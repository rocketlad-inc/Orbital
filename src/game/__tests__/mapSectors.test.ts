// ============================================================
// AUTHORED SECTORS REPLACE THE AUTOMATIC SYSTEMS (custom maps).
//
// A Map Maker map can draw sectors: named bands of orbit round the sun.
// Lorne's rule: on such a map a sector replaces the game's automatic
// "systems" EVERYWHERE for every world inside it -- the senate weight,
// the outliner and fleet headers, the map's region shading, the Herald.
// A world outside every band groups automatically, and a map without
// sectors (every shipped game) groups exactly as it did before.
//
// Both mirrors are driven here from ONE fixture in their own dialects:
// worker/systems.js reads DB rows (look_json strings, `<game>:` ids),
// src/game/systemGrouping.ts reads client bodies (parsed `look`).
// ============================================================

import {
  makeSystemRootOf, systemLabel, findBelts, bodySector, SECTOR_PREFIX,
} from '../systemGrouping';
import { computeSystemRegions } from '../../render/systemRegions';
import type { Body, Faction } from '../../types';

// jsdom ships no TextEncoder, and worker/factions.js pulls in auth.js,
// which builds one at module load (see startingBodies.test.ts).
/* eslint-disable @typescript-eslint/no-var-requires */
(global as unknown as { TextEncoder: unknown }).TextEncoder = require('util').TextEncoder;
const server = require('../../../worker/systems.js');
const { BODY_CATALOG } = require('../../../worker/factions.js');

type Spec = {
  id: string; name: string; type: string; parent: string | null;
  r: number; period?: number; owner?: string | null;
  sector?: { id: string; name: string; color: string } | null;
  rp?: number | null; ra?: number | null;
};

const G = 'g1';
/** A DB row, as the senate's SELECT returns it. */
const toRow = (s: Spec) => ({
  id: `${G}:${s.id}`, template_id: s.id, name: s.name,
  type: s.type, parent_body_id: s.parent ? `${G}:${s.parent}` : null,
  orbit_radius: s.r, orbit_period: s.period ?? 100,
  orbit_rp: s.rp ?? null, orbit_ra: s.ra ?? null,
  owner_faction_id: s.owner ?? null, obliterated_at_tick: null,
  look_json: s.sector ? JSON.stringify({ surface: 'rock', rings: false, sector: s.sector }) : null,
});
/** A client body, as MultiplayerGameProvider maps it (underscored types,
 *  stripped ids, parsed look). */
const toBody = (s: Spec): Body => ({
  id: s.id, name: s.name, type: s.type.replace('-', '_'),
  parent: s.parent ?? undefined,
  orbitRadius: s.r, orbitPeriod: s.period ?? 100, angle0: 0,
  radius: 3, soi: 10, color: '#888888',
  ...(s.rp != null ? { orbit_rp: s.rp } : {}),
  ...(s.ra != null ? { orbit_ra: s.ra } : {}),
  ...(s.owner ? { ownedBy: s.owner } : {}),
  ...(s.sector ? { look: { surface: 'rock', rings: false, sector: s.sector } } : {}),
} as unknown as Body);
const strip = (id: string) => id.replace(`${G}:`, '');

const INNER = { id: 'sin', name: 'Inner Reach', color: '#4ecdc4' };
const OUTER = { id: 'sout', name: 'Outer Deep', color: '#ffb84d' };

/** Two sectors, a moon in the outer one (one moon whose own look forgot
 *  the sector, which must follow its planet anyway), rubble that would be
 *  a belt, a Core-template world inside a sector, and one planet with a
 *  moon outside every band. */
const MAP: Spec[] = [
  { id: 'sol', name: 'Helion', type: 'star', parent: null, r: 0, period: 0 },
  { id: 'mercury', name: 'Cinderfall', type: 'terrestrial', parent: 'sol', r: 100, sector: INNER },
  { id: 'p1', name: 'Eirenos', type: 'terrestrial', parent: 'sol', r: 200, sector: INNER, owner: 'fA' },
  { id: 'p2', name: 'Neraphae', type: 'terrestrial', parent: 'sol', r: 300, sector: INNER, owner: 'fA' },
  { id: 'm2', name: 'Pell', type: 'moon', parent: 'p2', r: 20, sector: INNER, owner: 'fB' },
  { id: 'g1', name: 'Vastor', type: 'gas-giant', parent: 'sol', r: 800, sector: OUTER },
  { id: 'gm1', name: 'Ilo', type: 'moon', parent: 'g1', r: 30, sector: OUTER },
  { id: 'gm2', name: 'Ama', type: 'moon', parent: 'g1', r: 40 },
  { id: 'a1', name: 'Shard', type: 'asteroid', parent: 'sol', r: 900, sector: OUTER, owner: 'fA' },
  { id: 'a2', name: 'Flake', type: 'asteroid', parent: 'sol', r: 920, sector: OUTER, owner: 'fB' },
  { id: 'a3', name: 'Grit', type: 'asteroid', parent: 'sol', r: 940, sector: OUTER },
  { id: 'p5', name: 'Loner', type: 'terrestrial', parent: 'sol', r: 1500, owner: 'fB' },
  { id: 'm5', name: 'Wisp', type: 'moon', parent: 'p5', r: 25 },
];

