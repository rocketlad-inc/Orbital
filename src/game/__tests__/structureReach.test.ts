// [pure] The reach ring is drawn at the radius the SERVER applies.
//
// Noah, 2026-09-24: "can we get an indicator for how far '700 units'
// is?". The ring is that indicator, so its size has to be the real one:
// vision rides system_scale x sensor_scale (worker/state.js), weapons
// ride system_scale alone (room.js megaRangeScale).

import { reachSpec, reachWorldRadius, reachLabel, isReachPinned, setReachPinned } from '../structureReach';

describe('[pure] structureReach', () => {
  it('a Null Field on a system_scale 4 map blinds out to 2800 (Noah\'s game)', () => {
    expect(reachWorldRadius('null_field', { sensorScale: 4, systemScale: 4 })).toBe(2800);
  });

  it('vision follows the sensor knob on top of the map scale', () => {
    expect(reachWorldRadius('deep_array', { sensorScale: 8, systemScale: 4 })).toBe(1100 * 8);
  });

  it('a gun does NOT: sensor_scale 2 on a scale-4 map leaves the station at 2800', () => {
    expect(reachWorldRadius('weapons_station', { sensorScale: 8, systemScale: 4 })).toBe(2800);
    expect(reachWorldRadius('gravity_sink', { sensorScale: 8, systemScale: 4 })).toBe(2000);
  });

  it('missing scales fall back to 1, not 0', () => {
    expect(reachWorldRadius('weapons_station', {})).toBe(700);
  });

  it('structures with no reach draw no ring', () => {
    expect(reachSpec('warp_gate')).toBeNull();
    expect(reachWorldRadius('mobile_foundry', { sensorScale: 4, systemScale: 4 })).toBe(0);
  });

  it('the ring label repeats the card\'s number', () => {
    expect(reachLabel('null_field')).toBe('BLIND ZONE · 700');
    expect(reachLabel('weapons_station')).toBe('GUN RANGE · 700');
  });

  it('pins toggle per structure', () => {
    setReachPinned('mega_a', true);
    expect(isReachPinned('mega_a')).toBe(true);
    expect(isReachPinned('mega_b')).toBe(false);
    setReachPinned('mega_a', false);
    expect(isReachPinned('mega_a')).toBe(false);
  });
});
