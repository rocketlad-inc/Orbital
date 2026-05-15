// ============================================================
// Outliner — persistent right-side list of bodies and ships
// Grouped by body, with separate "In Transit" section.
// ============================================================

import React, { useState, useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import './Outliner.css';

export const Outliner: React.FC = () => {
  const { gameState, uiState, selectShip, selectBody, focusBody } = useGameContext();
  const [collapsed, setCollapsed] = useState(false);

  const playerShips = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player'),
    [gameState.ships]
  );

  // Bodies of interest: owned by player OR have player ships orbiting
  const tracked = useMemo(() => {
    const bodyIds = new Set<string>();
    for (const b of gameState.bodies) {
      if (b.ownedBy === 'player') bodyIds.add(b.id);
    }
    for (const s of playerShips) {
      if (!s.transfer) bodyIds.add(s.orbit.parentBodyId);
    }
    return gameState.bodies
      .filter(b => bodyIds.has(b.id))
      .sort((a, b) => {
        // Player-owned first, then by name
        if (a.ownedBy === 'player' && b.ownedBy !== 'player') return -1;
        if (b.ownedBy === 'player' && a.ownedBy !== 'player') return 1;
        return a.name.localeCompare(b.name);
      });
  }, [gameState.bodies, playerShips]);

  const inTransit = useMemo(() => playerShips.filter(s => s.transfer), [playerShips]);

  const shipsAt = (bodyId: string) =>
    playerShips.filter(s => !s.transfer && s.orbit.parentBodyId === bodyId);

  const handleBodyClick = (bodyId: string) => {
    selectBody(bodyId);
    focusBody(bodyId);
  };

  const hpRatio = (ship: { hp?: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    const hp = ship.hp ?? def.hp;
    return hp / def.hp;
  };

  const hpClass = (r: number) =>
    r > 0.66 ? 'good' : r > 0.33 ? 'mid' : 'low';

  if (collapsed) {
    return (
      <div className="outliner outliner--collapsed">
        <div className="outliner__header">
          <button
            className="outliner__toggle"
            onClick={() => setCollapsed(false)}
            title="Expand outliner"
          >‹</button>
        </div>
      </div>
    );
  }

  return (
    <div className="outliner">
      <div className="outliner__header">
        <span className="outliner__title">Outliner</span>
        <button
          className="outliner__toggle"
          onClick={() => setCollapsed(true)}
          title="Collapse"
        >›</button>
      </div>
      <div className="outliner__body">
        <div className="outliner__section">
          <div className="outliner__section-title">Holdings</div>
          {tracked.length === 0 ? (
            <div className="outliner__empty">No tracked bodies</div>
          ) : (
            tracked.map(body => {
              const ships = shipsAt(body.id);
              const isOwned = body.ownedBy === 'player';
              return (
                <div className="outliner__group" key={body.id}>
                  <div
                    className={`outliner__body-row ${uiState.selectedBodyId === body.id ? 'selected' : ''}`}
                    onClick={() => handleBodyClick(body.id)}
                  >
                    <span
                      className="outliner__body-icon"
                      style={{ background: body.color }}
                    />
                    <span className="outliner__body-name">
                      {body.name}{isOwned ? ' ★' : ''}
                    </span>
                    {ships.length > 0 && (
                      <span className="outliner__body-count">{ships.length}</span>
                    )}
                  </div>
                  {ships.map(ship => {
                    const def = getShipClass(ship.class as ShipClassName);
                    const r = hpRatio(ship);
                    const lowFuel = ship.fuel < 20;
                    return (
                      <div
                        key={ship.id}
                        className={`outliner__ship-row ${uiState.selectedShipId === ship.id ? 'selected' : ''}`}
                        onClick={(e) => { e.stopPropagation(); selectShip(ship.id); }}
                      >
                        <span className="outliner__ship-class">{def.displayName.slice(0, 3)}</span>
                        <span className="outliner__ship-name">{ship.name}</span>
                        {lowFuel && <span className="outliner__ship-status outliner__ship-status--lowfuel">⛽</span>}
                        <span className={`outliner__hp-dot outliner__hp-dot--${hpClass(r)}`} title={`HP ${Math.round(r * 100)}%`} />
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {inTransit.length > 0 && (
          <div className="outliner__section">
            <div className="outliner__section-title">In Transit</div>
            {inTransit.map(ship => {
              const def = getShipClass(ship.class as ShipClassName);
              const target = gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId);
              const eta = ship.transfer!.arrivalTime - gameState.currentTick;
              const r = hpRatio(ship);
              return (
                <div
                  key={ship.id}
                  className={`outliner__ship-row ${uiState.selectedShipId === ship.id ? 'selected' : ''}`}
                  style={{ paddingLeft: 8 }}
                  onClick={() => selectShip(ship.id)}
                >
                  <span className="outliner__ship-class">{def.displayName.slice(0, 3)}</span>
                  <span className="outliner__ship-name">
                    {ship.name} → {target?.name || '?'} T-{Math.max(0, eta).toFixed(0)}
                  </span>
                  <span className={`outliner__hp-dot outliner__hp-dot--${hpClass(r)}`} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
