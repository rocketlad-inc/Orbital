// ============================================================
// TICK SPEED BY TIME OF DAY — the client's side of
// worker/tickSchedule.js (migration 0171): the shape, the speeds a host
// can pick, and the one-line summary every player sees.
//
// The server decides when ticks fall; this only describes the schedule.
// ============================================================

import { t } from '../i18n/core';

export interface TickPeriod {
  /** Local start time, "HH:MM", in the schedule's zone. */
  at: string;
  interval_ms: number;
}

export interface TickSchedule {
  /** IANA zone, e.g. "America/Sao_Paulo". */
  tz: string;
  /** Sorted by start time; each runs until the next one's, wrapping. */
  periods: TickPeriod[];
}

/** worker/tickSchedule.js MAX_PERIODS. */
export const MAX_TICK_PERIODS = 4;

/** The speeds the host's pills offer. Mirrors worker/lobby.js
 *  ALLOWED_TICK_INTERVALS (the server refuses anything else). */
export const TICK_SPEED_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '30s', value: 30_000 },
  { label: '1m', value: 60_000 },
  { label: '5m', value: 300_000 },
  { label: '30m', value: 1_800_000 },
  { label: '1h', value: 3_600_000 },
  { label: '2h', value: 7_200_000 },
  { label: '6h', value: 21_600_000 },
  { label: '12h', value: 43_200_000 },
  { label: '24h', value: 86_400_000 },
];

export function speedLabel(ms: number): string {
  return TICK_SPEED_OPTIONS.find(o => o.value === ms)?.label
    ?? (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`);
}

/** The viewer's own zone, the default for a new schedule. */
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** A short zone name for display: "Sao Paulo" from "America/Sao_Paulo". */
export function zoneLabel(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

/** "1h from 00:00 · 30m from 08:00", in start order, in the player's language. */
export function describeSchedule(s: TickSchedule): string {
  return [...s.periods]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(p => t('topbar.sched.period', { speed: speedLabel(p.interval_ms), at: p.at }))
    .join(' · ');
}

// ------------------------------------------------------------
// DAY & NIGHT — the host panel's model (design approved 2026-10-19,
// claude.ai/artifact/5RoKcC2ouQPJZhTVQraoke): exactly two periods, the
// faster one called Day. The server still takes up to four.
// ------------------------------------------------------------

export interface DayNight {
  tz: string;
  /** Minutes after local midnight each one starts. */
  dayAt: number;
  nightAt: number;
  dayMs: number;
  nightMs: number;
}

export const DEFAULT_DAY_NIGHT = (): DayNight => ({
  tz: localTimeZone(), dayAt: 8 * 60, nightAt: 0, dayMs: 1_800_000, nightMs: 3_600_000,
});

const toMin = (at: string): number => {
  const m = /^(\d\d):(\d\d)$/.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const toAt = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** A stored schedule as Day & night, or null when it is not two periods. */
export function dayNightOf(s: TickSchedule | null | undefined): DayNight | null {
  if (!s || s.periods.length !== 2) return null;
  const [a, b] = s.periods;
  // Day is the faster one; on a tie, the one starting later in the
  // morning (a 06:00 start reads as day beside 22:00).
  const aDay = a.interval_ms !== b.interval_ms
    ? a.interval_ms < b.interval_ms
    : Math.abs(toMin(a.at) - 480) <= Math.abs(toMin(b.at) - 480);
  const day = aDay ? a : b;
  const night = aDay ? b : a;
  return { tz: s.tz, dayAt: toMin(day.at), nightAt: toMin(night.at), dayMs: day.interval_ms, nightMs: night.interval_ms };
}

export function scheduleOf(d: DayNight): TickSchedule {
  return {
    tz: d.tz,
    periods: [
      { at: toAt(d.dayAt), interval_ms: d.dayMs },
      { at: toAt(d.nightAt), interval_ms: d.nightMs },
    ].sort((x, y) => x.at.localeCompare(y.at)),
  };
}

/** Is local minute `m` in the day period? */
export function inDay(d: DayNight, m: number): boolean {
  return d.dayAt < d.nightAt ? (m >= d.dayAt && m < d.nightAt) : (m >= d.dayAt || m < d.nightAt);
}

/**
 * One local day of ticks, on the server's rule (worker/tickSchedule.js
 * nextTickAt): a step at the speed in force, cut short at the next start
 * time. Minutes after midnight, so a daylight-saving day is a sketch.
 */
export function ticksOfDay(d: DayNight): Array<{ min: number; day: boolean }> {
  const out: Array<{ min: number; day: boolean }> = [];
  let t = 0;
  for (let guard = 0; t < 1440 && guard < 5000; guard++) {
    const day = inDay(d, t);
    out.push({ min: t, day });
    const step = (day ? d.dayMs : d.nightMs) / 60_000;
    let edge = Infinity;
    for (const b of [d.dayAt, d.nightAt]) {
      let gap = (b - t + 1440) % 1440;
      if (gap === 0) gap = 1440;
      edge = Math.min(edge, t + gap);
    }
    t = Math.min(t + step, edge);
  }
  return out;
}

/** Minutes after midnight in zone `tz` at epoch `ms`. */
export function localMinutes(tz: string, ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(ms));
    const v = (k: string) => Number(parts.find(p => p.type === k)?.value ?? 0);
    return (v('hour') % 24) * 60 + v('minute');
  } catch {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  }
}

/** A local time in the viewer's own style ("8:00 AM", "08:00"). */
export function clockLabel(min: number): string {
  const d = new Date(2026, 0, 1, Math.floor(min / 60), min % 60);
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return toAt(min);
  }
}

/** "3h 20m" until local minute `to` from `from`, wrapping midnight. */
export function untilLabel(from: number, to: number): string {
  let gap = (to - from + 1440) % 1440;
  if (gap === 0) gap = 1440;
  const h = Math.floor(gap / 60);
  const m = gap % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The zones the Clock menu offers: the common ones for this game's
 *  players, plus whatever is set and the viewer's own. */
export const COMMON_ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];
