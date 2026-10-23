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
    [{ ...base(), orders: [{ type: 'warp' }] }, /must be move, strike, trade, mine or ram/],
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

// 2026-10-23: shields, a ram, megastructures, a loaded hold, the gate's
// birth and the Leviathan. Each key, and each mistake naming its field.
describe('expandScenario: set pieces', () => {
  it('reads shields on a world with cities', () => {
    const spec = expandScenario({ ...base(), worlds: [{ body: 'luna', owner: 'terra', cities: ['Tycho'], shields: 3 }] });
    expect(spec.worlds[0]).toMatchObject({ body: 'luna', shields: 3, thrusters: false, living: true });
    expect(expandScenario({ ...base(), worlds: [{ body: 'luna', cities: ['Tycho'] }] }).worlds[0].shields).toBeNull();
  });

  it('reads thrusters on a rogue asteroid station, and a ram from it', () => {
    const spec = expandScenario({
      ...base(),
      worlds: [{ body: 'midas', owner: 'mars', stations: 1, thrusters: true }],
      orders: [{ type: 'ram', asteroid: 'midas', target: 'earth', depart: '+2' }],
    });
    // An asteroid is never terraformed, so `living` is off by default here.
    expect(spec.worlds[0]).toMatchObject({ body: 'midas', thrusters: true, stations: 1, living: false });
    expect(spec.orders[0]).toMatchObject({ type: 'ram', asteroid: 'midas', target: 'earth', owner: 'mars' });
    expect(whenTick(spec.orders[0].depart, 10)).toBe(12);
  });

  it('reads megastructures: a site at a progress, or finished', () => {
    const spec = expandScenario({
      ...base(),
      megastructures: [
        { key: 'ws', kind: 'weapons_station', at: 'luna', owner: 'terra', progress: 0.9 },
        { key: 'gate_a', kind: 'warp_gate', at: 'mars', owner: 'mars', complete: true, name: 'Red Door' },
        { key: 'sink', kind: 'gravity_sink', at: 'earth', owner: 'terra' },
      ],
      ships: [{ key: 'fr', owner: 'terra', at: 'ws', class: 'freighter', count: 1, cargo: { metal: 400, credits: 250 } }],
    });
    expect(spec.megastructures[0]).toEqual({ key: 'ws', kind: 'weapons_station', at: 'luna', owner: 'terra', progress: 0.9, complete: false, name: null });
    expect(spec.megastructures[1]).toMatchObject({ complete: true, progress: 1, name: 'Red Door' });
    expect(spec.megastructures[2]).toMatchObject({ progress: 0, complete: false });
    // A ship group can stand at a site by its key; the hold rides along.
    expect(spec.ships[0]).toMatchObject({ at: 'ws', cargo: { metal: 400, gold: 250 } });
    expect(expandScenario({ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'corvette', count: 1 }] }).ships[0].cargo).toBeNull();
  });

  it('reads where a megastructure orbits: orbit in map units, angle in degrees', () => {
    const spec = expandScenario({
      ...base(),
      megastructures: [{ key: 'ws', kind: 'weapons_station', at: 'mars', owner: 'mars', complete: true, orbit: 20, angle: -140 }],
    });
    expect(spec.megastructures[0]).toMatchObject({ orbit: 20, angle: 220 });
  });

  it('keeps the worlds of a scene quiet unless it asks for secrets', () => {
    expect(expandScenario(base()).secrets).toBe(false);
    expect(expandScenario({ ...base(), secrets: true }).secrets).toBe(true);
  });

  it("reads gates: 'birth', and keeps gates: true", () => {
    const birth = expandScenario({ ...base(), gates: 'birth' });
    expect(birth.gates).toBe('birth');
    expect(birth.farSystems).toBe(true);
    expect(expandScenario({ ...base(), gates: true }).gates).toBe(true);
    expect(expandScenario(base()).gates).toBe(false);
  });

  it('reads the Leviathan: far systems and a gate come with it', () => {
    const spec = expandScenario({ ...base(), kaiju: { at: 'europa', charge_ticks: 4, hp: 6000 } });
    expect(spec.kaiju).toEqual({ at: 'europa', chargeTicks: 4, hp: 6000 });
    expect(spec.gates).toBe(true);
    expect(spec.farSystems).toBe(true);
    // The game's own wind-up when the scene does not say; a birth stays a birth.
    const plain = expandScenario({ ...base(), gates: 'birth', kaiju: { at: 'callisto' } });
    expect(plain.kaiju).toEqual({ at: 'callisto', chargeTicks: 24, hp: null });
    expect(plain.gates).toBe('birth');
  });

  it.each([
    [{ ...base(), worlds: [{ body: 'luna', cities: ['Tycho'], shields: 11 }] }, /worlds\[0\]\.shields must be a level from 1 to 10/],
    [{ ...base(), worlds: [{ body: 'luna', cities: ['Tycho'], shields: 2.5 }] }, /worlds\[0\]\.shields/],
    [{ ...base(), worlds: [{ body: 'luna', shields: 2 }] }, /shields stand on cities/],
    [{ ...base(), worlds: [{ body: 'midas', thrusters: true }] }, /thrusters are a station building/],
    [{ ...base(), worlds: [{ body: 'luna', stations: 1, thrusters: true }] }, /luna is not a rogue asteroid/],
    [{ ...base(), worlds: [{ body: 'midas', stations: 1, thrusters: 'yes' }] }, /thrusters must be true or false/],
    [{ ...base(), worlds: [{ body: 'midas', stations: 1, thrusters: true, living: true }] }, /cannot be terraformed/],
    [{ ...base(), orders: [{ type: 'ram', asteroid: 'midas', target: 'earth' }] }, /needs a worlds\[\] entry with stations: 1 and thrusters: true/],
    [{ ...base(), orders: [{ type: 'ram', asteroid: 'midas' }] }, /asteroid and target are required/],
    [{ ...base(), worlds: [{ body: 'midas', stations: 1, thrusters: true }], orders: [{ type: 'ram', asteroid: 'midas', target: 'midas' }] }, /cannot ram itself/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'death_star', at: 'luna', owner: 'terra' }] }, /megastructures\[0\]\.kind must be one of/],
    [{ ...base(), megastructures: [{ key: 'luna', kind: 'warp_gate', at: 'earth', owner: 'terra' }] }, /is a world id/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', at: 'earth', owner: 'venus' }] }, /unknown faction 'venus'/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', owner: 'terra' }] }, /megastructures\[0\]\.at/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', at: 'earth', owner: 'terra', progress: 1.5 }] }, /progress must be from 0 to 1/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', at: 'earth', owner: 'terra', orbit: -3 }] }, /orbit must be a distance/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', at: 'earth', owner: 'terra', angle: 'north' }] }, /angle must be in degrees/],
    [{ ...base(), megastructures: [{ key: 'ws', kind: 'warp_gate', at: 'earth', owner: 'terra' }, { key: 'ws', kind: 'null_field', at: 'mars', owner: 'mars' }] }, /duplicate megastructure key 'ws'/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'freighter', count: 1, cargo: { metal: -5 } }] }, /ships\[0\]\.cargo\.metal/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'freighter', count: 1, cargo: [400] }] }, /ships\[0\]\.cargo must be/],
    [{ ...base(), gates: 'open' }, /gates must be true .* or 'birth'/],
    [{ ...base(), kaiju: { charge_ticks: 4 } }, /kaiju\.at/],
    [{ ...base(), kaiju: { at: 'earth' } }, /earth is a homeworld/],
    [{ ...base(), kaiju: { at: 'jupiter' } }, /it eats terrestrial worlds, dwarfs and moons; jupiter is a gas-giant/],
    [{ ...base(), kaiju: { at: 'europa', charge_ticks: 0 } }, /kaiju\.charge_ticks/],
    [{ ...base(), kaiju: { at: 'europa', hp: 5 } }, /kaiju\.hp/],
    [{ ...base(), kaiju: 'europa' }, /kaiju must be/],
  ])('rejects a bad set piece with the field named (%#)', (scene, msg) => {
    expect(() => expandScenario(scene)).toThrow(msg);
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
