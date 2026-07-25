// ============================================================
// FleetPanel — all ships organized by status
// Orbiting (grouped by body) + separate "In Transit" group
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { loadoutSummary, countPart } from '../game/shipParts';
import { effectiveShipMaxHp } from '../game/combat';
import type { Ship, Captain } from '../types';
import { rankTier, traitSummary, AVATAR_IDS } from '../game/captains';
import { CaptainAvatar } from './CaptainAvatar';
import { deriveSecondary } from '../game/colorUtils';
import { makeSystemRootOf, systemLabel as systemLabelOf, shipStatus, makeHostilesAtBody, makeArmedHostilesAtBody, makeStationsAtBody, isArmed } from '../game/systemGrouping';
import { nearestShipyardBodyId, isDamagedShip } from '../game/repair';
import { ShipIcon } from './ShipIcons';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { openShipDesigner } from './ShipDesigner';
import './OverviewPanel.css';

interface FleetPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy' | 'captains';

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
  // Captain Bank state (spec §5.3): inline rename target + busy/error.
  const [capEditId, setCapEditId] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState(false);
  const [capMsg, setCapMsg] = useState<string | null>(null);
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
    const shipName = (id: string | null) =>
      id ? (myShips.find(s => s.id === id)?.name ?? id) : null;

    const doCap = (p: Promise<{ ok: boolean; error?: string }>) => {
      setCapBusy(true);
      p.then(res => { setCapBusy(false); setCapMsg(res.ok ? null : (res.error ?? 'Rejected')); });
    };

    const row = (c: Captain) => {
      const editing = capEditId === c.id;
      const aboard = shipName(c.shipId);
      return (
        <div
          key={c.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
            border: '1px solid #22303f', borderRadius: 6, marginBottom: 6,
            background: '#0d1420', opacity: c.status === 'lost' ? 0.55 : 1,
          }}
        >
          {/* avatar — click cycles the portrait set (BuildPanel icon precedent) */}
          <button
            onClick={() => {
              if (!mpActions || c.status === 'lost') return;
              const cur = AVATAR_IDS.indexOf((c.avatarId ?? 'a1') as typeof AVATAR_IDS[number]);
              doCap(mpActions.updateCaptain(c.id, { avatarId: AVATAR_IDS[(cur + 1) % AVATAR_IDS.length] }));
            }}
            disabled={capBusy || c.status === 'lost'}
            title={c.status === 'lost' ? undefined : 'Change portrait'}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <CaptainAvatar avatarId={c.avatarId} size={30} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <input
                autoFocus
                defaultValue={c.name}
                maxLength={32}
                style={{
                  background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
                  color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, padding: '2px 6px', width: '90%',
                }}
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
              <div style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                {c.status === 'active' && mpActions && (
                  <button
                    onClick={() => setCapEditId(c.id)}
                    title="Rename"
                    style={{ background: 'transparent', border: 'none', color: '#5f7488', cursor: 'pointer', fontSize: 10 }}
                  >✎</button>
                )}
                <span className={`fleet-xp__tier fleet-xp__tier--${rankTier(c.rank).toLowerCase()}`}>
                  {rankTier(c.rank)}
                </span>
                <span className="fleet-xp__kills">{c.rank > 0 ? `${c.rank} ⚔` : ''}</span>
              </div>
            )}
            <div style={{ fontSize: 9, color: '#8aa0b4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {traitSummary(c.traits) || 'No notable traits'}
              {c.bio ? ` · ${c.bio}` : ''}
            </div>
          </div>
          {c.status === 'lost' ? (
            <span style={{ fontSize: 9, color: '#ff5e5e', whiteSpace: 'nowrap' }}>
              ✝ LOST{c.lostAtTick != null ? ` T+${c.lostAtTick}` : ''}
            </span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {aboard && (
                <span style={{ fontSize: 9, color: '#4ecdc4', whiteSpace: 'nowrap' }} title="Current posting">
                  ⚓ {aboard}
                </span>
              )}
              {mpActions && (
                <select
                  value=""
                  disabled={capBusy}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__bench') doCap(mpActions.assignCaptain(c.id, null));
                    else if (v) doCap(mpActions.assignCaptain(c.id, v));
                  }}
                  style={{
                    background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
                    color: '#9fb4c6', fontFamily: 'inherit', fontSize: 9, padding: '2px 4px', maxWidth: 110,
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
      <div style={{ padding: '4px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '6px 0 10px' }}>
          <span style={{ fontSize: 10, letterSpacing: '0.1em', color: '#4ecdc4' }}>
            CAPTAIN BANK <span style={{ color: '#6f8598' }}>· {active.length} serving/{lost.length ? ` ${lost.length} lost` : ' none lost'}</span>
          </span>
          {mpActions && (
            <button
              className="filter-chip"
              disabled={capBusy}
              onClick={() => doCap(mpActions.createCaptain())}
              title="Roll a new captain into the bank — future builds draw from here before generating fresh"
            >+ NEW CAPTAIN</button>
          )}
        </div>
        {capMsg && (
          <div className="fleet-bulk-bar__error" style={{ marginBottom: 8 }} onClick={() => setCapMsg(null)}>
            ⚠ {capMsg}
          </div>
        )}
        {active.length === 0 && (
          <div className="overview-empty">No captains yet — they generate automatically as ships launch.</div>
        )}
        {active.map(row)}
        {lost.length > 0 && (
          <>
            <div style={{ fontSize: 10, letterSpacing: '0.1em', color: '#8aa0b4', margin: '14px 0 8px' }}>
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

  const renderHpBar = (ship: Ship) => {
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
        <th>Captain</th>
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
