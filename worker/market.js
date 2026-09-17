// The open market — trade offers with no named responder.
//
// Endpoints (all auth: 'required', caller must own a faction in the game):
//   GET    /api/games/:gameId/market                  — the board, the tape, going rates
//   POST   /api/games/:gameId/market                  — post an offer to the market
//   POST   /api/games/:gameId/market/:postId/take     — take a post, or part of one
//   POST   /api/games/:gameId/market/:postId/withdraw — poster pulls their post
//   POST   /api/games/:gameId/market/:postId/renew    — poster re-lists for the same lifetime
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
// on war, embargo or pacts — that rule is parked, deliberately. (The
// Senate TARIFF is read, but only to tell a taker what they will
// actually receive; it blocks nothing.)
//
// LOTS (migration 0128). A DIVISIBLE post — one resource each way,
// one-time — sells by the unit: a taker buys any amount and pays pro
// rata, rounded up in the poster's favour. Everything else is one lot.
// filled_units counts units sold or reserved by a take in flight, so
// two takers can never buy the same metal.
//
// A COUNTER to a post is not handled here: it is a private offer to the
// poster (POST /trades with market_post_id), and the post stays open for
// anyone else. Haggling is between two parties; the advert is public.

import {
  json, err, readJson, newId, callerFaction, loadGame, loadFaction, notifyRoom,
  normalizeResources, validateOfferedShip, handleAccept, handleAssignDelivery, tradeRowToJson,
} from './trades.js';
import { getSliderResolver } from './senate.js';

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const POST_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NOTE_MAX = 200;

/** Default lifetime, in ticks, when the poster names none. */
export const MARKET_POST_TTL_TICKS = 72;
/** Lifetimes a poster may choose, in real hours. Converted to ticks at
 *  the game's own tick length, so "3 days" means three days in a fast
 *  game and a slow one alike. */
export const MARKET_TTL_HOURS = [12, 24, 72, 168];
const MIN_TTL_TICKS = 6;
const MAX_TTL_TICKS = 2000;
/** Open posts per faction. A market is a board, not a feed; without a
 *  cap one player can bury it. */
export const MARKET_MAX_OPEN_POSTS = 5;
/** A unit reservation older than this with no deal behind it is a
 *  worker that died mid-take. */
const STALE_CLAIM_MS = 120_000;
const RECENT_FILLS = 8;
const RATE_SAMPLE = 40;
/** A delivery leg nobody has put a freighter on for this many ticks
 *  counts against its sender's record. */
const STALLED_AFTER_TICKS = 48;

const KEYS = ['metal', 'gold', 'science'];
const WORD = { metal: 'metal', gold: 'credits', science: 'science' };

const bundleOf = (row, prefix) => ({
  metal: Number(row[`${prefix}_metal`] ?? 0),
  gold: Number(row[`${prefix}_gold`] ?? 0),
  science: Number(row[`${prefix}_science`] ?? 0),
});
const nonZero = (b) => KEYS.filter(k => (b[k] ?? 0) > 0);
const words = (b) => nonZero(b).map(k => `**${Math.round(b[k]).toLocaleString('en-US')}** ${WORD[k]}`).join(' + ') || '_nothing_';

/** Units a post is sold in: its whole offer amount if divisible, else 1. */
function totalUnits(row) {
  if (Number(row.divisible ?? 0) !== 1) return 1;
  const o = bundleOf(row, 'offer');
  return o[nonZero(o)[0]] ?? 1;
}

/** What `units` of a divisible post cost: pro rata, rounded UP so a
 *  buyer can never shave the poster by splitting an order. */
export function priceForUnits(row, units) {
  const o = bundleOf(row, 'offer');
  const r = bundleOf(row, 'request');
  const oK = nonZero(o)[0];
  const rK = nonZero(r)[0];
  const pay = Math.max(1, Math.ceil((units * r[rK]) / o[oK]));
  return {
    offer: { metal: 0, gold: 0, science: 0, [oK]: units },
    request: { metal: 0, gold: 0, science: 0, [rK]: pay },
  };
}

