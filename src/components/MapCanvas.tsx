import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMapLayers } from '../state/mapLayers';
import {
  clearCanvas,
  drawOrbit,
  drawBody,
  drawAsteroidBeltDust,
  drawRammingBody,
  drawShip,
  drawOrbitEllipse,
  drawApsisMarkers,
  drawTorchTrajectory,
  drawTransitShip,
  drawGhostPlanet,
  drawTargetHighlight,
  drawSettlement,
  drawShipGhost,
  drawAllTransfersLayer,
  drawEnemyTrajectoriesLayer,
  drawOwnershipLayer,
  drawSystemRegions,
  systemRegionOpacity,
  drawFogOfWarOverlay,
  drawDestructionFlashes,
  generateStarfield,
  drawStarfield,
  StarfieldCache,
  GhostIntel,
  worldToCanvas,
  canvasToWorld,
  RenderContext,
  TRAJECTORY_COLORS,
  trajectoryRole,
} from '../render/mapRenderer';
import { computeSystemRegions } from '../render/systemRegions';
import {
  spawnTracer,
  drawTracers,
  drawEngagementFire,
  drawDetonations,
  spawnArrivalFlash,
  drawArrivalFlashes,
  enqueueDetonation,
} from '../render/combatFx';
import { drainVisibleFx } from '../render/pendingFx';
import { bodyPosition } from '../physics/orbitalMechanics';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import { COLORS, withOpacity } from '../render/colors';
import { shipWorldPosition } from '../game/combat';
import { getShipClass } from '../game/shipClasses';
import { computeIncomingThreats, threatenedBodyIds } from '../game/threats';
import { computeVisibility, factionSensorRings, GHOST_LIFETIME_TICKS } from '../game/visibility';
import { useCanvasTouchInput } from '../hooks/useCanvasTouchInput';
import { isCoarsePointer } from '../hooks/useIsMobile';
import { GIT_SHA } from '../_version';
import './MapCanvas.css';

/** Extra hit-radius padding when the primary input is touch. Apple/Material
 *  guidelines recommend ~44px tap targets; we widen the click radius rather
 *  than enlarge the rendered icon. */
const TOUCH_HIT_PADDING = isCoarsePointer() ? 16 : 0;

/**
 * Below this camera scale, parked ships at a body collapse into a single
 * "N ships" cluster badge rendered next to the body. Reduces the visual
 * noise when zoomed out far enough that ship sprites + labels pile on top
 * of each other (playtester report: solar-system view = unreadable smear
 * of overlapping triangles).
 *
 * Raised 0.6 -> 2.5 so individual hulls only appear once you're actually
 * inside a planet's moon system — the zoom where a fleet is a thing you
 * manoeuvre rather than a dot you count. Below that the map is a
 * strategic view and the cluster badge carries the same information in
 * one glyph.
 *
 * The selected ship and any in-transit ship always render in full so the
 * player can still track them across the zoomed-out view; only the
 * stationary at-body clusters collapse.
 */
const CLUSTER_ZOOM_THRESHOLD = 2.5;

/** Camera scale at/above which a queued chronicle effect is considered
 *  "watchable" and allowed to play. Below this an explosion is a
 *  meaningless speck, so the effect keeps waiting instead of being
 *  wasted. Sits just under DEFAULT_CAMERA_SCALE (0.5) so effects DO
 *  play at the default framing — gating above it would have made the
 *  whole system look dead until the player manually zoomed in. */
const PENDING_FX_MIN_SCALE = 0.45;

interface MapCanvasProps {
  width?: number;
  height?: number;
}


