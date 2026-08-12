// ============================================================
// Core Type Definitions for Orbital Game State and UI
// ============================================================

/**
 * Orbital elements: describes an elliptical orbit around a parent body
 * Uses Kepler elements: semi-major axis (a), eccentricity (e), etc.
 */
export interface OrbitElements {
  rp: number;              // periapsis radius (closest approach)
  ra: number;              // apoapsis radius (farthest point)
  omega: number;           // argument of periapsis (angle to Pe in orbital plane)
  M0: number;              // mean anomaly at epoch (stored as true anomaly)
  epoch: number;           // tick number when this orbit was computed
  direction: 1 | -1;       // +1 for prograde, -1 for retrograde
  period: number;          // orbital period in ticks (Kepler's 3rd law)
  parentBodyId: string;    // ID of the body this orbit is around
}

/**
 * Maneuver node: a planned burn at a specific time
 * status: 'planned' (not yet committed), 'committed' (ready to execute),
 *         'executed' (has been performed)
 */
export interface ManeuverNode {
  id: string;
  shipId: string;
  type: 'transfer' | 'orbital_change' | 'manual_burn';
  burnTime: number;                    // tick when burn occurs
  deltav: number;                      // delta-v in km/s equivalent
  prograde: number;                    // prograde component of burn
  radial: number;                      // radial component of burn
  normal: number;                      // normal component of burn
  status: 'planned' | 'committed' | 'executed';
  /** MP only. True once the SERVER has actually fired the burn
   *  (node status 'in_transit'). `status` collapses in_transit into
   *  'committed' so existing UI keeps rendering the arc, which left no
   *  way to tell "ordered, still parked" from "already gone" — and
   *  therefore no way to know whether a recall could still work. */
  departed?: boolean;
  label?: string;                      // human-readable burn label

  // Predicted outcome after burn
  preOrbit?: OrbitElements;            // orbit before burn
  postOrbit?: OrbitElements;           // orbit after burn
  capturedAtBody?: string;             // if transfer, body where capture occurs
  escapesBody?: boolean;               // if true, escapes to hyperbolic
}

/**
 * A celestial body: planet, star, moon, asteroid, or Lagrange point
 */
export interface Body {
  id: string;
  name: string;
  type: 'star' | 'black_hole' | 'terrestrial' | 'gas_giant' | 'ice_giant' | 'moon' | 'dwarf' | 'asteroid' | 'lagrange';

  /** Terraforming (MP, migration 0080). A body is RAW until terraformed.
   *  Terraformed worlds route 100% of settlement yield to the faction
   *  pool, host cities + city buildings, and serve as trade endpoints.
   *  Permanent — survives conquest and razing; only an asteroid strike
   *  clears it. Undefined in SP, where every world behaves as before. */
  terraformedAtTick?: number | null;
  /** Delivery meter toward the terraform payload (lives on the body —
   *  progress transfers with conquest). */
  terraformAcc?: { metal: number; credits: number };
  /** Set once the payload is fully delivered: the tick the
   *  transformation window closes and the world flips terraformed. */
  terraformCompletesAtTick?: number | null;
  mu?: number;                          // gravitational parameter (per-body override)

  // Orbital parameters (if not a star)
  parent?: string;                      // parent body id (null for Sol)
  orbitRadius: number;                  // semi-major axis of orbit around parent
  orbitPeriod: number;                  // orbital period in ticks
  angle0: number;                       // initial angle (radians) on orbit

  // Physical properties
  radius: number;                       // visible radius in game units (for rendering)
  soi: number;                          // sphere of influence

  // Appearance
  color: string;                        // hex color for rendering

  // Resources (per tick production/storage)
  resources?: {
    metal: number;
    fuel: number;
    gold: number;
    science: number;
  };

  // Ownership
  ownedBy?: string;                     // faction id

  /** Hidden surprise — set at game start by the secrets seeder for a
   *  handful of non-capital bodies. Revealed when a player ship first
   *  reaches the body; the effect fires and `revealed` flips true.
   *  Persistent secrets (portal_to_sun, slingshot_anomaly) keep
   *  applying after reveal; one-shot secrets are inert after firing. */
  secret?: BodySecret;

  /** Eccentric Kepler elements (rogue asteroids only).
   *
   *  Standard bodies use the legacy circular shortcut: position is
   *  (cos(angle), sin(angle)) * orbitRadius, with angle linear in t.
   *  Rogue asteroids spawned on long Kuiper-belt-class trajectories
   *  need eccentric orbits, so when these four fields are present
   *  bodyPosition switches to full Kepler propagation around the
   *  parent — same math the ship orbits use. orbitRadius is kept in
   *  sync with the semi-major axis for any non-asteroid code that
   *  still reads it (period derivation, sensor checks, etc.).
   *
   *  rp/ra in game units, omega in radians, m0 = mean anomaly at
   *  epoch (NOT true anomaly — distinguishes from OrbitElements.M0,
   *  which historically stored true anomaly for ship orbits).
   */
  orbit_rp?: number;
  orbit_ra?: number;
  orbit_omega?: number;
  orbit_m0?: number;

  /** Active asteroid-weapon trajectory. When set, the body has been
   *  diverted from its natural orbit and is on a torch transit toward
   *  `targetBodyId`. Renderer + bodyPosition override the Kepler/
   *  circular path and integrate this plan instead. Cleared (with
   *  the body itself destroyed) at arriveTick. */
  ramPlan?: RamPlan;

  /** Set when the body has been destroyed — either smashed into a
   *  target via its own ram plan, or wiped by an incoming impact
   *  (planets don't get destroyed, but asteroids can collide
   *  asteroid-on-asteroid in pathological cases). Filtered out of
   *  /state. */
  destroyedAtTick?: number;
}

