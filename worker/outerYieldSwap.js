// ============================================================
// outerYieldSwap -- carry the Kuiper Belt / Far Reach metal-credit swap
// into games that were seeded before it (Lorne, 2026-09-29: "for all the
// worlds in the Far Reach and Kuiper Belt that are not yet claimed, swap
// their credit and metal values").
//
// The catalogue already carries the swapped numbers, so new games need
// nothing. A running game keeps the numbers it was seeded with, and this
// plans, per game, which of its bodies to swap.
//
// WHICH BODIES. Whatever the map itself files under the Kuiper Belt or
// the Far Reach, asked of the game's own rows through makeSystemRootOf:
// dwarfs, their moons, and the rogue asteroids whose orbits reach out
// there. Not a hand-written list, so a rogue that an older, differently
// scaled board files elsewhere is left where that board put it.
//
// WHICH ARE UNCLAIMED. No living settlement on the body and no owner on
// the row. A settled world's income reads the body's yields live, so
// swapping a held world would change a player's economy under them; the
// order was to leave those alone.
//
// SAFE TO RUN TWICE. A body is swapped only while it still carries the
// OLD numbers -- the catalogue's, or half of them after an impact halved
// the surface. One already carrying the new numbers is left alone, which
// is also why games seeded after the catalogue change are untouched.
// Anything matching neither is reported and left for a human. The write
// re-checks both the numbers and the claim, so a colony founded between
// the plan and the write keeps its world as it was.
// ============================================================

import { BODY_CATALOG } from './factions.js';
import { makeSystemRootOf, isWorld } from './systems.js';

export const SWAP_BANDS = new Set(['belt:kuiper', 'belt:farreach']);

const catalogById = new Map(BODY_CATALOG.map(b => [b.id, b]));

/**
 * @param bodies  every game_bodies row of one game (needs id, template_id,
 *                type, parent_body_id, orbit_radius, owner_faction_id,
 *                yield_metal, yield_gold, destroyed_at_tick)
 * @param claimed Set of body ids with a living settlement
 * @returns { swap, already, even, claimed, odd } -- arrays of
 *          { id, template, band, metal, gold } (current values)
 */
export function planOuterYieldSwap(bodies, claimed) {
  const rootOf = makeSystemRootOf(bodies);
  const plan = { swap: [], already: [], even: [], claimed: [], odd: [] };
  for (const b of bodies) {
    if (b.destroyed_at_tick != null || !isWorld(b)) continue;
    const band = rootOf(b.id);
    if (!SWAP_BANDS.has(band)) continue;
    const row = {
      id: b.id, template: b.template_id, band,
      metal: Number(b.yield_metal ?? 0), gold: Number(b.yield_gold ?? 0),
    };
    if (claimed.has(b.id) || b.owner_faction_id != null) { plan.claimed.push(row); continue; }
    if (row.metal === row.gold) { plan.even.push(row); continue; }
    const cat = catalogById.get(b.template_id)?.yield;
    if (!cat) { plan.odd.push(row); continue; }
    // The catalogue holds the NEW numbers; the old ones are them swapped.
    const is = (m, g) => row.metal === m && row.gold === g;
    const half = (v) => Math.floor(v / 2);
    if (is(cat.gold, cat.metal) || is(half(cat.gold), half(cat.metal))) plan.swap.push(row);
    else if (is(cat.metal, cat.gold) || is(half(cat.metal), half(cat.gold))) plan.already.push(row);
    else plan.odd.push(row);
  }
  return plan;
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** The one UPDATE for one game, or null when there is nothing to swap.
 *  SQLite reads every right-hand side from the OLD row, so the pair
 *  assignment is a true swap. Each body is guarded by its planned
 *  numbers and by the claim, so the statement cannot apply twice or reach
 *  a world settled since the plan was made. */
export function outerYieldSwapSql(gameId, plan) {
  if (!plan.swap.length) return null;
  const guards = plan.swap
    .map(r => `(id = ${q(r.id)} AND yield_metal = ${r.metal} AND yield_gold = ${r.gold})`)
    .join(' OR ');
  return `UPDATE game_bodies SET yield_metal = yield_gold, yield_gold = yield_metal
           WHERE game_id = ${q(gameId)} AND owner_faction_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM game_settlements s
                              WHERE s.body_id = game_bodies.id AND s.destroyed_at_tick IS NULL)
             AND (${guards})`;
}
