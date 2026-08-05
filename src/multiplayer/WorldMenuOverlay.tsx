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
import { shipyardSlotsAtBody, canHostCity, canHostStation, suggestSettlementName } from '../game/settlements';
import { EditableName } from '../components/EditableName';
import { RushControl } from '../components/BuildPanel';
import { humanizeMpError } from './errorMessages';
import { ShipIcon } from '../components/ShipIcons';
import { randomShipName } from '../game/shipNames';
import { deriveSecondary } from '../game/colorUtils';
import { getBodyFlavor } from '../game/bodyFlavor';
import { Body, BuildingKind, Settlement, SettlementType } from '../types';
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
const ORB_SLOTS = [
  { dx: 310, y: 90,  r: 40 },   // parent (biggest)
  { dx: 440, y: 130, r: 22 },
  { dx: 550, y: 100, r: 18 },
  { dx: 380, y: 210, r: 16 },
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
    };
    measure();
    // Live-track content growth (build queue rows appearing, More/Less).
    const ro = new ResizeObserver(measure);
    if (panelEl) ro.observe(panelEl);
    if (fleetEl) ro.observe(fleetEl);
    return () => ro.disconnect();
  }, [chromeMounted, collapsed, openId]);

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
    const res = await mpActions?.queueBuilding(settlement.id, kind);
    if (res && !res.ok) setErrMsg(res.error ?? 'Build rejected by server');
  };
  const deployCollector = async () => {
    const target = myCity ?? myStation;
    if (!target || readout?.hasCollector) return;
    setErrMsg(null);
    const res = await mpActions?.buildCollector(target.id);
    if (res && !res.ok) setErrMsg(res.error ?? 'Collector rejected by server');
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
    const name = suggestSettlementName(body, type, gameState.settlements);
    const res = await mpActions?.deploySettlement({ bodyId: openId, type, name });
    if (res && !res.ok) setErrMsg(res.error ?? `Could not found ${type}`);
  };

  // ---- founding a city / station (MP rules, mirrors BodyInspector) ----
  // city    : consumes a Colony Ship of yours in orbit.
  // station : research-gated (settlement.station); then a Colony Ship
  //           here OR an owned settlement here + 30M/20C.
  const colonyShipHere = useMemo(() => gameState.ships.find(s =>
    s.ownedBy === 'player' && !s.transit && s.orbit.parentBodyId === openId && s.class === 'colony',
  ), [gameState.ships, openId]);
  const stationLock = gate.lockReason('settlement.station');
  const mpRes = gameState.resources['player'];
  const canAffordStation = !!mpRes && mpRes.ore >= 30 && mpRes.credits >= 20;

  if (!body || !readout || op <= 0.01) return null;

  const settled = z > 0.98;
  const isMine = readout.ownerFactionId === 'player';
  const cols = columnsFor(body);
  const flavor = getBodyFlavor(body.id);
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
  const COL_W = 168, BTN_H = 40;
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
    const disabled = !isMine || st.state !== 'ready' || !!lockObj;
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
        className={`wm-bbtn ${st.state === 'ready' && st.level > 0 ? 'built' : ''} ${st.state === 'queued' ? 'queued' : ''}`}
        data-testid={`wm-build-${kind}`}
        disabled={disabled}
        title={lockObj ? `${lockObj.label} — ${lockObj.text}` : undefined}
        onClick={() => queueBuild(kind, host)}
      >
        <span className="wm-bbtn-nm">{kind.toUpperCase()}</span>
        <span className="wm-bbtn-st">{lockShort ?? st.text}</span>
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
    // NOT gated by isMine: founding is the WAY you take ownership of an
    // unclaimed body. The old check kept the button disabled on every
    // unowned body (ownerFactionId === null → isMine === false), which
    // was the "have a colony ship in orbit but Build Station is dead"
    // bug. The colony ship / stationLock / cost checks below are the
    // real gates — mirrors BodyInspector's showCityDeploy/showStationDeploy.
    const enabled = !(isCity ? false : !!stationLock) && (isCity
      ? !!colonyShipHere
      : (!!colonyShipHere || (own && canAffordStation)));
    const sub = isCity
      ? (colonyShipHere ? 'consumes colony ship' : 'needs colony ship in orbit')
      : (stationLock ? stationLock.text
        : colonyShipHere ? 'consumes colony ship'
        : own ? '30M · 20C' : 'needs colony ship in orbit');
    const title = isCity
      ? (colonyShipHere ? `Found a city — consumes ${colonyShipHere.name}` : 'Requires a Colony Ship in orbit (consumed)')
      : (stationLock ? `${stationLock.label} — ${stationLock.text}`
        : colonyShipHere ? `Launch a station — consumes ${colonyShipHere.name}`
        : own ? (canAffordStation ? 'Built from orbit: 30M 20C' : 'Need 30M 20C to build from orbit')
        : 'Requires a Colony Ship in orbit, or own a settlement here first');
    return (
      <button
        key={type}
        className="wm-bbtn wm-found"
        disabled={!enabled}
        title={title}
        onClick={() => foundSettlement(type)}
        data-testid={`wm-found-${type}`}
      >
        <span className="wm-bbtn-nm">{isCity ? '▲ FOUND CITY' : '▲ BUILD STATION'}</span>
        <span className="wm-bbtn-st">{stationLock && !isCity ? `🔒 ${sub}` : sub}</span>
      </button>
    );
  };

  // Column element lists — reused by desktop columns AND the mobile grid.
  // No city/station → offer the FOUND button (if the body can host one);
  // otherwise the upgrade buttons for that settlement.
  const surfaceEls = myCity
    ? cols.surface.map(k => buildBtn(k, myCity, 'surface'))
    : (body && canHostCity(body) ? [foundBtn('city')] : []);
  const orbitEls = myStation
    ? cols.orbit.map(k => buildBtn(k, myStation, 'orbit'))
    : (body && canHostStation(body) ? [foundBtn('station')] : []);

  const yieldChips: Array<[string, number]> = [
    ['F', readout.yields.fuel], ['M', readout.yields.ore],
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
              <span className="wm-yield" key={k}><i>{k}</i>{Math.round(v * 10) / 10}</span>
            ))}
          </div>
          <div className="wm-stock">
            <span className="wm-label">Stockpile</span>{' '}
            {/* Round, not floor: floor turns fp residue like 0.9999 into
                0 when the true stock is 1. Whole numbers everywhere. */}
            F{Math.round(readout.stockpile.fuel)} · M{Math.round(readout.stockpile.ore)} ·
            C{Math.round(readout.stockpile.credits)} · S{Math.round(readout.stockpile.science)}
          </div>
        </div>
        {isMine && (myCity || myStation) && (() => {
          // Collectors are research-gated (Propulsion 4). The button used
          // to look freely available even before research — surface the
          // requirement instead of letting the click bounce with a 403.
          const collectorLock = gate.lockReason('collectors');
          const built = readout.hasCollector;
          return (
            <button
              className={`wm-collector ${built ? 'built' : ''} ${collectorLock ? 'locked' : ''}`}
              onClick={deployCollector}
              disabled={built || !!collectorLock}
              title={collectorLock ? `${collectorLock.label} — ${collectorLock.text}` : undefined}
              data-testid="wm-collector"
              data-tutorial-id="collector-button"
            >
              {built
                ? '◉ Collector online'
                : collectorLock
                  ? `🔒 Collector · ${collectorLock.text}`
                  : '▲ Deploy collector'}
            </button>
          );
        })()}
        {/* Dyson Sphere (Sol only) — the engineering-victory megaproject
            had NO surface in the default world-menu UI; the initiate/
            progress panel lived only in the legacy BodyInspector. */}
        {body.id === 'sol' && <WmDysonCard />}
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
           each surface button to its limb building. Mobile: station row
           just above the horizon, city row down at the bottom. */}
      {mobile ? (
        <>
          {/* ORBIT — station build options at the top of the sky, ABOVE
              the station graphic. Nudged down for clearance from the
              collapsed title strip. */}
          {orbitEls.length > 0 && (
            <div
              className="wm-mrow wm-mrow-orbit" data-testid="wm-col-orbit"
              // panel sits at topbar+10, so its BOTTOM is topbar+10+panelH;
              // +12 breathing room below that (the old +14-from-topbar calc
              // ignored the panel's own 10px offset and overlapped it).
              style={{ top: 'calc(var(--wm-topbar-h, 52px) + var(--wm-panel-h, 44px) + 22px)' }}
            >
              {orbitEls}
            </div>
          )}
          {/* SURFACE — city build options docked snug against the TOP
              of the ship-build box (which itself clears the dock nav).
              A live ResizeObserver keeps chromeH.fleet accurate as the
              build queue grows/shrinks, so this never sits behind it. */}
          {surfaceEls.length > 0 && (
            <div
              className="wm-mrow wm-mrow-surface" data-testid="wm-col-surface"
              style={{ bottom: `calc(${chromeH.fleet}px + var(--mobile-rail-height, 72px) + 6px)` }}
            >
              {surfaceEls}
            </div>
          )}
        </>
      ) : (
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
           left, ship grid + DESIGN on the right. Not full-width. ===== */}
      <WmFleet
        bodyId={body.id}
        mobile={mobile}
        isMine={isMine}
        hasStation={!!myStation}
        railW={railW}
        onErr={setErrMsg}
      />
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
  const activeVariant = (cls: (typeof BUILDABLE_CLASSES)[number]) =>
    gameState.shipDesigns?.find(d => d.shipClass === cls && d.isActive)?.iconVariant;

  const buildShip = async (cls: (typeof BUILDABLE_CLASSES)[number]) => {
    onErr(null);
    const existing = new Set<string>([
      ...gameState.ships.map(s => s.name),
      ...gameState.buildOrders.map(o => o.shipName).filter(Boolean) as string[],
    ]);
    const shipName = nameDraft.trim() || randomShipName(cls, existing);
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
        ...gameState.buildOrders,
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
    const res = await mpActions?.build({ bodyId, shipClass: cls, shipName, iconVariant: activeVariant(cls) });
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
    const res = await mpActions?.cancelBuild(orderId);
    if (res && !res.ok) onErr(res.error ?? 'Could not cancel build');
  };

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
      <div className="wm-fleet-queue">
        <div className="wm-fleet-title">
          BUILD SLOTS <b>{building.length}/{Math.max(slots, building.length)}</b>
        </div>
        <input
          className="wm-name-input"
          type="text"
          maxLength={28}
          value={nameDraft}
          onChange={e => setNameDraft(e.target.value)}
          placeholder="Name next ship (optional)"
          data-testid="wm-ship-name"
        />
        {building.map(o => qRow(o, true))}
        {waiting.map(o => qRow(o, false))}
        {orders.length === 0 && (
          <div className="wm-qrow empty">{hasStation ? (slots > 0 ? 'slots idle' : 'build a shipyard for slots') : 'no station yet'}</div>
        )}
      </div>
      <div className="wm-fleet-grid">
        {BUILDABLE_CLASSES.map(cls => {
          const def = getShipClass(cls);
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
              title={lock ?? (noYard ? 'Build a shipyard first' : `Build ${def.displayName} — ${def.buildTime} ticks`)}
              onClick={() => buildShip(cls)}
              data-testid={`wm-ship-${cls}`}
            >
              {/* single row: icon+name left, all meta stacked in the
                  right-side blank space — nothing wraps or spills. */}
              <span className="wm-shipmain">
                <ShipIcon shipClass={cls} variant={activeVariant(cls)} size={18} color={p1} color2={p2} />
                <span className="wm-shipnm">{lock ? '🔒 ' : ''}{def.displayName.toUpperCase()}</span>
              </span>
              <span className="wm-shipside">
                <span><i>M</i>{def.cost.ore} <i>C</i>{def.cost.credits} · ⏱{def.buildTime}t</span>
                <span>◈{def.firepower} ✚{def.hp} · <b className="wm-go">BUILD ▸</b></span>
              </span>
            </button>
          );
        })}
        <button
          className="wm-shipcell design"
          onClick={() => window.dispatchEvent(new CustomEvent('orbital:open-ship-designer'))}
        >
          <span className="wm-shipmain"><span className="wm-shipnm">◈ DESIGN</span></span>
          <span className="wm-shipside">
            <span>custom hull</span>
            <span><b className="wm-go">OPEN ▸</b></span>
          </span>
        </button>
      </div>
    </section>
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
const DYSON_PUMP = { ore: 10, credits: 10, science: 5 };