/**
 * Asteroid-weapon trajectory. Created when a player triggers the RAM
 * action on a rogue asteroid that hosts a built `trajectory_thrusters`
 * building. The asteroid is then on a torch transit toward
 * `targetBodyId`; on arrival the target's settlements are destroyed,
 * its yields are halved, and the asteroid itself is removed.
 *
 * Once committed, the plan cannot be aborted or re-targeted — the
 * doomsday clock is the entire mechanic.
 */
export interface RamPlan {
  targetBodyId: string;
  startTick: number;
  flipTick: number;
  arriveTick: number;
  acceleration: number;          // game-units / tick² (boost = brake, symmetric)
  startPos: { x: number; y: number };
  startVel: { x: number; y: number };
  interceptPos: { x: number; y: number };
  totalDv: number;
  /** Faction that committed the impact — for chronicle attribution,
   *  honor decrement (-100 max penalty), and post-impact propaganda. */
  ownedBy: string;
}

/**
 * Kinds of exploration surprises seeded onto non-capital bodies.
 *
 *   portal_to_sun     — every arriving ship is warped to a low Sol orbit
 *                       (persistent shortcut once discovered)
 *   warp_gate         — every arriving ship is warped to a low orbit
 *                       around `destinationBodyId`. Used to link Sol to
 *                       the far binary system (and back). One gate body
 *                       in each system, randomized per map seed on the
 *                       Sol side, fixed on the binary side. Persistent.
 *   ancient_city      — discoverer gets a free city (pop 3, free Lab L2)
 *   free_collector    — discoverer gets a free city with hasCollector
 *   derelict_warship  — discoverer claims a free Destroyer-class ship
 *   resource_cache    — discoverer's pool gets +500 ore + 500 credits
 *   ancient_databank  — discoverer gets +1 level in a random tech
 */
export type BodySecretKind =
  | 'portal_to_sun'
  | 'warp_gate'
  | 'ancient_city'
  | 'free_collector'    // legacy (SP + pre-terraforming MP games) — MP no longer seeds it
  | 'pre_terraformed'   // MP only: a world the ancients terraformed — status only, no settlement
  | 'derelict_warship'
  | 'resource_cache'
  | 'ancient_databank';

export interface BodySecret {
  kind: BodySecretKind;
  revealed?: boolean;                   // set when the effect first fires
  discoveredByFactionId?: string;
  discoveredAtTick?: number;
  /** Destination body id for `warp_gate` secrets. Ships arriving at the
   *  host body get teleported into a low orbit around the destination.
   *  Unused for other secret kinds. */
  destinationBodyId?: string;
}

/**
 * Fleet: a group of ships that move and fight together
 */
export interface Fleet {
  id: string;
  name: string;
  shipIds: string[];
  leadShipId: string;                   // the ship whose position represents the fleet
  ownedBy: string;                      // faction id

  /** Server fleets (DESIGN-fleets.md): the flag captain who commands.
   *  null flagCaptainId (leaderless=true) = flagship lost; the fleet
   *  refuses new common orders until a member captain is promoted. */
  flagCaptainId?: string | null;
  flagCaptainName?: string | null;
  flagCaptainRank?: number;
  flagCaptainTraits?: string[];
  leaderless?: boolean;
}

/**
 * A starship under player or enemy control
 *
 * A ship is in exactly ONE of two STATES at any time, discriminated by
 * the presence of `transit`:
 *
 *  • PARKED (transit == undefined): Ship is in a closed orbit around
 *    some body. `orbit` describes that orbit; rendering and game logic
 *    use it directly.
 *
 *  • IN TRANSIT (transit != undefined): Ship is on a torch trajectory
 *    in heliocentric coordinates. `transit.pos` and `transit.vel` are
 *    integrated each tick by the game loop. `orbit` still exists (it's
 *    the ship's last parked orbit, kept for type-compat) but rendering
 *    and game logic must check `transit` first via the helpers in
 *    src/render/visibility.ts.
 *
 * Transitions:
 *  - Launch (parked → transit): `transit` populated from parent body's
 *    instantaneous (pos, vel) at the launch tick; `orbit` is left alone
 *    as a stale snapshot.
 *  - Arrival (transit → parked): `transit` cleared, `orbit` overwritten
 *    with a circular parking orbit around the new parent body (default
 *    Pe ≈ 1.5·body.radius, prograde).
 */
export interface Ship {
  id: string;
  name: string;
  class: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  ownedBy: string;                      // faction id

  // Current state
  fuel: number;                         // remaining fuel
  hp?: number;                          // current HP (undefined = full from class def)
  fleetId?: string;                     // fleet this ship belongs to (if any)
  /** Per-ship icon variant override picked at construction. Falls back
   *  to DEFAULT_SHIP_ICONS[class] when undefined. Values map 1:1 to
   *  ShipIconVariant ('A'..'F') in src/components/ShipIcons.tsx. */
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
  /** Ship-designer parts loadout (multiplayer only, migration 0033).
   *  Snapshot from the active design at queue time; undefined/empty =
   *  bare hull = legacy class-def stats. Part ids are ShipPartId
   *  ('weapon'|'shield'|'engine'|'detonator') — see src/game/shipParts.ts.
   *  SP ships never carry parts (designer is MP-only; SP AI frozen). */
  parts?: string[];
  /** MP intel gate (Deep Scan, sensors 5): true when the server REDACTED
   *  this enemy's parts — loadout unknown, not necessarily a bare hull.
   *  Never set in SP. */
  partsRedacted?: boolean;
  /** Server-authoritative max HP (multiplayer only). Includes shield
   *  parts + tech applied at build completion. Undefined falls back to
   *  the class-def HP (single-player + legacy ships). */
  hpMax?: number;
  /** Server-computed LIVE hp ceiling: hpMax x rank x armor tech x
   *  Bulwark x fleet aura. Authoritative — the client can't derive it
   *  for rival hulls (it only receives its own faction's tech), which
   *  is what produced "307/204" displays. Undefined in single-player. */
  hpMaxEffective?: number;
  /** Server-authoritative damage per volley (multiplayer only) —
   *  includes weapon parts. Undefined = class def. */
  damagePerTick?: number;

