// THE BATTLE RECAP'S STORY (battleFilmModel.ts): pace, board, kills, ace.

import { pacing, filmSeconds, standingsAt, kills, ace, phaseAt, holderOf, outcomeOf, betrayals } from '../battleFilmModel';
import type { Detail } from '../BattleReview';

const P = (o: Partial<Detail['participants'][number]>) => ({
  ship_id: 's', faction_id: 'f1', ship_name: 'Hull', ship_class: 'corvette', hp_max: 40, hp_start: 40,
  hp_end: 0, first_tick: 100, last_tick: 110, died_tick: null, killer_faction_id: null,
  shots: 0, hits: 0, shots_taken: 0, hits_taken: 0, damage_dealt: 0, damage_taken: 0, kills: 0,
  icon_variant: null, parts: null, kind: 'ship', ...o,
}) as Detail['participants'][number];

const F = (tick: number, shots: number, killsN: number, log: Detail['frames'][number]['shot_log'] = []) =>
  ({ tick, seq: 0, shots, hits: shots, damage: shots * 5, kills: killsN, roster: [], shot_log: log });

const detail = (over: Partial<Detail> = {}): Detail => ({
  battle: { id: 'b', body_id: 'g:mars', body_name: 'Mars', started_tick: 100, last_fire_tick: 110, ended_tick: 110,
    status: 'ended', tick_count: 11, shots: 0, hits: 0, damage: 0, damage_raw: 0, ships_lost: 2, faction_count: 2,
    factions: [], victor: { id: 'f1', name: 'The UTEF', color: '#ffd23f' }, pacts_broken_during: [] },
  sides: [],
  participants: [
    P({ ship_id: 'a1', ship_name: 'LSS Firetail', captain_name: 'Vex Orlan', kills: 2, damage_dealt: 90 }),
    P({ ship_id: 'a2', ship_name: 'LSS Oriole', died_tick: 104 }),
    P({ ship_id: 'b1', faction_id: 'f2', ship_name: 'Dragonfly', died_tick: 103 }),
    P({ ship_id: 'b2', faction_id: 'f2', ship_name: 'Wasp', died_tick: 107, first_tick: 105, kills: 1, damage_dealt: 40 }),
    P({ ship_id: 'st', faction_id: 'f2', ship_name: 'Eadu Platform', kind: 'station' }),
  ],
  frames: [
    F(100, 4, 0),
    F(103, 6, 1, [{ a: 'a1', t: 'b1', hit: 1, dmg: 40, kill: 1 }]),
    F(104, 3, 1, [{ a: 'b2', t: 'a2', hit: 1, dmg: 40, kill: 1 }]),
    F(107, 2, 1, [{ a: 'a1', t: 'b2', hit: 1, dmg: 40, kill: 1 }, { a: 'a1', t: 'b2', hit: 1, dmg: 40, kill: 1 }]),
  ],
  factions: { f1: { name: 'The UTEF', color: '#ffd23f' }, f2: { name: 'Frowny Face', color: '#e0457b' } },
  body: null,
  ...over,
});

describe('pacing', () => {
  const d = detail();
  const r = pacing(d.frames, { lo: 98, hi: 113 }, { start: 100, end: 110 });

  it('covers every tick of the reel', () => {
    expect([...r.keys()]).toEqual(Array.from({ length: 16 }, (_, i) => 98 + i));
  });
  it('spends the seconds on the killing, and passes quiet ticks quickly', () => {
    expect(r.get(103)!).toBeGreaterThan(r.get(100)!);   // a kill beats a volley
    expect(r.get(100)!).toBeGreaterThan(r.get(101)!);   // a volley beats a lull
    expect(r.get(101)!).toBeGreaterThanOrEqual(0.2);
  });
  it('a battle lands in under a minute, however long it ran', () => {
    const long = Array.from({ length: 200 }, (_, i) => F(1000 + i, 5, i % 7 === 0 ? 1 : 0));
    const lr = pacing(long, { lo: 998, hi: 1203 }, { start: 1000, end: 1199 });
    let battle = 0;
    for (let t = 1000; t <= 1199; t++) battle += lr.get(t)!;
    expect(battle).toBeLessThanOrEqual(56);
    expect(filmSeconds(lr)).toBeLessThan(65);
  });
});

