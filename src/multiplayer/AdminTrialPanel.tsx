// ============================================================
// AdminTrialPanel — Play for Free, followed from click to comeback (admin).
//
// A trial is a solo game on a shadow account (worker/trial.js). It is
// followed by its GAME, because saving moves the game into a real
// account halfway through. Every number here is "trial games of the
// last 30 days that reached this point":
//
//   funnel   started, saw the tour, started the clock, played 5+ minutes,
//            saw the save prompt, tried to save, saved, came back on a
//            later day
//   why      what opened the save sheet, and which opening the save
//            followed; how they saved; where the trials came from
//   tour     the furthest tour step each trial reached
//   recent   the latest trials, one row each
//
// Data: trial in the admin overview (worker/adminDashboard.js); the
// moments come from src/multiplayer/trial/trialTelemetry.ts.
// ============================================================

import React, { useMemo } from 'react';
import { ago, playTime } from './adminFormat';
import { sourceName } from './AdminTrafficTrends';
import { TRIAL_TUTORIAL_STEPS } from '../game/tutorialSteps';
import './AdminTrialPanel.css';

export type TrialGameRow = {
  id: string; created_at: number; tick: number; status: string;
  paused: number; auto_paused: number; host_seen_ms: number | null;
  shadow: number | null; saved_ms: number | null; source: string;
  saved_how: string | null; saved_into: string | null;
  minutes: number; came_back: number;
};
export type TrialData = {
  games: TrialGameRow[];
  steps: { game_id: string; kind: string; at: number }[];
  refused: number;
};

const nf = new Intl.NumberFormat();
const n = (v: number) => nf.format(v);
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

const REASONS = [
  { key: 'time', label: 'After 10 minutes of play' },
  { key: 'leaving', label: 'Leaving the page' },
  { key: 'menu', label: 'The Save menu item' },
  { key: 'account', label: 'Something needed an account' },
] as const;
const HOW: Record<string, string> = {
  'google|new': 'Google, new account', 'google|existing': 'Google, existing account',
  'signup|new': 'Email, new account', 'login|existing': 'Signed in to an existing account',
};

type Trial = TrialGameRow & {
  m: Map<string, number>; // moment → first time
  furthest: number;       // last tour step shown, 1-based; 0 = none
  saved: boolean;
  savedAfter: string | null; // the sheet opening the save followed
};

function build(data: TrialData): Trial[] {
  const byGame = new Map<string, Map<string, number>>();
  for (const s of data.steps) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, new Map());
    byGame.get(s.game_id)!.set(s.kind, s.at);
  }
  return data.games.map(g => {
    const m = byGame.get(g.id) ?? new Map<string, number>();
    let furthest = 0;
    m.forEach((_, k) => {
      const hit = /^trial-tour-step-(\d+)$/.exec(k);
      if (hit) furthest = Math.max(furthest, Number(hit[1]));
    });
    const saved = g.shadow === 2 || g.saved_ms != null;
    let savedAfter: string | null = null;
    if (saved && g.saved_ms != null) {
      let best = -1;
      for (const r of REASONS) {
        const at = m.get(`trial-save-open-${r.key}`);
        if (at != null && at <= g.saved_ms + 60_000 && at > best) { best = at; savedAfter = r.key; }
      }
    }
    return { ...g, m, furthest, saved, savedAfter };
  });
}

const has = (t: Trial, prefix: string) => [...t.m.keys()].some(k => k.startsWith(prefix));