  // Orbital position. Always set. During transit it's a stale snapshot
  // of the last parked orbit; rendering and game logic must check
  // `transit` first via the visibility helpers.
  orbit: OrbitElements;

  // Torch transit state — present when the ship is mid-burn between
  // bodies. `transit.pos` and `transit.vel` are integrated each tick by
  // the game loop.
  transit?: ShipTransitState;

  // Chained transfer queue. When the current transit arrives, the
  // executor pops the head of this list and starts it. Each entry is
  // pre-planned (its startPos / startVel match the prior leg's arrival
  // pos/vel) so the player can see realistic ETAs and trajectories
  // for the full chain. Empty / undefined means the ship parks at the
  // current transit's destination.
  queuedTransits?: TorchTransferPlan[];

  // Planned-but-not-launched torch transfer. The player picked a
  // destination but hasn't clicked COMMIT yet. The renderer shows a
  // dashed preview from the ship's current parked position; COMMIT
  // promotes this into ship.transit. Mutually exclusive with
  // ship.transit (a ship in transit can't also have a separate plan).
  plannedTransit?: TorchTransferPlan;

  // Maneuvers
  orders: ManeuverNode[];               // planned/committed burns for this ship

  // Combat — tick when this ship last fired in auto-combat at its body
  lastCombatTick?: number;
  // Combat — tick when this ship last TOOK damage. Used by the renderer
  // to flash the ship marker briefly so the player sees hits land.
  lastDamagedTick?: number;
  // Combat — the ship/settlement id this ship engaged on its last volley
  // (round-robin single-target combat). The combat animation aims its
  // bolts here so the player sees who each hull is actually shooting.
  lastTargetId?: string;

  /** Refit propagation (DESIGN-fleet-economy §2, MP only): non-null
   *  means this hull is queued to refit to that design (and pay the
   *  fee) at its next friendly yard. Drives "Refit pending" badges. */
  refitPendingDesignId?: string;

  // Veterancy: every confirmed kill +1 rank. Each rank grants +1% damage
  // and +1% max HP, applied via rankDamageMul/rankHpMul in src/game/techs.ts
  // (alongside the weapons/armor tech modifiers). Defaults to 0 for fresh
  // hulls; undefined treated as 0 for back-compat with older save blobs.
  rank?: number;
  // Last 20 confirmed kills (LRU — oldest dropped when full) so the
  // ShipPanel can surface a per-ship combat record without bloating
  // saves. Older saves migrate to an empty array on load.
  combatHistory?: ShipKillRecord[];
  /** Captains (DESIGN-captains.md): the officer commanding this hull.
   *  rank above is HIS rank (server COALESCEs), so all existing veterancy
   *  math keeps working. name/avatar/traits are null on RIVAL ships until
   *  intel.loadouts (Sensors 5) — identity is gated like fitted loadouts. */
  captainId?: string | null;
  captainName?: string | null;
  captainAvatar?: string | null;
  captainTraits?: string[];
  // Freighter-only: cumulative trade-route deliveries. Increments by 1
  // each time the ship lands at a route's dest body with cargo and
  // dumps it into the faction pool. Replaces the COMBAT RECORD panel
  // on the ShipPanel for freighters with a TRADE LOG view, since
  // freighters can't actually kill. Migration 0025.
  tradesCompleted?: number;

  // === Standing orders (MP, DESIGN-identity-economy.md §3, migration 0034) ===
  // Stance: attack-on-sight (default, undefined == 'attack'), return-fire
  // only ('defensive'), or never fire ('hold').
  stance?: 'attack' | 'defensive' | 'hold';
  // Auto-retreat threshold (percent of max HP). null/undefined = off.
  // When set, the server auto-transfers the ship to the nearest friendly
  // shipyard-station body once hp/hpMax drops to or below the threshold.
  retreatHpPct?: 25 | 50 | 75 | null;
  // Dead-man detonate threshold. null/undefined = off. Only meaningful
  // for hulls carrying a detonator part; inert otherwise.
  detonateHpPct?: 25 | 50 | null;
  // Target priority (migration 0064). null/undefined = auto (peer
  // targeting inside the tier ladder). Otherwise a ranked permutation of
  // the five TargetPriorityKey categories — the ship engages the first
  // ranked category with a live hostile at its body.
  targetPriority?: TargetPriorityKey[] | null;
}

/** Target-priority category keys, mirroring TARGET_PRIORITY_KEYS in
 *  worker/actions.js. 'civilian' = freighters + colony ships;
 *  'settlement' = stations + cities. */
export type TargetPriorityKey =
  | 'corvette' | 'frigate' | 'destroyer' | 'civilian' | 'settlement';

/** The auto/default ranking shown before a player customizes — matches the
 *  server ladder (warships > civilians > settlements). Warship order here
 *  is cosmetic: auto mode actually targets by speed proximity. */
export const TARGET_PRIORITY_DEFAULT: TargetPriorityKey[] =
  ['corvette', 'frigate', 'destroyer', 'civilian', 'settlement'];

