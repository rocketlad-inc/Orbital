// ============================================================
// INTERCEPT for a selected group (GroupActionBar).
//
// The ship panel's picker, for many hulls at once. Candidates are solved
// from ONE parked hull of the selection — the lead — because a picker of
// every hull's own answers would be as many lists as ships. The order is
// per hull: each parked ship solves its own intercept of the chosen
// target from where it sits (multiplayer/interceptCommit), and ships
// already flying keep their course. The picker says so.
// ============================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CameraState, Ship } from '../types';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions, type MpActionResult } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { planHullIntercept } from '../multiplayer/interceptCommit';
import { useIsMobile } from '../hooks/useIsMobile';
import { orbitWorldPos } from '../physics/orbitalMechanics';
import { solveIntercepts, courseBox, type InterceptOption } from '../game/interceptOptions';
import { framingCamera, freeMapArea } from '../game/interceptPicker';
import { getCamera } from '../state/cameraStore';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { BottomSheet } from './BottomSheet';
import { InterceptPicker, STANDING_RING, type PickerEntry } from './InterceptPicker';
import { interceptPickerEntries } from './interceptEntries';
import { useInterceptOverlay } from './useInterceptOverlay';
import { iconClassFor, ShipIcon } from './ShipIcons';

interface GroupInterceptProps {
  /** The selection, resolved against live state. */
  ships: readonly Ship[];
  onClose: () => void;
  /** The order went out; the bar shows this as its notice. */
  onSent: (notice: string) => void;
}

