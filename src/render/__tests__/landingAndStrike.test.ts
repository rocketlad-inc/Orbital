// Two judges' findings on the Mega Destroyer clip (2026-10-22).
//
// A LANDING IS ONE MOTION: a hull arriving in orbit was drawn at its
// flight size and heading one frame and its orbit's the next (at close
// zoom, twice the size and a quarter turn round).
//
// THE WORLD DIES WHEN IT IS SHOT: the tick that sterilises a world lands
// before its death animation starts, and un-terraforms it, so a living
// Earth drew as bare dead rock with no shot fired.
import {
  noteFlightLook, noteParkedLook, landingLook, departureLook, LANDING_MORPH_MS,
  drawnTerraformFraction, sterilisedBlend,
} from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import { spawnSterilisation } from '../combatFx';
import type { Body } from '../../types';

describe('a landing is one motion', () => {
  test('eases from the flight look to the orbit look', () => {
    noteFlightLook('lander', 60, 0, 1000);
    const first = landingLook('lander', 120, Math.PI / 2, 1033);
    expect(first.size).toBeCloseTo(60, 1);
    expect(first.heading).toBeCloseTo(0, 2);
    const mid = landingLook('lander', 120, Math.PI / 2, 1033 + LANDING_MORPH_MS / 2);
    expect(mid.size).toBeGreaterThan(70);
    expect(mid.size).toBeLessThan(110);
    const done = landingLook('lander', 120, Math.PI / 2, 1033 + LANDING_MORPH_MS + 1);
    expect(done).toMatchObject({ size: 120, heading: Math.PI / 2, plume: 0 });
  });

  test('the engine it came in on dies away, not in a frame', () => {
    noteFlightLook('burner', 60, 0, 2000, 0.85, 1.4);
    const first = landingLook('burner', 120, 0, 2033);
    expect(first.plume).toBeCloseTo(0.85, 1);
    expect(first.len).toBe(1.4);
    expect(landingLook('burner', 120, 0, 2033 + LANDING_MORPH_MS * 0.25).plume).toBeGreaterThan(0.1);
    expect(landingLook('burner', 120, 0, 2033 + LANDING_MORPH_MS * 0.6).plume).toBe(0);
  });

  test('a hull parked all along is drawn as it is', () => {
    expect(landingLook('resident', 84, 1, 5000)).toMatchObject({ size: 84, heading: 1 });
  });

  test('a flight look long gone is not a landing', () => {
    noteFlightLook('old', 60, 0, 1000);
    expect(landingLook('old', 120, 2, 9000)).toMatchObject({ size: 120, heading: 2 });
  });

  test('and leaving orbit eases the other way, out of the parked look', () => {
    // Judges, round 2: the Mega group went from specks to giants in the
    // frame it lit off. Parked look first (drawShip notes it), then flight.
    noteParkedLook('leaver', 20, 1, 3000);         // drawn parked at 20 px
    const first = departureLook('leaver', 150, 0, 3033);
    expect(first.size).toBeCloseTo(20, 0);
    const done = departureLook('leaver', 150, 0, 3033 + LANDING_MORPH_MS + 1);
    expect(done).toEqual({ size: 150, heading: 0 });
  });
});

describe('the world dies when it is shot', () => {
  const ctxAt = (t: number, nowMs: number) => ({ t, nowMs } as unknown as RenderContext);
  const living = { id: 'earth-x', terraformedAtTick: 0 } as unknown as Body;
  const struck = { id: 'earth-x', terraformedAtTick: null, sterilisedAtTick: 27 } as unknown as Body;

  test('struck, its death not begun: still drawn living, no ash', () => {
    expect(drawnTerraformFraction(living, ctxAt(26.5, 0))).toBe(1);
    expect(drawnTerraformFraction(struck, ctxAt(27.05, 0))).toBe(1);
    expect(sterilisedBlend(struck, ctxAt(27.05, 0))).toBe(0);
  });

  test('once its death plays, the surface goes under the fire, then ash', () => {
    const t0 = performance.now();
    spawnSterilisation('strike-1', 'earth-x');
    expect(drawnTerraformFraction(struck, ctxAt(27.1, t0 + 200))).toBe(1);      // the beam
    expect(drawnTerraformFraction(struck, ctxAt(27.5, t0 + 4000))).toBe(0);     // past the fire's peak
    expect(sterilisedBlend(struck, ctxAt(27.5, t0 + 200))).toBe(0);
    expect(sterilisedBlend(struck, ctxAt(30, t0 + 60000))).toBe(1);             // dead for good
  });

  test('a world struck long ago is simply dead', () => {
    const old = { id: 'mars-x', terraformedAtTick: null, sterilisedAtTick: 3 } as unknown as Body;
    expect(sterilisedBlend(old, ctxAt(40, 0))).toBe(1);
  });
});
