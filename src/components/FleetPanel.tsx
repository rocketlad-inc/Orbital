// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { ShipIcon } from './ShipIcons';
import { planBezierTransfer } from '../physics/bezierTransfer';
import { travelTimeModifier, FactionTechState } from '../game/techs';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { ManeuverNode } from '../types';
import './OverviewPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy';

export const FleetPanel: React.FC<FleetPanelProps> = ({ onClose }) => {
  const {
    gameState, selectShip, focusBody, uiState,
    addManeuverNode, setPendingTransfer,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [filter, setFilter] = useState<Filter>('player');
  // Bulk-select set: ship ids the player has checked for a bulk
  // maneuver action. Only player-owned ships can join the set.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkError, setBulkError] = useState<string | null>(null);

  const ships = useMemo(() => {
    return gameState.ships.filter(s => {
      if (filter === 'player') return s.ownedBy === 'player';
      if (filter === 'enemy') return s.ownedBy === 'enemy';
      return true;
    });
  }, [gameState.ships, filter]);

  const inTransit = useMemo(() => ships.filter(s => s.transfer), [ships]);
  const orbiting = useMemo(() => ships.filter(s => !s.transfer), [ships]);

  // Group orbiting ships by parent body id
  const orbitingByBody = useMemo(() => {
    const map = new Map<string, typeof orbiting>();
    for (const s of orbiting) {
      const list = map.get(s.orbit.parentBodyId) || [];
      list.push(s);
      map.set(s.orbit.parentBodyId, list);
    }
    return Array.from(map.entries()).sort((a, b) => {
      const aBody = gameState.bodies.find(x => x.id === a[0]);
      const bBody = gameState.bodies.find(x => x.id === b[0]);
      return (aBody?.name || '').localeCompare(bBody?.name || '');
    });
  }, [orbiting, gameState.bodies]);

  const handleShipClick = (shipId: string) => {
    selectShip(shipId);
  };

  const handleBodyClick = (bodyId: string) => {
    focusBody(bodyId);
  };

  const toggleSelected = (shipId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(shipId)) next.delete(shipId);
      else next.add(shipId);
      return next;
    });
  };

  // Set of player ships currently eligible for a bulk transfer
  // (orbiting, with no pending or in-flight transfer already attached).
  const bulkEligibleIds = useMemo(() => {
    return new Set(
      gameState.ships
        .filter(s => s.ownedBy === 'player' && !s.transfer && !s.pendingTransfer)
        .map(s => s.id)
    );
  }, [gameState.ships]);

  const visibleSelected = useMemo(
    () => Array.from(selectedIds).filter(id => bulkEligibleIds.has(id)),
    [selectedIds, bulkEligibleIds]
  );

  // Bodies the player can route to (everything except Sol).
  const transferTargets = useMemo(
    () => gameState.bodies.filter(b => b.id !== 'sol').sort((a, b) => a.name.localeCompare(b.name)),
    [gameState.bodies]
  );

  const issueBulkTransfer = () => {
    setBulkError(null);
    if (!bulkTarget) { setBulkError('Pick a destination'); return; }
    const target = gameState.bodies.find(b => b.id === bulkTarget);
    if (!target) { setBulkError('Unknown destination'); return; }
    if (visibleSelected.length === 0) { setBulkError('No eligible ships selected'); return; }

    const playerTech = gameState.factionTech?.player as FactionTechState | undefined;
    const travelMul = travelTimeModifier(playerTech);
    let issued = 0;
    for (const sid of visibleSelected) {
      const ship = gameState.ships.find(s => s.id === sid);
      if (!ship) continue;
      const arc = planBezierTransfer(ship.orbit, bulkTarget, gameState.currentTick, gameState.bodies, travelMul);
      if (!arc) continue;
      const node: ManeuverNode = {
        id: `node-${Date.now()}-${Math.random()}`,
        shipId: ship.id,
        type: 'transfer',
        burnTime: arc.departureTime,
        deltav: arc.departureDv,
        prograde: arc.departureDv,
        radial: 0,
        normal: 0,
        status: 'planned',
        label: arc.label,
      };
      addManeuverNode(node);
      setPendingTransfer(ship.id, arc);
      if (mpActions) {
        mpActions.transfer({
          shipId: ship.id,
          targetBodyId: arc.arrivalBodyId,
          scheduledT: arc.departureTime,
          arrivalT: arc.arrivalTime,
          dvPrograde: arc.departureDv,
          fuelCost: Math.round(Math.abs(arc.departureDv) * 10),
        });
      }
      issued += 1;
    }
    if (issued === 0) setBulkError('Could not plan a transfer for any selected ship');
    else {
      setSelectedIds(new Set());
      setBulkTarget('');
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkError(null);
  };

  const ownerBadge = (ownedBy: string) => {
    if (ownedBy === 'player') return <span className="owner-badge owner-badge--player">Player</span>;
    if (ownedBy === 'enemy') return <span className="owner-badge owner-badge--enemy">Enemy</span>;
    return <span className="owner-badge owner-badge--neutral">{ownedBy}</span>;
  };

  const renderHpBar = (ship: { hp?: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    const hp = ship.hp ?? def.hp;
    const ratio = hp / def.hp;
    const hpClass = ratio > 0.66 ? 'good' : ratio > 0.33 ? 'mid' : 'low';
    return (
      <div className="status-bar">
        <div className="status-bar__fill">
          <div
            className={`status-bar__inner status-bar__inner--hp-${hpClass}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <span className="status-bar__text">{Math.round(hp)}/{def.hp}</span>
      </div>
    );
  };

  const renderFuelBar = (ship: { fuel: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    const ratio = ship.fuel / def.fuelCapacity;
    const fuelClass = ratio > 0.25 ? 'good' : 'low';
    return (
      <div className="status-bar">
        <div className="status-bar__fill">
          <div
            className={`status-bar__inner status-bar__inner--fuel-${fuelClass}`}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
        <span className="status-bar__text">{Math.round(ship.fuel)}</span>
      </div>
    );
  };

  const renderShipRow = (ship: typeof ships[0]) => {
    const def = getShipClass(ship.class as ShipClassName);
    const isSelected = uiState.selectedShipId === ship.id;
    const transit = ship.transfer;
    const target = transit ? gameState.bodies.find(b => b.id === transit.arrivalBodyId) : null;
    const eta = transit ? Math.max(0, transit.arrivalTime - gameState.currentTick) : null;

    let statusBadge;
    if (transit) {
      statusBadge = <span className="status-badge status-badge--transit">In Transit</span>;
    } else if (ship.pendingTransfer) {
      statusBadge = <span className="status-badge status-badge--planned">Planned</span>;
    } else {
      statusBadge = <span className="status-badge status-badge--orbiting">Orbiting</span>;
    }

    const eligible = bulkEligibleIds.has(ship.id);
    const checked = selectedIds.has(ship.id);
    return (
      <tr
        key={ship.id}
        className={isSelected ? 'selected' : ''}
        onClick={() => handleShipClick(ship.id)}
      >
        <td onClick={(e) => e.stopPropagation()} style={{ width: 32, textAlign: 'center' }}>
          {eligible ? (
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggleSelected(ship.id)}
              title="Add to bulk selection"
              style={{ cursor: 'pointer' }}
            />
          ) : (
            <span title="Not eligible (not player-owned, or already in transit/planned)" style={{ opacity: 0.25 }}>—</span>
          )}
        </td>
        <td>
          <div className="body-cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ color: '#4ecdc4', flexShrink: 0 }}>
              <ShipIcon shipClass={ship.class as ShipClassName} size={20} />
            </div>
            <div>
              <div className="body-cell__name">{ship.name}</div>
              <div className="body-cell__type">{def.displayName} · {ship.class}</div>
            </div>
          </div>
        </td>
        <td>{ownerBadge(ship.ownedBy)}</td>
        <td>{statusBadge}</td>
        <td>
          {transit && target ? (
            <span>→ <strong style={{ color: '#4ecdc4' }}>{target.name}</strong> · T-{eta}</span>
          ) : (
            <span className="col-muted">{ship.orbit.parentBodyId.toUpperCase()}</span>
          )}
        </td>
        <td>{renderHpBar(ship)}</td>
        <td>{renderFuelBar(ship)}</td>
      </tr>
    );
  };

  const tableHead = (locationLabel: string) => (
    <thead>
      <tr>
        <th style={{ width: 32 }}></th>
        <th>Ship</th>
        <th>Owner</th>
        <th>Status</th>
        <th>{locationLabel}</th>
        <th>HP</th>
        <th>Fuel</th>
      </tr>
    </thead>
  );

  return (
    <div className="overview-panel">
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Fleet</div>
          <div className="overview-panel__title-sub">{ships.length} ships · {orbiting.length} orbiting · {inTransit.length} in transit</div>
        </div>
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="overview-panel__filters">
        {(['player', 'enemy', 'all'] as Filter[]).map(f => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {visibleSelected.length > 0 && (
        <div className="fleet-bulk-bar">
          <div className="fleet-bulk-bar__count">
            {visibleSelected.length} ship{visibleSelected.length === 1 ? '' : 's'} selected
          </div>
          <div className="fleet-bulk-bar__actions">
            <label className="fleet-bulk-bar__label">Transfer all to</label>
            <select
              className="fleet-bulk-bar__select"
              value={bulkTarget}
              onChange={(e) => setBulkTarget(e.target.value)}
            >
              <option value="">Select destination…</option>
              {transferTargets.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <button
              className="fleet-bulk-bar__btn fleet-bulk-bar__btn--primary"
              onClick={issueBulkTransfer}
              disabled={!bulkTarget}
            >
              Issue {visibleSelected.length} orders
            </button>
            <button
              className="fleet-bulk-bar__btn"
              onClick={clearSelection}
            >
              Clear
            </button>
          </div>
          {bulkError && <div className="fleet-bulk-bar__error">{bulkError}</div>}
        </div>
      )}

      <div className="overview-panel__body">
        {ships.length === 0 ? (
          <div className="overview-empty">No ships match the current filter.</div>
        ) : (
          <>
            {inTransit.length > 0 && (
              <div className="overview-section">
                <div className="overview-section__title">
                  In Transit
                  <span className="overview-section__count">{inTransit.length} ships</span>
                </div>
                <table className="overview-table">
                  {tableHead('Destination')}
                  <tbody>
                    {inTransit.map(renderShipRow)}
                  </tbody>
                </table>
              </div>
            )}

            {orbitingByBody.map(([bodyId, bodyShips]) => {
              const body = gameState.bodies.find(b => b.id === bodyId);
              return (
                <div className="overview-section" key={bodyId}>
                  <div className="overview-section__title">
                    <span
                      onClick={() => handleBodyClick(bodyId)}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                      title="Click to focus map"
                    >
                      <span style={{
                        width: 10, height: 10, borderRadius: '50%',
                        background: body?.color || '#888',
                        display: 'inline-block',
                      }} />
                      Orbiting {body?.name || bodyId}
                    </span>
                    <span className="overview-section__count">{bodyShips.length} ships</span>
                  </div>
                  <table className="overview-table">
                    {tableHead('Location')}
                    <tbody>
                      {bodyShips.map(renderShipRow)}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
