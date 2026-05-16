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
}

const MultiplayerActionsContext = createContext<MultiplayerActions | null>(null);

export function MultiplayerActionsProvider({
  gameId, children,
}: { gameId: string; children: React.ReactNode }) {
  const value = useMemo<MultiplayerActions>(() => ({
    gameId,
    async transfer(intent) {
      const res = await apiFetch(`/api/games/${gameId}/ships/${encodeURIComponent(intent.shipId)}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          target_body_id: intent.targetBodyId,
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
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(intent.bodyId)}/build`, {
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
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(intent.bodyId)}/settlement`, {
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
  }), [gameId]);

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
