// ============================================================
// OPTIMISTIC BUILD ROWS — surviving the next /state poll.
//
// Ordering a hull writes a queue row locally before the server has
// answered, so the queue reacts to the click instead of to the network.
// The row is real for ~1.5s, and then the poll lands and the whole
// GameState is replaced by the server's snapshot.
//
// gameContext's external-state merge already carries the client-only
// things across that replacement — planned transfers, chained legs, a
// body's ram plan. Build orders were not on the list, so an optimistic
// row survived only if the server's snapshot already contained the
// real one. When it didn't, the row vanished, the queue looked empty,
// and the player ordered the same ship again. Reported as: "sometimes,
// when you queue a ship to build, it does not show in the queue until
// you click another button".
//
// The snapshot can legitimately miss a build that was accepted:
// mpActions.build dispatches orbital:refresh-state and the refetch
// fires 60ms later, which is well inside the window where a D1 read
// can still be serving a replica that has not caught up — and a poll
// already in flight when the click happened carries pre-click data by
// definition.
// ============================================================

import { BuildOrder } from '../types';

/** Ids minted by the two optimistic build paths: `opt_${Date.now()}_${cls}`. */
const OPTIMISTIC_PREFIX = 'opt_';

/**
 * How long a row may wait for the server to confirm it.
 *
 * A rejected build is rolled back by id the moment the response lands,
 * so this is only the backstop for a request that never resolves at all
 * — a dropped connection, a tab suspended mid-flight. Generous, because
 * expiring early recreates the exact bug this module exists to fix, and
 * the cost of expiring late is one stale row on a queue the next poll
 * corrects.
 */
export const OPTIMISTIC_TTL_MS = 20_000;

export function isOptimisticBuildId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX);
}

/** Minted-at, read back out of the id. NaN-safe: an unparseable id is
 *  treated as brand new rather than instantly expired. */
function mintedAt(id: string): number | null {
  const t = Number(id.split('_')[1]);
  return Number.isFinite(t) ? t : null;
}

/** Same body, same class, same name — what the server row will look like
 *  once it exists, since the client sends all three. */
const keyOf = (o: BuildOrder) => `${o.bodyId}|${o.shipClass}|${o.shipName}`;

/**
 * The build queue to show: the server's rows, plus any optimistic row
 * the server has not caught up with yet.
 *
 * Matching CONSUMES a server row per optimistic twin rather than
 * clearing every local row that shares a key. Queue two hulls with the
 * same typed name and the server confirms them one at a time; a plain
 * key test would drop both the moment the first landed and the queue
 * would flicker down to one.
 */
export function carryOptimisticBuilds(
  local: BuildOrder[],
  server: BuildOrder[],
  now: number,
): BuildOrder[] {
  const unmatched = new Map<string, number>();
  for (const o of server) {
    const k = keyOf(o);
    unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
  }

  const carried: BuildOrder[] = [];
  for (const o of local) {
    if (!isOptimisticBuildId(o.id)) continue;   // server-owned rows: the snapshot is the truth
    const t = mintedAt(o.id);
    if (t != null && now - t > OPTIMISTIC_TTL_MS) continue;
    const k = keyOf(o);
    const n = unmatched.get(k) ?? 0;
    if (n > 0) { unmatched.set(k, n - 1); continue; }  // the server has this one now
    carried.push(o);
  }

  return carried.length > 0 ? [...server, ...carried] : server;
}

// ------------------------------------------------------------------
// CANCELLING A ROW THE SERVER HAS NOT NAMED YET.
//
// An optimistic row carries a local id ("opt_1700000000000_corvette").
// Send that to the cancel endpoint and it answers 404 "build order not
// found" — which is what a player hit, on a queue that was showing them
// the row they were clicking.
//
// The build response carries the real order id. Registering it here
// against the optimistic id lets the ✕ resolve one to the other, and
// awaiting a settled promise costs nothing, so the common case (the
// build confirmed a second ago) is instant.
// ------------------------------------------------------------------

const PENDING_KEEP_MS = 60_000;

interface Pending { at: number; p: Promise<string | null> }
const inFlight = new Map<string, Pending>();

function prune(now: number): void {
  for (const [k, v] of inFlight) if (now - v.at > PENDING_KEEP_MS) inFlight.delete(k);
}

/** Register the build request behind an optimistic row. `p` resolves to
 *  the server's order id, or null if the build was rejected. */
export function trackPendingBuild(
  optimisticId: string,
  p: Promise<string | null>,
  now: number = Date.now(),
): void {
  prune(now);
  inFlight.set(optimisticId, { at: now, p });
}

/**
 * The id the cancel endpoint will recognise.
 *
 * A server-owned row is its own answer. An optimistic row resolves
 * through the build request that created it — null if that request was
 * rejected, or if we have no record of it, in which case the caller has
 * nothing to cancel and should say so rather than post a 404.
 */
export function resolveServerOrderId(rowId: string): Promise<string | null> {
  if (!isOptimisticBuildId(rowId)) return Promise.resolve(rowId);
  const held = inFlight.get(rowId);
  return held ? held.p : Promise.resolve(null);
}

/** Test seam — drops every registration. */
export function __resetPendingBuilds(): void { inFlight.clear(); }
