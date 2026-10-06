// ONE BURN: PUSH, FLIP AT 90%, BRAKE NINE TIMES HARDER.
//
// worker/burn.js owns the burn. The server times trade, retreat and
// delivery legs with it and integrates every leg in flight for transit
// combat (worker/transitCombat.js torchStateAt). The client plans every
// player leg (planTorchTransfer) and draws and fogs every hull from its
// own integrator (stepTorchShip). These hold the four to one another, and
// prove the hard brake actually brakes: a short leg is a few ticks long
// and the brake a tenth of that, so whole-tick steps (all an even burn
// ever needed) boost straight through it.

import {
  G_ANCHOR as W_G_ANCHOR, SHIP_ENGINE_G, MAX_ENGINE_G, RAMP_TICKS, BRAKE_MUL,
  burnTicks, boostAccelFor, burnShape as wBurnShape, legTicks, shapeForArrival, GROWTH_TAU,
} from '../../../worker/burn.js';
import { torchStateAt, V_REF as W_V_REF } from '../../../worker/transitCombat.js';
import { burnProgress, legProgress } from '../../../worker/orbitPos.js';
import {
  G_ANCHOR, DEFAULT_ENGINE_G, fromG, planTorchTransfer, stepTorchShip, launchFromPlan,
  setMpBurnProfile, baseEngineG, brakeAccelFor, mpRampFor, burnShape as cBurnShape, boostState,
} from '../torchTransfer';
import { V_REF } from '../../game/firingWindows';
import type { Body } from '../../types';

// A target that (effectively) sits still at 3000 units, so the trip
// length is exact: an orbit period of a trillion ticks.
const sun = { id: 'sun', type: 'star', radius: 10 } as unknown as Body;
const rock = {
  id: 'rock', parent: 'sun', type: 'asteroid', radius: 1, orbitRadius: 3000, orbitPeriod: 1e12, angle0: 0,
} as unknown as Body;
const bodies = [sun, rock];

afterEach(() => setMpBurnProfile(null));

