// The end-of-game page's logic, against the three REAL finished games in
// __fixtures__ and a few hand-made edge cases (no awards, one empire, ties, an
// eliminated viewer, a viewer who is not in the game).

import fs from 'fs';
import path from 'path';
import type { EndingFaction, EndingPayload } from '../endingTypes';
import {
  awardGroups, battleSegments, chartGeom, chartLines, durationParts, endLabels, hasSeries,
  holdingsShare, indexAtOrAfter, linePath, maxOfLines, myStats, nearestIndex, niceMax,
  peakLeader, rankBy, sampleIndexes, survivedTheGame, verdictKind, victoryWay, viewerOf, withViewer,
} from '../endingModel';

const load = (id: string): EndingPayload =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '__fixtures__', `ending.${id}.json`), 'utf8'));
const NEXT = load('sMu08u1ySzRJ');
const MEGA = load('ghhqbPbWz64Y');
const SIX = load('CAWEFbsSGyBI');

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const byName = (d: EndingPayload, n: string): EndingFaction => d.factions.find(f => f.name === n) as EndingFaction;

describe('viewer', () => {
  it('finds the viewer in a real payload', () => {
    expect(viewerOf(NEXT.factions)?.name).toBe('The Ministry of Silly Wonks');
  });

  it('withViewer re-seats the viewer by winner, name, id or nobody', () => {
    const asTri = withViewer(MEGA, 'tritalowda');
    expect(viewerOf(asTri.factions)?.name).toBe('Tritalowda');
    expect(asTri.factions.filter(f => f.isMe)).toHaveLength(1);
    expect(viewerOf(withViewer(MEGA, 'none').factions)).toBeNull();
    expect(viewerOf(withViewer(MEGA, 'winner').factions)?.isWinner).toBe(true);
    expect(viewerOf(withViewer(MEGA, MEGA.factions[3].id).factions)?.name).toBe(MEGA.factions[3].name);
    expect(viewerOf(withViewer(MEGA, 'nobody by that name').factions)).toBeNull();
    // does not touch the original
    expect(viewerOf(MEGA.factions)?.name).toBe('Stonekin of Mars');
  });
});

describe('ranks', () => {
  it('ranks the winner of the NEXT Zone 2nd on worlds held (Myanus holds 28 to its 26)', () => {
    const me = viewerOf(NEXT.factions) as EndingFaction;
    expect(rankBy(NEXT.factions, me, f => f.final.holdings)).toEqual({ rank: 2, tied: false });
  });

  it('uses competition ranking and flags ties', () => {
    const d = clone(NEXT);
    d.factions.forEach(f => { f.totals.kills = 5; });
    d.factions[1].totals.kills = 9;
    const me = d.factions[0];
    expect(rankBy(d.factions, me, f => f.totals.kills)).toEqual({ rank: 2, tied: true });
    expect(rankBy(d.factions, d.factions[1], f => f.totals.kills)).toEqual({ rank: 1, tied: false });
  });

  it('myStats ranks what has a rank and leaves ships lost and zeroes unranked', () => {
    const d = clone(SIX); // nobody traded
    const me = viewerOf(d.factions) as EndingFaction;
    const rows = myStats(d.factions, me);
    expect(rows.map(r => r.id)).toEqual(['holdings', 'kills', 'shipsLost', 'shipsBuilt', 'trades']);
    expect(rows.find(r => r.id === 'shipsLost')?.rank).toBeNull();
    expect(rows.find(r => r.id === 'trades')?.value).toBe(0);
    expect(rows.find(r => r.id === 'trades')?.rank).toBeNull();
    expect(rows.find(r => r.id === 'holdings')?.rank).toEqual({ rank: 1, tied: false });
  });

  it('works for a single empire', () => {
    const d = clone(NEXT);
    d.factions = [d.factions[0]];
    const rows = myStats(d.factions, d.factions[0]);
    expect(rows[0].rank).toEqual({ rank: 1, tied: false });
  });
});

describe('verdict', () => {
  it('VICTORY only for the winner', () => {
    expect(verdictKind('a', 'a')).toBe('victory');
    expect(verdictKind('a', 'b')).toBe('gameover');
    expect(verdictKind('a', null)).toBe('gameover');
    expect(verdictKind(null, null)).toBe('gameover');
  });
  it('knows the four ways to win and nothing else', () => {
    expect(victoryWay('engineering')).toBe('engineering');
    expect(victoryWay('annihilation')).toBe('annihilation');
    expect(victoryWay('hegemony')).toBeNull();
    expect(victoryWay(null)).toBeNull();
  });
  it('survivedTheGame: a winner, or an empire still active', () => {
    expect(survivedTheGame(null, false)).toBe(false);
    expect(survivedTheGame(null, true)).toBe(true);
    expect(survivedTheGame({ finalStatus: 'active' }, false)).toBe(true);
    expect(survivedTheGame({ finalStatus: 'eliminated' }, false)).toBe(false);
    expect(survivedTheGame({ status: 'active' }, false)).toBe(true);
    expect(survivedTheGame({ status: 'eliminated' }, false)).toBe(false);
  });
  it('an eliminated viewer in a real game reads GAME OVER and did not survive', () => {
    const d = withViewer(MEGA, 'Ember Syndicate');
    const me = viewerOf(d.factions) as EndingFaction;
    expect(verdictKind(d.game.winnerFactionId, me.id)).toBe('gameover');
    expect(survivedTheGame(me, false)).toBe(false);
  });
});

