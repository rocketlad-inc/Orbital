import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, MyFaction, Pact, PACT_LABELS, PactKind, tradesApi } from './api';
import { deriveSecondary } from '../game/colorUtils';
import { displayResource } from '../game/formatResources';

/** Two-tone (§5) chip: primary square with a secondary corner.
 *  decoration only — meaning must stay in primary. */
function twoToneChip(color: string, color2?: string | null): React.CSSProperties {
  const c2 = color2 || deriveSecondary(color);
  return {
    // Secondary occupies the bottom-right corner; primary keeps ~75%
    // of the chip so ownership stays legible at a glance.
    background: `linear-gradient(135deg, ${color} 0%, ${color} 68%, ${c2} 68%, ${c2} 100%)`,
  };
}

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
        <span className="mp-swatch" style={twoToneChip(me.color, me.color2)} />
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
                <span className="mp-swatch" style={twoToneChip(f.color, f.color2)} />
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
                <span className="meta" style={{ color: 'var(--mp-fg-dim)', fontSize: 10 }}>
                  ★ {f.senate_weight}
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