/** One confirmed kill credited to a ship. Stored on Ship.combatHistory.
 *  Recorded by combat.ts when a destroyed ship's top-damaging attacker
 *  is the owning ship — see autoCombatAtBodies. */
export interface ShipKillRecord {
  /** Game tick when the kill resolved. */
  tick: number;
  /** Display name of the destroyed ship at the moment it died. */
  targetName: string;
  /** Class of the destroyed ship — useful for "killed 3 corvettes" stats. */
  targetClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  /** Body id where the engagement took place. */
  atBodyId: string;
}

/**
 * State-vector data carried by a ship during a torch transit. (pos, vel)
 * are heliocentric world coordinates in game units; the integrator in
 * src/physics/torchTransfer.ts advances them every game tick.
 *
 * `currentTransfer` is the active plan — target body, accelerations,
 * timing. `plannedTransfer` is a not-yet-launched proposal the player
 * is configuring (it lives here briefly during planning, then gets
 * promoted to currentTransfer when the player clicks LAUNCH).
 */
export interface ShipTransitState {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  currentTransfer: TorchTransferPlan;
}

/**
 * A torch transfer plan. Mirrors the runtime `TorchTransfer` type in
 * src/physics/torchTransfer.ts; redeclared here so types.ts doesn't
 * depend on the physics module.
 */
export interface TorchTransferPlan {
  targetBodyId: string;
  acceleration: number;          // boost-phase g (game units / tick²)
  brakeAcceleration: number;     // brake-phase g — equal to acceleration for v1
  startTick: number;
  flipTick: number;
  arriveTick: number;
  thrustDir: { x: number; y: number };
  interceptPos: { x: number; y: number };
  startPos: { x: number; y: number };
  startVel: { x: number; y: number };
  totalDv: number;
  peakVelocity: number;
  /** Multiplayer: id of the server `game_ship_nodes` row this leg was
   *  reconstructed from, so the UI can cancel it server-side. Undefined
   *  for single-player and not-yet-committed local preview legs. */
  nodeId?: string;
}

/**
 * A faction (player, enemy, ally)
 */
export interface Faction {
  id: string;
  name: string;
  color: string;                        // hex color for faction assets (PRIMARY — carries all meaning)
  /** Secondary trim color (two-tone factions, §5). Decoration only —
   *  meaning must never be encoded solely in the secondary (colorblind
   *  safety). Absent → derive via deriveSecondary(color). */
  color2?: string;
  /** Flag emblem id (see src/game/emblems.ts). Absent on legacy factions
   *  and on the single-player model, which never seeds one — render
   *  through resolveEmblem() so those still draw a stable shape. */
  emblem?: string | null;
  isPlayer: boolean;
  /** When true, this faction's turn is driven by src/game/factionAI.ts
   *  instead of waiting for player input. Single-player only for v1. */
  isAI?: boolean;
  /** Tick at which the AI last ran a decision cycle for this faction.
   *  Used to throttle AI evaluations to AI_DECISION_INTERVAL. */
  lastAIDecisionTick?: number;

  /** Engine acceleration in game-units / tick², used by every ship this
   *  faction owns for torch transfers. Higher = faster trips between
   *  bodies AND lower trip-time Δv (peak velocity scales as √(a·d)).
   *  Defaults to DEFAULT_ENGINE_ACCEL (≈ 0.05g); intended to grow with
   *  engine research over the game's lifespan. Stored per-faction so
   *  research advances independently. */
  engineG?: number;
}

/**
 * A single AI decision entry — what the AI did, when, and a one-line
 * human-readable description for the activity feed.
 */
export interface AIActivityEntry {
  id: string;
  tick: number;
  factionId: string;
  message: string;
  kind: 'build' | 'deploy' | 'transfer' | 'research' | 'collector' | 'upgrade' | 'dyson' | 'idle';
}

/**
 * Build order: a ship under construction at a body
 */
export interface BuildOrder {
  id: string;
  bodyId: string;                       // where the ship is being built
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
  ownedBy: string;                      // faction that ordered it
  startTick: number;                    // tick when construction started
  completeTick: number;                 // tick when ship launches to orbit
  shipName: string;                     // name for the new ship
  /** Icon variant picked at build time. Copied to Ship.iconVariant
   *  when the build completes. Undefined falls back to the class default. */
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
  /** MP unlimited queue: 'building' = occupying a slot (progress bar),
   *  'waiting' = queued beyond concurrency, promoted FIFO server-side
   *  when a slot frees. Undefined (SP / legacy rows) means building. */
  status?: 'building' | 'waiting';
  /** Snapshot of the active design's parts at queue time (MP only).
   *  Lets the queue row show the loadout the ship will launch with —
   *  which may differ from the CURRENTLY active design if it changed
   *  after this order was placed. Undefined = bare hull. */
  parts?: string[];
  /** Rush construction (DESIGN-fleet-economy §3): how many times this
   *  order has been rushed (each rush paid the ship's price again and
   *  halved the remaining time). MP only; undefined = never rushed. */
  rushCount?: number;
  /** A rush roll came up bad — this hull will be delivered at HALF
   *  health. Sticky (can't get worse, can't be undone). MP only. */
  botched?: boolean;
}

/**
 * A saved ship design: hull class + parts loadout + icon variant.
 * Multiplayer only (server table game_ship_designs, migration 0033).
 * One design per (player, class) may be active; BUILD snapshots the
 * active design's parts onto the order at queue time.
 */
