// Thin context exposing server action endpoints to the in-game UI.
//
// In single-player the context value is `null` and components fall back
// to the existing local mutations. In multiplayer, MultiplayerGameProvider
// wraps its children with a non-null context, and panels (ShipPanel,
// BuildPanel) post user intent to the server in addition to (or instead
// of) mutating local state.

import React, { createContext, useContext, useMemo } from 'react';
import { apiFetch as rawApiFetch } from './api';
import { perf } from './PerfHud';
import { logger } from '../game/logger';
import type { BuildListEntry, TargetPriorityKey } from '../types';

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
  /** True = this is a fresh route that SUPERSEDES the ship's current one:
   *  the server cancels the ship's existing committed/in-transit legs
   *  before adding this one, so a redirected ship can't end up with two
   *  live destinations (one player seeing it at the old target, the owner
   *  at the new). Omit/false for CHAINED legs, which append to the route. */
  replace?: boolean;
  /** The torch plan's launch state, recorded server-side so a ship's
   *  mid-flight position becomes a pure function of tick that the server
   *  and every client evaluate identically (DESIGN-transit-combat.md
   *  stage 0). Without it the server has no idea where a ship is between
   *  bodies, which is why transit combat couldn't exist.
   *
   *  Optional and all-or-nothing: omit the whole group and the node is
   *  stored plan-less, exactly as before this field existed. */
  launch?: {
    x: number; y: number;          // position at burn start
    vx: number; vy: number;        // velocity inherited from the parking orbit
    accel: number;                 // units/tick², engine_g × parts × tech
    flipTick: number;              // boost ends, brake begins
  };
  /** A matched-velocity rendezvous instead of a flip-and-burn: two burn
   *  vectors, when they meet, and whose trajectory to adopt afterwards
   *  (migration 0090). Requires `launch` — the arcs integrate from it.
   *  Server stores all-or-nothing and validates that the burns fit
   *  inside the window. */
  rendezvous?: {
    ax: number; ay: number;
    bx: number; by: number;
    meetTick: number;
    followShipId: string;
  };
}

export interface BuildIntent {
  bodyId: string;
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  shipName?: string;
  /** Player's picked icon variant from the BuildPanel dropdown.
   *  Server validates 'A'..'F'; undefined/null = class default. */
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
  /** Curated build list: the SPECIFIC design this build-list row builds
   *  (server snapshots its parts). Omit for a bare hull. */
  designId?: string;
  /** Explicit bare-hull build — tells the server to skip the legacy
   *  active-design fallback. Set for the build list's "bare" rows. */
  bare?: boolean;
}

export interface SettlementIntent {
  bodyId: string;
  type: 'city' | 'station';
  name?: string;
}

export interface ResearchIntent {
  /** Set the active project. Omit to leave the current project as-is
   *  (e.g. a queue-only update); null clears it. */
  techId?: string | null;
  /** Full desired research queue (FIFO), replacing the stored one.
   *  Omit to leave the queue untouched. */
  queue?: string[];
}

/** Standing-orders update for one or more ships (DESIGN §3). Every field
 *  is optional; only supplied fields are written. Passing null for a
 *  threshold clears it ("off"); passing null for stance resets to the
 *  default attack-on-sight behavior. */
export interface ShipOrdersIntent {
  shipIds: string[];
  stance?: 'attack' | 'defensive' | 'hold' | null;
  retreatHpPct?: 25 | 50 | 75 | null;
  detonateHpPct?: 25 | 50 | null;
  /** Ranked target categories (migration 0064). null = reset to auto. */
  targetPriority?: TargetPriorityKey[] | null;
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
  /** Metal charged to the faction pool at commit. (Was fuel until fuel
   *  left the economy — see BodyInspector's RAM_METAL_PER_DV.) */
  metalCost: number;
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

/** Server row shape for a ship design (ship designer §2). */
export interface ServerShipDesign {
  id: string;
  ship_class: string;
  name: string;
  parts_json: string | null;
  icon_variant: string | null;
  is_active: boolean;
  created_at_ms: number;
}

/** A cross-game saved loadout (migration 0038). Same shape as a design
 *  minus the per-game `is_active` pointer — a template is inert until
 *  loaded into some game's designer. */
export interface ServerShipTemplate {
  id: string;
  ship_class: string;
  name: string;
  parts_json: string | null;
  icon_variant: string | null;
  created_at_ms: number;
}

export interface SaveTemplateIntent {
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  name: string;
  parts: string[];
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
}

export interface CreateDesignIntent {
  /** Colony ships have 0 slots and are never offered by the designer UI;
   *  the server rejects designs for them (unknown slot count). */
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  name: string;
  parts: string[];
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
  setActive?: boolean;
}

export interface UpdateDesignPatch {
  name?: string;
  parts?: string[];
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | null;
  isActive?: boolean;
}

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

