// ============================================================
// discoveryAck — discoveries the player has actually SEEN.
//
// The discovery banner is the "notice" surface; the situation-report
// row is the backstop. Left alone the row waited out a fixed tick
// window (25 ticks) before clearing — long enough that a discovery you
// already acknowledged sat there for several ticks "needing a decision"
// it didn't (player report). Now the banner marks a discovery seen when
// it's shown and dismissed, and the report reads that to close its row
// immediately. The tick window stays only as a fallback for discoveries
// that never bannered (e.g. revealed while you were logged out).
//
// Keyed by bodyId + the reveal tick, which is unique per discovery, and
// persisted so a reload doesn't resurrect a row you already dismissed.
// ============================================================

const STORAGE_KEY = 'orbital:disc-ack';
const CAP = 400;

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  cache = new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) cache = new Set(arr.filter((x) => typeof x === 'string'));
    }
  } catch { /* private mode / corrupt — start empty */ }
  return cache;
}

function persist(set: Set<string>): void {
  try {
    const arr = [...set];
    const trimmed = arr.length > CAP ? arr.slice(arr.length - CAP) : arr;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* storage unavailable — in-memory set still works this session */ }
}

/** Stable id for one discovery. `tick` is the reveal tick
 *  (secret.discoveredAtTick); pair with the body it fired at. */
export function discoveryAckKey(bodyId: string, tick: number | undefined): string {
  return `${bodyId}:${tick ?? 0}`;
}

export function ackDiscovery(bodyId: string, tick: number | undefined): void {
  const set = load();
  const key = discoveryAckKey(bodyId, tick);
  if (set.has(key)) return;
  set.add(key);
  if (set.size > CAP) cache = new Set([...set].slice(set.size - CAP));
  persist(cache!);
}

export function isDiscoveryAcked(bodyId: string, tick: number | undefined): boolean {
  return load().has(discoveryAckKey(bodyId, tick));
}
