import {
  dayNightOf, scheduleOf, ticksOfDay, inDay, untilLabel, DayNight,
} from '../tickSchedule';

// The host panel's Day & night model (TopBar HostTickSpeed). The server
// decides when ticks fall (worker/tickSchedule.js, sim/tickSchedule.mjs);
// these keep the panel's picture of a day honest to the same rule.
const DN: DayNight = { tz: 'America/New_York', dayAt: 480, nightAt: 0, dayMs: 1_800_000, nightMs: 3_600_000 };

describe('Day & night', () => {
  it('Lorne\'s example: 40 ticks a day, 8 of them at night', () => {
    const ticks = ticksOfDay(DN);
    expect(ticks.length).toBe(40);
    expect(ticks.filter(k => !k.day).length).toBe(8);
  });

  it('a tick never runs past a start time: 07:00 night, then 08:00 sharp', () => {
    const odd: DayNight = { ...DN, dayAt: 450, nightMs: 3_600_000 }; // day from 07:30
    const mins = ticksOfDay(odd).map(k => k.min);
    expect(mins).toContain(420);   // 07:00
    expect(mins).toContain(450);   // 07:30, cut short
    expect(mins).toContain(480);   // then every 30
  });

  it('a day that wraps midnight is read the right way round', () => {
    const late: DayNight = { ...DN, dayAt: 600, nightAt: 120 }; // day 10:00 to 02:00
    expect(inDay(late, 60)).toBe(true);
    expect(inDay(late, 300)).toBe(false);
    expect(inDay(late, 700)).toBe(true);
  });

  it('saves as two periods and reads back the same', () => {
    const s = scheduleOf(DN);
    expect(s.periods.map(p => p.at)).toEqual(['00:00', '08:00']);
    expect(dayNightOf(s)).toEqual(DN);
  });

  it('the faster period is the day, whichever order it comes in', () => {
    const dn = dayNightOf({ tz: 'UTC', periods: [{ at: '06:00', interval_ms: 300_000 }, { at: '22:00', interval_ms: 7_200_000 }] });
    expect(dn).toMatchObject({ dayAt: 360, dayMs: 300_000, nightAt: 1320, nightMs: 7_200_000 });
  });

  it('a schedule of more than two periods is not Day & night', () => {
    expect(dayNightOf({ tz: 'UTC', periods: [
      { at: '00:00', interval_ms: 3_600_000 }, { at: '08:00', interval_ms: 1_800_000 }, { at: '18:00', interval_ms: 300_000 },
    ] })).toBeNull();
  });

  it('counts down across midnight', () => {
    expect(untilLabel(22 * 60 + 18, 0)).toBe('1h 42m');
    expect(untilLabel(470, 480)).toBe('10m');
  });
});
