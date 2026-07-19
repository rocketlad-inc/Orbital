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

// Weld-spark tables (module-level so the per-frame draw allocates
// nothing). u/v are fractional positions inside the scaffold hull,
// freq (Hz) + phase give each spark an independent flash cadence.
const SPARK_U = [0.32, 0.62, 0.47];
const SPARK_V = [-0.15, 1.1, 0.5];
const SPARK_FREQ = [3.1, 2.4, 3.7];
const SPARK_PHASE = [0, 2.1, 4.4];

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
//
// Layout: a central hub with two solar-panel wings sweeping down and
// out from its BASE (the station's power source, always present — a
// station with zero buildings still reads as a station). Each building
// kind mounts on its own fixed boom off the hub — weapons upper-left,
// lab straight up, shipyard to the right — so modules never collide
// and always grow from the same anchor a player learns to read.
//
// Growth is DISCRETE, not just bigger: each level from 1-5 appends a
// genuinely new sub-shape (second barrel, second dish, extra gantry
// rail...) rather than rescaling the same one, so leveling up visibly
// changes the silhouette. Past level 5 a small pip row keeps counting
// without new bespoke art. A brief expanding-ring pop (drawBuildPop)
// marks the exact module that just leveled, so "I built something" has
// a moment, not just a diff you'd only notice on the next glance.
// ------------------------------------------------------------

const HUB_X = 0;
const HUB_Y = -2;
const BUILD_POP_DURATION_MS = 900;

/**
 * A rectangular panel between two points, subdivided into `cells` grid
 * lines along its length — the generic "solar array" primitive. Reused
 * for both wings; could serve city power arrays later too.
 */
function drawPanel(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  width: number, cells: number,
) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy * width / 2, py = ux * width / 2;
  c.fillStyle = PANEL;
  c.strokeStyle = PANEL_EDGE;
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(x0 + px, y0 + py);
  c.lineTo(x1 + px, y1 + py);
  c.lineTo(x1 - px, y1 - py);
  c.lineTo(x0 - px, y0 - py);
  c.closePath();
  c.fill();
  c.stroke();
  c.beginPath();
  for (let i = 1; i < cells; i++) {
    const t = i / cells;
    const cx = x0 + dx * t, cy = y0 + dy * t;
    c.moveTo(cx + px, cy + py);
    c.lineTo(cx - px, cy - py);
  }
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

/** Strut connecting the hub to a module's mount point. */
function drawBoom(c: CanvasRenderingContext2D, tipX: number, tipY: number) {
  c.strokeStyle = FRAME;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(HUB_X, HUB_Y);
  c.lineTo(tipX, tipY);
  c.stroke();
}

/** Overflow indicator once a module's bespoke art has run out of new
 *  shapes to add (level > 5) — a short row of dots so investing past
 *  the art ceiling still visibly does something. */
function drawLevelPips(c: CanvasRenderingContext2D, x: number, y: number, level: number, color: string) {
  const n = Math.min(level - 5, 6);
  if (n <= 0) return;
  c.fillStyle = color;
  for (let i = 0; i < n; i++) {
    c.beginPath();
    c.arc(x + i * 3 - (n - 1) * 1.5, y, 0.9, 0, Math.PI * 2);
    c.fill();
  }
}

/** Brief expanding ring + bright core at (x, y) — the "something just
 *  got built here" tell. Self-contained (no RenderContext access; this
 *  module can't import from mapRenderer.ts without a cycle), so it
 *  takes wall-clock ms directly. */
