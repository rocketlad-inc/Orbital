// ============================================================
// Megastructures — client mirror of worker/megastructures.js.
//
// KEEP THE CATALOGUE IN SYNC. The worker is a separate Cloudflare bundle
// and cannot import this file, so the seven entries exist twice and
// megastructureMirrors.test.ts parses both. A drifted cost here quotes a
// price the server will not honour, which is the exact failure the
// designer/yard split produced with hull damage.
//
// MULTIPLAYER ONLY. SP has no megastructures and never sends any.
// ============================================================

export type MegastructureKind =
  | 'warp_gate' | 'weapons_station' | 'gravity_sink'
  | 'deep_array' | 'null_field'
  | 'mega_destroyer' | 'mobile_foundry';

/** Fixed structures switch on where they stand. Mobile ones launch as a
 *  hull when finished and the site is spent. */
export type MegastructureFamily = 'fixed' | 'mobile';

export interface MegastructureDef {
  kind: MegastructureKind;
  label: string;
  family: MegastructureFamily;
  /** Research gate — see researchUnlocks.ts. */
  feature: string;
  cost: { metal: number; credits: number };
  /** Body radius the site is drawn at. */
  radius: number;
  color: string;
  glyph: string;
  blurb: string;
  /** What it DOES, mirrored from the worker catalogue. Ranges are in
   *  world units before system_scale. */
  effect: {
    range?: number;
    damagePerTick?: number;
    targets?: number;
    holdTicks?: number;
    sensorRange?: number;
    blindRange?: number;
    buildSlots?: number;
  };
}

export const MEGASTRUCTURES: Record<MegastructureKind, MegastructureDef> = {
  warp_gate: {
    kind: 'warp_gate',
    label: 'Warp Gate',
    family: 'fixed',
    feature: 'mega.warpGate',
    cost: { metal: 5000, credits: 7000 },
    radius: 1.9,
    color: '#7fd4ff',
    glyph: '◎',
    blurb: 'Two-way transit to exactly one partner. Anyone may use it.',
    effect: {},
  },
  weapons_station: {
    kind: 'weapons_station',
    label: 'Weapons Station',
    family: 'fixed',
    feature: 'mega.weaponsStation',
    cost: { metal: 7000, credits: 5000 },
    radius: 1.6,
    color: '#ff8a6b',
    glyph: '✷',
    blurb: 'Destroyer-tier guns with reach into transit lanes, and it fires on three at once.',
    effect: { range: 700, damagePerTick: 22.5, targets: 3 },
  },
  gravity_sink: {
    kind: 'gravity_sink',
    label: 'Gravity Sink',
    family: 'fixed',
    feature: 'mega.gravitySink',
    cost: { metal: 4000, credits: 4000 },
    radius: 1.5,
    color: '#b98cff',
    glyph: '◌',
    blurb: 'Holds crossing ships for 8 ticks. You choose who is caught.',
    effect: { range: 500, holdTicks: 8 },
  },
  deep_array: {
    kind: 'deep_array',
    label: 'Deep Space Array',
    family: 'fixed',
    feature: 'mega.deepArray',
    cost: { metal: 3500, credits: 4500 },
    radius: 1.5,
    color: '#6ee7b7',
    glyph: '≋',
    blurb: 'A sensor bubble anywhere you can pay to put one.',
    effect: { sensorRange: 1100 },
  },
  null_field: {
    kind: 'null_field',
    label: 'Null Field',
    family: 'fixed',
    feature: 'mega.nullField',
    cost: { metal: 4000, credits: 4000 },
    radius: 1.4,
    color: '#4a5f7a',
    glyph: '⊘',
    blurb: 'Blinds rival sensors inside its radius.',
    effect: { blindRange: 700 },
  },
  mega_destroyer: {
    kind: 'mega_destroyer',
    label: 'Mega Destroyer',
    family: 'mobile',
    feature: 'mega.megaDestroyer',
    cost: { metal: 12000, credits: 8000 },
    radius: 1.8,
    color: '#ff5e5e',
    glyph: '✹',
    blurb: 'Strips the terraforming off a world. Cannot use gates.',
    effect: {},
  },
  mobile_foundry: {
    kind: 'mobile_foundry',
    label: 'Mobile Foundry',
    family: 'mobile',
    feature: 'mega.mobileFoundry',
    cost: { metal: 9000, credits: 11000 },
    radius: 1.7,
    color: '#ffb84d',
    glyph: '⬢',
    blurb: 'A shipyard that moves. Four hulls at once, wherever it is.',
    effect: { buildSlots: 4 },
  },
};

