// Thin context exposing server action endpoints to the in-game UI.
//
// In single-player the context value is `null` and components fall back
// to the existing local mutations. In multiplayer, MultiplayerGameProvider
// wraps its children with a non-null context, and panels (ShipPanel,
// BuildPanel) post user intent to the server in addition to (or instead
// of) mutating local state.

import React, { createContext, useContext, useMemo } from 'react';
import { apiFetch } from './api';
import { logger } from '../game/logger';

export interface TransferIntent {
  shipId: string;
  targetBodyId: string;
  scheduledT: number;        // server tick when burn fires (== plan.startTick)
  /** Precomputed arrival tick (== plan.arriveTick). Sent so the server
   *  doesn't have to re-derive it — client-side torch math owns the
   *  travel-time computation; see src/physics/torchTransfer.ts. */
  arrivalT: number;
  dvPrograde: number;
  dvNormal?: number;
  dvRadial?: number;
  fuelCost: number;
}

export interface BuildIntent {
  bodyId: string;
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  shipName?: string;
  /** Player's picked icon variant from the BuildPanel dropdown.
   *  Server validates 'A'..'F'; undefined/null = class default. */
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
}

export interface SettlementIntent {
  bodyId: string;
  type: 'city' | 'station';
  name?: string;
}

export interface ResearchIntent {
  techId: string;
}

/** RAM intent — commits an asteroid (with built Trajectory Control
 *  Thrusters) to a torch transit toward `targetBodyId`. The client
 *  computes the entire plan via planTorchTransfer and posts every
 *  field; the server only validates + persists. Mirrors the same
 *  trust model the ship-transfer intent uses. */
export interface RamIntent {
  bodyId: string;                  // the asteroid being launched
  targetBodyId: string;
  startTick: number;
  flipTick: number;
  arriveTick: number;
  acceleration: number;
  startPos: { x: number; y: number };
  startVel: { x: number; y: number };
  interceptPos: { x: number; y: number };
  totalDv: number;
  fuelCost: number;
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

/** Common shape for any action that can be rejected by the server.
 *  When ok=false the caller gets the short server-side code (used by
 *  humanizeMpError to pick the right message) plus the freeform
 *  payload message as a fallback. Every mutating action now returns
 *  this rather than a bare boolean — without the code the UI is forced
 *  to silently reset on rejection, which reads as "the button did
 *  nothing." See src/multiplayer/errorMessages.ts. */
export type MpActionResult = { ok: true } | { ok: false; code?: string; error: string };

export interface MultiplayerActions {
  gameId: string;
  /** Post a committed maneuver node to the server. Errors carry a code
   *  (not_owner / not_found / bad_request) so the ShipPanel can surface
   *  the rejection instead of silently dropping the post. */
  transfer: (intent: TransferIntent) => Promise<MpActionResult>;
  /** Queue a ship build. Errors carry a code (not_owner /
   *  insufficient_resources / not_found) so BuildPanel can show the
   *  player why the queue didn't take. */
  build: (intent: BuildIntent) => Promise<MpActionResult>;
  /** Deploy a city or station at a body. Errors carry the server's
   *  rejection code (no_presence / no_surface / insufficient_resources)
   *  so the BodyInspector can surface it inline. */
  deploySettlement: (intent: SettlementIntent) => Promise<MpActionResult>;
  /** Spend science to advance a tech level. Server is authoritative on
   *  cost — errors carry tech_maxed / insufficient_resources for the
   *  TechPanel to surface. */
  research: (intent: ResearchIntent) => Promise<MpActionResult>;

  /** Trigger the RAM action on a rogue asteroid. Server validates
   *  ownership, TT presence, fuel; on success the body's natural
   *  orbit is replaced by the supplied torch plan. Doomsday clock
   *  starts here — there is no abort endpoint. */
  ram: (intent: RamIntent) => Promise<MpActionResult>;

  // --- Turn-Based Mode (MP) ---
  /** Host-only: enable/disable TBM and set ticks_per_turn for this game.
   *  Errors carry not_host so non-hosts see why the toggle didn't take. */
  setTurnSettings: (enabled: boolean, ticksPerTurn: number) => Promise<MpActionResult>;
  /** Submit caller's faction as ready for the current turn. If this commit
   *  fills the last slot, the server advances the sim by ticks_per_turn
   *  ticks before responding. */
  commitTurn: () => Promise<TurnCommitResult>;
  /** Poll the per-faction readiness for the current turn. */
  getTurnStatus: () => Promise<TurnStatus | null>;

  // --- Admin (host-only) ---
  /** Bump a faction's resource pools (or every faction when target='all').
   *  Server clamps each pool to >= 0. Returns ok+message — client surfaces
   *  the message in the AdminGrantModal when not ok. */
  adminGrant: (
    target: string | 'all',
    delta: { fuel?: number; ore?: number; credits?: number; science?: number },
  ) => Promise<MpActionResult>;