/** What is still on the table. For a one-lot post that is all of it. */
function remainingOf(row) {
  if (Number(row.divisible ?? 0) !== 1) {
    return { offer: bundleOf(row, 'offer'), request: bundleOf(row, 'request'), units: 1 - Math.min(1, Number(row.filled_units ?? 0)) };
  }
  const left = Math.max(0, totalUnits(row) - Number(row.filled_units ?? 0));
  if (left === 0) return { offer: { metal: 0, gold: 0, science: 0 }, request: { metal: 0, gold: 0, science: 0 }, units: 0 };
  return { ...priceForUnits(row, left), units: left };
}

/** One price per market, whichever way round a deal was posted: credits
 *  are the quote when either side is credits, else metal. Returns the
 *  price of 1 `base` in `quote`, or null for a bundle. */
export function pairPrice(offer, request) {
  const o = nonZero(offer);
  const r = nonZero(request);
  if (o.length !== 1 || r.length !== 1 || o[0] === r[0]) return null;
  const quote = (o[0] === 'gold' || r[0] === 'gold') ? 'gold' : 'metal';
  const base = o[0] === quote ? r[0] : o[0];
  const price = o[0] === quote ? offer[o[0]] / request[r[0]] : request[r[0]] / offer[o[0]];
  if (!Number.isFinite(price) || price <= 0) return null;
  return { base, quote, price };
}

function postRowToJson(row, callerFactionId, tick, records) {
  const rem = remainingOf(row);
  const rec = records?.get(row.poster_faction_id) ?? null;
  return {
    id: row.id,
    poster_faction_id: row.poster_faction_id,
    poster_name: row.poster_name ?? null,
    poster_color: row.poster_color ?? null,
    status: row.status,
    // What is STILL on the table — for a part-sold lot, the remainder.
    offer: rem.offer,
    request: rem.request,
    original_offer: bundleOf(row, 'offer'),
    original_request: bundleOf(row, 'request'),
    divisible: Number(row.divisible ?? 0) === 1,
    units_left: rem.units,
    units_total: totalUnits(row),
    recurring: Number(row.recurring ?? 0) === 1,
    // Whether the poster pinned a freighter. On a standing post the lane
    // flies the moment it is taken; on a one-time post their half ships
    // without them having to come back. The hull's identity is theirs.
    has_ship: !!row.offered_ship_id,
    note: row.note ?? null,
    created_at_tick: row.created_at_tick,
    created_at_ms: row.created_at_ms,
    expires_at_tick: row.expires_at_tick,
    ttl_ticks: Number(row.ttl_ticks ?? MARKET_POST_TTL_TICKS),
    expired: tick != null && Number(row.expires_at_tick) <= tick,
    mine: row.poster_faction_id === callerFactionId,
    // The poster's delivery record: legs they have landed, and legs they
    // have left sitting with no freighter. Nothing escrows a post, so
    // this is how you judge a stranger.
    poster_record: rec ? { delivered: rec.delivered, stalled: rec.stalled } : { delivered: 0, stalled: 0 },
  };
}

function fillRowToJson(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    poster_faction_id: row.poster_faction_id,
    poster_name: row.poster_name ?? null,
    poster_color: row.poster_color ?? null,
    taker_faction_id: row.taker_faction_id,
    taker_name: row.taker_name ?? null,
    taker_color: row.taker_color ?? null,
    offer: bundleOf(row, 'offer'),
    request: bundleOf(row, 'request'),
    recurring: Number(row.recurring ?? 0) === 1,
    at_tick: row.at_tick,
  };
}

/** Repair reservations left by a worker that died mid-take. The truth
 *  is trade_offers: a deal minted from this post and accepted is sold,
 *  whether or not its tape row got written. */
