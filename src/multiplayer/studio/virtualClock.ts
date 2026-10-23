import { isStudioHeldFrame } from './heldFrames';

export type VirtualClock = ReturnType<typeof installVirtualClock>;

/**
 * A clock only the caller advances. Date.now, performance.now and
 * requestAnimationFrame are swapped for the recording; `advance(ms)` moves
 * time and runs the frame callbacks that were waiting, which is how the
 * map draws exactly one frame per call. `real(fn)` runs fn against the
 * wall clock (server waits, the recorder's own hold timers).
 */
export function installVirtualClock() {
  const D = Date.now, P = performance.now.bind(performance);
  const RAF = window.requestAnimationFrame, CAF = window.cancelAnimationFrame;
  const baseD = D(), baseP = P();
  let v = 0;
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextId = 1;
  let inReal = 0;
  const vNow = () => baseD + v;
  Date.now = () => (inReal ? D() : vNow());
  performance.now = () => (inReal ? P() : baseP + v);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = nextId++; queue.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id: number) => { queue = queue.filter(q => q.id !== id); };
  return {
    /** Move time by `ms` and run the frame callbacks that were waiting.
     *  With `mapDrawnByHook` (the recorder draws the map itself through
     *  __benchDraw) the map's own draws, marked studioHeldFrame, stay
     *  queued for the next call or for uninstall; every other callback
     *  (the world menu's fade-in, the outliner's icons) still runs, or the
     *  interface froze where it stood when filming began. Returns how
     *  many ran. */
    advance(ms: number, mapDrawnByHook = false): number {
      v += ms;
      const cbs = queue; queue = [];
      let ran = 0;
      for (const q of cbs) {
        if (mapDrawnByHook && isStudioHeldFrame(q.cb)) { queue.push(q); continue; }
        ran++;
        try { q.cb(baseP + v); } catch (e) { console.error(e); }
      }
      return ran;
    },
    async real<T>(fn: () => Promise<T> | T): Promise<T> {
      inReal++;
      try { return await fn(); } finally { inReal--; }
    },
    realNow: () => P(),
    /** The film's clock, even inside real(): what a frame is drawn at. */
    virtualNow: () => vNow(),
    uninstall() {
      Date.now = D; performance.now = P;
      window.requestAnimationFrame = RAF; window.cancelAnimationFrame = CAF;
      // Hand the map's loop back to the real clock.
      const cbs = queue; queue = [];
      for (const q of cbs) RAF(q.cb);
    },
  };
}