  // --- Cancel actions ---
  /** Cancel a queued ship build server-side (marks cancelled_at_tick,
   *  refunds metal+gold). Without this, optimistic local removal was
   *  clobbered by the next /state poll and the build re-appeared. */
  cancelBuild: (orderId: string) => Promise<MpActionResult>;
  /** Cancel a planned or committed maneuver node server-side (flips
   *  status='cancelled'). Same problem as build cancel: local-only
   *  removal got rewound by the next /state. */
  cancelNode: (nodeId: string) => Promise<MpActionResult>;

  // --- Collector network ---
  /** Upgrade a player-owned settlement to a logistics endpoint. Server
   *  charges COLLECTOR_COST (500 credits) and flips
   *  has_collector = 1. Without this server hop the local mutation
   *  would survive ~1.5s before the next /state poll restored
   *  has_collector=0 and refunded the resources. */
  buildCollector: (settlementId: string) => Promise<MpActionResult>;

  // --- Settlement upgrade buildings (forge/mint/lab/weapons/shipyard) ---
  /** Queue an upgrade. Server charges the current-level cost and writes
   *  building_order_json. Cancelled or completed orders clear that slot. */
  queueBuilding: (settlementId: string, kind: string) =>
    Promise<MpActionResult>;
  /** Cancel the in-flight upgrade at a settlement; server refunds the
   *  cost-at-queue-time and clears building_order_json. */
  cancelBuilding: (settlementId: string) =>
    Promise<MpActionResult>;

  // --- Dyson Sphere (Engineering Victory) ---
  /** Lay the Dyson Sphere foundation at one of the caller's Sol-orbit
   *  stations. Server enforces the one-per-game slot, station ownership,
   *  station type, and Sol-orbit checks. Per-tick delivery happens
   *  server-side in tickDysonSphere; the client just mounts the panel
   *  via the /state mirror. */
  initiateDysonSphere: (foundationSettlementId: string) =>
    Promise<MpActionResult>;

