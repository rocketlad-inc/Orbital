import {
  groupFlights, makeupOf, standingOf, scopeTMax, scopeRadius, layoutScope,
  worldBoxOf, framingCamera,
} from '../interceptPicker';
import type { Fleet, Ship } from '../../types';

// Shaped on the prod showcase game at T+418 (Kai68RfB5BhV, Terran seat):
// 99 hulls in flight read as 10 groups, among them a 13-ship fleet and
// seven loose Neptunian hulls bound for Neptune on the same tick.
const flying = (id: string, name: string, owner: string, dest: string, arrive: number, extra: Partial<Ship> = {}): Ship => ({
  id, name, ownedBy: owner, class: 'frigate',
  transit: { currentTransfer: { targetBodyId: dest, arriveTick: arrive } },
  ...extra,
} as unknown as Ship);
const parked = (id: string, owner: string): Ship => ({ id, name: id, ownedBy: owner, class: 'destroyer' } as unknown as Ship);

describe('grouping hulls in flight', () => {
  const fleets = [{ id: 'fl_tide', name: 'Iron Tide', leadShipId: 'tide_0', shipIds: [], ownedBy: 'f1' } as unknown as Fleet];
  const ships: Ship[] = [
    flying('tide_1', 'MCS FF-101', 'f1', 'pallas', 421, { fleetId: 'fl_tide' }),
    flying('tide_0', 'MCS Phobos Dawn', 'f1', 'pallas', 421, { fleetId: 'fl_tide', captainName: 'Farok' }),
    flying('tide_2', 'MCS CV-106', 'f1', 'pallas', 421, { fleetId: 'fl_tide', class: 'corvette' } as Partial<Ship>),
    flying('nts_0', 'NTS Leviathan', 'f6', 'neptune', 439, { captainName: 'Wilhuff Tarkin' }),
    flying('nts_1', 'NTS DD-101', 'f6', 'neptune', 439),
    flying('nts_2', 'NTS DD-102', 'f6', 'neptune', 439.2),
    flying('nts_late', 'NTS FF-109', 'f6', 'neptune', 450),
    parked('home', 'player'),
  ];
  const groups = groupFlights(ships, fleets);
  const byKey = new Map(groups.map(g => [g.key, g]));

  it('a fleet in flight is one group, led by its lead hull', () => {
    const g = byKey.get('fleet:fl_tide')!;
    expect(g.members).toHaveLength(3);
    expect(g.lead.name).toBe('MCS Phobos Dawn');
    expect(g.fleet?.name).toBe('Iron Tide');
  });

  it('loose hulls of one empire bound for one world on one tick fly together', () => {
    const g = byKey.get('loose:f6|neptune|439')!;
    expect(g.members.map(m => m.name)).toEqual(['NTS DD-101', 'NTS DD-102', 'NTS Leviathan']);
    expect(g.lead.name).toBe('NTS Leviathan');
  });

  it('a later arrival is a separate group, and parked hulls are not in flight', () => {
    expect(byKey.get('loose:f6|neptune|450')!.members).toHaveLength(1);
    expect(groups.some(g => g.members.some(m => m.id === 'home'))).toBe(false);
    expect(groups).toHaveLength(3);
  });

  it('makeup counts classes, largest first', () => {
    expect(makeupOf(byKey.get('fleet:fl_tide')!.members)).toEqual([{ cls: 'frigate', n: 2 }, { cls: 'corvette', n: 1 }]);
  });
});

describe('standing', () => {
  const allies = ['f2', 'f3'];
  // The provider's keys are sorted pairs (peace.ts pairKey).
  const wars = ['f1|player', 'f4|player'];
  it('reads the game\'s own diplomacy', () => {
    expect(standingOf('player', allies, wars)).toBe('yours');
    expect(standingOf('f3', allies, wars)).toBe('allied');
    expect(standingOf('f1', allies, wars)).toBe('war');
    expect(standingOf('f4', allies, wars)).toBe('war');
    expect(standingOf('f6', allies, wars)).toBe('peace');
  });
  it('no declared wars means peace', () => {
    expect(standingOf('f1', [], [])).toBe('peace');
  });
});

