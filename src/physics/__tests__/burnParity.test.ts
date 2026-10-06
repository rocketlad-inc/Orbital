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
  G_ANCHOR as W_G_ANCHOR, SHIP_ENGINE_G, BRAKE_MUL, FLIP_FRACTION,
  burnTicks, boostAccelFor,
} from '../../../worker/burn.js';
import { torchStateAt, V_REF as W_V_REF } from '../../../worker/transitCombat.js';
import { burnProgress } from '../../../worker/orbitPos.js';
import {
  G_ANCHOR, DEFAULT_ENGINE_G, fromG, planTorchTransfer, stepTorchShip, launchFromPlan,
  setMpBurnProfile, baseEngineG, brakeAccelFor,
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
    expect((plan.flipTick - plan.startTick) / T).toBeCloseTo(FLIP_FRACTION, 6);
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
