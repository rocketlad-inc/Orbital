// R2-C10: an unarmed colony ship defaulted to stance ATTACK.
import { readFileSync } from 'fs';
import { join } from 'path';
import { defaultStanceFor, resolvedStance } from '../stance';

test('civilian hulls default to a stance that starts no fights', () => {
  expect(defaultStanceFor('colony')).toBe('defensive');
  expect(defaultStanceFor('freighter')).toBe('defensive');
  expect(defaultStanceFor('frigate')).toBe('attack');
  expect(resolvedStance(null, 'colony')).toBe('defensive');
  expect(resolvedStance(undefined, 'corvette')).toBe('attack');
});
test('a stance the player set is kept', () => {
  expect(resolvedStance('attack', 'freighter')).toBe('attack');
  expect(resolvedStance('hold', 'destroyer')).toBe('hold');
});
test('the worker resolves NULL the same way (shipStance.js mirror)', () => {
  const src = readFileSync(join(__dirname, '../../../worker/shipStance.js'), 'utf8');
  expect(src).toMatch(/CIVILIAN_CLASSES = new Set\(\['colony', 'freighter'\]\)/);
  expect(src).toMatch(/\? 'defensive' : 'attack'/);
  const room = readFileSync(join(__dirname, '../../../worker/room.js'), 'utf8');
  expect(room).toMatch(/const effectiveStance = \(s\) => resolvedStance\(s\.stance, s\.ship_class\)/);
});
