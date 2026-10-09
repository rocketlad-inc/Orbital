// A PUBLIC RECAP LINK MUST NOT BE A WINDOW ONTO THE LIVE GAME
// (worker/recapMap.js filterRow).
//
// The battle recap plays on the match film's map, and a match snapshot
// records every fleet in the system, every stockpile and every pact.
// Anyone can open a recap link, including players in the same game, so
// the server sends only this battle: hulls that fought or sat at its
// world, that world's settlements, and nothing else.

import { filterRow, recapContext } from '../../../worker/recapMap.js';

const BODY = 'g:mars';
const ship = (id: string, parent: string | null, fid = 'g:f1') =>
  ['s', id, fid, 'corvette', parent, null, null, null, null, null, null, 40, null, 'A'];
const stl = (id: string, body: string, fid = 'g:f1') => ['t', id, body, fid, 'city', 3, 0];

function run(rows: Array<{ t: number; kind: 'key' | 'delta'; put: any[][]; del?: string[] }>, participants: string[]) {
  const kept = new Set<string>();
  return rows.map(r => filterRow(
    { t: r.t, kind: r.kind, state: { v: 1, put: r.put, del: r.del ?? [] } },
    { bodyId: BODY, participants: new Set(participants), kept },
  ));
}

it('keeps the fighters and the battle world, drops the rest of the system', () => {
  const [key] = run([{ t: 110, kind: 'key', put: [
    ship('g:a', BODY),               // at Mars
    ship('g:b', 'g:earth'),          // elsewhere, not in the battle
    ship('g:c', 'g:venus'),          // elsewhere now, but fights later
    stl('g:mars:c1', BODY),
    stl('g:earth:c1', 'g:earth'),
    ['f', 'g:f1', 0, 500, 0, 900, 40],   // a stockpile
    ['p', 'g:f1|g:f2', 0, 'g:f1', 'g:f2'], // a pact
  ] }], ['g:a', 'g:c']);
  const ids = key.state.put.map(r => r[1]);
  expect(ids).toEqual(['g:a', 'g:c', 'g:mars:c1']);
  expect(key.state.put.some(r => r[0] === 'f' || r[0] === 'p')).toBe(false);
});

it('an onlooker that leaves the world leaves the reel, without saying where it went', () => {
  const out = run([
    { t: 110, kind: 'key', put: [ship('g:watcher', BODY)] },
    { t: 111, kind: 'delta', put: [ship('g:watcher', 'g:jupiter')] },
  ], []);
  expect(out[0].state.put.map(r => r[1])).toEqual(['g:watcher']);
  expect(out[1].state.put).toEqual([]);
  expect(out[1].state.del).toEqual(['s:g:watcher']);
});

it('a fighter is followed wherever it flies during the window', () => {
  const out = run([
    { t: 110, kind: 'key', put: [ship('g:a', 'g:earth')] },
    { t: 112, kind: 'delta', put: [ship('g:a', null)] },
    { t: 114, kind: 'delta', put: [ship('g:a', BODY)] },
  ], ['g:a']);
  expect(out.every(r => r.state.put.length === 1)).toBe(true);
});

it('deletions of things the reel never showed are not passed on', () => {
  const out = run([
    { t: 110, kind: 'key', put: [ship('g:a', BODY)] },
    { t: 111, kind: 'delta', put: [], del: ['s:g:a', 's:g:secret', 'f:g:f1', 'p:x'] },
  ], ['g:a']);
  expect(out[1].state.del).toEqual(['s:g:a']);
});

it('a settlement elsewhere never appears, even when it changes hands', () => {
  const out = run([
    { t: 110, kind: 'key', put: [stl('g:earth:c1', 'g:earth', 'g:f1')] },
    { t: 111, kind: 'delta', put: [stl('g:earth:c1', 'g:earth', 'g:f2')] },
  ], []);
  expect(out.flatMap(r => r.state.put)).toEqual([]);
});

