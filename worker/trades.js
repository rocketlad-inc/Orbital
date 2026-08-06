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

import { getActiveSliders, getSliderResolver } from './senate.js';
import {
  factionTechLevels, gatingEnabled, hasFeature, lockedError,
} from './researchUnlocks.js';

const GAME_ID_RE    = /^[A-Za-z0-9_-]{6,32}$/;
const TRADE_ID_RE   = /^[A-Za-z0-9_-]{6,64}$/;
// Faction IDs are formatted "${gameId}:f${slot}" (see seedGameWorld in
// factions.js), so the regex must permit a colon.
const FACTION_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;

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
    .prepare('SELECT id, game_id, user_id, name, color, capital_body_id, metal, fuel, gold, science FROM game_factions WHERE game_id = ? AND user_id = ?')
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

  // Resource trading is ungated — swapping metal for fuel is basic
  // diplomacy and needs to work from tick one. TREATIES are Society 4,
  // so only an offer that actually carries a pact is checked, and only
  // the PROPOSER pays the research cost (the responder is agreeing to
  // something the proposer authored, not authoring it themselves).
  if ((pactCheck.offerPacts.length + pactCheck.requestPacts.length) > 0
      && await gatingEnabled(env, gameId)) {
    const levels = await factionTechLevels(env, gameId, proposer.id);
    if (!hasFeature('pacts', levels, true)) {
      const e = lockedError('pacts');
      return err(403, e.code, e.message);
    }
  }

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
    proposer_faction_name: proposer.name,
    responder_faction_id: responderId,
  });

  // DM the responder with working buttons. Trade is the most
  // friction-heavy thing in the game — an offer sitting unseen for hours
  // is a deal that doesn't happen — and senate voting already proved a
  // Discord button can carry a real game action safely.
  try {
    const notify = await import('./notify.js');
    const uid = await notify.userIdForFaction(env, responderId);
    if (uid) {
      const roomName = (await env.DB
        .prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first())?.name ?? gameId;
      const bits = (o) => {
        const out = [];
        if (o.metal) out.push(`**${Math.round(o.metal)}** metal`);
        if (o.fuel) out.push(`**${Math.round(o.fuel)}** fuel`);
        if (o.gold) out.push(`**${Math.round(o.gold)}** credits`);
        if (o.science) out.push(`**${Math.round(o.science)}** science`);
        return out.length ? out.join(' · ') : '_nothing_';
      };
      // pactCheck holds the validated arrays the INSERT binds above.
      const pacts = (arr) => (Array.isArray(arr) && arr.length ? ` · ${arr.join(', ')}` : '');

      await notify.sendDm(env, {
        userId: uid,
        gameId,
        category: 'dm',
        dedupeKey: `trade:${id}`,
        embed: {
          title: `🤝 Trade offer from ${proposer.name}`,
          description: [
            `**They give you:** ${bits(res.offer)}${pacts(pactCheck.offerPacts)}`,
            `**They want:** ${bits(res.request)}${pacts(pactCheck.requestPacts)}`,
            note ? `\n_"${String(note).slice(0, 200)}"_` : null,
          ].filter(Boolean).join('\n'),
          color: 0x4ecdc4,
          footer: { text: `Orbital · ${roomName} · T+${tick}` },
        },
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Accept', custom_id: `orb:t:${gameId}:${id}:accept` },
            { type: 2, style: 4, label: 'Decline', custom_id: `orb:t:${gameId}:${id}:decline` },
          ],
        }],
      });
    }
  } catch (e) {
    console.error('trade offer DM failed', e, { tradeId: id });
  }

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

  // Attach delivery legs to every accepted trade in the page, in one
  // query. An accepted trade is no longer "done" — it's done when its
  // freighters have landed, and the panel needs to show which stage
  // each leg is at (and prompt the caller to assign a ship to theirs).
  const deliveriesByTrade = new Map();
  const acceptedIds = rows.filter(r => r.status === 'accepted').map(r => r.id);
  if (acceptedIds.length > 0) {
    const ph = acceptedIds.map(() => '?').join(',');
    const dRows = (await env.DB
      .prepare(
        `SELECT id, trade_id, sender_faction_id, recipient_faction_id,
                ship_id, status, pickup_body_id, dest_body_id,
                metal, fuel, gold, science, loaded, tariff_pct
           FROM trade_deliveries
          WHERE game_id = ? AND trade_id IN (${ph})`,
      )
      .bind(gameId, ...acceptedIds)
      .all()).results ?? [];
    for (const d of dRows) {
      if (!deliveriesByTrade.has(d.trade_id)) deliveriesByTrade.set(d.trade_id, []);
      deliveriesByTrade.get(d.trade_id).push(d);
    }
  }

  return json({
    trades: rows.map(r => ({
      ...tradeRowToJson(r),
      deliveries: deliveriesByTrade.get(r.id) ?? [],
    })),
    caller_faction_id: caller.id,
  });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/accept ----------

