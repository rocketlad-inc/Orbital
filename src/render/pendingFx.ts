// ============================================================
// pendingFx — effects wait for an audience.
//
// The problem this solves: combat FX used to fire the instant the
// client *noticed* a state change. If you were logged out, looking at
// another planet, or zoomed out to the system view, the explosion
// happened to nobody and was gone forever. Worse, the damage detector
// deliberately skips its first observation (so a page load doesn't
// dump every historical hit at once) — which meant logging in after a
// battle showed you *nothing at all*.
//
// So effects are now QUEUED against the chronicle (the server's
// authoritative event record) and played when the player can actually
// see them:
//
//   - queued from chronicle entries the client hasn't played yet,
//     including ones that happened while logged out;
//   - fired only when the anchor is ON SCREEN and the camera is zoomed
//     in enough to read the scene;
//   - staggered, so a battle replays as a sequence of hits instead of
//     one simultaneous blob;
//   - marked played in localStorage, so each event plays exactly once
//     ever — reloading doesn't re-run the fireworks.
//
// Net effect: zoom into a contested moon and the fight that happened
// while you were away unfolds for you, once, properly.
// ============================================================

/** Chronicle kinds worth a visual, mapped to how they should play. */
export type PendingFxKind = 'destruction' | 'detonation' | 'impact' | 'discovery' | 'damage';

const KIND_MAP: Record<string, PendingFxKind> = {
  ship_destroyed: 'destruction',
  settlement_destroyed: 'destruction',
  builds_destroyed: 'destruction',
  ship_detonated: 'detonation',
  asteroid_impact: 'impact',
  // A discovery blooms at the body the moment you look at it — the whole
  // reason this queue exists is that these were going unnoticed.
  secret_discovered: 'discovery',
  // Took fire and lived. Queued like the rest so a battle you weren't
  // watching still plays its hits when you look at the body.
  ship_damaged: 'damage',
};

export interface PendingFx {
  /** Chronicle entry id — the dedupe + played-set key. */
  id: string;
  kind: PendingFxKind;
  /** Anchor, already stripped to client-side id space. */
  bodyId?: string;
  shipId?: string;
  /** When this entered the queue (wall clock). */
  queuedMs: number;
}

/** Don't sit on an unwatched effect forever — if the player never looks,
 *  it ages out rather than ambushing them an hour later. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** Gap between two effects firing, so a batch reads as a sequence. */
const STAGGER_MS = 220;
/** Hard cap on the backlog. A long absence shouldn't queue 200 booms;
 *  keep the most recent, drop the rest (they're in the event log). */
const QUEUE_CAP = 24;
/** Remembered played ids per game, capped so localStorage can't grow
 *  without bound over a long match. */
const PLAYED_CAP = 600;

const pending: PendingFx[] = [];
let lastFiredMs = 0;

/** Played-set, lazily loaded from localStorage per game. */
let playedGameId: string | null = null;
let played: Set<string> = new Set();

function playedKey(gameId: string): string {
  return `orbital:fx-played:${gameId}`;
}

function loadPlayed(gameId: string): void {
  if (playedGameId === gameId) return;
  playedGameId = gameId;
  played = new Set();
  try {
    const raw = localStorage.getItem(playedKey(gameId));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) played = new Set(arr.filter(x => typeof x === 'string'));
    }
  } catch { /* private mode / corrupt entry — start clean */ }
}

function persistPlayed(): void {
  if (!playedGameId) return;
  try {
    // Keep the tail (most recently added) when trimming.
    const arr = [...played];
    const trimmed = arr.length > PLAYED_CAP ? arr.slice(arr.length - PLAYED_CAP) : arr;
    if (trimmed.length !== arr.length) played = new Set(trimmed);
    localStorage.setItem(playedKey(playedGameId), JSON.stringify(trimmed));
  } catch { /* storage full / unavailable — in-memory set still works */ }
}

export interface ChronicleFxSource {
  id: string;
  kind: string;
  bodyId?: string;
  shipId?: string;
}

/**
 * Queue any chronicle entries that deserve a visual and haven't played.
 * Safe to call every poll — already-played and already-queued entries
 * are ignored, so re-feeding the same rolling window is a no-op.
 *
 * NOTE on first load: this intentionally DOES queue events from before
 * the session. That's the point — you log in and watch what you missed.
 */
export function ingestChronicleFx(gameId: string, entries: ChronicleFxSource[]): void {
  if (!gameId) return;
  loadPlayed(gameId);
  const nowMs = performance.now();
  for (const e of entries) {
    const kind = KIND_MAP[e.kind];
    if (!kind) continue;
    if (!e.bodyId && !e.shipId) continue; // nowhere to draw it
    if (played.has(e.id)) continue;
    if (pending.some(p => p.id === e.id)) continue;
    pending.push({ id: e.id, kind, bodyId: e.bodyId, shipId: e.shipId, queuedMs: nowMs });
  }
  // Age out the unwatched, then cap to the most recent.
  for (let i = pending.length - 1; i >= 0; i--) {
    if (nowMs - pending[i].queuedMs > PENDING_TTL_MS) pending.splice(i, 1);
  }
  if (pending.length > QUEUE_CAP) pending.splice(0, pending.length - QUEUE_CAP);
}

/**
 * Fire at most one queued effect per STAGGER_MS, and only ones the
 * player can actually see.
 *
 * @param locate  resolve an entry to a canvas position, or null when it
 *                isn't visible (off-screen, too far zoomed out, or the
 *                anchor no longer exists). Caller owns that policy.
 * @param fire    actually spawn the effect at the given position.
 */
export function drainVisibleFx(
  nowMs: number,
  locate: (fx: PendingFx) => { x: number; y: number } | null,
  fire: (fx: PendingFx, pos: { x: number; y: number }) => void,
): void {
  if (pending.length === 0) return;
  if (nowMs - lastFiredMs < STAGGER_MS) return;

  for (let i = 0; i < pending.length; i++) {
    const fx = pending[i];
    // Expired while waiting — drop silently, no visual.
    if (nowMs - fx.queuedMs > PENDING_TTL_MS) {
      pending.splice(i, 1);
      played.add(fx.id);
      persistPlayed();
      return;
    }
    const pos = locate(fx);
    if (!pos) continue; // not watchable yet — keep waiting
    pending.splice(i, 1);
    played.add(fx.id);
    persistPlayed();
    lastFiredMs = nowMs;
    fire(fx, pos);
    return; // one per stagger window
  }
}

/** Test/debug hook. */
export function resetPendingFx(): void {
  pending.length = 0;
  played = new Set();
  playedGameId = null;
  lastFiredMs = 0;
}

/** How many effects are waiting for the player to look. */
export function pendingFxCount(): number {
  return pending.length;
}
