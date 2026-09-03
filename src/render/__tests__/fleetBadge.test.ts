import { buildBadgeSegments, ARRIVING_PREFIX } from '../fleetBadge';

/**
 * Three player reports, one root cause: a hull still under way was
 * counted into the destination's PARKED tally, so the badge on the
 * world claimed ships that had not arrived.
 *
 *  - "Map shows a ship parked at Haumea while the Fleet panel shows the
 *    same ship still 29 ticks out in transit"
 *  - "T1 hostile marker near Quaoar with an approach line and no ship"
 *
 * The load-bearing invariant is the first test: the two tallies must
 * never sum into one number.
 */
describe('fleet count badges — parked vs inbound', () => {
  it('never sums an inbound hull into the parked count', () => {
    // Two parked at Haumea, one colony ship still 29 ticks out.
    const segs = buildBadgeSegments(
      new Map([['player', 2]]),
      new Map([['player', 1]]),
      'player',
    );
    expect(segs).toHaveLength(1);
    // The bug printed this as a bare "3".
    expect(segs[0].label).not.toBe('3');
    expect(segs[0].parked).toBe(2);
    expect(segs[0].inbound).toBe(1);
    expect(segs[0].label).toBe(`2${ARRIVING_PREFIX}1`);
  });

  it('keeps a mixed pill solid — ships really are there', () => {
    const [seg] = buildBadgeSegments(
      new Map([['player', 2]]), new Map([['player', 1]]), 'player',
    );
    expect(seg.pending).toBe(false);
  });

  it('marks a pure-inbound pill as pending — the Quaoar case', () => {
    // A hostile inbound to a world with no garrison. This must still
    // produce a badge: it is the terminus the approach line points at,
    // and a line running to nothing is what read as a phantom.
    const segs = buildBadgeSegments(new Map(), new Map([['rival', 1]]), 'player');
    expect(segs).toHaveLength(1);
    expect(segs[0].parked).toBe(0);
    expect(segs[0].pending).toBe(true);
    expect(segs[0].label).toBe(`${ARRIVING_PREFIX}1`);
  });

  it('leaves a parked-only pill as a bare number', () => {
    const [seg] = buildBadgeSegments(new Map([['rival', 4]]), new Map(), 'player');
    expect(seg.label).toBe('4');
    expect(seg.pending).toBe(false);
    expect(seg.label).not.toContain(ARRIVING_PREFIX);
  });

  it('gives each faction exactly one pill, viewer first', () => {
    // Width is load-bearing: the strip has to win a slot from
    // labelLayer or the badge is dropped entirely. One pill per
    // faction, never one per fact.
    const segs = buildBadgeSegments(
      new Map([['zeta', 1], ['player', 2]]),
      new Map([['zeta', 5], ['player', 4], ['alpha', 3]]),
      'player',
    );
    expect(segs).toHaveLength(3);
    expect(segs.map(s => `${s.factionId}:${s.label}`)).toEqual([
      `player:2${ARRIVING_PREFIX}4`,
      `alpha:${ARRIVING_PREFIX}3`,
      `zeta:1${ARRIVING_PREFIX}5`,
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

  it('never emits a label that could be read as a larger garrison', () => {
    // Belt-and-braces on the actual player harm: whatever the mix, the
    // leading digits must be the parked count and nothing else.
    for (const [p, i] of [[0, 1], [1, 0], [2, 1], [10, 4], [1, 12]]) {
      const [seg] = buildBadgeSegments(
        new Map(p > 0 ? [['player', p]] : []),
        new Map(i > 0 ? [['player', i]] : []),
        'player',
      );
      const lead = seg.label.split(ARRIVING_PREFIX)[0];
      expect(lead).toBe(p > 0 ? String(p) : '');
    }
  });
});
