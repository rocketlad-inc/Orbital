// Polls GET /api/games/:gameId/state and feeds the result into the existing
// GameContextProvider via its externalState prop. The map canvas keeps
// reading from useGameContext() as before; in multiplayer mode the data
// just comes from the server instead of mockGameState.
//
// Polling cadence is intentionally generous (1s). Tick events broadcast on
// the room WebSocket also trigger an immediate refetch so transitions
// (build completes, ship arrives, etc.) feel snappy without spamming GET.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';
import { GameContextProvider } from '../state/gameContext';
import { MultiplayerActionsProvider } from './MultiplayerActionsContext';
import {
  Body, Ship, Faction, GameState, OrbitElements, FactionResources, FactionTechStateBase,
  Settlement, ManeuverNode, TransferArc,
} from '../types';
import { planBezierTransfer } from '../physics/bezierTransfer';

// Shape of /api/games/:gid/state.
interface ServerState {
  game: {
    id: string;
    status: string;
    current_tick: number;
    tick_interval_ms: number;
    next_tick_at: number | null;
    started_at: number | null;
    completed_at?: number | null;
    map_seed: string;
    winner_faction_id?: string | null;
    victory_type?: string | null;
  };
  me: {
    faction_id: string;
    slot: number;
    name: string;
    color: string;
    capital_body_id: string | null;
    resources: { metal: number; fuel: number; gold: number; science: number };
    tech_levels?: Record<string, number>;
  };
  factions: Array<{
    id: string; slot: number; name: string; color: string; status: string;
    capital_body_id: string | null;
  }>;
  bodies: Array<{
    id: string;
    template_id: string;
    name: string;
    type: string;
    parent_body_id: string | null;
    radius: number;
    soi: number | null;
    mu: number;
    orbit_radius: number | null;
    orbit_period: number | null;
    angle0: number | null;
    color: string;
    yield_metal: number;
    yield_fuel: number;
    yield_gold: number;
    yield_science: number;
    owner_faction_id: string | null;
  }>;
  ships: Array<{
    id: string;
    name: string;
    ship_class: string;
    owner_faction_id: string;
    parent_body_id: string;
    orbit_rp: number;
    orbit_ra: number;
    orbit_omega: number;
    orbit_m0: number;
    orbit_epoch: number;
    orbit_direction: 1 | -1;
    fuel: number;
    fuel_max: number;
    hp?: number;
    hp_max?: number;
    damage_per_tick?: number;
    status: string;
  }>;
  settlements?: Array<{
    id: string;
    body_id: string;
    owner_faction_id: string;
    type: 'city' | 'station';
    name: string;
    hp: number;
    hp_max: number;
    population: number;
    surface_angle: number | null;
    orbit_rp: number | null;
    orbit_ra: number | null;
    orbit_omega: number | null;
    orbit_m0: number | null;
    orbit_epoch: number | null;
    stockpile_metal: number;
    stockpile_fuel: number;
    stockpile_gold: number;
    stockpile_science: number;
    created_at_tick: number;
    last_growth_tick: number | null;
    last_harvest_tick: number | null;
  }>;
  nodes?: Array<{
    id: string;
    ship_id: string;
    sequence: number;
    anchor_kind: string;
    anchor_body_id: string | null;
    target_body_id: string | null;
    scheduled_t: number;
    arrival_at_tick: number | null;
    dv_prograde: number;
    dv_normal: number;
    dv_radial: number;
    fuel_cost: number;
    status: 'planned' | 'committed' | 'in_transit' | 'executed';
    committed_at_tick: number | null;
    departure_body_id: string | null;
  }>;
  events?: Array<{
    id: string;
    tick_number: number;
    kind: string;
    actor_faction_id: string | null;
    target_faction_id: string | null;
    body_id: string | null;
    ship_id: string | null;
    payload: string;
    created_at_ms: number;
  }>;
  /** In-flight ship builds for the caller's faction. The tick alarm
   *  spawns the ship into `ships` when completes_at_tick is reached;
   *  this list shows the BuildPanel's "BUILDING" strip in the meantime. */
  build_queue?: Array<{
    id: string;
    body_id: string;
    ship_class: string;
    queued_at_tick: number;
    completes_at_tick: number;
  }>;
}

