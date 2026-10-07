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

import { tk } from '../i18n/core';

export type EmblemId =
  | 'anchor' | 'comet' | 'crown' | 'eye' | 'gear' | 'hammer'
  | 'helix' | 'key' | 'leaf' | 'moon' | 'mountain' | 'orbit'
  | 'phoenix' | 'pyramid' | 'ring' | 'shield' | 'skull' | 'spear'
  | 'star' | 'sun' | 'tower' | 'trident' | 'wave' | 'wolf'
  // The Double V — the Double Victory campaign's mark (victory abroad
  // against fascism, victory at home against racism). Deliberately in
  // the FREE list, never the paid wing.
  | 'doublev'
  // Classic rocket — the storybook kind, fins and exhaust. Free.
  | 'rocket'
  // Premium wing (Commander's Commission). Same permanence rule as the
  // free two dozen: a stored 'dragon' draws a dragon forever.
  | 'dragon' | 'kraken' | 'galaxy' | 'nova' | 'raven'
  | 'serpent' | 'swords' | 'atom' | 'hourglass' | 'compass';

/** Catalog order — drives the picker grid and the default rotation.
 *  25 entries against a max_players cap of 10 means uniqueness is always
 *  satisfiable, unlike the 8-colour palette.
 *
 *  New ids are APPENDED, never inserted: this array's order is the
 *  default rotation, so splicing one into the middle would silently
 *  change which emblem every no-picker slot lands on. */
export const EMBLEM_IDS: EmblemId[] = [
  'star', 'sun', 'moon', 'comet', 'orbit', 'ring',
  'crown', 'shield', 'spear', 'trident', 'hammer', 'anchor',
  'skull', 'wolf', 'phoenix', 'eye', 'key', 'gear',
  'helix', 'leaf', 'wave', 'mountain', 'tower', 'pyramid',
  'doublev', 'rocket',
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
  get star() { return tk('data.emblem.star', 'Star'); },
  get sun() { return tk('data.emblem.sun', 'Sun'); },
  get moon() { return tk('data.emblem.moon', 'Crescent'); },
  get comet() { return tk('data.emblem.comet', 'Comet'); },
  get orbit() { return tk('data.emblem.orbit', 'Orbit'); },
  get ring() { return tk('data.emblem.ring', 'Ringed World'); },
  get crown() { return tk('data.emblem.crown', 'Crown'); },
  get shield() { return tk('data.emblem.shield', 'Shield'); },
  get spear() { return tk('data.emblem.spear', 'Spear'); },
  get trident() { return tk('data.emblem.trident', 'Trident'); },
  get hammer() { return tk('data.emblem.hammer', 'Hammer'); },
  get anchor() { return tk('data.emblem.anchor', 'Anchor'); },
  get skull() { return tk('data.emblem.skull', 'Skull'); },
  get wolf() { return tk('data.emblem.wolf', 'Wolf'); },
  get phoenix() { return tk('data.emblem.phoenix', 'Phoenix'); },
  get eye() { return tk('data.emblem.eye', 'Eye'); },
  get key() { return tk('data.emblem.key', 'Key'); },
  get gear() { return tk('data.emblem.gear', 'Gear'); },
  get helix() { return tk('data.emblem.helix', 'Helix'); },
  get leaf() { return tk('data.emblem.leaf', 'Leaf'); },
  get wave() { return tk('data.emblem.wave', 'Wave'); },
  get mountain() { return tk('data.emblem.mountain', 'Mountain'); },
  get tower() { return tk('data.emblem.tower', 'Tower'); },
  get pyramid() { return tk('data.emblem.pyramid', 'Pyramid'); },
  get dragon() { return tk('data.emblem.dragon', 'Dragon'); },
  get kraken() { return tk('data.emblem.kraken', 'Kraken'); },
  get galaxy() { return tk('data.emblem.galaxy', 'Galaxy'); },
  get nova() { return tk('data.emblem.nova', 'Nova'); },
  get raven() { return tk('data.emblem.raven', 'Raven'); },
  get serpent() { return tk('data.emblem.serpent', 'Serpent'); },
  get swords() { return tk('data.emblem.swords', 'Crossed Swords'); },
  get atom() { return tk('data.emblem.atom', 'Atom'); },
  get hourglass() { return tk('data.emblem.hourglass', 'Hourglass'); },
  get compass() { return tk('data.emblem.compass', 'Compass Rose'); },
  get doublev() { return tk('data.emblem.doublev', 'Double V'); },
  get rocket() { return tk('data.emblem.rocket', 'Rocket'); },
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
