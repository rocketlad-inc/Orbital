// Thin context exposing server action endpoints to the in-game UI.
//
// In single-player the context value is `null` and components fall back
// to the existing local mutations. In multiplayer, MultiplayerGameProvider
// wraps its children with a non-null context, and panels (ShipPanel,
// BuildPanel) post user intent to the server in addition to (or instead
// of) mutating local state.

import React, { createContext, useContext, useMemo } from 'react';
import { apiFetch } from './api';

export interface TransferIntent {
  shipId: string;
  targetBodyId: string;
  scheduledT: number;        // server tick when burn fires (== arc.departureTime)
  dvPrograde: number;
  dvNormal?: number;
  dvRadial?: number;
  fuelCost: number;
}

export interface BuildIntent {
  bodyId: string;
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  shipName?: string;
}

export interface SettlementIntent {
  bodyId: string;
  type: 'city' | 'station';
  name?: string;
}

export interface ResearchIntent {
  techId: string;
}

/** Result of a turn commit. Either the caller's vote was recorded
 *  (advanced=false) or every faction had voted and the server advanced
 *  the sim immediately (advanced=true). */
export interface TurnCommitResult {
  ok: boolean;
  ready?: number;
  needed?: number;
  turn_number?: number;
  advanced?: boolean;
  advanced_ticks?: number;
  new_tick?: number;
  new_turn_number?: number;
  error?: string;
}

/** Per-faction commit state for the current turn — used to render the
 *  "waiting on Mars / Belt / etc." HUD. */
export interface TurnStatus {
  turn_based_enabled: boolean;
  ticks_per_turn: number;
  current_tick: number;
  turn_number: number;
  me_committed: boolean;
  ready: number;
  needed: number;
  factions: Array<{ id: string; name: string; committed: boolean }>;
}

export interface MultiplayerActions {
  gameId: string;
  /** Post a committed maneuver node to the server. Resolves true on success. */
  transfer: (intent: TransferIntent) => Promise<boolean>;
  /** Queue a ship build. Resolves true on success. */
  build: (intent: BuildIntent) => Promise<boolean>;
  /** Deploy a city or station at a body. */
  deploySettlement: (intent: SettlementIntent) => Promise<boolean>;
  /** Spend science to advance a tech level. Server is authoritative on cost. */
  research: (intent: ResearchIntent) => Promise<boolean>;

  // --- Turn-Based Mode (MP) ---
  /** Host-only: enable/disable TBM and set ticks_per_turn for this game. */
  setTurnSettings: (enabled: boolean, ticksPerTurn: number) => Promise<boolean>;
  /** Submit caller's faction as ready for the current turn. If this commit
   *  fills the last slot, the server advances the sim by ticks_per_turn
   *  ticks before responding. */
  commitTurn: () => Promise<TurnCommitResult>;
  /** Poll the per-faction readiness for the current turn. */
  getTurnStatus: () => Promise<TurnStatus | null>;
}

const MultiplayerActionsContext = createContext<MultiplayerActions | null>(null);

export function MultiplayerActionsProvider({
  gameId, children,
}: { gameId: string; children: React.ReactNode }) {
  const value = useMemo<MultiplayerActions>(() => {
    // The client stores body IDs in the unprefixed form ('jupiter', 'sol')
    // after MultiplayerGameProvider strips the "<gameId>:" namespace at the
    // deserialization boundary. The server still expects the namespaced
    // form on every action endpoint, so re-attach the prefix on the way out.
    // Pass-through if the caller already gave us a fully-qualified id.
    const qualify = (id: string): string =>
      id.includes(':') ? id : `${gameId}:${id}`;

    return ({
    gameId,
    async transfer(intent) {
      const res = await apiFetch(`/api/games/${gameId}/ships/${encodeURIComponent(intent.shipId)}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          target_body_id: qualify(intent.targetBodyId),
          scheduled_t: intent.scheduledT,
          dv_prograde: intent.dvPrograde,
          dv_normal: intent.dvNormal ?? 0,
          dv_radial: intent.dvRadial ?? 0,
          fuel_cost: intent.fuelCost,
        }),
      });
      if (!res.ok) {
        // Surface to console for now; ShipPanel can show a toast later.
        console.warn('transfer failed', res.error);
      }
      return res.ok;
    },
    async build(intent) {
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(qualify(intent.bodyId))}/build`, {
        method: 'POST',
        body: JSON.stringify({
          ship_class: intent.shipClass,
          ship_name: intent.shipName,
        }),
      });
      if (!res.ok) {
        console.warn('build failed', res.error);
      }
      return res.ok;
    },
    async deploySettlement(intent) {
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(qualify(intent.bodyId))}/settlement`, {
        method: 'POST',
        body: JSON.stringify({ type: intent.type, name: intent.name }),
      });
      if (!res.ok) {
        console.warn('deploySettlement failed', res.error);
      }
      return res.ok;
    },
    async research(intent) {
      const res = await apiFetch(`/api/games/${gameId}/research`, {
        method: 'POST',
        body: JSON.stringify({ tech_id: intent.techId }),
      });
      if (!res.ok) {
        console.warn('research failed', res.error);
      }
      return res.ok;
    },
    async setTurnSettings(enabled, ticksPerTurn) {
      const res = await apiFetch(`/api/games/${gameId}/turn/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled, ticks_per_turn: ticksPerTurn }),
      });
      if (!res.ok) console.warn('setTurnSettings failed', res.error);
      return res.ok;
    },
    async commitTurn() {
      const res = await apiFetch<TurnCommitResult>(`/api/games/${gameId}/turn/commit`, {
        method: 'POST',
      });
      if (!res.ok) {
        console.warn('commitTurn failed', res.error);
        return { ok: false, error: res.error?.message ?? 'unknown' };
      }
      // The server already populates `ok: true` in its 200 payload, so
      // spreading res.data after `ok: true` would re-set the same key.
      // Take res.data wholesale (which has ok=true) and force `ok` true
      // defensively, in case the server somehow returns ok=false on a 200.
      return { ...res.data, ok: true };
    },
    async getTurnStatus() {
      const res = await apiFetch<TurnStatus>(`/api/games/${gameId}/turn/status`);
      if (!res.ok) return null;
      return res.data;
    },
    });
  }, [gameId]);

  return (
    <MultiplayerActionsContext.Provider value={value}>
      {children}
    </MultiplayerActionsContext.Provider>
  );
}

/** Returns the multiplayer actions, or null in single-player. */
export function useMultiplayerActions(): MultiplayerActions | null {
  return useContext(MultiplayerActionsContext);
}