async function healStaleClaims(env, gameId) {
  const cutoff = Date.now() - STALE_CLAIM_MS;
  const suspects = (await env.DB
    .prepare(
      `SELECT * FROM (
         SELECT p.*, (SELECT COALESCE(SUM(f.units), 0) FROM market_fills f WHERE f.post_id = p.id) AS sold
           FROM market_posts p
          WHERE p.game_id = ? AND p.status = 'open'
            AND p.taking_at_ms IS NOT NULL AND p.taking_at_ms < ?
       ) WHERE filled_units != sold LIMIT 10`,
    )
    .bind(gameId, cutoff).all()).results ?? [];
  for (const p of suspects) {
    const divisible = Number(p.divisible ?? 0) === 1;
    const oK = nonZero(bundleOf(p, 'offer'))[0];
    const orphans = (await env.DB
      .prepare(
        `SELECT t.* FROM trade_offers t
          WHERE t.market_post_id = ? AND t.proposer_faction_id = ? AND t.status = 'accepted'
            AND NOT EXISTS (SELECT 1 FROM market_fills f WHERE f.trade_offer_id = t.id)`,
      )
      .bind(p.id, p.poster_faction_id).all()).results ?? [];
    let sold = Number(p.sold ?? 0);
    for (const t of orphans) {
      const units = divisible ? Number(t[`offer_${oK}`] ?? 0) : 1;
      await insertFill(env, p, t.responder_faction_id, units, bundleOf(t, 'offer'), bundleOf(t, 'request'),
        t.id, t.created_at_tick ?? 0, t.created_at_ms ?? Date.now());
      sold += units;
    }
    await env.DB
      .prepare(
        `UPDATE market_posts SET filled_units = ?, taking_at_ms = NULL,
                status = CASE WHEN ? >= ? THEN 'filled' ELSE 'open' END
          WHERE id = ? AND status = 'open'`,
      )
      .bind(sold, sold, totalUnits(p), p.id).run();
  }
}

