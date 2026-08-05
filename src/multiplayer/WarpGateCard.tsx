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
        aria-label={`${body.name} warp gate`}
      >
        <button className="wgc__x" onClick={close} aria-label="Close">✕</button>

        <div className="wgc__eyebrow">Anomaly · Active</div>
        <h2 className="wgc__title">{body.name} Gate</h2>
        <div className="wgc__sub">
          {parent ? `In orbit of ${parent.name}` : 'Deep space'}
          {body.secret?.discoveredAtTick != null && ` · found tick ${body.secret.discoveredAtTick}`}
        </div>

        <div className="wgc__route" aria-hidden>
          <span className="wgc__end">{body.name}</span>
          <span className="wgc__arrow">
            <i /><i /><i />
          </span>
          <span className="wgc__end wgc__end--dest">{dest ? dest.name : 'Unknown'}</span>
        </div>

        <p className="wgc__body">
          An ancient ring, still under power. <strong>Every ship that arrives here is
          transported to {dest ? dest.name : 'a distant star'}</strong> on the next tick —
          into a low, tight orbit. The transit is one-way and it is not optional.
        </p>

        <ul className="wgc__facts">
          <li><span>Destination</span><span>{dest ? dest.name : 'Unknown'}</span></li>
          <li><span>Transit time</span><span>Instant</span></li>
          <li><span>Can be settled</span><span className="wgc__no">No — ships never stay</span></li>
          <li><span>Can be held</span><span className="wgc__no">No — no garrison persists</span></li>
          {shipsHere > 0 && (
            <li><span>In transit now</span><span>{shipsHere} ship{shipsHere === 1 ? '' : 's'}</span></li>
          )}
        </ul>

        <p className="wgc__tip">
          Use it as a shortcut: anything you send here comes out at{' '}
          {dest ? dest.name : 'the far end'}, however far away it started.
        </p>

        <div className="wgc__actions">
          {dest && (
            <button className="wgc__btn wgc__btn--go" onClick={showDestination}>
              Show {dest.name}
            </button>
          )}
          <button className="wgc__btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
};
