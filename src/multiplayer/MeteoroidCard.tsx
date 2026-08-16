// ============================================================
// MeteoroidCard — what you get when you click a rock.
//
// A ROCK IS NOT A WORLD. The world menu flew the camera down to a
// surface, drew a horizon, and offered a panel reading POP 0 / DEFENSE 0
// / INTEGRITY — with every yield at zero, because a meteoroid has none
// of those things. Worse, it rendered a BUILD STATION button, since
// canHostStation returned true for every body in the game. The one
// question a player actually has here — "what is in it and how do I get
// it out" — was answered nowhere in multiplayer at all. BodyInspector
// had a decent rock panel, but BodyInspector only mounts when the world
// menu kill-switch is off, so no MP player has ever seen it.
//
// This follows WarpGateCard exactly: a sibling card mounted next to the
// overlay, with the overlay bailing out for rocks. Same reasoning as the
// gate — a body you cannot hold should not be dressed as one you can.
//
// The card states the three rules that make mining what it is:
//   1. nothing can be built here, ever — it is too small to anchor
//   2. the only way material moves is a freighter with a Mining Rig
//   3. the hull is stuck in place while it fills, which is the risk
// ============================================================

import React, { useCallback, useEffect } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { EditableName } from '../components/EditableName';
import { MINE_RATE_PER_TICK, BASE_HOLD, TICKS_PER_HOLD, loadsRemaining, mineralUnit } from '../game/mining';
import './MeteoroidCard.css';

export const MeteoroidCard: React.FC = () => {
  const { gameState, uiState, deselectBody } = useGameContext();
  const mpActions = useMultiplayerActions();

  const body = uiState.selectedBodyId
    ? gameState.bodies.find(b => b.id === uiState.selectedBodyId)
    : undefined;
  // `mineralKind` IS the "is this a rock" test — see the payload note in
  // types.ts. Undiscovered rocks never reach the client, so anything
  // with a kind set is something this player has surveyed.
  const isRock = !!body?.mineralKind;

  const close = useCallback(() => { deselectBody(); }, [deselectBody]);

  useEffect(() => {
    if (!isRock) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRock, close]);

  if (!body || !isRock) return null;

  const initial = body.mineralInitial ?? 0;
  const left = Math.max(0, body.mineralRemaining ?? 0);
  const pct = initial > 0 ? Math.max(0, Math.min(1, left / initial)) : 0;
  const unit = mineralUnit(body.mineralKind);
  const dead = left <= 0;
  const loads = loadsRemaining(left);
  const pulled = Math.max(0, initial - left);

  return (
    <div className="mtrc-scrim" onClick={close} role="presentation">
      <div
        className="mtrc"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${body.name} meteoroid`}
      >
        <button className="mtrc__x" onClick={close} aria-label="Close">✕</button>

        <div className={`mtrc__eyebrow${dead ? ' is-dead' : ''}`}>
          {dead ? 'Meteoroid · Worked out' : `Meteoroid · ${unit === 'gold' ? 'Gold' : 'Metal'}`}
        </div>

        {/* The finder names it. renameBody is first-finder-only server
            side, so a failed save here just means someone beat you. */}
        <div className="mtrc__title">
          <EditableName
            value={body.name}
            onSave={async (n) => { await mpActions?.renameBody?.(body.id, n); }}
            ariaLabel="Name this meteoroid"
          />
        </div>

        {/* ---- WHAT IT HAS ---- */}
        <div className="mtrc__figure">
          <div className={`mtrc__amount${dead ? ' is-dead' : ''}`}>
            {Math.round(left).toLocaleString()}
          </div>
          <div className="mtrc__unit">{unit} remaining</div>
        </div>

        <div className="mtrc__bar" aria-hidden="true">
          <div
            className={`mtrc__bar-fill${dead ? ' is-dead' : ''} is-${unit === 'gold' ? 'gold' : 'metal'}`}
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>

        <div className="mtrc__stats">
          <div className="mtrc__stat">
            <span className="mtrc__stat-v">{Math.round(initial).toLocaleString()}</span>
            <span className="mtrc__stat-k">surveyed</span>
          </div>
          <div className="mtrc__stat">
            <span className="mtrc__stat-v">{Math.round(pulled).toLocaleString()}</span>
            <span className="mtrc__stat-k">extracted</span>
          </div>
          <div className="mtrc__stat">
            {/* The figure that actually plans a route: trips, not tonnes. */}
            <span className="mtrc__stat-v">{dead ? '—' : loads}</span>
            <span className="mtrc__stat-k">{loads === 1 ? 'freighter load' : 'freighter loads'}</span>
          </div>
        </div>

        {dead ? (
          <div className="mtrc__dead">
            Nothing left. Any route still pointed here will skip the stop
            and move on to the next one.
          </div>
        ) : (
          <>
            {/* ---- WHY THERE IS NOTHING TO BUILD ---- */}
            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⌀</span>
              <div>
                <b>No settlement can be built here.</b> A few hundred metres of
                rock on a loose orbit — there is nothing to anchor a station
                ring to and nothing to stand a city on. Rocks are worked, not
                held.
              </div>
            </div>

            {/* ---- THE ONLY WAY OUT ---- */}
            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⛏</span>
              <div>
                <b>Freighters are the only way to move it.</b> Fit a{' '}
                <b>Mining Rig</b> to a freighter in the ship designer, then add
                this rock as a stop on one of its trade routes.
              </div>
            </div>

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⏱</span>
              <div>
                <b>It has to sit still to fill.</b> {MINE_RATE_PER_TICK} a tick,
                so about <b>{TICKS_PER_HOLD} ticks</b> for a full {BASE_HOLD}
                {' '}hold — and it cannot leave until it is done. A parked
                freighter is a target.
              </div>
            </div>

            <div className="mtrc__foot">
              Nothing is banked until the load is carried home and dropped off.
            </div>
          </>
        )}
      </div>
    </div>
  );
};
