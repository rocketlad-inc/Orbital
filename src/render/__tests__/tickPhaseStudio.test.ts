/**
 * @jest-environment node
 */
// The Studio's display-tick override (tickPhase.ts): while a clip is
// filmed the director supplies the tick to draw at; otherwise the phase
// comes from next_tick_at as it always has.
import { smoothedTick, setStudioDisplayTick } from '../tickPhase';

describe('smoothedTick with the Studio override', () => {
  afterEach(() => setStudioDisplayTick(null));

  it('uses the server cadence when no override is set', () => {
    // Half way through a 1000 ms tick.
    expect(smoothedTick(10, 2000, 1000, 1500)).toBeCloseTo(10.5);
  });

  it('defers to the override while filming, whatever next_tick_at says', () => {
    // A next_tick_at stamped on the real clock, far ahead of the film's
    // clock: the old phase sat at 0 and the map jumped each tick.
    expect(smoothedTick(10, 9_999_999, 900, 1000)).toBe(10);
    setStudioDisplayTick((ct) => ct + 0.25);
    expect(smoothedTick(10, 9_999_999, 900, 1000)).toBeCloseTo(10.25);
  });

  it('hands back to the server cadence when the override is cleared', () => {
    setStudioDisplayTick(() => 99);
    setStudioDisplayTick(null);
    expect(smoothedTick(10, 2000, 1000, 1500)).toBeCloseTo(10.5);
  });
});
