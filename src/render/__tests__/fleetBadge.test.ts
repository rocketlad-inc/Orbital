import fs from 'fs';
import path from 'path';
import { buildBadgeSegments } from '../fleetBadge';

/**
 * Three player reports, one root cause: a hull still under way was
 * counted into the DESTINATION world's badge and its own sprite
 * dropped, so the map put a ship on a planet it had not reached.
 *
 *  - "Map shows a ship parked at Haumea while the Fleet panel shows the
 *    same ship still 29 ticks out in transit"
 *  - "T1 hostile marker near Quaoar with an approach line and no ship"
 *  - "Ship at Pluto shows no icon until you zoom in"
 *
 * A badge is now strictly "ships that are HERE". A ship in flight draws
 * at its real position.
 */
describe('fleet count badges — parked hulls only', () => {
  it('prints the parked count as a bare number', () => {
    const [seg] = buildBadgeSegments(new Map([['rival', 4]]), 'player');
    expect(seg.count).toBe(4);
    expect(seg.label).toBe('4');
  });

  it('gives each faction present exactly one pill, viewer first', () => {
    const segs = buildBadgeSegments(
      new Map([['zeta', 1], ['player', 2], ['alpha', 3]]),
      'player',
    );
    expect(segs.map(s => `${s.factionId}:${s.label}`))
      .toEqual(['player:2', 'alpha:3', 'zeta:1']);
  });

  it('is stable across frames for the same input', () => {
    const parked = new Map([['delta', 1], ['bravo', 2], ['player', 1]]);
    const a = buildBadgeSegments(parked, 'player');
    const b = buildBadgeSegments(parked, 'player');
    expect(a.map(s => s.factionId)).toEqual(b.map(s => s.factionId));
  });

  it('never prints a zero or a negative tally', () => {
    const segs = buildBadgeSegments(
      new Map([['player', 0], ['rival', -1], ['ghost', NaN]]),
      'player',
    );
    expect(segs).toEqual([]);
  });

  it('returns nothing for an empty body', () => {
    expect(buildBadgeSegments(new Map(), 'player')).toEqual([]);
  });
});

/**
 * Source guard. The regression the players actually hit lives in
 * MapCanvas's per-ship loop, which needs a canvas and a live game to
 * exercise — so this asserts the SHAPE of that loop instead: a ship in
 * transit must never be routed into a body's count badge.
 *
 * Same technique as jsxTextEscapes.test.ts. Brittle by nature, which is
 * the point: if someone reintroduces a destination-badge collapse, this
 * is the thing that argues with them.
 */
describe('MapCanvas: a ship in transit is never badged at its destination', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'components', 'MapCanvas.tsx'),
    'utf8',
  );

  it('has no inbound/arriving cluster accumulator', () => {
    // Counting a hull onto the world it is flying to, under any name.
    expect(src).not.toMatch(/bumpInbound/);
    expect(src).not.toMatch(/bodyInbound/);
  });

  it('never bumps a cluster using a transit destination body id', () => {
    // bumpCluster's argument must always be a ship's CURRENT parent
    // body, never the target of a transfer.
    const calls = src.match(/bumpCluster\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/dest/i);
      expect(call).not.toMatch(/target/i);
    }
  });

  it('still collapses PARKED hulls into badges — the LOD is intact', () => {
    // The fix must not have thrown out the zoom-out declutter along
    // with the phantom counts.
    expect(src).toMatch(/bumpCluster\(bodyId, ship\.ownedBy\)/);
  });
});