describe('authored sectors, both mirrors', () => {
  const rows = MAP.map(toRow);
  const bodies = MAP.map(toBody);
  const sRoot = server.makeSystemRootOf(rows);
  const cRoot = makeSystemRootOf(bodies);

  it('every world in a band roots to its sector, moons included', () => {
    for (const id of ['mercury', 'p1', 'p2', 'm2']) {
      expect(sRoot(`${G}:${id}`)).toBe('sector:sin');
      expect(cRoot(id)).toBe('sector:sin');
    }
    for (const id of ['g1', 'gm1', 'gm2', 'a1', 'a2', 'a3']) {
      expect(sRoot(`${G}:${id}`)).toBe('sector:sout');
      expect(cRoot(id)).toBe('sector:sout');
    }
    expect(SECTOR_PREFIX).toBe(server.SECTOR_PREFIX);
  });

  it('a sector outranks the belt and the Core', () => {
    expect(findBelts(bodies)).toEqual([]);
    expect(server.findBelts(rows)).toEqual([]);
    expect(cRoot('mercury')).not.toBe('core');
  });

  it('is labelled with the sector name', () => {
    expect(server.systemLabel(rows, 'sector:sin')).toBe('Inner Reach');
    expect(systemLabel(bodies, 'sector:sin')).toBe('Inner Reach');
    expect(server.systemLabel(rows, 'sector:sout')).toBe('Outer Deep');
    expect(systemLabel(bodies, 'sector:sout')).toBe('Outer Deep');
  });

  it('a world outside every band keeps its automatic system', () => {
    expect(sRoot(`${G}:m5`)).toBe(`${G}:p5`);
    expect(cRoot('m5')).toBe('p5');
    expect(server.systemLabel(rows, `${G}:p5`)).toBe('Loner System');
  });

  it('the two mirrors agree on every body', () => {
    for (const s of MAP) expect(strip(sRoot(`${G}:${s.id}`))).toBe(cRoot(s.id));
  });

  it('vote weight: most worlds of a sector is +1, a tie is nothing', () => {
    // Inner Reach: fA 2 (p1, p2), fB 1 (m2) of 4 -> fA.
    // Outer Deep: fA 1, fB 1 -> contested.  Loner System: fB.
    const sys = server.summarizeSystems(rows);
    const inner = sys.find((x: { rootId: string }) => x.rootId === 'sector:sin');
    const outer = sys.find((x: { rootId: string }) => x.rootId === 'sector:sout');
    expect(inner).toMatchObject({ label: 'Inner Reach', total: 4, controller: 'fA', contested: false });
    expect(outer).toMatchObject({ label: 'Outer Deep', total: 6, controller: null, contested: true });
    const w = server.voteWeights(rows, ['fA', 'fB', 'fC']);
    expect(w.get('fA')).toBe(2);
    expect(w.get('fB')).toBe(2);
    expect(w.get('fC')).toBe(1);
    const why = server.weightBreakdown(rows, 'fA');
    expect(why.controlled.map((c: { label: string }) => c.label)).toEqual(['Inner Reach']);
    expect(why.contesting).toEqual([
      expect.objectContaining({ label: 'Outer Deep', contested: true, need: 1 }),
    ]);
  });

  it('a malformed sector is no sector: the world groups automatically', () => {
    const bad = { id: 'sbad', name: 'Nope', color: 'red' };
    const r = [toRow({ id: 'sol', name: 'S', type: 'star', parent: null, r: 0, period: 0 }),
      toRow({ id: 'q', name: 'Q', type: 'terrestrial', parent: 'sol', r: 400, sector: bad })];
    const b = [toBody({ id: 'sol', name: 'S', type: 'star', parent: null, r: 0, period: 0 }),
      toBody({ id: 'q', name: 'Q', type: 'terrestrial', parent: 'sol', r: 400, sector: bad })];
    expect(server.makeSystemRootOf(r)(`${G}:q`)).toBe(`${G}:q`);
    expect(makeSystemRootOf(b)('q')).toBe('q');
    expect(bodySector(b[1])).toBeNull();
    expect(server.bodySector(r[1])).toBeNull();
  });

  it('the map draws a sector as one band round its members, in the owner rule', () => {
    const factions = [
      { id: 'fA', name: 'A', color: '#ff0000' },
      { id: 'fB', name: 'B', color: '#0000ff' },
    ] as unknown as Faction[];
    const regions = computeSystemRegions(bodies, factions, []);
    const inner = regions.find(r => r.label === 'Inner Reach');
    const outer = regions.find(r => r.label === 'Outer Deep');
    expect(inner).toBeDefined();
    expect(outer).toBeDefined();
    // fA holds 2 of the 3 claimed worlds: exclusive. 1 v 1 is contested.
    expect(inner!.ownership).toMatchObject({ kind: 'exclusive', factionId: 'fA' });
    expect(outer!.ownership.kind).toBe('contested');
    // The sector's own colour is only an accent.
    expect(inner!.accent).toBe('#4ecdc4');
    // One band spanning every member's orbit.
    expect(inner!.shape.rInner).toBeLessThanOrEqual(100);
    expect(inner!.shape.rOuter).toBeGreaterThanOrEqual(300);
    expect(outer!.shape.rInner).toBeLessThanOrEqual(800);
    expect(outer!.shape.rOuter).toBeGreaterThanOrEqual(940);
    expect(inner!.shape.rOuter).toBeLessThanOrEqual(outer!.shape.rInner);
    expect(new Set(inner!.bodyIds)).toEqual(new Set(['mercury', 'p1', 'p2', 'm2']));
    expect(new Set(outer!.bodyIds)).toEqual(new Set(['g1', 'gm1', 'gm2', 'a1', 'a2', 'a3']));
    // Nothing else claims a sector world: no planet lane, no belt.
    const elsewhere = regions.filter(r => r !== inner && r !== outer).flatMap(r => r.bodyIds);
    for (const id of [...inner!.bodyIds, ...outer!.bodyIds]) expect(elsewhere).not.toContain(id);
    // The world outside every band keeps its own lane.
    expect(regions.some(r => r.label === 'Loner System')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A CUSTOM MAP WITHOUT SECTORS (2026-10-15 audit). Its worlds carry `cm_`
// ids; Sol's own collapses are off: no Core (the star is its name), no
// Kuiper/Plutino bands, and dwarfs never chain into a belt -- only three
// or more asteroids do. Both mirrors, one fixture.
// ---------------------------------------------------------------------------

const CUSTOM: Spec[] = [
  { id: 'sol', name: 'Kel', type: 'star', parent: null, r: 0, period: 0 },
  { id: 'cm_p1', name: 'Hearth', type: 'terrestrial', parent: 'sol', r: 300, owner: 'fA' },
  { id: 'cm_m1', name: 'Pip', type: 'moon', parent: 'cm_p1', r: 20 },
  { id: 'cm_d1', name: 'Dwarfa', type: 'dwarf', parent: 'sol', r: 800, owner: 'fA' },
  { id: 'cm_d2', name: 'Dwarfb', type: 'dwarf', parent: 'sol', r: 2000, owner: 'fB' },
  { id: 'cm_d3', name: 'Dwarfc', type: 'dwarf', parent: 'sol', r: 5000, owner: 'fC' },
  { id: 'cm_a1', name: 'Asta', type: 'asteroid', parent: 'sol', r: 1000 },
  { id: 'cm_a2', name: 'Astb', type: 'asteroid', parent: 'sol', r: 1050 },
  { id: 'cm_a3', name: 'Astc', type: 'asteroid', parent: 'sol', r: 1100 },
  { id: 'cm_a4', name: 'Astd', type: 'asteroid', parent: 'sol', r: 6000 },
  { id: 'cm_a5', name: 'Aste', type: 'asteroid', parent: 'sol', r: 6100 },
  { id: 'cm_a6', name: 'Astf', type: 'asteroid', parent: 'sol', r: 6200 },
];

describe('a custom map groups by its own rules, both mirrors', () => {
  const rows = CUSTOM.map(toRow);
  const bodies = CUSTOM.map(toBody);
  const sRoot = server.makeSystemRootOf(rows);
  const cRoot = makeSystemRootOf(bodies);

  it('every dwarf is its own system (they were one contested Kuiper Belt)', () => {
    for (const id of ['cm_d1', 'cm_d2', 'cm_d3']) {
      expect(sRoot(`${G}:${id}`)).toBe(`${G}:${id}`);
      expect(cRoot(id)).toBe(id);
    }
    const w = server.voteWeights(rows, ['fA', 'fB', 'fC']);
    expect([w.get('fA'), w.get('fB'), w.get('fC')]).toEqual([3, 2, 2]);
  });

  it('three or more asteroids make a belt, numbered outward', () => {
    const labels = (bs: { label: string; members: { id: string }[] }[]) => bs.map(b => [b.label, b.members.length]);
    expect(labels(findBelts(bodies))).toEqual([['Asteroid Belt', 3], ['Asteroid Belt 2', 3]]);
    expect(labels(server.findBelts(rows))).toEqual([['Asteroid Belt', 3], ['Asteroid Belt 2', 3]]);
  });

  it('the star is called its name, never The Core', () => {
    expect(sRoot(`${G}:sol`)).toBe(`${G}:sol`);
    expect(cRoot('sol')).toBe('sol');
    expect(server.systemLabel(rows, `${G}:sol`)).toBe('Kel');
    expect(systemLabel(bodies, 'sol')).toBe('Kel');
    const regions = computeSystemRegions(bodies, [], []);
    expect(regions.some(r => r.label === 'The Core')).toBe(false);
  });

  it('the two mirrors agree on every body', () => {
    for (const s of CUSTOM) expect(strip(sRoot(`${G}:${s.id}`))).toBe(cRoot(s.id));
  });
});

// ---------------------------------------------------------------------------
// SHIPPED MAPS ARE UNTOUCHED. The whole Sol catalogue (far systems too),
// with owners sprinkled through it, digested through every grouping
// output on both sides. The constants were taken from the code as it was
// BEFORE sectors existed (base 9729ee28); a change here means a map with
// no sectors no longer groups byte-for-byte as it did.
// ---------------------------------------------------------------------------

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

type Cat = {
  id: string; name: string; type: string; parent: string | null;
  orbit_radius: number; orbit_period: number; orbit_rp?: number; orbit_ra?: number;
};
const OWNERS = ['fA', 'fB', null, 'fC', null];
const SOL: Spec[] = (BODY_CATALOG as Cat[]).map((c, i) => ({
  id: c.id, name: c.name, type: c.type, parent: c.parent,
  r: c.orbit_radius, period: c.orbit_period,
  rp: c.orbit_rp ?? null, ra: c.orbit_ra ?? null,
  owner: c.type === 'star' ? null : OWNERS[i % OWNERS.length],
}));

describe('a map without sectors groups exactly as before', () => {
  it('server: roots, labels, belts, systems, weights', () => {
    const rows = SOL.map(toRow);
    const root = server.makeSystemRootOf(rows);
    const out = {
      roots: rows.map((r: { id: string }) => [r.id, root(r.id), server.systemLabel(rows, root(r.id))]),
      belts: server.findBelts(rows).map((b: { id: string; label: string; members: { id: string }[]; laneMembers: { id: string }[] }) =>
        [b.id, b.label, b.members.map(m => m.id), b.laneMembers.map(m => m.id)]),
      systems: server.summarizeSystems(rows),
      weights: [...server.voteWeights(rows, ['fA', 'fB', 'fC']).entries()],
      why: server.weightBreakdown(rows, 'fA'),
    };
    expect(rows.length).toBeGreaterThan(80);
    expect(fnv(JSON.stringify(out))).toBe(SERVER_DIGEST);
  });

  it('client: roots, labels, belts, map regions', () => {
    const bodies = SOL.map(toBody);
    const root = makeSystemRootOf(bodies);
    const factions = [
      { id: 'fA', name: 'A', color: '#ff0000' },
      { id: 'fB', name: 'B', color: '#00ff00' },
      { id: 'fC', name: 'C', color: '#0000ff' },
    ] as unknown as Faction[];
    const out = {
      roots: bodies.map(b => [b.id, root(b.id), systemLabel(bodies, root(b.id))]),
      belts: findBelts(bodies).map(b =>
        [b.id, b.label, b.members.map(m => m.id), b.laneMembers.map(m => m.id)]),
      regions: computeSystemRegions(bodies, factions, []),
    };
    expect(fnv(JSON.stringify(out))).toBe(CLIENT_DIGEST);
  });
});

const SERVER_DIGEST = '6216fb6e';
const CLIENT_DIGEST = '8a56f14';
