// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { loadoutSummary } from '../game/shipParts';
import { ShipIcon } from './ShipIcons';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { openShipDesigner } from './ShipDesigner';
import './OverviewPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy';

export const FleetPanel: React.FC<FleetPanelProps> = ({ onClose }) => {
  const {
    gameState, selectShip, focusBody, uiState,
    launchTorchTransfer,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [filter, setFilter] = useState<Filter>('player');
  // Bulk-select set: ship ids the player has checked for a bulk
  // maneuver action. Only player-owned ships can join the set.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Bulk standing orders (MP only). '' = leave that field unchanged;
  // 'off' clears a threshold. Applied to every selected ship in one
  // PATCH /ships/orders call.
  const [bulkStance, setBulkStance] = useState<string>('');
  const [bulkRetreat, setBulkRetreat] = useState<string>('');
  const [bulkDetonate, setBulkDetonate] = useState<string>('');
  const [ordersNotice, setOrdersNotice] = useState<string | null>(null);

  const ships = useMemo(() => {
    return gameState.ships.filter(s => {
      if (filter === 'player') return s.ownedBy === 'player';
      if (filter === 'enemy') return s.ownedBy === 'enemy';
      return true;
    });
  }, [gameState.ships, filter]);

  // "In transit" = ships with an active torch burn. Bulk-action
  // eligibility excludes them.
  const inTransit = useMemo(() => ships.filter(s => s.transit), [ships]);
  const orbiting = useMemo(() => ships.filter(s => !s.transit), [ships]);

  // Group orbiting ships by parent body id
  const orbitingByBody = useMemo(() => {
    const map = new Map<string, typeof orbiting>();
    for (const s of orbiting) {
      const list = map.get(s.orbit.parentBodyId) || [];
      list.push(s);
      map.set(s.orbit.parentBodyId, list);
    }
    return Array.from(map.entries()).sort((a, b) => {
      const aBody = gameState.bodies.find(x => x.id === a[0]);
      const bBody = gameState.bodies.find(x => x.id === b[0]);
      return (aBody?.name || '').localeCompare(bBody?.name || '');
    });
  }, [orbiting, gameState.bodies]);

  const handleShipClick = (shipId: string) => {
    selectShip(shipId);
  };

  const handleBodyClick = (bodyId: string) => {
    focusBody(bodyId);
  };

  const toggleSelected = (shipId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(shipId)) next.delete(shipId);
      else next.add(shipId);
      return next;
    });
  };

  // Set of player ships currently eligible for a bulk transfer
  // (orbiting, with no in-flight or planned transit already attached).
  const bulkEligibleIds = useMemo(() => {
    return new Set(
      gameState.ships
        .filter(s => s.ownedBy === 'player' && !s.transit && !s.plannedTransit)
        .map(s => s.id)
    );
  }, [gameState.ships]);

  const visibleSelected = useMemo(
    () => Array.from(selectedIds).filter(id => bulkEligibleIds.has(id)),
    [selectedIds, bulkEligibleIds]
  );

  // Bodies the player can route to. Sol is included — the Dyson
  // sphere ferry mechanic already routes freighters there, and the
  // fleet picker previously excluded it for no good reason.
  const transferTargets = useMemo(
    () => [...gameState.bodies].sort((a, b) => a.name.localeCompare(b.name)),
    [gameState.bodies]
  );

  const issueBulkTransfer = () => {
    setBulkError(null);
    if (!bulkTarget) { setBulkError('Pick a destination'); return; }
    const target = gameState.bodies.find(b => b.id === bulkTarget);
    if (!target) { setBulkError('Unknown destination'); return; }
    if (visibleSelected.length === 0) { setBulkError('No eligible ships selected'); return; }

    let issued = 0;
    // Collect server rejection codes so the UI can summarize what
    // happened ("3 transfers rejected: not enough fuel / no longer
    // own ship"). Without this, the bulk button looks like it
    // worked but half the ships silently snap back to orbiting.
    const serverRejections: string[] = [];
    for (const sid of visibleSelected) {
      const ship = gameState.ships.find(s => s.id === sid);
      if (!ship) continue;
      // Torch model: bulk transfer fires the burn immediately — no
      // separate plan/commit step for the fleet-level button. Players
      // who want the preview path should use the per-ship Transfer.
      const plan = launchTorchTransfer(ship.id, bulkTarget);
      if (!plan) continue;
      if (mpActions) {
        mpActions.transfer({
          shipId: ship.id,
          targetBodyId: plan.targetBodyId,
          scheduledT: plan.startTick,
          arrivalT: plan.arriveTick,
          dvPrograde: plan.totalDv,
          fuelCost: Math.round(plan.totalDv * 10),
        }).then(res => {
          if (!res.ok) {
            serverRejections.push(humanizeMpError(res.code, res.error, 'transfer'));
            // We collect from many ships' resolved promises (fire-and-forget
            // loop), but they all share `serverRejections`. We re-render the
            // bulkError each rejection so the player sees the count grow.
            setBulkError(
              `${serverRejections.length} of ${visibleSelected.length} rejected by server — ${serverRejections[0]}`,
            );
          }
        });
      }
      issued += 1;
    }
    if (issued === 0) setBulkError('Could not plan a transfer for any selected ship');
    else {
      setSelectedIds(new Set());
      setBulkTarget('');
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkError(null);
    setOrdersNotice(null);
  };

  // Bulk standing orders — one PATCH covering every selected ship.
  // Server validates ownership of EVERY ship and rejects the whole
  // batch if any isn't ours (all-or-nothing), so no partial state.
  const issueBulkOrders = () => {
    setOrdersNotice(null);
    if (!mpActions) return;
    if (visibleSelected.length === 0) { setOrdersNotice('No eligible ships selected'); return; }
    if (!bulkStance && !bulkRetreat && !bulkDetonate) {
      setOrdersNotice('Pick at least one order to apply');
      return;
    }
    mpActions.setShipOrders({
      shipIds: visibleSelected,
      ...(bulkStance ? { stance: bulkStance as 'attack' | 'defensive' | 'hold' } : {}),
      ...(bulkRetreat
        ? { retreatHpPct: bulkRetreat === 'off' ? null : (Number(bulkRetreat) as 25 | 50 | 75) }
        : {}),
      ...(bulkDetonate
        ? { detonateHpPct: bulkDetonate === 'off' ? null : (Number(bulkDetonate) as 25 | 50) }
        : {}),
    }).then(res => {
      if (res.ok) {
        setOrdersNotice(`Orders set on ${visibleSelected.length} ship${visibleSelected.length === 1 ? '' : 's'}`);
        setBulkStance('');
        setBulkRetreat('');
        setBulkDetonate('');
      } else {
        setOrdersNotice(humanizeMpError(res.code, res.error, 'orders'));
      }
    });
  };

  const ownerBadge = (ownedBy: string) => {
    if (ownedBy === 'player') return <span className="owner-badge owner-badge--player">Player</span>;
    if (ownedBy === 'enemy') return <span className="owner-badge owner-badge--enemy">Enemy</span>;
    return <span className="owner-badge owner-badge--neutral">{ownedBy}</span>;
  };

  const renderHpBar = (ship: { hp?: number; hpMax?: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    // Server-authoritative max HP when present (designer shield parts +
    // tech, migration 0033); class-def fallback for SP/legacy ships.
    const hp = ship.hp ?? ship.hpMax ?? def.hp;
    // Where the server hasn't sent hpMax, armor tech and per-kill rank
    // still push real max above the base class hp, so a teched/veteran
    // ship would read "108/100" with the fill bar overrunning its track.
    // max(base, hp) clamps the denominator; the server value already
    // accounts for both when present.
    const maxHp = ship.hpMax ?? Math.max(def.hp, hp);
    const ratio = maxHp > 0 ? Math.min(1, hp / maxHp) : 0;
    const hpClass = ratio > 0.66 ? 'good' : ratio > 0.33 ? 'mid' : 'low';
    return (
      <div className="status-bar">
        <div className="status-bar__fill">
          <div
            className={`status-bar__inner status-bar__inner--hp-${hpClass}`}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
        <span className="status-bar__text">{Math.round(hp)}/{Math.round(maxHp)}</span>
      </div>
    );
  };

  // renderFuelBar removed — fuel left the economy
  // (DESIGN-identity-economy.md §1.1).


  const renderShipRow = (ship: typeof ships[0]) => {
    const def = getShipClass(ship.class as ShipClassName);
    const isSelected = uiState.selectedShipId === ship.id;
    // Pull transit metadata from the ship's torch transit state.
    let targetBodyId: string | undefined;
    let eta: number | null = null;
    if (ship.transit) {
      const plan = ship.transit.currentTransfer;
      targetBodyId = plan.targetBodyId;
      eta = Math.max(0, plan.arriveTick - gameState.currentTick);
    }
    const target = targetBodyId ? gameState.bodies.find(b => b.id === targetBodyId) : null;
    const transit = ship.transit;

    let statusBadge;
    if (transit) {
      statusBadge = <span className="status-badge status-badge--transit">In Transit</span>;
    } else if (ship.plannedTransit) {
      statusBadge = <span className="status-badge status-badge--planned">Planned</span>;
    } else {
      statusBadge = <span className="status-badge status-badge--orbiting">Orbiting</span>;
    }

    const eligible = bulkEligibleIds.has(ship.id);
    const checked = selectedIds.has(ship.id);
    return (
      <tr
        key={ship.id}
        className={isSelected ? 'selected' : ''}
        onClick={() => handleShipClick(ship.id)}
      >
        <td onClick={(e) => e.stopPropagation()} style={{ width: 32, textAlign: 'center' }}>
          {eligible ? (
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggleSelected(ship.id)}
              title="Add to bulk selection"
              style={{ cursor: 'pointer' }}
            />
          ) : (
            <span title="Not eligible (not player-owned, or already in transit/planned)" style={{ opacity: 0.25 }}>—</span>
          )}
        </td>
        <td>
          <div className="body-cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ color: '#4ecdc4', flexShrink: 0 }}>
              <ShipIcon shipClass={ship.class as ShipClassName} size={20} />
            </div>
            <div>
              <div className="body-cell__name">{ship.name}</div>
              <div className="body-cell__type">
                {def.displayName}
                {(() => {
                  // Show the designer loadout in place of the redundant
                  // "· corvette" class echo. Null (SP / colony / no parts
                  // field) falls back to the plain class name so nothing
                  // reads as empty.
                  const loadout = loadoutSummary(ship.parts);
                  return loadout
                    ? <span className="body-cell__loadout" title="Fitted parts"> · {loadout}</span>
                    : <> · {ship.class}</>;
                })()}
              </div>
            </div>
          </div>
        </td>
        <td>{ownerBadge(ship.ownedBy)}</td>
        <td>{statusBadge}</td>
        <td>
          {transit && target ? (
            <span>→ <strong style={{ color: '#4ecdc4' }}>{target.name}</strong> · T-{Math.round(eta ?? 0)}</span>
          ) : (
            <span className="col-muted">{ship.orbit.parentBodyId.toUpperCase()}</span>
          )}
        </td>
        <td>{renderHpBar(ship)}</td>
      </tr>
    );
  };

  const tableHead = (locationLabel: string) => (
    <thead>
      <tr>
        <th style={{ width: 32 }}></th>
        <th>Ship</th>
        <th>Owner</th>
        <th>Status</th>
        <th>{locationLabel}</th>
        <th>HP</th>
      </tr>
    </thead>
  );

  return (
    <div className="overview-panel">
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Fleet</div>
          <div className="overview-panel__title-sub">{ships.length} ships · {orbiting.length} orbiting · {inTransit.length} in transit</div>
        </div>
        {/* Ship designer entry point (MP only — the designer is part of
            the identity-economy release and the SP sim is frozen). */}
        {mpActions && (
          <button
            className="filter-chip"
            style={{ marginRight: 8 }}
            onClick={() => openShipDesigner()}
            title="Design ship loadouts — weapons, shields, engines, detonators. BUILD uses each class's active design."
          >
            ⚙ SHIP DESIGNER
          </button>
        )}
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="overview-panel__filters">
        {(['player', 'enemy', 'all'] as Filter[]).map(f => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {visibleSelected.length > 0 && (
        <div className="fleet-bulk-bar">
          <div className="fleet-bulk-bar__count">
            {visibleSelected.length} ship{visibleSelected.length === 1 ? '' : 's'} selected
          </div>
          <div className="fleet-bulk-bar__actions">
            <label className="fleet-bulk-bar__label">Transfer all to</label>
            <select
              className="fleet-bulk-bar__select"
              value={bulkTarget}
              onChange={(e) => setBulkTarget(e.target.value)}
            >
              <option value="">Select destination…</option>
              {transferTargets.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <button
              className="fleet-bulk-bar__btn fleet-bulk-bar__btn--primary"
              onClick={issueBulkTransfer}
              disabled={!bulkTarget}
            >
              Issue {visibleSelected.length} orders
            </button>
            <button
              className="fleet-bulk-bar__btn"
              onClick={clearSelection}
            >
              Clear
            </button>
          </div>
          {bulkError && <div className="fleet-bulk-bar__error">{bulkError}</div>}

          {mpActions && (
            <div className="fleet-bulk-bar__actions" style={{ marginTop: 6 }}>
              <label className="fleet-bulk-bar__label">Orders</label>
              <select
                className="fleet-bulk-bar__select"
                value={bulkStance}
                onChange={(e) => setBulkStance(e.target.value)}
                title="Stance: attack on sight / return fire only / never fire"
              >
                <option value="">Stance: keep</option>
                <option value="attack">Attack on sight</option>
                <option value="defensive">Defensive (return fire)</option>
                <option value="hold">Hold fire</option>
              </select>
              <select
                className="fleet-bulk-bar__select"
                value={bulkRetreat}
                onChange={(e) => setBulkRetreat(e.target.value)}
                title="Auto-retreat to the nearest friendly shipyard station below this HP threshold"
              >
                <option value="">Retreat: keep</option>
                <option value="off">Retreat: off</option>
                <option value="25">Retreat at 25% HP</option>
                <option value="50">Retreat at 50% HP</option>
                <option value="75">Retreat at 75% HP</option>
              </select>
              <select
                className="fleet-bulk-bar__select"
                value={bulkDetonate}
                onChange={(e) => setBulkDetonate(e.target.value)}
                title="Auto-detonate below X% HP: deals damage to every ship in this orbit, friend or foe; this ship is destroyed. No effect on hulls without a detonator part."
              >
                <option value="">Detonate: keep</option>
                <option value="off">Detonate: off</option>
                <option value="25">Detonate below 25% HP</option>
                <option value="50">Detonate below 50% HP</option>
              </select>
              <button
                className="fleet-bulk-bar__btn fleet-bulk-bar__btn--primary"
                onClick={issueBulkOrders}
                disabled={!bulkStance && !bulkRetreat && !bulkDetonate}
              >
                SET ORDERS
              </button>
            </div>
          )}
          {mpActions && bulkDetonate && bulkDetonate !== 'off' && (
            <div className="fleet-bulk-bar__error" style={{ color: '#ff9e7a' }}>
              Auto-detonate below {bulkDetonate}% HP: deals damage to every ship
              in this orbit, friend or foe; this ship is destroyed. No effect on
              hulls without a detonator part.
            </div>
          )}
          {ordersNotice && <div className="fleet-bulk-bar__error">{ordersNotice}</div>}
        </div>
      )}

      <div className="overview-panel__body">
        {ships.length === 0 ? (
          <div className="overview-empty">No ships match the current filter.</div>
        ) : (
          <>
            {inTransit.length > 0 && (
              <div className="overview-section">
                <div className="overview-section__title">
                  In Transit
                  <span className="overview-section__count">{inTransit.length} ships</span>
                </div>
                <table className="overview-table">
                  {tableHead('Destination')}
                  <tbody>
                    {inTransit.map(renderShipRow)}
                  </tbody>
                </table>
              </div>
            )}

            {orbitingByBody.map(([bodyId, bodyShips]) => {
              const body = gameState.bodies.find(b => b.id === bodyId);
              return (
                <div className="overview-section" key={bodyId}>
                  <div className="overview-section__title">
                    <span
                      onClick={() => handleBodyClick(bodyId)}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                      title="Click to focus map"
                    >
                      <span style={{
                        width: 10, height: 10, borderRadius: '50%',
                        background: body?.color || '#888',
                        display: 'inline-block',
                      }} />
                      Orbiting {body?.name || bodyId}
                    </span>
                    <span className="overview-section__count">{bodyShips.length} ships</span>
                  </div>
                  <table className="overview-table">
                    {tableHead('Location')}
                    <tbody>
                      {bodyShips.map(renderShipRow)}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
