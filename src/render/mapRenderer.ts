// ============================================================
// Map Canvas Rendering - Draw the orbital system
// ============================================================

import { Body, Ship, OrbitElements, TrajectoryArc } from '../types';
import { bodyPosition, localPositionAt, semiMajor, eccentricity } from '../physics/orbitalMechanics';
import { COLORS } from './colors';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  camera: { x: number; y: number; scale: number; focusedBodyId?: string };
  t: number;
  bodies: Body[];
}

/**
 * Convert world coordinates to canvas coordinates
 */
export function worldToCanvas(
  worldX: number,
  worldY: number,
  ctx: RenderContext
): { x: number; y: number } {
  const canvasX = ctx.canvas.width / 2 + (worldX - ctx.camera.x) * ctx.camera.scale;
  const canvasY = ctx.canvas.height / 2 + (worldY - ctx.camera.y) * ctx.camera.scale;
  return { x: canvasX, y: canvasY };
}

/**
 * Convert canvas coordinates to world coordinates
 */
export function canvasToWorld(
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
): { x: number; y: number } {
  const worldX = ctx.camera.x + (canvasX - ctx.canvas.width / 2) / ctx.camera.scale;
  const worldY = ctx.camera.y + (canvasY - ctx.canvas.height / 2) / ctx.camera.scale;
  return { x: worldX, y: worldY };
}

/**
 * Clear canvas and fill with background
 */
export function clearCanvas(ctx: RenderContext) {
  ctx.ctx.fillStyle = COLORS.bg;
  ctx.ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * Draw a subtle grid pattern
 */
function drawGrid(ctx: RenderContext) {
  const gridSize = 50;
  const gridColor = COLORS.bgGrid;

  ctx.ctx.strokeStyle = gridColor;
  ctx.ctx.lineWidth = 0.5;

  // Get world coordinates of canvas corners
  const topLeft = canvasToWorld(0, 0, ctx);
  const bottomRight = canvasToWorld(ctx.canvas.width, ctx.canvas.height, ctx);

  const minWorldX = Math.floor(topLeft.x / gridSize) * gridSize;
  const maxWorldX = Math.ceil(bottomRight.x / gridSize) * gridSize;
  const minWorldY = Math.floor(topLeft.y / gridSize) * gridSize;
  const maxWorldY = Math.ceil(bottomRight.y / gridSize) * gridSize;

  // Draw vertical lines
  for (let x = minWorldX; x <= maxWorldX; x += gridSize) {
    const canvasPos = worldToCanvas(x, 0, ctx);
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(canvasPos.x, 0);
    ctx.ctx.lineTo(canvasPos.x, ctx.canvas.height);
    ctx.ctx.stroke();
  }

  // Draw horizontal lines
  for (let y = minWorldY; y <= maxWorldY; y += gridSize) {
    const canvasPos = worldToCanvas(0, y, ctx);
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(0, canvasPos.y);
    ctx.ctx.lineTo(ctx.canvas.width, canvasPos.y);
    ctx.ctx.stroke();
  }
}

/**
 * Draw orbital path for a body
 */
export function drawOrbit(
  body: Body,
  ctx: RenderContext,
  color: string = COLORS.orbitTrajectory,
  width: number = 1
) {
  if (!body.parent) return; // Can't draw orbit for star

  const parentBody = ctx.bodies.find(b => b.id === body.parent);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  const canvasParentPos = worldToCanvas(parentPos.x, parentPos.y, ctx);

  const radius = body.orbitRadius * ctx.camera.scale;

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = width;
  ctx.ctx.beginPath();
  ctx.ctx.arc(
    canvasParentPos.x,
    canvasParentPos.y,
    radius,
    0,
    Math.PI * 2
  );
  ctx.ctx.stroke();
}

/**
 * Draw orbital path for an orbit (ellipse)
 */
export function drawOrbitEllipse(
  orbit: OrbitElements,
  ctx: RenderContext,
  color: string = COLORS.orbitTrajectory,
  width: number = 1,
  isDashed: boolean = false
) {
  const parentBody = ctx.bodies.find(b => b.id === orbit.parentBodyId);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  worldToCanvas(parentPos.x, parentPos.y, ctx);

  const a = semiMajor(orbit);
  const e = eccentricity(orbit);
  const b = a * Math.sqrt(1 - e * e);

  if (isDashed) {
    ctx.ctx.setLineDash([5, 5]);
  }

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = width;
  ctx.ctx.beginPath();

  // Draw ellipse using parametric form
  const steps = 100;
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    // Ellipse point in local coordinates
    const localX = a * cosTheta;
    const localY = b * sinTheta;

    // Rotate by omega and translate
    const rotX = localX * Math.cos(orbit.omega) - localY * Math.sin(orbit.omega);
    const rotY = localX * Math.sin(orbit.omega) + localY * Math.cos(orbit.omega);

    const worldX = parentPos.x + rotX;
    const worldY = parentPos.y + rotY;
    const canvasPos = worldToCanvas(worldX, worldY, ctx);

    if (i === 0) {
      ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
    } else {
      ctx.ctx.lineTo(canvasPos.x, canvasPos.y);
    }
  }

  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);
}

/**
 * Draw a celestial body (circle with label)
 */