// Map server body.type strings to client Body.type union.
function mapBodyType(t: string): Body['type'] {
  if (t === 'gas-giant') return 'gas_giant';
  if (t === 'ice-giant') return 'ice_giant';
  return (t as Body['type']);
}

/**
 * Server-side body IDs are namespaced per game as "<gameId>:<localId>"
 * (e.g. "Reemucleoytj:sol", "Reemucleoytj:jupiter"). The rest of the
 * client codebase compares body IDs against the unprefixed literals
 * 'sol', 'jupiter', etc. — most notably in physics/bezierTransfer.ts
 * where the whole intra/inter-system planner branches on
 * depParent === 'sol'. When the gameId prefix is left intact every
 * branch falls through and planBezierTransfer returns null, which is
 * why destination clicks in multiplayer silently did nothing.
 *
 * Strip the prefix once at the deserialization boundary so every
 * downstream consumer sees the same simple IDs as in single-player.
 */
function stripGameId(id: string | null | undefined): string | undefined {
  if (id == null) return undefined;
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
}

function bodyToClient(b: ServerState['bodies'][number]): Body {
  const localId = stripGameId(b.id) ?? b.id;
  return {
    id: localId,
    name: b.name,
    type: mapBodyType(b.type),
    mu: b.mu || undefined,
    parent: stripGameId(b.parent_body_id),
    orbitRadius: b.orbit_radius ?? 0,
    orbitPeriod: b.orbit_period ?? 0,
    angle0: b.angle0 ?? 0,
    radius: b.radius,
    soi: b.soi ?? Infinity,
    color: b.color,
    resources: {
      metal: b.yield_metal,
      fuel: b.yield_fuel,
      gold: b.yield_gold,
      science: b.yield_science,
    },
    ownedBy: b.owner_faction_id ?? undefined,
  };
}

function shipToClient(s: ServerState['ships'][number], muOfParent: number): Ship {
  // Period from Kepler's 3rd law: T = 2π √(a³ / μ)
  const a = (s.orbit_rp + s.orbit_ra) / 2;
  const period = muOfParent > 0
    ? 2 * Math.PI * Math.sqrt((a * a * a) / muOfParent)
    : 0;
  const orbit: OrbitElements = {
    rp: s.orbit_rp,
    ra: s.orbit_ra,
    omega: s.orbit_omega,
    M0: s.orbit_m0,
    epoch: s.orbit_epoch,
    direction: s.orbit_direction,
    period,
    parentBodyId: stripGameId(s.parent_body_id) ?? s.parent_body_id,
  };
  return {
    id: s.id,
    name: s.name,
    class: translateShipClass(s.ship_class),
    ownedBy: s.owner_faction_id,
    fuel: s.fuel,
    hp: s.hp,
    orbit,
    orders: [],
  };
}

// Server-to-client ship-class translation. The worker uses an older
// naming scheme ('cargo' for haulers, etc.); the client's class system
// only knows corvette / frigate / destroyer / freighter. Map unknown
// or legacy names onto the closest client class so renderers and panels
// (which all call getShipClass) don't crash the React tree.
function translateShipClass(serverClass: string): Ship['class'] {
  switch (serverClass) {
    case 'corvette':
    case 'frigate':
    case 'destroyer':
    case 'freighter':
      return serverClass;
    case 'cargo':
    case 'hauler':
      return 'freighter';
    default:
      return 'frigate';
  }
}

