// ============================================================
// POST /api/notify/act -- the buttons on a notification.
//
// A correspondence game is played in ninety-second windows, and until
// now every alert ended the same way: open the app, find the thing,
// act. These are the four answers worth giving from the lock screen.
//
//   retreat        pull your hulls out of a battle
//   vote           yea / nay on the bill that is closing
//   reply          a line back to whoever wrote to you
//   trade_accept / trade_decline
//
// WHOSE ORDER IT IS COMES FROM THE SESSION, NEVER FROM THE PAYLOAD. The
// push payload rides to one device and is encrypted to it, but it is
// still data arriving from outside, so it names WHAT to do and never WHO
// is doing it: the signed-in user is read from the cookie, and every
// verb goes through the game's own route with that user id. A payload
// that named somebody else's ship reaches handleSetShipOrders as you,
// and is refused there for the same reason it would be in the app.
//
// The game routes are reached through wearOrders.callGame -- the same
// dispatcher the watch uses, which bumps state_version and logs the
// event, so an order given from a notification is indistinguishable
// downstream from one given in the app.
// ============================================================

import { callGame, retreatShipsFor } from './wearOrders.js';
import { castVoteCore } from './senate.js';
import { factionIdFor } from './wear.js';

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/notify\/act$/,
    auth: 'required',
    handle: (req, env, ctx) => handleNotifyAct(req, env, ctx),
  },
];

/** Ten a minute, per user: a notification button is not a fire hose. */
const RATE = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const hits = (RATE.get(userId) ?? []).filter(t => now - t < 60_000);
  hits.push(now);
  RATE.set(userId, hits);
  if (RATE.size > 500) for (const [k, v] of RATE) if (!v.some(t => now - t < 60_000)) RATE.delete(k);
  return hits.length > 10;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Apply one notification button.
 *
 * Returns a line for the follow-up notification the service worker
 * shows, so a player who taps RETREAT learns whether the ships are
 * actually running -- in the game's own words when it refuses.
 */
export async function handleNotifyAct(req, env, ctx) {
  const userId = ctx?.session?.user_id;
  if (!userId) return json({ error: { code: 'unauthorised', message: 'Sign in to act from a notification' } }, 401);
  if (rateLimited(userId)) return json({ error: { code: 'rate_limited', message: 'Too many at once' } }, 429);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const act = body?.act ?? {};
  const verb = String(act.verb ?? '');
  const gameId = String(act.game_id ?? '');
  if (!gameId) return json({ error: { code: 'bad_request', message: 'No game named' } }, 400);
  const at = (path) => `/api/games/${encodeURIComponent(gameId)}${path}`;

  const say = (r, ok) => {
    const msg = r?.body?.error?.message;
    if (r.status >= 400 || msg) return json({ ok: false, message: msg || `The game said ${r.status}` });
    return json({ ok: true, message: ok });
  };

  try {
    switch (verb) {
      case 'retreat': {
        // THE SHIPS ARE RESOLVED HERE, not taken from the payload: the
        // alert was about a battle, and by the time a thumb reaches the
        // button some of those hulls are dead and others have arrived.
        // Everything of yours still alive in that battle runs.
        const battleId = String(act.battle_id ?? '');
        if (!battleId) return json({ ok: false, message: 'No battle named' });
        const me = await factionIdFor(env, gameId, userId);
        if (!me) return json({ ok: false, message: 'You hold no faction in that game' });
        const ships = (await env.DB.prepare(
          `SELECT s.id FROM battle_participants p
             JOIN game_ships s ON s.id = p.ship_id
            WHERE p.battle_id = ?1 AND p.faction_id = ?2 AND p.died_tick IS NULL
              AND s.status = 'active' AND s.hp > 0
            LIMIT 60`,
        ).bind(battleId, me).all().catch(() => ({ results: [] }))).results ?? [];
        if (!ships.length) return json({ ok: false, message: 'Nothing of yours is left in that fight' });
        const tick = Number((await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?')
          .bind(gameId).first())?.current_tick ?? 0);
        const results = await retreatShipsFor(env, ctx, userId, gameId, me, tick, ships.map(s => String(s.id)));
        const failed = (results ?? []).find(r => r.status >= 400);
        if (failed) return json({ ok: false, message: failed.body?.error?.message || 'The game refused the retreat' });
        return json({ ok: true, message: `Retreating ${ships.length} ${ships.length === 1 ? 'ship' : 'ships'}` });
      }
      case 'vote': {
        const choice = String(act.vote ?? '');
        if (!['yea', 'nay', 'abstain'].includes(choice)) {
          return json({ ok: false, message: 'Not a vote' });
        }
        const me = await factionIdFor(env, gameId, userId);
        if (!me) return json({ ok: false, message: 'You hold no faction in that game' });
        const tick = Number((await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?')
          .bind(gameId).first())?.current_tick ?? 0);
        // castVoteCore owns every rule that makes a vote legal -- the
        // window, the weight snapshot, changing your mind -- exactly as
        // the watch and the in-game panel use it.
        const res = await castVoteCore(env, {
          gameId,
          proposalId: String(act.proposal_id ?? ''),
          factionId: me,
          currentTick: tick,
          vote: choice,
        });
        if (!res.ok) return json({ ok: false, message: res.message || 'The vote was refused' });
        return json({ ok: true, message: `Voted ${choice}` });
      }
      case 'reply': {
        const text = String(body?.text ?? '').trim().slice(0, 500);
        if (!text) return json({ ok: false, message: 'Nothing to send' });
        const r = await callGame(env, ctx, userId, 'POST', at('/messages'), {
          scope: 'dm',
          recipient_faction_ids: [String(act.faction_id ?? '')],
          body: text,
        });
        return say(r, 'Sent');
      }
      case 'trade_accept':
      case 'trade_decline': {
        const id = String(act.trade_id ?? '');
        if (!id) return json({ ok: false, message: 'No offer named' });
        const r = await callGame(env, ctx, userId, 'POST',
          at(`/trades/${encodeURIComponent(id)}/${verb === 'trade_accept' ? 'accept' : 'decline'}`), null);
        return say(r, verb === 'trade_accept' ? 'Accepted' : 'Declined');
      }
      default:
        return json({ ok: false, message: 'Unknown action' });
    }
  } catch (e) {
    console.error('notification action failed', verb, e);
    return json({ ok: false, message: 'Orbital could not reach the game' }, 500);
  }
}