  // --- Trade routes ---
  /** Open a recurring freighter route between origin (any player
   *  settlement) and dest (a player collector). Server validates and
   *  inserts; the per-tick auto-pilot loop in worker/room.js drives
   *  the freighter from there. */
  createTradeRoute: (shipId: string, originBodyId: string, destBodyId: string) =>
    Promise<MpActionResult>;
  /** Cancel an active route. Server refunds any cargo in the hold to
   *  the player's pool (no resource leak). */
  cancelTradeRoute: (routeId: string) =>
    Promise<MpActionResult>;
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
          arrival_t: intent.arrivalT,
          dv_prograde: intent.dvPrograde,
          dv_normal: intent.dvNormal ?? 0,
          dv_radial: intent.dvRadial ?? 0,
          fuel_cost: intent.fuelCost,
        }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Transfer ordered', {
          ship: intent.shipId, to: intent.targetBodyId,
          arriveT: intent.arrivalT, fuel: intent.fuelCost,
        });
        return { ok: true };
      }
      console.warn('transfer failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the transfer.',
      };
    },
    async build(intent) {
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(qualify(intent.bodyId))}/build`, {
        method: 'POST',
        body: JSON.stringify({
          ship_class: intent.shipClass,
          ship_name: intent.shipName,
          icon_variant: intent.iconVariant ?? null,
        }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship build queued', {
          body: intent.bodyId, class: intent.shipClass, name: intent.shipName,
        });
        return { ok: true };
      }
      console.warn('build failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the build.',
      };
    },
    async deploySettlement(intent) {
      const res = await apiFetch(`/api/games/${gameId}/bodies/${encodeURIComponent(qualify(intent.bodyId))}/settlement`, {
        method: 'POST',
        body: JSON.stringify({ type: intent.type, name: intent.name }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Settlement deployed', {
          body: intent.bodyId, type: intent.type, name: intent.name,
        });
        return { ok: true };
      }
      console.warn('deploySettlement failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the settlement deploy.',
      };
    },
    async research(intent) {
      const res = await apiFetch(`/api/games/${gameId}/research`, {
        method: 'POST',
        body: JSON.stringify({ tech_id: intent.techId }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Research spent', { tech: intent.techId });
        return { ok: true };
      }
      console.warn('research failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the research spend.',
      };
    },
    async ram(intent) {
      const res = await apiFetch(
        `/api/games/${gameId}/bodies/${encodeURIComponent(qualify(intent.bodyId))}/ram`,
        {
          method: 'POST',
          body: JSON.stringify({
            target_body_id: qualify(intent.targetBodyId),
            start_tick: intent.startTick,
            flip_tick: intent.flipTick,
            arrive_tick: intent.arriveTick,
            acceleration: intent.acceleration,
            start_pos_x: intent.startPos.x,
            start_pos_y: intent.startPos.y,
            start_vel_x: intent.startVel.x,
            start_vel_y: intent.startVel.y,
            intercept_pos_x: intent.interceptPos.x,
            intercept_pos_y: intent.interceptPos.y,
            total_dv: intent.totalDv,
            fuel_cost: intent.fuelCost,
          }),
        },
      );
      if (res.ok) {
        logger.warn('ACTION', 'Asteroid ram launched', {
          asteroid: intent.bodyId, target: intent.targetBodyId,
          arriveTick: intent.arriveTick, fuel: intent.fuelCost,
        });
        return { ok: true };
      }
      console.warn('ram failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the asteroid ram.',
      };
    },
    async setTurnSettings(enabled, ticksPerTurn) {
      const res = await apiFetch(`/api/games/${gameId}/turn/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled, ticks_per_turn: ticksPerTurn }),
      });
      if (res.ok) return { ok: true };
      console.warn('setTurnSettings failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the TBM setting change.',
      };
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
    async cancelBuild(orderId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/builds/${encodeURIComponent(orderId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) return { ok: true };
      console.warn('cancelBuild failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected cancel.',
      };
    },
    async cancelNode(nodeId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/nodes/${encodeURIComponent(nodeId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) return { ok: true };
      console.warn('cancelNode failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected cancel.',
      };
    },
    async adminGrant(target, delta) {
      const res = await apiFetch<{ ok: boolean }>(`/api/games/${gameId}/admin/grant`, {
        method: 'POST',
        body: JSON.stringify({
          faction_id: target,
          fuel: delta.fuel ?? 0,
          ore: delta.ore ?? 0,
          credits: delta.credits ?? 0,
          science: delta.science ?? 0,
        }),
      });
      if (res.ok) {
        logger.warn('ACTION', 'Admin grant', {
          target, fuel: delta.fuel ?? 0, ore: delta.ore ?? 0,
          credits: delta.credits ?? 0, science: delta.science ?? 0,
        });
        return { ok: true };
      }
      console.warn('adminGrant failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the grant.',
      };
    },
    async buildCollector(settlementId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/settlements/${encodeURIComponent(settlementId)}/collector`,
        { method: 'POST' },
      );
      if (res.ok) {
        logger.info('ACTION', 'Collector built', { settlement: settlementId });
        return { ok: true };
      }
      console.warn('buildCollector failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the collector build.',
      };
    },
    async queueBuilding(settlementId, kind) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/settlements/${encodeURIComponent(settlementId)}/buildings`,
        { method: 'POST', body: JSON.stringify({ kind }) },
      );
      if (res.ok) {
        logger.info('ACTION', 'Building upgrade queued', { settlement: settlementId, kind });
        return { ok: true };
      }
      console.warn('queueBuilding failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the building queue.',
      };
    },
    async cancelBuilding(settlementId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/settlements/${encodeURIComponent(settlementId)}/buildings`,
        { method: 'DELETE' },
      );
      if (res.ok) return { ok: true };
      console.warn('cancelBuilding failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the cancel.',
      };
    },
    async initiateDysonSphere(foundationSettlementId) {
      // Server expects the namespaced settlement id ("<gameId>:<localId>").
      // Settlement ids in the client are unprefixed after the
      // MultiplayerGameProvider deserialization strips the namespace,
      // so qualify on the way out the same way every other action does.
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/dyson/initiate`,
        {
          method: 'POST',
          body: JSON.stringify({
            foundation_settlement_id: qualify(foundationSettlementId),
          }),
        },
      );
      if (res.ok) {
        logger.info('ACTION', 'Dyson Sphere foundation laid', { settlement: foundationSettlementId });
        return { ok: true };
      }
      console.warn('initiateDysonSphere failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the Dyson Sphere foundation.',
      };
    },
    async createTradeRoute(shipId, originBodyId, destBodyId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes`,
        {
          method: 'POST',
          body: JSON.stringify({
            ship_id: shipId,
            // Re-attach the gameId namespace; client stores stripped ids
            // but server endpoints expect the fully-qualified form
            // (same convention as transfers/builds).
            origin_body_id: qualify(originBodyId),
            dest_body_id: qualify(destBodyId),
          }),
        },
      );
      if (res.ok) {
        logger.info('ACTION', 'Trade route opened', { ship: shipId, origin: originBodyId, dest: destBodyId });
        return { ok: true };
      }
      console.warn('createTradeRoute failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the route.',
      };
    },
    async cancelTradeRoute(routeId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes/${encodeURIComponent(routeId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) return { ok: true };
      console.warn('cancelTradeRoute failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the cancel.',
      };
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
