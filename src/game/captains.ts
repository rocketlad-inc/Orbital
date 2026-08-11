// ============================================================
// Captains (DESIGN-captains.md) — client display metadata + the
// trait-effect mirror. KEEP TRAIT IDS/EFFECTS IN SYNC with
// worker/captains.js — the server is authoritative for combat/repair/
// cargo/sensors; the client applies hpMul (display cap) and accelMul
// (torch plans are client-computed and server-trusted).
// ============================================================

export interface CaptainTraitDef {
  name: string;
  icon: string;
  blurb: string;
  /** Client-applied multipliers (subset of the server's). */
  hpMul?: number;
  accelMul?: number;
  dmgMul?: number;
}

export const CAPTAIN_TRAITS: Record<string, CaptainTraitDef> = {
  // dmgMul mirrors the server's traitMul(_,'dmgMul') in worker/room.js.
  // It was blurb-only until the ship card started quoting real expected
  // damage — the number silently omitted the Gunner bonus.
  gunner:        { name: 'Gunner',        icon: '🎯', blurb: '+10% weapon damage', dmgMul: 1.10 },
  bulwark:       { name: 'Bulwark',       icon: '🛡', blurb: '+10% max hull', hpMul: 1.10 },
  wrench:        { name: 'Wrench',        icon: '🔧', blurb: '+50% repair rate' },
  voidrunner:    { name: 'Voidrunner',    icon: '💨', blurb: '+10% engine acceleration', accelMul: 1.10 },
  pathfinder:    { name: 'Pathfinder',    icon: '🧭', blurb: '+15% sensor range' },
  quartermaster: { name: 'Quartermaster', icon: '📦', blurb: '+25% cargo hold' },
  colonist:      { name: 'Colonist',      icon: '🏗', blurb: '−20% settlement founding cost' },
};

export const AVATAR_IDS = ['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11','a12'] as const;
export type AvatarId = typeof AVATAR_IDS[number];

/** Experience tier from rank — shared by the fleet Captain column and the
 *  bank (was FleetPanel-local). Each confirmed kill = +1 rank. */
export function rankTier(rank: number): string {
  if (rank >= 10) return 'Ace';
  if (rank >= 6) return 'Elite';
  if (rank >= 3) return 'Veteran';
  if (rank >= 1) return 'Regular';
  return 'Rookie';
}

/** Multiplier over a trait-id list for a client-applied effect key. */
export function traitMul(traits: string[] | undefined, key: 'hpMul' | 'accelMul' | 'dmgMul'): number {
  let m = 1;
  for (const t of traits ?? []) {
    const v = CAPTAIN_TRAITS[t]?.[key];
    if (v) m *= v;
  }
  return m;
}

/** One-line trait summary for tooltips/rows: "🎯 Gunner — +10% weapon damage". */
export function traitSummary(traits: string[] | undefined): string {
  return (traits ?? [])
    .map(t => CAPTAIN_TRAITS[t])
    .filter(Boolean)
    .map(d => `${d.icon} ${d.name} — ${d.blurb}`)
    .join(' · ');
}

/**
 * The same information, compact enough to sit inside a <select> option.
 *
 * Drops the em-dash between name and effect ("💨 Voidrunner +10% engine
 * acceleration"), because in a dropdown the row is already one item and
 * the dash just eats width. Returns a plain string with no markup: a
 * native <option> renders text only, which is the whole constraint.
 *
 * Returns '' for an untraited captain rather than a placeholder — the
 * caller decides how to say "nothing", since "no trait" reads
 * differently in a list of choices than it does on a card.
 */
export function traitBrief(traits: string[] | undefined): string {
  return (traits ?? [])
    .map(t => CAPTAIN_TRAITS[t])
    .filter(Boolean)
    .map(d => `${d.icon} ${d.name} ${d.blurb}`)
    .join(' · ');
}
