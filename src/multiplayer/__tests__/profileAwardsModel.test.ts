/**
 * The pure logic behind the profile's trophy case: reading the server's
 * payload defensively, ordering the medals, slicing the recent list, deciding
 * what the section shows, and when to ask the server again.
 */
import fs from 'fs';
import path from 'path';
import type { EndingPayload } from '../endingTypes';
import type { ProfileAward, ProfileAwardTotal, ProfileAwardsPayload } from '../profileAwardsTypes';
import {
  FIRST_REFETCH_MS, MAX_REFETCHES, NEXT_REFETCH_MS, RECENT_MAX, RECENT_SHOWN,
  formatAwardDate, normalizePayload, orderedTotals, recentSlice, refetchDelay, sectionView,
} from '../profileAwardsModel';
import { awardsOfWinner, buildSample, totalsOf } from '../profileAwardsSample';

const load = (id: string): EndingPayload =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '__fixtures__', `ending.${id}.json`), 'utf8'));
const FIXTURES = [load('sMu08u1ySzRJ'), load('ghhqbPbWz64Y'), load('CAWEFbsSGyBI')];

const award = (over: Partial<ProfileAward> = {}): ProfileAward => ({
  gameId: 'g1', gameName: 'Game', awardId: 'warmonger', value: 5, tied: false, ship: null,
  empireName: 'Me', wonGame: false, completedAtMs: 1_790_000_000_000, ...over,
});
const total = (awardId: ProfileAwardTotal['awardId'], count: number, best = 1): ProfileAwardTotal =>
  ({ awardId, count, best, bestGameId: 'g1', bestGameName: 'Game' });
const payload = (over: Partial<ProfileAwardsPayload> = {}): ProfileAwardsPayload =>
  ({ gamesFinished: 0, gamesWithAwards: 0, totals: [], awards: [], pending: 0, ...over });

describe('the sample is built from the real fixtures', () => {
  it('takes the awards each game\'s winner earned, with real ships, values and tie flags', () => {
    const ministry = awardsOfWinner(FIXTURES[0]);
    expect(ministry.map(a => a.awardId)).toEqual(['warmonger', 'ace', 'iron_wall', 'shipwright', 'statesman']);
    const ace = ministry.find(a => a.awardId === 'ace');
    expect(ace).toMatchObject({ value: 13, tied: true, empireName: 'The Ministry of Silly Wonks', wonGame: true });
    expect(ace?.ship).toEqual({ name: 'Truman', shipClass: 'destroyer', captainName: null });
    expect(ministry.find(a => a.awardId === 'warmonger')?.tied).toBe(false);
  });

  it('assembles all three games, newest first, with totals that add up', () => {
    const s = buildSample(FIXTURES);
    expect(s.awards).toHaveLength(21);
    expect(s.gamesFinished).toBe(3);
    const times = s.awards.map(a => a.completedAtMs ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(s.totals.reduce((n, x) => n + x.count, 0)).toBe(21);
    const warmonger = s.totals.find(x => x.awardId === 'warmonger');
    expect(warmonger).toMatchObject({ count: 2, best: 420, bestGameName: 'The MEGA Zone' });
  });

  it('"many" fills the server\'s cap and "pending" reports unseen games', () => {
    expect(buildSample(FIXTURES, { many: true }).awards).toHaveLength(60);
    const p = buildSample(FIXTURES, { games: 1, pending: 2 });
    expect(p.pending).toBe(2);
    expect(p.gamesWithAwards).toBe(1);
    expect(totalsOf(p.awards).every(x => x.count === 1)).toBe(true);
  });
});

describe('normalizePayload', () => {
  it('passes a good payload through', () => {
    const s = buildSample(FIXTURES);
    expect(normalizePayload(s)).toEqual(s);
  });

  it.each([null, undefined, 'x', 7, {}, { totals: [] }, { totals: {}, awards: [] }])('rejects %p', (bad) => {
    expect(normalizePayload(bad)).toBeNull();
  });

  it('drops award kinds this build has no title for, and rows without a usable number', () => {
    const n = normalizePayload({
      gamesFinished: 2, gamesWithAwards: 1, pending: 0,
      totals: [total('ace', 2, 9), { awardId: 'time_traveller', count: 1, best: 3, bestGameId: 'g', bestGameName: 'G' },
        { awardId: 'scholar', count: 0, best: 1 }, { awardId: 'scholar', count: 1, best: NaN }],
      awards: [award(), { ...award(), awardId: 'nope' }, { ...award(), value: 'a lot' }, null],
    });
    expect(n?.totals.map(x => x.awardId)).toEqual(['ace']);
    expect(n?.awards).toHaveLength(1);
  });

  it('caps the list at 60 and coerces missing fields to safe values', () => {
    const many = Array.from({ length: 80 }, (_, i) => award({ gameId: `g${i}` }));
    const n = normalizePayload({ totals: [], awards: many });
    expect(n?.awards).toHaveLength(RECENT_MAX);
    expect(n).toMatchObject({ gamesFinished: 0, gamesWithAwards: 0, pending: 0 });
    const odd = normalizePayload({ totals: [], awards: [{ awardId: 'ace', value: 1, ship: { name: 'X' } }] });
    expect(odd?.awards[0]).toMatchObject({ gameName: '', empireName: '', tied: false, wonGame: false, completedAtMs: null });
    expect(odd?.awards[0].ship).toEqual({ name: 'X', shipClass: null, captainName: null });
  });
});

describe('orderedTotals', () => {
  it('puts the most-earned first and breaks ties in the end page\'s order, not by unlike units', () => {
    const out = orderedTotals([
      total('statesman', 1, 99), total('merchant', 3, 1), total('warmonger', 1, 1), total('scholar', 3, 60),
    ]);
    expect(out.map(x => x.awardId)).toEqual(['scholar', 'merchant', 'warmonger', 'statesman']);
  });

  it('does not mutate its input', () => {
    const input = [total('statesman', 1), total('ace', 2)];
    orderedTotals(input);
    expect(input.map(x => x.awardId)).toEqual(['statesman', 'ace']);
  });
});

describe('recentSlice', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => award({ gameId: `g${i}` }));

  it('shows 6 collapsed and offers the rest', () => {
    const s = recentSlice(list(23), false);
    expect(s.rows).toHaveLength(RECENT_SHOWN);
    expect(s.canExpand).toBe(true);
    expect(s.total).toBe(23);
    expect(s.rows[0].gameId).toBe('g0');
  });

  it('reveals everything, up to 60, when expanded', () => {
    expect(recentSlice(list(23), true).rows).toHaveLength(23);
    expect(recentSlice(list(75), true).rows).toHaveLength(60);
    expect(recentSlice(list(75), true).total).toBe(60);
  });

  it('offers nothing to expand for six or fewer', () => {
    expect(recentSlice(list(6), false).canExpand).toBe(false);
    expect(recentSlice(list(0), false)).toEqual({ rows: [], canExpand: false, total: 0 });
  });
});

