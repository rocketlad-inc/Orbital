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

import { drawnRadiusOf } from './bodyPresentation';
import { Body, BuildingKind, Settlement } from '../types';
import { RenderContext, worldToCanvas, drawCloudDeck } from './mapRenderer';
import { getTerraformedTexture, globeKeyOf } from './planetTexture';
import { isLightweight } from './lightweightMode';
import { bodyPosition } from '../physics/orbitalMechanics';
import { zOf, clamp01, arcSpreadDeg } from '../game/worldMenu/camera';
import { hpColor, flameCount } from '../game/worldMenu/combatDisplay';
import { buildingLevel } from '../game/settlements';
import { deriveSecondary } from '../game/colorUtils';
import { drawSkylineStructure, dimHex } from './settlementArt';
import { drawHullFire } from './fxArt';
import {
  drawStructure, drawPlot, drawSite, drawPad, drawQueueBadge, drawFocusGlow, edgeLivery, STRUCTURE_BODY,
} from './structureArt';
import {
  SURFACE_STRUCTURES, structureUnit, structureTop, structureHalfWidth,
} from '../game/worldMenu/structures';
import { getWorldMenuStructures, getWorldMenuStructureFocus, type StructureSlot } from '../game/worldMenu/store';

/** Where the surface structures sit on the upper arc, as fractions of
 *  the framed span (matches the mockup's PART_FRACS; the overlay's
 *  leader lines aim at the same fractions). */
export const PART_FRACS: Record<string, number> = {
  forge: -0.62, mint: -0.15, lab: 0.35, missile_silo: 0.62, collector: 0.78,
};

/** Degrees per unit of arc fraction for THIS frame (arcSpreadDeg): 46 on a
 *  desktop, narrower on a phone. Set at the top of each close-up draw. */
let spreadDeg = 46;

