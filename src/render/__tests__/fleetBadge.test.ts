import { buildBadgeSegments, ARRIVING_PREFIX } from '../fleetBadge';

/**
 * Three player reports, one root cause: a hull still under way was
 * counted into the destination's PARKED tally, so the badge on the
 * world claimed ships that had not arrived.
 *
 *  - "Map shows ship parked at Haumea while Fleet panel shows T-29"
 *  - "T1 hostile marker at Quaoar with an approach line and no ship"
 *
 * The load-bearing invariant is the first test: the two tallies must
 * never sum into one number.
 */
describe('fleet count badges — parked vs inbound', () => {
  it('never folds an inbound hull into the parked count', () => {
    // Two parked at Haumea, one colony ship still 29 ticks out.
    const segs = buildBadgeSegments(
      new Map([['player', 2]]),
      new Map([['player', 1]]),
      'player',
    );
    // The bug drew this as a single "3".
    expect(segs).toHaveLength(2);
    expect(segs.map(s => s.count)).toEqual([2, 1]);
    expect(segs.map(s => s.arriving)).toEqual([false, true]);
    // No segment claims more hulls than are actually at the body.
    const parkedTotal = segs.filter(s => !s.arriving)
      .reduce((n, s) => n + s.count, 0);
    expect(parkedTotal).toBe(2);
  });

  it('marks an arriving segment in its printed label', () => {
    const [seg] = buildBadgeSegments(new Map(), new Map([['rival', 1]]), 'player');
    expect(seg.arriving).toBe(true);
    expect(seg.label).toBe(`${ARRIVING_PREFIX}1`);
  });

  it('leaves a parked label as a bare number', () => {
    const [seg] = buildBadgeSegments(new Map([['rival', 4]]), new Map(), 'player');
    expect(seg.arriving).toBe(false);
    expect(seg.label).toBe('4');
    expect(seg.label).not.toContain(ARRIVING_PREFIX);
  });

  it('renders an inbound-only body — the Quaoar case, nothing parked', () => {
    // A hostile inbound to a world with no garrison. This must still
    // produce a badge: it is the terminus the approach line points at,
    // and a line running to nothing is what made it read as a phantom.
    const segs = buildBadgeSegments(new Map(), new Map([['rival', 1]]), 'player');
    expect(segs).toHaveLength(1);
    expect(segs[0].arriving).toBe(true);
  });

  it('puts the viewer first, then a stable order, parked before arriving', () => {
    const segs = buildBadgeSegments(
      new Map([['zeta', 1], ['player', 2]]),
      new Map([['alpha', 3], ['player', 4]]),
      'player',
    );
    expect(segs.map(s => `${s.factionId}:${s.label}`)).toEqual([
      'player:2', 'zeta:1',
      `player:${ARRIVING_PREFIX}4`, `alpha:${ARRIVING_PREFIX}3`,
    ]);
  });

  it('is stable across frames for the same input', () => {
    const parked = new Map([['delta', 1], ['bravo', 2], ['player', 1]]);
    const a = buildBadgeSegments(parked, new Map(), 'player');
    const b = buildBadgeSegments(parked, new Map(), 'player');
    expect(a.map(s => s.factionId)).toEqual(b.map(s => s.factionId));
  });

  it('never prints a zero or a negative tally', () => {
    const segs = buildBadgeSegments(
      new Map([['player', 0], ['rival', -1]]),
      new Map([['ghost', 0]]),
      'player',
    );
    expect(segs).toEqual([]);
  });

  it('returns nothing for an empty body', () => {
    expect(buildBadgeSegments(new Map(), new Map(), 'player')).toEqual([]);
  });
});
