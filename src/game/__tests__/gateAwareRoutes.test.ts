// "If I start a route to Neptune from Earth it would take 2 days, but
// only half of one through the SOL-Neptune gate."
//
// planGateAwareHop answers "what is the next body" for a trade leg.
// Trade legs are re-planned every tick from wherever the hull actually
// is, so a multi-hop journey needs no stored path -- only an honest
// next-hop each time it is asked.
//
// computeLegTicks is injected, so these run on a fixture distance table
// rather than a database.

import { planGateAwareHop } from '../../../worker/routeMath.js';
import { gateTransitTicks } from '../../../worker/megastructures.js';

// A toy system. Distances are in ticks-of-burn directly, which is what
// computeLegTicks returns anyway.
const LEGS: Record<string, number> = {
  'earth|neptune': 48,     // the long way round: two days
  'earth|solgate': 3,      // Sol gate sits close in
  'solgate|nepgate': 40,   // the crossing, before the quarter applies
  'nepgate|neptune': 2,    // the far end is in Neptune's own space
  'earth|nepgate': 47,
  'solgate|neptune': 46,
  'earth|mars': 6,
  'mars|solgate': 5,
  'mars|nepgate': 44,
  'mars|neptune': 50,
};

const legOf = (a: string, b: string): number => {
  if (a === b) return 0;
  const hit = LEGS[a + '|' + b] ?? LEGS[b + '|' + a];
  if (hit == null) throw new Error('no fixture leg ' + a + '->' + b);
  return hit;
};

const computeLegTicks = async (_f: string, from: string, to: string) => legOf(from, to);
const GATES = [{ a: 'solgate', b: 'nepgate' }];

const hop = (fromId: string, toId: string, gates = GATES) => planGateAwareHop({
  computeLegTicks, gateTransitTicks, gates,
  factionId: 'f1', fromId, toId, tick: 0,
});

describe('planGateAwareHop', () => {
  it('sends an Earth->Neptune run to the gate, not to Neptune', async () => {
    // direct 48; via gate 3 + ceil(40*0.25)=10 + 2 = 15.
    const r = await hop('earth', 'neptune');
    expect(r.viaGate).toBe(true);
    expect(r.target).toBe('solgate');
    expect(r.ticks).toBe(3);
    expect(r.total).toBe(15);
  });

  it('crosses once the hull is sitting on the near end', async () => {
    const r = await hop('solgate', 'neptune');
    expect(r.viaGate).toBe(true);
    expect(r.target).toBe('nepgate');
    expect(r.ticks).toBe(gateTransitTicks(40));   // 10, a quarter burn
  });

  it('flies the last leg normally from the far end', async () => {
    const r = await hop('nepgate', 'neptune');
    expect(r.viaGate).toBe(false);
    expect(r.target).toBe('neptune');
    expect(r.ticks).toBe(2);
  });

  it('ignores the gate when flying direct is faster', async () => {
    // Earth->Mars is 6; the detour is 3 + 10 + 44.
    const r = await hop('earth', 'mars');
    expect(r.viaGate).toBe(false);
    expect(r.target).toBe('mars');
    expect(r.ticks).toBe(6);
  });

  it('compares the WHOLE journey, not the next leg', async () => {
    // Flying to the gate is 3 ticks against 48 direct, so a planner
    // comparing legs would always chase the gate. From Mars the full
    // detour (5+10+2=17) still wins; the point is that it is the total
    // being compared -- confirmed by the direct case above losing.
    const r = await hop('mars', 'neptune');
    expect(r.total).toBe(17);
    expect(r.target).toBe('solgate');
  });

  it('flies direct when there are no gates at all', async () => {
    const r = await hop('earth', 'neptune', []);
    expect(r.viaGate).toBe(false);
    expect(r.target).toBe('neptune');
    expect(r.ticks).toBe(48);
  });

  it('never routes a hull that is already at the far end back through', async () => {
    // Standing on nepgate bound for Neptune must not propose solgate.
    const r = await hop('nepgate', 'neptune');
    expect(r.target).toBe('neptune');
  });

  it('treats the destination as reached', async () => {
    const r = await hop('neptune', 'neptune');
    expect(r.target).toBe('neptune');
    expect(r.ticks).toBe(0);
  });

  it('uses the pair in either direction', async () => {
    // Same pair, entered from the Neptune side.
    const r = await hop('nepgate', 'earth');
    expect(r.viaGate).toBe(true);
    expect(r.target).toBe('solgate');
  });
  it('cannot ping-pong between the two ends', async () => {
    // The one way a next-hop router strands a hull forever: from A it
    // says "cross to B", and from B it says "cross back to A".
    //
    // It cannot happen, and the reason is arithmetic rather than luck.
    // Going back is only chosen when hop + d(A,dest) < d(B,dest), and
    // coming over was only chosen when hop + d(B,dest) < d(A,dest).
    // Add them: 2*hop < 0, and hop is at least 1. So at most one of the
    // two can ever hold. This walks it to be sure.
    let at = 'earth';
    const seen: string[] = [at];
    for (let i = 0; i < 12 && at !== 'neptune'; i++) {
      const r = await hop(at, 'neptune');
      at = r.target;
      seen.push(at);
    }
    expect(at).toBe('neptune');
    // Every body visited exactly once -- no body repeats.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(['earth', 'solgate', 'nepgate', 'neptune']);
  });

  it('the walk terminates from the far side too', async () => {
    let at = 'nepgate';
    const seen: string[] = [at];
    for (let i = 0; i < 12 && at !== 'earth'; i++) {
      const r = await hop(at, 'earth');
      at = r.target;
      seen.push(at);
    }
    expect(at).toBe('earth');
    expect(new Set(seen).size).toBe(seen.length);
  });
});
