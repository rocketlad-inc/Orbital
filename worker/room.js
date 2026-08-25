import { resolveSenate, getSliderResolver, hasActiveSanction } from './senate.js';
import { recomputeBodyOwnership, SETTLEMENT_SPEED, parkOrbitRadius } from './factions.js';
import { planStationBlast, finalizeStationBlast } from './detonationBlast.js';
import { parsePartsJson, computeShipStats, countPart, detonatorDamage,
         shipSpeed, hitChance, flakSlowMultiplier,
         damageProfile, defenseMitigation, MITIGATION_FLOOR, refitFee,
         upkeepSplit, REPAIR_TENDER_PER_BAY } from './shipDesigns.js';
import { ensureCaptains, resolveCaptainOnDeath, parseTraits, traitMul, ensureCaptainFloor } from './captains.js';
import { orbitAngle, ORBITAL_SPEED_SCALE } from './orbitPos.js';
import { makeRouteMath, planPickup, holdCapFor } from './routeMath.js';
import {
  torchStateAt, engagement, hasLineOfSight, SHIP_RANGE, V_REF as TRANSIT_V_REF,
  isEccentric, isRamming, ramPlanOf, eccentricLocalPosition,
  shipOrbitLocalPosition, muOfRow,
  DV_BONUS_MAX, DV_BONUS_START, DV_BONUS_FULL,
} from './transitCombat.js';
// Lives in src/ because the CLIENT solves with it too and CRA refuses
// imports from outside src/. The worker's bundler has no such rule, so
// the shared physics sits where both can reach it — one copy, not two.
import { rendezvousStateAt } from '../src/physics/rendezvous.js';
import { cfg as loadGameConfig } from './gameConfig.js';
import { assetState, voidDeal } from './assetDeals.js';
import { burnProgress } from './orbitPos.js';
import { effectiveHpMaxOf } from './effectiveHp.js';
import {
  periodForRadius, MEGASTRUCTURES, MEGA_MU, bodyPositionAt, foundrySlotsAt,
  MEGA_MAX_HP, MEGA_REGEN_PER_TICK, MEGA_BREACH_HP, stationDamage,
  maySupplySite, excludedFundersOf, constructionPartners,
} from './megastructures.js';

/** Unordered faction-pair key, shared by the tick's combat passes and
 *  peacePairsAt so both spell "these two are at peace" the same way. */
const megaPairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Hull classes the 'capital' target-priority category selects. */
const CAPITAL_CLASSES = new Set(['mega_destroyer', 'mobile_foundry']);
import { SHIP_COMBAT_STATS, parkPhaseFor } from './factions.js';

/** Consecutive quiet ticks at a body before its battle is declared
 *  over. Per Lorne: six. Long enough that a fleet drifting out of
 *  range and back does not split one engagement into three, which
 *  is the whole reason a battle is a useful unit. */
// Exported: the retroactive theatre backfill has to group old battles by
// the SAME quiet window the live recorder groups them by, or a campaign
// reconstructed from history would not match one recorded as it happened.
export const BATTLE_QUIET_TICKS = 6;

/**
 * URL-safe random token for a public battle recap.
 *
 * Deliberately random rather than derived from the battle id: those
 * read `b_<tick>_<bodyId>` and are guessable off any screenshot, and a
 * shared link must expose the one battle it names and nothing else.
 * Mirrors newShareToken in analytics.js -- the two are kept separate
 * because the worker and the room load independently, and a token
 * generator is four lines.
 */
function newRecapToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The six tech tracks. Single source of truth for the science-victory
// check AND the random-tech grant, so those two can't silently disagree
// about how many tracks exist. Mirrors ALL_TECH_IDS in src/game/techs.ts
// — keep in sync.
//
// The short-lived 'energy_weapons' and 'shields' ids are gone: energy
// mounts fold back into 'weapons' and shields into 'armor' (the Defense
// track). Dropping them from this list is what makes science victory
// reachable again — with eight entries, a faction had to max two tracks
// that the research UI no longer offers, so the check could never pass.
// Levels a live game banked in the retired ids still count toward combat
// via the max() folds in src/game/techs.ts.
const TECH_TRACKS = [
  'weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors',
];

/** Share of Dyson Sphere progress destroyed when its builder is thrown
 *  off — the toll for losing the hill, paid on top of whatever the
 *  bombardment itself burned off. Keeps a re-claim from being free for
 *  the evicted incumbent. Mirrored in the world-menu copy and the
 *  Herald's collapse prose; change all three together. */
const DYSON_ABANDON_LOSS = 0.20;

/** How many pre-game lobby chat lines the room keeps and replays to a
 *  client that connects (or reconnects after a refresh). Bounded because
 *  it lives in a single DO storage value: 200 lines at the 500-char cap
 *  is comfortably inside the per-value limit, while being far more
 *  backlog than any lobby actually produces before launch. */
const CHAT_HISTORY_MAX = 200;

/** How long a standing-trade leg may fail its pickup before the whole
 *  agreement is called off. Ticks, so it scales with whatever pace the
 *  host set. Previously ZERO — the first missed pickup killed the deal
 *  outright, which turned a temporary cash-flow dip into a permanent
 *  loss of the arrangement. */
const TRADE_STARVE_GRACE_TICKS = 10;

/** Units a fitted freighter pulls out of a rock per tick.
 *
 *  Sets the DWELL, which is the whole risk of mining: a 500-unit hold
 *  at 50/tick is ten ticks parked in deep space, unable to leave, in
 *  range of anyone who has found the same rock. Raising this makes
 *  mining safer as well as faster — the two are the same dial, which is
 *  worth remembering before treating it as a pure throughput knob.
 *  Host-tunable via mining_rate_per_tick. */
const MINE_RATE_PER_TICK = 50;
// Stall clock (DESIGN-trade-v2 §6, Lorne): a route that loses its last
// freighter STALLS instead of cancelling — 30 ticks to re-crew, warning
// DM at 5 remaining, then auto-cancel. At the default hour tick that is
// 30 real hours: long enough that a daily player never loses a lane by
// accident, which is the point.
const ROUTE_STALL_TICKS = 30;
const ROUTE_STALL_WARN_AT = ROUTE_STALL_TICKS - 5;

/** Player-facing resource names. `ore`/`gold` survive as internal keys
 *  but the fiction calls them metal and credits. */
const RESOURCE_LABEL = {
  metal: 'metal', gold: 'credits', fuel: 'fuel', science: 'science',
};

// Room Durable Object. One instance per game room, keyed by room id.
// Uses the WebSocket Hibernation API so idle rooms cost nothing.
//
// State model (kept in DO storage so we survive eviction):
//   meta: { id, name, hostId, status, maxPlayers, createdAt }
//   members: Map<userId, { userId, displayName }>  -- everyone with a seat
//   settings: { tick_interval_ms }  -- host-edited pre-start config
//   gameStarted: { gameId, tick_interval_ms, started_at } | null
//
// Per-connection state lives on the WebSocket's attachment:
//   { userId, displayName }
//
// Per-connection transient flags (not persisted; reset on rejoin):
//   ready: Map<userId, boolean>  -- in-memory only; cleared on DO eviction
//
// =============================================================================
// LOBBY AGENT ADDITIONS (do not remove without coordinating with the Lobby agent):
//
//   - `ready` map + `ready` WS message type for ready-check signalling.
//     Ready state is in-memory (`this.ready`), included in every presence
//     broadcast under `ready: { <userId>: boolean }` and in /snapshot.
//
//   - New internal POST endpoints used by src/lobby.js:
//       POST /settings       — update pre-start config (name/maxPlayers/tick cfg)
//       GET  /settings       — read pre-start config blob
//       POST /kick           — disconnect a kicked user and clear their state
//       POST /game-started   — broadcast a `game_started` event to all WS clients
//
//   - /snapshot now includes `settings` and `gameStarted` fields.
// =============================================================================

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = new Map(); // userId -> boolean (transient)
    // Re-entrancy guard for the tick loop. A DO is single-threaded but
    // `await` on a D1 subrequest yields, letting another event in — and
    // three sources converge on an overdue tick: the scheduled alarm,
    // the every-minute cron poke (/tick-now), and the fire-and-forget
    // /state self-heal every polling player issues. Without this flag two
    // interleaved alarm() runs both read current_tick=N before either
    // writes it, so tick N+1 resolves twice (double yields / growth /
    // combat). Set for the duration of a tick pass; a concurrent entry
    // bails immediately.
    this.ticking = false;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init' && req.method === 'POST') {
      const body = await req.json();
      await this.state.storage.put('meta', body.meta);
      await this.state.storage.put('members', body.members ?? {});
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/snapshot') {
      return Response.json(await this.snapshot());
    }
    if (url.pathname === '/settings' && req.method === 'GET') {
      const settings = (await this.state.storage.get('settings')) ?? {};
      return Response.json(settings);
    }
    if (url.pathname === '/settings' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const meta = (await this.state.storage.get('meta')) ?? {};
      const settings = (await this.state.storage.get('settings')) ?? {};
      let metaChanged = false;
      if (typeof body.name === 'string') { meta.name = body.name; metaChanged = true; }
      if (Number.isInteger(body.maxPlayers)) { meta.maxPlayers = body.maxPlayers; metaChanged = true; }
      // total_tick_target was removed — games run indefinitely.
      if (Number.isInteger(body.tick_interval_ms)) settings.tick_interval_ms = body.tick_interval_ms;
      if (metaChanged) await this.state.storage.put('meta', meta);
      await this.state.storage.put('settings', settings);
      this.broadcast({ type: 'settings', meta, settings });
      return Response.json(settings);
    }
    if (url.pathname === '/member-add' && req.method === 'POST') {
      // Server-driven member upsert. Called from worker/index.js
      // handleJoinRoom right after the D1 room_members insert, so the
      // DO's `members` map stays in sync with the D1 source of truth
      // without waiting for the joiner to open a WebSocket. Without
      // this, a join + tab-close before /connect left D1 at +1 member
      // and the DO at +0, drifting forever (see lobby.js for details).
      const body = await req.json().catch(() => ({}));
      const userId = body?.userId;
      const displayName = body?.displayName ?? 'player';
      if (!userId) return new Response('missing userId', { status: 400 });
      const members = (await this.state.storage.get('members')) ?? {};
      if (!members[userId]) {
        members[userId] = { userId, displayName };
      } else {
        // Refresh the displayName in case the user renamed since the
        // last DO write.
        members[userId].displayName = displayName;
      }
      await this.state.storage.put('members', members);
      this.broadcast({
        type: 'presence',
        members: Object.values(members),
        connected: this.connectedUserIds(),
        ready: this.readyMap(),
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/kick' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const targetId = body?.userId;
      if (!targetId) return new Response('missing userId', { status: 400 });
      const members = (await this.state.storage.get('members')) ?? {};
      if (members[targetId]) {
        delete members[targetId];
        await this.state.storage.put('members', members);
      }
      this.ready.delete(targetId);
      // Close any open sockets for the kicked user.
      for (const ws of this.state.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att?.userId === targetId) {
          try { ws.send(JSON.stringify({ type: 'kicked' })); } catch {}
          try { ws.close(4001, 'kicked'); } catch {}
        }
      }
      this.broadcast({ type: 'presence', members: Object.values(members), connected: this.connectedUserIds(), ready: this.readyMap() });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/game-started' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      await this.state.storage.put('gameStarted', body);
      const meta = (await this.state.storage.get('meta')) ?? {};
      meta.status = 'in_progress';
      await this.state.storage.put('meta', meta);
      this.broadcast({ type: 'game_started', ...body });
      // Schedule the first tick. seedGameWorld already wrote next_tick_at
      // into the games row; mirror that here so the DO alarm fires it.
      const firstTickAt = (body.started_at ?? Date.now()) + (body.tick_interval_ms ?? 86400000);
      try { await this.state.storage.setAlarm(firstTickAt); } catch (e) {
        console.error('setAlarm failed', e);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rearm' && req.method === 'POST') {
      // Re-arm the DO alarm to the games row's current next_tick_at.
      // Called by handleChangeTickInterval after it moves next_tick_at:
      // without this the OLD alarm stays pending at the previous
      // schedule, fires early, and (pre-guard) advanced a premature tick.
      // Body: { gameId }
      const body = await req.json().catch(() => ({}));
      const gid = typeof body?.gameId === 'string' ? body.gameId : null;
      if (!gid) return new Response(null, { status: 400 });
      const row = await this.env.DB
        .prepare('SELECT next_tick_at, status, turn_based_enabled FROM games WHERE id = ?')
        .bind(gid).first();
      if (!row || row.status !== 'active' || row.turn_based_enabled === 1) {
        return new Response(null, { status: 204 });
      }
      if (row.next_tick_at != null) {
        try { await this.state.storage.setAlarm(row.next_tick_at); } catch (e) {
          console.error('rearm setAlarm failed', e);
        }
      }
      return new Response(null, { status: 204 });
    }
    // POST /dispatch-route  body: { gameId, routeId }
    //
    // Runs the trade auto-pilot for ONE route at the CURRENT tick without
    // advancing anything. Called the moment a route is created so the
    // freighter starts moving immediately instead of idling until the
    // next tick — at an hour a tick, that wait read as a broken route.
    //
    // Idempotent by construction: the pass skips any ship that already
    // has a committed/in_transit node, so a double call plans one leg.
    if (url.pathname === '/dispatch-route' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const gameId = typeof body?.gameId === 'string' ? body.gameId : null;
      const routeId = typeof body?.routeId === 'string' ? body.routeId : null;
      if (!gameId || !routeId) {
        return new Response(JSON.stringify({ error: 'gameId and routeId required' }), { status: 400 });
      }
      try {
        const g = await this.env.DB
          .prepare('SELECT current_tick FROM games WHERE id = ?')
          .bind(gameId).first();
        const tick = Number(g?.current_tick ?? 0);
        const CFG = await loadGameConfig(this.env, gameId);
        // Sanctions still apply — an embargoed faction's new route must
        // sit exactly as it would at tick time. Cache is per-call.
        const cache = new Map();
        const sanctioned = async (factionId, kind) => {
          if (!factionId) return false;
          const key = `${factionId}|${kind}`;
          if (cache.has(key)) return cache.get(key);
          const v = await hasActiveSanction(this.env, gameId, tick, factionId, kind);
          cache.set(key, v);
          return v;
        };
        await this.runTradeAutopilot(gameId, tick, CFG, sanctioned, new Map(), routeId);
        return new Response(JSON.stringify({ ok: true, tick }), { status: 200 });
      } catch (e) {
        // Never fail the player's route creation over this — the tick
        // pass will pick the route up regardless, exactly as before.
        console.error('dispatch-route failed', e, { gameId, routeId });
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
    }

    if (url.pathname === '/tick-now' && req.method === 'POST') {
      // Catch-up endpoint. Called from:
      //   - state.js handleGetState as a self-heal when /state notices
      //     next_tick_at has passed (covers missed CF DO alarms).
      //   - The worker's /force-tick admin endpoint (host-only).
      //
      // Body: { force?: boolean }
      //   force=false (default) — only fires if next_tick_at < now; this
      //     is what the self-heal uses, so calling /tick-now twice in
      //     quick succession won't double-advance.
      //   force=true — fires unconditionally (admin tool). Ticks may
      //     burst-fire if a host repeatedly clicks Force.
      const body = await req.json().catch(() => ({}));
      const force = !!body?.force;
      const hintedGameId = typeof body?.gameId === 'string' ? body.gameId : null;
      let started = await this.state.storage.get('gameStarted');

      // Self-heal: when the DO was recycled or the room predates the
      // /game-started write, the storage flag is missing but D1 still
      // has the game row. The lobby's /force-tick endpoint passes
      // { gameId } in the body so we can bootstrap storage from D1.
      if (!started?.gameId && hintedGameId) {
        const row = await this.env.DB
          .prepare(`SELECT id AS gameId, tick_interval_ms, started_at
                      FROM games WHERE id = ?`)
          .bind(hintedGameId).first();
        if (row) {
          started = {
            gameId: row.gameId,
            tick_interval_ms: row.tick_interval_ms,
            started_at: row.started_at,
          };
          await this.state.storage.put('gameStarted', started);
        }
      }
      if (!started?.gameId) {
        return new Response(JSON.stringify({ error: 'no_game_for_do' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }

      const game = await this.env.DB
        .prepare('SELECT next_tick_at, status, tick_interval_ms, turn_based_enabled FROM games WHERE id = ?')
        .bind(started.gameId).first();
      if (!game) return new Response(null, { status: 204 });
      if (game.status === 'completed' || game.status === 'abandoned') {
        return new Response(null, { status: 204 });
      }

      const now = Date.now();
      // Orphan recovery: active wall-clock game with NULL next_tick_at
      // (TBM was on at some point, or the column got cleared). Skip for
      // TBM games — those are intentionally paused.
      //
      // Behaviour split by `force`:
      //   - self-heal (force=false): set next_tick_at one interval out so
      //     the natural alarm fires it, then bail. We DON'T tick now —
      //     the player isn't asking us to, and ticking on every poll
      //     would burst-fire if the DO is orphaned for a while.
      //   - host force (force=true): set next_tick_at to `now` so the
      //     due check below treats it as ready, then fall through to
      //     alarm(). Player-report: the force-tick button read "No
      //     change" because this branch unconditionally returned 204
      //     even when force was set — silently rescheduling without
      //     ever advancing the sim.
      if (game.next_tick_at == null && game.turn_based_enabled !== 1) {
        const interval = game.tick_interval_ms ?? 60_000;
        const nextAt = force ? now : Date.now() + interval;
        await this.env.DB
          .prepare('UPDATE games SET next_tick_at = ? WHERE id = ?')
          .bind(nextAt, started.gameId).run();
        if (!force) {
          try { await this.state.storage.setAlarm(nextAt); } catch {}
          return new Response(null, { status: 204 });
        }
        // Force: keep the local copy in sync so the due check below
        // sees the freshly-armed schedule, then fall through to alarm().
        game.next_tick_at = nextAt;
      }
      // Force must also defeat alarm()'s early/stale-fire guard: with a
      // future next_tick_at the guard sees "not due yet" and bails, so
      // the host's Force button silently no-opped (advanced:false) for
      // any normally-scheduled game. Pull the schedule to `now` first so
      // alarm() advances exactly one tick and re-arms at now + interval.
      if (force && game.next_tick_at != null && game.next_tick_at > now) {
        await this.env.DB
          .prepare('UPDATE games SET next_tick_at = ? WHERE id = ?')
          .bind(now, started.gameId).run();
        game.next_tick_at = now;
      }
      const due = game.next_tick_at != null && game.next_tick_at <= now;
      if (!force && !due) {
        // Nothing to do — and if the alarm got lost since the last call
        // (next_tick_at in the future, but DO didn't wake), re-arm it
        // here so future /tick-now or natural alarm fires.
        if (game.next_tick_at) {
          try { await this.state.storage.setAlarm(game.next_tick_at); } catch {}
        }
        return new Response(null, { status: 204 });
      }

      try {
        await this.alarm(force);
      } catch (e) {
        console.error('manual tick failed', e);
        return new Response(JSON.stringify({ error: String(e?.message || e) }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Re-arm the alarm after firing so the next tick fires on schedule.
      const after = await this.env.DB
        .prepare('SELECT next_tick_at, status FROM games WHERE id = ?')
        .bind(started.gameId).first();
      if (after && after.status === 'active' && after.next_tick_at) {
        try { await this.state.storage.setAlarm(after.next_tick_at); }
        catch (e) { console.error('rearm setAlarm failed', e); }
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/__internal/advance' && req.method === 'POST') {
      // Turn-Based Mode batch-advance entry point. Called from
      // worker/actions.js handleTurnCommit when every faction has
      // submitted their COMMIT TURN for the current turn. Walks
      // tick-by-tick so interval-gated logic (combat cadence, settlement
      // growth) fires at the right cadence. After the batch, increments
      // games.current_turn_number and clears the now-stale commit ledger
      // so the next turn starts with a clean slate.
      const gameIdParam = url.searchParams.get('gameId');
      const ticksParam = Math.max(1, Math.min(500, Number(url.searchParams.get('ticks') ?? 20)));
      if (!gameIdParam) {
        return new Response(JSON.stringify({ error: 'missing gameId' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      const g = await this.env.DB
        .prepare('SELECT current_tick, current_turn_number, status FROM games WHERE id = ?')
        .bind(gameIdParam).first();
      if (!g) return new Response(JSON.stringify({ error: 'game_not_found' }), { status: 404 });
      if (g.status !== 'active') {
        return new Response(JSON.stringify({ error: 'not_active', status: g.status }), { status: 409 });
      }
      const startTick = Number(g.current_tick ?? 0);
      const endTick = startTick + ticksParam;
      const turnN = Number(g.current_turn_number ?? 0);
      const now = Date.now();
      // Share the alarm's re-entrancy guard: a leftover scheduled alarm
      // (or a concurrent turn-advance) must not resolve ticks while this
      // batch is mid-flight, or the same tick double-applies.
      if (this.ticking) {
        return new Response(JSON.stringify({ error: 'tick_in_progress' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        });
      }
      this.ticking = true;
      try {
        for (let t = startTick + 1; t <= endTick; t++) {
          try { await this.resolveTick(gameIdParam, t); }
          catch (e) { console.error('resolveTick in batch failed', t, e); }
        }
      } finally {
        this.ticking = false;
      }
      // Bookkeeping: bump current_tick + turn number, wipe stale commits,
      // mark a single game_ticks row so /state shows the new tick.
      await this.env.DB.batch([
        this.env.DB
          .prepare('UPDATE games SET current_tick = ?, current_turn_number = ? WHERE id = ?')
          .bind(endTick, turnN + 1, gameIdParam),
        this.env.DB
          .prepare("INSERT OR REPLACE INTO game_ticks (game_id, tick_number, status, scheduled_at, started_at, completed_at) VALUES (?, ?, 'completed', ?, ?, ?)")
          .bind(gameIdParam, endTick, now, now, now),
        this.env.DB
          .prepare('DELETE FROM game_turn_commits WHERE game_id = ? AND turn_number <= ?')
          .bind(gameIdParam, turnN),
      ]);
      this.broadcast({
        type: 'turn_advanced',
        from_tick: startTick,
        to_tick: endTick,
        turn_number: turnN + 1,
      });
      return Response.json({
        ok: true,
        from_tick: startTick,
        to_tick: endTick,
        turn_number: turnN + 1,
      });
    }
    if (url.pathname === '/notify' && req.method === 'POST') {
      // Best-effort fan-out: feature modules (trades, messages, etc.)
      // post a JSON payload here and we broadcast it to every connected
      // WS client. Used so a player accepting/declining a trade triggers
      // an immediate refresh on the proposer's screen without waiting
      // for the next /list poll.
      let payload;
      try { payload = await req.json(); } catch { payload = null; }
      if (payload) this.broadcast(payload);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/destroy' && req.method === 'POST') {
      // Host deleted the room. Tell every connected client the room is
      // gone, close their sockets, cancel pending alarms, and wipe DO
      // storage so a stale DO doesn't keep ticking a deleted game.
      this.broadcast({ type: 'room_deleted' });
      for (const ws of this.state.getWebSockets()) {
        try { ws.close(4002, 'room_deleted'); } catch {}
      }
      try { await this.state.storage.deleteAlarm(); } catch {}
      try { await this.state.storage.deleteAll(); } catch {}
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/connect') {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const userId = url.searchParams.get('uid');
      const displayName = url.searchParams.get('name') ?? 'player';
      if (!userId) return new Response('missing uid', { status: 400 });

      const meta = await this.state.storage.get('meta');
      if (!meta) return new Response('room not initialized', { status: 404 });

      const members = (await this.state.storage.get('members')) ?? {};
      if (!members[userId]) {
        if (Object.keys(members).length >= meta.maxPlayers) {
          return new Response('room full', { status: 403 });
        }
        members[userId] = { userId, displayName };
        await this.state.storage.put('members', members);
      } else {
        members[userId].displayName = displayName;
        await this.state.storage.put('members', members);
      }
      // Reset ready on (re)connect — ready is a "right now" signal.
      this.ready.set(userId, false);

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.serializeAttachment({ userId, displayName });
      this.state.acceptWebSocket(server);

      // Replay the lobby backlog to THIS socket only (not a broadcast —
      // everyone else already has these lines). This is what makes a
      // refresh non-destructive and lets someone who joins late read what
      // was said before they arrived.
      const chatLog = (await this.state.storage.get('chatLog')) ?? [];
      if (chatLog.length) {
        try {
          server.send(JSON.stringify({ type: 'chat_history', messages: chatLog }));
        } catch { /* client vanished mid-handshake; presence below still runs */ }
      }

      this.broadcast({ type: 'presence', members: Object.values(members), connected: this.connectedUserIds(), ready: this.readyMap() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment();
    if (!att) return;

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        return;
      case 'chat': {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        const text = msg.text.slice(0, 500);
        const line = {
          type: 'chat',
          from: { userId: att.userId, displayName: att.displayName },
          text,
          at: Date.now(),
        };
        // PERSIST BEFORE BROADCASTING. This used to be broadcast-only,
        // which made lobby chat a pure "who happens to be listening right
        // now" channel: refresh and your own log was gone, and anyone who
        // joined the lobby thirty seconds later saw an empty box. Players
        // read that as messages not sending at all — they'd write
        // something, nobody would answer, because nobody who arrived
        // afterwards could ever see it.
        //
        // Written first so a line can never be shown to a live client and
        // then be missing from the history a reconnect replays.
        const log = (await this.state.storage.get('chatLog')) ?? [];
        log.push(line);
        // Ring-buffer: a lobby that sits open for hours must not grow a
        // storage value without bound.
        await this.state.storage.put('chatLog', log.slice(-CHAT_HISTORY_MAX));
        this.broadcast(line);
        return;
      }
      case 'ready': {
        // Lobby agent: per-user transient ready flag. Rebroadcast presence.
        const r = !!msg.ready;
        this.ready.set(att.userId, r);
        const members = (await this.state.storage.get('members')) ?? {};
        this.broadcast({
          type: 'presence',
          members: Object.values(members),
          connected: this.connectedUserIds(),
          ready: this.readyMap(),
        });
        return;
      }
      default:
        // ignore unknown messages for now
        return;
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    // Clear ready when the user disconnects — ready is "right now I'm here".
    this.ready.delete(att.userId);
    // Exclude THIS socket: it is still in getWebSockets() during its own
    // close handler, so counting it would announce the leaver as present.
    const connected = this.connectedUserIds(ws);
    this.broadcast({
      type: 'presence',
      members: await this.memberList(),
      connected,
      ready: this.readyMap(connected),
    });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async snapshot() {
    const meta = await this.state.storage.get('meta');
    const members = (await this.state.storage.get('members')) ?? {};
    const settings = (await this.state.storage.get('settings')) ?? {};
    const gameStarted = (await this.state.storage.get('gameStarted')) ?? null;
    return {
      meta,
      members: Object.values(members),
      connected: this.connectedUserIds(),
      ready: this.readyMap(),
      settings,
      gameStarted,
    };
  }

  async memberList() {
    const members = (await this.state.storage.get('members')) ?? {};
    return Object.values(members);
  }

  /**
   * User ids with at least one live socket.
   *
   * `exclude` MUST be passed from webSocketClose. A closing socket is
   * still present in getWebSockets() while its close handler runs, so
   * without this the departure broadcast lists the person who just left
   * as still connected — and since the next presence frame only goes out
   * when somebody else joins or leaves, they stay lit indefinitely.
   * Measured with scripts/presenceProbe.mjs: join moved 1 -> 2 ids,
   * disconnect stayed at 2.
   *
   * Excluding the SOCKET rather than the user id is deliberate: two tabs
   * are two sockets on one id, and closing one must not report that
   * player offline while the other is still open.
   */
  connectedUserIds(exclude = null) {
    const ids = new Set();
    for (const ws of this.state.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      const att = ws.deserializeAttachment();
      if (att?.userId) ids.add(att.userId);
    }
    return [...ids];
  }

  readyMap(connectedIds = null) {
    const connected = new Set(connectedIds ?? this.connectedUserIds());
    const out = {};
    for (const [uid, val] of this.ready) {
      if (connected.has(uid)) out[uid] = !!val;
    }
    return out;
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(text); } catch {}
    }
  }

  // ---------- Tick scheduler ----------
  // Fires on the schedule established at /game-started. Each tick:
  //   1. compute nextTick = current_tick + 1
  //   2. RESOLVE everything scheduled for ticks up to and including nextTick:
  //        - build queue completions  -> new game_ships row, queue row deleted
  //        - committed maneuver nodes -> ship parent + orbit updated, fuel
  //          deducted, node marked 'executed'
  //   3. write current_tick = nextTick, log a game_ticks row, broadcast.
  //
  // Combat resolution + body-yield harvesting are still future work.
  // Public alarm entry — guarded against re-entrancy (see this.ticking
  // in the constructor). The scheduled alarm, the cron /tick-now poke,
  // and the /state self-heal can all converge on an overdue tick; the
  // guard ensures only one tick pass runs at a time so a tick can't
  // resolve twice. All the real work lives in _runAlarm().
  //
  // `force` comes only from the host's /force-tick admin path. Cloudflare
  // invokes alarm() with no args, so scheduled fires stay force=false and
  // keep the early/stale-fire guard in _runAlarm().
  async alarm(force = false) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this._runAlarm(force);
    } finally {
      this.ticking = false;
    }
  }

  async _runAlarm(force = false) {
    let started = await this.state.storage.get('gameStarted');
    if (!started?.gameId) {
      // The DO got recycled / migrated / freshly-deployed and lost its
      // `gameStarted` flag. Without it the DO can't know its own roomId,
      // so it can't recover on its own. Try to self-heal: scan active
      // games and look for the one whose idFromName equals this DO's id.
      // If we find a match, re-hydrate storage and continue. This is the
      // overnight-stall recovery path; the cron trigger normally beats
      // us to it but this works even without external pokes.
      const myIdHex = (this.state.id?.toString?.() ?? '').toLowerCase();
      const candidates = await this.env.DB
        .prepare("SELECT id, tick_interval_ms, started_at FROM games WHERE status = 'active' LIMIT 200")
        .all();
      let match = null;
      for (const row of (candidates.results ?? [])) {
        try {
          const candId = this.env.ROOM.idFromName(row.id).toString().toLowerCase();
          if (candId === myIdHex) { match = row; break; }
        } catch {}
      }
      if (!match) {
        console.warn('alarm fired with no gameStarted storage AND no D1 match; DO is orphaned', { myIdHex });
        return;
      }
      started = {
        gameId: match.id,
        tick_interval_ms: match.tick_interval_ms,
        started_at: match.started_at,
      };
      await this.state.storage.put('gameStarted', started);
      console.log('alarm self-healed gameStarted from D1', { gameId: started.gameId });
    }
    const gameId = started.gameId;

    const game = await this.env.DB
      .prepare('SELECT status, current_tick, tick_interval_ms, turn_based_enabled, next_tick_at FROM games WHERE id = ?')
      .bind(gameId)
      .first();
    if (!game) return;
    if (game.status === 'completed' || game.status === 'abandoned') return;

    // Turn-Based Mode short-circuit: the alarm doesn't auto-advance time
    // in TBM games. The tick batch is driven from POST /turn/commit
    // (worker/actions.js handleTurnCommit) once every faction has clicked
    // their COMMIT TURN button. Reschedule far in the future so the alarm
    // doesn't repeatedly wake up and re-check; if the host disables TBM,
    // the /turn/settings endpoint can force an alarm refresh.
    if (game.turn_based_enabled === 1) {
      try { await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000); } catch {}
      return;
    }

    const now = Date.now();
    const interval = game.tick_interval_ms ?? 86_400_000;
    const startTick = game.current_tick ?? 0;
    const scheduled = game.next_tick_at ?? now;

    // Early/stale-fire guard. CF can fire an alarm that was armed under a
    // schedule that's since moved — most commonly when the host changes
    // the tick interval (handleChangeTickInterval pushes next_tick_at out
    // but the previously-armed DO alarm is still pending at the OLD time).
    // If the authoritative next tick is still in the future, do NOT
    // advance: just re-arm to next_tick_at and return.
    //
    // Without this, a stale early fire advanced a premature tick AND then
    // rescheduled to scheduled + interval — pushing the next legitimate
    // tick ~2 intervals past now. On a 1h cadence that's a 2h gap that
    // reads as "one tick then frozen." (next_tick_at NULL → scheduled =
    // now → guard is skipped, so orphan recovery still advances.)
    //
    // `force` bypasses this. The host's Force Tick button exists precisely
    // to fire a tick that ISN'T due yet, so applying the guard to it made
    // the button a silent no-op in the only case it's ever used —
    // /tick-now honoured force, then handed off to an alarm that didn't
    // know about it and re-armed instead of advancing.
    if (!force && scheduled - now > 1000) {
      try { await this.state.storage.setAlarm(scheduled); } catch (e) {
        console.error('setAlarm (early-fire re-arm) failed', e);
      }
      return;
    }

    // Catch-up loop. CF DO alarms are best-effort and the cron fall-back
    // only fires once per minute, so a hibernating DO + sporadic cron can
    // accumulate hours of missed ticks (4h wall-clock vs. 38 actual ticks
    // on a 60s cadence — what playtesters were hitting). When alarm DOES
    // fire we walk every tick that should have fired since `next_tick_at`
    // so the simulation stays on the cadence the host configured.
    //
    // The cap keeps a single alarm invocation from blowing the DO CPU
    // budget on a game that's been orphaned for days; remaining ticks
    // are picked up by the next cron poke. 50 × ~10ms/tick ≈ 500ms,
    // well under the per-invocation budget.
    const overdueMs = Math.max(0, now - scheduled);
    const catchUp = Math.min(1 + Math.floor(overdueMs / Math.max(interval, 1)), 50);
    const endTick = startTick + catchUp;

    // Games run indefinitely. Tick-countdown victory was removed; the
    // games table still carries a total_tick_target column for schema
    // compatibility (NOT NULL DEFAULT 42) but the alarm no longer reads
    // it, no endpoint serves it, and no client surface displays it.

    // ----- resolve scheduled events for [startTick+1 .. endTick] -----
    // Note: resolveTick reads the per-tick parameter, not games.current_tick,
    // so it's safe to loop here before the bulk UPDATE below. This mirrors
    // the /__internal/advance batch path used by Turn-Based Mode.
    for (let t = startTick + 1; t <= endTick; t++) {
      try {
        await this.resolveTick(gameId, t);
      } catch (e) {
        console.error('resolveTick failed', e, { gameId, t });
      }
    }

    // Schedule the next tick by stepping forward from the original
    // schedule, not "now" — this prevents drift accumulating when each
    // alarm fires slightly late. If we're so far behind that the next
    // theoretical tick is still in the past, push out one interval from
    // `now` so the alarm doesn't immediately re-fire in a hot loop.
    let nextAt = scheduled + catchUp * interval;
    if (nextAt <= now) nextAt = now + interval;

    await this.env.DB.batch([
      this.env.DB
        .prepare('UPDATE games SET current_tick = ?, next_tick_at = ? WHERE id = ?')
        .bind(endTick, nextAt, gameId),
      this.env.DB
        .prepare("INSERT OR REPLACE INTO game_ticks (game_id, tick_number, status, scheduled_at, started_at, completed_at) VALUES (?, ?, 'completed', ?, ?, ?)")
        .bind(gameId, endTick, now, now, now),
    ]);

    try { await this.state.storage.setAlarm(nextAt); } catch (e) {
      console.error('setAlarm (reschedule) failed', e);
    }

    this.broadcast({ type: 'tick', tick: endTick, next_tick_at: nextAt });
  }

  // ==================================================================
  // Trade-route + trade-delivery auto-pilot (tick pass 2c + 2d).
  //
  // Extracted from resolveTick so route CREATION can dispatch a brand
  // new route immediately instead of leaving the freighter parked until
  // the next tick. At one real hour per tick that wait read as "the
  // route is broken" — the ship just sat there, and if it happened to be
  // sitting at the destination it looked doubly wrong.
  //
  // The same code runs both ways on purpose. The alternative was
  // duplicating the load/deliver decisions in the create handler, and
  // two copies of that would drift.
  //
  // onlyRouteId  null = the whole pass (what the tick calls). A route
  //              id = dispatch just that route and skip 2d.
  // ==================================================================
  // scienceIncomeByFaction: the tick's science-income ledger. Delivered
  // science counts as INCOME, not just bank — the research drain clamps
  // spend to income, so without this a trade-fed faction banks science
  // forever and never advances a tech. A single-route dispatch passes a
  // throwaway Map: no tick is being resolved, so there is no drain to feed.
  // ==================================================================
  // TRADE V2 — the stop walker (DESIGN-trade-v2 §3/§4).
  //
  // A route is an ordered stop list plus a crew. Each CARRIER walks the
  // list with its own cursor and its own hold; each GUARD paces one
  // named carrier and holds defensive stance wherever it lands. A
  // two-stop backfilled route must reproduce the old outbound/returning
  // ping-pong byte for byte — that equivalence is the cutover's
  // acceptance test, which is why pickup math lives in routeMath.js
  // (shared with the composer's projection) instead of being re-derived
  // here.
  // ==================================================================
  async walkRouteStops({ gameId, tick, r, stops, crew, flyingShips, planLegFor, scienceIncomeByFaction }) {
    const DB = this.env.DB;
    // Self-heal a route the OLD worker created in the deploy window
    // (migration applied, code not yet swapped): synthesize the two-stop
    // itinerary and crew row it would have been backfilled with.
    if (!stops || stops.length < 2) {
      stops = [
        { route_id: r.id, sequence: 0, body_id: r.origin_body_id, action: 'pickup',  take_metal: 1, take_gold: 1, take_science: 1 },
        { route_id: r.id, sequence: 1, body_id: r.dest_body_id,   action: 'dropoff', take_metal: 1, take_gold: 1, take_science: 1 },
      ];
      for (const s of stops) {
        await DB.prepare(
          `INSERT OR IGNORE INTO game_trade_route_stops
             (id, game_id, route_id, sequence, body_id, action)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(`${r.id}:s${s.sequence}`, gameId, r.id, s.sequence, s.body_id, s.action).run();
      }
    }
    // SELF-HEAL, but never against the player's wishes. An empty crew
    // means one of two very different things: a legacy route that
    // predates the crew table (rebuild it from ship_id), or a lane the
    // player just took the last freighter off (leave it alone — it is
    // stalled on purpose, and re-crewing it would silently undo the
    // removal on the next tick). The stall clock is what tells them
    // apart, and getting this backwards is what made a removed ship
    // reappear.
    if ((!crew || crew.length === 0) && r.stalled_since_tick == null) {
      await DB.prepare(
        `INSERT OR IGNORE INTO game_trade_route_ships
           (id, game_id, route_id, ship_id, role, next_stop_seq,
            cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
         VALUES (?, ?, ?, ?, 'carrier', ?, ?, ?, ?, ?, ?)`,
      ).bind(`${r.id}:c0`, gameId, r.id, r.ship_id,
             r.status === 'outbound' ? 1 : 0,
             r.cargo_fuel ?? 0, r.cargo_metal ?? 0, r.cargo_gold ?? 0, r.cargo_science ?? 0,
             tick).run();
      crew = [{
        crew_id: `${r.id}:c0`, route_id: r.id, ship_id: r.ship_id, role: 'carrier',
        follow_ship_id: null, next_stop_seq: r.status === 'outbound' ? 1 : 0,
        cargo_fuel: r.cargo_fuel ?? 0, cargo_metal: r.cargo_metal ?? 0,
        cargo_gold: r.cargo_gold ?? 0, cargo_science: r.cargo_science ?? 0,
        ship_body: null, ship_status: 'active', ship_class: 'freighter',
        ship_owner: r.owner_faction_id, captain_traits: null,
      }];
      // The synthesized row has no joined ship columns — hydrate them.
      const sh = await DB.prepare(
        `SELECT s.parent_body_id, s.status, s.ship_class, s.owner_faction_id, c.traits_json
           FROM game_ships s LEFT JOIN game_captains c ON c.id = s.captain_id
          WHERE s.id = ?`,
      ).bind(r.ship_id).first();
      if (sh) {
        crew[0].ship_body = sh.parent_body_id; crew[0].ship_status = sh.status;
        crew[0].ship_class = sh.ship_class; crew[0].ship_owner = sh.owner_faction_id;
        crew[0].captain_traits = sh.traits_json;
      }
    }

    // Prune crew rows whose hull is gone (any role) — the primary's own
    // death is handled by the promote-or-stall branch before this runs.
    const liveCrew = [];
    for (const c of crew) {
      if (c.ship_status !== 'active') {
        await DB.prepare('DELETE FROM game_trade_route_ships WHERE id = ?').bind(c.crew_id).run();
        continue;
      }
      liveCrew.push(c);
    }
    const carriers = liveCrew.filter(c => c.role === 'carrier' && c.ship_class === 'freighter');
    if (carriers.length === 0) {
      await this.stallRouteTick(gameId, tick, r);
      return;
    }
    const carriersById = new Map(carriers.map(c => [c.ship_id, c]));
    // Legs planned THIS pass, so guards can depart in lockstep.
    const departures = new Map();   // carrier ship_id -> { from, target, arrive }

    for (const c of carriers) {
      if (flyingShips.has(c.ship_id)) continue;
      const seq = Math.min(Math.max(0, Number(c.next_stop_seq ?? 0)), stops.length - 1);
      const stop = stops[seq];
      const here = c.ship_body;
      let aboard = {
        fuel: Number(c.cargo_fuel ?? 0), metal: Number(c.cargo_metal ?? 0),
        gold: Number(c.cargo_gold ?? 0), science: Number(c.cargo_science ?? 0),
      };
      if (here !== stop.body_id) {
        // Off-course or freshly assigned: head for the current stop.
        // Same self-heal the old loop had — every idle, off-script tick
        // just plans the leg the ship should be flying.
        // A consolidated lane can carry BOTH empires' freighters, so a
        // hull burns on its own owner's engine curve, not the route
        // owner's.
        const arrive = await planLegFor(c.ship_id, c.ship_owner ?? r.owner_faction_id, here, stop.body_id);
        departures.set(c.ship_id, { from: here, target: stop.body_id, arrive });
        continue;
      }

      // AT THE STOP — act, advance, fly.

      // MINING is the only stop that takes TIME. Pickup and dropoff are
      // instantaneous: touch the body, move the cargo, advance the
      // cursor, fly. A mine stop holds the hull in place while it fills.
      //
      // AND IT NEEDS NO NEW STATE TO DO THAT. The walker re-enters every
      // tick with the ship parked here, so "still mining" is expressed
      // by simply NOT advancing the cursor and NOT planning a
      // departure — and the hold itself is the progress bar. A
      // mining_until_tick column would be a second source of truth for
      // something the cargo already says.
      //
      // The dwell is the exposure: at-body combat buckets by
      // parent_body_id with no settlement requirement, so a raider who
      // has found this rock can park on it and shoot a laden freighter
      // that cannot leave until it is full.
      if (stop.action === 'mine') {
        const rock = await DB
          .prepare(
            `SELECT mineral_kind, mineral_remaining, name FROM game_bodies
              WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
          )
          .bind(stop.body_id, gameId).first();
        // NO RIG, NO ORE. Checked in the tick and not only at route
        // creation, because a hull can be refitted out of its mining rig
        // after the route is laid — and the route would otherwise keep
        // producing metal from a freighter that no longer has the gear.
        const fitted = await DB
          .prepare(
            `SELECT parts_json FROM game_ships WHERE id = ? AND game_id = ?`,
          )
          .bind(c.ship_id, gameId).first();
        let hasRig = false;
        try {
          const parts = JSON.parse(fitted?.parts_json ?? '[]');
          hasRig = Array.isArray(parts) && parts.includes('mining');
        } catch { hasRig = false; }
        if (!hasRig) {
          // Park it. Not an error and not a stall: the player refitted
          // the rig away and the fix is to put one back, which the
          // route card can say. Advancing instead would quietly turn a
          // mining run into a sightseeing tour.
          continue;
        }

        const cap = holdCapFor(c.captain_traits);
        const carried = aboard.fuel + aboard.metal + aboard.gold + aboard.science;
        const space = Math.max(0, cap - carried);
        const left = Number(rock?.mineral_remaining ?? 0);

        // Full, dry, or not a rock at all: stop waiting and move on.
        // A worked-out rock must NOT strand the hull here — the route
        // carries on to its drop-off and the cargo still gets home.
        if (!rock || left <= 0 || space <= 0) {
          // falls through to the advance-and-fly tail below
        } else {
          const take = Math.min(MINE_RATE_PER_TICK, space, left);
          const col = rock.mineral_kind === 'gold' ? 'cargo_gold' : 'cargo_metal';
          await DB.prepare(
            `UPDATE game_trade_route_ships SET ${col} = ${col} + ? WHERE id = ?`,
          ).bind(take, c.crew_id).run();
          const after = left - take;
          await DB.prepare(
            `UPDATE game_bodies
                SET mineral_remaining = ?, exhausted_at_tick = ?
              WHERE id = ? AND game_id = ?`,
          ).bind(after, after <= 0 ? tick : null, stop.body_id, gameId).run();

          if (after <= 0) {
            // Exhaustion is a MOMENT, not a silent vanish: the players
            // who knew about this rock are told it is finished, and any
            // route still pointed at it will read the empty rock next
            // tick and carry on to its drop-off rather than stalling.
            try {
              await DB.prepare(
                `INSERT OR IGNORE INTO chronicle_entries
                   (id, game_id, tick_number, kind, actor_faction_id, body_id,
                    payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'meteoroid_exhausted', ?, ?, ?, 'public', ?)`,
              ).bind(
                `c_mtrx_${String(stop.body_id).slice(-10)}_${tick}`, gameId, tick,
                c.ship_owner ?? r.owner_faction_id, stop.body_id,
                JSON.stringify({ name: rock.name, kind: rock.mineral_kind }),
                Date.now(),
              ).run();
            } catch (e) { console.error('meteoroid exhaustion chronicle failed', e); }
          }
          // STAY. No cursor advance, no departure — the hull keeps
          // working the rock next tick.
          continue;
        }
      }

      if (stop.action === 'pickup') {
        const stocks = (await DB
          .prepare(
            `SELECT id, stockpile_fuel, stockpile_metal, stockpile_gold, stockpile_science
               FROM game_settlements
              WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
                AND destroyed_at_tick IS NULL`,
          )
          .bind(gameId, stop.body_id, r.owner_faction_id)
          .all()).results ?? [];
        const plan = planPickup(stocks, holdCapFor(c.captain_traits), aboard, {
          metal: stop.take_metal, gold: stop.take_gold, science: stop.take_science,
        });
        for (const take of plan.takes) {
          await DB.prepare(
            `UPDATE game_settlements
                SET stockpile_fuel    = stockpile_fuel    - ?,
                    stockpile_metal   = stockpile_metal   - ?,
                    stockpile_gold    = stockpile_gold    - ?,
                    stockpile_science = stockpile_science - ?
              WHERE id = ?`,
          ).bind(take.f, take.m, take.g, take.sc, take.settlementId).run();
        }
        aboard = plan.aboardAfter;
      } else if (stop.action === 'dropoff') {
        // EXPLICIT, not "anything that is not a pickup". This was an
        // `else` while there were exactly two actions, and adding a
        // third made it wrong in a way that looked like theft: a mine
        // stop whose rock had run dry fell through to here and banked
        // its cargo AT THE ROCK, thousands of units from the drop-off.
        // Caught by sim/meteoroids.mjs, which asserted the hull still
        // held what it dug.
        //
        // A CONSTRUCTION SITE TAKES THE FREIGHT ITSELF. Every other
        // dropoff banks into the faction pool, which is the one thing a
        // site does not want — it wants the metal and credits poured
        // into its meter. Handled before the pool path, because falling
        // through would silently convert a supply run into a delivery
        // home and the site would never finish while the hauler kept
        // reporting successful trips.
        const siteHere = await DB
          .prepare(
            `SELECT m.status, m.acc_metal, m.acc_credits, m.cost_metal, m.cost_credits,
                    m.settings_json, b.owner_faction_id, b.name
               FROM game_megastructures m
               JOIN game_bodies b ON b.id = m.body_id
              WHERE m.body_id = ? AND m.game_id = ?`,
          )
          .bind(stop.body_id, gameId).first();
        // THE SITE MAY HAVE CHANGED HANDS SINCE THE ROUTE WAS LAID.
        // Creating a route to somebody else's structure is refused, and
        // so is unloading into one by hand — but this path had no check
        // at all, so a capture quietly turned a standing supply line
        // into a subsidy: your freighters kept hauling your metal into
        // the thing that had just been taken off you, run after run,
        // reporting successful trips the whole way.
        //
        // Stalled rather than cancelled. The route is still a sensible
        // itinerary the moment you take the site back, and deleting a
        // player's standing order because a fight went badly for a few
        // ticks is a worse answer than parking it.
        const unloadOk = siteHere && maySupplySite(
          r.owner_faction_id, siteHere.owner_faction_id,
          await constructionPartners(this.env, gameId, r.owner_faction_id, tick),
          excludedFundersOf(siteHere.settings_json),
        );
        if (siteHere && !unloadOk) {
          await DB.prepare(
            `UPDATE game_trade_routes SET stalled_since_tick = ?, status = 'stalled'
              WHERE id = ? AND cancelled_at_tick IS NULL AND stalled_since_tick IS NULL`,
          ).bind(tick, r.id).run();
          continue;                       // cargo stays aboard
        }
        if (siteHere && siteHere.status !== 'complete') {
          const needM = Math.max(0, Number(siteHere.cost_metal) - Number(siteHere.acc_metal));
          const needG = Math.max(0, Number(siteHere.cost_credits) - Number(siteHere.acc_credits));
          const addM = Math.min(aboard.metal, needM);
          const addG = Math.min(aboard.gold, needG);
          if (addM > 0 || addG > 0) {
            const accM = Number(siteHere.acc_metal) + addM;
            const accG = Number(siteHere.acc_credits) + addG;
            const full = accM >= Number(siteHere.cost_metal)
              && accG >= Number(siteHere.cost_credits);
            await DB.prepare(
              `UPDATE game_megastructures
                  SET acc_metal = ?, acc_credits = ?, status = ?, completed_at_tick = ?
                WHERE body_id = ?`,
            ).bind(accM, accG, full ? 'complete' : 'building',
                   full ? tick : null, stop.body_id).run();
            await DB.prepare('UPDATE game_ships SET trades_completed = trades_completed + 1 WHERE id = ?')
              .bind(c.ship_id).run();
          }
          // Anything the site would not take stays ABOARD for the next
          // stop rather than vanishing at a building site.
          aboard = {
            fuel: aboard.fuel,
            metal: aboard.metal - addM,
            gold: aboard.gold - addG,
            science: aboard.science,
          };
          // Skip the pool path entirely.
          const nextSeq = seq + 1;
          void nextSeq;
        } else {

        // DROPOFF: everything aboard goes to the owner's pool. One
        // lever, not a matrix — filters shape pickups only.
        const total = aboard.fuel + aboard.metal + aboard.gold + aboard.science;
        if (total > 0) {
          await DB.prepare(
            `UPDATE game_factions
                SET fuel = fuel + ?, metal = metal + ?, gold = gold + ?, science = science + ?
              WHERE id = ?`,
          ).bind(aboard.fuel, aboard.metal, aboard.gold, aboard.science, r.owner_faction_id).run();
          if (aboard.science > 0) {
            scienceIncomeByFaction.set(
              r.owner_faction_id,
              (scienceIncomeByFaction.get(r.owner_faction_id) ?? 0) + aboard.science,
            );
          }
          await DB.prepare('UPDATE game_ships SET trades_completed = trades_completed + 1 WHERE id = ?')
            .bind(c.ship_id).run();
        }
        aboard = { fuel: 0, metal: 0, gold: 0, science: 0 };
        }
      }

      // Advance the cursor; wrapping past the last stop is a completed
      // loop, which is where loop_mode='count' burns down and retires.
      let next = seq + 1;
      let wrapped = false;
      if (next >= stops.length) { next = 0; wrapped = true; }
      if (wrapped) {
        const loops = Number(r.loops_completed ?? 0) + 1;
        r.loops_completed = loops;
        let remaining = r.loops_remaining == null ? null : Number(r.loops_remaining) - 1;
        if (r.loop_mode === 'count' && remaining != null && remaining <= 0) {
          // RUN COMPLETE — park the fleet and retire the route. Cargo
          // still aboard (odd stop shapes) stays in the ship's own hold,
          // the same rule every other retire path follows.
          const total = aboard.fuel + aboard.metal + aboard.gold + aboard.science;
          if (total > 0) {
            await DB.prepare(
              `UPDATE game_ships
                  SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                      cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ?
                WHERE id = ?`,
            ).bind(aboard.fuel, aboard.metal, aboard.gold, aboard.science, c.ship_id).run();
          }
          await DB.prepare(
            `UPDATE game_trade_routes
                SET cancelled_at_tick = ?, loops_completed = ?, loops_remaining = 0,
                    cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
              WHERE id = ?`,
          ).bind(tick, loops, r.id).run();
          await DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(r.id).run();
          try {
            await DB.prepare(
              `INSERT OR IGNORE INTO chronicle_entries
                 (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'trade_route_done', ?, ?, ?, ?)`,
            ).bind(`c_trd_${r.id.slice(-10)}_${tick}`, gameId, tick, r.owner_faction_id,
                   JSON.stringify({ route_id: r.id, name: r.name ?? null, loops }),
                   JSON.stringify([r.owner_faction_id]), Date.now()).run();
          } catch (e) { console.error('trade_route_done chronicle failed', e); }
          return;
        }
        await DB.prepare(
          `UPDATE game_trade_routes SET loops_completed = ?${remaining != null ? ', loops_remaining = ?' : ''} WHERE id = ?`,
        ).bind(...(remaining != null ? [loops, remaining, r.id] : [loops, r.id])).run();
        if (remaining != null) r.loops_remaining = remaining;
      }

      await DB.prepare(
        `UPDATE game_trade_route_ships
            SET next_stop_seq = ?, cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?
          WHERE id = ?`,
      ).bind(next, aboard.fuel, aboard.metal, aboard.gold, aboard.science, c.crew_id).run();
      c.next_stop_seq = next;
      c.cargo_fuel = aboard.fuel; c.cargo_metal = aboard.metal;
      c.cargo_gold = aboard.gold; c.cargo_science = aboard.science;

      // MIRROR the primary carrier onto the route row: stale clients and
      // legacy readers (unload, cancel refund, analytics) keep reading
      // origin/dest/status/cargo exactly as before the cutover.
      if (c.ship_id === r.ship_id) {
        await DB.prepare(
          `UPDATE game_trade_routes
              SET status = ?, cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?
            WHERE id = ?`,
        ).bind(next === 0 ? 'returning' : 'outbound',
               aboard.fuel, aboard.metal, aboard.gold, aboard.science, r.id).run();
      }

      const arrive = await planLegFor(c.ship_id, c.ship_owner ?? r.owner_faction_id, here, stops[next].body_id);
      departures.set(c.ship_id, { from: here, target: stops[next].body_id, arrive });
    }

    // Guards are paced by ONE pass over every route after the loop
    // (paceAllGuards) — see the note there.
  }

  // ==================================================================
  // GUARDS — paced for EVERY route kind, in one pass after the loop.
  //
  // This used to live inside the stop walker, which meant only self-haul
  // logistics and consolidated lanes ever moved their escorts. A guard
  // assigned to an agreement leg, a terraform run or a Dyson supply line
  // simply sat where it was, forever, still listed as guarding: reported
  // as "the ship I've assigned to guard a route ain't moving and it's
  // still marked idle."
  //
  // Driven off the database rather than off legs planned this pass, so
  // it does not care which branch moved the carrier — or whether
  // anything moved it at all. Lockstep still holds exactly: the guard
  // copies its ward's arrival tick, and since crossing time is one
  // shared constant, matching arrivals means matching departures.
  // ==================================================================
  async paceAllGuards(gameId, tick, flyingShips, planLegFor) {
    const DB = this.env.DB;
    const guards = (await DB
      .prepare(
        `SELECT c.id AS crew_id, c.route_id, c.ship_id, c.follow_ship_id,
                sh.parent_body_id AS guard_body, sh.status AS guard_status,
                sh.owner_faction_id AS guard_owner,
                r.ship_id AS primary_ship_id
           FROM game_trade_route_ships c
           JOIN game_trade_routes r ON r.id = c.route_id
           LEFT JOIN game_ships sh ON sh.id = c.ship_id
          WHERE c.game_id = ? AND c.role = 'guard'
            AND r.cancelled_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];
    if (guards.length === 0) return;

    for (const g of guards) {
      try {
        // A dead escort is not an escort. Free the hull's slot so the
        // one-job-per-ship index never pins a corpse to a lane.
        if (g.guard_status !== 'active') {
          await DB.prepare('DELETE FROM game_trade_route_ships WHERE id = ?')
            .bind(g.crew_id).run();
          continue;
        }
        // WHO IS IT ESCORTING. The named ward if it is still a live
        // carrier here, otherwise any surviving carrier on the same
        // route, otherwise the route's own primary. Re-attaching rather
        // than idling is what keeps a lane guarded across a carrier
        // swap.
        const carriers = (await DB
          .prepare(
            `SELECT c.ship_id FROM game_trade_route_ships c
               JOIN game_ships s ON s.id = c.ship_id
              WHERE c.route_id = ? AND c.role = 'carrier'
                AND s.status = 'active'`,
          )
          .bind(g.route_id)
          .all()).results ?? [];
        let wardId = null;
        if (g.follow_ship_id && carriers.some(c => c.ship_id === g.follow_ship_id)) {
          wardId = g.follow_ship_id;
        } else if (carriers.length > 0) {
          wardId = carriers[0].ship_id;
        } else {
          // Legacy kinds (agreement legs, terraform, dyson) carry no
          // crew row for their pinned hull — the route row IS the roster.
          const primary = await DB
            .prepare("SELECT id FROM game_ships WHERE id = ? AND status = 'active'")
            .bind(g.primary_ship_id).first();
          wardId = primary?.id ?? null;
        }
        if (!wardId) continue;                   // nothing to guard: hold position
        if (wardId !== g.follow_ship_id) {
          await DB.prepare('UPDATE game_trade_route_ships SET follow_ship_id = ? WHERE id = ?')
            .bind(wardId, g.crew_id).run();
        }
        // Re-attachment is bookkeeping and happens even mid-flight —
        // only MOVEMENT waits for the guard to land. Skipping the whole
        // guard while it was in transit meant one that lost its ward en
        // route never picked up a new one.
        if (flyingShips.has(g.ship_id)) continue;

        // LOCKSTEP. If the ward has a live leg, take its destination AND
        // its arrival tick — a partner's escort on a different engine
        // curve still lands the same tick.
        const wardLeg = await DB
          .prepare(
            `SELECT target_body_id, arrival_at_tick FROM game_ship_nodes
              WHERE ship_id = ? AND status IN ('committed','in_transit')
              ORDER BY sequence DESC LIMIT 1`,
          )
          .bind(wardId).first();
        if (wardLeg?.target_body_id) {
          if (g.guard_body !== wardLeg.target_body_id) {
            await planLegFor(g.ship_id, g.guard_owner, g.guard_body,
                             wardLeg.target_body_id, wardLeg.arrival_at_tick);
          }
          continue;
        }

        // Ward is parked. Be where it is.
        const ward = await DB
          .prepare('SELECT parent_body_id FROM game_ships WHERE id = ?')
          .bind(wardId).first();
        if (ward?.parent_body_id && ward.parent_body_id !== g.guard_body) {
          await planLegFor(g.ship_id, g.guard_owner, g.guard_body, ward.parent_body_id);
        }
      } catch (e) {
        console.error('guard pacing failed', e, { crewId: g.crew_id, shipId: g.ship_id });
      }
    }
  }

  // The stall clock (§6). First tick: mark and tell both ends. Five from
  // the end: warn. At thirty: the route cancels itself — an agreement
  // route takes the whole deal with it (a deal with a permanently dead
  // leg is a zombie, not a lane), and guards HOLD POSITION, named in the
  // notice, because warships' whereabouts are the player's decision.
  async stallRouteTick(gameId, tick, r) {
    const DB = this.env.DB;
    const routeLabel = r.name
      ?? `${r.origin_body_id.split(':').pop()} → ${r.dest_body_id.split(':').pop()}`;
    const parties = [r.owner_faction_id, r.counterparty_faction_id].filter(Boolean);
    const factions = new Map(((await DB
      .prepare(`SELECT id, name, user_id FROM game_factions WHERE id IN (${parties.map(() => '?').join(',')})`)
      .bind(...parties)
      .all()).results ?? []).map(f => [f.id, f]));
    const dmBoth = async (title, description, dedupeKey) => {
      try {
        const notify = await import('./notify.js');
        for (const fid of parties) {
          const f = factions.get(fid);
          if (!f?.user_id) continue;
          await notify.sendDm(this.env, {
            userId: f.user_id, gameId, category: 'economy', dedupeKey,
            embed: { title, description, color: 0xffca28, footer: { text: `Orbital · T+${tick}` } },
          });
        }
      } catch (e) { console.error('stall DM failed', e, { routeId: r.id }); }
    };

    if (r.stalled_since_tick == null) {
      await DB.prepare(
        `UPDATE game_trade_routes SET stalled_since_tick = ?, status = 'stalled'
          WHERE id = ? AND cancelled_at_tick IS NULL`,
      ).bind(tick, r.id).run();
      try {
        await DB.prepare(
          `INSERT OR IGNORE INTO chronicle_entries
             (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'trade_route_stalled', ?, ?, ?, ?)`,
        ).bind(`c_trs_${r.id.slice(-10)}_${tick}`, gameId, tick, r.owner_faction_id,
               JSON.stringify({ route_id: r.id, name: r.name ?? null, cancels_in: ROUTE_STALL_TICKS }),
               JSON.stringify(parties), Date.now()).run();
      } catch (e) { console.error('trade_route_stalled chronicle failed', e); }
      await dmBoth(
        '⚓ Trade route stalled — no freighter',
        `**${routeLabel}** lost its last freighter. Assign a new one within `
        + `**${ROUTE_STALL_TICKS} ticks** or the route cancels itself.`,
        `stall:${r.id}`,
      );
      return;
    }

    const elapsed = tick - Number(r.stalled_since_tick);
    if (elapsed === ROUTE_STALL_WARN_AT) {
      await dmBoth(
        '⏳ Stalled route cancels soon',
        `**${routeLabel}** has been without a freighter for ${elapsed} ticks — `
        + `**${ROUTE_STALL_TICKS - elapsed} ticks** left before it cancels.`,
        `stallwarn:${r.id}`,
      );
      return;
    }
    if (elapsed < ROUTE_STALL_TICKS) return;

    // Expired. Collect guard positions BEFORE deleting crew rows so the
    // notice can say where everyone is holding.
    const guardRows = (await DB
      .prepare(
        `SELECT s.name AS ship_name, b.name AS body_name
           FROM game_trade_route_ships c
           JOIN game_ships s ON s.id = c.ship_id
           LEFT JOIN game_bodies b ON b.id = s.parent_body_id
          WHERE c.route_id = ? AND c.role = 'guard'`,
      )
      .bind(r.id)
      .all()).results ?? [];
    const guardNote = guardRows.length
      ? ' Guards hold position: ' + guardRows.map(g => `${g.ship_name} at ${g.body_name ?? 'deep space'}`).join(', ') + '.'
      : '';

    if (r.agreement_id) {
      try {
        const ta = await import('./tradeAgreements.js');
        const ag = await DB.prepare('SELECT * FROM trade_agreements WHERE id = ?')
          .bind(r.agreement_id).first();
        if (ag) {
          await ta.endAgreement(this.env, gameId, ag, 'ship_lost', tick, {
            byFactionId: r.owner_faction_id,
            detail: `The lane stalled for ${ROUTE_STALL_TICKS} ticks with no freighter assigned.`,
          });
        }
      } catch (e) { console.error('stall expiry: endAgreement failed', e, { routeId: r.id }); }
    }
    await DB.prepare(
      `UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE id = ? AND cancelled_at_tick IS NULL`,
    ).bind(tick, r.id).run();
    await DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(r.id).run();
    try {
      await DB.prepare(
        `INSERT OR IGNORE INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'trade_route_cancelled', ?, ?, ?, ?)`,
      ).bind(`c_trc_${r.id.slice(-10)}_${tick}`, gameId, tick, r.owner_faction_id,
             JSON.stringify({ route_id: r.id, name: r.name ?? null, reason: 'stalled_out', guards: guardRows }),
             JSON.stringify(parties), Date.now()).run();
    } catch (e) { console.error('trade_route_cancelled chronicle failed', e); }
    await dmBoth(
      '🚫 Trade route cancelled',
      `**${routeLabel}** went ${ROUTE_STALL_TICKS} ticks without a freighter and has been cancelled.${guardNote}`,
      `stallcancel:${r.id}`,
    );
  }

  // ==================================================================
  // TRADE V2 — the consolidated lane (§8): ONE freighter serving BOTH
  // directions of a standing agreement. Stop 0 is the owner's endpoint,
  // stop 1 the partner's. Every arrival delivers what's aboard to the
  // RECEIVING side (minus the tariff snapshot) and loads the outgoing
  // direction's contracted amount from the LOADING side's pool — the
  // empty leg is the other side's shipment, which is the whole idea.
  // ==================================================================
  async walkConsolidatedLane({ gameId, tick, r, stops, crew, flyingShips, planLegFor, scienceIncomeByFaction }) {
    const DB = this.env.DB;
    const ag = await DB.prepare('SELECT * FROM trade_agreements WHERE id = ?')
      .bind(r.agreement_id).first();
    if (!ag || ag.status !== 'active') {
      // The deal died elsewhere (war, embargo, cancel) — retire the lane.
      // endAgreement usually cancels the route itself; this is the
      // backstop for a row that slipped through.
      await DB.prepare(
        `UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE id = ? AND cancelled_at_tick IS NULL`,
      ).bind(tick, r.id).run();
      await DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(r.id).run();
      return;
    }
    if (!stops || stops.length < 2) return;   // malformed — leave for repair, never guess directions

    const ownerIsA = ag.faction_a_id === r.owner_faction_id;
    // What the OWNER ships out (loaded at stop 0) and what the PARTNER
    // ships back (loaded at stop 1), straight from the agreement's terms.
    const outbound = ownerIsA
      ? { metal: ag.a_metal, fuel: ag.a_fuel, gold: ag.a_gold, science: ag.a_science }
      : { metal: ag.b_metal, fuel: ag.b_fuel, gold: ag.b_gold, science: ag.b_science };
    const inbound = ownerIsA
      ? { metal: ag.b_metal, fuel: ag.b_fuel, gold: ag.b_gold, science: ag.b_science }
      : { metal: ag.a_metal, fuel: ag.a_fuel, gold: ag.a_gold, science: ag.a_science };

    const liveCrew = [];
    for (const c of crew ?? []) {
      if (c.ship_status !== 'active') {
        await DB.prepare('DELETE FROM game_trade_route_ships WHERE id = ?').bind(c.crew_id).run();
        continue;
      }
      liveCrew.push(c);
    }
    const carriers = liveCrew.filter(c => c.role === 'carrier' && c.ship_class === 'freighter');
    if (carriers.length === 0) { await this.stallRouteTick(gameId, tick, r); return; }
    const carriersById = new Map(carriers.map(c => [c.ship_id, c]));
    const departures = new Map();

    for (const c of carriers) {
      if (flyingShips.has(c.ship_id)) continue;
      const seq = Math.min(Math.max(0, Number(c.next_stop_seq ?? 0)), stops.length - 1);
      const stop = stops[seq];
      const here = c.ship_body;
      const aboard = {
        fuel: Number(c.cargo_fuel ?? 0), metal: Number(c.cargo_metal ?? 0),
        gold: Number(c.cargo_gold ?? 0), science: Number(c.cargo_science ?? 0),
      };
      if (here !== stop.body_id) {
        // A consolidated lane can carry BOTH empires' freighters, so a
        // hull burns on its own owner's engine curve, not the route
        // owner's.
        const arrive = await planLegFor(c.ship_id, c.ship_owner ?? r.owner_faction_id, here, stop.body_id);
        departures.set(c.ship_id, { from: here, target: stop.body_id, arrive });
        continue;
      }

      const atOwnerStop = seq === 0;
      const receiver = atOwnerStop ? r.owner_faction_id : r.counterparty_faction_id;
      const loader   = atOwnerStop ? r.owner_faction_id : r.counterparty_faction_id;
      const loadTerms = atOwnerStop ? outbound : inbound;

      // 1. DELIVER what's aboard to the receiving side, minus THAT
      // side's tariff snapshot (a_/b_tariff_pct on the agreement —
      // the recipient pays their own rate, exactly as the two-leg
      // arrangement priced it; one flat rate would re-price the deal).
      const receiverTariff = receiver === ag.faction_a_id ? ag.a_tariff_pct : ag.b_tariff_pct;
      const skim = Math.max(0, Math.min(100, Number(receiverTariff ?? 0))) / 100;
      const gross = aboard.metal + aboard.fuel + aboard.gold + aboard.science;
      if (gross > 0) {
        const net = {
          metal: Math.floor(aboard.metal * (1 - skim)),
          fuel: Math.floor(aboard.fuel * (1 - skim)),
          gold: Math.floor(aboard.gold * (1 - skim)),
          science: Math.floor(aboard.science * (1 - skim)),
        };
        await DB.prepare(
          `UPDATE game_factions
              SET metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
            WHERE id = ?`,
        ).bind(net.metal, net.fuel, net.gold, net.science, receiver).run();
        if (net.science > 0) {
          scienceIncomeByFaction.set(receiver, (scienceIncomeByFaction.get(receiver) ?? 0) + net.science);
        }
        await DB.prepare('UPDATE game_ships SET trades_completed = trades_completed + 1 WHERE id = ?')
          .bind(c.ship_id).run();
        const sender = atOwnerStop ? r.counterparty_faction_id : r.owner_faction_id;
        try {
          await DB.prepare(
            `INSERT OR IGNORE INTO chronicle_entries
               (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'trade_route_run', ?, ?, ?, ?)`,
          ).bind(
            `c_trr_${r.id.slice(-10)}_${tick}_${seq}`, gameId, tick, sender,
            JSON.stringify({
              agreement_id: r.agreement_id, route_id: r.id, consolidated: true,
              loop: Number(r.loops_completed ?? 0) + (atOwnerStop ? 1 : 0),
              sender_faction_id: sender, recipient_faction_id: receiver,
              delivered: net, tariff_pct: Number(r.tariff_pct ?? 0),
              gross: { metal: aboard.metal, fuel: aboard.fuel, gold: aboard.gold, science: aboard.science },
            }),
            JSON.stringify([r.owner_faction_id, r.counterparty_faction_id]), Date.now(),
          ).run();
        } catch (e) { console.error('consolidated run log failed', e, { routeId: r.id }); }
      }
      // A loop completes when the hull gets BACK to the owner's dock
      // carrying the partner's goods — not merely by standing there.
      // Counting the first visit (empty, before anything has shipped)
      // reported a completed round trip on tick one, which is how the
      // sim caught this: loops_completed hit 1 with both pools untouched.
      if (atOwnerStop && gross > 0) {
        r.loops_completed = Number(r.loops_completed ?? 0) + 1;
        await DB.prepare('UPDATE game_trade_routes SET loops_completed = ? WHERE id = ?')
          .bind(r.loops_completed, r.id).run();
      }

      // 2. LOAD the outgoing direction from the loading side's pool,
      // with the SAME starve-grace the two-leg arrangement had. A side
      // that cannot pay sits parked and retries; a side stuck past the
      // grace window ends the deal, with the shortfall named.
      const need = {
        metal: Number(loadTerms.metal ?? 0), fuel: Number(loadTerms.fuel ?? 0),
        gold: Number(loadTerms.gold ?? 0), science: Number(loadTerms.science ?? 0),
      };
      const pool = await DB.prepare('SELECT metal, fuel, gold, science FROM game_factions WHERE id = ?')
        .bind(loader).first();
      const shortfalls = [];
      for (const k of ['metal', 'fuel', 'gold', 'science']) {
        if (!(need[k] > 0)) continue;
        const have = Number(pool?.[k] ?? 0);
        if (!(have >= need[k])) shortfalls.push({ resource: k, have, need: need[k] });
      }
      if (!pool || shortfalls.length > 0) {
        const since = r.starved_since_tick == null ? tick : Number(r.starved_since_tick);
        // WRITE THE GAP, EVERY TICK IT PERSISTS. The clock alone told
        // the panel a lane was parked without saying what for, so a
        // player watched a healthy-looking route sit still and then
        // watched the whole agreement die naming a number they had
        // never been shown. Rewritten each tick because a partial
        // recovery narrows the shortfall.
        await DB.prepare(
          'UPDATE game_trade_routes SET starved_since_tick = ?, starve_short_json = ? WHERE id = ?',
        ).bind(since, JSON.stringify(shortfalls), r.id).run();
        r.starved_since_tick = since;
        if (tick - since < TRADE_STARVE_GRACE_TICKS) continue;
        try {
          const ta = await import('./tradeAgreements.js');
          const who = await DB.prepare('SELECT name FROM game_factions WHERE id = ?').bind(loader).first();
          const missing = shortfalls
            .map(x => `${Math.max(0, Math.ceil(x.need - x.have))} ${RESOURCE_LABEL[x.resource] ?? x.resource}`)
            .join(' + ');
          await ta.endAgreement(this.env, gameId, ag, 'starved', tick, {
            byFactionId: loader,
            detail: `${who?.name ?? 'A party'} could not cover their shipment for `
                  + `${TRADE_STARVE_GRACE_TICKS} ticks`
                  + (missing ? ` — short ${missing}` : '') + '.',
            shortfalls,
          });
        } catch (e) { console.error('consolidated starve handling failed', e, { routeId: r.id }); }
        return;
      }
      if (r.starved_since_tick != null) {
        await DB.prepare(
          'UPDATE game_trade_routes SET starved_since_tick = NULL, starve_short_json = NULL WHERE id = ?',
        ).bind(r.id).run();
        r.starved_since_tick = null;
      }
      await DB.prepare(
        `UPDATE game_factions
            SET metal = metal - ?, fuel = fuel - ?, gold = gold - ?, science = science - ?
          WHERE id = ?`,
      ).bind(need.metal, need.fuel, need.gold, need.science, loader).run();

      // 3. Advance and fly.
      const next = seq === 0 ? 1 : 0;
      await DB.prepare(
        `UPDATE game_trade_route_ships
            SET next_stop_seq = ?, cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?
          WHERE id = ?`,
      ).bind(next, need.fuel, need.metal, need.gold, need.science, c.crew_id).run();
      if (c.ship_id === r.ship_id) {
        await DB.prepare(
          `UPDATE game_trade_routes
              SET status = ?, cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?
            WHERE id = ?`,
        ).bind(next === 0 ? 'returning' : 'outbound',
               need.fuel, need.metal, need.gold, need.science, r.id).run();
      }
      const arrive = await planLegFor(c.ship_id, c.ship_owner ?? r.owner_faction_id, here, stops[next].body_id);
      departures.set(c.ship_id, { from: here, target: stops[next].body_id, arrive });
    }

    // Guards are paced by ONE pass over every route after the loop
    // (paceAllGuards) — see the note there.
  }

  async runTradeAutopilot(gameId, tick, CFG, sanctioned, scienceIncomeByFaction, onlyRouteId = null) {
    try {
      const routes = (await this.env.DB
        .prepare(
          // The agreement columns MUST be selected here: the standing-
          // route branches gate on r.counterparty_faction_id, and an
          // unselected column reads as undefined — which is falsy, which
          // silently turns every agreement leg back into a self-haul
          // route. sim/tradeRoutes.mjs caught exactly that on its first
          // run (loops=0 while everything else "worked").
          `SELECT id, owner_faction_id, ship_id, origin_body_id, dest_body_id, status, kind,
                  cargo_fuel, cargo_metal, cargo_gold, cargo_science,
                  counterparty_faction_id, agreement_id, tariff_pct,
                  per_run_metal, per_run_fuel, per_run_gold, per_run_science,
                  loops_completed, starved_since_tick,
                  name, loop_mode, loops_remaining, stalled_since_tick, consolidated
             FROM game_trade_routes
            WHERE game_id = ? AND cancelled_at_tick IS NULL${onlyRouteId ? ' AND id = ?' : ''}`,
        )
        .bind(...(onlyRouteId ? [gameId, onlyRouteId] : [gameId]))
        .all()).results ?? [];

      // Movement math lives in routeMath.js now — ONE owner shared with
      // the composer's hold-projection endpoint, because a gauge that
      // forks this logic becomes a second source of truth that quietly
      // lies. Moved verbatim; per-pass caches preserved by the factory.
      const { computeLegTicks, bodyPosAt } = makeRouteMath(this.env.DB, gameId);

      // TRADE V2 (0089): the stop list and the crew, fetched once for the
      // whole pass. Only walker kinds read them, but the dead-primary
      // branch below needs crew for every kind (promote-or-stall).
      const stopsByRoute = new Map();
      for (const s of (await this.env.DB
        .prepare(
          `SELECT s.route_id, s.sequence, s.body_id, s.action,
                  s.take_metal, s.take_gold, s.take_science
             FROM game_trade_route_stops s
             JOIN game_trade_routes r ON r.id = s.route_id
            WHERE s.game_id = ? AND r.cancelled_at_tick IS NULL
            ORDER BY s.route_id, s.sequence`,
        )
        .bind(gameId)
        .all()).results ?? []) {
        if (!stopsByRoute.has(s.route_id)) stopsByRoute.set(s.route_id, []);
        stopsByRoute.get(s.route_id).push(s);
      }
      const crewByRoute = new Map();
      for (const c of (await this.env.DB
        .prepare(
          `SELECT c.id AS crew_id, c.route_id, c.ship_id, c.role, c.follow_ship_id,
                  c.next_stop_seq, c.cargo_fuel, c.cargo_metal, c.cargo_gold, c.cargo_science,
                  sh.parent_body_id AS ship_body, sh.status AS ship_status,
                  sh.ship_class, sh.owner_faction_id AS ship_owner,
                  cap.traits_json AS captain_traits
             FROM game_trade_route_ships c
             JOIN game_trade_routes r ON r.id = c.route_id
             LEFT JOIN game_ships sh ON sh.id = c.ship_id
             LEFT JOIN game_captains cap ON cap.id = sh.captain_id
            WHERE c.game_id = ? AND r.cancelled_at_tick IS NULL`,
        )
        .bind(gameId)
        .all()).results ?? []) {
        if (!crewByRoute.has(c.route_id)) crewByRoute.set(c.route_id, []);
        crewByRoute.get(c.route_id).push(c);
      }
      // Ships with a live movement node — the walker's "already flying"
      // set, updated as legs are planned so a guard never gets a second
      // node the same pass its carrier departs.
      const flyingShips = new Set(
        ((await this.env.DB
          .prepare(
            `SELECT DISTINCT ship_id AS id FROM game_ship_nodes
              WHERE game_id = ? AND status IN ('committed','in_transit')`,
          )
          .bind(gameId)
          .all()).results ?? []).map(x => x.id),
      );

      // Generalized leg planner: any ship, any faction's engine curve,
      // optional arrival override so a partner's guard (different
      // engine_g) still departs and lands in LOCKSTEP with its carrier.
      const planLegFor = (shipId, factionId, fromBodyId, targetBodyId, arrivalOverride = null) =>
        this.planLegForShip(
          gameId, tick, shipId, factionId, fromBodyId, targetBodyId,
          arrivalOverride, flyingShips,
        );

      for (const r of routes) {
       // Per-route isolation: wrap each route so one bad route (a
       // throwing sanction check, a missing body in computeLegTicks,
       // etc.) can't abort the WHOLE loop and freeze every other
       // player's freighters. The outer try/catch logs; this inner one
       // keeps the remaining routes moving.
       try {
        if (r.status === 'paused') continue;
        const ship = await this.env.DB
          .prepare(`SELECT s.id, s.owner_faction_id, s.parent_body_id, s.ship_class, s.status,
                           c.traits_json AS captain_traits
                      FROM game_ships s LEFT JOIN game_captains c ON c.id = s.captain_id
                     WHERE s.id = ?`)
          .bind(r.ship_id).first();
        // Dead or missing PRIMARY freighter → promote-or-stall (TRADE V2,
        // Lorne: "trade routes remain stalled for 30 ticks before auto
        // canceling"). This used to cancel outright — and for agreement
        // legs, end the whole deal on the spot. Now a lane with a second
        // carrier degrades instead of stopping, and a lane with none gets
        // a 30-tick window to re-crew. The deal people spent diplomacy on
        // survives the ship; only the goods die with it (piracy handles
        // the looting).
        if (!ship || ship.status !== 'active') {
          // Clean the dead hull's crew row so the one-job-per-hull index
          // can never pin its route history to a corpse.
          await this.env.DB
            .prepare('DELETE FROM game_trade_route_ships WHERE ship_id = ?')
            .bind(r.ship_id).run();
          const heirs = (crewByRoute.get(r.id) ?? []).filter(c =>
            c.role === 'carrier' && c.ship_id !== r.ship_id
            && c.ship_status === 'active' && c.ship_class === 'freighter');
          if (heirs.length > 0) {
            // PROMOTE: the next carrier becomes the primary and the
            // route row mirrors its state. The lane never stops.
            const heir = heirs[0];
            await this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET ship_id = ?, status = ?, stalled_since_tick = NULL,
                        cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?
                  WHERE id = ?`,
              )
              .bind(heir.ship_id, heir.next_stop_seq === 0 ? 'returning' : 'outbound',
                    heir.cargo_fuel, heir.cargo_metal, heir.cargo_gold, heir.cargo_science, r.id)
              .run();
          } else {
            await this.stallRouteTick(gameId, tick, r);
          }
          continue;
        }
        // Senate trade embargo: if this route's owner is under embargo
        // right now, the freighter sits idle this tick — no pickup, no
        // delivery, no new leg planned. Resumes the moment the embargo
        // expires (senate_effects.active_until_tick clears).
        if (await sanctioned(r.owner_faction_id, 'trade_embargo')) continue;
        if (ship.ship_class !== 'freighter') continue;

        // A stalled route that reaches this point has a LIVE primary
        // again (someone assigned a freighter) — clear the clock. The
        // assign endpoint clears it too; this is the belt to its braces.
        if (r.stalled_since_tick != null) {
          const hasCarrier = (crewByRoute.get(r.id) ?? []).some(c =>
            c.role === 'carrier' && c.ship_status === 'active' && c.ship_class === 'freighter');
          if (!hasCarrier) {
            // Primary is ALIVE but pulled off the roster — the clock
            // keeps counting. Clearing on mere ship-aliveness would
            // re-stamp the stall every tick and the countdown would
            // never advance.
            await this.stallRouteTick(gameId, tick, r);
            continue;
          }
          await this.env.DB
            .prepare(`UPDATE game_trade_routes
                         SET stalled_since_tick = NULL,
                             status = CASE WHEN status = 'stalled' THEN 'returning' ELSE status END
                       WHERE id = ?`)
            .bind(r.id).run();
          r.stalled_since_tick = null;
          if (r.status === 'stalled') r.status = 'returning';
        }

        // ==== TRADE V2 STOP WALKER — self-haul logistics ====
        // The generalized itinerary: N stops, each pickup or dropoff,
        // one or more carriers each with their own cursor and hold,
        // guards pacing a named carrier. Two-stop backfilled routes MUST
        // behave byte-identically to the old ping-pong — that is the
        // cutover's acceptance test (sim/tradeRoutesV2.mjs case 1).
        if (r.kind === 'logistics' && !r.counterparty_faction_id && !r.consolidated) {
          await this.walkRouteStops({
            gameId, tick, r,
            stops: stopsByRoute.get(r.id) ?? [],
            crew: crewByRoute.get(r.id) ?? [],
            flyingShips, planLegFor, scienceIncomeByFaction,
          });
          continue;
        }

        // ==== TRADE V2 CONSOLIDATED LANE — one freighter, both directions ====
        // The return leg is sold, not deleted (§8): load A's goods at A,
        // deliver to B, load B's goods at B, deliver to A. Terms come from
        // the agreement row per direction; the tariff snapshot applies to
        // both. Starvation on either side runs the same grace window the
        // two-leg arrangement had, then ends the deal.
        if (r.consolidated && r.counterparty_faction_id && r.agreement_id) {
          await this.walkConsolidatedLane({
            gameId, tick, r,
            stops: stopsByRoute.get(r.id) ?? [],
            crew: crewByRoute.get(r.id) ?? [],
            flyingShips, planLegFor, scienceIncomeByFaction,
          });
          continue;
        }

        // Skip if already mid-transit (any committed or in_transit node).
        const inFlight = await this.env.DB
          .prepare("SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status IN ('committed','in_transit') LIMIT 1")
          .bind(r.ship_id).first();
        if (inFlight) continue;

        const here = ship.parent_body_id;
        const cargoFuel    = Number(r.cargo_fuel    ?? 0);
        const cargoMetal   = Number(r.cargo_metal   ?? 0);
        const cargoGold    = Number(r.cargo_gold    ?? 0);
        const cargoScience = Number(r.cargo_science ?? 0);
        const cargoTotal = cargoFuel + cargoMetal + cargoGold + cargoScience;

        // Insert a committed node toward targetBodyId. 2a will flip it
        // to in_transit next tick; 2b will arrive it at the computed
        // arrival tick. ONE node writer for every branch (planLegFor in
        // the header) — this is just the legacy branches' shorthand.
        const planLeg = (targetBodyId) =>
          planLegFor(r.ship_id, r.owner_faction_id, here, targetBodyId);

        // TERRAFORM SUPPLY RUN: dest is a raw world being terraformed.
        // Same physical-logistics shape as the dyson branch below — load
        // metal+credits from the pool at a terraformed origin, haul,
        // deliver into the BODY's terraform meter. When the meter fills,
        // the transformation window opens; tickTerraforming flips the
        // world when it elapses. The meter living on the body is the
        // king-of-the-hill rule again: conquer mid-terraform and the
        // progress is simply yours.
        // MEGASTRUCTURE SUPPLY. Same shape as a terraform run — load at
        // a terraformed world, fly out, pour into a meter — and it banks
        // into the same two accumulators the manual deliver endpoint
        // uses, so a site cannot tell the difference between a hand
        // delivery and a standing route.
        if (r.kind === 'megastructure') {
          const site = await this.env.DB
            .prepare(
              `SELECT m.status, m.acc_metal, m.acc_credits, m.cost_metal, m.cost_credits,
                      b.name, b.destroyed_at_tick
                 FROM game_megastructures m
                 JOIN game_bodies b ON b.id = m.body_id
                WHERE m.body_id = ? AND m.game_id = ?`,
            )
            .bind(r.dest_body_id, gameId)
            .first();

          // The job can vanish under a running route three ways: the site
          // finished, it was destroyed, or it never existed. Cargo stays
          // ABOARD in every one of them — the route's purpose died, the
          // freight did not.
          const gone = !site || site.destroyed_at_tick != null || site.status === 'complete';
          if (gone) {
            if (cargoTotal > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_ships
                      SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                          cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ?
                    WHERE id = ?`,
                )
                .bind(cargoFuel, cargoMetal, cargoGold, cargoScience, r.ship_id)
                .run();
            }
            await this.env.DB
              .prepare(`UPDATE game_trade_routes SET status = 'cancelled' WHERE id = ?`)
              .bind(r.id)
              .run();
            continue;
          }

          const needM = Math.max(0, Number(site.cost_metal) - Number(site.acc_metal));
          const needG = Math.max(0, Number(site.cost_credits) - Number(site.acc_credits));

          if (here === r.origin_body_id) {
            // Load only what the site still wants, so a nearly-finished
            // structure does not drag a full hold across the system to
            // buy the last fifty metal.
            // Same hold the terraform run uses, captain traits included.
            const HOLD = holdCapFor(ship.captain_traits);
            const cm = Math.min(HOLD, needM);
            const cg = Math.min(HOLD, needG);
            if (cm <= 0 && cg <= 0) { await planLeg(r.dest_body_id); continue; }
            await this.env.DB
              .prepare(
                `UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?`,
              )
              .bind(cm, cg, r.owner_faction_id)
              .run();
            await this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET cargo_fuel = 0, cargo_metal = ?, cargo_gold = ?, cargo_science = 0,
                        status = 'outbound'
                  WHERE id = ?`,
              )
              .bind(cm, cg, r.id)
              .run();
            await planLeg(r.dest_body_id);
            continue;
          }

          if (here === r.dest_body_id) {
            const addM = Math.max(0, Math.min(cargoMetal, needM));
            const addG = Math.max(0, Math.min(cargoGold, needG));
            const accM = Number(site.acc_metal) + addM;
            const accG = Number(site.acc_credits) + addG;
            const full = accM >= Number(site.cost_metal) && accG >= Number(site.cost_credits);
            await this.env.DB.batch([
              this.env.DB
                .prepare(
                  `UPDATE game_megastructures
                      SET acc_metal = ?, acc_credits = ?, status = ?, completed_at_tick = ?
                    WHERE body_id = ?`,
                )
                .bind(accM, accG, full ? 'complete' : 'building',
                      full ? tick : null, r.dest_body_id),
              // Anything the site would not take goes home with the hull
              // rather than evaporating on the dock.
              this.env.DB
                .prepare(
                  `UPDATE game_trade_routes
                      SET cargo_fuel = 0, cargo_metal = ?, cargo_gold = ?, cargo_science = 0,
                          status = 'returning'
                    WHERE id = ?`,
                )
                .bind(cargoMetal - addM, cargoGold - addG, r.id),
            ]);
            await planLeg(r.origin_body_id);
            continue;
          }

          await planLeg(here === r.dest_body_id ? r.origin_body_id : r.dest_body_id);
          continue;
        }

        if (r.kind === 'terraform') {
          const tb = await this.env.DB
            .prepare(
              `SELECT owner_faction_id, terraformed_at_tick,
                      terraform_acc_metal, terraform_acc_gold,
                      terraform_completes_at_tick
                 FROM game_bodies
                WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
            )
            .bind(r.dest_body_id, gameId)
            .first();
          // ESCALATING COST. The Nth terraform costs base x growth^(N-1),
          // counted on worlds this faction has ALREADY finished. At the
          // default growth of 1.0 this is exactly flat and the pow() is a
          // no-op; above 1.0 it is the brake on a runaway leader, who pays
          // more for their ninth world than a rival pays for their second.
          //
          // Counted from finished worlds only, not from in-flight meters:
          // otherwise two routes opened the same tick would each inflate
          // the other's price and the pair would deadlock mid-delivery.
          // The capital is excluded by construction — it starts terraformed
          // and is counted, so the first PURCHASED world is already N=2 if
          // you seeded terraformed worlds. See the sweep for what that
          // does to the curve.
          const TF_GROWTH = Number(CFG.terraform_cost_growth ?? 1.0);
          let tfDone = 0;
          if (TF_GROWTH > 1.0) {
            const c = await this.env.DB
              .prepare(
                `SELECT COUNT(*) n FROM game_bodies
                  WHERE game_id = ? AND owner_faction_id = ?
                    AND terraformed_at_tick IS NOT NULL
                    AND destroyed_at_tick IS NULL`,
              )
              .bind(gameId, r.owner_faction_id)
              .first();
            tfDone = Math.max(0, Number(c?.n ?? 0));
          }
          const tfMul = TF_GROWTH > 1.0 ? Math.pow(TF_GROWTH, tfDone) : 1;
          const TF_COST_M = Math.round(Number(CFG.terraform_cost_metal ?? 124) * tfMul);
          const TF_COST_G = Math.round(Number(CFG.terraform_cost_credits ?? 124) * tfMul);
          // Route retires when its job is gone: body destroyed, already
          // terraformed, payload delivered (window running), or the
          // world changed hands. Cargo always goes home, never vanishes.
          const jobDone = !tb
            || tb.terraformed_at_tick != null
            || tb.terraform_completes_at_tick != null
            || tb.owner_faction_id !== r.owner_faction_id;
          if (jobDone) {
            // Cargo stays ABOARD (migration 0088), not teleported to
            // the pool: the route's purpose died, the freight didn't.
            // The player unloads it manually or lays a new route, which
            // folds the hold in and delivers it there.
            if (cargoTotal > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_ships
                      SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                          cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ?
                    WHERE id = ?`,
                )
                .bind(cargoFuel, cargoMetal, cargoGold, cargoScience, r.ship_id)
                .run();
            }
            await this.env.DB
              .prepare(`UPDATE game_trade_routes SET cancelled_at_tick = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?`)
              .bind(tick, r.id)
              .run();
            continue;
          }

          const needM = Math.max(0, TF_COST_M - (tb.terraform_acc_metal ?? 0));
          const needG = Math.max(0, TF_COST_G - (tb.terraform_acc_gold ?? 0));

          if (here === r.origin_body_id && cargoTotal < 1) {
            // LOAD from the pool at the terraformed origin, capped by
            // hold, balance, and remaining need per component.
            const pool = await this.env.DB
              .prepare('SELECT metal, gold FROM game_factions WHERE id = ?')
              .bind(r.owner_faction_id)
              .first();
            const HOLD = holdCapFor(ship.captain_traits);
            const cm = Math.max(0, Math.min(HOLD, Number(pool?.metal ?? 0), needM));
            const cg = Math.max(0, Math.min(HOLD, Number(pool?.gold  ?? 0), needG));
            if (cm + cg > 0) {
              await this.env.DB
                .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
                .bind(cm, cg, r.owner_faction_id)
                .run();
            }
            await this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET cargo_fuel = 0, cargo_metal = ?, cargo_gold = ?, cargo_science = 0,
                        status = 'outbound'
                  WHERE id = ?`,
              )
              .bind(cm, cg, r.id)
              .run();
            await planLeg(r.dest_body_id);
            continue;
          }

          if (here === r.dest_body_id) {
            // DELIVER into the meter, clamped; overflow home to pool.
            const addM = Math.max(0, Math.min(cargoMetal, needM));
            const addG = Math.max(0, Math.min(cargoGold,  needG));
            const backM = cargoMetal - addM;
            const backG = cargoGold  - addG;
            const accM = (tb.terraform_acc_metal ?? 0) + addM;
            const accG = (tb.terraform_acc_gold  ?? 0) + addG;
            const full = accM >= TF_COST_M && accG >= TF_COST_G;
            const duration = Math.max(1, Number(CFG.terraform_duration_ticks ?? 24));
            const batch = [
              this.env.DB
                .prepare(
                  `UPDATE game_bodies
                      SET terraform_acc_metal = ?, terraform_acc_gold = ?,
                          terraform_completes_at_tick = COALESCE(terraform_completes_at_tick, ?)
                    WHERE id = ? AND game_id = ?`,
                )
                .bind(accM, accG, full ? tick + duration : null, r.dest_body_id, gameId),
              this.env.DB
                .prepare(
                  `UPDATE game_trade_routes
                      SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0,
                          status = 'returning'
                    WHERE id = ?`,
                )
                .bind(r.id),
            ];
            if (cargoFuel + backM + backG + cargoScience > 0) {
              batch.push(this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET fuel = fuel + ?, metal = metal + ?,
                          gold = gold + ?, science = science + ?
                    WHERE id = ?`,
                )
                .bind(cargoFuel, backM, backG, cargoScience, r.owner_faction_id));
            }
            await this.env.DB.batch(batch);
            if (full) {
              // Payload complete — the transformation window opens.
              // Public: cranes over a world are visible from orbit.
              try {
                const fac = await this.env.DB
                  .prepare('SELECT name FROM game_factions WHERE id = ?')
                  .bind(r.owner_faction_id).first();
                const bodyName = await this.env.DB
                  .prepare('SELECT name FROM game_bodies WHERE id = ?')
                  .bind(r.dest_body_id).first();
                await this.env.DB
                  .prepare(
                    `INSERT OR IGNORE INTO chronicle_entries
                      (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
                     VALUES (?, ?, ?, 'terraform_begun', ?, ?, ?, 'public', ?)`,
                  )
                  .bind(`c_tfb_${r.dest_body_id}_${tick}`, gameId, tick, r.owner_faction_id,
                        r.dest_body_id,
                        JSON.stringify({ faction_name: fac?.name ?? null, body_name: bodyName?.name ?? null, duration }),
                        Date.now())
                  .run();
              } catch (e) { console.error('terraform_begun chronicle failed', e); }
            }
            await planLeg(r.origin_body_id);
            continue;
          }

          // Loaded => the site, empty => the origin. Unconditional, same
          // stuck-state lesson as the dyson branch.
          await planLeg(cargoTotal > 0 ? r.dest_body_id : r.origin_body_id);
          continue;
        }

        // DYSON SUPPLY RUN: dest is Sol itself. These routes feed the
        // sphere, and they load from the faction POOL rather than the
        // origin stockpile — collectors put 100% of yield into the pool,
        // so their stockpiles are permanently empty and a stockpile
        // pickup would haul nothing forever. The collector is the
        // loading dock; the pool is what's on the dock.
        const isDysonRun = r.dest_body_id === `${gameId}:sol`;
        if (isDysonRun) {
          const dg = await this.env.DB
            .prepare(
              `SELECT dyson_controller_faction_id AS ctrl,
                      dyson_acc_ore, dyson_acc_credits, dyson_acc_science,
                      dyson_target_ore, dyson_target_credits, dyson_target_science
                 FROM games WHERE id = ?`,
            )
            .bind(gameId)
            .first();
          // The sphere changed hands (or fell) since this route was laid:
          // its purpose is gone. Dump any cargo home and retire the route
          // rather than delivering into a rival's wonder.
          if (dg?.ctrl !== r.owner_faction_id) {
            // Cargo stays ABOARD (migration 0088), not teleported to
            // the pool: the route's purpose died, the freight didn't.
            // The player unloads it manually or lays a new route, which
            // folds the hold in and delivers it there.
            if (cargoTotal > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_ships
                      SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                          cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ?
                    WHERE id = ?`,
                )
                .bind(cargoFuel, cargoMetal, cargoGold, cargoScience, r.ship_id)
                .run();
            }
            await this.env.DB
              .prepare(`UPDATE game_trade_routes SET cancelled_at_tick = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?`)
              .bind(tick, r.id)
              .run();
            continue;
          }

          const need = {
            m:  Math.max(0, (dg.dyson_target_ore     ?? 0) - (dg.dyson_acc_ore     ?? 0)),
            g:  Math.max(0, (dg.dyson_target_credits ?? 0) - (dg.dyson_acc_credits ?? 0)),
            sc: Math.max(0, (dg.dyson_target_science ?? 0) - (dg.dyson_acc_science ?? 0)),
          };

          if (here === r.origin_body_id && cargoTotal < 1) {
            // LOAD at the collector: draw from the pool, capped by hold,
            // pool balance, and what the sphere still needs per
            // component (another freighter may land first — delivery
            // clamps again and refunds any overflow to the pool).
            const pool = await this.env.DB
              .prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?')
              .bind(r.owner_faction_id)
              .first();
            const HOLD = holdCapFor(ship.captain_traits);
            const cm  = Math.max(0, Math.min(HOLD, Number(pool?.metal   ?? 0), need.m));
            const cg  = Math.max(0, Math.min(HOLD, Number(pool?.gold    ?? 0), need.g));
            const csc = Math.max(0, Math.min(HOLD, Number(pool?.science ?? 0), need.sc));
            if (cm + cg + csc > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET metal = metal - ?, gold = gold - ?, science = science - ?
                    WHERE id = ?`,
                )
                .bind(cm, cg, csc, r.owner_faction_id)
                .run();
            }
            // Cycle even with an empty pool so the route retries.
            await this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET cargo_fuel = 0, cargo_metal = ?, cargo_gold = ?, cargo_science = ?,
                        status = 'outbound'
                  WHERE id = ?`,
              )
              .bind(cm, cg, csc, r.id)
              .run();
            await planLeg(r.dest_body_id);
            continue;
          }

          if (here === r.dest_body_id) {
            // DELIVER into the sphere, clamped by remaining need per
            // component; anything the lattice can't take goes back to
            // the pool instead of vanishing.
            const addM  = Math.max(0, Math.min(cargoMetal,   need.m));
            const addG  = Math.max(0, Math.min(cargoGold,    need.g));
            const addSc = Math.max(0, Math.min(cargoScience, need.sc));
            const backM  = cargoMetal   - addM;
            const backG  = cargoGold    - addG;
            const backSc = cargoScience - addSc;
            const batch = [];
            if (addM + addG + addSc > 0) {
              batch.push(this.env.DB
                .prepare(
                  `UPDATE games
                      SET dyson_acc_ore     = dyson_acc_ore     + ?,
                          dyson_acc_credits = dyson_acc_credits + ?,
                          dyson_acc_science = dyson_acc_science + ?
                    WHERE id = ?`,
                )
                .bind(addM, addG, addSc, gameId));
            }
            if (cargoFuel + backM + backG + backSc > 0) {
              batch.push(this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET fuel = fuel + ?, metal = metal + ?,
                          gold = gold + ?, science = science + ?
                    WHERE id = ?`,
                )
                .bind(cargoFuel, backM, backG, backSc, r.owner_faction_id));
            }
            batch.push(this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0,
                        status = 'returning'
                  WHERE id = ?`,
              )
              .bind(r.id));
            await this.env.DB.batch(batch);
            await planLeg(r.origin_body_id);
            continue;
          }

          // Any other state: nudge toward where the cargo says to go.
          // Loaded → the sphere, empty → the collector. UNCONDITIONAL,
          // not gated on being off both endpoints — a freighter sitting
          // AT ITS ORIGIN with a full hold (player flew it home mid-run,
          // or a leg got cancelled) matched no branch here and idled
          // loaded forever: pickup wants an empty hold and the old
          // off-course check excluded the origin. Verification catch,
          // 2026-08-09.
          await planLeg(cargoTotal > 0 ? r.dest_body_id : r.origin_body_id);
          continue;
        }

        // ---- CROSS-FACTION PICKUP (standing agreement leg) ----------
        //
        // A self-haul route vacuums whatever its settlements happen to
        // have. An agreement leg ships a CONTRACTED amount, drawn from
        // the sender's pool — the same place a one-shot delivery draws
        // from, so a standing deal and a single shipment cost the sender
        // the same way.
        //
        // Cannot cover it? The whole agreement ends, both legs, right
        // now (Lorne). Not a skipped run: a partner who cannot pay this
        // cycle is a partner you should stop shipping to, and silently
        // idling would leave the other side donating cargo indefinitely.
        if (r.counterparty_faction_id && here === r.origin_body_id && cargoTotal < 1) {
          const need = {
            metal:   Number(r.per_run_metal   ?? 0),
            fuel:    Number(r.per_run_fuel    ?? 0),
            gold:    Number(r.per_run_gold    ?? 0),
            science: Number(r.per_run_science ?? 0),
          };
          const pool = await this.env.DB
            .prepare('SELECT metal, fuel, gold, science FROM game_factions WHERE id = ?')
            .bind(r.owner_faction_id).first();
          // ONLY COMPARE WHAT THIS RUN ACTUALLY NEEDS.
          //
          // The old check tested all four resources unconditionally, so a
          // leg contracted for metal alone was still judged against the
          // sender's fuel, credits and science. Any oddity in a resource
          // the run never touches — a negative balance, a NaN — read as
          // "cannot pay" and killed a fully funded deal. Whatever produced
          // the one starve on record, comparing columns the contract does
          // not mention can only ever cause false positives.
          const shortfalls = [];
          for (const k of ['metal', 'fuel', 'gold', 'science']) {
            if (!(need[k] > 0)) continue;              // not part of this run
            const have = Number(pool?.[k] ?? 0);
            if (!(have >= need[k])) shortfalls.push({ resource: k, have, need: need[k] });
          }
          const short = !pool || shortfalls.length > 0;
          if (short) {
            // GRACE PERIOD. A missed pickup is a delay, not a death
            // sentence: the leg remembers when it first went hungry and
            // keeps trying. Only a leg stuck for the full window ends the
            // agreement. One light tick mid-build used to destroy the
            // whole arrangement with no way back.
            const since = r.starved_since_tick == null ? tick : Number(r.starved_since_tick);
            // Same as the folded path: the shortfall is persisted so the
            // panel can name it while there is still time to act.
            await this.env.DB
              .prepare(
                'UPDATE game_trade_routes SET starved_since_tick = ?, starve_short_json = ? WHERE id = ?',
              )
              .bind(since, JSON.stringify(shortfalls), r.id).run();
            const stuckFor = tick - since;
            // Everything a post-mortem needs, at the moment it happens.
            // The old event recorded THAT a deal starved and not one
            // number, which is why the only occurrence on record could not
            // be explained afterwards.
            console.warn('trade route: pickup unaffordable', {
              routeId: r.id, agreementId: r.agreement_id,
              factionId: r.owner_faction_id, tick, since, stuckFor,
              need, pool: pool ? { ...pool } : null, shortfalls,
            });
            if (stuckFor < TRADE_STARVE_GRACE_TICKS) continue;   // still in grace
            try {
              const ta = await import('./tradeAgreements.js');
              const ag = await this.env.DB
                .prepare('SELECT * FROM trade_agreements WHERE id = ?')
                .bind(r.agreement_id).first();
              const who = await this.env.DB
                .prepare('SELECT name FROM game_factions WHERE id = ?')
                .bind(r.owner_faction_id).first();
              if (ag) {
                const missing = shortfalls
                  .map(x => `${Math.max(0, Math.ceil(x.need - x.have))} ${RESOURCE_LABEL[x.resource] ?? x.resource}`)
                  .join(' + ');
                await ta.endAgreement(this.env, gameId, ag, 'starved', tick, {
                  byFactionId: r.owner_faction_id,
                  // NAME THE SIDE. "a shipment could not be covered" left
                  // both parties assuming it was the other one.
                  detail: `${who?.name ?? 'A party'} could not cover their shipment for `
                        + `${TRADE_STARVE_GRACE_TICKS} ticks`
                        + (missing ? ` — short ${missing}` : '') + '.',
                  shortfalls,
                });
              }
            } catch (e) {
              console.error('trade route: starve handling failed', e, { routeId: r.id });
            }
            continue;
          }
          // Paid up: the hunger clock resets.
          if (r.starved_since_tick != null) {
            await this.env.DB
              .prepare(
                'UPDATE game_trade_routes SET starved_since_tick = NULL, starve_short_json = NULL WHERE id = ?',
              )
              .bind(r.id).run();
          }
          await this.env.DB
            .prepare(
              `UPDATE game_factions
                  SET metal = metal - ?, fuel = fuel - ?, gold = gold - ?, science = science - ?
                WHERE id = ?`,
            )
            .bind(need.metal, need.fuel, need.gold, need.science, r.owner_faction_id)
            .run();
          await this.env.DB
            .prepare(
              `UPDATE game_trade_routes
                  SET cargo_metal = ?, cargo_fuel = ?, cargo_gold = ?, cargo_science = ?,
                      status = 'outbound'
                WHERE id = ?`,
            )
            .bind(need.metal, need.fuel, need.gold, need.science, r.id)
            .run();
          await planLeg(r.dest_body_id);
          continue;
        }

        // (The generic self-haul PICKUP/DELIVERY blocks lived here until
        // TRADE V2 — every self-haul logistics route now goes through
        // walkRouteStops above, and keeping a second copy of the sweep
        // is exactly the two-walkers-drifting failure the shared
        // routeMath module exists to prevent. Agreement legs still use
        // their own branches below.)

        // ---- CROSS-FACTION DELIVERY (standing agreement leg) --------
        //
        // Credits the PARTNER, not the owner, minus the tariff that was
        // snapshotted when the deal was struck. Then turns around and
        // does it again — that repetition is the whole feature.
        if (r.counterparty_faction_id && here === r.dest_body_id) {
          const skim = Math.max(0, Math.min(100, Number(r.tariff_pct ?? 0))) / 100;
          const net = {
            metal:   Math.floor(cargoMetal   * (1 - skim)),
            fuel:    Math.floor(cargoFuel    * (1 - skim)),
            gold:    Math.floor(cargoGold    * (1 - skim)),
            science: Math.floor(cargoScience * (1 - skim)),
          };
          const shipped = cargoMetal + cargoFuel + cargoGold + cargoScience;
          if (shipped > 0) {
            await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
                  WHERE id = ?`,
              )
              .bind(net.metal, net.fuel, net.gold, net.science, r.counterparty_faction_id)
              .run();
            // Delivered science is INCOME this tick, not just bank —
            // the research drain clamps spend to income, and without
            // this a trade-fed faction banks science forever without
            // advancing a tech. Same fix the self-haul branch carries.
            if (net.science > 0) {
              scienceIncomeByFaction.set(
                r.counterparty_faction_id,
                (scienceIncomeByFaction.get(r.counterparty_faction_id) ?? 0) + net.science,
              );
            }
          }
          const loops = Number(r.loops_completed ?? 0) + 1;
          await this.env.DB
            .prepare(
              `UPDATE game_trade_routes
                  SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0,
                      status = 'returning', loops_completed = ?
                WHERE id = ?`,
            )
            .bind(loops, r.id)
            .run();

          // A LINE IN THE LOG ON EVERY LOOP (Lorne). The point is that a
          // standing route is automation, and automation that produces
          // resources invisibly is indistinguishable from a bug — or
          // from free money nobody is accounting for. Visible to the two
          // parties ONLY: who trades with whom, and how much, is exactly
          // the commercial intelligence the Sensors track exists to sell.
          try {
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                   (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'trade_route_run', ?, ?, ?, ?)`,
              )
              .bind(
                // Deterministic id (route + tick) — the same convention
                // as fleet_flag_lost above. crypto.randomUUID would work
                // too, but a stable id means a retried tick writes the
                // SAME row id and the second insert fails instead of
                // logging the loop twice.
                `c_trr_${r.id.slice(-10)}_${tick}`, gameId, tick, r.owner_faction_id,
                JSON.stringify({
                  agreement_id: r.agreement_id,
                  route_id: r.id,
                  loop: loops,
                  sender_faction_id: r.owner_faction_id,
                  recipient_faction_id: r.counterparty_faction_id,
                  delivered: net,
                  tariff_pct: Number(r.tariff_pct ?? 0),
                  // Gross vs net so the skim is legible rather than
                  // looking like the numbers simply don't add up.
                  gross: { metal: cargoMetal, fuel: cargoFuel, gold: cargoGold, science: cargoScience },
                }),
                JSON.stringify([r.owner_faction_id, r.counterparty_faction_id]),
                Date.now(),
              )
              .run();
          } catch (e) {
            console.error('trade route: run log failed', e, { routeId: r.id });
          }
          await planLeg(r.origin_body_id);
          continue;
        }

        // Otherwise (off-course or at correct endpoint with wrong cargo
        // phase), nudge the freighter toward whichever endpoint matches
        // the current status. This recovers from a player manually
        // flying the ship off-route.
        const target = r.status === 'outbound' ? r.dest_body_id : r.origin_body_id;
        if (here !== target) {
          await planLeg(target);
        }
       } catch (routeErr) {
         // One route blew up — log it and move on to the next so a
         // single bad route can't freeze everyone else's logistics.
         console.error('trade route failed for ship', r.ship_id, routeErr);
       }
      }

      // Escorts, for every route kind, once the carriers have moved.
      // Runs on a single-route dispatch too: assigning a guard should
      // send it on its way immediately, not an hour later.
      await this.paceAllGuards(gameId, tick, flyingShips, planLegFor);

      // A single-route dispatch (the route was just created) has no
      // business driving everyone else’s trade deliveries — it owes
      // THIS ship a first leg and nothing more. The tick pass still
      // runs 2d normally.
      if (onlyRouteId) return;

      // 2d. Trade DELIVERY auto-pilot — physical inter-player trades.
      //
      // Lives inside the same try as 2c so it shares bodyPosAt /
      // computeLegTicks and their caches. Each accepted trade leg
      // (trade_deliveries, migration 0041) with an assigned freighter
      // is driven through: burn to the sender's collector → load
      // (debit the sender's pool — the FIRST moment the goods exist
      // anywhere) → burn to the recipient's collector → credit their
      // pool, minus the tariff snapshotted at accept.
      //
      // Movement authority mirrors 2c exactly: skip anything with an
      // in-flight node, plan at most one leg per tick. A freighter
      // that ends up somewhere unexpected (retreat, manual detour
      // before the block in handleCommitTransfer, arrival body lost)
      // self-heals — every tick it's idle and off-script, we just plan
      // the leg it should be flying.
      try {
        const deliveries = (await this.env.DB
          .prepare(
            `SELECT * FROM trade_deliveries
              WHERE game_id = ? AND resolved_at_tick IS NULL
                AND ship_id IS NOT NULL
                AND status IN ('to_pickup', 'outbound')`,
          )
          .bind(gameId)
          .all()).results ?? [];

        for (const d of deliveries) {
         try {
          // Embargoed senders can't run shipments — same senate lever
          // that freezes their trade routes.
          if (await sanctioned(d.sender_faction_id, 'trade_embargo')) continue;

          const ship = await this.env.DB
            .prepare("SELECT id, parent_body_id, status FROM game_ships WHERE id = ?")
            .bind(d.ship_id).first();
          if (!ship || ship.status !== 'active') {
            // Freighter died and the piracy block didn't resolve this
            // row (e.g. destroyed by something with no kill credit).
            // Loaded cargo goes down with the ship; an unloaded leg
            // returns to the pool of assignable obligations.
            if (d.loaded === 1) {
              await this.env.DB
                .prepare(`UPDATE trade_deliveries SET status = 'lost', resolved_at_tick = ? WHERE id = ?`)
                .bind(tick, d.id).run();
            } else {
              await this.env.DB
                .prepare(`UPDATE trade_deliveries SET ship_id = NULL, pickup_body_id = NULL, status = 'unassigned' WHERE id = ?`)
                .bind(d.id).run();
            }
            continue;
          }

          const inFlight = await this.env.DB
            .prepare("SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status IN ('committed','in_transit') LIMIT 1")
            .bind(d.ship_id).first();
          if (inFlight) continue;

          const here = ship.parent_body_id;
          const planDeliveryLeg = async (targetBodyId) => {
            const legTicks = await computeLegTicks(
              d.sender_faction_id, here, targetBodyId, tick,
            );
            const seqRow = await this.env.DB
              .prepare('SELECT MAX(sequence) AS m FROM game_ship_nodes WHERE ship_id = ?')
              .bind(d.ship_id).first();
            const seq = (seqRow?.m ?? -1) + 1;
            const nodeId = `${d.ship_id}:td${tick}:n${seq}`;
            await this.env.DB
              .prepare(
                `INSERT INTO game_ship_nodes
                   (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
                    scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
                    status, committed_at_tick)
                 VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, 0, 0, 0, 0, 'committed', ?)`,
              )
              .bind(nodeId, gameId, d.ship_id, seq, targetBodyId, tick, tick + legTicks, tick)
              .run();
          };

          if (d.status === 'to_pickup') {
            if (here !== d.pickup_body_id) { await planDeliveryLeg(d.pickup_body_id); continue; }
            // At the collector: load. The debit is guarded — if the
            // sender's pool can't cover the manifest right now, the
            // freighter just WAITS here and we retry every tick. The
            // deal was allowed to out-promise the treasury at accept;
            // this is where that promise has to be made good.
            const upd = await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET metal = metal - ?, fuel = fuel - ?, gold = gold - ?, science = science - ?
                  WHERE id = ? AND game_id = ?
                    AND metal >= ? AND fuel >= ? AND gold >= ? AND science >= ?`,
              )
              .bind(
                d.metal, d.fuel, d.gold, d.science,
                d.sender_faction_id, gameId,
                d.metal, d.fuel, d.gold, d.science,
              )
              .run();
            if ((upd.meta?.changes ?? 0) === 0) continue;   // awaiting funds
            await this.env.DB
              .prepare(`UPDATE trade_deliveries SET loaded = 1, status = 'outbound' WHERE id = ?`)
              .bind(d.id).run();
            await planDeliveryLeg(d.dest_body_id);
          } else if (d.status === 'outbound') {
            if (here !== d.dest_body_id) { await planDeliveryLeg(d.dest_body_id); continue; }
            // Arrived. Credit the recipient minus the accept-time
            // tariff snapshot; floors so the skim can't mint units.
            const mul = 1 - Math.max(0, Math.min(100, d.tariff_pct ?? 0)) / 100;
            await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
                  WHERE id = ? AND game_id = ?`,
              )
              .bind(
                Math.floor(d.metal * mul), Math.floor(d.fuel * mul),
                Math.floor(d.gold * mul), Math.floor(d.science * mul),
                d.recipient_faction_id, gameId,
              )
              .run();
            await this.env.DB
              .prepare(`UPDATE trade_deliveries SET status = 'delivered', resolved_at_tick = ? WHERE id = ?`)
              .bind(tick, d.id).run();
            try {
              await this.env.DB
                .prepare(
                  `INSERT INTO chronicle_entries
                     (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
                   VALUES (?, ?, ?, 'trade_delivered', ?, ?, ?, 'public', ?)`,
                )
                .bind(
                  `c_td_${d.id}_${tick}`, gameId, tick,
                  d.sender_faction_id, d.dest_body_id,
                  JSON.stringify({
                    trade_id: d.trade_id,
                    sender_faction_id: d.sender_faction_id,
                    recipient_faction_id: d.recipient_faction_id,
                    ship_id: d.ship_id,
                    metal: d.metal, fuel: d.fuel, gold: d.gold, science: d.science,
                    tariff_pct: d.tariff_pct ?? 0,
                  }),
                  Date.now(),
                )
                .run();
            } catch (e) {
              console.error('trade_delivered chronicle insert failed', e);
            }
          }
         } catch (deliveryErr) {
           // Same isolation contract as routes: one broken shipment
           // must not strand every other convoy in the game.
           console.error('trade delivery failed for ship', d.ship_id, deliveryErr);
         }
        }
      } catch (e) {
        console.error('trade-delivery auto-pilot failed', e);
      }
    } catch (e) {
      console.error('trade-route auto-pilot failed', e);
    }
  }


  // === Match snapshots ======================================
  //
  // The whole game, reconstructable tick by tick -- the data a
  // full-match replay video plays from. Keyframe + delta, like video
  // encoding, because the goal IS a video: a keyframe carries complete
  // world state, a delta carries only what changed plus removals, and a
  // quiet tick writes nothing at all (absent tick = nothing changed).
  //
  // The previous tick's serialized state lives in DO memory. If the DO
  // was evicted the cache is empty and the tick simply writes a
  // keyframe -- eviction costs one bigger row, never correctness. A
  // scheduled keyframe every 60 ticks bounds how many deltas a reader
  // ever walks.
  async recordMatchSnapshot(gameId, tick) {
    const [ships, stl, fx, treaties, signers, routes] = await this.env.DB.batch([
      this.env.DB.prepare(
        `SELECT id, owner_faction_id AS fid, ship_class AS cls,
                parent_body_id AS parent, orbit_rp, orbit_ra, orbit_omega,
                orbit_m0, orbit_epoch, orbit_direction AS dir, hp, status,
                icon_variant AS iv
           FROM game_ships WHERE game_id = ? AND hp > 0`).bind(gameId),
      this.env.DB.prepare(
        `SELECT id, body_id AS body, owner_faction_id AS fid, type,
                population AS pop, hp
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`).bind(gameId),
      this.env.DB.prepare(
        `SELECT id, metal, fuel, gold, science FROM game_factions
          WHERE game_id = ? AND status = 'active'`).bind(gameId),
      this.env.DB.prepare(
        `SELECT id, kind FROM treaties
          WHERE game_id = ? AND status = 'active'`).bind(gameId),
      this.env.DB.prepare(
        `SELECT ts.treaty_id AS tid, ts.faction_id AS fid
           FROM treaty_signatories ts
           JOIN treaties t ON t.id = ts.treaty_id
          WHERE t.game_id = ? AND t.status = 'active'`).bind(gameId),
      this.env.DB.prepare(
        `SELECT id, owner_faction_id AS fid, ship_id AS ship,
                origin_body_id AS origin, dest_body_id AS dest, status
           FROM game_trade_routes
          WHERE game_id = ? AND status != 'cancelled'`).bind(gameId),
    ]);

    // Serialize every live entity to a compact array. The joined string
    // is the change detector: two ticks with the same string are the
    // same entity state, and rounding here decides what counts as "a
    // change" (a 1e-9 wobble in an orbital element does not).
    const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    const cur = new Map();
    for (const r of ships.results ?? []) {
      cur.set('s:' + r.id, ['s', r.id, r.fid, r.cls, r.parent,
        r3(r.orbit_rp), r3(r.orbit_ra), r3(r.orbit_omega), r3(r.orbit_m0),
        r.orbit_epoch, r.dir, Math.round((r.hp || 0) * 10) / 10, r.status,
        r.iv]);
    }
    for (const r of stl.results ?? []) {
      cur.set('t:' + r.id, ['t', r.id, r.body, r.fid, r.type,
        Math.round(r.pop || 0), Math.round((r.hp || 0) * 10) / 10]);
    }
    for (const r of fx.results ?? []) {
      cur.set('f:' + r.id, ['f', r.id, Math.round(r.metal || 0),
        Math.round(r.fuel || 0), Math.round(r.gold || 0),
        Math.round(r.science || 0)]);
    }
    const pactSigners = new Map();
    for (const r of signers.results ?? []) {
      if (!pactSigners.has(r.tid)) pactSigners.set(r.tid, []);
      pactSigners.get(r.tid).push(r.fid);
    }
    for (const r of treaties.results ?? []) {
      cur.set('p:' + r.id,
        ['p', r.id, r.kind, ...(pactSigners.get(r.id) ?? []).sort()]);
    }
    for (const r of routes.results ?? []) {
      cur.set('r:' + r.id, ['r', r.id, r.fid, r.ship, r.origin, r.dest, r.status]);
    }

    // The change detector must survive eviction. Games tick ~hourly and
    // a DO does not stay warm that long, so an in-memory cache meant
    // every tick wrote a keyframe -- observed live: eleven rows, eleven
    // keyframes, zero deltas. DO storage is durable per-game state; the
    // memory map is only a fast path over it.
    if (!this._snapCache) this._snapCache = new Map();
    let prev = this._snapCache.get(gameId);
    if (!prev) {
      const stored = await this.state.storage.get('snap:' + gameId);
      if (stored) prev = new Map(Object.entries(stored));
    }
    const keyframeDue = !prev || tick % 60 === 0;

    let put = [], del = [];
    if (keyframeDue) {
      put = [...cur.values()];
    } else {
      for (const [k, v] of cur) {
        const was = prev.get(k);
        if (!was || was !== JSON.stringify(v)) put.push(v);
      }
      for (const k of prev.keys()) {
        if (!cur.has(k)) del.push(k);
      }
    }

    // Cache the serialized form, not the arrays: string compare is the
    // whole diff, and strings are what JSON.stringify costs anyway.
    const next = new Map();
    for (const [k, v] of cur) next.set(k, JSON.stringify(v));
    this._snapCache.set(gameId, next);
    await this.state.storage.put('snap:' + gameId, Object.fromEntries(next));

    if (!keyframeDue && put.length === 0 && del.length === 0) return;

    const state = JSON.stringify({ v: 1, put, del });
    // D1 rows top out near 2MB; a state this large means something is
    // pathological, and losing one snapshot must never fail the tick.
    if (state.length > 1_500_000) {
      console.error('match snapshot oversized, skipped', gameId, tick, state.length);
      return;
    }
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO match_snapshots (game_id, tick_number, kind, state)
       VALUES (?, ?, ?, ?)`,
    ).bind(gameId, tick, keyframeDue ? 'key' : 'delta', state).run();
  }

  /**
   * DETONATE ONE HULL, and everything that follows from it.
   *
   * Extracted from the dead-man pass so a second trigger does not become a
   * second copy. There were already TWO implementations of this -- the
   * manual endpoint in actions.js and the 3.49 tick pass -- sharing only
   * detonatorDamage(). Adding scheduled strikes would have made three, and
   * three copies of "who is in the blast, what does it do to them, what
   * gets written down" is exactly the drift this codebase keeps paying for.
   *
   * `ship` must be a row carrying id, name, ship_class, owner_faction_id,
   * parent_body_id, hp, hp_max, parts_json. Returns true if it fired.
   * Never throws: a detonation that fails must not take the tick with it.
   */
  /**
   * Unordered faction pairs currently AT PEACE — an active NAP or defence
   * pact with both sides signed, not broken, not expired.
   *
   * Extracted so the scheduled-detonation guard (2c-arrive) and the combat
   * pass agree on who counts as hostile. They ran at different points in
   * the tick and the set was built inline in combat, so the alternative
   * was a second copy of the treaty rule — and "two derivations of one
   * truth" is the failure this file keeps repeating.
   *
   * Key with pairKeyOf(a, b); order does not matter.
   */
  /**
   * PLAN ONE LEG for a ship and write the node. Extracted from the trade
   * pass so the build queue can launch a hull the same way a trade route
   * does -- same planner, same launch plan, same raidability -- instead
   * of a second copy of flip-and-burn sizing.
   *
   * The trade pass still calls this through a thin closure, so its
   * behaviour is byte-identical; only the home of the code moved.
   */
  async planLegForShip(
    gameId, tick, shipId, factionId, fromBodyId, targetBodyId,
    arrivalOverride = null,
    /** The caller's in-tick dispatch guard. The trade pass keeps a Set of
     *  hulls already launched this tick so a ship is not sent twice; the
     *  build path has no such loop and passes nothing, taking a throwaway.
     *  Captured from the closure before this was extracted — eslint caught
     *  it as an undefined reference, which is what promoted it to a real
     *  parameter instead of a silent global. */
    flyingShips = new Set(),
  ) {
    const { computeLegTicks, bodyPosAt } = makeRouteMath(this.env.DB, gameId);
    const legTicks = await computeLegTicks(factionId, fromBodyId, targetBodyId, tick);
    const arrive = arrivalOverride != null ? Math.max(tick + 1, arrivalOverride) : tick + legTicks;
    const seqRow = await this.env.DB
      .prepare('SELECT MAX(sequence) AS m FROM game_ship_nodes WHERE ship_id = ?')
      .bind(shipId).first();
    const seq = (seqRow?.m ?? -1) + 1;
    const nodeId = `${shipId}:tr${tick}:n${seq}`;

    // A LAUNCH PLAN, OR THIS FREIGHTER CANNOT BE RAIDED.
    //
    // Transit combat skips any hull whose node has no plan, and this
    // is the ONLY place trade legs are created — so without this,
    // freighters on routes were the single class of ship that could
    // neither shoot nor be shot in flight. Measured on Peace Zone
    // before the fix: 31 of 33 player-ordered legs could fight, and
    // 0 of 17 trade legs could. Exactly backwards, since the trade
    // copy promises raiding and escorting is the whole reason guards
    // exist.
    //
    // Symmetric flip-and-burn, so the acceleration falls out of the
    // leg the planner just sized: d = a(T/2)^2, hence a = 4d/T^2.
    // Same shape the client posts, so both sides integrate one plan.
    let lx = null, ly = null, lvx = null, lvy = null, acc = null, flip = null;
    try {
      const from = await bodyPosAt(fromBodyId, tick);
      const to = await bodyPosAt(targetBodyId, arrive);
      const T = arrive - tick;
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      if (T > 0 && d > 0) {
        // Departure velocity is the origin body's — the hull carries
        // its parking orbit's motion out with it.
        const fromNext = await bodyPosAt(fromBodyId, tick + 0.01);
        lvx = (fromNext.x - from.x) / 0.01;
        lvy = (fromNext.y - from.y) / 0.01;

        // DEPART FROM THE PARK ORBIT, NOT THE BODY'S CENTRE. That is
        // 6-10 units, against weapon ranges of 12-20 — enough to
        // decide a passing contact in or out of range on a point the
        // client never drew, since the client places a parked hull on
        // its orbit and now prefers this stored plan over its own
        // derivation.
        lx = from.x; ly = from.y;
        try {
          const el = await this.env.DB
            .prepare(
              `SELECT s.orbit_rp, s.orbit_ra, s.orbit_omega, s.orbit_m0,
                      s.orbit_epoch, s.orbit_direction, b.mu, b.type
                 FROM game_ships s
                 LEFT JOIN game_bodies b ON b.id = s.parent_body_id
                WHERE s.id = ?`,
            )
            .bind(shipId).first();
          if (el) {
            const mu = muOfRow({ mu: el.mu, type: el.type },
                               String(fromBodyId).endsWith(':sol') || fromBodyId === 'sol');
            const local = shipOrbitLocalPosition({
              rp: el.orbit_rp, ra: el.orbit_ra, omega: el.orbit_omega,
              m0: el.orbit_m0, epoch: el.orbit_epoch, direction: el.orbit_direction,
            }, mu, tick);
            lx = from.x + local.x;
            ly = from.y + local.y;
          }
        } catch (e) {
          console.error('park-orbit offset failed, using body centre', e, { shipId });
        }
        // BACK-SOLVED FROM THE COMMITTED LEG, not read off the
        // faction's engine. The plan's whole job is to say where the
        // hull is between two known endpoints at two known times, so
        // it has to be self-consistent with the arrival the planner
        // actually committed to — which is rounded up to whole ticks,
        // and which paceAllGuards deliberately OVERRIDES so an escort
        // lands in lockstep with its carrier.
        //
        // Using the raw engine value there would store an
        // acceleration that cannot reach the destination in the time
        // the node claims: the hull would lag its own arc all flight
        // and snap at the end. Symmetric flip-and-burn, d = a(T/2)^2,
        // so a = 4d/T^2.
        acc = 4 * d / (T * T);
        flip = tick + T / 2;
      }
    } catch (e) {
      // A missing body should cost this leg its combat visibility,
      // never the leg itself — the route has to keep running.
      console.error('trade leg: launch plan failed', e, { shipId });
    }

    await this.env.DB
      .prepare(
        `INSERT INTO game_ship_nodes
           (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
            scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
            launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick,
            status, committed_at_tick)
         VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      )
      .bind(nodeId, gameId, shipId, seq, targetBodyId, tick, arrive,
            lx, ly, lvx, lvy, acc, flip, tick)
      .run();
    flyingShips.add(shipId);
    return arrive;
  }

  async peacePairs(gameId, tick) {
    const rows = (await this.env.DB
      .prepare(
        `SELECT t.id, ts.faction_id
           FROM treaty_signatories ts
           JOIN treaties t ON t.id = ts.treaty_id
          WHERE t.game_id = ?
            AND t.status = 'active'
            AND t.broken_at_tick IS NULL
            AND ts.signed_at_tick IS NOT NULL
            AND t.kind IN ('nap', 'defense_pact')
            AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?)`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];
    const byTreaty = new Map();
    for (const r of rows) {
      if (!byTreaty.has(r.id)) byTreaty.set(r.id, []);
      byTreaty.get(r.id).push(r.faction_id);
    }
    const out = new Set();
    for (const sigs of byTreaty.values()) {
      for (let i = 0; i < sigs.length; i++) {
        for (let j = i + 1; j < sigs.length; j++) {
          out.add(sigs[i] < sigs[j] ? `${sigs[i]}|${sigs[j]}` : `${sigs[j]}|${sigs[i]}`);
        }
      }
    }
    return out;
  }

/**
   * Does a 'hostile_in_orbit' guard hold for this hull right now?
   *
   * TREATY-AWARE, and CIVILIAN-BLIND. A pact partner parked at the same
   * rock is not a reason to blow up, and neither is a freighter: losing
   * a destroyer to a passing cargo hauler is the obvious way this
   * feature would earn a bug report. Only an armed hull from a faction
   * you are not at peace with counts. Same treaty rule the combat pass
   * uses.
   *
   * Extracted when the timed trigger (0110) arrived: arrival strikes and
   * scheduled demolitions must agree on what "hostile" means, and two
   * copies of this query would eventually not.
   *
   * A null/unknown guard means UNCONDITIONAL -- the order fires.
   */
/**
   * Is any FRIENDLY hull sharing this orbit?
   *
   * Deliberately counts DIFFERENT things from hostileGuardHolds, and
   * the asymmetry is the point:
   *
   *   hostile detection IGNORES civilians -- a passing freighter is not
   *   a reason to blow up.
   *   friendly detection COUNTS them -- your freighter still dies in
   *   the blast.
   *
   * detonateShip damages every hull in the orbit regardless of flag, so
   * "would this cost me anything" has to include the hulls that cannot
   * shoot back.
   *
   * Friendly means your own faction OR one you are at peace with, using
   * the same treaty rule as everything else here: a pact partner's
   * cruiser is not collateral you get to ignore.
   *
   * Excludes the mined hull itself (it is the bomb) and anything in
   * flight (it is not here yet).
   *
   * NOTE: this widened when detonations began damaging stations. A mine
   * set to spare your friends has to know that your STATION is one of
   * them, or "no friends to lose" would quietly stop being true. The
   * practical consequence is that ALONE will not fire at a world you
   * hold a station at -- which is the correct reading of the promise,
   * not a bug.
   */
  async friendlyInOrbit(gameId, tick, ship) {
    const near = (await this.env.DB
      .prepare(
        `SELECT DISTINCT f.owner_faction_id AS fid
           FROM game_ships f
          WHERE f.game_id = ? AND f.parent_body_id = ? AND f.status = 'active'
            AND f.id != ?
            AND NOT EXISTS (
              SELECT 1 FROM game_ship_nodes n
               WHERE n.ship_id = f.id AND n.status = 'in_transit'
            )`,
      )
      .bind(gameId, ship.parent_body_id, ship.id).all()).results ?? [];

    // STATIONS COUNT TOO, since the blast now damages them (0113). The
    // question this answers is "would firing cost me anything", and a
    // station of yours in the blast is very much something to lose.
    // Cities do not: a detonation is in orbit and they are on the
    // ground, so the charge never reaches them.
    const stations = (await this.env.DB
      .prepare(
        `SELECT DISTINCT owner_faction_id AS fid
           FROM game_settlements
          WHERE game_id = ? AND body_id = ? AND type = 'station'
            AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId, ship.parent_body_id).all()).results ?? [];

    const parties = [...near, ...stations];
    if (parties.length === 0) return false;
    if (parties.some(f => f.fid === ship.owner_faction_id)) return true;
    const atPeace = await this.peacePairs(gameId, tick);
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    return parties.some(f => atPeace.has(key(ship.owner_faction_id, f.fid)));
  }

    async hostileGuardHolds(gameId, tick, ship, guard) {
    if (guard !== 'hostile_in_orbit') return true;
    const foe = await this.env.DB
      .prepare(
        `SELECT f.owner_faction_id AS fid
           FROM game_ships f
          WHERE f.game_id = ? AND f.parent_body_id = ? AND f.status = 'active'
            AND f.owner_faction_id != ?
            AND f.ship_class NOT IN ('freighter', 'colony')
            AND NOT EXISTS (
              SELECT 1 FROM game_ship_nodes n
               WHERE n.ship_id = f.id AND n.status = 'in_transit'
            )`,
      )
      .bind(gameId, ship.parent_body_id, ship.owner_faction_id).all();
    const foes = foe.results ?? [];
    const atPeace = await this.peacePairs(gameId, tick);
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    return foes.some(f => !atPeace.has(key(ship.owner_faction_id, f.fid)));
  }

    async detonateShip(gameId, tick, ship) {
          const parts = parsePartsJson(ship.ship_class, ship.parts_json);
          const nDet = countPart(parts, 'detonator');
          if (nDet <= 0) return false;   // no detonator fitted
          try {
            // Weapons tech at trigger time, half rate — same as manual.
            const weaponsRow = await this.env.DB
              .prepare("SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = 'weapons'")
              .bind(gameId, ship.owner_faction_id)
              .first();
            // EFFECTIVE ceiling, not the stored base — one helper feeds
            // all four tick-pass detonation paths through this method,
            // so the dead-man, the timed charge, the proximity mine and
            // the arrival strike all pay out what the tooltip promised.
            const blastBase = await effectiveHpMaxOf(this.env.DB, gameId, ship.id);
            const damage = detonatorDamage(blastBase, nDet, weaponsRow?.level ?? 0);

            const victims = (await this.env.DB
              .prepare(
                `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.hp
                   FROM game_ships s
                  WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active'
                    AND s.id != ?
                    AND NOT EXISTS (
                      SELECT 1 FROM game_ship_nodes n
                       WHERE n.ship_id = s.id AND n.status = 'in_transit'
                    )`,
              )
              .bind(gameId, ship.parent_body_id, ship.id)
              .all()).results ?? [];

            const stmts = [
              this.env.DB
                .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
                .bind(tick, ship.id),
            ];
            const victimSummaries = [];
            for (const v of victims) {
              const newHp = Math.max(0, (v.hp ?? 0) - damage);
              stmts.push(
                newHp <= 0
                  ? this.env.DB
                      .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
                      .bind(tick, v.id)
                  : this.env.DB.prepare('UPDATE game_ships SET hp = ?, last_damaged_tick = ? WHERE id = ?').bind(newHp, tick, v.id),
              );
              victimSummaries.push({
                ship_id: v.id,
                ship_name: v.name,
                ship_class: v.ship_class,
                owner_faction_id: v.owner_faction_id,
                destroyed: newHp <= 0,
              });
            }
            // STATIONS take half. Planned into the SAME batch as the
            // hull damage so a blast is all-or-nothing: a detonation
            // that killed ships but left the station untouched because
            // a second write failed would be worse than not landing.
            let stationSummaries = [];
            try {
              const blast = await planStationBlast(
                this.env.DB, gameId, tick, ship.parent_body_id, damage,
              );
              stmts.push(...blast.stmts);
              stationSummaries = blast.summaries;
            } catch (e) {
              console.error('station blast planning failed', e, { gameId, shipId: ship.id });
            }
            await this.env.DB.batch(stmts);

            // A station lost to a blast has to be logged and re-flag the
            // body, exactly as one lost to bombardment does -- otherwise
            // a world stays marked as held by a faction whose only
            // station just evaporated.
            if (stationSummaries.some(x => x.destroyed)) {
              await finalizeStationBlast(
                this.env.DB, gameId, tick, ship.parent_body_id,
                stationSummaries, ship.owner_faction_id,
              );
              try { await recomputeBodyOwnership(this.env.DB, gameId, ship.parent_body_id); }
              catch (e) { console.error('recomputeBodyOwnership failed after blast', e); }
            }

            // Everyone who actually died here takes the survival roll —
            // the detonating hull and any victim it took with it. The
            // MANUAL detonate endpoint already did this (actions.js); the
            // tick-loop copy never did, so a detonation resolved on the
            // clock left its captains pointing at destroyed ships forever.
            try {
              for (const deadId of [ship.id, ...victimSummaries.filter(v => v.destroyed).map(v => v.ship_id)]) {
                await resolveCaptainOnDeath(this.env.DB, gameId, tick, deadId);
              }
            } catch (e) {
              console.error('detonation captain resolution failed', e, { gameId, shipId: ship.id });
            }

            try {
              const bodyRow = await this.env.DB
                .prepare('SELECT name FROM game_bodies WHERE id = ?')
                .bind(ship.parent_body_id)
                .first();
              const facRows = (await this.env.DB
                .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
                .bind(gameId)
                .all()).results ?? [];
              const facName = new Map(facRows.map(f => [f.id, f.name]));
              const payload = JSON.stringify({
                ship_id: ship.id,
                ship_name: ship.name,
                ship_class: ship.ship_class,
                body_name: bodyRow?.name ?? null,
                owner_faction_name: facName.get(ship.owner_faction_id) ?? null,
                damage,
                detonators: nDet,
                auto: true,
                detonate_hp_pct: ship.detonate_hp_pct,
                stations: stationSummaries,
                victims: victimSummaries.map(v => ({
                  ...v,
                  owner_faction_name: facName.get(v.owner_faction_id) ?? null,
                })),
                destroyed_count: victimSummaries.filter(v => v.destroyed).length,
                // HULL AT THE MOMENT OF THE DECISION. Toll alone cannot tell a weapon
                // from a last resort: a ship detonating at full health was SENT to do
                // it, and one going up at eight percent was going to die anyway. The
                // Herald reads this to pick its register, so it has to be captured
                // here -- after the fact the hull is gone and its hp is zero.
                hp_pct: (ship.hp_max ?? 0) > 0
                  ? Math.max(0, Math.min(100, Math.round(((ship.hp ?? 0) / ship.hp_max) * 100)))
                  : null,
              });
              await this.env.DB
                .prepare(
                  `INSERT INTO chronicle_entries
                    (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
                   VALUES (?, ?, ?, 'ship_detonated', ?, ?, ?, ?, 'public', ?)`,
                )
                .bind(`c_det_${ship.id.slice(-10)}_${tick}`, gameId, tick, ship.owner_faction_id,
                      ship.parent_body_id, ship.id, payload, Date.now())
                .run();
            } catch (e) { console.error('auto ship_detonated chronicle failed', e); }
          } catch (e) {
            console.error('dead-man detonate failed for ship', ship.id, e);
          }
    return true;
  }

  async resolveTick(gameId, tick) {
    // What the fleet-upkeep pass actually charged each faction this tick,
    // for the economy ledger written at the end. Recorded rather than
    // recomputed: the settle() logic clamps against carry and arrears, so
    // "what was owed" and "what was taken" are different numbers and only
    // the pass itself knows which is which.
    const upkeepChargedThisTick = new Map(); // fid -> {metal, gold, arrearsMetal, arrearsGold}

    // Tunables for THIS game, resolved once. Every knob below reads from
    // here instead of a hardcoded literal, so the admin Editor can change
    // balance without a deploy. A game is pinned to the config it was
    // created with, so a publish never rewrites a match in flight.
    // Falls back to shipped defaults on any error — see gameConfig.js.
    const CFG = await loadGameConfig(this.env, gameId);

    // Captains — lazy backfill + attach-on-build (spec §2.2). Runs first
    // so every ship entering combat this tick already has its officer.
    // Covers EVERY faction (rival aces must not be stealth-nerfed) and
    // no-ops once drained. Never allowed to block the tick.
    // === ELIMINATION ==========================================
    // A faction whose LAST SETTLEMENT is gone is out of the game.
    //
    // This rule did not exist. Nothing in the codebase ever moved
    // game_factions.status off 'active' -- all 46 factions in the live
    // database were active, including one the Herald was already reporting
    // at minus one world. Everything downstream was written correctly and
    // simply never fired: quorumFor counts status='active', the chancellor
    // vote re-checks that a candidate is "still around", and the digest has
    // had a faction_eliminated phrasing waiting the whole time.
    //
    // Settlements, not ships. A fleet with nowhere to dock is a defeat in
    // progress; losing the last piece of ground is the end of it, and it is
    // the condition Lorne stated.
    //
    // Placed here, once per tick, rather than inline at each settlement
    // death: razing, bombardment and asteroid strikes all remove ground by
    // different paths, and a single sweep catches every one of them without
    // three copies of the same rule.
    try {
      const wiped = (await this.env.DB
        .prepare(`SELECT f.id, f.name FROM game_factions f
                   WHERE f.game_id = ? AND f.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1 FROM game_settlements s
                        WHERE s.game_id = f.game_id
                          AND s.owner_faction_id = f.id
                          AND s.destroyed_at_tick IS NULL)
                     -- ...and they must have HELD ground to have lost it.
                     -- The rule is "their last settlement is destroyed", not
                     -- "they have none": a faction created by a late join is
                     -- momentarily settlement-less before it is seeded, and
                     -- without this it would be eliminated on its first tick.
                     -- Requiring a destroyed settlement distinguishes wiped
                     -- out from not yet placed.
                     AND EXISTS (
                       SELECT 1 FROM game_settlements s2
                        WHERE s2.game_id = f.game_id
                          AND s2.owner_faction_id = f.id
                          AND s2.destroyed_at_tick IS NOT NULL)`)
        .bind(gameId).all()).results ?? [];
      for (const f of wiped) {
        await this.env.DB
          .prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = ?`)
          .bind(f.id).run();
        // The Herald already knows how to report this kind; it has simply
        // never been handed one.
        try {
          await this.env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'faction_eliminated', ?, ?, 'public', ?)`)
            .bind(`c${tick}_elim_${String(f.id).slice(-8)}`, gameId, tick, f.id,
                  JSON.stringify({ faction_name: f.name ?? null, cause: 'no_settlements' }),
                  Date.now())
            .run();
        } catch (e) { console.error('elimination chronicle failed', f.id, e); }
      }
    } catch (e) {
      // Never allowed to block the tick, same contract as the passes below.
      console.error('elimination sweep failed', e);
    }

    try {
      await ensureCaptainFloor(this.env.DB, gameId, tick);
      // RELEASE STRANDED CAPTAINS FIRST.
      //
      // A captain whose ship no longer exists is in limbo: ship_id is set
      // so the bank doesn't list them and ensureCaptains won't re-post
      // them, but the hull is gone so they aren't serving either. They
      // show in the roster as "on assignment" forever and can never be
      // used again — which is exactly what a player reported.
      //
      // Combat deaths clear this properly (resolveCaptainOnDeath). What
      // did not: a colony ship CONSUMED to found a settlement, and ships
      // destroyed by a detonation resolved inside the tick loop. Both are
      // fixed at source, but this sweep runs anyway — it repairs the
      // captains already stranded in live games, and it means the next
      // destruction path someone adds can't quietly strand more.
      //
      // Cleared rather than killed: their ship left the board without
      // them dying in it, so they go back to the bank ready to serve.
      await this.env.DB
        .prepare(
          `UPDATE game_captains
              SET ship_id = NULL, benched_at_tick = NULL
            WHERE game_id = ?
              AND status = 'active'
              AND ship_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM game_ships s
                 WHERE s.id = game_captains.ship_id AND s.status = 'active'
              )`,
        )
        .bind(gameId)
        .run();
      await ensureCaptains(this.env.DB, gameId, tick);
    } catch (e) {
      console.error('captain backfill pass failed', e);
    }

    // 0.05 Fleet flag integrity + auto-disband (DESIGN-fleets.md).
    //   - A flag captain who no longer commands an ACTIVE MEMBER ship
    //     (flagship destroyed, captain lost or banked) beheads the
    //     fleet: flag_captain_id -> NULL, chronicle fleet_flag_lost.
    //     The fleet persists leaderless; promotion is a player act.
    //   - Fleets below 2 active members dissolve silently.
    try {
      const beheaded = (await this.env.DB
        .prepare(
          `SELECT f.id, f.name, f.faction_id FROM game_fleets f
            WHERE f.game_id = ? AND f.flag_captain_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM game_captains c
                  JOIN game_ships s ON s.id = c.ship_id
                 WHERE c.id = f.flag_captain_id AND c.status = 'active'
                   AND s.fleet_id = f.id AND s.status = 'active')`,
        )
        .bind(gameId)
        .all()).results ?? [];
      for (const f of beheaded) {
        await this.env.DB
          .prepare('UPDATE game_fleets SET flag_captain_id = NULL WHERE id = ?')
          .bind(f.id)
          .run();
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
               (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'fleet_flag_lost', ?, NULL, ?, 'public', ?)`,
          )
          .bind(`c_flx_${f.id.slice(-8)}_${tick}`, gameId, tick, f.faction_id,
                JSON.stringify({ fleet_id: f.id, fleet_name: f.name }), Date.now())
          .run();
      }
      const small = (await this.env.DB
        .prepare(
          `SELECT f.id FROM game_fleets f
            WHERE f.game_id = ?
              -- < 1, NOT < 2. This used to DELETE the fleet row the
              -- moment a squadron dropped to one hull, taking its name
              -- and its flag-captain assignment with it — so a fleet
              -- that took losses in a hard fight had to be rebuilt from
              -- scratch, and the identity is the part players get
              -- attached to. A one-ship fleet is a fleet waiting for
              -- reinforcements. Only a fleet with NOTHING left is
              -- swept, because there is then nothing to reinforce.
              AND (SELECT COUNT(*) FROM game_ships s
                    WHERE s.fleet_id = f.id AND s.status = 'active') < 1`,
        )
        .bind(gameId)
        .all()).results ?? [];
      for (const f of small) {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE game_ships SET fleet_id = NULL WHERE game_id = ? AND fleet_id = ?').bind(gameId, f.id),
          this.env.DB.prepare('DELETE FROM game_fleets WHERE game_id = ? AND id = ?').bind(gameId, f.id),
        ]);
      }
    } catch (e) {
      console.error('fleet integrity pass failed', e);
    }

    // 0. Phantom-ownership sweep. Bodies whose last surviving settlement
    //    was destroyed used to keep their old owner attached (the
    //    recomputeBodyOwnership helper short-circuited on "zero
    //    settlements" instead of clearing). The helper is fixed now, but
    //    a single SQL pass per tick scrubs any rows already stuck in
    //    that state from prior ticks — idempotent and cheap.
    try {
      await this.env.DB
        .prepare(
          `UPDATE game_bodies
              SET owner_faction_id = NULL
            WHERE game_id = ?
              AND owner_faction_id IS NOT NULL
              -- MEGASTRUCTURES ARE NOT OWNED BY SETTLEMENT. A site holds
              -- its founder's flag from the moment the foundation goes
              -- down and changes hands only on capture, so a sweep that
              -- infers ownership from settlements disowns every one of
              -- them on the tick after they are built. It did exactly
              -- that: a gate was founded, and one tick later nobody
              -- owned it and nobody could wire it.
              AND type != 'megastructure'
              AND NOT EXISTS (
                SELECT 1 FROM game_settlements s
                 WHERE s.game_id = game_bodies.game_id
                   AND s.body_id = game_bodies.id
                   AND s.destroyed_at_tick IS NULL
              )`,
        )
        .bind(gameId)
        .run();
    } catch (e) {
      // Best-effort: never let the sweep block the rest of the tick.
      console.error('phantom-ownership sweep failed', e);
    }

    // 0.5. Settlement-building completions. building_order_json carries
    //      a single in-flight upgrade per settlement; when complete_tick
    //      hits, bump the kind in buildings_json and clear the order.
    //
    // Telescopes finishing this tick are collected and surveyed AFTER
    // the loop: the survey needs body positions, which are resolved far
    // below, and doing it inline would mean building that machinery
    // twice.
    const telescopeCompletions = [];
    try {
      const dueOrders = (await this.env.DB
        .prepare(
          `SELECT id, owner_faction_id, body_id, buildings_json, building_order_json, building_backlog_json
             FROM game_settlements
            WHERE game_id = ?
              AND destroyed_at_tick IS NULL
              AND building_order_json IS NOT NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];
      for (const row of dueOrders) {
        let order; try { order = JSON.parse(row.building_order_json); } catch { continue; }
        if (!order || (order.complete_tick ?? 0) > tick) continue;
        let buildings = {};
        if (row.buildings_json) {
          try { buildings = JSON.parse(row.buildings_json) ?? {}; } catch { buildings = {}; }
        }
        buildings[order.kind] = Math.max(buildings[order.kind] ?? 0, order.target_level ?? 1);
        // FIRST LIGHT. A finished telescope grants the nearest
        // undiscovered rock immediately, so an expensive building
        // produces a visible result instead of nothing until an orbit
        // happens to wander into range. Best-effort: a survey failing
        // must never cost the player the building they just paid for.
        if (order.kind === 'telescope') {
          telescopeCompletions.push({
            factionId: row.owner_faction_id ?? null,
            bodyId: row.body_id ?? null,
          });
        }
        // Promote the next queued upgrade into the now-empty slot and
        // start its clock from THIS tick. Its duration was priced when the
        // player queued it, so it rides on the entry rather than being
        // re-derived here against a level that has since moved.
        let backlog = [];
        if (row.building_backlog_json) {
          try {
            const parsed = JSON.parse(row.building_backlog_json);
            if (Array.isArray(parsed)) backlog = parsed;
          } catch { backlog = []; }
        }
        const next = backlog.shift() ?? null;
        if (next) {
          const span = Math.max(1, Number(next.ticks ?? 1));
          next.start_tick = tick;
          next.complete_tick = tick + span;
        }
        await this.env.DB
          .prepare(
            `UPDATE game_settlements
                SET buildings_json = ?, building_order_json = ?, building_backlog_json = ?
              WHERE id = ?`,
          )
          .bind(
            JSON.stringify(buildings),
            next ? JSON.stringify(next) : null,
            backlog.length ? JSON.stringify(backlog) : null,
            row.id,
          )
          .run();
        // Chronicle the completion so players can see a forge/lab/
        // shipyard level finishing in the log.
        try {
          const meta = await this.env.DB
            .prepare(`SELECT s.body_id, s.owner_faction_id, s.name AS settlement_name,
                             b.name AS body_name, f.name AS owner_faction_name
                        FROM game_settlements s
                        JOIN game_bodies b   ON b.id = s.body_id
                        LEFT JOIN game_factions f ON f.id = s.owner_faction_id
                       WHERE s.id = ?`)
            .bind(row.id).first();
          if (meta) {
            const payload = JSON.stringify({
              building_kind: order.kind,
              new_level: buildings[order.kind],
              settlement_id: row.id,
              settlement_name: meta.settlement_name,
              body_name: meta.body_name,
              owner_faction_name: meta.owner_faction_name,
            });
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'building_completed', ?, ?, ?, 'public', ?)`,
              )
              .bind(`c_b_${row.id}_${order.kind}_${tick}`, gameId, tick,
                    meta.owner_faction_id, meta.body_id, payload, Date.now())
              .run();
          }
        } catch (e) {
          console.error('building_completed chronicle insert failed', e);
        }
      }
    } catch (e) {
      console.error('settlement-building completion pass failed', e);
    }

    // 1. Build completions. Each row spawns one ship in a small circular
    //    orbit around the building body. Only ACTIVE rows complete —
    //    status='waiting' rows (queued beyond concurrency, see 0037)
    //    carry a placeholder completes_at_tick and are promoted in 1b
    //    below once a slot frees up. Legacy rows read status='building'
    //    via the column DEFAULT.
    const builds = (await this.env.DB
      .prepare(
        `SELECT id, body_id, faction_id, ship_class, completes_at_tick,
                icon_variant, ship_name, parts_json, rush_count, botched,
                build_order, build_order_body_id, build_order_route_id, build_order_fleet_id
           FROM game_body_build_queue
          WHERE game_id = ?
            AND cancelled_at_tick IS NULL
            AND status = 'building'
            AND completes_at_tick <= ?`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    // Faction tech levels (weapons/armor) — part effects scale with
    // tech at COMPLETION time (worker/shipDesigns.js computeShipStats).
    // Cached per faction across this tick's builds. Bare-hull orders
    // (parts_json NULL — every pre-designer queue row) never touch
    // tech and come out exactly as today's stats.
    const techCache = new Map();
    const techLevelsFor = async (factionId) => {
      let levels = techCache.get(factionId);
      if (!levels) {
        const rows = (await this.env.DB
          .prepare(
            `SELECT tech_id, level FROM faction_techs
              WHERE game_id = ? AND faction_id = ? AND tech_id IN ('weapons','armor','shields')`,
          )
          .bind(gameId, factionId)
          .all()).results ?? [];
        levels = Object.fromEntries(rows.map(r => [r.tech_id, r.level ?? 0]));
        techCache.set(factionId, levels);
      }
      return levels;
    };

    for (const [idx, b] of builds.entries()) {
     // Per-row guard: a single bad completion (malformed parts, a
     // constraint failure, a missing body) must NOT abort the whole
     // pass — doing so would also skip the promotion pass (1b) below and
     // every later pass, silently FREEZING the room's tick forever
     // (waiting builds never promote, income/combat never run). Isolate
     // each row so one poison build can't take the game down.
     try {
      // Defense in depth vs. the settlement-loss cancellation (§3.4): a
      // ship only rolls out if its faction STILL holds a living
      // settlement at the body at completion time. Covers destruction
      // paths that miss the explicit cancel (asteroid impacts, future
      // mechanics) — no yard, no ship.
      const yardStill = await this.env.DB
        .prepare(
          `SELECT 1 AS x FROM game_settlements
            WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
              AND destroyed_at_tick IS NULL
            LIMIT 1`,
        )
        .bind(gameId, b.body_id, b.faction_id)
        .first();
      if (!yardStill) {
        await this.env.DB
          .prepare('UPDATE game_body_build_queue SET cancelled_at_tick = ? WHERE id = ? AND cancelled_at_tick IS NULL')
          .bind(tick, b.id)
          .run();
        continue;
      }
      const body = await this.env.DB
        .prepare('SELECT radius, mu FROM game_bodies WHERE id = ?')
        .bind(b.body_id)
        .first();
      if (!body) {
        // Body gone (destroyed?) — the order can never complete here.
        // Drop it so it doesn't wedge the queue, refunding nothing (the
        // body's loss is the player's problem, not a double charge).
        await this.env.DB
          .prepare('DELETE FROM game_body_build_queue WHERE id = ?')
          .bind(b.id).run();
        continue;
      }

      const FUEL_MAX = { corvette: 80, frigate: 200, destroyer: 300, freighter: 400, colony: 100 };
      // HP/DMG now come from SHIP_COMBAT_STATS via computeShipStats below
      // (single source of truth shared with the designer's part math).
      // Those values already carry origin's client-alignment fix — HP must
      // match src/game/shipClasses.ts or the client renders a permanently
      // half-full bar: frigate 80->100, freighter 30->60.
      const fuelMax = FUEL_MAX[b.ship_class] ?? 100;
      // Ship designer: hull base × part multipliers × tech (spec §2).
      // parts_json is the snapshot taken at queue time; NULL = bare
      // hull = the legacy HP/DMG table values exactly.
      const parts = parsePartsJson(b.ship_class, b.parts_json);
      // Cached per faction, so reading it unconditionally costs nothing
      // extra — the spawn-HP math below needs the defense level even for
      // a bare hull, which the `parts.length > 0` gate used to skip.
      const techLevels = await techLevelsFor(b.faction_id);
      const stats = computeShipStats(
        b.ship_class, parts,
        parts.length > 0 ? techLevels : {},
      );
      const hp = stats.hp;
      const dmg = stats.damage_per_tick;
      // Tight park orbit: just off the surface. Proportional to the body
      // (parkOrbitRadius in factions.js) — an additive offset put a hull
      // 4.3x the radius away from a small moon and 1.1x away from Sol.
      const rp = parkOrbitRadius(body.radius);
      const ra = rp; // circular orbit
      // Collision-proof id: tick + loop index guarantees uniqueness even
      // when many builds finish on the SAME tick (a fleet spammer with
      // queues at a dozen bodies). The old `s${tick}_${id.slice(-6)}`
      // could collide on the last-6 chars of two queue ids finishing
      // together → PRIMARY KEY failure → the whole batch (and tick)
      // threw. idx is unique within the tick; tick is unique across them.
      const shipId = `${gameId}:s${tick}_${idx}_${b.id.slice(-5)}`;
      // Honor the player's custom name from BuildPanel if they queued
      // one; otherwise fall back to the legacy auto-name so older
      // queue rows (pre-0029 migration) still complete cleanly.
      const shipName = (typeof b.ship_name === 'string' && b.ship_name.trim().length > 0)
        ? b.ship_name.trim()
        // Legacy fallback keyed on tick alone produced the SAME name for
        // every same-class hull finishing on that tick — across factions
        // too ("Corvette T14" on three different ships at once). The hull
        // number keeps the shape but makes each one distinct.
        : `${b.ship_class.charAt(0).toUpperCase()}${b.ship_class.slice(1)} ` +
          `T${tick}-${String(Math.floor(Math.random() * 900) + 100)}`;

      // Veteran Yards (weapons 5) used to launch new hulls carrying a
      // QUARTER of the faction's average fleet rank. That is hull-carried
      // veterancy by another name, and veterancy is now CAPTAIN-ONLY, so
      // the perk is retired: every hull rolls out at rank 0 and earns
      // nothing until an officer boards it.
      //
      // It also read AVG(rank) FROM game_ships, a column migration 0068
      // zeroes — so the bonus was about to silently evaluate to 0 anyway.
      // FOLLOW-UP for whoever owns the research tree: Weapons 5 now has
      // no shipyard effect. Re-pointing it at captains (a free ranked
      // officer with each hull, say) is new design, not a mechanical
      // translation, so it is deliberately not invented here.
      const spawnRank = 0;

      // Launch at the EFFECTIVE ceiling, not the bare baked hull.
      // hp_max is stored as the build-time base; the live ceiling is
      // base × defense tech (+8%/level) × rank (+1%/kill) — see
      // armorMulOf and the maintenance pass's effectiveMaxHp, which the
      // client mirrors in effectiveShipMaxHp. Spawning at `hp` meant a
      // fresh hull was born short of its own ceiling by exactly that
      // multiplier: at Defense 6 it launched reading 68%, and because
      // repair is station-only it stayed that way (playtest report:
      // "all my ships are launching at like half health"). Same fix the
      // armor-research pass already applies to EXISTING hulls when a
      // level lands; the spawn path never got it.
      //
      // Bulwark/aura hpMul are deliberately NOT folded in: a new hull
      // has no captain and no fleet yet. Once ensureCaptains posts one,
      // the maintenance pass repairs it up to the higher ceiling.
      const defenseLvl = Math.max(
        Number(techLevels.armor ?? 0),
        Number(techLevels.shields ?? 0),
      );
      // Botched rush (§3): the 25% roll happened at rush time (sticky —
      // stamped on the order); the hull rolls out at HALF the effective
      // ceiling. hp_max stays the full base, so the ship reads 50% and
      // repairs normally at any friendly station. The rush endpoint
      // already chronicled the botch publicly for the herald.
      const botchMul = (b.botched ?? 0) ? 0.5 : 1;
      const spawnHp = hp * (1 + 0.08 * defenseLvl) * (1 + 0.01 * spawnRank) * botchMul;

      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `INSERT INTO game_ships
              (id, game_id, owner_faction_id, name, ship_class,
               parent_body_id, orbit_rp, orbit_ra, orbit_omega,
               orbit_m0, orbit_epoch, orbit_direction,
               fuel, fuel_max, status, built_at_tick,
               hp, hp_max, damage_per_tick, icon_variant, parts_json, rank)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(shipId, gameId, b.faction_id, shipName, b.ship_class,
                b.body_id, rp, ra, tick, fuelMax, fuelMax, tick,
                spawnHp, hp, dmg, b.icon_variant ?? null,
                parts.length > 0 ? JSON.stringify(parts) : null,
                spawnRank),
        this.env.DB
          .prepare('DELETE FROM game_body_build_queue WHERE id = ?')
          .bind(b.id),
      ]);

      // ORDERS THAT SURVIVE THE BUILD (migration 0108). A hull finishing
      // at 4am used to park at its yard and wait for its owner to wake
      // up; this is the last of the three overnight gaps the player
      // named.
      //
      // Runs AFTER the batch above, so the ship row exists before
      // anything references it, and each branch is wrapped: a bad order
      // must cost you the order, never the hull or the tick.
      if (b.build_order) {
        try {
          if (b.build_order === 'go_to' && b.build_order_body_id) {
            // Same planner trade routes use, so a hull launched by a
            // build order carries a real launch plan -- which is what
            // makes it raidable in flight. A ship that could not be
            // intercepted would be a quiet exception to transit combat.
            await this.planLegForShip(
              gameId, tick, shipId, b.faction_id, b.body_id, b.build_order_body_id,
            );
          } else if (b.build_order === 'trade_route' && b.build_order_route_id) {
            // Every rule is re-checked HERE, not at queue time: a hull
            // ordered to join a convoy last night may roll out into a
            // route that has since been cancelled or filled its cap.
            // attachShipToRoute is the same gauntlet the ASSIGN
            // FREIGHTER button runs, so the two cannot disagree.
            //
            // The role comes from the CLASS, not the order: a freighter
            // signs on as a carrier, a warship as an escort. Nothing to
            // choose, so nothing to get wrong.
            const { attachShipToRoute } = await import('./tradeRoutesV2.js');
            const res = await attachShipToRoute(
              this.env, gameId, b.build_order_route_id, shipId, b.faction_id, tick,
            );
            if (!res.ok) {
              // A refused order costs the ORDER, never the hull: the
              // ship still exists, parked at its yard. But it must SAY
              // so -- the whole point of this feature is that you were
              // asleep, so a silent no-op is the one outcome that would
              // make it worse than not having it. DM rather than a new
              // chronicle kind, because trade already tells you this way
              // when a route stalls.
              try {
                const notify = await import('./notify.js');
                const owner = await this.env.DB
                  .prepare('SELECT user_id FROM game_factions WHERE id = ?')
                  .bind(b.faction_id).first();
                if (owner?.user_id) {
                  await notify.sendDm(this.env, {
                    userId: owner.user_id, gameId, category: 'economy',
                    dedupeKey: `bo_route_${shipId}`,
                    embed: {
                      title: '⚓ New ship could not join its route',
                      description: `${shipName} rolled out, but ${res.message}. `
                        + 'It is parked at its yard awaiting orders.',
                      color: 0xffca28,
                      footer: { text: `Orbital · T+${tick}` },
                    },
                  });
                }
              } catch (e) { console.error('build-order route DM failed', e, { shipId }); }
            }
          } else if (b.build_order === 'join_fleet' && b.build_order_fleet_id) {
            // REINFORCEMENT. Re-checked at spawn, not trusted from the
            // queue: the squadron this hull was built for may have been
            // wiped out overnight, which is precisely when the order is
            // most likely to be standing.
            const fl = await this.env.DB
              .prepare('SELECT id FROM game_fleets WHERE id = ? AND game_id = ? AND faction_id = ?')
              .bind(b.build_order_fleet_id, gameId, b.faction_id).first();
            if (fl) {
              // ONE CAPTAIN PER FLEET. Members surrender theirs to the
              // bank on joining — the flag's is the fleet's only
              // officer. Skipping this would mint a second officer in a
              // fleet by the back door, which every other join path
              // forbids.
              await this.env.DB.batch([
                this.env.DB.prepare('UPDATE game_captains SET ship_id = NULL WHERE game_id = ? AND ship_id = ?')
                  .bind(gameId, shipId),
                this.env.DB.prepare('UPDATE game_ships SET fleet_id = ?, captain_id = NULL WHERE id = ?')
                  .bind(b.build_order_fleet_id, shipId),
              ]);
            }
          } else if (b.build_order === 'defensive' || b.build_order === 'hold') {
            await this.env.DB
              .prepare('UPDATE game_ships SET stance = ? WHERE id = ?')
              .bind(b.build_order, shipId).run();
          }
        } catch (e) {
          console.error('build order failed for ship', shipId, b.build_order, e);
        }
      }

      // Chronicle the completion. Playtester reported the log was
      // mostly silent — they didn't know when a queued ship had
      // actually rolled out of the yard.
      try {
        const body = await this.env.DB
          .prepare('SELECT name FROM game_bodies WHERE id = ?')
          .bind(b.body_id).first();
        const fac = await this.env.DB
          .prepare('SELECT name FROM game_factions WHERE id = ?')
          .bind(b.faction_id).first();
        const payload = JSON.stringify({
          ship_id: shipId,
          ship_name: shipName,
          ship_class: b.ship_class,
          body_name: body?.name ?? null,
          owner_faction_name: fac?.name ?? null,
        });
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'ship_built', ?, ?, ?, ?, 'public', ?)`,
          )
          .bind(`c_${shipId}`, gameId, tick, b.faction_id, b.body_id, shipId, payload, Date.now())
          .run();
      } catch (e) {
        console.error('ship_built chronicle insert failed', e);
      }
     } catch (rowErr) {
       // This one build failed to complete — log and move on. The row
       // stays 'building' and will be retried next tick; the rest of the
       // pass (including promotion below) still runs.
       console.error('build completion failed for row', b?.id, rowErr);
     }
    }

    // 1b. Promote waiting builds into freed slots — FIFO per
    //     body+faction (queued_at_tick, then id which embeds a
    //     Date.now() base36 stamp so same-tick orders keep creation
    //     order). Concurrency = 1 base slot + 1 per Shipyard level on
    //     the faction's live stations at the body, mirroring the count
    //     in worker/actions.js handleQueueBuild. Resources were already
    //     charged at queue time, so promotion only stamps the schedule:
    //     started_at_tick = now, completes_at_tick = now + build_ticks
    //     (falling back to the class table for rows queued before the
    //     column existed).
    try {
      const BUILD_TICKS_BY_CLASS = { corvette: 10, frigate: 20, destroyer: 40, freighter: 15 };
      const waiting = (await this.env.DB
        .prepare(
          `SELECT id, body_id, faction_id, ship_class, build_ticks
             FROM game_body_build_queue
            WHERE game_id = ? AND cancelled_at_tick IS NULL AND status = 'waiting'
            ORDER BY queued_at_tick ASC, id ASC`,
        )
        .bind(gameId)
        .all()).results ?? [];
      if (waiting.length > 0) {
        // Group FIFO lists per body+faction ('|' can't appear in ids).
        const groups = new Map();
        for (const w of waiting) {
          const key = `${w.body_id}|${w.faction_id}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(w);
        }
        const promotions = [];
        for (const [key, rows] of groups) {
          const [bodyId, factionId] = key.split('|');
          const yardRows = (await this.env.DB
            .prepare(
              `SELECT buildings_json FROM game_settlements
                WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
                  AND type = 'station' AND destroyed_at_tick IS NULL`,
            )
            .bind(gameId, bodyId, factionId)
            .all()).results ?? [];
          let shipyardLevels = 0;
          for (const row of yardRows) {
            if (!row.buildings_json) continue;
            try {
              const b = JSON.parse(row.buildings_json) || {};
              shipyardLevels += Number(b.shipyard ?? 0) || 0;
            } catch { /* ignore malformed */ }
          }
          // Same total the queue endpoint used when it accepted these
          // orders. If the promoter counted only ground yards, a
          // foundry's extra slots would be honoured at queue time and
          // then quietly ignored forever after.
          const slots = 1 + shipyardLevels
            + await foundrySlotsAt(this.env, gameId, bodyId, factionId);
          const active = await this.env.DB
            .prepare(
              `SELECT COUNT(*) AS c FROM game_body_build_queue
                WHERE game_id = ? AND body_id = ? AND faction_id = ?
                  AND cancelled_at_tick IS NULL AND status = 'building'`,
            )
            .bind(gameId, bodyId, factionId)
            .first();
          let free = slots - Number(active?.c ?? 0);
          for (const w of rows) {
            if (free <= 0) break;
            const bt = Number(w.build_ticks) > 0
              ? Number(w.build_ticks)
              : (BUILD_TICKS_BY_CLASS[w.ship_class] ?? 20);
            promotions.push(
              this.env.DB
                .prepare(
                  `UPDATE game_body_build_queue
                      SET status = 'building', started_at_tick = ?, completes_at_tick = ?
                    WHERE id = ? AND status = 'waiting' AND cancelled_at_tick IS NULL`,
                )
                .bind(tick, tick + bt, w.id),
            );
            free -= 1;
          }
        }
        if (promotions.length > 0) await this.env.DB.batch(promotions);
      }
    } catch (e) {
      console.error('build promotion pass failed', e);
    }

    // 1c. Pending refits (DESIGN-fleet-economy §2). Ships stamped with
    //     refit_pending_design_id by the refit-fleet endpoint catch up
    //     here: whenever such a hull is PARKED (no committed/in-transit
    //     node) at a body where its owner holds a living settlement, and
    //     the owner's pool covers the fee (half the added parts'
    //     escalated price, computed against the design's CURRENT parts —
    //     later template edits are honored, not the snapshot at stamp
    //     time), the loadout applies and the marker clears. Unaffordable
    //     hulls stay pending and simply retry next tick; a deleted
    //     design clears the marker as a no-op.
    try {
      const pendingRefits = (await this.env.DB
        .prepare(
          `SELECT s.id, s.owner_faction_id, s.ship_class, s.parent_body_id,
                  s.hp, s.hp_max, s.parts_json, s.refit_pending_design_id,
                  d.parts_json AS design_parts_json, d.ship_class AS design_class
             FROM game_ships s
             LEFT JOIN game_ship_designs d ON d.id = s.refit_pending_design_id
            WHERE s.game_id = ? AND s.status = 'active'
              AND s.refit_pending_design_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM game_ship_nodes n
                 WHERE n.ship_id = s.id AND n.status IN ('committed', 'in_transit')
              )
              AND EXISTS (
                SELECT 1 FROM game_settlements st
                 WHERE st.game_id = s.game_id AND st.body_id = s.parent_body_id
                   AND st.owner_faction_id = s.owner_faction_id
                   AND st.destroyed_at_tick IS NULL
              )
            ORDER BY s.id ASC`,
        )
        .bind(gameId)
        .all()).results ?? [];
      if (pendingRefits.length > 0) {
        // Per-faction running pool so a squadron refitting at once can't
        // collectively overdraw. Tech per faction for the stat rebake.
        const poolCache = new Map();
        const refitTech = new Map();
        for (const s of pendingRefits) {
          // Design deleted (LEFT JOIN miss) or class mismatch → the
          // refit can never apply; clear the marker. A bare-hull design
          // (parts_json NULL) is a legitimate refit target.
          if (s.design_class == null || s.design_class !== s.ship_class) {
            await this.env.DB
              .prepare('UPDATE game_ships SET refit_pending_design_id = NULL WHERE id = ?')
              .bind(s.id).run();
            continue;
          }
          const newParts = parsePartsJson(s.ship_class, s.design_parts_json);
          const curParts = parsePartsJson(s.ship_class, s.parts_json);
          const same = [...newParts].sort().join(',') === [...curParts].sort().join(',');
          const fee = same ? { metal: 0, gold: 0 } : refitFee(curParts, newParts);
          let pool = poolCache.get(s.owner_faction_id);
          if (!pool) {
            const row = await this.env.DB
              .prepare('SELECT metal, gold FROM game_factions WHERE id = ?')
              .bind(s.owner_faction_id).first();
            pool = { metal: Number(row?.metal ?? 0), gold: Number(row?.gold ?? 0) };
            poolCache.set(s.owner_faction_id, pool);
          }
          if (fee.metal > pool.metal || fee.gold > pool.gold) continue; // retry next tick
          let tech = refitTech.get(s.owner_faction_id);
          if (!tech) {
            const rows = (await this.env.DB
              .prepare(
                `SELECT tech_id, level FROM faction_techs
                  WHERE game_id = ? AND faction_id = ?
                    AND tech_id IN ('weapons', 'energy_weapons', 'armor', 'shields')`,
              )
              .bind(gameId, s.owner_faction_id)
              .all()).results ?? [];
            tech = Object.fromEntries(rows.map(r => [r.tech_id, r.level ?? 0]));
            refitTech.set(s.owner_faction_id, tech);
          }
          const stats = computeShipStats(s.ship_class, newParts, tech);
          const oldBase = Number(s.hp_max ?? 0) > 0 ? Number(s.hp_max) : stats.hp;
          const hpScale = stats.hp / oldBase;
          const stmts = [
            this.env.DB
              .prepare(
                `UPDATE game_ships
                    SET parts_json = ?, hp_max = ?, hp = MIN(hp * ?, ?),
                        damage_per_tick = ?, refit_pending_design_id = NULL
                  WHERE id = ?`,
              )
              .bind(newParts.length > 0 ? JSON.stringify(newParts) : null,
                    stats.hp, hpScale, stats.hp, stats.damage_per_tick, s.id),
          ];
          if (fee.metal > 0 || fee.gold > 0) {
            stmts.push(this.env.DB
              .prepare(
                `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
                  WHERE id = ? AND metal >= ? AND gold >= ?`,
              )
              .bind(fee.metal, fee.gold, s.owner_faction_id, fee.metal, fee.gold));
          }
          await this.env.DB.batch(stmts);
          pool.metal -= fee.metal;
          pool.gold -= fee.gold;
        }
      }
    } catch (e) {
      console.error('pending refit pass failed (non-fatal)', e);
    }

    // 2a. Depart. A committed node whose scheduled_t has come up: stamp
    //     committed_at_tick (in case it was force-fired without explicit
    //     commit) and compute the Hohmann arrival tick. The SHIP STAYS
    //     AT THE DEPARTURE BODY until 2b fires — that keeps the canvas
    //     animating the in-flight ship along its bezier arc instead of
    //     teleporting on burn.
    // arrival_at_tick is now populated at intent-recording time by
    // handleCommitTransfer (client supplies it). The join against
    // game_bodies orbit_radius columns is kept around in case some
    // legacy row needs the fallback derive, but the alarm doesn't
    // use those values anymore.
    const departures = (await this.env.DB
      .prepare(
        `SELECT n.id, n.ship_id, n.target_body_id, n.scheduled_t,
                n.arrival_at_tick,
                s.parent_body_id AS dep_body_id
           FROM game_ship_nodes n
           JOIN game_ships s ON s.id = n.ship_id
          WHERE n.game_id = ?
            AND n.status = 'committed'
            AND n.scheduled_t <= ?
            AND n.target_body_id IS NOT NULL
          ORDER BY n.scheduled_t ASC`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    for (const d of departures) {
      // arrival_at_tick is set at intent-recording time by
      // handleCommitTransfer (the client posts a precomputed value
      // derived from plain distance/SHIP_SPEED). Trust it. We used
      // to derive it here via Hohmann t = π√(a³/μ), but that gave
      // 400+ ticks for moon transfers because the formula scales
      // with parent μ — a 5-unit hop between two Jovian moons used
      // μ_sun and inflated the time wildly. Distance/speed is now
      // the single source of truth.
      //
      // The Math.ceil + max guard ensures we never write a value
      // that's already passed (would leave the ship stuck in_transit
      // with no arrival).
      const fallback = Math.ceil(d.scheduled_t + 30); // legacy: old clients without arrival_t
      const arrivalAtTick = Math.max(
        tick + 1,
        Math.ceil(d.arrival_at_tick != null ? d.arrival_at_tick : fallback),
      );
      await this.env.DB
        .prepare(
          `UPDATE game_ship_nodes
              SET status = 'in_transit',
                  arrival_at_tick = ?
            WHERE id = ?`,
        )
        .bind(arrivalAtTick, d.id)
        .run();
    }

    // 2b. Arrive. An in_transit node whose arrival_at_tick has come up:
    //     warp the ship to a circular orbit around target_body_id, mark
    //     the node executed.
    const arrivals = (await this.env.DB
      .prepare(
        `SELECT id, ship_id, target_body_id, arrival_at_tick
           FROM game_ship_nodes
          WHERE game_id = ?
            AND status = 'in_transit'
            AND arrival_at_tick IS NOT NULL
            AND arrival_at_tick <= ?`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    // Gravity Sinks grab first, so a hull pinned this tick does not also
    // land this tick. Non-throwing: a sink failure must not strand every
    // arrival in the game.
    try {
      await this.resolveGravitySinks(gameId, tick);
    } catch (e) {
      console.error('resolveGravitySinks failed', e);
    }

    for (const n of arrivals) {
      if (!n.target_body_id) continue;
      // Re-read: a sink may have pushed this arrival into the future
      // between the SELECT above and here.
      const stillDue = await this.env.DB
        .prepare('SELECT arrival_at_tick FROM game_ship_nodes WHERE id = ?')
        .bind(n.id).first();
      if (stillDue && Number(stillDue.arrival_at_tick) > tick) continue;
      const target = await this.env.DB
        .prepare('SELECT radius FROM game_bodies WHERE id = ?')
        .bind(n.target_body_id)
        .first();
      if (!target) continue;
      // Tight park orbit on arrival — parkOrbitRadius (factions.js) is the
      // one definition; the build-spawn pass above and the client's
      // optimistic park both call it.
      const rp = parkOrbitRadius(target.radius);
      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `UPDATE game_ships
                SET parent_body_id = ?,
                    orbit_rp = ?, orbit_ra = ?, orbit_omega = 0,
                    orbit_m0 = ?, orbit_epoch = ?, orbit_direction = 1
              WHERE id = ?`,
          )
          .bind(n.target_body_id, rp, rp, parkPhaseFor(n.ship_id), tick, n.ship_id),
        this.env.DB
          .prepare("UPDATE game_ship_nodes SET status = 'executed', executed_at_tick = ? WHERE id = ?")
          .bind(tick, n.id),
      ]);

      // Ad-hoc pickup: a freighter arriving at an owned body does a
      // ONE-SHOT vacuum of every owned-settlement stockpile here, up
      // to CARGO_CAP per resource type. Fires regardless of whether
      // the ship is on a trade route — the trade-route pickup block
      // further down handles routed freighters separately, but this
      // covers the "just sent the Pella to grab the Pluto stockpile"
      // case the playtester wants. Pickup is one-shot per arrival
      // because the loop runs once per status='in_transit' node; a
      // parked freighter doesn't passive-drip.
      try {
        const ship = await this.env.DB
          .prepare(`SELECT s.ship_class, s.owner_faction_id, c.traits_json AS captain_traits
                      FROM game_ships s LEFT JOIN game_captains c ON c.id = s.captain_id
                     WHERE s.id = ? AND s.status = ?`)
          .bind(n.ship_id, 'active')
          .first();
        if (ship && ship.ship_class === 'freighter') {
          // Skip ANY freighter on an active trade route — the route
          // state machine below owns pickup/delivery for routed ships
          // end-to-end. The old guard only skipped routed ships that
          // were ALREADY carrying cargo, so a freighter RETURNING to
          // its origin (cargo=0) got ad-hoc-vacuumed and its haul
          // stashed into the route's cargo columns; next tick the
          // route machine saw cargo>0 at origin (PICKUP wants cargo=0,
          // DELIVERY wants dest) and none of its branches could move
          // the ship — the route deadlocked on its first return leg
          // with up to 500/resource frozen in cargo. Gating on route
          // membership (not cargo) hands routed freighters exclusively
          // to the state machine; manual freighters (no route) still
          // get ad-hoc pickup.
          const onActiveRoute = await this.env.DB
            .prepare(
              `SELECT 1 AS x FROM game_trade_routes
                 WHERE ship_id = ? AND cancelled_at_tick IS NULL
                 LIMIT 1`,
            )
            .bind(n.ship_id).first();
          if (!onActiveRoute) {
            // Quartermaster captain (spec §3): +25% hold.
            // CARGO_CAP, not a literal. This said 500 by hand, so
            // retuning the hold would have moved mining and left
            // hauling behind — two different answers to "how big is a
            // freighter" in one tick.
            const PICKUP_CAP = holdCapFor(ship.captain_traits);
            const stocks = (await this.env.DB
              .prepare(
                `SELECT id, stockpile_fuel, stockpile_metal, stockpile_gold, stockpile_science
                   FROM game_settlements
                  WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
                    AND destroyed_at_tick IS NULL`,
              )
              .bind(gameId, n.target_body_id, ship.owner_faction_id)
              .all()).results ?? [];
            let cf = 0, cm = 0, cg = 0, csci = 0;
            for (const s of stocks) {
              const take = {
                f:  Math.min(PICKUP_CAP - cf,   Number(s.stockpile_fuel    ?? 0)),
                m:  Math.min(PICKUP_CAP - cm,   Number(s.stockpile_metal   ?? 0)),
                g:  Math.min(PICKUP_CAP - cg,   Number(s.stockpile_gold    ?? 0)),
                sc: Math.min(PICKUP_CAP - csci, Number(s.stockpile_science ?? 0)),
              };
              if (take.f + take.m + take.g + take.sc <= 0) continue;
              cf += take.f; cm += take.m; cg += take.g; csci += take.sc;
              await this.env.DB
                .prepare(
                  `UPDATE game_settlements
                      SET stockpile_fuel    = stockpile_fuel    - ?,
                          stockpile_metal   = stockpile_metal   - ?,
                          stockpile_gold    = stockpile_gold    - ?,
                          stockpile_science = stockpile_science - ?
                    WHERE id = ?`,
                )
                .bind(take.f, take.m, take.g, take.sc, s.id)
                .run();
              if (cf >= PICKUP_CAP && cm >= PICKUP_CAP && cg >= PICKUP_CAP && csci >= PICKUP_CAP) break;
            }
            // We're only here for freighters with NO active route (the
            // guard above excluded routed ships), so this is manual
            // logistics: hand the pickup straight to the faction pool.
            // Do NOT stash into any trade_routes row — a cancelled
            // route row would swallow the cargo permanently.
            if (cf + cm + cg + csci > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET fuel    = fuel    + ?, metal   = metal   + ?,
                          gold    = gold    + ?, science = science + ?
                    WHERE id = ?`,
                )
                .bind(cf, cm, cg, csci, ship.owner_faction_id).run();
            }
          }
        }
      } catch (e) {
        console.error('ad-hoc freighter pickup failed (non-fatal)', e);
      }
    }

    // 2c-arrive. SCHEDULED DETONATION.
    //
    // The manual endpoint refuses a detonation mid-transfer ("wait for
    // arrival"), so a strike can only be fired on the exact tick a hull
    // lands -- routinely 4am at an hour a tick. This pass makes that
    // decision in advance instead.
    //
    // PLACED HERE ON PURPOSE: after 2b arrivals, well before the combat
    // pass. A strike that resolved after combat would eat the defenders'
    // volley first and could die before it fired. Arriving and detonating
    // in the same tick, ahead of return fire, is the whole point. Note the
    // dead-man trigger (3.49) sits deliberately AFTER combat -- it means
    // "they shot me down, take them with me", which is the opposite case.
    //
    // The guard is a GUARD, not an escape: the burn still landed and the
    // hull is still sitting in hostile space either way. Only the
    // self-destruct is conditional, which keeps "a committed burn cannot
    // be re-aimed" intact.
    try {
      const arrivedIds = [...new Set((arrivals ?? []).map(a => a.ship_id))];
      if (arrivedIds.length > 0) {
        const marks = arrivedIds.map(() => '?').join(',');
        const armed = (await this.env.DB
          .prepare(
            `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.parent_body_id,
                    s.hp, s.hp_max, s.parts_json, s.arrival_guard, s.arrival_action
               FROM game_ships s
              WHERE s.game_id = ? AND s.status = 'active'
                AND s.arrival_action IS NOT NULL
                AND s.id IN (${marks})`,
          )
          .bind(gameId, ...arrivedIds).all()).results ?? [];

        for (const ship of armed) {
          const fire = await this.hostileGuardHolds(gameId, tick, ship, ship.arrival_guard);
          // ONE-SHOT EITHER WAY. Cleared before firing so a hull that
          // survives (guard failed) is not left silently armed for its
          // next arrival -- an order the player set for one strike must
          // not quietly follow them around the map.
          await this.env.DB
            .prepare('UPDATE game_ships SET arrival_action = NULL, arrival_guard = NULL WHERE id = ?')
            .bind(ship.id).run();
          if (ship.arrival_action === 'detonate') {
            if (fire) await this.detonateShip(gameId, tick, ship);
          } else if (fire) {
            // STANCE ON ARRIVAL. Set before the combat pass reads it, so
            // the posture applies to the first volley rather than the
            // second. A guarded stance order is legitimate too: "arrive
            // defensive IF something hostile is here, otherwise carry on
            // as you were" is a sane thing to want.
            const posture = ship.arrival_action === 'arrive_hold' ? 'hold' : 'defensive';
            await this.env.DB
              .prepare('UPDATE game_ships SET stance = ? WHERE id = ?')
              .bind(posture, ship.id).run();
          }
        }
      }
    } catch (e) {
      console.error('scheduled detonation pass failed', e);
    }

    // 2c-timer. SCHEDULED DEMOLITION.
    //
    // The same charge, on a clock instead of a doorstep. Where the
    // arrival strike answers "blow up when you get there", this answers
    // "blow up at T+412" -- which is what you want for a mine left in a
    // lane, or for several hulls timed to go off together.
    //
    // SAME PLACEMENT, SAME REASON as 2c-arrive: after arrivals, before
    // combat. A demolition that resolved after the combat pass would eat
    // the defenders' volley first and could die with the charge unspent.
    //
    // <= tick, not === tick. A game that was paused, or a worker that
    // missed an alarm, must still fire the charge on the next tick it
    // runs rather than stepping silently past the appointment and
    // leaving a hull armed forever.
    try {
      const due = (await this.env.DB
        .prepare(
          `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.parent_body_id,
                  s.hp, s.hp_max, s.parts_json, s.detonate_at_guard
             FROM game_ships s
            WHERE s.game_id = ? AND s.status = 'active'
              AND s.detonate_at_tick IS NOT NULL
              AND s.detonate_at_tick <= ?`,
        )
        .bind(gameId, tick).all()).results ?? [];

      for (const ship of due) {
        const fire = await this.hostileGuardHolds(gameId, tick, ship, ship.detonate_at_guard);
        // ONE-SHOT EITHER WAY, cleared before firing. A hull whose guard
        // failed must not stay armed for a timer that has already
        // passed -- it would then detonate on the very next tick, which
        // is the opposite of what a guard is for.
        await this.env.DB
          .prepare('UPDATE game_ships SET detonate_at_tick = NULL, detonate_at_guard = NULL WHERE id = ?')
          .bind(ship.id).run();
        if (fire) await this.detonateShip(gameId, tick, ship);
      }
    } catch (e) {
      console.error('scheduled demolition pass failed', e);
    }

    // 2c-watch. PROXIMITY MINE.
    //
    // The same charge again, but WATCHING instead of firing at a moment:
    // park a hull somewhere that matters, arm it, and the first armed
    // hostile to share the orbit sets it off.
    //
    // NOT ONE-SHOT, which is the whole difference from the other two.
    // They clear themselves whether or not the guard held, because an
    // appointment that has passed must not linger. A mine has to survive
    // every tick the guard does not hold -- that is every tick until the
    // one that matters -- so it is cleared only by firing or by the
    // player disarming it.
    //
    // IN-TRANSIT HULLS ARE EXCLUDED. A ship stays parked at its
    // DEPARTURE body until 2b fires it (see the note in 2a), so a mined
    // hull in flight would keep evaluating against an orbit it has
    // already left and blow up over the wrong rock. The manual detonate
    // endpoint refuses mid-transfer for the same reason.
    //
    // Placed with the other two -- after arrivals, before combat -- so a
    // hostile that lands this tick trips the mine before it can shoot.
    // That is the point of a mine.
    try {
      const mined = (await this.env.DB
        .prepare(
          `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.parent_body_id,
                  s.hp, s.hp_max, s.parts_json, s.detonate_mine_mode
             FROM game_ships s
            WHERE s.game_id = ? AND s.status = 'active'
              AND s.detonate_on_hostile = 1
              AND NOT EXISTS (
                SELECT 1 FROM game_ship_nodes n
                 WHERE n.ship_id = s.id AND n.status = 'in_transit'
              )`,
        )
        .bind(gameId).all()).results ?? [];

      for (const ship of mined) {
        // NULL mode = 'hostile', so every charge armed under 0111 keeps
        // firing on exactly the condition it was armed with.
        const mode = ship.detonate_mine_mode || 'hostile';
        // Each condition is asked ONLY when it can change the answer:
        // 'no_friendly' never looks for hostiles, and 'hostile' never
        // counts friends. Both queries hit peacePairs, and this pass
        // runs every tick for every mined hull.
        let fire;
        if (mode === 'no_friendly') {
          fire = !(await this.friendlyInOrbit(gameId, tick, ship));
        } else if (mode === 'hostile_no_friendly') {
          fire = await this.hostileGuardHolds(gameId, tick, ship, 'hostile_in_orbit')
            && !(await this.friendlyInOrbit(gameId, tick, ship));
        } else {
          fire = await this.hostileGuardHolds(gameId, tick, ship, 'hostile_in_orbit');
        }
        if (!fire) continue;
        await this.env.DB
          .prepare('UPDATE game_ships SET detonate_on_hostile = 0, detonate_mine_mode = NULL WHERE id = ?')
          .bind(ship.id).run();
        await this.detonateShip(gameId, tick, ship);
      }
    } catch (e) {
      console.error('proximity mine pass failed', e);
    }

    // 2d. Body secret reveal + persistent portal warp.
    //
    // Mirrors src/game/secrets.ts + the client gameContext.tsx reveal
    // loop. A body with secret_kind != null AND secret_revealed = 0
    // fires its effect the first tick any active ship parks there.
    // portal_to_sun additionally keeps warping every subsequent ship
    // back to Sol forever (so the portal stays a strategic hazard,
    // not just a one-time reveal).
    //
    // Effects:
    //   portal_to_sun     warp all parked ships at this body to Sol
    //                     (a +18 circular orbit around the star).
    //   ancient_city      free city for the discoverer + Lab L2 baked
    //                     in via has_collector NULL and population 3.
    //   free_collector    free city with has_collector = 1.
    //   derelict_warship  free destroyer spawned at the body.
    //   resource_cache    +500 metal +500 gold to discoverer's pool.
    //   ancient_databank  bump a random tech track by +1 for discoverer.
    try {
      await this.resolveSecretReveal(gameId, tick);
    } catch (e) {
      console.error('resolveSecretReveal failed', e);
    }

    // 2d-bis. Finished MOBILE sites become hulls. Non-throwing: a
    // launch failure must not take the rest of the tick with it.
    try {
      await this.launchCompletedMobileSites(gameId, tick);
    } catch (e) {
      console.error('launchCompletedMobileSites failed', e);
    }

    // 2d-ter. Mega Destroyer strikes that finished charging.
    try {
      await this.resolveMegaStrikes(gameId, tick);
    } catch (e) {
      console.error('resolveMegaStrikes failed', e);
    }

    // 2d-quater. Structures under siege: hostile hulls holding the orbit
    // break them down, and they repair when nobody is.
    try {
      await this.resolveMegastructureSiege(gameId, tick);
    } catch (e) {
      console.error('resolveMegastructureSiege failed', e);
    }

    // 2d-quinquies. Gate links whose construction pact has ended — or
    // whose far end changed hands. A door nobody agreed to leave open.
    try {
      await this.snapUnauthorisedGateLinks(gameId, tick);
    } catch (e) {
      console.error('snapUnauthorisedGateLinks failed', e);
    }

    // 2d-sexies. Asset deals whose subject has been scrapped or lost.
    try {
      await this.sweepAssetDeals(gameId, tick);
    } catch (e) {
      console.error('sweepAssetDeals failed', e);
    }

    // 2d-septies. Anything that finished building this tick.
    try {
      await this.chronicleCompletions(gameId, tick);
    } catch (e) {
      console.error('chronicleCompletions failed', e);
    }

    // 2d-septies. Structures whose owner has been eliminated go derelict
    // rather than fighting on for a dead empire.
    try {
      await this.abandonDeadFactionStructures(gameId, tick);
    } catch (e) {
      console.error('abandonDeadFactionStructures failed', e);
    }

    // 2c-pre. Asteroid-weapon impacts.
    //
    // Bodies with ram_target_body_id != NULL and ram_arrive_tick <= tick
    // are arriving this step. Apply the impact effects (settlements
    // wiped, yields halved, asteroid destroyed) atomically per body.
    try {
      await this.resolveAsteroidImpacts(gameId, tick);
    } catch (e) {
      console.error('resolveAsteroidImpacts failed', e);
    }

    // 2b-bis. Senate phase advance. Idempotent + non-throwing -- a
    //         senate-side failure must not kill combat/dyson/economy
    //         that follow. Runs BEFORE combat so a ratified
    //         combat_damage_multiplier applies on the same tick.
    try {
      await resolveSenate(this.env, gameId, tick);
    } catch (e) {
      console.error('resolveSenate failed', e);
    }

    // Interrupt-grade notifications (combat, arrears, closing votes).
    // AFTER senate so a bill that just opened can already warn the
    // players who haven't voted. Isolated: an alert failing must never
    // cost a player their tick.
    try {
      const alerts = await import('./alerts.js');
      await alerts.runTickAlerts(this.env, gameId, tick);
    } catch (e) {
      console.error('runTickAlerts failed', e);
    }

    // Battle posters for any fight big enough to be news. Channel-level,
    // and isolated like everything else that talks to Discord.
    try {
      const battles = await import('./battleCard.js');
      await battles.publishBattles(this.env, gameId, tick);
    } catch (e) {
      console.error('publishBattles failed', e);
    }

    // Senate effects active this tick. Cached in a closure local so
    // every downstream consumer reads the same snapshot without
    // hammering D1 once per attacker. Falls through to slider defaults
    // (1.0 multipliers, 0% tariff) on any error.
    // Science reaching each faction's POOL this tick — the research drain
    // (§ further down) advances a project at the faction's ACTUAL income
    // rate, so a big science economy researches faster.
    //
    // Declared THIS early (above the trade-route pass) because science
    // arrives from two places: settlement yield in the harvest pass AND
    // freighter trade deliveries, which run earlier in the tick. When
    // this lived next to the harvest pass, deliveries had nowhere to
    // register and the drain's `min(pool, income, remaining)` clamp saw
    // income=0 — a faction whose science came only from trade routes
    // banked it forever and never advanced a tech (playtest report:
    // "science dropped off by trade route does not apply to the
    // currently researching tech"). Contributions are ADDITIVE from both
    // sources. Empty on a harvest failure → research simply pauses.
    const scienceIncomeByFaction = new Map();

    // Slider laws for this tick. ONE query, then O(1) per faction —
    // slider laws can now name a target, so "the" effective value is no
    // longer a single number for the whole match: it depends on who is
    // being charged. sliderFor(factionId) layers any law aimed at that
    // faction over the general law.
    //
    // sliderFor(null) is the general law, used where no faction is in
    // scope. That is the old behaviour exactly, so any site not yet
    // faction-aware keeps working and simply ignores targeting.
    let sliderFor = () => ({});
    try { sliderFor = await getSliderResolver(this.env, gameId, tick); }
    catch (e) { console.error('getSliderResolver failed', e); }
    // Per-faction accessors. Each is a function now, not a scalar: a
    // captured constant here would silently re-globalize the law.
    const combatDamageMultOf = (fid) => Number(sliderFor(fid).combat_damage_multiplier ?? 1);
    // Senate yield sliders, applied to every settlement at distribution
    // time. The fuel one is kept ONLY so a law passed before fuel was
    // retired still resolves instead of throwing; nothing spends fuel any
    // more. Metal, credits and science are the live levers.
    const fuelYieldMultOf = (fid) => Number(sliderFor(fid).fuel_yield_multiplier ?? 1);
    const metalYieldMultOf = (fid) => Number(sliderFor(fid).metal_yield_multiplier ?? 1);
    const goldYieldMultOf = (fid) => Number(sliderFor(fid).gold_yield_multiplier ?? 1);
    const scienceYieldMultOf = (fid) => Number(sliderFor(fid).science_yield_multiplier ?? 1);

    // Senate sanction cache for this tick. Used by trade routes
    // (trade_embargo), combat damage (war_authorization), and body
    // harvest (production_sanction). One D1 query per faction per
    // sanction kind, memoised so a hostile fleet hitting the same target
    // 200 times this tick still pays only one DB hit for that target.
    const sanctionCache = new Map();
    const sanctioned = async (factionId, kind) => {
      if (!factionId) return false;
      const key = `${factionId}|${kind}`;
      if (sanctionCache.has(key)) return sanctionCache.get(key);
      const v = await hasActiveSanction(this.env, gameId, tick, factionId, kind);
      sanctionCache.set(key, v);
      return v;
    };

    // 2c. Trade route auto-pilot.
    //
    // For each active route, look at the freighter. Skip if it has any
    // in_transit OR committed node currently — the alarm's depart/arrive
    // passes (2a/2b) already drive that ship; don't double-schedule.
    //
    //   - At origin with empty hold  → pick up from origin settlement
    //                                   stockpile (up to CARGO_CAP per
    //                                   resource), insert committed
    //                                   node toward dest. Status →
    //                                   'outbound'.
    //   - At dest with non-empty hold → dump cargo into faction pool,
    //                                   clear cargo, insert committed
    //                                   node back to origin. Status →
    //                                   'returning'.
    //   - Off-course / paused        → no-op (player can manually fly
    //                                   back; route picks up next time
    //                                   they land at an endpoint).
    //
    // arrival_at_tick uses a flat 60-tick placeholder per leg. The
    // existing scheduled_t/arrival_at_tick path in 2a/2b is the single
    // source of truth for "ship is in transit" so we don't need to
    // re-implement the Bezier model.
    await this.runTradeAutopilot(gameId, tick, CFG, sanctioned, scienceIncomeByFaction);

    // 3. Combat. Find bodies where 2+ factions have ships. Each ship's
    //    damage_per_tick is split evenly across hostile ships at the same
    //    body. Ships at hp<=0 are marked destroyed.
    //
    //    Hostility is now treaty-aware: an active NAP (non-aggression pact)
    //    or defense_pact between two factions suppresses damage between
    //    them. An "active" treaty has status='active', broken_at_tick IS
    //    NULL, and (expires_at_tick IS NULL OR expires_at_tick > tick),
    //    with BOTH sides as signed signatories.
    // Pull rank + combat_history alongside the live stats so we can
    // (1) multiply each attacker's damage by 1 + 0.01*rank, and
    // (2) append a kill record + bump rank when a hull lands the
    // killing blow on another ship. Class + name are needed for the
    // history record itself (target's class/name at moment of death).
    // Rank now lives on the CAPTAIN (spec §2): COALESCE falls back to the
    // ship's legacy column only for hulls the backfill pass hasn't reached
    // yet (it runs first, so in practice never after one tick).
    const allShips = (await this.env.DB
      .prepare(
        `SELECT s.id, s.owner_faction_id, s.parent_body_id, s.hp, s.hp_max, s.damage_per_tick,
                -- Orbital elements, so the transit pass can place a PARKED
                -- hull on its park orbit rather than at the body's centre.
                -- Without these the position silently reads undefined and
                -- every parked ship collapses to the origin.
                s.orbit_rp, s.orbit_ra, s.orbit_omega, s.orbit_m0,
                s.orbit_epoch, s.orbit_direction,
                -- Veterancy is CAPTAIN-ONLY. This used to COALESCE onto
                -- s.rank, which resurrected a hull's legacy record the
                -- moment its captain was unassigned. An uncrewed hull is
                -- rank 0, full stop.
                COALESCE(c.rank, 0) AS rank, s.ship_class, s.name, s.last_combat_tick,
                s.stance, s.retreat_hp_pct, s.detonate_hp_pct, s.parts_json,
                s.target_priority, s.last_target_id,
                s.captain_id, s.fleet_id, c.traits_json AS captain_traits, c.name AS captain_name
           FROM game_ships s
           LEFT JOIN game_captains c ON c.id = s.captain_id
          WHERE s.game_id = ? AND s.status = 'active'`,
      )
      .bind(gameId)
      .all()).results ?? [];

    // Parse each ship's loadout ONCE (parts_json -> validated ids,
    // legacy weapon->kinetic aliased) and cache on the row as `_parts`,
    // so the per-target damage loops below can read damage type +
    // shield/armor counts without re-parsing JSON per pairing.
    for (const s of allShips) {
      s._parts = parsePartsJson(s.ship_class, s.parts_json);
      // Captain traits (spec §3) — small multiplicative modifiers.
      s._traits = parseTraits(s.captain_traits);
      // Player-set target priority (migration 0064). NULL/bad JSON = auto.
      // The API validated the permutation on write; a defensive re-check
      // here means a hand-edited row degrades to auto instead of throwing
      // mid-tick.
      s._targetPriority = null;
      if (s.target_priority) {
        try {
          const p = JSON.parse(s.target_priority);
          if (Array.isArray(p) && p.length > 0 && p.every(k => typeof k === 'string')) {
            s._targetPriority = p;
          }
        } catch { /* auto */ }
      }
    }

    // (The old per-ship cadence gate lived here. COMBAT V2 fires every tick
    // and rolls to hit instead — see the block below. src/game/combat.ts still
    // carries AUTO_COMBAT_INTERVAL for the frozen single-player sim, which is
    // now deliberately a different game.)
    // --- Flag-trait aura (DESIGN-fleets.md P2) ---
    // Members of a LED fleet get the flag captain's trait at HALF
    // strength — 1 + (mul-1)/2 — stacking with their own captain's
    // full trait. The flagship is excluded: its captain already
    // applies at full strength via _traits, and an aura on itself
    // would double-dip a single trait. Combat axes only here (gunner/
    // bulwark/wrench); voidrunner/pathfinder/quartermaster/colonist
    // run in other passes and are a recorded follow-up.
    const fleetAura = new Map(); // shipId -> { dmgMul, hpMul, repairMul }
    try {
      const led = (await this.env.DB
        .prepare(
          `SELECT f.id, fc.ship_id AS flagship_id, fc.traits_json
             FROM game_fleets f
             JOIN game_captains fc ON fc.id = f.flag_captain_id
            WHERE f.game_id = ? AND f.flag_captain_id IS NOT NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];
      const AXES = { gunner: ['dmgMul', 1.10], bulwark: ['hpMul', 1.10], wrench: ['repairMul', 1.5] };
      for (const f of led) {
        let traits = [];
        try { traits = JSON.parse(f.traits_json || '[]'); } catch { /* bad blob = no aura */ }
        const eff = { dmgMul: 1, hpMul: 1, repairMul: 1 };
        for (const t of traits) { const ax = AXES[t]; if (ax) eff[ax[0]] *= 1 + (ax[1] - 1) / 2; }
        if (eff.dmgMul === 1 && eff.hpMul === 1 && eff.repairMul === 1) continue;
        for (const sh of allShips) {
          if (sh.fleet_id === f.id && sh.id !== f.flagship_id) fleetAura.set(sh.id, eff);
        }
      }
    } catch (e) { console.error('fleet aura build failed', e); }
    const auraMul = (shipId, k) => fleetAura.get(shipId)?.[k] ?? 1;

    // COMBAT V2 (DESIGN-combat-v2.md). AUTO_COMBAT_INTERVAL is retired: every
    // armed hull fires EVERY tick and rolls to hit on relative speed.
    //
    // The roll is the first randomness in the tick, so it must be reproducible
    // — a replay, a re-run of a dropped alarm, and every client have to agree.
    // Seeded from (tick, attacker id) only: no Math.random, no ordering
    // dependence, no state carried between ticks.
    const hashStr = (str) => {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    const rollFor = (attackerId, atTick) => {
      let a = (hashStr(attackerId) ^ Math.imul(atTick + 1, 2654435761)) >>> 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Sticky-random target acquisition, shared by ships and stations.
    // A combatant HOLDS its previous target (last_target_id) for as long as
    // that target is still a legal pick in its current priority tier; when
    // the target dies, leaves, or a higher-priority tier appears, the held
    // id is no longer in `tier` and it re-rolls a fresh RANDOM target.
    //
    // Replaces peer-speed matching. That picked the target nearest the
    // attacker's own speed, but every same-speed hull computed the SAME
    // answer, so a whole squadron converged on one enemy and deleted it in a
    // single tick — 10 corvettes one-shotting one corvette a tick, the weird
    // balance Lorne flagged. Random spread makes focus EMERGENT (a few ships
    // happening to share a mark) instead of universal, and because it's
    // uniform across classes it does NOT reintroduce the "everyone shoots the
    // slowest, capital ships unplayable" problem peer-targeting once solved.
    //
    // Priority is untouched: the caller still hands us the top non-empty tier
    // (armed ships before civilians before settlements, honouring player
    // priority), so "hold until it dies" operates WITHIN the profile — a
    // warship arriving still pulls fire off a freighter.
    //
    // Seeded on (`${id}:tgt`, tick): reproducible for replays, and a distinct
    // stream from the hit roll rollFor(id, tick) so choice and hit chance
    // aren't correlated. No Math.random, no state between ticks beyond the
    // persisted last_target_id.
    //
    // FOCUS FIRE. The seed is the FLEET's, not the hull's, whenever the
    // hull is in one. Members therefore roll the same index into the
    // same sorted tier and converge on one target, and the hold-until-
    // it-dies rule above keeps them there — a squadron kills a ship
    // instead of wounding five.
    //
    // This is the whole implementation. It needs no extra pass and no
    // stored fleet target because the roll is already deterministic per
    // (seed, tick), and orders are fleet-wide now, so members share a
    // target_priority and are handed IDENTICAL tiers. If they were ever
    // handed different tiers the shared seed would still be safe — each
    // hull indexes its own tier — it simply would not converge.
    const pickTarget = (attackerId, lastTargetId, tier, atTick, fleetId) => {
      tier.sort((a, b) => (a.id < b.id ? -1 : 1));   // stable order for the index
      if (lastTargetId) {
        const held = tier.find(t => t.id === lastTargetId);
        if (held) return held;
      }
      const r = rollFor(`${fleetId || attackerId}:tgt`, atTick);
      return tier[Math.min(tier.length - 1, Math.floor(r * tier.length))];
    };
    // COMBAT V2 TELEMETRY. Every balance number in DESIGN-combat-v2.md came
    // from shot-level data the live game never recorded. Accumulate it here
    // per tick, flush once at the end of the pass (migration 0063).
    //
    // In-memory Map keyed "attacker>target" so the whole tick is one batched
    // write of at most ~36 rows rather than a statement per shot.
    const combatTally = new Map();
    /** targetId -> Set of attacker classes that LANDED on it this tick.
     *  Damage resolves simultaneously, so there is no single killing blow;
     *  this is what lets a kill be credited to everyone who was shooting. */
    const hitBy = new Map();
    // ---- per-HULL stats (migration 0069) --------------------------------
    // The tally is keyed by CLASS and so can never name a ship. This map
    // is what makes the MVP awards and the loadout analysis possible:
    // one row per hull, UPSERTed in the same batched flush.
    const shipStats = new Map();
    const statsFor = (sh) => {
      let e = shipStats.get(sh.id);
      if (!e) {
        e = {
          name: sh.name ?? null, cls: sh.ship_class ?? null, fid: sh.owner_faction_id ?? null,
          shots: 0, hits: 0, shotsTaken: 0, hitsTaken: 0,
          dealt: 0, taken: 0, absorbed: 0, kills: 0, overkill: 0, lowHpKills: 0,
        };
        shipStats.set(sh.id, e);
      }
      return e;
    };
    /** targetId -> ships that landed on it this tick, for kill credit. */
    const hitByShip = new Map();

    // `raw` is pre-mitigation, `dmg` post — the gap is what the target's
    // shields/armor absorbed, which is the whole point of recording both.
    // --- BATTLE RECORDS (migration 0092) -------------------------
    // The two existing aggregates are lifetime totals: they answer "how
    // do corvettes fare against frigates" and never "what happened at
    // Mars". These buffers keep this tick's combat grouped BY BODY, which
    // is the grain a player actually remembers a fight at, and the
    // persistence pass below folds each body's tick into an open battle.
    const battleShots = new Map();    // bodyId -> [shot]
    const battleRoster = new Map();   // bodyId -> [hull snapshot]
    const battleDeaths = new Map();   // shipId -> { killerFactionId, bodyId }
    // Set at the top of the per-body combat loop. Safe as a single
    // mutable: the loop awaits sequentially and nothing else runs
    // between its iterations.
    let currentCombatBodyId = null;

    // `energyShare` is the attacker's energy fraction for THIS volley —
    // the same number the damage roll blended its weapon tech and picked
    // the target's mitigation with. Recorded rather than re-derived,
    // because a recap of an old fight must show the loadout that fought
    // it, and a hull that has since been refitted (or destroyed) can no
    // longer answer the question.
    const tallyShot = (attackerClass, targetClass, landed, dmg, targetId, raw, attacker, target,
                       energyShare = 0) => {
      if (currentCombatBodyId) {
        let arr = battleShots.get(currentCombatBodyId);
        if (!arr) { arr = []; battleShots.set(currentCombatBodyId, arr); }
        arr.push({
          a: attacker?.id ?? null,
          af: attacker?.owner_faction_id ?? null,
          ac: attackerClass ?? null,
          t: targetId ?? null,
          tf: target?.owner_faction_id ?? null,
          tc: targetClass ?? null,
          hit: landed ? 1 : 0,
          dmg: landed ? (dmg || 0) : 0,
          raw: landed ? (raw ?? dmg ?? 0) : 0,
          e: Math.max(0, Math.min(1, Number(energyShare) || 0)),
        });
      }
      const k = `${attackerClass}>${targetClass}`;
      let e = combatTally.get(k);
      if (!e) {
        e = { volleys: 0, hits: 0, damage: 0, kills: 0, damageRaw: 0, absorbed: 0, overkill: 0 };
        combatTally.set(k, e);
      }
      e.volleys++;
      // Settlements have no ship row — same guard the target side
      // already applies, so a station can be named as the shooter in
      // the battle record without inventing a hull in the aggregate.
      const aStat = (attacker && attacker.ship_class) ? statsFor(attacker) : null;
      if (aStat) aStat.shots++;
      // Settlements have no ship row; only ships get a per-hull record.
      const tStat = (target && target.ship_class) ? statsFor(target) : null;
      if (tStat) tStat.shotsTaken++;
      if (landed) {
        e.hits++;
        e.damage += dmg;
        e.damageRaw += (raw ?? dmg);
        // Own accumulator, NOT raw - damage: `damage` carries history
        // from 0063 while raw starts at 0069, so the subtraction would
        // span two epochs (migration 0070).
        e.absorbed += Math.max(0, (raw ?? dmg) - dmg);
        if (aStat) { aStat.hits++; aStat.dealt += dmg; }
        if (tStat) {
          tStat.hitsTaken++;
          tStat.taken += dmg;
          tStat.absorbed += Math.max(0, (raw ?? dmg) - dmg);
        }
        if (targetId) {
          let set = hitBy.get(targetId);
          if (!set) { set = new Set(); hitBy.set(targetId, set); }
          set.add(attackerClass);
          if (attacker) {
            let ships = hitByShip.get(targetId);
            if (!ships) { ships = new Map(); hitByShip.set(targetId, ships); }
            // Remember how much THIS hull put in, so overkill can be
            // apportioned by contribution rather than split evenly.
            ships.set(attacker.id, (ships.get(attacker.id) ?? 0) + dmg);
          }
        }
      }
      return e;
    };
    /** Credit a kill to every class that landed on this hull this tick.
     *  `wasted` is damage beyond what the target had left — apportioned
     *  across contributors by share of damage dealt. */
    const tallyKill = (targetId, targetClass, wasted = 0, attackerLowHp) => {
      const set = hitBy.get(targetId);
      if (set) {
        for (const cls of set) {
          const e = combatTally.get(`${cls}>${targetClass}`);
          if (e) { e.kills++; e.overkill += wasted / set.size; }
        }
      }
      const ships = hitByShip.get(targetId);
      if (!ships) return;
      let total = 0;
      for (const v of ships.values()) total += v;
      for (const [shipId, contributed] of ships) {
        const st = shipStats.get(shipId);
        if (!st) continue;
        st.kills++;
        if (total > 0) st.overkill += wasted * (contributed / total);
        // "Last Stand" — a kill landed while the killer was itself
        // nearly dead. Resolved by the caller, which knows live HP.
        if (attackerLowHp && attackerLowHp.has(shipId)) st.lowHpKills++;
      }
    };

    /** Speed of any combatant. Settlements are not ships but they shoot and
     *  are shot at, so they answer on the same scale. */
    // FLAK. shipId -> speed multiplier from enemy flak batteries in the
    // same orbit. Filled once the roster and the treaty set are known
    // (just below the peace pairs); speedOfShip closes over it, which is
    // why every gun in the game picks the debuff up for free — the ship
    // volley, the settlement guns, the Weapons Station, counter-battery.
    // One choke point beats five call sites that have to remember.
    const flakSlow = new Map();
    const speedOfShip = (sh) => shipSpeed(sh.ship_class, sh._parts)
      * (flakSlow.get(sh.id) ?? 1);
    const speedOfSettlement = () => SETTLEMENT_SPEED;

    // --- Canonical combat constants, mirrored from the client (the
    //     authoritative combat spec — src/game/shipClasses.ts +
    //     src/game/settlements.ts). MP combat now matches SP exactly:
    //     each attacker deals FULL damage to EVERY hostile (not split),
    //     settlements bombard with their class damage (not a flat 4) and
    //     FIRE BACK on hostile ships. ---
    //
    // POINT DEFENCE REMOVED (Lorne, 2026-08-04). Every hull used to carry
    // a free untyped damage cut by class — corvette 20% / frigate 40% /
    // destroyer 60%, plus a further flat +10% from Defense 4. It was the
    // single largest survivability term in the game and it appeared in
    // ZERO player-facing surfaces, so a destroyer read as 5x a corvette
    // (200 HP vs 40) while actually soaking 10x. The only mitigation left
    // is the TYPED one players can see and choose: shields cut kinetic,
    // armor cuts energy, 0.78 per part, floored at MITIGATION_FLOOR.
    //
    // Effect: incoming damage rises across the board, most for the hulls
    // that had the most PDC — destroyers take +150%, frigates +67%,
    // corvettes +25%. Modelled at ~2x faster battles (94 -> 43 ticks on a
    // 9v9 mixed fleet) and the class durability spread compressing from
    // 10x to 5x.
    //
    // Return-fire: CITIES never shoot (civilian). STATIONS shoot only once
    // a Weapons module is built, with damage scaling by its level — an
    // unarmed station is a soft target. No flat "just for existing" base.
    // COMBAT V2: 8 -> 20 per level. Stations kept their 3-tick cadence while
    // ships moved to every tick, which would have cut their relative worth to
    // a third without anyone editing a number. 20 + the hit roll lands them at
    // ~2x today's effective DPS — a deliberate buff to fortification, not a
    // restoration. See DESIGN-combat-v2.md R2.
    const STATION_DMG_PER_WEAPONS_LEVEL = 20;                 // L1=20, L2=40, … Ln=20n

    // Per-faction tech multipliers for this tick (one indexed query,
    // bucketed). perLevel values mirror src/game/techs.ts TECH_DEFS.
    // Only weapons (combat) + armor (HP cap) are read in the tick loop;
    // industry is re-read in the yield pass, construction/flight are
    // applied in the request handlers (build cost / engine_g).
    const combatTechRows = (await this.env.DB
      .prepare('SELECT faction_id, tech_id, level FROM faction_techs WHERE game_id = ?')
      .bind(gameId)
      .all()).results ?? [];
    const techLvl = new Map(); // fid -> { weapons, armor, ... }
    for (const r of combatTechRows) {
      let m = techLvl.get(r.faction_id);
      if (!m) { m = {}; techLvl.set(r.faction_id, m); }
      m[r.tech_id] = r.level;
    }
    // Kinetic + energy weapon tech scale their own mounts; a ship's
    // effective weapon multiplier is these blended by its damage profile
    // (see attackerWeaponMul below). Legacy games that only teched the
    // old 'weapons' line fall back to it for energy so an energy fleet
    // isn't silently un-teched by the split.
    // Research-gated combat buffs (project_intel_gating): these effects
    // existed as design promises only; now they key off the owner's tech.
    // Ungated (grandfathered) games get them for free, same as every
    // other research gate. Requirement levels mirror researchUnlocks:
    // damageControl = armor 5. (armor 4 was pdcUpgrade — removed with PDC.)
    const gatingRow = await this.env.DB
      .prepare('SELECT gating_enabled FROM games WHERE id = ?')
      .bind(gameId).first();
    const buffsGated = (gatingRow?.gating_enabled ?? 0) === 1;
    const hasBuff = (fid, track, reqLevel) =>
      !buffsGated || (techLvl.get(fid)?.[track] ?? 0) >= reqLevel;

    const kineticMulOf = (fid) => 1 + 0.10 * (techLvl.get(fid)?.weapons ?? 0);
    const energyMulOf  = (fid) => 1 + 0.10 * Math.max(
      techLvl.get(fid)?.energy_weapons ?? 0, techLvl.get(fid)?.weapons ?? 0);
    // Best defensive line raises the live repair ceiling (baked HP
    // already includes per-part tech). armor covers shields in legacy
    // games until shields is researched.
    const armorMulOf    = (fid) => 1 + 0.08 * Math.max(
      techLvl.get(fid)?.armor ?? 0, techLvl.get(fid)?.shields ?? 0);
    const industryMulOf = (fid) => 1 + 0.10 * (techLvl.get(fid)?.industry ?? 0);
    /** A ship/settlement's weapon-tech multiplier, blended by what it
     *  fires. Settlements + bare hulls fire kinetic. */
    const attackerWeaponMul = (fid, profile) =>
      profile.kinetic * kineticMulOf(fid) + profile.energy * energyMulOf(fid);

    // Fleet arrears (DESIGN-fleet-economy §1): an unpaid fleet fights at
    // 75% damage until the debt clears. Reads the ledger AS OF the last
    // upkeep pass (upkeep bills later in this same tick), so the penalty
    // always reflects a full tick of being broke, never a mid-tick race.
    // Ships only — station return-fire is settlement infrastructure and
    // pays no upkeep, so it never suffers the malus.
    const ARREARS_DAMAGE_MULT = 0.75;
    const arrearsSet = new Set();
    try {
      const arrearsRows = (await this.env.DB
        .prepare(
          `SELECT id FROM game_factions
            WHERE game_id = ? AND (arrears_gold > 0 OR arrears_metal > 0)`,
        )
        .bind(gameId)
        .all()).results ?? [];
      for (const r of arrearsRows) arrearsSet.add(r.id);
    } catch (e) { console.error('arrears lookup failed (no combat penalty applied)', e); }
    const arrearsMulOf = (fid) => (arrearsSet.has(fid) ? ARREARS_DAMAGE_MULT : 1);

    // Build a fast at-peace lookup: pacts.has(fA + '|' + fB) === true iff
    // they have an active NAP/defense pact (unordered key).
    // Extracted to peacePairsAt so the megastructure siege pass asks the
    // same question rather than carrying its own copy of the treaty
    // rule — a second copy is how a new treaty kind ends up pacifying
    // fleet combat while structures keep getting shot.
    const pairKey = megaPairKey;
    const peace = await this.peacePairsAt(gameId, tick);

    // Ships actually IN FLIGHT don't fight and can't be fought — they're
    // between bodies, not at one. game_ships.parent_body_id still holds
    // the departure body while a ship is in transit, so without this a
    // hull that has already left still sits in its origin's combat bucket
    // and takes fire mid-flight (player report: "Osprey at 1% HP,
    // damaged in transit"). SP already excludes these (src/game/combat.ts
    // `if (s.transit) continue`); this brings MP in line. Only 'in_transit'
    // counts — a 'committed' node hasn't departed yet, so that ship is
    // still parked and a valid combatant.
    const inTransitIds = new Set(
      ((await this.env.DB
        .prepare(
          `SELECT DISTINCT n.ship_id AS id
             FROM game_ship_nodes n
             JOIN game_ships s ON s.id = n.ship_id
            WHERE s.game_id = ? AND n.status = 'in_transit'`,
        )
        .bind(gameId)
        .all()).results ?? []).map(r => r.id),
    );

    // ---- FLAK BATTERIES ---------------------------------------------
    //
    // Flak does no damage. It slows what it is pointed at, and in this
    // game speed IS survivability: the hit roll is atk^2/(atk^2+def^2),
    // so a slower hull is an easier one for EVERY gun in the fleet
    // rather than only for the ship carrying the flak. That is what
    // makes it the answer to a swarm without a rule that says so —
    // 5% off a corvette's 0.85 buys far more hit chance than 5% off a
    // destroyer's 0.30, so the counter self-selects against the fast.
    //
    // Per BODY, because a flak screen is a formation: it covers the
    // orbit it is standing in. Hulls in transit are untouched, which is
    // the same reason a settlement's guns cannot reach them.
    {
      const byBody = new Map();
      for (const sh of allShips) {
        if ((sh.hp ?? 0) <= 0) continue;
        if (!sh.parent_body_id) continue;
        if (inTransitIds.has(sh.id)) continue;
        if (!byBody.has(sh.parent_body_id)) byBody.set(sh.parent_body_id, []);
        byBody.get(sh.parent_body_id).push(sh);
      }
      for (const crowd of byBody.values()) {
        if (crowd.length < 2) continue;
        // Flak mounts each faction has in this orbit.
        const mountsByFaction = new Map();
        for (const sh of crowd) {
          const n = countPart(sh._parts, 'flak');
          if (n > 0) {
            mountsByFaction.set(sh.owner_faction_id,
              (mountsByFaction.get(sh.owner_faction_id) ?? 0) + n);
          }
        }
        if (mountsByFaction.size === 0) continue;
        for (const sh of crowd) {
          let against = 0;
          for (const [fid, n] of mountsByFaction) {
            if (fid === sh.owner_faction_id) continue;             // not your own
            if (peace.has(pairKey(fid, sh.owner_faction_id))) continue;  // not a partner's
            against += n;
          }
          if (against > 0) flakSlow.set(sh.id, flakSlowMultiplier(against));
        }
      }
    }


    // ---- transit combat inputs (DESIGN-transit-combat.md) -------------
    // Loaded whether or not the flag is on, because they cost one query
    // each and the alternative is a second code path that only runs in
    // sim rooms and therefore only breaks in production.
    const transitCombatEnabled = Number(CFG.transit_combat_enabled ?? 0) === 1;
    // Weapons Stations, with the owner read off the BODY so a captured
    // one shoots for whoever holds it now. Structure ranges are
    // pre-scale numbers, same as sensors — a spread map must not
    // shrink what an emplacement covers.
    const megaRangeScale = Number(CFG.system_scale) > 0 ? Number(CFG.system_scale) : 1;
    const megaStations = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.kind, b.owner_faction_id
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
          WHERE m.game_id = ? AND m.kind = 'weapons_station'
            AND m.status = 'complete' AND b.destroyed_at_tick IS NULL
            AND m.hp > ?`,
      )
      .bind(gameId, MEGA_BREACH_HP).all()).results ?? [];
    // How long after lighting the engine a hull may still trade fire
    // with something PARKED. One tick: the parting shot, and the mirror
    // case of arriving into a defended orbit. Ships fully under way
    // fight each other, not the furniture.
    const TRANSIT_ORBIT_SHOT_TICKS = 1;
    const transitVRef = Number(CFG.transit_evasion_v_ref ?? TRANSIT_V_REF) || TRANSIT_V_REF;
    // Closing-speed bonus (see transitCombat.js). Read here with the
    // other transit knobs so a host can turn it off without a deploy.
    // `?? DEFAULT` rather than `|| DEFAULT` on the max: 0 is a REAL
    // value here (it disables the bonus) and `||` would silently
    // resurrect the default every time somebody switched it off.
    const transitDvBonusMax = Number(CFG.transit_dv_bonus_max ?? DV_BONUS_MAX);
    const transitDvBonusStart = Number(CFG.transit_dv_bonus_start ?? DV_BONUS_START);
    const transitDvBonusFull = Number(CFG.transit_dv_bonus_full ?? DV_BONUS_FULL);
    // Weapon reach inside a planet's sphere of influence. Moon orbits are
    // packed an order of magnitude tighter than interplanetary space —
    // Uranus runs 6 to 15 units between neighbours — so a reach sized for
    // open space covers the entire neighbourhood, and a hull parked at one
    // moon can shoot across three orbits (player report, with a picture).
    const transitRangeInSystemMul = Math.max(0.05, Math.min(1,
      Number(CFG.transit_range_in_system_mul ?? 0.5) || 0.5));
    /** Shots taken in the transit pass, for telemetry + the intercept
     *  warning. Populated in 3.3b below. */
    const transitShots = [];

    // Every body, once, so position and velocity are synchronous inside
    // the pass. bodyPosAt further up is async and recursive per call —
    // fine for a handful of freighter legs, ruinous for an N² contact
    // sweep.
    // LOADED UNCONDITIONALLY, and that is a fix rather than a
    // pessimisation. This used to be gated on transitCombatEnabled, so
    // with transit combat OFF the map was empty and bodyPosSync
    // answered {0,0} for EVERY body. Anything else that reached for the
    // resolver silently got the origin — which is exactly what happened
    // to the meteoroid survey: all thirty rocks stacked on Sol, 566
    // units from a station with 800 range, and the whole belt was
    // "discovered" in a single tick.
    //
    // A resolver that returns plausible-looking garbage when a
    // FEATURE FLAG is off is a trap for every future caller, not just
    // that one. The query is a single indexed read of a few dozen rows;
    // the expensive thing this comment block originally warned about
    // was the async per-call recursion, which is unchanged.
    const allBodyRows = ((await this.env.DB
          .prepare(
            `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0, radius, soi,
                    mu, type,
                    orbit_rp, orbit_ra, orbit_omega, orbit_m0,
                    ram_target_body_id, ram_start_tick, ram_flip_tick, ram_arrive_tick,
                    ram_acceleration, ram_start_pos_x, ram_start_pos_y,
                    ram_start_vel_x, ram_start_vel_y,
                    ram_intercept_pos_x, ram_intercept_pos_y
               FROM game_bodies WHERE game_id = ?`,
          )
          .bind(gameId).all()).results ?? []);
    const bodyRowById = new Map(allBodyRows.map(b => [b.id, b]));
    const posMemo = new Map();
    // Mirrors bodyPosition in src/physics/orbitalMechanics.ts, in the
    // SAME order of precedence: a ram trajectory overrides everything, an
    // eccentric Kepler orbit comes next, and the cheap circular shortcut
    // is the fallback every ordinary body takes.
    //
    // The first two used to be missing here, which put the three Kuiper
    // rogues in every default system hundreds of units from where the
    // client draws them — and those positions feed intercept geometry and
    // occlusion, so the error would not have stayed cosmetic.
    const bodyPosSync = (id, t) => {
      const key = `${id}@${t}`;
      const hit = posMemo.get(key);
      if (hit) return hit;
      const b = bodyRowById.get(id);
      if (!b || b.parent_body_id == null) return { x: 0, y: 0 };
      let out;
      if (isRamming(b, t)) {
        out = torchStateAt(ramPlanOf(b), bodyVelSync, t).pos;
      } else {
        const parent = bodyPosSync(b.parent_body_id, t);
        if (isEccentric(b)) {
          const local = eccentricLocalPosition(b, t, ORBITAL_SPEED_SCALE);
          out = { x: parent.x + local.x, y: parent.y + local.y };
        } else {
          const angle = orbitAngle(b.angle0, b.orbit_period, t);
          out = {
            x: parent.x + Math.cos(angle) * (b.orbit_radius ?? 0),
            y: parent.y + Math.sin(angle) * (b.orbit_radius ?? 0),
          };
        }
      }
      posMemo.set(key, out);
      return out;
    };
    // Forward difference at dt=0.01 — matches bodyWorldVelocity in
    // src/physics/orbitalMechanics.ts exactly, which matters because the
    // torch brake phase reads it.
    const bodyVelSync = (id, t) => {
      const p1 = bodyPosSync(id, t);
      const p2 = bodyPosSync(id, t + 0.01);
      return { x: (p2.x - p1.x) / 0.01, y: (p2.y - p1.y) / 0.01 };
    };

    // Launch plans for hulls in flight (migration 0088). A node with no
    // plan is pre-flag and simply doesn't participate — it can neither
    // shoot nor be shot, exactly as before.
    const launchPlans = new Map();
    if (transitCombatEnabled) {
      const planRows = (await this.env.DB
        .prepare(
          `SELECT n.ship_id, n.target_body_id, n.scheduled_t, n.arrival_at_tick,
                  n.launch_x, n.launch_y, n.launch_vx, n.launch_vy, n.accel, n.flip_tick,
                  n.rv_ax, n.rv_ay, n.rv_bx, n.rv_by, n.rv_meet_tick, n.rv_follow_ship_id
             FROM game_ship_nodes n
             JOIN game_ships s ON s.id = n.ship_id
            WHERE s.game_id = ? AND n.status = 'in_transit'
              AND n.launch_x IS NOT NULL AND n.accel IS NOT NULL`,
        )
        .bind(gameId).all()).results ?? [];
      for (const r of planRows) {
        if (!r.target_body_id || r.arrival_at_tick == null) continue;
        // The intercept is the target body where the ship is due to
        // arrive — the same point the client's planner aimed at.
        const ip = bodyPosSync(r.target_body_id, Number(r.arrival_at_tick));
        launchPlans.set(r.ship_id, {
          launchX: Number(r.launch_x), launchY: Number(r.launch_y),
          launchVx: Number(r.launch_vx), launchVy: Number(r.launch_vy),
          accel: Number(r.accel), flipTick: Number(r.flip_tick),
          startTick: Number(r.scheduled_t), arriveTick: Number(r.arrival_at_tick),
          interceptX: ip.x, interceptY: ip.y, targetBodyId: r.target_body_id,
          // Rendezvous arc, when this leg is one (migration 0090).
          rv: (r.rv_ax != null && r.rv_meet_tick != null && r.rv_follow_ship_id) ? {
            A: { x: Number(r.rv_ax), y: Number(r.rv_ay) },
            B: { x: Number(r.rv_bx), y: Number(r.rv_by) },
            meetTick: Number(r.rv_meet_tick),
            follow: r.rv_follow_ship_id,
          } : null,
        });
      }
    }

    /**
     * Where a hull in flight is, whichever kind of leg it is flying.
     *
     * An ordinary transfer is a flip-and-burn. A rendezvous is burn /
     * coast / burn and then, from the meeting onward, IS the ship it
     * joined — so the follow phase recurses into that ship's own plan
     * rather than integrating anything. Depth-capped because a pair of
     * hulls could in principle be set to follow each other; one level of
     * following is all the feature promises.
     */
    const shipStateAt = (plan, t, depth = 0) => {
      if (!plan.rv) return torchStateAt(plan, bodyVelSync, t);
      const followedPlan = depth < 2 ? launchPlans.get(plan.rv.follow) : null;
      return rendezvousStateAt(
        {
          p0: { x: plan.launchX, y: plan.launchY },
          v0: { x: plan.launchVx, y: plan.launchVy },
          accel: plan.accel,
          A: plan.rv.A, B: plan.rv.B,
          startTick: plan.startTick, meetTick: plan.rv.meetTick,
        },
        t,
        followedPlan ? (x) => shipStateAt(followedPlan, x, depth + 1) : null,
      );
    };

    // Group by body, then check for multiple factions present.
    const byBody = new Map();
    for (const s of allShips) {
      if (inTransitIds.has(s.id)) continue;
      if (!byBody.has(s.parent_body_id)) byBody.set(s.parent_body_id, []);
      byBody.get(s.parent_body_id).push(s);
    }

    // hpDeltas: shipId -> { total: number, byFaction: Map<factionId, number>,
    //                       byShip: Map<attackerShipId, number> }
    // Per-faction split credits the kill in chronicle entries; per-ship
    // split credits the rank-up + history record to a specific hull
    // (mirrors src/game/combat.ts damageByAttackerShip).
    const hpDeltas = new Map();
    const addDamage = (targetId, attackerFid, attackerShipId, amount) => {
      let entry = hpDeltas.get(targetId);
      if (!entry) {
        entry = { total: 0, byFaction: new Map(), byShip: new Map() };
        hpDeltas.set(targetId, entry);
      }
      entry.total += amount;
      entry.byFaction.set(attackerFid, (entry.byFaction.get(attackerFid) || 0) + amount);
      if (attackerShipId) {
        entry.byShip.set(attackerShipId, (entry.byShip.get(attackerShipId) || 0) + amount);
      }
    };
    // Standing orders — stance (DESIGN-identity-economy.md §3).
    //   attack (default / NULL): engage hostiles in range — legacy behavior.
    //   defensive: return fire only. Simplest robust rule (per spec): a
    //     defensive ship engages any faction that is CURRENTLY AGGRESSING
    //     at this body — i.e. has an armed attack-stance ship parked here.
    //     Such a ship fires on your ships every cadence window and chips
    //     your settlements every tick, so "attack-stance armed hostile
    //     present" == "currently damaging your ships/settlements here".
    //     Defensive-vs-defensive standoffs correctly never fire.
    //   hold: never fires. Still takes damage.
    const effectiveStance = (s) =>
      (s.stance === 'defensive' || s.stance === 'hold') ? s.stance : 'attack';
    // aggressorsAtBody: bodyId -> Set<factionId> with at least one armed
    // attack-stance ship at that body.
    const aggressorsAtBody = new Map();
    for (const [bodyId, ships] of byBody) {
      const set = new Set();
      for (const s of ships) {
        if ((s.damage_per_tick ?? 0) > 0 && effectiveStance(s) === 'attack') {
          set.add(s.owner_faction_id);
        }
      }
      aggressorsAtBody.set(bodyId, set);
    }
    // Settlements are combatants too — fetched here (before the volley
    // loop) so ships can target them and they can fire back within the
    // same simultaneous step, matching the client model. buildings_json
    // carries the Weapons-building level for station return-fire;
    // last_combat_tick gates the settlement's own cadence.
    const livingSettlements = (await this.env.DB
      .prepare(
        `SELECT id, name, body_id, owner_faction_id, type, hp, hp_max,
                buildings_json, last_combat_tick, population,
                shield_hp, shield_hp_max, shield_down_tick, last_target_id
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];
    const combatSettlementsByBody = new Map();
    for (const st of livingSettlements) {
      if (!combatSettlementsByBody.has(st.body_id)) combatSettlementsByBody.set(st.body_id, []);
      combatSettlementsByBody.get(st.body_id).push(st);
    }
    const weaponsLevelOf = (st) => {
      if (!st.buildings_json) return 0;
      try { return Number(JSON.parse(st.buildings_json)?.weapons ?? 0) || 0; } catch { return 0; }
    };
    // settlementId -> { total, byFaction: Map } accrued ship→settlement damage.
    const settlementDamage = new Map();
    const addSettlementDamage = (sid, fid, amount) => {
      let e = settlementDamage.get(sid);
      if (!e) { e = { total: 0, byFaction: new Map() }; settlementDamage.set(sid, e); }
      e.total += amount;
      e.byFaction.set(fid, (e.byFaction.get(fid) || 0) + amount);
    };

    // Ships that fired this tick — their last_combat_tick gets bumped
    // to `tick` in a post-loop UPDATE so the next-N-ticks cooldown
    // applies. Tracked here instead of inline so we can batch the writes.
    const firedShipIds = new Set();
    const firedSettlementIds = new Set();
    // shooterId -> the ONE target it engaged this volley (ship or
    // settlement id). Stamped to last_target_id so the client animation
    // shows who each combatant is actually shooting.
    const firedShipTargets = new Map();
    const firedSettlementTargets = new Map();
    // megastructure body id -> the ship it last shot at, for the FX layer
    // and the combat stamp written after the volley passes.
    const megaFired = new Map();
    // megastructure body id -> damage its own targets put back into it.
    const megaReturn = new Map();
    // A body sees hostilities if ≥2 factions are present across ships
    // AND settlements combined (so a ship attacking an undefended
    // enemy settlement, or a settlement firing on a lone raider, both
    // count even when only one faction has ships there).
    const combatBodyIds = new Set([...byBody.keys(), ...combatSettlementsByBody.keys()]);
    for (const bodyId of combatBodyIds) {
      const ships = byBody.get(bodyId) ?? [];
      // Which body the shots below belong to, and the board as it stood
      // before any of them landed.
      currentCombatBodyId = bodyId;
      const localSettlements = combatSettlementsByBody.get(bodyId) ?? [];
      if (!battleRoster.has(bodyId)) {
        battleRoster.set(bodyId, [
          ...ships.map(s => ({
            id: s.id,
            fid: s.owner_faction_id ?? null,
            cls: s.ship_class ?? null,
            hp: Number(s.hp) || 0,
            hpMax: Number(s.hp_max) || null,
            rank: Number(s.rank) || 0,
            kind: 'ship',
          })),
          // Stations and cities are combatants: they get bombarded, a
          // station with guns shoots back, and losing one is usually the
          // whole point of the engagement. Leaving them out of the roster
          // meant the shot log pointed at ids nothing on the board owned,
          // so a recap drew ten hulls converging on an anonymous dot.
          ...localSettlements.map(st => ({
            id: st.id,
            fid: st.owner_faction_id ?? null,
            cls: st.type ?? 'settlement',
            name: st.name ?? null,
            // What was actually built here. The station rig draws its
            // weapons, shipyard, lab and thruster modules; without these
            // a recap can only ever show a bare ring.
            mods: st.buildings_json ?? null,
            hp: Number(st.hp) || 0,
            hpMax: Number(st.hp_max) || null,
            rank: 0,
            kind: st.type === 'station' ? 'station' : 'city',
          })),
        ]);
      }
      const factions = new Set([
        ...ships.map(s => s.owner_faction_id),
        ...localSettlements.map(s => s.owner_faction_id),
      ]);
      if (factions.size < 2) continue;
      for (const attacker of ships) {
        if (!attacker.damage_per_tick || attacker.damage_per_tick <= 0) continue;
        const stance = effectiveStance(attacker);
        // hold-fire: never shoots, no matter what.
        if (stance === 'hold') continue;
        // COMBAT V2: no cadence gate. Every armed hull fires every tick;
        // whether it CONNECTS is the speed roll below.
        // Only engage factions we're at war with (no peace pact).
        // Defensive stance additionally requires the target's faction to be
        // an active aggressor at this body (see aggressorsAtBody above).
        const aggressors = aggressorsAtBody.get(bodyId) ?? new Set();
        const canEngage = (fid) =>
          fid !== attacker.owner_faction_id
          && !peace.has(pairKey(attacker.owner_faction_id, fid))
          && (stance !== 'defensive' || aggressors.has(fid));

        // === TARGET PRIORITY — one target per volley ===
        // Everything in ORBIT dies before any settlement is touched, and
        // combat units die before civilians:
        //   1. armed hostile ships        (warships — the actual threat)
        //   2. unarmed hostile ships      (freighters/colony — civilians)
        //   3. armed stations             (weapons ≥ 1 — they shoot back)
        //   4. remaining settlements      (unarmed stations, cities)
        const armedShips = [];
        const civilianShips = [];
        for (const t of ships) {
          if (!canEngage(t.owner_faction_id)) continue;
          ((t.damage_per_tick ?? 0) > 0 ? armedShips : civilianShips).push(t);
        }
        const armedStations = [];
        const softSettlements = [];
        for (const t of localSettlements) {
          if (!canEngage(t.owner_faction_id)) continue;
          if (t.type === 'station' && weaponsLevelOf(t) >= 1) armedStations.push(t);
          else softSettlements.push(t);
        }
        // Player-set priority (migration 0064) reorders the SHIP
        // categories. Settlements are PINNED LAST and cannot be promoted
        // (Lorne: "too OP to walk right up and blow away someone's
        // cities") — a raider must clear the defending fleet before it
        // can touch what the fleet is defending. The 'settlement' entry
        // is skipped wherever it sits in the stored list, so a legacy row
        // that ranked it first (or a forged request) is inert rather than
        // rejected. Auto (NULL) keeps the ladder below.
        let tier;
        if (attacker._targetPriority) {
          tier = [];
          for (const cat of attacker._targetPriority) {
            if (cat === 'settlement') continue;   // pinned last, see below
            if (cat === 'civilian') tier = civilianShips;
            // CAPITALS ARE A CATEGORY. The three hull names below are
            // literal ship_class matches, and 'mega_destroyer' is none
            // of them — so the largest, most dangerous thing on the
            // board could never be RANKED. It was only ever reached
            // through the fallback ladder, which means a player could
            // not order a fleet to kill the death star first.
            else if (cat === 'capital') tier = armedShips.filter(t => CAPITAL_CLASSES.has(t.ship_class));
            else tier = armedShips.filter(t => t.ship_class === cat);
            if (tier.length > 0) break;
          }
          // No ranked SHIP category present — only now may settlements be
          // engaged, in the ladder's own sub-order (armed stations are the
          // threat, they die first). This is also the fallback for a list
          // that can't match (e.g. an armed freighter matches no class key).
          if (tier.length === 0) {
            tier = armedShips.length ? armedShips
              : civilianShips.length ? civilianShips
              : armedStations.length ? armedStations
              : softSettlements;
          }
        } else {
          tier = armedShips.length ? armedShips
            : civilianShips.length ? civilianShips
            : armedStations.length ? armedStations
            : softSettlements;
        }
        if (tier.length === 0) continue;
        const isShipTier = tier.length > 0 && tier[0].ship_class !== undefined;
        // TARGET WITHIN TIER — random, held until it dies (see pickTarget).
        // atkSpeed is still needed for the hit roll below.
        const atkSpeed = speedOfShip(attacker);
        const target = pickTarget(attacker.id, attacker.last_target_id, tier, tick, attacker.fleet_id);

        // Damage math: full attacker power into the target's TYPED
        // mitigation (shields v kinetic, armor v energy). Lands on ONE
        // hull per volley (per design: round-robin single-target combat).
        // The untyped per-class PDC cut that used to multiply in here was
        // removed — see the note by STATION_DMG_PER_WEAPONS_LEVEL.
        const rankMul = 1 + 0.01 * Math.max(0, attacker.rank ?? 0);
        // Damage type this attacker fires (bare hull => kinetic), used
        // both to blend its weapon tech and to pick the target's
        // mitigation. parts parsed once per attacker per volley.
        const atkProfile = damageProfile(attacker._parts);
        const attackPower =
          attacker.damage_per_tick * attackerWeaponMul(attacker.owner_faction_id, atkProfile)
          * rankMul * combatDamageMultOf(attacker.owner_faction_id)
          // Unpaid fleet (§1 arrears): −25% damage until the debt clears.
          * arrearsMulOf(attacker.owner_faction_id)
          // Gunner captain (spec §3): +10% damage, multiplicative.
          * traitMul(attacker._traits ?? [], 'dmgMul')
          // Flag aura, halved (never on the flagship itself).
          * auraMul(attacker.id, 'dmgMul');
        // Senate war authorization: damage TO a faction the senate has
        // formally declared war on is doubled.
        const warAuthMul = (await sanctioned(target.owner_faction_id, 'war_authorization')) ? 2 : 1;
        // The roll. A miss still costs the volley — the shot happened, it
        // just did not land.
        const defSpeed = isShipTier ? speedOfShip(target) : speedOfSettlement();
        const targetClassLabel = isShipTier ? target.ship_class : 'settlement';
        if (rollFor(attacker.id, tick) >= hitChance(atkSpeed, defSpeed)) {
          tallyShot(attacker.ship_class, targetClassLabel, false, 0, target.id,
                    0, attacker, isShipTier ? target : null, atkProfile.energy);
          // Still counts as "fired" for the FX layer: animations are
          // unchanged, so a miss looks exactly like a hit on the map.
          firedShipIds.add(attacker.id);
          firedShipTargets.set(attacker.id, target.id);
          continue;
        }
        if (isShipTier) {
          // Typed mitigation only, floored so a stacked hull is brutal
          // but never immune (85% cap). Shields cut kinetic, armor cuts
          // energy; a target with NO relevant parts now takes the volley
          // in full — there is no longer a free class-based reduction.
          const mit = Math.max(MITIGATION_FLOOR,
            defenseMitigation(target._parts, atkProfile));
          const dealt = attackPower * mit * warAuthMul;
          tallyShot(attacker.ship_class, targetClassLabel, true, dealt, target.id,
                    attackPower * warAuthMul, attacker, target, atkProfile.energy);
          addDamage(target.id, attacker.owner_faction_id, attacker.id, dealt);
        } else {
          // Bombardment — settlements carry no shield/armor parts yet, and
          // their PDC (city 0.3 / station 0.5) went with the rest of the
          // system, so a bombarding volley now lands in full.
          tallyShot(attacker.ship_class, 'settlement', true, attackPower * warAuthMul, target.id,
                    attackPower * warAuthMul, attacker, null, atkProfile.energy);
          addSettlementDamage(target.id, attacker.owner_faction_id, attackPower * warAuthMul);
        }
        firedShipIds.add(attacker.id);
        // Record the engagement so the client's combat animation aims at
        // the REAL target (stamped alongside last_combat_tick below).
        firedShipTargets.set(attacker.id, target.id);
      }

      // Station return-fire on hostile ships at the same body — damage
      // = STATION_DMG_PER_WEAPONS_LEVEL × weapons level, scaled by the
      // owner's Weapons tech, reduced by the target ship's typed parts. Gated by
      // the settlement's own cadence. Accrues into the SAME hpDeltas the
      // ship volley uses, so it resolves simultaneously (a station and
      // its attacker can kill each other on the same tick). Settlements
      // never earn veterancy (no attackerShipId passed), matching the client.
      //
      // CITIES never return fire (civilian). STATIONS fire only once a
      // Weapons module is built. And both are STRICTLY DEFENSIVE: they
      // only shoot an armed hostile ship whose faction is actively
      // aggressing here (has an armed attack-stance ship — aggressorsAtBody),
      // never freighters, and never fire first on a warship parked in
      // defensive stance.
      const stlAggressors = aggressorsAtBody.get(bodyId) ?? new Set();
      for (const st of localSettlements) {
        if (st.type !== 'station') continue;               // cities never fire
        const weaponsLvl = weaponsLevelOf(st);
        if (weaponsLvl < 1) continue;                      // no guns until Weapons built
        const base = STATION_DMG_PER_WEAPONS_LEVEL * weaponsLvl;
        // COMBAT V2: stations fire every tick like everything else, and roll
        // on SETTLEMENT_SPEED — a station is mechanically a destroyer that
        // cannot move. The 8 -> 20 damage bump above pays for the roll.
        const shipTargets = ships.filter(t =>
          t.owner_faction_id !== st.owner_faction_id
          && !peace.has(pairKey(st.owner_faction_id, t.owner_faction_id))
          && t.ship_class !== 'freighter'                    // never fire on haulers
          && (t.damage_per_tick ?? 0) > 0                    // only armed hulls are threats
          && stlAggressors.has(t.owner_faction_id),          // defensive: only factions aggressing here
        );
        if (shipTargets.length === 0) continue;
        // Random, held until the target dies — same rule as ships (pickTarget).
        const target = pickTarget(st.id, st.last_target_id, shipTargets, tick);
        // Settlement guns fire kinetic, so a target's shields cut them
        // and armor does nothing — same counter-matrix as ship kinetic.
        const KINETIC = { kinetic: 1, energy: 0 };
        const power = base * kineticMulOf(st.owner_faction_id) * combatDamageMultOf(st.owner_faction_id);
        const warAuthMul = (await sanctioned(target.owner_faction_id, 'war_authorization')) ? 2 : 1;
        // Seeded on the settlement id so a station's roll is as reproducible
        // as a ship's.
        if (rollFor(st.id, tick) >= hitChance(speedOfSettlement(), speedOfShip(target))) {
          tallyShot('station', target.ship_class, false, 0, target.id, 0, st, target);
          firedSettlementIds.add(st.id);
          firedSettlementTargets.set(st.id, target.id);
          continue;
        }
        const mit = Math.max(MITIGATION_FLOOR,
          defenseMitigation(target._parts, KINETIC));
        const stnDealt = power * mit * warAuthMul;
        tallyShot('station', target.ship_class, true, stnDealt, target.id,
                  power * warAuthMul, st, target);
        addDamage(target.id, st.owner_faction_id, null, stnDealt);
        firedSettlementIds.add(st.id);
        firedSettlementTargets.set(st.id, target.id);
      }
    }

    // === 3.3b TRANSIT COMBAT (DESIGN-transit-combat.md) ===============
    //
    // A SEPARATE PASS, deliberately. The body loop above is untouched, so
    // two ships parked at the same body fight with exactly the numbers
    // they always have — flag on or off. This pass only ever handles
    // engagements where AT LEAST ONE party is in flight, which is
    // precisely R2's guardrail ("same body, or someone is moving"). The
    // two passes cannot both score the same pair.
    //
    // Ship-vs-ship only in v1. Settlements have range 0 (the defensive
    // umbrella was cut), and a raider glassing a city on a flyby would
    // walk straight through the rule that a fleet must be cleared before
    // what it defends can be touched.
    // ---- WEAPONS STATIONS -------------------------------------------
    //
    // Not the settlement gun. A settlement shoots what is standing on
    // top of it; this reaches out to a radius and fires on anything
    // hostile inside it, INCLUDING hulls in mid-burn. That is the whole
    // point of the structure — it is the only thing in the game that
    // denies an area rather than defending a spot.
    //
    // WHAT MAKES IT SPLIT A FLEET IS THE TARGET COUNT, not the damage.
    // Firing on one hull a tick means a swarm walks past and eats a
    // single loss; firing on three means you have to bring enough hulls
    // to saturate it, or lose three every tick you spend in the bubble.
    //
    // Strictly hostile-only, and never freighters — same restraint the
    // settlement guns show, so a station is a fortress rather than a
    // toll booth that shoots civilians.
    if (megaStations.length > 0) {
      const posOfShip = (sh) => {
        if (inTransitIds.has(sh.id)) {
          const plan = launchPlans.get(sh.id);
          if (!plan) return null;              // pre-0088 node: no plan
          const st8 = shipStateAt(plan, tick);
          return { x: st8.x, y: st8.y };
        }
        return bodyPosSync(sh.parent_body_id, tick);
      };

      for (const stn of megaStations) {
        const owner = stn.owner_faction_id;
        // A structure nobody owns has nobody to shoot for. Ancient gates
        // are the precedent: unowned means neutral, not hostile to all.
        if (!owner) continue;
        const sp = bodyPosSync(stn.body_id, tick);
        const eff = MEGASTRUCTURES[stn.kind]?.effect ?? {};
        const reach = (eff.range ?? 0) * megaRangeScale;
        if (reach <= 0) continue;
        const reach2 = reach * reach;

        const inRange = [];
        for (const t of allShips) {
          if ((t.hp ?? 0) <= 0) continue;
          if (t.owner_faction_id === owner) continue;
          if (peace.has(pairKey(owner, t.owner_faction_id))) continue;
          if (t.ship_class === 'freighter') continue;
          if ((t.damage_per_tick ?? 0) <= 0) continue;   // armed hulls only
          const tp = posOfShip(t);
          if (!tp) continue;
          const dx = tp.x - sp.x;
          const dy = tp.y - sp.y;
          if (dx * dx + dy * dy > reach2) continue;
          inRange.push({ ship: t, d2: dx * dx + dy * dy });
        }
        if (inRange.length === 0) continue;

        // Closest first. A station picking at random would let a player
        // walk a capital ship through the middle while it plinked at
        // something on the rim.
        inRange.sort((a, b) => a.d2 - b.d2);
        const nTargets = Math.max(1, eff.targets ?? 1);
        // WEAPONS RESEARCH REACHES THE STATION. kineticMulOf is the
        // currency split and combatDamageMultOf is a senate slider —
        // neither is tech, so before this the gun never improved and a
        // Weapons-10 faction fielded destroyers hitting six times
        // harder than the emplacement they paid 7,000 metal for.
        const stnTech = await techLevelsFor(owner);
        const dmg = stationDamage(eff.damagePerTick ?? 0, stnTech.weapons ?? 0)
          * kineticMulOf(owner) * combatDamageMultOf(owner);
        if (dmg <= 0) continue;

        // SHOTS BELONG TO THE STATION'S OWN BODY. currentCombatBodyId is
        // set at the top of the per-body loop above and never cleared,
        // so without this every station volley would be filed into
        // whichever body that loop happened to finish on — battle
        // records at Neptune for a station firing over Venus.
        currentCombatBodyId = stn.body_id;

        for (const { ship: target } of inRange.slice(0, nTargets)) {
          // Kinetic, like every other emplaced gun: shields cut it,
          // armor does not. Keeps the counter-matrix honest — an area
          // weapon that ignored fittings would make the defensive half
          // of the tree pointless inside its bubble.
          const KINETIC_MEGA = { kinetic: 1, energy: 0 };
          const warAuthMul = (await sanctioned(target.owner_faction_id, 'war_authorization')) ? 2 : 1;

          // THE ROLL. This pass had none, so a Weapons Station landed
          // every shot on the three closest hulls while every other
          // shooter in the game — ships, settlement guns — rolled to
          // hit. The most expensive emplacement was also the only one
          // that could not miss, which is not what 7,000 metal was
          // supposed to buy. It rolls on SETTLEMENT_SPEED for the same
          // reason a station does: it is a gun that cannot move.
          if (rollFor(stn.body_id, tick) >= hitChance(speedOfSettlement(), speedOfShip(target))) {
            tallyShot('weapons_station', target.ship_class, false, 0, target.id, 0, stn, target);
            megaFired.set(stn.body_id, target.id);
            continue;
          }

          const mit = Math.max(MITIGATION_FLOOR,
            defenseMitigation(target._parts, KINETIC_MEGA));
          const dealt = dmg * mit * warAuthMul;
          // Now the shot exists in the record. Before this, a station
          // could kill a destroyer and the battle card, the chronicle
          // and the combat telemetry all showed the hull dying to
          // nothing at all.
          tallyShot('weapons_station', target.ship_class, true, dealt, target.id,
                    dmg * warAuthMul, stn, target);
          addDamage(target.id, owner, null, dealt);
          megaFired.set(stn.body_id, target.id);
        }

        // COUNTER-BATTERY. If it shoots you, you may shoot back.
        //
        // A structure only took damage from hulls PARKED on it, and this
        // one reaches 700 units — so there was an annulus, most of a
        // system wide, in which it fired every tick and could not be
        // touched. The only counter was to fly to point-blank range and
        // sit there, which is not a counter, it is a toll.
        //
        // Everything it fired on this tick may answer, wherever it is,
        // including mid-burn: the shot proves the line of fire exists in
        // both directions. It rolls like any other attacker, against
        // SETTLEMENT_SPEED, so a corvette plinks and a destroyer hurts.
        // Nothing else in range joins in — you have to be shot at to
        // shoot back, which keeps a station dangerous to approach
        // rather than merely dangerous to notice.
        for (const { ship: shooter } of inRange.slice(0, nTargets)) {
          const back = Number(shooter.damage_per_tick) || 0;
          if (back <= 0) continue;
          if (rollFor(`${shooter.id}:cb`, tick) >= hitChance(speedOfShip(shooter), speedOfSettlement())) {
            tallyShot(shooter.ship_class, 'weapons_station', false, 0, stn.body_id, 0, shooter, null);
            continue;
          }
          // A structure carries no fittings, so no mitigation applies —
          // the same asymmetry bombardment has against settlements.
          const ret = back * ((await sanctioned(owner, 'war_authorization')) ? 2 : 1);
          tallyShot(shooter.ship_class, 'weapons_station', true, ret, stn.body_id, ret, shooter, null);
          megaReturn.set(stn.body_id, (megaReturn.get(stn.body_id) ?? 0) + ret);
          firedShipIds.add(shooter.id);
          firedShipTargets.set(shooter.id, stn.body_id);
        }
      }
      currentCombatBodyId = null;

      // Stamp what each station shot at. The FX layer reads this pair
      // the same way it reads a ship's, so a station now draws a tracer
      // to the hull it is actually engaging instead of killing things
      // in silence.
      for (const [siteId, targetId] of megaFired) {
        await this.env.DB
          .prepare(
            `UPDATE game_megastructures
                SET last_combat_tick = ?, last_target_id = ?
              WHERE body_id = ?`,
          )
          .bind(tick, targetId, siteId)
          .run();
      }

      // Return fire lands on the hull. Floored at zero; a structure at 0
      // is breached rather than destroyed — razing one is still a player
      // decision (handleSeizeSite), not something a volley does by
      // accident.
      for (const [siteId, amount] of megaReturn) {
        if (amount <= 0) continue;
        await this.env.DB
          .prepare('UPDATE game_megastructures SET hp = MAX(0, hp - ?) WHERE body_id = ?')
          .bind(amount, siteId)
          .run();
      }
    }

    if (transitCombatEnabled && inTransitIds.size > 0) {
      // Bodies positioned for this tick, for line of sight (R4).
      const losBodies = [];
      for (const b of allBodyRows) {
        const p = bodyPosSync(b.id, tick);
        losBodies.push({ x: p.x, y: p.y, radius: Number(b.radius ?? 0) });
      }

      // Planet systems, for the in-system range cut. A "planet" here is
      // anything orbiting the star directly — its sphere of influence is
      // the one that contains a moon system. Moons have their own SOI but
      // sit inside their parent's, so testing the parents is enough.
      const starIds = new Set(allBodyRows.filter(b => b.parent_body_id == null).map(b => b.id));
      const planetSois = allBodyRows
        .filter(b => b.parent_body_id != null && starIds.has(b.parent_body_id) && Number(b.soi) > 0)
        .map(b => {
          const p = bodyPosSync(b.id, tick);
          return { x: p.x, y: p.y, soi: Number(b.soi) };
        });
      const inPlanetSystem = (p) =>
        planetSois.some(s => Math.hypot(p.x - s.x, p.y - s.y) <= s.soi);

      // Segment per hull: where it is at tick start, where at tick end.
      // A parked ship inherits its body's motion (station-keeping), which
      // is what makes two hulls at one body have Δv exactly 0.
      const segments = new Map();
      for (const s of allShips) {
        if ((s.hp ?? 0) <= 0) continue;
        if (inTransitIds.has(s.id)) {
          const plan = launchPlans.get(s.id);
          if (!plan) continue;          // pre-0088 node: no plan, no participation
          const a = shipStateAt(plan, tick);
          const b = shipStateAt(plan, tick + 1);
          // How long ago this hull lit its engine. Drives the
          // parting-shot window below.
          const sinceDeparture = tick - Number(plan.startTick ?? tick);
          // ...and how long until it parks. The window below is meant to
          // cover BOTH ends of a trip; measuring only departure meant the
          // mirror case the design promises — arriving into a defended
          // orbit should hurt — could never fire, so a raider on a long
          // burn coasted through its target's guns on the approach tick.
          const untilArrival = Number(plan.arriveTick ?? Infinity) - tick;
          segments.set(s.id, {
            p0: a.pos, p1: b.pos, transit: true, sinceDeparture, untilArrival,
          });
        } else {
          // KNOWN APPROXIMATION, and a stage-2 blocker: a parked hull is
          // modelled at its body's CENTRE, but it really orbits at
          // parkOrbitRadius — 6-10 units out, the same order as the
          // 12-20 unit weapon ranges this pass compares against. So a
          // A parked hull sits on its PARK ORBIT, not at the body's
          // centre. That is 6-10 units — against weapon ranges of 12-20 —
          // so placing it at the centre could decide a passing contact
          // in or out of range on a position the client never drew.
          //
          // The period is not stored on the ship, but it is derivable
          // from the elements that are, exactly as the client derives it
          // (a = (rp+ra)/2, T = 2*pi*sqrt(a^3/mu)). One derivation,
          // shared — which is the whole contract of this feature.
          const parentRow = bodyRowById.get(s.parent_body_id);
          const mu = muOfRow(parentRow, s.parent_body_id === 'sol'
            || String(s.parent_body_id).endsWith(':sol'));
          const orbit = {
            rp: s.orbit_rp, ra: s.orbit_ra, omega: s.orbit_omega,
            m0: s.orbit_m0, epoch: s.orbit_epoch, direction: s.orbit_direction,
          };
          const l0 = shipOrbitLocalPosition(orbit, mu, tick);
          const l1 = shipOrbitLocalPosition(orbit, mu, tick + 1);
          const b0 = bodyPosSync(s.parent_body_id, tick);
          const b1 = bodyPosSync(s.parent_body_id, tick + 1);
          const p0 = { x: b0.x + l0.x, y: b0.y + l0.y };
          const p1 = { x: b1.x + l1.x, y: b1.y + l1.y };
          segments.set(s.id, { p0, p1, transit: false });
        }
      }

      // A SHOT BETWEEN WORLDS BELONGS TO NO BODY. currentCombatBodyId is
      // set at the top of the per-body loop and never cleared, so every
      // in-flight shot below was being filed into whichever body that
      // loop happened to iterate last — battle records at Earth for an
      // interception near Jupiter, with participant rows for hulls that
      // were never there. tallyShot skips battle bookkeeping when this
      // is null, which is the correct answer for open space; the
      // transitShots array is where these are recorded instead.
      currentCombatBodyId = null;

      const shipById = new Map(allShips.map(s => [s.id, s]));
      // Deterministic order so every replay resolves identically.
      const shooters = [...segments.keys()].sort();

      for (const attackerId of shooters) {
        const attacker = shipById.get(attackerId);
        if (!attacker || !(attacker.damage_per_tick > 0)) continue;
        // ONE VOLLEY PER HULL PER TICK, across both passes. A parked ship
        // with hostiles at its body AND a transit contact in range is in
        // scope for the body loop and for this one, and without this
        // guard it fires twice — with the same rollFor(id, tick) seed, so
        // the two shots aren't even independent. The body loop runs
        // first, so whatever it already engaged stands.
        if (firedShipIds.has(attackerId)) continue;
        const stance = effectiveStance(attacker);
        if (stance === 'hold') continue;
        // ARMED HULLS ONLY INITIATE (decision 1). Unarmed range is 0, so
        // this is belt-and-braces, but it is the rule that makes losing a
        // freighter while asleep survivable.
        const baseRange = SHIP_RANGE[attacker.ship_class] ?? 0;
        if (baseRange <= 0) continue;
        const aSeg = segments.get(attackerId);
        // Inside a planet system, reach is cut (see the knob above). The
        // scale a gun is sized for out between the planets is absurd in
        // among the moons.
        const range = inPlanetSystem(aSeg.p0) ? baseRange * transitRangeInSystemMul : baseRange;

        // Candidates: hostiles where at least one party is in flight.
        const contacts = [];
        for (const [defenderId, dSeg] of segments) {
          if (defenderId === attackerId) continue;
          if (!aSeg.transit && !dSeg.transit) continue;   // the body loop owns this pair

          // A SHIP UNDER WAY DOES NOT SNIPE ORBITS.
          //
          // Where exactly one party is parked, this is a hull leaving (or
          // arriving at) a defended body — the parting shot the design
          // wanted, and nothing more. Beyond a tick of burn it is a ship
          // crossing the system, and letting it keep trading fire with
          // things in orbit turns every passing freighter into artillery.
          //
          // Between two hulls both under way the window does not apply:
          // that is an interception, which is the whole point.
          const aParked = !aSeg.transit, dParked = !dSeg.transit;
          if (aParked !== dParked) {
            const flyer = aParked ? dSeg : aSeg;
            const leaving = (flyer.sinceDeparture ?? Infinity) <= TRANSIT_ORBIT_SHOT_TICKS;
            const arriving = (flyer.untilArrival ?? Infinity) <= TRANSIT_ORBIT_SHOT_TICKS;
            if (!leaving && !arriving) continue;
          }
          const defender = shipById.get(defenderId);
          if (!defender || (defender.hp ?? 0) <= 0) continue;
          if (defender.owner_faction_id === attacker.owner_faction_id) continue;
          if (peace.has(pairKey(attacker.owner_faction_id, defender.owner_faction_id))) continue;
          // Defensive stance returns fire only — and "currently
          // aggressing" has no body to key on out here, so require the
          // contact itself to be armed.
          if (stance === 'defensive' && !(defender.damage_per_tick > 0)) continue;

          // Cheap reject before the expensive one. Line of sight walks
          // every body in the system, and the overwhelming majority of
          // pairs are hundreds of units apart — running it eagerly on
          // each candidate cost a hypot per body per pair per tick. Test
          // geometry first, then only ask about occlusion for the
          // handful that were actually in range.
          const geom = engagement(
            { p0: aSeg.p0, p1: aSeg.p1, speed: speedOfShip(attacker), shipClass: attacker.ship_class },
            { p0: dSeg.p0, p1: dSeg.p1, speed: speedOfShip(defender) },
            { range, vRef: transitVRef,
              dvBonusMax: transitDvBonusMax,
              dvBonusStart: transitDvBonusStart,
              dvBonusFull: transitDvBonusFull },
          );
          if (!geom.engaged) continue;
          // R4: no line of sight, no engagement — which is also what
          // keeps this from leaking a hidden ship's position through a
          // tracer.
          if (!hasLineOfSight(aSeg.p0, dSeg.p0, losBodies)) continue;
          contacts.push({ defender, e: geom });
        }
        if (contacts.length === 0) continue;

        // Same priority ladder as the body loop: warships before
        // civilians. Within a tier, the CLOSEST approach — out here
        // "nearest in speed" has no meaning, but "who did I actually
        // nearly run into" does.
        const armed = contacts.filter(c => (c.defender.damage_per_tick ?? 0) > 0);
        const tier = armed.length > 0 ? armed : contacts;
        tier.sort((x, y) => (x.e.dMin - y.e.dMin) || (x.defender.id < y.defender.id ? -1 : 1));
        const pick = tier[0];
        const target = pick.defender;

        const rankMul = 1 + 0.01 * Math.max(0, attacker.rank ?? 0);
        const atkProfile = damageProfile(attacker._parts);
        const attackPower =
          attacker.damage_per_tick * attackerWeaponMul(attacker.owner_faction_id, atkProfile)
          * rankMul * combatDamageMultOf(attacker.owner_faction_id)
          * arrearsMulOf(attacker.owner_faction_id)
          * traitMul(attacker._traits ?? [], 'dmgMul')
          * auraMul(attacker.id, 'dmgMul');
        const warAuthMul = (await sanctioned(target.owner_faction_id, 'war_authorization')) ? 2 : 1;

        // ONE roll per attacker per tick, seeded on (attacker, tick) only
        // — same as the body loop, so replays and every client agree.
        if (rollFor(attacker.id, tick) >= pick.e.p) {
          tallyShot(attacker.ship_class, target.ship_class, false, 0, target.id,
                    0, attacker, target, atkProfile.energy);
          firedShipIds.add(attacker.id);
          firedShipTargets.set(attacker.id, target.id);
          transitShots.push({ attacker, target, e: pick.e, landed: false });
          continue;
        }
        const mit = Math.max(MITIGATION_FLOOR, defenseMitigation(target._parts, atkProfile));
        const dealt = attackPower * mit * warAuthMul;
        tallyShot(attacker.ship_class, target.ship_class, true, dealt, target.id,
                  attackPower * warAuthMul, attacker, target, atkProfile.energy);
        addDamage(target.id, attacker.owner_faction_id, attacker.id, dealt);
        firedShipIds.add(attacker.id);
        firedShipTargets.set(attacker.id, target.id);
        transitShots.push({ attacker, target, e: pick.e, landed: true });
      }
    }

    // Helper: return the faction id that dealt the most damage to `targetId`
    // this tick, breaking ties by insertion order. Used to credit kills.
    function topAttacker(targetId) {
      const entry = hpDeltas.get(targetId);
      if (!entry || entry.byFaction.size === 0) return null;
      let best = null;
      let bestDmg = -1;
      for (const [fid, dmg] of entry.byFaction) {
        if (dmg > bestDmg) { best = fid; bestDmg = dmg; }
      }
      return best;
    }

    // Mirror of the above but per-ship — returns the single attacker
    // ship id that landed the most damage on `targetId`. Used for
    // rank-up + combat history awards. Stationary settlements don't
    // populate `byShip` so they correctly never accrue veterancy.
    function topAttackerShip(targetId) {
      const entry = hpDeltas.get(targetId);
      if (!entry || entry.byShip.size === 0) return null;
      let best = null;
      let bestDmg = -1;
      for (const [sid, dmg] of entry.byShip) {
        if (dmg > bestDmg) { best = sid; bestDmg = dmg; }
      }
      return best;
    }

    // 3.35 METEOROIDS — sensor discovery, then belt restocking.
    //
    // Placed HERE because it needs `bodyPosSync`, the tick's memoised
    // orbit resolver, which is built for the transit-combat geometry
    // above. Running it earlier would mean resolving every body's
    // position a second time in the same tick.
    //
    // Both are best-effort and isolated: a survey pass failing must
    // never cost a player their tick, and neither result feeds anything
    // downstream. Discovery is idempotent (INSERT OR IGNORE on the
    // faction/body pair) and restocking is gated on a tick multiple, so
    // a retried tick cannot double up either one.
    try {
      const mt = await import('./meteoroidTick.js');
      // Sensor reach follows the map's spread, same as the fog in
      // state.js — otherwise a rock sits inside your visible area and
      // never gets surveyed, and the two passes disagree about sight.
      const sensorScale = Number(CFG?.system_scale) > 0 ? Number(CFG.system_scale) : 1;
      await mt.discoverMeteoroids(this.env, gameId, tick, bodyPosSync, sensorScale);
      // First light for any telescope that finished earlier this tick.
      for (const t of telescopeCompletions) {
        if (!t.factionId || !t.bodyId) continue;
        await mt.telescopeFirstLight(this.env, gameId, t.factionId, t.bodyId, tick, bodyPosSync);
      }
      // The restock stream is seeded from the game AND the tick, so it
      // is reproducible on replay rather than depending on wall clock.
      let a = 0;
      const seedStr = `${gameId}:restock:${tick}`;
      for (let i = 0; i < seedStr.length; i++) {
        a = Math.imul(a ^ seedStr.charCodeAt(i), 3432918353);
        a = (a << 13) | (a >>> 19);
      }
      const rand = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t2 = Math.imul(a ^ (a >>> 15), 1 | a);
        t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
        return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
      };
      await mt.replenishKuiper(this.env, gameId, tick, rand, bodyPosSync, sensorScale);
      // MANUAL MINING — hulls a player pointed at a rock by hand, with
      // no route and no autopilot. Same rate as the routed path on
      // purpose. holdCapFor is passed in so meteoroidTick stays free of
      // routeMath.
      await mt.runManualMining(this.env, gameId, tick, holdCapFor);
    } catch (e) {
      console.error('meteoroid pass failed', e, { gameId, tick });
    }

    // 3.4 Settlement damage resolution. Damage was accrued into
    //     `settlementDamage` during the volley loop above (ships
    //     bombarding hostile settlements with class damage,
    //     not the old flat 4/ship). Peace pacts already suppressed at
    //     accrual time. Here we just apply it + credit the kill to the
    //     top-damage faction, and stamp last_combat_tick on settlements
    //     that fired back so their cadence advances.
    const destroyedSettlements = [];
    // settlementId -> faction id that dealt the most damage (kill credit).
    const settlementKillers = new Map();
    for (const s of livingSettlements) {
      // Damage was accrued per-attacker in the ship volley loop above
      // (which already applies stance gating — see settlementTargets).
      const entry = settlementDamage.get(s.id);
      const rawIncoming = entry?.total ?? 0;
      const fired = firedSettlementIds.has(s.id);
      if (rawIncoming <= 0 && !fired) continue;   // untouched this tick

      // ORBITAL SHIELDS absorb first. The pool regenerates and structure
      // does not, which is the whole point: a raid should cost a defender
      // time, not a permanent amputation. Overflow past the shield spills
      // into structure in the SAME tick — a big enough volley still gets
      // through, so shields raise the bar rather than making a world
      // immortal.
      let shieldHp = Number(s.shield_hp ?? 0);
      let shieldDownTick = s.shield_down_tick ?? null;
      let absorbed = 0;
      if (rawIncoming > 0 && shieldHp > 0) {
        absorbed = Math.min(shieldHp, rawIncoming);
        shieldHp -= absorbed;
        // Stamp the collapse so the regen grace period starts from the
        // moment it broke, not from the last time anyone shot at it.
        if (shieldHp <= 0) shieldDownTick = tick;
      }
      const incoming = rawIncoming - absorbed;
      const newHp = Math.max(0, s.hp - incoming);
      const shieldChanged = absorbed > 0;
      if (incoming > 0 && newHp <= 0) {
        await this.env.DB
          .prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, last_combat_tick = ? WHERE id = ?')
          .bind(tick, tick, s.id)
          .run();
        destroyedSettlements.push(s);
        // Top-damage faction gets the kill credit (tie: first inserted).
        let topFid = null, topDmg = -1;
        for (const [fid, dmg] of entry.byFaction) {
          if (dmg > topDmg) { topFid = fid; topDmg = dmg; }
        }
        if (topFid) settlementKillers.set(s.id, topFid);
        // A settlement going down is a death in the battle record too. It
        // is usually the loss the whole engagement was ABOUT, and a recap
        // that only ever blew up ships would show the station simply
        // ceasing to be drawn.
        battleDeaths.set(s.id, { killerFactionId: topFid, bodyId: s.body_id });
      } else {
        // Survived (or only fired back): persist any hp loss + cadence.
        // last_damaged_tick stamps ONLY when damage actually landed —
        // COALESCE(NULL, …) preserves the old stamp on fire-only ticks.
        // (last_combat_tick must NOT double as this stamp: it gates the
        // return-fire cadence — see the note in worker/state.js.)
        // last_damaged_tick stamps when the SHIELD takes a hit too: from
        // the defender's side they are under fire either way, and the
        // urgent-alert logic keys off this. A shield quietly eating a
        // bombardment while the city reports "not damaged" would be a
        // worse lie than the 100%-HP false alarm this stamp replaced.
        const tookAnything = rawIncoming > 0;
        await this.env.DB
          .prepare(
            `UPDATE game_settlements
                SET hp = ?, last_combat_tick = ?,
                    last_damaged_tick = COALESCE(?, last_damaged_tick),
                    last_target_id = COALESCE(?, last_target_id),
                    shield_hp = ?, shield_down_tick = ?
              WHERE id = ?`,
          )
          .bind(
            newHp, fired ? tick : (s.last_combat_tick ?? tick),
            tookAnything ? tick : null,
            firedSettlementTargets.get(s.id) ?? null,
            shieldChanged ? shieldHp : Number(s.shield_hp ?? 0),
            shieldDownTick, s.id,
          )
          .run();
      }
    }

    // Chronicle each destroyed settlement so the log surfaces it.
    if (destroyedSettlements.length) {
      const now = Date.now();
      const touchedBodies = new Set();
      // Pre-fetch all the faction names we'll cite (owners + killers) in
      // one query — chronicling N settlements should be 1 round-trip for
      // names, not 2N.
      const factionIds = new Set();
      for (const s of destroyedSettlements) {
        if (s.owner_faction_id) factionIds.add(s.owner_faction_id);
        const k = settlementKillers.get(s.id);
        if (k) factionIds.add(k);
      }
      const factionNameById = new Map();
      if (factionIds.size > 0) {
        const ids = [...factionIds];
        const placeholders = ids.map(() => '?').join(',');
        const rows = (await this.env.DB
          .prepare(`SELECT id, name FROM game_factions WHERE id IN (${placeholders})`)
          .bind(...ids)
          .all()).results ?? [];
        for (const r of rows) factionNameById.set(r.id, r.name);
      }
      for (const s of destroyedSettlements) {
        touchedBodies.add(s.body_id);
        const body = await this.env.DB
          .prepare('SELECT name FROM game_bodies WHERE id = ?')
          .bind(s.body_id).first();
        const killerFid = settlementKillers.get(s.id) ?? null;
        const id = `c${tick}_setl_${s.id.slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
        const payload = JSON.stringify({
          settlement_id: s.id,
          // settlement_name was missing — without it the client log just
          // said "settlement_destroyed" with no way to identify which.
          settlement_name: s.name ?? null,
          settlement_type: s.type,
          body_id: s.body_id,
          body_name: body?.name ?? '?',
          owner_faction_name: factionNameById.get(s.owner_faction_id) ?? null,
          killer_faction_id: killerFid,
          killer_faction_name: killerFid ? (factionNameById.get(killerFid) ?? null) : null,
          // Adds weight to the loss beyond a bare name -- the client
          // flavor engine already had a {popLost} template slot wired
          // up (src/game/flavorEngine.ts) but nothing ever sent it.
          pop_lost: s.population ?? 0,
        });
        try {
          await this.env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'settlement_destroyed', ?, ?, ?, 'public', ?)`,
            )
            .bind(id, gameId, tick, s.owner_faction_id, s.body_id, payload, now)
            .run();
        } catch (e) { console.error('settlement chronicle failed', e); }
      }

      // Each touched body may have had ownership shift (the destroyed
      // settlement was its only one; or the destroyed faction's last;
      // or an opposing faction now has more). Recompute.
      for (const bodyId of touchedBodies) {
        try { await recomputeBodyOwnership(this.env.DB, gameId, bodyId); }
        catch (e) { console.error('recomputeBodyOwnership failed', e); }
      }

      // Construction dies with the yards. For each destroyed
      // settlement's (body, faction): if that faction has NO living
      // settlement left at the body, every in-flight and waiting build
      // order it had there is destroyed with the infrastructure — no
      // refund (the enemy blew it up; that's the cost of losing the
      // yard). Without this, builds were pure timers and ships kept
      // spawning at bodies whose shipyards were rubble.
      for (const s of destroyedSettlements) {
        try {
          const still = await this.env.DB
            .prepare(
              `SELECT 1 AS x FROM game_settlements
                WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
                  AND destroyed_at_tick IS NULL
                LIMIT 1`,
            )
            .bind(gameId, s.body_id, s.owner_faction_id)
            .first();
          if (still) continue; // they still hold ground here — base slot remains
          const axed = await this.env.DB
            .prepare(
              `UPDATE game_body_build_queue
                  SET cancelled_at_tick = ?
                WHERE game_id = ? AND body_id = ? AND faction_id = ?
                  AND cancelled_at_tick IS NULL`,
            )
            .bind(tick, gameId, s.body_id, s.owner_faction_id)
            .run();
          const lost = axed.meta?.changes ?? 0;
          if (lost > 0) {
            const body = await this.env.DB
              .prepare('SELECT name FROM game_bodies WHERE id = ?')
              .bind(s.body_id).first();
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'builds_destroyed', ?, ?, ?, 'public', ?)`,
              )
              .bind(
                `c${tick}_bldx_${s.body_id.slice(-6)}_${Math.random().toString(36).slice(2, 6)}`,
                gameId, tick, s.owner_faction_id, s.body_id,
                JSON.stringify({
                  body_name: body?.name ?? '?',
                  owner_faction_name: factionNameById.get(s.owner_faction_id) ?? null,
                  builds_lost: lost,
                }),
                now,
              )
              .run();
          }
        } catch (e) { console.error('build-cancel on settlement loss failed', e); }
      }
    }

    // 3.41 WAR BREAKS STANDING TRADE (Lorne). "Players go to war" has no
    // formal declaration in this game — no war flag, only pacts and
    // their absence — so the honest signal is the one a player would
    // recognise as war: shots actually exchanged between the pair this
    // tick. Both damage maps are fully accrued by this point (ships in
    // hpDeltas, settlements in settlementDamage), and both record WHO
    // dealt every point, so the pairs fall straight out — no new state,
    // no separate bookkeeping to drift out of sync with combat itself.
    //
    // Runs even when no agreements exist: the query inside no-ops on an
    // empty table, and gating it on a preflight count would be a second
    // thing to keep correct.
    try {
      const shipOwner = new Map(allShips.map(s => [s.id, s.owner_faction_id]));
      const settlementOwner = new Map(livingSettlements.map(s => [s.id, s.owner_faction_id]));
      const warPairs = [];
      for (const [targetId, entry] of hpDeltas) {
        const victimFid = shipOwner.get(targetId);
        if (!victimFid) continue;
        for (const attackerFid of entry.byFaction.keys()) {
          if (attackerFid && attackerFid !== victimFid) warPairs.push([attackerFid, victimFid]);
        }
      }
      for (const [sid, entry] of settlementDamage) {
        const victimFid = settlementOwner.get(sid);
        if (!victimFid) continue;
        for (const attackerFid of entry.byFaction.keys()) {
          if (attackerFid && attackerFid !== victimFid) warPairs.push([attackerFid, victimFid]);
        }
      }
      if (warPairs.length > 0) {
        const ta = await import('./tradeAgreements.js');
        await ta.endAgreementsForCombat(this.env, gameId, warPairs, tick);
      }
    } catch (e) {
      console.error('war-breaks-trade check failed', e);
    }

    // 3.42 Orbital shield regen. Must run AFTER §3.4 above, which is
    //      where incoming damage actually spends the pool: this refills
    //      what survived the volley. It previously sat up at §2c-pre,
    //      ~1200 lines earlier, so every shielded city was topped up
    //      immediately BEFORE being shot — handing the defender a tick of
    //      regen they had not earned and making the effective pool
    //      (stored + regen) against every volley.
    //
    //      Its own try/catch, not shared with the asteroid-impact pass it
    //      used to ride along with: an impact throwing must not silently
    //      stop shield regen game-wide, and the error must be logged
    //      under its own name.
    try {
      await this.resolveShields(gameId, tick, CFG);
    } catch (e) {
      console.error('resolveShields failed', e);
    }

    // 3.45 Ship maintenance — heal + refuel at friendly infrastructure.
    //      Mirrors src/game/maintenance.ts tickMaintenance. Three rules:
    //        (a) base refuel +1: ship parked at a body YOU own (logistics
    //            presence — flag-on-the-pole signal, not infrastructure).
    //        (b) per city you own at the body: +2 HP, no fuel.
    //        (c) per station you own at the body: +1 HP and +2 fuel.
    //      Rules (b)+(c) don't gate on body ownership — your settlements
    //      service your hulls even on contested moons. Heal cap is the
    //      rank-boosted max (rank +1% each), so veteran ships fill in
    //      their extra HP buffer over time. Refuel cap is the per-class
    //      fuel_max stored at spawn.
    //
    //      Skipped for ships in transit (they're not orbiting any body's
    //      infrastructure).
    // Station is the SOLE repair source (cities don't heal hulls).
    //
    // Repair now scales with the station's SHIPYARD level — +5 HP/tick
    // per level (Lorne). The old flat +2 was set when hulls topped out
    // around 200 HP; combat v2 put destroyers at 1184 base and defense
    // tech multiplies that (a real hull seen at 367/1660), so a wreck
    // needed ~650 ticks — most of a month at 1h/tick — to come back.
    // Tying the rate to the yard also makes the building mean something
    // past unlocking construction: a level-6 yard heals 30/tick and
    // turns that same wreck around in ~43.
    const REPAIR_CITY = 0;
    // Each shipyard level MULTIPLIES the station's repair rate rather than
    // adding to it. NOTE for balance: building level is not capped, so this
    // keeps tripling -- L5 is 486/tick, L6 is 1458. That is deliberate as
    // asked, but it is the knob to watch if yards ever go that high.
    const REPAIR_YARD_MULT = 3;
    /** What the first shipyard level adds, before tripling. */
    const REPAIR_YARD_STEP = 5;
    /** A station with no shipyard is still a dry dock, just a bare one. */
    const REPAIR_STATION_BASE = 5;
    /** Kept for the armor-5 Damage Control trickle, which is a faction
     *  buff rather than infrastructure and shouldn't scale with a yard
     *  the ship isn't parked at. */
    /** Defense-5 perk: a flat bonus on top of whatever the station gives.
     *  Was expressed as REPAIR_STATION / 2 with its own copy of the base
     *  rate -- two constants that looked like duplicates and were not, so
     *  raising the base would have silently doubled a tech perk. */
    const REPAIR_ARMOR5_BONUS = 1;
    const REFUEL_BASE = 1;
    const REFUEL_STATION = 2;
    // One ship-row fetch with the joinable owner-status data. status='active'
    // excludes ships destroyed earlier in this same tick; transit-state
    // is encoded as parent_body_id pointing at the source body even
    // while in flight, so we filter on the route-state column the
    // alarm uses elsewhere. The schema doesn't have a single 'in_transit'
    // bool — the existence of an in_transit ship_node is the signal —
    // so we cheat and detect transit via `has_pending_arrival_at_tick`
    // joined from game_ship_nodes (cheap, indexed). Ships in transit
    // get zero maintenance.
    const maintShips = (await this.env.DB
      .prepare(
        `SELECT s.id, s.owner_faction_id, s.parent_body_id, s.hp, s.hp_max,
                -- ship_class + parts_json feed the field-tender pass below:
                -- a parked freighter with a Repair Bay heals its neighbours.
                s.ship_class, s.parts_json,
                -- Captain-only veterancy: rank raises the repair ceiling
                -- (+1%/rank), and an uncrewed hull earns none.
                s.fuel, s.fuel_max, COALESCE(c.rank, 0) AS rank,
                c.traits_json AS captain_traits,
                b.owner_faction_id AS body_owner,
                (SELECT 1 FROM game_ship_nodes n
                  WHERE n.ship_id = s.id
                    AND n.game_id = ?1
                    AND n.status = 'in_transit'
                  LIMIT 1) AS in_transit
           FROM game_ships s
           LEFT JOIN game_captains c ON c.id = s.captain_id
           JOIN game_bodies b ON b.id = s.parent_body_id
          WHERE s.game_id = ?1 AND s.status = 'active'`,
      )
      .bind(gameId)
      .all()).results ?? [];
    // Settlement-by-body lookup — we need every settlement at each body
    // the player has a ship at, filtered to "owned by the same faction".
    // Cheaper to fetch once and group than to subquery per-ship.
    const settlementsByBody = new Map();
    const allSettlements = (await this.env.DB
      .prepare(
        `SELECT id, body_id, owner_faction_id, type, buildings_json
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];
    for (const st of allSettlements) {
      if (!settlementsByBody.has(st.body_id)) settlementsByBody.set(st.body_id, []);
      settlementsByBody.get(st.body_id).push(st);
    }
    // Captain traits and the effective HP ceiling, resolved ONCE per hull.
    // The ceiling is base × rank (+1%/kill) × armor tech (+8%/lvl) ×
    // Bulwark trait × Bulwark aura, and it has to exist before the loop
    // because the tender triage below ranks hulls by how close to death
    // they are — which is meaningless without knowing each one's max.
    const traitsOf = new Map();
    const effMaxHpOf = new Map();
    for (const s of maintShips) {
      const t = parseTraits(s.captain_traits);
      traitsOf.set(s.id, t);
      effMaxHpOf.set(s.id, (s.hp_max ?? 0)
        * (1 + 0.01 * Math.max(0, s.rank ?? 0))
        * armorMulOf(s.owner_faction_id)
        * traitMul(t, 'hpMul')
        * auraMul(s.id, 'hpMul'));
    }
    // FIELD TENDERS (Defense 4). A Repair Bay works ONE PATIENT AT A TIME:
    // it picks the friendly hull in its orbit that is closest to death and
    // stays on it. Two bays at a body means two patients, not one hull
    // healed twice — a tender is a crew and a dry dock, not a damage
    // number sprayed over a fleet.
    //
    // Triage is by HP FRACTION, not missing HP: "worst off" is what a
    // player reads off a health bar, and ranking by absolute damage would
    // park every tender on the biggest hull present regardless of whether
    // it was actually in danger. Ties break on ship id so the choice is
    // stable tick to tick and identical on every replay — a tender that
    // flickers between two patients heals neither in any legible way.
    //
    // Keyed by `${bodyId}|${factionId}`: repair is a FRIENDLY service, so
    // a rival's tender parked at the same moon does nothing for you. Ships
    // in transit are excluded on both sides — a bay under way is a bay in
    // a crate, and the loop below already refuses to service a moving hull.
    //
    // The tender is a candidate for its own bay. No special case: if it is
    // the worst-off hull in the orbit it patches itself, which also means
    // shooting the tender degrades the whole fleet's repair.
    const parkedByGroup = new Map();
    const baysByGroup = new Map();
    for (const s of maintShips) {
      if (s.in_transit) continue;
      const key = `${s.parent_body_id}|${s.owner_faction_id}`;
      if (!parkedByGroup.has(key)) parkedByGroup.set(key, []);
      parkedByGroup.get(key).push(s);
      if (s.ship_class !== 'freighter') continue;
      const bays = countPart(parsePartsJson(s.ship_class, s.parts_json), 'repair');
      if (bays > 0) baysByGroup.set(key, (baysByGroup.get(key) ?? 0) + bays);
    }
    /** Ship ids a tender is working on this tick. */
    const tenderPatients = new Set();
    for (const [key, bays] of baysByGroup) {
      const hurt = (parkedByGroup.get(key) ?? [])
        // A bay is never spent on a hull that is already full — it moves
        // to the next-worst instead, so N bays always find N patients if
        // N damaged hulls exist.
        .filter((s) => {
          const max = effMaxHpOf.get(s.id) ?? 0;
          return max > 0 && (s.hp ?? max) < max - 1e-6;
        })
        .sort((a, b) => {
          const fa = (a.hp ?? 0) / (effMaxHpOf.get(a.id) || 1);
          const fb = (b.hp ?? 0) / (effMaxHpOf.get(b.id) || 1);
          if (fa !== fb) return fa - fb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      for (const s of hurt.slice(0, bays)) tenderPatients.add(s.id);
    }
    // Repair economy counter (migration 0069) — flushed after the loop.
    let hpRepairedThisTick = 0;
    for (const ship of maintShips) {
      if (ship.in_transit) continue;
      const localStations = (settlementsByBody.get(ship.parent_body_id) ?? [])
        .filter(st => st.owner_faction_id === ship.owner_faction_id);
      // Station-only repair: hull HP regen requires a friendly STATION
      // in orbit (the orbital repair infrastructure). Cities no longer
      // heal ships — they're surface industry, not a dry dock. Base
      // refuel (owning the body) stays as a small logistics presence.
      let repairRate = 0;
      let refuelRate = ship.body_owner === ship.owner_faction_id ? REFUEL_BASE : 0;
      for (const st of localStations) {
        if (st.type === 'station') {
          // Bare station repairs at the base rate; every shipyard level
          // TRIPLES it (see REPAIR_YARD_MULT).
          let yardLvl = 0;
          if (st.buildings_json) {
            try { yardLvl = Number(JSON.parse(st.buildings_json)?.shipyard ?? 0) || 0; }
            catch { yardLvl = 0; }
          }
          // TRIPLES PER LEVEL (Lorne, 2026-08-19): "my destroyer is going to
          // take 2 weeks to repair at my level 2 shipyard". It was
          // BASE + 5*level -- linear, so 2/7/12/17, and a 1658-HP destroyer
          // needed ~138 ticks at a level-2 yard. Geometric now:
          //   bare 2, L1 6, L2 18, L3 54, L4 162
          // which takes that same destroyer from 138 ticks to 92 at L2 and
          // 31 at L3. A yard is an investment and now repairs like one.
          // The YARD'S CONTRIBUTION triples, on top of the bare dry dock.
          // First cut was BASE * 3^level, which tripled correctly but made
          // level 1 WORSE than the additive rate it replaced (6 vs 7) --
          // caught because a destroyer at a level-1 yard reported +6/t. The
          // bare station keeps its 2, and each level triples the 5 the old
          // formula added once: 2, 7, 17, 47, 137.
          repairRate += REPAIR_STATION_BASE + (yardLvl > 0
            ? REPAIR_YARD_STEP * Math.pow(REPAIR_YARD_MULT, yardLvl - 1)
            : 0);
          refuelRate += REFUEL_STATION;
        }
      }
      // Damage Control (armor 5, project_intel_gating): hulls of a
      // researched faction self-repair a trickle ANYWHERE — mid-fight,
      // deep space, no dry dock required. Half the station rate, and it
      // stacks with a station when parked at one.
      if (hasBuff(ship.owner_faction_id, 'armor', 5)) repairRate += REPAIR_ARMOR5_BONUS;
      // Field tender (armor 4): a bay in this orbit picked THIS hull as its
      // patient. One bay, one ship — see the triage above. Stacks with a
      // station and with Damage Control; a tender sitting in a home dry
      // dock is redundant, which is the point: you fly it out.
      if (tenderPatients.has(ship.id)) repairRate += REPAIR_TENDER_PER_BAY;
      const shipTraits = traitsOf.get(ship.id) ?? parseTraits(ship.captain_traits);
      // Wrench captain (spec §3): ×1.5 repair rate.
      repairRate *= traitMul(shipTraits, 'repairMul');
      if (repairRate <= 0 && refuelRate <= 0) continue;
      // Effective HP cap = base × rank (+1%/kill) × armor tech (+8%/level)
      // × Bulwark captain (+10%). Rank is the CAPTAIN's (COALESCEd in the
      // SELECT); the client mirrors all of this in effectiveShipMaxHp.
      // Resolved in the pre-pass above so the tender triage and this loop
      // read one number — two derivations would let a bay pick a patient
      // by one ceiling and heal it toward a different one.
      repairRate *= auraMul(ship.id, 'repairMul');   // Wrench flag aura
      const effectiveMaxHp = effMaxHpOf.get(ship.id) ?? 0;
      const newHp = Math.min(effectiveMaxHp, (ship.hp ?? effectiveMaxHp) + repairRate);
      const newFuel = Math.min(ship.fuel_max ?? 0, (ship.fuel ?? 0) + refuelRate);
      // Repair economy telemetry: HP actually restored, not the rate the
      // yard offers — a hull already at its ceiling heals nothing.
      hpRepairedThisTick += Math.max(0, newHp - (ship.hp ?? newHp));
      if (newHp === ship.hp && newFuel === ship.fuel) continue;
      await this.env.DB
        .prepare('UPDATE game_ships SET hp = ?, fuel = ? WHERE id = ?')
        .bind(newHp, newFuel, ship.id)
        .run();
    }
    if (hpRepairedThisTick > 0) {
      // Best-effort like the rest of the telemetry — an un-migrated
      // isolate must not fail a tick over a counter.
      try {
        await this.env.DB
          .prepare(
            `INSERT INTO game_combat_stats (game_id, stat, value) VALUES (?, 'hp_repaired', ?)
             ON CONFLICT(game_id, stat) DO UPDATE SET value = value + excluded.value`,
          )
          .bind(gameId, hpRepairedThisTick)
          .run();
      } catch (e) { console.error('repair stat flush failed', e); }
    }

    // 3.5 Per-tick yield distribution.
    //
    // Replaces the previous "every 10 ticks harvest to stockpile +
    // every tick collector delivery to pool" two-pass system with a
    // single per-tick split:
    //
    //   With collector    : 100% of effective yield -> faction pool
    //   Without collector : 10% to faction pool + 90% to local stockpile
    //
    // Local stockpile (LOCAL bucket on the HUD) is freighter-vacuumable
    // and spendable on local body builds — it isn't dead weight. The
    // 10% trickle ensures even uncollectered worlds contribute SOMETHING
    // to the empire pool every tick so the player doesn't sit at zero
    // income until they build the first collector.
    //
    // Effective yield = base body yield * popMult * typeMult * buildingMults.
    // Buildings: forge boosts metal, mint boosts gold, lab boosts science.
    // Population is still grown by the POP_GROWTH_INTERVAL pass below.
    // BOTH OF THESE WERE HARDCODED and shadowed live config knobs — a host
    // could set pop_max to 50 in the editor and nothing happened, the same
    // dead-knob class as victory_ships. Now read from config, with the old
    // constants as the fallback.
    //
    // pop_max 0 = UNCAPPED (Lorne): a world you hold keeps growing for as
    // long as you hold it. Safe to uncap because the yield bonus is LINEAR
    // in population — popMul = 1 + rate x (pop-1) — so a settlement at pop
    // 30 earns 3.9x base, not 30x. Growth is one point per interval, so
    // this is a slow compounding reward for holding ground rather than a
    // runaway.
    const POP_GROWTH_INTERVAL = Math.max(1, Number(CFG.pop_growth_interval ?? 20));
    const POP_MAX_RAW = Number(CFG.pop_max ?? 10);
    const POP_MAX = (Number.isFinite(POP_MAX_RAW) && POP_MAX_RAW > 0)
      ? POP_MAX_RAW
      : Infinity;
    const settlements = (await this.env.DB
      .prepare(
        `SELECT s.id, s.owner_faction_id AS fid, s.body_id, s.type, s.population,
                s.last_growth_tick, s.buildings_json,
                b.terraformed_at_tick,
                b.yield_metal, b.yield_fuel, b.yield_gold, b.yield_science
           FROM game_settlements s
           JOIN game_bodies b ON b.id = s.body_id
          WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];

    // Population growth pass — independent of yield cadence.
    for (const s of settlements) {
      const lastGrowth = s.last_growth_tick ?? 0;
      if (tick - lastGrowth < POP_GROWTH_INTERVAL) continue;
      if ((s.population ?? 1) >= POP_MAX) {
        await this.env.DB
          .prepare('UPDATE game_settlements SET last_growth_tick = ? WHERE id = ?')
          .bind(tick, s.id).run();
        continue;
      }
      await this.env.DB
        .prepare('UPDATE game_settlements SET population = population + 1, last_growth_tick = ? WHERE id = ?')
        .bind(tick, s.id).run();
      s.population = (s.population ?? 1) + 1;
    }

    // Passive settlement auto-repair. A settlement that hasn't TAKEN
    // damage within REPAIR_GRACE_TICKS regenerates toward max HP, so a
    // base mends between raids with no build action. "Under attack" =
    // damaged within the grace window (last_damaged_tick, migration
    // 0044). The old justification was "grace >= the combat cadence (3)";
    // under COMBAT V2 the cadence is 1, so the grace is now a pure design
    // choice about how fast a base mends between raids, not a derived value. A
    // settlement under sustained bombardment never heals mid-siege. Heal
    // scales with max HP (~6%/tick, min 3) so a big city and a small
    // station both mend at a sensible pace. Runs AFTER combat resolution
    // this tick, so anything just hit has last_damaged_tick = tick.
    const REPAIR_GRACE_TICKS = 3;
    try {
      const hurt = (await this.env.DB
        .prepare(
          `SELECT id, hp, hp_max, last_damaged_tick FROM game_settlements
            WHERE game_id = ? AND destroyed_at_tick IS NULL AND hp < hp_max
              AND (last_damaged_tick IS NULL OR ? - last_damaged_tick >= ?)`,
        )
        .bind(gameId, tick, REPAIR_GRACE_TICKS)
        .all()).results ?? [];
      for (const s of hurt) {
        const maxHp = Number(s.hp_max ?? 0);
        if (maxHp <= 0) continue;
        const rate = Math.max(3, Math.ceil(maxHp * 0.06));
        const newHp = Math.min(maxHp, Number(s.hp ?? 0) + rate);
        await this.env.DB
          .prepare('UPDATE game_settlements SET hp = ? WHERE id = ?')
          .bind(newHp, s.id)
          .run();
      }
    } catch (e) {
      console.error('settlement auto-repair pass failed', e);
    }

    // Yield multipliers — kept in sync with src/game/settlements.ts.
    const YIELD_MULT_PER_POP = CFG.yield_mult_per_pop;
    const FORGE_PER_LEVEL = CFG.forge_per_level;
    const MINT_PER_LEVEL  = CFG.mint_per_level;
    const LAB_PER_LEVEL   = CFG.lab_per_level; // parity with forge/mint (economy rework §1.2)
    const TYPE_MUL_CITY    = { fuel: 1.0, metal: 1.2, gold: 1.0, science: 0.8 };
    const TYPE_MUL_STATION = { fuel: 1.1, metal: 0.8, gold: 1.0, science: 1.4 };
    const NO_COLLECTOR_POOL_FRACTION = CFG.no_collector_pool_fraction;       // 10% to faction pool
    const NO_COLLECTOR_STOCK_FRACTION = 1 - CFG.no_collector_pool_fraction;       // 90% to local stockpile

    // Aggregate per-faction pool deltas; apply per-(body,faction)
    // stockpile deltas individually. Wrapped: yield distribution must
    // NEVER kill resolveTick (combat, dyson, victory all run after).
    try {
      const perFactionPool = new Map();

      // Per-body local stockpile pre-pass. Lorne's call: ONE local
      // pool per body, shared between a city and any stations of the
      // same faction at that body. A TERRAFORMED body routes the WHOLE
      // group's yield 100% to pool; otherwise the group's 90% stockpile
      // share gets written to the primary holder (prefer city → fall
      // back to station). This is what makes a station's yield reach
      // the city's local pile instead of stranding in a separate
      // station-only stockpile. Keyed (body, faction) so two factions
      // sharing a body still keep their stockpiles independent.
      const groupKey = (s) => `${s.body_id}|${s.fid}`;
      const groupPrimary = new Map(); // groupKey -> { id, type }
      for (const s of settlements) {
        const k = groupKey(s);
        const cur = groupPrimary.get(k);
        // Prefer 'city' as the stockpile holder. If there's no city
        // (gas-giant cases like clownking's Neptune), the station's own
        // row collects — same row that already shows in the inspector.
        if (!cur || (cur.type === 'station' && s.type === 'city')) {
          groupPrimary.set(k, { id: s.id, type: s.type });
        }
      }
      // Per-group stockpile accumulators so a city + station at the
      // same body write ONE UPDATE to the primary's row instead of two.
      const perGroupStock = new Map(); // groupKey -> { targetId, f, m, g, sc }

      for (const s of settlements) {
        const tm = s.type === 'city' ? TYPE_MUL_CITY : TYPE_MUL_STATION;
        const popMul = 1 + YIELD_MULT_PER_POP * Math.max(0, Number(s.population ?? 1) - 1);
        let bld = {};
        if (s.buildings_json) { try { bld = JSON.parse(s.buildings_json) ?? {}; } catch { bld = {}; } }
        // COMPOUNDING yield per level (1.25^n), not additive (1+0.25n).
        // Costs scale 1.6^n, so with a flat +0.25 return each level cost
        // 1.6x more for the SAME increment — by L8 you paid 27x more
        // metal per unit of yield than at L1. Players correctly stopped
        // upgrading around L4 and the surplus piled up with nowhere to
        // go. Compounding keeps the curve diminishing (1.6 cost vs 1.25
        // yield) while leaving deep levels genuinely worth buying, which
        // turns buildings back into the economy's long sink.
        // KEEP IN SYNC with settlementYield() in src/game/settlements.ts.
        const forgeMul = Math.pow(1 + FORGE_PER_LEVEL, Number(bld.forge ?? 0));
        const mintMul  = Math.pow(1 + MINT_PER_LEVEL,  Number(bld.mint  ?? 0));
        const labMul   = Math.pow(1 + LAB_PER_LEVEL,   Number(bld.lab   ?? 0));
        // Senate production sanction: while active, the target faction's
        // settlement yields are halved across every resource at the
        // source. Hits both pool and stockpile pathways uniformly so the
        // sanction is felt the same whether the settlement has a
        // collector or not. Cached per faction so a sanctioned player
        // with 30 settlements still does 1 lookup, not 30.
        // Mirrors PROD_SANCTION_MULTIPLIER in worker/senate.js — keep
        // these two values in sync.
        const prodMul = (await sanctioned(s.fid, 'production_sanction')) ? 0.5 : 1;
        // Industry tech: +10%/level to ALL resource yields for the
        // owning faction (mirrors src/game/techs.ts yieldModifier, which
        // SP applies via tickSettlements). Previously the server ignored
        // tech entirely, so an industry-teched empire's income silently
        // reverted to base the moment /state reconciled.
        const indMul = industryMulOf(s.fid);
        const yieldFull = {
          // Senate yield sliders ride at the END of each chain, so a law
          // scales the finished number rather than fighting the building
          // multipliers for position.
          fuel:    Number(s.yield_fuel    ?? 0) * popMul * tm.fuel              * prodMul * indMul * fuelYieldMultOf(s.fid),
          metal:   Number(s.yield_metal   ?? 0) * popMul * tm.metal   * forgeMul * prodMul * indMul * metalYieldMultOf(s.fid),
          gold:    Number(s.yield_gold    ?? 0) * popMul * tm.gold    * mintMul  * prodMul * indMul * goldYieldMultOf(s.fid),
          science: Number(s.yield_science ?? 0) * popMul * tm.science * labMul   * prodMul * indMul * scienceYieldMultOf(s.fid),
        };

        // Collector status is now per (body, faction) group — see
        // pre-pass above. A city's collector covers any station at the
        // same body, and vice versa.
        const gk = groupKey(s);
        // Terraformed world => 100% to pool. Raw => 10/90 split. The
        // body row rides in on the settlement join, so no extra query.
        const bodyTerraformed = s.terraformed_at_tick != null;
        const toPoolFraction  = bodyTerraformed ? 1.0 : NO_COLLECTOR_POOL_FRACTION;
        const toStockFraction = bodyTerraformed ? 0.0 : NO_COLLECTOR_STOCK_FRACTION;

        const poolDelta = {
          fuel:    yieldFull.fuel    * toPoolFraction,
          metal:   yieldFull.metal   * toPoolFraction,
          gold:    yieldFull.gold    * toPoolFraction,
          science: yieldFull.science * toPoolFraction,
        };
        const agg = perFactionPool.get(s.fid) ?? { fuel: 0, metal: 0, gold: 0, science: 0 };
        agg.fuel    += poolDelta.fuel;
        agg.metal   += poolDelta.metal;
        agg.gold    += poolDelta.gold;
        agg.science += poolDelta.science;
        perFactionPool.set(s.fid, agg);

        if (toStockFraction > 0) {
          const sf = Math.round(yieldFull.fuel    * toStockFraction);
          const sm = Math.round(yieldFull.metal   * toStockFraction);
          const sg = Math.round(yieldFull.gold    * toStockFraction);
          const ss = Math.round(yieldFull.science * toStockFraction);
          if (sf + sm + sg + ss > 0) {
            // Accumulate into the GROUP's primary stockpile holder.
            // Two settlements at the same body (city + station) feed
            // ONE UPDATE on the city's row below. If no city is
            // present (gas-giant body) the station's own row collects.
            const primary = groupPrimary.get(gk);
            const targetId = primary?.id ?? s.id;
            const agg = perGroupStock.get(gk) ?? { targetId, f: 0, m: 0, g: 0, sc: 0 };
            agg.f  += sf;
            agg.m  += sm;
            agg.g  += sg;
            agg.sc += ss;
            perGroupStock.set(gk, agg);
          }
        }
      }

      // Flush per-group stockpile UPDATEs — one per (body, faction)
      // rather than one per settlement, so a city + station combine
      // into a single write at the city's row.
      for (const [, agg] of perGroupStock) {
        if (agg.f + agg.m + agg.g + agg.sc <= 0) continue;
        await this.env.DB
          .prepare(
            `UPDATE game_settlements
                SET stockpile_fuel    = stockpile_fuel    + ?,
                    stockpile_metal   = stockpile_metal   + ?,
                    stockpile_gold    = stockpile_gold    + ?,
                    stockpile_science = stockpile_science + ?
              WHERE id = ?`,
          )
          .bind(agg.f, agg.m, agg.g, agg.sc, agg.targetId)
          .run();
      }

      // Apply pool deltas — one UPDATE per faction, carrying sub-integer
      // fractions in the *_remainder columns (migration 0028) instead of
      // Math.round-and-dropping them. The old rounding silently destroyed
      // the entire income of small non-collector colonies: a body giving
      // e.g. 0.4 science/tick to the pool rounded to 0 EVERY tick,
      // forever — defeating the documented "even uncollectered worlds
      // contribute SOMETHING every tick" 10% trickle. `CAST(x AS INTEGER)`
      // truncates toward zero in SQLite; deltas are non-negative (yields),
      // so truncate == floor. new_pool += floor(remainder + delta);
      // new_remainder = (remainder + delta) - floor(remainder + delta).
      for (const [fid, delta] of perFactionPool) {
        // Record science income BEFORE the zero-delta skip, so a faction
        // whose only income is science still registers a rate.
        // ADDITIVE: a trade-route delivery may already have registered
        // science income for this faction earlier in the tick (see the
        // freighter dropoff). A bare .set() clobbered it, so delivered
        // science never advanced research.
        if (delta.science > 0) {
          scienceIncomeByFaction.set(fid, (scienceIncomeByFaction.get(fid) ?? 0) + delta.science);
        }
        if (delta.fuel + delta.metal + delta.gold + delta.science <= 0) continue;
        await this.env.DB
          .prepare(
            `UPDATE game_factions SET
               fuel    = fuel    + CAST(fuel_remainder    + ? AS INTEGER),
               metal   = metal   + CAST(metal_remainder   + ? AS INTEGER),
               gold    = gold    + CAST(gold_remainder    + ? AS INTEGER),
               science = science + CAST(science_remainder + ? AS INTEGER),
               fuel_remainder    = (fuel_remainder    + ?) - CAST(fuel_remainder    + ? AS INTEGER),
               metal_remainder   = (metal_remainder   + ?) - CAST(metal_remainder   + ? AS INTEGER),
               gold_remainder    = (gold_remainder    + ?) - CAST(gold_remainder    + ? AS INTEGER),
               science_remainder = (science_remainder + ?) - CAST(science_remainder + ? AS INTEGER)
             WHERE id = ?`,
          )
          .bind(
            delta.fuel, delta.metal, delta.gold, delta.science,
            delta.fuel, delta.fuel, delta.metal, delta.metal,
            delta.gold, delta.gold, delta.science, delta.science,
            fid,
          )
          .run();
      }
    } catch (e) {
      console.error('per-tick yield distribution failed (non-fatal)', e);
    }

    // === Fleet upkeep (DESIGN-fleet-economy §1) ===
    //
    // Runs AFTER yield distribution (this tick's income lands first) and
    // BEFORE the research drain (warships outrank lab budgets). Every
    // active hull bills per-tick maintenance; what a faction can't pay
    // lands in game_factions.arrears_* and the whole fleet fights at 75%
    // damage (arrearsMulOf in the volley, which reads LAST tick's ledger
    // — combat resolves earlier in this pass) until income clears the
    // debt. Civ model on purpose: no HP penalty (HP is stored absolute —
    // a cap change would desync every hull), no ship destruction, no
    // manual repayment step. Fractional bills (corvette 0.25c) accumulate
    // in the upkeep_carry_* columns until a whole unit is due, so pools
    // stay integers and a lone corvette bills 1 gold every 4th tick.
    try {
      // Resolved per faction inside the ledger loop below — an upkeep law
      // can now name one target, so there is no single match-wide value.
      // KEEP IN SYNC with SHIP_UPKEEP in src/game/shipClasses.ts.
      // 2026-08-02 rebalance: frigate 1/1 → 0.5/0.5, destroyer 2/2 → 1/1
      // (first playtest read the original bill as too steep).
      const UPKEEP = {
        corvette:  { gold: CFG.upkeep_corvette_gold,  metal: 0 },
        frigate:   { gold: CFG.upkeep_frigate_gold,   metal: CFG.upkeep_frigate_metal },
        destroyer: { gold: CFG.upkeep_destroyer_gold, metal: CFG.upkeep_destroyer_metal },
        freighter: { gold: CFG.upkeep_freighter_gold, metal: 0 },
        colony:    { gold: 0, metal: 0 },
      };
      const round3 = (n) => Math.round(n * 1000) / 1000;
      // PER HULL, not per class: upkeep currency now follows each ship's
      // own loadout (upkeepSplit), so two corvettes in the same fleet
      // bill differently if one carries kinetic and the other energy.
      // That is the whole feature, and it is why this can no longer be a
      // GROUP BY ship_class count.
      //
      // Cost: one row per active hull per tick instead of one per
      // (faction, class). A 229-ship game is 229 rows — the same order
      // as the combat and maintenance passes already read, and far
      // cheaper than the per-ship queries they run.
      const fleetRows = (await this.env.DB
        .prepare(
          `SELECT owner_faction_id AS fid, ship_class, parts_json
             FROM game_ships
            WHERE game_id = ? AND status = 'active'`,
        )
        .bind(gameId)
        .all()).results ?? [];
      const owedByFaction = new Map(); // fid -> { gold, metal }
      for (const row of fleetRows) {
        const totals = UPKEEP[row.ship_class];
        if (!totals) continue;
        const parts = parsePartsJson(row.ship_class, row.parts_json);
        const u = upkeepSplit(row.ship_class, parts, totals);
        const agg = owedByFaction.get(row.fid) ?? { gold: 0, metal: 0 };
        agg.gold  += u.gold;
        agg.metal += u.metal;
        owedByFaction.set(row.fid, agg);
      }
      const ledger = (await this.env.DB
        .prepare(
          `SELECT id, name, gold, metal,
                  upkeep_carry_gold, upkeep_carry_metal,
                  arrears_gold, arrears_metal
             FROM game_factions
            WHERE game_id = ?`,
        )
        .bind(gameId)
        .all()).results ?? [];
      for (const f of ledger) {
        const upkeepMult = Number(sliderFor(f.id).fleet_upkeep_multiplier ?? 1);
        const owed = owedByFaction.get(f.id) ?? { gold: 0, metal: 0 };
        const prevArrears = Number(f.arrears_gold ?? 0) + Number(f.arrears_metal ?? 0);
        // Slider at 0 = upkeep suspended: nothing bills, and any standing
        // debt is forgiven so a passed "no upkeep" law is a real amnesty.
        if (upkeepMult <= 0) {
          if (prevArrears > 0 || Number(f.upkeep_carry_gold ?? 0) > 0 || Number(f.upkeep_carry_metal ?? 0) > 0) {
            await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET upkeep_carry_gold = 0, upkeep_carry_metal = 0,
                        arrears_gold = 0, arrears_metal = 0
                  WHERE id = ?`,
              )
              .bind(f.id).run();
          }
          continue;
        }
        // Whole-unit billing per resource: carry accumulates the
        // fractional part; the integer part becomes this tick's bill.
        const settle = (pool, carryPrev, owedNow, arrearsPrev) => {
          const carry = round3(Number(carryPrev ?? 0) + owedNow * upkeepMult);
          const bill = Math.floor(carry + 1e-9);
          const due = round3(Number(arrearsPrev ?? 0) + bill);
          const pay = Math.min(Math.max(0, Number(pool ?? 0)), due);
          return {
            pay,
            newCarry: round3(carry - bill),
            newArrears: round3(due - pay),
          };
        };
        const g = settle(f.gold,  f.upkeep_carry_gold,  owed.gold,  f.arrears_gold);
        const m = settle(f.metal, f.upkeep_carry_metal, owed.metal, f.arrears_metal);
        const nothingToDo =
          g.pay === 0 && m.pay === 0
          && g.newCarry === Number(f.upkeep_carry_gold ?? 0)
          && m.newCarry === Number(f.upkeep_carry_metal ?? 0)
          && g.newArrears === Number(f.arrears_gold ?? 0)
          && m.newArrears === Number(f.arrears_metal ?? 0);
        if (nothingToDo) continue;
        // Guarded on the LIVE balance (QA finding): `pay` was clamped to
        // a pool read several awaits ago, and a concurrent rush/refit/
        // build can legally spend it down in between — an unguarded
        // subtraction here could drive the pool negative. On a miss we
        // skip this faction for the tick: carry/arrears stay untouched,
        // so nothing drifts and next tick simply bills again.
        const paid = await this.env.DB
          .prepare(
            `UPDATE game_factions
                SET gold = gold - ?, metal = metal - ?,
                    upkeep_carry_gold = ?, upkeep_carry_metal = ?,
                    arrears_gold = ?, arrears_metal = ?
              WHERE id = ? AND gold >= ? AND metal >= ?`,
          )
          .bind(g.pay, m.pay, g.newCarry, m.newCarry, g.newArrears, m.newArrears,
                f.id, g.pay, m.pay)
          .run();
        if (!paid.meta?.changes) continue;
        // Banked for the economy ledger at the end of the tick. Only after
        // the guarded UPDATE landed — a skipped faction was not charged,
        // and recording a bill it never paid would make the Economy tab
        // disagree with the player's actual balance.
        upkeepChargedThisTick.set(f.id, {
          metal: m.pay, gold: g.pay,
          arrearsMetal: m.newArrears, arrearsGold: g.newArrears,
        });
        // Chronicle the TRANSITIONS only (enter/leave arrears), not the
        // steady state — the herald wants the drama, not a per-tick drone.
        const nowArrears = g.newArrears + m.newArrears;
        const entered = prevArrears <= 0 && nowArrears > 0;
        const cleared = prevArrears > 0 && nowArrears <= 0;
        if (entered || cleared) {
          try {
            const payload = JSON.stringify({
              faction_name: f.name ?? null,
              entered,
              arrears_gold: g.newArrears,
              arrears_metal: m.newArrears,
            });
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'fleet_arrears', ?, ?, 'public', ?)`,
              )
              .bind(`c_arr_${f.id}_${tick}`, gameId, tick, f.id, payload, Date.now())
              .run();
          } catch (e) { console.error('fleet_arrears chronicle insert failed', e); }
        }
      }
    } catch (e) {
      console.error('fleet upkeep pass failed (non-fatal)', e);
    }

    // Stamp last_combat_tick on every ship that fired this tick. Done
    // before the damage-application block so even ships that fired and
    // missed (all targets had peace pacts, etc — defensively, can't
    // happen given the loop structure but cheap insurance) get gated
    // correctly on subsequent ticks. Batched via D1.batch() so a body
    // with a dozen ships firing doesn't burn a dozen round-trips.
    if (firedShipIds.size > 0) {
      const stmt = this.env.DB.prepare(
        'UPDATE game_ships SET last_combat_tick = ?, last_target_id = ? WHERE id = ?',
      );
      await this.env.DB.batch(
        Array.from(firedShipIds).map(id => stmt.bind(tick, firedShipTargets.get(id) ?? null, id)),
      );
    }

    if (hpDeltas.size > 0) {
      const losses = [];
      const lostShipRows = [];  // for chronicle entries
      const killerByShip = new Map(); // shipId -> faction id that landed the killing volley
      // killerShipByVictim: victimShipId -> attacker SHIP id that landed
      // the most damage. Used below to award rank + push a history row.
      // Per-attacker-ship attribution, separate from the per-faction
      // kill credit that drives chronicle entries + piracy loot.
      const killerShipByVictim = new Map();
      // Track each killer ship's pending rank/history mutation so we
      // can collapse N kills on the same hull into one UPDATE at the
      // end (a destroyer cleaning up a squad shouldn't take N round-
      // trips). Map: killerShipId -> { addedRank, newHistoryRecords[] }
      const veteranAwards = new Map();
      // Hulls that took fire and LIVED. Destruction is chronicled; being
      // shot was not, so a player watching the log saw nothing until a
      // ship actually died — no warning, which is exactly how you lose a
      // world without noticing. Aggregated per body+owner below so a
      // 20-ship brawl is one line, not twenty.
      const damagedSurvivors = [];
      // Killers that were themselves nearly dead when the volley landed —
      // the "Last Stand" award. Computed from HP BEFORE this tick's
      // damage resolves, which is what "fought on at 20%" means.
      const lowHpAttackers = new Set();
      for (const sh of allShips) {
        const max = sh.hp_max ?? 0;
        if (max > 0 && (sh.hp ?? 0) / max <= 0.25) lowHpAttackers.add(sh.id);
      }
      for (const [shipId, entry] of hpDeltas) {
        const cur = allShips.find(s => s.id === shipId);
        if (!cur) continue;
        const newHp = Math.max(0, cur.hp - entry.total);
        if (newHp <= 0) {
          await this.env.DB
            .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
            .bind(tick, shipId)
            .run();
          // Damage past zero is waste: simultaneous resolution means
          // everyone shooting this hull committed their volley before
          // anyone knew it was already dead.
          tallyKill(shipId, cur.ship_class,
                    Math.max(0, entry.total - (cur.hp ?? 0)), lowHpAttackers);
          losses.push(shipId);
          lostShipRows.push(cur);
          const kf = topAttacker(shipId);
          if (kf) killerByShip.set(shipId, kf);

          // Veterancy award. Find the single attacker ship with the
          // highest damage; bump its rank +1 and append a kill record
          // to its combat_history (LRU cap 20, applied in the flush
          // below). Settlements firing on ships have no shipId in the
          // byShip map so they correctly don't earn ranks.
          const killerShipId = topAttackerShip(shipId);
          // The hull that actually did it. "Lost to Harmattan" is a
          // better fact than "lost to Center of Gravity", and the ledger
          // has known it all along — killerShipByVictim was declared for
          // this and never filled.
          if (killerShipId) killerShipByVictim.set(shipId, killerShipId);
          if (killerShipId && killerShipId !== shipId) {
            let award = veteranAwards.get(killerShipId);
            if (!award) {
              award = { addedRank: 0, newRecords: [] };
              veteranAwards.set(killerShipId, award);
            }
            award.addedRank += 1;
            award.newRecords.push({
              tick,
              targetName: cur.name ?? '?',
              targetClass: cur.ship_class ?? 'frigate',
              atBodyId: cur.parent_body_id,
            });
          }
        } else {
          // Apply damage RELATIVE to the ship's current DB hp, not the
          // pre-maintenance `allShips` snapshot. Section 3.45 (ship
          // maintenance) already wrote `hp = old + repairRate` to the
          // row this tick; an absolute `hp = snapshot.hp - dmg` write
          // here would overwrite (erase) that station repair. So a
          // fleet tanking at its own dry-dock under fire got ZERO
          // effective healing — precisely the case stations exist for.
          // MAX(0, …) keeps the floor without needing the snapshot.
          // last_damaged_tick drives the client's persistent battle-
          // damage FX (fire/smoke for a tick after a hit) — a stamp
          // the damage-flash's hp-diff can't provide when station
          // repair masks the net hp change within one poll.
          await this.env.DB
            .prepare('UPDATE game_ships SET hp = MAX(0, hp - ?), last_damaged_tick = ? WHERE id = ?')
            .bind(entry.total, tick, shipId)
            .run();
          if (entry.total > 0) {
            damagedSurvivors.push({
              shipId,
              dmg: entry.total,
              name: cur.name ?? '?',
              shipClass: cur.ship_class ?? 'ship',
              bodyId: cur.parent_body_id ?? null,
              ownerFid: cur.owner_faction_id ?? null,
              hpAfter: newHp,
              // THE CEILING, not the build-time base. hp_max is what the
              // hull rolled off the line with; the live maximum is that
              // times rank (+1%/kill) and armor tech (+8%/level), and HP
              // is stored ABSOLUTE — so a well-teched hull sits legitimately
              // above hp_max. Logging the base produced "takes 35 damage
              // ... 149/135 HP", which reads as the game being unable to
              // subtract. Same ceiling the maintenance pass and the client's
              // effectiveShipMaxHp use; captain traits and fleet auras are
              // not in scope here and are the small terms.
              hpMax: cur.hp_max != null
                ? Math.round(Number(cur.hp_max)
                    * (1 + 0.01 * Math.max(0, Number(cur.rank) || 0))
                    * armorMulOf(cur.owner_faction_id))
                : null,
            });
          }
        }
      }

      // --- Chronicle: ships that took fire and survived -------------
      // One entry per (body, owner) per tick. The FX anchor is the
      // WORST-hit hull, so the flash plays on the ship that most needs
      // looking at. Best-effort: never fail the tick over a log line.
      if (damagedSurvivors.length > 0) {
        try {
          const groups = new Map();
          for (const d of damagedSurvivors) {
            const key = `${d.bodyId ?? 'deep'}|${d.ownerFid ?? 'none'}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(d);
          }
          const bodyIds = [...new Set(damagedSurvivors.map(d => d.bodyId).filter(Boolean))];
          const bodyNameById = new Map();
          if (bodyIds.length > 0) {
            const ph = bodyIds.map(() => '?').join(',');
            const rows = (await this.env.DB
              .prepare(`SELECT id, name FROM game_bodies WHERE id IN (${ph})`)
              .bind(...bodyIds).all()).results ?? [];
            for (const r of rows) bodyNameById.set(r.id, r.name);
          }
          for (const [key, list] of groups) {
            list.sort((x, y) => y.dmg - x.dmg);
            const worst = list[0];
            const entryId = `cd${tick}_${worst.shipId.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
            const payload = JSON.stringify({
              body_id: worst.bodyId,
              body_name: bodyNameById.get(worst.bodyId) ?? 'deep space',
              count: list.length,
              ships: list.slice(0, 4).map(d => ({
                ship_id: d.shipId, ship_name: d.name, ship_class: d.shipClass,
                damage: Math.round(d.dmg), hp_after: Math.round(d.hpAfter), hp_max: d.hpMax,
              })),
              total_damage: Math.round(list.reduce((n, d) => n + d.dmg, 0)),
            });
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'ship_damaged', ?, ?, ?, ?, 'public', ?)`,
              )
              // Date.now() inline, NOT `now`. The nearest `now` in scope is
              // declared further down this method (the ship_destroyed
              // block at ~3552), so this line threw ReferenceError on
              // every single combat tick — silently, because the catch
              // below swallows it. Result: chronicle_entries has never
              // held a ship_damaged row. Prod bore this out — 187
              // ship_destroyed rows and zero ship_damaged — which means
              // the damage FX (render/pendingFx.ts) and its flavor text
              // have never fired for anyone. Found by the headless sim,
              // the first thing ever to make bots shoot at each other.
              .bind(entryId, gameId, tick, worst.ownerFid, worst.bodyId, worst.shipId,
                    payload, Date.now())
              .run();
          }
        } catch (e) {
          console.error('damage chronicle failed', e);
        }
      }

      // COMBAT V2 telemetry flush.
      //
      // ORDERING IS LOad-BEARING: this used to sit ABOVE the damage
      // resolution loop, so it wrote `kills` before tallyKill had ever
      // incremented it. Prod bore that out exactly — 345 chronicled ship
      // deaths against a tally reporting 0 kills, on every row. It now
      // runs after the loop, so a kill credited this tick is written this
      // tick.
      //
      // At most ~36 tally rows (6 attacker x 6 target classes) plus one
      // row per hull that fired or was fired upon, so a tick is two
      // batches regardless of fleet size.
      // Transit shot log (migration 0089). Separate from the class tally
      // because stage 2 needs the DISTRIBUTION of w_t and f, not their
      // totals — a mean crossing rate tells you nothing about whether
      // V_REF is right. Best-effort: telemetry must never cost a tick.
      if (transitShots.length > 0) {
        try {
          const now = Date.now();
          await this.env.DB.batch(transitShots.map((s, i) => this.env.DB
            .prepare(
              // OR REPLACE, matching the deterministic id below: a
              // retried tick rewrites its own rows rather than being
              // silently dropped (IGNORE) or double-counted.
              `INSERT OR REPLACE INTO game_transit_shots
                 (id, game_id, tick_number,
                  attacker_ship_id, attacker_faction_id, attacker_class,
                  defender_ship_id, defender_faction_id, defender_class,
                  attacker_in_transit, defender_in_transit,
                  d_min, dv, w_t, k_realised, f_realised, p_hit, landed, created_at_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              // Deterministic id so a retried tick overwrites rather
              // than double-counting the same volley. Namespaced by
              // GAME: the table is shared across every match, and
              // `ts_<tick>_<i>_<shipsuffix>` collides the moment two
              // games run the same tick with similarly-suffixed ids.
              `ts_${gameId}_${tick}_${i}_${s.attacker.id.slice(-8)}`, gameId, tick,
              s.attacker.id, s.attacker.owner_faction_id, s.attacker.ship_class,
              s.target.id, s.target.owner_faction_id, s.target.ship_class,
              inTransitIds.has(s.attacker.id) ? 1 : 0,
              inTransitIds.has(s.target.id) ? 1 : 0,
              s.e.dMin, s.e.dv, s.e.wT, s.e.k, s.e.f, s.e.p,
              s.landed ? 1 : 0, now,
            )));
        } catch (e) {
          console.error('transit shot telemetry failed', e, { tick });
        }
      }

      // Fleet composition, sampled while transit combat is live. The
      // corvette-monoculture question cannot be answered from hit rates
      // — only from what players BUILD once they learn the rule.
      if (transitCombatEnabled) {
        try {
          const comp = (await this.env.DB
            .prepare(
              `SELECT owner_faction_id AS fid, ship_class, COUNT(*) AS n
                 FROM game_ships
                WHERE game_id = ? AND status = 'active'
                GROUP BY owner_faction_id, ship_class`,
            )
            .bind(gameId).all()).results ?? [];
          const byFaction = new Map();
          for (const r of comp) {
            const e = byFaction.get(r.fid)
              ?? { corvette: 0, frigate: 0, destroyer: 0, freighter: 0, colony: 0 };
            if (r.ship_class in e) e[r.ship_class] = Number(r.n ?? 0);
            byFaction.set(r.fid, e);
          }
          if (byFaction.size > 0) {
            const nowMs = Date.now();
            await this.env.DB.batch([...byFaction.entries()].map(([fid, e]) => this.env.DB
              .prepare(
                `INSERT OR REPLACE INTO game_fleet_composition
                   (game_id, faction_id, tick_number, corvettes, frigates,
                    destroyers, freighters, colonies, created_at_ms)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
              )
              .bind(gameId, fid, tick, e.corvette, e.frigate, e.destroyer,
                    e.freighter, e.colony, nowMs)));
          }
        } catch (e) {
          console.error('fleet composition sample failed', e, { tick });
        }
      }

      if (combatTally.size > 0 || shipStats.size > 0) {
        try {
          const tallyStmts = [];
          for (const [key, e] of combatTally) {
            const [atkCls, tgtCls] = key.split('>');
            tallyStmts.push(
              this.env.DB.prepare(
                `INSERT INTO game_combat_tally
                   (game_id, attacker_class, target_class, volleys, hits, damage, kills,
                    damage_raw, damage_absorbed, overkill)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(game_id, attacker_class, target_class) DO UPDATE SET
                   volleys         = volleys         + excluded.volleys,
                   hits            = hits            + excluded.hits,
                   damage          = damage          + excluded.damage,
                   kills           = kills           + excluded.kills,
                   damage_raw      = damage_raw      + excluded.damage_raw,
                   damage_absorbed = damage_absorbed + excluded.damage_absorbed,
                   overkill        = overkill        + excluded.overkill`,
              ).bind(gameId, atkCls, tgtCls, e.volleys, e.hits, e.damage, e.kills,
                     e.damageRaw, e.absorbed, e.overkill),
            );
          }
          for (const [shipId, st] of shipStats) {
            tallyStmts.push(
              this.env.DB.prepare(
                `INSERT INTO game_ship_stats
                   (game_id, ship_id, ship_name, ship_class, faction_id,
                    shots, hits, shots_taken, hits_taken,
                    damage_dealt, damage_taken, damage_absorbed,
                    kills, overkill, low_hp_kills)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(game_id, ship_id) DO UPDATE SET
                   -- name/class/faction refresh so a renamed hull keeps
                   -- its record under the name the player now knows.
                   ship_name       = excluded.ship_name,
                   ship_class      = excluded.ship_class,
                   faction_id      = excluded.faction_id,
                   shots           = shots           + excluded.shots,
                   hits            = hits            + excluded.hits,
                   shots_taken     = shots_taken     + excluded.shots_taken,
                   hits_taken      = hits_taken      + excluded.hits_taken,
                   damage_dealt    = damage_dealt    + excluded.damage_dealt,
                   damage_taken    = damage_taken    + excluded.damage_taken,
                   damage_absorbed = damage_absorbed + excluded.damage_absorbed,
                   kills           = kills           + excluded.kills,
                   overkill        = overkill        + excluded.overkill,
                   low_hp_kills    = low_hp_kills    + excluded.low_hp_kills`,
              ).bind(gameId, shipId, st.name, st.cls, st.fid,
                     st.shots, st.hits, st.shotsTaken, st.hitsTaken,
                     st.dealt, st.taken, st.absorbed, st.kills, st.overkill, st.lowHpKills),
            );
          }
          // hp_destroyed: the damage economy's other half, read against
          // hp_repaired from the maintenance pass.
          let hpDestroyed = 0;
          for (const e of hpDeltas.values()) hpDestroyed += e.total;
          if (hpDestroyed > 0) {
            tallyStmts.push(
              this.env.DB.prepare(
                `INSERT INTO game_combat_stats (game_id, stat, value) VALUES (?, 'hp_destroyed', ?)
                 ON CONFLICT(game_id, stat) DO UPDATE SET value = value + excluded.value`,
              ).bind(gameId, hpDestroyed),
            );
          }
          await this.env.DB.batch(tallyStmts);
        } catch (e) {
          // Telemetry must never cost a tick. A missing table (migration not
          // yet applied on this isolate) or a write failure is logged and
          // dropped, not thrown.
          console.error('combat tally flush failed', e);
        }
      }

      // Flush veteran awards — veterancy is CAPTAIN-ONLY (Lorne: "I don't
      // want hulls to carry veterancy anymore. Captains only. If a hull
      // makes a kill with no captain, it gets no credit").
      //
      // The legacy fallback that wrote game_ships.rank for an uncrewed
      // hull is gone. It wasn't merely redundant: reads used
      // COALESCE(c.rank, s.rank), which only falls through on NULL, so a
      // fresh captain's rank of 0 SHADOWED whatever the bare hull had
      // earned — six live destroyers silently lost up to 6% damage and
      // 6% HP the moment an officer came aboard. With one owner there is
      // nothing to shadow.
      const KILL_HISTORY_CAP = 20;
      for (const [killerShipId, award] of veteranAwards) {
        const killer = allShips.find(s => s.id === killerShipId);
        if (!killer) continue;
        // No officer aboard, no credit. The kill still happened and is
        // still chronicled — nobody's record grows from it.
        if (!killer.captain_id) continue;
        const newRank = (killer.rank ?? 0) + award.addedRank;
        const applyHistory = (raw) => {
          let history = [];
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) history = parsed;
            } catch { /* bad JSON — start fresh */ }
          }
          return JSON.stringify([...history, ...award.newRecords].slice(-KILL_HISTORY_CAP));
        };
        const cap = await this.env.DB
          .prepare('SELECT combat_history FROM game_captains WHERE id = ?')
          .bind(killer.captain_id).first();
        await this.env.DB
          .prepare('UPDATE game_captains SET rank = ?, combat_history = ? WHERE id = ?')
          .bind(newRank, applyHistory(cap?.combat_history), killer.captain_id)
          .run();
      }

      // Piracy: any destroyed freighter on an active trade route hands
      // its cargo to the kill-credit faction. Mirrors the SP hook in
      // src/state/gameContext.tsx. Routes are cancelled regardless —
      // the ship is gone, the auto-pilot has nothing to drive.
      //
      // SHIP-LEVEL hold first (migration 0088): loot is what was
      // physically aboard, and cargo that outlived a route rides in the
      // ship's own columns now. Zeroed after capture — the destroyed row
      // keeps its columns, and leaving a balance there would let any
      // future path double-count the same loot.
      if (losses.length > 0) {
        const placeholdersS = losses.map(() => '?').join(',');
        const holds = (await this.env.DB
          .prepare(
            `SELECT id, cargo_fuel, cargo_metal, cargo_gold, cargo_science
               FROM game_ships
              WHERE game_id = ? AND id IN (${placeholdersS})
                AND (cargo_fuel > 0 OR cargo_metal > 0 OR cargo_gold > 0 OR cargo_science > 0)`,
          )
          .bind(gameId, ...losses)
          .all()).results ?? [];
        for (const h of holds) {
          const killer = killerByShip.get(h.id);
          if (killer) {
            await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET fuel = fuel + ?, metal = metal + ?,
                        gold = gold + ?, science = science + ?
                  WHERE id = ?`,
              )
              .bind(Number(h.cargo_fuel ?? 0), Number(h.cargo_metal ?? 0),
                    Number(h.cargo_gold ?? 0), Number(h.cargo_science ?? 0), killer)
              .run();
          }
          await this.env.DB
            .prepare('UPDATE game_ships SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?')
            .bind(h.id)
            .run();
        }
      }
      if (losses.length > 0) {
        const placeholders = losses.map(() => '?').join(',');
        // TRADE V2: a dead freighter LOOTS but no longer CANCELS — the
        // autopilot's next pass promotes a surviving carrier or starts
        // the 30-tick stall clock. Cargo authority varies by kind:
        // walker kinds (self-haul logistics + consolidated) keep cargo
        // on the CREW ROW, legacy kinds (terraform/dyson/agreement
        // legs) keep it on the route row. Loot exactly ONE store per
        // hull — looting the primary carrier's mirror as well would
        // pay the killer twice.
        const crewLoot = (await this.env.DB
          .prepare(
            `SELECT c.id AS crew_id, c.ship_id,
                    c.cargo_fuel, c.cargo_metal, c.cargo_gold, c.cargo_science,
                    r.id AS route_id, r.kind, r.counterparty_faction_id,
                    r.consolidated, r.ship_id AS primary_ship_id
               FROM game_trade_route_ships c
               JOIN game_trade_routes r ON r.id = c.route_id
              WHERE c.game_id = ? AND r.cancelled_at_tick IS NULL
                AND c.ship_id IN (${placeholders})`,
          )
          .bind(gameId, ...losses)
          .all()).results ?? [];
        const crewLootedShips = new Set();
        for (const cl of crewLoot) {
          const walkerKind = cl.kind === 'logistics'
            && (!cl.counterparty_faction_id || cl.consolidated === 1);
          const cf = Number(cl.cargo_fuel ?? 0), cm = Number(cl.cargo_metal ?? 0);
          const cg = Number(cl.cargo_gold ?? 0), cs = Number(cl.cargo_science ?? 0);
          if (walkerKind) {
            crewLootedShips.add(cl.ship_id);
            const killer = killerByShip.get(cl.ship_id);
            if (killer && cf + cm + cg + cs > 0) {
              await this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET fuel = fuel + ?, metal = metal + ?,
                          gold = gold + ?, science = science + ?
                    WHERE id = ?`,
                )
                .bind(cf, cm, cg, cs, killer)
                .run();
            }
            if (cl.ship_id === cl.primary_ship_id) {
              // Zero the mirror so nothing re-loots or re-displays it.
              await this.env.DB
                .prepare('UPDATE game_trade_routes SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?')
                .bind(cl.route_id)
                .run();
            }
          }
          // The crew row dies with the hull whatever the kind, so the
          // promote-or-stall pass reads clean data next tick.
          await this.env.DB
            .prepare('DELETE FROM game_trade_route_ships WHERE id = ?')
            .bind(cl.crew_id)
            .run();
        }
        const looted = (await this.env.DB
          .prepare(
            `SELECT id, ship_id, owner_faction_id,
                    cargo_fuel, cargo_metal, cargo_gold, cargo_science
               FROM game_trade_routes
              WHERE game_id = ?
                AND cancelled_at_tick IS NULL
                AND ship_id IN (${placeholders})
                AND NOT (kind = 'logistics' AND (counterparty_faction_id IS NULL OR consolidated = 1))`,
          )
          .bind(gameId, ...losses)
          .all()).results ?? [];
        for (const r of looted) {
          if (crewLootedShips.has(r.ship_id)) continue;   // paranoia: never double-pay
          const killer = killerByShip.get(r.ship_id);
          const cargoFuel    = Number(r.cargo_fuel    ?? 0);
          const cargoMetal   = Number(r.cargo_metal   ?? 0);
          const cargoGold    = Number(r.cargo_gold    ?? 0);
          const cargoScience = Number(r.cargo_science ?? 0);
          const total = cargoFuel + cargoMetal + cargoGold + cargoScience;
          if (killer && total > 0) {
            await this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET fuel    = fuel    + ?,
                        metal   = metal   + ?,
                        gold    = gold    + ?,
                        science = science + ?
                  WHERE id = ?`,
              )
              .bind(cargoFuel, cargoMetal, cargoGold, cargoScience, killer)
              .run();
          }
          await this.env.DB
            .prepare(
              `UPDATE game_trade_routes
                  SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
                WHERE id = ?`,
            )
            .bind(r.id)
            .run();
        }

        // Same piracy rule for TRADE DELIVERIES (inter-player trade
        // legs, migration 0041). A loaded hull hands its manifest to
        // the killer and the leg is lost — the recipient never sees
        // the goods, the sender's debit stays spent. An UNLOADED leg
        // just lost its ride: nothing was aboard, so the obligation
        // survives and returns to 'unassigned' for a new freighter.
        // This is what makes trade convoys worth escorting.
        const deadDeliveries = (await this.env.DB
          .prepare(
            `SELECT id, ship_id, trade_id, sender_faction_id, recipient_faction_id,
                    metal, fuel, gold, science, loaded
               FROM trade_deliveries
              WHERE game_id = ?
                AND resolved_at_tick IS NULL
                AND ship_id IN (${placeholders})`,
          )
          .bind(gameId, ...losses)
          .all()).results ?? [];
        for (const d of deadDeliveries) {
          if (d.loaded === 1) {
            const killer = killerByShip.get(d.ship_id);
            if (killer) {
              await this.env.DB
                .prepare(
                  `UPDATE game_factions
                      SET metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
                    WHERE id = ?`,
                )
                .bind(d.metal, d.fuel, d.gold, d.science, killer)
                .run();
            }
            await this.env.DB
              .prepare(`UPDATE trade_deliveries SET status = 'lost', resolved_at_tick = ? WHERE id = ?`)
              .bind(tick, d.id).run();
            try {
              await this.env.DB
                .prepare(
                  `INSERT INTO chronicle_entries
                     (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
                   VALUES (?, ?, ?, 'trade_shipment_lost', ?, ?, 'public', ?)`,
                )
                .bind(
                  `c_tl_${d.id}_${tick}`, gameId, tick, d.sender_faction_id,
                  JSON.stringify({
                    trade_id: d.trade_id,
                    sender_faction_id: d.sender_faction_id,
                    recipient_faction_id: d.recipient_faction_id,
                    killer_faction_id: killerByShip.get(d.ship_id) ?? null,
                    metal: d.metal, fuel: d.fuel, gold: d.gold, science: d.science,
                  }),
                  Date.now(),
                )
                .run();
            } catch (e) {
              console.error('trade_shipment_lost chronicle insert failed', e);
            }
          } else {
            await this.env.DB
              .prepare(`UPDATE trade_deliveries SET ship_id = NULL, pickup_body_id = NULL, status = 'unassigned' WHERE id = ?`)
              .bind(d.id).run();
          }
        }
      }

      // Persist chronicle entries for destroyed ships so the canvas can
      // show a combat log without relying on the transient WS broadcast.
      if (lostShipRows.length) {
        const now = Date.now();
        // Pre-fetch faction names for any killer ids we'll cite. One query
        // for the lot is cheaper than per-ship round-trips in the loop.
        const killerIds = [...new Set([...killerByShip.values()].filter(Boolean))];
        const factionNameById = new Map();
        if (killerIds.length > 0) {
          const placeholders = killerIds.map(() => '?').join(',');
          const rows = (await this.env.DB
            .prepare(`SELECT id, name FROM game_factions WHERE id IN (${placeholders})`)
            .bind(...killerIds)
            .all()).results ?? [];
          for (const r of rows) factionNameById.set(r.id, r.name);
        }
        // Also fetch the victim's faction name so the formatter can render
        // "<owner>'s <class> <name> destroyed by <killer>" without needing
        // a client-side join. actor_faction_id stays the owner (victim).
        const victimFactionIds = [...new Set(lostShipRows.map(s => s.owner_faction_id).filter(Boolean))];
        if (victimFactionIds.length > 0) {
          const placeholders = victimFactionIds.map(() => '?').join(',');
          const rows = (await this.env.DB
            .prepare(`SELECT id, name FROM game_factions WHERE id IN (${placeholders})`)
            .bind(...victimFactionIds)
            .all()).results ?? [];
          for (const r of rows) factionNameById.set(r.id, r.name);
        }
        // Destination names for anything that died in flight, fetched
        // once rather than per-loss.
        const bodyNameByIdForKills = new Map();
        try {
          const destIds = [...new Set(lostShipRows
            .map(l => launchPlans.get(l.id)?.targetBodyId)
            .filter(Boolean))];
          if (destIds.length > 0) {
            const marks = destIds.map(() => '?').join(',');
            const rows = (await this.env.DB
              .prepare(`SELECT id, name FROM game_bodies WHERE id IN (${marks})`)
              .bind(...destIds).all()).results ?? [];
            for (const r of rows) bodyNameByIdForKills.set(r.id, r.name);
          }
        } catch (e) {
          console.error('kill destination names failed', e);
        }
        // WHO FIRED THE SHOT. killerShipByVictim has known the attacking
        // HULL all along; only its faction ever reached the chronicle, so
        // the log could say a corvette died "by the Double-Yew Dominion"
        // and never which of their ships did it — the record named the
        // loser and not the winner. A player asked for exactly this.
        //
        // Prefetched in ONE query like the destination names above,
        // rather than a lookup per loss: a fleet action resolves many
        // deaths in a tick and this runs inside the tick.
        //
        // No new intel is disclosed. ship_destroyed is already inserted
        // with visibility 'public' and already carries the killer's
        // FACTION; a hull that just shot you is the most direct sighting
        // there is. If kills are ever fog-gated, this rides along with
        // the faction attribution rather than needing its own rule.
        const killerNameById = new Map();
        try {
          const killerIds = [...new Set(lostShipRows
            .map(l => killerShipByVictim.get(l.id))
            .filter(Boolean))];
          if (killerIds.length > 0) {
            const marks = killerIds.map(() => '?').join(',');
            // Captain joined here rather than fetched separately: the Herald
            // only ever interviewed the losing side, because the winner's
            // officer was the one fact the kill record didn't carry. Same
            // row, same trip, one LEFT JOIN.
            const rows = (await this.env.DB
              .prepare(`SELECT s.id, s.name, s.ship_class, c.name AS captain_name
                          FROM game_ships s
                          LEFT JOIN game_captains c ON c.id = s.captain_id
                         WHERE s.id IN (${marks})`)
              .bind(...killerIds).all()).results ?? [];
            for (const r of rows) {
              killerNameById.set(r.id, { name: r.name, cls: r.ship_class, captain: r.captain_name ?? null });
            }
          }
        } catch (e) {
          console.error('killer ship names failed', e);
        }

        for (const lost of lostShipRows) {
          const ship = await this.env.DB
            .prepare('SELECT name, ship_class, parent_body_id FROM game_ships WHERE id = ?')
            .bind(lost.id).first();
          const body = ship?.parent_body_id
            ? await this.env.DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(ship.parent_body_id).first()
            : null;
          const killerFid = killerByShip.get(lost.id) ?? null;
          // Same fact the chronicle records, kept in battle terms so the
          // recap can show the hull actually going down on the tick it
          // went down, attributed.
          battleDeaths.set(lost.id, {
            killerFactionId: killerFid,
            killerShipId: killerShipByVictim.get(lost.id) ?? null,
            bodyId: ship?.parent_body_id ?? null,
          });
          const entryId = `c${tick}_${lost.id.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
          const payload = JSON.stringify({
            ship_id: lost.id,
            ship_name: ship?.name ?? 'Unknown',
            ship_class: ship?.ship_class ?? 'unknown',
            body_id: ship?.parent_body_id ?? null,
            body_name: body?.name ?? 'unknown space',
            // WHERE IT DIED, NOT WHERE IT LEFT. parent_body_id holds the
            // DEPARTURE body for a hull in flight, so once transit combat
            // existed a freighter killed halfway to Mars read "destroyed
            // at Titan" — a place it had left hours and thousands of
            // units earlier. The client words these two cases
            // differently; without the flag it cannot tell them apart.
            in_transit: inTransitIds.has(lost.id),
            dest_body_name: (() => {
              const tgt = launchPlans.get(lost.id)?.targetBodyId;
              return tgt ? (bodyNameByIdForKills.get(tgt) ?? null) : null;
            })(),
            // Killer attribution: top per-faction damage dealer. Null when
            // no combat-capable ship was at the body (e.g. a kill from a
            // future settlement attacker — currently impossible but
            // forward-compatible).
            killer_faction_id: killerFid,
            killer_faction_name: killerFid ? (factionNameById.get(killerFid) ?? null) : null,
            // The hull that landed the killing blow. Null is normal and
            // must stay renderable: a settlement's guns, a detonator that
            // took its own killer with it, or a hull destroyed in the same
            // volley all leave no surviving attacker to name.
            killer_ship_id: killerShipByVictim.get(lost.id) ?? null,
            killer_ship_name: killerNameById.get(killerShipByVictim.get(lost.id))?.name ?? null,
            killer_ship_class: killerNameById.get(killerShipByVictim.get(lost.id))?.cls ?? null,
            // Who won it. Null stays normal for all the reasons the killer
            // SHIP can be null, plus an uncrewed hull -- the Herald simply
            // has no victor to quote and falls back to the other voices.
            killer_captain_name: killerNameById.get(killerShipByVictim.get(lost.id))?.captain ?? null,
            owner_faction_name: factionNameById.get(lost.owner_faction_id) ?? null,
            // `lost` is the allShips row (captain_id/captain_name joined
            // above) -- still the CORRECT captain here even though
            // resolveCaptainOnDeath below may detach/rescue them, since
            // that runs AFTER this insert and reads its own fresh query.
            captain_name: lost.captain_name ?? null,
            // Loadout at the moment of death (migration 0069 analytics).
            // The hull row is about to be marked destroyed and its parts
            // are only meaningful alongside the outcome, so the record
            // has to carry them — otherwise "which loadouts actually
            // survive" is unanswerable after the fact.
            parts: Array.isArray(lost._parts) ? lost._parts : [],
            hp_max: lost.hp_max ?? null,
          });
          try {
            await this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'ship_destroyed', ?, ?, ?, ?, 'public', ?)`,
              )
              .bind(entryId, gameId, tick, lost.owner_faction_id ?? null,
                    ship?.parent_body_id ?? null, lost.id, payload, now)
              .run();
          } catch (e) {
            // chronicle log is best-effort; don't fail the whole tick.
            console.error('chronicle insert failed', e);
          }

          // Captain survival roll (spec §2.1): 25%-class base improved by
          // friendly-station proximity, permadeath on failure. Both
          // outcomes are chronicled — THE retention hook of the feature.
          try {
            const fate = await resolveCaptainOnDeath(this.env.DB, gameId, tick, lost.id);
            if (fate) {
              const capPayload = JSON.stringify({
                captain_id: fate.captain.id,
                captain_name: fate.captain.name,
                captain_rank: fate.captain.rank ?? 0,
                ship_name: ship?.name ?? 'Unknown',
                body_name: body?.name ?? 'unknown space',
                // Carried for the same reason ship_destroyed carries it:
                // a captain lost in flight did not go down at the body
                // the hull departed from.
                in_transit: inTransitIds.has(lost.id),
                dest_body_name: (() => {
                  const tgt = launchPlans.get(lost.id)?.targetBodyId;
                  return tgt ? (bodyNameByIdForKills.get(tgt) ?? null) : null;
                })(),
                owner_faction_name: factionNameById.get(lost.owner_faction_id) ?? null,
              });
              await this.env.DB
                .prepare(
                  `INSERT INTO chronicle_entries
                    (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`,
                )
                .bind(`c${tick}_cap_${lost.id.slice(-8)}`, gameId, tick,
                      fate.outcome === 'rescued' ? 'captain_rescued' : 'captain_lost',
                      lost.owner_faction_id ?? null, ship?.parent_body_id ?? null,
                      capPayload, now)
                .run();
            }
          } catch (e) { console.error('captain survival roll failed', e); }
        }
        // WHOSE ships. The toast this drives said "N ship(s) destroyed"
        // and nothing else, so a player could not tell their own fleet
        // being wiped out from someone else's — the one thing that
        // message exists to tell them.
        //
        // Broadcast is room-wide, so the classification cannot happen
        // here: every client gets the same payload and works out its own
        // standing. Both halves are already in hand — the victim rows
        // were fetched for the chronicle above, and `peace` was built for
        // this tick's combat suppression — so this costs no extra query.
        this.broadcast({
          type: 'ships_destroyed', tick, ship_ids: losses,
          owners: lostShipRows.map(s => s.owner_faction_id ?? null),
          peace_pairs: [...peace],
        });
      }
    }

    // === Battle records — fold this tick into open engagements ======
    // Never allowed to kill the tick: an analytics write failing must
    // not cost a player their turn.
    try {
      await this.recordBattleTick(gameId, tick, {
        shotsByBody: battleShots,
        rosterByBody: battleRoster,
        deaths: battleDeaths,
        peace,
      });
    } catch (e) { console.error('battle record failed', e); }

    // === Standing orders — auto-retreat + dead-man detonate ===
    // DESIGN-identity-economy.md §3. Runs AFTER damage application so the
    // hp values read below reflect this tick's combat. Wrapped: an
    // orders-pass failure must never kill the Dyson/victory passes below.
    try {
      // 3.48 Auto-retreat. Any active ship with retreat_hp_pct set whose
      // hp/hp_max has dropped to or below the threshold gets an automatic
      // transfer to the nearest friendly body that has a station with
      // shipyard level >= 1 (stations repair — closes the loop).
      //
      // "Once per damage episode" is enforced structurally: a ship with
      // any committed/in_transit node is skipped (it's already going
      // somewhere), and a ship already parked at its nearest shipyard
      // body has no move to make — so once the retreat leg is written
      // this block goes quiet for that hull until it heals above the
      // threshold, ships out again, and takes fresh damage.
      const retreaters = (await this.env.DB
        .prepare(
          // A HULL RETREATS, OR ITS FORMATION DOES.
          //
          // Per-hull retreat dissolves a squadron one ship at a time:
          // each hull leaves as it personally gets hurt, so the fleet
          // bleeds away and whatever is left is weaker every tick. The
          // fleet threshold breaks it as a formation instead, on
          // COMBINED hull — which is what a fleet losing a battle
          // actually looks like.
          //
          // Both apply. Setting one does not disable the other: a
          // per-hull 25% still pulls a nearly-dead ship out of a fight
          // its squadron is winning.
          //
          // Detached hulls are excluded — they are on their own errand
          // and their formation's morale is not theirs.
          `SELECT s.id, s.name, s.owner_faction_id, s.parent_body_id,
                  s.hp, s.hp_max, s.retreat_hp_pct
             FROM game_ships s
            WHERE s.game_id = ? AND s.status = 'active'
              AND s.hp_max > 0
              AND (
                (s.retreat_hp_pct IS NOT NULL
                  AND s.hp * 100 <= s.hp_max * s.retreat_hp_pct)
                OR (
                  s.fleet_id IS NOT NULL AND s.fleet_detached = 0
                  AND EXISTS (
                    SELECT 1 FROM game_fleets f
                     WHERE f.id = s.fleet_id
                       AND f.retreat_hp_pct IS NOT NULL
                       AND (SELECT COALESCE(SUM(m.hp), 0) FROM game_ships m
                             WHERE m.fleet_id = f.id AND m.status = 'active'
                               AND m.fleet_detached = 0) * 100
                           <= (SELECT COALESCE(SUM(m.hp_max), 0) FROM game_ships m
                                WHERE m.fleet_id = f.id AND m.status = 'active'
                                  AND m.fleet_detached = 0) * f.retreat_hp_pct
                  )
                )
              )`,
        )
        .bind(gameId)
        .all()).results ?? [];

      if (retreaters.length > 0) {
        // Friendly shipyard bodies per faction: living stations whose
        // buildings_json carries shipyard >= 1.
        const stationRows = (await this.env.DB
          .prepare(
            `SELECT body_id, owner_faction_id, buildings_json
               FROM game_settlements
              WHERE game_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`,
          )
          .bind(gameId)
          .all()).results ?? [];
        const shipyardBodiesByFaction = new Map(); // fid -> Set<bodyId>
        // FALLBACK TIER: any living station of yours, shipyard or not.
        //
        // Requiring a shipyard made the whole setting a silent no-op for
        // anyone who hadn't built one: the pass bailed at "nowhere to run"
        // before distance was ever considered, and the hull sat in the
        // fight and died exactly as if retreat were switched off. That is
        // how a salvaged destroyer was lost with retreat set to 25% —
        // its owner had four stations and not one shipyard, and
        // `ship_retreated` had never fired once in that entire game.
        //
        // Shipyards still WIN when you have one, because only they repair.
        // A plain station is shelter, not a dry dock — you live, you just
        // don't heal.
        const stationBodiesByFaction = new Map(); // fid -> Set<bodyId>
        for (const st of stationRows) {
          if (!stationBodiesByFaction.has(st.owner_faction_id)) {
            stationBodiesByFaction.set(st.owner_faction_id, new Set());
          }
          stationBodiesByFaction.get(st.owner_faction_id).add(st.body_id);

          if (!st.buildings_json) continue;
          let lvl = 0;
          try { lvl = Number((JSON.parse(st.buildings_json) ?? {}).shipyard ?? 0) || 0; }
          catch { /* malformed */ }
          if (lvl < 1) continue;
          if (!shipyardBodiesByFaction.has(st.owner_faction_id)) {
            shipyardBodiesByFaction.set(st.owner_faction_id, new Set());
          }
          shipyardBodiesByFaction.get(st.owner_faction_id).add(st.body_id);
        }

        // Body-position + leg-time helpers. Same circular-orbit recursion
        // and brachistochrone T = 2·√(d/a) the trade-route auto-pilot
        // uses (its helpers are scoped to that block, so re-declare).
        const TWO_PI = 2 * Math.PI;
        const bodyCache = new Map();
        const fetchBody = async (id) => {
          if (bodyCache.has(id)) return bodyCache.get(id);
          const row = await this.env.DB
            .prepare(
              `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0
                 FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
            )
            .bind(id, gameId)
            .first();
          bodyCache.set(id, row);
          return row;
        };
        const bodyPosAt = async (id, t) => {
          const b = await fetchBody(id);
          if (!b || b.parent_body_id == null) return { x: 0, y: 0 };
          const parent = await bodyPosAt(b.parent_body_id, t);
          const angle = orbitAngle(b.angle0, b.orbit_period, t);
          return {
            x: parent.x + Math.cos(angle) * (b.orbit_radius ?? 0),
            y: parent.y + Math.sin(angle) * (b.orbit_radius ?? 0),
          };
        };
        const G_ANCHOR = 4 * 132.6;            // mirror physics/torchTransfer.ts
        const DEFAULT_ENGINE_G = 0.05;
        const accelCache = new Map();
        const getFactionAccel = async (factionId) => {
          if (accelCache.has(factionId)) return accelCache.get(factionId);
          const f = await this.env.DB
            .prepare('SELECT engine_g FROM game_factions WHERE id = ?')
            .bind(factionId)
            .first();
          const accel = (f?.engine_g ?? DEFAULT_ENGINE_G) * G_ANCHOR;
          accelCache.set(factionId, accel);
          return accel;
        };
        const computeLegTicks = async (factionId, originId, destId) => {
          const accel = await getFactionAccel(factionId);
          const startPos = await bodyPosAt(originId, tick);
          let T = 1;
          for (let i = 0; i < 5; i++) {
            const destPos = await bodyPosAt(destId, tick + T);
            const dx = destPos.x - startPos.x;
            const dy = destPos.y - startPos.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const Tnew = 2 * Math.sqrt(Math.max(d, 0.01) / accel);
            if (Math.abs(Tnew - T) < 0.05) { T = Tnew; break; }
            T = Tnew;
          }
          return Math.max(1, Math.ceil(T));
        };

        for (const ship of retreaters) {
          try {
            // Prefer a dry dock; settle for any port in a storm.
            const yards = shipyardBodiesByFaction.get(ship.owner_faction_id);
            const repairs = !!(yards && yards.size > 0);
            const havens = repairs
              ? yards
              : stationBodiesByFaction.get(ship.owner_faction_id);
            if (!havens || havens.size === 0) continue;   // genuinely nowhere to run
            // Already there? No move to make — if it's a shipyard, station
            // repair takes over; if it's a plain station, sitting still is
            // the whole of the retreat.
            if (havens.has(ship.parent_body_id)) continue;

            // Once per episode: skip if already retreating / in transit.
            const inFlight = await this.env.DB
              .prepare(
                `SELECT 1 AS x FROM game_ship_nodes
                  WHERE ship_id = ? AND status IN ('committed','in_transit') LIMIT 1`,
              )
              .bind(ship.id)
              .first();
            if (inFlight) continue;

            // Nearest haven by straight-line distance at the current tick.
            const herePos = await bodyPosAt(ship.parent_body_id, tick);
            let bestBodyId = null;
            let bestD2 = Infinity;
            for (const yardBodyId of havens) {
              const p = await bodyPosAt(yardBodyId, tick);
              const dx = p.x - herePos.x;
              const dy = p.y - herePos.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2) { bestD2 = d2; bestBodyId = yardBodyId; }
            }
            if (!bestBodyId) continue;

            // Insert a committed node — same shape the trade-route
            // auto-pilot writes; the alarm's depart/arrive passes (2a/2b)
            // drive the actual transit from here.
            const legTicks = await computeLegTicks(
              ship.owner_faction_id, ship.parent_body_id, bestBodyId,
            );
            const seqRow = await this.env.DB
              .prepare('SELECT MAX(sequence) AS m FROM game_ship_nodes WHERE ship_id = ?')
              .bind(ship.id)
              .first();
            const seq = (seqRow?.m ?? -1) + 1;
            const nodeId = `${ship.id}:rt${tick}:n${seq}`;
            await this.env.DB
              .prepare(
                `INSERT INTO game_ship_nodes
                   (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
                    scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
                    status, committed_at_tick)
                 VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, 0, 0, 0, 0, 'committed', ?)`,
              )
              .bind(nodeId, gameId, ship.id, seq, bestBodyId, tick, tick + legTicks, tick)
              .run();

            // Chronicle the retreat (best-effort).
            try {
              const fromBody = await this.env.DB
                .prepare('SELECT name FROM game_bodies WHERE id = ?')
                .bind(ship.parent_body_id).first();
              const toBody = await this.env.DB
                .prepare('SELECT name FROM game_bodies WHERE id = ?')
                .bind(bestBodyId).first();
              const factionName = (await this.env.DB
                .prepare('SELECT name FROM game_factions WHERE id = ?')
                .bind(ship.owner_faction_id).first())?.name ?? null;
              const entryId = `c${tick}_ret_${ship.id.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
              await this.env.DB
                .prepare(
                  `INSERT INTO chronicle_entries
                    (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
                   VALUES (?, ?, ?, 'ship_retreated', ?, ?, ?, ?, 'public', ?)`,
                )
                .bind(
                  entryId, gameId, tick, ship.owner_faction_id,
                  ship.parent_body_id, ship.id,
                  JSON.stringify({
                    ship_id: ship.id,
                    ship_name: ship.name ?? '?',
                    owner_faction_name: factionName,
                    from_body_id: ship.parent_body_id,
                    from_body_name: fromBody?.name ?? '?',
                    to_body_id: bestBodyId,
                    to_body_name: toBody?.name ?? '?',
                    hp: ship.hp,
                    hp_max: ship.hp_max,
                    retreat_hp_pct: ship.retreat_hp_pct,
                    // false = ran for a plain station: alive, but no dry
                    // dock, so it will NOT heal there. The log should be
                    // able to say which of the two happened rather than
                    // implying a repair that never comes.
                    repairs,
                  }),
                  Date.now(),
                )
                .run();
            } catch (e) { console.error('ship_retreated chronicle failed', e); }
          } catch (e) {
            console.error('retreat failed for ship', ship.id, e);
          }
        }
      }

      // 3.49 Dead-man detonate. Ships with detonate_hp_pct set whose HP
      // is at/below the threshold auto-trigger their detonator (§2.2) —
      // but ONLY if the hull actually carries a detonator part. Mirrors
      // the manual POST /ships/:id/detonate endpoint in worker/actions.js
      // (server naming convention: endpoint + tick-pass mirror, like
      // combat + repair). Damage math is shared via detonatorDamage().
      try {
        const detonators = (await this.env.DB
          .prepare(
            `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.parent_body_id,
                    s.hp, s.hp_max, s.detonate_hp_pct, s.parts_json
               FROM game_ships s
              WHERE s.game_id = ? AND s.status = 'active'
                AND s.detonate_hp_pct IS NOT NULL
                AND s.hp_max > 0
                AND s.hp * 100 <= s.hp_max * s.detonate_hp_pct
                AND NOT EXISTS (
                  SELECT 1 FROM game_ship_nodes n
                   WHERE n.ship_id = s.id AND n.status = 'in_transit'
                )`,
          )
          .bind(gameId)
          .all()).results ?? [];
        for (const ship of detonators) {
          await this.detonateShip(gameId, tick, ship);
        }
      } catch (e) {
        console.error('dead-man detonate pass failed', e);
      }
    } catch (e) {
      console.error('standing-orders pass failed', e);
    }

    // === Research drain ====================================
    // Commit-to-a-track model (Civ/Stellaris), mirroring what
    // single-player already did in gameContext's advanceToTick. MP used
    // to buy levels instantly from a science stockpile; the schema had
    // carried research_tech_id/research_progress since 0003 but NOTHING
    // ever advanced them — the columns were vestigial.
    //
    // Each tick a faction with an active project advances it by its
    // ACTUAL science income for that tick (captured from the harvest
    // pass above) — no artificial cap. Research speed IS your science
    // economy, so specialising worlds for science genuinely pays off.
    // Banked science is a buffer, not an accelerant: it can't be dumped
    // into a project to skip ahead, which is what made the old model a
    // purchase.
    // Completing a level clears the project, so the player gets a
    // "pick your next project" moment (and the Situation Report can nag
    // with "No research project"). Science with no project simply banks.
    try {
      const TECH_MAX_LEVEL = CFG.tech_max_level;
      // UNIFIED curve — must match src/game/techs.ts and worker/actions.js
      // exactly (15 × (level+1)^1.72). The old per-track curves left stale
      // here made the drain complete at a HIGHER cost than the client bar
      // showed, so research looked done then hung. Keep all three in sync.
      const RESEARCH_BASE_COST = CFG.research_base_cost;
      const RESEARCH_COST_SCALING = CFG.research_cost_scaling;
      const TECH_DEFS = {
        weapons:      { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
        armor:        { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
        propulsion:   { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
        construction: { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
        industry:     { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
        sensors:      { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
      };

      // --- research queue promotion ---------------------------------
      // Any faction that is IDLE (research_tech_id NULL) but has a
      // non-empty research_queue auto-starts the next valid entry. This
      // covers both "a level just completed" (the drain clears the
      // project → idle) and "player queued something while nothing was
      // researching". Maxed/unknown entries at the head are skipped
      // (dropped from the queue).
      //
      // We run this BEFORE the drain (so a project queued while idle
      // also drains this tick) AND AFTER it (so a project that COMPLETES
      // during the drain is succeeded within the SAME tick instead of
      // idling until the next tick's promotion — the old ordering left a
      // one-tick gap between projects, which on slow ticks read as "the
      // next research project never gets promoted").
      const promoteIdleResearch = async () => {
        try {
          const idle = (await this.env.DB
            .prepare(
              `SELECT id, research_queue FROM game_factions
                WHERE game_id = ? AND research_tech_id IS NULL
                  AND research_queue IS NOT NULL AND research_queue != '[]'`,
            )
            .bind(gameId).all()).results ?? [];
          for (const f of idle) {
            let q;
            try { q = JSON.parse(f.research_queue); } catch { q = []; }
            if (!Array.isArray(q) || q.length === 0) continue;
            // Levels for this faction, to skip queued techs already maxed.
            const lvlRows = (await this.env.DB
              .prepare('SELECT tech_id, level FROM faction_techs WHERE game_id = ? AND faction_id = ?')
              .bind(gameId, f.id).all()).results ?? [];
            const levels = Object.fromEntries(lvlRows.map(r => [r.tech_id, r.level]));
            let next = null;
            while (q.length > 0) {
              const cand = q.shift();
              if (TECH_DEFS[cand] && (levels[cand] ?? 0) < TECH_MAX_LEVEL) { next = cand; break; }
              // else: unknown or maxed — drop and keep scanning.
            }
            await this.env.DB
              .prepare('UPDATE game_factions SET research_tech_id = ?, research_progress = 0, research_queue = ? WHERE id = ?')
              .bind(next, JSON.stringify(q), f.id)
              .run();
          }
        } catch (e) { console.error('research queue promotion failed', e); }
      };
      await promoteIdleResearch();

      const researchers = (await this.env.DB
        .prepare(
          `SELECT f.id, f.name, f.science, f.research_tech_id, f.research_progress,
                  COALESCE(t.level, 0) AS level
             FROM game_factions f
             LEFT JOIN faction_techs t
               ON t.game_id = f.game_id AND t.faction_id = f.id
              AND t.tech_id = f.research_tech_id
            WHERE f.game_id = ? AND f.research_tech_id IS NOT NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];

      for (const f of researchers) {
        const def = TECH_DEFS[f.research_tech_id];
        // Unknown track (e.g. the scrapped 'flight') — clear it rather
        // than burning science into a project that can never finish.
        if (!def) {
          await this.env.DB
            .prepare('UPDATE game_factions SET research_tech_id = NULL, research_progress = 0 WHERE id = ?')
            .bind(f.id).run();
          continue;
        }
        const level = Number(f.level ?? 0);
        if (level >= TECH_MAX_LEVEL) {
          await this.env.DB
            .prepare('UPDATE game_factions SET research_tech_id = NULL, research_progress = 0 WHERE id = ?')
            .bind(f.id).run();
          continue;
        }
        const cost = Math.ceil(def.baseCost * Math.pow(level + 1, def.costScaling));
        const progress = Number(f.research_progress ?? 0);
        const pool = Number(f.science ?? 0);
        // Research advances at the faction's ACTUAL science income rate
        // — no artificial ceiling. A science-specialised empire genuinely
        // outresearches a poor one, which the old flat 3/tick cap
        // flattened away (income was irrelevant; everyone tied).
        //
        // Clamped to the pool so we can never spend science that isn't
        // there, and to what the level still needs so a big income
        // doesn't overshoot and waste the remainder.
        const income = Number(scienceIncomeByFaction.get(f.id) ?? 0);
        // Income is fractional (yields × multipliers), so round the
        // bookkeeping to 3dp. Without this, float noise accumulates in
        // research_progress and the science pool across hundreds of
        // ticks and the numbers drift into long ugly decimals.
        const round3 = (n) => Math.round(n * 1000) / 1000;
        const remaining = round3(cost - progress);
        // Already fully funded → grant NOW, spending nothing more. This
        // covers a project whose stored progress meets/exceeds the current
        // cost — e.g. the cost curve was lowered under existing progress
        // (the unified-curve alignment), or float drift left it a hair over.
        // Without this branch the spend<=0 guard below would `continue` and
        // a finished tech would hang forever, never granted.
        let spend = 0;
        if (remaining > 0) {
          spend = round3(Math.min(pool, income, remaining));
          if (spend <= 0) continue;  // no science income this tick — retry next tick

          const newProgress = round3(progress + spend);
          if (newProgress < cost) {
            await this.env.DB
              .prepare('UPDATE game_factions SET science = science - ?, research_progress = ? WHERE id = ?')
              .bind(spend, newProgress, f.id)
              .run();
            continue;
          }
        }

        // Level complete. Clear the project so the next one is a
        // deliberate choice; overflow is not carried (the spend was
        // clamped to exactly what was needed).
        await this.env.DB.batch([
          this.env.DB
            .prepare('UPDATE game_factions SET science = science - ?, research_tech_id = NULL, research_progress = 0 WHERE id = ?')
            .bind(spend, f.id),
          this.env.DB
            .prepare(
              `INSERT INTO faction_techs
                (game_id, faction_id, tech_id, status, level, started_at_tick, completed_at_tick)
               VALUES (?, ?, ?, 'completed', 1, ?, ?)
               ON CONFLICT(game_id, faction_id, tech_id) DO UPDATE
                 SET level = level + 1, status = 'completed', completed_at_tick = ?`,
            )
            .bind(gameId, f.id, f.research_tech_id, tick, tick, tick),
        ]);

        // ARMOR raises every hull's effective max HP (+8%/level, see
        // armorMulOf). HP is stored ABSOLUTE, so without a matching bump
        // the whole fleet instantly reads as damaged the moment the tech
        // lands — and since repair is station-only, ships in the field
        // never close the gap and look permanently hurt (playtest report:
        // "a lot of my ships are damaged despite not having been in
        // combat"). Scale current HP by the same ratio so the DAMAGE
        // FRACTION is preserved: a full hull stays full, a half-wrecked
        // one stays half-wrecked, and the buff is a real HP gain.
        if (f.research_tech_id === 'armor') {
          try {
            const prevLevel = Number(level ?? 0);
            const ratio = (1 + 0.08 * (prevLevel + 1)) / (1 + 0.08 * prevLevel);
            await this.env.DB
              .prepare(
                `UPDATE game_ships SET hp = hp * ?
                  WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`,
              )
              .bind(ratio, gameId, f.id)
              .run();
          } catch (e) { console.error('armor hp rescale failed', e); }
        }

        try {
          await this.env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'tech_advanced', ?, ?, 'public', ?)`,
            )
            .bind(
              `c${tick}_tech_${f.id.slice(-6)}_${f.research_tech_id}`,
              gameId, tick, f.id,
              JSON.stringify({
                tech_id: f.research_tech_id,
                level: level + 1,
                faction_name: f.name ?? null,
              }),
              Date.now(),
            )
            .run();
        } catch (e) { console.error('tech_advanced chronicle failed', e); }
      }

      // Succeed any project that COMPLETED during the drain above within
      // this same tick, so there is no idle gap before the next queued
      // project starts.
      await promoteIdleResearch();
    } catch (e) {
      console.error('research drain pass failed', e);
    }

    // === Dyson Sphere — delivery + damage routing ===========
    // Mirrors the client tick in src/state/gameContext.tsx. Runs after
    // combat so destroyed freighters don't contribute and station HP
    // changes are reflected in the sphere's damage.
    try {
      await this.tickDysonSphere(gameId, tick);
      await this.tickTerraforming(gameId, tick);
    } catch (e) {
      console.error('dyson tick failed', e);
    }

    // === Analytics: per-tick faction metrics ================
    // One tiny row per faction per tick — the admin dashboard's yield
    // curves read these. Recorded LAST so the numbers reflect every
    // pass above (income, combat losses, construction spend). A single
    // INSERT..SELECT keeps it one round-trip regardless of faction
    // count. INSERT OR IGNORE because a re-resolved tick (crash retry)
    // must not fail the whole loop on the PK.
    try {
      await this.env.DB
        .prepare(
          `INSERT OR IGNORE INTO faction_metrics
             (game_id, tick_number, faction_id, metal, fuel, gold, science, ships, settlements)
           SELECT f.game_id, ?, f.id, f.metal, f.fuel, f.gold, f.science,
                  (SELECT COUNT(*) FROM game_ships s
                    WHERE s.game_id = f.game_id AND s.owner_faction_id = f.id AND s.hp > 0),
                  (SELECT COUNT(*) FROM game_settlements st
                    WHERE st.game_id = f.game_id AND st.owner_faction_id = f.id)
             FROM game_factions f
            WHERE f.game_id = ? AND f.status = 'active'`,
        )
        .bind(tick, gameId)
        .run();
    } catch (e) {
      console.error('faction metrics pass failed', e);
    }

    // === Match snapshot (whole-game replay) =================
    // Beside faction_metrics for the same reason it is last: the state
    // written reflects every pass above. Never allowed to fail a tick.
    try {
      await this.recordMatchSnapshot(gameId, tick);
    } catch (e) {
      console.error('match snapshot failed', e);
    }

    // === Victory check =====================================
    // Mirrors src/game/victory.ts. Runs at the end of resolveTick so
    // every per-tick mutation above is already reflected in the DB.
    // First match wins; order is engineering → military → science.
    try {
      const resolution = await this.checkVictory(gameId);
      if (resolution) {
        const now = Date.now();
        await this.env.DB
          .prepare(
            `UPDATE games
                SET status = 'completed',
                    winner_faction_id = ?,
                    victory_type = ?,
                    completed_at = ?
              WHERE id = ? AND status != 'completed'`,
          )
          .bind(resolution.winnerFactionId, resolution.victoryType, now, gameId)
          .run();
        try {
          const entryId = crypto.randomUUID();
          await this.env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'victory', ?, ?, 'public', ?)`,
            )
            .bind(entryId, gameId, tick, resolution.winnerFactionId,
                  JSON.stringify({ victoryType: resolution.victoryType, detail: resolution.detail }),
                  now)
            .run();
        } catch (e) {
          console.error('chronicle insert failed (victory)', e);
        }
        this.broadcast({
          type: 'game_completed',
          tick,
          winner_faction_id: resolution.winnerFactionId,
          victory_type: resolution.victoryType,
        });
        // Publish the final Herald NOW. The daily sweep would eventually
        // catch it (see maybeRunDailyDigest's completed-game clause), but
        // "eventually" is up to 24h and the end of a match is the one
        // story that has to land while people are watching. Non-throwing;
        // the win is already recorded above.
        try {
          const { publishFinalEdition } = await import('./digest.js');
          await publishFinalEdition(this.env, gameId);
        } catch (e) {
          console.error('final edition (objective victory) failed', e);
        }
      }
    } catch (e) {
      // Never let a victory-check bug block the rest of the tick.
      console.error('victory check failed', e);
    }

    // 3.99 ECONOMY LEDGER. One row per faction per tick — the only record
    // of what an empire was worth over time. Deliberately the LAST thing
    // in the tick, so the levels it records are the ones a player would
    // see if they opened the game right now.
    //
    // Levels + upkeep only. Income is derived by the endpoint from
    // consecutive rows rather than accumulated here, because income
    // arrives across half a dozen passes (yields, trade deliveries,
    // salvage, refunds) and a hand-maintained counter would drift away
    // from the rules the first time someone added a seventh.
    //
    // Isolated: an economy row is a nice-to-have and must never be the
    // reason a tick fails.
    try {
      const econRows = (await this.env.DB
        .prepare(
          `SELECT id, metal, gold, science, arrears_metal, arrears_gold
             FROM game_factions WHERE game_id = ?`,
        )
        .bind(gameId)
        .all()).results ?? [];
      if (econRows.length > 0) {
        const nowMs = Date.now();
        await this.env.DB.batch(econRows.map(f => {
          const up = upkeepChargedThisTick.get(f.id);
          return this.env.DB
            .prepare(
              `INSERT OR REPLACE INTO faction_economy_ticks
                 (game_id, faction_id, tick_number,
                  pool_metal, pool_gold, pool_science,
                  upkeep_metal, upkeep_gold,
                  arrears_metal, arrears_gold, created_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              gameId, f.id, tick,
              Number(f.metal ?? 0), Number(f.gold ?? 0), Number(f.science ?? 0),
              Number(up?.metal ?? 0), Number(up?.gold ?? 0),
              // Arrears from the upkeep pass when it ran this tick,
              // otherwise whatever is standing on the faction row.
              Number(up?.arrearsMetal ?? f.arrears_metal ?? 0),
              Number(up?.arrearsGold ?? f.arrears_gold ?? 0),
              nowMs,
            );
        }));
      }
    } catch (e) {
      console.error('economy ledger write failed', e, { gameId, tick });
    }
  }

  /**
   * Server mirror of src/game/dysonSphere.ts (see tickDysonSphere below).
   * Each tick:
   *   1. Detect foundation-station destruction → collapse sphere.
   *   2. Detect foundation-station damage delta → apply to sphere HP
   *      and proportionally scale accumulated resources.
   *   3. Run delivery: parked freighters at Sol drain the controller's
   *      pool into the sphere.
   *
   * Per-freighter per-tick contribution: 5F · 10O · 10C · 5S.
   * Clamped by pool availability and remaining target.
   */
  /**
   * Asteroid-weapon impact resolver.
   *
   * For each body whose ram_arrive_tick has come up, apply the impact:
   *   - All non-destroyed settlements at target_body_id get marked
   *     destroyed_at_tick.
   *   - Target body's yield_metal / yield_fuel / yield_gold /
   *     yield_science halved (floor) — pollution + crater + lost
   *     surface infrastructure.
   *   - Ownership of the target body is recomputed (likely flips to
   *     NULL if every settlement is gone).
   *   - The asteroid itself is marked destroyed_at_tick — it's
   *     consumed in the strike.
   *   - Chronicle entry: 'asteroid_impact'. Lights up the Daily.
   *
   * Sol is a special case: the asteroid evaporates on approach and
   * nothing else happens. Lets a player who built TT but doesn't want
   * to use it as a weapon dispose of the rock pacifically.
   */
  /**
   * ORBITAL SHIELD upkeep, once per tick.
   *
   * Does two jobs that have to happen together:
   *
   *  1. RECONCILE THE CAP. shield_hp_max is derived from the shields
   *     building level, but the level changes when construction finishes
   *     and nothing else recomputes it. Doing it here means a freshly
   *     completed shield starts filling on the next tick without the
   *     build-completion path needing to know shields exist. It also
   *     handles the cap going DOWN — a razed and rebuilt settlement, or a
   *     config change to shield_hp_per_level — by clamping current to max.
   *
   *  2. REGENERATE. Up to the cap, and NOT during the grace period after
   *     a collapse. Without that grace a shield that just broke would
   *     soak the very next volley and no bombardment could ever finish
   *     the job; with it, breaking a shield buys the attacker a real
   *     window.
   *
   * Runs on ALL living settlements including ones with no shield, because
   * job 1 is what gives a newly built shield its pool in the first place.
   * Cheap: one read, and writes only where something actually changed.
   */
  async resolveShields(gameId, tick, CFG) {
    const perLevel = Number(CFG.shield_hp_per_level ?? 0);
    const regen = Number(CFG.shield_regen_per_tick ?? 0);
    const grace = Number(CFG.shield_down_grace_ticks ?? 0);

    const rows = (await this.env.DB
      .prepare(
        `SELECT id, buildings_json, shield_hp, shield_hp_max, shield_down_tick,
                last_damaged_tick
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      ).bind(gameId).all()).results ?? [];

    const stmts = [];
    for (const r of rows) {
      let level = 0;
      try {
        const b = r.buildings_json ? JSON.parse(r.buildings_json) : null;
        level = Number(b?.shields ?? 0) || 0;
      } catch { level = 0; }

      const max = Math.max(0, level * perLevel);
      let hp = Math.min(Number(r.shield_hp ?? 0), max);
      let downTick = r.shield_down_tick ?? null;

      // A shield that has recovered clears its collapse stamp, so the
      // next break starts a fresh grace window rather than inheriting a
      // stale one from an old fight.
      if (hp >= max && max > 0) downTick = null;

      const inGrace = downTick != null && (tick - downTick) < grace;
      if (max > 0 && hp < max && !inGrace) {
        hp = Math.min(max, hp + regen);
        if (hp >= max) downTick = null;
      }

      const capChanged = Math.abs(max - Number(r.shield_hp_max ?? 0)) > 1e-9;
      const hpChanged = Math.abs(hp - Number(r.shield_hp ?? 0)) > 1e-9;
      const stampChanged = (downTick ?? null) !== (r.shield_down_tick ?? null);
      if (!capChanged && !hpChanged && !stampChanged) continue;

      stmts.push(this.env.DB
        .prepare('UPDATE game_settlements SET shield_hp = ?, shield_hp_max = ?, shield_down_tick = ? WHERE id = ?')
        .bind(hp, max, downTick, r.id));
    }
    if (stmts.length) await this.env.DB.batch(stmts);
  }

  async resolveAsteroidImpacts(gameId, tick) {
    const now = Date.now();
    const arrivals = (await this.env.DB
      .prepare(
        `SELECT id, name, ram_target_body_id, ram_owned_by_faction_id, ram_arrive_tick
           FROM game_bodies
          WHERE game_id = ?
            AND ram_target_body_id IS NOT NULL
            AND ram_arrive_tick IS NOT NULL
            AND ram_arrive_tick <= ?
            AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    for (const a of arrivals) {
      const targetId = a.ram_target_body_id;
      const targetIsSol = targetId === `${gameId}:sol` || targetId === 'sol';

      // Always: consume the asteroid AND any settlements on it (the
      // rock is being driven into a planet — anyone who built a city
      // on the thruster platform goes with it). Refund pending
      // building queues on those settlements so the launching faction
      // isn't double-charged: they already paid the ram fuel.
      const stmts = [];
      stmts.push(
        this.env.DB
          .prepare(
            `UPDATE game_bodies
                SET destroyed_at_tick = ?,
                    ram_target_body_id = NULL,
                    ram_arrive_tick = NULL
              WHERE id = ?`,
          )
          .bind(tick, a.id),
      );
      // Wipe own settlements + refund any in-flight building queue.
      const ownSettlements = (await this.env.DB
        .prepare(
          `SELECT id, owner_faction_id, building_order_json, building_backlog_json
             FROM game_settlements
            WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`,
        )
        .bind(gameId, a.id)
        .all()).results ?? [];
      // The rock is consumed — every settlement on it dies, so any ship
      // construction there dies with the yards (no refund; §3.4 rule).
      if (ownSettlements.length > 0) {
        stmts.push(
          this.env.DB
            .prepare(
              `UPDATE game_body_build_queue SET cancelled_at_tick = ?
                WHERE game_id = ? AND body_id = ? AND cancelled_at_tick IS NULL`,
            )
            .bind(tick, gameId, a.id),
        );
      }
      for (const s of ownSettlements) {
        stmts.push(
          this.env.DB
            .prepare('UPDATE game_settlements SET destroyed_at_tick = ? WHERE id = ?')
            .bind(tick, s.id),
        );
        if (s.building_order_json && s.owner_faction_id) {
          try {
            const order = JSON.parse(s.building_order_json);
            const cost = order?.cost;
            if (cost && typeof cost === 'object') {
              const oreRefund = Math.max(0, Math.floor(cost.ore ?? 0));
              const credRefund = Math.max(0, Math.floor(cost.credits ?? 0));
              if (oreRefund + credRefund > 0) {
                stmts.push(
                  this.env.DB
                    .prepare(
                      `UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?`,
                    )
                    .bind(oreRefund, credRefund, s.owner_faction_id),
                );
              }
            }
          } catch { /* malformed order json — skip refund */ }
        }
        // Upgrades that were QUEUED behind the in-flight one were paid for
        // at queue time too, so the rock eating this settlement has to
        // hand those back as well or the player is silently charged for
        // buildings that will never exist. Paid to the POOL, matching the
        // active-order refund directly above: the settlement is dying, so
        // its local stockpile has nowhere to receive them.
        if (s.building_backlog_json && s.owner_faction_id) {
          try {
            const queued = JSON.parse(s.building_backlog_json);
            if (Array.isArray(queued)) {
              let oreBack = 0, credBack = 0;
              for (const o of queued) {
                const c = o?.cost;
                if (!c || typeof c !== 'object') continue;
                oreBack += Math.max(0, Math.floor(c.ore ?? 0));
                credBack += Math.max(0, Math.floor(c.credits ?? 0));
              }
              if (oreBack + credBack > 0) {
                stmts.push(
                  this.env.DB
                    .prepare(
                      `UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?`,
                    )
                    .bind(oreBack, credBack, s.owner_faction_id),
                );
              }
            }
          } catch { /* malformed backlog json — skip refund */ }
        }
      }

      let targetName = 'Sol';
      let destroyedCount = 0;
      if (!targetIsSol) {
        // Look up target name + current yields.
        const target = await this.env.DB
          .prepare(
            `SELECT name, yield_metal, yield_fuel, yield_gold, yield_science,
                    terraformed_at_tick
               FROM game_bodies
              WHERE id = ? AND game_id = ?`,
          )
          .bind(targetId, gameId)
          .first();
        targetName = target?.name ?? '?';

        // Settlements wiped. Same build-queue refund logic as the
        // asteroid's own settlements — anyone with an upgrade in
        // flight on a destroyed city gets their ore + credits back.
        const victimSettlements = (await this.env.DB
          .prepare(
            `SELECT id, owner_faction_id, building_order_json
               FROM game_settlements
              WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`,
          )
          .bind(gameId, targetId)
          .all()).results ?? [];
        destroyedCount = victimSettlements.length;
        // Impact levels every settlement at the target — in-flight ship
        // builds die with the yards (no refund; §3.4 rule).
        if (victimSettlements.length > 0) {
          stmts.push(
            this.env.DB
              .prepare(
                `UPDATE game_body_build_queue SET cancelled_at_tick = ?
                  WHERE game_id = ? AND body_id = ? AND cancelled_at_tick IS NULL`,
              )
              .bind(tick, gameId, targetId),
          );
        }
        for (const s of victimSettlements) {
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_settlements SET destroyed_at_tick = ? WHERE id = ?')
              .bind(tick, s.id),
          );
          if (s.building_order_json && s.owner_faction_id) {
            try {
              const order = JSON.parse(s.building_order_json);
              const cost = order?.cost;
              if (cost && typeof cost === 'object') {
                const oreRefund = Math.max(0, Math.floor(cost.ore ?? 0));
                const credRefund = Math.max(0, Math.floor(cost.credits ?? 0));
                if (oreRefund + credRefund > 0) {
                  stmts.push(
                    this.env.DB
                      .prepare(
                        `UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?`,
                      )
                      .bind(oreRefund, credRefund, s.owner_faction_id),
                  );
                }
              }
            } catch { /* malformed order json — skip refund */ }
          }
        }

        // Yields halved (floor). Target body endures, but the surface
        // is now a crater field that produces half what it did.
        if (target) {
          stmts.push(
            this.env.DB
              .prepare(
                `UPDATE game_bodies
                    SET yield_metal = ?, yield_fuel = ?, yield_gold = ?, yield_science = ?
                  WHERE id = ?`,
              )
              .bind(
                Math.floor((target.yield_metal ?? 0) / 2),
                Math.floor((target.yield_fuel ?? 0) / 2),
                Math.floor((target.yield_gold ?? 0) / 2),
                Math.floor((target.yield_science ?? 0) / 2),
                targetId,
              ),
          );
        }

        // UN-TERRAFORM (DESIGN-terraforming stage 8). This is the ONLY
        // code path in the game allowed to clear terraform state —
        // conquest and razing never touch it; only a dinosaur-killer
        // does. Any part-filled meter dies with it: the payload was
        // spent on a biosphere that no longer exists.
        if (target && target.terraformed_at_tick != null) {
          stmts.push(
            this.env.DB
              .prepare(
                `UPDATE game_bodies
                    SET terraformed_at_tick = NULL,
                        terraform_acc_metal = 0,
                        terraform_acc_gold = 0,
                        terraform_completes_at_tick = NULL,
                        -- Same scar the Mega Destroyer leaves. Two ways
                        -- to kill a biosphere, one afterwards.
                        sterilised_at_tick = ?
                  WHERE id = ?`,
              )
              .bind(tick, targetId),
          );
          const tdId = `tfdead_${targetId.slice(-10)}_${Math.random().toString(36).slice(2, 8)}`;
          stmts.push(
            this.env.DB
              .prepare(
                `INSERT INTO chronicle_entries
                  (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
                 VALUES (?, ?, ?, 'terraform_destroyed', ?, ?, NULL, ?, 'public', ?)`,
              )
              .bind(
                tdId, gameId, tick,
                a.ram_owned_by_faction_id,
                targetId,
                JSON.stringify({
                  body_name: targetName,
                  asteroid_name: a.name,
                }),
                now,
              ),
          );
        }
      }

      // Chronicle entry.
      const chronicleId = `impact_${a.id.slice(-10)}_${Math.random().toString(36).slice(2, 8)}`;
      stmts.push(
        this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'asteroid_impact', ?, ?, NULL, ?, 'public', ?)`,
          )
          .bind(
            chronicleId, gameId, tick,
            a.ram_owned_by_faction_id,
            targetId,
            JSON.stringify({
              asteroid_name: a.name,
              target_name: targetName,
              target_body_id: targetId,
              settlements_destroyed: destroyedCount,
              sol_special: targetIsSol,
            }),
            now,
          ),
      );

      try {
        await this.env.DB.batch(stmts);
      } catch (e) {
        console.error('asteroid impact batch failed', { asteroid: a.id, target: targetId }, e);
        continue;
      }

      // Body ownership may need to flip to NULL if every settlement
      // was destroyed. Reuse the existing helper.
      if (!targetIsSol) {
        try {
          await recomputeBodyOwnership(this.env.DB, gameId, targetId);
        } catch (e) {
          console.error('recomputeBodyOwnership after impact failed', e);
        }
      }
    }
  }

  /**
   * Body-secret reveal pass + portal_to_sun persistent warp.
   *
   * Runs once per resolveTick. Finds every secret-bearing body that
   * either (a) has an unrevealed secret AND a parked ship, or (b)
   * has a revealed portal_to_sun AND any parked ships. Applies the
   * appropriate effect (settlement/ship spawn, resource grant, tech
   * bump, ship warp) and emits a `secret_discovered` chronicle entry
   * on first reveal.
   *
   * Effect resolution mirrors src/game/secrets.ts computeSecretReveal.
   * Kept server-authoritative: the discoverer is the OWNER of the first
   * ship the SELECT returns for each body, ordered deterministically by
   * arrival (built_at_tick fallback) so concurrent arrivals don't race.
   */
/**
   * Stand up the two halves of a discovered stargate: one in orbit of
   * the world that hid it, one in close solar orbit, wired to each
   * other.
   *
   * BOTH ENDS ARE UNOWNED, and that is the whole mechanism behind
   * "permanently linked". pairGate refuses anyone who does not own a
   * gate, and NULL is nobody, so the link cannot be cut or re-pointed by
   * any player for the rest of the match. Transit has no ownership check
   * at all, so everyone can use it — which leaves the board with exactly
   * one fixed crossing that is contested by position rather than by
   * title deed.
   *
   * Idempotent: a second call finds the gates already there and does
   * nothing, so a retried tick cannot litter the system with doors.
   */
  async spawnDiscoveredGatePair(gameId, bodyId, bodyName, tick) {
    const existing = await this.env.DB
      .prepare(
        `SELECT 1 AS x FROM game_megastructures m
           JOIN game_bodies gb ON gb.id = m.body_id
          WHERE m.game_id = ? AND m.kind = 'warp_gate' AND gb.parent_body_id = ?
          LIMIT 1`,
      )
      .bind(gameId, bodyId).first();
    if (existing) return null;

    const bodies = (await this.env.DB
      .prepare(
        `SELECT id, name, type, parent_body_id, mu, soi, radius,
                orbit_radius, orbit_period, angle0
           FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId).all()).results ?? [];

    // Same body_scale rule the player-placed path follows.
    let gateBodyScale = 1;
    try {
      const gconf = await loadGameConfig(this.env, gameId);
      gateBodyScale = Number(gconf?.body_scale) > 0 ? Number(gconf.body_scale) : 1;
    } catch { gateBodyScale = 1; }

    const host = bodies.find(b => b.id === bodyId);
    const sol = bodies.find(b => !b.parent_body_id) ?? bodies.find(b => b.type === 'star');
    if (!host || !sol) return null;

    // Far enough out to clear the surface, well inside the SOI so the
    // gate belongs to the world rather than drifting at its edge. A
    // body with no SOI falls back to a few radii.
    // Two constraints that can fight each other: clear of the surface,
    // and comfortably inside the SOI. On a big world the surface term
    // wins and it lands at a third of the SOI; on something like Phobos,
    // whose SOI is barely two and a half times its own radius, the
    // surface term alone would push the gate PAST the sphere of
    // influence — and a gate outside its host's SOI stops belonging to
    // the world it was found on, which is the one thing the story needs.
    // So the SOI cap is the one that wins.
    const hostSoi = Number(host.soi) || 0;
    const hostRad = Number(host.radius) || 1;
    const hostR = hostSoi > 0
      ? Math.min(Math.max(hostRad * 2.5, hostSoi * 0.35), hostSoi * 0.8)
      : hostRad * 4;
    // The solar end is squeezed between two things. parkOrbitRadius is
    // already tuned to clear the photosphere, but on an UNSCALED map
    // that altitude is 78% of the way to Mercury — which stops reading
    // as "close solar orbit" and starts sitting in the innermost
    // planet's lane. So it is also capped under half of that orbit, and
    // the surface clearance wins if the two bounds ever cross.
    const solRad = Number(sol.radius) || 50;
    const innerOrbit = bodies
      .filter(b => b.parent_body_id === sol.id && Number(b.orbit_radius) > 0)
      .reduce((m, b) => Math.min(m, Number(b.orbit_radius)), Infinity);
    const solR = Math.max(
      solRad * 1.15,
      Math.min(parkOrbitRadius(solRad), Number.isFinite(innerOrbit) ? innerOrbit * 0.45 : Infinity),
    );

    const mk = (parent, r, name, angle) => {
      const id = `${gameId}:mega_${crypto.randomUUID().slice(0, 8)}`;
      return {
        id,
        stmts: [
          this.env.DB.prepare(
            `INSERT INTO game_bodies
               (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
                orbit_radius, orbit_period, angle0, color, owner_faction_id)
             VALUES (?, ?, 'mega_warp_gate', ?, 'megastructure', ?, ?, 0, ?, ?, ?, ?, '#7fd4ff', NULL)`,
          ).bind(id, gameId, name, parent.id,
                 (MEGASTRUCTURES.warp_gate?.radius ?? 1.9) * gateBodyScale,
                 MEGA_MU, r, periodForRadius(parent, r, bodies), angle),
          this.env.DB.prepare(
            `INSERT INTO game_megastructures
               (body_id, game_id, kind, status, acc_metal, acc_credits,
                cost_metal, cost_credits, founded_by_faction_id,
                founded_at_tick, completed_at_tick)
             VALUES (?, ?, 'warp_gate', 'complete', 0, 0, 0, 0, NULL, ?, ?)`,
          ).bind(id, gameId, tick, tick),
        ],
      };
    };

    // Opposite phases so the two ends are visibly unrelated positions
    // rather than looking like one object drawn twice.
    const a = mk(host, hostR, `${bodyName} Gate`, 0);
    const b = mk(sol, solR, 'Solar Gate', Math.PI);

    await this.env.DB.batch([
      ...a.stmts,
      ...b.stmts,
      this.env.DB.prepare('UPDATE game_megastructures SET partner_body_id = ? WHERE body_id = ?')
        .bind(b.id, a.id),
      this.env.DB.prepare('UPDATE game_megastructures SET partner_body_id = ? WHERE body_id = ?')
        .bind(a.id, b.id),
    ]);

    // Everyone sees a stargate. It is the one structure on the board
    // that belongs to nobody, so hiding it behind sensor coverage would
    // make a public landmark into a private one.
    const factions = (await this.env.DB
      .prepare(`SELECT id FROM game_factions WHERE game_id = ?`)
      .bind(gameId).all()).results ?? [];
    if (factions.length > 0) {
      await this.env.DB.batch(factions.flatMap(f => [a.id, b.id].map(gid => this.env.DB
        .prepare(
          `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(gameId, f.id, gid, tick))));
    }

    return { planetGateId: a.id, solarGateId: b.id };
  }

/**
   * Turn finished MOBILE sites into hulls.
   *
   * The two families diverge only here. A fixed structure switches on
   * where it stands and the site row IS the structure forever; a mobile
   * one was never a structure at all, it was a slipway — so the hull
   * launches and the site is spent.
   *
   * Runs as its own pass rather than inline in the two places a site can
   * complete (a manual delivery and a supply route). Those both just set
   * status='complete', and duplicating the launch into both is how one
   * of them ends up subtly different six months from now. This is also
   * why it is idempotent: it looks for completed mobile sites that still
   * have a body, so a retried tick cannot launch the same hull twice.
   */
  async launchCompletedMobileSites(gameId, tick) {
    const ready = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.kind, b.name, b.parent_body_id, b.owner_faction_id,
                b.orbit_radius, b.orbit_period, b.angle0
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
          WHERE m.game_id = ? AND m.status = 'complete'
            AND b.destroyed_at_tick IS NULL
            AND m.kind IN ('mega_destroyer', 'mobile_foundry')`,
      )
      .bind(gameId).all()).results ?? [];
    if (ready.length === 0) return 0;

    let launched = 0;
    for (const site of ready) {
      const spec = MEGASTRUCTURES[site.kind];
      const stats = SHIP_COMBAT_STATS[site.kind];
      if (!spec || !stats) continue;
      // ARMOUR RESEARCH REACHES CAPITAL HULLS TOO. Every other ship in
      // the game spawns at hp x (1 + 0.08 x defenceLevel); these launched
      // at the flat catalogue number, so a Mega Destroyer built by an
      // Armour-10 faction was no tougher than one built by a faction
      // that had never opened the tree. They take no fittings by design —
      // their ability is the structure that made them — but that is an
      // argument about MOUNTS, not about a faction's metallurgy, and it
      // left two research tracks doing nothing at all for the most
      // expensive hull a player can field.
      // Queried here rather than via resolveTick's techLevelsFor, which
      // is a local of that method and not in scope in this one — the
      // kind of thing node --check is happy to let through.
      const capTech = (await this.env.DB
        .prepare(
          `SELECT tech_id, level FROM faction_techs
            WHERE game_id = ? AND faction_id = ? AND tech_id IN ('armor','shields')`,
        )
        .bind(gameId, site.owner_faction_id).all()).results ?? [];
      const capDefLvl = capTech.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0);
      const capHp = Math.round(stats.hp * (1 + 0.08 * capDefLvl));
      // A site nobody owns cannot launch — there would be no fleet for
      // the hull to join. Ancient gates are unowned by design; a capital
      // slipway never should be, so this is a guard, not a case.
      if (!site.owner_faction_id) continue;

      const shipId = `${gameId}:mega_${crypto.randomUUID().slice(0, 8)}`;
      // The hull appears in the orbit the site held, around the same
      // parent, so it is exactly where the player watched it being built
      // rather than teleporting to a capital.
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO game_ships
             (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
              orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
              fuel, fuel_max, hp, hp_max, damage_per_tick,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science, built_at_tick)
           VALUES (?, ?, ?, ?, ?, ?, 'active',
                   18, 20, 0, ?, ?, 1,
                   ?, ?, ?, ?, ?,
                   0, 0, 0, 0, ?)`,
        ).bind(
          shipId, gameId, site.owner_faction_id, spec.label, site.kind,
          site.parent_body_id,
          parkPhaseFor(shipId), tick,
          600, 600, capHp, capHp, stats.damage_per_tick, tick,
        ),
        // The slipway is spent. Dropping the megastructure row first
        // keeps the FK happy; the body cascades from its own delete.
        this.env.DB.prepare('DELETE FROM game_megastructures WHERE body_id = ?')
          .bind(site.body_id),
        this.env.DB.prepare('DELETE FROM game_bodies WHERE id = ? AND game_id = ?')
          .bind(site.body_id, gameId),
      ]);
      launched += 1;

      try {
        await this.env.DB
          .prepare(
            `INSERT INTO game_chronicle (id, game_id, tick, kind, faction_id, body_id, message)
             VALUES (?, ?, ?, 'megastructure_launched', ?, ?, ?)`,
          )
          .bind(`${gameId}:ch_${crypto.randomUUID().slice(0, 8)}`, gameId, tick,
                site.owner_faction_id, site.parent_body_id,
                `${spec.label} launched from its slipway.`)
          .run();
      } catch { /* chronicle is decoration; never fail a launch over it */ }
    }
    return launched;
  }

/**
   * Gravity Sinks: catch hulls crossing them and pin the burn.
   *
   * Runs BEFORE arrivals resolve, so a hull grabbed this tick does not
   * also land this tick.
   *
   * WHAT MAKES IT A COMMITMENT RATHER THAN A FREE FILTER. The owner
   * picks who passes, which on its own would be pure upside — you would
   * put one on every lane you hold and never think about it again. Two
   * things stop that. The sink is a body like any other, so anyone with
   * sensors on it can see the thing and route around; and the pass list
   * is read from settings at the moment of the grab, so a list left
   * stale while your diplomacy moved on catches the wrong people.
   *
   * The hold is recorded on the NODE. A ship inside the radius is inside
   * it every tick, so without a record of having been caught the same
   * hull would be re-trapped forever and never arrive anywhere.
   */
  async resolveGravitySinks(gameId, tick) {
    const sinks = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.settings_json, b.owner_faction_id
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
          WHERE m.game_id = ? AND m.kind = 'gravity_sink'
            AND m.status = 'complete' AND b.destroyed_at_tick IS NULL
            AND m.hp > ?`,
      )
      // Breached structures are offline. A sink that goes on grabbing
      // fleets while its own hull is open would make the siege pointless
      // on the one structure you most want to switch off before you fly
      // through it.
      .bind(gameId, MEGA_BREACH_HP).all()).results ?? [];
    if (sinks.length === 0) return 0;

    const inFlight = (await this.env.DB
      .prepare(
        `SELECT n.id, n.ship_id, n.target_body_id, n.scheduled_t, n.arrival_at_tick,
                n.launch_x, n.launch_y, n.launch_vx, n.launch_vy, n.accel, n.flip_tick,
                n.sink_body_id, n.sink_held_until_tick,
                s.owner_faction_id, s.ship_class
           FROM game_ship_nodes n
           JOIN game_ships s ON s.id = n.ship_id
          WHERE s.game_id = ? AND n.status = 'in_transit'
            AND n.launch_x IS NOT NULL AND n.accel IS NOT NULL
            AND n.arrival_at_tick IS NOT NULL`,
      )
      .bind(gameId).all()).results ?? [];
    if (inFlight.length === 0) return 0;

    const CFG2 = await loadGameConfig(this.env, gameId).catch(() => ({}));
    const rangeScale = Number(CFG2?.system_scale) > 0 ? Number(CFG2.system_scale) : 1;
    const eff = MEGASTRUCTURES.gravity_sink?.effect ?? {};
    const holdTicks = Math.max(1, Number(eff.holdTicks ?? 8));

    // Positions this tick. bodyPosAt walks the parent chain the same way
    // the rest of the tick does.
    const bodies = (await this.env.DB
      .prepare(
        `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0
           FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId).all()).results ?? [];
    const byId = new Map(bodies.map(b => [b.id, b]));
    const posOfBody = id => bodyPositionAt(byId.get(id), byId, tick);

    let caught = 0;
    for (const n of inFlight) {
      // Already serving a hold: let it run down, then clear it so the
      // same sink can grab the hull again on a LATER crossing.
      if (n.sink_held_until_tick != null && Number(n.sink_held_until_tick) > tick) continue;

      // Straight-line position under the burn. The sink is a volume in
      // space, not a stop on an itinerary, so where the hull IS matters
      // rather than where it is going.
      const f = Math.max(0, Math.min(1,
        (tick - Number(n.scheduled_t)) /
        Math.max(1, Number(n.arrival_at_tick) - Number(n.scheduled_t))));
      const frac = burnProgress(f);
      const origin = { x: Number(n.launch_x), y: Number(n.launch_y) };
      const dest = posOfBody(n.target_body_id) ?? origin;
      const pos = {
        x: origin.x + (dest.x - origin.x) * frac,
        y: origin.y + (dest.y - origin.y) * frac,
      };

      for (const sk of sinks) {
        if (sk.body_id === n.sink_body_id
            && n.sink_held_until_tick != null
            && Number(n.sink_held_until_tick) >= tick) continue;
        const sp = posOfBody(sk.body_id);
        if (!sp) continue;
        const reach = (eff.range ?? 0) * rangeScale;
        if (reach <= 0) continue;
        const dx = pos.x - sp.x;
        const dy = pos.y - sp.y;
        if (dx * dx + dy * dy > reach * reach) continue;

        // WHO PASSES. Default is "everyone but the owner" — a sink that
        // caught its own fleet on the first tick it switched on would be
        // read as broken rather than as a rule.
        let pass = new Set();
        try {
          const cfg = sk.settings_json ? JSON.parse(sk.settings_json) : null;
          if (Array.isArray(cfg?.pass)) pass = new Set(cfg.pass);
        } catch { /* malformed settings: fall back to owner-only */ }
        if (sk.owner_faction_id) pass.add(sk.owner_faction_id);
        if (pass.has(n.owner_faction_id)) continue;

        await this.env.DB
          .prepare(
            `UPDATE game_ship_nodes
                SET arrival_at_tick = arrival_at_tick + ?,
                    sink_body_id = ?, sink_held_until_tick = ?
              WHERE id = ?`,
          )
          .bind(holdTicks, sk.body_id, tick + holdTicks, n.id)
          .run();
        caught += 1;
        break;    // one grab per hull per tick
      }
    }
    return caught;
  }

/**
   * Mega Destroyer strikes that have finished charging.
   *
   * THE CHARGE IS BROKEN BY MOVING. A hull that left the world it was
   * aiming at — under its own orders or because somebody pushed it — is
   * no longer charging, and the order is dropped rather than held. That
   * is the counterplay the 48 ticks exist to create: you do not have to
   * kill a Mega Destroyer to stop it, you have to make it move.
   *
   * The effect mirrors resolveAsteroidImpacts exactly: terraforming
   * cleared, settlements destroyed, build queues cancelled. Two different
   * answers to "what happens to a world that loses its biosphere" is one
   * answer too many.
   */
  /**
   * Structures whose owner has been eliminated.
   *
   * Elimination is "no live settlements", which a faction can hit while
   * still holding a Weapons Station, a gate network and a Null Field.
   * Nothing used to touch them, so a dead player's guns kept firing on
   * everyone with no way to negotiate and no owner to negotiate with.
   *
   * They go derelict instead: ownership to NULL, stamped with the tick
   * so they can be told apart from the ancient gates, which are also
   * unowned and must stay unclaimable forever.
   *
   * Swept every tick rather than hooked to the elimination event,
   * because a faction can also be eliminated by paths that do not run
   * that code — and a station still shooting for a dead empire is the
   * kind of thing nobody reports as a bug, they just quietly stop
   * playing near it.
   */
  async abandonDeadFactionStructures(gameId, tick) {
    const orphans = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.kind, b.name, b.owner_faction_id
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
           JOIN game_factions f ON f.id = b.owner_faction_id
          WHERE m.game_id = ? AND b.destroyed_at_tick IS NULL
            AND f.status = 'eliminated'
            AND m.abandoned_at_tick IS NULL`,
      )
      .bind(gameId).all()).results ?? [];
    if (orphans.length === 0) return 0;

    for (const o of orphans) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE game_bodies SET owner_faction_id = NULL WHERE id = ?',
        ).bind(o.body_id),
        this.env.DB.prepare(
          `UPDATE game_megastructures
              SET abandoned_at_tick = ?,
                  -- A derelict has no diplomacy and no orders. Clearing
                  -- the sink's pass list is the point: a filter set by a
                  -- dead empire would go on choosing who gets through on
                  -- behalf of nobody.
                  settings_json = NULL,
                  last_combat_tick = NULL, last_target_id = NULL
            WHERE body_id = ?`,
        ).bind(tick, o.body_id),
      ]);

      try {
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'megastructure_abandoned', ?, ?, ?, 'public', ?)`,
          )
          .bind(
            `aband_${crypto.randomUUID().slice(0, 10)}`, gameId, tick,
            o.owner_faction_id, o.body_id,
            JSON.stringify({ structure: o.name, structure_kind: o.kind }),
            Date.now(),
          )
          .run();
      } catch { /* decoration */ }
    }
    return orphans.length;
  }

  /**
   * Structures that finished this tick.
   *
   * Completion is written in three places — two route-unload paths and
   * the hand delivery — and hooking a chronicle into each of them is how
   * you end up with two of the three announcing. The row already records
   * completed_at_tick, so a sweep asks the question once: what finished
   * just now.
   *
   * Thirty-one freighter loads used to land in total silence while a
   * discovered rock got a firework.
   */
  async chronicleCompletions(gameId, tick) {
    const done = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.kind, b.name, b.owner_faction_id
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
          WHERE m.game_id = ? AND m.status = 'complete'
            AND m.completed_at_tick = ?
            AND b.destroyed_at_tick IS NULL`,
      )
      .bind(gameId, tick).all()).results ?? [];
    if (done.length === 0) return 0;

    for (const d of done) {
      try {
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'megastructure_complete', ?, ?, ?, 'public', ?)`,
          )
          .bind(
            `mdone_${crypto.randomUUID().slice(0, 10)}`, gameId, tick,
            d.owner_faction_id ?? null, d.body_id,
            JSON.stringify({ structure: d.name, structure_kind: d.kind }),
            Date.now(),
          )
          .run();
      } catch { /* decoration */ }
    }
    return done.length;
  }

  /**
   * Asset deals whose subject no longer exists.
   *
   * A seller can scrap the hull, lose the world, or be eliminated while
   * a buyer's freighters are still in flight. Left alone, the buyer goes
   * on hauling into a meter that can never pay out — so the deal is
   * voided the moment the asset stops being deliverable, and whatever is
   * escrowed goes home.
   *
   * DELIBERATELY NOT triggered by the asset MOVING. The delivery point
   * was snapshotted at proposal; a hull that wanders is one the buyer
   * has to chase, not a broken deal. Voiding on movement would let any
   * seller cancel a sale they regretted by taking their ship for a walk.
   */
  async sweepAssetDeals(gameId, tick) {
    const open = (await this.env.DB
      .prepare(
        `SELECT * FROM trade_asset_deals
          WHERE game_id = ? AND status IN ('offered', 'active')`,
      )
      .bind(gameId).all()).results ?? [];
    if (open.length === 0) return 0;

    let killed = 0;
    for (const deal of open) {
      const state = await assetState(
        this.env, gameId, deal.asset_kind, deal.asset_id, deal.seller_faction_id,
      );
      if (state.ok) continue;
      await voidDeal(this.env, gameId, deal, state.reason, tick);
      killed += 1;
    }
    return killed;
  }

  /**
   * Cross-empire gate links that have lost their authority.
   *
   * Pairing to another empire's gate needs an active construction pact.
   * Treaties end — broken, expired, torn up the tick before an invasion —
   * and a gate is a door: leaving one open into a former partner's
   * capital because nothing swept it would be the single most dangerous
   * piece of stale state in the game.
   *
   * Self-healing rather than event-driven ON PURPOSE. A link can lose
   * its authority three ways — the pact breaks, the pact expires, or
   * somebody CAPTURES one end and inherits a door they never agreed to —
   * and hooking all three would leave the third to be discovered by a
   * player walking through it. Checking the condition each tick catches
   * every path, including ones nobody has thought of yet.
   *
   * Ancient gates are untouched: they belong to nobody, their link
   * predates every treaty in the game, and it is not ours to cut.
   */
  async snapUnauthorisedGateLinks(gameId, tick) {
    const pairs = (await this.env.DB
      .prepare(
        `SELECT m.body_id AS a, m.partner_body_id AS b,
                ba.owner_faction_id AS oa, bb.owner_faction_id AS ob
           FROM game_megastructures m
           JOIN game_bodies ba ON ba.id = m.body_id
           JOIN game_bodies bb ON bb.id = m.partner_body_id
          WHERE m.game_id = ? AND m.kind = 'warp_gate'
            AND m.partner_body_id IS NOT NULL
            AND ba.owner_faction_id IS NOT NULL
            AND bb.owner_faction_id IS NOT NULL
            AND ba.owner_faction_id <> bb.owner_faction_id`,
      )
      .bind(gameId).all()).results ?? [];
    if (pairs.length === 0) return 0;

    const partnersCache = new Map();
    const partnersOf = async (fid) => {
      if (!partnersCache.has(fid)) {
        partnersCache.set(fid, await constructionPartners(this.env, gameId, fid, tick));
      }
      return partnersCache.get(fid);
    };

    let snapped = 0;
    const seen = new Set();
    for (const p of pairs) {
      // Each link shows up twice, once from each end.
      const key = p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const partners = await partnersOf(p.oa);
      if (partners.has(p.ob)) continue;                  // still authorised

      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE game_megastructures SET partner_body_id = NULL WHERE body_id = ?').bind(p.a),
        this.env.DB.prepare('UPDATE game_megastructures SET partner_body_id = NULL WHERE body_id = ?').bind(p.b),
      ]);
      snapped += 1;

      try {
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'gate_link_severed', ?, ?, ?, ?, 'public', ?)`,
          )
          .bind(
            `gsnap_${crypto.randomUUID().slice(0, 10)}`, gameId, tick,
            p.oa, p.a, p.ob, JSON.stringify({ reason: 'pact_ended' }), Date.now(),
          )
          .run();
      } catch { /* decoration */ }
    }
    return snapped;
  }

  /**
   * Megastructures under siege: damage from hostile hulls holding the
   * orbit, and repair when nobody is.
   *
   * WHY PARKED HULLS RATHER THAN THE TARGET-PRIORITY LADDER. A structure
   * is not a ship and it is not a settlement; slotting it into the tier
   * walk would mean giving every warship in the game a new category to
   * rank, and a fleet told to prefer corvettes would wander off a
   * half-broken gate to chase a screen. Holding station on a structure
   * is already the thing you do to take it — the same predicate the
   * seize check uses — so that is what does the breaking. No new order,
   * no new priority key: park warships on it and they work on it.
   *
   * REPAIR IS THE POINT OF THE PASS. Without it one corvette left in
   * orbit grinds 200 points down over a hundred unattended ticks and
   * the owner can never recover, which makes every structure in the
   * game a matter of time rather than of force. With it, taking one
   * means committing hulls and KEEPING them there against whatever the
   * owner sends.
   *
   * Damage is raw. A structure carries no fittings, so there is no
   * defenseMitigation to apply — the same asymmetry bombardment already
   * has against settlements.
   */
  async resolveMegastructureSiege(gameId, tick) {
    const sites = (await this.env.DB
      .prepare(
        `SELECT m.body_id, m.hp, b.owner_faction_id
           FROM game_megastructures m
           JOIN game_bodies b ON b.id = m.body_id
          WHERE m.game_id = ? AND b.destroyed_at_tick IS NULL`,
      )
      .bind(gameId).all()).results ?? [];
    if (sites.length === 0) return 0;

    // Armed hulls parked ON a structure. Freighters and colony hulls are
    // excluded for the same reason the seize check excludes them: a
    // hauler sitting at a gate is not a siege, and counting it would
    // let a supply run quietly break the thing it was supplying.
    const parked = (await this.env.DB
      .prepare(
        `SELECT s.id, s.parent_body_id AS site, s.owner_faction_id AS fid,
                s.damage_per_tick AS dmg
           FROM game_ships s
           JOIN game_megastructures m ON m.body_id = s.parent_body_id
          WHERE s.game_id = ? AND s.status = 'active'
            AND s.hp > 0 AND s.damage_per_tick > 0
            AND s.ship_class NOT IN ('freighter', 'colony')
            AND m.game_id = ?`,
      )
      .bind(gameId, gameId).all()).results ?? [];

    // A hull mid-burn still carries the parent_body_id it launched from,
    // so without this a fleet that left an hour ago would go on shooting
    // the structure it departed. Scoped to this game's ships — the node
    // table is shared.
    const inFlight = new Set((await this.env.DB
      .prepare(
        `SELECT n.ship_id FROM game_ship_nodes n
           JOIN game_ships s ON s.id = n.ship_id
          WHERE s.game_id = ? AND n.status = 'in_transit'`,
      )
      .bind(gameId).all()).results?.map(r => r.ship_id) ?? []);

    const peace = await this.peacePairsAt(gameId, tick);
    const bySite = new Map();
    for (const r of parked) {
      if (inFlight.has(r.id)) continue;
      if (!bySite.has(r.site)) bySite.set(r.site, []);
      bySite.get(r.site).push(r);
    }

    let touched = 0;
    for (const site of sites) {
      const hp = Number(site.hp);
      const owner = site.owner_faction_id;
      const crowd = bySite.get(site.body_id) ?? [];

      // Hostile = not the owner's, and not at peace with the owner. An
      // UNOWNED structure — an ancient gate — has nobody to be hostile
      // to, so it is never under siege and never needs repairing.
      const hostile = owner
        ? crowd.filter(r => r.fid !== owner && !peace.has(megaPairKey(owner, r.fid)))
        : [];

      const incoming = hostile.reduce((sum, r) => sum + (Number(r.dmg) || 0), 0);

      let next;
      if (incoming > 0) {
        next = Math.max(0, hp - incoming);
      } else if (hp < MEGA_MAX_HP) {
        next = Math.min(MEGA_MAX_HP, hp + MEGA_REGEN_PER_TICK);
      } else {
        continue;                                   // intact and unbothered
      }
      if (next === hp) continue;

      await this.env.DB
        .prepare('UPDATE game_megastructures SET hp = ? WHERE body_id = ?')
        .bind(next, site.body_id)
        .run();
      touched += 1;
    }
    return touched;
  }

  /**
   * Unordered faction pairs currently at peace, as `a|b` keys.
   *
   * Lifted out of the tick body so the megastructure siege pass can ask
   * the same question. Two copies of "who is not allowed to shoot whom"
   * is the kind of drift that shows up as a NAP holding for fleets and
   * silently not holding for structures.
   */
  async peacePairsAt(gameId, tick) {
    const rows = (await this.env.DB
      .prepare(
        `SELECT t.id, t.kind, ts.faction_id
           FROM treaties t
           JOIN treaty_signatories ts ON ts.treaty_id = t.id
          WHERE t.game_id = ?
            AND t.status = 'active'
            AND t.broken_at_tick IS NULL
            AND ts.signed_at_tick IS NOT NULL
            AND t.kind IN ('nap', 'defense_pact')
            AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?)`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    // Group signatories by treaty id; then for each treaty emit every
    // unordered pair into a Set.
    const treatyToFactions = new Map();
    for (const r of rows) {
      if (!treatyToFactions.has(r.id)) treatyToFactions.set(r.id, []);
      treatyToFactions.get(r.id).push(r.faction_id);
    }
    const out = new Set();
    for (const sigs of treatyToFactions.values()) {
      for (let i = 0; i < sigs.length; i++) {
        for (let j = i + 1; j < sigs.length; j++) {
          out.add(megaPairKey(sigs[i], sigs[j]));
        }
      }
    }
    return out;
  }

  async resolveMegaStrikes(gameId, tick) {
    const armed = (await this.env.DB
      .prepare(
        `SELECT s.id, s.name, s.owner_faction_id, s.parent_body_id,
                s.strike_target_body_id AS target, s.strike_ready_tick AS ready,
                s.status
           FROM game_ships s
          WHERE s.game_id = ? AND s.strike_ready_tick IS NOT NULL`,
      )
      .bind(gameId).all()).results ?? [];
    if (armed.length === 0) return 0;

    let fired = 0;
    for (const sh of armed) {
      const clear = () => this.env.DB
        .prepare('UPDATE game_ships SET strike_target_body_id = NULL, strike_ready_tick = NULL WHERE id = ?')
        .bind(sh.id).run();

      // A dead or moved hull is not charging. Checked before the clock,
      // so a destroyer chased off its target loses the order the moment
      // it leaves rather than at the instant it would have fired.
      if (sh.status !== 'active' || sh.parent_body_id !== sh.target) {
        await clear();
        continue;
      }
      const flying = await this.env.DB
        .prepare(`SELECT 1 AS x FROM game_ship_nodes
                   WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
        .bind(sh.id).first();
      if (flying) { await clear(); continue; }

      if (Number(sh.ready) > tick) continue;              // still winding up

      const target = await this.env.DB
        .prepare(
          `SELECT id, name, terraformed_at_tick, owner_faction_id
             FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
        )
        .bind(sh.target, gameId).first();
      // Somebody else may have stripped it in the meantime, or an
      // asteroid may have arrived first. Either way there is nothing
      // left to shoot.
      if (!target || target.terraformed_at_tick == null) { await clear(); continue; }

      const doomed = (await this.env.DB
        .prepare(
          `SELECT id FROM game_settlements
            WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`,
        )
        .bind(gameId, target.id).all()).results ?? [];

      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE game_bodies
              SET terraformed_at_tick = NULL,
                  terraform_acc_metal = 0,
                  terraform_acc_gold = 0,
                  terraform_completes_at_tick = NULL,
                  -- The scar. Clearing terraformed_at_tick alone sent
                  -- the world back to the sprite it had before anyone
                  -- touched it, so the most violent act in the game
                  -- left no mark on the map at all.
                  sterilised_at_tick = ?
            WHERE id = ?`,
        ).bind(tick, target.id),
        this.env.DB.prepare(
          `UPDATE game_body_build_queue SET cancelled_at_tick = ?
            WHERE game_id = ? AND body_id = ? AND cancelled_at_tick IS NULL`,
        ).bind(tick, gameId, target.id),
        ...doomed.map(d => this.env.DB
          .prepare('UPDATE game_settlements SET destroyed_at_tick = ? WHERE id = ?')
          .bind(tick, d.id)),
        this.env.DB.prepare(
          'UPDATE game_ships SET strike_target_body_id = NULL, strike_ready_tick = NULL WHERE id = ?',
        ).bind(sh.id),
      ]);
      fired += 1;

      try {
        await this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'terraform_destroyed', ?, ?, ?, ?, 'public', ?)`,
          )
          .bind(
            `mdfire_${crypto.randomUUID().slice(0, 10)}`, gameId, tick,
            sh.owner_faction_id, target.id, target.owner_faction_id ?? null,
            JSON.stringify({
              world: target.name,
              cause: 'mega_destroyer',
              ship: sh.name,
              settlements_lost: doomed.length,
            }),
            Date.now(),
          )
          .run();
      } catch { /* chronicle is decoration; never fail a strike over it */ }
    }
    return fired;
  }

  async resolveSecretReveal(gameId, tick) {
    const SOL_BODY_ID = `${gameId}:sol`;
    const now = Date.now();
    // Bodies whose stargate revealed this tick. Handled after the
    // per-body batches so the gates are built from committed state.
    const gatePairsToSpawn = [];

    // Step 1: unrevealed-secret bodies that have at least one parked ship.
    const unrevealed = (await this.env.DB
      .prepare(
        `SELECT b.id AS body_id, b.name AS body_name, b.radius AS body_radius,
                b.secret_kind AS kind,
                (SELECT s.owner_faction_id FROM game_ships s
                  WHERE s.game_id = b.game_id
                    AND s.parent_body_id = b.id
                    AND s.status = 'active'
                  ORDER BY s.built_at_tick ASC, s.id ASC
                  LIMIT 1) AS discoverer
           FROM game_bodies b
          WHERE b.game_id = ?
            AND b.secret_kind IS NOT NULL
            AND b.secret_revealed = 0`,
      )
      .bind(gameId)
      .all()).results ?? [];

    for (const row of unrevealed) {
      if (!row.discoverer) continue; // no ship parked here yet
      const { body_id, body_name, body_radius, kind, discoverer } = row;
      const stmts = [];
      let chronicleMessage = `${body_name}: DISCOVERY — ${kind.replace(/_/g, ' ')}`;
      // Extra structured fields the Herald digest reads instead of
      // scraping chronicleMessage (worker/digest.js buildDiscoveryStories).
      // Only ancient_databank needs one so far — which tech track leveled.
      let chronicleExtra = {};

      // Mark the body revealed first; subsequent effects piggyback on
      // the same batch when they're DB-only (no DO-state writes).
      stmts.push(
        this.env.DB
          .prepare(
            `UPDATE game_bodies
                SET secret_revealed = 1,
                    secret_discovered_by_faction_id = ?,
                    secret_discovered_at_tick = ?
              WHERE id = ?`,
          )
          .bind(discoverer, tick, body_id),
      );

      switch (kind) {
        case 'portal_to_sun': {
          // THE STARGATE IS A REAL PAIR OF GATES NOW, not a trapdoor.
          // It used to grab every ship that parked here and fling it to
          // Sol whether or not that was the plan — a hazard you learned
          // about by losing a fleet's position to it.
          //
          // Standing up two linked megastructures instead makes it the
          // thing it was always described as: a door. Both ends are
          // UNOWNED, which is what makes the link permanent — pairGate
          // requires ownership, so nobody can ever cut or re-wire it —
          // and it leaves the map with one fixed crossing that everybody
          // can use and nobody can hold.
          //
          // Spawned after this batch commits, because it needs the
          // body's own SOI and Sol's radius to place two orbits.
          gatePairsToSpawn.push({ bodyId: body_id, bodyName: body_name });
          chronicleMessage = `${body_name}: DISCOVERY — an ancient stargate, and its twin in close solar orbit. The pair is live: anything that can reach one end steps out of the other.`;
          break;
        }
        case 'ancient_city': {
          const cityId = `${body_id}:cAC${Math.random().toString(36).slice(2, 8)}`;
          const surfaceAngle = Math.random() * Math.PI * 2;
          stmts.push(
            this.env.DB
              .prepare(
                `INSERT INTO game_settlements
                  (id, game_id, body_id, owner_faction_id, type, name,
                   hp, hp_max, population,
                   surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
                   created_at_tick, last_growth_tick, last_harvest_tick,
                   has_collector, collector_built_tick,
                   buildings_json)
                 VALUES (?, ?, ?, ?, 'city', ?,
                         100, 100, 3,
                         ?, NULL, NULL, NULL, NULL, NULL,
                         ?, ?, ?,
                         0, NULL,
                         '{"lab":2}')`,
              )
              .bind(cityId, gameId, body_id, discoverer, `${body_name} Ruins`,
                    surfaceAngle, tick, tick, tick),
          );
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?')
              .bind(discoverer, body_id),
          );
          // HARD-GATE INVARIANT (DESIGN-terraforming): a city can only
          // exist on a terraformed world. The ancients who built this
          // colony terraformed the place — mark it, or this free city
          // would be the one illegal city-on-raw-world in the game.
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_bodies SET terraformed_at_tick = COALESCE(terraformed_at_tick, ?) WHERE id = ?')
              .bind(tick, body_id),
          );
          chronicleMessage = `${body_name}: DISCOVERY — a long-abandoned colony reactivates under your banner — a free city with a working Lab.`;
          break;
        }
        case 'pre_terraformed': {
          // Terraforming rework: replaces free_collector. Grants
          // TERRAFORM STATUS ONLY — no free settlement, no ownership
          // flip. A beachhead, not a gift: whoever claims it with a
          // station gets a city-capable, full-pool world without paying
          // the 124/124 payload. Idempotent via COALESCE so a re-reveal
          // can never move the timestamp.
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_bodies SET terraformed_at_tick = COALESCE(terraformed_at_tick, ?) WHERE id = ?')
              .bind(tick, body_id),
          );
          chronicleMessage = `${body_name}: DISCOVERY — a world the ancients already prepped for life. Terraformed and waiting; claim it and build.`;
          break;
        }
        case 'derelict_warship': {
          // Spawn a destroyer for the discoverer in a tight orbit
          // around the body. Stats mirror the destroyer class definition.
          const shipId = `${gameId}:wreck_${body_id.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
          const rp = (body_radius || 4) * 1.5;
          const ra = (body_radius || 4) * 2.0;
          // Same launch-at-the-ceiling rule as the build path above: the
          // hardcoded 180/180 says the author meant a FULL hull, but the
          // live ceiling is 180 × defense tech, so a Defense-10 finder
          // salvaged a "free destroyer" that showed up reading 56%.
          let wreckHp = 180;
          try {
            const dRow = await this.env.DB
              .prepare(`SELECT MAX(level) AS lvl FROM faction_techs
                         WHERE game_id = ? AND faction_id = ? AND tech_id IN ('armor','shields')`)
              .bind(gameId, discoverer).first();
            wreckHp = 180 * (1 + 0.08 * Number(dRow?.lvl ?? 0));
          } catch (e) { console.error('derelict hp scale failed', e); }
          stmts.push(
            this.env.DB
              .prepare(
                `INSERT INTO game_ships
                  (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
                   orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
                   fuel, fuel_max, status, built_at_tick,
                   hp, hp_max, damage_per_tick)
                 VALUES (?, ?, ?, ?, 'destroyer', ?,
                         ?, ?, 0, 0, ?, 1,
                         200, 200, 'active', ?,
                         ?, 180, 10)`,
              )
              .bind(shipId, gameId, discoverer, `${body_name} Salvage`, body_id,
                    rp, ra, tick, tick, wreckHp),
          );
          chronicleMessage = `${body_name}: DISCOVERY — a derelict destroyer is salvageable. Claimed.`;
          break;
        }
        case 'resource_cache': {
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_factions SET metal = metal + 500, gold = gold + 500 WHERE id = ?')
              .bind(discoverer),
          );
          chronicleMessage = `${body_name}: DISCOVERY — a buried cache — +500 metal + 500 credits to your pool.`;
          break;
        }
        case 'ancient_databank': {
          // Pick a random tech track (module-level TECH_TRACKS).
          const pick = TECH_TRACKS[Math.floor(Math.random() * TECH_TRACKS.length)];
          // Upsert: try update first, fall back to insert if missing.
          const existing = await this.env.DB
            .prepare('SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = ?')
            .bind(gameId, discoverer, pick)
            .first();
          if (existing) {
            stmts.push(
              this.env.DB
                .prepare(
                  `UPDATE faction_techs
                      SET level = level + 1,
                          status = 'completed',
                          completed_at_tick = ?
                    WHERE game_id = ? AND faction_id = ? AND tech_id = ?`,
                )
                .bind(tick, gameId, discoverer, pick),
            );
          } else {
            stmts.push(
              this.env.DB
                .prepare(
                  `INSERT INTO faction_techs
                    (game_id, faction_id, tech_id, status, level, started_at_tick, completed_at_tick)
                   VALUES (?, ?, ?, 'completed', 1, ?, ?)`,
                )
                .bind(gameId, discoverer, pick, tick, tick),
            );
          }
          chronicleMessage = `${body_name}: DISCOVERY — an intact databank teaches your engineers a new trick. ${pick} +1.`;
          chronicleExtra = { tech_id: pick };
          break;
        }
      }

      // Chronicle the discovery. Best-effort; never block the reveal.
      const chronicleId = `secret_${body_id.slice(-12)}_${Math.random().toString(36).slice(2, 8)}`;
      stmts.push(
        this.env.DB
          .prepare(
            `INSERT INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, 'secret_discovered', ?, ?, ?, 'public', ?)`,
          )
          .bind(
            chronicleId, gameId, tick, discoverer, body_id,
            JSON.stringify({ kind, body_name, message: chronicleMessage, ...chronicleExtra }),
            now,
          ),
      );

      try {
        await this.env.DB.batch(stmts);
      } catch (e) {
        console.error('secret reveal batch failed', { body_id, kind }, e);
        // Don't propagate — keep ticking even if one body's reveal fails.
      }
    }

    // Step 1b: stand up the gate pairs for anything revealed above.
    for (const g of gatePairsToSpawn) {
      try {
        await this.spawnDiscoveredGatePair(gameId, g.bodyId, g.bodyName, tick);
      } catch (e) {
        console.error('spawnDiscoveredGatePair failed', g, e);
      }
    }

    // Step 2: LEGACY persistent portal warp, for stargates revealed
    // before the gate pair existed. Those games have a revealed portal
    // and no gates, and silently changing what their portal does
    // mid-match would be worse than leaving it. Any body that HAS a
    // gate is excluded: the pair replaces the trapdoor, and running
    // both would teleport a ship the instant it arrived to use the
    // door it came for.
    const portalBodies = (await this.env.DB
      .prepare(
        `SELECT b.id FROM game_bodies b
          WHERE b.game_id = ?
            AND b.secret_kind = 'portal_to_sun'
            AND b.secret_revealed = 1
            AND NOT EXISTS (
              SELECT 1 FROM game_megastructures m
                JOIN game_bodies gb ON gb.id = m.body_id
               WHERE m.game_id = b.game_id
                 AND m.kind = 'warp_gate'
                 AND gb.parent_body_id = b.id
            )`,
      )
      .bind(gameId)
      .all()).results ?? [];

    // Where a warped ship lands. Derived from Sol's ACTUAL radius rather
    // than the old hardcoded rp=18/ra=20, which was tuned when the star was
    // radius 10 and would drop every rescued hull inside a radius-50
    // photosphere. Read once, not per portal.
    let warpR = 65;
    if (portalBodies.length > 0) {
      const solRow = await this.env.DB
        .prepare('SELECT radius FROM game_bodies WHERE id = ?')
        .bind(SOL_BODY_ID)
        .first();
      warpR = Math.round(parkOrbitRadius(Number(solRow?.radius) || 50));
    }

    for (const p of portalBodies) {
      const stuck = (await this.env.DB
        .prepare(
          `SELECT id FROM game_ships
            WHERE game_id = ?
              AND parent_body_id = ?
              AND status = 'active'`,
        )
        .bind(gameId, p.id)
        .all()).results ?? [];
      if (stuck.length === 0) continue;
      // Warp each to a low Sol orbit, at the same altitude any ship parks at.
      const warpStmts = stuck.map(sh =>
        this.env.DB
          .prepare(
            `UPDATE game_ships
                SET parent_body_id = ?,
                    orbit_rp = ?, orbit_ra = ?, orbit_omega = 0,
                    orbit_m0 = ?, orbit_epoch = ?, orbit_direction = 1
              WHERE id = ?`,
          )
          .bind(SOL_BODY_ID, warpR, warpR, parkPhaseFor(sh.id), tick, sh.id),
      );
      try {
        await this.env.DB.batch(warpStmts);
      } catch (e) {
        console.error('portal warp batch failed', { portal_body: p.id }, e);
      }
    }
  }

  async tickDysonSphere(gameId, tick) {
    const game = await this.env.DB
      .prepare(
        `SELECT
            dyson_controller_faction_id, dyson_foundation_settlement_id,
            dyson_acc_fuel, dyson_acc_ore, dyson_acc_credits, dyson_acc_science,
            dyson_target_fuel, dyson_target_ore, dyson_target_credits, dyson_target_science,
            dyson_hp, dyson_max_hp,
            dyson_station_last_hp
          FROM games WHERE id = ?`,
      )
      .bind(gameId)
      .first();
    if (!game?.dyson_controller_faction_id) return;

    const ctrl = game.dyson_controller_faction_id;
    const foundationId = game.dyson_foundation_settlement_id;
    let acc = {
      fuel: game.dyson_acc_fuel ?? 0,
      ore: game.dyson_acc_ore ?? 0,
      credits: game.dyson_acc_credits ?? 0,
      science: game.dyson_acc_science ?? 0,
    };
    let hp = game.dyson_hp ?? 0;
    let maxHp = game.dyson_max_hp ?? 0;
    const target = {
      fuel: game.dyson_target_fuel ?? 0,
      ore: game.dyson_target_ore ?? 0,
      credits: game.dyson_target_credits ?? 0,
      science: game.dyson_target_science ?? 0,
    };

    // Self-heal: fuel left the economy, so a sphere initiated under the
    // old 10K-fuel target can never earn its remaining fuel component —
    // hp would cap below max_hp and the Engineering Victory would be
    // silently unreachable. Retire the outstanding fuel requirement:
    // shrink the stored target (and max_hp) by whatever fuel was never
    // delivered. Idempotent — after the first pass target.fuel == acc.fuel
    // and the branch stops firing. New games seed target.fuel = 0.
    if (target.fuel > acc.fuel) {
      const retired = target.fuel - acc.fuel;
      target.fuel = acc.fuel;
      maxHp = Math.max(0, maxHp - retired);
      await this.env.DB
        .prepare(
          `UPDATE games
              SET dyson_target_fuel = ?, dyson_max_hp = ?
            WHERE id = ?`,
        )
        .bind(target.fuel, maxHp, gameId)
        .run();
    }

    // 1 + 2: foundation state. A NULL settlement row (cascaded by
    // ON DELETE) means it was destroyed; a row with destroyed_at_tick
    // set is also destroyed.
    const station = await this.env.DB
      .prepare(
        `SELECT hp, hp_max, destroyed_at_tick FROM game_settlements
            WHERE id = ? AND game_id = ?`,
      )
      .bind(foundationId, gameId)
      .first();

    // Chronicle helper — dyson events are HEADLINE news (a wonder being
    // built, bombed, or broken is the biggest story a tick can carry),
    // so every one is public and carries the controller's name for the
    // herald. Failures never abort the tick.
    const dysonChronicle = async (kind, idFrag, payload) => {
      try {
        const fac = await this.env.DB
          .prepare('SELECT name FROM game_factions WHERE id = ?')
          .bind(ctrl).first();
        await this.env.DB
          .prepare(
            `INSERT OR IGNORE INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`,
          )
          .bind(`c_${idFrag}_${gameId}_${tick}`, gameId, tick, kind, ctrl, `${gameId}:sol`,
                JSON.stringify({ faction_name: fac?.name ?? null, ...payload }),
                Date.now())
          .run();
      } catch (e) { console.error(`${kind} chronicle insert failed`, e); }
    };

    let collapse = false;
    let collapseReason = '';
    let stationHpForNextTick = null;
    let damageTaken = 0;
    if (!station || station.destroyed_at_tick != null) {
      collapse = true;
      collapseReason = 'foundation destroyed';
    } else {
      stationHpForNextTick = station.hp;
      // Damage delta: compare current foundation HP to dyson_station_last_hp
      // (snapshotted on the previous tickDysonSphere call). Any drop is
      // damage the sphere absorbs. Migration 0019 added the column;
      // NULL means "first read after foundation-laying" — we seed
      // last_hp without applying damage.
      const prevHp = game.dyson_station_last_hp;
      if (prevHp != null && station.hp < prevHp) {
        const dmg = prevHp - station.hp;
        damageTaken = dmg;
        const oldHp = acc.fuel + acc.ore + acc.credits + acc.science;
        const newHp = oldHp - dmg;
        if (newHp <= 0) {
          collapse = true;
          collapseReason = 'damaged to collapse';
        } else {
          // Per the player's spec: scale accumulated resources by the
          // damage ratio so the breakdown stays coherent. Then rebuild
          // total HP from the scaled accumulator.
          const ratio = newHp / oldHp;
          acc.fuel    = Math.floor(acc.fuel    * ratio);
          acc.ore     = Math.floor(acc.ore     * ratio);
          acc.credits = Math.floor(acc.credits * ratio);
          acc.science = Math.floor(acc.science * ratio);
        }
      }
      hp = acc.fuel + acc.ore + acc.credits + acc.science;
      // The sphere took fire and survived — chronicle it as a BATTLE
      // beat (the herald ranks dyson damage as front-page combat). One
      // entry per tick at most; the id embeds the tick for dedup.
      if (damageTaken > 0 && !collapse) {
        await dysonChronicle('dyson_damaged', 'dyd', {
          damage: Math.round(damageTaken),
          progress_lost: Math.round(damageTaken),
          hp: Math.round(hp),
          max_hp: Math.round(maxHp),
          pct: maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0,
        });
      }
    }

    if (collapse) {
      // KING OF THE HILL (Sean's rule): the fall of the builder is not
      // the fall of the sphere. Progress and targets stay on the games
      // row; only the controller and their foundation are cleared, and
      // whoever lays the next foundation at Sol RESUMES the build.
      //
      // The two collapse causes differ in what survives: 'damaged to
      // collapse' means bombardment ground the accumulator to zero, so
      // there is nothing left to inherit; 'foundation destroyed' leaves
      // the lattice orbiting uncontrolled, at whatever progress it had.
      if (collapseReason === 'damaged to collapse') {
        acc = { fuel: 0, ore: 0, credits: 0, science: 0 };
      } else {
        // ABANDONMENT TOLL. Losing the sphere costs a flat share of the
        // work on top of whatever the bombardment already burned off:
        // scaffolding drifts, crews evacuate, the half-built lattice
        // decays before anyone else can take the helm. Without it,
        // being kicked off is nearly free for the incumbent — they can
        // simply claim straight back with an insurance station and
        // resume where they stood, and the whole king-of-the-hill
        // scrap costs the attacker more than the defender.
        //
        // Applied per component so the breakdown stays coherent with
        // the per-resource targets (the same reason the damage path
        // scales rather than subtracting from a total).
        acc.fuel    = Math.floor(acc.fuel    * (1 - DYSON_ABANDON_LOSS));
        acc.ore     = Math.floor(acc.ore     * (1 - DYSON_ABANDON_LOSS));
        acc.credits = Math.floor(acc.credits * (1 - DYSON_ABANDON_LOSS));
        acc.science = Math.floor(acc.science * (1 - DYSON_ABANDON_LOSS));
      }
      const kept = acc.fuel + acc.ore + acc.credits + acc.science;
      const priorProgress = (game.dyson_acc_fuel ?? 0) + (game.dyson_acc_ore ?? 0)
        + (game.dyson_acc_credits ?? 0) + (game.dyson_acc_science ?? 0);
      await dysonChronicle('dyson_collapsed', 'dyc', {
        reason: collapseReason,
        progress_lost: Math.round(Math.max(0, priorProgress - kept)),
        progress_kept: Math.round(kept),
        abandon_pct: Math.round(DYSON_ABANDON_LOSS * 100),
        max_hp: Math.round(maxHp),
        pct: maxHp > 0 ? Math.round((kept / maxHp) * 100) : 0,
      });
      await this.env.DB
        .prepare(
          `UPDATE games SET
              dyson_controller_faction_id = NULL,
              dyson_foundation_settlement_id = NULL,
              dyson_started_at_tick = NULL,
              dyson_acc_fuel = ?, dyson_acc_ore = ?,
              dyson_acc_credits = ?, dyson_acc_science = ?,
              dyson_hp = ?,
              dyson_station_last_hp = NULL
            WHERE id = ?`,
        )
        .bind(acc.fuel, acc.ore, acc.credits, acc.science, kept, gameId)
        .run();
      this.broadcast({ type: 'dyson_collapsed', tick, reason: collapseReason, progress_kept: kept });
      return;
    }

    // 3: reconcile. Parked freighters NO LONGER PUMP — the sphere is
    // fed by dyson supply routes (trade routes with dest = Sol), which
    // load from the pool at a collector and physically haul the cargo
    // here. Those deliveries land in the trade-route pass EARLIER this
    // tick, writing dyson_acc_* directly; freighters on the line are
    // raidable the whole way, which is the tension the design wants.
    //
    // This step recomputes hp from the (possibly damage-scaled,
    // possibly delivery-bumped) accumulator, announces any quarter
    // milestone the deliveries crossed, and persists the snapshot.
    const hpStored = game.dyson_hp ?? 0;
    hp = Math.min(maxHp, acc.fuel + acc.ore + acc.credits + acc.science);

    // Construction milestones — one public beat per quarter crossed
    // (25/50/75%). Completion itself is the 'victory' chronicle from
    // checkVictory, so 100% isn't duplicated here. If damage knocks
    // progress back below a line, re-crossing it re-announces — that's
    // the drama working as intended (tick-scoped ids keep it deduped).
    if (maxHp > 0 && hp > hpStored) {
      for (const pct of [25, 50, 75]) {
        const line = (maxHp * pct) / 100;
        if (hpStored < line && hp >= line) {
          await dysonChronicle('dyson_milestone', `dym${pct}`, {
            pct,
            hp: Math.round(hp),
            max_hp: Math.round(maxHp),
          });
        }
      }
    }

    await this.env.DB
      .prepare(
        `UPDATE games SET dyson_hp = ?,
            dyson_acc_fuel = ?, dyson_acc_ore = ?,
            dyson_acc_credits = ?, dyson_acc_science = ?,
            dyson_station_last_hp = ?
          WHERE id = ?`,
      )
      .bind(hp, acc.fuel, acc.ore, acc.credits, acc.science, stationHpForNextTick, gameId)
      .run();
  }

  /**
   * Terraforming completion. A body whose transformation window has
   * elapsed flips terraformed this tick: 100% pool routing, city rights,
   * trade-endpoint status — permanently. The window only exists on
   * bodies whose meter filled (terraform_completes_at_tick is set by the
   * route delivery), so this scan is almost always empty and cheap.
   */
  /**
   * Fold one tick of combat into the open battle at each body.
   *
   * A BATTLE is a body plus a contiguous run of combat ticks. It opens on
   * the first shot there and closes after BATTLE_QUIET_TICKS consecutive
   * ticks without one, so a fleet that trades fire, drifts apart and
   * re-engages two ticks later stays ONE engagement instead of
   * fragmenting into three -- which is how a player remembers it.
   *
   * Everything written here comes from state the combat pass already
   * computed. The only extra reads are body and hull names, and the
   * records carry those themselves: a recap of a fight from fifty ticks
   * ago must not change because a hull was renamed afterwards.
   */
  /**
   * The body a neighbourhood hangs off: walk parent_body_id up until the
   * next step would be the star. Phobos -> Mars, Ganymede -> Jupiter,
   * Mars -> Mars. A body already orbiting the star is its own anchor, and
   * a body with no parent at all (the star itself, a rogue) anchors to
   * itself so nothing can fall out of the grouping.
   *
   * Cached for the life of the call: a system's parent chain does not
   * change mid-tick, and a busy war would otherwise re-walk it per body.
   */
  async anchorBodyOf(gameId, bodyId, cache) {
    if (!bodyId) return null;
    if (cache.has(bodyId)) return cache.get(bodyId);
    const chain = [];
    let cur = bodyId;
    let anchor = bodyId;
    for (let hops = 0; hops < 8 && cur; hops++) {
      if (cache.has(cur)) { anchor = cache.get(cur).id; break; }
      chain.push(cur);
      const row = await this.env.DB
        .prepare('SELECT id, name, type, parent_body_id FROM game_bodies WHERE id = ? AND game_id = ?')
        .bind(cur, gameId).first();
      if (!row) break;
      const parent = row.parent_body_id
        ? await this.env.DB
            .prepare('SELECT id, type FROM game_bodies WHERE id = ? AND game_id = ?')
            .bind(row.parent_body_id, gameId).first()
        : null;
      // No parent, or the parent is the star: this is the anchor.
      if (!parent || parent.type === 'star') { anchor = row.id; break; }
      cur = row.parent_body_id;
      anchor = row.parent_body_id;
    }
    const named = await this.env.DB
      .prepare('SELECT id, name FROM game_bodies WHERE id = ? AND game_id = ?')
      .bind(anchor, gameId).first();
    const out = { id: anchor, name: named?.name ?? null };
    for (const id of chain) cache.set(id, out);
    cache.set(anchor, out);
    return out;
  }

  /**
   * Find the open theatre for this neighbourhood, or open one.
   *
   * Keyed on the anchor and nothing else: who is fighting does not
   * define the campaign, the place does. Two factions trading fire at
   * Mars while two others go at it over Phobos is one war in one system,
   * and the fleets can move between those bodies mid-fight.
   */
  async openTheatre(gameId, anchor, tick, nowMs) {
    if (!anchor?.id) return null;
    const open = await this.env.DB
      .prepare(
        `SELECT id, body_ids, faction_ids FROM battle_theatres
          WHERE game_id = ? AND anchor_body_id = ? AND status = 'active' LIMIT 1`,
      )
      .bind(gameId, anchor.id).first();
    if (open) return open;
    const id = `th_${tick}_${anchor.id}`.slice(0, 120);
    await this.env.DB
      .prepare(
        `INSERT OR IGNORE INTO battle_theatres
           (id, game_id, anchor_body_id, anchor_name, started_tick, last_fire_tick,
            started_at_ms, body_ids, faction_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]')`,
      )
      .bind(id, gameId, anchor.id, anchor.name ?? null, tick, tick, nowMs)
      .run();
    return { id, body_ids: '[]', faction_ids: '[]' };
  }

  async recordBattleTick(gameId, tick, { shotsByBody, rosterByBody, deaths, peace }) {
    const nowMs = Date.now();
    await this.closeQuietBattles(gameId, tick, BATTLE_QUIET_TICKS, peace, nowMs);
    if (!shotsByBody || shotsByBody.size === 0) return;
    // Anchor lookups are shared across every body fighting this tick.
    const anchorCache = new Map();

    const peaceJson = JSON.stringify([...(peace ?? [])]);

    // Names for every hull touched this tick, in one query.
    const nameIds = new Set();
    for (const roster of rosterByBody.values()) for (const r of roster) nameIds.add(r.id);
    for (const shots of shotsByBody.values()) {
      for (const s of shots) { if (s.a) nameIds.add(s.a); if (s.t) nameIds.add(s.t); }
    }
    const shipMeta = new Map();
    const idList = [...nameIds].filter(Boolean);
    for (let i = 0; i < idList.length; i += 100) {
      const chunk = idList.slice(i, i + 100);
      const ph = chunk.map(() => '?').join(',');
      const rows = (await this.env.DB
        .prepare(`SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.hp, s.hp_max,
                         s.icon_variant, s.parts_json, c.name AS captain_name
                    FROM game_ships s
                    LEFT JOIN game_captains c ON c.id = s.captain_id
                   WHERE s.id IN (${ph})`)
        .bind(...chunk).all()).results ?? [];
      for (const r of rows) shipMeta.set(r.id, r);
    }
    // Settlements are combatants and turn up as both shooters and
    // targets, so they need the same name/hp lookup ships get. Kept in a
    // second map rather than merged, because the two tables answer
    // different questions and a settlement has no icon variant or parts.
    const stlMeta = new Map();
    for (let i = 0; i < idList.length; i += 100) {
      const chunk = idList.slice(i, i + 100);
      const ph = chunk.map(() => '?').join(',');
      const rows = (await this.env.DB
        .prepare(`SELECT id, name, type, owner_faction_id, hp, hp_max, buildings_json
                    FROM game_settlements WHERE id IN (${ph})`)
        .bind(...chunk).all()).results ?? [];
      for (const r of rows) stlMeta.set(r.id, r);
    }

    for (const [bodyId, shots] of shotsByBody) {
      if (!shots || shots.length === 0) continue;
      const roster = rosterByBody.get(bodyId) ?? [];

      let battle = await this.env.DB
        .prepare(`SELECT id, tick_count, faction_ids FROM battles
                   WHERE game_id = ? AND body_id = ? AND status = 'active' LIMIT 1`)
        .bind(gameId, bodyId).first();

      const anchor = await this.anchorBodyOf(gameId, bodyId, anchorCache);
      const theatre = await this.openTheatre(gameId, anchor, tick, nowMs);

      if (!battle) {
        const body = await this.env.DB
          .prepare('SELECT name FROM game_bodies WHERE id = ?').bind(bodyId).first();
        const id = `b_${tick}_${bodyId}`.slice(0, 120);
        await this.env.DB
          .prepare(
            `INSERT OR IGNORE INTO battles
               (id, game_id, body_id, body_name, started_tick, last_fire_tick,
                started_at_ms, status, peace_pairs_open, theatre_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .bind(id, gameId, bodyId, body?.name ?? null, tick, tick, nowMs, peaceJson,
                theatre?.id ?? null)
          .run();
        battle = { id, tick_count: 0, faction_ids: null };
      }

      let shotN = 0, hitN = 0, dmg = 0, raw = 0;
      const perShip = new Map();
      const statOf = (id) => {
        let s = perShip.get(id);
        if (!s) {
          s = { shots: 0, hits: 0, taken: 0, hitsTaken: 0, dealt: 0, dmgTaken: 0, absorbed: 0, kills: 0 };
          perShip.set(id, s);
        }
        return s;
      };
      // ONE shot per death gets the credit.
      //
      // This tested the killer's FACTION, so every shot that faction put
      // into a dying hull on its last tick was flagged as the kill —
      // thirteen ships focusing one target handed out thirteen kills for
      // one wreck, and the per-hull kill counts inflated accordingly.
      // The comment above the shot log has always claimed otherwise.
      //
      // The credited killer SHIP is recorded now, so prefer it outright.
      // Where it is missing (a settlement's guns earn no ship credit),
      // fall back to the first matching shot and nothing after it.
      const killClaimed = new Set();
      const killedBy = (s) => {
        const d = s.t ? deaths.get(s.t) : null;
        if (!d || !s.t) return 0;
        if (d.killerShipId) return s.a === d.killerShipId ? 1 : 0;
        if (!s.af || !d.killerFactionId || d.killerFactionId !== s.af) return 0;
        if (killClaimed.has(s.t)) return 0;
        killClaimed.add(s.t);
        return 1;
      };
      const shotLog = [];
      for (const s of shots) {
        shotN++; if (s.hit) hitN++;
        dmg += s.dmg || 0; raw += s.raw || 0;
        if (s.a) { const st = statOf(s.a); st.shots++; if (s.hit) { st.hits++; st.dealt += s.dmg || 0; } }
        if (s.t) {
          const st = statOf(s.t);
          st.taken++;
          if (s.hit) {
            st.hitsTaken++;
            st.dmgTaken += s.dmg || 0;
            st.absorbed += Math.max(0, (s.raw || 0) - (s.dmg || 0));
          }
        }
        // Only the credited killer's shot is flagged, so a recap never
        // shows four hulls each claiming the same wreck.
        //
        // Decided ONCE and remembered on the shot: killedBy claims a
        // death the first time it answers for one, and it is asked again
        // below when the per-shot row is written. Calling it twice would
        // have the frame and the shot table disagree about who scored.
        const kill = killedBy(s);
        s._kill = kill;
        if (kill && s.a) statOf(s.a).kills++;
        // `e` rides in the frame so playback can animate each bolt as the
        // weapon it actually was without a second fetch.
        // `abs` is what the target's shields and armor ate: the volley
        // as rolled, minus what got through. It was already recorded per
        // shot in battle_shots (damage_raw) and never reached playback,
        // so every hit looked identical whether it was stopped cold or
        // went straight into the hull.
        const absorbed = Math.max(0, (s.raw || 0) - (s.dmg || 0));
        shotLog.push({ a: s.a, t: s.t, hit: s.hit, dmg: Math.round((s.dmg || 0) * 10) / 10, kill,
                       e: Math.round((s.e || 0) * 100) / 100,
                       abs: Math.round(absorbed * 10) / 10 });
      }
      let killsHere = 0;
      for (const [, d] of deaths) if (d.bodyId === bodyId) killsHere++;

      const rosterOut = roster.map(r => ({
        id: r.id,
        fid: r.fid,
        cls: r.cls,
        // The roster's own name wins: a settlement carries its name in the
        // snapshot and is not in game_ships at all.
        name: r.name ?? shipMeta.get(r.id)?.name ?? stlMeta.get(r.id)?.name ?? null,
        hp: Math.round((r.hp || 0) * 10) / 10,
        hpMax: r.hpMax ?? shipMeta.get(r.id)?.hp_max ?? stlMeta.get(r.id)?.hp_max ?? null,
        dead: deaths.has(r.id) ? 1 : 0,
        kind: r.kind ?? 'ship',
        mods: r.mods ?? stlMeta.get(r.id)?.buildings_json ?? null,
      }));

      const stmts = [];
      stmts.push(this.env.DB.prepare(
        `INSERT OR REPLACE INTO battle_ticks
           (battle_id, tick_number, seq, shots, hits, damage, kills, roster, shot_log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(battle.id, tick, Number(battle.tick_count) || 0, shotN, hitN, dmg, killsHere,
             JSON.stringify(rosterOut), JSON.stringify(shotLog)));

      for (const s of shots) {
        stmts.push(this.env.DB.prepare(
          `INSERT INTO battle_shots
             (battle_id, tick_number, attacker_ship_id, attacker_faction_id, attacker_class,
              target_ship_id, target_faction_id, target_class, hit, damage, damage_raw, killed,
              energy_share)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(battle.id, tick, s.a, s.af, s.ac, s.t, s.tf, s.tc,
               s.hit, s.dmg || 0, s.raw || 0, s._kill ?? 0, s.e || 0));
      }

      const seen = new Set();
      for (const r of roster) if (r.id) seen.add(r.id);
      for (const k of perShip.keys()) if (k) seen.add(k);
      for (const shipId of seen) {
        const meta = shipMeta.get(shipId);
        const stl = stlMeta.get(shipId);
        const snap = roster.find(r => r.id === shipId);
        const st = perShip.get(shipId)
          ?? { shots: 0, hits: 0, taken: 0, hitsTaken: 0, dealt: 0, dmgTaken: 0, absorbed: 0, kills: 0 };
        const death = deaths.get(shipId);
        stmts.push(this.env.DB.prepare(
          `INSERT INTO battle_participants
             (battle_id, ship_id, faction_id, ship_name, ship_class, hp_max, hp_start, hp_end,
              icon_variant, parts, kind, captain_name, modules, rank,
              first_tick, last_tick, died_tick, killer_faction_id, killer_ship_id,
              shots, hits, shots_taken, hits_taken, damage_dealt, damage_taken,
              damage_absorbed, kills)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(battle_id, ship_id) DO UPDATE SET
             last_tick         = excluded.last_tick,
             hp_end            = excluded.hp_end,
             died_tick         = COALESCE(battle_participants.died_tick, excluded.died_tick),
             killer_faction_id = COALESCE(battle_participants.killer_faction_id, excluded.killer_faction_id),
             killer_ship_id    = COALESCE(battle_participants.killer_ship_id, excluded.killer_ship_id),
             ship_name         = COALESCE(excluded.ship_name, battle_participants.ship_name),
             captain_name      = COALESCE(battle_participants.captain_name, excluded.captain_name),
             modules           = COALESCE(excluded.modules, battle_participants.modules),
             -- Livery is snapshotted on FIRST sight and never overwritten:
             -- the row for a hull that has since died must keep the sprite
             -- it fought in, and a later tick's lookup finds nothing.
             icon_variant      = COALESCE(battle_participants.icon_variant, excluded.icon_variant),
             parts             = COALESCE(battle_participants.parts, excluded.parts),
             shots         = battle_participants.shots         + excluded.shots,
             hits          = battle_participants.hits          + excluded.hits,
             shots_taken   = battle_participants.shots_taken   + excluded.shots_taken,
             hits_taken    = battle_participants.hits_taken    + excluded.hits_taken,
             damage_dealt  = battle_participants.damage_dealt  + excluded.damage_dealt,
             damage_taken  = battle_participants.damage_taken  + excluded.damage_taken,
             damage_absorbed = battle_participants.damage_absorbed + excluded.damage_absorbed,
             kills         = battle_participants.kills         + excluded.kills`,
        ).bind(
          battle.id, shipId,
          snap?.fid ?? meta?.owner_faction_id ?? stl?.owner_faction_id ?? null,
          snap?.name ?? meta?.name ?? stl?.name ?? null,
          snap?.cls ?? meta?.ship_class ?? stl?.type ?? null,
          snap?.hpMax ?? meta?.hp_max ?? stl?.hp_max ?? null,
          snap?.hp ?? null,
          death ? 0 : (meta?.hp ?? stl?.hp ?? null),
          meta?.icon_variant ?? null,
          meta?.parts_json ?? null,
          snap?.kind ?? (stl ? (stl.type === 'station' ? 'station' : 'city') : 'ship'),
          meta?.captain_name ?? null,
          snap?.mods ?? stl?.buildings_json ?? null,
          snap?.rank ?? 0,
          tick, tick,
          death ? tick : null,
          death?.killerFactionId ?? null,
          death?.killerShipId ?? null,
          st.shots, st.hits, st.taken, st.hitsTaken, st.dealt, st.dmgTaken,
          st.absorbed, st.kills,
        ));
      }

      const fids = new Set();
      try { for (const f of JSON.parse(battle.faction_ids || '[]')) fids.add(f); } catch (e) { /* fresh */ }
      for (const r of roster) if (r.fid) fids.add(r.fid);
      for (const s of shots) { if (s.af) fids.add(s.af); if (s.tf) fids.add(s.tf); }

      stmts.push(this.env.DB.prepare(
        `UPDATE battles SET
           last_fire_tick = ?, tick_count = tick_count + 1,
           shots = shots + ?, hits = hits + ?, damage = damage + ?, damage_raw = damage_raw + ?,
           ships_lost = ships_lost + ?, faction_ids = ?, faction_count = ?
         WHERE id = ?`,
      ).bind(tick, shotN, hitN, dmg, raw, killsHere,
             JSON.stringify([...fids]), fids.size, battle.id));

      // The campaign this engagement belongs to moves with it. Bodies and
      // factions accumulate across the whole neighbourhood, so a theatre
      // knows every world that saw fighting and every flag that was in
      // it, not just this body's.
      if (theatre?.id) {
        const tBodies = new Set();
        const tFactions = new Set();
        try { for (const b of JSON.parse(theatre.body_ids || '[]')) tBodies.add(b); } catch (e) { /* fresh */ }
        try { for (const f of JSON.parse(theatre.faction_ids || '[]')) tFactions.add(f); } catch (e) { /* fresh */ }
        const knownBody = tBodies.has(bodyId);
        tBodies.add(bodyId);
        for (const f of fids) tFactions.add(f);
        stmts.push(this.env.DB.prepare(
          `UPDATE battle_theatres SET
             last_fire_tick = ?,
             battle_count = battle_count + ?,
             body_ids = ?, faction_ids = ?,
             shots = shots + ?, hits = hits + ?, damage = damage + ?,
             ships_lost = ships_lost + ?
           WHERE id = ?`,
        ).bind(tick, knownBody ? 0 : 1,
               JSON.stringify([...tBodies]), JSON.stringify([...tFactions]),
               shotN, hitN, dmg, killsHere, theatre.id));
        // Keep the in-memory copy current: several bodies in the same
        // neighbourhood can fight in one tick, and each pass would
        // otherwise write back a list missing the others.
        theatre.body_ids = JSON.stringify([...tBodies]);
        theatre.faction_ids = JSON.stringify([...tFactions]);
      }

      await this.env.DB.batch(stmts);
    }
  }

  /**
   * Close any battle whose last shot is far enough behind us.
   *
   * The quiet window is the whole reason a battle is a useful unit:
   * without it every lull would end an engagement and a siege would come
   * out as a dozen unrelated skirmishes.
   */
  async closeQuietBattles(gameId, tick, quiet, peace, nowMs) {
    const stale = (await this.env.DB
      .prepare(`SELECT id FROM battles
                 WHERE game_id = ? AND status = 'active' AND last_fire_tick <= ?`)
      .bind(gameId, tick - quiet).all()).results ?? [];
    if (stale.length === 0) return;
    const peaceJson = JSON.stringify([...(peace ?? [])]);
    for (const row of stale) {
      // The victor is whoever still holds hulls at the end. A mutual wipe,
      // or a fight everyone walked away from, leaves this null rather than
      // inventing a winner.
      let victor = null;
      try {
        const sides = (await this.env.DB
          .prepare(
            `SELECT faction_id,
                    SUM(CASE WHEN died_tick IS NULL THEN 1 ELSE 0 END) AS alive,
                    SUM(kills) AS kills
               FROM battle_participants
              WHERE battle_id = ? AND faction_id IS NOT NULL
              GROUP BY faction_id`,
          )
          .bind(row.id).all()).results ?? [];
        const standing = sides.filter(s => Number(s.alive) > 0);
        if (standing.length === 1) victor = standing[0].faction_id;
        else if (standing.length > 1) {
          const ranked = [...standing].sort((a, b) => Number(b.kills) - Number(a.kills));
          if (Number(ranked[0].kills) > Number(ranked[1] ? ranked[1].kills : 0)) {
            victor = ranked[0].faction_id;
          }
        }
      } catch (e) { console.error('battle victor resolve failed', e); }
      await this.env.DB
        .prepare(
          `UPDATE battles
              SET status = 'ended', ended_tick = last_fire_tick, closed_at_ms = ?,
                  peace_pairs_close = ?, victor_faction_id = ?
            WHERE id = ? AND status = 'active'`,
        )
        .bind(nowMs, peaceJson, victor, row.id)
        .run();

      // Every finished engagement gets a public link, minted here rather
      // than on demand.
      //
      // The token has to exist before the Herald writes about the battle,
      // and the Herald runs unattended -- there is no admin present to
      // click 'share'. Minting at close also means the link for a given
      // battle never changes: the paper, a Discord post and the analytics
      // browser all point at one URL.
      //
      // created_by NULL marks it as the house's own link. The unique index
      // is on (battle_id, created_by), so this cannot collide with a
      // token a player later mints for themselves, and INSERT OR IGNORE
      // keeps a re-close from minting a second house token.
      try {
        await this.env.DB
          .prepare(
            `INSERT OR IGNORE INTO battle_shares
               (token, battle_id, game_id, created_by, created_at_ms)
             VALUES (?, ?, ?, NULL, ?)`,
          )
          .bind(newRecapToken(), row.id, gameId, nowMs)
          .run();
      } catch (e) { console.error('recap token mint failed', e); }
    }

    // A campaign ends when the last engagement in it does. Doing this
    // AFTER the battles close means the same quiet window that holds one
    // engagement together across a lull holds a theatre together across a
    // body being taken and the fleet moving to the next one.
    try {
      await this.env.DB
        .prepare(
          `UPDATE battle_theatres
              SET status = 'ended', ended_tick = last_fire_tick, closed_at_ms = ?
            WHERE game_id = ? AND status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM battles b
                 WHERE b.theatre_id = battle_theatres.id AND b.status = 'active')`,
        )
        .bind(nowMs, gameId)
        .run();
    } catch (e) { console.error('theatre close failed', e); }
  }

  async tickTerraforming(gameId, tick) {
    try {
      const done = (await this.env.DB
        .prepare(
          `SELECT b.id, b.name, b.owner_faction_id, f.name AS faction_name
             FROM game_bodies b
             LEFT JOIN game_factions f ON f.id = b.owner_faction_id
            WHERE b.game_id = ? AND b.terraformed_at_tick IS NULL
              AND b.terraform_completes_at_tick IS NOT NULL
              AND b.terraform_completes_at_tick <= ?`,
        )
        .bind(gameId, tick)
        .all()).results ?? [];
      for (const b of done) {
        await this.env.DB
          .prepare('UPDATE game_bodies SET terraformed_at_tick = ? WHERE id = ? AND game_id = ?')
          .bind(tick, b.id, gameId)
          .run();
        try {
          await this.env.DB
            .prepare(
              `INSERT OR IGNORE INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'terraform_complete', ?, ?, ?, 'public', ?)`,
            )
            .bind(`c_tfc_${b.id}_${tick}`, gameId, tick, b.owner_faction_id, b.id,
                  JSON.stringify({ faction_name: b.faction_name ?? null, body_name: b.name ?? null }),
                  Date.now())
            .run();
        } catch (e) { console.error('terraform_complete chronicle failed', e); }
        this.broadcast({ type: 'terraform_complete', tick, body_id: b.id, faction_id: b.owner_faction_id });
      }

      // STRANDED STOCKPILES (fartmaster, 2026-08-14: "it appears to still
      // have materials trapped in its stockpile. What do? I want my
      // science points").
      //
      // A raw world banks 90% of its yield in the settlement stockpile and
      // logistics freighters come and vacuum it. Terraforming flips the
      // split to 100% pool / 0% stock — which closes the loading dock
      // without emptying it. Whatever was on the dock the moment the world
      // flipped has nothing left to come and collect it, and local
      // construction can only spend stockpiled METAL and GOLD, so
      // stranded fuel and science were unreachable by any means at all.
      //
      // Terraformed worlds pay their whole yield into the pool, so the
      // pool is where anything still sitting at one belongs. Written as a
      // scan rather than a hook on the completion above so that games
      // which already stranded a pile heal on the next tick instead of
      // needing a migration. Terraformed worlds never accumulate stock
      // again, so this finds only residue and returns nothing on
      // virtually every tick.
      //
      // Safe against every route kind: terraform and dyson runs load from
      // the POOL at a terraformed origin, and the stockpile-vacuuming
      // pickup only ever runs at raw origins. Sweeping here cannot starve
      // a route — it feeds the two that load from the pool.
      const stranded = (await this.env.DB
        .prepare(
          `SELECT s.id AS id, s.owner_faction_id AS fid,
                  s.stockpile_fuel    AS f, s.stockpile_metal   AS m,
                  s.stockpile_gold    AS g, s.stockpile_science AS sc
             FROM game_settlements s
             JOIN game_bodies b ON b.id = s.body_id
            WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL
              AND s.owner_faction_id IS NOT NULL
              AND b.terraformed_at_tick IS NOT NULL
              AND (s.stockpile_fuel  > 0 OR s.stockpile_metal   > 0
                OR s.stockpile_gold  > 0 OR s.stockpile_science > 0)`,
        )
        .bind(gameId)
        .all()).results ?? [];
      if (stranded.length) {
        const perFaction = new Map();
        for (const s of stranded) {
          const f  = Math.max(0, Number(s.f  ?? 0));
          const m  = Math.max(0, Number(s.m  ?? 0));
          const g  = Math.max(0, Number(s.g  ?? 0));
          const sc = Math.max(0, Number(s.sc ?? 0));
          if (f + m + g + sc <= 0) continue;
          // Subtract exactly what was read rather than SET 0, so anything
          // credited between the read and this write survives.
          await this.env.DB
            .prepare(
              `UPDATE game_settlements
                  SET stockpile_fuel    = stockpile_fuel    - ?,
                      stockpile_metal   = stockpile_metal   - ?,
                      stockpile_gold    = stockpile_gold    - ?,
                      stockpile_science = stockpile_science - ?
                WHERE id = ?`,
            )
            .bind(f, m, g, sc, s.id)
            .run();
          const agg = perFaction.get(s.fid) ?? { f: 0, m: 0, g: 0, sc: 0 };
          agg.f += f; agg.m += m; agg.g += g; agg.sc += sc;
          perFaction.set(s.fid, agg);
        }
        for (const [fid, agg] of perFaction) {
          await this.env.DB
            .prepare(
              `UPDATE game_factions
                  SET fuel = fuel + ?, metal = metal + ?,
                      gold = gold + ?, science = science + ?
                WHERE id = ?`,
            )
            .bind(agg.f, agg.m, agg.g, agg.sc, fid)
            .run();
        }
      }
    } catch (e) {
      // NEVER kill resolveTick — same tolerance as the dyson tick.
      console.error('terraform tick failed', e);
    }
  }

  /**
   * Server mirror of src/game/victory.ts checkVictory.
   *
   * THREE win conditions (2026-08-02 rework — per Lorne):
   *   ENGINEERING  dyson_hp >= dyson_max_hp — the Sol Dyson Sphere
   *   CHANCELLOR   senate elects you Supreme Chancellor (fires from
   *                worker/senate.js when a chancellor_vote bill passes,
   *                NOT from this checker — listed for completeness)
   *   DOMINATION   own MORE than 60% of the map's claimable bodies
   *                (everything except stars/black holes; ownership is
   *                the settlement-derived game_bodies.owner_faction_id)
   *
   * MILITARY (all rival settlements destroyed) was retired in the same
   * rework: total elimination now wins by growing into 60% of the map,
   * which a sole survivor does uncontested. SCIENCE remains disabled.
   *
   * Returns { winnerFactionId, victoryType, detail } or null.
   */
  async checkVictory(gameId) {
    // Active factions only — observers / eliminated seats excluded.
    const factions = (await this.env.DB
      .prepare(`SELECT id, name FROM game_factions WHERE game_id = ? AND status = 'active'`)
      .bind(gameId)
      .all()).results ?? [];
    if (factions.length === 0) return null;

    // ----- ENGINEERING -----
    // Dyson Sphere lives on the `games` row as nullable columns
    // populated by Phase B. The hp/max_hp pair encodes both progress
    // and combat damage; reaching parity means the sphere is built.
    try {
      const dyson = await this.env.DB
        .prepare(
          `SELECT dyson_controller_faction_id, dyson_hp, dyson_max_hp
             FROM games WHERE id = ?`,
        )
        .bind(gameId)
        .first();
      if (
        dyson &&
        dyson.dyson_controller_faction_id &&
        dyson.dyson_max_hp > 0 &&
        dyson.dyson_hp >= dyson.dyson_max_hp
      ) {
        return {
          winnerFactionId: dyson.dyson_controller_faction_id,
          victoryType: 'engineering',
          detail: 'Dyson Sphere complete',
        };
      }
    } catch {
      // Column may not exist yet (pre-Phase-B DBs). Fall through.
    }

    // ----- DOMINATION -----
    // Own MORE than 60% of the worlds that can hold a station — which
    // is EVERY non-destroyed body (stations have no body-type gate;
    // that's how gas giants and Sol itself get settled, and a Sol
    // station claims Sol through the same settlement-derived ownership
    // as anywhere else). Ownership is game_bodies.owner_faction_id,
    // the claim recomputeBodyOwnership maintains — the same fact the
    // political map shading paints. Even the sun is territory.
    try {
      const DOMINATION_FRACTION = 0.6;
      const counts = (await this.env.DB
        .prepare(
          `SELECT owner_faction_id AS fid, COUNT(*) AS n
             FROM game_bodies
            WHERE game_id = ? AND destroyed_at_tick IS NULL
            GROUP BY owner_faction_id`,
        )
        .bind(gameId)
        .all()).results ?? [];
      let total = 0;
      const owned = new Map();
      for (const r of counts) {
        total += Number(r.n ?? 0);
        if (r.fid) owned.set(r.fid, Number(r.n ?? 0));
      }
      if (total > 0) {
        for (const candidate of factions) {
          const n = owned.get(candidate.id) ?? 0;
          if (n > total * DOMINATION_FRACTION) {
            return {
              winnerFactionId: candidate.id,
              victoryType: 'domination',
              detail: `Controls ${n} of ${total} worlds (${Math.round((n / total) * 100)}%)`,
            };
          }
        }
      }
    } catch (e) {
      console.error('domination victory check failed', e);
    }

    // SCIENCE victory was removed outright in the three-conditions
    // rework (it had already been flag-disabled after ending a live
    // game at tick 208 — research accrues on an uncontestable curve).
    // The three paths are engineering / chancellor / domination.

    return null;
  }
}
