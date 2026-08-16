// ============================================================
// FX primitives — the game's combat and body visuals, in pure
// canvas terms.
//
// Everything here was lifted out of combatFx.ts and mapRenderer.ts
// unchanged. Those modules now call these, so there is exactly one
// definition of what a tracer, a blast, a wreck or a lit sphere looks
// like in this game.
//
// The reason to split them out is the battle recap: it draws the same
// fight on its own canvas with its own layout, and a recap whose
// explosions merely RESEMBLE the ones on the map is a recap of a
// different game. None of these take a RenderContext — they take
// canvas coordinates and a normalized life fraction, which is the only
// thing a caller outside the map can supply.
//
// Timing rules are unchanged: callers own the clock, these own the
// pixels. `k` is always 0→1 across the effect's life.
// ============================================================

import { withOpacity, lighten } from './colors';
import { hashStr, mulberry32 } from './planetTexture';

// ---- shared constants (were private to combatFx) ---------------------

export const TRACER_LIFE_MS = 140;
export const ENERGY_COLOR = '#7fd4ff';
export const ENERGY_CORE = '#e8fbff';

export const DETONATION_LIFE_MS = 500;
export const DETONATION_CORE_MS = 60;
export const DETONATION_RING_PX = 48;
const DETONATION_SPARKS = 6;
const DETONATION_SPARK_DIST = 30;

export const DEBRIS_LIFE_MS = 400;

/** Axial tilt of a rendered sphere, radians. The map is a top-down view
 *  of the orbital plane, so a planet's spin axis really points up out of
 *  the screen; drawing it dead side-on reads flat. Leaning the surface
 *  ~20° gives a 3/4 read instead. */
export const PLANET_AXIAL_TILT = 0.35;

// ---- weapons ---------------------------------------------------------

/**
 * One bolt in flight, from (fx,fy) to (tx,ty).
 *
 * Kinetic is a 2px line in the SHOOTER's faction primary with a bright
 * head dot at the impact end — the head is what reads as the shell
 * landing. Energy is a different weapon and looks like one: a wide cyan
 * glow under a thin white-hot core. Both blend additively, so the caller
 * must have opened a `lighter` pass.
 *
 * `head` exists for callers that draw a bolt in pieces — the battle
 * recap cuts one against the world it passes behind. Only the piece
 * carrying the real leading edge should get the bright dot; without
 * this, every cut left an impact flash sitting on the terminator.
 */
export function drawBolt(
  c: CanvasRenderingContext2D,
  fx: number, fy: number, tx: number, ty: number,
  color: string, alpha: number, energy: boolean,
  head = true,
): void {
  if (energy) {
    c.strokeStyle = withOpacity(ENERGY_COLOR, 0.4 * alpha);
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(fx, fy);
    c.lineTo(tx, ty);
    c.stroke();
    c.strokeStyle = withOpacity(ENERGY_CORE, alpha);
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(fx, fy);
    c.lineTo(tx, ty);
    c.stroke();
    if (head) {
      c.fillStyle = withOpacity(ENERGY_CORE, alpha);
      c.beginPath();
      c.arc(tx, ty, 2.5, 0, Math.PI * 2);
      c.fill();
    }
    return;
  }
  c.strokeStyle = withOpacity(color, alpha);
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(fx, fy);
  c.lineTo(tx, ty);
  c.stroke();
  if (head) {
    c.fillStyle = withOpacity(lighten(color, 1.5), alpha);
    c.beginPath();
    c.arc(tx, ty, 2.5, 0, Math.PI * 2);
    c.fill();
  }
}

/**
 * Muzzle flash at the firing end — a brief hot bloom oriented down the
 * barrel. Not in the map's repertoire (at map zoom a fleet's muzzles
 * would be a strobe), but a recap frames one fight at close range, where
 * a bolt appearing out of nothing looks wrong.
 */