describe('duration', () => {
  it('rounds to days, hours or minutes', () => {
    expect(durationParts(NEXT.game.durationMs)).toEqual({ unit: 'days', n: 22 });
    expect(durationParts(SIX.game.durationMs)).toEqual({ unit: 'days', n: 11 });
    expect(durationParts(5 * 3_600_000)).toEqual({ unit: 'hours', n: 5 });
    expect(durationParts(20 * 60_000)).toEqual({ unit: 'minutes', n: 20 });
    expect(durationParts(1000)).toEqual({ unit: 'minutes', n: 1 });
  });
  it('says nothing when unknown', () => {
    expect(durationParts(null)).toBeNull();
    expect(durationParts(0)).toBeNull();
    expect(durationParts(Number.NaN)).toBeNull();
  });
});

describe('awards', () => {
  it('groups the NEXT Zone awards War / Empire / Society, all 12 present', () => {
    const g = awardGroups(NEXT.awards, NEXT.factions);
    expect(g.map(x => x.group)).toEqual(['war', 'empire', 'society']);
    expect(g.reduce((n, x) => n + x.cards.length, 0)).toBe(NEXT.awards.length);
    expect(NEXT.awards).toHaveLength(12);
  });

  it('only shows awards that exist: 9 in 6X 30min, no empty group labels', () => {
    const g = awardGroups(SIX.awards, SIX.factions);
    expect(g.reduce((n, x) => n + x.cards.length, 0)).toBe(9);
    expect(g.every(x => x.cards.length > 0)).toBe(true);
  });

  it('no awards at all gives no groups', () => {
    expect(awardGroups([], NEXT.factions)).toEqual([]);
  });

  it('marks ties and hull awards, and the viewer\'s own', () => {
    const g = awardGroups(NEXT.awards, NEXT.factions).flatMap(x => x.cards);
    const ace = g.find(c => c.id === 'ace');
    expect(ace?.ship?.name).toBe('Truman');
    expect(ace?.runnerUp?.tied).toBe(true); // 13 v 13
    expect(ace?.mine).toBe(true);
    const warmonger = g.find(c => c.id === 'warmonger');
    expect(warmonger?.runnerUp?.tied).toBe(false);
  });

  it('skips an award whose empire is unknown rather than inventing one', () => {
    const awards = clone(NEXT.awards);
    awards[0].factionId = 'ghost';
    const n = awardGroups(awards, NEXT.factions).reduce((c, x) => c + x.cards.length, 0);
    expect(n).toBe(NEXT.awards.length - 1);
  });
});

describe('standings and battles', () => {
  it('holdingsShare is proportional but never invisible', () => {
    expect(holdingsShare(28, 28)).toBe(100);
    expect(holdingsShare(14, 28)).toBe(50);
    expect(holdingsShare(1, 100)).toBe(3);
    expect(holdingsShare(0, 28)).toBe(0);
  });

  it('battle loss segments sum to 100 and lead with the biggest loser', () => {
    const segs = battleSegments(NEXT.battles[0]);
    expect(segs[0].shipsLost).toBe(83);
    expect(segs.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 5);
    expect(battleSegments({ ...NEXT.battles[0], lossesByFaction: [] })).toEqual([]);
  });
});

