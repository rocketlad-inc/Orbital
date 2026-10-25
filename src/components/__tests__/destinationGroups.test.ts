/**
 * The fleet's "Destination…" list was one alphabetical run of every body
 * in the game (96 worlds); it now groups like the destination picker,
 * the selection's own system first (Rafaela, Leo, round 2).
 */
import { groupTransferTargets, isPickableDestination } from '../ShipPanel';
import type { Body } from '../../types';

const body = (id: string, parent: string | undefined, orbitRadius: number, type = 'planet'): Body =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), parent, orbitRadius, type, radius: 1 } as unknown as Body);

const bodies = [
  body('sol', undefined, 0, 'star'),
  body('earth', 'sol', 300), body('luna', 'earth', 4, 'moon'),
  body('mars', 'sol', 450),
  body('jupiter', 'sol', 1500, 'gas_giant'), body('io', 'jupiter', 6, 'moon'), body('europa', 'jupiter', 9, 'moon'),
  body('l4', 'sol', 300, 'lagrange'),
];

it('puts the home system first, then reads outward from the Sun', () => {
  const groups = groupTransferTargets(bodies, bodies.filter(b => isPickableDestination(b)), 'io');
  expect(groups[0].bodies.map(b => b.id).sort()).toEqual(['europa', 'io', 'jupiter']);
  const rest = groups.slice(1).flatMap(g => g.bodies.map(b => b.id));
  expect(rest.indexOf('earth')).toBeLessThan(rest.indexOf('mars'));
  expect(rest).not.toContain('l4');
});