export function drawMuzzleFlash(
  c: CanvasRenderingContext2D,
  x: number, y: number, ang: number,
  color: string, alpha: number, scale = 1,
): void {
  const len = 9 * scale;
  const g = c.createLinearGradient(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
  g.addColorStop(0, withOpacity(lighten(color, 1.8), alpha));
  g.addColorStop(1, withOpacity(color, 0));
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(x, y);
  c.arc(x, y, len, ang - 0.45, ang + 0.45);
  c.closePath();
  c.fill();
}

// ---- destruction -----------------------------------------------------

/**
 * A ship or settlement going up: white core flash for the first 60ms,
 * an expanding shockwave ring, and seeded debris sparks. `k` runs 0→1
 * over DETONATION_LIFE_MS. `seed` keys the spark scatter so every client
 * draws the same blast. Additive; caller opens the pass.
 */
export function drawBlast(
  c: CanvasRenderingContext2D,
  x: number, y: number, k: number, seed: string, scale = 1,
): void {
  const easeOut = 1 - (1 - k) * (1 - k);
  const coreK = DETONATION_CORE_MS / DETONATION_LIFE_MS;

  if (k < coreK) {
    const coreAlpha = 1 - k / coreK;
    c.fillStyle = `rgba(255, 255, 255, ${coreAlpha})`;
    c.beginPath();
    c.arc(x, y, 10 * scale, 0, Math.PI * 2);
    c.fill();
  }

  const ringR = (4 + (DETONATION_RING_PX - 4) * easeOut) * scale;
  c.strokeStyle = `rgba(255, 230, 190, ${0.9 * (1 - k)})`;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, ringR, 0, Math.PI * 2);
  c.stroke();

  const rng = mulberry32(hashStr(seed));
  const sparkDist = DETONATION_SPARK_DIST * easeOut * scale;
  c.fillStyle = `rgba(255, 200, 140, ${1 - k})`;
  for (let s = 0; s < DETONATION_SPARKS; s++) {
    const ang = rng() * Math.PI * 2;
    c.beginPath();
    c.arc(x + Math.cos(ang) * sparkDist, y + Math.sin(ang) * sparkDist, 1.5 * scale, 0, Math.PI * 2);
    c.fill();
  }
}

/**
 * 4–6 sparks flying off a dying hull, on angles seeded from its id.
 * `k` runs 0→1 over DEBRIS_LIFE_MS. Additive; caller opens the pass.
 */
export function drawDebris(
  c: CanvasRenderingContext2D,
  x: number, y: number, baseRadius: number, k: number, seed: string,
): void {
  const easeOut = 1 - (1 - k) * (1 - k);
  const rng = mulberry32(hashStr(seed));
  const count = 4 + Math.floor(rng() * 3);
  const dist = baseRadius * 0.6 + (baseRadius * 1.4 + 12) * easeOut;
  c.fillStyle = `rgba(255, 210, 150, ${1 - k})`;
  for (let s = 0; s < count; s++) {
    const ang = rng() * Math.PI * 2;
    const size = 1 + rng();
    c.beginPath();
    c.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, size / 2 + 0.5, 0, Math.PI * 2);
    c.fill();
  }
}

/**
 * Charred tumbling shards at a kill site, with an ember glint on one of
 * them that cools as `k` runs 0→1 over the wreck's life. `tumbleMs` is
 * wall clock — the shards keep turning while the wreck sits there.
 * NOT additive: a wreck is cold, and drawing it `lighter` made kill
 * sites glow like the blast that made them.
 */
export function drawWreckShards(
  c: CanvasRenderingContext2D,
  x: number, y: number, size: number, k: number, seed: string, tumbleMs: number,
): void {
  const alpha = k < 0.66 ? 0.55 : 0.55 * (1 - (k - 0.66) / 0.34);
  const base = mulberry32(hashStr(seed));
  const tumble = tumbleMs / 4000 + ((hashStr(seed) % 1000) / 1000) * Math.PI * 2;
  for (let s = 0; s < 3; s++) {
    const a = tumble + (s * Math.PI * 2) / 3 + base() * 0.8;
    const d = size * (0.35 + base() * 0.5);
    const shard = size * (0.3 + base() * 0.25);
    c.save();
    c.translate(x + Math.cos(a) * d, y + Math.sin(a) * d);
    c.rotate(a * 1.7);
    c.fillStyle = `rgba(96, 84, 72, ${alpha.toFixed(3)})`;
    c.fillRect(-shard / 2, -shard / 4, shard, shard / 2);
    if (s === 0 && k < 0.4) {
      c.fillStyle = `rgba(255, 140, 60, ${(alpha * (1 - k / 0.4) * 0.8).toFixed(3)})`;
      c.fillRect(-shard / 4, -shard / 8, shard / 2, shard / 4);
    }
    c.restore();
  }
}

