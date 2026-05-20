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
      .prepare('SELECT status, current_tick, tick_interval_ms, turn_based_enabled FROM games WHERE id = ?')
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
    const nextTick = (game.current_tick ?? 0) + 1;

    // Games run indefinitely. Tick-countdown victory was removed; the
    // games table still carries a total_tick_target column for schema
    // compatibility (NOT NULL DEFAULT 42) but the alarm no longer reads
    // it, no endpoint serves it, and no client surface displays it.

    // ----- resolve scheduled events for [prev+1 .. nextTick] -----
    try {
      await this.resolveTick(gameId, nextTick);
    } catch (e) {
      console.error('resolveTick failed', e);
    }

    const interval = game.tick_interval_ms ?? 86_400_000;
    const nextAt = now + interval;

    await this.env.DB.batch([
      this.env.DB
        .prepare('UPDATE games SET current_tick = ?, next_tick_at = ? WHERE id = ?')
        .bind(nextTick, nextAt, gameId),
      this.env.DB
        .prepare("INSERT OR REPLACE INTO game_ticks (game_id, tick_number, status, scheduled_at, started_at, completed_at) VALUES (?, ?, 'completed', ?, ?, ?)")
        .bind(gameId, nextTick, now, now, now),
    ]);

    try { await this.state.storage.setAlarm(nextAt); } catch (e) {
      console.error('setAlarm (reschedule) failed', e);
    }

    this.broadcast({ type: 'tick', tick: nextTick, next_tick_at: nextAt });
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
      }
    } catch (e) {
      console.error('settlement-building completion pass failed', e);
    }

    // 1. Build completions. Each row spawns one ship in a small circular
    //    orbit around the building body.
    const builds = (await this.env.DB
      .prepare(
        `SELECT id, body_id, faction_id, ship_class, completes_at_tick
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
      const shipName = `${b.ship_class.charAt(0).toUpperCase()}${b.ship_class.slice(1)} T${tick}`;

      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `INSERT INTO game_ships
              (id, game_id, owner_faction_id, name, ship_class,
               parent_body_id, orbit_rp, orbit_ra, orbit_omega,
               orbit_m0, orbit_epoch, orbit_direction,
               fuel, fuel_max, status, built_at_tick,
               hp, hp_max, damage_per_tick)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ?, ?, 'active', ?, ?, ?, ?)`,
          )
          .bind(shipId, gameId, b.faction_id, shipName, b.ship_class,
                b.body_id, rp, ra, tick, fuelMax, fuelMax, tick,
                hp, hp, dmg),
        this.env.DB
          .prepare('DELETE FROM game_body_build_queue WHERE id = ?')
          .bind(b.id),
      ]);
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
    }

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
      const CARGO_CAP = 50;
      const LEG_TICKS = 60;
      const routes = (await this.env.DB
        .prepare(
          `SELECT id, owner_faction_id, ship_id, origin_body_id, dest_body_id, status,
                  cargo_fuel, cargo_metal, cargo_gold, cargo_science
             FROM game_trade_routes
            WHERE game_id = ? AND cancelled_at_tick IS NULL`,
        )
        .bind(gameId)
        .all()).results ?? [];

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
          // Insert a committed node toward targetBodyId. 2a will flip it
          // to in_transit next tick; 2b will arrive it LEG_TICKS later.
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
            .bind(nodeId, gameId, r.ship_id, seq, targetBodyId, tick, tick + LEG_TICKS, tick)
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

        if (here === r.dest_body_id && cargoTotal > 0) {
          // DELIVERY: dump cargo to faction pool, head home.
          await this.env.DB.batch([
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
          ]);
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
    const allShips = (await this.env.DB
      .prepare(
        `SELECT id, owner_faction_id, parent_body_id, hp, damage_per_tick
           FROM game_ships
          WHERE game_id = ? AND status = 'active'`,
      )
      .bind(gameId)
      .all()).results ?? [];

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

    // hpDeltas: shipId -> { total: number, byFaction: Map<factionId, number> }
    // Per-faction split is needed so chronicle entries can credit the kill
    // ("destroyed BY <faction>") — previously we only knew the victim.
    const hpDeltas = new Map();
    const addDamage = (targetId, attackerFid, amount) => {
      let entry = hpDeltas.get(targetId);
      if (!entry) {
        entry = { total: 0, byFaction: new Map() };
        hpDeltas.set(targetId, entry);
      }
      entry.total += amount;
      entry.byFaction.set(attackerFid, (entry.byFaction.get(attackerFid) || 0) + amount);
    };
    for (const [, ships] of byBody) {
      const factions = new Set(ships.map(s => s.owner_faction_id));
      if (factions.size < 2) continue;
      for (const attacker of ships) {
        if (!attacker.damage_per_tick || attacker.damage_per_tick <= 0) continue;
        // Only target ships from factions we're at war with (no peace pact).
        const targets = ships.filter(t =>
          t.owner_faction_id !== attacker.owner_faction_id
          && !peace.has(pairKey(attacker.owner_faction_id, t.owner_faction_id)),
        );
        if (targets.length === 0) continue;
        const split = attacker.damage_per_tick / targets.length;
        for (const t of targets) {
          addDamage(t.id, attacker.owner_faction_id, split);
        }
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

    // 3.5 Yield harvest. Every SETTLEMENT_HARVEST_INTERVAL=10 ticks, each
    //     settlement converts its body's yield into stockpile, scaled by
    //     population and the settlement type's bias (cities -> metal,
    //     stations -> science).
    //     Also: every POP_GROWTH_INTERVAL=20 ticks, settlement population
    //     grows by 1 (capped at POP_MAX). Growing populations harvest more
    //     because the popMult above scales with population.
    const HARVEST_INTERVAL = 10;
    const POP_GROWTH_INTERVAL = 20;
    const POP_MAX = 10;
    const settlements = (await this.env.DB
      .prepare(
        `SELECT s.id, s.body_id, s.type, s.population, s.last_harvest_tick, s.last_growth_tick,
                b.yield_metal, b.yield_fuel, b.yield_gold, b.yield_science
           FROM game_settlements s
           JOIN game_bodies b ON b.id = s.body_id
          WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];

    // Population growth pass — independent of harvest cadence.
    for (const s of settlements) {
      const lastGrowth = s.last_growth_tick ?? 0;
      if (tick - lastGrowth < POP_GROWTH_INTERVAL) continue;
      if ((s.population ?? 1) >= POP_MAX) {
        // Even at cap, update last_growth_tick so we don't burn cycles.
        await this.env.DB
          .prepare('UPDATE game_settlements SET last_growth_tick = ? WHERE id = ?')
          .bind(tick, s.id).run();
        continue;
      }
      await this.env.DB
        .prepare('UPDATE game_settlements SET population = population + 1, last_growth_tick = ? WHERE id = ?')
        .bind(tick, s.id).run();
      s.population = (s.population ?? 1) + 1;  // keep local copy in sync for harvest pass below
    }

    for (const s of settlements) {
      const last = s.last_harvest_tick ?? 0;
      if (tick - last < HARVEST_INTERVAL) continue;
      const popMult = 1 + 0.1 * Math.max(0, (s.population ?? 1) - 1);
      const typeMult = s.type === 'city'
        ? { metal: 1.2, fuel: 1.0, gold: 1.0, science: 0.8 }
        : { metal: 0.8, fuel: 1.1, gold: 1.0, science: 1.4 };
      const addMetal   = Math.round(s.yield_metal   * popMult * typeMult.metal);
      const addFuel    = Math.round(s.yield_fuel    * popMult * typeMult.fuel);
      const addGold    = Math.round(s.yield_gold    * popMult * typeMult.gold);
      const addScience = Math.round(s.yield_science * popMult * typeMult.science);
      await this.env.DB
        .prepare(
          `UPDATE game_settlements
              SET stockpile_metal   = stockpile_metal   + ?,
                  stockpile_fuel    = stockpile_fuel    + ?,
                  stockpile_gold    = stockpile_gold    + ?,
                  stockpile_science = stockpile_science + ?,
                  last_harvest_tick = ?
            WHERE id = ?`,
        )
        .bind(addMetal, addFuel, addGold, addScience, tick, s.id)
        .run();
    }

    // 3.6 Stockpile offload. Settlements deposit directly into the
    //     owner's faction pool every tick — the freighter-ferry mechanic
    //     was scrapped because players had cities producing but no idea
    //     why their CR wasn't moving (gold piled up on the city forever
    //     waiting for a freighter that never came). Now every non-empty
    //     stockpile sweeps to its faction's pool unconditionally. Mirrors
    //     the client SP behavior in src/game/settlements.ts.
    const offloads = (await this.env.DB
      .prepare(
        `SELECT s.id AS sid, s.owner_faction_id AS fid,
                s.stockpile_metal AS m, s.stockpile_fuel AS f,
                s.stockpile_gold AS g, s.stockpile_science AS sci
           FROM game_settlements s
          WHERE s.game_id = ?
            AND s.destroyed_at_tick IS NULL
            AND (s.stockpile_metal + s.stockpile_fuel + s.stockpile_gold + s.stockpile_science) > 0`,
      )
      .bind(gameId)
      .all()).results ?? [];

    for (const o of offloads) {
      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `UPDATE game_factions
                SET metal = metal + ?, fuel = fuel + ?, gold = gold + ?, science = science + ?
              WHERE id = ?`,
          )
          .bind(o.m, o.f, o.g, o.sci, o.fid),
        this.env.DB
          .prepare(
            `UPDATE game_settlements
                SET stockpile_metal = 0, stockpile_fuel = 0,
                    stockpile_gold = 0, stockpile_science = 0
              WHERE id = ?`,
          )
          .bind(o.sid),
      ]);
    }

    if (hpDeltas.size > 0) {
      const losses = [];
      const lostShipRows = [];  // for chronicle entries
      const killerByShip = new Map(); // shipId -> faction id that landed the killing volley
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
        } else {
          await this.env.DB
            .prepare('UPDATE game_ships SET hp = ? WHERE id = ?')
            .bind(newHp, shipId)
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
  async tickDysonSphere(gameId, tick) {
    const game = await this.env.DB
      .prepare(
        `SELECT
            dyson_controller_faction_id, dyson_foundation_settlement_id,
            dyson_acc_fuel, dyson_acc_ore, dyson_acc_credits, dyson_acc_science,
            dyson_target_fuel, dyson_target_ore, dyson_target_credits, dyson_target_science,
            dyson_hp, dyson_max_hp
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
    if (!station || station.destroyed_at_tick != null) {
      collapse = true;
      collapseReason = 'foundation destroyed';
    } else {
      // Damage detection: dyson_hp tracks "accumulated total"; combat
      // shouldn't reduce that. We instead track damage at station-HP
      // delta from a private side channel. Simpler approach for now:
      // if station HP < (hp_max), the gap is the damage the sphere has
      // absorbed cumulatively. Since the sphere HP and station HP can
      // diverge wildly, we use a delta-based approach: track the
      // station's pre-tick HP via a per-tick read above, compare to
      // post-combat HP, and apply the delta to the sphere.
      //
      // The pre-tick HP isn't available here (we only see post-tick).
      // We approximate: any damage that reduced station HP this tick
      // will manifest as station.hp < its previous reading. We don't
      // have that history without an extra column. Cheap workaround:
      // route a separate "damage volley" hook through combat (Phase C).
      //
      // For now, just rebuild HP from accumulated each tick — the
      // sphere can't be damaged on the server side until the
      // damage-volley hook lands. The foundation destroying is the
      // primary loss vector.
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
              dyson_hp = 0, dyson_max_hp = 0
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
      // Just refresh hp from accumulated.
      await this.env.DB
        .prepare(`UPDATE games SET dyson_hp = ? WHERE id = ?`)
        .bind(hp, gameId)
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
      await this.env.DB
        .prepare(`UPDATE games SET dyson_hp = ? WHERE id = ?`)
        .bind(hp, gameId)
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
              dyson_hp = ? WHERE id = ?`,
        )
        .bind(acc.fuel, acc.ore, acc.credits, acc.science, hp, gameId),
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
