// ============================================================
// RouteDiagram — the circuit, drawn (Lorne: "graphically show what
// worlds the route visits with the planet icons and arrows between
// them, and an indicator of where each ship is on their route").
//
// A route card used to be three lines of text naming two bodies. That
// reads fine for a two-stop lane and falls apart the moment a milk run
// has four stops and three ships strung out along it — which is the
// whole point of the feature. This draws the thing itself:
//
//   (Saturn) ──▶ (Enceladus) ──▶ (Rhea) ↻
//                    ▲
//                 Bucketashit
//
// Planet art is the SAME procedural texture the map draws (PlanetIcon
// reuses getPlanetTexture), so a world looks like itself everywhere.
//
// Ship placement reads the ships themselves, not the route's cursor
// alone: a hull parked at a stop sits ON that stop, and one under way
// sits on the leg it is crossing. The cursor says where it is headed;
// the ship says where it is. Both are needed, and disagreeing with the
// map would be worse than showing nothing.
// ============================================================

import React from 'react';
import type { Body, GameState, TradeRoute } from '../types';
import { PlanetIcon } from '../components/PlanetIcon';
import { ShipIcon } from '../components/ShipIcons';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import { routeStops, routeShips, routePartyColors, routeGradient } from '../game/routeSelectors';
import './RouteDiagram.css';

export interface RouteDiagramProps {
  gameState: GameState;
  route: TradeRoute;
}

/** Where a ship sits on the circuit.
 *  - { at: n }   parked at stop n
 *  - { leg: n }  crossing the leg that ENDS at stop n
 *  - null        somewhere off the circuit entirely (a fresh guard
 *                still burning to join, a hull the player flew away)
 */
export function placeShip(
  ship: { orbit?: { parentBodyId?: string }; transit?: unknown } | undefined,
  nextStopSeq: number,
  stopBodyIds: string[],
): { at: number } | { leg: number } | null {
  if (!ship) return null;
  const here = ship.orbit?.parentBodyId;
  const flying = !!ship.transit;
  if (!flying && here != null) {
    const idx = stopBodyIds.indexOf(here);
    if (idx >= 0) return { at: idx };
    return null;                    // parked, but not on this circuit
  }
  if (flying) {
    const target = Math.min(Math.max(0, nextStopSeq), stopBodyIds.length - 1);
    return { leg: target };
  }
  return null;
}

