// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { loadoutSummary, countPart } from '../game/shipParts';
import { effectiveShipMaxHp } from '../game/combat';
import type { Ship, Captain, TargetPriorityKey } from '../types';
import { TARGET_PRIORITY_DEFAULT } from '../types';
import { TargetPriorityCards } from './TargetPriorityCards';
import { rankTier, traitSummary, AVATAR_IDS } from '../game/captains';
import { CaptainAvatar } from './CaptainAvatar';
import { EditableName } from './EditableName';
import { deriveSecondary } from '../game/colorUtils';
import { makeSystemRootOf, systemLabel as systemLabelOf, shipStatus, makeHostilesAtBody, makeArmedHostilesAtBody, makeStationsAtBody, isArmed } from '../game/systemGrouping';
import { nearestShipyardBodyId, isDamagedShip } from '../game/repair';
import { ShipIcon } from './ShipIcons';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { apiFetch } from '../multiplayer/api';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { logUiEvent } from '../multiplayer/telemetry';
import { openShipDesigner } from './ShipDesigner';
import './OverviewPanel.css';
import './FleetPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy' | 'captains';

// System grouping and ship status now live in game/systemGrouping so the
// Outliner renders identical headers and identical status chips. They were
// duplicated here, and the copies had already diverged.

/**
 * What the fleet costs to keep, per tick, and where the bill comes from.
 *
 * This exists because of a measured problem, not a hunch: 100 simulated
 * games ended with a bankrupt empire in EVERY one, and 58% of factions
 * hit zero credits. Upkeep is the quiet thing that decides those games,
 * and until now the only place a player saw it was a single net number
 * in the top bar — by which point they had already built the ships.
 *
 * Every figure is server-computed (worker/state.js). The rates are
 * editable in the admin Editor, so a client-side copy of the table would
 * quote a price the tick no longer charges.
 */
