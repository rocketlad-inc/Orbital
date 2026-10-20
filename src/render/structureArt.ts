// ============================================================
// structureArt — the surface structures, drawn on the world.
//
// The silhouettes Lorne picked from the canvas mock (2026-10-20), drawn
// the way the menu is drawn: dark bodies, edges lit in the owner's
// livery, each with a glow in its resource's colour —
//   FORGE   smelter + stacks, a furnace mouth glowing orange (metal)
//   MINT    stepped vault dome, gold rings (credits)
//   LAB     a dish on a mast, green focus (science)
//   SHIELDS a pylon with its emitter ring (the dome is drawn over the city)
//   SILO    flush upright hatches, one per magazine slot, gantry + beacon
// Three silhouettes each (levels 1-2, 3-5, 6+), plus the states every
// tag can be in: an open plot, a locked plot, a building site, the next
// level waiting in the queue (a teal ghost), damage.
//
// Coordinates are STRUCTURE UNITS with the ground at y = 0 and up as -y;
// the caller translates to the structure's spot on the limb, rotates so
// "up" is away from the planet's centre, and scales by structureUnit(r).
// Heights here must match src/game/worldMenu/structures.ts.
// ============================================================

export interface StructureLook {
  /** Edge colour: the owner's livery, or the highlight. */
  edge: string;
  /** Body fill; null draws an outline only (the queued ghost). */
  body: string | null;
  /** 0..1 strength of the resource glow. */
  glow: number;
  /** Dashed edges (the ghost). */
  dash?: number[];
}

const BODY = '#0e1621';
const PAD = '#0a0f16';
const PAD_EDGE = '#2a3d50';

function shape(g: CanvasRenderingContext2D, look: StructureLook, build: () => void) {
  g.beginPath();
  build();
  if (look.body) { g.fillStyle = look.body; g.fill(); }
  g.setLineDash(look.dash ?? []);
  g.strokeStyle = look.edge;
  g.lineWidth = 1.3;
  g.lineJoin = 'round';
  g.stroke();
  g.setLineDash([]);
}
const rect = (g: CanvasRenderingContext2D, look: StructureLook, x: number, y: number, w: number, h: number) =>
  shape(g, look, () => g.rect(x, y, w, h));
const poly = (g: CanvasRenderingContext2D, look: StructureLook, pts: number[]) =>
  shape(g, look, () => { g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); });
function detail(g: CanvasRenderingContext2D, look: StructureLook, x1: number, y1: number, x2: number, y2: number) {
  g.save();
  g.globalAlpha *= 0.45;
  g.strokeStyle = look.edge;
  g.lineWidth = 0.9;
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  g.restore();
}
function glowRect(g: CanvasRenderingContext2D, look: StructureLook, color: string, x: number, y: number, w: number, h: number) {
  if (look.glow <= 0) return;
  g.save(); g.globalAlpha *= look.glow; g.fillStyle = color; g.fillRect(x, y, w, h); g.restore();
}
function glowDot(g: CanvasRenderingContext2D, look: StructureLook, color: string, x: number, y: number, r: number) {
  if (look.glow <= 0) return;
  g.save(); g.globalAlpha *= look.glow; g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.restore();
}
function glowStroke(g: CanvasRenderingContext2D, look: StructureLook, color: string, build: () => void, w = 1.2) {
  if (look.glow <= 0) return;
  g.save(); g.globalAlpha *= look.glow; g.strokeStyle = color; g.lineWidth = w; g.beginPath(); build(); g.stroke(); g.restore();
}
const dome = (g: CanvasRenderingContext2D, look: StructureLook, baseY: number, r: number) =>
  shape(g, look, () => { g.moveTo(-r, baseY); g.arc(0, baseY, r, Math.PI, 0); g.closePath(); });
const dish = (g: CanvasRenderingContext2D, look: StructureLook, half: number, y: number, depth: number) =>
  shape(g, look, () => { g.moveTo(-half, y); g.quadraticCurveTo(0, y + depth, half, y); g.closePath(); });

