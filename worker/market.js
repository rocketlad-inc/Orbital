// The open market — trade offers with no named responder.
//
// Endpoints (all auth: 'required', caller must own a faction in the game):
//   GET    /api/games/:gameId/market                  — every open post + recent fills
//   POST   /api/games/:gameId/market                  — post an offer to the market
//   POST   /api/games/:gameId/market/:postId/take     — take a post (strikes the deal)
//   POST   /api/games/:gameId/market/:postId/withdraw — poster pulls their post
//
// A post is only the ADVERT. Taking one mints an ordinary trade_offers
// row (poster = proposer, taker = responder) and runs it through
// trades.handleAccept, so everything downstream — deliveries that ride
// freighters, standing agreements, the pinned-hull lane start, tariffs,
// the "your offer was accepted" DM — is the private-deal machinery,
// unchanged. There is no second economy to keep in step.
//
// VISIBILITY (Lorne): every faction sees every post, enemies included.
// "Let everyone know what your enemies are trading." Nothing here gates
// on war, embargo or pacts — that rule is parked, deliberately.
//
// A COUNTER to a post is not handled here: it is a private offer to the
// poster (POST /trades with market_post_id), and the post stays open for
// anyone else. Haggling is between two parties; the advert is public.

import {
  json, err, readJson, newId, callerFaction, loadGame, loadFaction, notifyRoom,
  normalizeResources, validateOfferedShip, handleAccept, tradeRowToJson,
} from './trades.js';

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const POST_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NOTE_MAX = 200;

/** How long a post stays listed. At the default 1h tick that is three
 *  days — long enough to be seen by a player who logs in daily, short
 *  enough that the board is not a graveyard of offers whose poster spent
 *  the metal a week ago. */
export const MARKET_POST_TTL_TICKS = 72;
/** Open posts per faction. A market is a board, not a feed; without a
 *  cap one player can bury it. */
export const MARKET_MAX_OPEN_POSTS = 5;
/** A 'taking' claim older than this is a worker that died mid-take. */
const STALE_CLAIM_MS = 120_000;
const RECENT_FILLS = 8;

const KEYS = ['metal', 'gold', 'science'];

function postRowToJson(row, callerFactionId) {
  return {
    id: row.id,
    poster_faction_id: row.poster_faction_id,
    poster_name: row.poster_name ?? null,
    poster_color: row.poster_color ?? null,
    status: row.status,
    offer: { metal: row.offer_metal, gold: row.offer_gold, science: row.offer_science },
    request: { metal: row.request_metal, gold: row.request_gold, science: row.request_science },
    recurring: Number(row.recurring ?? 0) === 1,
    // Whether the poster pinned a freighter — i.e. whether taking a
    // standing post starts the lane at once or leaves both sides to
    // commission a leg. The hull's identity is the poster's business.
    has_ship: !!row.offered_ship_id,
    note: row.note ?? null,
    created_at_tick: row.created_at_tick,
    expires_at_tick: row.expires_at_tick,
    mine: row.poster_faction_id === callerFactionId,
    taken_by_faction_id: row.taken_by_faction_id ?? null,
    taken_by_name: row.taker_name ?? null,
    taken_by_color: row.taker_color ?? null,
    taken_at_tick: row.taken_at_tick ?? null,
  };
}

/** Self-heal claims left behind by a worker that died between claiming
 *  a post and finishing the take. If the minted offer WAS accepted the
 *  post is filled; otherwise it goes back on the board. */
