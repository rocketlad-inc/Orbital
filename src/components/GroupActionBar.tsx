// ============================================================
// GroupActionBar
//
// The shift-click group's control surface, floating over the map so
// the common actions ("everyone go there", "everyone hold fire") are
// reachable without opening the Fleet panel. The panel's own action
// bar still works — both read the same shared selection
// (uiState.selectedShipIds) — this is just the version you get while
// your eyes are already on the map.
//
// Shift-clicking a WORLD is the move gesture; MapCanvas fires
// 'orbital:group-move' for it and this component owns the transfer
// (it has the hook and somewhere to put the result summary).
//
// Desktop-shaped by construction: shift-click needs a keyboard, so
// there's no touch equivalent to design around here.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { useBulkTransfer } from '../hooks/useBulkTransfer';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { apiFetch } from '../multiplayer/api';
import { isArmed } from '../game/systemGrouping';
import type { TargetPriorityKey } from '../types';
import { TargetPriorityCards } from './TargetPriorityCards';
import { ChainOrderEditor } from './ChainOrderEditor';
import { useBulkChain } from '../hooks/useBulkChain';
import type { ChainStep } from '../physics/chainPlanner';
import './GroupActionBar.css';

type Stance = 'attack' | 'defensive' | 'hold';

const STANCES: Array<{ id: Stance; label: string; title: string }> = [
  { id: 'attack',    label: 'ATTACK',    title: 'Attack on sight' },
  { id: 'defensive', label: 'DEFENSIVE', title: 'Return fire only' },
  { id: 'hold',      label: 'HOLD',      title: 'Never fire' },
];