const FleetUpkeepLine: React.FC = () => {
  const { gameState } = useGameContext();
  const [open, setOpen] = useState(false);
  const up = gameState.fleetUpkeep;
  const arrears = gameState.fleetArrears;
  if (!up) return null;

  const inDebt = !!arrears && (arrears.credits > 0 || arrears.ore > 0);
  const rows = up.byClass ?? [];
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
  // The senate can scale the whole bill; say so rather than leaving the
  // player to wonder why the arithmetic does not add up.
  const mult = up.multiplier ?? 1;

  return (
    <div className="fleet-header__counts" style={{ display: 'block', marginTop: 2 }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Per-tick fleet maintenance. Click for the breakdown by ship class."
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          font: 'inherit', color: inDebt ? '#ff6b6b' : 'inherit', textAlign: 'left',
        }}
      >
        <span aria-hidden>{inDebt ? '💸' : '🛠'}</span>{' '}
        Upkeep {fmt(up.credits)}C{up.ore > 0 ? ` · ${fmt(up.ore)}M` : ''} / tick
        {mult !== 1 && <span style={{ opacity: 0.75 }}> (senate ×{mult})</span>}
        {rows.length > 0 && <span style={{ opacity: 0.6 }}> {open ? '▾' : '▸'}</span>}
      </button>

      {inDebt && (
        <div style={{ color: '#ff6b6b', fontSize: 11, marginTop: 1 }}>
          Unpaid: {fmt(arrears!.credits)}C
          {arrears!.ore > 0 ? ` · ${fmt(arrears!.ore)}M` : ''} — ships fight at{' '}
          {Math.round((up.arrearsDamageMult ?? 0.75) * 100)}% damage until it clears.
        </div>
      )}

      {open && rows.length > 0 && (
        <table style={{ fontSize: 11, marginTop: 4, borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {rows.map(r => (
              <tr key={r.shipClass}>
                <td style={{ padding: '1px 6px 1px 0', textTransform: 'capitalize' }}>
                  {r.count}× {r.shipClass}
                </td>
                <td style={{ padding: '1px 6px 1px 0', opacity: 0.65 }}>
                  @ {fmt(r.creditsEach)}C{r.oreEach > 0 ? `+${fmt(r.oreEach)}M` : ''}
                </td>
                <td style={{ padding: '1px 0', textAlign: 'right' }}>
                  {fmt(r.credits)}C{r.ore > 0 ? ` · ${fmt(r.ore)}M` : ''}
                </td>
              </tr>
            ))}
            {/* Colony hulls are free; showing a 0 row for them is noise,
                so the server omits any class with no cost. */}
          </tbody>
        </table>
      )}
    </div>
  );
};

export const FleetPanel: React.FC<FleetPanelProps> = ({ onClose }) => {
  const {
    gameState, selectShip, focusBody, uiState,
    launchTorchTransfer, renameShip,
    toggleShipSelection, setShipSelection, clearShipSelection,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  // Default to the "All" tab in multiplayer (per request); single-player
  // keeps its historical "Mine" default. mpActions is non-null ONLY in
  // MP (null in SP, where every mpActions branch below is already dead),
  // so gating on it changes nothing about the SP code path.
  const [filter, setFilter] = useState<Filter>(mpActions ? 'all' : 'player');
  // Funnel telemetry: menu opened (deduped per page load in logUiEvent).
  useEffect(() => { logUiEvent(mpActions?.gameId, 'fleet-menu'); }, [mpActions?.gameId]);
  // Captain Bank state (spec §5.3): inline rename target + busy/error.
  const [capEditId, setCapEditId] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState(false);
  const [capMsg, setCapMsg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsedSystems, setCollapsedSystems] = useState<Set<string>>(new Set());
  // Bulk-select set: ship ids the player has checked for a bulk
  // maneuver action. Only player-owned ships can join the set.
  //
  // Lives in gameContext (uiState.selectedShipIds) rather than local
  // state so the map's shift-click group and these checkboxes are ONE
  // list — tick a box here and the ship rings on the map; shift-click
  // three hulls out there and this action bar is already armed.
  const selectedIds = useMemo(
    () => new Set(uiState.selectedShipIds ?? []),
    [uiState.selectedShipIds],
  );
  const setSelectedIds = useCallback((next: Set<string>) => {
    setShipSelection(Array.from(next));
  }, [setShipSelection]);
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Bulk standing orders (MP only). '' = leave that field unchanged;
  // 'off' clears a threshold. Applied to every selected ship in one
  // PATCH /ships/orders call.
  const [bulkStance, setBulkStance] = useState<string>('');
  const [bulkRetreat, setBulkRetreat] = useState<string>('');
  const [bulkDetonate, setBulkDetonate] = useState<string>('');
  // Bulk target priority (migration 0064). '' = keep, 'auto' = reset to
  // peer targeting, 'custom' = apply bulkPriorityOrder (staged via the
  // drag cards below the row).
  const [bulkTargeting, setBulkTargeting] = useState<'' | 'auto' | 'custom'>('');
  const [bulkPriorityOrder, setBulkPriorityOrder] =
    useState<TargetPriorityKey[]>(TARGET_PRIORITY_DEFAULT);
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
  // Peace partners (NAP / defense-pact / intel-share / alliance) never
  // count as hostile — the server never fires between them, so the status
  // must not read "In Combat" for a peace partner sharing your orbit.
  const friendlyFactions = useMemo(
    () => new Set([...(gameState.alliedFactionIds ?? []), ...(gameState.peaceFactionIds ?? [])]),
    [gameState.alliedFactionIds, gameState.peaceFactionIds],
  );
  const hostilesAtBody = useMemo(
    () => makeHostilesAtBody(gameState.ships, gameState.settlements, friendlyFactions),
    [gameState.ships, gameState.settlements, friendlyFactions],
  );
  // Stricter combat test for non-combatants — an armed hostile SHIP is
  // actually here. A freighter parked near an enemy city or a passing
  // hauler is NOT "in combat".
  const armedHostilesAtBody = useMemo(
    () => makeArmedHostilesAtBody(gameState.ships, friendlyFactions),
    [gameState.ships, friendlyFactions],
  );
  // Friendly-station presence per body — feeds the "Repairing" status
  // (station repair = +2 HP/tick, worker maintenance pass).
  const stationsAtBody = useMemo(
    () => makeStationsAtBody(gameState.settlements),
    [gameState.settlements],
  );
  // A NON-COMBATANT (unarmed) ship is only "In Combat" when an armed
  // hostile SHIP is on it. An ARMED ship — any class, including an armed
  // freighter — is "In Combat" whenever any hostile shares the body
  // (enemy ship OR a settlement it's bombarding). Keying on isArmed, not
  // class, is what fixes an armed freighter reading "not in combat" while
  // it's actively fighting.
  const inCombatFor = (s: typeof gameState.ships[number]) =>
    (isArmed(s) ? hostilesAtBody : armedHostilesAtBody)(s.orbit.parentBodyId, s.ownedBy);

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
    const fileUnder = (bodyId: string, s: typeof orbiting[number]) => {
      const root = systemRootOf(bodyId);
      let bodies = bySystem.get(root);
      if (!bodies) { bodies = new Map(); bySystem.set(root, bodies); }
      const list = bodies.get(bodyId) || [];
      list.push(s);
      bodies.set(bodyId, list);
    };
    for (const s of orbiting) fileUnder(s.orbit.parentBodyId, s);
    // Transit ships file under their DESTINATION body — the card carries
    // the "→ dest · T-n" line, so it reads as "inbound to this world"
    // rather than living in a separate top-level table.
    for (const s of inTransit) {
      fileUnder(s.transit?.currentTransfer?.targetBodyId ?? s.orbit.parentBodyId, s);
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
  }, [orbiting, inTransit, bodyById, systemRootOf]);

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

  // Delegates to the context toggle rather than reading `selectedIds`
  // and writing a new Set: the shared state is the source of truth, and
  // going through it keeps this correct if two toggles land in the same
  // render (the old local version used a function updater for exactly
  // that reason, which the shared setter can't express).
  const toggleSelected = (shipId: string) => toggleShipSelection(shipId);

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
        replace: true,
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
          replace: true,
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
    clearShipSelection();
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
    if (!bulkStance && !bulkRetreat && !detonate && !bulkTargeting) {
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
      ...(bulkTargeting
        ? { targetPriority: bulkTargeting === 'auto' ? null : bulkPriorityOrder }
        : {}),
    }).then(res => {
      if (res.ok) {
        setOrdersNotice(`Orders set on ${visibleSelected.length} ship${visibleSelected.length === 1 ? '' : 's'}`);
        setBulkStance('');
        setBulkRetreat('');
        setBulkDetonate('');
        setBulkTargeting('');
        setBulkPriorityOrder(TARGET_PRIORITY_DEFAULT);
      } else {
        setOrdersNotice(humanizeMpError(res.code, res.error, 'orders'));
      }
    });
  };

  // Captain cell (spec §5.2) — the Experience column becomes the PERSON.
  // Rank/kills ride along under the name (rank now lives on the captain;
  // the server COALESCEs it onto ship.rank for compat). Rival identities
  // are gated behind intel.loadouts server-side — captainName arrives
  // null, so rivals show exactly the old tier+kills cell.
  const renderExperience = (ship: Ship) => {
    const rank = ship.rank ?? 0;
    const tierBits = (
      <>
        <span className={`fleet-xp__tier fleet-xp__tier--${rankTier(rank).toLowerCase()}`}>
          {rankTier(rank)}
        </span>
        <span className="fleet-xp__kills" title="Confirmed kills">
          {rank > 0 ? `${rank} ⚔` : '—'}
        </span>
      </>
    );
    if (!ship.captainName) {
      // Own ship with no captain (pre-backfill window) → discovery path
      // into the bank; rival without Deep Scan → tier+kills only.
      if (ship.ownedBy === 'player' && mpActions) {
        return (
          <div className="fleet-xp">
            {tierBits}
            <button
              className="fleet-mini-btn"
              style={{ fontSize: 8, marginLeft: 4 }}
              onClick={(e) => { e.stopPropagation(); setFilter('captains'); }}
              title="No captain assigned — open the captain bank"
            >UNASSIGNED</button>
          </div>
        );
      }
      return <div className="fleet-xp">{tierBits}</div>;
    }
    return (
      <div
        className="fleet-xp"
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: mpActions && ship.ownedBy === 'player' ? 'pointer' : undefined }}
        onClick={mpActions && ship.ownedBy === 'player'
          ? (e) => { e.stopPropagation(); setFilter('captains'); }
          : undefined}
        title={traitSummary(ship.captainTraits) || undefined}
      >
        <CaptainAvatar avatarId={ship.captainAvatar} size={20} />
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, minWidth: 0 }}>
          <span style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
            {ship.captainName}
          </span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{tierBits}</span>
        </div>
      </div>
    );
  };

  // ===== Captain Bank (spec §5.3) =====================================
  // Roster + memorial + create-ahead + assign/reassign. Mutations post to
  // the server and settle on the next /state poll (~1.5s); capBusy guards
  // double-submits, capMsg surfaces rejections.
  const renderCaptainBank = () => {
    const roster = gameState.captains ?? [];
    const active = roster.filter(c => c.status === 'active');
    const lost = roster.filter(c => c.status === 'lost');
    const myShips = gameState.ships.filter(s => s.ownedBy === 'player');
    // Resolve a posting to a NAME, never a raw id. Client ship ids keep the
    // "<gameId>:" prefix while other id spaces don't, so match exactly
    // first, then on the unprefixed tail; if it still misses (ship not in
    // view / id form drifted) say something human instead of leaking
    // "s10_0_u8za4" into the UI, which is what this fix was for.
    const tail = (id: string) => id.slice(id.indexOf(':') + 1);
    const shipName = (id: string | null): string | null => {
      if (!id) return null;
      const hit = myShips.find(s => s.id === id) ?? myShips.find(s => tail(s.id) === tail(id));
      return hit?.name ?? 'on assignment';
    };

    const doCap = (p: Promise<{ ok: boolean; error?: string }>) => {
      setCapBusy(true);
      p.then(res => { setCapBusy(false); setCapMsg(res.ok ? null : (res.error ?? 'Rejected')); });
    };

    const row = (c: Captain) => {
      const editing = capEditId === c.id;
      const aboard = shipName(c.shipId);
      return (
        <div key={c.id} className={`fleet-capcard${c.status === 'lost' ? ' fleet-capcard--lost' : ''}`}>
          {/* avatar — click cycles the portrait set (BuildPanel icon precedent) */}
          <button
            className="fleet-capcard__avatarbtn"
            onClick={() => {
              if (!mpActions || c.status === 'lost') return;
              const cur = AVATAR_IDS.indexOf((c.avatarId ?? 'a1') as typeof AVATAR_IDS[number]);
              doCap(mpActions.updateCaptain(c.id, { avatarId: AVATAR_IDS[(cur + 1) % AVATAR_IDS.length] }));
            }}
            disabled={capBusy || c.status === 'lost'}
            title={c.status === 'lost' ? undefined : 'Change portrait'}
          >
            <CaptainAvatar avatarId={c.avatarId} size={30} />
          </button>
          <div className="fleet-capcard__main">
            {editing ? (
              <input
                className="fleet-capcard__input"
                autoFocus
                defaultValue={c.name}
                maxLength={32}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim();
                    setCapEditId(null);
                    if (v && v !== c.name && mpActions) doCap(mpActions.updateCaptain(c.id, { name: v }));
                  }
                  if (e.key === 'Escape') setCapEditId(null);
                }}
                onBlur={() => setCapEditId(null)}
              />
            ) : (
              <div className="fleet-capcard__line1">
                <span className="fleet-capcard__name">{c.name}</span>
                {c.status === 'active' && mpActions && (
                  <button
                    className="fleet-capcard__rename"
                    onClick={() => setCapEditId(c.id)}
                    title="Rename"
                  >✎</button>
                )}
                <span className={`fleet-xp__tier fleet-xp__tier--${rankTier(c.rank).toLowerCase()}`}>
                  {rankTier(c.rank)}
                </span>
                <span className="fleet-xp__kills">{c.rank > 0 ? `${c.rank} ⚔` : ''}</span>
              </div>
            )}
            <div className="fleet-capcard__traits">
              {traitSummary(c.traits) || 'No notable traits'}
              {c.bio ? ` · ${c.bio}` : ''}
            </div>
          </div>
          {c.status === 'lost' ? (
            <span className="fleet-capcard__lostmark">
              ✝ LOST{c.lostAtTick != null ? ` T+${c.lostAtTick}` : ''}
            </span>
          ) : (
            <div className="fleet-capcard__rail">
              {aboard && (
                <span className="fleet-capcard__posting" title="Current posting">
                  ⚓ {aboard}
                </span>
              )}
              {/* Distinguishes "held back on purpose" from "in the bank
                  and awaiting a posting" — only the latter gets picked up
                  by the server's auto-assign pass (migration 0051). */}
              {!aboard && c.benchedAtTick != null && (
                <span className="fleet-capcard__reserve"
                      title="Held in reserve by you — the auto-assign pass will leave them alone">
                  ⏸ RESERVE
                </span>
              )}
              {mpActions && (
                <select
                  className="fleet-capcard__assign"
                  value=""
                  disabled={capBusy}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__bench') doCap(mpActions.assignCaptain(c.id, null));
                    else if (v) doCap(mpActions.assignCaptain(c.id, v));
                  }}
                  title="Assign this captain to a ship (any sitting captain returns to the bank)"
                >
                  <option value="">{aboard ? 'REASSIGN…' : 'ASSIGN…'}</option>
                  {aboard && <option value="__bench">→ To the bank</option>}
                  {myShips.filter(s => s.id !== c.shipId).map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.captainName ? ` (swap: ${s.captainName})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="fleet-capbank">
        <div className="fleet-capbank__head">
          <span className="fleet-capbank__title">
            Captain Bank <span className="fleet-capbank__title-sub">· {active.length} serving/{lost.length ? ` ${lost.length} lost` : ' none lost'}</span>
          </span>
          {mpActions && (
            <button
              className="filter-chip"
              disabled={capBusy}
              onClick={() => doCap(mpActions.createCaptain())}
              title="Recruit a fresh captain into the bank (50 metal + 100 credits). Ships without captains fly uncommanded — no trait, no rank growth."
            >+ RECRUIT · 50M+100C</button>
          )}
        </div>
        {capMsg && (
          <div className="fleet-notice" onClick={() => setCapMsg(null)}>
            ⚠ {capMsg}
          </div>
        )}
        {active.length === 0 && (
          <div className="overview-empty">No captains yet — they generate automatically as ships launch.</div>
        )}
        {active.map(row)}
        {lost.length > 0 && (
          <>
            <div className="fleet-capbank__memorial">
              ✝ MEMORIAL — went down with the ship
            </div>
            {lost.map(row)}
          </>
        )}
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
  const hpOf = (ship: Ship) => {
    // Effective max includes veterancy + the owner's armor tech (see
    // effectiveShipMaxHp), matching the server's repair cap — so a teched
    // hull reads e.g. 53/53 at full instead of 53/40.
    const maxHp = effectiveShipMaxHp(ship, gameState.factionTech[ship.ownedBy]);
    const hp = ship.hp ?? maxHp;
    return { hp, maxHp, ratio: maxHp > 0 ? Math.min(1, hp / maxHp) : 0 };
  };

  const hpRatioOf = (ship: Ship) => hpOf(ship).ratio;

  // Card right rail: HP bar with the number beneath it (fixed-width
  // column, so the bar never squeezes the name/loadout text).
  const renderHpRail = (ship: Ship) => {
    const { hp, maxHp, ratio } = hpOf(ship);
    const hpClass = ratio > 0.66 ? 'good' : ratio > 0.33 ? 'mid' : 'low';
    return (
      <div className="fleet-card__rail">
        <div className="fleet-card__hptrack">
          <div
            className={`status-bar__inner status-bar__inner--hp-${hpClass}`}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
        <span className="fleet-card__hptext">{Math.round(hp)}/{Math.round(maxHp)}</span>
      </div>
    );
  };

  // renderFuelBar removed — fuel left the economy
  // (DESIGN-identity-economy.md §1.1). Its column slot now holds the
  // ship's Experience (veterancy tier + confirmed kills).

  // ===== Server fleets (DESIGN-fleets.md) — MP only =====
  // Client fleet ids are stripped ('fl_x'); API paths need the full
  // game-namespaced id back.
  const fullFleetId = (id: string) => `${mpActions?.gameId}:${id}`;
  const myFleets = useMemo(
    () => (gameState.fleets ?? []).filter(f => f.ownedBy === 'player'),
    [gameState.fleets],
  );
  const [fleetErr, setFleetErr] = useState<string | null>(null);
  const fleetApi = async (method: string, path: string, body?: unknown) => {
    if (!mpActions) return;
    setFleetErr(null);
    const res = await apiFetch(`/api/games/${mpActions.gameId}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      setFleetErr(res.error?.code === 'fleet_leaderless'
        ? 'Fleet is leaderless — promote a captain first.'
        : (res.error?.message ?? 'fleet action failed'));
    }
  };
  const formFleetFromSelection = () => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) return;
    const members = ids
      .map(id => gameState.ships.find(sh => sh.id === id))
      .filter((sh): sh is NonNullable<typeof sh> => !!sh);
    // Flag defaults to the highest-rank captain among the selection.
    const flag = members.reduce((best, sh) => ((sh.rank ?? 0) > (best.rank ?? 0) ? sh : best), members[0]);
    void fleetApi('POST', '/fleets', { ship_ids: ids, flag_ship_id: flag.id });
    setSelectedIds(new Set());
  };
  const renderShipCard = (ship: typeof ships[0]) => {
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
    // Refit propagation (§2): this hull refits (and pays the fee) at its
    // next friendly yard — surfaced so a "why is my loadout old" ship is
    // self-explanatory.
    const refitBadge = ship.refitPendingDesignId ? (
      <span
        className="status-badge"
        style={{ color: '#9fdcff', borderColor: 'rgba(127,212,255,0.5)', flex: '0 0 auto' }}
        title="Refit pending — this ship updates to its latest template (and pays the refit fee) when it next parks at a friendly yard."
      >⟳ Refit pending</span>
    ) : null;

    const eligible = bulkEligibleIds.has(ship.id);
    const checked = selectedIds.has(ship.id);

    // Icon uses the ship's REAL faction colours (the same lookup the map
    // does) so the two-tone livery matches pixel-for-pixel — including
    // the player's own ships, which the map paints in the faction colour
    // rather than the fleet list's teal "You" highlight.
    const owner = factionOf(ship.ownedBy);
    const fac = gameState.factions.find(f => f.id === ship.ownedBy);
    const iconColor = fac?.color ?? owner.color;
    const iconColor2 = (fac?.color && (fac.color2 || deriveSecondary(fac.color))) || owner.color2;

    // Designer loadout replaces the redundant "· corvette" class echo;
    // null (SP / colony / no parts field) falls back to the class name.
    const loadout = loadoutSummary(ship.parts);
    // Captain line only when there's something to say: a named captain,
    // confirmed kills, or the player-owned UNASSIGNED discovery path.
    const showCaptainLine = !!ship.captainName || (ship.rank ?? 0) > 0
      || (ship.ownedBy === 'player' && !!mpActions);

    return (
      <div
        key={ship.id}
        className={`fleet-card${isSelected ? ' fleet-card--selected' : ''}`}
        onClick={() => handleShipClick(ship.id)}
      >
        <div className="fleet-card__lead">
          {eligible ? (
            <label
              className="fleet-check"
              title="Add to bulk selection"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleSelected(ship.id)}
              />
              <span className="fleet-check__box" aria-hidden />
            </label>
          ) : (
            <span className="fleet-card__nocheck" title="Not eligible (not player-owned, or already in transit/planned)">—</span>
          )}
          <ShipIcon
            shipClass={ship.class as ShipClassName}
            variant={ship.iconVariant}
            color={iconColor}
            color2={iconColor2}
            size={20}
            // Sub-40px sizes render only the big-silhouette reads
            // (shield bubble + engine plume) — tanky/fast at a glance.
            parts={ship.parts}
          />
        </div>

        <div className="fleet-card__main">
          <div className="fleet-card__line1">
            {/* Rename in place (fartmaster, playtest) — the same
                EditableName the ShipPanel header uses, so the pencil,
                keyboard handling and optimistic-then-reconcile
                behaviour are identical wherever you rename. Rivals'
                hulls are read-only. stopPropagation keeps a click on
                the pencil from also selecting/focusing the ship. */}
            <span className="fleet-card__name" onClick={e => e.stopPropagation()}>
              <EditableName
                value={ship.name}
                readOnly={ship.ownedBy !== 'player' || !mpActions}
                ariaLabel={`Rename ${ship.name}`}
                onSave={async (next) => {
                  renameShip(ship.id, next);
                  if (mpActions) {
                    const res = await mpActions.renameShip(ship.id, next);
                    if (!res.ok) {
                      throw new Error(humanizeMpError(res.code, res.error, 'rename'));
                    }
                  }
                }}
              />
            </span>
            {statusBadge}
            {refitBadge}
          </div>
          <div className="fleet-card__line2">
            {ship.ownedBy !== 'player' && (
              <>
                <span className="fleet-card__owner">
                  <span className="fleet-card__owner-dot" style={{ background: owner.color }} aria-hidden />
                  {owner.name}
                </span>
                <span className="fleet-card__sep" aria-hidden>·</span>
              </>
            )}
            <span>{def.displayName}</span>
            {loadout && (
              <>
                <span className="fleet-card__sep" aria-hidden>·</span>
                <span className="fleet-card__loadout" title="Fitted parts">{loadout}</span>
              </>
            )}
            <span className="fleet-card__sep" aria-hidden>·</span>
            {transit && target ? (
              <span className="fleet-card__dest">→ {target.name} · T-{Math.round(eta ?? 0)}</span>
            ) : (
              <span>{bodyById.get(ship.orbit.parentBodyId)?.name ?? ship.orbit.parentBodyId}</span>
            )}
          </div>
          {showCaptainLine && (
            <div className="fleet-card__line3">{renderExperience(ship)}</div>
          )}
        </div>

        {renderHpRail(ship)}
      </div>
    );
  };

  return (
    <div className="overview-panel fleet-panel">
      {/* Compact header: title + counts line, icon-labeled actions that
          wrap on narrow screens (labels drop at ≤640px, icons stay). */}
      <div className="fleet-header">
        <div className="fleet-header__title">
          <div className="fleet-header__name">Fleet</div>
          <div className="fleet-header__counts">
            <span>{ships.length} ships · {orbiting.length} orbiting</span>
            {inTransit.length > 0 && (
              <span className="fleet-header__transit-chip">In transit: {inTransit.length}</span>
            )}
          </div>
          <FleetUpkeepLine />
        </div>
        {/* One-shot repair dispatch (MP only): every damaged parked hull
            that ISN'T already sitting at a friendly station gets a
            transfer to its nearest shipyard body — same destination rule
            the auto-retreat uses. */}
        {mpActions && (
          <button
            className="fleet-hbtn"
            onClick={sendDamagedToYards}
            disabled={damagedAway.length === 0}
            title={damagedAway.length === 0
              ? 'No damaged ships away from a friendly station'
              : `Send ${damagedAway.length} damaged ship${damagedAway.length === 1 ? '' : 's'} to the nearest friendly shipyard for repair`}
          >
            <span className="fleet-hbtn__icon" aria-hidden>⛨</span>
            <span className="fleet-hbtn__label">Repair at yard</span>
            {damagedAway.length > 0 && <span>({damagedAway.length})</span>}
          </button>
        )}
        {/* Ship designer entry point (MP only — the designer is part of
            the identity-economy release and the SP sim is frozen). */}
        {mpActions && (
          <button
            className="fleet-hbtn"
            onClick={() => openShipDesigner()}
            title="Design ship loadouts — weapons, shields, engines, detonators. BUILD uses each class's active design."
          >
            <span className="fleet-hbtn__icon" aria-hidden>⚙</span>
            <span className="fleet-hbtn__label">Ship designer</span>
          </button>
        )}
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="fleet-scroll">
        {/* Sticky controls row: filter chips + search pin to the top of
            the scroll area. */}
        <div className="fleet-controls">
          <div className="fleet-controls__chips">
            {([
              ['player', 'Mine'],
              ['enemy', 'Enemies'],
              ['all', 'All'],
              // Captain Bank (spec §5.3) — MP only; captains don't exist in SP.
              ...(mpActions ? ([['captains', '★ Captains']] as [Filter, string][]) : []),
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
        </div>

        <div className="fleet-scroll__inner">
          {repairMsg && (
            <div className="fleet-notice">{repairMsg}</div>
          )}

          {filter === 'captains' ? renderCaptainBank() : ships.length === 0 ? (
            <div className="overview-empty">
              {query.trim()
                ? `No ships match “${query.trim()}”.`
                : filter === 'enemy'
                  ? 'No rival ships are visible to you right now.'
                  : 'No ships match the current filter.'}
            </div>
          ) : (
            <>
            {mpActions && myFleets.length > 0 && (
              <div className="fleet-group">
                <div className="fleet-group__title">Fleets</div>
                {fleetErr && (
                  <div className="fleet-notice">{fleetErr}</div>
                )}
                {myFleets.map(f => {
                  const full = fullFleetId(f.id);
                  return (
                    (() => {
                      // Current orders, derived from the members: when every
                      // member agrees, that IS the fleet's setting — light it
                      // up so the buttons read as state, not just verbs.
                      // Mixed (mid-poll or hand-edited ships) shows nothing
                      // active rather than guessing.
                      const members = f.shipIds
                        .map(id => gameState.ships.find(sh => sh.id === id))
                        .filter((sh): sh is Ship => !!sh);
                      const agree = <T,>(get: (s: Ship) => T): T | null => {
                        if (members.length === 0) return null;
                        const v = get(members[0]);
                        return members.every(sh => get(sh) === v) ? v : null;
                      };
                      const curStance = agree(sh => sh.stance ?? 'attack');
                      const curRetreat = agree(sh => sh.retreatHpPct ?? null);
                      return (
                    <div key={f.id} className={`fleet-fleetcard${f.leaderless ? ' fleet-fleetcard--leaderless' : ''}`}>
                      <div className="fleet-fleetcard__line1">
                        <span className="fleet-fleetcard__name">{f.name}</span>
                        <span className="fleet-fleetcard__count">{f.shipIds.length} ships</span>
                        {f.leaderless ? (
                          <span className="fleet-fleetcard__leaderless">LEADERLESS</span>
                        ) : (
                          <span className="fleet-fleetcard__flag">
                            ★ {f.flagCaptainName}{f.flagCaptainRank ? ` · R${f.flagCaptainRank}` : ''}
                            {(f.flagCaptainTraits ?? []).length > 0 && (
                              <span className="fleet-fleetcard__trait">
                                {(f.flagCaptainTraits ?? []).join(' · ')}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="fleet-fleetcard__controls">
                        <button className="fleet-chipbtn" title="Check every member into the bulk-action list — then move or order them together"
                                onClick={() => setSelectedIds(new Set(f.shipIds))}>Select all</button>
                        <button className="fleet-chipbtn"
                                title="Dissolve the fleet — members keep their current orders"
                                onClick={() => {
                                  if (window.confirm(`Disband ${f.name}? Members keep their current orders.`)) {
                                    void fleetApi('DELETE', `/fleets/${encodeURIComponent(full)}`);
                                  }
                                }}>Disband</button>
                        {(['attack', 'defensive', 'hold'] as const).map(st => (
                          // Chips read as STATE: the stance every member
                          // currently holds is lit.
                          <button key={st}
                                  className={`fleet-chipbtn${curStance === st ? ' fleet-chipbtn--active' : ''}`}
                                  disabled={!!f.leaderless}
                                  aria-pressed={curStance === st}
                                  onClick={() => void fleetApi('PATCH', `/fleets/${encodeURIComponent(full)}/orders`, { stance: st })}>
                            {st === 'attack' ? 'Attack' : st === 'defensive' ? 'Defend' : 'Hold'}
                          </button>
                        ))}
                        <select className="fleet-chipbtn"
                                disabled={!!f.leaderless}
                                value={curRetreat == null ? '' : String(curRetreat)}
                                onChange={e => {
                                  const v = e.target.value;
                                  void fleetApi('PATCH', `/fleets/${encodeURIComponent(full)}/orders`,
                                    { retreat_hp_pct: v === '' ? null : Number(v) });
                                }}>
                          <option value="">Retreat off</option>
                          <option value="25">Retreat 25%</option>
                          <option value="50">Retreat 50%</option>
                          <option value="75">Retreat 75%</option>
                        </select>
                        {/* Shown for HEALTHY fleets too, not just leaderless
                            ones — the server has never gated flag_ship_id on
                            leaderless (worker/fleets.js), so refusing to let
                            a player change a living fleet's flag was purely a
                            client-side restriction. Swapping the flag is how
                            you decide whose trait becomes the fleet aura. */}
                        {(() => {
                          const options = f.shipIds
                            .map(id => gameState.ships.find(x => x.id === id))
                            .filter((sh): sh is NonNullable<typeof sh> => !!sh?.captainName);
                          if (options.length === 0) return null;
                          return (
                            <select className={`fleet-chipbtn${f.leaderless ? ' fleet-chipbtn--promote' : ''}`} value=""
                                    title={f.leaderless
                                      ? 'Promote a member captain to flag'
                                      : 'Change which captain flies the flag (their trait becomes the fleet aura)'}
                                    onChange={e => {
                                      if (e.target.value) {
                                        void fleetApi('PATCH', `/fleets/${encodeURIComponent(full)}`, { flag_ship_id: e.target.value });
                                      }
                                    }}>
                              <option value="">{f.leaderless ? 'Promote captain…' : 'Change flag…'}</option>
                              {options.map(sh => (
                                <option key={sh.id} value={sh.id}>
                                  {sh.captainName} ({sh.name})
                                  {sh.captainName === f.flagCaptainName ? ' ★ current' : ''}
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                    </div>
                      );
                    })()
                  );
                })}
              </div>
            )}
            {systems.map(system => {
              const isCollapsed = collapsedSystems.has(system.rootId);
              const rootBody = bodyById.get(system.rootId);
              return (
                <div className="fleet-sys" key={system.rootId}>
                  <button
                    className="fleet-sys__header"
                    onClick={() => toggleSystem(system.rootId)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand system' : 'Collapse system'}
                  >
                    <span className={`fleet-sys__caret${isCollapsed ? ' fleet-sys__caret--collapsed' : ''}`} aria-hidden>▾</span>
                    <span className="fleet-sys__dot" style={{ background: rootBody?.color || '#888' }} aria-hidden />
                    <span className="fleet-sys__name">{system.label}</span>
                    <span className="fleet-sys__meta">
                      {system.bodies.length} world{system.bodies.length === 1 ? '' : 's'} · {system.shipCount} ship{system.shipCount === 1 ? '' : 's'}
                    </span>
                  </button>

                  {!isCollapsed && system.bodies.map(([bodyId, bodyShips]) => {
                    const body = bodyById.get(bodyId);
                    return (
                      <div key={bodyId}>
                        <button
                          className="fleet-bodyhead"
                          onClick={() => handleBodyClick(bodyId)}
                          title="Click to focus map"
                        >
                          <span className="fleet-bodyhead__dot" style={{ background: body?.color || '#888' }} aria-hidden />
                          {body?.name || bodyId}
                          <span className="fleet-bodyhead__count">· {bodyShips.length} ship{bodyShips.length === 1 ? '' : 's'}</span>
                        </button>
                        <div className="fleet-sys__cards">
                          {bodyShips.map(renderShipCard)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
          )}
        </div>

        {/* Sticky selection action bar — the ONE selection surface. As
            the LAST child of the scroll container with position:sticky
            bottom:0, it pins to the panel viewport's bottom edge
            whenever its natural spot is below the fold, so the actions
            ride alongside the checkboxes at every scroll position, and
            settle into normal flow at list end. */}
        {filter !== 'captains' && selectedIds.size > 0 && (
          <div className="fleet-actionbar">
            <div className="fleet-actionbar__row">
              <span className="fleet-actionbar__count">
                {visibleSelected.length} selected
                {visibleSelected.length !== selectedIds.size
                  && ` (${selectedIds.size - visibleSelected.length} ineligible)`}
              </span>
              {mpActions && selectedIds.size >= 2 && (
                <button
                  className="fleet-actionbar__btn fleet-actionbar__btn--primary"
                  onClick={formFleetFromSelection}
                >
                  ★ Form fleet
                </button>
              )}
              <span className="fleet-actionbar__spacer" />
              <button className="fleet-actionbar__btn" onClick={clearSelection}>Clear</button>
            </div>

            <div className="fleet-actionbar__row">
              <span className="fleet-actionbar__label">Transfer to</span>
              <select
                className="fleet-actionbar__select"
                value={bulkTarget}
                onChange={(e) => setBulkTarget(e.target.value)}
              >
                <option value="">Destination…</option>
                {transferTargets.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <button
                className="fleet-actionbar__btn fleet-actionbar__btn--primary"
                onClick={issueBulkTransfer}
                disabled={!bulkTarget}
              >
                Issue {visibleSelected.length} order{visibleSelected.length === 1 ? '' : 's'}
              </button>
            </div>
            {bulkError && <div className="fleet-actionbar__error">{bulkError}</div>}

            {mpActions && (
              <div className="fleet-actionbar__row">
                <span className="fleet-actionbar__label">Orders</span>
                <select
                  className="fleet-actionbar__select"
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
                  className="fleet-actionbar__select"
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
                    className="fleet-actionbar__select"
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
                <select
                  className="fleet-actionbar__select"
                  value={bulkTargeting}
                  onChange={(e) => setBulkTargeting(e.target.value as '' | 'auto' | 'custom')}
                  title="Target priority: auto matches speed peers; custom ranks target categories"
                >
                  <option value="">Targeting: keep</option>
                  <option value="auto">Targeting: auto</option>
                  <option value="custom">Targeting: custom…</option>
                </select>
                <button
                  className="fleet-actionbar__btn fleet-actionbar__btn--primary"
                  onClick={issueBulkOrders}
                  disabled={!bulkStance && !bulkRetreat && !bulkTargeting
                    && !(bulkDetonate && detonatorSelectedCount > 0)}
                >
                  Set orders
                </button>
              </div>
            )}
            {/* Staged priority cards — drag here, then SET ORDERS applies
                the order to every selected ship in the same PATCH. */}
            {mpActions && bulkTargeting === 'custom' && (
              <div style={{ maxWidth: 300 }}>
                <TargetPriorityCards
                  value={bulkPriorityOrder}
                  onChange={(next) => {
                    if (next == null) setBulkTargeting('auto');
                    else setBulkPriorityOrder(next);
                  }}
                  note={`Will apply to ${visibleSelected.length} selected ship${visibleSelected.length === 1 ? '' : 's'} on SET ORDERS.`}
                />
              </div>
            )}
            {mpActions && bulkDetonate && bulkDetonate !== 'off' && detonatorSelectedCount > 0 && (
              <div className="fleet-actionbar__warn">
                Auto-detonate below {bulkDetonate}% HP: deals damage to every ship
                in this orbit, friend or foe; the detonating ship is destroyed.
                {detonatorSelectedCount < visibleSelected.length
                  && ` Applies to ${detonatorSelectedCount} of ${visibleSelected.length} selected — the rest carry no detonator.`}
              </div>
            )}
            {ordersNotice && <div className="fleet-actionbar__error">{ordersNotice}</div>}
          </div>
        )}
      </div>
    </div>
  );
};