function drawBuildPop(
  c: CanvasRenderingContext2D,
  x: number, y: number,
  startMs: number | undefined, nowMs: number,
  color: string,
) {
  if (startMs === undefined) return;
  const age = nowMs - startMs;
  if (age < 0 || age >= BUILD_POP_DURATION_MS) return;
  const linear = 1 - age / BUILD_POP_DURATION_MS;
  const prevAlpha = c.globalAlpha;
  c.strokeStyle = color;
  c.lineWidth = 1.4;
  c.globalAlpha = prevAlpha * linear * 0.85;
  c.beginPath();
  c.arc(x, y, 3 + (1 - linear) * 15, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = color;
  c.globalAlpha = prevAlpha * linear * 0.6;
  c.beginPath();
  c.arc(x, y, 2.5 * linear, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = prevAlpha;
}

/** A single dish: short mast + arc, matching the city lab's silhouette
 *  vocabulary but freestanding (no ground prism — station modules float
 *  off booms, not a surface). */
function drawDish(c: CanvasRenderingContext2D, x: number, y: number, mastLen: number, dishR: number) {
  c.strokeStyle = TOP;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y - mastLen);
  c.stroke();
  c.beginPath();
  c.arc(x, y - mastLen, dishR, Math.PI * 0.9, Math.PI * 1.7);
  c.stroke();
}

// ---- Weapons module (boom: upper-left) ----------------------

function drawWeaponsModule(c: CanvasRenderingContext2D, level: number, popStart: number | undefined, nowMs: number) {
  const tip = { x: HUB_X - 8, y: HUB_Y - 7 };
  drawBoom(c, tip.x, tip.y);

  // L1: turret dome + first barrel.
  c.fillStyle = FRAME;
  c.beginPath();
  c.arc(tip.x, tip.y, 3, Math.PI, 0);
  c.closePath();
  c.fill();
  c.strokeStyle = '#d8e4ee';
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(tip.x - 1.5, tip.y - 1.5);
  c.lineTo(tip.x - 1.5 - 7, tip.y - 1.5 - 5);
  c.stroke();

  // L2: second (twin) barrel, offset.
  if (level >= 2) {
    c.beginPath();
    c.moveTo(tip.x + 1.5, tip.y - 1.5);
    c.lineTo(tip.x + 1.5 - 7, tip.y - 1.5 - 5);
    c.stroke();
  }

  // L3: targeting dish above the turret.
  if (level >= 3) drawDish(c, tip.x, tip.y - 3, 4, 2);

  // L4: armor collar around the dome base.
  if (level >= 4) {
    c.strokeStyle = FRAME;
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(tip.x, tip.y, 4.2, Math.PI * 0.15, Math.PI * 0.85);
    c.stroke();
  }

  // L5: a third, heavier barrel with a muzzle glow.
  if (level >= 5) {
    c.strokeStyle = '#d8e4ee';
    c.lineWidth = 2.2;
    const ex = tip.x - 9, ey = tip.y - 7;
    c.beginPath();
    c.moveTo(tip.x, tip.y - 2);
    c.lineTo(ex, ey);
    c.stroke();
    c.fillStyle = GLOW;
    c.beginPath();
    c.arc(ex, ey, 1.1, 0, Math.PI * 2);
    c.fill();
  }

  drawLevelPips(c, tip.x, tip.y + 5, level, '#d8e4ee');
  drawBuildPop(c, tip.x, tip.y, popStart, nowMs, '#d8e4ee');
}

// ---- Lab module (boom: straight up) --------------------------

function drawStationLabModule(c: CanvasRenderingContext2D, level: number, popStart: number | undefined, nowMs: number) {
  const tip = { x: HUB_X, y: HUB_Y - 10 };
  drawBoom(c, tip.x, tip.y);

  // L1: one dish.
  drawDish(c, tip.x - 1.5, tip.y, 4, 2.4);

  // L2: second, larger dish beside it — a small fan.
  if (level >= 2) drawDish(c, tip.x + 2.5, tip.y + 1, 3, 2);

  // L3: blinking sensor light on the mast, own pulse cadence distinct
  // from the hub beacon so a busy station doesn't read as one light.
  if (level >= 3) {
    const gate = 0.5 + 0.5 * Math.sin(Math.PI * nowMs / 620);
    c.fillStyle = GLOW;
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * (0.35 + 0.65 * gate);
    c.beginPath();
    c.arc(tip.x - 1.5, tip.y - 2, 0.9, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = prevAlpha;
  }

  // L4: mast extends further + a third mini dish.
  if (level >= 4) {
    c.strokeStyle = TOP;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(tip.x, tip.y);
    c.lineTo(tip.x, tip.y - 5);
    c.stroke();
    drawDish(c, tip.x - 4, tip.y - 4, 2, 1.4);
  }

  // L5: a truss arc tying the dishes together — reads as "array" now,
  // not three separate dishes.
  if (level >= 5) {
    c.strokeStyle = FRAME;
    c.lineWidth = 0.9;
    c.beginPath();
    c.arc(tip.x, tip.y + 2, 6.5, Math.PI * 1.05, Math.PI * 1.95);
    c.stroke();
  }

  drawLevelPips(c, tip.x, tip.y + 6, level, TOP);
  drawBuildPop(c, tip.x, tip.y, popStart, nowMs, TOP);
}

// ---- Shipyard module (boom: right) -----------------------------

/** Per-class hull proportions for the under-construction silhouette,
 *  so the shipyard shows roughly what it's actually building rather
 *  than one generic capsule for every class. */
const HULL_SHAPE: Record<string, { lenFrac: number; hFrac: number; tailFin: boolean; boxy: boolean; bulbNose: boolean }> = {
  corvette:  { lenFrac: 0.42, hFrac: 0.55, tailFin: false, boxy: false, bulbNose: false },
  frigate:   { lenFrac: 0.58, hFrac: 0.7,  tailFin: true,  boxy: false, bulbNose: false },
  destroyer: { lenFrac: 0.72, hFrac: 0.85, tailFin: true,  boxy: false, bulbNose: false },
  freighter: { lenFrac: 0.62, hFrac: 0.9,  tailFin: false, boxy: true,  bulbNose: false },
  colony:    { lenFrac: 0.55, hFrac: 0.95, tailFin: false, boxy: false, bulbNose: true },
};

/**
 * A ship taking shape inside a shipyard bay. Draws a dim full-length
 * "blueprint" outline (the whole hull, always visible once queued) and
 * an opaque hull clipped to `progress` — a printing-in-progress look
 * rather than a ship that's either absent or magically complete. Nose
 * and class-specific details fade in only once progress crosses their
 * own threshold, so assembly reads front-to-back like it should.
 */
function drawHullUnderConstruction(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, availW: number, availH: number,
  shipClass: string, progress: number, nowMs: number, sparkSeed: number,
) {
  const shape = HULL_SHAPE[shipClass] ?? HULL_SHAPE.corvette;
  const w = availW * shape.lenFrac;
  const h = availH * shape.hFrac;
  const y = y0 + (availH - h) / 2;
  const p = Math.max(0, Math.min(1, progress));

  const drawBody = (alpha: number, filled: boolean, clipW: number) => {
    if (clipW <= 0) return;
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * alpha;
    c.save();
    c.beginPath();
    c.rect(x0 - 1, y0 - 1, clipW + 2, availH + 2);
    c.clip();
    if (filled) {
      c.fillStyle = HULL;
      c.beginPath();
      if (c.roundRect) c.roundRect(x0, y, w, h, Math.min(3, h / 2));
      else c.rect(x0, y, w, h);
      c.fill();
    } else {
      c.strokeStyle = FRAME;
      c.lineWidth = 0.8;
      c.setLineDash([1.5, 1.5]);
      c.beginPath();
      if (c.roundRect) c.roundRect(x0, y, w, h, Math.min(3, h / 2));
      else c.rect(x0, y, w, h);
      c.stroke();
      c.setLineDash([]);
    }
    c.restore();
    c.globalAlpha = prevAlpha;
  };

  // Blueprint ghost for the whole hull, then the printed portion on top.
  drawBody(0.4, false, w);
  drawBody(1, true, w * p);

  // Nose cone — only once the body is mostly printed, boxy freighters
  // get a flat prow instead.
  if (!shape.boxy && p > 0.55) {
    const noseAlpha = Math.min(1, (p - 0.55) / 0.25);
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * noseAlpha;
    c.fillStyle = HULL;
    c.beginPath();
    if (shape.bulbNose) {
      c.arc(x0 + w, y + h / 2, h * 0.6, -Math.PI / 2, Math.PI / 2);
    } else {
      c.moveTo(x0 + w, y);
      c.lineTo(x0 + w + h * 0.7, y + h / 2);
      c.lineTo(x0 + w, y + h);
    }
    c.closePath();
    c.fill();
    c.globalAlpha = prevAlpha;
  }
  if (shape.tailFin && p > 0.2) {
    const finAlpha = Math.min(1, (p - 0.2) / 0.2);
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * finAlpha;
    c.fillStyle = HULL;
    c.beginPath();
    c.moveTo(x0, y + h * 0.15);
    c.lineTo(x0 - h * 0.4, y - h * 0.15);
    c.lineTo(x0, y + h * 0.45);
    c.closePath();
    c.fill();
    c.globalAlpha = prevAlpha;
  }
  if (shape.boxy) {
    const podAlpha1 = p > 0.4 ? Math.min(1, (p - 0.4) / 0.2) : 0;
    const podAlpha2 = p > 0.75 ? Math.min(1, (p - 0.75) / 0.2) : 0;
    const prevAlpha = c.globalAlpha;
    if (podAlpha1 > 0) {
      c.globalAlpha = prevAlpha * podAlpha1;
      c.fillStyle = FRAME;
      c.fillRect(x0 + w * 0.15, y - 2, w * 0.25, 2.2);
    }
    if (podAlpha2 > 0) {
      c.globalAlpha = prevAlpha * podAlpha2;
      c.fillStyle = FRAME;
      c.fillRect(x0 + w * 0.55, y - 2, w * 0.25, 2.2);
    }
    c.globalAlpha = prevAlpha;
  }

  // Weld sparks trail the growing edge, not the whole hull, so the
  // "active work" reads as happening where the print head actually is.
  if (p < 1) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = GLOW;
    const edgeX = x0 + w * p;
    for (let i = 0; i < 3; i++) {
      const freq = SPARK_FREQ[i] + sparkSeed * 0.3;
      const gate = Math.sin((nowMs / 1000) * freq * Math.PI * 2 + SPARK_PHASE[i] + sparkSeed);
      if (gate <= 0.45) continue;
      c.globalAlpha = Math.min(1, (gate - 0.45) / 0.35);
      c.beginPath();
      c.arc(edgeX + (SPARK_U[i] - 0.5) * 5, y + h * SPARK_V[i] * 0.4 + h / 2, 1, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
}

function drawShipyardModule(
  c: CanvasRenderingContext2D,
  level: number,
  builds: { shipClass: string; progress: number }[],
  popStart: number | undefined,
  nowMs: number,
) {
  const fw = 18 + level * 3;
  const fh = 12 + level * 1.5;
  const x0 = HUB_X + 5, y0 = HUB_Y - fh / 2;
  drawBoom(c, x0, y0 + fh / 2);

  const drawBay = (bx0: number, by0: number, bw: number, bh: number, build?: { shipClass: string; progress: number }, seed = 0) => {
    c.strokeStyle = FRAME;
    c.lineWidth = 1;
    c.strokeRect(bx0, by0, bw, bh);
    c.beginPath();
    c.moveTo(bx0, by0 + bh / 3); c.lineTo(bx0 + bw, by0 + bh / 3);
    c.moveTo(bx0, by0 + bh * 2 / 3); c.lineTo(bx0 + bw, by0 + bh * 2 / 3);
    c.moveTo(bx0 + bw / 3, by0); c.lineTo(bx0 + bw / 3, by0 + bh);
    c.moveTo(bx0 + bw * 2 / 3, by0); c.lineTo(bx0 + bw * 2 / 3, by0 + bh);
    c.stroke();
    if (build) {
      drawHullUnderConstruction(c, bx0 + 2, by0 + 1, bw - 4, bh - 2, build.shipClass, build.progress, nowMs, seed);
    }
  };

  // L1: single bay.
  drawBay(x0, y0, fw, fh, builds[0]);

  // L2: a second gantry rail across the top (frame reads busier —
  // this station can actually run parallel work now, not just a
  // bigger single bay).
  if (level >= 2) {
    c.strokeStyle = FRAME;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x0 - 2, y0 - 2); c.lineTo(x0 + fw + 2, y0 - 2);
    c.stroke();
  }

  // L3: floodlights at the frame corners.
  if (level >= 3) {
    const gate = 0.6 + 0.4 * Math.sin(Math.PI * nowMs / 900);
    c.fillStyle = GLOW;
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * gate;
    for (const [fx, fy] of [[x0, y0], [x0 + fw, y0], [x0, y0 + fh], [x0 + fw, y0 + fh]]) {
      c.beginPath();
      c.arc(fx, fy, 0.8, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = prevAlpha;
  }

  // L4: docking clamp at the open end.
  if (level >= 4) {
    c.strokeStyle = FRAME;
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(x0 + fw, y0 + fh * 0.3);
    c.lineTo(x0 + fw + 4, y0 + fh / 2);
    c.lineTo(x0 + fw, y0 + fh * 0.7);
    c.stroke();
  }

  // L5: a genuine second bay, parallel below the first — this is the
  // level where the station can actually show two hulls building at
  // once, matching the extra build slot the level grants.
  if (level >= 5) {
    drawBay(x0, y0 + fh + 4, fw * 0.85, fh * 0.8, builds[1], 1.7);
  }

  drawLevelPips(c, x0 + fw / 2, y0 + fh + (level >= 5 ? fh * 0.8 + 8 : 4), level, FRAME);
  drawBuildPop(c, x0 + fw / 2, y0 + fh / 2, popStart, nowMs, FRAME);
}

export interface StationStructureOpts {
  weaponsLevel: number;
  shipyardLevel: number;
  labLevel: number;
  factionColor: string;
  /** Ships currently under construction here, earliest-queued first.
   *  Empty = idle shipyard (frame stays; no hull). */
  builds: { shipClass: string; progress: number }[];
  /** wall-clock ms, threaded in rather than read via performance.now()
   *  internally so callers with a frame-stable "now" (matching the
   *  damage-flash convention elsewhere) stay in sync with it. */
  nowMs: number;
  /** "Just leveled up" pop timing per module, wall-clock ms. Undefined
   *  = no recent change, no pop. */
  buildFlash?: { weapons?: number; shipyard?: number; lab?: number };
}

/**
 * Draw a station as hub + solar wings (base, always present) + one boom
 * per building kind, centered on the current origin (caller translates
 * to the station's canvas position).
 */
export function drawStationStructure(
  c: CanvasRenderingContext2D,
  opts: StationStructureOpts,
) {
  const nowM = opts.nowMs;

  // Solar wings — the station's power source, drawn first (behind
  // everything) and unconditionally, so even a bare station with zero
  // buildings still reads as a station and not a stray dot.
  drawPanel(c, HUB_X - 3, HUB_Y + 4, HUB_X - 17, HUB_Y + 14, 6, 4);
  drawPanel(c, HUB_X + 3, HUB_Y + 4, HUB_X + 17, HUB_Y + 14, 6, 4);

  // Hub — small prism with a faction-tinted beacon on top. The beacon
  // pulses alpha 0.4→1.0 at 0.5Hz (§E1) — pure cosmetic, so wall-clock
  // is the right time base (matches the damage-flash pattern).
  drawIsoPrism(c, HUB_X, HUB_Y + 6, 5, 8);
  c.fillStyle = opts.factionColor;
  const prevAlpha = c.globalAlpha;
  c.globalAlpha = prevAlpha * (0.7 + 0.3 * Math.sin(Math.PI * nowM / 1000));
  c.beginPath();
  c.arc(HUB_X, HUB_Y - 3, 1.5, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = prevAlpha;

  if (opts.weaponsLevel > 0) {
    drawWeaponsModule(c, opts.weaponsLevel, opts.buildFlash?.weapons, nowM);
  }
  if (opts.labLevel > 0) {
    drawStationLabModule(c, opts.labLevel, opts.buildFlash?.lab, nowM);
  }
  if (opts.shipyardLevel > 0) {
    drawShipyardModule(c, opts.shipyardLevel, opts.builds, opts.buildFlash?.shipyard, nowM);
  }
}