export async function handleAccept(req, env, { session, params }) {
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

  const proposer = await loadFaction(env, gameId, trade.proposer_faction_id);
  const responder = caller;
  if (!proposer) return err(409, 'proposer_missing', 'proposer faction is gone');

  // NOTE: no balance re-verification here anymore. Resources are no
  // longer moved at accept — they're debited when a freighter physically
  // LOADS them at the sender's collector (room.js delivery pass). A
  // faction can accept a deal it can't currently cover; the shipment
  // simply waits at the collector until the pool can fund it. The
  // Trades panel shows that state, so an under-funded promise is
  // visible to both sides rather than silently impossible.

  let offerPacts = [];
  let requestPacts = [];
  try { offerPacts = JSON.parse(trade.offer_pacts || '[]'); } catch {}
  try { requestPacts = JSON.parse(trade.request_pacts || '[]'); } catch {}

  const nowMs = Date.now();
  const tick = game.current_tick ?? 0;

  // Senate trade tariff. Slider value is a percentage (0–50); each side
  // pays the full amount it offered, but RECEIVES (1 - tariff) of the
  // counter-offer. The differential evaporates — there's no senate
  // treasury to bank it, the resources are simply skimmed off the
  // transaction. Defaults to 0% so an un-legislated game behaves as
  // before this slider was wired.
  // Resolved PER RECIPIENT, because the skim is receive-side: a tariff
  // law aimed at one faction taxes what that faction receives, and
  // leaves the other side of the same deal untouched. Falls back to a
  // flat 0% resolver on any senate error, exactly as before.
  let tariffFor = () => 0;
  try {
    const resolve = await getSliderResolver(env, gameId, tick);
    tariffFor = (factionId) => Math.max(0, Math.min(100,
      Number(resolve(factionId).trade_tariff_pct ?? 0)));
  } catch { /* leave at 0 */ }
  // (Applied as a receive-side skim at delivery time, from the snapshot
  // stored on each leg — see the delivery credit in room.js.)

  // Build atomic batch.
  const stmts = [];

  // 1+2. Resources are DELIVERED, not teleported. One trade_deliveries
  // row per giving side; the goods move only when a freighter hauls
  // them collector-to-collector (room.js pass 2d drives the lifecycle;
  // see migration 0041 for the state machine). Pacts, by contrast,
  // remain instant below — a treaty is a signature, not a shipment.
  //
  // tariff_pct is snapshotted NOW so a slider passed mid-flight can't
  // re-price a deal both sides already agreed to. The skim is applied
  // at the delivery credit.
  const legs = [
    { sender: proposer.id, recipient: responder.id, prefix: 'offer' },
    { sender: responder.id, recipient: proposer.id, prefix: 'request' },
  ];
  for (const leg of legs) {
    const amounts = {};
    let total = 0;
    for (const k of RESOURCE_KEYS) {
      amounts[k] = Math.max(0, Math.floor(Number(trade[`${leg.prefix}_${k}`] ?? 0)));
      total += amounts[k];
    }
    if (total === 0) continue;   // pact-only or one-sided: no empty legs
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO trade_deliveries
             (id, game_id, trade_id, sender_faction_id, recipient_faction_id,
              ship_id, status, pickup_body_id, dest_body_id,
              metal, fuel, gold, science, loaded, tariff_pct, created_at_tick)
           VALUES (?, ?, ?, ?, ?, NULL, 'unassigned', NULL, NULL, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          newId(), gameId, tradeId, leg.sender, leg.recipient,
          amounts.metal, amounts.fuel, amounts.gold, amounts.science,
          Math.round(tariffFor(leg.recipient)), tick,
        ),
    );
  }

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

  // 5. Chronicle entry — the trade itself.
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

  // 5b. One treaty_signed chronicle per pact created. Lets the in-game
  // log surface diplomatic shifts as discrete events (not just buried
  // in the trade_accepted payload), so playtesters see PACT SIGNED
  // entries the same way they see PACT BROKEN later.
  for (const t of treatyIds) {
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, target_faction_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'treaty_signed', ?, ?, ?, 'public', ?)`,
        )
        .bind(
          newId(), gameId, tick,
          proposer.id, responder.id,
          JSON.stringify({ treaty_id: t.id, kind: t.kind, source_trade_id: tradeId }),
          nowMs,
        ),
    );
  }

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

export async function handleDecline(req, env, { session, params }) {
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

// ---------- POST /api/games/:gameId/treaties/:treatyId/break ----------
//
// Unilateral pact-break. Either signatory can fire this; the treaty
// flips from 'active' to 'broken' and a treaty_broken chronicle entry
// fires. The breaker is named in chronicle.actor_faction_id and on
// treaties.breaker_faction_id so downstream UIs can render
// "Lornian Empire BROKE the NAP with Sean."
//
// Hostility is implicit: once the pact is broken, the combat code
// (worker/room.js — t.status = 'active' check) starts allowing damage
// between the two factions on the very next combat tick. There is no
// separate 'declare war' action — break the peace and the war begins.
async function handleBreakTreaty(req, env, { session, params }) {
  const gameId = params.gameId;
  const treatyId = params.treatyId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (typeof treatyId !== 'string' || !treatyId) {
    return err(400, 'bad_request', 'invalid treaty id');
  }

  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  // Verify the treaty exists, is active, and the caller is a signatory.
  const treaty = await env.DB
    .prepare(
      `SELECT t.id, t.kind, t.status
         FROM treaties t
         JOIN treaty_signatories ts ON ts.treaty_id = t.id
        WHERE t.id = ? AND t.game_id = ? AND ts.faction_id = ?`,
    )
    .bind(treatyId, gameId, caller.id)
    .first();
  if (!treaty) return err(404, 'not_found', 'treaty not found, or you are not a signatory');
  if (treaty.status !== 'active') {
    return err(409, 'not_active', `treaty is ${treaty.status}`);
  }

  // Pull the other signatories so the chronicle gets a target_faction_id.
  const others = (await env.DB
    .prepare(
      `SELECT faction_id FROM treaty_signatories
        WHERE treaty_id = ? AND faction_id != ?`,
    )
    .bind(treatyId, caller.id)
    .all()).results ?? [];
  const targetId = others[0]?.faction_id ?? null;

  const tick = game.current_tick ?? 0;
  const nowMs = Date.now();

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE treaties
            SET status = 'broken',
                broken_at_tick = ?,
                breaker_faction_id = ?
          WHERE id = ? AND status = 'active'`,
      )
      .bind(tick, caller.id, treatyId),
    env.DB
      .prepare(
        `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, target_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'treaty_broken', ?, ?, ?, 'public', ?)`,
      )
      .bind(
        newId(), gameId, tick,
        caller.id, targetId,
        JSON.stringify({ treaty_id: treatyId, kind: treaty.kind }),
        nowMs,
      ),
  ]);

  // Push a WS event so the other signatory sees the break immediately
  // (no waiting for the next /state poll).
  notifyRoom(env, gameId, {
    kind: 'treaty',
    event: 'broken',
    treaty_id: treatyId,
    treaty_kind: treaty.kind,
    breaker_faction_id: caller.id,
  });

  return json({ ok: true, treaty: { id: treatyId, status: 'broken' } });
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

