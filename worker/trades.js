// Trades module — Civ/Stellaris-style player-to-player diplomacy.
//
// Endpoints (all auth: 'required'):
//   POST   /api/games/:gameId/trades                        — propose a new offer
//   GET    /api/games/:gameId/trades                        — list offers involving caller
//   POST   /api/games/:gameId/trades/:tradeId/accept        — accept (atomic resource + pact transfer)
//   POST   /api/games/:gameId/trades/:tradeId/decline       — decline
//   POST   /api/games/:gameId/trades/:tradeId/counter       — submit counter-offer
//   POST   /api/games/:gameId/trades/:tradeId/cancel        — proposer withdraws
//   GET    /api/games/:gameId/pacts                         — list active treaties for caller
//
// State machine:
//   open     →  accepted | declined | cancelled | countered
//   countered offers spawn a new 'open' row pointing at them via parent_offer_id
//
// Resource payload uses server faction columns: metal, fuel, gold, science.

const GAME_ID_RE    = /^[A-Za-z0-9_-]{6,32}$/;
const TRADE_ID_RE   = /^[A-Za-z0-9_-]{6,64}$/;
const FACTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const NOTE_MAX = 500;
const PACT_KINDS = new Set(['nap', 'defense_pact', 'intel_share']);
const RESOURCE_KEYS = ['metal', 'fuel', 'gold', 'science'];

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function callerFaction(env, gameId, userId) {
  return env.DB
    .prepare('SELECT id, game_id, user_id, name, color, metal, fuel, gold, science FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
}

async function loadGame(env, gameId) {
  return env.DB
    .prepare('SELECT id, current_tick, status FROM games WHERE id = ?')
    .bind(gameId)
    .first();
}

async function loadFaction(env, gameId, factionId) {
  return env.DB
    .prepare('SELECT id, game_id, name, color, metal, fuel, gold, science FROM game_factions WHERE game_id = ? AND id = ?')
    .bind(gameId, factionId)
    .first();
}

// Best-effort live notification through the Room DO.
async function notifyRoom(env, gameId, payload) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
    await stub.fetch('https://room/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — UI polling fallback covers this
  }
}

// Validate and normalize a payload of {offer, request} resources.
// Returns either { ok: true, offer, request } or { ok: false, error }.
function normalizeResources(body) {
  const offer = { metal: 0, fuel: 0, gold: 0, science: 0 };
  const request = { metal: 0, fuel: 0, gold: 0, science: 0 };

  const o = body.offer || {};
  const r = body.request || {};
  if (typeof o !== 'object' || typeof r !== 'object') {
    return { ok: false, error: 'offer and request must be objects' };
  }
  for (const k of RESOURCE_KEYS) {
    const ov = o[k];
    const rv = r[k];
    if (ov != null) {
      if (typeof ov !== 'number' || !Number.isFinite(ov) || ov < 0 || ov > 1e9 || !Number.isInteger(ov)) {
        return { ok: false, error: `offer.${k} must be a non-negative integer` };
      }
      offer[k] = ov;
    }
    if (rv != null) {
      if (typeof rv !== 'number' || !Number.isFinite(rv) || rv < 0 || rv > 1e9 || !Number.isInteger(rv)) {
        return { ok: false, error: `request.${k} must be a non-negative integer` };
      }
      request[k] = rv;
    }
  }
  return { ok: true, offer, request };
}

