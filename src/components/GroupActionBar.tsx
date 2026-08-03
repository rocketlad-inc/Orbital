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

import React, { useCallback, useEffect, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { useBulkTransfer } from '../hooks/useBulkTransfer';
import { humanizeMpError } from '../multiplayer/errorMessages';
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

  const ids = uiState.selectedShipIds ?? [];

  // Ships can die or be sold out from under a stale selection, so resolve
  // against live state rather than trusting the id list's length.
  const ships = ids
    .map(id => gameState.ships.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // A move needs a hull that isn't already committed to a burn — same
  // eligibility rule the Fleet panel's bulk transfer uses.
  const movable = ships.filter(s => !s.transit && !s.plannedTransit);

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
  // result.
  useEffect(() => { setNotice(null); }, [uiState.selectedShipIds]);

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
          </span>
        )}
        <button
          className="group-bar__btn group-bar__btn--ghost"
          onClick={clearShipSelection}
          title="Clear the group (Esc)"
        >CLEAR</button>
      </div>
      <div className="group-bar__hint">
        {notice ?? 'Drag a box or shift-click to add · shift-click a world to send them there'}
      </div>
    </div>
  );
};
