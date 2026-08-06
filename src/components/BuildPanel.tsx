// ============================================================
// BuildPanel — Ship construction UI for owned bodies
// ============================================================

import React, { useState, useEffect } from 'react';
import { useGameContext } from '../state/gameContext';
import { BUILDABLE_CLASSES, SHIP_CLASSES, ShipClassName } from '../game/shipClasses';
import { shipyardSlotsAtBody } from '../game/settlements';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import {
  ShipIcon, ShipIconVariant, ICON_VARIANT_NAMES,
  ALL_VARIANTS, DEFAULT_SHIP_ICONS,
} from './ShipIcons';
import { openShipDesigner } from './ShipDesigner';
import {
  sanitizeParts, partsCost, computeDesignStats, loadoutSummary, ShipPartId, SERVER_HULL_BASE,
  combatSpeedOf,
} from '../game/shipParts';
import { deliveredHullHp } from '../game/combat';
import { randomShipName } from '../game/shipNames';
import type { BuildListEntry, ShipDesign } from '../types';
import { HULL_FEATURE } from '../game/researchUnlocks';
import { useFeatureGate } from '../hooks/useFeatureGate';
import { RESOURCE_COLORS } from '../game/resourceColors';
import './BuildPanel.css';

export const BuildPanel: React.FC = () => {
  const { gameState, uiState, buildShip, cancelBuild, updateGameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();
  const [, setSelectedClass] = useState<ShipClassName | null>(null);
  const [customName, setCustomName] = useState<string>('');
  // FIFO queue of names committed via the COMMIT button. Each BUILD
  // consumes the head of this queue if present; otherwise it falls
  // back to whatever's typed in the input (back-compat with the
  // original "type then BUILD" flow), or a random pool name. Playtester
  // reported "custom names dont seem to work" — server-side fix lands
  // separately, but this lets the player line up several names before
  // queuing builds in sequence without re-typing each time.
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  // Per-class icon variant pick. Each row in the build list has its
  // own selector defaulting to DEFAULT_SHIP_ICONS[class]. Map keyed by
  // class because the player might want, e.g. Corvette Raptor and
  // Frigate Carrier at the same time.
  const [iconChoice, setIconChoice] = useState<Record<ShipClassName, ShipIconVariant>>({
    corvette:  DEFAULT_SHIP_ICONS.corvette,
    frigate:   DEFAULT_SHIP_ICONS.frigate,
    destroyer: DEFAULT_SHIP_ICONS.destroyer,
    freighter: DEFAULT_SHIP_ICONS.freighter,
    colony:    DEFAULT_SHIP_ICONS.colony,
  });
  // Server-side build rejection shown as a red chip below the rows so
  // the BUILD button never silently resets in MP — mirrors the
  // BodyInspector deploy-error pattern. Cleared on the next attempt.
  const [buildError, setBuildError] = useState<string | null>(null);
  // CSS-side feedback for click confirmation: the build-btn--just-queued
  // class fires the queued-flash keyframes for 600ms. Tracked per
  // class so the player can spam BUILD on Corvette without losing the
  // animation on Frigate.
  const [recentlyQueued, setRecentlyQueued] = useState<Set<string>>(new Set());
  // Live view of gameState for async rollbacks — a build rejection lands
  // hundreds of ms later, by which time the closed-over snapshot is stale.
  const gameStateRef = React.useRef(gameState);
  React.useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => {
    if (recentlyQueued.size === 0) return;
    const t = setTimeout(() => setRecentlyQueued(new Set()), 600);
    return () => clearTimeout(t);
  }, [recentlyQueued]);

  // --- Curated build list (MP): local state ---------------------------
  // The build panel is now a list of LOADOUTS the player assigns, not a
  // fixed roster of every class. pickerOpen toggles the "add loadout"
  // menu; rowQty holds per-row build counts; pendingList is an optimistic
  // overlay so add/remove feel instant instead of waiting ~1.5s for the
  // next /state poll to reflect the PUT.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rowQty, setRowQty] = useState<Record<string, number>>({});
  const [pendingList, setPendingList] = useState<BuildListEntry[] | null>(null);
  // Server buildList is authoritative — whenever it changes (our PUT
  // reflected, or another tab edited), drop the optimistic overlay.
  const buildListKey = JSON.stringify(gameState.buildList ?? []);
  useEffect(() => { setPendingList(null); }, [buildListKey]);

  if (!uiState.selectedBodyId) return null;

  const body = gameState.bodies.find(b => b.id === uiState.selectedBodyId);
  if (!body) return null;

  // Build is allowed wherever the player has any active settlement —
  // surface city OR orbital station. Stations CAN sit at gas / ice
  // giants (no city possible there, but the station provides the
  // shipyard slots), so the old "type must be terrestrial/dwarf/moon"
  // bail locked out the gas-giant playstyle. Playtester report
  // (clownking, 2026-06-27): "I have a station around Neptune, and
  // I upgraded to shipyard level 1 for 1 build slot, but I can't
  // build any ships."
  //
  // Star is the only type still blocked outright — no settlements can
  // be deployed at stars in the first place, so the gate would never
  // pass anyway, but we exit early to avoid the settlements scan.
  if (body.type === 'star') return null;
  // Settlement type has no destroyedAtTick — the server filters destroyed
  // rows out before /state sends the list, so anything present here is
  // alive by construction.
  const hasMySettlement = gameState.settlements.some(
    s => s.bodyId === body.id && s.ownedBy === 'player',
  );
  if (!hasMySettlement) return null;

  const playerRes = gameState.resources['player'];
  if (!playerRes) return null;

  const ordersHere = gameState.buildOrders.filter(bo => bo.bodyId === body.id);
  // MP unlimited queue split: 'building' rows occupy slots and show a
  // progress bar; 'waiting' rows sit below with a position number until
  // the server promotes them FIFO. SP orders never carry a status —
  // they're all active.
  const buildingOrders = ordersHere.filter(bo => bo.status !== 'waiting');
  const waitingOrders = ordersHere.filter(bo => bo.status === 'waiting');
  const existingShipNames = gameState.ships.map(s => s.name);

  // Build slots: 1 base + 1 per Shipyard level on owned stations here.
  // Mirrors the server concurrency in worker/actions.js handleQueueBuild
  // and src/game/settlements.ts shipyardSlotsAtBody. Pips count ACTIVE
  // builds only — waiting orders don't consume a slot.
  const totalSlots = shipyardSlotsAtBody(body.id, 'player', gameState.settlements);
  const usedSlots = buildingOrders.length;
  const slotsFull = usedSlots >= totalSlots;

  // Projected START tick for each waiting order, so a queued ship reads
  // "starts in ~N ticks" instead of a bare "waiting for slot" that looks
  // frozen — at slow tick cadences a destroyer behind another destroyer
  // legitimately waits dozens of ticks (hours of wall-clock), which
  // playtesters read as a bug. Simulate the slots: seed each with its
  // current build's finish tick (empty slots free now), then hand the
  // FIFO waiting queue the earliest-free slot in turn.
  const slotCap = Math.max(1, totalSlots);
  const slotFreeAt: number[] = buildingOrders
    .map(bo => bo.completeTick)
    .sort((a, b) => a - b)
    .slice(0, slotCap);
  while (slotFreeAt.length < slotCap) slotFreeAt.push(gameState.currentTick);
  const waitingStartTicks = waitingOrders.map(bo => {
    const dur = SHIP_CLASSES[bo.shipClass]?.buildTime ?? 20;
    let earliest = 0;
    for (let s = 1; s < slotFreeAt.length; s++) {
      if (slotFreeAt[s] < slotFreeAt[earliest]) earliest = s;
    }
    const start = slotFreeAt[earliest];
    slotFreeAt[earliest] = start + dur;
    return start;
  });
  // MP: the queue is unlimited depth — BUILD stays enabled at capacity
  // and new orders wait for a slot (charged up front, refundable via
  // cancel). SP keeps the hard gate (single-player engine is frozen).
  const capacityBlocks = slotsFull && !mpActions;

  const handleCommitName = () => {
    const trimmed = customName.trim();
    if (trimmed.length === 0) return;
    setPendingNames(prev => [...prev, trimmed]);
    setCustomName('');
  };

  const dequeueName = () => {
    if (pendingNames.length > 0) {
      const [head, ...rest] = pendingNames;
      setPendingNames(rest);
      return head;
    }
    const typed = customName.trim();
    if (typed.length > 0) {
      setCustomName('');
      return typed;
    }
    return null;
  };

  const handleBuild = (shipClass: ShipClassName) => {
    // Name resolution priority:
    //   1. head of pendingNames (committed via COMMIT button)
    //   2. whatever's typed in the input right now (legacy flow)
    //   3. random pool name
    const fromQueue = dequeueName();
    const name = fromQueue ?? randomShipName(shipClass, existingShipNames);
    // Icon source of truth: the active design owns the ship's look, so
    // its icon wins whenever a design is set for this class. The inline
    // per-row picker (iconChoice) only applies to bare-hull builds where
    // no design exists. Previously handleBuild always sent iconChoice,
    // so the server's "use the design's icon when the client sends none"
    // fallback could never fire — designs built with the class-default
    // icon no matter what you picked in the designer.
    const activeDesign = mpActions
      ? gameState.shipDesigns?.find(d => d.shipClass === shipClass && d.isActive)
      : undefined;
    const variant = activeDesign?.iconVariant ?? iconChoice[shipClass];
    if (mpActions) {
      // Multiplayer: server is canonical for resource deduction + queue
      // persistence. Skip the local buildShip() — calling it here used
      // to flash 2× deducted resources for ~1.5s until /state poll snap
      // back. Post intent only; UI updates when the poll lands.
      // Surface server rejections inline so the BUILD button doesn't
      // appear to "do nothing" when the queue actually 4xx'd.
      setBuildError(null);
      // Optimistic queue row: show it NOW. The old code posted intent
      // and waited for /state, which on a big game is a 650ms fetch that
      // may not even start for another second — the "3 second delay"
      // playtest report. The server list is canonical and replaces this
      // wholesale on the next poll; the temp id just has to survive
      // until then. Resources are NOT deducted locally (that double-
      // counted against the server's own deduction — see the note this
      // replaces), so only the row itself is predicted.
      const optimisticId = `opt_${Date.now()}_${shipClass}`;
      const cls = SHIP_CLASSES[shipClass];
      updateGameState({
        buildOrders: [
          ...gameState.buildOrders,
          {
            id: optimisticId,
            bodyId: body.id,
            shipClass,
            ownedBy: 'player',
            startTick: gameState.currentTick,
            completeTick: gameState.currentTick + (cls?.buildTime ?? 10),
            shipName: name,
            iconVariant: variant,
            // 'waiting' not 'building': the server decides whether a
            // slot is free, and claiming 'building' would draw a
            // progress bar that could snap backwards a second later.
            status: 'waiting',
          },
        ],
      });
      mpActions.build({ bodyId: body.id, shipClass, shipName: name, iconVariant: variant })
        .then(res => {
          if (!res.ok) {
            setBuildError(humanizeMpError(res.code, res.error, 'build'));
            // Roll back the optimistic row. Read through a ref, not the
            // closed-over snapshot: a /state poll almost certainly landed
            // while the request was in flight, and filtering the stale
            // array would resurrect rows the server has since changed.
            updateGameState({
              buildOrders: gameStateRef.current.buildOrders.filter(
                o => o.id !== optimisticId),
            });
            // Server rejected the build — put the name back at the
            // head of the queue so the player doesn't lose what they
            // committed. (Only if we pulled from the queue; typed
            // names already cleared from the input.)
            if (fromQueue) setPendingNames(prev => [fromQueue, ...prev]);
          }
        });
    } else {
      // Single-player: local state is canonical.
      const success = buildShip(body.id, shipClass, name, variant);
      if (!success && fromQueue) {
        setPendingNames(prev => [fromQueue, ...prev]);
      }
    }
    setSelectedClass(null);
  };

  // ===== Curated build list (MP only) ================================
  // The player assigns specific LOADOUTS to this list (any saved design,
  // or a bare hull) instead of the fixed all-classes roster. Building a
  // row queues that exact loadout — many per class, no locked clutter.
  const designs: ShipDesign[] = gameState.shipDesigns ?? [];
  const mpBuildable = BUILDABLE_CLASSES.filter(cls => cls !== 'colony' || !!mpActions);
  const isUnlocked = (cls: ShipClassName) => !gate.lockReason(HULL_FEATURE[cls]);
  const techLevels = gameState.factionTech['player']?.levels ?? {};
  // The build menu must quote the DELIVERED hull, not the build-time base:
  // the yard spawns at base × defense tech, so at Defense 10 the base
  // number is 80% short of what actually launches.
  const playerTech = gameState.factionTech['player'];
  const deliveredHp = (cls: ShipClassName, stats: { hp: number } | null) =>
    deliveredHullHp(stats ? stats.hp : SERVER_HULL_BASE[cls].hp, playerTech);
  const hpTitle = (cls: ShipClassName, stats: { hp: number } | null) => {
    const base = stats ? stats.hp : SERVER_HULL_BASE[cls].hp;
    const out = deliveredHp(cls, stats);
    return out === base
      ? `${base} HP on delivery`
      : `${base} HP hull + defense tech = ${out} HP on delivery`;
  };

  // Effective entries = the optimistic overlay, else the explicit server
  // list, else a sensible default (active design / bare hull per UNLOCKED
  // class) so a player who has never curated one still sees buildables.
  const serverList = gameState.buildList ?? [];
  const deriveDefaultList = (): BuildListEntry[] => {
    const out: BuildListEntry[] = [];
    for (const cls of mpBuildable) {
      if (!isUnlocked(cls)) continue;
      const active = designs.find(d => d.shipClass === cls && d.isActive);
      out.push(active ? { designId: active.id } : { bareClass: cls });
    }
    return out;
  };
  const effectiveEntries: BuildListEntry[] =
    pendingList ?? (serverList.length > 0 ? serverList : deriveDefaultList());

  interface BuildRow {
    key: string; shipClass: ShipClassName; name: string;
    iconVariant?: ShipIconVariant; parts: ShipPartId[]; designId?: string;
  }
  const buildRows: BuildRow[] = effectiveEntries
    .map((e): BuildRow | null => {
      if (e.designId) {
        const d = designs.find(x => x.id === e.designId);
        if (!d) return null; // stale ref (design deleted) — drop it
        return {
          key: `d:${d.id}`, shipClass: d.shipClass, name: d.name,
          iconVariant: d.iconVariant, parts: sanitizeParts(d.parts), designId: d.id,
        };
      }
      const cls = (e.bareClass ?? 'corvette') as ShipClassName;
      return {
        key: `b:${cls}`, shipClass: cls,
        name: `Bare ${SHIP_CLASSES[cls].displayName}`, parts: [],
      };
    })
    .filter((r): r is BuildRow => r !== null);

  const persistList = (next: BuildListEntry[]) => {
    setPendingList(next);
    setBuildError(null);
    if (mpActions) {
      mpActions.setBuildList(next).then(res => {
        if (!res.ok) setBuildError(humanizeMpError(res.code, res.error, 'build'));
      });
    }
  };
  const addEntry = (entry: BuildListEntry) => {
    persistList([...effectiveEntries, entry]);
    setPickerOpen(false);
  };
  const removeRow = (row: BuildRow) => persistList(
    effectiveEntries.filter(e =>
      row.designId ? e.designId !== row.designId : e.bareClass !== row.shipClass),
  );

  const listedDesignIds = new Set(effectiveEntries.map(e => e.designId).filter(Boolean));
  const listedBareClasses = new Set(effectiveEntries.map(e => e.bareClass).filter(Boolean));

  const getRowQty = (key: string) => Math.max(1, rowQty[key] ?? 1);
  const bumpRowQty = (key: string, d: number) =>
    setRowQty(prev => ({ ...prev, [key]: Math.max(1, Math.min(20, (prev[key] ?? 1) + d)) }));

  const pickerRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 7, width: '100%',
    padding: '5px 6px', background: 'transparent', border: 'none',
    borderRadius: 5, color: '#d8e4ee', fontFamily: 'inherit',
    cursor: 'pointer', textAlign: 'left',
  };

  // Local stockpile at THIS body (matches server spend logic), summed
  // once for every row's affordability check.
  const localStock = gameState.settlements
    .filter(s => s.ownedBy === 'player' && s.bodyId === body.id)
    .reduce((a, s) => ({
      fuel: a.fuel + s.stockpile.fuel,
      ore: a.ore + s.stockpile.ore,
      credits: a.credits + s.stockpile.credits,
    }), { fuel: 0, ore: 0, credits: 0 });

  const handleBuildRow = (row: BuildRow) => {
    if (!mpActions) return;
    const n = getRowQty(row.key);
    setBuildError(null);
    for (let i = 0; i < n; i++) {
      const fromQueue = dequeueName();
      const name = fromQueue ?? randomShipName(row.shipClass, existingShipNames);
      mpActions.build({
        bodyId: body.id, shipClass: row.shipClass, shipName: name,
        iconVariant: row.iconVariant,
        ...(row.designId ? { designId: row.designId } : { bare: true }),
      }).then(res => {
        if (!res.ok) {
          setBuildError(humanizeMpError(res.code, res.error, 'build'));
          if (fromQueue) setPendingNames(prev => [fromQueue, ...prev]);
        }
      });
    }
    setRecentlyQueued(s => new Set(s).add(row.key));
  };

  return (
    <div className="build-panel">
      <div className="section-title">BUILD</div>

      {/* Build slots — visible capacity. Filled pips = builds in flight,
          hollow = free. Full row turns amber with a "build a Shipyard"
          nudge so the player knows how to get more. */}
      <div className={`build-slots${slotsFull ? ' build-slots--full' : ''}`}>
        <span className="build-slots__label">BUILD SLOTS</span>
        <span className="build-slots__pips" aria-hidden="true">
          {Array.from({ length: totalSlots }).map((_, i) => (
            <span
              key={i}
              className={`build-slots__pip${i < usedSlots ? ' is-filled' : ''}`}
            />
          ))}
        </span>
        <span className="build-slots__count">{usedSlots}/{totalSlots}</span>
      </div>
      {slotsFull && (
        <div className="build-slots__hint">
          {mpActions
            ? 'All slots busy — new builds are charged now and wait in the queue. Add/upgrade a Shipyard for more concurrent slots.'
            : 'All slots busy — wait for a build to finish, or add/upgrade a Shipyard on a station here for more.'}
        </div>
      )}

      <div className="build-name-row">
        <input
          type="text"
          className="build-name-input"
          placeholder="Custom name (optional)"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customName.trim().length > 0) {
              e.preventDefault();
              handleCommitName();
            }
          }}
          maxLength={32}
        />
        <button
          type="button"
          className="build-name-commit"
          onClick={handleCommitName}
          disabled={customName.trim().length === 0}
          title="Save this name for the next ship you BUILD"
        >
          COMMIT
        </button>
      </div>

      {pendingNames.length > 0 && (
        <div className="build-name-queue">
          <div className="build-name-queue__label">
            NEXT BUILD{pendingNames.length > 1 ? `S (${pendingNames.length})` : ''}:
          </div>
          {pendingNames.map((n, i) => (
            <span key={`${n}:${i}`} className="build-name-chip">
              {n}
              <button
                type="button"
                className="build-name-chip__x"
                onClick={() =>
                  setPendingNames(prev => prev.filter((_, idx) => idx !== i))
                }
                aria-label={`Remove ${n} from the build-name queue`}
                title="Remove from the queue"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {buildingOrders.length > 0 && (
        <div className="build-queue">
          <div className="queue-label">BUILDING</div>
          {buildingOrders.map(bo => {
            const progress = (gameState.currentTick - bo.startTick) / (bo.completeTick - bo.startTick);
            const remaining = Math.max(0, bo.completeTick - gameState.currentTick);
            return (
              <div key={bo.id} className="build-item">
                <div className="build-info">
                  <span className="build-name">{bo.shipName}</span>
                  <span className="build-class">{bo.shipClass.toUpperCase()}</span>
                  {loadoutSummary(bo.parts) && bo.parts && bo.parts.length > 0 && (
                    <span className="build-loadout" title="Fitted parts (snapshot at queue time)">
                      {loadoutSummary(bo.parts)}
                    </span>
                  )}
                </div>
                <div className="build-progress-bar">
                  <div className="build-progress-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                </div>
                <div className="build-eta">T-{remaining.toFixed(0)}</div>
                {bo.botched && (
                  <span
                    className="build-botched"
                    title="A rush went badly — this hull will be delivered at HALF health."
                    style={{ color: '#ff8a5c', fontSize: 11, whiteSpace: 'nowrap' }}
                  >⚠ half-hull</span>
                )}
                {mpActions && remaining > 1 && (
                  <RushControl
                    order={bo}
                    remaining={remaining}
                    constructionLvl={gameState.factionTech?.player?.levels?.construction ?? 0}
                  />
                )}
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

      {/* Waiting orders — queued beyond concurrency (MP unlimited
          queue). Already paid for; the server promotes them FIFO as
          active builds finish. Position number instead of a progress
          bar; cancel refunds like any other order. */}
      {waitingOrders.length > 0 && (
        <div className="build-queue build-queue--waiting">
          <div className="queue-label">QUEUED (waiting for slot)</div>
          {waitingOrders.map((bo, i) => (
            <div key={bo.id} className="build-item build-item--waiting" style={{ opacity: 0.75 }}>
              <div className="build-info">
                <span
                  className="build-queue-pos"
                  style={{ fontSize: 10, opacity: 0.8, marginRight: 6 }}
                >#{i + 1}</span>
                <span className="build-name">{bo.shipName}</span>
                <span className="build-class">{bo.shipClass.toUpperCase()}</span>
                {loadoutSummary(bo.parts) && bo.parts && bo.parts.length > 0 && (
                  <span className="build-loadout" title="Fitted parts (snapshot at queue time)">
                    {loadoutSummary(bo.parts)}
                  </span>
                )}
                {(() => {
                  const ticksAway = Math.max(0, waitingStartTicks[i] - gameState.currentTick);
                  return (
                    <span
                      className="build-eta"
                      title="Estimated start once a build slot frees"
                      style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.75, whiteSpace: 'nowrap' }}
                    >
                      {ticksAway === 0 ? 'starts next tick' : `starts ~${ticksAway}t`}
                    </span>
                  );
                })()}
              </div>
              <button
                className="build-cancel"
                onClick={() => {
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
                title="Cancel this queued build (refunds the cost)"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* SINGLE-PLAYER roster (frozen sim). MP uses the curated build
          list below instead. LOCAL-first: sum the stockpiles of every
          player-owned settlement at this body so the affordability calc
          matches worker/actions.js handleQueueBuild. */}
      {!mpActions && (
      <div className="build-classes">
        {/* Colony ships are an MP-only verb (SP's sim is frozen on the
            legacy freighter-settle mechanics), so hide the class from
            the SP build menu — building one there would be a dead end. */}
        {BUILDABLE_CLASSES.filter(cls => cls !== 'colony' || !!mpActions).map(cls => {
          const def = SHIP_CLASSES[cls];
          // Ship designer (MP only): BUILD uses the ACTIVE design for
          // this class. Its parts add to the hull cost and boost the
          // displayed stats — mirror of the server's handleQueueBuild
          // snapshot so the row shows what the yard will actually
          // charge and deliver. No active design = bare hull.
          const activeDesign = mpActions
            ? gameState.shipDesigns?.find(d => d.shipClass === cls && d.isActive)
            : undefined;
          const designParts = activeDesign ? sanitizeParts(activeDesign.parts) : [];
          const designCost = partsCost(designParts);
          const rowCostOre = def.cost.ore + designCost.ore;
          const rowCostCredits = def.cost.credits + designCost.credits;
          const designStats = designParts.length > 0
            ? computeDesignStats(cls, designParts, gameState.factionTech['player']?.levels ?? {})
            : null;
          // Per-resource shortages so the UI can colour each cost
          // individually + surface the deficit explicitly. Previously the
          // BUILD button just greyed out with no indication of why.
          const localF = gameState.settlements
            .filter(s => s.ownedBy === 'player' && s.bodyId === body.id)
            .reduce((a, s) => a + s.stockpile.fuel, 0);
          const localO = gameState.settlements
            .filter(s => s.ownedBy === 'player' && s.bodyId === body.id)
            .reduce((a, s) => a + s.stockpile.ore, 0);
          const localC = gameState.settlements
            .filter(s => s.ownedBy === 'player' && s.bodyId === body.id)
            .reduce((a, s) => a + s.stockpile.credits, 0);
          const shortFuel    = Math.max(0, def.cost.fuel  - playerRes.fuel    - localF);
          const shortOre     = Math.max(0, rowCostOre     - playerRes.ore     - localO);
          const shortCredits = Math.max(0, rowCostCredits - playerRes.credits - localC);
          const canAfford = shortFuel === 0 && shortOre === 0 && shortCredits === 0;
          const shortBits: string[] = [];
          if (shortFuel    > 0) shortBits.push(`+${shortFuel} fuel`);
          if (shortOre     > 0) shortBits.push(`+${shortOre} metal`);
          if (shortCredits > 0) shortBits.push(`+${shortCredits} cr`);
          const shortLabel = shortBits.length > 0 ? `Need ${shortBits.join(', ')}` : '';
          // Research gate. Locked hulls stay VISIBLE rather than being
          // filtered out — seeing the destroyer sitting there with
          // "Unlocks at Construction 4" is what makes the tech tree
          // legible as a set of goals. Hiding them would just make the
          // early game look empty.
          const lock = gate.lockReason(HULL_FEATURE[cls]);
          return (
            <div key={cls} className={`build-class-row ${lock || !canAfford ? 'disabled' : ''}`}>
              <div className="class-info">
                {/* Icon-variant picker dropped from the inline row to
                    keep the build row narrow enough to stay one-line
                    inside the bottom card. The variant is still
                    accessible via the ship's own panel after build —
                    it's a power-user preference, not a build-time
                    decision. Click the icon itself to cycle through
                    variants in-place. */}
                {(() => {
                  // Effective icon = the active design's icon when one is
                  // set (it owns the look), else the local per-row pick.
                  // With a design active, cycling the local override would
                  // silently do nothing (the build sends the design icon),
                  // so the click opens the designer instead — where the
                  // icon actually lives.
                  const effectiveVariant = activeDesign?.iconVariant ?? iconChoice[cls];
                  return (
                    <button
                      className="class-icon"
                      onClick={() => {
                        if (activeDesign) { openShipDesigner(cls); return; }
                        const cur = ALL_VARIANTS.indexOf(iconChoice[cls]);
                        const next = ALL_VARIANTS[(cur + 1) % ALL_VARIANTS.length];
                        setIconChoice(prev => ({ ...prev, [cls]: next }));
                      }}
                      title={activeDesign
                        ? `Icon from design "${activeDesign.name}" — click to change it in the designer`
                        : `Icon: ${ICON_VARIANT_NAMES[cls][iconChoice[cls]]} (click to cycle)`}
                      style={{
                        background: 'transparent', border: 'none',
                        padding: 0, cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <ShipIcon shipClass={cls} variant={effectiveVariant} size={20} />
                    </button>
                  );
                })()}
                <span className="class-name">{def.displayName}</span>
                {mpActions && (
                  // Quick-link to the designer, landing on this class's
                  // tab. Shows the active design's name when one is set
                  // so the row tells you what BUILD will produce.
                  <button
                    onClick={() => openShipDesigner(cls)}
                    title={activeDesign
                      ? `Active design: ${activeDesign.name} — click to edit loadouts`
                      : 'No active design (bare hull) — click to open the ship designer'}
                    style={{
                      background: 'transparent',
                      border: '1px solid #2a3d50', borderRadius: 3,
                      color: activeDesign ? '#4ecdc4' : '#8aa0b4',
                      fontFamily: 'inherit', fontSize: 8,
                      letterSpacing: '0.08em', padding: '2px 6px',
                      marginLeft: 6, cursor: 'pointer',
                      maxWidth: 110, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    ⚙ {activeDesign ? activeDesign.name.toUpperCase() : 'DESIGN'}
                  </button>
                )}
              </div>
              <div className="class-stats">
                <span className="stat">FP:{designStats ? designStats.damagePerTick : SERVER_HULL_BASE[cls].damagePerTick}</span>
                <span className="stat" title="Speed: how fast it arrives, and how hard it is to hit.">
                  SPD:{combatSpeedOf(cls, designParts).toFixed(2)}
                </span>
                <span className="stat" title={hpTitle(cls, designStats)}>
                  HP:{deliveredHp(cls, designStats)}
                </span>
                {designStats && designStats.travelTimeMult < 1 && (
                  <span className="stat" title="Engine parts: travel-time multiplier">
                    ⏱×{designStats.travelTimeMult.toFixed(2)}
                  </span>
                )}
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
                >{rowCostOre}M</span>
                <span
                  className="cost-money"
                  style={shortCredits > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}
                >{rowCostCredits}C</span>
              </div>
              <button
                className={`build-btn${recentlyQueued.has(cls) ? ' build-btn--just-queued' : ''}`}
                disabled={!!lock || !canAfford || capacityBlocks}
                onClick={() => { setRecentlyQueued(s => new Set(s).add(cls)); handleBuild(cls); }}
                title={
                  lock
                    ? `${lock.label} — ${lock.text}`
                  : capacityBlocks
                    ? `All ${totalSlots} build slots busy — finish a build, or add a Shipyard to a station here`
                    : canAfford
                      ? slotsFull
                        ? `Queue a ${def.displayName}${activeDesign ? ` [${activeDesign.name}]` : ''} (${rowCostOre}M ${rowCostCredits}C, charged now — starts when a slot frees)`
                        : `Build a ${def.displayName}${activeDesign ? ` [${activeDesign.name}]` : ''} (${rowCostOre}M ${rowCostCredits}C, ${def.buildTime} ticks)`
                      : shortLabel}
              >
                {lock ? '🔒 LOCKED' : `BUILD · ${def.buildTime}t`}
              </button>
              {lock && (
                // The unlock condition, stated inline. A player should
                // never have to hover to find out what to research next.
                <div
                  className="build-shortage"
                  role="status"
                  style={{
                    flexBasis: '100%',
                    margin: '2px 0 0',
                    fontSize: 10,
                    color: '#8aa0b4',
                    letterSpacing: '0.04em',
                  }}
                >🔒 {lock.text}</div>
              )}
              {!lock && !canAfford && shortLabel && (
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
      )}

      {/* MULTIPLAYER curated build list — the loadouts the player has
          assigned. Building a row queues that exact design (or bare hull),
          with a ×N stepper; add/remove via the picker. Locked hulls live
          only in the picker, greyed, so the list is never padded with
          ships you can't build. Replaces the fixed all-classes roster. */}
      {mpActions && (
        <>
          <div
            className="section-title"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>BUILD LIST</span>
            <button
              onClick={() => openShipDesigner()}
              title="Open the ship designer to create and edit loadouts"
              style={{
                background: 'transparent', border: '1px solid #2a3d50',
                borderRadius: 3, color: '#8aa0b4', fontFamily: 'inherit',
                fontSize: 8, letterSpacing: '0.08em', padding: '2px 6px', cursor: 'pointer',
              }}
            >⚙ DESIGNER</button>
          </div>

          {pickerOpen ? (
            <div
              style={{
                border: '1px solid #2a3d50', borderRadius: 6,
                background: '#0c141d', padding: 8, marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: '0.1em', color: '#8aa0b4', marginBottom: 4 }}>
                ADD A LOADOUT TO YOUR LIST
              </div>
              {mpBuildable.map(cls => {
                const lock = gate.lockReason(HULL_FEATURE[cls]);
                if (lock) {
                  // Locked hull: shown greyed, not addable — the "you
                  // can't fill the list with ships you can't build" rule.
                  return (
                    <div
                      key={cls}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        padding: '5px 6px', opacity: 0.5,
                      }}
                    >
                      <ShipIcon shipClass={cls} size={14} />
                      <span style={{ fontSize: 11, color: '#7a8a99' }}>{SHIP_CLASSES[cls].displayName}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 8, color: '#8aa0b4', letterSpacing: '0.04em' }}>
                        🔒 {lock.text}
                      </span>
                    </div>
                  );
                }
                const clsDesigns = designs.filter(d => d.shipClass === cls && !listedDesignIds.has(d.id));
                const bareListed = listedBareClasses.has(cls);
                if (bareListed && clsDesigns.length === 0) return null; // nothing left to add
                return (
                  <div key={cls}>
                    <div style={{ fontSize: 9, letterSpacing: '0.1em', color: '#6f8598', margin: '7px 0 3px' }}>
                      {SHIP_CLASSES[cls].displayName.toUpperCase()}
                    </div>
                    {!bareListed && (
                      <button
                        onClick={() => addEntry({ bareClass: cls })}
                        style={pickerRowStyle}
                      >
                        <ShipIcon shipClass={cls} size={16} />
                        <span style={{ fontSize: 11, color: '#9fb4c6' }}>Bare {SHIP_CLASSES[cls].displayName}</span>
                        <span style={{ marginLeft: 'auto', color: '#4ecdc4', fontSize: 14 }}>+</span>
                      </button>
                    )}
                    {clsDesigns.map(d => (
                      <button
                        key={d.id}
                        onClick={() => addEntry({ designId: d.id })}
                        style={pickerRowStyle}
                      >
                        <ShipIcon shipClass={cls} variant={d.iconVariant} size={16} />
                        <span style={{ fontSize: 11 }}>{d.name}</span>
                        <span style={{ fontSize: 9, color: '#8aa0b4', marginLeft: 6 }}>
                          {loadoutSummary(d.parts) || 'bare hull'}
                        </span>
                        <span style={{ marginLeft: 'auto', color: '#4ecdc4', fontSize: 14 }}>+</span>
                      </button>
                    ))}
                  </div>
                );
              })}
              <div style={{ textAlign: 'right', marginTop: 6 }}>
                <button
                  onClick={() => setPickerOpen(false)}
                  style={{
                    background: 'transparent', border: 'none', color: '#8aa0b4',
                    fontFamily: 'inherit', fontSize: 10, letterSpacing: '0.06em', cursor: 'pointer',
                  }}
                >CLOSE</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setPickerOpen(true)}
              style={{
                width: '100%', padding: 8, background: 'transparent',
                border: '1px dashed #35566e', borderRadius: 6, color: '#7fd4cf',
                fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.08em',
                cursor: 'pointer', marginBottom: 8,
              }}
            >+ ADD LOADOUT</button>
          )}

          {buildRows.length === 0 && !pickerOpen && (
            <div style={{ fontSize: 10, color: '#8aa0b4', padding: '4px 2px 8px' }}>
              Your build list is empty. Add a loadout above to start building.
            </div>
          )}

          <div className="build-classes">
            {buildRows.map(row => {
              const def = SHIP_CLASSES[row.shipClass];
              const pc = partsCost(row.parts);
              const rowCostOre = def.cost.ore + pc.ore;
              const rowCostCredits = def.cost.credits + pc.credits;
              const dstats = row.parts.length > 0
                ? computeDesignStats(row.shipClass, row.parts, techLevels) : null;
              const shortFuel = Math.max(0, def.cost.fuel - playerRes.fuel - localStock.fuel);
              const shortOre = Math.max(0, rowCostOre - playerRes.ore - localStock.ore);
              const shortCredits = Math.max(0, rowCostCredits - playerRes.credits - localStock.credits);
              const canAfford = shortFuel === 0 && shortOre === 0 && shortCredits === 0;
              const qty = getRowQty(row.key);
              const shortBits: string[] = [];
              if (shortFuel > 0) shortBits.push(`+${shortFuel} fuel`);
              if (shortOre > 0) shortBits.push(`+${shortOre} metal`);
              if (shortCredits > 0) shortBits.push(`+${shortCredits} cr`);
              const shortLabel = shortBits.length > 0 ? `Need ${shortBits.join(', ')}` : '';
              return (
                <div key={row.key} className={`build-class-row ${!canAfford ? 'disabled' : ''}`}>
                  <div className="class-info">
                    <ShipIcon shipClass={row.shipClass} variant={row.iconVariant} size={20} />
                    <span className="class-name">{row.name}</span>
                    <span style={{ fontSize: 8, color: '#4ecdc4', letterSpacing: '0.08em', marginLeft: 4 }}>
                      {def.displayName.toUpperCase()}
                    </span>
                  </div>
                  <div className="class-stats">
                    <span className="stat">FP:{dstats ? dstats.damagePerTick : SERVER_HULL_BASE[row.shipClass].damagePerTick}</span>
                    <span className="stat" title="Speed: how fast it arrives, and how hard it is to hit.">
                      SPD:{combatSpeedOf(row.shipClass, row.parts).toFixed(2)}
                    </span>
                    <span className="stat" title={hpTitle(row.shipClass, dstats)}>
                      HP:{deliveredHp(row.shipClass, dstats)}
                    </span>
                    {dstats && dstats.travelTimeMult < 1 && (
                      <span className="stat" title="Engine parts: travel-time multiplier">
                        ⏱×{dstats.travelTimeMult.toFixed(2)}
                      </span>
                    )}
                    {def.cargoCapacity > 0 && <span className="stat">CG:{def.cargoCapacity}</span>}
                  </div>
                  <div className="class-cost" title={shortLabel || undefined}>
                    {def.cost.fuel > 0 && (
                      <span className="cost-fuel" style={shortFuel > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}>{def.cost.fuel}F</span>
                    )}
                    <span className="cost-metal" style={shortOre > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}>{rowCostOre}M</span>
                    <span className="cost-money" style={shortCredits > 0 ? { color: '#ff5e5e', fontWeight: 700 } : undefined}>{rowCostCredits}C</span>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid #2a3d50', borderRadius: 4, marginRight: 4 }}>
                    <button
                      onClick={() => bumpRowQty(row.key, -1)}
                      disabled={qty <= 1}
                      aria-label="Fewer"
                      style={{ background: '#14202c', color: '#9fb4c6', border: 'none', width: 18, height: 20, cursor: 'pointer', fontSize: 12 }}
                    >−</button>
                    <span style={{ minWidth: 16, textAlign: 'center', fontSize: 11 }}>{qty}</span>
                    <button
                      onClick={() => bumpRowQty(row.key, 1)}
                      aria-label="More"
                      style={{ background: '#14202c', color: '#9fb4c6', border: 'none', width: 18, height: 20, cursor: 'pointer', fontSize: 12 }}
                    >+</button>
                  </div>
                  <button
                    className={`build-btn${recentlyQueued.has(row.key) ? ' build-btn--just-queued' : ''}`}
                    disabled={!canAfford}
                    onClick={() => handleBuildRow(row)}
                    title={canAfford
                      ? `${slotsFull ? 'Queue' : 'Build'} ${qty > 1 ? `${qty}× ` : ''}${row.name} (${rowCostOre}M ${rowCostCredits}C each)`
                      : shortLabel}
                  >
                    {qty > 1 ? `BUILD ×${qty}` : `BUILD · ${def.buildTime}t`}
                  </button>
                  <button
                    className="build-cancel"
                    onClick={() => removeRow(row)}
                    title="Remove this loadout from the build list (keeps the design)"
                  >✕</button>
                  {!canAfford && shortLabel && (
                    <div
                      className="build-shortage"
                      role="status"
                      style={{ flexBasis: '100%', margin: '2px 0 0', fontSize: 10, color: '#ff5e5e', letterSpacing: '0.04em' }}
                    >⚠ {shortLabel}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

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
        <span className="resource" style={{ color: RESOURCE_COLORS.fuel }}>FUEL: {Math.round(playerRes.fuel)}</span>
        <span className="resource" style={{ color: RESOURCE_COLORS.metal }}>METAL: {Math.round(playerRes.ore)}</span>
        <span className="resource" style={{ color: RESOURCE_COLORS.credits }}>CR: {Math.round(playerRes.credits)}</span>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------
// Rush construction (DESIGN-fleet-economy §3). ⚡ opens a small confirm
// popover — cost, new delivery, and the 25% half-hull risk — because a
// rush spends the ship's FULL price again with a real chance of wasting
// half of it; that stake deserves a deliberate second tap, and repeat
// rushes on the same order make a mis-tap expensive. (UX-juror verdict:
// confirm-popover over instant-apply.)
// ----------------------------------------------------------------

export const RushControl: React.FC<{
  order: import('../types').BuildOrder;
  remaining: number;
  constructionLvl: number;
}> = ({ order, remaining, constructionLvl }) => {
  const mpActions = useMultiplayerActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The world menu's fleet box is pinned to the BOTTOM of the screen, so
  // a popover that always opens downward can land off-viewport with its
  // CONFIRM unreachable (QA finding). Flip upward when there isn't room.
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  // Outside click closes the popover — without this, tapping ⚡ on two
  // queue rows stacked two open dialogs on top of each other (playtest
  // screenshot) and neither was dismissable except via its own CANCEL.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  if (!mpActions) return null;
  // Client-side quote: hull + the order's parts snapshot at the same
  // construction-tech discount the server applies. The senate's
  // build-cost / rush-cost sliders (default 1.0) aren't in the /state
  // payload, so this is exact in the common case and marked "≈".
  const def = SHIP_CLASSES[order.shipClass];
  const pc = partsCost(sanitizeParts(order.parts ?? []));
  const mult = Math.max(0.25, 1 - 0.05 * constructionLvl);
  const quoteOre = Math.ceil((def.cost.ore + pc.ore) * mult);
  const quoteCr = Math.ceil((def.cost.credits + pc.credits) * mult);
  const newRemaining = Math.max(1, Math.ceil(remaining / 2));
  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="build-rush"
        onClick={() => {
          setError(null);
          const r = wrapRef.current?.getBoundingClientRect();
          // ~170px covers the popover incl. an error line; flip up when
          // the space below the button is tighter than that.
          setOpenUp(!!r && window.innerHeight - r.bottom < 170);
          setOpen(o => !o);
        }}
        title={`Rush: pay the ship's price again to halve remaining build time (${(order.rushCount ?? 0) > 0 ? `rushed ×${order.rushCount} — ` : ''}25% risk of half-hull delivery)`}
        style={{
          background: 'rgba(255, 200, 80, 0.12)',
          border: '1px solid rgba(255, 200, 80, 0.5)',
          borderRadius: 4, color: '#ffcf70', cursor: 'pointer',
          fontSize: 11, padding: '2px 6px', whiteSpace: 'nowrap',
        }}
      >⚡{(order.rushCount ?? 0) > 0 ? `×${order.rushCount}` : ''}</button>
      {open && (
        <div
          role="dialog"
          aria-label="Confirm rush"
          style={{
            position: 'absolute', right: 0, zIndex: 40,
            ...(openUp ? { bottom: '110%' } : { top: '110%' }),
            width: 210, padding: '8px 10px',
            background: '#0d1722', border: '1px solid #3a5068',
            borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
            fontSize: 11, lineHeight: 1.5, color: '#c8d8e8',
          }}
        >
          <div style={{ fontWeight: 700, color: '#ffcf70', marginBottom: 4 }}>⚡ RUSH BUILD</div>
          <div>Cost: <b>≈{quoteOre}M {quoteCr}C</b> (full ship price)</div>
          <div>Delivery: T-{remaining.toFixed(0)} → <b>T-{newRemaining}</b></div>
          <div style={{ color: '#ff8a5c', marginTop: 2 }}>
            25% risk: delivered at <b>half hull</b>{order.botched ? ' (already botched — no further risk)' : ''}
          </div>
          {error && <div style={{ color: '#ff5e5e', marginTop: 4 }}>⚠ {error}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                mpActions.rushBuild(order.id).then(res => {
                  setBusy(false);
                  if (res.ok) setOpen(false);
                  else setError(humanizeMpError(res.code, res.error ?? 'Rush failed.', 'build'));
                });
              }}
              style={{
                flex: 1, background: 'rgba(255, 200, 80, 0.18)',
                border: '1px solid rgba(255, 200, 80, 0.6)', borderRadius: 4,
                color: '#ffcf70', cursor: 'pointer', padding: '3px 0', fontSize: 11,
              }}
            >{busy ? '…' : 'CONFIRM'}</button>
            <button
              disabled={busy}
              onClick={() => setOpen(false)}
              style={{
                flex: 1, background: 'transparent',
                border: '1px solid #3a5068', borderRadius: 4,
                color: '#9fb4c6', cursor: 'pointer', padding: '3px 0', fontSize: 11,
              }}
            >CANCEL</button>
          </div>
        </div>
      )}
    </div>
  );
};
