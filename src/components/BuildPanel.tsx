// ============================================================
// BuildPanel — Ship construction UI for owned bodies
// ============================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { BUILDABLE_CLASSES, SHIP_CLASSES, ShipClassName } from '../game/shipClasses';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import {
  ShipIcon, ShipIconVariant, ICON_VARIANT_NAMES,
  ALL_VARIANTS, DEFAULT_SHIP_ICONS,
} from './ShipIcons';
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
  const mpActions = useMultiplayerActions();
  const [, setSelectedClass] = useState<ShipClassName | null>(null);
  const [customName, setCustomName] = useState<string>('');
  // Per-class icon variant pick. Each row in the build list has its
  // own selector defaulting to DEFAULT_SHIP_ICONS[class]. Map keyed by
  // class because the player might want, e.g. Corvette Raptor and
  // Frigate Carrier at the same time.
  const [iconChoice, setIconChoice] = useState<Record<ShipClassName, ShipIconVariant>>({
    corvette:  DEFAULT_SHIP_ICONS.corvette,
    frigate:   DEFAULT_SHIP_ICONS.frigate,
    destroyer: DEFAULT_SHIP_ICONS.destroyer,
    freighter: DEFAULT_SHIP_ICONS.freighter,
  });
  // Server-side build rejection shown as a red chip below the rows so
  // the BUILD button never silently resets in MP — mirrors the
  // BodyInspector deploy-error pattern. Cleared on the next attempt.
  const [buildError, setBuildError] = useState<string | null>(null);

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
    const variant = iconChoice[shipClass];
    if (mpActions) {
      // Multiplayer: server is canonical for resource deduction + queue
      // persistence. Skip the local buildShip() — calling it here used
      // to flash 2× deducted resources for ~1.5s until /state poll snap
      // back. Post intent only; UI updates when the poll lands.
      // Surface server rejections inline so the BUILD button doesn't
      // appear to "do nothing" when the queue actually 4xx'd.
      setBuildError(null);
      mpActions.build({ bodyId: body.id, shipClass, shipName: name, iconVariant: variant })
        .then(res => {
          if (!res.ok) {
            setBuildError(humanizeMpError(res.code, res.error, 'build'));
          }
        });
      setCustomName('');
    } else {
      // Single-player: local state is canonical.
      const success = buildShip(body.id, shipClass, name, variant);
      if (success) setCustomName('');
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
                <button
                  className="build-cancel"
                  onClick={() => {
                    // Optimistic local remove + refund. In MP the server
                    // is authoritative — without the DELETE the next
                    // /state poll would resurrect this build queue row
                    // and re-deduct the refund. Server failures are
                    // logged; the next /state poll will reconcile (the
                    // queued row reappearing is itself the error signal).
                    cancelBuild(bo.id);
                    if (mpActions) {
                      mpActions.cancelBuild(bo.id).then(res => {
                        if (!res.ok) {
                          // eslint-disable-next-line no-console
                          console.warn('cancelBuild rejected by server:', res.error);
                        }
                      });
                    }
                  }}
                  title="Cancel this build (refunds the cost)"
                >✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="build-classes">
        {BUILDABLE_CLASSES.map(cls => {
          const def = SHIP_CLASSES[cls];
          // Per-resource shortages so the UI can colour each cost
          // individually + surface the deficit explicitly. Previously the
          // BUILD button just greyed out with no indication of why.
          const shortFuel    = Math.max(0, def.cost.fuel    - playerRes.fuel);
          const shortOre     = Math.max(0, def.cost.ore     - playerRes.ore);
          const shortCredits = Math.max(0, def.cost.credits - playerRes.credits);
          const canAfford = shortFuel === 0 && shortOre === 0 && shortCredits === 0;
          const shortBits: string[] = [];
          if (shortFuel    > 0) shortBits.push(`+${shortFuel} fuel`);
          if (shortOre     > 0) shortBits.push(`+${shortOre} ore`);
          if (shortCredits > 0) shortBits.push(`+${shortCredits} cr`);
          const shortLabel = shortBits.length > 0 ? `Need ${shortBits.join(', ')}` : '';
          return (
            <div key={cls} className={`build-class-row ${!canAfford ? 'disabled' : ''}`}>
              <div className="class-info">
                {/* Icon picker. Shows the currently-selected variant
                    big, with a small dropdown to swap it. Each row's
                    state is independent (the player can be eyeing a
                    Raptor corvette and a Carrier frigate at once). */}
                <span
                  className="class-icon"
                  title={`Icon: ${ICON_VARIANT_NAMES[cls][iconChoice[cls]]} (click selector to change)`}
                >
                  <ShipIcon shipClass={cls} variant={iconChoice[cls]} size={20} />
                </span>
                <select
                  value={iconChoice[cls]}
                  onChange={(e) => setIconChoice(prev => ({
                    ...prev, [cls]: e.target.value as ShipIconVariant,
                  }))}
                  title="Pick an icon variant for this ship"
                  style={{
                    fontSize: 9, padding: '2px 4px',
                    background: '#0a1018', color: '#4ecdc4',
                    border: '1px solid #2a3d50', borderRadius: 3,
                    fontFamily: 'inherit', cursor: 'pointer',
                    marginRight: 4,
                  }}
                >
                  {ALL_VARIANTS.map(v => (
                    <option key={v} value={v}>{v} · {ICON_VARIANT_NAMES[cls][v]}</option>
                  ))}
                </select>
                <span className="class-name">{def.displayName}</span>
              </div>
              <div className="class-stats">
                <span className="stat">FP:{def.firepower}</span>
                <span className="stat">HP:{def.hp}</span>
                {def.cargoCapacity > 0 && <span className="stat">CG:{def.cargoCapacity}</span>}
              </div>
              <div className="class-cost" title={shortLabel || undefined}>
                {def.cost.fuel > 0 && (
                  <span
                    className="cost-fuel"
                    style={shortFuel > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}
                  >{def.cost.fuel}F</span>
                )}
                <span
                  className="cost-metal"
                  style={shortOre > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}
                >{def.cost.ore}O</span>
                <span
                  className="cost-money"
                  style={shortCredits > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}
                >{def.cost.credits}C</span>
              </div>
              <button
                className="build-btn"
                disabled={!canAfford}
                onClick={() => handleBuild(cls)}
                title={canAfford
                  ? `Build a ${def.displayName} (${def.cost.fuel}F ${def.cost.ore}O ${def.cost.credits}C, ${def.buildTime} ticks)`
                  : shortLabel}
              >
                BUILD
              </button>
              {!canAfford && shortLabel && (
                // Inline shortage callout. Hugs the row so the player
                // doesn't have to hover to learn what's missing.
                <div
                  className="build-shortage"
                  role="status"
                  style={{
                    flexBasis: '100%',
                    margin: '2px 0 0',
                    fontSize: 10,
                    color: '#ff5e5e',
                    letterSpacing: '0.04em',
                  }}
                >⚠ {shortLabel}</div>
              )}
            </div>
          );
        })}
      </div>

      {buildError && (
        // Server rejected the queue. Without surfacing this the BUILD
        // button would silently reset to the un-clicked state when the
        // next /state poll arrived (because the server never actually
        // wrote the row). Click to dismiss.
        <button
          onClick={() => setBuildError(null)}
          style={{
            marginTop: 8, padding: '6px 10px',
            background: 'rgba(255, 94, 94, 0.1)',
            border: '1px solid #ff5e5e', borderRadius: 4,
            color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
            fontFamily: 'inherit', textAlign: 'left',
            cursor: 'pointer', width: '100%',
          }}
          title="Click to dismiss"
        >⚠ {buildError}</button>
      )}

      <div className="resources-bar">
        <span className="resource">FUEL: {Math.round(playerRes.fuel)}</span>
        <span className="resource">ORE: {Math.round(playerRes.ore)}</span>
        <span className="resource">CR: {Math.round(playerRes.credits)}</span>
      </div>
    </div>
  );
};
