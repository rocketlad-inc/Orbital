// ============================================================
// World-menu close-up pass — MULTIPLAYER ONLY canvas layer.
//
// Draws the diegetic surface of the focused body once the camera
// dives past the map LOD: per-type surface detail (continents /
// craters / bands), terminator, ambient skyline, faction buildings
// with level variants, the city's name + HP bar, and damage fire.
//
// One planet, one camera: this paints ON the same disc drawBody
// already rendered, at the same screen circle — nothing fades in
// from elsewhere. Every size in here is a fraction of the body's
// SCREEN RADIUS (spec G6/G7), never a raw pixel constant.
//
// Called from MapCanvas only when isWorldMenuActive() (set by the
// MP-only overlay) — this module is unreachable in single-player.
// ============================================================

import { Body, BuildingKind, Settlement } from '../types';
import { RenderContext, worldToCanvas, drawCloudDeck } from './mapRenderer';
import { getTerraformedTexture } from './planetTexture';
import { bodyPosition } from '../physics/orbitalMechanics';
import { zOf, clamp01 } from '../game/worldMenu/camera';
import { hpColor, flameCount } from '../game/worldMenu/combatDisplay';
import { buildingLevel } from '../game/settlements';
import { deriveSecondary } from '../game/colorUtils';

/** Where the surface structures sit on the upper arc, as fractions of
 *  the framed span (matches the mockup's PART_FRACS; the overlay's
 *  leader lines aim at the same fractions). */
export const PART_FRACS: Record<string, number> = {
  forge: -0.62, mint: -0.15, lab: 0.35, collector: 0.72,
};
const FIRE_FRACS = [-0.62, -0.15, 0.35, 0.55, -0.4];

/** Angle (radians) of an arc fraction on the framed upper limb. */
function arcAngle(frac: number): number {
  return (-90 + frac * 46) * Math.PI / 180;
}