/** One burning hull/settlement: 1-3 flickering fires + smoke puffs
 *  drifting off the anchor. Cheap — arcs only, no gradients; additive
 *  fires over normal-blend smoke. Severity 0..1 scales everything. */
export function drawBurn(
  c: CanvasRenderingContext2D,
  x: number, y: number, baseR: number,
  sev: number, nowMs: number, seed: number,
): void {
  const ph = ((seed % 1000) / 1000) * Math.PI * 2;
  // Smoke first (normal blend, under the fire) — puffs cycling outward.
  const puffs = 2 + Math.round(sev);
  for (let i = 0; i < puffs; i++) {
    const drift = ((nowMs / 1400) + i / puffs + ph) % 1;
    const sx = x + Math.cos(ph + i * 2.4) * baseR * 0.3 + drift * baseR * 0.5;
    const sy = y - drift * baseR * 1.1;
    c.fillStyle = `rgba(48, 54, 62, ${((1 - drift) * 0.25 * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(sx, sy, baseR * (0.22 + drift * 0.3), 0, Math.PI * 2);
    c.fill();
  }
  // Fires (additive) — slow flicker, per-entity phase.
  c.save();
  c.globalCompositeOperation = 'lighter';
  const fires = 1 + Math.round(sev * 2);
  for (let i = 0; i < fires; i++) {
    const a = ph + i * 2.3;
    const fx = x + Math.cos(a) * baseR * 0.4;
    const fy = y + Math.sin(a) * baseR * 0.4;
    const f = 0.55 + 0.45 * Math.sin(nowMs / 130 + i * 2 + ph);
    const r = baseR * (0.28 + 0.18 * sev) * (0.7 + 0.5 * f);
    c.fillStyle = `rgba(255, 150, 50, ${(0.4 * f * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(fx, fy - r * 0.25, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = `rgba(255, 240, 190, ${(0.75 * f * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(fx, fy - r * 0.25, r * 0.4, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

/**
 * Shield flare — a bright arc on the impact side of a hull that took a
 * hit and survived. Reads the difference between "hit" and "killed"
 * without a number, which is most of what a recap frame has to say.
 */
export function drawShieldFlare(
  c: CanvasRenderingContext2D,
  x: number, y: number, r: number, ang: number, alpha: number, color = '#8fd8ff',
): void {
  c.strokeStyle = withOpacity(color, alpha);
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, r, ang - 0.9, ang + 0.9);
  c.stroke();
}

// ---- bodies ----------------------------------------------------------

/**
 * Draw a cached planet texture into a disk, optionally scrolled
 * horizontally with wraparound so the surface reads as rotating.
 *
 * The SURFACE is tilted, not the silhouette — the disk stays a circle
 * and the sun-relative terminator is applied later, unrotated, so
 * lighting stays correct. The 2r-square texture still covers the
 * r-radius clip circle at any rotation.
 */
export function drawTexturedDisk(
  c: CanvasRenderingContext2D,
  tex: CanvasImageSource,
  x: number, y: number, r: number,
  drift: number,
  tilt: number = PLANET_AXIAL_TILT,
): void {
  c.save();
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.clip();
  c.translate(x, y);
  c.rotate(tilt);
  c.translate(-x, -y);
  const d = r * 2;
  if (drift > 0.5) {
    const off = drift % d;
    c.drawImage(tex, x - r + off - d, y - r, d, d);
    c.drawImage(tex, x - r + off, y - r, d, d);
  } else {
    c.drawImage(tex, x - r, y - r, d, d);
  }
  c.restore();
}

/**
 * Terminator plus specular kiss: the night side falls off along the
 * light direction, and the day side keeps a soft highlight so the disk
 * still reads spherical. `(ldx, ldy)` is the unit vector pointing AWAY
 * from the light.
 */
export function drawSphereLighting(
  c: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  ldx: number, ldy: number,
): void {
  const g = c.createLinearGradient(x - ldx * r, y - ldy * r, x + ldx * r, y + ldy * r);
  g.addColorStop(0, 'rgba(2, 6, 12, 0)');
  g.addColorStop(0.5, 'rgba(2, 6, 12, 0)');
  g.addColorStop(0.62, 'rgba(2, 6, 12, 0.55)');
  g.addColorStop(0.8, 'rgba(2, 6, 12, 0.9)');
  g.addColorStop(1, 'rgba(2, 6, 12, 0.94)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();

  const hx = x - ldx * r * 0.45;
  const hy = y - ldy * r * 0.45;
  const hl = c.createRadialGradient(hx, hy, 0, hx, hy, r * 0.9);
  hl.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  hl.addColorStop(1, 'rgba(255, 255, 255, 0)');
  c.fillStyle = hl;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

// ---- ships under way -------------------------------------------------
//
// Lifted out of mapRenderer unchanged. The recap flies reinforcements in
// on their own engines, so it needs the real plume — including the
// per-class bell geometry, which is what makes a destroyer's burn read
// as a destroyer's.

const PLUME_SHAPE: Record<string, { len: number; width: number; bells: number }> = {
  corvette:  { len: 1.5,  width: 0.7, bells: 1 },
  frigate:   { len: 1.0,  width: 1.0, bells: 1 },
  destroyer: { len: 1.1,  width: 1.4, bells: 3 },
  freighter: { len: 0.75, width: 1.5, bells: 1 },
  colony:    { len: 0.9,  width: 1.1, bells: 1 },
};

export function drawThrustExhaust(
  ctx2d: CanvasRenderingContext2D,
  enginePos: { x: number; y: number },
  thrustDir: { x: number; y: number },
  shipSize: number,
  intensity: number = 1,
  shipClass?: string,
) {
  // Sized to the ship icon, so the plume reads as this hull's exhaust
  // rather than a banner streaking across the map — and since shipSize
  // IS the icon's on-screen size, it tracks the ship at every zoom.
  // Base ≈ the ship's beam (half-width 0.26 → full 0.52·icon), length a
  // touch over one icon. Was 2.4·icon long / 0.84·icon wide — a cone
  // several times the hull, which read as "too big".
  const shape = PLUME_SHAPE[shipClass ?? ''] ?? { len: 1, width: 1, bells: 1 };
  const flameLen = shipSize * 1.35 * shape.len;
  const flameWidth = shipSize * 0.26 * shape.width;
  // Exhaust extends OPPOSITE to thrust.
  const tailX = enginePos.x - thrustDir.x * flameLen;
  const tailY = enginePos.y - thrustDir.y * flameLen;
  // Perpendicular for the flame's flared base near the engine bell.
  const perpX = -thrustDir.y;
  const perpY = thrustDir.x;
  // Per-frame jitter for a "live" flicker. Random is fine — the
  // unpredictability is the point. Cheap enough to do every frame.
  // Scaled down with the smaller plume so the wag stays proportional.
  const jitterMag = shipSize * 0.12;
  const jitterT = (Math.random() - 0.5) * 2 * jitterMag;       // tail wag
  const jitterP = (Math.random() - 0.5) * jitterMag * 0.3;     // base wiggle
  const lenJitter = (Math.random() - 0.5) * shipSize * 0.22;   // length pulse

  // Gradient: hot core at the engine bell, cooling out to the tail.
  const grad = ctx2d.createLinearGradient(
    enginePos.x, enginePos.y,
    tailX, tailY,
  );
  grad.addColorStop(0,    `rgba(255, 245, 200, ${0.95 * intensity})`);
  grad.addColorStop(0.25, `rgba(255, 180, 90,  ${0.70 * intensity})`);
  grad.addColorStop(0.7,  `rgba(255, 90, 50,   ${0.25 * intensity})`);
  grad.addColorStop(1,     'rgba(255, 60, 30, 0)');

  ctx2d.save();
  // Blending: the BODY of the plume paints normally, only the small hot
  // core is additive. Making the whole cone additive (the first cut)
  // looked great over black space but summed past white over anything
  // bright — a destroyer crossing a lit gas giant painted a solid white
  // triangle bigger than the ship (live screenshot at Uranus). Normal
  // blend keeps the plume translucent over planets while the additive
  // core still gives the nozzle its glow against the void.
  // Destroyer-style multi-bell: two smaller side cones flanking the
  // main plume, offset along the beam. Drawn first so the core sits on top.
  if (shape.bells >= 3) {
    const sideW = flameWidth * 0.45;
    const sideLen = flameLen * 0.6;
    for (const side of [-1, 1]) {
      const bx = enginePos.x + perpX * flameWidth * 0.85 * side;
      const by = enginePos.y + perpY * flameWidth * 0.85 * side;
      ctx2d.fillStyle = `rgba(255, 150, 70, ${0.35 * intensity})`;
      ctx2d.beginPath();
      ctx2d.moveTo(bx + perpX * sideW, by + perpY * sideW);
      ctx2d.lineTo(bx - perpX * sideW, by - perpY * sideW);
      ctx2d.lineTo(bx - thrustDir.x * sideLen, by - thrustDir.y * sideLen);
      ctx2d.closePath();
      ctx2d.fill();
    }
  }
  ctx2d.fillStyle = grad;
  ctx2d.beginPath();
  // Flared base near the engine nozzle.
  ctx2d.moveTo(
    enginePos.x + perpX * (flameWidth + jitterP),
    enginePos.y + perpY * (flameWidth + jitterP),
  );
  ctx2d.lineTo(
    enginePos.x - perpX * (flameWidth - jitterP),
    enginePos.y - perpY * (flameWidth - jitterP),
  );
  // Tapered tail with side-to-side wag.
  ctx2d.lineTo(
    tailX - thrustDir.x * lenJitter + perpX * jitterT,
    tailY - thrustDir.y * lenJitter + perpY * jitterT,
  );
  ctx2d.closePath();
  ctx2d.fill();

  // Hot inner core — a smaller, brighter triangle layered over the
  // outer flame so the engine bell reads as the brightest point. THIS is
  // the additive part: small enough that blowing out to white is the
  // desired look (an engine bell IS blindingly bright) without washing
  // over a planet behind it.
  ctx2d.globalCompositeOperation = 'lighter';
  const coreLen = flameLen * 0.45;
  const coreW = flameWidth * 0.55;
  const coreTailX = enginePos.x - thrustDir.x * coreLen;
  const coreTailY = enginePos.y - thrustDir.y * coreLen;
  const coreGrad = ctx2d.createLinearGradient(
    enginePos.x, enginePos.y,
    coreTailX, coreTailY,
  );
  coreGrad.addColorStop(0, `rgba(255, 255, 235, ${0.95 * intensity})`);
  coreGrad.addColorStop(1, `rgba(255, 200, 100, 0)`);
  ctx2d.fillStyle = coreGrad;
  ctx2d.beginPath();
  ctx2d.moveTo(enginePos.x + perpX * coreW, enginePos.y + perpY * coreW);
  ctx2d.lineTo(enginePos.x - perpX * coreW, enginePos.y - perpY * coreW);
  ctx2d.lineTo(coreTailX, coreTailY);
  ctx2d.closePath();
  ctx2d.fill();
  ctx2d.restore();
}

/** Veteran mark: gold, screen-aligned, never rotated with the hull. */
const RANK_CHEVRON_COLOR = '#ffd166';

export function drawRankChevron(
  c2d: CanvasRenderingContext2D,
  canvasPos: { x: number; y: number },
  iconSize: number,
) {
  const y = canvasPos.y - iconSize / 2 - 4;
  c2d.save();
  c2d.strokeStyle = RANK_CHEVRON_COLOR;
  c2d.lineWidth = 2;
  c2d.lineJoin = 'miter';
  c2d.beginPath();
  c2d.moveTo(canvasPos.x - 4, y);
  c2d.lineTo(canvasPos.x, y - 3.5);
  c2d.lineTo(canvasPos.x + 4, y);
  c2d.stroke();
  c2d.restore();
}

export function drawRetreatWake(
  c2d: CanvasRenderingContext2D,
  canvasPos: { x: number; y: number },
  heading: number,
  iconSize: number,
  secondary: string,
  nowMs?: number,
  shipId?: string,
) {
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  const perpX = -sinH;
  const perpY = cosH;
  const rng = mulberry32(
    hashStr(shipId ?? 'wake') ^ Math.floor((nowMs ?? performance.now()) / 110));
  c2d.save();
  for (let s = 0; s < 3; s++) {
    const off = (s - 1) * iconSize * 0.28 + (rng() - 0.5) * 2;
    const len = 9 + rng() * 9;
    const x0 = canvasPos.x - cosH * iconSize / 2 + perpX * off;
    const y0 = canvasPos.y - sinH * iconSize / 2 + perpY * off;
    c2d.strokeStyle = withOpacity(secondary, 0.2 + 0.25 * rng());
    c2d.lineWidth = s === 1 ? 1.4 : 1;
    c2d.beginPath();
    c2d.moveTo(x0, y0);
    c2d.lineTo(x0 - cosH * len, y0 - sinH * len);
    c2d.stroke();
  }
  c2d.restore();
}
