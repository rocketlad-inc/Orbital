// ============================================================
// Megastructure art — the slipway, and the seven things it produces.
//
// THE BUILD IS THE STORY. Terraforming taught this: a world does not
// flip from raw to green, it blooms, and the bloom is what makes anyone
// care that they paid for it. A megastructure takes thirty freighter
// runs, which is far longer than a terraform, so it gets FIVE readable
// states instead of one transition — a player checking back should be
// able to tell at a glance how far their money has got without opening
// a panel.
//
//   FOUNDATION  a bare hex frame, unlit. Nothing has been delivered.
//   FRAME       spars close the ring; the first work-lights blink on.
//   SKIN        hull plating fills between the spars, kind colour shows.
//   POWER       the structure is whole and energy starts running it.
//   COMPLETE    its own sprite, and it stops being a building site.
//
// Everything here draws in the map's existing vocabulary — layered
// radial blooms, struck rings, a slow spin, a sine pulse — because a
// megastructure that looked like it came from a different game would
// read as a UI overlay rather than a thing in the sky.
//
// Canvas, not SVG: these sit in the body-drawing hot path alongside
// every planet, and they animate every frame.
// ============================================================

import type { MegastructureKind } from '../game/megastructures';

/** How far through the build each visual stage begins. */
export const BUILD_STAGES = [
  { at: 0.00, name: 'Foundation' },
  { at: 0.25, name: 'Frame' },
  { at: 0.50, name: 'Plating' },
  { at: 0.75, name: 'Powering up' },
] as const;

/** The stage label for a progress fraction — also used by the panel, so
 *  the words under the bar match the shape on the map. */
export function buildStageName(progress: number): string {
  let name = BUILD_STAGES[0].name as string;
  for (const s of BUILD_STAGES) if (progress >= s.at) name = s.name;
  return name;
}

type G = CanvasRenderingContext2D;

