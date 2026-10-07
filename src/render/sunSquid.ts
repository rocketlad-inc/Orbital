// ============================================================
// THE THING FROM THE SUN — a sun gate's body, in flight and at rest.
//
// Lorne, 2026-10-06: "a strange alien structure, vaguely squid shaped
// that does the transit and turns into the gate upon arrival."
//
// One drawing with one dial, `morph`:
//
//   0  THE SQUID. A dark ribbed mantle with fins at the tip, two lamp
//      eyes, eight arms and two long feeding tentacles trailing behind,
//      and a jet out of the siphon between them. It flies mantle first;
//      at the flip (worker/sunGates.js times an even push-flip-brake) it
//      turns round and brakes on the same jet, so the plume always says
//      which way it is pushing.
//   1  THE GATE. The body has folded away into a lit throat, the eight
//      arms have curled round into a ring, each one's tip reaching the
//      next one's root, and the two feeders stand out from it as spines.
//
// In between, every point of every arm slides from where it trails to
// where it sits on the ring, so the arrival is one continuous unfurling,
// not a cut. The ring's angle is kept in WORLD terms (it does not turn
// with the squid's heading) so the frame the flight ends on is exactly
// the frame the resting gate starts from.
//
// Not the warp-gate sprite. A warp gate is something people built, all
// truss and module; this was never built by anyone, and the art says so.
// Canvas, not SVG: it animates every frame and there are only two.
// ============================================================

type G = CanvasRenderingContext2D;

const TWO_PI = Math.PI * 2;
const ARMS = 8;

/** Gold of the gate (worker/sunGates.js colours its rows '#ffc86b'). */
const GLOW = '255, 200, 107';
const GLOW_HOT = '255, 241, 194';
const HIDE_DARK = '#1c1029';
const HIDE_MID = '#3b2150';
const HIDE_LIT = '#6a4a86';

export interface SunSquidPose {
  /** Squid size unit in px. The mantle is ~2.4u long, the arms ~2.6u. */
  u: number;
  /** Radius in px of the ring it becomes. */
  ringR: number;
  /** Radians, canvas frame: the way the mantle tip points. */
  heading: number;
  /** 0 = squid, 1 = gate. */
  morph: number;
  /** 0..1, how hard it is burning (the jet's length). */
  thrust: number;
  /** performance.now(), for the motion. */
  now: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The ring's slow turn, in world radians. Wrapped so a long session
 *  never loses precision (the megastructure art does the same). */
export function sunGateSpin(now: number): number {
  return (now / 46000) % TWO_PI;
}

/** How far a flight has turned into a gate: nothing until the last
 *  fifth of the trip, then an eased unfurling that completes on arrival. */
export function sunGateMorph(flightFraction: number): number {
  return smooth((flightFraction - 0.8) / 0.2);
}

/** Heading through the flight: outward while it pushes, swinging round
 *  across the flip to point back at the Sun while it brakes. */
export function sunGateHeading(outward: number, flightFraction: number): number {
  return outward + Math.PI * smooth((flightFraction - 0.44) / 0.12);
}

type P = { x: number; y: number };

/** A tapered ribbon along a centreline: width w0 at the root, w1 at the tip. */
function ribbon(g: G, pts: P[], w0: number, w1: number) {
  const n = pts.length;
  if (n < 2) return;
  const left: P[] = [], right: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const w = lerp(w0, w1, i / (n - 1)) / 2;
    left.push({ x: pts[i].x - ty * w, y: pts[i].y + tx * w });
    right.push({ x: pts[i].x + ty * w, y: pts[i].y - tx * w });
  }
  g.beginPath();
  g.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) g.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) g.lineTo(right[i].x, right[i].y);
  g.closePath();
  g.fill();
}

/**
 * Draw it at (cx, cy). Everything is laid out in the squid's own frame
 * (x forward), then the canvas is turned to `heading`; ring positions
 * are converted from world angles into that frame.
 */