  /** Set standing orders (stance / retreat / detonate thresholds) on one
   *  or more owned ships in a single batch. Server validates ownership of
   *  EVERY ship — rejects the whole batch if any ship isn't the caller's
   *  (code=not_owner / not_found). Only fields present in the intent are
   *  written. */
  setShipOrders: (intent: ShipOrdersIntent) => Promise<MpActionResult>;

  /** Rename a ship the caller owns. Server trims + length-caps the
   *  name (1..32 chars). Rejects destroyed ships with code=destroyed
   *  and non-owners with code=not_owner. */
  renameShip: (shipId: string, name: string) => Promise<MpActionResult>;
  /** Rename a city or station the caller owns. Same validation +
   *  error codes as renameShip. */
  renameSettlement: (settlementId: string, name: string) => Promise<MpActionResult>;
  /** Name a meteoroid you discovered FIRST. One name for everyone who
   *  can see it, and only the first finder gets to set it — that is what
   *  makes the map a record of who was where. */
  renameBody: (bodyId: string, name: string) => Promise<MpActionResult>;
  /** Rewrite (or revert) a chronicle event's flavor text. Pass null to
   *  revert to the generated flavor. Server gates on party-to-event or
   *  host; rejections carry code=not_party. */
  editChronicleFlavor: (entryId: string, flavor: string | null) => Promise<MpActionResult>;

  // --- Ship designer (§2) ---
  /** Fetch the caller's design library. Returns null on failure so the
   *  designer can fall back to the /state mirror. */
  getDesigns: () => Promise<ServerShipDesign[] | null>;
  /** Cross-game template library (per USER, not per game). Lets a
   *  loadout survive into the next match. Null on failure. */
  getShipTemplates: () => Promise<ServerShipTemplate[] | null>;
  /** Save the current loadout as a reusable cross-game template. */
  saveShipTemplate: (intent: SaveTemplateIntent) => Promise<MpActionResult>;
  /** Remove a saved template. */
  deleteShipTemplate: (templateId: string) => Promise<MpActionResult>;
  /** Create a design (optionally activating it in the same call). */
  createDesign: (intent: CreateDesignIntent) => Promise<MpActionResult>;
  /** Rename / edit parts / set-active on an existing design. Editing
   *  never mutates queued or completed ships — parts are snapshot onto
   *  the build order at queue time. */
  updateDesign: (designId: string, patch: UpdateDesignPatch) => Promise<MpActionResult>;
  /** Delete a design. The active pointer simply clears — builds fall
   *  back to the bare hull until another design is activated. */
  deleteDesign: (designId: string) => Promise<MpActionResult>;
  /** Replace the caller's curated build list wholesale (migration 0045).
   *  The client owns ordering, so it always sends the full array. The
   *  server drops entries pointing at deleted designs. */
  setBuildList: (entries: BuildListEntry[]) => Promise<MpActionResult>;

