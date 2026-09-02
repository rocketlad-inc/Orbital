// "I wish it auto-cancelled the route if the asteroid's empty."
//
// A worked-out rock never refills, so a route pointed only at dead
// rocks flies its loop forever mining nothing. miningRouteIsSpent is
// the decision to retire one -- deliberately narrow, because retiring a
// route that still has real work to do is far worse than leaving a
// pointless one running.

import { miningRouteIsSpent } from '../../../worker/routeMath.js';

const mine = (bodyId: string) => ({ action: 'mine', body_id: bodyId });
const drop = (bodyId: string) => ({ action: 'dropoff', body_id: bodyId });
const pick = (bodyId: string) => ({ action: 'pickup', body_id: bodyId });

describe('miningRouteIsSpent', () => {
  it('retires a mine-and-deliver route whose rock is dead', () => {
    const stops = [mine('rock1'), drop('home')];
    expect(miningRouteIsSpent(stops, new Set())).toBe(true);
  });

  it('keeps it while the rock still has ore', () => {
    const stops = [mine('rock1'), drop('home')];
    expect(miningRouteIsSpent(stops, new Set(['rock1']))).toBe(false);
  });

  it('keeps a multi-rock route while ANY rock is alive', () => {
    const stops = [mine('rock1'), mine('rock2'), drop('home')];
    expect(miningRouteIsSpent(stops, new Set(['rock2']))).toBe(false);
    expect(miningRouteIsSpent(stops, new Set())).toBe(true);
  });

  it('never retires a route that also lifts goods off a settlement', () => {
    // The rock is dead, but the pickup leg is still a working supply
    // line. Killing it would destroy real logistics over an unrelated
    // stop.
    const stops = [mine('rock1'), pick('colony'), drop('home')];
    expect(miningRouteIsSpent(stops, new Set())).toBe(false);
  });

  it('ignores a route with no mining at all', () => {
    expect(miningRouteIsSpent([pick('a'), drop('b')], new Set())).toBe(false);
    expect(miningRouteIsSpent([drop('b')], new Set())).toBe(false);
  });

  it('is safe on malformed input rather than retiring on a guess', () => {
    expect(miningRouteIsSpent([], new Set())).toBe(false);
    expect(miningRouteIsSpent(null as never, new Set())).toBe(false);
    expect(miningRouteIsSpent([{ action: 'mine' }] as never, new Set())).toBe(false);
  });

  it('accepts a plain array of live bodies as well as a Set', () => {
    const stops = [mine('rock1'), drop('home')];
    expect(miningRouteIsSpent(stops, ['rock1'])).toBe(false);
    expect(miningRouteIsSpent(stops, [])).toBe(true);
  });
});
