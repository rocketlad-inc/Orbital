import { resolveSenate, getActiveSliders } from './senate.js';
import { recomputeBodyOwnership } from './factions.js';

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
      // (TBM was on at some point, or the column got cleared). Set it
      // to "now" so the tick can fire immediately rather than waiting
      // indefinitely. Skip for TBM games — those are intentionally paused.
      if (game.next_tick_at == null && game.turn_based_enabled !== 1) {
        const interval = game.tick_interval_ms ?? 60_000;
        const nextAt = Date.now() + interval;
        await this.env.DB
          .prepare('UPDATE games SET next_tick_at = ? WHERE id = ?')
          .bind(nextAt, started.gameId).run();
        try { await this.state.storage.setAlarm(nextAt); } catch {}
        return new Response(null, { status: 204 });
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
        await this.alarm();
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
      for (let t = startTick + 1; t <= endTick; t++) {
        try { await this.resolveTick(gameIdParam, t); }
        catch (e) { console.error('resolveTick in batch failed', t, e); }
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
  async alarm() {
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
    if (scheduled - now > 1000) {
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
    //    orbit around the building body.
    const builds = (await this.env.DB
      .prepare(
        `SELECT id, body_id, faction_id, ship_class, completes_at_tick,
                icon_variant, ship_name
           FROM game_body_build_queue
          WHERE game_id = ?
            AND cancelled_at_tick IS NULL
            AND completes_at_tick <= ?`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    for (const b of builds) {
      const body = await this.env.DB
        .prepare('SELECT radius, mu FROM game_bodies WHERE id = ?')
        .bind(b.body_id)
        .first();
      if (!body) continue;

      const FUEL_MAX = { corvette: 80, frigate: 200, destroyer: 300, freighter: 400 };
      const HP       = { corvette: 40, frigate: 80,  destroyer: 200, freighter: 30 };
      const DMG      = { corvette: 5,  frigate: 10,  destroyer: 18,  freighter: 0 };
      const fuelMax = FUEL_MAX[b.ship_class] ?? 100;
      const hp = HP[b.ship_class] ?? 50;
      const dmg = DMG[b.ship_class] ?? 0;
      const rp = (body.radius || 4) + 4;
      const ra = rp; // circular orbit
      const shipId = `${gameId}:s${tick}_${b.id.slice(-6)}`;
      // Honor the player's custom name from BuildPanel if they queued
      // one; otherwise fall back to the legacy auto-name so older
      // queue rows (pre-0029 migration) still complete cleanly.
      const shipName = (typeof b.ship_name === 'string' && b.ship_name.trim().length > 0)
        ? b.ship_name.trim()
        : `${b.ship_class.charAt(0).toUpperCase()}${b.ship_class.slice(1)} T${tick}`;

      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `INSERT INTO game_ships
              (id, game_id, owner_faction_id, name, ship_class,
               parent_body_id, orbit_rp, orbit_ra, orbit_omega,
               orbit_m0, orbit_epoch, orbit_direction,
               fuel, fuel_max, status, built_at_tick,
               hp, hp_max, damage_per_tick, icon_variant)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          )
          .bind(shipId, gameId, b.faction_id, shipName, b.ship_class,
                b.body_id, rp, ra, tick, fuelMax, fuelMax, tick,
                hp, hp, dmg, b.icon_variant ?? null),
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
      const rp = (target.radius || 4) + 4;
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
          .prepare('SELECT ship_class, owner_faction_id FROM game_ships WHERE id = ? AND status = ?')
          .bind(n.ship_id, 'active')
          .first();
        if (ship && ship.ship_class === 'freighter') {
          // Only pickup if this freighter isn't already on a trade
          // route hauling cargo (avoid double-pickup with the
          // trade-route block).
          const onRouteWithCargo = await this.env.DB
            .prepare(
              `SELECT 1 AS x FROM game_trade_routes
                 WHERE ship_id = ?
                   AND (cargo_fuel + cargo_metal + cargo_gold + cargo_science) > 0
                 LIMIT 1`,
            )
            .bind(n.ship_id).first();
          if (!onRouteWithCargo) {
            const PICKUP_CAP = 500;  // matches CARGO_CAP further down
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
            // If we picked anything up, stash it in the trade_routes
            // row associated with this ship if one exists; otherwise
            // hand straight to the faction pool (the freighter is
            // doing manual logistics, no route to buffer cargo on).
            if (cf + cm + cg + csci > 0) {
              const route = await this.env.DB
                .prepare('SELECT id FROM game_trade_routes WHERE ship_id = ? LIMIT 1')
                .bind(n.ship_id).first();
              if (route) {
                await this.env.DB
                  .prepare(
                    `UPDATE game_trade_routes
                        SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                            cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ?
                      WHERE id = ?`,
                  )
                  .bind(cf, cm, cg, csci, route.id).run();
              } else {
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

    // Senate effects active this tick. Cached in a closure local so
    // every downstream consumer reads the same snapshot without
    // hammering D1 once per attacker. Falls through to slider defaults
    // (1.0 multipliers, 0% tariff) on any error.
    let senateSliders = {};
    try { senateSliders = await getActiveSliders(this.env, gameId, tick); }
    catch (e) { console.error('getActiveSliders failed', e); }
    const combatDamageMult = Number(senateSliders.combat_damage_multiplier ?? 1);

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
        if (r.status === 'paused') continue;
        const ship = await this.env.DB
          .prepare("SELECT id, owner_faction_id, parent_body_id, ship_class, status FROM game_ships WHERE id = ?")
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
          let cf = 0, cm = 0, cg = 0, csci = 0;
          for (const s of stocks) {
            const take = {
              f:  Math.min(CARGO_CAP - cf,   Number(s.stockpile_fuel    ?? 0)),
              m:  Math.min(CARGO_CAP - cm,   Number(s.stockpile_metal   ?? 0)),
              g:  Math.min(CARGO_CAP - cg,   Number(s.stockpile_gold    ?? 0)),
              sc: Math.min(CARGO_CAP - csci, Number(s.stockpile_science ?? 0)),
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
            if (cf >= CARGO_CAP && cm >= CARGO_CAP && cg >= CARGO_CAP && csci >= CARGO_CAP) break;
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
    const allShips = (await this.env.DB
      .prepare(
        `SELECT id, owner_faction_id, parent_body_id, hp, damage_per_tick,
                rank, combat_history, ship_class, name, last_combat_tick
           FROM game_ships
          WHERE game_id = ? AND status = 'active'`,
      )
      .bind(gameId)
      .all()).results ?? [];

    // Combat cadence — every N ticks per ship, matching the SP
    // constant AUTO_COMBAT_INTERVAL in src/game/combat.ts. Pulled into
    // a server constant rather than imported because the worker is a
    // separate Cloudflare bundle that doesn't share the React build
    // tree. Keep in sync if SP's interval changes.
    const AUTO_COMBAT_INTERVAL = 3;

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

    // Group by body, then check for multiple factions present.
    const byBody = new Map();
    for (const s of allShips) {
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
    // Ships that fired this tick — their last_combat_tick gets bumped
    // to `tick` in a post-loop UPDATE so the next-N-ticks cooldown
    // applies. Tracked here instead of inline so we can batch the writes.
    const firedShipIds = new Set();
    for (const [, ships] of byBody) {
      const factions = new Set(ships.map(s => s.owner_faction_id));
      if (factions.size < 2) continue;
      for (const attacker of ships) {
        if (!attacker.damage_per_tick || attacker.damage_per_tick <= 0) continue;
        // Cadence gate — only fire if AUTO_COMBAT_INTERVAL ticks have
        // passed since this ship's last volley. NULL last_combat_tick
        // (never fired) reads as -Infinity, so a fresh ship can fire
        // immediately. Matches the SP loop's lastCombatTick check in
        // src/game/combat.ts:134.
        const lastFired = attacker.last_combat_tick ?? -Infinity;
        if (tick - lastFired < AUTO_COMBAT_INTERVAL) continue;
        // Only target ships from factions we're at war with (no peace pact).
        const targets = ships.filter(t =>
          t.owner_faction_id !== attacker.owner_faction_id
          && !peace.has(pairKey(attacker.owner_faction_id, t.owner_faction_id)),
        );
        if (targets.length === 0) continue;
        // Veterancy: each rank on the attacker = +1% damage (mirrors
        // src/game/techs.ts RANK_PER_KILL_MUL). Stacks multiplicatively
        // with the faction-level Weapons tech (which is applied via the
        // hp_max / damage_per_tick already stamped on the ship row when
        // they were last upgraded — see lobby/upgrade endpoints).
        const rankMul = 1 + 0.01 * Math.max(0, attacker.rank ?? 0);
        const split = (attacker.damage_per_tick * rankMul * combatDamageMult) / targets.length;
        for (const t of targets) {
          addDamage(t.id, attacker.owner_faction_id, attacker.id, split);
        }
        firedShipIds.add(attacker.id);
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

    // 3.4 Settlement combat. Hostile ships orbiting the same body as a
    //     settlement chip away at its hp every tick. Peace pacts still
    //     suppress (same `peace` set as ship combat). Cities and stations
    //     can't fight back yet — that's a follow-up.
    const SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP = 4;
    // Pull settlement name too so chronicle entries can say "Triton City"
    // instead of the un-formatted "settlement_destroyed" the log was
    // showing previously.
    const livingSettlements = (await this.env.DB
      .prepare(
        `SELECT id, name, body_id, owner_faction_id, type, hp, hp_max
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];

    const destroyedSettlements = [];
    // settlementId -> faction id that landed the killing volley, by largest
    // ship-count contribution (proxy for damage since per-hostile damage
    // is flat). Used downstream for the chronicle payload's killer field.
    const settlementKillers = new Map();
    for (const s of livingSettlements) {
      const shipsHere = byBody.get(s.body_id) ?? [];
      const hostiles = shipsHere.filter(sh =>
        sh.owner_faction_id !== s.owner_faction_id
        && !peace.has(pairKey(sh.owner_faction_id, s.owner_faction_id))
        && (sh.damage_per_tick ?? 0) > 0,
      );
      if (hostiles.length === 0) continue;
      const incoming = hostiles.length * SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP;
      const newHp = Math.max(0, s.hp - incoming);
      if (newHp <= 0) {
        await this.env.DB
          .prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, last_combat_tick = ? WHERE id = ?')
          .bind(tick, tick, s.id)
          .run();
        destroyedSettlements.push(s);
        // Largest hostile-faction presence gets the kill credit. Tie:
        // first encountered wins (Map iteration order = insertion order).
        const byFaction = new Map();
        for (const h of hostiles) {
          byFaction.set(h.owner_faction_id, (byFaction.get(h.owner_faction_id) || 0) + 1);
        }
        let topFid = null, topN = -1;
        for (const [fid, n] of byFaction) {
          if (n > topN) { topFid = fid; topN = n; }
        }
        if (topFid) settlementKillers.set(s.id, topFid);
      } else {
        await this.env.DB
          .prepare('UPDATE game_settlements SET hp = ?, last_combat_tick = ? WHERE id = ?')
          .bind(newHp, tick, s.id)
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
    const REPAIR_CITY = 2;
    const REPAIR_STATION = 1;
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
                s.fuel, s.fuel_max, s.rank,
                b.owner_faction_id AS body_owner,
                (SELECT 1 FROM game_ship_nodes n
                  WHERE n.ship_id = s.id
                    AND n.game_id = ?1
                    AND n.status = 'in_transit'
                  LIMIT 1) AS in_transit
           FROM game_ships s
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
        `SELECT id, body_id, owner_faction_id, type
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
      let repairRate = 0;
      let refuelRate = ship.body_owner === ship.owner_faction_id ? REFUEL_BASE : 0;
      for (const st of localStations) {
        if (st.type === 'city') {
          repairRate += REPAIR_CITY;
        } else if (st.type === 'station') {
          repairRate += REPAIR_STATION;
          refuelRate += REFUEL_STATION;
        }
      }
      if (repairRate <= 0 && refuelRate <= 0) continue;
      // Rank-boosted HP cap so veteran hulls can heal into their
      // extra buffer. The +1% per rank matches client combat.ts +
      // src/game/techs.ts rankHpMul.
      const effectiveMaxHp = (ship.hp_max ?? 0) * (1 + 0.01 * Math.max(0, ship.rank ?? 0));
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

    // Yield multipliers — kept in sync with src/game/settlements.ts.
    const YIELD_MULT_PER_POP = 0.1;
    const FORGE_PER_LEVEL = 0.25;
    const MINT_PER_LEVEL  = 0.25;
    const LAB_PER_LEVEL   = 0.20;
    const TYPE_MUL_CITY    = { fuel: 1.0, metal: 1.2, gold: 1.0, science: 0.8 };
    const TYPE_MUL_STATION = { fuel: 1.1, metal: 0.8, gold: 1.0, science: 1.4 };
    const NO_COLLECTOR_POOL_FRACTION = 0.10;       // 10% to faction pool
    const NO_COLLECTOR_STOCK_FRACTION = 0.90;       // 90% to local stockpile

    // Aggregate per-faction pool deltas; apply per-settlement
    // stockpile deltas individually. Wrapped: yield distribution must
    // NEVER kill resolveTick (combat, dyson, victory all run after).
    try {
      const perFactionPool = new Map();
      for (const s of settlements) {
        const tm = s.type === 'city' ? TYPE_MUL_CITY : TYPE_MUL_STATION;
        const popMul = 1 + YIELD_MULT_PER_POP * Math.max(0, Number(s.population ?? 1) - 1);
        let bld = {};
        if (s.buildings_json) { try { bld = JSON.parse(s.buildings_json) ?? {}; } catch { bld = {}; } }
        const forgeMul = 1 + Number(bld.forge ?? 0) * FORGE_PER_LEVEL;
        const mintMul  = 1 + Number(bld.mint  ?? 0) * MINT_PER_LEVEL;
        const labMul   = 1 + Number(bld.lab   ?? 0) * LAB_PER_LEVEL;
        const yieldFull = {
          fuel:    Number(s.yield_fuel    ?? 0) * popMul * tm.fuel,
          metal:   Number(s.yield_metal   ?? 0) * popMul * tm.metal   * forgeMul,
          gold:    Number(s.yield_gold    ?? 0) * popMul * tm.gold    * mintMul,
          science: Number(s.yield_science ?? 0) * popMul * tm.science * labMul,
        };

        const toPoolFraction  = s.has_collector ? 1.0 : NO_COLLECTOR_POOL_FRACTION;
        const toStockFraction = s.has_collector ? 0.0 : NO_COLLECTOR_STOCK_FRACTION;

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
            await this.env.DB
              .prepare(
                `UPDATE game_settlements
                    SET stockpile_fuel    = stockpile_fuel    + ?,
                        stockpile_metal   = stockpile_metal   + ?,
                        stockpile_gold    = stockpile_gold    + ?,
                        stockpile_science = stockpile_science + ?
                  WHERE id = ?`,
              )
              .bind(sf, sm, sg, ss, s.id)
              .run();
          }
        }
      }

      // Apply pool deltas — one UPDATE per faction.
      for (const [fid, delta] of perFactionPool) {
        const fuelI    = Math.round(delta.fuel);
        const metalI   = Math.round(delta.metal);
        const goldI    = Math.round(delta.gold);
        const scienceI = Math.round(delta.science);
        if (fuelI + metalI + goldI + scienceI <= 0) continue;
        await this.env.DB
          .prepare(
            `UPDATE game_factions
                SET fuel = fuel + ?, metal = metal + ?, gold = gold + ?, science = science + ?
              WHERE id = ?`,
          )
          .bind(fuelI, metalI, goldI, scienceI, fid)
          .run();
      }
    } catch (e) {
      console.error('per-tick yield distribution failed (non-fatal)', e);
    }

    // Stamp last_combat_tick on every ship that fired this tick. Done
    // before the damage-application block so even ships that fired and
    // missed (all targets had peace pacts, etc — defensively, can't
    // happen given the loop structure but cheap insurance) get gated
    // correctly on subsequent ticks. Batched via D1.batch() so a body
    // with a dozen ships firing doesn't burn a dozen round-trips.
    if (firedShipIds.size > 0) {
      const stmt = this.env.DB.prepare(
        'UPDATE game_ships SET last_combat_tick = ? WHERE id = ?',
      );
      await this.env.DB.batch(
        Array.from(firedShipIds).map(id => stmt.bind(tick, id)),
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
      for (const [shipId, entry] of hpDeltas) {
        const cur = allShips.find(s => s.id === shipId);
        if (!cur) continue;
        const newHp = Math.max(0, cur.hp - entry.total);
        if (newHp <= 0) {
          await this.env.DB
            .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
            .bind(tick, shipId)
            .run();
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
          await this.env.DB
            .prepare('UPDATE game_ships SET hp = ? WHERE id = ?')
            .bind(newHp, shipId)
            .run();
        }
      }

      // Flush veteran awards — one UPDATE per killer ship. Read the
      // current rank + history from the live `allShips` snapshot we
      // already queried at the top of combat (cheaper than a re-SELECT).
      const KILL_HISTORY_CAP = 20;
      for (const [killerShipId, award] of veteranAwards) {
        const killer = allShips.find(s => s.id === killerShipId);
        if (!killer) continue;
        const newRank = (killer.rank ?? 0) + award.addedRank;
        // Parse the existing JSON history (or empty) and apply the new
        // records LRU-style. Malformed JSON resets the column rather
        // than crashing the tick.
        let history = [];
        if (killer.combat_history) {
          try {
            const parsed = JSON.parse(killer.combat_history);
            if (Array.isArray(parsed)) history = parsed;
          } catch {
            // Bad JSON — start fresh; logging would spam the console.
          }
        }
        history = [...history, ...award.newRecords].slice(-KILL_HISTORY_CAP);
        await this.env.DB
          .prepare('UPDATE game_ships SET rank = ?, combat_history = ? WHERE id = ?')
          .bind(newRank, JSON.stringify(history), killerShipId)
          .run();
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
        }
        this.broadcast({ type: 'ships_destroyed', tick, ship_ids: losses });
      }
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
   * Server mirror of src/game/dysonSphere.ts. Each tick:
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
                         180, 180, 10)`,
              )
              .bind(shipId, gameId, discoverer, `${body_name} Salvage`, body_id,
                    rp, ra, tick, tick),
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
          chronicleMessage = `${body_name}: DISCOVERY — a buried cache — +500 metal + 500 gold to your pool.`;
          break;
        }
        case 'ancient_databank': {
          // Pick a random tech track. tech ids match the client's
          // TechId union; we keep the list inline rather than import
          // it cross-runtime to avoid bundling the whole tech catalog.
          const TECH_TRACKS = ['weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors', 'flight'];
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
            JSON.stringify({ kind, body_name, message: chronicleMessage }),
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
    const maxHp = game.dyson_max_hp ?? 0;
    const target = {
      fuel: game.dyson_target_fuel ?? 0,
      ore: game.dyson_target_ore ?? 0,
      credits: game.dyson_target_credits ?? 0,
      science: game.dyson_target_science ?? 0,
    };

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

    let collapse = false;
    let collapseReason = '';
    let stationHpForNextTick = null;
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
    }

    if (collapse) {
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
    const freighters = (await this.env.DB
      .prepare(
        `SELECT id FROM game_ships
            WHERE game_id = ?
              AND owner_faction_id = ?
              AND ship_class = 'freighter'
              AND status = 'active'
              AND parent_body_id = 'sol'`,
      )
      .bind(gameId, ctrl)
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

    acc.fuel    += move.fuel;
    acc.ore     += move.ore;
    acc.credits += move.credits;
    acc.science += move.science;
    hp = Math.min(maxHp, acc.fuel + acc.ore + acc.credits + acc.science);

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
   *   ENGINEERING  dyson_sphere row hp >= max_hp (Phase B)
   *   MILITARY     every rival faction has zero non-destroyed
   *                settlements (cities and stations both count)
   *   SCIENCE      faction has every tech track at TECH_MAX_LEVEL
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

    // ----- MILITARY -----
    // For each candidate, count rival factions with at least one
    // non-destroyed settlement (city OR station). If none, candidate
    // wins. Single-faction games can't win by military.
    if (factions.length >= 2) {
      const settled = (await this.env.DB
        .prepare(
          `SELECT DISTINCT faction_id
             FROM game_settlements
            WHERE game_id = ? AND destroyed_at_tick IS NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];
      const factionsWithSettlements = new Set(settled.map(r => r.faction_id));
      for (const candidate of factions) {
        let anyRivalAlive = false;
        for (const f of factions) {
          if (f.id === candidate.id) continue;
          if (factionsWithSettlements.has(f.id)) { anyRivalAlive = true; break; }
        }
        if (!anyRivalAlive) {
          return {
            winnerFactionId: candidate.id,
            victoryType: 'military',
            detail: 'All rival settlements destroyed',
          };
        }
      }
    }

    // ----- SCIENCE -----
    // Every tech track at TECH_MAX_LEVEL. Pull all faction_techs
    // rows in one query and bucket per faction.
    const techRows = (await this.env.DB
      .prepare(`SELECT faction_id, tech_id, level FROM faction_techs WHERE game_id = ?`)
      .bind(gameId)
      .all()).results ?? [];
    const TECH_TRACKS = ['weapons', 'armor', 'propulsion', 'flight', 'construction', 'industry', 'sensors'];
    const TECH_MAX_LEVEL = 10;
    const byFaction = new Map();
    for (const r of techRows) {
      let m = byFaction.get(r.faction_id);
      if (!m) { m = new Map(); byFaction.set(r.faction_id, m); }
      m.set(r.tech_id, r.level);
    }
    for (const candidate of factions) {
      const levels = byFaction.get(candidate.id) ?? new Map();
      const maxedAll = TECH_TRACKS.every(t => (levels.get(t) ?? 0) >= TECH_MAX_LEVEL);
      if (maxedAll) {
        return {
          winnerFactionId: candidate.id,
          victoryType: 'science',
          detail: 'All tech tracks mastered',
        };
      }
    }

    return null;
  }
}
