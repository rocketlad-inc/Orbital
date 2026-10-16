// The Map Maker's edits (ops.ts): the review's findings, pinned.

import { blankMap, normalizeMap, MAX_BODIES, type CustomMap, type MapBody } from '../../game/customMap';
import {
  addSector, changeType, rerollZone, suggestSectors, placeBody, placeSymmetric, duplicateBodies, mirrorBodies,
} from '../ops';

const body = (id: string, over: Partial<MapBody> = {}): MapBody => ({
  id, name: id.toUpperCase(), type: 'terrestrial', parent: 'sun', orbit: 300, angle: 0, radius: 3,
  yields: { metal: 3, credits: 3, science: 3 }, color: '#4f8a3c', surface: 'verdant', rings: false, start: false, secret: null,
  ...over,
} as MapBody);
const withBodies = (bodies: MapBody[], extra: Partial<CustomMap> = {}): CustomMap => normalizeMap({ ...blankMap(), bodies, ...extra });

describe('addSector', () => {
  it('never swallows a band already drawn: the new one keeps the widest free gap', () => {
    const one = addSector(blankMap(), 400, 600);
    const two = addSector(one.map, 200, 900);
    expect(two.map.sectors.find(s => s.id === one.id)).toMatchObject({ inner: 400, outer: 600 });
    const made = two.map.sectors.find(s => s.id === two.id)!;
    expect(made).toMatchObject({ inner: 600, outer: 900 });
  });
  it('is refused when there is no room left', () => {
    const one = addSector(blankMap(), 400, 600);
    const two = addSector(one.map, 420, 580);
    expect(two.id).toBeNull();
    expect(two.map).toBe(one.map);
  });
});

describe('changeType', () => {
  const map = withBodies([body('pa', { orbit: 800 }), body('ma', { type: 'moon', parent: 'pa', orbit: 30, radius: 1 })]);
  it('a world with moons does not become an asteroid or a rock', () => {
    expect(changeType(map, 'pa', 'asteroid')).toBe(map);
    expect(changeType(map, 'pa', 'rock')).toBe(map);
  });
  it('...but still becomes a giant, moons kept', () => {
    const next = changeType(map, 'pa', 'gas-giant');
    expect(next.bodies.find(b => b.id === 'pa')!.type).toBe('gas-giant');
    expect(next.bodies.find(b => b.id === 'ma')!.parent).toBe('pa');
  });
});

describe('rerollZone', () => {
  it('keeps every start the zone had, moons included', () => {
    const map = withBodies([
      body('pa', { orbit: 200, start: true }),
      body('ma', { type: 'moon', parent: 'pa', orbit: 30, radius: 1, start: true }),
      body('mb', { type: 'moon', parent: 'pa', orbit: 60, radius: 1, start: true }),
      body('pb', { orbit: 400, type: 'gas-giant', radius: 8 }),
      body('pc', { orbit: 3000, start: true }),
      body('pd', { orbit: 5000, start: true }),
    ]);
    for (let i = 0; i < 10; i++) {
      const r = rerollZone(map, 'inner', 'Mythic');
      expect(r.map.bodies.filter(b => b.start).length).toBe(5);
    }
  });
  it('splits worlds that share one orbit by rank: "inner" never replaces the whole system', () => {
    const map = withBodies(['a', 'b', 'c', 'd'].map((id, i) => body(id, { orbit: 900, angle: i })));
    const r = rerollZone(map, 'inner', 'Mythic');
    expect(r.map.bodies.filter(b => ['a', 'b', 'c', 'd'].includes(b.id)).length).toBe(2);
  });
});

describe('suggestSectors', () => {
  it('worlds all on one orbit get one band round them', () => {
    const map = withBodies(['a', 'b', 'c'].map((id, i) => body(id, { orbit: 900, angle: i })));
    const next = suggestSectors(map, 4);
    expect(next.sectors).toHaveLength(1);
    expect(next.sectors[0].inner).toBeLessThan(900);
    expect(next.sectors[0].outer).toBeGreaterThan(900);
  });
});

describe('ids at the body cap', () => {
  const full = withBodies(Array.from({ length: MAX_BODIES - 1 }, (_, i) => body(`b${i}`, { type: 'asteroid', orbit: 300 + i * 10, radius: 0.5 })));
  it('only ids still on the map come back', () => {
    const sym = placeSymmetric(full, 'terrestrial', 1000, 0, 'Mythic', 4);
    expect(sym.ids).toHaveLength(1);
    expect(sym.ids.every(id => sym.map.bodies.some(b => b.id === id))).toBe(true);
    const belt = placeBody(full, 'belt', 'sun', 1000, 0, 'Mythic');
    expect(belt.ids.every(id => belt.map.bodies.some(b => b.id === id))).toBe(true);
    const dup = duplicateBodies(sym.map, ['b0', 'b1'], 'Mythic');
    expect(dup.ids).toHaveLength(0);
    const mir = mirrorBodies(sym.map, ['b0'], 4, 'Mythic');
    expect(mir.ids.every(id => mir.map.bodies.some(b => b.id === id))).toBe(true);
  });
});