export interface ShipDesign {
  id: string;
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  name: string;
  /** Part ids (ShipPartId in src/game/shipParts.ts). Empty = bare hull. */
  parts: string[];
  iconVariant?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S';
  isActive: boolean;
  createdAtMs: number;
}

/**
 * One row of the curated build list (ship-builder redesign, migration
 * 0045). Exactly one of the fields is set: `designId` points at a saved
 * ShipDesign the player wants to build; `bareClass` is a stock hull with
 * no parts. The BuildPanel renders these in order as buildable rows.
 */
export interface BuildListEntry {
  designId?: string;
  bareClass?: 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';
}

/**
 * A captain (DESIGN-captains.md): named persistent officer who OWNS a
 * ship's veterancy. ship_id null = in the bank; status 'lost' = went down
 * with the ship (memorial). Multiplayer only.
 */
export interface Captain {
  id: string;
  name: string;
  avatarId: string | null;
  bio: string | null;
  rank: number;
  traits: string[];
  shipId: string | null;
  status: 'active' | 'lost';
  createdAtTick: number;
  lostAtTick: number | null;
  /** Tick the player deliberately put this captain in reserve (migration
   *  0051). Non-null means the server's auto-assign pass will leave them
   *  in the bank; null means they arrived on their own (starting
   *  allotment or a rescue) and may be auto-posted to a captainless hull. */
  benchedAtTick: number | null;
}

/**
 * Player/faction resources (stubbed global pool)
 */
export interface FactionResources {
  fuel: number;
  ore: number;
  credits: number;
  science: number;
}

/**
 * Settlement: city or orbital station that extracts a body's resources
 * into a local stockpile. Freighters carry stockpile to the global pool.
 */
export type SettlementType = 'city' | 'station';

export interface Settlement {
  id: string;
  type: SettlementType;
  name: string;
  bodyId: string;                     // body it's on (city) or orbits (station)
  ownedBy: string;                    // faction id

  hp: number;
  maxHp: number;

  population: number;                 // starts at 1, +1 per growth interval
  lastGrowthTick: number;             // tick when population last grew
  lastCombatTick?: number;            // tick when this settlement last returned fire
  lastDamagedTick?: number;           // tick when this settlement last TOOK damage
  lastTargetId?: string;              // ship this station engaged on its last volley

  surfaceAngle?: number;              // city: angle on body surface (radians)
  orbit?: OrbitElements;              // station: orbit around body

  // Local stockpile — extracted resources awaiting freighter pickup
  stockpile: { fuel: number; ore: number; credits: number; science: number };

  lastHarvestTick: number;            // tick when stockpile last grew

  /** Collector network endpoint. When true, this settlement can receive
   *  freighter trade-route dropoffs AND it counts toward the empire's
   *  "has at least one collector" gate for the background stockpile
   *  auto-drain. Capitals start with this; everything else has to build
   *  one (high cost, see COLLECTOR_COST in src/game/settlements.ts). */
  hasCollector?: boolean;
  /** Tick this collector was constructed at, surfaced in the UI as a
   *  build date. undefined for the capital's free starting collector. */
  collectorBuiltTick?: number;

  /** Per-building level counters. Missing key = level 0.
   *  Cities can host forge / mint / lab; stations can host weapons /
   *  shipyard. Effects compound additively per level via the helpers
   *  in src/game/settlements.ts — see BUILDING_DEFS for the catalog. */
  buildings?: Partial<Record<BuildingKind, number>>;
  /** Orbital shield pool — absorbs damage BEFORE hp and regenerates.
   *  Server-authoritative (worker/room.js resolveShields); 0/0 means no
   *  shield generator has been built. */
  shieldHp?: number;
  shieldHpMax?: number;
  /** Single in-flight building upgrade for this settlement. Only one
   *  at a time per settlement — finish or cancel before queueing
   *  another. Cleared by the per-tick completion loop in
   *  advanceToTick once completeTick is reached. */
  buildingQueue?: SettlementBuildOrder;
}

/**
 * Kinds of upgrade buildings that can be queued at a settlement.
 * City-only: forge / mint / lab.  Station-only: weapons / shipyard.
 */
export type BuildingKind =
  | 'forge' | 'mint' | 'lab' | 'weapons' | 'shipyard'
  // Trajectory Control Thrusters — only buildable on rogue asteroid
  // bodies (type='asteroid'). When present, the asteroid's owning
  // faction can target another body and crash this one into it via
  // the RAM action. Single-level, present/absent.
  | 'trajectory_thrusters'
  // Orbital Shields — a REGENERATING pool in front of structure. Unlocked
  // by Armor 3 ("Hardened Settlements"). CITIES ONLY (per Lorne): ground
  // is what you protect, orbit is what you contest, and a shielded
  // station would let a player fortify orbit itself.
  | 'shields';

/**
 * One in-flight upgrade at a settlement. The "ship build queue"
 * pattern (see BuildOrder above) for the settlement-buildings system.
 */
export interface SettlementBuildOrder {
  id: string;
  settlementId: string;
  kind: BuildingKind;
  targetLevel: number;   // level the settlement will be at on completion
  startTick: number;
  completeTick: number;
}

/**
 * Trade route assigned to a freighter. The freighter runs origin → dest
 * (a settlement with a stockpile, e.g. a city) → (a collector) and back
 * indefinitely until the player cancels it. Auto-drain still flows in
 * the background; an active route layers a multiplier on top of that
 * base rate.
 *
 * NOTE: data shape only this turn. The execution loop, on-map
 * rendering, and piracy-on-death cargo drop land in the next pass —
 * the field exists now so the rest of the code can compile against it
 * and the lobby/load-save flows persist routes across reloads.
 */
