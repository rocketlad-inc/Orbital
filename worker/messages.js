// Messaging module — in-game faction-to-faction messaging.
//
// Endpoints (all auth: 'required'):
//   POST   /api/games/:gameId/messages
//   GET    /api/games/:gameId/messages
//   POST   /api/games/:gameId/messages/:messageId/read
//   GET    /api/games/:gameId/messages/unread-count
//
// Visibility: caller sees messages they sent, messages where they are a
// recipient (dm/group), or any scope='broadcast' message in the game.

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const MSG_ID_RE  = /^[A-Za-z0-9_-]{6,64}$/;
const FACTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BODY_MIN = 1;
const BODY_MAX = 4000;

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

// Resolve the caller's faction in this game. Returns row or null.
async function callerFaction(env, gameId, userId) {
  return env.DB
    .prepare('SELECT id, game_id, user_id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
}

async function loadGame(env, gameId) {
  return env.DB
    .prepare('SELECT id, current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
}

// Best-effort live notification through the Room DO. Silently swallows errors
// since the notify route is owned by the Lobby agent and may not exist yet.
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

// ---------- POST /api/games/:gameId/messages ----------

async function handleSend(req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');

  const sender = await callerFaction(env, gameId, session.user_id);
  if (!sender) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const scope = body.scope;
  if (scope !== 'dm' && scope !== 'group' && scope !== 'broadcast') {
    return err(400, 'bad_request', "scope must be 'dm', 'group', or 'broadcast'");
  }

  const text = typeof body.body === 'string' ? body.body : '';
  if (text.length < BODY_MIN) return err(400, 'bad_request', 'body required');
  if (text.length > BODY_MAX) return err(400, 'bad_request', `body must be <= ${BODY_MAX} chars`);

  const signed = body.signed ? 1 : 0;

  let recipients = [];
  if (scope === 'dm' || scope === 'group') {
    const raw = Array.isArray(body.recipient_faction_ids) ? body.recipient_faction_ids : [];
    const cleaned = [];
    const seen = new Set();
    for (const r of raw) {
      if (typeof r !== 'string' || !FACTION_ID_RE.test(r)) {
        return err(400, 'bad_request', 'invalid recipient_faction_ids');
      }
      if (seen.has(r)) continue;
      seen.add(r);
      cleaned.push(r);
    }
    if (scope === 'dm' && cleaned.length !== 1) {
      return err(400, 'bad_request', 'dm requires exactly one recipient');
    }
    if (scope === 'group' && cleaned.length < 2) {
      return err(400, 'bad_request', 'group requires at least two recipients');
    }
    // Verify all recipient factions exist in this game.
    const placeholders = cleaned.map(() => '?').join(',');
    const rows = await env.DB
      .prepare(`SELECT id FROM game_factions WHERE game_id = ? AND id IN (${placeholders})`)
      .bind(gameId, ...cleaned)
      .all();
    const found = new Set((rows.results ?? []).map(r => r.id));
    for (const r of cleaned) {
      if (!found.has(r)) return err(400, 'bad_request', `unknown faction: ${r}`);
    }
    recipients = cleaned;
  }

  const id = newId();
  const nowMs = Date.now();
  const tick = game.current_tick ?? 0;

  const stmts = [
    env.DB
      .prepare(
        `INSERT INTO messages
         (id, game_id, actual_sender_faction_id, claimed_sender_faction_id,
          scope, body, signed, sent_at_tick, sent_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, gameId, sender.id, sender.id, scope, text, signed, tick, nowMs),
  ];
  for (const r of recipients) {
    stmts.push(
      env.DB
        .prepare('INSERT INTO message_recipients (message_id, faction_id, read_at_ms) VALUES (?, ?, NULL)')
        .bind(id, r),
    );
  }
  await env.DB.batch(stmts);

  // Fire-and-forget live notification (best effort).
  notifyRoom(env, gameId, {
    kind: 'message',
    message_id: id,
    scope,
    sender_faction_id: sender.id,
    recipient_faction_ids: scope === 'broadcast' ? null : recipients,
    sent_at_ms: nowMs,
    sent_at_tick: tick,
  });

  return json({
    message: {
      id,
      scope,
      claimed_sender_faction_id: sender.id,
      body: text,
      signed: !!signed,
      sent_at_tick: tick,
      sent_at_ms: nowMs,
      recipient_faction_ids: scope === 'broadcast' ? null : recipients,
    },
  }, { status: 201 });
}

// ---------- GET /api/games/:gameId/messages ----------

async function handleList(req, env, { url, session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const sender = await callerFaction(env, gameId, session.user_id);
  if (!sender) return err(403, 'not_a_faction', 'you do not own a faction in this game');
  const fid = sender.id;

  let limit = parseInt(url.searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const since = url.searchParams.get('since');
  const withFaction = url.searchParams.get('with_faction');
  if (withFaction != null && !FACTION_ID_RE.test(withFaction)) {
    return err(400, 'bad_request', 'invalid with_faction');
  }
  if (since != null && !MSG_ID_RE.test(since)) {
    return err(400, 'bad_request', 'invalid since');
  }

  const where = ['m.game_id = ?'];
  const bind = [gameId];

  if (withFaction) {
    // Only messages between caller and `withFaction`. Broadcasts excluded
    // from thread view (they have no recipients table membership).
    where.push(`(
      (m.actual_sender_faction_id = ? AND m.id IN (SELECT message_id FROM message_recipients WHERE faction_id = ?))
      OR
      (m.actual_sender_faction_id = ? AND m.id IN (SELECT message_id FROM message_recipients WHERE faction_id = ?))
    )`);
    bind.push(fid, withFaction, withFaction, fid);
  } else {
    where.push(`(
      m.actual_sender_faction_id = ?
      OR m.scope = 'broadcast'
      OR m.id IN (SELECT message_id FROM message_recipients WHERE faction_id = ?)
    )`);
    bind.push(fid, fid);
  }

  if (since) {
    where.push(`(
      m.sent_at_ms > (SELECT sent_at_ms FROM messages WHERE id = ?)
      OR (m.sent_at_ms = (SELECT sent_at_ms FROM messages WHERE id = ?) AND m.id > ?)
    )`);
    bind.push(since, since, since);
  }

  const sql =
    `SELECT m.id, m.scope, m.claimed_sender_faction_id, m.body, m.signed,
            m.sent_at_tick, m.sent_at_ms
     FROM messages m
     WHERE ${where.join(' AND ')}
     ORDER BY m.sent_at_ms DESC, m.id DESC
     LIMIT ?`;
  bind.push(limit);

  const rows = (await env.DB.prepare(sql).bind(...bind).all()).results ?? [];

  // Batch-load recipients for the returned messages.
  const recipientMap = new Map();
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const rec = await env.DB
      .prepare(`SELECT message_id, faction_id, read_at_ms FROM message_recipients WHERE message_id IN (${placeholders})`)
      .bind(...ids)
      .all();
    for (const r of rec.results ?? []) {
      let arr = recipientMap.get(r.message_id);
      if (!arr) { arr = []; recipientMap.set(r.message_id, arr); }
      arr.push({ faction_id: r.faction_id, read_at_ms: r.read_at_ms });
    }
  }

  const messages = rows.map(r => {
    const recs = recipientMap.get(r.id) ?? [];
    const recipient_faction_ids = r.scope === 'broadcast' ? null : recs.map(x => x.faction_id);
    let read_by_caller = null;
    if (r.scope !== 'broadcast') {
      const mine = recs.find(x => x.faction_id === fid);
      read_by_caller = mine ? mine.read_at_ms != null : null;
    }
    return {
      id: r.id,
      scope: r.scope,
      claimed_sender_faction_id: r.claimed_sender_faction_id,
      body: r.body,
      signed: !!r.signed,
      sent_at_tick: r.sent_at_tick,
      sent_at_ms: r.sent_at_ms,
      recipient_faction_ids,
      read_by_caller,
    };
  });

  return json({ messages, caller_faction_id: fid });
}

// ---------- POST /api/games/:gameId/messages/:messageId/read ----------

async function handleMarkRead(req, env, { session, params }) {
  const gameId = params.gameId;
  const messageId = params.messageId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!MSG_ID_RE.test(messageId)) return err(400, 'bad_request', 'invalid message id');

  const sender = await callerFaction(env, gameId, session.user_id);
  if (!sender) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const msg = await env.DB
    .prepare('SELECT id FROM messages WHERE id = ? AND game_id = ?')
    .bind(messageId, gameId)
    .first();
  if (!msg) return err(404, 'not_found', 'message not found');

  const recRow = await env.DB
    .prepare('SELECT read_at_ms FROM message_recipients WHERE message_id = ? AND faction_id = ?')
    .bind(messageId, sender.id)
    .first();
  if (!recRow) return err(403, 'not_recipient', 'you are not a recipient of this message');

  if (recRow.read_at_ms == null) {
    await env.DB
      .prepare('UPDATE message_recipients SET read_at_ms = ? WHERE message_id = ? AND faction_id = ?')
      .bind(Date.now(), messageId, sender.id)
      .run();
  }
  return new Response(null, { status: 204 });
}

// ---------- GET /api/games/:gameId/messages/unread-count ----------

async function handleUnreadCount(req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const sender = await callerFaction(env, gameId, session.user_id);
  if (!sender) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c
       FROM message_recipients mr
       JOIN messages m ON m.id = mr.message_id
       WHERE m.game_id = ? AND mr.faction_id = ? AND mr.read_at_ms IS NULL`,
    )
    .bind(gameId, sender.id)
    .first();

  return json({ unread: row?.c ?? 0 });
}

// ---------- routes ----------

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/messages$/,
    auth: 'required',
    handle: handleSend,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/messages$/,
    auth: 'required',
    handle: handleList,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/messages\/unread-count$/,
    auth: 'required',
    handle: handleUnreadCount,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/messages\/(?<messageId>[^/]+)\/read$/,
    auth: 'required',
    handle: handleMarkRead,
  },
];