const WmDysonCard: React.FC = () => {
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dyson = gameState.dysonSphere;

  if (dyson) {
    const isMine = dyson.controllerFactionId === 'player';
    const controller = gameState.factions.find(f => f.id === dyson.controllerFactionId);
    const pct = dyson.maxHp > 0 ? (dyson.hp / dyson.maxHp) * 100 : 0;
    const pumps = gameState.ships.filter(s =>
      s.ownedBy === 'player' && s.class === 'freighter' && !s.transit
      && s.orbit.parentBodyId === 'sol').length;
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
          <div className="wm-dyson-supply" title={`Each of your freighters parked at Sol delivers ${DYSON_PUMP.ore} metal + ${DYSON_PUMP.credits} credits + ${DYSON_PUMP.science} science per tick from your resource POOL into the sphere. Collectors and trade routes keep the pool filled — the freighters here are the pump.`}>
            {pumps > 0
              ? <>□ {pumps} freighter{pumps === 1 ? '' : 's'} pumping ≈{pumps * DYSON_PUMP.ore}M {pumps * DYSON_PUMP.credits}C {pumps * DYSON_PUMP.science}S /t from your pool</>
              : <span style={{ color: '#ffb84d' }}>⚠ No freighters at Sol — construction is stalled. Park freighters here to pump your pool into the sphere.</span>}
          </div>
        )}
      </div>
    );
  }

  // No sphere yet — the slot is open. Show initiate affordances.
  const myStations = gameState.settlements.filter(s =>
    s.ownedBy === 'player' && s.type === 'station' && s.bodyId === 'sol');
  const lock = gate.lockReason('dyson');
  return (
    <div className="wm-dyson" data-testid="wm-dyson" data-tutorial-id="dyson-sphere-section">
      <div className="wm-dyson-head">
        <span className="wm-dyson-title">☀ DYSON SPHERE · slot open</span>
      </div>
      <div className="wm-dyson-meta">
        Lay the foundation at a Sol station, then park freighters here to
        deliver 15K metal · 15K credits · 10K science. Completion wins the
        match. Destroying the foundation destroys ALL progress.
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
            title={`Lay the Dyson Sphere foundation on ${s.name}. One per game — losing the station collapses the whole project.`}
          >◆ INITIATE AT {s.name.toUpperCase()}</button>
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
