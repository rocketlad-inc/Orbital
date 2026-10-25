// ============================================================
// stateFetchGate — one budget for every caller of the /state fetch.
//
// Five things ask for a fresh /state: the poll loop, every successful
// action (orbital:refresh-state), the room socket's tick, a language flip,
// and the "an ask came in while one was in flight" re-run. They used to
// share only an in-flight guard, and the re-run fired the instant the
// previous response landed. Any caller that asked at least once per round
// trip therefore kept /state running back to back: measured on staging
// (headless Chrome, a fresh trial, playtest R2-C11) as bursts of 3-8
// requests a second against a steady one per ~1.6 s.
//
// Now every ask goes through this gate:
//   - at most ONE request in flight;
//   - starts are at least `minGapMs` apart;
//   - asks that land while one is in flight or waiting collapse into ONE
//     trailing request, so the newest state still arrives.
// ============================================================

export interface FetchGateDeps {
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export function makeFetchGate(
  run: () => Promise<void>,
  minGapMs: number,
  deps: FetchGateDeps = {},
): () => Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let inflight = false;
  let waiting = false;      // a deferred start is scheduled
  let again = false;        // asked while in flight: run once more after
  let lastStart = -Infinity;

  const fire = async (): Promise<void> => {
    waiting = false;
    inflight = true;
    lastStart = now();
    try {
      await run();
    } finally {
      inflight = false;
      if (again) { again = false; void request(); }
    }
  };

  const request = (): Promise<void> => {
    if (inflight) { again = true; return Promise.resolve(); }
    if (waiting) return Promise.resolve();
    const wait = lastStart + minGapMs - now();
    if (wait > 0) {
      waiting = true;
      setT(() => { void fire(); }, wait);
      return Promise.resolve();
    }
    return fire();
  };
  return request;
}
