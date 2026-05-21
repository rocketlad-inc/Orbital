// ============================================================
// Outliner — persistent right-side list of bodies and ships
// Grouped by body, with separate "In Transit" section.
// ============================================================

import React, { useState, useMemo, useEffect } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { ShipIcon } from './ShipIcons';
import { useIsMobile } from '../hooks/useIsMobile';
import './Outliner.css';

export const Outliner: React.FC = () => {
  const {
    gameState, uiState, selectShip, selectBody, focusBody,
    selectSettlement, selectedSettlementId,
  } = useGameContext();
  const isMobile = useIsMobile();
  // Default collapsed on mobile so it doesn't eat the whole screen.
  const [collapsed, setCollapsed] = useState<boolean>(() => isMobile);

  // If the viewport flips between mobile and desktop (rotation, devtools),
  // re-apply the sensible default.
  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // Escape closes the outliner on mobile (matches other drawer patterns).
  useEffect(() => {
    if (!isMobile || collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCollapsed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, collapsed]);

  // Mirror collapse state onto a body class so sibling fixed-position
  // panels (mp-dock in particular) can slide in/out alongside us. The
  // mp-dock anchors to right: 264px when we're open (clear of our 240px
  // width + 16px gutter) and right: 56px when we're collapsed (clear of
  // our 32px stub + same gutter). multiplayer.css owns the actual
  // declarations — this effect just publishes the signal.
  useEffect(() => {
    const cls = 'outliner-collapsed';
    if (collapsed) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [collapsed]);

  const playerShips = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player'),
    [gameState.ships]
  );

  const playerSettlements = useMemo(
    () => gameState.settlements.filter(s => s.ownedBy === 'player'),
    [gameState.settlements]
  );

  // Bodies of interest: owned, have player ships, or have player settlements
  const tracked = useMemo(() => {
    const bodyIds = new Set<string>();
    for (const b of gameState.bodies) {
      if (b.ownedBy === 'player') bodyIds.add(b.id);
    }
    for (const s of playerShips) {
      // Parked ships contribute their body to the outliner; ships
      // in transit appear in the dedicated In Transit section below.
      if (!s.transit) bodyIds.add(s.orbit.parentBodyId);
    }
    for (const s of playerSettlements) {
      bodyIds.add(s.bodyId);
    }
    return gameState.bodies
      .filter(b => bodyIds.has(b.id))
      .sort((a, b) => {
        if (a.ownedBy === 'player' && b.ownedBy !== 'player') return -1;
        if (b.ownedBy === 'player' && a.ownedBy !== 'player') return 1;
        return a.name.localeCompare(b.name);
      });
  }, [gameState.bodies, playerShips, playerSettlements]);

  const inTransit = useMemo(() => playerShips.filter(s => s.transit), [playerShips]);

  const shipsAt = (bodyId: string) =>
    playerShips.filter(s => !s.transit && s.orbit.parentBodyId === bodyId);

  const settlementsAt = (bodyId: string) =>
    playerSettlements.filter(s => s.bodyId === bodyId);

  const handleBodyClick = (bodyId: string) => {
    selectBody(bodyId);
    focusBody(bodyId);
  };

  const handleSettlementClick = (settlementId: string, bodyId: string) => {
    selectSettlement(settlementId);
    selectBody(bodyId);
    focusBody(bodyId);
  };

  const settlementHpClass = (s: { hp: number; maxHp: number }) => {
    const r = s.hp / s.maxHp;
    return r > 0.66 ? 'good' : r > 0.33 ? 'mid' : 'low';
  };

  const hpRatio = (ship: { hp?: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    const hp = ship.hp ?? def.hp;
    return hp / def.hp;
  };

  const hpClass = (r: number) =>
    r > 0.66 ? 'good' : r > 0.33 ? 'mid' : 'low';

  if (collapsed) {
    const trackedCount = tracked.length + inTransit.length;
    return (
      <div className="outliner outliner--collapsed">
        <div className="outliner__header">
          <button
            className="outliner__toggle"
            onClick={() => setCollapsed(false)}
            title="Show holdings"
            aria-label="Show holdings"
          >
            {isMobile ? '☰' : '‹'}
            {isMobile && trackedCount > 0 && (
              <span className="outliner__toggle-badge">{trackedCount}</span>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {isMobile && (
        <div
          className="outliner__scrim"
          onClick={() => setCollapsed(true)}
          aria-hidden
        />
      )}
      <div
        className={`outliner${isMobile ? ' outliner--mobile' : ''}`}
        data-tutorial-id="outliner"
      >
      <div className="outliner__header">
        <span className="outliner__title">Outliner</span>
        <button
          className="outliner__toggle"
          onClick={() => setCollapsed(true)}
          title="Collapse"
          aria-label="Close"
        >{isMobile ? '✕' : '›'}</button>
      </div>
      <div className="outliner__body">
        <div className="outliner__section">
          <div className="outliner__section-title">Holdings</div>
          {tracked.length === 0 ? (
            <div className="outliner__empty">No tracked bodies</div>
          ) : (
            tracked.map(body => {
              const ships = shipsAt(body.id);
              const settlements = settlementsAt(body.id);
              const isOwned = body.ownedBy === 'player';
              const totalUnder = ships.length + settlements.length;
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
                    {totalUnder > 0 && (
                      <span className="outliner__body-count">{totalUnder}</span>
                    )}
                  </div>
                  {settlements.map(s => (
                    <div
                      key={s.id}
                      className={`outliner__ship-row ${selectedSettlementId === s.id ? 'selected' : ''}`}
                      onClick={(e) => { e.stopPropagation(); handleSettlementClick(s.id, body.id); }}
                      title={`${s.type} · pop ${s.population} · HP ${s.hp}/${s.maxHp}`}
                    >
                      <span className="outliner__ship-class">{s.type === 'city' ? '⌂' : '◇'}</span>
                      <span className="outliner__ship-name">{s.name}</span>
                      <span className={`outliner__hp-dot outliner__hp-dot--${settlementHpClass(s)}`} />
                    </div>
                  ))}
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
                        <span className="outliner__ship-class" title={def.displayName}>
                          <ShipIcon shipClass={ship.class as ShipClassName} size={14} />
                        </span>
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
          <div className="outliner__section" data-tutorial-id="outliner-transit">
            <div className="outliner__section-title">In Transit</div>
            {inTransit.map(ship => {
              const def = getShipClass(ship.class as ShipClassName);
              // Pull target + ETA from the ship's torch transit state.
              const targetBodyId = ship.transit!.currentTransfer.targetBodyId;
              const arrivalTick = ship.transit!.currentTransfer.arriveTick;
              const target = gameState.bodies.find(b => b.id === targetBodyId);
              const eta = arrivalTick - gameState.currentTick;
              const r = hpRatio(ship);
              return (
                <div
                  key={ship.id}
                  className={`outliner__ship-row ${uiState.selectedShipId === ship.id ? 'selected' : ''}`}
                  style={{ paddingLeft: 8 }}
                  onClick={() => selectShip(ship.id)}
                >
                  <span className="outliner__ship-class" title={def.displayName}>
                    <ShipIcon shipClass={ship.class as ShipClassName} size={14} />
                  </span>
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
    </>
  );
};
