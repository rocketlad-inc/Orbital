import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, MyFaction, Pact, PACT_LABELS, PactKind, tradesApi } from './api';

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
  nap: 'NAP',
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

  return (
    <div>
      <div className="mp-section-title">Your empire</div>
      <div className="mp-row" style={{ gap: 8 }}>
        <span className="mp-swatch" style={{ background: me.color }} />
        <strong style={{ fontSize: 13 }}>{me.name}</strong>
      </div>
      <div className="mp-resource-grid">
        <div className="mp-resource-tile"><div className="label">Metal</div><div className="value">{me.metal}</div></div>
        <div className="mp-resource-tile"><div className="label">Fuel</div><div className="value">{me.fuel}</div></div>
        <div className="mp-resource-tile"><div className="label">Credits</div><div className="value">{me.gold}</div></div>
        <div className="mp-resource-tile"><div className="label">Science</div><div className="value">{me.science}</div></div>
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
                <span className="mp-swatch" style={{ background: f.color }} />
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
