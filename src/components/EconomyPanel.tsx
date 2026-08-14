// ============================================================
// EconomyPanel — the ledger behind the HUD numbers.
//
// The HUD shows a balance and a rate. It never said WHERE the rate came
// from, so "why am I poor" had no answer anywhere in the game. This is
// that answer: a statement of what came in, what went out, and whether
// the gap is widening.
//
// DERIVED, NOT DECLARED. Income is not stored anywhere — the server
// reconstructs it from consecutive ledger rows (see worker/economy.js),
// because money arrives across half a dozen tick passes and any
// hand-maintained counter would drift from the rules. Everything here is
// therefore arithmetic on observed balances, which means it cannot
// disagree with the player's actual pool.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../multiplayer/api';
import './EconomyPanel.css';

type Point = {
  tick: number;
  pool_metal: number; pool_gold: number; pool_science: number;
  upkeep_metal: number; upkeep_gold: number;
  arrears_metal: number; arrears_gold: number;
  spend_metal: number; spend_gold: number;
  net_metal: number | null; net_gold: number | null; net_science: number | null;
  income_metal: number | null; income_gold: number | null; income_science: number | null;
};

type EconomyResponse = {
  faction: { id: string; name: string };
  current_tick: number;
  pools: { metal: number; gold: number; science: number };
  arrears: { metal: number; gold: number };
  averages: {
    income_metal: number; income_gold: number; income_science: number;
    upkeep_metal: number; upkeep_gold: number;
    spend_metal: number; spend_gold: number;
    net_metal: number; net_gold: number;
    sample_ticks: number;
  };
  spend_by_category: Array<{ category: string; metal: number; gold: number; count: number }>;
  series: Point[];
};

// Two series, validated as a categorical pair against this panel's own
// surface (#0d131c) rather than eyeballed: OKLab lightness band, chroma
// floor, protan/deutan/tritan separation ΔE 15.0, normal-vision ΔE 20.5,
// and >= 3:1 contrast. They sit in the game's existing teal/amber family
// so the panel doesn't read as imported from another product.
const INK_IN = '#12a89e';
const INK_OUT = '#c8821f';

type Currency = 'metal' | 'gold';
const CURRENCY_LABEL: Record<Currency, string> = { metal: 'Metal', gold: 'Credits' };

