// WHO MAY BE A CAPITAL.
//
// The lobby menu and the host's auto-assignment read the same predicate,
// so this suite guards the predicate rather than either caller.

// jsdom ships no TextEncoder, and worker/factions.js pulls in auth.js,
// which builds one at module load. Polyfilled before the require rather
// than imported at the top, because an `import` would hoist above it.
/* eslint-disable @typescript-eslint/no-var-requires */
(global as unknown as { TextEncoder: unknown }).TextEncoder = require('util').TextEncoder;
const {
  STARTING_BODY_OPTIONS, isValidStartingBody, CATALOG_FOR_EDITOR,
} = require('../../../worker/factions.js');

type CatalogBody = { id: string; type: string; parent: string | null; radius: number };
type Option = { id: string; name: string; type: string };

const ids = new Set<string>(STARTING_BODY_OPTIONS.map((o: Option) => o.id));
const byId = new Map<string, CatalogBody>(CATALOG_FOR_EDITOR.map((b: CatalogBody) => [b.id, b]));
const hasMoon = (id: string) => CATALOG_FOR_EDITOR.some((b: CatalogBody) => b.parent === id);

describe('starting body options', () => {
  it('offers the planets and big moons', () => {
    for (const id of ['earth', 'mars', 'luna', 'titan', 'triton']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('includes Pluto — a 1.5 world with a moon, not a rock in a ring', () => {
    expect(ids.has('pluto')).toBe(true);
    expect(isValidStartingBody('pluto')).toBe(true);
  });

  // The rule, not the list: a star-orbiting dwarf with no satellite reads
  // as rubble to findBelts, and a capital filed inside a belt row is wrong
  // on the map, in the outliner and in the vote grouping. Ceres and Eris
  // are radius 1.5 and clear the economic floor — this is what keeps them
  // out, and what would let them in if either were given a moon.
  it('offers no moonless dwarf', () => {
    for (const o of STARTING_BODY_OPTIONS as Option[]) {
      if (byId.get(o.id)?.type === 'dwarf') expect(hasMoon(o.id)).toBe(true);
    }
    expect(ids.has('ceres')).toBe(false);
    expect(ids.has('eris')).toBe(false);
  });

  it('holds the economic floor that the whole filter exists for', () => {
    for (const o of STARTING_BODY_OPTIONS as Option[]) {
      expect((byId.get(o.id)?.radius ?? 0)).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('offers no asteroid, gas giant or star', () => {
    for (const o of STARTING_BODY_OPTIONS as Option[]) {
      expect(['terrestrial', 'moon', 'dwarf']).toContain(byId.get(o.id)?.type);
    }
  });

  it('rejects a body that is not on the menu', () => {
    expect(isValidStartingBody('vesta')).toBe(false);
    expect(isValidStartingBody('sol')).toBe(false);
    expect(isValidStartingBody('')).toBe(false);
  });
});
