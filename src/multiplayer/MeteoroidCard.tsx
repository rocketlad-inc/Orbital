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
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './MeteoroidCard.css';

/** Which population a rock belongs to, in words a player can act on.
 *  L3 rocks are seeded as type 'lagrange' with an id of the form
 *  `<game>:mtr_<host>_l3`; eccentric rocks carry Kepler elements. */
function bandOf(body: Body, bodies: Body[]): { name: string; note: string } {
  if (body.type === 'lagrange') {
    const hostId = /mtr_([a-z]+)_l3$/.exec(body.id)?.[1];
    const host = hostId ? bodies.find(b => b.id.endsWith(`:${hostId}`) || b.id === hostId) : undefined;
    const who = host ? host.name : t('meteoroid.itsWorld');
    return {
      name: t('meteoroid.band.trojan.name', { who }),
      // The thing that makes L3 worth knowing about: it never moves
      // relative to its host, so a route planned here stays planned.
      note: t('meteoroid.band.trojan.note', { who }),
    };
  }
  if (body.orbit_ra != null && body.orbit_rp != null) {
    return {
      name: t('meteoroid.band.kuiper.name'),
      note: t('meteoroid.band.kuiper.note'),
    };
  }
  return {
    name: t('meteoroid.band.main.name'),
    note: t('meteoroid.band.main.note'),
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
    // Redrawn every frame so the rock tumbles, as it does on the map
    // (and so it swaps in once its art has loaded). Reduced motion gets
    // one still drawing, repeated only until the art arrives.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0;
    let frames = 0;
    const draw = () => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      drawMeteoroidBody(body, { x: W / 2, y: H / 2 }, 24, { ...ctx, nowMs: still ? 0 : performance.now() });
      if (!still || ++frames < 120) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [body, bodies, t]);

  return <canvas ref={ref} className="mtrc__portrait" aria-hidden="true" />;
};

