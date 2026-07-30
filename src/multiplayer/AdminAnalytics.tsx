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
};
type OverviewPlayer = {
  id: string; display_name: string; email: string;
  sessions_14d: number; last_seen_ms: number | null;
  minutes_14d: number; active_days_14d: number;
};
type RetentionRow = {
  id: string; display_name: string; created_at: number;
  d1: boolean; d7: boolean; d14: boolean;
};
type Overview = {
  now: number; games: OverviewGame[]; players: OverviewPlayer[];
  retention: RetentionRow[]; hours_utc: number[];
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
  id: string; display_name: string; faction_name: string; color: string;
  sessions_14d: number; last_seen_ms: number | null;
  minutes_14d: number; active_days_14d: number; actions_14d: number;
};
type FactionCount = { faction_id: string | null; n: number };
type GameAnalytics = {
  now: number;
  game: OverviewGame & { winner_faction_id: string | null };
  factions: FactionRow[]; curves: CurvePoint[]; usage: UsageRow[]; engagement: EngagementRow[];
  techPace: Array<{ faction_id: string; completed: number; avg_ticks: number; last_completed_tick: number }>;
  combat: { losses: FactionCount[]; kills: FactionCount[]; settlements_lost: FactionCount[] };
  shipClasses: {
    alive: Array<{ ship_class: string; n: number }>;
    lost: Array<{ ship_class: string | null; n: number }>;
  };
  senate: { proposals: FactionCount[]; votes: Array<{ faction_id: string; vote: string; n: number }>; proposal_total: number };
  trade: { routes: FactionCount[]; offers: Array<{ status: string; n: number }> };
  dropoff: Array<{ kind: string; n: number }>;
};

const METRICS = ['metal', 'fuel', 'gold', 'science', 'ships', 'settlements'] as const;
type Metric = typeof METRICS[number];

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

