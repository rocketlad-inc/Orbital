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
  /** Mid-plume colour. Defaults to the map's orange. */
  tint?: [number, number, number],
) {
  const [tr, tg, tb] = tint ?? [255, 180, 90];
  // Sized to the ship icon, so the plume reads as this hull's exhaust
  // rather than a banner streaking across the map — and since shipSize
  // IS the icon's on-screen size, it tracks the ship at every zoom.
  // Base ≈ the ship's beam (half-width 0.26 → full 0.52·icon), length a
  // touch over one icon. Was 2.4·icon long / 0.84·icon wide — a cone
  // several times the hull, which read as "too big".
  const shape = PLUME_SHAPE[shipClass ?? ''] ?? { len: 1, width: 1, bells: 1 };
  const flameLen = shipSize * 1.35 * shape.len;
  const flameWidth = shipSize * 0.19 * shape.width;
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
  grad.addColorStop(0.25, `rgba(${tr}, ${tg}, ${tb},  ${0.70 * intensity})`);
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

/**
 * Warm window-light scatter on the night side of a settled world.
 *
 * Same treatment as the map's drawNightLights — a seeded scatter with one
 * window in ten on a slow independent flicker — reduced to what a caller
 * outside the map can supply: the disc, the light direction, and a
 * surface angle per city. A settled world whose dark side stays black is
 * a world nobody lives on.
 */
export function drawNightLights(
  c: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  ldx: number, ldy: number,
  cityAngles: number[],
  seed: string,
  nowMs: number,
): void {
  if (!cityAngles.length) return;
  let clipped = false;
  for (let ci = 0; ci < cityAngles.length; ci++) {
    const a = cityAngles[ci];
    // Only glow where the surface faces AWAY from the light.
    if (Math.cos(a) * ldx + Math.sin(a) * ldy < 0.15) continue;
    if (!clipped) {
      c.save();
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.clip();
      clipped = true;
    }
    const rand = mulberry32(hashStr(`${seed}:city${ci}`));
    for (let i = 0; i < 8; i++) {
      const rr = r * (0.68 + rand() * 0.26);
      const ja = a + (rand() - 0.5) * 0.55;
      c.fillStyle = i % 3 === 0 ? '#ffb84d' : '#ffd27a';
      let alpha = 0.5 + rand() * 0.5;
      const flick = rand();
      if (flick < 0.1) alpha *= 0.5 + 0.5 * Math.sin(nowMs / 1400 + i * 1.7 + flick * 60);
      c.globalAlpha = alpha;
      c.beginPath();
      c.arc(x + Math.cos(ja) * rr, y + Math.sin(ja) * rr, 0.9 + rand() * 0.8, 0, Math.PI * 2);
      c.fill();
    }
  }
  if (clipped) { c.globalAlpha = 1; c.restore(); }
}

// The contested-body ring lived here and is gone. It was decorative and
// it read as decoration: a dashed hoop sitting between a world and the
// fleet fighting over it, adding nothing the shooting itself does not
// already say. The map keeps its own; the recaps do not need one.

// ---- ordnance at close range -----------------------------------------
//
// drawBlast above is the MAP's explosion: a 2px ring, a brief white core
// and six dots, sized for a body forty pixels wide where it reads as a
// quick pop. Put a camera on it and push in, and three independent
// reviewers looked straight at a ship being destroyed and described "a
// ring of four white dots inside a thin grey circle — a wireframe
// hit-test gizmo". They were not wrong: at close range that primitive
// has nothing in it that resembles a fireball.
//
// These are the close-range versions. Same seeded determinism, same
// additive discipline, an order of magnitude more substance.

export const FIREBALL_LIFE_MS = 900;

/**
 * A ship coming apart: a white-hot core blowing out through yellow and
 * orange, a thick shockwave that outruns it, debris thrown on seeded
 * angles with motion trails, and smoke that lingers after the light is
 * gone. `k` runs 0→1 over FIREBALL_LIFE_MS.
 *
 * The caller does NOT open an additive pass — this one manages its own,
 * because the smoke has to be normal-blended or it turns into more fire.
 */
export function drawFireball(
  c: CanvasRenderingContext2D,
  x: number, y: number, k: number, seed: string, scale = 1,
): void {
  const t = Math.max(0, Math.min(1, k));
  const ease = 1 - (1 - t) * (1 - t);
  const rng = mulberry32(hashStr(seed + ':fire'));
  const R = 34 * scale;

  // Smoke first, under everything, and it outlives the flame.
  c.save();
  const puffs = 7;
  for (let i = 0; i < puffs; i++) {
    const a = rng() * Math.PI * 2;
    const d = R * (0.25 + rng() * 0.75) * ease;
    const pr = R * (0.30 + rng() * 0.34) * (0.5 + ease);
    const al = 0.30 * (1 - t) * (t > 0.18 ? 1 : t / 0.18);
    if (al <= 0.01) continue;
    const gx = x + Math.cos(a) * d, gy = y + Math.sin(a) * d - R * 0.18 * ease;
    const gr = c.createRadialGradient(gx, gy, 0, gx, gy, pr);
    gr.addColorStop(0, `rgba(58, 52, 48, ${al.toFixed(3)})`);
    gr.addColorStop(1, 'rgba(40, 36, 34, 0)');
    c.fillStyle = gr;
    c.beginPath(); c.arc(gx, gy, pr, 0, Math.PI * 2); c.fill();
  }
  c.restore();

  c.save();
  c.globalCompositeOperation = 'lighter';

  if (t < 0.14) {
    const fa = 1 - t / 0.14;
    const fr = R * (0.5 + t * 4);
    const fg = c.createRadialGradient(x, y, 0, x, y, fr);
    fg.addColorStop(0, `rgba(255, 255, 250, ${(0.95 * fa).toFixed(3)})`);
    fg.addColorStop(0.5, `rgba(255, 232, 190, ${(0.5 * fa).toFixed(3)})`);
    fg.addColorStop(1, 'rgba(255, 210, 150, 0)');
    c.fillStyle = fg;
    c.beginPath(); c.arc(x, y, fr, 0, Math.PI * 2); c.fill();
  }

  // The fireball itself — a real gradient, not a flat disc.
  const coreR = R * (0.22 + ease * 0.85);
  const heat = Math.max(0, 1 - t * 1.35);
  if (heat > 0.01) {
    const gr = c.createRadialGradient(x, y, 0, x, y, coreR);
    gr.addColorStop(0, `rgba(255, 255, 245, ${(0.98 * heat).toFixed(3)})`);
    gr.addColorStop(0.28, `rgba(255, 226, 138, ${(0.92 * heat).toFixed(3)})`);
    gr.addColorStop(0.58, `rgba(255, 146, 48, ${(0.66 * heat).toFixed(3)})`);
    gr.addColorStop(0.82, `rgba(196, 62, 20, ${(0.34 * heat).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(120, 30, 10, 0)');
    c.fillStyle = gr;
    c.beginPath(); c.arc(x, y, coreR, 0, Math.PI * 2); c.fill();
  }

  // There is deliberately no shock ring. Three separate tunings of one
  // and it still read as a pale circle drawn AROUND the fire rather than
  // as part of it -- a reviewer called it a wireframe hit-test gizmo.
  // Heat, debris and smoke carry the blast on their own.

  // Debris. Short trails at uneven speeds: thirteen even spokes of equal
  // length is a starburst glyph, not wreckage. Gone well before the
  // smoke is, so the tail of the effect is smoke rather than a diagram.
  const shards = 8 + Math.floor(rng() * 8);
  const debT = Math.min(1, t / 0.62);
  for (let i = 0; i < shards; i++) {
    const a = rng() * Math.PI * 2;
    const speed = 0.35 + rng() * rng() * 1.35;
    const d = R * speed * (1 - (1 - debT) * (1 - debT)) * 0.82;
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    const al = (1 - debT) * (1 - debT) * (0.5 + rng() * 0.45);
    if (al <= 0.02) continue;
    // Trails curve off the radius and taper. Straight uniform spokes of
    // equal length are a starburst glyph -- reviewers called them straws.
    const tl = Math.min(R * 0.3, d * (0.2 + rng() * 0.22));
    const bend = (rng() - 0.5) * 0.7;
    const gx = px - Math.cos(a + bend) * tl, gy = py - Math.sin(a + bend) * tl;
    const gr2 = c.createLinearGradient(px, py, gx, gy);
    const tone = Math.round(160 + rng() * 80);
    gr2.addColorStop(0, `rgba(255, ${tone}, 90, ${al.toFixed(3)})`);
    gr2.addColorStop(1, `rgba(220, ${tone}, 80, 0)`);
    c.strokeStyle = gr2;
    c.lineWidth = Math.max(0.7, (0.8 + rng() * 1.1) * scale);
    c.beginPath();
    c.moveTo(px, py);
    c.quadraticCurveTo(
      px - Math.cos(a) * tl * 0.6, py - Math.sin(a) * tl * 0.6, gx, gy);
    c.stroke();
  }
  c.restore();
}

/**
 * Where a round lands on something that survives it. A bright bloom
 * flattened along the hull's facing, so an impact reads as an impact and
 * not as a second, smaller muzzle flash.
 */
export function drawImpactFlash(
  c: CanvasRenderingContext2D,
  x: number, y: number, k: number, color: string, scale = 1,
): void {
  const t = Math.max(0, Math.min(1, k));
  const a = (1 - t) * (1 - t);
  if (a <= 0.01) return;
  const r = (7 + 17 * t) * scale;
  const gr = c.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, withOpacity('#ffffff', a));
  gr.addColorStop(0.35, withOpacity(color, a * 0.85));
  gr.addColorStop(1, withOpacity(color, 0));
  c.fillStyle = gr;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  // A quick ring. Short-lived and tight to the hit, so it reads as the
  // round arriving rather than as a circle drawn on the frame.
  if (t < 0.5) {
    const ra = (1 - t / 0.5) * 0.75;
    c.strokeStyle = withOpacity('#ffffff', ra);
    c.lineWidth = Math.max(0.8, 2.2 * scale * (1 - t / 0.5));
    c.beginPath();
    c.arc(x, y, r * (0.5 + t * 1.1), 0, Math.PI * 2);
    c.stroke();
  }
  // Sparks off the plating.
  if (t < 0.7) {
    const sa = (1 - t / 0.7);
    const rng = mulberry32(Math.round(x * 7 + y * 13));
    c.strokeStyle = withOpacity('#ffe9c4', sa * 0.8);
    c.lineWidth = Math.max(0.6, 1 * scale);
    for (let i = 0; i < 5; i++) {
      const ang = rng() * Math.PI * 2;
      const d0 = r * 0.35, d1 = r * (0.7 + rng() * 1.15) * (0.4 + t);
      c.beginPath();
      c.moveTo(x + Math.cos(ang) * d0, y + Math.sin(ang) * d0);
      c.lineTo(x + Math.cos(ang) * d1, y + Math.sin(ang) * d1);
      c.stroke();
    }
  }
}



/**
 * What is left where a hull died, at recap range.
 *
 * The map's version is three five-pixel rectangles in gunmetal grey. On
 * a black field at recap zoom that is nothing at all -- three reviewers
 * independently reported that kills in this view leave no trace, on a
 * feature whose entire subject is who died. This is a broken hull that
 * tumbles, cools from ember to cold metal over the first third of its
 * life, keeps a rim of its owner's colour so a wreck still has a side,
 * and sheds fragments that drift away from it.
 */
export function drawWreck(
  c: CanvasRenderingContext2D,
  x: number, y: number, size: number, k: number, seed: string,
  tumbleMs: number, color: string,
): void {
  const t = Math.max(0, Math.min(1, k));
  const alpha = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
  if (alpha <= 0.02) return;
  const rng = mulberry32(hashStr(seed));
  const spin = tumbleMs / 5200 + ((hashStr(seed) % 997) / 997) * Math.PI * 2;
  const heat = Math.max(0, 1 - t / 0.34);

  // Fragments, thrown clear and still going.
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    const d = size * (0.5 + rng() * 1.5) * (0.35 + t * 0.9);
    const fr = size * (0.1 + rng() * 0.12);
    c.save();
    c.globalAlpha = alpha * 0.8;
    c.translate(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7);
    c.rotate(spin * (1 + rng()) + a);
    c.fillStyle = i % 2 === 0 ? '#4a4740' : withOpacity(color, 0.45);
    c.fillRect(-fr, -fr * 0.4, fr * 2, fr * 0.8);
    c.restore();
  }

  // The hull itself: a torn slab, not a rectangle.
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y);
  c.rotate(spin);
  const w = size * 0.9, h = size * 0.38;
  c.beginPath();
  c.moveTo(-w * 0.5, -h * 0.5);
  c.lineTo(w * 0.22, -h * 0.62);
  c.lineTo(w * 0.5, -h * 0.1);
  c.lineTo(w * 0.18, h * 0.5);
  c.lineTo(-w * 0.34, h * 0.44);
  c.closePath();
  const face = c.createLinearGradient(-w * 0.5, -h, w * 0.5, h);
  face.addColorStop(0, '#6b6559');
  face.addColorStop(0.55, '#403c34');
  face.addColorStop(1, '#26241f');
  c.fillStyle = face;
  c.fill();
  c.strokeStyle = withOpacity(color, 0.55);
  c.lineWidth = 1.2;
  c.stroke();
  // A torn edge along the break, glowing while it is still hot.
  if (heat > 0.01) {
    c.strokeStyle = `rgba(255, ${Math.round(110 + heat * 90)}, 50, ${(heat * 0.9).toFixed(3)})`;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(w * 0.18, h * 0.5);
    c.lineTo(-w * 0.34, h * 0.44);
    c.stroke();
  }
  c.restore();

  if (heat > 0.01) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    const gr = c.createRadialGradient(x, y, 0, x, y, size * 0.85);
    gr.addColorStop(0, `rgba(255, 150, 60, ${(heat * 0.5 * alpha).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(255, 110, 40, 0)');
    c.fillStyle = gr;
    c.beginPath(); c.arc(x, y, size * 0.85, 0, Math.PI * 2); c.fill();
    c.restore();
  }
}

/**
 * A recap tracer. The map's bolt is drawn for a camera two thousand
 * pixels out, where a flat stroke with a bright cap on each end is
 * exactly right. At recap range that same stroke reads as a capsule
 * lying in space -- three reviewers used the word 'glowstick'. This one
 * fades to nothing at the tail and carries its heat at the head.
 *
 * Energy fire keeps the FACTION's colour rather than a universal white,
 * because during the climax every beam being the same colour meant you
 * could not tell who was winning an exchange without reading the HUD.
 */
export function drawTaperedBolt(
  c: CanvasRenderingContext2D,
  fx: number, fy: number, tx: number, ty: number,
  color: string, alpha: number, energy: boolean,
): void {
  const core = lighten(color, energy ? 2.4 : 1.7);
  const g1 = c.createLinearGradient(fx, fy, tx, ty);
  g1.addColorStop(0, withOpacity(color, 0));
  g1.addColorStop(0.42, withOpacity(color, 0.06 * alpha));
  g1.addColorStop(0.72, withOpacity(color, 0.3 * alpha));
  g1.addColorStop(1, withOpacity(color, 0.62 * alpha));
  c.strokeStyle = g1;
  c.lineWidth = energy ? 1.8 : 1.3;
  c.lineCap = 'butt';
  c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty); c.stroke();
  const g2 = c.createLinearGradient(fx, fy, tx, ty);
  g2.addColorStop(0, withOpacity(core, 0));
  g2.addColorStop(0.68, withOpacity(core, 0.42 * alpha));
  g2.addColorStop(1, withOpacity(core, alpha));
  c.strokeStyle = g2;
  c.lineWidth = energy ? 0.9 : 0.7;
  c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty); c.stroke();
}

/**
 * A bolt with a glow under it. drawBolt is the map's tracer, correct at
 * map zoom and thin as wire at close range — reviewers read a fleet's
 * fire as "constant-width line segments, a debugging visualisation of
 * targeting vectors". This lays a soft wide pass under the same core so
 * the round has heat around it.
 */
export function drawBoltGlow(
  c: CanvasRenderingContext2D,
  fx: number, fy: number, tx: number, ty: number,
  color: string, alpha: number, energy: boolean, scale = 1,
): void {
  c.lineCap = 'butt';
  const halo = c.createLinearGradient(fx, fy, tx, ty);
  halo.addColorStop(0, withOpacity(color, 0));
  halo.addColorStop(0.55, withOpacity(color, alpha * 0.07));
  halo.addColorStop(1, withOpacity(color, alpha * 0.2));
  c.strokeStyle = halo;
  c.lineWidth = 4.2 * scale;
  c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty); c.stroke();
  const inner = c.createLinearGradient(fx, fy, tx, ty);
  const lit = lighten(color, energy ? 1.8 : 1.3);
  inner.addColorStop(0, withOpacity(lit, 0));
  inner.addColorStop(0.6, withOpacity(lit, alpha * 0.14));
  inner.addColorStop(1, withOpacity(lit, alpha * 0.4));
  c.strokeStyle = inner;
  c.lineWidth = 2 * scale;
  c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty); c.stroke();
}
