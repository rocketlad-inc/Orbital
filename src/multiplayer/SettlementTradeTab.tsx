// ============================================================
// SettlementTradeTab — every route that stops HERE, listed here
// (DESIGN-trade-v2 §5).
//
// The point of this surface is diagnosability. Before it, a lane that
// lost its freighter simply stopped, somewhere, silently. Now it sits
// in the panel of the settlement it was supposed to serve, counting
// down, with the button that fixes it attached to the thing that's
// broken.
//
// Two roles, named the way a player says them: a ship either RUNS the
// route or GUARDS it.
// ============================================================

import React, { useMemo, useState } from 'react';
import type { GameState, Ship, TradeRoute } from '../types';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { RouteDiagram } from './RouteDiagram';
import {
  routesAtBody, routeCarriers, routeGuards, routeStops,
  isStalled, stallTicksLeft, routeLabel, ROUTE_STALL_TICKS,
  routePartyColors, routeGradient,
} from '../game/routeSelectors';
import './SettlementTradeTab.css';

/** WHERE IS THIS SHIP AND WHAT IS IT DOING — the context the ship
 *  pickers were missing (Lorne: "Where are these ships I'm choosing
 *  from? What are they doing?"). A bare list of names asks the player
 *  to remember an entire fleet's whereabouts; this answers it in the
 *  row they're choosing from. */
function shipContext(
  ship: Ship | undefined,
  gameState: GameState,
  role?: 'carrier' | 'guard',
): { where: string; doing: string } {
  if (!ship) return { where: '', doing: '' };
  const bodyName = (id?: string) =>
    gameState.bodies.find(b => b.id === id)?.name ?? id ?? 'deep space';
  if (ship.transit) {
    const target = ship.transit.currentTransfer?.targetBodyId;
    return {
      where: target ? `→ ${bodyName(target)}` : 'under way',
      doing: 'in transit',
    };
  }
  const held = (ship.cargo?.ore ?? 0) + (ship.cargo?.credits ?? 0)
    + (ship.cargo?.science ?? 0) + (ship.cargo?.fuel ?? 0);
  // A GUARD IS NEVER "IDLE". It carries nothing by design, so measuring
  // it by its hold reported an escort standing exactly where it was
  // asked to stand as though it had no orders — which is half of what
  // "ain't moving and still marked idle" was describing.
  if (role === 'guard') {
    return { where: bodyName(ship.orbit?.parentBodyId), doing: 'on station' };
  }
  return {
    where: bodyName(ship.orbit?.parentBodyId),
    doing: held >= 1 ? `holding ${Math.round(held)}` : 'empty',
  };
}

export interface SettlementTradeTabProps {
  gameState: GameState;
  /** Scope to one body's routes, or omit for EVERY route you're party
   *  to — which is what the Settlements panel wants. Trade is an empire
   *  view, not a per-rock one: a milk run touches four bodies and
   *  belongs to none of them. */
  bodyId?: string;
  /** Open the composer on an existing route ("Add stops"). */
  onEditRoute?: (route: TradeRoute) => void;
  /** Open the composer for a brand-new run starting here. */
  onNewRoute?: (bodyId?: string) => void;
}