export const MEGASTRUCTURE_KINDS = Object.keys(MEGASTRUCTURES) as MegastructureKind[];

/**
 * Hull points on a structure, uniform across kinds.
 *
 * Taking one used to be a presence check — park an armed hull, have
 * nobody else's there, done. Nothing that costs twelve thousand metal
 * should change hands because a corvette drifted past it, so a site is
 * now something you break before you board.
 *
 * Uniform at 3000 on purpose: a Mega Destroyer scaffold is no tougher
 * than a null field because neither is armoured. What makes one hard to
 * take is the fleet its owner keeps on it.
 *
 * KEEP IN SYNC with worker/megastructures.js — megastructureMirrors
 * parses both.
 */
export const MEGA_MAX_HP = 3000;

/** How long a gate trip takes, as a fraction of the ordinary burn. A
 *  gate flings you rather than teleporting you: a ten-tick crossing
 *  takes three, and the hull is really in flight for them — visible,
 *  interceptable, and catchable by a Gravity Sink like anything else.
 *  KEEP IN SYNC with worker/megastructures.js. */
export const GATE_TRANSIT_FRACTION = 0.25;

/** Ticks a gate crossing takes, given the ordinary burn between the two
 *  gates. Always at least one — a gate is fast, not instant. */
export function gateTransitTicks(normalTicks: number): number {
  const t = Number(normalTicks);
  if (!Number.isFinite(t) || t <= 0) return 1;
  return Math.max(1, Math.ceil(t * GATE_TRANSIT_FRACTION));
}

/** Below this fraction of max HP a structure can be boarded. */
export const MEGA_SEIZE_HP_FRAC = 0.2;

/** Points repaired per tick while no hostile armed hull is parked on it.
 *  This is what stops one corvette grinding a site down over two
 *  hundred unattended ticks: to take a structure you have to commit
 *  force and KEEP it there. */
export const MEGA_REGEN_PER_TICK = 12;

/** Can this structure be boarded right now, on hull damage alone? The
 *  other two conditions (your force present, no rival force) are about
 *  who is standing there and live in the card. */
/** Derelict and free to claim. An ANCIENT gate is also unowned and must
 *  stay unclaimable, so this asks for the abandonment stamp and a
 *  founder rather than just a missing owner. Mirrors
 *  worker/megastructures.js. */
export function isAbandoned(
  m: { abandonedAtTick: number | null; foundedByFactionId: string | null },
  ownedBy: string | undefined,
): boolean {
  return !ownedBy && m.abandonedAtTick != null && m.foundedByFactionId != null;
}

export function isBreached(m: { hp: number }): boolean {
  return m.hp <= MEGA_MAX_HP * MEGA_SEIZE_HP_FRAC;
}

/** Live state of one site, from the state payload's `megastructures`. */
export interface MegastructureState {
  bodyId: string;
  kind: MegastructureKind;
  status: 'building' | 'complete';
  accMetal: number;
  accCredits: number;
  costMetal: number;
  costCredits: number;
  partnerBodyId: string | null;
  foundedByFactionId: string | null;
  foundedAtTick: number;
  completedAtTick: number | null;
  /** Gravity Sink: faction ids allowed through. The OWNER is never in
   *  here — they always pass — so this is purely the list of other
   *  people you have waved past. */
  passFactionIds: string[];
  /** Hull points. Damaged by warships parked on it, repaired while
   *  nobody hostile is. At or below 20% it can be boarded. */
  hp: number;
  /** Weapons Station: the tick it last fired, and at what. Same pair
   *  ships and settlements carry, and read by the same FX layer. */
  lastCombatTick: number | null;
  lastTargetId: string | null;
  /** Set when the owning faction was eliminated. Derelict: unowned, and
   *  claimable by the first faction to put a ship in its orbit. */
  abandonedAtTick: number | null;
  /** Which of the three silhouettes the builder picked. Null renders as
   *  the default, so structures raised before the picker existed keep a
   *  valid look. */
  variant: 'A' | 'B' | 'C' | null;

}

