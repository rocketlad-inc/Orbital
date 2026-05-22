import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { Ship, Body, Settlement, TradeRoute } from '../types';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { maintenanceRatesForShip } from '../game/maintenance';
import { rankHpMul } from '../game/techs';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { useIsMobile } from '../hooks/useIsMobile';
import { ShipIcon } from './ShipIcons';
import {
  BINARY_SYSTEM_BODY_IDS,
  BLACK_HOLE_SYSTEM_BODY_IDS,
} from '../state/mockGameState';
import { BottomSheet } from './BottomSheet';
import './ShipPanel.css';

export const ShipPanel: React.FC = () => {
  const {
    gameState, uiState, deselectShip, setGameState,
    deleteManeuverNode, setTargetSelectionMode,
    launchTorchTransfer, enqueueTorchTransfer, planTorchPreview, cancelTorchPreview,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    createTradeRoute, cancelTradeRoute,
  } = useGameContext();

  // In multiplayer this is non-null and we post intent to the server in
  // addition to mutating local state (so the UI feels responsive while
  // waiting for the next /state poll to reconcile).
  const mpActions = useMultiplayerActions();
  const isMobile = useIsMobile();

  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [fleetModalOpen, setFleetModalOpen] = useState(false);
  const [propagateTransferToFleet, setPropagateTransferToFleet] = useState(true);
  // Server-side transfer rejection — shown inline above the COMMIT
  // button when MP rejects the burn (e.g. ship was captured between
  // plan and commit). Without this the TRANSFER / COMMIT click looks
  // like it worked but the next /state poll silently rewinds the
  // optimistic local state.
  const [transferError, setTransferError] = useState<string | null>(null);

  const ship = uiState.selectedShipId
    ? gameState.ships.find(s => s.id === uiState.selectedShipId) || null
    : null;

  const transferHandlerRef = useRef<(bodyId: string) => void>(() => {});

  useEffect(() => {
    if (!ship) return;

    transferHandlerRef.current = (targetBodyId: string) => {
      // Two flows depending on the ship's state:
      //
      // 1. SHIP IN TRANSIT (or has queued legs): chain-extension.
      //    enqueueTorchTransfer plans a new leg from the prior leg's
      //    predicted arrival; visible immediately as a queued dashed
      //    preview on the map. Auto-commits — there's no separate
      //    confirm step for chained legs.
      //
      // 2. SHIP PARKED: stage a torch preview via planTorchPreview.
      //    The ship's plannedTransit field holds the plan; the map
      //    renderer shows the dashed amber arc. The COMMIT button
      //    promotes it via launchTorchTransfer.
      if (ship.transit || (ship.queuedTransits && ship.queuedTransits.length > 0)) {
        const queuedPlan = enqueueTorchTransfer(ship.id, targetBodyId);
        if (queuedPlan && mpActions) {
          setTransferError(null);
          mpActions.transfer({
            shipId: ship.id,
            targetBodyId,
            scheduledT: queuedPlan.startTick,
            arrivalT: queuedPlan.arriveTick,
            dvPrograde: queuedPlan.totalDv,
            fuelCost: Math.round(queuedPlan.totalDv * 10),
          }).then(res => {
            if (!res.ok) {
              setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
            }
          });
        }
        setTransferModalOpen(false);
        setTargetSelectionMode(false);
        return;
      }

      // Parked ship: stage a torch preview (NOT committed). Player
      // clicks COMMIT to promote it to a live burn (commitTransferLocal).
      const plan = planTorchPreview(ship.id, targetBodyId);
      if (!plan) {
        console.warn('[transfer] planTorchPreview returned null', {
          shipId: ship.id, target: targetBodyId,
        });
        return;
      }

      // Fleet propagation: stage previews for every fleet member from
      // their own orbits so the player can COMMIT ALL in one click.
      if (propagateTransferToFleet && ship.fleetId) {
        const fleet = gameState.fleets.find(f => f.id === ship.fleetId);
        if (fleet) {
          for (const memberId of fleet.shipIds) {
            if (memberId === ship.id) continue;
            const member = gameState.ships.find(s => s.id === memberId);
            if (!member || member.transit) continue;
            planTorchPreview(member.id, targetBodyId);
          }
        }
      }

      setTransferModalOpen(false);
      setTargetSelectionMode(false);
    };
  }, [
    ship, gameState, planTorchPreview, enqueueTorchTransfer,
    setTargetSelectionMode, propagateTransferToFleet, mpActions,
  ]);

  const handleTransferConfirmEvent = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.bodyId) {
      transferHandlerRef.current(detail.bodyId);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('orbital-transfer-confirm', handleTransferConfirmEvent);
    return () => window.removeEventListener('orbital-transfer-confirm', handleTransferConfirmEvent);
  }, [handleTransferConfirmEvent]);

  if (!ship) return null;

  const handleTransferManeuver = (targetBodyId: string) => {
    transferHandlerRef.current(targetBodyId);
  };

  /**
   * Commit a planned transfer locally + post the intent to the server
   * (multiplayer only). Two-step action preserved: planning a transfer
   * stages a torch preview (ship.plannedTransit, dashed preview arc),
   * COMMIT promotes that preview to a live burn via launchTorchTransfer.
   * Previously the server post happened at plan time, which made every
   * transfer auto-fire ~1.5s later when /state polled back the server's
   * 'committed' record.
   */
  const commitTransferLocal = (owningShip: typeof ship) => {
    // The planned preview holds the target body. Promote via
    // launchTorchTransfer (the context method clears plannedTransit
    // and sets ship.transit atomically).
    const preview = owningShip.plannedTransit;
    if (!preview) {
      console.warn('[transfer] commitTransferLocal: no plannedTransit on ship', owningShip.id);
      return;
    }
    const plan = launchTorchTransfer(owningShip.id, preview.targetBodyId);
    if (!plan) {
      console.warn('[transfer] launchTorchTransfer rejected', { shipId: owningShip.id, target: preview.targetBodyId });
      return;
    }
    if (!mpActions) return;
    // Post the torch-derived arrival to the server so its DB row, the
    // alarm's in_transit→arrive transition, and the other clients' MP
    // reconstruction all agree exactly.
    setTransferError(null);
    mpActions.transfer({
      shipId: owningShip.id,
      targetBodyId: preview.targetBodyId,
      scheduledT: plan.startTick,
      arrivalT: plan.arriveTick,
      // dvPrograde is a Δv magnitude on the server; the maneuver-node
      // display reconstructs `deltav = sqrt(prograde²+normal²+radial²)`
      // and we want it to read the full burn cost, not half of it.
      dvPrograde: plan.totalDv,
      fuelCost: Math.round(plan.totalDv * 10),
    }).then(res => {
      if (!res.ok) {
        setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
      }
    });
  };

  const handleRemoveQueuedTransfer = (index: number) => {
    const queue = ship.queuedTransits || [];
    if (index >= queue.length) return;
    const newQueue = queue.slice(0, index);
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s =>
        s.id === ship.id
          ? { ...s, queuedTransits: newQueue.length > 0 ? newQueue : undefined }
          : s
      ),
    });
  };

  const handleFormFleet = (peerIds: string[]) => {
    if (peerIds.length === 0) return;
    const allIds = [ship.id, ...peerIds];
    // Auto-generate a fleet name like "Earth Group" from the parent body
    const parent = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);
    const name = `${parent?.name ?? 'Fleet'} Group`;
    createFleet(name, allIds);
    setFleetModalOpen(false);
  };

  const handleAddPeersToFleet = (peerIds: string[]) => {
    if (!ship.fleetId) return;
    for (const id of peerIds) addToFleet(ship.fleetId, id);
    setFleetModalOpen(false);
  };

  // "Has existing transfer" gates the TRANSFER button — a ship already
  // committed to a destination (live torch burn OR staged preview)
  // can't accept a new plan. Chained legs come in through the
  // ship.transit branch via enqueueTorchTransfer.
  const hasExistingTransfer = !!(ship.transit || ship.plannedTransit);

  // Location label: target name during transit OR preview, parent body
  // name when parked.
  const transitTarget = ship.transit?.currentTransfer.targetBodyId;
  const previewTarget = ship.plannedTransit?.targetBodyId;
  const targetForLabel = transitTarget ?? previewTarget;
  const locationLabel = targetForLabel
    ? `→ ${gameState.bodies.find(b => b.id === targetForLabel)?.name || '?'}`
    : ship.orbit.parentBodyId.toUpperCase();

  // ETA: ticks-until-arrival for live transits; ticks-until-burn-start
  // for previews (which is just 0 since torch fires on commit).
  const eta = ship.transit
    ? ship.transit.currentTransfer.arriveTick - gameState.currentTick
    : ship.plannedTransit
      ? ship.plannedTransit.arriveTick - gameState.currentTick
      : null;

  // Queue (torch chained legs).
  const queuedTransits = ship.queuedTransits || [];

  // Ship class stats
  const shipClass = getShipClass(ship.class as ShipClassName);

  // Maintenance — repair/refuel rates at current location
  const maintenance = maintenanceRatesForShip(ship, gameState.bodies, gameState.settlements);
  // maxHp factors in veterancy (+1% per rank). Combat.ts + maintenance.ts
  // both apply the same multiplier, so the displayed cap matches the
  // actual cap the heal loop fills to.
  const maxHp = Math.round(shipClass.hp * rankHpMul(ship.rank));
  const maxFuel = shipClass.fuelCapacity;
  const currentHp = ship.hp ?? maxHp;
  const hpAtMax = currentHp >= maxHp;
  const fuelAtMax = ship.fuel >= maxFuel;

  // Fleet — current fleet (if any) and ships eligible to fleet with at this body
  const currentFleet = ship.fleetId
    ? gameState.fleets.find(f => f.id === ship.fleetId) ?? null
    : null;
  const fleetMembers = currentFleet
    ? gameState.ships.filter(s => currentFleet.shipIds.includes(s.id))
    : [];
  // Eligible peers: same faction, same parent body, not in transit, not this ship, not already in *this* fleet
  const eligiblePeers = !ship.transit
    ? gameState.ships.filter(s =>
        s.id !== ship.id &&
        s.ownedBy === ship.ownedBy &&
        s.orbit.parentBodyId === ship.orbit.parentBodyId &&
        !s.transit &&
        s.fleetId !== ship.fleetId
      )
    : [];

  // Mobile target-selection mode: hide the ship panel BottomSheet so the
  // canvas underneath is fully tappable for target picking. The panel
  // re-mounts automatically when the player picks a target (which clears
  // targetSelectionMode in the transfer handler) or cancels.
  // Desktop is unaffected — the panel docks to the side and doesn't cover
  // the canvas.
  const hideForTargeting = isMobile && uiState.targetSelectionMode;

  return (
    <>
      {/* Floating cancel banner during mobile target selection. The map
          HUD already prints "SELECT TARGET BODY", but mobile has no ESC
          key — so we surface a tappable Cancel here. */}
      {hideForTargeting && (
        <div
          className="ship-target-banner"
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)',
            zIndex: 1090,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 14px',
            background: 'linear-gradient(180deg, #1a2433 0%, #0a1018 100%)',
            border: '1px solid #ffb84d',
            borderRadius: 8,
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.55)',
            fontFamily: "'JetBrains Mono', monospace",
            color: '#ffb84d',
            fontSize: 11,
            letterSpacing: '0.08em',
          }}
        >
          <span>TAP A BODY → {ship.name.toUpperCase()}</span>
          <button
            onClick={() => setTargetSelectionMode(false)}
            style={{
              border: '1px solid #ff5e5e',
              background: 'transparent',
              color: '#ff5e5e',
              fontFamily: 'inherit',
              fontSize: 11,
              padding: '6px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >
            CANCEL
          </button>
        </div>
      )}

      <BottomSheet open={!hideForTargeting} onClose={deselectShip} title={`Ship: ${ship.name}`}>
      <div className="ship-panel" data-tutorial-id="ship-panel">
        <div className="panel-header">
          <span>
            SHIP: {ship.name}
            {(ship.rank ?? 0) > 0 && (
              // Veterancy chip — every kill +1 rank, +1% damage/HP.
              // The number is what other systems also surface (combat
              // log, threat panel) so players learn what RANK means.
              <span
                style={{
                  marginLeft: 6,
                  padding: '1px 6px',
                  fontSize: 9,
                  letterSpacing: '0.1em',
                  background: 'rgba(255, 184, 77, 0.18)',
                  border: '1px solid #ffb84d',
                  color: '#ffb84d',
                  borderRadius: 3,
                  verticalAlign: 'middle',
                }}
                title={`Rank ${ship.rank}: +${ship.rank ?? 0}% damage, +${ship.rank ?? 0}% max HP`}
              >RANK {ship.rank}</span>
            )}
          </span>
          <button className="panel-close" onClick={deselectShip}>✕</button>
        </div>

        <div className="panel-body">
          <div className="ship-stats" data-tutorial-id="ship-stats">
            <div className="stat-row">
              <span className="label">CLASS</span>
              <span className="value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#4ecdc4', display: 'inline-flex' }}>
                  <ShipIcon shipClass={ship.class as ShipClassName} size={16} />
                </span>
                {ship.class.toUpperCase()}
              </span>
            </div>
            <div className="stat-row">
              <span className="label">OWNER</span>
              {(() => {
                // Faction lookup: in MP the caller's faction id is
                // rewritten to 'player' (see MultiplayerGameProvider
                // PLAYER_TOKEN) so a single find on ownedBy works for
                // both SP + MP. Render a colored chip so a glance tells
                // you "mine / theirs / whose theirs" at the same colors
                // ships now render in on the map.
                const owner = gameState.factions.find(f => f.id === ship.ownedBy);
                const ownerColor = owner?.color || '#b8c8d6';
                const ownerName = owner?.name || ship.ownedBy.toUpperCase();
                const isMine = ship.ownedBy === 'player';
                return (
                  <span
                    className="value"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 10, height: 10, borderRadius: '50%',
                        background: ownerColor, flexShrink: 0,
                        boxShadow: `0 0 4px ${ownerColor}`,
                      }}
                    />
                    <span style={{ color: ownerColor, fontWeight: 700 }}>
                      {ownerName}
                    </span>
                    {isMine && (
                      <span style={{ color: '#b8c8d6', fontSize: '9px', marginLeft: 2 }}>
                        (you)
                      </span>
                    )}
                  </span>
                );
              })()}
            </div>
            <div className="stat-row">
              <span className="label">HP</span>
              <span className="value" style={{ color: currentHp < maxHp * 0.3 ? '#ff5e5e' : undefined }}>
                {currentHp.toFixed(0)}/{maxHp}
                {maintenance.repairRate > 0 && !hpAtMax && (
                  <span style={{ color: '#4ecdc4', marginLeft: 6, fontSize: '9px' }}>
                    +{maintenance.repairRate}/t
                  </span>
                )}
              </span>
            </div>
            <div className="stat-row">
              <span className="label">FUEL</span>
              <span className="value">
                {ship.fuel.toFixed(0)}/{maxFuel} kt
                {maintenance.refuelRate > 0 && !fuelAtMax && (
                  <span style={{ color: '#ffb84d', marginLeft: 6, fontSize: '9px' }}>
                    +{maintenance.refuelRate}/t
                  </span>
                )}
              </span>
            </div>
            <div className="stat-row">
              <span className="label">LOCATION</span>
              <span className="value">{locationLabel}</span>
            </div>
            {ship.transit && eta != null && eta > 0 && (
              <div className="stat-row">
                <span className="label">ETA</span>
                <span className="value">T-{eta.toFixed(0)} ticks</span>
              </div>
            )}
            {ship.plannedTransit && !ship.transit && (
              <div className="stat-row">
                <span className="label">STATUS</span>
                <span className="value">TRANSFER PLANNED</span>
              </div>
            )}
          </div>

          {/* Freighters show TRADE LOG (delivery count) instead of
              COMBAT RECORD (confirmed kills) — they're cargo haulers,
              not warships, and "0 confirmed kills" was a category
              error that read as "underperforming" instead of "this
              ship can't kill." */}
          {ship.class === 'freighter' ? (
            <ShipTradeLog tradesCompleted={ship.tradesCompleted ?? 0} />
          ) : (
            <ShipCombatRecord
              rank={ship.rank ?? 0}
              history={ship.combatHistory ?? []}
              bodies={gameState.bodies}
            />
          )}

          {ship.class === 'freighter' && ship.ownedBy === 'player' && (
            <TradeRouteSection
              ship={ship}
              tradeRoutes={gameState.tradeRoutes ?? []}
              bodies={gameState.bodies}
              settlements={gameState.settlements}
              onCreate={(originBodyId, destBodyId) => {
                // Optimistic local create + MP server post. In SP the
                // local mutation is the source of truth; in MP it
                // gives the UI an immediate route to render until the
                // next /state poll (~1.5s) reconciles with the
                // server's authoritative row.
                const ok = createTradeRoute(ship.id, originBodyId, destBodyId);
                if (ok && mpActions) {
                  // Surface server rejections (route already exists,
                  // origin not yours, dest not a collector) so the route
                  // chip doesn't flicker on and silently disappear. The
                  // 'transfer' domain message is close enough — both
                  // talk about ship/body presence.
                  setTransferError(null);
                  mpActions.createTradeRoute(ship.id, originBodyId, destBodyId).then(res => {
                    if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                  });
                }
                return ok;
              }}
              onCancel={(routeId) => {
                cancelTradeRoute(routeId);
                if (mpActions) {
                  mpActions.cancelTradeRoute(routeId).then(res => {
                    if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                  });
                }
              }}
            />
          )}

          <div className="maneuver-section" data-tutorial-id="ship-maneuver-section">
            <div className="section-title">MANEUVER NODES</div>
            {ship.orders.length === 0 && !ship.transit && !ship.plannedTransit && queuedTransits.length === 0 ? (
              <div className="no-orders">No planned maneuvers</div>
            ) : (
              <>
                <div className="orders-list">
                  {ship.transit && (() => {
                    const plan = ship.transit.currentTransfer;
                    const targetBody = gameState.bodies.find(b => b.id === plan.targetBodyId);
                    const phase = gameState.currentTick < plan.flipTick ? 'BOOST' : 'BRAKE';
                    return (
                      <div className="order-item status-committed">
                        <div className="order-info">
                          <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId}</div>
                          <div className="order-details">
                            {phase} | Δv: {plan.totalDv.toFixed(2)} | ETA T-{Math.max(0, plan.arriveTick - gameState.currentTick).toFixed(0)}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {ship.plannedTransit && !ship.transit && (() => {
                    const plan = ship.plannedTransit;
                    const targetBody = gameState.bodies.find(b => b.id === plan.targetBodyId);
                    const tripTime = plan.arriveTick - plan.startTick;
                    return (
                      <div className="order-item status-planned">
                        <div className="order-info">
                          <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId} (PLANNED)</div>
                          <div className="order-details">
                            Δv: {plan.totalDv.toFixed(2)} | Trip: {tripTime.toFixed(0)} ticks
                          </div>
                        </div>
                        <div className="order-actions">
                          <button
                            className="commit-btn"
                            onClick={() => commitTransferLocal(ship)}
                            title="Launch this transfer"
                          >COMMIT</button>
                          <button
                            className="delete-btn"
                            onClick={() => cancelTorchPreview(ship.id)}
                            title="Cancel this transfer"
                          >✕</button>
                        </div>
                      </div>
                    );
                  })()}
                  {ship.orders.map((order) => (
                    <div key={order.id} className={`order-item status-${order.status}`}>
                      <div className="order-info">
                        <div className="order-type">{order.label || order.type.toUpperCase()}</div>
                        <div className="order-details">
                          Δv: {Math.abs(order.deltav).toFixed(2)} km/s | T+{order.burnTime.toFixed(0)}
                        </div>
                      </div>
                      <div className="order-actions">
                        <button
                          className="delete-btn"
                          onClick={() => {
                            // Optimistic local remove + MP server-side
                            // status='cancelled' POST. Without the DELETE
                            // the next /state poll re-derived this node
                            // from the server-side game_ship_nodes row,
                            // so the X button looked broken to the user.
                            deleteManeuverNode(order.id);
                            if (mpActions) {
                              mpActions.cancelNode(order.id).then(res => {
                                if (!res.ok) {
                                  // eslint-disable-next-line no-console
                                  console.warn('cancelNode rejected by server:', res.error);
                                }
                              });
                            }
                          }}
                          title="Cancel this maneuver"
                        >✕</button>
                      </div>
                    </div>
                  ))}
                  {queuedTransits.map((qt, i) => {
                    const targetBody = gameState.bodies.find(b => b.id === qt.targetBodyId);
                    return (
                      <div key={`${qt.targetBodyId}-${qt.startTick}-${i}`} className="order-item status-queued">
                        <div className="order-info">
                          <div className="order-type">→ {targetBody?.name ?? qt.targetBodyId}</div>
                          <div className="order-details">
                            QUEUED | Δv: {qt.totalDv.toFixed(2)} | Arr. T+{qt.arriveTick.toFixed(0)}
                          </div>
                        </div>
                        <div className="order-actions">
                          <button className="delete-btn" onClick={() => handleRemoveQueuedTransfer(i)}>✕</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  // Torch model: commit is per-ship, not per-node.
                  // Each ship's plannedTransit preview is promoted to a
                  // live burn via commitTransferLocal. The button label
                  // honors fleet propagation — when the player staged
                  // transfers for an entire fleet from this ship, we
                  // commit ALL of them; otherwise it's just this ship.
                  const fleetPreviewShips = ship.fleetId
                    ? gameState.ships.filter(s =>
                        s.fleetId === ship.fleetId && s.plannedTransit && !s.transit,
                      )
                    : (ship.plannedTransit ? [ship] : []);
                  if (fleetPreviewShips.length === 0) return null;
                  const label = fleetPreviewShips.length > 1
                    ? `▶ COMMIT ALL (${fleetPreviewShips.length})`
                    : '▶ COMMIT';
                  return (
                    <button
                      className="commit-all-btn"
                      data-tutorial-id="ship-commit-button"
                      onClick={() => {
                        for (const s of fleetPreviewShips) {
                          commitTransferLocal(s);
                        }
                      }}
                    >
                      {label}
                    </button>
                  );
                })()}
              </>
            )}
          </div>

          {(currentFleet || eligiblePeers.length > 0) && (
            <div className="fleet-section" data-tutorial-id="ship-fleet-section">
              <div className="section-title">
                FLEET{currentFleet ? `: ${currentFleet.name}` : ''}
              </div>
              {currentFleet ? (
                <>
                  <div className="fleet-members">
                    {fleetMembers.map(m => (
                      <div key={m.id} className="fleet-member">
                        <span className="fleet-member-name">
                          {m.id === currentFleet.leadShipId && '★ '}
                          {m.name}
                        </span>
                        <span className="fleet-member-class">{m.class.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, marginTop: 6, color: '#8aa0b4' }}>
                    <input
                      type="checkbox"
                      checked={propagateTransferToFleet}
                      onChange={e => setPropagateTransferToFleet(e.target.checked)}
                    />
                    TRANSFER MOVES FLEET
                  </label>
                  <div className="fleet-buttons">
                    {eligiblePeers.length > 0 && (
                      <button className="maneuver-btn" onClick={() => setFleetModalOpen(true)}>
                        + ADD SHIPS
                      </button>
                    )}
                    <button
                      className="maneuver-btn"
                      onClick={() => removeFromFleet(currentFleet.id, ship.id)}
                    >
                      LEAVE
                    </button>
                    <button
                      className="maneuver-btn"
                      style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
                      onClick={() => disbandFleet(currentFleet.id)}
                    >
                      DISBAND
                    </button>
                  </div>
                </>
              ) : (
                <button className="maneuver-btn" onClick={() => setFleetModalOpen(true)}>
                  FORM FLEET ({eligiblePeers.length} ship{eligiblePeers.length === 1 ? '' : 's'} available)
                </button>
              )}
            </div>
          )}

          {shipClass.damagePerTick > 0 && (
            <div className="engagement-section">
              <div className="section-title">COMBAT</div>
              <div className="stat-row">
                <span className="label">DAMAGE</span>
                {/* SP fires "{damagePerTick}/volley" every AUTO_COMBAT_INTERVAL
                    ticks (20). MP server fires {damagePerTick}/tick with no
                    cadence gate, so the unit label has to change to match
                    what the player actually sees. Default to MP behavior
                    when mpActions is wired (we're talking to the server). */}
                <span className="value">
                  {shipClass.damagePerTick}/{mpActions ? 'tick' : 'volley'}
                </span>
              </div>
              <div className="stat-row">
                <span className="label">CADENCE</span>
                <span className="value">
                  {mpActions ? 'every server tick' : 'every 20 ticks'}
                </span>
              </div>
              <div className="stat-row" style={{ fontSize: '9px', color: '#b8c8d6', fontStyle: 'italic' }}>
                Auto-fires at any hostile sharing this body.
              </div>
            </div>
          )}

          {transferError && (
            // Server rejected this transfer. Surface inline above the
            // maneuver buttons so the next-action UI is right next to
            // the explanation. Click to dismiss.
            <button
              onClick={() => setTransferError(null)}
              style={{
                margin: '0 0 6px', padding: '6px 10px',
                background: 'rgba(255, 94, 94, 0.1)',
                border: '1px solid #ff5e5e', borderRadius: 4,
                color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
                fontFamily: 'inherit', textAlign: 'left',
                cursor: 'pointer', width: '100%',
              }}
              title="Click to dismiss"
            >⚠ {transferError}</button>
          )}
          <div className="maneuver-buttons">
            <button
              className="maneuver-btn"
              onClick={() => setTargetSelectionMode(true)}
              data-tutorial-id="ship-transfer-button"
            >
              {hasExistingTransfer ? '+ CHAIN' : 'TRANSFER'}
            </button>
            <button className="maneuver-btn" onClick={() => setTransferModalOpen(true)}>
              SHOW LIST
            </button>
          </div>
        </div>
      </div>
      </BottomSheet>

      {transferModalOpen && (
        <TransferTargetPicker
          bodies={gameState.bodies}
          excludeBodyId={ship.orbit.parentBodyId}
          title={hasExistingTransfer ? 'Chain Transfer To' : 'Select Transfer Target'}
          onPick={(id) => handleTransferManeuver(id)}
          onClose={() => setTransferModalOpen(false)}
        />
      )}

      {fleetModalOpen && (
        <FleetFormationModal
          mode={currentFleet ? 'add' : 'form'}
          fleetName={currentFleet?.name}
          peers={eligiblePeers}
          onCancel={() => setFleetModalOpen(false)}
          onConfirm={currentFleet ? handleAddPeersToFleet : handleFormFleet}
        />
      )}
    </>
  );
};

interface FleetFormationModalProps {
  mode: 'form' | 'add';
  fleetName?: string;
  peers: Array<{ id: string; name: string; class: string }>;
  onCancel: () => void;
  onConfirm: (ids: string[]) => void;
}

// ============================================================
// TransferTargetPicker — grouped, searchable destination picker.
//
// Previously rendered ALL ~25 bodies as a single tall column of
// full-width buttons; on mobile (and even desktop) that meant
// a wall of scrolling to reach Pluto's moon. Now:
//
//   - a search box at the top filters by body name (live)
//   - bodies are grouped by parent ("Inner system", "Asteroid belt",
//     "Outer system", "Jupiter system", "Saturn system", etc.)
//     and rendered in a 2-column responsive grid
//   - each cell is compact enough that most groups fit in one viewport
//     screenful without scrolling
// ============================================================
interface TransferTargetPickerProps {
  bodies: import('../types').Body[];
  /** Id of the body to exclude (the ship's current parent). */
  excludeBodyId: string;
  title: string;
  onPick: (bodyId: string) => void;
  onClose: () => void;
}

/** Group label + ordering for the picker. `farSystem: true` flags the
 *  group as collapsible in the UI — Centauri and Cygnus X live behind
 *  a "show" toggle by default so the Sol-system picker isn't dominated
 *  by 15+ exotic destinations the player won't pick most matches. */
function groupOf(
  body: import('../types').Body,
  bodies: import('../types').Body[],
): { key: string; label: string; order: number; farSystem?: boolean } {
  // Far systems get folded into one group each regardless of their
  // own internal parent-child structure (Prismara orbits Crimson but
  // belongs in the Centauri bucket, not its own "Crimson system"
  // sub-group). High order so they sort to the bottom of the list.
  if (BINARY_SYSTEM_BODY_IDS.has(body.id)) {
    return { key: 'centauri', label: 'Centauri system', order: 20, farSystem: true };
  }
  if (BLACK_HOLE_SYSTEM_BODY_IDS.has(body.id)) {
    return { key: 'cygnus', label: 'Cygnus X system', order: 21, farSystem: true };
  }
  if (!body.parent || body.parent === 'sol') {
    // Categorize sun-orbiters by type for legibility.
    if (body.type === 'terrestrial') return { key: 'inner', label: 'Inner system', order: 1 };
    if (body.type === 'dwarf' && body.orbitRadius < 500) return { key: 'belt', label: 'Asteroid belt', order: 2 };
    if (body.type === 'gas_giant') return { key: 'gas', label: 'Gas giants', order: 3 };
    if (body.type === 'ice_giant') return { key: 'ice', label: 'Ice giants', order: 4 };
    if (body.type === 'dwarf') return { key: 'kuiper', label: 'Kuiper belt', order: 5 };
    return { key: 'other', label: 'Other', order: 99 };
  }
  // Moons: group by parent body's name.
  const parent = bodies.find(b => b.id === body.parent);
  const pName = parent?.name ?? body.parent;
  return { key: `moons-${body.parent}`, label: `${pName} system`, order: 10 };
}

const TransferTargetPicker: React.FC<TransferTargetPickerProps> = ({
  bodies, excludeBodyId, title, onPick, onClose,
}) => {
  const [query, setQuery] = useState('');
  // Per-group expansion state. Far-system groups (Centauri / Cygnus X)
  // are collapsed by default; the player toggles them open. Sol-system
  // groups have no toggle and are always shown. An active search
  // query auto-expands any far group that has matches inside it (see
  // the render logic below), without persisting that expansion — clear
  // the query and the group collapses again.
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bodies.filter(b => {
      // Sol is a legal target — Dyson sphere ferry already routes
      // freighters there, and players occasionally want to park a
      // ship in close-solar orbit. Only the origin body is excluded
      // from the picker (can't transfer to where you already are).
      if (b.id === excludeBodyId) return false;
      // Lagrange-type markers (the Centauri + Cygnus barycenters) are
      // invisible centre-of-mass points with no SOI or mu — there's
      // nothing to park around. Hide them so the player can't try.
      if (b.type === 'lagrange') return false;
      if (!q) return true;
      const parentName = b.parent ? bodies.find(x => x.id === b.parent)?.name.toLowerCase() ?? '' : '';
      return b.name.toLowerCase().includes(q) || parentName.includes(q);
    });
  }, [bodies, excludeBodyId, query]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; order: number; farSystem?: boolean; bodies: import('../types').Body[] }>();
    for (const b of visible) {
      const g = groupOf(b, bodies);
      if (!map.has(g.key)) map.set(g.key, { label: g.label, order: g.order, farSystem: g.farSystem, bodies: [] });
      map.get(g.key)!.bodies.push(b);
    }
    // Sort body lists by name; groups by .order then label.
    for (const v of map.values()) v.bodies.sort((a, b) => a.name.localeCompare(b.name));
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [visible, bodies]);

  // Active-query auto-expand: when the player is searching, any
  // far-system group that has matches gets opened so the matches are
  // actually visible. Without this, the matches would just be hidden
  // behind a still-collapsed toggle and the search would silently
  // appear to find nothing.
  const hasActiveQuery = query.trim().length > 0;
  const toggleGroup = (key: string) => {
    setManualExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content target-picker"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480, width: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
          <input
            type="text"
            placeholder="Search bodies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            style={{
              width: '100%',
              padding: '8px 10px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid #2a3d50',
              borderRadius: 3,
              color: '#d8e4ee',
              fontFamily: 'inherit',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.length === 0 && (
              <div style={{ color: '#b8c8d6', fontSize: 11, textAlign: 'center', padding: '24px 0' }}>
                No bodies match "{query}".
              </div>
            )}
            {groups.map(g => {
              // Far-system groups (Centauri / Cygnus) collapse by
              // default. Open when the player clicks the toggle OR
              // when an active search query has matches inside
              // (otherwise the search appears to find nothing).
              const isCollapsible = g.farSystem;
              const isOpen = !isCollapsible || hasActiveQuery || manualExpanded.has(g.key);
              const headerColor = g.farSystem ? '#ffb84d' : '#b8c8d6';
              return (
                <div key={g.key}>
                  {isCollapsible ? (
                    // Clickable header for the collapsible far groups.
                    // Caret rotates open/closed so the affordance reads
                    // even without hover state.
                    <button
                      onClick={() => toggleGroup(g.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        width: '100%', padding: '4px 0',
                        background: 'transparent', border: 'none',
                        cursor: 'pointer',
                        fontSize: 9, letterSpacing: '0.14em', color: headerColor,
                        textTransform: 'uppercase',
                        fontFamily: 'inherit', textAlign: 'left',
                        marginBottom: isOpen ? 6 : 0,
                      }}
                      title={isOpen ? 'Hide far-system bodies' : 'Show far-system bodies'}
                    >
                      <span style={{
                        display: 'inline-block',
                        transition: 'transform 0.15s',
                        transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}>▶</span>
                      {g.label} · {g.bodies.length}
                    </button>
                  ) : (
                    <div style={{
                      fontSize: 9, letterSpacing: '0.14em', color: headerColor,
                      textTransform: 'uppercase', marginBottom: 6,
                    }}>
                      {g.label} · {g.bodies.length}
                    </div>
                  )}
                  {isOpen && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                        gap: 4,
                      }}
                    >
                      {g.bodies.map(body => (
                        <button
                          key={body.id}
                          className="target-button target-button--compact"
                          onClick={() => onPick(body.id)}
                          style={{ padding: '7px 8px', fontSize: 10, textAlign: 'center' }}
                        >
                          {body.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

const FleetFormationModal: React.FC<FleetFormationModalProps> = ({ mode, fleetName, peers, onCancel, onConfirm }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'form' ? 'Form Fleet' : `Add to ${fleetName ?? 'Fleet'}`}</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          {peers.length === 0 ? (
            <div className="no-orders">No eligible ships at this location.</div>
          ) : (
            <div className="target-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {peers.map((p) => (
                <label key={p.id} className="target-button" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span style={{ color: '#b8c8d6', fontSize: 9 }}>{p.class.toUpperCase()}</span>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="maneuver-btn"
              disabled={selected.size === 0}
              onClick={() => onConfirm(Array.from(selected))}
              style={{ flex: 1 }}
            >
              {mode === 'form' ? 'FORM FLEET' : 'ADD'}
            </button>
            <button className="maneuver-btn" onClick={onCancel}>
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------
// TradeRouteSection — freighter-only. Shows the active route (with
// cargo + cancel) or a "+ TRADE ROUTE" button that opens a picker
// for origin (any player settlement) + destination (any player
// collector). Once created, the per-tick reducer auto-pilots the
// freighter: fill at origin → transfer → dump at dest → return →
// repeat until cancelled.
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// ShipTradeLog — freighter-only delivery counter.
//
// Replaces ShipCombatRecord on freighters since they can't actually
// kill anything (damagePerTick === 0 in the class def). Shows a
// running count of completed deliveries on active trade routes —
// incremented server-side in worker/room.js when a freighter dumps
// cargo at a dest body, and SP-side in gameContext.tsx's matching
// DELIVERY branch.
// ----------------------------------------------------------------
const ShipTradeLog: React.FC<{ tradesCompleted: number }> = ({ tradesCompleted }) => {
  return (
    <div className="combat-record-section" style={{ marginTop: 10 }}>
      <div
        className="section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
      >
        <span>TRADE LOG</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {tradesCompleted > 0
            ? `${tradesCompleted} route${tradesCompleted === 1 ? '' : 's'} completed`
            : 'No deliveries yet.'}
        </span>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------
// ShipCombatRecord — per-ship rank + kill log, collapsible.
//
// Rank summary is always visible (shows the +%/+% bonuses). The
// kill list collapses by default and expands on click — the ledger
// can run up to KILL_HISTORY_CAP=20 entries and we don't want to
// dominate the panel for veteran ships. Targets are rendered with
// their class + which body they died at, plus the tick stamp so
// the player can correlate with their event log.
// ----------------------------------------------------------------
const ShipCombatRecord: React.FC<{
  rank: number;
  history: import('../types').ShipKillRecord[];
  bodies: Body[];
}> = ({ rank, history, bodies }) => {
  const [expanded, setExpanded] = useState(false);
  const kills = history.length;
  const dmgBonus = rank;     // each rank = +1%
  const hpBonus  = rank;     // each rank = +1%
  return (
    <div className="combat-record-section" data-tutorial-id="ship-combat-record" style={{ marginTop: 10 }}>
      <div
        className="section-title"
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          cursor: kills > 0 ? 'pointer' : 'default',
        }}
        onClick={() => kills > 0 && setExpanded(v => !v)}
        title={kills > 0 ? 'Toggle combat record' : undefined}
      >
        <span>COMBAT RECORD</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {kills > 0 ? `${kills} kill${kills === 1 ? '' : 's'} · ${expanded ? '▲' : '▼'}` : 'No confirmed kills.'}
        </span>
      </div>
      {rank > 0 && (
        <div className="stat-row" style={{ marginTop: 4 }}>
          <span className="label">VETERANCY</span>
          <span className="value" style={{ color: '#ffb84d' }}>
            +{dmgBonus}% DMG · +{hpBonus}% HP
          </span>
        </div>
      )}
      {expanded && kills > 0 && (
        <ul
          style={{
            listStyle: 'none', padding: 0, margin: '6px 0 0',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}
        >
          {history.slice().reverse().map((k, i) => {
            const body = bodies.find(b => b.id === k.atBodyId);
            return (
              <li
                key={`${k.tick}-${i}`}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  padding: '3px 6px',
                  background: 'rgba(255, 184, 77, 0.04)',
                  border: '1px solid #2a3d50',
                  borderRadius: 3,
                  fontSize: 10,
                }}
              >
                <span style={{ color: '#ff5e5e' }}>
                  ✕ {k.targetName}
                  <span style={{ color: '#b8c8d6', marginLeft: 4 }}>
                    ({k.targetClass})
                  </span>
                </span>
                <span style={{ color: '#b8c8d6', fontSize: 9 }}>
                  T+{k.tick} · {body?.name ?? k.atBodyId}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const TradeRouteSection: React.FC<{
  ship: Ship;
  tradeRoutes: TradeRoute[];
  bodies: Body[];
  settlements: Settlement[];
  onCreate: (originBodyId: string, destBodyId: string) => boolean;
  onCancel: (routeId: string) => void;
}> = ({ ship, tradeRoutes, bodies, settlements, onCreate, onCancel }) => {
  const route = tradeRoutes.find(r => r.shipId === ship.id);
  const [picking, setPicking] = useState(false);
  const [originId, setOriginId] = useState<string>('');
  const [destId, setDestId] = useState<string>('');

  // Eligible origins = any body where the player owns a settlement
  // (collector not required — you can pick up from any settlement,
  // it just needs to have stockpile).
  const originBodies = useMemo(() => {
    const ids = new Set(settlements.filter(s => s.ownedBy === 'player').map(s => s.bodyId));
    return bodies.filter(b => ids.has(b.id));
  }, [bodies, settlements]);

  // Eligible destinations = any body where the player has a collector.
  // Without one the route's deliveries would have nowhere to land.
  const destBodies = useMemo(() => {
    const ids = new Set(
      settlements.filter(s => s.ownedBy === 'player' && s.hasCollector).map(s => s.bodyId),
    );
    return bodies.filter(b => ids.has(b.id));
  }, [bodies, settlements]);

  if (route) {
    const origin = bodies.find(b => b.id === route.originBodyId);
    const dest = bodies.find(b => b.id === route.destBodyId);
    const cargoTotal =
      route.cargo.fuel + route.cargo.ore + route.cargo.credits + route.cargo.science;
    const cargoStr = [
      route.cargo.fuel    > 0 ? `${Math.round(route.cargo.fuel)}F`    : null,
      route.cargo.ore     > 0 ? `${Math.round(route.cargo.ore)}O`     : null,
      route.cargo.credits > 0 ? `${Math.round(route.cargo.credits)}C` : null,
      route.cargo.science > 0 ? `${Math.round(route.cargo.science)}S` : null,
    ].filter(Boolean).join(' ');
    return (
      <div className="maneuver-section">
        <div className="section-title">TRADE ROUTE</div>
        <div className="order-item status-committed" style={{ flexDirection: 'column', gap: 4 }}>
          <div className="order-info" style={{ width: '100%' }}>
            <div className="order-type">{origin?.name ?? '?'} ↔ {dest?.name ?? '?'}</div>
            <div className="order-details">
              {route.status === 'outbound' ? '→ delivering' : route.status === 'returning' ? '← picking up' : 'paused'}
              {cargoTotal > 0 ? ` · cargo ${cargoStr}` : ' · empty hold'}
            </div>
          </div>
          <button
            className="maneuver-btn"
            // Brightened red + opaque tinted fill so the destructive button
            // reads against the golden status-committed row background.
            // Previous (#ff5e5e on amber tint) was ~3:1 contrast — below
            // WCAG AA — and the red-on-amber created visual noise.
            style={{
              borderColor: '#ff7a7a',
              color: '#ffb0b0',
              background: 'rgba(255, 94, 94, 0.12)',
              alignSelf: 'flex-start',
              fontWeight: 600,
            }}
            onClick={() => onCancel(route.id)}
            title="Cancel the route. Any cargo in the hold is dumped to your pool."
          >
            ✕ CANCEL ROUTE
          </button>
        </div>
      </div>
    );
  }

  if (picking) {
    const canCreate = !!originId && !!destId && originId !== destId;
    return (
      <div className="maneuver-section">
        <div className="section-title">NEW TRADE ROUTE</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0' }}>
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            ORIGIN (settlement)
          </label>
          <select
            value={originId}
            onChange={(e) => setOriginId(e.target.value)}
            style={{
              padding: '4px 6px', background: '#0a1018', border: '1px solid #2a3d50',
              color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, borderRadius: 3,
            }}
          >
            <option value="">— pick origin —</option>
            {originBodies.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            DEST (collector)
          </label>
          {destBodies.length === 0 ? (
            <div style={{ fontSize: 10, color: '#ff5e5e' }}>
              You have no collectors. Build one at a settlement first.
            </div>
          ) : (
            <select
              value={destId}
              onChange={(e) => setDestId(e.target.value)}
              style={{
                padding: '4px 6px', background: '#0a1018', border: '1px solid #2a3d50',
                color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, borderRadius: 3,
              }}
            >
              <option value="">— pick collector —</option>
              {destBodies.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              className="maneuver-btn"
              onClick={() => {
                if (!canCreate) return;
                if (onCreate(originId, destId)) {
                  setPicking(false); setOriginId(''); setDestId('');
                }
              }}
              disabled={!canCreate}
              style={!canCreate ? { opacity: 0.5, cursor: 'default' } : undefined}
            >
              ▶ OPEN ROUTE
            </button>
            <button
              className="maneuver-btn"
              onClick={() => { setPicking(false); setOriginId(''); setDestId(''); }}
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="maneuver-section">
      <div className="section-title">TRADE ROUTE</div>
      <button
        className="maneuver-btn"
        onClick={() => setPicking(true)}
        style={{ marginTop: 4 }}
        title="Open a recurring trade route — auto-pilots this freighter to ferry cargo from a settlement to a collector and loop."
        disabled={destBodies.length === 0}
      >
        + TRADE ROUTE
      </button>
      {destBodies.length === 0 && (
        <div style={{ fontSize: 9, color: '#b8c8d6', marginTop: 4 }}>
          Build a collector first.
        </div>
      )}
    </div>
  );
};
