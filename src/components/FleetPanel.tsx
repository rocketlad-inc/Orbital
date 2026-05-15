// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { FUEL_ENABLED } from '../game/featureFlags';
import { ShipIcon } from './ShipIcons';
import './OverviewPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy';

export const FleetPanel: React.FC<FleetPanelProps> = ({ onClose }) => {
  const { gameState, selectShip, focusBody, uiState } = useGameContext();
  const [filter, setFilter] = useState<Filter>('player');

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

    return (
      <tr
        key={ship.id}
        className={isSelected ? 'selected' : ''}
        onClick={() => handleShipClick(ship.id)}
      >
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
        {FUEL_ENABLED && <td>{renderFuelBar(ship)}</td>}
      </tr>
    );
  };

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
                  <thead>
                    <tr>
                      <th>Ship</th>
                      <th>Owner</th>
                      <th>Status</th>
                      <th>Destination</th>
                      <th>HP</th>
                      {FUEL_ENABLED && <th>Fuel</th>}
                    </tr>
                  </thead>
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
                    <thead>
                      <tr>
                        <th>Ship</th>
                        <th>Owner</th>
                        <th>Status</th>
                        <th>Location</th>
                        <th>HP</th>
                        {FUEL_ENABLED && <th>Fuel</th>}
                      </tr>
                    </thead>
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
