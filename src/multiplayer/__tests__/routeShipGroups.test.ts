// Sam, 2026-10-22, over the New Route form: "you need to know the ship
// names, where instead it could be based on location." The picker listed
// free hulls by name in build order. Now they are grouped by world,
// nearest the first stop first, with other star systems set apart.
import { groupByWorld, groupGuards, freighterAccel, tripTicks, shipWhere } from '../routeShipGroups';
import type { Body, Fleet, GameState, Ship } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 100, angle0: 0, soi: 50, color: '#fff',
  ...o,
} as Body);

const bodies: Body[] = [
  B({ id: 'sol', name: 'Sol', type: 'star', orbitPeriod: 0, radius: 60 }),
  B({ id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol', orbitRadius: 1490, orbitPeriod: 365 }),
  B({ id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', orbitRadius: 40, orbitPeriod: 27 }),
  B({ id: 'jupiter', name: 'Jupiter', type: 'gas_giant', parent: 'sol', orbitRadius: 7780, orbitPeriod: 4330 }),
  B({ id: 'binary_barycenter', name: 'Centauri Barycenter', type: 'lagrange', parent: 'sol', orbitRadius: 530400, orbitPeriod: 1e12 }),
  B({ id: 'crimson', name: 'Crimson', type: 'gas_giant', parent: 'binary_barycenter', orbitRadius: 3800, orbitPeriod: 9000 }),
];

const orbit = (parentBodyId: string) => ({
  rp: 8, ra: 8, omega: 0, M0: 0, epoch: 0, direction: 1 as const, period: 10, parentBodyId,
});
const ship = (id: string, name: string, cls: Ship['class'], at: string, extra: Partial<Ship> = {}): Ship => ({
  id, name, class: cls, ownedBy: 'player', orbit: orbit(at), ...extra,
} as Ship);

const gs = (ships: Ship[], fleets: Fleet[] = []): GameState => ({
  bodies, ships, fleets, currentTick: 0,
  factions: [{ id: 'player', name: 'Freepost', color: '#ffca28' }],
  factionTech: {},
} as unknown as GameState);

const freighters = [
  ship('f1', 'Yak', 'freighter', 'jupiter'),
  ship('f2', 'Shackleton', 'freighter', 'luna'),
  ship('f3', 'Burro', 'freighter', 'earth'),
  ship('f4', 'Zheng He', 'freighter', 'crimson'),
  ship('f5', 'Abundance', 'freighter', 'jupiter'),
];

test('worlds come nearest the first stop first, the stop itself at the top', () => {
  const g = gs(freighters);
  const { worlds } = groupByWorld(freighters, 'earth', g, freighterAccel(g));
  expect(worlds.map(w => w.bodyId)).toEqual(['earth', 'luna', 'jupiter']);
  expect(worlds[0].eta).toBe(0);
  expect(worlds[1].eta!).toBeLessThan(worlds[2].eta!);
  // Hulls at one world are A-Z.
  expect(worlds[2].ships.map(s => s.ship.name)).toEqual(['Abundance', 'Yak']);
});

test('a hull in another star system is set apart, with no straight-line time', () => {
  const g = gs(freighters);
  const { worlds, far } = groupByWorld(freighters, 'earth', g, freighterAccel(g));
  expect(worlds.flatMap(w => w.ships.map(s => s.ship.name))).not.toContain('Zheng He');
  expect(far).toHaveLength(1);
  expect(far[0].systemId).toBe('binary_barycenter');
  expect(far[0].ships.map(s => [s.ship.name, s.bodyId, s.eta])).toEqual([['Zheng He', 'crimson', null]]);
});

test('a route that starts in Centauri treats Sol as the far system', () => {
  const g = gs(freighters);
  const { worlds, far } = groupByWorld(freighters, 'crimson', g, freighterAccel(g));
  expect(worlds.map(w => w.bodyId)).toEqual(['crimson']);
  expect(far.map(f => f.systemId)).toEqual(['sol']);
});

test('a hull in flight is grouped under where it is going, and its trip starts on arrival', () => {
  const flying = ship('f6', 'Drifter', 'freighter', 'earth', {
    transit: {
      pos: { x: 3000, y: 0 }, vel: { x: 0, y: 0 },
      currentTransfer: { targetBodyId: 'jupiter', arriveTick: 40 } as never,
    },
  });
  expect(shipWhere(flying)).toEqual({ bodyId: 'jupiter', enRoute: true });
  const g = gs([...freighters, flying]);
  const accel = freighterAccel(g)(flying);
  const eta = tripTicks(flying, 'earth', accel, 0, bodies)!;
  const parked = tripTicks(freighters[0], 'earth', accel, 0, bodies)!;
  expect(eta).toBeGreaterThan(40);
  expect(tripTicks(flying, 'jupiter', accel, 0, bodies)).toBe(40);
  const { worlds } = groupByWorld([...freighters, flying], 'earth', g, freighterAccel(g));
  const jup = worlds.find(w => w.bodyId === 'jupiter')!;
  expect(jup.ships.find(s => s.ship.id === 'f6')!.enRoute).toBe(true);
  expect(parked).toBeGreaterThan(0);
});

test('with no stop yet, worlds are A-Z and nobody quotes a trip', () => {
  const g = gs(freighters);
  const { worlds } = groupByWorld(freighters, undefined, g, freighterAccel(g));
  expect(worlds.map(w => w.bodyId)).toEqual(['earth', 'jupiter', 'luna']);
  expect(worlds.every(w => w.eta == null)).toBe(true);
});

test('guards: fleets at the first stop first, members picked together, loose ships by world', () => {
  const warships = [
    ship('w1', 'Templar', 'frigate', 'jupiter', { fleetId: 'fl_far' }),
    ship('w2', 'Sejong', 'corvette', 'jupiter', { fleetId: 'fl_far' }),
    ship('w3', 'Bastion', 'destroyer', 'earth', { fleetId: 'fl_home' }),
    ship('w4', 'Hoplite', 'frigate', 'earth', { fleetId: 'fl_home' }),
    ship('w5', 'Jemison-2', 'corvette', 'luna'),
    ship('w6', 'Jemison-2', 'corvette', 'jupiter'),
  ];
  const fleets: Fleet[] = [
    { id: 'fl_far', name: 'Uranus Group', shipIds: ['w1', 'w2'], leadShipId: 'w1', ownedBy: 'player' },
    { id: 'fl_home', name: 'Pride of Terra', shipIds: ['w3', 'w4'], leadShipId: 'w3', ownedBy: 'player' },
    // A fleet whose hulls are all busy on routes has nothing to offer.
    { id: 'fl_busy', name: 'Busy', shipIds: ['zz'], leadShipId: 'zz', ownedBy: 'player' },
  ];
  const g = gs(warships, fleets);
  const { fleets: picks, loose } = groupGuards(warships, 'earth', g);
  expect(picks.map(p => [p.fleet.name, p.here, p.lead.name])).toEqual([
    ['Pride of Terra', true, 'Bastion'],
    ['Uranus Group', false, 'Templar'],
  ]);
  expect(picks[1].members.map(m => m.id)).toEqual(['w2', 'w1']);
  expect(picks[1].eta!).toBeGreaterThan(0);
  // The two Jemison-2s are told apart by where they are.
  expect(loose.worlds.map(w => [w.bodyId, w.ships.map(s => s.ship.id)])).toEqual([
    ['luna', ['w5']], ['jupiter', ['w6']],
  ]);
});
