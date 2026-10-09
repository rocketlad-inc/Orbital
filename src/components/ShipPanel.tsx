import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { NON_WORLD_TYPES } from '../game/victory';
import { useGameContext } from '../state/gameContext';
import { Ship, Body, Settlement, TradeRoute, TargetPriorityKey, CameraState } from '../types';
import { TargetPriorityCards, autoTargetOrderFor } from './TargetPriorityCards';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import { deriveSecondary } from '../game/colorUtils';
import { maintenanceRatesForShip, REPAIR_PER_TICK_PER_TENDER_BAY } from '../game/maintenance';
import { nearestRefitBodyId, preferredYardBodyId, isDamagedShip } from '../game/repair';
import { effectiveShipMaxHp, shipWorldPosition, attackerDamageFactors } from '../game/combat';
import { orbitWorldPos } from '../physics/orbitalMechanics';
import { predictTarget, enemyFlakOn, SETTLEMENT_COMBAT_SPEED } from '../game/targeting';
import { traitSummary, traitBrief, rankTierLabel, rerollAvatarId } from '../game/captains';
import { CaptainAvatar } from './CaptainAvatar';
import { summarizeFleet, fleetHeadlineStatus } from '../game/fleetSummary';
import {
  ShipPartId, SHIP_PART_DEFS, countPart, detonatorDamage, detonatorDisclosure,
  PART_GLYPH, SHIP_SLOT_COUNTS, ALL_PART_IDS, sanitizeParts,
  hitChanceOf, damageProfile, defenseMitigation, MITIGATION_FLOOR, refitFee,
} from '../game/shipParts';
import { TransferIntent, MpActionResult, useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { MINE_RATE_PER_TICK, BASE_HOLD } from '../game/mining';
import { RouteComposer } from '../multiplayer/RouteComposer';
import { apiFetch } from '../multiplayer/api';
import { ShipActivityLog } from './ShipActivityLog';
import { shipOrdersIntent } from '../game/shipOrdersIntent';
import { committedNodeIdFor, markNodeCancelPending, unmarkNodeCancelPending } from '../multiplayer/pendingNodeCancels';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { combatSpeedOf } from '../game/shipParts';
import { refitStatus } from '../game/refitStatus';
import { retrofitChoices, retrofitOptions, defaultRetrofitPick } from '../game/designChoice';
import { useIsMobile } from '../hooks/useIsMobile';
import { EditableName } from './EditableName';
import { iconClassFor, ShipIcon } from './ShipIcons';
import { HullIcon } from './StructureIcons';
import { launchFromPlan } from '../physics/torchTransfer';
import { solveLockstepThrottle } from '../physics/lockstep';
import { planExploreTour, type ExploreScope } from '../game/autoExplore';
import { canHostCity, canHostStation, isRawWorld, suggestSettlementName } from '../game/settlements';
import { useFeatureGate } from '../hooks/useFeatureGate';
import {
  BINARY_SYSTEM_BODY_IDS,
  BLACK_HOLE_SYSTEM_BODY_IDS,
} from '../state/mockGameState';
import { isSunGateSite, isGateInFlight } from '../game/farSystems';
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
import { requirementLabel } from '../game/researchUnlocks';
import { MegastructurePicker, MegastructureModuleHint } from '../multiplayer/MegastructureCard';
import { beginPlacement } from '../game/megastructurePlacement';
import { MEGA_STRIKE_CHARGE_TICKS, MEGASTRUCTURES } from '../game/megastructures';
import { isCapitalHull } from '../render/megastructureArt';
import { BuildPanel } from './BuildPanel';
import { fleetPath } from '../multiplayer/fleetWire';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { createPortal } from 'react-dom';
import { InterceptPicker, STANDING_RING, type PickerEntry } from './InterceptPicker';
import { solveIntercepts, courseBox, type InterceptOption } from '../game/interceptOptions';
import { interceptPickerEntries } from './interceptEntries';
import { framingCamera, freeMapArea } from '../game/interceptPicker';
import { getCamera } from '../state/cameraStore';
import { planHullIntercept } from '../multiplayer/interceptCommit';
import { useInterceptOverlay } from './useInterceptOverlay';

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

type ShipPanelTab = 'fleet' | 'orders' | 'yard' | 'ship' | 'cargo' | 'log';

/** Tab order, left to right. Reads as a sentence about the hull: what it's
 *  doing, what it is, what it's carrying, what it's done. */
const SHIP_TABS: Array<{ key: ShipPanelTab }> = [
  // FLEET exists only for a hull in a fleet, and sits first because for
  // one it is the card the panel opens on — see the default below.
  { key: 'fleet' },
  { key: 'orders' },
  // YARD is the Mobile Foundry's whole reason to exist, and it lived on
  // the BODY's menu — so the one hull in the game that IS a shipyard had
  // no way to build anything from its own panel. Sits second because on
  // a foundry it is the thing you opened the panel for.
  { key: 'yard' },
  { key: 'ship' },
  { key: 'cargo' },
  { key: 'log' },
];

export const ShipPanel: React.FC = () => {
  const { lang: uiLang } = useI18n();
  const {
    gameState, uiState, deselectShip, setGameState,
    deleteManeuverNode, setTargetSelectionMode,
    launchTorchTransfer, enqueueTorchTransfer, enqueueIntercept, queueTorchTour, planLegFor,
    planTorchPreview, cancelTorchPreview, previewRendezvous,
    recallLaunch,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    createTradeRoute, cancelTradeRoute, renameShip,
    focusBody, updateCamera, setShipSelection, selectShip,
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
  // Defaults to 'orders' — EXCEPT for a hull in a fleet, which opens on
  // FLEET. This used to be 'orders' always, on the principle that muscle
  // memory beats cleverness. Lorne asked for the fleet card to "supersede
  // when a fleet forms": selecting any member of a fleet is asking about
  // the fleet, and the one-hull card answered a question nobody had. The
  // rule stays one line long — fleet member, FLEET; anything else,
  // ORDERS — so it is still learnable. See the effect below the ship
  // lookup.
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
      if (tab === 'fleet' || tab === 'orders' || tab === 'ship' || tab === 'cargo' || tab === 'log') {
        setShipTab(tab);
      }
    };
    window.addEventListener('orbital:ship-panel-tab', onTab);
    return () => window.removeEventListener('orbital:ship-panel-tab', onTab);
  }, []);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [fleetModalOpen, setFleetModalOpen] = useState(false);

  // Server-side transfer rejection — shown inline above the COMMIT
  // button when MP rejects the burn (e.g. ship was captured between
  // plan and commit). Without this the TRANSFER / COMMIT click looks
  // like it worked but the next /state poll silently rewinds the
  // optimistic local state.
  const [transferError, setTransferError] = useState<string | null>(null);
  /** Information about a plan, not a failure ("flying in formation…").
   *  It went through transferError and wore the red ⚠ error box (QA). */
  const [transferNote, setTransferNote] = useState<string | null>(null);
  // Recall-in-flight guard. Declared with the other hooks (this component
  // has early returns further down, so it cannot live beside its usage).
  const [recalling, setRecalling] = useState(false);
  /** In-flight guard for the settle-on-arrival controls. */
  const [settleBusy, setSettleBusy] = useState(false);
  // Live gameState for the optimistic toggle below: a /state poll almost
  // certainly lands while the PATCH is in flight, and rolling back
  // through the closed-over snapshot would resurrect ships the server
  // has since moved.
  const gsRef = React.useRef(gameState);
  React.useEffect(() => { gsRef.current = gameState; }, [gameState]);
  // Auto-explore (corvettes): how far the survey ranges, and the
  // result line after one is dispatched.
  const [exploreScope, setExploreScope] = useState<ExploreScope>('system');
  // Which in-flight ship the RENDEZVOUS picker is aimed at.
  const [rendezvousId, setRendezvousId] = useState<string | null>(null);
  const [rendezvousBusy, setRendezvousBusy] = useState(false);
  const [rendezvousOpen, setRendezvousOpen] = useState(false);
  // THE INTERCEPT PICKER (InterceptPicker): a pop-out beside the panel on
  // desktop, a page of the sheet on a phone. Picking a target no longer
  // throws the camera out to the whole system; SHOW does that on request
  // and BACK TO SHIP puts the camera back exactly where it was.
  const [rvShowing, setRvShowing] = useState(false);
  const rvCamBefore = useRef<CameraState | null>(null);
  // Phone: after a pick the sheet drops to a peek so the course shows.
  const [rvPeek, setRvPeek] = useState(false);
  // A MEET pick stages the plain leg to their door as the ship's planned
  // move, so the map draws it; remembered so closing the picker clears
  // only what the picker staged.
  const rvStagedMoveFor = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rvPopAt, setRvPopAt] = useState<{ left: number; top: number } | null>(null);
  // FLEET tab member list: capped until asked. Every row is an icon, a
  // bar and three labels rebuilt on each /state poll, and an uncapped
  // 147-row list is the exact shape that made a megafleet crawl.
  const [fleetListAll, setFleetListAll] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  const [chainInterceptOpen, setChainInterceptOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [refitBusy, setRefitBusy] = useState(false);
  // The design picked in the RETROFIT dropdown, remembered per hull so
  // selecting another ship does not carry the pick across.
  const [refitPick, setRefitPick] = useState<{ shipId: string; designId: string } | null>(null);
  const [exploreNotice, setExploreNotice] = useState<string | null>(null);
  // Colony ship "deploy settlement" — inline result/rejection line.
  const [deployNotice, setDeployNotice] = useState<string | null>(null);
  // Captain assign/bench used to fire and forget, so a server refusal —
  // now including "this hull is in combat" — was invisible from here: the
  // click just did nothing.
  const [captainNotice, setCaptainNotice] = useState<string | null>(null);
  const [deployBusy, setDeployBusy] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
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

  // OPEN ON FLEET for a fleet member. Keyed on the selection AND on
  // membership, so a fleet forming around the ship you are looking at
  // brings its card up too — "supersedes when a fleet forms". Not on any
  // other change: switching to ORDERS by hand sticks until you select a
  // different ship. A detached hull is on its own errand, so it opens as
  // a ship.
  const selectedInFleet = !!ship?.fleetId && !ship.fleetDetached;
  useEffect(() => {
    if (selectedInFleet) setShipTab('fleet');
  }, [uiState.selectedShipId, selectedInFleet]);

  /**
   * Set (or clear) "found a station when you get there".
   *
   * ONE writer for two controls: the ON ARRIVAL toggle in ORDERS and the
   * line in the chain tape are the same order, and two copies of an
   * optimistic write plus its rollback is two chances to disagree about
   * what the ship is doing.
   */
  const setSettleOrder = useCallback(async (want: 'station' | null) => {
    if (!ship || !mpActions) return;
    const before = ship.deployOnArrival ?? null;
    if (before === want) return;
    setSettleBusy(true);
    const write = (v: 'station' | null) => setGameState({
      ...gsRef.current,
      ships: gsRef.current.ships.map(sh =>
        (sh.id === ship.id ? { ...sh, deployOnArrival: v } : sh)),
    });
    write(want);
    const res = await mpActions.setDeployOnArrival(ship.id, want);
    setSettleBusy(false);
    // A control that stays set after a refusal is a promise nothing kept.
    if (!res.ok) { write(before); setTransferError(humanizeMpError(res.code, res.error, 'transfer')); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ship, mpActions, setGameState]);

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
    void uiLang;   // labels are translated here: recompute when the language flips
    if (!ship) return [] as Array<{
      key: string; kind: 'goto' | 'wait'; dest: string; label: string; meta: string;
      // Which queued leg this row IS, so the row can delete itself.
      // null = the live burn (committed, cannot be re-aimed) or the
      // staged primary, which is cleared rather than de-queued.
      committed: boolean; waitBefore: number; intercepts: string | null;
      queueIndex: number | null;
    }>;
    const now = gameState.currentTick;
    const shipNameOf = (id: string | undefined | null) =>
      (id ? gameState.ships.find(sh => sh.id === id)?.name : null) ?? null;
    const nameOf = (id: string | undefined | null) =>
      (id ? gameState.bodies.find(b => b.id === id)?.name : null) ?? t('ship.panel.unknownLower');
    const eta = (arrive: number | undefined) =>
      arrive == null ? '' : t('ship.panel.arrives', { tick: Math.round(arrive), n: Math.max(0, Math.round(arrive - now)) });

    const out: Array<{
      key: string; kind: 'goto' | 'wait'; dest: string; label: string; meta: string;
      // Which queued leg this row IS, so the row can delete itself.
      // null = the live burn (committed, cannot be re-aimed) or the
      // staged primary, which is cleared rather than de-queued.
      committed: boolean; waitBefore: number; intercepts: string | null;
      queueIndex: number | null;
    }> = [];

    // A WAIT IS NOT STORED. It is the GAP between when the previous leg
    // parks the ship and when the next burn fires -- which the plans
    // already carry as arriveTick and startTick. Deriving it means a
    // program reloaded from the server shows its waits without the
    // server ever having to know the word "wait", and means the drawn
    // gap and the written gap cannot disagree.
    let readyAt = now;
    // The wait BELONGS TO the leg it precedes, so it renders on that
    // leg's row: "wait 6t, then Pluto". A row of its own made the tape
    // twice as long to say one thing, and numbered dead time as if it
    // were a destination.
    const waitFor = (departAt: number) => Math.max(0, Math.round(departAt - readyAt));

    const live = ship.transit?.currentTransfer;
    if (live) {
      const d = nameOf(live.targetBodyId);
      out.push({ key: 'live', kind: 'goto', dest: d, label: t('ship.panel.goTo', { name: d }), meta: eta(live.arriveTick), committed: true, waitBefore: 0, intercepts: shipNameOf(live.rv?.followShipId), queueIndex: null });
      readyAt = live.arriveTick;
    } else if (ship.plannedTransit) {
      const d = nameOf(ship.plannedTransit.targetBodyId);
      const w = waitFor(ship.plannedTransit.startTick);
      // Staged, not committed: say so, because this one CAN still be changed
      // and the committed one cannot. That difference is the whole rule.
      out.push({ key: 'planned', kind: 'goto', dest: d, label: t('ship.panel.goTo', { name: d }), meta: t('ship.panel.staged'), committed: false, waitBefore: w, intercepts: shipNameOf(ship.plannedTransit.rv?.followShipId), queueIndex: null });
      readyAt = ship.plannedTransit.arriveTick;
    }
    for (const [i, q] of (ship.queuedTransits ?? []).entries()) {
      const d = nameOf(q.targetBodyId);
      const w = waitFor(q.startTick);
      out.push({
        key: `q${i}`, kind: 'goto', dest: d, label: t('ship.panel.goTo', { name: d }),
        meta: t('ship.panel.departs', { tick: Math.round(q.startTick) }), committed: false, waitBefore: w,
        queueIndex: i,
        intercepts: shipNameOf(q.rv?.followShipId),
      });
      readyAt = q.arriveTick;
    }
    return out;
  }, [ship, gameState.bodies, gameState.ships, gameState.currentTick, uiLang]);

  /**
   * WHO THIS SHIP COULD STILL CATCH, solved from the END of its chain.
   *
   * Different question from the RENDEZVOUS list above, which asks it
   * of a parked hull right now. Here the ship may already have legs,
   * so the honest window runs from when it comes FREE to when the
   * target parks -- and a target that lands first is simply not
   * offered, because its future after parking is not known and the
   * step would be a plain go-to wearing an intercept's name.
   *
   * Gated on the section being open for the same reason the other list
   * is: this is the most expensive thing the panel computes.
   */
  const chainInterceptCandidates = useMemo(() => {
    type Cand = {
      id: string; name: string; meetIn: number; dest: string;
      shipClass: Ship['class']; iconVariant: Ship['iconVariant'];
      ownerName: string; c1: string; c2: string; mine: boolean;
    };
    void uiLang;   // owner fallback below is translated: recompute on a language flip
    if (!chainInterceptOpen || !ship) return [] as Cand[];
    const unknownLabel = t('ship.panel.unknown');
    const now = gameState.currentTick;
    const queue = ship.queuedTransits ?? [];
    const prior = queue.length > 0
      ? queue[queue.length - 1]
      : (ship.transit?.currentTransfer ?? ship.plannedTransit ?? null);
    const freeAt = prior ? prior.arriveTick : now;
    return gameState.ships
      .filter(t => t.id !== ship.id && (t.hp ?? 1) > 0 && !!t.transit?.currentTransfer?.targetBodyId)
      .map(t => {
        const tr = t.transit!.currentTransfer;
        if (!(tr.arriveTick > freeAt)) return null;   // parks before we are free
        // Solving twice (once to list, once to append) would be two
        // derivations of one trajectory. So the list reports only what
        // it can cheaply KNOW -- that a window exists, how long it is,
        // and whose hull it is -- and the append does the single real
        // solve.
        const owner = gameState.factions.find(f => f.id === t.ownedBy);
        const c1 = owner?.color ?? '#8b6fd0';
        return {
          id: t.id,
          name: t.name,
          meetIn: Math.max(0, Math.round(tr.arriveTick - now)),
          dest: gameState.bodies.find(b => b.id === tr.targetBodyId)?.name ?? '?',
          shipClass: t.class,
          iconVariant: t.iconVariant,
          ownerName: owner?.name ?? unknownLabel,
          c1,
          c2: owner?.color2 || deriveSecondary(c1),
          mine: t.ownedBy === 'player',
        };
      })
      .filter((x): x is Cand => !!x)
      // NO CAP. It scrolls now, and a silently truncated list of who
      // you could catch reads as "that is everyone" when it is not.
      .sort((a, b) => a.meetIn - b.meetIn);
  }, [chainInterceptOpen, ship, gameState.ships, gameState.factions, gameState.bodies, gameState.currentTick, uiLang]);

  // A staged rendezvous belongs to the ship whose panel raised it. Drop
  // it when the panel moves to another hull or closes, or the arc hangs
  // on the map describing a plan nobody is looking at any more.
  const rvShipId = ship?.id ?? null;
  useEffect(() => {
    // The picker is a pop-out now, not a list folded into ORDERS: one
    // left open must not spring open again on the next hull selected
    // (the panel stays mounted between selections, and so did this).
    setRendezvousOpen(false);
    setRendezvousId(null);
    setRvPeek(false);
    // THE ERROR BELONGED TO THE LAST HULL. transferError is written by
    // the move/intercept flows and was never cleared when the panel
    // moved on, so "No matched intercept of Parana exists from here"
    // sat on a different ship's ORDERS tab long after that plan was
    // gone — reported as the game still acting on a removed order.
    setTransferError(null);
    setTransferNote(null);
    setRvShowing(false);
    rvCamBefore.current = null;
    if (!rvShipId) return undefined;
    return () => {
      previewRendezvous(rvShipId, null);
      // A meeting-at-the-door preview the picker staged as this hull's
      // planned move goes with it.
      if (rvStagedMoveFor.current === rvShipId) {
        cancelTorchPreview(rvShipId);
        rvStagedMoveFor.current = null;
      }
    };
  }, [rvShipId, previewRendezvous, cancelTorchPreview]);

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

  // ONE ANSWER PER GROUP IN FLIGHT (game/interceptOptions.ts): a fleet,
  // or loose hulls of one empire bound for one world on one tick, solved
  // once from its lead. The rule is unchanged — a true rendezvous before
  // they land, or reaching their door no later than they do — but groups
  // you can't catch are kept, with the reason, for the picker's "can't
  // reach" view instead of silently vanishing.
  const interceptOptions = useMemo((): InterceptOption[] => {
    // Closed is the default, and the solve is the most expensive thing
    // this panel does — so do not do it until asked.
    if (!rendezvousOpen) return [];
    if (!ship || ship.transit) return [];
    // Your own fleet flies with you; it is not something to intercept.
    const crew = ship.fleetId
      ? new Set(gameState.ships.filter(s => s.fleetId === ship.fleetId).map(s => s.id))
      : undefined;
    return solveIntercepts(ship, gameState, planLegFor, crew);
  // planLegFor is stable; bodies only matter through the plans. And
  // gameState.ships is read inside but deliberately NOT a dep:
  // flightSignature is its meaningful projection, and depending on the
  // array itself is the ~450ms-per-click bug this replaces.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendezvousOpen, ship?.id, ship?.transit, flightSignature, gameState.currentTick, gameState.bodies]);

  // What the picker shows for each group (components/interceptEntries).
  const interceptEntries = useMemo((): PickerEntry[] => {
    if (!ship || !ship.orbit || interceptOptions.length === 0) return [];
    return interceptPickerEntries(interceptOptions, gameState, orbitWorldPos(ship.orbit, gameState.currentTick, gameState.bodies));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interceptOptions, uiLang]);

  // Dock the desktop pop-out beside the panel, and keep it there.
  useLayoutEffect(() => {
    if (!rendezvousOpen || isMobile) { setRvPopAt(null); return undefined; }
    const place = () => {
      const r = panelRef.current?.getBoundingClientRect();
      if (r) setRvPopAt({ left: Math.round(r.right + 8), top: Math.round(r.top) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [rendezvousOpen, isMobile, shipTab, ship?.id]);

  // The map's half of the picker: rings on what this hull can catch, the
  // meeting at the door, and the veil while SHOW has the camera.
  useInterceptOverlay(
    'ship-panel',
    rendezvousOpen && !!ship && ship.ownedBy === 'player' && !ship.transit && !!mpActions,
    interceptOptions,
    rendezvousId,
    rvShowing,
    ship?.orbit ? orbitWorldPos(ship.orbit, gameState.currentTick, gameState.bodies) : null,
    gameState.bodies,
    uiLang,
  );

  const transferHandlerRef = useRef<(bodyId: string, waitTicks?: number) => void>(() => {});

  useEffect(() => {
    if (!ship) return;

    transferHandlerRef.current = (targetBodyId: string, waitTicks = 0) => {
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
        // FLEET-WIDE. enqueueTorchTransfer is eager now, so looping it
        // actually returns a plan per hull instead of one plan and a
        // row of nulls. Each mate chains off ITS OWN last leg, so a
        // fleet whose hulls are at different points in their routes
        // still each get a coherent next leg.
        setTransferError(null);
        const crew = orderedHulls();
        let queuedPlan: ReturnType<typeof enqueueTorchTransfer> = null;
        const appends: TransferIntent[] = [];
        for (const m of crew) {
          const p = enqueueTorchTransfer(m.id, targetBodyId, waitTicks);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- queuedPlan — assigned for a use not written yet
          if (m.id === ship.id) queuedPlan = p;
          // Only a hull already under way has a route the server knows
          // about; the rest are staged locally until COMMIT.
          if (p && m.transit) {
            appends.push({
              shipId: m.id,
              targetBodyId,
              scheduledT: p.startTick,
              arrivalT: p.arriveTick,
              launch: launchFromPlan(p),
              dvPrograde: p.totalDv,
              fuelCost: Math.round(p.totalDv * 10),
            });
          }
        }
        // One request for the whole fleet's next leg.
        if (mpActions && appends.length > 0) {
          void mpActions.transferMany(appends).then(results => {
            const bad = results.find((r): r is Extract<MpActionResult, { ok: false }> => !r.ok);
            if (bad) setTransferError(humanizeMpError(bad.code, bad.error, 'transfer'));
          });
        }
        // The per-hull loop above already posted for every mate under
        // way. It used to post only for this one ship, right here; the
        // rule it encoded still holds and now lives in the loop: post
        // ONLY when chaining onto a live in-flight burn, because the
        // server already knows about that leg. Chaining onto a
        // still-uncommitted plannedTransit must wait for COMMIT, or the
        // server treats the chained leg as primary and the next /state
        // poll wipes the local preview.
        setTransferModalOpen(false);
        setTargetSelectionMode(false);
        return;
      }

      // Parked ship: stage a torch preview (NOT committed). Player
      // clicks COMMIT to promote it to a live burn (commitTransferLocal).
      const plan = planTorchPreview(ship.id, targetBodyId, waitTicks);
      if (!plan) {
        // Used to be a console.warn and a bare return — the player
        // clicked a destination and got NOTHING: no arc, no error, no
        // rule they could infer. Whatever the cause (no engine accel,
        // body gone from the list, already there), say so on the panel.
        console.warn('[transfer] planTorchPreview returned null', {
          shipId: ship.id, target: targetBodyId,
        });
        const targetName = gameState.bodies.find(bd => bd.id === targetBodyId)?.name
          ?? t('ship.panel.thatDestination');
        setTransferError(
          t('ship.panel.noCourse', { name: targetName }),
        );
        setTransferModalOpen(false);
        setTargetSelectionMode(false);
        return;
      }

      // FLEET MOVE, IN LOCKSTEP.
      //
      // Every hull plans from its own orbit — a shared destination, not
      // a shared trajectory — and then the fast ones are DELAYED so the
      // whole formation lands on one tick. Hulls differ by fitted
      // engine parts, so a five-ship fleet sent to one world used to
      // arrive smeared over several ticks: the fast ships alone, first,
      // and beaten in detail. That is the opposite of the reason to
      // have a fleet.
      //
      // The fast ships wait rather than the slow ones hurrying, because
      // there is no way to beat your own burn — and waiting keeps the
      // formation together at the origin, where it is defended, instead
      // of strung out across the gap.
      if (ship.fleetId) {
        const crew = orderedHulls().filter(m => !m.transit);
        if (crew.length > 1) {
          const muls = solveLockstepThrottle(
            crew.map(m => m.id),
            // DRY RUN. Same code path the commit uses, so the probe and
            // the answer cannot disagree.
            // The player's own DEPART delay rides along untouched:
            // "leave in 6 ticks" is an order, and the formation matches
            // pace on top of it rather than instead of it.
            (id, mul) => planTorchPreview(id, targetBodyId, waitTicks, false, mul)?.arriveTick ?? null,
            gameState.currentTick + Math.max(0, Math.round(waitTicks)),
          );
          const staged: number[] = [];
          let throttled = 0;
          for (const m of crew) {
            const mul = muls.get(m.id);
            if (mul == null) continue;    // this hull cannot fly the leg
            const p = planTorchPreview(m.id, targetBodyId, waitTicks, true, mul);
            if (p) { staged.push(p.arriveTick); if (mul < 0.999) throttled += 1; }
          }
          // SAY WHAT IT COST. Holding the fast half of a squadron for a
          // dozen ticks is a real decision, and one the player would
          // otherwise only discover by watching nothing happen. Silent
          // when the fleet was already together — no credit for a delay
          // that was not needed.
          setTransferNote(null);
          if (staged.length > 1 && throttled > 0) {
            setTransferNote(
              tn('ship.panel.formation', throttled, { total: staged.length, tick: Math.ceil(Math.max(...staged)) }),
            );
          }
        } else {
          for (const m of crew) {
            if (m.id !== ship.id) planTorchPreview(m.id, targetBodyId);
          }
        }
      }

      setTransferModalOpen(false);
      setTargetSelectionMode(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- orderedHulls — adding it would re-run the effect on every reorder
  }, [
    ship, gameState, planTorchPreview, enqueueTorchTransfer,
    setTargetSelectionMode, mpActions,
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

  // A map pick the map itself refused (MapCanvas): today only a sun gate
  // still flying out of the Sun. Said in the transfer error box; the pick
  // stays open so the player can choose another target.
  useEffect(() => {
    const onRefused = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.reason === 'gate_in_flight') {
        setTransferNote(null);
        setTransferError(t('mp.err.gateInFlightClick', { tick: d.landsAt }));
      }
    };
    window.addEventListener('orbital-transfer-refused', onRefused);
    return () => window.removeEventListener('orbital-transfer-refused', onRefused);
  }, []);

  // GroupSelectionPanel takes the ship-card slot when 2+ live hulls are
  // selected — the group is what you're commanding, and showing whichever
  // single ship you last clicked contradicted the action bar. Same live
  // resolution both sides, so the slot can never end up empty.
  if (groupOwnsSlot) return null;
  if (!ship) return null;

  /** The hulls an order from this panel commands: the fleet if there is
   *  one, otherwise just this ship. A fleet is one order set, so every
   *  movement verb has to use this rather than ship.id — that is the
   *  gap that left chained legs and intercepts single-hull. */
  const orderedHulls = (): typeof gameState.ships => {
    if (!ship.fleetId) return [ship];
    // A DETACHED hull is on its own errand: it neither receives the
    // squadron's orders nor drags the squadron along with its own.
    if (ship.fleetDetached) return [ship];
    const mates = gameState.ships.filter(s => s.fleetId === ship.fleetId && !s.fleetDetached);
    return mates.length > 0 ? mates : [ship];
  };

  const handleTransferManeuver = (targetBodyId: string, waitTicks = 0) => {
    transferHandlerRef.current(targetBodyId, waitTicks);
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
  const commitTransferLocal = (owningShip: typeof ship): TransferIntent[] => {
    // The planned preview holds the target body. Promote via
    // launchTorchTransfer (the context method clears plannedTransit
    // and sets ship.transit atomically).
    const preview = owningShip.plannedTransit;
    if (!preview) {
      console.warn('[transfer] commitTransferLocal: no plannedTransit on ship', owningShip.id);
      return [];
    }
    // The staged preview may carry a LEADING WAIT. Re-derive it from the
    // plan rather than reading a second piece of state: the gap between
    // now and the planned departure IS the wait, so the two cannot
    // disagree, and it survives any re-render.
    const leadWait = Math.max(0, Math.round(preview.startTick - gameState.currentTick));
    const plan = launchTorchTransfer(owningShip.id, preview.targetBodyId, leadWait);
    if (!plan) {
      console.warn('[transfer] launchTorchTransfer rejected', { shipId: owningShip.id, target: preview.targetBodyId });
      return [];
    }
    // Snapshot the queue BEFORE we post — launchTorchTransfer didn't
    // touch queuedTransits, but each one needs to land on the server
    // too so the alarm fires the chained burn at the right tick. Each
    // q.startTick is already chained from the previous leg's arriveTick
    // (set at enqueue time in gameContext), so we can post each leg
    // verbatim and the server's alarm scheduler does the right thing.
    const queuedAtCommit = owningShip.queuedTransits ?? [];

    // The torch-derived arrival goes to the server so its DB row, the
    // alarm's in_transit→arrive transition, and the other clients' MP
    // reconstruction all agree exactly. The primary leg REPLACES the
    // ship's current route (cancels any prior committed/in-transit legs
    // server-side) and must land before the chained legs, or a queued
    // leg could race ahead of the replace and be cancelled with the old
    // route. The intents are returned in that order and posted as ONE
    // batch, which the server applies in order.
    const intents: TransferIntent[] = [{
      shipId: owningShip.id,
      targetBodyId: preview.targetBodyId,
      scheduledT: plan.startTick,
      // A true match arrives when THEY do -- flying together means
      // sharing their arrival, or the pair splits on touchdown.
      arrivalT: preview.rv ? preview.arriveTick : plan.arriveTick,
      launch: launchFromPlan(plan),
      // dvPrograde is a Δv magnitude on the server; the maneuver-node
      // display reconstructs `deltav = sqrt(prograde²+normal²+radial²)`
      // and we want it to read the full burn cost, not half of it.
      dvPrograde: plan.totalDv,
      fuelCost: Math.round(plan.totalDv * 10),
      replace: true,
      // An INTERCEPT leg carries its two burns. launchTorchTransfer
      // re-plans a plain course, so the rv rides from the STAGED
      // preview -- re-solving here would be a second derivation of a
      // trajectory, which is the failure this design exists to avoid.
      ...(preview.rv ? {
        rendezvous: {
          ax: preview.rv.A.x, ay: preview.rv.A.y,
          bx: preview.rv.B.x, by: preview.rv.B.y,
          meetTick: preview.rv.meetTick,
          followShipId: preview.rv.followShipId,
        },
      } : {}),
    }];
    // Each queued leg was chained off plannedTransit's arriveTick at
    // enqueue time, so its scheduledT lines up with when the previous
    // leg parks the ship. replace:false → append.
    for (const q of queuedAtCommit) {
      intents.push({
        shipId: owningShip.id,
        targetBodyId: q.targetBodyId,
        scheduledT: q.startTick,
        arrivalT: q.arriveTick,
        launch: launchFromPlan(q),
        dvPrograde: q.totalDv,
        fuelCost: Math.round(q.totalDv * 10),
        replace: false,
        ...(q.rv ? {
          rendezvous: {
            ax: q.rv.A.x, ay: q.rv.A.y,
            bx: q.rv.B.x, by: q.rv.B.y,
            meetTick: q.rv.meetTick,
            followShipId: q.rv.followShipId,
          },
        } : {}),
      });
    }
    return intents;
  };

  const isOwn = ship.ownedBy === 'player';

  // ---- INTERCEPT PICKER ---------------------------------------------------
  // Open only for your own parked hull (a committed burn cannot be re-aimed).
  const rvOpenNow = rendezvousOpen && isOwn && !!mpActions && !ship.transit;
  const rvSelected = interceptOptions.find(o => o.key === rendezvousId && o.ok) ?? null;
  const rvFleet = ship.fleetId ? gameState.fleets.find(f => f.id === ship.fleetId) ?? null : null;
  const rvFleetSize = rvFleet ? gameState.ships.filter(s => s.fleetId === rvFleet.id).length : 1;
  const rvGroupName = (o: InterceptOption) => o.fleet?.name ?? o.lead.name;

  const clearRvPreview = () => {
    previewRendezvous(ship.id, null);
    if (rvStagedMoveFor.current === ship.id) {
      cancelTorchPreview(ship.id);
      rvStagedMoveFor.current = null;
    }
  };
  const restoreRvCamera = () => {
    if (rvCamBefore.current) updateCamera(rvCamBefore.current);
    rvCamBefore.current = null;
    setRvShowing(false);
  };
  const closeIntercept = () => {
    clearRvPreview();
    restoreRvCamera();
    setRendezvousId(null);
    setRvPeek(false);
    setRendezvousOpen(false);
  };

  // SHOW: today's zoom-out, on request. It frames your hull, their hull
  // and the meeting point inside the map the panels leave uncovered —
  // beside the pop-out on a desktop, above the sheet on a phone.
  const frameIntercept = (o: InterceptOption) => {
    const box = courseBox(o, shipWorldPosition(ship, gameState.currentTick, gameState.bodies), gameState.bodies);
    if (!box) return;
    const W = window.innerWidth, H = window.innerHeight;
    // focusedBodyId is cleared FIRST — while it is set, x/y are an
    // offset (see releaseFocusPosition), not the world point at centre.
    updateCamera({
      focusedBodyId: undefined,
      ...framingCamera(box, freeMapArea(isMobile, rvPopAt?.left ?? null, W, H), W, H),
    });
  };
  const toggleShowIntercept = () => {
    if (!rvSelected) return;
    if (rvShowing) { restoreRvCamera(); return; }
    rvCamBefore.current = { ...getCamera() };
    frameIntercept(rvSelected);
    setRvShowing(true);
  };

  // PICKING NO LONGER MOVES THE CAMERA. It draws the course from where
  // you are: a match through the rendezvous preview, a meeting at the
  // door as the plain leg there (staged as the ship's planned move, the
  // same arc MOVE TO TARGET draws).
  const pickIntercept = (key: string) => {
    const o = interceptOptions.find(x => x.key === key && x.ok);
    if (!o) return;
    setRendezvousId(key);
    setTransferError(null);
    setTransferNote(null);
    if (isMobile) setRvPeek(true);
    if (o.rv) {
      if (rvStagedMoveFor.current === ship.id) {
        cancelTorchPreview(ship.id);
        rvStagedMoveFor.current = null;
      }
      previewRendezvous(ship.id, {
        p0: { x: o.myPlan.startPos.x, y: o.myPlan.startPos.y },
        v0: { x: o.myPlan.startVel.x, y: o.myPlan.startVel.y },
        accel: o.myPlan.acceleration,
        A: o.rv.A, B: o.rv.B,
        startTick: gameState.currentTick, meetTick: o.rv.meetTick,
        followShipId: o.lead.id,
      });
    } else {
      previewRendezvous(ship.id, null);
      if (planTorchPreview(ship.id, o.dest.id)) rvStagedMoveFor.current = ship.id;
    }
    if (rvShowing) frameIntercept(o);
  };

  // The order itself, unchanged from the old MATCH COURSE / MEET AT
  // button: the flagship flies the course it was shown, every other hull
  // of the fleet solves its own intercept of the same target, and the
  // fleet's mixed result is reported.
  const commitIntercept = async () => {
    const chosen = rvSelected;
    if (!chosen || !mpActions || rendezvousBusy) return;
    const chosenName = rvGroupName(chosen);
    // Guard the double-click: both posts carry replace:true, so the
    // second would cancel the leg the first just created.
    setRendezvousBusy(true);
    // The launch below replaces the staged preview, so it is no longer
    // the picker's to clear.
    rvStagedMoveFor.current = null;
    // Fly it locally too, or the hull sits parked until the next /state
    // poll and the button reads as dead. A MATCH IS NOT A TRIP TO THEIR
    // DESTINATION: keep the rendezvous preview staged so the committed
    // manoeuvre is still the one on screen until the server confirms it.
    launchTorchTransfer(ship.id, chosen.dest.id);
    if (chosen.rv) {
      previewRendezvous(ship.id, {
        p0: { x: chosen.myPlan.startPos.x, y: chosen.myPlan.startPos.y },
        v0: { x: chosen.myPlan.startVel.x, y: chosen.myPlan.startVel.y },
        accel: chosen.myPlan.acceleration,
        A: chosen.rv.A, B: chosen.rv.B,
        startTick: chosen.myPlan.startTick,
        meetTick: chosen.rv.meetTick,
        followShipId: chosen.lead.id,
      });
    }
    const res = await mpActions.transfer({
      shipId: ship.id,
      targetBodyId: chosen.dest.id,
      scheduledT: chosen.myPlan.startTick,
      // A TRUE MATCH ARRIVES WHEN THEY DO: flying together means sharing
      // their arrival, not landing on my own schedule.
      arrivalT: chosen.rv ? chosen.theirEta : chosen.myPlan.arriveTick,
      launch: launchFromPlan(chosen.myPlan),
      ...(chosen.rv ? {
        rendezvous: {
          ax: chosen.rv.A.x, ay: chosen.rv.A.y,
          bx: chosen.rv.B.x, by: chosen.rv.B.y,
          meetTick: chosen.rv.meetTick,
          followShipId: chosen.lead.id,
        },
      } : {}),
      dvPrograde: chosen.myPlan.totalDv,
      fuelCost: Math.round(chosen.myPlan.totalDv * 10),
      replace: true,
    });
    // THE WHOLE FLEET GOES: each mate solves its OWN intercept of the
    // same target from where it sits (a shared target, not a shared
    // trajectory) and commits it the same way.
    const mates = orderedHulls().filter(m => m.id !== ship.id);
    let mateOk = 0;
    let mateMatched = 0;
    const mateFlying = mates.filter(m => m.transit).length;
    const matePlans = mates
      .filter(m => !m.transit)
      .map(m => planHullIntercept(m.id, chosen.lead.id, { enqueueIntercept, launchTorchTransfer, previewRendezvous }))
      .filter((p): p is NonNullable<typeof p> => !!p);
    if (matePlans.length > 0) {
      const results = await mpActions.transferMany(matePlans.map(p => p.intent));
      results.forEach((r, i) => { if (r.ok) { mateOk++; if (matePlans[i].matched) mateMatched++; } });
    }
    setRendezvousBusy(false);
    rvCamBefore.current = null;
    setRvShowing(false);
    setRvPeek(false);
    if (!res.ok) {
      setTransferError(humanizeMpError(res.code, res.error, 'transfer'));
      return;
    }
    // Sent: the picker's job is done. Left open, it only hid while the
    // hull flew, and sprang back with the old pick on a RECALL LAUNCH.
    // The fleet's mixed result below shows on the ORDERS tab.
    setRendezvousId(null);
    setRendezvousOpen(false);
    if (mates.length > 0) {
      const total = mates.length + 1;
      const got = 1 + mateOk;
      const matched = (chosen.rv ? 1 : 0) + mateMatched;
      const flyingNote = mateFlying > 0 ? ` ${t('ship.panel.mateFlying', { n: mateFlying })}` : '';
      setTransferError(
        got < total
          ? `${t('ship.panel.ivPlotted', { got, total, name: chosenName })}${flyingNote}`
          : matched === total || matched === 0
            ? null
            : t('ship.panel.ivMatched', { matched, total, name: chosenName, dest: chosen.dest.name }),
      );
    }
  };

  const rvMyFaction = gameState.factions.find(f => f.id === 'player');
  const rvPickerShared = {
    entries: interceptEntries,
    selectedKey: rvSelected?.key ?? null,
    onSelect: pickIntercept,
    showing: rvShowing,
    onShow: toggleShowIntercept,
    onCommit: () => { void commitIntercept(); },
    busy: rendezvousBusy,
    message: transferError
      ? { kind: 'error' as const, text: transferError }
      : transferNote ? { kind: 'note' as const, text: transferNote } : null,
    meIcon: (
      <ShipIcon size={24} shipClass={iconClassFor(ship.class)} variant={ship.iconVariant} parts={ship.parts}
        color={rvMyFaction?.color ?? STANDING_RING.yours} color2={rvMyFaction?.color2} />
    ),
    now: gameState.currentTick,
    note: rvFleet && rvFleetSize > 1 ? t('ship.rv.fleetNote', { n: rvFleetSize, fleet: rvFleet.name }) : null,
  };

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
   * route the hull had; the rest append — one batch, applied in order.
   */
  const startAutoExplore = () => {
    if (!ship) return;
    setExploreNotice(null);
    setTransferError(null);
    const tour = exploreTour;
    if (tour.length === 0) return;

    const plans = queueTorchTour(ship.id, tour);
    if (plans.length === 0) {
      setExploreNotice(t('ship.panel.exploreNoCourse'));
      return;
    }
    const firstName = gameState.bodies.find(b => b.id === plans[0].targetBodyId)?.name ?? t('ship.panel.firstStop');
    setExploreNotice(
      tn('ship.panel.surveying', plans.length, { name: firstName })
      + (plans.length < tour.length ? ` (${t('ship.panel.unreachable', { n: tour.length - plans.length })})` : ''),
    );
    if (!mpActions) return;

    // One request; the server applies the legs in order and stops the
    // route at its first refusal, as the awaited loop here used to.
    void mpActions.transferMany(plans.map((p, i) => ({
      shipId: ship.id,
      targetBodyId: p.targetBodyId,
      scheduledT: p.startTick,
      arrivalT: p.arriveTick,
      launch: launchFromPlan(p),
      dvPrograde: p.totalDv,
      fuelCost: Math.round(p.totalDv * 10),
      replace: i === 0,
    }))).then(results => {
      const bad = results.find((r): r is Extract<MpActionResult, { ok: false }> => !r.ok);
      if (bad) setTransferError(humanizeMpError(bad.code, bad.error, 'transfer'));
    });
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
      setDeployNotice(t('ship.panel.founded', { name, body: colonyBody.name }));
    } else {
      setDeployNotice(humanizeMpError(res.code, res.error, 'deploy'));
    }
  };

  /**
   * Drop a staged step.
   *
   * queueIndex null = the PRIMARY preview: cleared locally, and for the
   * whole fleet, because a fleet move stages one preview per member and
   * leaving the others behind is what made a "removed" plan still fly.
   * A number = a chained leg, which handleRemoveQueuedTransfer already
   * knows how to cancel server-side along with its orphaned tail.
   */
  const removeStep = (queueIndex: number | null) => {
    setTransferError(null);
    if (queueIndex != null) { handleRemoveQueuedTransfer(queueIndex); return; }
    const crew = ship.fleetId
      ? gameState.ships.filter(s => s.fleetId === ship.fleetId)
      : [ship];
    const drop = new Set(crew.map(s => s.id));
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s => (drop.has(s.id)
        ? { ...s, plannedTransit: undefined }
        : s)),
    });
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
        // A leg committed a moment ago carries no nodeId until the next
        // poll; the transfer POST's answer does (committedNodeIdFor).
        const nodeId = leg.nodeId ?? committedNodeIdFor(ship.id, leg.startTick);
        if (!nodeId) continue;  // local-only preview leg — nothing to cancel
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
      setFleetError(res.error?.message ?? t('ship.panel.fleetFailed'));
      return false;
    }
    return true;
  };
  // Client fleet ids are stripped ('fl_x'); the worker matches the full
  // "<gameId>:fl_x". Sending the bare one 404'd every button below.
  const fleetUrl = (id: string) => fleetPath(mpActions?.gameId ?? '', id);

  const handleFormFleet =(peerIds: string[]) => {
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
      void fleetApi('PATCH', fleetUrl(ship.fleetId),
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

  // A GATE LEG LOOKS LIKE A MISTAKE UNLESS IT SAYS SO.
  //
  // Trade routes take a warp gate whenever the whole detour beats flying
  // direct, so a Neptune run now leaves Earth heading INWARD, at the sun.
  // The panel said "En route to Solar Gate" and left the player to work
  // out why their freighter had turned around. Name the crossing and the
  // world it is ultimately for.
  //
  // The far side is read from the gate's own pairing; the final stop from
  // the route this hull crews, which is the thing the player actually
  // asked for. Falls back to the far gate when the hull is not on a route
  // (a manual transit), and to nothing at all when neither is known —
  // never to a guess.
  const targetGate = transitTarget
    ? gameState.megastructures?.[transitTarget]
    : undefined;
  const onAGateLeg = !!ship.transit && targetGate?.kind === 'warp_gate';
  const routeStopName = (() => {
    for (const r of gameState.tradeRoutes ?? []) {
      const crew = (r.ships ?? []).find(c => c.shipId === ship.id);
      if (!crew) continue;
      const stops = r.stops ?? [];
      if (!stops.length) return null;
      const i = Math.min(Math.max(0, crew.nextStopSeq ?? 0), stops.length - 1);
      return nameOfBody(stops[i].bodyId);
    }
    return null;
  })();
  const gateOnward = routeStopName
    ?? (targetGate?.partnerBodyId ? nameOfBody(targetGate.partnerBodyId) : null);
  const gateSuffix = onAGateLeg && gateOnward ? ` · ${t('ship.panel.gateLeg', { name: gateOnward })}` : '';

  const locationLabel = ship.transit
    ? `${t('ship.panel.enRoute', { name: nameOfBody(transitTarget) ?? t('ship.panel.unknownLower') })}${etaSuffix}${gateSuffix}`
    : t('ship.panel.orbiting', { name: nameOfBody(ship.orbit.parentBodyId) ?? ship.orbit.parentBodyId });


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
  // ...and the other side of that window. Once the tick burns the node it
  // flips to in_transit and recall is genuinely gone -- the burn has
  // fired, there is nothing left to call back. Saying so is the point:
  // the control simply vanishing reads as a missing button rather than a
  // closed window, which is how it was reported.
  const burnFired = !!(isOwn && ship.transit && !canRecall
    && ship.orders.some(o => o.type === 'transfer' && o.departed === true));

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

  // ONE recall control, offered in two places -- the same reasoning as
  // COMMIT below.
  //
  // It only ever lived on the SHIP tab, in among SPEED and STATUS. But
  // the moment it applies is the moment you are staring at MANEUVER
  // NODES on the ORDERS tab watching a committed leg you regret, with a
  // COMMIT button greyed out beneath it reading "nothing staged". The
  // one live verb in that state was a tab away, so it read as missing.
  // Asked as: "what happened to the recall launch button?"
  const recallButton = (
    <button
      onClick={doRecall}
      disabled={recalling}
      title={(() => {
        // Said "the top of the next tick" for every leg, including one
        // scheduled nine ticks out (QA battle test). Name the real tick.
        const burn = Math.ceil(pendingNode?.burnTime ?? gameState.currentTick + 1);
        const wait = burn - gameState.currentTick;
        return wait <= 1
          ? t('ship.panel.recallNext')
          : t('ship.panel.recallAt', { burn, wait });
      })()}
      style={{
        background: 'rgba(255,184,77,0.14)',
        border: '1px solid rgba(255,184,77,0.55)',
        color: '#ffb84d', borderRadius: 4, cursor: 'pointer',
        font: 'inherit', fontSize: 10, letterSpacing: '0.08em',
        padding: '2px 8px',
      }}
    >
      {recalling ? t('ship.panel.recalling') : `⟲ ${t('ship.panel.recallLaunch')}`}
    </button>
  );

  // Queue (torch chained legs).
  const queuedTransits = ship.queuedTransits || [];

  // WHAT COMMIT WOULD LAUNCH -- derived ONCE and offered in two places.
  //
  // The button lives under MANEUVER NODES, which is a section and a
  // scroll away from PROGRAM. A player reading "staged -- not committed"
  // in their program had to know to scroll up to a differently-named
  // section to act on it, which is the same complaint that produced the
  // program view in the first place: the state was visible and the verb
  // was not.
  //
  // So PROGRAM gets the button too -- the SAME button, not a second
  // implementation. This used to be an IIFE inside the JSX; hoisting it
  // is what makes offering it twice safe.
  const fleetPreviewShips = ship.fleetId
    ? gameState.ships.filter(s =>
        s.fleetId === ship.fleetId && s.plannedTransit && !s.transit,
      )
    : (ship.plannedTransit ? [ship] : []);
  const canCommit = fleetPreviewShips.length > 0;
  const commitLabel = fleetPreviewShips.length > 1
    ? `▶ ${t('ship.panel.commitAll', { n: fleetPreviewShips.length })}`
    : `▶ ${t('ship.panel.commit')}`;
  // Every hull's legs in ONE request (POST /transfers). A fleet COMMIT ALL
  // was one POST per leg per hull, awaited hull by hull.
  const commitStagedPlan = () => {
    const intents = fleetPreviewShips.flatMap(s => commitTransferLocal(s));
    if (!mpActions || intents.length === 0) return;
    setTransferError(null);
    void mpActions.transferMany(intents).then(results => {
      const bad = results.filter((r): r is Extract<MpActionResult, { ok: false }> => !r.ok);
      if (bad.length === 0) return;
      const msg = humanizeMpError(bad[0].code, bad[0].error, 'transfer');
      setTransferError(bad.length > 1 ? t('ship.panel.legsRefused', { n: bad.length, msg }) : msg);
    });
  };

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
  // FLEET: any hull that belongs to one, yours or a rival's. A DETACHED
  // member still has the tab — it is still in the fleet — it just does
  // not open on it.
  const hasFleet = !!ship.fleetId;
  // A foundry mid-burn has no body to build at — the slots are wherever
  // it PARKS. Showing the tab anyway would be the empty-tab trap this
  // file warns about twice already.
  const hasYard = isOwn && ship.class === 'mobile_foundry' && !ship.transit
    && !!ship.orbit?.parentBodyId;
  const tabExists = (t: ShipPanelTab) =>
    (t !== 'cargo' || hasCargo) && (t !== 'orders' || hasOrders)
    && (t !== 'yard' || hasYard) && (t !== 'fleet' || hasFleet);
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
  const atPeace = makePeaceCheck(gameState.warPairs);
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
    ? (gameState.fleets ?? []).find(f => f.id === ship.fleetId) ?? null
    : null;
  // The officer commanding this hull, when it is in a fleet. Members
  // have no captain of their own — the admiral is their command.
  const admiral = currentFleet
    ? (gameState.captains ?? []).find(c => c.id === currentFleet.flagCaptainId) ?? null
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
    retreatBodyId?: string | null;
    arrivalAction?: 'detonate' | 'arrive_defensive' | 'arrive_hold' | null;
    arrivalGuard?: 'hostile_in_orbit' | null;
    detonateAtTick?: number | null;
    detonateAtGuard?: 'hostile_in_orbit' | null;
    detonateOnHostile?: boolean;
    detonateMineMode?: 'hostile' | 'no_friendly' | 'hostile_no_friendly' | null;
    detonateHpPct?: 25 | 50 | null;
    targetPriority?: TargetPriorityKey[] | null;
  }) => {
    if (!mpActions) return;
    setOrdersError(null);
    setGameState({
      ...gameState,
      ships: gameState.ships.map(s => (s.id === ship.id ? { ...s, ...patch } : s)),
    });
    // Every key on the patch is forwarded (shipOrdersIntent). A hand-kept
    // list here dropped the MINED / detonate-when-hostile fields, so those
    // orders were never saved ("no order fields supplied").
    mpActions.setShipOrders(shipOrdersIntent(ship.id, patch)).then(res => {
      if (!res.ok) {
        setOrdersError(humanizeMpError(res.code, res.error, 'orders'));
      }
    });
  };

  // THE FLEET BLOCK, rendered in two places. On the SHIP tab it is where a
  // fleet is FORMED — the FLEET tab only exists once there is one. Inside
  // a fleet the block moves to the FLEET tab with the rest of the fleet's
  // card, and the SHIP tab keeps a one-line pointer. The pointer carries
  // the same tutorial id, so the "Fleets move as one" step never points
  // at a hidden element.
  const fleetSectionJsx = (where: 'ship' | 'fleet'): React.ReactNode => {
    if (where === 'ship' && currentFleet) {
      return (
        <div className="fleet-section" data-tutorial-id="ship-fleet-section">
          <div className="section-title">{t('ship.panel.tab.fleet')}</div>
          <div className="fleet-note">
            {ship.fleetDetached ? t('ship.panel.detachedFrom') : t('ship.panel.fliesWith')}{' '}
            <strong>{currentFleet.name}</strong>.
          </div>
          <div className="fleet-buttons">
            <button className="maneuver-btn" onClick={() => setShipTab('fleet')}>
              {t('ship.panel.openFleetCard')}
            </button>
          </div>
        </div>
      );
    }
    if (!(currentFleet || eligiblePeers.length > 0)) return null;
    return (
            <div className="fleet-section" data-tutorial-id={where === 'ship' ? 'ship-fleet-section' : undefined}>
              <div className="section-title">
                {where === 'fleet' ? t('ship.panel.fleetActions') : t('ship.panel.tab.fleet')}
              </div>
              {currentFleet ? (
                <>
                  {/* The old TRANSFER MOVES FLEET checkbox lived here.
                      It was the bug: a fleet whose movement was optional
                      is not a fleet, it is a label, and unticking it
                      scattered the formation with nothing on screen
                      saying so. A fleet moves together; that is what it
                      is for. */}
                  <div className="fleet-note">
                    {ship.fleetDetached
                      ? t('ship.panel.detachedNote')
                      : t('ship.panel.attachedNote', { n: fleetMembers.filter(m => !m.fleetDetached).length })}
                  </div>
                  <div className="fleet-buttons">
                    <button
                      className="maneuver-btn"
                      onClick={() => setShipSelection(
                        fleetMembers.filter(m => !m.fleetDetached).map(m => m.id),
                      )}
                      title={t('ship.panel.selectFleetTip')}
                    >{t('ship.panel.selectFleet')}</button>
                    {/* DETACH keeps membership. LEAVE below is permanent
                        and forfeits the captain arrangement; this is for
                        "that one scouts ahead" and is one click to undo. */}
                    <button
                      className={`maneuver-btn${ship.fleetDetached ? ' prog__set' : ''}`}
                      onClick={() => {
                        void fleetApi('PATCH', fleetUrl(currentFleet.id),
                          ship.fleetDetached
                            ? { rejoin_ship_ids: [ship.id] }
                            : { detach_ship_ids: [ship.id] });
                      }}
                      title={ship.fleetDetached
                        ? t('ship.panel.rejoinTip')
                        : t('ship.panel.detachTip')}
                    >{ship.fleetDetached ? t('ship.panel.rejoin') : t('ship.panel.detach')}</button>
                  </div>
                  <div className="fleet-buttons">
                    {eligiblePeers.length > 0 && (
                      <button className="maneuver-btn" onClick={() => setFleetModalOpen(true)}>
                        {t('ship.panel.addShips')}
                      </button>
                    )}
                    <button
                      className="maneuver-btn"
                      onClick={() => {
                        if (mpActions) {
                          void fleetApi('PATCH', fleetUrl(currentFleet.id),
                            { remove_ship_ids: [ship.id] });
                        } else removeFromFleet(currentFleet.id, ship.id);
                      }}
                    >
                      {t('ship.panel.leave')}
                    </button>
                    <button
                      className="maneuver-btn"
                      style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
                      onClick={() => {
                        if (mpActions) {
                          void fleetApi('DELETE', fleetUrl(currentFleet.id));
                        } else disbandFleet(currentFleet.id);
                      }}
                    >
                      {t('ship.panel.disband')}
                    </button>
                  </div>
                </>
              ) : (
                <button className="maneuver-btn" onClick={() => setFleetModalOpen(true)}>
                  {tn('ship.panel.formFleet', eligiblePeers.length)}
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
                  title={t('ship.sd.dismiss')}
                >⚠ {fleetError}</button>
              )}
            </div>
    );
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
          <span>{t('ship.panel.tapBody', { name: ship.name.toUpperCase() })}</span>
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
            {t('ship.panel.cancel')}
          </button>
        </div>
      )}

      <BottomSheet
        open={!hideForTargeting}
        onClose={deselectShip}
        title={rvOpenNow && isMobile ? t('ship.rv.title', { name: ship.name }) : t('ship.panel.shipTitle', { name: ship.name })}
        size={rvOpenNow && isMobile ? (rvPeek && rvSelected ? 'peek' : 'tall') : undefined}
      >
      {/* PHONE: the intercept picker is a page of this sheet. The panel
          stays mounted underneath (its state survives) but is hidden, and
          with it the sticky COMMIT bar that used to cover the list. */}
      {rvOpenNow && isMobile && (
        <InterceptPicker
          variant="sheet"
          {...rvPickerShared}
          onBack={closeIntercept}
          peek={rvPeek}
          onUnpeek={() => setRvPeek(false)}
        />
      )}
      <div
        className={`ship-panel${rvOpenNow && isMobile ? ' ship-panel--away' : ''}`}
        data-tutorial-id="ship-panel"
        ref={panelRef}
      >
        <div className="panel-header">
          <span>
            {t('ship.panel.shipColon')}{' '}
            <EditableName
              value={ship.name}
              readOnly={ship.ownedBy !== 'player'}
              ariaLabel={t('ship.panel.renameThis')}
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
                title={t('ship.panel.rankTip', { rank: ship.rank ?? 0, pct: ship.rank ?? 0 })}
              >{t('ship.panel.rank', { n: ship.rank ?? 0 })}</span>
            )}
            {/* Captain chip (DESIGN-captains §5): portrait + name. The rank
                above is HIS. Click-through lives in the Fleet panel's
                Captains view; here it's identity + trait tooltip. */}
            {/* THE ADMIRAL, ON EVERY HULL IN THE SQUADRON.
                Members surrender their own captains on joining, so a
                non-flagship hull showed no officer at all — while being
                commanded by one, and carrying their trait into every
                fight. The chip says WHOSE fleet you are looking at from
                any member, not just the flagship. On the flagship the
                ship's own captain chip below already IS the admiral, so
                this stands down rather than saying it twice. */}
            {currentFleet && ship.id !== currentFleet.leadShipId && admiral && (
              <span
                className="ship-adm-chip"
                title={t('ship.panel.admiralTip', {
                  name: admiral.name, fleet: currentFleet.name,
                  flag: gameState.ships.find(x => x.id === currentFleet.leadShipId)?.name ?? t('ship.panel.theFlagship'),
                  traits: traitSummary(admiral.traits) || t('fleet.noTraits'),
                })}
              >
                <CaptainAvatar avatarId={admiral.avatarId} size={CAPTAIN_CHIP_PX} />
                <span className="ship-adm-chip__rank">{t('fleet.admiral')}</span>
                {admiral.name.toUpperCase()}
              </span>
            )}
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
                title={traitSummary(ship.captainTraits) || t('ship.panel.captain')}
              >
                <CaptainAvatar avatarId={ship.captainAvatar} size={CAPTAIN_CHIP_PX} />
                {ship.captainName.toUpperCase()}
              </span>
            )}
          </span>
          <button className="panel-close" onClick={deselectShip}>✕</button>
        </div>

        <div className="ship-tabs" role="tablist">
          {SHIP_TABS.filter(tb => tabExists(tb.key)).map(tb => (
            <button
              key={tb.key}
              role="tab"
              aria-selected={activeTab === tb.key}
              className={`ship-tabs__tab${activeTab === tb.key ? ' is-active' : ''}`}
              onClick={() => setShipTab(tb.key)}
            >
              {t(`ship.panel.tab.${tb.key}` as const)}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {/* FLEET — one card for the whole squadron.
              Selecting any member used to show that one hull: its HP, its
              destination, its guns. True, and not the question — "what is
              this FLEET and what is it doing". Everything here is summed
              over the attached hulls by fleetSummary, which is tested, and
              read off the SHIPS rather than the fleet row, so a rival's
              fleet (whose row we may not hold) gets the same card from
              whatever our sensors can see of it. */}
          {activeTab === 'fleet' && ship.fleetId && (() => {
            const fid = ship.fleetId;
            const members = gameState.ships.filter(m => m.fleetId === fid);
            const maxHpOf = (m: typeof ship) =>
              effectiveShipMaxHp(m, gameState.factionTech[m.ownedBy]);
            const sum = summarizeFleet(
              members, gameState.currentTick, maxHpOf,
              m => m.damagePerTick ?? getShipClass(m.class as ShipClassName).damagePerTick,
            );
            const statusOf = (m: typeof ship) => {
              const mx = maxHpOf(m);
              return shipStatus(
                m, gameState.currentTick, mx > 0 ? (m.hp ?? mx) / mx : 1,
                (isArmed(m) ? hostilesHere : armedHostilesHere)(m.orbit.parentBodyId, m.ownedBy),
                stationsHere(m.orbit.parentBodyId, m.ownedBy),
              );
            };
            const head = fleetHeadlineStatus(sum.attached.map(statusOf));
            const bodyName = (id: string) => gameState.bodies.find(b => b.id === id)?.name ?? '?';
            const name = currentFleet?.name ?? t('fleet.title');
            const flagId = currentFleet?.leadShipId;
            // The officer, read off the FLAGSHIP: it carries captain name,
            // portrait and rank for rivals too, while our captain roster
            // only knows our own.
            const flag = members.find(m => m.id === flagId) ?? null;
            const admName = flag?.captainName ?? currentFleet?.flagCaptainName ?? admiral?.name ?? null;
            const admAvatar = flag?.captainAvatar ?? admiral?.avatarId ?? null;
            const admRank = admiral?.rank ?? currentFleet?.flagCaptainRank ?? flag?.rank ?? 0;
            const admTraits = currentFleet?.flagCaptainTraits ?? admiral?.traits ?? [];
            const ownerFaction = !isOwn ? gameState.factions.find(f => f.id === ship.ownedBy) : null;
            const LIST_CAP = 24;
            const listed = fleetListAll ? sum.attached : sum.attached.slice(0, LIST_CAP);
            const clsName = (c: string) =>
              (getShipClass(c as ShipClassName)?.displayName ?? c.replace('_', ' ')).toUpperCase();
            return (
              <div className="fleet-tab">
                <div className="fleet-tab__head">
                  <span className="fleet-tab__flag" aria-hidden>&#9873;</span>
                  <span className="fleet-tab__name">{name}</span>
                  <span className="fleet-tab__count">
                    {tn('fleet.ships', sum.attached.length)}
                  </span>
                </div>
                {ownerFaction && (
                  <div className="fleet-tab__owner" style={{ color: ownerFaction.color }}>
                    {ownerFaction.name}
                  </div>
                )}

                {admName ? (
                  <div className="fleet-tab__adm" title={traitSummary(admTraits) || t('fleet.noTraits')}>
                    <CaptainAvatar avatarId={admAvatar ?? undefined} size={34} />
                    <div className="fleet-tab__admtext">
                      <span className="fleet-tab__admrole">{t('fleet.admiral')} · {rankTierLabel(admRank).toUpperCase()}</span>
                      <span className="fleet-tab__admname">{admName}</span>
                      {admTraits.length > 0 && (
                        <span className="fleet-tab__admtraits">{traitSummary(admTraits)}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="fleet-tab__adm fleet-tab__adm--none">
                    {t('ship.panel.noAdmiral')}
                  </div>
                )}

                <div className="stat-row">
                  <span className="label">{t('ship.panel.status')}</span>
                  <span className="value">
                    {head ? (
                      <span className={`status-badge status-badge--${head.status.cls}`} title={head.status.title}>
                        {head.status.label.toUpperCase()}
                        {head.count < sum.attached.length ? ` · ${t('ship.panel.ofTotal', { n: head.count, total: sum.attached.length })}` : ''}
                      </span>
                    ) : '—'}
                  </span>
                </div>
                {/* Where it is. One line for a fleet together; one per
                    group for a fleet split across places, because a
                    detachment somewhere else is a real answer. */}
                {sum.places.map(pl => (
                  <div className="stat-row" key={`${pl.kind}:${pl.bodyId}`}>
                    <span className="label">{sum.places.length > 1 ? tn('fleet.shipsCaps', pl.count) : t('ship.panel.location')}</span>
                    <span className="value">
                      {pl.kind === 'transit'
                        ? t('ship.panel.enRouteEta', { name: bodyName(pl.bodyId), eta: String(pl.eta) })
                        : t('ship.panel.parkedAt', { name: bodyName(pl.bodyId) })}
                    </span>
                  </div>
                ))}

                <div className="section-title">{t('ship.panel.power')}</div>
                <div className="stat-row">
                  <span className="label">{t('ship.panel.hull')}</span>
                  <span className="value">{Math.round(sum.hp)}/{Math.round(sum.hpMax)} · {sum.hpPct}%</span>
                </div>
                {/* The ship card's own hull bar, so a fleet reads on the
                    same scale and colours as each of its ships. */}
                <div className="sp-hpbar">
                  <div
                    className={`sp-hpbar__fill sp-hpbar__fill--${sum.hpPct <= 33 ? 'low' : sum.hpPct <= 66 ? 'mid' : 'good'}`}
                    style={{ width: `${sum.hpPct}%` }}
                  />
                </div>
                {sum.worstHpPct < sum.hpPct - 10 && (
                  <div className="fleet-tab__warn">{t('ship.panel.weakest', { pct: sum.worstHpPct })}</div>
                )}
                <div className="stat-row">
                  <span className="label">{t('ship.panel.firepower')}</span>
                  <span className="value">
                    {Math.round(sum.firepower)}/{t('fleet.tick')}
                    {sum.armed < sum.attached.length ? ` · ${t('ship.panel.armedN', { n: sum.armed })}` : ''}
                  </span>
                </div>
                <div className="fleet-tab__comp">
                  {sum.composition.map(c => (
                    <span key={c.cls} className="fleet-tab__compchip">
                      <HullIcon shipClass={c.cls} size={16} />
                      {c.count} {clsName(c.cls)}
                    </span>
                  ))}
                </div>

                <div className="section-title">{t('ship.panel.shipsHead')}</div>
                <div className="fleet-tab__list">
                  {listed.map(m => {
                    const mx = maxHpOf(m);
                    const pct = Math.max(0, Math.min(100, Math.round(((m.hp ?? mx) / (mx || 1)) * 100)));
                    const c = pct <= 33 ? '#ff5e5e' : pct <= 66 ? '#ffb84d' : '#6ee7b7';
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`fleet-tab__row${m.id === ship.id ? ' is-open' : ''}`}
                        onClick={() => selectShip(m.id)}
                        title={t('ship.panel.rowTip', { name: m.name, pct })}
                      >
                        <HullIcon shipClass={m.class} variant={m.iconVariant} size={16} color={c} />
                        <span className="fleet-tab__rowname">{m.id === flagId ? '★ ' : ''}{m.name}</span>
                        <span className="fleet-tab__rowcls">{clsName(m.class)}</span>
                        <span className="fleet-tab__rowhp"><span style={{ width: `${pct}%`, background: c }} /></span>
                      </button>
                    );
                  })}
                </div>
                {sum.attached.length > LIST_CAP && (
                  <button type="button" className="fleet-tab__more" onClick={() => setFleetListAll(v => !v)}>
                    {fleetListAll ? t('ship.panel.showFewer') : t('ship.panel.moreShowAll', { n: sum.attached.length - LIST_CAP })}
                  </button>
                )}
                {sum.detached.length > 0 && (<>
                  <div className="section-title">{t('ship.panel.detachedHead')}</div>
                  <div className="fleet-tab__note">{t('ship.panel.detachedNoteTab')}</div>
                  <div className="fleet-tab__list">
                    {sum.detached.map(m => (
                      <button key={m.id} type="button" className="fleet-tab__row" onClick={() => selectShip(m.id)}>
                        <HullIcon shipClass={m.class} variant={m.iconVariant} size={16} />
                        <span className="fleet-tab__rowname">{m.name}</span>
                        <span className="fleet-tab__rowcls">{clsName(m.class)}</span>
                      </button>
                    ))}
                  </div>
                </>)}

                {isOwn && fleetSectionJsx('fleet')}
              </div>
            );
          })()}
          {/* YARD — the foundry's slipway, pointed at whatever it is
              parked over. BuildPanel is the same component the body
              inspector uses, handed an explicit body instead of reading
              the map selection, so the queue, the slot pips, the senate
              price law and the waiting-order projections are all the
              real ones rather than a second implementation that would
              drift within a release. */}
          {activeTab === 'yard' && (() => {
            const at = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);
            const slots = MEGASTRUCTURES.mobile_foundry.effect.buildSlots ?? 0;
            return (
              <>
                <div className="capnote">
                  <div className="capnote__head">⬢ {t('ship.panel.slipway')}</div>
                  <div className="capnote__body">
                    {t('ship.panel.slipwayBody', { slots, name: at?.name ?? t('ship.panel.thisOrbit') })}
                  </div>
                </div>
                <BuildPanel bodyId={ship.orbit.parentBodyId} />
              </>
            );
          })()}
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
              title={t('ship.sd.dismiss')}
            >⚠ {transferError}</button>
          )}
          {transferNote && !transferError && (
            <button
              onClick={() => setTransferNote(null)}
              style={{
                margin: '0 0 6px', padding: '6px 10px',
                background: 'rgba(78, 205, 196, 0.08)',
                border: '1px solid rgba(78, 205, 196, 0.45)', borderRadius: 4,
                color: '#9fe3dd', fontSize: 10, lineHeight: 1.4,
                fontFamily: 'inherit', textAlign: 'left',
                cursor: 'pointer', width: '100%',
              }}
              title={t('ship.sd.dismiss')}
            >{transferNote}</button>
          )}
          {/* WHO THIS ORDER MOVES, said where the order is given. A move
              from a fleet member plans for the whole fleet, and the way to
              send one hull alone (DETACH) lived on the FLEET tab — from
              here it looked impossible (QA battle test). */}
          {isOwn && currentFleet && !ship.fleetDetached && mpActions && (
            <div className="fleet-note" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ flex: 1 }}>
                {t('ship.panel.movesApply', { n: fleetMembers.filter(m => !m.fleetDetached).length })}{' '}
                <strong>{currentFleet.name}</strong>.
              </span>
              <button
                className="maneuver-btn"
                style={{ flex: '0 0 auto' }}
                onClick={() => {
                  void fleetApi('PATCH', fleetUrl(currentFleet.id), { detach_ship_ids: [ship.id] });
                }}
                title={t('ship.panel.detachThisTip')}
              >{t('ship.panel.detachThis')}</button>
            </div>
          )}
          <div className="maneuver-buttons">
            <button
              className="maneuver-btn"
              onClick={() => setTargetSelectionMode(true)}
              data-tutorial-id="ship-transfer-button"
            >
              {hasExistingTransfer ? t('ship.panel.chainMove') : t('ship.panel.moveToTarget')}
            </button>
            <button className="maneuver-btn" onClick={() => setTransferModalOpen(true)}>
              {t('ship.panel.chooseFromList')}
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
                ? t('ship.panel.locateFlightTip')
                : t('ship.panel.locateTip')}
            >
              {t('ship.panel.locate')}
            </button>
            {/* INTERCEPT — the fourth button, and a button at last.
                It was a bare disclosure row below the grid: "it doesn't
                look like a button, which should probably be UI tweaked"
                (Noah), and fartmaster only found it after being told
                where to look. Same shape and weight as its three
                neighbours; the list opens underneath the grid.
                Gated exactly as the list below is, so the button can
                never offer a panel that will not open. */}
            {isOwn && mpActions && !ship.transit && (
              <button
                type="button"
                className={`maneuver-btn${rendezvousOpen ? ' is-armed' : ''}`}
                onClick={() => (rendezvousOpen ? closeIntercept() : setRendezvousOpen(true))}
                aria-expanded={rendezvousOpen}
                title={t('ship.panel.interceptTip')}
              >
                {t('ship.panel.intercept')} ▸
              </button>
            )}
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
                title={t('ship.panel.surveyRange')}
                style={{
                  background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
                  color: '#9fb4c6', fontFamily: 'inherit', fontSize: 10, padding: '3px 5px',
                  flex: '0 1 auto', minWidth: 0,
                }}
              >
                <option value="system">{t('ship.panel.thisSystem')}</option>
                <option value="all">{t('ship.panel.wholeMap')}</option>
              </select>
              <button
                className="maneuver-btn"
                disabled={exploreTour.length === 0 || !!ship.transit}
                onClick={startAutoExplore}
                title={ship.transit
                  ? t('ship.panel.exploreUnderWay')
                  : exploreTour.length === 0
                    ? t('ship.panel.exploreNothing')
                    : t('ship.panel.exploreQueue', { n: exploreTour.length })}
                style={exploreTour.length === 0 || ship.transit ? { opacity: 0.45 } : undefined}
              >
                ⌖ {t('ship.panel.autoExplore')}{exploreTour.length > 0 ? ` (${exploreTour.length})` : ''}
              </button>
            </div>
          )}
          {exploreNotice && (
            <div style={{ fontSize: 10, color: '#8aa0b4', margin: '4px 0 0', lineHeight: 1.4 }}>
              {exploreNotice}
            </div>
          )}

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
          {/* THE COUNTDOWN, FOR EVERYONE. Deliberately NOT gated on
              ownership — this is the only readout in the game where the
              person who most needs the number is the one who does not
              own the hull. The charge exists solely to give the target a
              window; showing the clock only to the attacker meant the
              window was theoretical.
              If you can see the ship, you can see what it is doing. No
              controls here — standing it down stays on ORDERS, which is
              owner-only, so a rival reads the clock and cannot touch it. */}
          {ship.strikeReadyTick != null && (() => {
            const left = Math.max(0, Math.ceil(ship.strikeReadyTick - gameState.currentTick));
            const world = gameState.bodies.find(b => b.id === ship.strikeTargetBodyId);
            const pct = Math.max(0, Math.min(1,
              1 - left / MEGA_STRIKE_CHARGE_TICKS));
            const mineTarget = world?.ownedBy === 'player';
            return (
              <div className="strikeclock">
                <div className="strikeclock__head">
                  ✹ {ship.strikeMode === 'obliterate' ? t('ship.panel.chargingDestroy') : t('ship.panel.charging')}{world ? ` — ${world.name}` : ''}
                </div>
                <div className="strikeclock__t">
                  {tn('ship.panel.tillCharged', left)}
                </div>
                <div className="strikeclock__track">
                  <div className="strikeclock__fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
                </div>
                <div className="strikeclock__note">
                  {mineTarget
                    ? (ship.strikeMode === 'obliterate'
                      ? t('ship.panel.strikeWorldDies')
                      : t('ship.panel.strikeSettlementsDie'))
                      + ' ' + t('ship.panel.strikeMoveBreaks')
                    : isOwn
                      ? t('ship.panel.movingBreaks')
                      : t('ship.panel.losesCharge')}
                </div>
              </div>
            );
          })()}
          {isOwn && mpActions && (() => {
            // ANY SAVED DESIGN OF THIS CLASS, not only the active one
            // (Noah: retrofitting one hull meant making its design the
            // active template in the fleet designer first). The server
            // has always taken any of your designs of the right class.
            const choices = retrofitChoices(ship, gameState.shipDesigns);
            if (choices.length === 0) return null;
            const picked = refitPick?.shipId === ship.id
              ? choices.find(d => d.id === refitPick.designId) : undefined;
            const active = picked ?? defaultRetrofitPick(ship, choices)!;
            const now = sanitizeParts(ship.parts ?? []);
            const want = sanitizeParts(active.parts ?? []);

            const pending = ship.refitPendingDesignId === active.id;
            const pendingOther = !pending && ship.refitPendingDesignId
              ? (gameState.shipDesigns ?? []).find(d => d.id === ship.refitPendingDesignId) : undefined;
            const fee = refitFee(now, want, ship.class);
            const feeStr = [
              fee.ore > 0 ? t('ship.panel.nMetal', { n: Math.round(fee.ore) }) : null,
              fee.credits > 0 ? t('ship.panel.nCredits', { n: Math.round(fee.credits) }) : null,
            ].filter(Boolean).join(' + ') || t('ship.panel.noCharge');

            // Where the work can actually happen — ANY friendly
            // settlement, which is what the tick pass requires. null
            // means this hull is already somewhere that qualifies.
            const site = nearestRefitBodyId(ship, gameState.settlements, gameState.bodies, gameState.currentTick);
            const siteName = site ? (gameState.bodies.find(b => b.id === site)?.name ?? t('ship.panel.aYard')) : null;

            return (
              <div className="maneuver-section" style={{ marginTop: 8 }}>
                {/* Title text is RETROFIT</div> in English (source-scanning tests look for it). */}
                <div className="section-title">{t('ship.panel.retrofit')}</div>
                {/* ALWAYS a dropdown once there is anything to refit to,
                    listing the whole class: the design this hull carries
                    shows as "fitted now" and cannot be picked. A single
                    alternative used to render as plain text, which read
                    as the picker not being there at all. */}
                {(
                  <select
                    className="refit-pick"
                    data-testid="refit-pick"
                    value={active.id}
                    onChange={e => setRefitPick({ shipId: ship.id, designId: e.target.value })}
                    title={t('ship.panel.refitPickTip')}
                    style={{
                      width: '100%', margin: '2px 0 4px', padding: '3px 4px', fontSize: 11,
                      background: 'rgba(14, 21, 30, 0.9)', color: '#d8e4ee',
                      border: '1px solid #2a3d50', borderRadius: 4, fontFamily: 'inherit',
                    }}
                  >
                    {retrofitOptions(ship, gameState.shipDesigns).map(d => {
                      if (d.fitted) {
                        return (
                          <option key={d.id} value={d.id} disabled>
                            {d.name}{d.isActive ? ` (${t('ship.sd.activeLower')})` : ''} · {t('ship.panel.fittedNow')}
                          </option>
                        );
                      }
                      const f = refitFee(now, sanitizeParts(d.parts ?? []), ship.class);
                      const cost = [
                        f.ore > 0 ? `${Math.round(f.ore)}M` : null,
                        f.credits > 0 ? `${Math.round(f.credits)}C` : null,
                      ].filter(Boolean).join(' ') || t('ship.sd.free');
                      return (
                        <option key={d.id} value={d.id}>
                          {d.name}{d.isActive ? ` (${t('ship.sd.activeLower')})` : ''}{ship.refitPendingDesignId === d.id ? ` · ${t('ship.panel.ordered')}` : ''} · {cost}
                        </option>
                      );
                    })}
                  </select>
                )}
                <div style={{ fontSize: 10, color: '#8a9fb3', lineHeight: 1.5, padding: '2px 0 4px' }}>
                  {t('ship.panel.refitTo')} <b style={{ color: '#d8e4ee' }}>{active.name}</b>.
                  {' '}{t('ship.panel.refitCosts')} <b style={{ color: '#d8e4ee' }}>{feeStr}</b>{t('ship.panel.refitCharged')}
                  {/* WHERE, WHEN, or WHY NOT (refitStatus): "fits on
                      arrival at a friendly world" was all it ever said,
                      and players read the silence as nothing happening. */}
                  {pending && (() => {
                    const st = refitStatus(ship, gameState);
                    return (
                      <div
                        data-testid="refit-status"
                        style={{ color: st?.blocked ? '#ffb84d' : '#6ee7b7' }}
                      >
                        {t('ship.panel.orderedDash')} {st?.text ?? t('ship.panel.fitsOnArrival')}.
                      </div>
                    );
                  })()}
                  {pendingOther && (
                    <div style={{ color: '#6ee7b7' }}>
                      {t('ship.panel.pendingReplaced', { other: pendingOther.name, name: active.name })}
                    </div>
                  )}
                </div>
                <div className="maneuver-buttons">
                  <button
                    className="maneuver-btn"
                    disabled={refitBusy}
                    style={{ opacity: refitBusy ? 0.45 : 1 }}
                    title={site
                      ? t('ship.panel.retrofitOrderTip', { ship: ship.name, site: siteName ?? '', name: active.name })
                      : t('ship.panel.retrofitHereTip', { name: active.name })}
                    onClick={async () => {
                      if (refitBusy) return;
                      setRefitBusy(true);
                      const res = await mpActions.refitShip(ship.id, pending ? null : active.id);
                      // Only fly it somewhere if the order stuck AND it
                      // is not already parked where the work happens.
                      // Swapping one standing order for another keeps the
                      // flight it already has.
                      if (res.ok && !pending && !pendingOther && site) launchTorchTransfer(ship.id, site);
                      setRefitBusy(false);
                      if (!res.ok) setTransferError(humanizeMpError(res.code, res.error ?? t('ship.sd.refitFailed'), 'transfer'));
                    }}
                  >
                    {pending ? `✕ ${t('ship.panel.cancelRetrofit')}`
                      : site ? `⟳ ${t('ship.panel.retrofitAt', { name: siteName!.toUpperCase() })}`
                      : `⟳ ${t('ship.panel.retrofitHere')}`}
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
          {/* WHAT THIS CAPITAL HULL IS FOR, and why it cannot do it
              right now.

              Both mega hulls shipped with their capability reachable
              only under exactly the right conditions and invisible
              otherwise, so a player who had just spent twelve thousand
              metal selected the thing and found an ordinary ship panel.
              The Mega Destroyer's charge button needs a terraformed
              world underneath and no burn in progress; the foundry's
              build slots live on the BODY's menu and nothing on the
              ship said so. A capability you cannot find is one you did
              not build. */}
          {isOwn && isCapitalHull(ship.class) && (() => {
            const here = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);
            const foundry = ship.class === 'mobile_foundry';
            const slots = MEGASTRUCTURES.mobile_foundry.effect.buildSlots ?? 0;

            let line: string;
            if (ship.transit) {
              line = foundry
                ? t('ship.panel.foundryTransit', { slots })
                : t('ship.panel.gunTransit');
            } else if (foundry) {
              line = here
                ? t('ship.panel.foundryAt', { slots, name: here.name })
                : t('ship.panel.foundryAnywhere', { slots });
            } else if (here && here.terraformedAtTick != null) {
              line = t('ship.panel.inRange', { name: here.name });
            } else {
              line = here
                ? t('ship.panel.nothingStrike', { name: here.name })
                : t('ship.panel.parkToStrike');
            }

            return (
              <div className="capnote">
                <div className="capnote__head">
                  {foundry ? '⬢ Mobile Foundry' : '✹ Mega Destroyer'}
                </div>
                <div className="capnote__body">{line}</div>
                {foundry && here && !ship.transit && (
                  <button
                    className="maneuver-btn"
                    onClick={() => setShipTab('yard')}
                    title={t('ship.panel.layDownTip', { name: here.name })}
                  >
                    ⚒ {t('ship.panel.openYard')}
                  </button>
                )}
              </div>
            );
          })()}

          {/* GATE TRANSIT. Offered on any hull parked on a finished,
              wired gate — including gates somebody else built and paid
              for, which is the standing risk of owning one. */}
          {isOwn && mpActions && (() => {
            const site = gameState.megastructures?.[ship.orbit.parentBodyId];
            if (!site || site.kind !== 'warp_gate' || site.status !== 'complete') return null;
            if (!site.partnerBodyId) return null;
            const far = gameState.bodies.find(b => b.id === site.partnerBodyId);
            if (!far) return null;
            // A SUN GATE goes to a SYSTEM, and both of its far ends are
            // called "Sol Gate", so it is labelled by where the far end
            // is: the far system's name (its barycenter, less the word),
            // or Sol coming home.
            const sunGate = site.transitFraction != null;
            const farParent = gameState.bodies.find(b => b.id === far.parent);
            const dest = !sunGate ? far.name
              : !farParent || !farParent.parent ? 'Sol'
                : farParent.name.replace(/\s*Barycenter$/i, '');
            const share = sunGate ? t('ship.panel.aTenth') : t('ship.panel.aQuarter');
            return (
              <div style={{ marginTop: 6 }}>
                <button
                  className="maneuver-btn"
                  disabled={gateBusy || !!ship.transit}
                  onClick={() => {
                    setGateBusy(true);
                    mpActions.gateTransit(ship.id).then(() => setGateBusy(false));
                  }}
                  title={ship.transit
                    ? t('ship.panel.midBurn')
                    : t('ship.panel.gateLaunchTip', { dest, share })}
                >
                  ◎ {t('ship.panel.launchTo', { dest: dest.toUpperCase() })}
                </button>
              </div>
            );
          })()}
          {/* MEGA DESTROYER STRIKE. Offered over any world: a living one
              is sterilised, a raw one destroyed. Not over a star, a
              structure or a debris field, where it could do nothing --
              showing it and refusing on click teaches the rule the
              expensive way. */}
          {isOwn && mpActions && ship.class === 'mega_destroyer' && !ship.transit && (() => {
            const world = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);

            // ALREADY CHARGING. Shown before the fire button, because the
            // only thing that matters once a strike is armed is how long
            // is left and how to stop it.
            if (ship.strikeReadyTick != null) {
              const left = Math.max(0, ship.strikeReadyTick - gameState.currentTick);
              const tgt = gameState.bodies.find(b => b.id === ship.strikeTargetBodyId);
              const pct = Math.max(0, Math.min(1,
                1 - left / MEGA_STRIKE_CHARGE_TICKS));
              return (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 11, color: '#ff5e5e', marginBottom: 4 }}>
                    ✹ {ship.strikeMode === 'obliterate' ? t('ship.panel.destroying') : t('ship.panel.chargingCaps')} — {t(left === 1 ? 'ship.panel.targetInOne' : 'ship.panel.targetInMany', { name: tgt?.name ?? t('ship.panel.target'), n: left })}
                  </div>
                  <div style={{
                    height: 5, background: 'rgba(255,255,255,0.08)',
                    borderRadius: 3, overflow: 'hidden', marginBottom: 6,
                  }}>
                    <div style={{
                      width: `${(pct * 100).toFixed(1)}%`, height: '100%',
                      background: '#ff5e5e',
                    }} />
                  </div>
                  <button
                    className="maneuver-btn"
                    disabled={gateBusy}
                    onClick={() => {
                      setGateBusy(true);
                      mpActions.megaStrike(ship.id, false, true).then(() => setGateBusy(false));
                    }}
                    title={t('ship.panel.standDownTip')}
                  >
                    {t('ship.panel.standDown')}
                  </button>
                </div>
              );
            }

            // TWO STRIKES (0141). A living world is sterilised; a raw one --
            // never terraformed, or already stripped -- is destroyed
            // outright and left as a debris field. The server decides the
            // same way; this only has to say which one the button fires.
            if (!world) return null;
            if (world.type === 'star' || world.type === 'black_hole'
              || NON_WORLD_TYPES.has(world.type)) return null;
            if (world.obliteratedAtTick != null) {
              return (
                <div style={{ fontSize: 10, color: '#8fa6ba', marginTop: 6, lineHeight: 1.4 }}>
                  {t('ship.panel.alreadyDebris', { name: world.name })}
                </div>
              );
            }
            const obliterate = world.terraformedAtTick == null;
            const mine = world.ownedBy === 'player';
            return (
              <div style={{ marginTop: 6 }}>
                <button
                  className="maneuver-btn"
                  disabled={gateBusy}
                  style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
                  onClick={() => {
                    // Striking your OWN world is a real tactic and a
                    // catastrophic misclick, so it asks. A rival's does
                    // not — you flew a world-killer there on purpose.
                    if (mine && !window.confirm(obliterate
                      ? t('ship.panel.confirmDestroy', { name: world.name, n: `${MEGA_STRIKE_CHARGE_TICKS}` })
                      : t('ship.panel.confirmStrip', { name: world.name, n: `${MEGA_STRIKE_CHARGE_TICKS}` }))) return;
                    setGateBusy(true);
                    mpActions.megaStrike(ship.id, mine).then(() => setGateBusy(false));
                  }}
                  title={obliterate
                    ? t('ship.panel.chargeDestroyTip', { n: `${MEGA_STRIKE_CHARGE_TICKS}`, name: world.name })
                    : t('ship.panel.chargeStripTip', { n: `${MEGA_STRIKE_CHARGE_TICKS}`, name: world.name })}
                >
                  {obliterate
                    ? <>✹ {t('ship.panel.chargeToDestroy', { name: world.name.toUpperCase() })}</>
                    : <>✹ {t('ship.panel.chargeStrike', { name: world.name.toUpperCase() })}</>}
                </button>
                <div style={{ fontSize: 10, color: '#8fa6ba', marginTop: 3, lineHeight: 1.4 }}>
                  {t('ship.panel.ticksToFire', { n: `${MEGA_STRIKE_CHARGE_TICKS}` })}{' '}
                  {t('ship.panel.movingBreaks')}
                </div>
              </div>
            );
          })()}
          {/* A colony hull fitted with a Construction Module founds
              megastructures instead of settlements — the same bargain as
              DEPLOY below (the ship is spent), so it belongs beside it
              rather than in the cargo tab, which a colony hull never
              shows. */}
          {isOwn && ship.class === 'colony' && mpActions
            && !(ship.parts ?? []).includes('construction') && <MegastructureModuleHint />}
          {isOwn && ship.class === 'colony' && mpActions
            && (ship.parts ?? []).includes('construction') && (() => {
              const anchor = gameState.bodies.find(b => b.id === ship.orbit.parentBodyId);
              if (!anchor) return null;
              return (
                <MegastructurePicker
                  shipId={ship.id}
                  anchorBodyId={anchor.id}
                  anchorSoi={anchor.soi ?? 0}
                  onBegin={(kind, variant) => beginPlacement({
                    shipId: ship.id,
                    kind,
                    variant,
                    anchorBodyId: anchor.id,
                    anchorSoi: anchor.soi ?? 0,
                  })}
                />
              );
            })()}
          {isOwn && ship.class === 'colony' && mpActions && (
            <div style={{ marginTop: 6 }}>
              {deployTypes.length > 0 ? (
                <div className="maneuver-buttons">
                  {deployTypes.map(dt => (
                    <button
                      key={dt}
                      className="maneuver-btn"
                      disabled={deployBusy}
                      onClick={() => deploySettlementHere(dt)}
                      title={dt === 'city'
                        ? t('ship.panel.foundCityTip', { body: colonyBody?.name ?? '', ship: ship.name })
                        : t('ship.panel.foundStationTip', { body: colonyBody?.name ?? '', ship: ship.name })}
                    >
                      ▲ {dt === 'city' ? t('ship.panel.deployCity') : t('ship.panel.deployStation')}
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#5f7488', lineHeight: 1.4 }}>
                  {ship.transit
                    ? t('ship.panel.deployParked')
                    : !colonyBody
                      ? t('ship.panel.deployOrbit')
                      : cityHere && stationHere
                        ? t('ship.panel.fullySettled', { name: colonyBody.name })
                        : cityLock && !canDeployCity
                          ? `🔒 ${cityLock.label} — ${cityLock.text}`
                          : t('ship.panel.nothingToFound', { name: colonyBody.name })}
                </div>
              )}
            </div>
          )}
          {deployNotice && (
            <div style={{ fontSize: 10, color: '#8aa0b4', margin: '4px 0 0', lineHeight: 1.4 }}>
              {deployNotice}
            </div>
          )}

          {/* SETTLE ON ARRIVAL. Offered on any own colony hull, in flight
              or parked: the whole point is to set it BEFORE the ship
              lands, and a hull about to be sent somewhere is exactly when
              you know you want a station there. Parked hulls keep the
              button above -- this is the version that survives the night.

              Wears the STANCE row's clothes rather than a raw checkbox:
              it is the same kind of thing, a standing order with two
              settings, and the browser's default box read as a form
              control that had wandered into a console. */}
          {isOwn && ship.class === 'colony' && mpActions && (
            <div className="orders-config-row" style={{ marginTop: 6 }}>
              <span className="orders-config-label">{t('ship.panel.onArrival')}</span>
              <div className="orders-stance-toggle">
                {([null, 'station'] as const).map(v => (
                  <button
                    key={v ?? 'wait'}
                    className={`orders-stance-btn ${(ship.deployOnArrival ?? null) === v ? 'active' : ''}`}
                    disabled={settleBusy}
                    title={v
                      ? t('ship.panel.foundOnArrivalTip')
                      : t('ship.panel.waitTip')}
                    onClick={() => void setSettleOrder(v)}
                  >
                    {v ? t('ship.panel.foundStation') : t('ship.panel.wait')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Maneuver nodes + COMMIT ride with the move buttons: you pick a
              destination, then confirm the burn. Splitting those across a
              scroll meant staging a move and losing sight of the button
              that actually launches it. */}
          <div className="maneuver-section" data-tutorial-id="ship-maneuver-section">
            <div className="section-title">{t('ship.panel.maneuverNodes')}</div>
            {ship.orders.length === 0 && !ship.transit && !ship.plannedTransit && queuedTransits.length === 0 ? (
              <div className="no-orders">{t('ship.panel.noManeuvers')}</div>
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
                                ⇌ {t('ship.panel.matchName', { name: (mate?.name ?? t('ship.panel.contactCaps')).toUpperCase() })}
                              </div>
                              <div className="order-details">
                                {t('ship.panel.meetThenTogether', { n: meetIn.toFixed(0), name: targetBody?.name ?? plan.targetBodyId })}
                              </div>
                              <div className="order-details" style={{ color: '#6ee7b7' }}>
                                {t('ship.panel.etaDv', { eta: Math.max(0, plan.arriveTick - gameState.currentTick).toFixed(0), dv: plan.totalDv.toFixed(2) })}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId}</div>
                              <div className="order-details">
                                {t('ship.panel.etaDv', { eta: Math.max(0, plan.arriveTick - gameState.currentTick).toFixed(0), dv: plan.totalDv.toFixed(2) })}
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
                                ⇌ {t('ship.panel.matchNamePlanned', { name: (gameState.ships.find(x => x.id === ship.plannedRendezvous!.followShipId)?.name
                                  ?? t('ship.panel.contactCaps')).toUpperCase() })}
                              </div>
                              <div className="order-details">
                                {t('ship.panel.meetThenTogether', { n: Math.max(0, ship.plannedRendezvous.meetTick - gameState.currentTick).toFixed(0), name: targetBody?.name ?? plan.targetBodyId })}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="order-type">→ {targetBody?.name ?? plan.targetBodyId} ({t('ship.panel.planned')})</div>
                              <div className="order-details">
                                {t('ship.panel.dvTrip', { dv: plan.totalDv.toFixed(2), n: tripTime.toFixed(0) })}
                              </div>
                            </>
                          )}
                        </div>
                        <div className="order-actions">
                          <button
                            className="delete-btn"
                            onClick={() => cancelTorchPreview(ship.id)}
                            title={t('ship.panel.cancelTransfer')}
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
                          title={t('ship.panel.cancelManeuver')}
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
                            {t('ship.panel.queuedLine', { dv: qt.totalDv.toFixed(2), tick: qt.arriveTick.toFixed(0) })}
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
            {canRecall && (
              <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }}>
                {recallButton}
              </div>
            )}
            {burnFired && (
              <div style={{
                margin: '6px 0', fontSize: 10, lineHeight: 1.4,
                color: '#7c8b99', fontStyle: 'italic', textAlign: 'center',
              }}>
                {t('ship.panel.burnFired')}
              </div>
            )}
            <button
              className="commit-all-btn"
              data-tutorial-id="ship-commit-button"
              disabled={!canCommit}
              title={canCommit
                ? t('ship.panel.launchPlanned')
                : t('ship.panel.nothingStaged')}
              onClick={commitStagedPlan}
            >
              {commitLabel}
            </button>
          </div>
          {mpActions && ship.ownedBy === 'player' && (
            <div className="orders-config-section">
              {/* WHOSE ORDERS THESE ARE, first and on its own line.
                  Every control below commands the whole squadron, so the
                  scope belongs at the top of the section rather than
                  tucked after the word ORDERS where it read as a
                  footnote. */}
              {currentFleet && (
                <div
                  className="orders-fleetbar"
                  title={t('ship.panel.fleetOrdersTip', { n: fleetMembers.length, name: currentFleet.name })}
                >
                  <span className="orders-fleetbar__flag" aria-hidden>&#9873;</span>
                  <span className="orders-fleetbar__name">{currentFleet.name}</span>
                  <span className="orders-fleetbar__count">{tn('fleet.ships', fleetMembers.length)}</span>
                </div>
              )}
              <div className="section-title">
                {currentFleet ? t('ship.panel.fleetOrders') : t('ship.panel.tab.orders')}
              </div>
              {/* SAY THE SCOPE. The server now applies any order on a
                  fleet member to the whole fleet, which is what a fleet
                  means — but an order that quietly touches four hulls
                  when you were looking at one is the same invisible
                  surprise as the old behaviour, pointing the other way.
                  So the panel says so before you click. */}

              <div className="orders-config-row">
                <span className="orders-config-label">{t('ship.panel.stance')}</span>
                <div className="orders-stance-toggle">
                  {(['attack', 'defensive', 'hold'] as const).map(st => (
                    <button
                      key={st}
                      className={`orders-stance-btn ${currentStance === st ? 'active' : ''}`}
                      onClick={() => applyOrders({ stance: st })}
                      title={
                        st === 'attack' ? t('ship.panel.stanceAttackTip')
                        : st === 'defensive' ? t('ship.panel.stanceDefTip')
                        : t('ship.panel.stanceHoldTip')
                      }
                    >
                      {st === 'attack' ? t('ship.panel.attack') : st === 'defensive' ? t('ship.panel.defend') : t('ship.panel.hold')}
                    </button>
                  ))}
                </div>
              </div>

              {/* WHY THIS HULL IS OR ISN'T SHOOTING, next to the control
                  that decides it. This readout already existed on the SHIP
                  tab, which is not where anyone is standing when they ask
                  the question -- they are here, looking at STANCE, having
                  just set it to ATTACK and watched nothing happen. Same
                  component, so the two tabs cannot disagree. */}
              <CurrentTargetRow ship={ship} />

              <div className="orders-config-row">
                <span className="orders-config-label">{t('ship.panel.retreatAt')}</span>
                <select
                  className="orders-config-select"
                  value={ship.retreatHpPct ?? ''}
                  onChange={e => applyOrders({
                    retreatHpPct: e.target.value
                      ? (Number(e.target.value) as 25 | 50 | 75)
                      : null,
                  })}
                >
                  <option value="">{t('ship.panel.off')}</option>
                  <option value="25">25% HP</option>
                  <option value="50">50% HP</option>
                  <option value="75">75% HP</option>
                </select>
              </div>
              {/* WHERE IT RUNS TO. Default is the yard that built the hull
                  (migration 0126); the list is every living station of
                  yours, yards first, because a plain station is shelter
                  but not a dry dock. "" = home. The server resolves
                  chosen -> home -> nearest, each only while a station of
                  yours still stands there, so this can never point a hull
                  at nowhere. Sits under RETREAT AT because that is the
                  question it answers: "and then where?" */}
              {(() => {
                const ports = gameState.settlements
                  .filter(st => st.type === 'station' && st.hp > 0 && st.ownedBy === ship.ownedBy)
                  .map(st => ({
                    bodyId: st.bodyId,
                    name: gameState.bodies.find(b => b.id === st.bodyId)?.name ?? st.bodyId,
                    yard: (st.buildings?.shipyard ?? 0) >= 1,
                  }))
                  .filter((p, i, arr) => arr.findIndex(q => q.bodyId === p.bodyId) === i)
                  .sort((a, b) => Number(b.yard) - Number(a.yard) || a.name.localeCompare(b.name));
                const homeName = ship.homeBodyId
                  ? gameState.bodies.find(b => b.id === ship.homeBodyId)?.name ?? null
                  : null;
                const homeStands = !!ship.homeBodyId && ports.some(p => p.bodyId === ship.homeBodyId);
                // "No station" rather than "gone": a capital can have a
                // city and never a port, and the hull's home is still
                // that world — it just has nowhere there to dock.
                const defaultLabel = homeStands
                  ? t('ship.panel.homeYard', { name: homeName ?? '' })
                  : homeName
                    ? t('ship.panel.nearestYardNoHome', { name: homeName })
                    : t('ship.panel.nearestYard');
                return (
                  <div className="orders-config-row">
                    <span className="orders-config-label">{t('ship.panel.retreatTo')}</span>
                    <select
                      className="orders-config-select"
                      value={ship.retreatBodyId ?? ''}
                      onChange={e => applyOrders({ retreatBodyId: e.target.value || null })}
                      title={t('ship.panel.retreatToTip')}
                    >
                      <option value="">{defaultLabel}</option>
                      {ports.map(p => (
                        <option key={p.bodyId} value={p.bodyId}>
                          {p.name}{p.yard ? ` · ${t('ship.panel.yardWord')}` : ` · ${t('ship.panel.stationNoRepairs')}`}
                          {p.bodyId === ship.homeBodyId ? ` · ${t('ship.panel.homeWord')}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              <div className="orders-config-hint">
                {t('ship.panel.retreatHint')}
                {' '}
                {/* A setting that silently stops applying is worse than one
                    never offered. Transit combat means a hull can now be
                    shot while flying, and a committed torch burn cannot be
                    re-aimed — so retreat genuinely does nothing out there,
                    and the player is owed that BEFORE they watch a ship set
                    to run at 25% die at 0%. See DESIGN-transit-combat.md. */}
                <strong style={{ color: '#ffb84d' }}>
                  {t('fleet.retreatTip2')}
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
                // Same port the auto-retreat would pick, restricted to
                // yards because this is a repair run (preferredYardBodyId).
                const dest = preferredYardBodyId(
                  ship, gameState.settlements, gameState.bodies, gameState.currentTick,
                );
                const destBody = dest ? gameState.bodies.find(b => b.id === dest) : null;
                const why = dest && dest === ship.retreatBodyId ? t('ship.panel.whyChosen')
                  : dest && dest === ship.homeBodyId ? t('ship.panel.whyHome')
                  : t('ship.panel.whyNearest');
                return (
                  <div className="orders-config-row">
                    <span className="orders-config-label">{t('ship.panel.repair')}</span>
                    <button
                      className="orders-stance-btn"
                      disabled={!dest}
                      title={dest
                        ? t('ship.panel.repairTip', { name: destBody?.name ?? dest, why })
                        : t('ship.panel.noYardAnywhere')}
                      onClick={() => {
                        if (!dest) return;
                        const plan = launchTorchTransfer(ship.id, dest);
                        // "check fuel" named a resource that no longer
                        // exists — a dead end for anyone who read it.
                        if (!plan) { setTransferError(t('ship.panel.transferFailed')); return; }
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
                      ⛨ {t('ship.panel.sendYard')}{destBody ? ` (${destBody.name.toUpperCase()})` : ''}
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
                    <span className="orders-config-label">{t('ship.panel.autoDetonate')}</span>
                    <select
                      className="orders-config-select"
                      value={ship.detonateHpPct ?? ''}
                      onChange={e => applyOrders({
                        detonateHpPct: e.target.value
                          ? (Number(e.target.value) as 25 | 50)
                          : null,
                      })}
                    >
                      <option value="">{t('ship.panel.off')}</option>
                      <option value="25">25% HP</option>
                      <option value="50">50% HP</option>
                    </select>
                  </div>
                  <div className="orders-config-hint orders-config-hint--danger">
                    {t('ship.panel.detonateHint', { pct: ship.detonateHpPct ?? 'X' })}
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
                  SP's frozen sim doesn't read the column.

                  ARMED HULLS ONLY. A stock freighter or colony ship deals
                  no damage and never picks a target, so ranking what it
                  should shoot first was a control that could not do
                  anything. Keyed on isArmed rather than the class name
                  because the designer can arm a freighter or strip a
                  warship — what matters is whether this hull fires, not
                  what it is called. */}
              {mpActions && ship.ownedBy === 'player' && isArmed(ship) && (
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
                  CHAIN ORDERS — the ship's plan as an ordered tape.
                  (Named PROGRAM while it was built; the CSS prefix is
                  still .prog__, which is churn not worth a rename.)
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
                title={programOpen ? t('ship.panel.hidePlan') : t('ship.panel.showPlan')}
              >
                <span style={{ transform: programOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>&#9656;</span>
                {t('grp.chain')}
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
                  {/* A bordered box to say NOTHING IS HERE is a box
                      earning nothing. Empty gets one muted line. */}
                  {programSteps.length === 0 ? (
                    <div className="prog__idle">{t('ship.panel.awaiting')}</div>
                  ) : (
                    <div className="prog__readout">
                      <span className="prog__k">{t('ship.panel.step1Of', { n: programSteps.length })}</span>
                      <span className="prog__v">{programSteps[0].label.toUpperCase()}</span>
                      <span className="prog__why">{programSteps[0].meta}</span>
                    </div>
                  )}

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
                              ? <><span className="prog__guard">{t('ship.panel.wait')}</span> {st.label.replace('Wait ', '')}</>
                              : st.intercepts
                                ? <><span className="prog__guard">{t('ship.panel.intercept')}</span> <em>{st.intercepts}</em></>
                                : st.waitBefore
                                  ? <>{t('ship.panel.waitThen', { n: st.waitBefore })} <em>{st.dest}</em></>
                                  : <>{t('ship.panel.goToCaps')} <em>{st.dest}</em></>}
                          </span>
                          {st.committed
                            ? <span className="prog__lock" title={t('ship.panel.committedTip')}>&#9670; {t('ship.panel.committed')}</span>
                            : <span className="prog__meta">{st.meta}</span>}
                          {/* REMOVE. A staged plan you cannot unstage is a
                              trap: the only way out was to click away and
                              hope, which cleared the primary preview and
                              left the chained legs behind. A committed
                              burn has no ✕ — that is the transit rule,
                              not an omission. */}
                          {!st.committed && (
                            <button
                              type="button"
                              className="prog__stepX"
                              title={st.queueIndex == null
                                ? t('ship.panel.dropStep')
                                : t('ship.panel.dropStepChain')}
                              onClick={() => removeStep(st.queueIndex)}
                            >&#10005;</button>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  {/* ON ARRIVAL, offered on the row it governs. Only
                      once there IS an arrival: with an empty plan this
                      modifies nothing, and a control that cannot act
                      should not be drawn. */}
                  {programSteps.length > 0 && !ship.arrivalAction && (
                    <div className="prog__onarr">
                      <button
                        type="button"
                        className="prog__onarrB"
                        onClick={() => applyOrders({ arrivalAction: 'arrive_defensive', arrivalGuard: 'hostile_in_orbit' })}
                        title={t('ship.panel.defendArrivalTip')}
                      >{t('ship.panel.defendArrival')}</button>
                      {countPart(ship.parts, 'detonator') > 0 && (
                        <button
                          type="button"
                          className="prog__onarrB prog__onarrB--hot"
                          onClick={() => applyOrders({ arrivalAction: 'detonate', arrivalGuard: 'hostile_in_orbit' })}
                          title={t('ship.panel.detonateArrivalTip')}
                        >{t('ship.panel.detonateArrival')}</button>
                      )}
                      {/* A settle order attaches to the END of the plan,
                          not to the next landing: the server holds it
                          back while any leg is still to fly. So it reads
                          as the last line of the tape however long the
                          tape gets. */}
                      {isOwn && ship.class === 'colony' && mpActions
                        && ship.deployOnArrival !== 'station' && (
                        <button
                          type="button"
                          className="prog__onarrB"
                          disabled={settleBusy}
                          onClick={() => void setSettleOrder('station')}
                          title={t('ship.panel.foundEndTip')}
                        >{t('ship.panel.foundEnd')}</button>
                      )}
                    </div>
                  )}
                  {ship.arrivalAction && ship.arrivalAction !== 'detonate' && (
                    <div className="prog__final prog__final--calm">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {ship.arrivalGuard === 'hostile_in_orbit'
                          ? <><span className="prog__guard">{t('ship.panel.if')}</span> {t('ship.panel.hostileStance')} <em>{ship.arrivalAction === 'arrive_hold' ? t('ship.panel.hold') : t('ship.panel.defensiveCaps')}</em> {t('ship.panel.onArrivalLower')}</>
                          : <>{t('ship.panel.stance')} <em>{ship.arrivalAction === 'arrive_hold' ? t('ship.panel.hold') : t('ship.panel.defensiveCaps')}</em> {t('ship.panel.onArrivalLower')}</>}
                      </span>
                      <button
                        type="button"
                        className="prog__clearX"
                        title={t('ship.panel.clearStanceTip')}
                        onClick={() => applyOrders({ arrivalAction: null, arrivalGuard: null })}
                      >&#10005;</button>
                    </div>
                  )}
                  {ship.deployOnArrival === 'station' && (
                    <div className="prog__final prog__final--calm">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {t('ship.panel.foundOnArrivalCaps')} &mdash; <em>{t('ship.panel.hullSpent')}</em>
                      </span>
                      <button
                        type="button"
                        className="prog__clearX"
                        disabled={settleBusy}
                        title={t('ship.panel.clearParkTip')}
                        onClick={() => void setSettleOrder(null)}
                      >&#10005;</button>
                    </div>
                  )}
                  {!!ship.detonateOnHostile && (
                    <div className="prog__final">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        <span className="prog__guard">{t('ship.panel.when')}</span>{' '}
                        {ship.detonateMineMode === 'no_friendly'
                          ? t('ship.panel.noFriendlyLeft')
                          : ship.detonateMineMode === 'hostile_no_friendly'
                            ? t('ship.panel.hostileNoFriend')
                            : t('ship.panel.hostileEnters')} &rarr; {t('ship.panel.detonateCaps')}
                      </span>
                      <button
                        type="button"
                        className="prog__clearX prog__clearX--hot"
                        title={t('ship.panel.stopWatching')}
                        onClick={() => applyOrders({ detonateOnHostile: false, detonateMineMode: null })}
                      >&#10005;</button>
                    </div>
                  )}
                  {!!ship.detonateAtTick && (
                    <div className="prog__final">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {ship.detonateAtGuard === 'hostile_in_orbit'
                          ? <><span className="prog__guard">{t('ship.panel.if')}</span> {t('ship.panel.hostileDetonate')} <em>{t('ship.panel.atTick', { n: ship.detonateAtTick })}</em></>
                          : <>{t('ship.panel.detonateCaps')} <em>{t('ship.panel.atTick', { n: ship.detonateAtTick })}</em></>}
                      </span>
                      <button
                        type="button"
                        className="prog__clearX prog__clearX--hot"
                        title={t('ship.panel.disarmTimer')}
                        onClick={() => applyOrders({ detonateAtTick: null, detonateAtGuard: null })}
                      >&#10005;</button>
                    </div>
                  )}
                  {ship.arrivalAction === 'detonate' && (
                    <div className="prog__final">
                      <span className="prog__n">&#9670;</span>
                      <span className="prog__b">
                        {ship.arrivalGuard === 'hostile_in_orbit'
                          ? <><span className="prog__guard">{t('ship.panel.if')}</span> {t('ship.panel.hostileDetonate')} <em>{t('ship.panel.onArrivalLower')}</em></>
                          : <>{t('ship.panel.detonateCaps')} <em>{t('ship.panel.onArrivalLower')}</em></>}
                      </span>
                      <button
                        type="button"
                        className="prog__clearX prog__clearX--hot"
                        title={t('ship.panel.disarmArrive')}
                        onClick={() => applyOrders({ arrivalAction: null, arrivalGuard: null })}
                      >&#10005;</button>
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
                  {/* ADD A LEG. One verb, because there is one verb:
                      this opens the SAME TransferTargetPicker the MOVE
                      control uses, and the picker now carries DEPART, so
                      "wait then go" is one choice rather than an armed
                      mode you could not see.

                      ON ARRIVAL is not a peer of this button -- it is a
                      property of the LAST step -- so it is offered from
                      the row above, next to the arrival it governs. */}
                  <div className="prog__add">
                    <button
                      type="button"
                      className="maneuver-btn prog__addB"
                      onClick={() => setTransferModalOpen(true)}
                      title={programSteps.length > 0
                        ? t('ship.panel.addLegTip')
                        : t('ship.panel.sendSomewhereTip')}
                    >
                      {programSteps.length > 0 ? t('ship.panel.addLeg') : t('ship.panel.sendSomewhere')}
                    </button>
                    {/* INTERCEPT. Offered only when something is
                        actually catchable from the end of this chain --
                        an empty list means every hull in flight parks
                        before this one comes free, and the honest step
                        then is a plain leg to where they landed. */}
                    <button
                      type="button"
                      className={`maneuver-btn${chainInterceptOpen ? ' prog__set' : ''}`}
                      onClick={() => setChainInterceptOpen(o => !o)}
                      title={t('ship.panel.chainInterceptTip')}
                    >{t('ship.panel.intercept')}</button>
                    {/* SCHEDULED DEMOLITION. Only on a hull that carries
                        a charge -- the same gate DETONATE ON ARRIVAL and
                        the AUTO-DETONATE row use, because a control that
                        cannot fire should not be drawn. */}
                    {countPart(ship.parts, 'detonator') > 0 && (
                      <button
                        type="button"
                        className={`maneuver-btn${(ship.detonateAtTick || ship.detonateOnHostile) ? ' prog__armed' : ''}`}
                        onClick={() => setDemoOpen(o => !o)}
                        title={t('ship.panel.demoTip')}
                      >{ship.detonateOnHostile
                        ? `◆ ${t('ship.panel.mined')}`
                        : ship.detonateAtTick ? `◆ ${t('ship.panel.demoAt', { n: ship.detonateAtTick })}` : t('ship.panel.demolition')}</button>
                    )}
                    {/* COMMIT keeps a fixed place beside ADD LEG rather
                        than appearing and shifting the row under the
                        cursor. Disabled when there is nothing staged. */}
                    {canCommit && (
                      <button
                        type="button"
                        className="commit-all-btn prog__commitB"
                        title={t('ship.panel.sendPlanTip')}
                        onClick={commitStagedPlan}
                      >
                        {commitLabel}
                      </button>
                    )}
                  </div>
                  {demoOpen && countPart(ship.parts, 'detonator') > 0 && (
                    <div className="prog__demo">
                      <span className="prog__iceptNone">{t('ship.panel.detonateIn')}</span>
                      {[3, 6, 12, 24, 48].map(n => (
                        <button
                          key={n}
                          type="button"
                          className="prog__iceptB"
                          onClick={() => {
                            // Offsets in the UI, an ABSOLUTE tick on the
                            // wire: the player thinks "in six hours", the
                            // server needs something that survives a
                            // restart and is a comparison, not a
                            // countdown it could double-decrement.
                            applyOrders({
                              detonateAtTick: gameState.currentTick + n,
                              detonateAtGuard: null,
                            });
                            setDemoOpen(false);
                          }}
                          title={t('ship.panel.blowAt', { n: gameState.currentTick + n })}
                        >+{n}t</button>
                      ))}
                      <button
                        type="button"
                        className="prog__iceptB"
                        onClick={() => {
                          applyOrders({
                            detonateAtTick: gameState.currentTick + 6,
                            detonateAtGuard: 'hostile_in_orbit',
                          });
                          setDemoOpen(false);
                        }}
                        title={t('ship.panel.blowIfTip')}
                      >{t('ship.panel.blowIf')}</button>
                      {/* PROXIMITY MINE. A standing watch rather than a
                          moment, so these are toggles: the charge
                          survives every quiet tick and clears only by
                          firing or by being switched off here.

                          Three conditions, because the blast does not
                          pick sides -- it damages every hull in the
                          orbit. WHEN ALONE and the combined form exist
                          so the charge can wait until it would only
                          cost the enemy. */}
                      <span className="prog__mineK">{t('ship.panel.mineFire')}</span>
                      {([
                        ['hostile', t('ship.panel.mineHostile'), t('ship.panel.mineHostileTip')],
                        ['hostile_no_friendly', t('ship.panel.mineNoFriends'), t('ship.panel.mineNoFriendsTip')],
                        ['no_friendly', t('ship.panel.mineAlone'), t('ship.panel.mineAloneTip')],
                      ] as const).map(([mode, label, tip]) => {
                        const on = !!ship.detonateOnHostile && (ship.detonateMineMode ?? 'hostile') === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            className={`prog__iceptB${on ? ' is-armed' : ''}`}
                            onClick={() => {
                              applyOrders(on
                                ? { detonateOnHostile: false, detonateMineMode: null }
                                : { detonateOnHostile: true, detonateMineMode: mode });
                              setDemoOpen(false);
                            }}
                            title={on ? t('ship.panel.disarmMine') : tip}
                          >{on ? `◆ ${label}` : label}</button>
                        );
                      })}
                      {(ship.detonateAtTick || ship.detonateOnHostile) && (
                        <button
                          type="button"
                          className="prog__iceptB"
                          onClick={() => {
                            applyOrders({
                              detonateAtTick: null, detonateAtGuard: null,
                              detonateOnHostile: false, detonateMineMode: null,
                            });
                            setDemoOpen(false);
                          }}
                        >{t('ship.panel.disarmAll')}</button>
                      )}
                    </div>
                  )}
                  {chainInterceptOpen && (
                    <div className="prog__icept">
                      {chainInterceptCandidates.length === 0 ? (
                        <span className="prog__iceptNone">
                          {t('ship.panel.nothingCatchable')}
                        </span>
                      ) : chainInterceptCandidates.map(c => (
                        <button
                          key={c.id}
                          type="button"
                          className={`prog__iceptRow${c.mine ? ' is-mine' : ''}`}
                          // The owner's livery on the rail, not the whole
                          // card: a filled row in a rival's colour fights
                          // the panel and makes the ship name harder to
                          // read, which is the one thing you are scanning
                          // for.
                          style={{ borderLeftColor: c.c1 }}
                          onClick={() => {
                            // THE WHOLE FLEET CATCHES IT. Each hull
                            // solves its own intercept from its own
                            // position — a shared target, not a shared
                            // trajectory — so a slower mate still gets
                            // the best window it can reach.
                            const crew = orderedHulls();
                            const legs = crew.map(m => ({
                              m, leg: enqueueIntercept(m.id, c.id, 0),
                            }));
                            setChainInterceptOpen(false);
                            const mine = legs.find(x => x.m.id === ship.id)?.leg ?? null;
                            const got = legs.filter(x => !!x.leg).length;
                            const matched = legs.filter(x => x.leg?.rv).length;
                            if (got === 0) {
                              setTransferError(
                                t('ship.panel.ivNoPlot', { name: c.name }),
                              );
                              return;
                            }
                            // Say what the FLEET got, not what this hull
                            // got: a mixed result where half the
                            // squadron matched and half is chasing the
                            // destination is exactly the thing you need
                            // told, and reporting only the open panel's
                            // hull would hide it.
                            setTransferError(
                              got < crew.length
                                ? t('ship.panel.ivPlotted', { got, total: crew.length, name: c.name })
                                : matched === crew.length
                                  ? null
                                  : matched === 0
                                    ? t('ship.panel.ivNoMatch', { name: c.name })
                                    : t('ship.panel.ivChasing', { matched, total: crew.length, name: c.name }),
                            );
                            void mine;
                          }}
                          title={t('ship.panel.iceptRowTip', { owner: c.ownerName, cls: c.shipClass, dest: c.dest, n: c.meetIn })}
                        >
                          <ShipIcon
                            shipClass={iconClassFor(c.shipClass)}
                            variant={c.iconVariant}
                            size={18}
                            color={c.c1}
                            color2={c.c2}
                          />
                          <span className="prog__iceptNm">{c.name}</span>
                          <span className="prog__iceptOwn" style={{ color: c.c1 }}>{c.ownerName}</span>
                          <span className="prog__iceptEta">{c.meetIn}t</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {canCommit && (
                    <div className="prog__commitNote">{t('ship.panel.stepsLocal')}</div>
                  )}

                  {/* STANDING RULES, stated rather than re-offered. The
                      controls live in ORDERS above; duplicating them here
                      would be two derivations of one setting, which is the
                      bug this codebase keeps paying for. This half of the
                      panel exists to say WHEN they apply -- always, including
                      during step 1 -- which the flat list above cannot. */}
                  <div className="prog__rules">
                    <div
                      className="prog__rulesHd"
                      title={t('ship.panel.rulesTip')}
                    >{t('ship.panel.rules')}</div>
                    <div className={`prog__rule${currentStance !== 'attack' ? ' is-on' : ''}`}>
                      {t('ship.panel.stance')} <em>{(currentStance ?? 'attack') === 'attack' ? t('ship.panel.attack') : currentStance === 'defensive' ? t('ship.panel.defensiveCaps') : t('ship.panel.hold')}</em>
                    </div>
                    <div className={`prog__rule${ship.retreatHpPct ? ' is-on' : ''}`}>
                      {t('ship.panel.retreatCaps')} <em>{ship.retreatHpPct ? `${ship.retreatHpPct}%` : t('ship.panel.off')}</em>
                      {ship.transit && ship.retreatHpPct
                        ? <span className="prog__note"> &mdash; {t('ship.panel.notWhileUnderWay')}</span>
                        : null}
                    </div>
                    {countPart(ship.parts, 'detonator') > 0 && (
                      <div className={`prog__rule${ship.detonateHpPct ? ' is-armed' : ''}`}>
                        {t('ship.panel.detonateCaps')} <em>{ship.detonateHpPct ? `${ship.detonateHpPct}%` : t('ship.panel.off')}</em>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {ordersError && (
                <button
                  onClick={() => setOrdersError(null)}
                  className="orders-config-error"
                  title={t('ship.sd.dismiss')}
                >⚠ {ordersError}</button>
              )}
            </div>
          )}
          </>)}
          {activeTab === 'ship' && (<>
          <div className="ship-stats" data-tutorial-id="ship-stats">
            <div className="stat-row">
              <span className="label">{t('ship.panel.classLabel')}</span>
              <span
                className="value"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                title={configName ? `${configName} · ${ship.class.toUpperCase()}` : undefined}
              >
                <span style={{ color: '#4ecdc4', display: 'inline-flex', flexShrink: 0 }}>
                  <HullIcon shipClass={ship.class} variant={ship.iconVariant} size={16} parts={ship.parts} />
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
              <span className="label">{t('ship.panel.owner')}</span>
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
                        ({t('ship.panel.you')})
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
                      t('ship.panel.repairingAt', { rate: maintenance.repairRate, n: Math.ceil((maxHp - currentHp) / maintenance.repairRate) }),
                      // Name whichever source is actually paying. Crediting a
                      // shipyard when the work is being done by a tender in
                      // deep space sends the player home for no reason.
                      maintenance.tenderRepairing
                        ? t('ship.panel.tenderWorking', { n: REPAIR_PER_TICK_PER_TENDER_BAY })
                        : null,
                      maintenance.hasStation
                        ? t('ship.panel.biggerYard')
                        : null,
                    ].filter(Boolean).join(' ')}
                  >
                    +{maintenance.repairRate}/t
                    <span style={{ color: '#7a8a9a', marginLeft: 4 }}>
                      · {t('ship.panel.toFull', { n: Math.ceil((maxHp - currentHp) / maintenance.repairRate) })}
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
                     aria-valuemin={0} aria-valuemax={maxHp} aria-label={t('ship.panel.hullIntegrity')}>
                  <div className={`sp-hpbar__fill sp-hpbar__fill--${tier}`}
                       style={{ width: `${ratio * 100}%` }} />
                </div>
              );
            })()}
            {/* FUEL row removed — fuel left the economy
                (DESIGN-identity-economy.md §1.1). Transfers are free, so
                the number never moved and refuelling was decoration. */}
            <div className="stat-row">
              <span className="label">{t('ship.panel.location')}</span>
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
              title={t('ship.panel.speedTip')}
            >
              <span className="label">{t('ship.panel.speed')}</span>
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
              <span className="label">{t('ship.panel.status')}</span>
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
                <span className="label">{t('ship.panel.launchLabel')}</span>
                {recallButton}
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
              🔒 {t('ship.panel.loadoutUnknown')}{' '}
              <b style={{ color: '#ffb84d' }}>{requirementLabel('intel.loadouts')}</b> {t('ship.panel.toReadFittings')}
            </div>
          ) : (
            <ShipLoadoutSection
              parts={ship.parts}
              shipClass={iconClassFor(ship.class)}
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
                  if (!res.ok) setCaptainNotice(humanizeMpError(res.code, res.error ?? t('ship.panel.rejectedAssign'), 'orders'));
                });
              }}
              onBench={() => {
                if (!ship.captainId || !mpActions) return;
                setCaptainNotice(null);
                void mpActions.assignCaptain(ship.captainId, null).then(res => {
                  if (!res.ok) setCaptainNotice(humanizeMpError(res.code, res.error ?? t('ship.panel.rejectedChange'), 'orders'));
                });
              }}
              onRename={(name) => { if (ship.captainId && mpActions) mpActions.updateCaptain(ship.captainId, { name }); }}
              onBio={(bio) => { if (ship.captainId && mpActions) mpActions.updateCaptain(ship.captainId, { bio }); }}
              fleetName={currentFleet?.name ?? null}
              admiralName={admiral?.name ?? null}
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
            const destName = gameState.bodies.find(b => b.id === haul.destBodyId)?.name ?? t('ship.panel.theirWorld');
            const pickupName = gameState.bodies.find(b => b.id === haul.pickupBodyId)?.name ?? t('ship.panel.yourWorld');
            return (
              <div style={{
                margin: '8px 0', padding: '6px 8px',
                border: '1px solid #4ecdc4', borderRadius: 3,
                background: 'rgba(78, 205, 196, 0.08)',
                fontSize: 10, color: '#d8e4ee', lineHeight: 1.5,
              }}>
                <div style={{ color: '#4ecdc4', fontWeight: 700, letterSpacing: '0.08em' }}>
                  ⇢ {t('ship.panel.tradeShipment')}
                </div>
                {haul.loaded
                  ? <>{t('ship.panel.hauling')} <b>{manifest}</b> {t('ship.panel.haulTo')} <b>{destName}</b>{t('ship.panel.haulAboard')}</>
                  : <>{t('ship.panel.enRouteToWord')} <b>{pickupName}</b> {t('ship.panel.toLoadWord')} <b>{manifest}</b>.</>}
                {' '}{t('ship.panel.fliesItself')}
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
                    {t('ship.panel.raidable')}
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
                  d.metal   > 0 ? t('ship.panel.nMetal', { n: Math.round(d.metal) })     : null,
                  d.gold    > 0 ? t('ship.panel.nCredits', { n: Math.round(d.gold) })    : null,
                  d.science > 0 ? t('ship.panel.nScience', { n: Math.round(d.science) }) : null,
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
          {fleetSectionJsx('ship')}

          {/* The section renders for EVERY hull now. It used to be gated
              on damage, so an unarmed ship showed no combat box at all
              and a player asking "why isn't it shooting" found nothing
              in the panel to answer them. An unarmed hull gets the
              section with a single line saying it cannot shoot. */}
          {(() => {
            const armed = (ship.damagePerTick ?? shipClass.damagePerTick) > 0;
            return (
            <div className="engagement-section">
              <div className="section-title">{t('ship.panel.combat')}</div>
              {armed && (<>
              <div className="stat-row">
                <span className="label">{t('ship.panel.damage')}</span>
                {/* Server-authoritative damage when present (weapon parts +
                    Weapons tech, stamped at build).
                    COMBAT V2 dropped the CADENCE row: every hull now fires
                    every tick, so the line said the same thing on every ship
                    and carried no information. "/tick" replaces "/volley" so
                    the rate stays legible without it. */}
                <span className="value">{ship.damagePerTick ?? shipClass.damagePerTick}/{t('fleet.tick')}</span>
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
                    ? t('ship.panel.firesPriority')
                    : t('ship.panel.firesAny'))
                  : currentStance === 'defensive'
                    ? t('ship.panel.returnsFire')
                    : t('ship.panel.holdingFire')}
              </div>
              {/* Who this hull is actually shooting, resolved from the
                  server's stamped engagement. The priority cards say what
                  it WOULD pick; this says what it DID. */}
              </>)}
              <CurrentTargetRow ship={ship} />
            </div>
            );
          })()}

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

      {/* DESKTOP: the intercept picker pops out beside the panel. */}
      {rvOpenNow && !isMobile && rvPopAt && createPortal(
        <InterceptPicker
          variant="popout"
          {...rvPickerShared}
          title={t('ship.rv.title', { name: ship.name })}
          onClose={closeIntercept}
          style={{ left: rvPopAt.left, top: rvPopAt.top }}
        />,
        document.body,
      )}

      {transferModalOpen && (
        <TransferTargetPicker
          bodies={gameState.bodies}
          tick={gameState.currentTick}
          excludeBodyId={ship.orbit.parentBodyId}
          title={hasExistingTransfer ? t('ship.panel.chainMoveTo') : t('ship.panel.moveToTargetTitle')}
          onPick={(id, wait) => handleTransferManeuver(id, wait ?? 0)}
          allowDepartDelay
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
  /** Called with the chosen body and, when the depart row is shown, the
   *  number of ticks to hold before the burn fires. */
  onPick: (bodyId: string, waitTicks?: number) => void;
  onClose: () => void;
  /** Show the DEPART row. Off by default: the build menu reuses this
   *  picker to pick a destination for a hull that does not exist yet,
   *  and "leave in 6 ticks" is meaningless there. */
  allowDepartDelay?: boolean;
  /** The game's tick, so a sun gate still in flight can be left out (its
   *  landing site is offered instead). Omitted: nothing is filtered. */
  tick?: number;
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
  bodies, excludeBodyId, title, onPick, onClose, allowDepartDelay = false, tick,
}) => {
  const { lang: pickerLang } = useI18n();
  const [query, setQuery] = useState('');
  // WAIT IS AN ADVERB ON A LEG, not an action of its own. It used to be
  // its own button that ARMED a hidden mode: you picked a number, the
  // panel looked unchanged, and the next GO TO silently spent it. A
  // mode with no visible mode. Choosing it here makes it one flow --
  // "go to Pluto, leaving in 6 ticks" -- and there is no state to strand.
  const [departIn, setDepartIn] = useState(0);
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
      // A sun gate's landing site is the one 'lagrange' point you CAN
      // fly to: that is what it is for (worker/sunGates.js).
      if (b.type === 'lagrange' && !isSunGateSite(b)) return false;
      // ...and the gate itself only once it has landed: the server
      // refuses a leg to a gate still in flight (gate_in_flight).
      if (tick != null && isGateInFlight(b, tick)) return false;
      if (!q) return true;
      const parentName = b.parent ? bodies.find(x => x.id === b.parent)?.name.toLowerCase() ?? '' : '';
      return b.name.toLowerCase().includes(q) || parentName.includes(q);
    });
  }, [bodies, excludeBodyId, query, tick]);

  // Built once per body list, not per body: makeSystemRootOf computes
  // belt clustering up front and memoizes the parent walk internally.
  const rootOf = useMemo(() => makeSystemRootOf(bodies), [bodies]);

  const groups = useMemo(() => {
    const byId = new Map(bodies.map(b => [b.id, b]));
    void pickerLang;   // group labels are translated: recompute on a language flip
    const map = new Map<string, { label: string; order: number; farSystem?: boolean; bodies: import('../types').Body[] }>();
    for (const b of visible) {
      const g = pickerGroupOf(b, rootOf);
      if (!map.has(g.key)) {
        // Far systems keep their hand-written names; everything else is
        // named by systemLabel, which already knows that a bare rock is
        // "Midas" and only a body with satellites earns "… System".
        const label = g.key === 'centauri' ? t('ship.panel.centauriSystem')
          : g.key === 'cygnus' ? t('ship.panel.cygnusSystem')
          : systemLabel(bodies, g.key);
        map.set(g.key, { label, order: 0, farSystem: g.farSystem, bodies: [] });
      }
      map.get(g.key)!.bodies.push(b);
    }
    // LONE ROCKS SHARE A GROUP. A meteoroid (MTR-12) or a structure site
    // orbiting nothing but the sun is its own "system", so the list grew
    // a one-item heading per rock ("MTR-14 · 1", "MTR-12 · 1", … — QA
    // battle test). They fold into one group of their kind instead.
    for (const [key, v] of [...map.entries()]) {
      const only = v.bodies.length === 1 ? v.bodies[0] : null;
      if (!only || v.farSystem || only.id !== key) continue;
      const kind = only.type === 'meteoroid' ? { k: '__meteoroids', label: t('ship.panel.meteoroids') }
        : only.type === 'megastructure' ? { k: '__structures', label: t('ship.panel.structureSites') }
        : null;
      if (!kind) continue;
      map.delete(key);
      if (!map.has(kind.k)) map.set(kind.k, { label: kind.label, order: 0, bodies: [] });
      map.get(kind.k)!.bodies.push(only);
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
  }, [visible, bodies, rootOf, pickerLang]);

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
          <button className="modal-close" onClick={onClose} aria-label={t('ship.sd.close')}>✕</button>
        </div>
        <div className="modal-body" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
          {allowDepartDelay && (
            <div className="tp-depart">
              <span className="tp-depart__k">{t('ship.panel.depart')}</span>
              {[0, 1, 3, 6, 12, 24].map(n => (
                <button
                  key={n}
                  type="button"
                  className={`tp-depart__b${departIn === n ? ' is-on' : ''}`}
                  onClick={() => setDepartIn(n)}
                  title={n === 0
                    ? t('ship.panel.burnNowTip')
                    : tn('ship.panel.sitStill', n)}
                >{n === 0 ? t('ship.panel.now') : `+${n}t`}</button>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder={t('ship.panel.searchBodies')}
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
                {t('ship.panel.noBodies', { q: query })}
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
                      title={isOpen ? t('ship.panel.hideFar') : t('ship.panel.showFar')}
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
                          onClick={() => onPick(body.id, departIn)}
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
  useI18n();
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
          <h3>{mode === 'form' ? t('ship.panel.formFleetTitle') : t('ship.panel.addToFleet', { name: fleetName ?? t('fleet.title') })}</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          {peers.length === 0 ? (
            <div className="no-orders">{t('ship.panel.noEligible')}</div>
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
              {mode === 'form' ? t('ship.panel.formFleetBtn') : t('ship.panel.add')}
            </button>
            <button className="maneuver-btn" onClick={onCancel}>
              {t('ship.panel.cancel')}
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
  useI18n();
  return (
    <div className="combat-record-section" style={{ marginTop: 10 }}>
      <div
        className="section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
      >
        <span>{t('ship.panel.tradeLog')}</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {tradesCompleted > 0
            ? tn('ship.panel.routesCompleted', tradesCompleted)
            : t('ship.panel.noDeliveries')}
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
  /** The fleet this hull serves in, if any, and its admiral. A member
   *  has no captain BY DESIGN — saying "no officer aboard" to a ship
   *  under an admiral's command is both wrong and discouraging. */
  fleetName?: string | null;
  admiralName?: string | null;
}> = ({ ship, captain, editable, bank, onAssign, onBench, onRename, onBio, onAvatar, fleetName, admiralName }) => {
  useI18n();
  const [editingName, setEditingName] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const rank = ship.rank ?? 0;
  const traits = ship.captainTraits ?? captain?.traits ?? [];
  const avatarId = ship.captainAvatar ?? captain?.avatarId ?? null;
  const name = ship.captainName ?? captain?.name ?? t('ship.panel.unknown');

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
        <div className="section-title"><span>{t('ship.panel.captainCaps')}</span></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0 2px' }}>
          <div style={{ opacity: 0.35, flexShrink: 0 }}>
            <CaptainAvatar avatarId={null} size={CAPTAIN_PORTRAIT_PX} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#8aa0b4', marginBottom: 4 }}>
              {fleetName
                ? <>{t('ship.panel.servingUnder')} {admiralName ? <b>{admiralName}</b> : t('ship.panel.theAdmiral')} {t('ship.panel.inFleetNote', { fleet: fleetName })}</>
                : <>{t('ship.panel.noOfficer')}</>}
            </div>
            {editable && (
              bank.length > 0 ? (
                <select
                  value=""
                  style={selectStyle}
                  onChange={(e) => { if (e.target.value) onAssign(e.target.value); }}
                  title={t('ship.panel.postCaptainTip')}
                >
                  <option value="">{t('ship.panel.postCaptain')}</option>
                  {bank.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.rank > 0 ? ` · ${c.rank} ⚔` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 10, color: '#5f7488' }}>
                  {t('ship.panel.bankEmpty')}
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
        <span>{t('ship.panel.captainCaps')}</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {rankTierLabel(rank)}{rank > 0 ? ` · ${rank} ⚔` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0 2px' }}>
        <button
          onClick={() => {
            if (!editable) return;
            onAvatar(rerollAvatarId(avatarId));
          }}
          disabled={!editable}
          title={editable ? t('fleet.changePortrait') : undefined}
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
                  title={t('ship.panel.renameCaptain')}
                  style={{ background: 'transparent', border: 'none', color: '#5f7488', cursor: 'pointer', fontSize: 10 }}
                >✎</button>
              )}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#9fe8e2', margin: '3px 0' }}>
            {traitSummary(traits) || t('fleet.noTraits')}
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
              title={editable ? t('ship.panel.writeBioTip') : undefined}
              style={{
                fontSize: 10, color: captain?.bio ? '#8aa0b4' : '#5f7488',
                fontStyle: captain?.bio ? 'italic' : 'normal',
                cursor: editable ? 'pointer' : 'default', lineHeight: 1.4,
              }}
            >
              {captain?.bio || (editable ? t('ship.panel.writeBio') : '')}
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
              title={t('ship.panel.swapTip')}
            >
              <option value="">{t('fleet.reassign')}</option>
              <option value="__bench">{t('fleet.toBank')}</option>
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
                    title={traitSummary(c.traits) || t('fleet.noTraits')}
                  >
                    {t('ship.panel.swapIn', { name: c.name })}{c.rank > 0 ? ` · ${c.rank} ⚔` : ''}
                    {brief ? ` — ${brief}` : ` — ${t('ship.panel.noTrait')}`}
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
/** Headline + explanation for every reason a hull holds its fire.
 *  The panel used to render NOTHING for a parked ship with no target,
 *  which is precisely the state a player writes in to ask about. */
function noTargetCopy(reason: string): { title: string; body: string } | null {
  switch (reason) {
    case 'unarmed': return { title: t('ship.panel.nt.unarmed.title'), body: t('ship.panel.nt.unarmed.body') };
    case 'hold': return { title: t('ship.panel.nt.hold.title'), body: t('ship.panel.nt.hold.body') };
    case 'at-peace': return { title: t('ship.panel.nt.peace.title'), body: t('ship.panel.nt.peace.body') };
    case 'defensive-no-aggressor': return { title: t('ship.panel.nt.defensive.title'), body: t('ship.panel.nt.defensive.body') };
    case 'none-present': return { title: t('ship.panel.nt.none.title'), body: t('ship.panel.nt.none.body') };
    default: return null;
  }
}

const NoTargetNote: React.FC<{ reason: string }> = ({ reason }) => {
  useI18n();
  const copy = noTargetCopy(reason);
  if (!copy) return null;
  return (
    <div className="sp-target sp-target--idle">
      <div className="sp-target__head"><span className="sp-target__title">{copy.title}</span></div>
      <div className="sp-target__foot">{copy.body}</div>
    </div>
  );
};

const CurrentTargetRow: React.FC<{ ship: Ship }> = ({ ship }) => {
  useI18n();
  const { gameState } = useGameContext();
  const baseDamage = ship.damagePerTick ?? getShipClass(ship.class as ShipClassName).damagePerTick;
  // An unarmed hull says so rather than showing an empty combat box.
  if (baseDamage <= 0) return <NoTargetNote reason="unarmed" />;

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
      warPairs: gameState.warPairs,
      damagePerTick: baseDamage,
      tick: gameState.currentTick,
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
    if (reason && reason !== 'in-transit') return <NoTargetNote reason={reason} />;
    if (reason === 'in-transit') {
      return (
        <div className="sp-target sp-target--idle">
          <div className="sp-target__head"><span className="sp-target__title">{t('ship.panel.nt.none.title')}</span></div>
          <div className="sp-target__foot">
            {/* This said transit hulls neither fire nor take fire, which
                stopped being true the moment transit combat shipped —
                and the panel kept saying it in games where the rule had
                changed underneath the player. */}
            {gameState.transitCombatEnabled
              ? t('ship.panel.underBurnCombat')
              : t('ship.panel.underBurnNoCombat')}
          </div>
        </div>
      );
    }
    // Reached only when the predictor gave no reason at all; say the
    // plain thing rather than rendering an empty box.
    return <NoTargetNote reason="none-present" />;
  }

  // Live multipliers. Only computable for OUR ships: a rival's tech,
  // upkeep ledger and captain roster are intel we don't hold, so their
  // card shows the stamped figure rather than a confident wrong number.
  const isMine = ship.ownedBy === 'player';
  const myFleet = isMine
    ? (gameState.fleets ?? []).find(f => f.shipIds.includes(ship.id))
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

  // Flak in the orbit slows BOTH halves of the roll — theirs on us, ours
  // (and any third party's at war with them) on the target. The server
  // folds it into speedOfShip for every gun, so odds quoted from the
  // hull's own speed were a number no hit roll actually used.
  const myFlak = enemyFlakOn(ship, gameState.ships, gameState.warPairs);
  const hullSpeed = combatSpeedOf(ship.class as ShipClassName, ship.parts);
  const mySpeed = hullSpeed * myFlak.mul;
  // A settlement is mechanically a destroyer that cannot move
  // (SETTLEMENT_SPEED in worker/factions.js), and flak does not touch it.
  const targetFlak = tShip
    ? enemyFlakOn(tShip, gameState.ships, gameState.warPairs)
    : { mounts: 0, mul: 1 };
  const targetHullSpeed = tShip
    ? combatSpeedOf(tShip.class as ShipClassName, tShip.parts)
    : SETTLEMENT_COMBAT_SPEED;
  const targetSpeed = targetHullSpeed * targetFlak.mul;
  const odds = hitChanceOf(mySpeed, targetSpeed);
  // Shows the work only when there is work to show; an orbit with no
  // flak keeps the plain sentence.
  const flakNote = (f: { mounts: number; mul: number }, whose: string) =>
    f.mounts > 0 ? ` (${whose ? t('ship.panel.flakEnemy', { mul: f.mul.toFixed(2), n: f.mounts }) : t('ship.panel.flakOwn', { mul: f.mul.toFixed(2), n: f.mounts })})` : '';
  const oddsTitle = t('ship.panel.oddsTip', {
    a: hullSpeed.toFixed(2), noteA: flakNote(myFlak, 'enemy '),
    b: targetHullSpeed.toFixed(2), noteB: flakNote(targetFlak, ''),
  });

  // Settlements carry no shield/armor parts, so bombardment lands in
  // full — matching the room.js bombardment branch.
  const profile = damageProfile(ship.parts);
  const mit = tShip
    ? Math.max(MITIGATION_FLOOR, defenseMitigation(tShip.parts, profile))
    : 1;
  const perHit = myDamage * mit;
  const perTick = perHit * odds;

  const name = tShip?.name ?? tStl?.name ?? t('ship.panel.unknown');
  const kindLabel = tShip
    ? getShipClass(tShip.class as ShipClassName).displayName.toUpperCase()
    : (tStl?.type === 'station' ? t('ship.panel.stationCaps') : t('ship.panel.cityCaps'));
  const targetHp = tShip?.hp ?? tStl?.hp ?? 0;
  // Ticks to kill at the expected rate — the "so what" of the numbers
  // above. Only shown when this hull alone could actually finish it.
  const ttk = perTick > 0 ? Math.ceil(targetHp / perTick) : Infinity;

  return (
    <div className={`sp-target${isPrediction ? ' sp-target--next' : ''}`}>
      <div className="sp-target__head">
        <span className="sp-target__title">
          {isPrediction ? t('ship.panel.nextTarget') : t('ship.panel.currentTarget')}
        </span>
        <span className="sp-target__kind">{kindLabel}</span>
      </div>
      <div className="sp-target__name">{name}</div>
      <div className="sp-target__grid">
        <span className="sp-target__k">{t('ship.panel.oddsToHit')}</span>
        <span className="sp-target__v" title={oddsTitle}>
          {Math.round(100 * odds)}%
        </span>
        <span className="sp-target__k">{t('ship.panel.perHit')}</span>
        <span className="sp-target__v" title={mit < 1
          ? t('ship.panel.perHitCut', { dmg: myDamage.toFixed(1), pct: Math.round(100 * mit) })
          : t('ship.panel.perHitFull')}>
          {perHit.toFixed(1)}
          {mit < 1 && <span className="sp-target__dim"> ({Math.round(100 * mit)}%)</span>}
        </span>
        <span className="sp-target__k">{t('ship.panel.expected')}</span>
        <span className="sp-target__v sp-target__v--hero" title={t('ship.panel.expectedTip')}>
          {perTick.toFixed(1)}<span className="sp-target__dim">/{t('fleet.tick')}</span>
        </span>
      </div>
      {/* Show the work: every live multiplier folded into the numbers
          above, so a player can see WHY their frigate is hitting for
          more than its stat line — and spot an arrears penalty they
          didn't know they were paying. */}
      {factors.length > 0 && (
        <div className="sp-target__bonus">
          <span className="sp-target__bonus-lead">
            {t('ship.panel.baseMul', { dmg: baseDamage.toFixed(1), mul: bonusMul.toFixed(2) })}
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
        {isPrediction && `${t('ship.panel.notFiredYet')} `}
        {Number.isFinite(ttk)
          ? tn('ship.panel.hpLeftAbout', ttk, { hp: Math.round(targetHp) })
          : t('ship.panel.hpLeft', { hp: Math.round(targetHp) })}
        {!isMine && ` ${t('ship.panel.rivalBonuses')}`}
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
  useI18n();
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
        title={kills > 0 ? t('ship.panel.toggleRecord') : undefined}
      >
        <span>{t('ship.panel.combatRecord')}</span>
        <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.06em' }}>
          {kills > 0 ? `${tn('ship.panel.kills', kills)} · ${expanded ? '▲' : '▼'}` : t('ship.panel.noKills')}
        </span>
      </div>
      {rank > 0 && (
        <div className="stat-row" style={{ marginTop: 4 }}>
          <span className="label">{t('ship.panel.veterancy')}</span>
          <span className="value" style={{ color: '#ffb84d' }}>
            {t('ship.panel.veterancyBonus', { dmg: dmgBonus, hp: hpBonus })}
          </span>
        </div>
      )}
      {/* The record belongs to the OFFICER. Without one, kills are still
          chronicled but bank no veterancy — say it here so an empty
          record on a ship that has clearly been fighting doesn't read
          as a bug. */}
      {!hasCaptain && (
        <div style={{ marginTop: 4, fontSize: 9, color: '#7a8a9a', fontStyle: 'italic' }}>
          {t('ship.panel.killsCredited')}
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
  useI18n();
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
        <span className="section-title">{t('ship.panel.configuration')}</span>
        <span className="ship-loadout__count">{t('ship.panel.slotsCount', { n: fitted.length, total: totalSlots })}</span>
      </div>

      <div className="ship-loadout__chips">
        {slots.map((p, i) => (
          p === null ? (
            <span key={i} className="ship-loadout__chip ship-loadout__chip--empty" title={t('ship.panel.emptySlot')}>·</span>
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
        <div className="ship-loadout__bare">{t('ship.panel.bareHull')}</div>
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
  useI18n();
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
        ☠ {t('ship.panel.detonatorHead', { n: nDet })}
      </div>
      <div style={{ fontSize: 10, color: '#ffb0b0', lineHeight: 1.5, margin: '4px 0 8px' }}>
        {disclosure}
      </div>
      {inTransit ? (
        <div style={{ fontSize: 10, color: '#b8c8d6', fontStyle: 'italic' }}>
          {t('ship.panel.cannotDetonate')}
        </div>
      ) : !confirming ? (
        <button
          className="maneuver-btn"
          style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
          onClick={() => setConfirming(true)}
          title={disclosure}
        >
          ☠ {t('ship.panel.detonateCaps')}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, color: '#ff5e5e', fontWeight: 700, lineHeight: 1.5 }}>
            {t('ship.panel.confirmColon')} {disclosure}
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
              {busy ? t('ship.panel.detonating') : `☠ ${t('ship.panel.confirmDetonation')}`}
            </button>
            <button
              className="maneuver-btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t('ship.panel.cancel')}
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
  useI18n();
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
    holdCargo.ore     > 0 ? t('ship.panel.nMetal', { n: Math.round(holdCargo.ore) })      : null,
    holdCargo.credits > 0 ? t('ship.panel.nCredits', { n: Math.round(holdCargo.credits) }): null,
    holdCargo.science > 0 ? t('ship.panel.nScience', { n: Math.round(holdCargo.science) }): null,
    holdCargo.fuel    > 0 ? t('ship.panel.nFuel', { n: Math.round(holdCargo.fuel) })      : null,
  ].filter(Boolean).join(' · ');
  // "Contracted" only greys the button when there is NOTHING of your
  // own aboard — your own cargo unloads fine alongside an agreement
  // leg's staging (the server splits the two pots the same way).
  const holdContracted = (contractedTotal >= 1 || !!contractedCargo) && holdTotal < 1;
  const holdInTransit = !!ship.transit;
  // Greyed with a REASON, not just greyed: empty, contracted and
  // mid-burn are three different answers to "why can't I press this".
  const unloadWhy =
    holdContracted ? t('ship.panel.unloadContracted')
    : holdTotal < 1  ? t('ship.panel.holdEmptyTip')
    : holdInTransit  ? t('ship.panel.unloadMidBurn')
    : t('ship.panel.unloadNow');
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
      <div className="section-title">{t('ship.panel.mining')}</div>
      {isMining ? (
        <div className="order-item" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          <div className="order-details" style={{ color: '#e8f4ff' }}>
            {t('ship.panel.workingRock', { name: rockHere.name, rate: MINE_RATE_PER_TICK })}
          </div>
          {/* The hold IS the progress bar: a mining run ends when this
              fills or the rock runs dry, so showing anything else would
              be a second number saying the same thing less usefully. */}
          <div className="order-details">
            {miningPending === true && holdTotal <= 0
              ? t('ship.panel.orderSent')
              : null}
          </div>
          <div className="mine-bar" aria-hidden="true">
            <div className="mine-bar__fill" style={{ width: `${Math.round(fillPct * 100)}%` }} />
          </div>
          <div className="order-details">
            {t('ship.panel.aboard', { n: Math.round(holdTotal), total: BASE_HOLD })} ·{' '}
            {ticksToStop <= 0
              ? t('ship.panel.stoppingNow')
              : holdRoom <= rockLeft ? tn('ship.panel.ticksUntilFull', ticksToStop) : tn('ship.panel.ticksUntilDry', ticksToStop)}
          </div>
          <button
            className="maneuver-btn"
            onClick={() => { setMiningPending(false); onSetMining(false); }}
          >
            ■ {t('ship.panel.stopMining')}
          </button>
        </div>
      ) : (
        <div className="order-item" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          <div className="order-details">
            {rockLeft <= 0
              ? t('ship.panel.workedOut', { name: rockHere.name })
              : t('ship.panel.rockLeft', { name: rockHere.name, n: Math.round(rockLeft), kind: rockHere.mineralKind === 'gold' ? t('ship.panel.creditsWord') : t('ship.panel.metalWord'), rate: MINE_RATE_PER_TICK })}
          </div>
          <button
            className="maneuver-btn"
            disabled={rockLeft <= 0 || holdRoom <= 0}
            title={holdRoom <= 0 ? t('ship.panel.holdFullTip') : undefined}
            onClick={() => { setMiningPending(true); onSetMining(true); }}
          >
            ⛏ {t('ship.panel.beginMining')}
          </button>
        </div>
      )}
    </div>
  );

  const holdBox = (
    <>
    {miningBox}
    <div className="maneuver-section">
      <div className="section-title">{t('ship.panel.hold')}</div>
      <div className="order-item" style={{ flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
        <div className="order-details" style={holdTotal > 0 || contractedTotal > 0 || contractedCargo ? { color: '#e8f4ff' } : undefined}>
          {holdTotal > 0 ? holdStr : (contractedTotal > 0 || contractedCargo) ? null : t('ship.panel.empty')}
          {(contractedTotal > 0 || contractedCargo) && (
            <div style={{ color: '#ffb84d' }}>
              {contractedRoute
                ? [
                    contractedRoute.ore     > 0 ? t('ship.panel.nMetal', { n: Math.round(contractedRoute.ore) })       : null,
                    contractedRoute.credits > 0 ? t('ship.panel.nCredits', { n: Math.round(contractedRoute.credits) }) : null,
                    contractedRoute.science > 0 ? t('ship.panel.nScience', { n: Math.round(contractedRoute.science) }) : null,
                    contractedRoute.fuel    > 0 ? t('ship.panel.nFuel', { n: Math.round(contractedRoute.fuel) })       : null,
                  ].filter(Boolean).join(' · ')
                : contractedCargo}
              {` · ${t('ship.panel.underContract')}`}
            </div>
          )}
        </div>
        {holdTotal > 0 && (
          <div className="order-details" style={{ color: '#8fa3b5' }}>
            {t('ship.panel.staysAboard')}
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
            ⬇ {t('ship.panel.deliverPool')}
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
    const kindLabel = route.kind === 'terraform' ? `◌ ${t('ship.panel.terraformSupply')}`
      : route.kind === 'dyson' ? `☀ ${t('ship.panel.dysonSupply')}`
      : isMiningRun ? `⛏ ${t('ship.panel.miningRun')}`
      : t('ship.panel.tradeRoute');

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
      nextAction = t('ship.panel.underWayTo', { name: to?.name ?? t('ship.panel.destinationWord'), n: Math.round(eta) });
    } else if (here === route.destBodyId && cargoTotal > 0) {
      nextAction = t('ship.panel.unloadingAt', { name: dest?.name ?? t('ship.panel.destinationWord') });
    } else if (here && mineBodyIds.has(here)) {
      // Parked ON the rock. This is the leg that takes several ticks and
      // cannot be interrupted, so say the rate rather than "next tick" —
      // "next tick" implies it is about to leave.
      const rock = bodies.find(b => b.id === here);
      const rockLeftHere = Math.max(0, rock?.mineralRemaining ?? 0);
      // How much is left is the fact that decides whether to keep this
      // rock on the itinerary, so it belongs on the line that says the
      // hull is working it.
      nextAction = t('ship.panel.workingRockDot', { name: rock?.name ?? t('ship.panel.theRock'), rate: MINE_RATE_PER_TICK })
        + (rockLeftHere > 0 ? ` · ${t('ship.panel.nLeft', { n: Math.round(rockLeftHere) })}` : ` · ${t('ship.panel.workedOutShort')}`);
    } else if (here === route.originBodyId && cargoTotal < 1) {
      nextAction = isMiningRun
        ? t('ship.panel.startingDig', { name: origin?.name ?? t('ship.panel.theRock') })
        : t('ship.panel.loadingAt', { name: origin?.name ?? t('ship.panel.originWord') });
    } else {
      nextAction = t('ship.panel.departingFor', { name: wantsBody?.name ?? t('ship.panel.nextStop') });
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
              {route.status === 'outbound' ? `→ ${t('ship.panel.delivering')}`
                : route.status === 'returning' ? (isMiningRun ? `← ${t('ship.panel.outToRock')}` : `← ${t('ship.panel.pickingUp')}`)
                : t('ship.panel.paused')}
              {/* "empty hold" sat directly under a HOLD box reading
                  "200 metal" and flatly contradicted it: this counts the
                  ROUTE's staged cargo, while the box above counts that
                  PLUS whatever the hull carries of its own (a manual
                  mining load, say). When the route has staged nothing
                  but the hull is not empty, say nothing here rather than
                  call a full hold empty. */}
              {cargoTotal > 0
                ? ` · ${t('ship.panel.cargoStr', { cargo: cargoStr })}`
                : holdTotal > 0 ? ` · ${t('ship.panel.nothingStaged2')}` : ` · ${t('ship.panel.emptyHold')}`}
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
            title={t('ship.panel.cancelRouteTip')}
          >
            ✕ {t('ship.panel.cancelRoute')}
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
        <div className="section-title">{t('ship.panel.newRoute')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0' }}>
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            {t('ship.panel.destRouteKind')}
          </label>
          {!anyDest ? (
            <div style={{ fontSize: 10, color: '#ff5e5e' }}>
              {t('ship.panel.noDests')}
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
              <option value="">{t('ship.panel.pickDest')}</option>
              {rawDests.length > 0 && (
                <optgroup label={t('ship.panel.optTerraform')}>
                  {rawDests.map(b => (
                    <option key={b.id} value={b.id}>
                      ◌ {b.name} ({Math.round(b.terraformAcc?.metal ?? 0)}M · {Math.round(b.terraformAcc?.credits ?? 0)}C {t('ship.panel.delivered')})
                    </option>
                  ))}
                </optgroup>
              )}
              {logisticsDests.length > 0 && (
                <optgroup label={t('ship.panel.optLogistics')}>
                  {logisticsDests.map(b => (
                    <option key={b.id} value={b.id}>● {b.name}</option>
                  ))}
                </optgroup>
              )}
              {canSupplyDyson && (
                <optgroup label={t('ship.panel.optMegaproject')}>
                  <option value="sol">☀ {t('ship.panel.dysonSol')}</option>
                </optgroup>
              )}
            </select>
          )}
          {destKind === 'terraform' && destId && (
            <div style={{ fontSize: 10, color: '#8aa0b4', lineHeight: 1.5 }}>
              {t('ship.panel.terraformHint')}
            </div>
          )}
          {destKind === 'dyson' && destId && (
            <div style={{ fontSize: 10, color: '#8aa0b4', lineHeight: 1.5 }}>
              {t('ship.panel.dysonHint')}
            </div>
          )}
          <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.08em' }}>
            {t('ship.panel.origin')} {destKind === 'logistics' ? `(${t('ship.panel.anySettlement')})` : `(${t('ship.panel.terraformedDock')})`}
          </label>
          <select
            value={originId}
            onChange={(e) => setOriginId(e.target.value)}
            style={{
              padding: '4px 6px', background: '#0a1018', border: '1px solid #2a3d50',
              color: '#d8e4ee', fontFamily: 'inherit', fontSize: 11, borderRadius: 3,
            }}
          >
            <option value="">{t('ship.panel.pickOrigin')}</option>
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
              ▶ {t('ship.panel.openRoute')}
            </button>
            <button
              className="maneuver-btn"
              onClick={() => { setPicking(false); setOriginId(''); setDestId(''); }}
            >
              {t('ship.panel.cancel')}
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
      <div className="section-title">{t('ship.panel.tradeRoute')}</div>
      <button
        className="maneuver-btn"
        onClick={() => setPicking(true)}
        style={{ marginTop: 4 }}
        title={t('ship.panel.openRouteTip')}
        disabled={!anyDest}
      >
        + {t('ship.panel.tradeRoute')}
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
          title={t('ship.panel.multiStopTip')}
          disabled={!anyDest}
        >
          + {t('ship.panel.multiStop')}
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
          {t('ship.panel.claimRaw')}
        </div>
      )}
    </div>
    </>
  );
};
