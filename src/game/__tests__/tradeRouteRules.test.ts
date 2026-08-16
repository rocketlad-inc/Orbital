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
import { routeProblem, routeIsValid, MIN_STOPS } from '../tradeRouteRules';

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
