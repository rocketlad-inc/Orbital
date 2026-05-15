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
  RenderContext,
} from '../render/mapRenderer';
import { bezierPositionAt } from '../physics/bezierTransfer';
import { COLORS, withOpacity } from '../render/colors';
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
  const { gameState, camera, uiState, simSpeed, updateCamera, selectShip, selectBody, hoverBody, focusBody } =
    useGameContext();

  const [panState, setPanState] = useState<{
    startX: number;
    startY: number;
    camX: number;
    camY: number;
  } | null>(null);

  const render = useCallback(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const renderContext: RenderContext = {
      ctx,
      canvas: canvasRef.current,
      camera: { x: camera.x, y: camera.y, scale: camera.scale, focusedBodyId: camera.focusedBodyId },
      t: gameState.currentTick,
      bodies: gameState.bodies,
      simSpeed,
    };

    clearCanvas(renderContext);

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
        // Ship is in transit — draw Bezier trajectory and transit ship
        drawBezierTrajectory(ship.transfer, renderContext, COLORS.arcTransfer, false);
        drawTransitShip(ship, renderContext, isSelected);

        // Ghost planet at arrival
        const arrivalBody = gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.transfer.arrivalTime, gameState.currentTick, renderContext);
        }
      } else if (ship.pendingTransfer) {
        // Ship has a planned transfer — draw orbit + preview
        drawOrbitEllipse(
          ship.orbit, renderContext,
          isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
          isSelected ? 2 : 1
        );
        drawShip(ship, renderContext, isSelected);
        if (isSelected) drawApsisMarkers(ship, renderContext);

        // Dashed preview of Bezier transfer
        const nodeColor = ship.orders.some(o => o.type === 'transfer' && o.status === 'committed')
          ? COLORS.maneuverCommitted
          : COLORS.maneuverPlanned;
        drawBezierTrajectory(ship.pendingTransfer, renderContext, nodeColor, true);

        // Ghost planet at arrival
        const arrivalBody = gameState.bodies.find(b => b.id === ship.pendingTransfer!.arrivalBodyId);
        if (arrivalBody) {
          drawGhostPlanet(arrivalBody, ship.pendingTransfer.arrivalTime, gameState.currentTick, renderContext);
        }

        // Departure marker
        if (isSelected) {
          drawDepartureMarker(ship.pendingTransfer, gameState.currentTick, renderContext, nodeColor);
        }
      } else {
        // Normal orbiting ship
        drawOrbitEllipse(
          ship.orbit, renderContext,
          isSelected ? COLORS.orbitCurrent : COLORS.orbitTrajectory,
          isSelected ? 2 : 1
        );
        drawShip(ship, renderContext, isSelected);
        if (isSelected) drawApsisMarkers(ship, renderContext);
      }
    }

    drawHUD(renderContext);
  }, [gameState, camera, uiState, simSpeed]);

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
      setPanState({ startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y });
    }
  }, [camera]);

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

      selectShip('');
      selectBody('');
    },
    [gameState, camera, selectShip, selectBody]
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
    [gameState, camera, focusBody]
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

function drawHUD(ctx: RenderContext) {
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

  if (ctx.camera.focusedBodyId) {
    const focusedBody = ctx.bodies.find(b => b.id === ctx.camera.focusedBodyId);
    if (focusedBody) {
      ctx.ctx.fillStyle = COLORS.info;
      ctx.ctx.font = 'bold 12px monospace';
      ctx.ctx.textAlign = 'center';
      ctx.ctx.fillText(`FOCUSED: ${focusedBody.name.toUpperCase()}`, ctx.canvas.width / 2, 32);
      ctx.ctx.fillStyle = COLORS.fgDim;
      ctx.ctx.font = '10px monospace';
      ctx.ctx.fillText(`SOI: ${focusedBody.soi.toFixed(0)} km`, ctx.canvas.width / 2, 48);
    }
  }

  ctx.ctx.textAlign = 'right';
  ctx.ctx.fillText('v0.2.0-bezier', ctx.canvas.width - 16, ctx.canvas.height - 16);
}
