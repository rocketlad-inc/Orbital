// ============================================================
// Faction emblems — the shape half of a faction's flag.
//
// A faction's identity is PRIMARY colour + SECONDARY trim + EMBLEM.
// Colour alone stopped scaling: eight empires on one scoreboard is
// eight swatches to tell apart at a glance, and the palette can't even
// promise they're all 90 units apart (see sim/colorClash.mjs). A shape
// reads instantly at any size and survives being printed in a Discord
// embed, a 12px chip, or a colourblind viewer's screen.
//
// IDS ARE OPAQUE AND PERMANENT. Never renumber, never repurpose — a
// stored 'anchor' must draw an anchor in every future version, because
// live factions carry these strings. Adding is free; changing is not.
//
// KEEP IN SYNC with EMBLEM_IDS in worker/emblems.js. The server
// validates picks against its own copy, so a client offering an emblem
// the server doesn't know would 400 on save.
// ============================================================

export type EmblemId =
  | 'anchor' | 'comet' | 'crown' | 'eye' | 'gear' | 'hammer'
  | 'helix' | 'key' | 'leaf' | 'moon' | 'mountain' | 'orbit'
  | 'phoenix' | 'pyramid' | 'ring' | 'shield' | 'skull' | 'spear'
  | 'star' | 'sun' | 'tower' | 'trident' | 'wave' | 'wolf'
  // Premium wing (Commander's Commission). Same permanence rule as the
  // free two dozen: a stored 'dragon' draws a dragon forever.
  | 'dragon' | 'kraken' | 'galaxy' | 'nova' | 'raven'
  | 'serpent' | 'swords' | 'atom' | 'hourglass' | 'compass';

/** Catalog order — drives the picker grid and the default rotation.
 *  24 entries against a max_players cap of 8 means uniqueness is always
 *  satisfiable, unlike the 8-colour palette. */
export const EMBLEM_IDS: EmblemId[] = [
  'star', 'sun', 'moon', 'comet', 'orbit', 'ring',
  'crown', 'shield', 'spear', 'trident', 'hammer', 'anchor',
  'skull', 'wolf', 'phoenix', 'eye', 'key', 'gear',
  'helix', 'leaf', 'wave', 'mountain', 'tower', 'pyramid',
];

/** The Commission's emblems. NOT in EMBLEM_IDS: the default rotation
 *  and the deterministic fallback both walk that array, and a default
 *  must never hand out (or a fallback silently draw) paid content on a
 *  free account. Validation accepts both lists; rotation only the free
 *  one. UI locks gate on this + is_premium; the SERVER re-checks the
 *  entitlement on every save. */
export const PREMIUM_EMBLEM_IDS: EmblemId[] = [
  'dragon', 'kraken', 'galaxy', 'nova', 'raven',
  'serpent', 'swords', 'atom', 'hourglass', 'compass',
];

/** Human labels for tooltips and the Herald's prose. */
export const EMBLEM_NAMES: Record<EmblemId, string> = {
  star: 'Star', sun: 'Sun', moon: 'Crescent', comet: 'Comet',
  orbit: 'Orbit', ring: 'Ringed World', crown: 'Crown', shield: 'Shield',
  spear: 'Spear', trident: 'Trident', hammer: 'Hammer', anchor: 'Anchor',
  skull: 'Skull', wolf: 'Wolf', phoenix: 'Phoenix', eye: 'Eye',
  key: 'Key', gear: 'Gear', helix: 'Helix', leaf: 'Leaf',
  wave: 'Wave', mountain: 'Mountain', tower: 'Tower', pyramid: 'Pyramid',
  dragon: 'Dragon', kraken: 'Kraken', galaxy: 'Galaxy', nova: 'Nova',
  raven: 'Raven', serpent: 'Serpent', swords: 'Crossed Swords',
  atom: 'Atom', hourglass: 'Hourglass', compass: 'Compass Rose',
};

const EMBLEM_SET = new Set<string>([...EMBLEM_IDS, ...PREMIUM_EMBLEM_IDS]);

export function isEmblemId(v: unknown): v is EmblemId {
  return typeof v === 'string' && EMBLEM_SET.has(v);
}

/**
 * Emblem for a faction that has none stored, or whose stored id this
 * bundle doesn't recognise (client older than server).
 *
 * Deterministic from a stable key — the faction id — so the same
 * faction always draws the same fallback shape rather than flickering
 * between renders or disagreeing between two panels on screen at once.
 */
export function fallbackEmblem(key: string): EmblemId {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return EMBLEM_IDS[(h >>> 0) % EMBLEM_IDS.length];
}

/** Resolve what to DRAW: the stored emblem when valid, else a stable
 *  fallback. Never returns null, so no caller needs a null branch. */
export function resolveEmblem(stored: string | null | undefined, key: string): EmblemId {
  return isEmblemId(stored) ? stored : fallbackEmblem(key);
}