async function healStaleClaims(env, gameId) {
  const cutoff = Date.now() - STALE_CLAIM_MS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE market_posts SET status = 'filled'
        WHERE game_id = ? AND status = 'taking' AND taking_at_ms < ?
          AND EXISTS (SELECT 1 FROM trade_offers t
                       WHERE t.market_post_id = market_posts.id AND t.status = 'accepted')`,
    ).bind(gameId, cutoff),
    env.DB.prepare(
      `UPDATE market_posts SET status = 'open', taking_at_ms = NULL,
              taken_by_faction_id = NULL
        WHERE game_id = ? AND status = 'taking' AND taking_at_ms < ?`,
    ).bind(gameId, cutoff),
  ]);
}

// ---------- GET /api/games/:gameId/market ----------

async function handleListMarket(_req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');
  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');
  const tick = game.current_tick ?? 0;

  try { await healStaleClaims(env, gameId); } catch (e) { console.error('market: heal failed', e); }

  // Open posts, newest first. A dead faction's adverts come down with it.
  const open = await env.DB
    .prepare(
      `SELECT p.*, f.name AS poster_name, f.color AS poster_color
         FROM market_posts p
         JOIN game_factions f ON f.id = p.poster_faction_id
        WHERE p.game_id = ? AND p.status = 'open' AND p.expires_at_tick > ?
          AND f.eliminated_at_tick IS NULL
        ORDER BY p.created_at_ms DESC
        LIMIT 100`,
    )
    .bind(gameId, tick).all();

  // The tape: who took what. Public on purpose — a market you can only
  // see half of is a rumour mill.
  const recent = await env.DB
    .prepare(
      `SELECT p.*, f.name AS poster_name, f.color AS poster_color,
              t.name AS taker_name, t.color AS taker_color
         FROM market_posts p
         JOIN game_factions f ON f.id = p.poster_faction_id
         LEFT JOIN game_factions t ON t.id = p.taken_by_faction_id
        WHERE p.game_id = ? AND p.status = 'filled'
        ORDER BY p.taken_at_ms DESC
        LIMIT ?`,
    )
    .bind(gameId, RECENT_FILLS).all();

  return json({
    posts: (open.results ?? []).map(r => postRowToJson(r, caller.id)),
    recent: (recent.results ?? []).map(r => postRowToJson(r, caller.id)),
    caller_faction_id: caller.id,
    tick,
    max_open: MARKET_MAX_OPEN_POSTS,
    ttl_ticks: MARKET_POST_TTL_TICKS,
  });
}

// ---------- POST /api/games/:gameId/market ----------

async function handlePost(req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');
  const poster = await callerFaction(env, gameId, session.user_id);
  if (!poster) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  // A treaty with "whoever turns up" is not a treaty. Pacts stay a
  // private-offer concern; the market moves goods.
  if ((Array.isArray(body.offer_pacts) && body.offer_pacts.length)
      || (Array.isArray(body.request_pacts) && body.request_pacts.length)) {
    return err(400, 'bad_request', 'a market post carries goods only — treaties are offered privately');
  }

  const res = normalizeResources(body);
  if (!res.ok) return err(400, 'bad_request', res.error);
  const offerSum = KEYS.reduce((s, k) => s + res.offer[k], 0);
  const requestSum = KEYS.reduce((s, k) => s + res.request[k], 0);
  // A listing has a price. One-sided posts (a gift, or a begging bowl)
  // are what comms is for.
  if (offerSum === 0 || requestSum === 0) {
    return err(400, 'bad_request', 'a market post needs something on both sides — what you give and what you want');
  }
  // Soft check, same as a private offer: can you cover (the first run
  // of) what you are advertising right now. Goods are debited when a
  // freighter loads them, not here.
  for (const k of KEYS) {
    if (poster[k] < res.offer[k]) {
      return err(400, 'insufficient_resources', `you don't have ${res.offer[k]} ${k === 'gold' ? 'credits' : k} to offer`);
    }
  }

  const tick = game.current_tick ?? 0;
  const openCount = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM market_posts
        WHERE game_id = ? AND poster_faction_id = ? AND status = 'open' AND expires_at_tick > ?`,
    )
    .bind(gameId, poster.id, tick).first();
  if (Number(openCount?.n ?? 0) >= MARKET_MAX_OPEN_POSTS) {
    return err(409, 'too_many_posts',
      `you already have ${MARKET_MAX_OPEN_POSTS} posts on the market — withdraw one first`);
  }

  const recurring = body.recurring === true || body.recurring === 1;
  let offeredShipId = null;
  if (recurring && body.ship_id != null) {
    const v = await validateOfferedShip(env, gameId, poster.id, body.ship_id);
    if (v.error) return v.error;
    offeredShipId = v.shipId;
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) || null : null;
  const id = newId();
  await env.DB
    .prepare(
      `INSERT INTO market_posts
         (id, game_id, poster_faction_id, status,
          offer_metal, offer_gold, offer_science,
          request_metal, request_gold, request_science,
          recurring, offered_ship_id, note,
          created_at_tick, created_at_ms, expires_at_tick)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, gameId, poster.id,
      res.offer.metal, res.offer.gold, res.offer.science,
      res.request.metal, res.request.gold, res.request.science,
      recurring ? 1 : 0, offeredShipId, note,
      tick, Date.now(), tick + MARKET_POST_TTL_TICKS,
    )
    .run();

  notifyRoom(env, gameId, {
    kind: 'market', event: 'posted', post_id: id,
    poster_faction_id: poster.id, poster_faction_name: poster.name,
  });

  const row = await env.DB
    .prepare(
      `SELECT p.*, f.name AS poster_name, f.color AS poster_color
         FROM market_posts p JOIN game_factions f ON f.id = p.poster_faction_id
        WHERE p.id = ?`,
    )
    .bind(id).first();
  return json({ post: postRowToJson(row, poster.id) }, { status: 201 });
}

