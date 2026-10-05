// ============================================================
// AdminOverview — the live-ops landing page, built for thousands of
// players and games rather than the dozens it started with.
//
// What changed from the page it replaces, and why:
//   - Every list is PAGED AND SEARCHED ON THE SERVER with an honest
//     total. The old page shipped the first 50 players and 100 games and
//     said nothing about the rest.
//   - Headline numbers come first (KPI tiles with week-over-week
//     change), then trends, then the lists. You should know whether the
//     game is growing before you scroll past a single row.
//   - Retention is a weekly COHORT table. It used to be one row per new
//     player, which is unreadable at 50 signups and impossible at 5,000.
//   - Tabs instead of one 5,000px scroll: each list gets the whole
//     width, and a busy section no longer pushes the others off-screen.
//   - The server reads rollup tables (worker/adminDashboard.js) instead
//     of recounting history, so refreshing is cheap — and it only
//     refreshes while the tab is actually visible.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';
import { ago, labelForKind, playTime } from './adminFormat';
import { FrictionRows } from './GameStory';
import { span } from './storyVerdict';
import './AdminOverview.css';

// ---------- payload types (worker/adminDashboard.js) ----------

type Kpis = {
  online_now: number; games_online_now: number;
  players_today: number; players_week: number; players_prev_week: number; players_month: number;
  minutes_today: number; minutes_week: number; minutes_prev_week: number;
  signups_week: number; signups_prev_week: number; signups_today: number;
  games_active: number; games_quiet: number; games_completed: number;
  commissions_total: number; commissions_week: number;
};
type DailyRow = { day_ms: number; players: number; minutes: number; actions: number; signups: number };
type UsageRow = {
  kind: string; n30: number; prev30: number; total: number;
  /** Refused, and tries that carry an outcome at all (0152). Rates divide by judged. */
  rejected30?: number; judged30?: number;
};
type FrictionRow = { kind: string; code: string; reason: string; n: number };
type CrashRow = { scope: string; message: string; n: number; users: number; last_ms: number; git_sha: string | null };
type Journey = {
  signed_up: number; eligible_1d: number; eligible_7d: number;
  steps: Array<{ id: string; label: string; n: number; median_ms: number | null }>;
};
type Cohort = {
  week_ms: number; size: number; seated: number; played: number;
  r1: number; r7: number; r14: number; r28: number;
  e1: number; e7: number; e14: number; e28: number;
};
type SourceRow = {
  source: string; signups: number; signups_30d: number; joined: number;
  came_back: number; latest_ms: number | null; referrers: string | null;
};
type Overview = {
  now: number;
  rollup: { through_ms: number; behind_ms: number | null };
  kpis: Kpis;
  daily: DailyRow[];
  heat_grid: number[][];
  usage: UsageRow[];
  cohorts: Cohort[];
  sources: SourceRow[];
  journey?: Journey;
  friction?: FrictionRow[];
  crashes?: CrashRow[];
};
type GameRow = {
  id: string; name: string; status: string; current_tick: number;
  tick_interval_ms: number; next_tick_at: number | null; victory_type: string | null;
  created_at: number; humans: number; factions: number;
  last_action_ms: number | null; last_heartbeat_ms: number | null;
  last_combat_ms: number | null; last_proposal_tick: number | null;
  actions_14d: number; minutes_14d: number; players_14d: number;
};
type PlayerRow = {
  id: string; display_name: string; email: string; created_at: number;
  last_played_ms: number | null; minutes_all: number | null;
  days_14: number[]; minutes_14d: number; minutes_7d: number; minutes_prior7: number;
  active_days_14d: number; actions_14d: number; rejected_14d?: number; judged_14d?: number;
  games: Array<{ id: string; name: string; faction: string; color: string }>;
};

const DAY = 86_400_000;
const PAGE = 25;
/** Auto-refresh cadence for the headline numbers. The rollups behind
 *  them move once a minute, so polling faster would only re-read the
 *  same answer. */
const REFRESH_MS = 60_000;

type Tab = 'pulse' | 'games' | 'players' | 'growth' | 'friction' | 'features' | 'commission';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pulse', label: 'Pulse' },
  { id: 'games', label: 'Games' },
  { id: 'players', label: 'Players' },
  { id: 'growth', label: 'Growth' },
  { id: 'friction', label: 'Friction' },
  { id: 'features', label: 'Features' },
  { id: 'commission', label: 'Commission' },
];
const TAB_KEY = 'orbital.admin.tab';

function readTab(): Tab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v && TABS.some(t => t.id === v)) return v as Tab;
  } catch { /* storage blocked: fall through to the default */ }
  return 'pulse';
}

// ---------- small formatting ----------

const nf = new Intl.NumberFormat();
const n = (v: number | null | undefined) => nf.format(v ?? 0);
const hours = (min: number) => (min >= 600 ? `${nf.format(Math.round(min / 60))}h` : playTime(min));
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ============================================================
// Shell
// ============================================================