  // --- Captains (DESIGN-captains §5) ---
  /** Create an unassigned bank captain (auto-rolled; optional name). */
  createCaptain: (name?: string) => Promise<MpActionResult>;
  /** Rename / re-avatar / re-bio one of the caller's captains. */
  updateCaptain: (captainId: string, patch: { name?: string; avatarId?: string; bio?: string }) => Promise<MpActionResult>;
  /** Assign a captain to one of the caller's ships (swapping any sitting
   *  captain back to the bank) or bench him with shipId=null. */
  assignCaptain: (captainId: string, shipId: string | null) => Promise<MpActionResult>;
  /** Trigger a ship's detonator (spec §2.2). Deals 50% of the ship's
   *  max HP per detonator part to EVERY in-orbit ship at the body —
   *  friend or foe alike — and destroys the ship. The confirming UI
   *  must show the full disclosure copy before calling this. */
  detonateShip: (shipId: string) => Promise<MpActionResult>;

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
  /** Rush a building order (§3): pay the ship's full price again, halve
   *  the remaining time. Unlimited; each rush risks a 25% half-health
   *  delivery. Result carries the new schedule + botch flag. */
  rushBuild: (orderId: string) => Promise<MpActionResult & {
    completesAtTick?: number; rushCount?: number; botched?: boolean;
    cost?: { ore: number; credits: number };
  }>;
  /** Propagate a design to every live hull of its class (§2). Ships at
   *  a friendly yard refit + pay now; the rest go "refit pending". */
  refitFleet: (designId: string) => Promise<MpActionResult & {
    refitted?: string[]; pending?: string[];
    charged?: { ore: number; credits: number };
  }>;
  /** The in-game Orbital Herald edition — the same clustered newspaper
   *  the Discord digest posts, composed read-only over the last 24h.
   *  null on any failure (the reader shows a "presses jammed" note). */
  getHerald: () => Promise<{
    title: string; description: string;
    fields: Array<{ name: string; value: string }>;
    tick: number; generated_at_ms: number; window_hours: number;
  } | null>;
  /** Cancel a planned or committed maneuver node server-side (flips
   *  status='cancelled'). Same problem as build cancel: local-only
   *  removal got rewound by the next /state. */
  cancelNode: (nodeId: string) => Promise<MpActionResult>;

  // --- Settlement upgrade buildings (forge/mint/lab/weapons/shipyard) ---
  /** Queue an upgrade. Server charges the current-level cost and writes
   *  building_order_json. Cancelled or completed orders clear that slot. */
  queueBuilding: (settlementId: string, kind: string) =>
    Promise<MpActionResult>;
  /** Cancel an upgrade at a settlement; the server refunds the
   *  cost-at-queue-time. Omit orderId to cancel the IN-FLIGHT build;
   *  pass one to drop a specific entry that is still waiting in the
   *  queue behind it. */
  cancelBuilding: (settlementId: string, orderId?: string) =>
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
  /** Order ONE hull to take a design. Stamps the pending refit; the tick
   *  pass fits it the moment the ship is parked somewhere friendly with
   *  the fee available. Pass null to cancel a standing order. */
  refitShip: (shipId: string, designId: string | null) =>
    Promise<MpActionResult>;
  cancelTradeRoute: (routeId: string) =>
    Promise<MpActionResult>;
  /** Dump a routed freighter's hold into the faction pool WITHOUT
   *  cancelling the route. Server refuses mid-burn, empty holds, and
   *  agreement legs (that cargo is owed to the counterparty). */
  unloadHold: (shipId: string) =>
    Promise<MpActionResult>;

  /** MANUAL MINING: start or stop working the rock this freighter is
   *  parked on. The automated path (a trade route with a mine stop) is
   *  unchanged; this is the hand-operated one beside it, at the same
   *  extraction rate. Server refuses a hull with no rig, mid-burn, off a
   *  rock, on an undiscovered rock, already flying a route, or full. */
  setMining: (shipId: string, active: boolean) =>
    Promise<MpActionResult>;

  // ---- MEGASTRUCTURES ----
  /** Spend a colony ship fitted with a Construction Module to lay a
   *  foundation at a world-space point. The point must fall inside the
   *  SOI of the body the ship is parked at. */
  placeFramework: (shipId: string, kind: string, x: number, y: number) =>
    Promise<MpActionResult & { siteId?: string }>;
  /** Hand a parked ship's cargo to a site. Takes only what is still
   *  needed; the rest stays aboard. */
  deliverToSite: (siteId: string, shipId: string) =>
    Promise<MpActionResult & { progress?: number }>;
  /** Wire one of your finished gates to another, or pass null to cut
   *  the link. Pairing is exactly one partner, both ways. */
  pairGate: (siteId: string, partnerBodyId: string | null) =>
    Promise<MpActionResult>;
  /** Step a parked ship through the gate it is sitting on. */
  gateTransit: (shipId: string) =>
    Promise<MpActionResult & { toName?: string }>;

