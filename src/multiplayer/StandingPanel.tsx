// ============================================================
// StandingPanel — where you stand with every other empire, and the only
// place a war can be started or stopped.
//
// This exists because the game's default flipped. Hostility used to be
// the absence of a treaty: everyone shot everyone from tick one, and a
// non-aggression pact negotiated inside a trade deal was the only way
// out. Peace is now the default and free, and shooting requires a
// declaration — so there has to be somewhere to declare.
//
// One row per empire, and the row says the whole truth: AT WAR, ALLIED,
// or at peace. "At peace" is not an achievement and is not dressed up as
// one — it is what two empires are when neither has done anything, and
// the row is deliberately quiet.
//
// Mounts outside any assumption about GameContext, like the other dock
// panels: everything it shows is fetched.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, warsApi, WarRow, Faction, MyFaction, Pact } from './api';
import { logUiEvent } from './telemetry';
import './StandingPanel.css';

type Props = { gameId: string };

/** The pact kinds that make two empires allies. Mirrors the server's
 *  peacePairs — intel-share is deliberately not one, because the tick
 *  has never treated it as such. */
const ALLY_KINDS = new Set(['nap', 'defense_pact']);

/** One round trip for the whole dock. `/trade-summary` composes the
 *  same handlers in-process, and wars ride along with the pacts because
 *  the two are always read together. */
type Summary = {
  me: { faction: MyFaction } | null;
  factions: { factions: Faction[] } | null;
  pacts: { pacts: Pact[] } | null;
  wars: { wars: WarRow[] } | null;
};

export function StandingPanel({ gameId }: Props) {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [wars, setWars] = useState<WarRow[]>([]);
  const [allies, setAllies] = useState<Set<string>>(new Set());
  const [meId, setMeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const api = warsApi(gameId);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Summary>(`/api/games/${gameId}/trade-summary`);
      setFactions(d?.factions?.factions ?? []);
      setWars(d?.wars?.wars ?? []);
      setMeId(d?.me?.faction?.id ?? null);
      // counterparty_faction_ids is the OTHER signatories, caller
      // excluded, so an ally is simply anyone named in an active pact of
      // an allying kind — no pair arithmetic needed.
      const set = new Set<string>();
      for (const p of d?.pacts?.pacts ?? []) {
        if (p.status !== 'active' || !ALLY_KINDS.has(p.kind)) continue;
        for (const id of p.counterparty_faction_ids ?? []) set.add(id);
      }
      setAllies(set);
      setError(null);
    } catch {
      setError('Could not read the diplomatic standing.');
    }
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  const openWarWith = (fid: string) =>
    wars.find(w => w.open && w.factions.includes(fid) && (meId ? w.factions.includes(meId) : false));

  const run = async (fid: string, fn: () => Promise<unknown>, failMsg: string) => {
    setBusy(fid);
    setError(null);
    try {
      await fn();
      await load();
    } catch {
      setError(failMsg);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const others = factions.filter(f => f.id !== meId && f.status !== 'eliminated');

  return (
    <div className="mp-standing">
      <p className="mp-standing-lede">
        You are at peace with everyone until you say otherwise. Shots are only
        exchanged between empires that have declared war.
      </p>
      {error && <div className="mp-standing-error">{error}</div>}
      {others.length === 0 && <div className="mp-standing-empty">No other empires.</div>}
      <ul className="mp-standing-list">
        {others.map((f) => {
          const war = openWarWith(f.id);
          const allied = allies.has(f.id);
          const state = war ? 'war' : allied ? 'allied' : 'peace';
          const breaksPact = allied && !war;
          return (
            <li key={f.id} className={`mp-standing-row is-${state}`}>
              <span className="mp-standing-flag" style={{ background: f.color }} aria-hidden />
              <span className="mp-standing-name">{f.name}</span>
              <span className={`mp-standing-chip is-${state}`}>
                {war ? 'AT WAR' : allied ? 'ALLIED' : 'at peace'}
              </span>
              {war ? (
                <button
                  type="button"
                  className="mp-standing-btn is-end"
                  disabled={busy === f.id}
                  onClick={() => {
                    logUiEvent('war_end_click', { gameId });
                    run(f.id, () => api.end(f.id), 'Could not stand down.');
                  }}
                  title="End the war. Either side may do this, and it takes effect at once."
                >
                  Stand down
                </button>
              ) : confirming === f.id ? (
                <span className="mp-standing-confirm">
                  <span className="mp-standing-warn">
                    {breaksPact
                      ? `This breaks your pact with ${f.name}, publicly.`
                      : 'Shots can be exchanged immediately.'}
                  </span>
                  <button
                    type="button"
                    className="mp-standing-btn is-declare"
                    disabled={busy === f.id}
                    onClick={() => {
                      logUiEvent('war_declare_confirm', { gameId, breaksPact });
                      run(f.id, () => api.declare(f.id), 'Could not declare war.');
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="mp-standing-btn"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="mp-standing-btn is-declare"
                  disabled={busy === f.id}
                  onClick={() => setConfirming(f.id)}
                  title={breaksPact
                    ? 'Declaring war breaks your standing pact, and the record will say so.'
                    : 'Declare war. Takes effect immediately, and is announced.'}
                >
                  Declare war
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {wars.some(w => !w.open) && (
        <>
          <h4 className="mp-standing-head">Past wars</h4>
          <ul className="mp-standing-past">
            {wars.filter(w => !w.open).slice(0, 8).map((w) => {
              const name = (id: string) => factions.find(f => f.id === id)?.name ?? 'Unknown';
              return (
                <li key={w.id}>
                  {name(w.factions[0])} vs {name(w.factions[1])}
                  <span className="mp-standing-ticks">
                    {' '}· ticks {w.declared_at_tick}–{w.ended_at_tick}
                    {w.origin === 'pact_broken' ? ' · pact broken' : ''}
                    {w.origin === 'seeded' ? ' · inherited' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export default StandingPanel;
