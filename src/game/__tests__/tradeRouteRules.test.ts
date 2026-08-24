// THE COMPOSER MUST NOT REFUSE A ROUTE THE SERVER WOULD ACCEPT.
//
// The inline copy of these rules in RouteComposer required a stop with
// action 'pickup'. A mining run is mine -> dropoff and has no pickup at
// all, so the composer disabled the save button on the only route shape
// mining can produce, and reported "nothing is picked up anywhere" for a
// route that loads several hundred units off a rock. The server had
// accepted `pickup || mine` since the day mine stops were added. Every
// server-side test passed, because the server was never asked.
//
// So this pins the client rule to the SERVER SOURCE, not to a
// restatement of it. If someone tightens validateStops, the mirror
// fails here rather than in a playtest.

import fs from 'fs';
import path from 'path';
import { routeProblem, routeIsValid, MIN_STOPS, eligibleBodies } from '../tradeRouteRules';

const server = fs.readFileSync(
  path.resolve(__dirname, '../../../worker/tradeRoutesV2.js'), 'utf8',
);

describe('client route rules mirror the server', () => {
  it('the server still treats a mine stop as loading', () => {
    // The exact predicate. If this line moves, the mirror above is
    // suspect and the failure should be loud.
    expect(server).toMatch(/s\.action === 'pickup' \|\| s\.action === 'mine'/);
  });

  it('the server still requires a dropoff', () => {
    expect(server).toMatch(/s\.action === 'dropoff'/);
  });

  it('agrees with the server on the minimum stop count', () => {
    // The server validates the RAW payload before normalising it.
    const m = /(?:raw|stops)\.length\s*<\s*(\d+)/.exec(server);
    expect(m).toBeTruthy();
    expect(MIN_STOPS).toBe(Number(m![1]));
  });
});

describe('routeProblem', () => {
  const mine = { action: 'mine' as const };
  const drop = { action: 'dropoff' as const };
  const pick = { action: 'pickup' as const };

  it('ACCEPTS a pure mining run — mine then dropoff', () => {
    // The regression. This is the whole feature.
    expect(routeProblem([mine, drop])).toBeNull();
    expect(routeIsValid([mine, drop])).toBe(true);
  });

  it('accepts an ordinary haul', () => {
    expect(routeProblem([pick, drop])).toBeNull();
  });

  it('accepts a mixed run that both mines and collects', () => {
    expect(routeProblem([pick, mine, drop])).toBeNull();
  });

  it('rejects a route that never loads anything', () => {
    expect(routeProblem([drop, drop])).toMatch(/loaded/);
  });

  it('rejects a route that never delivers', () => {
    expect(routeProblem([mine, pick])).toMatch(/dropped off/);
  });

  it('rejects a single stop', () => {
    expect(routeProblem([mine])).toMatch(/two stops/);
  });
});


// ---------------------------------------------------------------
// CONSTRUCTION SITES AS DESTINATIONS.
//
// A site is the third kind of stop, and it breaks both rules the other
// two rely on: it is not a settlement you own (so the ownership gate
// would drop it) and it is not terraformed (so the dropoff gate would).
// It also has one condition neither shares — a FINISHED structure wants
// nothing, and offering it produces a route the server refuses with
// 'already_done' while the player wonders why the stop was listed.
// ---------------------------------------------------------------

type LooseState = Parameters<typeof eligibleBodies>[0];

const world = (over: Record<string, unknown> = {}) => ({
  bodies: [], settlements: [], megastructures: {}, ...over,
}) as unknown as LooseState;

const siteBody = (id: string) => ({ id, name: id, type: 'megastructure' });
const siteState = (id: string, status: 'building' | 'complete') => ({
  [id]: {
    bodyId: id, kind: 'warp_gate', status,
    accMetal: 0, accCredits: 0, costMetal: 100, costCredits: 100,
    partnerBodyId: null, foundedByFactionId: 'player', foundedAtTick: 0,
    completedAtTick: null,
  },
});

describe('construction sites are eligible stops', () => {
  it('an unfinished site is offered', () => {
    const st = world({ bodies: [siteBody('s1')], megastructures: siteState('s1', 'building') });
    expect(eligibleBodies(st).sites.map(b => b.id)).toEqual(['s1']);
  });

  it('a FINISHED structure is not', () => {
    const st = world({ bodies: [siteBody('s1')], megastructures: siteState('s1', 'complete') });
    expect(eligibleBodies(st).sites).toEqual([]);
  });

  it('a site with no build state is not offered', () => {
    // Defensive: a body typed megastructure with nothing in the side
    // table is malformed, and guessing would list a stop the server
    // cannot resolve.
    const st = world({ bodies: [siteBody('s1')], megastructures: {} });
    expect(eligibleBodies(st).sites).toEqual([]);
  });

  it('needs no settlement, the way a rock does not', () => {
    // The ownership gate drops anything the player has no settlement on.
    // A site has to be tested before it, or the only deliverable
    // structures would be ones built on top of a world you already hold.
    const st = world({ bodies: [siteBody('s1')], megastructures: siteState('s1', 'building') });
    expect(eligibleBodies(st).sites).toHaveLength(1);
    expect(eligibleBodies(st).pickup).toEqual([]);
  });

  it('a site never lands in pickup or dropoff', () => {
    // Both would be wrong in a way that reads as working: pickup would
    // try to load FROM a construction site, and dropoff implies the
    // terraformed-world rule that a site does not satisfy.
    const st = world({ bodies: [siteBody('s1')], megastructures: siteState('s1', 'building') });
    const e = eligibleBodies(st);
    expect({ pickup: e.pickup.length, dropoff: e.dropoff.length }).toEqual({ pickup: 0, dropoff: 0 });
  });

  it('leaves rocks and worlds alone', () => {
    const st = world({
      bodies: [
        siteBody('s1'),
        { id: 'rock', name: 'MTR-1', type: 'meteoroid', mineralKind: 'metal', mineralRemaining: 500 },
        { id: 'home', name: 'Home', type: 'terrestrial', terraformedAtTick: 3 },
      ],
      settlements: [{ bodyId: 'home', ownedBy: 'player' }],
      megastructures: siteState('s1', 'building'),
    });
    const e = eligibleBodies(st);
    expect({
      sites: e.sites.map(b => b.id),
      mineable: e.mineable.map(b => b.id),
      dropoff: e.dropoff.map(b => b.id),
    }).toEqual({ sites: ['s1'], mineable: ['rock'], dropoff: ['home'] });
  });
});