const METAL = '#ff8a5c';
const GOLD = '#ffd166';
const SCI = '#6ee7b7';
const SHIELD = '#7fd6ff';

export function drawPad(g: CanvasRenderingContext2D, rx: number) {
  g.beginPath(); g.ellipse(0, 0, rx, 3, 0, 0, Math.PI * 2);
  g.fillStyle = PAD; g.fill(); g.strokeStyle = PAD_EDGE; g.lineWidth = 1; g.stroke();
}

function forge(g: CanvasRenderingContext2D, t: 1 | 3 | 6, L: StructureLook) {
  if (t === 1) {
    rect(g, L, -14, -15, 24, 15); rect(g, L, 4, -30, 6, 15);
    glowRect(g, L, METAL, -10, -8, 8, 5);
  } else if (t === 3) {
    rect(g, L, -19, -24, 32, 24); detail(g, L, -19, -12, 13, -12);
    rect(g, L, -11, -38, 6, 14); rect(g, L, 3, -50, 8, 26);
    glowRect(g, L, METAL, -15, -9, 10, 6); glowDot(g, L, METAL, 7, -53, 2);
  } else {
    rect(g, L, -24, -34, 40, 34); detail(g, L, -24, -23, 16, -23); detail(g, L, -24, -12, 16, -12);
    rect(g, L, 16, -20, 9, 20); rect(g, L, -15, -56, 8, 22); rect(g, L, 3, -74, 10, 40);
    detail(g, L, 3, -60, 13, -60);
    glowRect(g, L, METAL, -19, -10, 14, 7); glowDot(g, L, METAL, 8, -78, 2.6); glowDot(g, L, METAL, -11, -59, 1.8);
  }
}
function mint(g: CanvasRenderingContext2D, t: 1 | 3 | 6, L: StructureLook) {
  const ring = (y: number, rx: number, ry: number) => glowStroke(g, L, GOLD, () => g.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2));
  if (t === 1) {
    rect(g, L, -14, -6, 28, 6); dome(g, L, -6, 10); ring(-10, 6, 1.5); glowDot(g, L, GOLD, 0, -19, 1.8);
  } else if (t === 3) {
    rect(g, L, -19, -6, 38, 6); rect(g, L, -15, -12, 30, 6); dome(g, L, -12, 13);
    ring(-17, 9, 2); detail(g, L, 0, -25, 0, -31); glowDot(g, L, GOLD, 0, -33, 2.4);
  } else {
    rect(g, L, -24, -6, 48, 6); rect(g, L, -20, -12, 40, 6); rect(g, L, -16, -18, 32, 6); dome(g, L, -18, 16);
    ring(-24, 12, 2.5); ring(-29, 8, 1.6); detail(g, L, 0, -34, 0, -46); glowDot(g, L, GOLD, 0, -48, 3);
  }
}
function lab(g: CanvasRenderingContext2D, t: 1 | 3 | 6, L: StructureLook) {
  if (t === 1) {
    rect(g, L, -10, -8, 20, 8); rect(g, L, -1.5, -20, 3, 12); dish(g, L, 9, -24, 9);
    glowDot(g, L, SCI, 0, -27, 1.8);
  } else if (t === 3) {
    rect(g, L, -14, -12, 28, 12); detail(g, L, -14, -6, 14, -6); rect(g, L, -2, -34, 4, 22);
    dish(g, L, 13, -38, 12);
    glowStroke(g, L, SCI, () => { g.moveTo(0, -36); g.lineTo(0, -45); }); glowDot(g, L, SCI, 0, -46, 2.2);
  } else {
    rect(g, L, -18, -16, 36, 16); detail(g, L, -18, -8, 18, -8); rect(g, L, 18, -10, 10, 10);
    rect(g, L, -3, -54, 6, 38); detail(g, L, -3, -28, 3, -40); detail(g, L, 3, -28, -3, -40);
    dish(g, L, 18, -58, 16);
    glowStroke(g, L, SCI, () => { g.moveTo(0, -55); g.lineTo(0, -67); }); glowDot(g, L, SCI, 0, -68, 2.8);
    shape(g, L, () => { g.moveTo(20, -12); g.quadraticCurveTo(23, -7, 26, -12); g.closePath(); });
  }
}
function shields(g: CanvasRenderingContext2D, t: 1 | 3 | 6, L: StructureLook) {
  const ring = (y: number, r: number) => glowStroke(g, L, SHIELD, () => g.arc(0, y, r, 0, Math.PI * 2), 1.4);
  if (t === 1) {
    poly(g, L, [-7, 0, -3, -20, 3, -20, 7, 0]); ring(-24, 4);
  } else if (t === 3) {
    poly(g, L, [-9, 0, -3, -32, 3, -32, 9, 0]); detail(g, L, -6, -12, 6, -12); ring(-37, 5); glowDot(g, L, SHIELD, 0, -37, 2);
  } else {
    poly(g, L, [-11, 0, -3, -46, 3, -46, 11, 0]); detail(g, L, -8, -14, 8, -14); detail(g, L, -6, -28, 6, -28);
    poly(g, L, [-22, 0, -18, -18, -15, -18, -12, 0]); poly(g, L, [12, 0, 15, -18, 18, -18, 22, 0]);
    ring(-52, 6); glowDot(g, L, SHIELD, 0, -52, 2.4);
  }
}
/** The silo: one hatch per magazine slot (5 a level), rows of 15. `stock`
 *  null = not ours to know (a rival's): every hatch reads closed. */