/** Vertices of a regular polygon, rotated. */
function poly(g: G, cx: number, cy: number, r: number, n: number, rot: number) {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

/** Deterministic 0..1 from an integer — for spark placement that is
 *  stable frame to frame rather than jittering. */
function h01(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// ------------------------------------------------------------
// THE SLIPWAY
// ------------------------------------------------------------

/**
 * A site under construction. One sprite for all seven, because from any
 * distance an unfinished gate and an unfinished gun platform ARE the
 * same thing: a frame somebody is pouring freight into. What differs is
 * how much of it exists.
 */
export function drawConstructionSite(
  g: G,
  cx: number, cy: number, R: number,
  progress: number,
  tint: string,
  nowMs: number,
  /** Draws the finished form, faded in under the scaffold once the
   *  structure starts powering up. */
  ghost?: () => void,
) {
  const p = Math.max(0, Math.min(1, progress));
  const spin = (nowMs / 14000) % (Math.PI * 2);   // slow: this is heavy
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 1100);

  g.save();

  // --- Foundation: the hex frame is there from the first delivery, so
  // the site always reads as a deliberate object rather than a marker.
  g.strokeStyle = 'rgba(122, 148, 170, 0.75)';
  g.lineWidth = Math.max(1, R * 0.09);
  poly(g, cx, cy, R, 6, spin);
  g.stroke();

  // Six radial struts, growing outward from the hub as the frame closes.
  const strutF = Math.min(1, p / 0.25);
  if (strutF > 0) {
    g.strokeStyle = 'rgba(150, 176, 198, 0.6)';
    g.lineWidth = Math.max(1, R * 0.06);
    for (let i = 0; i < 6; i++) {
      const a = spin + (i / 6) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * R * strutF, cy + Math.sin(a) * R * strutF);
      g.stroke();
    }
  }

  // --- Frame: an inner ring closes, and cross-bracing appears.
  if (p >= 0.25) {
    const f = Math.min(1, (p - 0.25) / 0.25);
    g.strokeStyle = 'rgba(168, 194, 214, 0.72)';
    g.lineWidth = Math.max(1, R * 0.07);
    g.beginPath();
    g.arc(cx, cy, R * 0.58, spin, spin + Math.PI * 2 * f);
    g.stroke();
  }

  // --- Plating: wedges fill in between the struts. This is the stage
  // that reads as "it is becoming a thing" — the silhouette goes from
  // skeletal to solid, and it takes the structure's own colour.
  if (p >= 0.5) {
    const f = Math.min(1, (p - 0.5) / 0.25);
    const filled = Math.round(6 * f);
    // Opaque-ish. At 0.20 the panels were invisible against the frame
    // and the whole "it is becoming a thing" beat was lost — 60% built
    // looked the same as 35%. Hull plating should read as HULL.
    g.fillStyle = withAlpha(tint, 0.42);
    g.strokeStyle = withAlpha(tint, 0.85);
    g.lineWidth = Math.max(1, R * 0.06);
    for (let i = 0; i < filled; i++) {
      const a0 = spin + (i / 6) * Math.PI * 2;
      const a1 = spin + ((i + 1) / 6) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a0) * R * 0.58, cy + Math.sin(a0) * R * 0.58);
      g.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
      g.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
      g.lineTo(cx + Math.cos(a1) * R * 0.58, cy + Math.sin(a1) * R * 0.58);
      g.closePath();
      g.fill();
      g.stroke();
      // A seam down the middle of each panel. Cheap, and it is what
      // stops a filled wedge reading as a coloured gap.
      const am = (a0 + a1) / 2;
      g.save();
      g.strokeStyle = 'rgba(12, 20, 28, 0.5)';
      g.lineWidth = Math.max(0.6, R * 0.03);
      g.beginPath();
      g.moveTo(cx + Math.cos(am) * R * 0.58, cy + Math.sin(am) * R * 0.58);
      g.lineTo(cx + Math.cos(am) * R, cy + Math.sin(am) * R);
      g.stroke();
      g.restore();
    }
  }

  // --- Powering up: the hub lights and a charge ring runs round it.
  if (p >= 0.75) {
    const f = Math.min(1, (p - 0.75) / 0.25);
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.5);
    core.addColorStop(0, withAlpha(tint, 0.65 * f * (0.7 + 0.3 * pulse)));
    core.addColorStop(1, withAlpha(tint, 0));
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = withAlpha(tint, 0.5 + 0.4 * pulse);
    g.lineWidth = Math.max(1, R * 0.05);
    g.beginPath();
    g.arc(cx, cy, R * 0.78, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
    g.stroke();

    // A ghost of the finished thing, fading up underneath the scaffold.
    // Until now every structure looked identical right up to the moment
    // it finished, so the last quarter of a thirty-run project told a
    // player nothing about what they were about to get.
    if (ghost) {
      g.save();
      g.globalAlpha = 0.35 * f;
      ghost();
      g.restore();
    }
  }

  // --- Work lights. Small blinking flecks on the frame, out of phase
  // with each other. They are the cheapest possible "somebody is here
  // right now" cue, and they stop while the site is untouched at 0%.
  if (p > 0.02 && R >= 7) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const blink = Math.sin(nowMs / (520 + i * 190) + i * 2.1);
      if (blink < 0.3) continue;
      const a = spin * (i % 2 ? -1 : 1) + h01(i) * Math.PI * 2;
      const rr = R * (0.62 + 0.34 * h01(i + 40));
      g.fillStyle = `rgba(255, 226, 160, ${0.5 + 0.5 * blink})`;
      g.beginPath();
      g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, Math.max(0.8, R * 0.055), 0, Math.PI * 2);
      g.fill();
    }
  }

  // --- The progress arc, outermost. The one thing a rival needs from
  // across the map: how long have I got.
  g.strokeStyle = withAlpha(tint, 0.9);
  g.lineWidth = Math.max(1.6, R * 0.11);
  g.lineCap = 'butt';
  g.beginPath();
  g.arc(cx, cy, R * 1.22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
  g.stroke();
  g.strokeStyle = 'rgba(140, 165, 185, 0.22)';
  g.lineWidth = Math.max(1, R * 0.06);
  g.beginPath();
  g.arc(cx, cy, R * 1.22, 0, Math.PI * 2);
  g.stroke();

  g.restore();
}

