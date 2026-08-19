import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { routeForShip } from '../game/routeSelectors';
import {
  subscribeRoutePick, isRoutePicking,
  takeRouteFit, fitToPoints, offerPickCluster,
} from '../game/routePick/store';
import { perf } from '../multiplayer/PerfHud';
import { requestLabel, flushLabels, reserveBox, resetReservations } from '../render/labelLayer';
import { smoothedTick, shipDisplayTick } from '../render/tickPhase';
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
  drawRendezvousPreview,
  rendezvousTrajectorySamples,
  drawTransitShip,
  drawGhostPlanet,
  drawTargetHighlight,
  drawSettlement,
  drawShipGhost,
  drawAllTransfersLayer,
  drawEnemyTrajectoriesLayer,
  drawOwnershipLayer,
  drawSystemRegions,
  systemRegionOpacityFor,
  systemSpans,
  MOON_ORBIT_MIN_PARENT_PX,
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
  bodyLabelAlwaysOn,
  planBodyLabels,
  BODY_LABEL_ROW_HEIGHT,
  ShipFormation,
  shipLane,
  shipLaneOnly,
  drawnShipWorldPos,
  drawnShipWorldPositions,
  isRevealedWarpGate,
  torchTrajectorySamples,
  computeTransitLanes,
  drawTransitRangeRing,
  drawInterceptMarkersLayer,
} from '../render/mapRenderer';
import { computeSystemRegions } from '../render/systemRegions';
import { getEmblemImage } from '../render/emblemCache';
import { BUILDING_DEFS, buildingLevel } from '../game/settlements';
import { releaseFocusPosition } from '../game/cameraFocus';
import { Body as GameBody, BuildingKind, Ship } from '../types';
import {
  spawnTracer,
  drawTracers,
  drawEngagementFire,
  spawnWreck,
  drawWrecks,
  drawBattleDamageStates,
  drawDetonations,
  spawnArrivalFlash,
  drawArrivalFlashes,
  enqueueDetonation,
  spawnDiscoveryBloom,
  discoveryVariantForSecret,
  drawDiscoveryBlooms,
  diedByChronicle,
} from '../render/combatFx';
import { drainVisibleFx } from '../render/pendingFx';
import { bodyPosition } from '../physics/orbitalMechanics';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import type { InterceptMarker } from '../render/mapRenderer';
import { shipIconSize } from '../render/mapRenderer';
import { forecastIntercepts, reachOf } from '../game/firingWindows';
import { COLORS, withOpacity, lighten } from '../render/colors';
import { deriveSecondary } from '../game/colorUtils';
import { shipWorldPosition } from '../game/combat';
import { makePeaceCheck } from '../game/peace';
import { getShipClass } from '../game/shipClasses';
import { computeIncomingThreats, threatenedBodyIds } from '../game/threats';
import { computeVisibility, payloadVisibility, factionSensorRings, GHOST_LIFETIME_TICKS } from '../game/visibility';
// World menu (MULTIPLAYER ONLY): every use below is gated on
// isWorldMenuActive(), which only the MP-mounted overlay ever sets —
// these imports add zero reachable code paths to single-player.
import { isWorldMenuActive, setWorldMenuMaxScale, getWorldMenuMaxScale, getWorldMenuOpenBodyId } from '../game/worldMenu/store';
import { isLightweight, LIGHTWEIGHT_MIN_FRAME_MS, FROZEN_ANIM_MS } from '../render/lightweightMode';
import { menuScaleFor, zOf, furnitureOpacity } from '../game/worldMenu/camera';
import { drawWorldMenuCloseup } from '../render/worldMenuCloseup';
import { useCanvasTouchInput } from '../hooks/useCanvasTouchInput';
import { isCoarsePointer } from '../hooks/useIsMobile';
import { GIT_SHA } from '../_version';
import { exploredStorageKey, loadExplored, saveExplored } from '../game/exploredBodies';
import './MapCanvas.css';

/** Extra hit-radius padding when the primary input is touch. Apple/Material
 *  guidelines recommend ~44px tap targets; we widen the click radius rather
 *  than enlarge the rendered icon. */
const TOUCH_HIT_PADDING = isCoarsePointer() ? 16 : 0;
/** Pointer travel (CSS px) before a left-drag counts as a selection box
 *  rather than a click. Keeps a slightly-shaky click from turning into a
 *  one-pixel box that silently wipes the current group. */
const BOX_DRAG_THRESHOLD_PX = 5;

/**
 * Below this camera scale, parked ships at a body collapse into a single
 * "N ships" cluster badge rendered next to the body. Reduces the visual
 * noise when zoomed out far enough that ship sprites + labels pile on top
 * of each other (playtester report: solar-system view = unreadable smear
 * of overlapping triangles).
 *
 * Measured in SPANS (screen-heights of the whole star system), not raw
 * camera.scale — SYSTEM_SCALE=2 doubled heliocentric orbits for NEW
 * games while games in progress kept their original size, so no single
 * camera.scale number is correct for both. Spans is invariant.
 *
 * ~12 spans means you're well inside a planet's moon system — the zoom
 * where a fleet is something you manoeuvre rather than a dot you count.
 * Zoomed out past that, the cluster badge carries the same information
 * in one glyph.
 *
 * The selected ship and any in-transit ship always render in full so the
 * player can still track them across the zoomed-out view; only the
 * stationary at-body clusters collapse.
 */
// Ship sprites are LOCAL now, per system: hulls render individually only
// once their system's moon-orbit rings are on screen (anchor planet ≥
// MOON_ORBIT_MIN_PARENT_PX px — the same rule drawOrbit uses). Below
// that, every world shows an owner-coloured count badge instead, all the
// way out until the whole system smears into one SYSTEM badge. A body
// with no moons runs the identical px rule on its own radius — one
// number down to the same scale. This kills the "sprites piled on a
// tight moon system" blur: numbers until the system has visually opened.
/** Crossfade width (px of anchor radius) above the ring threshold —
 *  badges dissolve into hulls across this band. */
const SPRITE_FADE_PX = 5;
/** Anchor px at which hulls reach full size (ramp from the threshold). */
const SPRITE_FULL_PX = 34;
const ORBIT_SHIP_MIN_SCALE = 0.5;

// --- In-transit hull size vs zoom -------------------------------------
// Parked hulls shrink via spriteSizeFor, which keys off their parent
// body's on-screen radius. A ship between worlds has no such anchor, so
// it drew at FULL size at every zoom — a wall of same-size sprites once
// you pulled back to see the whole system. These drive a straight
// camera-zoom ramp instead.
/** Floor: how small an in-transit hull gets at max zoom-out. Half. */
const TRANSIT_SHIP_MIN_SIZE = 0.5;
/** Camera scale at/above which transit hulls draw full size. This is the
 *  default view scale (gameContext DEFAULT_CAMERA_SCALE), so zooming IN
 *  never shrinks anything and zooming out starts the ramp immediately. */
const TRANSIT_FULL_CAM_SCALE = 0.5;
/** The wheel handler's hard zoom-out clamp — the ramp bottoms out here
 *  so "fully zoomed out" and "half size" line up exactly. Keep in sync
 *  with the Math.max floor in the wheel handler below. */
const TRANSIT_MIN_CAM_SCALE = 0.0012;

/** Size multiplier for an in-transit hull at the given camera scale.
 *  Interpolated in LOG space because zoom is multiplicative — a linear
 *  ramp across a ~400x range would spend almost its entire travel in the
 *  last sliver of zoom and read as an abrupt pop. */
function transitShipScale(camScale: number): number {
  const s = Math.max(TRANSIT_MIN_CAM_SCALE, camScale);
  const t = Math.max(0, Math.min(1,
    Math.log(s / TRANSIT_MIN_CAM_SCALE)
      / Math.log(TRANSIT_FULL_CAM_SCALE / TRANSIT_MIN_CAM_SCALE)));
  return TRANSIT_SHIP_MIN_SIZE + (1 - TRANSIT_SHIP_MIN_SIZE) * t;
}
/** A star-orbiter whose whole moon system spans fewer than this many
 *  screen pixels collapses its bodies' ship badges into a single
 *  SYSTEM-level count (its moons would overlap into an unreadable smear
 *  at that zoom). Above it, badges are per-body. */
const SYSTEM_BADGE_MAX_PX = 48;

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


/** Drawn radius of a body in canvas px, accounting for the warp-gate
 *  sprite that replaces a revealed gate's disc (mapRenderer
 *  drawWarpGateBody). Used for hit-testing so the click target and the
 *  visible art agree. */
function gateAwareRadius(body: GameBody, scale: number): number {
  const r = body.radius! * scale;
  return isRevealedWarpGate(body)
    ? Math.max(10, Math.min(Math.max(3, r) * 1.6, 48))
    : r;
}

