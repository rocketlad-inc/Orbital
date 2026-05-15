import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { ManeuverNode } from '../types';
import { planBezierTransfer } from '../physics/bezierTransfer';
import './ShipPanel.css';

export const ShipPanel: React.FC = () => {
  const {
    gameState, uiState, deselectShip,
    commitManeuverNode, deleteManeuverNode, addManeuverNode, setPendingTransfer,
  } = useGameContext();

  const [transferModalOpen, setTransferModalOpen] = useState(false);

  if (!uiState.selectedShipId) return null;
  const ship = gameState.ships.find(s => s.id === uiState.selectedShipId);
  if (!ship) return null;

  const handleTransferManeuver = (targetBodyId: string, strategy: 'quickest' | 'efficient' = 'quickest') => {
    const arc = planBezierTransfer(ship.orbit, targetBodyId, gameState.currentTick, gameState.bodies, strategy);
    if (!arc) {
      alert('Cannot plan transfer to that target');
      return;
    }

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
    setTransferModalOpen(false);
  };

  const locationLabel = ship.transfer
    ? `→ ${gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId)?.name || '?'}`
    : ship.orbit.parentBodyId.toUpperCase();

  const eta = ship.transfer
    ? ship.transfer.arrivalTime - gameState.currentTick
    : ship.pendingTransfer
      ? ship.pendingTransfer.departureTime - gameState.currentTick
      : null;

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
            {ship.orders.length === 0 && !ship.transfer ? (
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

          {!ship.transfer && (
            <div className="maneuver-buttons">
              <button className="maneuver-btn" onClick={() => setTransferModalOpen(true)}>
                ⇒ TRANSFER
              </button>
            </div>
          )}
        </div>
      </div>

      {transferModalOpen && (
        <div className="modal-overlay" onClick={() => setTransferModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select Transfer Target</h3>
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
