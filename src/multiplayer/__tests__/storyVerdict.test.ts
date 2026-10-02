import { findSetbacks, tickAt, verdictFor, span, StoryEvent, StoryPoint } from '../storyVerdict';

/** A trajectory from a settlements-by-tick and ships-by-tick function. */
function traj(ticks: number, colonies: (t: number) => number, ships: (t: number) => number = () => 3): StoryPoint[] {
  return Array.from({ length: ticks + 1 }, (_, t) => [t, colonies(t), ships(t), 100, 50, t] as StoryPoint);
}
const F = 'g:f0';
const ev = (t: number, kind: string, f: string | null = F, o: string | null = null, d = {}): StoryEvent => ({ t, kind, f, o, d });

describe('verdictFor', () => {
  it('reads an eliminated empire as out, with the cause', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 90 ? 1 : 0)),
      events: [ev(90, 'faction_eliminated', F, null, { cause: 'no_settlements' })],
      arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).toBe('out');
    expect(v.reason).toContain('T90');
    expect(v.reason).toContain('losing every colony');
  });

  it('a revival after elimination is not out', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 40 ? 1 : t < 60 ? 0 : 2)),
      events: [ev(40, 'faction_eliminated'), ev(60, 'faction_revived')],
      arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).not.toBe('out');
  });

  it('is struggling while still below its peak after losing a colony', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 50 ? 3 : 1)),
      events: [ev(50, 'settlement_destroyed', F, null, { name: 'Kepler Rest' })],
      arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).toBe('struggling');
    expect(v.reason).toContain('Down to 1 colony from a peak of 3');
    expect(v.reason).toContain('Kepler Rest');
  });

  it('is struggling while in arrears right now, and says since when', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, () => 2),
      events: [], arrearsTicks: [20, 21, 95, 96, 97, 98, 99, 100], currentTick: 100,
    });
    expect(v.key).toBe('struggling');
    expect(v.reason).toContain('since T95');
  });

  it('recovered: lost a colony, then got back to where it was', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 45 ? 2 : t < 70 ? 1 : 3)),
      events: [ev(45, 'settlement_destroyed', F, null, { name: 'Kepler Rest' })],
      arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).toBe('recovered');
    expect(v.reason).toMatch(/^Lost Kepler Rest at T45; back to 3 colonies/);
  });

  it('recovered from arrears that have ended', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, () => 2),
      events: [], arrearsTicks: [50, 51, 52], currentTick: 100,
    });
    expect(v.key).toBe('recovered');
    expect(v.reason).toContain('arrears at T50');
  });

  it('a fleet wiped and not rebuilt is not a recovery', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, () => 2, t => (t < 60 ? 10 : 2)),
      events: [], arrearsTicks: [], currentTick: 100,
    });
    expect(v.setbacks.some(s => s.what === 'fleet cut to 2 from 10')).toBe(true);
    expect(v.key).not.toBe('recovered');
  });

  it('growing: judged on the recent stretch, not the opening', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 80 ? 1 : 2)),
      events: [], arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).toBe('growing');
    expect(v.reason).toContain('colonies 1 → 2');
  });

  it('stalled: grew early, flat since', () => {
    const v = verdictFor({
      factionId: F, status: 'active', series: traj(100, t => (t < 20 ? 1 : 3)),
      events: [], arrearsTicks: [], currentTick: 100,
    });
    expect(v.key).toBe('stalled');
    expect(v.reason).toContain('No new colonies or ships since T75');
  });

  it('too little history is "just started", not a judgement', () => {
    const v = verdictFor({ factionId: F, status: 'active', series: traj(3, () => 1), events: [], arrearsTicks: [], currentTick: 3 });
    expect(v.key).toBe('new');
  });

  it('a colony seized FROM this empire is its setback, not the taker\'s', () => {
    const series = traj(50, () => 2);
    const seized = [ev(30, 'settlement_seized', 'g:f1', F, { name: 'Earth' })];
    expect(findSetbacks(F, series, seized, []).map(s => s.what)).toContain('had Earth seized');
    expect(findSetbacks('g:f1', series, seized, [])).toHaveLength(0);
  });

  it('one arrears run is one setback, however long', () => {
    const s = findSetbacks(F, traj(50, () => 1), [], [10, 11, 12, 13, 30, 31]);
    expect(s.filter(x => x.what === 'fell into arrears').map(x => x.t)).toEqual([10, 30]);
  });

  it('a drop the events already explain is not counted twice', () => {
    const s = findSetbacks(F, traj(50, t => (t < 20 ? 2 : 1)), [ev(20, 'settlement_destroyed', F, null, { name: 'X' })], []);
    expect(s).toHaveLength(1);
  });
});

describe('tickAt / span', () => {
  it('interpolates wall clock onto ticks', () => {
    const ticks: Array<[number, number]> = [[0, 1000], [10, 2000], [20, 4000]];
    expect(tickAt(ticks, 500)).toBe(0);
    expect(tickAt(ticks, 1500)).toBe(5);
    expect(tickAt(ticks, 3000)).toBe(15);
    expect(tickAt(ticks, 9999)).toBe(20);
    expect(tickAt([], 1)).toBeNull();
  });
  it('formats durations people can read', () => {
    expect(span(30_000)).toBe('under a minute');
    expect(span(12 * 60_000)).toBe('12m');
    expect(span(200 * 60_000)).toBe('3h 20m');
    expect(span(52 * 3_600_000)).toBe('2d 4h');
    expect(span(null)).toBe('—');
  });
});
