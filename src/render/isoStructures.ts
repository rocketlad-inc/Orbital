// ============================================================
// isoStructures — isometric building art for the body-focus zoom.
//
// Pure vector, zero image assets. Everything is composed from one
// primitive: an isometric prism (3 quads — top face light, left mid,
// right dark). Each building kind gets a distinct silhouette on top
// of that primitive so the skyline reads at a glance:
//
//   forge     tall stack + chimney with an ember glow
//   mint      dome on a block
//   lab       thin mast + dish
//   thrusters angled nozzle cluster (asteroid TT)
//   weapons   twin barrels off the station hub
//   shipyard  open scaffold dock (+ hull silhouette while building)
//
// Building LEVEL = taller prism + extra blocks, so investing in a
// settlement literally grows its skyline.
//
// Coordinate contract:
//   drawCityCluster  — caller translates to the surface anchor and
//                      rotates so LOCAL -y points along the outward
//                      surface normal. Ground plane is y≈0.
//   drawStationStructure — caller translates to the station's canvas
//                      position; drawn upright, centered on origin.
//
// Perf: a full cluster is ~30–60 path fills and only renders for the
// one or two bodies at focus zoom. No gradients, no shadows.
// ============================================================

import { Settlement, BuildingKind } from '../types';
import { buildingLevel } from '../game/settlements';

// Shared metal palette — factions are distinguished by the pad edge,
// not the buildings, so clusters stay visually coherent.
const TOP = '#9fd8d1';
const LEFT = '#4e8f88';
const RIGHT = '#35625d';
const DOME = '#c8ebe6';
const GLOW = '#ffb84d';
const PAD = '#141d27';
const PANEL = '#378add';
const PANEL_EDGE = '#1a3a5c';
const FRAME = '#8fa3b5';
const HULL = '#6b7f8e';

/**
 * The core primitive: an isometric prism standing on ground point
 * (gx, gy) with half-width w and height h. 2:1 iso proportions.
 */
export function drawIsoPrism(
  c: CanvasRenderingContext2D,
  gx: number, gy: number,
  w: number, h: number,
  top: string = TOP, left: string = LEFT, right: string = RIGHT,
) {
  // Left face
  c.fillStyle = left;
  c.beginPath();
  c.moveTo(gx - w, gy - h);
  c.lineTo(gx, gy - h + w / 2);
  c.lineTo(gx, gy + w / 2);
  c.lineTo(gx - w, gy);
  c.closePath();
  c.fill();
  // Right face
  c.fillStyle = right;
  c.beginPath();
  c.moveTo(gx, gy - h + w / 2);
  c.lineTo(gx + w, gy - h);
  c.lineTo(gx + w, gy);
  c.lineTo(gx, gy + w / 2);
  c.closePath();
  c.fill();
  // Top face
  c.fillStyle = top;
  c.beginPath();
  c.moveTo(gx - w, gy - h);
  c.lineTo(gx, gy - h - w / 2);
  c.lineTo(gx + w, gy - h);
  c.lineTo(gx, gy - h + w / 2);
  c.closePath();
  c.fill();
}

// ------------------------------------------------------------
// Building silhouettes. All take a ground point + level (>= 1).
// ------------------------------------------------------------

export function drawForge(c: CanvasRenderingContext2D, gx: number, gy: number, level: number) {
  const h = 9 + level * 4;
  drawIsoPrism(c, gx, gy, 4.5, h);
  // Chimney off the top-right corner
  const chX = gx + 2.5;
  const chTopY = gy - h - 5 - level;
  drawIsoPrism(c, chX, gy - h + 1, 1.4, 5 + level);
  // Ember glow
  c.fillStyle = GLOW;
  c.beginPath();
  c.arc(chX, chTopY - 1.5, 1.7, 0, Math.PI * 2);
  c.fill();
  if (level >= 3) {
    c.globalAlpha = 0.55;
    c.beginPath();
    c.arc(chX - 2.5, chTopY + 2, 1.1, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }
}

export function drawMint(c: CanvasRenderingContext2D, gx: number, gy: number, level: number) {
  const h = 5 + level * 2.5;
  const w = 4.5;
  drawIsoPrism(c, gx, gy, w, h);
  // Dome on the top face
  c.fillStyle = DOME;
  c.beginPath();
  c.arc(gx, gy - h - w / 4, w * 0.62, Math.PI, 0);
  c.closePath();
  c.fill();
}

export function drawLab(c: CanvasRenderingContext2D, gx: number, gy: number, level: number) {
  const h = 5 + level * 2.5;
  drawIsoPrism(c, gx, gy, 3.2, h);
  // Mast + dish
  const mastTop = gy - h - 6 - level * 1.5;
  c.strokeStyle = TOP;
  c.lineWidth = 1.1;
  c.beginPath();
  c.moveTo(gx, gy - h);
  c.lineTo(gx, mastTop);
  c.stroke();
  c.beginPath();
  c.arc(gx, mastTop, 3.2, Math.PI * 0.9, Math.PI * 1.7);
  c.stroke();
}

export function drawThrusters(c: CanvasRenderingContext2D, gx: number, gy: number, level: number) {
  // Angled nozzle cluster — reads as "this rock can move".
  const n = Math.min(3, 1 + level);
  c.strokeStyle = LEFT;
  c.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const ox = gx - 4 + i * 4;
    c.beginPath();
    c.moveTo(ox, gy);
    c.lineTo(ox + 3, gy - 7);
    c.stroke();
    c.fillStyle = GLOW;
    c.beginPath();
    c.arc(ox + 3.6, gy - 8.2, 1.3, 0, Math.PI * 2);
    c.fill();
  }
}

function drawHabitat(c: CanvasRenderingContext2D, gx: number, gy: number, size: number) {
  drawIsoPrism(c, gx, gy, 3 + size, 5 + size * 2.5);
}

