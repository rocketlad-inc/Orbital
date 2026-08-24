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
}

export const MEGASTRUCTURES: Record<MegastructureKind, MegastructureDef> = {
  warp_gate: {
    kind: 'warp_gate',
    label: 'Warp Gate',
    family: 'fixed',
    feature: 'mega.warpGate',
    cost: { metal: 5000, credits: 7000 },
    radius: 9,
    color: '#7fd4ff',
    glyph: '◎',
    blurb: 'Two-way transit to exactly one partner. Anyone may use it.',
  },
  weapons_station: {
    kind: 'weapons_station',
    label: 'Weapons Station',
    family: 'fixed',
    feature: 'mega.weaponsStation',
    cost: { metal: 7000, credits: 5000 },
    radius: 8,
    color: '#ff8a6b',
    glyph: '✷',
    blurb: 'Destroyer-tier guns with reach into transit lanes. Upgradable.',
  },
  gravity_sink: {
    kind: 'gravity_sink',
    label: 'Gravity Sink',
    family: 'fixed',
    feature: 'mega.gravitySink',
    cost: { metal: 4000, credits: 4000 },
    radius: 7,
    color: '#b98cff',
    glyph: '◌',
    blurb: 'Holds crossing ships for 8 ticks. You choose who is caught.',
  },
  deep_array: {
    kind: 'deep_array',
    label: 'Deep Space Array',
    family: 'fixed',
    feature: 'mega.deepArray',
    cost: { metal: 3500, credits: 4500 },
    radius: 7,
    color: '#6ee7b7',
    glyph: '≋',
    blurb: 'A sensor bubble anywhere you can pay to put one.',
  },
  null_field: {
    kind: 'null_field',
    label: 'Null Field',
    family: 'fixed',
    feature: 'mega.nullField',
    cost: { metal: 4000, credits: 4000 },
    radius: 7,
    color: '#4a5f7a',
    glyph: '⊘',
    blurb: 'Blinds rival sensors inside its radius.',
  },
  mega_destroyer: {
    kind: 'mega_destroyer',
    label: 'Mega Destroyer',
    family: 'mobile',
    feature: 'mega.megaDestroyer',
    cost: { metal: 12000, credits: 8000 },
    radius: 12,
    color: '#ff5e5e',
    glyph: '✹',
    blurb: 'Strips the terraforming off a world. Cannot use gates.',
  },
  mobile_foundry: {
    kind: 'mobile_foundry',
    label: 'Mobile Foundry',
    family: 'mobile',
    feature: 'mega.mobileFoundry',
    cost: { metal: 9000, credits: 11000 },
    radius: 11,
    color: '#ffb84d',
    glyph: '⬢',
    blurb: 'A shipyard that moves. Four hulls at once, wherever it is.',
  },
};

export const MEGASTRUCTURE_KINDS = Object.keys(MEGASTRUCTURES) as MegastructureKind[];

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
