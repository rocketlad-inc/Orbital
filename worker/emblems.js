// ============================================================
// Faction emblems — SERVER mirror of src/game/emblems.ts.
//
// KEEP IN SYNC. The worker is a separate Cloudflare bundle that cannot
// import the React build tree, so the id list is duplicated — the same
// arrangement researchUnlocks and shipDesigns already live with.
//
// The server only needs the IDS (to validate a pick and to hand out a
// default). The SVG artwork is client-only; nothing server-side ever
// draws an emblem, it just decides which id a faction owns.
//
// IDS ARE OPAQUE AND PERMANENT — a stored 'anchor' must mean an anchor
// forever, because live factions carry these strings.
// ============================================================

export const EMBLEM_IDS = [
  'star', 'sun', 'moon', 'comet', 'orbit', 'ring',
  'crown', 'shield', 'spear', 'trident', 'hammer', 'anchor',
  'skull', 'wolf', 'phoenix', 'eye', 'key', 'gear',
  'helix', 'leaf', 'wave', 'mountain', 'tower', 'pyramid',
];

const EMBLEM_SET = new Set(EMBLEM_IDS);

export function isEmblemId(v) {
  return typeof v === 'string' && EMBLEM_SET.has(v);
}

/** Normalise an incoming pick: a known id, or null. Anything else is a
 *  400 at the caller — emblems are a closed set, unlike colours which
 *  accept any #rrggbb. */
export function normalizeEmblem(v) {
  if (v === null || v === undefined || v === '') return null;
  return isEmblemId(v) ? v : undefined;   // undefined = invalid, caller 400s
}

/**
 * Pick an emblem for a faction that didn't choose one.
 *
 * Walks the catalog from the slot's natural position so a lobby of
 * no-pickers gets a spread rather than everyone starting at 'star', and
 * skips anything already taken.
 *
 * This is the colour lesson applied up front. Colours shipped a bug
 * where the DEFAULT fallback handed out a palette entry somebody had
 * explicitly picked, because the uniqueness check only ever compared
 * pick against pick (see sim/colorClash.mjs). Emblems dodge it by
 * construction: 24 ids against a max_players cap of 8 means a free one
 * always exists, so unlike the colour palette this never has to
 * degrade to "closest available".
 */
export function defaultEmblemFor(slot, taken) {
  const used = new Set(taken.filter(Boolean));
  for (let i = 0; i < EMBLEM_IDS.length; i++) {
    const id = EMBLEM_IDS[(slot + i) % EMBLEM_IDS.length];
    if (!used.has(id)) return id;
  }
  // Unreachable while EMBLEM_IDS.length (24) > max_players (8), but a
  // silent duplicate beats a crash during game start.
  return EMBLEM_IDS[slot % EMBLEM_IDS.length];
}
