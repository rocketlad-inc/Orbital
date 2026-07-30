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
  sessions_14d: number; last_seen_ms: number | null; avg_session_min: number | null;
};
type Overview = { now: number; games: OverviewGame[]; players: OverviewPlayer[] };

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
  sessions_14d: number; last_seen_ms: number | null; avg_session_min: number | null;
  actions_14d: number;
};
type GameAnalytics = {
  now: number;
  game: OverviewGame & { winner_faction_id: string | null };
  factions: FactionRow[]; curves: CurvePoint[]; usage: UsageRow[]; engagement: EngagementRow[];
};

const METRICS = ['metal', 'fuel', 'gold', 'science', 'ships', 'settlements'] as const;
type Metric = typeof METRICS[number];

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
        <div className="aa-section-title">PLAYERS · LAST 14 DAYS</div>
        <table className="aa-table">
          <thead>
            <tr><th>Player</th><th>Logins</th><th>Avg session</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {data.players.map(p => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td>{p.sessions_14d}</td>
                <td>{p.avg_session_min != null ? `${Math.round(p.avg_session_min)} min` : '—'}</td>
                <td>{ago(now, p.last_seen_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
        <YieldChart curves={data.curves} factions={factions} metric={metric} />
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
        <div className="aa-section-title">PLAYER ENGAGEMENT</div>
        <table className="aa-table">
          <thead>
            <tr><th>Player</th><th>Faction</th><th>Logins·14d</th><th>Avg session</th><th>Actions·14d</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {data.engagement.map(e => (
              <tr key={e.id}>
                <td>{e.display_name}</td>
                <td><span className="aa-dot" style={{ background: e.color }} />{e.faction_name}</td>
                <td>{e.sessions_14d}</td>
                <td>{e.avg_session_min != null ? `${Math.round(e.avg_session_min)} min` : '—'}</td>
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
  curves, factions, metric,
}: { curves: CurvePoint[]; factions: FactionRow[]; metric: Metric }) {
  const W = 720, H = 220, PAD = 34;

  const series = useMemo(() => {
    const byFaction = new Map<string, Array<[number, number]>>();
    for (const p of curves) {
      let arr = byFaction.get(p.faction_id);
      if (!arr) { arr = []; byFaction.set(p.faction_id, arr); }
      arr.push([p.tick_number, p[metric]]);
    }
    return byFaction;
  }, [curves, metric]);

  const [maxTick, maxVal] = useMemo(() => {
    let mt = 1, mv = 1;
    series.forEach(arr => {
      for (const [t, v] of arr) { if (t > mt) mt = t; if (v > mv) mv = v; }
    });
    return [mt, mv];
  }, [series]);

  if (curves.length === 0) {
    return (
      <div className="aa-empty">
        No curve data yet — metrics record from each tick after the
        analytics release, so history starts accruing now.
      </div>
    );
  }

  const x = (t: number) => PAD + (t / maxTick) * (W - PAD * 2);
  const y = (v: number) => H - PAD + -(v / maxVal) * (H - PAD * 2);

  return (
    <div className="aa-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="aa-chart" preserveAspectRatio="none">
        {[0, 0.5, 1].map(f => (
          <g key={f}>
            <line x1={PAD} x2={W - PAD} y1={y(maxVal * f)} y2={y(maxVal * f)} className="aa-grid" />
            <text x={4} y={y(maxVal * f) + 4} className="aa-axis">{Math.round(maxVal * f)}</text>
          </g>
        ))}
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
