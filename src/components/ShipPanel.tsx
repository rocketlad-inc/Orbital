import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useGameContext } from '../state/gameContext';
import { ManeuverNode } from '../types';
import { planBezierTransfer } from '../physics/bezierTransfer';
import { createCircularOrbit } from '../physics/orbitalMechanics';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { maintenanceRatesForShip } from '../game/maintenance';
import { travelTimeModifier, FactionTechState } from '../game/techs';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { ShipIcon } from './ShipIcons';
import { BottomSheet } from './BottomSheet';
import './ShipPanel.css';

export const ShipPanel: React.FC = () => {
  const {
    gameState, uiState, deselectShip, setGameState,
    commitManeuverNode, deleteManeuverNode, addManeuverNode,
    setPendingTransfer, addQueuedTransfer, setTargetSelectionMode,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
  } = useGameContext();

  // In multiplayer this is non-null and we post intent to the server in
  // addition to mutating local state (so the UI feels responsive while
  // waiting for the next /state poll to reconcile).
  const mpActions = useMultiplayerActions();

  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [fleetModalOpen, setFleetModalOpen] = useState(false);
  const [propagateTransferToFleet, setPropagateTransferToFleet] = useState(true);

  const ship = uiState.selectedShipId
    ? gameState.ships.find(s => s.id === uiState.selectedShipId) || null
    : null;

  const transferHandlerRef = useRef<(bodyId: string) => void>(() => {});

  useEffect(() => {
    if (!ship) return;

    transferHandlerRef.current = (targetBodyId: string) => {
      // Apply player's Flight Dynamics tech to shrink Hohmann transit time.
      const playerTech = gameState.factionTech?.[ship.ownedBy] as FactionTechState | undefined;
      const travelTimeMul = travelTimeModifier(playerTech);

      const queue = ship.queuedTransfers || [];
      let chainTail: { bodyId: string; time: number } | null = null;
      if (queue.length > 0) {
        const last = queue[queue.length - 1];
        chainTail = { bodyId: last.arrivalBodyId, time: last.arrivalTime };
      } else if (ship.transfer) {
        chainTail = { bodyId: ship.transfer.arrivalBodyId, time: ship.transfer.arrivalTime };
      } else if (ship.pendingTransfer) {
        chainTail = { bodyId: ship.pendingTransfer.arrivalBodyId, time: ship.pendingTransfer.arrivalTime };
      }

      if (chainTail) {
        const tailBody = gameState.bodies.find(b => b.id === chainTail!.bodyId);
        const arrRadius = tailBody ? tailBody.radius + 4 : 10;
        const tempOrbit = createCircularOrbit(chainTail.bodyId, arrRadius, chainTail.time, gameState.bodies);
        const arc = planBezierTransfer(tempOrbit, targetBodyId, chainTail.time, gameState.bodies, travelTimeMul);
        if (!arc) return;
        addQueuedTransfer(ship.id, arc);
      } else {
        const arc = planBezierTransfer(ship.orbit, targetBodyId, gameState.currentTick, gameState.bodies, travelTimeMul);
        if (!arc) return;

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

        // Multiplayer: post the maneuver to the server so the Room DO tick
        // resolver can execute it on schedule. The local state above keeps
        // the UI responsive until the next /state poll reconciles.
        if (mpActions) {
          mpActions.transfer({
            shipId: ship.id,
            targetBodyId: arc.arrivalBodyId,
            scheduledT: arc.departureTime,
            dvPrograde: arc.departureDv,
            fuelCost: Math.round(Math.abs(arc.departureDv) * 10),
          });
        }

        // Fleet propagation: if this ship is in a fleet and the player opted in,
        // plan the same target transfer for every fleet member (each from its own orbit).
        if (propagateTransferToFleet && ship.fleetId) {
          const fleet = gameState.fleets.find(f => f.id === ship.fleetId);
          if (fleet) {
            for (const memberId of fleet.shipIds) {
              if (memberId === ship.id) continue;
              const member = gameState.ships.find(s => s.id === memberId);
              if (!member || member.transfer || member.pendingTransfer) continue;
              const memberArc = planBezierTransfer(member.orbit, targetBodyId, gameState.currentTick, gameState.bodies, travelTimeMul);
              if (!memberArc) continue;
              const memberNode: ManeuverNode = {
                id: `node-${Date.now()}-${Math.random()}`,
                shipId: member.id,
                type: 'transfer',
                burnTime: memberArc.departureTime,
                deltav: memberArc.departureDv,
                prograde: memberArc.departureDv,
                radial: 0,
                normal: 0,
                status: 'planned',
                label: memberArc.label,
              };
              addManeuverNode(memberNode);
              setPendingTransfer(member.id, memberArc);
              if (mpActions) {
                mpActions.transfer({
                  shipId: member.id,
                  targetBodyId: memberArc.arrivalBodyId,
                  scheduledT: memberArc.departureTime,
                  dvPrograde: memberArc.departureDv,
                  fuelCost: Math.round(Math.abs(memberArc.departureDv) * 10),
                });
              }
            }
          }
        }
      }
      setTransferModalOpen(false);
      setTargetSelectionMode(false);
    };
  }, [ship, gameState, addManeuverNode, setPendingTransfer, addQueuedTransfer, setTargetSelectionMode, propagateTransferToFleet, mpActions]);

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

  const handleRemoveQueuedTransfer = (index: number) => {
    const queue = ship.queuedTransfers || [];
    if (index >= queue.length) return;
    const newQueue = queue.slice(0, index);
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s =>
        s.id === ship.id
          ? { ...s, queuedTransfers: newQueue.length > 0 ? newQueue : undefined }
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

  const hasExistingTransfer = !!(ship.transfer || ship.pendingTransfer);

  const locationLabel = ship.transfer
    ? `→ ${gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId)?.name || '?'}`
    : ship.orbit.parentBodyId.toUpperCase();

  const eta = ship.transfer
    ? ship.transfer.arrivalTime - gameState.currentTick
    : ship.pendingTransfer
      ? ship.pendingTransfer.departureTime - gameState.currentTick
      : null;

  const queuedTransfers = ship.queuedTransfers || [];

  // Ship class stats
  const shipClass = getShipClass(ship.class as ShipClassName);

  // Maintenance — repair/refuel rates at current location
  const maintenance = maintenanceRatesForShip(ship, gameState.bodies, gameState.settlements);
  const maxHp = shipClass.hp;
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
  const eligiblePeers = !ship.transfer
    ? gameState.ships.filter(s =>
        s.id !== ship.id &&
        s.ownedBy === ship.ownedBy &&
        s.orbit.parentBodyId === ship.orbit.parentBodyId &&
        !s.transfer &&
        s.fleetId !== ship.fleetId
      )
    : [];

  return (
    <>
      <BottomSheet open={true} onClose={deselectShip} title={`Ship: ${ship.name}`}>
      <div className="ship-panel">
        <div className="panel-header">
          <span>SHIP: {ship.name}</span>
          <button className="panel-close" onClick={deselectShip}>✕</button>
        </div>

        <div className="panel-body">
          <div className="ship-stats">
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
            {ship.transfer && eta != null && eta > 0 && (
              <div className="stat-row">
                <span className="label">ETA</span>
                <span className="value">T-{eta.toFixed(0)} ticks</span>
              </div>
            )}
            {ship.pendingTransfer && !ship.transfer && (
              <div className="stat-row">
                <span className="label">STATUS</span>
                <span className="value">TRANSFER PLANNED</span>
              </div>
            )}
          </div>

          <div className="maneuver-section">
            <div className="section-title">MANEUVER NODES</div>
            {ship.orders.length === 0 && !ship.transfer && queuedTransfers.length === 0 ? (
              <div className="no-orders">No planned maneuvers</div>
            ) : (
              <>
                <div className="orders-list">
                  {ship.transfer && (
                    <div className="order-item status-committed">
                      <div className="order-info">
                        <div className="order-type">{ship.transfer.label}</div>
                        <div className="order-details">
                          IN TRANSIT | Arr. Δv: {ship.transfer.arrivalDv.toFixed(2)} km/s
                        </div>
                      </div>
                    </div>
                  )}
                  {ship.orders.map((order) => (
                    <div key={order.id} className={`order-item status-${order.status}`}>
                      <div className="order-info">
                        <div className="order-type">{order.label || order.type.toUpperCase()}</div>
                        <div className="order-details">
                          Δv: {Math.abs(order.deltav).toFixed(2)} km/s | T+{order.burnTime.toFixed(0)}
                        </div>
                      </div>
                      <div className="order-actions">
                        <button className="delete-btn" onClick={() => deleteManeuverNode(order.id)}>✕</button>
                      </div>
                    </div>
                  ))}
                  {queuedTransfers.map((qt, i) => (
                    <div key={qt.id} className="order-item status-queued">
                      <div className="order-info">
                        <div className="order-type">{qt.label}</div>
                        <div className="order-details">
                          QUEUED | Δv: {(qt.departureDv + qt.arrivalDv).toFixed(2)} km/s | T+{qt.departureTime.toFixed(0)}
                        </div>
                      </div>
                      <div className="order-actions">
                        <button className="delete-btn" onClick={() => handleRemoveQueuedTransfer(i)}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
                {ship.orders.some(o => o.status === 'planned') && (
                  <button
                    className="commit-all-btn"
                    onClick={() => ship.orders.forEach(o => {
                      if (o.status === 'planned') commitManeuverNode(o.id);
                    })}
                  >
                    ▶ COMMIT ALL
                  </button>
                )}
              </>
            )}
          </div>

          {(currentFleet || eligiblePeers.length > 0) && (
            <div className="fleet-section">
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
                <span className="value">{shipClass.damagePerTick}/volley</span>
              </div>
              <div className="stat-row">
                <span className="label">CADENCE</span>
                <span className="value">every 20 ticks</span>
              </div>
              <div className="stat-row" style={{ fontSize: '9px', color: '#6b8195', fontStyle: 'italic' }}>
                Auto-fires at any hostile sharing this body.
              </div>
            </div>
          )}

          <div className="maneuver-buttons">
            <button className="maneuver-btn" onClick={() => setTargetSelectionMode(true)}>
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
        <div className="modal-overlay" onClick={() => setTransferModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{hasExistingTransfer ? 'Chain Transfer To' : 'Select Transfer Target'}</h3>
              <button className="modal-close" onClick={() => setTransferModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="target-list">
                {gameState.bodies
                  .filter((b) => b.id !== 'sol' && b.id !== ship.orbit.parentBodyId)
                  .map((body) => (
                    <button
                      key={body.id}
                      className="target-button"
                      onClick={() => handleTransferManeuver(body.id)}
                    >
                      {body.name}{body.parent !== 'sol' ? ` (${body.parent})` : ''}
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
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
                  <span style={{ color: '#6b8195', fontSize: 9 }}>{p.class.toUpperCase()}</span>
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