async function insertFill(env, post, takerId, units, offer, request, tradeId, tick, ms) {
  await env.DB
    .prepare(
      `INSERT INTO market_fills
         (id, game_id, post_id, poster_faction_id, taker_faction_id, units,
          offer_metal, offer_gold, offer_science,
          request_metal, request_gold, request_science,
          recurring, trade_offer_id, at_tick, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(), post.game_id, post.id, post.poster_faction_id, takerId, units,
      offer.metal, offer.gold, offer.science,
      request.metal, request.gold, request.science,
      Number(post.recurring ?? 0), tradeId, tick, ms,
    )
    .run();
}

/** Tell a poster, once, that their advert came down unsold. Expiry is
 *  lazy — nothing sweeps the board — so the first list call after the
 *  deadline is what notices. */
async function notifyLapsed(env, gameId, tick) {
  const lapsed = (await env.DB
    .prepare(
      `SELECT * FROM market_posts
        WHERE game_id = ? AND status = 'open' AND expires_at_tick <= ? AND lapse_notified = 0
        LIMIT 3`,
    )
    .bind(gameId, tick).all()).results ?? [];
  if (!lapsed.length) return;
  const notify = await import('./notify.js');
  for (const p of lapsed) {
    const claim = await env.DB
      .prepare('UPDATE market_posts SET lapse_notified = 1 WHERE id = ? AND lapse_notified = 0')
      .bind(p.id).run();
    if (!claim.meta?.changes) continue;
    const uid = await notify.userIdForFaction(env, p.poster_faction_id);
    if (!uid) continue;
    const rem = remainingOf(p);
    await notify.sendDm(env, {
      userId: uid, gameId, category: 'market', dedupeKey: `market-lapsed:${p.id}`,
      embed: {
        title: '⌛ Your market post expired',
        description: `Nobody took **${words(rem.offer).replace(/\*\*/g, '')}** for ${words(rem.request)}.\n`
          + 'Renew it from the Trade panel (MARKET · Mine), or post it again at a better price.',
        color: 0x8a9fb3,
        footer: { text: `Orbital · T+${tick}` },
      },
    });
  }
}

/** Per-faction delivery record for the whole game, in one query. */
async function deliveryRecords(env, gameId, tick) {
  const rows = (await env.DB
    .prepare(
      `SELECT sender_faction_id AS fid,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'unassigned' AND resolved_at_tick IS NULL AND created_at_tick < ?
                       THEN 1 ELSE 0 END) AS stalled
         FROM trade_deliveries WHERE game_id = ? GROUP BY sender_faction_id`,
    )
    .bind(tick - STALLED_AFTER_TICKS, gameId).all()).results ?? [];
  const m = new Map();
  for (const r of rows) m.set(r.fid, { delivered: Number(r.delivered ?? 0), stalled: Number(r.stalled ?? 0) });
  return m;
}

/** What things have actually been going for: low / middle / high of the
 *  recent fills in each market. Real deals only — no model, no maker. */
function goingRates(fillRows) {
  const by = new Map();
  for (const f of fillRows) {
    const p = pairPrice(bundleOf(f, 'offer'), bundleOf(f, 'request'));
    if (!p) continue;
    const key = `${p.base}/${p.quote}`;
    if (!by.has(key)) by.set(key, { base: p.base, quote: p.quote, prices: [] });
    by.get(key).prices.push(p.price);
  }
  return [...by.values()].map(({ base, quote, prices }) => {
    const s = [...prices].sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { base, quote, low: s[0], high: s[s.length - 1], mid, n: s.length };
  });
}

const POST_SELECT = `SELECT p.*, f.name AS poster_name, f.color AS poster_color
                       FROM market_posts p
                       JOIN game_factions f ON f.id = p.poster_faction_id`;

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
  try { await notifyLapsed(env, gameId, tick); } catch (e) { console.error('market: lapse notice failed', e); }

  const [open, mineExpired, recent, sample, records] = await Promise.all([
    // Open posts, newest first. A dead faction's adverts come down with it.
    env.DB.prepare(
      `${POST_SELECT}
        WHERE p.game_id = ? AND p.status = 'open' AND p.expires_at_tick > ?
          AND f.eliminated_at_tick IS NULL
        ORDER BY p.created_at_ms DESC LIMIT 100`,
    ).bind(gameId, tick).all(),
    // The caller's own lapsed posts, so they can renew or clear them.
    env.DB.prepare(
      `${POST_SELECT}
        WHERE p.game_id = ? AND p.status = 'open' AND p.expires_at_tick <= ?
          AND p.poster_faction_id = ?
        ORDER BY p.expires_at_tick DESC LIMIT 10`,
    ).bind(gameId, tick, caller.id).all(),
    // The tape: who took what. Public on purpose — a market you can only
    // see half of is a rumour mill.
    env.DB.prepare(
      `SELECT m.*, f.name AS poster_name, f.color AS poster_color,
              t.name AS taker_name, t.color AS taker_color
         FROM market_fills m
         LEFT JOIN game_factions f ON f.id = m.poster_faction_id
         LEFT JOIN game_factions t ON t.id = m.taker_faction_id
        WHERE m.game_id = ? ORDER BY m.at_ms DESC LIMIT ?`,
    ).bind(gameId, RECENT_FILLS).all(),
    env.DB.prepare(
      'SELECT * FROM market_fills WHERE game_id = ? ORDER BY at_ms DESC LIMIT ?',
    ).bind(gameId, RATE_SAMPLE).all(),
    deliveryRecords(env, gameId, tick),
  ]);

  // What the Senate skims off whatever the CALLER receives. Shown so a
  // taker sees the number that will actually land, not the sticker.
  let myTariff = 0;
  try {
    const resolve = await getSliderResolver(env, gameId, tick);
    myTariff = Math.max(0, Math.min(100, Math.round(Number(resolve(caller.id).trade_tariff_pct ?? 0))));
  } catch { /* an un-legislated game has no tariff */ }

  return json({
    posts: (open.results ?? []).map(r => postRowToJson(r, caller.id, tick, records)),
    mine_expired: (mineExpired.results ?? []).map(r => postRowToJson(r, caller.id, tick, records)),
    recent: (recent.results ?? []).map(fillRowToJson),
    rates: goingRates(sample.results ?? []),
    caller_faction_id: caller.id,
    tick,
    tick_interval_ms: Number(game.tick_interval_ms ?? 3600000),
    my_tariff_pct: myTariff,
    max_open: MARKET_MAX_OPEN_POSTS,
    ttl_ticks: MARKET_POST_TTL_TICKS,
    ttl_hours: MARKET_TTL_HOURS,
  });
}

// ---------- POST /api/games/:gameId/market ----------

async function openPostCount(env, gameId, factionId, tick) {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM market_posts
        WHERE game_id = ? AND poster_faction_id = ? AND status = 'open' AND expires_at_tick > ?`,
    )
    .bind(gameId, factionId, tick).first();
  return Number(row?.n ?? 0);
}

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
      return err(400, 'insufficient_resources', `you don't have ${res.offer[k]} ${WORD[k]} to offer`);
    }
  }

  const tick = game.current_tick ?? 0;
  if (await openPostCount(env, gameId, poster.id, tick) >= MARKET_MAX_OPEN_POSTS) {
    return err(409, 'too_many_posts',
      `you already have ${MARKET_MAX_OPEN_POSTS} posts on the market — withdraw one first`);
  }

  const recurring = body.recurring === true || body.recurring === 1;
  // Sold by the unit: only where a unit has one price. A bundle has no
  // pro-rata, and a standing route's numbers are already a rate.
  const divisible = body.divisible === true || body.divisible === 1;
  if (divisible) {
    if (recurring) return err(400, 'bad_request', 'a standing route cannot be sold in parts');
    if (nonZero(res.offer).length !== 1 || nonZero(res.request).length !== 1) {
      return err(400, 'bad_request', 'only a one-for-one post can be sold in parts — one resource each way');
    }
  }

  // The poster's freighter. On a standing post it flies the lane the
  // moment the post is taken; on a one-time post it ships the poster's
  // half without them coming back. Re-checked at take time either way.
  let offeredShipId = null;
  if (body.ship_id != null && body.ship_id !== '') {
    const v = await validateOfferedShip(env, gameId, poster.id, body.ship_id);
    if (v.error) return v.error;
    offeredShipId = v.shipId;
  }

  // Lifetime: real hours, converted at this game's tick length.
  let ttlTicks = MARKET_POST_TTL_TICKS;
  if (body.ttl_hours != null) {
    const hours = Number(body.ttl_hours);
    if (!MARKET_TTL_HOURS.includes(hours)) {
      return err(400, 'bad_request', `ttl_hours must be one of ${MARKET_TTL_HOURS.join(', ')}`);
    }
    const interval = Math.max(1, Number(game.tick_interval_ms ?? 3600000));
    ttlTicks = Math.max(MIN_TTL_TICKS, Math.min(MAX_TTL_TICKS, Math.round((hours * 3600000) / interval)));
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) || null : null;
  const id = newId();
  await env.DB
    .prepare(
      `INSERT INTO market_posts
         (id, game_id, poster_faction_id, status,
          offer_metal, offer_gold, offer_science,
          request_metal, request_gold, request_science,
          recurring, divisible, offered_ship_id, note,
          created_at_tick, created_at_ms, expires_at_tick, ttl_ticks)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, gameId, poster.id,
      res.offer.metal, res.offer.gold, res.offer.science,
      res.request.metal, res.request.gold, res.request.science,
      recurring ? 1 : 0, divisible ? 1 : 0, offeredShipId, note,
      tick, Date.now(), tick + ttlTicks, ttlTicks,
    )
    .run();

  notifyRoom(env, gameId, {
    kind: 'market', event: 'posted', post_id: id,
    poster_faction_id: poster.id, poster_faction_name: poster.name,
  });

  // TELL THE OTHER PLAYERS. A board nobody is looking at sells nothing:
  // a post used to sit silent until it expired. Everyone else in the
  // game gets one DM with a working Take button, under its own
  // 'market' category so it can be muted without muting real offers.
  try {
    const others = (await env.DB
      .prepare(
        `SELECT user_id FROM game_factions
          WHERE game_id = ? AND id != ? AND user_id IS NOT NULL AND eliminated_at_tick IS NULL`,
      )
      .bind(gameId, poster.id).all()).results ?? [];
    if (others.length) {
      const notify = await import('./notify.js');
      const roomName = (await env.DB
        .prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first())?.name ?? gameId;
      const p = pairPrice(res.offer, res.request);
      await Promise.allSettled(others.map(o => notify.sendDm(env, {
        userId: o.user_id, gameId, category: 'market', dedupeKey: `market-post:${id}:${o.user_id}`,
        embed: {
          title: `📣 ${poster.name} posted to the market`,
          description: [
            `**Gives:** ${words(res.offer)}`,
            `**Wants:** ${words(res.request)}`,
            p ? `_${p.price >= 1 ? p.price.toFixed(1) : p.price.toFixed(2)} ${WORD[p.quote]} per ${WORD[p.base]}_` : null,
            recurring ? '_A standing route: these are per-run amounts._' : null,
            divisible ? '_Sold in parts — the button takes all of it; open the game to take less._' : null,
            note ? `\n_"${note}"_` : null,
          ].filter(Boolean).join('\n'),
          color: 0xffb84d,
          footer: { text: `Orbital · ${roomName} · T+${tick} · first to take it strikes the deal` },
        },
        components: [{
          type: 1,
          components: [{ type: 2, style: 3, label: 'Take it', custom_id: `orb:m:${gameId}:${id}` }],
        }],
      })));
    }
  } catch (e) {
    console.error('market post DMs failed', e, { postId: id });
  }

  const row = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first();
  return json({ post: postRowToJson(row, poster.id, tick, null) }, { status: 201 });
}

// ---------- POST /api/games/:gameId/market/:postId/take ----------

/** Put `shipId` on the leg `faction` owes for this deal. Best effort by
 *  design: the DEAL stands whether or not the hull can be assigned, and
 *  a leg left unassigned is exactly the state the Trades panel already
 *  knows how to show. Returns { ok } or { ok:false, message }. */
async function autoAssignLeg(env, gameId, tradeId, faction, shipId) {
  try {
    const leg = await env.DB
      .prepare(
        `SELECT id, recipient_faction_id FROM trade_deliveries
          WHERE trade_id = ? AND game_id = ? AND sender_faction_id = ? AND status = 'unassigned' LIMIT 1`,
      )
      .bind(tradeId, gameId, faction.id).first();
    if (!leg) return { ok: false, message: 'no shipment to assign' };
    const dests = (await env.DB
      .prepare(
        `SELECT DISTINCT s.body_id FROM game_settlements s
           JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
          WHERE s.game_id = ? AND s.owner_faction_id = ?
            AND b.terraformed_at_tick IS NOT NULL AND s.destroyed_at_tick IS NULL
            AND b.destroyed_at_tick IS NULL`,
      )
      .bind(gameId, leg.recipient_faction_id).all()).results ?? [];
    if (!dests.length) return { ok: false, message: 'the other side has no terraformed world to deliver to yet' };
    const cap = await env.DB
      .prepare('SELECT capital_body_id FROM game_factions WHERE id = ?')
      .bind(leg.recipient_faction_id).first();
    const dest = dests.find(d => d.body_id === cap?.capital_body_id)?.body_id ?? dests[0].body_id;
    const res = await handleAssignDelivery(
      { json: async () => ({ ship_id: shipId, dest_body_id: dest }) }, env,
      { session: { user_id: faction.user_id }, params: { gameId, tradeId, deliveryId: leg.id } },
    );
    if (res.status >= 400) {
      let msg = 'that freighter could not be assigned';
      try { msg = (await res.json())?.error?.message ?? msg; } catch { /* keep default */ }
      return { ok: false, message: msg };
    }
    return { ok: true };
  } catch (e) {
    console.error('market: auto-assign failed', e, { tradeId });
    return { ok: false, message: 'that freighter could not be assigned' };
  }
}

export async function handleTake(req, env, { session, params }) {
  const gameId = params.gameId;
  const postId = params.postId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!POST_ID_RE.test(postId)) return err(400, 'bad_request', 'invalid post id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');
  const taker = await callerFaction(env, gameId, session.user_id);
  if (!taker) return err(403, 'not_a_faction', 'you do not own a faction in this game');
  const tick = game.current_tick ?? 0;
  const body = (await readJson(req)) ?? {};

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
  const poster = await env.DB
    .prepare('SELECT id, name, user_id FROM game_factions WHERE game_id = ? AND id = ?')
    .bind(gameId, post.poster_faction_id).first();
  if (!poster) return err(409, 'poster_missing', 'the poster is gone');

  // How much. A one-lot post is all or nothing; a divisible one sells
  // any whole number of units up to what is left.
  const total = totalUnits(post);
  const divisible = Number(post.divisible ?? 0) === 1;
  const left = total - Number(post.filled_units ?? 0);
  if (left <= 0) return err(409, 'not_open', 'someone else already took that offer');
  let units = left;
  if (divisible && body.units != null) {
    units = Number(body.units);
    if (!Number.isInteger(units) || units < 1) return err(400, 'bad_request', 'units must be a whole number of at least 1');
    if (units > left) return err(409, 'not_enough_left', `only ${left} left on that post`);
  }
  const terms = divisible
    ? priceForUnits(post, units)
    : { offer: bundleOf(post, 'offer'), request: bundleOf(post, 'request') };

  // RESERVE FIRST. Two players hitting TAKE in the same second must not
  // both buy the same goods; the guarded UPDATE lets through only as
  // many units as are really left.
  const nowMs = Date.now();
  const claim = await env.DB
    .prepare(
      `UPDATE market_posts SET filled_units = filled_units + ?, taking_at_ms = ?
        WHERE id = ? AND status = 'open' AND filled_units + ? <= ?`,
    )
    .bind(units, nowMs, postId, units, total).run();
  if (!claim.meta?.changes) {
    return err(409, 'not_open', divisible
      ? 'someone else just bought into that post — check what is left'
      : 'someone else just took that offer');
  }
  const release = async () => {
    await env.DB
      .prepare(`UPDATE market_posts SET filled_units = MAX(0, filled_units - ?) WHERE id = ?`)
      .bind(units, postId).run();
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
        terms.offer.metal, terms.offer.gold, terms.offer.science,
        terms.request.metal, terms.request.gold, terms.request.science,
        post.note, Number(post.recurring ?? 0),
        // Only a standing deal reads the pinned hull at accept. A
        // one-time post's hull is assigned to its leg below instead.
        Number(post.recurring ?? 0) === 1 ? (post.offered_ship_id ?? null) : null,
        postId, tick, nowMs,
      )
      .run();

    const accepted = await handleAccept(req, env, {
      session, params: { gameId, tradeId },
    });
    if (accepted.status >= 400) {
      // The deal did not strike. Take the stillborn offer off both
      // players' tables and put the units back on the board.
      await env.DB
        .prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at_ms = ? WHERE id = ? AND status = 'open'`)
        .bind(Date.now(), tradeId).run();
      await release();
      return accepted;
    }

    await insertFill(env, post, taker.id, units, terms.offer, terms.request, tradeId, tick, Date.now());
    await env.DB
      .prepare(
        `UPDATE market_posts
            SET status = CASE WHEN filled_units >= ? THEN 'filled' ELSE status END,
                taken_by_faction_id = ?, taken_at_tick = ?, taken_at_ms = ?, trade_offer_id = ?
          WHERE id = ?`,
      )
      .bind(total, taker.id, tick, Date.now(), tradeId, postId).run();

    // FREIGHTERS, WHILE EVERYONE IS STILL HERE. A one-time deal ships by
    // freighter and used to sit until both players went to PRIVATE and
    // named a hull — forgetting was the usual way a deal stalled. The
    // taker may name theirs with the take; the poster may have pinned
    // theirs to the post. Either failing leaves the leg unassigned, which
    // the Trades panel already flags.
    const assigned = { mine: null, poster: null };
    if (Number(post.recurring ?? 0) !== 1) {
      if (body.ship_id) assigned.mine = await autoAssignLeg(env, gameId, tradeId, taker, String(body.ship_id));
      if (post.offered_ship_id) assigned.poster = await autoAssignLeg(env, gameId, tradeId, poster, post.offered_ship_id);
    }

    notifyRoom(env, gameId, {
      kind: 'market', event: 'filled', post_id: postId, trade_id: tradeId,
      poster_faction_id: post.poster_faction_id, poster_faction_name: poster.name,
      taker_faction_id: taker.id, taker_faction_name: taker.name,
    });

    const offerRow = await env.DB
      .prepare('SELECT * FROM trade_offers WHERE id = ?').bind(tradeId).first();
    const postRow = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(postId).first();
    return json({
      post: postRowToJson(postRow, taker.id, tick, null),
      trade: tradeRowToJson(offerRow),
      terms,
      assigned,
    });
  } catch (e) {
    console.error('market take failed', e, { postId, tradeId });
    try {
      // If the accept landed before the throw, the deal stands;
      // healStaleClaims writes the missing tape row later. Otherwise the
      // units go back on the board.
      const t = await env.DB
        .prepare('SELECT status FROM trade_offers WHERE id = ?').bind(tradeId).first();
      if (t?.status !== 'accepted') {
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

async function ownPost(env, gameId, postId, session) {
  if (!GAME_ID_RE.test(gameId)) return { error: err(400, 'bad_request', 'invalid game id') };
  if (!POST_ID_RE.test(postId)) return { error: err(400, 'bad_request', 'invalid post id') };
  const caller = await callerFaction(env, gameId, session.user_id);
  if (!caller) return { error: err(403, 'not_a_faction', 'you do not own a faction in this game') };
  const post = await env.DB
    .prepare('SELECT * FROM market_posts WHERE id = ? AND game_id = ?')
    .bind(postId, gameId).first();
  if (!post) return { error: err(404, 'not_found', 'that post is not on the market') };
  if (post.poster_faction_id !== caller.id) return { error: err(403, 'not_poster', 'only the poster can do that') };
  return { caller, post };
}

async function handleWithdraw(_req, env, { session, params }) {
  const { gameId, postId } = params;
  const own = await ownPost(env, gameId, postId, session);
  if (own.error) return own.error;

  const done = await env.DB
    .prepare(`UPDATE market_posts SET status = 'withdrawn' WHERE id = ? AND status = 'open'`)
    .bind(postId).run();
  if (!done.meta?.changes) {
    return err(409, 'not_open', own.post.status === 'withdrawn'
      ? 'already withdrawn' : 'too late — that post has been taken');
  }
  notifyRoom(env, gameId, { kind: 'market', event: 'withdrawn', post_id: postId, poster_faction_id: own.caller.id });
  return json({ ok: true });
}

// ---------- POST /api/games/:gameId/market/:postId/renew ----------

async function handleRenew(_req, env, { session, params }) {
  const { gameId, postId } = params;
  const own = await ownPost(env, gameId, postId, session);
  if (own.error) return own.error;
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'game not found');
  const tick = game.current_tick ?? 0;
  const { post, caller } = own;
  if (post.status !== 'open') return err(409, 'not_open', 'that post is no longer on the market');

  // Re-listing a lapsed post takes a slot like any other.
  const wasExpired = Number(post.expires_at_tick) <= tick;
  if (wasExpired && await openPostCount(env, gameId, caller.id, tick) >= MARKET_MAX_OPEN_POSTS) {
    return err(409, 'too_many_posts',
      `you already have ${MARKET_MAX_OPEN_POSTS} posts on the market — withdraw one first`);
  }
  const ttl = Math.max(MIN_TTL_TICKS, Number(post.ttl_ticks ?? MARKET_POST_TTL_TICKS));
  await env.DB
    .prepare(`UPDATE market_posts SET expires_at_tick = ?, lapse_notified = 0 WHERE id = ? AND status = 'open'`)
    .bind(tick + ttl, postId).run();
  if (wasExpired) {
    notifyRoom(env, gameId, { kind: 'market', event: 'posted', post_id: postId, poster_faction_id: caller.id, poster_faction_name: caller.name });
  }
  const row = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(postId).first();
  return json({ post: postRowToJson(row, caller.id, tick, null) });
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
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/market\/(?<postId>[^/]+)\/renew$/,
    auth: 'required',
    handle: handleRenew,
  },
];
