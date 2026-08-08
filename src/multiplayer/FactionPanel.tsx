import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, MyFaction, Pact, PACT_LABELS, PactKind, tradesApi } from './api';
import { FlagChip } from '../components/FactionEmblem';

// The local twoToneChip helper is gone — FlagChip in
// components/FactionEmblem draws the same two-tone field plus the
// faction's emblem, and LobbyView now shares it, so a player's flag
// cannot render one way in the lobby and another in the match.

// Highest-tier pact wins for the at-a-glance WAR/ALLIED/NAP label.
// Ranked by how much it suppresses combat: defense_pact (full coverage)
// > nap (peace but no defense) > intel_share (info only, no combat
// suppression in the current rules). Players with NO active pact are
// at war by default — that's the implicit-war design.
const PACT_RANK: Record<PactKind, number> = {
  defense_pact: 3,
  nap: 2,
  intel_share: 1,
};

const STATUS_LABEL = {
  defense_pact: 'ALLIED',
  // ☮ peace sign — the acronym "NAP" was opaque to playtesters;
  // glyph + the word "PEACE" reads as the intent at a glance and
  // matches the cool-cyan no-combat coloring.
  nap: '☮ PEACE',
  intel_share: 'INTEL',
  war: 'WAR',
  self: '',
} as const;

/** The drawer's long-form of the relation chip: the chip abbreviates,
 *  the drawer speaks in sentences. */
const RELATION_TEXT: Record<keyof typeof STATUS_LABEL, string> = {
  defense_pact: 'allied with you',
  nap: 'at peace with you',
  intel_share: 'sharing intel with you',
  war: 'at war with you',
  self: '',
};

const STATUS_COLOR: Record<keyof typeof STATUS_LABEL, string> = {
  defense_pact: '#6ee7b7',   // friendly green — full alliance
  nap: '#67e8f9',            // cool cyan — peace but not allied
  intel_share: '#a4b5c4',    // muted — info-only
  war: '#ff5e5e',            // hostile red — implicit war default
  self: 'var(--mp-fg-dim)',
};

// Per-resource tint for the income line — subtle, decoration only.

