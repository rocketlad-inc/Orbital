import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, SenateProposal, SenateSlider } from './api';

// Per-proposal duration bounds — mirror worker/senate.js
// DEBATE_MIN/MAX + VOTE_MIN/MAX so the input gates match server-side
// validation (server clamps + rejects out-of-range).
const DEBATE_MIN = 1, DEBATE_MAX = 48, DEBATE_DEFAULT = 2;
const VOTE_MIN   = 1, VOTE_MAX   = 24, VOTE_DEFAULT   = 1;

/** Bill kinds the server accepts. Slider law is the legacy default.
 *  Targeted sanctions plus the Chancellor election bill all carry a
 *  faction-id pointer; we drive the right composer fields off this. */
type BillKind =
  | 'slider_law'
  | 'trade_embargo'
  | 'war_authorization'
  | 'production_sanction'
  | 'reparations'
  | 'chancellor_vote';

const BILL_KIND_LABELS: Record<BillKind, string> = {
  slider_law:          'Slider Law (global multiplier)',
  trade_embargo:       'Trade Embargo (target loses trade for 14t)',
  war_authorization:   'War Authorization (2× damage TO target, 21t)',
  production_sanction: 'Production Sanction (½ target yield, 14t)',
  reparations:         'Reparations (target pays credits to all)',
  chancellor_vote:     'Call for Supreme Chancellor (election — game-ending)',
};

/** Bill kinds that need a faction id in their payload. Drives the target
 *  picker render below; chancellor_vote uses candidate_faction_id, the
 *  rest use target_faction_id. */
const NEEDS_TARGET: Record<BillKind, boolean> = {
  slider_law:          false,
  trade_embargo:       true,
  war_authorization:   true,
  production_sanction: true,
  reparations:         true,
  chancellor_vote:     true,
};

const STATUS_COLORS: Record<SenateProposal['status'], string> = {
  debating:  '#ffb84d',   // amber: still cooking
  voting:    '#6ee7b7',   // green: act now
  passed:    '#4ecdc4',
  failed:    '#ff5e5e',
  withdrawn: '#8a9fb3',
};

const STATUS_LABEL: Record<SenateProposal['status'], string> = {
  debating:  'DEBATING',
  voting:    'VOTING NOW',
  passed:    'RATIFIED',
  failed:    'FAILED',
  withdrawn: 'WITHDRAWN',
};

