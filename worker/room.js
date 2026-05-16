// Room Durable Object. One instance per game room, keyed by room id.
// Uses the WebSocket Hibernation API so idle rooms cost nothing.
//
// State model (kept in DO storage so we survive eviction):
//   meta: { id, name, hostId, status, maxPlayers, createdAt }
//   members: Map<userId, { userId, displayName }>  -- everyone with a seat
//   settings: { total_tick_target, tick_interval_ms }  -- host-edited pre-start config
//   gameStarted: { gameId, total_tick_target, tick_interval_ms, started_at } | null
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
      if (Number.isInteger(body.total_tick_target)) settings.total_tick_target = body.total_tick_target;
      if (Number.isInteger(body.tick_interval_ms)) settings.tick_interval_ms = body.tick_interval_ms;
      if (metaChanged) await this.state.storage.put('meta', meta);
      await this.state.storage.put('settings', settings);
      this.broadcast({ type: 'settings', meta, settings });
      return Response.json(settings);
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
    const started = await this.state.storage.get('gameStarted');
    if (!started?.gameId) return;
    const gameId = started.gameId;

    const game = await this.env.DB
      .prepare('SELECT status, current_tick, total_tick_target, tick_interval_ms FROM games WHERE id = ?')
      .bind(gameId)
      .first();
    if (!game) return;
    if (game.status === 'completed' || game.status === 'abandoned') return;

    const now = Date.now();
    const nextTick = (game.current_tick ?? 0) + 1;

    if (nextTick >= game.total_tick_target) {
      // Compute winner — most owned bodies wins; tie-break by total
      // resource value (metal + fuel + gold + science).
      const scores = (await this.env.DB
        .prepare(
          `SELECT f.id, f.name,
                  (SELECT COUNT(*) FROM game_bodies b
                    WHERE b.game_id = f.game_id AND b.owner_faction_id = f.id) AS worlds,
                  (f.metal + f.fuel + f.gold + f.science) AS wealth
             FROM game_factions f
            WHERE f.game_id = ? AND f.status = 'active'
            ORDER BY worlds DESC, wealth DESC, f.slot ASC`,
        )
        .bind(gameId)
        .all()).results ?? [];

      const winner = scores[0] ?? null;
      const victoryType = scores.length > 1 && winner && winner.worlds > (scores[1].worlds ?? 0)
        ? 'hegemony'
        : 'last_standing';

      await this.env.DB
        .prepare(
          `UPDATE games
              SET status = 'completed', current_tick = ?, completed_at = ?,
                  next_tick_at = NULL, winner_faction_id = ?, victory_type = ?
            WHERE id = ?`,
        )
        .bind(nextTick, now, winner?.id ?? null, winner ? victoryType : 'abandoned', gameId)
        .run();

      if (winner) {
        try {
          const entryId = `c${nextTick}_victory_${Math.random().toString(36).slice(2, 6)}`;
          await this.env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, 'victory', ?, ?, 'public', ?)`,
            )
            .bind(entryId, gameId, nextTick, winner.id,
                  JSON.stringify({ victory_type: victoryType, worlds: winner.worlds, wealth: winner.wealth, scores }),
                  now)
            .run();
        } catch (e) { console.error('victory chronicle failed', e); }
      }

      this.broadcast({
        type: 'game_completed', tick: nextTick,
        winner_faction_id: winner?.id ?? null,
        victory_type: winner ? victoryType : 'abandoned',
      });
      return;
    }

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
    const SOL_MU = 6003; // matches client GRAVITATIONAL_PARAMS.SOL
    const departures = (await this.env.DB
      .prepare(
        `SELECT n.id, n.ship_id, n.target_body_id, n.scheduled_t,
                s.parent_body_id AS dep_body_id,
                dep.orbit_radius AS dep_r,
                arr.orbit_radius AS arr_r
           FROM game_ship_nodes n
           JOIN game_ships s ON s.id = n.ship_id
           JOIN game_bodies dep ON dep.id = s.parent_body_id
           JOIN game_bodies arr ON arr.id = n.target_body_id
          WHERE n.game_id = ?
            AND n.status = 'committed'
            AND n.scheduled_t <= ?
            AND n.target_body_id IS NOT NULL
          ORDER BY n.scheduled_t ASC`,
      )
      .bind(gameId, tick)
      .all()).results ?? [];

    for (const d of departures) {
      // Hohmann travel time t = π√(a³/μ), a = (r1+r2)/2.
      const r1 = d.dep_r || 0;
      const r2 = d.arr_r || 0;
      const a = (r1 + r2) / 2;
      const travelTime = a > 0 && SOL_MU > 0
        ? Math.PI * Math.sqrt((a * a * a) / SOL_MU)
        : 5;
      const arrivalAtTick = Math.max(tick + 1, Math.ceil(d.scheduled_t + travelTime));
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

    const hpDeltas = new Map(); // shipId -> total damage taken this tick
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
          hpDeltas.set(t.id, (hpDeltas.get(t.id) || 0) + split);
        }
      }
    }

    // 3.4 Settlement combat. Hostile ships orbiting the same body as a
    //     settlement chip away at its hp every tick. Peace pacts still
    //     suppress (same `peace` set as ship combat). Cities and stations
    //     can't fight back yet — that's a follow-up.
    const SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP = 4;
    const livingSettlements = (await this.env.DB
      .prepare(
        `SELECT id, body_id, owner_faction_id, type, hp, hp_max
           FROM game_settlements
          WHERE game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId)
      .all()).results ?? [];

    const destroyedSettlements = [];
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
      for (const s of destroyedSettlements) {
        const body = await this.env.DB
          .prepare('SELECT name FROM game_bodies WHERE id = ?')
          .bind(s.body_id).first();
        const id = `c${tick}_setl_${s.id.slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
        const payload = JSON.stringify({
          settlement_id: s.id, settlement_type: s.type,
          body_id: s.body_id, body_name: body?.name ?? '?',
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

    // 3.6 Stockpile offload. If a player's freighter is in orbit at a
    //     body where they own a settlement, sweep the settlement's stockpile
    //     into the owning faction's resources. Mirrors the client behavior.
    const offloads = (await this.env.DB
      .prepare(
        `SELECT DISTINCT s.id AS sid, s.owner_faction_id AS fid,
                s.stockpile_metal AS m, s.stockpile_fuel AS f,
                s.stockpile_gold AS g, s.stockpile_science AS sci
           FROM game_settlements s
           JOIN game_ships sh ON sh.parent_body_id = s.body_id
                              AND sh.owner_faction_id = s.owner_faction_id
                              AND sh.ship_class = 'freighter'
                              AND sh.status = 'active'
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
      for (const [shipId, dmg] of hpDeltas) {
        const cur = allShips.find(s => s.id === shipId);
        if (!cur) continue;
        const newHp = Math.max(0, cur.hp - dmg);
        if (newHp <= 0) {
          await this.env.DB
            .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
            .bind(tick, shipId)
            .run();
          losses.push(shipId);
          lostShipRows.push(cur);
        } else {
          await this.env.DB
            .prepare('UPDATE game_ships SET hp = ? WHERE id = ?')
            .bind(newHp, shipId)
            .run();
        }
      }

      // Persist chronicle entries for destroyed ships so the canvas can
      // show a combat log without relying on the transient WS broadcast.
      if (lostShipRows.length) {
        const now = Date.now();
        for (const lost of lostShipRows) {
          const ship = await this.env.DB
            .prepare('SELECT name, ship_class, parent_body_id FROM game_ships WHERE id = ?')
            .bind(lost.id).first();
          const body = ship?.parent_body_id
            ? await this.env.DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(ship.parent_body_id).first()
            : null;
          const entryId = `c${tick}_${lost.id.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
          const payload = JSON.stringify({
            ship_id: lost.id,
            ship_name: ship?.name ?? 'Unknown',
            ship_class: ship?.ship_class ?? 'unknown',
            body_id: ship?.parent_body_id ?? null,
            body_name: body?.name ?? 'unknown space',
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
  }
}
