import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useGameContext } from '../state/gameContext';
import { ManeuverNode } from '../types';
import { planBezierTransfer } from '../physics/bezierTransfer';
import { createCircularOrbit } from '../physics/orbitalMechanics';
import './ShipPanel.css';

export const ShipPanel: React.FC = () => {
  const {
    gameState, uiState, deselectShip, setGameState,
    commitManeuverNode, deleteManeuverNode, addManeuverNode,
    setPendingTransfer, addQueuedTransfer, setTargetSelectionMode,
  } = useGameContext();

  const [transferModalOpen, setTransferModalOpen] = useState(false);

  const ship = uiState.selectedShipId
    ? gameState.ships.find(s => s.id === uiState.selectedShipId) || null
    : null;

  // Keep a ref to the latest transfer handler so the event listener always sees current state
  const transferHandlerRef = useRef<(bodyId: string, strategy: 'quickest' | 'efficient') => void>(() => {});

  useEffect(() => {
    if (!ship) return;

    transferHandlerRef.current = (targetBodyId: string, strategy: 'quickest' | 'efficient') => {
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
        const arc = planBezierTransfer(tempOrbit, targetBodyId, chainTail.time, gameState.bodies, strategy);
        if (!arc) return;
        addQueuedTransfer(ship.id, arc);
      } else {
        const arc = planBezierTransfer(ship.orbit, targetBodyId, gameState.currentTick, gameState.bodies, strategy);
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
      }
      setTransferModalOpen(false);
      setTargetSelectionMode(false);
    };
  }, [ship, gameState, addManeuverNode, setPendingTransfer, addQueuedTransfer, setTargetSelectionMode]);

  const handleTransferConfirmEvent = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.bodyId && detail?.strategy) {
      transferHandlerRef.current(detail.bodyId, detail.strategy);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('orbital-transfer-confirm', handleTransferConfirmEvent);
    return () => window.removeEventListener('orbital-transfer-confirm', handleTransferConfirmEvent);
  }, [handleTransferConfirmEvent]);

  if (!ship) return null;

  const handleTransferManeuver = (targetBodyId: string, strategy: 'quickest' | 'efficient' = 'quickest') => {
    transferHandlerRef.current(targetBodyId, strategy);
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

  return (
    <>
      <div className="ship-panel">
        <div className="panel-header">
          <span>SHIP: {ship.name}</span>
          <button className="panel-close" onClick={deselectShip}>✕</button>
        </div>

        <div className="panel-body">
          <div className="ship-stats">
            <div className="stat-row">
              <span className="label">CLASS</span>
              <span className="value">{ship.class.toUpperCase()}</span>
            </div>
            <div className="stat-row">
              <span className="label">FUEL</span>
              <span className="value">{ship.fuel} kt</span>
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
                    COMMIT ALL
                  </button>
                )}
              </>
            )}
          </div>

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
                    <div key={body.id} className="target-row">
                      <span className="target-name">
                        {body.name}{body.parent !== 'sol' ? ` (${body.parent})` : ''}
                      </span>
                      <div className="target-actions">
                        <button
                          className="target-btn target-btn-quick"
                          onClick={() => handleTransferManeuver(body.id, 'quickest')}
                        >
                          QUICK
                        </button>
                        <button
                          className="target-btn target-btn-efficient"
                          onClick={() => handleTransferManeuver(body.id, 'efficient')}
                        >
                          EFFICIENT
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