export function drawBody(
  body: Body,
  ctx: RenderContext,
  isSelected: boolean = false,
  isHovered: boolean = false
) {
  const pos = bodyPosition(body, ctx.t, ctx.bodies);
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);

  const radius = Math.max(3, body.radius * ctx.camera.scale);

  // Draw body circle
  ctx.ctx.fillStyle = body.color || COLORS.planetDefault;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Draw selection/hover ring
  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 2;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, radius + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
  } else if (isHovered) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, radius + 3, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }

  // Draw label at larger zoom
  if (ctx.camera.scale > 0.5) {
    ctx.ctx.fillStyle = COLORS.fg;
    ctx.ctx.font = '11px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'top';
    ctx.ctx.fillText(body.name, canvasPos.x, canvasPos.y + radius + 8);
  }
}

/**
 * Draw a ship on its orbit
 */
export function drawShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean = false
) {
  const parentBody = ctx.bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  const localPos = localPositionAt(ship.orbit, ctx.t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  // Get faction color
  const factionColor = COLORS.playerFriendly; // TODO: get from faction

  // Draw ship as small triangle
  const shipSize = 4;
  ctx.ctx.fillStyle = factionColor;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, shipSize, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Draw selection indicator
  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 2;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, shipSize + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }

  // Draw label at higher zoom
  if (ctx.camera.scale > 1) {
    ctx.ctx.fillStyle = COLORS.fg;
    ctx.ctx.font = '9px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'bottom';
    ctx.ctx.fillText(ship.name, canvasPos.x, canvasPos.y - 8);
  }
}

/**
 * Draw resource panel for a body
 */
export function drawResourcePanel(
  body: Body,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
) {
  if (!body.resources) return;

  const padding = 8;
  const lineHeight = 14;
  const textSize = 11;
  const panelWidth = 100;
  const panelHeight = lineHeight * 3 + padding * 2;

  // Draw panel background
  ctx.ctx.fillStyle = COLORS.panelBg;
  ctx.ctx.fillRect(canvasX, canvasY, panelWidth, panelHeight);

  ctx.ctx.strokeStyle = COLORS.panelBorder;
  ctx.ctx.lineWidth = 1;
  ctx.ctx.strokeRect(canvasX, canvasY, panelWidth, panelHeight);

  // Draw resources
  ctx.ctx.fillStyle = COLORS.fgDim;
  ctx.ctx.font = `${textSize}px monospace`;
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';

  const labels = ['Fuel', 'Gold', 'Metal', 'Sci'];
  const values = [
    body.resources.fuel,
    body.resources.gold,
    body.resources.metal,
    body.resources.science,
  ];

  for (let i = 0; i < labels.length; i++) {
    const y = canvasY + padding + i * lineHeight;
    const label = labels[i];
    const value = values[i];
    ctx.ctx.fillText(`${label}: ${value}`, canvasX + padding, y);
  }
}

/**
 * Draw text label on canvas
 */
export function drawText(
  text: string,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext,
  color: string = COLORS.fg,
  fontSize: number = 12,
  align: CanvasTextAlign = 'left'
) {
  ctx.ctx.fillStyle = color;
  ctx.ctx.font = `${fontSize}px monospace`;
  ctx.ctx.textAlign = align;
  ctx.ctx.textBaseline = 'top';
  ctx.ctx.fillText(text, canvasX, canvasY);
}

/**
 * Draw a complete trajectory (sequence of arcs through SOIs)
 * Shows projected path with color indicating status
 */
export function drawTrajectory(
  arcs: TrajectoryArc[],
  ctx: RenderContext,
  color: string = COLORS.maneuverPlanned,
  isDashed: boolean = false
) {
  if (arcs.length === 0) return;

  if (isDashed) {
    ctx.ctx.setLineDash([5, 5]);
  }

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = 1.5;

  for (const arc of arcs) {
    const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
    if (!parentBody) continue;

    const parentPos = bodyPosition(parentBody, arc.tStart, ctx.bodies);

    // Draw the arc as a sequence of line segments
    const steps = 50;
    let isFirstPoint = true;

    for (let i = 0; i <= steps; i++) {
      const t = arc.tStart + (arc.tEnd - arc.tStart) * (i / steps);
      const localPos = localPositionAt(arc.orbit, t);
      const worldX = parentPos.x + localPos.x;
      const worldY = parentPos.y + localPos.y;
      const canvasPos = worldToCanvas(worldX, worldY, ctx);

      if (isFirstPoint) {
        ctx.ctx.beginPath();
        ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
        isFirstPoint = false;
      } else {
        ctx.ctx.lineTo(canvasPos.x, canvasPos.y);
      }
    }

    ctx.ctx.stroke();
  }

  ctx.ctx.setLineDash([]);
}

/**
 * Draw maneuver node marker at a specific position on an arc
 */
export function drawManeuverNode(
  t: number,
  arc: TrajectoryArc,
  ctx: RenderContext,
  color: string = COLORS.info,
  size: number = 6
) {
  const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
  if (!parentBody || t < arc.tStart || t > arc.tEnd) return;

  const parentPos = bodyPosition(parentBody, arc.tStart, ctx.bodies);
  const localPos = localPositionAt(arc.orbit, t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  // Draw cross marker for maneuver node
  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = 2;
  ctx.ctx.beginPath();
  ctx.ctx.moveTo(canvasPos.x - size, canvasPos.y);
  ctx.ctx.lineTo(canvasPos.x + size, canvasPos.y);
  ctx.ctx.moveTo(canvasPos.x, canvasPos.y - size);
  ctx.ctx.lineTo(canvasPos.x, canvasPos.y + size);
  ctx.ctx.stroke();
}
