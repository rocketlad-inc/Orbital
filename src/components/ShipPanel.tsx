import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { Ship, Body, Settlement, TradeRoute, TargetPriorityKey } from '../types';
import { TargetPriorityCards, autoTargetOrderFor } from './TargetPriorityCards';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { maintenanceRatesForShip, REPAIR_PER_TICK_PER_TENDER_BAY } from '../game/maintenance';
import { nearestShipyardBodyId, nearestRefitBodyId, isDamagedShip } from '../game/repair';
import { effectiveShipMaxHp, shipWorldPosition, attackerDamageFactors } from '../game/combat';
import { bodyPosition } from '../physics/orbitalMechanics';
import { torchTrajectorySamples } from '../render/mapRenderer';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import { solveRendezvous } from '../physics/rendezvous.js';
import { predictTarget, SETTLEMENT_COMBAT_SPEED } from '../game/targeting';
import { traitSummary, traitBrief, rankTier, rerollAvatarId } from '../game/captains';
import { CaptainAvatar } from './CaptainAvatar';
import {
  ShipPartId, SHIP_PART_DEFS, countPart, detonatorDamage, detonatorDisclosure,
  PART_GLYPH, SHIP_SLOT_COUNTS, ALL_PART_IDS, sanitizeParts,
  hitChanceOf, damageProfile, defenseMitigation, MITIGATION_FLOOR, refitFee,
} from '../game/shipParts';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { MINE_RATE_PER_TICK, BASE_HOLD } from '../game/mining';
import { RouteComposer } from '../multiplayer/RouteComposer';
import { apiFetch } from '../multiplayer/api';
import { ShipActivityLog } from './ShipActivityLog';
import { markNodeCancelPending, unmarkNodeCancelPending } from '../multiplayer/pendingNodeCancels';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { combatSpeedOf } from '../game/shipParts';
import { useIsMobile } from '../hooks/useIsMobile';
import { EditableName } from './EditableName';
import { ShipIcon } from './ShipIcons';
import { launchFromPlan } from '../physics/torchTransfer';
import { planExploreTour, type ExploreScope } from '../game/autoExplore';
import { canHostCity, canHostStation, isRawWorld, suggestSettlementName } from '../game/settlements';
import { useFeatureGate } from '../hooks/useFeatureGate';
import {
  BINARY_SYSTEM_BODY_IDS,
  BLACK_HOLE_SYSTEM_BODY_IDS,
} from '../state/mockGameState';
import {
  makeSystemRootOf, systemLabel, shipStatus, isArmed,
  makeHostilesAtBody, makeArmedHostilesAtBody, makeStationsAtBody,
} from '../game/systemGrouping';
import { makePeaceCheck } from '../game/peace';
import { BottomSheet } from './BottomSheet';
import { useGroupOwnsCardSlot } from './GroupSelectionPanel';
import './ShipPanel.css';
// .status-badge lives here. It reached this panel only because FleetPanel and
// two others happen to import it, which is a dependency by luck — state it.
import './OverviewPanel.css';
import { routeForShip } from '../game/routeSelectors';

// Order-independent key for a parts loadout, so two designs with the same
// multiset of parts compare equal regardless of slot order.
const partsKey = (parts: string[] | undefined): string =>
  [...sanitizeParts(parts ?? [])].sort().join(',');

/** Which face of the ship panel is showing. 'cargo' only exists for hulls
 *  that carry something — see CARGO_CLASSES. */
/** Captain portrait edge, in CSS px.
 *
 *  Was 44, set when avatars were 32x32 SVG busts. The imported portraits
 *  (public/portraits) are 128x128, so 44 was showing about a third of the
 *  resolution that shipped -- Lorne asked for them bigger and more
 *  prominent, and there was real detail being thrown away.
 *
 *  72 is the compromise: a 2.7x jump in area, exactly crisp on a 1x
 *  display, and only ~12% upscaled at 2x (144 wanted against 128 held),
 *  which is imperceptible on a face. Going much past this would be
 *  inventing detail the source does not have.
 *
 *  Shared by BOTH the posted and the empty-slot branch so the section does
 *  not change height the moment a captain is assigned. */
const CAPTAIN_PORTRAIT_PX = 72;
// Header chip portrait. The 122 captain portraits are detailed ink-and-wash
// busts -- at 14px a face was a smudge, which defeats the point of letting
// players pick one. 28px is the smallest size where the features read, and
// the chip already wraps to its own line under the ship name, so it costs
// no horizontal room.
const CAPTAIN_CHIP_PX = 28;

type ShipPanelTab = 'orders' | 'ship' | 'cargo' | 'log';

/** Tab order, left to right. Reads as a sentence about the hull: what it's
 *  doing, what it is, what it's carrying, what it's done. */
const SHIP_TABS: Array<{ key: ShipPanelTab; label: string }> = [
  { key: 'orders', label: 'ORDERS' },
  { key: 'ship',   label: 'SHIP' },
  { key: 'cargo',  label: 'CARGO' },
  { key: 'log',    label: 'LOG' },
];

