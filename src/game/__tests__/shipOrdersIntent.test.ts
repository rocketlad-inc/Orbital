// [pure] Every standing-order field the ship panel sets reaches the server.
//
// Alante, 2026-09-23 ("been like this all day"): setting MINED or
// "WHEN a hostile enters orbit -> DETONATE" showed "This client sent an
// invalid request (no order fields supplied)". The panel forwarded a
// hand-kept list of fields that predated those orders, so the request
// carried only the ship id.

import { shipOrdersIntent } from '../shipOrdersIntent';

describe('[pure] shipOrdersIntent', () => {
  it('forwards the MINED rule and its mode (the reported case)', () => {
    expect(shipOrdersIntent('s1', { detonateOnHostile: true, detonateMineMode: 'hostile' }))
      .toEqual({ shipIds: ['s1'], detonateOnHostile: true, detonateMineMode: 'hostile' });
  });

  it('forwards a scheduled detonation', () => {
    expect(shipOrdersIntent('s1', { detonateAtTick: 700, detonateAtGuard: 'hostile_in_orbit' }))
      .toEqual({ shipIds: ['s1'], detonateAtTick: 700, detonateAtGuard: 'hostile_in_orbit' });
  });

  it('forwards every key it is given, not a fixed list', () => {
    const patch = {
      stance: 'hold' as const, retreatHpPct: 50 as const, retreatBodyId: null,
      arrivalAction: 'detonate' as const, arrivalGuard: 'hostile_in_orbit' as const,
      detonateAtTick: null, detonateAtGuard: null, detonateOnHostile: false,
      detonateMineMode: null, detonateHpPct: 25 as const, targetPriority: null,
    };
    const out = shipOrdersIntent('s1', patch);
    for (const k of Object.keys(patch)) expect(out).toHaveProperty(k);
  });

  it('an explicit null clears; undefined becomes null (clear)', () => {
    expect(shipOrdersIntent('s1', { retreatHpPct: undefined })).toEqual({ shipIds: ['s1'], retreatHpPct: null });
  });

  it('stance: undefined still means "leave the stance alone"', () => {
    expect(shipOrdersIntent('s1', { stance: undefined, detonateOnHostile: true }))
      .toEqual({ shipIds: ['s1'], detonateOnHostile: true });
  });
});
