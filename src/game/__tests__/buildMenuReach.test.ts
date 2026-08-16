// EVERY BUILDING MUST BE REACHABLE.
//
// `columnsFor` is a hard-coded allow-list and it IS the build menu: a
// building defined in BUILDING_DEFS but missing from it is fully
// implemented, costed, research-gated and completely unbuildable,
// because nothing renders a button for it.
//
// This has now happened twice. `trajectory_thrusters` sat unreachable
// across every game ever played — zero were ever built, which is what
// that looks like from the outside. The Deep Survey Telescope did the
// same thing on its first day: defined, gated, tested by sims, and
// invisible in the menu.
//
// A test is the only thing that catches it, because everything else
// about such a building looks correct.

import { BUILDING_DEFS } from '../settlements';
import { columnsFor } from '../worldMenu/buildRules';
import type { Body, BuildingKind } from '../../types';

const body = (type: Body['type'], extra: Partial<Body> = {}): Body => ({
  id: 'b', name: 'B', type,
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 1, soi: 0, color: '#fff',
  ...extra,
} as Body);

/** Everywhere a player can actually be offered buildings. */
const SURFACES = [
  body('terrestrial', { terraformedAtTick: 1 }),
  body('terrestrial'),
  body('moon'),
  body('dwarf'),
  body('asteroid'),
  body('gas_giant'),
];

describe('every building is reachable from some build menu', () => {
  const offered = new Set<BuildingKind>();
  for (const b of SURFACES) {
    const cols = columnsFor(b);
    for (const k of [...cols.surface, ...cols.orbit]) offered.add(k);
  }

  const defined = Object.keys(BUILDING_DEFS) as BuildingKind[];

  it.each(defined)('%s appears in a build column', (kind) => {
    expect(offered.has(kind)).toBe(true);
  });

  it('offers nothing that is not defined', () => {
    for (const k of offered) {
      expect(BUILDING_DEFS[k]).toBeDefined();
    }
  });

  it('puts the telescope on a city surface, where its host type says', () => {
    // Its hostType is 'city', so offering it in the orbit column would
    // render a button the server refuses.
    const city = columnsFor(body('terrestrial', { terraformedAtTick: 1 }));
    expect(city.surface).toContain('telescope');
    expect(city.orbit).not.toContain('telescope');
  });
});
