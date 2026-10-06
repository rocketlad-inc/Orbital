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
  burnTicks, boostAccelFor, burnShape as wBurnShape, legTicks, shapeForArrival,
} from '../../../worker/burn.js';
import { torchStateAt, V_REF as W_V_REF } from '../../../worker/transitCombat.js';
import { burnProgress, legProgress } from '../../../worker/orbitPos.js';
import {
  G_ANCHOR, DEFAULT_ENGINE_G, fromG, planTorchTransfer, stepTorchShip, launchFromPlan,
  setMpBurnProfile, baseEngineG, brakeAccelFor, mpRampFor, burnShape as cBurnShape,
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
    // 1g shipped for an hour on 2026-10-06 and was far too fast.
    expect(SHIP_ENGINE_G).toBe(0.05);
    expect(BRAKE_MUL).toBe(9);
    expect(fromG(baseEngineG(undefined))).toBeCloseTo(26.52, 6);
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

// THE PUSH BUILDS FROM LAUNCH: 0.05g -> 1g over 48 ticks, then the 9x
// brake at whatever push was reached (Lorne, 2026-10-06, after a flat 1g
// proved far too fast). These pin the numbers he approved and hold the
// client's copy of the solver and integrator to the server's.
describe('the build-up', () => {
  const profile = () => setMpBurnProfile({
    engineG: SHIP_ENGINE_G, brakeMul: BRAKE_MUL, maxG: MAX_ENGINE_G, rampTicks: RAMP_TICKS,
  });
  const at = (r: number) => [sun, { ...rock, orbitRadius: r } as unknown as Body];
  const a0 = fromG(SHIP_ENGINE_G);

  it('gives the trip times Lorne picked (System scale 4, typical routes)', () => {
    expect(MAX_ENGINE_G).toBe(1);
    expect(RAMP_TICKS).toBe(48);
    const hours = [2709, 4835, 8180, 19235, 28530, 36880].map(d => Math.round(legTicks(d, a0)));
    // Earth-Mars, Earth-Jupiter, Jupiter-Saturn, Neptune-Pluto,
    // Pluto-Makemake, Makemake-Sedna.
    expect(hours).toEqual([10, 12, 15, 21, 24, 26]);
  });

  it('the client plans exactly the leg the server times', () => {
    profile();
    for (const d of [300, 2709, 28530]) {
      const r = mpRampFor(a0)!;
      expect(r.max).toBeCloseTo(fromG(MAX_ENGINE_G), 9);
      const plan = planTorchTransfer(
        { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, brakeAccelFor(a0), 0, at(d), undefined, r,
      )!;
      const w = wBurnShape(d, a0, r.ramp, r.max, BRAKE_MUL);
      expect(plan.arriveTick).toBeCloseTo(legTicks(d, a0), 6);
      expect(plan.flipTick).toBeCloseTo(w.t1, 6);
      expect(plan.brakeAcceleration).toBeCloseTo(w.brake, 6);
      expect(cBurnShape(d, a0, r.ramp, r.max, BRAKE_MUL).T).toBe(w.T);
      const launch = launchFromPlan(plan);
      expect(launch.accelRamp).toBe(r.ramp);
      expect(launch.accelMax).toBe(r.max);
    }
  });

  it('engine parts lift the whole curve, and single player gets no build', () => {
    expect(mpRampFor(a0)).toBeUndefined();
    profile();
    const fast = mpRampFor(a0 * 1.5)!;
    const base = mpRampFor(a0)!;
    expect(fast.max / base.max).toBeCloseTo(1.5, 9);
    expect(fast.ramp / base.ramp).toBeCloseTo(1.5, 9);
  });

  it('server and client fly a building leg to the same point; fog and the sink agree; it stops', () => {
    profile();
    const d = 28530;
    const r = mpRampFor(a0)!;
    const plan = planTorchTransfer(
      { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, 'rock', a0, brakeAccelFor(a0), 0, at(d), undefined, r,
    )!;
    const T = plan.arriveTick;
    const server = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: a0, brakeAccel: plan.brakeAcceleration, accelRamp: r.ramp, accelMax: r.max,
      flipTick: plan.flipTick, startTick: 0, arriveTick: T, interceptX: d, interceptY: 0, targetBodyId: 'rock',
    };
    const leg = {
      accel: a0, brake: plan.brakeAcceleration, ramp: r.ramp, max: r.max,
      startTick: 0, flipTick: plan.flipTick, arriveTick: T,
    };
    const still = () => ({ x: 0, y: 0 });
    for (const f of [0.2, 0.5, 0.8, 0.94, 0.97, 0.99]) {
      const s = torchStateAt(server, still, T * f);
      const c = stepTorchShip({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }, plan, 0, T * f, at(d));
      // Float rounding only (hypot vs sqrt) over a 28,530-unit trip.
      expect(Math.hypot(s.pos.x - c.pos.x, s.pos.y - c.pos.y)).toBeLessThan(1e-4);
      expect(s.pos.x / d).toBeCloseTo(legProgress(f, leg), 3);
    }
    const late = torchStateAt(server, still, T * 0.999);
    expect(Math.abs(d - late.pos.x)).toBeLessThan(2);
    expect(Math.hypot(late.vel.x, late.vel.y)).toBeLessThan(plan.peakVelocity * 0.02);
  });

  it('a server-planned leg (trade, escort) lands exactly on its committed tick', () => {
    const d = 19235;
    const T = Math.ceil(legTicks(d, a0)) + 2;            // ceiled, then paced late
    const s = shapeForArrival(d, T);
    const plan = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0,
      accel: s.accel, brakeAccel: s.brake, accelRamp: s.ramp, accelMax: s.max,
      flipTick: s.t1, startTick: 0, arriveTick: T, interceptX: d, interceptY: 0, targetBodyId: 'rock',
    };
    const late = torchStateAt(plan, () => ({ x: 0, y: 0 }), T * 0.999);
    expect(Math.abs(d - late.pos.x)).toBeLessThan(2);
    expect(wBurnShape(d, s.accel, s.ramp, s.max, BRAKE_MUL).T).toBeCloseTo(T, 6);
  });

  it('a flat leg (every leg before migration 0158) is integrated exactly as before', () => {
    const a = fromG(0.05);
    const flat = {
      launchX: 0, launchY: 0, launchVx: 0, launchVy: 0, accel: a, brakeAccel: a * BRAKE_MUL, flipTick: 14,
      startTick: 0, arriveTick: 16, interceptX: 3000, interceptY: 0, targetBodyId: 'rock',
    };
    const t = 9;
    expect(torchStateAt({ ...flat, accelRamp: null, accelMax: null }, () => ({ x: 0, y: 0 }), t))
      .toEqual(torchStateAt(flat, () => ({ x: 0, y: 0 }), t));
  });
});
