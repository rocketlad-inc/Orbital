/**
 * @jest-environment node
 */
// The studio's scene language (worker/studioScene.js): what a director
// writes becomes a checked plan, and every mistake names its field.
import { expandScenario, EXAMPLES, LOADOUT_PRESETS, whenTick, solveMoveTiming } from '../../../worker/studioScene.js';

const base = () => ({
  name: 'Test',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
});

describe('expandScenario', () => {
  it('accepts every shipped example', () => {
    for (const [key, ex] of Object.entries(EXAMPLES)) {
      const spec = expandScenario(ex);
      expect(spec.name).toBe((ex as { name: string }).name);
      expect(spec.factions.length).toBeGreaterThanOrEqual(2);
      // Every order points at a ship group that exists.
      for (const o of spec.orders) {
        const ref = (o as { ships?: string; ship?: string }).ships ?? (o as { ship?: string }).ship ?? '';
        expect(spec.ships.some(g => g.key === ref.split('.')[0])).toBe(true);
      }
      expect(key).toBeTruthy();
    }
  });

  it('expands "wars: all" to every pair once', () => {
    const spec = expandScenario({ ...base(), factions: [...base().factions, { key: 'jove', name: 'J', home: 'ganymede' }], wars: 'all' });
    expect(spec.wars).toEqual([['terra', 'mars'], ['terra', 'jove'], ['mars', 'jove']]);
  });

  it('turns class+count or a mix into a hull list with a loadout preset', () => {
    const spec = expandScenario({
      ...base(),
      ships: [
        { key: 'a', owner: 'terra', at: 'earth', class: 'destroyer', count: 3 },
        { key: 'b', owner: 'mars', at: 'mars', mix: { corvette: 2, frigate: 1 }, loadout: 'energy', hp: 2 },
      ],
    });
    expect(spec.ships[0].hulls).toEqual(['destroyer', 'destroyer', 'destroyer']);
    expect(spec.ships[0].loadout).toBe('mixed');
    expect(spec.ships[1].hulls.sort()).toEqual(['corvette', 'corvette', 'frigate']);
    expect(spec.ships[1].hp).toBe(2);
    expect(LOADOUT_PRESETS.energy('frigate', 0)).toContain('energy');
    expect(LOADOUT_PRESETS.mixed('destroyer', 2)).toContain('flak');
  });

  it('defaults the viewer to the first faction and seat_me off', () => {
    const spec = expandScenario(base());
    expect(spec.viewer).toBe('terra');
    expect(spec.seatMe).toBe(false);
    expect(spec.reset).toBe(true);
    expect(spec.factions[0].handle).toBe('studio-terra');
  });

  it('reads laws: a slider law for everyone, a sanction with its target and ballots', () => {
    const spec = expandScenario({
      ...base(),
      laws: [
        { slider: 'combat_damage_multiplier', value: 2 },
        { kind: 'war_authorization', target: 'mars', yea: ['terra'], nay: ['mars'], ticks: 10 },
      ],
    });
    expect(spec.laws).toHaveLength(2);
    expect(spec.laws[0]).toMatchObject({ kind: 'law', slider: 'combat_damage_multiplier', value: 2, target: null, proposer: 'terra', ticks: 24, yea: null });
    expect(spec.laws[1]).toMatchObject({ kind: 'war_authorization', target: 'mars', proposer: 'terra', ticks: 10, yea: ['terra'], nay: ['mars'] });
    expect(() => expandScenario({ ...base(), laws: [{ kind: 'trade_embargo' }] })).toThrow(/needs a target/);
    expect(() => expandScenario({ ...base(), laws: [{ slider: 'Bad Slider', value: 1 }] })).toThrow(/slider/);
    expect(() => expandScenario({ ...base(), laws: [{ kind: 'war_authorization', target: 'venus' }] })).toThrow(/unknown faction/);
  });

  it('reads silos: full stock by default, auto fleets, bounded numbers', () => {
    const spec = expandScenario({ ...base(), silos: [{ world: 'earth', level: 3, salvo: 4 }, { world: 'mars', owner: 'mars', stock: 99, auto: 'missiles' }] });
    expect(spec.silos[0]).toMatchObject({ world: 'earth', owner: null, level: 3, stock: 15, auto: 'fleets', salvo: 4, reserve: 0 });
    expect(spec.silos[1]).toMatchObject({ world: 'mars', owner: 'mars', level: 1, stock: 5, auto: 'missiles' });
    expect(() => expandScenario({ ...base(), silos: [{ world: 'earth', auto: 'always' }] })).toThrow(/auto/);
    expect(() => expandScenario({ ...base(), silos: [{ world: 'earth', owner: 'venus' }] })).toThrow(/unknown faction/);
  });

  it('reads a group target order: a preset name or a list', () => {
    const big = expandScenario({ ...base(), ships: [{ key: 'g', owner: 'terra', at: 'earth', class: 'frigate', count: 2, priority: 'big' }] });
    expect(big.ships[0].priority[0]).toBe('capital');
    const list = expandScenario({ ...base(), ships: [{ key: 'g', owner: 'terra', at: 'earth', class: 'frigate', count: 2, priority: ['destroyer', 'capital'] }] });
    expect(list.ships[0].priority).toEqual(['destroyer', 'capital']);
    expect(() => expandScenario({ ...base(), ships: [{ key: 'g', owner: 'terra', at: 'earth', class: 'frigate', count: 2, priority: 'everything' }] })).toThrow(/priority/);
  });

  it('parses relative and absolute times', () => {
    const spec = expandScenario({
      ...base(),
      ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'corvette', count: 2 }],
      orders: [
        { type: 'move', ships: 'a', to: 'luna', depart: '+3' },
        { type: 'move', ships: 'a.1', to: 'mars', depart: 40, arrive: 60 },
      ],
    });
    expect(whenTick(spec.orders[0].depart, 10)).toBe(13);
    expect(whenTick(spec.orders[1].depart, 10)).toBe(40);
    expect(whenTick(spec.orders[1].arrive!, 10)).toBe(60);
  });

  it.each([
    [{ factions: [{ key: 'terra', home: 'earth' }] }, /at least 2 factions/],
    [{ ...base(), factions: [{ key: 'Bad Key', home: 'earth' }, { key: 'b', home: 'mars' }] }, /factions\[0\]\.key/],
    [{ ...base(), factions: [{ key: 'a', home: 'nowhere' }, { key: 'b', home: 'mars' }] }, /not a starting world/],
    [{ ...base(), wars: [['terra', 'venus']] }, /unknown faction 'venus'/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'battleship', count: 1 }] }, /unknown class/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'corvette', count: 1, loadout: 'laser' }] }, /loadout/],
    [{ ...base(), orders: [{ type: 'move', ships: 'ghost', to: 'luna' }] }, /unknown ship group 'ghost'/],
    [{ ...base(), orders: [{ type: 'warp' }] }, /must be move, strike, trade or mine/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'freighter', count: 1 }], orders: [{ type: 'mine', ship: 'a', to: 'earth' }] }, /rock and to/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'uranus', class: 'colony', count: 1 }], orders: [{ type: 'move', ships: 'a', to: 'verdant', settle: 'city' }] }, /settle must be 'station'/],
    [{ ...base(), dyson: { owner: 'venus' } }, /unknown faction 'venus'/],
    [{ ...base(), meteoroids: [{ tons: 50 }] }, /meteoroids\[0\]\.body/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'corvette', count: 1 }], orders: [{ type: 'move', ships: 'a', to: 'luna', depart: 'soon' }] }, /\+N/],
  ])('rejects a bad scene with the field named', (scene, msg) => {
    expect(() => expandScenario(scene)).toThrow(msg);
  });

  it('reads the far systems, the Dyson Sphere, meteoroids, mining and settling', () => {
    const spec = expandScenario({
      ...base(),
      gates: true,
      dyson: { owner: 'terra', progress: 1.5, station_hp: 9000 },
      meteoroids: [{ body: 'mtr_belt_0', tons: 120 }],
      ships: [
        { key: 'fr', owner: 'terra', at: 'mars', class: 'freighter', count: 1, loadout: ['mining'] },
        { key: 'col', owner: 'terra', at: 'uranus', class: 'colony', count: 1 },
      ],
      orders: [
        { type: 'mine', ship: 'fr', rock: 'mtr_belt_0', to: 'earth' },
        { type: 'move', ships: 'col', to: 'sun_gate', settle: 'station' },
      ],
    });
    expect(spec.gates).toBe(true);
    expect(spec.farSystems).toBe(true);                       // gates bring the far systems with them
    expect(spec.dyson).toEqual({ owner: 'terra', progress: 0.99, stationHp: 9000 });   // never complete: that ends the game
    expect(spec.meteoroids).toEqual([{ body: 'mtr_belt_0', tons: 120, discoveredBy: 'all' }]);
    expect(spec.orders[0]).toMatchObject({ type: 'mine', ship: 'fr', rock: 'mtr_belt_0', to: 'earth', loops: 1 });
    expect(spec.orders[1]).toMatchObject({ type: 'move', to: 'sun_gate', settle: 'station' });
  });
});