export const RouteDiagram: React.FC<RouteDiagramProps> = ({ gameState, route }) => {
  const stops = routeStops(route);
  const crew = routeShips(route);
  // WHOSE LANE IS THIS. Domestic hauling is one empire's business end to
  // end and draws in one colour; an international lane hands over
  // left-to-right, which is the same direction the circuit reads in.
  const myColor = gameState.factions.find(f => f.id === 'player')?.color ?? '#4ecdc4';
  const parties = routePartyColors(
    route, myColor,
    (fid) => gameState.factions.find(f => f.id === fid)?.color,
  );
  const lanePaint = routeGradient(parties);
  // WHOSE GROUND IS EACH STOP. Read from the settlements themselves, so
  // a lane that hands over at stop 1 draws the handover at stop 1 —
  // rather than fading across the whole strip and implying the goods
  // change hands somewhere in the middle of a leg.
  const colorOfBody = (bodyId: string): string => {
    const st = gameState.settlements.find(x => x.bodyId === bodyId);
    if (!st) return parties.mine;
    if (st.ownedBy === 'player') return parties.mine;
    return gameState.factions.find(f => f.id === st.ownedBy)?.color
        ?? parties.theirs ?? parties.mine;
  };
  const bodyById = new Map(gameState.bodies.map(b => [b.id, b]));
  const shipById = new Map(gameState.ships.map(s => [s.id, s]));
  const stopBodyIds = stops.map(s => s.bodyId);

  // Bucket every hull by where it is, so a stop or a leg can carry
  // several without them stacking on top of each other. Each marker
  // carries its own hull and livery: a mixed crew drawn as identical
  // glyphs hides the one fact the diagram is best placed to show —
  // which empire's ship is standing on which leg.
  interface Marker {
    label: string;
    cls: ShipIconClass;
    variant?: ShipIconVariant;
    color: string;
    eta: number | null;
  }
  const atStop = new Map<number, Marker[]>();
  const onLeg = new Map<number, Marker[]>();
  for (const c of crew) {
    const ship = shipById.get(c.shipId);
    const spot = placeShip(ship as never, c.nextStopSeq, stopBodyIds);
    if (!spot) continue;
    // c.shipName is the server's answer for hulls outside your fog of war —
    // a partner's freighter sharing a folded lane is never in gameState.ships.
    const m: Marker = {
      label: `${ship?.name ?? c.shipName ?? c.shipId}${c.role === 'guard' ? ' ⚔' : ''}`,
      cls: (ship?.class ?? c.shipClass ?? 'freighter') as ShipIconClass,
      variant: (ship?.iconVariant ?? c.iconVariant ?? undefined) as ShipIconVariant | undefined,
      color: (!c.ownerFactionId || c.ownerFactionId === 'player')
        ? parties.mine
        : gameState.factions.find(f => f.id === c.ownerFactionId)?.color
          ?? parties.theirs ?? parties.mine,
      eta: c.arrivalTick != null ? c.arrivalTick - gameState.currentTick : null,
    };
    if ('at' in spot) {
      atStop.set(spot.at, [...(atStop.get(spot.at) ?? []), m]);
    } else {
      onLeg.set(spot.leg, [...(onLeg.get(spot.leg) ?? []), m]);
    }
  }
  const names = (ms: Marker[]) => ms.map(m => m.label).join(', ');
  // The soonest arrival on a leg is the one the player is waiting for.
  const soonest = (ms: Marker[]) => {
    const ts = ms.map(m => m.eta).filter((t): t is number => t != null && t > 0);
    return ts.length ? Math.min(...ts) : null;
  };

  return (
    <div className="rd" role="img" aria-label={
      `Route: ${stops.map(s => bodyById.get(s.bodyId)?.name ?? s.bodyId).join(' then ')}, repeating`
    }>
      {/* The lane's colours ride as CSS variables so the arrows, the
          stop rings and the loop glyph all read from one source — the
          gradient is per-ROUTE, not per-element, or the handover point
          would drift between them. */}
      <div
        className={`rd-track${parties.international ? ' is-intl' : ''}`}
        // Only the fallback paint rides on the track now: each leg
        // computes its own gradient from the two stops it joins, so a
        // pair of track-wide endpoint colours would be two more things
        // that could disagree with what is drawn.
        style={{ ['--lane-paint' as string]: lanePaint }}
      >
        {stops.map((s, i) => {
          const body = bodyById.get(s.bodyId) as Body | undefined;
          const here = atStop.get(i) ?? [];
          const incoming = onLeg.get(i) ?? [];
          return (
            <React.Fragment key={`${s.bodyId}-${i}`}>
              {i > 0 && (
                <div className="rd-leg">
                  <div className="rd-arrow" aria-hidden>
                    <span
                      className="rd-line"
                      style={{
                        background: `linear-gradient(90deg, ${colorOfBody(stops[i - 1].bodyId)}, ${colorOfBody(s.bodyId)})`,
                      }}
                    />
                    <span className="rd-head" style={{ color: colorOfBody(s.bodyId) }}>▶</span>
                  </div>
                  {incoming.length > 0 && (
                    <div
                      className="rd-ship is-flying"
                      title={`${names(incoming)} — under way${
                        soonest(incoming) != null ? `, arriving in ${soonest(incoming)} ticks` : ''}`}
                    >
                      <span className="rd-ship-hulls" aria-hidden>
                        {incoming.map((m, k) => (
                          <ShipIcon key={k} shipClass={m.cls} variant={m.variant}
                                    size={16} color={m.color} />
                        ))}
                      </span>
                      <span className="rd-ship-name">{names(incoming)}</span>
                      {soonest(incoming) != null && (
                        <span className="rd-ship-eta">{soonest(incoming)}t</span>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className={`rd-stop${s.action === 'dropoff' ? ' is-drop' : ''}${route.consolidated ? ' is-swap' : ''}`}>
                <div className="rd-orb" style={{ ['--stop-owner' as string]: colorOfBody(s.bodyId) }}>
                  {body
                    ? <PlanetIcon body={body} size={30} currentTick={gameState.currentTick} />
                    : <span className="rd-orb-blank" aria-hidden />}
                  <span className="rd-seq">{i + 1}</span>
                </div>
                <div className="rd-name">{body?.name ?? s.bodyId}</div>
                {/* A FOLDED LANE SWAPS AT EVERY STOP. Both stops are
                    stored as pickups because the walker loads the
                    outgoing direction there, but it also DELIVERS what
                    the hull arrived with — labelling that "pick up"
                    described half of what happens. */}
                <div className="rd-act">
                  {route.consolidated
                    ? 'drop & load'
                    : s.action === 'dropoff' ? 'drop off' : 'pick up'}
                </div>
                {here.length > 0 && (
                  <div className="rd-ship is-docked" title={`${names(here)} — docked here`}>
                    <span className="rd-ship-hulls" aria-hidden>
                      {here.map((m, k) => (
                        <ShipIcon key={k} shipClass={m.cls} variant={m.variant}
                                  size={16} color={m.color} />
                      ))}
                    </span>
                    <span className="rd-ship-name">{names(here)}</span>
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        {/* The loop-back. The single most confusing thing about a
            standing route is that it repeats, so say so at the end of
            the chain rather than trusting the player to infer it. */}
        <div className="rd-loop" title="…then back to the first stop, and round again">
          <span className="rd-loop-glyph" aria-hidden>↻</span>
        </div>
      </div>
    </div>
  );
};

export default RouteDiagram;