export function TrialPanel({ data, now }: { data: TrialData; now: number }) {
  const trials = useMemo(() => build(data), [data]);
  const total = trials.length;

  const stages = [
    { label: 'Started a trial game', count: total, help: 'Pressed Try out a Solo Game and got a game.' },
    { label: 'Saw the tour', count: trials.filter(t => t.furthest > 0).length, help: 'The trial tour showed its first step.' },
    { label: 'Started the clock', count: trials.filter(t => t.m.has('trial-clock') || t.tick > 0).length, help: 'The game is born paused; the tour ends by starting it.' },
    { label: 'Played 5+ minutes', count: trials.filter(t => t.minutes >= 5).length, help: 'Five or more minutes with the game open and in view.' },
    { label: 'Saw the save prompt', count: trials.filter(t => has(t, 'trial-save-open-')).length, help: 'The save sheet opened, for any reason.' },
    { label: 'Tried to save', count: trials.filter(t => has(t, 'trial-save-try-')).length, help: 'Pressed Google, Create account or Sign in on the save sheet.' },
    { label: 'Saved', count: trials.filter(t => t.saved).length, help: 'The trial moved into a real account.' },
    { label: 'Came back another day', count: trials.filter(t => t.came_back).length, help: 'The saved account played on a later UTC day.' },
  ];
  const saved = stages[6].count;

  const reasons = REASONS.map(r => ({
    ...r,
    opened: trials.filter(t => t.m.has(`trial-save-open-${r.key}`)).length,
    led: trials.filter(t => t.savedAfter === r.key).length,
  }));
  const hows = new Map<string, number>();
  for (const t of trials) if (t.saved) {
    const k = t.saved_how ? `${t.saved_how}|${t.saved_into ?? ''}` : 'unknown';
    hows.set(k, (hows.get(k) ?? 0) + 1);
  }
  const sources = new Map<string, { started: number; saved: number }>();
  for (const t of trials) {
    const s = sources.get(t.source) ?? { started: 0, saved: 0 };
    s.started += 1; if (t.saved) s.saved += 1;
    sources.set(t.source, s);
  }
  const sourceRows = [...sources.entries()].sort((a, b) => b[1].started - a[1].started);

  const steps = TRIAL_TUTORIAL_STEPS.map((s, i) => ({
    title: s.title, reached: trials.filter(t => t.furthest >= i + 1).length,
  }));
  const tourDone = trials.filter(t => t.m.has('trial-tour-done')).length;
  const tourSkip = trials.filter(t => t.m.has('trial-tour-skip')).length;
  const errors = trials.filter(t => t.m.has('trial-save-error')).length;

  const state = (t: Trial) => {
    if (t.saved) return 'saved';
    if (t.status !== 'active') return t.status;
    if (t.host_seen_ms && now - t.host_seen_ms < 15 * 60_000) return 'playing now';
    if (t.auto_paused) return 'idle, paused';
    return t.paused ? 'paused' : 'idle';
  };
  const tour = (t: Trial) =>
    t.m.has('trial-tour-done') ? 'finished'
      : t.m.has('trial-tour-skip') ? `skipped at ${t.furthest}`
        : t.furthest ? `at step ${t.furthest}` : '–';

  return (
    <section className="ao-panel tp">
      <div className="ao-phead">
        <div>
          <h3 className="ao-phead__title">Trial Game</h3>
          <p className="ao-phead__hint">
            Trial games of the last 30 days, started from the sign-in page with no account. Each is followed by its game,
            because saving moves it into a real account. Tour, clock and save-prompt moments are recorded from Oct 25, so earlier trials show none.
          </p>
        </div>
      </div>

      {total === 0 ? <div className="ao-none">No trials yet.</div> : (
        <>
          <div className="ao-kpis atp-kpis">
            <div className="ao-kpi"><span className="ao-kpi__label">Trials started</span>
              <span className="ao-kpi__value">{n(total)}</span>
              <span className="ao-kpi__foot">{n(trials.filter(t => now - t.created_at < 86_400_000).length)} in the last 24 hours</span></div>
            <div className="ao-kpi"><span className="ao-kpi__label">Saved</span>
              <span className="ao-kpi__value">{n(saved)}</span>
              <span className="ao-kpi__foot">{pct(saved, total)} of trials became accounts</span></div>
            <div className="ao-kpi"><span className="ao-kpi__label">Played 5+ minutes</span>
              <span className="ao-kpi__value">{n(stages[3].count)}</span>
              <span className="ao-kpi__foot">{pct(stages[3].count, total)} of trials · median {playTime(median(trials.map(t => t.minutes)))}</span></div>
            <div className="ao-kpi"><span className="ao-kpi__label">Turned away</span>
              <span className="ao-kpi__value">{n(data.refused)}</span>
              <span className="ao-kpi__foot">refused by the 30-an-hour limit per address</span></div>
          </div>

          <h4 className="atp-sub">How far trials get</h4>
          <div className="atp-funnel" role="table" aria-label="Trial game funnel">
            {stages.map((s, i) => (
              <div className="atp-row" role="row" key={s.label} title={s.help}>
                <span className="atp-row__label" role="rowheader">{s.label}</span>
                <span className="atp-row__bar" role="cell"><i style={{ width: `${total ? (s.count / total) * 100 : 0}%` }} /></span>
                <span className="atp-row__n" role="cell">{n(s.count)}</span>
                <span className="atp-row__pct" role="cell">{pct(s.count, total)}</span>
                <span className="atp-row__step" role="cell">{i === 0 ? '' : `${pct(s.count, stages[i - 1].count)} of the step before`}</span>
              </div>
            ))}
          </div>

          <div className="atp-grid">
            <div>
              <h4 className="atp-sub">What opened the save sheet</h4>
              <table className="ao-table">
                <thead><tr><th>Opened by</th><th className="num">Trials</th><th className="num" title="Saved trials whose save followed this opening">Saved after it</th></tr></thead>
                <tbody>
                  {reasons.map(r => (
                    <tr key={r.key}><td>{r.label}</td><td className="num">{n(r.opened)}</td><td className="num">{n(r.led)}</td></tr>
                  ))}
                </tbody>
              </table>
              {errors > 0 && <p className="ao-note atp-note">{n(errors)} trial{errors === 1 ? '' : 's'} had a save refused (wrong password, email taken).</p>}
            </div>
            <div>
              <h4 className="atp-sub">How they saved</h4>
              {saved === 0 ? <div className="ao-none">No saves yet.</div> : (
                <table className="ao-table">
                  <thead><tr><th>Saved with</th><th className="num">Trials</th></tr></thead>
                  <tbody>
                    {[...hows.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                      <tr key={k}><td>{HOW[k] ?? (k === 'unknown' ? 'Before tracking' : k.replace('|', ', '))}</td><td className="num">{n(v)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h4 className="atp-sub">Where trials came from</h4>
              <table className="ao-table">
                <thead><tr><th>Source</th><th className="num">Started</th><th className="num">Saved</th></tr></thead>
                <tbody>
                  {sourceRows.map(([s, v]) => (
                    <tr key={s || 'none'}><td title={s}>{s ? sourceName(s) : <span className="ao-dim">not recorded</span>}</td>
                      <td className="num">{n(v.started)}</td><td className="num">{n(v.saved)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <h4 className="atp-sub">The tour: furthest step reached</h4>
          <div className="atp-tour" aria-label="Trials reaching each tour step">
            {steps.map((s, i) => (
              <div className="atp-tour__col" key={i} title={`Step ${i + 1}: ${s.title} · ${s.reached} trial${s.reached === 1 ? '' : 's'}`}>
                <span className="atp-tour__n">{n(s.reached)}</span>
                <span className="atp-tour__bar"><i style={{ height: `${total ? (s.reached / total) * 100 : 0}%` }} /></span>
                <span className="atp-tour__label">{i + 1}</span>
              </div>
            ))}
          </div>
          <p className="ao-note atp-note">
            {n(tourDone)} finished the tour and {n(tourSkip)} skipped it. Hover a bar for its step. The last step starts the clock.
          </p>

          <h4 className="atp-sub">Latest trials</h4>
          <div className="ao-scroll">
            <table className="ao-table">
              <thead><tr><th>Started</th><th>Source</th><th>Tour</th><th className="num">Tick</th><th className="num">Played</th><th>Save prompt</th><th>Saved</th><th>Now</th></tr></thead>
              <tbody>
                {trials.slice(0, 25).map(t => (
                  <tr key={t.id}>
                    <td>{ago(now, t.created_at)}</td>
                    <td>{t.source ? sourceName(t.source) : <span className="ao-dim">—</span>}</td>
                    <td>{tour(t)}</td>
                    <td className="num">{n(t.tick)}</td>
                    <td className="num">{t.minutes ? playTime(t.minutes) : <span className="ao-dim">0</span>}</td>
                    <td>{REASONS.filter(r => t.m.has(`trial-save-open-${r.key}`)).map(r => r.key).join(', ') || <span className="ao-dim">—</span>}</td>
                    <td>{t.saved ? (HOW[`${t.saved_how}|${t.saved_into}`] ?? 'yes') : <span className="ao-dim">—</span>}</td>
                    <td className={t.saved ? '' : 'ao-dim'}>{state(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