export interface TradeRoute {
  id: string;
  ownedBy: string;          // faction running the route
  shipId: string;           // the freighter assigned (must be ownedBy)
  originBodyId: string;     // settlement we pick up from
  destBodyId: string;       // terraformed world / raw world / Sol we drop off at
  status: 'outbound' | 'returning' | 'paused';
  /** Route taxonomy (DESIGN-terraforming) — destination decides it:
   *  logistics hauls stockpile home, terraform feeds a raw world's
   *  meter, dyson supplies the sphere. Optional: SP routes predate it. */
  kind?: 'logistics' | 'terraform' | 'dyson';
  /** Cargo currently sitting in the freighter's hold. Captured by the
   *  killer's pool if the freighter dies en route. */
  cargo: { fuel: number; ore: number; credits: number; science: number };
  createdAtTick: number;
  /** STANDING TRADE ROUTE to another player (MP only): the faction on the
   *  other side of the deal. When set, `destBodyId` is THEIR world — so
   *  nothing may test it against "do I hold that body". Undefined on a
   *  self-haul route (logistics / terraform / dyson) and in SP. */
  counterpartyFactionId?: string;
  /** The trade agreement this route fulfils, when it's a standing deal. */
  agreementId?: string;
  /** Goods handed over per completed loop, on a standing deal. */
  perRun?: { metal: number; fuel: number; credits: number; science: number };
  /** How many loops this standing route has delivered. */
  loopsCompleted?: number;
}

/**
 * Per-faction tech progress (forward-declared; the canonical shape lives
 * in src/game/techs.ts). `queue` is optional so callers that haven't been
 * updated to the queue model keep type-checking.
 */
export interface FactionTechStateBase {
  levels: Record<string, number>;
  researching: string | null;
  progress: number;
  queue?: string[];
}

/** Where an EventLog row's "take me there" button should send the
 *  camera. Resolved from the chronicle event's body_id / ship_id.
 *
 *  The ship variant carries the event's body id TOO. The most-reported
 *  events are deaths, and a dead ship is gone from client state — with
 *  only a shipId to go on, "take me there" silently hid itself on
 *  exactly the rows players most want to jump to. The body is where it
 *  happened, and it still exists. */
export type ChronicleFocus =
  | { kind: 'body'; bodyId: string }
  | { kind: 'ship'; shipId: string; bodyId?: string };

/** Edit state for an EventLog row's player-authored flavor (Phase 3). */
export interface ChronicleEditMeta {
  /** Chronicle entry id — the target of the PATCH .../chronicle/:id/flavor. */
  entryId: string;
  /** True when a custom flavor override is currently set. */
  isOverride: boolean;
  /** Display name of the faction that last edited, or null. Drives the
   *  "— rewritten by X" attribution footer. */
  editedByName: string | null;
  /** Whether the local player may edit this event (party to it, or host). */
  canEdit: boolean;
}

/**
 * Complete game state snapshot
 */
