import { installVirtualClock } from '../virtualClock';
import { studioHeldFrame } from '../heldFrames';

// The "building on a world" film (2026-10-23): with the map drawn through
// its hook, the clock held EVERY frame callback, so the world menu's fade
// (a requestAnimationFrame ease) never ran, the menu stayed at opacity 0
// and never mounted, and the cursor found no building to click.
describe('studio virtual clock', () => {
  it('holds only the map draws while the recorder draws the map itself', () => {
    const clock = installVirtualClock();
    try {
      const calls: string[] = [];
      const mapLoop = studioHeldFrame(() => { calls.push('map'); });
      requestAnimationFrame(mapLoop);
      const t0 = performance.now();
      let fadeAt = -1;
      requestAnimationFrame(() => { calls.push('fade'); fadeAt = performance.now(); });

      expect(clock.advance(1000 / 30, true)).toBe(1);
      expect(calls).toEqual(['fade']);
      expect(fadeAt - t0).toBeCloseTo(1000 / 30, 5);   // the fade sees the film's time

      // The map loop is still waiting, and runs when nothing draws it.
      expect(clock.advance(1000 / 30, false)).toBe(1);
      expect(calls).toEqual(['fade', 'map']);
    } finally { clock.uninstall(); }
  });

  it('runs a fade that re-queues itself frame after frame', () => {
    const clock = installVirtualClock();
    try {
      let z = 0;
      const start = performance.now();
      const step = () => {
        z = Math.min(1, (performance.now() - start) / 250);
        if (z < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      for (let k = 0; k < 10; k++) clock.advance(1000 / 30, true);
      expect(z).toBe(1);
    } finally { clock.uninstall(); }
  });

  it('cancels a queued callback', () => {
    const clock = installVirtualClock();
    try {
      let ran = false;
      const id = requestAnimationFrame(() => { ran = true; });
      cancelAnimationFrame(id);
      clock.advance(16, true);
      expect(ran).toBe(false);
    } finally { clock.uninstall(); }
  });
});