function OverviewView({ data, onOpen }: { data: Overview; onOpen: (id: string) => void }) {
  const { now } = data;
  const live = data.games.filter(g => g.status === 'active');
  const done = data.games.filter(g => g.status !== 'active');
  return (
    <div className="aa-root">
      <section>
        <div className="aa-section-title">LIVE GAMES · {live.length}</div>
        <div className="aa-cards">
          {live.map(g => <GameCard key={g.id} g={g} now={now} onOpen={onOpen} />)}
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
        <div className="aa-section-title">PLAY HOURS · HEARTBEATS BY LOCAL HOUR · 14D</div>
        <HourHeatmap hoursUtc={data.hours_utc} />
      </section>
      <section>
        <div className="aa-section-title">NEW-PLAYER RETENTION · 28D COHORT</div>
        <RetentionTable rows={data.retention} now={now} />
      </section>
      <section>
        <div className="aa-section-title">PLAYERS · LAST 14 DAYS</div>
        <table className="aa-table">
          <thead>
            <tr><th>Player</th><th>Logins</th><th>Time in game</th><th>Active days</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {data.players.map(p => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.sessions_14d}</td>
                <td>{playTime(p.minutes_14d)}</td>
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

// 24 bars, relabeled from UTC to the viewer's local hours so "when do
// people play" reads in Lorne's own clock.
function HourHeatmap({ hoursUtc }: { hoursUtc: number[] }) {
  const offset = -new Date().getTimezoneOffset() / 60; // e.g. -7 for PDT
  const local = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    local[((h + offset) % 24 + 24) % 24] += hoursUtc[h] ?? 0;
  }
  const max = Math.max(1, ...local);
  const total = local.reduce((x, y) => x + y, 0);
  if (total === 0) return <div className="aa-empty">No play recorded yet — accrues from the analytics release.</div>;
  return (
    <div className="aa-heat">
      {local.map((n, h) => (
        <div key={h} className="aa-heat__col" title={`${h}:00 — ${n} min`}>
          <div className="aa-heat__bar" style={{ height: `${Math.max(2, (n / max) * 56)}px` }} />
          {h % 3 === 0 && <div className="aa-heat__lbl">{h}</div>}
        </div>
      ))}
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

function GameCard({ g, now, onOpen }: { g: OverviewGame; now: number; onOpen: (id: string) => void }) {
  return (
    <button className="aa-card" onClick={() => onOpen(g.id)}>
      <div className="aa-card__name">{g.name}</div>
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
  const [mode, setMode] = useState<'stock' | 'flow'>('stock');

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const res = await apiFetch<GameAnalytics>(`/api/admin/games/${gameId}/analytics`);
      if (!dead && res.ok) setData(res.data);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { dead = true; clearInterval(t); };
  }, [gameId]);

  if (!data) return <div className="aa-empty">Loading game analytics…</div>;
  const { now, game, factions } = data;

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
        </div>
        <YieldChart curves={data.curves} factions={factions} metric={metric} mode={mode} />
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
        <div className="aa-section-title">TECH PACE</div>
        <TechPace data={data} />
      </section>

      <section>
        <div className="aa-section-title">COMBAT LEDGER</div>
        <CombatLedger data={data} />
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
  curves, factions, metric, mode = 'stock',
}: { curves: CurvePoint[]; factions: FactionRow[]; metric: Metric; mode?: 'stock' | 'flow' }) {
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
        {factions.map(f => {
          const pts = series.get(f.id);
          if (!pts || pts.length === 0) return null;
          return (
            <polyline
              key={f.id}
              points={pts.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
              fill="none"
              stroke={f.color}
              strokeWidth={2}
              opacity={f.status === 'active' ? 1 : 0.35}
            />
          );
        })}
      </svg>
      <div className="aa-legend">
        {factions.map(f => (
          <span key={f.id} className="aa-legend__item">
            <span className="aa-dot" style={{ background: f.color }} />
            {f.name}{f.player_name ? ` (${f.player_name})` : ''}
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

function TechPace({ data }: { data: GameAnalytics }) {
  if (data.techPace.length === 0) return <div className="aa-empty">No completed research yet.</div>;
  const rows = [...data.techPace].sort((x, y) => y.completed - x.completed);
  return (
    <table className="aa-table">
      <thead><tr><th>Faction</th><th>Techs done</th><th>Avg ticks each</th><th>Last completed</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.faction_id}>
            <td><FactionChip id={r.faction_id} factions={data.factions} /></td>
            <td>{r.completed}</td>
            <td>{r.avg_ticks}</td>
            <td>T+{r.last_completed_tick}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  return (
    <table className="aa-table">
      <thead><tr><th>Faction</th><th>Kills</th><th>Ships lost</th><th>K/D</th><th>Cities lost</th></tr></thead>
      <tbody>
        {rows.map(id => {
          const k = n(data.combat.kills, id);
          const l = n(data.combat.losses, id);
          return (
            <tr key={id}>
              <td><FactionChip id={id} factions={data.factions} /></td>
              <td>{k}</td>
              <td>{l}</td>
              <td>{l ? (k / l).toFixed(1) : (k ? 'perfect' : '-')}</td>
              <td>{n(data.combat.settlements_lost, id)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
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

function Dropoff({ rows }: { rows: Array<{ kind: string; n: number }> }) {
  if (rows.length === 0) return <div className="aa-empty">No completed idle sessions logged yet.</div>;
  const max = Math.max(...rows.map(r => r.n));
  return (
    <div className="aa-bars">
      {rows.map(r => (
        <div key={r.kind} className="aa-bar-row">
          <span className="aa-bar-label">{r.kind}</span>
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
          <span className="aa-bar-label">{u.kind}</span>
          <span className="aa-bar-track">
            <span className="aa-bar-fill" style={{ width: `${(u.total / max) * 100}%` }} />
          </span>
          <span className="aa-bar-num">{u.total} <em>({u.last_14d} recent · {u.distinct_users} users)</em></span>
        </div>
      ))}
    </div>
  );
}