export const ShipPanel: React.FC = () => {
  const {
    gameState, uiState, deselectShip, setGameState,
    deleteManeuverNode, setTargetSelectionMode,
    launchTorchTransfer, enqueueTorchTransfer, queueTorchTour, planLegFor,
    planTorchPreview, cancelTorchPreview, previewRendezvous,
    recallLaunch,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    createTradeRoute, cancelTradeRoute, renameShip,
    focusBody, updateCamera,
  } = useGameContext();

  // In multiplayer this is non-null and we post intent to the server in
  // addition to mutating local state (so the UI feels responsive while
  // waiting for the next /state poll to reconcile).
  const mpActions = useMultiplayerActions();
  const groupOwnsSlot = useGroupOwnsCardSlot();
  const isMobile = useIsMobile();
  const deployGate = useFeatureGate();

  // === PANEL TABS ===========================================
  // The panel had grown to eighteen stacked sections in one scroll, with
  // related controls scattered: three separate combat surfaces, three
  // trade surfaces, and the two halves of the loadout eleven sections
  // apart. Tabs group them by the question the player is actually asking
  // — what is it DOING (orders), what IS it (ship), what has it DONE
  // (log) — so a new feature has an obvious home instead of becoming
  // section nineteen.
  //
  // Defaults to 'orders' ALWAYS, deliberately. A panel that opens on a
  // different tab depending on the hull's state is harder to use than one
  // that's occasionally on the wrong tab: muscle memory beats cleverness.
  const [shipTab, setShipTab] = useState<ShipPanelTab>('orders');
  // Tutorial steps that point at a control on a non-default tab ask the panel
  // to switch first — otherwise the coachmark cuts a hole in the backdrop
  // around an element that is mounted but hidden. Mirrors the
  // 'orbital:open-panel' contract the other panels already use. Declared up
  // here with the other hooks: this component early-returns when no ship is
  // selected, and a hook below that return fires in a different order
  // between renders (rules-of-hooks).
  useEffect(() => {
    const onTab = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab === 'orders' || tab === 'ship' || tab === 'cargo' || tab === 'log') {
        setShipTab(tab);
      }
    };
    window.addEventListener('orbital:ship-panel-tab', onTab);
    return () => window.removeEventListener('orbital:ship-panel-tab', onTab);
  }, []);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [fleetModalOpen, setFleetModalOpen] = useState(false);
  const [propagateTransferToFleet, setPropagateTransferToFleet] = useState(true);
  // Server-side transfer rejection — shown inline above the COMMIT
  // button when MP rejects the burn (e.g. ship was captured between
  // plan and commit). Without this the TRANSFER / COMMIT click looks
  // like it worked but the next /state poll silently rewinds the
  // optimistic local state.
  const [transferError, setTransferError] = useState<string | null>(null);
  // Recall-in-flight guard. Declared with the other hooks (this component
  // has early returns further down, so it cannot live beside its usage).
  const [recalling, setRecalling] = useState(false);
  // Auto-explore (corvettes): how far the survey ranges, and the
  // result line after one is dispatched.
  const [exploreScope, setExploreScope] = useState<ExploreScope>('system');
  // Which in-flight ship the RENDEZVOUS picker is aimed at.
  const [rendezvousId, setRendezvousId] = useState<string | null>(null);
  const [rendezvousBusy, setRendezvousBusy] = useState(false);
  const [rendezvousOpen, setRendezvousOpen] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  // A WAIT staged but not yet spent. It is a MODIFIER on the next leg,
  // not a step of its own: "wait 3 ticks" with nothing after it is just
  // a ship sitting still, which it was already doing. So it is held here
  // until a destination is picked, then consumed.
  const [pendingWait, setPendingWait] = useState(0);
  const [waitPickerOpen, setWaitPickerOpen] = useState(false);
  const [refitBusy, setRefitBusy] = useState(false);
  const [exploreNotice, setExploreNotice] = useState<string | null>(null);
  // Colony ship "deploy settlement" — inline result/rejection line.
  const [deployNotice, setDeployNotice] = useState<string | null>(null);
  // Captain assign/bench used to fire and forget, so a server refusal —
  // now including "this hull is in combat" — was invisible from here: the
  // click just did nothing.
  const [captainNotice, setCaptainNotice] = useState<string | null>(null);
  const [deployBusy, setDeployBusy] = useState(false);
  // Server-side standing-orders rejection (MP only). Shown inline in the
  // ORDERS section; the next /state poll rewinds the optimistic change.
  const [ordersError, setOrdersError] = useState<string | null>(null);
  // Fleet actions had NO error surface, which is half of why they read
  // as dead: a 409 ("flagship has no captain", "ship is in combat")
  // looked exactly like a button that did nothing.
  const [fleetError, setFleetError] = useState<string | null>(null);

  const ship = uiState.selectedShipId
    ? gameState.ships.find(s => s.id === uiState.selectedShipId) || null
    : null;

  /**
   * THE SHIP'S PLAN, as an ordered list of steps.
   *
   * Assembled from state that already exists rather than anything new:
   *   ship.transit         the burn under way  -> step 1, COMMITTED
   *   ship.plannedTransit  staged, not yet committed -> still re-aimable
   *   ship.queuedTransits  chained legs, each scheduled to start when the
   *                        previous one lands (the server holds them as
   *                        nodes with a future scheduled_t)
   *
   * That queue has been drawable on the map for a while -- the dashed
   * chained arcs -- and has never been READABLE as a list. A player could
   * see their plan and not read it.
   *
   * Order matters here and is the reason these are numbered, so the array
   * is built in execution order: what is happening now, then what happens
   * next.
   */
  const programSteps = useMemo(() => {
    if (!ship) return [] as Array<{
      key: string; kind: 'goto' | 'wait'; dest: string; label: string; meta: string; committed: boolean;
    }>;
    const now = gameState.currentTick;
    const nameOf = (id: string | undefined | null) =>
      (id ? gameState.bodies.find(b => b.id === id)?.name : null) ?? 'unknown';
    const eta = (arrive: number | undefined) =>
      arrive == null ? '' : `arrives T+${Math.round(arrive)} (${Math.max(0, Math.round(arrive - now))}t)`;

    const out: Array<{ key: string; kind: 'goto' | 'wait'; dest: string; label: string; meta: string; committed: boolean }> = [];

    // A WAIT IS NOT STORED. It is the GAP between when the previous leg
    // parks the ship and when the next burn fires -- which the plans
    // already carry as arriveTick and startTick. Deriving it means a
    // program reloaded from the server shows its waits without the
    // server ever having to know the word "wait", and means the drawn
    // gap and the written gap cannot disagree.
    let readyAt = now;
    const pushWait = (departAt: number, key: string) => {
      const n = Math.round(departAt - readyAt);
      if (n < 1) return;
      out.push({
        key: `w${key}`, kind: 'wait', dest: '', label: `Wait ${n} tick${n === 1 ? '' : 's'}`,
        meta: `then departs T+${Math.round(departAt)}`, committed: false,
      });
    };

    const live = ship.transit?.currentTransfer;
    if (live) {
      const d = nameOf(live.targetBodyId);
      out.push({ key: 'live', kind: 'goto', dest: d, label: `Go to ${d}`, meta: eta(live.arriveTick), committed: true });
      readyAt = live.arriveTick;
    } else if (ship.plannedTransit) {
      const d = nameOf(ship.plannedTransit.targetBodyId);
      pushWait(ship.plannedTransit.startTick, 'p');
      // Staged, not committed: say so, because this one CAN still be changed
      // and the committed one cannot. That difference is the whole rule.
      out.push({ key: 'planned', kind: 'goto', dest: d, label: `Go to ${d}`, meta: 'staged — not committed', committed: false });
      readyAt = ship.plannedTransit.arriveTick;
    }
    for (const [i, q] of (ship.queuedTransits ?? []).entries()) {
      const d = nameOf(q.targetBodyId);
      pushWait(q.startTick, `q${i}`);
      out.push({
        key: `q${i}`, kind: 'goto', dest: d, label: `Go to ${d}`,
        meta: `departs T+${Math.round(q.startTick)}`, committed: false,
      });
      readyAt = q.arriveTick;
    }
    return out;
  }, [ship, gameState.bodies, gameState.currentTick]);

  // A staged rendezvous belongs to the ship whose panel raised it. Drop
  // it when the panel moves to another hull or closes, or the arc hangs
  // on the map describing a plan nobody is looking at any more.
  const rvShipId = ship?.id ?? null;
  useEffect(() => {
    setRendezvousId(null);
    if (!rvShipId) return undefined;
    return () => { previewRendezvous(rvShipId, null); };
  }, [rvShipId, previewRendezvous]);

  // SOLVED ONCE PER TICK, NOT ONCE PER FRAME.
  //
  // This used to live in an IIFE inside the JSX, so every render of the
  // panel re-solved a rendezvous for every hull in flight. Measured at
  // 9.8 ms per solve, that is 442 ms of arithmetic per render against 45
  // ships in flight — twenty-six frames' worth of budget, burned to
  // redraw a list whose contents only change when the tick does.
  //
  // The multi-start that made the solver correct also made it eight
  // times dearer, so the two changes together turned a slow panel into
  // an unusable one. Correctness stays; it just runs when its inputs
  // move, which is on the tick.
  // WHAT ACTUALLY CHANGES THE ANSWER: which hulls are in flight, where
  // they are going, and when they land. Keying the solve on
  // gameState.ships meant staging a preview — which rewrites that array
  // — invalidated it, so CHOOSING a candidate re-ran every candidate's
  // solve. At 9.8ms each against Peace Zone's 45 in-flight hulls that is
  // ~450ms of blocking work for a click that changed nothing about the
  // question.
  const flightSignature = gameState.ships
    .filter(t => t.transit?.currentTransfer?.targetBodyId)
    .map(t => `${t.id}:${t.transit!.currentTransfer!.targetBodyId}:${t.transit!.currentTransfer!.arriveTick}`)
    .join('|');

  const rendezvousCandidates = useMemo(() => {
    // Collapsed is the default, and the solve is the most expensive
    // thing this panel does — so do not do it until asked.
    if (!rendezvousOpen) return [];
    if (!ship || ship.transit) return [];
    const now = gameState.currentTick;
    return gameState.ships
            .filter(t => t.id !== ship.id && t.transit && (t.hp ?? 1) > 0
                      && !!t.transit.currentTransfer?.targetBodyId)
            .map(t => {
              const tr = t.transit!.currentTransfer;
              const dest = gameState.bodies.find(b => b.id === tr.targetBodyId);
              if (!dest) return null;
              const theirEta = tr.arriveTick;
              if (theirEta <= now) return null;          // already parking
              const myPlan = planLegFor(ship.id, dest.id);
              if (!myPlan) return null;                   // no course at all
              // Sampled once per candidate — the solver asks ~29 times.
              const theirSamples = torchTrajectorySamples(tr, gameState.bodies);
              if (!theirSamples || theirSamples.length < 2) return null;

              // TRUE RENDEZVOUS first: a burn/coast/burn that matches
              // their velocity in open space, so the two fly the rest
              // of the leg together instead of merely sharing a door.
              //
              // It usually returns null, and that is the design: for
              // most geometries no pair of burns closes both the
              // position and the velocity gap in time. Falling back to
              // the destination is not a consolation prize — per the
              // chase analysis, the door is where the value is anyway.
              const rv = solveRendezvous(
                { x: myPlan.startPos.x, y: myPlan.startPos.y },
                { x: myPlan.startVel.x, y: myPlan.startVel.y },
                myPlan.acceleration,
                // SOLVE AGAINST WHERE THE HULL IS DRAWN.
                //
                // ship.transit.pos is a separate integration that drifts
                // from the polyline the renderer lerps the sprite along
                // — the same divergence that once put sensor rings ahead
                // of their own ship. Solving against it placed the
                // meeting somewhere the target visibly was not, which is
                // exactly how this surfaced: a crosshair in empty space.
                (tick) => {
                  const q1 = torchPositionFromSamples(theirSamples, tick);
                  const h = 0.01;
                  const q2 = torchPositionFromSamples(theirSamples, tick + h);
                  return {
                    pos: { x: q1.x, y: q1.y },
                    vel: { x: (q2.x - q1.x) / h, y: (q2.y - q1.y) / h },
                  };
                },
                now,
                theirEta,
              );

              // The filter that makes this list worth reading: arriving
              // after they have parked is not a rendezvous, it is a late
              // visit to an empty orbit.
              if (!rv && myPlan.arriveTick > theirEta) return null;
              const meetIn = rv
                ? Math.max(0, rv.meetTick - now)
                : Math.max(0, theirEta - now);
              return { t, dest, theirEta, myPlan, rv, meetIn };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .sort((a, b) => a.meetIn - b.meetIn);
  // planLegFor is stable; bodies only matter through the plans. And
  // gameState.ships is read inside but deliberately NOT a dep:
  // flightSignature is its meaningful projection, and depending on the
  // array itself is the ~450ms-per-click bug this replaces.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendezvousOpen, ship?.id, ship?.transit, flightSignature, gameState.currentTick, gameState.bodies]);

  const transferHandlerRef = useRef<(bodyId: string) => void>(() => {});

  useEffect(() => {
    if (!ship) return;

    transferHandlerRef.current = (targetBodyId: string) => {
      // Two flows depending on the ship's state:
      //
      // 1. SHIP IN TRANSIT (or has queued legs): chain-extension.
      //    enqueueTorchTransfer plans a new leg from the prior leg's
      //    predicted arrival; visible immediately as a queued dashed
      //    preview on the map. Auto-commits — there's no separate
      //    confirm step for chained legs.
      //
      // 2. SHIP PARKED: stage a torch preview via planTorchPreview.
      //    The ship's plannedTransit field holds the plan; the map
      //    renderer shows the dashed amber arc. The COMMIT button
      //    promotes it via launchTorchTransfer.
      if (ship.transit || ship.plannedTransit || (ship.queuedTransits && ship.queuedTransits.length > 0)) {
        const queuedPlan = enqueueTorchTransfer(ship.id, targetBodyId, pendingWait);
        setPendingWait(0);
        // Post immediately ONLY when chaining onto a live in-flight
        // burn — the server already knows about ship.transit so the
        // queued leg's scheduledT = arriveTick is a coherent future
        // event for it. When chaining onto a still-uncommitted
        // plannedTransit, the server has no idea the prior leg exists;
        // posting now would make the server treat the chained leg as
        // primary and the /state poll would wipe the local plannedTransit.
        // commitTransferLocal posts the full chain when the player
        // hits COMMIT.
        if (queuedPlan && mpActions && ship.transit) {
          setTransferError(null);
          mpActions.transfer({
            shipId: ship.id,
            targetBodyId,
            scheduledT: queuedPlan.startTick,
            arrivalT: queuedPlan.arriveTick,
            launch: launchFromPlan(queuedPlan),
            dvPrograde: queuedPlan.totalDv,
            fuelCost: Math.round(queuedPlan.totalDv * 10),
          }).then(res => {
            if (!res.ok) {
              setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
            }
          });
        }
        setTransferModalOpen(false);
        setTargetSelectionMode(false);
        return;
      }

      // Parked ship: stage a torch preview (NOT committed). Player
      // clicks COMMIT to promote it to a live burn (commitTransferLocal).
      const plan = planTorchPreview(ship.id, targetBodyId, pendingWait);
      setPendingWait(0);
      if (!plan) {
        // Used to be a console.warn and a bare return — the player
        // clicked a destination and got NOTHING: no arc, no error, no
        // rule they could infer. Whatever the cause (no engine accel,
        // body gone from the list, already there), say so on the panel.
        console.warn('[transfer] planTorchPreview returned null', {
          shipId: ship.id, target: targetBodyId,
        });
        const targetName = gameState.bodies.find(bd => bd.id === targetBodyId)?.name
          ?? 'that destination';
        setTransferError(
          `Couldn't plot a course to ${targetName}. If this ship is already there, pick somewhere else.`,
        );
        setTransferModalOpen(false);
        setTargetSelectionMode(false);
        return;
      }

      // Fleet propagation: stage previews for every fleet member from
      // their own orbits so the player can COMMIT ALL in one click.
      if (propagateTransferToFleet && ship.fleetId) {
        const fleet = gameState.fleets.find(f => f.id === ship.fleetId);
        if (fleet) {
          for (const memberId of fleet.shipIds) {
            if (memberId === ship.id) continue;
            const member = gameState.ships.find(s => s.id === memberId);
            if (!member || member.transit) continue;
            planTorchPreview(member.id, targetBodyId);
          }
        }
      }

      setTransferModalOpen(false);
      setTargetSelectionMode(false);
    };
  }, [
    ship, gameState, planTorchPreview, enqueueTorchTransfer,
    setTargetSelectionMode, propagateTransferToFleet, mpActions, pendingWait,
  ]);

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

  // GroupSelectionPanel takes the ship-card slot when 2+ live hulls are
  // selected — the group is what you're commanding, and showing whichever
  // single ship you last clicked contradicted the action bar. Same live
  // resolution both sides, so the slot can never end up empty.
  if (groupOwnsSlot) return null;
  if (!ship) return null;

  const handleTransferManeuver = (targetBodyId: string) => {
    transferHandlerRef.current(targetBodyId);
  };

  /**
   * Commit a planned transfer locally + post the intent to the server
   * (multiplayer only). Two-step action preserved: planning a transfer
   * stages a torch preview (ship.plannedTransit, dashed preview arc),
   * COMMIT promotes that preview to a live burn via launchTorchTransfer.
   * Previously the server post happened at plan time, which made every
   * transfer auto-fire ~1.5s later when /state polled back the server's
   * 'committed' record.
   */
  const commitTransferLocal = (owningShip: typeof ship) => {
    // The planned preview holds the target body. Promote via
    // launchTorchTransfer (the context method clears plannedTransit
    // and sets ship.transit atomically).
    const preview = owningShip.plannedTransit;
    if (!preview) {
      console.warn('[transfer] commitTransferLocal: no plannedTransit on ship', owningShip.id);
      return;
    }
    // The staged preview may carry a LEADING WAIT. Re-derive it from the
    // plan rather than reading a second piece of state: the gap between
    // now and the planned departure IS the wait, so the two cannot
    // disagree, and it survives a re-render that clears pendingWait.
    const leadWait = Math.max(0, Math.round(preview.startTick - gameState.currentTick));
    const plan = launchTorchTransfer(owningShip.id, preview.targetBodyId, leadWait);
    if (!plan) {
      console.warn('[transfer] launchTorchTransfer rejected', { shipId: owningShip.id, target: preview.targetBodyId });
      return;
    }
    if (!mpActions) return;
    // Snapshot the queue BEFORE we post — launchTorchTransfer didn't
    // touch queuedTransits, but each one needs to land on the server
    // too so the alarm fires the chained burn at the right tick. Each
    // q.startTick is already chained from the previous leg's arriveTick
    // (set at enqueue time in gameContext), so we can post each leg
    // verbatim and the server's alarm scheduler does the right thing.
    const queuedAtCommit = owningShip.queuedTransits ?? [];

    // Post the torch-derived arrival to the server so its DB row, the
    // alarm's in_transit→arrive transition, and the other clients' MP
    // reconstruction all agree exactly.
    setTransferError(null);
    // The primary leg REPLACES the ship's current route (cancels any prior
    // committed/in-transit legs server-side). AWAIT it before posting the
    // chained legs so the cancel lands first — otherwise a queued leg could
    // race ahead of the replace and get cancelled with the old route.
    (async () => {
      const first = await mpActions.transfer({
        shipId: owningShip.id,
        targetBodyId: preview.targetBodyId,
        scheduledT: plan.startTick,
        arrivalT: plan.arriveTick,
        launch: launchFromPlan(plan),
        // dvPrograde is a Δv magnitude on the server; the maneuver-node
        // display reconstructs `deltav = sqrt(prograde²+normal²+radial²)`
        // and we want it to read the full burn cost, not half of it.
        dvPrograde: plan.totalDv,
        fuelCost: Math.round(plan.totalDv * 10),
        replace: true,
      });
      if (!first.ok) {
        setTransferError(humanizeMpError(first.code, first.error, 'transfer'));
      }
      // Post each queued leg. These were chained off plannedTransit's
      // arriveTick at enqueue time, so their scheduledT lines up with
      // when the previous leg parks the ship. replace:false → append.
      for (const q of queuedAtCommit) {
        const res = await mpActions.transfer({
          shipId: owningShip.id,
          targetBodyId: q.targetBodyId,
          scheduledT: q.startTick,
          arrivalT: q.arriveTick,
          launch: launchFromPlan(q),
          dvPrograde: q.totalDv,
          fuelCost: Math.round(q.totalDv * 10),
          replace: false,
        });
        if (!res.ok) {
          setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
        }
      }
    })();
  };

  const isOwn = ship.ownedBy === 'player';

  // Plain computation, not useMemo — this sits after the panel's early
  // `if (!ship) return null`, so a hook here would break the rules of
  // hooks (same reasoning as the other post-guard computations here).
  // Cheap: bodies × at most MAX_TOUR_LEGS.
  const exploreTour = (isOwn && ship.class === 'corvette')
    ? planExploreTour(ship, gameState.bodies, gameState.settlements, gameState.currentTick, exploreScope)
    : [];

  // ---- Colony ship: deploy a settlement where it's parked ----
  // Same gates the world menu applies from the body side, read from the
  // ship's own orbit so the action lives where the player is looking.
  // A colony ship is CONSUMED either way, so both types are offered
  // when both are legal and the ship isn't mid-burn.
  const colonyBody = (isOwn && ship.class === 'colony' && !ship.transit && ship.orbit.parentBodyId)
    ? gameState.bodies.find(b => b.id === ship.orbit.parentBodyId) ?? null
    : null;
  const cityHere = !!colonyBody
    && gameState.settlements.some(s => s.bodyId === colonyBody.id && s.type === 'city');
  const stationHere = !!colonyBody
    && gameState.settlements.some(s => s.bodyId === colonyBody.id && s.type === 'station');
  // Construction 1 now gates CITIES, not stations — a colony ship must
  // be able to claim a raw world on turn one.
  const cityLock = deployGate.lockReason('settlement.city');
  // Raw worlds take stations only (the terraforming hard gate) — the
  // city option simply isn't offered, so a colony ship arriving at a
  // raw world "deploys a station instead" with zero extra UI.
  const canDeployCity = !!colonyBody && canHostCity(colonyBody) && !cityHere
    && !isRawWorld(colonyBody) && !cityLock;
  const canDeployStation = !!colonyBody && canHostStation(colonyBody) && !stationHere;
  const deployTypes: Array<'city' | 'station'> = [
    ...(canDeployCity ? ['city' as const] : []),
    ...(canDeployStation ? ['station' as const] : []),
  ];

  /**
   * Queue the survey: plan every leg locally in one shot, then post
   * them in order. Leg 1 carries replace:true so it cancels whatever
   * route the hull had; the rest append. Awaited in sequence for the
   * same reason commitTransferLocal does it — a queued leg racing ahead
   * of the replace would get cancelled along with the old route.
   */
  const startAutoExplore = () => {
    if (!ship) return;
    setExploreNotice(null);
    setTransferError(null);
    const tour = exploreTour;
    if (tour.length === 0) return;

    const plans = queueTorchTour(ship.id, tour);
    if (plans.length === 0) {
      setExploreNotice('Could not plot a course to any of those worlds');
      return;
    }
    const firstName = gameState.bodies.find(b => b.id === plans[0].targetBodyId)?.name ?? 'the first stop';
    setExploreNotice(
      `Surveying ${plans.length} world${plans.length === 1 ? '' : 's'} — next stop ${firstName}`
      + (plans.length < tour.length ? ` (${tour.length - plans.length} unreachable)` : ''),
    );
    if (!mpActions) return;

    (async () => {
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        const res = await mpActions.transfer({
          shipId: ship.id,
          targetBodyId: p.targetBodyId,
          scheduledT: p.startTick,
          arrivalT: p.arriveTick,
          launch: launchFromPlan(p),
          dvPrograde: p.totalDv,
          fuelCost: Math.round(p.totalDv * 10),
          replace: i === 0,
        });
        if (!res.ok) {
          setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
          break;
        }
      }
    })();
  };

  /**
   * Found a settlement under this colony ship. The server owns the
   * whole transaction — it validates the body, creates the settlement
   * and consumes the hull — so there's no optimistic local deploy here:
   * a client-side mirror would double-count the settlement for ~1.5s
   * until /state caught up, and this ship is about to stop existing.
   */
  const deploySettlementHere = async (type: 'city' | 'station') => {
    if (!ship || !colonyBody || !mpActions || deployBusy) return;
    setDeployBusy(true);
    setDeployNotice(null);
    const name = suggestSettlementName(colonyBody, type, gameState.settlements);
    const res = await mpActions.deploySettlement({ bodyId: colonyBody.id, type, name });
    setDeployBusy(false);
    if (res.ok) {
      // Deliberately doesn't name the hull: the server consumes the
      // first colony ship it finds at the body (LIMIT 1), which isn't
      // necessarily the one selected here when two share an orbit.
      setDeployNotice(`${name} founded on ${colonyBody.name} — a colony ship was consumed`);
    } else {
      setDeployNotice(humanizeMpError(res.code, res.error, 'deploy'));
    }
  };

  const handleRemoveQueuedTransfer = (index: number) => {
    const queue = ship.queuedTransits || [];
    if (index >= queue.length) return;
    // A queued leg launches from the previous leg's arrival point, so
    // removing one orphans every leg chained after it — drop the tail too.
    const removed = queue.slice(index);
    const newQueue = queue.slice(0, index);
    // Optimistic local removal.
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s =>
        s.id === ship.id
          ? { ...s, queuedTransits: newQueue.length > 0 ? newQueue : undefined }
          : s
      ),
    });
    // Multiplayer: the queued legs are 'committed' server rows. Without a
    // server-side cancel the next /state poll reconstructs them and they
    // "come back." Cancel each removed leg's node and mark it pending so
    // reconstruction suppresses it until the cancel lands (no flicker).
    if (mpActions) {
      for (const leg of removed) {
        if (!leg.nodeId) continue;  // local-only preview leg — nothing to cancel
        const nodeId = leg.nodeId;
        markNodeCancelPending(nodeId);
        mpActions.cancelNode(nodeId).then(res => {
          if (!res.ok) {
            // Server kept the leg — stop suppressing it so it reappears
            // instead of silently executing while hidden.
            unmarkNodeCancelPending(nodeId);
            // eslint-disable-next-line no-console
            console.warn('cancelNode (queued leg) rejected by server:', res.error);
          }
        });
      }
    }
  };

  /**
   * Fleets live on the SERVER in multiplayer.
   *
   * Every button in this section used to call straight into
   * gameContext's createFleet/addToFleet/removeFromFleet/disbandFleet,
   * which mutate LOCAL state only. In a multiplayer game the server
   * never heard about it and the next /state sync overwrote the result,
   * so the fleet appeared for an instant and then was gone — reported
   * as "the form fleet button doesn't do anything". The identical
   * controls in FleetPanel always went through the API; this panel was
   * simply never rewired.
   *
   * Single-player still gets the local calls, so the fallback stays.
   */
  const fleetApi = async (
    method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown,
  ): Promise<boolean> => {
    if (!mpActions) return false;
    setFleetError(null);
    const res = await apiFetch(`/api/games/${mpActions.gameId}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      setFleetError(res.error?.message ?? 'fleet action failed');
      return false;
    }
    return true;
  };

  const handleFormFleet = (peerIds: string[]) => {
    if (peerIds.length === 0) return;
    const allIds = [ship.id, ...peerIds];
    // Auto-generate a fleet name like "Earth Group" from the parent body
    const parent = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);
    const name = `${parent?.name ?? 'Fleet'} Group`;
    if (mpActions) {
      // The flag must have a captain or the server refuses the whole
      // fleet. Prefer the ship whose panel this is — the player picked
      // it — and fall back to the highest-ranked peer that has one.
      const members = allIds
        .map(id => gameState.ships.find(s => s.id === id))
        .filter((s): s is NonNullable<typeof s> => !!s);
      const captained = members.filter(s => !!s.captainName);
      const pool = captained.length > 0 ? captained : members;
      const flag = pool.includes(ship)
        ? ship
        : pool.reduce((best, s) => ((s.rank ?? 0) > (best.rank ?? 0) ? s : best), pool[0]);
      void fleetApi('POST', '/fleets', {
        ship_ids: allIds, flag_ship_id: flag.id, name,
      });
    } else {
      createFleet(name, allIds);
    }
    setFleetModalOpen(false);
  };

  const handleAddPeersToFleet = (peerIds: string[]) => {
    if (!ship.fleetId) return;
    if (mpActions) {
      void fleetApi('PATCH', `/fleets/${encodeURIComponent(ship.fleetId)}`,
        { add_ship_ids: peerIds });
    } else {
      for (const id of peerIds) addToFleet(ship.fleetId, id);
    }
    setFleetModalOpen(false);
  };

  // "Has existing transfer" gates the TRANSFER button — a ship already
  // committed to a destination (live torch burn OR staged preview)
  // can't accept a new plan. Chained legs come in through the
  // ship.transit branch via enqueueTorchTransfer.
  const hasExistingTransfer = !!(ship.transit || ship.plannedTransit);

  // Only the LIVE burn feeds the location line now. The old
  // `transitTarget ?? previewTarget` fallback is gone deliberately: a merely
  // planned transfer is not a location, and folding it in here is what made
  // a parked ship claim to be travelling.
  // ETA: ticks-until-arrival for live transits; ticks-until-burn-start
  // for previews (which is just 0 since torch fires on commit).
  const eta = ship.transit
    ? ship.transit.currentTransfer.arriveTick - gameState.currentTick
    : ship.plannedTransit
      ? ship.plannedTransit.arriveTick - gameState.currentTick
      : null;

  const transitTarget = ship.transit?.currentTransfer.targetBodyId;
  const nameOfBody = (id: string | undefined) =>
    (id && gameState.bodies.find(b => b.id === id)?.name) || null;
  // LOCATION answers "where is this hull", in words rather than an arrow and
  // a shouted id. Two cases only:
  //   in flight  -> "En route to Mars"
  //   parked     -> "Orbiting Ganymede"
  //
  // A PLANNED transfer no longer reads as travel. The old label lumped
  // plannedTransit in with a live burn and said "→ Mars" for a ship still
  // sitting in its parking orbit, which is a lie about the most important
  // fact on the panel. Where it IS goes here; what it's ABOUT to do is the
  // STATUS row below ("Planned").
  //
  // Falls back to the raw id only if a body is genuinely missing from state
  // (fog, a mid-poll gap) — the old code showed the uppercased ID for EVERY
  // parked ship, so "Orbiting SOL:JUPITER:GANYMEDE" was the normal case.
  const etaSuffix = eta != null && eta > 0 ? ` · T-${eta.toFixed(0)}` : '';
  const locationLabel = ship.transit
    ? `En route to ${nameOfBody(transitTarget) ?? 'unknown'}${etaSuffix}`
    : `Orbiting ${nameOfBody(ship.orbit.parentBodyId) ?? ship.orbit.parentBodyId}`;


  // RECALL WINDOW. The client paints a launch onto its arc immediately,
  // but the server holds the node as 'committed' and only burns it at the
  // top of the next tick — 30s to a full hour depending on the game. That
  // window is real; it was just invisible, so nobody knew a launch could
  // still be called back. Offer it while the node has not departed.
  const pendingNode = isOwn
    ? ship.orders.find(o => o.type === 'transfer'
        && o.status === 'committed' && o.departed !== true)
    : undefined;
  const canRecall = !!(pendingNode && mpActions && ship.transit);

  const doRecall = async () => {
    if (!pendingNode || !mpActions) return;
    setRecalling(true);
    const res = await mpActions.cancelNode(pendingNode.id);
    setRecalling(false);
    // Only drop the local arc once the SERVER agrees the burn is off.
    // Clearing optimistically on a failed cancel would show the ship
    // parked while it was actually still flying.
    if (res.ok) recallLaunch(ship.id);
    else setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
  };

  // Queue (torch chained legs).
  const queuedTransits = ship.queuedTransits || [];

  // Ship class stats
  const shipClass = getShipClass(ship.class as ShipClassName);
  // Cargo only exists for hulls that carry something. activeTab (rather than
  // shipTab) is what the render reads: selecting a corvette while parked on
  // a freighter's Cargo tab would otherwise leave the panel showing a tab
  // that no longer exists, i.e. blank. Deriving instead of syncing in an
  // effect means there is never a frame in the invalid state.
  // CARGO exists only where it has contents. Every block on that tab is
  // gated `freighter && own`, so the first cut — keyed on ship class alone,
  // with 'colony' in the set — gave a colony ship AND a rival's freighter a
  // tab that opened onto nothing. That is the empty-tab trap this file's own
  // comment warns about, introduced two commits after writing it.
  //
  // Colony ships don't want one: their cargo IS the settlement they deploy,
  // and that button lives in ORDERS.
  const hasCargo = ship.class === 'freighter' && isOwn;
  // ORDERS is every control you'd issue to a hull, and every one of them is
  // already gated on ownership — so on a rival's ship the tab was a click
  // that led to nothing. Hidden outright rather than shown-and-empty.
  //
  // The COMBAT readout deliberately stays on SHIP rather than moving in with
  // the orders: CurrentTargetRow renders for rivals too (it's how you see
  // what an enemy hull is shooting), and folding it into a tab rivals can't
  // open would have quietly deleted that.
  const hasOrders = isOwn;
  const tabExists = (t: ShipPanelTab) =>
    (t !== 'cargo' || hasCargo) && (t !== 'orders' || hasOrders);
  // Derived, not synced: selecting a rival while on ORDERS must never leave
  // the panel pointed at a tab that isn't there.
  const activeTab: ShipPanelTab = tabExists(shipTab)
    ? shipTab
    : (hasOrders ? 'orders' : 'ship');


  // Configuration name: match this hull's loadout to one of the player's
  // saved designs (same class + same parts multiset) so the CLASS row can
  // read "Brawler MkII" instead of a bare "DESTROYER". Only for the
  // player's own ships — enemy designs live in their (hidden) library, so
  // matching a rival hull against our names would mislabel it. Prefer the
  // active design when several share a loadout. Null → fall back to class.
  // Plain computation (not useMemo) because this sits after the panel's
  // early-return guards, where hooks can't run; the filter is tiny.
  const configName: string | null = (() => {
    if (ship.ownedBy !== 'player') return null;
    const key = partsKey(ship.parts);
    const matches = (gameState.shipDesigns ?? []).filter(
      d => d.shipClass === ship.class && partsKey(d.parts) === key,
    );
    if (matches.length === 0) return null;
    return (matches.find(d => d.isActive) ?? matches[0]).name;
  })();

  // Maintenance — repair/refuel rates at current location. The ship list
  // and the HP-ceiling function are passed so a friendly Repair Bay in
  // this orbit can run the same triage the server runs; without them the
  // panel would quote a station-only rate and disagree with what actually
  // heals. effectiveShipMaxHp is the one ceiling both sides use.
  const maintenance = maintenanceRatesForShip(
    ship, gameState.bodies, gameState.settlements, gameState.ships,
    (s) => effectiveShipMaxHp(s, gameState.factionTech[s.ownedBy]),
  );
  // Effective max HP = build-time hp_max × veterancy (+1%/rank) × the
  // owner's armor tech (+8%/level), mirroring the server's repair cap
  // (effectiveShipMaxHp). The stored hp_max alone lags for a ranked or
  // armor-teched hull, which is why HP read over its max (e.g. 53/40).
  const maxHp = effectiveShipMaxHp(ship, gameState.factionTech[ship.ownedBy]);
  const currentHp = ship.hp ?? maxHp;

  // STATUS — what the hull is DOING: In Combat / Repairing / Retreating /
  // Holding Fire / In Transit / Planned / Orbiting.
  //
  // Reuses systemGrouping's shipStatus, the same helper the fleet list, the
  // outliner and the group panel already render badges from, rather than
  // deriving a seventh opinion here. Four surfaces agreeing by construction
  // is the whole point: a ship that reads "In Combat" in the fleet list must
  // not read "Orbiting" in its own panel.
  //
  // Presence flags are supplied rather than left to shipStatus's timestamp
  // fallback, which its own comment calls out as latching the badge for
  // hours after a fight ends. isArmed picks the right test: an armed hull is
  // in combat when ANY hostile shares the orbit (including a settlement it
  // is bombarding), while an unarmed one needs an armed hostile SHIP present
  // — otherwise a freighter parked near an enemy city reads as fighting.
  const atPeace = makePeaceCheck(gameState.pactPairs);
  const hostilesHere = makeHostilesAtBody(
    gameState.ships, gameState.settlements, atPeace,
  );
  const armedHostilesHere = makeArmedHostilesAtBody(gameState.ships, atPeace);
  const stationsHere = makeStationsAtBody(gameState.settlements);
  const status = shipStatus(
    ship,
    gameState.currentTick,
    maxHp > 0 ? currentHp / maxHp : 1,
    (isArmed(ship) ? hostilesHere : armedHostilesHere)(
      ship.orbit.parentBodyId, ship.ownedBy,
    ),
    stationsHere(ship.orbit.parentBodyId, ship.ownedBy),
  );

  const hpAtMax = currentHp >= maxHp - 0.5;

  // Fleet — current fleet (if any) and ships eligible to fleet with at this body
  const currentFleet = ship.fleetId
    ? gameState.fleets.find(f => f.id === ship.fleetId) ?? null
    : null;
  const fleetMembers = currentFleet
    ? gameState.ships.filter(s => currentFleet.shipIds.includes(s.id))
    : [];
  // Eligible peers: same faction, same parent body, not in transit, not this ship, not already in *this* fleet
  const eligiblePeers = !ship.transit
    ? gameState.ships.filter(s =>
        s.id !== ship.id &&
        s.ownedBy === ship.ownedBy &&
        s.orbit.parentBodyId === ship.orbit.parentBodyId &&
        !s.transit &&
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

  // Standing orders (MP only, DESIGN §3). Optimistic local update +
  // server post; a rejection surfaces inline and the next /state poll
  // rewinds the optimistic change.
  const currentStance = ship.stance ?? 'attack';
  const applyOrders = (patch: {
    stance?: 'attack' | 'defensive' | 'hold';
    retreatHpPct?: 25 | 50 | 75 | null;
    arrivalAction?: 'detonate' | 'arrive_defensive' | 'arrive_hold' | null;
    arrivalGuard?: 'hostile_in_orbit' | null;
    detonateHpPct?: 25 | 50 | null;
    targetPriority?: TargetPriorityKey[] | null;
  }) => {
    if (!mpActions) return;
    setOrdersError(null);
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s => (s.id === ship.id ? { ...s, ...patch } : s)),
    });
    mpActions.setShipOrders({
      shipIds: [ship.id],
      ...(patch.stance !== undefined ? { stance: patch.stance } : {}),
      ...('retreatHpPct' in patch ? { retreatHpPct: patch.retreatHpPct ?? null } : {}),
      ...('arrivalAction' in patch ? { arrivalAction: patch.arrivalAction ?? null } : {}),
      ...('arrivalGuard' in patch ? { arrivalGuard: patch.arrivalGuard ?? null } : {}),
      ...('detonateHpPct' in patch ? { detonateHpPct: patch.detonateHpPct ?? null } : {}),
      ...('targetPriority' in patch ? { targetPriority: patch.targetPriority ?? null } : {}),
    }).then(res => {
      if (!res.ok) {
        setOrdersError(humanizeMpError(res.code, res.error, 'orders'));
      }
    });
  };

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
            fontFamily: 'var(--font-body)',
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
      <div className="ship-panel" data-tutorial-id="ship-panel">
        <div className="panel-header">
          <span>
            SHIP:{' '}
            <EditableName
              value={ship.name}
              readOnly={ship.ownedBy !== 'player'}
              ariaLabel="Rename this ship"
              onSave={async (next) => {
                // Optimistic local rename so the header updates
                // instantly. MP /state poll reconciles within ~1.5s
                // if the server rejects.
                renameShip(ship.id, next);
                if (mpActions) {
                  const res = await mpActions.renameShip(ship.id, next);
                  if (!res.ok) {
                    throw new Error(humanizeMpError(res.code, res.error, 'rename'));
                  }
                }
              }}
            />
            {/* Class chip moved out of the editable name so the
                pencil doesn't make the rank+class jiggle. */}
            {(ship.rank ?? 0) > 0 && (
              // Veterancy chip — every kill +1 rank, +1% damage/HP.
              // The number is what other systems also surface (combat
              // log, threat panel) so players learn what RANK means.
              <span
                style={{
                  marginLeft: 6,
                  padding: '1px 6px',
                  fontSize: 9,
                  letterSpacing: '0.1em',
                  background: 'rgba(255, 184, 77, 0.18)',
                  border: '1px solid #ffb84d',
                  color: '#ffb84d',
                  borderRadius: 3,
                  verticalAlign: 'middle',
                }}
                title={`Rank ${ship.rank}: +${ship.rank ?? 0}% damage, +${ship.rank ?? 0}% max HP`}
              >RANK {ship.rank}</span>
            )}
            {/* Captain chip (DESIGN-captains §5): portrait + name. The rank
                above is HIS. Click-through lives in the Fleet panel's
                Captains view; here it's identity + trait tooltip. */}
            {ship.captainName && (
              <span
                style={{
                  marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 7,
                  /* Tight on the left so the round portrait sits in the chip's
                     corner rather than floating in padding. */
                  padding: '2px 10px 2px 2px', fontSize: 11, letterSpacing: '0.04em',
                  background: 'rgba(78, 205, 196, 0.10)', border: '1px solid #2f6f6a',
                  /* Not a pill: CaptainAvatar draws a rounded SQUARE (radius 4), and a
                     999 radius would let the portrait's corners cut into the chip's
                     curve at 28px. 6 sits just outside the portrait's own rounding. */
                  color: '#9fe8e2', borderRadius: 6, verticalAlign: 'middle',
                }}
                title={traitSummary(ship.captainTraits) || 'Captain'}
              >
                <CaptainAvatar avatarId={ship.captainAvatar} size={CAPTAIN_CHIP_PX} />
                {ship.captainName.toUpperCase()}
              </span>
            )}
          </span>
          <button className="panel-close" onClick={deselectShip}>✕</button>
        </div>

        <div className="ship-tabs" role="tablist">
          {SHIP_TABS.filter(t => tabExists(t.key)).map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeTab === t.key}
              className={`ship-tabs__tab${activeTab === t.key ? ' is-active' : ''}`}
              onClick={() => setShipTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {activeTab === 'orders' && (<>
          {/* Actions and standing orders lead the panel. They used to sit
              below MANEUVER NODES / FLEET / COMBAT / DETONATOR, which meant
              scrolling a tall panel to reach the two controls you reach for
              most: move this ship, and tell it how to fight. */}
          {transferError && (
            // Server rejected this transfer. Surface inline above the
            // maneuver buttons so the next-action UI is right next to
            // the explanation. Click to dismiss.
            <button
              onClick={() => setTransferError(null)}
              style={{
                margin: '0 0 6px', padding: '6px 10px',
                background: 'rgba(255, 94, 94, 0.1)',
                border: '1px solid #ff5e5e', borderRadius: 4,
                color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
                fontFamily: 'inherit', textAlign: 'left',
                cursor: 'pointer', width: '100%',
              }}
              title="Click to dismiss"
            >⚠ {transferError}</button>
          )}
          <div className="maneuver-buttons">
            <button
              className="maneuver-btn"
              onClick={() => setTargetSelectionMode(true)}
              data-tutorial-id="ship-transfer-button"
            >
              {hasExistingTransfer ? '+ CHAIN MOVE' : 'MOVE TO TARGET'}
            </button>
            <button className="maneuver-btn" onClick={() => setTransferModalOpen(true)}>
              CHOOSE FROM LIST
            </button>
            {/* LOCATE — put the camera where this hull actually is.
                Two different moves, because a ship has two states:

                PARKED: focus its parent body. Focus mode is what draws
                the local SOI and keeps the camera glued as the body
                orbits, so a parked ship stays on screen instead of
                sliding off over the next few ticks.

                IN TRANSIT: there is no parent body to focus, so pan to
                the ship's own coordinates and CLEAR focus. Note this
                deliberately differs from the fleet list, which jumps to
                a transiting ship's DESTINATION — reasonable for "where
                is it headed", wrong for a button that says Locate. */}
            <button
              className="maneuver-btn"
              onClick={() => {
                if (ship.transit) {
                  const pos = shipWorldPosition(ship, gameState.currentTick, gameState.bodies);
                  if (pos) updateCamera({ x: pos.x, y: pos.y, focusedBodyId: undefined });
                } else if (ship.orbit?.parentBodyId) {
                  focusBody(ship.orbit.parentBodyId);
                }
              }}
              title={ship.transit
                ? 'Centre the map on this ship in flight'
                : 'Focus the world this ship is orbiting'}
            >
              LOCATE
            </button>
          </div>

          {/* AUTO-EXPLORE — corvettes only. Scouting is what the class is
              for, and a one-click survey tour is the difference between
              a scout being useful and being 10 manual transfers. The leg
              count is on the button so the commitment is visible before
              the click, not after. */}
          {isOwn && ship.class === 'corvette' && (
            <div className="maneuver-buttons" style={{ marginTop: 6 }}>
              <select
                value={exploreScope}
                onChange={(e) => setExploreScope(e.target.value as ExploreScope)}
                title="How far the survey ranges"
                style={{
                  background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
                  color: '#9fb4c6', fontFamily: 'inherit', fontSize: 10, padding: '3px 5px',
                  flex: '0 1 auto', minWidth: 0,
                }}
              >
                <option value="system">This system</option>
                <option value="all">Whole map</option>
              </select>
              <button
                className="maneuver-btn"
                disabled={exploreTour.length === 0 || !!ship.transit}
                onClick={startAutoExplore}
                title={ship.transit
                  ? 'Already under way — auto-explore starts from a parked hull'
                  : exploreTour.length === 0
                    ? 'Nothing left to survey in range'
                    : `Queue a ${exploreTour.length}-stop survey`}
                style={exploreTour.length === 0 || ship.transit ? { opacity: 0.45 } : undefined}
              >
                ⌖ AUTO-EXPLORE{exploreTour.length > 0 ? ` (${exploreTour.length})` : ''}
              </button>
            </div>
          )}
          {exploreNotice && (
            <div style={{ fontSize: 10, color: '#8aa0b4', margin: '4px 0 0', lineHeight: 1.4 }}>
              {exploreNotice}
            </div>
          )}

          {/* RENDEZVOUS — meet a ship in flight at the door it is
              heading for (DESIGN-transit-combat.md, "the missing order").

              The order system could only ever say "go to a body", which
              made escorting impossible unless you happened to be at the
              same body on the same tick, and interception a lottery.
              This is the cheap 90% of the fix: read where they are going
              and when they get there, then plan an ordinary transfer
              timed to land with them. No new solver — and the chase
              analysis says that is where the value is anyway, because
              you catch things at the door, never in the open.

              ONLY REACHABLE CONTACTS ARE LISTED. A raw list of everything
              in flight is mostly noise: most of it you cannot possibly
              meet, and a picker whose entries silently fail is worse than
              one that is short. Every candidate is planned against before
              it is offered, and anything you would reach after it has
              already parked is dropped.

              Sensor-gated by construction — the list is built from
              gameState.ships, which is already what this player can see. */}
          {isOwn && mpActions && !ship.transit && (() => {
            const now = gameState.currentTick;
            const candidates = rendezvousCandidates;

            const chosen = candidates.find(c => c.t.id === rendezvousId) ?? null;

            // Frame the whole plan: my hull, theirs, and the door they are
            // both heading for.
            //
            // focusedBodyId is cleared FIRST because while it is set the
            // camera's x/y are an offset pinned to (0,0) — writing world
            // coordinates into it teleports the view to the Sun. Same trap
            // the WASD pan hit (see releaseFocusPosition).
            const frameOn = (c: NonNullable<(typeof candidates)[number]>) => {
              const pts = [
                shipWorldPosition(ship, now, gameState.bodies),
                shipWorldPosition(c.t, now, gameState.bodies),
                bodyPosition(c.dest, c.theirEta, gameState.bodies),
              ].filter((p): p is { x: number; y: number } => !!p);
              if (pts.length === 0) return;
              const xs = pts.map(p => p.x);
              const ys = pts.map(p => p.y);
              const minX = Math.min(...xs), maxX = Math.max(...xs);
              const minY = Math.min(...ys), maxY = Math.max(...ys);
              // Generous margin: a torch arc bows well outside the straight
              // line between its endpoints, so a tight box would crop the
              // very curve this is meant to show.
              const w = Math.max(40, (maxX - minX) * 1.9);
              const h = Math.max(40, (maxY - minY) * 1.9);
              const vw = Math.max(320, window.innerWidth);
              const vh = Math.max(320, window.innerHeight);
              const scale = Math.max(0.02, Math.min(3, Math.min(vw / w, vh / h)));
              updateCamera({
                focusedBodyId: undefined,
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                scale,
                zoomLevel: scale > 1.2 ? 3 : scale > 0.35 ? 2 : 1,
              });
            };

            return (
              <div className="maneuver-section" style={{ marginTop: 8 }}>
                {/* COLLAPSED BY DEFAULT. A dozen contacts is a wall of
                    rows that pushes the maneuver controls off-screen, and
                    most of the time the player is not shopping for a
                    rendezvous at all. The header carries the count so the
                    section still says whether there is anything worth
                    opening. */}
                <button
                  type="button"
                  className="section-title"
                  onClick={() => setRendezvousOpen(o => !o)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    background: 'none', border: 'none', padding: 0,
                    font: 'inherit', color: 'inherit', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  title={rendezvousOpen ? 'Hide contacts' : 'Show contacts you could meet'}
                >
                  <span style={{ transform: rendezvousOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
                  {/* Player-facing name only (Lorne). The solver, the
                      stored plan and every field stay `rendezvous` --
                      renaming those would touch the physics module, the
                      API and three migrations for a label change. */}
                  INTERCEPT
                  {candidates.length > 0 && (
                    <span style={{ color: '#4ecdc4', fontSize: 10 }}>{candidates.length}</span>
                  )}
                  {!rendezvousOpen && chosen && (
                    <span style={{
                      color: '#8a9fb3', fontSize: 10, fontWeight: 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      · {chosen.t.name}
                    </span>
                  )}
                </button>
                {!rendezvousOpen ? null : candidates.length === 0 ? (
                  <div style={{ fontSize: 10, color: '#7a8a9a', lineHeight: 1.45, padding: '4px 0' }}>
                    Nothing in flight you could reach before it lands.
                  </div>
                ) : (
                  <div style={{ maxHeight: 190, overflowY: 'auto', margin: '2px 0 6px' }}>
                    {candidates.map((c) => {
                      const isMine = c.t.ownedBy === 'player';
                      const owner = gameState.factions.find(f => f.id === c.t.ownedBy);
                      const who = isMine ? 'yours' : (owner?.name ?? 'rival');
                      const tint = isMine ? '#4ecdc4' : (owner?.color ?? '#8a9fb3');
                      const on = c.t.id === rendezvousId;
                      return (
                        <button
                          key={c.t.id}
                          onClick={() => {
                            setRendezvousId(c.t.id);
                            frameOn(c);
                            // SHOW THE COURSE, not just the row. A picker
                            // that names a meeting without drawing it asks
                            // the player to take the solver's word for a
                            // manoeuvre they cannot picture — and this one
                            // is a shape nothing else in the game flies.
                            previewRendezvous(ship.id, c.rv ? {
                              p0: { x: c.myPlan.startPos.x, y: c.myPlan.startPos.y },
                              v0: { x: c.myPlan.startVel.x, y: c.myPlan.startVel.y },
                              accel: c.myPlan.acceleration,
                              A: c.rv.A, B: c.rv.B,
                              startTick: now, meetTick: c.rv.meetTick,
                              followShipId: c.t.id,
                            } : null);
                          }}
                          title={'Frame the course — ' + c.t.name + ' reaches ' + c.dest.name
                                 + ' on T+' + Math.round(c.theirEta)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                            textAlign: 'left', cursor: 'pointer',
                            background: on ? 'rgba(78,205,196,0.12)' : 'transparent',
                            border: '1px solid ' + (on ? '#4ecdc4' : '#22303f'),
                            borderRadius: 3, padding: '5px 7px', marginBottom: 3,
                            color: '#d8e4ee', font: 'inherit', fontSize: 11,
                          }}
                        >
                          <ShipIcon
                            shipClass={c.t.class as ShipClassName}
                            variant={c.t.iconVariant}
                            size={18}
                            parts={c.t.parts}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{
                              display: 'block', overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {c.t.name}
                              <span style={{ color: tint, fontSize: 9, marginLeft: 5 }}>{who}</span>
                            </span>
                            <span style={{ display: 'block', fontSize: 9, color: '#7a8a9a' }}>
                              → {c.dest.name} · {c.rv ? 'match' : 'meet'} in {Math.round(c.meetIn)}t
                              {c.rv && (
                                <span style={{ color: '#6ee7b7', marginLeft: 5 }}>
                                  ⇌ fly together
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {chosen && (
                  <button
                    className="maneuver-btn"
                    style={{ width: '100%', opacity: rendezvousBusy ? 0.45 : 1 }}
                    disabled={rendezvousBusy}
                    onClick={async () => {
                      if (rendezvousBusy) return;
                      // Guard the double-click: both posts carry
                      // replace:true, so the second would cancel the leg
                      // the first just created.
                      setRendezvousBusy(true);
                      // Fly it locally too, or the hull sits parked until
                      // the next /state poll and the button reads as dead.
                      //
                      // A MATCH IS NOT A TRIP TO THEIR DESTINATION. This
                      // used to stage only the plain transfer, so the
                      // moment you committed an interception the panel
                      // showed a route to Mars — the arc you had just
                      // been shown simply vanished. Keep the preview
                      // staged so the committed manoeuvre is still the
                      // one on screen until the server confirms it.
                      launchTorchTransfer(ship.id, chosen.dest.id);
                      if (chosen.rv) {
                        previewRendezvous(ship.id, {
                          p0: { x: chosen.myPlan.startPos.x, y: chosen.myPlan.startPos.y },
                          v0: { x: chosen.myPlan.startVel.x, y: chosen.myPlan.startVel.y },
                          accel: chosen.myPlan.acceleration,
                          A: chosen.rv.A, B: chosen.rv.B,
                          startTick: chosen.myPlan.startTick,
                          meetTick: chosen.rv.meetTick,
                          followShipId: chosen.t.id,
                        });
                      }
                      const res = await mpActions.transfer({
                        shipId: ship.id,
                        targetBodyId: chosen.dest.id,
                        scheduledT: chosen.myPlan.startTick,
                        // A TRUE MATCH ARRIVES WHEN THEY DO. Sending my
                        // own ETA made the server fly a plain leg to
                        // their planet on my schedule, so the pair split
                        // up again the moment they touched. Flying
                        // together means sharing their arrival.
                        arrivalT: chosen.rv ? chosen.theirEta : chosen.myPlan.arriveTick,
                        launch: launchFromPlan(chosen.myPlan),
                        // A real match flies its own two arcs and then
                        // adopts their plan; without one this is the
                        // plain transfer to their destination.
                        ...(chosen.rv ? {
                          rendezvous: {
                            ax: chosen.rv.A.x, ay: chosen.rv.A.y,
                            bx: chosen.rv.B.x, by: chosen.rv.B.y,
                            meetTick: chosen.rv.meetTick,
                            followShipId: chosen.t.id,
                          },
                        } : {}),
                        dvPrograde: chosen.myPlan.totalDv,
                        fuelCost: Math.round(chosen.myPlan.totalDv * 10),
                        replace: true,
                      });
                      setRendezvousBusy(false);
                      if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                    }}
                  >
                    {chosen.rv
                      ? '⇌ MATCH COURSE WITH ' + chosen.t.name.toUpperCase()
                      : '⇉ MEET ' + chosen.t.name.toUpperCase() + ' AT ' + chosen.dest.name.toUpperCase()}
                  </button>
                )}
              </div>
            );
          })()}

          {/* RETROFIT — take the active design for this hull's class.
              Only rendered when there is genuinely something to do:
              an active design exists, its loadout DIFFERS from what this
              hull is flying, and no order is already standing. Same rule
              the DEPLOY control follows below — a button that cannot
              accomplish anything should not be on screen.

              The order is passive by design on the server: it stamps the
              hull and the tick pass fits it wherever it next parks
              friendly. What this adds is the trip — which since transit
              combat is a real cost, so sending a ship home to upgrade is
              a decision rather than a formality. */}
          </>)}
          {activeTab === 'ship' && (<>
          {isOwn && mpActions && (() => {
            const active = (gameState.shipDesigns ?? []).find(
              d => d.shipClass === ship.class && d.isActive);
            if (!active) return null;
            const now = sanitizeParts(ship.parts ?? []);
            const want = sanitizeParts(active.parts ?? []);
            const same = now.length === want.length
              && [...now].sort().join(',') === [...want].sort().join(',');
            if (same) return null;

            const pending = ship.refitPendingDesignId === active.id;
            const fee = refitFee(now, want);
            const feeStr = [
              fee.ore > 0 ? `${Math.round(fee.ore)} metal` : null,
              fee.credits > 0 ? `${Math.round(fee.credits)} credits` : null,
            ].filter(Boolean).join(' + ') || 'no charge';

            // Where the work can actually happen — ANY friendly
            // settlement, which is what the tick pass requires. null
            // means this hull is already somewhere that qualifies.
            const site = nearestRefitBodyId(ship, gameState.settlements, gameState.bodies, gameState.currentTick);
            const siteName = site ? (gameState.bodies.find(b => b.id === site)?.name ?? 'a yard') : null;

            return (
              <div className="maneuver-section" style={{ marginTop: 8 }}>
                <div className="section-title">RETROFIT</div>
                <div style={{ fontSize: 10, color: '#8a9fb3', lineHeight: 1.5, padding: '2px 0 4px' }}>
                  <b style={{ color: '#d8e4ee' }}>{active.name}</b> is newer than this hull's fit.
                  {' '}Costs <b style={{ color: '#d8e4ee' }}>{feeStr}</b>, charged when the work is done.
                  {pending && <div style={{ color: '#6ee7b7' }}>Ordered — fits on arrival at a friendly world.</div>}
                </div>
                <div className="maneuver-buttons">
                  <button
                    className="maneuver-btn"
                    disabled={refitBusy}
                    style={{ opacity: refitBusy ? 0.45 : 1 }}
                    title={site
                      ? `Order ${ship.name} to ${siteName} and fit ${active.name} on arrival`
                      : `Fit ${active.name} here — applies on the next tick`}
                    onClick={async () => {
                      if (refitBusy) return;
                      setRefitBusy(true);
                      const res = await mpActions.refitShip(ship.id, pending ? null : active.id);
                      // Only fly it somewhere if the order stuck AND it
                      // is not already parked where the work happens.
                      if (res.ok && !pending && site) launchTorchTransfer(ship.id, site);
                      setRefitBusy(false);
                      if (!res.ok) setTransferError(humanizeMpError(res.code, res.error ?? 'Refit failed.', 'transfer'));
                    }}
                  >
                    {pending ? '✕ CANCEL RETROFIT'
                      : site ? `⟳ RETROFIT AT ${siteName!.toUpperCase()}`
                      : '⟳ RETROFIT HERE'}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* DEPLOY SETTLEMENT — colony ships only. Founding was
              previously reachable only from the body side (world menu /
              body inspector), so a player who had the colony ship
              selected had to go find the planet's panel to use it. The
              button only renders when this hull is parked somewhere it
              can actually found, so it never appears as a dead control. */}
          </>)}
          {activeTab === 'orders' && (<>
          {isOwn && ship.class === 'colony' && mpActions && (
            <div style={{ marginTop: 6 }}>
              {deployTypes.length > 0 ? (
                <div className="maneuver-buttons">
                  {deployTypes.map(t => (
                    <button
                      key={t}
                      className="maneuver-btn"
                      disabled={deployBusy}
                      onClick={() => deploySettlementHere(t)}
                      title={`Found a ${t} on ${colonyBody?.name} — consumes ${ship.name}`}
                    >
                      ▲ DEPLOY {t === 'city' ? 'CITY' : 'STATION'}
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#5f7488', lineHeight: 1.4 }}>
                  {ship.transit
                    ? 'Deploy available once parked at a target'
                    : !colonyBody
                      ? 'Deploy available in orbit of a world'
                      : cityHere && stationHere
                        ? `${colonyBody.name} is already fully settled`
                        : cityLock && !canDeployCity
                          ? `🔒 ${cityLock.label} — ${cityLock.text}`
                          : `Nothing left to found at ${colonyBody.name}`}
                </div>
              )}
            </div>
          )}
          {deployNotice && (
            <div style={{ fontSize: 10, color: '#8aa0b4', margin: '4px 0 0', lineHeight: 1.4 }}>
              {deployNotice}
            </div>
          )}

          {/* Maneuver nodes + COMMIT ride with the move buttons: you pick a
              destination, then confirm the burn. Splitting those across a
              scroll meant staging a move and losing sight of the button
              that actually launches it. */}
          <div className="maneuver-section" data-tutorial-id="ship-maneuver-section">
            <div className="section-title">MANEUVER NODES</div>
            {ship.orders.length === 0 && !ship.transit && !ship.plannedTransit && queuedTransits.length === 0 ? (
              <div className="no-orders">No planned maneuvers</div>
            ) : (
              <>
                <div className="orders-list">
                  {ship.transit && (() => {
                    const plan = ship.transit.currentTransfer;
                    const targetBody = gameState.bodies.find(b => b.id === plan.targetBodyId);
                    // A MATCH IS NOT A DESTINATION. This card read
                    // "→ Ganymede" for a manoeuvre whose whole point was
                    // to join another hull — so the node contradicted the
                    // arc drawn on the map ("looks like we're both going
                    // to Ganymede, and not?"). Lead with the meeting; the
                    // body is where the pair ends up afterwards, which is
                    // the second fact, not the first.
                    const rv = ship.plannedRendezvous;
                    const mate = rv
                      ? gameState.ships.find(x => x.id === rv.followShipId)
                      : undefined;
                    const meetIn = rv
                      ? Math.max(0, rv.meetTick - gameState.currentTick)
                      : 0;
                    return (
                      <div className="order-item status-committed">
                        <div className="order-info">
                          {rv ? (
                            <>
                              <div className="order-type" style={{ color: '#4ecdc4' }}>
                                ⇌ MATCH {(mate?.name ?? 'CONTACT').toUpperCase()}
                              </div>
                              <div className="order-details">
                                meet in {meetIn.toFixed(0)}t · then together → {targetBody?.name ?? plan.targetBodyId}
                              </div>
                              <div className="order-details" style={{ color: '#6ee7b7' }}>
                                ETA T-{Math.max(0, plan.arriveTick - gameState.currentTick).toFixed(0)} · Δv {plan.totalDv.toFixed(2)}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId}</div>
                              <div className="order-details">
                                ETA T-{Math.max(0, plan.arriveTick - gameState.currentTick).toFixed(0)} · Δv {plan.totalDv.toFixed(2)}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {ship.plannedTransit && !ship.transit && (() => {
                    const plan = ship.plannedTransit;
                    const targetBody = gameState.bodies.find(b => b.id === plan.targetBodyId);
                    const tripTime = plan.arriveTick - plan.startTick;
                    return (
                      <div className="order-item status-planned">
                        <div className="order-info">
                          {/* Same rule as the committed card: if a match
                              is staged, the meeting is the plan and the
                              body is where it ends. */}
                          {ship.plannedRendezvous ? (
                            <>
                              <div className="order-type" style={{ color: '#4ecdc4' }}>
                                ⇌ MATCH {(gameState.ships.find(x => x.id === ship.plannedRendezvous!.followShipId)?.name
                                  ?? 'CONTACT').toUpperCase()} (PLANNED)
                              </div>
                              <div className="order-details">
                                meet in {Math.max(0, ship.plannedRendezvous.meetTick - gameState.currentTick).toFixed(0)}t
                                {' '}· then together → {targetBody?.name ?? plan.targetBodyId}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId} (PLANNED)</div>
                              <div className="order-details">
                                Δv: {plan.totalDv.toFixed(2)} | Trip: {tripTime.toFixed(0)} ticks
                              </div>
                            </>
                          )}
                        </div>
                        <div className="order-actions">
                          <button
                            className="delete-btn"
                            onClick={() => cancelTorchPreview(ship.id)}
                            title="Cancel this transfer"
                          >✕</button>
                        </div>
                      </div>
                    );
                  })()}
                  {ship.orders.filter(o => o.type !== 'transfer').map((order) => (
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
                  {queuedTransits.map((qt, i) => {
                    const targetBody = gameState.bodies.find(b => b.id === qt.targetBodyId);
                    return (
                      <div key={`${qt.targetBodyId}-${qt.startTick}-${i}`} className="order-item status-queued">
                        <div className="order-info">
                          <div className="order-type">→ {targetBody?.name ?? qt.targetBodyId}</div>
                          <div className="order-details">
                            QUEUED | Δv: {qt.totalDv.toFixed(2)} | Arr. T+{qt.arriveTick.toFixed(0)}
                          </div>
                        </div>
                        <div className="order-actions">
                          <button className="delete-btn" onClick={() => handleRemoveQueuedTransfer(i)}>✕</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {/* COMMIT sits outside the empty-state branch so it always
                holds its place under the node list. It used to render
                only once a plan existed, which meant the panel reflowed
                under the cursor the moment you picked a destination. */}
            {(() => {
              // Torch model: commit is per-ship, not per-node.
              // Each ship's plannedTransit preview is promoted to a
              // live burn via commitTransferLocal. The button label
              // honors fleet propagation — when the player staged
              // transfers for an entire fleet from this ship, we
              // commit ALL of them; otherwise it's just this ship.
              const fleetPreviewShips = ship.fleetId
                ? gameState.ships.filter(s =>
                    s.fleetId === ship.fleetId && s.plannedTransit && !s.transit,
                  )
                : (ship.plannedTransit ? [ship] : []);
              const canCommit = fleetPreviewShips.length > 0;
              const label = fleetPreviewShips.length > 1
                ? `▶ COMMIT ALL (${fleetPreviewShips.length})`
                : '▶ COMMIT';
              return (
                <button
                  className="commit-all-btn"
                  data-tutorial-id="ship-commit-button"
                  disabled={!canCommit}
                  title={canCommit
                    ? 'Launch the planned burn'
                    : 'Nothing staged — plan a move first'}
                  onClick={() => {
                    for (const s of fleetPreviewShips) {
                      commitTransferLocal(s);
                    }
                  }}
                >
                  {label}
                </button>
              );
            })()}
          </div>
          {mpActions && ship.ownedBy === 'player' && (
            <div className="orders-config-section">
              <div className="section-title">ORDERS</div>

              <div className="orders-config-row">
                <span className="orders-config-label">STANCE</span>
                <div className="orders-stance-toggle">
                  {(['attack', 'defensive', 'hold'] as const).map(st => (
                    <button
                      key={st}
                      className={`orders-stance-btn ${currentStance === st ? 'active' : ''}`}
                      onClick={() => applyOrders({ stance: st })}
                      title={
                        st === 'attack' ? 'Attack on sight: engage hostiles in range.'
                        : st === 'defensive' ? 'Defensive: return fire only.'
                        : 'Hold fire: never fires. Still takes damage.'
                      }
                    >
                      {st === 'attack' ? 'ATTACK' : st === 'defensive' ? 'DEFEND' : 'HOLD'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="orders-config-row">
                <span className="orders-config-label">RETREAT AT</span>
                <select
                  className="orders-config-select"
                  value={ship.retreatHpPct ?? ''}
                  onChange={e => applyOrders({
                    retreatHpPct: e.target.value
                      ? (Number(e.target.value) as 25 | 50 | 75)
                      : null,
                  })}
                >
                  <option value="">OFF</option>
                  <option value="25">25% HP</option>
                  <option value="50">50% HP</option>
                  <option value="75">75% HP</option>
                </select>
              </div>
              <div className="orders-config-hint">
                Auto-transfer to the nearest friendly shipyard station when HP
                drops below the threshold. Fires once per damage episode.
                {' '}
                {/* A setting that silently stops applying is worse than one
                    never offered. Transit combat means a hull can now be
                    shot while flying, and a committed torch burn cannot be
                    re-aimed — so retreat genuinely does nothing out there,
                    and the player is owed that BEFORE they watch a ship set
                    to run at 25% die at 0%. See DESIGN-transit-combat.md. */}
                <strong style={{ color: '#ffb84d' }}>
                  No effect in transit — a committed burn can’t be re-aimed.
                </strong>
              </div>

              {/* One-shot repair dispatch — the manual sibling of the
                  RETREAT AT threshold. Only offered when it would DO
                  something: hull is damaged, parked, and not already
                  sitting at a friendly station (station repair covers
                  that case; the status badge says "Repairing"). */}
              {isDamagedShip(ship) && !ship.transit && (() => {
                const atStation = gameState.settlements.some(st =>
                  st.type === 'station' && st.hp > 0
                  && st.ownedBy === ship.ownedBy
                  && st.bodyId === ship.orbit.parentBodyId);
                if (atStation) return null;
                const dest = nearestShipyardBodyId(
                  ship, gameState.settlements, gameState.bodies, gameState.currentTick,
                );
                const destBody = dest ? gameState.bodies.find(b => b.id === dest) : null;
                return (
                  <div className="orders-config-row">
                    <span className="orders-config-label">REPAIR</span>
                    <button
                      className="orders-stance-btn"
                      disabled={!dest}
                      title={dest
                        ? `Transfer to ${destBody?.name ?? dest} — nearest friendly shipyard — and repair (+2 HP/tick docked)`
                        : 'No friendly shipyard station anywhere — build a station shipyard first'}
                      onClick={() => {
                        if (!dest) return;
                        const plan = launchTorchTransfer(ship.id, dest);
                        // "check fuel" named a resource that no longer
                        // exists — a dead end for anyone who read it.
                        if (!plan) { setTransferError('Transfer failed — no route to that world'); return; }
                        setTransferError(null);
                        mpActions?.transfer({
                          shipId: ship.id,
                          targetBodyId: plan.targetBodyId,
                          scheduledT: plan.startTick,
                          arrivalT: plan.arriveTick,
                          launch: launchFromPlan(plan),
                          dvPrograde: plan.totalDv,
                          fuelCost: Math.round(plan.totalDv * 10),
                          replace: true,
                        }).then(res => {
                          if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                        });
                      }}
                    >
                      ⛨ SEND TO SHIPYARD{destBody ? ` (${destBody.name.toUpperCase()})` : ''}
                    </button>
                  </div>
                );
              })()}

              {/* Detonator-only. The row used to render on every hull with
                  a "no effect without a detonator part" disclaimer — a live
                  control that does nothing, on most of the fleet, explaining
                  its own uselessness. Gate it the same way the manual
                  DetonatorSection above already does, so the setting only
                  appears where it can actually fire. */}
              {countPart(ship.parts, 'detonator') > 0 && (
                <>
                  <div className="orders-config-row">
                    <span className="orders-config-label">AUTO-DETONATE</span>
                    <select
                      className="orders-config-select"
                      value={ship.detonateHpPct ?? ''}
                      onChange={e => applyOrders({
                        detonateHpPct: e.target.value
                          ? (Number(e.target.value) as 25 | 50)
                          : null,
                      })}
                    >
                      <option value="">OFF</option>
                      <option value="25">25% HP</option>
                      <option value="50">50% HP</option>
                    </select>
                  </div>
                  <div className="orders-config-hint orders-config-hint--danger">
                    Auto-detonate below {ship.detonateHpPct ?? 'X'}% HP: deals
                    damage to every ship in this orbit, friend or foe; this
                    ship is destroyed.
                  </div>
                </>
              )}

              {/* Target priority (migration 0064): ranked drag cards. This
                  is a STANDING ORDER — the doctrine the hull follows when it
                  picks a target — so it belongs beside stance and retreat,
                  not in the COMBAT readout it used to live in. That readout
                  answers "what is this ship", these cards answer "what
                  should it do", and they're different questions.
                  MP + own ship only: rivals' doctrine is their business, and
                  SP's frozen sim doesn't read the column. */}
              {mpActions && ship.ownedBy === 'player' && (
                <TargetPriorityCards
                  value={ship.targetPriority ?? null}
                  autoOrder={autoTargetOrderFor(
                    combatSpeedOf(ship.class as ShipClassName, ship.parts),
                  )}
                  ownSpeed={combatSpeedOf(ship.class as ShipClassName, ship.parts)}
                  onChange={(next) => applyOrders({ targetPriority: next })}
                />
              )}

              {/* ============================================================
                  PROGRAM — the ship's plan as an ordered tape.
                  ============================================================
                  A program is STEPS (ordered, numbered, one at a time) plus
                  STANDING RULES (unnumbered, true the whole time). The
                  numbering is the argument: order is real information for a
                  step and meaningless for a rule, so only one list gets it.
                  Blur that and players write "retreat at 25%" at the bottom
                  and wonder why it did not protect step 1.

                  WHAT IS REAL HERE. Every step below comes from state the
                  game already has -- ship.transit (the committed burn) and
                  ship.queuedTransits (chained legs, already dashed on the
                  map). That queue has existed for a while and has never been
                  LISTED anywhere: the player could see arcs on the canvas and
                  had no way to read their own plan as a plan. Nothing is
                  mocked; when there are no legs, the section says so.

                  Collapsed by default. It is a review surface, not a thing
                  you touch every tick, and ORDERS above is already dense. */}
              <button
                type="button"
                className="section-title"
                onClick={() => setProgramOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  background: 'none', border: 'none', padding: 0,
                  font: 'inherit', color: 'inherit', cursor: 'pointer',
                  textAlign: 'left', marginTop: 10,
                }}
                title={programOpen ? 'Hide this ship’s plan' : 'Show this ship’s plan step by step'}
              >
                <span style={{ transform: programOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>&#9656;</span>
                PROGRAM
                {programSteps.length > 0 && (
                  <span style={{ color: '#4ecdc4', fontSize: 10 }}>{programSteps.length}</span>
                )}
                {!programOpen && programSteps.length > 0 && (
                  <span style={{ color: '#8a9fb3', fontSize: 10, fontWeight: 400 }}>
                    &middot; {programSteps[0].label}
                  </span>
                )}
              </button>

              {programOpen && (
                <div className="prog">
                  {/* THE READOUT, first. A plan that stalls overnight is
                      worse than no plan: the player wakes to an idle hull and
                      no reason. State the step and, when blocked, why. */}
                  <div className="prog__readout">
                    {programSteps.length === 0 ? (
                      <span className="prog__idle">No steps queued &mdash; this ship is awaiting orders.</span>
                    ) : (
                      <>
                        <span className="prog__k">Step 1 of {programSteps.length}</span>
                        <span className="prog__v">{programSteps[0].label.toUpperCase()}</span>
                        <span className="prog__why">{programSteps[0].meta}</span>
                      </>
                    )}
                  </div>

                  {programSteps.length > 0 && (
                    <ol className="prog__tape">
                      {programSteps.map((st, i) => (
                        <li
                          key={st.key}
                          className={`prog__step${i === 0 ? ' is-now' : ''}${st.kind === 'wait' ? ' is-wait' : ''}`}
                        >
                          <span className="prog__n">{i + 1}</span>
                          <span className="prog__b">
                            {st.kind === 'wait'
                              ? <><span className="prog__guard">WAIT</span> {st.label.replace('Wait ', '')}</>
                              : <>GO TO <em>{st.dest}</em></>}
                          </span>
                          {st.committed
                            ? <span className="prog__lock" title="A committed burn cannot be re-aimed.">&#9670; COMMITTED</span>
                            : <span className="prog__meta">{st.meta}</span>}
                        </li>
                      ))}
                    </ol>
                  )}

                  {ship.arrivalAction && ship.arrivalAction !== 'detonate' && (
                    <div className="prog__final prog__final--calm">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {ship.arrivalGuard === 'hostile_in_orbit'
                          ? <><span className="prog__guard">IF</span> hostile in orbit &rarr; STANCE <em>{ship.arrivalAction === 'arrive_hold' ? 'HOLD' : 'DEFENSIVE'}</em> on arrival</>
                          : <>STANCE <em>{ship.arrivalAction === 'arrive_hold' ? 'HOLD' : 'DEFENSIVE'}</em> on arrival</>}
                      </span>
                      <span className="prog__armedTag prog__armedTag--calm">SET</span>
                    </div>
                  )}
                  {ship.arrivalAction === 'detonate' && (
                    <div className="prog__final">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {ship.arrivalGuard === 'hostile_in_orbit'
                          ? <><span className="prog__guard">IF</span> hostile in orbit &rarr; DETONATE <em>on arrival</em></>
                          : <>DETONATE <em>on arrival</em></>}
                      </span>
                      <span className="prog__armedTag">ARMED</span>
                    </div>
                  )}

                  {/* ADD A STEP.
                      Only ONE step type is offered because only one is real:
                      this button opens the SAME TransferTargetPicker the
                      MOVE/CHAIN control uses, and the handler behind it
                      already appends to ship.queuedTransits when a transfer
                      exists. No new logic, no second path to keep in sync --
                      and the picker even retitles itself "Chain Move To".

                      WAIT / DETONATE / IF are deliberately ABSENT rather than
                      shown disabled. They need a step table and a cursor that
                      do not exist yet, and this panel's own DEPLOY rule is
                      that a control which cannot act should not be drawn. A
                      greyed row promising a feature is a worse lie than an
                      honest gap. */}
                  <div className="prog__add">
                    {/* DETONATE ON ARRIVAL. Only offered on a hull that
                        carries a detonator -- the same gate the AUTO-DETONATE
                        row uses, because a control that cannot fire should
                        not be drawn. Toggling also sets the guard: the
                        guarded form is the sane default, since an unguarded
                        strike that finds an empty rock has spent a warship
                        on nothing. */}
                    {countPart(ship.parts, 'detonator') > 0 && (
                      <button
                        type="button"
                        className={`maneuver-btn${ship.arrivalAction ? ' prog__armed' : ''}`}
                        onClick={() => applyOrders(ship.arrivalAction
                          ? { arrivalAction: null, arrivalGuard: null }
                          : { arrivalAction: 'detonate', arrivalGuard: 'hostile_in_orbit' })}
                        title={ship.arrivalAction
                          ? 'Disarm: this ship will arrive normally.'
                          : 'Detonate the tick this ship arrives, but only if an armed hostile is in orbit. Fires before the defenders return fire.'}
                      >
                        {ship.arrivalAction ? '◆ DISARM ARRIVAL' : '+ DETONATE ON ARRIVAL'}
                      </button>
                    )}
                    {/* STANCE ON ARRIVAL. Unlike detonation this fits any
                        hull, and it is the quiet half of the same idea:
                        arrival resolves before combat, so a posture set here
                        governs the first volley. Guarded by default for the
                        same reason -- "go defensive if something is actually
                        there" beats blanket-defensive everywhere. */}
                    <button
                      type="button"
                      className={`maneuver-btn${ship.arrivalAction === 'arrive_defensive' ? ' prog__set' : ''}`}
                      onClick={() => applyOrders(ship.arrivalAction === 'arrive_defensive'
                        ? { arrivalAction: null, arrivalGuard: null }
                        : { arrivalAction: 'arrive_defensive', arrivalGuard: 'hostile_in_orbit' })}
                      title={ship.arrivalAction === 'arrive_defensive'
                        ? 'Clear: this ship keeps its current stance on arrival.'
                        : 'Go defensive the tick this ship arrives, if a hostile is in orbit. Applies before the first volley.'}
                    >
                      {ship.arrivalAction === 'arrive_defensive' ? '◆ CLEAR ARRIVAL STANCE' : '+ DEFEND ON ARRIVAL'}
                    </button>
                    <button
                      type="button"
                      className="maneuver-btn"
                      onClick={() => setTransferModalOpen(true)}
                      title={programSteps.length > 0
                        ? 'Add another leg to the end of this plan'
                        : 'Send this ship somewhere'}
                    >
                      + GO TO&hellip;
                    </button>
                    {/* WAIT n TICKS. Offered as a modifier rather than a
                        step you can strand: it arms, then the next GO TO
                        spends it. A wait with nothing after it would be a
                        ship sitting still, which it is already doing. */}
                    <button
                      type="button"
                      className={`maneuver-btn${pendingWait > 0 ? ' is-armed' : ''}`}
                      onClick={() => setWaitPickerOpen(o => !o)}
                      title="Sit still for a few ticks before the next leg departs"
                    >
                      {pendingWait > 0 ? `◆ WAIT ${pendingWait}t` : '+ WAIT…'}
                    </button>
                  </div>
                  {waitPickerOpen && (
                    <div className="prog__wait">
                      <span className="prog__waitK">WAIT, THEN GO TO&hellip;</span>
                      {[1, 3, 6, 12, 24].map(n => (
                        <button
                          key={n}
                          type="button"
                          className={`prog__waitB${pendingWait === n ? ' is-on' : ''}`}
                          onClick={() => { setPendingWait(n); setWaitPickerOpen(false); setTransferModalOpen(true); }}
                        >{n}t</button>
                      ))}
                      {pendingWait > 0 && (
                        <button
                          type="button"
                          className="prog__waitX"
                          onClick={() => { setPendingWait(0); setWaitPickerOpen(false); }}
                        >CLEAR</button>
                      )}
                    </div>
                  )}

                  {/* STANDING RULES, stated rather than re-offered. The
                      controls live in ORDERS above; duplicating them here
                      would be two derivations of one setting, which is the
                      bug this codebase keeps paying for. This half of the
                      panel exists to say WHEN they apply -- always, including
                      during step 1 -- which the flat list above cannot. */}
                  <div className="prog__rules">
                    <div className="prog__rulesHd">STANDING RULES &middot; active during every step</div>
                    <div className={`prog__rule${currentStance !== 'attack' ? ' is-on' : ''}`}>
                      STANCE <em>{(currentStance ?? 'attack').toUpperCase()}</em>
                    </div>
                    <div className={`prog__rule${ship.retreatHpPct ? ' is-on' : ''}`}>
                      RETREAT at <em>{ship.retreatHpPct ? `${ship.retreatHpPct}% hull` : 'off'}</em>
                      {ship.transit && ship.retreatHpPct
                        ? <span className="prog__note"> &mdash; not while under way</span>
                        : null}
                    </div>
                    {countPart(ship.parts, 'detonator') > 0 && (
                      <div className={`prog__rule${ship.detonateHpPct ? ' is-armed' : ''}`}>
                        DETONATE at <em>{ship.detonateHpPct ? `${ship.detonateHpPct}% hull` : 'off'}</em>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {ordersError && (
                <button
                  onClick={() => setOrdersError(null)}
                  className="orders-config-error"
                  title="Click to dismiss"
                >⚠ {ordersError}</button>
              )}
            </div>
          )}
          </>)}
          {activeTab === 'ship' && (<>
          <div className="ship-stats" data-tutorial-id="ship-stats">
            <div className="stat-row">
              <span className="label">CLASS</span>
              <span
                className="value"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                title={configName ? `${configName} · ${ship.class.toUpperCase()}` : undefined}
              >
                <span style={{ color: '#4ecdc4', display: 'inline-flex', flexShrink: 0 }}>
                  <ShipIcon shipClass={ship.class as ShipClassName} variant={ship.iconVariant} size={16} parts={ship.parts} />
                </span>
                {configName ? (
                  <span className="ship-config-name">
                    {configName}
                    <span className="ship-config-class"> · {ship.class.toUpperCase()}</span>
                  </span>
                ) : (
                  ship.class.toUpperCase()
                )}
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
                const ownerColor = owner?.color || '#b8c8d6';
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
                      <span style={{ color: '#b8c8d6', fontSize: '9px', marginLeft: 2 }}>
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
                {currentHp.toFixed(0)}/{Math.round(maxHp)}
                {maintenance.repairRate > 0 && !hpAtMax && (
                  // Rate scales with the station's shipyard level (+5/level
                  // on top of the bare dock's +2), so the ETA is worth
                  // spelling out — "+32/t" alone doesn't answer "when is
                  // this hull fit to fight again".
                  <span
                    style={{ color: '#4ecdc4', marginLeft: 6, fontSize: '9px' }}
                    title={[
                      `Repairing at ${maintenance.repairRate} HP/tick — full in ~${Math.ceil((maxHp - currentHp) / maintenance.repairRate)} ticks.`,
                      // Name whichever source is actually paying. Crediting a
                      // shipyard when the work is being done by a tender in
                      // deep space sends the player home for no reason.
                      maintenance.tenderRepairing
                        ? `A field tender in this orbit is working on this ship (+${REPAIR_PER_TICK_PER_TENDER_BAY}/tick). Each Repair Bay treats one hull at a time — the worst off it can see.`
                        : null,
                      maintenance.hasStation
                        ? 'A bigger shipyard on the station repairs faster (+5/tick per level).'
                        : null,
                    ].filter(Boolean).join(' ')}
                  >
                    +{maintenance.repairRate}/t
                    <span style={{ color: '#7a8a9a', marginLeft: 4 }}>
                      · ~{Math.ceil((maxHp - currentHp) / maintenance.repairRate)}t to full
                    </span>
                  </span>
                )}
              </span>
            </div>
            {/* Visual health bar — same green/amber/red thresholds the
                Fleet panel + map badges use, so hull damage reads at a
                glance instead of parsing the number. */}
            {(() => {
              const ratio = maxHp > 0 ? Math.max(0, Math.min(1, currentHp / maxHp)) : 0;
              const tier = ratio > 0.5 ? 'good' : ratio > 0.25 ? 'mid' : 'low';
              return (
                <div className="sp-hpbar" role="meter" aria-valuenow={Math.round(currentHp)}
                     aria-valuemin={0} aria-valuemax={maxHp} aria-label="Hull integrity">
                  <div className={`sp-hpbar__fill sp-hpbar__fill--${tier}`}
                       style={{ width: `${ratio * 100}%` }} />
                </div>
              );
            })()}
            {/* FUEL row removed — fuel left the economy
                (DESIGN-identity-economy.md §1.1). Transfers are free, so
                the number never moved and refuelling was decoration. */}
            <div className="stat-row">
              <span className="label">LOCATION</span>
              <span className="value">{locationLabel}</span>
            </div>
            {/* SPEED, promoted from the combat block below to replace MAX
                ACCEL here.
                MAX ACCEL was engineG, which is a FACTION-wide value: every
                hull you own printed the identical number, so on a panel about
                one ship it carried no information at all. Speed is per-class
                and per-parts, and it drives both how fast this ship arrives
                and how hard it is to hit — which is what a reader wants from
                this row.
                Acceleration is NOT dead, to be clear: engineG still sets the
                burn a torch transfer flies. It is just a property of your
                empire's flight tech rather than of this hull, so it belongs
                in a research/faction readout, not here. */}
            <div
              className="stat-row"
              title="Drives both how fast this ship arrives and how hard it is to hit. Set by hull class and parts."
            >
              <span className="label">SPEED</span>
              <span className="value">
                {combatSpeedOf(ship.class as ShipClassName, ship.parts).toFixed(2)}
              </span>
            </div>
            {/* The standalone ETA row is gone: the countdown now rides the
                LOCATION line ("En route to Mars · T-12"), where destination
                and arrival read as one fact instead of two rows separated by
                MAX ACCEL. Keeping both would just print the number twice. */}
            {/* STATUS is unconditional now. It used to appear ONLY when a
                transfer was planned and said nothing else — so a ship in
                combat, repairing, or auto-retreating had no status line at
                all, which is precisely when you want one. shipStatus covers
                the planned case too ("Planned"), so nothing is lost. */}
            <div className="stat-row" title={status.title}>
              <span className="label">STATUS</span>
              {/* Badge NESTED inside .value rather than sharing the class:
                  `.stat-row .value` sets a colour at specificity (0,2,0) and
                  would outrank `.status-badge--combat` (0,1,0), repainting
                  every status the same grey. On its own element the badge's
                  colour wins. */}
              <span className="value">
                <span className={`status-badge status-badge--${status.cls}`}>
                  {status.label}
                </span>
              </span>
            </div>
            {canRecall && (
              <div className="stat-row">
                <span className="label">LAUNCH</span>
                <button
                  onClick={doRecall}
                  disabled={recalling}
                  title="The burn fires at the top of the next tick — until then this ship can still be called back."
                  style={{
                    background: 'rgba(255,184,77,0.14)',
                    border: '1px solid rgba(255,184,77,0.55)',
                    color: '#ffb84d', borderRadius: 4, cursor: 'pointer',
                    font: 'inherit', fontSize: 10, letterSpacing: '0.08em',
                    padding: '2px 8px',
                  }}
                >
                  {recalling ? 'RECALLING…' : '⟲ RECALL LAUNCH'}
                </button>
              </div>
            )}
          </div>

          {/* Ship configuration — the designer loadout as slot chips +
              a per-part legend. Shown whenever the hull has slots (MP
              designed ships); SP / colony hulls with 0 slots render
              nothing. Deep Scan gate (MP): an enemy hull whose parts the
              server REDACTED shows a lock note instead of reading as a
              bare hull — you don't know its fit until Sensors 5. */}
          {ship.partsRedacted ? (
            <div style={{
              margin: '8px 12px', padding: '7px 10px',
              border: '1px dashed #2a3d50', borderRadius: 4,
              fontSize: 10, color: '#8aa0b4', lineHeight: 1.5,
            }}>
              🔒 Loadout unknown — research <b style={{ color: '#ffb84d' }}>Deep Scan (Sensors 5)</b> to
              read enemy fittings.
            </div>
          ) : (
            <ShipLoadoutSection
              parts={ship.parts}
              shipClass={ship.class as ShipClassName}
              maxHp={maxHp}
              weaponsLvl={gameState.factionTech['player']?.levels?.weapons ?? 0}
            />
          )}

          {/* CAPTAIN (DESIGN-captains §5) — the person commanding this
              hull. Rank/kills below belong to HIM, so this sits directly
              above the record. Own ships get inline rename + portrait
              cycling + bio editing (all optional); rival ships show only
              what Deep Scan reveals (name/avatar/traits, no bio). */}
          {/* Renders for an UNCAPTAINED own ship too — captains are a
              finite resource now (10 to start, the rest recruited), so
              most hulls sail empty and the ship side is where you'd
              naturally go to crew one. Rival ships still only appear
              once Deep Scan has revealed a captain. */}
          {(ship.captainName || (ship.ownedBy === 'player' && mpActions)) && (
            <ShipCaptainCard
              ship={ship}
              captain={(gameState.captains ?? []).find(c => c.id === ship.captainId) ?? null}
              editable={ship.ownedBy === 'player' && !!mpActions}
              bank={(gameState.captains ?? []).filter(c => c.status === 'active' && !c.shipId)}
              onAssign={(captainId) => {
                if (!mpActions) return;
                setCaptainNotice(null);
                void mpActions.assignCaptain(captainId, ship.id).then(res => {
                  if (!res.ok) setCaptainNotice(humanizeMpError(res.code, res.error ?? 'Server rejected the assignment.', 'orders'));
                });
              }}
              onBench={() => {
                if (!ship.captainId || !mpActions) return;
                setCaptainNotice(null);
                void mpActions.assignCaptain(ship.captainId, null).then(res => {
                  if (!res.ok) setCaptainNotice(humanizeMpError(res.code, res.error ?? 'Server rejected the change.', 'orders'));
                });
              }}
              onRename={(name) => { if (ship.captainId && mpActions) mpActions.updateCaptain(ship.captainId, { name }); }}
              onBio={(bio) => { if (ship.captainId && mpActions) mpActions.updateCaptain(ship.captainId, { bio }); }}
              onAvatar={(avatarId) => { if (ship.captainId && mpActions) mpActions.updateCaptain(ship.captainId, { avatarId }); }}
            />
          )}
          {captainNotice && (
            <div
              style={{ fontSize: 10, color: '#ffb84d', margin: '4px 0 0', lineHeight: 1.4, cursor: 'pointer' }}
              onClick={() => setCaptainNotice(null)}
            >
              ⚠ {captainNotice}
            </div>
          )}

          {/* Freighters show TRADE LOG (delivery count) instead of
              COMBAT RECORD (confirmed kills) — they're cargo haulers,
              not warships, and "0 confirmed kills" was a category
              error that read as "underperforming" instead of "this
              ship can't kill." */}
          </>)}
          {activeTab === 'log' && (<>
          {/* Summary first (rank / kills / trade count), then the actual
              per-tick account beneath it. The summary answers "is this hull
              any good"; the log answers "what has it been doing", and Lorne
              wanted the second one. */}
          {ship.class === 'freighter' ? (
            <ShipTradeLog tradesCompleted={ship.tradesCompleted ?? 0} />
          ) : (
            <ShipCombatRecord
              rank={ship.rank ?? 0}
              history={ship.combatHistory ?? []}
              bodies={gameState.bodies}
              hasCaptain={!!ship.captainId}
            />
          )}
          {/* MP only: the endpoint is a multiplayer route and single-player
              has no server to ask. */}
          {mpActions?.gameId && (
            <ShipActivityLog gameId={mpActions.gameId} shipId={ship.id} />
          )}

          {/* Active trade-delivery banner. When this freighter is
              hauling an inter-player shipment the autopilot owns it —
              manual transfers are refused server-side, so say WHY here
              rather than letting the player discover it via a 409. */}
          </>)}
          {activeTab === 'cargo' && (<>
          {ship.class === 'freighter' && ship.ownedBy === 'player' && (() => {
            const haul = (gameState.tradeDeliveries ?? []).find(
              d => d.shipId === ship.id && d.status !== 'delivered' && d.status !== 'lost',
            );
            if (!haul) return null;
            const manifest = [
              haul.metal ? `${haul.metal}M` : null,
              // No F: fuel left the economy, so a manifest can never
              // legitimately carry any (DESIGN-identity-economy §1.1).
              haul.gold ? `${haul.gold}C` : null,
              haul.science ? `${haul.science}S` : null,
            ].filter(Boolean).join(' ');
            const destName = gameState.bodies.find(b => b.id === haul.destBodyId)?.name ?? 'their world';
            const pickupName = gameState.bodies.find(b => b.id === haul.pickupBodyId)?.name ?? 'your world';
            return (
              <div style={{
                margin: '8px 0', padding: '6px 8px',
                border: '1px solid #4ecdc4', borderRadius: 3,
                background: 'rgba(78, 205, 196, 0.08)',
                fontSize: 10, color: '#d8e4ee', lineHeight: 1.5,
              }}>
                <div style={{ color: '#4ecdc4', fontWeight: 700, letterSpacing: '0.08em' }}>
                  ⇢ TRADE SHIPMENT
                </div>
                {haul.loaded
                  ? <>Hauling <b>{manifest}</b> to <b>{destName}</b>. Cargo is aboard — if this ship dies, the killer takes it.</>
                  : <>En route to <b>{pickupName}</b> to load <b>{manifest}</b>.</>}
                {' '}Flies itself until delivery; manual transfers are locked.
                {/* THE LINE THAT USED TO BE ASPIRATIONAL. Until transit
                    combat shipped, a loaded freighter crossing hostile
                    space could not be touched — so the Trades panel's
                    "escort what you can't afford to lose" was advice
                    about nothing. It is true now, and this banner is the
                    moment a player is actually looking at a loaded hull
                    in open space. Gated on the flag, because in a game
                    without transit combat it would be the same lie
                    pointing the other way. */}
                {gameState.transitCombatEnabled && haul.loaded && (
                  <div style={{ marginTop: 4, color: '#ffb84d' }}>
                    Raidable in flight — most exposed leaving and arriving.
                    An escort launched on the same tick to the same world
                    flies alongside it.
                  </div>
                )}
              </div>
            );
          })()}

          {ship.class === 'freighter' && ship.ownedBy === 'player' && (
            <TradeRouteSection
              ship={ship}
              tradeRoutes={gameState.tradeRoutes ?? []}
              bodies={gameState.bodies}
              settlements={gameState.settlements}
              canSupplyDyson={gameState.dysonSphere?.controllerFactionId === 'player'}
              currentTick={gameState.currentTick}
              onSetMining={mpActions
                ? (active) => {
                    setTransferError(null);
                    mpActions.setMining(ship.id, active).then(res => {
                      if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                    });
                  }
                : undefined}
              onCreate={(originBodyId, destBodyId) => {
                if (mpActions) {
                  // MP: the SERVER owns the route taxonomy (terraform /
                  // logistics / dyson). The local SP reducer still
                  // enforces the dead "dest must have a collector" rule
                  // and rejects every terraform run (raw dest, no
                  // collector by definition) — so it must not run, let
                  // alone gate the server post. No optimistic route:
                  // the /state poll lands the authoritative row in
                  // ~1.5s, same contract as deploySettlement.
                  setTransferError(null);
                  mpActions.createTradeRoute(ship.id, originBodyId, destBodyId).then(res => {
                    if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                  });
                  return true;
                }
                // SP: the local mutation is the source of truth.
                return createTradeRoute(ship.id, originBodyId, destBodyId);
              }}
              onCancel={(routeId) => {
                // SP REDUCER, SP ONLY. This used to run unconditionally,
                // so in MP it deleted the route from local state AND
                // credited the hold to the local pool — a phantom refund
                // the next /state poll silently reversed. Worse, it made
                // a FAILED server cancel look like a success: the route
                // vanished, then reappeared on the poll, which is exactly
                // what the "it re-adds it to my trade route list" report
                // described. onCreate right above already guards this
                // way and says why; onCancel never got the same guard.
                if (!mpActions) {
                  cancelTradeRoute(routeId);
                  return;
                }
                if (mpActions) {
                  // The server refuses to cancel a route with ships still
                  // on it, so that deleting a lane is always deliberate.
                  // From THIS button the intent is unambiguous — you are
                  // looking at the freighter — so take it off the route
                  // first and the player sees the same one-click cancel
                  // they always did. Any guards left aboard still block
                  // it, which is the point: they'd be stranded.
                  (async () => {
                    // Detaching is BEST-EFFORT and its failure is
                    // expected: a terraform / dyson / agreement route
                    // pins its carrier and answers 'not_removable'. The
                    // cancel below now tolerates a pinned carrier, so
                    // that refusal is no longer fatal — but it must not
                    // be treated as one either, which is what swallowing
                    // the result here quietly used to imply.
                    await mpActions.removeRouteShip(routeId, ship.id);
                    const res = await mpActions.cancelTradeRoute(routeId);
                    if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                  })();
                }
              }}
              contractedCargo={(() => {
                const d = (gameState.tradeDeliveries ?? []).find(
                  x => x.shipId === ship.id && x.loaded && x.status !== 'delivered');
                if (!d) return null;
                const parts = [
                  d.metal   > 0 ? `${Math.round(d.metal)} metal`     : null,
                  d.gold    > 0 ? `${Math.round(d.gold)} credits`    : null,
                  d.science > 0 ? `${Math.round(d.science)} science` : null,
                ].filter(Boolean).join(' · ');
                return parts || null;
              })()}
              // MP only: SP has no server pool transaction to bank the
              // hold, so the box renders read-only there.
              onUnload={mpActions ? () => {
                setTransferError(null);
                mpActions.unloadHold(ship.id).then(res => {
                  if (!res.ok) setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                });
              } : undefined}
            />
          )}


          </>)}
          {activeTab === 'ship' && (<>
          {(currentFleet || eligiblePeers.length > 0) && (
            <div className="fleet-section" data-tutorial-id="ship-fleet-section">
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
                      onClick={() => {
                        if (mpActions) {
                          void fleetApi('PATCH', `/fleets/${encodeURIComponent(currentFleet.id)}`,
                            { remove_ship_ids: [ship.id] });
                        } else removeFromFleet(currentFleet.id, ship.id);
                      }}
                    >
                      LEAVE
                    </button>
                    <button
                      className="maneuver-btn"
                      style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
                      onClick={() => {
                        if (mpActions) {
                          void fleetApi('DELETE', `/fleets/${encodeURIComponent(currentFleet.id)}`);
                        } else disbandFleet(currentFleet.id);
                      }}
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
              {/* A rejected fleet action is indistinguishable from a dead
                  button unless the reason is on screen. The server has
                  good ones — no captain on the flagship, a member still
                  under fire — and none of them used to reach the player. */}
              {fleetError && (
                <button
                  onClick={() => setFleetError(null)}
                  className="orders-config-error"
                  title="Click to dismiss"
                >⚠ {fleetError}</button>
              )}
            </div>
          )}

          {(ship.damagePerTick ?? shipClass.damagePerTick) > 0 && (
            <div className="engagement-section">
              <div className="section-title">COMBAT</div>
              <div className="stat-row">
                <span className="label">DAMAGE</span>
                {/* Server-authoritative damage when present (weapon parts +
                    Weapons tech, stamped at build).
                    COMBAT V2 dropped the CADENCE row: every hull now fires
                    every tick, so the line said the same thing on every ship
                    and carried no information. "/tick" replaces "/volley" so
                    the rate stays legible without it. */}
                <span className="value">{ship.damagePerTick ?? shipClass.damagePerTick}/tick</span>
              </div>
              {/* SPEED moved up to the summary rows, where MAX ACCEL used
                  to be. Not duplicated here — one number, one place. */}
              {/* Engagement blurb tracks the current STANCE — the fixed
                  "auto-fires at any hostile" copy contradicted a ship set
                  to DEFEND/HOLD. In SP (no orders) stance defaults to
                  attack, so this reads the same as before. Hold is tinted
                  amber since the ship won't fight. */}
              <div
                className="stat-row"
                style={{
                  fontSize: '9px',
                  color: currentStance === 'hold' ? '#ffb84d' : '#b8c8d6',
                  fontStyle: 'italic',
                }}
              >
                {currentStance === 'attack'
                  ? (mpActions && ship.ownedBy === 'player'
                    // The priority cards render right under this line, so
                    // the copy can point at them. Rival ships (no cards
                    // shown) keep a self-contained version.
                    ? 'Fires once per tick according to the target priority below.'
                    : 'Fires once per tick at any hostile sharing this body.')
                  : currentStance === 'defensive'
                    ? 'Returns fire only — engages hostiles that attack here.'
                    : 'Holding fire — will not engage, even under attack.'}
              </div>
              {/* Who this hull is actually shooting, resolved from the
                  server's stamped engagement. The priority cards say what
                  it WOULD pick; this says what it DID. */}
              <CurrentTargetRow ship={ship} />
            </div>
          )}

          </>)}
          {activeTab === 'orders' && (<>
          {mpActions
            && ship.ownedBy === 'player'
            && countPart(ship.parts, 'detonator') > 0 && (
            <DetonatorSection
              ship={ship}
              maxHp={maxHp}
              weaponsLvl={gameState.factionTech['player']?.levels?.weapons ?? 0}
              inTransit={!!ship.transit}
              onDetonate={async () => {
                const res = await mpActions.detonateShip(ship.id);
                if (!res.ok) {
                  setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
                  return false;
                }
                // The ship is gone — close the panel; the next /state
                // poll removes it from the map.
                deselectShip();
                return true;
              }}
            />
          )}
          </>)}

        </div>
      </div>
      </BottomSheet>

      {transferModalOpen && (
        <TransferTargetPicker
          bodies={gameState.bodies}
          excludeBodyId={ship.orbit.parentBodyId}
          title={hasExistingTransfer ? 'Chain Move To' : 'Move To Target'}
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

/**
 * Group label + ordering for the picker.
 *
 * Grouping comes from systemGrouping.ts — the SAME model the senate
 * counts vote weight with and the outliner sorts by. This used to be a
 * private taxonomy here, and it was wrong twice over:
 *
 *   1. It mixed two different ideas. Sun-orbiters were bucketed by TYPE
 *      ("Gas giants", "Ice giants") while moons were bucketed by SYSTEM
 *      ("Jupiter system"), so Jupiter sat in one group and the Galileans
 *      in another. Asking for a moon of Jupiter meant knowing Jupiter
 *      was filed under its composition.
 *   2. Its asteroid-belt test was `orbitRadius < 500`, written before
 *      SYSTEM_SCALE=2 doubled every heliocentric orbit (worker/factions.js).
 *      Ceres sits at 360×2=720, so the belt bucket became UNREACHABLE and
 *      every main-belt rock — Ceres, Vesta, Pallas, Juno, Hygiea — was
 *      labelled "Kuiper belt". findBelts() clusters on a RATIO instead,
 *      so it cannot rot the same way when the map is rescaled.
 *
 * `farSystem: true` flags the group as collapsible — Centauri and Cygnus
 * X live behind a toggle so the Sol picker isn't dominated by 15+ exotic
 * destinations. They stay hand-folded here on purpose: each is one
 * DESTINATION in the player's head regardless of its internal
 * parent-child structure (Prismara orbits Crimson but belongs in the
 * Centauri bucket, not a "Crimson System" of its own).
 */
function pickerGroupOf(
  body: import('../types').Body,
  rootOf: (bodyId: string) => string,
): { key: string; farSystem?: boolean } {
  if (BINARY_SYSTEM_BODY_IDS.has(body.id)) return { key: 'centauri', farSystem: true };
  if (BLACK_HOLE_SYSTEM_BODY_IDS.has(body.id)) return { key: 'cygnus', farSystem: true };
  return { key: rootOf(body.id) };
}

// Exported so the world menu can reuse it for "where should this hull go
// when it is built". One destination picker for the whole game: a second
// one would drift in grouping, search and mobile layout the moment
// either was touched.
export const TransferTargetPicker: React.FC<TransferTargetPickerProps> = ({
  bodies, excludeBodyId, title, onPick, onClose,
}) => {
  const [query, setQuery] = useState('');
  // Per-group expansion state. Far-system groups (Centauri / Cygnus X)
  // are collapsed by default; the player toggles them open. Sol-system
  // groups have no toggle and are always shown. An active search
  // query auto-expands any far group that has matches inside it (see
  // the render logic below), without persisting that expansion — clear
  // the query and the group collapses again.
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bodies.filter(b => {
      // Sol is a legal target — Dyson sphere ferry already routes
      // freighters there, and players occasionally want to park a
      // ship in close-solar orbit. Only the origin body is excluded
      // from the picker (can't transfer to where you already are).
      if (b.id === excludeBodyId) return false;
      // Lagrange-type markers (the Centauri + Cygnus barycenters) are
      // invisible centre-of-mass points with no SOI or mu — there's
      // nothing to park around. Hide them so the player can't try.
      if (b.type === 'lagrange') return false;
      if (!q) return true;
      const parentName = b.parent ? bodies.find(x => x.id === b.parent)?.name.toLowerCase() ?? '' : '';
      return b.name.toLowerCase().includes(q) || parentName.includes(q);
    });
  }, [bodies, excludeBodyId, query]);

  // Built once per body list, not per body: makeSystemRootOf computes
  // belt clustering up front and memoizes the parent walk internally.
  const rootOf = useMemo(() => makeSystemRootOf(bodies), [bodies]);

  const groups = useMemo(() => {
    const byId = new Map(bodies.map(b => [b.id, b]));
    const map = new Map<string, { label: string; order: number; farSystem?: boolean; bodies: import('../types').Body[] }>();
    for (const b of visible) {
      const g = pickerGroupOf(b, rootOf);
      if (!map.has(g.key)) {
        // Far systems keep their hand-written names; everything else is
        // named by systemLabel, which already knows that a bare rock is
        // "Midas" and only a body with satellites earns "… System".
        const label = g.key === 'centauri' ? 'Centauri system'
          : g.key === 'cygnus' ? 'Cygnus X system'
          : systemLabel(bodies, g.key);
        map.set(g.key, { label, order: 0, farSystem: g.farSystem, bodies: [] });
      }
      map.get(g.key)!.bodies.push(b);
    }
    // Order Sol groups by distance from the sun, so the list reads
    // outward — Core, Earth, Mars, the Belt, Jupiter … Kuiper. That is
    // the map players already have in their heads, and it beats an
    // arbitrary hand-assigned rank that has to be renumbered whenever a
    // group is added.
    //
    // Two shapes of key: a REAL body (jupiter → use its own orbit) and a
    // SYNTHETIC root (the Core, and each belt — no body carries that id,
    // so fall back to the median orbit of its members).
    for (const [key, v] of map.entries()) {
      v.bodies.sort((a, b) => a.name.localeCompare(b.name));
      if (v.farSystem) { v.order = key === 'centauri' ? 1e9 : 1e9 + 1; continue; }
      const root = byId.get(key);
      if (root) { v.order = root.orbitRadius ?? 0; continue; }
      const radii = v.bodies.map(b => b.orbitRadius ?? 0).sort((a, b) => a - b);
      v.order = radii[Math.floor(radii.length / 2)] ?? 0;
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [visible, bodies, rootOf]);

  // Active-query auto-expand: when the player is searching, any
  // far-system group that has matches gets opened so the matches are
  // actually visible. Without this, the matches would just be hidden
  // behind a still-collapsed toggle and the search would silently
  // appear to find nothing.
  const hasActiveQuery = query.trim().length > 0;
  const toggleGroup = (key: string) => {
    setManualExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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
              <div style={{ color: '#b8c8d6', fontSize: 11, textAlign: 'center', padding: '24px 0' }}>
                No bodies match "{query}".
              </div>
            )}
            {groups.map(g => {
              // Far-system groups (Centauri / Cygnus) collapse by
              // default. Open when the player clicks the toggle OR
              // when an active search query has matches inside
              // (otherwise the search appears to find nothing).
              const isCollapsible = g.farSystem;
              const isOpen = !isCollapsible || hasActiveQuery || manualExpanded.has(g.key);
              const headerColor = g.farSystem ? '#ffb84d' : '#b8c8d6';
              return (
                <div key={g.key}>
                  {isCollapsible ? (
                    // Clickable header for the collapsible far groups.
                    // Caret rotates open/closed so the affordance reads
                    // even without hover state.
                    <button
                      onClick={() => toggleGroup(g.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        width: '100%', padding: '4px 0',
                        background: 'transparent', border: 'none',
                        cursor: 'pointer',
                        fontSize: 9, letterSpacing: '0.14em', color: headerColor,
                        textTransform: 'uppercase',
                        fontFamily: 'inherit', textAlign: 'left',
                        marginBottom: isOpen ? 6 : 0,
                      }}
                      title={isOpen ? 'Hide far-system bodies' : 'Show far-system bodies'}
                    >
                      <span style={{
                        display: 'inline-block',
                        transition: 'transform 0.15s',
                        transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}>▶</span>
                      {g.label} · {g.bodies.length}
                    </button>
                  ) : (
                    <div style={{
                      fontSize: 9, letterSpacing: '0.14em', color: headerColor,
                      textTransform: 'uppercase', marginBottom: 6,
                    }}>
                      {g.label} · {g.bodies.length}
                    </div>
                  )}
                  {isOpen && (
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
                  )}
                </div>
              );
            })}
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
                  <span style={{ color: '#b8c8d6', fontSize: 9 }}>{p.class.toUpperCase()}</span>
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

// ----------------------------------------------------------------
// TradeRouteSection — freighter-only. Shows the active route (with
// cargo + cancel) or a "+ TRADE ROUTE" button that opens a picker
// for origin (any player settlement) + destination (any player
// collector). Once created, the per-tick reducer auto-pilots the
// freighter: fill at origin → transfer → dump at dest → return →
// repeat until cancelled.
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// ShipTradeLog — freighter-only delivery counter.
//
// Replaces ShipCombatRecord on freighters since they can't actually
// kill anything (damagePerTick === 0 in the class def). Shows a
// running count of completed deliveries on active trade routes —
// incremented server-side in worker/room.js when a freighter dumps
// cargo at a dest body, and SP-side in gameContext.tsx's matching
// DELIVERY branch.
// ----------------------------------------------------------------
const ShipTradeLog: React.FC<{ tradesCompleted: number }> = ({ tradesCompleted }) => {
  return (
    <div className="combat-record-section" style={{ marginTop: 10 }}>
      <div
        className="section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
      >
        <span>TRADE LOG</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {tradesCompleted > 0
            ? `${tradesCompleted} route${tradesCompleted === 1 ? '' : 's'} completed`
            : 'No deliveries yet.'}
        </span>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------
// ShipCombatRecord — per-ship rank + kill log, collapsible.
//
// Rank summary is always visible (shows the +%/+% bonuses). The
// kill list collapses by default and expands on click — the ledger
// can run up to KILL_HISTORY_CAP=20 entries and we don't want to
// dominate the panel for veteran ships. Targets are rendered with
// their class + which body they died at, plus the tick stamp so
// the player can correlate with their event log.
// ----------------------------------------------------------------
/**
 * CAPTAIN card (DESIGN-captains §5) — identity for the officer aboard.
 * Everything is optional to touch: click the portrait to cycle it, ✎ to
 * rename, the bio line to write one. Rival captains render read-only
 * (and only once Deep Scan reveals them; the server nulls them out).
 */
const ShipCaptainCard: React.FC<{
  ship: Ship;
  captain: import('../types').Captain | null;
  editable: boolean;
  /** Unassigned active captains available to post to this hull. */
  bank: import('../types').Captain[];
  onAssign: (captainId: string) => void;
  onBench: () => void;
  onRename: (name: string) => void;
  onBio: (bio: string) => void;
  onAvatar: (avatarId: string) => void;
}> = ({ ship, captain, editable, bank, onAssign, onBench, onRename, onBio, onAvatar }) => {
  const [editingName, setEditingName] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const rank = ship.rank ?? 0;
  const traits = ship.captainTraits ?? captain?.traits ?? [];
  const avatarId = ship.captainAvatar ?? captain?.avatarId ?? null;
  const name = ship.captainName ?? captain?.name ?? 'Unknown';

  const selectStyle: React.CSSProperties = {
    background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
    color: '#9fb4c6', fontFamily: 'inherit', fontSize: 10, padding: '2px 4px',
    maxWidth: '100%',
  };

  // No officer aboard: the hull still gets a CAPTAIN section so the slot
  // reads as empty-and-fillable rather than simply absent.
  if (!ship.captainName) {
    return (
      <div className="combat-record-section" style={{ marginTop: 10 }}>
        <div className="section-title"><span>CAPTAIN</span></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0 2px' }}>
          <div style={{ opacity: 0.35, flexShrink: 0 }}>
            <CaptainAvatar avatarId={null} size={CAPTAIN_PORTRAIT_PX} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#8aa0b4', marginBottom: 4 }}>
              No officer aboard — no trait, no rank growth.
            </div>
            {editable && (
              bank.length > 0 ? (
                <select
                  value=""
                  style={selectStyle}
                  onChange={(e) => { if (e.target.value) onAssign(e.target.value); }}
                  title="Post a captain from the bank to this ship"
                >
                  <option value="">POST A CAPTAIN…</option>
                  {bank.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.rank > 0 ? ` · ${c.rank} ⚔` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 10, color: '#5f7488' }}>
                  Bank empty — recruit one from the Fleet panel.
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="combat-record-section" style={{ marginTop: 10 }}>
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>CAPTAIN</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {rankTier(rank)}{rank > 0 ? ` · ${rank} ⚔` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0 2px' }}>
        <button
          onClick={() => {
            if (!editable) return;
            onAvatar(rerollAvatarId(avatarId));
          }}
          disabled={!editable}
          title={editable ? 'Change portrait' : undefined}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            cursor: editable ? 'pointer' : 'default', flexShrink: 0,
          }}
        >
          <CaptainAvatar avatarId={avatarId} size={CAPTAIN_PORTRAIT_PX} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <input
              autoFocus
              defaultValue={name}
              maxLength={32}
              style={{
                width: '100%', background: '#14202c', border: '1px solid #2a3d50',
                borderRadius: 3, color: '#d8e4ee', fontFamily: 'inherit', fontSize: 12, padding: '2px 6px',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim();
                  setEditingName(false);
                  if (v && v !== name) onRename(v);
                }
                if (e.key === 'Escape') setEditingName(false);
              }}
              onBlur={() => setEditingName(false)}
            />
          ) : (
            // Name is the heading of this card, so it scales with the
            // portrait; at 12px beside a 72px face it read as a caption.
            <div style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: '#e8f0f8', letterSpacing: '0.01em',
              }}>{name}</span>
              {editable && (
                <button
                  onClick={() => setEditingName(true)}
                  title="Rename captain"
                  style={{ background: 'transparent', border: 'none', color: '#5f7488', cursor: 'pointer', fontSize: 10 }}
                >✎</button>
              )}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#9fe8e2', margin: '3px 0' }}>
            {traitSummary(traits) || 'No notable traits'}
          </div>
          {editingBio ? (
            <textarea
              autoFocus
              defaultValue={captain?.bio ?? ''}
              maxLength={240}
              rows={2}
              style={{
                width: '100%', background: '#14202c', border: '1px solid #2a3d50',
                borderRadius: 3, color: '#d8e4ee', fontFamily: 'inherit', fontSize: 10,
                padding: '3px 6px', resize: 'vertical',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const v = (e.target as HTMLTextAreaElement).value.trim();
                  setEditingBio(false);
                  if (v !== (captain?.bio ?? '')) onBio(v);
                }
                if (e.key === 'Escape') setEditingBio(false);
              }}
              onBlur={() => setEditingBio(false)}
            />
          ) : (
            <div
              onClick={() => editable && setEditingBio(true)}
              title={editable ? 'Click to write a bio' : undefined}
              style={{
                fontSize: 10, color: captain?.bio ? '#8aa0b4' : '#5f7488',
                fontStyle: captain?.bio ? 'italic' : 'normal',
                cursor: editable ? 'pointer' : 'default', lineHeight: 1.4,
              }}
            >
              {captain?.bio || (editable ? 'Write a bio…' : '')}
            </div>
          )}
          {editable && (
            <select
              value=""
              style={{ ...selectStyle, marginTop: 6 }}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__bench') onBench();
                else if (v) onAssign(v);
              }}
              title="Swap in another captain, or send this one back to the bank"
            >
              <option value="">REASSIGN…</option>
              <option value="__bench">→ To the bank</option>
              {/* The bonus rides along with the name (player feedback).
                  Without it the only way to learn what a bank captain
                  does was to swap them in, read the card, and swap back —
                  or leave the ship entirely for the captains menu. A
                  dropdown you have to commit to before it tells you
                  anything isn't a chooser.

                  Plain text, because a native <option> renders no markup;
                  `title` carries the fuller phrasing where the browser
                  shows option tooltips. */}
              {bank.map(c => {
                const brief = traitBrief(c.traits);
                return (
                  <option
                    key={c.id}
                    value={c.id}
                    title={traitSummary(c.traits) || 'No notable traits'}
                  >
                    Swap in {c.name}{c.rank > 0 ? ` · ${c.rank} ⚔` : ''}
                    {brief ? ` — ${brief}` : ' — no trait'}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * CURRENT TARGET — who this hull is actually shooting.
 *
 * The priority cards above say what the ship WOULD pick; this says what
 * the server actually stamped on its last volley (last_target_id, the
 * same field the map's tracer aims at), so the two can be compared when
 * a doctrine doesn't do what the player expected.
 *
 * Odds and damage are computed with the same formulas the tick runs:
 * hitChanceOf on the two combat speeds, and the attacker's damage
 * through the target's TYPED mitigation (shields cut kinetic, armor cuts
 * energy), floored exactly as room.js floors it. Expected/tick folds the
 * hit chance in — the honest number for "how long until that thing
 * dies", which is the question the section exists to answer.
 *
 * Deliberately NOT modelled here: rank, captain traits, flag auras,
 * arrears, and senate war authorization. Those are multipliers the tick
 * applies on top, so the figure is a floor, and the footnote says so
 * rather than quoting a number that quietly disagrees with the log.
 */
const CurrentTargetRow: React.FC<{ ship: Ship }> = ({ ship }) => {
  const { gameState } = useGameContext();
  const baseDamage = ship.damagePerTick ?? getShipClass(ship.class as ShipClassName).damagePerTick;
  if (baseDamage <= 0) return null;   // freighters/colony ships never engage

  // The server stamps last_target_id only when a hull actually FIRES, so
  // a ship that just arrived in a brawl has none. Falling back to a
  // prediction means the section always answers "who am I shooting" —
  // rendering nothing mid-battle read as a bug.
  const stampedId = ship.lastTargetId;
  const stampedShip = stampedId ? gameState.ships.find(s => s.id === stampedId) : undefined;
  const stampedStl = stampedId && !stampedShip
    ? gameState.settlements.find(s => s.id === stampedId)
    : undefined;

  const predicted = (!stampedShip && !stampedStl)
    ? predictTarget({
      attacker: ship,
      ships: gameState.ships,
      settlements: gameState.settlements,
      pactPairs: gameState.pactPairs,
      damagePerTick: baseDamage,
    })
    : null;

  const tShip = stampedShip ?? (predicted?.target?.kind === 'ship' ? predicted.target.ship : undefined);
  const tStl = stampedStl ?? (predicted?.target?.kind === 'settlement' ? predicted.target.settlement : undefined);
  /** True when we're showing what it WILL shoot, not what it did. */
  const isPrediction = !stampedShip && !stampedStl;

  // Nothing to shoot — say WHY instead of vanishing, but only while the
  // hull is somewhere a fight could happen. A ship parked alone in a
  // quiet orbit doesn't need a combat readout at all.
  if (!tShip && !tStl) {
    const reason = predicted?.reason;
    if (reason === 'hold') {
      return (
        <div className="sp-target sp-target--idle">
          <div className="sp-target__head"><span className="sp-target__title">NO TARGET</span></div>
          <div className="sp-target__foot">
            Standing order is HOLD FIRE — this hull will not engage, even under attack.
          </div>
        </div>
      );
    }
    if (reason === 'in-transit') {
      return (
        <div className="sp-target sp-target--idle">
          <div className="sp-target__head"><span className="sp-target__title">NO TARGET</span></div>
          <div className="sp-target__foot">
            {/* This said transit hulls neither fire nor take fire, which
                stopped being true the moment transit combat shipped —
                and the panel kept saying it in games where the rule had
                changed underneath the player. */}
            {gameState.transitCombatEnabled
              ? 'Under burn — you can trade fire with anything under way, '
                + 'and with what is parked only for the first tick after '
                + 'leaving. Retreat orders do not apply: a committed burn '
                + 'cannot be re-aimed.'
              : 'Under burn — ships in transit neither fire nor take fire.'}
          </div>
        </div>
      );
    }
    return null;   // parked, nothing hostile here: no readout needed
  }

  // Live multipliers. Only computable for OUR ships: a rival's tech,
  // upkeep ledger and captain roster are intel we don't hold, so their
  // card shows the stamped figure rather than a confident wrong number.
  const isMine = ship.ownedBy === 'player';
  const myFleet = isMine
    ? gameState.fleets.find(f => f.shipIds.includes(ship.id))
    : undefined;
  // The flagship's own captain already applies at full strength; an
  // aura on itself would double-dip the same trait.
  const flagShipId = myFleet?.flagCaptainId
    ? gameState.ships.find(s => s.captainId === myFleet.flagCaptainId)?.id
    : undefined;
  const flagTraits = myFleet && flagShipId !== ship.id
    ? myFleet.flagCaptainTraits
    : undefined;
  const arrears = gameState.fleetArrears;
  const inArrears = !!arrears && ((arrears.credits ?? 0) > 0 || (arrears.ore ?? 0) > 0);
  // Senate war authorization doubles damage dealt TO the sanctioned
  // faction. Target ownedBy is a raw faction id for every rival (only
  // OUR ships get rewritten to 'player'), so a direct compare is right
  // for every case that can actually occur — you never shoot yourself.
  const targetFaction = tShip?.ownedBy ?? tStl?.ownedBy;
  const warAuthorized = (gameState.senateSanctions ?? []).some(
    s => s.kind === 'war_authorization' && s.targetFactionId === targetFaction,
  );

  const profileForTech = damageProfile(ship.parts);
  const { total: bonusMul, factors } = isMine
    ? attackerDamageFactors({
      rank: ship.rank,
      captainTraits: ship.captainTraits,
      flagTraits,
      profile: profileForTech,
      tech: gameState.factionTech[ship.ownedBy],
      inArrears,
      warAuthorized,
    })
    : { total: 1, factors: [] };
  const myDamage = baseDamage * bonusMul;

  const mySpeed = combatSpeedOf(ship.class as ShipClassName, ship.parts);
  // A settlement is mechanically a destroyer that cannot move
  // (SETTLEMENT_SPEED in worker/factions.js).
  const targetSpeed = tShip
    ? combatSpeedOf(tShip.class as ShipClassName, tShip.parts)
    : SETTLEMENT_COMBAT_SPEED;
  const odds = hitChanceOf(mySpeed, targetSpeed);

  // Settlements carry no shield/armor parts, so bombardment lands in
  // full — matching the room.js bombardment branch.
  const profile = damageProfile(ship.parts);
  const mit = tShip
    ? Math.max(MITIGATION_FLOOR, defenseMitigation(tShip.parts, profile))
    : 1;
  const perHit = myDamage * mit;
  const perTick = perHit * odds;

  const name = tShip?.name ?? tStl?.name ?? 'Unknown';
  const kindLabel = tShip
    ? getShipClass(tShip.class as ShipClassName).displayName.toUpperCase()
    : (tStl?.type === 'station' ? 'STATION' : 'CITY');
  const targetHp = tShip?.hp ?? tStl?.hp ?? 0;
  // Ticks to kill at the expected rate — the "so what" of the numbers
  // above. Only shown when this hull alone could actually finish it.
  const ttk = perTick > 0 ? Math.ceil(targetHp / perTick) : Infinity;

  return (
    <div className={`sp-target${isPrediction ? ' sp-target--next' : ''}`}>
      <div className="sp-target__head">
        <span className="sp-target__title">
          {isPrediction ? 'NEXT TARGET' : 'CURRENT TARGET'}
        </span>
        <span className="sp-target__kind">{kindLabel}</span>
      </div>
      <div className="sp-target__name">{name}</div>
      <div className="sp-target__grid">
        <span className="sp-target__k">ODDS TO HIT</span>
        <span className="sp-target__v" title={`This ship's speed ${mySpeed.toFixed(2)} against the target's ${targetSpeed.toFixed(2)}.`}>
          {Math.round(100 * odds)}%
        </span>
        <span className="sp-target__k">PER HIT</span>
        <span className="sp-target__v" title={mit < 1
          ? `${myDamage.toFixed(1)} after bonuses, cut to ${Math.round(100 * mit)}% by the target's defensive parts.`
          : 'The target carries nothing that counters this weapon type.'}>
          {perHit.toFixed(1)}
          {mit < 1 && <span className="sp-target__dim"> ({Math.round(100 * mit)}%)</span>}
        </span>
        <span className="sp-target__k">EXPECTED</span>
        <span className="sp-target__v sp-target__v--hero" title="Damage per hit times the chance of landing it — the real rate this target is losing hull.">
          {perTick.toFixed(1)}<span className="sp-target__dim">/tick</span>
        </span>
      </div>
      {/* Show the work: every live multiplier folded into the numbers
          above, so a player can see WHY their frigate is hitting for
          more than its stat line — and spot an arrears penalty they
          didn't know they were paying. */}
      {factors.length > 0 && (
        <div className="sp-target__bonus">
          <span className="sp-target__bonus-lead">
            {baseDamage.toFixed(1)} base ×{bonusMul.toFixed(2)}
          </span>
          {factors.map(f => (
            <span
              key={f.label}
              className={`sp-target__chip${f.mul < 1 ? ' sp-target__chip--bad' : ''}`}
            >
              {f.label} ×{f.mul.toFixed(2)}
            </span>
          ))}
        </div>
      )}
      <div className="sp-target__foot">
        {isPrediction && 'Hasn’t fired yet — this is who it picks on the next volley. '}
        {Number.isFinite(ttk)
          ? `${Math.round(targetHp)} HP left — about ${ttk} tick${ttk === 1 ? '' : 's'} at this rate, alone.`
          : `${Math.round(targetHp)} HP left.`}
        {!isMine && ' Rival bonuses are intel we don’t hold — base damage only.'}
      </div>
    </div>
  );
};