// A scene's `arrive` used to be handed to the leg planner as the arrival,
// which shapes the burn to land on it: a 16-tick hop asked to take 40 flew
// on a twentieth of its engine and crawled through the shot (Lorne,
// 2026-10-21). Now a later arrival is a later DEPARTURE on the real engine.
describe('solveMoveTiming', () => {
  const trip16 = async () => 16;

  it('with no arrival asked, leaves at the earliest and lands when it lands', async () => {
    expect(await solveMoveTiming({ earliest: 11, want: null, tripAt: trip16 })).toEqual({ depart: 11, arrive: 27, late: false });
  });

  it('a later arrival is a later departure, not a slower burn', async () => {
    // Asked to land at 50 on a 16-tick trip: leave at 34, on its own engine.
    expect(await solveMoveTiming({ earliest: 11, want: 50, tripAt: trip16 })).toEqual({ depart: 34, arrive: 50, late: false });
  });

  it('follows a trip that changes with the departure (the worlds move)', async () => {
    const tripAt = async (d: number) => 10 + Math.floor((d - 10) / 5);   // longer the later it leaves
    const r = await solveMoveTiming({ earliest: 10, want: 60, tripAt });
    expect(r.late).toBe(false);
    expect(r.arrive).toBe(r.depart + (await tripAt(r.depart)));
    expect(r.arrive).toBeLessThanOrEqual(60);
    expect(r.arrive).toBeGreaterThan(58);
  });

  it('too soon to make it: leaves now, arrives as soon as it can, and says so', async () => {
    expect(await solveMoveTiming({ earliest: 11, want: 20, tripAt: trip16 })).toEqual({ depart: 11, arrive: 27, late: true });
  });

  it('never leaves before the depart it was given', async () => {
    expect(await solveMoveTiming({ earliest: 40, want: 50, tripAt: trip16 })).toEqual({ depart: 40, arrive: 56, late: true });
  });
});
