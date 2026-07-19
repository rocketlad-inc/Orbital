// ============================================================
// Outliner — persistent right-side list of bodies and ships
// Grouped by body, with separate "In Transit" section.
// ============================================================

import React, { useState, useMemo, useEffect } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { loadoutSummary } from '../game/shipParts';
import { ShipIcon } from './ShipIcons';
import { PlanetIcon } from './PlanetIcon';
import { makeSystemRootOf, systemLabel, shipStatus, makeHostilesAtBody } from '../game/systemGrouping';
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
    // On mobile the outliner overlays most of the canvas, so the
    // player can't see what they just selected until the drawer
    // gets out of the way. Collapse after any pick.
    if (isMobile) setCollapsed(true);
  };

  const handleSettlementClick = (settlementId: string, bodyId: string) => {
    selectSettlement(settlementId);
    selectBody(bodyId);
    focusBody(bodyId);
    if (isMobile) setCollapsed(true);
  };

  const handleShipClick = (shipId: string) => {
    selectShip(shipId);
    if (isMobile) setCollapsed(true);
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

  // --- System grouping -------------------------------------
  // Shared with FleetPanel (src/game/systemGrouping.ts) so both panels
  // show identical headers and statuses.
  const systemRootOf = useMemo(
    () => makeSystemRootOf(gameState.bodies),
    [gameState.bodies],
  );

  /** Tracked bodies bucketed by their PLANETARY system (Jupiter + the
   *  Galileans, Saturn + Titan), each bucket keeping the existing
   *  owned-first-then-alphabetical order. */
  const systems = useMemo(() => {
    const radiusOf = new Map(gameState.bodies.map(b => [b.id, b.orbitRadius ?? 0]));
    const buckets = new Map<string, typeof tracked>();
    for (const b of tracked) {
      const root = systemRootOf(b.id);
      const arr = buckets.get(root);
      if (arr) arr.push(b);
      else buckets.set(root, [b]);
    }
    return [...buckets.entries()]
      .map(([rootId, bodies]) => ({
        rootId,
        label: systemLabel(gameState.bodies, rootId),
        bodies,
        owned: bodies.filter(b => b.ownedBy === 'player').length,
      }))
      // Systems you hold first, then outward from the sun. Ordering the
      // rest by orbit radius keeps the list in the same mental order as
      // the map — Earth, Mars, Jupiter — instead of alphabetical jumble.
      .sort((a, b) =>
        (b.owned - a.owned) ||
        ((radiusOf.get(a.rootId) ?? 0) - (radiusOf.get(b.rootId) ?? 0)) ||
        a.label.localeCompare(b.label));
  }, [tracked, systemRootOf, gameState.bodies]);

  const currentTick = gameState.currentTick;

  /** "In Combat" means a hostile is here NOW — computed over ALL ships and
   *  settlements, not just the player's, since the enemy is the point. */
  const hostilesAtBody = useMemo(
    () => makeHostilesAtBody(gameState.ships, gameState.settlements),
    [gameState.ships, gameState.settlements],
  );

  /** Ship builds under way at a body, for the settlement rows. */
  const shipBuildsAt = (bodyId: string) =>
    (gameState.buildOrders ?? []).filter(
      bo => bo.bodyId === bodyId && bo.ownedBy === 'player' && bo.status !== 'waiting',
    );

  /** 0..1 completion for a start/complete tick pair. Guards a zero-length
   *  window so a same-tick build can't divide by zero. */
  const tickProgress = (startTick: number, completeTick: number) => {
    const span = completeTick - startTick;
    if (span <= 0) return 1;
    return Math.max(0, Math.min(1, (currentTick - startTick) / span));
  };

  if (collapsed) {
    const trackedCount = tracked.length + inTransit.length;
    return (
      <div className="outliner outliner--collapsed">
        <div className="outliner__header">
          <button
            className="outliner__toggle"
            onClick={() => setCollapsed(false)}
            title={`Show holdings${trackedCount > 0 ? ` (${trackedCount})` : ''}`}
            aria-label={`Show holdings${trackedCount > 0 ? `: ${trackedCount}` : ''}`}
          >
            <span className="outliner__toggle-icon">☰</span>
            {trackedCount > 0 && (
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
            systems.map(sys => (
              <div className="outliner__system" key={sys.rootId}>
                <div className="outliner__system-title">
                  {sys.label}
                  <span className="outliner__system-count">{sys.bodies.length}</span>
                </div>
                {sys.bodies.map(body => {
              const ships = shipsAt(body.id);
              const settlements = settlementsAt(body.id);
              const isOwned = body.ownedBy === 'player';
              const totalUnder = ships.length + settlements.length;
              const builds = shipBuildsAt(body.id);
              // Ship builds are queued per BODY, but they physically happen
              // at the yard. Showing them on the planet row too just says
              // the same thing twice, so they render on the station and the
              // planet row stays clean. Cities never host them.
              const yard = settlements.find(s => s.type !== 'city');
              // No station (yard destroyed mid-build, and the hull still
              // finishes) — fall back to the body row so an in-flight build
              // never silently disappears from the outliner.
              const bodyBuilds = yard ? [] : builds;
              return (
                <div className="outliner__group" key={body.id}>
                  <div
                    className={`outliner__body-row ${uiState.selectedBodyId === body.id ? 'selected' : ''}`}
                    onClick={() => handleBodyClick(body.id)}
                  >
                    {/* Same procedural art the map draws, so a body is
                        recognisable here instead of a generic colour dot. */}
                    <PlanetIcon body={body} size={16} className="outliner__body-icon" />
                    <span className="outliner__body-name">
                      {body.name}{isOwned ? ' ★' : ''}
                      {bodyBuilds.length > 0 && (
                        <span className="outliner__build">
                          <span className="outliner__build-label">
                            {bodyBuilds[0].shipName || bodyBuilds[0].shipClass} · {Math.max(0, bodyBuilds[0].completeTick - currentTick)}t
                            {bodyBuilds.length > 1 ? ` (+${bodyBuilds.length - 1})` : ''}
                          </span>
                          <span className="outliner__build-bar">
                            <span
                              className="outliner__build-fill"
                              style={{ width: `${Math.round(tickProgress(bodyBuilds[0].startTick, bodyBuilds[0].completeTick) * 100)}%` }}
                            />
                          </span>
                        </span>
                      )}
                    </span>
                    {totalUnder > 0 && (
                      <span className="outliner__body-count">{totalUnder}</span>
                    )}
                  </div>
                  {settlements.map(s => {
                    const upgrade = s.buildingQueue;
                    // Hulls show on the yard that's building them, and only
                    // there. They're queued per BODY, so rendering them on
                    // every settlement printed one ship twice — once under
                    // the city, once under the station.
                    const hulls = s.id === yard?.id ? builds : [];
                    const bar = upgrade
                      ? {
                          label: `${upgrade.kind} L${upgrade.targetLevel}`,
                          pct: tickProgress(upgrade.startTick, upgrade.completeTick),
                          eta: Math.max(0, upgrade.completeTick - currentTick),
                        }
                      : null;
                    return (
                      <div
                        key={s.id}
                        className={`outliner__ship-row ${selectedSettlementId === s.id ? 'selected' : ''}`}
                        onClick={(e) => { e.stopPropagation(); handleSettlementClick(s.id, body.id); }}
                        title={`${s.type} · pop ${s.population} · HP ${s.hp}/${s.maxHp}`}
                      >
                        <span className="outliner__ship-class">{s.type === 'city' ? '⌂' : '◇'}</span>
                        <span className="outliner__ship-name">
                          {s.name}
                          {bar && (
                            <span className="outliner__build">
                              <span className="outliner__build-label">
                                {bar.label} · {bar.eta}t
                              </span>
                              <span className="outliner__build-bar">
                                <span
                                  className="outliner__build-fill"
                                  style={{ width: `${Math.round(bar.pct * 100)}%` }}
                                />
                              </span>
                            </span>
                          )}
                          {hulls.length > 0 && (
                            <span className="outliner__build">
                              <span className="outliner__build-label">
                                {hulls[0].shipName || hulls[0].shipClass} · {Math.max(0, hulls[0].completeTick - currentTick)}t
                                {hulls.length > 1 ? ` (+${hulls.length - 1})` : ''}
                              </span>
                              <span className="outliner__build-bar">
                                <span
                                  className="outliner__build-fill"
                                  style={{ width: `${Math.round(tickProgress(hulls[0].startTick, hulls[0].completeTick) * 100)}%` }}
                                />
                              </span>
                            </span>
                          )}
                        </span>
                        <span className={`outliner__hp-dot outliner__hp-dot--${settlementHpClass(s)}`} />
                      </div>
                    );
                  })}
                  {ships.map(ship => {
                    const def = getShipClass(ship.class as ShipClassName);
                    const r = hpRatio(ship);
                    const loadout = loadoutSummary(ship.parts);
                    const status = shipStatus(ship, currentTick, r, hostilesAtBody(ship.orbit.parentBodyId, ship.ownedBy));
                    return (
                      <div
                        key={ship.id}
                        className={`outliner__ship-row ${uiState.selectedShipId === ship.id ? 'selected' : ''}`}
                        onClick={(e) => { e.stopPropagation(); handleShipClick(ship.id); }}
                      >
                        <span className="outliner__ship-class" title={def.displayName}>
                          <ShipIcon shipClass={ship.class as ShipClassName} size={22} />
                        </span>
                        <span className="outliner__ship-name">
                          {ship.name}
                          <span
                            className={`outliner__status outliner__status--${status.cls}`}
                            title={status.title}
                          >{status.label}</span>
                        </span>
                        {loadout && ship.parts && ship.parts.length > 0 && (
                          <span className="outliner__ship-loadout" title="Fitted parts">{loadout}</span>
                        )}
                        <span className={`outliner__hp-dot outliner__hp-dot--${hpClass(r)}`} title={`HP ${Math.round(r * 100)}%`} />
                      </div>
                    );
                  })}
                </div>
              );
                })}
              </div>
            ))
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
                  onClick={() => handleShipClick(ship.id)}
                >
                  <span className="outliner__ship-class" title={def.displayName}>
                    <ShipIcon shipClass={ship.class as ShipClassName} size={22} />
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
