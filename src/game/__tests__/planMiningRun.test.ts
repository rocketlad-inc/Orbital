// STARTING A RUN FROM THE ROCK.
//
// The composer could always express a mining run, but only for a player
// who already knew the shape: pick the rock, pick a delivery world, and
// find the one freighter that happens to carry a rig. planMiningRun
// works that out from the rock you are looking at.
//
// The cases that matter most here are the REFUSALS. An offer to start a
// run that the composer would then reject — no rigged hull, nowhere to
// deliver — is worse than no offer, because the player only finds out
// after committing.

import { planMiningRun } from '../mining';
import type { Body, GameState } from '../../types';

const rock = (id: string, remaining = 900): Body => ({
  id, name: id, type: 'meteoroid',
  orbitRadius: 700, orbitPeriod: 1500, angle0: 0,
  radius: 0.4, soi: 0, color: '#999',
  mineralKind: 'metal', mineralInitial: 1000, mineralRemaining: remaining,
} as Body);

const world = (id: string, terraformed: boolean): Body => ({
  id, name: id, type: 'terrestrial',
  orbitRadius: 372, orbitPeriod: 580, angle0: 0,
  radius: 4, soi: 20, color: '#59f',
  terraformedAtTick: terraformed ? 1 : null,
} as Body);

const ship = (id: string, parts: string[], parentBodyId = 'home'): any => ({
  id, name: id, class: 'freighter', ownedBy: 'player',
  parts, orbit: { parentBodyId },
});

/** Positions are injected, so the test states them outright. */
const POS: Record<string, { x: number; y: number }> = {
  MTR: { x: 700, y: 0 },
  home: { x: 0, y: 0 },
  far: { x: -900, y: 0 },
  near: { x: 600, y: 0 },
};
const posOf = (b: Body) => POS[b.id] ?? { x: 0, y: 0 };

function state(over: Partial<GameState> = {}): GameState {
  return {
    bodies: [rock('MTR'), world('home', true)],
    ships: [ship('frt-1', ['mining'])],
    settlements: [{ bodyId: 'home', ownedBy: 'player' }],
    tradeRoutes: [],
    currentTick: 10,
    ...over,
  } as unknown as GameState;
}

describe('planMiningRun', () => {
  it('plans mine -> dropoff with a rigged freighter', () => {
    const r = planMiningRun(rock('MTR'), state(), posOf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.carrierId).toBe('frt-1');
    expect(r.plan.dropoff.id).toBe('home');
    expect(r.plan.stops).toEqual([
      { bodyId: 'MTR', action: 'mine' },
      { bodyId: 'home', action: 'dropoff' },
    ]);
  });

  it('refuses when no freighter carries a rig', () => {
    const r = planMiningRun(rock('MTR'), state({ ships: [ship('frt-1', ['armor'])] } as any), posOf);
    expect(r).toEqual({ ok: false, reason: 'no_rig' });
  });

  it('refuses when the only freighter is already employed', () => {
    // ONE JOB PER HULL is a server rule; offering an employed ship is
    // offering a move that gets refused.
    const r = planMiningRun(rock('MTR'), state({
      tradeRoutes: [{ id: 'r1', ships: [{ shipId: 'frt-1' }] }],
    } as any), posOf);
    expect(r).toEqual({ ok: false, reason: 'no_rig' });
  });

  it('refuses when no world of yours is terraformed', () => {
    // Mirrors the composer's dropoff rule via the shared eligibleBodies:
    // a raw world cannot take delivery.
    const r = planMiningRun(rock('MTR'), state({
      bodies: [rock('MTR'), world('home', false)],
    } as any), posOf);
    expect(r).toEqual({ ok: false, reason: 'no_dropoff' });
  });

  it('refuses an exhausted rock', () => {
    const r = planMiningRun(rock('MTR', 0), state(), posOf);
    expect(r).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('picks the delivery world NEAREST the rock', () => {
    // The loaded leg is the one that matters — it is the one carrying
    // something worth taking off you.
    const r = planMiningRun(rock('MTR'), state({
      bodies: [rock('MTR'), world('far', true), world('near', true)],
      settlements: [
        { bodyId: 'far', ownedBy: 'player' },
        { bodyId: 'near', ownedBy: 'player' },
      ],
    } as any), posOf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.dropoff.id).toBe('near');
  });

  it('picks the rigged freighter nearest the rock', () => {
    const r = planMiningRun(rock('MTR'), state({
      bodies: [rock('MTR'), world('home', true), world('near', true)],
      ships: [ship('far-one', ['mining'], 'far'), ship('close-one', ['mining'], 'near')],
    } as any), posOf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.carrierId).toBe('close-one');
  });
});