// ---------- POST /api/games/:gameId/market/:postId/take ----------

async function handleTake(req, env, { session, params }) {
  const gameId = params.gameId;
  const postId = params.postId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!POST_ID_RE.test(postId)) return err(400, 'bad_request', 'invalid post id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');
  const taker = await callerFaction(env, gameId, session.user_id);
  if (!taker) return err(403, 'not_a_faction', 'you do not own a faction in this game');
  const tick = game.current_tick ?? 0;

  const post = await env.DB
    .prepare('SELECT * FROM market_posts WHERE id = ? AND game_id = ?')
    .bind(postId, gameId).first();
  if (!post) return err(404, 'not_found', 'that post is not on the market');
  if (post.poster_faction_id === taker.id) {
    return err(400, 'own_post', 'that is your own post — withdraw it instead');
  }
  if (post.status !== 'open') {
    return err(409, 'not_open', post.status === 'withdrawn'
      ? 'the poster withdrew that offer'
      : 'someone else already took that offer');
  }
  if (Number(post.expires_at_tick) <= tick) {
    return err(409, 'expired', 'that post has expired');
  }
  const poster = await loadFaction(env, gameId, post.poster_faction_id);
  if (!poster) return err(409, 'poster_missing', 'the poster is gone');

  // CLAIM FIRST. Two players hitting TAKE in the same second must not
  // both strike the deal; the guarded UPDATE lets exactly one through.
  const nowMs = Date.now();
  const claim = await env.DB
    .prepare(
      `UPDATE market_posts SET status = 'taking', taking_at_ms = ?, taken_by_faction_id = ?
        WHERE id = ? AND status = 'open'`,
    )
    .bind(nowMs, taker.id, postId).run();
  if (!claim.meta?.changes) {
    return err(409, 'not_open', 'someone else just took that offer');
  }

  const release = async () => {
    await env.DB
      .prepare(
        `UPDATE market_posts SET status = 'open', taking_at_ms = NULL, taken_by_faction_id = NULL
          WHERE id = ? AND status = 'taking'`,
      )
      .bind(postId).run();
  };

  const tradeId = newId();
  try {
    // The advert becomes a deal: an ordinary private offer from the
    // poster to the taker, answered on the spot.
    await env.DB
      .prepare(
        `INSERT INTO trade_offers
           (id, game_id, proposer_faction_id, responder_faction_id, status,
            offer_metal, offer_fuel, offer_gold, offer_science,
            request_metal, request_fuel, request_gold, request_science,
            offer_pacts, request_pacts,
            parent_offer_id, note, recurring, offered_ship_id, market_post_id,
            created_at_tick, created_at_ms)
         VALUES (?, ?, ?, ?, 'open',
                 ?, 0, ?, ?,
                 ?, 0, ?, ?,
                 '[]', '[]',
                 NULL, ?, ?, ?, ?,
                 ?, ?)`,
      )
      .bind(
        tradeId, gameId, post.poster_faction_id, taker.id,
        post.offer_metal, post.offer_gold, post.offer_science,
        post.request_metal, post.request_gold, post.request_science,
        post.note, Number(post.recurring ?? 0), post.offered_ship_id ?? null, postId,
        tick, nowMs,
      )
      .run();

    const accepted = await handleAccept(req, env, {
      session, params: { gameId, tradeId },
    });
    if (accepted.status >= 400) {
      // The deal did not strike. Take the stillborn offer off both
      // players' tables and put the advert back on the board.
      await env.DB
        .prepare(
          `UPDATE trade_offers SET status = 'cancelled', resolved_at_ms = ?
            WHERE id = ? AND status = 'open'`,
        )
        .bind(Date.now(), tradeId).run();
      await release();
      return accepted;
    }

    await env.DB
      .prepare(
        `UPDATE market_posts
            SET status = 'filled', taken_by_faction_id = ?, taken_at_tick = ?,
                taken_at_ms = ?, trade_offer_id = ?
          WHERE id = ?`,
      )
      .bind(taker.id, tick, Date.now(), tradeId, postId).run();

    notifyRoom(env, gameId, {
      kind: 'market', event: 'filled', post_id: postId, trade_id: tradeId,
      poster_faction_id: post.poster_faction_id, poster_faction_name: poster.name,
      taker_faction_id: taker.id, taker_faction_name: taker.name,
    });

    const offerRow = await env.DB
      .prepare('SELECT * FROM trade_offers WHERE id = ?').bind(tradeId).first();
    const postRow = await env.DB
      .prepare(
        `SELECT p.*, f.name AS poster_name, f.color AS poster_color,
                t.name AS taker_name, t.color AS taker_color
           FROM market_posts p
           JOIN game_factions f ON f.id = p.poster_faction_id
           LEFT JOIN game_factions t ON t.id = p.taken_by_faction_id
          WHERE p.id = ?`,
      )
      .bind(postId).first();
    return json({ post: postRowToJson(postRow, taker.id), trade: tradeRowToJson(offerRow) });
  } catch (e) {
    console.error('market take failed', e, { postId, tradeId });
    try {
      // If the accept landed before the throw, the deal stands and the
      // post is filled; healStaleClaims makes the same call later.
      const t = await env.DB
        .prepare('SELECT status FROM trade_offers WHERE id = ?').bind(tradeId).first();
      if (t?.status === 'accepted') {
        await env.DB
          .prepare(
            `UPDATE market_posts SET status = 'filled', taken_at_tick = ?, taken_at_ms = ?, trade_offer_id = ?
              WHERE id = ?`,
          )
          .bind(tick, Date.now(), tradeId, postId).run();
      } else {
        await env.DB
          .prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at_ms = ? WHERE id = ? AND status = 'open'`)
          .bind(Date.now(), tradeId).run();
        await release();
      }
    } catch { /* healStaleClaims is the backstop */ }
    return err(500, 'take_failed', 'the deal could not be struck — try again');
  }
}

// ---------- POST /api/games/:gameId/market/:postId/withdraw ----------

async function handleWithdraw(_req, env, { session, params }) {
  const gameId = params.gameId;
  const postId = params.postId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!POST_ID_RE.test(postId)) return err(400, 'bad_request', 'invalid post id');
  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return err(403, 'not_a_faction', 'you do not own a faction in this game');

  const post = await env.DB
    .prepare('SELECT id, poster_faction_id, status FROM market_posts WHERE id = ? AND game_id = ?')
    .bind(postId, gameId).first();
  if (!post) return err(404, 'not_found', 'that post is not on the market');
  if (post.poster_faction_id !== caller.id) return err(403, 'not_poster', 'only the poster can withdraw a post');

  const done = await env.DB
    .prepare(`UPDATE market_posts SET status = 'withdrawn' WHERE id = ? AND status = 'open'`)
    .bind(postId).run();
  if (!done.meta?.changes) {
    return err(409, 'not_open', post.status === 'withdrawn'
      ? 'already withdrawn' : 'too late — that post has been taken');
  }
  notifyRoom(env, gameId, { kind: 'market', event: 'withdrawn', post_id: postId, poster_faction_id: caller.id });
  return json({ ok: true });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/market$/,
    auth: 'required',
    handle: handleListMarket,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/market$/,
    auth: 'required',
    handle: handlePost,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/market\/(?<postId>[^/]+)\/take$/,
    auth: 'required',
    handle: handleTake,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/market\/(?<postId>[^/]+)\/withdraw$/,
    auth: 'required',
    handle: handleWithdraw,
  },
];