function settlementToClient(
  s: NonNullable<ServerState['settlements']>[number],
  parentBodyMu: number,
): Settlement {
  // Station: rebuild a circular orbit Kepler element set so the renderer
  // can draw it. City: keep surfaceAngle. Stockpile renames metal→ore,
  // gold→credits to match client conventions.
  const isStation = s.type === 'station';
  const localBodyId = stripGameId(s.body_id) ?? s.body_id;
  let orbit: OrbitElements | undefined;
  if (isStation && s.orbit_rp != null) {
    const rp = s.orbit_rp;
    const ra = s.orbit_ra ?? rp;
    const a = (rp + ra) / 2;
    const period = parentBodyMu > 0
      ? 2 * Math.PI * Math.sqrt((a * a * a) / parentBodyMu)
      : 0;
    orbit = {
      rp, ra,
      omega: s.orbit_omega ?? 0,
      M0: s.orbit_m0 ?? 0,
      epoch: s.orbit_epoch ?? 0,
      direction: 1,
      period,
      parentBodyId: localBodyId,
    };
  }
  return {
    id: s.id,
    type: s.type,
    name: s.name,
    bodyId: localBodyId,
    ownedBy: s.owner_faction_id,
    hp: s.hp,
    maxHp: s.hp_max,
    population: s.population,
    lastGrowthTick: s.last_growth_tick ?? s.created_at_tick,
    surfaceAngle: s.surface_angle ?? undefined,
    orbit,
    stockpile: {
      fuel: s.stockpile_fuel,
      ore: s.stockpile_metal,        // server 'metal' -> client 'ore'
      credits: s.stockpile_gold,     // server 'gold'  -> client 'credits'
      science: s.stockpile_science,
    },
    lastHarvestTick: s.last_harvest_tick ?? s.created_at_tick,
  };
}

function nodeToClient(
  n: NonNullable<ServerState['nodes']>[number],
): ManeuverNode {
  // Server stores dv components separately; client's primary `deltav` is
  // the magnitude, with prograde/normal/radial mirroring server columns.
  const dv = Math.sqrt(n.dv_prograde * n.dv_prograde
                     + n.dv_normal   * n.dv_normal
                     + n.dv_radial   * n.dv_radial);
  // The client's ManeuverNode.status enum doesn't have 'in_transit' —
  // that's a server-internal state. From the client's POV the burn has
  // happened (the ship has a transfer arc); we keep the node marked
  // 'committed' so the existing UI continues to render it.
  const clientStatus: ManeuverNode['status'] =
    n.status === 'in_transit' ? 'committed' : n.status;
  return {
    id: n.id,
    shipId: n.ship_id,
    type: 'transfer',
    burnTime: n.scheduled_t,
    deltav: dv,
    prograde: n.dv_prograde,
    radial: n.dv_radial,
    normal: n.dv_normal,
    status: clientStatus,
    label: n.target_body_id ? `→ ${n.target_body_id}` : undefined,
  };
}

