import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { ManeuverNode } from '../types';
import { planBezierTransfer } from '../physics/bezierTransfer';
import { createCircularOrbit } from '../physics/orbitalMechanics';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { maintenanceRatesForShip } from '../game/maintenance';
import { travelTimeModifier, FactionTechState } from '../game/techs';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { useIsMobile } from '../hooks/useIsMobile';
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
  const isMobile = useIsMobile();

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
        if (!arc) {
          console.warn('[transfer] planBezierTransfer returned null (chain)', {
            from: chainTail.bodyId, to: targetBodyId,
            knownBodies: gameState.bodies.map(b => b.id),
          });
          return;
        }
        addQueuedTransfer(ship.id, arc);
      } else {
        const arc = planBezierTransfer(ship.orbit, targetBodyId, gameState.currentTick, gameState.bodies, travelTimeMul);
        if (!arc) {
          console.warn('[transfer] planBezierTransfer returned null', {
            shipId: ship.id,
            from: ship.orbit.parentBodyId, to: targetBodyId,
            knownBodies: gameState.bodies.map(b => ({ id: b.id, parent: b.parent })),
          });
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
        // NOTE: do NOT post mpActions.transfer() here. The server records
        // every transfer it sees as 'committed' (no 'planned' state on the
        // server side), which made every plan auto-commit at the next
        // /state poll (~1.5s) regardless of whether the user clicked
        // Commit. The post now happens in commitTransferLocal() below,
        // wired to the COMMIT button so plan/commit stays a deliberate
        // two-step action — matching the single-player UX.

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
              // mpActions.transfer() is deliberately omitted here too —
              // fleet members get their own planned node and will be
              // posted together when the leader hits Commit (each
              // member's node carries enough state for commitTransferLocal
              // to recover the arc).
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

  /**
   * Commit a planned transfer locally + post the intent to the server
   * (multiplayer only). This is the deliberate two-step action: planning
   * a transfer creates a `planned` node with a dashed preview arc; the
   * user has to explicitly commit before the burn schedules on the
   * server. Previously the server post happened at plan time, which
   * made every transfer auto-fire ~1.5s later when /state polled back
   * the server's 'committed' record.
   */
  const commitTransferLocal = (node: ManeuverNode, owningShip: typeof ship) => {
    commitManeuverNode(node.id);
    if (!mpActions) return;
    // Recover the arc that produced this node from the ship's pending
    // transfer state (set at plan time). For queued transfers the arc
    // came from queuedTransfers — but for now we only post the head
    // of the chain; the rest will be posted as each one becomes the
    // committed pending transfer on subsequent arrivals.
    const arc = owningShip.pendingTransfer;
    if (!arc) return;
    mpActions.transfer({
      shipId: owningShip.id,
      targetBodyId: arc.arrivalBodyId,
      scheduledT: arc.departureTime,
      // Pass the precomputed arrival tick so the server doesn't re-
      // derive it via Hohmann (which was giving 400+ ticks for moon
      // transfers because of mismatched μ vs. orbit-radius units).
      arrivalT: arc.arrivalTime,
      dvPrograde: arc.departureDv,
      fuelCost: Math.round(Math.abs(arc.departureDv) * 10),
    });
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
              <span className="label">OWNER</span>
              {(() => {
                // Faction lookup: in MP the caller's faction id is
                // rewritten to 'player' (see MultiplayerGameProvider
                // PLAYER_TOKEN) so a single find on ownedBy works for
                // both SP + MP. Render a colored chip so a glance tells
                // you "mine / theirs / whose theirs" at the same colors
                // ships now render in on the map.
                const owner = gameState.factions.find(f => f.id === ship.ownedBy);
                const ownerColor = owner?.color || '#8a9fb3';
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
                      <span style={{ color: '#8a9fb3', fontSize: '9px', marginLeft: 2 }}>
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
                    onClick={() => {
                      // Commit each planned node. In MP commitTransferLocal
                      // also posts the intent to the server; in SP it's
                      // just a local status flip via commitManeuverNode.
                      // Walk a snapshot of orders so the loop is stable
                      // even if state mutates between iterations.
                      const planned = ship.orders.filter(o => o.status === 'planned');
                      for (const o of planned) {
                        commitTransferLocal(o, ship);
                      }
                    }}
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
              <div className="stat-row" style={{ fontSize: '9px', color: '#8a9fb3', fontStyle: 'italic' }}>
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

/** Group label + ordering for the picker. */
function groupOf(body: import('../types').Body, bodies: import('../types').Body[]): { key: string; label: string; order: number } {
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

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bodies.filter(b => {
      if (b.id === 'sol' || b.id === excludeBodyId) return false;
      if (!q) return true;
      const parentName = b.parent ? bodies.find(x => x.id === b.parent)?.name.toLowerCase() ?? '' : '';
      return b.name.toLowerCase().includes(q) || parentName.includes(q);
    });
  }, [bodies, excludeBodyId, query]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; order: number; bodies: import('../types').Body[] }>();
    for (const b of visible) {
      const g = groupOf(b, bodies);
      if (!map.has(g.key)) map.set(g.key, { label: g.label, order: g.order, bodies: [] });
      map.get(g.key)!.bodies.push(b);
    }
    // Sort body lists by name; groups by .order then label.
    for (const v of map.values()) v.bodies.sort((a, b) => a.name.localeCompare(b.name));
    return Array.from(map.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [visible, bodies]);

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
              <div style={{ color: '#8a9fb3', fontSize: 11, textAlign: 'center', padding: '24px 0' }}>
                No bodies match "{query}".
              </div>
            )}
            {groups.map(g => (
              <div key={g.label}>
                <div style={{
                  fontSize: 9, letterSpacing: '0.14em', color: '#8a9fb3',
                  textTransform: 'uppercase', marginBottom: 6,
                }}>
                  {g.label} · {g.bodies.length}
                </div>
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
              </div>
            ))}
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
                  <span style={{ color: '#8a9fb3', fontSize: 9 }}>{p.class.toUpperCase()}</span>
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
