// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { loadoutSummary, countPart } from '../game/shipParts';
import { deriveSecondary } from '../game/colorUtils';
import { makeSystemRootOf, systemLabel as systemLabelOf, shipStatus, makeHostilesAtBody, makeArmedHostilesAtBody, makeStationsAtBody } from '../game/systemGrouping';
import { nearestShipyardBodyId, isDamagedShip } from '../game/repair';
import { ShipIcon } from './ShipIcons';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { openShipDesigner } from './ShipDesigner';
import './OverviewPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy';

// System grouping and ship status now live in game/systemGrouping so the
// Outliner renders identical headers and identical status chips. They were
// duplicated here, and the copies had already diverged.

// Translucent fill from a hex colour (for faction-tinted badges).
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const FleetPanel: React.FC<FleetPanelProps> = ({ onClose }) => {
  const {
    gameState, selectShip, focusBody, uiState,
    launchTorchTransfer,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  // Default to the "All" tab in multiplayer (per request); single-player
  // keeps its historical "Mine" default. mpActions is non-null ONLY in
  // MP (null in SP, where every mpActions branch below is already dead),
  // so gating on it changes nothing about the SP code path.
  const [filter, setFilter] = useState<Filter>(mpActions ? 'all' : 'player');
  const [query, setQuery] = useState('');
  const [collapsedSystems, setCollapsedSystems] = useState<Set<string>>(new Set());
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

  const bodyById = useMemo(
    () => new Map(gameState.bodies.map(b => [b.id, b])),
    [gameState.bodies]
  );

  // Faction id -> { name, color } so the OWNER column shows the empire
  // name (e.g. "Lornian Empire") in its faction colour, instead of the
  // raw faction id ("8X7TTVD-L3P_:F1") — the "name bug".
  const factionById = useMemo(() => {
    const m = new Map<string, { name: string; color: string; color2: string }>();
    for (const f of gameState.factions) {
      m.set(f.id, { name: f.name, color: f.color, color2: f.color2 || deriveSecondary(f.color) });
    }
    return m;
  }, [gameState.factions]);

  // color2 mirrors the map (§5): the faction's explicit secondary, or a
  // derived one, so the fleet-menu ship icons carry the same two-tone
  // livery the map does.
  const factionOf = (ownedBy: string): { name: string; color: string; color2: string } => {
    if (ownedBy === 'player') return { name: 'You', color: '#4ecdc4', color2: deriveSecondary('#4ecdc4') };
    if (ownedBy === 'enemy') return { name: 'Enemy', color: '#ff5e5e', color2: deriveSecondary('#ff5e5e') };
    const f = factionById.get(ownedBy);
    if (f) return f;
    // Last resort (unknown faction id): show the short suffix, not the
    // whole game-namespaced id.
    return { name: ownedBy.split(':').pop() ?? ownedBy, color: '#8a9fb3', color2: deriveSecondary('#8a9fb3') };
  };

  // Planetary grouping: Titan and Enceladus file under "Saturn System",
  // Saturn under itself. See game/systemGrouping.
  const systemRootOf = useMemo(
    () => makeSystemRootOf(gameState.bodies),
    [gameState.bodies]
  );

  const systemLabel = (rootId: string): string =>
    systemLabelOf(gameState.bodies, rootId);

  /** "In Combat" means a hostile shares the orbit right now. Built over
   *  ALL ships and settlements — the filter tabs hide the enemy from the
   *  list, but they must not hide it from the status calculation. */
  const hostilesAtBody = useMemo(
    () => makeHostilesAtBody(gameState.ships, gameState.settlements),
    [gameState.ships, gameState.settlements],
  );
  // Stricter combat test for non-combatants — an armed hostile SHIP is
  // actually here. A freighter parked near an enemy city or a passing
  // hauler is NOT "in combat".
  const armedHostilesAtBody = useMemo(
    () => makeArmedHostilesAtBody(gameState.ships),
    [gameState.ships],
  );
  // Friendly-station presence per body — feeds the "Repairing" status
  // (station repair = +2 HP/tick, worker maintenance pass).
  const stationsAtBody = useMemo(
    () => makeStationsAtBody(gameState.settlements),
    [gameState.settlements],
  );
  // A freighter (non-combatant) is only "In Combat" when a warship is on
  // it; every other class uses the general presence test.
  const inCombatFor = (s: typeof gameState.ships[number]) =>
    (s.class === 'freighter' ? armedHostilesAtBody : hostilesAtBody)(s.orbit.parentBodyId, s.ownedBy);

  const ships = useMemo(() => {
    const q = query.trim().toLowerCase();
    return gameState.ships.filter(s => {
      // 'enemy' means "not mine". The caller's faction is rewritten to
      // the 'player' token on load and every other faction keeps its raw
      // id, so nothing is ever literally owned by 'enemy' — matching on
      // that string left the tab permanently blank.
      if (filter === 'player' && s.ownedBy !== 'player') return false;
      if (filter === 'enemy' && s.ownedBy === 'player') return false;
      if (!q) return true;
      const def = getShipClass(s.class as ShipClassName);
      const body = bodyById.get(s.orbit.parentBodyId);
      const haystack = [
        s.name,
        s.class,
        def.displayName,
        body?.name ?? s.orbit.parentBodyId,
        body ? systemLabel(systemRootOf(body.id)) : '',
        factionOf(s.ownedBy).name,
      ];
      return haystack.some(h => h.toLowerCase().includes(q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.ships, filter, query, bodyById, systemRootOf, factionById]);

  // "In transit" = ships with an active torch burn. Bulk-action
  // eligibility excludes them.
  const inTransit = useMemo(() => ships.filter(s => s.transit), [ships]);
  const orbiting = useMemo(() => ships.filter(s => !s.transit), [ships]);

  // Orbiting ships, grouped by star system and then by body within it.
  // Systems sort by the root's orbit radius, which reads as "distance
  // from home": Sol (0), then Centauri, then Cygnus.
  const systems = useMemo(() => {
    const bySystem = new Map<string, Map<string, typeof orbiting>>();
    for (const s of orbiting) {
      const root = systemRootOf(s.orbit.parentBodyId);
      let bodies = bySystem.get(root);
      if (!bodies) { bodies = new Map(); bySystem.set(root, bodies); }
      const list = bodies.get(s.orbit.parentBodyId) || [];
      list.push(s);
      bodies.set(s.orbit.parentBodyId, list);
    }
    return Array.from(bySystem.entries())
      .map(([rootId, bodies]) => ({
        rootId,
        label: systemLabel(rootId),
        shipCount: Array.from(bodies.values()).reduce((n, l) => n + l.length, 0),
        bodies: Array.from(bodies.entries()).sort((a, b) =>
          (bodyById.get(a[0])?.name || a[0]).localeCompare(bodyById.get(b[0])?.name || b[0])
        ),
      }))
      .sort((a, b) =>
        (bodyById.get(a.rootId)?.orbitRadius ?? 0) - (bodyById.get(b.rootId)?.orbitRadius ?? 0)
        || a.label.localeCompare(b.label)
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbiting, bodyById, systemRootOf]);

  const toggleSystem = (rootId: string) => {
    setCollapsedSystems(prev => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const handleShipClick = (shipId: string) => {
    selectShip(shipId);
    // Zoom the map to where the ship is: the body it orbits, or — if it's
    // in transit — the world it's heading to. With the panel now narrow +
    // left-anchored, the focused body lands in the open map area on the right.
    const ship = gameState.ships.find(s => s.id === shipId);
    const bodyId = ship?.transit
      ? ship.transit.currentTransfer?.targetBodyId
      : ship?.orbit?.parentBodyId;
    if (bodyId) focusBody(bodyId);
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

  // How many of the selection can actually detonate. The bulk control
  // is hidden at zero (setting it would be a no-op on every ship), and
  // when it's a subset the hint says so instead of the old blanket
  // "no effect on hulls without a detonator part" disclaimer.
  const detonatorSelectedCount = useMemo(() => {
    const sel = new Set(visibleSelected);
    return gameState.ships.filter(
      s => sel.has(s.id) && countPart(s.parts, 'detonator') > 0,
    ).length;
  }, [visibleSelected, gameState.ships]);

  // Bodies the player can route to. Sol is included — the Dyson
  // sphere ferry mechanic already routes freighters there, and the
  // fleet picker previously excluded it for no good reason.
  const transferTargets = useMemo(
    () => [...gameState.bodies].sort((a, b) => a.name.localeCompare(b.name)),
    [gameState.bodies]
  );

  // Damaged parked player hulls NOT already healing at a friendly
  // station — the population the one-shot repair dispatch operates on.
  const damagedAway = useMemo(
    () => gameState.ships.filter(s =>
      s.ownedBy === 'player' && !s.transit && !s.plannedTransit
      && isDamagedShip(s)
      && !stationsAtBody(s.orbit.parentBodyId, s.ownedBy)),
    [gameState.ships, stationsAtBody],
  );

  // Feedback line for the one-shot repair dispatch — rendered under the
  // search row (the bulk bar's error only exists while ships are checked).
  const [repairMsg, setRepairMsg] = useState<string | null>(null);

  /** One click: every damaged parked hull heads to its nearest friendly
   *  shipyard body (same destination rule the server's auto-retreat
   *  uses). Ships already at a friendly station are left alone — the
   *  maintenance pass is healing them where they sit. */
  const sendDamagedToYards = () => {
    setRepairMsg(null);
    let sent = 0;
    let noYard = 0;
    const rejections: string[] = [];
    for (const ship of damagedAway) {
      const dest = nearestShipyardBodyId(
        ship, gameState.settlements, gameState.bodies, gameState.currentTick,
      );
      if (!dest) { noYard++; continue; }
      const plan = launchTorchTransfer(ship.id, dest);
      if (!plan) continue;   // no fuel / engine down — leave it parked
      sent++;
      mpActions?.transfer({
        shipId: ship.id,
        targetBodyId: plan.targetBodyId,
        scheduledT: plan.startTick,
        arrivalT: plan.arriveTick,
        dvPrograde: plan.totalDv,
        fuelCost: Math.round(plan.totalDv * 10),
      }).then(res => {
        if (!res.ok) {
          rejections.push(humanizeMpError(res.code, res.error, 'transfer'));
          setRepairMsg(`${rejections.length} repair transfer${rejections.length === 1 ? '' : 's'} rejected — ${rejections[0]}`);
        }
      });
    }
    if (sent > 0) {
      setRepairMsg(`${sent} ship${sent === 1 ? '' : 's'} dispatched to shipyards for repair`);
    } else {
      setRepairMsg(noYard > 0
        ? 'No friendly shipyard to send them to — build a station shipyard first'
        : 'No damaged ships needed dispatching');
    }
  };

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
    // The detonate dropdown hides when the selection has no detonator
    // hulls, but its state survives the selection change — drop it here
    // so a stale value can't ride along on a later SET ORDERS.
    const detonate = detonatorSelectedCount > 0 ? bulkDetonate : '';
    if (!bulkStance && !bulkRetreat && !detonate) {
      setOrdersNotice('Pick at least one order to apply');
      return;
    }
    mpActions.setShipOrders({
      shipIds: visibleSelected,
      ...(bulkStance ? { stance: bulkStance as 'attack' | 'defensive' | 'hold' } : {}),
      ...(bulkRetreat
        ? { retreatHpPct: bulkRetreat === 'off' ? null : (Number(bulkRetreat) as 25 | 50 | 75) }
        : {}),
      ...(detonate
        ? { detonateHpPct: detonate === 'off' ? null : (Number(detonate) as 25 | 50) }
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
    const { name, color } = factionOf(ownedBy);
    return (
      <span
        className="owner-badge"
        style={{ color, borderColor: color, background: hexToRgba(color, 0.12) }}
      >
        {name}
      </span>
    );
  };

  // Experience tier from veterancy rank (each confirmed kill = +1 rank).
  const rankTier = (rank: number): string => {
    if (rank >= 10) return 'Ace';
    if (rank >= 6) return 'Elite';
    if (rank >= 3) return 'Veteran';
    if (rank >= 1) return 'Regular';
    return 'Rookie';
  };

  // Experience + kills cell (replaces the fuel bar). Rank IS the total
  // confirmed-kill count, so kills = rank; the tier gives a quick
  // qualitative read alongside the raw number.
  const renderExperience = (ship: { rank?: number }) => {
    const rank = ship.rank ?? 0;
    return (
      <div className="fleet-xp">
        <span className={`fleet-xp__tier fleet-xp__tier--${rankTier(rank).toLowerCase()}`}>
          {rankTier(rank)}
        </span>
        <span className="fleet-xp__kills" title="Confirmed kills">
          {rank > 0 ? `${rank} ⚔` : '—'}
        </span>
      </div>
    );
  };

  // Current HP and effective max, resolved the same way for the HP bar and
  // the status badge's retreat check.
  //   - Server-authoritative hpMax when present (designer shield parts +
  //     tech, migration 0033); class-def fallback for SP/legacy ships.
  //   - Where the server hasn't sent hpMax, armor tech and per-kill rank
  //     still push real max above the base class hp, so a teched/veteran
  //     ship would read "108/100" with the fill bar overrunning its track.
  //     max(base, hp) clamps the denominator.
  const hpOf = (ship: { hp?: number; hpMax?: number; class: string }) => {
    const def = getShipClass(ship.class as ShipClassName);
    const hp = ship.hp ?? ship.hpMax ?? def.hp;
    const maxHp = ship.hpMax ?? Math.max(def.hp, hp);
    return { hp, maxHp, ratio: maxHp > 0 ? Math.min(1, hp / maxHp) : 0 };
  };

  const hpRatioOf = (ship: { hp?: number; hpMax?: number; class: string }) => hpOf(ship).ratio;

  const renderHpBar = (ship: { hp?: number; hpMax?: number; class: string }) => {
    const { hp, maxHp, ratio } = hpOf(ship);
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
  // (DESIGN-identity-economy.md §1.1). Its column slot now holds the
  // ship's Experience (veterancy tier + confirmed kills).

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

    const status = shipStatus(
      ship, gameState.currentTick, hpRatioOf(ship),
      inCombatFor(ship),
      stationsAtBody(ship.orbit.parentBodyId, ship.ownedBy),
    );
    const statusBadge = (
      <span className={`status-badge status-badge--${status.cls}`} title={status.title}>
        {status.label}
      </span>
    );

    const eligible = bulkEligibleIds.has(ship.id);
    const checked = selectedIds.has(ship.id);
    return (
      <tr
        key={ship.id}
        className={isSelected ? 'selected' : ''}
        onClick={() => handleShipClick(ship.id)}
      >
        <td onClick={(e) => e.stopPropagation()} className="fleet-check-cell">
          {eligible ? (
            <label className="fleet-check" title="Add to bulk selection">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleSelected(ship.id)}
              />
              <span className="fleet-check__box" aria-hidden />
            </label>
          ) : (
            <span title="Not eligible (not player-owned, or already in transit/planned)" style={{ opacity: 0.25 }}>—</span>
          )}
        </td>
        <td>
          <div className="body-cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flexShrink: 0 }}>
              {(() => {
                // Icon uses the ship's REAL faction colours (the same
                // lookup the map does) so the two-tone livery matches
                // pixel-for-pixel — including the player's own ships,
                // which the map paints in the faction colour rather than
                // the fleet list's teal "You" highlight.
                const fac = gameState.factions.find(f => f.id === ship.ownedBy);
                const iconColor = fac?.color ?? factionOf(ship.ownedBy).color;
                const iconColor2 = (fac?.color && (fac.color2 || deriveSecondary(fac.color)))
                  || factionOf(ship.ownedBy).color2;
                return (
                  <ShipIcon
                    shipClass={ship.class as ShipClassName}
                    variant={ship.iconVariant}
                    color={iconColor}
                    color2={iconColor2}
                    size={20}
                  />
                );
              })()}
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
            <span className="col-muted">
              {bodyById.get(ship.orbit.parentBodyId)?.name ?? ship.orbit.parentBodyId}
            </span>
          )}
        </td>
        <td>{renderHpBar(ship)}</td>
        <td>{renderExperience(ship)}</td>
      </tr>
    );
  };

  const tableHead = (locationLabel: string) => (
    <thead>
      <tr>
        <th style={{ width: 40 }}></th>
        <th>Ship</th>
        <th>Owner</th>
        <th>Status</th>
        <th>{locationLabel}</th>
        <th>HP</th>
        <th>Experience</th>
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
        {/* One-shot repair dispatch (MP only): every damaged parked hull
            that ISN'T already sitting at a friendly station gets a
            transfer to its nearest shipyard body — same destination rule
            the auto-retreat uses. */}
        {mpActions && (
          <button
            className="filter-chip"
            style={{ marginRight: 8 }}
            onClick={sendDamagedToYards}
            disabled={damagedAway.length === 0}
            title={damagedAway.length === 0
              ? 'No damaged ships away from a friendly station'
              : `Send ${damagedAway.length} damaged ship${damagedAway.length === 1 ? '' : 's'} to the nearest friendly shipyard for repair`}
          >
            ⛨ REPAIR AT YARD{damagedAway.length > 0 ? ` (${damagedAway.length})` : ''}
          </button>
        )}
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
        {([
          ['player', 'Mine'],
          ['enemy', 'Enemies'],
          ['all', 'All'],
        ] as [Filter, string][]).map(([f, label]) => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="fleet-search">
        <span className="fleet-search__icon" aria-hidden>⌕</span>
        <input
          className="fleet-search__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ships, worlds, systems, owners…"
          aria-label="Search fleet"
        />
        {query && (
          <button
            className="fleet-search__clear"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            title="Clear search"
          >✕</button>
        )}
      </div>

      {repairMsg && (
        <div className="fleet-bulk-bar__error" style={{ margin: '0 16px 8px' }}>
          {repairMsg}
        </div>
      )}

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
              {/* Only when something in the selection can actually blow
                  up — otherwise this is a live control that no-ops on
                  every ship it would touch. */}
              {detonatorSelectedCount > 0 && (
                <select
                  className="fleet-bulk-bar__select"
                  value={bulkDetonate}
                  onChange={(e) => setBulkDetonate(e.target.value)}
                  title="Auto-detonate below X% HP: deals damage to every ship in this orbit, friend or foe; this ship is destroyed."
                >
                  <option value="">Detonate: keep</option>
                  <option value="off">Detonate: off</option>
                  <option value="25">Detonate below 25% HP</option>
                  <option value="50">Detonate below 50% HP</option>
                </select>
              )}
              <button
                className="fleet-bulk-bar__btn fleet-bulk-bar__btn--primary"
                onClick={issueBulkOrders}
                disabled={!bulkStance && !bulkRetreat
                  && !(bulkDetonate && detonatorSelectedCount > 0)}
              >
                SET ORDERS
              </button>
            </div>
          )}
          {mpActions && bulkDetonate && bulkDetonate !== 'off' && detonatorSelectedCount > 0 && (
            <div className="fleet-bulk-bar__error" style={{ color: '#ff9e7a' }}>
              Auto-detonate below {bulkDetonate}% HP: deals damage to every ship
              in this orbit, friend or foe; the detonating ship is destroyed.
              {detonatorSelectedCount < visibleSelected.length
                && ` Applies to ${detonatorSelectedCount} of ${visibleSelected.length} selected — the rest carry no detonator.`}
            </div>
          )}
          {ordersNotice && <div className="fleet-bulk-bar__error">{ordersNotice}</div>}
        </div>
      )}

      <div className="overview-panel__body">
        {ships.length === 0 ? (
          <div className="overview-empty">
            {query.trim()
              ? `No ships match “${query.trim()}”.`
              : filter === 'enemy'
                ? 'No rival ships are visible to you right now.'
                : 'No ships match the current filter.'}
          </div>
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

            {systems.map(system => {
              const isCollapsed = collapsedSystems.has(system.rootId);
              return (
                <div className="fleet-system" key={system.rootId}>
                  <button
                    className="fleet-system__header"
                    onClick={() => toggleSystem(system.rootId)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand system' : 'Collapse system'}
                  >
                    <span className={`fleet-system__caret${isCollapsed ? ' fleet-system__caret--collapsed' : ''}`} aria-hidden>▾</span>
                    <span className="fleet-system__name">{system.label}</span>
                    <span className="fleet-system__meta">
                      {system.bodies.length} world{system.bodies.length === 1 ? '' : 's'} · {system.shipCount} ship{system.shipCount === 1 ? '' : 's'}
                    </span>
                  </button>

                  {!isCollapsed && system.bodies.map(([bodyId, bodyShips]) => {
                    const body = bodyById.get(bodyId);
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
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
