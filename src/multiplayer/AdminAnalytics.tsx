// ============================================================
// AdminAnalytics — live-ops dashboard, visible only to the
// allow-listed admin account (server re-checks every request;
// this component 404s for anyone else and renders nothing
// useful). Two views:
//   list  : every active/completed game with engagement vitals
//   detail: one game — yield curves, faction standings,
//           feature usage, per-player engagement
// Purpose: spot how engaged players are and where the economy
// needs balancing, so the charts favor comparability (shared
// scales per resource) over prettiness.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import './AdminAnalytics.css';

type OverviewGame = {
  id: string; name: string; status: string; current_tick: number;
  tick_interval_ms: number; next_tick_at: number | null; victory_type: string | null;
  created_at: number; humans: number; factions: number;
  last_action_ms: number | null; actions_14d: number;
  last_heartbeat_ms?: number | null; last_combat_ms?: number | null;
  last_proposal_tick?: number | null;
};
type OverviewPlayer = {
  id: string; display_name: string; email: string;
  sessions_14d: number; last_seen_ms: number | null;
  minutes_14d: number; active_days_14d: number;
  minutes_7d: number; minutes_prior7: number;
};
type RetentionRow = {
  id: string; display_name: string; created_at: number;
  d1: boolean; d7: boolean; d14: boolean;
};
type Overview = {
  now: number; games: OverviewGame[]; players: OverviewPlayer[];
  retention: RetentionRow[]; heat_grid: number[][];
  sparks: Record<string, Array<[number, number]>>;
  usage_global: Array<{ kind: string; total: number; games_used: number }>;
};

type FactionRow = {
  id: string; name: string; color: string; status: string; user_id: string | null;
  player_name: string | null; metal: number; fuel: number; gold: number; science: number;
  reputation: number; ships: number; settlements: number; techs_completed: number;
};
type CurvePoint = {
  tick_number: number; faction_id: string;
  metal: number; fuel: number; gold: number; science: number;
  ships: number; settlements: number;
};
type UsageRow = { kind: string; total: number; last_14d: number; distinct_users: number };
type EngagementRow = {
  id: string; display_name: string; faction_id: string; faction_name: string; color: string;
  sessions_14d: number; last_seen_ms: number | null;
  minutes_14d: number; active_days_14d: number; actions_14d: number;
};
type FactionCount = { faction_id: string | null; n: number };
type PerfRow = {
  user_id: string; display_name: string; samples: number;
  total_p50: number; total_p95: number;
  map_p50: number; map_p95: number;
  paint_p50: number; paint_p95: number;
  fetch_p50: number; frame_p50: number;
  ships: number; cores: number | null; mem_gb: number | null;
  mobile: number; ua: string;
};

type RenderRow = {
  user_id: string; display_name: string; beats: number;
  fps_avg: number; fps_low1: number; draw_p95: number; long_frames: number;
  fps_early: number; fps_late: number; heap_early: number; heap_late: number;
  ships: number; gpu: string | null; cores: number | null; mem_gb: number | null;
  dpr: number | null; screen: string | null; mobile: number; ua: string;
};

type GameAnalytics = {
  now: number;
  perf: PerfRow[];
  render: RenderRow[];
  game: OverviewGame & { winner_faction_id: string | null };
  factions: FactionRow[]; curves: CurvePoint[]; usage: UsageRow[]; engagement: EngagementRow[];
  techPace: Array<{ faction_id: string; completed: number; avg_ticks: number; last_completed_tick: number }>;
  techDetail: Array<{
    faction_id: string; tech_id: string; level: number; status: string;
    started_at_tick: number | null; completed_at_tick: number | null;
  }>;
  combat: {
    losses: FactionCount[]; kills: FactionCount[]; settlements_lost: FactionCount[];
    /** COMBAT V2 telemetry (migration 0063). Absent on games that have not
     *  ticked since the table landed. */
    tally?: CombatTallyRow[];
    /** Second wave (migration 0069). Each field is independently
     *  best-effort server-side, so any of them may be missing. */
    ship_stats?: ShipStatRow[];
    economy?: { hp_repaired: number; hp_destroyed: number };
    captains?: {
      lost: number; rescued: number; active: number;
      banked: number; top_rank: number; avg_rank: number;
    };
    retreats?: { fired: number; saved: number };
    detonations?: { count: number; damage: number; kills: number };
    priority?: { armed: number; custom: number };
    battles?: {
      count: number; avg_ticks: number; longest: number;
      avg_deaths: number; decisive: number;
    };
    loadouts?: Array<{ ship_class: string; loadout: string; alive: number; lost: number }>;
  };
  shipClasses: {
    alive: Array<{ ship_class: string; n: number }>;
    lost: Array<{ ship_class: string | null; n: number }>;
  };
  senate: { proposals: FactionCount[]; votes: Array<{ faction_id: string; vote: string; n: number }>; proposal_total: number };
  trade: { routes: FactionCount[]; offers: Array<{ status: string; n: number }> };
  dropoff: Array<{ kind: string; n: number }>;
  spend: Array<{ faction_id: string | null; category: string; metal: number; gold: number }>;
  timeline: Array<{ user_id: string; day: string; n: number }>;
};

const METRICS = ['metal', 'fuel', 'gold', 'science', 'ships', 'settlements'] as const;

/** One (attacker class -> target class) pairing's running totals. */
interface CombatTallyRow {
  attacker_class: string;
  target_class: string;
  volleys: number;
  hits: number;
  damage: number;
  kills: number;
  /** Pre-mitigation damage fired (0069). damage_raw - damage is what the
   *  target's shields/armor absorbed. */
  damage_raw?: number;
  /** Damage landed on a hull that died the same tick (0069). */
  overkill?: number;
}

/** Per-hull lifetime combat record (migration 0069) — the only source
 *  that can name a specific ship, which is what the awards need. */
interface ShipStatRow {
  ship_id: string;
  ship_name: string | null;
  ship_class: string | null;
  faction_id: string | null;
  shots: number;
  hits: number;
  shots_taken: number;
  hits_taken: number;
  damage_dealt: number;
  damage_taken: number;
  damage_absorbed: number;
  kills: number;
  overkill: number;
  low_hp_kills: number;
  /** 1 while the hull is still flying; the record outlives the ship. */
  alive: number;
}

/** Speeds the server fights with — worker/factions.js SHIP_COMBAT_STATS.speed
 *  plus SETTLEMENT_SPEED. Used ONLY to draw the predicted hit chance beside
 *  the observed one, so a drift between model and reality is visible rather
 *  than inferred. KEEP IN SYNC. */
const V2_SPEED: Record<string, number> = {
  corvette: 0.85, frigate: 0.50, destroyer: 0.30,
  freighter: 0.55, colony: 0.55, settlement: 0.30, station: 0.30,
};
const CLASS_ORDER = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony', 'station', 'settlement'];
const predictedHit = (atk: string, def: string): number | null => {
  const a = V2_SPEED[atk], d = V2_SPEED[def];
  if (a == null || d == null) return null;
  return (a * a) / (a * a + d * d);
};
type Metric = typeof METRICS[number];

// Event kinds are normalized route strings ("POST bodies/build") -
// meaningful to the server, gibberish on a dashboard. Known kinds get
// hand-written labels; unknown ones get a generic de-HTTP-ing so a new
// route never shows a raw method verb again.
const KIND_LABELS: Record<string, string> = {
  'POST bodies/build': 'Build ship',
  'POST bodies/settlement': 'Found colony',
  'POST bodies/ram': 'Asteroid ram',
  'POST settlements/buildings': 'Queue building',
  'DELETE settlements/buildings': 'Cancel building',
  'POST settlements/collector': 'Build collector',
  'DELETE settlements': 'Abandon settlement',
  'PATCH settlements': 'Rename settlement',
  'POST research': 'Set research',
  'POST trades': 'Propose trade',
  'POST trades/accept': 'Accept trade',
  'POST trades/decline': 'Decline trade',
  'POST trades/counter': 'Counter trade',
  'POST trades/cancel': 'Cancel trade',
  'POST trades/deliveries/assign': 'Assign trade delivery',
  'POST trade-routes': 'Create trade route',
  'DELETE trade-routes': 'Cancel trade route',
  'POST fleets': 'Form fleet',
  'PATCH fleets': 'Edit fleet',
  'DELETE fleets': 'Disband fleet',
  'POST fleets/orders': 'Fleet orders',
  'POST designs': 'Save ship design',
  'PATCH designs': 'Edit ship design',
  'DELETE designs': 'Delete ship design',
  'POST captains': 'Recruit captain',
  'PATCH captains': 'Edit captain',
  'POST captains/assign': 'Assign captain',
  'POST senate/proposals': 'Raise senate proposal',
  'POST senate/proposals/vote': 'Senate vote',
  'POST senate/proposals/withdraw': 'Withdraw proposal',
  'POST senate/sliders': 'Senate sliders',
  'POST ships/orders': 'Ship standing orders',
  'PATCH ships': 'Rename ship',
  'POST ships/transfer': 'Ship transfer',
  'POST ships/detonate': 'Detonate ship',
  'DELETE builds': 'Cancel ship build',
  'DELETE nodes': 'Cancel maneuver',
  'POST build-list': 'Set build list',
  'POST dyson/initiate': 'Begin Dyson project',
  'POST pacts': 'Pact action',
  'POST treaties/break': 'Break treaty',
  'POST turn/commit': 'Commit turn',
  'ui/trades': 'Open trade panel',
  'ui/recap': 'Play recap',
};
function labelForKind(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  if (kind.startsWith('ui/')) return `Open ${kind.slice(3)} panel`;
  const m = kind.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/);
  if (!m) return kind;
  const verb = { POST: '', PATCH: 'Edit ', PUT: 'Edit ', DELETE: 'Cancel ', GET: 'View ' }[m[1]] ?? '';
  const noun = m[2].replace(/[/-]/g, ' ');
  return (verb + noun).trim().replace(/^./, c => c.toUpperCase());
}

