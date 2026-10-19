// ============================================================================
// profileAwardsSample — a real-shaped /api/users/me/awards payload for the
// dev preview (/?profile-awards) and the tests.
//
// It is assembled from the three REAL finished-game fixtures the ending page
// is tested against (__fixtures__/ending.*.json): for each game, the awards
// its WINNER earned, as if one player had played all three. Ships, values,
// tie flags (a runner-up on the same number) and game names are the real
// ones; nothing here is made up except that one player holds all three seats.
//
// DEV AND TESTS ONLY. Nothing in the app imports this file except the dev
// preview (behind a NODE_ENV guard in App.tsx) and tests, so a production
// build never contains it or the fixtures.
// ============================================================================

import type { EndingPayload } from './endingTypes';
import type { ProfileAward, ProfileAwardTotal, ProfileAwardsPayload } from './profileAwardsTypes';

/** The awards one game's winner earned, as profile rows. */
export function awardsOfWinner(d: EndingPayload): ProfileAward[] {
  const winner = d.factions.find(f => f.id === d.game.winnerFactionId);
  if (!winner) return [];
  return d.awards
    .filter(a => a.factionId === winner.id)
    .map(a => ({
      gameId: d.game.id,
      gameName: d.game.name,
      awardId: a.id,
      value: a.value,
      tied: a.runnerUp != null && a.runnerUp.value === a.value,
      ship: a.ship ? { name: a.ship.name, shipClass: a.ship.shipClass, captainName: a.ship.captainName ?? null } : null,
      empireName: winner.name,
      wonGame: true,
      completedAtMs: d.game.completedAtMs,
    }));
}

/** Per-kind totals: how many times, and the best number (the first, i.e. the
 *  newest, game on a tie). Most-earned first. */
export function totalsOf(awards: readonly ProfileAward[]): ProfileAwardTotal[] {
  const by = new Map<string, ProfileAwardTotal>();
  for (const a of awards) {
    const cur = by.get(a.awardId);
    if (!cur) {
      by.set(a.awardId, { awardId: a.awardId, count: 1, best: a.value, bestGameId: a.gameId, bestGameName: a.gameName });
    } else {
      cur.count += 1;
      if (a.value > cur.best) { cur.best = a.value; cur.bestGameId = a.gameId; cur.bestGameName = a.gameName; }
    }
  }
  return Array.from(by.values()).sort((a, b) => b.count - a.count || b.best - a.best);
}

export interface SampleOptions {
  /** Only the first n games (the preview's "pending" run reveals them one by one). */
  games?: number;
  /** Pending count to report. */
  pending?: number;
  /** Stretch to the server's cap of 60 awards by replaying the same awards on
   *  earlier weeks, to look at a long list. Layout stress only. */
  many?: boolean;
}

const WEEK = 7 * 86_400_000;

/** The payload for the given fixtures (newest game first). */
export function buildSample(fixtures: readonly EndingPayload[], opts: SampleOptions = {}): ProfileAwardsPayload {
  const games = [...fixtures]
    .sort((a, b) => (b.game.completedAtMs ?? 0) - (a.game.completedAtMs ?? 0))
    .slice(0, opts.games ?? fixtures.length);
  let awards = games.flatMap(awardsOfWinner);
  let finished = games.length;
  if (opts.many) {
    const base = awards;
    const out: ProfileAward[] = [...base];
    for (let lap = 1; out.length < 60; lap++) {
      for (const a of base) {
        if (out.length >= 60) break;
        out.push({
          ...a,
          gameId: `${a.gameId}-${lap}`,
          completedAtMs: a.completedAtMs == null ? null : a.completedAtMs - lap * WEEK,
        });
      }
      finished += games.length;
    }
    awards = out;
  }
  return {
    gamesFinished: finished + (opts.pending ?? 0),
    gamesWithAwards: finished,
    totals: totalsOf(awards),
    awards,
    pending: opts.pending ?? 0,
  };
}

/** The three bundled fixtures. The NODE_ENV guard is what keeps them out of a
 *  production bundle should this file ever be reached from one. */
export async function loadSampleFixtures(): Promise<EndingPayload[]> {
  if (process.env.NODE_ENV === 'production') return [];
  const all = await Promise.all([
    import('./__fixtures__/ending.sMu08u1ySzRJ.json'),
    import('./__fixtures__/ending.ghhqbPbWz64Y.json'),
    import('./__fixtures__/ending.CAWEFbsSGyBI.json'),
  ]);
  return all.map(m => m.default as unknown as EndingPayload);
}
