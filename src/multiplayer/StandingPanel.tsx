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
import { t } from '../i18n/core';
import type { Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';
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
  useI18n();
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
      const res = await apiFetch<Summary>(`/api/games/${gameId}/trade-summary`);
      if (!res.ok) { setError(t('standing.err.read')); return; }
      const d = res.data;
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
      setError(t('standing.err.read'));
    }
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  const openWarWith = (fid: string) =>
    wars.find(w => w.open && w.factions.includes(fid) && (meId ? w.factions.includes(meId) : false));

  // apiFetch RESOLVES on a 4xx rather than throwing, so a bare await
  // would report success on every refusal — "already at war", "no such
  // faction", a lost session. Check .ok and surface what the server
  // actually said when it bothered to say something.
  const run = async (
    fid: string,
    fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } | null }>,
    failKey: Key,
  ) => {
    setBusy(fid);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) { setError(apiErrorText(res.error, failKey)); return; }
      await load();
    } catch {
      setError(t(failKey));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const others = factions.filter(f => f.id !== meId && f.status !== 'eliminated');

  return (
    <div className="mp-standing">
      {/* Says where you STAND, not only the default. "You are at peace with
          everyone" stayed up while the QA armada was at war with all three
          rivals, directly above three red AT WAR rows. */}
      <p className="mp-standing-lede">
        {(() => {
          const atWar = others.filter(f => openWarWith(f.id)).length;
          return atWar === 0
            ? t('standing.lede.peace')
            : atWar === others.length
              ? t('standing.lede.warAll', { n: atWar })
              : t('standing.lede.warSome', { n: atWar, total: others.length });
        })()}
        {' '}{t('standing.lede.rule')}
      </p>
      {error && <div className="mp-standing-error">{error}</div>}
      {others.length === 0 && <div className="mp-standing-empty">{t('standing.noOthers')}</div>}
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
                {war ? t('standing.chip.war') : allied ? t('standing.chip.allied') : t('standing.chip.peace')}
              </span>
              {war ? (
                // PEACE TAKES TWO, so this is three states, not one.
                // Nobody has offered: offer. They have offered: accept,
                // and the war is over on the spot. You have offered:
                // there is nothing to do but wait, or take it back.
                war.ceasefire_by && war.ceasefire_by !== meId ? (
                  <button
                    type="button"
                    className="mp-standing-btn is-end"
                    disabled={busy === f.id}
                    onClick={() => {
                      logUiEvent(gameId, 'ceasefire_accept');
                      run(f.id, () => api.end(f.id), 'standing.err.accept');
                    }}
                    title={t('standing.accept.tip', { name: f.name })}
                  >
                    {t('standing.accept')}
                  </button>
                ) : war.ceasefire_by === meId ? (
                  <span className="mp-standing-confirm">
                    <span className="mp-standing-pending">
                      {t('standing.offered', { name: f.name })}
                    </span>
                    <button
                      type="button"
                      className="mp-standing-btn"
                      disabled={busy === f.id}
                      onClick={() => {
                        logUiEvent(gameId, 'ceasefire_withdraw');
                        run(f.id, () => api.endUndo(f.id), 'standing.err.withdraw');
                      }}
                    >
                      {t('standing.withdraw')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="mp-standing-btn is-end"
                    disabled={busy === f.id}
                    onClick={() => {
                      logUiEvent(gameId, 'ceasefire_offer');
                      run(f.id, () => api.end(f.id), 'standing.err.offer');
                    }}
                    title={t('standing.offer.tip')}
                  >
                    {t('standing.offer')}
                  </button>
                )
              ) : confirming === f.id ? (
                <span className="mp-standing-confirm">
                  <span className="mp-standing-warn">
                    {breaksPact
                      ? t('standing.confirm.breaksPact', { name: f.name })
                      : t('standing.confirm.immediate')}
                  </span>
                  <button
                    type="button"
                    className="mp-standing-btn is-declare"
                    disabled={busy === f.id}
                    onClick={() => {
                      logUiEvent(gameId, breaksPact ? 'war_declare_oathbreak' : 'war_declare_confirm');
                      run(f.id, () => api.declare(f.id), 'standing.err.declare');
                    }}
                  >
                    {t('standing.confirm')}
                  </button>
                  <button
                    type="button"
                    className="mp-standing-btn"
                    onClick={() => setConfirming(null)}
                  >
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="mp-standing-btn is-declare"
                  disabled={busy === f.id}
                  onClick={() => setConfirming(f.id)}
                  title={breaksPact
                    ? t('standing.declare.tipBreaks')
                    : t('standing.declare.tip')}
                >
                  {t('standing.declare')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {wars.some(w => !w.open) && (
        <>
          <h4 className="mp-standing-head">{t('standing.past')}</h4>
          <ul className="mp-standing-past">
            {wars.filter(w => !w.open).slice(0, 8).map((w) => {
              const name = (id: string) => factions.find(f => f.id === id)?.name ?? t('standing.unknown');
              return (
                <li key={w.id}>
                  {name(w.factions[0])} vs {name(w.factions[1])}
                  <span className="mp-standing-ticks">
                    {' '}· {t('standing.ticks', { from: w.declared_at_tick, to: w.ended_at_tick ?? '' })}
                    {w.origin === 'pact_broken' ? ` · ${t('standing.pactBroken')}` : ''}
                    {w.origin === 'seeded' ? ` · ${t('standing.inherited')}` : ''}
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