// ---------- GET /api/games/:gameId/trades/:tradeId/delivery-options ----------
//
// Everything the "assign a freighter" UI needs, in one call: which of
// MY freighters are free to haul, and which of the counterparty's
// collector bodies can receive. Computed server-side so the client
// never has to guess at collector locations (capitals always qualify —
// every capital city seeds with a collector).

async function handleDeliveryOptions(req, env, { url, session, params }) {
  const { gameId, tradeId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const deliveryId = url.searchParams.get('delivery') || '';
  const delivery = await env.DB
    .prepare(
      `SELECT * FROM trade_deliveries
        WHERE id = ? AND game_id = ? AND trade_id = ?`,
    )
    .bind(deliveryId, gameId, tradeId)
    .first();
  if (!delivery) return err(404, 'not_found', 'delivery not found');
  if (delivery.sender_faction_id !== caller.id) {
    return err(403, 'not_sender', 'only the sending faction assigns this shipment');
  }

  // Recipient collector bodies — where this shipment may land.
  const targets = (await env.DB
    .prepare(
      `SELECT DISTINCT s.body_id, b.name AS body_name
         FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
        WHERE s.game_id = ? AND s.owner_faction_id = ?
          AND s.has_collector = 1 AND s.destroyed_at_tick IS NULL
          AND b.destroyed_at_tick IS NULL`,
    )
    .bind(gameId, delivery.recipient_faction_id)
    .all()).results ?? [];

  // My idle freighters: active hull, not on a trade route, not already
  // hauling another shipment, nothing in flight. "Inactive" is the
  // requirement — a busy freighter can't be double-booked.
  const freighters = (await env.DB
    .prepare(
      `SELECT sh.id, sh.name, sh.parent_body_id
         FROM game_ships sh
        WHERE sh.game_id = ? AND sh.owner_faction_id = ?
          AND sh.ship_class = 'freighter' AND sh.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM game_trade_routes r
             WHERE r.ship_id = sh.id AND r.cancelled_at_tick IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM trade_deliveries d
             WHERE d.ship_id = sh.id AND d.resolved_at_tick IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM game_ship_nodes n
             WHERE n.ship_id = sh.id AND n.status IN ('committed','in_transit'))`,
    )
    .bind(gameId, caller.id)
    .all()).results ?? [];

  // Which of my bodies have collectors — so the picker can badge
  // freighters that can load instantly (already parked at one).
  const myCollectors = new Set(
    ((await env.DB
      .prepare(
        `SELECT DISTINCT body_id FROM game_settlements
          WHERE game_id = ? AND owner_faction_id = ?
            AND has_collector = 1 AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId, caller.id)
      .all()).results ?? []).map(r => r.body_id),
  );

  return json({
    delivery: {
      id: delivery.id,
      status: delivery.status,
      metal: delivery.metal, fuel: delivery.fuel,
      gold: delivery.gold, science: delivery.science,
    },
    targets,
    freighters: freighters.map(f => ({
      id: f.id, name: f.name, body_id: f.parent_body_id,
      at_collector: myCollectors.has(f.parent_body_id),
    })),
  });
}

// ---------- POST /api/games/:gameId/trades/:tradeId/deliveries/:deliveryId/assign ----------
//
// body: { ship_id, dest_body_id }
//
// Connects an idle freighter to a shipment and picks the receiving
// collector. No nodes are planned here — the room tick's delivery pass
// owns all movement: next tick it either loads on the spot (freighter
// already parked at one of the sender's collectors) or burns for the
// pickup collector first. Splitting authority that way means there is
// exactly one place that plans delivery legs.

async function handleAssignDelivery(req, env, { session, params }) {
  const { gameId, tradeId, deliveryId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!TRADE_ID_RE.test(tradeId)) return err(400, 'bad_request', 'invalid trade id');

  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const shipId = String(body.ship_id ?? '');
  const destBodyId = String(body.dest_body_id ?? '');
  if (!shipId) return err(400, 'bad_request', 'ship_id required');
  if (!destBodyId) return err(400, 'bad_request', 'dest_body_id required');

  const delivery = await env.DB
    .prepare(
      `SELECT * FROM trade_deliveries
        WHERE id = ? AND game_id = ? AND trade_id = ?`,
    )
    .bind(deliveryId, gameId, tradeId)
    .first();
  if (!delivery) return err(404, 'not_found', 'delivery not found');
  if (delivery.sender_faction_id !== caller.id) {
    return err(403, 'not_sender', 'only the sending faction assigns this shipment');
  }
  // Reassignment is allowed any time before the cargo is aboard —
  // including after a pre-load freighter loss resets the row to
  // 'unassigned'. Once loaded, the goods ride THAT hull; no swapping.
  if (delivery.loaded === 1 || !['unassigned', 'to_pickup'].includes(delivery.status)) {
    return err(409, 'not_assignable', `shipment is ${delivery.status}`);
  }

  const ship = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, ship_class, status, parent_body_id
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId)
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== caller.id) return err(403, 'not_owner', 'not your ship');
  if (ship.ship_class !== 'freighter') return err(409, 'wrong_class', 'only freighters can haul trade shipments');
  if (ship.status !== 'active') return err(409, 'ship_dead', 'that freighter is gone');

  const busyRoute = await env.DB
    .prepare('SELECT 1 AS x FROM game_trade_routes WHERE ship_id = ? AND cancelled_at_tick IS NULL LIMIT 1')
    .bind(shipId).first();
  if (busyRoute) return err(409, 'on_route', 'that freighter is running a trade route — cancel the route first');
  const busyDelivery = await env.DB
    .prepare('SELECT 1 AS x FROM trade_deliveries WHERE ship_id = ? AND resolved_at_tick IS NULL AND id != ? LIMIT 1')
    .bind(shipId, deliveryId).first();
  if (busyDelivery) return err(409, 'on_delivery', 'that freighter is already hauling another shipment');
  const inFlight = await env.DB
    .prepare("SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status IN ('committed','in_transit') LIMIT 1")
    .bind(shipId).first();
  if (inFlight) return err(409, 'in_transit', 'that freighter is mid-burn — wait for it to arrive');

  // Destination must be a live collector of the RECIPIENT.
  const destOk = await env.DB
    .prepare(
      `SELECT 1 AS x FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
          AND has_collector = 1 AND destroyed_at_tick IS NULL LIMIT 1`,
    )
    .bind(gameId, destBodyId, delivery.recipient_faction_id)
    .first();
  if (!destOk) return err(409, 'no_dest_collector', 'the recipient has no collector there');

  // Pickup: the freighter's current body if the sender has a collector
  // on it (instant load next tick), else the sender's capital — which
  // always has one (seeded + migration 0041 backfill). A faction that
  // somehow lost every collector including its capital can't ship.
  let pickupBodyId = null;
  const hereOk = await env.DB
    .prepare(
      `SELECT 1 AS x FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
          AND has_collector = 1 AND destroyed_at_tick IS NULL LIMIT 1`,
    )
    .bind(gameId, ship.parent_body_id, caller.id)
    .first();
  if (hereOk) {
    pickupBodyId = ship.parent_body_id;
  } else {
    const anyCollector = await env.DB
      .prepare(
        `SELECT s.body_id,
                CASE WHEN s.body_id = ? THEN 0 ELSE 1 END AS pref
           FROM game_settlements s
          WHERE s.game_id = ? AND s.owner_faction_id = ?
            AND s.has_collector = 1 AND s.destroyed_at_tick IS NULL
          ORDER BY pref LIMIT 1`,
      )
      .bind(caller.capital_body_id, gameId, caller.id)
      .first();
    if (!anyCollector) return err(409, 'no_pickup_collector', 'you have no collector to load from');
    pickupBodyId = anyCollector.body_id;
  }

  await env.DB
    .prepare(
      `UPDATE trade_deliveries
          SET ship_id = ?, pickup_body_id = ?, dest_body_id = ?, status = 'to_pickup'
        WHERE id = ? AND loaded = 0`,
    )
    .bind(shipId, pickupBodyId, destBodyId, deliveryId)
    .run();

  return json({ ok: true, pickup_body_id: pickupBodyId, dest_body_id: destBodyId });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/delivery-options$/,
    auth: 'required',
    handle: handleDeliveryOptions,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trades\/(?<tradeId>[^/]+)\/deliveries\/(?<deliveryId>[^/]+)\/assign$/,
    auth: 'required',
    handle: handleAssignDelivery,
  },
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
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/treaties\/(?<treatyId>[^/]+)\/break$/,
    auth: 'required',
    handle: handleBreakTreaty,
  },
];