// Heartbeats arrive once per active minute, so a count of them IS
// minutes of play. Format 90 -> "1h 30m".
function playTime(minutes: number): string {
  if (!minutes) return '—';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ago(now: number, ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AdminAnalytics({ onEnterRoom }: { onEnterRoom: (roomId: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch<Overview>('/api/admin/overview');
    if (res.ok) { setOverview(res.data); setError(null); }
    else setError('Analytics unavailable for this account.');
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error) return <div className="aa-empty">{error}</div>;
  if (!overview) return <div className="aa-empty">Loading analytics…</div>;
  if (gameId) {
    return (
      <GameDetail
        gameId={gameId}
        onBack={() => setGameId(null)}
        onEnterRoom={onEnterRoom}
      />
    );
  }
  return <OverviewView data={overview} onOpen={setGameId} />;
}

// ---------- overview ----------

// Tiny inline trend line. Points are [tick, value]; renders flat-line
// for <2 points rather than nothing so cards keep a stable layout.
function Spark({ points, color = '#4ecdc4', w = 96, h = 22 }: {
  points: Array<[number, number]>; color?: string; w?: number; h?: number;
}) {
  if (!points || points.length < 2) return <svg width={w} height={h} className="aa-spark" />;
  const xs = points.map(pt => pt[0]);
  const ys = points.map(pt => pt[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const path = points
    .map(([px, py]) => `${((px - minX) / spanX) * (w - 2) + 1},${h - 2 - ((py - minY) / spanY) * (h - 4)}`)
    .join(' ');
  const rising = ys[ys.length - 1] >= ys[0];
  return (
    <svg width={w} height={h} className="aa-spark">
      <polyline points={path} fill="none" stroke={rising ? color : '#d06a75'} strokeWidth={1.5} />
    </svg>
  );
}

// Triage dots: green = healthy signal, dim = stale/absent. Titles carry
// the specifics so the dots stay glanceable.
function HealthDots({ g, now }: { g: OverviewGame; now: number }) {
  const DAY = 86_400_000;
  const cadenceOk = g.status !== 'active'
    ? false
    : g.next_tick_at != null && now < g.next_tick_at + 2 * g.tick_interval_ms;
  const playersToday = g.last_heartbeat_ms != null && now - g.last_heartbeat_ms < DAY;
  const combatRecent = g.last_combat_ms != null && now - g.last_combat_ms < 2 * DAY;
  const senateAlive = g.last_proposal_tick != null && g.current_tick - g.last_proposal_tick < 150;
  const dot = (on: boolean, label: string, color: string) => (
    <span
      key={label}
      className="aa-hdot"
      title={`${label}: ${on ? 'yes' : 'no'}`}
      style={{ background: on ? color : 'rgba(120,140,160,0.25)' }}
    />
  );
  return (
    <span className="aa-hdots">
      {dot(cadenceOk, 'Ticking on schedule', '#4ecdc4')}
      {dot(playersToday, 'Players active today', '#7fd8cf')}
      {dot(combatRecent, 'Combat in last 48h', '#d06a75')}
      {dot(senateAlive, 'Senate active', '#c9a84c')}
    </span>
  );
}

// 7x24 day-of-week x hour grid. DB buckets are UTC; shift each cell to
// the viewer's local clock (day wraps along with the hour).
function HeatGrid({ grid }: { grid: number[][] }) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const local = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const shifted = h + offset;
      const lh = ((shifted % 24) + 24) % 24;
      const ld = (((d + Math.floor(shifted / 24)) % 7) + 7) % 7;
      local[ld][lh] += grid[d]?.[h] ?? 0;
    }
  }
  const max = Math.max(1, ...local.flat());
  const total = local.flat().reduce((x, y) => x + y, 0);
  if (total === 0) return <div className="aa-empty">No play recorded yet.</div>;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <div className="aa-scroll-x">
      <table className="aa-heatgrid">
        <tbody>
          {local.map((row, d) => (
            <tr key={d}>
              <td className="aa-heatgrid__day">{days[d]}</td>
              {row.map((n, h) => (
                <td key={h} title={`${days[d]} ${h}:00 - ${n} min`}>
                  <div className="aa-heatgrid__cell" style={{ opacity: n ? 0.25 + 0.75 * (n / max) : 0.06 }} />
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td />
            {Array.from({ length: 24 }, (_, h) => (
              <td key={h} className="aa-heatgrid__lbl">{h % 6 === 0 ? h : ''}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function OverviewView({ data, onOpen }: { data: Overview; onOpen: (id: string) => void }) {
  const { now } = data;
  const live = data.games.filter(g => g.status === 'active');
  const done = data.games.filter(g => g.status !== 'active');
  return (
    <div className="aa-root">
      <section>
        <div className="aa-section-title">LIVE GAMES · {live.length}</div>
        <div className="aa-cards">
          {live.map(g => <GameCard key={g.id} g={g} now={now} spark={data.sparks[g.id]} onOpen={onOpen} />)}
          {live.length === 0 && <div className="aa-empty">No active games.</div>}
        </div>
      </section>
      {done.length > 0 && (
        <section>
          <div className="aa-section-title">FINISHED · {done.length}</div>
          <div className="aa-cards">
            {done.map(g => <GameCard key={g.id} g={g} now={now} onOpen={onOpen} />)}
          </div>
        </section>
      )}
      <section>
        <div className="aa-section-title">PLAY HOURS · LOCAL TIME · 14D</div>
        <HeatGrid grid={data.heat_grid} />
      </section>
      <section>
        <div className="aa-section-title">CROSS-GAME FEATURE USE</div>
        <MetaUsage rows={data.usage_global} />
      </section>
      <section>
        <div className="aa-section-title">NEW-PLAYER RETENTION · 28D COHORT</div>
        <RetentionTable rows={data.retention} now={now} />
      </section>
      <section>
        <div className="aa-section-title">PLAYERS · LAST 14 DAYS</div>
        <table className="aa-table">
          <thead>
            <tr><th>Player</th><th>Logins</th><th>Time in game</th><th>Δ vs prior wk</th><th>Active days</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {data.players.map(p => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.sessions_14d}</td>
                <td>{playTime(p.minutes_14d)}</td>
                <td><WeekDelta cur={p.minutes_7d} prev={p.minutes_prior7} /></td>
                <td>{p.active_days_14d}</td>
                <td>{ago(now, p.last_seen_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}


function RetentionTable({ rows, now }: { rows: RetentionRow[]; now: number }) {
  if (rows.length === 0) return <div className="aa-empty">No new accounts in the last 28 days.</div>;
  const DAY = 86_400_000;
  // A cohort member only counts toward Dn once they are ≥n days old —
  // otherwise young accounts read as churned.
  const eligible = (r: RetentionRow, days: number) => now - r.created_at >= days * DAY;
  const pct = (days: number, key: 'd1' | 'd7' | 'd14') => {
    const el = rows.filter(r => eligible(r, days));
    if (el.length === 0) return '—';
    return `${Math.round((el.filter(r => r[key]).length / el.length) * 100)}%`;
  };
  return (
    <div>
      <div className="aa-card__row" style={{ marginBottom: 8 }}>
        <span>Cohort: {rows.length}</span>
        <span>D1 return: {pct(1, 'd1')}</span>
        <span>D7: {pct(7, 'd7')}</span>
        <span>D14: {pct(14, 'd14')}</span>
      </div>
      <table className="aa-table">
        <thead><tr><th>Player</th><th>Joined</th><th>D1</th><th>D7</th><th>D14</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.display_name}</td>
              <td>{ago(now, r.created_at)}</td>
              <td>{eligible(r, 1) ? (r.d1 ? '✓' : '·') : '…'}</td>
              <td>{eligible(r, 7) ? (r.d7 ? '✓' : '·') : '…'}</td>
              <td>{eligible(r, 14) ? (r.d14 ? '✓' : '·') : '…'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Rising/falling arrow with magnitude for week-over-week comparisons.
function WeekDelta({ cur, prev }: { cur: number; prev: number }) {
  if (!cur && !prev) return <span className="aa-delta aa-delta--flat">-</span>;
  const diff = cur - prev;
  if (Math.abs(diff) < Math.max(5, prev * 0.1)) return <span className="aa-delta aa-delta--flat">≈</span>;
  return diff > 0
    ? <span className="aa-delta aa-delta--up">▲ {playTime(diff)}</span>
    : <span className="aa-delta aa-delta--down">▼ {playTime(-diff)}</span>;
}

function GameCard({ g, now, spark, onOpen }: {
  g: OverviewGame; now: number; spark?: Array<[number, number]>; onOpen: (id: string) => void;
}) {
  return (
    <button className="aa-card" onClick={() => onOpen(g.id)}>
      <div className="aa-card__name">
        {g.name}
        <HealthDots g={g} now={now} />
        {spark && <Spark points={spark} />}
      </div>
      <div className="aa-card__row">
        <span>T+{g.current_tick}</span>
        <span>{Math.round(g.tick_interval_ms / 60000)} min/tick</span>
        <span>{g.humans} human{g.humans === 1 ? '' : 's'} / {g.factions} factions</span>
      </div>
      <div className="aa-card__row aa-card__row--dim">
        <span>last action {ago(now, g.last_action_ms)}</span>
        <span>{g.actions_14d} actions·14d</span>
        {g.victory_type && <span>won by {g.victory_type}</span>}
      </div>
    </button>
  );
}

// ---------- per-game detail ----------

function GameDetail({
  gameId, onBack, onEnterRoom,
}: { gameId: string; onBack: () => void; onEnterRoom: (id: string) => void }) {
  const [data, setData] = useState<GameAnalytics | null>(null);
  const [metric, setMetric] = useState<Metric>('gold');
  // stock = balances; flow = per-tick delta (income minus spend), the
  // economy-balancing lens.
  const [mode, setMode] = useState<'stock' | 'flow' | 'share'>('stock');

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const res = await apiFetch<GameAnalytics>(`/api/admin/games/${gameId}/analytics`);
      if (dead) return;
      // A failed poll must SAY so - this view once spun forever on a
      // server 500 and read as "loading" instead of "broken".
      if (res.ok) { setData(res.data); setLoadError(null); }
      else setLoadError(`Analytics failed to load (HTTP ${res.status}). Retrying in 30s.`);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { dead = true; clearInterval(t); };
  }, [gameId]);

  if (!data) {
    return (
      <div className="aa-root">
        <button className="aa-btn" onClick={onBack}>← All games</button>
        <div className="aa-empty">{loadError ?? 'Loading game analytics…'}</div>
      </div>
    );
  }
  const { now, game, factions } = data;
  const DAY = 86_400_000;
  // Factions whose human hasn't been seen in 3+ days: their flat curves
  // are absences, not play styles - dim + dash them on the chart.
  const idleFactions = new Set(
    data.engagement
      .filter(e => e.last_seen_ms == null || now - e.last_seen_ms > 3 * DAY)
      .map(e => e.faction_id),
  );

  return (
    <div className="aa-root">
      <div className="aa-detail-head">
        <button className="aa-btn" onClick={onBack}>← All games</button>
        <div className="aa-detail-title">{game.name}</div>
        <div className="aa-detail-sub">
          T+{game.current_tick} · {game.status}
          {game.victory_type ? ` · won by ${game.victory_type}` : ''}
        </div>
        {/* Opens the normal room view — as a member you resume; games
            you don't belong to still open their lobby/spectate page. */}
        <button className="aa-btn aa-btn--primary" onClick={() => onEnterRoom(game.id)}>
          Open game →
        </button>
      </div>

      <section>
        <AlertsFeed data={data} idleFactions={idleFactions} />
      </section>

      <section>
        <div className="aa-section-title">
          EMPIRE YIELD CURVES
          <span className="aa-metric-tabs">
            {METRICS.map(m => (
              <button
                key={m}
                className={`aa-chip ${metric === m ? 'is-active' : ''}`}
                onClick={() => setMetric(m)}
              >{m}</button>
            ))}
          </span>
        </div>
        <div className="aa-metric-tabs" style={{ marginBottom: 8 }}>
          <button className={`aa-chip ${mode === 'stock' ? 'is-active' : ''}`} onClick={() => setMode('stock')}>stockpile</button>
          <button className={`aa-chip ${mode === 'flow' ? 'is-active' : ''}`} onClick={() => setMode('flow')}>per-tick flow</button>
          <button className={`aa-chip ${mode === 'share' ? 'is-active' : ''}`} onClick={() => setMode('share')}>share of economy</button>
        </div>
        <YieldChart curves={data.curves} factions={factions} metric={metric} mode={mode} idleFactionIds={idleFactions} />
      </section>

      <section>
        <div className="aa-section-title">FACTIONS · NOW</div>
        <div className="aa-scroll-x">
          <table className="aa-table">
            <thead>
              <tr>
                <th>Faction</th><th>Player</th><th>Metal</th><th>Fuel</th><th>Gold</th>
                <th>Science</th><th>Ships</th><th>Cities</th><th>Techs</th><th>Rep</th>
              </tr>
            </thead>
            <tbody>
              {factions.map(f => (
                <tr key={f.id} className={f.status !== 'active' ? 'aa-row--dead' : ''}>
                  <td><span className="aa-dot" style={{ background: f.color }} />{f.name}</td>
                  <td>{f.player_name ?? 'AI'}</td>
                  <td>{f.metal}</td><td>{f.fuel}</td><td>{f.gold}</td><td>{f.science}</td>
                  <td>{f.ships}</td><td>{f.settlements}</td><td>{f.techs_completed}</td>
                  <td>{f.reputation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="aa-section-title">FEATURE USAGE</div>
        <UsageBars usage={data.usage} />
      </section>

      <section>
        <div className="aa-section-title">CLIENT PERFORMANCE · CLICK → PIXELS · 7D</div>
        <PerfTable rows={data.perf ?? []} />
      </section>

      <section>
        <div className="aa-section-title">ANIMATION / FRAME RATE · 7D</div>
        <RenderTable rows={data.render ?? []} />
      </section>

      <section>
        <div className="aa-section-title">RUNAWAY-LEADER SCORE · SHARE OF ECONOMY + FLEET</div>
        <RunawayChart data={data} />
      </section>

      <section>
        <div className="aa-section-title">SPEND BY CATEGORY</div>
        <SpendTable data={data} />
      </section>

      <section>
        <div className="aa-section-title">PLAYER ACTIVITY · LAST 14 DAYS</div>
        <TimelineStrips data={data} />
      </section>

      <section>
        <div className="aa-section-title">TECH PACE</div>
        <TechPace data={data} />
      </section>

      <section>
        <div className="aa-section-title">COMBAT LEDGER</div>
        <CombatLedger data={data} />
      </section>

      <section>
        <div className="aa-section-title">COMBAT V2 — THE EXCHANGE</div>
        <CombatV2Panel data={data} />
      </section>

      <section>
        <div className="aa-section-title">MVP AWARDS</div>
        <CombatAwards data={data} />
      </section>

      <section>
        <div className="aa-section-title">COMBAT DEEP DIVE</div>
        <CombatDeepDive data={data} />
      </section>

      <section>
        <div className="aa-section-title">LOADOUTS · ALIVE VS LOST</div>
        <LoadoutTable data={data} />
      </section>

      <section>
        <div className="aa-section-title">SHIP CLASSES · BUILT VS LOST</div>
        <ShipClassBars data={data} />
      </section>

      <section>
        <div className="aa-section-title">SENATE PARTICIPATION</div>
        <SenateTable data={data} />
      </section>

      <section>
        <div className="aa-section-title">TRADE &amp; DIPLOMACY</div>
        <TradeTable data={data} />
      </section>

      <section>
        <div className="aa-section-title">FEATURE FUNNELS</div>
        <Funnels usage={data.usage} />
      </section>

      <section>
        <div className="aa-section-title">SESSION DROP-OFF · LAST ACTION BEFORE GOING IDLE</div>
        <Dropoff rows={data.dropoff} />
      </section>

      <section>
        <div className="aa-section-title">PLAYER ENGAGEMENT</div>
        <table className="aa-table">
          <thead>
            <tr><th>Player</th><th>Faction</th><th>Logins·14d</th><th>Time in game·14d</th><th>Active days</th><th>Actions·14d</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {data.engagement.map(e => (
              <tr key={e.id}>
                <td>{e.display_name}</td>
                <td><span className="aa-dot" style={{ background: e.color }} />{e.faction_name}</td>
                <td>{e.sessions_14d}</td>
                <td>{playTime(e.minutes_14d)}</td>
                <td>{e.active_days_14d}</td>
                <td>{e.actions_14d}</td>
                <td>{ago(now, e.last_seen_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------- charts ----------

// One SVG polyline per faction, faction-colored, shared y-scale so the
// curves are directly comparable (the whole point: who is out-yielding
// whom, and when did the gap open).
function YieldChart({
  curves, factions, metric, mode = 'stock', idleFactionIds,
}: {
  curves: CurvePoint[]; factions: FactionRow[]; metric: Metric;
  mode?: 'stock' | 'flow' | 'share'; idleFactionIds?: Set<string>;
}) {
  const W = 720, H = 220, PAD = 34;

  const series = useMemo(() => {
    const byFaction = new Map<string, Array<[number, number]>>();
    for (const p of curves) {
      let arr = byFaction.get(p.faction_id);
      if (!arr) { arr = []; byFaction.set(p.faction_id, arr); }
      arr.push([p.tick_number, p[metric]]);
    }
    if (mode === 'flow') {
      // Per-tick delta between consecutive samples. Points are already
      // tick-ordered; divide by the tick gap so downsampled curves
      // still read as "per tick", not "per sample".
      byFaction.forEach((arr, k) => {
        const out: Array<[number, number]> = [];
        for (let i = 1; i < arr.length; i++) {
          const dt = arr[i][0] - arr[i - 1][0];
          if (dt > 0) out.push([arr[i][0], Math.round(((arr[i][1] - arr[i - 1][1]) / dt) * 10) / 10]);
        }
        byFaction.set(k, out);
      });
    }
    return byFaction;
  }, [curves, metric, mode]);

  const [maxTick, maxVal, minVal] = useMemo(() => {
    let mt = 1, mv = 1, mn = 0;
    series.forEach(arr => {
      for (const [t, v] of arr) { if (t > mt) mt = t; if (v > mv) mv = v; if (v < mn) mn = v; }
    });
    return [mt, mv, mn];
  }, [series]);

  if (curves.length === 0) {
    return (
      <div className="aa-empty">
        No curve data yet — metrics record from each tick after the
        analytics release, so history starts accruing now.
      </div>
    );
  }

  const span = Math.max(1, maxVal - minVal);
  const x = (t: number) => PAD + (t / maxTick) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - minVal) / span) * (H - PAD * 2);

  return (
    <div className="aa-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="aa-chart" preserveAspectRatio="none">
        {[0, 0.5, 1].map(f => {
          const v = minVal + span * f;
          return (
            <g key={f}>
              <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} className="aa-grid" />
              <text x={4} y={y(v) + 4} className="aa-axis">{Math.round(v)}</text>
            </g>
          );
        })}
        {minVal < 0 && <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} className="aa-grid" style={{ strokeDasharray: '4 3' }} />}
        <text x={W - PAD} y={H - 8} className="aa-axis" textAnchor="end">T+{maxTick}</text>
        {mode !== 'share' && factions.map(f => {
          const pts = series.get(f.id);
          if (!pts || pts.length === 0) return null;
          const idle = idleFactionIds?.has(f.id);
          return (
            <polyline
              key={f.id}
              points={pts.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
              fill="none"
              stroke={f.color}
              strokeWidth={2}
              strokeDasharray={idle ? '3 4' : undefined}
              opacity={f.status !== 'active' ? 0.3 : idle ? 0.4 : 1}
            />
          );
        })}
        {mode === 'share' && (() => {
          // 100%-stacked bands: who OWNS the economy. Build per-tick
          // totals, then cumulative bands in faction order.
          const ticks = [...new Set(curves.map(c => c.tick_number))].sort((m, n) => m - n);
          const byTick = new Map(ticks.map(t => [t, new Map<string, number>()]));
          for (const c of curves) byTick.get(c.tick_number)!.set(c.faction_id, Math.max(0, c[metric]));
          const totals = new Map(ticks.map(t => {
            let sum = 0;
            byTick.get(t)!.forEach(v => { sum += v; });
            return [t, Math.max(1, sum)];
          }));
          const yShare = (v: number) => H - PAD - v * (H - PAD * 2);
          const cum = new Map(ticks.map(t => [t, 0]));
          return factions.map(f => {
            const lower = ticks.map(t => [t, cum.get(t)!] as [number, number]);
            const upper = ticks.map(t => {
              const next = cum.get(t)! + (byTick.get(t)!.get(f.id) ?? 0) / totals.get(t)!;
              cum.set(t, next);
              return [t, next] as [number, number];
            });
            const path = [
              ...upper.map(([t, v]) => `${x(t)},${yShare(v)}`),
              ...lower.reverse().map(([t, v]) => `${x(t)},${yShare(v)}`),
            ].join(' ');
            return <polygon key={f.id} points={path} fill={f.color} opacity={0.55} stroke="none" />;
          });
        })()}
      </svg>
      <div className="aa-legend">
        {factions.map(f => (
          <span key={f.id} className="aa-legend__item" style={{ opacity: idleFactionIds?.has(f.id) ? 0.55 : 1 }}>
            <span className="aa-dot" style={{ background: f.color }} />
            {f.name}{f.player_name ? ` (${f.player_name})` : ''}
            {idleFactionIds?.has(f.id) ? ' · idle' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// Shared: resolve a faction id to name+color chip.
function FactionChip({ id, factions }: { id: string | null; factions: FactionRow[] }) {
  const f = factions.find(x => x.id === id);
  if (!f) return <span>{id === 'system' ? 'System' : (id ?? 'Unknown')}</span>;
  return <span><span className="aa-dot" style={{ background: f.color }} />{f.name}</span>;
}

// Research cost curve - MUST mirror worker/room.js TECH_DEFS:
// stepping to level n costs 15 * n^1.72, so total cost to reach L is the
// partial sum. This is what makes pace comparable across tech levels.
function costToLevel(level: number): number {
  let total = 0;
  for (let n = 1; n <= level; n++) total += 15 * Math.pow(n, 1.72);
  return total;
}
const TRACK_ABBR: Record<string, string> = {
  armor: 'AR', construction: 'CO', industry: 'IN',
  propulsion: 'PR', sensors: 'SE', weapons: 'WE',
};

// Cost-weighted research speed per faction: total science cost of every
// level reached, divided by the game clock everyone shares.
function researchThroughput(data: GameAnalytics): Map<string, { cost: number; levels: number }> {
  const out = new Map<string, { cost: number; levels: number }>();
  for (const t of data.techDetail) {
    let agg = out.get(t.faction_id);
    if (!agg) { agg = { cost: 0, levels: 0 }; out.set(t.faction_id, agg); }
    agg.cost += costToLevel(t.level);
    agg.levels += t.level;
  }
  return out;
}

function TechPace({ data }: { data: GameAnalytics }) {
  if (data.techDetail.length === 0) return <div className="aa-empty">No research yet.</div>;
  const ticks = Math.max(1, data.game.current_tick);
  const thru = researchThroughput(data);
  const rows = data.factions
    .filter(f => thru.has(f.id))
    .map(f => ({ f, levels: thru.get(f.id)!.levels, rate: thru.get(f.id)!.cost / ticks }))
    .sort((x, y) => y.rate - x.rate);
  const maxRate = Math.max(...rows.map(r => r.rate), 0.001);
  const byFactionTrack = new Map(
    data.techDetail.map(t => [`${t.faction_id}:${t.tech_id}`, t]));
  const tracks = Object.keys(TRACK_ABBR);
  return (
    <div>
      <div className="aa-axis" style={{ padding: '0 2px 8px', fontSize: 11 }}>
        Speed is cost-weighted (level n costs 15·n^1.72 science), so one
        level-8 counts like ~35 level-1s - fair across different tech heights.
      </div>
      <div className="aa-bars">
        {rows.map(({ f, rate, levels }) => (
          <div key={f.id} className="aa-bar-row">
            <span className="aa-bar-label"><FactionChip id={f.id} factions={data.factions} /></span>
            <span className="aa-bar-track">
              <span className="aa-bar-fill" style={{ width: `${(rate / maxRate) * 100}%` }} />
            </span>
            <span className="aa-bar-num">
              {rate.toFixed(1)} sci/tick <em>· {levels} levels</em>
            </span>
          </div>
        ))}
      </div>
      <div className="aa-scroll-x" style={{ marginTop: 12 }}>
        <table className="aa-table">
          <thead>
            <tr>
              <th>Faction</th>
              {tracks.map(t => <th key={t} title={t}>{TRACK_ABBR[t]}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f }) => (
              <tr key={f.id}>
                <td><FactionChip id={f.id} factions={data.factions} /></td>
                {tracks.map(t => {
                  const row = byFactionTrack.get(`${f.id}:${t}`);
                  const lv = row?.level ?? 0;
                  const researching = row?.status === 'researching';
                  return (
                    <td key={t} title={`${t} level ${lv}${researching ? ' (researching)' : ''}`}>
                      {lv > 0 || researching ? (
                        <span style={{
                          color: researching ? '#c9a84c' : '#cdd9e4',
                          fontWeight: lv >= 6 ? 700 : 400,
                        }}>{lv}{researching ? '*' : ''}</span>
                      ) : <span style={{ color: '#4a5a6c' }}>-</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="aa-axis" style={{ padding: '4px 2px', fontSize: 10.5 }}>
          * = researching now · bold = level 6+
        </div>
      </div>
    </div>
  );
}

function CombatLedger({ data }: { data: GameAnalytics }) {
  const n = (rows: FactionCount[], id: string) => rows.find(r => r.faction_id === id)?.n ?? 0;
  const ids = new Set<string>();
  data.combat.losses.forEach(r => { if (r.faction_id) ids.add(r.faction_id); });
  data.combat.kills.forEach(r => { if (r.faction_id) ids.add(r.faction_id); });
  data.combat.settlements_lost.forEach(r => { if (r.faction_id) ids.add(r.faction_id); });
  if (ids.size === 0) return <div className="aa-empty">No combat yet.</div>;
  const rows = [...ids].sort((x, y) => n(data.combat.kills, y) - n(data.combat.kills, x));
  // Mirror bars: losses grow LEFT (red), kills grow RIGHT (teal).
  // A faction feeding ships into a grinder reads as a lopsided red wing.
  const max = Math.max(1, ...rows.map(id => Math.max(n(data.combat.kills, id), n(data.combat.losses, id))));
  return (
    <div className="aa-mirror">
      <div className="aa-mirror__head">
        <span>ships lost</span><span /><span>kills</span>
      </div>
      {rows.map(id => {
        const k = n(data.combat.kills, id);
        const l = n(data.combat.losses, id);
        const razed = n(data.combat.settlements_lost, id);
        return (
          <div key={id} className="aa-mirror__row">
            <div className="aa-mirror__left">
              <span className="aa-mirror__num">{l}</span>
              <span className="aa-mirror__bar aa-mirror__bar--loss" style={{ width: `${(l / max) * 100}%` }} />
            </div>
            <div className="aa-mirror__label">
              <FactionChip id={id} factions={data.factions} />
              {razed > 0 && <span className="aa-mirror__razed"> · {razed} cities lost</span>}
            </div>
            <div className="aa-mirror__right">
              <span className="aa-mirror__bar aa-mirror__bar--kill" style={{ width: `${(k / max) * 100}%` }} />
              <span className="aa-mirror__num">{k}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * COMBAT V2 telemetry. The balance work behind the rework measured volleys,
 * hits, damage and kills per matchup across ~990k simulated battles; this is
 * the same view on real games.
 *
 * The headline column is OBSERVED vs PREDICTED hit rate. The model claims a
 * corvette hits a destroyer 88.9% of the time — this is where that claim
 * either holds up or does not. A pairing that drifts wide of prediction with
 * a healthy sample size is either a bug in the roll or a stat that moved
 * without the table being updated.
 */
function CombatV2Panel({ data }: { data: GameAnalytics }) {
  const rows = data.combat.tally ?? [];
  if (rows.length === 0) {
    return (
      <div className="aa-empty">
        No shot data yet — the tally starts filling on the next tick with combat in it.
      </div>
    );
  }

  const totalVolleys = rows.reduce((a, r) => a + r.volleys, 0);
  const totalHits = rows.reduce((a, r) => a + r.hits, 0);
  const totalDamage = rows.reduce((a, r) => a + r.damage, 0);

  // per attacker class
  const byAttacker = new Map<string, { volleys: number; hits: number; damage: number; kills: number }>();
  for (const r of rows) {
    let e = byAttacker.get(r.attacker_class);
    if (!e) { e = { volleys: 0, hits: 0, damage: 0, kills: 0 }; byAttacker.set(r.attacker_class, e); }
    e.volleys += r.volleys; e.hits += r.hits; e.damage += r.damage; e.kills += r.kills;
  }
  const attackers = CLASS_ORDER.filter(c => byAttacker.has(c));
  const defenders = CLASS_ORDER.filter(c => rows.some(r => r.target_class === c));
  const cell = (a: string, d: string) => rows.find(r => r.attacker_class === a && r.target_class === d);

  // A pairing is only worth judging once it has enough shots to mean anything.
  const MIN_SAMPLE = 40;

  return (
    <div className="aa-v2">
      <div className="aa-v2__top">
        <div className="aa-v2__stat">
          <span className="aa-v2__num">{totalVolleys.toLocaleString()}</span>
          <span className="aa-v2__lbl">shots fired</span>
        </div>
        <div className="aa-v2__stat">
          <span className="aa-v2__num">
            {totalVolleys ? ((100 * totalHits) / totalVolleys).toFixed(1) : '0'}%
          </span>
          <span className="aa-v2__lbl">landed</span>
        </div>
        <div className="aa-v2__stat">
          <span className="aa-v2__num">{Math.round(totalDamage).toLocaleString()}</span>
          <span className="aa-v2__lbl">damage dealt</span>
        </div>
        <div className="aa-v2__stat">
          <span className="aa-v2__num">
            {totalHits ? Math.round(totalDamage / totalHits) : 0}
          </span>
          <span className="aa-v2__lbl">per hit</span>
        </div>
      </div>

      <div className="aa-v2__sub">Observed hit rate vs the model's prediction</div>
      <div className="aa-v2__scroll">
        <table className="aa-v2__matrix">
          <thead>
            <tr>
              <th />
              {defenders.map(d => <th key={d}>vs {d.slice(0, 4)}</th>)}
            </tr>
          </thead>
          <tbody>
            {attackers.map(a => (
              <tr key={a}>
                <th>{a}</th>
                {defenders.map(d => {
                  const c = cell(a, d);
                  if (!c || c.volleys === 0) return <td key={d} className="aa-v2__na">—</td>;
                  const obs = c.hits / c.volleys;
                  const pred = predictedHit(a, d);
                  const thin = c.volleys < MIN_SAMPLE;
                  const drift = pred == null ? 0 : (obs - pred) * 100;
                  const off = !thin && Math.abs(drift) > 8;
                  return (
                    <td key={d} className={off ? 'aa-v2__off' : undefined}
                        title={`${c.volleys} shots, ${c.hits} hits, ${Math.round(c.damage)} damage, ${c.kills} kills`}>
                      <span className="aa-v2__obs">{(100 * obs).toFixed(0)}%</span>
                      {pred != null && (
                        <span className={thin ? 'aa-v2__pred aa-v2__thin' : 'aa-v2__pred'}>
                          {thin ? `n=${c.volleys}` : `pred ${(100 * pred).toFixed(0)}%`}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="aa-v2__sub">Per class</div>
      <div className="aa-v2__scroll">
        <table className="aa-v2__matrix aa-v2__perclass">
          <thead>
            <tr><th>class</th><th>shots</th><th>hit%</th><th>damage</th><th>dmg/shot</th><th>kills</th></tr>
          </thead>
          <tbody>
            {attackers.map(a => {
              const e = byAttacker.get(a)!;
              return (
                <tr key={a}>
                  <th>{a}</th>
                  <td>{e.volleys.toLocaleString()}</td>
                  <td>{e.volleys ? ((100 * e.hits) / e.volleys).toFixed(1) : '0'}%</td>
                  <td>{Math.round(e.damage).toLocaleString()}</td>
                  <td>{e.volleys ? (e.damage / e.volleys).toFixed(1) : '0'}</td>
                  <td>{e.kills}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="aa-v2__foot">
        Kills credit every class that landed on a hull the tick it died — damage
        resolves simultaneously, so there is no single killing blow. Pairings
        under {MIN_SAMPLE} shots show their sample size instead of a verdict.
        A cell more than 8 points off prediction is flagged.
      </div>
    </div>
  );
}

/**
 * MVP AWARDS — the battle's named performers.
 *
 * Per-class tallies can tell you a destroyer is efficient; only the
 * per-hull record (migration 0069) can tell you WHICH destroyer, and a
 * name is what players actually remember. Each award states its own
 * criterion, because an unexplained superlative invites arguments about
 * what it measured.
 *
 * Minimum samples exist so a hull that fired twice and got lucky doesn't
 * outrank one that fought all game.
 */
function CombatAwards({ data }: { data: GameAnalytics }) {
  const rows = data.combat.ship_stats ?? [];
  if (rows.length === 0) {
    return <div className="aa-empty">No per-ship records yet — awards fill in as hulls fight.</div>;
  }

  const label = (r: ShipStatRow) =>
    `${r.ship_name ?? 'Unnamed'}${r.alive ? '' : ' †'}`;
  const sub = (r: ShipStatRow) => r.ship_class ?? 'ship';

  type Award = {
    key: string; title: string; blurb: string;
    winner?: ShipStatRow; value: string;
  };
  const best = (
    pool: ShipStatRow[],
    score: (r: ShipStatRow) => number,
  ): ShipStatRow | undefined => {
    let top: ShipStatRow | undefined;
    let topScore = -Infinity;
    for (const r of pool) {
      const v = score(r);
      if (v > topScore) { topScore = v; top = r; }
    }
    return topScore > 0 ? top : undefined;
  };

  const MIN_SHOTS = 20;
  const shooters = rows.filter(r => r.shots >= MIN_SHOTS);
  const targets = rows.filter(r => r.shots_taken >= MIN_SHOTS);

  const ace = best(rows, r => r.kills);
  const breaker = best(rows, r => r.damage_dealt);
  const anvil = best(rows.filter(r => r.alive === 1), r => r.damage_taken);
  const untouchable = targets.length
    ? targets.reduce((a, b) =>
      (a.hits_taken / a.shots_taken) <= (b.hits_taken / b.shots_taken) ? a : b)
    : undefined;
  const executioner = best(shooters.filter(r => r.kills > 0), r => r.kills / Math.max(1, r.hits));
  const sponge = best(rows, r => r.damage_absorbed);
  const lastStand = best(rows, r => r.low_hp_kills);
  const wasteful = best(shooters, r => r.overkill);

  const awards: Award[] = [
    { key: 'ace', title: 'ACE', blurb: 'most kills',
      winner: ace, value: ace ? `${ace.kills} kills` : '—' },
    { key: 'breaker', title: 'SHIPBREAKER', blurb: 'most damage dealt',
      winner: breaker, value: breaker ? `${Math.round(breaker.damage_dealt).toLocaleString()} dmg` : '—' },
    { key: 'anvil', title: 'ANVIL', blurb: 'most damage survived',
      winner: anvil, value: anvil ? `${Math.round(anvil.damage_taken).toLocaleString()} taken` : '—' },
    { key: 'untouchable', title: 'UNTOUCHABLE', blurb: `hardest to hit (min ${MIN_SHOTS} shots at it)`,
      winner: untouchable,
      value: untouchable
        ? `${Math.round(100 * untouchable.hits_taken / untouchable.shots_taken)}% hit`
        : '—' },
    { key: 'executioner', title: 'EXECUTIONER', blurb: 'most kills per landed hit',
      winner: executioner,
      value: executioner
        ? `${(executioner.kills / Math.max(1, executioner.hits)).toFixed(2)} per hit`
        : '—' },
    { key: 'sponge', title: 'BULWARK', blurb: 'most damage soaked by its parts',
      winner: sponge, value: sponge ? `${Math.round(sponge.damage_absorbed).toLocaleString()} absorbed` : '—' },
    { key: 'laststand', title: 'LAST STAND', blurb: 'kills landed below 25% HP',
      winner: lastStand, value: lastStand ? `${lastStand.low_hp_kills} kills` : '—' },
    { key: 'wasteful', title: 'TRIGGER HAPPY', blurb: 'most damage wasted on already-dead hulls',
      winner: wasteful, value: wasteful ? `${Math.round(wasteful.overkill).toLocaleString()} wasted` : '—' },
  ];

  return (
    <>
      <div className="aa-awards">
        {awards.filter(a => a.winner).map(a => (
          <div className="aa-award" key={a.key}>
            <div className="aa-award__title">{a.title}</div>
            <div className="aa-award__name">{label(a.winner!)}</div>
            <div className="aa-award__meta">
              <span className="aa-award__cls">{sub(a.winner!)}</span>
              <span className="aa-award__val">{a.value}</span>
            </div>
            <div className="aa-award__blurb">{a.blurb}</div>
          </div>
        ))}
      </div>
      <div className="aa-v2__foot">
        † hull destroyed — the record outlives the ship. Awards read every
        hull that has ever fired or been fired on in this game.
      </div>
    </>
  );
}

/** The questions the tally can answer beyond the hit matrix: what
 *  defences are worth, what is wasted, and how fights actually run. */
function CombatDeepDive({ data }: { data: GameAnalytics }) {
  const tally = data.combat.tally ?? [];
  const battles = data.combat.battles;
  const econ = data.combat.economy;
  const caps = data.combat.captains;
  const ret = data.combat.retreats;
  const det = data.combat.detonations;
  const pri = data.combat.priority;

  const rawTotal = tally.reduce((a, r) => a + (r.damage_raw ?? 0), 0);
  const landed = tally.reduce((a, r) => a + r.damage, 0);
  const absorbed = Math.max(0, rawTotal - landed);
  const absorbedPct = rawTotal > 0 ? (100 * absorbed) / rawTotal : 0;
  const overkill = tally.reduce((a, r) => a + (r.overkill ?? 0), 0);
  const overkillPct = landed > 0 ? (100 * overkill) / landed : 0;

  const repaired = econ?.hp_repaired ?? 0;
  const destroyed = econ?.hp_destroyed ?? 0;
  const healRatio = destroyed > 0 ? repaired / destroyed : 0;

  const rescuePct = caps && (caps.lost + caps.rescued) > 0
    ? (100 * caps.rescued) / (caps.lost + caps.rescued)
    : 0;
  const retreatPct = ret && ret.fired > 0 ? (100 * ret.saved) / ret.fired : 0;
  const customPct = pri && pri.armed > 0 ? (100 * pri.custom) / pri.armed : 0;

  const stat = (
    label: string, value: string, note: string, tone?: 'good' | 'warn',
  ) => (
    <div className={`aa-dd${tone ? ` aa-dd--${tone}` : ''}`} key={label}>
      <div className="aa-dd__val">{value}</div>
      <div className="aa-dd__label">{label}</div>
      <div className="aa-dd__note">{note}</div>
    </div>
  );

  return (
    <div className="aa-dd-grid">
      {stat('ABSORBED BY DEFENCES', `${absorbedPct.toFixed(0)}%`,
        `${Math.round(absorbed).toLocaleString()} of ${Math.round(rawTotal).toLocaleString()} fired never landed. This is what shields and armor are buying.`,
        absorbedPct >= 20 ? 'good' : undefined)}
      {stat('OVERKILL', `${overkillPct.toFixed(0)}%`,
        `${Math.round(overkill).toLocaleString()} damage landed on hulls already dead that tick. Simultaneous resolution makes some waste unavoidable.`,
        overkillPct >= 25 ? 'warn' : undefined)}
      {stat('REPAIR vs DESTRUCTION', healRatio > 0 ? `${healRatio.toFixed(2)}×` : '—',
        `${Math.round(repaired).toLocaleString()} HP repaired against ${Math.round(destroyed).toLocaleString()} destroyed. Above 1.0 means yards outpace the guns.`,
        healRatio >= 1 ? 'warn' : undefined)}
      {battles && stat('BATTLE LENGTH', battles.count ? `${battles.avg_ticks.toFixed(1)}t` : '—',
        `${battles.count} engagements, longest ${battles.longest} ticks, ${battles.avg_deaths.toFixed(1)} deaths each. ${battles.decisive} ended in a kill.`)}
      {caps && stat('CAPTAIN RESCUE RATE', `${rescuePct.toFixed(0)}%`,
        `${caps.rescued} recovered, ${caps.lost} lost for good. ${caps.active} active (${caps.banked} benched), top rank ${caps.top_rank}.`,
        rescuePct < 30 ? 'warn' : undefined)}
      {ret && stat('RETREAT SURVIVAL', ret.fired ? `${retreatPct.toFixed(0)}%` : '—',
        `${ret.saved} of ${ret.fired} auto-retreating hulls are still alive. Near 100% means the threshold is generous.`)}
      {det && stat('DETONATIONS', `${det.count}`,
        `${Math.round(det.damage).toLocaleString()} damage, ${det.kills} hulls destroyed — ${det.count ? (det.kills / det.count).toFixed(2) : '0'} kills per hull spent.`)}
      {pri && stat('CUSTOM TARGETING', `${customPct.toFixed(0)}%`,
        `${pri.custom} of ${pri.armed} armed hulls override AUTO. Low adoption means the cards are not earning their complexity.`)}
    </div>
  );
}

/** Which fits actually survive. Alive vs lost per (class, loadout). */
function LoadoutTable({ data }: { data: GameAnalytics }) {
  const rows = data.combat.loadouts ?? [];
  if (rows.length === 0) {
    return <div className="aa-empty">No loadout data yet — deaths recorded before this shipped carry no parts.</div>;
  }
  return (
    <div className="aa-v2__scroll">
      <table className="aa-v2__matrix aa-v2__perclass">
        <thead>
          <tr><th>class</th><th>loadout</th><th>alive</th><th>lost</th><th>survival</th></tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const total = r.alive + r.lost;
            const surv = total > 0 ? (100 * r.alive) / total : 0;
            return (
              <tr key={`${r.ship_class}|${r.loadout}`}>
                <th>{r.ship_class}</th>
                <th style={{ fontWeight: 400, color: '#9fb4c6' }}>{r.loadout}</th>
                <td>{r.alive}</td>
                <td>{r.lost}</td>
                <td className={surv < 40 && total >= 4 ? 'aa-v2__off' : undefined}>
                  {total >= 4 ? `${surv.toFixed(0)}%` : `n=${total}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ShipClassBars({ data }: { data: GameAnalytics }) {
  const alive = new Map(data.shipClasses.alive.map(r => [r.ship_class, r.n]));
  const lost = new Map(data.shipClasses.lost.map(r => [r.ship_class ?? 'unknown', r.n]));
  const classes = [...new Set([...alive.keys(), ...lost.keys()])];
  if (classes.length === 0) return <div className="aa-empty">No ships.</div>;
  const totalOf = (c: string) => (alive.get(c) ?? 0) + (lost.get(c) ?? 0);
  const max = Math.max(1, ...classes.map(totalOf));
  return (
    <div className="aa-bars">
      {classes.sort((x, y) => totalOf(y) - totalOf(x)).map(c => {
        const a = alive.get(c) ?? 0;
        const l = lost.get(c) ?? 0;
        return (
          <div key={c} className="aa-bar-row">
            <span className="aa-bar-label">{c}</span>
            <span className="aa-bar-track">
              <span className="aa-bar-fill" style={{ width: `${(a / max) * 100}%` }} />
              <span className="aa-bar-fill aa-bar-fill--lost" style={{ width: `${(l / max) * 100}%` }} />
            </span>
            <span className="aa-bar-num">{a} alive <em>- {l} lost</em></span>
          </div>
        );
      })}
    </div>
  );
}

function SenateTable({ data }: { data: GameAnalytics }) {
  const { senate } = data;
  if (senate.proposal_total === 0) return <div className="aa-empty">No senate proposals yet.</div>;
  const voteOf = (fid: string, kind: string) =>
    senate.votes.find(v => v.faction_id === fid && v.vote === kind)?.n ?? 0;
  const proposed = (fid: string) => senate.proposals.find(pr => pr.faction_id === fid)?.n ?? 0;
  return (
    <table className="aa-table">
      <thead><tr><th>Faction</th><th>Proposed</th><th>Yea</th><th>Nay</th><th>Abstain</th><th>No-shows</th></tr></thead>
      <tbody>
        {data.factions.filter(f => f.user_id).map(f => {
          const cast = voteOf(f.id, 'yea') + voteOf(f.id, 'nay') + voteOf(f.id, 'abstain');
          return (
            <tr key={f.id}>
              <td><FactionChip id={f.id} factions={data.factions} /></td>
              <td>{proposed(f.id)}</td>
              <td>{voteOf(f.id, 'yea')}</td>
              <td>{voteOf(f.id, 'nay')}</td>
              <td>{voteOf(f.id, 'abstain')}</td>
              <td>{Math.max(0, senate.proposal_total - cast)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TradeTable({ data }: { data: GameAnalytics }) {
  const { trade } = data;
  if (trade.routes.length === 0 && trade.offers.length === 0) {
    return <div className="aa-empty">No trade activity yet.</div>;
  }
  return (
    <div className="aa-card__row" style={{ gap: 20, flexWrap: 'wrap' }}>
      <div>
        <div className="aa-axis" style={{ fontSize: 11, marginBottom: 4 }}>Routes per faction</div>
        {trade.routes.map(r => (
          <div key={r.faction_id ?? 'x'} style={{ fontSize: 12.5, padding: '2px 0' }}>
            <FactionChip id={r.faction_id} factions={data.factions} /> - {r.n}
          </div>
        ))}
        {trade.routes.length === 0 && <div className="aa-empty">none</div>}
      </div>
      <div>
        <div className="aa-axis" style={{ fontSize: 11, marginBottom: 4 }}>Diplomatic offers</div>
        {trade.offers.map(o => (
          <div key={o.status} style={{ fontSize: 12.5, padding: '2px 0' }}>{o.status} - {o.n}</div>
        ))}
        {trade.offers.length === 0 && <div className="aa-empty">none</div>}
      </div>
    </div>
  );
}

// Funnels: "opened the menu" (ui/ events) vs "actually used the
// feature" (server mutations). A wide gap = discoverable but not
// compelling; both near zero = not discoverable at all.
const FUNNELS: Array<{ label: string; open: string; act: (k: string) => boolean }> = [
  { label: 'Fleets', open: 'ui/fleet-menu', act: k => k.includes('fleets') },
  { label: 'Senate', open: 'ui/senate', act: k => k.includes('senate') && !k.startsWith('ui/') },
  { label: 'Trade', open: 'ui/trades', act: k => (k.includes('trade') || k.includes('offers')) && !k.startsWith('ui/') },
  { label: 'Ship designer', open: 'ui/ship-designer', act: k => k.includes('build') || k.includes('designs') },
];

function Funnels({ usage }: { usage: UsageRow[] }) {
  const count = (pred: (k: string) => boolean) =>
    usage.filter(u => pred(u.kind)).reduce((acc, u) => acc + u.total, 0);
  const rows = FUNNELS.map(f => ({
    label: f.label,
    opened: count(k => k === f.open),
    acted: count(f.act),
  }));
  if (rows.every(r => r.opened === 0 && r.acted === 0)) {
    return <div className="aa-empty">No funnel data yet - UI opens record from the analytics v2 release.</div>;
  }
  return (
    <table className="aa-table">
      <thead><tr><th>Feature</th><th>Menu opened</th><th>Actions taken</th><th>Conversion</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>{r.opened}</td>
            <td>{r.acted}</td>
            <td>{r.opened ? `${Math.round((r.acted / r.opened) * 100)}%` : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Frame-rate health per player. fps_low1 (mean of the worst 1% of
// frames) matters more than the average: a 55fps average with 8fps
// stutters is what players describe as "animations slowing down".
// early/late compare the first 5 min of a session against 15+ min in —
// a big drop, especially alongside a climbing heap, is a LEAK rather
// than a slow machine, and those need opposite fixes.
function RenderTable({ rows }: { rows: RenderRow[] }) {
  if (rows.length === 0) {
    return <div className="aa-empty">No frame data yet — clients report once a minute of active play.</div>;
  }
  return (
    <div className="aa-scroll-x">
      <table className="aa-table">
        <thead>
          <tr>
            <th>Player</th><th>beats</th>
            <th>fps avg</th><th>1% low</th>
            <th>draw p95</th><th>long frames</th>
            <th>fps early→late</th><th>heap early→late</th>
            <th>ships</th><th>device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const degraded = r.fps_early > 0 && r.fps_late > 0 && r.fps_late < r.fps_early * 0.75;
            const leaking = r.heap_early > 0 && r.heap_late > r.heap_early * 1.5;
            return (
              <tr key={r.user_id}>
                <td>{r.display_name}</td>
                <td>{r.beats}</td>
                <td style={{ color: r.fps_avg < 30 ? '#ff6b6b' : '#cdd9e4' }}><b>{r.fps_avg}</b></td>
                <td style={{ color: r.fps_low1 < 15 ? '#ff6b6b' : '#cdd9e4' }}>{r.fps_low1}</td>
                <td style={{ color: r.draw_p95 > 16 ? '#ff6b6b' : '#cdd9e4' }}>{r.draw_p95} ms</td>
                <td>{r.long_frames}</td>
                <td style={{ color: degraded ? '#ff6b6b' : '#cdd9e4' }}>
                  {r.fps_early || '—'} → {r.fps_late || '—'}{degraded ? ' ⚠' : ''}
                </td>
                <td style={{ color: leaking ? '#ff6b6b' : '#8a9fb3' }}>
                  {r.heap_early ? `${r.heap_early}MB` : '—'} → {r.heap_late ? `${r.heap_late}MB` : '—'}
                  {leaking ? ' ⚠' : ''}
                </td>
                <td>{r.ships}</td>
                <td style={{ color: '#8a9fb3', fontSize: 11 }} title={r.gpu ?? r.ua}>
                  {r.gpu && /microsoft basic|swiftshader|llvmpipe|software/i.test(r.gpu) && (
                    <b style={{ color: '#ff6b6b' }}>⚠ SOFTWARE </b>
                  )}
                  {(r.gpu ?? '?').slice(0, 28)}{r.mobile ? ' · mobile' : ''}
                  {r.cores ? ` · ${r.cores}c` : ''}{r.dpr && r.dpr !== 1 ? ` · ${r.dpr}x` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Per-player click->pixels latency, reported by each client. p95, not
// average: the occasional 3-second stall is what a player remembers and
// complains about, and a mean buries it. Device columns are here so a
// slow report can be correlated with hardware instead of guessed at.
function PerfTable({ rows }: { rows: PerfRow[] }) {
  if (rows.length === 0) {
    return <div className="aa-empty">No samples yet — clients report one per 30s of active play.</div>;
  }
  const ms = (v: number, lim: number) => (
    <span style={{ color: v > lim ? '#ff6b6b' : '#cdd9e4' }}>{v}</span>
  );
  const browserOf = (ua: string) => {
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return '?';
  };
  return (
    <div className="aa-scroll-x">
      <table className="aa-table">
        <thead>
          <tr>
            <th>Player</th><th>n</th>
            <th>click→UI p50</th><th>p95</th>
            <th>map p95</th><th>paint p95</th><th>fetch p50</th>
            <th>frame</th><th>ships</th><th>device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.user_id}>
              <td>{r.display_name}</td>
              <td>{r.samples}</td>
              <td>{ms(r.total_p50, 800)}</td>
              <td><b>{ms(r.total_p95, 1500)}</b></td>
              <td>{ms(r.map_p95, 150)}</td>
              <td>{ms(r.paint_p95, 200)}</td>
              <td>{ms(r.fetch_p50, 500)}</td>
              <td>{ms(r.frame_p50, 40)} ms</td>
              <td>{r.ships}</td>
              <td style={{ color: '#8a9fb3', fontSize: 11 }}>
                {browserOf(r.ua)}{r.mobile ? ' · mobile' : ''}
                {r.cores ? ` · ${r.cores} cores` : ''}
                {r.mem_gb ? ` · ${r.mem_gb}GB` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- v3 components ----------

// Composite dominance: mean of a faction's share of (gold+metal) and
// share of ships, per tick. >40% = runaway leader; the balance alarm.
function runawayShares(data: GameAnalytics): Map<string, Array<[number, number]>> {
  const ticks = [...new Set(data.curves.map(c => c.tick_number))].sort((m, n) => m - n);
  const out = new Map<string, Array<[number, number]>>();
  for (const t of ticks) {
    const rows = data.curves.filter(c => c.tick_number === t);
    const ecoTotal = Math.max(1, rows.reduce((acc, r) => acc + r.gold + r.metal, 0));
    const shipTotal = Math.max(1, rows.reduce((acc, r) => acc + r.ships, 0));
    for (const r of rows) {
      const score = ((r.gold + r.metal) / ecoTotal + r.ships / shipTotal) / 2;
      let arr = out.get(r.faction_id);
      if (!arr) { arr = []; out.set(r.faction_id, arr); }
      arr.push([t, score]);
    }
  }
  return out;
}

function RunawayChart({ data }: { data: GameAnalytics }) {
  const series = runawayShares(data);
  if (series.size === 0) {
    return <div className="aa-empty">Needs curve history - accrues per tick.</div>;
  }
  const W = 720, H = 180, PAD = 34;
  let maxTick = 1;
  series.forEach(arr => { for (const [t] of arr) if (t > maxTick) maxTick = t; });
  const x = (t: number) => PAD + (t / maxTick) * (W - PAD * 2);
  const y = (v: number) => H - PAD - v * (H - PAD * 2);
  return (
    <div className="aa-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 180, display: 'block' }} preserveAspectRatio="none">
        {[0, 0.2, 0.4, 0.6].map(f => (
          <g key={f}>
            <line x1={PAD} x2={W - PAD} y1={y(f)} y2={y(f)} className="aa-grid" />
            <text x={4} y={y(f) + 4} className="aa-axis">{Math.round(f * 100)}%</text>
          </g>
        ))}
        <line x1={PAD} x2={W - PAD} y1={y(0.4)} y2={y(0.4)} stroke="#d06a75" strokeWidth={1} strokeDasharray="5 4" />
        {data.factions.map(f => {
          const pts = series.get(f.id);
          if (!pts || pts.length === 0) return null;
          return (
            <polyline
              key={f.id}
              points={pts.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
              fill="none" stroke={f.color} strokeWidth={2}
              opacity={f.status === 'active' ? 1 : 0.3}
            />
          );
        })}
      </svg>
      <div className="aa-axis" style={{ padding: '4px 6px', fontSize: 11 }}>
        Dashed red line = 40% dominance threshold.
      </div>
    </div>
  );
}

const SPEND_CATEGORIES = ['ships', 'buildings', 'colonies', 'captains'];

function SpendTable({ data }: { data: GameAnalytics }) {
  if (data.spend.length === 0) {
    return <div className="aa-empty">No spend logged yet - records per player action from the v3 release.</div>;
  }
  const cats = [...new Set([...SPEND_CATEGORIES, ...data.spend.map(r => r.category)])];
  const cell = (fid: string, cat: string) => {
    const r = data.spend.find(sp => sp.faction_id === fid && sp.category === cat);
    if (!r || (!r.metal && !r.gold)) return '-';
    return `${r.metal}M+${r.gold}C`;
  };
  const spenders = data.factions.filter(f =>
    data.spend.some(sp => sp.faction_id === f.id));
  if (spenders.length === 0) return <div className="aa-empty">No spend logged yet.</div>;
  return (
    <div className="aa-scroll-x">
      <table className="aa-table">
        <thead>
          <tr><th>Faction</th>{cats.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {spenders.map(f => (
            <tr key={f.id}>
              <td><FactionChip id={f.id} factions={data.factions} /></td>
              {cats.map(c => <td key={c}>{cell(f.id, c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One strip per player: 14 day-cells, intensity = minutes that day.
// Churn risk is visible as a strip fading to black.
function TimelineStrips({ data }: { data: GameAnalytics }) {
  if (data.engagement.length === 0) return <div className="aa-empty">No players.</div>;
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    days.push(new Date(data.now - i * 86_400_000).toISOString().slice(0, 10));
  }
  const byKey = new Map(data.timeline.map(t => [`${t.user_id}:${t.day}`, t.n]));
  const max = Math.max(1, ...data.timeline.map(t => t.n));
  return (
    <div className="aa-strips">
      {data.engagement.map(e => (
        <div key={e.id} className="aa-strip">
          <span className="aa-strip__name">
            <span className="aa-dot" style={{ background: e.color }} />{e.display_name}
          </span>
          <span className="aa-strip__cells">
            {days.map(d => {
              const n = byKey.get(`${e.id}:${d}`) ?? 0;
              return (
                <span
                  key={d}
                  className="aa-strip__cell"
                  title={`${d} - ${n} min`}
                  style={{ opacity: n ? 0.3 + 0.7 * (n / max) : 0.08 }}
                />
              );
            })}
          </span>
          <span className="aa-strip__total">{playTime(e.minutes_14d)}</span>
        </div>
      ))}
    </div>
  );
}

// The push layer: anomalies the queries can already detect, so the
// dashboard states what is wrong instead of waiting to be read.
function AlertsFeed({ data, idleFactions }: { data: GameAnalytics; idleFactions: Set<string> }) {
  const alerts: string[] = [];
  const nameOf = (fid: string | null) =>
    data.factions.find(f => f.id === fid)?.name ?? 'Unknown';

  // Runaway leader: latest composite share > 40%.
  const shares = runawayShares(data);
  let leaderFid: string | null = null;
  let leaderV = 0;
  shares.forEach((arr, fid) => {
    const last = arr[arr.length - 1];
    if (last && last[1] > leaderV) { leaderFid = fid; leaderV = last[1]; }
  });
  if (leaderFid && leaderV > 0.4) {
    alerts.push(`${nameOf(leaderFid)} controls ${Math.round(leaderV * 100)}% of the solar economy + fleet - runaway leader.`);
  }

  // Tech outlier, cost-weighted: total research cost achieved per tick.
  // Raw ticks-per-tech flagged an early quitter with three cheap
  // level-1s as "15x faster" than level-8 grinders - controlling for
  // level via the cost curve kills that false positive.
  const thru = researchThroughput(data);
  const ticksNow = Math.max(1, data.game.current_tick);
  const rates = [...thru.entries()]
    .map(([fid, v]) => ({ fid, rate: v.cost / ticksNow, levels: v.levels }))
    .filter(r => r.levels >= 6)
    .sort((x, y) => x.rate - y.rate);
  if (rates.length >= 3) {
    const median = rates[Math.floor(rates.length / 2)].rate;
    const fastest = rates[rates.length - 1];
    if (median > 0 && fastest.rate > median * 3) {
      alerts.push(`${nameOf(fastest.fid)} researches ${(fastest.rate / median).toFixed(1)}x faster than the median, cost-weighted (${fastest.rate.toFixed(1)} vs ${median.toFixed(1)} sci/tick).`);
    }
  }

  // Hull dominance.
  const totalAlive = data.shipClasses.alive.reduce((acc, r) => acc + r.n, 0);
  const top = data.shipClasses.alive[0];
  if (top && totalAlive >= 10 && top.n / totalAlive > 0.5) {
    alerts.push(`${top.ship_class}s are ${Math.round((top.n / totalAlive) * 100)}% of all hulls - class balance is off.`);
  }

  // Senate silence.
  if (data.senate.proposal_total === 0 && data.game.current_tick > 100) {
    alerts.push(`No senate proposal in ${data.game.current_tick} ticks - the senate is dead weight in this game.`);
  }

  // Player absence.
  for (const e of data.engagement) {
    if (e.last_seen_ms == null) continue;
    const days = Math.floor((data.now - e.last_seen_ms) / 86_400_000);
    if (days >= 7) alerts.push(`${e.display_name} (${e.faction_name}) hasn't logged in for ${days} days.`);
  }
  if (idleFactions.size > 0 && alerts.length === 0) {
    alerts.push(`${idleFactions.size} faction(s) idle 3+ days - curves dimmed on the chart.`);
  }

  if (alerts.length === 0) {
    return <div className="aa-alerts aa-alerts--ok">✓ No anomalies detected.</div>;
  }
  return (
    <div className="aa-alerts">
      {alerts.map((msg, i) => <div key={i} className="aa-alert">⚠ {msg}</div>)}
    </div>
  );
}

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

function MetaUsage({ rows }: { rows: Array<{ kind: string; total: number; games_used: number }> }) {
  if (rows.length === 0) return <div className="aa-empty">No actions logged anywhere yet.</div>;
  const unused = FEATURE_REGISTRY.filter(f => !rows.some(r => f.match(r.kind)));
  const max = Math.max(...rows.map(r => r.total));
  return (
    <div>
      {unused.length > 0 && (
        <div className="aa-alerts" style={{ marginBottom: 10 }}>
          <div className="aa-alert">⚠ No recorded use in any game (incl. backfilled history): {unused.map(f => f.label).join(', ')}.</div>
        </div>
      )}
      <div className="aa-bars">
        {rows.slice(0, 14).map(r => (
          <div key={r.kind} className="aa-bar-row">
            <span className="aa-bar-label" title={r.kind}>{labelForKind(r.kind)}</span>
            <span className="aa-bar-track">
              <span className="aa-bar-fill" style={{ width: `${(r.total / max) * 100}%` }} />
            </span>
            <span className="aa-bar-num">{r.total} <em>in {r.games_used} game{r.games_used === 1 ? '' : 's'}</em></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dropoff({ rows }: { rows: Array<{ kind: string; n: number }> }) {
  if (rows.length === 0) return <div className="aa-empty">No completed idle sessions logged yet.</div>;
  const max = Math.max(...rows.map(r => r.n));
  return (
    <div className="aa-bars">
      {rows.map(r => (
        <div key={r.kind} className="aa-bar-row">
          <span className="aa-bar-label" title={r.kind}>{labelForKind(r.kind)}</span>
          <span className="aa-bar-track">
            <span className="aa-bar-fill" style={{ width: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="aa-bar-num">{r.n}</span>
        </div>
      ))}
    </div>
  );
}

function UsageBars({ usage }: { usage: UsageRow[] }) {
  if (usage.length === 0) {
    return (
      <div className="aa-empty">
        No actions logged yet — feature usage records from each player
        action after the analytics release.
      </div>
    );
  }
  const max = Math.max(...usage.map(u => u.total));
  return (
    <div className="aa-bars">
      {usage.map(u => (
        <div key={u.kind} className="aa-bar-row">
          <span className="aa-bar-label" title={u.kind}>{labelForKind(u.kind)}</span>
          <span className="aa-bar-track">
            <span className="aa-bar-fill" style={{ width: `${(u.total / max) * 100}%` }} />
          </span>
          <span className="aa-bar-num">{u.total} <em>({u.last_14d} recent · {u.distinct_users} users)</em></span>
        </div>
      ))}
    </div>
  );
}
