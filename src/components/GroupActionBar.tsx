// ============================================================
// GroupActionBar
//
// The selected group's control surface, floating over the map so the
// common actions ("everyone go there", "everyone hold fire") are
// reachable without opening the Fleet panel. The panel's own action bar
// still works — both read the same shared selection
// (uiState.selectedShipIds) — this is the version you get while your
// eyes are already on the map.
//
// TWO SHAPES, ONE SET OF ACTIONS.
//
// On a desktop it is the shift-click group's bar: shift-clicking a WORLD
// is the move gesture; MapCanvas fires 'orbital:group-move' for it and
// this component owns the transfer.
//
// On a phone it is the contextual action bar of TOUCH SELECTION MODE --
// the Android pattern: the count, the batch commands, and Done. A phone
// has no shift key, so MapCanvas instead raises 'orbital:select-world'
// when a world is tapped in selection mode, and this bar asks what to do
// with it: take your ships that are there, or send the group there. It
// asks rather than acts because a stray tap while collecting ships must
// never launch a fleet.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { useBulkTransfer } from '../hooks/useBulkTransfer';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { apiFetch } from '../multiplayer/api';
import { isArmed } from '../game/systemGrouping';
import { getShipClass, ShipClassName } from '../game/shipClasses';
import type { TargetPriorityKey } from '../types';
import { TargetPriorityCards } from './TargetPriorityCards';
import { ChainOrderEditor } from './ChainOrderEditor';
import { GroupIntercept } from './GroupIntercept';
import { useBulkChain } from '../hooks/useBulkChain';
import { useIsMobile } from '../hooks/useIsMobile';
import type { ChainStep } from '../physics/chainPlanner';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './GroupActionBar.css';

type Stance = 'attack' | 'defensive' | 'hold';

const STANCE_IDS: Stance[] = ['attack', 'defensive', 'hold'];

