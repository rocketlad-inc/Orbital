// ============================================================
// EconomyPanel — the ledger behind the HUD numbers.
//
// Reads top to bottom as a statement: every world and what it earns per
// tick, then every standing cost, then the line that matters — output
// minus costs. The chart underneath is the same three resources over
// time, so "am I getting richer" is a shape rather than a memory test.
//
// THE TABLES ARE LIVE, THE CHART IS HISTORY. Per-world yield and fleet
// upkeep are computed here from game state through the SAME helpers and
// multipliers the tick uses (settlementYield, the industry tech bonus,
// the Senate sliders, SHIP_UPKEEP), so the statement is correct the
// moment you open it — on tick 1, with an empty ledger. Only the trend
// line needs recorded history, because a trend IS history.
//
// The multipliers are not optional decoration. A quoted rate that
// ignores a passed yield law is a rate the server will not deliver,
// which is exactly what once made a "Research x2" bill look inert.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { settlementYield, NO_COLLECTOR_POOL_FRACTION } from '../game/settlements';
import { SHIP_UPKEEP, upkeepSplitFor, type ShipClassName } from '../game/shipClasses';
import { partsCost, sanitizeParts } from '../game/shipParts';
import { TECH_DEFS } from '../game/techs';
import { apiFetch } from '../multiplayer/api';
import './EconomyPanel.css';

type Point = {
  tick: number;
  income_metal: number | null;
  income_gold: number | null;
  income_science: number | null;
};

type EconomyResponse = {
  averages: { spend_metal: number; spend_gold: number; sample_ticks: number };
  spend_by_category: Array<{ category: string; metal: number; gold: number; count: number }>;
  series: Point[];
};

type ResKey = 'metal' | 'credits' | 'science';
const RES_ORDER: ResKey[] = ['metal', 'credits', 'science'];
const RES_LABEL: Record<ResKey, string> = { metal: 'Metal', credits: 'Credits', science: 'Science' };

// Three series, validated as a categorical SET against this panel's own
// surface (#0d131c) with --pairs all rather than adjacent-only: worst
// pair ΔE 9.9 deutan, 19.0 normal vision, every step inside the
// lightness band and over the chroma floor.
//
// Metal is VIOLET, not the game's usual grey: grey has zero chroma, so
// as a 2px line it is indistinguishable from the gridlines and fails
// every colourblind check by construction. Credits and science keep the
// game's gold and mint hues, stepped into the band. Identity is also
// carried by the legend and the column dots, so no reading here depends
// on hue alone.
const INK: Record<ResKey, string> = {
  metal: '#8f7fd6',
  credits: '#c8821f',
  science: '#12a89e',
};

// Only "colony" is irregular, but a naive `${cls}s` printed "colonys"
// on the very first render of this table, so the plurals are named.
const CLASS_PLURAL: Record<ShipClassName, string> = {
  corvette: 'Corvettes',
  frigate: 'Frigates',
  destroyer: 'Destroyers',
  freighter: 'Freighters',
  colony: 'Colony ships',
};

type Triple = { metal: number; credits: number; science: number };
const ZERO: Triple = { metal: 0, credits: 0, science: 0 };
const add = (a: Triple, b: Triple): Triple => ({
  metal: a.metal + b.metal, credits: a.credits + b.credits, science: a.science + b.science,
});