// ------------------------------------------------------------
// THE FINISHED THINGS
// ------------------------------------------------------------

/**
 * A completed structure. Five of the seven end up here — the two mobile
 * ones launch as hulls and their site is spent, so they never have a
 * finished form on the map.
 */
export function drawCompletedStructure(
  g: G,
  cx: number, cy: number, R: number,
  kind: MegastructureKind,
  tint: string,
  nowMs: number,
) {
  switch (kind) {
    case 'warp_gate':       return drawWarpGate(g, cx, cy, R, tint, nowMs);
    case 'weapons_station': return drawWeaponsStation(g, cx, cy, R, tint, nowMs);
    case 'gravity_sink':    return drawGravitySink(g, cx, cy, R, tint, nowMs);
    case 'deep_array':      return drawDeepArray(g, cx, cy, R, tint, nowMs);
    case 'null_field':      return drawNullField(g, cx, cy, R, tint, nowMs);
    default:                return drawGenericComplete(g, cx, cy, R, tint, nowMs);
  }
}

/**
 * A door. The flagship structure, and it was falling through to a plain
 * ring — the least interesting thing on the board for the one a player
 * spends thirty-one freighter runs on.
 *
 * Built in the same layers as the discovered-gate sprite it shares a
 * lineage with: outer bloom, a lit throat you can read as "somewhere
 * else", a structural ring, and pylons on a slow spin that say this was
 * BUILT rather than found.
 */
function drawWarpGate(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 5200) % (Math.PI * 2);
  const pulse = 0.5 + 0.5 * Math.sin(now / 900);
  g.save();

  bloom(g, cx, cy, R * 2.4, tint, 0.18 + 0.07 * pulse);

  // The throat. Bright at the centre and dark at the rim, so it reads as
  // depth rather than as a disc.
  const throat = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.84);
  throat.addColorStop(0, `rgba(232, 250, 255, ${0.9 * (0.7 + 0.3 * pulse)})`);
  throat.addColorStop(0.45, withAlpha(tint, 0.6));
  throat.addColorStop(1, 'rgba(18, 32, 78, 0.92)');
  g.fillStyle = throat;
  g.beginPath();
  g.arc(cx, cy, R * 0.84, 0, Math.PI * 2);
  g.fill();

  // Event horizon: a thin bright rim right at the aperture.
  g.strokeStyle = `rgba(200, 244, 255, ${0.6 + 0.35 * pulse})`;
  g.lineWidth = Math.max(1, R * 0.06);
  g.beginPath();
  g.arc(cx, cy, R * 0.84, 0, Math.PI * 2);
  g.stroke();

  // Structural ring.
  g.strokeStyle = 'rgba(198, 226, 246, 0.92)';
  g.lineWidth = Math.max(1.5, R * 0.17);
  g.beginPath();
  g.arc(cx, cy, R * 1.05, 0, Math.PI * 2);
  g.stroke();

  // Four pylons, spinning slowly. The "somebody assembled this" cue.
  g.strokeStyle = 'rgba(214, 234, 250, 0.8)';
  g.lineWidth = Math.max(1, R * 0.12);
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = spin + (i / 4) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02);
    g.lineTo(cx + Math.cos(a) * R * 1.42, cy + Math.sin(a) * R * 1.42);
    g.stroke();
  }

  g.restore();
}

/** Guns: an angular platform, four barrels, a targeting sweep. Reads as
 *  aggressive at a glance — hard edges where everything else is round. */