describe('the board', () => {
  it('lists every side at its full size from the start', () => {
    const b = standingsAt(detail(), 100);
    expect(b.map(s => [s.name, s.alive, s.total])).toEqual([['Frowny Face', 1, 2], ['The UTEF', 2, 2]]);
  });
  it('a fleet still on its way is arriving, not destroyed', () => {
    const late = detail({ participants: [P({ ship_id: 'x', faction_id: 'f2', first_tick: 106 })] });
    expect(standingsAt(late, 101)[0]).toMatchObject({ arrived: 0, alive: 0, total: 1 });
    expect(standingsAt(late, 106)[0]).toMatchObject({ arrived: 1, alive: 1, total: 1 });
  });

  it('counts losses as they happen, and reinforcements as they arrive', () => {
    expect(standingsAt(detail(), 105).map(s => [s.name, s.alive])).toEqual([['Frowny Face', 1], ['The UTEF', 1]]);
    expect(standingsAt(detail(), 108).map(s => [s.name, s.alive])).toEqual([['Frowny Face', 0], ['The UTEF', 1]]);
  });
  it('stations are not a fleet', () => {
    expect(standingsAt(detail(), 100).reduce((n, s) => n + s.total, 0)).toBe(4);
  });
});

describe('the kill feed', () => {
  it('names the victim, the killer and the captain, once per kill', () => {
    const k = kills(detail());
    expect(k.map(x => [x.tick, x.victim, x.killer, x.captain])).toEqual([
      [103, 'Dragonfly', 'LSS Firetail', 'Vex Orlan'],
      [104, 'LSS Oriole', 'Wasp', null],
      [107, 'Wasp', 'LSS Firetail', 'Vex Orlan'],
    ]);
  });
});

describe('the ace', () => {
  it('is the hull with the most kills', () => {
    expect(ace(detail())).toMatchObject({ ship: 'LSS Firetail', captain: 'Vex Orlan', kills: 2, faction: 'The UTEF' });
  });
  it('is nobody when nobody killed', () => {
    expect(ace(detail({ participants: [P({})] }))).toBeNull();
  });
});

describe('the world before and after', () => {
  const stls = (...rows: Array<[string, string | null, number]>) => rows.map(([body, fid, pop]) => ({ body, fid, pop }));

  it('the holder is whoever has the most people there', () => {
    expect(holderOf(stls(['g:mars', 'f1', 2], ['g:mars', 'f2', 5], ['g:earth', 'f3', 9]), 'g:mars')).toBe('f2');
    expect(holderOf(stls(['g:earth', 'f3', 9]), 'g:mars')).toBeNull();
  });

  it('says whether the world fell, held or was left empty', () => {
    expect(outcomeOf('f1', 'f2')).toEqual({ kind: 'fell', to: 'f2', from: 'f1' });
    expect(outcomeOf(null, 'f2')).toEqual({ kind: 'fell', to: 'f2', from: null });
    expect(outcomeOf('f1', 'f1')).toEqual({ kind: 'held', by: 'f1' });
    expect(outcomeOf('f1', null)).toEqual({ kind: 'emptied', from: 'f1' });
    expect(outcomeOf(null, null)).toBeNull();
  });

  it('betrayals come from the pairs at peace at the start and not at the end', () => {
    expect(betrayals(['g:f1|g:f2', 'bad', ''])).toEqual([['g:f1', 'g:f2']]);
    expect(betrayals(undefined)).toEqual([]);
  });
});

it('phases', () => {
  const b = { start: 100, end: 110 };
  expect([phaseAt(99, b), phaseAt(100, b), phaseAt(110, b), phaseAt(111, b)]).toEqual(['approach', 'battle', 'battle', 'aftermath']);
});
