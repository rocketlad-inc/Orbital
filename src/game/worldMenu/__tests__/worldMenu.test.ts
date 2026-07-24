// ============================================================
// World-menu pure-logic suite — port of the v2 spec's [pure] tests
// (qa mockup: 71/71). DOM/geometry [cmp] tests live in the in-browser
// self-test page; everything here runs under plain Jest.
//
// Spec ids preserved in test names so failures map straight back to
// the requirement doc.
// ============================================================

import {
  Z1_FRAC, S1X_FRAC, S1Y_FRAC,
  MENU_FADE_START, FURN_FADE_START, FURN_FADE_LEN,
  menuScaleFor, zOf, scaleAt, menuOpacity, furnitureOpacity,
  menuCameraOffset, focusedBodyScreenCircle, FOCUS_BASE_SCALE,
} from '../camera';
import { columnsFor, buildStatus, costText, noHostText } from '../buildRules';
import { hpColor, flameCount, FIRE_THRESH } from '../combatDisplay';
import { readoutFor, neighborsOf } from '../bodyStats';
import { Body, Settlement, Ship } from '../../../types';

// ---------- fixtures ----------
const mkBody = (o: Partial<Body>): Body => ({
  id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol',
  radius: 3, soi: 54, mu: 100, color: '#4a90d9',
  orbitRadius: 186, orbitPeriod: 205, angle0: 0,
  resources: { fuel: 3, gold: 2, metal: 3, science: 5 },
  ...o,
} as Body);

const mkSettlement = (o: Partial<Settlement>): Settlement => ({
  id: 's1', type: 'city', name: 'New Geneva', bodyId: 'earth', ownedBy: 'player',
  hp: 200, maxHp: 200, population: 3, lastGrowthTick: 0,
  stockpile: { fuel: 0, ore: 5, credits: 2, science: 1 }, lastHarvestTick: 0,
  ...o,
} as Settlement);

const mkShip = (o: Partial<Ship>): Ship => ({
  id: 'sh1', name: 'V1', class: 'corvette', ownedBy: 'player',
  orbit: { parentBodyId: 'earth' },
  ...o,
} as unknown as Ship);

const EARTH = mkBody({});
const SATURN = mkBody({ id: 'saturn', type: 'gas_giant', radius: 7 });