function drawWeaponsStation(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 9000) % (Math.PI * 2);
  const charge = 0.5 + 0.5 * Math.sin(now / 700);
  g.save();

  bloom(g, cx, cy, R * 2.1, tint, 0.13 + 0.05 * charge);

  // Barrels first, so the hull sits over their roots.
  g.strokeStyle = withAlpha(tint, 0.85);
  g.lineWidth = Math.max(1.4, R * 0.15);
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = spin + (i / 4) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5);
    g.lineTo(cx + Math.cos(a) * R * 1.5, cy + Math.sin(a) * R * 1.5);
    g.stroke();
    // Muzzle glow, so it reads as loaded rather than derelict.
    g.fillStyle = `rgba(255, 210, 170, ${0.4 + 0.5 * charge})`;
    g.beginPath();
    g.arc(cx + Math.cos(a) * R * 1.5, cy + Math.sin(a) * R * 1.5,
          Math.max(1, R * 0.11), 0, Math.PI * 2);
    g.fill();
  }

  // Angular hull — a square, deliberately, against a sky of circles.
  g.fillStyle = 'rgba(30, 22, 20, 0.92)';
  g.strokeStyle = withAlpha(tint, 0.95);
  g.lineWidth = Math.max(1.2, R * 0.1);
  poly(g, cx, cy, R * 0.86, 4, spin + Math.PI / 4);
  g.fill();
  g.stroke();

  // Targeting reticle, sweeping.
  g.strokeStyle = withAlpha(tint, 0.55);
  g.lineWidth = Math.max(1, R * 0.05);
  g.beginPath();
  g.arc(cx, cy, R * 0.55, spin * 2.4, spin * 2.4 + 1.1);
  g.stroke();

  g.restore();
}

/** A well. Concentric rings pulled INWARD — the only thing on the map
 *  that animates toward its own centre, which is the whole read. */
function drawGravitySink(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  g.save();
  bloom(g, cx, cy, R * 2.3, tint, 0.12);

  // Four rings marching in, respawning at the rim. The inward direction
  // is the entire idea: everything else in this game radiates.
  for (let i = 0; i < 4; i++) {
    const phase = ((now / 2600) + i / 4) % 1;
    const rr = R * (1.7 - 1.35 * phase);
    const a = (1 - Math.abs(phase - 0.5) * 2) * 0.7;
    g.strokeStyle = withAlpha(tint, a);
    g.lineWidth = Math.max(1, R * 0.09 * (0.5 + phase));
    g.beginPath();
    g.arc(cx, cy, Math.max(1, rr), 0, Math.PI * 2);
    g.stroke();
  }

  // The throat: darker than space, so it reads as a hole rather than a
  // light. Nothing else on the board is drawn subtractively like this.
  const well = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.72);
  well.addColorStop(0, 'rgba(4, 2, 10, 0.98)');
  well.addColorStop(0.7, withAlpha(tint, 0.35));
  well.addColorStop(1, withAlpha(tint, 0));
  g.fillStyle = well;
  g.beginPath();
  g.arc(cx, cy, R * 0.72, 0, Math.PI * 2);
  g.fill();

  g.restore();
}

/** Dishes. Three of them on a slow sweep, with a scan arc that widens
 *  and fades — reads as listening rather than shooting. */
function drawDeepArray(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 11000) % (Math.PI * 2);
  g.save();
  bloom(g, cx, cy, R * 2.0, tint, 0.11);

  // Scan pulse: a ring that expands and dies, once every few seconds.
  const sweep = (now / 3200) % 1;
  g.strokeStyle = withAlpha(tint, 0.5 * (1 - sweep));
  g.lineWidth = Math.max(1, R * 0.07);
  g.beginPath();
  g.arc(cx, cy, R * (0.9 + 1.6 * sweep), 0, Math.PI * 2);
  g.stroke();

  // Mast.
  g.strokeStyle = 'rgba(190, 210, 224, 0.8)';
  g.lineWidth = Math.max(1, R * 0.1);
  for (let i = 0; i < 3; i++) {
    const a = spin + (i / 3) * Math.PI * 2;
    const dx = cx + Math.cos(a) * R * 0.95;
    const dy = cy + Math.sin(a) * R * 0.95;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(dx, dy);
    g.stroke();
    // Dish: an arc facing outward, filled thinly so it reads as concave.
    g.fillStyle = withAlpha(tint, 0.35);
    g.strokeStyle = withAlpha(tint, 0.9);
    g.lineWidth = Math.max(1, R * 0.07);
    g.beginPath();
    g.arc(dx, dy, R * 0.42, a - 2.2, a + 2.2);
    g.fill();
    g.stroke();
    g.strokeStyle = 'rgba(190, 210, 224, 0.8)';
    g.lineWidth = Math.max(1, R * 0.1);
  }

  g.fillStyle = 'rgba(18, 30, 34, 0.95)';
  g.strokeStyle = withAlpha(tint, 0.9);
  g.lineWidth = Math.max(1, R * 0.09);
  g.beginPath();
  g.arc(cx, cy, R * 0.38, 0, Math.PI * 2);
  g.fill();
  g.stroke();

  g.restore();
}

