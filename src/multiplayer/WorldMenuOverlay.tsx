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
import { shipyardSlotsAtBody, canHostCity, canHostStation } from '../game/settlements';
import { getBodyFlavor } from '../game/bodyFlavor';
import { deriveSecondary } from '../game/colorUtils';
import { Body, BuildingKind, Settlement, SettlementType } from '../types';
import {
  menuScaleFor, menuCameraOffset, menuOpacity, zOf,
  S1X_FRAC, S1Y_FRAC, Z1_FRAC,
} from '../game/worldMenu/camera';
import { setWorldMenuActive } from '../game/worldMenu/store';
import { columnsFor, buildStatus, noHostText } from '../game/worldMenu/buildRules';
import { hpColor, flameCount } from '../game/worldMenu/combatDisplay';
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
const ORB_SLOTS = [
  { x: 0.33, y: 0.26, r: 0.040 },   // parent (biggest)
  { x: 0.45, y: 0.18, r: 0.020 },
  { x: 0.56, y: 0.26, r: 0.016 },
  { x: 0.66, y: 0.18, r: 0.014 },
];

export const WorldMenuOverlay: React.FC = () => {
  const {
    gameState, camera, uiState,
    updateCamera, focusBody, selectBody, deselectBody,
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
  const [collapsed, setCollapsed] = useState(true);
  // While a menu is open: tag <body> so the left rail steps aside
  // (CSS in WorldMenuOverlay.css — MP-only by construction), and
  // measure the real TopBar so the panel tucks exactly under it.
  useEffect(() => {
    document.body.classList.toggle('wm-open', !!openId);
    const measure = () => {
      const bar = document.querySelector('.top-bar') as HTMLElement | null;
      document.body.style.setProperty('--wm-topbar-h', `${bar?.offsetHeight ?? 52}px`);
      const panel = document.querySelector('.wm-top') as HTMLElement | null;
      document.body.style.setProperty('--wm-panel-h', `${panel?.offsetHeight ?? 92}px`);
      const fleet = document.querySelector('.wm-fleet') as HTMLElement | null;
      document.body.style.setProperty('--wm-fleet-h', `${fleet?.offsetHeight ?? 150}px`);
    };
    measure();
    // re-measure after the panel/fleet paint + on any content reflow
    const t = setTimeout(measure, 80);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
      document.body.classList.remove('wm-open');
    };
  }, [openId, collapsed]);

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
    if (!b || b.type === 'star' || b.type === 'lagrange') return;
    if (openId !== sel) {
      if (!openId) {
        camSnapshotRef.current = {
          x: camera.x, y: camera.y, scale: camera.scale, focusedBodyId: camera.focusedBodyId,
        };
      }
      const s1 = menuScaleFor(b, vh);
      const off = menuCameraOffset(vw, vh, s1);
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
    }
  }, [deselectBody, focusBody, updateCamera, setOpenId]);

  // z from the real camera; eased display copy for chrome fades.
  const zTarget = body ? zOf(camera.scale, body, vh) : 0;
  const z = useEasedZ(zTarget);
  const op = menuOpacity(z);

  // Wheel/pinch-out past the threshold dismisses (leave the camera
  // wherever the player pulled it — that WAS the dismissal gesture).
  useEffect(() => {
    if (openId && zTarget < 0.3) close(false);
  }, [zTarget, openId, close]);

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
  const buildingShipHere = gameState.buildOrders.some(o => o.bodyId === openId && o.ownedBy === 'player');

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
  const foundSettlement = async (type: SettlementType) => {
    if (!openId) return;
    setErrMsg(null);
    const res = await mpActions?.deploySettlement({ bodyId: openId, type });
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

  // Settled framing is deterministic: centre at S1, radius Z1_FRAC·H —
  // same math the canvas pass uses. Everything below anchors to it.
  const cx = S1X_FRAC * vw, cy = S1Y_FRAC * vh, cr = Z1_FRAC * vh;
  const partPos = (frac: number) => {
    const a = (-90 + frac * 46) * Math.PI / 180;
    return { x: cx + Math.cos(a) * cr, y: cy + Math.sin(a) * cr };
  };
  // Chrome geometry — build columns hover just off the limb; the
  // station rig floats off the upper-right limb; everything clamps
  // inside the rail/dock gutters.
  // Rail hides while the menu is open (body.wm-open) — only a small
  // gutter remains. Dock rail (right icons) stays.
  const railW = mobile ? 0 : 12, dockW = mobile ? 0 : 60;
  const COL_W = 176, BTN_H = 56;
  const leftColX = Math.max(railW + 10, cx - cr - COL_W - 26);
  const colTopY = cy - cr + 4;
  const staW = 150, staH = 280;
  const staX = Math.min(vw - dockW - staW - COL_W - 34, cx + cr * 0.72);
  const staY = Math.max(60, cy - cr - staH * 0.45);
  const rightColX = Math.min(vw - dockW - COL_W - 10, staX + staW + 24);
  // Leader-line anchor for the i-th button in a column.
  const btnAnchor = (colX: number, i: number, edge: 'right' | 'left') =>
    ({ x: edge === 'right' ? colX + COL_W : colX, y: colTopY + i * (BTN_H + 9) + BTN_H / 2 });
  // Station part anchors (viewBox 170x320 scaled to staW/staH).
  const staAnchor = (fy: number) => ({ x: staX + (staW * 0.5), y: staY + staH * fy });

  const buildBtn = (kind: BuildingKind, host: Settlement | null, column: 'surface' | 'orbit') => {
    const st = buildStatus(kind, host, {
      currentTick: gameState.currentTick,
      noHostText: noHostText(column, body),
    });
    const lockObj = st.state === 'ready' && st.level === 0 && BUILDING_FEATURE[kind]
      ? gate.lockReason(BUILDING_FEATURE[kind]) : null;
    const lock = lockObj ? `${lockObj.label} — ${lockObj.text}` : null;
    const disabled = !isMine || st.state !== 'ready' || !!lock;
    return (
      <button
        key={kind}
        className={`wm-bbtn ${st.state === 'ready' && st.level > 0 ? 'built' : ''}`}
        data-testid={`wm-build-${kind}`}
        disabled={disabled}
        title={lock ?? undefined}
        onClick={() => queueBuild(kind, host)}
      >
        <span className="wm-bbtn-nm">{kind.toUpperCase()}</span>
        <span className="wm-bbtn-st">{lock ? `🔒 ${lock}` : st.text}</span>
      </button>
    );
  };

  const foundBtn = (type: SettlementType) => {
    const isCity = type === 'city';
    const own = !!(myCity || myStation);
    const enabled = isMine && !(isCity ? false : !!stationLock) && (isCity
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
  const staFlames = readout.station ? flameCount(staHpRatio, 4) : 0;

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
        className={`wm-top ${mobile && collapsed ? 'collapsed' : ''}`}
        style={mobile ? undefined : { left: railW + 12, maxWidth: Math.min(620, vw - railW - dockW - 24) }}
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
        <div className="wm-out">
          <span className="wm-label">Output /t</span>
          <div className="wm-yields">
            {yieldChips.map(([k, v]) => (
              <span className="wm-yield" key={k}><i>{k}</i>{Math.round(v * 10) / 10}</span>
            ))}
          </div>
          <div className="wm-stock">
            <span className="wm-label">Stockpile</span>{' '}
            F{Math.floor(readout.stockpile.fuel)} · M{Math.floor(readout.stockpile.ore)} ·
            C{Math.floor(readout.stockpile.credits)} · S{Math.floor(readout.stockpile.science)}
          </div>
        </div>
        {isMine && (myCity || myStation) && (
          <button
            className={`wm-collector ${readout.hasCollector ? 'built' : ''}`}
            onClick={deployCollector}
            disabled={readout.hasCollector}
            data-testid="wm-collector"
          >
            {readout.hasCollector ? '◉ Collector online' : '▲ Deploy collector'}
          </button>
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

      {/* ===== neighbor orbs ===== */}
      <svg className="wm-orbs" width={vw} height={vh} aria-hidden="true">
        {neighbors.map((nb, i) => {
          const isParent = nb.id === body.parent;
          // parent occupies index 0 of the neighbors array, so sibling
          // indexes 1..3 map straight onto slots 1..3 (no double-count).
          const slot = ORB_SLOTS[isParent ? 0 : Math.min(3, Math.max(1, i))];
          const ox = slot.x * vw, oy = slot.y * vh, or = Math.max(9, slot.r * vh);
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
              <circle className={`wm-orb-ring ${isParent ? 'sel' : ''}`} r={or + 6} />
              <text y={or + 15} textAnchor="middle">{nb.name.toUpperCase()} ▸</text>
            </g>
          );
        })}
      </svg>

      {/* ===== station rig — floats off the upper-right limb ===== */}
      {readout.station && (
        <svg
          className="wm-station" viewBox="0 0 170 320" data-testid="wm-station"
          style={mobile
            ? { top: 'calc(var(--wm-topbar-h, 52px) + var(--wm-panel-h, 92px) + 8px)', right: 8, width: 92, height: 172 }
            : { left: staX, top: staY, width: staW, height: staH }}
        >
          <g className="wm-sta-core">
            <rect x="82" y="78" width="6" height="196" />
            <rect x="75" y="72" width="20" height="8" />
            <rect x="48" y="162" width="30" height="10" />
            <rect x="92" y="162" width="30" height="10" />
            <ellipse cx="85" cy="216" rx="56" ry="15" fill="none" strokeWidth="5" />
          </g>
          {myStation && (myStation.buildings?.weapons ?? 0) > 0 && (
            <g className="wm-sta-part" style={{ fill: p1 }}>
              <rect x="39" y="118" width="92" height="5" />
              <rect x="35" y="111" width="8" height="13" />
              <rect x="127" y="111" width="8" height="13" />
              <rect x="27" y="115" width="9" height="2.5" style={{ fill: p2 }} />
              <rect x="134" y="115" width="9" height="2.5" style={{ fill: p2 }} />
            </g>
          )}
          {myStation && (myStation.buildings?.shipyard ?? 0) > 0 && (
            <g className="wm-sta-part">
              <path d="M65,250 L45,250 L45,292 L65,292" fill="none" stroke={p1} strokeWidth="4" />
              <path d="M105,250 L125,250 L125,292 L105,292" fill="none" stroke={p1} strokeWidth="4" />
              {buildingShipHere && (
                <path d="M57,266 L101,266 L109,271 L101,276 L57,276 Z" fill="none"
                  stroke={p2} strokeWidth="1.5" strokeDasharray="4 3" data-testid="wm-hull" />
              )}
            </g>
          )}
          <text className="wm-sta-name" x="85" y="16" textAnchor="middle">
            {readout.station.name.toUpperCase()}
          </text>
          <rect x="29" y="22" width="112" height="7" rx="2" className="wm-hp-bg" />
          <rect x="29" y="22" width={112 * staHpRatio} height="7" rx="2" fill={hpColor(staHpRatio)} />
          <text className="wm-sta-hp" x="85" y="39" textAnchor="middle">
            {Math.round(readout.station.hp)} / {readout.station.maxHp}
          </text>
          {Array.from({ length: staFlames }, (_, i) => {
            const pts = [{ x: 62, y: 122 }, { x: 108, y: 122 }, { x: 85, y: 170 }, { x: 70, y: 216 }];
            const p = pts[i];
            return (
              <g key={i} className="wm-flame" style={{ animationDelay: `${i * 0.12}s` }}>
                <path d={`M${p.x},${p.y} c-4.4,-4.8 -2.2,-9.2 0,-13.6 c2.2,4.4 4.4,8.8 0,13.6`} fill="#ff5a1f" />
                <path d={`M${p.x},${p.y} c-2.4,-3.6 -1.2,-6 0,-9 c1.2,3 2.4,5.4 0,9`} fill="#ffca28" />
              </g>
            );
          })}
        </svg>
      )}

      {/* ===== build controls =====
           Desktop: two columns hovering just off the limb, leader lines
           from the button edge to the hardware. Mobile: ONE compact grid
           of all six over the planet (no columns, no lines). */}
      {mobile ? (
        <div className="wm-mgrid" data-testid="wm-col-surface">
          {surfaceEls}
          {orbitEls}
        </div>
      ) : (
        <>
          {surfaceEls.length > 0 && (
            <aside
              className="wm-col" data-testid="wm-col-surface"
              style={{ left: leftColX, top: colTopY, width: COL_W }}
            >
              <div className="wm-col-label">SURFACE — <b>CITY</b></div>
              {surfaceEls}
            </aside>
          )}
          {orbitEls.length > 0 && (
            <aside
              className="wm-col" data-testid="wm-col-orbit"
              style={{ left: rightColX, top: colTopY, width: COL_W }}
            >
              <div className="wm-col-label">ORBIT — <b>STATION</b></div>
              {orbitEls}
            </aside>
          )}

          {/* leader lines: button edge → limb part (surface) / station
              rig part (orbit). Only when the settlement (and thus the
              part) actually exists — no lines to a FOUND button. */}
          {settled && (
            <svg className="wm-lines" width={vw} height={vh} aria-hidden="true">
              {myCity && cols.surface.map((k, i) => {
                const from = btnAnchor(leftColX, i + 1, 'right'); // +1: label row
                const to = partPos(PART_FRACS[k] ?? 0);
                if (to.y > vh - 40) return null;
                const mx = (from.x + to.x) / 2;
                return <path key={k} data-wm-line={k} className="wm-line" fill="none"
                  d={`M${from.x},${from.y} C${mx},${from.y} ${mx},${to.y} ${to.x - 8},${to.y}`} />;
              })}
              {myStation && readout.station && cols.orbit.map((k, i) => {
                const from = btnAnchor(rightColX, i + 1, 'left');
                const to = staAnchor(k === 'weapons' ? 0.38 : k === 'shipyard' ? 0.84 : 0.55);
                const mx = (from.x + to.x) / 2;
                return <path key={k} data-wm-line={k} className="wm-line" fill="none"
                  d={`M${from.x},${from.y} C${mx},${from.y} ${mx},${to.y} ${to.x + staW * 0.28},${to.y}`} />;
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
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const gate = useFeatureGate();
  const slots = shipyardSlotsAtBody(bodyId, 'player', gameState.settlements);
  const orders = gameState.buildOrders
    .filter(o => o.bodyId === bodyId && o.ownedBy === 'player')
    .slice(0, 6);
  // MP tags queue state server-side; undefined status = building (legacy).
  const building = orders.filter(o => o.status !== 'waiting');
  const waiting = orders.filter(o => o.status === 'waiting');
  const buildShip = async (cls: (typeof BUILDABLE_CLASSES)[number]) => {
    onErr(null);
    const res = await mpActions?.build({ bodyId, shipClass: cls });
    if (res && !res.ok) onErr(res.error ?? 'Build rejected by server');
  };
  return (
    <section
      className="wm-fleet"
      style={mobile ? undefined : { left: '50%', transform: 'translateX(-50%)' }}
      data-testid="wm-fleet"
    >
      <div className="wm-fleet-queue">
        <div className="wm-fleet-title">
          BUILD SLOTS <b>{building.length}/{Math.max(slots, building.length)}</b>
        </div>
        {building.map(o => (
          <div className="wm-qrow building" key={o.id}>
            <span className="wm-qnm">{o.shipName ?? o.shipClass}</span>
            <span className="wm-qeta">T-{Math.max(0, o.completeTick - gameState.currentTick)} ↓</span>
          </div>
        ))}
        {waiting.map(o => (
          <div className="wm-qrow waiting" key={o.id}>
            <span className="wm-qnm">{o.shipName ?? o.shipClass}</span>
            <span className="wm-qeta">waiting</span>
          </div>
        ))}
        {orders.length === 0 && (
          <div className="wm-qrow empty">{hasStation ? (slots > 0 ? 'slots idle' : 'build a shipyard for slots') : 'no station yet'}</div>
        )}
      </div>
      <div className="wm-fleet-ships">
        {BUILDABLE_CLASSES.map(cls => {
          const def = getShipClass(cls);
          const feat = HULL_FEATURE[cls];
          const lockObj = feat ? gate.lockReason(feat as Parameters<typeof gate.lockReason>[0]) : null;
          const lock = lockObj ? `${lockObj.label} — ${lockObj.text}` : null;
          const noYard = slots <= 0;
          const disabled = !isMine || !!lock || noYard;
          return (
            <div className="wm-shiprow" key={cls} data-testid={`wm-ship-${cls}`}>
              <div className="wm-shipinfo">
                <span className="wm-shipnm">{lock ? '🔒 ' : ''}{def.displayName.toUpperCase()}</span>
                <span className="wm-shipmeta">
                  <span className="wm-cost"><i>M</i>{def.cost.ore} <i>C</i>{def.cost.credits}</span>
                  <span className="wm-time">⏱ {def.buildTime}t</span>
                  <span className="wm-stat">◈ {def.firepower} ✚ {def.hp}</span>
                </span>
              </div>
              <button
                className="wm-shipbuild"
                disabled={disabled}
                title={lock ?? (noYard ? 'Build a shipyard first' : `Build ${def.displayName} — ${def.buildTime} ticks`)}
                onClick={() => buildShip(cls)}
              >
                BUILD
              </button>
            </div>
          );
        })}
        <button
          className="wm-designrow"
          onClick={() => window.dispatchEvent(new CustomEvent('orbital:open-ship-designer'))}
        >
          ◈ SHIP DESIGNER →
        </button>
      </div>
    </section>
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
