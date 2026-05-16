import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  clearCanvas,
  drawOrbit,
  drawBody,
  drawShip,
  drawOrbitEllipse,
  drawSOIBoundary,
  drawApsisMarkers,
  drawBezierTrajectory,
  drawTransitShip,
  drawDepartureMarker,
  drawGhostPlanet,
  drawTargetHighlight,
  drawSettlement,
  drawShipGhost,
  drawSensorRing,
  generateStarfield,
  drawStarfield,
  StarfieldCache,
  GhostIntel,
  worldToCanvas,
  RenderContext,
} from '../render/mapRenderer';
import { bezierPositionAt } from '../physics/bezierTransfer';
import { bodyPosition } from '../physics/orbitalMechanics';
import { COLORS, withOpacity } from '../render/colors';
import { shipWorldPosition } from '../game/combat';
import { computeIncomingThreats, threatenedBodyIds } from '../game/threats';
import { computeVisibility, factionSensorRings, GHOST_LIFETIME_TICKS } from '../game/visibility';
import { useCanvasTouchInput } from '../hooks/useCanvasTouchInput';
import { isCoarsePointer } from '../hooks/useIsMobile';
import './MapCanvas.css';

/** Extra hit-radius padding when the primary input is touch. Apple/Material
 *  guidelines recommend ~44px tap targets; we widen the click radius rather
 *  than enlarge the rendered icon. */