export const GroupIntercept: React.FC<GroupInterceptProps> = ({ ships, onClose, onSent }) => {
  const { lang } = useI18n();
  const {
    gameState, updateCamera, planLegFor,
    previewRendezvous, planTorchPreview, cancelTorchPreview,
    enqueueIntercept, launchTorchTransfer,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  const isMobile = useIsMobile();

  const parked = useMemo(
    () => ships.filter(s => s.ownedBy === 'player' && !s.transit && !!s.orbit),
    [ships],
  );
  const flyingMine = ships.filter(s => s.ownedBy === 'player' && !!s.transit).length;
  const lead = parked[0] ?? null;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  const [popAt, setPopAt] = useState<{ left: number; top: number } | null>(null);
  const camBefore = useRef<CameraState | null>(null);
  // The hull whose preview the picker staged, so it is the one cleared.
  const previewFor = useRef<string | null>(null);
  const stagedMoveFor = useRef<string | null>(null);

  // Same projection the ship panel keys its solve on: what is in flight,
  // where to, and when it lands — not the ships array, which a preview
  // rewrites on every pick.
  const flightSignature = gameState.ships
    .filter(s => s.transit?.currentTransfer?.targetBodyId)
    .map(s => `${s.id}:${s.transit!.currentTransfer!.targetBodyId}:${s.transit!.currentTransfer!.arriveTick}`)
    .join('|');
  const selectionKey = ships.map(s => s.id).join(',');

  const options = useMemo((): InterceptOption[] => {
    if (!lead) return [];
    // Nobody intercepts their own group, or a fleet one of them flies in.
    const fleetIds = new Set(ships.map(s => s.fleetId).filter((f): f is string => !!f));
    const exclude = new Set<string>(ships.map(s => s.id));
    for (const s of gameState.ships) if (s.fleetId && fleetIds.has(s.fleetId)) exclude.add(s.id);
    return solveIntercepts(lead, gameState, planLegFor, exclude);
  // See the ship panel: flightSignature stands in for gameState.ships.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, selectionKey, flightSignature, gameState.currentTick, gameState.bodies]);

  const myPos = lead?.orbit ? orbitWorldPos(lead.orbit, gameState.currentTick, gameState.bodies) : null;
  const entries = useMemo((): PickerEntry[] => (
    myPos ? interceptPickerEntries(options, gameState, myPos) : []
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [options, lang]);
  const selected = options.find(o => o.key === selectedKey && o.ok) ?? null;

  useInterceptOverlay('group-bar', !!lead, options, selectedKey, showing, myPos, gameState.bodies, lang);

  const clearPreview = () => {
    if (previewFor.current) previewRendezvous(previewFor.current, null);
    previewFor.current = null;
    if (stagedMoveFor.current) cancelTorchPreview(stagedMoveFor.current);
    stagedMoveFor.current = null;
  };
  const restoreCamera = () => {
    if (camBefore.current) updateCamera(camBefore.current);
    camBefore.current = null;
    setShowing(false);
  };
  // Leaving by any road — ✕, Escape on the bar, the group changing —
  // takes the preview with it. The camera comes back only on ✕ or BACK
  // TO SHIP, as in the ship panel: a new group is usually picked ON the
  // framed view, and jumping away from it would lose what was clicked.
  const clearRef = useRef(() => {});
  clearRef.current = clearPreview;
  useEffect(() => () => clearRef.current(), []);

  // Dock the desktop pop-out beside the group's panel.
  useLayoutEffect(() => {
    if (isMobile) { setPopAt(null); return undefined; }
    const panel = () => document.querySelector('.group-selection-panel') ?? document.querySelector('.ship-panel');
    const place = () => {
      const r = panel()?.getBoundingClientRect();
      // Clamped, and measured again when the panel's slide-in ends (see
      // the ship panel's dock).
      setPopAt(r && r.width > 0
        ? { left: Math.round(r.right + 8), top: Math.max(8, Math.round(r.top)) }
        : { left: 16, top: 70 });
    };
    place();
    const el = panel();
    window.addEventListener('resize', place);
    el?.addEventListener('animationend', place);
    return () => {
      window.removeEventListener('resize', place);
      el?.removeEventListener('animationend', place);
    };
  }, [isMobile, selectionKey]);

  const close = () => {
    clearPreview();
    restoreCamera();
    onClose();
  };

  const frame = (o: InterceptOption) => {
    const box = courseBox(o, myPos, gameState.bodies);
    if (!box) return;
    const W = window.innerWidth, H = window.innerHeight;
    updateCamera({
      focusedBodyId: undefined,
      ...framingCamera(box, freeMapArea(isMobile, popAt?.left ?? null, W, H), W, H),
    });
  };
  const toggleShow = () => {
    if (!selected) return;
    if (showing) { restoreCamera(); return; }
    camBefore.current = { ...getCamera() };
    frame(selected);
    setShowing(true);
  };

  // Picking draws the lead's course and leaves the camera alone, exactly
  // as in the ship panel.
  const pick = (key: string) => {
    const o = options.find(x => x.key === key && x.ok);
    if (!o || !lead) return;
    setSelectedKey(key);
    setError(null);
    if (isMobile) setPeek(true);
    clearPreview();
    if (o.rv) {
      previewRendezvous(lead.id, {
        p0: { x: o.myPlan.startPos.x, y: o.myPlan.startPos.y },
        v0: { x: o.myPlan.startVel.x, y: o.myPlan.startVel.y },
        accel: o.myPlan.acceleration,
        A: o.rv.A, B: o.rv.B,
        startTick: gameState.currentTick, meetTick: o.rv.meetTick,
        followShipId: o.lead.id,
      });
      previewFor.current = lead.id;
    } else if (planTorchPreview(lead.id, o.dest.id)) {
      stagedMoveFor.current = lead.id;
    }
    if (showing) frame(o);
  };

  const commit = async () => {
    const chosen = selected;
    if (!chosen || !mpActions || busy) return;
    setBusy(true);
    // The launches below replace the staged previews.
    previewFor.current = null;
    stagedMoveFor.current = null;
    const plans = parked
      .map(s => planHullIntercept(s.id, chosen.lead.id, { enqueueIntercept, launchTorchTransfer, previewRendezvous }))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const results = plans.length > 0 ? await mpActions.transferMany(plans.map(p => p.intent)) : [];
    setBusy(false);
    const sent = results.filter(r => r.ok).length;
    if (sent === 0) {
      const bad = results.find((r): r is Extract<MpActionResult, { ok: false }> => !r.ok);
      setError(bad ? humanizeMpError(bad.code, bad.error, 'transfer') : t('grp.noPlan'));
      return;
    }
    camBefore.current = null;
    setShowing(false);
    const name = chosen.fleet?.name ?? chosen.lead.name;
    onSent(
      t('grp.intercepting', { ships: tn('grp.ships', sent), name })
      + (parked.length - sent > 0 ? ` · ${t('grp.couldnt', { n: parked.length - sent })}` : '')
      + (flyingMine > 0 ? ` ${t('ship.panel.mateFlying', { n: flyingMine })}` : ''),
    );
  };

  if (!lead) return null;
  const myFaction = gameState.factions.find(f => f.id === 'player');
  const shared = {
    entries,
    selectedKey: selected?.key ?? null,
    onSelect: pick,
    showing,
    onShow: toggleShow,
    onCommit: () => { void commit(); },
    busy,
    message: error ? { kind: 'error' as const, text: error } : null,
    meIcon: (
      <ShipIcon size={24} shipClass={iconClassFor(lead.class)} variant={lead.iconVariant} parts={lead.parts}
        color={myFaction?.color ?? STANDING_RING.yours} color2={myFaction?.color2} />
    ),
    now: gameState.currentTick,
    note: t('ship.rv.groupNote'),
  };
  const title = t('ship.rv.groupTitle', { n: parked.length });

  if (isMobile) {
    return (
      <BottomSheet open onClose={close} title={title} size={peek ? 'peek' : 'tall'}>
        <InterceptPicker
          variant="sheet"
          {...shared}
          onBack={close}
          peek={peek}
          onUnpeek={() => setPeek(false)}
        />
      </BottomSheet>
    );
  }
  if (!popAt) return null;
  return createPortal(
    <InterceptPicker
      variant="popout"
      {...shared}
      title={title}
      onClose={close}
      style={{ left: popAt.left, top: popAt.top }}
    />,
    document.body,
  );
};
