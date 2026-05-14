// ============================================================
// ShipPanel - Ship information and maneuver controls
// ============================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { ManeuverNode } from '../types';
import { planTransfer } from '../physics/orbitalMechanics';
import './ShipPanel.css';

export const ShipPanel: React.FC = () => {
  const { gameState, uiState, deselectShip, commitManeuverNode, deleteManeuverNode, addManeuverNode } =
    useGameContext();

  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [orbitalModalOpen, setOrbitalModalOpen] = useState(false);
  const [peInput, setPeInput] = useState('');
  const [apInput, setApInput] = useState('');

  if (!uiState.selectedShipId) {
    return null;
  }

  const ship = gameState.ships.find(s => s.id === uiState.selectedShipId);
  if (!ship) {
    return null;
  }

  const handleTransferManeuver = (targetBodyId: string) => {
    const plan = planTransfer(ship.orbit, targetBodyId, gameState.bodies, gameState.currentTick);
    if (!plan) {
      alert('Cannot plan transfer to that target');
      return;
    }

    if (!plan.hasValidPlan) {
      console.warn('[TRANSFER] Using analytic fallback — encounter not guaranteed');
    }

    // Create maneuver nodes from the plan
    // Departure burn: normal node (fires at burnTime)
    // Capture burn: has capturedAtBody (handled by game loop on SOI entry)
    plan.burns.forEach((burn) => {
      const node: ManeuverNode = {
        id: `node-${Date.now()}-${Math.random()}`,
        shipId: ship.id,
        type: 'transfer',
        burnTime: burn.timing,
        deltav: burn.dv,
        prograde: burn.dv,
        radial: 0,
        normal: 0,
        status: 'planned',
        // Only set capturedAtBody on the capture burn (not the departure burn)
        capturedAtBody: burn.capturedAtBody,
      };
      addManeuverNode(node);
    });

    setTransferModalOpen(false);
  };

  const handleOrbitalManeuver = () => {
    const pe = parseFloat(peInput);
    const ap = parseFloat(apInput);

    if (isNaN(pe) || isNaN(ap) || pe < 1 || ap < pe) {
      alert('Invalid Pe/Ap values');
      return;
    }

    // Create two burns for circularization
    // First burn: raise/lower apoapsis
    const burn1: ManeuverNode = {
      id: `node-${Date.now()}-${Math.random()}`,
      shipId: ship.id,
      type: 'orbital_change',
      burnTime: gameState.currentTick + 50,
      deltav: 5.0, // Placeholder
      prograde: 5.0,
      radial: 0,
      normal: 0,
      status: 'planned',
    };

    // Second burn: circularize at target
    const burn2: ManeuverNode = {
      id: `node-${Date.now()}-${Math.random()}`,
      shipId: ship.id,
      type: 'orbital_change',
      burnTime: gameState.currentTick + 100,
      deltav: 3.0, // Placeholder
      prograde: 3.0,
      radial: 0,
      normal: 0,
      status: 'planned',
    };

    addManeuverNode(burn1);
    addManeuverNode(burn2);

    setOrbitalModalOpen(false);
    setPeInput('');
    setApInput('');
  };

  return (
    <>
      <div className="ship-panel">
        <div className="panel-header">
          <span>SHIP: {ship.name}</span>
          <button className="panel-close" onClick={deselectShip}>
            ✕
          </button>
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
              <span className="value">{ship.orbit.parentBodyId.toUpperCase()}</span>
            </div>
          </div>

          <div className="maneuver-section">
            <div className="section-title">MANEUVER NODES</div>
            {ship.orders.length === 0 ? (
              <div className="no-orders">No planned maneuvers</div>
            ) : (
              <div className="orders-list">
                {ship.orders.map((order) => (
                  <div key={order.id} className={`order-item status-${order.status}`}>
                    <div className="order-info">
                      <div className="order-type">{order.type.toUpperCase()}</div>
                      <div className="order-details">
                        Δv: {order.deltav.toFixed(2)} | T+{order.burnTime.toFixed(0)}
                      </div>
                    </div>
                    <div className="order-actions">
                      {order.status === 'planned' && (
                        <button
                          className="commit-btn"
                          onClick={() => commitManeuverNode(order.id)}
                        >
                          COMMIT
                        </button>
                      )}
                      <button
                        className="delete-btn"
                        onClick={() => deleteManeuverNode(order.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="maneuver-buttons">
            <button className="maneuver-btn" onClick={() => setTransferModalOpen(true)}>
              ⇒ TRANSFER MANEUVER
            </button>
            <button className="maneuver-btn" onClick={() => setOrbitalModalOpen(true)}>
              ↻ ORBITAL MANEUVER
            </button>
          </div>

          <details className="advanced-section">
            <summary>Advanced Manual Steps</summary>
            <div className="advanced-content">
              <p>Manual step entry not yet implemented.</p>
            </div>
          </details>
        </div>
      </div>

      {/* Transfer Target Modal */}
      {transferModalOpen && (
        <div className="modal-overlay" onClick={() => setTransferModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select Transfer Target</h3>
              <button className="modal-close" onClick={() => setTransferModalOpen(false)}>
                ✕
              </button>
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

      {/* Orbital Maneuver Modal */}
      {orbitalModalOpen && (
        <div className="modal-overlay" onClick={() => setOrbitalModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Plan Orbital Maneuver</h3>
              <button className="modal-close" onClick={() => setOrbitalModalOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="input-group">
                <label>Periapsis (km)</label>
                <input
                  type="number"
                  value={peInput}
                  onChange={(e) => setPeInput(e.target.value)}
                  placeholder="Periapsis radius"
                />
              </div>
              <div className="input-group">
                <label>Apoapsis (km)</label>
                <input
                  type="number"
                  value={apInput}
                  onChange={(e) => setApInput(e.target.value)}
                  placeholder="Apoapsis radius"
                />
              </div>
              <div className="modal-actions">
                <button className="btn-primary" onClick={handleOrbitalManeuver}>
                  Plan Maneuver
                </button>
                <button className="btn-secondary" onClick={() => setOrbitalModalOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
