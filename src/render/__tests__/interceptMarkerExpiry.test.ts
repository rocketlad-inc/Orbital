// "It keeps showing an intercept point behind them."
//
// drawInterceptMarkersLayer took a currentTick and never read it, so a
// firing window was never retired once it closed. The reticle is drawn
// where the window OPENS; the hull flies on; the marker stays put and
// ends up behind the ships it was warning about, until the next tick's
// forecast happens to drop it. The forecast only recomputes once per
// server tick, so that could be a long time on screen.

import { liveInterceptMarkers } from '../mapRenderer';
import type { InterceptMarker } from '../mapRenderer';

const mk = (o: Partial<InterceptMarker>): InterceptMarker => ({
  x: 0, y: 0, opensAt: 10, duration: 4, hitChance: 0.5,
  open: false, canAnswer: true, foes: 1, ex: 1, ey: 1, closesAt: 14,
  ...o,
});

describe('liveInterceptMarkers', () => {
  it('retires a window that has closed', () => {
    const m = mk({ opensAt: 10, closesAt: 14 });
    expect(liveInterceptMarkers([m], 14.1)).toEqual([]);
    expect(liveInterceptMarkers([m], 20)).toEqual([]);
  });

  it('keeps a window that has not opened yet, and calls it not-open', () => {
    const out = liveInterceptMarkers([mk({ opensAt: 10, closesAt: 14 })], 8);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(false);
  });

  it('marks a window open once the tick reaches it', () => {
    const out = liveInterceptMarkers([mk({ opensAt: 10, closesAt: 14, open: false })], 11.5);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(true);
  });

  it('corrects a stale open flag downward too', () => {
    // Forecast said FIRING; the smoothed tick has not reached it yet.
    const out = liveInterceptMarkers([mk({ opensAt: 10, closesAt: 14, open: true })], 9);
    expect(out[0].open).toBe(false);
  });

  it('tracks between server ticks on a fractional tick', () => {
    const m = mk({ opensAt: 10, closesAt: 11 });
    expect(liveInterceptMarkers([m], 10.5)).toHaveLength(1);
    expect(liveInterceptMarkers([m], 11.0)).toEqual([]);
  });

  it('keeps unrelated markers untouched by identity when nothing changed', () => {
    const m = mk({ opensAt: 10, closesAt: 14, open: false });
    expect(liveInterceptMarkers([m], 9)[0]).toBe(m);
  });

  it('filters a mixed set', () => {
    const live = mk({ opensAt: 20, closesAt: 24 });
    const dead = mk({ opensAt: 1, closesAt: 5 });
    expect(liveInterceptMarkers([dead, live], 12)).toEqual([live]);
  });
});