describe('charts', () => {
  it('niceMax rounds up to a tidy top', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(26)).toBe(50);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(7080)).toBe(10000);
    expect(niceMax(110)).toBe(200);
  });

  it('draws the viewer last (on top), then the winner', () => {
    const d = withViewer(MEGA, 'Tritalowda');
    const lines = chartLines(d, 'holdings');
    expect(lines[lines.length - 1].faction.name).toBe('Tritalowda');
    expect(lines[lines.length - 2].faction.isWinner).toBe(true);
    expect(lines.filter(l => l.emphasis)).toHaveLength(2);
  });

  it('an empire that fell stops at its elimination tick', () => {
    const lines = chartLines(MEGA, 'holdings');
    const out = lines.find(l => l.faction.name === 'Ember Syndicate') as ReturnType<typeof chartLines>[number];
    expect(out.faction.eliminatedAtTick).toBe(274);
    expect(MEGA.series.ticks[out.cut]).toBeGreaterThanOrEqual(274);
    expect(out.cut).toBeLessThan(MEGA.series.ticks.length - 1);
    const standing = lines.find(l => l.faction.isWinner) as ReturnType<typeof chartLines>[number];
    expect(standing.cut).toBe(MEGA.series.ticks.length - 1);
  });

  it('geometry maps ticks and values into the plot', () => {
    const lines = chartLines(NEXT, 'holdings');
    const g = chartGeom(700, 270, NEXT.series.ticks, maxOfLines(lines));
    expect(g.x(0)).toBeCloseTo(g.padL, 5);
    expect(g.x(NEXT.series.ticks.length - 1)).toBeCloseTo(700 - g.padR, 5);
    expect(g.y(0)).toBeCloseTo(270 - g.padB, 5);
    expect(g.y(g.top)).toBeCloseTo(g.padT, 5);
    const d = linePath(lines[0], g);
    expect(d.startsWith('M')).toBe(true);
  });

  it('never labels more than three ends, and no two labels overlap', () => {
    for (const d of [NEXT, MEGA, SIX]) {
      for (const m of ['holdings', 'ships', 'credits'] as const) {
        const lines = chartLines(d, m);
        for (const width of [340, 720, 1100]) {
          const g = chartGeom(width, 240, d.series.ticks, maxOfLines(lines));
          const labels = endLabels(lines, g);
          expect(labels.length).toBeLessThanOrEqual(3);
          const ys = labels.map(l => l.ty).sort((a, b) => a - b);
          for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(13.999);
          for (const l of labels) expect(l.ty).toBeLessThanOrEqual(240 - g.padB + 2 + 0.001);
        }
      }
    }
  });

  it('keeps the viewer labelled even when they are not a leader', () => {
    const d = withViewer(NEXT, 'Tritalowda');
    const lines = chartLines(d, 'holdings');
    const g = chartGeom(720, 240, d.series.ticks, maxOfLines(lines));
    const labels = endLabels(lines, g);
    expect(labels.some(l => l.factionId === byName(d, 'Tritalowda').id)).toBe(true);
    expect(labels.length).toBeLessThanOrEqual(3);
  });

  it('labels equal end values without stacking them', () => {
    const d = clone(NEXT);
    const ids = d.factions.slice(0, 4).map(f => f.id);
    ids.forEach(id => { d.series.holdings[id] = d.series.holdings[id].map(() => 10); });
    const lines = chartLines(d, 'holdings');
    const g = chartGeom(720, 240, d.series.ticks, maxOfLines(lines));
    const ys = endLabels(lines, g).map(l => l.ty).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(13.999);
  });

  it('nearestIndex snaps a pixel to the closest tick', () => {
    const g = chartGeom(700, 240, [0, 10, 20, 30], 5);
    expect(nearestIndex(g.x(2) + 3, g)).toBe(2);
    expect(nearestIndex(-100, g)).toBe(0);
    expect(nearestIndex(10000, g)).toBe(3);
    expect(nearestIndex(5, chartGeom(700, 240, [], 5))).toBeNull();
  });

  it('indexAtOrAfter finds the first tick that has reached a moment', () => {
    expect(indexAtOrAfter([0, 10, 20], 10)).toBe(1);
    expect(indexAtOrAfter([0, 10, 20], 11)).toBe(2);
    expect(indexAtOrAfter([0, 10, 20], 99)).toBe(2);
    expect(indexAtOrAfter([], 1)).toBe(0);
  });

  it('sampleIndexes spreads columns and keeps both ends', () => {
    expect(sampleIndexes(0, 6)).toEqual([]);
    expect(sampleIndexes(3, 6)).toEqual([0, 1, 2]);
    const s = sampleIndexes(106, 6);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(105);
    expect(s).toHaveLength(6);
  });

  it('peakLeader names the highest peak, and nothing when nobody had any', () => {
    expect(peakLeader(NEXT.factions, 'holdings')?.value).toBe(Math.max(...NEXT.factions.map(f => f.peak.holdings)));
    const none = clone(NEXT.factions);
    none.forEach(f => { f.peak.credits = 0; });
    expect(peakLeader(none, 'credits')).toBeNull();
  });

  it('hasSeries needs two points to draw a line', () => {
    expect(hasSeries(NEXT)).toBe(true);
    const d = clone(NEXT);
    d.series.ticks = [5];
    expect(hasSeries(d)).toBe(false);
  });

  it('copes with a missing or short series for an empire', () => {
    const d = clone(NEXT);
    delete d.series.holdings[d.factions[0].id];
    d.series.holdings[d.factions[1].id] = d.series.holdings[d.factions[1].id].slice(0, 3);
    const lines = chartLines(d, 'holdings');
    expect(lines.every(l => l.values.length === d.series.ticks.length)).toBe(true);
    expect(() => lines.forEach(l => linePath(l, chartGeom(600, 240, d.series.ticks, 10)))).not.toThrow();
  });
});

describe('one empire, no awards, no battles', () => {
  it('is a degenerate but valid game', () => {
    const d = clone(SIX);
    d.factions = [d.factions[0]];
    d.awards = [];
    d.battles = [];
    expect(awardGroups(d.awards, d.factions)).toEqual([]);
    expect(myStats(d.factions, d.factions[0])[0].rank).toEqual({ rank: 1, tied: false });
    const lines = chartLines(d, 'holdings');
    expect(lines).toHaveLength(1);
    expect(endLabels(lines, chartGeom(600, 240, d.series.ticks, maxOfLines(lines))).length).toBeLessThanOrEqual(1);
  });
});