describe('the burn', () => {
  it('client and server agree on the anchor and the combat reference', () => {
    expect(G_ANCHOR).toBe(W_G_ANCHOR);
    expect(V_REF).toBe(W_V_REF);
  });

  it('with no profile installed the planners are exactly what single player always ran', () => {
    expect(baseEngineG(undefined)).toBe(DEFAULT_ENGINE_G);
    expect(baseEngineG(0.2)).toBe(0.2);
    expect(brakeAccelFor(26.52)).toBe(26.52);
  });

  it('multiplayer pushes at the server\'s g and brakes 9x', () => {
    setMpBurnProfile({ engineG: SHIP_ENGINE_G, brakeMul: BRAKE_MUL });
    // The floor: 0.05g until the evening of 2026-10-06, then 0.02g "to slow
    // down intermoon a bit". (A flat 1g shipped for 21 minutes that day.)
    expect(SHIP_ENGINE_G).toBe(0.02);
    expect(BRAKE_MUL).toBe(9);
    expect(fromG(baseEngineG(undefined))).toBeCloseTo(10.608, 6);
    expect(brakeAccelFor(100)).toBe(900);
  });

  it('the planner flips at 90% and arrives when burn.js says it will', () => {
    const a = fromG(SHIP_ENGINE_G);
    const plan = planTorchTransfer(
      { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a, a * BRAKE_MUL, 0, bodies,
    )!;
    const T = plan.arriveTick - plan.startTick;
    expect(T).toBeCloseTo(burnTicks(3000, a), 6);
    // A flat push with a 9x brake flips at k/(1+k) = 90%.
    expect((plan.flipTick - plan.startTick) / T).toBeCloseTo(BRAKE_MUL / (1 + BRAKE_MUL), 6);
    expect(boostAccelFor(3000, T)).toBeCloseTo(a, 6);
    // 0.745x an even burn at the same push.
    expect(T / (2 * Math.sqrt(3000 / a))).toBeCloseTo(0.745, 3);
    // The brake travels with the launch plan to the server.
    expect(launchFromPlan(plan).brakeAccel).toBe(a * BRAKE_MUL);
  });

  it('server and client fly a hard-brake leg to the same point, and it really brakes', () => {
    const a = fromG(SHIP_ENGINE_G);
    const plan = planTorchTransfer(
      { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a, a * BRAKE_MUL, 0, bodies,
    )!;
    const T = plan.arriveTick;
    const server = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: a, brakeAccel: a * BRAKE_MUL, flipTick: plan.flipTick,
      startTick: 0, arriveTick: T, interceptX: 3000, interceptY: 0, targetBodyId: 'rock',
    };
    const still = () => ({ x: 0, y: 0 });
    let peak = 0;
    for (const f of [0.25, 0.5, 0.85, 0.9, 0.95, 0.99]) {
      const t = T * f;
      const s = torchStateAt(server, still, t);
      const c = stepTorchShip({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, plan, 0, t, bodies);
      expect(Math.hypot(s.pos.x - c.pos.x, s.pos.y - c.pos.y)).toBeLessThan(1e-6);
      // On the burn's own distance curve (what fog and the sink use).
      expect(s.pos.x / 3000).toBeCloseTo(burnProgress(f, BRAKE_MUL), 2);
      peak = Math.max(peak, Math.hypot(s.vel.x, s.vel.y));
    }
    // Just before arrival it is nearly there and nearly stopped. With
    // whole-tick steps it overshoots the target at full speed instead.
    const late = torchStateAt(server, still, T * 0.999);
    expect(3000 - late.pos.x).toBeLessThan(1);
    expect(Math.hypot(late.vel.x, late.vel.y)).toBeLessThan(peak * 0.02);
  });

  it('an even burn (every leg before migration 0155) is integrated exactly as before', () => {
    const a = fromG(0.05);
    const plan = planTorchTransfer({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a, a, 0, bodies)!;
    const legacy = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0, accel: a, flipTick: plan.flipTick,
      startTick: 0, arriveTick: plan.arriveTick, interceptX: 3000, interceptY: 0, targetBodyId: 'rock',
    };
    const t = plan.arriveTick * 0.6;
    const nullBrake = torchStateAt({ ...legacy, brakeAccel: null }, () => ({ x: 0, y: 0 }), t);
    const absent = torchStateAt(legacy, () => ({ x: 0, y: 0 }), t);
    expect(nullBrake).toEqual(absent);
    expect(burnProgress(0.3, 1)).toBe(burnProgress(0.3));
    expect(burnProgress(0.3)).toBeCloseTo(2 * 0.09, 12);
  });
});

// THE PUSH BUILDS FROM LAUNCH, EXPONENTIALLY: 0.05g doubling about every 11
// ticks to 1g at 48, then the 9x brake at whatever push was reached
// (Lorne, 2026-10-06: first linear, then "exponential, so it starts
// muuuuch slower but leads to the same result"). These pin the numbers he
// approved and hold the client's copy of the solver and integrator to the
// server's — for the exponential build every new leg flies, and for the
// linear one legs committed before the switch are still flying.
describe('the build-up', () => {
  const profile = () => setMpBurnProfile({
    engineG: SHIP_ENGINE_G, brakeMul: BRAKE_MUL, maxG: MAX_ENGINE_G, rampTicks: RAMP_TICKS,
    growthTau: GROWTH_TAU,
  });
  const at = (r: number) => [sun, { ...rock, orbitRadius: r } as unknown as Body];
  const a0 = fromG(SHIP_ENGINE_G);
  const still = () => ({ x: 0, y: 0 });

  it('gives the trip times Lorne picked (System scale 4, typical routes)', () => {
    expect(MAX_ENGINE_G).toBe(1);
    expect(RAMP_TICKS).toBe(48);
    // It reaches the same top at the same tick the linear build did.
    expect(boostState(48, a0, 0, fromG(1), GROWTH_TAU).a).toBeCloseTo(fromG(1), 6);
    // In WHOLE TICKS, as the server lands them (it rounds arrival up).
    const ticks = [625, 2709, 4835, 19235, 28530, 36880].map(d => Math.ceil(legTicks(d, a0)));
    // Io-Callisto, Earth-Mars, Earth-Jupiter, Neptune-Pluto,
    // Pluto-Makemake, Makemake-Sedna.
    expect(ticks).toEqual([10, 18, 23, 35, 39, 42]);
  });

  it('the client plans exactly the leg the server times', () => {
    profile();
    for (const d of [300, 2709, 28530]) {
      const r = mpRampFor(a0)!;
      expect(r.max).toBeCloseTo(fromG(MAX_ENGINE_G), 9);
      expect(r.tau).toBe(GROWTH_TAU);
      const plan = planTorchTransfer(
        { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, brakeAccelFor(a0), 0, at(d), undefined, r,
      )!;
      const w = wBurnShape(d, a0, 0, r.max, BRAKE_MUL, GROWTH_TAU);
      expect(plan.arriveTick).toBeCloseTo(legTicks(d, a0), 6);
      expect(plan.flipTick).toBeCloseTo(w.t1, 6);
      expect(plan.brakeAcceleration).toBeCloseTo(w.brake, 6);
      expect(cBurnShape(d, a0, 0, r.max, BRAKE_MUL, GROWTH_TAU).T).toBe(w.T);
      const launch = launchFromPlan(plan);
      expect(launch.accelTau).toBe(GROWTH_TAU);
      expect(launch.accelMax).toBe(r.max);
      expect(launch.accelRamp).toBeUndefined();
    }
  });

  it('engine parts lift the whole curve, and single player gets no build', () => {
    expect(mpRampFor(a0)).toBeUndefined();
    profile();
    const fast = mpRampFor(a0 * 1.5)!;
    const base = mpRampFor(a0)!;
    expect(fast.max / base.max).toBeCloseTo(1.5, 9);
    expect(fast.tau).toBe(base.tau);
  });

  it('server and client fly an exponential leg to the same point; fog and the sink agree; it stops', () => {
    profile();
    const d = 28530;
    const r = mpRampFor(a0)!;
    const plan = planTorchTransfer(
      { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, brakeAccelFor(a0), 0, at(d), undefined, r,
    )!;
    const T = plan.arriveTick;
    const server = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: a0, brakeAccel: plan.brakeAcceleration, accelTau: r.tau, accelMax: r.max,
      flipTick: plan.flipTick, startTick: 0, arriveTick: T, interceptX: d, interceptY: 0, targetBodyId: 'rock',
    };
    const leg = {
      accel: a0, brake: plan.brakeAcceleration, tau: r.tau, max: r.max,
      startTick: 0, flipTick: plan.flipTick, arriveTick: T,
    };
    for (const f of [0.2, 0.5, 0.8, 0.94, 0.97, 0.99]) {
      const s = torchStateAt(server, still, T * f);
      const c = stepTorchShip({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, plan, 0, T * f, at(d));
      // Float rounding only (hypot vs sqrt) over a 28,530-unit trip.
      expect(Math.hypot(s.pos.x - c.pos.x, s.pos.y - c.pos.y)).toBeLessThan(1e-4);
      expect(s.pos.x / d).toBeCloseTo(legProgress(f, leg), 3);
    }
    // A thousandth of the trip from the end it is all but there and
    // braking hard to the last: ~2% of its top speed left.
    const late = torchStateAt(server, still, T * 0.999);
    expect(Math.abs(d - late.pos.x)).toBeLessThan(2);
    expect(Math.hypot(late.vel.x, late.vel.y)).toBeLessThan(plan.peakVelocity * 0.03);
  });

  it('a linear leg (committed before the switch) still flies as planned on both sides', () => {
    const d = 28530;
    // The linear build launched at the old 0.05g floor.
    const a0 = fromG(0.05);
    const max = fromG(1), ramp = (max - a0) / 48;
    const plan = planTorchTransfer(
      { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, a0 * BRAKE_MUL, 0, at(d), undefined, { ramp, max },
    )!;
    expect(plan.accelRamp).toBe(ramp);
    expect(plan.accelTau).toBeUndefined();
    const server = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: a0, brakeAccel: plan.brakeAcceleration, accelRamp: ramp, accelMax: max,
      flipTick: plan.flipTick, startTick: 0, arriveTick: plan.arriveTick, interceptX: d, interceptY: 0, targetBodyId: 'rock',
    };
    const t = plan.arriveTick * 0.7;
    const s = torchStateAt(server, still, t);
    const c = stepTorchShip({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, plan, 0, t, at(d));
    expect(Math.hypot(s.pos.x - c.pos.x, s.pos.y - c.pos.y)).toBeLessThan(1e-4);
    // Pluto -> Makemake on the linear build: the 24 T Lorne saw at lunch.
    expect(Math.round(wBurnShape(d, a0, ramp, max, BRAKE_MUL).T)).toBe(24);
  });

  it('a server-planned leg (trade, escort) lands exactly on its committed tick', () => {
    const d = 19235;
    const T = Math.ceil(legTicks(d, a0)) + 2;            // ceiled, then paced late
    const s = shapeForArrival(d, T);
    expect(s.tau).toBe(GROWTH_TAU);
    const plan = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: s.accel, brakeAccel: s.brake, accelTau: s.tau, accelMax: s.max,
      flipTick: s.t1, startTick: 0, arriveTick: T, interceptX: d, interceptY: 0, targetBodyId: 'rock',
    };
    const late = torchStateAt(plan, still, T * 0.999);
    expect(Math.abs(d - late.pos.x)).toBeLessThan(2);
    expect(wBurnShape(d, s.accel, 0, s.max, BRAKE_MUL, s.tau).T).toBeCloseTo(T, 6);
  });

  it('a flat leg (every leg before migration 0158) is integrated exactly as before', () => {
    const a = fromG(0.05);
    const flat = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0, accel: a, brakeAccel: a * BRAKE_MUL, flipTick: 14,
      startTick: 0, arriveTick: 16, interceptX: 3000, interceptY: 0, targetBodyId: 'rock',
    };
    const t = 9;
    expect(torchStateAt({ ...flat, accelRamp: null, accelMax: null, accelTau: null }, still, t))
      .toEqual(torchStateAt(flat, still, t));
  });
});
