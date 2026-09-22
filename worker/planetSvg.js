// ============================================================
// Planet sprites for the watch -- the GAME'S planets, not a watch
// drawing of them.
//
// The map paints every world procedurally (src/render/planetTexture.ts),
// seeded on the world's local id, so Oberon has the same craters in
// every game and on every client. The watch cannot run that code (it is
// canvas JavaScript), and a Kotlin port would drift the first time the
// art changed. So the server runs THE SAME PAINTER here, against a
// context that records each call as SVG instead of pixels, and resvg
// (already here for the ship icons) rasterises the result. Composed the
// way the Outliner's PlanetIcon composes it: surface, cloud deck,
// terminator shadow, atmospheric rim, thin limb.
//
// Only the slice of CanvasRenderingContext2D the painter uses is
// implemented: fillStyle/strokeStyle (colours and gradients), lineWidth,
// lineCap, globalAlpha, globalCompositeOperation, save/restore,
// translate/scale, beginPath/moveTo/lineTo/arc/ellipse, fill, stroke,
// fillRect. src/render/__tests__ has nothing to say about this; the
// sprite test in worker/__tests__ fails if the painter reaches for
// anything else.
// ============================================================

import { paintSurfaceOnto, paintCloudsOnto, TEX_SIZE } from '../src/render/planetTexture';
import { lighten, withOpacity } from '../src/render/colors';

const f = (n) => (Math.round(n * 100) / 100).toString();

/** CSS colour -> { c: '#rrggbb', a } for SVG, which wants them apart. */
export function parseColor(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (t === 'transparent') return { c: '#000000', a: 0 };
  if (t === 'white') return { c: '#ffffff', a: 1 };
  if (t === 'black') return { c: '#000000', a: 1 };
  let m = t.match(/^#([0-9a-f]{3})$/);
  if (m) return { c: '#' + m[1].split('').map(x => x + x).join(''), a: 1 };
  m = t.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return { c: '#' + m[1], a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = t.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const h = (v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0');
    return { c: '#' + h(m[1]) + h(m[2]) + h(m[3]), a: m[4] == null ? 1 : Math.max(0, Math.min(1, Number(m[4]))) };
  }
  throw new Error(`planetSprite: unparsed colour ${s}`);
}

class Gradient {
  constructor(kind, args) { this.kind = kind; this.args = args; this.stops = []; }
  addColorStop(o, color) { this.stops.push([o, parseColor(color)]); }
}

/** A CanvasRenderingContext2D that writes SVG. */
export class SvgContext {
  constructor() {
    this.defs = [];
    this.body = [];
    this.ids = 0;
    this.st = { fill: '#000', stroke: '#000', lw: 1, cap: 'butt', alpha: 1, op: 'source-over', m: [1, 0, 0, 1, 0, 0] };
    this.stack = [];
    this.d = '';
  }
  // ---- state
  set fillStyle(v) { this.st.fill = v; }
  get fillStyle() { return this.st.fill; }
  set strokeStyle(v) { this.st.stroke = v; }
  get strokeStyle() { return this.st.stroke; }
  set lineWidth(v) { this.st.lw = v; }
  get lineWidth() { return this.st.lw; }
  set lineCap(v) { this.st.cap = v; }
  get lineCap() { return this.st.cap; }
  set globalAlpha(v) { this.st.alpha = v; }
  get globalAlpha() { return this.st.alpha; }
  set globalCompositeOperation(v) { this.st.op = v; }
  get globalCompositeOperation() { return this.st.op; }
  save() { this.stack.push({ ...this.st, m: [...this.st.m] }); }
  restore() { if (this.stack.length) this.st = this.stack.pop(); }
  translate(x, y) {
    const [a, b, c, d, e, g] = this.st.m;
    this.st.m = [a, b, c, d, e + a * x + c * y, g + b * x + d * y];
  }
  scale(sx, sy) {
    const [a, b, c, d, e, g] = this.st.m;
    this.st.m = [a * sx, b * sx, c * sy, d * sy, e, g];
  }
  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]); }
  // ---- path
  beginPath() { this.d = ''; }
  closePath() { this.d += 'Z'; }
  moveTo(x, y) { this.d += `M${f(x)} ${f(y)}`; }
  lineTo(x, y) { this.d += `L${f(x)} ${f(y)}`; }
  arc(x, y, r, a0, a1, ccw = false) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
    const pt = (a) => {
      const px = Math.cos(a) * rx, py = Math.sin(a) * ry;
      return [x + px * Math.cos(rot) - py * Math.sin(rot), y + px * Math.sin(rot) + py * Math.cos(rot)];
    };
    let sweep = ccw ? a0 - a1 : a1 - a0;
    const full = sweep >= Math.PI * 2 - 1e-9;
    if (!full) sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const [sx, sy] = pt(a0);
    this.d += this.d ? `L${f(sx)} ${f(sy)}` : `M${f(sx)} ${f(sy)}`;
    const deg = (rot * 180) / Math.PI;
    const dir = ccw ? -1 : 1;
    const flag = ccw ? 0 : 1;
    if (full) {
      const [mx, my] = pt(a0 + dir * Math.PI);
      this.d += `A${f(rx)} ${f(ry)} ${f(deg)} 0 ${flag} ${f(mx)} ${f(my)}`;
      this.d += `A${f(rx)} ${f(ry)} ${f(deg)} 0 ${flag} ${f(sx)} ${f(sy)}`;
      return;
    }
    const [ex, ey] = pt(a0 + dir * sweep);
    this.d += `A${f(rx)} ${f(ry)} ${f(deg)} ${sweep > Math.PI ? 1 : 0} ${flag} ${f(ex)} ${f(ey)}`;
  }
  // ---- paint
  paint(style) {
    if (style instanceof Gradient) {
      const id = `g${this.ids++}`;
      const stops = style.stops
        .map(([o, { c, a }]) => `<stop offset="${f(o)}" stop-color="${c}" stop-opacity="${f(a)}"/>`).join('');
      const a = style.args;
      this.defs.push(style.kind === 'linear'
        ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(a[2])}" y2="${f(a[3])}">${stops}</linearGradient>`
        : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" fx="${f(a[0])}" fy="${f(a[1])}" fr="${f(a[2])}" cx="${f(a[3])}" cy="${f(a[4])}" r="${f(a[5])}">${stops}</radialGradient>`);
      return { v: `url(#${id})`, a: 1 };
    }
    const { c, a } = parseColor(style);
    return { v: c, a };
  }
  common() {
    const m = this.st.m;
    const t = (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)
      ? '' : ` transform="matrix(${m.map(f).join(' ')})"`;
    const op = this.st.alpha < 1 ? ` opacity="${f(this.st.alpha)}"` : '';
    // 'lighter' is additive; resvg has no plus-lighter, and screen is the
    // closest brightening blend it does have.
    const blend = this.st.op === 'lighter' ? ' style="mix-blend-mode:screen"' : '';
    return t + op + blend;
  }
  fillRect(x, y, w, h) {
    const p = this.paint(this.st.fill);
    this.body.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${p.v}"${p.a < 1 ? ` fill-opacity="${f(p.a)}"` : ''}${this.common()}/>`);
  }
  fill() {
    if (!this.d) return;
    const p = this.paint(this.st.fill);
    this.body.push(`<path d="${this.d}" fill="${p.v}"${p.a < 1 ? ` fill-opacity="${f(p.a)}"` : ''}${this.common()}/>`);
  }
  stroke() {
    if (!this.d) return;
    const p = this.paint(this.st.stroke);
    this.body.push(`<path d="${this.d}" fill="none" stroke="${p.v}"${p.a < 1 ? ` stroke-opacity="${f(p.a)}"` : ''} stroke-width="${f(this.st.lw)}" stroke-linecap="${this.st.cap}"${this.common()}/>`);
  }
}