const TOUCH_HIT_PADDING = isCoarsePointer() ? 16 : 0;

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

  // Damage flash bookkeeping. Two refs:
  //   prevDamageTick   — last lastDamagedTick value we saw per entity
  //   damageFlashStart — performance.now() when we first observed that tick
  // Each frame we walk ships + settlements; when lastDamagedTick changes
  // for an id, we stamp a fresh wall-clock time. The renderer reads the
  // stamp via RenderContext.damageFlashStart and fades the halo over
  // DAMAGE_FLASH_DURATION_MS regardless of sim speed.
  const prevDamageTickRef = useRef<Map<string, number>>(new Map());
  const damageFlashStartRef = useRef<Map<string, number>>(new Map());

  // Sensor coverage ring overlay toggle (V key)
  const [showSensorRings, setShowSensorRings] = useState(false);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'v' || e.key === 'V') setShowSensorRings(s => !s);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
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

    // === Damage flash bookkeeping ===
    // Walk every ship + settlement; whenever an entity's lastDamagedTick
    // differs from what we remembered last frame, stamp a fresh
    // wall-clock time. The renderer fades the halo from there.
    const nowMs = performance.now();
    for (const ship of gameState.ships) {
      const cur = ship.lastDamagedTick;
      if (cur === undefined) continue;
      const prev = prevDamageTickRef.current.get(ship.id);
      if (prev !== cur) {
        prevDamageTickRef.current.set(ship.id, cur);
        damageFlashStartRef.current.set(ship.id, nowMs);
      }
    }
    for (const settlement of gameState.settlements) {
      const cur = settlement.lastDamagedTick;
      if (cur === undefined) continue;
      const prev = prevDamageTickRef.current.get(settlement.id);
      if (prev !== cur) {
        prevDamageTickRef.current.set(settlement.id, cur);
        damageFlashStartRef.current.set(settlement.id, nowMs);
      }
    }

    const renderContext: RenderContext = {
      ctx,
      canvas: canvasRef.current,
      camera: { x: camX, y: camY, scale: camera.scale, focusedBodyId: camera.focusedBodyId },
      t: gameState.currentTick,
      bodies: gameState.bodies,
      simSpeed,
      damageFlashStart: damageFlashStartRef.current,
      nowMs,
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

    // Draw orbits for all bodies
    for (const body of gameState.bodies) {
      if (body.parent) {
        drawOrbit(body, renderContext, withOpacity(body.color, 0.35));
      }
    }

    // Draw SOI boundaries
    for (const body of gameState.bodies) {
      if (body.type === 'star') continue;
      drawSOIBoundary(body, renderContext);
    }

    // Draw target selection highlights
    if (uiState.targetSelectionMode) {
      for (const body of gameState.bodies) {
        if (body.id === 'sol') continue;
        const isHovered = uiState.hoveredBodyId === body.id;
        drawTargetHighlight(body, renderContext, isHovered);
      }

      // Draw dashed line from selected ship to hovered body
      if (uiState.hoveredBodyId && uiState.selectedShipId) {
        const ship = gameState.ships.find(s => s.id === uiState.selectedShipId);
        const hovBody = gameState.bodies.find(b => b.id === uiState.hoveredBodyId);
        if (ship && hovBody) {
          let shipWorldPos;
          if (ship.transfer) {
            shipWorldPos = bezierPositionAt(ship.transfer, gameState.currentTick);
          } else {
            const { orbitWorldPos } = require('../physics/orbitalMechanics');
            shipWorldPos = orbitWorldPos(ship.orbit, gameState.currentTick, gameState.bodies);
          }
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
    const visibility = computeVisibility(
      'player',
      gameState.ships,
      gameState.settlements,
      gameState.bodies,
      gameState.currentTick,
      lastSeenRef.current,
    );
    lastSeenRef.current = visibility.lastSeen;
    const visibleShipIds = visibility.visibleShipIds;

    // Compute threats (hostile transits targeting player-owned bodies) —
    // but only include threats from ships the player can actually see.
    const allThreats = computeIncomingThreats(gameState, 'player');
    const threats = allThreats.filter(t => visibleShipIds.has(t.attackerShipId));
    const threatBodies = threatenedBodyIds(threats);

    // Sensor coverage rings (V to toggle)
    if (showSensorRings) {
      const rings = factionSensorRings(
        'player',
        gameState.ships,
        gameState.settlements,
        gameState.bodies,
        gameState.currentTick,
      );
      for (const r of rings) {
        drawSensorRing(r.pos, r.range, r.sourceType, renderContext);
      }
    }

    // Draw bodies
    for (const body of gameState.bodies) {
      const isSelected = uiState.selectedBodyId === body.id;
      const isHovered = uiState.hoveredBodyId === body.id;
      drawBody(body, renderContext, isSelected, isHovered);

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
    // transit follow their Bezier arc and don't stack.
    const formationMap = new Map<string, { index: number; total: number }>();
    {
      const buckets = new Map<string, string[]>();
      for (const s of gameState.ships) {
        if (s.transfer) continue;
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

    // Draw ships
    for (const ship of gameState.ships) {
      // Fog of war: skip enemy ships the player can't currently see
      if (ship.ownedBy !== 'player' && !visibleShipIds.has(ship.id)) continue;

      const isSelected = uiState.selectedShipId === ship.id;
      const formation = formationMap.get(ship.id);

      if (ship.transfer) {
        drawBezierTrajectory(ship.transfer, renderContext, COLORS.arcTransfer, false);
        drawTransitShip(ship, renderContext, isSelected);

        const arrivalBody = gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.transfer.arrivalTime, gameState.currentTick, renderContext);
        }

        if (ship.queuedTransfers) {
          for (const qt of ship.queuedTransfers) {
            drawBezierTrajectory(qt, renderContext, COLORS.fgDim, true);
            const qtArrBody = gameState.bodies.find(b => b.id === qt.arrivalBodyId);
            if (qtArrBody) {
              drawGhostPlanet(qtArrBody, qt.arrivalTime, gameState.currentTick, renderContext);
            }
          }
        }
      } else if (ship.pendingTransfer) {
        drawOrbitEllipse(
          ship.orbit, renderContext,
          isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
          isSelected ? 2 : 1
        );
        drawShip(ship, renderContext, isSelected, formation);
        if (isSelected) drawApsisMarkers(ship, renderContext);

        const nodeColor = ship.orders.some(o => o.type === 'transfer' && o.status === 'committed')
          ? COLORS.maneuverCommitted
          : COLORS.maneuverPlanned;
        drawBezierTrajectory(ship.pendingTransfer, renderContext, nodeColor, true);

        const arrivalBody = gameState.bodies.find(b => b.id === ship.pendingTransfer!.arrivalBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.pendingTransfer.arrivalTime, gameState.currentTick, renderContext);
        }

        if (isSelected) {
          drawDepartureMarker(ship.pendingTransfer, gameState.currentTick, renderContext, nodeColor);
        }

        if (ship.queuedTransfers) {
          for (const qt of ship.queuedTransfers) {
            drawBezierTrajectory(qt, renderContext, COLORS.fgDim, true);
            const qtArrBody = gameState.bodies.find(b => b.id === qt.arrivalBodyId);
            if (qtArrBody) {
              drawGhostPlanet(qtArrBody, qt.arrivalTime, gameState.currentTick, renderContext);
            }
          }
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

    drawHUD(renderContext, uiState.targetSelectionMode);
  }, [gameState, camera, uiState, simSpeed, selectedSettlementId, showSensorRings]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      if (panState) {
        const deltaX = e.clientX - panState.startX;
        const deltaY = e.clientY - panState.startY;
        const newCamX = panState.camX - deltaX / camera.scale;
        const newCamY = panState.camY - deltaY / camera.scale;
        updateCamera({ x: newCamX, y: newCamY });
      }
    },
    [panState, camera.scale, updateCamera]
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
        updateCamera({ x: startCamX, y: startCamY, focusedBodyId: undefined });
      }
      setPanState({ startX: e.clientX, startY: e.clientY, camX: startCamX, camY: startCamY });
    }
  }, [camera, gameState.bodies, gameState.currentTick, uiState.targetSelectionMode, setTargetSelectionMode, updateCamera]);

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
      const newScale = Math.max(0.005, Math.min(50, camera.scale * factor));
      const newCamX = worldBeforeX - (mouseX - canvas.width / 2) / newScale;
      const newCamY = worldBeforeY - (mouseY - canvas.height / 2) / newScale;
      updateCamera({ x: newCamX, y: newCamY, scale: newScale });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [camera.x, camera.y, camera.scale, updateCamera]);

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
        updateCamera({
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
  }, [camera.x, camera.y, camera.scale, updateCamera]);

  // Shared tap/click logic — called by both the mouse onClick handler and
  // the touch-input layer. Hit radii are padded on coarse-pointer devices
  // (mobile/tablet) so fingers can reliably grab ships and bodies.
  const handleTapAt = useCallback(
    (canvasX: number, canvasY: number) => {
      if (!canvasRef.current) return;

      if (uiState.targetSelectionMode) {
        for (const body of gameState.bodies) {
          if (body.id === 'sol') continue;
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
        const shipPos = getShipCanvasPos(ship, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        if (Math.hypot(canvasX - shipPos.x, canvasY - shipPos.y) < 10 + TOUCH_HIT_PADDING) {
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
    updateCamera,
    onTap: handleTapAt,
    onDoubleTap: handleFocusAt,
  });

  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(() => { if (!cancelled) render(); });
    const fallback = setTimeout(() => { if (!cancelled) render(); }, 32);
    return () => { cancelled = true; cancelAnimationFrame(frame); clearTimeout(fallback); };
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onMouseMove={(e) => { handleMouseMove(e); handleMouseHover(e); }}
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
  if (ship.transfer) {
    pos = bezierPositionAt(ship.transfer, t);
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
  ctx.ctx.fillText('Right-drag: pan | Scroll: zoom | Click: select | Double-click: focus', 16, ctx.canvas.height - 32);

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
  ctx.ctx.fillText('v0.2.0-bezier', ctx.canvas.width - 16, ctx.canvas.height - 16);
}
