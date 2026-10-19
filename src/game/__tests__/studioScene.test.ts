/**
 * @jest-environment node
 */
// The studio's scene language (worker/studioScene.js): what a director
// writes becomes a checked plan, and every mistake names its field.
import { expandScenario, EXAMPLES, LOADOUT_PRESETS, whenTick } from '../../../worker/studioScene.js';

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
    [{ ...base(), orders: [{ type: 'warp' }] }, /must be move, strike or trade/],
    [{ ...base(), ships: [{ key: 'a', owner: 'terra', at: 'earth', class: 'corvette', count: 1 }], orders: [{ type: 'move', ships: 'a', to: 'luna', depart: 'soon' }] }, /\+N/],
  ])('rejects a bad scene with the field named', (scene, msg) => {
    expect(() => expandScenario(scene)).toThrow(msg);
  });
});