// Validate pact arrays. Returns { ok, offerPacts, requestPacts } or { ok: false, error }.
function normalizePacts(body) {
  const offerPactsRaw = body.offer_pacts;
  const requestPactsRaw = body.request_pacts;
  const offerPacts = [];
  const requestPacts = [];
  if (offerPactsRaw != null) {
    if (!Array.isArray(offerPactsRaw)) return { ok: false, error: 'offer_pacts must be an array' };
    for (const p of offerPactsRaw) {
      if (typeof p !== 'string' || !PACT_KINDS.has(p)) return { ok: false, error: `unknown pact: ${p}` };
      if (!offerPacts.includes(p)) offerPacts.push(p);
    }
  }
  if (requestPactsRaw != null) {
    if (!Array.isArray(requestPactsRaw)) return { ok: false, error: 'request_pacts must be an array' };
    for (const p of requestPactsRaw) {
      if (typeof p !== 'string' || !PACT_KINDS.has(p)) return { ok: false, error: `unknown pact: ${p}` };
      if (!requestPacts.includes(p)) requestPacts.push(p);
    }
  }
  return { ok: true, offerPacts, requestPacts };
}

function tradeRowToJson(row) {
  let offerPacts = [];
  let requestPacts = [];
  try { offerPacts = JSON.parse(row.offer_pacts || '[]'); } catch {}
  try { requestPacts = JSON.parse(row.request_pacts || '[]'); } catch {}
  return {
    id: row.id,
    proposer_faction_id: row.proposer_faction_id,
    responder_faction_id: row.responder_faction_id,
    status: row.status,
    offer: {
      metal: row.offer_metal, fuel: row.offer_fuel,
      gold: row.offer_gold, science: row.offer_science,
    },
    request: {
      metal: row.request_metal, fuel: row.request_fuel,
      gold: row.request_gold, science: row.request_science,
    },
    offer_pacts: offerPacts,
    request_pacts: requestPacts,
    parent_offer_id: row.parent_offer_id,
    note: row.note,
    created_at_tick: row.created_at_tick,
    created_at_ms: row.created_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    resolved_by_faction_id: row.resolved_by_faction_id,
  };
}

// ---------- POST /api/games/:gameId/trades ----------

async function handlePropose(req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');

  const proposer = await callerFaction(env, gameId, session.user_id);
  if (!proposer) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const responderId = body.responder_faction_id;
  if (typeof responderId !== 'string' || !FACTION_ID_RE.test(responderId)) {
    return err(400, 'bad_request', 'invalid responder_faction_id');
  }
  if (responderId === proposer.id) {
    return err(400, 'bad_request', 'cannot trade with yourself');
  }

  const responder = await loadFaction(env, gameId, responderId);
  if (!responder) return err(404, 'not_found', 'responder faction not found in this game');

  const res = normalizeResources(body);
  if (!res.ok) return err(400, 'bad_request', res.error);
  const pactCheck = normalizePacts(body);
  if (!pactCheck.ok) return err(400, 'bad_request', pactCheck.error);

  // Reject empty offers (nothing on either side).
  const offerSum = RESOURCE_KEYS.reduce((s, k) => s + res.offer[k], 0) + pactCheck.offerPacts.length;
  const requestSum = RESOURCE_KEYS.reduce((s, k) => s + res.request[k], 0) + pactCheck.requestPacts.length;
  if (offerSum === 0 && requestSum === 0) {
    return err(400, 'bad_request', 'offer must include at least one resource or pact');
  }

  // Proposer must currently hold what they're offering. (Soft check — accept
  // will re-verify atomically.)
  for (const k of RESOURCE_KEYS) {
    if (proposer[k] < res.offer[k]) {
      return err(400, 'insufficient_resources', `you don't have ${res.offer[k]} ${k} to offer`);
    }
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, NOTE_MAX) : null;

  // Optional parent_offer_id (counter-offer linkage). The /counter endpoint is
  // the supported path; we permit parent here too for clients that prefer it.
  let parentOfferId = null;
  if (body.parent_offer_id != null) {
    if (typeof body.parent_offer_id !== 'string' || !TRADE_ID_RE.test(body.parent_offer_id)) {
      return err(400, 'bad_request', 'invalid parent_offer_id');
    }
    parentOfferId = body.parent_offer_id;
  }

  const id = newId();
  const nowMs = Date.now();
  const tick = game.current_tick ?? 0;

  await env.DB
    .prepare(
      `INSERT INTO trade_offers
       (id, game_id, proposer_faction_id, responder_faction_id, status,
        offer_metal, offer_fuel, offer_gold, offer_science,
        request_metal, request_fuel, request_gold, request_science,
        offer_pacts, request_pacts,
        parent_offer_id, note, created_at_tick, created_at_ms)
       VALUES (?, ?, ?, ?, 'open',
               ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?,
               ?, ?, ?, ?)`,
    )
    .bind(
      id, gameId, proposer.id, responderId,
      res.offer.metal, res.offer.fuel, res.offer.gold, res.offer.science,
      res.request.metal, res.request.fuel, res.request.gold, res.request.science,
      JSON.stringify(pactCheck.offerPacts), JSON.stringify(pactCheck.requestPacts),
      parentOfferId, note, tick, nowMs,
    )
    .run();

  notifyRoom(env, gameId, {
    kind: 'trade',
    event: 'proposed',
    trade_id: id,
    proposer_faction_id: proposer.id,
    responder_faction_id: responderId,
  });

  const row = await env.DB
    .prepare('SELECT * FROM trade_offers WHERE id = ?')
    .bind(id)
    .first();

  return json({ trade: tradeRowToJson(row) }, { status: 201 });
}