function n(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function signed(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return '—';
  const s = n(Math.abs(v), dp);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export const EconomyPanel: React.FC<{ gameId: string }> = ({ gameId }) => {
  const { gameState } = useGameContext();
  const [hist, setHist] = useState<EconomyResponse | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await apiFetch<EconomyResponse>(`/api/games/${gameId}/economy`);
      if (live && res.ok) setHist(res.data);
    };
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [gameId]);

  // ---- OUTPUT: every world you hold, line by line -------------------
  const worlds = useMemo(() => {
    const lvl = gameState.factionTech?.player?.levels?.industry ?? 0;
    const yieldMul = 1 + TECH_DEFS.industry.perLevel * lvl;
    const sl = gameState.activeSliders;
    const sMetal = sl?.metalYieldMultiplier ?? 1;
    const sCredits = sl?.goldYieldMultiplier ?? 1;
    const sScience = sl?.scienceYieldMultiplier ?? 1;

    return gameState.settlements
      .filter(s => s.ownedBy === 'player')
      .map(s => {
        const body = gameState.bodies.find(b => b.id === s.bodyId);
        const y = body ? settlementYield(s, body) : { fuel: 0, ore: 0, credits: 0, science: 0 };
        const gross: Triple = {
          metal: y.ore * yieldMul * sMetal,
          credits: y.credits * yieldMul * sCredits,
          science: y.science * yieldMul * sScience,
        };
        // A raw world banks most of its yield on-site and trickles the
        // rest to the empire; a terraformed one ships everything. MP
        // keys the split on the BODY (terraformedAtTick null = raw); SP
        // bodies leave the field undefined and keep the collector rule.
        const docked = body && body.terraformedAtTick !== undefined
          ? body.terraformedAtTick !== null
          : !!s.hasCollector;
        const f = docked ? 1 : NO_COLLECTOR_POOL_FRACTION;
        return {
          id: s.id,
          name: s.name,
          where: body?.name ?? '—',
          type: s.type,
          pop: s.population,
          docked,
          gross,
          pool: { metal: gross.metal * f, credits: gross.credits * f, science: gross.science * f },
        };
      })
      .sort((a, b) => (b.pool.metal + b.pool.credits + b.pool.science)
                    - (a.pool.metal + a.pool.credits + a.pool.science));
  }, [gameState.settlements, gameState.bodies, gameState.factionTech, gameState.activeSliders]);

  const grossTotal = useMemo(() => worlds.reduce((t, w) => add(t, w.gross), ZERO), [worlds]);
  const poolTotal = useMemo(() => worlds.reduce((t, w) => add(t, w.pool), ZERO), [worlds]);

  // ---- COSTS: standing upkeep, lumped by ship class -----------------
  const upkeepMul = gameState.activeSliders?.fleetUpkeepMultiplier ?? 1;
  const fleetCosts = useMemo(() => {
    const byClass = new Map<ShipClassName, { count: number; metal: number; credits: number }>();
    for (const s of gameState.ships) {
      if (s.ownedBy !== 'player') continue;
      const cls = s.class as ShipClassName;
      if (!SHIP_UPKEEP[cls]) continue;
      // PER HULL, by loadout. SHIP_UPKEEP is a per-class TOTAL now; which
      // currency it comes out of depends on what the ship is made of
      // (upkeepSplitFor, mirroring worker/shipDesigns.js). Reading the
      // flat table here would make this statement disagree with the tick
      // that actually bills — the exact drift this panel exists to avoid.
      const up = upkeepSplitFor(cls, sanitizeParts(s.parts ?? []), partsCost);
      const e = byClass.get(cls) ?? { count: 0, metal: 0, credits: 0 };
      e.count += 1;
      e.metal += up.ore * upkeepMul;
      e.credits += up.credits * upkeepMul;
      byClass.set(cls, e);
    }
    return [...byClass.entries()]
      .map(([cls, v]) => ({ cls, ...v }))
      .sort((a, b) => (b.metal + b.credits) - (a.metal + a.credits));
  }, [gameState.ships, upkeepMul]);

  const upkeepTotal = useMemo(
    () => fleetCosts.reduce((t, c) => add(t, { metal: c.metal, credits: c.credits, science: 0 }), ZERO),
    [fleetCosts],
  );

  // Construction is spiky by nature — a shipyard order lands in one tick
  // and nothing the next — so it joins the statement as an average over
  // the recorded window rather than a spot value that is usually zero.
  const buildAvg: Triple = {
    metal: hist?.averages.spend_metal ?? 0,
    credits: hist?.averages.spend_gold ?? 0,
    science: 0,
  };

  const costTotal = add(upkeepTotal, buildAvg);
  const net: Triple = {
    metal: poolTotal.metal - costTotal.metal,
    credits: poolTotal.credits - costTotal.credits,
    science: poolTotal.science - costTotal.science,
  };

  const strandedShown =
    (grossTotal.metal + grossTotal.credits + grossTotal.science)
    - (poolTotal.metal + poolTotal.credits + poolTotal.science) > 0.005;

  const plot = useMemo(() => (hist?.series ?? []).filter(p => p.income_gold != null), [hist]);

  return (
    <div className="econ">
      {/* ---------------- OUTPUT ---------------- */}
      <h4 className="econ-h">
        Output · per tick
        <span className="econ-sub">what each world sends to the empire pool</span>
      </h4>
      <table className="econ-table">
        <thead>
          <tr>
            <th scope="col">World</th>
            <th scope="col" className="econ-num">
              <i className="econ-dot" style={{ background: INK.metal }} aria-hidden />Metal
            </th>
            <th scope="col" className="econ-num">
              <i className="econ-dot" style={{ background: INK.credits }} aria-hidden />Credits
            </th>
            <th scope="col" className="econ-num">
              <i className="econ-dot" style={{ background: INK.science }} aria-hidden />Science
            </th>
          </tr>
        </thead>
        <tbody>
          {worlds.length === 0 && (
            <tr><td colSpan={4} className="econ-muted">No settlements yet.</td></tr>
          )}
          {worlds.map(w => (
            <tr key={w.id}>
              <th scope="row">
                <span className="econ-world">{w.name}</span>
                <span className="econ-where">
                  {w.where} · {w.type} · pop {w.pop}
                  {!w.docked && (
                    <em
                      className="econ-raw"
                      title={`Raw world — it banks ${Math.round((1 - NO_COLLECTOR_POOL_FRACTION) * 100)}% of its yield on-site and only ${Math.round(NO_COLLECTOR_POOL_FRACTION * 100)}% reaches the pool. Terraform it to ship everything.`}
                    > · raw, {Math.round(NO_COLLECTOR_POOL_FRACTION * 100)}%</em>
                  )}
                </span>
              </th>
              <td className="econ-num">{n(w.pool.metal)}</td>
              <td className="econ-num">{n(w.pool.credits)}</td>
              <td className="econ-num">{n(w.pool.science)}</td>
            </tr>
          ))}
          <tr className="econ-r--sub">
            <th scope="row">Total output</th>
            <td className="econ-num">{n(poolTotal.metal)}</td>
            <td className="econ-num">{n(poolTotal.credits)}</td>
            <td className="econ-num">{n(poolTotal.science)}</td>
          </tr>
          {strandedShown && (
            <tr className="econ-r--faint">
              <th scope="row">
                Gross produced
                <span className="econ-where">the difference banks locally on raw worlds</span>
              </th>
              <td className="econ-num">{n(grossTotal.metal)}</td>
              <td className="econ-num">{n(grossTotal.credits)}</td>
              <td className="econ-num">{n(grossTotal.science)}</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* ---------------- COSTS ---------------- */}
      <h4 className="econ-h">
        Costs · per tick
        <span className="econ-sub">fleet upkeep by class, plus construction</span>
      </h4>
      <table className="econ-table">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col" className="econ-num">Ships</th>
            <th scope="col" className="econ-num">Metal</th>
            <th scope="col" className="econ-num">Credits</th>
          </tr>
        </thead>
        <tbody>
          {fleetCosts.length === 0 && (
            <tr><td colSpan={4} className="econ-muted">No fleet to pay for.</td></tr>
          )}
          {fleetCosts.map(c => (
            <tr key={c.cls}>
              <th scope="row">{CLASS_PLURAL[c.cls] ?? c.cls}</th>
              <td className="econ-num econ-muted">{c.count}</td>
              <td className="econ-num">{c.metal === 0 ? '—' : `−${n(c.metal)}`}</td>
              <td className="econ-num">{c.credits === 0 ? '—' : `−${n(c.credits)}`}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">
              Construction
              <span className="econ-where">
                {hist
                  ? `averaged over ${hist.averages.sample_ticks} recorded tick${hist.averages.sample_ticks === 1 ? '' : 's'}`
                  : 'awaiting history'}
              </span>
            </th>
            <td className="econ-num econ-muted">—</td>
            <td className="econ-num">{buildAvg.metal === 0 ? '—' : `−${n(buildAvg.metal)}`}</td>
            <td className="econ-num">{buildAvg.credits === 0 ? '—' : `−${n(buildAvg.credits)}`}</td>
          </tr>
          <tr className="econ-r--sub">
            <th scope="row">Total costs</th>
            <td className="econ-num econ-muted" />
            <td className="econ-num">{costTotal.metal === 0 ? '—' : `−${n(costTotal.metal)}`}</td>
            <td className="econ-num">{costTotal.credits === 0 ? '—' : `−${n(costTotal.credits)}`}</td>
          </tr>
        </tbody>
      </table>

      {/* ---------------- NET ---------------- */}
      <table className="econ-table econ-table--net">
        <tbody>
          <tr className="econ-r--net">
            <th scope="row">
              Net per tick
              <span className="econ-where">output less costs</span>
            </th>
            {RES_ORDER.map(k => (
              <td key={k} className={`econ-num ${net[k] > 0 ? 'is-pos' : net[k] < 0 ? 'is-neg' : ''}`}>
                <span className="econ-netk">{RES_LABEL[k]}</span>
                {signed(net[k])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {upkeepMul !== 1 && (
        <p className="econ-note">
          A Senate law has fleet upkeep at ×{n(upkeepMul)}; the cost lines above are
          the billed amounts, not the base rates.
        </p>
      )}

      {/* ---------------- TREND ---------------- */}
      <h4 className="econ-h">
        Income over time
        <span className="econ-sub">per tick, as actually banked</span>
      </h4>
      <ResourceTrend points={plot} />
      <p className="econ-note">
        The trend is measured, not projected: each point is that tick's change
        in the pool with upkeep and spending added back. Trade payouts, salvage
        and refunds land in it too, so it runs above or below the table
        whenever something other than a settlement pays you.
      </p>
    </div>
  );
};

/**
 * Per-tick income of all three resources.
 *
 * ONE AXIS, deliberately: these are three quantities of the same kind
 * (units banked in a tick), so a shared scale is what makes "science
 * dwarfs metal" a readable fact rather than an artefact of two y-scales
 * each tuned to flatter its own series.
 */
export function ResourceTrend({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 200, PAD_L = 46, PAD_R = 46, PAD_T = 12, PAD_B = 24;

  if (points.length < 2) {
    return (
      <div className="econ-chart econ-chart--empty">
        The trend needs at least two recorded ticks. The ledger only starts
        recording from the tick after this update landed, so the line
        begins drawing shortly.
      </div>
    );
  }

  const val = (p: Point, k: ResKey): number => Number(
    (k === 'metal' ? p.income_metal : k === 'credits' ? p.income_gold : p.income_science) ?? 0,
  );
  const all = RES_ORDER.flatMap(k => points.map(p => val(p, k)));
  const hi = Math.max(1, ...all);
  const lo = Math.min(0, ...all);
  const x = (i: number) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD_T - PAD_B);
  const idx = hover == null ? points.length - 1 : hover;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => lo + f * (hi - lo));

  return (
    <figure className="econ-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`} className="econ-svg" role="img"
        aria-label={`Per-tick income for metal, credits and science, ticks ${points[0].tick} to ${points[points.length - 1].tick}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const f = (px - PAD_L) / (W - PAD_L - PAD_R);
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(f * (points.length - 1)))));
        }}
      >
        {grid.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="econ-grid" />
            <text x={PAD_L - 6} y={y(t) + 3} className="econ-axis" textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {lo < 0 && <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} className="econ-zero" />}

        <line x1={x(idx)} x2={x(idx)} y1={PAD_T} y2={H - PAD_B} className="econ-cross" />

        {RES_ORDER.map(k => {
          const d = points
            .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val(p, k)).toFixed(1)}`)
            .join('');
          return <path key={k} d={d} fill="none" stroke={INK[k]} strokeWidth={2} strokeLinejoin="round" />;
        })}

        {RES_ORDER.map(k => (
          <circle
            key={k} cx={x(idx)} cy={y(val(points[idx], k))} r={4}
            fill={INK[k]} className="econ-mark"
          />
        ))}

        <text x={PAD_L} y={H - 6} className="econ-axis">T{points[0].tick}</text>
        <text x={W - PAD_R} y={H - 6} className="econ-axis" textAnchor="end">
          T{points[points.length - 1].tick}
        </text>
      </svg>

      <figcaption className="econ-legend">
        {RES_ORDER.map(k => (
          <span key={k}>
            <i className="econ-dot" style={{ background: INK[k] }} aria-hidden />
            {RES_LABEL[k]} <b>{n(val(points[idx], k))}</b>
          </span>
        ))}
        <span className="econ-legend__t">tick {points[idx].tick}</span>
      </figcaption>
    </figure>
  );
}
