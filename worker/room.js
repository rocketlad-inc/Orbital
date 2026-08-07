import { resolveSenate, getSliderResolver, hasActiveSanction } from './senate.js';
import { recomputeBodyOwnership, SETTLEMENT_SPEED } from './factions.js';
import { parsePartsJson, computeShipStats, countPart, detonatorDamage,
         shipSpeed, hitChance,
         damageProfile, defenseMitigation, MITIGATION_FLOOR, refitFee } from './shipDesigns.js';
import { ensureCaptains, resolveCaptainOnDeath, parseTraits, traitMul, ensureCaptainFloor } from './captains.js';
import { cfg as loadGameConfig } from './gameConfig.js';

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
        this.broadcast({
          type: 'chat',
          from: { userId: att.userId, displayName: att.displayName },
          text,
          at: Date.now(),
        });
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
    this.broadcast({ type: 'presence', members: await this.memberList(), connected: this.connectedUserIds(), ready: this.readyMap() });
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

  connectedUserIds() {
    const ids = new Set();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.userId) ids.add(att.userId);
    }
    return [...ids];
  }

  readyMap() {
    const connected = new Set(this.connectedUserIds());
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

  async resolveTick(gameId, tick) {
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
    try {
      await ensureCaptainFloor(this.env.DB, gameId, tick);
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
              AND (SELECT COUNT(*) FROM game_ships s
                    WHERE s.fleet_id = f.id AND s.status = 'active') < 2`,
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
    try {
      const dueOrders = (await this.env.DB
        .prepare(
          `SELECT id, buildings_json, building_order_json
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
        await this.env.DB
          .prepare('UPDATE game_settlements SET buildings_json = ?, building_order_json = NULL WHERE id = ?')
          .bind(JSON.stringify(buildings), row.id)
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
                icon_variant, ship_name, parts_json, rush_count, botched
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
      // Tight park orbit: just off the surface. Was radius+4, which put
      // hulls twice the planet's disc away and crowded moon lanes in big
      // systems (player report). KEEP IN SYNC with the arrival pass below
      // and the client's optimistic park (gameContext parkRadius).
      const rp = (body.radius || 4) + 2;
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

      // Veteran Yards (weapons 5, project_intel_gating): new hulls launch
      // with a QUARTER of the faction's average fleet rank instead of raw
      // rank 0. Ungated (grandfathered) games get it for free, matching
      // how every other research gate behaves there. Build completions
      // are rare, so the two extra point queries per hull are cheap.
      let spawnRank = 0;
      try {
        const gRow = await this.env.DB
          .prepare('SELECT gating_enabled FROM games WHERE id = ?')
          .bind(gameId).first();
        const wRow = await this.env.DB
          .prepare(`SELECT level FROM faction_techs
                     WHERE game_id = ? AND faction_id = ? AND tech_id = 'weapons'`)
          .bind(gameId, b.faction_id).first();
        const veteranYards = (gRow?.gating_enabled ?? 0) !== 1 || Number(wRow?.level ?? 0) >= 5;
        if (veteranYards) {
          const avgRow = await this.env.DB
            .prepare(`SELECT AVG(rank) AS r FROM game_ships
                       WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`)
            .bind(gameId, b.faction_id).first();
          spawnRank = Math.max(0, Math.floor(Number(avgRow?.r ?? 0) / 4));
        }
      } catch (e) { console.error('veteran yards rank calc failed', e); }

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
          const slots = 1 + shipyardLevels;
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

    for (const n of arrivals) {
      if (!n.target_body_id) continue;
      const target = await this.env.DB
        .prepare('SELECT radius FROM game_bodies WHERE id = ?')
        .bind(n.target_body_id)
        .first();
      if (!target) continue;
      // Tight park orbit on arrival — keep in sync with the build-spawn
      // park above and the client's optimistic parkRadius.
      const rp = (target.radius || 4) + 2;
      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `UPDATE game_ships
                SET parent_body_id = ?,
                    orbit_rp = ?, orbit_ra = ?, orbit_omega = 0,
                    orbit_m0 = 0, orbit_epoch = ?, orbit_direction = 1
              WHERE id = ?`,
          )
          .bind(n.target_body_id, rp, rp, tick, n.ship_id),
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
            const PICKUP_CAP = Math.round(500 * traitMul(parseTraits(ship.captain_traits), 'cargoMul'));
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
    try {
      // Per-resource cargo cap. Raised 50 -> 500 alongside the
      // 10%/90% economy rewrite — non-collector stockpiles now grow
      // fast enough that a 50-unit hold was a thimble. 500 lets one
      // freighter visit empty a typical settlement stockpile in one
      // round trip while keeping tonnage a real ship stat (a busy
      // hub may still need multiple runs).
      const CARGO_CAP = 500;
      const routes = (await this.env.DB
        .prepare(
          `SELECT id, owner_faction_id, ship_id, origin_body_id, dest_body_id, status,
                  cargo_fuel, cargo_metal, cargo_gold, cargo_science
             FROM game_trade_routes
            WHERE game_id = ? AND cancelled_at_tick IS NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];

      // Helper: recursive heliocentric body position. Mirrors the
      // client's bodyPosition in src/physics/orbitalMechanics.ts —
      // the legacy circular-orbit shortcut. Rogue Kuiper asteroids
      // with eccentric Kepler elements (orbit_rp/ra/omega/m0) aren't
      // valid trade-route endpoints in v1, so we don't need the
      // Kepler propagator here. Cached per-call to avoid re-querying
      // the same parent body multiple times in one leg lookup.
      const TWO_PI = 2 * Math.PI;
      const bodyCache = new Map();
      const fetchBody = async (id) => {
        if (bodyCache.has(id)) return bodyCache.get(id);
        const row = await this.env.DB
          .prepare(
            `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0
               FROM game_bodies WHERE id = ? AND game_id = ?`,
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
        const angle = (b.angle0 ?? 0) + TWO_PI * t / (b.orbit_period || 1);
        return {
          x: parent.x + Math.cos(angle) * (b.orbit_radius ?? 0),
          y: parent.y + Math.sin(angle) * (b.orbit_radius ?? 0),
        };
      };

      // Torch trip-time. Mirrors planTorchTransfer in
      // src/physics/torchTransfer.ts — closed-form brachistochrone
      // T = 2·√(d/a) for symmetric accel, with a 5-iteration
      // intercept refinement so target-body motion during the trip
      // is accounted for. Returns an integer tick count >= 1.
      //
      // Previously this used a hard-coded LEG_TICKS = 60. For a short
      // Jupiter-system moon-hop (Europa↔Ganymede ≈ 30 units, T ≈ 2)
      // that gave the client a 60-tick window to run the torch
      // integrator at full thrust both directions — producing the
      // 23,000-unit overshoot zigzags the player reported.
      const G_ANCHOR = 4 * 132.6;            // mirror physics/torchTransfer.ts
      const DEFAULT_ENGINE_G = 0.05;
      const fromG = (g) => g * G_ANCHOR;
      const factionAccelCache = new Map();
      const getFactionAccel = async (factionId) => {
        if (factionAccelCache.has(factionId)) return factionAccelCache.get(factionId);
        const f = await this.env.DB
          .prepare('SELECT engine_g FROM game_factions WHERE id = ?')
          .bind(factionId)
          .first();
        const g = f?.engine_g ?? DEFAULT_ENGINE_G;
        const accel = fromG(g);
        factionAccelCache.set(factionId, accel);
        return accel;
      };
      const computeLegTicks = async (factionId, originId, destId, refTick) => {
        const accel = await getFactionAccel(factionId);
        const startPos = await bodyPosAt(originId, refTick);
        let T = 1;
        for (let i = 0; i < 5; i++) {
          const destPos = await bodyPosAt(destId, refTick + T);
          const dx = destPos.x - startPos.x;
          const dy = destPos.y - startPos.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const Tnew = 2 * Math.sqrt(Math.max(d, 0.01) / accel);
          if (Math.abs(Tnew - T) < 0.05) { T = Tnew; break; }
          T = Tnew;
        }
        // Clamp to integer ticks >= 1. Aggressively short trips (T<1)
        // still need at least one tick so the depart→arrive state
        // machine has room to fire 2a then 2b.
        return Math.max(1, Math.ceil(T));
      };

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
        // Dead or missing freighter → cancel the route so we don't keep
        // scanning it. Piracy step (below) handles cargo capture if the
        // freighter died this tick.
        if (!ship || ship.status !== 'active') {
          await this.env.DB
            .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE id = ?')
            .bind(tick, r.id).run();
          continue;
        }
        // Senate trade embargo: if this route's owner is under embargo
        // right now, the freighter sits idle this tick — no pickup, no
        // delivery, no new leg planned. Resumes the moment the embargo
        // expires (senate_effects.active_until_tick clears).
        if (await sanctioned(r.owner_faction_id, 'trade_embargo')) continue;
        if (ship.ship_class !== 'freighter') continue;

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

        const planLeg = async (targetBodyId) => {
          // Insert a committed node toward targetBodyId. 2a will flip
          // it to in_transit next tick; 2b will arrive it at the
          // computed arrival tick. Trip time uses real torch math
          // (computeLegTicks above) so the client's reconstructed
          // plan agrees on the timing — without that the client's
          // integrator runs full thrust over an inflated arrival
          // window and produces zigzag overshoot trajectories.
          const legTicks = await computeLegTicks(
            r.owner_faction_id, here, targetBodyId, tick,
          );
          const seqRow = await this.env.DB
            .prepare('SELECT MAX(sequence) AS m FROM game_ship_nodes WHERE ship_id = ?')
            .bind(r.ship_id).first();
          const seq = (seqRow?.m ?? -1) + 1;
          const nodeId = `${r.ship_id}:tr${tick}:n${seq}`;
          await this.env.DB
            .prepare(
              `INSERT INTO game_ship_nodes
                 (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
                  scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
                  status, committed_at_tick)
               VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, 0, 0, 0, 0, 'committed', ?)`,
            )
            .bind(nodeId, gameId, r.ship_id, seq, targetBodyId, tick, tick + legTicks, tick)
            .run();
        };

        if (here === r.origin_body_id && cargoTotal < 1) {
          // PICKUP: vacuum from settlement stockpiles at origin.
          const stocks = (await this.env.DB
            .prepare(
              `SELECT id, stockpile_fuel, stockpile_metal, stockpile_gold, stockpile_science
                 FROM game_settlements
                WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
                  AND destroyed_at_tick IS NULL`,
            )
            .bind(gameId, r.origin_body_id, r.owner_faction_id)
            .all()).results ?? [];
          // Quartermaster captain (spec §3): +25% hold on this freighter.
          const HOLD = Math.round(CARGO_CAP * traitMul(parseTraits(ship.captain_traits), 'cargoMul'));
          let cf = 0, cm = 0, cg = 0, csci = 0;
          for (const s of stocks) {
            const take = {
              f:  Math.min(HOLD - cf,   Number(s.stockpile_fuel    ?? 0)),
              m:  Math.min(HOLD - cm,   Number(s.stockpile_metal   ?? 0)),
              g:  Math.min(HOLD - cg,   Number(s.stockpile_gold    ?? 0)),
              sc: Math.min(HOLD - csci, Number(s.stockpile_science ?? 0)),
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
            if (cf >= HOLD && cm >= HOLD && cg >= HOLD && csci >= HOLD) break;
          }
          // Always plan the outbound leg — even an empty stockpile
          // sends the freighter cycling so it'll try again next loop.
          await this.env.DB
            .prepare(
              `UPDATE game_trade_routes
                  SET cargo_fuel = ?, cargo_metal = ?, cargo_gold = ?, cargo_science = ?,
                      status = 'outbound'
                WHERE id = ?`,
            )
            .bind(cf, cm, cg, csci, r.id)
            .run();
          await planLeg(r.dest_body_id);
          continue;
        }

        if (here === r.dest_body_id) {
          // DELIVERY: dump whatever's in the hold and cycle back home.
          // Previously this required cargoTotal > 0, but a freighter
          // that picked up an empty stockpile arrives at dest with
          // nothing in the hold and got STUCK (DELIVERY didn't fire
          // and the nudge saw here === target). That's what the
          // playtester saw as "trade routes aren't repeating".
          // Only bump trades_completed for cargo-bearing deliveries
          // so the counter still tracks real runs.
          const batch = [
            this.env.DB
              .prepare(
                `UPDATE game_factions
                    SET fuel    = fuel    + ?,
                        metal   = metal   + ?,
                        gold    = gold    + ?,
                        science = science + ?
                  WHERE id = ?`,
              )
              .bind(cargoFuel, cargoMetal, cargoGold, cargoScience, r.owner_faction_id),
            this.env.DB
              .prepare(
                `UPDATE game_trade_routes
                    SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0,
                        status = 'returning'
                  WHERE id = ?`,
              )
              .bind(r.id),
          ];
          // Delivered science counts as INCOME this tick, not just bank.
          // The research drain clamps spend to income, so without this a
          // trade-fed faction banked science forever without advancing a
          // tech (playtest report). Additive — the harvest pass adds its
          // settlement yield to the same map later in the tick.
          if (cargoScience > 0) {
            scienceIncomeByFaction.set(
              r.owner_faction_id,
              (scienceIncomeByFaction.get(r.owner_faction_id) ?? 0) + cargoScience,
            );
          }
          if (cargoTotal > 0) {
            batch.push(
              this.env.DB
                .prepare('UPDATE game_ships SET trades_completed = trades_completed + 1 WHERE id = ?')
                .bind(r.ship_id),
            );
          }
          await this.env.DB.batch(batch);
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
                COALESCE(c.rank, s.rank) AS rank, s.ship_class, s.name, s.last_combat_tick,
                s.stance, s.retreat_hp_pct, s.detonate_hp_pct, s.parts_json,
                s.target_priority,
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
    const tallyShot = (attackerClass, targetClass, landed, dmg, targetId) => {
      const k = `${attackerClass}>${targetClass}`;
      let e = combatTally.get(k);
      if (!e) { e = { volleys: 0, hits: 0, damage: 0, kills: 0 }; combatTally.set(k, e); }
      e.volleys++;
      if (landed) {
        e.hits++;
        e.damage += dmg;
        if (targetId) {
          let set = hitBy.get(targetId);
          if (!set) { set = new Set(); hitBy.set(targetId, set); }
          set.add(attackerClass);
        }
      }
      return e;
    };
    /** Credit a kill to every class that landed on this hull this tick. */
    const tallyKill = (targetId, targetClass) => {
      const set = hitBy.get(targetId);
      if (!set) return;
      for (const cls of set) {
        const e = combatTally.get(`${cls}>${targetClass}`);
        if (e) e.kills++;
      }
    };

    /** Speed of any combatant. Settlements are not ships but they shoot and
     *  are shot at, so they answer on the same scale. */
    const speedOfShip = (sh) => shipSpeed(sh.ship_class, sh._parts);
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
    const peaceRows = (await this.env.DB
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
    for (const r of peaceRows) {
      if (!treatyToFactions.has(r.id)) treatyToFactions.set(r.id, []);
      treatyToFactions.get(r.id).push(r.faction_id);
    }
    const peace = new Set();
    const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const sigs of treatyToFactions.values()) {
      for (let i = 0; i < sigs.length; i++) {
        for (let j = i + 1; j < sigs.length; j++) {
          peace.add(pairKey(sigs[i], sigs[j]));
        }
      }
    }

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
                shield_hp, shield_hp_max, shield_down_tick
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
    // A body sees hostilities if ≥2 factions are present across ships
    // AND settlements combined (so a ship attacking an undefended
    // enemy settlement, or a settlement firing on a lone raider, both
    // count even when only one faction has ships there).
    const combatBodyIds = new Set([...byBody.keys(), ...combatSettlementsByBody.keys()]);
    for (const bodyId of combatBodyIds) {
      const ships = byBody.get(bodyId) ?? [];
      const localSettlements = combatSettlementsByBody.get(bodyId) ?? [];
      const factions = new Set([
        ...ships.map(s => s.owner_faction_id),
        ...localSettlements.map(s => s.owner_faction_id),
      ]);
      if (factions.size < 2) continue;
      // Round-robin fire distribution: the Nth shooter at this body takes
      // the Nth target in its priority tier (offset by tick so pairings
      // ROTATE across volleys instead of locking the same duel forever).
      let shooterIdx = 0;
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
        // COMBAT V2 — PEER TARGETING. Tier priority is unchanged (everything
        // in orbit still dies before a settlement is touched); what changes is
        // the pick WITHIN the tier: engage whoever is closest to your own
        // speed. Corvettes tangle with corvettes, destroyers slug it out with
        // destroyers, and most shots in the game are fired at an even 50%.
        //
        // Without this, every gun points at the slowest thing present and
        // capital ships become unplayable.
        tier.sort((a, b) => (a.id < b.id ? -1 : 1));   // deterministic tie-break
        const atkSpeed = speedOfShip(attacker);
        // Nearest speed wins; on an EQUAL gap the slower target wins
        // (close, then below, then above — Lorne's rule). Slower is the
        // better shot, so the tie resolves toward the target you'd
        // actually hit, instead of falling through to ship-id order.
        let target = tier[0];
        let bestGap = Infinity;
        let bestBelow = false;
        for (const cand of tier) {
          const candSpeed = isShipTier ? speedOfShip(cand) : speedOfSettlement();
          const gap = Math.abs(atkSpeed - candSpeed);
          const below = candSpeed <= atkSpeed;
          if (gap < bestGap - 1e-9
              || (Math.abs(gap - bestGap) <= 1e-9 && below && !bestBelow)) {
            bestGap = gap; bestBelow = below; target = cand;
          }
        }
        shooterIdx++;

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
          tallyShot(attacker.ship_class, targetClassLabel, false, 0, target.id);
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
          tallyShot(attacker.ship_class, targetClassLabel, true, dealt, target.id);
          addDamage(target.id, attacker.owner_faction_id, attacker.id, dealt);
        } else {
          // Bombardment — settlements carry no shield/armor parts yet, and
          // their PDC (city 0.3 / station 0.5) went with the rest of the
          // system, so a bombarding volley now lands in full.
          tallyShot(attacker.ship_class, 'settlement', true, attackPower * warAuthMul, target.id);
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
        // Round-robin single-target, same as ships: one aggressor per
        // volley, rotating across volleys via the tick offset.
        shipTargets.sort((a, b) => (a.id < b.id ? -1 : 1));
        const target = shipTargets[tick % shipTargets.length];
        // Settlement guns fire kinetic, so a target's shields cut them
        // and armor does nothing — same counter-matrix as ship kinetic.
        const KINETIC = { kinetic: 1, energy: 0 };
        const power = base * kineticMulOf(st.owner_faction_id) * combatDamageMultOf(st.owner_faction_id);
        const warAuthMul = (await sanctioned(target.owner_faction_id, 'war_authorization')) ? 2 : 1;
        // Seeded on the settlement id so a station's roll is as reproducible
        // as a ship's.
        if (rollFor(st.id, tick) >= hitChance(speedOfSettlement(), speedOfShip(target))) {
          tallyShot('station', target.ship_class, false, 0, target.id);
          firedSettlementIds.add(st.id);
          firedSettlementTargets.set(st.id, target.id);
          continue;
        }
        const mit = Math.max(MITIGATION_FLOOR,
          defenseMitigation(target._parts, KINETIC));
        const stnDealt = power * mit * warAuthMul;
        tallyShot('station', target.ship_class, true, stnDealt, target.id);
        addDamage(target.id, st.owner_faction_id, null, stnDealt);
        firedSettlementIds.add(st.id);
        firedSettlementTargets.set(st.id, target.id);
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
    const REPAIR_PER_YARD_LEVEL = 5;
    /** A station with no shipyard is still a dry dock, just a bare one. */
    const REPAIR_STATION_BASE = 2;
    /** Kept for the armor-5 Damage Control trickle, which is a faction
     *  buff rather than infrastructure and shouldn't scale with a yard
     *  the ship isn't parked at. */
    const REPAIR_STATION = 2;
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
                s.fuel, s.fuel_max, COALESCE(c.rank, s.rank) AS rank,
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
          // Bare station repairs at the old flat rate; every shipyard
          // level on it adds REPAIR_PER_YARD_LEVEL on top.
          let yardLvl = 0;
          if (st.buildings_json) {
            try { yardLvl = Number(JSON.parse(st.buildings_json)?.shipyard ?? 0) || 0; }
            catch { yardLvl = 0; }
          }
          repairRate += REPAIR_STATION_BASE + REPAIR_PER_YARD_LEVEL * yardLvl;
          refuelRate += REFUEL_STATION;
        }
      }
      // Damage Control (armor 5, project_intel_gating): hulls of a
      // researched faction self-repair a trickle ANYWHERE — mid-fight,
      // deep space, no dry dock required. Half the station rate, and it
      // stacks with a station when parked at one.
      if (hasBuff(ship.owner_faction_id, 'armor', 5)) repairRate += REPAIR_STATION / 2;
      const shipTraits = parseTraits(ship.captain_traits);
      // Wrench captain (spec §3): ×1.5 repair rate.
      repairRate *= traitMul(shipTraits, 'repairMul');
      if (repairRate <= 0 && refuelRate <= 0) continue;
      // Effective HP cap = base × rank (+1%/kill) × armor tech (+8%/level)
      // × Bulwark captain (+10%). Rank is the CAPTAIN's (COALESCEd in the
      // SELECT); the client mirrors all of this in effectiveShipMaxHp.
      repairRate *= auraMul(ship.id, 'repairMul');   // Wrench flag aura
      const effectiveMaxHp = (ship.hp_max ?? 0)
        * (1 + 0.01 * Math.max(0, ship.rank ?? 0))
        * armorMulOf(ship.owner_faction_id)
        * traitMul(shipTraits, 'hpMul')
        * auraMul(ship.id, 'hpMul');   // Bulwark flag aura
      const newHp = Math.min(effectiveMaxHp, (ship.hp ?? effectiveMaxHp) + repairRate);
      const newFuel = Math.min(ship.fuel_max ?? 0, (ship.fuel ?? 0) + refuelRate);
      if (newHp === ship.hp && newFuel === ship.fuel) continue;
      await this.env.DB
        .prepare('UPDATE game_ships SET hp = ?, fuel = ? WHERE id = ?')
        .bind(newHp, newFuel, ship.id)
        .run();
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
    const POP_GROWTH_INTERVAL = 20;
    const POP_MAX = 10;
    const settlements = (await this.env.DB
      .prepare(
        `SELECT s.id, s.owner_faction_id AS fid, s.body_id, s.type, s.population,
                s.last_growth_tick, s.has_collector, s.buildings_json,
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
      // same faction at that body. A collector anywhere in the group
      // flips the WHOLE group to 100% pool; otherwise the group's
      // 90% stockpile share gets written to the primary holder
      // (prefer city → fall back to station). This is what makes a
      // station's yield reach the city's local pile instead of
      // stranding in a separate station-only stockpile, and what makes
      // a collector on a city also collect for the station orbiting it.
      // Keyed (body, faction) so two factions sharing a body still keep
      // their stockpiles independent.
      const groupKey = (s) => `${s.body_id}|${s.fid}`;
      const groupHasCollector = new Map();
      const groupPrimary = new Map(); // groupKey -> { id, type }
      for (const s of settlements) {
        const k = groupKey(s);
        if (s.has_collector) groupHasCollector.set(k, true);
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
        const groupCollector = groupHasCollector.get(gk) === true;
        const toPoolFraction  = groupCollector ? 1.0 : NO_COLLECTOR_POOL_FRACTION;
        const toStockFraction = groupCollector ? 0.0 : NO_COLLECTOR_STOCK_FRACTION;

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
      const fleetCounts = (await this.env.DB
        .prepare(
          `SELECT owner_faction_id AS fid, ship_class, COUNT(*) AS n
             FROM game_ships
            WHERE game_id = ? AND status = 'active'
            GROUP BY owner_faction_id, ship_class`,
        )
        .bind(gameId)
        .all()).results ?? [];
      const owedByFaction = new Map(); // fid -> { gold, metal }
      for (const row of fleetCounts) {
        const u = UPKEEP[row.ship_class];
        if (!u) continue;
        const agg = owedByFaction.get(row.fid) ?? { gold: 0, metal: 0 };
        agg.gold  += u.gold  * row.n;
        agg.metal += u.metal * row.n;
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
      // COMBAT V2 telemetry flush. Runs after damage resolution so kills are
      // already credited. At most ~36 rows (6 attacker classes x 6 target
      // classes), so the whole tick is one batch regardless of fleet size.
      if (combatTally.size > 0) {
        try {
          const tallyStmts = [];
          for (const [key, e] of combatTally) {
            const [atkCls, tgtCls] = key.split('>');
            tallyStmts.push(
              this.env.DB.prepare(
                `INSERT INTO game_combat_tally
                   (game_id, attacker_class, target_class, volleys, hits, damage, kills)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(game_id, attacker_class, target_class) DO UPDATE SET
                   volleys = volleys + excluded.volleys,
                   hits    = hits    + excluded.hits,
                   damage  = damage  + excluded.damage,
                   kills   = kills   + excluded.kills`,
              ).bind(gameId, atkCls, tgtCls, e.volleys, e.hits, e.damage, e.kills),
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

      // Hulls that took fire and LIVED. Destruction is chronicled; being
      // shot was not, so a player watching the log saw nothing until a
      // ship actually died — no warning, which is exactly how you lose a
      // world without noticing. Aggregated per body+owner below so a
      // 20-ship brawl is one line, not twenty.
      const damagedSurvivors = [];
      for (const [shipId, entry] of hpDeltas) {
        const cur = allShips.find(s => s.id === shipId);
        if (!cur) continue;
        const newHp = Math.max(0, cur.hp - entry.total);
        if (newHp <= 0) {
          await this.env.DB
            .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
            .bind(tick, shipId)
            .run();
          tallyKill(shipId, cur.ship_class);
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
              hpMax: cur.hp_max ?? null,
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

      // Flush veteran awards — rank + history now belong to the CAPTAIN
      // (spec §2), so a survivor carries his record into the next hull.
      // The killer's current rank comes from the allShips snapshot (which
      // already COALESCEs captain rank); history is re-read from the
      // captain row since the snapshot no longer carries it. Legacy
      // fallback (no captain yet) writes the old ship columns unchanged.
      const KILL_HISTORY_CAP = 20;
      for (const [killerShipId, award] of veteranAwards) {
        const killer = allShips.find(s => s.id === killerShipId);
        if (!killer) continue;
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
        if (killer.captain_id) {
          const cap = await this.env.DB
            .prepare('SELECT combat_history FROM game_captains WHERE id = ?')
            .bind(killer.captain_id).first();
          await this.env.DB
            .prepare('UPDATE game_captains SET rank = ?, combat_history = ? WHERE id = ?')
            .bind(newRank, applyHistory(cap?.combat_history), killer.captain_id)
            .run();
        } else {
          const shipRow = await this.env.DB
            .prepare('SELECT combat_history FROM game_ships WHERE id = ?')
            .bind(killerShipId).first();
          await this.env.DB
            .prepare('UPDATE game_ships SET rank = ?, combat_history = ? WHERE id = ?')
            .bind(newRank, applyHistory(shipRow?.combat_history), killerShipId)
            .run();
        }
      }

      // Piracy: any destroyed freighter on an active trade route hands
      // its cargo to the kill-credit faction. Mirrors the SP hook in
      // src/state/gameContext.tsx. Routes are cancelled regardless —
      // the ship is gone, the auto-pilot has nothing to drive.
      if (losses.length > 0) {
        const placeholders = losses.map(() => '?').join(',');
        const looted = (await this.env.DB
          .prepare(
            `SELECT id, ship_id, owner_faction_id,
                    cargo_fuel, cargo_metal, cargo_gold, cargo_science
               FROM game_trade_routes
              WHERE game_id = ?
                AND cancelled_at_tick IS NULL
                AND ship_id IN (${placeholders})`,
          )
          .bind(gameId, ...losses)
          .all()).results ?? [];
        for (const r of looted) {
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
                  SET cancelled_at_tick = ?,
                      cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
                WHERE id = ?`,
            )
            .bind(tick, r.id)
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
        for (const lost of lostShipRows) {
          const ship = await this.env.DB
            .prepare('SELECT name, ship_class, parent_body_id FROM game_ships WHERE id = ?')
            .bind(lost.id).first();
          const body = ship?.parent_body_id
            ? await this.env.DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(ship.parent_body_id).first()
            : null;
          const killerFid = killerByShip.get(lost.id) ?? null;
          const entryId = `c${tick}_${lost.id.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
          const payload = JSON.stringify({
            ship_id: lost.id,
            ship_name: ship?.name ?? 'Unknown',
            ship_class: ship?.ship_class ?? 'unknown',
            body_id: ship?.parent_body_id ?? null,
            body_name: body?.name ?? 'unknown space',
            // Killer attribution: top per-faction damage dealer. Null when
            // no combat-capable ship was at the body (e.g. a kill from a
            // future settlement attacker — currently impossible but
            // forward-compatible).
            killer_faction_id: killerFid,
            killer_faction_name: killerFid ? (factionNameById.get(killerFid) ?? null) : null,
            owner_faction_name: factionNameById.get(lost.owner_faction_id) ?? null,
            // `lost` is the allShips row (captain_id/captain_name joined
            // above) -- still the CORRECT captain here even though
            // resolveCaptainOnDeath below may detach/rescue them, since
            // that runs AFTER this insert and reads its own fresh query.
            captain_name: lost.captain_name ?? null,
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
        this.broadcast({ type: 'ships_destroyed', tick, ship_ids: losses });
      }
    }

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
          `SELECT id, name, owner_faction_id, parent_body_id, hp, hp_max, retreat_hp_pct
             FROM game_ships
            WHERE game_id = ? AND status = 'active'
              AND retreat_hp_pct IS NOT NULL
              AND hp_max > 0
              AND hp * 100 <= hp_max * retreat_hp_pct`,
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
        for (const st of stationRows) {
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
          const angle = (b.angle0 ?? 0) + TWO_PI * t / (b.orbit_period || 1);
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
            const yards = shipyardBodiesByFaction.get(ship.owner_faction_id);
            if (!yards || yards.size === 0) continue;   // nowhere to run
            // Already home? No move to make — station repair takes over.
            if (yards.has(ship.parent_body_id)) continue;

            // Once per episode: skip if already retreating / in transit.
            const inFlight = await this.env.DB
              .prepare(
                `SELECT 1 AS x FROM game_ship_nodes
                  WHERE ship_id = ? AND status IN ('committed','in_transit') LIMIT 1`,
              )
              .bind(ship.id)
              .first();
            if (inFlight) continue;

            // Nearest yard by straight-line distance at the current tick.
            const herePos = await bodyPosAt(ship.parent_body_id, tick);
            let bestBodyId = null;
            let bestD2 = Infinity;
            for (const yardBodyId of yards) {
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
          const parts = parsePartsJson(ship.ship_class, ship.parts_json);
          const nDet = countPart(parts, 'detonator');
          if (nDet <= 0) continue;
          try {
            // Weapons tech at trigger time, half rate — same as manual.
            const weaponsRow = await this.env.DB
              .prepare("SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = 'weapons'")
              .bind(gameId, ship.owner_faction_id)
              .first();
            const damage = detonatorDamage(ship.hp_max ?? 0, nDet, weaponsRow?.level ?? 0);

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
            await this.env.DB.batch(stmts);

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
                victims: victimSummaries.map(v => ({
                  ...v,
                  owner_faction_name: facName.get(v.owner_faction_id) ?? null,
                })),
                destroyed_count: victimSummaries.filter(v => v.destroyed).length,
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
      }
    } catch (e) {
      // Never let a victory-check bug block the rest of the tick.
      console.error('victory check failed', e);
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
          `SELECT id, owner_faction_id, building_order_json
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
      }

      let targetName = 'Sol';
      let destroyedCount = 0;
      if (!targetIsSol) {
        // Look up target name + current yields.
        const target = await this.env.DB
          .prepare(
            `SELECT name, yield_metal, yield_fuel, yield_gold, yield_science
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
  async resolveSecretReveal(gameId, tick) {
    const SOL_BODY_ID = `${gameId}:sol`;
    const now = Date.now();

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
          // Persistent effect — the warp itself is applied below for
          // any ship currently at the body. The reveal just flips the
          // flag so the chronicle fires once.
          chronicleMessage = `${body_name}: DISCOVERY — an ancient stargate. Every ship arriving here will now be warped to Sol.`;
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
          chronicleMessage = `${body_name}: DISCOVERY — a long-abandoned colony reactivates under your banner — a free city with a working Lab.`;
          break;
        }
        case 'free_collector': {
          const cityId = `${body_id}:cFC${Math.random().toString(36).slice(2, 8)}`;
          const surfaceAngle = Math.random() * Math.PI * 2;
          stmts.push(
            this.env.DB
              .prepare(
                `INSERT INTO game_settlements
                  (id, game_id, body_id, owner_faction_id, type, name,
                   hp, hp_max, population,
                   surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
                   created_at_tick, last_growth_tick, last_harvest_tick,
                   has_collector, collector_built_tick)
                 VALUES (?, ?, ?, ?, 'city', ?,
                         100, 100, 2,
                         ?, NULL, NULL, NULL, NULL, NULL,
                         ?, ?, ?,
                         1, ?)`,
              )
              .bind(cityId, gameId, body_id, discoverer, `${body_name} Hub`,
                    surfaceAngle, tick, tick, tick, tick),
          );
          stmts.push(
            this.env.DB
              .prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?')
              .bind(discoverer, body_id),
          );
          chronicleMessage = `${body_name}: DISCOVERY — a derelict freight hub still pings. Free city + collector — your logistics just widened.`;
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

    // Step 2: persistent portal_to_sun warp. Bodies with a revealed
    // portal keep warping every ship that arrives, forever. Cheap to
    // run unconditionally — most games have at most one portal.
    const portalBodies = (await this.env.DB
      .prepare(
        `SELECT id FROM game_bodies
          WHERE game_id = ?
            AND secret_kind = 'portal_to_sun'
            AND secret_revealed = 1`,
      )
      .bind(gameId)
      .all()).results ?? [];

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
      // Warp each to a low Sol orbit (rp=18, ra=20).
      const warpStmts = stuck.map(sh =>
        this.env.DB
          .prepare(
            `UPDATE game_ships
                SET parent_body_id = ?,
                    orbit_rp = 18, orbit_ra = 20, orbit_omega = 0,
                    orbit_m0 = 0, orbit_epoch = ?, orbit_direction = 1
              WHERE id = ?`,
          )
          .bind(SOL_BODY_ID, tick, sh.id),
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
      // Persist the fall of the wonder BEFORE wiping the columns — the
      // websocket broadcast below is transient; this is the record.
      // acc is UNSCALED on both collapse paths (the ratio-scaling else
      // only runs on survivable damage), so the accumulator total IS the
      // full progress lost — adding damageTaken again double-counted it
      // (QA: a 500-progress sphere killed by 600 damage reported 1100).
      const lostProgress = acc.fuel + acc.ore + acc.credits + acc.science;
      await dysonChronicle('dyson_collapsed', 'dyc', {
        reason: collapseReason,
        progress_lost: Math.round(lostProgress),
        max_hp: Math.round(maxHp),
      });
      await this.env.DB
        .prepare(
          `UPDATE games SET
              dyson_controller_faction_id = NULL,
              dyson_foundation_settlement_id = NULL,
              dyson_started_at_tick = NULL,
              dyson_acc_fuel = 0, dyson_acc_ore = 0,
              dyson_acc_credits = 0, dyson_acc_science = 0,
              dyson_target_fuel = 0, dyson_target_ore = 0,
              dyson_target_credits = 0, dyson_target_science = 0,
              dyson_hp = 0, dyson_max_hp = 0,
              dyson_station_last_hp = NULL
            WHERE id = ?`,
        )
        .bind(gameId)
        .run();
      this.broadcast({ type: 'dyson_collapsed', tick, reason: collapseReason });
      return;
    }

    // 3: delivery. Count parked freighters at Sol owned by ctrl.
    // PARKED means parked: parent_body_id is a stale snapshot for the
    // whole duration of a transit (the departure pass leaves it on the
    // origin body so the canvas can animate the arc), so a freighter
    // that undocked 50 ticks ago still read as "at Sol" and kept
    // pumping (QA). Exclude anything with a live transfer node — the
    // design intent is that feeding the sphere TIES THE SHIP UP, and
    // the world-menu supply readout already counts it this way.
    const freighters = (await this.env.DB
      .prepare(
        `SELECT id FROM game_ships s
            WHERE s.game_id = ?
              AND s.owner_faction_id = ?
              AND s.ship_class = 'freighter'
              AND s.status = 'active'
              AND s.parent_body_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM game_ship_nodes n
                 WHERE n.ship_id = s.id AND n.status IN ('committed', 'in_transit')
              )`,
      )
      .bind(gameId, ctrl, `${gameId}:sol`)
      .all()).results ?? [];
    const n = freighters.length;
    if (n === 0) {
      // Just refresh hp from accumulated + persist station-HP snapshot
      // for next tick's damage delta.
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
      return;
    }

    // Get controller's pool.
    const faction = await this.env.DB
      .prepare('SELECT fuel, metal, gold, science FROM game_factions WHERE id = ?')
      .bind(ctrl)
      .first();
    if (!faction) return;

    const PER = { fuel: 5, ore: 10, credits: 10, science: 5 };
    const want = {
      fuel:    PER.fuel    * n,
      ore:     PER.ore     * n,
      credits: PER.credits * n,
      science: PER.science * n,
    };
    // Server uses 'metal' / 'gold' column names for ore / credits.
    const move = {
      fuel:    Math.max(0, Math.min(want.fuel,    faction.fuel    ?? 0, target.fuel    - acc.fuel)),
      ore:     Math.max(0, Math.min(want.ore,     faction.metal   ?? 0, target.ore     - acc.ore)),
      credits: Math.max(0, Math.min(want.credits, faction.gold    ?? 0, target.credits - acc.credits)),
      science: Math.max(0, Math.min(want.science, faction.science ?? 0, target.science - acc.science)),
    };
    const contribution = move.fuel + move.ore + move.credits + move.science;
    if (contribution === 0) {
      // No pool / no remaining target — still persist the accumulator
      // (damage may have scaled it down) + station-HP snapshot.
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
      return;
    }

    const hpBefore = hp;
    acc.fuel    += move.fuel;
    acc.ore     += move.ore;
    acc.credits += move.credits;
    acc.science += move.science;
    hp = Math.min(maxHp, acc.fuel + acc.ore + acc.credits + acc.science);

    // Construction milestones — one public beat per quarter crossed
    // (25/50/75%). Completion itself is the 'victory' chronicle from
    // checkVictory, so 100% isn't duplicated here. If damage knocks
    // progress back below a line, re-crossing it re-announces — that's
    // the drama working as intended (tick-scoped ids keep it deduped).
    if (maxHp > 0) {
      for (const pct of [25, 50, 75]) {
        const line = (maxHp * pct) / 100;
        if (hpBefore < line && hp >= line) {
          await dysonChronicle('dyson_milestone', `dym${pct}`, {
            pct,
            hp: Math.round(hp),
            max_hp: Math.round(maxHp),
          });
        }
      }
    }

    await this.env.DB.batch([
      this.env.DB
        .prepare(
          `UPDATE games SET
              dyson_acc_fuel = ?, dyson_acc_ore = ?,
              dyson_acc_credits = ?, dyson_acc_science = ?,
              dyson_hp = ?,
              dyson_station_last_hp = ? WHERE id = ?`,
        )
        .bind(acc.fuel, acc.ore, acc.credits, acc.science, hp, stationHpForNextTick, gameId),
      this.env.DB
        .prepare(
          `UPDATE game_factions SET
              fuel = fuel - ?, metal = metal - ?,
              gold = gold - ?, science = science - ?
            WHERE id = ?`,
        )
        .bind(move.fuel, move.ore, move.credits, move.science, ctrl),
    ]);
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
