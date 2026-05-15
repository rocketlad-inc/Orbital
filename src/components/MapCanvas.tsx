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
  generateStarfield,
  drawStarfield,
  StarfieldCache,
  worldToCanvas,
  RenderContext,
} from '../render/mapRenderer';
import { bezierPositionAt } from '../physics/bezierTransfer';
import { bodyPosition } from '../physics/orbitalMechanics';
import { COLORS, withOpacity } from '../render/colors';
import { shipWorldPosition } from '../game/combat';
import './MapCanvas.css';

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

    const renderContext: RenderContext = {
      ctx,
      canvas: canvasRef.current,
      camera: { x: camX, y: camY, scale: camera.scale, focusedBodyId: camera.focusedBodyId },
      t: gameState.currentTick,
      bodies: gameState.bodies,
      simSpeed,
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

    // Draw bodies
    for (const body of gameState.bodies) {
      const isSelected = uiState.selectedBodyId === body.id;
      const isHovered = uiState.hoveredBodyId === body.id;
      drawBody(body, renderContext, isSelected, isHovered);
    }

    // Draw ships
    for (const ship of gameState.ships) {
      const isSelected = uiState.selectedShipId === ship.id;

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
        drawShip(ship, renderContext, isSelected);
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
        drawShip(ship, renderContext, isSelected);
        if (isSelected) drawApsisMarkers(ship, renderContext);
      }
    }

    // Draw fleet bonds — faint lines connecting members of each fleet
    for (const fleet of gameState.fleets) {
      if (fleet.shipIds.length < 2) continue;
      const positions: Array<{ x: number; y: number }> = [];
      for (const sid of fleet.shipIds) {
        const s = gameState.ships.find(sh => sh.id === sid);
        if (!s) continue;
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
  }, [gameState, camera, uiState, simSpeed, selectedSettlementId]);

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
      setPanState({ startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y });
    }
  }, [camera, uiState.targetSelectionMode, setTargetSelectionMode]);

  const handleMouseUp = useCallback(() => {
    setPanState(null);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
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
    },
    [camera.x, camera.y, camera.scale, updateCamera]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      if (uiState.targetSelectionMode) {
        for (const body of gameState.bodies) {
          if (body.id === 'sol') continue;
          const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
          const clickRadius = Math.max(12, body.radius! * camera.scale + 8);
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
        if (Math.hypot(canvasX - shipPos.x, canvasY - shipPos.y) < 10) {
          selectShip(ship.id);
          return;
        }
      }

      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const clickRadius = Math.max(8, body.radius! * camera.scale + 5);
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

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (uiState.targetSelectionMode) return;
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      for (const body of gameState.bodies) {
        const bodyPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const clickRadius = Math.max(8, body.radius! * camera.scale + 5);
        if (Math.hypot(canvasX - bodyPos.x, canvasY - bodyPos.y) < clickRadius) {
          focusBody(body.id);
          return;
        }
      }
      focusBody(undefined);
    },
    [gameState, camera, focusBody, uiState.targetSelectionMode]
  );

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
      onWheel={handleWheel}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className="map-canvas"
      style={{ cursor: uiState.targetSelectionMode ? 'crosshair' : undefined }}
    />
  );
};

function getBodyCanvasPos(
  body: any, canvas: HTMLCanvasElement, bodies: any[], camera: any, t: number
): { x: number; y: number } {
  const { bodyPosition } = require('../physics/orbitalMechanics');
  const pos = bodyPosition(body, t, bodies);
  return {
    x: canvas.width / 2 + (pos.x - camera.x) * camera.scale,
    y: canvas.height / 2 + (pos.y - camera.y) * camera.scale,
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
  return {
    x: canvas.width / 2 + (pos.x - camera.x) * camera.scale,
    y: canvas.height / 2 + (pos.y - camera.y) * camera.scale,
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
