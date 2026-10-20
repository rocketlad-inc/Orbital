// ============================================================
// WorldMenuOverlay — the diegetic world menu. MULTIPLAYER ONLY.
//
// Mounted exclusively from GameUI's MP branch (App.tsx). On mount it
// flips the world-menu store flag that activates the MP-gated close-up
// pass in MapCanvas/worldMenuCloseup; single-player never mounts this
// component, so all of that stays dead there.
//
// Architecture (per the tested mockup, qa 71/71):
//   - ONE camera. Selecting a body flies the existing map camera to
//     menu framing (body centre just below the frame → upper limb +
//     sky). The canvas draws the planet + surface the whole way; this
//     overlay only fades DOM chrome in at the end of the dive and back
//     out as you zoom away. No modal, no crossfade.
//   - Menu chrome: top readout panel, surface/orbit build columns,
//     fleet bar (reuses BuildPanel wholesale), neighbor orbs, station
//     rig, leader lines.
//   - Dismissal: zoom out (wheel/pinch), ✕ MAP, or Escape.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameContext } from '../state/gameContext';
import { useCamera } from '../state/cameraStore';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import type { MpActionResult } from './MultiplayerActionsContext';
import { useFeatureGate } from '../hooks/useFeatureGate';
import { BUILDING_FEATURE } from '../game/researchUnlocks';
import { BUILDABLE_CLASSES, getShipClass } from '../game/shipClasses';
import { sanitizeParts, partsCost, computeDesignStats, PART_GLYPH } from '../game/shipParts';
import type { ShipPartId } from '../game/shipParts';
import { RESOURCE_LETTER_COLORS } from '../game/resourceColors';
import { trackPendingBuild, resolveServerOrderId } from '../game/optimisticBuilds';