export interface GameState {
  currentTick: number;
  bodies: Body[];
  ships: Ship[];
  fleets: Fleet[];
  factions: Faction[];
  settlements: Settlement[];           // cities and orbital stations
  orders: ManeuverNode[];              // all maneuvers in the game
  buildOrders: BuildOrder[];           // ships under construction
  resources: Record<string, FactionResources>; // factionId → resources
  factionTech: Record<string, FactionTechStateBase>; // factionId → tech progress
  /** Fleet upkeep (DESIGN-fleet-economy §1, MP only): the player's
   *  per-tick maintenance bill (senate multiplier folded in server-side).
   *  TopBar shows NET income = delivered − upkeep. Undefined in SP. */
  fleetUpkeep?: {
    credits: number; ore: number; multiplier: number;
    /** Per-class breakdown, server-computed. Not mirrored client-side:
     *  the rates are editable in the admin Editor, so a local copy would
     *  quote a price the tick no longer charges. */
    byClass?: Array<{
      shipClass: string; count: number;
      creditsEach: number; oreEach: number;
      credits: number; ore: number;
    }>;
    /** Damage multiplier applied while in arrears (config-driven). */
    arrearsDamageMult?: number;
  };
  /** Standing upkeep debt. Any positive value = the whole fleet fights
   *  at −25% damage until income clears it. Undefined/zeros in SP. */
  fleetArrears?: { credits: number; ore: number };
  /** Terraform payload targets (DESIGN-terraforming, MP only) — from
   *  game config, host-tunable per lobby. The world-menu meter quotes
   *  delivered/target from this, never a hardcoded 124. Undefined in SP. */
  terraformConfig?: { costMetal: number; costCredits: number; durationTicks: number };
  /**
   * Senate sanctions in force this tick, game-wide.
   *
   * MP only. `ticksLeft` is computed SERVER-side against the
   * authoritative tick — do not recompute it from currentTick, which
   * lags by however stale the last poll is and would make the countdown
   * jitter. Empty array when nothing is in force.
   */
  senateSanctions?: Array<{
    /** 'war_authorization' | 'trade_embargo' | 'production_sanction' */
    kind: string;
    targetFactionId: string;
    untilTick: number;
    ticksLeft: number;
  }>;
  /**
   * What a hull actually costs this player, as a breakdown.
   *
   * MP only. `mult` is the product the server charges at queue time; the
   * parts exist so the build menu can say WHY the price moved — a
   * `ship_build_cost_multiplier` law used to halve the charge invisibly
   * because the menu rendered SHIP_CLASSES base prices and nothing else.
   * Undefined in SP (which applies its own buildCostModifier directly).
   */
  buildCost?: {
    /** Host's ship_cost_mult config dial. */
    config: number;
    /** Active senate ship_build_cost_multiplier law, 1 when none. */
    law: number;
    /** Construction tech discount, −5%/level floored at 0.25. */
    tech: number;
    /** Senate rush_cost_multiplier — applies ONLY to rushing, and is
     *  therefore deliberately NOT folded into `mult`. */
    rush: number;
    constructionLevel: number;
    /** config × law × tech. */
    mult: number;
  };
  /** Fog-FREE political claims: bodyId -> owning faction for every live
   *  settlement in the game. This is what region ownership shading reads
   *  — political borders are common knowledge even when the settlements
   *  themselves are outside sensor range. MP only; SP derives the same
   *  facts from its (unfogged) settlements array. */
  settlementClaims?: { bodyId: string; ownedBy: string }[];
  /** Senate slider laws currently in force ON THE VIEWING FACTION, as
   *  plain multipliers (tariff is a percent). Sent by /state each poll and
   *  resolved server-side, because a law can target one faction. MP only;
   *  undefined in SP, where every reader falls back to neutral. Without
   *  this the client quoted economy rates the tick then contradicted, and
   *  passed laws looked inert. */
  activeSliders?: {
    metalYieldMultiplier: number;
    goldYieldMultiplier: number;
    scienceYieldMultiplier: number;
    shipBuildCostMultiplier: number;
    fleetUpkeepMultiplier: number;
    combatDamageMultiplier: number;
    rushCostMultiplier: number;
    tradeTariffPct: number;
  };
  /** Accepted trade agreements that are waiting on a freighter of MINE
   *  before anything ships. Accepting a deal moves no goods — each side
   *  has to assign a hauler — and until this existed there was no signal
   *  anywhere on the main screen that the ball was in your court. MP
   *  only; SP has no inter-player trade. */
  tradesAwaitingShip?: {
    agreementId: string;
    partnerFactionId: string;
    partnerName?: string;
    /** What MY side owes per completed run. */
    myGoods: { metal: number; fuel: number; credits: number; science: number };
    createdAtTick: number;
  }[];
  /** Active physical trade-delivery legs involving the player (either
   *  direction). MP only; SP has no inter-player trade. Sourced from the
   *  server state payload each poll — never mutated locally. */
  tradeDeliveries?: {
    id: string; tradeId: string;
    senderFactionId: string; recipientFactionId: string;
    shipId: string | null; status: string;
    pickupBodyId: string | null; destBodyId: string | null;
    metal: number; fuel: number; gold: number; science: number;
    loaded: boolean;
  }[];
  /** Research gating is ON for this match (see src/game/researchUnlocks.ts).
   *  False for single-player and for multiplayer games seeded before
   *  migration 0040 — both grandfather every feature unlocked, so no UI
   *  should grey anything out. Mirrors games.gating_enabled. */
  gatingEnabled?: boolean;
  combatLog: string[];                 // recent combat events (machine-truth headlines)
  /** Prose flavor for each combatLog entry, parallel-indexed. Resolved
   *  from the structured chronicle event via src/game/flavorEngine.ts.
   *  null where the event kind has no flavor bank or its data couldn't
   *  be enriched (the EventLog falls back to echoing the headline).
   *  Multiplayer only — the SP sim emits pre-formatted strings without
   *  structured payloads, so SP leaves this undefined. */
  chronicleFlavor?: (string | null)[];
  /** Focus target for each combatLog entry, parallel-indexed. Lets the
   *  expanded EventLog row offer a "take me there" button that centers
   *  the camera on the body/ship the event happened at. null where the
   *  event has no locatable target (e.g. a senate vote). Multiplayer
   *  only — built from the structured chronicle event's body_id/ship_id
   *  in MultiplayerGameProvider. The EventLog still validates the target
   *  still exists at click time before focusing. */
  chronicleFocus?: (ChronicleFocus | null)[];
  /** Per-entry edit state (Phase 3): override flag, attribution, and
   *  whether the local player can edit. Parallel-indexed with combatLog.
   *  Multiplayer only. */
  chronicleMeta?: (ChronicleEditMeta | null)[];
  /** Machine-readable chronicle kind per entry, parallel-indexed with
   *  combatLog. Drives the pending-FX queue (src/render/pendingFx.ts). */
  lastHarvestTick: number;             // tick when resources were last collected
  /** Wall-clock epoch (ms) the server expects to fire the next tick, and
   *  the configured tick interval. Multiplayer only — the server drives the
   *  clock, so the TopBar can show a live "next tick in Ns" countdown.
   *  Undefined in single-player (the local sim loop owns the cadence). */
  nextTickAt?: number | null;
  tickIntervalMs?: number;
  /** Active trade routes (freighter ↔ collector). Empty when no
   *  freighter has been assigned. Persisted with the save. Currently
   *  data-only — the execution loop lands next turn. */
  tradeRoutes?: TradeRoute[];
  /** The local player's ship-design library (ship designer, §2 of the
   *  identity-economy release). Multiplayer only — populated from
   *  /state's ship_designs; undefined in single-player (SP frozen). */
  shipDesigns?: ShipDesign[];
  /** The local player's curated build list (ship-builder redesign,
   *  migration 0045): the loadouts they've assigned to the build panel,
   *  in order. Each entry references a saved design OR a bare hull class.
   *  Global across every owned shipyard. Multiplayer only; undefined/empty
   *  falls back to a client-derived default (unlocked bare hulls + active
   *  designs) in the BuildPanel. */
  buildList?: BuildListEntry[];
  /** The local player's captain roster — bank + assigned + memorial
   *  (DESIGN-captains.md). Multiplayer only. */
  captains?: Captain[];
  aiActivityLog?: AIActivityEntry[];   // optional — rolling log of recent AI decisions