describe('the war around a battle', () => {
  /** A D1 that answers recapContext's five statements. */
  function env({ wars, battles, capital = null }: { wars: any[]; battles: any[]; capital?: string | null }) {
    return {
      DB: {
        prepare(sql: string) {
          const run = () => {
            if (sql.includes('FROM battles WHERE id')) {
              return { first: { id: 'b2', body_id: 'g:mars', started_tick: 120, ended_tick: 130, faction_ids: '["g:f1","g:f2","g:f3"]' } };
            }
            if (sql.includes('FROM game_wars')) return { all: wars };
            if (sql.includes('FROM game_bodies')) return { first: { yield_metal: 4, yield_gold: 2, yield_science: 1, terraformed_at_tick: 125, type: 'terrestrial' } };
            if (sql.includes('capital_body_id')) return { first: capital ? { id: capital } : null };
            if (sql.includes('FROM battles bt')) return { all: battles };
            throw new Error('unexpected ' + sql);
          };
          return { bind: () => ({ first: async () => run().first ?? null, all: async () => ({ results: run().all ?? [] }) }) };
        },
      },
    };
  }
  const read = async (res: Response) => JSON.parse(await (res as any).text());
  // jest's node lacks Response; recapContext only needs json().
  beforeAll(() => {
    if (!(globalThis as any).Response) {
      (globalThis as any).Response = class { constructor(public body: string) {} async text() { return this.body; } };
    }
  });

  it('names the wars between empires that were both there, and the stakes as they stood', async () => {
    const res = await recapContext(env({
      wars: [
        { faction_a: 'g:f1', faction_b: 'g:f2', declared_by: 'g:f2', declared_at_tick: 98, origin: 'pact_broken' },
        { faction_a: 'g:f1', faction_b: 'g:f9', declared_by: 'g:f1', declared_at_tick: 90, origin: 'declared' },
      ],
      battles: [],
      capital: 'g:f1',
    }) as any, { battle_id: 'b2', game_id: 'g' });
    const j = await read(res);
    expect(j.wars).toEqual([{ a: 'g:f1', b: 'g:f2', declaredBy: 'g:f2', declaredAt: 98, origin: 'pact_broken' }]);
    expect(j.stake).toMatchObject({ capitalOf: 'g:f1', terraformed: true, yields: { metal: 4, credits: 2, science: 1 } });
  });

  it('finds the battles before and after in the same war, with their links', async () => {
    const res = await recapContext(env({
      wars: [{ faction_a: 'g:f1', faction_b: 'g:f2', declared_by: 'g:f1', declared_at_tick: 98, origin: 'declared' }],
      battles: [
        { id: 'b1', body_name: 'Phobos', started_tick: 101, ships_lost: 4, faction_ids: '["g:f1","g:f2"]', token: 'tok1aaaaaa' },
        { id: 'bx', body_name: 'Juno', started_tick: 110, ships_lost: 9, faction_ids: '["g:f1","g:f7"]', token: 'tokxxxxxxx' },
        { id: 'b2', body_name: 'Mars', started_tick: 120, ships_lost: 45, faction_ids: '["g:f1","g:f2","g:f3"]', token: 'tok2aaaaaa' },
        { id: 'b3', body_name: 'Deimos', started_tick: 140, ships_lost: 6, faction_ids: '["g:f2","g:f1"]', token: 'tok3aaaaaa' },
      ],
    }) as any, { battle_id: 'b2', game_id: 'g' });
    const j = await read(res);
    expect(j.series).toEqual({
      prev: { token: 'tok1aaaaaa', name: 'Phobos', tick: 101, lost: 4 },
      next: { token: 'tok3aaaaaa', name: 'Deimos', tick: 140, lost: 6 },
      count: 3, index: 2,
    });
  });

  it('a game with no declared wars has no "why" and no series', async () => {
    const j = await read(await recapContext(env({ wars: [], battles: [] }) as any, { battle_id: 'b2', game_id: 'g' }));
    expect(j.wars).toEqual([]);
    expect(j.series).toEqual({ prev: null, next: null, count: 0 });
  });
});

it('keeps the reconstructed marker so the page can say so', () => {
  const kept = new Set<string>();
  const r = filterRow({ t: 5, kind: 'delta', state: { v: 1, syn: 1, put: [], del: [] } },
    { bodyId: BODY, participants: new Set(), kept });
  expect(r.state.syn).toBe(1);
});