import { shipyardSlotsAtBody, canHostCity, canHostStation, isRawWorld, suggestSettlementName, BUILDING_DEFS } from '../game/settlements';
import { EditableName } from '../components/EditableName';
import { RushControl } from '../components/BuildPanel';
import { humanizeMpError } from './errorMessages';
import { ShipIcon, ICON_VARIANT_NAMES, DEFAULT_SHIP_ICONS } from '../components/ShipIcons';
import { randomShipName } from '../game/shipNames';
import { pickFromPool } from '../game/namePools';
import { deriveSecondary } from '../game/colorUtils';
import { stationInnerSvg } from '../render/settlementArt';
import { globeKeyOf } from '../render/planetTexture';
import { artUrl } from '../render/artVersion';
import { StructureIcon, StructureScaffold } from '../components/StructureIcons';
import { progressOf as progressOfSite } from '../game/megastructures';
import { composedBodyFlavor, bodyImmovableNote } from '../game/bodyFlavor';
import { TransferTargetPicker } from '../components/ShipPanel';
import { WmSilo, MISSILES_PER_LEVEL } from './WmSilo';
import { Body, BuildingKind, Settlement, SettlementType, Ship } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';
import { isRevealedWarpGate } from '../render/mapRenderer';
import {
  menuScaleFor, menuCameraOffset, menuOpacity, zOf,
  S1X_FRAC, S1Y_FRAC, Z1_FRAC, MOBILE_LIFT_FRAC,
} from '../game/worldMenu/camera';
import { setWorldMenuActive, setWorldMenuOpenBodyId, setWorldMenuStructures, setWorldMenuStructureFocus } from '../game/worldMenu/store';
import { structureUnit, structureTop, structureHalfWidth } from '../game/worldMenu/structures';
import { columnsFor, buildStatus, noHostText, nextBuildingLevel, costText } from '../game/worldMenu/buildRules';
import { hpColor } from '../game/worldMenu/combatDisplay';
import { readoutFor, neighborsOf, orbSlotIndex } from '../game/worldMenu/bodyStats';
import { worldControl, settlementLivery } from '../game/worldMenu/settlementControl';
import { empireYieldMultipliers } from '../game/yieldMultipliers';
import { PART_FRACS } from '../render/worldMenuCloseup';
import './WorldMenuOverlay.css';
import { RuinsCard } from './RuinsCard';
import { employedShipIds, routeDeliversTo, routeCarriers } from '../game/routeSelectors';
import { terraformInbound, tickClock } from '../game/terraformInbound';
import { buildChoices } from '../game/designChoice';
import { RamControlsSection } from '../components/BodyInspector';
import { t, tn, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
/** The bar's drawers, and where the last choice is remembered. */
const DRAWER_IDS = ['structures', 'yard', 'silo', 'terraform'] as const;
type DrawerId = typeof DRAWER_IDS[number];
const DRAWER_KEY = 'orbital.wm_drawer';

/** Picker target meaning "the panel default", not a specific queued row.
 *  A build order id can never collide with it — they are body-prefixed. */
const NEXT_SHIP = '__next_ship__';

/** Ease the displayed z toward the camera-derived target over ~250ms —
 *  matching MapCanvas's programmatic-camera tween so the chrome resolves
 *  in step with the planet's visual arrival, not the instant state jump. */
function useEasedZ(target: number): number {
  const [z, setZ] = useState(target);
  const stateRef = useRef({ from: target, to: target, start: 0 });
  useEffect(() => {
    const st = stateRef.current;
    if (target === st.to) return;
    st.from = z; st.to = target; st.start = performance.now();
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (performance.now() - st.start) / 250);
      const e = 1 - Math.pow(1 - t, 3);
      setZ(st.from + (st.to - st.from) * e);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return z;
}

// Sky orbs: small (just big enough to tap — the transparent hit circle
// adds +14px) and kept HIGH so they stay clear of the city name tag.
// Sky orbs — placed as absolute-px offsets from `cx`, all to the RIGHT
// of the info panel (which centres over the planet and has a max width
// of 560px, so its right edge lives at cx + 280). This puts every orb
// clear of the panel and clear of the outliner on the left.
// Ordered biggest-first (parent), then siblings.
// The ✕ MAP button lives at (topbar + 10) and stands ~28px tall, hard
// against the same right gutter the orb cluster is clamped into. The orbs
// carry a generous r+14 transparent hit circle, so the top row was landing
// ON the close button and eating the click that dismisses the menu.
// Everything below is offset to start clear of it.
// The 28 is an estimate (7px padding x2 + ~12px line box + 2px borders), so
// the gap is deliberately generous rather than pixel-tight — uppercase and
// letter-spacing can push that line box a couple of px either way.
const ORB_CLEAR_Y = 52 /* topbar */ + 10 /* button top */ + 28 /* button */ + 28 /* gap */;

const ORB_SLOTS = [
  // y is the CENTRE, so each slot must also clear its own radius.
  { dx: 310, y: ORB_CLEAR_Y + 40, r: 40 },   // parent (biggest)
  { dx: 440, y: ORB_CLEAR_Y + 80, r: 22 },
  { dx: 550, y: ORB_CLEAR_Y + 50, r: 18 },
  { dx: 380, y: ORB_CLEAR_Y + 160, r: 16 },
];

export const WorldMenuOverlay: React.FC = () => {
  useI18n();
  const {
    gameState, uiState,
    updateCamera, focusBody, selectBody, deselectBody, renameSettlement,
  } = useGameContext();
  const camera = useCamera();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();

  const [vw, setVw] = useState(window.innerWidth);
  const [vh, setVh] = useState(window.innerHeight);
  // Where the map canvas starts below the window's top. The camera frames
  // the planet in CANVAS px and this overlay is laid out in window px; on
  // staging the banner pushes the canvas down 23px, and every stem ended
  // that far above its building.
  const [mapTop, setMapTop] = useState(0);
  // The map's own side buttons (box-select, previous / next) show on a
  // narrow desktop too; the station keeps left of them.
  const [ctlLeft, setCtlLeft] = useState<number | null>(null);
  const measureChrome = () => {
    const cv = document.querySelector('canvas[data-map-canvas]');
    setMapTop(cv ? Math.round(cv.getBoundingClientRect().top + window.scrollY) : 0);
    const btns = [...document.querySelectorAll('.map-controls__btn')]
      .map(b => b.getBoundingClientRect()).filter(r => r.width > 0 && r.top < 320);
    setCtlLeft(btns.length ? Math.round(Math.min(...btns.map(r => r.left))) : null);
  };
  useEffect(() => {
    const onR = () => {
      setVw(window.innerWidth); setVh(window.innerHeight);
      measureChrome();
    };
    onR();
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const mobile = vw <= 720;

  // Activate the MP-only canvas close-up while mounted.
  useEffect(() => {
    setWorldMenuActive(true);
    return () => setWorldMenuActive(false);
  }, []);

  const [openId, setOpenIdRaw] = useState<string | null>(null);
  // Publish the currently open body id to the renderer so drawCity /
  // drawStation know to suppress their old canvas art ONLY on the
  // focused body while the menu is up. Cleared on close so diamonds
  // return to the map view.
  useEffect(() => {
    setWorldMenuOpenBodyId(openId);
    return () => setWorldMenuOpenBodyId(null);
  }, [openId]);
  const [collapsed, setCollapsed] = useState(true);
  // THE BAR (diegetic pass, 2026-10-19): STRUCTURES / YARD / MISSILE SILO /
  // TERRAFORM. Nothing is open until asked, so the world keeps the screen;
  // the last choice is remembered, so a player who lives in the yard finds
  // it open on every world.
  const [drawer, setDrawer] = useState<DrawerId | null>(() => {
    try {
      const v = localStorage.getItem(DRAWER_KEY);
      return (DRAWER_IDS as readonly string[]).includes(v ?? '') ? (v as DrawerId) : null;
    } catch { return null; }
  });
  const openDrawer = useCallback((d: DrawerId | null) => {
    setDrawer(d);
    try { if (d) localStorage.setItem(DRAWER_KEY, d); else localStorage.removeItem(DRAWER_KEY); } catch { /* private window */ }
  }, []);
  // The structure whose card is open: one at a time, cleared per world.
  const [picked, setPicked] = useState<{ kind: BuildingKind; column: 'surface' | 'orbit' } | null>(null);
  const pickedKind = picked?.kind ?? null;
  const pickedColumn = picked?.column ?? 'surface';
  // The station's own card: its modules, listed, one tap from their cards.
  const [stationOpen, setStationOpen] = useState(false);
  // The structure under the pointer: its tag and its building light together.
  const [hoverKind, setHoverKind] = useState<string | null>(null);
  useEffect(() => { setPicked(null); setStationOpen(false); setHoverKind(null); }, [openId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { measureChrome(); }, [openId]);
  // The lore waits behind ABOUT: it was taking the best spot on the screen.
  const [aboutOpen, setAboutOpen] = useState(false);
  // While a menu is open: tag <body> so the left rail steps aside
  // (CSS in WorldMenuOverlay.css — MP-only by construction), and
  // measure the real TopBar so the panel tucks exactly under it.
  // fleet/panel heights bump this so JS-computed positions (column
  // clamp) re-render after the DOM measures in.
  const [chromeH, setChromeH] = useState({ fleet: 200, panel: 92, panelW: 420 });
  useEffect(() => {
    document.body.classList.toggle('wm-open', !!openId);
    if (!openId) return;
    const bar = document.querySelector('.top-bar') as HTMLElement | null;
    document.body.style.setProperty('--wm-topbar-h', `${bar?.offsetHeight ?? 52}px`);
    return () => { document.body.classList.remove('wm-open'); };
  }, [openId]);
  // The chrome-measuring observer lives in a SEPARATE effect defined
  // further down, gated on the chrome actually being in the DOM — see
  // `chromeMounted`. Attaching it here (on openId) observed nothing:
  // at open time the overlay still returns null (opacity gate), so
  // .wm-top/.wm-fleet didn't exist yet and every mobile row positioned
  // itself off the stale fallback heights — the surface row vanished
  // behind the fleet box and the orbit row overlapped the top panel.

  const setOpenId = setOpenIdRaw;
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /** A neutral line, e.g. where a cancelled order's refund went. */
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const camSnapshotRef = useRef<{ x: number; y: number; scale: number; focusedBodyId?: string } | null>(null);

  const body: Body | undefined = useMemo(
    () => (openId ? gameState.bodies.find(b => b.id === openId) : undefined),
    [openId, gameState.bodies],
  );

  // ---- open: selecting a body flies the camera to menu framing ----
  useEffect(() => {
    const sel = uiState.selectedBodyId;
    if (!sel) return;
    const b = gameState.bodies.find(bb => bb.id === sel);
    // Stars ARE clickable now (per Lorne: "can't open a world menu on
    // the sun to build the Dyson sphere"). Sol flows through the same
    // no-surface path as a gas giant — empty SURFACE column, live ORBIT
    // column (stations can orbit anything, that's the Dyson foundation)
    // — and the WmDysonCard in the top panel is finally reachable in
    // the default UI. Only lagrange markers stay unclickable.
    if (!b || b.type === 'lagrange') return;
    // A revealed warp gate is a door, not a world — every ship that
    // arrives is warped out next tick, so SURFACE/ORBIT build columns
    // would be offering something that can never happen. WarpGateCard
    // renders instead (mounted alongside this overlay in App.tsx).
    if (isRevealedWarpGate(b)) return;
    // A METEOROID IS NOT A WORLD EITHER. Flying the camera down to a
    // "surface" and drawing a horizon on a few hundred metres of rock
    // produced a panel of zeros — POP 0, DEFENSE 0, every yield 0 — and
    // a BUILD STATION button for something that cannot host one.
    // MeteoroidCard renders instead (mounted alongside this overlay in
    // App.tsx), and answers the only question a rock raises: what is in
    // it, and how does it get out.
    if (b.mineralKind) return;
    // A MEGASTRUCTURE IS NOT A WORLD EITHER, and for exactly the same
    // reasons. Flying down to it drew the site as a big coloured
    // PLANET — a flat disc in the structure's own tint, sitting next to
    // the truss sprite, so one object appeared twice in two different
    // styles — and served a panel of zeros with a BUILD STATION button
    // on a construction site. MegastructureCard renders instead
    // (mounted alongside this overlay in App.tsx) and answers the only
    // question a site raises: what is it, and how far along.
    if (b.type === 'megastructure') return;
    if (openId !== sel) {
      if (!openId) {
        camSnapshotRef.current = {
          x: camera.x, y: camera.y, scale: camera.scale, focusedBodyId: camera.focusedBodyId,
        };
      }
      const s1 = menuScaleFor(b, vh);
      // Desktop keeps the outliner visible; shift the planet right by
      // half the outliner width so it centers in the remaining space
      // (outliner ~296px on the left, dock ~60px on the right).
      const rShift = vw > 720 ? (296 - 60) / 2 : 0;
      // Mobile: lift the planet so the horizon lands ~45% down — the
      // station and the structure tags in the sky above, the bar and its
      // sheets below (MOBILE_LIFT_FRAC; the render below uses the same).
      const uShift = vw > 720 ? 0 : -MOBILE_LIFT_FRAC * vh;
      const off = menuCameraOffset(vw, vh, s1, rShift, uShift);
      focusBody(sel); // sets focusedBodyId (body-relative camera)
      updateCamera({ scale: s1, x: off.x, y: off.y });
      setOpenId(sel);
      setErrMsg(null);
    } else {
      // SAME WORLD, NEW VIEWPORT (a window resized, a phone turned): frame
      // it again. The tags are placed from the viewport, the planet from
      // the camera; left alone the two parted company, and the tags hung
      // off a planet framed for the old size.
      const s1 = menuScaleFor(b, vh);
      const rShift = vw > 720 ? (296 - 60) / 2 : 0;
      const uShift = vw > 720 ? 0 : -MOBILE_LIFT_FRAC * vh;
      const off = menuCameraOffset(vw, vh, s1, rShift, uShift);
      updateCamera({ scale: s1, x: off.x, y: off.y });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState.selectedBodyId, vw, vh]);

  const close = useCallback((restoreCamera: boolean) => {
    setOpenId(null);
    deselectBody();
    if (restoreCamera) {
      const snap = camSnapshotRef.current;
      if (snap) {
        focusBody(snap.focusedBodyId);
        // FOCUSED: centre on the body. x/y are an offset from it only
        // while a world menu is open; carried back out of one, a stale
        // offset parked the camera on empty space with the focus header
        // still reading "SOI 184 km" (QA battle test, after ✕ MAP).
        updateCamera(snap.focusedBodyId
          ? { x: 0, y: 0, scale: snap.scale }
          : { x: snap.x, y: snap.y, scale: snap.scale });
      } else {
        focusBody(undefined);
      }
      return;
    }
    // Zoom-out dismissal: the player pulled back to the map, so LEAVE the
    // camera where they stopped — but RELEASE the body-focus tether.
    // While the menu is open the camera is body-relative: camera.x/y are an
    // OFFSET from the focused body (MapCanvas render, gated on
    // isWorldMenuActive()). If we leave focusedBodyId set, the camera stays
    // locked to this world's frame and the wheel handler never clears it, so
    // a click on ANOTHER planet lands in the wrong screen space and nothing
    // re-centers — the reported bug. Convert to the equivalent FREE camera
    // at the same scale + on-screen world centre (no visible jump), then
    // drop the focus so any planet click flies to and opens that world.
    const fb = camera.focusedBodyId
      ? gameState.bodies.find(bb => bb.id === camera.focusedBodyId)
      : undefined;
    if (fb) {
      const pos = bodyPosition(fb, gameState.currentTick, gameState.bodies);
      updateCamera({ focusedBodyId: undefined, x: pos.x + camera.x, y: pos.y + camera.y, scale: camera.scale });
    } else {
      updateCamera({ focusedBodyId: undefined });
    }
  }, [deselectBody, focusBody, updateCamera, setOpenId, camera, gameState.bodies, gameState.currentTick]);

  // z from the real camera; eased display copy for chrome fades.
  const zTarget = body ? zOf(camera.scale, body, vh) : 0;
  const z = useEasedZ(zTarget);
  const op = menuOpacity(z);

  // ---- chrome measurement (panel + fleet heights) ----
  // Gated on the chrome actually being MOUNTED: the overlay returns null
  // until op > 0.01, so an effect keyed only on openId ran while
  // .wm-top/.wm-fleet didn't exist and observed nothing — every mobile
  // row then positioned itself off the stale fallback heights.
  const chromeMounted = !!openId && op > 0.01;
  useEffect(() => {
    if (!chromeMounted) return;
    const panelEl = document.querySelector('.wm-top') as HTMLElement | null;
    const fleetEl = document.querySelector('.wm-fleet') as HTMLElement | null;
    const measure = () => {
      const panelH = panelEl?.offsetHeight ?? 92;
      const fleetH = fleetEl?.offsetHeight ?? 0;
      document.body.style.setProperty('--wm-panel-h', `${panelH}px`);
      document.body.style.setProperty('--wm-fleet-h', `${fleetH}px`);
      const panelW = panelEl?.offsetWidth ?? 420;
      setChromeH(prev => (prev.fleet === fleetH && prev.panel === panelH && prev.panelW === panelW
        ? prev : { fleet: fleetH, panel: panelH, panelW }));

      // MOBILE VERTICAL BUDGET (desktop never reads --wm-top-max; its
      // panel has no max-height).
      //
      // The bottom chrome is authoritative: the build box sits on the
      // dock rail, and the surface build row sits on the build box.
      // Whatever height is left between the topbar and the TOP of that
      // surface row is what the info panel may occupy — beyond that it
      // scrolls internally instead of growing into the row and burying
      // the terraform controls. Deliberately NOT circular: the surface
      // row is positioned off the build box alone and never off the
      // panel, so capping the panel cannot feed back into this.
      if (mobile) {
        // Same element the --wm-topbar-h effect above measures.
        const topbarH = (document.querySelector('.top-bar') as HTMLElement | null)?.offsetHeight ?? 52;
        const railH = parseFloat(
          getComputedStyle(document.body).getPropertyValue('--mobile-rail-height'),
        ) || 72;
        // The build rows are INSIDE the sheet now (wm-msec / wm-mrow-flow),
        // so they need no reservation out here — they're already part of
        // the height being capped, and they scroll with everything else.
        // Only the bottom chrome competes for space.
        const avail = window.innerHeight
          - (topbarH + 10)          // panel's own top offset
          - (fleetH + railH + 6)    // open drawer + dock rail
          - 66                      // the bar
          - 8;                      // breathing room
        // Floor so a very short viewport still shows a usable panel; it
        // scrolls, so a floor costs reachability nothing.
        document.body.style.setProperty('--wm-top-max', `${Math.max(120, Math.round(avail))}px`);
      } else {
        document.body.style.removeProperty('--wm-top-max');
      }
    };
    measure();
    // Live-track content growth (build queue rows appearing, More/Less).
    const ro = new ResizeObserver(measure);
    if (panelEl) ro.observe(panelEl);
    if (fleetEl) ro.observe(fleetEl);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [chromeMounted, collapsed, openId, mobile, drawer]);

  // Wheel/pinch-out past the threshold dismisses (leave the camera
  // wherever the player pulled it — that WAS the dismissal gesture).
  // Hysteresis: only arm the dismiss AFTER we've observed the menu
  // fully arrive (zTarget ≥ 0.85). Otherwise the initial fly-in from
  // map view (which climbs through 0→1) would fire this and immediately
  // close the just-opened menu. Bug repro'd from outliner + map-click
  // opens where the camera has to tween from map scale.
  const dismissArmed = useRef(false);
  const dismissSelRef = useRef(uiState.selectedBodyId);
  useEffect(() => {
    const sel = uiState.selectedBodyId;
    if (!openId) { dismissArmed.current = false; dismissSelRef.current = sel; return; }
    // A body SWITCH (outliner row / sky orb / map click changed the
    // selection) is not a dismissal — focusBody() drops the scale to 2
    // for the new target, which momentarily craters z. Without this
    // guard the armed dismiss fired close() (and deselectBody) before
    // the open effect could re-frame the new body: "you go there but
    // the menu doesn't open." On a switch, re-arm from scratch and skip
    // this cycle; the open effect below re-opens the new body.
    if (sel !== dismissSelRef.current) {
      dismissSelRef.current = sel;
      dismissArmed.current = false;
      return;
    }
    if (zTarget >= 0.85) dismissArmed.current = true;
    if (dismissArmed.current && zTarget < 0.3) close(false);
  }, [zTarget, openId, close, uiState.selectedBodyId]);

  // Another menu opening (DockRail panels, settlements/fleet/research —
  // anything that dispatches 'orbital:close-world-menu') dismisses us.
  // That event existed as an inert no-op since the cardinal revert;
  // this is its listener again.
  useEffect(() => {
    const onCloseEvt = () => { if (openId) close(true); };
    // Desktop: App broadcasts panel-state on every settlements/fleet/
    // research open — a non-null panel means another menu now owns the
    // screen. (SP dispatches this too, but SP never mounts us.)
    const onPanelState = (e: Event) => {
      const panel = (e as CustomEvent).detail?.panel;
      if (panel && openId) close(true);
    };
    window.addEventListener('orbital:close-world-menu', onCloseEvt);
    window.addEventListener('orbital:panel-state', onPanelState);
    return () => {
      window.removeEventListener('orbital:close-world-menu', onCloseEvt);
      window.removeEventListener('orbital:panel-state', onPanelState);
    };
  }, [openId, close]);

  // Escape closes and flies home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape' && openId) {
        if (picked) setPicked(null);
        else if (stationOpen) setStationOpen(false);
        else close(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, close, picked, stationOpen]);

  // ---- data ----
  const readout = useMemo(
    () => (body
      ? readoutFor(body, gameState.settlements, gameState.ships, 'player',
        empireYieldMultipliers(gameState))
      : null),
    [body, gameState.settlements, gameState.ships],
  );
  const here = useMemo(
    () => gameState.settlements.filter(s => s.bodyId === openId),
    [gameState.settlements, openId],
  );
  // Per SETTLEMENT, not per world: a world can be a rival's while one of
  // its settlements is yours (settlementControl.ts).
  const { myCity, myStation, canCommand } = worldControl(here);
  const siloLevel = Number(myCity?.buildings?.missile_silo ?? 0);
  // SLOT TAKEN, BY ANYONE. The server's rule is one city and one station
  // PER BODY with no owner filter (actions.js: "this body already has a
  // <type> — only one <type> per body"), so a rival's city occupies the
  // city slot exactly as firmly as your own would.
  //
  // Deliberately NOT "is this body owned by someone else". Body ownership
  // is DERIVED from settlement counts (recomputeBodyOwnership), so a
  // contested body reads as a rival's while a slot on it may still be
  // free — and taking that free slot is a legal, deliberate move the
  // build endpoint explicitly supports. Gating on ownership would delete
  // a real play; gating on the slot deletes only dead buttons.
  const anyCity = here.some(s => s.type === 'city');
  const anyStation = here.some(s => s.type === 'station');
  const ownerFaction = readout?.ownerFactionId
    ? gameState.factions.find(f => f.id === readout.ownerFactionId)
    : undefined;
  const p1 = ownerFaction?.color ?? '#8b6fd0';
  const p2 = ownerFaction?.color2 || deriveSecondary(p1);
  // The station flies its OWN owner's colours. On a shared world the
  // world's owner and the station's can differ, and painting a seized
  // station in the loser's livery made it look like it had not been taken.
  const staLivery = settlementLivery(
    readout?.station ? here.find(x => x.id === readout.station!.settlementId) : null,
    gameState.factions,
  );
  const sp1 = staLivery?.color ?? p1;
  const sp2 = staLivery?.color2 || (staLivery ? deriveSecondary(sp1) : p2);
  // ...and its owner's station skin (0154), so the badge is the station
  // the map draws.
  const staOwnerId = readout?.station ? here.find(x => x.id === readout.station!.settlementId)?.ownedBy : undefined;
  const staSkin = gameState.factions.find(f => f.id === staOwnerId)?.stationSkin ?? null;
  const neighbors = useMemo(() => {
    // Four orb slots: the parent's plus three. A planet has no parent, so
    // only three of its moons fit; a fourth (Jupiter's) stacked on the third.
    const list = neighborsOf(openId, gameState.bodies);
    const self = gameState.bodies.find(b => b.id === openId);
    const hasParent = !!self?.parent && list[0]?.id === self.parent;
    return list.slice(0, hasParent ? 4 : 3);
  }, [openId, gameState.bodies]);
  const parentBody = body?.parent && body.parent !== 'sol'
    ? gameState.bodies.find(b => b.id === body.parent)
    : undefined;

  const queueBuild = async (kind: BuildingKind, settlement: Settlement | null) => {
    if (!settlement) return;
    setErrMsg(null);
    // Clicking something already WAITING in the queue takes it back out
    // (and refunds it). Without this a misclick is unfixable: the cost is
    // charged when you queue, so the only other way out would be to let
    // the thing you didn't want get built.
    const waiting = (settlement.buildingBacklog ?? []).find(o => o.kind === kind);
    const res = waiting
      ? await mpActions?.cancelBuilding(settlement.id, waiting.id)
      : await mpActions?.queueBuilding(settlement.id, kind, nextBuildingLevel(settlement, kind));
    // already_queued: the tap the screen had not caught up with. What was
    // asked for is already happening, so there is nothing to tell them.
    if (res && !res.ok && res.code !== 'already_queued') setErrMsg(res.error ?? t('worldmenu.err.buildRejected'));
  };
  // Rename a settlement (city OR station). Mirrors BodyInspector: apply
  // the optimistic local change, then PATCH the server; re-throw on
  // failure so EditableName drops back into edit mode.
  const renameOwned = async (settlementId: string, next: string) => {
    renameSettlement(settlementId, next);
    const res = await mpActions?.renameSettlement(settlementId, next);
    if (res && !res.ok) throw new Error(humanizeMpError(res.code, res.error, 'rename'));
  };
  const foundSettlement = async (type: SettlementType) => {
    if (!openId || !body) return;
    setErrMsg(null);
    const name = suggestSettlementName(
      body, type, gameState.settlements,
      type === 'city' ? gameState.namePools?.city : gameState.namePools?.station,
    );
    const res = await mpActions?.deploySettlement({ bodyId: openId, type, name });
    if (res && !res.ok) setErrMsg(res.error ?? (type === 'city' ? t('worldmenu.err.couldNotFoundCity') : t('worldmenu.err.couldNotFoundStation')));
  };

  // ---- founding a city / station (MP rules, mirrors BodyInspector) ----
  // station : UNGATED — a Colony Ship here, OR an owned settlement here
  //           + 30M/20C. This is the claim move and must work on turn one.
  // city    : research-gated (settlement.city, Construction 1) AND the
  //           world must already be terraformed.
  const colonyShipHere = useMemo(() => gameState.ships.find(s =>
    s.ownedBy === 'player' && !s.transit && s.orbit.parentBodyId === openId && s.class === 'colony',
  ), [gameState.ships, openId]);
  const cityLock = gate.lockReason('settlement.city');
  const mpRes = gameState.resources['player'];
  // The price of building on ground you already hold — SERVER-SENT, and
  // the same for a city and a station. It used to be the literals 30/20
  // in three places here, including the affordability gate, which had a
  // real consequence: a Colonist captain at this body makes the server
  // charge 20% less, so a player holding 24-29 metal saw the button
  // DISABLED for a build that would have succeeded.
  const settleBase = gameState.settlementCost ?? { ore: 30, credits: 20, colonistMult: 0.8 };
  const colonistHere = useMemo(() => gameState.ships.some(sh =>
    sh.ownedBy === 'player' && !sh.transit && sh.orbit.parentBodyId === openId
    && (sh.captainTraits ?? []).includes('colonist'),
  ), [gameState.ships, openId]);
  // Mirrors handleFoundSettlement: Math.ceil on each component, applied
  // only when a Colonist is present at THIS body.
  const settleCost = useMemo(() => (colonistHere
    ? { ore: Math.ceil(settleBase.ore * settleBase.colonistMult),
        credits: Math.ceil(settleBase.credits * settleBase.colonistMult) }
    : { ore: settleBase.ore, credits: settleBase.credits }),
    [colonistHere, settleBase.ore, settleBase.credits, settleBase.colonistMult]);
  const costLabel = `${settleCost.ore}M · ${settleCost.credits}C`;
  const canAffordSettlement = !!mpRes
    && mpRes.ore >= settleCost.ore && mpRes.credits >= settleCost.credits;

  if (!body || !readout || op <= 0.01) {
    setWorldMenuStructures(null);
    setWorldMenuStructureFocus(null);
    return null;
  }

  const settled = z > 0.98;
  const isMine = readout.ownerFactionId === 'player';
  const cols = columnsFor(body);
  // Authored prose plus any type-level line (the asteroid planet-killer
  // note). Composed in bodyFlavor.ts so this panel and BodyInspector
  // cannot drift — see the note there.
  const flavor = composedBodyFlavor(body);
  const immovable = bodyImmovableNote(body);
  const integrity = myCity ?? myStation ?? here[0] ?? null;

  // ---- THE FRAMING: the same circle the canvas paints ----
  // Settled framing is deterministic: centre at S1 (+ the desktop outliner
  // shift, + the phone lift), radius Z1_FRAC·H. Every tag below hangs off
  // it, and the canvas draws each structure at the angle published for its
  // tag (setWorldMenuStructures), so a tag's stem always ends on its roof.
  const rShift = !mobile ? (296 - 60) / 2 : 0;
  const uShift = mobile ? -MOBILE_LIFT_FRAC * vh : 0;
  const cx = S1X_FRAC * vw + rShift, cy = S1Y_FRAC * vh + uShift + mapTop, cr = Z1_FRAC * vh;
  const railW = mobile ? 0 : 296, dockW = mobile ? 0 : 60;
  const TOPBAR = 52;
  // A SHORT desktop window (1000x690 was the report) has no room for the
  // full header AND the arc of tags in the sky between it and the horizon:
  // the header starts collapsed there, like a phone's, with MORE to open it.
  const shortDesk = !mobile && vh < 820;

  // ---- the station: top right on a desktop, under the header on a phone
  // (the map's own side buttons own the phone's right). Its MODULES are on
  // the station art and in its card: as tags of their own they took the
  // same patch of sky as the surface tags (Lorne, 2026-10-20: "we got
  // overlapping here") ----
  const staW = mobile ? 84 : shortDesk ? 100 : 130, staH = staW;
  const staX = mobile ? 8 : Math.min(vw - dockW - staW - 30, (ctlLeft ?? vw) - staW - 10);
  const staY = mobile ? TOPBAR + 10 + chromeH.panel + 10 : TOPBAR + 10 + 40 + 14;
  const STA_CHIP_H = 30;
  const orbitKinds = myStation ? cols.orbit : [];
  // A desktop lists every module under the station, always: what is built,
  // its level, what it costs next (Lorne, 2026-10-20: a collapsed MODULES
  // chip hid what the station had). A phone keeps one chip, but it names
  // the modules built rather than a count; the station art took the band
  // of sky the structure tags need there.
  // A SHORT window has no sky for a column of them: two abreast, name and
  // level only (the rest is in the card), or they land on the surface tags.
  const MOD_COLS = shortDesk ? 2 : 1;
  const MOD_W = shortDesk ? 2 * 100 + 4 : 168, MOD_H = shortDesk ? 24 : 36, MOD_GAP = 4;
  const modLeft = staX + staW - MOD_W;
  const modRows = Math.ceil(orbitKinds.length / MOD_COLS);
  const modsH = modRows ? modRows * MOD_H + (modRows - 1) * MOD_GAP : 0;
  const rigLeft = mobile || !orbitKinds.length ? staX : Math.min(staX, modLeft);
  const modTop = staY + staH + 6;
  const rigBottom = mobile ? staY + (myStation ? STA_CHIP_H : 70) : Math.max(staY + staH, modTop + modsH);

  // ---- orb cluster placement: ONE shift, two constraints ----
  // The orb slots are fixed constants; the station rig (now with its module
  // tags under it) and the right gutter both move relative to them. Move
  // the cluster as a BLOCK by the worst encroachment, never orb by orb:
  // per-orb clamping is what once stacked two moons on one spot.
  const ORB_GUTTER = 12, ORB_STA_CLEAR = 16;
  /** Half the width an orb takes: its disc, or its name under it (9px
   *  Audiowide, tracked out), whichever is wider. */
  const orbHalfW = (name: string, r: number) => Math.max(r + 12, (name.length + 2) * 4.3);
  const orbShift = mobile ? 0 : (() => {
    // The station, or the plot where one can be built: either sits there.
    const rigLive = !!readout.station || (!myStation && canHostStation(body) && !anyStation);
    let over = 0;
    for (let i = 0; i < neighbors.length; i++) {
      const sl = ORB_SLOTS[orbSlotIndex(i, neighbors, body.parent)];
      const right = cx + sl.dx + orbHalfW(neighbors[i].name, sl.r);
      over = Math.max(over, right - (vw - dockW - ORB_GUTTER));
      // Only orbs level with the rig can actually hit it.
      if (rigLive && sl.y + sl.r > staY && sl.y - sl.r < rigBottom) {
        over = Math.max(over, right - (rigLeft - ORB_STA_CLEAR));
      }
    }
    return Math.max(0, Math.min(over, Math.max(0, cx + 200 - (railW + 10))));
  })();

  // Owner faction colour for a body's settlement (null = unsettled).
  const bodyOwnerColor = (bid: string): string | null => {
    const s = gameState.settlements.find(x => x.bodyId === bid);
    if (!s) return null;
    return gameState.factions.find(f => f.id === s.ownedBy)?.color ?? '#8d99a5';
  };

  // ---- one structure's status, shared by its tag, its card and the list ----
  const statusOf = (kind: BuildingKind, host: Settlement | null, column: 'surface' | 'orbit') => {
    const st = buildStatus(kind, host, {
      currentTick: gameState.currentTick,
      noHostText: noHostText(column, body),
    });
    const lockObj = st.state === 'ready' && st.level === 0 && BUILDING_FEATURE[kind]
      ? gate.lockReason(BUILDING_FEATURE[kind]) : null;
    let progress: number | null = null;
    if (st.state === 'queued' && host?.buildingQueue) {
      const q = host.buildingQueue;
      const span = Math.max(1, q.completeTick - q.startTick);
      progress = Math.max(0, Math.min(1, 1 - st.ticksLeft / span));
    }
    return { st, lockObj, progress };
  };

  // The STRUCTURES list (bottom bar): every building as a row, the
  // keyboard-and-scan fallback for the tags on the world.
  const buildBtn = (kind: BuildingKind, host: Settlement | null, column: 'surface' | 'orbit') => {
    const { st, lockObj, progress } = statusOf(kind, host, column);
    // Compact lock chip: just the lock + tier (strip "Unlocks at" and the
    // building name — the button already says which building it is).
    const lockShort = lockObj ? `🔒 ${lockObj.text.replace(/^unlocks at\s*/i, '')}` : null;
    // 'backlogged' stays clickable — that click is how you remove it.
    const disabled = !host || !!lockObj
      || (st.state !== 'ready' && st.state !== 'backlogged');
    return (
      <button
        key={kind}
        className={`wm-bbtn ${st.state === 'ready' && st.level > 0 ? 'built' : ''} ${st.state === 'queued' ? 'queued' : ''} ${st.state === 'backlogged' ? 'backlogged' : ''}`}
        data-testid={`wm-list-${kind}`}
        disabled={disabled}
        title={lockObj
          ? `${lockObj.label} — ${lockObj.text}\n\n${BUILDING_DEFS[kind].description}`
          : st.state === 'backlogged'
            ? t('worldmenu.build.backlogTitle', { pos: st.position })
              + `\n\n${BUILDING_DEFS[kind].description}`
            : BUILDING_DEFS[kind].description}
        onClick={() => queueBuild(kind, host)}
      >
        <span className="wm-bbtn-nm">{tk(`worldmenu.building.${kind}`, kind.toUpperCase())}</span>
        {st.state === 'backlogged' && (
          <span className="wm-bbtn-q" aria-label={t('worldmenu.build.queuePosition', { pos: st.position })}>{st.position}</span>
        )}
        <span className="wm-bbtn-st">{lockShort ?? st.text}</span>
        <span className="wm-bbtn-fx">{BUILDING_DEFS[kind].effectShort}</span>
        {progress !== null && (
          <span className="wm-bbtn-bar">
            <i style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </span>
        )}
      </button>
    );
  };

  // ---- a structure's TAG, standing on the world ----
  const tagLine = (kind: BuildingKind, host: Settlement, column: 'surface' | 'orbit') => {
    const { st, lockObj, progress } = statusOf(kind, host, column);
    const level = 'level' in st ? st.level : 0;
    const isSilo = kind === 'missile_silo';
    let line: string;
    let tone = '';
    if (lockObj) { line = `🔒 ${lockObj.text.replace(/^unlocks at\s*/i, '')}`; tone = 'is-locked'; }
    else if (st.state === 'queued') { line = t('worldmenu.tag.building', { n: st.ticksLeft }); tone = 'is-work'; }
    else if (st.state === 'backlogged') { line = t('worldmenu.tag.inLine', { pos: st.position }); tone = 'is-booked'; }
    else if (level === 0) { line = `+ ${costText(kind, 0)}`; tone = 'is-open'; }
    else if (kind === 'shields' && (host.shieldHpMax ?? 0) > 0) {
      const cur = Math.round(host.shieldHp ?? 0), max = Math.round(host.shieldHpMax ?? 0);
      line = t('worldmenu.tag.dome', { cur, max });
      if (cur < max * 0.25) tone = 'is-warn';
    } else if (isSilo && host.missileSilo) {
      line = t('worldmenu.tag.magazine', { n: host.missileSilo.stock, cap: MISSILES_PER_LEVEL * level });
    } else line = `↑ ${costText(kind, level)}`;
    return { st, progress, level, line, tone };
  };
  const clickStructure = (kind: BuildingKind, host: Settlement, column: 'surface' | 'orbit') => {
    const level = Number(host.buildings?.[kind] ?? 0);
    if (kind === 'missile_silo' && level > 0 && host.missileSilo) { setPicked(null); openDrawer('silo'); return; }
    const isPicked = pickedKind === kind && pickedColumn === column;
    setStationOpen(false);
    setPicked(isPicked ? null : { kind, column });
  };
  const tagFor = (kind: BuildingKind, host: Settlement, column: 'surface' | 'orbit',
    style: React.CSSProperties) => {
    const { st, progress, level, line, tone } = tagLine(kind, host, column);
    const pipsN = Math.min(10, Math.max(level, st.state === 'queued' || st.state === 'backlogged' ? st.targetLevel : level + 1));
    const picked = pickedKind === kind && pickedColumn === column;
    return (
      <button
        key={`${column}-${kind}`}
        type="button"
        className={`wm-tag ${tone}${picked ? ' is-picked' : ''}${hoverKind === kind && column === 'surface' ? ' is-hover' : ''}`}
        style={style}
        data-testid={`wm-build-${kind}`}
        aria-expanded={picked}
        title={BUILDING_DEFS[kind].description}
        onMouseEnter={() => column === 'surface' && setHoverKind(kind)}
        onMouseLeave={() => column === 'surface' && setHoverKind(null)}
        onFocus={() => column === 'surface' && setHoverKind(kind)}
        onBlur={() => column === 'surface' && setHoverKind(null)}
        onClick={() => clickStructure(kind, host, column)}
      >
        <span className="wm-tag-nm">
          {tk(`worldmenu.building.${kind}`, kind.toUpperCase())}
          {level > 0 && <b>{st.state === 'queued' ? `${level}→${st.targetLevel}` : level}</b>}
        </span>
        {level > 0 && (
          <span className="wm-tag-pips" aria-hidden="true">
            {Array.from({ length: pipsN }, (_, i) => <i key={i} className={i < level ? 'on' : ''} />)}
          </span>
        )}
        <span className="wm-tag-st">{line}</span>
        {progress !== null && <span className="wm-tag-bar"><i style={{ width: `${(progress * 100).toFixed(1)}%` }} /></span>}
      </button>
    );
  };

  const foundBtn = (type: SettlementType) => {
    const isCity = type === 'city';
    const own = !!(myCity || myStation);
    // THE HARD GATE (DESIGN-terraforming): raw worlds host stations
    // only. The city button stays VISIBLE but disabled with the reason.
    const raw = isCity && !!body && isRawWorld(body);
    // NOT gated by isMine: founding is the WAY you take ownership of an
    // unclaimed body. The colony ship / lock / cost checks are the gates.
    // THE SERVER'S ORDER, NOT OURS: holding ground here means the cost is
    // what matters, a colony ship can't stand in (handleFoundSettlement).
    const consumesShip = !own && !!colonyShipHere;
    const enabled = !raw && !(isCity ? !!cityLock : false)
      && (own ? canAffordSettlement : !!colonyShipHere);
    const needSub = own
      ? (colonistHere ? t('worldmenu.found.costColonist', { cost: costLabel }) : costLabel)
      : t('worldmenu.found.needsShip');
    const sub = isCity
      ? (raw ? t('worldmenu.found.rawFirst')
        : cityLock ? cityLock.text
        : consumesShip ? t('worldmenu.found.consumesShip') : needSub)
      : (consumesShip ? t('worldmenu.found.consumesShip') : needSub);
    const colonistTag = colonistHere ? ` ${t('worldmenu.found.colonistTag')}` : '';
    const title = isCity
      ? (raw ? t('worldmenu.found.rawTitle')
        : cityLock ? `${cityLock.label} — ${cityLock.text}`
        : consumesShip ? t('worldmenu.found.cityConsumes', { name: colonyShipHere!.name })
        : own ? (canAffordSettlement
            ? `${t('worldmenu.found.cityHeld', { cost: costLabel })}${colonistTag}`
            : t('worldmenu.found.cityNeed', { cost: costLabel }))
        : t('worldmenu.found.requires'))
      : (consumesShip ? t('worldmenu.found.stationConsumes', { name: colonyShipHere!.name })
        : own ? (canAffordSettlement
            ? `${t('worldmenu.found.stationHeld', { cost: costLabel })}${colonistTag}`
            : t('worldmenu.found.stationNeed', { cost: costLabel }))
        : t('worldmenu.found.requires'));
    return (
      <button
        key={type}
        className={`wm-bbtn wm-found${raw ? ' wm-found--locked' : ''}`}
        disabled={!enabled && !raw}
        title={title}
        onClick={() => {
          // A raw world's city plot opens the way to living: the terraform
          // drawer, rather than a dead button.
          if (raw) { setPicked(null); openDrawer('terraform'); return; }
          foundSettlement(type);
        }}
        data-testid={`wm-found-${type}`}
      >
        <span className="wm-bbtn-nm">{isCity ? t('worldmenu.found.btnCity') : t('worldmenu.found.btnStation')}</span>
        <span className="wm-bbtn-st">{cityLock && isCity && !raw ? `🔒 ${sub}` : sub}</span>
      </button>
    );
  };

  // The rows for the STRUCTURES list, orbit then surface — the order a
  // phone always used.
  const surfaceEls = myCity
    ? cols.surface.map(k => buildBtn(k, myCity, 'surface'))
    : (body && canHostCity(body) && !anyCity ? [foundBtn('city')] : []);
  const orbitEls = myStation
    ? cols.orbit.map(k => buildBtn(k, myStation, 'orbit'))
    : (body && canHostStation(body) && !anyStation ? [foundBtn('station')] : []);

  // ---- THE BOTTOM BAR: what you can open here, each with its state ----
  const cfgTf = gameState.terraformConfig ?? { costMetal: 124, costCredits: 124, durationTicks: 24 };
  const rawHere = canHostCity(body) && isRawWorld(body);
  const tfAcc = body.terraformAcc ?? { metal: 0, credits: 0 };
  const tfPct = Math.round(100 * (Math.min(tfAcc.metal, cfgTf.costMetal) + Math.min(tfAcc.credits, cfgTf.costCredits))
    / Math.max(1, cfgTf.costMetal + cfgTf.costCredits));
  const builtCount = [myCity, myStation].reduce((n, s) => n
    + (s ? Object.values(s.buildings ?? {}).filter(v => Number(v) > 0).length : 0), 0);
  const yardSlots = shipyardSlotsAtBody(body.id, 'player', gameState.settlements);
  const yardBusy = (gameState.buildOrders ?? []).filter(o => o.bodyId === body.id && o.ownedBy === 'player'
    && (o.status ?? 'building') === 'building').length;
  const siloCap = MISSILES_PER_LEVEL * siloLevel;
  type Tab = { id: DrawerId; label: string; sub: string; tone?: string };
  const tabs: Tab[] = [];
  if (surfaceEls.length + orbitEls.length > 0) {
    tabs.push({ id: 'structures', label: t('worldmenu.bar.structures'), sub: tn('worldmenu.bar.built', builtCount) });
  }
  if (myCity || myStation) {
    tabs.push({ id: 'yard', label: t('worldmenu.bar.yard'), sub: t('worldmenu.bar.slipways', { busy: yardBusy, slots: yardSlots }) });
  }
  if (siloLevel > 0 && myCity?.missileSilo) {
    tabs.push({ id: 'silo', label: t('worldmenu.bar.silo'), sub: t('worldmenu.tag.magazine', { n: myCity.missileSilo.stock, cap: siloCap }), tone: 'is-silo' });
  }
  if (rawHere) {
    const left = body.terraformCompletesAtTick != null ? Math.max(0, body.terraformCompletesAtTick - gameState.currentTick) : null;
    tabs.push({ id: 'terraform', label: t('worldmenu.bar.terraform'),
      sub: left != null ? t('worldmenu.bar.tfWindow', { n: left }) : t('worldmenu.bar.tfPct', { n: tfPct }), tone: 'is-tf' });
  }
  const openTab = tabs.some(x => x.id === drawer) ? drawer : null;
  const tfTab = tabs.find(x => x.id === 'terraform');

  // ---- surface tags: fanned on an arc above the limb (desktop) or two
  // staggered rows over the horizon (phone), stems to their buildings ----
  const TAG_FRAC: Record<string, number> = { ...PART_FRACS, shields: 0 };
  const surfKinds = myCity ? [...cols.surface].sort((a, b) => (TAG_FRAC[a] ?? 0) - (TAG_FRAC[b] ?? 0)) : [];
  const TAG_W = mobile ? Math.min(112, Math.floor((2 * (vw - 24)) / Math.max(1, surfKinds.length)) - 8)
    : vw < 1100 ? 112 : vw < 1280 ? 126 : 144;
  const TAG_H = mobile ? 50 : 54;
  const apexY = cy - cr;
  // THE ARC IS PLACED, NOT ASSUMED. The header, the ✕ MAP button, the
  // station and the neighbour orbs all live in the same sky, and where each
  // sits depends on the window — a fixed arc that cleared them at 1440x900
  // ran into the station at 1000x690. Try a few radii, a little compression
  // and a sideways turn, in order of preference, and take the first that
  // touches nothing (or the least bad).
  type Rect = { l: number; t: number; r: number; b: number };
  const obstacles: Rect[] = [];
  if (!mobile) {
    obstacles.push({ l: railW + 10, t: TOPBAR + 4, r: railW + 26 + chromeH.panelW, b: TOPBAR + 18 + chromeH.panel });
    obstacles.push({ l: vw - dockW - 130, t: TOPBAR + 4, r: vw - dockW, b: TOPBAR + 50 });
    if (readout.station || (!myStation && canHostStation(body) && !anyStation)) {
      obstacles.push({ l: rigLeft - 10, t: staY - 10, r: staX + staW + 10, b: rigBottom + 10 });
    }
    neighbors.forEach((nb, i) => {
      const sl = ORB_SLOTS[orbSlotIndex(i, neighbors, body.parent)];
      const ox = cx + sl.dx - orbShift;
      const hw = orbHalfW(nb.name, sl.r);
      obstacles.push({ l: ox - hw, t: sl.y - sl.r - 12, r: ox + hw, b: sl.y + sl.r + 24 });
    });
  }
  const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  // How tall each structure stands, in px: the arc keeps every tag clear
  // of its roof, and every stem ends on it.
  const sUnit = structureUnit(cr);
  const levelHere = (k: string) => Number(myCity?.buildings?.[k as BuildingKind] ?? 0);
  const roofOf = (k: string) => structureTop(k, levelHere(k), myCity?.buildingQueue?.kind === k) * sUnit;
  const fan = (() => {
    const n = surfKinds.length;
    if (mobile || n === 0) return { R: cr + 128, step: 0, shift: 0 };
    let best = { R: cr + 128, step: (TAG_W + 18) / (cr + 128), shift: 0, score: Infinity };
    // Lower radii last: closer to the horizon when the sky above is full
    // (a short window: header, orbs and station all up there).
    for (const dR of [128, 104, 152, 84, 176, 64, 48]) {
      for (const sh of [0, -5, 5, -10, 10, -15, 15, -20, 20]) {
        for (const sc of [1, 0.92]) {
          const R = cr + dR;
          const step = Math.max((TAG_W + 6) / R, (sc * (TAG_W + 18)) / R);
          const shift = sh * Math.PI / 180;
          let score = 0;
          for (let i = 0; i < n; i++) {
            const th = (i - (n - 1) / 2) * step + shift;
            const px = cx + Math.sin(th) * R, py = cy - Math.cos(th) * R;
            const rect = { l: px - TAG_W / 2, t: py - TAG_H, r: px + TAG_W / 2, b: py };
            for (const o of obstacles) score += overlap(rect, o);
            // A tag grazing a roof is the lesser evil: the header, the
            // station and the orbs win (weighted like the area it covers).
            const clearance = (R - cr) - (roofOf(surfKinds[i]) + 14);
            if (clearance < 0) score += -clearance * TAG_W * 0.5;
            score += 4 * TAG_H * (Math.max(0, railW + 8 - rect.l) + Math.max(0, rect.r - (vw - dockW - 8))
              + Math.max(0, TOPBAR + 8 - rect.t));
          }
          if (score < best.score) best = { R, step, shift, score };
          if (score === 0) return best;
        }
      }
    }
    return best;
  })();
  // Each structure stands at its tag's angle (desktop: the arc's; phone:
  // straight under the tag), so stems run down the radius to its roof.
  // The canvas reads the same angles (setWorldMenuStructures below).
  const phoneXs = surfKinds.map((_k, i) => {
    const raw = 12 + (vw - 24) * ((i + 0.5) / surfKinds.length);
    return Math.max(8 + TAG_W / 2, Math.min(vw - 8 - TAG_W / 2, raw));
  });
  const thetaAt = (i: number) => (mobile
    ? Math.asin(Math.max(-0.95, Math.min(0.95, (phoneXs[i] - cx) / cr)))
    : (i - (surfKinds.length - 1) / 2) * fan.step + fan.shift);
  const roofPoint = (i: number) => {
    const th = thetaAt(i), rr = cr + roofOf(surfKinds[i]);
    return { x: cx + Math.sin(th) * rr, y: cy - Math.cos(th) * rr };
  };
  // Phone rows: the LOWER row takes the even tags (three of five: both
  // ends and the middle) just over their tallest roof; the UPPER row the
  // two between, a tag's height higher. Upper-row tags never reach the
  // screen's right edge, where the map's side buttons are.
  const upper = (i: number) => i % 2 === 1;
  const rowB = Math.min(...surfKinds.map((_k, i) => (!upper(i) ? roofPoint(i).y - 12 : Infinity)), apexY - 30);
  const rowA = Math.max(rigBottom + 8 + TAG_H,
    Math.min(rowB - TAG_H - 8, ...surfKinds.map((_k, i) => (upper(i) ? roofPoint(i).y - 12 : Infinity))));
  const surfTags = surfKinds.map((kind, i) => {
    let px: number, py: number;
    if (mobile) {
      py = upper(i) ? rowA : Math.max(rowB, rowA + TAG_H + 8);
      // The map's own side buttons (box-select, previous / next) run down
      // the phone's right edge to about y 290; a tag that high stays
      // left of them.
      const rightLimit = py - TAG_H < 292 ? vw - 60 : vw - 8;
      px = Math.min(rightLimit - TAG_W / 2, phoneXs[i]);
    } else {
      const th = thetaAt(i);
      px = cx + Math.sin(th) * fan.R;
      py = cy - Math.cos(th) * fan.R;
    }
    const theta = thetaAt(i);
    const end = roofPoint(i);
    const base = { x: cx + Math.sin(theta) * cr, y: cy - Math.cos(theta) * cr };
    const hitW = structureHalfWidth(kind, levelHere(kind)) * 2 * sUnit;
    return { kind, px, py, end, theta, base, hitW, hitH: roofOf(kind) + 8 };
  });
  // Publish where the structures stand, which are locked, and which is lit,
  // for the canvas (a module store: read every frame, written every render).
  setWorldMenuStructures(myCity ? surfTags.map(s => ({
    kind: s.kind, theta: s.theta,
    locked: !!statusOf(s.kind as BuildingKind, myCity, 'surface').lockObj,
  })) : null);
  setWorldMenuStructureFocus(hoverKind ?? (pickedColumn === 'surface' ? pickedKind : null));

  // The card a picked structure opens: beside its tag on a desktop, a
  // sheet over the bar on a phone.
  const pickedHost = pickedColumn === 'orbit' ? myStation : myCity;
  const pickedTag = pickedKind
    ? (pickedColumn === 'orbit'
      ? (orbitKinds.includes(pickedKind) ? { px: rigLeft, py: staY, side: 'left' as const } : null)
      : (() => { const s = surfTags.find(x => x.kind === pickedKind); return s ? { px: s.px, py: s.py - TAG_H / 2, side: (s.px < cx ? 'right' : 'left') as 'left' | 'right' } : null; })())
    : null;
  const CARD_W = 300;
  // A module's card opens beside the module column, level with the
  // station: under it, a 690-high window ran the card into the bar. Where
  // the modules already sit beside the station (a short window), under.
  const stationCardStyle = (): React.CSSProperties => (shortDesk ? {
    left: Math.max(railW + 12, staX + staW - CARD_W),
    top: rigBottom + 8,
    width: CARD_W,
  } : {
    left: Math.max(railW + 12, rigLeft - CARD_W - 12),
    top: staY,
    width: CARD_W,
  });
  const stationCard = () => {
    if (!stationOpen || !myStation || pickedKind) return null;
    return (
      <section className={`wm-card${mobile ? ' is-sheet' : ''}`} style={mobile ? undefined : stationCardStyle()}
        aria-label={t('worldmenu.station.aria')} data-testid="wm-station-card">
        <div className="wm-card-head">
          <h2>{myStation.name.toUpperCase()}</h2>
          <span className="wm-card-lv">{Math.round(myStation.hp)}/{myStation.maxHp}</span>
          <button type="button" className="wm-card-x" aria-label={t('worldmenu.card.close')}
            onClick={() => setStationOpen(false)}>✕</button>
        </div>
        <div className="wm-modlist">
          {orbitKinds.map(k => {
            const { level, line, tone } = tagLine(k, myStation, 'orbit');
            return (
              <button key={k} type="button" className={`wm-modrow ${tone}`} data-testid={`wm-build-${k}`}
                onClick={() => { setStationOpen(false); setPicked({ kind: k, column: 'orbit' }); }}>
                <span className="wm-modrow-nm">{tk(`worldmenu.building.${k}`, k.toUpperCase())}</span>
                <b>{level > 0 ? level : '—'}</b>
                <span className="wm-modrow-st">{line}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };
  const structureCard = () => {
    if (!pickedKind || !pickedHost || !pickedTag) return null;
    const kind = pickedKind;
    const { st, lockObj, progress } = statusOf(kind, pickedHost, pickedColumn);
    const level = 'level' in st ? st.level : 0;
    const name = tk(`worldmenu.building.${kind}`, kind.toUpperCase());
    const style: React.CSSProperties | undefined = mobile ? undefined : pickedColumn === 'orbit'
      ? stationCardStyle()
      : (() => {
      const left = pickedTag.side === 'right'
        ? Math.min(vw - dockW - CARD_W - 12, pickedTag.px + TAG_W / 2 + 14)
        : Math.max(railW + 12, pickedTag.px - TAG_W / 2 - 14 - CARD_W);
      const top = Math.max(TOPBAR + 10, Math.min(vh - 96 - 260, pickedTag.py - 60));
      return { left, top, width: CARD_W };
    })();
    return (
      <section className={`wm-card${mobile ? ' is-sheet' : ''}`} style={style}
        aria-label={name} data-testid="wm-card">
        <div className="wm-card-head">
          <h2>{name}</h2>
          <span className="wm-card-lv">
            {st.state === 'queued' || st.state === 'backlogged'
              ? t('worldmenu.card.lvTo', { from: level, to: st.targetLevel })
              : level > 0 ? t('worldmenu.card.lv', { lv: level }) : t('worldmenu.card.notBuilt')}
          </span>
          <button type="button" className="wm-card-x" aria-label={t('worldmenu.card.close')}
            onClick={() => setPicked(null)}>✕</button>
        </div>
        <p className="wm-card-desc">{BUILDING_DEFS[kind].description}</p>
        <div className="wm-card-fx">{BUILDING_DEFS[kind].effectShort}</div>
        {kind === 'shields' && (pickedHost.shieldHpMax ?? 0) > 0 && (
          <div className="wm-card-row">
            <span>{t('worldmenu.card.dome')}</span>
            <span className="wm-card-meter"><i style={{ width: `${Math.round(100 * (pickedHost.shieldHp ?? 0) / Math.max(1, pickedHost.shieldHpMax ?? 1))}%` }} /></span>
            <b>{Math.round(pickedHost.shieldHp ?? 0)}/{Math.round(pickedHost.shieldHpMax ?? 0)}</b>
          </div>
        )}
        {st.state === 'queued' && (
          <div className="wm-card-row is-work">
            <span>{t('worldmenu.card.building', { lv: st.targetLevel })}</span>
            <span className="wm-card-meter"><i style={{ width: `${((progress ?? 0) * 100).toFixed(1)}%` }} /></span>
            <b>{t('worldmenu.tag.building', { n: st.ticksLeft })}</b>
          </div>
        )}
        {st.state === 'backlogged' && (
          <>
            <div className="wm-card-row is-booked"><span>{t('worldmenu.card.inLine', { pos: st.position, lv: st.targetLevel })}</span></div>
            <button type="button" className="wm-card-go is-quiet" onClick={() => queueBuild(kind, pickedHost)}>
              {t('worldmenu.card.takeOut')}
            </button>
          </>
        )}
        {st.state === 'ready' && (
          lockObj ? (
            <div className="wm-card-row is-locked"><span>🔒 {lockObj.label} — {lockObj.text}</span></div>
          ) : (
            <>
              <div className="wm-card-row"><span>{t('worldmenu.card.cost')}</span><b className="is-cost">{costText(kind, level)}</b></div>
              <button type="button" className="wm-card-go" data-testid="wm-card-go"
                onClick={() => { void queueBuild(kind, pickedHost); }}>
                {level > 0 ? t('worldmenu.card.upgrade', { lv: level + 1 }) : t('worldmenu.card.build')}
              </button>
            </>
          )
        )}
      </section>
    );
  };

  // No F chip: fuel is dead (DESIGN-identity-economy.md §1.1). The DB
  // column still exists, but a permanent 0 on every world is noise.
  const yieldChips: Array<[string, number]> = [
    ['M', readout.yields.ore],
    ['C', readout.yields.credits], ['S', readout.yields.science],
  ];

  const staHpRatio = readout.station ? readout.station.hp / Math.max(1, readout.station.maxHp) : 1;

  return (
    <div
      className={`wm-root ${mobile ? 'wm-mobile' : ''}${openTab ? ' has-drawer' : ''}`}
      style={{ opacity: op, pointerEvents: op > 0.9 ? undefined : 'none' }}
      data-testid="world-menu"
    >
      {/* ===== the header: the world's name leads; the lore waits behind
           ABOUT so the panel stops taking the best spot on the screen ===== */}
      <section
        data-tutorial-id="world-menu"
        className={`wm-top ${(mobile || shortDesk) && collapsed ? 'collapsed' : ''}${shortDesk ? ' is-short' : ''}`}
        style={mobile ? undefined : {
          left: railW + 16,
          maxWidth: Math.min(520, Math.max(320, cx - cr * 0.15 - railW - 32)),
          width: 'max-content',
        }}
        data-testid="wm-top"
      >
        <div className="wm-id">
          {parentBody && (
            <button className="wm-crumb" onClick={() => selectBody(parentBody.id)}>
              ◂ {parentBody.name.toUpperCase()}
            </button>
          )}
          <div className="wm-name">{body.name.toUpperCase()}</div>
          <div className="wm-idrow">
            <span className="wm-type">{tk(`body.type.${body.type}`, body.type.replace('_', ' '))}</span>
            {readout.ownerFactionId && (
              <span
                className={`wm-owner ${isMine ? '' : 'neutral'}`}
                style={isMine ? { borderColor: p1, color: p1 } : undefined}
              >
                {isMine ? t('worldmenu.you') : (ownerFaction?.name ?? readout.ownerFactionId).toUpperCase()}
              </span>
            )}
            {(flavor || body.look?.lore) && !mobile && (
              <button type="button" className="wm-about" aria-expanded={aboutOpen}
                onClick={() => setAboutOpen(o => !o)}>
                {t('worldmenu.about')} {aboutOpen ? '▴' : '▾'}
              </button>
            )}
          </div>
        </div>
        {flavor && !mobile && aboutOpen && <div className="wm-desc">{flavor}</div>}
        {/* A custom map's world lore and a revealed hand-placed find, in
            the map maker's own words: plain text, never translated. */}
        {body.look?.lore && (mobile || aboutOpen) && <div className="wm-lore">{body.look.lore}</div>}
        {body.secret?.revealed && (body.secret.customName || body.secret.customText) && (
          <div className="wm-find">
            <span className="wm-find-glyph">✦</span>
            {body.secret.customName && <b>{body.secret.customName}</b>}
            {body.secret.customText && <span className="wm-find-text">{body.secret.customText}</span>}
          </div>
        )}
        {/* The immovable note is a RULE, so unlike flavour it is NOT
            hidden: it answers "why is there no thrusters button on this
            rock". One short line, so it costs little room. */}
        {immovable && <div className="wm-immovable">{immovable}</div>}
        <div className="wm-metrics">
          <div className="wm-metric"><span>{t('worldmenu.metric.pop')}</span><b>{readout.pop}</b></div>
          <div className="wm-metric"><span>{t('worldmenu.metric.defense')}</span><b>{readout.defense}</b></div>
          <div className="wm-metric"><span>{t('worldmenu.metric.ships')}</span><b>◆ {readout.shipCount}</b></div>
          <div className="wm-metric"><span>{t('worldmenu.metric.integrity')}</span>
            <b>{integrity ? `${Math.round(integrity.hp)}/${integrity.maxHp}` : '—'}</b>
          </div>
        </div>
        {(myCity || myStation) && (
          <div className="wm-settlements">
            {myCity && (
              <span className="wm-settlement" title={t('worldmenu.renameCity')}>
                <span className="wm-settlement-glyph">■</span>
                <EditableName value={myCity.name} maxLength={32} ariaLabel={t('worldmenu.renameCity')}
                  onSave={(next) => renameOwned(myCity.id, next)} />
                <span className="wm-settlement-hp"
                  style={{ color: hpColor(myCity.hp / Math.max(1, myCity.maxHp)) }}
                  title={t('worldmenu.integrityTitle')}>
                  ◈ {Math.round(myCity.hp)}/{myCity.maxHp}
                </span>
              </span>
            )}
            {myStation && (
              <span className="wm-settlement" title={t('worldmenu.renameStation')}>
                <span className="wm-settlement-glyph">◆</span>
                <EditableName value={myStation.name} maxLength={32} ariaLabel={t('worldmenu.renameStation')}
                  onSave={(next) => renameOwned(myStation.id, next)} />
                <span className="wm-settlement-hp"
                  style={{ color: hpColor(myStation.hp / Math.max(1, myStation.maxHp)) }}
                  title={t('worldmenu.integrityTitle')}>
                  ◈ {Math.round(myStation.hp)}/{myStation.maxHp}
                </span>
              </span>
            )}
          </div>
        )}
        <RuinsCard bodyId={body.id} />
        <div className="wm-out">
          <span className="wm-label">{t('worldmenu.output')}</span>
          <div className="wm-yields">
            {yieldChips.map(([k, v]) => (
              <span
                className="wm-yield" key={k}
                style={{ color: RESOURCE_LETTER_COLORS[k as 'F' | 'M' | 'C' | 'S'] }}
              >
                <i style={{ color: 'inherit', opacity: 0.75 }}>{k}</i>
                {Math.round(v * 10) / 10}</span>
            ))}
          </div>
          <div className="wm-stock">
            <span className="wm-label">{t('worldmenu.stockpile')}</span>{' '}
            {([
              ['M', readout.stockpile.ore],
              ['C', readout.stockpile.credits], ['S', readout.stockpile.science],
            ] as Array<['M' | 'C' | 'S', number]>).map(([k, v], i) => (
              <React.Fragment key={k}>
                {i > 0 && ' · '}
                <span style={{ color: RESOURCE_LETTER_COLORS[k] }}>{k}{Math.round(v)}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
        {/* A living world says so in one green line. A raw one's terraform
            controls live in the TERRAFORM drawer on the bar, and its
            progress is the ring on the world. */}
        {!rawHere && <WmTerraformCard body={body} isMine={isMine} />}
        {/* Dyson Sphere (Sol only) — the engineering-victory megaproject. */}
        {body.id === 'sol' && <WmDysonCard />}
        {/* The asteroid weapon: one component, mounted here and in the
            legacy BodyInspector, so the two surfaces cannot drift. */}
        {body.type === 'asteroid' && (
          <div className="wm-ram" data-testid="wm-ram">
            <RamControlsSection body={body} />
          </div>
        )}

        {(mobile || shortDesk) && (
          <button className="wm-more" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? t('worldmenu.more') : t('worldmenu.less')}
          </button>
        )}
      </section>

      {/* ===== dismissal + error ===== */}
      <button className="wm-tomap" onClick={() => close(true)} data-testid="wm-tomap">{t('worldmenu.toMap')}</button>
      {errMsg && <div className="wm-err">{errMsg}</div>}
      {!errMsg && noteMsg && <div className="wm-note" role="status">{noteMsg}</div>}

      {/* ===== neighbor orbs (desktop only) ===== */}
      {!mobile && (
      <svg className="wm-orbs" width={vw} height={vh} aria-hidden="true">
        {neighbors.map((nb, i) => {
          const isParent = nb.id === body.parent;
          const slot = ORB_SLOTS[orbSlotIndex(i, neighbors, body.parent)];
          const ox = cx + slot.dx - orbShift;
          const oy = slot.y, or = slot.r;
          const ownColor = bodyOwnerColor(nb.id);
          const gk = globeKeyOf(nb, !isRawWorld(nb));
          const site = nb.type === 'megastructure' ? gameState.megastructures?.[nb.id] : undefined;
          const siteFac = site ? gameState.factions.find(f => f.id === nb.ownedBy) : undefined;
          const siteCol = siteFac?.color ?? '#9fb4c4';
          const siteCol2 = (siteFac as { color2?: string } | undefined)?.color2;
          return (
            <g
              key={nb.id}
              className="wm-orb"
              transform={`translate(${ox},${oy})`}
              onClick={() => selectBody(nb.id)}
              data-testid={`wm-orb-${nb.id}`}
            >
              <circle r={or + 14} fill="transparent" />
              {nb.type === 'gas_giant' && (
                <ellipse rx={or * 1.6} ry={or * 0.4} fill="none" stroke="#a08a5f"
                  strokeOpacity="0.55" strokeWidth={Math.max(2, or * 0.12)} transform="rotate(-14)" />
              )}
              {site ? (
                <g transform={`translate(${-or * 1.25},${-or * 1.25})`}>
                  {site.status === 'complete'
                    ? <StructureIcon kind={site.kind} variant={site.variant ?? null} size={or * 2.5} color={siteCol} color2={siteCol2} />
                    : <StructureScaffold stage={Math.min(3, Math.floor(progressOfSite(site) * 4))} size={or * 2.5} color={siteCol} color2={siteCol2} />}
                </g>
              ) : gk
                ? <image href={artUrl(`/globes/${gk}.webp`)} x={-or} y={-or} width={or * 2} height={or * 2} />
                : <circle r={or} fill={nb.color} />}
              {!isRawWorld(nb) && (
                <>
                  {!gk && <circle r={or} fill="#4ade80" opacity="0.26" />}
                  <circle className="wm-orb-tf" r={Math.max(2.5, or * 0.22)}
                    cx={-or * 0.66} cy={or * 0.66} fill="#4ade80" />
                </>
              )}
              {!site && <circle r={or} cx={or * 0.32} cy={or * 0.18} fill="#05080e" opacity="0.3" />}
              {ownColor && (
                <>
                  <circle className="wm-orb-owned" r={or + 3} fill="none" stroke={ownColor} strokeWidth={2} />
                  <g transform={`translate(${or * 0.72},${-or - 5}) scale(${Math.max(0.7, or / 16)})`}>
                    <path className="wm-orb-star" fill={ownColor}
                      d="M0,-6 L1.6,-1.9 L6,-1.9 L2.4,0.7 L3.7,5 L0,2.4 L-3.7,5 L-2.4,0.7 L-6,-1.9 L-1.6,-1.9 Z" />
                  </g>
                </>
              )}
              <circle className={`wm-orb-ring ${isParent ? 'sel' : ''}`} r={or + 6} />
              <text y={or + 15} textAnchor="middle">{nb.name.toUpperCase()} ▸</text>
            </g>
          );
        })}
      </svg>
      )}

      {/* ===== the station: the map's own art in its owner's livery, its
           modules as tags right under it ===== */}
      {readout.station && !mobile && (
        <svg
          className="wm-station" data-testid="wm-station"
          viewBox="0 0 130 130"
          style={{ left: staX, top: staY, width: staW, height: staH }}
        >
          <g
            data-livery={sp1}
            transform="translate(65 80) scale(1.05)"
            dangerouslySetInnerHTML={{ __html: stationInnerSvg({
              weaponsLevel: myStation?.buildings?.weapons ?? 0,
              labLevel: myStation?.buildings?.lab ?? 0,
              shipyardLevel: myStation?.buildings?.shipyard ?? 0,
              thrustersLevel: (myStation?.buildings as Record<string, number> | undefined)?.trajectory_thrusters ?? 0,
            }, sp1, sp2, staSkin) }}
          />
          {/* Name + HP header — always readable */}
          <text x="65" y="14" textAnchor="middle"
            style={{ font: '700 10px "Audiowide", monospace', letterSpacing: '0.08em', fill: '#d6e2ec' }}>
            {readout.station.name.toUpperCase()}
          </text>
          <rect x="18" y="20" width="94" height="5" rx="2" fill="#0c1219" stroke="#2a3d50" strokeWidth="1" />
          <rect x="18" y="20" width={94 * staHpRatio} height="5" rx="2" fill={hpColor(staHpRatio)} />
          <text x="65" y="33" textAnchor="middle"
            style={{ font: '700 8px "Audiowide", monospace', letterSpacing: '0.06em', fill: hpColor(staHpRatio) }}>
            {Math.round(readout.station.hp)}/{readout.station.maxHp}
          </text>
        </svg>
      )}

      {/* ===== THE STRUCTURES, ON THE WORLD =====
           Each building is a tag standing over its spot on the limb, a
           stem down to it; the station's modules hang under the station.
           Pick one for its card. The STRUCTURES list on the bar holds the
           same buttons as rows. */}
      {orbitKinds.length > 0 && myStation && !(mobile && openTab) && (
        mobile ? (() => {
          const built = orbitKinds.filter(k => Number(myStation.buildings?.[k] ?? 0) > 0);
          return (
            <button type="button" className={`wm-sta-chip${stationOpen ? ' is-on' : ''}`}
              data-testid="wm-col-orbit" data-tutorial-id="wm-columns-orbit" aria-expanded={stationOpen}
              style={{ left: 8, top: staY, maxWidth: vw - 16, height: STA_CHIP_H }}
              onClick={() => { setPicked(null); setStationOpen(o => !o); }}>
              {t('worldmenu.station.chip')}
              <span className="wm-sta-chip-mods">
                {built.length
                  ? built.map(k => (
                    <em key={k}>{tk(`worldmenu.building.${k}`, k.toUpperCase())} <b>{Number(myStation.buildings?.[k] ?? 0)}</b></em>
                  ))
                  : <em>{t('worldmenu.station.none')}</em>}
              </span>
              <span aria-hidden="true">{stationOpen ? '▴' : '▾'}</span>
            </button>
          );
        })() : (
          <div className={`wm-mods${MOD_COLS > 1 ? ' is-grid' : ''}`} data-testid="wm-col-orbit" data-tutorial-id="wm-columns-orbit"
            role="group" aria-label={t('worldmenu.station.aria')}
            style={{ left: modLeft, top: modTop, width: MOD_W, gap: MOD_GAP }}>
            {orbitKinds.map(k => {
              const { level, line, tone, progress } = tagLine(k, myStation, 'orbit');
              const picked = pickedKind === k && pickedColumn === 'orbit';
              return (
                <button key={k} type="button" data-testid={`wm-build-${k}`}
                  className={`wm-mod ${tone}${picked ? ' is-picked' : ''}`} style={{ height: MOD_H }}
                  aria-expanded={picked} title={MOD_COLS > 1 ? `${line} — ${BUILDING_DEFS[k].description}` : BUILDING_DEFS[k].description}
                  onClick={() => clickStructure(k, myStation, 'orbit')}>
                  <span className="wm-mod-nm">{tk(`worldmenu.building.${k}`, k.toUpperCase())}</span>
                  <b>{level > 0 ? level : ''}</b>
                  <span className="wm-mod-st">{line}</span>
                  {progress !== null && <span className="wm-tag-bar"><i style={{ width: `${(progress * 100).toFixed(1)}%` }} /></span>}
                </button>
              );
            })}
          </div>
        )
      )}
      {!myStation && body && canHostStation(body) && !anyStation && (
        <div className="wm-plot" style={{
          left: Math.max(8 + (mobile ? 75 : 84), Math.min(vw - dockW - 8 - (mobile ? 75 : 84), staX + staW / 2)),
          top: staY + staH / 2, width: mobile ? 150 : 168,
        }}>
          {foundBtn('station')}
        </div>
      )}
      {surfTags.length > 0 && myCity && !(mobile && openTab) && (
        <>
          {settled && (
            <svg className="wm-lines" width={vw} height={vh} aria-hidden="true">
              {surfTags.map(s => (
                <path key={s.kind}
                  className={`wm-stem${(pickedKind === s.kind && pickedColumn === 'surface') || hoverKind === s.kind ? ' is-picked' : ''}`}
                  data-wm-line={s.kind} fill="none" d={`M${s.px},${s.py} L${s.end.x},${s.end.y}`} />
              ))}
            </svg>
          )}
          {/* The buildings themselves are buttons too (the tag stays the
              keyboard's way in, so these skip the tab order). */}
          <div className="wm-bhits" aria-hidden="true">
            {surfTags.map(s => (
              <button key={s.kind} type="button" tabIndex={-1} className="wm-bhit"
                data-testid={`wm-bhit-${s.kind}`}
                style={{
                  left: s.base.x, top: s.base.y, width: Math.max(28, s.hitW), height: Math.max(24, s.hitH),
                  transform: `translate(-50%, -100%) rotate(${s.theta}rad)`,
                }}
                onMouseEnter={() => setHoverKind(s.kind)}
                onMouseLeave={() => setHoverKind(null)}
                onClick={() => clickStructure(s.kind as BuildingKind, myCity, 'surface')} />
            ))}
          </div>
          <div className="wm-tags wm-tags-surface" data-testid="wm-col-surface" data-tutorial-id="wm-columns">
            {surfTags.map(s => tagFor(s.kind, myCity, 'surface', {
              left: s.px, top: s.py, width: TAG_W, minHeight: TAG_H, transform: 'translate(-50%, -100%)',
            }))}
          </div>
        </>
      )}
      {!myCity && body && canHostCity(body) && !anyCity && !(mobile && openTab) && (
        <div className="wm-plot" data-tutorial-id="wm-columns"
          style={{ left: cx, top: apexY - (mobile ? 40 : 70), width: mobile ? 170 : 190 }}>
          {foundBtn('city')}
        </div>
      )}

      {stationCard()}
      {structureCard()}

      {/* ===== THE BAR: what you can open on this world ===== */}
      {tabs.length > 0 && !(mobile && (pickedKind || stationOpen)) && (
        <nav className="wm-bar" aria-label={t('worldmenu.bar.aria')} data-testid="wm-bar"
          style={mobile ? undefined : { left: `calc(var(--wm-rail) + (100vw - var(--wm-rail) - var(--wm-dock)) / 2)` }}>
          {tabs.map(x => (
            <button key={x.id} type="button" className={`wm-bar-tab ${x.tone ?? ''}${openTab === x.id ? ' is-on' : ''}`}
              aria-pressed={openTab === x.id} data-testid={`wm-bar-${x.id}`}
              onClick={() => { setPicked(null); setStationOpen(false); openDrawer(openTab === x.id ? null : x.id); }}>
              <span className="wm-bar-nm">{x.label}</span>
              {x.id === 'terraform' && body.terraformCompletesAtTick == null ? (
                <span className="wm-bar-meter"><i style={{ width: `${tfPct}%` }} /></span>
              ) : null}
              <span className="wm-bar-sub">{x.sub}</span>
            </button>
          ))}
        </nav>
      )}

      {openTab === 'structures' && (
        <section className="wm-fleet wm-drawer" data-testid="wm-structures"
          style={mobile ? undefined : { left: 'calc(var(--wm-rail) + (100vw - var(--wm-rail) - var(--wm-dock)) / 2)', transform: 'translateX(-50%)' }}>
          {orbitEls.length > 0 && (
            <div className="wm-msec">
              <div className="wm-msec-label">{t('worldmenu.col.orbit')} — <b>{t('worldmenu.col.station')}</b></div>
              <div className="wm-drawer-grid">{orbitEls}</div>
            </div>
          )}
          {surfaceEls.length > 0 && (
            <div className="wm-msec">
              <div className="wm-msec-label">{t('worldmenu.col.surface')} — <b>{t('worldmenu.col.city')}</b></div>
              <div className="wm-drawer-grid">{surfaceEls}</div>
            </div>
          )}
        </section>
      )}
      {openTab === 'terraform' && tfTab && (
        <section className="wm-fleet wm-drawer wm-drawer-tf" data-testid="wm-terraform-drawer"
          style={mobile ? undefined : { left: 'calc(var(--wm-rail) + (100vw - var(--wm-rail) - var(--wm-dock)) / 2)', transform: 'translateX(-50%)' }}>
          <WmTerraformCard body={body} isMine={isMine} />
        </section>
      )}
      {openTab === 'silo' && myCity && (
        <WmSilo city={myCity} body={body} mobile={mobile} tabs={null} onErr={setErrMsg} />
      )}
      {openTab === 'yard' && (myCity || myStation) && (
        <WmFleet
          bodyId={body.id}
          mobile={mobile}
          isMine={canCommand}
          hasStation={!!myStation}
          railW={railW}
          onErr={setErrMsg}
          onNote={setNoteMsg}
          tabs={null}
        />
      )}
    </div>
  );
};

/* ================= compact fleet box ================= */
const HULL_FEATURE: Partial<Record<string, string>> = {
  frigate: 'hull.frigate', destroyer: 'hull.destroyer', freighter: 'hull.freighter',
};
const WmFleet: React.FC<{
  bodyId: string; mobile: boolean;
  /** You hold a settlement HERE (not: you own the world). The server's
   *  own gate for queueing a hull; see settlementControl.ts. */
  isMine: boolean;
  hasStation: boolean;
  railW: number; onErr: (m: string | null) => void;
  /** Neutral news for the player, e.g. where a refund went. */
  onNote?: (m: string | null) => void;
  /** The YARD / MISSILE SILO tabs, when this city has a silo. */
  tabs?: React.ReactNode;
}> = ({ bodyId, mobile, isMine, hasStation, railW, onErr, onNote, tabs }) => {
  useI18n();
  const { gameState, updateGameState } = useGameContext();
  // Live view for async rollbacks (a poll may land while the POST flies).
  const gsRef = React.useRef(gameState);
  React.useEffect(() => { gsRef.current = gameState; }, [gameState]);
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();
  const [nameDraft, setNameDraft] = useState('');
  // ON-COMPLETION ORDER for ships queued from this panel (migration
  // 0108). Sticky for the whole grid, not per ship cell: a picker on
  // every cell would triple the height of a grid that has to fit a phone.
  // THE YARD'S OWN ORDER, read off the station rather than held in this
  // component. It used to be panel state: set it, queue three ships,
  // close the menu, and the setting was gone — which is fine for a
  // stamp applied at queue time and useless as something a row can
  // defer to. Now the station carries it and queued hulls can follow.
  const yard = gameState.settlements.find(
    st => st.bodyId === bodyId && st.type === 'station' && st.ownedBy === 'player',
  );
  const buildOrder = yard?.defaultBuildOrder ?? null;
  const buildOrderBody = yard?.defaultBuildOrderBodyId ?? null;
  const buildOrderRoute = yard?.defaultBuildOrderRouteId ?? null;
  const buildOrderFleet = yard?.defaultBuildOrderFleetId ?? null;
  // WHICH row the picker is choosing for. NEXT_SHIP is the panel-wide
  // default that applies to the next thing queued; anything else is a
  // build order id being edited on its own. One picker either way --
  // the question "where should this hull go" does not change because
  // the hull already exists in the yard.
  const [orderPickerFor, setOrderPickerFor] = useState<string | null>(null);
  const [routePickerFor, setRoutePickerFor] = useState<string | null>(null);
  // Fleets a new hull could reinforce: mine, and still standing.
  const joinableFleets = useMemo(
    () => (gameState.fleets ?? []).filter(f => f.ownedBy === 'player'),
    [gameState.fleets],
  );

  // Routes this yard may sign a new hull onto: mine, or a partner's lane
  // I am a party to. The server re-checks all of it at spawn -- this
  // list only decides what is worth OFFERING.
  const joinableRoutes = useMemo(() => (gameState.tradeRoutes ?? []).filter(r =>
    r.ownedBy === 'player' || r.counterpartyFactionId === 'player'), [gameState.tradeRoutes]);
  const routeLabel = React.useCallback((r: { id: string; name?: string | null; originBodyId: string; destBodyId: string }) => {
    if (r.name) return r.name;
    const nm = (id: string) => gameState.bodies.find(b => b.id === id)?.name ?? '?';
    return `${nm(r.originBodyId)} → ${nm(r.destBodyId)}`;
  }, [gameState.bodies]);

  // The collapsed line has to answer the question on its own, or hiding
  // the buttons would just hide the setting.
  // The label the order control shows once a route is chosen. Derived,
  // not stored: renaming a route renames it here too.
  const orderRouteName = buildOrderRoute
    ? (() => { const r = joinableRoutes.find(x => x.id === buildOrderRoute); return r ? routeLabel(r) : '?'; })()
    : '?';
  const slots = shipyardSlotsAtBody(bodyId, 'player', gameState.settlements);
  // EVERY order, not the first six. The list was sliced to six because
  // the queue column could not scroll (a scroller clipped the rush
  // popover); the seventh hull onward was simply not drawn. The desktop
  // queue now scrolls and the rush popover renders outside it.
  const orders = gameState.buildOrders
    .filter(o => o.bodyId === bodyId && o.ownedBy === 'player');
  // MP tags queue state server-side; undefined status = building (legacy).
  const building = orders.filter(o => o.status !== 'waiting');
  const waiting = orders.filter(o => o.status === 'waiting');
  // Player faction livery for the ship icons (two-tone §5).
  const pf = gameState.factions.find(f => f.id === 'player');
  const p1 = pf?.color ?? '#8b6fd0';
  const p2 = pf?.color2 || deriveSecondary(p1);
  // The whole active design, not just its icon. This lookup already
  // existed and threw the parts away, which is how the build cards came
  // to quote a bare hull while the yard charged for the loadout: a
  // player with 49 metal was told a frigate cost 45 and then rejected
  // for needing 55.
  //
  // WHICH TEMPLATE, per class. The yard built only the ACTIVE design, so
  // queueing a miner after a batch of cargo freighters meant a trip to
  // the fleet designer to flip the active template (Lorne, 2026-09-30).
  // A class with two or more saved designs now carries a picker under
  // its cell; the pick drives the price, the icon and the build itself,
  // and falls back to the active design when nothing (or a deleted
  // design) is picked.
  const [templatePick, setTemplatePick] = useState<Record<string, string>>({});
  const activeDesignOf = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    gameState.shipDesigns?.find(d => d.shipClass === cls && d.id === templatePick[cls])
      ?? gameState.shipDesigns?.find(d => d.shipClass === cls && d.isActive);
  const activeVariant = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    activeDesignOf(cls)?.iconVariant;
  /** The look's NAME, under the hull: the design is the ship you get. */
  const lookNameOf = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    ICON_VARIANT_NAMES[cls]?.[activeVariant(cls) ?? DEFAULT_SHIP_ICONS[cls]] ?? '';
  /** Step the picked design for a hull (desktop arrows). */
  const cycleDesign = (cls: (typeof BUILDABLE_CLASSES)[number], dir: 1 | -1) => {
    const list = buildChoices(cls, gameState.shipDesigns);
    if (list.length < 2) return;
    const cur = activeDesignOf(cls);
    const i = Math.max(0, list.findIndex(d => d.id === cur?.id));
    const next = list[(i + dir + list.length) % list.length];
    setTemplatePick(p => ({ ...p, [cls]: next.id }));
  };
  /** Phone: the hull whose design sheet is open. */
  const [pickFor, setPickFor] = useState<(typeof BUILDABLE_CLASSES)[number] | null>(null);
  const openDesigner = (cls?: (typeof BUILDABLE_CLASSES)[number]) =>
    window.dispatchEvent(new CustomEvent('orbital:open-ship-designer', { detail: { shipClass: cls } }));

  // Price dials, same as BuildPanel: host config x senate
  // ship_build_cost_multiplier x Construction discount, all folded into
  // gameState.buildCost.mult by the server's own buildCostFactors(). The
  // queue rows below already take this (they get buildCost passed
  // straight in) -- so the RECEIPT was right and only the PRICE TAG was
  // wrong. Scale THEN ceil, parts included, because that is the order
  // worker/actions.js uses and rounding the other way is off by one.
  const costMult = gameState.buildCost?.mult ?? 1;
  const priceLaw = gameState.buildCost?.law ?? 1;
  const priced = (n: number) => Math.ceil(n * costMult);

  const buildShip = async (cls: (typeof BUILDABLE_CLASSES)[number]) => {
    onErr(null);
    const existing = new Set<string>([
      ...gameState.ships.map(s => s.name),
      ...gameState.buildOrders.map(o => o.shipName).filter(Boolean) as string[],
    ]);
    // THE PLAYER'S OWN NAMES FIRST, in the order they wrote them.
    // A typed name still wins over both — you asked for that hull to
    // be called that.
    const shipName = nameDraft.trim()
      || pickFromPool(gameState.namePools?.ship, existing)
      || randomShipName(cls, existing);
    setNameDraft('');
    // Optimistic queue row - THE build path players actually use (the
    // world menu), which the earlier BuildPanel-only optimism missed
    // entirely; this is why "build, very specifically, takes a beat".
    // Same contract as BuildPanel/TechPanel: the row appears NOW with
    // status 'waiting' (the server decides slot promotion), the next
    // /state replaces it wholesale, a rejection rolls it back via the
    // live ref (never the stale closure).
    const optimisticId = `opt_${Date.now()}_${cls}`;
    // WILL IT START, OR WAIT? The row used to claim 'waiting'
    // unconditionally on the reasoning that the server owns slot
    // promotion. It does — but it decides with `inFlight < slots`, which
    // is arithmetic this panel already has in front of it, and being
    // wrong about it is not free: a yard with both slots open drew SLOTS
    // 0/2 over two rows marked "queued", which reads as a queue that has
    // stalled rather than one that has not been answered yet. Reported
    // as "I keep queuing ships with open slots and they get stuck in
    // queued".
    //
    // Mirrors startsNow in worker/actions.js handleQueueBuild. If the
    // two ever disagree the poll corrects it within the tick, which is
    // the same safety net every other optimistic row here relies on.
    const startsNow = building.length < slots;
    updateGameState({
      buildOrders: [
        // Live ref, not the closed-over snapshot: a poll landing
        // between render and click leaves `gameState` an array the
        // server has already moved past, and appending to it would
        // resurrect the rows it dropped. Same reasoning as the
        // rollback below.
        ...gsRef.current.buildOrders,
        {
          id: optimisticId,
          bodyId,
          shipClass: cls,
          ownedBy: 'player',
          startTick: gameState.currentTick,
          completeTick: gameState.currentTick + getShipClass(cls).buildTime,
          shipName,
          iconVariant: activeVariant(cls),
          status: startsNow ? 'building' : 'waiting',
        },
      ],
    });
    const chosen = activeDesignOf(cls);
    const req = mpActions?.build({
      bodyId, shipClass: cls, shipName, iconVariant: activeVariant(cls),
      // The SPECIFIC design shown on the cell, so what the yard builds is
      // what the card priced. Omitted with no design at all, which keeps
      // the server's old active-design / bare-hull fallback.
      ...(chosen ? { designId: chosen.id } : {}),
      // ORDERS THAT SURVIVE THE BUILD. Sticky across the panel rather
      // than per-row: you are usually queueing a batch for one purpose,
      // and a picker on every ship cell would triple the height of a
      // grid that already has to fit a phone.
      //
      // A half-set order (GO TO with no destination, JOIN with no route)
      // sends NOTHING rather than a bare verb the server would reject --
      // the button cannot reach that state, but the type can.
      // NOTHING. A new row carries no order of its own and therefore
      // follows the yard, which is resolved at roll-out rather than
      // stamped in here. That is what lets changing the yard's order
      // re-aim the hulls already queued under it -- stamping made every
      // row a fossil of whatever the panel said at the time.
    });
    // Register the request against the row it drew, so a ✕ pressed
    // before the next poll can still name the order to the server.
    trackPendingBuild(
      optimisticId,
      Promise.resolve(req).then(r => (r && r.ok ? r.orderId ?? null : null)),
    );
    const res = await req;
    if (res && !res.ok) {
      updateGameState({
        buildOrders: gsRef.current.buildOrders.filter(o => o.id !== optimisticId),
      });
      onErr(res.error ?? t('worldmenu.err.buildRejected'));
    }
  };

  // Cancel a queued OR in-progress ship build. Server (handleCancelBuild)
  // marks cancelled_at_tick and refunds the metal/credits spent at queue
  // time; the /state poll drops the row.
  const cancelBuild = async (orderId: string) => {
    onErr(null);
    // An optimistic row has a local id the server has never heard of.
    // Resolve it through the build request that drew it rather than
    // posting the local id and getting "build order not found" for a
    // row the player can plainly see.
    const serverId = await resolveServerOrderId(orderId);
    if (!serverId) {
      onErr(t('worldmenu.err.stillPlacing'));
      return;
    }
    // Drop it locally NOW. Cancelling used to wait on the next /state
    // poll to notice, which read as the queue ignoring the click.
    updateGameState({
      buildOrders: gsRef.current.buildOrders.filter(o => o.id !== orderId),
    });
    const res = await mpActions?.cancelBuild(serverId);
    // A rejected cancel needs no rollback: the row is still the
    // server's, so the next poll puts it back — which is the honest
    // signal that it was not cancelled.
    if (res && !res.ok) onErr(res.error ?? t('worldmenu.err.cantCancel'));
    // SAY WHERE THE MONEY WENT. An order paid from a raw world's own
    // stockpile is refunded THERE (the anti-laundering rule), so the pool
    // in the top bar does not move, and a player who cancelled fifteen
    // hulls concluded he had been robbed (2026-10-12).
    if (res && res.ok && res.refund && (res.refund.metal > 0 || res.refund.gold > 0)) {
      const loc = res.refund.local.find(l => l.metal > 0 || l.gold > 0);
      if (loc) {
        const name = gsRef.current.settlements.find(s => loc.settlementId === s.id || loc.settlementId.endsWith(`:${s.id}`))?.name
          ?? t('worldmenu.q.thisStation');
        onNote?.(t('worldmenu.q.refundLocal', { metal: loc.metal, gold: loc.gold, name }));
      } else {
        onNote?.(t('worldmenu.q.refundPool', { metal: res.refund.metal, gold: res.refund.gold }));
      }
    }
  };

  // Write the yard's standing order. Optimistic through the same
  // channel as everything else here: the select has to answer the
  // click, and the poll confirms it a beat later.
  const setYardOrder = async (intent: {
    buildOrder?: 'go_to' | 'defensive' | 'hold' | 'trade_route' | 'join_fleet' | 'stay';
    buildOrderBodyId?: string;
    buildOrderRouteId?: string;
    buildOrderFleetId?: string;
  }) => {
    if (!yard) return;
    onErr(null);
    const before = gsRef.current.settlements.find(st => st.id === yard.id);
    const write = (st: typeof before) => (st ? {
      ...st,
      defaultBuildOrder: intent.buildOrder ?? null,
      defaultBuildOrderBodyId: intent.buildOrderBodyId ?? null,
      defaultBuildOrderRouteId: intent.buildOrderRouteId ?? null,
      defaultBuildOrderFleetId: intent.buildOrderFleetId ?? null,
    } : st);
    updateGameState({
      settlements: gsRef.current.settlements.map(st => (st.id === yard.id ? write(st)! : st)),
    });
    const res = await mpActions?.setYardOrder(yard.id, intent);
    if (res && !res.ok) {
      onErr(res.error ?? t('worldmenu.err.cantSetOrder'));
      if (before) {
        updateGameState({
          settlements: gsRef.current.settlements.map(st => (st.id === yard.id ? before : st)),
        });
      }
    }
  };

  // Retarget ONE queued hull. Optimistic, for the same reason the queue
  // row itself is: the dropdown has to answer the click, not the poll.
  // A rejection rolls back through the live ref and says why.
  const setRowOrder = async (
    orderId: string,
    intent: {
      buildOrder?: 'go_to' | 'defensive' | 'hold' | 'trade_route' | 'join_fleet' | 'stay';
      buildOrderBodyId?: string;
      buildOrderRouteId?: string;
      buildOrderFleetId?: string;
    },
  ) => {
    onErr(null);
    const before = gsRef.current.buildOrders.find(o => o.id === orderId);
    const apply = (row: typeof before) => (row ? {
      ...row,
      buildOrder: intent.buildOrder ?? null,
      buildOrderBodyId: intent.buildOrderBodyId ?? null,
      buildOrderRouteId: intent.buildOrderRouteId ?? null,
      buildOrderFleetId: intent.buildOrderFleetId ?? null,
    } : row);
    updateGameState({
      buildOrders: gsRef.current.buildOrders.map(o => (o.id === orderId ? apply(o)! : o)),
    });
    // A row the server has never named cannot be retargeted by id.
    // Resolve it through the build request that drew it first.
    const serverId = await resolveServerOrderId(orderId);
    if (!serverId) {
      onErr(t('worldmenu.err.stillPlacing'));
      if (before) {
        updateGameState({
          buildOrders: gsRef.current.buildOrders.map(o => (o.id === orderId ? before : o)),
        });
      }
      return;
    }
    const res = await mpActions?.setBuildOrder(serverId, intent);
    if (res && !res.ok) {
      onErr(res.error ?? t('worldmenu.err.cantSetOrder'));
      if (before) {
        updateGameState({
          buildOrders: gsRef.current.buildOrders.map(o => (o.id === orderId ? before : o)),
        });
      }
    }
  };

  /** The label a queued row's order wears, or null for "wait here". */
  const rowOrderLabel = (o: typeof orders[number]): string | null => {
    if (!o.buildOrder) return null;
    if (o.buildOrder === 'go_to') {
      return t('worldmenu.order.goTo', { name: gameState.bodies.find(b => b.id === o.buildOrderBodyId)?.name ?? '?' });
    }
    if (o.buildOrder === 'join_fleet') {
      return t('worldmenu.order.join', { name: joinableFleets.find(f => f.id === o.buildOrderFleetId)?.name ?? t('worldmenu.order.fleetDefault') });
    }
    if (o.buildOrder === 'trade_route') {
      const r = joinableRoutes.find(x => x.id === o.buildOrderRouteId);
      return t('worldmenu.order.join', { name: r ? routeLabel(r) : t('worldmenu.order.routeDefault') });
    }
    if (o.buildOrder === 'stay') return t('worldmenu.order.wait');
    return o.buildOrder === 'defensive' ? t('worldmenu.order.defend') : t('worldmenu.order.hold');
  };

  /** What the yard is doing, worded for the row's follow option. Null
   *  when the yard has no opinion — the rows then read "wait here",
   *  which is what they will actually do. */
  const yardOrderLabel: string | null = !buildOrder ? null
    : buildOrder === 'go_to'
      ? t('worldmenu.yard.goTo', { name: gameState.bodies.find(b => b.id === buildOrderBody)?.name ?? '?' })
      : buildOrder === 'join_fleet'
        ? t('worldmenu.yard.join', { name: joinableFleets.find(f => f.id === buildOrderFleet)?.name ?? t('worldmenu.order.fleetDefault') })
        : buildOrder === 'trade_route'
          ? t('worldmenu.yard.join', { name: orderRouteName })
          : buildOrder === 'defensive' ? t('worldmenu.yard.defend') : t('worldmenu.yard.hold');

  // THE PER-HULL ORDER, one control for both layouts. A row with no
  // order of its own follows the yard; one that has its own reads in
  // teal (.is-own) so an override stands out in a scan.
  const orderSelect = (o: typeof orders[number]) => (
    <select
      className={`wm-qorder${o.buildOrder ? ' is-own' : ''}`}
      value={o.buildOrder === 'join_fleet' && o.buildOrderFleetId
        ? `fleet:${o.buildOrderFleetId}`
        : o.buildOrder ?? ''}
      aria-label={t('worldmenu.order.startingFor', { name: o.shipName ?? o.shipClass })}
      title={t('worldmenu.order.rowTitle')}
      onChange={e => {
        const v = e.target.value;
        if (v === 'go_to') { setOrderPickerFor(o.id); return; }
        if (v === 'trade_route') { setRoutePickerFor(o.id); return; }
        if (v.startsWith('fleet:')) {
          void setRowOrder(o.id,
            { buildOrder: 'join_fleet', buildOrderFleetId: v.slice('fleet:'.length) });
          return;
        }
        if (v === 'stay') { void setRowOrder(o.id, { buildOrder: 'stay' }); return; }
        void setRowOrder(o.id, v === 'defensive' ? { buildOrder: 'defensive' } : {});
      }}
    >
      {/* FIRST, and the default: a row with no order of its own
          does whatever the yard is doing, and keeps doing it if
          the yard changes its mind. */}
      <option value="">
        {t('worldmenu.order.yard', { order: yardOrderLabel ?? t('worldmenu.yard.wait') })}
      </option>
      <option value="stay">{t('worldmenu.order.wait')}</option>
      <option value="defensive">{t('worldmenu.order.defend')}</option>
      <option value="go_to">
        {o.buildOrder === 'go_to' ? rowOrderLabel(o) : t('worldmenu.order.goToEllipsis')}
      </option>
      {/* SHOWN EVEN WHEN THERE IS NOTHING TO JOIN, disabled and
          saying why. Hiding them made the two best verbs invisible
          to anyone who had not already formed a fleet or laid a
          lane — which is everyone, the first time. "Don't see it"
          was exactly that: the option was correct to be
          unselectable and wrong to be absent. */}
      {joinableFleets.length > 0
        ? joinableFleets.map(f => (
          <option key={f.id} value={`fleet:${f.id}`}>{t('worldmenu.order.join', { name: f.name })}</option>
        ))
        : <option value="__no_fleets" disabled>{t('worldmenu.order.noFleets')}</option>}
      {joinableRoutes.length > 0 ? (
        <option value="trade_route">
          {o.buildOrder === 'trade_route' ? rowOrderLabel(o) : t('worldmenu.order.joinRouteEllipsis')}
        </option>
      ) : (
        <option value="__no_routes" disabled>{t('worldmenu.order.noRoutes')}</option>
      )}
    </select>
  );

  const qRow = (o: typeof orders[number], isBuilding: boolean) => {
    const span = Math.max(1, o.completeTick - o.startTick);
    const done = Math.max(0, Math.min(1, (gameState.currentTick - o.startTick) / span));
    const eta = Math.max(0, o.completeTick - gameState.currentTick);
    return (
      <div className={`wm-qrow ${isBuilding ? 'building' : 'waiting'}`} key={o.id}>
        <div className="wm-qhead">
          <ShipIcon shipClass={o.shipClass} variant={o.iconVariant} size={15} color={p1} color2={p2} />
          <span className="wm-qnm">{o.shipName ?? o.shipClass}</span>
          <span className="wm-qeta">{isBuilding ? `T-${eta}` : t('worldmenu.q.queued')}</span>
          {o.botched && (
            <span
              title={t('worldmenu.q.botched')}
              style={{ color: '#ff8a5c', fontSize: 10, flex: '0 0 auto' }}
            >⚠</span>
          )}
          {isMine && isBuilding && eta > 1 && (
            // Rush (§3): confirm popover with cost + new ETA + the 25%
            // half-hull risk. Same control the BuildPanel rows use.
            <RushControl
              order={o}
              remaining={eta}
              constructionLvl={gameState.factionTech?.player?.levels?.construction ?? 0}
              buildCost={gameState.buildCost}
            />
          )}
          {isMine && (
            <button
              className="wm-qcancel"
              onClick={() => cancelBuild(o.id)}
              title={isBuilding ? t('worldmenu.q.cancelBuilding') : t('worldmenu.q.cancelQueued')}
              aria-label={t('worldmenu.q.cancelBuild')}
            >✕</button>
          )}
        </div>
        {isMine && orderSelect(o)}
        <div className="wm-qbar">
          <i style={{ width: `${(isBuilding ? done : 0) * 100}%` }} />
        </div>
      </div>
    );
  };

  // OPTION A (desktop): one line per hull -- name, its own starting
  // order, ETA, rush, cancel -- so a long queue scrolls instead of
  // running off the bottom of the box (Lorne, 2026-09-30: "the build
  // queue struggles when you have more than 4 ships in queue").
  const qLine = (o: typeof orders[number], isBuilding: boolean, pos: number) => {
    const span = Math.max(1, o.completeTick - o.startTick);
    const done = Math.max(0, Math.min(1, (gameState.currentTick - o.startTick) / span));
    const eta = Math.max(0, o.completeTick - gameState.currentTick);
    return (
      <div className={`wm-qline ${isBuilding ? 'building' : 'waiting'}`} key={o.id} data-testid="wm-qline">
        <div className="wm-qline__row">
          <ShipIcon shipClass={o.shipClass} variant={o.iconVariant} size={16} color={p1} color2={p2} />
          <span className="wm-qnm">
            {!isBuilding && <i className="wm-qpos">{pos}</i>}
            {o.shipName ?? o.shipClass}
          </span>
          {isMine ? orderSelect(o) : <span />}
          <span className="wm-qline__end">
            {o.botched && (
              <span title={t('worldmenu.q.botched')} style={{ color: '#ff8a5c' }}>⚠</span>
            )}
            <span className="wm-qeta">{isBuilding ? `T-${eta}` : t('worldmenu.q.queued')}</span>
            {isMine && isBuilding && eta > 1 && (
              <RushControl
                order={o}
                remaining={eta}
                constructionLvl={gameState.factionTech?.player?.levels?.construction ?? 0}
                buildCost={gameState.buildCost}
              />
            )}
            {isMine && (
              <button
                className="wm-qcancel"
                onClick={() => cancelBuild(o.id)}
                title={isBuilding ? t('worldmenu.q.cancelBuilding') : t('worldmenu.q.cancelQueued')}
                aria-label={t('worldmenu.q.cancelNamed', { name: o.shipName ?? t('worldmenu.q.buildWord') })}
              >✕</button>
            )}
          </span>
        </div>
        {isBuilding && <div className="wm-qbar"><i style={{ width: `${done * 100}%` }} /></div>}
      </div>
    );
  };

  // ONE HULL'S NUMBERS, for whichever layout draws it: what the yard will
  // charge for the picked template, why, and whether it can be built.
  const hullInfo = (cls: (typeof BUILDABLE_CLASSES)[number]) => {
    const def = getShipClass(cls);
    // What the yard will ACTUALLY charge: bare hull + the picked
    // design's parts, then scaled by the price dials. Empty slots are
    // free, so no design means no surcharge.
    const parts = sanitizeParts(activeDesignOf(cls)?.parts ?? []);
    const pc = partsCost(parts, cls);
    const costOre = priced(def.cost.ore + pc.ore);
    const costCredits = priced(def.cost.credits + pc.credits);
    const dial = (label: string, m: number | undefined) =>
      m != null && Math.abs(m - 1) > 1e-9
        ? `${label}: ${m < 1 ? '−' : '+'}${Math.round(Math.abs(1 - m) * 100)}%`
        : '';
    const stats = computeDesignStats(cls, parts, gameState.factionTech?.player?.levels ?? {});
    // "Economy has been so confusing this game" was the other half of
    // the report. A correct-but-unexplained number still reads as a bug,
    // so the tooltip itemises it: bare hull, what the loadout added,
    // what a law did, total.
    const priceWhy = [
      t('worldmenu.why.build', { name: def.displayName, ticks: def.buildTime }),
      t('worldmenu.why.hull', { ore: def.cost.ore, credits: def.cost.credits }),
      pc.ore || pc.credits ? t('worldmenu.why.loadout', { ore: pc.ore, credits: pc.credits }) : '',
      // EVERY dial that moves the total gets a line. This listed the
      // senate law only, while `priced` also applies the host's price
      // setting and the Construction discount, so a player at
      // Construction 10 read "Hull 1000M + Loadout 580M = Total 790M"
      // ("Math aint mathing"). Lines above are list prices, these are
      // multipliers, the total is what the yard takes.
      dial(t('worldmenu.why.gameSetting'), gameState.buildCost?.config),
      dial(t('worldmenu.why.senateLaw'), priceLaw),
      dial(t('worldmenu.why.constructionResearch', { lv: gameState.buildCost?.constructionLevel ?? 0 }), gameState.buildCost?.tech),
      t('worldmenu.why.total', { ore: costOre, credits: costCredits }),
      // The hull's real fighting numbers with this loadout and your
      // research. def.firepower is a legacy display field and def.hp
      // the bare hull, neither of which is what launches.
      t('worldmenu.why.damage', { dmg: stats.damagePerTick, hp: stats.hp }),
    ].filter(Boolean).join('\n');
    const feat = HULL_FEATURE[cls];
    const lockObj = feat ? gate.lockReason(feat as Parameters<typeof gate.lockReason>[0]) : null;
    const lock = lockObj ? `${lockObj.label} — ${lockObj.text}` : null;
    const noYard = slots <= 0;
    const disabled = !isMine || !!lock || noYard;
    const templates = buildChoices(cls, gameState.shipDesigns);
    const picked = activeDesignOf(cls);
    return { def, costOre, costCredits, priceWhy, lock, lockObj, noYard, disabled, templates, picked };
  };

  // The template picker, same control in both layouts.
  const templateSelect = (cls: (typeof BUILDABLE_CLASSES)[number], h: ReturnType<typeof hullInfo>, className: string) => (
    <select
      className={className}
      data-testid={`wm-template-${cls}`}
      value={h.picked?.id ?? ''}
      onChange={e => setTemplatePick(p => ({ ...p, [cls]: e.target.value }))}
      aria-label={t('worldmenu.template.aria', { name: h.def.displayName })}
      title={t('worldmenu.template.title', { name: h.def.displayName })}
    >
      {h.templates.map(d => (
        <option key={d.id} value={d.id}>{d.name}{d.isActive ? ' ★' : ''}</option>
      ))}
    </select>
  );

  return (
    <section
      className="wm-fleet"
      // Centred in the space BETWEEN the outliner and the dock rail, like
      // the rest of the world menu -- not on the window. At 960 px wide a
      // window-centred box ran under the outliner's column.
      style={mobile ? undefined : {
        left: 'calc(var(--wm-rail) + (100vw - var(--wm-rail) - var(--wm-dock)) / 2)',
        transform: 'translateX(-50%)',
      }}
      data-testid="wm-fleet"
      data-tutorial-id="wm-build"
    >
      {tabs}
      {/* SETTINGS STRIP. Slots, the name field and ON COMPLETION are one
          thing -- configuration for the NEXT hull you queue -- so they sit
          together above the two content panes rather than competing with
          them for width. ON COMPLETION used to be a third column here,
          which is why its label wrapped and its value truncated: a
          horizontal label needs horizontal room. */}
      <div className="wm-fleet-set">
        <span className="wm-fleet-title">
          {t('worldmenu.slots')} <b>{building.length}/{Math.max(slots, building.length)}</b>
        </span>
        <input
          className="wm-name-input"
          type="text"
          maxLength={28}
          value={nameDraft}
          onChange={e => setNameDraft(e.target.value)}
          placeholder={t('worldmenu.nameNext')}
          data-testid="wm-ship-name"
        />
        {isMine && hasStation && (
          <span className="wm-oncomplete">
            <span className="wm-oncomplete__k">{t('worldmenu.yardOrder')}</span>
            {/* A single-choice setting with a default IS a select. Four
                always-visible buttons spent two rows saying one value,
                and the collapsed summary then said it a second time.
                'go_to' and 'trade_route' open a picker and do NOT commit
                until something is picked -- cancelling snaps the control
                back to whatever was already set, because it is
                controlled off buildOrder. */}
            <select
              className="wm-oncomplete__sel"
              value={buildOrder === 'join_fleet' && buildOrderFleet
                ? `fleet:${buildOrderFleet}`
                : buildOrder ?? ''}
              title={t('worldmenu.yardOrderTitle')}
              onChange={e => {
                const v = e.target.value;
                if (v === 'go_to') { setOrderPickerFor(NEXT_SHIP); return; }
                if (v === 'trade_route') { setRoutePickerFor(NEXT_SHIP); return; }
                // Fleets are listed individually rather than behind a
                // second picker: you have a handful, they have names,
                // and one dropdown is fewer clicks than a dropdown plus
                // a modal.
                if (v.startsWith('fleet:')) {
                  void setYardOrder({
                    buildOrder: 'join_fleet',
                    buildOrderFleetId: v.slice('fleet:'.length),
                  });
                  return;
                }
                void setYardOrder(v === 'defensive' ? { buildOrder: 'defensive' } : {});
              }}
            >
              <option value="">{t('worldmenu.order.wait')}</option>
              <option value="defensive">{t('worldmenu.order.defend')}</option>
              <option value="go_to">
                {buildOrder === 'go_to' && buildOrderBody
                  ? t('worldmenu.order.goTo', { name: gameState.bodies.find(b => b.id === buildOrderBody)?.name ?? '?' })
                  : t('worldmenu.order.goToEllipsis')}
              </option>
              {/* Same reasoning as the per-row control below: an absent
                  option teaches that the feature does not exist. */}
              {joinableFleets.length > 0
                ? joinableFleets.map(f => (
                  <option key={f.id} value={`fleet:${f.id}`}>{t('worldmenu.order.join', { name: f.name })}</option>
                ))
                : <option value="__no_fleets" disabled>{t('worldmenu.order.noFleets')}</option>}
              {joinableRoutes.length > 0 ? (
                <option value="trade_route">
                  {buildOrder === 'trade_route' && buildOrderRoute
                    ? t('worldmenu.order.join', { name: orderRouteName })
                    : t('worldmenu.order.joinRouteEllipsis')}
                </option>
              ) : (
                <option value="__no_routes" disabled>{t('worldmenu.order.noRoutes')}</option>
              )}
            </select>
          </span>
        )}
      </div>

      {/* Route picker, inline under the strip: routes are not places, so
          the body picker cannot serve. */}
      {routePickerFor && (
        <div className="wm-routepick">
          <div className="wm-routepick__k">
            {routePickerFor === NEXT_SHIP ? t('worldmenu.routePick.newShips') : t('worldmenu.routePick.thisHull')}
          </div>
          {joinableRoutes.map(r => (
            <button
              key={r.id}
              type="button"
              className={`wm-routepick__r${buildOrderRoute === r.id ? ' is-on' : ''}`}
              onClick={() => {
                if (routePickerFor === NEXT_SHIP) {
                  void setYardOrder({ buildOrder: 'trade_route', buildOrderRouteId: r.id });
                } else {
                  void setRowOrder(routePickerFor,
                    { buildOrder: 'trade_route', buildOrderRouteId: r.id });
                }
                setRoutePickerFor(null);
              }}
            >{routeLabel(r)}</button>
          ))}
          <button
            type="button"
            className="wm-routepick__x"
            onClick={() => setRoutePickerFor(null)}
          >{t('worldmenu.cancel')}</button>
        </div>
      )}
      {orderPickerFor && (
        <TransferTargetPicker
          bodies={gameState.bodies}
          tick={gameState.currentTick}
          excludeBodyId={bodyId}
          title={orderPickerFor === NEXT_SHIP ? t('worldmenu.sendNew') : t('worldmenu.sendThis')}
          onPick={(id) => {
            if (orderPickerFor === NEXT_SHIP) {
              void setYardOrder({ buildOrder: 'go_to', buildOrderBodyId: id });
            } else {
              void setRowOrder(orderPickerFor, { buildOrder: 'go_to', buildOrderBodyId: id });
            }
            setOrderPickerFor(null);
          }}
          onClose={() => setOrderPickerFor(null)}
        />
      )}

      <div className={`wm-fleet-body${mobile ? '' : ' wm-fleet-body--list'}`}>
      <div className="wm-fleet-queue">
        {mobile ? (
          <>
            <div className="wm-fleet-sub">{t('worldmenu.inYard')}</div>
            {building.map(o => qRow(o, true))}
            {waiting.map(o => qRow(o, false))}
          </>
        ) : (
          <>
            <div className="wm-yardhead">
              <span className="wm-fleet-sub">{t('worldmenu.inYard')}</span>
              <span className="wm-yardcount" data-testid="wm-yardcount">
                <b className="is-building">{building.length}</b> {t('worldmenu.yardBuilding')} · <b>{waiting.length}</b> {t('worldmenu.q.queued')}
              </span>
            </div>
            {orders.length > 0 && (
              <div className="wm-qcols" aria-hidden="true">
                <span /><span>{t('worldmenu.qcol.ship')}</span><span>{t('worldmenu.qcol.onLaunch')}</span><span />
              </div>
            )}
            <div className="wm-qlist" data-testid="wm-qlist">
              {building.map(o => qLine(o, true, 0))}
              {waiting.map((o, i) => qLine(o, false, building.length + i + 1))}
            </div>
          </>
        )}
        {orders.length === 0 && (
          <div className="wm-qrow empty">{hasStation ? (slots > 0 ? t('worldmenu.slotsIdle') : t('worldmenu.needYard')) : t('worldmenu.noStationYet')}</div>
        )}
      </div>
      {mobile ? (
      <div className="wm-fleet-grid">
        {BUILDABLE_CLASSES.map(cls => {
          const h = hullInfo(cls);
          return (
            <div key={cls} className="wm-shipslot">
            <button
              className="wm-shipcell"
              disabled={h.disabled}
              title={h.lock ?? (h.noYard ? t('worldmenu.buildYardFirst') : h.priceWhy)}
              onClick={() => buildShip(cls)}
              data-testid={`wm-ship-${cls}`}
            >
              {/* single row: icon+name left, all meta stacked in the
                  right-side blank space — nothing wraps or spills. */}
              <span className="wm-shipmain">
                <ShipIcon shipClass={cls} variant={activeVariant(cls)} size={30} color={p1} color2={p2} />
                <span className="wm-shipnm">{h.lock ? '🔒 ' : ''}{h.def.displayName.toUpperCase()}</span>
              </span>
              <span className="wm-shipmeta">
                {h.costOre}m · {h.costCredits}c · {h.def.buildTime}t
              </span>
            </button>
            {h.templates.length > 0 && !h.lock && (
              <button
                type="button"
                className="wm-shipdesign"
                onClick={() => setPickFor(cls)}
                aria-label={t('worldmenu.pick.change')}
                data-testid={`wm-shipdesign-${cls}`}
              >
                <span className="wm-shipdesign__nm">{h.picked?.name ?? h.templates[0].name}</span>
                <span className="wm-shipdesign__look">{lookNameOf(cls)}</span>
                <span className="wm-shipdesign__caret" aria-hidden>▾</span>
              </button>
            )}
            </div>
          );
        })}
        <button
          className="wm-shipcell design"
          onClick={() => openDesigner()}
        >
          <span className="wm-shipmain"><span className="wm-shipnm">{t('worldmenu.design')}</span></span>
          <span className="wm-shipmeta">{t('worldmenu.customHull')}</span>
        </button>
      </div>
      ) : (
      /* OPTION A: the build list. One row per hull, a template on EVERY
         row (a hull with no saved design says so instead), and BUILD its
         own button -- the whole-cell button was what kept a dropdown out
         of the cell. */
      <div className="wm-hulls" data-testid="wm-hulls">
        <div className="wm-hullrow wm-hullrow--head" aria-hidden="true">
          <span>{t('worldmenu.hcol.hull')}</span><span>{t('worldmenu.hcol.template')}</span><span>{t('worldmenu.hcol.cost')}</span><span>{t('worldmenu.hcol.time')}</span><span />
        </div>
        {BUILDABLE_CLASSES.map(cls => {
          const h = hullInfo(cls);
          return (
            <div key={cls} className={`wm-hullrow${h.lock ? ' is-locked' : ''}`} data-testid={`wm-hull-${cls}`}>
              <span className="wm-hullnm">
                <ShipIcon shipClass={cls} variant={activeVariant(cls)} size={36} color={p1} color2={p2} />
                <span className="wm-hullnm__txt">
                  {h.def.displayName.toUpperCase()}
                  {!h.lock && <i className="wm-hullnm__look">{lookNameOf(cls)}</i>}
                </span>
              </span>
              {h.lock ? (
                <span className="wm-hulllock" title={h.lock}>🔒 {h.lockObj?.label}</span>
              ) : h.templates.length > 0 ? (
                <span className="wm-hullpick">
                  {h.templates.length > 1 && (
                    <button type="button" className="wm-hullstep" onClick={() => cycleDesign(cls, -1)}
                      aria-label={t('worldmenu.pick.prev')}>‹</button>
                  )}
                  {templateSelect(cls, h, 'wm-hulltpl')}
                  {h.templates.length > 1 && (
                    <button type="button" className="wm-hullstep" onClick={() => cycleDesign(cls, 1)}
                      aria-label={t('worldmenu.pick.next')}>›</button>
                  )}
                </span>
              ) : (
                <span className="wm-hulltpl is-bare" title={t('worldmenu.bareTitle')}>{tk('worldmenu.bareHull', 'Bare hull')}</span>
              )}
              <span className="wm-hullcost">{h.costOre}m · {h.costCredits}c</span>
              <span className="wm-hulltime">{h.def.buildTime}t</span>
              <button
                className="wm-hullbuild"
                disabled={h.disabled}
                title={h.lock ?? (h.noYard ? t('worldmenu.buildYardFirst') : h.priceWhy)}
                onClick={() => buildShip(cls)}
                data-testid={`wm-ship-${cls}`}
              >{t('worldmenu.build')}</button>
            </div>
          );
        })}
        <button
          className="wm-hulldesign"
          onClick={() => openDesigner()}
        >{t('worldmenu.designTemplate')}</button>
      </div>
      )}
      </div>
      {/* PHONE: choose a design for one hull. Opened from the cell's
          design line; tapping a row picks it for this yard (the same
          templatePick the desktop select writes), BUILD builds it. */}
      {pickFor && (() => {
        const cls = pickFor;
        const h = hullInfo(cls);
        const def = getShipClass(cls);
        const list = h.templates;
        const picked = activeDesignOf(cls);
        return createPortal(
          <div className="wm-dsheet__scrim" onClick={() => setPickFor(null)}>
            <section
              className="wm-dsheet"
              role="dialog"
              aria-modal="true"
              aria-label={t('worldmenu.pick.title')}
              onClick={e => e.stopPropagation()}
              data-testid="wm-dsheet"
            >
              <div className="wm-dsheet__grip" aria-hidden />
              <div className="wm-dsheet__head">
                <span className="wm-dsheet__ttl">
                  <i>{def.displayName.toUpperCase()}</i>
                  <b>{t('worldmenu.pick.title')}</b>
                </span>
                <button type="button" className="wm-dsheet__x" onClick={() => setPickFor(null)} aria-label={t('worldmenu.cancel')}>×</button>
              </div>
              <div className="wm-dsheet__list">
                {list.map(d => {
                  const parts = sanitizeParts(d.parts);
                  const pc = partsCost(parts, cls);
                  const on = d.id === picked?.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className={`wm-dsheet__row${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setTemplatePick(p => ({ ...p, [cls]: d.id }))}
                    >
                      <ShipIcon shipClass={cls} variant={d.iconVariant} size={52} color={p1} color2={p2} />
                      <span className="wm-dsheet__txt">
                        <span className="wm-dsheet__nm">
                          {d.name}
                          {d.isActive && <span className="wm-dsheet__active">{t('ship.sd.active')}</span>}
                        </span>
                        <span className="wm-dsheet__look">{ICON_VARIANT_NAMES[cls]?.[d.iconVariant ?? DEFAULT_SHIP_ICONS[cls]]}</span>
                        <span className="wm-dsheet__parts">
                          {parts.length === 0 ? t('ship.sd.bareHull') : parts.map(pp => PART_GLYPH[pp as ShipPartId] ?? '?').join(' ')}
                        </span>
                        <span className="wm-dsheet__cost">
                          {priced(def.cost.ore + pc.ore)}m · {priced(def.cost.credits + pc.credits)}c · {def.buildTime}t
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="wm-dsheet__foot">
                <button type="button" className="wm-dsheet__edit" onClick={() => { setPickFor(null); openDesigner(cls); }}>
                  {t('worldmenu.pick.edit')}
                </button>
                <button
                  type="button"
                  className="wm-dsheet__build"
                  disabled={h.disabled}
                  title={h.lock ?? (h.noYard ? t('worldmenu.buildYardFirst') : h.priceWhy)}
                  onClick={() => { setPickFor(null); void buildShip(cls); }}
                >
                  {t('worldmenu.pick.build', { name: picked?.name ?? def.displayName })}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        );
      })()}
    </section>
  );
};

// ============================================================
// WmTerraformCard — a body's terraform state in the DEFAULT UI.
//
// Replaces the collector button (collectors are dead — terraformed
// status IS the loading dock now). Three faces:
//   terraformed → a quiet one-line chip; the world just works.
//   raw, window open → countdown to the flip (the payload landed).
//   raw → the delivery meter (X/COST M · Y/COST C), how many terraform
//         routes are feeding it, and what to do when none are.
// Targets come from gameState.terraformConfig (host-tunable), never a
// hardcoded 124.
// ============================================================
const WmTerraformCard: React.FC<{ body: Body; isMine: boolean }> = ({ body, isMine }) => {
  useI18n();
  const { gameState } = useGameContext();

  // Only worlds that could host a city can be terraformed — the card is
  // noise on gas giants, stars and lagrange points.
  if (!canHostCity(body)) return null;
  const cfg = gameState.terraformConfig ?? { costMetal: 124, costCredits: 124, durationTicks: 24 };

  if (!isRawWorld(body)) {
    return (
      <div className="wm-terraform done" data-testid="wm-terraform" data-tutorial-id="terraform-section"
        title={t('worldmenu.tf.doneTitle')}>
        {t('worldmenu.tf.done')}
      </div>
    );
  }

  const acc = body.terraformAcc ?? { metal: 0, credits: 0 };
  const window_ = body.terraformCompletesAtTick;
  const feeding = (gameState.tradeRoutes ?? [])
    .filter(r => r.kind === 'terraform' && routeDeliversTo(r, body.id)).length;

  if (window_ != null) {
    const left = Math.max(0, window_ - gameState.currentTick);
    return (
      <div className="wm-terraform working" data-testid="wm-terraform" data-tutorial-id="terraform-section"
        title={t('worldmenu.tf.workingTitle')}>
        {tn('worldmenu.tf.working', left)}
      </div>
    );
  }

  const mPct = Math.min(100, (acc.metal / Math.max(1, cfg.costMetal)) * 100);
  const cPct = Math.min(100, (acc.credits / Math.max(1, cfg.costCredits)) * 100);
  return (
    <div className="wm-terraform" data-testid="wm-terraform" data-tutorial-id="terraform-section"
      title={t('worldmenu.tf.rawTitle', { metal: cfg.costMetal, credits: cfg.costCredits, ticks: cfg.durationTicks })}>
      <div className="wm-terraform-head">
        <span>{t('worldmenu.tf.raw')}</span>
        <span className="wm-terraform-routes">
          {feeding > 0 ? tn('worldmenu.tf.feeding', feeding) : t('worldmenu.tf.noRoutes')}
        </span>
      </div>
      <div className="wm-terraform-row">
        <i>M</i>
        <div className="wm-terraform-bar"><b style={{ width: `${mPct}%` }} /></div>
        <span>{Math.round(acc.metal)}/{cfg.costMetal}</span>
      </div>
      <div className="wm-terraform-row">
        <i>C</i>
        <div className="wm-terraform-bar"><b style={{ width: `${cPct}%` }} /></div>
        <span>{Math.round(acc.credits)}/{cfg.costCredits}</span>
      </div>
      {/* PAID BUT NOT LANDED. The pool pays when a freighter loads; the
          bar moves when it lands. Say what is in between, or a bar at
          zero reads as credits that vanished. */}
      {isMine && terraformInbound(gameState, body.id).map(x => {
        const nameOf = (id: string | null) => gameState.bodies.find(b => b.id === id)?.name ?? '?';
        const when = x.arriveTick != null
          ? `${t('worldmenu.tf.tick', { n: x.arriveTick })}${tickClock(x.arriveTick, gameState) ? ` (${tickClock(x.arriveTick, gameState)})` : ''}`
          : null;
        const text = x.stage === 'inbound'
          ? t('worldmenu.tf.inbound', { metal: x.metal, credits: x.credits, ship: x.shipName, when: when ?? 'null' })
          : x.stage === 'aboard'
            ? t('worldmenu.tf.aboard', { metal: x.metal, credits: x.credits, ship: x.shipName })
            : `${t('worldmenu.tf.loadFirst', { ship: x.shipName, pickup: nameOf(x.pickupBodyId) })}${when ? t('worldmenu.tf.arrives', { when }) : ''}`;
        return (
          <div key={x.routeId} className={`wm-terraform-inbound ${x.stage}`} data-testid="wm-terraform-inbound">
            ⇢ {text}
          </div>
        );
      })}
      {/* Assign a freighter WITHOUT leaving the world (WmSupplyAssign). */}
      {isMine && (
        <WmSupplyAssign
          destId={body.id}
          feeding={feeding}
          payload={t('worldmenu.payload.terraform')}
          testId="wm-terraform-assign"
        />
      )}
    </div>
  );
};

// ============================================================
// WmSupplyAssign — open a supply route to THIS site from its own card.
//
// Pick a freighter and a loading dock, one click opens the route. Born
// in the terraform card; the Dyson card had only the words "give a
// freighter a route" and no way to do it, so the Sun was reachable
// solely from a freighter's cargo tab ("sol is not a valid target for
// any of the things", Crimson_Song, 2026-10-04). Both cards now share
// this, and it posts the same create call the cargo tab does.
// ============================================================
const WmSupplyAssign: React.FC<{
  destId: string;
  feeding: number;
  /** What is hauled, for the hint text ("the payload"). */
  payload: string;
  testId: string;
  /** Replaces the default one-freighter route (createTradeRoute). */
  onAssign?: (shipId: string, originId: string) => Promise<MpActionResult>;
  /** Replaces the default START SUPPLY / + ADD ROUTE label. */
  buttonLabel?: string;
  /** No dock to choose: the freighter joins a route that has one. */
  hideOrigin?: boolean;
}> = ({ destId, feeding, payload, testId, onAssign, buttonLabel, hideOrigin }) => {
  useI18n();
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [pickShip, setPickShip] = useState('');
  const [pickOrigin, setPickOrigin] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);

  // Your freighters, most-assignable first: idle at a body beats
  // in-transit beats already-on-a-route (picking a routed one simply
  // replaces its route — the server swaps atomically).
  // Employed = ANY role on ANY route. Mapping r.shipId counted only
  // primaries, so a second carrier or a guard sorted as "idle" and
  // offered itself for reassignment as though it had nothing to do.
  const routedShips = useMemo(
    () => employedShipIds(gameState.tradeRoutes ?? []),
    [gameState.tradeRoutes],
  );
  const freighters = useMemo(() => {
    const score = (s: Ship) => (routedShips.has(s.id) ? 2 : s.transit ? 1 : 0);
    return gameState.ships
      .filter(s => s.ownedBy === 'player' && s.class === 'freighter')
      .sort((a, b) => score(a) - score(b));
  }, [gameState.ships, routedShips]);
  // Pool loading docks: terraformed worlds where you live.
  const docks = useMemo(() => {
    const settled = new Set(
      gameState.settlements.filter(s => s.ownedBy === 'player').map(s => s.bodyId),
    );
    return gameState.bodies.filter(b => settled.has(b.id) && !isRawWorld(b));
  }, [gameState.bodies, gameState.settlements]);

  const shipSel = pickShip || freighters[0]?.id || '';
  const originSel = pickOrigin || docks[0]?.id || '';
  const bodyNameOf = (id: string | null | undefined) =>
    gameState.bodies.find(b => b.id === id)?.name ?? '?';
  const shipLabel = (s: Ship) =>
    `${s.name} · ${routedShips.has(s.id) ? t('worldmenu.assign.onRoute')
      : s.transit ? t('worldmenu.assign.inTransit')
      : t('worldmenu.assign.at', { body: bodyNameOf(s.orbit.parentBodyId) })}`;
  if (freighters.length === 0) {
    return (
      <div className="wm-terraform-hint">
        {t('worldmenu.assign.noFreighters', { payload })}
      </div>
    );
  }
  if (docks.length === 0) {
    return (
      <div className="wm-terraform-hint">
        {t('worldmenu.assign.noDock', { payload })}
      </div>
    );
  }
  const assign = async () => {
    if (!mpActions || !shipSel || !originSel || assignBusy) return;
    setAssignBusy(true);
    setAssignMsg(null);
    const res = onAssign
      ? await onAssign(shipSel, originSel)
      : await mpActions.createTradeRoute(shipSel, originSel, destId);
    setAssignBusy(false);
    setAssignMsg(res.ok
      ? (hideOrigin
        ? t('worldmenu.assign.added')
        : t('worldmenu.assign.opened', { body: bodyNameOf(originSel) }))
      : humanizeMpError(res.code, res.error, 'transfer'));
  };
  return (
    <div className="wm-terraform-assign">
      <select
        value={shipSel}
        onChange={e => setPickShip(e.target.value)}
        title={t('worldmenu.assign.shipTitle', { payload })}
      >
        {freighters.map(s => (
          <option key={s.id} value={s.id}>{shipLabel(s)}</option>
        ))}
      </select>
      {!hideOrigin && (
        <select
          value={originSel}
          onChange={e => setPickOrigin(e.target.value)}
          title={t('worldmenu.assign.dockTitle', { payload })}
        >
          {docks.map(d => (
            <option key={d.id} value={d.id}>{t('worldmenu.assign.loadAt', { name: d.name })}</option>
          ))}
        </select>
      )}
      <button
        disabled={assignBusy || !shipSel || !originSel}
        onClick={assign}
        data-testid={testId}
      >
        {buttonLabel ?? (feeding > 0 ? t('worldmenu.assign.addRoute') : t('worldmenu.assign.start'))}
      </button>
      {assignMsg && <div className="wm-terraform-hint">{assignMsg}</div>}
    </div>
  );
};

// ============================================================
// WmDysonCard — the Dyson Sphere's home in the DEFAULT UI.
//
// The entire megaproject experience (see the foundation slot, lay it,
// watch the bar fill) previously existed only in the legacy
// BodyInspector, which the world menu replaced as the default — so a
// player on the standard UI had no way to discover or track the
// engineering victory at all. This card renders inside the Sol top
// panel:
//   no sphere  → initiate buttons per owned Sol station (research-
//                gated on Construction 6, lock reason surfaced)
//   sphere     → progress bar + controller + the supply-line readout:
//                how many of YOUR freighters are parked at Sol pumping
//                (delivery = per-freighter drain of the faction POOL;
//                collectors and trade routes keep the pool filled).
// ============================================================
const WmDysonCard: React.FC = () => {
  useI18n();
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dyson = gameState.dysonSphere;

  if (dyson && dyson.controllerFactionId) {
    const isMine = dyson.controllerFactionId === 'player';
    const controller = gameState.factions.find(f => f.id === dyson.controllerFactionId);
    const pct = dyson.maxHp > 0 ? (dyson.hp / dyson.maxHp) * 100 : 0;
    // Freighters no longer pump by parking — the sphere is fed by
    // supply ROUTES (collector → Sol), raidable the whole way.
    const supplyRoutes = (gameState.tradeRoutes ?? [])
      .filter(r => routeDeliversTo(r, 'sol')).length;
    return (
      <div className="wm-dyson" data-testid="wm-dyson" data-tutorial-id="dyson-sphere-section">
        <div className="wm-dyson-head">
          <span className="wm-dyson-title">{t('worldmenu.dyson.title')}</span>
          <span className="wm-dyson-owner" style={{ color: isMine ? '#6ee7b7' : '#ff8a4d' }}>
            {isMine ? t('worldmenu.dyson.yours') : t('worldmenu.dyson.rival', { name: (controller?.name ?? '?').toUpperCase() })}
          </span>
        </div>
        <div className="wm-dyson-bar">
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="wm-dyson-meta">
          {Math.round(dyson.hp).toLocaleString()} / {dyson.maxHp.toLocaleString()} · {pct.toFixed(1)}%
        </div>
        {isMine && (
          <div className="wm-dyson-supply" title={t('worldmenu.dyson.supplyTitle')}>
            {supplyRoutes > 0
              ? <>{tn('worldmenu.dyson.hauling', supplyRoutes)}</>
              : <span style={{ color: '#ffb84d' }}>{t('worldmenu.dyson.stalled')}</span>}
          </div>
        )}
        {isMine && (() => {
          // ONE ROUTE, MANY FREIGHTERS (Crimson_Song: "i can't add them
          // to the route so i got a buncha individual routes"). The Sun
          // is a drop-off on an ordinary route now, so a freighter JOINS
          // your Sun route while it has room under the Convoy cap, and a
          // new route starts only when every one is full.
          const cap = gameState.carrierCap ?? 1;
          const sunRoute = (gameState.tradeRoutes ?? []).find(r =>
            r.ownedBy === 'player' && r.kind === 'logistics' && routeDeliversTo(r, 'sol')
            && routeCarriers(r).length < cap);
          return (
            <WmSupplyAssign
              destId="sol"
              feeding={supplyRoutes}
              payload={t('worldmenu.payload.sphere')}
              testId="wm-dyson-assign"
              hideOrigin={!!sunRoute}
              buttonLabel={sunRoute ? t('worldmenu.dyson.addFreighter') : supplyRoutes > 0 ? t('worldmenu.dyson.newRoute') : t('worldmenu.assign.start')}
              onAssign={(shipId, originId) => (sunRoute
                ? mpActions!.addRouteShip(sunRoute.id, 'carrier', { shipId })
                : mpActions!.createRouteFull({
                    name: 'Dyson supply',
                    stops: [
                      { bodyId: originId, action: 'pickup' },
                      { bodyId: 'sol', action: 'dropoff' },
                    ],
                    carrierShipIds: [shipId],
                  }))}
            />
          );
        })()}
      </div>
    );
  }

  // No controller — the slot is open. Two flavours: a virgin slot, or
  // an ABANDONED sphere whose progress survives for whoever claims it
  // (king of the hill: kicking the builder off doesn't reset the build).
  const derelict = dyson && !dyson.controllerFactionId && dyson.maxHp > 0 ? dyson : null;
  const derelictPct = derelict ? (derelict.hp / Math.max(1, derelict.maxHp)) * 100 : 0;
  const myStations = gameState.settlements.filter(s =>
    s.ownedBy === 'player' && s.type === 'station' && s.bodyId === 'sol');
  const lock = gate.lockReason('dyson');
  return (
    <div className="wm-dyson" data-testid="wm-dyson" data-tutorial-id="dyson-sphere-section">
      <div className="wm-dyson-head">
        <span className="wm-dyson-title">
          {derelict ? t('worldmenu.dyson.abandoned') : t('worldmenu.dyson.slotOpen')}
        </span>
        {derelict && (
          <span className="wm-dyson-owner" style={{ color: '#ffb84d' }}>
            {t('worldmenu.dyson.builtUnclaimed', { pct: derelictPct.toFixed(1) })}
          </span>
        )}
      </div>
      {derelict && (
        <div className="wm-dyson-bar">
          <i style={{ width: `${Math.min(100, derelictPct)}%`, opacity: 0.6 }} />
        </div>
      )}
      <div className="wm-dyson-meta">
        {derelict
          ? <>{t('worldmenu.dyson.derelictBody', { pct: derelictPct.toFixed(0) })}</>
          : <>{t('worldmenu.dyson.slotBodyA')} <b>{t('worldmenu.dyson.slotBodyBold')}</b>{' '}
              {t('worldmenu.dyson.slotBodyB')}</>}
      </div>
      {lock ? (
        <div className="wm-dyson-meta" style={{ color: '#8aa0b4' }}>🔒 {lock.label} — {lock.text}</div>
      ) : myStations.length === 0 ? (
        <div className="wm-dyson-meta" style={{ color: '#ffb84d' }}>
          {t('worldmenu.dyson.needStation')}
        </div>
      ) : (
        myStations.map(s => (
          <button
            key={s.id}
            className="wm-dyson-initiate"
            disabled={busy}
            onClick={() => {
              if (!mpActions) return;
              setBusy(true);
              setErr(null);
              mpActions.initiateDysonSphere(s.id).then(res => {
                setBusy(false);
                if (!res.ok) setErr(humanizeMpError(res.code, res.error ?? t('worldmenu.dyson.initiateRejected'), 'build'));
              });
            }}
            title={derelict
              ? t('worldmenu.dyson.claimTitle', { name: s.name, pct: derelictPct.toFixed(0) })
              : t('worldmenu.dyson.initiateTitle', { name: s.name })}
          >{derelict ? t('worldmenu.dyson.claimBtn', { name: s.name.toUpperCase() }) : t('worldmenu.dyson.initiateBtn', { name: s.name.toUpperCase() })}</button>
        ))
      )}
      {err && (
        <button className="wm-dyson-err" onClick={() => setErr(null)} title={t('worldmenu.dyson.clickDismiss')}>
          ⚠ {err}
        </button>
      )}
    </div>
  );
};

/** LocalStorage-backed preference for the MP world menu (default ON).
 *  Kill switch: flipping OFF restores the legacy BodyInspector without
 *  touching any SP code path (SP always uses BodyInspector). */
const WM_PREF_KEY = 'orbital.world_menu';
export function worldMenuPref(): boolean {
  try { return localStorage.getItem(WM_PREF_KEY) !== '0'; } catch { return true; }
}
export function setWorldMenuPref(on: boolean): void {
  try { localStorage.setItem(WM_PREF_KEY, on ? '1' : '0'); } catch { /* noop */ }
  window.dispatchEvent(new CustomEvent('orbital:world-menu-pref'));
}

/** Tiny MP-only pill for flipping between the diegetic menu and the
 *  legacy inspector. Rendered by GameUI's MP branch in both modes so
 *  the kill switch is always reachable. */
export const WorldMenuToggle: React.FC<{ on: boolean }> = ({ on }) => {
  useI18n();
  return (
    <button
      className="wm-toggle-pill"
      data-testid="wm-toggle"
      title={on ? t('worldmenu.toggle.toClassicTitle') : t('worldmenu.toggle.toWorldTitle')}
      onClick={() => setWorldMenuPref(!on)}
    >
      {on ? t('worldmenu.toggle.classic') : t('worldmenu.toggle.world')}
    </button>
  );
};