export const GroupActionBar: React.FC = () => {
  const { gameState, uiState, clearShipSelection } = useGameContext();
  const mpActions = useMultiplayerActions();
  const bulkTransfer = useBulkTransfer();
  const [notice, setNotice] = useState<string | null>(null);
  const [dest, setDest] = useState('');
  // Target-priority flyout. Group members may carry different priorities,
  // so the cards open on the shared DEFAULT ladder — the first drop
  // overwrites the whole group with one order (same immediate-apply model
  // as the stance buttons).
  const [showTargeting, setShowTargeting] = useState(false);
  // CHAIN ORDERS for the group. The itinerary is shared; each hull
  // solves it from its OWN orbit, so this is a route, not a plan.
  const [showChain, setShowChain] = useState(false);
  const [chain, setChain] = useState<ChainStep[]>([]);
  const bulkChain = useBulkChain();

  const ids = uiState.selectedShipIds ?? [];

  // Ships can die or be sold out from under a stale selection, so resolve
  // against live state rather than trusting the id list's length.
  const ships = ids
    .map(id => gameState.ships.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // A move needs a hull that isn't already committed to a burn — same
  // eligibility rule the Fleet panel's bulk transfer uses.
  const movable = ships.filter(s => !s.transit && !s.plannedTransit);

  // FORM FLEET from the selection. The server's rules, mirrored here so
  // the button is only drawn when it can actually succeed:
  //   - at least two hulls, all mine
  //   - a flagship that HAS a captain (members surrender theirs on
  //     joining, so the flag's is the fleet's only officer)
  // Ships already in another fleet are allowed: the create endpoint
  // silently pulls them out of it, which is the behaviour you want when
  // you have just box-selected a new formation.
  const mine = ships.filter(s => s.ownedBy === 'player');
  // WHO CAN ACTUALLY SHOOT. Target priority is doctrine for picking a
  // victim, so it means nothing on a hull that never fires — a stock
  // freighter or colony ship. Keyed on isArmed rather than the class
  // name because the designer can arm a freighter or strip a warship.
  const gunners = ships.filter(isArmed);
  const flagCandidate = mine.find(s => !!s.captainName || !!s.captainId) ?? null;
  const canFormFleet = mine.length >= 2;

  // Destination list for the picker — every body, alphabetical, matching
  // the Fleet panel's transfer dropdown so the two read the same. Own
  // worlds carry a ★ because "where do I already hold ground" is the
  // question you're usually answering when you move a group.
  const destinations = useMemo(
    () => [...gameState.bodies]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(b => ({ id: b.id, label: `${b.ownedBy === 'player' ? '★ ' : ''}${b.name}` })),
    [gameState.bodies],
  );

  const groupMove = useCallback((bodyId: string) => {
    const body = gameState.bodies.find(b => b.id === bodyId);
    const targets = movable.map(s => s.id);
    if (targets.length === 0) {
      setNotice('No ship in the group can start a new burn');
      return;
    }
    const res = bulkTransfer(targets, bodyId, (msg, soFar, total) => {
      setNotice(`${soFar} of ${total} rejected — ${msg}`);
    });
    if (res.issued === 0) {
      setNotice('Could not plan a burn for any ship in the group');
    } else {
      setNotice(
        `${res.issued} ship${res.issued === 1 ? '' : 's'} bound for ${body?.name ?? 'target'}`
        + (res.unplannable > 0 ? ` · ${res.unplannable} couldn't` : ''),
      );
      // Reset the picker so the same destination can't be re-fired by a
      // stray second click on SEND after the group has already launched.
      setDest('');
    }
  }, [bulkTransfer, gameState.bodies, movable]);

  // MapCanvas raises this when you shift-click a world with a live group.
  useEffect(() => {
    const onMove = (e: Event) => {
      const bodyId = (e as CustomEvent).detail?.bodyId;
      if (typeof bodyId === 'string') groupMove(bodyId);
    };
    window.addEventListener('orbital:group-move', onMove as EventListener);
    return () => window.removeEventListener('orbital:group-move', onMove as EventListener);
  }, [groupMove]);

  // Drop the notice whenever the group itself changes — a stale "3 ships
  // bound for Io" hanging over a different selection reads as this one's
  // result. The targeting flyout closes with it: it was scoped to the
  // old group.
  useEffect(() => {
    setNotice(null);
    setShowTargeting(false);
    // The chain goes with them. An itinerary written for one group and
    // silently applied to the next is the worst kind of bulk mistake:
    // it succeeds.
    setShowChain(false);
    setChain([]);
  }, [uiState.selectedShipIds]);

  // What the targeting flyout shows: if EVERY ship in the group already
  // shares one custom order, start from it (so a tweak reads as a tweak);
  // otherwise the default ladder. Above the early return — hooks must run
  // on every render.
  const sharedPriority = useMemo(() => {
    const armed = ships.filter(isArmed);
    const first = armed[0]?.targetPriority ?? null;
    if (!first) return null;
    const key = JSON.stringify(first);
    return armed.every(s => JSON.stringify(s.targetPriority ?? null) === key) ? first : null;
  }, [ships]);

  // Escape clears the group, matching how the panels dismiss.
  useEffect(() => {
    if (ids.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearShipSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids.length, clearShipSelection]);

  if (ids.length === 0) return null;

  const formFleet = async () => {
    if (!mpActions || mine.length < 2) return;
    if (!flagCandidate) {
      // The server would say this too, but only after a round trip and
      // in its own words. Saying it here keeps the reason next to the
      // button that could not act.
      setNotice('No captain among these ships — a fleet needs one to fly the flag');
      return;
    }
    const parent = gameState.bodies.find(b => b.id === flagCandidate.orbit?.parentBodyId);
    const res = await apiFetch(`/api/games/${mpActions.gameId}/fleets`, {
      method: 'POST',
      body: JSON.stringify({
        ship_ids: mine.map(s => s.id),
        flag_ship_id: flagCandidate.id,
        name: `${parent?.name ?? 'Task'} Group`,
      }),
    });
    setNotice(res.ok
      ? `Fleet formed — ${mine.length} ships under ${flagCandidate.captainName ?? flagCandidate.name}`
      : (res.error?.message ?? 'Could not form a fleet'));
  };

  const setStance = (stance: Stance) => {
    if (!mpActions) return;
    const targets = ships.map(s => s.id);
    if (targets.length === 0) return;
    mpActions.setShipOrders({ shipIds: targets, stance }).then(res => {
      setNotice(res.ok
        ? `${targets.length} ship${targets.length === 1 ? '' : 's'} set to ${stance}`
        : humanizeMpError(res.code, res.error, 'orders'));
    });
  };

  const setTargeting = (priority: TargetPriorityKey[] | null) => {
    if (!mpActions) return;
    // Only the hulls it can mean anything for. Sending it to the whole
    // selection would report "priority set on 6 ships" when two of them
    // are freighters that will never read it.
    const targets = gunners.map(s => s.id);
    if (targets.length === 0) return;
    mpActions.setShipOrders({ shipIds: targets, targetPriority: priority }).then(res => {
      setNotice(res.ok
        ? (priority === null
          ? `${targets.length} ship${targets.length === 1 ? '' : 's'} back to auto targeting`
          : `Priority set on ${targets.length} ship${targets.length === 1 ? '' : 's'}`)
        : humanizeMpError(res.code, res.error, 'orders'));
    });
  };

  const applyChain = () => {
    const targets = movable.map(s => s.id);
    if (targets.length === 0 || chain.length === 0) return;
    const res = bulkChain(targets, chain, (msg) => setNotice(msg));
    if (res.issued === 0) {
      setNotice('Could not plan that route for any ship in the group');
      return;
    }
    setNotice(
      `${res.issued} ship${res.issued === 1 ? '' : 's'} flying a ${chain.length}-leg chain`
      + (res.unplannable > 0 ? ` · ${res.unplannable} couldn't` : '')
      // Truncation is called out because the ship still LAUNCHES -- it
      // just stops short, somewhere nobody chose.
      + (res.truncated > 0 ? ` · ${res.truncated} cut short` : ''),
    );
    setChain([]);
    setShowChain(false);
  };


  return (
    <div className="group-bar" role="region" aria-label="Group actions">
      <div className="group-bar__row">
        <span className="group-bar__count">
          {ships.length} selected
          {movable.length !== ships.length && (
            <span className="group-bar__sub"> · {ships.length - movable.length} already burning</span>
          )}
        </span>
        {mpActions && (
          <span className="group-bar__stances">
            {STANCES.map(s => (
              <button
                key={s.id}
                className="group-bar__btn"
                title={s.title}
                onClick={() => setStance(s.id)}
              >{s.label}</button>
            ))}
            {gunners.length > 0 && (
              <button
                className={`group-bar__btn${showTargeting ? ' group-bar__btn--active' : ''}`}
                title={gunners.length === ships.length
                  ? 'Rank which target categories the group engages first'
                  : `Rank targets for the ${gunners.length} armed hull${gunners.length === 1 ? '' : 's'} — the rest never fire`}
                onClick={() => setShowTargeting(v => !v)}
              >TARGETING</button>
            )}
            <button
              className={`group-bar__btn${showChain ? ' group-bar__btn--active' : ''}`}
              title="Send the group through a multi-leg route, with holds between legs"
              onClick={() => setShowChain(v => !v)}
            >CHAIN ORDERS</button>
          </span>
        )}
        {canFormFleet && (
          <button
            className="group-bar__btn"
            onClick={() => { void formFleet(); }}
            title={flagCandidate
              ? `Bind these ${mine.length} ships into one fleet under ${flagCandidate.captainName ?? flagCandidate.name}. One order set, one commander.`
              : 'These ships have no captain between them — a fleet needs one to fly the flag'}
          >FORM FLEET</button>
        )}
        <button
          className="group-bar__btn group-bar__btn--ghost"
          onClick={clearShipSelection}
          title="Clear the group (Esc)"
        >CLEAR</button>
      </div>

      {/* Pick-from-list transfer, for when the destination is off-screen
          or too small to shift-click comfortably. Same code path as the
          map gesture — both call groupMove. */}
      <div className="group-bar__row">
        <span className="group-bar__label">Transfer to</span>
        <select
          className="group-bar__select"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          title="Send the whole group to one world"
        >
          <option value="">Destination…</option>
          {destinations.map(d => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
        <button
          className="group-bar__btn group-bar__btn--primary"
          disabled={!dest || movable.length === 0}
          onClick={() => { if (dest) groupMove(dest); }}
          title={movable.length === 0
            ? 'Every ship in the group is already on a burn'
            : `Send ${movable.length} ship${movable.length === 1 ? '' : 's'}`}
        >
          SEND {movable.length}
        </button>
      </div>

      {/* Target-priority flyout — every drop applies to the whole group
          immediately, matching the stance buttons' apply model. */}
      {mpActions && showTargeting && gunners.length > 0 && (
        <div className="group-bar__targeting">
          <TargetPriorityCards
            value={sharedPriority}
            onChange={setTargeting}
            note={sharedPriority
              ? undefined
              : `Applies to ${gunners.length} armed hull${gunners.length === 1 ? '' : 's'} on drop.`}
          />
        </div>
      )}

      {/* CHAIN ORDERS. Sibling of the single-destination SEND above:
          that row is the fast path, this is the itinerary. Both end at
          the same place -- a burn per hull, solved from that hull's own
          orbit -- so a chain of one leg is exactly a SEND. */}
      {showChain && (
        <div className="group-bar__chain">
          <ChainOrderEditor
            steps={chain}
            onChange={setChain}
            bodies={gameState.bodies}
            note={movable.length === 0
              ? 'Every ship in the group is already on a burn.'
              : `Each of the ${movable.length} movable ship${movable.length === 1 ? '' : 's'} flies this from its own orbit.`}
          />
          <button
            className="group-bar__btn group-bar__btn--primary"
            disabled={chain.length === 0 || movable.length === 0}
            onClick={applyChain}
            title={chain.length === 0
              ? 'Add at least one leg'
              : `Launch ${movable.length} ship${movable.length === 1 ? '' : 's'} on a ${chain.length}-leg route`}
          >
            LAUNCH {movable.length} · {chain.length} LEG{chain.length === 1 ? '' : 'S'}
          </button>
        </div>
      )}

      <div className="group-bar__hint">
        {notice ?? 'Drag a box or shift-click to add · shift-click a world to send them there'}
      </div>
    </div>
  );
};