/** Angle (radians) of an arc fraction on the framed upper limb. */
function arcAngle(frac: number): number {
  return (-90 + frac * spreadDeg) * Math.PI / 180;
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
  // The DRAWN disc (bodyPresentation), which is true scale by the time a
  // menu has settled but larger on the way in; detail painted on the true
  // circle floated inside the enlarged globe.
  return { x: cp.x, y: cp.y, r: drawnRadiusOf(rc.presentation, body, rc.camera.scale) };
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


/** How much hue a colour actually has, 0..255. A near-neutral secondary
 *  (white, grey, bone) is a fine TRIM but a poor body: dimmed to a
 *  tower's weight it lands as a hueless dark slab, which is the exact
 *  look the livery was meant to get rid of. */
function chroma(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return Math.max(r, g, b) - Math.min(r, g, b);
}

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

function surfaceDetail(rc: RenderContext, body: Body, c: { x: number; y: number; r: number }, alpha: number) {
  // Visual overhaul (staging): a real-map world is already on this disc,
  // turning, with its own terminator, terraform crossfade and rim light
  // (drawBody → globeSpin). The painted continents, bands and craters
  // below were stand-ins for the procedural texture; drawn over a real
  // globe they hid it and froze its spin, so they are skipped.
  if (globeKeyOf(body) !== null) return;
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
  if (tfF > 0 && !isLightweight()) {
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


let reducedMotion: boolean | null = null;
function prefersReducedMotion(): boolean {
  if (reducedMotion === null) {
    reducedMotion = typeof window !== 'undefined'
      && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return reducedMotion;
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



/**
 * THE TERRAFORM RING: on a raw world, a band above the horizon that fills
 * as the payload lands — metal from the left, credits from the right — so
 * the world itself says how close it is. Once both are in, the whole band
 * glows green for the change window.
 */
function drawTerraformRing(
  g: CanvasRenderingContext2D,
  body: Body,
  c: { x: number; y: number; r: number },
  cost: { costMetal: number; costCredits: number },
  tick: number,
  t: number,
  alpha: number,
): void {
  const acc = body.terraformAcc ?? { metal: 0, credits: 0 };
  const windowOpen = body.terraformCompletesAtTick != null;
  const mF = clamp01(acc.metal / Math.max(1, cost.costMetal));
  const cF = clamp01(acc.credits / Math.max(1, cost.costCredits));
  if (!windowOpen && mF <= 0 && cF <= 0) return;
  const rr = c.r * 1.045;
  const lw = Math.max(3, c.r * 0.012);
  const left0 = arcAngle(-0.95), mid = arcAngle(0), right1 = arcAngle(0.95);
  const gap = 0.012;
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = 'round';
  g.lineWidth = lw;
  const band = (from: number, to: number, color: string) => {
    if (to <= from) return;
    g.strokeStyle = color;
    g.beginPath(); g.arc(c.x, c.y, rr, from, to); g.stroke();
  };
  if (windowOpen) {
    // Both payloads in: the whole band breathes green until the change.
    const pulse = prefersReducedMotion() ? 1 : 0.75 + 0.25 * Math.sin(t * 0.003);
    g.globalAlpha = alpha * pulse;
    band(left0, right1, '#6ee7b7');
  } else {
    band(left0, mid - gap, 'rgba(201, 212, 222, 0.16)');
    band(mid + gap, right1, 'rgba(255, 209, 102, 0.16)');
    band(mid - gap - (mid - gap - left0) * mF, mid - gap, '#c9d4de');
    band(mid + gap, mid + gap + (right1 - mid - gap) * cF, '#ffd166');
  }
  g.restore();
}

export interface CloseupExtras {
  terraformConfig?: { costMetal: number; costCredits: number; durationTicks?: number };
  tick?: number;
}

export function drawWorldMenuCloseup(
  rc: RenderContext,
  settlements: Settlement[],
  viewerFactionId: string,
  extras: CloseupExtras = {},
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
  spreadDeg = arcSpreadDeg(rc.canvas.width, rc.canvas.height);

  surfaceDetail(rc, body, c, alpha);

  if (body.terraformedAtTick == null) {
    drawTerraformRing(rc.ctx, body, c,
      extras.terraformConfig ?? { costMetal: 124, costCredits: 124 }, extras.tick ?? 0, rc.t, alpha);
  }

  const here = settlements.filter(s => s.bodyId === focusId);
  const city = here.find(s => s.type === 'city');
  const faction = rc.factions?.find(f => f.id === (city?.ownedBy ?? viewerFactionId));
  const p1 = faction?.color ?? '#8b6fd0';
  const p2 = (faction as { color2?: string } | undefined)?.color2 || deriveSecondary(p1);

  if (city) {
    const slots = structureSlotsFor(city, viewerFactionId);
    drawSkyline(rc.ctx, body, c, city, p1, p2, slots, alpha);
    drawShieldDome(rc.ctx, c, city, rc.t, alpha);
    drawStructures(rc.ctx, c, city, viewerFactionId, p1, slots, extras.tick ?? 0, rc.t, alpha);
    // A rival's city wears its name and hit points on the world; yours are
    // in the menu's header, and here they sat under your structure tags.
    if (city.ownedBy !== viewerFactionId) drawHpTag(rc.ctx, c, city.name, city.hp, city.maxHp, alpha);
  }
}

/** Where each surface structure stands. Your own city: exactly under its
 *  tag (the overlay publishes the angles it placed the tags at). A rival's,
 *  or yours before the tags exist: spread evenly over the framed limb. */
const FALLBACK_FRACS: Record<string, number> = { forge: -0.7, mint: -0.35, shields: 0, lab: 0.35, missile_silo: 0.7 };
function structureSlotsFor(city: Settlement, viewerFactionId: string): StructureSlot[] {
  const published = city.ownedBy === viewerFactionId ? getWorldMenuStructures() : null;
  if (published && published.length) return published;
  return SURFACE_STRUCTURES.map(kind => ({
    kind, theta: (FALLBACK_FRACS[kind] * spreadDeg) * Math.PI / 180, locked: false,
  }));
}

/**
 * THE SKYLINE: the city's own towers behind the structures, exactly as
 * they were before the structures were redrawn (Lorne, 2026-10-20: the
 * cityscape art stays). It GROWS with population: more towers, taller
 * spires, lit windows as pop climbs, the shape pool widening as it
 * matures. A tower that would stand on a structure's footprint is
 * skipped, so every structure keeps its clearing.
 *
 * TWO-TONE in the owner's livery: each tower has a body and a crown in
 * opposite tones, and roughly half run the pairing the other way round,
 * so the horizon carries both colours at tower scale. A faction whose
 * secondary is near-neutral keeps every tower body in the primary.
 * Dimmed so the structures in front still lead the eye.
 */
function drawSkyline(
  g: CanvasRenderingContext2D, body: Body, c: { x: number; y: number; r: number },
  city: Settlement, p1: string, p2: string, slots: StructureSlot[], alpha: number,
): void {
  const twoWay = chroma(p2) >= 34;
  const pop = Math.max(1, city.population ?? 1);
  const count = Math.min(28, 7 + Math.floor(pop * 2.5));
  const growth = clamp01(pop / 8);
  const u = structureUnit(c.r);
  const clear = slots.map(sl => ({
    th: sl.theta,
    half: (structureHalfWidth(sl.kind, buildingLevel(city, sl.kind as BuildingKind)) * u + c.r * 0.012) / c.r,
  }));
  for (let i = 0; i < count; i++) {
    const fr = -0.9 + (i / Math.max(1, count - 1)) * 1.8 + (hash01(body.id, i + 61) - 0.5) * 0.045;
    const th = (fr * spreadDeg) * Math.PI / 180;
    if (clear.some(k => Math.abs(k.th - th) < k.half)) continue;
    const a = arcAngle(fr);
    const px = c.x + Math.cos(a) * c.r, py = c.y + Math.sin(a) * c.r;
    const pool = growth > 0.55 ? SKYLINE_LARGE : growth > 0.3 ? SKYLINE_MID : SKYLINE_SMALL;
    const kind = pool[Math.min(pool.length - 1, Math.floor(hash01(body.id, i + 97) * pool.length))];
    const h = c.r * (0.03 + hash01(body.id, i + 31) * (0.045 + 0.085 * growth));
    const w = c.r * (0.007 + hash01(body.id, i + 43) * 0.018);
    g.save(); g.globalAlpha = alpha; g.translate(px, py); g.rotate(a + Math.PI / 2);
    // Seeded off the body id like every other choice here, so a skyline
    // is identical on every client and from one frame to the next.
    const flip = twoWay && hash01(body.id, i + 211) > 0.5;
    const k = h > c.r * 0.075 ? 0.8 : 0.66;
    const [pa, pb] = flip ? [p2, p1] : [p1, p2];
    const windowsOn = growth > 0.4 && kind <= 1 && hash01(body.id, i + 151) > 0.55;
    drawSkylineStructure(g, kind, w, h, dimHex(pa, k), dimHex(pb, k), windowsOn);
    g.restore();
  }
}

/**
 * THE STRUCTURES: one under every tag, always (structureArt.ts draws
 * them). Built: its silhouette at its level, edges in the owner's livery.
 * Not built: a plot, padlocked when research gates it. Building: the
 * scaffold and crane with its ring. Next in the queue: a teal ghost of
 * the level coming, with its place in line. Hovered or picked (the tag's
 * twin): lit amber. A rival's city shows only what is built.
 */
function drawStructures(
  g: CanvasRenderingContext2D, c: { x: number; y: number; r: number }, city: Settlement,
  viewerFactionId: string, p1: string, slots: StructureSlot[], tick: number, t: number, alpha: number,
): void {
  const mine = city.ownedBy === viewerFactionId;
  const u = structureUnit(c.r);
  const edge = edgeLivery(p1);
  const focus = mine ? getWorldMenuStructureFocus() : null;
  const q = city.buildingQueue;
  const backlog = city.buildingBacklog ?? [];
  // Damage: fires on the built structures, as many as the city's hull
  // ratio calls for (combatDisplay.flameCount, the hulls' own rule).
  const ratio = city.hp / Math.max(1, city.maxHp);
  const builtKinds = slots.filter(sl => buildingLevel(city, sl.kind as BuildingKind) > 0).map(sl => sl.kind);
  const burning = new Set(builtKinds.slice(0, flameCount(ratio, builtKinds.length)));
  const nowMs = prefersReducedMotion() ? 0 : t * 1000;
  for (const sl of slots) {
    const kind = sl.kind;
    const level = buildingLevel(city, kind as BuildingKind);
    const building = q?.kind === kind;
    if (!mine && level === 0) continue;
    const queuedAt = backlog.findIndex(o => o.kind === kind);
    const hl = focus === kind;
    const hw = structureHalfWidth(kind, level);
    g.save();
    g.globalAlpha = alpha;
    g.translate(c.x + Math.sin(sl.theta) * c.r, c.y - Math.cos(sl.theta) * c.r);
    g.rotate(sl.theta);
    g.scale(u, u);
    if (hl) drawFocusGlow(g, hw);
    if (level === 0 && !building) {
      drawPlot(g, sl.locked, hl);
    } else {
      drawPad(g, hw - 2);
      if (level > 0) {
        const siloState = kind === 'missile_silo'
          ? { stock: mine && city.missileSilo ? city.missileSilo.stock : null,
              building: mine && city.missileSilo && city.missileSilo.orders.length > 0 ? 1 : 0 }
          : undefined;
        drawStructure(g, kind, level, { edge: hl ? '#ffd27a' : edge, body: STRUCTURE_BODY, glow: hl ? 1 : 0.95 }, siloState);
      } else {
        drawPlot(g, false, hl);
      }
    }
    if (building && q) {
      const span = Math.max(1, q.completeTick - q.startTick);
      drawSite(g, clamp01((tick - q.startTick) / span));
    } else if (mine && queuedAt >= 0) {
      g.save();
      g.globalAlpha *= 0.4;
      drawStructure(g, kind, Math.max(level + 1, backlog[queuedAt].targetLevel ?? level + 1),
        { edge: '#4ecdc4', body: null, glow: 0, dash: [3, 2] });
      g.restore();
      drawQueueBadge(g, queuedAt + 1, hw, -structureTop(kind, level + 1, false) - 6);
    }
    if (burning.has(kind)) {
      const sev = Math.min(1, 0.45 + (1 - ratio) * 0.7);
      drawHullFire(g, 0, -structureTop(kind, level, false) * 0.55, 26, sev, nowMs, 0x6f1e + kind.length * 977);
    }
    g.restore();
  }
}