/** 0..1. The WORSE of the two buckets — a site with all its metal and no
 *  credits is not half built in any sense that matters. Mirrors
 *  progressOf in worker/megastructures.js. */
export function progressOf(m: {
  accMetal: number; accCredits: number; costMetal: number; costCredits: number;
}): number {
  const pm = m.costMetal > 0 ? Math.min(1, m.accMetal / m.costMetal) : 1;
  const pc = m.costCredits > 0 ? Math.min(1, m.accCredits / m.costCredits) : 1;
  return Math.min(pm, pc);
}

export function remainingFor(m: {
  accMetal: number; accCredits: number; costMetal: number; costCredits: number;
}): { metal: number; credits: number } {
  return {
    metal: Math.max(0, m.costMetal - m.accMetal),
    credits: Math.max(0, m.costCredits - m.accCredits),
  };
}

/** Freighter loads still owed, at the given hold size. The number that
 *  actually tells a player how long this will take. */
export function loadsRemaining(
  m: { accMetal: number; accCredits: number; costMetal: number; costCredits: number },
  hold = 400,
): number {
  const r = remainingFor(m);
  return Math.ceil(r.metal / hold) + Math.ceil(r.credits / hold);
}

/**
 * What a structure DOES, in one line, from its own effect numbers.
 *
 * Derived rather than written out a second time. The picker is where a
 * player decides to spend a colony ship and thirty freighter runs, so
 * the figures it quotes have to be the figures the tick applies — and
 * the only way to guarantee that is to read them from the same place.
 * Ranges are quoted unscaled, matching how every other range in the UI
 * is written.
 */
export function effectSummary(kind: MegastructureKind): string {
  const e = MEGASTRUCTURES[kind].effect;
  switch (kind) {
    case 'warp_gate':
      return 'Two-way transit to one partner gate at a quarter of the normal '
        + 'burn. Anyone may use it.';
    case 'weapons_station':
      return `${e.damagePerTick} damage a tick to ${e.targets} targets at once, out to `
        + `${e.range} units — and it reaches ships in mid-burn.`;
    case 'gravity_sink':
      return `Pins crossing hulls for ${e.holdTicks} ticks within ${e.range} units. `
        + 'You choose who passes.';
    case 'deep_array':
      return `A ${e.sensorRange}-unit sensor bubble, nearly three times a station's reach.`;
    case 'null_field':
      return `Blinds rival sensors within ${e.blindRange} units. Only a hull `
        + 'in the same system sees through it.';
    case 'mega_destroyer':
      return 'Launches as a hull. Strips a world of terraforming and everything '
        + 'living on it. Crawls, and cannot use gates.';
    case 'mobile_foundry':
      return `Launches as a hull. ${e.buildSlots} build slots wherever it parks, `
        + 'and it makes a body buildable at all.';
    default:
      return '';
  }
}

/** Ticks a Mega Destroyer spends charging before it fires.
 *  KEEP IN SYNC with MEGA_STRIKE_CHARGE_TICKS in worker/actions.js —
 *  this is only what the panel counts down; the tick decides. */
export const MEGA_STRIKE_CHARGE_TICKS = 24;

/** The one thing a player most needs to weigh against the price. */
export function headlineFor(kind: MegastructureKind): string {
  switch (kind) {
    case 'warp_gate':       return 'Defeats distance';
    case 'weapons_station': return 'Denies an area';
    case 'gravity_sink':    return 'Stops a fleet';
    case 'deep_array':      return 'Sees everything';
    case 'null_field':      return 'Hides everything';
    case 'mega_destroyer':  return 'Ends a world';
    case 'mobile_foundry':  return 'A shipyard that moves';
    default:                return '';
  }
}
