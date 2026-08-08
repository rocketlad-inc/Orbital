import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, MyFaction, Pact, PACT_LABELS, PactKind, tradesApi } from './api';
import { displayResource } from '../game/formatResources';
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

const STATUS_COLOR: Record<keyof typeof STATUS_LABEL, string> = {
  defense_pact: '#6ee7b7',   // friendly green — full alliance
  nap: '#67e8f9',            // cool cyan — peace but not allied
  intel_share: '#a4b5c4',    // muted — info-only
  war: '#ff5e5e',            // hostile red — implicit war default
  self: 'var(--mp-fg-dim)',
};

// Per-resource tint for the income line — subtle, decoration only.
const INCOME_TINT: Record<'metal' | 'fuel' | 'gold' | 'science', string> = {
  metal: '#c9d4de',
  fuel: '#ffb84d',
  gold: '#ffd166',
  science: '#67e8f9',
};

/** Compact scoreboard line: active ship count + POOL income/tick. Shared
 *  by the "Your empire" header and every diplomacy row so a rival's
 *  economy + fleet read at a glance (full open scoreboard). Income chips
 *  hide any resource at 0 — so once fuel is retired empire-wide the fuel
 *  chip simply stops appearing. */
const TECH_ABBR: Array<[string, string]> = [
  ['weapons', 'W'], ['armor', 'A'], ['propulsion', 'P'],
  ['construction', 'C'], ['industry', 'I'], ['sensors', 'S'],
];
const Locked = ({ tip }: { tip: string }) => (
  <span title={tip} style={{ opacity: 0.7, color: '#ffb84d' }}>🔒</span>
);

/** Fraction of all worlds one empire must hold to win outright.
 *  Mirrors DOMINATION_FRACTION in worker/room.js — KEEP IN SYNC. */
const DOMINATION_FRACTION = 0.6;

/**
 * Worlds held, shown against the domination threshold.
 *
 * A bare "12 worlds" doesn't answer the question players actually have,
 * which is "how close is this empire to winning". The share does, so the
 * count leads with it and tints as the threshold approaches.
 */
function WorldsHeld({ f }: { f: Faction }) {
  const owned = f.bodies_owned ?? 0;
  const total = f.bodies_total ?? 0;
  if (total <= 0) return null;
  const share = owned / total;
  const needed = Math.floor(total * DOMINATION_FRACTION) + 1;
  // Amber inside striking distance, red once domination is one push
  // away — the same escalation the runaway-leader warning uses.
  const near = share >= DOMINATION_FRACTION * 0.75;
  const critical = share >= DOMINATION_FRACTION;
  const color = critical ? '#ff5e5e' : near ? '#ffb84d' : undefined;
  return (
    <span
      title={`Holds ${owned} of ${total} worlds (${Math.round(100 * share)}%). `
        + `Domination victory at ${Math.round(100 * DOMINATION_FRACTION)}% — ${needed} worlds.`}
      style={{ fontVariantNumeric: 'tabular-nums', color, fontWeight: critical ? 700 : undefined }}
    >
      ◍ {owned} {owned === 1 ? 'world' : 'worlds'}
      <span style={{ opacity: 0.6 }}> ({Math.round(100 * share)}%)</span>
    </span>
  );
}

/**
 * Systems controlled, and the senate vote it buys.
 *
 * Worlds answer "how much do they hold"; systems answer "how much of the
 * chamber do they own", and the two come apart badly — five worlds
 * scattered across five systems you don't lead is 0 extra votes, while
 * five in one system is 1. Showing the derived VOTE is the point: it is
 * the chancellor win condition, and players were reading territory as a
 * proxy for it.
 */
function SystemsHeld({ f }: { f: Faction }) {
  const owned = f.systems_owned ?? 0;
  const total = f.systems_total ?? 0;
  if (total <= 0) return null;
  // Server-computed (factions.js) so the "eliminated holds no seat" rule
  // isn't duplicated here; fall back to the plain formula only if an
  // older server didn't send it.
  const weight = f.vote_weight ?? owned + 1;
  return (
    <span
      title={`Controls ${owned} of ${total} systems — senate vote weight ${weight} `
        + `(1 seat + 1 per system).${(f.systems_open ?? 0) > 0
          ? ` ${f.systems_open} still unclaimed or deadlocked.` : ''} `
        + 'You control a system by owning more of its bodies than anyone else; '
        + 'a tie is contested and worth nothing to anyone.'}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {/* No weight repeated here — the ★ badge in the header carries it. */}
      ◉ {owned} {owned === 1 ? 'system' : 'systems'}
      <span style={{ opacity: 0.6 }}> of {total}</span>
    </span>
  );
}

