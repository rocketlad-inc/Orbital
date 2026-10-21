// A missile salvo is drawn meeting its target ON the target's drawn line
// (Lorne, 2026-10-20: "why don't these lines match up?").
import { missileDrawnRendezvous } from '../mapRenderer';
import { rendezvousStateAt } from '../../physics/rendezvous.js';

const real = {
  p0: { x: -881.9, y: -1198.5 }, v0: { x: 9.09, y: -6.69 }, accel: 96.2,
  A: { x: -202.12, y: 642.36 }, B: { x: 0, y: 0 }, startTick: 254, meetTick: 261,
  followShipId: 'g:st_w3earth_3',
};
// The target's drawn chord: a straight line, timed along.
const chord = (t: number) => ({ x: -1633 + (t - 252) * 48, y: 1562 - (t - 252) * 150 });

describe('missileDrawnRendezvous', () => {
  it('meets the target where its DRAWN path puts it at the meeting', () => {
    const drawn = missileDrawnRendezvous(real, chord);
    const meet = rendezvousStateAt(drawn, drawn.meetTick, null).pos;
    expect(meet.x).toBeCloseTo(chord(261).x, 6);
    expect(meet.y).toBeCloseTo(chord(261).y, 6);
  });
  it('still leaves from its launch point, creeping off and gathering speed', () => {
    const drawn = missileDrawnRendezvous(real, chord);
    expect(rendezvousStateAt(drawn, 254, null).pos).toEqual(real.p0);
    const a = rendezvousStateAt(drawn, 255, null).pos, b = rendezvousStateAt(drawn, 260, null).pos;
    const total = Math.hypot(chord(261).x - real.p0.x, chord(261).y - real.p0.y);
    expect(Math.hypot(a.x - real.p0.x, a.y - real.p0.y) / total).toBeCloseTo(1 / 49, 6);
    expect(Math.hypot(b.x - real.p0.x, b.y - real.p0.y) / total).toBeCloseTo(36 / 49, 6);
  });
  it('is the real plan when the target has no drawn path', () => {
    expect(missileDrawnRendezvous(real, null)).toBe(real);
  });
});