export const MeteoroidCard: React.FC = () => {
  useI18n();
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
  // Ships this card has just sent an order for. The server records it
  // instantly, but this client only learns on its next state poll — so
  // without this the button does not move and the press reads as
  // "nothing happened". Entries drop out once the server agrees.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [composing, setComposing] = useState<null | {
    stops: { bodyId: string; action: 'mine' | 'dropoff' }[];
    carrierId: string;
    name: string;
  }>(null);

  const close = useCallback(() => { deselectBody(); }, [deselectBody]);

  // Forget an optimistic flag as soon as the real state matches it.
  const shipsSig = gameState.ships
    .map(sh => `${sh.id}:${sh.miningBodyId ?? ''}`).join('|');
  useEffect(() => {
    setPending(prev => {
      if (Object.keys(prev).length === 0) return prev;
      const next: Record<string, boolean> = {};
      for (const [id, want] of Object.entries(prev)) {
        const sh = gameState.ships.find(x => x.id === id);
        const now = !!sh && sh.miningBodyId === uiState.selectedBodyId;
        if (now !== want) next[id] = want;      // still waiting
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    // shipsSig is the dependency that actually changes when a poll lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipsSig, uiState.selectedBodyId]);

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

  // MANUAL MINING. Rigged hulls of yours ALREADY PARKED here, which is
  // the case the automated flow reads as absurd: the freighter is on the
  // rock, and the answer was "lay a trade route to where you already
  // are". Split by whether each is currently digging, since the button
  // is a toggle and the two states want opposite words.
  const riggedHere = gameState.ships.filter(
    sh => sh.ownedBy === 'player'
      && !sh.transit
      && sh.orbit.parentBodyId === body.id
      && (sh.parts ?? []).includes('mining'),
  );
  const worksThisRock = (sh: typeof riggedHere[number]) =>
    pending[sh.id] ?? (sh.miningBodyId === body.id);
  const digging = riggedHere.filter(worksThisRock);
  const idleHere = riggedHere.filter(sh => !worksThisRock(sh));

  return (
    <div className="mtrc-scrim" onClick={close} role="presentation">
      <div
        className="mtrc"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('meteoroid.ariaLabel', { name: body.name })}
      >
        <button className="mtrc__x" onClick={close} aria-label={t('meteoroid.close')}>✕</button>

        <div className="mtrc__head">
          <RockPortrait body={body} bodies={gameState.bodies} t={gameState.currentTick} />
          <div className="mtrc__headtext">
            <div className={`mtrc__eyebrow${dead ? ' is-dead' : ''}`}>
              {/* CREDITS, not "Gold". `gold` is the server's column
                  name; every player-facing surface in this game says
                  Credits (EconomyPanel's RES_LABEL is the authority).
                  Saying GOLD here and then "450 credits left" two lines
                  down invented a second currency out of nothing. */}
              {dead ? t('meteoroid.workedOut') : t('meteoroid.eyebrow', { kind: unit === 'credits' ? t('meteoroid.kind.credits') : t('meteoroid.kind.metal') })}
            </div>
            {/* The finder names it. renameBody is first-finder-only on
                the server, so a rejected save means someone beat you. */}
            <div className="mtrc__title">
              <EditableName
                value={body.name}
                onSave={async (n) => { await mpActions?.renameBody?.(body.id, n); }}
                ariaLabel={t('meteoroid.nameIt')}
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
          <div className="mtrc__unit">{t('meteoroid.unitLeft', { unit: unit === 'credits' ? t('meteoroid.unit.credits') : t('meteoroid.unit.metal') })}</div>
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
            <span className="mtrc__stat-k">{t('meteoroid.surveyed')}</span>
          </div>
          <div className="mtrc__stat">
            <span className="mtrc__stat-v">{Math.round(pulled).toLocaleString()}</span>
            <span className="mtrc__stat-k">{t('meteoroid.taken')}</span>
          </div>
          <div className="mtrc__stat">
            {/* Trips, not tonnes — the unit a route is planned in. */}
            <span className="mtrc__stat-v">{dead ? '—' : loads}</span>
            <span className="mtrc__stat-k">{loads === 1 ? t('meteoroid.freighterLoad_one') : t('meteoroid.freighterLoad_other')}</span>
          </div>
        </div>

        {/* ---- WHERE IT IS ---- */}
        <div className="mtrc__orbit">
          <div className="mtrc__orbit-row">
            <span className="mtrc__k">{t('meteoroid.distFromSol')}</span>
            <span className="mtrc__v">{distNow.toLocaleString()}</span>
          </div>
          {rp != null && ra != null && (
            <div className="mtrc__orbit-row">
              <span className="mtrc__k">{t('meteoroid.closestFarthest')}</span>
              <span className="mtrc__v">{rp.toLocaleString()} · {ra.toLocaleString()}</span>
            </div>
          )}
          <div className="mtrc__orbit-row">
            <span className="mtrc__k">{t('meteoroid.year')}</span>
            <span className="mtrc__v">{t('meteoroid.ticks', { n: Math.round(body.orbitPeriod).toLocaleString() })}</span>
          </div>
          {shipsHere > 0 && (
            <div className="mtrc__orbit-row">
              <span className="mtrc__k">{t('meteoroid.shipsHere')}</span>
              <span className="mtrc__v">{shipsHere}</span>
            </div>
          )}
          <div className="mtrc__orbit-note">{band.note}</div>
        </div>

        {dead ? (
          <div className="mtrc__dead">
            {t('meteoroid.dead')}
          </div>
        ) : (
          <>
            {/* HAND-WORKED HULLS FIRST. A freighter already sitting on
                the rock should not be told to lay a trade route to
                where it is. */}
            {digging.map(sh => {
              // PROGRESS, not just "it is digging". A run ends when the
              // hold fills or the rock runs dry, so show how full the
              // hull is and which of the two is about to happen.
              const aboard = sh.cargo
                ? sh.cargo.fuel + sh.cargo.ore + sh.cargo.credits + sh.cargo.science
                : 0;
              const room = Math.max(0, BASE_HOLD - aboard);
              const ticks = Math.ceil(Math.min(room, left) / MINE_RATE_PER_TICK);
              const pctFull = Math.max(0, Math.min(1, aboard / BASE_HOLD));
              return (
                <button
                  key={sh.id}
                  className="mtrc__go is-working"
                  onClick={() => {
                    setPending(p => ({ ...p, [sh.id]: false }));
                    mpActions?.setMining?.(sh.id, false);
                  }}
                >
                  <span className="mtrc__go-main">{t('meteoroid.stop', { name: sh.name })}</span>
                  <span className="mtrc__go-bar" aria-hidden="true">
                    <span className="mtrc__go-bar-fill" style={{ width: `${Math.round(pctFull * 100)}%` }} />
                  </span>
                  <span className="mtrc__go-sub">
                    {t('meteoroid.aboard', { have: Math.round(aboard), cap: BASE_HOLD })} ·{' '}
                    {ticks <= 0
                      ? t('meteoroid.stoppingNow')
                      : tn(room <= left ? 'meteoroid.untilFull' : 'meteoroid.untilDry', ticks)}
                  </span>
                </button>
              );
            })}
            {idleHere.map(sh => (
              <button
                key={sh.id}
                className="mtrc__go"
                onClick={() => {
                  setPending(p => ({ ...p, [sh.id]: true }));
                  mpActions?.setMining?.(sh.id, true);
                }}
              >
                <span className="mtrc__go-main">{t('meteoroid.begin', { name: sh.name })}</span>
                <span className="mtrc__go-sub">
                  {t('meteoroid.beginSub', { rate: MINE_RATE_PER_TICK })}
                </span>
              </button>
            ))}

            {/* THE ACTION. Everything below explains how mining works;
                this does it. The plan picks the nearest idle rigged
                freighter and the nearest delivery world, so the composer
                opens on a route that is already valid and the player
                confirms instead of assembling. */}
            {riggedHere.length > 0 ? null : run.ok ? (
              <button
                className="mtrc__go"
                onClick={() => setComposing({
                  stops: run.plan.stops,
                  carrierId: run.plan.carrierId,
                  name: run.plan.name,
                })}
              >
                <span className="mtrc__go-main">{t('meteoroid.startRun')}</span>
                <span className="mtrc__go-sub">
                  {run.plan.carrierName} → {body.name} → {run.plan.dropoff.name}
                </span>
              </button>
            ) : (
              <div className="mtrc__go is-blocked">
                <span className="mtrc__go-main">{t('meteoroid.cantRun')}</span>
                <span className="mtrc__go-sub">
                  {run.reason === 'no_rig'
                    ? t('meteoroid.noRig')
                    : t('meteoroid.noDropoff')}
                </span>
              </div>
            )}

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⌀</span>
              <div>
                <b>{t('meteoroid.rule.noBuild.title')}</b> {t('meteoroid.rule.noBuild.body')}
              </div>
            </div>

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⛏</span>
              <div>
                <b>{t('meteoroid.rule.freighter.title')}</b> {t('meteoroid.rule.freighter.pre')}{' '}
                <b>{t('meteoroid.miningRig')}</b> {t('meteoroid.rule.freighter.post')}
              </div>
            </div>

            <div className="mtrc__rule">
              <span className="mtrc__rule-icon" aria-hidden="true">⏱</span>
              <div>
                <b>{t('meteoroid.rule.sit.title')}</b> {t('meteoroid.rule.sit.a', { rate: MINE_RATE_PER_TICK })}{' '}
                <b>{t('meteoroid.ticks', { n: TICKS_PER_HOLD })}</b> {t('meteoroid.rule.sit.b', { hold: BASE_HOLD })}
              </div>
            </div>

            <div className="mtrc__foot">
              {t('meteoroid.foot')}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
