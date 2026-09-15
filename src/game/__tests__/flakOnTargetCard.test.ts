// THE ODDS ON THE CARD MUST BE THE ODDS THE SERVER ROLLS.
//
// The CURRENT TARGET card quoted hitChanceOf over each hull's own combat
// speed, while worker/room.js multiplies every speed by the flak parked
// in the orbit before it rolls. Three enemy flak took ~14% off a speed
// and the card never moved. These pin enemyFlakOn to the server's rule
// exactly: per body, living, PARKED, hostile mounts only.

import fs from 'fs';
import path from 'path';
import { enemyFlakOn } from '../targeting';
import { flakSlowMultiplier } from '../shipParts';
import { Ship } from '../../types';

const mkShip = (o: Partial<Ship> & { id: string; ownedBy: string }): Ship => ({
  class: 'destroyer',
  orbit: { parentBodyId: 'enceladus' },
  parts: [],
  ...o,
} as unknown as Ship);

const ME = 'player';
const THEM = 'them';
const FRIEND = 'friend';
const flak = (n: number) => Array(n).fill('flak');

describe('enemyFlakOn mirrors the FLAK BATTERIES block', () => {
  const me = mkShip({ id: 'a1', ownedBy: ME });

  it('three hostile parked mounts slow to flakSlowMultiplier(3)', () => {
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(2) }),
      mkShip({ id: 'e2', ownedBy: THEM, parts: ['weapon', 'flak'] }),
    ]);
    expect(r.mounts).toBe(3);
    expect(r.mul).toBeCloseTo(flakSlowMultiplier(3), 10);
  });

  it('an orbit with no flak leaves speed alone', () => {
    const r = enemyFlakOn(me, [me, mkShip({ id: 'e1', ownedBy: THEM, parts: ['weapon'] })]);
    expect(r).toEqual({ mounts: 0, mul: 1 });
  });

  it('a hull in flight is not in the formation', () => {
    // The server excludes in_transit rows from every body's crowd, so a
    // flak ship that has left the orbit slows nobody there.
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(3), transit: {} as Ship['transit'] }),
    ]);
    expect(r.mounts).toBe(0);
  });

  it('nor is it under the flak that stayed behind', () => {
    const flying = mkShip({ id: 'a2', ownedBy: ME, transit: {} as Ship['transit'] });
    const r = enemyFlakOn(flying, [flying, mkShip({ id: 'e1', ownedBy: THEM, parts: flak(3) })]);
    expect(r.mul).toBe(1);
  });

  it('your own flak never slows you', () => {
    const r = enemyFlakOn(me, [me, mkShip({ id: 'a2', ownedBy: ME, parts: flak(4) })]);
    expect(r.mounts).toBe(0);
  });

  it('a treaty partner\'s flak is not pointed at you', () => {
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'f1', ownedBy: FRIEND, parts: flak(2) }),
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(1) }),
    ], ['friend|player']);
    expect(r.mounts).toBe(1);
  });

  it('counts only the orbit it is standing in', () => {
    // A moon and its planet are separate stations.
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(3), orbit: { parentBodyId: 'saturn' } as Ship['orbit'] }),
    ]);
    expect(r.mounts).toBe(0);
  });

  it('a dead hull shoots no flak, a full-health one (hp undefined) does', () => {
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(2), hp: 0 }),
      mkShip({ id: 'e2', ownedBy: THEM, parts: flak(1) }),
    ]);
    expect(r.mounts).toBe(1);
  });

  it('stacks across every hostile faction present', () => {
    // Two rivals at war with us AND each other: the server sums every
    // non-own, non-partner faction's mounts against a hull.
    const r = enemyFlakOn(me, [
      me,
      mkShip({ id: 'e1', ownedBy: THEM, parts: flak(2) }),
      mkShip({ id: 'x1', ownedBy: 'other', parts: flak(2) }),
    ]);
    expect(r.mounts).toBe(4);
  });
});

describe('the card reads speed through the mirror', () => {
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'src/components/ShipPanel.tsx'), 'utf8',
  );

  it('both halves of the hit roll carry the flak multiplier', () => {
    // One helper, both speeds. Applying it to one side only would put
    // the card back to disagreeing with the tick, just less obviously.
    expect(panel).toMatch(/const mySpeed = hullSpeed \* myFlak\.mul/);
    expect(panel).toMatch(/const targetSpeed = targetHullSpeed \* targetFlak\.mul/);
    expect(panel).toMatch(/hitChanceOf\(mySpeed, targetSpeed\)/);
  });
});
