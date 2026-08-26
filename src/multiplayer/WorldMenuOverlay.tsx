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
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { useFeatureGate } from '../hooks/useFeatureGate';
import { BUILDING_FEATURE } from '../game/researchUnlocks';
import { BUILDABLE_CLASSES, getShipClass } from '../game/shipClasses';
import { sanitizeParts, partsCost } from '../game/shipParts';
import { RESOURCE_LETTER_COLORS } from '../game/resourceColors';
import { trackPendingBuild, resolveServerOrderId } from '../game/optimisticBuilds';

import { shipyardSlotsAtBody, canHostCity, canHostStation, isRawWorld, suggestSettlementName, BUILDING_DEFS } from '../game/settlements';
import { EditableName } from '../components/EditableName';
import { RushControl } from '../components/BuildPanel';
import { humanizeMpError } from './errorMessages';
import { ShipIcon } from '../components/ShipIcons';
import { randomShipName } from '../game/shipNames';
import { pickFromPool } from '../game/namePools';
import { deriveSecondary } from '../game/colorUtils';
import { composedBodyFlavor, bodyImmovableNote } from '../game/bodyFlavor';
import { TransferTargetPicker } from '../components/ShipPanel';
import { Body, BuildingKind, Settlement, SettlementType, Ship } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';
import { isRevealedWarpGate } from '../render/mapRenderer';
import {
  menuScaleFor, menuCameraOffset, menuOpacity, zOf,
  S1X_FRAC, S1Y_FRAC, Z1_FRAC,
} from '../game/worldMenu/camera';
import { setWorldMenuActive, setWorldMenuOpenBodyId } from '../game/worldMenu/store';
import { columnsFor, buildStatus, noHostText } from '../game/worldMenu/buildRules';
import { hpColor } from '../game/worldMenu/combatDisplay';
import { readoutFor, neighborsOf } from '../game/worldMenu/bodyStats';
import { PART_FRACS } from '../render/worldMenuCloseup';
import './WorldMenuOverlay.css';
import { employedShipIds, routeDeliversTo } from '../game/routeSelectors';
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
  const {
    gameState, camera, uiState,
    updateCamera, focusBody, selectBody, deselectBody, renameSettlement,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();

  const [vw, setVw] = useState(window.innerWidth);
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => {
    const onR = () => { setVw(window.innerWidth); setVh(window.innerHeight); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
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
  // While a menu is open: tag <body> so the left rail steps aside
  // (CSS in WorldMenuOverlay.css — MP-only by construction), and
  // measure the real TopBar so the panel tucks exactly under it.
  // fleet/panel heights bump this so JS-computed positions (column
  // clamp) re-render after the DOM measures in.
  const [chromeH, setChromeH] = useState({ fleet: 200, panel: 92 });
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
      // Mobile: lift the planet so it sits close to the station, well
      // above the surface build row. Default horizon is 60% (S1Y=1.02 -
      // Z1=0.42); shifting up by 0.25·vh moves it to 35% of the viewport.
      const uShift = vw > 720 ? 0 : -0.25 * vh;
      const off = menuCameraOffset(vw, vh, s1, rShift, uShift);
      focusBody(sel); // sets focusedBodyId (body-relative camera)
      updateCamera({ scale: s1, x: off.x, y: off.y });
      setOpenId(sel);
      setErrMsg(null);
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
        updateCamera({ x: snap.x, y: snap.y, scale: snap.scale });
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
      const fleetH = fleetEl?.offsetHeight ?? 200;
      document.body.style.setProperty('--wm-panel-h', `${panelH}px`);
      document.body.style.setProperty('--wm-fleet-h', `${fleetH}px`);
      setChromeH(prev => (prev.fleet === fleetH && prev.panel === panelH ? prev : { fleet: fleetH, panel: panelH }));

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
          - (fleetH + railH + 6)    // build box + dock rail
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
  }, [chromeMounted, collapsed, openId, mobile]);

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
      if (e.key === 'Escape' && openId) close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, close]);

  // ---- data ----
  const readout = useMemo(
    () => (body ? readoutFor(body, gameState.settlements, gameState.ships, 'player') : null),
    [body, gameState.settlements, gameState.ships],
  );
  const here = useMemo(
    () => gameState.settlements.filter(s => s.bodyId === openId),
    [gameState.settlements, openId],
  );
  const myCity = here.find(s => s.type === 'city' && s.ownedBy === 'player') ?? null;
  const myStation = here.find(s => s.type === 'station' && s.ownedBy === 'player') ?? null;
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
  const neighbors = useMemo(
    () => neighborsOf(openId, gameState.bodies).slice(0, 4),
    [openId, gameState.bodies],
  );
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
      : await mpActions?.queueBuilding(settlement.id, kind);
    if (res && !res.ok) setErrMsg(res.error ?? 'Build rejected by server');
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
    if (res && !res.ok) setErrMsg(res.error ?? `Could not found ${type}`);
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

  if (!body || !readout || op <= 0.01) return null;

  const settled = z > 0.98;
  const isMine = readout.ownerFactionId === 'player';
  const cols = columnsFor(body);
  // Authored prose plus any type-level line (the asteroid planet-killer
  // note). Composed in bodyFlavor.ts so this panel and BodyInspector
  // cannot drift — see the note there.
  const flavor = composedBodyFlavor(body);
  const immovable = bodyImmovableNote(body);
  const integrity = myCity ?? myStation ?? here[0] ?? null;

  // Settled framing is deterministic: centre at S1 (+ desktop outliner
  // shift), radius Z1_FRAC·H — same math the canvas pass uses. Every DOM
  // anchor below hangs off `cx` so it stays coincident with the canvas
  // planet after the shift.
  const rShift = !mobile ? (296 - 60) / 2 : 0;
  const uShift = mobile ? -0.25 * vh : 0; // mobile: horizon at 35% of vh (close to station)
  const cx = S1X_FRAC * vw + rShift, cy = S1Y_FRAC * vh + uShift, cr = Z1_FRAC * vh;
  const partPos = (frac: number) => {
    const a = (-90 + frac * 46) * Math.PI / 180;
    return { x: cx + Math.cos(a) * cr, y: cy + Math.sin(a) * cr };
  };
  // Chrome geometry — build columns hover just off the limb; the
  // station rig floats above the orbit column.
  const railW = mobile ? 0 : 296, dockW = mobile ? 0 : 60;
  // BTN_H MUST equal .wm-bbtn height in WorldMenuOverlay.css (54px). The
  // leader-line anchors below derive from it; if they drift the lines
  // point at empty space between buttons.
  const COL_W = 168, BTN_H = 54;
  const leftColX = Math.max(railW + 10, cx - cr - COL_W - 26);
  // Column stack height: label (18) + up to 4 buttons (40 + 9 gap).
  const COL_MAX_H = 18 + 4 * (BTN_H + 9);
  // Fleet panel lives with `bottom: 12px`; its measured height (state
  // above) bounds where the surface column can end.
  const colBottomLimit = vh - chromeH.fleet - 20;   // last y a col button can occupy
  const colTopY = Math.max(80, Math.min(cy - cr + 4, colBottomLimit - COL_MAX_H));
  // Orbit column pinned far right.
  const rightColX = vw - dockW - COL_W - 10;
  // Station indicator: a small DOM silhouette that echoes the canvas
  // station's ring+hub (isoStructures.drawStationStructure). Not the
  // cartoon tall-mast — a stylized icon that sits above the orbit
  // column so the station reads as a distinct place in the sky.
  const staW = 130, staH = 130;
  const staX = rightColX + (COL_W - staW) / 2;
  const staY = Math.max(66, colTopY - staH - 10);
  // Leader-line anchor for the i-th button in a column.
  const btnAnchor = (colX: number, i: number, edge: 'right' | 'left') =>
    ({ x: edge === 'right' ? colX + COL_W : colX, y: colTopY + i * (BTN_H + 9) + BTN_H / 2 });
  // Owner faction colour for a body's settlement (null = unsettled).
  const bodyOwnerColor = (bid: string): string | null => {
    const s = gameState.settlements.find(x => x.bodyId === bid);
    if (!s) return null;
    return gameState.factions.find(f => f.id === s.ownedBy)?.color ?? '#8d99a5';
  };

  const buildBtn = (kind: BuildingKind, host: Settlement | null, column: 'surface' | 'orbit') => {
    const st = buildStatus(kind, host, {
      currentTick: gameState.currentTick,
      noHostText: noHostText(column, body),
    });
    const lockObj = st.state === 'ready' && st.level === 0 && BUILDING_FEATURE[kind]
      ? gate.lockReason(BUILDING_FEATURE[kind]) : null;
    // Compact lock chip: just the lock + tier (strip "Unlocks at" and the
    // building name — the button already says which building it is).
    const lockShort = lockObj ? `🔒 ${lockObj.text.replace(/^unlocks at\s*/i, '')}` : null;
    // 'backlogged' stays clickable — that click is how you remove it.
    const disabled = !isMine || !!lockObj
      || (st.state !== 'ready' && st.state !== 'backlogged');
    // Progress bar: fraction of the queued upgrade complete. buildStatus
    // gives us ticksLeft + targetLevel; span is (targetLevel - level)
    // multiplied by that building's base build ticks, but we don't need
    // the def here — the queue row on `settlement.buildingQueue` carries
    // startTick / completeTick, so fraction = 1 - ticksLeft / totalSpan
    // where totalSpan is completeTick - startTick.
    let progress: number | null = null;
    if (st.state === 'queued' && host?.buildingQueue) {
      const q = host.buildingQueue;
      const span = Math.max(1, q.completeTick - q.startTick);
      progress = Math.max(0, Math.min(1, 1 - st.ticksLeft / span));
    }
    return (
      <button
        key={kind}
        className={`wm-bbtn ${st.state === 'ready' && st.level > 0 ? 'built' : ''} ${st.state === 'queued' ? 'queued' : ''} ${st.state === 'backlogged' ? 'backlogged' : ''}`}
        data-testid={`wm-build-${kind}`}
        disabled={disabled}
        // Full prose on hover; the short effect line below is always
        // visible, because hover does not exist on touch and the effect
        // is the thing you need in order to choose.
        title={lockObj
          ? `${lockObj.label} — ${lockObj.text}\n\n${BUILDING_DEFS[kind].description}`
          : st.state === 'backlogged'
            ? `#${st.position} in the build queue — click to take it back out and refund the cost.`
              + `\n\n${BUILDING_DEFS[kind].description}`
            : BUILDING_DEFS[kind].description}
        onClick={() => queueBuild(kind, host)}
      >
        <span className="wm-bbtn-nm">{kind.toUpperCase()}</span>
        {st.state === 'backlogged' && (
          <span className="wm-bbtn-q" aria-label={`queue position ${st.position}`}>{st.position}</span>
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

  const foundBtn = (type: SettlementType) => {
    const isCity = type === 'city';
    const own = !!(myCity || myStation);
    // THE HARD GATE (DESIGN-terraforming): raw worlds host stations
    // only. The city button stays VISIBLE but disabled with the reason —
    // hiding it would leave players guessing why this world won't take
    // a city while the next one will.
    const raw = isCity && !!body && isRawWorld(body);
    // NOT gated by isMine: founding is the WAY you take ownership of an
    // unclaimed body. The old check kept the button disabled on every
    // unowned body (ownerFactionId === null → isMine === false), which
    // was the "have a colony ship in orbit but Build Station is dead"
    // bug. The colony ship / stationLock / cost checks below are the
    // real gates — mirrors BodyInspector's showCityDeploy/showStationDeploy.
    // The research lock now sits on the CITY side: stations are the
    // turn-one claim move and carry no tech requirement.
    // Same two paths for both types now (see handleFoundSettlement): a
    // settlement you already own here buys the build for resources,
    // otherwise a Colony Ship in orbit is consumed. A city that demanded a
    // fresh colony ship on a world you had already terraformed AND
    // stationed read as the game not noticing you lived there.
    const enabled = !raw && !(isCity ? !!cityLock : false)
      && (!!colonyShipHere || (own && canAffordSettlement));
    const needSub = own
      ? (colonistHere ? `${costLabel} · colonist` : costLabel)
      : 'needs colony ship in orbit';
    const sub = isCity
      ? (raw ? 'raw world — terraform first'
        : cityLock ? cityLock.text
        : colonyShipHere ? 'consumes colony ship' : needSub)
      : (colonyShipHere ? 'consumes colony ship' : needSub);
    const title = isCity
      ? (raw ? 'Raw world — run a terraform supply route here first. Stations can be built now.'
        : cityLock ? `${cityLock.label} — ${cityLock.text}`
        : colonyShipHere ? `Found a city — consumes ${colonyShipHere.name}`
        : own ? (canAffordSettlement
            ? `Built on ground you already hold: ${costLabel}${colonistHere ? ' (Colonist captain: -20%)' : ''}`
            : `Need ${costLabel} to build here`)
        : 'Requires a Colony Ship in orbit, or own a settlement here first')
      : (colonyShipHere ? `Launch a station — consumes ${colonyShipHere.name}`
        : own ? (canAffordSettlement
            ? `Built from orbit: ${costLabel}${colonistHere ? ' (Colonist captain: -20%)' : ''}`
            : `Need ${costLabel} to build from orbit`)
        : 'Requires a Colony Ship in orbit, or own a settlement here first');
    // MOBILE: a CITY button that's disabled purely because the world is
    // raw is not an action — it's a rule. As a full-height tile it took a
    // third of the build row and, on a cramped phone, sat directly on the
    // terraform controls that are the only way to lift the restriction.
    // Collapse it to a single full-width line: the rule stays visible
    // (it's the only place that states it outside a tooltip) at ~a third
    // of the height. Desktop keeps the tile — `mobile` gates this.
    const rawCityNote = mobile && isCity && raw;
    return (
      <button
        key={type}
        className={`wm-bbtn wm-found${rawCityNote ? ' wm-found--rule' : ''}`}
        disabled={!enabled}
        title={title}
        onClick={() => foundSettlement(type)}
        data-testid={`wm-found-${type}`}
      >
        {rawCityNote ? (
          <span className="wm-bbtn-st">🔒 CITY — terraform this world first</span>
        ) : (
          <>
            <span className="wm-bbtn-nm">{isCity ? '▲ FOUND CITY' : '▲ BUILD STATION'}</span>
            <span className="wm-bbtn-st">{cityLock && isCity && !raw ? `🔒 ${sub}` : sub}</span>
          </>
        )}
      </button>
    );
  };

  // Column element lists — reused by desktop columns AND the mobile grid.
  // No city/station → offer the FOUND button (if the body can host one);
  // otherwise the upgrade buttons for that settlement.
  // The `any*` guards only bite in the else branch — the branch that means
  // "I have none here". If the slot is filled and it is not mine, the
  // button is a control the server would refuse with 409 'occupied', so it
  // is not drawn at all. Reported from Europa, where a rival held BOTH
  // slots and the panel still offered to found a city and a station.
  const surfaceEls = myCity
    ? cols.surface.map(k => buildBtn(k, myCity, 'surface'))
    : (body && canHostCity(body) && !anyCity ? [foundBtn('city')] : []);
  const orbitEls = myStation
    ? cols.orbit.map(k => buildBtn(k, myStation, 'orbit'))
    : (body && canHostStation(body) && !anyStation ? [foundBtn('station')] : []);

  // No F chip: fuel is dead (DESIGN-identity-economy.md §1.1). The DB
  // column still exists, but a permanent 0 on every world is noise.
  const yieldChips: Array<[string, number]> = [
    ['M', readout.yields.ore],
    ['C', readout.yields.credits], ['S', readout.yields.science],
  ];

  const staHpRatio = readout.station ? readout.station.hp / Math.max(1, readout.station.maxHp) : 1;

  return (
    <div
      className={`wm-root ${mobile ? 'wm-mobile' : ''}`}
      style={{ opacity: op, pointerEvents: op > 0.9 ? undefined : 'none' }}
      data-testid="world-menu"
    >
      {/* ===== top readout panel — a BOX above the planet, not a strip.
           The world's NAME leads the hierarchy: biggest thing in the box,
           never covered. Mobile spans full width (collapsed default). ===== */}
      <section
        data-tutorial-id="world-menu"
        className={`wm-top ${mobile && collapsed ? 'collapsed' : ''}`}
        style={mobile ? undefined : {
          // Centered ABOVE the planet, capped so it never overlaps the
          // outliner or the dock. Uses `cx` (post-shift planet centre).
          left: '50%',
          transform: `translateX(calc(-50% + ${(cx - vw / 2).toFixed(0)}px))`,
          maxWidth: Math.min(560, vw - railW - dockW - 24),
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
            <span className="wm-type">{body.type.replace('_', ' ')}</span>
            {readout.ownerFactionId && (
              <span
                className={`wm-owner ${isMine ? '' : 'neutral'}`}
                style={isMine ? { borderColor: p1, color: p1 } : undefined}
              >
                {isMine ? 'YOU' : (ownerFaction?.name ?? readout.ownerFactionId).toUpperCase()}
              </span>
            )}
          </div>
        </div>
        {flavor && !mobile && <div className="wm-desc">{flavor}</div>}
        {/* The immovable note is a RULE, so unlike flavour it is NOT
            hidden on mobile: it answers "why is there no thrusters
            button on this rock", and that question is just as reachable
            on a phone. One short line, so it costs little room. */}
        {immovable && <div className="wm-immovable">{immovable}</div>}
        <div className="wm-metrics">
          <div className="wm-metric"><span>POP</span><b>{readout.pop}</b></div>
          <div className="wm-metric"><span>DEFENSE</span><b>{readout.defense}</b></div>
          <div className="wm-metric"><span>SHIPS</span><b>◆ {readout.shipCount}</b></div>
          <div className="wm-metric"><span>INTEGRITY</span>
            <b>{integrity ? `${Math.round(integrity.hp)}/${integrity.maxHp}` : '—'}</b>
          </div>
        </div>
        {(myCity || myStation) && (
          <div className="wm-settlements">
            {myCity && (
              <span className="wm-settlement" title="Rename this city">
                <span className="wm-settlement-glyph">■</span>
                <EditableName value={myCity.name} maxLength={32} ariaLabel="Rename this city"
                  onSave={(next) => renameOwned(myCity.id, next)} />
                <span className="wm-settlement-hp"
                  style={{ color: hpColor(myCity.hp / Math.max(1, myCity.maxHp)) }}
                  title="Structure integrity (current / max)">
                  ◈ {Math.round(myCity.hp)}/{myCity.maxHp}
                </span>
              </span>
            )}
            {myStation && (
              <span className="wm-settlement" title="Rename this station">
                <span className="wm-settlement-glyph">◆</span>
                <EditableName value={myStation.name} maxLength={32} ariaLabel="Rename this station"
                  onSave={(next) => renameOwned(myStation.id, next)} />
                <span className="wm-settlement-hp"
                  style={{ color: hpColor(myStation.hp / Math.max(1, myStation.maxHp)) }}
                  title="Structure integrity (current / max)">
                  ◈ {Math.round(myStation.hp)}/{myStation.maxHp}
                </span>
              </span>
            )}
          </div>
        )}
        <div className="wm-out">
          <span className="wm-label">Output /t</span>
          <div className="wm-yields">
            {yieldChips.map(([k, v]) => (
              // Chip tinted with the canonical resource color so F/M/C/S
              // reads the same here as on the top bar.
              <span
                className="wm-yield" key={k}
                style={{ color: RESOURCE_LETTER_COLORS[k as 'F' | 'M' | 'C' | 'S'] }}
              >{/* letter inherits the tint (CSS dims it grey otherwise) */}
                <i style={{ color: 'inherit', opacity: 0.75 }}>{k}</i>
                {Math.round(v * 10) / 10}</span>
            ))}
          </div>
          <div className="wm-stock">
            <span className="wm-label">Stockpile</span>{' '}
            {/* Round, not floor: floor turns fp residue like 0.9999 into
                0 when the true stock is 1. Whole numbers everywhere. */}
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
        {/* Terraform state — replaces the collector button (collectors
            are dead; terraformed status is the loading dock now). */}
        <WmTerraformCard body={body} isMine={isMine} />
        {/* Dyson Sphere (Sol only) — the engineering-victory megaproject
            had NO surface in the default world-menu UI; the initiate/
            progress panel lived only in the legacy BodyInspector. */}
        {body.id === 'sol' && <WmDysonCard />}

        {/* ===== MOBILE BUILD ROWS — INSIDE the sheet, in normal flow.
             They used to float over the map at computed offsets: the
             orbit row hung off the panel's bottom edge and the surface
             row rode the top of the build box. Three independent absolute
             layers converging on the same strip of a phone screen, and
             they kept landing on each other and on the terraform
             controls — twice patched by tuning offsets, twice still
             overlapping (BUILD STATION was the last one standing).
             In flow they cannot overlap by construction: the sheet is
             already capped and scrollable, so the rows just take their
             place in it. The diegetic sky/horizon placement stays on
             DESKTOP, which has the room for it. ===== */}
        {mobile && !collapsed && orbitEls.length > 0 && (
          <div className="wm-msec" data-testid="wm-col-orbit">
            <div className="wm-msec-label">ORBIT — <b>STATION</b></div>
            <div className="wm-mrow wm-mrow-flow">{orbitEls}</div>
          </div>
        )}
        {mobile && !collapsed && surfaceEls.length > 0 && (
          <div className="wm-msec" data-testid="wm-col-surface">
            <div className="wm-msec-label">SURFACE — <b>CITY</b></div>
            <div className="wm-mrow wm-mrow-flow">{surfaceEls}</div>
          </div>
        )}

        {mobile && (
          <button className="wm-more" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? '▾ More' : '▴ Less'}
          </button>
        )}
      </section>

      {/* ===== dismissal + error ===== */}
      <button className="wm-tomap" onClick={() => close(true)} data-testid="wm-tomap">✕ MAP</button>
      {errMsg && <div className="wm-err">{errMsg}</div>}

      {/* ===== neighbor orbs (desktop only — they don't fit alongside
           the dense mobile panels; mobile navigates via the outliner) ===== */}
      {!mobile && (
      <svg className="wm-orbs" width={vw} height={vh} aria-hidden="true">
        {neighbors.map((nb, i) => {
          const isParent = nb.id === body.parent;
          // parent occupies index 0 of the neighbors array, so sibling
          // indexes 1..3 map straight onto slots 1..3 (no double-count).
          const slot = ORB_SLOTS[isParent ? 0 : Math.min(3, Math.max(1, i))];
          // dx is absolute px offset from `cx` (post-shift), so the
          // cluster rides with the planet and is safely right of the
          // centred info panel. y is absolute px from the top.
          // Also clamp inside the dock rail's right gutter.
          const ox = Math.min(vw - dockW - slot.r - 12, cx + slot.dx);
          const oy = slot.y, or = slot.r;
          const ownColor = bodyOwnerColor(nb.id);
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
              <circle r={or} fill={nb.color} />
              {/* TERRAFORMED: the same living green the surface art and the
                  TERRAFORMED pill use, so a glance at the cluster answers
                  "which of these can take a city" without opening each one.
                  A veil rather than another ring — owner and selection
                  already own the ring language out here. Bodies that can
                  never be terraformed (gas giants, asteroids) simply never
                  match, so no type test is needed. */}
              {!isRawWorld(nb) && (
                <>
                  <circle r={or} fill="#4ade80" opacity="0.26" />
                  <circle className="wm-orb-tf" r={Math.max(2.5, or * 0.22)}
                    cx={-or * 0.66} cy={or * 0.66} fill="#4ade80" />
                </>
              )}
              <circle r={or} cx={or * 0.32} cy={or * 0.18} fill="#05080e" opacity="0.3" />
              {/* settlement indicator: an owner-coloured ring + star badge
                  when this body is claimed (spec: "indicate who with the
                  colors"). Absent when unsettled. */}
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

      {/* ===== station indicator — a stylized ring+hub silhouette that
           echoes the canvas station (isoStructures.drawStationStructure).
           Not the tall-mast cartoon; a compact icon above the orbit
           column that reads as "the station" at a glance. Modules
           appear in faction color when built. ===== */}
      {readout.station && (
        <svg
          className="wm-station" data-testid="wm-station"
          viewBox="0 0 130 130"
          style={mobile
            // Mobile: park just below the station-build row, RIGHT
            // ABOVE the horizon so the planet reads as one contiguous
            // scene with the station. Centered.
            ? { left: '50%',
                // below: panel offset (10) + orbit row (40 @ +22) + 12 gap
                top: 'calc(var(--wm-topbar-h, 52px) + var(--wm-panel-h, 44px) + var(--wm-orbit-h, 40px) + 34px)',
                width: 100, height: 100, transform: 'translateX(-50%)' }
            : { left: staX, top: staY, width: staW, height: staH }}
        >
          {/* Station painted in the OWNER's two tones (was neutral steel).
              Ring = primary, its inner highlight = secondary; hub capsule
              primary with a secondary lit face + beacon. Built modules
              swap to the SECONDARY so they still read against the primary
              base. */}
          {/* tilted torus ring (back band = primary, front highlight = secondary) */}
          <ellipse cx="65" cy="66" rx="46" ry="14" fill="none"
            stroke={p1} strokeWidth="6" transform="rotate(-14 65 66)" />
          <ellipse cx="65" cy="66" rx="46" ry="14" fill="none"
            stroke={p2} strokeOpacity="0.7" strokeWidth="1.5" transform="rotate(-14 65 66)" />
          {/* hub — a capsule threaded through the ring */}
          <g transform="translate(65 66) rotate(-14)">
            <rect x="-6" y="-18" width="12" height="36" rx="6" fill={p1} stroke={p2} strokeWidth="0.8" />
            <rect x="-6" y="-18" width="4.5" height="36" rx="4" fill={p2} fillOpacity="0.55" />
            <circle cx="0" cy="-18" r="2.4" fill={p2} />
          </g>
          {/* faction modules — appear as built, in the secondary tone */}
          {myStation && (myStation.buildings?.weapons ?? 0) > 0 && (
            <g style={{ fill: p2 }} data-part="weapons">
              <rect x="12" y="60" width="10" height="10" rx="1" />
              <rect x="108" y="60" width="10" height="10" rx="1" />
            </g>
          )}
          {myStation && (myStation.buildings?.shipyard ?? 0) > 0 && (
            <g style={{ stroke: p2, fill: 'none' }} data-part="shipyard" strokeWidth="2.5">
              <path d="M50,96 L42,96 L42,116 L50,116" />
              <path d="M80,96 L88,96 L88,116 L80,116" />
            </g>
          )}
          {myStation && (myStation.buildings?.lab ?? 0) > 0 && (
            <g data-part="lab">
              <circle cx="65" cy="106" r="6" fill="none" stroke={p2} strokeWidth="1.8" />
              <circle cx="65" cy="106" r="2" fill={p2} />
            </g>
          )}
          {/* Name + HP header — always readable */}
          <text x="65" y="14" textAnchor="middle"
            style={{ font: '700 10px "Audiowide", monospace', letterSpacing: '0.08em', fill: '#d6e2ec' }}>
            {readout.station.name.toUpperCase()}
          </text>
          <rect x="18" y="20" width="94" height="5" rx="2" fill="#0c1219" stroke="#2a3d50" strokeWidth="1" />
          <rect x="18" y="20" width={94 * staHpRatio} height="5" rx="2" fill={hpColor(staHpRatio)} />
          {/* current / max integrity, spelled out under the bar */}
          <text x="65" y="33" textAnchor="middle"
            style={{ font: '700 8px "Audiowide", monospace', letterSpacing: '0.06em', fill: hpColor(staHpRatio) }}>
            {Math.round(readout.station.hp)}/{readout.station.maxHp}
          </text>
        </svg>
      )}

      {/* ===== build controls =====
           Desktop: two columns hovering off the limb, leader lines from
           each surface button to its limb building.
           MOBILE: rendered INSIDE the info sheet above (see the wm-msec
           blocks) so they sit in normal flow and cannot collide. They
           were floating here at computed offsets and kept overlapping
           each other and the terraform card. */}
      {!mobile && (
        <>
          {surfaceEls.length > 0 && (
            <aside
              className="wm-col" data-testid="wm-col-surface"
              data-tutorial-id="wm-columns"
              style={{ left: leftColX, top: colTopY, width: COL_W }}
            >
              <div className="wm-col-label">SURFACE — <b>CITY</b></div>
              {surfaceEls}
            </aside>
          )}
          {orbitEls.length > 0 && (
            <aside
              className="wm-col" data-testid="wm-col-orbit"
              data-tutorial-id="wm-columns-orbit"
              style={{ left: rightColX, top: colTopY, width: COL_W }}
            >
              <div className="wm-col-label">ORBIT — <b>STATION</b></div>
              {orbitEls}
            </aside>
          )}

          {/* leader lines: surface button edge → its limb building. The
              station is the canvas graphic (drawStation) on the orbital
              ring, so orbit buttons don't draw lines. */}
          {settled && myCity && (
            <svg className="wm-lines" width={vw} height={vh} aria-hidden="true">
              {cols.surface.map((k, i) => {
                const from = btnAnchor(leftColX, i + 1, 'right'); // +1: label row
                // Shields has no limb structure to point at — it's the
                // dome over the whole settlement, drawn by the closeup
                // pass. Without this it would fall back to frac 0 and
                // aim into the gap between MINT and LAB.
                if (k === 'shields') return null;
                const to = partPos(PART_FRACS[k] ?? 0);
                if (to.y > vh - 40) return null;
                const mx = (from.x + to.x) / 2;
                return <path key={k} data-wm-line={k} className="wm-line" fill="none"
                  d={`M${from.x},${from.y} C${mx},${from.y} ${mx},${to.y} ${to.x - 8},${to.y}`} />;
              })}
            </svg>
          )}
        </>
      )}

      {/* ===== fleet box — compact, per the sketch: slots + queue on the
           left, ship grid + DESIGN on the right. Not full-width.

           ONLY where the player has a settlement (per Lorne). On a body
           you haven't settled — a rival capital, an empty rock — the box
           rendered a full grid of hull cards, all dead, over "no station
           yet": a build menu for a yard that doesn't exist. Reported
           from a rival's Dyson site at Sol, where it read as noise over
           the thing being scouted. The FOUND CITY / BUILD STATION
           affordances live in the columns and are untouched — settling
           is still how you earn this box. */}
      {(myCity || myStation) && (
        <WmFleet
          bodyId={body.id}
          mobile={mobile}
          isMine={isMine}
          hasStation={!!myStation}
          railW={railW}
          onErr={setErrMsg}
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
  bodyId: string; mobile: boolean; isMine: boolean; hasStation: boolean;
  railW: number; onErr: (m: string | null) => void;
}> = ({ bodyId, mobile, isMine, hasStation, railW, onErr }) => {
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
  const orders = gameState.buildOrders
    .filter(o => o.bodyId === bodyId && o.ownedBy === 'player')
    .slice(0, 6);
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
  const activeDesignOf = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    gameState.shipDesigns?.find(d => d.shipClass === cls && d.isActive);
  const activeVariant = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    activeDesignOf(cls)?.iconVariant;

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
          status: 'waiting',
        },
      ],
    });
    const req = mpActions?.build({
      bodyId, shipClass: cls, shipName, iconVariant: activeVariant(cls),
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
      onErr(res.error ?? 'Build rejected by server');
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
      onErr('That order is still being placed — give it a second.');
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
    if (res && !res.ok) onErr(res.error ?? 'Could not cancel build');
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
      onErr(res.error ?? 'Could not set that order');
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
      onErr('That order is still being placed — give it a second.');
      if (before) {
        updateGameState({
          buildOrders: gsRef.current.buildOrders.map(o => (o.id === orderId ? before : o)),
        });
      }
      return;
    }
    const res = await mpActions?.setBuildOrder(serverId, intent);
    if (res && !res.ok) {
      onErr(res.error ?? 'Could not set that order');
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
      return `Go to ${gameState.bodies.find(b => b.id === o.buildOrderBodyId)?.name ?? '?'}`;
    }
    if (o.buildOrder === 'join_fleet') {
      return `Join ${joinableFleets.find(f => f.id === o.buildOrderFleetId)?.name ?? 'fleet'}`;
    }
    if (o.buildOrder === 'trade_route') {
      const r = joinableRoutes.find(x => x.id === o.buildOrderRouteId);
      return `Join ${r ? routeLabel(r) : 'route'}`;
    }
    if (o.buildOrder === 'stay') return 'Wait here';
    return o.buildOrder === 'defensive' ? 'Defend' : 'Hold';
  };

  /** What the yard is doing, worded for the row's follow option. Null
   *  when the yard has no opinion — the rows then read "wait here",
   *  which is what they will actually do. */
  const yardOrderLabel: string | null = !buildOrder ? null
    : buildOrder === 'go_to'
      ? `go to ${gameState.bodies.find(b => b.id === buildOrderBody)?.name ?? '?'}`
      : buildOrder === 'join_fleet'
        ? `join ${joinableFleets.find(f => f.id === buildOrderFleet)?.name ?? 'fleet'}`
        : buildOrder === 'trade_route'
          ? `join ${orderRouteName}`
          : buildOrder === 'defensive' ? 'defend' : 'hold';

  const qRow = (o: typeof orders[number], isBuilding: boolean) => {
    const span = Math.max(1, o.completeTick - o.startTick);
    const done = Math.max(0, Math.min(1, (gameState.currentTick - o.startTick) / span));
    const eta = Math.max(0, o.completeTick - gameState.currentTick);
    return (
      <div className={`wm-qrow ${isBuilding ? 'building' : 'waiting'}`} key={o.id}>
        <div className="wm-qhead">
          <ShipIcon shipClass={o.shipClass} variant={o.iconVariant} size={15} color={p1} color2={p2} />
          <span className="wm-qnm">{o.shipName ?? o.shipClass}</span>
          <span className="wm-qeta">{isBuilding ? `T-${eta}` : 'queued'}</span>
          {o.botched && (
            <span
              title="A rush went badly — this hull will be delivered at HALF health."
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
              title={isBuilding ? 'Cancel construction (refunds cost)' : 'Remove from queue (refunds cost)'}
              aria-label="Cancel build"
            >✕</button>
          )}
        </div>
        {isMine && (
          <select
            className="wm-qorder"
            value={o.buildOrder === 'join_fleet' && o.buildOrderFleetId
              ? `fleet:${o.buildOrderFleetId}`
              : o.buildOrder ?? ''}
            title="What THIS hull does the moment it rolls out."
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
              {yardOrderLabel ? `Same as yard · ${yardOrderLabel}` : 'Same as yard · wait here'}
            </option>
            <option value="stay">Wait here</option>
            <option value="defensive">Defend</option>
            <option value="go_to">
              {o.buildOrder === 'go_to' ? rowOrderLabel(o) : 'Go to…'}
            </option>
            {/* SHOWN EVEN WHEN THERE IS NOTHING TO JOIN, disabled and
                saying why. Hiding them made the two best verbs invisible
                to anyone who had not already formed a fleet or laid a
                lane — which is everyone, the first time. "Don't see it"
                was exactly that: the option was correct to be
                unselectable and wrong to be absent. */}
            {joinableFleets.length > 0
              ? joinableFleets.map(f => (
                <option key={f.id} value={`fleet:${f.id}`}>Join {f.name}</option>
              ))
              : <option value="__no_fleets" disabled>Join a fleet — none formed yet</option>}
            {joinableRoutes.length > 0 ? (
              <option value="trade_route">
                {o.buildOrder === 'trade_route' ? rowOrderLabel(o) : 'Join trade route…'}
              </option>
            ) : (
              <option value="__no_routes" disabled>Join a trade route — none laid yet</option>
            )}
          </select>
        )}
        <div className="wm-qbar">
          <i style={{ width: `${(isBuilding ? done : 0) * 100}%` }} />
        </div>
      </div>
    );
  };

  return (
    <section
      className="wm-fleet"
      style={mobile ? undefined : { left: '50%', transform: 'translateX(-50%)' }}
      data-testid="wm-fleet"
      data-tutorial-id="wm-build"
    >
      {/* SETTINGS STRIP. Slots, the name field and ON COMPLETION are one
          thing -- configuration for the NEXT hull you queue -- so they sit
          together above the two content panes rather than competing with
          them for width. ON COMPLETION used to be a third column here,
          which is why its label wrapped and its value truncated: a
          horizontal label needs horizontal room. */}
      <div className="wm-fleet-set">
        <span className="wm-fleet-title">
          SLOTS <b>{building.length}/{Math.max(slots, building.length)}</b>
        </span>
        <input
          className="wm-name-input"
          type="text"
          maxLength={28}
          value={nameDraft}
          onChange={e => setNameDraft(e.target.value)}
          placeholder="Name next ship (optional)"
          data-testid="wm-ship-name"
        />
        {isMine && hasStation && (
          <span className="wm-oncomplete">
            <span className="wm-oncomplete__k">YARD ORDER</span>
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
              title="What this yard tells its ships to do the moment they roll out. Any queued hull can override it."
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
              <option value="">Wait here</option>
              <option value="defensive">Defend</option>
              <option value="go_to">
                {buildOrder === 'go_to' && buildOrderBody
                  ? `Go to ${gameState.bodies.find(b => b.id === buildOrderBody)?.name ?? '?'}`
                  : 'Go to…'}
              </option>
              {/* Same reasoning as the per-row control below: an absent
                  option teaches that the feature does not exist. */}
              {joinableFleets.length > 0
                ? joinableFleets.map(f => (
                  <option key={f.id} value={`fleet:${f.id}`}>Join {f.name}</option>
                ))
                : <option value="__no_fleets" disabled>Join a fleet — none formed yet</option>}
              {joinableRoutes.length > 0 ? (
                <option value="trade_route">
                  {buildOrder === 'trade_route' && buildOrderRoute
                    ? `Join ${orderRouteName}`
                    : 'Join trade route…'}
                </option>
              ) : (
                <option value="__no_routes" disabled>Join a trade route — none laid yet</option>
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
            {routePickerFor === NEXT_SHIP ? 'SIGN NEW SHIPS ONTO' : 'SIGN THIS HULL ONTO'}
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
          >CANCEL</button>
        </div>
      )}
      {orderPickerFor && (
        <TransferTargetPicker
          bodies={gameState.bodies}
          excludeBodyId={bodyId}
          title={orderPickerFor === NEXT_SHIP ? 'Send new ships to' : 'Send this hull to'}
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

      <div className="wm-fleet-body">
      <div className="wm-fleet-queue">
        <div className="wm-fleet-sub">IN THE YARD</div>
        {building.map(o => qRow(o, true))}
        {waiting.map(o => qRow(o, false))}
        {orders.length === 0 && (
          <div className="wm-qrow empty">{hasStation ? (slots > 0 ? 'slots idle' : 'build a shipyard for slots') : 'no station yet'}</div>
        )}
      </div>
      <div className="wm-fleet-grid">
        {BUILDABLE_CLASSES.map(cls => {
          const def = getShipClass(cls);
          // What the yard will ACTUALLY charge: bare hull + the active
          // design's parts, then scaled by the price dials. Empty slots
          // are free, so no design means no surcharge.
          const parts = sanitizeParts(activeDesignOf(cls)?.parts ?? []);
          const pc = partsCost(parts);
          const costOre = priced(def.cost.ore + pc.ore);
          const costCredits = priced(def.cost.credits + pc.credits);
          // "Economy has been so confusing this game" was the other half
          // of the report. A correct-but-unexplained number still reads
          // as a bug, so the tooltip itemises it: bare hull, what the
          // loadout added, what a law did, total.
          const priceWhy = [
            `Build ${def.displayName} — ${def.buildTime} ticks`,
            `Hull ${def.cost.ore}M ${def.cost.credits}C`,
            pc.ore || pc.credits ? `Loadout +${pc.ore}M +${pc.credits}C` : '',
            priceLaw !== 1
              ? `Senate law: ship costs ${priceLaw < 1 ? '−' : '+'}${Math.round(Math.abs(1 - priceLaw) * 100)}%`
              : '',
            `Total ${costOre}M ${costCredits}C`,
            `Firepower ${def.firepower} · Hull ${def.hp}`,
          ].filter(Boolean).join('\n');
          const feat = HULL_FEATURE[cls];
          const lockObj = feat ? gate.lockReason(feat as Parameters<typeof gate.lockReason>[0]) : null;
          const lock = lockObj ? `${lockObj.label} — ${lockObj.text}` : null;
          const noYard = slots <= 0;
          const disabled = !isMine || !!lock || noYard;
          return (
            <button
              key={cls}
              className="wm-shipcell"
              disabled={disabled}
              title={lock ?? (noYard ? 'Build a shipyard first' : priceWhy)}
              onClick={() => buildShip(cls)}
              data-testid={`wm-ship-${cls}`}
            >
              {/* single row: icon+name left, all meta stacked in the
                  right-side blank space — nothing wraps or spills. */}
              <span className="wm-shipmain">
                <ShipIcon shipClass={cls} variant={activeVariant(cls)} size={18} color={p1} color2={p2} />
                <span className="wm-shipnm">{lock ? '🔒 ' : ''}{def.displayName.toUpperCase()}</span>
              </span>
              {/* One scan line of tabular figures, so the numbers column
                  up between cells. Firepower and hull moved into the
                  tooltip: nobody read them at 8.5px, and the cost is what
                  the decision actually turns on. */}
              <span className="wm-shipmeta">
                {costOre}m · {costCredits}c · {def.buildTime}t
              </span>
            </button>
          );
        })}
        <button
          className="wm-shipcell design"
          onClick={() => window.dispatchEvent(new CustomEvent('orbital:open-ship-designer'))}
        >
          <span className="wm-shipmain"><span className="wm-shipnm">◈ DESIGN</span></span>
          <span className="wm-shipmeta">custom hull</span>
        </button>
      </div>
      </div>
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
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  // Assign-freighter state (hooks stay above the early returns).
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

  // Only worlds that could host a city can be terraformed — the card is
  // noise on gas giants, stars and lagrange points.
  if (!canHostCity(body)) return null;
  const cfg = gameState.terraformConfig ?? { costMetal: 124, costCredits: 124, durationTicks: 24 };

  if (!isRawWorld(body)) {
    return (
      <div className="wm-terraform done" data-testid="wm-terraform" data-tutorial-id="terraform-section"
        title="Terraformed: every settlement here routes 100% of its yield to your pool, cities and city-buildings are allowed, and freighters can load pool cargo at the dock.">
        ● TERRAFORMED
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
        title="The full payload has been delivered — the transformation is running. Nothing can speed it up now; hold the world.">
        ◌ TERRAFORMING · {left} tick{left === 1 ? '' : 's'} to completion
      </div>
    );
  }

  const mPct = Math.min(100, (acc.metal / Math.max(1, cfg.costMetal)) * 100);
  const cPct = Math.min(100, (acc.credits / Math.max(1, cfg.costCredits)) * 100);
  return (
    <div className="wm-terraform" data-testid="wm-terraform" data-tutorial-id="terraform-section"
      title={`Raw world — it banks 90% of settlement yield locally and can host stations only. Deliver ${cfg.costMetal} metal + ${cfg.costCredits} credits by freighter supply route to terraform it (${cfg.durationTicks}-tick transformation once the payload lands). Progress is permanent and transfers with the world if it changes hands.`}>
      <div className="wm-terraform-head">
        <span>◌ RAW WORLD</span>
        <span className="wm-terraform-routes">
          {feeding > 0 ? `⇢ ${feeding} route${feeding === 1 ? '' : 's'} feeding` : 'no supply routes'}
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
      {/* Assign a freighter WITHOUT leaving the world: pick a hull +
          a loading dock, one click opens the terraform route. The same
          flow still exists ship-first in the ShipPanel route picker —
          this is the world-first mirror of it. */}
      {isMine && (() => {
        const shipSel = pickShip || freighters[0]?.id || '';
        const originSel = pickOrigin || docks[0]?.id || '';
        const bodyNameOf = (id: string | null | undefined) =>
          gameState.bodies.find(b => b.id === id)?.name ?? '?';
        const shipLabel = (s: Ship) =>
          `${s.name} · ${routedShips.has(s.id) ? 'on a route (reassigns)'
            : s.transit ? 'in transit'
            : `at ${bodyNameOf(s.orbit.parentBodyId)}`}`;
        if (freighters.length === 0) {
          return (
            <div className="wm-terraform-hint">
              No freighters — build one at a shipyard to start the payload.
            </div>
          );
        }
        if (docks.length === 0) {
          return (
            <div className="wm-terraform-hint">
              No loading dock — you need a settlement on a terraformed world
              to load the payload from.
            </div>
          );
        }
        const assign = async () => {
          if (!mpActions || !shipSel || !originSel || assignBusy) return;
          setAssignBusy(true);
          setAssignMsg(null);
          const res = await mpActions.createTradeRoute(shipSel, originSel, body.id);
          setAssignBusy(false);
          setAssignMsg(res.ok
            ? `⇢ Supply route opened — loading at ${bodyNameOf(originSel)}`
            : humanizeMpError(res.code, res.error, 'transfer'));
        };
        return (
          <div className="wm-terraform-assign">
            <select
              value={shipSel}
              onChange={e => setPickShip(e.target.value)}
              title="Which freighter runs the payload. One already on a route is reassigned; its old route is cancelled."
            >
              {freighters.map(s => (
                <option key={s.id} value={s.id}>{shipLabel(s)}</option>
              ))}
            </select>
            <select
              value={originSel}
              onChange={e => setPickOrigin(e.target.value)}
              title="The terraformed world the payload loads from — metal + credits come out of your faction POOL at this dock."
            >
              {docks.map(d => (
                <option key={d.id} value={d.id}>⇐ load at {d.name}</option>
              ))}
            </select>
            <button
              disabled={assignBusy || !shipSel || !originSel}
              onClick={assign}
              data-testid="wm-terraform-assign"
            >
              {feeding > 0 ? '+ ADD ROUTE' : '▶ START SUPPLY'}
            </button>
            {assignMsg && <div className="wm-terraform-hint">{assignMsg}</div>}
          </div>
        );
      })()}
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
          <span className="wm-dyson-title">☀ DYSON SPHERE</span>
          <span className="wm-dyson-owner" style={{ color: isMine ? '#6ee7b7' : '#ff8a4d' }}>
            {isMine ? '★ YOUR PROJECT' : `RIVAL: ${(controller?.name ?? '?').toUpperCase()}`}
          </span>
        </div>
        <div className="wm-dyson-bar">
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="wm-dyson-meta">
          {Math.round(dyson.hp).toLocaleString()} / {dyson.maxHp.toLocaleString()} · {pct.toFixed(1)}%
        </div>
        {isMine && (
          <div className="wm-dyson-supply" title="The sphere is built from cargo physically hauled here. Set a freighter's trade route from one of your terraformed worlds to the Dyson Sphere — it loads metal, credits and science from your pool at the dock and delivers on arrival. Freighters on the line can be raided; escort what you can't afford to lose.">
            {supplyRoutes > 0
              ? <>⇢ {supplyRoutes} supply route{supplyRoutes === 1 ? '' : 's'} hauling to the sphere</>
              : <span style={{ color: '#ffb84d' }}>⚠ No supply routes — construction is stalled. Give a freighter a route from a terraformed world to the Dyson Sphere.</span>}
          </div>
        )}
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
          {derelict ? '☀ DYSON SPHERE · ABANDONED' : '☀ DYSON SPHERE · slot open'}
        </span>
        {derelict && (
          <span className="wm-dyson-owner" style={{ color: '#ffb84d' }}>
            {derelictPct.toFixed(1)}% BUILT · UNCLAIMED
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
          ? <>The previous builder was thrown off. Most of their work survives —
              a fifth of it tore loose when the sphere went masterless. Lay a
              foundation at a Sol station to CLAIM it and resume construction
              at {derelictPct.toFixed(0)}%. Supply it by freighter routes from
              your terraformed worlds.</>
          : <>Lay the foundation at a Sol station, then run freighter routes
              from your terraformed worlds to deliver 15K metal · 15K credits ·
              10K science. Completion wins the match. Lose the foundation and
              the sphere goes masterless: <b>20% of your progress is destroyed</b>{' '}
              and the rest is there for whoever claims it first.</>}
      </div>
      {lock ? (
        <div className="wm-dyson-meta" style={{ color: '#8aa0b4' }}>🔒 {lock.label} — {lock.text}</div>
      ) : myStations.length === 0 ? (
        <div className="wm-dyson-meta" style={{ color: '#ffb84d' }}>
          Deploy a station in Sol orbit first to host the foundation.
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
                if (!res.ok) setErr(humanizeMpError(res.code, res.error ?? 'Initiate rejected.', 'build'));
              });
            }}
            title={derelict
              ? `Claim the abandoned sphere from ${s.name} — construction resumes at ${derelictPct.toFixed(0)}%, and completing it wins YOU the game.`
              : `Lay the Dyson Sphere foundation on ${s.name}. One sphere per game — lose the station and 20% of your progress is destroyed, with the rest left for whoever claims it first.`}
          >{derelict ? `◆ CLAIM AT ${s.name.toUpperCase()}` : `◆ INITIATE AT ${s.name.toUpperCase()}`}</button>
        ))
      )}
      {err && (
        <button className="wm-dyson-err" onClick={() => setErr(null)} title="Click to dismiss">
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
export const WorldMenuToggle: React.FC<{ on: boolean }> = ({ on }) => (
  <button
    className="wm-toggle-pill"
    data-testid="wm-toggle"
    title={on ? 'Switch back to the classic body inspector' : 'Switch to the diegetic world menu'}
    onClick={() => setWorldMenuPref(!on)}
  >
    {on ? '☰ CLASSIC UI' : '🪐 WORLD MENU'}
  </button>
);