// ---------- GET /api/games/:gameId/trades ----------

async function handleList(req, env, { url, session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  let limit = parseInt(url.searchParams.get('limit') || '100', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 500) limit = 500;

  const statusFilter = url.searchParams.get('status'); // optional: 'open' to get only active offers
  const where = ['game_id = ?', '(proposer_faction_id = ? OR responder_faction_id = ?)'];
  const bind = [gameId, caller.id, caller.id];
  if (statusFilter === 'open' || statusFilter === 'accepted' || statusFilter === 'declined' || statusFilter === 'cancelled' || statusFilter === 'countered') {
    where.push('status = ?');
    bind.push(statusFilter);
  }

  const sql = `SELECT * FROM trade_offers WHERE ${where.join(' AND ')} ORDER BY created_at_ms DESC LIMIT ?`;
  bind.push(limit);

  const rows = (await env.DB.prepare(sql).bind(...bind).all()).results ?? [];
  return json({
    trades: rows.map(tradeRowToJson),
    caller_faction_id: caller.id,
  });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/accept ----------

async function handleAccept(req, env, { session, params }) {
  const gameId = params.gameId;
  const tradeId = params.tradeId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const trade = await env.DB
    .prepare('SELECT * FROM trade_offers WHERE id = ? AND game_id = ?')
    .bind(tradeId, gameId)
    .first();
  if (!trade) return err(404, 'not_found', 'trade not found');
  if (trade.responder_faction_id !== caller.id) {
    return err(403, 'not_recipient', 'only the responder can accept this trade');
  }
  if (trade.status !== 'open') {
    return err(409, 'not_open', `trade is ${trade.status}`);
  }

  // Re-verify both sides still hold the resources at accept time.
  const proposer = await loadFaction(env, gameId, trade.proposer_faction_id);
  const responder = caller;
  if (!proposer) return err(409, 'proposer_missing', 'proposer faction is gone');

  for (const k of RESOURCE_KEYS) {
    const offerCol = `offer_${k}`;
    const requestCol = `request_${k}`;
    if (proposer[k] < trade[offerCol]) {
      return err(409, 'proposer_insufficient', `proposer no longer has ${trade[offerCol]} ${k}`);
    }
    if (responder[k] < trade[requestCol]) {
      return err(409, 'responder_insufficient', `you do not have ${trade[requestCol]} ${k} to fulfill this`);
    }
  }

  let offerPacts = [];
  let requestPacts = [];
  try { offerPacts = JSON.parse(trade.offer_pacts || '[]'); } catch {}
  try { requestPacts = JSON.parse(trade.request_pacts || '[]'); } catch {}

  const nowMs = Date.now();
  const tick = game.current_tick ?? 0;

  // Build atomic batch.
  const stmts = [];

  // 1. Transfer resources from proposer to responder (proposer's offer).
  // 2. Transfer resources from responder to proposer (proposer's request).
  // Combined update so each row is touched only once: proposer pays offer_X
  // and receives request_X; responder is the inverse.
  const proposerDelta = {};
  const responderDelta = {};
  for (const k of RESOURCE_KEYS) {
    proposerDelta[k] = -trade[`offer_${k}`] + trade[`request_${k}`];
    responderDelta[k] = +trade[`offer_${k}`] - trade[`request_${k}`];
  }

  stmts.push(
    env.DB
      .prepare(`UPDATE game_factions SET
        metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
        WHERE id = ? AND game_id = ?
          AND metal + ? >= 0 AND fuel + ? >= 0 AND gold + ? >= 0 AND science + ? >= 0`)
      .bind(
        proposerDelta.metal, proposerDelta.fuel, proposerDelta.gold, proposerDelta.science,
        proposer.id, gameId,
        proposerDelta.metal, proposerDelta.fuel, proposerDelta.gold, proposerDelta.science,
      ),
  );
  stmts.push(
    env.DB
      .prepare(`UPDATE game_factions SET
        metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
        WHERE id = ? AND game_id = ?
          AND metal + ? >= 0 AND fuel + ? >= 0 AND gold + ? >= 0 AND science + ? >= 0`)
      .bind(
        responderDelta.metal, responderDelta.fuel, responderDelta.gold, responderDelta.science,
        responder.id, gameId,
        responderDelta.metal, responderDelta.fuel, responderDelta.gold, responderDelta.science,
      ),
  );

  // 3. Insert treaties for each pact, with both factions as signatories.
  const treatyIds = [];
  const allPacts = Array.from(new Set([...offerPacts, ...requestPacts]));
  for (const kind of allPacts) {
    const treatyId = newId();
    treatyIds.push({ id: treatyId, kind });
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO treaties (id, game_id, kind, status, proposed_at_tick, signed_at_tick, terms)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .bind(treatyId, gameId, kind, tick, tick, JSON.stringify({ source_trade_id: tradeId })),
    );
    for (const fid of [proposer.id, responder.id]) {
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO treaty_signatories (treaty_id, faction_id, signed_at_tick)
             VALUES (?, ?, ?)`,
          )
          .bind(treatyId, fid, tick),
      );
    }
  }

  // 4. Mark the trade accepted.
  stmts.push(
    env.DB
      .prepare(
        `UPDATE trade_offers
         SET status = 'accepted', resolved_at_ms = ?, resolved_by_faction_id = ?
         WHERE id = ? AND status = 'open'`,
      )
      .bind(nowMs, caller.id, tradeId),
  );

  // 5. Chronicle entry.
  const chronicleId = newId();
  stmts.push(
    env.DB
      .prepare(
        `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, target_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'trade_accepted', ?, ?, ?, 'public', ?)`,
      )
      .bind(
        chronicleId, gameId, tick,
        proposer.id, responder.id,
        JSON.stringify({
          trade_id: tradeId,
          offer: {
            metal: trade.offer_metal, fuel: trade.offer_fuel,
            gold: trade.offer_gold, science: trade.offer_science,
          },
          request: {
            metal: trade.request_metal, fuel: trade.request_fuel,
            gold: trade.request_gold, science: trade.request_science,
          },
          pacts: allPacts,
        }),
        nowMs,
      ),
  );

  await env.DB.batch(stmts);

  notifyRoom(env, gameId, {
    kind: 'trade',
    event: 'accepted',
    trade_id: tradeId,
    proposer_faction_id: proposer.id,
    responder_faction_id: responder.id,
  });

  const updated = await env.DB
    .prepare('SELECT * FROM trade_offers WHERE id = ?')
    .bind(tradeId)
    .first();
  return json({ trade: tradeRowToJson(updated), treaties: treatyIds });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/decline ----------

async function handleDecline(req, env, { session, params }) {
  const gameId = params.gameId;
  const tradeId = params.tradeId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const trade = await env.DB
    .prepare('SELECT id, status, proposer_faction_id, responder_faction_id FROM trade_offers WHERE id = ? AND game_id = ?')
    .bind(tradeId, gameId)
    .first();
  if (!trade) return err(404, 'not_found', 'trade not found');
  if (trade.responder_faction_id !== caller.id) {
    return err(403, 'not_recipient', 'only the responder can decline this trade');
  }
  if (trade.status !== 'open') return err(409, 'not_open', `trade is ${trade.status}`);

  await env.DB
    .prepare(`UPDATE trade_offers SET status = 'declined', resolved_at_ms = ?, resolved_by_faction_id = ? WHERE id = ? AND status = 'open'`)
    .bind(Date.now(), caller.id, tradeId)
    .run();

  notifyRoom(env, gameId, {
    kind: 'trade',
    event: 'declined',
    trade_id: tradeId,
    proposer_faction_id: trade.proposer_faction_id,
    responder_faction_id: trade.responder_faction_id,
  });

  return new Response(null, { status: 204 });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/cancel ----------

async function handleCancel(req, env, { session, params }) {
  const gameId = params.gameId;
  const tradeId = params.tradeId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const trade = await env.DB
    .prepare('SELECT id, status, proposer_faction_id, responder_faction_id FROM trade_offers WHERE id = ? AND game_id = ?')
    .bind(tradeId, gameId)
    .first();
  if (!trade) return err(404, 'not_found', 'trade not found');
  if (trade.proposer_faction_id !== caller.id) {
    return err(403, 'not_proposer', 'only the proposer can cancel this trade');
  }
  if (trade.status !== 'open') return err(409, 'not_open', `trade is ${trade.status}`);

  await env.DB
    .prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at_ms = ?, resolved_by_faction_id = ? WHERE id = ? AND status = 'open'`)
    .bind(Date.now(), caller.id, tradeId)
    .run();

  notifyRoom(env, gameId, {
    kind: 'trade',
    event: 'cancelled',
    trade_id: tradeId,
    proposer_faction_id: trade.proposer_faction_id,
    responder_faction_id: trade.responder_faction_id,
  });

  return new Response(null, { status: 204 });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/counter ----------

async function handleCounter(req, env, { session, params }) {
  const gameId = params.gameId;
  const tradeId = params.tradeId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const original = await env.DB
    .prepare('SELECT * FROM trade_offers WHERE id = ? AND game_id = ?')
    .bind(tradeId, gameId)
    .first();
  if (!original) return err(404, 'not_found', 'trade not found');
  if (original.responder_faction_id !== caller.id) {
    return err(403, 'not_recipient', 'only the responder can counter this trade');
  }
  if (original.status !== 'open') return err(409, 'not_open', `trade is ${original.status}`);

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const res = normalizeResources(body);
  if (!res.ok) return err(400, 'bad_request', res.error);
  const pactCheck = normalizePacts(body);
  if (!pactCheck.ok) return err(400, 'bad_request', pactCheck.error);

  // Roles flip on counter: the responder of the original becomes the proposer
  // of the counter.
  const newProposer = caller;
  const newResponderId = original.proposer_faction_id;
  const newResponder = await loadFaction(env, gameId, newResponderId);
  if (!newResponder) return err(409, 'opponent_missing', 'original proposer is gone');

  for (const k of RESOURCE_KEYS) {
    if (newProposer[k] < res.offer[k]) {
      return err(400, 'insufficient_resources', `you don't have ${res.offer[k]} ${k} to offer`);
    }
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, NOTE_MAX) : null;
  const id = newId();
  const nowMs = Date.now();
  const tick = game.current_tick ?? 0;

  await env.DB.batch([
    env.DB
      .prepare(`UPDATE trade_offers SET status = 'countered', resolved_at_ms = ?, resolved_by_faction_id = ? WHERE id = ? AND status = 'open'`)
      .bind(nowMs, caller.id, tradeId),
    env.DB
      .prepare(
        `INSERT INTO trade_offers
         (id, game_id, proposer_faction_id, responder_faction_id, status,
          offer_metal, offer_fuel, offer_gold, offer_science,
          request_metal, request_fuel, request_gold, request_science,
          offer_pacts, request_pacts,
          parent_offer_id, note, created_at_tick, created_at_ms)
         VALUES (?, ?, ?, ?, 'open',
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?,
                 ?, ?, ?, ?)`,
      )
      .bind(
        id, gameId, newProposer.id, newResponderId,
        res.offer.metal, res.offer.fuel, res.offer.gold, res.offer.science,
        res.request.metal, res.request.fuel, res.request.gold, res.request.science,
        JSON.stringify(pactCheck.offerPacts), JSON.stringify(pactCheck.requestPacts),
        tradeId, note, tick, nowMs,
      ),
  ]);

  notifyRoom(env, gameId, {
    kind: 'trade',
    event: 'countered',
    trade_id: id,
    parent_trade_id: tradeId,
    proposer_faction_id: newProposer.id,
    responder_faction_id: newResponderId,
  });

  const row = await env.DB.prepare('SELECT * FROM trade_offers WHERE id = ?').bind(id).first();
  return json({ trade: tradeRowToJson(row) }, { status: 201 });
}

// ---------- GET /api/games/:gameId/pacts ----------

async function handleListPacts(req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  // Active treaties the caller is a signatory of.
  const rows = (await env.DB
    .prepare(
      `SELECT t.id, t.kind, t.status, t.signed_at_tick, t.expires_at_tick, t.broken_at_tick, t.terms,
              ts.faction_id AS my_faction
       FROM treaties t
       JOIN treaty_signatories ts ON ts.treaty_id = t.id
       WHERE t.game_id = ? AND ts.faction_id = ? AND t.status = 'active'
       ORDER BY t.signed_at_tick DESC`,
    )
    .bind(gameId, caller.id)
    .all()).results ?? [];

  // Also fetch the *other* signatories so each pact knows its counterparty.
  const pactIds = rows.map(r => r.id);
  const counterMap = new Map();
  if (pactIds.length) {
    const ph = pactIds.map(() => '?').join(',');
    const others = (await env.DB
      .prepare(`SELECT treaty_id, faction_id FROM treaty_signatories WHERE treaty_id IN (${ph})`)
      .bind(...pactIds)
      .all()).results ?? [];
    for (const r of others) {
      if (r.faction_id === caller.id) continue;
      const arr = counterMap.get(r.treaty_id) || [];
      arr.push(r.faction_id);
      counterMap.set(r.treaty_id, arr);
    }
  }

  const pacts = rows.map(r => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    signed_at_tick: r.signed_at_tick,
    expires_at_tick: r.expires_at_tick,
    counterparty_faction_ids: counterMap.get(r.id) || [],
  }));

  return json({ pacts, caller_faction_id: caller.id });
}

// ---------- routes ----------

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades$/,
    auth: 'required',
    handle: handlePropose,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades$/,
    auth: 'required',
    handle: handleList,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/accept$/,
    auth: 'required',
    handle: handleAccept,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/decline$/,
    auth: 'required',
    handle: handleDecline,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/cancel$/,
    auth: 'required',
    handle: handleCancel,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/counter$/,
    auth: 'required',
    handle: handleCounter,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/pacts$/,
    auth: 'required',
    handle: handleListPacts,
  },
];