function fmt(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Signed, for anything where direction is the point. */
function signed(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = fmt(Math.abs(n), dp);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export const EconomyPanel: React.FC<{ gameId: string }> = ({ gameId }) => {
  const [data, setData] = useState<EconomyResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState<Currency>('gold');

  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await apiFetch<EconomyResponse>(`/api/games/${gameId}/economy`);
      if (!live) return;
      if (res.ok) { setData(res.data); setErr(null); }
      else setErr(res.error?.message ?? 'Could not load the economy.');
    };
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [gameId]);

  // Only ticks where income could be derived — the first row of a window
  // has no predecessor, and charting it as zero would draw a cliff that
  // never happened. The `?? []` lives INSIDE the memo: as a bare
  // expression it allocates a new array each render and the memo never
  // holds.
  const plot = useMemo(
    () => (data?.series ?? []).filter(p => p.income_gold != null),
    [data],
  );

  if (err) return <div className="econ-empty">{err}</div>;
  if (!data) return <div className="econ-empty">Reading the books…</div>;

  const a = data.averages;
  const inKey = cur === 'metal' ? 'income_metal' : 'income_gold';
  const upKey = cur === 'metal' ? 'upkeep_metal' : 'upkeep_gold';
  const spKey = cur === 'metal' ? 'spend_metal' : 'spend_gold';

  const avgIn = cur === 'metal' ? a.income_metal : a.income_gold;
  const avgUp = cur === 'metal' ? a.upkeep_metal : a.upkeep_gold;
  const avgSp = cur === 'metal' ? a.spend_metal : a.spend_gold;
  const avgNet = cur === 'metal' ? a.net_metal : a.net_gold;

  return (
    <div className="econ">
      {/* Balances first: the number the player already knows from the HUD,
          so the panel is anchored to something familiar before it starts
          explaining. */}
      <div className="econ-tiles">
        <Tile label="Metal" value={fmt(data.pools.metal)} rate={a.net_metal} tone="#a0a0a0" />
        <Tile label="Credits" value={fmt(data.pools.gold)} rate={a.net_gold} tone="#ffd700" />
        <Tile label="Science" value={fmt(data.pools.science, 1)} rate={a.income_science} tone="#6ee7b7" />
      </div>

      {(data.arrears.gold > 0 || data.arrears.metal > 0) && (
        <div className="econ-arrears" role="status">
          <span aria-hidden>⚠</span> Fleet in arrears —{' '}
          {data.arrears.metal > 0 && <>{fmt(data.arrears.metal)} metal </>}
          {data.arrears.gold > 0 && <>{fmt(data.arrears.gold)} credits </>}
          unpaid. Unpaid fleets fight at a penalty.
        </div>
      )}

      <div className="econ-head">
        <h4 className="econ-h">In and out, per tick</h4>
        <div className="econ-switch" role="group" aria-label="Currency">
          {(['gold', 'metal'] as Currency[]).map(c => (
            <button
              key={c}
              className={`econ-switch__b ${cur === c ? 'is-on' : ''}`}
              onClick={() => setCur(c)}
              aria-pressed={cur === c}
            >{CURRENCY_LABEL[c]}</button>
          ))}
        </div>
      </div>

      <TrendChart
        points={plot}
        inKey={inKey as keyof Point}
        outKeys={[upKey as keyof Point, spKey as keyof Point]}
        label={CURRENCY_LABEL[cur]}
      />

      {/* The spreadsheet. Averaged over the sampled window rather than
          shown for a single tick: one tick is noise (a build lands, a
          freighter arrives) and the question is the trend. */}
      <h4 className="econ-h">
        Statement · {CURRENCY_LABEL[cur].toLowerCase()} per tick
        <span className="econ-sub">averaged over the last {a.sample_ticks} scored tick{a.sample_ticks === 1 ? '' : 's'}</span>
      </h4>
      <table className="econ-table">
        <thead>
          <tr><th scope="col">Line</th><th scope="col" className="econ-num">Per tick</th></tr>
        </thead>
        <tbody>
          <tr className="econ-r--in">
            <th scope="row"><i className="econ-dot" style={{ background: INK_IN }} aria-hidden /> Income</th>
            <td className="econ-num">{signed(avgIn, 1)}</td>
          </tr>
          <tr className="econ-r--out">
            <th scope="row"><i className="econ-dot" style={{ background: INK_OUT }} aria-hidden /> Fleet upkeep</th>
            <td className="econ-num">{signed(-avgUp, 1)}</td>
          </tr>
          <tr className="econ-r--out">
            <th scope="row"><i className="econ-dot econ-dot--hollow" style={{ borderColor: INK_OUT }} aria-hidden /> Construction</th>
            <td className="econ-num">{signed(-avgSp, 1)}</td>
          </tr>
          <tr className="econ-r--net">
            <th scope="row">Net</th>
            <td className={`econ-num ${avgNet >= 0 ? 'is-pos' : 'is-neg'}`}>{signed(avgNet, 1)}</td>
          </tr>
        </tbody>
      </table>

      {data.spend_by_category.length > 0 && (
        <>
          <h4 className="econ-h">
            Where construction went
            <span className="econ-sub">totals across the charted window</span>
          </h4>
          <table className="econ-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="econ-num">Metal</th>
                <th scope="col" className="econ-num">Credits</th>
                <th scope="col" className="econ-num">Orders</th>
              </tr>
            </thead>
            <tbody>
              {data.spend_by_category.map(c => (
                <tr key={c.category}>
                  <th scope="row">{c.category}</th>
                  <td className="econ-num">{fmt(c.metal)}</td>
                  <td className="econ-num">{fmt(c.gold)}</td>
                  <td className="econ-num econ-muted">{fmt(c.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {plot.length === 0 && (
        <div className="econ-empty">
          No history yet — the ledger starts recording from the next tick.
          Come back in a few and the trend will draw itself.
        </div>
      )}
    </div>
  );
};

function Tile({ label, value, rate, tone }: {
  label: string; value: string; rate: number; tone: string;
}) {
  const good = rate >= 0;
  return (
    <div className="econ-tile">
      <div className="econ-tile__l" style={{ color: tone }}>{label}</div>
      <div className="econ-tile__v">{value}</div>
      <div className={`econ-tile__r ${good ? 'is-pos' : 'is-neg'}`}>
        {signed(rate, 1)}<span className="econ-tile__u">/t</span>
      </div>
    </div>
  );
}

/**
 * Income vs outgoings over time.
 *
 * ONE AXIS. Both series are the same currency in the same unit, so they
 * share a scale — the two-y-axis chart that would let metal and credits
 * share a frame is exactly the thing that makes a chart lie.
 */
function TrendChart({ points, inKey, outKeys, label }: {
  points: Point[]; inKey: keyof Point; outKeys: Array<keyof Point>; label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 190, PAD_L = 44, PAD_R = 12, PAD_T = 12, PAD_B = 24;

  if (points.length < 2) {
    return (
      <div className="econ-chart econ-chart--empty">
        Not enough history to plot yet — one point per tick.
      </div>
    );
  }

  const inc = points.map(p => Number(p[inKey] ?? 0));
  const out = points.map(p => outKeys.reduce((s, k) => s + Number(p[k] ?? 0), 0));
  const hi = Math.max(1, ...inc, ...out);
  const lo = Math.min(0, ...inc, ...out);
  const x = (i: number) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD_T - PAD_B);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  // Four gridlines is enough to read a level against without the grid
  // competing with the data for attention.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + f * (hi - lo));
  const idx = hover == null ? points.length - 1 : hover;

  return (
    <figure className="econ-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`} className="econ-svg" role="img"
        aria-label={`${label} income versus outgoings per tick, ticks ${points[0].tick} to ${points[points.length - 1].tick}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const f = (px - PAD_L) / (W - PAD_L - PAD_R);
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(f * (points.length - 1)))));
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="econ-grid" />
            <text x={PAD_L - 6} y={y(t) + 3} className="econ-axis" textAnchor="end">{Math.round(t)}</text>
          </g>
        ))}
        {lo < 0 && <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} className="econ-zero" />}

        <path d={path(out)} fill="none" stroke={INK_OUT} strokeWidth={2} strokeLinejoin="round" />
        <path d={path(inc)} fill="none" stroke={INK_IN} strokeWidth={2} strokeLinejoin="round" />

        {/* Crosshair + the read-out for the hovered tick. An SVG chart is
            interactive by default; a static one makes the player estimate
            values off a grid. */}
        <line x1={x(idx)} x2={x(idx)} y1={PAD_T} y2={H - PAD_B} className="econ-cross" />
        <circle cx={x(idx)} cy={y(inc[idx])} r={4} fill={INK_IN} className="econ-mark" />
        <circle cx={x(idx)} cy={y(out[idx])} r={4} fill={INK_OUT} className="econ-mark" />

        <text x={PAD_L} y={H - 6} className="econ-axis">T{points[0].tick}</text>
        <text x={W - PAD_R} y={H - 6} className="econ-axis" textAnchor="end">T{points[points.length - 1].tick}</text>
      </svg>

      <figcaption className="econ-legend">
        <span><i className="econ-dot" style={{ background: INK_IN }} aria-hidden /> Income <b>{fmt(inc[idx], 1)}</b></span>
        <span><i className="econ-dot" style={{ background: INK_OUT }} aria-hidden /> Out <b>{fmt(out[idx], 1)}</b></span>
        <span className="econ-legend__t">tick {points[idx].tick}</span>
      </figcaption>
    </figure>
  );
}
