// ============================================================
// MapCanvas - Main orbital system visualization
// ============================================================

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  clearCanvas,
  drawOrbit,
  drawBody,
  drawShip,
  drawOrbitEllipse,
  drawTrajectory,
  drawManeuverNode,
  RenderContext,
} from '../render/mapRenderer';
import { computeTrajectory } from '../physics/orbitalMechanics';
import { COLORS } from '../render/colors';
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
  const { gameState, camera, uiState, updateCamera, selectShip, selectBody, hoverBody } =
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
      camera: { x: camera.x, y: camera.y, scale: camera.scale },
      t: gameState.currentTick,
      bodies: gameState.bodies,
    };

    // Clear and draw background
    clearCanvas(renderContext);

    // Draw orbits for all bodies
    for (const body of gameState.bodies) {
      if (body.parent) {
        drawOrbit(body, renderContext);
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
      drawShip(ship, renderContext, isSelected);
    }

    // Draw trajectories and maneuver nodes if ship is selected
    if (uiState.selectedShipId) {
      const ship = gameState.ships.find(s => s.id === uiState.selectedShipId);
      if (ship) {
        // Convert orders to node format for trajectory computation
        const nodes = ship.orders.map(order => ({
          t: order.burnTime,
          dv: order.deltav,
        }));

        // Compute trajectory through current orbit and planned maneuvers
        if (nodes.length > 0) {
          const trajectory = computeTrajectory(
            ship.orbit,
            nodes,
            gameState.currentTick,
            gameState.bodies
          );

          // Draw trajectory
          for (const arc of trajectory) {
            const color =
              ship.orders.some(
                order =>
                  order.burnTime >= arc.tStart &&
                  order.burnTime <= arc.tEnd &&
                  order.status === 'committed'
              )
                ? COLORS.maneuverCommitted
                : COLORS.maneuverPlanned;
            const isDashed =
              !ship.orders.some(
                order =>
                  order.burnTime >= arc.tStart &&
                  order.burnTime <= arc.tEnd &&
                  order.status === 'committed'
              );
            drawTrajectory([arc], renderContext, color, isDashed);
          }

          // Draw maneuver node markers
          for (const order of ship.orders) {
            const arcWithNode = trajectory.find(
              arc => order.burnTime >= arc.tStart && order.burnTime <= arc.tEnd
            );
            if (arcWithNode) {
              const color =
                order.status === 'committed'
                  ? COLORS.maneuverCommitted
                  : COLORS.maneuverPlanned;
              drawManeuverNode(order.burnTime, arcWithNode, renderContext, color, 6);
            }
          }
        } else if (ship.orders.length > 0) {
          // If we have orders but no nodes set up yet, show post-burn orbits
          for (const order of ship.orders) {
            if (order.postOrbit) {
              const color =
                order.status === 'committed'
                  ? COLORS.maneuverCommitted
                  : COLORS.maneuverPlanned;
              const isDashed = order.status !== 'committed';
              drawOrbitEllipse(order.postOrbit, renderContext, color, 1.5, isDashed);
            }
          }
        }
      }
    }

    // Draw HUD
    drawHUD(renderContext);
  }, [gameState, camera, uiState]);

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
      // Right-click: start pan
      setPanState({
        startX: e.clientX,
        startY: e.clientY,
        camX: camera.x,
        camY: camera.y,
      });
    }
  }, [camera]);

  const handleMouseUp = useCallback(() => {
    setPanState(null);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1;
      const newScale = Math.max(0.1, Math.min(10, camera.scale * (1 + direction * 0.1)));
      updateCamera({ scale: newScale });
    },
    [camera.scale, updateCamera]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;

      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Check for ship clicks
      for (const ship of gameState.ships) {
        const shipCanvasPos = getShipCanvasPos(ship, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const dist = Math.hypot(canvasX - shipCanvasPos.x, canvasY - shipCanvasPos.y);
        if (dist < 10) {
          selectShip(ship.id);
          return;
        }
      }

      // Check for body clicks
      for (const body of gameState.bodies) {
        const bodyCanvasPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const dist = Math.hypot(canvasX - bodyCanvasPos.x, canvasY - bodyCanvasPos.y);
        const clickRadius = Math.max(8, body.radius! * camera.scale + 5);
        if (dist < clickRadius) {
          selectBody(body.id);
          return;
        }
      }

      // Deselect if clicking empty space
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

      // Check for body hovers
      for (const body of gameState.bodies) {
        const bodyCanvasPos = getBodyCanvasPos(body, canvasRef.current, gameState.bodies, camera, gameState.currentTick);
        const dist = Math.hypot(canvasX - bodyCanvasPos.x, canvasY - bodyCanvasPos.y);
        const hoverRadius = Math.max(8, body.radius! * camera.scale + 5);
        if (dist < hoverRadius) {
          hoveredBodyId = body.id;
          break;
        }
      }

      hoverBody(hoveredBodyId);
    },
    [gameState, camera, hoverBody]
  );

  // Render loop
  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      render();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onMouseMove={(e) => {
        handleMouseMove(e);
        handleMouseHover(e);
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={handleWheel}
      onClick={handleClick}
      className="map-canvas"
    />
  );
};

/**
 * Helper to get canvas position of a body
 */
function getBodyCanvasPos(
  body: any,
  canvas: HTMLCanvasElement,
  bodies: any[],
  camera: any,
  t: number
): { x: number; y: number } {
  // Import the physics function to get world position
  const { bodyPosition } = require('../physics/orbitalMechanics');
  const pos = bodyPosition(body, t, bodies);
  const canvasX = canvas.width / 2 + (pos.x - camera.x) * camera.scale;
  const canvasY = canvas.height / 2 + (pos.y - camera.y) * camera.scale;
  return { x: canvasX, y: canvasY };
}

/**
 * Helper to get canvas position of a ship
 */
function getShipCanvasPos(
  ship: any,
  canvas: HTMLCanvasElement,
  bodies: any[],
  camera: any,
  t: number
): { x: number; y: number } {
  // Import the physics function to get world position
  const { orbitWorldPos } = require('../physics/orbitalMechanics');
  const pos = orbitWorldPos(ship.orbit, t, bodies);
  const canvasX = canvas.width / 2 + (pos.x - camera.x) * camera.scale;
  const canvasY = canvas.height / 2 + (pos.y - camera.y) * camera.scale;
  return { x: canvasX, y: canvasY };
}

/**
 * Draw HUD overlays
 */
function drawHUD(ctx: RenderContext) {
  // Draw tick counter
  ctx.ctx.fillStyle = COLORS.fgDim;
  ctx.ctx.font = '12px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';
  ctx.ctx.fillText(`Tick: ${ctx.t.toFixed(1)}`, 16, 16);

  // Draw zoom level
  ctx.ctx.fillText(`Scale: ${ctx.camera.scale.toFixed(2)}x`, 16, 32);

  // Draw help text
  ctx.ctx.fillStyle = COLORS.fgFaint;
  ctx.ctx.font = '10px monospace';
  ctx.ctx.fillText('Right-drag: pan | Scroll: zoom | Click: select', 16, ctx.canvas.height - 32);

  // Draw version
  ctx.ctx.textAlign = 'right';
  ctx.ctx.fillText('v0.1.0', ctx.canvas.width - 16, ctx.canvas.height - 16);
}