function silo(g: CanvasRenderingContext2D, level: number, stock: number | null, building: number, L: StructureLook) {
  const n = 5 * Math.max(1, level);
  const rows = n > 15 ? 2 : 1;
  const perRow = Math.min(15, n);
  const w = 6 + 4.2 * perRow;
  const h = rows === 2 ? 16 : 9;
  rect(g, L, -w / 2, -h, w, h);
  for (let k = 0; k < n; k++) {
    const r = Math.floor(k / 15), i = k % 15;
    const x = -w / 2 + 3 + 4.2 * i;
    const y = rows === 2 ? (r === 0 ? -14 : -7) : -7;
    if (stock != null && k < stock) {
      glowRect(g, { ...L, glow: Math.max(0.35, L.glow) }, METAL, x, y, 3, 5);
    } else if (stock != null && k < stock + building) {
      g.save(); g.setLineDash([1.5, 1]); g.strokeStyle = METAL; g.lineWidth = 0.8; g.strokeRect(x, y, 3, 5); g.restore();
      g.save(); g.globalAlpha *= 0.7; g.fillStyle = METAL; g.fillRect(x + 0.7, y - 5, 1.6, 5); g.restore();
    } else {
      g.save(); g.strokeStyle = '#3a4b5c'; g.lineWidth = 0.8; g.strokeRect(x, y, 3, 5); g.restore();
    }
  }
  g.save();
  g.strokeStyle = L.edge; g.lineWidth = 1.3;
  g.beginPath(); g.moveTo(-w / 2, -h); g.lineTo(-w / 2, -h - 15);
  if (level >= 3) { g.moveTo(w / 2, -h); g.lineTo(w / 2, -h - 9); }
  g.stroke();
  g.fillStyle = '#ff6b6b'; g.beginPath(); g.arc(-w / 2, -h - 17, 1.8, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** A built structure at `level` (>= 1). */
export function drawStructure(
  g: CanvasRenderingContext2D, kind: string, level: number, L: StructureLook,
  silo_?: { stock: number | null; building: number },
) {
  const t: 1 | 3 | 6 = level >= 6 ? 6 : level >= 3 ? 3 : 1;
  if (kind === 'forge') forge(g, t, L);
  else if (kind === 'mint') mint(g, t, L);
  else if (kind === 'lab') lab(g, t, L);
  else if (kind === 'shields') shields(g, t, L);
  else if (kind === 'missile_silo') silo(g, level, silo_?.stock ?? null, silo_?.building ?? 0, L);
}

/** An empty plot: a dashed pad and post, a plus (open) or a padlock (locked). */
export function drawPlot(g: CanvasRenderingContext2D, locked: boolean, highlight: boolean) {
  const edge = highlight ? '#ffd27a' : locked ? '#2a3d50' : '#3a5068';
  g.save();
  g.strokeStyle = edge; g.lineWidth = 1;
  g.setLineDash([3, 2]);
  g.fillStyle = PAD; g.beginPath(); g.rect(-20, -3, 40, 3); g.fill(); g.stroke();
  g.setLineDash([2, 2]);
  g.beginPath(); g.moveTo(-20, -3); g.lineTo(-16, -9); g.lineTo(16, -9); g.lineTo(20, -3); g.stroke();
  g.setLineDash([]);
  g.beginPath(); g.moveTo(0, -9); g.lineTo(0, locked ? -15 : -14); g.stroke();
  if (locked) {
    g.strokeStyle = '#c9a86a';
    g.fillStyle = PAD;
    g.beginPath(); g.rect(-4, -21, 8, 6); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-2.4, -21); g.lineTo(-2.4, -23); g.arc(0, -23, 2.4, Math.PI, 0); g.lineTo(2.4, -21); g.stroke();
  } else {
    g.strokeStyle = highlight ? '#ffd27a' : '#8aa4bd'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(-3.5, -19); g.lineTo(3.5, -19); g.moveTo(0, -22.5); g.lineTo(0, -15.5); g.stroke();
  }
  g.restore();
}

/** A building site: dashed scaffold, a crane, a ring filling to done. */
export function drawSite(g: CanvasRenderingContext2D, done: number) {
  g.save();
  g.strokeStyle = '#ffb84d'; g.lineWidth = 1;
  g.setLineDash([3, 3]); g.strokeRect(-22, -54, 44, 54); g.setLineDash([]);
  g.save(); g.globalAlpha *= 0.5;
  g.beginPath(); g.moveTo(-22, -54); g.lineTo(22, 0); g.moveTo(22, -54); g.lineTo(-22, 0); g.stroke();
  g.restore();
  g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(28, 0); g.lineTo(28, -66); g.lineTo(-8, -66); g.moveTo(-4, -66); g.lineTo(-4, -56); g.stroke();
  g.lineWidth = 2.4;
  g.strokeStyle = '#1c2836'; g.beginPath(); g.arc(40, -36, 6, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = '#ffb84d'; g.beginPath(); g.arc(40, -36, 6, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, done) * Math.PI * 2); g.stroke();
  g.restore();
}

/** The queue's next entry for this structure: its badge, teal. */
export function drawQueueBadge(g: CanvasRenderingContext2D, pos: number, x: number, y: number) {
  g.save();
  g.fillStyle = '#4ecdc4'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#04202a';
  g.font = '600 10px "Chivo Mono", ui-monospace, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(pos), x, y + 0.5);
  g.restore();
}

/** The glow under a structure that is hovered or picked. */
export function drawFocusGlow(g: CanvasRenderingContext2D, rx: number) {
  g.save();
  g.fillStyle = 'rgba(255, 184, 77, 0.22)';
  g.beginPath(); g.ellipse(0, -2, rx + 8, 7, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** An edge colour bright enough to read on the dark bodies, hue intact:
 *  a dark livery (deep red, navy) is lifted toward white. */
export function edgeLivery(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return '#4fc3f7';
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  if (lum < 120) {
    const k = (120 - lum) / (255 - lum);
    r = Math.round(r + (255 - r) * k); gg = Math.round(gg + (255 - gg) * k); b = Math.round(b + (255 - b) * k);
  }
  return `rgb(${r},${gg},${b})`;
}

export const STRUCTURE_BODY = BODY;
