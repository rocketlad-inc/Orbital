/**
 * The map's coverage follows the server's sensor rules (sensor audit,
 * 2026-10-08):
 *   - a breached Deep Space Array is offline (the server reads hp > 600);
 *   - a RIVAL Null Field cuts your coverage, and only your ships in the
 *     field's own system see through it; an abandoned (unowned) field,
 *     a breached one and your own or an ally's never cut.
 */
import fs from 'fs';
import path from 'path';
import { nullFieldCuts, structureOnline, systemOfBody } from '../visibility';
import type { Body, Ship } from '../../types';

const body = (id: string, parent: string | undefined, type: string, ownedBy?: string, orbitRadius = 0): Body =>
  ({ id, name: id, type, parent, ownedBy, radius: 1, orbitRadius, orbitPeriod: 100, angle0: 0, color: '#fff' } as unknown as Body);

const BODIES: Body[] = [
  body('sol', undefined, 'star'),
  body('uranus', 'sol', 'ice_giant', undefined, 9000),
  body('oberon', 'uranus', 'moon', 'rival', 40),
  body('nf', 'oberon', 'megastructure', 'rival', 5),        // rival Null Field over Oberon
  body('mars', 'sol', 'terrestrial', 'player', 2000),
];
const ship = (id: string, ownedBy: string, at: string): Ship =>
  ({ id, name: id, class: 'destroyer', ownedBy, orbit: { parentBodyId: at } } as unknown as Ship);

const field = (over: Partial<{ hp: number; status: string; bodyId: string }> = {}) =>
  ({ bodyId: 'nf', kind: 'null_field', status: 'complete', hp: 3000, ...over });

test('a system is the star-orbiting ancestor', () => {
  const byId = new Map(BODIES.map(b => [b.id, b]));
  expect(systemOfBody('nf', byId)).toBe('uranus');
  expect(systemOfBody('oberon', byId)).toBe('uranus');
  expect(systemOfBody('mars', byId)).toBe('mars');
});

test('a breached structure is offline; unknown hp is full', () => {
  expect(structureOnline({ bodyId: 'x', kind: 'deep_array', status: 'complete', hp: 3000 })).toBe(true);
  expect(structureOnline({ bodyId: 'x', kind: 'deep_array', status: 'complete', hp: 600 })).toBe(false);
  expect(structureOnline({ bodyId: 'x', kind: 'deep_array', status: 'complete' })).toBe(true);
  expect(structureOnline({ bodyId: 'x', kind: 'deep_array', status: 'building', hp: 3000 })).toBe(false);
});

test('a rival field cuts; only a ship in its system pierces it', () => {
  const ships = [ship('mine-at-mars', 'player', 'mars'), ship('mine-at-oberon', 'player', 'oberon')];
  const cuts = nullFieldCuts('player', [field()], ships, BODIES, 0);
  expect(cuts).toHaveLength(1);
  expect(cuts[0].range).toBeGreaterThan(0);
  expect(cuts[0].pierce).toHaveLength(1);           // the Oberon hull, not the Mars one
});

test('no cut from an abandoned, breached, own or allied field', () => {
  const unowned = BODIES.map(b => (b.id === 'nf' ? { ...b, ownedBy: undefined } : b)) as Body[];
  expect(nullFieldCuts('player', [field()], [], unowned, 0)).toHaveLength(0);
  expect(nullFieldCuts('player', [field({ hp: 500 })], [], BODIES, 0)).toHaveLength(0);
  expect(nullFieldCuts('rival', [field()], [], BODIES, 0)).toHaveLength(0);
  expect(nullFieldCuts('player', [field()], [], BODIES, 0, new Set(['rival']))).toHaveLength(0);
});

test('the map passes the cuts to the fog and keeps breached arrays out', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../components/MapCanvas.tsx'), 'utf8');
  expect(src).toMatch(/drawFogOfWarOverlay\(seen, renderContext, 1, \{ wash: regionFade, cuts \}\)/);
  expect(src).toMatch(/m\.kind !== 'deep_array' \|\| !structureOnline\(m\)/);
});
