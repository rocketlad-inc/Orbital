// ============================================================
// Every flight you can see comes back from solveIntercepts, the ones you
// can't catch with the reason (Lorne, 2026-10-20: "shows ships that you
// can't intercept and shows why ... he couldnt target the ships and didnt
// know why"). A group with no course, or one landing now, used to vanish.
// ============================================================

// Straight-line geometry: a body sits at (orbitRadius, 0); a flight is a
// line from its start to its intercept point over its ticks.
jest.mock('../../render/mapRenderer', () => ({
  torchTrajectorySamples: (tr: any) => [
    { t: tr.startTick, x: tr.startPos.x, y: tr.startPos.y },
    { t: tr.arriveTick, x: tr.interceptPos.x, y: tr.interceptPos.y },
  ],
}));
jest.mock('../../physics/orbitalMechanics', () => ({
  bodyPosition: (b: any) => ({ x: b.orbitRadius, y: 0 }),
}));

import { solveIntercepts } from '../interceptOptions';

const bodies: any[] = [
  { id: 'saturn', name: 'Saturn', orbitRadius: 1000 },
  { id: 'uranus', name: 'Uranus', orbitRadius: 0 },
  { id: 'far', name: 'Far', orbitRadius: 9000 },
];

const flight = (id: string, dest: string, start: number, arrive: number, from = 0): any => ({
  id, name: id, ownedBy: 'f1', class: 'corvette', hp: 10,
  transit: {
    currentTransfer: {
      targetBodyId: dest, startTick: start, arriveTick: arrive,
      startPos: { x: from, y: 0 }, interceptPos: { x: bodies.find(b => b.id === dest)!.orbitRadius, y: 0 },
    },
  },
});

const me: any = { id: 'me', name: 'me', ownedBy: 'player', class: 'corvette', orbit: { parentBodyId: 'saturn' } };

// My leg to anywhere: from Saturn, 1 tick per 100 units; none to Far.
const planLegFor = (_: string, dest: string): any => {
  if (dest === 'far') return null;
  const d = Math.abs(bodies.find(b => b.id === dest)!.orbitRadius - 1000);
  return {
    targetBodyId: dest, startTick: 10, arriveTick: 10 + d / 100, acceleration: 0.001,
    startPos: { x: 1000, y: 0 }, startVel: { x: 0, y: 0 }, interceptPos: { x: 0, y: 0 },
  };
};

const gs: any = {
  currentTick: 10, bodies, fleets: [], alliedFactionIds: [], warPairs: [],
  ships: [
    me,
    flight('raid', 'saturn', 0, 30),     // coming to me: I'm already there
    flight('runner', 'uranus', 5, 12, 900), // lands at Uranus before my 10t
    flight('lander', 'saturn', 0, 10),   // lands this tick
    flight('lost', 'far', 0, 40),        // no course from here
  ],
};

describe('solveIntercepts keeps the ones you cannot catch, with the reason', () => {
  const out = solveIntercepts(me, gs, planLegFor);
  const by = (k: string) => out.find(o => o.lead.id === k)!;

  it('returns every flight it can see', () => {
    expect(out.map(o => o.lead.id).sort()).toEqual(['lander', 'lost', 'raid', 'runner']);
  });

  it('a raid on your own world is catchable and says it is coming to you', () => {
    expect(by('raid').ok).toBe(true);
    expect(by('raid').why).toBeNull();
    expect(by('raid').toYou).toBe(true);
  });

  it('too far to reach in time: late, with both arrival times', () => {
    expect(by('runner')).toMatchObject({ ok: false, why: 'late', toYou: false });
    expect(by('runner').theirEta).toBe(12);
    expect(by('runner').myEta).toBe(10);
  });

  it('no course at all: noCourse, not silence', () => {
    expect(by('lost')).toMatchObject({ ok: false, why: 'noCourse', myPlan: null });
  });

  it('landing this tick: landing', () => {
    expect(by('lander')).toMatchObject({ ok: false, why: 'landing' });
  });

  it('catchable first, then near misses, then landing, then no course', () => {
    expect(out.map(o => o.lead.id)).toEqual(['raid', 'runner', 'lander', 'lost']);
  });
});