/** Did the air come with the world? PlanetIcon's cloudAlphaFor, exactly. */
function cloudAlphaFor(type, terraformed) {
  if (type === 'terrestrial') return 0.45;
  if (type === 'gas_giant') return 0.55;
  if (type === 'ice_giant') return 0.38;
  return terraformed ? 0.45 : 0;
}

export function mapType(t) {
  if (t === 'gas-giant') return 'gas_giant';
  if (t === 'ice-giant') return 'ice_giant';
  return t;
}

/**
 * The sprite key the watch asks for: everything the art depends on and
 * nothing else, so one PNG serves every game where the world looks the
 * same. local id ~ type ~ colour ~ terraformed ~ orbit radius ~ metal
 * (the last two only pick a terraformed world's biome).
 */
export function spriteKey(row) {
  const colon = String(row.id).indexOf(':');
  const local = colon === -1 ? String(row.id) : String(row.id).slice(colon + 1);
  const tf = row.terraformed_at_tick != null ? 1 : 0;
  const hex = String(row.color || '#8899aa').replace('#', '').toLowerCase();
  return [local, mapType(row.type), hex, tf,
    tf ? Math.round(Number(row.orbit_radius) || 0) : 0,
    tf ? Math.round(Number(row.yield_metal) || 0) : 0].map(encodeURIComponent).join('~');
}

export function parseSpriteKey(key) {
  const p = String(key).split('~').map(decodeURIComponent);
  if (p.length !== 6 || !/^[0-9a-f]{6}$/.test(p[2])) return null;
  return {
    id: p[0], type: p[1], color: '#' + p[2], terraformed: p[3] === '1',
    orbitRadius: Number(p[4]) || 0, resources: { metal: Number(p[5]) || 0 },
    terraformedAtTick: p[3] === '1' ? 0 : null,
  };
}

// ---- rings: mapRenderer's drawRingArcs, same constants ----------------
// Saturn and Uranus wear rings on the map: a tilted ellipse whose back
// half passes behind the disk and front half in front, with a soft dark
// segment where it crosses the night side. The sprite of a ringed world
// is TWICE the disk across (RING_PAD) so the rings fit; the watch knows
// from ringed() to draw it at twice the disk size.
const RING_TILT = 0.35;
const RING_RX = 1.9;
const RING_RY = 0.55;
export const RING_PAD = 2;

export function ringed(localId) {
  return localId === 'saturn' || localId === 'uranus';
}