function ScoreboardStats({ f }: { f: Faction }) {
  const income = f.income;
  // null = intel-gated (show a lock). undefined = ungated/own (show data).
  const censusLocked = f.ship_count === null;
  const economyLocked = income === null;
  const chips = income
    ? (['metal', 'fuel', 'gold', 'science'] as const)
        .map((k) => ({ k, v: income[k] ?? 0 }))
        .filter((c) => c.v > 0)
    : [];
  const researchIntel = f.tech_levels; // present only with Research Intel
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div
        className="mp-scoreboard"
        style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          gap: 8, fontSize: 11, color: 'var(--mp-fg-dim)',
        }}
      >
        <span title="Active ships" style={{ fontVariantNumeric: 'tabular-nums' }}>
          ⬡ {censusLocked
            ? <Locked tip="Fleet Census — research Sensors 3 to see rival ship counts" />
            : `${f.ship_count ?? 0} ${(f.ship_count ?? 0) === 1 ? 'ship' : 'ships'}`}
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        {/* Worlds held — the domination win condition, so it is never
            intel-gated and leads with how close this empire is to the
            60% threshold rather than a bare count. */}
        <WorldsHeld f={f} />
        <span style={{ opacity: 0.4 }}>·</span>
        {/* Systems — the senate's currency. Sits next to worlds because
            the two diverge: territory spread thin across systems you
            don't lead buys no votes at all. */}
        <SystemsHeld f={f} />
        <span style={{ opacity: 0.4 }}>·</span>
        {economyLocked ? (
          <span><Locked tip="Economic Intel — research Sensors 4 to see rival income" /> income</span>
        ) : chips.length === 0 ? (
          <span style={{ opacity: 0.6 }}>no income</span>
        ) : (
          <span
            title="Pool income per tick (before senate effects)"
            style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}
          >
            {chips.map((c) => (
              <span key={c.k} style={{ color: INCOME_TINT[c.k] }}>
                +{c.v}{c.k === 'metal' ? 'M' : c.k === 'fuel' ? 'F' : c.k === 'gold' ? 'C' : 'S'}
              </span>
            ))}
            <span style={{ opacity: 0.6 }}>/t</span>
          </span>
        )}
      </div>
      {researchIntel && (
        <div
          title="Research Intel — rival tech levels"
          style={{ display: 'flex', gap: 7, fontSize: 10, color: 'var(--mp-fg-dim)', fontVariantNumeric: 'tabular-nums' }}
        >
          <span style={{ opacity: 0.6 }}>🔬</span>
          {TECH_ABBR.map(([key, abbr]) => (
            <span key={key}>{abbr}{researchIntel[key] ?? 0}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function FactionPanel({ gameId }: { gameId: string }) {
  const [me, setMe] = useState<MyFaction | null>(null);
  const [roster, setRoster] = useState<Faction[]>([]);
  const [pacts, setPacts] = useState<Pact[]>([]);
  const [breaking, setBreaking] = useState<string | null>(null);
  const [breakError, setBreakError] = useState<string | null>(null);

  const tradesApiClient = useMemo(() => tradesApi(gameId), [gameId]);

  const refresh = useCallback(async () => {
    const [meRes, listRes, pactsRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      tradesApiClient.listPacts(),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (listRes.ok) setRoster(listRes.data.factions);
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

  const others = roster.filter((f) => f.id !== me.id);
  // My own scoreboard (income + ship count) lives on the roster entry —
  // /me doesn't carry it. Fall back to a bare object so the line still
  // renders before the roster fetch lands.
  const myScore = roster.find((f) => f.id === me.id) ?? (me as Faction);

  return (
    <div>
      <div className="mp-section-title">Your empire</div>
      <div className="mp-row" style={{ gap: 8 }}>
        <FlagChip className="mp-swatch" color={me.color} color2={me.color2}
                  emblem={me.emblem} fallbackKey={me.id} size={20} />
        <strong style={{ fontSize: 13 }}>{me.name}</strong>
      </div>
      <div className="mp-resource-grid">
        {/* All three go through displayResource: the pools drift
            fractional (research drain + treaty payouts subtract floats),
            and science was rendering as 181.9399999999999. Same helper the
            top-bar pills use, so the two can't show different numbers for
            the same resource. */}
        <div className="mp-resource-tile"><div className="label">Metal</div><div className="value">{displayResource(me.metal)}</div></div>
        {/* Fuel tile removed — fuel left the economy (§1.1). Legacy
            stockpiles still exist on old factions but earn nothing and
            buy nothing, so showing them was pure confusion. */}
        <div className="mp-resource-tile"><div className="label">Credits</div><div className="value">{displayResource(me.gold)}</div></div>
        <div className="mp-resource-tile"><div className="label">Science</div><div className="value">{displayResource(me.science)}</div></div>
      </div>
      <div style={{ marginTop: 6 }}>
        <ScoreboardStats f={myScore} />
      </div>

      <div className="mp-section-title" style={{ marginTop: 12 }}>Diplomacy</div>
      {others.length === 0 ? (
        <div className="mp-empty">No other factions yet.</div>
      ) : (
        others.map((f) => {
          const eliminated = f.status === 'eliminated';
          const top = topPactKind(f.id);
          const factionPacts = pactsByFaction.get(f.id) ?? [];
          const statusKey: keyof typeof STATUS_LABEL = eliminated
            ? 'self'
            : top ?? 'war';
          return (
            <div
              key={f.id}
              className="mp-presence-row"
              style={{ flexWrap: 'wrap', borderBottom: '1px solid var(--mp-border)', padding: '6px 0' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <FlagChip className="mp-swatch" color={f.color} color2={f.color2}
                          emblem={f.emblem} fallbackKey={f.id} />
                <span style={{
                  textDecoration: eliminated ? 'line-through' : 'none',
                  flex: 1,
                }}>
                  {f.name}
                </span>
                {!eliminated && (
                  <span style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    color: STATUS_COLOR[statusKey],
                    padding: '2px 8px',
                    border: `1px solid ${STATUS_COLOR[statusKey]}`,
                    borderRadius: 2,
                  }}>
                    {STATUS_LABEL[statusKey] || 'ELIMINATED'}
                  </span>
                )}
                <span
                  className="meta"
                  style={{ color: 'var(--mp-fg-dim)', fontSize: 10 }}
                  title={
                    'Senate vote weight: 1 + 1 per system controlled. '
                    + 'A faction controls a system when it owns more of that '
                    + "system's bodies than anyone else; ties are contested "
                    + 'and count for nobody.'
                  }
                >
                  {/* vote_weight is computed live from systems controlled.
                      game_factions.senate_weight is a VESTIGIAL column —
                      the senate recomputes weight at cast time and never
                      writes it back, so it sits at 1 for every faction
                      forever. This badge was showing that 1 while the
                      tooltip described the real rule, so an empire with 13
                      votes read as having 1. */}
                  ★ {f.vote_weight ?? f.senate_weight}
                </span>
              </div>
              {!eliminated && (
                <div style={{ width: '100%', marginTop: 4, marginLeft: 18 }}>
                  <ScoreboardStats f={f} />
                </div>
              )}
              {factionPacts.length > 0 && (
                <div style={{
                  width: '100%', marginTop: 4, marginLeft: 18,
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}>
                  {factionPacts.map(p => (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 11, color: 'var(--mp-fg-dim)',
                    }}>
                      <span style={{ flex: 1 }}>
                        {PACT_LABELS[p.kind]} · signed T+{p.signed_at_tick}
                      </span>
                      <button
                        onClick={() => handleBreak(p.id)}
                        disabled={breaking === p.id}
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: 10,
                          letterSpacing: '0.06em',
                          background: 'transparent',
                          color: '#ff5e5e',
                          border: '1px solid #ff5e5e',
                          padding: '2px 8px',
                          borderRadius: 2,
                          cursor: breaking === p.id ? 'wait' : 'pointer',
                          opacity: breaking === p.id ? 0.5 : 1,
                        }}
                        title="Unilaterally break this pact. Combat resumes on the next tick."
                      >
                        {breaking === p.id ? 'BREAKING…' : 'BREAK'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
      {breakError && (
        <div className="mp-empty" style={{ color: 'var(--mp-hostile)', marginTop: 6 }}>
          {breakError}
        </div>
      )}
    </div>
  );
}
