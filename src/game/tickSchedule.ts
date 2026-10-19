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

/** The starting point a host edits: day 30m from 08:00, night 1h from
 *  00:00, in their own zone. Lorne's example, 2026-10-18. */
export function defaultSchedule(): TickSchedule {
  return {
    tz: localTimeZone(),
    periods: [
      { at: '00:00', interval_ms: 3_600_000 },
      { at: '08:00', interval_ms: 1_800_000 },
    ],
  };
}

/** "1h from 00:00 · 30m from 08:00", in start order, in the player's language. */
export function describeSchedule(s: TickSchedule): string {
  return [...s.periods]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(p => t('topbar.sched.period', { speed: speedLabel(p.interval_ms), at: p.at }))
    .join(' · ');
}