export function drawSunSquid(g: G, cx: number, cy: number, pose: SunSquidPose) {
  const { u, ringR: rho, heading, now } = pose;
  const m = clamp01(pose.morph);
  const thrust = clamp01(pose.thrust) * (1 - m);
  const spin = sunGateSpin(now);
  const pulse = 0.5 + 0.5 * Math.sin(now / 760);
  const detail = Math.max(u, rho * 0.5) >= 7;

  g.save();
  g.translate(cx, cy);

  // The glow it sits in: a long wash along the squid, a disc for the gate.
  const haloR = lerp(u * 3.4, rho * 2.2, m);
  const halo = g.createRadialGradient(0, 0, 0, 0, 0, haloR);
  halo.addColorStop(0, `rgba(${GLOW}, ${0.2 + 0.08 * pulse})`);
  halo.addColorStop(1, `rgba(${GLOW}, 0)`);
  g.fillStyle = halo;
  g.beginPath(); g.arc(0, 0, haloR, 0, TWO_PI); g.fill();

  g.rotate(heading);
  // World angle -> this frame.
  const local = (a: number) => a - heading;

  // ---- the jet, under everything -------------------------------------
  if (thrust > 0.02) {
    const len = u * (1.8 + 6.5 * thrust);
    const w = u * (0.34 + 0.2 * thrust);
    const x0 = -u * 0.55;
    const jet = g.createLinearGradient(x0, 0, x0 - len, 0);
    jet.addColorStop(0, `rgba(${GLOW_HOT}, ${0.9 * thrust + 0.1})`);
    jet.addColorStop(0.3, `rgba(${GLOW}, ${0.55 * thrust})`);
    jet.addColorStop(1, 'rgba(255, 120, 50, 0)');
    g.fillStyle = jet;
    g.beginPath();
    g.moveTo(x0, -w * 0.5);
    g.quadraticCurveTo(x0 - len * 0.45, -w, x0 - len, 0);
    g.quadraticCurveTo(x0 - len * 0.45, w, x0, w * 0.5);
    g.closePath();
    g.fill();
  }

  // ---- the throat it opens into ---------------------------------------
  if (m > 0.01) {
    const tr = rho * 0.8 * m;
    const throat = g.createRadialGradient(0, 0, 0, 0, 0, tr);
    throat.addColorStop(0, `rgba(${GLOW_HOT}, ${0.85 * m * (0.7 + 0.3 * pulse)})`);
    throat.addColorStop(0.45, `rgba(${GLOW}, ${0.5 * m})`);
    throat.addColorStop(1, `rgba(40, 14, 52, ${0.85 * m})`);
    g.fillStyle = throat;
    g.beginPath(); g.arc(0, 0, tr, 0, TWO_PI); g.fill();
    // Something in there looks back: a slow slit that never quite closes.
    if (detail) {
      g.save();
      g.rotate(local(Math.PI / 2));
      const sw = tr * (0.08 + 0.07 * (0.5 + 0.5 * Math.sin(now / 2300)));
      g.fillStyle = `rgba(28, 8, 30, ${0.7 * m})`;
      g.beginPath();
      g.ellipse(0, 0, tr * 0.62, sw, 0, 0, TWO_PI);
      g.fill();
      g.restore();
    }
  }

  // ---- arms and feeders -------------------------------------------------
  // Squid pose: roots fanned across the back of the head, trailing aft
  // in a slow travelling wave that straightens as it speeds up.
  // Ring pose: arm i rides the ring from its root angle to the next.
  const N = detail ? 18 : 9;
  const sway = 0.24 * (1 - 0.65 * thrust);
  const phaseT = now / 300;
  const armSeg = TWO_PI / ARMS;
  const armPts = (i: number): P[] => {
    const yb = (i / (ARMS - 1) - 0.5) * 0.72 * u;
    const L = u * 2.6;
    const ringA = spin + i * armSeg;
    const pts: P[] = [];
    for (let k = 0; k < N; k++) {
      const s = k / (N - 1);
      const sq = {
        x: -u * 0.6 - s * L,
        y: yb * (1 + 1.3 * s) + u * sway * s * Math.sin(i * 1.3 + 4.5 * s - phaseT),
      };
      const a = local(ringA + s * armSeg * 0.94);
      const rr = rho * (1 + 0.035 * Math.sin(3 * s * TWO_PI + phaseT * 0.4 + i));
      const rg = { x: Math.cos(a) * rr, y: Math.sin(a) * rr };
      pts.push({ x: lerp(sq.x, rg.x, m), y: lerp(sq.y, rg.y, m) });
    }
    return pts;
  };
  const feederPts = (j: number): P[] => {
    const yb = (j === 0 ? -1 : 1) * 0.12 * u;
    const L = u * 4.1;
    const baseA = spin + Math.PI / ARMS + j * Math.PI;
    const pts: P[] = [];
    for (let k = 0; k < N; k++) {
      const s = k / (N - 1);
      const sq = {
        x: -u * 0.55 - s * L,
        y: yb * (1 + 3 * s) + u * (sway + 0.1) * s * Math.sin(j * 2.1 + 3.4 * s - phaseT * 0.8),
      };
      // Out from the ring as a spine, its tip curling over.
      const a = local(baseA + 0.35 * s * s);
      const rr = rho * (1 + 0.62 * s);
      const rg = { x: Math.cos(a) * rr, y: Math.sin(a) * rr };
      pts.push({ x: lerp(sq.x, rg.x, m), y: lerp(sq.y, rg.y, m) });
    }
    return pts;
  };

  const wRoot = lerp(u * 0.28, rho * 0.19, m);
  const wTip = lerp(u * 0.03, rho * 0.06, m);
  const feeders = [feederPts(0), feederPts(1)];
  const arms = Array.from({ length: ARMS }, (_, i) => armPts(i));

  // A faint gold rim first, so a dark limb still reads against space;
  // then the hide, then a lit stripe down the middle of each arm.
  const fw0 = lerp(u * 0.1, rho * 0.11, m), fw1 = lerp(u * 0.03, rho * 0.03, m);
  const rim = Math.max(1.2, lerp(u * 0.08, rho * 0.05, m));
  g.fillStyle = `rgba(${GLOW}, 0.28)`;
  for (const f of feeders) ribbon(g, f, fw0 + rim, fw1 + rim);
  for (const a of arms) ribbon(g, a, wRoot + rim, wTip + rim);
  g.fillStyle = HIDE_MID;
  for (const f of feeders) ribbon(g, f, fw0, fw1);
  for (const a of arms) ribbon(g, a, wRoot, wTip);
  g.fillStyle = HIDE_LIT;
  for (const a of arms) ribbon(g, a, wRoot * 0.42, wTip * 0.4);

  // Feeding clubs: the lamps at the ends of the long tentacles.
  for (const f of feeders) {
    const t = f[f.length - 1];
    const cr = lerp(u * 0.16, rho * 0.11, m);
    const club = g.createRadialGradient(t.x, t.y, 0, t.x, t.y, cr * 2.4);
    club.addColorStop(0, `rgba(${GLOW_HOT}, ${0.75 + 0.25 * pulse})`);
    club.addColorStop(0.4, `rgba(${GLOW}, 0.45)`);
    club.addColorStop(1, `rgba(${GLOW}, 0)`);
    g.fillStyle = club;
    g.beginPath(); g.arc(t.x, t.y, cr * 2.4, 0, TWO_PI); g.fill();
  }

  // Photophores down every arm, a travelling ripple of light.
  if (detail) {
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      for (let k = 2; k < a.length - 1; k += 2) {
        const s = k / (a.length - 1);
        const lit = 0.5 + 0.5 * Math.sin(s * 9 - now / 260 + i * 0.8);
        g.fillStyle = `rgba(${GLOW}, ${(0.25 + 0.6 * lit) * (1 - 0.5 * s)})`;
        g.beginPath();
        g.arc(a[k].x, a[k].y, Math.max(0.6, lerp(u * 0.05, rho * 0.035, m) * (1 - 0.5 * s)), 0, TWO_PI);
        g.fill();
      }
    }
  }

  // ---- mantle, fins, head: they fold away into the throat --------------
  const bodyK = 1 - m;
  if (bodyK > 0.01) {
    g.save();
    g.globalAlpha *= smooth(bodyK * 1.25);
    // Shrink toward the centre, where the throat opens.
    g.scale(lerp(1, 0.25, m), lerp(1, 0.25, m));

    // Fins at the tip: thin, translucent, flexing.
    const flex = 0.08 * Math.sin(now / 420);
    g.fillStyle = 'rgba(122, 90, 152, 0.75)';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(u * 2.45, 0);
      g.quadraticCurveTo(u * 2.1, s * u * (1.05 + flex), u * 1.35, s * u * 0.55);
      g.lineTo(u * 1.7, s * u * 0.3);
      g.closePath();
      g.fill();
    }

    // The mantle: a long ribbed hull, darker underneath.
    const hull = g.createLinearGradient(0, -u * 0.6, 0, u * 0.6);
    hull.addColorStop(0, HIDE_LIT);
    hull.addColorStop(0.45, HIDE_MID);
    hull.addColorStop(1, HIDE_DARK);
    g.fillStyle = hull;
    g.beginPath();
    g.moveTo(u * 2.6, 0);
    g.bezierCurveTo(u * 2.0, -u * 0.5, u * 0.8, -u * 0.66, 0, -u * 0.5);
    g.lineTo(0, u * 0.5);
    g.bezierCurveTo(u * 0.8, u * 0.66, u * 2.0, u * 0.5, u * 2.6, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = `rgba(${GLOW}, 0.35)`;
    g.lineWidth = Math.max(0.6, u * 0.04);
    g.stroke();

    // Ribs of light: chevrons that run tip to collar, like a heartbeat.
    if (detail) {
      g.lineWidth = Math.max(0.6, u * 0.05);
      for (let i = 0; i < 4; i++) {
        const x = u * (0.4 + i * 0.5);
        const half = u * 0.5 * (1 - i * 0.16);
        const lit = 0.5 + 0.5 * Math.sin(now / 350 - i * 0.9);
        g.strokeStyle = `rgba(${GLOW}, ${0.25 + 0.55 * lit})`;
        g.beginPath();
        g.moveTo(x - u * 0.18, -half);
        g.lineTo(x + u * 0.12, 0);
        g.lineTo(x - u * 0.18, half);
        g.stroke();
      }
    }

    // The head, and two lamp eyes that are the brightest thing on it.
    g.fillStyle = HIDE_DARK;
    g.beginPath();
    g.ellipse(-u * 0.3, 0, u * 0.48, u * 0.46, 0, 0, TWO_PI);
    g.fill();
    for (const s of [-1, 1]) {
      const ex = -u * 0.24, ey = s * u * 0.32;
      const eye = g.createRadialGradient(ex, ey, 0, ex, ey, u * 0.2);
      eye.addColorStop(0, `rgba(${GLOW_HOT}, 1)`);
      eye.addColorStop(0.35, `rgba(${GLOW}, 0.8)`);
      eye.addColorStop(1, `rgba(${GLOW}, 0)`);
      g.fillStyle = eye;
      g.beginPath(); g.arc(ex, ey, u * 0.2, 0, TWO_PI); g.fill();
    }
    g.restore();
  }

  // The ring's inner lip, once there is a ring.
  if (m > 0.6) {
    const a = (m - 0.6) / 0.4;
    g.strokeStyle = `rgba(${GLOW}, ${a * (0.45 + 0.35 * pulse)})`;
    g.lineWidth = Math.max(1, rho * 0.05);
    g.beginPath(); g.arc(0, 0, rho * 0.82, 0, TWO_PI); g.stroke();
  }

  g.restore();
}

