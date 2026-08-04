// ============================================================================
// heraldPng.js — the territory strip as a real PNG, rendered entirely
// inside the Worker. No canvas, no browser, no WASM, no paid binding.
//
// HOW: rasterise into an RGBA buffer by hand, then PNG-encode. The only
// piece that looks like magic is the compression, and Workers hand it to
// us: CompressionStream('deflate') emits zlib-wrapped deflate, which is
// EXACTLY what a PNG IDAT chunk contains. So a PNG is: signature, IHDR,
// deflate(scanlines), IEND — plus a CRC per chunk.
//
// TEXT is why this file exists at all. Everything else (discs, washes,
// gradients) is arithmetic, but glyphs need a font, and a Worker has no
// font engine. So one ships here: a 5x7 bitmap face, uppercase plus
// digits and a little punctuation, which is all the chart uses. It reads
// as a tactical readout rather than smooth type — a deliberate trade for
// being wholly self-contained.
// ============================================================================

// ---------------------------------------------------------------------------
// 5x7 bitmap font. Each glyph is 7 rows of 5 bits, MSB left.
// ---------------------------------------------------------------------------
const GLYPHS = {
  A: '01110,10001,10001,11111,10001,10001,10001',
  B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111',
  F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111',
  H: '10001,10001,10001,11111,10001,10001,10001',
  I: '11111,00100,00100,00100,00100,00100,11111',
  J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001',
  L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001',
  N: '10001,11001,10101,10011,10001,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101',
  R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001',
  X: '10001,01010,00100,00100,00100,01010,10001',
  Y: '10001,01010,00100,00100,00100,00100,00100',
  Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110',
  1: '00100,01100,00100,00100,00100,00100,01110',
  2: '01110,10001,00001,00010,00100,01000,11111',
  3: '11111,00010,00100,00010,00001,10001,01110',
  4: '00010,00110,01010,10010,11111,00010,00010',
  5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110',
  7: '11111,00001,00010,00100,01000,01000,01000',
  8: '01110,10001,10001,01110,10001,10001,01110',
  9: '01110,10001,10001,01111,00001,00010,01100',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
  '-': '00000,00000,00000,11111,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,00000,00100',
  ',': '00000,00000,00000,00000,00000,00100,01000',
  "'": '00100,00100,00000,00000,00000,00000,00000',
  ':': '00000,00100,00000,00000,00100,00000,00000',
  '+': '00000,00100,00100,11111,00100,00100,00000',
  '/': '00001,00010,00010,00100,01000,01000,10000',
  '(': '00010,00100,01000,01000,01000,00100,00010',
  ')': '01000,00100,00010,00010,00010,00100,01000',
  '·': '00000,00000,00000,00100,00000,00000,00000',
  '…': '00000,00000,00000,00000,00000,00000,10101',
  '!': '00100,00100,00100,00100,00100,00000,00100',
};
const GLYPH_W = 5, GLYPH_H = 7, ADVANCE = 6;

/** Width in px of `text` at a given cell scale. The layout code MUST use
 *  this rather than guessing, or centred text drifts off its band. */
export function textWidth(text, scale) {
  return String(text).length * ADVANCE * scale;
}

// ---------------------------------------------------------------------------
// Raster surface
// ---------------------------------------------------------------------------

export function createSurface(w, h, bg = [6, 9, 15]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}

/** Source-over blend of one pixel. All drawing funnels through here, so
 *  alpha behaves consistently and out-of-bounds writes are impossible. */
function px(s, x, y, r, g, b, a) {
  if (a <= 0) return;
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= s.w || yi >= s.h) return;
  const i = (yi * s.w + xi) * 4;
  const d = s.data;
  if (a >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; return; }
  d[i] = d[i] + (r - d[i]) * a;
  d[i + 1] = d[i + 1] + (g - d[i + 1]) * a;
  d[i + 2] = d[i + 2] + (b - d[i + 2]) * a;
  d[i + 3] = 255;
}

export function fillRect(s, x, y, w, h, [r, g, b], a = 1) {
  const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(s.w, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(s.h, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px(s, xx, yy, r, g, b, a);
}

/** Vertical gradient band. `stops` = [[t, [r,g,b], alpha], ...] with t in 0..1. */
export function fillVGrad(s, x, y, w, h, stops) {
  const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(s.w, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(s.h, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    const t = h <= 0 ? 0 : (yy - y) / h;
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const span = Math.max(1e-6, hi[0] - lo[0]);
    const k = Math.max(0, Math.min(1, (t - lo[0]) / span));
    const r = lo[1][0] + (hi[1][0] - lo[1][0]) * k;
    const g = lo[1][1] + (hi[1][1] - lo[1][1]) * k;
    const b = lo[1][2] + (hi[1][2] - lo[1][2]) * k;
    const a = lo[2] + (hi[2] - lo[2]) * k;
    for (let xx = x0; xx < x1; xx++) px(s, xx, yy, r, g, b, a);
  }
}

/** Radial falloff — the star's corona and the combat icon's heat. */
export function fillRadial(s, cx, cy, radius, [r, g, b], aCenter, aEdge = 0) {
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(s.w, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(s.h, Math.ceil(cy + radius));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
    if (d > radius) continue;
    const t = d / radius;
    px(s, xx, yy, r, g, b, aCenter + (aEdge - aCenter) * t);
  }
}

/** Anti-aliased disc: coverage from the distance to the edge, which is
 *  what keeps small planet dots from looking like squares. */
export function fillCircle(s, cx, cy, radius, [r, g, b], a = 1) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1)), x1 = Math.min(s.w, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1)), y1 = Math.min(s.h, Math.ceil(cy + radius + 1));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
    const cov = Math.max(0, Math.min(1, radius + 0.5 - d));
    if (cov > 0) px(s, xx, yy, r, g, b, a * cov);
  }
}

