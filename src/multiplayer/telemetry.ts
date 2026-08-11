// Fire-and-forget UI telemetry.
//
// WHAT CHANGED AND WHY. The original module answered exactly one
// question — "has this player ever opened X?" — by deduping each kind to
// once per page load. That is the right shape for a funnel and the wrong
// shape for engagement: 85 fleet-menu rows across 8 users meant "8 people
// opened it at least once", and no amount of querying could recover how
// often, how long, in what order, or inside which visit.
//
// So there are now two channels, deliberately kept apart:
//
//   logUiEvent   unchanged semantics — first open per kind per load.
//                The existing funnels keep working untouched.
//   openScreen   every open, with a dwell time written on close, tagged
//                with a visit id so a session can be reassembled.
//
// Still dumb on purpose: no retry, errors swallowed, and every payload is
// structural. Losing a row must never affect play, and telemetry must
// never carry anything a player typed.

import { apiFetch } from './api';

/** One id per page load. Groups every event from a single visit so the
 *  dashboard can compute session length, actions-per-visit and screen
 *  order without a sessions table, and without guessing at an idle
 *  timeout that would be meaningless in a game with hour-long ticks. */
export const TELEMETRY_SESSION_ID: string =
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    : Math.random().toString(36).slice(2, 14) + Date.now().toString(36);

type Item = {
  kind: string;
  session_id: string;
  dwell_ms?: number;
  payload?: Record<string, string | number | boolean>;
};

const sent = new Set<string>();
let queue: Item[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let queueGameId: string | undefined;

/** Batch window. Long enough that opening three menus in a row is one
 *  request, short enough that a player who closes the tab loses at most
 *  a couple of seconds of history (and `pagehide` below catches most of
 *  even that). */
const FLUSH_MS = 2500;
const QUEUE_MAX = 25;

function flush(useBeacon = false): void {
  if (!queue.length || !queueGameId) return;
  const batch = queue;
  const gameId = queueGameId;
  queue = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  const url = `/api/games/${gameId}/telemetry`;
  const body = JSON.stringify({ session_id: TELEMETRY_SESSION_ID, batch });

  // On unload, fetch() is cancelled mid-flight but sendBeacon survives —
  // and the last screen a player was looking at before they left is one
  // of the more interesting rows in the table.
  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    } catch { /* fall through to fetch */ }
  }
  void apiFetch(url, { method: 'POST', body }).catch(() => { /* best-effort */ });
}

function enqueue(gameId: string, item: Item): void {
  // A queue holding another game's rows would post them to this game's
  // endpoint; flush first so each batch belongs to exactly one game.
  if (queueGameId && queueGameId !== gameId) flush();
  queueGameId = gameId;
  queue.push(item);
  if (queue.length >= QUEUE_MAX) { flush(); return; }
  if (!flushTimer) flushTimer = setTimeout(() => flush(), FLUSH_MS);
}

if (typeof window !== 'undefined') {
  // pagehide, not unload: unload is unreliable on mobile, where the tab
  // is usually backgrounded rather than closed.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/**
 * FUNNEL channel — first time only, per (game, kind), per page load.
 * Existing call sites rely on this dedupe; leave it alone.
 */
export function logUiEvent(gameId: string | null | undefined, kind: string): void {
  if (!gameId) return; // single-player: nothing to report to
  const key = `${gameId}:${kind}`;
  if (sent.has(key)) return;
  sent.add(key);
  enqueue(gameId, { kind, session_id: TELEMETRY_SESSION_ID });
}

/**
 * ENGAGEMENT channel — every open, and how long it stayed open.
 *
 * Returns the close function, so a React effect is the whole
 * integration: `useEffect(() => openScreen(gameId, 'senate'), [gameId])`.
 * Tying dwell to effect cleanup is what makes coverage automatic rather
 * than hand-placed — hand-placing is exactly why only four screens were
 * ever instrumented.
 */
export function openScreen(
  gameId: string | null | undefined,
  screen: string,
  payload?: Record<string, string | number | boolean>,
): () => void {
  if (!gameId) return () => { /* SP: no-op */ };
  const t0 = Date.now();
  enqueue(gameId, { kind: `open-${screen}`.slice(0, 33), session_id: TELEMETRY_SESSION_ID, payload });
  let closed = false;
  return () => {
    if (closed) return;   // StrictMode double-invokes cleanup in dev
    closed = true;
    enqueue(gameId, {
      kind: `dwell-${screen}`.slice(0, 33),
      session_id: TELEMETRY_SESSION_ID,
      dwell_ms: Date.now() - t0,
    });
  };
}

/** Structural context on a player action ("built a forge", "researched
 *  propulsion 2"). Never deduped — repetition is the signal here. */
export function logAction(
  gameId: string | null | undefined,
  kind: string,
  payload?: Record<string, string | number | boolean>,
): void {
  if (!gameId) return;
  enqueue(gameId, { kind: kind.slice(0, 33), session_id: TELEMETRY_SESSION_ID, payload });
}
