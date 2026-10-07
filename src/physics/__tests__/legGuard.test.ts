// THE LEG GUARD NEVER REFUSES AN HONEST CLIENT, AND ALWAYS REFUSES A FAST ONE.
//
// worker/legGuard.js checks every committed leg against the hull's own
// limits (Lorne, 2026-10-07: the far systems make the game a race, and
// the server used to store whatever plan the client sent). The danger in
// a guard like that is a false refusal: a real player's order bounced.
// So every leg here is planned by the CLIENT's own planner
// (planTorchTransfer + mpRampFor, at the live burn), for hulls with and
// without engine parts, Propulsion research and a Voidrunner captain,
// over distances from a moon hop to Cygnus -- and must pass. Then the
// same legs, doctored the ways a modified client would, must not.

import {
  planTorchTransfer, setMpBurnProfile, mpRampFor, brakeAccelFor, fromG,
} from '../torchTransfer';
import { engineAccelMultiplier } from '../../game/shipParts';
import { traitMul } from '../../game/captains';
import {
  SHIP_ENGINE_G, MAX_ENGINE_G, RAMP_TICKS, GROWTH_TAU, BRAKE_MUL,
} from '../../../worker/burn.js';
import { legRefusal, maxLaunchAccel, engineAccelMul } from '../../../worker/legGuard.js';
import type { Body } from '../../types';

const sun = { id: 'sun', type: 'star', radius: 10 } as unknown as Body;
const rockAt = (r: number) => ({
  id: 'rock', parent: 'sun', type: 'asteroid', radius: 1, orbitRadius: r, orbitPeriod: 1e12, angle0: 0,
} as unknown as Body);

const HULLS: Array<{ parts: string[]; propulsionLvl: number; traits: string[] }> = [
  { parts: [], propulsionLvl: 0, traits: [] },
  { parts: ['engine'], propulsionLvl: 0, traits: [] },
  { parts: ['engine', 'engine', 'engine'], propulsionLvl: 4, traits: [] },
  { parts: [], propulsionLvl: 0, traits: ['voidrunner'] },
  { parts: ['engine', 'engine'], propulsionLvl: 2, traits: ['voidrunner'] },
];
const DISTANCES = [200, 1500, 6000, 24000, 120000, 530000, 680000];

beforeAll(() => setMpBurnProfile({
  engineG: SHIP_ENGINE_G, brakeMul: BRAKE_MUL, maxG: MAX_ENGINE_G, rampTicks: RAMP_TICKS, growthTau: GROWTH_TAU,
}));
afterAll(() => setMpBurnProfile(null));

/** A leg the client would commit, as the server receives it. */
function clientLeg(hull: typeof HULLS[number], d: number, depart = 10) {
  // The client's own engine maths (MultiplayerGameProvider / fleetPace).
  const a0 = fromG(SHIP_ENGINE_G) * engineAccelMultiplier(hull.parts as never, hull.propulsionLvl)
    * traitMul(hull.traits, 'accelMul');
  const plan = planTorchTransfer(
    { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, brakeAccelFor(a0), depart,
    [sun, rockAt(d)], 20, mpRampFor(a0),
  )!;
  return {
    a0max: maxLaunchAccel(hull),
    plan: {
      acc: plan.acceleration, amax: plan.accelMax ?? null, atau: plan.accelTau ?? null,
      rmp: plan.accelRamp ?? null, brk: plan.brakeAcceleration,
    },
    depart, arrive: plan.arriveTick, distance: d,
  };
}

describe('the leg guard', () => {
  it('computes a hull\'s engines exactly as the client does', () => {
    for (const h of HULLS) {
      expect(engineAccelMul(h.parts, h.propulsionLvl))
        .toBeCloseTo(engineAccelMultiplier(h.parts as never, h.propulsionLvl), 12);
    }
  });

  it('never refuses a leg the client planned, for any hull, at any range', () => {
    const refused: string[] = [];
    for (const h of HULLS) {
      for (const d of DISTANCES) {
        const why = legRefusal(clientLeg(h, d));
        if (why) refused.push(`${JSON.stringify(h)} @ ${d}: ${why}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it('refuses a leg that pushes harder, builds faster, tops out higher or brakes harder', () => {
    const leg = clientLeg(HULLS[0], 24000);
    expect(legRefusal({ ...leg, plan: { ...leg.plan, acc: leg.plan.acc * 1.5 } })).toBe('push');
    expect(legRefusal({ ...leg, plan: { ...leg.plan, amax: leg.plan.amax! * 10 } })).toBe('cap');
    expect(legRefusal({ ...leg, plan: { ...leg.plan, atau: leg.plan.atau! / 3 } })).toBe('build');
    expect(legRefusal({ ...leg, plan: { ...leg.plan, brk: leg.plan.brk * 3 } })).toBe('brake');
  });

  it('refuses an arrival sooner than the hull can fly the distance', () => {
    const leg = clientLeg(HULLS[0], 530000);
    expect(legRefusal({ ...leg, arrive: leg.depart + 1 })).toBe('too_soon');
    expect(legRefusal({ ...leg, arrive: leg.depart + (leg.arrive - leg.depart) * 0.5 })).toBe('too_soon');
    // A hull lying about its engines gains nothing: the stock limit holds.
    const fast = clientLeg(HULLS[2], 530000);
    expect(legRefusal({ ...fast, a0max: maxLaunchAccel(HULLS[0]) })).not.toBeNull();
  });

  it('lets a hull fly SLOWER than it could: a fleet paced to its slowest ship', () => {
    const slow = clientLeg(HULLS[0], 24000);
    expect(legRefusal({ ...slow, a0max: maxLaunchAccel(HULLS[2]) })).toBeNull();
  });
});
