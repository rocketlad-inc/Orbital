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
import { BuildPanel } from '../components/BuildPanel';
import { getBodyFlavor } from '../game/bodyFlavor';
import { deriveSecondary } from '../game/colorUtils';
import { Body, BuildingKind, Settlement } from '../types';
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

const ORB_SLOTS = [
  { x: 0.34, y: 0.36, r: 0.062 },   // parent (biggest)
  { x: 0.47, y: 0.26, r: 0.030 },
  { x: 0.58, y: 0.38, r: 0.024 },
  { x: 0.67, y: 0.28, r: 0.020 },
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
  // While a menu is open: tag <body> so the left rail steps aside
  // (CSS in WorldMenuOverlay.css — MP-only by construction), and
  // measure the real TopBar so the panel tucks exactly under it.
  useEffect(() => {
    document.body.classList.toggle('wm-open', !!openId);
    const bar = document.querySelector('.top-bar') as HTMLElement | null;
    document.body.style.setProperty('--wm-topbar-h', `${bar?.offsetHeight ?? 52}px`);
    return () => { document.body.classList.remove('wm-open'); };
  }, [openId]);

  const setOpenId = setOpenIdRaw;
  const [collapsed, setCollapsed] = useState(true);
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

  if (!body || !readout || op <= 0.01) return null;

  const settled = z > 0.98;
  const isMine = readout.ownerFactionId === 'player';
  const cols = columnsFor(body);
  const flavor = getBodyFlavor(body.id);
  const integrity = myCity ?? myStation ?? here[0] ?? null;

  // Surface part screen positions (settled framing is deterministic:
  // centre at S1, radius Z1_FRAC·H — same math the canvas pass uses).
  const cx = S1X_FRAC * vw, cy = S1Y_FRAC * vh, cr = Z1_FRAC * vh;
  const partPos = (frac: number) => {
    const a = (-90 + frac * 46) * Math.PI / 180;
    return { x: cx + Math.cos(a) * cr, y: cy + Math.sin(a) * cr };
  };

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
      {/* ===== top readout panel ===== */}
      <section className={`wm-top ${mobile && collapsed ? 'collapsed' : ''}`} data-testid="wm-top">
        <div className="wm-id">
          {parentBody && (
            <button className="wm-crumb" onClick={() => selectBody(parentBody.id)}>
              ◂ {parentBody.name.toUpperCase()}
            </button>
          )}
          <div className="wm-name">{body.name.toUpperCase()}</div>
          <div className="wm-type">{body.type.replace('_', ' ')}</div>
          {readout.ownerFactionId && (
            <span
              className={`wm-owner ${isMine ? '' : 'neutral'}`}
              style={isMine ? { borderColor: p1, color: p1 } : undefined}
            >
              {isMine ? 'YOU' : (ownerFaction?.name ?? readout.ownerFactionId).toUpperCase()}
            </span>
          )}
        </div>
        {flavor && <div className="wm-desc">{flavor}</div>}
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

      {/* ===== station rig ===== */}
      {readout.station && (
        <svg className="wm-station" viewBox="0 0 170 320" data-testid="wm-station">
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

      {/* ===== build columns ===== */}
      <aside className="wm-col wm-col-left" data-testid="wm-col-surface">
        {!mobile && <div className="wm-col-label">SURFACE — <b>CITY</b></div>}
        {(cols.surface.length ? cols.surface : (['forge', 'mint', 'lab'] as BuildingKind[]))
          .map(k => buildBtn(k, cols.surface.length ? myCity : null, 'surface'))}
      </aside>
      <aside className="wm-col wm-col-right" data-testid="wm-col-orbit">
        {!mobile && <div className="wm-col-label">ORBIT — <b>STATION</b></div>}
        {cols.orbit.map(k => buildBtn(k, myStation, 'orbit'))}
      </aside>

      {/* ===== leader lines (desktop, settled only) ===== */}
      {settled && !mobile && (
        <svg className="wm-lines" width={vw} height={vh} aria-hidden="true">
          {cols.surface.map(k => {
            const p = partPos(PART_FRACS[k] ?? 0);
            if (p.y > vh - 60) return null;
            return <line key={k} x1={196} y1={0} x2={p.x} y2={p.y}
              data-wm-line={k} className="wm-line" />;
          })}
        </svg>
      )}

      {/* ===== fleet bar: the real BuildPanel, wholesale ===== */}
      <section className="wm-fleet" data-testid="wm-fleet">
        <div className="wm-fleet-head">
          <span className="wm-label">FLEET · SHIPYARD</span>
          <button
            className="wm-designer"
            onClick={() => window.dispatchEvent(new CustomEvent('orbital:open-ship-designer'))}
          >
            ◈ SHIP DESIGNER →
          </button>
        </div>
        <div className="wm-fleet-body"><BuildPanel /></div>
      </section>
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
