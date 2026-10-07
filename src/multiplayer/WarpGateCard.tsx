// ============================================================
// WarpGateCard — what you get when you click a revealed warp gate.
//
// A gate is not a world. Every ship that arrives is warped out on the
// next tick, so it can never be settled, garrisoned or built on — which
// made the world menu actively misleading: it offered SURFACE and ORBIT
// build columns for a rock you can't hold. This replaces that with the
// one thing a player actually wants to know: where does it go?
//
// Selection still flows through uiState.selectedBodyId; WorldMenuOverlay
// bails out for gate bodies (see its open effect) and this renders
// instead. Dismissal mirrors the menu's: ✕, Escape, or clicking away.
// ============================================================

import React, { useCallback, useEffect } from 'react';
import { useGameContext } from '../state/gameContext';
import { isRevealedWarpGate } from '../render/mapRenderer';
import { Body } from '../types';
import { t, tn } from '../i18n/core';
import { tRich } from '../i18n/rich';
import { useI18n } from '../i18n/react';
import './WarpGateCard.css';

/** Where this gate lets out. MP only ever seeds `portal_to_sun`, whose
 *  destination is always a low Sol orbit (worker/room.js step 2 of the
 *  secret pass). `warp_gate` carries an explicit destination and is
 *  single-player only today, but honour it if one ever shows up. */
function destinationOf(body: Body, bodies: Body[]): Body | undefined {
  const destId = body.secret?.kind === 'warp_gate'
    ? body.secret?.destinationBodyId
    : 'sol';
  return destId ? bodies.find(b => b.id === destId) : undefined;
}

export const WarpGateCard: React.FC = () => {
  useI18n();
  const { gameState, uiState, deselectBody, focusBody, updateCamera } = useGameContext();

  const body = uiState.selectedBodyId
    ? gameState.bodies.find(b => b.id === uiState.selectedBodyId)
    : undefined;
  const isGate = !!body && isRevealedWarpGate(body);

  const close = useCallback(() => { deselectBody(); }, [deselectBody]);

  useEffect(() => {
    if (!isGate) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGate, close]);

  if (!body || !isGate) return null;

  const dest = destinationOf(body, gameState.bodies);
  const parent = body.parent ? gameState.bodies.find(b => b.id === body.parent) : undefined;
  // Same accessor BodyInspector uses: orbiting ships only, transits excluded.
  const shipsHere = gameState.ships.filter(
    s => !s.transit && s.orbit.parentBodyId === body.id,
  ).length;

  /** Fly the map to the far end so "where does it go" is answered by the
   *  map itself, not just by the copy. */
  const showDestination = () => {
    if (!dest) return;
    deselectBody();
    focusBody(dest.id);
    updateCamera({ scale: 2.2 });
  };

  return (
    <div className="wgc-scrim" onClick={close} role="presentation">
      <div
        className="wgc"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('mp.gate.aria', { name: body.name })}
      >
        <button className="wgc__x" onClick={close} aria-label={t('site.close')}>✕</button>

        <div className="wgc__eyebrow">{t('mp.gate.eyebrow')}</div>
        <h2 className="wgc__title">{t('mp.gate.title', { name: body.name })}</h2>
        <div className="wgc__sub">
          {parent ? t('mp.gate.orbitOf', { name: parent.name }) : t('mp.gate.deepSpace')}
          {body.secret?.discoveredAtTick != null && t('mp.gate.found', { n: body.secret.discoveredAtTick })}
        </div>

        <div className="wgc__route" aria-hidden>
          <span className="wgc__end">{body.name}</span>
          <span className="wgc__arrow">
            <i /><i /><i />
          </span>
          <span className="wgc__end wgc__end--dest">{dest ? dest.name : t('mp.gate.unknown')}</span>
        </div>

        <p className="wgc__body">
          {tRich('mp.gate.body', {
            transported: <strong>{t('mp.gate.transported', { dest: dest ? dest.name : t('mp.gate.farStar') })}</strong>,
          })}
        </p>

        <ul className="wgc__facts">
          <li><span>{t('mp.gate.destination')}</span><span>{dest ? dest.name : t('mp.gate.unknown')}</span></li>
          <li><span>{t('mp.gate.transit')}</span><span>{t('mp.gate.instant')}</span></li>
          <li><span>{t('mp.gate.settled')}</span><span className="wgc__no">{t('mp.gate.settledNo')}</span></li>
          <li><span>{t('mp.gate.held')}</span><span className="wgc__no">{t('mp.gate.heldNo')}</span></li>
          {shipsHere > 0 && (
            <li><span>{t('mp.gate.inTransit')}</span><span>{tn('mp.gate.ships', shipsHere)}</span></li>
          )}
        </ul>

        <p className="wgc__tip">
          {t('mp.gate.tip', { dest: dest ? dest.name : t('mp.gate.farEnd') })}
        </p>

        <div className="wgc__actions">
          {dest && (
            <button className="wgc__btn wgc__btn--go" onClick={showDestination}>
              {t('mp.gate.show', { name: dest.name })}
            </button>
          )}
          <button className="wgc__btn" onClick={close}>{t('site.close')}</button>
        </div>
      </div>
    </div>
  );
};