export function strokeCircle(s, cx, cy, radius, [r, g, b], a = 1, lw = 1) {
  const outer = radius + lw / 2, inner = radius - lw / 2;
  const x0 = Math.max(0, Math.floor(cx - outer - 1)), x1 = Math.min(s.w, Math.ceil(cx + outer + 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1)), y1 = Math.min(s.h, Math.ceil(cy + outer + 1));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
    const cov = Math.min(1, Math.max(0, outer + 0.5 - d)) * Math.min(1, Math.max(0, d - inner + 0.5));
    if (cov > 0) px(s, xx, yy, r, g, b, a * cov);
  }
}

/** Squashed ring for gas giants. Same coverage trick in ellipse space. */
export function strokeEllipse(s, cx, cy, rx, ry, rot, [r, g, b], a = 1, lw = 1.4) {
  const co = Math.cos(-rot), si = Math.sin(-rot);
  const R = Math.max(rx, ry) + lw + 1;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(s.w, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(s.h, Math.ceil(cy + R));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
    const ux = dx * co - dy * si, uy = dx * si + dy * co;
    const f = Math.hypot(ux / Math.max(1e-6, rx), uy / Math.max(1e-6, ry));
    const cov = Math.max(0, 1 - Math.abs(f - 1) * (Math.min(rx, ry) / Math.max(0.5, lw)));
    if (cov > 0) px(s, xx, yy, r, g, b, a * Math.min(1, cov));
  }
}

export function drawLine(s, x0, y0, x1, y1, [r, g, b], a = 1, lw = 1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (lw <= 1) px(s, x, y, r, g, b, a);
    else fillCircle(s, x, y, lw / 2, [r, g, b], a);
  }
}

/** Diagonal hatch inside a rect — the contested-sector marker. */
export function hatchRect(s, x, y, w, h, [r, g, b], a = 0.16, step = 11) {
  for (let sx = x - h; sx < x + w + h; sx += step) {
    for (let t = 0; t < h; t += 0.5) {
      const px0 = sx + t, py0 = y + h - t;
      if (px0 >= x && px0 < x + w) px(s, px0, py0, r, g, b, a);
    }
  }
}

/**
 * Bitmap text. `scale` is the size of one font cell pixel, so glyphs are
 * 5*scale wide and 7*scale tall. align: 'left' | 'center' | 'right'.
 */
export function drawText(s, text, x, y, scale, [r, g, b], a = 1, align = 'left') {
  const str = String(text);
  const w = textWidth(str, scale);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  for (const ch of str) {
    const rows = GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || null;
    if (rows) {
      const lines = rows.split(',');
      for (let ry = 0; ry < GLYPH_H; ry++) {
        const line = lines[ry];
        for (let rx = 0; rx < GLYPH_W; rx++) {
          if (line[rx] === '1') {
            fillRect(s, cx + rx * scale, y + ry * scale, scale, scale, [r, g, b], a);
          }
        }
      }
    }
    cx += ADVANCE * scale;
  }
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, body) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(typeBytes, 4);
  out.set(body, 8);
  const crcInput = new Uint8Array(4 + body.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(body, 4);
  dv.setUint32(8 + body.length, crc32(crcInput));
  return out;
}

async function deflate(bytes) {
  // 'deflate' (not 'deflate-raw') gives zlib framing — header + Adler-32
  // — which is precisely what PNG's IDAT expects. Getting this wrong
  // produces a file every decoder rejects.
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Surface -> PNG bytes. */
export async function encodePng(s) {
  // Filter byte 0 (None) per scanline. Filtering would compress better,
  // but this image is flat colour and already tiny; simplicity wins.
  const raw = new Uint8Array(s.h * (1 + s.w * 4));
  for (let y = 0; y < s.h; y++) {
    const src = y * s.w * 4;
    const dst = y * (1 + s.w * 4);
    raw[dst] = 0;
    raw.set(s.data.subarray(src, src + s.w * 4), dst + 1);
  }
  const idat = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, s.w);
  hv.setUint32(4, s.h);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function hexToRgb(hex) {
  const h = String(hex || '#888888').replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [
    parseInt(s.slice(0, 2), 16) || 136,
    parseInt(s.slice(2, 4), 16) || 136,
    parseInt(s.slice(4, 6), 16) || 136,
  ];
}
