// ============================================================
// GroupSelectionPanel — what you see in the ship-card slot when a
// GROUP is selected instead of a single hull.
//
// Selecting nine ships used to leave the left rail showing whichever
// single ship you happened to click last, so the card and the "9
// selected" action bar disagreed about what you were commanding. The
// bar could act on the group but never told you what was IN it.
//
// Status vocabulary, HP classes and row chrome are deliberately the
// Outliner's (shipStatus + .outliner__* classes, both global): a hull
// that reads "In Combat" in the outliner must read "In Combat" here.
// Duplicating either would let the two drift.
// ============================================================

import React, { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- iconClassFor/ShipIcon — icon refactor in flight
import { iconClassFor, ShipIcon } from './ShipIcons';
import { HullIcon } from './StructureIcons';
import { BottomSheet } from './BottomSheet';
import { effectiveShipMaxHp } from '../game/combat';
import { loadoutSummary } from '../game/shipParts';
import {
  shipStatus, isArmed,
  makeStationsAtBody, makeArmedHostilesAtBody, makeHostilesAtBody,
} from '../game/systemGrouping';
import { makePeaceCheck } from '../game/peace';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { Ship } from '../types';
import './Outliner.css';
import './GroupSelectionPanel.css';

/**
 * The selected group, resolved against LIVE state.
 *
 * Ships die or get sold out from under a stale id list, so a count must
 * come from what still exists rather than from selectedShipIds.length —
 * the rule GroupActionBar already follows.
 *
 * Exported because TWO components decide the ship-card slot from it:
 * this panel claims the slot at 2+, and ShipPanel yields the slot on the
 * same condition. If they computed it differently — say one counted ids
 * and the other counted live hulls — a group whose ships had all died
 * would hide ShipPanel while this returned null, leaving the slot empty.
 */
export function useGroupSelectionShips(): Ship[] {
  const { gameState, uiState } = useGameContext();
  const ids = uiState.selectedShipIds;
  return useMemo(
    () => (ids ?? [])
      .map(id => gameState.ships.find(s => s.id === id))
      .filter((s): s is Ship => !!s),
    [ids, gameState.ships],
  );
}

/** True when the group owns the ship-card slot. */
export function useGroupOwnsCardSlot(): boolean {
  return useGroupSelectionShips().length >= 2;
}

export const GroupSelectionPanel: React.FC = () => {
  const {
    gameState, uiState, selectShip, focusBody,
    toggleShipSelection, clearShipSelection,
  } = useGameContext();

  const ships = useGroupSelectionShips();

  // Presence probes for shipStatus. Built once per render rather than
  // per row: each walks the ship list, and a 20-hull group would
  // otherwise rescan it 60 times.
  // Factions at peace (NAP / defense pact) must NOT trigger "In Combat"
  // — the server never fires between them. Pairwise, not viewer-centric:
  // passing a set of MY peace partners makes everyone else's ships read
  // as fighting mine. See src/game/peace.ts.
  const atPeace = useMemo(
    () => makePeaceCheck(gameState.pactPairs),
    [gameState.pactPairs],
  );
  const stationsAtBody = useMemo(
    () => makeStationsAtBody(gameState.settlements),
    [gameState.settlements],
  );
  const armedHostilesAtBody = useMemo(
    () => makeArmedHostilesAtBody(gameState.ships, atPeace),
    [gameState.ships, atPeace],
  );
  const hostilesAtBody = useMemo(
    () => makeHostilesAtBody(gameState.ships, gameState.settlements, atPeace),
    [gameState.ships, gameState.settlements, atPeace],
  );

  const bodyName = (id: string | undefined) =>
    gameState.bodies.find(b => b.id === id)?.name ?? '—';

  const hpRatioOf = (ship: Ship) => {
    const max = effectiveShipMaxHp(ship, gameState.factionTech[ship.ownedBy]);
    return max > 0 ? (ship.hp ?? max) / max : 1;
  };
  const hpClass = (r: number) => (r > 0.66 ? 'good' : r > 0.33 ? 'mid' : 'low');

  // Roll-up: the two questions you actually have about a group are "how
  // beaten up is it" and "what is it made of".
  const summary = useMemo(() => {
    let hp = 0, maxHp = 0;
    const byClass = new Map<string, number>();
    for (const s of ships) {
      const max = effectiveShipMaxHp(s, gameState.factionTech[s.ownedBy]);
      hp += s.hp ?? max;
      maxHp += max;
      byClass.set(s.class, (byClass.get(s.class) ?? 0) + 1);
    }
    const classes = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([c, n]) => `${n}× ${getShipClass(c as ShipClassName).displayName}`)
      .join(' · ');
    return { hp: Math.round(hp), maxHp: Math.round(maxHp), classes };
  }, [ships, gameState.factionTech]);

  // Fewer than two live hulls isn't a group — let ShipPanel have the slot.
  if (ships.length < 2) return null;

  const hpPct = summary.maxHp > 0 ? Math.round((summary.hp / summary.maxHp) * 100) : 100;

  return (
    // BottomSheet is a PASS-THROUGH on desktop and a dock on mobile — and
    // it is NOT optional. mobile.css hides `.ship-panel` with
    // `display: none !important` unless it sits inside .bottom-sheet__body,
    // so reusing that class without this wrapper renders an invisible
    // panel on every phone. ShipPanel wraps itself exactly the same way.
    <BottomSheet open onClose={clearShipSelection} title={`${ships.length} ships selected`}>
      {/* Reuses .ship-panel deliberately: this occupies that exact slot,
          so it carries the same frame, border, slide-in and 55vh cap. A
          bespoke shell would drift from the card it stands in for. */}
      <div className="ship-panel group-selection-panel">
      <div className="panel-header">
        <span>{ships.length} SHIPS SELECTED</span>
        <button
          className="panel-close"
          onClick={clearShipSelection}
          title="Clear the selection"
        >✕</button>
      </div>

      <div className="gsp-summary">
        <div className="gsp-summary-row">
          <span className={`outliner__hp-dot outliner__hp-dot--${hpClass(hpPct / 100)}`} />
          <span>{summary.hp} / {summary.maxHp} HP · {hpPct}%</span>
        </div>
        {summary.classes && <div className="gsp-summary-classes">{summary.classes}</div>}
      </div>

      <div className="gsp-list">
        {ships.map(ship => {
          const r = hpRatioOf(ship);
          const def = getShipClass(ship.class as ShipClassName);
          const loadout = loadoutSummary(ship.parts);
          const status = shipStatus(
            ship, gameState.currentTick, r,
            // Armed hulls read "In Combat" when ANY hostile shares the
            // body; unarmed ones use the stricter armed-ship test so a
            // freighter parked near an enemy city isn't "fighting".
            // Same call the Outliner makes.
            (isArmed(ship) ? hostilesAtBody : armedHostilesAtBody)(ship.orbit.parentBodyId, ship.ownedBy),
            stationsAtBody(ship.orbit.parentBodyId, ship.ownedBy),
          );
          // In transit there is no parent orbit to name — say where it's
          // going instead, which is the useful fact mid-burn.
          const where = ship.transit
            ? `→ ${bodyName(ship.transit.currentTransfer?.targetBodyId)}`
            : bodyName(ship.orbit.parentBodyId);
          return (
            <div
              key={ship.id}
              className={`outliner__ship-row gsp-row ${uiState.selectedShipId === ship.id ? 'selected' : ''}`}
              onClick={() => {
                // Select AND locate — the reason to open this list is
                // usually "which of these is the hurt one, and where".
                // Does NOT clear the group: selectShip deliberately
                // leaves selectedShipIds alone, so the action bar below
                // still commands all nine.
                selectShip(ship.id);
                if (!ship.transit && ship.orbit?.parentBodyId) focusBody(ship.orbit.parentBodyId);
              }}
              title={`${def.displayName} — ${status.title}`}
            >
              <span className="outliner__ship-class">
                <HullIcon shipClass={ship.class} variant={ship.iconVariant} size={20} />
              </span>
              <span className="outliner__ship-name">{ship.name}</span>
              <span
                className={`outliner__status outliner__status--${status.cls}`}
                title={status.title}
              >{status.label}</span>
              {loadout && ship.parts && ship.parts.length > 0 && (
                <span className="outliner__ship-loadout" title="Fitted parts">{loadout}</span>
              )}
              <span className="gsp-where" title="Location">{where}</span>
              <span
                className={`outliner__hp-dot outliner__hp-dot--${hpClass(r)}`}
                title={`HP ${Math.round(r * 100)}%`}
              />
              <button
                className="gsp-drop"
                title="Remove from selection"
                onClick={(e) => { e.stopPropagation(); toggleShipSelection(ship.id); }}
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
    </BottomSheet>
  );
};