/**
 * THE OMEN ON THE SUN: the six ticks between "something strange is
 * emerging from the Sun" and a gate coming out. Until now the warning
 * went to every phone and the map's Sun looked exactly as it always had.
 *
 * A dark shape surfaces near the limb, swelling as the moment nears
 * (`k`, 0 at the warning, 1 as it breaks free), with a gold rim where the
 * photosphere boils off it; slow ripples run across the disc; and in the
 * last third two lamp eyes open in the dark, the squid's own. Where on the
 * disc is `angle` (the caller seeds it: where the gate will actually fly
 * stays secret until it does).
 */
export function drawSunOmen(
  g: G, cx: number, cy: number, coreR: number, k: number, angle: number, now: number,
) {
  const t = clamp01(k);
  if (coreR < 3) return;
  g.save();
  g.translate(cx, cy);

  // Ripples across the disc, clipped to it: the Sun is disturbed.
  g.save();
  g.beginPath(); g.arc(0, 0, coreR, 0, TWO_PI); g.clip();
  for (let i = 0; i < 3; i++) {
    const phase = ((now / 2600) + i / 3) % 1;
    const r = coreR * (0.15 + 0.95 * phase);
    g.strokeStyle = `rgba(90, 30, 10, ${0.22 * (1 - phase) * (0.4 + 0.6 * t)})`;
    g.lineWidth = Math.max(1, coreR * 0.035);
    g.beginPath();
    g.arc(Math.cos(angle) * coreR * 0.55, Math.sin(angle) * coreR * 0.55, r, 0, TWO_PI);
    g.stroke();
  }
  g.restore();

  // The shape, rising from inside the disc toward the limb along `angle`.
  const dist = coreR * (0.45 + 0.5 * t);
  const sx = Math.cos(angle) * dist, sy = Math.sin(angle) * dist;
  const len = coreR * (0.18 + 0.32 * t), wid = coreR * (0.1 + 0.16 * t);
  g.save();
  g.translate(sx, sy);
  g.rotate(angle);
  // Gold rim: the photosphere boiling off it.
  const pulse = 0.5 + 0.5 * Math.sin(now / 340);
  const rim = g.createRadialGradient(0, 0, 0, 0, 0, len * 1.8);
  rim.addColorStop(0, `rgba(${GLOW_HOT}, ${0.35 + 0.25 * pulse * t})`);
  rim.addColorStop(1, `rgba(${GLOW}, 0)`);
  g.fillStyle = rim;
  g.beginPath(); g.ellipse(0, 0, len * 1.8, wid * 1.8, 0, 0, TWO_PI); g.fill();
  // The dark body itself.
  g.fillStyle = `rgba(28, 12, 34, ${0.55 + 0.4 * t})`;
  g.beginPath();
  g.moveTo(len, 0);
  g.bezierCurveTo(len * 0.4, -wid, -len * 0.6, -wid * 0.9, -len, 0);
  g.bezierCurveTo(-len * 0.6, wid * 0.9, len * 0.4, wid, len, 0);
  g.closePath();
  g.fill();
  // Its eyes, late: the thing is looking out.
  if (t > 0.66) {
    const e = (t - 0.66) / 0.34;
    for (const s of [-1, 1]) {
      const ex = -len * 0.35, ey = s * wid * 0.45;
      const er = Math.max(1, wid * 0.28);
      const eye = g.createRadialGradient(ex, ey, 0, ex, ey, er * 2);
      eye.addColorStop(0, `rgba(${GLOW_HOT}, ${e})`);
      eye.addColorStop(1, `rgba(${GLOW}, 0)`);
      g.fillStyle = eye;
      g.beginPath(); g.arc(ex, ey, er * 2, 0, TWO_PI); g.fill();
    }
  }
  g.restore();
  g.restore();
}