export function AdminOverview({ onOpenGame }: { onOpenGame: (id: string) => void }) {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumped by the Refresh button so the paged lists re-read too. The
   *  lists do NOT auto-refresh: rows re-sorting under the cursor while
   *  you read page 3 is worse than a list that is a minute old. */
  const [listKey, setListKey] = useState(0);
  const [, setClock] = useState(0);

  const setTab = (t: Tab) => {
    setTabState(t);
    try { sessionStorage.setItem(TAB_KEY, t); } catch { /* not essential */ }
  };

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch<Overview>('/api/admin/overview');
    setLoading(false);
    if (res.ok) { setData(res.data); setError(null); setLoadedAt(Date.now()); }
    else setError('Analytics unavailable for this account.');
  }, []);

  // Refresh only while someone is looking: a backgrounded admin tab used
  // to re-read the whole history every 30 seconds, all night.
  const loadedRef = useRef<number | null>(null);
  loadedRef.current = loadedAt;
  useEffect(() => {
    void load();
    const tick = setInterval(() => {
      setClock(c => c + 1); // keeps "updated 40s ago" honest
      if (document.visibilityState === 'visible'
        && (loadedRef.current == null || Date.now() - loadedRef.current >= REFRESH_MS)) void load();
    }, 15_000);
    const onVis = () => {
      if (document.visibilityState === 'visible'
        && (loadedRef.current == null || Date.now() - loadedRef.current >= REFRESH_MS)) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(tick); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  if (error) return <div className="aa-empty">{error}</div>;
  if (!data) return <div className="ao"><div className="ao-loading">Loading analytics…</div></div>;

  const k = data.kpis;
  const counts: Partial<Record<Tab, number>> = {
    games: k.games_active,
    commission: k.commissions_total,
  };

  return (
    <div className="ao">
      <header className="ao-head">
        <div className="ao-head__title">
          <h2>Live ops</h2>
          <Freshness data={data} loadedAt={loadedAt} />
        </div>
        <button
          className="ao-btn"
          disabled={loading}
          onClick={() => { void load(); setListKey(x => x + 1); }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <nav className="ao-tabs" role="tablist" aria-label="Dashboard sections">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`ao-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {counts[t.id] != null && <span className="ao-tab__n">{n(counts[t.id])}</span>}
          </button>
        ))}
      </nav>

      {tab === 'pulse' && <Pulse data={data} onGo={setTab} />}
      {tab === 'games' && <GamesPanel refreshKey={listKey} kpis={k} onOpen={onOpenGame} />}
      {tab === 'players' && <PlayersPanel refreshKey={listKey} onOpenGame={onOpenGame} />}
      {tab === 'growth' && <Growth data={data} />}
      {tab === 'friction' && <FrictionTab data={data} />}
      {tab === 'features' && <Features rows={data.usage} />}
      {tab === 'commission' && <Commission kpis={k} />}
    </div>
  );
}

/** Says how old the numbers are. When the rollup is catching up (first
 *  deploy, or after an outage) the totals are PARTIAL, and a dashboard
 *  that shows partial totals without saying so is lying. */
function Freshness({ data, loadedAt }: { data: Overview; loadedAt: number | null }) {
  const behind = data.rollup.behind_ms;
  const catching = behind == null || behind > 15 * 60_000;
  return (
    <p className="ao-fresh">
      {loadedAt && <>Updated {ago(Date.now(), loadedAt)}</>}
      {catching ? (
        <span className="ao-fresh__warn">
          {' · '}Still counting history — totals are partial
          {data.rollup.through_ms ? ` (through ${dayLabel(data.rollup.through_ms)})` : ''}
        </span>
      ) : (
        <> · figures trail live play by about {Math.max(1, Math.round((behind ?? 0) / 60_000))} min</>
      )}
    </p>
  );
}

// ============================================================
// Pulse: KPIs + trend + when people play
// ============================================================

function Pulse({ data, onGo }: { data: Overview; onGo: (t: Tab) => void }) {
  const k = data.kpis;
  // Complete days only for the tile sparklines — today's partial day
  // would always read as a cliff.
  const done = data.daily.slice(0, -1).slice(-14);
  return (
    <div className="ao-stack">
      <div className="ao-kpis">
        <Kpi
          label="Online now"
          value={n(k.online_now)}
          live={k.online_now > 0}
          foot={k.online_now ? `in ${n(k.games_online_now)} game${k.games_online_now === 1 ? '' : 's'}` : 'nobody right now'}
        />
        <Kpi
          label="Played today"
          value={n(k.players_today)}
          foot={`${hours(k.minutes_today)} so far · ${n(k.signups_today)} new`}
        />
        <Kpi
          label="Players · last 7 days"
          value={n(k.players_week)}
          delta={[k.players_week, k.players_prev_week]}
          spark={done.map(d => d.players)}
        />
        <Kpi
          label="Time played · last 7 days"
          value={hours(k.minutes_week)}
          delta={[k.minutes_week, k.minutes_prev_week]}
          spark={done.map(d => d.minutes)}
        />
        <Kpi
          label="New players · last 7 days"
          value={n(k.signups_week)}
          delta={[k.signups_week, k.signups_prev_week]}
          spark={done.map(d => d.signups)}
        />
        <RefusalKpi usage={data.usage} onGo={() => onGo('friction')} />
        <Kpi
          label="Games running"
          value={n(k.games_active)}
          foot={k.games_quiet
            ? <span className="ao-warn">{n(k.games_quiet)} quiet for 24h+</span>
            : `all active · ${n(k.games_completed)} finished`}
          onClick={() => onGo('games')}
        />
        <Kpi
          label="Commissions sold"
          value={n(k.commissions_total)}
          gold
          foot={k.commissions_week ? `+${n(k.commissions_week)} this week` : 'none this week'}
          onClick={() => onGo('commission')}
        />
      </div>

      <section className="ao-panel">
        <DailyChart days={data.daily} />
      </section>

      <section className="ao-panel">
        <PanelHead
          title="When people play"
          hint="Minutes played by hour, last 14 days, in your timezone. Brighter = busier: start new games just before the bright band."
        />
        <HeatGrid grid={data.heat_grid} />
      </section>
    </div>
  );
}

function PanelHead({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="ao-phead">
      <div>
        <h3 className="ao-phead__title">{title}</h3>
        {hint && <p className="ao-phead__hint">{hint}</p>}
      </div>
      {children && <div className="ao-phead__tools">{children}</div>}
    </div>
  );
}

function Delta({ cur, prev, unit = '%' }: { cur: number; prev: number; unit?: '%' }) {
  if (!prev && !cur) return <span className="ao-delta">no change</span>;
  if (!prev) return <span className="ao-delta ao-delta--up">new this week</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return <span className="ao-delta">flat vs prior 7 days</span>;
  return (
    <span className={`ao-delta ${p > 0 ? 'ao-delta--up' : 'ao-delta--down'}`}>
      {p > 0 ? '▲' : '▼'} {Math.abs(p)}{unit} vs prior 7 days
    </span>
  );
}

function Kpi({ label, value, foot, delta, spark, live, gold, onClick }: {
  label: string; value: string; foot?: React.ReactNode;
  delta?: [number, number]; spark?: number[]; live?: boolean; gold?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ao-kpi__label">
        {live && <span className="ao-live" aria-hidden />}
        {label}
      </span>
      <span className="ao-kpi__main">
        <span className={`ao-kpi__value${gold ? ' ao-kpi__value--gold' : ''}`}>{value}</span>
        {spark && spark.length > 1 && <MiniSpark values={spark} />}
      </span>
      <span className="ao-kpi__foot">
        {delta ? <Delta cur={delta[0]} prev={delta[1]} /> : foot}
      </span>
    </>
  );
  return onClick
    ? <button className="ao-kpi ao-kpi--link" onClick={onClick}>{body}</button>
    : <div className="ao-kpi">{body}</div>;
}

/** Area sparkline for a tile. Scale starts at zero so a flat week of
 *  3 players does not look like a crash when one leaves. */
function MiniSpark({ values }: { values: number[] }) {
  const w = 120, h = 28;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 2 - (v / max) * (h - 4)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className="ao-kpi__spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,${h} ${line} ${w},${h}`} className="ao-spark__area" />
      <polyline points={line} className="ao-spark__line" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.2} className="ao-spark__dot" />
    </svg>
  );
}

// ---------- 30-day chart ----------

type ChartMetric = 'players' | 'minutes' | 'signups' | 'actions';
const CHART_METRICS: Array<{ id: ChartMetric; label: string; title: string }> = [
  { id: 'players', label: 'Players', title: 'Players per day' },
  { id: 'minutes', label: 'Time played', title: 'Time played per day' },
  { id: 'signups', label: 'New players', title: 'New players per day' },
  { id: 'actions', label: 'Actions', title: 'Player actions per day' },
];

/** 1, 2, 5 × 10^n: a gridline top a person can read at a glance. */
function niceMax(v: number): number {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function DailyChart({ days }: { days: DailyRow[] }) {
  const [metric, setMetric] = useState<ChartMetric>('players');
  const [hover, setHover] = useState<number | null>(null);
  const val = (d: DailyRow) => d[metric];
  const top = niceMax(Math.max(...days.map(val), 0));
  const fmt = (v: number) => (metric === 'minutes' ? hours(v) : n(v));
  const def = CHART_METRICS.find(m => m.id === metric)!;
  const shown = hover ?? days.length - 1;
  const d = days[shown];
  const last = days.length - 1;

  return (
    <div>
      <PanelHead title={def.title} hint="Last 30 days, UTC. Today is still filling in.">
        <div className="ao-seg" role="group" aria-label="Chart metric">
          {CHART_METRICS.map(m => (
            <button
              key={m.id}
              className={`ao-seg__opt${metric === m.id ? ' is-active' : ''}`}
              aria-pressed={metric === m.id}
              onClick={() => setMetric(m.id)}
            >{m.label}</button>
          ))}
        </div>
      </PanelHead>

      {/* Readout above the plot rather than a floating tooltip: it never
          covers a bar, and it works the same on a phone. */}
      <div className="ao-readout" aria-live="polite">
        <span className="ao-readout__day">{shown === last ? 'Today so far' : dayLabel(d.day_ms)}</span>
        <span><b>{n(d.players)}</b> players</span>
        <span><b>{hours(d.minutes)}</b> played</span>
        <span><b>{n(d.signups)}</b> new</span>
        <span><b>{n(d.actions)}</b> actions</span>
      </div>

      <div className="ao-chart" onMouseLeave={() => setHover(null)}>
        <div className="ao-chart__grid" aria-hidden>
          {[1, 0.5, 0].map(f => (
            <div key={f} className="ao-chart__gridline" style={{ bottom: `${f * 100}%` }}>
              <span>{fmt(top * f)}</span>
            </div>
          ))}
        </div>
        <div className="ao-chart__bars">
          {days.map((row, i) => {
            const v = val(row);
            return (
              <button
                key={row.day_ms}
                className={`ao-bar${i === last ? ' ao-bar--today' : ''}${hover === i ? ' is-hover' : ''}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${dayLabel(row.day_ms)}: ${fmt(v)}`}
              >
                <span className="ao-bar__fill" style={{ height: v ? `max(2px, ${(v / top) * 100}%)` : 0 }} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="ao-chart__x" aria-hidden>
        {days.map((row, i) => (
          <span key={row.day_ms}>
            {i === last ? 'Today' : (last - i) % 7 === 0 ? dayLabel(row.day_ms) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- heat grid ----------

// 7x24 day-of-week x hour grid. Buckets are UTC; each cell moves to the
// viewer's local clock (the day wraps along with the hour).
function HeatGrid({ grid }: { grid: number[][] }) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const local = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const shifted = h + offset;
      const lh = ((Math.floor(shifted) % 24) + 24) % 24;
      const ld = (((d + Math.floor(shifted / 24)) % 7) + 7) % 7;
      local[ld][lh] += grid[d]?.[h] ?? 0;
    }
  }
  const max = Math.max(1, ...local.flat());
  const total = local.flat().reduce((x, y) => x + y, 0);
  if (total === 0) return <div className="ao-none">No play recorded in the last 14 days.</div>;
  // Monday first: the way people think about their week.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hourName = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  return (
    <div className="ao-scroll">
      <div className="ao-heat">
        {order.map(d => (
          <React.Fragment key={d}>
            <span className="ao-heat__day">{days[d]}</span>
            {local[d].map((v, h) => (
              <span
                key={h}
                className="ao-heat__cell"
                title={`${days[d]} ${hourName(h)} — ${hours(v)} played`}
                style={{ '--a': v ? 0.14 + 0.86 * (v / max) : 0 } as React.CSSProperties}
              />
            ))}
          </React.Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="ao-heat__hour">{h % 3 === 0 ? hourName(h) : ''}</span>
        ))}
      </div>
      <div className="ao-heat__legend">
        <span>quiet</span>
        <span className="ao-heat__ramp" aria-hidden />
        <span>busiest ({hours(max)} in one hour-slot)</span>
      </div>
    </div>
  );
}

// ============================================================
// Paged lists
// ============================================================

function usePaged<T>(path: string, params: Record<string, string>, refreshKey: number) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  // Starts true: otherwise the first paint, before the fetch begins,
  // flashes "no games here yet" at someone with 1,400 of them.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const query = new URLSearchParams(params).toString();
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    void apiFetch<Record<string, unknown>>(`${path}?${query}`).then(res => {
      // A slow response for an old search must not overwrite a newer one.
      if (mine !== seq.current) return;
      setLoading(false);
      if (!res.ok) { setError(res.error?.message ?? 'Could not load.'); return; }
      const body = res.data;
      const key = Object.keys(body).find(k2 => Array.isArray(body[k2])) ?? '';
      setRows((body[key] as T[]) ?? []);
      setTotal(Number(body.total ?? 0));
      setExtra(body);
      setError(null);
    });
  }, [path, query, refreshKey]);

  return { rows, total, loading, error, extra };
}

function Pager({ offset, total, count, onPage, loading }: {
  offset: number; total: number | null; count: number; onPage: (o: number) => void; loading: boolean;
}) {
  if (!total) return null;
  const end = offset + count;
  return (
    <div className="ao-pager">
      <span className="ao-pager__text">
        {total <= PAGE ? `${n(total)} total` : `${n(offset + 1)}–${n(end)} of ${n(total)}`}
      </span>
      {total > PAGE && (
        <span className="ao-pager__btns">
          <button className="ao-btn" disabled={loading || offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <button className="ao-btn" disabled={loading || end >= total} onClick={() => onPage(offset + PAGE)}>
            Next →
          </button>
        </span>
      )}
    </div>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="ao-search">
      <span aria-hidden className="ao-search__icon">⌕</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value && <button className="ao-search__clear" onClick={() => onChange('')} aria-label="Clear search">×</button>}
    </label>
  );
}

function Select<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: Array<[T, string]>; label: string;
}) {
  return (
    <label className="ao-select">
      <span>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

// ---------- games ----------

type GameSort = 'activity' | 'players' | 'newest' | 'longest';

function GamesPanel({ refreshKey, kpis, onOpen }: {
  refreshKey: number; kpis: Kpis; onOpen: (id: string) => void;
}) {
  const [status, setStatus] = useState<'active' | 'completed'>('active');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<GameSort>('activity');
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q, 250);
  useEffect(() => { setOffset(0); }, [status, dq, sort]);

  const { rows, total, loading, error, extra } = usePaged<GameRow>('/api/admin/games', {
    status, q: dq, sort, limit: String(PAGE), offset: String(offset),
  }, refreshKey);
  const sparks = (extra.sparks ?? {}) as Record<string, Array<[number, number]>>;
  const now = Number(extra.now ?? Date.now());

  return (
    <section className="ao-panel">
      <div className="ao-toolbar">
        <div className="ao-seg" role="group" aria-label="Game status">
          <button className={`ao-seg__opt${status === 'active' ? ' is-active' : ''}`} onClick={() => setStatus('active')}>
            Running <span className="ao-seg__n">{n(kpis.games_active)}</span>
          </button>
          <button className={`ao-seg__opt${status === 'completed' ? ' is-active' : ''}`} onClick={() => setStatus('completed')}>
            Finished <span className="ao-seg__n">{n(kpis.games_completed)}</span>
          </button>
        </div>
        <Search value={q} onChange={setQ} placeholder="Search games by name or id" />
        <Select<GameSort>
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[['activity', 'Last played'], ['players', 'Most players'], ['newest', 'Newest'], ['longest', 'Most ticks']]}
        />
      </div>

      {status === 'active' && (
        <div className="ao-legend">
          <span><i className="ao-hdot ao-hdot--tick" />ticking on time</span>
          <span><i className="ao-hdot ao-hdot--play" />played today</span>
          <span><i className="ao-hdot ao-hdot--war" />combat in 48h</span>
          <span><i className="ao-hdot ao-hdot--senate" />senate active</span>
        </div>
      )}

      {error && <div className="ao-none">{error}</div>}
      <div className={`ao-scroll${loading ? ' is-loading' : ''}`}>
        <table className="ao-table ao-table--click">
          <thead>
            <tr>
              <th>Game</th>
              {status === 'active' && <th>Health</th>}
              <th className="num">Tick</th>
              <th className="num">Seats</th>
              <th className="num">Played by · 14d</th>
              <th className="num">Time · 14d</th>
              <th className="num">Actions · 14d</th>
              <th>Last action</th>
              {status === 'active' ? <th>Credits trend</th> : <th>Result</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(g => {
              const quiet = g.status === 'active' && (!g.last_action_ms || now - g.last_action_ms > DAY);
              return (
                <tr
                  key={g.id}
                  tabIndex={0}
                  onClick={() => onOpen(g.id)}
                  onKeyDown={e => { if (e.key === 'Enter') onOpen(g.id); }}
                >
                  <td>
                    <span className="ao-name">{g.name}</span>
                    <span className="ao-sub">{g.id} · {Math.round(g.tick_interval_ms / 60000)} min/tick</span>
                  </td>
                  {status === 'active' && <td><HealthDots g={g} now={now} /></td>}
                  <td className="num">{n(g.current_tick)}</td>
                  <td className="num">{g.humans}<span className="ao-dim"> / {g.factions}</span></td>
                  <td className="num">{g.players_14d || <span className="ao-dim">0</span>}</td>
                  <td className="num">{hours(g.minutes_14d)}</td>
                  <td className="num">{n(g.actions_14d)}</td>
                  <td className={quiet ? 'ao-warn' : ''}>{ago(now, g.last_action_ms)}</td>
                  {status === 'active'
                    ? <td><TrendSpark points={sparks[g.id]} /></td>
                    : <td>{g.victory_type ? `won by ${g.victory_type}` : <span className="ao-dim">ended</span>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error && (
          <div className="ao-none">{dq ? `No ${status === 'active' ? 'running' : 'finished'} game matches “${dq}”.` : 'No games here yet.'}</div>
        )}
      </div>
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} loading={loading} />
    </section>
  );
}

// Triage dots: filled = healthy signal. The words are in the title and
// in the legend above the table, so colour is never the only carrier.
function HealthDots({ g, now }: { g: GameRow; now: number }) {
  const cadenceOk = g.next_tick_at != null && now < g.next_tick_at + 2 * g.tick_interval_ms;
  const playedToday = g.last_heartbeat_ms != null && now - g.last_heartbeat_ms < DAY;
  const combat = g.last_combat_ms != null && now - g.last_combat_ms < 2 * DAY;
  const senate = g.last_proposal_tick != null && g.current_tick - g.last_proposal_tick < 150;
  const dot = (on: boolean, cls: string, label: string) => (
    <i className={`ao-hdot ao-hdot--${cls}${on ? '' : ' is-off'}`} title={`${label}: ${on ? 'yes' : 'no'}`} />
  );
  return (
    <span className="ao-hdots" aria-label={[
      cadenceOk ? 'ticking' : 'not ticking on time',
      playedToday ? 'played today' : 'not played today',
    ].join(', ')}>
      {dot(cadenceOk, 'tick', 'Ticking on schedule')}
      {dot(playedToday, 'play', 'Played today')}
      {dot(combat, 'war', 'Combat in the last 48h')}
      {dot(senate, 'senate', 'Senate active')}
    </span>
  );
}

function TrendSpark({ points }: { points?: Array<[number, number]> }) {
  if (!points || points.length < 2) return <span className="ao-dim">—</span>;
  const w = 88, h = 22;
  const ys = points.map(p => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = Math.max(1, hi - lo);
  const line = points.map((p, i) =>
    `${((i / (points.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((p[1] - lo) / span) * (h - 6)).toFixed(1)}`).join(' ');
  const rising = ys[ys.length - 1] >= ys[0];
  return (
    <svg className="ao-trend" width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      aria-label={`credits ${rising ? 'rising' : 'falling'} over the last ${points.length} ticks`}>
      <polyline points={line} className={rising ? 'is-up' : 'is-down'} />
    </svg>
  );
}

// ---------- players ----------

type PlayerSort = 'time' | 'recent' | 'days' | 'newest';

function PlayersPanel({ refreshKey, onOpenGame }: { refreshKey: number; onOpenGame: (id: string) => void }) {
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<PlayerSort>('time');
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q, 250);
  useEffect(() => { setOffset(0); }, [scope, dq, sort]);

  const { rows, total, loading, error, extra } = usePaged<PlayerRow>('/api/admin/players', {
    scope, q: dq, sort, limit: String(PAGE), offset: String(offset),
  }, refreshKey);
  const now = Number(extra.now ?? Date.now());
  const day0 = Number(extra.day0_ms ?? 0);

  return (
    <section className="ao-panel">
      <div className="ao-toolbar">
        <div className="ao-seg" role="group" aria-label="Which players">
          <button className={`ao-seg__opt${scope === 'active' ? ' is-active' : ''}`} onClick={() => setScope('active')}>
            Played in 14 days
          </button>
          <button className={`ao-seg__opt${scope === 'all' ? ' is-active' : ''}`} onClick={() => setScope('all')}>
            Everyone
          </button>
        </div>
        <Search value={q} onChange={setQ} placeholder="Search by name or email" />
        <Select<PlayerSort>
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[['time', 'Most time played'], ['recent', 'Last played'], ['days', 'Most days active'], ['newest', 'Newest account']]}
        />
      </div>
      <p className="ao-note">Robot and test accounts are never listed. Time is minutes with the game open and in use.</p>

      {error && <div className="ao-none">{error}</div>}
      <div className={`ao-scroll${loading ? ' is-loading' : ''}`}>
        <table className="ao-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Playing in</th>
              <th>Last 14 days</th>
              <th className="num">Time · 14d</th>
              <th>This week</th>
              <th className="num" title="Actions the game refused, last 14 days">Refused</th>
              <th>Last played</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.id}>
                <td>
                  <span className="ao-name">{p.display_name}</span>
                  <span className="ao-sub">{p.email}</span>
                </td>
                <td>
                  <span className="ao-chips">
                    {p.games.length === 0 && <span className="ao-dim">—</span>}
                    {p.games.slice(0, 3).map(g => (
                      <button key={g.id} className="ao-chip" onClick={() => onOpenGame(g.id)} title={`${g.faction} in ${g.name}`}>
                        <i style={{ background: g.color }} />{g.name}
                      </button>
                    ))}
                    {p.games.length > 3 && <span className="ao-dim">+{p.games.length - 3}</span>}
                  </span>
                </td>
                <td><DayStrip days={p.days_14} day0={day0} /></td>
                <td className="num">{hours(p.minutes_14d)}</td>
                <td><WeekDelta cur={p.minutes_7d} prev={p.minutes_prior7} /></td>
                <td className={`num${refusedRate(p) > 0.15 ? ' ao-warn' : ''}`}>
                  {p.rejected_14d ? `${n(p.rejected_14d)} · ${Math.round(refusedRate(p) * 100)}%` : <span className="ao-dim">—</span>}
                </td>
                <td>{p.last_played_ms ? ago(now, p.last_played_ms) : <span className="ao-dim">never played</span>}</td>
                <td className="ao-dim">{ago(now, p.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error && (
          <div className="ao-none">
            {dq
              ? `Nobody ${scope === 'active' ? 'who played in the last 14 days ' : ''}matches “${dq}”.`
              : 'Nobody has played in the last 14 days.'}
            {dq && scope === 'active' && (
              <> <button className="ao-link" onClick={() => setScope('all')}>Search everyone</button></>
            )}
          </div>
        )}
      </div>
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} loading={loading} />
    </section>
  );
}

/** Fourteen cells, oldest first; brightness = minutes that day. One
 *  glance tells a daily regular from a player who binged once. */
function DayStrip({ days, day0 }: { days: number[]; day0: number }) {
  const max = Math.max(30, ...days);
  return (
    <span className="ao-strip" aria-label={`active ${days.filter(Boolean).length} of the last 14 days`}>
      {days.map((m, i) => (
        <i
          key={i}
          title={`${day0 ? dayLabel(day0 + i * DAY) : ''}: ${m ? playTime(m) : 'not played'}`}
          style={{ '--a': m ? 0.25 + 0.75 * Math.min(1, m / max) : 0 } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

function WeekDelta({ cur, prev }: { cur: number; prev: number }) {
  if (!cur && !prev) return <span className="ao-dim">—</span>;
  const diff = cur - prev;
  if (Math.abs(diff) < Math.max(5, prev * 0.1)) return <span className="ao-delta">about the same</span>;
  return diff > 0
    ? <span className="ao-delta ao-delta--up">▲ {playTime(diff)} more</span>
    : <span className="ao-delta ao-delta--down">▼ {playTime(-diff)} less</span>;
}

// ============================================================
// Growth: cohorts + sources
// ============================================================

const refusedRate = (p: PlayerRow) => (p.judged_14d ? (p.rejected_14d ?? 0) / p.judged_14d : 0);
/** Refused share of the tries that have an outcome; null until any do. */
const usageRate = (u: UsageRow) => (u.judged30 ? (u.rejected30 ?? 0) / u.judged30 : null);

/** Share of player actions the game refused over the last 30 days.
 *  Outcomes are only recorded from the 1 October update, so until then
 *  the tile says it is still collecting rather than showing a 0%. */
function RefusalKpi({ usage, onGo }: { usage: UsageRow[]; onGo: () => void }) {
  const tries = usage.reduce((s, u) => s + (u.judged30 ?? 0), 0);
  const refused = usage.reduce((s, u) => s + (u.rejected30 ?? 0), 0);
  const worst = [...usage].filter(u => (u.judged30 ?? 0) >= 20 && (u.rejected30 ?? 0) > 0)
    .sort((a, b) => usageRate(b)! - usageRate(a)!)[0];
  return (
    <Kpi
      label="Actions refused · 30 days"
      value={refused ? `${((refused / Math.max(1, tries)) * 100).toFixed(1)}%` : '—'}
      foot={worst
        ? <>worst: <span className="ao-warn">{labelForKind(worst.kind)}</span> {Math.round(usageRate(worst)! * 100)}%</>
        : 'recorded from the 1 Oct update on'}
      onClick={onGo}
    />
  );
}

// ============================================================
// Friction: where the game says no, and where it breaks
// ============================================================

function FrictionTab({ data }: { data: Overview }) {
  const friction = data.friction ?? [];
  const crashes = data.crashes ?? [];
  const rates = data.usage
    .filter(u => (u.judged30 ?? 0) >= 20 && (u.rejected30 ?? 0) > 0)
    .map(u => ({ ...u, rate: usageRate(u)! }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 12);
  return (
    <div className="ao-stack">
      <section className="ao-panel">
        <PanelHead
          title="Where players hit walls"
          hint="Every action the game refused in the last 7 days, by the reason it gave. A wall that many players hit is a rule the game is not explaining; one player hitting it over and over is someone stuck. Names in reasons are hidden as ·."
        />
        {friction.length === 0
          ? <div className="ao-none">No refusals recorded yet. Outcomes are recorded from the 1 October update on.</div>
          : <FrictionRows rows={friction.slice(0, 20)} max={friction[0].n} now={data.now} />}
      </section>

      <section className="ao-panel">
        <PanelHead
          title="Actions most often refused"
          hint="Of the attempts at each action in the last 30 days, the share the game turned down (actions tried at least 20 times since outcomes were recorded). High rates point at controls that look available when they are not."
        />
        {rates.length === 0 ? <div className="ao-none">Nothing refused often enough to rank yet.</div> : (
          <div className="ao-usage">
            {rates.map(r => (
              <div key={r.kind} className="ao-usage__row ao-usage__row--rate">
                <span className="ao-usage__label" title={r.kind}>{labelForKind(r.kind)}</span>
                <span className="ao-usage__track ao-usage__track--warn"><i style={{ width: `${r.rate * 100}%` }} /></span>
                <span className="ao-usage__n">{Math.round(r.rate * 100)}%</span>
                <span className="ao-usage__all">{n(r.rejected30)} of {n(r.judged30)} tries</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ao-panel">
        <PanelHead
          title="Crashes"
          hint="Real client crashes in the last 7 days, grouped by error. The Android app's launch breadcrumbs share this table and are left out."
        />
        {crashes.length === 0 ? <div className="ao-none">No crashes in the last 7 days.</div> : (
          <div>
            {crashes.map(c => (
              <div key={`${c.scope}|${c.message}`} className="ao-crash">
                <div>
                  <code>{c.message}</code>
                  <span className="ao-sub">{c.scope || 'web'}{c.git_sha ? ` · build ${c.git_sha.slice(0, 8)}` : ''}</span>
                </div>
                <span className="ao-usage__n">{n(c.n)}×</span>
                <span className="ao-dim">{c.users} {c.users === 1 ? 'player' : 'players'}</span>
                <span className="ao-dim">{ago(data.now, c.last_ms)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ============================================================
// The new-player journey (Growth tab)
// ============================================================

function JourneyFunnel({ journey }: { journey: Journey }) {
  const size = journey.signed_up;
  if (!size) return <div className="ao-none">No signups in the last 30 days.</div>;
  // Each step's base is everyone who signed up, except the "came back"
  // steps, which only count players old enough to have had the chance.
  const base = (id: string) => (id === 'back1' ? journey.eligible_1d : id === 'back7' ? journey.eligible_7d : size);
  const rows = journey.steps.map(s => ({ ...s, of: base(s.id), p: base(s.id) ? s.n / base(s.id) : 0 }));
  // The biggest single drop between neighbouring steps is the one to fix.
  let worst = -1;
  let worstDrop = 0;
  rows.forEach((r, i) => {
    if (i === 0) return;
    const drop = rows[i - 1].p - r.p;
    if (drop > worstDrop && !['back1', 'back7'].includes(r.id)) { worstDrop = drop; worst = i; }
  });
  return (
    <div className="ao-funnel">
      <div className="ao-funnel__row">
        <span className="ao-funnel__label">Signed up</span>
        <span className="ao-funnel__track"><span className="ao-funnel__fill" style={{ width: '100%' }} /></span>
        <span className="ao-funnel__n">{n(size)}</span>
        <span className="ao-funnel__time" />
      </div>
      {rows.map((r, i) => {
        const prevP = i === 0 ? 1 : rows[i - 1].p;
        return (
          <div key={r.id} className="ao-funnel__row">
            <span className={`ao-funnel__label${i === worst ? ' ao-funnel__worst' : ''}`} title={i === worst ? 'The biggest drop between two steps' : undefined}>
              {r.label}{i === worst ? ' ◀ biggest drop' : ''}
            </span>
            <span className="ao-funnel__track">
              <span className="ao-funnel__fill" style={{ width: `${r.p * 100}%` }} />
              {prevP > r.p && <span className="ao-funnel__drop" style={{ left: `${r.p * 100}%`, width: `${(prevP - r.p) * 100}%` }} />}
            </span>
            <span className="ao-funnel__n">{Math.round(r.p * 100)}%<small>{n(r.n)}</small></span>
            <span className="ao-funnel__time">{r.median_ms != null ? `median ${span(r.median_ms)} in` : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

function Growth({ data }: { data: Overview }) {
  const cohorts = data.cohorts;
  const sum = (key: keyof Cohort) => cohorts.reduce((s, c) => s + (c[key] as number), 0);
  const rate = (r: keyof Cohort, e: keyof Cohort) => pctOf(sum(r), sum(e));
  const headline: Array<[string, number | null, number]> = [
    ['came back the next day', rate('r1', 'e1'), sum('e1')],
    ['came back after a week', rate('r7', 'e7'), sum('e7')],
    ['after two weeks', rate('r14', 'e14'), sum('e14')],
    ['after four weeks', rate('r28', 'e28'), sum('e28')],
  ];
  return (
    <div className="ao-stack">
      {data.journey && (
        <section className="ao-panel">
          <PanelHead
            title="What new players actually do"
            hint="Everyone who signed up in the last 30 days, and how many reached each of the game's basics, with the median time it took them. A step counts only when the game said yes, not on a refused attempt. The striped part of each bar is who dropped off since the step above."
          />
          <JourneyFunnel journey={data.journey} />
        </section>
      )}
      <section className="ao-panel">
        <PanelHead
          title="Do new players come back?"
          hint="Everyone who signed up in the last 12 weeks, grouped by the week they joined. “Came back after a week” means they played again at least seven days after signing up. Players too new to have had the chance are left out of that column."
        />
        <div className="ao-headline">
          {headline.map(([label, p, of]) => (
            <div key={label} className="ao-headline__item">
              <span className="ao-headline__value">{p == null ? '—' : `${p}%`}</span>
              <span className="ao-headline__label">{label}</span>
              <span className="ao-headline__of">of {n(of)} old enough</span>
            </div>
          ))}
        </div>
        <CohortTable rows={cohorts} />
      </section>
      <section className="ao-panel">
        <PanelHead
          title="Where players came from"
          hint="Every account by where it first arrived from: your link tag (?from=…), a friend’s invite, the site that sent them, or “direct”. Took a seat = joined a game. Came back = played again a day or more after signing up."
        />
        <SourcesTable rows={data.sources} now={data.now} />
      </section>
    </div>
  );
}

function CohortTable({ rows }: { rows: Cohort[] }) {
  if (rows.length === 0) return <div className="ao-none">No signups in the last 12 weeks.</div>;
  const cell = (r: number, e: number, size: number) => {
    if (e === 0) return <td className="ao-cohort__na" title="Nobody in this week is old enough yet">…</td>;
    const p = r / e;
    return (
      <td
        className="ao-cohort__cell"
        style={{ '--a': 0.06 + 0.6 * p } as React.CSSProperties}
        title={`${r} of ${e}${e < size ? ` (the other ${size - e} are too new)` : ''}`}
      >
        {Math.round(p * 100)}%{e < size && <sup>*</sup>}
      </td>
    );
  };
  const share = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <div className="ao-scroll">
      <table className="ao-table ao-cohort">
        <thead>
          <tr>
            <th>Week of</th>
            <th className="num">Signed up</th>
            <th className="num">Took a seat</th>
            <th className="num">Played</th>
            <th className="num">Next day</th>
            <th className="num">1 week</th>
            <th className="num">2 weeks</th>
            <th className="num">4 weeks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.week_ms}>
              <td>{dayLabel(c.week_ms)}</td>
              <td className="num">{n(c.size)}</td>
              <td className="num">{share(c.seated, c.size)}</td>
              <td className="num">{share(c.played, c.size)}</td>
              {cell(c.r1, c.e1, c.size)}
              {cell(c.r7, c.e7, c.size)}
              {cell(c.r14, c.e14, c.size)}
              {cell(c.r28, c.e28, c.size)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ao-note"><sup>*</sup> part of this week is too new to count yet; the figure is for the players who are old enough.</p>
    </div>
  );
}

function SourcesTable({ rows, now }: { rows: SourceRow[]; now: number }) {
  if (rows.length === 0) return <div className="ao-none">No accounts yet.</div>;
  const Rate = ({ a, of }: { a: number; of: number }) => {
    const p = pctOf(a, of) ?? 0;
    return (
      <span className="ao-rate">
        <span className="ao-rate__bar"><i style={{ width: `${p}%` }} /></span>
        <span className="ao-rate__n">{p}%</span>
      </span>
    );
  };
  return (
    <div className="ao-scroll">
      <table className="ao-table">
        <thead>
          <tr>
            <th>Source</th><th className="num">Signups</th><th className="num">30 days</th>
            <th>Took a seat</th><th>Came back</th><th>Latest</th><th>Via</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.source || '(none)'}>
              {/* Blank = the account predates tracking; never guessed. */}
              <td>{r.source || <span className="ao-dim">before tracking</span>}</td>
              <td className="num">{n(r.signups)}</td>
              <td className="num">{n(r.signups_30d)}</td>
              <td><Rate a={r.joined} of={r.signups} /></td>
              <td><Rate a={r.came_back} of={r.signups} /></td>
              <td>{r.latest_ms ? ago(now, r.latest_ms) : '—'}</td>
              <td className="ao-sub ao-wrap">{r.referrers ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Features
// ============================================================

// Cross-game: what is used anywhere, and what is used NOWHERE.
const FEATURE_REGISTRY: Array<{ label: string; match: (k: string) => boolean }> = [
  { label: 'Fleets', match: k => k.includes('fleets') },
  { label: 'Senate votes', match: k => k.includes('senate') && !k.startsWith('ui/') },
  { label: 'Trade offers', match: k => k.includes('trade') || k.includes('offers') },
  { label: 'Ship building', match: k => k.includes('build') },
  { label: 'Research', match: k => k.includes('research') },
  { label: 'Captains', match: k => k.includes('captain') },
  { label: 'Ship designs', match: k => k.includes('designs') },
  { label: 'Recap', match: k => k === 'ui/recap' },
];

function Features({ rows }: { rows: UsageRow[] }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const unused = FEATURE_REGISTRY.filter(f => !rows.some(r => r.total > 0 && f.match(r.kind)));
  const quiet = FEATURE_REGISTRY.filter(f =>
    !unused.includes(f) && !rows.some(r => r.n30 > 0 && f.match(r.kind)));
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? rows.filter(r => labelForKind(r.kind).toLowerCase().includes(needle) || r.kind.toLowerCase().includes(needle))
      : rows;
  }, [rows, q]);
  const shown = all || q ? filtered : filtered.slice(0, 15);
  const max = Math.max(1, ...rows.map(r => r.n30));

  return (
    <section className="ao-panel">
      <PanelHead
        title="Which features get used"
        hint="Every action players took in the last 30 days, all games, against the 30 days before. Near zero means undiscoverable or not worth keeping."
      >
        <Search value={q} onChange={setQ} placeholder="Filter actions" />
      </PanelHead>
      {(unused.length > 0 || quiet.length > 0) && (
        <div className="ao-callout">
          {unused.length > 0 && <div><b>Never used, in any game:</b> {unused.map(f => f.label).join(', ')}.</div>}
          {quiet.length > 0 && <div><b>Not used in the last 30 days:</b> {quiet.map(f => f.label).join(', ')}.</div>}
        </div>
      )}
      {rows.length === 0 && <div className="ao-none">No actions logged anywhere yet.</div>}
      <div className="ao-usage">
        {shown.map(r => {
          const change = r.prev30 ? Math.round(((r.n30 - r.prev30) / r.prev30) * 100) : null;
          return (
            <div key={r.kind} className="ao-usage__row">
              <span className="ao-usage__label" title={r.kind}>{labelForKind(r.kind)}</span>
              <span className="ao-usage__track"><i style={{ width: `${(r.n30 / max) * 100}%` }} /></span>
              <span className="ao-usage__n">{n(r.n30)}</span>
              <span className={`ao-usage__chg ${change == null ? '' : change >= 0 ? 'ao-delta--up' : 'ao-delta--down'}`}>
                {change == null ? (r.n30 ? 'new' : '') : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%`}
              </span>
              <span className={`ao-usage__rej${(usageRate(r) ?? 0) > 0.15 ? ' ao-warn' : ''}`}>
                {r.rejected30 ? `${Math.round((usageRate(r) ?? 0) * 100)}% refused` : ''}
              </span>
              <span className="ao-usage__all">{n(r.total)} all time</span>
            </div>
          );
        })}
      </div>
      {!q && filtered.length > 15 && (
        <button className="ao-link" onClick={() => setAll(a => !a)}>
          {all ? 'Show the top 15' : `Show all ${filtered.length} actions`}
        </button>
      )}
    </section>
  );
}

// ============================================================
// Commission
// ============================================================

function Commission({ kpis }: { kpis: Kpis }) {
  return (
    <div className="ao-stack">
      <div className="ao-kpis ao-kpis--two">
        <Kpi label="Commissions sold" value={n(kpis.commissions_total)} gold foot="paid through Stripe, all time" />
        <Kpi label="Sold this week" value={n(kpis.commissions_week)} gold foot="last 7 days" />
      </div>
      <CommissionFunnel />
      <section className="ao-panel">
        <PanelHead
          title="Accounts"
          hint="Look anyone up by name or email, and grant or revoke the Commander’s Commission — comps, refunds, a purchase on the wrong account."
        />
        <PremiumGrants />
      </section>
    </div>
  );
}

type FunnelRow = {
  surface: string; views: number; viewers: number; clicks: number;
  dismissals: number; checkouts: number; paid: number;
};
type FunnelData = {
  days: number;
  surfaces: FunnelRow[];
  gifts: { sold: number; redeemed: number; voided: number; redeemed_grants: number };
  thanks_card: Record<string, number>;
};
const SURFACE_LABEL: Record<string, string> = {
  profile: 'Profile hangar',
  'lobby-flag': 'Lobby flag picker',
  designer: 'Ship designer preview',
  endgame: 'End of game',
  'thanks-card': '20-hour thank-you',
  other: 'Other / older clients',
  'before tracking': 'Before tracking',
};

/**
 * Which surface sells (0153). Each surface logs a view, a click and a
 * dismissal; checkout logs every attempt; the paid row carries where it
 * started. Read left to right, each row is that surface's funnel.
 */
function CommissionFunnel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<FunnelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void apiFetch<FunnelData>(`/api/admin/commission?days=${days}`).then(res => {
      if (dead) return;
      if (res.ok) { setData(res.data); setError(null); } else setError('Could not load the funnel.');
    });
    return () => { dead = true; };
  }, [days]);
  const rate = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '\u2014');
  const rows = (data?.surfaces ?? []).filter(r => r.views || r.clicks || r.checkouts || r.paid || SURFACE_LABEL[r.surface]);
  return (
    <section className="ao-panel">
      <PanelHead
        title="Which surface sells"
        hint="For each place the Commission appears: how many saw it, clicked, started a checkout and paid. Views count once per page load. Recorded from the Oct 5 update on; robots excluded."
      >
        <div className="ao-seg" role="group" aria-label="Window">
          {[7, 30, 90].map(d => (
            <button key={d} className={`ao-seg__opt${days === d ? ' is-active' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      </PanelHead>
      {error && <div className="ao-none">{error}</div>}
      {!data && !error && <div className="ao-none">Loading…</div>}
      {data && (
        <>
          <div className="ao-scroll">
            <table className="ao-table">
              <thead>
                <tr>
                  <th>Surface</th>
                  <th className="num">Views</th>
                  <th className="num">Players</th>
                  <th className="num">Clicks</th>
                  <th className="num">Click rate</th>
                  <th className="num">Checkouts</th>
                  <th className="num">Paid</th>
                  <th className="num">Dismissed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.surface}>
                    <td>{SURFACE_LABEL[r.surface] ?? r.surface}</td>
                    <td className="num">{n(r.views)}</td>
                    <td className="num">{n(r.viewers)}</td>
                    <td className="num">{n(r.clicks)}</td>
                    <td className="num">{rate(r.clicks, r.views)}</td>
                    <td className="num">{n(r.checkouts)}</td>
                    <td className="num">{n(r.paid)}</td>
                    <td className="num">{r.dismissals ? n(r.dismissals) : <span className="ao-dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ao-note" style={{ marginTop: 12 }}>
            Gifts: {n(data.gifts.sold)} bought, {n(data.gifts.redeemed)} redeemed
            {data.gifts.voided ? `, ${n(data.gifts.voided)} refunded` : ''}.
            {' '}Thank-you card answers: {n(data.thanks_card.clicked ?? 0)} interested, {n(data.thanks_card.dismissed ?? 0)} no thanks.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The admin override for the Commission: browse every account, search by
 * name or email, grant/revoke inline. Look up FIRST, then act — the
 * buttons only exist on a row that is on screen, so a mistyped email is a
 * harmless "no match" rather than a grant landing on a stranger.
 */
type AdminUser = {
  id: string; email: string; display_name: string; created_at: number;
  last_login_at: number | null; is_premium: boolean;
  premium_source: string | null; premium_at: number | null; premium_by: string | null;
};

function PremiumGrants() {
  const [q, setQ] = useState('');
  const [premiumOnly, setPremiumOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [bump, setBump] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  /** Which row has an action in flight, so one grant does not grey out
   *  every button in the list. */
  const [acting, setActing] = useState<string | null>(null);
  const dq = useDebounced(q, 250);
  useEffect(() => { setOffset(0); }, [dq, premiumOnly]);

  const params: Record<string, string> = { limit: String(PAGE), offset: String(offset) };
  if (dq.trim()) params.q = dq.trim();
  if (premiumOnly) params.premium = '1';
  const { rows, total, loading, error, extra } = usePaged<AdminUser>('/api/admin/users', params, bump);
  const premiumTotal = Number(extra.premium_total ?? 0);

  const act = async (u: AdminUser) => {
    setActing(u.id); setNote(null);
    const res = await apiFetch<{ ok: boolean }>(
      u.is_premium ? '/api/admin/entitlements/revoke' : '/api/admin/entitlements',
      { method: 'POST', body: JSON.stringify({ email: u.email }) },
    );
    setActing(null);
    if (!res.ok) { setNote(res.error?.message ?? 'That did not work.'); return; }
    setNote(`${u.is_premium ? 'Revoked' : 'Granted'} — ${u.display_name}`);
    // Re-read rather than flip the row, so it shows the server's truth.
    setBump(b => b + 1);
  };

  return (
    <div>
      <div className="ao-toolbar">
        <Search value={q} onChange={setQ} placeholder="Search name or email — blank lists everyone" />
        <label className="ao-check">
          <input type="checkbox" checked={premiumOnly} onChange={e => setPremiumOnly(e.target.checked)} />
          Commission holders only <span className="ao-dim">({n(premiumTotal)})</span>
        </label>
      </div>
      {error && <div className="ao-none">{error}</div>}
      {note && <div className="ao-toast" role="status">{note}</div>}
      <div className={`ao-scroll${loading ? ' is-loading' : ''}`}>
        <table className="ao-table">
          <thead>
            <tr><th>Account</th><th>Last seen</th><th>Commission</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(u => (
              <tr key={u.id}>
                <td>
                  <span className="ao-name">{u.display_name}</span>
                  <span className="ao-sub">{u.email}</span>
                </td>
                <td className="ao-dim" title={`joined ${new Date(u.created_at).toLocaleDateString()}`}>
                  {ago(Date.now(), u.last_login_at)}
                </td>
                <td>
                  {u.is_premium
                    ? (
                      <span className="ao-pill ao-pill--gold" title={u.premium_by ? `granted by ${u.premium_by}` : undefined}>
                        {u.premium_source === 'stripe' ? 'Paid' : 'Granted'}
                        {u.premium_at ? ` · ${new Date(u.premium_at).toLocaleDateString()}` : ''}
                      </span>
                    )
                    : <span className="ao-dim">—</span>}
                </td>
                <td className="num">
                  <button
                    className={`ao-btn${u.is_premium ? ' ao-btn--danger' : ''}`}
                    disabled={acting === u.id}
                    onClick={() => void act(u)}
                  >
                    {acting === u.id ? '…' : u.is_premium ? 'Revoke' : 'Grant'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error && <div className="ao-none">No matching accounts.</div>}
      </div>
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} loading={loading} />
    </div>
  );
}
