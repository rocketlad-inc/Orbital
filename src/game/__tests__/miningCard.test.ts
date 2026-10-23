// THE CARGO CARD MUST TELL THE TRUTH ABOUT A MINING RUN.
//
// Filmed (mining-run-to-a-meteoroid, 8.3-11 s): a freighter on a mining
// route sat on its rock filling 50 -> 100 -> 150 while its card offered
// "BEGIN MINING ... cannot leave until you stop it", and after the rock
// was worked out it still offered BEGIN MINING. The card only knew the
// MANUAL order (ship.miningBodyId); a route's dig never sets it, and the
// server refuses a manual order on a routed hull anyway (409 on_a_route).

import { miningCardState, MiningCardInput } from '../mining';

const ROCK = 'g:mtr_mars_l3';
const HOME = 'g:earth';
const run = (nextStopSeq: number) => ({
  stops: [{ bodyId: ROCK, action: 'mine' }, { bodyId: HOME, action: 'dropoff' }],
  nextStopSeq,
});
const base: MiningCardInput = {
  hasRig: true, rockId: ROCK, rockLeft: 100, holdRoom: 350,
  inTransit: false, canOrder: true, miningBodyId: null, pending: null, route: null,
};

describe('miningCardState: a mining ROUTE parked on its rock', () => {
  it('reads as mining now, by the route, not as an offer to begin', () => {
    expect(miningCardState({ ...base, route: run(0) })).toEqual({ mode: 'working', byRoute: true });
  });

  it('a worked-out rock reads as done and leaving for the drop-off, never BEGIN MINING', () => {
    expect(miningCardState({ ...base, rockLeft: 0, route: run(0) }))
      .toEqual({ mode: 'leaving', reason: 'dry', nextBodyId: HOME });
  });

  it('a full hold reads as leaving for the drop-off', () => {
    expect(miningCardState({ ...base, holdRoom: 0, route: run(0) }))
      .toEqual({ mode: 'leaving', reason: 'full', nextBodyId: HOME });
  });

  it('works without the manual-order callback (the route needs no button)', () => {
    expect(miningCardState({ ...base, canOrder: false, route: run(0) }).mode).toBe('working');
  });

  it('a routed hull at a rock its route does not mine gets no mining card (the server refuses a manual dig)', () => {
    const other = { stops: [{ bodyId: 'g:luna', action: 'pickup' }, { bodyId: HOME, action: 'dropoff' }], nextStopSeq: 0 };
    expect(miningCardState({ ...base, route: other })).toEqual({ mode: 'hidden' });
  });

  it('a routed hull whose cursor has moved past the rock is not mining it', () => {
    expect(miningCardState({ ...base, route: run(1) })).toEqual({ mode: 'hidden' });
  });
});

describe('miningCardState: manual mining is unchanged', () => {
  it('idle on a rock offers BEGIN MINING', () => {
    expect(miningCardState(base)).toEqual({ mode: 'idle' });
  });
  it('a manual order reads as working, not by a route', () => {
    expect(miningCardState({ ...base, miningBodyId: ROCK })).toEqual({ mode: 'working', byRoute: false });
  });
  it('the optimistic flag wins until the server agrees', () => {
    expect(miningCardState({ ...base, pending: true })).toEqual({ mode: 'working', byRoute: false });
    expect(miningCardState({ ...base, miningBodyId: ROCK, pending: false })).toEqual({ mode: 'idle' });
  });
  it('no manual-order callback (SP) hides the manual card', () => {
    expect(miningCardState({ ...base, canOrder: false })).toEqual({ mode: 'hidden' });
  });
  it('in transit or rigless: hidden', () => {
    expect(miningCardState({ ...base, inTransit: true, route: run(0) })).toEqual({ mode: 'hidden' });
    expect(miningCardState({ ...base, hasRig: false, route: run(0) })).toEqual({ mode: 'hidden' });
  });
});
