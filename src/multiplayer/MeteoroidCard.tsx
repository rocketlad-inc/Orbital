// ============================================================
// MeteoroidCard — what you get when you click a rock.
//
// A ROCK IS NOT A WORLD. The world menu flew the camera down to a
// "surface", drew a horizon on a few hundred metres of gravel, and
// opened a panel reading POP 0 / DEFENSE 0 / INTEGRITY - with every
// yield zero, because a rock has none of those things. It also offered
// a BUILD STATION button, since canHostStation returned true for every
// body in the game. Meanwhile the questions a player actually has here
// — what is in it, where is it, how do I get the stuff out — were
// answered nowhere in multiplayer at all.
//
// This follows WarpGateCard: a sibling card, with the overlay bailing
// for rocks the way it bails for gates. Same reasoning — a body you
// cannot hold should not be dressed as one you can.
//
// IT SHOWS THE ROCK. The first version was text only, which for the one
// body type with a hand-authored silhouette was a waste: the preview
// canvas calls the SAME drawMeteoroidBody the map uses, so the portrait
// is that rock, not a stock illustration — same seeded shape, same
// craters, same erosion as it gets worked out. The camera also flies to
// it behind the card, so closing leaves you looking at it.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { EditableName } from '../components/EditableName';
import { drawMeteoroidBody } from '../render/mapRenderer';
import { bodyPosition } from '../physics/orbitalMechanics';
import { Body } from '../types';
import {
  MINE_RATE_PER_TICK, BASE_HOLD, TICKS_PER_HOLD, loadsRemaining, mineralUnit,
  planMiningRun,
} from '../game/mining';
import { RouteComposer } from './RouteComposer';
import './MeteoroidCard.css';

/** Which population a rock belongs to, in words a player can act on.
 *  L3 rocks are seeded as type 'lagrange' with an id of the form
 *  `<game>:mtr_<host>_l3`; eccentric rocks carry Kepler elements. */
function bandOf(body: Body, bodies: Body[]): { name: string; note: string } {
  if (body.type === 'lagrange') {
    const hostId = /mtr_([a-z]+)_l3$/.exec(body.id)?.[1];
    const host = hostId ? bodies.find(b => b.id.endsWith(`:${hostId}`) || b.id === hostId) : undefined;
    const who = host ? host.name : 'its world';
    return {
      name: `Trojan · opposite ${who}`,
      // The thing that makes L3 worth knowing about: it never moves
      // relative to its host, so a route planned here stays planned.
      note: `Pinned to the far side of ${who}'s orbit — it stays there, so a run to it never goes stale. The crossing passes the sun.`,
    };
  }
  if (body.orbit_ra != null && body.orbit_rp != null) {
    return {
      name: 'Kuiper · eccentric',
      note: 'A long, lopsided orbit — the haul is cheap near its closest approach and brutal at its farthest. Time the run.',
    };
  }
  return {
    name: 'Main belt',
    note: 'Out past Mars, among the dwarf worlds. The close, contested rocks.',
  };
}

/** Portrait of the actual rock, drawn with the map's own routine.
 *  Sized so trueR clears the crater threshold and you see the surface. */
const RockPortrait: React.FC<{ body: Body; bodies: Body[]; t: number }> = ({ body, bodies, t }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 120, H = 120;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // A fake camera whose only job is to put SOL up and to the left, so
    // drawMeteoroidBody's lighting has a direction to work with. With
    // the camera at the origin the sun would project onto the rock
    // itself and the terminator would be degenerate.
    const ctx: any = {
      ctx: g,
      canvas: { width: W, height: H } as HTMLCanvasElement,
      camera: { x: 320, y: 320, scale: 1 },
      t,
      bodies,
    };
    // 24, not 46. The silhouette runs out to ~2.3x the radius once the
    // long axis and the radial wobble are applied, so 46 drew a 210px
    // rock into a 120px tile and the canvas clipped it into a slab.
    // 24 leaves a margin and still clears the crater threshold.
    drawMeteoroidBody(body, { x: W / 2, y: H / 2 }, 24, ctx);
  }, [body, bodies, t]);

  return <canvas ref={ref} className="mtrc__portrait" aria-hidden="true" />;
};