const ShipCombatRecord: React.FC<{
  rank: number;
  history: import('../types').ShipKillRecord[];
  bodies: Body[];
  /** Veterancy is captain-only — an uncrewed hull banks nothing, and
   *  the record should say so rather than looking merely empty. */
  hasCaptain?: boolean;
}> = ({ rank, history, bodies, hasCaptain }) => {
  const [expanded, setExpanded] = useState(false);
  const kills = history.length;
  const dmgBonus = rank;     // each rank = +1%
  const hpBonus  = rank;     // each rank = +1%
  return (
    <div className="combat-record-section" data-tutorial-id="ship-combat-record" style={{ marginTop: 10 }}>
      <div
        className="section-title"
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          cursor: kills > 0 ? 'pointer' : 'default',
        }}
        onClick={() => kills > 0 && setExpanded(v => !v)}
        title={kills > 0 ? 'Toggle combat record' : undefined}
      >
        <span>COMBAT RECORD</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {kills > 0 ? `${kills} kill${kills === 1 ? '' : 's'} · ${expanded ? '▲' : '▼'}` : 'No confirmed kills.'}
        </span>
      </div>
      {rank > 0 && (
        <div className="stat-row" style={{ marginTop: 4 }}>
          <span className="label">VETERANCY</span>
          <span className="value" style={{ color: '#ffb84d' }}>
            +{dmgBonus}% DMG · +{hpBonus}% HP
          </span>
        </div>
      )}
      {/* The record belongs to the OFFICER. Without one, kills are still
          chronicled but bank no veterancy — say it here so an empty
          record on a ship that has clearly been fighting doesn't read
          as a bug. */}
      {!hasCaptain && (
        <div style={{ marginTop: 4, fontSize: 9, color: '#7a8a9a', fontStyle: 'italic' }}>
          Kills are credited to the captain. With no officer aboard this hull
          banks nothing — assign one from the Fleet panel.
        </div>
      )}
      {expanded && kills > 0 && (
        <ul
          style={{
            listStyle: 'none', padding: 0, margin: '6px 0 0',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}
        >
          {history.slice().reverse().map((k, i) => {
            const body = bodies.find(b => b.id === k.atBodyId);
            return (
              <li
                key={`${k.tick}-${i}`}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  padding: '3px 6px',
                  background: 'rgba(255, 184, 77, 0.04)',
                  border: '1px solid #2a3d50',
                  borderRadius: 3,
                  fontSize: 10,
                }}
              >
                <span style={{ color: '#ff5e5e' }}>
                  ✕ {k.targetName}
                  <span style={{ color: '#b8c8d6', marginLeft: 4 }}>
                    ({k.targetClass})
                  </span>
                </span>
                <span style={{ color: '#b8c8d6', fontSize: 9 }}>
                  T+{k.tick} · {body?.name ?? k.atBodyId}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

// ----------------------------------------------------------------
// DetonatorSection — manual trigger for detonator-fitted hulls
// (ship designer §2.2, MP only).
//
// UX REQUIREMENT (spec, explicit): every surface where the detonator
// appears must state ALL THREE — the damage number, that it hits
// friend and foe alike, and that the ship is destroyed. The button
// tooltip, the confirm step, and the section body all carry the full
// detonatorDisclosure() copy. Two-step confirm so a mis-click can't
// vaporize a fleet.
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// ShipLoadoutSection — the designer configuration, shown as a strip of
// slot chips (fitted parts glyph-coded, empty slots dimmed) plus a
// per-part legend with effects. Detonator rows carry the full §2.2
// disclosure in their tooltip. Hulls with 0 slots (colony / SP ships
// without a parts field) render nothing.
// ----------------------------------------------------------------
const ShipLoadoutSection: React.FC<{
  parts: string[] | undefined;
  shipClass: ShipClassName;
  maxHp: number;
  weaponsLvl: number;
}> = ({ parts, shipClass, maxHp, weaponsLvl }) => {
  const totalSlots = SHIP_SLOT_COUNTS[shipClass] ?? 0;
  if (totalSlots === 0) return null;
  const fitted = sanitizeParts(parts);

  // Slot chips: fitted parts first (in fit order), then dimmed empties.
  const slots: (ShipPartId | null)[] = [...fitted];
  while (slots.length < totalSlots) slots.push(null);

  // Legend: distinct parts in a fixed order with counts + effects.
  const groups = ALL_PART_IDS
    .map(id => ({ id, n: fitted.filter(p => p === id).length }))
    .filter(g => g.n > 0);

  return (
    <div className="ship-loadout">
      <div className="ship-loadout__head">
        <span className="section-title">CONFIGURATION</span>
        <span className="ship-loadout__count">{fitted.length}/{totalSlots} SLOTS</span>
      </div>

      <div className="ship-loadout__chips">
        {slots.map((p, i) => (
          p === null ? (
            <span key={i} className="ship-loadout__chip ship-loadout__chip--empty" title="Empty slot">·</span>
          ) : (
            <span
              key={i}
              className={`ship-loadout__chip${p === 'detonator' ? ' ship-loadout__chip--danger' : ''}`}
              title={SHIP_PART_DEFS[p].name}
            >
              {PART_GLYPH[p]}
            </span>
          )
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="ship-loadout__bare">Bare hull — no parts fitted.</div>
      ) : (
        <div className="ship-loadout__legend">
          {groups.map(g => {
            const def = SHIP_PART_DEFS[g.id];
            const isDet = g.id === 'detonator';
            return (
              <div
                key={g.id}
                className={`ship-loadout__row${isDet ? ' ship-loadout__row--danger' : ''}`}
                title={isDet
                  ? detonatorDisclosure(detonatorDamage(maxHp, g.n, weaponsLvl))
                  : `${def.name} — ${def.blurb}`}
              >
                <span className="ship-loadout__glyph">{PART_GLYPH[g.id]}</span>
                <span className="ship-loadout__name">
                  {def.name}{g.n > 1 ? ` ×${g.n}` : ''}
                </span>
                <span className="ship-loadout__effect">{def.blurb}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const DetonatorSection: React.FC<{
  ship: Ship;
  maxHp: number;
  weaponsLvl: number;
  inTransit: boolean;
  /** Fires the server detonate call. Resolves true on success. */
  onDetonate: () => Promise<boolean>;
}> = ({ ship, maxHp, weaponsLvl, inTransit, onDetonate }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reset the confirm step when the selected ship changes.
  useEffect(() => { setConfirming(false); }, [ship.id]);

  const nDet = countPart(ship.parts, 'detonator');
  const damage = detonatorDamage(maxHp, nDet, weaponsLvl);
  const disclosure = detonatorDisclosure(damage);

  return (
    <div className="engagement-section" style={{ borderColor: '#ff5e5e' }}>
      <div className="section-title" style={{ color: '#ff5e5e' }}>
        ☠ DETONATOR ({nDet}×)
      </div>
      <div style={{ fontSize: 10, color: '#ffb0b0', lineHeight: 1.5, margin: '4px 0 8px' }}>
        {disclosure}
      </div>
      {inTransit ? (
        <div style={{ fontSize: 10, color: '#b8c8d6', fontStyle: 'italic' }}>
          Cannot detonate mid-transfer — wait for arrival.
        </div>
      ) : !confirming ? (
        <button
          className="maneuver-btn"
          style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
          onClick={() => setConfirming(true)}
          title={disclosure}
        >
          ☠ DETONATE
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, color: '#ff5e5e', fontWeight: 700, lineHeight: 1.5 }}>
            CONFIRM: {disclosure}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="maneuver-btn"
              disabled={busy}
              style={{
                borderColor: '#ff5e5e', color: '#fff',
                background: 'rgba(255, 94, 94, 0.25)', fontWeight: 700,
              }}
              onClick={async () => {
                setBusy(true);
                const ok = await onDetonate();
                setBusy(false);
                if (!ok) setConfirming(false);
              }}
            >
              {busy ? 'DETONATING…' : '☠ CONFIRM DETONATION'}
            </button>
            <button
              className="maneuver-btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const TradeRouteSection: React.FC<{
  ship: Ship;
  tradeRoutes: TradeRoute[];
  bodies: Body[];
  settlements: Settlement[];
  /** True when the player controls the Dyson Sphere — unlocks Sol as a
   *  route destination (the supply line that actually builds it). */
  canSupplyDyson?: boolean;
  /** Current game tick — turns a transit's arriveTick into an ETA. */
  currentTick: number;
  onCreate: (originBodyId: string, destBodyId: string) => boolean;
  onCancel: (routeId: string) => void;
  /** Dump the hold into the faction pool without cancelling the route.
   *  Absent in SP (no server to bank it) — the HOLD box then renders
   *  read-only. */
  onUnload?: () => void;
  /** Start or stop working the rock this hull is parked on. Absent in
   *  SP (no server to remember the order), which simply hides the
   *  control — same shape as onUnload above. */
  onSetMining?: (active: boolean) => void;
  /** Cargo aboard for a LOADED cross-faction delivery leg (one-shot
   *  trades live in tradeDeliveries, not the route row). Display-only:
   *  those goods are owed to the counterparty. */
  contractedCargo?: string | null;
}> = ({ ship, tradeRoutes, bodies, settlements, canSupplyDyson, currentTick, onCreate, onCancel, onUnload, onSetMining, contractedCargo }) => {
  // A ship can be on a route as a CARRIER or a GUARD, so the lookup
  // asks the crew rather than the route's single ship id
  // (src/game/routeSelectors.ts — the one owner of that question).
  const route = routeForShip(tradeRoutes, ship.id) ?? undefined;
  const [picking, setPicking] = useState(false);
  // The multi-stop composer, owned right here. It renders as a
  // fixed-position modal, so it does not need hoisting to a panel root
  // — and holding it locally is what lets the ship menu open it with
  // THIS freighter already assigned as the carrier.
  const [composing, setComposing] = useState(false);
  const mpForCompose = useMultiplayerActions();
  const { gameState: composerGameState } = useGameContext();

  // THE HOLD, as its own box on every freighter (player request) — not a
  // clause buried in the route line. It is TWO pots reading as one: the
  // ship's own cargo columns (loads that outlived a route — migration
  // 0088, cargo persists until delivered) plus the active route's
  // per-leg staging. An agreement leg's staging is shown separately as
  // "under contract": those goods are owed to the counterparty and only
  // the automatic delivery (or cancelling the deal) moves them.
  const shipHold = ship.cargo ?? { fuel: 0, ore: 0, credits: 0, science: 0 };
  // A walker route stages cargo on the CREW ROW, so read this hull's own
  // row when there is one — the route columns only ever mirror the
  // PRIMARY carrier, and a second carrier would otherwise show the
  // primary's cargo as its own.
  const myCrew = route?.ships?.find(x => x.shipId === ship.id);
  const routeOwn = route && !route.counterpartyFactionId
    ? (myCrew?.cargo ?? route.cargo)
    : { fuel: 0, ore: 0, credits: 0, science: 0 };
  const holdCargo = {
    fuel:    shipHold.fuel    + routeOwn.fuel,
    ore:     shipHold.ore     + routeOwn.ore,
    credits: shipHold.credits + routeOwn.credits,
    science: shipHold.science + routeOwn.science,
  };
  const contractedRoute = route?.counterpartyFactionId ? route.cargo : null;
  const contractedTotal = contractedRoute
    ? contractedRoute.fuel + contractedRoute.ore + contractedRoute.credits + contractedRoute.science
    : 0;
  const holdTotal = holdCargo.fuel + holdCargo.ore + holdCargo.credits + holdCargo.science;
  const holdStr = [
    holdCargo.ore     > 0 ? `${Math.round(holdCargo.ore)} metal`      : null,
    holdCargo.credits > 0 ? `${Math.round(holdCargo.credits)} credits`: null,
    holdCargo.science > 0 ? `${Math.round(holdCargo.science)} science`: null,
    holdCargo.fuel    > 0 ? `${Math.round(holdCargo.fuel)} fuel`      : null,
  ].filter(Boolean).join(' · ');
  // "Contracted" only greys the button when there is NOTHING of your
  // own aboard — your own cargo unloads fine alongside an agreement
  // leg's staging (the server splits the two pots the same way).
  const holdContracted = (contractedTotal >= 1 || !!contractedCargo) && holdTotal < 1;
  const holdInTransit = !!ship.transit;
  // Greyed with a REASON, not just greyed: empty, contracted and
  // mid-burn are three different answers to "why can't I press this".
  const unloadWhy =
    holdContracted ? 'Everything aboard is owed to your trade partner — it delivers on arrival.'
    : holdTotal < 1  ? 'The hold is empty.'
    : holdInTransit  ? 'Mid-burn — cargo transfers only in orbit.'
    : 'Deliver the hold into your resource pool now. Any route keeps running and picks up again at its origin.';
  const canUnload = !!onUnload && holdTotal >= 1 && !holdInTransit;

  // ---- MINING, for a rigged hull parked on a rock ----
  // Rendered as part of the hold group because that is what it fills,
  // and because holdBox is one const used at three render sites — a
  // separate box would have to be threaded into all three.
  const rockHere = ship.orbit?.parentBodyId
    ? bodies.find((b: Body) => b.id === ship.orbit.parentBodyId && b.mineralKind)
    : undefined;
  const hasRig = (ship.parts ?? []).includes('mining');
  const rockLeft = Math.max(0, rockHere?.mineralRemaining ?? 0);
  const serverMining = !!rockHere && ship.miningBodyId === rockHere.id;
  // The order lands on the server immediately, but this client only
  // learns about it on its next state poll — up to a whole tick later.
  // Without an optimistic flag the button does not move and the press
  // reads as "nothing happened", which is exactly how it was reported.
  // Cleared as soon as the server's view agrees.
  const [miningPending, setMiningPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (miningPending !== null && miningPending === serverMining) setMiningPending(null);
  }, [miningPending, serverMining]);
  const isMining = miningPending ?? serverMining;
  const holdRoom = Math.max(0, BASE_HOLD - holdTotal);
  // What is actually going to happen: whichever runs out first.
  const ticksToStop = Math.ceil(Math.min(holdRoom, rockLeft) / MINE_RATE_PER_TICK);
  const fillPct = Math.max(0, Math.min(1, holdTotal / BASE_HOLD));

  const miningBox = (!hasRig || !rockHere || ship.transit || !onSetMining) ? null : (
    <div className="maneuver-section">
      <div className="section-title">MINING</div>
      {isMining ? (
        <div className="order-item" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          <div className="order-details" style={{ color: '#e8f4ff' }}>
            Working {rockHere.name} — {MINE_RATE_PER_TICK}/tick
          </div>
          {/* The hold IS the progress bar: a mining run ends when this
              fills or the rock runs dry, so showing anything else would
              be a second number saying the same thing less usefully. */}
          <div className="order-details">
            {miningPending === true && holdTotal <= 0
              ? 'Order sent — the first load comes in on the next tick.'
              : null}
          </div>
          <div className="mine-bar" aria-hidden="true">
            <div className="mine-bar__fill" style={{ width: `${Math.round(fillPct * 100)}%` }} />
          </div>
          <div className="order-details">
            {Math.round(holdTotal)} / {BASE_HOLD} aboard ·{' '}
            {ticksToStop <= 0
              ? 'stopping now'
              : `${ticksToStop} tick${ticksToStop === 1 ? '' : 's'} until ${holdRoom <= rockLeft ? 'full' : 'the rock is dry'}`}
          </div>
          <button
            className="maneuver-btn"
            onClick={() => { setMiningPending(false); onSetMining(false); }}
          >
            ■ STOP MINING
          </button>
        </div>
      ) : (
        <div className="order-item" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          <div className="order-details">
            {rockLeft <= 0
              ? `${rockHere.name} is worked out.`
              : `${rockHere.name} · ${Math.round(rockLeft)} ${rockHere.mineralKind === 'gold' ? 'credits' : 'metal'} left. `
                + `Fills ${MINE_RATE_PER_TICK}/tick and cannot leave until you stop it.`}
          </div>
          <button
            className="maneuver-btn"
            disabled={rockLeft <= 0 || holdRoom <= 0}
            title={holdRoom <= 0 ? 'The hold is full — deliver it first.' : undefined}
            onClick={() => { setMiningPending(true); onSetMining(true); }}
          >
            ⛏ BEGIN MINING
          </button>
        </div>
      )}
    </div>
  );

  const holdBox = (
    <>
    {miningBox}
    <div className="maneuver-section">
      <div className="section-title">HOLD</div>
      <div className="order-item" style={{ flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
        <div className="order-details" style={holdTotal > 0 || contractedTotal > 0 || contractedCargo ? { color: '#e8f4ff' } : undefined}>
          {holdTotal > 0 ? holdStr : (contractedTotal > 0 || contractedCargo) ? null : 'Empty'}
          {(contractedTotal > 0 || contractedCargo) && (
            <div style={{ color: '#ffb84d' }}>
              {contractedRoute
                ? [
                    contractedRoute.ore     > 0 ? `${Math.round(contractedRoute.ore)} metal`       : null,
                    contractedRoute.credits > 0 ? `${Math.round(contractedRoute.credits)} credits` : null,
                    contractedRoute.science > 0 ? `${Math.round(contractedRoute.science)} science` : null,
                    contractedRoute.fuel    > 0 ? `${Math.round(contractedRoute.fuel)} fuel`       : null,
                  ].filter(Boolean).join(' · ')
                : contractedCargo}
              {' · under contract'}
            </div>
          )}
        </div>
        {holdTotal > 0 && (
          <div className="order-details" style={{ color: '#8fa3b5' }}>
            Stays aboard until delivered — automatically at a route's destination, or manually here.
          </div>
        )}
        {onUnload && (
          <button
            className="maneuver-btn"
            disabled={!canUnload}
            onClick={onUnload}
            title={unloadWhy}
            style={{
              alignSelf: 'flex-start',
              opacity: canUnload ? 1 : 0.45,
              cursor: canUnload ? 'pointer' : 'not-allowed',
            }}
          >
            ⬇ DELIVER TO POOL
          </button>
        )}
      </div>
    </div>
    </>
  );
  const [originId, setOriginId] = useState<string>('');
  const [destId, setDestId] = useState<string>('');

  // ROUTE TAXONOMY (DESIGN-terraforming): the destination decides the
  // route kind, mirroring worker/actions.js handleCreateTradeRoute —
  //   terraform  dest = a RAW world I control (station claims it)
  //   logistics  dest = a terraformed world where I live
  //   dyson      dest = Sol (controller only)
  // Terraform + dyson runs load the faction POOL, which is only "on the
  // dock" at terraformed worlds — so those origins filter accordingly.
  const settledIds = useMemo(
    () => new Set(settlements.filter(s => s.ownedBy === 'player').map(s => s.bodyId)),
    [settlements],
  );
  const originBodies = useMemo(
    () => bodies.filter(b => settledIds.has(b.id)),
    [bodies, settledIds],
  );
  const terraformedOrigins = useMemo(
    () => bodies.filter(b => settledIds.has(b.id) && !isRawWorld(b)),
    [bodies, settledIds],
  );
  // Raw worlds I control that can still take supply (window not open).
  const rawDests = useMemo(
    () => bodies.filter(b =>
      b.ownedBy === 'player'
      && isRawWorld(b)
      && b.terraformCompletesAtTick == null
      && (b.type === 'terrestrial' || b.type === 'moon' || b.type === 'dwarf'),
    ),
    [bodies],
  );
  // Terraformed worlds where I live — classic stockpile hauling.
  const logisticsDests = useMemo(
    () => bodies.filter(b => settledIds.has(b.id) && !isRawWorld(b)),
    [bodies, settledIds],
  );
  const destKind = destId === 'sol' ? 'dyson'
    : rawDests.some(b => b.id === destId) ? 'terraform'
    : 'logistics';
  const anyDest = logisticsDests.length > 0 || rawDests.length > 0 || !!canSupplyDyson;

  if (route) {
    const origin = bodies.find(b => b.id === route.originBodyId);
    const dest = bodies.find(b => b.id === route.destBodyId);
    const cargoTotal =
      route.cargo.fuel + route.cargo.ore + route.cargo.credits + route.cargo.science;
    const cargoStr = [
      route.cargo.fuel    > 0 ? `${Math.round(route.cargo.fuel)}F`    : null,
      route.cargo.ore     > 0 ? `${Math.round(route.cargo.ore)}M`     : null,
      route.cargo.credits > 0 ? `${Math.round(route.cargo.credits)}C` : null,
      route.cargo.science > 0 ? `${Math.round(route.cargo.science)}S` : null,
    ].filter(Boolean).join(' ');
    // A MINING RUN IS NOT A PICKUP, and the card was calling it one.
    // The itinerary knows: a stop with action 'mine' works a rock, which
    // is a different verb, a different rate, and — because the hull sits
    // still while it fills — a different reason for the freighter to be
    // stationary. Reading it off the stops means the label follows the
    // route the player actually built.
    const mineStops = (route.stops ?? []).filter(st => st.action === 'mine');
    const isMiningRun = mineStops.length > 0;
    const mineBodyIds = new Set(mineStops.map(st => st.bodyId));
    const kindLabel = route.kind === 'terraform' ? '◌ TERRAFORM SUPPLY'
      : route.kind === 'dyson' ? '☀ DYSON SUPPLY'
      : isMiningRun ? '⛏ MINING RUN'
      : 'TRADE ROUTE';

    // NEXT ACTION. A supply route only acts on the tick, so between ticks
    // the freighter genuinely does sit still — and with an hour a tick
    // that silence read as a broken route ("this freighter aint movin").
    // Say what it's about to do and when, so an idle hold looks like a
    // schedule instead of a fault.
    const here = ship.orbit?.parentBodyId;
    const wantsToBe = route.status === 'outbound' ? route.destBodyId : route.originBodyId;
    const wantsBody = bodies.find(b => b.id === wantsToBe);
    let nextAction: string;
    if (ship.transit) {
      const plan = ship.transit.currentTransfer;
      const to = bodies.find(b => b.id === plan.targetBodyId);
      const eta = Math.max(0, plan.arriveTick - currentTick);
      nextAction = `Under way to ${to?.name ?? 'destination'} · arrives in ${Math.round(eta)}t`;
    } else if (here === route.destBodyId && cargoTotal > 0) {
      nextAction = `Unloading at ${dest?.name ?? 'destination'} next tick`;
    } else if (here && mineBodyIds.has(here)) {
      // Parked ON the rock. This is the leg that takes several ticks and
      // cannot be interrupted, so say the rate rather than "next tick" —
      // "next tick" implies it is about to leave.
      const rock = bodies.find(b => b.id === here);
      const rockLeftHere = Math.max(0, rock?.mineralRemaining ?? 0);
      // How much is left is the fact that decides whether to keep this
      // rock on the itinerary, so it belongs on the line that says the
      // hull is working it.
      nextAction = `Working ${rock?.name ?? 'the rock'} · ${MINE_RATE_PER_TICK}/tick`
        + (rockLeftHere > 0 ? ` · ${Math.round(rockLeftHere)} left` : ' · worked out');
    } else if (here === route.originBodyId && cargoTotal < 1) {
      nextAction = isMiningRun
        ? `Starting the dig at ${origin?.name ?? 'the rock'} next tick`
        : `Loading at ${origin?.name ?? 'origin'} next tick`;
    } else {
      nextAction = `Departing for ${wantsBody?.name ?? 'the next stop'} next tick`;
    }
    return (
      <>
      {holdBox}
      <div className="maneuver-section">
        <div className="section-title">{kindLabel}</div>
        <div className="order-item status-committed" style={{ flexDirection: 'column', gap: 4 }}>
          <div className="order-info" style={{ width: '100%' }}>
            <div className="order-type">{origin?.name ?? '?'} ↔ {dest?.name ?? '?'}</div>
            <div className="order-details">
              {route.status === 'outbound' ? '→ delivering'
                : route.status === 'returning' ? (isMiningRun ? '← out to the rock' : '← picking up')
                : 'paused'}
              {/* "empty hold" sat directly under a HOLD box reading
                  "200 metal" and flatly contradicted it: this counts the
                  ROUTE's staged cargo, while the box above counts that
                  PLUS whatever the hull carries of its own (a manual
                  mining load, say). When the route has staged nothing
                  but the hull is not empty, say nothing here rather than
                  call a full hold empty. */}
              {cargoTotal > 0
                ? ` · cargo ${cargoStr}`
                : holdTotal > 0 ? ' · nothing staged yet' : ' · empty hold'}
            </div>
            {route.status !== 'paused' && (
              <div className="order-details" style={{ color: '#4ecdc4' }}>{nextAction}</div>
            )}
          </div>
          <button
            className="maneuver-btn"
            // Brightened red + opaque tinted fill so the destructive button
            // reads against the golden status-committed row background.
            // Previous (#ff5e5e on amber tint) was ~3:1 contrast — below
            // WCAG AA — and the red-on-amber created visual noise.
            style={{
              borderColor: '#ff7a7a',
              color: '#ffb0b0',
              background: 'rgba(255, 94, 94, 0.12)',
              alignSelf: 'flex-start',
              fontWeight: 600,
            }}
            onClick={() => onCancel(route.id)}
            title="Cancel the route. Any cargo in the hold is dumped to your pool."
          >
            ✕ CANCEL ROUTE
          </button>
        </div>
      </div>
      </>
    );
  }

  if (picking) {
    const canCreate = !!originId && !!destId && originId !== destId;
    return (
      <>
      {holdBox}
      <div className="maneuver-section">
        <div className="section-title">NEW TRADE ROUTE</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0' }}>
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            DESTINATION (decides the route kind)
          </label>
          {!anyDest ? (
            <div style={{ fontSize: 10, color: '#ff5e5e' }}>
              No eligible destinations — claim a raw world with a station to
              terraform it, or settle a terraformed world to haul stockpile.
            </div>
          ) : (
            <select
              value={destId}
              onChange={(e) => {
                const next = e.target.value;
                setDestId(next);
                // Changing the destination can change the route KIND, and
                // with it which origins are legal — a logistics origin can
                // be a raw world, which a terraform/dyson run can't load
                // at. Clear a now-illegal pick instead of letting the
                // server 409 it at OPEN ROUTE.
                const nextKind = next === 'sol' ? 'dyson'
                  : rawDests.some(b => b.id === next) ? 'terraform'
                  : 'logistics';
                if (nextKind !== 'logistics' && originId
                    && !terraformedOrigins.some(b => b.id === originId)) {
                  setOriginId('');
                }
              }}
              style={{
                padding: '4px 6px', background: '#0a1018', border: '1px solid #2a3d50',
                color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, borderRadius: 3,
              }}
            >
              <option value="">— pick destination —</option>
              {rawDests.length > 0 && (
                <optgroup label="TERRAFORM — raw worlds you control">
                  {rawDests.map(b => (
                    <option key={b.id} value={b.id}>
                      ◌ {b.name} ({Math.round(b.terraformAcc?.metal ?? 0)}M · {Math.round(b.terraformAcc?.credits ?? 0)}C delivered)
                    </option>
                  ))}
                </optgroup>
              )}
              {logisticsDests.length > 0 && (
                <optgroup label="LOGISTICS — your terraformed worlds">
                  {logisticsDests.map(b => (
                    <option key={b.id} value={b.id}>● {b.name}</option>
                  ))}
                </optgroup>
              )}
              {canSupplyDyson && (
                <optgroup label="MEGAPROJECT">
                  <option value="sol">☀ Dyson Sphere (Sol)</option>
                </optgroup>
              )}
            </select>
          )}
          {destKind === 'terraform' && destId && (
            <div style={{ fontSize: 10, color: '#8aa0b4', lineHeight: 1.5 }}>
              Terraform supply loads metal + credits from your POOL at a
              terraformed world and delivers them into this world's terraform
              meter. When the payload lands, the transformation begins.
            </div>
          )}
          {destKind === 'dyson' && destId && (
            <div style={{ fontSize: 10, color: '#8aa0b4', lineHeight: 1.5 }}>
              Dyson supply loads metal, credits and science from your POOL at
              a terraformed world, then hauls it to the sphere. The freighter
              can be raided the whole way.
            </div>
          )}
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            ORIGIN {destKind === 'logistics' ? '(any settlement of yours)' : '(terraformed world — pool loading dock)'}
          </label>
          <select
            value={originId}
            onChange={(e) => setOriginId(e.target.value)}
            style={{
              padding: '4px 6px', background: '#0a1018', border: '1px solid #2a3d50',
              color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, borderRadius: 3,
            }}
          >
            <option value="">— pick origin —</option>
            {(destKind === 'logistics' ? originBodies : terraformedOrigins).map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              className="maneuver-btn"
              onClick={() => {
                if (!canCreate) return;
                if (onCreate(originId, destId)) {
                  setPicking(false); setOriginId(''); setDestId('');
                }
              }}
              disabled={!canCreate}
              style={!canCreate ? { opacity: 0.5, cursor: 'default' } : undefined}
            >
              ▶ OPEN ROUTE
            </button>
            <button
              className="maneuver-btn"
              onClick={() => { setPicking(false); setOriginId(''); setDestId(''); }}
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
      </>
    );
  }

  return (
    <>
    {holdBox}
    <div className="maneuver-section">
      <div className="section-title">TRADE ROUTE</div>
      <button
        className="maneuver-btn"
        onClick={() => setPicking(true)}
        style={{ marginTop: 4 }}
        title="Open a recurring route — auto-pilots this freighter to haul stockpile home, feed a terraform meter, or supply the Dyson Sphere."
        disabled={!anyDest}
      >
        + TRADE ROUTE
      </button>
      {/* THE FAST PATH STAYS FAST (DESIGN-trade-v2 §10). Picking an
          origin and a destination above is still two clicks and still
          the way most routes get laid — it just writes a two-stop route
          underneath now, which is what lets the same route grow stops
          later. The powerful path sits one line below it rather than
          somewhere else in the interface. */}
      {mpForCompose && (
        <button
          className="maneuver-btn"
          onClick={() => setComposing(true)}
          style={{ marginTop: 4 }}
          title="Build a run with several stops — collect from a few outposts, then drop it all at one dock."
          disabled={!anyDest}
        >
          + MULTI-STOP RUN
        </button>
      )}
      {composing && (
        <RouteComposer
          gameState={composerGameState}
          initialCarrierId={ship.id}
          initialStops={[]}
          onClose={() => setComposing(false)}
        />
      )}
      {!anyDest && (
        <div style={{ fontSize: 9, color: '#b8c8d6', marginTop: 4 }}>
          Claim a raw world with a station, or settle a terraformed one.
        </div>
      )}
    </div>
    </>
  );
};
