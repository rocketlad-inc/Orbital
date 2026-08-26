import { stationOrbitRadius, parkOrbitRadius } from '../orbitalMechanics';

describe('stationOrbitRadius', () => {
  it('clears the surface by three units on catalogue-sized worlds', () => {
    expect(stationOrbitRadius(3)).toBe(6);      // Earth, body_scale 1
    expect(stationOrbitRadius(1.5)).toBe(4.5);  // Luna
  });

  // THE REPORTED BUG: on a body_scale 2 map the stations sat at
  // catalogue radius + 3 while the worlds had doubled, so the ring
  // landed on the limb. Whatever a stored row says, the rule reads the
  // radius the body actually has.
  it('scales with the body, so a doubled world gets a doubled clearance', () => {
    expect(stationOrbitRadius(6)).toBe(9);
    expect(stationOrbitRadius(6)).toBeGreaterThan(6);
  });

  it('never sits on or under the surface', () => {
    for (const r of [0.6, 1, 1.5, 2, 3, 5, 6, 8, 13, 50, 100]) {
      expect(stationOrbitRadius(r)).toBeGreaterThan(r);
    }
  });

  it('goes proportional on a star rather than hugging it', () => {
    // 50 + 11 = 61, which is what migration 0079 pinned Sol stations to.
    expect(stationOrbitRadius(50)).toBe(61);
  });

  // Pinned as MEASURED, not as the shipped comment claimed. A station
  // only sits under its parked fleet on large bodies; on catalogue-sized
  // planets it rides above them, and at radius 6 the two rings land on
  // exactly the same circle — which is a station and its hulls drawn on
  // top of each other. Recorded so a future re-tune is a decision rather
  // than a discovery.
  it('sits under the park orbit only on large bodies', () => {
    expect(stationOrbitRadius(50)).toBeLessThan(parkOrbitRadius(50));
    expect(stationOrbitRadius(13)).toBeLessThan(parkOrbitRadius(13));
    expect(stationOrbitRadius(3)).toBeGreaterThan(parkOrbitRadius(3));
    expect(stationOrbitRadius(6)).toBe(parkOrbitRadius(6));
  });

  it('treats a missing radius as the default rather than returning 3', () => {
    expect(stationOrbitRadius(0)).toBe(7);
    expect(stationOrbitRadius(-1)).toBe(7);
  });
});