  /** Faction ids the local player is allied with — active defense-pact
   *  or intel-share treaties. Multiplayer only, populated from /state.
   *  Allies share sensor coverage: their ships/settlements count as the
   *  player's own for fog of war (computeVisibility / factionSensorRings
   *  treat these ids as friendly). Empty/undefined in single-player,
   *  which has no diplomacy. */
  alliedFactionIds?: string[];

  /** Faction ids the local player has ANY active peace treaty with — NAP,
   *  defense pact, or intel share. Superset of alliedFactionIds (which is
   *  the two pacts that also share vision). Used by threat detection so
   *  an inbound ship from a NAP partner doesn't get painted as a threat
   *  even though they don't share sensors with you — peace is peace.
   *  Empty/undefined in single-player. */
  peaceFactionIds?: string[];
  /** Every active at-peace pair in the game (nap / defense pact), as
   *  unordered 'a|b' keys in the same id space as Ship.ownedBy. Unlike
   *  peaceFactionIds (player-centric), this covers THIRD-party pairs -
   *  combat FX uses it so two co-located allies are never drawn
   *  shooting each other. */
  pactPairs?: string[];

  // Match shape — populated in single-player by setup, in multiplayer by
  // the server. The match ends when status flips to 'completed', either
  // via a host-initiated abandon or when one of the three victory
  // conditions in src/game/victory.ts fires.
  status?: 'lobby' | 'active' | 'completed' | 'abandoned';
  winnerFactionId?: string;            // set when status flips to 'completed'
  /** The three live paths are engineering / chancellor / domination
   *  (2026-08 rework). Retired + legacy labels stay in the union for
   *  back-compat with games completed before the rework.
   *  'chancellor' is the server-only senate election win — fires when
   *  a chancellor_vote bill passes (see worker/senate.js). */
  victoryType?: 'engineering' | 'chancellor' | 'domination'
    | 'military' | 'science' | 'hegemony' | 'wealth' | 'tiebreak';

  /** Dyson-Sphere megaproject state. Present only after a faction has
   *  begun construction at a Sol station; completing it triggers
   *  Engineering Victory. See src/game/dysonSphere.ts. */
  dysonSphere?: DysonSphereState;
}

/**
 * Dyson Sphere progress tracker. Lives at game-level rather than on a
 * specific settlement because the project is the match-defining
 * megaproject — destruction nukes the entire object and frees the
 * slot for the next builder.
 */
export interface DysonSphereState {
  /** Faction id of the empire whose Sol station is hosting the build. */
  /** Null while the sphere sits ABANDONED — foundation destroyed,
   *  progress preserved, waiting for the next claimant. */
  controllerFactionId: string | null;
  /** Settlement id of the Sol station serving as the foundation. */
  foundationSettlementId: string;
  /** Per-resource accumulated total. Sum across all four = HP. */
  accumulated: { fuel: number; ore: number; credits: number; science: number };
  /** Per-resource target. Sum across all four = maxHp. */
  target: { fuel: number; ore: number; credits: number; science: number };
  /** Current hit-points. Equal to sum(accumulated) — duplicated so combat
   *  damage can be applied without re-reading the deposit map. */
  hp: number;
  /** Maximum hit-points. Equal to sum(target) — cached so we don't sum
   *  every render. */
  maxHp: number;
  /** Tick the foundation was laid; surfaced in the UI / chronicle. */
  startedAtTick: number;
}

/**
 * Single-player setup config — captured from the SinglePlayerSetup screen
 * and consumed by setupSinglePlayer() to seed an initial GameState.
 */
export interface SinglePlayerConfig {
  player: {
    factionName: string;
    color: string;
    startingBodyId: string;
  };
  aiOpponents: Array<{
    factionName: string;
    color: string;
    startingBodyId: string;
  }>;
  mapSeed?: string;                    // optional seed for repeatability
}

/**
 * Camera viewport state
 */
export interface CameraState {
  x: number;                            // center position x
  y: number;                            // center position y
  scale: number;                        // zoom level (pixels per game unit)
  zoomLevel: 1 | 2 | 3;                 // discrete zoom mode
  focusedBodyId?: string;               // if set, camera centers on this body and shows local SOI
}

/**
 * UI state for map interaction
 */
export interface MapUIState {
  selectedShipId?: string;
  selectedBodyId?: string;
  hoveredBodyId?: string;
  targetSelectionMode?: boolean;        // true when picking a transfer target on the map
  /** Shift-click group selection, shared by the map and the Fleet panel
   *  so one list drives both. Independent of `selectedShipId`: a plain
   *  click selects ONE ship and clears this; shift-click builds a group
   *  to move or give common orders. Array (not Set) to keep MapUIState
   *  plainly serializable like every other field here. */
  selectedShipIds?: string[];
}

/**
 * Trajectory arc: one segment of a ship's path around a single parent
 */
export interface TrajectoryArc {
  orbit: OrbitElements;
  tStart: number;                       // start tick
  tEnd: number;                         // end tick
  endReason: 'exit' | 'enter' | 'node' | 'budget';
}

/**
 * Full trajectory: sequence of arcs as ship moves through SOIs
 */
export interface Trajectory {
  arcs: TrajectoryArc[];
}

/**
 * Rendering hints for maneuver visualization
 */
export interface ManeuverRenderHints {
  currentOrbitColor: string;            // cyan
  plannedBurnColor: string;             // amber dashed
  committedBurnColor: string;           // amber solid
  captureColor: string;                 // green
  escapeColor: string;                  // red
}