  // ---- TRADE V2 (DESIGN-trade-v2) ----
  /** Lay a route with N stops from the composer. Body ids are stripped
   *  client-side and re-qualified here, same as every other endpoint. */
  createRouteFull: (input: {
    name?: string | null;
    stops: RouteStopInput[];
    loopMode?: 'forever' | 'count';
    loopCount?: number;
    carrierShipIds: string[];
    guardShipIds?: string[];
    guardFleetId?: string;
  }) => Promise<MpActionResult>;
  /** The hold gauge. Computed server-side by the same code the tick
   *  runs, so the projection cannot drift from the real load. */
  projectRoute: (stops: RouteStopInput[], shipId?: string) =>
    Promise<MpActionResult & { projection?: RouteProjection }>;
  /** Replace an existing route's itinerary — what "Add stops" on a
   *  two-stop route ends up calling. */
  updateRouteStops: (routeId: string, stops: RouteStopInput[], name?: string | null) =>
    Promise<MpActionResult>;
  /** Put a ship (or a whole fleet, for guards) on a route. Adding a
   *  carrier to a stalled route is also how it gets rescued. */
  addRouteShip: (
    routeId: string,
    role: 'carrier' | 'guard',
    opts: { shipId?: string; fleetId?: string },
  ) => Promise<MpActionResult>;
  removeRouteShip: (routeId: string, shipId: string) => Promise<MpActionResult>;
  /** Fold a standing agreement's two legs into ONE lane, keeping every
   *  freighter already working it. No handshake: nobody loses a hull,
   *  so there is nothing for the other side to consent to. */
  consolidateAgreement: (agreementId: string) => Promise<MpActionResult>;
}

/** One row of the composer's stop strip, as the client holds it. */
export interface RouteStopInput {
  bodyId: string;
  action: 'pickup' | 'dropoff' | 'mine';
  takeMetal?: boolean;
  takeGold?: boolean;
  takeScience?: boolean;
}

/** What the hold gauge draws — one entry per stop, plus the readouts. */
export interface RouteProjection {
  stops: Array<{
    sequence: number;
    body_id: string;
    action: 'pickup' | 'dropoff' | 'mine';
    loaded: { fuel: number; metal: number; gold: number; science: number };
    dropped: { fuel: number; metal: number; gold: number; science: number };
    aboard_after: { fuel: number; metal: number; gold: number; science: number };
    aboard_total: number;
    leg_ticks: number;
  }>;
  loop_ticks: number;
  hold_cap: number;
  peak_per_resource: number;
  delivered: { fuel: number; metal: number; gold: number; science: number };
}

const MultiplayerActionsContext = createContext<MultiplayerActions | null>(null);

