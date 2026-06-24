import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, SenateProposal, SenateSlider } from './api';

// Per-proposal duration bounds — mirror worker/senate.js
// DEBATE_MIN/MAX + VOTE_MIN/MAX so the input gates match server-side
// validation (server clamps + rejects out-of-range).
const DEBATE_MIN = 1, DEBATE_MAX = 48, DEBATE_DEFAULT = 2;
const VOTE_MIN   = 1, VOTE_MAX   = 24, VOTE_DEFAULT   = 1;

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

  // Composer state
  const [sliderId, setSliderId] = useState<string>('');
  const [target, setTarget] = useState<number>(1);
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
    if (!selectedSlider) return;
    if (!title.trim() || !summary.trim()) {
      setError('Title and summary are required.');
      return;
    }
    setBusy(true);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals`, {
      method: 'POST',
      body: JSON.stringify({
        slider_id: selectedSlider.id,
        target_value: target,
        title: title.trim(),
        summary: summary.trim(),
        debate_ticks: debateTicks,
        vote_ticks: voteTicks,
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(res.error?.message ?? 'Could not propose'); return; }
    setTitle(''); setSummary('');
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
      <div className="mp-section-title">Propose a law</div>
      <form onSubmit={propose}>
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
            {p.payload?.slider_id && (
              <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
                Sets <strong>{p.payload.slider_id}</strong> to <strong>{fmtNum(p.payload.target_value)}</strong>
                {p.effect_until_tick != null && p.status === 'passed' && (
                  <> · active until tick {p.effect_until_tick}</>
                )}
              </div>
            )}

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
