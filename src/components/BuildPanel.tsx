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
import { sanitizeParts, partsCost, computeDesignStats, loadoutSummary } from '../game/shipParts';
import { randomShipName } from '../game/shipNames';
import { HULL_FEATURE } from '../game/researchUnlocks';
import { useFeatureGate } from '../hooks/useFeatureGate';
import './BuildPanel.css';

export const BuildPanel: React.FC = () => {
  const { gameState, uiState, buildShip, cancelBuild } = useGameContext();
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
  useEffect(() => {
    if (recentlyQueued.size === 0) return;
    const t = setTimeout(() => setRecentlyQueued(new Set()), 600);
    return () => clearTimeout(t);
  }, [recentlyQueued]);

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
      mpActions.build({ bodyId: body.id, shipClass, shipName: name, iconVariant: variant })
        .then(res => {
          if (!res.ok) {
            setBuildError(humanizeMpError(res.code, res.error, 'build'));
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

      {/* LOCAL-first: sum the stockpiles of every player-owned
          settlement at this body so the affordability calc matches
          the server's spend logic in worker/actions.js handleQueueBuild. */}
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
                <span className="stat">FP:{designStats ? designStats.damagePerTick : def.firepower}</span>
                <span className="stat">HP:{designStats ? designStats.hp : def.hp}</span>
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
        <span className="resource">METAL: {Math.round(playerRes.ore)}</span>
        <span className="resource">CR: {Math.round(playerRes.credits)}</span>
      </div>
    </div>
  );
};
