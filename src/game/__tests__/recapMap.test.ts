// A PUBLIC RECAP LINK MUST NOT BE A WINDOW ONTO THE LIVE GAME
// (worker/recapMap.js filterRow).
//
// The battle recap plays on the match film's map, and a match snapshot
// records every fleet in the system, every stockpile and every pact.
// Anyone can open a recap link, including players in the same game, so
// the server sends only this battle: hulls that fought or sat at its
// world, that world's settlements, and nothing else.

import { filterRow } from '../../../worker/recapMap.js';

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

it('keeps the reconstructed marker so the page can say so', () => {
  const kept = new Set<string>();
  const r = filterRow({ t: 5, kind: 'delta', state: { v: 1, syn: 1, put: [], del: [] } },
    { bodyId: BODY, participants: new Set(), kept });
  expect(r.state.syn).toBe(1);
});