function serverToGameState(srv: ServerState, callerFactionId: string): GameState {
  const bodies = srv.bodies.map(bodyToClient);
  // muById is keyed on the stripped local body id (matching what
  // bodyToClient produces). Strip server-side references before lookup
  // so we don't pass mu=0 into Kepler's 3rd law and end up with NaN
  // periods.
  const muById = new Map(bodies.map(b => [b.id, b.mu ?? 0]));
  const muOf = (rawId: string | null | undefined) =>
    muById.get(stripGameId(rawId) ?? '') ?? 0;
  const ships = srv.ships.map(s => shipToClient(s, muOf(s.parent_body_id)));

  // Tag the caller's faction as the "player" so all the existing client
  // code that checks ownedBy === 'player' keeps working without rewrites.
  const PLAYER_TOKEN = 'player';
  for (const b of bodies) {
    if (b.ownedBy === callerFactionId) b.ownedBy = PLAYER_TOKEN;
  }
  for (const s of ships) {
    if (s.ownedBy === callerFactionId) s.ownedBy = PLAYER_TOKEN;
  }

  const factions: Faction[] = srv.factions.map(f => ({
    id: f.id === callerFactionId ? PLAYER_TOKEN : f.id,
    name: f.name,
    color: f.color,
    isPlayer: f.id === callerFactionId,
  }));

  const playerRes: FactionResources = {
    fuel: srv.me.resources.fuel,
    ore: srv.me.resources.metal,         // server's 'metal' is our 'ore'
    credits: srv.me.resources.gold,      // server's 'gold' is our 'credits'
    science: srv.me.resources.science,
  };

  // Carry the server's authoritative tech levels into the existing
  // client GameState shape so TechPanel keeps reading from the same
  // place in single-player and multiplayer.
  const playerTech: FactionTechStateBase = {
    levels: srv.me.tech_levels ?? {},
    researching: null,
    progress: 0,
  };

  const settlements: Settlement[] = (srv.settlements ?? []).map(s => {
    const settlement = settlementToClient(s, muOf(s.body_id));
    if (settlement.ownedBy === callerFactionId) settlement.ownedBy = PLAYER_TOKEN;
    return settlement;
  });

  const orders: ManeuverNode[] = (srv.nodes ?? []).map(nodeToClient);

  // Attach each caller's node to its ship.orders so per-ship UIs find them.
  if (orders.length > 0) {
    const byShip = new Map<string, ManeuverNode[]>();
    for (const o of orders) {
      if (!byShip.has(o.shipId)) byShip.set(o.shipId, []);
      byShip.get(o.shipId)!.push(o);
    }
    for (const s of ships) {
      const list = byShip.get(s.id);
      if (list) s.orders = list;
    }
  }

  // Reconstruct Bezier transfer arcs from in_transit / committed nodes so
  // the canvas can animate ships along their curves between burn and
  // arrival, and draw dashed preview arcs for committed-but-not-yet-fired
  // departures. Without this, server-driven ships sit at the departure
  // body for the whole Hohmann travel time and then teleport.
  const shipById = new Map(ships.map(s => [s.id, s]));
  for (const srvNode of (srv.nodes ?? [])) {
    if (!srvNode.target_body_id) continue;
    if (srvNode.status !== 'committed' && srvNode.status !== 'in_transit') continue;
    const ship = shipById.get(srvNode.ship_id);
    if (!ship) continue;
    // planBezierTransfer adds a +5-tick launch buffer to currentTick;
    // pass scheduled_t - 5 so the resulting arc.departureTime matches.
    const pseudoNow = srvNode.scheduled_t - 5;
    const targetLocalId = stripGameId(srvNode.target_body_id) ?? srvNode.target_body_id;
    const arc: TransferArc | null = planBezierTransfer(
      ship.orbit, targetLocalId, pseudoNow, bodies, 1.0,
    );
    if (!arc) continue;
    // For an in_transit node, the server's authoritative arrival tick is
    // arrival_at_tick — override the Hohmann-computed one so the canvas
    // doesn't disagree with the server about when arrival fires.
    if (srvNode.status === 'in_transit' && srvNode.arrival_at_tick != null) {
      arc.arrivalTime = srvNode.arrival_at_tick;
    }
    if (srvNode.status === 'in_transit') {
      ship.transfer = arc;
    } else {
      ship.pendingTransfer = arc;
    }
  }

  // Server-side chronicle entries -> human-readable combat log.
  //
  // Payloads now carry pre-resolved faction names (owner_faction_name,
  // killer_faction_name) so we don't need to join against the factions
  // map for every render. The factionNameById fallback covers older
  // chronicle rows written before the server-side enrichment landed.
  const factionNameById = new Map(srv.factions.map(f => [f.id, f.name]));
  const nameOfFaction = (id: string | null | undefined, fallback?: string): string => {
    if (fallback) return fallback;
    if (!id) return 'Unknown';
    return factionNameById.get(id) ?? 'Unknown';
  };
  const combatLog: string[] = (srv.events ?? [])
    .slice()
    .reverse()  // server returns newest first; we want chronological
    .map(ev => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(ev.payload || '{}'); } catch { /* ignore */ }
      const t = `T+${ev.tick_number}`;

      if (ev.kind === 'ship_destroyed') {
        const name = (parsed.ship_name as string) ?? 'Unknown';
        const cls = (parsed.ship_class as string) ?? 'ship';
        const where = (parsed.body_name as string) ?? 'space';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
        // "destroyed by Unknown" is uninformative — only attribute when
        // we actually have a killer id (the chronicle stored null for
        // pre-attribution rows).
        const tail = parsed.killer_faction_id ? ` by ${killer}` : '';
        return `${t}  ${owner}'s ${cls} ${name} destroyed at ${where}${tail}`;
      }

      if (ev.kind === 'settlement_destroyed') {
        const sName = (parsed.settlement_name as string) ?? null;
        const sType = (parsed.settlement_type as string) ?? 'settlement';
        const where = (parsed.body_name as string) ?? 'unknown body';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
        const tail = parsed.killer_faction_id ? ` by ${killer}` : '';
        const label = sName ? `${sType} ${sName}` : sType;
        return `${t}  ${owner}'s ${label} on ${where} destroyed${tail}`;
      }

      return `${t}  ${ev.kind}`;
    });

  // Server-side build queue → client BuildOrder[]. Drives the BuildPanel
  // "BUILDING" strip while the alarm grinds toward completes_at_tick.
  // Without this, optimistic local state survived ~1.5s until the next
  // /state poll wiped it, leaving players staring at deducted resources
  // and nothing in the queue.
  const buildOrders = (srv.build_queue ?? []).map(b => ({
    id: b.id,
    bodyId: stripGameId(b.body_id) ?? b.body_id,
    shipClass: b.ship_class as 'corvette' | 'frigate' | 'destroyer' | 'freighter',
    ownedBy: PLAYER_TOKEN,
    startTick: b.queued_at_tick,
    completeTick: b.completes_at_tick,
    // The server doesn't currently track per-order names — fall back to
    // a ship-class display label so the UI has something to render.
    shipName: b.ship_class.charAt(0).toUpperCase() + b.ship_class.slice(1),
  }));

  return {
    currentTick: srv.game.current_tick,
    bodies,
    ships,
    fleets: [],
    factions,
    settlements,
    orders,
    buildOrders,
    resources: { [PLAYER_TOKEN]: playerRes },
    factionTech: { [PLAYER_TOKEN]: playerTech },
    combatLog,
    lastHarvestTick: srv.game.current_tick,
  };
}