/** Deterministic per-body pseudo-random in [0,1) — stable art, no flicker. */
function hash01(seed: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let c = 0; c < seed.length; c++) { h ^= seed.charCodeAt(c); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

/** The focused body's current screen circle. Exported so the DOM overlay
 *  aims its leader lines / orbs at the exact same geometry. */
export function focusedScreenCircle(
  body: Body, rc: RenderContext,
): { x: number; y: number; r: number } {
  const wp = bodyPosition(body, rc.t, rc.bodies);
  const cp = worldToCanvas(wp.x, wp.y, rc);
  return { x: cp.x, y: cp.y, r: body.radius * rc.camera.scale };
}

/** Shade a #rrggbb color toward black (k<0) or white (k>0) — keeps the
 *  close-up detail in the SAME hue family as the overworld disc, which
 *  is drawn in body.color, so the dive never shifts palette. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return hex;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** A faction colour dimmed to a target luminance, hue intact.
 *
 *  Scaling all three channels preserves the hue exactly, which a fixed
 *  shade() factor does not: the same factor leaves a yellow faction's
 *  skyline twice as bright as a violet one's, and turns a near-white
 *  secondary into a doorway light enough to stop reading as an opening.
 *  Capping instead of scaling means a colour already darker than the cap
 *  is left alone. */
function livery(hex: string, cap: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return hex;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = lum > cap ? cap / lum : 1;
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

/** How much hue a colour actually has, 0..255. A near-neutral secondary
 *  (white, grey, bone) is a fine TRIM but a poor body: dimmed to a
 *  tower's weight it lands as a hueless dark slab, which is the exact
 *  look the livery was meant to get rid of. */
/** Silhouette pools for the city skyline, widening as the settlement
 *  grows. A young colony is silos, domes and low blocks — the things you
 *  put up first. Gantries and stepped terraces arrive with a working
 *  population, and the showpieces (arcology, cooling stack, ring
 *  habitat) only once there are people to fill them, so a city visibly
 *  matures rather than just multiplying the same five shapes.
 *
 *  Held at module scope so widening the pool costs no allocation. */
const SKYLINE_SMALL = [0, 1, 3, 9, 11];
const SKYLINE_MID   = [0, 1, 3, 9, 11, 2, 4, 5];
const SKYLINE_LARGE = [0, 1, 3, 9, 11, 2, 4, 5, 6, 7, 8, 10];

function chroma(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function surfaceDetail(rc: RenderContext, body: Body, c: { x: number; y: number; r: number }, alpha: number) {
  const g = rc.ctx;
  const base = body.color ?? '#8d99a5';
  g.save();
  g.globalAlpha = alpha;
  g.beginPath(); g.arc(c.x, c.y, c.r, 0, Math.PI * 2); g.clip();
  const { x, y, r } = c;
  if (body.type === 'terrestrial') {
    g.fillStyle = shade(base, 0.22);
    blob(g, x - r * 0.3, y - r * 0.4, r * 0.5);
    blob(g, x + r * 0.42, y - r * 0.15, r * 0.34);
    g.fillStyle = shade(base, -0.35);
    blob(g, x - r * 0.05, y + r * 0.45, r * 0.55);
    // Drifting cloud deck — the SAME shared, wall-clock-driven layer the
    // overworld uses, so diving into the world menu keeps the planet's
    // clouds (and keeps them moving) instead of freezing to flat art.
    // Drawn over the continents but before the terminator below, so the
    // night side darkens the clouds too. `alpha` fades it in with the dive.
    drawCloudDeck(rc, body, x, y, r, alpha);
  } else if (body.type === 'gas_giant') {
    g.strokeStyle = shade(base, -0.25); g.lineWidth = r * 0.16;
    band(g, x, y, r, -0.35); band(g, x, y, r, 0.05);
    g.strokeStyle = shade(base, -0.45); g.lineWidth = r * 0.12;
    band(g, x, y, r, -0.15); band(g, x, y, r, 0.3);
    // Same drifting cloud deck as the overworld giant, over the bands.
    drawCloudDeck(rc, body, x, y, r, alpha);
  } else { // moon / dwarf / asteroid — craters
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let i = 0; i < 5; i++) {
      const a = hash01(body.id, i) * Math.PI * 2;
      const d = (0.15 + hash01(body.id, i + 7) * 0.55) * r;
      blob(g, x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.07 + hash01(body.id, i + 13) * 0.12));
    }
    g.fillStyle = shade(base, 0.12);
    blob(g, x - r * 0.45, y - r * 0.2, r * 0.22);
  }
  // Terraformed face (DESIGN-terraforming stage 7): the close-up is
  // where the change should hit hardest. Overlay the cached terraformed
  // texture (same seed as the raw art, so silhouettes match) at the
  // crossfade fraction — full once flipped, partial mid-window — and
  // give the world its new weather.
  const tfF = body.terraformedAtTick != null ? 1
    : body.terraformCompletesAtTick != null ? 0.55 : 0;
  if (tfF > 0) {
    const tfTex = getTerraformedTexture(body);
    if (tfTex) {
      g.save();
      g.globalAlpha = alpha * tfF;
      g.drawImage(tfTex, x - r, y - r, r * 2, r * 2);
      g.restore();
    }
    drawCloudDeck(rc, body, x, y, r, alpha, tfF);
  }
  // terminator — day/night shading, offset toward lower-right
  g.fillStyle = 'rgba(5,8,14,0.3)';
  g.beginPath(); g.arc(x + r * 0.32, y + r * 0.16, r, 0, Math.PI * 2); g.fill();
  g.restore();
  // thin atmosphere ring for terrestrials — and for worlds that grew
  // one by terraforming.
  if (body.type === 'terrestrial' || tfF > 0.2) {
    g.save(); g.globalAlpha = alpha * 0.4 * (body.type === 'terrestrial' ? 1 : tfF);
    g.strokeStyle = '#7fd4ff'; g.lineWidth = Math.max(1, r * 0.012);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.restore();
  }
}
function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function band(g: CanvasRenderingContext2D, x: number, y: number, r: number, off: number) {
  g.beginPath(); g.moveTo(x - r, y + r * off);
  g.quadraticCurveTo(x, y + r * (off - 0.2), x + r, y + r * off); g.stroke();
}

/** Draw one building glyph at an arc fraction. `unit` = 1 glyph-unit in
 *  px, derived from the 0.19·r spec height over the 64-unit glyph. */
function drawBuilding(
  g: CanvasRenderingContext2D, kind: BuildingKind | 'collector', level: number,
  c: { x: number; y: number; r: number }, frac: number, p1: string, p2: string, alpha: number,
) {
  if (level <= 0) return;
  const a = arcAngle(frac);
  const px = c.x + Math.cos(a) * c.r, py = c.y + Math.sin(a) * c.r;
  const unit = (0.19 * c.r) / 64;
  g.save();
  g.globalAlpha = alpha;
  g.translate(px, py);
  g.rotate(a + Math.PI / 2);
  g.scale(unit, unit);
  // An opening still has to read as an opening, so it stays the darkest
  // thing on the building — but in the SECONDARY's hue rather than the
  // near-black it used to be, which punched a hole straight out of the
  // faction's palette.
  const doorway = livery(p2, 40);
  g.fillStyle = p1;
  if (kind === 'forge') {
    g.fillRect(-26, -26, 40, 26);
    g.beginPath(); g.moveTo(-26, -26); g.lineTo(-26, -31); g.lineTo(-6, -41); g.lineTo(14, -31); g.lineTo(14, -26); g.closePath(); g.fill();
    g.fillRect(2, -54, 7, 28);
    g.fillStyle = p2; g.fillRect(2, -58, 7, 4);
    g.fillStyle = doorway; g.fillRect(-12, -9, 6, 9);
    if (level >= 2) { g.fillStyle = p1; g.fillRect(-16, -48, 6, 22); g.fillStyle = p2; g.fillRect(-16, -52, 6, 4); }
    if (level >= 3) { g.fillStyle = p1; g.fillRect(14, -18, 15, 18); g.fillStyle = p2; g.fillRect(18, -24, 4, 6); }
  } else if (kind === 'mint') {
    g.fillRect(-20, -20, 40, 20); g.fillRect(-14, -34, 28, 14);
    g.beginPath(); g.moveTo(-14, -34); g.lineTo(0, -43); g.lineTo(14, -34); g.closePath(); g.fill();
    g.fillStyle = p2; g.beginPath(); g.arc(0, -27, 4.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = doorway; g.fillRect(-13, -15, 4, 15); g.fillRect(-2, -15, 4, 15); g.fillRect(9, -15, 4, 15);
    if (level >= 2) { g.fillStyle = p1; g.fillRect(20, -14, 13, 14); }
    if (level >= 3) { g.fillStyle = p1; g.fillRect(-33, -14, 13, 14); }
  } else if (kind === 'lab') {
    g.beginPath(); g.arc(0, 0, 16, Math.PI, 0); g.closePath(); g.fill();
    g.fillRect(-1.5, -42, 3, 28);
    g.fillStyle = p2; g.beginPath(); g.arc(0, -45, 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = p2; g.lineWidth = 2; g.beginPath(); g.arc(0, -1, 9, Math.PI, 0); g.stroke();
    if (level >= 2) { g.fillStyle = p1; g.beginPath(); g.arc(25, 0, 9, Math.PI, 0); g.closePath(); g.fill(); }
  } else { // collector
    g.fillRect(-2.5, -26, 5, 26);
    g.beginPath(); g.moveTo(-22, -26); g.quadraticCurveTo(0, -48, 22, -26); g.quadraticCurveTo(0, -35, -22, -26); g.closePath(); g.fill();
    g.fillStyle = p2; g.beginPath(); g.arc(0, -46, 3.5, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

let reducedMotion: boolean | null = null;
function prefersReducedMotion(): boolean {
  if (reducedMotion === null) {
    reducedMotion = typeof window !== 'undefined'
      && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return reducedMotion;
}

function drawFire(
  g: CanvasRenderingContext2D, c: { x: number; y: number; r: number },
  ratio: number, t: number, alpha: number,
) {
  const n = flameCount(ratio, FIRE_FRACS.length);
  if (n === 0) return;
  const flicker = prefersReducedMotion() ? () => 1 : (i: number) => 0.75 + 0.25 * Math.sin(t * 9 + i * 2.1);
  for (let i = 0; i < n; i++) {
    const a = arcAngle(FIRE_FRACS[i]);
    const px = c.x + Math.cos(a) * c.r, py = c.y + Math.sin(a) * c.r;
    const s = c.r * 0.085 * flicker(i);
    g.save(); g.globalAlpha = alpha * 0.92; g.translate(px, py); g.rotate(a + Math.PI / 2);
    g.fillStyle = '#ff5a1f';
    g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(-s * 0.55, -s * 0.6, -s * 0.28, -s * 1.15, 0, -s * 1.7);
    g.bezierCurveTo(s * 0.28, -s * 1.15, s * 0.55, -s * 0.6, 0, 0); g.fill();
    g.fillStyle = '#ffca28';
    g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(-s * 0.3, -s * 0.45, -s * 0.15, -s * 0.8, 0, -s * 1.12);
    g.bezierCurveTo(s * 0.15, -s * 0.8, s * 0.3, -s * 0.45, 0, 0); g.fill();
    g.restore();
  }
}

function drawHpTag(
  g: CanvasRenderingContext2D, c: { x: number; y: number; r: number },
  name: string, hp: number, maxHp: number, alpha: number,
) {
  // Small + shifted LEFT of the limb apex: the station rig owns the
  // right side of the sky, so the two never collide. Font/bar sizes
  // are capped in px so a big planet doesn't blow the label up.
  const fpx = Math.min(13, Math.max(9, c.r * 0.026));
  const cx = c.x - c.r * 0.42, cy = c.y - c.r * 1.1;
  const w = Math.min(120, 0.24 * c.r), bh = Math.min(6, c.r * 0.014);
  const ratio = clamp01(hp / Math.max(1, maxHp));
  g.save(); g.globalAlpha = alpha;
  g.font = `700 ${fpx.toFixed(1)}px "Audiowide", monospace`;
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#d6e2ec';
  g.fillText(name.toUpperCase(), cx, cy);
  g.fillStyle = '#0c1219'; g.strokeStyle = '#2a3d50'; g.lineWidth = 1;
  g.fillRect(cx - w / 2, cy + 4, w, bh);
  g.strokeRect(cx - w / 2, cy + 4, w, bh);
  g.fillStyle = hpColor(ratio);
  g.fillRect(cx - w / 2, cy + 4, w * ratio, bh);
  g.fillStyle = '#6b8195';
  g.font = `${Math.max(8, fpx * 0.8).toFixed(1)}px "Audiowide", monospace`;
  g.fillText(`${Math.round(hp)} / ${maxHp}`, cx, cy + 4 + bh + fpx * 0.95);
  g.restore();
}

/**
 * The close-up pass. Call right after the body layer; a no-op below
 * z≈0 (map view) so the map renders untouched until the dive begins.
 */
/**
 * Orbital shields — a dome arcing over the framed city limb.
 *
 * Deliberately NOT a limb building like forge/mint/lab. Those occupy one
 * slot on the surface and get a leader line pointing at them; a shield
 * covers the whole settlement, so it reads as a canopy over everything
 * instead of a structure standing among the towers. That's also why
 * WorldMenuOverlay skips its leader line — there is nothing to point at.
 *
 * The dome's HEIGHT encodes capacity (building level) and its OPACITY
 * encodes charge. A level-3 shield sitting at 10% draws tall and faint:
 * you can see at a glance that the player invested and that the
 * investment is currently spent. Height alone would hide the damage;
 * opacity alone would make a big shield and a small one look identical.
 */
function drawShieldDome(
  g: CanvasRenderingContext2D,
  c: { x: number; y: number; r: number },
  city: Settlement,
  t: number,
  alpha: number,
): void {
  const max = city.shieldHpMax ?? 0;
  if (max <= 0) return;                 // never built, or razed
  const cur = Math.max(0, city.shieldHp ?? 0);
  const frac = clamp01(cur / max);
  if (frac <= 0.005) return;            // collapsed: the canopy is gone

  // Capacity → height. SHIELD_HP_PER_LEVEL is 120, so this reads level
  // back off the pool rather than re-parsing buildings_json.
  const level = Math.max(1, Math.round(max / 120));
  const lift = c.r * (0.11 + Math.min(3, level) * 0.035);
  const rr = c.r + lift;
  // Span the framed limb plus a margin, so the dome visibly encloses the
  // outermost towers instead of clipping them.
  const a0 = arcAngle(-1.12), a1 = arcAngle(1.12);

  // Slow breathing shimmer — alive, but never distracting. Reduced-motion
  // pins it flat.
  const pulse = prefersReducedMotion() ? 1 : 0.88 + 0.12 * Math.sin(t * 0.0014);
  const a = alpha * (0.20 + 0.55 * frac) * pulse;

  g.save();
  const grad = g.createRadialGradient(c.x, c.y, c.r * 0.94, c.x, c.y, rr);
  grad.addColorStop(0, 'rgba(120, 210, 255, 0)');
  grad.addColorStop(0.72, `rgba(120, 210, 255, ${(a * 0.30).toFixed(3)})`);
  grad.addColorStop(1, `rgba(150, 230, 255, ${(a * 0.10).toFixed(3)})`);
  g.beginPath();
  g.arc(c.x, c.y, rr, a0, a1);
  g.arc(c.x, c.y, c.r * 0.94, a1, a0, true);
  g.closePath();
  g.fillStyle = grad;
  g.fill();

  // Bright leading edge — the surface the shots actually stop against.
  g.beginPath();
  g.arc(c.x, c.y, rr, a0, a1);
  g.strokeStyle = `rgba(170, 235, 255, ${a.toFixed(3)})`;
  g.lineWidth = Math.max(1, c.r * 0.006);
  g.stroke();

  // Hex facets, brightest where the shield is healthy. They thin out as
  // the pool drains, so a failing shield looks structurally sparse and
  // not merely dim.
  const ribs = 5 + Math.min(3, level) * 2;
  g.strokeStyle = `rgba(150, 225, 255, ${(a * 0.28).toFixed(3)})`;
  g.lineWidth = Math.max(0.5, c.r * 0.0025);
  for (let i = 1; i < ribs; i++) {
    if (i / ribs > frac + 0.15) continue;
    const ang = a0 + (a1 - a0) * (i / ribs);
    g.beginPath();
    g.moveTo(c.x + Math.cos(ang) * c.r * 0.96, c.y + Math.sin(ang) * c.r * 0.96);
    g.lineTo(c.x + Math.cos(ang) * rr, c.y + Math.sin(ang) * rr);
    g.stroke();
  }
  g.restore();
}

export function drawWorldMenuCloseup(
  rc: RenderContext,
  settlements: Settlement[],
  viewerFactionId: string,
): void {
  const focusId = rc.camera.focusedBodyId;
  if (!focusId) return;
  const body = rc.bodies.find(b => b.id === focusId);
  if (!body || body.type === 'star') return;
  const z = zOf(rc.camera.scale, body, rc.canvas.height);
  if (z < 0.05) return;
  // detail resolves in over the first half of the dive
  const alpha = clamp01(z / 0.5);
  const c = focusedScreenCircle(body, rc);

  surfaceDetail(rc, body, c, alpha);

  const here = settlements.filter(s => s.bodyId === focusId);
  const city = here.find(s => s.type === 'city');
  const faction = rc.factions?.find(f => f.id === (city?.ownedBy ?? viewerFactionId));
  const p1 = faction?.color ?? '#8b6fd0';
  const p2 = (faction as { color2?: string } | undefined)?.color2 || deriveSecondary(p1);

  if (city) {
    // Sci-fi skyline that GROWS with population: more towers, taller
    // spires, lit windows as pop climbs. Slots near the faction-building
    // fracs are skipped so those keep their clearing.
    //
    // The towers were one hardcoded navy — deliberately neutral, so the
    // faction buildings would pop against them. Against a bright
    // terraformed disc that silhouettes as flat black, and a settled
    // world stops reading as ANYBODY'S from orbit. They wear the
    // owner's livery now, dark enough that the full-strength faction
    // buildings still lead the eye.
    //
    // TWO-TONE. Painting every tower in the primary alone made the
    // skyline one flat colour: the secondary only ever appeared on an
    // occasional window strip, which is not enough to read as a livery.
    // Each tower now has a BODY and a CROWN in opposite tones, and
    // roughly half of them run the pairing the other way round, so the
    // horizon carries both colours at tower scale instead of at
    // window scale.
    //
    // Capped rather than shaded by a factor: a yellow faction and a
    // violet one have to sit at the same weight behind the buildings.
    const bodyOf  = [livery(p1, 46), livery(p1, 62)];   // [short, tall]
    const bodyAlt = [livery(p2, 46), livery(p2, 62)];
    // The crown sits above the mass it caps, so it carries more light.
    const crownOf  = livery(p2, 78);
    const crownAlt = livery(p1, 78);
    // Lit edges brighter still — this is the only thing on a tower that
    // is meant to look switched on.
    const litOf  = livery(p2, 116);
    const litAlt = livery(p1, 116);
    const twoWay = chroma(p2) >= 34;
    const g = rc.ctx;
    const pop = Math.max(1, city.population ?? 1);
    const count = Math.min(28, 7 + Math.floor(pop * 2.5));
    const growth = clamp01(pop / 8);
    for (let i = 0; i < count; i++) {
      const fr = -0.9 + (i / Math.max(1, count - 1)) * 1.8 + (hash01(body.id, i + 61) - 0.5) * 0.045;
      if (Object.values(PART_FRACS).some(pf => Math.abs(pf - fr) < 0.07)) continue;
      const a = arcAngle(fr);
      const px = c.x + Math.cos(a) * c.r, py = c.y + Math.sin(a) * c.r;
      const pool = growth > 0.55 ? SKYLINE_LARGE : growth > 0.3 ? SKYLINE_MID : SKYLINE_SMALL;
      const kind = pool[Math.min(pool.length - 1, Math.floor(hash01(body.id, i + 97) * pool.length))];
      const h = c.r * (0.03 + hash01(body.id, i + 31) * (0.045 + 0.085 * growth));
      const w = c.r * (0.007 + hash01(body.id, i + 43) * 0.018);
      g.save(); g.globalAlpha = alpha; g.translate(px, py); g.rotate(a + Math.PI / 2);
      // Which way round this tower runs. Seeded off the body id like
      // every other choice here, so a skyline is identical on every
      // client and from one frame to the next.
      // A faction whose secondary is near-neutral (Moose Authority runs
      // brown on white) keeps every tower body in the primary: white
      // dimmed to a body's weight is a grey slab, and grey slabs are
      // what this whole change was getting rid of. Its white still shows
      // up, on the crowns and lit edges, where a pale trim belongs.
      const flip = twoWay && hash01(body.id, i + 211) > 0.5;
      const tall = h > c.r * 0.075 ? 1 : 0;
      const mass  = flip ? bodyAlt[tall] : bodyOf[tall];
      const crown = flip ? crownAlt : crownOf;
      const lit   = flip ? litAlt : litOf;
      g.fillStyle = mass;
      if (kind === 0) {
        g.fillRect(-w, -h, w * 2, h);
        g.fillStyle = crown; g.fillRect(-w * 0.55, -h * 1.28, w * 1.1, h * 0.3);
      } else if (kind === 1) {
        g.fillRect(-w * 0.5, -h * 1.15, w, h * 1.15);
        g.fillStyle = crown; g.fillRect(-w * 0.16, -h * 1.5, w * 0.32, h * 0.4);
      } else if (kind === 2) {
        g.fillRect(-w * 0.4, -h, w * 0.8, h);
        // Gantry and dish together — the whole rig reads as one fitting
        // bolted onto the tower rather than part of its mass.
        g.fillStyle = crown;
        g.fillRect(-w * 1.6, -h * 0.82, w * 3.2, h * 0.06);
        g.beginPath(); g.arc(0, -h * 1.06, w * 0.6, 0, Math.PI * 2); g.fill();
      } else if (kind === 3) {
        g.beginPath(); g.arc(0, 0, h * 0.42, Math.PI, 0); g.closePath(); g.fill();
        // A dome is one mass, so its two-tone has to be a band at the
        // spring line rather than a cap on top.
        g.fillStyle = crown; g.fillRect(-h * 0.42, -h * 0.055, h * 0.84, h * 0.055);
      } else if (kind === 4) {
        g.fillRect(-w * 1.4, -h * 0.7, w, h * 0.7);
        g.fillRect(w * 0.3, -h, w, h);
        // The linking bridge is the natural accent on a paired block.
        g.fillStyle = crown; g.fillRect(-w * 1.4, -h * 0.74, w * 2.7, h * 0.05);
      } else if (kind === 5) {
        // Stepped terrace — three setbacks, crowned on the top step.
        g.fillRect(-w * 1.25, -h * 0.38, w * 2.5, h * 0.38);
        g.fillRect(-w * 0.85, -h * 0.72, w * 1.7, h * 0.34);
        g.fillRect(-w * 0.45, -h, w * 0.9, h * 0.28);
        g.fillStyle = crown; g.fillRect(-w * 0.2, -h * 1.13, w * 0.4, h * 0.13);
      } else if (kind === 6) {
        // Cooling stack — pinched waist, flared rim. The curve is what
        // makes it read as industrial next to all the straight edges.
        g.beginPath();
        g.moveTo(-w, 0);
        g.quadraticCurveTo(-w * 0.42, -h * 0.55, -w * 0.8, -h);
        g.lineTo(w * 0.8, -h);
        g.quadraticCurveTo(w * 0.42, -h * 0.55, w, 0);
        g.closePath(); g.fill();
        g.fillStyle = crown; g.fillRect(-w * 0.92, -h * 1.06, w * 1.84, h * 0.08);
      } else if (kind === 7) {
        // Arcology — a single mass big enough to live inside, capped at
        // the apex so the peak still carries the trim colour.
        g.beginPath();
        g.moveTo(-w * 1.35, 0); g.lineTo(0, -h); g.lineTo(w * 1.35, 0);
        g.closePath(); g.fill();
        g.fillStyle = crown;
        g.beginPath();
        g.moveTo(-w * 0.46, -h * 0.66); g.lineTo(0, -h); g.lineTo(w * 0.46, -h * 0.66);
        g.closePath(); g.fill();
      } else if (kind === 8) {
        // Twin needles off a shared pad — deliberately uneven, so a pair
        // never reads as one wide tower.
        g.fillRect(-w, -h * 0.18, w * 2, h * 0.18);
        g.fillRect(-w * 0.62, -h, w * 0.28, h);
        g.fillRect(w * 0.34, -h * 0.78, w * 0.24, h * 0.78);
        g.fillStyle = crown;
        g.fillRect(-w * 0.6, -h * 1.12, w * 0.24, h * 0.13);
        g.fillRect(w * 0.36, -h * 0.9, w * 0.2, h * 0.13);
      } else if (kind === 9) {
        // Tank farm — three squat cylinders of unequal height with domed
        // caps. The first thing a colony builds and the last it removes.
        const xs = [-w * 0.82, 0, w * 0.82];
        const hs = [h * 0.62, h * 0.86, h * 0.5];
        for (let k = 0; k < 3; k++) g.fillRect(xs[k] - w * 0.3, -hs[k], w * 0.6, hs[k]);
        g.fillStyle = crown;
        for (let k = 0; k < 3; k++) {
          g.beginPath(); g.arc(xs[k], -hs[k], w * 0.3, Math.PI, 0); g.closePath(); g.fill();
        }
      } else if (kind === 10) {
        // Ring habitat on a pylon — the one curved outline in the set,
        // which is what makes it read from a long way out.
        g.fillRect(-w * 0.13, -h * 0.62, w * 0.26, h * 0.62);
        g.strokeStyle = crown; g.lineWidth = Math.max(0.6, w * 0.22);
        g.beginPath(); g.arc(0, -h * 0.86, w * 0.72, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(0, -h * 0.86, w * 0.2, 0, Math.PI * 2); g.fill();
      } else {
        // Solar array — almost no height, so it breaks up a horizon that
        // would otherwise be all verticals.
        g.fillRect(-w * 0.45, -h * 0.22, w * 0.9, h * 0.22);
        g.fillStyle = crown;
        g.beginPath();
        g.moveTo(-w * 1.5, -h * 0.28); g.lineTo(w * 1.25, -h * 0.6);
        g.lineTo(w * 1.25, -h * 0.5); g.lineTo(-w * 1.5, -h * 0.18);
        g.closePath(); g.fill();
      }
      if (growth > 0.4 && kind <= 1 && hash01(body.id, i + 151) > 0.55) {
        g.fillStyle = lit; g.globalAlpha = alpha * 0.85; g.fillRect(-w * 0.3, -h * 0.8, w * 0.6, h * 0.05);
      }
      g.restore();
    }
    for (const kind of ['forge', 'mint', 'lab'] as BuildingKind[]) {
      drawBuilding(rc.ctx, kind, buildingLevel(city, kind), c, PART_FRACS[kind], p1, p2, alpha);
    }
    if (city.hasCollector) drawBuilding(rc.ctx, 'collector', 1, c, PART_FRACS.collector, p1, p2, alpha);
    drawShieldDome(rc.ctx, c, city, rc.t, alpha);
    drawHpTag(rc.ctx, c, city.name, city.hp, city.maxHp, alpha);
    drawFire(rc.ctx, c, city.hp / Math.max(1, city.maxHp), rc.t, alpha);
  }
}
