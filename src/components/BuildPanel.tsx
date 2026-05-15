// ============================================================
// BuildPanel — Ship construction UI for owned bodies
// ============================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { BUILDABLE_CLASSES, SHIP_CLASSES, ShipClassName } from '../game/shipClasses';
import './BuildPanel.css';

// Expanse-themed random ship names
const SHIP_NAMES: Record<ShipClassName, string[]> = {
  corvette: ['Tachi', 'Razorback', 'Pella', 'Chetzemoka', 'Screaming Firehawk', 'Kittur Chennamma'],
  frigate: ['Scirocco', 'Hammurabi', 'Xuesen', 'Amberjack', 'Zenobia'],
  destroyer: ['Donnager', 'Agatha King', 'Truman', 'Barkeith', 'Sagarmatha', 'Jimenez'],
  freighter: ['Canterbury', 'Somnambulist', 'Weeping Somnambulist', 'Barbapiccola', 'Cerisier'],
};

function getRandomName(shipClass: ShipClassName, existingNames: string[]): string {
  const pool = SHIP_NAMES[shipClass];
  const available = pool.filter(n => !existingNames.includes(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  return `${pool[0]}-${Math.floor(Math.random() * 100)}`;
}

export const BuildPanel: React.FC = () => {
  const { gameState, uiState, buildShip, cancelBuild } = useGameContext();
  const [, setSelectedClass] = useState<ShipClassName | null>(null);
  const [customName, setCustomName] = useState<string>('');

  if (!uiState.selectedBodyId) return null;

  const body = gameState.bodies.find(b => b.id === uiState.selectedBodyId);
  if (!body || body.ownedBy !== 'player') return null;

  // Can only build on terrestrial, dwarf, or moon bodies
  if (body.type === 'star' || body.type === 'gas_giant' || body.type === 'ice_giant') return null;

  const playerRes = gameState.resources['player'];
  if (!playerRes) return null;

  const activeBuildOrders = gameState.buildOrders.filter(bo => bo.bodyId === body.id);
  const existingShipNames = gameState.ships.map(s => s.name);

  const handleBuild = (shipClass: ShipClassName) => {
    // Custom name takes precedence; fall back to a random pool name
    const trimmed = customName.trim();
    const name = trimmed.length > 0
      ? trimmed
      : getRandomName(shipClass, existingShipNames);
    const success = buildShip(body.id, shipClass, name);
    if (success) {
      setCustomName('');
    }
    setSelectedClass(null);
  };

  return (
    <div className="build-panel">
      <div className="section-title">SHIPYARD</div>

      <div className="build-name-row">
        <input
          type="text"
          className="build-name-input"
          placeholder="Custom name (optional)"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          maxLength={32}
        />
      </div>

      {activeBuildOrders.length > 0 && (
        <div className="build-queue">
          <div className="queue-label">BUILDING</div>
          {activeBuildOrders.map(bo => {
            const progress = (gameState.currentTick - bo.startTick) / (bo.completeTick - bo.startTick);
            const remaining = Math.max(0, bo.completeTick - gameState.currentTick);
            return (
              <div key={bo.id} className="build-item">
                <div className="build-info">
                  <span className="build-name">{bo.shipName}</span>
                  <span className="build-class">{bo.shipClass.toUpperCase()}</span>
                </div>
                <div className="build-progress-bar">
                  <div className="build-progress-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                </div>
                <div className="build-eta">T-{remaining.toFixed(0)}</div>
                <button className="build-cancel" onClick={() => cancelBuild(bo.id)}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="build-classes">
        {BUILDABLE_CLASSES.map(cls => {
          const def = SHIP_CLASSES[cls];
          const canAfford = playerRes.fuel >= def.cost.fuel && playerRes.ore >= def.cost.ore && playerRes.credits >= def.cost.credits;
          return (
            <div key={cls} className={`build-class-row ${!canAfford ? 'disabled' : ''}`}>
              <div className="class-info">
                <span className="class-icon">{def.icon}</span>
                <span className="class-name">{def.displayName}</span>
              </div>
              <div className="class-stats">
                <span className="stat">FP:{def.firepower}</span>
                <span className="stat">HP:{def.hp}</span>
                {def.cargoCapacity > 0 && <span className="stat">CG:{def.cargoCapacity}</span>}
              </div>
              <div className="class-cost">
                <span className="cost-metal">{def.cost.ore}O</span>
                <span className="cost-money">{def.cost.credits}C</span>
              </div>
              <button
                className="build-btn"
                disabled={!canAfford}
                onClick={() => handleBuild(cls)}
              >
                BUILD
              </button>
            </div>
          );
        })}
      </div>

      <div className="resources-bar">
        <span className="resource">FUEL: {playerRes.fuel}</span>
        <span className="resource">ORE: {playerRes.ore}</span>
        <span className="resource">CR: {playerRes.credits}</span>
      </div>
    </div>
  );
};