interface Props {
  gameId: string;
  children: React.ReactNode;
  /** Invoked when the server says the game no longer exists (404). The
   *  parent clears the stored room id and routes back to the lobby. */
  onGameMissing?: () => void;
}

const POLL_INTERVAL_MS = 1500;

interface GameMeta {
  status: string;
  winnerFactionId: string | null;
  winnerName: string | null;
  victoryType: string | null;
  myFactionId: string;
  /** Caller's capital body id (per-game id like "<gameId>:earth"). */
  capitalBodyId: string | null;
  factions: ServerState['factions'];
}

export function MultiplayerGameProvider({ gameId, children, onGameMissing }: Props) {
  const [state, setState] = useState<GameState | null>(null);
  const [meta, setMeta] = useState<GameMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set true when the server returns 404. Stops polling + offers an exit. */
  const [missing, setMissing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inflightRef = useRef(false);
  // Stable ref so the polling effect doesn't tear down each render.
  const onGameMissingRef = useRef(onGameMissing);
  useEffect(() => { onGameMissingRef.current = onGameMissing; }, [onGameMissing]);

  const fetchState = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await apiFetch<ServerState>(`/api/games/${gameId}/state`);
      if (res.ok) {
        const next = serverToGameState(res.data, res.data.me.faction_id);
        setState(next);
        const winnerName = res.data.game.winner_faction_id
          ? (res.data.factions.find(f => f.id === res.data.game.winner_faction_id)?.name ?? null)
          : null;
        setMeta({
          status: res.data.game.status,
          winnerFactionId: res.data.game.winner_faction_id ?? null,
          winnerName,
          victoryType: res.data.game.victory_type ?? null,
          myFactionId: res.data.me.faction_id,
          capitalBodyId: stripGameId(res.data.me.capital_body_id) ?? null,
          factions: res.data.factions,
        });
        setError(null);
      } else if (res.status === 404 || res.error?.code === 'not_found') {
        // Game no longer exists on the server (deleted, expired, or stale
        // room id in localStorage). Stop polling and surface a bounce-out.
        setMissing(true);
      } else if (res.error?.code !== 'no_backend') {
        setError(res.error?.message ?? 'failed to load game state');
      }
    } finally {
      inflightRef.current = false;
    }
  }, [gameId]);

  // Polling loop — halts when the game is missing so we don't spam 404s.
  useEffect(() => {
    if (missing) return;
    fetchState();
    const id = setInterval(fetchState, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchState, missing]);

  // Auto-exit on missing after a brief pause so the user sees the message.
  useEffect(() => {
    if (!missing) return;
    const t = setTimeout(() => { onGameMissingRef.current?.(); }, 1200);
    return () => clearTimeout(t);
  }, [missing]);

  // Room WS: refetch on tick / completion events. Skipped if missing.
  useEffect(() => {
    if (missing) return;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/rooms/${gameId}/ws`);
    wsRef.current = ws;
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'tick' || msg?.type === 'game_completed') fetchState();
      } catch { /* ignore non-json */ }
    });
    return () => { try { ws.close(); } catch {} wsRef.current = null; };
  }, [gameId, fetchState, missing]);

  const status = useMemo(() => {
    if (missing) return 'missing';
    if (state) return 'ready';
    if (error) return 'error';
    return 'loading';
  }, [state, error, missing]);

  if (status !== 'ready' || !state) {
    return (
      <div className="mp-overlay">
        <div className="mp-card" style={{ textAlign: 'center' }}>
          {status === 'missing' ? (
            <>
              <div style={{ color: 'var(--mp-accent)', marginBottom: 8 }}>
                This game no longer exists
              </div>
              <div style={{ color: 'var(--mp-fg-dim)', fontSize: 11, marginBottom: 12 }}>
                The room may have been deleted or the game expired.
              </div>
              <button
                className="mp-submit"
                onClick={() => onGameMissingRef.current?.()}
                style={{ marginTop: 4 }}
              >
                Return to lobby
              </button>
            </>
          ) : status === 'error' ? (
            <>
              <div style={{ color: 'var(--mp-hostile)', marginBottom: 8 }}>Couldn't load game state</div>
              <div style={{ color: 'var(--mp-fg-dim)', fontSize: 11, marginBottom: 12 }}>{error}</div>
              {/* Safety net so the user is never permanently stuck. */}
              <button
                className="mp-submit"
                onClick={() => onGameMissingRef.current?.()}
                style={{ marginTop: 4 }}
              >
                Return to lobby
              </button>
            </>
          ) : (
            <div style={{ color: 'var(--mp-fg-dim)' }}>Loading game…</div>
          )}
        </div>
      </div>
    );
  }

  const gameOver = meta?.status === 'completed';
  const iWon = gameOver && meta?.winnerFactionId === meta?.myFactionId;

  // Pass caller's capital body id so the canvas auto-pans there on
  // first load instead of staring at Sol.
  return (
    <GameContextProvider
      externalState={state}
      externallyControlled
      initialFocusBodyId={meta?.capitalBodyId ?? null}
    >
      <MultiplayerActionsProvider gameId={gameId}>
        {children}
        {gameOver && (
          <div
            className="mp-overlay"
            style={{
              background: 'rgba(5, 8, 12, 0.86)',
              zIndex: 6000,
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{
              fontFamily: 'Orbitron, system-ui, sans-serif',
              fontSize: 28,
              letterSpacing: '0.32em',
              color: iWon ? 'var(--mp-friendly)' : 'var(--mp-accent)',
              textShadow: iWon
                ? '0 0 24px rgba(78,205,196,0.4)'
                : '0 0 24px rgba(255,184,77,0.4)',
            }}>
              {iWon ? 'VICTORY' : 'GAME OVER'}
            </div>
            <div style={{
              fontFamily: 'var(--mp-mono)',
              fontSize: 13,
              color: 'var(--mp-fg)',
              letterSpacing: '0.12em',
              textAlign: 'center',
            }}>
              {meta?.winnerName ? (
                <>
                  <div style={{ color: 'var(--mp-accent)', marginBottom: 6 }}>
                    {meta.winnerName} {iWon ? '(you)' : ''} wins
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)' }}>
                    Victory type: {meta.victoryType ?? 'hegemony'}
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--mp-fg-dim)' }}>No winner declared</div>
              )}
            </div>
            <button
              className="mp-submit"
              style={{ width: 'auto', padding: '10px 24px', marginTop: 12 }}
              onClick={() => onGameMissingRef.current?.()}
            >
              Return to lobby
            </button>
          </div>
        )}
      </MultiplayerActionsProvider>
    </GameContextProvider>
  );
}