export const MapCanvas: React.FC<MapCanvasProps> = ({
  width = typeof window !== 'undefined' ? window.innerWidth : 1280,
  height = typeof window !== 'undefined' ? window.innerHeight : 800,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // DYNAMIC RESOLUTION (telemetry-driven): two playtesters render the
  // canvas WITHOUT GPU acceleration (ANGLE reports Microsoft Basic
  // Render Driver for one; Firefox software-canvas for the other) - for
  // them every pixel is CPU-rasterized and frame cost scales with AREA.
  // When sustained fps drops, shrink the canvas BACKING store while CSS
  // size stays fixed: the browser upscales, slightly soft, but 0.65x
  // scale = 42% of the pixels. Hardware-accelerated clients never
  // trip the down-step. Mouse input converts via renderScaleRef.
  const renderScaleRef = useRef(1);
  const {
    gameState, camera, uiState, simSpeed,
    updateCamera, selectShip, selectBody, deselectShip, deselectBody,
    hoverBody, focusBody,
    setTargetSelectionMode,
    toggleShipSelection, setShipSelection, clearShipSelection,
    selectedSettlementId,
  } = useGameContext();
  /**
   * The tick to DRAW at: the last resolved tick plus however far into the
   * current tick we are (see render/tickPhase). Called fresh per frame by
   * the rAF loop, so bodies and ships glide instead of teleporting once
   * per tick — and land exactly on their next-tick position at the
   * instant the server tick fires.
   *
   * Hit-testing calls this too. If clicks used the raw tick while the
   * canvas drew a smoothed one, every planet's hitbox would sit up to a
   * full tick of travel away from the planet you can see.
   *
   * Deliberately NOT memoized on a value: it must re-read the clock on
   * every call, mid-tick, or it would just be the old quantized tick
   * wearing a different name.
   */
  const renderTick = useCallback(
    () => smoothedTick(
      gameState.currentTick,
      gameState.nextTickAt,
      gameState.tickIntervalMs,
      Date.now(),
    ),
    [gameState.currentTick, gameState.nextTickAt, gameState.tickIntervalMs],
  );

  /**
   * Where a hull is actually ON SCREEN — not where its orbit says it is.
   *
   * A parked ship is NOT drawn at shipWorldPosition(). drawShip adds
   * three things on top: the cosmetic spin (a full lap every 180s, so
   * hulls visibly circle instead of creeping a pixel a minute), the
   * formation phase offset that fans a co-orbiting fleet around the
   * ring, and the radial lane. Together those move a hull by up to twice
   * its park radius from the raw orbital point — hundreds of pixels at
   * moon zoom.
   *
   * Anything DRAWING A LINE TO A SHIP has to use this. Three overlays
   * were using the raw position and so anchored to empty space, with the
   * gap opening and closing as the spin carried the hull around: the
   * fleet bonds, the selected-ship hover line, and the FX fallback.
   *
   * Falls back to the raw orbit for a hull that has not been drawn yet
   * (first frame, or one culled off-screen), which is the best guess
   * available and never null-propagates a missing line.
   */
  const drawnPosOf = useCallback(
    (s: Ship) => drawnShipWorldPos(s.id) ?? shipWorldPosition(s, renderTick(), gameState.bodies),
    [renderTick, gameState.bodies],
  );

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
  /** Intercept markers, recomputed once per TICK rather than per frame —
   *  every trajectory feeding them is a committed burn, so nothing in the
   *  answer changes between frames. */
  const interceptCacheRef = useRef<{ tick: number; markers: InterceptMarker[] }>(
    { tick: -1, markers: [] },
  );

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
  // Per-module "just built" pop (§ station art), same shape as the
  // growth pulse above but keyed `${settlementId}:${buildingKind}` and
  // fired on a LEVEL increase (0→1 counts — first construction is a
  // level-up too) rather than population. Tracks every BuildingKind
  // generically via BUILDING_DEFS rather than hardcoding the
  // station-only subset the renderer currently draws, so city art
  // picking this up later needs no changes here.
  const prevBuildingLevelsRef = useRef<Map<string, number>>(new Map());
  const buildFlashStartRef = useRef<Map<string, number>>(new Map());
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

  // ============================================================
  // hitCam — THE camera every hit-test must use.
  //
  // Aiming was broken because the map was DRAWN with one camera and
  // HIT-TESTED with another. Two separate derivations of "where is the
  // camera really", and they disagreed in three ways:
  //
  //   1. WORLD-MENU OFFSET. While the world menu is up, the render path
  //      treats camera.x/y as an OFFSET from the focused body so the
  //      body can be parked below the frame (`camX = pos.x + camera.x`,
  //      upper-limb framing). effectiveCamera() returned a bare
  //      `pos.x` and dropped the offset, so every hit box sat
  //      (camera.x, camera.y) × scale away from the sprite it belonged
  //      to. That is the "hovering the planet does nothing but some
  //      other patch of screen highlights it" report.
  //   2. POSITION EASING. focusBody tweens camX/camY over 250ms;
  //      effectiveCamera jumped straight to the target, so hit boxes
  //      led the visible bodies for the whole tween.
  //   3. SCALE EASING. The renderer draws at the eased camScale;
  //      effectiveCamera used the raw camera.scale, so mid-zoom every
  //      radius was computed against the wrong pixels-per-unit.
  //
  // lastRenderedCamRef is already exactly "the effective camera drawn
  // last frame", so hit-testing against it is correct by construction
  // and cannot drift again — there is now ONE derivation, not two.
  // Returned WITHOUT focusedBodyId on purpose: it is already resolved,
  // and effectiveCamera must pass it through rather than re-resolve it.
  //
  // Fallback is only for the very first frame (nothing rendered yet).
  // ============================================================
  const hitCam = useCallback((): { x: number; y: number; scale: number } => (
    lastRenderedCamRef.current
    ?? effectiveCamera(camera, gameState.bodies, renderTick())
  ), [camera, gameState.bodies, renderTick]);
  const directCamInputRef = useRef(false);
  const tweenRafRef = useRef<number | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const prevShipIdsRef = useRef<Map<string, { x: number; y: number; cls: string }>>(new Map());
  // Ids of ships that were in torch transit last frame. Diffed against
  // this frame the same way hp deltas are — a ship present both frames
  // that dropped its .transit just ARRIVED, which triggers the soft
  // arrival ring (combatFx.spawnArrivalFlash). null = first frame, skip
  // the diff so a mid-flight page load doesn't fire a phantom flash.
  const prevTransitIdsRef = useRef<Set<string> | null>(null);
  const prevSettlementIdsRef = useRef<Map<string, { x: number; y: number; bodyId: string }>>(new Map());
  const destructionFlashesRef = useRef<Map<string, { pos: { x: number; y: number }; startMs: number; baseRadius?: number; id?: string }>>(new Map());
  /** Ship ids whose death already flashed at the hull via the list-diff
   *  path — consulted by the queued chronicle FX so the same kill never
   *  booms twice (once at the ship, later again from the queue). */
  const listDiffFlashedShipsRef = useRef<Set<string>>(new Set());
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
  // The same drawn points in WORLD space. Sensor rings and the visibility
  // pass work in world coords, and they were using ship.transit.pos — the
  // integration this map exists to route around — so a transiting hull's
  // fog circle sat ahead of the hull itself.
  const transitShipWorldPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  /** Memoised torch polylines, keyed by ship, valid while the plan and
   *  the body array keep their identity (i.e. until the next /state). */
  const torchSampleCacheRef = useRef<Map<string, {
    plan: unknown;
    bodies: unknown;
    samples: Array<{ t: number; x: number; y: number }>;
  }>>(new Map());
  // Parked-ship hit boxes recorded by the renderer (drawShip) each frame:
  // the exact drawn centre + a radius covering the sprite. The click/hover
  // hit-test reads these so the box is always ON the visible hull, spin,
  // interpolation and formation spread included.
  const shipHitboxesRef = useRef<Map<string, { x: number; y: number; r: number }>>(new Map());
  // Drag-box selection. Rendered as a fixed-position DOM overlay in
  // CLIENT coords rather than on the canvas: it changes every mousemove,
  // and feeding that through the canvas render effect would redraw the
  // whole map per pixel of drag. Null when no box is in flight.
  const [boxSel, setBoxSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // A completed drag must not also fire the click handler underneath —
  // otherwise releasing the box over empty space would immediately clear
  // the selection the drag just made.
  const suppressClickRef = useRef(false);
  // Ship under the cursor — drives the hover-only name label. A ref, not
  // state: mousemove fires on every pixel and the render loop already
  // runs each frame, so re-rendering the component for a label would be
  // pure churn. The loop reads .current when it builds RenderContext.
  const hoveredShipIdRef = useRef<string | null>(null);


  // Bodies we've ever had sensor coverage on. Yields are stable facts
  // about a rock, so once surveyed the readout sticks instead of blinking
  // out when the fleet moves on. Loaded lazily on first frame (needs the
  // faction list for the per-game key) and flushed on a timer, since the
  // set grows inside the rAF loop where setState/localStorage-per-frame
  // would be pure churn. See game/exploredBodies.
  const exploredRef = useRef<Set<string> | null>(null);
  const exploredKeyRef = useRef<string>('');
  const exploredDirtyRef = useRef(false);
  const exploredFlushAtRef = useRef(0);

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

  // Always-current camera for animation loops that must NOT re-subscribe
  // when it moves. A rAF pan loop that closes over `camera` re-registers
  // on every frame it produces, which tears its own timing down — see the
  // WASD effect below.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  // Same reason: the pan loop needs bodies + the live tick to convert a
  // focused camera into absolute coordinates, without re-subscribing
  // every time either changes.
  const bodiesRef = useRef(gameState.bodies);
  bodiesRef.current = gameState.bodies;
  const renderTickRef = useRef(renderTick);
  renderTickRef.current = renderTick;

  // === Q / E world cycling ===================================
  //
  // One flat list, ordered the way the system reads on the map: each
  // primary from the star outwards, immediately followed by its own moons
  // from ITS surface outwards. So Jupiter is followed by Io, Europa,
  // Ganymede, Callisto before Saturn's turn comes up. Asteroids and dwarf
  // planets are primaries in their own right (they orbit the star), so
  // they take their place by orbit radius like anything else.
  //
  // Built by depth-first walk rather than a hand-written order so a map
  // with extra stars, or bodies added later, needs no maintenance here.
  const worldCycle = useMemo(() => {
    // Not worlds: the star you measure from, and anything that isn't a
    // place you can go. An EXCLUDE list rather than an include list on
    // purpose — body type spellings vary across the seed data
    // ('gas-giant' vs 'gas_giant'), and a new world type should join the
    // cycle automatically instead of silently vanishing from it.
    // 'meteoroid' joins the skip list DELIBERATELY, against the
    // exclude-list convention above. That convention exists so a new
    // body type joins the Q/E cycle automatically rather than silently
    // vanishing — right for a new class of WORLD, wrong here: thirty
    // surveyed rocks would drown a cycle whose job is stepping between
    // the handful of places you actually hold. Rocks are reached from
    // the trade panel and the map, not by tabbing past them.
    const SKIP = new Set(['star', 'black_hole', 'black-hole', 'lagrange', 'meteoroid']);
    const childrenOf = new Map<string, GameBody[]>();
    const roots: GameBody[] = [];
    for (const b of gameState.bodies) {
      if (b.parent) {
        const arr = childrenOf.get(b.parent);
        if (arr) arr.push(b); else childrenOf.set(b.parent, [b]);
      } else {
        roots.push(b);
      }
    }
    const byRadius = (a: GameBody, b: GameBody) => (a.orbitRadius ?? 0) - (b.orbitRadius ?? 0);
    const out: string[] = [];
    const walk = (b: GameBody) => {
      // A revealed warp gate is a door, not a world — the world menu
      // refuses to open on one (WorldMenuOverlay), so leaving it in the
      // cycle would strand the menu on the previous world while the
      // selection had already moved on, and further presses would step
      // from an index nothing was showing.
      if (!SKIP.has(b.type) && !isRevealedWarpGate(b)) out.push(b.id);
      const kids = childrenOf.get(b.id);
      if (kids) [...kids].sort(byRadius).forEach(walk);
    };
    [...roots].sort(byRadius).forEach(walk);
    return out;
  }, [gameState.bodies]);
  const worldCycleRef = useRef(worldCycle);
  worldCycleRef.current = worldCycle;
  // focusBody is NOT referentially stable (it closes over bodies + tick),
  // so it goes through a ref like everything else this listener touches.
  // Listing it as a dependency would re-subscribe the handler on every
  // poll — the same self-defeating pattern that made WASD crawl.
  const focusBodyRef = useRef(focusBody);
  focusBodyRef.current = focusBody;
  const selectBodyRef = useRef(selectBody);
  selectBodyRef.current = selectBody;
  // Same reason as the two above: the route-pick effect subscribes once
  // and must not re-subscribe on every poll.
  const updateCameraRef = useRef(updateCamera);
  updateCameraRef.current = updateCamera;
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;
  // Bumped when pick mode changes, purely to force a repaint.
  const [, setPickTick] = useState(0);

  // Step to a world. With a world menu OPEN, tab the MENU to the new
  // world rather than just flying the camera: selecting is what opens a
  // menu (WorldMenuOverlay watches uiState.selectedBodyId and does its own
  // fly-in, framing and scale), so going through selectBody gets the menu
  // to follow you for free — and the overlay keeps the pre-menu camera
  // snapshot it took on the FIRST open, so closing still returns you to
  // where you were before any of this, not to the last world you tabbed
  // through. Outside a menu, plain focus is the right, cheaper move.
  const goToWorld = (bodyId: string) => {
    if (getWorldMenuOpenBodyId()) selectBodyRef.current(bodyId);
    else focusBodyRef.current(bodyId);
  };
  const goToWorldRef = useRef(goToWorld);
  goToWorldRef.current = goToWorld;

  // ROUTE PICKING — repaint on enter/leave, and honour a fit request.
  //
  // The composer can't reach the camera (a dock panel is mounted
  // outside the game provider on purpose), so it posts the stop ids and
  // this resolves them: bodies ORBIT, so their positions only exist for
  // a given tick, and only the canvas knows the viewport. Framing the
  // whole set is the point — focusBody frames ONE world, which on a
  // four-stop circuit hides the three you just picked.
  useEffect(() => subscribeRoutePick(() => {
    const ids = takeRouteFit();
    if (ids && ids.length > 0) {
      const cv = canvasRef.current;
      const bodies = gameStateRef.current?.bodies ?? [];
      const pts = ids
        .map(id => bodies.find(b => b.id === id))
        .filter((b): b is NonNullable<typeof b> => !!b)
        .map(b => bodyPosition(b, renderTick(), bodies));
      const fit = cv
        ? fitToPoints(pts, { width: cv.clientWidth, height: cv.clientHeight },
                      { maxScale: 8 })
        : null;
      if (fit) updateCameraRef.current({ x: fit.x, y: fit.y, scale: fit.scale });
    }
    // Cheap forced repaint so the dim pass appears the instant the
    // player presses the button, rather than on the next animation tick.
    setPickTick(t => t + 1);
    // renderTick is a useCallback over the tick clock; the body-position
    // sample above reads it, so it belongs in the deps.
  }), [renderTick]);

  useEffect(() => {
    const isTextField = (el: EventTarget | null): boolean => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== 'q' && k !== 'e') return;
      const cycle = worldCycleRef.current;
      if (cycle.length === 0) return;
      e.preventDefault();

      const cam = cameraRef.current;
      let idx = cam.focusedBodyId ? cycle.indexOf(cam.focusedBodyId) : -1;
      if (idx < 0) {
        // Not focused (or focused on something outside the cycle, e.g.
        // the star): start from whatever world the viewport is nearest,
        // so the first press continues from where you are looking instead
        // of teleporting you to Mercury.
        const bodies = bodiesRef.current;
        const tick = renderTickRef.current();
        let best = Infinity;
        cycle.forEach((id, i) => {
          const b = bodies.find(bb => bb.id === id);
          if (!b) return;
          const p = bodyPosition(b, tick, bodies);
          const d = Math.hypot(p.x - cam.x, p.y - cam.y);
          if (d < best) { best = d; idx = i; }
        });
        if (idx < 0) return;
        // First press only re-centres on that nearest world; it does not
        // also step. Stepping would skip past the thing you were looking
        // at, which reads as the key overshooting.
        goToWorldRef.current(cycle[idx]);
        return;
      }

      // Clamped, not wrapped: E at the outermost body would otherwise fling
      // you back to Mercury, which is exactly the whole-system jump that
      // reads as a bug rather than as navigation.
      const next = k === 'q' ? idx - 1 : idx + 1;
      if (next < 0 || next >= cycle.length) return;
      goToWorldRef.current(cycle[next]);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

    // ID LOOKUPS FOR THE WHOLE FRAME. Ten places in this render did a
    // LINEAR .find() by id, several inside a per-ship, per-settlement or
    // per-FX loop — so the cost was objects x objects and grew
    // quadratically as a match filled up. Two Maps built once a frame
    // make every one of them O(1).
    //
    // Declared HERE, at the top, rather than beside the system-grouping
    // helpers where the body map used to live: the settlement loop that
    // needs it runs several hundred lines EARLIER, and a const declared
    // later is in its temporal dead zone. The build caught that.
    const bodyById2 = new Map(gameState.bodies.map(b => [b.id, b] as const));
    const shipById2 = new Map(gameState.ships.map(s => [s.id, s] as const));

    // GROUPINGS FOR THE TRACER ATTRIBUTION BELOW, which was the worst
    // scaling in this file. For every ship that took damage this frame it
    // scanned EVERY ship and EVERY settlement to name a shooter — so the
    // cost was damaged x objects, and "damaged" is largest during exactly
    // the fleet action that also has the most objects. Quadratic in the
    // one situation that matters.
    //
    // Built once per frame instead. The lowest-id tie-break is unchanged:
    // the scan still walks a group, just a group of the right size.
    const shipsByParent = new Map<string, Ship[]>();
    for (const s of gameState.ships) {
      if (s.transit) continue;                       // matches the old guard
      const arr = shipsByParent.get(s.orbit.parentBodyId);
      if (arr) arr.push(s); else shipsByParent.set(s.orbit.parentBodyId, [s]);
    }
    const settlementsByBodyId = new Map<string, typeof gameState.settlements>();
    for (const st of gameState.settlements) {
      const arr = settlementsByBodyId.get(st.bodyId);
      if (arr) arr.push(st); else settlementsByBodyId.set(st.bodyId, [st]);
    }
    // Transit shooters, indexed by who they are shooting AT. FIRST writer
    // wins, because the original used .find() and took the first match in
    // array order — a Map.set would have silently changed which of two
    // shooters gets the tracer.
    const shooterByTarget = new Map<string, Ship>();
    for (const s of gameState.ships) {
      if (s.lastTargetId === undefined || s.lastTargetId === null) continue;
      if (s.lastCombatTick === undefined) continue;
      if (gameState.currentTick - s.lastCombatTick > 3) continue;
      // Self and same-owner are rejected HERE, not at the point of use.
      // Indexing first and filtering later is NOT equivalent: if the
      // first ship aiming at a target is disqualified but a later one
      // is not, .find() picked the later one while a filter-on-read
      // returns the first and then drops it — losing the tracer
      // entirely. Reachable, because a detonator hits friend and foe and
      // so can carry a friendly lastTargetId.
      if (s.id === s.lastTargetId) continue;
      const tgt = shipById2.get(s.lastTargetId);
      if (tgt && tgt.ownedBy === s.ownedBy) continue;
      if (!shooterByTarget.has(s.lastTargetId)) shooterByTarget.set(s.lastTargetId, s);
    }

    // When a body is focused, recompute its world position each frame so
    // the camera tracks it as it orbits.
    let camX = camera.x;
    let camY = camera.y;
    if (camera.focusedBodyId) {
      const focusedBody = gameState.bodies.find(b => b.id === camera.focusedBodyId);
      if (focusedBody) {
        const pos = bodyPosition(focusedBody, renderTick(), gameState.bodies);
        // World menu (MP only): while the overlay is active, camera.x/y
        // act as an OFFSET from the tracked body so the menu can park
        // the body below the frame (upper-limb framing). SP: camera.x/y
        // are always 0 while focused (focusBody zeroes them; pan/pinch
        // release focus first), so pos + 0 ≡ pos — byte-identical.
        if (isWorldMenuActive()) {
          camX = pos.x + camera.x;
          camY = pos.y + camera.y;
        } else {
          camX = pos.x;
          camY = pos.y;
        }
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
    const nowTick = renderTick();

    // Build the current frame's ship-pos snapshot so we can both
    // (a) record damage flashes on hit and (b) remember positions
    // for any disappearing entries so destruction has a place to draw.
    // cls rides along so a wreck can be sized off the hull that died —
    // the ship is gone from /state by the time we notice, so its class
    // has to be remembered from the frame it was last alive.
    const curShipIds = new Map<string, { x: number; y: number; cls: string }>();
    // Reset the transit-ship canvas-position cache — it gets repopulated
    // per-frame by the per-ship overlay below. A ship that arrived and
    // dropped out of transit shouldn't keep its old hitbox.
    transitShipCanvasPosRef.current.clear();
    // TRANSIT POSITIONS FOR THE FOG PASS — rebuilt here, from the same
    // sampler the renderer draws along, for EVERY hull in transit.
    //
    // This used to be filled as a side effect of drawing, and only
    // pruned here. That coupled two things that must not be coupled: the
    // sensor pass read these positions, and the draw pass that wrote
    // them SKIPPED any ship the sensor pass had just called invisible
    // (and any collapsed into a system badge). So a hull near the edge
    // of a ring froze its own fog position the moment it went dark, then
    // jumped forward the moment it came back — a two-frame oscillator
    // that flickered the ship, its "T-0" ghost and its world's count
    // badge at frame rate. ("The ship number counter flickers between
    // the correct amount and the soon-to-be-correct amount" — clownking,
    // filming a hull about to arrive at an occupied planet.)
    //
    // Computing it up front breaks the loop: what the fog sees no longer
    // depends on what the fog decided last frame. Cost is one 80-step
    // sample per hull IN TRANSIT — the renderer already pays exactly
    // this for each one it draws.
    // Sampling is memoised on (plan, bodies) identity. Both arrays are
    // replaced wholesale by the provider on each /state poll and never
    // mutated, so reference equality is a sound key: the 80-step
    // integration runs once per leg per poll (~1.5s) rather than 60
    // times a second, and per-frame cost drops to one lerp per hull.
    transitShipWorldPosRef.current.clear();
    for (const s of gameState.ships) {
      const plan = s.transit?.currentTransfer;
      if (!plan) continue;
      let hit = torchSampleCacheRef.current.get(s.id);
      if (!hit || hit.plan !== plan || hit.bodies !== gameState.bodies) {
        const samples = torchTrajectorySamples(plan, gameState.bodies);
        if (samples.length < 2) continue;
        hit = { plan, bodies: gameState.bodies, samples };
        torchSampleCacheRef.current.set(s.id, hit);
      }
      const p = torchPositionFromSamples(hit.samples, renderTick());
      transitShipWorldPosRef.current.set(s.id, { x: p.x, y: p.y });
    }
    // Drop cache entries for hulls no longer in transit so a long session
    // doesn't accumulate dead legs.
    if (torchSampleCacheRef.current.size > transitShipWorldPosRef.current.size) {
      for (const id of torchSampleCacheRef.current.keys()) {
        if (!transitShipWorldPosRef.current.has(id)) torchSampleCacheRef.current.delete(id);
      }
    }
    // Label/badge occupancy is per-frame state.
    resetReservations();
    // Parked-ship hit boxes are rebuilt every frame by drawShip. Clear
    // here so a ship that left orbit doesn't keep a stale box.
    shipHitboxesRef.current.clear();
    const curTransitIds = new Set<string>();
    for (const ship of gameState.ships) {
      if (ship.transit) curTransitIds.add(ship.id);
      // Position now; ships in transit use the torch trajectory so they
      // explode at the spot they were on the burn when killed.
      // shipWorldPosition returns null for ships whose parent body
      // has gone missing — skip those rather than crash.
      const pos: { x: number; y: number } | null =
        shipWorldPosition(ship, nowTick, gameState.bodies);
      if (pos) curShipIds.set(ship.id, { x: pos.x, y: pos.y, cls: ship.class });

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
        // A hull hit IN FLIGHT has a shooter now (transit combat), but
        // never a local one — so the lowest-id-at-this-body attribution
        // below is meaningless for it. Use the server's stamp: whoever
        // is currently engaging this ship named it as their target.
        if (ship.transit) {
          // Fully qualified at build time (see shooterByTarget), so a hit
          // here is the same ship .find() would have returned.
          const shooter = shooterByTarget.get(ship.id);
          if (shooter) spawnTracer(shooter.id, ship.id, nowMs);
        } else {
          const atBody = ship.orbit.parentBodyId;
          let attackerId: string | null = null;
          for (const s of (shipsByParent.get(atBody) ?? [])) {
            if (s.id === ship.id) continue;   // transit + body already filtered
            if (s.ownedBy === ship.ownedBy) continue;
            // Server-authoritative damage when present (designer builds
            // can arm or disarm any hull); class def for SP/legacy.
            if ((s.damagePerTick ?? getShipClass(s.class).damagePerTick) <= 0) continue;
            if (attackerId === null || s.id < attackerId) attackerId = s.id;
          }
          // Hostile settlements are shooters too — every city/station
          // returns fire server-side (SETTLEMENT_DMG + weapons modules),
          // so a lone freighter limping past a hostile station takes its
          // hits from SOMETHING visible. Same lowest-id determinism.
          for (const st of (settlementsByBodyId.get(atBody) ?? [])) {
            if (st.hp <= 0) continue;         // body already filtered
            if (st.ownedBy === ship.ownedBy) continue;
            if (attackerId === null || st.id < attackerId) attackerId = st.id;
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
    // Pairwise at-peace test for this frame. Shared with the fleet
    // list and outliner (src/game/peace.ts) and built from the same
    // treaty set room.js suppresses damage on, so a formation only
    // reads as a battle when the server would really shoot.
    const atPeace = makePeaceCheck(gameState.pactPairs);
    const sensorRingsThisFrame = factionSensorRings(
      'player',
      gameState.ships,
      gameState.settlements,
      gameState.bodies,
      nowTick,
      alliedSet,
      transitShipWorldPosRef.current,
    );
    const wasInCoverage = (pos: { x: number; y: number }): boolean => {
      for (const r of sensorRingsThisFrame) {
        const dx = pos.x - r.pos.x;
        const dy = pos.y - r.pos.y;
        if (dx * dx + dy * dy <= r.range * r.range) return true;
      }
      return false;
    };

    // Explored-body memory. Loaded here rather than in an effect because
    // the per-game key comes from the faction list, which isn't populated
    // on the first mount. Re-keys if the player switches games without a
    // reload. Bodies hosting one of our settlements seed in immediately —
    // you're standing on them, so their yields are known even if a sensor
    // ring happens not to cover the exact orbital position this frame.
    const exploredKey = exploredStorageKey(gameState.factions.map(f => f.id));
    if (exploredRef.current === null || exploredKeyRef.current !== exploredKey) {
      exploredKeyRef.current = exploredKey;
      exploredRef.current = loadExplored(exploredKey);
      exploredDirtyRef.current = false;
    }
    for (const s of gameState.settlements) {
      if (s.ownedBy === 'player' && !exploredRef.current.has(s.bodyId)) {
        exploredRef.current.add(s.bodyId);
        exploredDirtyRef.current = true;
      }
    }
    // Flush at most every 2s — the set grows inside the rAF loop and a
    // localStorage write per frame would be pure churn.
    if (exploredDirtyRef.current && nowMs - exploredFlushAtRef.current > 2000) {
      saveExplored(exploredKeyRef.current, exploredRef.current);
      exploredDirtyRef.current = false;
      exploredFlushAtRef.current = nowMs;
    }

    if (prevShipIdsRef.current.size > 0) {
      for (const [id, pos] of prevShipIdsRef.current) {
        if (!curShipIds.has(id) && !destructionFlashesRef.current.has(id)) {
          // Only flash a REAL kill. A ship dropping out of /state usually
          // just left the player's (moving) sensor coverage — a fog-out,
          // not a death. The server chronicles actual kills; require one.
          if (!diedByChronicle(id, nowMs)) continue;
          // Prefer the position the renderer actually DREW the hull at
          // last frame — battle-line arcs and lane offsets place ships
          // far from their textbook orbital point, and a wreck on the
          // wrong side of the planet reads as a bug (QA finding).
          const drawnPos = drawnShipWorldPos(id) ?? pos;
          destructionFlashesRef.current.set(id, { pos: drawnPos, startMs: nowMs, baseRadius: 12, id });
          // Remember we played this kill AT THE HULL, so the queued
          // chronicle twin of the same death doesn't boom again later.
          listDiffFlashedShipsRef.current.add(id);
          if (listDiffFlashedShipsRef.current.size > 2000) listDiffFlashedShipsRef.current.clear();
          // Leave a wreck at the kill site — the battle scars the map
          // for a few minutes instead of vanishing with the flash.
          // Sized off the DEAD HULL's own icon, not a flat 12: a destroyer
          // (icon 44) now leaves visibly more than a corvette (28).
          spawnWreck(id, drawnPos, shipIconSize(pos.cls, false), nowMs, nowTick);
        }
      }
    }
    prevShipIdsRef.current = curShipIds;

    // Settlements get the same treatment but their position is the
    // body world-position (cities + stations both render adjacent to
    // their body). Reusing bodyPosition keeps the math tight.
    const curSettlementIds = new Map<string, { x: number; y: number; bodyId: string }>();
    for (const settlement of gameState.settlements) {
      const body = bodyById2.get(settlement.bodyId);
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

      // "Just built" module pop — same edge-detection shape as the
      // population pulse above, but per building kind so the flash
      // lands on the exact module that grew (a new weapons barrel, not
      // a generic glow over the whole station). 0→1 counts as an
      // increase (first construction), matching "a new visual item
      // appears every time you build" literally, not just on upgrades.
      for (const kind of Object.keys(BUILDING_DEFS) as BuildingKind[]) {
        const key = `${settlement.id}:${kind}`;
        const level = buildingLevel(settlement, kind);
        const prevLevel = prevBuildingLevelsRef.current.get(key);
        if (prevLevel !== undefined && level > prevLevel) {
          buildFlashStartRef.current.set(key, nowMs);
        }
        prevBuildingLevelsRef.current.set(key, level);
      }

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
        // Bombardment tracer: only ships attack settlements, so the
        // shooter is the lowest-id armed hostile ship at this body —
        // same deterministic attribution the ship-damage path uses, so
        // every client draws the same shot.
        let attackerId: string | null = null;
        for (const s of gameState.ships) {
          if (s.transit) continue;
          if (s.orbit.parentBodyId !== settlement.bodyId) continue;
          if (s.ownedBy === settlement.ownedBy) continue;
          if ((s.damagePerTick ?? getShipClass(s.class).damagePerTick) <= 0) continue;
          if (attackerId === null || s.id < attackerId) attackerId = s.id;
        }
        if (attackerId) spawnTracer(attackerId, settlement.id, nowMs);
      }
    }
    if (prevSettlementIdsRef.current.size > 0) {
      for (const [id, snap] of prevSettlementIdsRef.current) {
        if (!curSettlementIds.has(id) && !destructionFlashesRef.current.has(id)) {
          // Same rule as ships: a settlement vanishing from /state is far
          // more likely a fog-out than a destruction, so require a
          // server-chronicled kill (settlement_destroyed carries body_id,
          // not a settlement id — match on the host body).
          if (!diedByChronicle(`body:${snap.bodyId}`, nowMs)) continue;
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
    // Build pops live 900ms (isoStructures.BUILD_POP_DURATION_MS) — a
    // slightly looser prune window here is harmless, drawBuildPop
    // itself no-ops once an entry ages past its own duration.
    for (const [key, startMs] of buildFlashStartRef.current) {
      if (nowMs - startMs >= 1000) buildFlashStartRef.current.delete(key);
    }

    // Transit lanes for this frame. Cheap (one pass over ships, only those
    // in transit group at all) and it must be computed BEFORE the context is
    // built, because the trajectory layer, the hull and the click hit-test
    // all read the same map.
    const transitLanes = computeTransitLanes(gameState.ships);
    const renderContext: RenderContext = {
      ctx,
      canvas: canvasRef.current,
      transitLanes,
      // camScale (not camera.scale) — the eased-camera tween renders the
      // interpolated scale; reading the raw target here would snap zoom
      // while position eased.
      camera: { x: camX, y: camY, scale: camScale, focusedBodyId: camera.focusedBodyId },
      // Selection reaches the orbit layer so drawOrbit can fade
      // rings unrelated to the selected body (falls back to the
      // camera focus when nothing is explicitly selected).
      selectedBodyId: uiState.selectedBodyId,
      t: renderTick(),
      bodies: gameState.bodies,
      // Factions enable per-faction ship coloring (matches settlements).
      // Without this, drawShip falls back to cyan-for-player / red-otherwise,
      // which collapsed every AI rival into the same hue.
      factions: gameState.factions,
      simSpeed,
      damageFlashStart: damageFlashStartRef.current,
      growthFlashStart: growthFlashStartRef.current,
      buildFlashStart: buildFlashStartRef.current,
      shipHitboxes: shipHitboxesRef.current,
      // LIGHTWEIGHT MODE freezes the ANIMATION clock. ~40 reads of
      // ctx.nowMs drive wall-clock phase — corona shimmer, cloud drift,
      // engine idle glow, dashed-orbit crawl, selection-bracket pulse —
      // and a constant makes every one of them hold still. Freezing here
      // rather than at the `nowMs` declaration on purpose: that same
      // variable also drives real bookkeeping (the 2s explored-bodies
      // flush throttle, FX spawn stamps), and stopping it would wedge
      // them.
      nowMs: isLightweight() ? FROZEN_ANIM_MS : nowMs,
      // Planet-visual extras: night-side city lights on settled worlds
      // + focus-zoom building structures read these. Optional in the
      // RenderContext so the lobby preview can skip them.
      settlements: gameState.settlements,
      buildOrders: gameState.buildOrders,
      // Hover-only ship labels — read fresh each frame from the ref the
      // mousemove hit-test writes.
      hoveredShipId: hoveredShipIdRef.current,
      // Resolves a ship's EFFECTIVE max HP for the hover/selection health
      // bar, so the map agrees with the Fleet/Ship panels.
      factionTech: gameState.factionTech,
      // Dyson Sphere lattice around Sol — progress fraction drives how
      // many cage segments are lit; complete = the solid sun-cage.
      dysonSphere: gameState.dysonSphere ? {
        progress: gameState.dysonSphere.maxHp > 0
          ? gameState.dysonSphere.hp / gameState.dysonSphere.maxHp
          : 0,
        complete: gameState.dysonSphere.maxHp > 0
          && gameState.dysonSphere.hp >= gameState.dysonSphere.maxHp,
      } : undefined,
    };

    clearCanvas(renderContext);

    // How much of the star system is on screen, in screen-heights. All
    // the zoomed-out LOD keys off this rather than camera.scale, so it
    // behaves identically in a 1x game and a SYSTEM_SCALE=2 one.
    const spans = systemSpans(renderContext);
    const regionFade = systemRegionOpacityFor(spans, camera.scale, gameState.bodies);
    // Structure-derived, so it costs a pass over the body list — skipped
    // entirely once we're zoomed past the overlay's fade-out.
    const systemRegions = regionFade > 0
      ? computeSystemRegions(
          gameState.bodies, gameState.factions, gameState.settlements,
          // MP: fog-free claims so political borders show even where
          // sensors don't reach. SP leaves this undefined and the
          // (unfogged) settlements list serves the same role.
          gameState.settlementClaims,
        )
      : [];

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
    // Self-gating: no-ops above SYSTEM_REGION_HIDE_SPANS.
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
    //
    // World menu (MP only — isWorldMenuActive() is false everywhere in
    // SP): orbit rings are "map furniture" and fade out as the camera
    // dives into a body's diegetic menu, so the focused planet's own
    // ring never slashes across the menu sky (spec G9). orbitAlpha
    // stays 1 in SP and at map zoom, making this hunk a no-op there.
    let orbitAlpha = 1;
    if (isWorldMenuActive() && camera.focusedBodyId) {
      const focusedBody = gameState.bodies.find(b => b.id === camera.focusedBodyId);
      if (focusedBody && focusedBody.type !== 'star') {
        orbitAlpha = furnitureOpacity(zOf(camera.scale, focusedBody, renderContext.canvas.height));
        // Publish the raised interactive-zoom cap for this focused body;
        // wheel + touch handlers read it from the store. (SP: store
        // always reports 50 because the overlay never activates it.)
        setWorldMenuMaxScale(Math.max(50, menuScaleFor(focusedBody, renderContext.canvas.height)));
      } else {
        setWorldMenuMaxScale(null);
      }
    } else {
      setWorldMenuMaxScale(null);
    }
    if (orbitAlpha > 0.01) {
      for (const body of gameState.bodies) {
        // NO RINGS FOR ROCKS. Thirty meteoroids drawing thirty rings
        // turns the map into a spirograph, and unlike a planet's orbit
        // the ring tells you nothing you can act on — you never plan
        // around where a rock WILL be, you send a freighter to where it
        // is. `mineralKind` catches belt, Kuiper and restocked rocks
        // alike; the `lagrange` test stays because L3 markers predate
        // meteoroids and not all of them carry a mineral.
        if (body.parent && body.type !== 'lagrange' && !body.mineralKind) {
          drawOrbit(body, renderContext, withOpacity(body.color, 0.35 * orbitAlpha));
        }
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
        // Where the hull is DRAWN. Using the raw orbital point sprang
        // this line from empty space, and the gap swung open and shut as
        // the cosmetic spin carried the hull around the planet.
        const shipWorldPos = ship ? drawnPosOf(ship) : null;
        if (ship && hovBody && shipWorldPos) {
          const bodyWorldPos = bodyPosition(hovBody, renderTick(), gameState.bodies);
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
    // MP: the payload IS the fog. The server already decided what this
    // player can see when it built /state; re-running a second,
    // slightly-different fog here is what made server-visible ships
    // blink out near range boundaries (the "flickering ship around
    // Mercury" report — see payloadVisibility). The client's only job
    // in MP is ghost bookkeeping for ships the server STOPS sending.
    //
    // SP: no server, so the local computeVisibility stays the fog —
    // recomputed each frame, carrying lastSeen forward so ghosts age.
    const visibility = gameState.tickIntervalMs != null
      ? payloadVisibility(
          'player',
          gameState.ships,
          renderTick(),
          lastSeenRef.current,
          gameState.bodies,
          // Sightings are recorded at the DRAWN position (spin and
          // formation fan included) so a ghost appears exactly where
          // the hull was last visibly seen.
          drawnShipWorldPositions(),
          // Needed for the coverage cull: a station's 800 is usually the
          // widest bubble you own, and without settlements a ghost could
          // survive sitting on top of your own dry dock.
          gameState.settlements,
        )
      : computeVisibility(
          'player',
          gameState.ships,
          gameState.settlements,
          gameState.bodies,
          renderTick(),
          lastSeenRef.current,
          alliedSet,
          transitShipWorldPosRef.current,
          drawnShipWorldPositions(),
        );
    lastSeenRef.current = visibility.lastSeen;
    const visibleShipIds = visibility.visibleShipIds;

    // Compute threats (hostile transits targeting player-owned bodies) —
    // but only include threats from ships the player can actually see.
    const allThreats = computeIncomingThreats(gameState, 'player');
    const threats = allThreats.filter(t => visibleShipIds.has(t.attackerShipId));
    const threatBodies = threatenedBodyIds(threats);

    // INTERCEPT MARKERS — where a hostile's firing envelope opens on one
    // of your hulls. Recomputed once per TICK, not per frame: the walk is
    // ships x foes x horizon and nothing in it changes between frames,
    // since every trajectory involved is a committed burn.
    const rTick = renderTick();
    if (interceptCacheRef.current.tick !== gameState.currentTick) {
      const bodies = gameState.bodies;
      // A transit hull's position must be PROJECTED, not read: ship.transit
      // reports one cached point whatever tick you ask for, which would
      // collapse every window into "right now". The torch samples are the
      // same ones the arc is drawn from, so the marker lands on the line
      // the player can already see.
      const sampleCache = new Map<string, Array<{ t: number; x: number; y: number }>>();
      const posOf = (s: Ship, t: number): { x: number; y: number } => {
        const plan = s.transit?.currentTransfer;
        if (!plan) {
          // A parked hull's orbit is defined at any tick, so this is a
          // real projection. Null only when the body is gone; treat that
          // as "nowhere" rather than crashing the whole frame.
          return shipWorldPosition(s, t, bodies) ?? { x: 0, y: 0 };
        }
        let smp = sampleCache.get(s.id);
        if (!smp) { smp = torchTrajectorySamples(plan, bodies); sampleCache.set(s.id, smp); }
        return torchPositionFromSamples(smp, t);
      };
      const mine = gameState.ships.filter(s => s.ownedBy === 'player' && s.transit);
      // Fog applies: a window is only drawn for a hostile your sensors
      // actually hold. Drawing one for an unseen ship would leak its
      // position through the marker.
      const seen = { ...gameState, ships: gameState.ships.filter(
        s => s.ownedBy === 'player' || visibleShipIds.has(s.id)) };
      const fc = gameState.transitCombatEnabled
        ? forecastIntercepts(seen as typeof gameState, gameState.currentTick, mine, posOf, {
          // The SAME pairwise pact check the battle-line pass uses below,
          // so a treaty partner never draws a firing marker on you.
          atPeace: (a, b) => atPeace(a, b),
          // A parked hull never "arrives", so Infinity leaves it to the
          // ordinary reach test rather than truncating the walk to zero.
          arrivalOf: (s) => s.transit?.currentTransfer?.arriveTick ?? Infinity,
        })
        : [];
      // ONE MARKER PER THREATENED HULL, not per (hull, hostile) pair.
      // forecastIntercepts yields a row per pair, so three ships under
      // fire from three hostiles drew NINE reticles stacked on top of
      // each other with their labels interleaved into gibberish. A ship
      // being shot at by three hulls is still ONE thing happening to one
      // ship; the extra rows are detail for the panel, not the map.
      //
      // The kept row is the SOONEST window — the deadline that actually
      // constrains the player — with the hostile count carried alongside
      // so the marker can say three are shooting without drawing three.
      const worst = new Map<string, typeof fc[number] & { foes: number }>();
      for (const f of fc) {
        if (!f.incoming) continue;
        const prev = worst.get(f.ship.id);
        if (!prev) { worst.set(f.ship.id, { ...f, foes: 1 }); continue; }
        prev.foes += 1;
        if (f.incoming.opensAt < prev.incoming!.opensAt) {
          worst.set(f.ship.id, { ...f, foes: prev.foes });
        }
      }
      interceptCacheRef.current = {
        tick: gameState.currentTick,
        markers: [...worst.values()].map(f => ({
          x: f.incoming!.atPoint.x,
          y: f.incoming!.atPoint.y,
          opensAt: f.incoming!.opensAt,
          duration: f.incoming!.duration,
          hitChance: f.incoming!.hitChance,
          open: f.incoming!.open,
          canAnswer: !!f.outgoing,
          foes: f.foes,
          ex: f.incoming!.exitPoint.x,
          ey: f.incoming!.exitPoint.y,
          closesAt: f.incoming!.closesAt,
        })),
      };
    }

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
    // Drawn AFTER the trajectory layers on purpose: the reticle annotates
    // those lines, so it has to sit on top of them rather than under.
    // Rides the enemyTrajectories toggle — a player who has hidden hostile
    // courses has said they do not want this class of warning on the map.
    if (layerOn('enemyTrajectories')) {
      drawInterceptMarkersLayer(interceptCacheRef.current.markers, rTick, renderContext);
    }
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

    // Body-label collision plan. A body's name draws at a fixed offset
    // below its dot with no awareness of its neighbours, so close pairs
    // (Mercury/Venus at low zoom, five co-orbital Belt rocks) printed on
    // top of each other. Pre-pass over every body that WILL show a label
    // this frame (same gate drawBody itself uses), measure its box, and
    // let planBodyLabels stagger contenders onto rows above OR below
    // their own body — whichever direction is actually clear, never
    // sideways, never hidden, never far. (An earlier below-only version
    // let a crowded label walk downward across the whole system — Phobos
    // ended up over near Earth — even when the space directly above its
    // own body was empty the whole time.) Read-only against the
    // explored/coverage state (the loop below still owns the one
    // mutation that marks a body explored) so this can run first without
    // disturbing that bookkeeping.
    // System grouping helpers — shared by the label collapse below, the
    // ship loop's transit-collapse, and the badge block. A moon rolls up
    // to its planet; a planet (parent is the star) is its own anchor.
    const childrenOf2 = new Map<string, typeof gameState.bodies>();
    for (const b of gameState.bodies) {
      if (!b.parent) continue;
      const arr = childrenOf2.get(b.parent) ?? [];
      arr.push(b);
      childrenOf2.set(b.parent, arr);
    }
    const isStarLike = (b: (typeof gameState.bodies)[number] | undefined) =>
      !!b && (b.type === 'star' || b.type === 'black_hole');
    const anchorOf = (id: string | undefined | null): string | null => {
      if (!id) return null;
      const b = bodyById2.get(id);
      if (!b) return null;
      const p = b.parent ? bodyById2.get(b.parent) : undefined;
      return (p && !isStarLike(p)) ? p.id : id;
    };
    const systemPx = (anchorId: string): number => {
      const kids = childrenOf2.get(anchorId) ?? [];
      let maxOrbit = 0;
      for (const k of kids) if (k.orbitRadius > maxOrbit) maxOrbit = k.orbitRadius;
      const anchor = bodyById2.get(anchorId);
      return (maxOrbit > 0 ? maxOrbit : (anchor?.radius ?? 4)) * camera.scale;
    };

    /**
     * SYSTEM-LEVEL LABEL COLLAPSE.
     *
     * A moon's label is suppressed while its whole system is a tight
     * knot on screen, so the cluster reads as one place ("URANUS")
     * instead of five overlapping name+yield stacks fighting for the
     * same 200px. The anchor keeps its label for free — planets are
     * bodyLabelAlwaysOn (parent === 'sol').
     *
     * Threshold is the system's on-screen RADIUS (outermost moon's
     * orbit × camera.scale), which is resolution-independent and scales
     * naturally per system: wide systems separate sooner than tight
     * ones. Calibrated against Lorne's screenshot (2026-07-26) of the
     * Uranus system, the worst case in the map with 5 moons — Oberon's
     * orbit is 50u and sat ~170px out there, so 200px puts that view
     * firmly in "just URANUS" and reveals the moons on a ~20% zoom-in.
     * For reference at the same threshold: Neptune (78u) and Jupiter
     * (75u) open up around scale 2.6, Saturn (65u) ~3.1, Uranus ~4.0,
     * Mars (19u, only Phobos/Deimos) stays collapsed until far closer —
     * which is the pair that used to shove labels clear across the map.
     */
    const SYSTEM_LABEL_COLLAPSE_PX = 200;
    const labelCollapsed = (body: (typeof gameState.bodies)[number]): boolean => {
      const anchor = anchorOf(body.id);
      // Own anchor (planet/star) — never collapsed; it IS the system label.
      if (!anchor || anchor === body.id) return false;
      return systemPx(anchor) < SYSTEM_LABEL_COLLAPSE_PX;
    };

    const bodyLabelCandidates: Array<{
      id: string; x: number; belowAnchor: number; aboveAnchor: number;
      width: number; priority: number;
    }> = [];
    for (const body of gameState.bodies) {
      if (body.destroyedAtTick != null) continue;
      if (!(bodyLabelAlwaysOn(body) || renderContext.camera.scale > 0.4)) continue;
      // Satellite inside a knotted-up system: the anchor speaks for it.
      // Selection/hover always win — you must be able to see what you
      // clicked on, at any zoom.
      if (labelCollapsed(body)
          && uiState.selectedBodyId !== body.id
          && uiState.hoveredBodyId !== body.id) continue;
      const wp = bodyPosition(body, renderTick(), gameState.bodies);
      const cp = worldToCanvas(wp.x, wp.y, renderContext);
      const radius = Math.max(3, body.radius * renderContext.camera.scale);
      const isSelected = uiState.selectedBodyId === body.id;
      const isHovered = uiState.hoveredBodyId === body.id;
      const priority =
        isSelected ? 0
        : isHovered ? 1
        : body.ownedBy === 'player' ? 2
        : body.ownedBy ? 3
        : bodyLabelAlwaysOn(body) ? 4
        : 5;
      renderContext.ctx.font = '10px "Audiowide", monospace';
      const nameWidth = renderContext.ctx.measureText(body.name.toUpperCase()).width;
      // Yield row (see drawBody) can be wider than the name for a
      // well-stocked world; 64px comfortably covers three "NNM"-style
      // tokens at 9px "Audiowide", monospace without measuring the exact string here.
      const explored = exploredRef.current;
      const yieldsVisible = explored ? explored.has(body.id) : wasInCoverage(wp);
      const hasYieldRow = !!body.resources && yieldsVisible
        && (body.resources.metal > 0 || body.resources.gold > 0 || body.resources.science > 0);
      const width = Math.max(nameWidth, hasYieldRow ? 64 : 0);
      // Must exactly match the anchors drawBody derives internally
      // (same radius, same +/-14 gap, same row height) — see
      // bodyLabelRowTop — or the reserved box and the painted text
      // disagree.
      bodyLabelCandidates.push({
        id: body.id,
        x: cp.x,
        belowAnchor: cp.y + radius + 14,
        aboveAnchor: cp.y - radius - 14 - BODY_LABEL_ROW_HEIGHT,
        width,
        priority,
      });
    }
    const bodyLabelRows = planBodyLabels(bodyLabelCandidates);

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
      // A body's resource yields are intel, but they're a stable fact
      // about the rock rather than a live reading: once you've had eyes
      // on a world you keep the number. Gating on LIVE coverage made the
      // readout blink out the moment a fleet moved on, so a surveyed
      // world you'd been reading all game silently went blank.
      // Anything you own counts as surveyed regardless of sensors.
      const bodyPos = bodyPosition(body, renderTick(), gameState.bodies);
      const explored = exploredRef.current;
      if (explored && !explored.has(body.id)
          && (wasInCoverage(bodyPos) || body.ownedBy === 'player')) {
        explored.add(body.id);
        exploredDirtyRef.current = true;
      }
      const yieldsVisible = explored ? explored.has(body.id) : wasInCoverage(bodyPos);
      // World menu (MP only): selection brackets/hover rings are map
      // furniture — at menu zoom they'd render as giant chevrons across
      // the sky. orbitAlpha is 1 in SP and at map zoom (no-op there).
      const menuHidesChrome = orbitAlpha < 0.5;
      drawBody(
        body, renderContext,
        isSelected && !menuHidesChrome, isHovered && !menuHidesChrome,
        yieldsVisible, bodyLabelRows.get(body.id) ?? 0,
        // System-level collapse: a moon in a knotted system defers to its
        // planet's label. Selection/hover always keep their own name.
        labelCollapsed(body) && !isSelected && !isHovered,
      );
      // Asteroid-weapon overlay: flame trail + projected impact path
      // + pulsing crosshair on the target. drawBody already places
      // the body's icon at its ram-mode position via bodyPosition.
      if (body.ramPlan) {
        drawRammingBody(body, renderContext);
      }

      // Pulsing red threat ring around threatened bodies.
      if (threatBodies.has(body.id)) {
        const wp = bodyPosition(body, renderTick(), gameState.bodies);
        const cp = worldToCanvas(wp.x, wp.y, renderContext);
        const baseR = Math.max(8, body.radius * camera.scale + 10);
        // THE PULSING RED RING IS GONE (Lorne): "the ships shooting is
        // sign enough of that". It was a third ring on every contested
        // body, outside the ownership halo and inside nothing, and at a
        // glance it read as a rule of the map rather than a transient —
        // players asked what it meant. Tracers, engagement fire and the
        // battle lines already say a fight is happening, in the place it
        // is happening, without a permanent circle asserting it.
        //
        // What that costs: the ring used to be the FALLBACK for a label
        // the collision solver displaced, so the word below is now the
        // only marker. It carries priority 90 and outranks every other
        // label, so it effectively never loses — but "effectively" is
        // doing real work in that sentence. If a threatened body ever
        // goes unmarked in a crowded system, this is why.
        //
        // Each threatened body used to print its label unconditionally,
        // which stacked three "⚠ THREAT"s on the same pixels in a moon
        // system under attack; it goes through the solver instead.
        requestLabel({
          id: `threat:${body.id}`,
          kind: 'threat',
          text: '⚠ THREAT',
          x: cp.x,
          y: cp.y,
          radius: baseR + 6,
          priority: 90,
          font: 'bold 9px "Audiowide", monospace',
          color: '#ff5e5e',
          leader: true,
        });
      }
    }

    // World-menu diegetic close-up (MP only — inert in SP because
    // isWorldMenuActive() is only ever set by the MP-mounted overlay).
    // Paints surface detail/buildings/HP/fire ONTO the focused body's
    // already-drawn disc once the camera dives past map LOD. Drawn
    // before ships so hulls in orbit pass in front of the surface.
    if (isWorldMenuActive() && camera.focusedBodyId) {
      drawWorldMenuCloseup(renderContext, gameState.settlements, 'player');
    }

    // Build a co-orbit formation map: ships sharing the same parent body
    // and a similar orbital radius (bucketed) get PHASED evenly around the
    // ring — the i-th of N draws i/N of an orbit ahead (drawShip applies it
    // as a time offset), so a parked fleet reads as a ring of ships around
    // the planet instead of a stack at the arrival point. Only orbiting
    // ships are bucketed — ships in transit follow their torch trajectory
    // and don't stack.
    const formationMap = new Map<string, ShipFormation>();
    {
      // PASS 1 — group by BODY, not by altitude.
      //
      // The old key was `parent|round(sma)`, which put ships at slightly
      // different parking radii into different buckets. A fleet that
      // arrived in pieces, or mixed classes with different park heights,
      // straddles a rounding boundary — and a faction that lands alone in
      // its bucket falls through to shipLaneOnly: no arc, no drift, no
      // battle line. That is the third fleet sitting still while the
      // other two form up (player report, three-way fight at Sol).
      //
      // Combat is a property of the BODY, not of an altitude band, so
      // battle detection and line assignment now run over everything
      // orbiting the same world. Radial separation is what lane and the
      // renderer's ranks are for.
      const byBody = new Map<string, Ship[]>();
      for (const s of gameState.ships) {
        if (s.transit) continue;
        if (s.ownedBy !== 'player' && !visibleShipIds.has(s.id)) continue;
        const arr = byBody.get(s.orbit.parentBodyId) || [];
        arr.push(s);
        byBody.set(s.orbit.parentBodyId, arr);
      }

      for (const atBody of byBody.values()) {
        // Stable order so a ship's slot doesn't jitter frame-to-frame.
        atBody.sort((a, b) => (a.id < b.id ? -1 : 1));

        // BATTLE LINES: when two or more factions with ARMED hulls share
        // this WORLD, each faction forms its own line and the lines face
        // each other across a no-man's-land gap — instead of everyone
        // interleaving into a blender. Factions with only civilians
        // present (a freighter caught in the crossfire) still get a line
        // of their own so they visibly huddle away from the guns.
        //
        // The lines sit inside a CONTESTED SECTOR rather than spread
        // around the whole ring. Diametrically-opposed arcs (the first
        // cut) put the fleets on opposite sides of the planet, which
        // (a) hid half the battle behind the world and (b) collided with
        // the tracer-occlusion rule — every cross-fleet shot passed
        // through the planet and was suppressed, so a ten-ship brawl
        // drew one bolt. Park orbits are TIGHT (body radius + 2), so the
        // planet blocks any pair more than roughly 90° apart; keeping
        // the whole engagement inside BATTLE_SECTOR preserves line of
        // sight AND frames the entire fight on screen at once.
        const owners = [...new Set(atBody.map(s => s.ownedBy))].sort();
        const armedOwners = [...new Set(
          atBody.filter(s => (s.damagePerTick ?? getShipClass(s.class).damagePerTick) > 0)
              .map(s => s.ownedBy))];
        // A battle needs two armed factions that will actually SHOOT
        // each other. Without the peace test, two NAP partners sharing a
        // moon were drawn squaring off across a no-man's-land while the
        // server quietly refused to fire a shot — the same viewer-blind
        // hostility mistake the fleet-list badge had. atPeace is the
        // pairwise pact test (src/game/peace.ts), so this also stops
        // pulling a THIRD faction's allies into a firing line.
        const hostilePair = armedOwners.some(
          a => armedOwners.some(b => a !== b && !atPeace(a, b)));
        const battle = owners.length >= 2 && hostilePair;

        if (battle) {
          const F = owners.length;
          // Total angular span the whole engagement occupies (~86°).
          const BATTLE_SECTOR = 1.5;
          // Line centers spread evenly across the sector, centered on 0.
          const spacing = F > 1 ? BATTLE_SECTOR / (F - 1) : 0;
          // Each line's own width, leaving a visible gap between lines.
          const arcWidth = Math.min(spacing * 0.55, 0.8);
          // One wheel direction for the whole ring (lowest-id ship's),
          // so opposing lines hold their facing instead of counter-
          // rotating when fleets inserted from opposite approaches.
          const arcDir = atBody[0].orbit.direction ?? 1;
          owners.forEach((owner, k) => {
            const arcCenter = -BATTLE_SECTOR / 2 + spacing * k;
            const mine = atBody.filter(s => s.ownedBy === owner);
            mine.forEach((s, i) => {
              formationMap.set(s.id, {
                index: i, total: mine.length,
                lane: shipLane(s),
                arcCenter, arcWidth, arcDir,
              });
            });
          });
          continue;
        }

        // PASS 2 — peacetime. Sub-bucket by altitude so a station ring
        // and a parking ring stay separate rings rather than merging
        // into one crowded circle. Only reached when nobody is fighting
        // here, so it can't strand a faction out of a battle line.
        const buckets = new Map<string, Ship[]>();
        for (const s of atBody) {
          const sma = ((s.orbit.rp ?? 0) + (s.orbit.ra ?? 0)) / 2;
          const key = String(Math.round(sma));
          const list = buckets.get(key) || [];
          list.push(s);
          buckets.set(key, list);
        }
        for (const list of buckets.values()) {
          if (list.length === 1) {
            // Lone ship still gets its lane offset so a freighter parked
            // over a moon doesn't sit inside the station's ring.
            formationMap.set(list[0].id, shipLaneOnly(list[0]));
            continue;
          }
          list.forEach((s, i) => {
            formationMap.set(s.id, {
              index: i, total: list.length, lane: shipLane(s),
            });
          });
        }
      }
    }

    // Body ownership rings — drawn AFTER bodies so the halo sits around
    // the planet circle, BEFORE ships so the ring doesn't obscure ship
    // icons stacked at low altitude.
    //
    // Suppressed while the diegetic world menu is up (MP only): at that
    // zoom the barber-pole halo just wraps the one focused planet as a
    // fat dashed ring around the whole screen — noise. Ownership there
    // is conveyed by the faction-coloured city buildings + station
    // instead. (isWorldMenuActive() is always false in SP.)
    if (layerOn('ownership') && !(isWorldMenuActive() && camera.focusedBodyId)) {
      drawOwnershipLayer(gameState.bodies, renderContext);
    }

    // Per-body cluster accumulator. Counts PARKED (non-transit) ships
    // per body PER FACTION, so the badge tier can render one coloured
    // segment per fleet owner instead of N overlapping triangles.
    // Which bodies badge vs sprite is decided per SYSTEM below
    // (spriteBlendFor) — not by a global zoom threshold.
    const bodyClusters = new Map<string, Map<string, number>>();
    const bumpCluster = (bodyId: string, factionId: string) => {
      let cur = bodyClusters.get(bodyId);
      if (!cur) { cur = new Map(); bodyClusters.set(bodyId, cur); }
      cur.set(factionId, (cur.get(factionId) ?? 0) + 1);
    };

    // Sprite ⇄ badge blend for a body's SYSTEM: 0 = count badge, 1 =
    // individual hulls, crossfading over SPRITE_FADE_PX above the
    // moon-ring threshold. Anchored on the SAME px rule that gates the
    // system's orbit rings (drawOrbit), so hulls appear exactly when the
    // rings do. Moonless bodies run the rule on their own radius.
    const spriteBlendCache = new Map<string, number>();
    const spriteBlendFor = (bodyId: string | undefined | null): number => {
      if (!bodyId) return 1;
      const anchorId = anchorOf(bodyId) ?? bodyId;
      let v = spriteBlendCache.get(anchorId);
      if (v === undefined) {
        const anchor = bodyById2.get(anchorId);
        const px = (anchor?.radius ?? 4) * camera.scale;
        v = Math.max(0, Math.min(1, (px - MOON_ORBIT_MIN_PARENT_PX) / SPRITE_FADE_PX));
        spriteBlendCache.set(anchorId, v);
      }
      return v;
    };
    // Hull size ramps from ORBIT_SHIP_MIN_SCALE at the ring threshold to
    // full at SPRITE_FULL_PX, so a system you dive toward grows its
    // ships in rather than popping a wall of full-size hulls.
    const spriteSizeFor = (bodyId: string | undefined | null): number => {
      if (!bodyId) return 1;
      const anchorId = anchorOf(bodyId) ?? bodyId;
      const anchor = bodyById2.get(anchorId);
      const px = (anchor?.radius ?? 4) * camera.scale;
      return Math.max(ORBIT_SHIP_MIN_SCALE, Math.min(1,
        ORBIT_SHIP_MIN_SCALE + (1 - ORBIT_SHIP_MIN_SCALE)
          * (px - MOON_ORBIT_MIN_PARENT_PX) / (SPRITE_FULL_PX - MOON_ORBIT_MIN_PARENT_PX)));
    };
    // Transit ships hopping WITHIN one tight, overlapping system (moon to
    // moon) — collapsed into that system's badge instead of drawn as a
    // full-size hull clashing over the smear. Keyed by system anchor,
    // counted per faction like the parked clusters.
    const systemTransitCounts = new Map<string, Map<string, number>>();

    // Wrecks first — kill-site debris sits UNDER live hulls.
    if (!isLightweight()) drawWrecks(renderContext, nowMs);

    // Draw ships.
    //
    // Order matters where hulls overlap, and gameState.ships arrives grouped
    // by faction — so one faction's hulls were always painted last and the
    // other always lost ("blue ships are under yellows"). Sorting by lane
    // makes the layering a property of WHERE a ship is rather than WHO owns
    // it: lanes run back-to-front, so an overlap reads as depth, and no
    // faction is systematically buried. Ships with no lane (alone on their
    // route, or parked) sort as 0 and keep their existing relative order —
    // Array.prototype.sort is stable, so parked hulls are undisturbed.
    const drawOrder = [...gameState.ships].sort((a, b) =>
      (transitLanes.get(a.id) ?? 0) - (transitLanes.get(b.id) ?? 0));
    for (const ship of drawOrder) {
      // Fog of war: skip enemy ships the player can't currently see
      if (ship.ownedBy !== 'player' && !visibleShipIds.has(ship.id)) continue;

      const isSelected = uiState.selectedShipId === ship.id;
      // Parked-orbit rings are drawn ONLY for the ship the player is
      // pointing at (or has selected). Drawing one per ship turned a busy
      // body into a plate of spaghetti. Same predicate the hover-only name
      // label uses in drawShip, so the ring and the name appear together.
      const isShipHovered = hoveredShipIdRef.current === ship.id;
      const showOrbitRing = isSelected || isShipHovered;
      const formation = formationMap.get(ship.id);

      // Sprite ⇄ badge decision, PER SYSTEM: a parked hull draws
      // individually only once its system's moon-orbit rings are on
      // screen (spriteBlendFor). Below that it accumulates into its
      // world's per-faction count badge; inside the crossfade band both
      // render (hull dissolving, badge bleeding in). In-transit ships
      // keep drawing — their trajectory arcs spread them out — and the
      // selected ship stays visible so the player can find what they
      // picked.
      const sprBlend = (!ship.transit && !isSelected)
        ? spriteBlendFor(ship.orbit?.parentBodyId)
        : 1;
      if (sprBlend < 1 && !ship.transit && !isSelected) {
        const bodyId = ship.orbit?.parentBodyId;
        if (bodyId) {
          bumpCluster(bodyId, ship.ownedBy);
          if (sprBlend <= 0.01) continue;   // fully collapsed — badge only
        }
      }

      // Collapse a transit ship that's hopping WITHIN one system whose moons
      // overlap on screen: both endpoints anchor to the same planet and the
      // system is in system-badge mode. Otherwise a full-size hull moving
      // moon-to-moon clashes over the tiny system smear — count it into the
      // system badge instead and skip the individual draw (icon + arc).
      if (ship.transit && !isSelected) {
        const originAnchor = anchorOf(ship.orbit?.parentBodyId);
        const destAnchor = anchorOf(ship.transit.currentTransfer?.targetBodyId);
        if (originAnchor && originAnchor === destAnchor
            && (childrenOf2.get(originAnchor)?.length ?? 0) > 0
            && systemPx(originAnchor) < SYSTEM_BADGE_MAX_PX) {
          let cur = systemTransitCounts.get(originAnchor);
          if (!cur) { cur = new Map(); systemTransitCounts.set(originAnchor, cur); }
          cur.set(ship.ownedBy, (cur.get(ship.ownedBy) ?? 0) + 1);
          continue;
        }
      }

      // Crossfade band: parked hulls dissolve as the badges take over.
      // globalAlpha multiplies through drawShip's fills (its internal
      // overrides are all `dressed`-gated, and dressed is impossible at
      // badge-tier zooms), so one outer alpha fades the whole sprite.
      const orbitShipScale = ship.transit ? 1 : spriteSizeFor(ship.orbit?.parentBodyId);
      const prevShipAlpha = ctx.globalAlpha;
      if (sprBlend < 1) ctx.globalAlpha = prevShipAlpha * sprBlend;

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
        // A ship can be on a route as a CARRIER or a GUARD, so this can
        // no longer match on the route's single ship id — routeForShip
        // asks the crew (src/game/routeSelectors.ts). A guard flying the
        // lane gets the dashed treatment too: it is on the run, and the
        // dash is what says "this is a recurring circuit".
        const tradeLeg = routeForShip(gameState.tradeRoutes ?? [], ship.id);
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
        // A rendezvous already draws this hull's whole course, meeting
        // and joined leg included, so the ordinary destination arc would
        // be a second line to the same place.
        // A matched hull flies the MATCH, not a transfer to the same
        // planet. Sampling the rendezvous here is what puts the sprite,
        // the click hit-test and the drawn line on one course — before
        // this the ship visibly flew its plain leg with the match arc
        // painted alongside, which is why it read as "he's just going to
        // Ganymede". He was.
        const rvPlan = ship.plannedRendezvous;
        const rvFollowed = rvPlan ? shipById2.get(rvPlan.followShipId) : undefined;
        const rvFollowedSamples = rvFollowed?.transit?.currentTransfer
          ? torchTrajectorySamples(rvFollowed.transit.currentTransfer, gameState.bodies)
          : null;
        const samples = rvPlan ? rendezvousTrajectorySamples(
          rvPlan,
          rvFollowedSamples && rvFollowedSamples.length >= 2
            ? (t: number) => torchPositionFromSamples(rvFollowedSamples, t)
            : null,
          rvFollowed?.transit?.currentTransfer?.arriveTick ?? null,
        ) : drawTorchTrajectory(
          plan, gameState.bodies, renderContext, arcColor,
          // Dashed when this leg belongs to a trade route — the
          // dash + green colour double-cue tells the player "this is
          // a recurring run" (vs a one-shot transfer, drawn solid in
          // the relationship colour). Useful for colourblind viewers
          // who can't lean on hue alone.
          !!tradeLeg,
          isSelected && !tradeLeg, renderTick(),
          // Lane offset: the returned samples are what the hull is lerped
          // along AND what the click hit-test reads below, so passing the
          // id here moves line, ship and hitbox together.
          ship.id,
        );
        ctx.restore();
        // Weapons-range ring for the hull you just clicked. BEFORE the ship
        // so the icon sits on top of its own bubble rather than inside a
        // line drawn over it.
        //
        // Gated on transitCombatEnabled: with transit combat off, ships
        // can't shoot in flight at all and the ring would promise a rule
        // that isn't running. Unarmed hulls get reach 0 and no ring.
        //
        // Reach comes from firingWindows.reachOf — the same helper the
        // intercept forecast uses — and like that forecast it passes
        // inSystem=false, so this is the OPEN-SPACE reach. Inside a
        // planet's SOI the server halves it; the client has no SOI test
        // yet, so the ring can read generous close to a world. Fixing that
        // means teaching both this and the forecast the same test, not
        // just this one.
        if (isSelected && ship.transit && gameState.transitCombatEnabled
            && samples && samples.length > 0) {
          drawTransitRangeRing(
            ship, renderContext,
            torchPositionFromSamples(samples, renderTick()),
            reachOf(ship.class, false),
          );
        }
        drawTransitShip(ship, renderContext, isSelected, samples, transitShipScale(camera.scale));
        // Cache the canvas position the renderer just drew at, so the
        // click hit-test uses the SAME polyline-lerped point (not the
        // diverging ship.transit.pos integration). Matches the lerp
        // drawTorchTransitShip does internally. See transitShipCanvasPosRef.
        if (samples && samples.length > 0) {
          const lerped = torchPositionFromSamples(samples, renderTick());
          const cp = worldToCanvas(lerped.x, lerped.y, renderContext);
          transitShipCanvasPosRef.current.set(ship.id, cp);
          // The WORLD-space twin of this point is NOT written here. It
          // feeds the fog pass, which runs before this loop and must not
          // depend on which ships this loop chose to draw — see the
          // rebuild at the top of the frame.
        }

        const arrivalBody = bodyById2.get(plan.targetBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, plan.arriveTick, renderContext);
        }

        // Queued chained legs — draw each as a faint dashed amber
        // preview so the player can see the full multi-leg plan at a
        // glance. The first queued leg starts at the current transit's
        // arrival; second leg starts at first's arrival; etc.
        //
        // YOUR plans only (Lorne). A queued leg is a statement of intent
        // rather than a thing happening, and drawing everyone's turned
        // the inner system into a lattice of dashes for journeys that
        // may never be flown. The live burn a rival is ON still draws —
        // that is a real ship in real flight, and losing it would be
        // losing intel rather than losing clutter.
        if (ship.queuedTransits && ship.ownedBy === 'player') {
          for (const queuedPlan of ship.queuedTransits) {
            drawTorchTrajectory(queuedPlan, gameState.bodies, renderContext, COLORS.fgDim, true);
            const qBody = bodyById2.get(queuedPlan.targetBodyId);
            if (qBody) drawGhostPlanet(qBody, queuedPlan.arriveTick, renderContext);
          }
        }
      } else if (ship.plannedTransit && ship.ownedBy === 'player') {
        // Ship parked but has a torch preview staged. Draw the parked
        // orbit + ship at its current location, plus a dashed amber
        // torch arc to the picked destination.
        if (showOrbitRing) {
          drawOrbitEllipse(
            ship.orbit, renderContext,
            isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
            isSelected ? 2 : 1,
            false,
            // Match the lane drawShip fans this hull out by, or the ring
            // draws under a ship that isn't on it.
            formation?.lane ?? 0,
          );
        }
        drawShip(ship, renderContext, isSelected, formation, orbitShipScale);
        if (isSelected) drawApsisMarkers(ship, renderContext, formation?.lane ?? 0);

        const previewColor = COLORS.maneuverPlanned;
        if (!ship.plannedRendezvous) {
          drawTorchTrajectory(ship.plannedTransit, gameState.bodies, renderContext, previewColor, true);
        }

        const arrivalBody = bodyById2.get(ship.plannedTransit!.targetBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.plannedTransit.arriveTick, renderContext);
        }
      } else {
        if (showOrbitRing) {
          drawOrbitEllipse(
            ship.orbit, renderContext,
            isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
            isSelected ? 2 : 1,
            false,
            formation?.lane ?? 0,
          );
        }
        drawShip(ship, renderContext, isSelected, formation, orbitShipScale);
        if (isSelected) drawApsisMarkers(ship, renderContext, formation?.lane ?? 0);
      }
      ctx.globalAlpha = prevShipAlpha;   // undo the crossfade-band fade
    }

    // Ship-count badges — two LOD tiers below the individual-ship zoom.
    // PER-BODY: when a planet's moons are still spread out on screen, a
    // badge up-right of each body, fading under the political wash. Once a
    // moon system shrinks to a tight smear (systemPx < SYSTEM_BADGE_MAX_PX)
    // it collapses to ONE SYSTEM badge at the planet — kept visible even
    // over the wash, since per-body would be an unreadable pile there.
    if (bodyClusters.size > 0 || systemTransitCounts.size > 0) {
      const c2d = ctx;
      // Seed the per-system aggregate with intra-system transit ships (moon-
      // to-moon hoppers collapsed in the ship loop above), then fold in the
      // parked per-body counts. Everything is per-faction now, so a badge
      // can split into one coloured segment per fleet owner.
      const foldInto = (dst: Map<string, number>, src: Map<string, number>) => {
        for (const [fid, n] of src) dst.set(fid, (dst.get(fid) ?? 0) + n);
      };
      const sysAgg = new Map<string, Map<string, number>>();
      for (const [anchor, counts] of systemTransitCounts) {
        const dst = new Map<string, number>();
        foldInto(dst, counts);
        sysAgg.set(anchor, dst);
      }
      const perBody: Array<{ bodyId: string; counts: Map<string, number> }> = [];
      for (const [bodyId, counts] of bodyClusters) {
        const anchor = anchorOf(bodyId) ?? bodyId;
        const hasMoons = (childrenOf2.get(anchor)?.length ?? 0) > 0;
        if (hasMoons && systemPx(anchor) < SYSTEM_BADGE_MAX_PX) {
          let cur = sysAgg.get(anchor);
          if (!cur) { cur = new Map(); sysAgg.set(anchor, cur); }
          foldInto(cur, counts);
        } else {
          perBody.push({ bodyId, counts });
        }
      }

      // Owner tones for a badge segment — the faction's TWO-tone livery
      // (§5): border in the primary (meaning), count text in a lightened
      // secondary (trim), same fallback rule the combat FX layer uses.
      const badgeTonesOf = (fid: string): { p: string; s: string; emblem: string | null } => {
        const f = gameState.factions.find(fa => fa.id === fid);
        const p = f?.color ?? (fid === 'player' ? COLORS.neutral : COLORS.danger);
        const s = f?.color2 || deriveSecondary(p);
        return { p, s, emblem: f?.emblem ?? null };
      };
      // Segment order: the viewer's fleet leads, then everyone else in a
      // stable id order so segments don't reshuffle frame to frame.
      const segOrder = (a: [string, number], b: [string, number]) => {
        if (a[0] === 'player') return -1;
        if (b[0] === 'player') return 1;
        return a[0] < b[0] ? -1 : 1;
      };

      // One pill PER FACTION present, laid out left-to-right with a small
      // gap — a mixed body reads as "▸3 ▸2" in the two fleets' own
      // colours instead of one amber "mixed" pill. Near-black fill keeps
      // the coloured border + count legible over the wash.
      // `id`/`ax`/`ay`/`anchorR` let the badge claim a collision-free slot
      // instead of always sitting at a fixed up-right offset — which is
      // why neighbouring bodies' badges piled onto each other in the
      // strategic screenshot. If nothing is free the badge is SKIPPED,
      // never stacked: an unreadable pile communicates less than absence.
      const drawBadge = (
        id: string, ax: number, ay: number, anchorR: number,
        counts: Map<string, number>, big: boolean, alpha: number,
      ) => {
        if (alpha <= 0.01 || counts.size === 0) return;
        // Viewport cull. Text was already culled inside the solver, but
        // badges were laid out and RESERVED for every ship-bearing body
        // in the game — an audit found badge:sedna reserved at x=-45193,
        // i.e. measured, slot-searched and occupancy-tested every frame
        // for something that can never be drawn. Off-screen reservations
        // also polluted the collision set. 120px margin keeps a badge
        // that's partly on-screen.
        if (ax < -120 || ay < -120
            || ax > c2d.canvas.width + 120 || ay > c2d.canvas.height + 120) return;
        const fs = big ? 15 : 13;
        const padX = 6, gap = 3;
        const pillH = fs + 8;
        c2d.save();
        c2d.globalAlpha = c2d.globalAlpha * alpha;
        // Concrete stack — canvas ctx.font ignores CSS var(), so the old
        // var(--font-mono,…) silently fell back to default sans-serif.
        c2d.font = `800 ${fs}px 'Audiowide', sans-serif`;
        c2d.textAlign = 'left';
        c2d.textBaseline = 'middle';
        const entries = [...counts.entries()].filter(([, n]) => n > 0).sort(segOrder);
        // Total width first, so the whole multi-faction strip is placed
        // as ONE box (placing segments individually would let a second
        // faction's pill land on another body's label).
        // The "▸" is a generic marker; the faction's EMBLEM in its place
        // says WHOSE fleet without a click, which is the one thing a
        // count alone can't tell you on a contested body.
        //
        // The mark slot is a FIXED width whether or not the raster has
        // loaded, and the ▸ fallback is centred inside it. Sizing the
        // slot to whichever mark happened to be ready measured a 1px
        // reflow the frame an image landed — invisible on one badge, but
        // every pill in a multi-faction strip shifts, and this box has
        // already been reserved with the collision solver at the old
        // width.
        const emblemPx = fs;
        let totalW = 0;
        for (const [, n] of entries) {
          totalW += emblemPx + c2d.measureText(String(n)).width + padX * 2 + gap;
        }
        totalW = Math.max(0, totalW - gap);
        // Pass the visible pill text so an overlap report can say WHAT
        // collided ("▸12 ▸3") instead of only which body it belonged to.
        const slot = reserveBox(id, ax, ay, anchorR, totalW, pillH,
          entries.map(([, n]) => `▸${n}`).join(' '));
        if (!slot) { c2d.restore(); return; }
        const cy = slot.y + pillH / 2;
        let x = slot.x;
        const anyCtx = c2d as any;
        for (const [fid, n] of entries) {
          const { p, s, emblem } = badgeTonesOf(fid);
          const count = String(n);
          const ink = lighten(s, 1.45);
          // Emblem tinted with the SAME ink as the count, so the pill
          // reads as one object rather than a coloured sticker beside a
          // number. Null while the raster loads (or for a faction with
          // no emblem) — the "▸" fallback keeps the badge complete.
          const img = getEmblemImage(emblem, p);
          const pillW = emblemPx + c2d.measureText(count).width + padX * 2;
          c2d.beginPath();
          if (typeof anyCtx.roundRect === 'function') anyCtx.roundRect(x, cy - pillH / 2, pillW, pillH, 5);
          else anyCtx.rect(x, cy - pillH / 2, pillW, pillH);
          c2d.fillStyle = 'rgba(4, 8, 14, 0.96)';
          c2d.fill();
          c2d.lineWidth = 2;
          c2d.strokeStyle = p;
          c2d.stroke();
          // Count in the lightened SECONDARY, so the segment carries the
          // faction's full two-tone livery (primary border, trim text).
          c2d.fillStyle = ink;
          if (img) {
            c2d.drawImage(img, x + padX, cy - emblemPx / 2, emblemPx, emblemPx);
          } else {
            // Centred in the same fixed slot the emblem will occupy.
            const aw = c2d.measureText('▸').width;
            c2d.fillText('▸', x + padX + (emblemPx - aw) / 2, cy + 0.5);
          }
          c2d.fillText(count, x + padX + emblemPx, cy + 0.5);
          x += pillW + gap;
        }
        c2d.restore();
      };

      // Per-body badges: alpha mirrors the sprite blend (1-sprBlend), so
      // a badge dissolves exactly as its system's hulls bleed in. They
      // do NOT duck under the region wash — this tier is the mid-zoom
      // read now, and a moonless body's badge IS its system badge all
      // the way out (per-world numbers survive until the smear collapse).
      for (const { bodyId, counts } of perBody) {
        const body = bodyById2.get(bodyId);
        if (!body) continue;
        const alpha = 1 - spriteBlendFor(bodyId);
        if (alpha <= 0.01) continue;
        const bp = bodyPosition(body, renderTick(), gameState.bodies);
        const cp = worldToCanvas(bp.x, bp.y, renderContext);
        const radius = Math.max(3, (body.radius ?? 4) * camera.scale);
        drawBadge(`badge:${bodyId}`, cp.x, cp.y, radius + 4, counts, false, alpha);
      }
      // System badges: visible even when the wash is full — that IS the read.
      for (const [anchorId, counts] of sysAgg) {
        const body = bodyById2.get(anchorId);
        if (!body) continue;
        const bp = bodyPosition(body, renderTick(), gameState.bodies);
        const cp = worldToCanvas(bp.x, bp.y, renderContext);
        const radius = Math.max(4, (body.radius ?? 5) * camera.scale);
        drawBadge(`sysbadge:${anchorId}`, cp.x, cp.y, radius + 5, counts, true, 1);
      }
    }

    // Draw fog-of-war ghosts for enemies currently out of sensor range but
    // recently seen. Their lastSeen position fades over GHOST_LIFETIME_TICKS.
    for (const [shipId, intel] of visibility.lastSeen) {
      if (visibleShipIds.has(shipId)) continue;
      drawShipGhost(intel, renderTick(), GHOST_LIFETIME_TICKS, gameState.factions, renderContext);
    }

    // Draw fleet bonds — faint lines connecting members of each fleet.
    // Skip invisible enemy ships so fleet structure doesn't leak through fog.
    for (const fleet of gameState.fleets) {
      if (fleet.shipIds.length < 2) continue;
      const positions: Array<{ x: number; y: number }> = [];
      for (const sid of fleet.shipIds) {
        const s = shipById2.get(sid);
        if (!s) continue;
        if (s.ownedBy !== 'player' && !visibleShipIds.has(s.id)) continue;
        // Same rule as the hover line: bond a fleet at the hulls, not at
        // their orbital elements. Six destroyers sharing a moon are fanned
        // around the ring by their formation offsets, so raw positions
        // drew a star of dashed lines through empty space near the planet.
        const wp = drawnPosOf(s);
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
      const body = bodyById2.get(settlement.bodyId);
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
        // Prefer where the hull was DRAWN — that is what the player is
        // looking at, and it already accounts for the cosmetic spin, the
        // formation fan and battle-line placement. The order used to be
        // the other way round, so a boom on a live ship played at its raw
        // orbital point: up to a full ring diameter from the hull it was
        // supposed to be attached to. The raw position stays as the
        // fallback for a hull this client has not drawn yet.
        let world: { x: number; y: number } | null = null;
        const shipEvent = !!fx.shipId;
        if (fx.shipId) {
          world = drawnShipWorldPos(fx.shipId) ?? null;
          if (!world) {
            const sh = shipById2.get(fx.shipId);
            if (sh) world = shipWorldPosition(sh, nowTick, gameState.bodies);
          }
        }
        if (!world && shipEvent && fx.kind === 'damage') {
          // A HIT on a hull this client has never rendered (a fogged
          // rival brawl — chronicle rows are public). A boom with no
          // visible target is exactly the "random explosion" bug; the
          // event log still carries the line. Never play it.
          return 'skip';
        }
        if (!world && fx.bodyId) {
          const b = bodyById2.get(fx.bodyId);
          if (b) {
            const bp = bodyPosition(b, nowTick, gameState.bodies);
            if (shipEvent) {
              // A ship died here but we never saw the hull. Place the
              // boom ON THE PARKING RING (radius + 2 — where ships
              // actually orbit), at an angle hashed from the entry id so
              // it's stable across frames. Dead center read as the WORLD
              // exploding.
              let h = 0;
              for (let ci = 0; ci < fx.id.length; ci++) h = (h * 31 + fx.id.charCodeAt(ci)) | 0;
              const ang = (h >>> 0) % 628 / 100;
              const ringR = (b.radius ?? 4) + 2;
              world = { x: bp.x + Math.cos(ang) * ringR, y: bp.y + Math.sin(ang) * ringR };
            } else {
              // Settlement/impact/discovery events genuinely belong to
              // the body itself.
              world = bp;
            }
          }
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
        if (fx.kind === 'discovery') {
          // Blooms at the body; re-located each frame so it rides the
          // body's orbit rather than a fixed canvas point. The VARIANT
          // comes off the body's revealed secret, so a cache spills gold
          // and a databank streams data instead of every find playing
          // the same purple flare.
          if (fx.bodyId) {
            const hit = bodyById2.get(fx.bodyId);
            spawnDiscoveryBloom(
              fx.id, fx.bodyId,
              discoveryVariantForSecret(hit?.secret?.kind),
            );
          }
          return;
        }
        if (fx.kind === 'damage') {
          // A hit, not a kill — same flash machinery at a much smaller
          // radius so "took fire" never reads as "died". This is the
          // queued twin of the live hp-drop flash: it plays when you
          // LOOK, so a battle fought while you were away still shows
          // its hits instead of only its corpses.
          const w = canvasToWorld(pos.x, pos.y, renderContext);
          destructionFlashesRef.current.set(fx.id, {
            pos: w, startMs: nowMs, baseRadius: 6, id: fx.id,
          });
          return;
        }
        // destruction / impact both read as an explosion; impacts are
        // bigger because a whole rock hit the surface.
        // A kill the player already WATCHED (list-diff flashed it at the
        // hull) must not boom a second time from the chronicle queue —
        // that double-tap was half the "random explosions" report.
        if (fx.shipId && listDiffFlashedShipsRef.current.has(fx.shipId)) return;
        const world = canvasToWorld(pos.x, pos.y, renderContext);
        destructionFlashesRef.current.set(fx.id, {
          pos: world,
          startMs: nowMs,
          baseRadius: fx.kind === 'impact' ? 22 : 12,
          id: fx.id,
        });
        // AND LEAVE A WRECK. This is why the map never had any.
        //
        // A death reaches the renderer two ways: the list-diff above
        // (you were watching the hull disappear from /state) and this
        // chronicle queue (drainVisibleFx replays it when you next LOOK).
        // spawnWreck lived only in the first. With ticks an hour apart,
        // almost every kill in the game arrives by this path instead —
        // 12 hulls detonating at Midas while you were elsewhere is the
        // normal case, not the exception — so wrecks were spawned almost
        // never, which reads exactly like the feature not existing.
        //
        // The hull is already gone from /state, so its class comes from
        // the last frame that saw it alive; a frigate is the middle of
        // the range when even that has aged out.
        if (fx.kind === 'destruction' && fx.shipId) {
          const deadCls = prevShipIdsRef.current.get(fx.shipId)?.cls ?? 'frigate';
          spawnWreck(fx.shipId, world, shipIconSize(deadCls, false), nowMs, nowTick);
        }
      },
    );

    // LIGHTWEIGHT MODE skips the whole combat FX layer. These are the
    // most animated things on the map — per-frame bolts, sustained fire,
    // debris, blooms — and the first thing to go when a phone cannot
    // hold a frame. What survives is every piece of state they dress:
    // the FIRING label, hp bars, arrears and damage numbers. You lose
    // the fireworks, not the fight.
    if (!isLightweight()) {
      drawTracers(renderContext, gameState.ships, gameState.settlements, nowMs, transitShipCanvasPosRef.current);
      // Sustained fire while an engagement is live. One-shot tracers alone
      // are unwatchable on real tick intervals (30s–1h per tick), so this
      // carries the firefight between volleys. Settlements participate on
      // both ends: stations/cities visibly return fire, and bombarding
      // ships visibly pound them.
      drawEngagementFire(
        renderContext, gameState.ships, gameState.settlements, nowMs, nowTick,
        transitShipCanvasPosRef.current, gameState.pactPairs,
        gameState.transitCombatEnabled,
      );
    }
    // RENDEZVOUS PREVIEW. Drawn after the fleet so the arc and its
    // meeting marker sit above the hulls rather than under them, and
    // outside the per-ship branch above because the ship staging it may
    // be parked, in transit, or off-screen entirely — the useful subject
    // is the MEETING, not the hull.
    for (const ship of gameState.ships) {
      const rv = ship.plannedRendezvous;
      if (!rv) continue;
      // A RIVAL'S MATCH IS DRAWN TOO. Gating this to your own hulls meant
      // an enemy rendezvous had its plain arc suppressed by the layers
      // above and nothing drawn in its place: a sprite riding a course
      // with no line, or worse, the wrong one. Their manoeuvre is also
      // the single most useful thing on the map to see — a hostile
      // converging on your freighter — so it is drawn in the role colour
      // and without the meeting label, which is your planning aid rather
      // than intelligence you have earned.
      const isMine = ship.ownedBy === 'player';
      if (!isMine && !visibleShipIds.has(ship.id)) continue;   // fog still applies
      const followed = gameState.ships.find(s => s.id === rv.followShipId);
      // Their side of the convergence, from the SAME polyline the
      // renderer draws their hull along.
      //
      // Sampled ONCE, outside the callback. It was inside — and
      // drawRendezvousPreview invokes the callback ~48 times a frame, so
      // every frame re-integrated their entire trajectory 48 times over
      // to draw one dashed line.
      const followedSamples = followed?.transit?.currentTransfer
        ? torchTrajectorySamples(followed.transit.currentTransfer, gameState.bodies)
        : null;
      const theirPath = followedSamples && followedSamples.length >= 2
        ? (t: number) => torchPositionFromSamples(followedSamples, t)
        : null;
      drawRendezvousPreview(
        rv, theirPath, renderContext,
        (isMine && followed) ? `MEET ${followed.name} · T+${Math.round(rv.meetTick)}` : undefined,
        followed?.transit?.currentTransfer?.arriveTick ?? null,
        renderTick(),
      );
    }

    // Persistent battle damage: fire + smoke linger on anything hit
    // within the last tick (and on crippled hulls), so "damage was
    // taken" reads at a glance — the tick-instant flash alone is a
    // blink nobody catches at 1h/tick. Ignition staggers per ship.
    if (!isLightweight()) {
      drawBattleDamageStates(
        renderContext, gameState.ships, gameState.settlements, nowMs,
        transitShipCanvasPosRef.current,
      );
      drawDetonations(renderContext, nowMs);
      drawDiscoveryBlooms(renderContext, nowMs);
    }
    // ---- ALL TEXT, LAST, ON TOP ----
    // One placement pass for every label requested this frame. Drawn
    // after the world so a sprite can never occlude text (the Uranus
    // deep-zoom shot had hulls sitting over body names), and wrapped so
    // a solver fault can degrade to "no labels" instead of corrupting
    // the canvas transform for every subsequent frame.
    if (!isLightweight()) drawArrivalFlashes(renderContext, gameState.ships, nowMs);
    try {
      flushLabels(ctx, renderContext.camera.scale, ctx.canvas.width, ctx.canvas.height);
    } catch (e) {
      console.error('label solver failed', e);
    }

    // Shift-click group markers. Without these the group is invisible —
    // the panel would know about it and the map wouldn't. Reads the same
    // hitboxes the click test uses (with pickShipAt's identical fallback
    // for ships the main pass hasn't boxed yet) so the ring lands exactly
    // where a click would register.
    {
      const groupIds = uiState.selectedShipIds;
      if (groupIds && groupIds.length > 0) {
        const c = renderContext.ctx;
        c.save();
        c.strokeStyle = '#ffb84d';
        c.lineWidth = 2;
        c.setLineDash([4, 3]);
        const dashPhase = (nowMs / 60) % 7;   // slow crawl so it reads as "live"
        c.lineDashOffset = -dashPhase;
        for (const id of groupIds) {
          const ship = gameState.ships.find(s => s.id === id);
          if (!ship) continue;
          const hb = shipHitboxesRef.current.get(id);
          let x: number, y: number, r: number;
          if (hb) {
            x = hb.x; y = hb.y; r = hb.r + 4;
          } else {
            const cached = ship.transit ? transitShipCanvasPosRef.current.get(id) : undefined;
            // renderContext.camera, NOT the raw camera prop: this is a
            // DRAW pass, so the ring has to use the same eased/offset
            // camera the frame is being painted with or it lands away
            // from the hull it is meant to circle.
            const p = cached ?? getShipCanvasPos(ship, c.canvas, gameState.bodies, renderContext.camera, nowTick);
            if (!p) continue;
            x = p.x; y = p.y; r = (ship.transit ? 20 : 14) + 4;
          }
          c.beginPath();
          c.arc(x, y, r, 0, Math.PI * 2);
          c.stroke();
        }
        c.restore();
      }
    }

    // Fog-of-war: paint the dim wash and punch holes where the
    // player's sensors reach. The dim↔bright transition is its own
    // boundary — no separate outline pass needed.
    {
      const rings = factionSensorRings(
        'player',
        gameState.ships,
        gameState.settlements,
        gameState.bodies,
        renderTick(),
        alliedSet,
        transitShipWorldPosRef.current,
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
        const deltaX = (e.clientX - panState.startX) * renderScaleRef.current;
        const deltaY = (e.clientY - panState.startY) * renderScaleRef.current;
        const newCamX = panState.camX - deltaX / camera.scale;
        const newCamY = panState.camY - deltaY / camera.scale;
        directUpdateCamera({ x: newCamX, y: newCamY });
      }
    },
    [panState, camera.scale, directUpdateCamera]
  );

  /** Canvas-space centre of a ship, using the same sources (and the same
   *  fallback order) the click hit-test uses so box-select agrees with
   *  what a click would have grabbed. */
  const shipCanvasPoint = useCallback(
    (ship: Ship): { x: number; y: number } | null => {
      const hb = shipHitboxesRef.current.get(ship.id);
      if (hb) return { x: hb.x, y: hb.y };
      const cached = ship.transit ? transitShipCanvasPosRef.current.get(ship.id) : undefined;
      if (cached) return cached;
      if (!canvasRef.current) return null;
      return getShipCanvasPos(ship, canvasRef.current, gameState.bodies, hitCam(), renderTick());
    },
    [gameState.bodies, hitCam, renderTick],
  );

  /** Finalize a drag box: every OWN ship whose centre falls inside wins.
   *  Plain drag replaces the group (dragging empty space clears it, the
   *  usual RTS meaning); shift/meta-drag adds to it. */
  const commitBoxSelection = useCallback(
    (c0x: number, c0y: number, c1x: number, c1y: number, additive: boolean) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const s = renderScaleRef.current;
      const toCanvas = (cx: number, cy: number) => ({
        x: (cx - rect.left) * s,
        y: (cy - rect.top) * s,
      });
      const a = toCanvas(c0x, c0y);
      const b = toCanvas(c1x, c1y);
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

      const caught: string[] = [];
      for (const ship of gameState.ships) {
        if (ship.ownedBy !== 'player') continue;   // same rule as shift-click
        const p = shipCanvasPoint(ship);
        if (!p) continue;
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) caught.push(ship.id);
      }

      if (additive) {
        const merged = new Set(uiState.selectedShipIds ?? []);
        for (const id of caught) merged.add(id);
        setShipSelection(Array.from(merged));
      } else {
        setShipSelection(caught);
      }
    },
    [gameState.ships, shipCanvasPoint, uiState.selectedShipIds, setShipSelection],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Clear any suppress flag left over from a drag that ended OFF the
    // canvas: that mouseup fires (window listener) but no click follows,
    // so without this reset the stale flag would swallow the next real
    // click. Every click is preceded by a mousedown, so resetting here
    // is always safe and always early enough.
    suppressClickRef.current = false;
    // Left button drags a selection box. Panning is on the RIGHT button
    // (below), so the two gestures never contend. Listeners go on the
    // WINDOW, not the canvas, so releasing off-canvas still finalizes
    // instead of leaving a box stuck to the cursor.
    if (e.button === 0 && !uiState.targetSelectionMode) {
      const startX = e.clientX;
      const startY = e.clientY;
      const additive = e.shiftKey || e.metaKey;
      let dragging = false;
      const onMove = (ev: MouseEvent) => {
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > BOX_DRAG_THRESHOLD_PX) {
          dragging = true;
        }
        if (dragging) setBoxSel({ x0: startX, y0: startY, x1: ev.clientX, y1: ev.clientY });
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setBoxSel(null);
        if (!dragging) return;             // a plain click — let onClick handle it
        suppressClickRef.current = true;
        commitBoxSelection(startX, startY, ev.clientX, ev.clientY, additive);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return;
    }
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
          const pos = bodyPosition(focused, renderTick(), gameState.bodies);
          startCamX = pos.x;
          startCamY = pos.y;
        }
        directUpdateCamera({ x: startCamX, y: startCamY, focusedBodyId: undefined });
      }
      setPanState({ startX: e.clientX, startY: e.clientY, camX: startCamX, camY: startCamY });
    }
  }, [camera, gameState.bodies, renderTick, uiState.targetSelectionMode, setTargetSelectionMode, directUpdateCamera, commitBoxSelection]);

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
      const mouseX = (e.clientX - rect.left) * renderScaleRef.current;
      const mouseY = (e.clientY - rect.top) * renderScaleRef.current;
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
      //
      // World menu (MP only): the cap comes from the store, which reports
      // the historical 50 unless the MP overlay is active over a focused
      // body (diving into a menu needs ~130 for small worlds). SP:
      // permanently 50, byte-identical behavior.
      const newScale = Math.max(0.0012, Math.min(getWorldMenuMaxScale(), camera.scale * factor));
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
        // Read the camera from the REF, never the closure. The old code
        // did `camera.x + step` off the captured value, so every frame
        // recomputed the same destination from the same stale origin —
        // and because the effect depended on camera.x/y/scale, producing
        // that frame immediately tore the loop down and rebuilt it with
        // an empty heldKeys and a null lastTime (dt = 0 → zero movement).
        // What survived was one sub-pixel nudge per OS key-repeat, which
        // is the "moves one pixel at a time" players reported.
        const cam = cameraRef.current;
        // RELEASE FOCUS PROPERLY BEFORE PANNING.
        //
        // While a body is focused the renderer centres on that body and
        // camera.x/y are pinned to (0,0) — they're an offset, not a
        // position. Panning from those raw zeros while dropping the focus
        // flag put the camera at world origin, which IS the Sun. That is
        // the documented trap in gameContext.focusBody(undefined), and
        // four call sites had already hand-rolled the same compensation.
        // Use the shared helper instead of writing a fifth copy.
        const base = releaseFocusPosition(cam, bodiesRef.current, renderTickRef.current());
        // On-screen pixels per second → world units, so the pan feels the
        // same speed at every zoom level.
        const worldStep = (PAN_PIXELS_PER_SEC * dt) / cam.scale;
        directUpdateCamera({
          x: base.x + dx * worldStep,
          y: base.y + dy * worldStep,
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
    // Deliberately NOT camera.x/y/scale. Those change on every frame this
    // loop produces, so listing them made the pan cancel its own rAF and
    // drop every held key the moment it started working — the loop could
    // never survive long enough to build up motion. The camera is read
    // from cameraRef instead, which is always current without
    // re-subscribing.
  }, [directUpdateCamera]);

  // Ship under a canvas point, or null. The CLOSEST hit wins, so a
  // fanned-out formation selects the hull nearest the cursor rather than
  // whichever happened to be first in the array. Reads the renderer's
  // recorded hit boxes (drawShip) — the exact drawn position + a
  // sprite-covering radius — so the box is always over the visible hull.
  // Ships not drawn this frame (in transit, fog-hidden, first frame)
  // fall back to the transit cache / recomputed position.
  //
  // padTouch: coarse-pointer devices pad the radius so fingers land;
  // a mouse hover passes false for precision.
  const pickShipAt = useCallback(
    (canvasX: number, canvasY: number, padTouch: boolean): string | null => {
      const pad = padTouch ? TOUCH_HIT_PADDING : 0;
      let best: string | null = null;
      let bestD = Infinity;
      for (const ship of gameState.ships) {
        let x: number, y: number, r: number;
        const hb = shipHitboxesRef.current.get(ship.id);
        if (hb) {
          x = hb.x; y = hb.y; r = hb.r + pad;
        } else {
          const cached = ship.transit ? transitShipCanvasPosRef.current.get(ship.id) : undefined;
          const p = cached ?? getShipCanvasPos(ship, canvasRef.current!, gameState.bodies, hitCam(), renderTick());
          if (!p) continue;
          x = p.x; y = p.y; r = (ship.transit ? 20 : 14) + pad;
        }
        const d = Math.hypot(canvasX - x, canvasY - y);
        if (d <= r && d < bestD) { best = ship.id; bestD = d; }
      }
      return best;
    },
    [gameState.ships, gameState.bodies, hitCam, renderTick],
  );

  // Shared tap/click logic — called by both the mouse onClick handler and
  // the touch-input layer. Hit radii are padded on coarse-pointer devices
  // (mobile/tablet) so fingers can reliably grab ships and bodies.
  const handleTapAt = useCallback(
    (canvasX: number, canvasY: number, additive = false) => {
      if (!canvasRef.current) return;

      if (uiState.targetSelectionMode) {
        const hc = hitCam();
        // NEAREST wins, matching the hover highlight exactly — so the
        // world lit up under the crosshair is the world you get. First
        // -in-array made a close-orbiting moon unpickable whenever its
        // planet's padded box happened to cover it.
        let pickId: string | null = null;
        let pickDist = Infinity;
        for (const body of gameState.bodies) {
          // Sol is a valid target — see the matching note in the
          // target-highlight render loop above. Removing both gates
          // unblocks pick-via-map for Sol (the panel-driven Dyson
          // transfer already worked via a different code path).
          const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, hc, renderTick());
          const clickRadius = Math.max(12, body.radius! * hc.scale + 8) + TOUCH_HIT_PADDING;
          const d = Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y);
          if (d < clickRadius && d < pickDist) {
            pickDist = d;
            pickId = body.id;
          }
        }
        if (pickId) {
          window.dispatchEvent(new CustomEvent('orbital-transfer-confirm', {
            detail: { bodyId: pickId },
          }));
        }
        return;
      }

      const hitShip = pickShipAt(canvasX, canvasY, true);
      if (hitShip) {
        // Shift+click builds a group. Own hulls only — you can't give
        // orders to someone else's ship, and silently collecting them
        // would make the count lie about what a group order will touch.
        if (additive) {
          const s = gameState.ships.find(sh => sh.id === hitShip);
          if (s && s.ownedBy === 'player') toggleShipSelection(hitShip);
          return;
        }
        // Plain click on a hull = "just this one" (RTS convention), so
        // the group resets here rather than inside selectShip — see the
        // note there about not coupling focus to selection.
        clearShipSelection();
        selectShip(hitShip);
        return;
      }

      const hcBody = hitCam();
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, hcBody, renderTick());
        // A revealed gate draws far bigger than the rock it replaced, so
        // the hit target follows the RING — otherwise you'd be aiming at a
        // 3px moon inside a 40px sprite. Mirrors drawWarpGateBody's R.
        const clickRadius = Math.max(8, gateAwareRadius(body, hcBody.scale) + 5) + TOUCH_HIT_PADDING;
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
          // PICKING A ROUTE STOP takes the click before anything else.
          // Falling through to selectBody would dive the camera into
          // that world's menu on the way to adding a stop, which is the
          // opposite of staying oriented while building a circuit.
          // offerPick consumes the click even for an INELIGIBLE body:
          // clicking a rock you cannot ship from should do nothing at
          // all rather than quietly select it.
          if (isRoutePicking()) {
            // Everything under the cursor, not just the first match:
            // at system zoom a moon system is one smudge, and picking
            // whichever body happened to sort first is a coin toss.
            const hits: string[] = [];
            for (const b2 of gameState.bodies) {
              const p2 = getBodyCanvasPos(b2, canvasRef.current, gameState.bodies, hcBody, renderTick());
              const r2 = Math.max(8, gateAwareRadius(b2, hcBody.scale) + 5) + TOUCH_HIT_PADDING;
              if (Math.hypot(canvasX - p2.x, canvasY - p2.y) < r2) hits.push(b2.id);
            }
            if (offerPickCluster(hits.length > 0 ? hits : [body.id])) return;
          }
          // Shift+click a world while a group is selected = "everyone go
          // there". Handled by the group bar (which owns the transfer
          // hook and the result summary) so this stays a pure event.
          if (additive && (uiState.selectedShipIds?.length ?? 0) > 0) {
            window.dispatchEvent(new CustomEvent('orbital:group-move', {
              detail: { bodyId: body.id },
            }));
            return;
          }
          // Body click PRESERVES the group on purpose: inspecting a world
          // while holding a selection is the natural lead-in to sending
          // them there (look at it, then shift-click to commit).
          selectBody(body.id);
          return;
        }
      }

      // Empty space: a plain click drops everything, including the
      // group. Shift+click on nothing leaves the group intact — an
      // errant miss while collecting ships shouldn't undo the work.
      if (additive) return;
      deselectShip();
      deselectBody();
      clearShipSelection();
    },
    [gameState, hitCam, uiState.targetSelectionMode, uiState.selectedShipIds, selectShip, selectBody, deselectShip, deselectBody, renderTick, pickShipAt, toggleShipSelection, clearShipSelection]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      // The click that closes a drag-box must not also run the tap logic:
      // a box released over empty space would otherwise clear the very
      // selection it just made.
      if (suppressClickRef.current) { suppressClickRef.current = false; return; }
      const rect = canvasRef.current.getBoundingClientRect();
      handleTapAt(
        (e.clientX - rect.left) * renderScaleRef.current,
        (e.clientY - rect.top) * renderScaleRef.current,
        // metaKey too so the gesture matches the platform convention on
        // Mac; the touch path never sets either and keeps single-select.
        e.shiftKey || e.metaKey,
      );
    },
    [handleTapAt]
  );

  const handleMouseHover = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left) * renderScaleRef.current;
      const canvasY = (e.clientY - rect.top) * renderScaleRef.current;

      // Ship hover drives the name label. Same boxes the click hit-test
      // uses, so a label appears exactly where a click would land — no
      // touch padding: a mouse is precise, and padding here would pop
      // labels for ships the cursor isn't really over. Ships take
      // priority over bodies, matching the click order.
      hoveredShipIdRef.current = pickShipAt(canvasX, canvasY, false);

      // Target-mode aiming uses a hit box padded to match the click
      // test, so the highlight you see IS the thing a click will take.
      // Plain browsing keeps the tight box (a mouse is precise, and a
      // fat box pops labels for worlds the cursor isn't over).
      const hcHover = hitCam();
      const aiming = uiState.targetSelectionMode;
      let hoveredBodyId: string | null = null;
      let bestDist = Infinity;
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, hcHover, renderTick());
        const hoverRadius = aiming
          ? Math.max(12, body.radius! * hcHover.scale + 8) + TOUCH_HIT_PADDING
          : Math.max(8, body.radius! * hcHover.scale + 5);
        const d = Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y);
        // NEAREST wins, not first-in-array: a moon tucked inside its
        // planet's padded box used to be unreachable purely because the
        // planet came first in gameState.bodies.
        if (d < hoverRadius && d < bestDist) {
          bestDist = d;
          hoveredBodyId = body.id;
        }
      }
      hoverBody(hoveredBodyId);
    },
    [gameState, hitCam, uiState.targetSelectionMode, hoverBody, renderTick, pickShipAt]
  );

  // Shared focus-on-tap logic — called by both onDoubleClick and the
  // touch input layer's double-tap.
  const handleFocusAt = useCallback(
    (canvasX: number, canvasY: number) => {
      if (uiState.targetSelectionMode) return;
      if (!canvasRef.current) return;
      const hcBody = hitCam();
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, hcBody, renderTick());
        // A revealed gate draws far bigger than the rock it replaced, so
        // the hit target follows the RING — otherwise you'd be aiming at a
        // 3px moon inside a 40px sprite. Mirrors drawWarpGateBody's R.
        const clickRadius = Math.max(8, gateAwareRadius(body, hcBody.scale) + 5) + TOUCH_HIT_PADDING;
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
          focusBody(body.id);
          return;
        }
      }
      focusBody(undefined);
    },
    [gameState, hitCam, focusBody, uiState.targetSelectionMode, renderTick]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      handleFocusAt(
        (e.clientX - rect.left) * renderScaleRef.current,
        (e.clientY - rect.top) * renderScaleRef.current,
      );
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
      return bodyPosition(focused, renderTick(), gameState.bodies);
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
    // Synchronous draw benchmark for A/B-ing render changes from the
    // console: __benchDraw(60) -> mean ms/draw. Works even in a
    // backgrounded tab (no rAF involved).
    (window as unknown as { __benchDraw?: (n?: number) => number }).__benchDraw = (n = 60) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) renderRef.current();
      return (performance.now() - t0) / n;
    };
    let frameCount = 0;
    // FRAME GOVERNOR. iOS players report the map "real crunchy" and
    // crashing outright once a planet has more than about five ships
    // around it. This loop redraws the WHOLE map on every display frame,
    // which is correct for continuously-animated FX and ruinous on a
    // phone: a 6000-line 2D renderer at 60fps saturates the main thread,
    // Safari thermally throttles, then kills the tab.
    //
    // Adaptive RESOLUTION is the other half of the answer and is disabled
    // above for a documented reason (it scaled the backing store while
    // this renderer draws in backing-store pixels). Frame RATE is the
    // half that can be fixed safely today, because it touches no geometry
    // and therefore cannot cause that class of bug at all: halving the
    // frames halves the work with zero risk of anything changing size.
    //
    // Desktop keeps every frame. Phones get 30fps, which for an orbital
    // strategy map is indistinguishable in feel and half the cost.
    const isPhone = typeof window !== 'undefined'
      && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
      && Math.min(window.innerWidth, window.innerHeight) < 900;
    // Lightweight halves the phone cap again. Read per frame, not
    // captured once, so flipping the toggle takes effect immediately
    // instead of on the next remount.
    const baseMinFrameMs = isPhone ? 1000 / 30 : 0;
    const frameBudget = () => (isLightweight()
      ? Math.max(baseMinFrameMs, LIGHTWEIGHT_MIN_FRAME_MS)
      : baseMinFrameMs);
    let lastDrawAt = 0;
    const loop = () => {
      // Adaptive resolution: evaluate every ~90 frames on the rolling
      // frame-time EMA. Hysteresis (down under 18fps, up over 45) so it
      // never oscillates. Floor 0.55 - below that text becomes mush.
      // ADAPTIVE RESOLUTION IS DISABLED — it magnified instead of
      // degrading, and it has never done anything else.
      //
      // The down-step shrank the BACKING STORE while CSS size stayed
      // fixed, so the browser stretched the smaller bitmap back over the
      // same box. Nothing compensated: this renderer draws in
      // BACKING-STORE pixels (21 reads of canvas.width, HUD text at a
      // literal 12px, world offsets straight off camera.scale), so at
      // q=0.55 every planet, ship and label came out ~1.8x too big and
      // blurry — reported as "everything but the UX is getting bigger
      // every couple of seconds". Couple of seconds = this very check,
      // 90 frames at 60fps.
      //
      // It stayed invisible because it only fires when frames are slow,
      // and frames only got slow today. The up-step was wrong in the same
      // way, so it could not even undo itself.
      //
      // NOT a one-line fix: doing this properly means drawing in LOGICAL
      // (CSS) pixels — setTransform(q,0,0,q,0,0) plus a logical viewW/
      // viewH on RenderContext for those 21 sites, and dropping the
      // *renderScale conversion from all ten pointer handlers, which
      // currently convert CSS -> backing to match. Until that refactor,
      // full resolution is the only correct setting.
      //
      // The frame-time EMA below is untouched: perf.frameMs is still
      // measured and still visible in the HUD, which is what the
      // slow-frame investigation needs.
      if (++frameCount % 90 === 0 && canvasRef.current) {
        const cv = canvasRef.current;
        // Self-heal: an older session may have left the backing store
        // shrunk. Restore 1:1 and leave renderScaleRef at 1 so the
        // pointer handlers' conversion stays a no-op.
        if (cv.width !== width || cv.height !== height) {
          renderScaleRef.current = 1;
          cv.style.width = `${width}px`;
          cv.style.height = `${height}px`;
          cv.width = width;
          cv.height = height;
        }
      }
      // Time the draw itself: frame INTERVAL alone can't tell "our canvas
      // work is heavy" from "something else stalled the main thread".
      const t0 = performance.now();
      const minFrameMs = frameBudget();
      if (minFrameMs && t0 - lastDrawAt < minFrameMs) {
        raf = requestAnimationFrame(loop);
        return;
      }
      lastDrawAt = t0;
      try {
        renderRef.current();
      } catch (e) {
        // A mid-frame exception must never poison canvas state: an
        // unbalanced save() or leftover transform COMPOUNDS on later
        // frames (the chase-FX incident: every frame re-scaled until the
        // map was giant). Reset the transform and keep the loop alive.
        console.error('render frame failed', e);
        const c = canvasRef.current?.getContext('2d');
        if (c) c.setTransform(1, 0, 0, 1, 0, 0);
      }
      perf.recordDraw(performance.now() - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf != null) cancelAnimationFrame(raf); };
  }, [width, height]);

  return (
    <>
    {/* Drag-box rubber band. Fixed-position in client coords so it needs
        no positioned ancestor and never participates in canvas layout;
        pointerEvents none so it can't eat the mouseup that ends it. */}
    {boxSel && (
      <div
        style={{
          position: 'fixed',
          left: Math.min(boxSel.x0, boxSel.x1),
          top: Math.min(boxSel.y0, boxSel.y1),
          width: Math.abs(boxSel.x1 - boxSel.x0),
          height: Math.abs(boxSel.y1 - boxSel.y0),
          border: '1px solid #ffb84d',
          background: 'rgba(255, 184, 77, 0.10)',
          pointerEvents: 'none',
          zIndex: 55,
        }}
      />
    )}
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
    </>
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
    // Mirror drawShip EXACTLY: the parent body is placed at the render
    // tick `t`, but the ship's angle around it uses the cosmetic spin
    // (shipDisplayTick). Positioning the parent at the spun time too —
    // which orbitWorldPos(ship.orbit, spunTime) would do — drifts the
    // box by however far the parent moved over the spin offset. This is
    // only the fallback for ships the renderer didn't record this frame;
    // the primary path reads drawShip's exact recorded box.
    const { bodyPosition, localPositionAt } = require('../physics/orbitalMechanics');
    const parent = bodies.find(b => b.id === ship.orbit?.parentBodyId);
    const parentPos = parent ? bodyPosition(parent, t, bodies) : { x: 0, y: 0 };
    const local = localPositionAt(ship.orbit, shipDisplayTick(t, ship.orbit?.period, Date.now()));
    pos = { x: parentPos.x + local.x, y: parentPos.y + local.y };
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
  ctx.ctx.font = '12px "Audiowide", monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';
  ctx.ctx.fillText(`Tick: ${ctx.t.toFixed(1)} | ${speedLabel}`, 16, 16);
  ctx.ctx.fillText(`Scale: ${ctx.camera.scale.toFixed(2)}x`, 16, 32);

  ctx.ctx.fillStyle = COLORS.fgFaint;
  ctx.ctx.font = '10px "Audiowide", monospace';
  // Hint changes by input modality — desktop hotkeys are wrong on a
  // touch device, so don't tell a phone player to "right-drag."
  const hint = isCoarsePointer()
    ? 'Drag: pan · Pinch: zoom · Tap: select · Double-tap: focus'
    : 'Right-drag: pan | Scroll: zoom | Click: select | Double-click: focus';
  ctx.ctx.fillText(hint, 16, ctx.canvas.height - 32);

  if (targetSelectionMode) {
    ctx.ctx.fillStyle = COLORS.warning;
    ctx.ctx.font = 'bold 12px "Audiowide", monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.fillText('SELECT TARGET BODY', ctx.canvas.width / 2, 16);
    ctx.ctx.fillStyle = COLORS.fgDim;
    ctx.ctx.font = '10px "Audiowide", monospace';
    ctx.ctx.fillText('Click a body to transfer | ESC to cancel | Right-click to cancel', ctx.canvas.width / 2, 32);
  }

  if (ctx.camera.focusedBodyId) {
    const focusedBody = ctx.bodies.find(b => b.id === ctx.camera.focusedBodyId);
    if (focusedBody) {
      ctx.ctx.fillStyle = COLORS.info;
      ctx.ctx.font = 'bold 12px "Audiowide", monospace';
      ctx.ctx.textAlign = 'center';
      ctx.ctx.fillText(`FOCUSED: ${focusedBody.name.toUpperCase()}`, ctx.canvas.width / 2, targetSelectionMode ? 52 : 32);
      ctx.ctx.fillStyle = COLORS.fgDim;
      ctx.ctx.font = '10px "Audiowide", monospace';
      ctx.ctx.fillText(`SOI: ${focusedBody.soi.toFixed(0)} km`, ctx.canvas.width / 2, targetSelectionMode ? 68 : 48);
    }
  }

  ctx.ctx.textAlign = 'right';
  ctx.ctx.fillText(`v0.3 · ${GIT_SHA.slice(0,7)}`, ctx.canvas.width - 16, ctx.canvas.height - 16);
}
