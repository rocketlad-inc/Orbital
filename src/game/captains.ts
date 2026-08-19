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

// 48 imported portraits (public/portraits, via scripts/import-portraits.js).
// Legacy a1-a12 still resolve — CaptainAvatar maps a{n} -> p{n} — so
// captains created before the import are not stranded on the old busts.
// 122 imported portraits (public/portraits, via scripts/import-portraits.js).
// Legacy a1-a12 still resolve — CaptainAvatar maps a{n} -> p{n} — so
// captains created before the import are not stranded on the old busts.
export const AVATAR_IDS = ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10','p11','p12','p13','p14','p15','p16','p17','p18','p19','p20','p21','p22','p23','p24','p25','p26','p27','p28','p29','p30','p31','p32','p33','p34','p35','p36','p37','p38','p39','p40','p41','p42','p43','p44','p45','p46','p47','p48','p49','p50','p51','p52','p53','p54','p55','p56','p57','p58','p59','p60','p61','p62','p63','p64','p65','p66','p67','p68','p69','p70','p71','p72','p73','p74','p75','p76','p77','p78','p79','p80','p81','p82','p83','p84','p85','p86','p87','p88','p89','p90','p91','p92','p93','p94','p95','p96','p97','p98','p99','p100','p101','p102','p103','p104','p105','p106','p107','p108','p109','p110','p111','p112','p113','p114','p115','p116','p117','p118','p119','p120','p121','p122'] as const;

/**
 * Pick a DIFFERENT portrait at random.
 *
 * The avatar button used to step +1 through the list. That was a way to
 * browse all twelve; across 122 it is a way to click sixty times looking
 * for a face you already saw. Random reroll finds something you like in a
 * few taps, which is what the button is actually for.
 *
 * One definition, used by both the Fleet panel and the Ship panel, so the
 * two can never disagree about what the button does.
 */
export function rerollAvatarId(current?: string | null): AvatarId {
  // No single-entry guard: AVATAR_IDS is a const tuple, so tsc knows its
  // length is 122 and rejects the comparison as dead. The fallback below
  // covers a one-portrait set anyway.
  for (let i = 0; i < 12; i++) {
    const pick = AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
    if (pick !== current) return pick;
  }
  // Astronomically unlikely; fall back to a definite change rather than
  // returning the same face and reading as a dead button.
  const cur = AVATAR_IDS.indexOf((current ?? '') as AvatarId);
  return AVATAR_IDS[(cur + 1 + AVATAR_IDS.length) % AVATAR_IDS.length];
}
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