export function SenatePanel({ gameId }: { gameId: string }) {
  const [sliders, setSliders] = useState<SenateSlider[]>([]);
  const [currentTick, setCurrentTick] = useState<number>(0);
  const [proposals, setProposals] = useState<SenateProposal[]>([]);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [myFactionId, setMyFactionId] = useState<string | null>(null);

  // Composer state
  const [kind, setKind] = useState<BillKind>('slider_law');
  const [sliderId, setSliderId] = useState<string>('');
  const [target, setTarget] = useState<number>(1);
  const [targetFactionId, setTargetFactionId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [debateTicks, setDebateTicks] = useState<number>(DEBATE_DEFAULT);
  const [voteTicks, setVoteTicks] = useState<number>(VOTE_DEFAULT);

  const refresh = useCallback(async () => {
    const [sRes, pRes, fRes] = await Promise.all([
      apiFetch<{ sliders: SenateSlider[]; current_tick: number }>(`/api/games/${gameId}/senate/sliders`),
      apiFetch<{ proposals: SenateProposal[] }>(`/api/games/${gameId}/senate/proposals`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
    ]);
    if (sRes.ok) {
      setSliders(sRes.data.sliders);
      setCurrentTick(sRes.data.current_tick);
      if (!sliderId && sRes.data.sliders.length) {
        setSliderId(sRes.data.sliders[0].id);
        setTarget(sRes.data.sliders[0].default);
      }
    }
    if (pRes.ok) setProposals(pRes.data.proposals);
    if (fRes.ok) setFactions(fRes.data.factions);
  }, [gameId, sliderId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Learn caller's faction id once so the Withdraw button knows when
  // to show (proposer-only on the server side; client mirrors to
  // avoid a confusing 403 click).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ faction: { id: string } }>(`/api/games/${gameId}/me`);
      if (!cancelled && res.ok && res.data?.faction?.id) setMyFactionId(res.data.faction.id);
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  // External refresh — MultiplayerShell broadcasts a 'mp:senate-refresh'
  // window event when a WS notification arrives, so the panel reacts
  // immediately instead of waiting for the next 5s poll.
  useEffect(() => {
    const onExternal = () => { void refresh(); };
    window.addEventListener('mp:senate-refresh', onExternal);
    return () => window.removeEventListener('mp:senate-refresh', onExternal);
  }, [refresh]);

  const factionsById = useMemo(() => {
    const m = new Map<string, Faction>();
    for (const f of factions) m.set(f.id, f);
    return m;
  }, [factions]);

  const selectedSlider = useMemo(
    () => sliders.find((s) => s.id === sliderId) ?? null,
    [sliders, sliderId],
  );

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !summary.trim()) {
      setError('Title and summary are required.');
      return;
    }
    // Per-kind body shape — server validates each branch in
    // buildBillPayload (worker/senate.js). Mirror the same field names
    // here so a 400 surfaces as a real message instead of an opaque
    // "bad request" the user can't act on.
    const body: Record<string, unknown> = {
      kind,
      title: title.trim(),
      summary: summary.trim(),
      debate_ticks: debateTicks,
      vote_ticks: voteTicks,
    };
    if (kind === 'slider_law') {
      if (!selectedSlider) { setError('Pick a slider.'); return; }
      body.slider_id = selectedSlider.id;
      body.target_value = target;
    } else if (kind === 'chancellor_vote') {
      if (!targetFactionId) { setError('Pick a candidate.'); return; }
      body.candidate_faction_id = targetFactionId;
    } else {
      // Targeted sanctions: trade_embargo, war_authorization,
      // production_sanction, reparations
      if (!targetFactionId) { setError('Pick a target faction.'); return; }
      if (targetFactionId === myFactionId) {
        setError('Cannot target your own faction.');
        return;
      }
      body.target_faction_id = targetFactionId;
    }
    setBusy(true);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) { setError(res.error?.message ?? 'Could not propose'); return; }
    setTitle(''); setSummary('');
    setTargetFactionId('');
    setDebateTicks(DEBATE_DEFAULT); setVoteTicks(VOTE_DEFAULT);
    refresh();
  }

  async function castVote(proposalId: string, vote: 'yea' | 'nay' | 'abstain') {
    setError(null);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals/${proposalId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ vote }),
    });
    if (!res.ok) setError(res.error?.message ?? 'Vote failed');
    refresh();
  }

  async function withdraw(proposalId: string) {
    setError(null);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals/${proposalId}/withdraw`, {
      method: 'POST',
    });
    if (!res.ok) setError(res.error?.message ?? 'Withdraw failed');
    refresh();
  }

  // Caller's own faction id is needed to gate the Withdraw button. We
  // know it by looking up which proposal the caller proposed AND has
  // a faction row (the proposer_faction_id field on those proposals).
  // For new games the SenatePanel can derive it from the factions
  // list, but more reliably we just remember which proposals the
  // caller has voted on or owns. Simplest: pull /me to learn faction
  // id once, since SenatePanel already has access to /factions.
  // Track it once and reuse.

  // Order proposals: VOTING first (act now), then DEBATING, then
  // resolved. Within each group, soonest-closing first.
  const sortedProposals = useMemo(() => {
    const rank = (p: SenateProposal): number => {
      if (p.status === 'voting')   return 0;
      if (p.status === 'debating') return 1;
      return 2;
    };
    return [...proposals].sort((a, b) => {
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return a.vote_closes_at_tick - b.vote_closes_at_tick;
    });
  }, [proposals]);

  return (
    <div>
      <div className="mp-section-title">Propose a bill</div>
      <form onSubmit={propose}>
        <label className="mp-label">Kind</label>
        <select
          className="mp-select"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as BillKind);
            setTargetFactionId('');     // reset so a stale target doesn't carry across kinds
          }}
        >
          {(Object.keys(BILL_KIND_LABELS) as BillKind[]).map(k => (
            <option key={k} value={k}>{BILL_KIND_LABELS[k]}</option>
          ))}
        </select>

        {kind === 'slider_law' && (
          <>
            <label className="mp-label">Slider</label>
            <select
              className="mp-select"
              value={sliderId}
              onChange={(e) => {
                setSliderId(e.target.value);
                const s = sliders.find((x) => x.id === e.target.value);
                if (s) setTarget(s.effective_value);
              }}
            >
              {sliders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} (now {fmtNum(s.effective_value)})
                </option>
              ))}
            </select>
            {selectedSlider && (
              <>
                <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
                  {selectedSlider.description}
                </div>
                <label className="mp-label">
                  Target value (range {selectedSlider.min}–{selectedSlider.max}; default {selectedSlider.default})
                </label>
                <input
                  className="mp-input"
                  type="number"
                  inputMode="decimal"
                  step={selectedSlider.step || 'any'}
                  min={selectedSlider.min}
                  max={selectedSlider.max}
                  value={target}
                  onChange={(e) => setTarget(parseFloat(e.target.value))}
                />
              </>
            )}
          </>
        )}

        {NEEDS_TARGET[kind] && (
          <>
            <label className="mp-label">
              {kind === 'chancellor_vote' ? 'Candidate (can be yourself)' : 'Target faction'}
            </label>
            <select
              className="mp-select"
              value={targetFactionId}
              onChange={(e) => setTargetFactionId(e.target.value)}
            >
              <option value="">— choose —</option>
              {factions
                // Sanctions can't target self; chancellor_vote can. Filter
                // accordingly so an invalid choice isn't even presented.
                .filter(f => kind === 'chancellor_vote' || f.id !== myFactionId)
                .map(f => (
                  <option key={f.id} value={f.id}>
                    {f.name}{f.id === myFactionId ? ' (you)' : ''}
                  </option>
                ))}
            </select>
            {kind === 'chancellor_vote' && (
              <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4, fontStyle: 'italic' }}>
                One attempt per faction per game. If this bill PASSES, the
                candidate wins — match ends. Failed bids burn your shot.
              </div>
            )}
          </>
        )}
        <label className="mp-label">Title</label>
        <input
          className="mp-input"
          type="text"
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="mp-label">Summary</label>
        <textarea
          className="mp-textarea"
          maxLength={500}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label className="mp-label">Debate ticks ({DEBATE_MIN}–{DEBATE_MAX})</label>
            <input
              className="mp-input"
              type="number"
              inputMode="numeric"
              min={DEBATE_MIN}
              max={DEBATE_MAX}
              value={debateTicks}
              onChange={(e) => setDebateTicks(parseInt(e.target.value, 10) || DEBATE_DEFAULT)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="mp-label">Vote ticks ({VOTE_MIN}–{VOTE_MAX})</label>
            <input
              className="mp-input"
              type="number"
              inputMode="numeric"
              min={VOTE_MIN}
              max={VOTE_MAX}
              value={voteTicks}
              onChange={(e) => setVoteTicks(parseInt(e.target.value, 10) || VOTE_DEFAULT)}
            />
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
          Voting opens at tick {currentTick + debateTicks} · closes at tick {currentTick + debateTicks + voteTicks}
        </div>

        <button className="mp-submit" type="submit" style={{ marginTop: 10 }} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit proposal'}
        </button>
        {error && <div className="mp-error" style={{ marginTop: 6 }}>{error}</div>}
      </form>

      <div className="mp-section-title" style={{ marginTop: 16 }}>
        Proposals · tick {currentTick}
      </div>
      {sortedProposals.length === 0 && (
        <div className="mp-empty">No proposals on the floor.</div>
      )}
      {sortedProposals.map((p) => {
        const proposer = p.proposer_faction_id ? factionsById.get(p.proposer_faction_id) : null;
        const inVoting = p.status === 'voting';
        const ticksUntilOpen  = Math.max(0, p.vote_opens_at_tick  - currentTick);
        const ticksUntilClose = Math.max(0, p.vote_closes_at_tick - currentTick);
        const my = p.caller_vote;

        return (
          <div key={p.id} className="mp-proposal">
            <div className="ptitle">{p.title}</div>
            <div className="pmeta" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {proposer && (
                <>
                  <span className="mp-swatch" style={{ background: proposer.color }} />
                  <span>{proposer.name}</span>
                  <span>·</span>
                </>
              )}
              <span style={{ color: STATUS_COLORS[p.status], fontWeight: 600 }}>
                {STATUS_LABEL[p.status]}
              </span>
              {p.status === 'debating' && (<><span>·</span><span>voting opens T+{ticksUntilOpen}</span></>)}
              {p.status === 'voting' && (
                <><span>·</span><span style={{ color: STATUS_COLORS.voting }}>closes in T+{ticksUntilClose}</span></>
              )}
              {(p.status === 'passed' || p.status === 'failed') && p.resolved_at_tick != null && (
                <><span>·</span><span>at tick {p.resolved_at_tick}</span></>
              )}
            </div>
            <div className="psummary">{p.summary}</div>
            <ProposalEffectLine
              proposal={p}
              factionsById={factionsById}
            />
            {/* New bill-kind tag — small chip showing what kind of bill
                this is, since slider-law and a chancellor-vote look very
                different in consequence. */}
            <div style={{
              display: 'inline-block', fontSize: 9, color: '#b8c8d6',
              border: '1px solid #2a3d50', borderRadius: 8,
              padding: '1px 6px', marginTop: 4, letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {(BILL_KIND_LABELS[p.kind as BillKind] ?? p.kind).split(' (')[0]}
            </div>

            <VoteBar totals={p.totals} />

            {inVoting && (
              <div className="mp-vote-row">
                <button
                  className={`mp-vote-btn yea ${my === 'yea' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'yea')}
                >Yea</button>
                <button
                  className={`mp-vote-btn nay ${my === 'nay' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'nay')}
                >Nay</button>
                <button
                  className={`mp-vote-btn abstain ${my === 'abstain' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'abstain')}
                >Abstain</button>
              </div>
            )}
            {p.status === 'debating' && (
              <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4, fontStyle: 'italic' }}>
                Voting opens in {ticksUntilOpen} tick{ticksUntilOpen === 1 ? '' : 's'}.
                {my && <> Your early vote: <strong>{my}</strong></>}
              </div>
            )}
            {/* Withdraw is proposer-only + debating-only (server-side gate). Mirror
                that here so the button doesn't show up where it can't do anything. */}
            {p.status === 'debating' && myFactionId && p.proposer_faction_id === myFactionId && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => { void withdraw(p.id); }}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--mp-border)',
                    color: 'var(--mp-fg-dim)',
                    padding: '4px 10px',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    borderRadius: 2,
                  }}
                  title="Pull this proposal off the floor before voting opens"
                >
                  ✕ Withdraw
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Tidy number formatter — 1.0 → "1", 1.25 → "1.25", 0.8 → "0.8".
function fmtNum(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * One-line summary of what a bill DOES, switching on kind. Sits under the
 * proposal's freeform summary so the player can see the mechanical
 * effect at a glance — "Embargoes Mars Confederacy" — without having to
 * read the proposer's prose to understand the consequences.
 */
function ProposalEffectLine({
  proposal: p,
  factionsById,
}: {
  proposal: SenateProposal;
  factionsById: Map<string, Faction>;
}) {
  const k = p.kind as BillKind;
  const targetId = p.payload?.target_faction_id || p.payload?.candidate_faction_id;
  const targetName = targetId ? (factionsById.get(targetId)?.name ?? targetId) : null;
  const wrap = (s: React.ReactNode) => (
    <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
      {s}
      {p.effect_until_tick != null && p.status === 'passed' && (
        <> · active until tick {p.effect_until_tick}</>
      )}
    </div>
  );

  if (k === 'slider_law' && p.payload?.slider_id) {
    return wrap(<>
      Sets <strong>{p.payload.slider_id}</strong> to <strong>{fmtNum(p.payload.target_value)}</strong>
    </>);
  }
  if (!targetName) return null;
  if (k === 'trade_embargo')       return wrap(<>Embargoes <strong>{targetName}</strong> from trade for 14 ticks</>);
  if (k === 'war_authorization')   return wrap(<>Doubles damage TO <strong>{targetName}</strong> for 21 ticks (peace pacts broken)</>);
  if (k === 'production_sanction') return wrap(<>Halves <strong>{targetName}</strong>'s yields for 14 ticks</>);
  if (k === 'reparations')         return wrap(<><strong>{targetName}</strong> pays reparations to every other faction</>);
  if (k === 'chancellor_vote')     return wrap(<>If passed, <strong>{targetName}</strong> wins the game as Supreme Chancellor</>);
  return null;
}

// Vote weight bar. Source of truth for ratification is WEIGHT (one
// vote per body owned), not count (one per faction). Count is shown
// alongside so it's clear how many factions a weight represents.
function VoteBar({ totals }: { totals: SenateProposal['totals'] }) {
  const yeaW     = totals?.yea?.weight     ?? 0;
  const nayW     = totals?.nay?.weight     ?? 0;
  const abstainW = totals?.abstain?.weight ?? 0;
  const total = yeaW + nayW + abstainW;

  if (total === 0) {
    return (
      <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
        No votes cast yet.
      </div>
    );
  }

  const pctY = (yeaW     / total) * 100;
  const pctN = (nayW     / total) * 100;
  const pctA = (abstainW / total) * 100;

  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: 'flex',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ width: `${pctY}%`, background: '#6ee7b7' }} />
        <div style={{ width: `${pctN}%`, background: '#ff5e5e' }} />
        <div style={{ width: `${pctA}%`, background: '#8a9fb3' }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
        Yea {yeaW} ({totals.yea.count}) ·
        Nay {nayW} ({totals.nay.count}) ·
        Abstain {abstainW} ({totals.abstain.count})
      </div>
    </div>
  );
}