export const MapCanvas: React.FC<MapCanvasProps> = ({
  width = typeof window !== 'undefined' ? window.innerWidth : 1280,
  height = typeof window !== 'undefined' ? window.innerHeight : 800,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const {
    gameState, camera, uiState, simSpeed,
    updateCamera, selectShip, selectBody, deselectShip, deselectBody,
    hoverBody, focusBody,
    setTargetSelectionMode,
    selectedSettlementId,
  } = useGameContext();

  const [panState, setPanState] = useState<{
    startX: number;
    startY: number;
    camX: number;
    camY: number;
  } | null>(null);

  // Starfield: generated once and regenerated when canvas size changes
  const starfieldRef = useRef<StarfieldCache | null>(null);

  // Fog of war: keep a rolling lastSeen map for the viewing faction
  const lastSeenRef = useRef<Map<string, GhostIntel>>(new Map());

  // Flash bookkeeping. Tick-based (not wall-clock) so the fade
  // duration is consistent across sim speeds — at 100× a flash that
  // started "now" still gets DAMAGE_FLASH_DURATION_TICKS to play out,
  // it just feels faster. A single +10-tick skip naturally resolves
  // any flash that started inside it.
  //
  //   prevDamageTick     — last lastDamagedTick value seen per entity
  //   damageFlashStart   — tick value when we first noticed the hit
  //                        (passed to renderer, fades over ~10 ticks)
  //   prevShipIds        — snapshot of last frame's ship ids; entries
  //                        that disappear become destruction flashes
  //   destructionFlashes — { id → { pos, startMs } } for entities
  //                        that have died recently. Renderer draws a
  //                        bigger orange "explosion" variant at each
  //                        position, then we prune entries older than
  //                        DESTRUCTION_FLASH_DURATION_TICKS.
  const prevDamageTickRef = useRef<Map<string, number>>(new Map());
  /** Last observed hp per ship id. The authoritative damage signal in
   *  BOTH engines (MP never populates lastDamagedTick) — an hp drop
   *  between polls drives damage flashes + combat tracers. */
  const prevHpRef = useRef<Map<string, number>>(new Map());
  const damageFlashStartRef = useRef<Map<string, number>>(new Map());
  // Population-growth pulse (§E4): prevPop tracks the last observed
  // population per settlement id; an increase stamps growthFlashStart
  // with wall-clock ms (the growth pulse is a 600ms cosmetic, so ms —
  // not ticks — is the right base). Pruned each frame after expiry.
  const prevPopRef = useRef<Map<string, number>>(new Map());
  const growthFlashStartRef = useRef<Map<string, number>>(new Map());
  // Camera easing (§E5). Programmatic camera changes (focusBody,
  // selectBody-driven moves, initialFocus) tween position+scale over
  // ~250ms ease-out-cubic; direct user input (wheel/pinch/pan/WASD)
  // snaps and cancels any active tween.
  //   camTweenRef       — active tween: rendered-camera snapshot at the
  //                       moment the target changed, + start ms. The
  //                       *target* is re-read live each frame (focused
  //                       bodies orbit while we fly to them).
  //   prevCamSigRef     — last camera state observed by render(), used
  //                       to detect programmatic changes.
  //   lastRenderedCamRef— effective camera actually drawn last frame
  //                       (tween "from" values come from here).
  //   directCamInputRef — set by input handlers right before their
  //                       updateCamera call; consumed by render().
  const camTweenRef = useRef<{ fromX: number; fromY: number; fromScale: number; startMs: number } | null>(null);
  const prevCamSigRef = useRef<{ x: number; y: number; scale: number; focusedBodyId?: string } | null>(null);
  const lastRenderedCamRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const directCamInputRef = useRef(false);
  const tweenRafRef = useRef<number | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const prevShipIdsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Ids of ships that were in torch transit last frame. Diffed against
  // this frame the same way hp deltas are — a ship present both frames
  // that dropped its .transit just ARRIVED, which triggers the soft
  // arrival ring (combatFx.spawnArrivalFlash). null = first frame, skip
  // the diff so a mid-flight page load doesn't fire a phantom flash.
  const prevTransitIdsRef = useRef<Set<string> | null>(null);
  const prevSettlementIdsRef = useRef<Map<string, { x: number; y: number; bodyId: string }>>(new Map());
  const destructionFlashesRef = useRef<Map<string, { pos: { x: number; y: number }; startMs: number; baseRadius?: number; id?: string }>>(new Map());
  // Last-rendered CANVAS position of every in-transit ship, populated by
  // the render loop and consumed by the click hit-test. The visual ship
  // sits on a polyline lerp (drawTorchTransitShip's lerpedPos) while
  // ship.transit.pos is an independent integration; the two can disagree
  // by several pixels mid-segment. Storing what the renderer actually
  // drew makes visual == clickable by construction — no more "I see the
  // ship but my click goes through it." Reset each frame so a destroyed
  // ship doesn't keep an undead hitbox. Parked ships hit the regular
  // getShipCanvasPos path; this map only exists for transit ships.
  const transitShipCanvasPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Ship under the cursor — drives the hover-only name label. A ref, not
  // state: mousemove fires on every pixel and the render loop already
  // runs each frame, so re-rendering the component for a label would be
  // pure churn. The loop reads .current when it builds RenderContext.
  const hoveredShipIdRef = useRef<string | null>(null);

  // Map layers: source of truth lives in MapLayersProvider (state +
  // localStorage). The Set is surfaced as a render dep so toggling
  // any layer triggers a redraw (isOn would otherwise be stable
  // across toggles). The old V-key sensor toggle was removed when
  // sensor coverage became an always-on fog overlay.
  const { enabled: enabledLayers, isOn: layerOn } = useMapLayers();


  // Camera updates coming from DIRECT user input (wheel zoom, drag pan,
  // WASD, touch pan/pinch). These stay 1:1 — no easing — and any active
  // programmatic tween dies immediately so the user is never fighting
  // an animation for control of the viewport.
  const directUpdateCamera = useCallback((partial: Parameters<typeof updateCamera>[0]) => {
    directCamInputRef.current = true;
    camTweenRef.current = null;
    updateCamera(partial);
  }, [updateCamera]);

  // Escape key cancels target selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && uiState.targetSelectionMode) {
        setTargetSelectionMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [uiState.targetSelectionMode, setTargetSelectionMode]);

  const render = useCallback(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // When a body is focused, recompute its world position each frame so
    // the camera tracks it as it orbits.
    let camX = camera.x;
    let camY = camera.y;
    if (camera.focusedBodyId) {
      const focusedBody = gameState.bodies.find(b => b.id === camera.focusedBodyId);
      if (focusedBody) {
        const pos = bodyPosition(focusedBody, gameState.currentTick, gameState.bodies);
        camX = pos.x;
        camY = pos.y;
      }
    }

    // === Camera easing (§E5) ===
    // Detect camera-state changes. Direct input (flag set by
    // directUpdateCamera) snaps; anything else — focusBody, selectBody
    // side effects, initialFocus — tweens from the camera we actually
    // rendered last frame to the (live) target over 250ms ease-out.
    const nowMsCam = performance.now();
    let camScale = camera.scale;
    {
      const prevSig = prevCamSigRef.current;
      const changed = !prevSig
        || prevSig.x !== camera.x || prevSig.y !== camera.y
        || prevSig.scale !== camera.scale
        || prevSig.focusedBodyId !== camera.focusedBodyId;
      if (changed) {
        const from = lastRenderedCamRef.current;
        if (prevSig && from && !directCamInputRef.current) {
          camTweenRef.current = {
            fromX: from.x, fromY: from.y, fromScale: from.scale, startMs: nowMsCam,
          };
        } else {
          camTweenRef.current = null; // first frame or direct input: snap
        }
        directCamInputRef.current = false;
        prevCamSigRef.current = {
          x: camera.x, y: camera.y, scale: camera.scale,
          focusedBodyId: camera.focusedBodyId,
        };
      }
      const tw = camTweenRef.current;
      if (tw) {
        const tt = (nowMsCam - tw.startMs) / 250;
        if (tt >= 1) {
          camTweenRef.current = null;
        } else {
          const e = 1 - Math.pow(1 - tt, 3); // ease-out cubic
          camX = tw.fromX + (camX - tw.fromX) * e;
          camY = tw.fromY + (camY - tw.fromY) * e;
          camScale = tw.fromScale + (camera.scale - tw.fromScale) * e;
        }
      }
      lastRenderedCamRef.current = { x: camX, y: camY, scale: camScale };
    }

    // === Flash bookkeeping (damage + destruction) ===
    // Tick-based so the visual duration is consistent across sim
    // speeds. Damage = entity present with a new lastDamagedTick;
    // destruction = entity present last frame but missing this frame.
    const nowMs = performance.now();
    const nowTick = gameState.currentTick;

    // Build the current frame's ship-pos snapshot so we can both
    // (a) record damage flashes on hit and (b) remember positions
    // for any disappearing entries so destruction has a place to draw.
    const curShipIds = new Map<string, { x: number; y: number }>();
    // Reset the transit-ship canvas-position cache — it gets repopulated
    // per-frame by the per-ship overlay below. A ship that arrived and
    // dropped out of transit shouldn't keep its old hitbox.
    transitShipCanvasPosRef.current.clear();
    const curTransitIds = new Set<string>();
    for (const ship of gameState.ships) {
      if (ship.transit) curTransitIds.add(ship.id);
      // Position now; ships in transit use the torch trajectory so they
      // explode at the spot they were on the burn when killed.
      // shipWorldPosition returns null for ships whose parent body
      // has gone missing — skip those rather than crash.
      const pos: { x: number; y: number } | null =
        shipWorldPosition(ship, nowTick, gameState.bodies);
      if (pos) curShipIds.set(ship.id, pos);

      // Damage detection. MUST be hp-based: `lastDamagedTick` is only
      // ever populated by the single-player engine — the MP /state
      // payload carries `last_combat_tick` (when a ship FIRED), not when
      // it was hit, so keying on it meant every MP ship hit the
      // `undefined` guard and neither damage flashes NOR tracers ever
      // fired in multiplayer. An hp drop between polls is the one signal
      // that's authoritative in both engines. The tick path is kept as a
      // secondary trigger so SP still flashes on a 0-damage graze.
      const curHp = ship.hp;
      const prevHp = prevHpRef.current.get(ship.id);
      if (curHp !== undefined) prevHpRef.current.set(ship.id, curHp);
      const tookDamage =
        prevHp !== undefined && curHp !== undefined && curHp < prevHp;

      const cur = ship.lastDamagedTick;
      const prev = prevDamageTickRef.current.get(ship.id);
      if (cur !== undefined) prevDamageTickRef.current.set(ship.id, cur);
      const tickAdvanced = cur !== undefined && prev !== undefined && prev !== cur;

      if (tookDamage || tickAdvanced) {
        damageFlashStartRef.current.set(ship.id, nowMs);
        // Tracer fire (combatFx §1): the hp drop means some hostile
        // armed ship at the same body fired a volley. Attribute the
        // shot deterministically — lowest ship id among armed hostiles
        // at the body — so every client draws the same tracer. Skip
        // ships in transit (auto-combat is at-body only, so a transit
        // "hit" has no local shooter). First-observation is already
        // excluded: both triggers above require a prior sample, so a
        // page load can't manufacture a volley. (This guard used to test
        // `prev !== undefined`, the SP-only tick — which is always
        // undefined in MP and silently suppressed every tracer.)
        if (!ship.transit) {
          const atBody = ship.orbit.parentBodyId;
          let attackerId: string | null = null;
          for (const s of gameState.ships) {
            if (s.id === ship.id || s.transit) continue;
            if (s.orbit.parentBodyId !== atBody) continue;
            if (s.ownedBy === ship.ownedBy) continue;
            if (getShipClass(s.class).damagePerTick <= 0) continue;
            if (attackerId === null || s.id < attackerId) attackerId = s.id;
          }
          if (attackerId) spawnTracer(attackerId, ship.id, nowMs);
        }
      }
    }
    // Arrival flash (combatFx §4): in transit last frame, orbiting this
    // frame, still alive → the ship just arrived at a body.
    if (prevTransitIdsRef.current) {
      for (const id of prevTransitIdsRef.current) {
        if (!curTransitIds.has(id) && curShipIds.has(id)) {
          spawnArrivalFlash(id, nowMs);
        }
      }
    }
    prevTransitIdsRef.current = curTransitIds;
    // Detect ship disappearance → destruction flash at last known pos.
    // Skip the very first frame (prevShipIds empty = initial mount,
    // not a die-off). The class-based base radius scales the boom
    // with ship size so a destroyer pops bigger than a corvette.
    //
    // CRITICAL fog-of-war check: an enemy ship can disappear from
    // /state for TWO reasons — it was destroyed, or it drifted out of
    // the player's sensor coverage. Only flash when the last known
    // position was inside coverage at this moment, so fog-out doesn't
    // paint fake combat blooms. Computed lazily and once per frame.
    // Allies (MP defense-pact / intel-share) share sensor coverage —
    // their sources count as the player's own for fog, flash-gating,
    // and yield-readout reveal. Empty in single-player.
    const alliedSet: ReadonlySet<string> = new Set(gameState.alliedFactionIds ?? []);
    const sensorRingsThisFrame = factionSensorRings(
      'player',
      gameState.ships,
      gameState.settlements,
      gameState.bodies,
      nowTick,
      alliedSet,
    );
    const wasInCoverage = (pos: { x: number; y: number }): boolean => {
      for (const r of sensorRingsThisFrame) {
        const dx = pos.x - r.pos.x;
        const dy = pos.y - r.pos.y;
        if (dx * dx + dy * dy <= r.range * r.range) return true;
      }
      return false;
    };

    if (prevShipIdsRef.current.size > 0) {
      for (const [id, pos] of prevShipIdsRef.current) {
        if (!curShipIds.has(id) && !destructionFlashesRef.current.has(id)) {
          if (!wasInCoverage(pos)) continue; // fog-out, not destruction
          destructionFlashesRef.current.set(id, { pos, startMs: nowMs, baseRadius: 12, id });
        }
      }
    }
    prevShipIdsRef.current = curShipIds;

    // Settlements get the same treatment but their position is the
    // body world-position (cities + stations both render adjacent to
    // their body). Reusing bodyPosition keeps the math tight.
    const curSettlementIds = new Map<string, { x: number; y: number; bodyId: string }>();
    for (const settlement of gameState.settlements) {
      const body = gameState.bodies.find(b => b.id === settlement.bodyId);
      if (body) {
        const bp = bodyPosition(body, nowTick, gameState.bodies);
        curSettlementIds.set(settlement.id, { x: bp.x, y: bp.y, bodyId: settlement.bodyId });
      }

      // Population growth pulse (§E4): stamp wall-clock ms the frame we
      // first see the pop tick upward. First observation just seeds.
      const prevPop = prevPopRef.current.get(settlement.id);
      if (prevPop !== undefined && settlement.population > prevPop) {
        growthFlashStartRef.current.set(settlement.id, nowMs);
      }
      prevPopRef.current.set(settlement.id, settlement.population);

      // Same hp-based rule as ships — settlement.lastDamagedTick is
      // likewise SP-only, so bombardment never flashed in MP.
      const curHp = settlement.hp;
      const prevHp = prevHpRef.current.get(settlement.id);
      if (curHp !== undefined) prevHpRef.current.set(settlement.id, curHp);
      const tookDamage =
        prevHp !== undefined && curHp !== undefined && curHp < prevHp;

      const cur = settlement.lastDamagedTick;
      const prev = prevDamageTickRef.current.get(settlement.id);
      if (cur !== undefined) prevDamageTickRef.current.set(settlement.id, cur);
      const tickAdvanced = cur !== undefined && prev !== undefined && prev !== cur;

      if (tookDamage || tickAdvanced) {
        damageFlashStartRef.current.set(settlement.id, nowMs);
      }
    }
    if (prevSettlementIdsRef.current.size > 0) {
      for (const [id, snap] of prevSettlementIdsRef.current) {
        if (!curSettlementIds.has(id) && !destructionFlashesRef.current.has(id)) {
          // Same fog-of-war guard as ships: skip if the body that
          // hosted this settlement is now outside the player's sensor
          // coverage. Settlement loss without a kill chronicle event
          // is far more likely a fog-out than a destruction.
          if (!wasInCoverage({ x: snap.x, y: snap.y })) continue;
          destructionFlashesRef.current.set(id, {
            pos: { x: snap.x, y: snap.y },
            startMs: nowMs,
            baseRadius: 14,
            id,
          });
        }
      }
    }
    prevSettlementIdsRef.current = curSettlementIds;

    // Prune flashes that have fully faded — keeps the map clean and
    // bounds memory in a long campaign with lots of casualties.
    const DESTRUCTION_FADE_MS = 2000; // wall-clock — flashes live on the viewer clock now
    for (const [id, f] of destructionFlashesRef.current) {
      if (nowMs - f.startMs >= DESTRUCTION_FADE_MS) {
        destructionFlashesRef.current.delete(id);
      }
    }
    // Growth pulses live 600ms (wall clock) — prune expired entries.
    for (const [id, startMs] of growthFlashStartRef.current) {
      if (nowMs - startMs >= 700) growthFlashStartRef.current.delete(id);
    }

    // Political regions for the far-zoom wash. Structure-derived, so it
    // costs a pass over the body list; skipped entirely once we're
    // zoomed past the overlay's fade-out.
    const regionFade = systemRegionOpacity(camera.scale);
    const systemRegions = regionFade > 0
      ? computeSystemRegions(gameState.bodies, gameState.factions)
      : [];

    const renderContext: RenderContext = {
      ctx,
      canvas: canvasRef.current,
      // camScale (not camera.scale) — the eased-camera tween renders the
      // interpolated scale; reading the raw target here would snap zoom
      // while position eased.
      camera: { x: camX, y: camY, scale: camScale, focusedBodyId: camera.focusedBodyId },
      // Selection reaches the orbit layer so drawOrbit can fade
      // rings unrelated to the selected body (falls back to the
      // camera focus when nothing is explicitly selected).
      selectedBodyId: uiState.selectedBodyId,
      t: gameState.currentTick,
      bodies: gameState.bodies,
      // Factions enable per-faction ship coloring (matches settlements).
      // Without this, drawShip falls back to cyan-for-player / red-otherwise,
      // which collapsed every AI rival into the same hue.
      factions: gameState.factions,
      simSpeed,
      damageFlashStart: damageFlashStartRef.current,
      growthFlashStart: growthFlashStartRef.current,
      nowMs,
      // Planet-visual extras: night-side city lights on settled worlds
      // + focus-zoom building structures read these. Optional in the
      // RenderContext so the lobby preview can skip them.
      settlements: gameState.settlements,
      buildOrders: gameState.buildOrders,
      // Hover-only ship labels — read fresh each frame from the ref the
      // mousemove hit-test writes.
      hoveredShipId: hoveredShipIdRef.current,
    };

    clearCanvas(renderContext);

    // Starfield backdrop — regenerate if canvas dimensions changed
    const canvasW = canvasRef.current.width;
    const canvasH = canvasRef.current.height;
    // Make starfield ~2x viewport so parallax has room to wrap
    const desiredW = canvasW * 2;
    const desiredH = canvasH * 2;
    if (
      !starfieldRef.current ||
      starfieldRef.current.width !== desiredW ||
      starfieldRef.current.height !== desiredH
    ) {
      starfieldRef.current = generateStarfield(desiredW, desiredH);
    }
    drawStarfield(starfieldRef.current, renderContext);

    // Political wash for the zoomed-out map — one shaded region per
    // planet system / belt, coloured by owner. Painted straight after
    // the starfield so it reads as background: orbits, bodies and
    // labels all sit crisply on top of the coloured ground.
    // Self-gating: no-ops above SYSTEM_REGION_HIDE_SCALE.
    if (layerOn('ownership')) {
      drawSystemRegions(systemRegions, renderContext);
    }

    // Belt dust — purely cosmetic specks between Mars and Jupiter so
    // the belt doesn't read as five lonely rocks at the same radius.
    drawAsteroidBeltDust(renderContext);

    // Draw orbits for all bodies. Lagrange-point markers (e.g. the
    // Centauri-system barycenter) are skipped — they live way outside
    // the normal scale band and their orbit ring would just be a giant
    // distracting circle through the Kuiper belt at max zoom-out.
    for (const body of gameState.bodies) {
      if (body.parent && body.type !== 'lagrange') {
        drawOrbit(body, renderContext, withOpacity(body.color, 0.35));
      }
    }

    // Draw SOI boundaries
    for (const body of gameState.bodies) {
      if (body.type === 'star') continue;
      // SOI boundary ring removed — player feedback: too many dashed
      // rings around every planet read as visual noise. Sensor fog
      // already implies the gravitational neighborhood.
      // drawSOIBoundary(body, renderContext);
    }

    // Draw target selection highlights
    if (uiState.targetSelectionMode) {
      for (const body of gameState.bodies) {
        // Sol is a valid target — the Dyson sphere ferry mechanic
        // already routes freighters there, and there's no reason a
        // player can't park a survey ship in close-solar orbit. The
        // earlier exclusion predated the engineering/Dyson flow.
        const isHovered = uiState.hoveredBodyId === body.id;
        drawTargetHighlight(body, renderContext, isHovered);
      }

      // Draw dashed line from selected ship to hovered body
      if (uiState.hoveredBodyId && uiState.selectedShipId) {
        const ship = gameState.ships.find(s => s.id === uiState.selectedShipId);
        const hovBody = gameState.bodies.find(b => b.id === uiState.hoveredBodyId);
        // Same priority chain shipWorldPosition uses: torch transit
        // first, parked orbit second. Returns null only if parent
        // body has gone missing — skip the hover line in that edge case.
        const shipWorldPos = ship ? shipWorldPosition(ship, gameState.currentTick, gameState.bodies) : null;
        if (ship && hovBody && shipWorldPos) {
          const bodyWorldPos = bodyPosition(hovBody, gameState.currentTick, gameState.bodies);
          const shipCanvas = worldToCanvas(shipWorldPos.x, shipWorldPos.y, renderContext);
          const bodyCanvas = worldToCanvas(bodyWorldPos.x, bodyWorldPos.y, renderContext);

          ctx.strokeStyle = withOpacity(COLORS.warning, 0.3);
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.moveTo(shipCanvas.x, shipCanvas.y);
          ctx.lineTo(bodyCanvas.x, bodyCanvas.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // === Fog of war ============================================
    // Recompute the player's visibility set each frame, carrying the
    // previous lastSeen map forward so ghosts age naturally.
    // alliedSet computed once near the top of this frame (shared sensor
    // coverage for fog, flash-gating, and yield reveal).
    const visibility = computeVisibility(
      'player',
      gameState.ships,
      gameState.settlements,
      gameState.bodies,
      gameState.currentTick,
      lastSeenRef.current,
      alliedSet,
    );
    lastSeenRef.current = visibility.lastSeen;
    const visibleShipIds = visibility.visibleShipIds;

    // Compute threats (hostile transits targeting player-owned bodies) —
    // but only include threats from ships the player can actually see.
    const allThreats = computeIncomingThreats(gameState, 'player');
    const threats = allThreats.filter(t => visibleShipIds.has(t.attackerShipId));
    const threatBodies = threatenedBodyIds(threats);

    // === Map layer overlays (toggled via LayersPanel) ===
    // Sensor coverage is now an always-on fog-of-war overlay drawn
    // LAST (below) — out-of-range areas dim, in-range areas read
    // normally, the boundary itself is the sensor edge. The old
    // explicit sensor-rings toggle was redundant once the fog made
    // the boundary visible everywhere; it's been removed.
    // All ship transfer arcs — faint, beneath bodies.
    if (layerOn('transfers')) {
      drawAllTransfersLayer(gameState.ships, renderContext, 'player', alliedSet);
    }
    // Incoming enemy trajectories — bright red glow for arcs ending at
    // a player body, dim warning hue for everything else. Honors fog
    // of war via visibleShipIds (only ships your sensors actually see).
    if (layerOn('enemyTrajectories')) {
      drawEnemyTrajectoriesLayer(
        gameState.ships,
        gameState.bodies,
        visibleShipIds,
        'player',
        alliedSet,
        renderContext,
      );
    }

    // Draw bodies. Destroyed asteroids (post-RAM impact) keep their
    // row in gameState.bodies for one tick to give consumers a chance
    // to observe destroyedAtTick, but they must not render — without
    // this filter the SP MapCanvas would snap them back to their
    // natural orbit and they'd visibly orbit forever even though
    // their impact already fired. (MP /state strips them at the
    // SQL layer so this only bit single-player.)
    for (const body of gameState.bodies) {
      if (body.destroyedAtTick != null) continue;
      const isSelected = uiState.selectedBodyId === body.id;
      const isHovered = uiState.hoveredBodyId === body.id;
      // A body's resource yields are intel — only reveal the readout
      // when the body is inside the player's (or an ally's) live sensor
      // coverage. Geometry/label still always render.
      const bodyPos = bodyPosition(body, gameState.currentTick, gameState.bodies);
      const yieldsVisible = wasInCoverage(bodyPos);
      drawBody(body, renderContext, isSelected, isHovered, yieldsVisible);
      // Asteroid-weapon overlay: flame trail + projected impact path
      // + pulsing crosshair on the target. drawBody already places
      // the body's icon at its ram-mode position via bodyPosition.
      if (body.ramPlan) {
        drawRammingBody(body, renderContext);
      }

      // Pulsing red threat ring around threatened bodies.
      if (threatBodies.has(body.id)) {
        const wp = bodyPosition(body, gameState.currentTick, gameState.bodies);
        const cp = worldToCanvas(wp.x, wp.y, renderContext);
        const baseR = Math.max(8, body.radius * camera.scale + 10);
        // Use real time, not tick, so the pulse is steady at any sim speed.
        const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 320);
        ctx.strokeStyle = withOpacity('#ff3030', 0.45 + 0.35 * pulse);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, baseR + 4 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        // "THREAT" label
        ctx.fillStyle = '#ff5e5e';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('⚠ THREAT', cp.x, cp.y - baseR - 6);
      }
    }

    // Build a co-orbit formation map: ships sharing the same parent body
    // and a similar orbital radius (bucketed) get fanned out perpendicular
    // to their velocity so the cluster reads as a formation instead of a
    // single overlapping dot. Only orbiting ships are bucketed — ships in
    // transit follow their torch trajectory and don't stack.
    const formationMap = new Map<string, { index: number; total: number }>();
    {
      const buckets = new Map<string, string[]>();
      for (const s of gameState.ships) {
        if (s.transit) continue;
        if (s.ownedBy !== 'player' && !visibleShipIds.has(s.id)) continue;
        // Bucket by parent + coarse orbital radius so two ships intended to
        // share an orbit cluster together even if their semi-major axes
        // differ by sub-unit rounding. Use (rp+ra)/2 as the SMA proxy.
        const sma = ((s.orbit.rp ?? 0) + (s.orbit.ra ?? 0)) / 2;
        const key = `${s.orbit.parentBodyId}|${Math.round(sma)}`;
        const list = buckets.get(key) || [];
        list.push(s.id);
        buckets.set(key, list);
      }
      for (const list of buckets.values()) {
        if (list.length < 2) continue;
        list.sort();  // stable order so a ship's lane doesn't jitter frame-to-frame
        list.forEach((sid, i) => {
          formationMap.set(sid, { index: i, total: list.length });
        });
      }
    }

    // Body ownership rings — drawn AFTER bodies so the halo sits around
    // the planet circle, BEFORE ships so the ring doesn't obscure ship
    // icons stacked at low altitude.
    if (layerOn('ownership')) {
      drawOwnershipLayer(gameState.bodies, renderContext);
    }

    // Per-body cluster accumulator. Active only at low zoom — see
    // CLUSTER_ZOOM_THRESHOLD. Counts PARKED (non-transit) ships per
    // body so we can render a single "N⌖" badge next to the body
    // instead of N overlapping triangles + labels.
    const clusterMode = camera.scale < CLUSTER_ZOOM_THRESHOLD;
    const bodyClusters = new Map<string, { mine: number; other: number }>();
    const bumpCluster = (bodyId: string, mine: boolean) => {
      const cur = bodyClusters.get(bodyId) ?? { mine: 0, other: 0 };
      if (mine) cur.mine += 1; else cur.other += 1;
      bodyClusters.set(bodyId, cur);
    };

    // Draw ships
    for (const ship of gameState.ships) {
      // Fog of war: skip enemy ships the player can't currently see
      if (ship.ownedBy !== 'player' && !visibleShipIds.has(ship.id)) continue;

      const isSelected = uiState.selectedShipId === ship.id;
      const formation = formationMap.get(ship.id);

      // Cluster collapse: at low zoom, skip the individual draw for
      // parked ships and accumulate a count under their parent body.
      // In-transit ships keep drawing — their trajectory arcs spread
      // them out so clustering at a body wouldn't be coherent — and
      // the selected ship stays visible so the player can find what
      // they picked.
      if (clusterMode && !ship.transit && !isSelected) {
        const bodyId = ship.orbit?.parentBodyId;
        if (bodyId) {
          bumpCluster(bodyId, ship.ownedBy === 'player');
          continue;
        }
      }

      if (ship.transit) {
        // Torch transit — preferred path post-migration. Selected ship
        // gets the split-phase coloring (green boost / pink brake) so
        // the player can see at a glance which half of the burn they're
        // in. Unselected uses the arcTransfer color for visual quiet.
        //
        // The samples returned from drawTorchTrajectory drive the ship's
        // drawn position via lerp — same polyline both the line and the
        // ship sit on, so the icon never floats off the visible curve.
        const plan = ship.transit.currentTransfer;
        // Trade-route legs render in cyan so the player can pick out
        // "this freighter is on a recurring run" vs "this is a
        // one-shot transfer I ordered" at a glance.
        //
        // Otherwise: color by relationship to the viewer (mine/
        // neutral/hostile) so every transit is classifiable without
        // selecting it. Was previously hard-coded to COLORS.arcTransfer
        // (amber) here, which silently overwrote drawAllTransfersLayer's
        // relationship paint with a uniform color — playtester saw
        // "trajectory colors only show up when you've selected a ship."
        const tradeLeg = gameState.tradeRoutes?.find(r => r.shipId === ship.id);
        const role = trajectoryRole(ship, 'player', alliedSet);
        const arcColor = tradeLeg
          ? COLORS.arcTradeRoute
          : TRAJECTORY_COLORS[role];
        ctx.save();
        // Selected ships get full opacity + the split-phase (green/
        // pink) coloring; unselected ones dim a bit so the system
        // isn't a wall of solid color. Hostile stays prominent;
        // neutral fades hardest because it's "you don't have to
        // care about this."
        ctx.globalAlpha = isSelected
          ? 1
          : role === 'mine'    ? 0.85
          : role === 'hostile' ? 0.85
          : 0.45;                                    // neutral
        // Pass currentTick so the segment behind the ship fades out
        // gradually — reduces visual noise from many in-flight ships.
        // Auto-disabled inside drawTorchTrajectory when splitPhaseColors
        // is on (selected ship: player wants the full green/pink arc).
        const samples = drawTorchTrajectory(
          plan, gameState.bodies, renderContext, arcColor,
          // Dashed when this leg belongs to a trade route — the
          // dash + green colour double-cue tells the player "this is
          // a recurring run" (vs a one-shot transfer, drawn solid in
          // the relationship colour). Useful for colourblind viewers
          // who can't lean on hue alone.
          !!tradeLeg,
          isSelected && !tradeLeg, gameState.currentTick,
        );
        ctx.restore();
        drawTransitShip(ship, renderContext, isSelected, samples);
        // Cache the canvas position the renderer just drew at, so the
        // click hit-test uses the SAME polyline-lerped point (not the
        // diverging ship.transit.pos integration). Matches the lerp
        // drawTorchTransitShip does internally. See transitShipCanvasPosRef.
        if (samples && samples.length > 0) {
          const lerped = torchPositionFromSamples(samples, gameState.currentTick);
          const cp = worldToCanvas(lerped.x, lerped.y, renderContext);
          transitShipCanvasPosRef.current.set(ship.id, cp);
        }

        const arrivalBody = gameState.bodies.find(b => b.id === plan.targetBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, plan.arriveTick, gameState.currentTick, renderContext);
        }

        // Queued chained legs — draw each as a faint dashed amber
        // preview so the player can see the full multi-leg plan at a
        // glance. The first queued leg starts at the current transit's
        // arrival; second leg starts at first's arrival; etc.
        if (ship.queuedTransits) {
          for (const queuedPlan of ship.queuedTransits) {
            drawTorchTrajectory(queuedPlan, gameState.bodies, renderContext, COLORS.fgDim, true);
            const qBody = gameState.bodies.find(b => b.id === queuedPlan.targetBodyId);
            if (qBody) drawGhostPlanet(qBody, queuedPlan.arriveTick, gameState.currentTick, renderContext);
          }
        }
      } else if (ship.plannedTransit) {
        // Ship parked but has a torch preview staged. Draw the parked
        // orbit + ship at its current location, plus a dashed amber
        // torch arc to the picked destination.
        drawOrbitEllipse(
          ship.orbit, renderContext,
          isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
          isSelected ? 2 : 1
        );
        drawShip(ship, renderContext, isSelected, formation);
        if (isSelected) drawApsisMarkers(ship, renderContext);

        const previewColor = COLORS.maneuverPlanned;
        drawTorchTrajectory(ship.plannedTransit, gameState.bodies, renderContext, previewColor, true);

        const arrivalBody = gameState.bodies.find(b => b.id === ship.plannedTransit!.targetBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.plannedTransit.arriveTick, gameState.currentTick, renderContext);
        }
      } else {
        drawOrbitEllipse(
          ship.orbit, renderContext,
          isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
          isSelected ? 2 : 1
        );
        drawShip(ship, renderContext, isSelected, formation);
        if (isSelected) drawApsisMarkers(ship, renderContext);
      }
    }

    // Cluster badges. One per body that had its parked ships collapsed
    // into the bodyClusters accumulator above. Position: a small offset
    // up-and-right of the body so it doesn't overlap the body label.
    // Colour: cyan for player-only, red for enemy-only, amber for mixed.
    // Format: just the total count + a tiny ship glyph. Players see the
    // density at a glance and click-to-zoom for detail.
    // ...but not once the region wash is fully in. At full-system zoom
    // the badges become the clutter (a scatter of "•2" pips over the
    // inner planets); the political shading is the read at that range.
    // They fade back in as the wash fades out.
    if (clusterMode && bodyClusters.size > 0 && regionFade < 1) {
      const c2d = ctx;
      c2d.save();
      c2d.globalAlpha = c2d.globalAlpha * (1 - regionFade);
      c2d.font = "700 11px var(--font-mono, ui-monospace, Menlo, Consolas, monospace)";
      c2d.textAlign = 'left';
      c2d.textBaseline = 'middle';
      for (const [bodyId, counts] of bodyClusters) {
        const body = gameState.bodies.find(b => b.id === bodyId);
        if (!body) continue;
        const bp = bodyPosition(body, gameState.currentTick, gameState.bodies);
        const cp = worldToCanvas(bp.x, bp.y, renderContext);
        const total = counts.mine + counts.other;
        if (total <= 0) continue;
        // Colour cue.
        let fill = '#4ecdc4';   // mine-only cyan
        let stroke = '#1a3a3a';
        if (counts.mine === 0)        { fill = '#ff5e5e'; stroke = '#3a1a1a'; }
        else if (counts.other > 0)    { fill = '#ffb84d'; stroke = '#3a2a10'; }
        // Pill placement: up-right of the body marker.
        const radius = Math.max(3, (body.radius ?? 4) * camera.scale);
        const pillX = cp.x + radius + 6;
        const pillY = cp.y - radius - 6;
        const label = `▸${total}`;
        const padX = 5;
        const textW = c2d.measureText(label).width;
        const pillW = textW + padX * 2;
        const pillH = 14;
        c2d.fillStyle = 'rgba(10, 14, 20, 0.92)';
        c2d.strokeStyle = stroke;
        c2d.lineWidth = 1;
        c2d.beginPath();
        // Rounded rect via roundRect (widely supported in Chromium/Firefox
        // since 2023). Falls back to a plain rect on older engines. Cast
        // through any so TS doesn't narrow the canvas type to never in
        // the fallback branch.
        const rr = 4;
        const anyCtx = c2d as any;
        if (typeof anyCtx.roundRect === 'function') {
          anyCtx.roundRect(pillX, pillY - pillH / 2, pillW, pillH, rr);
        } else {
          anyCtx.rect(pillX, pillY - pillH / 2, pillW, pillH);
        }
        c2d.fill();
        c2d.stroke();
        c2d.fillStyle = fill;
        c2d.fillText(label, pillX + padX, pillY + 0.5);
      }
      c2d.restore();
    }

    // Draw fog-of-war ghosts for enemies currently out of sensor range but
    // recently seen. Their lastSeen position fades over GHOST_LIFETIME_TICKS.
    for (const [shipId, intel] of visibility.lastSeen) {
      if (visibleShipIds.has(shipId)) continue;
      drawShipGhost(intel, gameState.currentTick, GHOST_LIFETIME_TICKS, gameState.factions, renderContext);
    }

    // Draw fleet bonds — faint lines connecting members of each fleet.
    // Skip invisible enemy ships so fleet structure doesn't leak through fog.
    for (const fleet of gameState.fleets) {
      if (fleet.shipIds.length < 2) continue;
      const positions: Array<{ x: number; y: number }> = [];
      for (const sid of fleet.shipIds) {
        const s = gameState.ships.find(sh => sh.id === sid);
        if (!s) continue;
        if (s.ownedBy !== 'player' && !visibleShipIds.has(s.id)) continue;
        const wp = shipWorldPosition(s, gameState.currentTick, gameState.bodies);
        if (wp) positions.push(wp);
      }
      if (positions.length < 2) continue;
      ctx.strokeStyle = withOpacity('#4ecdc4', 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      // Star pattern: connect each ship to the first (lead) ship
      const [lead, ...rest] = positions;
      const leadCanvas = worldToCanvas(lead.x, lead.y, renderContext);
      for (const p of rest) {
        const pc = worldToCanvas(p.x, p.y, renderContext);
        ctx.beginPath();
        ctx.moveTo(leadCanvas.x, leadCanvas.y);
        ctx.lineTo(pc.x, pc.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Draw settlements (cities on body surface, stations in orbit)
    for (const settlement of gameState.settlements) {
      const body = gameState.bodies.find(b => b.id === settlement.bodyId);
      if (!body) continue;
      drawSettlement(
        settlement,
        body,
        gameState.factions,
        renderContext,
        selectedSettlementId === settlement.id,
      );
    }

    // Destruction flashes — for ships/settlements that disappeared
    // recently. Drawn after the live entities so the explosion sits
    // on top of nothing (the entity is gone) and beneath the fog
    // overlay so a kill outside your sensor range still reads as
    // dimmed (you saw it die through your scopes, but the lights
    // are out now).
    if (destructionFlashesRef.current.size > 0) {
      const arr = Array.from(destructionFlashesRef.current.values());
      drawDestructionFlashes(arr, renderContext);
    }

    // Combat & event FX (combatFx): tracers, detonator blasts and
    // arrival rings. Drawn above ships/settlements so combat always
    // reads, but beneath the fog wash (consistent with destruction
    // flashes — a kill outside coverage still reads as dimmed).
    // Tracers/detonations are deliberately NOT LOD-gated: combat must
    // be visible at any zoom.
    // Pending FX: play queued chronicle effects once the player can
    // actually watch them — on screen AND zoomed in enough to read the
    // scene. Effects that happened while logged out, off-screen, or at
    // system zoom wait here instead of firing into the void. One per
    // stagger window, so a battle replays as a sequence of hits.
    drainVisibleFx(
      nowMs,
      (fx) => {
        if (renderContext.camera.scale < PENDING_FX_MIN_SCALE) return null;
        // Prefer the ship (most specific); a destroyed ship is gone, so
        // fall back to the body it died at — which is why the queue
        // carries both anchors.
        let world: { x: number; y: number } | null = null;
        if (fx.shipId) {
          const sh = gameState.ships.find(s => s.id === fx.shipId);
          if (sh) world = shipWorldPosition(sh, nowTick, gameState.bodies);
        }
        if (!world && fx.bodyId) {
          const b = gameState.bodies.find(x => x.id === fx.bodyId);
          if (b) world = bodyPosition(b, nowTick, gameState.bodies);
        }
        if (!world) return null;
        const cp = worldToCanvas(world.x, world.y, renderContext);
        // Must be comfortably inside the viewport — a blast half off the
        // edge isn't "watched", so keep waiting until it's framed.
        const m = 60;
        if (cp.x < m || cp.y < m || cp.x > width - m || cp.y > height - m) return null;
        return cp;
      },
      (fx, pos) => {
        if (fx.kind === 'detonation') {
          enqueueDetonation(fx.id, fx.bodyId ?? null, fx.shipId ?? null);
          return;
        }
        // destruction / impact both read as an explosion; impacts are
        // bigger because a whole rock hit the surface.
        const world = canvasToWorld(pos.x, pos.y, renderContext);
        destructionFlashesRef.current.set(fx.id, {
          pos: world,
          startMs: nowMs,
          baseRadius: fx.kind === 'impact' ? 22 : 12,
          id: fx.id,
        });
      },
    );

    drawTracers(renderContext, gameState.ships, nowMs, transitShipCanvasPosRef.current);
    // Sustained fire while an engagement is live. One-shot tracers alone
    // are unwatchable on real tick intervals (30s–1h per tick), so this
    // carries the firefight between volleys.
    drawEngagementFire(
      renderContext, gameState.ships, nowMs, nowTick, transitShipCanvasPosRef.current,
    );
    drawDetonations(renderContext, nowMs);
    drawArrivalFlashes(renderContext, gameState.ships, nowMs);

    // Fog-of-war: paint the dim wash and punch holes where the
    // player's sensors reach. The dim↔bright transition is its own
    // boundary — no separate outline pass needed.
    {
      const rings = factionSensorRings(
        'player',
        gameState.ships,
        gameState.settlements,
        gameState.bodies,
        gameState.currentTick,
        alliedSet,
      );
      // Fade the fog out as the political wash fades in. The fog is a
      // 62%-opaque dark fill over everything outside sensor range, and
      // at full-system zoom that's nearly the entire map — it was
      // crushing the wash underneath it to about a third of its
      // intended colour, which is why the layer read as missing.
      //
      // Dropping it at that range costs little: its main subject is
      // enemy ships, which the LOD already hides out here, and the
      // wash itself becomes the "what do I know" layer. The wash stays
      // UNDER bodies (drawn far earlier) so planets and labels keep
      // sitting crisply on top of coloured ground.
      drawFogOfWarOverlay(rings, renderContext, 1 - regionFade);
    }

    drawHUD(renderContext, uiState.targetSelectionMode);

    // Camera tween in flight → self-drive one more frame. The normal
    // render cadence is state-change-driven; a paused sim would freeze
    // the easing mid-flight without this. renderRef always points at
    // the latest render closure; the id guard stops frame stacking.
    if (camTweenRef.current && tweenRafRef.current == null) {
      tweenRafRef.current = requestAnimationFrame(() => {
        tweenRafRef.current = null;
        renderRef.current();
      });
    }
    // enabledLayers (Set) is the actual signal for "redraw when a layer
    // toggles" — listing layerOn is redundant (it closes over the same
    // set). The lint rule can't see through that closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, camera, uiState, simSpeed, selectedSettlementId, enabledLayers]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      if (panState) {
        const deltaX = e.clientX - panState.startX;
        const deltaY = e.clientY - panState.startY;
        const newCamX = panState.camX - deltaX / camera.scale;
        const newCamY = panState.camY - deltaY / camera.scale;
        directUpdateCamera({ x: newCamX, y: newCamY });
      }
    },
    [panState, camera.scale, directUpdateCamera]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 2) {
      if (uiState.targetSelectionMode) {
        setTargetSelectionMode(false);
        return;
      }
      // Seed the pan from the *effective* camera position (the world point
      // currently under the crosshair). If a focused body is sticky from
      // an earlier focusBody / initialFocus, camera.x/.y still holds the
      // pre-focus origin (0,0) and the user would see the camera jump back
      // to origin on the first mouse move. Snapshot the focused-body world
      // pos instead, then clear focusedBodyId so the render stops snapping.
      let startCamX = camera.x;
      let startCamY = camera.y;
      if (camera.focusedBodyId) {
        const focused = gameState.bodies.find(b => b.id === camera.focusedBodyId);
        if (focused) {
          const { bodyPosition } = require('../physics/orbitalMechanics');
          const pos = bodyPosition(focused, gameState.currentTick, gameState.bodies);
          startCamX = pos.x;
          startCamY = pos.y;
        }
        directUpdateCamera({ x: startCamX, y: startCamY, focusedBodyId: undefined });
      }
      setPanState({ startX: e.clientX, startY: e.clientY, camX: startCamX, camY: startCamY });
    }
  }, [camera, gameState.bodies, gameState.currentTick, uiState.targetSelectionMode, setTargetSelectionMode, directUpdateCamera]);

  const handleMouseUp = useCallback(() => {
    setPanState(null);
  }, []);

  // React attaches wheel listeners as passive by default since v17, which
  // makes preventDefault() a no-op and floods the console. Attach a native
  // non-passive listener instead so the page doesn't scroll while zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldBeforeX = camera.x + (mouseX - canvas.width / 2) / camera.scale;
      const worldBeforeY = camera.y + (mouseY - canvas.height / 2) / camera.scale;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      // MIN_SCALE evolution:
      //   0.005  — original; Sol-system-only era
      //   0.002  — Centauri at 60K landed
      //   0.0012 — Centauri pushed to 265K AND Cygnus X added at 340K
      //            on the opposite side of Sol. Both need to be
      //            reachable at full zoom-out. On a 1000px canvas
      //            centered at Sol, scale=0.0012 gives ±417K visible
      //            range — Centauri at +265 and Cygnus at -340 both
      //            sit comfortably inside, with Cygnus juuust off the
      //            visible band at the default zoom (good — players
      //            should discover it by pulling out).
      // Touch hook (useCanvasTouchInput) needs to match this clamp.
      const newScale = Math.max(0.0012, Math.min(50, camera.scale * factor));
      const newCamX = worldBeforeX - (mouseX - canvas.width / 2) / newScale;
      const newCamY = worldBeforeY - (mouseY - canvas.height / 2) / newScale;
      directUpdateCamera({ x: newCamX, y: newCamY, scale: newScale });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [camera.x, camera.y, camera.scale, directUpdateCamera]);

  // Arrow keys / WASD pan the camera at a constant on-screen speed
  // (independent of zoom). Held keys produce smooth motion via rAF;
  // multiple keys combine on diagonals. Skipped when the user is
  // typing in a text field or when a modifier is held (so browser
  // shortcuts still work).
  useEffect(() => {
    const heldKeys = new Set<string>();
    let rafId: number | null = null;
    let lastTime: number | null = null;

    const PAN_PIXELS_PER_SEC = 600;

    const isTextField = (el: EventTarget | null): boolean => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    };

    const tick = (now: number) => {
      if (heldKeys.size === 0) { rafId = null; lastTime = null; return; }
      const dt = lastTime == null ? 0 : (now - lastTime) / 1000;
      lastTime = now;

      let dx = 0, dy = 0;
      if (heldKeys.has('w') || heldKeys.has('arrowup'))    dy -= 1;
      if (heldKeys.has('s') || heldKeys.has('arrowdown'))  dy += 1;
      if (heldKeys.has('a') || heldKeys.has('arrowleft'))  dx -= 1;
      if (heldKeys.has('d') || heldKeys.has('arrowright')) dx += 1;

      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        dx /= len; dy /= len;
        // Convert "on-screen pixels per second" to world-space pan
        // by dividing by current scale so the pan feels constant
        // regardless of zoom level.
        const worldStep = (PAN_PIXELS_PER_SEC * dt) / camera.scale;
        // Read previous camera fresh from updateCamera's closure each
        // frame so we keep momentum even as state batches.
        directUpdateCamera({
          x: camera.x + dx * worldStep,
          y: camera.y + dy * worldStep,
          focusedBodyId: undefined,
        });
      }
      rafId = requestAnimationFrame(tick);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextField(e.target)) return;
      const k = e.key.toLowerCase();
      if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return;
      e.preventDefault();
      if (heldKeys.has(k)) return;
      heldKeys.add(k);
      if (rafId == null) rafId = requestAnimationFrame(tick);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      heldKeys.delete(k);
    };

    const onBlur = () => { heldKeys.clear(); };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [camera.x, camera.y, camera.scale, directUpdateCamera]);

  // Shared tap/click logic — called by both the mouse onClick handler and
  // the touch-input layer. Hit radii are padded on coarse-pointer devices
  // (mobile/tablet) so fingers can reliably grab ships and bodies.
  const handleTapAt = useCallback(
    (canvasX: number, canvasY: number) => {
      if (!canvasRef.current) return;

      if (uiState.targetSelectionMode) {
        for (const body of gameState.bodies) {
          // Sol is a valid target — see the matching note in the
          // target-highlight render loop above. Removing both gates
          // unblocks pick-via-map for Sol (the panel-driven Dyson
          // transfer already worked via a different code path).
          const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
          const clickRadius = Math.max(12, body.radius! * camera.scale + 8) + TOUCH_HIT_PADDING;
          if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
            window.dispatchEvent(new CustomEvent('orbital-transfer-confirm', {
              detail: { bodyId: body.id },
            }));
            return;
          }
        }
        return;
      }

      for (const ship of gameState.ships) {
        // Prefer the cached canvas position the renderer just used for
        // in-transit ships (matches the lerp drawTorchTransitShip does,
        // which can disagree with ship.transit.pos mid-segment by enough
        // pixels to make clicks miss the visible icon). Falls back to
        // getShipCanvasPos for parked ships and the rare case where the
        // ship is in transit but the render-loop pass for it hasn't run
        // yet (first frame after mount, fog-hidden, etc.).
        const cached = ship.transit ? transitShipCanvasPosRef.current.get(ship.id) : undefined;
        const shipPos = cached ?? getShipCanvasPos(ship, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        // Wider hit radius for in-transit ships — they're moving, so the
        // player aims slightly behind where they end up by the time the
        // click event fires. 14px for parked, 20px for transit. Touch
        // padding stacks on top for coarse-pointer devices.
        const hitRadius = (ship.transit ? 20 : 14) + TOUCH_HIT_PADDING;
        if (Math.hypot(canvasX - shipPos.x, canvasY - shipPos.y) < hitRadius) {
          selectShip(ship.id);
          return;
        }
      }

      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const clickRadius = Math.max(8, body.radius! * camera.scale + 5) + TOUCH_HIT_PADDING;
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
          selectBody(body.id);
          return;
        }
      }

      deselectShip();
      deselectBody();
    },
    [gameState, camera, uiState.targetSelectionMode, selectShip, selectBody, deselectShip, deselectBody]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      handleTapAt(e.clientX - rect.left, e.clientY - rect.top);
    },
    [handleTapAt]
  );

  const handleMouseHover = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Ship hover drives the name label. Same geometry the click
      // hit-test uses (cached transit pos, 20px in-transit / 14px
      // parked) so a label appears exactly where a click would land —
      // no touch padding: a mouse is precise, and padding here would
      // pop labels for ships the cursor isn't really over. Ships take
      // priority over bodies, matching the click order.
      let hoveredShipId: string | null = null;
      for (const ship of gameState.ships) {
        const cached = ship.transit ? transitShipCanvasPosRef.current.get(ship.id) : undefined;
        const shipPos = cached ?? getShipCanvasPos(ship, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        if (Math.hypot(canvasX - shipPos.x, canvasY - shipPos.y) < (ship.transit ? 20 : 14)) {
          hoveredShipId = ship.id;
          break;
        }
      }
      hoveredShipIdRef.current = hoveredShipId;

      let hoveredBodyId: string | null = null;
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const hoverRadius = Math.max(8, body.radius! * camera.scale + 5);
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < hoverRadius) {
          hoveredBodyId = body.id;
          break;
        }
      }
      hoverBody(hoveredBodyId);
    },
    [gameState, camera, hoverBody]
  );

  // Shared focus-on-tap logic — called by both onDoubleClick and the
  // touch input layer's double-tap.
  const handleFocusAt = useCallback(
    (canvasX: number, canvasY: number) => {
      if (uiState.targetSelectionMode) return;
      if (!canvasRef.current) return;
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const clickRadius = Math.max(8, body.radius! * camera.scale + 5) + TOUCH_HIT_PADDING;
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
          focusBody(body.id);
          return;
        }
      }
      focusBody(undefined);
    },
    [gameState, camera, focusBody, uiState.targetSelectionMode]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      handleFocusAt(e.clientX - rect.left, e.clientY - rect.top);
    },
    [handleFocusAt]
  );

  // Touch gesture layer: single-finger pan, two-finger pinch zoom,
  // tap-to-select, double-tap-to-focus. Mouse events above are untouched.
  useCanvasTouchInput({
    canvasRef,
    camera,
    // Touch pan/pinch is direct manipulation — route through the
    // direct wrapper so it snaps and kills any in-flight camera tween.
    updateCamera: directUpdateCamera,
    onTap: handleTapAt,
    onDoubleTap: handleFocusAt,
    // Touch pan + sticky focused body: when the player pans with their
    // capital still focused, the stored camera.x/y is the pre-focus
    // origin (0, 0) — the Sun. Without this snapshot, dropping focus
    // mid-pan yanked the camera to world (0, 0). Mirror the desktop
    // mousedown's snapshot-before-release behaviour by reading the
    // focused body's CURRENT world position and starting the pan from
    // there. The hook caches the callback in a ref so the consumer's
    // identity doesn't churn the effect — safe to redeclare each render.
    getReleaseFocusPos: () => {
      if (!camera.focusedBodyId) return null;
      const focused = gameState.bodies.find(b => b.id === camera.focusedBodyId);
      if (!focused) return null;
      return bodyPosition(focused, gameState.currentTick, gameState.bodies);
    },
  });

  // Keep renderRef pointed at the freshest render closure so the camera
  // tween's self-driven frames never call a stale one.
  useEffect(() => { renderRef.current = render; }, [render]);

  // Unmount-only: kill any pending tween continuation frame.
  useEffect(() => () => {
    if (tweenRafRef.current != null) cancelAnimationFrame(tweenRafRef.current);
  }, []);

  // Continuous render loop. The map used to redraw only when the render
  // closure's deps changed — once per sim tick / state poll (~1/sec in
  // MP), plus tween/key frames. That was fine when nothing animated on
  // wall-clock time, but the graphics pass added continuously-animated
  // FX (engagement bolts, beacon pulses, dash crawl, twinkle) which
  // advanced in 1fps chunks — reported as "bolts are very slow / frame
  // rate problem." A persistent rAF loop renders every display frame;
  // rAF self-suspends while the tab is hidden, so background cost is
  // zero. renderRef always points at the freshest closure.
  useEffect(() => {
    let raf: number | null = null;
    const loop = () => {
      renderRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf != null) cancelAnimationFrame(raf); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onMouseMove={(e) => { handleMouseMove(e); handleMouseHover(e); }}
      onMouseLeave={() => {
        // Cursor left the canvas — no mousemove will fire to clear these,
        // so a hovered label/body would stay lit indefinitely.
        hoveredShipIdRef.current = null;
        hoverBody(null);
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => e.preventDefault()}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className="map-canvas"
      style={{
        cursor: uiState.targetSelectionMode ? 'crosshair' : undefined,
        // Block native page scroll/zoom on touch so our gesture layer owns
        // the canvas entirely.
        touchAction: 'none',
      }}
    />
  );
};

/**
 * The "effective" camera center. When the camera is locked onto a body
 * via camera.focusedBodyId, the render loop overrides camera.x/.y with
 * that body's current world position so the body stays under the
 * crosshair. Hit-tests need to do the same math or canvas positions
 * computed from the raw camera will diverge from what the user sees —
 * which is how a click anywhere ended up landing on Sol (which sits at
 * world 0,0, matching camera.x/.y when the camera state hadn't been
 * panned away from origin).
 */
function effectiveCamera(camera: any, bodies: any[], t: number): { x: number; y: number; scale: number } {
  if (camera.focusedBodyId) {
    const focused = bodies.find((b: any) => b.id === camera.focusedBodyId);
    if (focused) {
      const { bodyPosition } = require('../physics/orbitalMechanics');
      const pos = bodyPosition(focused, t, bodies);
      return { x: pos.x, y: pos.y, scale: camera.scale };
    }
  }
  return { x: camera.x, y: camera.y, scale: camera.scale };
}

function getBodyCanvasPos(
  body: any, canvas: HTMLCanvasElement, bodies: any[], camera: any, t: number
): { x: number; y: number } {
  const { bodyPosition } = require('../physics/orbitalMechanics');
  const pos = bodyPosition(body, t, bodies);
  const cam = effectiveCamera(camera, bodies, t);
  return {
    x: canvas.width / 2 + (pos.x - cam.x) * cam.scale,
    y: canvas.height / 2 + (pos.y - cam.y) * cam.scale,
  };
}

function getShipCanvasPos(
  ship: any, canvas: HTMLCanvasElement, bodies: any[], camera: any, t: number
): { x: number; y: number } {
  let pos;
  if (ship.transit) {
    pos = { x: ship.transit.pos.x, y: ship.transit.pos.y };
  } else {
    const { orbitWorldPos } = require('../physics/orbitalMechanics');
    pos = orbitWorldPos(ship.orbit, t, bodies);
  }
  const cam = effectiveCamera(camera, bodies, t);
  return {
    x: canvas.width / 2 + (pos.x - cam.x) * cam.scale,
    y: canvas.height / 2 + (pos.y - cam.y) * cam.scale,
  };
}

function drawHUD(ctx: RenderContext, targetSelectionMode?: boolean) {
  const speedLabel = ctx.simSpeed && ctx.simSpeed > 0 ? `${ctx.simSpeed}×` : 'PAUSED';
  ctx.ctx.fillStyle = COLORS.fgDim;
  ctx.ctx.font = '12px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';
  ctx.ctx.fillText(`Tick: ${ctx.t.toFixed(1)} | ${speedLabel}`, 16, 16);
  ctx.ctx.fillText(`Scale: ${ctx.camera.scale.toFixed(2)}x`, 16, 32);

  ctx.ctx.fillStyle = COLORS.fgFaint;
  ctx.ctx.font = '10px monospace';
  // Hint changes by input modality — desktop hotkeys are wrong on a
  // touch device, so don't tell a phone player to "right-drag."
  const hint = isCoarsePointer()
    ? 'Drag: pan · Pinch: zoom · Tap: select · Double-tap: focus'
    : 'Right-drag: pan | Scroll: zoom | Click: select | Double-click: focus';
  ctx.ctx.fillText(hint, 16, ctx.canvas.height - 32);

  if (targetSelectionMode) {
    ctx.ctx.fillStyle = COLORS.warning;
    ctx.ctx.font = 'bold 12px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.fillText('SELECT TARGET BODY', ctx.canvas.width / 2, 16);
    ctx.ctx.fillStyle = COLORS.fgDim;
    ctx.ctx.font = '10px monospace';
    ctx.ctx.fillText('Click a body to transfer | ESC to cancel | Right-click to cancel', ctx.canvas.width / 2, 32);
  }

  if (ctx.camera.focusedBodyId) {
    const focusedBody = ctx.bodies.find(b => b.id === ctx.camera.focusedBodyId);
    if (focusedBody) {
      ctx.ctx.fillStyle = COLORS.info;
      ctx.ctx.font = 'bold 12px monospace';
      ctx.ctx.textAlign = 'center';
      ctx.ctx.fillText(`FOCUSED: ${focusedBody.name.toUpperCase()}`, ctx.canvas.width / 2, targetSelectionMode ? 52 : 32);
      ctx.ctx.fillStyle = COLORS.fgDim;
      ctx.ctx.font = '10px monospace';
      ctx.ctx.fillText(`SOI: ${focusedBody.soi.toFixed(0)} km`, ctx.canvas.width / 2, targetSelectionMode ? 68 : 48);
    }
  }

  ctx.ctx.textAlign = 'right';
  ctx.ctx.fillText(`v0.3 · ${GIT_SHA.slice(0,7)}`, ctx.canvas.width - 16, ctx.canvas.height - 16);
}