export const MeteoroidCard: React.FC = () => {
  const { gameState, uiState, deselectBody, focusBody, updateCamera } = useGameContext();
  const mpActions = useMultiplayerActions();

  const body = uiState.selectedBodyId
    ? gameState.bodies.find(b => b.id === uiState.selectedBodyId)
    : undefined;
  // `mineralKind` IS the "is this a rock" test — see the payload note in
  // types.ts. Undiscovered rocks never reach the client, so anything
  // with a kind set is something this player has surveyed.
  const isRock = !!body?.mineralKind;
  const bodyId = body?.id;
  // Set when the player commits to a run: the card hands off to the
  // composer rather than rendering both, so there is one modal on
  // screen and one Escape target.
  const [composing, setComposing] = useState<null | {
    stops: { bodyId: string; action: 'mine' | 'dropoff' }[];
    carrierId: string;
    name: string;
  }>(null);

  const close = useCallback(() => { deselectBody(); }, [deselectBody]);

  useEffect(() => {
    if (!isRock) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRock, close]);

  // FLY TO IT. Selecting a rock used to open the world menu, which at
  // least framed the thing you clicked; bailing out of that menu left
  // the camera wherever it was. A rock is a few tenths of a unit across,
  // so without a real zoom it stays the triangle marker and "show me the
  // meteoroid" goes unanswered.
  const bodyRadius = body?.radius ?? 0.4;
  useEffect(() => {
    if (!isRock || !bodyId) return;
    focusBody(bodyId);
    // Zoom so the ROCK RESOLVES. A meteoroid's true radius is a few
    // tenths of a unit, so at ordinary map scales it is sub-pixel and
    // draws as the triangle marker — "show me the meteoroid" answered
    // with the same glyph you clicked. drawMeteoroidBody crossfades to
    // the real silhouette above ~9px and is fully rock by ~9, so aim
    // for a comfortable 30px and clamp against a degenerate radius.
    updateCamera({ scale: Math.max(12, Math.min(120, 30 / Math.max(0.15, bodyRadius))) });
  }, [isRock, bodyId, bodyRadius, focusBody, updateCamera]);

  if (!body || !isRock) return null;

  if (composing) {
    return (
      <RouteComposer
        gameState={gameState}
        initialName={composing.name}
        initialStops={composing.stops}
        initialCarrierId={composing.carrierId}
        onClose={() => setComposing(null)}
        onSaved={() => { setComposing(null); close(); }}
      />
    );
  }

  const initial = body.mineralInitial ?? 0;
  const left = Math.max(0, body.mineralRemaining ?? 0);
  const pct = initial > 0 ? Math.max(0, Math.min(1, left / initial)) : 0;
  const unit = mineralUnit(body.mineralKind);
  const dead = left <= 0;
  const loads = loadsRemaining(left);
  const pulled = Math.max(0, initial - left);
  const band = bandOf(body, gameState.bodies);

  // Where it is right now. Eccentric rocks genuinely move in and out, so
  // the live distance is a decision input rather than trivia.
  const pos = bodyPosition(body, gameState.currentTick, gameState.bodies);
  const distNow = Math.round(Math.hypot(pos.x, pos.y));
  const rp = body.orbit_rp != null ? Math.round(body.orbit_rp) : null;
  const ra = body.orbit_ra != null ? Math.round(body.orbit_ra) : null;

  // Anything of anyone's parked here. Same accessor WarpGateCard uses.
  const shipsHere = gameState.ships.filter(
    s => !s.transit && s.orbit.parentBodyId === body.id,
  ).length;

  // Can this rock actually be worked right now, and by whom?
  const run = planMiningRun(
    body, gameState, (b) => bodyPosition(b, gameState.currentTick, gameState.bodies),
  );

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

        <div className="mtrc__head">
          <RockPortrait body={body} bodies={gameState.bodies} t={gameState.currentTick} />
          <div className="mtrc__headtext">
            <div className={`mtrc__eyebrow${dead ? ' is-dead' : ''}`}>
              {/* CREDITS, not "Gold". `gold` is the server's column
                  name; every player-facing surface in this game says
                  Credits (EconomyPanel's RES_LABEL is the authority).
                  Saying GOLD here and then "450 credits left" two lines
                  down invented a second currency out of nothing. */}
              {dead ? 'Worked out' : `Meteoroid · ${unit === 'credits' ? 'Credits' : 'Metal'}`}
            </div>
            {/* The finder names it. renameBody is first-finder-only on
                the server, so a rejected save means someone beat you. */}
            <div className="mtrc__title">
              <EditableName
                value={body.name}
                onSave={async (n) => { await mpActions?.renameBody?.(body.id, n); }}
                ariaLabel="Name this meteoroid"
              />
            </div>
            <div className="mtrc__band">{band.name}</div>
          </div>
        </div>

        {/* ---- WHAT IT HAS ---- */}
        <div className="mtrc__figure">
          <div className={`mtrc__amount${dead ? ' is-dead' : ''}`}>
            {Math.round(left).toLocaleString()}
          </div>
          <div className="mtrc__unit">{unit} left</div>
        </div>

        <div className="mtrc__bar" aria-hidden="true">
          <div
            className={`mtrc__bar-fill${dead ? ' is-dead' : ''} is-${unit === 'credits' ? 'credits' : 'metal'}`}
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
            <span className="mtrc__stat-k">taken</span>
          </div>
          <div className="mtrc__stat">
            {/* Trips, not tonnes — the unit a route is planned in. */}
            <span className="mtrc__stat-v">{dead ? '—' : loads}</span>
            <span className="mtrc__stat-k">{loads === 1 ? 'freighter load' : 'freighter loads'}</span>
          </div>
        </div>

        {/* ---- WHERE IT IS ---- */}
        <div className="mtrc__orbit">
          <div className="mtrc__orbit-row">
            <span className="mtrc__k">Distance from Sol</span>
            <span className="mtrc__v">{distNow.toLocaleString()}</span>
          </div>
          {rp != null && ra != null && (
            <div className="mtrc__orbit-row">
              <span className="mtrc__k">Closest / farthest</span>
              <span className="mtrc__v">{rp.toLocaleString()} · {ra.toLocaleString()}</span>
            </div>
          )}
          <div className="mtrc__orbit-row">
            <span className="mtrc__k">Year</span>
            <span className="mtrc__v">{Math.round(body.orbitPeriod).toLocaleString()} ticks</span>
          </div>
          {shipsHere > 0 && (
            <div className="mtrc__orbit-row">
              <span className="mtrc__k">Ships here</span>
              <span className="mtrc__v">{shipsHere}</span>
            </div>
          )}
          <div className="mtrc__orbit-note">{band.note}</div>
        </div>

        {dead ? (
          <div className="mtrc__dead">
            Nothing left. Any route still pointed here will skip the stop
            and move on to the next one.
          </div>
        ) : (
          <>
            {/* THE ACTION. Everything below explains how mining works;
                this does it. The plan picks the nearest idle rigged
                freighter and the nearest delivery world, so the composer
                opens on a route that is already valid and the player
                confirms instead of assembling. */}
            {run.ok ? (
              <button
                className="mtrc__go"
                onClick={() => setComposing({
                  stops: run.plan.stops,
                  carrierId: run.plan.carrierId,
                  name: run.plan.name,
                })}
              >
                <span className="mtrc__go-main">Start a mining run</span>
                <span className="mtrc__go-sub">
                  {run.plan.carrierName} → {body.name} → {run.plan.dropoff.name}
                </span>
              </button>
            ) : (
              <div className="mtrc__go is-blocked">
                <span className="mtrc__go-main">Can't run this yet</span>
                <span className="mtrc__go-sub">
                  {run.reason === 'no_rig'
                    ? 'No idle freighter carries a Mining Rig. Fit one in the ship designer.'
                    : 'Nowhere to deliver — you need a terraformed world of your own.'}
                </span>
              </div>
            )}

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⌀</span>
              <div>
                <b>Nothing can be built here.</b> A few hundred metres of rock
                on a loose orbit — no ring to anchor a station to, no ground to
                stand a city on. Rocks are worked, not held.
              </div>
            </div>

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⛏</span>
              <div>
                <b>A freighter is the only way to move it.</b> Fit a{' '}
                <b>Mining Rig</b> in the ship designer, then add this rock as a
                stop on that freighter's trade route.
              </div>
            </div>

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⏱</span>
              <div>
                <b>It has to sit still to fill.</b> {MINE_RATE_PER_TICK} a tick —
                about <b>{TICKS_PER_HOLD} ticks</b> for a full {BASE_HOLD} hold —
                and it cannot leave until it is done. A parked freighter is a
                target.
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
