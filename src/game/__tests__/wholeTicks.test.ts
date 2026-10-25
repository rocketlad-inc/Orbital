// R2-C8: a colony ship's ETA read T-11 while paused and T-12 after the
// clock started: one panel rounded the planner's fractional arrival, the
// server lands the hull on the next whole tick.
import { landingTick, ticksUntil } from '../wholeTicks';

test('a fractional arrival lands on the next whole tick', () => {
  expect(landingTick(23.4)).toBe(24);
  expect(ticksUntil(23.4, 12)).toBe(12);   // Math.round said 11
});
test('a whole-tick arrival is not pushed a tick out by float noise', () => {
  expect(landingTick(24.0000000001)).toBe(24);
  expect(ticksUntil(24, 12)).toBe(12);
});
test('never negative, and a smoothed "now" counts from its tick', () => {
  expect(ticksUntil(10, 12)).toBe(0);
  expect(ticksUntil(23.4, 12.7)).toBe(12);
});