describe('the radar scale', () => {
  it('the rim is the smallest round size that fits every meeting', () => {
    expect(scopeTMax([6, 33])).toBe(40);
    expect(scopeTMax([6, 148])).toBe(160);
    expect(scopeTMax([])).toBe(20);
  });

  it('sooner is closer, and nothing leaves the scope', () => {
    const R = 165;
    let last = -1;
    for (const t of [0, 2, 5, 10, 20, 33, 40, 400]) {
      const r = scopeRadius(t, R, 40);
      expect(r).toBeGreaterThanOrEqual(last);
      expect(r).toBeLessThanOrEqual(R);
      last = r;
    }
    expect(scopeRadius(40, R, 40)).toBeCloseTo(R);
  });
});

describe('the radar layout', () => {
  it('pushes overlapping blips apart without moving them inward of their time', () => {
    const R = 165, tMax = 40;
    const items = [
      { key: 'a', angle: 0, meetIn: 21, myEta: 32, size: 32 },
      { key: 'b', angle: 0.02, meetIn: 21, myEta: 32, size: 32 },
      { key: 'c', angle: 0.04, meetIn: 22, myEta: 32, size: 32 },
    ];
    const pts = layoutScope(items, R, tMax);
    const P = items.map(i => pts.get(i.key)!);
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        expect(Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y)).toBeGreaterThanOrEqual(32);
      }
      const r = Math.hypot(P[i].x - R, P[i].y - R);
      expect(r).toBeGreaterThanOrEqual(scopeRadius(items[i].meetIn, R, tMax) - 6.01);
    }
  });

  it('a meeting at the door puts the world pin inside the blip: you arrive first', () => {
    const pts = layoutScope([{ key: 'lancers', angle: -0.6, meetIn: 33, myEta: 25, size: 32 }], 165, 40);
    const p = pts.get('lancers')!;
    expect(Math.hypot(p.pin!.x - 165, p.pin!.y - 165)).toBeLessThan(Math.hypot(p.x - 165, p.y - 165));
  });

  it('a match has no pin', () => {
    expect(layoutScope([{ key: 'm', angle: 1, meetIn: 6, myEta: null, size: 32 }], 165, 40).get('m')!.pin).toBeNull();
  });
});

describe('SHOW framing', () => {
  // A 1440x900 desktop with the pop-out docked at x=300: the free map is
  // the part to its right, and the course must land in the middle of THAT.
  const W = 1440, H = 900;
  const area = { l: 300 + 392 + 24, r: W - 72, t: 70, b: H - 24 };
  const toScreen = (cam: { x: number; y: number; scale: number }, p: { x: number; y: number }) => ({
    x: W / 2 + (p.x - cam.x) * cam.scale,
    y: H / 2 + (p.y - cam.y) * cam.scale,
  });

  it('centres the course in the free area, not the window', () => {
    const box = worldBoxOf([{ x: 100, y: 50 }, { x: 900, y: -250 }])!;
    const cam = framingCamera(box, area, W, H);
    const c = toScreen(cam, { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
    expect(c.x).toBeCloseTo((area.l + area.r) / 2, 6);
    expect(c.y).toBeCloseTo((area.t + area.b) / 2, 6);
  });

  it('keeps every corner of the course inside the free area', () => {
    const box = worldBoxOf([{ x: -3000, y: 200 }, { x: 4000, y: 2600 }, { x: 0, y: 0 }])!;
    const cam = framingCamera(box, area, W, H);
    for (const p of [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.maxY }]) {
      const q = toScreen(cam, p);
      expect(q.x).toBeGreaterThanOrEqual(area.l);
      expect(q.x).toBeLessThanOrEqual(area.r);
      expect(q.y).toBeGreaterThanOrEqual(area.t);
      expect(q.y).toBeLessThanOrEqual(area.b);
    }
  });
});
