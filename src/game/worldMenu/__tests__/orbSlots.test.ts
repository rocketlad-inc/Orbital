/**
 * Mars's world menu printed "PHOBOS" and "DEIMOS" over one orb: a planet's
 * neighbour list is just its moons, and the old slot rule max(1, i) put
 * moon 0 and moon 1 both in slot 1.
 */
import { orbSlotIndex } from '../bodyStats';

const ids = (...xs: string[]) => xs.map(id => ({ id }));

test('a planet\u2019s moons each get their own slot', () => {
  const moons = ids('phobos', 'deimos');
  const slots = moons.map((_, i) => orbSlotIndex(i, moons, undefined));
  expect(slots).toEqual([1, 2]);
});

test('a moon\u2019s list puts its parent in slot 0 and its siblings after', () => {
  const list = ids('mars', 'deimos');
  expect(list.map((_, i) => orbSlotIndex(i, list, 'mars'))).toEqual([0, 1]);
});

test('no two of the four listed neighbours share a slot', () => {
  const planet = ids('a', 'b', 'c');
  expect(new Set(planet.map((_, i) => orbSlotIndex(i, planet, null))).size).toBe(3);
  const moon = ids('p', 'x', 'y', 'z');
  expect(new Set(moon.map((_, i) => orbSlotIndex(i, moon, 'p'))).size).toBe(4);
});
