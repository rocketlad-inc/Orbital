// R2-C5: the Situation Report counted 92 bodies where the server's win
// check (and the Standing panel) counts 60.
import { dominationWorlds, dominationTarget } from '../dominationWorlds';
import type { Body } from '../../types';

const b = (id: string, type: string, parent?: string, extra: Partial<Body> = {}) =>
  ({ id, name: id, type, parent, orbitPeriod: 100, radius: 1, mu: 1, orbitRadius: 1, angle0: 0, ...extra }) as unknown as Body;

test('home-system worlds count; rocks, markers and the far systems do not', () => {
  const bodies = [
    b('sol', 'star', undefined, { orbitPeriod: 0 }),
    b('earth', 'terrestrial', 'sol'),
    b('luna', 'moon', 'earth'),
    b('rock', 'meteoroid', 'sol'),
    b('l4', 'lagrange', 'sol'),
    b('gone', 'moon', 'earth', { obliteratedAtTick: 5 }),
    b('binary_barycenter', 'lagrange', 'sol', { orbitPeriod: 1e9 }),
    b('centauri_a', 'star', 'binary_barycenter'),
    b('verdant', 'terrestrial', 'centauri_a'),
  ];
  expect(dominationWorlds(bodies).map(x => x.id)).toEqual(['sol', 'earth', 'luna']);
});

test('the target is strictly more than the fraction, as the server checks', () => {
  expect(dominationTarget(60)).toBe(37);
  expect(dominationTarget(45)).toBe(28);
  expect(dominationTarget(0)).toBe(0);
});