export function FactionPanel({ gameId }: { gameId: string }) {
  const [me, setMe] = useState<MyFaction | null>(null);
  const [roster, setRoster] = useState<Faction[]>([]);
  const [pacts, setPacts] = useState<Pact[]>([]);
  const [breaking, setBreaking] = useState<string | null>(null);
  const [breakError, setBreakError] = useState<string | null>(null);
  /** Dyson progress rides on the factions payload so all three victory
   *  paths render from one fetch. Null on pre-Phase-B games. */
  const [dyson, setDyson] = useState<DysonProgress | null>(null);
  /** Which faction rows have their detail drawer open. */
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => setOpenRows(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const tradesApiClient = useMemo(() => tradesApi(gameId), [gameId]);

  const refresh = useCallback(async () => {
    const [meRes, listRes, pactsRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[]; dyson?: DysonProgress | null }>(`/api/games/${gameId}/factions`),
      tradesApiClient.listPacts(),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (listRes.ok) { setRoster(listRes.data.factions); setDyson(listRes.data.dyson ?? null); }
    if (pactsRes.ok) setPacts(pactsRes.data.pacts);
  }, [gameId, tradesApiClient]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function handleBreak(treatyId: string) {
    if (!window.confirm(
      'Break this pact? Combat between you and the counterparty resumes immediately.'
    )) return;
    setBreaking(treatyId);
    setBreakError(null);
    const res = await tradesApiClient.breakTreaty(treatyId);
    setBreaking(null);
    if (!res.ok) {
      setBreakError(res.error?.message ?? 'Could not break treaty');
      return;
    }
    refresh();
  }

  if (!me) return <div className="mp-empty">Loading faction…</div>;

  // Build per-counterparty pact map for the diplomacy roster.
  const pactsByFaction = new Map<string, Pact[]>();
  for (const p of pacts) {
    for (const fid of p.counterparty_faction_ids) {
      const arr = pactsByFaction.get(fid) ?? [];
      arr.push(p);
      pactsByFaction.set(fid, arr);
    }
  }
  const topPactKind = (fid: string): PactKind | null => {
    const arr = pactsByFaction.get(fid);
    if (!arr || arr.length === 0) return null;
    return arr.reduce<PactKind | null>((best, p) => {
      if (!best) return p.kind;
      return PACT_RANK[p.kind] > PACT_RANK[best] ? p.kind : best;
    }, null);
  };

  // Threat order: the faction closest to winning reads first, not the
  // one that happened to take seat 0. Vote weight is the sort key because
  // it is the only stat that is itself a win condition.
  const ranked = [...roster].sort((a, b) => {
    const w = (weightOf(b) - weightOf(a));
    if (w !== 0) return w;
    return (b.bodies_owned ?? 0) - (a.bodies_owned ?? 0);
  });

  // My own scoreboard lives on the roster entry — /me doesn't carry the
  // derived fields. Fall back so the tracks render before the roster lands.
  const myScore = roster.find(f => f.id === me.id) ?? (me as unknown as Faction);
  const bodiesTotal = roster.find(f => (f.bodies_total ?? 0) > 0)?.bodies_total ?? 0;
  const systemsTotal = roster.find(f => (f.systems_total ?? 0) > 0)?.systems_total ?? 0;
  const claimed = roster.reduce((n, f) => n + (f.bodies_owned ?? 0), 0);
  const unclaimed = Math.max(0, bodiesTotal - claimed);
  // Domination is STRICTLY more than 60%, so the target is the first
  // integer above the fraction — 28 of 45, not 27. Mirrors room.js.
  const dominationTarget = bodiesTotal > 0 ? Math.floor(bodiesTotal * 0.6) + 1 : 0;
  const chamber = roster.reduce((n, f) => n + weightOf(f), 0);

  const leaderBy = (score: (f: Faction) => number): Faction | null =>
    ranked.reduce<Faction | null>((best, f) =>
      (!best || score(f) > score(best)) ? f : best, null);
  const domLeader = leaderBy(f => f.bodies_owned ?? 0);
  const senLeader = leaderBy(weightOf);
  const dysonOwner = dyson?.controller
    ? roster.find(f => f.id === dyson.controller) ?? null
    : null;

  return (
    <div className="fp">
      {/* ---------- territory: the shape of the game ---------- */}
      {bodiesTotal > 0 && (
        <section className="fp-sect">
          <div className="fp-sect__h">
            <span className="fp-lbl">Territory</span>
            <span className="fp-lbl fp-lbl--dim">
              {bodiesTotal} worlds · {systemsTotal} systems
            </span>
          </div>
          <div className="fp-terrwrap">
            <div className="fp-terr">
              {ranked.filter(f => (f.bodies_owned ?? 0) > 0).map(f => {
                const n = f.bodies_owned ?? 0;
                const pct = (100 * n) / bodiesTotal;
                return (
                  <div
                    key={f.id}
                    style={{ width: `${pct}%`, background: f.color }}
                    title={`${f.name} — ${n} of ${bodiesTotal} worlds`}
                  >
                    {pct >= 7 && <span style={{ color: readableOn(f.color) }}>{n}</span>}
                  </div>
                );
              })}
              {unclaimed > 0 && (
                <div
                  className="fp-terr__free"
                  style={{ width: `${(100 * unclaimed) / bodiesTotal}%` }}
                  title={`${unclaimed} worlds unclaimed`}
                >
                  {unclaimed / bodiesTotal >= 0.14 && <span>{unclaimed} free</span>}
                </div>
              )}
            </div>
            {/* Domination line. Left as a fraction of the whole bar so it
                lands on the same scale the segments use. */}
            <div
              className="fp-terr__tick"
              style={{ left: `${(100 * dominationTarget) / bodiesTotal}%` }}
            />
          </div>
          <div className="fp-terrfoot">
            <span>{claimed} of {bodiesTotal} claimed</span>
            <span className="fp-terrfoot__mid">{dominationTarget} wins</span>
            <span>{unclaimed} unclaimed</span>
          </div>
        </section>
      )}

      {/* ---------- standings ---------- */}
      <section className="fp-sect">
        <div className="fp-sect__h">
          <span className="fp-lbl">Standings</span>
          <span className="fp-lbl fp-lbl--dim">tap a row for detail</span>
        </div>
        <div role="table" aria-label="Faction standings">
          <div role="rowgroup">
            <div className="fp-head" role="row">
              <span role="columnheader">Mtl</span>
              <span role="columnheader">Cr</span>
              <span role="columnheader">Sci</span>
              <span role="columnheader">Wld</span>
              <span role="columnheader">Sys</span>
              <span role="columnheader">Fleet</span>
            </div>
          </div>
          {ranked.map(f => {
            const mine = f.id === me.id;
            const eliminated = f.status === 'eliminated';
            const dormant = !eliminated && (f.bodies_owned ?? 0) === 0
              && (f.ship_count ?? 0) === 0;
            const top = topPactKind(f.id);
            const factionPacts = pactsByFaction.get(f.id) ?? [];
            const open = openRows.has(f.id);
            const statusKey: keyof typeof STATUS_LABEL = mine ? 'self' : (top ?? 'war');
            return (
              <div
                key={f.id}
                role="rowgroup"
                className={'fp-row'
                  + (mine ? ' fp-row--you' : '')
                  + (eliminated ? ' fp-row--out' : '')}
              >
                <button
                  type="button"
                  className="fp-row__id"
                  aria-expanded={open}
                  onClick={() => toggleRow(f.id)}
                >
                  <span className="fp-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  <FlagChip className="mp-swatch" color={f.color} color2={f.color2}
                    emblem={f.emblem} fallbackKey={f.id} size={16} />
                  <span className="fp-name" title={f.name}>{f.name}</span>
                  <span
                    className="fp-state"
                    style={{ color: eliminated ? 'var(--mp-fg-dim)' : STATUS_COLOR[statusKey] }}
                  >
                    {eliminated ? 'OUT' : dormant ? 'DORMANT' : (mine ? 'YOU' : STATUS_LABEL[statusKey])}
                  </span>
                  <span
                    className="fp-wt"
                    title={'Senate vote weight: 1 seat + 1 per system controlled. '
                      + "You control a system by owning more of its bodies than any rival; "
                      + 'a tie is contested and worth nothing to anyone.'}
                  >
                    ★{weightOf(f)}
                  </span>
                </button>

                <div className="fp-stats" role="row" aria-label={f.name}>
                  {/* One gate for all three: null means no Economic Intel. */}
                  <span role="cell">{f.metal === null
                    ? <span className="fp-lock" title="Economic Intel — research Sensors 4">🔒</span>
                    : compact(f.metal)}</span>
                  <span role="cell">{f.gold === null ? '' : compact(f.gold)}</span>
                  <span role="cell">{f.science === null ? '' : compact(f.science)}</span>
                  <span role="cell">{f.bodies_owned ?? 0}</span>
                  <span role="cell">{f.systems_owned ?? 0}/{systemsTotal || '—'}</span>
                  <span role="cell">
                    {f.ship_count === null
                      ? <span className="fp-lock" title="Fleet Census — research Sensors 3">🔒</span>
                      : (f.ship_count ?? 0)}
                  </span>
                </div>

                {open && (
                  <div className="fp-drawer">
                    <div className="fp-kv">
                      <span className="fp-k">Income</span>
                      {f.income === null
                        ? <span className="fp-lock" title="Economic Intel — research Sensors 4">🔒 Sensors 4</span>
                        : <IncomeChips income={f.income ?? { metal: 0, fuel: 0, gold: 0, science: 0 }} />}
                    </div>
                    <div className="fp-kv">
                      <span className="fp-k">Tech</span>
                      {f.tech_levels
                        ? <TechPips levels={f.tech_levels} />
                        : <span className="fp-lock" title="Research Intel — research Sensors 6">🔒 Sensors 6</span>}
                    </div>
                    <div className="fp-kv">
                      <span className="fp-k">Status</span>
                      <span>
                        {eliminated ? 'Eliminated — holds no seat'
                          : dormant ? 'Dormant, but alive — still holds its senate seat'
                          : mine ? 'Active'
                          : `Active · ${RELATION_TEXT[statusKey]}`}
                      </span>
                    </div>
                    {factionPacts.map(pct => (
                      <div key={pct.id} className="fp-pact">
                        <span>{PACT_LABELS[pct.kind]} · signed T+{pct.signed_at_tick}</span>
                        <button
                          onClick={() => handleBreak(pct.id)}
                          disabled={breaking === pct.id}
                          title="Unilaterally break this pact. Combat resumes on the next tick."
                        >
                          {breaking === pct.id ? 'BREAKING…' : 'BREAK'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="fp-foot">
          ★ = senate vote weight (1 seat + 1 per system).
        </div>
      </section>

      {/* ---------- paths to victory ---------- */}
      <section className="fp-sect">
        <div className="fp-sect__h"><span className="fp-lbl">Paths to victory</span></div>

        {chamber > 0 && senLeader && (
          <VictoryTrack
            label="Chancellor · senate"
            who={senLeader.name}
            color={senLeader.color}
            value={weightOf(senLeader)}
            target={chamber}
            readout={`★${weightOf(senLeader)} of ${chamber}`}
            note="a bill passes on more yea than nay among votes cast — a tie kills it"
          />
        )}

        {dyson && dysonOwner && (
          <VictoryTrack
            label="Dyson Sphere"
            who={dysonOwner.name}
            color={dysonOwner.color}
            value={dyson.hp}
            target={dyson.max_hp}
            readout={`${compact(dyson.hp)} / ${compact(dyson.max_hp)}`}
            note="completing it ends the match outright"
          />
        )}

        {bodiesTotal > 0 && domLeader && (
          <VictoryTrack
            label={`Domination · ${dominationTarget} worlds`}
            who={domLeader.name}
            color={domLeader.color}
            value={domLeader.bodies_owned ?? 0}
            target={dominationTarget}
            readout={`${domLeader.bodies_owned ?? 0} / ${dominationTarget}`}
            youAt={bodiesTotal > 0
              ? (myScore.bodies_owned ?? 0) / dominationTarget
              : undefined}
            note={`you hold ${myScore.bodies_owned ?? 0}`}
          />
        )}
      </section>

      {breakError && (
        <div className="mp-empty" style={{ color: 'var(--mp-hostile)', marginTop: 6 }}>
          {breakError}
        </div>
      )}
    </div>
  );
}

/** Dyson progress as sent by GET /factions. */
interface DysonProgress { controller: string | null; hp: number; max_hp: number }

/** Live senate weight. `senate_weight` on the row is VESTIGIAL — the
 *  senate recomputes at cast time and never writes it back, so it sits at
 *  1 forever. Prefer the computed value. */
function weightOf(f: Faction): number {
  return f.vote_weight ?? f.senate_weight ?? 1;
}

/** 32790 -> "32.8k". Keeps six columns inside a 376px panel without
 *  truncating the number that matters. */
function compact(n: number | null | undefined): string {
  const v = Math.round(Number(n ?? 0));
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Black or white, whichever reads on this faction's colour. Faction
 *  colours span white (#f5f5f5) to deep purple, so a fixed label colour
 *  is unreadable on one end or the other. */
function readableOn(hex: string): string {
  const h = (hex || '#888').replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = n.map(v => (Number.isFinite(v) ? v : 136));
  // Rec. 601 luma is good enough for a two-way pick.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0a0f16' : '#ffffff';
}

const INCOME_TINT_KEYS: Array<[keyof FactionIncome, string, string]> = [
  ['metal', 'M', 'var(--res-metal)'],
  ['gold', 'C', 'var(--res-credit)'],
  ['science', 'S', 'var(--res-science)'],
];
type FactionIncome = NonNullable<Faction['income']>;

function IncomeChips({ income }: { income: FactionIncome }) {
  const chips = INCOME_TINT_KEYS
    // Whole numbers. "+27.4M" under a "9.2k" stockpile column reads as
    // 27.4 MILLION — the decimal makes the M parse as magnitude instead
    // of metal. Rounded, coloured, and "/tick" spelled out, it parses as
    // a rate line the way the mockup's did.
    .map(([k, suffix, tint]) => ({ v: Math.round(income[k] ?? 0), suffix, tint }))
    .filter(c => c.v > 0);
  if (chips.length === 0) return <span className="fp-dim">no income</span>;
  return (
    <span className="fp-income">
      {chips.map(c => (
        <span key={c.suffix} style={{ color: c.tint }}>+{c.v}{c.suffix}</span>
      ))}
      <span className="fp-dim">/tick</span>
    </span>
  );
}

/** Six tracks as bars rather than "W10 A10 P10 C10 I10 S10" — the shape
 *  reads at a glance and the exact levels stay in the tooltip. */
function TechPips({ levels }: { levels: Record<string, number> }) {
  const tracks: Array<[string, string]> = [
    ['weapons', 'W'], ['armor', 'A'], ['propulsion', 'P'],
    ['construction', 'C'], ['industry', 'I'], ['sensors', 'S'],
  ];
  const readout = tracks.map(([k, a]) => `${a}${levels[k] ?? 0}`).join(' ');
  return (
    <span className="fp-pips-wrap">
      <span className="fp-pips" aria-hidden="true">
        {tracks.map(([k]) => (
          <i key={k} style={{ height: `${2 + 1.2 * Math.min(10, levels[k] ?? 0)}px` }} />
        ))}
      </span>
      {/* The letters are the data; the pips are the shape. The mockup
          showed both, and a tooltip is not a place to keep data. */}
      <span className="fp-pips__txt">{readout}</span>
    </span>
  );
}

/**
 * One victory path. The readout carries its own background because the
 * fill grows from the left — without it the number becomes unreadable
 * exactly as a faction approaches the threshold, which is when it matters.
 */
function VictoryTrack({
  label, who, color, value, target, readout, note, youAt,
}: {
  label: string; who: string; color: string;
  value: number; target: number; readout: string; note: string;
  /** Your own progress as a 0-1 fraction of the target, if worth marking. */
  youAt?: number;
}) {
  const pct = target > 0 ? Math.min(100, (100 * value) / target) : 0;
  return (
    <div className="fp-vt">
      <div className="fp-vt__h">
        <span className="fp-vt__t">{label}</span>
        <span className="fp-vt__who" title={who}>{who}</span>
      </div>
      <div className="fp-vt__rail">
        <div className="fp-vt__seg" style={{ width: `${pct}%`, background: color }} />
        {youAt !== undefined && youAt > 0 && youAt < 1 && (
          <div className="fp-vt__you" style={{ left: `${100 * youAt}%` }} />
        )}
        <span className="fp-vt__pct">{readout}</span>
      </div>
      <div className="fp-vt__n">{note}</div>
    </div>
  );
}
