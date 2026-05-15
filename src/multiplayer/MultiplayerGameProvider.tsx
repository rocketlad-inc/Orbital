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
} from '../types';

// Shape of /api/games/:gid/state.
interface ServerState {
  game: {
    id: string;
    status: string;
    current_tick: number;
    total_tick_target: number;
    tick_interval_ms: number;
    next_tick_at: number | null;
    started_at: number | null;
    map_seed: string;
  };
  me: {
    faction_id: string;
    slot: number;
    name: string;
    color: string;
    capital_body_id: string | null;
    resources: { metal: number; fuel: number; gold: number; science: number };
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
}

// Map server body.type strings to client Body.type union.
function mapBodyType(t: string): Body['type'] {
  if (t === 'gas-giant') return 'gas_giant';
  if (t === 'ice-giant') return 'ice_giant';
  return (t as Body['type']);
}

function bodyToClient(b: ServerState['bodies'][number]): Body {
  return {
    id: b.id,
    name: b.name,
    type: mapBodyType(b.type),
    mu: b.mu || undefined,
    parent: b.parent_body_id ?? undefined,
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
    parentBodyId: s.parent_body_id,
  };
  return {
    id: s.id,
    name: s.name,
    class: (s.ship_class as Ship['class']),
    ownedBy: s.owner_faction_id,
    fuel: s.fuel,
    hp: s.hp,
    orbit,
    orders: [],
  };
}

function serverToGameState(srv: ServerState, callerFactionId: string): GameState {
  const bodies = srv.bodies.map(bodyToClient);
  const muById = new Map(bodies.map(b => [b.id, b.mu ?? 0]));
  const ships = srv.ships.map(s => shipToClient(s, muById.get(s.parent_body_id) ?? 0));

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

  const emptyTech: FactionTechStateBase = { levels: {}, researching: null, progress: 0 };

  return {
    currentTick: srv.game.current_tick,
    bodies,
    ships,
    fleets: [],
    factions,
    settlements: [],
    orders: [],
    buildOrders: [],
    resources: { [PLAYER_TOKEN]: playerRes },
    factionTech: { [PLAYER_TOKEN]: emptyTech },
    combatLog: [],
    lastHarvestTick: srv.game.current_tick,
  };
}

interface Props {
  gameId: string;
  children: React.ReactNode;
  /**
   * Called when the server returns 404 — the game no longer exists.
   * The parent should clear the stored room id and route the user back
   * to the lobby. Without this, the client polls 404 forever.
   */
  onGameMissing?: () => void;
}

const POLL_INTERVAL_MS = 1500;

export function MultiplayerGameProvider({ gameId, children, onGameMissing }: Props) {
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server returns 404. Stops polling and shows the missing-game UI. */
  const [missing, setMissing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inflightRef = useRef(false);
  // Stable callback ref so the polling effect doesn't tear down every render.
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
        setError(null);
      } else if (res.status === 404) {
        // Game no longer exists on the server (deleted, expired, or
        // stored room id is stale). Stop everything and bounce out.
        setMissing(true);
      } else if (res.error?.code !== 'no_backend') {
        setError(res.error?.message ?? 'failed to load game state');
      }
    } finally {
      inflightRef.current = false;
    }
  }, [gameId]);

  // Polling loop — halts once the game is determined to be missing so we
  // don't spam 404s. The user is dropped back to the lobby via onGameMissing.
  useEffect(() => {
    if (missing) return;
    fetchState();
    const id = setInterval(fetchState, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchState, missing]);

  // Auto-exit when we know the game is gone. Defer one tick so the user
  // briefly sees the "this game no longer exists" message before bouncing.
  useEffect(() => {
    if (!missing) return;
    const timer = setTimeout(() => {
      onGameMissingRef.current?.();
    }, 1200);
    return () => clearTimeout(timer);
  }, [missing]);

  // Room WS: refetch immediately on tick / settlement events. Skipped when
  // the game is missing — no point connecting to a dead room.
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
              <div style={{ color: 'var(--mp-fg-dim)', fontSize: 11 }}>{error}</div>
            </>
          ) : (
            <div style={{ color: 'var(--mp-fg-dim)' }}>Loading game…</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <GameContextProvider externalState={state} externallyControlled>
      <MultiplayerActionsProvider gameId={gameId}>
        {children}
      </MultiplayerActionsProvider>
    </GameContextProvider>
  );
}