export const GroupActionBar: React.FC = () => {
  useI18n();
  const {
    gameState, uiState, clearShipSelection, setShipSelection,
    setSelectMode, setGroupListOpen,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  const bulkTransfer = useBulkTransfer();
  const isMobile = useIsMobile();
  // The bar's layout follows the LAYOUT (useIsMobile), nothing else.
  // It used to add `|| isCoarsePointer()`, and some desktop browsers
  // report a coarse pointer with a mouse in hand (Lorne's does): the
  // phone bar went full width across the outliner and its hints talked
  // about tapping, on a desktop. A real tablet already gets the mobile
  // layout from useIsMobile, which is the one system touch UI follows.
  const touch = isMobile;
  const [notice, setNotice] = useState<string | null>(null);
  const [dest, setDest] = useState('');
  // Target-priority flyout. Group members may carry different priorities,
  // so the cards open on the shared DEFAULT ladder — the first drop
  // overwrites the whole group with one order (same immediate-apply model
  // as the stance buttons).
  const [showTargeting, setShowTargeting] = useState(false);
  // CHAIN ORDERS for the group. The itinerary is shared; each hull
  // solves it from its OWN orbit, so this is a route, not a plan.
  const [showChain, setShowChain] = useState(false);
  const [chain, setChain] = useState<ChainStep[]>([]);
  const bulkChain = useBulkChain();
  // INTERCEPT for the group: the ship panel's picker, solved from one
  // parked hull, ordered per hull (GroupIntercept).
  const [showIntercept, setShowIntercept] = useState(false);
  // Touch layout: the order rows fold away behind two toggles, because a
  // phone-width bar holding every button at once covers a third of the map.
  const [showSend, setShowSend] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  // The world last tapped in selection mode, waiting on a choice.
  const [worldPrompt, setWorldPrompt] = useState<string | null>(null);
  // Which full-screen panel is open, if any. On a phone a panel covers the
  // map entirely, and a bar floating over it would cover the panel's own
  // controls instead.
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  // Set when THIS bar grew the group, so the reset below does not wipe
  // the "Added 25 ships" it has just written about that very change.
  const ownChangeRef = useRef(false);

  const ids = useMemo(() => uiState.selectedShipIds ?? [], [uiState.selectedShipIds]);
  const selectMode = !!uiState.selectMode;

  // Ships can die or be sold out from under a stale selection, so resolve
  // against live state rather than trusting the id list's length. Indexed,
  // not scanned: a scan per id is selected x fleet on every 1.5s poll,
  // which on a megafleet is the panel-jank GroupSelectionPanel already
  // learned about the hard way.
  const ships = useMemo(() => {
    const byId = new Map(gameState.ships.map(s => [s.id, s]));
    return ids.map(id => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  }, [ids, gameState.ships]);

  // A move needs a hull that isn't already committed to a burn — same
  // eligibility rule the Fleet panel's bulk transfer uses.
  const movable = ships.filter(s => !s.transit && !s.plannedTransit);
  // Hulls already flying a route the server knows: an order for them is
  // a LEG ON THE END of that route (useBulkChain appends), not a new
  // burn. Counting only `movable` greyed SEND out on any group that was
  // all in flight (reported on mobile, 2026-10-05). A hull with only an
  // uncommitted local preview (plannedTransit, no transit) is in neither
  // list: its route waits on that ship's own COMMIT.
  const underWay = ships.filter(s => !!s.transit);
  const routable = [...movable, ...underWay];

  // FORM FLEET from the selection. The server's rules, mirrored here so
  // the button is only drawn when it can actually succeed:
  //   - at least two hulls, all mine
  //   - a flagship that HAS a captain (members surrender theirs on
  //     joining, so the flag's is the fleet's only officer)
  // Ships already in another fleet are allowed: the create endpoint
  // silently pulls them out of it, which is the behaviour you want when
  // you have just box-selected a new formation.
  const mine = useMemo(() => ships.filter(s => s.ownedBy === 'player'), [ships]);
  // WHO CAN ACTUALLY SHOOT. Target priority is doctrine for picking a
  // victim, so it means nothing on a hull that never fires — a stock
  // freighter or colony ship. Keyed on isArmed rather than the class
  // name because the designer can arm a freighter or strip a warship.
  const gunners = ships.filter(isArmed);
  const flagCandidate = mine.find(s => !!s.captainName || !!s.captainId) ?? null;
  const canFormFleet = mine.length >= 2;
  // Only a parked hull can set off to meet anyone; one in flight keeps
  // the course it is on.
  const interceptors = mine.filter(s => !s.transit).length;

  // SAME CLASS. Every ship of yours of any class already in the group,
  // for "all my destroyers" without finding each one. Nothing did this on
  // any device before.
  const sameClass = useMemo(() => {
    const classes = new Set(mine.map(s => s.class));
    const have = new Set(ids);
    return gameState.ships.filter(s =>
      s.ownedBy === 'player' && classes.has(s.class) && !have.has(s.id));
  }, [mine, ids, gameState.ships]);
  const classLabel = useMemo(() => {
    const classes = Array.from(new Set(mine.map(s => s.class)));
    if (classes.length !== 1) return t('grp.sameClasses');
    return t('grp.allOfClass', { name: getShipClass(classes[0] as ShipClassName).displayName.toUpperCase() });
  }, [mine]);

  // Destination list for the picker — every body, alphabetical, matching
  // the Fleet panel's transfer dropdown so the two read the same. Own
  // worlds carry a ★ because "where do I already hold ground" is the
  // question you're usually answering when you move a group.
  const destinations = useMemo(
    () => [...gameState.bodies]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(b => ({ id: b.id, label: `${b.ownedBy === 'player' ? '★ ' : ''}${b.name}` })),
    [gameState.bodies],
  );

  const groupMove = useCallback((bodyId: string) => {
    const body = gameState.bodies.find(b => b.id === bodyId);
    const targets = movable.map(s => s.id);
    const flying = underWay.map(s => s.id);
    if (targets.length === 0 && flying.length === 0) {
      setNotice(t('grp.noBurn'));
      return;
    }
    const res = targets.length > 0
      ? bulkTransfer(targets, bodyId, (msg, soFar, total) => {
          setNotice(t('grp.rejected', { soFar, total, msg }));
        })
      : { issued: 0, unplannable: 0 };
    // A one-leg chain is exactly a SEND, and the chain path is the one
    // that knows how to put a leg on the end of a route in flight.
    const after = flying.length > 0
      ? bulkChain(flying, [{ bodyId, wait: 0 }], (msg) => setNotice(msg))
      : { issued: 0, unplannable: 0, truncated: 0 };
    const issued = res.issued + after.issued;
    const unplannable = res.unplannable + after.unplannable;
    if (issued === 0) {
      setNotice(t('grp.noPlan'));
    } else {
      setNotice(
        t('grp.bound', { ships: tn('grp.ships', issued), target: body?.name ?? t('grp.target') })
        + (after.issued > 0 && res.issued > 0 ? ` · ${t('grp.afterLegN', { n: after.issued })}` : '')
        + (after.issued > 0 && res.issued === 0 ? ` ${t('grp.afterLeg')}` : '')
        + (unplannable > 0 ? ` · ${t('grp.couldnt', { n: unplannable })}` : ''),
      );
      // Reset the picker so the same destination can't be re-fired by a
      // stray second click on SEND after the group has already launched.
      setDest('');
      setShowSend(false);
    }
  }, [bulkTransfer, bulkChain, gameState.bodies, movable, underWay]);

  const done = useCallback(() => {
    clearShipSelection();
    setSelectMode(false);
    setWorldPrompt(null);
  }, [clearShipSelection, setSelectMode]);

  // MapCanvas raises this when you shift-click a world with a live group.
  useEffect(() => {
    const onMove = (e: Event) => {
      const bodyId = (e as CustomEvent).detail?.bodyId;
      if (typeof bodyId === 'string') groupMove(bodyId);
    };
    window.addEventListener('orbital:group-move', onMove as EventListener);
    return () => window.removeEventListener('orbital:group-move', onMove as EventListener);
  }, [groupMove]);

  // ...and this when you TAP a world in touch selection mode.
  useEffect(() => {
    const onWorld = (e: Event) => {
      const bodyId = (e as CustomEvent).detail?.bodyId;
      if (typeof bodyId === 'string') setWorldPrompt(bodyId);
    };
    window.addEventListener('orbital:select-world', onWorld as EventListener);
    return () => window.removeEventListener('orbital:select-world', onWorld as EventListener);
  }, []);

  // The back button (AndroidBackHandler) ends selection the same way Done
  // does, and needs to know when there is anything to end.
  useEffect(() => {
    const onExit = () => done();
    window.addEventListener('orbital:exit-select', onExit);
    return () => window.removeEventListener('orbital:exit-select', onExit);
  }, [done]);
  const active = selectMode || ids.length > 0;
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('orbital:select-state', { detail: { active } }));
  }, [active]);

  useEffect(() => {
    const onPanel = (e: Event) => setOpenPanel((e as CustomEvent).detail?.panel ?? null);
    window.addEventListener('orbital:panel-state', onPanel as EventListener);
    return () => window.removeEventListener('orbital:panel-state', onPanel as EventListener);
  }, []);

  // Drop the notice whenever the group itself changes — a stale "3 ships
  // bound for Io" hanging over a different selection reads as this one's
  // result. The targeting flyout closes with it: it was scoped to the
  // old group.
  useEffect(() => {
    if (ownChangeRef.current) { ownChangeRef.current = false; return; }
    setNotice(null);
    setShowTargeting(false);
    // The chain goes with them. An itinerary written for one group and
    // silently applied to the next is the worst kind of bulk mistake:
    // it succeeds.
    setShowChain(false);
    setChain([]);
    setShowIntercept(false);
  }, [uiState.selectedShipIds]);
  // A world prompt belongs to the mode it was raised in.
  useEffect(() => { if (!selectMode) setWorldPrompt(null); }, [selectMode]);

  // What the targeting flyout shows: if EVERY ship in the group already
  // shares one custom order, start from it (so a tweak reads as a tweak);
  // otherwise the default ladder. Above the early return — hooks must run
  // on every render.
  const sharedPriority = useMemo(() => {
    const armed = ships.filter(isArmed);
    const first = armed[0]?.targetPriority ?? null;
    if (!first) return null;
    const key = JSON.stringify(first);
    return armed.every(s => JSON.stringify(s.targetPriority ?? null) === key) ? first : null;
  }, [ships]);

  // Escape clears the group, matching how the panels dismiss.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, done]);

  // Your parked ships at the prompted world, not already in the group.
  const promptBody = worldPrompt ? gameState.bodies.find(b => b.id === worldPrompt) ?? null : null;
  const shipsThere = useMemo(() => {
    if (!worldPrompt) return [];
    const have = new Set(ids);
    return gameState.ships.filter(s =>
      s.ownedBy === 'player' && !s.transit && s.orbit?.parentBodyId === worldPrompt && !have.has(s.id));
  }, [worldPrompt, ids, gameState.ships]);

  if (!active) return null;
  // On a phone a full-screen panel owns the screen; the group bar comes
  // back when it closes. So does the list sheet, which lists the group.
  if (isMobile && (openPanel || uiState.groupListOpen)) return null;

  const formFleet = async () => {
    if (!mpActions || mine.length < 2) return;
    if (!flagCandidate) {
      // The server would say this too, but only after a round trip and
      // in its own words. Saying it here keeps the reason next to the
      // button that could not act.
      setNotice(t('grp.noCaptain'));
      return;
    }
    const parent = gameState.bodies.find(b => b.id === flagCandidate.orbit?.parentBodyId);
    const res = await apiFetch(`/api/games/${mpActions.gameId}/fleets`, {
      method: 'POST',
      body: JSON.stringify({
        ship_ids: mine.map(s => s.id),
        flag_ship_id: flagCandidate.id,
        name: `${parent?.name ?? 'Task'} Group`,
      }),
    });
    setNotice(res.ok
      ? t('grp.fleetFormed', { n: mine.length, name: flagCandidate.captainName ?? flagCandidate.name })
      : (res.error?.message ?? t('grp.fleetFail')));
  };

  const setStance = (stance: Stance) => {
    if (!mpActions) return;
    const targets = ships.map(s => s.id);
    if (targets.length === 0) return;
    mpActions.setShipOrders({ shipIds: targets, stance }).then(res => {
      setNotice(res.ok
        ? t('grp.stanceSet', { ships: tn('grp.ships', targets.length), stance: t(`grp.stanceWord.${stance}` as const) })
        : humanizeMpError(res.code, res.error, 'orders'));
    });
  };

  const setTargeting = (priority: TargetPriorityKey[] | null) => {
    if (!mpActions) return;
    // Only the hulls it can mean anything for. Sending it to the whole
    // selection would report "priority set on 6 ships" when two of them
    // are freighters that will never read it.
    const targets = gunners.map(s => s.id);
    if (targets.length === 0) return;
    mpActions.setShipOrders({ shipIds: targets, targetPriority: priority }).then(res => {
      setNotice(res.ok
        ? (priority === null
          ? t('grp.targetAuto', { ships: tn('grp.ships', targets.length) })
          : t('grp.prioritySet', { ships: tn('grp.ships', targets.length) }))
        : humanizeMpError(res.code, res.error, 'orders'));
    });
  };

  const applyChain = () => {
    const targets = routable.map(s => s.id);
    if (targets.length === 0 || chain.length === 0) return;
    const res = bulkChain(targets, chain, (msg) => setNotice(msg));
    if (res.issued === 0) {
      setNotice(t('grp.noRoute'));
      return;
    }
    setNotice(
      t('grp.flyingChain', { ships: tn('grp.ships', res.issued), n: chain.length })
      + (res.unplannable > 0 ? ` · ${t('grp.couldnt', { n: res.unplannable })}` : '')
      // Truncation is called out because the ship still LAUNCHES -- it
      // just stops short, somewhere nobody chose.
      + (res.truncated > 0 ? ` · ${t('grp.cutShort', { n: res.truncated })}` : ''),
    );
    setChain([]);
    setShowChain(false);
  };

  const addSameClass = () => {
    if (sameClass.length === 0) return;
    ownChangeRef.current = true;
    setShipSelection([...ids, ...sameClass.map(s => s.id)]);
    setNotice(t('grp.added', { ships: tn('grp.ships', sameClass.length) }));
  };

  const takeShipsThere = () => {
    if (shipsThere.length === 0) return;
    ownChangeRef.current = true;
    setShipSelection([...ids, ...shipsThere.map(s => s.id)]);
    setNotice(t('grp.addedAt', { ships: tn('grp.ships', shipsThere.length), body: promptBody?.name ?? t('grp.thatWorld') }));
    setWorldPrompt(null);
  };

  const sendThere = () => {
    if (!worldPrompt) return;
    groupMove(worldPrompt);
    setWorldPrompt(null);
  };

  const stanceButtons = STANCE_IDS.map(s => (
    <button
      key={s}
      className="group-bar__btn"
      title={t(`grp.stance.${s}.title` as const)}
      onClick={() => setStance(s)}
    >{t(`grp.stance.${s}.label` as const)}</button>
  ));
  const targetingButton = gunners.length > 0 && (
    <button
      className={`group-bar__btn${showTargeting ? ' group-bar__btn--active' : ''}`}
      title={gunners.length === ships.length
        ? t('grp.targetingTip')
        : t('grp.targetingTipSome', { hulls: tn('grp.armedHulls', gunners.length) })}
      onClick={() => setShowTargeting(v => !v)}
    >{t('grp.targeting')}</button>
  );
  const chainButton = (
    <button
      className={`group-bar__btn${showChain ? ' group-bar__btn--active' : ''}`}
      title={t('grp.chainTip')}
      onClick={() => setShowChain(v => !v)}
    >{t('grp.chain')}</button>
  );
  const interceptButton = mpActions && (
    <button
      className={`group-bar__btn${showIntercept ? ' group-bar__btn--active' : ''}`}
      disabled={interceptors === 0}
      title={interceptors === 0 ? t('grp.interceptNone') : t('grp.interceptTip')}
      onClick={() => setShowIntercept(v => !v)}
    >{touch ? t('grp.interceptMore') : t('grp.intercept')}</button>
  );
  const interceptPicker = showIntercept && interceptors > 0 && (
    <GroupIntercept
      ships={ships}
      onClose={() => setShowIntercept(false)}
      onSent={(msg) => { setNotice(msg); setShowIntercept(false); }}
    />
  );
  const formFleetButton = canFormFleet && (
    <button
      className="group-bar__btn"
      onClick={() => { void formFleet(); }}
      title={flagCandidate
        ? t('grp.formFleetTip', { n: mine.length, name: flagCandidate.captainName ?? flagCandidate.name })
        : t('grp.formFleetNoCaptain')}
    >{t('grp.formFleet')}</button>
  );
  const sameClassButton = sameClass.length > 0 && (
    <button
      className="group-bar__btn"
      onClick={addSameClass}
      title={tn('grp.addSameTip', sameClass.length)}
    >+ {classLabel}</button>
  );
  const destinationPicker = (
    <div className="group-bar__row">
      <span className="group-bar__label">{t('grp.transferTo')}</span>
      <select
        className="group-bar__select"
        value={dest}
        onChange={(e) => setDest(e.target.value)}
        title={t('grp.sendAllTip')}
      >
        <option value="">{t('grp.destination')}</option>
        {destinations.map(d => (
          <option key={d.id} value={d.id}>{d.label}</option>
        ))}
      </select>
      <button
        className="group-bar__btn group-bar__btn--primary"
        disabled={!dest || routable.length === 0}
        onClick={() => { if (dest) groupMove(dest); }}
        title={routable.length === 0
          ? t('grp.noOrderYet')
          : underWay.length > 0
            ? t('grp.sendTipAfter', { ships: tn('grp.ships', routable.length), n: underWay.length })
            : t('grp.sendTip', { ships: tn('grp.ships', routable.length) })}
      >
        {t('grp.send', { n: routable.length })}
      </button>
    </div>
  );
  const flyouts = (
    <>
      {/* Target-priority flyout — every drop applies to the whole group
          immediately, matching the stance buttons' apply model. */}
      {mpActions && showTargeting && gunners.length > 0 && (
        <div className="group-bar__targeting">
          <TargetPriorityCards
            value={sharedPriority}
            onChange={setTargeting}
            note={sharedPriority
              ? undefined
              : t('grp.appliesTo', { hulls: tn('grp.armedHulls', gunners.length) })}
          />
        </div>
      )}
      {/* CHAIN ORDERS. Sibling of the single-destination SEND: that is the
          fast path, this is the itinerary. Both end at the same place -- a
          burn per hull, solved from that hull's own orbit -- so a chain of
          one leg is exactly a SEND. */}
      {showChain && (
        <div className="group-bar__chain">
          <ChainOrderEditor
            steps={chain}
            onChange={setChain}
            bodies={gameState.bodies}
            note={routable.length === 0
              ? t('grp.noOrderYetDot')
              : underWay.length > 0
                ? t('grp.chainNoteUnderWay', { n: underWay.length })
                : t('grp.chainNote', { ships: tn('grp.ships', routable.length) })}
          />
          <button
            className="group-bar__btn group-bar__btn--primary"
            disabled={chain.length === 0 || routable.length === 0}
            onClick={applyChain}
            title={chain.length === 0
              ? t('grp.addLeg')
              : t('grp.launchTip', { ships: tn('grp.ships', routable.length), n: chain.length })}
          >
            {tn('grp.launch', chain.length, { ships: routable.length })}
          </button>
        </div>
      )}
    </>
  );

  // ---- touch: the contextual action bar of selection mode ---------------
  if (touch) {
    // The picker's sheet takes the bar's place; ✕ or a sent order brings
    // the bar back.
    if (interceptPicker) return interceptPicker;
    const hint = notice
      ?? (ships.length === 0
        ? t('grp.hintTouchEmpty')
        : t('grp.hintTouch'));
    return (
      <div className="group-bar group-bar--touch" role="region" aria-label={t('grp.selection')}>
        <div className="group-bar__row group-bar__row--head">
          <span className="group-bar__count">
            {ships.length === 0 ? t('grp.selectShips') : t('grp.selectedCaps', { n: ships.length })}
            {ships.length > 0 && movable.length !== ships.length && (
              <span className="group-bar__sub">{t('grp.underWay', { n: ships.length - movable.length })}</span>
            )}
          </span>
          {ships.length >= 2 && (
            <button
              className="group-bar__btn"
              onClick={() => setGroupListOpen(true)}
              title={t('grp.listTip')}
            >{t('grp.list')}</button>
          )}
          <button
            className="group-bar__btn group-bar__btn--primary"
            onClick={done}
            title={t('grp.doneTip')}
          >{t('grp.done')}</button>
        </div>

        {/* A tapped world, waiting on a choice. Never acts on its own. */}
        {promptBody && (
          <div className="group-bar__row group-bar__prompt">
            <span className="group-bar__label">{promptBody.name}</span>
            {shipsThere.length > 0 && (
              <button className="group-bar__btn" onClick={takeShipsThere}>
                {t('grp.plusHere', { ships: tn('grp.shipsCaps', shipsThere.length) })}
              </button>
            )}
            {routable.length > 0 && (
              <button className="group-bar__btn group-bar__btn--primary" onClick={sendThere}>
                {t('grp.sendHere', { n: routable.length })}
              </button>
            )}
            {shipsThere.length === 0 && routable.length === 0 && (
              <span className="group-bar__sub">{t('grp.nothingHere')}</span>
            )}
            <button
              className="group-bar__btn group-bar__btn--ghost"
              onClick={() => setWorldPrompt(null)}
              aria-label={t('grp.dismiss')}
            >✕</button>
          </div>
        )}

        {ships.length > 0 && (
          <div className="group-bar__row">
            <button
              className={`group-bar__btn${showSend ? ' group-bar__btn--active' : ''}`}
              onClick={() => setShowSend(v => !v)}
              disabled={routable.length === 0}
            >{t('grp.sendMore')}</button>
            {interceptButton}
            {formFleetButton}
            {sameClassButton}
            {mpActions && (
              <button
                className={`group-bar__btn${showOrders ? ' group-bar__btn--active' : ''}`}
                onClick={() => setShowOrders(v => !v)}
              >{t('grp.ordersMore')}</button>
            )}
          </div>
        )}
        {ships.length > 0 && showSend && destinationPicker}
        {ships.length > 0 && mpActions && showOrders && (
          <div className="group-bar__row">
            {stanceButtons}
            {targetingButton}
            {chainButton}
          </div>
        )}
        {flyouts}
        <div className="group-bar__hint">{hint}</div>
      </div>
    );
  }

  // ---- desktop ------------------------------------------------------------
  return (
    <div className="group-bar" role="region" aria-label={t('grp.groupActions')}>
      <div className="group-bar__row">
        <span className="group-bar__count">
          {t('grp.selected', { n: ships.length })}
          {movable.length !== ships.length && (
            <span className="group-bar__sub"> · {t('grp.alreadyBurning', { n: ships.length - movable.length })}</span>
          )}
        </span>
        {mpActions && (
          <span className="group-bar__stances">
            {stanceButtons}
            {targetingButton}
            {chainButton}
            {interceptButton}
          </span>
        )}
        {formFleetButton}
        {sameClassButton}
        <button
          className="group-bar__btn group-bar__btn--ghost"
          onClick={done}
          title={t('grp.clearTip')}
        >{t('grp.clear')}</button>
      </div>

      {/* Pick-from-list transfer, for when the destination is off-screen
          or too small to shift-click comfortably. Same code path as the
          map gesture — both call groupMove. */}
      {destinationPicker}
      {flyouts}
      {interceptPicker}

      <div className="group-bar__hint">
        {notice ?? t('grp.hintDesktop')}
      </div>
    </div>
  );
};