/** An absence. A dark sphere with a band of static across it — the one
 *  structure that should look like a fault in the picture, because that
 *  is exactly what it does to a rival's map. */
function drawNullField(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  g.save();

  // Suppression haze, deliberately murky rather than luminous.
  const haze = g.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2.4);
  haze.addColorStop(0, 'rgba(18, 24, 34, 0.55)');
  haze.addColorStop(1, 'rgba(18, 24, 34, 0)');
  g.fillStyle = haze;
  g.beginPath();
  g.arc(cx, cy, R * 2.4, 0, Math.PI * 2);
  g.fill();

  // Body: near-black, but ringed in something BRIGHT. The structure's
  // own colour is a dark slate — correct for what it does and useless as
  // an outline, so the rim is drawn in a cold white instead. Without it
  // the whole thing vanished into the starfield and the most
  // strategically alarming object on the board was the hardest to see.
  g.fillStyle = 'rgba(9, 12, 19, 0.97)';
  g.beginPath();
  g.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = 'rgba(178, 198, 220, 0.92)';
  g.lineWidth = Math.max(1.4, R * 0.12);
  g.beginPath();
  g.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
  g.stroke();

  // Broken outer ring — a containment cage that is visibly incomplete,
  // which is the closest a still image gets to "this is suppressing
  // something".
  g.strokeStyle = 'rgba(150, 175, 200, 0.55)';
  g.lineWidth = Math.max(1, R * 0.07);
  for (let i = 0; i < 6; i++) {
    const a0 = (now / 6000) + (i / 6) * Math.PI * 2;
    g.beginPath();
    g.arc(cx, cy, R * 1.18, a0, a0 + 0.62);
    g.stroke();
  }

  // Static bands, scrolling. Clipped to the body so they read as
  // interference across it rather than a fence in front of it.
  g.save();
  g.beginPath();
  g.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
  g.clip();
  for (let i = 0; i < 7; i++) {
    const y = cy - R + (((now / 900) + i / 7) % 1) * R * 2;
    g.fillStyle = `rgba(180, 205, 225, ${0.05 + 0.13 * h01(i)})`;
    g.fillRect(cx - R, y, R * 2, Math.max(0.7, R * 0.07));
  }
  g.restore();

  g.restore();
}

/** Fallback: a lit ring. Used for a completed warp gate, which already
 *  has bespoke art elsewhere, and for anything new before it earns its
 *  own sprite. */
function drawGenericComplete(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 1100);
  g.save();
  bloom(g, cx, cy, R * 2.0, tint, 0.13 + 0.05 * pulse);
  g.strokeStyle = withAlpha(tint, 0.95);
  g.lineWidth = Math.max(1.5, R * 0.15);
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(6, 14, 22, 0.75)';
  g.beginPath();
  g.arc(cx, cy, R * 0.8, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// ------------------------------------------------------------

function bloom(g: G, cx: number, cy: number, r: number, tint: string, alpha: number) {
  const grad = g.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
  grad.addColorStop(0, withAlpha(tint, alpha));
  grad.addColorStop(1, withAlpha(tint, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
}

/** `#rrggbb` + alpha -> rgba(). The catalogue stores hex; canvas
 *  gradients need per-stop alpha, and parsing once here beats storing a
 *  second rgba copy of every structure colour. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(160, 190, 210, ${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