export function MultiplayerActionsProvider({
  gameId, children,
}: { gameId: string; children: React.ReactNode }) {
  const value = useMemo<MultiplayerActions>(() => {
    // Every action in this provider goes through this wrapper: on any
    // successful non-GET, ping the game provider for an immediate /state
    // refetch (coalesced there). This is the "responsive UI" fix - the
    // result of a click shows up after one round-trip, not after the
    // 1.5s poll happens to fire. Shadowing the import means all ~30
    // action closures below inherit it without a 30-site rewrite.
    const apiFetch = async <T = unknown,>(path: string, init?: RequestInit) => {
      const t0 = performance.now();
      const res = await rawApiFetch<T>(path, init);
      const method = init?.method ?? 'GET';
      if (res.ok && method.toUpperCase() !== 'GET') {
        // Starts the click->pixels stopwatch; PerfHud closes it on the
        // frame that actually paints the resulting state.
        perf.recordAction(performance.now() - t0);
        window.dispatchEvent(new CustomEvent('orbital:refresh-state'));
      }
      return res;
    };
    // The client stores body IDs in the unprefixed form ('jupiter', 'sol')
    // after MultiplayerGameProvider strips the "<gameId>:" namespace at the
    // deserialization boundary. The server still expects the namespaced
    // form on every action endpoint, so re-attach the prefix on the way out.
    // Pass-through if the caller already gave us a fully-qualified id.
    const qualify = (id: string): string =>
      id.includes(':') ? id : `${gameId}:${id}`;
    // Composer stop -> wire shape. One converter for create, project
    // and edit, so a stop can never mean three different things.
    const toServerStop = (s: RouteStopInput) => ({
      body_id: qualify(s.bodyId),
      action: s.action,
      take_metal: s.takeMetal === false ? 0 : 1,
      take_gold: s.takeGold === false ? 0 : 1,
      take_science: s.takeScience === false ? 0 : 1,
    });

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
          replace: intent.replace === true,
          // Launch plan (migration 0088). Server validates all six as a
          // group and stores NULLs if anything is missing or incoherent,
          // so an older bundle omitting them behaves exactly as before.
          ...(intent.launch ? {
            launch_x: intent.launch.x,
            launch_y: intent.launch.y,
            launch_vx: intent.launch.vx,
            launch_vy: intent.launch.vy,
            accel: intent.launch.accel,
            flip_tick: intent.launch.flipTick,
          } : {}),
          ...(intent.rendezvous ? {
            rv_ax: intent.rendezvous.ax,
            rv_ay: intent.rendezvous.ay,
            rv_bx: intent.rendezvous.bx,
            rv_by: intent.rendezvous.by,
            rv_meet_tick: intent.rendezvous.meetTick,
            rv_follow_ship_id: intent.rendezvous.followShipId,
          } : {}),
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
          // Curated build list: build a specific design, or an explicit
          // bare hull. Legacy callers send neither → server active-design
          // fallback (unchanged).
          ...(intent.designId ? { design_id: intent.designId } : {}),
          ...(intent.bare ? { bare: true } : {}),
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
    async setShipOrders(intent) {
      // Only forward fields the caller actually set — the server
      // distinguishes "absent" (leave alone) from "null" (clear).
      const payload: Record<string, unknown> = {
        ship_ids: intent.shipIds.map(qualify),
      };
      if ('stance' in intent) payload.stance = intent.stance ?? null;
      if ('retreatHpPct' in intent) payload.retreat_hp_pct = intent.retreatHpPct ?? null;
      if ('detonateHpPct' in intent) payload.detonate_hp_pct = intent.detonateHpPct ?? null;
      if ('targetPriority' in intent) payload.target_priority = intent.targetPriority ?? null;
      const res = await apiFetch(`/api/games/${gameId}/ships/orders`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship orders set', {
          ships: intent.shipIds.length,
          stance: intent.stance,
          retreat: intent.retreatHpPct,
          detonate: intent.detonateHpPct,
        });
        return { ok: true };
      }
      console.warn('setShipOrders failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the orders update.',
      };
    },
    async renameBody(bodyId, name) {
      const res = await apiFetch(
        `/api/games/${gameId}/bodies/${encodeURIComponent(qualify(bodyId))}/rename`,
        { method: 'POST', body: JSON.stringify({ name }) },
      );
      if (res.ok) {
        logger.info('ACTION', 'Meteoroid named', { body: bodyId, name });
        return { ok: true };
      }
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the name.',
      };
    },

    async renameShip(shipId, name) {
      const res = await apiFetch(`/api/games/${gameId}/ships/${encodeURIComponent(qualify(shipId))}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship renamed', { ship: shipId, name });
        return { ok: true };
      }
      console.warn('renameShip failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the rename.',
      };
    },
    async renameSettlement(settlementId, name) {
      const res = await apiFetch(`/api/games/${gameId}/settlements/${encodeURIComponent(qualify(settlementId))}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Settlement renamed', { settlement: settlementId, name });
        return { ok: true };
      }
      console.warn('renameSettlement failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the rename.',
      };
    },
    async editChronicleFlavor(entryId, flavor) {
      const res = await apiFetch(`/api/games/${gameId}/chronicle/${encodeURIComponent(entryId)}/flavor`, {
        method: 'PATCH',
        body: JSON.stringify({ flavor }),
      });
      if (res.ok) {
        logger.info('ACTION', flavor == null ? 'Chronicle flavor reverted' : 'Chronicle flavor edited', { entry: entryId });
        return { ok: true };
      }
      console.warn('editChronicleFlavor failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the edit.',
      };
    },
    async research(intent) {
      // Send only the keys the caller set: `tech_id` present (incl.
      // null) changes the active project; absent leaves it. `queue`
      // present replaces the stored queue. A queue-only update omits
      // tech_id entirely so the server doesn't touch the project.
      const payload: Record<string, unknown> = {};
      if ('techId' in intent) payload.tech_id = intent.techId;
      if (intent.queue !== undefined) payload.queue = intent.queue;
      const res = await apiFetch(`/api/games/${gameId}/research`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        logger.info('ACTION', 'Research updated', { tech: intent.techId, queued: intent.queue?.length });
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
            metal_cost: intent.metalCost,
          }),
        },
      );
      if (res.ok) {
        logger.warn('ACTION', 'Asteroid ram launched', {
          asteroid: intent.bodyId, target: intent.targetBodyId,
          arriveTick: intent.arriveTick, metal: intent.metalCost,
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
    async getDesigns() {
      const res = await apiFetch<{ designs: ServerShipDesign[] }>(`/api/games/${gameId}/designs`);
      if (!res.ok) return null;
      return res.data.designs ?? [];
    },
    // --- Cross-game templates (migration 0038) ---
    // NOT game-scoped: these live on the user account, so a loadout saved
    // in one match can be loaded into the next one.
    async getShipTemplates() {
      const res = await apiFetch<{ templates: ServerShipTemplate[] }>('/api/users/me/ship-templates');
      if (!res.ok) return null;
      return res.data.templates ?? [];
    },
    async saveShipTemplate(intent) {
      const res = await apiFetch('/api/users/me/ship-templates', {
        method: 'POST',
        body: JSON.stringify({
          ship_class: intent.shipClass,
          name: intent.name,
          parts: intent.parts,
          icon_variant: intent.iconVariant ?? null,
        }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship template saved', {
          class: intent.shipClass, name: intent.name, parts: intent.parts.join(','),
        });
        return { ok: true };
      }
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the template.',
      };
    },
    async deleteShipTemplate(templateId) {
      const res = await apiFetch(`/api/users/me/ship-templates/${encodeURIComponent(templateId)}`, {
        method: 'DELETE',
      });
      if (res.ok) return { ok: true };
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Could not delete the template.',
      };
    },
    async createDesign(intent) {
      const res = await apiFetch(`/api/games/${gameId}/designs`, {
        method: 'POST',
        body: JSON.stringify({
          ship_class: intent.shipClass,
          name: intent.name,
          parts: intent.parts,
          icon_variant: intent.iconVariant ?? null,
          set_active: intent.setActive === true,
        }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship design created', {
          class: intent.shipClass, name: intent.name, parts: intent.parts.join(','),
        });
        return { ok: true };
      }
      console.warn('createDesign failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the design.',
      };
    },
    async updateDesign(designId, patch) {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.parts !== undefined) body.parts = patch.parts;
      if (patch.iconVariant !== undefined) body.icon_variant = patch.iconVariant;
      if (patch.isActive !== undefined) body.is_active = patch.isActive;
      const res = await apiFetch(`/api/games/${gameId}/designs/${encodeURIComponent(designId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship design updated', { design: designId });
        return { ok: true };
      }
      console.warn('updateDesign failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the design update.',
      };
    },
    async deleteDesign(designId) {
      const res = await apiFetch(`/api/games/${gameId}/designs/${encodeURIComponent(designId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        logger.info('ACTION', 'Ship design deleted', { design: designId });
        return { ok: true };
      }
      console.warn('deleteDesign failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the delete.',
      };
    },
    async setBuildList(entries) {
      const res = await apiFetch(`/api/games/${gameId}/build-list`, {
        method: 'PUT',
        body: JSON.stringify({
          entries: entries.map(e =>
            e.designId ? { design_id: e.designId } : { bare_class: e.bareClass },
          ),
        }),
      });
      if (res.ok) {
        logger.info('ACTION', 'Build list updated', { count: entries.length });
        return { ok: true };
      }
      console.warn('setBuildList failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the build list.',
      };
    },
    async createCaptain(name) {
      const res = await apiFetch(`/api/games/${gameId}/captains`, {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      });
      if (res.ok) { logger.info('ACTION', 'Captain created', { name: name ?? '(rolled)' }); return { ok: true }; }
      console.warn('createCaptain failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the captain.' };
    },
    async updateCaptain(captainId, patch) {
      const res = await apiFetch(`/api/games/${gameId}/captains/${encodeURIComponent(captainId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.avatarId !== undefined ? { avatar_id: patch.avatarId } : {}),
          ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
        }),
      });
      if (res.ok) { logger.info('ACTION', 'Captain updated', { captain: captainId }); return { ok: true }; }
      console.warn('updateCaptain failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the edit.' };
    },
    async assignCaptain(captainId, shipId) {
      const res = await apiFetch(`/api/games/${gameId}/captains/${encodeURIComponent(captainId)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ ship_id: shipId === null ? null : qualify(shipId) }),
      });
      if (res.ok) { logger.info('ACTION', 'Captain assigned', { captain: captainId, ship: shipId }); return { ok: true }; }
      console.warn('assignCaptain failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the assignment.' };
    },
    async detonateShip(shipId) {
      const res = await apiFetch(`/api/games/${gameId}/ships/${encodeURIComponent(qualify(shipId))}/detonate`, {
        method: 'POST',
      });
      if (res.ok) {
        logger.warn('ACTION', 'Ship detonated', { ship: shipId });
        return { ok: true };
      }
      console.warn('detonateShip failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the detonation.',
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
    async getHerald() {
      const res = await apiFetch<{
        edition: {
          title: string; description: string;
          fields: Array<{ name: string; value: string }>;
          tick: number; generated_at_ms: number; window_hours: number;
        };
      }>(`/api/games/${gameId}/herald`);
      if (res.ok) return res.data.edition;
      console.warn('getHerald failed', res.error);
      return null;
    },
    async rushBuild(orderId) {
      const res = await apiFetch<{
        ok: boolean; completes_at_tick: number; rush_count: number;
        botched: boolean; cost: { metal: number; gold: number };
      }>(
        `/api/games/${gameId}/builds/${encodeURIComponent(orderId)}/rush`,
        { method: 'POST' },
      );
      if (res.ok) {
        return {
          ok: true,
          completesAtTick: res.data.completes_at_tick,
          rushCount: res.data.rush_count,
          botched: res.data.botched,
          cost: { ore: res.data.cost?.metal ?? 0, credits: res.data.cost?.gold ?? 0 },
        };
      }
      console.warn('rushBuild failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the rush.',
      };
    },
    async refitFleet(designId) {
      const res = await apiFetch<{
        ok: boolean; refitted: string[]; pending: string[];
        charged: { metal: number; gold: number };
      }>(
        `/api/games/${gameId}/designs/${encodeURIComponent(designId)}/refit-fleet`,
        { method: 'POST' },
      );
      if (res.ok) {
        return {
          ok: true,
          refitted: res.data.refitted ?? [],
          pending: res.data.pending ?? [],
          charged: { ore: res.data.charged?.metal ?? 0, credits: res.data.charged?.gold ?? 0 },
        };
      }
      console.warn('refitFleet failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the refit.',
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
    // buildCollector was deleted with the terraforming rework — the
    // server endpoint is gone; terraformed status is the loading dock.
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
    async cancelBuilding(settlementId, orderId) {
      const q = orderId ? `?order_id=${encodeURIComponent(orderId)}` : '';
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/settlements/${encodeURIComponent(settlementId)}/buildings${q}`,
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
    // ---- TRADE V2 ----
    // Every stop's body id is re-qualified with the gameId namespace,
    // exactly as createTradeRoute has always done.
    async createRouteFull(input) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes/full`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: input.name ?? null,
            stops: input.stops.map(toServerStop),
            loop_mode: input.loopMode ?? 'forever',
            loop_count: input.loopCount,
            carrier_ship_ids: input.carrierShipIds,
            guard_ship_ids: input.guardShipIds ?? [],
            guard_fleet_id: input.guardFleetId,
          }),
        },
      );
      if (res.ok) {
        logger.info('ACTION', 'Route laid', {
          stops: input.stops.length, carriers: input.carrierShipIds.length,
        });
        return { ok: true };
      }
      console.warn('createRouteFull failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the route.' };
    },
    async projectRoute(stops, shipId) {
      const res = await apiFetch<{ ok: boolean; projection: RouteProjection }>(
        `/api/games/${gameId}/trade-routes/project`,
        { method: 'POST', body: JSON.stringify({ ship_id: shipId, stops: stops.map(toServerStop) }) },
      );
      if (res.ok) return { ok: true, projection: res.data?.projection };
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Could not project the run.' };
    },
    async updateRouteStops(routeId, stops, name) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes/${encodeURIComponent(routeId)}/stops`,
        { method: 'PATCH', body: JSON.stringify({ name, stops: stops.map(toServerStop) }) },
      );
      if (res.ok) return { ok: true };
      console.warn('updateRouteStops failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the change.' };
    },
    async addRouteShip(routeId, role, opts) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes/${encodeURIComponent(routeId)}/ships`,
        { method: 'POST', body: JSON.stringify({ role, ship_id: opts.shipId, fleet_id: opts.fleetId }) },
      );
      if (res.ok) {
        logger.info('ACTION', 'Ship assigned to route', { route: routeId, role });
        return { ok: true };
      }
      console.warn('addRouteShip failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the assignment.' };
    },
    async removeRouteShip(routeId, shipId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-routes/${encodeURIComponent(routeId)}/ships/${encodeURIComponent(shipId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) return { ok: true };
      console.warn('removeRouteShip failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the removal.' };
    },
    async consolidateAgreement(agreementId) {
      const res = await apiFetch<{ ok: boolean; carriers?: string[] }>(
        `/api/games/${gameId}/trade-agreements/${encodeURIComponent(agreementId)}/consolidate`,
        { method: 'POST' },
      );
      if (res.ok) {
        logger.info('ACTION', 'Lane consolidated', { agreement: agreementId });
        return { ok: true };
      }
      console.warn('consolidateAgreement failed', res.error);
      return { ok: false, code: res.error?.code, error: res.error?.message ?? 'Server rejected the merge.' };
    },
    async unloadHold(shipId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/unload-hold`,
        { method: 'POST' },
      );
      if (res.ok) return { ok: true };
      console.warn('unloadHold failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the unload.',
      };
    },
    async setMining(shipId, active) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/mine`,
        { method: 'POST', body: JSON.stringify({ active }) },
      );
      if (res.ok) return { ok: true };
      console.warn('setMining failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the mining order.',
      };
    },
    async placeFramework(shipId, kind, x, y) {
      const res = await apiFetch<{ ok: boolean; site?: { id: string } }>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/place-framework`,
        { method: 'POST', body: JSON.stringify({ kind, x, y }) },
      );
      if (res.ok) return { ok: true, siteId: res.data?.site?.id };
      console.warn('placeFramework failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server refused the foundation.',
      };
    },
    async deliverToSite(siteId, shipId) {
      const res = await apiFetch<{ ok: boolean; site?: { progress: number } }>(
        `/api/games/${gameId}/megastructures/${encodeURIComponent(siteId)}/deliver`,
        { method: 'POST', body: JSON.stringify({ ship_id: shipId }) },
      );
      if (res.ok) return { ok: true, progress: res.data?.site?.progress };
      console.warn('deliverToSite failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server refused the delivery.',
      };
    },
    async pairGate(siteId, partnerBodyId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/megastructures/${encodeURIComponent(siteId)}/pair`,
        { method: 'POST', body: JSON.stringify({ partner_body_id: partnerBodyId }) },
      );
      if (res.ok) return { ok: true };
      console.warn('pairGate failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server refused the pairing.',
      };
    },
    async gateTransit(shipId) {
      const res = await apiFetch<{ ok: boolean; to?: { name: string } }>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/gate`,
        { method: 'POST' },
      );
      if (res.ok) return { ok: true, toName: res.data?.to?.name };
      console.warn('gateTransit failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server refused the transit.',
      };
    },
    async refitShip(shipId, designId) {
      const res = await apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/refit`,
        { method: 'POST', body: JSON.stringify({ design_id: designId }) },
      );
      if (res.ok) {
        logger.info('ACTION', designId ? 'Refit ordered' : 'Refit cancelled', { ship: shipId });
        return { ok: true };
      }
      console.warn('refitShip failed', res.error);
      return {
        ok: false,
        code: res.error?.code,
        error: res.error?.message ?? 'Server rejected the refit order.',
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
