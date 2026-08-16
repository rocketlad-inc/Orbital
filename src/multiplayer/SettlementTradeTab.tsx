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
import type { GameState, Ship, TradeRoute, TradeRouteShip, TradeRouteStop } from '../types';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { RouteDiagram } from './RouteDiagram';
import { ShipIcon } from '../components/ShipIcons';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import {
  routesAtBody, routeCarriers, routeGuards, routeStops,
  isStalled, stallTicksLeft, routeLabel, ROUTE_STALL_TICKS,
  routePartyColors, routeGradient, employedShipIds,
  isStarved, starveTicksLeft, starveShortText, TRADE_STARVE_GRACE_TICKS,
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

/** THE SAME QUESTION, ANSWERED FROM THE CREW ROW. shipContext above can
 *  only speak about hulls in ships[] — i.e. mine, in sensor range — so a
 *  partner's freighter on a folded lane rendered a blank context: name,
 *  role, and then nothing at all about the run it is flying. Every field
 *  here comes off the crew row the server sends, with the local Ship used
 *  only to sharpen it, so both halves of a shared lane read identically. */
function crewContext(
  c: TradeRouteShip,
  ship: Ship | undefined,
  stops: TradeRouteStop[],
  currentTick: number,
  bodyName: (id: string) => string,
): { where: string; eta: string; doing: string } {
  // Prefer the live client transit when we have it: it updates between
  // /state fetches, where the crew row is only as fresh as the last poll.
  const dest = ship?.transit?.currentTransfer?.targetBodyId ?? c.destBodyId ?? null;
  const at = ship?.orbit?.parentBodyId ?? c.parentBodyId ?? null;
  const ticks = c.arrivalTick != null ? c.arrivalTick - currentTick : null;

  // What it's carrying comes off the ROUTE hold, not the ship, so it is
  // known for a partner's hull too. "Empty" on a carrier is the tell for
  // a run that picked nothing up — the thing a stalled lane looks like
  // before the stall counter admits it.
  const held: string[] = [];
  if (c.cargo.ore >= 1) held.push(`${Math.round(c.cargo.ore)} metal`);
  if (c.cargo.credits >= 1) held.push(`${Math.round(c.cargo.credits)} credits`);
  if (c.cargo.science >= 1) held.push(`${Math.round(c.cargo.science)} science`);

  if (dest) {
    return {
      where: `→ ${bodyName(dest)}`,
      // A tick is the game's unit of time everywhere else in the UI, so
      // the ETA is quoted in ticks rather than invented minutes.
      eta: ticks != null && ticks > 0 ? `ETA ${ticks}t` : 'arriving',
      // A GUARD IS NEVER "EMPTY" — same rule as the docked branch below,
      // which had it and this one didn't. An escort carries nothing by
      // design, so grading it on its hold reported a corvette doing
      // exactly its job as though it had failed to load.
      doing: c.role === 'guard'
        ? 'escorting'
        : held.length ? `carrying ${held.join(', ')}` : 'running empty',
    };
  }
  // Docked. The next stop is the useful half of "where" — a ship sitting
  // at Titan with Luna next is mid-run, not idle, which is what made an
  // escort standing exactly where it was told to stand read as "idle".
  const next = stops.find(s => s.sequence === c.nextStopSeq);
  const nextName = next && next.bodyId !== at ? bodyName(next.bodyId) : null;
  return {
    where: at ? `at ${bodyName(at)}` : 'deep space',
    eta: nextName ? `next ${nextName}` : '',
    doing: c.role === 'guard'
      ? 'on station'
      : held.length ? `holding ${held.join(', ')}` : 'loading',
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

  const carrierCap = gameState.carrierCap ?? 1;

  const routes = useMemo(
    () => (bodyId
      ? routesAtBody(gameState.tradeRoutes ?? [], bodyId)
      : (gameState.tradeRoutes ?? [])),
    [gameState.tradeRoutes, bodyId],
  );

  // Free hulls, by role. A ship already employed anywhere is absent —
  // the server enforces one job per hull, so offering a busy ship would
  // only produce a 409 the player can't act on.
  //
  // Through the shared selector, which also knows about ONE-OFF
  // shipments: the server refuses a freighter mid-delivery, and this
  // list was built from routes alone — so a hull hauling a one-shot
  // trade was offered here and answered with a 409 nobody could act on,
  // which is the very thing the comment above promises it prevents.
  const employed = useMemo(() => {
    const set = employedShipIds(
      gameState.tradeRoutes ?? [],
      (gameState.tradeDeliveries ?? []) as Array<{ shipId: string | null }>,
    );
    // A legacy leg pins its hull on the route row rather than in a crew
    // list; employedShipIds reads crews, so cover the pinned case here.
    for (const r of gameState.tradeRoutes ?? []) if (!r.ships?.length) set.add(r.shipId);
    return set;
  }, [gameState.tradeRoutes, gameState.tradeDeliveries]);
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
        // WHAT ACTUALLY BLOCKS A DELETE, mirroring the server rule.
        //
        // This used to disable on ANY ship aboard, which was true of the
        // server once and is not any more: a NON-WALKER route (terraform,
        // dyson, agreement leg) pins its carrier and refuses to detach it,
        // so requiring an empty crew made those routes undeletable by any
        // sequence of clicks. The server now ignores a pinned carrier;
        // this has to agree, or the button stays grey over a call that
        // would succeed.
        //
        // Guards block either way — they would be left escorting a route
        // that no longer exists — and a WALKER crew still blocks, because
        // those carriers can be removed and stopping them mid-circuit
        // without orders is the accident the rule exists to prevent.
        const isWalker = r.kind === 'logistics'
          && (!r.counterpartyFactionId || r.consolidated === true);
        const cancelBlockers: string[] = [];
        if (guards.length > 0) {
          cancelBlockers.push(guards.length === 1 ? 'the guard' : 'the guards');
        }
        if (isWalker && carriers.length > 0) {
          cancelBlockers.push(carriers.length === 1 ? 'the freighter' : 'the freighters');
        }
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
        // A DEAL RUNNING ON TWO ROUTES AT ONCE. One leg folded and
        // another still going one way beside it: the shape a partner
        // left behind by commissioning after the fold.
        const split = group.legs.length > 1 && group.legs.some(l => l.consolidated);
        // Carriers ACROSS the whole deal: a folded lane is one route, so
        // counting this card's carriers is counting the lane's crew.
        const atCarrierCap = carriers.length >= carrierCap;
        // Which side is short. A folded lane loads from BOTH treasuries
        // depending on the end it is at, so naming "you" unconditionally
        // would blame the wrong player half the time; the starving leg's
        // owner is the one who has to find the goods.
        const starvedLeg = group.legs.find(l => isStarved(l)) ?? null;
        const starved = !!starvedLeg;
        const starveLeft = starvedLeg ? starveTicksLeft(starvedLeg, gameState.currentTick) : null;
        const shortText = starvedLeg ? starveShortText(starvedLeg) : '';
        const starveWho = starvedLeg
          ? (starvedLeg.ownedBy === 'player'
            ? 'You'
            : gameState.factions.find(f => f.id === starvedLeg.ownedBy)?.name ?? 'Your partner')
          : '';
        // THE LEDGER, summed across every leg of the deal — a folded lane
        // is one card, so its numbers have to be one set of numbers.
        const per = group.legs.reduce(
          (a, l) => ({
            metal: a.metal + (l.perRun?.metal ?? 0),
            gold: a.gold + (l.perRun?.credits ?? 0),
            science: a.science + (l.perRun?.science ?? 0),
          }),
          { metal: 0, gold: 0, science: 0 },
        );
        const payload = [
          per.metal >= 1 ? `${Math.round(per.metal)} metal` : null,
          per.gold >= 1 ? `${Math.round(per.gold)} credits` : null,
          per.science >= 1 ? `${Math.round(per.science)} science` : null,
        ].filter(Boolean).join(' + ');
        const runs = group.legs.reduce((a, l) => a + (l.loopsCompleted ?? 0), 0);
        // The soonest CARRIER arrival is the next delivery. A guard
        // landing first is not a drop, and quoting its ETA here would
        // promise goods that aren't on it.
        const nextDrop = group.legs
          .flatMap(l => (l.ships ?? []).filter(c => c.role === 'carrier'))
          .filter(c => c.destBodyId)
          .map(c => ({
            where: bodyName(c.destBodyId as string),
            ticks: c.arrivalTick != null ? c.arrivalTick - gameState.currentTick : null,
          }))
          .sort((a, b) => (a.ticks ?? 1e9) - (b.ticks ?? 1e9))[0] ?? null;
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

            {/* WHAT THE LANE IS ACTUALLY WORTH. The card said where the
                goods go and never what they are, how much has landed, or
                when the next lot arrives — the three numbers a player
                needs to decide whether a route deserves another hull. */}
            <div className="stt-ledger">
              {payload && <span className="stt-led-item">{payload} <em>per run</em></span>}
              <span className="stt-led-item">
                {runs > 0 ? <><strong>{runs}</strong> <em>run{runs === 1 ? '' : 's'} delivered</em></>
                  : <em>no runs yet</em>}
              </span>
              {nextDrop
                ? (
                  <span className="stt-led-item is-eta">
                    next drop <strong>{nextDrop.where}</strong>
                    {nextDrop.ticks != null ? <> in <strong>{nextDrop.ticks}t</strong></> : null}
                  </span>
                )
                : <span className="stt-led-item is-idle"><em>nothing under way</em></span>}
              {r.loopMode !== 'forever' && r.loopsRemaining != null && (
                <span className="stt-led-item"><strong>{r.loopsRemaining}</strong> <em>runs left</em></span>
              )}
            </div>

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
            {r.agreementId && carriers.length > 0 && (!r.consolidated || split) && (
              <div className="stt-fold">
                <div className="stt-fold-msg">
                  {split
                    // THE SPLIT STATE. One leg folded, another running
                    // one-way beside it — a partner commissioning after
                    // the fold used to open a rival leg. The same button
                    // repairs it, so a game already carrying the damage
                    // is not stuck with it.
                    ? 'This deal is running on two routes at once: one circuit that works both '
                      + 'directions, and a one-way leg beside it. Merge them so every freighter '
                      + 'collects and delivers at both ends.'
                    : carriers.length > 1
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
                      : split
                        ? 'Merge onto one lane'
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

            {/* THE OTHER WAY A LANE STOPS, and the one nobody could see.
                Stalled means no hull; STARVED means the loading side
                cannot cover the shipment — the lane is crewed, willing,
                and parked. It was invisible until the agreement died
                naming a shortfall the player had never been shown, on a
                clock three times shorter than the stall one. */}
            {starved && (
              <div className="stt-stall is-starved">
                {starveWho} can't cover the next run
                {shortText && <> — short <b>{shortText}</b></>}.
                {' '}The whole deal ends in <b>{starveLeft ?? TRADE_STARVE_GRACE_TICKS}</b>{' '}
                tick{starveLeft === 1 ? '' : 's'} unless the shortfall is covered.
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
                // THE CAP IS KNOWN HERE — say so instead of letting the
                // server answer with a 409. The composer already states
                // it at route creation; this button, which is where a
                // player actually adds the second hull, did not.
                disabled={busyId === r.id || freeFreighters.length === 0 || atCarrierCap}
                // NAME THE TECH AND THE TRACK AS THE PLAYER SEES THEM.
                // This used to say "advance Logistics", which is neither:
                // the tech is Convoy Logistics and the track is displayed
                // as SOCIETY (its internal id is `industry`). A player who
                // went looking for "Logistics" found no such track — and
                // until the unlock rows were added to researchUnlocks.ts
                // there was no card for the tech either, so the advice
                // pointed at nothing that existed on screen.
                title={atCarrierCap
                  ? `Your research allows ${carrierCap} freighter${carrierCap === 1 ? '' : 's'} `
                    + (carrierCap < 2
                      ? 'on a route. Convoy Logistics (Society 7) raises it to 2.'
                      : carrierCap < 4
                        ? 'on a route. Trade Armadas (Society 8) raises it to 4.'
                        // 4 is the ceiling — there is no third tech, and
                        // pointing at one would send the player hunting.
                        : 'on a route, which is the most any research allows.')
                  : freeFreighters.length === 0
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
                  disabled={busyId === r.id || cancelBlockers.length > 0}
                  title={cancelBlockers.length > 0
                    ? `Take ${cancelBlockers.join(' and ')} off this route first — `
                      + 'otherwise they are left with no orders.'
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
                  const ship = gameState.ships.find(x => x.id === s.shipId);
                  const ctx = crewContext(s, ship, stops, gameState.currentTick, bodyName);
                  // WHOSE HULL IT IS, IN COLOUR. On a folded lane the crew
                  // is mixed, and "TTC Prosperity" alone doesn't say it
                  // belongs to the other empire — the silhouette wearing
                  // their colour does, at a glance.
                  const empire = (!s.ownerFactionId || s.ownerFactionId === 'player')
                    ? myColor
                    : gameState.factions.find(f => f.id === s.ownerFactionId)?.color ?? '#7a8a9a';
                  const hullClass = (ship?.class ?? s.shipClass ?? 'freighter') as ShipIconClass;
                  const variant = (ship?.iconVariant ?? s.iconVariant ?? undefined) as
                    ShipIconVariant | undefined;
                  return (
                    <span
                      key={s.shipId}
                      className={`stt-crewchip${s.role === 'guard' ? ' is-guard' : ''}`}
                      style={{ ['--crew-empire' as string]: empire }}
                    >
                      <span className="stt-crewicon">
                        <ShipIcon shipClass={hullClass} variant={variant} size={22} color={empire} />
                      </span>
                      <span className="stt-crewbody">
                        <span className="stt-crewtop">
                          <span className="stt-crewname">{shipName(s.shipId)}</span>
                          <span className="stt-crewrole">{s.role === 'guard' ? 'guard' : 'runs it'}</span>
                        </span>
                        <span className="stt-crewbottom">
                          <span className="stt-crewwhere">{ctx.where}</span>
                          {ctx.eta && <span className="stt-creweta">{ctx.eta}</span>}
                          <span className="stt-crewdoing">{ctx.doing}</span>
                        </span>
                      </span>
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
