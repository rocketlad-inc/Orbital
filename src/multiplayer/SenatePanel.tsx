import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, SenateProposal, SenateSlider } from './api';

export function SenatePanel({ gameId }: { gameId: string }) {
  const [sliders, setSliders] = useState<SenateSlider[]>([]);
  const [currentTick, setCurrentTick] = useState<number>(0);
  const [proposals, setProposals] = useState<SenateProposal[]>([]);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [error, setError] = useState<string | null>(null);

  // New-proposal composer state
  const [sliderId, setSliderId] = useState<string>('');
  const [target, setTarget] = useState<number>(1);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');

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
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals`, {
      method: 'POST',
      body: JSON.stringify({
        slider_id: selectedSlider.id,
        target_value: target,
        title: title.trim(),
        summary: summary.trim(),
      }),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Could not propose'); return; }
    setTitle(''); setSummary('');
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

  return (
    <div>
      <div className="mp-section-title">Propose a law</div>
      <form onSubmit={propose}>
        <select
          className="mp-select"
          value={sliderId}
          onChange={(e) => {
            setSliderId(e.target.value);
            const s = sliders.find((x) => x.id === e.target.value);
            if (s) setTarget(s.effective);
          }}
        >
          {sliders.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} (now {s.effective})
            </option>
          ))}
        </select>
        {selectedSlider && (
          <>
            <label className="mp-label">
              Target value (range {selectedSlider.min}–{selectedSlider.max}; default {selectedSlider.default})
            </label>
            <input
              className="mp-input"
              type="number"
              step="any"
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
        <button className="mp-submit" type="submit" style={{ marginTop: 6 }}>Submit proposal</button>
        <div className="mp-error">{error || ''}</div>
      </form>

      <div className="mp-section-title" style={{ marginTop: 16 }}>Proposals · tick {currentTick}</div>
      {proposals.length === 0 && <div className="mp-empty">No proposals.</div>}
      {proposals.map((p) => {
        const proposer = p.proposer_faction_id ? factionsById.get(p.proposer_faction_id) : null;
        const inVoting = p.status === 'voting';
        const v = p.votes ?? { yea: 0, nay: 0, abstain: 0 };
        const my = p.my_vote;
        return (
          <div key={p.id} className="mp-proposal">
            <div className="ptitle">{p.title}</div>
            <div className="pmeta">
              {proposer && <><span className="mp-swatch" style={{ background: proposer.color }} />{proposer.name} · </>}
              {p.status.toUpperCase()} · debate→{p.vote_opens_at_tick}, close→{p.vote_closes_at_tick}
            </div>
            <div className="psummary">{p.summary}</div>
            <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)' }}>
              Yea {v.yea} · Nay {v.nay} · Abstain {v.abstain}
            </div>
            {inVoting && (
              <div className="mp-vote-row">
                <button className={`mp-vote-btn yea ${my === 'yea' ? 'mine' : ''}`} onClick={() => castVote(p.id, 'yea')}>Yea</button>
                <button className={`mp-vote-btn nay ${my === 'nay' ? 'mine' : ''}`} onClick={() => castVote(p.id, 'nay')}>Nay</button>
                <button className={`mp-vote-btn abstain ${my === 'abstain' ? 'mine' : ''}`} onClick={() => castVote(p.id, 'abstain')}>Abstain</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
