// The Studio's close-up of a battle in flight: hulls in flight draw a
// fixed size at every zoom, so only this multiplier makes them bigger.

import { transitHullScale, setStudioHullScale } from '../cameraLimits';

describe('studio hull scale', () => {
  afterEach(() => setStudioHullScale(1));

  it('multiplies the in-flight hull size at every zoom', () => {
    const base = transitHullScale(1.1);
    setStudioHullScale(2.2);
    expect(transitHullScale(1.1)).toBeCloseTo(base * 2.2, 9);
  });

  it('a nonsense value means no close-up', () => {
    const base = transitHullScale(1.1);
    setStudioHullScale(0);
    expect(transitHullScale(1.1)).toBe(base);
    setStudioHullScale(Number.NaN);
    expect(transitHullScale(1.1)).toBe(base);
  });
});