describe('sectionView', () => {
  it('hides for no payload and for no finished games', () => {
    expect(sectionView(null)).toBe('hidden');
    expect(sectionView(payload())).toBe('hidden');
  });
  it('is empty when games finished with no awards and nothing pending', () => {
    expect(sectionView(payload({ gamesFinished: 4, gamesWithAwards: 0 }))).toBe('empty');
  });
  it('is "checking" while past games are still being worked out and nothing is in', () => {
    expect(sectionView(payload({ gamesFinished: 4, pending: 4 }))).toBe('checking');
    expect(sectionView(payload({ pending: 2 }))).toBe('checking');
  });
  it('shows medals as soon as any award is in, even with more pending', () => {
    expect(sectionView(buildSample(FIXTURES))).toBe('medals');
    expect(sectionView(buildSample(FIXTURES, { games: 1, pending: 2 }))).toBe('medals');
  });
});

describe('refetchDelay', () => {
  it('does not ask again when nothing is pending', () => {
    expect(refetchDelay(0, 0, null)).toBeNull();
    expect(refetchDelay(2, 0, 3)).toBeNull();
  });
  it('asks once after ~4s, then every 6s only while the count keeps shrinking', () => {
    expect(refetchDelay(0, 3, null)).toBe(FIRST_REFETCH_MS);
    expect(refetchDelay(1, 2, 3)).toBe(NEXT_REFETCH_MS);
    expect(refetchDelay(2, 1, 2)).toBe(NEXT_REFETCH_MS);
  });
  it('stops when the count stops shrinking, or grows', () => {
    expect(refetchDelay(1, 3, 3)).toBeNull();
    expect(refetchDelay(2, 4, 3)).toBeNull();
  });
  it('never makes more than the cap, however the count moves', () => {
    expect(FIRST_REFETCH_MS).toBe(4000);
    expect(NEXT_REFETCH_MS).toBe(6000);
    expect(MAX_REFETCHES).toBe(4);
    // A server that always sheds one pending game per answer.
    let pending = 50, prev: number | null = null, done = 0;
    for (;;) {
      const wait = refetchDelay(done, pending, prev);
      if (wait == null) break;
      prev = pending; pending -= 1; done += 1;
    }
    expect(done).toBe(MAX_REFETCHES);
    expect(refetchDelay(MAX_REFETCHES, 1, 5)).toBeNull();
  });
});

describe('formatAwardDate', () => {
  const ms = Date.UTC(2026, 9, 14, 12);
  it('reads in the given language', () => {
    expect(formatAwardDate(ms, 'en')).toMatch(/Oct/);
    expect(formatAwardDate(ms, 'en')).toMatch(/2026/);
    expect(formatAwardDate(ms, 'pt-BR')).toMatch(/out/i);
    expect(formatAwardDate(ms, 'pt-BR')).toMatch(/2026/);
  });
  it('is null when the date is unknown', () => {
    expect(formatAwardDate(null, 'en')).toBeNull();
    expect(formatAwardDate(0, 'en')).toBeNull();
    expect(formatAwardDate(NaN, 'en')).toBeNull();
  });
});