export const SettlementTradeTab: React.FC<SettlementTradeTabProps> = ({
  gameState, bodyId, onEditRoute, onNewRoute,
}) => {
  const mp = useMultiplayerActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<{ routeId: string; role: 'carrier' | 'guard' } | null>(null);

  const bodyName = (id: string) => gameState.bodies.find(b => b.id === id)?.name ?? id;
  // My own fleet first, then the name the server attached to the crew
  // row. A partner's freighter on a shared lane is outside my fog of
  // war, so it is absent from ships[] — without the fallback the card
  // printed a raw database id where a ship's name belongs.
  const crewNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of gameState.tradeRoutes ?? []) {
      for (const c of r.ships ?? []) if (c.shipName) m.set(c.shipId, c.shipName);
    }
    return m;
  }, [gameState.tradeRoutes]);
  const shipName = (id: string) =>
    gameState.ships.find(s => s.id === id)?.name ?? crewNames.get(id) ?? id;

  const routes = useMemo(
    () => (bodyId
      ? routesAtBody(gameState.tradeRoutes ?? [], bodyId)
      : (gameState.tradeRoutes ?? [])),
    [gameState.tradeRoutes, bodyId],
  );

  // Free hulls, by role. A ship already employed anywhere is absent —
  // the server enforces one job per hull, so offering a busy ship would
  // only produce a 409 the player can't act on.
  const employed = useMemo(() => {
    const set = new Set<string>();
    for (const r of gameState.tradeRoutes ?? []) {
      for (const s of r.ships ?? []) set.add(s.shipId);
      if (!r.ships?.length) set.add(r.shipId);
    }
    return set;
  }, [gameState.tradeRoutes]);
  const freeFreighters = gameState.ships.filter(
    s => s.ownedBy === 'player' && s.class === 'freighter' && !employed.has(s.id));
  const freeWarships = gameState.ships.filter(
    s => s.ownedBy === 'player' && !employed.has(s.id)
      && ['corvette', 'frigate', 'destroyer'].includes(s.class));

  const assign = async (routeId: string, role: 'carrier' | 'guard', shipId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(routeId);
    const res = await mp.addRouteShip(routeId, role, { shipId });
    setBusyId(null);
    setAssignFor(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };
  // CONSOLIDATION: fold a two-leg deal onto one freighter, so the lane
  // stops flying half its distance empty. Offer -> the partner accepts,
  // because it changes whose hull does the work and that is not a thing
  // one side gets to decide.
  // FOLD THE DEAL. Immediate, because every hull already on the
  // agreement comes across as a carrier — nothing is taken from either
  // side, so there is nothing to get consent for.
  const consolidate = async (agreementId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(agreementId);
    const res = await mp.consolidateAgreement(agreementId);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };
  const remove = async (routeId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(routeId);
    const res = await mp.cancelTradeRoute(routeId);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };
  const unassign = async (routeId: string, shipId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(routeId);
    const res = await mp.removeRouteShip(routeId, shipId);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };

  // ONE DEAL, ONE CARD. A standing agreement that hasn't consolidated
  // runs as TWO routes — one leg per giving side — and rendering them as
  // independent cards showed the same relationship twice, with the same
  // consolidation offer duplicated on both. It is one agreement; the
  // legs are how it is currently flown, not two separate arrangements.
  //
  // Everything else stays one card per route: a self-haul milk run has
  // no counterpart to group with.
  const groups = useMemo(() => {
    const out: Array<{ key: string; legs: TradeRoute[] }> = [];
    const byAgreement = new Map<string, TradeRoute[]>();
    for (const r of routes) {
      if (r.agreementId) {
        if (!byAgreement.has(r.agreementId)) {
          const legs: TradeRoute[] = [];
          byAgreement.set(r.agreementId, legs);
          out.push({ key: r.agreementId, legs });
        }
        byAgreement.get(r.agreementId)!.push(r);
      } else {
        out.push({ key: r.id, legs: [r] });
      }
    }
    // My leg first — the one the player can actually crew.
    for (const g of out) {
      g.legs.sort((a, b) => Number(b.ownedBy === 'player') - Number(a.ownedBy === 'player'));
    }
    return out;
  }, [routes]);

  if (routes.length === 0) {
    return (
      <div className="stt">
        <div className="stt-empty">
          {bodyId
            ? 'No trade route stops here yet. A run collects from your outposts and drops everything at a terraformed world you live on.'
            : 'No trade routes yet. A run collects from your outposts and drops everything at a terraformed world you live on.'}
        </div>
        {onNewRoute && (
          <button type="button" className="stt-btn is-primary" onClick={() => onNewRoute(bodyId)}>
            {bodyId ? 'New route from here' : 'New route'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="stt">
      {err && <div className="stt-err">{err}</div>}
      {groups.map(group => {
        const r = group.legs[0];
        const isPair = group.legs.length > 1;
        // Crew spans the WHOLE deal for display — a pair's two hulls
        // are both flying the same relationship, and hiding the
        // partner's behind its own card is what made this read as two
        // arrangements. Assignment still targets MY leg (group.legs is
        // sorted mine-first), because that is the only one I can crew.
        const carriers = group.legs.flatMap(routeCarriers);
        const guards = group.legs.flatMap(routeGuards);
        const stalled = isStalled(r);
        const left = stallTicksLeft(r, gameState.currentTick);
        const stops = routeStops(r);
        const mine = r.ownedBy === 'player';
        const here = stops.filter(s => s.bodyId === bodyId);
        // The card wears the lane's colours: flat for domestic hauling,
        // a left-to-right handover when the deal has two empires in it.
        const myColor = gameState.factions.find(f => f.id === 'player')?.color ?? '#4ecdc4';
        const parties = routePartyColors(
          r, myColor, (fid) => gameState.factions.find(f => f.id === fid)?.color);
        const partnerName = parties.international
          ? gameState.factions.find(f =>
              f.id === (r.ownedBy !== 'player' ? r.ownedBy : r.counterpartyFactionId))?.name
          : null;
        return (
          <div
            key={group.key}
            className={`stt-route${stalled ? ' is-stalled' : ''}${parties.international ? ' is-intl' : ''}`}
            style={{ ['--lane-paint' as string]: routeGradient(parties) }}
          >
            {/* A stalled lane still needs its warning to win, so the
                party stripe sits ABOVE the card rather than replacing
                the border that carries urgency. */}
            <div className="stt-lane" aria-hidden />
            <div className="stt-row">
              <span className="stt-name">
                {isPair
                  // Two legs of one deal read as a round trip, because
                  // that is what the pair achieves between them.
                  ? `${bodyName(routeStops(r)[0].bodyId)} ⇄ ${bodyName(routeStops(r)[routeStops(r).length - 1].bodyId)}`
                  : routeLabel(r, bodyName)}
              </span>
              {partnerName && (
                <span className="stt-partner" title={`A standing deal with ${partnerName}`}>
                  with {partnerName}
                </span>
              )}
              {stalled
                ? <span className="stt-pill is-warn">Stalled</span>
                : <span className="stt-pill">Running</span>}
              <span className="stt-spacer" />
              <span className="stt-meta">
                {isPair
                  ? `${group.legs.length} legs · one freighter each`
                  : bodyId
                    ? here.map(s => (s.action === 'dropoff' ? 'drops off here' : 'collects here')).join(' · ')
                    // Unscoped: name the whole circuit, since no single
                    // body is "here" in an empire-wide list.
                    : stops.map(s => `${bodyName(s.bodyId)}${s.action === 'dropoff' ? ' ▾' : ''}`).join(' → ')}
              </span>
            </div>

            {/* THE CIRCUIT ITSELF. Text named two bodies and stopped
                being legible the moment a run had four stops and three
                hulls strung along it — which is the feature.
                A two-leg deal draws BOTH directions here, each labelled
                with whose freighter flies it, so the duplication the two
                cards used to show becomes the one thing it always was:
                a round trip split across two hulls. */}
            {group.legs.map(leg => {
              const legOwner = leg.ownedBy === 'player'
                ? 'yours'
                : gameState.factions.find(f => f.id === leg.ownedBy)?.name ?? 'theirs';
              return (
                <div key={leg.id} className={isPair ? 'stt-leg' : undefined}>
                  {isPair && (
                    <div className="stt-leg-head">
                      <span className="stt-leg-owner">{legOwner}</span>
                      <span className="stt-leg-ships">
                        {routeCarriers(leg).length > 0
                          ? routeCarriers(leg).map(c => shipName(c.shipId)).join(', ')
                          : 'no freighter'}
                      </span>
                    </div>
                  )}
                  <RouteDiagram gameState={gameState} route={leg} />
                </div>
              );
            })}

            {/* THE EMPTY HALF OF THE LANE. A two-leg agreement flies
                each freighter home with nothing in it — the thing Orbit
                Man opened the whole design with. Offer to run it on one
                hull instead, and the return leg becomes the other side's
                shipment. Shown on the leg the player is looking at,
                because that is where they noticed the problem. */}
            {/* FOLD IT. Both freighters currently fly half the lane
                empty — the thing Orbit Man opened the design with. This
                takes every hull already on the deal and puts them ALL on
                one circuit, so each collects and delivers at BOTH ends.
                Same ships, twice the trade. No handshake: nobody loses a
                freighter, so there is nothing to ask the partner. */}
            {r.agreementId && !r.consolidated && carriers.length > 0 && (
              <div className="stt-fold">
                <div className="stt-fold-msg">
                  {carriers.length > 1
                    ? `Both freighters fly home empty on this deal. Put ${carriers
                        .map(c => shipName(c.shipId)).join(' and ')} on one circuit and each
                       collects and delivers at both ends — same ships, twice the trade.`
                    : 'This freighter flies home empty every run. One circuit makes it collect '
                      + 'and deliver at both ends.'}
                </div>
                <div className="stt-row stt-actions">
                  <button
                    type="button" className="stt-btn is-go"
                    disabled={busyId === r.agreementId}
                    onClick={() => consolidate(r.agreementId!)}
                  >
                    {busyId === r.agreementId
                      ? 'Merging…'
                      : carriers.length > 1
                        ? `Run both ways with ${carriers.length} freighters`
                        : 'Run it both ways'}
                  </button>
                </div>
              </div>
            )}

            {stalled && (
              <div className="stt-stall">
                No freighter. This route cancels itself in <b>{left ?? ROUTE_STALL_TICKS}</b>{' '}
                tick{left === 1 ? '' : 's'} unless one is assigned.
              </div>
            )}

            <div className="stt-row stt-crew">
              <span className="stt-chip">
                Runs it · <b>{carriers.length ? carriers.map(c => shipName(c.shipId)).join(', ') : 'none'}</b>
              </span>
              <span className="stt-chip">
                Guards · <b>{guards.length ? guards.map(g => shipName(g.shipId)).join(', ') : 'none'}</b>
              </span>
            </div>

            <div className="stt-row stt-actions">
              <button
                type="button"
                className={`stt-btn${stalled ? ' is-primary' : ''}`}
                disabled={busyId === r.id || freeFreighters.length === 0}
                title={freeFreighters.length === 0
                  ? 'Every freighter you have is already on a job.'
                  : 'Put another freighter on this run'}
                onClick={() => setAssignFor({ routeId: r.id, role: 'carrier' })}
              >
                {stalled ? 'Assign freighter' : '+ Freighter'}
              </button>
              <button
                type="button"
                className="stt-btn"
                disabled={busyId === r.id || freeWarships.length === 0}
                title={freeWarships.length === 0
                  ? 'No free warships — guards are corvettes, frigates and destroyers.'
                  : 'Guards fly the run and hold fire unless something attacks it'}
                onClick={() => setAssignFor({ routeId: r.id, role: 'guard' })}
              >
                + Guard
              </button>
              {mine && onEditRoute && !r.counterpartyFactionId && (
                <button type="button" className="stt-btn" onClick={() => onEditRoute(r)}>
                  Add stops
                </button>
              )}
              {/* DELETE, but only once the lane is empty. Cancelling a
                  staffed route strands every hull on it — carriers stop
                  mid-circuit, guards hold a body defending nothing — so
                  taking the ships off first is the price of deleting,
                  and the server enforces the same rule. */}
              {/* Cancelling ONE leg of a standing deal would leave the
                  other side shipping into an arrangement that no longer
                  reciprocates — the deal is ended from the Trades panel,
                  as a deal. Delete stays for routes that are only ever
                  one route. */}
              {mine && !r.agreementId && (
                <button
                  type="button"
                  className="stt-btn is-danger"
                  disabled={busyId === r.id || carriers.length + guards.length > 0}
                  title={carriers.length + guards.length > 0
                    ? 'Take every ship off this route first — otherwise they are left with no orders.'
                    : 'Delete this route'}
                  onClick={() => remove(r.id)}
                >
                  Delete route
                </button>
              )}
            </div>

            {assignFor?.routeId === r.id && (
              <div className="stt-picker">
                <div className="stt-picker-head">
                  {assignFor.role === 'carrier' ? 'Which freighter runs it?' : 'Which ship guards it?'}
                </div>
                <div className="stt-picker-list">
                  {(assignFor.role === 'carrier' ? freeFreighters : freeWarships).map(s => {
                    const ctx = shipContext(s, gameState);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="stt-pick"
                        onClick={() => assign(r.id, assignFor.role, s.id)}
                        title={`${s.name} — ${ctx.where}, ${ctx.doing}`}
                      >
                        <span className="stt-pick-name">{s.name}</span>
                        <span className="stt-pick-where">{ctx.where}</span>
                        <span className="stt-pick-doing">{ctx.doing}</span>
                      </button>
                    );
                  })}
                  {(assignFor.role === 'carrier' ? freeFreighters : freeWarships).length === 0 && (
                    <span className="stt-empty">
                      {assignFor.role === 'carrier'
                        ? 'Every freighter you have is already on a job.'
                        : 'No free warships — guards are corvettes, frigates and destroyers.'}
                    </span>
                  )}
                </div>
                <button type="button" className="stt-btn" onClick={() => setAssignFor(null)}>
                  Cancel
                </button>
              </div>
            )}

            {/* THE CREW, and how to take one off.
                This was a chip where the WHOLE thing was a destructive
                button — it looked like a status label, so clicking it to
                see what it was silently unassigned the freighter. That is
                what "adding a guard dismissed my freighter" actually was:
                the server never touched the carrier (proved in
                sim/tradeRoutesV2 case 12), the chip did. Only the ✕
                removes now, and it says what it will do. */}
            {(carriers.length + guards.length) > 0 && (
              <div className="stt-roster">
                {[...carriers, ...guards].map(s => {
                  const ctx = shipContext(
                    gameState.ships.find(x => x.id === s.shipId), gameState, s.role);
                  return (
                    <span key={s.shipId} className="stt-crewchip">
                      <span className="stt-crewname">{shipName(s.shipId)}</span>
                      <span className="stt-crewrole">{s.role === 'guard' ? 'guard' : 'runs it'}</span>
                      <span className="stt-crewwhere">{ctx.where} · {ctx.doing}</span>
                      <button
                        type="button"
                        className="stt-crewx"
                        disabled={busyId === r.id}
                        title={`Take ${shipName(s.shipId)} off this route`}
                        aria-label={`Take ${shipName(s.shipId)} off this route`}
                        onClick={() => unassign(r.id, s.shipId)}
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {onNewRoute && (
        <button type="button" className="stt-btn" onClick={() => onNewRoute(bodyId)}>
          {bodyId ? 'New route from here' : 'New route'}
        </button>
      )}
    </div>
  );
};

export default SettlementTradeTab;