// ------------------------------------------------------------
// City cluster
// ------------------------------------------------------------

/**
 * Draw a settled city as an isometric cluster. Canvas must already be
 * translated to the surface anchor and rotated so -y = outward normal.
 * The faction color tints only the landing-pad edge.
 */
export function drawCityCluster(
  c: CanvasRenderingContext2D,
  settlement: Settlement,
  factionColor: string,
) {
  // Landing pad — flat iso diamond, faction-edged.
  c.fillStyle = PAD;
  c.strokeStyle = factionColor;
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(0, -9);
  c.lineTo(20, 1);
  c.lineTo(0, 11);
  c.lineTo(-20, 1);
  c.closePath();
  c.fill();
  c.stroke();

  // Habitat blocks scale with population (back row first for correct
  // painter's-algorithm overlap).
  const habs = Math.min(3, 1 + Math.floor(settlement.population / 3));
  const habSlots: Array<[number, number]> = [[-9, -2], [9, -2], [-2, -5]];
  for (let i = 0; i < habs; i++) {
    const [hx, hy] = habSlots[i];
    drawHabitat(c, hx, hy, i === 0 ? 1 : 0);
  }

  // Building silhouettes — fixed slots, front of the pad.
  const forgeL = buildingLevel(settlement, 'forge' as BuildingKind);
  const mintL = buildingLevel(settlement, 'mint' as BuildingKind);
  const labL = buildingLevel(settlement, 'lab' as BuildingKind);
  const ttL = buildingLevel(settlement, 'trajectory_thrusters' as BuildingKind);
  if (labL > 0) drawLab(c, -12, 5, labL);
  if (forgeL > 0) drawForge(c, 1, 4, forgeL);
  if (mintL > 0) drawMint(c, 12, 3, mintL);
  if (ttL > 0) drawThrusters(c, -3, 10, ttL);
}

// ------------------------------------------------------------
// Station structure
// ------------------------------------------------------------

export interface StationStructureOpts {
  weaponsLevel: number;
  shipyardLevel: number;
  /** A ship build is in flight at this body — show a hull sitting in
   *  the scaffold. The construction tell playtesters actually see. */
  buildInFlight: boolean;
  factionColor: string;
}

/**
 * Draw a station as hub + solar wings + per-building modules, centered
 * on the current origin (caller translates to the station position).
 */
export function drawStationStructure(
  c: CanvasRenderingContext2D,
  opts: StationStructureOpts,
) {
  // Solar wings first (behind the hub)
  c.fillStyle = PANEL;
  c.strokeStyle = PANEL_EDGE;
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(-24, -3); c.lineTo(-8, 0); c.lineTo(-8, 6); c.lineTo(-24, 3);
  c.closePath(); c.fill(); c.stroke();
  c.beginPath();
  c.moveTo(8, 0); c.lineTo(24, -3); c.lineTo(24, 3); c.lineTo(8, 6);
  c.closePath(); c.fill(); c.stroke();

  // Hub — small prism with a faction-tinted beacon.
  drawIsoPrism(c, 0, 6, 6, 9);
  c.fillStyle = opts.factionColor;
  c.beginPath();
  c.arc(0, -8, 1.6, 0, Math.PI * 2);
  c.fill();

  // Weapons — barrels angled off the hub's upper-left; count/length
  // scale with level.
  if (opts.weaponsLevel > 0) {
    c.strokeStyle = '#d8e4ee';
    c.lineWidth = 1.6;
    const len = 6 + opts.weaponsLevel * 2;
    c.beginPath();
    c.moveTo(-4, -4); c.lineTo(-4 - len * 0.8, -4 - len * 0.6);
    c.moveTo(-1, -6); c.lineTo(-1 - len * 0.8, -6 - len * 0.6);
    c.stroke();
  }

  // Shipyard — open scaffold dock off the right side. Frame grows
  // with level; a hull materializes inside while a build is queued.
  if (opts.shipyardLevel > 0) {
    const fw = 20 + opts.shipyardLevel * 3;
    const fh = 14 + opts.shipyardLevel * 2;
    const x0 = 12, y0 = -fh / 2 + 3;
    c.strokeStyle = FRAME;
    c.lineWidth = 1;
    c.strokeRect(x0, y0, fw, fh);
    c.beginPath();
    c.moveTo(x0, y0 + fh / 3); c.lineTo(x0 + fw, y0 + fh / 3);
    c.moveTo(x0, y0 + fh * 2 / 3); c.lineTo(x0 + fw, y0 + fh * 2 / 3);
    c.moveTo(x0 + fw / 3, y0); c.lineTo(x0 + fw / 3, y0 + fh);
    c.moveTo(x0 + fw * 2 / 3, y0); c.lineTo(x0 + fw * 2 / 3, y0 + fh);
    c.stroke();
    if (opts.buildInFlight) {
      const hw = fw * 0.55;
      const hy = y0 + fh / 2 - 3;
      c.fillStyle = HULL;
      c.beginPath();
      // rounded hull + nose cone
      c.roundRect ? c.roundRect(x0 + 3, hy, hw, 6, 3) : c.rect(x0 + 3, hy, hw, 6);
      c.fill();
      c.beginPath();
      c.moveTo(x0 + 3 + hw, hy);
      c.lineTo(x0 + 3 + hw + 5, hy + 3);
      c.lineTo(x0 + 3 + hw, hy + 6);
      c.closePath();
      c.fill();
      // Weld sparks — two glow dots (static, cheap)
      c.fillStyle = GLOW;
      c.beginPath();
      c.arc(x0 + 3 + hw * 0.4, hy - 1, 1, 0, Math.PI * 2);
      c.fill();
    }
  }
}
