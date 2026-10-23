// Frame callbacks the studio's film clock holds back.
//
// While the studio records or films, it swaps requestAnimationFrame for a
// virtual clock (director.ts installVirtualClock) and draws the map itself
// once per frame through MapCanvas's __benchDraw hook. The map's own loop
// must then stay queued, or the map would draw twice a frame. Every OTHER
// frame callback still has to run: the world menu's fade-in (useEasedZ in
// WorldMenuOverlay) is one, and holding it kept the menu at opacity 0, so
// it never mounted and a shot's cursor found nothing to click (the
// "building on a world" clip, 2026-10-23).
//
// So the map marks the callbacks that draw it, and the clock holds only
// those. Outside a recording the mark does nothing.

const held = new WeakSet<FrameRequestCallback>();

/** Mark a frame callback as a map draw the studio's clock should hold. */
export function studioHeldFrame<T extends FrameRequestCallback>(cb: T): T {
  held.add(cb);
  return cb;
}

/** True for a callback marked with studioHeldFrame. */
export function isStudioHeldFrame(cb: FrameRequestCallback): boolean {
  return held.has(cb);
}