// ---------- A · camera math ----------
describe('A · camera & zoom math', () => {
  const H = 700, W = 900;

  test('A1: endpoints exact — scaleAt(0)=base, scaleAt(1)=menu framing', () => {
    expect(scaleAt(1, EARTH, H)).toBeCloseTo(menuScaleFor(EARTH, H), 9);
    expect(scaleAt(0, EARTH, H)).toBeCloseTo(
      Math.min(FOCUS_BASE_SCALE, menuScaleFor(EARTH, H) * 0.5), 9);
    expect(menuScaleFor(EARTH, H)).toBeCloseTo((Z1_FRAC * H) / EARTH.radius, 9);
  });

  test('A3 [P0]: screen radius strictly increasing across the dive', () => {
    let prev = 0;
    for (let i = 0; i <= 10; i++) {
      const r = EARTH.radius * scaleAt(i / 10, EARTH, H);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  test('A4: scale is geometric in z (pow, not linear)', () => {
    const ratios: number[] = [];
    for (let i = 0; i < 10; i++) {
      ratios.push(scaleAt((i + 1) / 10, EARTH, H) / scaleAt(i / 10, EARTH, H));
    }
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.0001);
  });

  test('A5 [P0]: upper-limb framing bounded both ways at z=1', () => {
    const s1 = scaleAt(1, EARTH, H);
    const off = menuCameraOffset(W, H, s1);
    const c = focusedBodyScreenCircle(EARTH, off, s1, W, H);
    expect(c.r).toBeGreaterThanOrEqual(0.42 * H);
    expect(c.r).toBeLessThanOrEqual(0.55 * H);
    expect(c.y).toBeGreaterThan(H);                 // centre below the frame
    const top = c.y - c.r;
    expect(top).toBeGreaterThanOrEqual(0.40 * H);   // not too far…
    expect(top).toBeLessThanOrEqual(0.60 * H);      // …not too small
    expect(c.x).toBeCloseTo(S1X_FRAC * W, 6);
    expect(c.y).toBeCloseTo(S1Y_FRAC * H, 6);
  });

  test('A6: radius-independence — any body fills Z1_FRAC·H at z=1', () => {
    for (const b of [EARTH, SATURN, mkBody({ id: 'luna', radius: 1.5 })]) {
      expect(b.radius * scaleAt(1, b, H)).toBeCloseTo(Z1_FRAC * H, 6);
    }
  });

  test('A7: zOf clamps to [0,1] and round-trips scaleAt', () => {
    expect(zOf(0.0001, EARTH, H)).toBe(0);
    expect(zOf(1e6, EARTH, H)).toBe(1);
    for (const z of [0, 0.25, 0.5, 0.75, 1]) {
      expect(zOf(scaleAt(z, EARTH, H), EARTH, H)).toBeCloseTo(z, 9);
    }
  });

  test('A8: framing holds at other viewport sizes (no absolute px leaks)', () => {
    for (const [w, h] of [[1200, 800], [500, 600]] as const) {
      const s1 = scaleAt(1, EARTH, h);
      const c = focusedBodyScreenCircle(EARTH, menuCameraOffset(w, h, s1), s1, w, h);
      expect(c.r).toBeGreaterThanOrEqual(0.42 * h);
      expect(c.r).toBeLessThanOrEqual(0.55 * h);
      expect(c.y).toBeGreaterThan(h);
    }
  });

  test('G9 [P0] fade bands: clean menu sky, furniture restored at map', () => {
    expect(menuOpacity(1)).toBe(1);
    expect(menuOpacity(MENU_FADE_START)).toBe(0);
    expect(furnitureOpacity(1)).toBe(0);
    expect(furnitureOpacity(0)).toBe(1);
    expect(furnitureOpacity(FURN_FADE_START + FURN_FADE_LEN)).toBe(0);
  });
});

// ---------- F · build & gating rules ----------
describe('F · build rules', () => {
  test('F1 [P0]: surface column only on city-capable bodies', () => {
    expect(columnsFor(EARTH).surface).toEqual(['forge', 'mint', 'lab']);
    expect(columnsFor(SATURN).surface).toEqual([]);
  });

  test('F2 [P0]: lab (hostType any) is buildable on EVERY station', () => {
    // 2026-07-22: labs belong to stations everywhere, not just where
    // there's no surface — matches worker BUILDING_DEFS hostType 'any'.
    expect(columnsFor(SATURN).orbit).toContain('lab');
    expect(columnsFor(EARTH).orbit).toEqual(['weapons', 'shipyard', 'lab']);
  });

  test('F4: status text formats', () => {
    const city = mkSettlement({});
    expect(buildStatus('forge', city, { currentTick: 0, noHostText: 'no surface' }))
      .toMatchObject({ state: 'ready', level: 0, text: 'not built · 40 metal' });
    const leveled = mkSettlement({ buildings: { forge: 2 } });
    const st = buildStatus('forge', leveled, { currentTick: 0, noHostText: 'x' });
    expect(st.state).toBe('ready');
    expect(st.text).toMatch(/^LV 2 ↑ · /);
    const queued = mkSettlement({
      buildingQueue: { id: 'q', settlementId: 's1', kind: 'mint', targetLevel: 1, startTick: 0, completeTick: 20 },
    });
    expect(buildStatus('mint', queued, { currentTick: 5, noHostText: 'x' }))
      .toMatchObject({ state: 'queued', ticksLeft: 15, text: 'building LV 1 · T-15' });
    expect(buildStatus('forge', null, { currentTick: 0, noHostText: 'no surface' }))
      .toMatchObject({ state: 'no-host', text: 'no surface' });
  });

  test('cost scaling follows BUILDING_DEFS (1.6^level, ceil)', () => {
    expect(costText('forge', 0)).toBe('40 metal');
    expect(costText('forge', 1)).toBe('64 metal');   // 40·1.6
    expect(costText('shipyard', 0)).toBe('50 metal + 30 cr');
  });

  test('lock wording per column', () => {
    expect(noHostText('surface', SATURN)).toBe('no surface');
    expect(noHostText('surface', EARTH)).toBe('no city yet');
    expect(noHostText('orbit', EARTH)).toBe('no station yet');
  });
});

// ---------- I · combat display ----------
describe('I · combat display', () => {
  test('I2: HP color thresholds at exact boundaries', () => {
    expect(hpColor(0.61)).toBe('#66bb6a');
    expect(hpColor(0.6)).toBe('#ffb84d');
    expect(hpColor(0.31)).toBe('#ffb84d');
    expect(hpColor(0.3)).toBe('#ef5350');
  });

  test('I3: fire threshold + monotone intensity', () => {
    expect(flameCount(1, 5)).toBe(0);
    expect(flameCount(FIRE_THRESH, 5)).toBe(0);
    expect(flameCount(FIRE_THRESH - 0.01, 5)).toBeGreaterThanOrEqual(1);
    let prev = 0;
    for (const r of [0.8, 0.6, 0.4, 0.2, 0]) {
      const n = flameCount(r, 5);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(flameCount(0, 5)).toBeLessThanOrEqual(5);
  });
});

// ---------- E · body readout ----------
describe('E · body readout', () => {
  const city = mkSettlement({ id: 'c1', population: 4 });
  const station = mkSettlement({
    id: 't1', type: 'station', name: 'High Guard', population: 2,
    hp: 80, maxHp: 100, buildings: { weapons: 2, shipyard: 1 },
    stockpile: { fuel: 1, ore: 0, credits: 3, science: 4 },
  });

  test('E1 [P0]: full readout fields present', () => {
    const r = readoutFor(EARTH, [city, station], [mkShip({}), mkShip({ id: 'sh2' })], 'player');
    expect(r.ownerFactionId).toBe('player');
    expect(r.pop).toBe(6);
    expect(r.city).toMatchObject({ name: 'New Geneva', hp: 200, maxHp: 200 });
    expect(r.station).toMatchObject({ name: 'High Guard', hp: 80, maxHp: 100 });
    expect(r.shipCount).toBe(2);
    expect(r.yields.ore).toBeGreaterThan(0);
    expect(r.stockpile.ore).toBe(5);
    expect(r.stockpile.science).toBe(5);
  });

  test('E2: defense = armed-station return fire only (cities never fire)', () => {
    const r = readoutFor(EARTH, [city, station], [], 'player');
    // City contributes 0 (civilian). Station fires only with weapons:
    // level 2 × 8 dmg/level = 16.
    expect(r.defense).toBe(16);
  });

  test('rival settlements show owner but hide books', () => {
    const rival = mkSettlement({ id: 'r1', ownedBy: 'dominion' });
    const r = readoutFor(EARTH, [rival], [], 'player');
    expect(r.ownerFactionId).toBe('dominion');
    expect(r.yields.ore).toBe(0);
    expect(r.stockpile.ore).toBe(0);
  });

  test('ships in transit are not "here"', () => {
    const transiting = mkShip({ id: 'sh3', transit: { departTick: 0 } as unknown as Ship['transit'] });
    const r = readoutFor(EARTH, [city], [transiting], 'player');
    expect(r.shipCount).toBe(0);
  });
});

// ---------- D/C · neighbors ----------
describe('D · neighbors (sky orbs)', () => {
  const bodies: Body[] = [
    mkBody({ id: 'earth', parent: 'sol' }),
    mkBody({ id: 'luna', parent: 'earth', type: 'moon', radius: 1.5 }),
    mkBody({ id: 'saturn', parent: 'sol', type: 'gas_giant', radius: 7 }),
    mkBody({ id: 'titan', parent: 'saturn', type: 'moon', radius: 2 }),
    mkBody({ id: 'rhea', parent: 'saturn', type: 'moon', radius: 1 }),
  ];

  test('D1: moon → parent + siblings; planet → moons', () => {
    expect(neighborsOf('titan', bodies).map(b => b.id)).toEqual(['saturn', 'rhea']);
    expect(neighborsOf('earth', bodies).map(b => b.id)).toEqual(['luna']);
  });

  test('C6 [P0]: never throws on null/unknown focus', () => {
    expect(neighborsOf(null, bodies)).toEqual([]);
    expect(neighborsOf(undefined, bodies)).toEqual([]);
    expect(neighborsOf('nope', bodies)).toEqual([]);
  });
});
