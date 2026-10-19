// ============================================================================
// profileAwardsModel — the pure logic behind the profile's trophy case.
//
// Plain data in, plain data out: no React, no catalog, no DOM. It decides
// which medals to show and in what order, which awards are "recent", whether
// the section should show at all, and when to ask the server again while it
// is still working out past games. The component (ProfileAwards.tsx) only
// decides how that reads and looks.
//
// The payload is the server's, so it is read defensively: an award kind this
// build has no title for is dropped (never a blank medal), numbers that are
// not numbers are dropped, and anything malformed hides the section rather
// than breaking the profile.
// ============================================================================

import type { EndingAwardId } from './endingTypes';
import { AWARD_GROUP } from './endingModel';
import type { ProfileAward, ProfileAwardTotal, ProfileAwardsPayload } from './profileAwardsTypes';

/** How many recent awards show before "Show all". */
export const RECENT_SHOWN = 6;
/** The most the list ever reveals (the server never sends more). */
export const RECENT_MAX = 60;

/** The order awards break a tie in: the end page's own order (war, empire,
 *  society). A kind this build has never heard of is not in it. */
const KIND_ORDER = Object.keys(AWARD_GROUP) as EndingAwardId[];

export const isKnownAward = (id: unknown): id is EndingAwardId =>
  typeof id === 'string' && (KIND_ORDER as string[]).includes(id);

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

// ---------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------

/** The payload cleaned up for drawing, or null when it is not the shape we
 *  asked for (the section then hides). Unknown award kinds and rows without a
 *  usable number are dropped; the cap of 60 is enforced here as well. */
export function normalizePayload(raw: unknown): ProfileAwardsPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<keyof ProfileAwardsPayload, unknown>>;
  if (!Array.isArray(r.totals) || !Array.isArray(r.awards)) return null;

  const totals: ProfileAwardTotal[] = [];
  for (const x of r.totals as Array<Partial<ProfileAwardTotal> | null>) {
    if (!x || !isKnownAward(x.awardId) || !num(x.count) || x.count < 1 || !num(x.best)) continue;
    totals.push({
      awardId: x.awardId, count: Math.floor(x.count), best: x.best,
      bestGameId: str(x.bestGameId), bestGameName: str(x.bestGameName),
    });
  }

  const awards: ProfileAward[] = [];
  for (const a of r.awards as Array<Partial<ProfileAward> | null>) {
    if (!a || !isKnownAward(a.awardId) || !num(a.value)) continue;
    awards.push({
      gameId: str(a.gameId),
      gameName: str(a.gameName),
      awardId: a.awardId,
      value: a.value,
      tied: a.tied === true,
      ship: a.ship && typeof a.ship === 'object' && str(a.ship.name)
        ? { name: str(a.ship.name), shipClass: a.ship.shipClass ? String(a.ship.shipClass) : null, captainName: a.ship.captainName ? String(a.ship.captainName) : null }
        : null,
      empireName: str(a.empireName),
      wonGame: a.wonGame === true,
      completedAtMs: num(a.completedAtMs) ? a.completedAtMs : null,
    });
    if (awards.length >= RECENT_MAX) break;
  }

  return {
    gamesFinished: num(r.gamesFinished) ? Math.max(0, Math.floor(r.gamesFinished)) : 0,
    gamesWithAwards: num(r.gamesWithAwards) ? Math.max(0, Math.floor(r.gamesWithAwards)) : 0,
    totals, awards,
    pending: num(r.pending) ? Math.max(0, Math.floor(r.pending)) : 0,
  };
}

// ---------------------------------------------------------------------------
// The medals
// ---------------------------------------------------------------------------

/** One medal per award kind, most-earned first. Equal counts keep the end
 *  page's order (war, empire, society) so the row does not shuffle between
 *  loads. (Their best numbers are in different units, so they are not
 *  compared with each other.) */
export function orderedTotals(totals: readonly ProfileAwardTotal[]): ProfileAwardTotal[] {
  return totals
    .filter(x => isKnownAward(x.awardId) && x.count > 0)
    .sort((a, b) => b.count - a.count || KIND_ORDER.indexOf(a.awardId) - KIND_ORDER.indexOf(b.awardId));
}

// ---------------------------------------------------------------------------
// The recent list
// ---------------------------------------------------------------------------

export interface RecentSlice {
  rows: ProfileAward[];
  /** More than the collapsed list shows: offer "Show all". */
  canExpand: boolean;
  /** How many the full list holds (for "Show all 23"). */
  total: number;
}

/** The latest awards: 6 collapsed, up to 60 expanded. The server sends them
 *  newest game first; that order is kept. */
export function recentSlice(awards: readonly ProfileAward[], expanded: boolean): RecentSlice {
  const all = awards.slice(0, RECENT_MAX);
  return {
    rows: expanded ? all : all.slice(0, RECENT_SHOWN),
    canExpand: all.length > RECENT_SHOWN,
    total: all.length,
  };
}

// ---------------------------------------------------------------------------
// What the section shows
// ---------------------------------------------------------------------------

export type SectionView =
  /** Nothing to say: no finished games and nothing pending, or no payload. */
  | 'hidden'
  /** Finished games, but no award yet (and nothing still being checked). */
  | 'empty'
  /** Past games are still being worked out and nothing is in yet. */
  | 'checking'
  /** Medals to show. */
  | 'medals';

export function sectionView(p: ProfileAwardsPayload | null): SectionView {
  if (!p) return 'hidden';
  if (p.totals.length > 0 || p.awards.length > 0) return 'medals';
  if (p.pending > 0) return 'checking';
  return p.gamesFinished > 0 ? 'empty' : 'hidden';
}

// ---------------------------------------------------------------------------
// Asking again while the server catches up
// ---------------------------------------------------------------------------

export const FIRST_REFETCH_MS = 4000;
export const NEXT_REFETCH_MS = 6000;
/** One re-fetch after the first load, then at most three more. */
export const MAX_REFETCHES = 4;

/** How long to wait before asking again, or null to stop.
 *   refetchesDone  re-fetches already made (0 right after the first load)
 *   pending        the count in the response just received
 *   prevPending    the count in the response before it (null on the first)
 *  The first re-fetch always happens when something is pending; each one
 *  after it only while the count keeps shrinking, so a server that is stuck
 *  is asked a handful of times, never forever. */
export function refetchDelay(
  refetchesDone: number, pending: number, prevPending: number | null,
): number | null {
  if (!(pending > 0) || refetchesDone >= MAX_REFETCHES) return null;
  if (refetchesDone === 0) return FIRST_REFETCH_MS;
  return prevPending != null && pending < prevPending ? NEXT_REFETCH_MS : null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "Oct 14, 2026" / "14 de out. de 2026": the day a game ended, in the given
 *  language. null when the server did not know the date. */
export function formatAwardDate(ms: number | null | undefined, lang: string): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch {
    return null;
  }
}