function ringArcs(body, half) {
  const R = TEX_SIZE / 2;
  const c = new SvgContext();
  const color = body.color;
  const start = half === 'back' ? Math.PI : 0;
  const end = half === 'back' ? Math.PI * 2 : Math.PI;
  c.strokeStyle = withOpacity(lighten(color, 1.15), half === 'back' ? 0.45 : 0.6);
  c.lineWidth = Math.max(1.5, R * 0.1);
  c.beginPath();
  c.ellipse(R, R, R * RING_RX, R * RING_RY, RING_TILT, start, end);
  c.stroke();
  c.strokeStyle = withOpacity(color, 0.32);
  c.lineWidth = Math.max(0.5, R * 0.04);
  c.beginPath();
  c.ellipse(R, R, R * 1.55, R * 0.45, RING_TILT, start, end);
  c.stroke();
  let shadow = '';
  if (half === 'front') {
    // The sprite's light is fixed at the upper left (its terminator), so
    // the night side is down-right, where the map would put it for a
    // world lit from that side.
    const thetaN = Math.atan2(1, 1) - RING_TILT;
    const phi = Math.atan2(RING_RX * Math.sin(thetaN), RING_RY * Math.cos(thetaN));
    const sh = new SvgContext();
    sh.strokeStyle = 'rgba(2, 6, 12, 0.28)';
    sh.lineWidth = Math.max(3, R * 0.16);
    sh.beginPath();
    sh.ellipse(R, R, R * RING_RX, R * RING_RY, RING_TILT, phi - 0.8, phi + 0.8);
    sh.stroke();
    sh.strokeStyle = 'rgba(2, 6, 12, 0.4)';
    sh.lineWidth = Math.max(1.5, R * 0.1);
    sh.beginPath();
    sh.ellipse(R, R, R * RING_RX, R * RING_RY, RING_TILT, phi - 0.5, phi + 0.5);
    sh.stroke();
    shadow = `<g clip-path="url(#offdisk)">${sh.body.join('')}</g>`;
  }
  return c.body.join('') + shadow;
}

/** The whole sprite as SVG, transparent outside the art: TEX_SIZE
 *  square, or RING_PAD times that with the disk centred for a ringed
 *  world. */
export function planetSvg(body) {
  const S = TEX_SIZE, R = S / 2;
  const rings = ringed(body.id);
  const W = rings ? S * RING_PAD : S;
  const o = (W - S) / 2;
  const surface = new SvgContext();
  paintSurfaceOnto(surface, body, body.terraformed ? 'terraformed' : 'raw');
  const cloudA = cloudAlphaFor(body.type, body.terraformed);
  let clouds = null;
  if (cloudA > 0) {
    clouds = new SvgContext();
    paintCloudsOnto(clouds, body);
  }
  // Keep each context's gradient ids apart.
  const cloudDefs = clouds ? clouds.defs.join('').replace(/id="g/g, 'id="c').replace(/url\(#g/g, 'url(#c') : '';
  const cloudBody = clouds ? clouds.body.join('').replace(/url\(#g/g, 'url(#c') : '';
  const rimA = 0.30 * Math.min(1, cloudA / 0.45);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="${-o} ${-o} ${W} ${W}">`
    + `<defs><clipPath id="disk"><circle cx="${R}" cy="${R}" r="${R}"/></clipPath>`
    + `<clipPath id="offdisk"><path clip-rule="evenodd" d="M${-o} ${-o}h${W}v${W}h${-W}Z`
    + `M${R + R * 1.02} ${R}A${R * 1.02} ${R * 1.02} 0 1 0 ${R - R * 1.02} ${R}A${R * 1.02} ${R * 1.02} 0 1 0 ${R + R * 1.02} ${R}Z"/></clipPath>`
    + surface.defs.join('') + cloudDefs
    + `<linearGradient id="term" x1="0" y1="0" x2="${S}" y2="${S}" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.55" stop-color="#000" stop-opacity="0"/>`
    + `<stop offset="1" stop-color="#02060c" stop-opacity="0.55"/></linearGradient>`
    + `<radialGradient id="rim" cx="${R}" cy="${R}" r="${R}" fr="${R * 0.72}" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" stop-color="#96d2ff" stop-opacity="0"/><stop offset="0.85" stop-color="#96d2ff" stop-opacity="${f(rimA)}"/>`
    + `<stop offset="1" stop-color="#96d2ff" stop-opacity="0"/></radialGradient></defs>`
    + (rings ? ringArcs(body, 'back') : '')
    + `<g clip-path="url(#disk)">`
    + surface.body.join('')
    + (clouds ? `<g opacity="${cloudA}">${cloudBody}</g>` : '')
    + `<rect width="${S}" height="${S}" fill="url(#term)"/></g>`
    + (cloudA > 0 ? `<circle cx="${R}" cy="${R}" r="${R}" fill="url(#rim)" style="mix-blend-mode:screen"/>` : '')
    + `<circle cx="${R}" cy="${R}" r="${R - 1.5}" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="3"/>`
    + (rings ? ringArcs(body, 'front') : '')
    + `</svg>`;
}

