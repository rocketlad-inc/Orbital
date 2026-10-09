// ============================================================
// gifEncoder — an animated GIF89a writer, small enough to own.
//
// For the battle recap's "Download GIF" (Lorne, 2026-10-09: "so we can
// download and post the recap as a gif"). Written here rather than
// pulled from npm: an npm install in this repo prunes the deploy's
// local wrangler, and the format is small.
//
//   * ONE palette for the whole animation (median cut over sampled
//     frames), so colours do not shimmer frame to frame, with the last
//     index kept for transparency;
//   * each frame after the first stores only the rectangle that changed,
//     and inside it every unchanged pixel is transparent: a space scene
//     is mostly sky that does not move, and long transparent runs are
//     what LZW compresses best;
//   * the LZW coder is the classic one (Poskanzer's compress, as every GIF
//     encoder since has used it): 12-bit codes, open-addressed hash.
// ============================================================

/** Index reserved for "unchanged since the last frame". */
export const GIF_TRANSPARENT = 255;
const MAX_COLORS = 255;

// ---------------------------------------------------------------- palette

/** 5 bits a channel: the key every colour lookup goes through. */
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * A palette of up to 255 colours for the pixels in `samples` (RGBA), by
 * median cut over a 15-bit histogram: the box with the most pixels times
 * the widest spread is split at its weighted median, until there are
 * enough boxes; each box's colour is its pixels' average.
 */
export function buildPalette(samples: readonly Uint8ClampedArray[], maxColors = MAX_COLORS): Uint8Array {
  const hist = new Float64Array(32768);
  for (const px of samples) {
    for (let i = 0; i < px.length; i += 4) hist[key15(px[i], px[i + 1], px[i + 2])]++;
  }
  const bins: number[] = [];
  for (let k = 0; k < 32768; k++) if (hist[k] > 0) bins.push(k);
  const ch = (k: number, c: number) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);

  type Box = { bins: number[]; count: number; spread: number; axis: number };
  const makeBox = (list: number[]): Box => {
    let count = 0;
    const lo = [31, 31, 31], hi = [0, 0, 0];
    for (const k of list) {
      count += hist[k];
      for (let c = 0; c < 3; c++) {
        const v = ch(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    let axis = 0;
    for (let c = 1; c < 3; c++) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
    return { bins: list, count, spread: hi[axis] - lo[axis], axis };
  };
  const boxes: Box[] = bins.length ? [makeBox(bins)] : [];
  while (boxes.length < maxColors) {
    let best = -1, score = 0;
    for (let n = 0; n < boxes.length; n++) {
      const b = boxes[n];
      if (b.bins.length < 2 || b.spread === 0) continue;
      const s = b.count * b.spread;
      if (s > score) { score = s; best = n; }
    }
    if (best < 0) break;
    const b = boxes[best];
    const sorted = [...b.bins].sort((x, y) => ch(x, b.axis) - ch(y, b.axis));
    let acc = 0, cut = 1;
    for (let n = 0; n < sorted.length - 1; n++) {
      acc += hist[sorted[n]];
      if (acc >= b.count / 2) { cut = n + 1; break; }
      cut = n + 1;
    }
    boxes.splice(best, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }
  const pal = new Uint8Array(256 * 3);
  boxes.forEach((b, n) => {
    let r = 0, g = 0, bl = 0;
    for (const k of b.bins) {
      const w = hist[k];
      r += (ch(k, 0) * 8 + 4) * w; g += (ch(k, 1) * 8 + 4) * w; bl += (ch(k, 2) * 8 + 4) * w;
    }
    pal[n * 3] = Math.round(r / b.count);
    pal[n * 3 + 1] = Math.round(g / b.count);
    pal[n * 3 + 2] = Math.round(bl / b.count);
  });
  return pal;
}

/** Maps RGBA pixels to palette indices, nearest colour, cached per 15-bit
 *  colour so each distinct colour is searched for once. */
export function paletteMapper(pal: Uint8Array, colors = MAX_COLORS) {
  const lut = new Int16Array(32768).fill(-1);
  const nearest = (k: number) => {
    const r = (k >> 10) * 8 + 4, g = ((k >> 5) & 31) * 8 + 4, b = (k & 31) * 8 + 4;
    let best = 0, bd = Infinity;
    for (let n = 0; n < colors; n++) {
      const dr = pal[n * 3] - r, dg = pal[n * 3 + 1] - g, db = pal[n * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = n; }
    }
    lut[k] = best;
    return best;
  };
  return (px: Uint8ClampedArray, out: Uint8Array) => {
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const k = key15(px[i], px[i + 1], px[i + 2]);
      const v = lut[k];
      out[j] = v >= 0 ? v : nearest(k);
    }
  };
}

// ---------------------------------------------------------------- bytes

class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  byte(v: number) {
    if (this.len >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = v & 0xff;
  }
  word(v: number) { this.byte(v); this.byte(v >> 8); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  bytes() { return this.buf.subarray(0, this.len); }
}

// ---------------------------------------------------------------- LZW

const BITS = 12, HSIZE = 5003, MAXMAXCODE = 1 << BITS;
const MASKS = [0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff,
  0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff];

/** LZW-compress `pixels` (indices) into GIF image-data sub-blocks. */
function lzw(pixels: Uint8Array, minCodeSize: number, out: Bytes): void {
  const htab = new Int32Array(HSIZE).fill(-1);
  const codetab = new Int32Array(HSIZE);
  const initBits = minCodeSize + 1;
  const clearCode = 1 << minCodeSize;
  const eofCode = clearCode + 1;
  let nBits = initBits;
  let maxcode = (1 << nBits) - 1;
  let freeEnt = clearCode + 2;
  let clearFlg = false;
  let curAccum = 0, curBits = 0;
  const block = new Uint8Array(255);
  let blockLen = 0;
  const flushBlock = () => {
    if (blockLen > 0) {
      out.byte(blockLen);
      for (let n = 0; n < blockLen; n++) out.byte(block[n]);
      blockLen = 0;
    }
  };
  const charOut = (c: number) => {
    block[blockLen++] = c;
    if (blockLen >= 255) flushBlock();
  };
  const output = (code: number) => {
    curAccum &= MASKS[curBits];
    curAccum = curBits > 0 ? curAccum | (code << curBits) : code;
    curBits += nBits;
    while (curBits >= 8) { charOut(curAccum & 0xff); curAccum >>= 8; curBits -= 8; }
    if (freeEnt > maxcode || clearFlg) {
      if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
      else { nBits++; maxcode = nBits === BITS ? MAXMAXCODE : (1 << nBits) - 1; }
    }
    if (code === eofCode) {
      while (curBits > 0) { charOut(curAccum & 0xff); curAccum >>= 8; curBits -= 8; }
      flushBlock();
    }
  };

  let hshift = 0;
  for (let f = HSIZE; f < 65536; f *= 2) hshift++;
  hshift = 8 - hshift;

  out.byte(minCodeSize);
  output(clearCode);
  let ent = pixels[0];
  outer: for (let p = 1; p < pixels.length; p++) {
    const c = pixels[p];
    const fcode = (c << BITS) + ent;
    let i = (c << hshift) ^ ent;
    if (htab[i] === fcode) { ent = codetab[i]; continue; }
    if (htab[i] >= 0) {
      const disp = i === 0 ? 1 : HSIZE - i;
      do {
        i -= disp;
        if (i < 0) i += HSIZE;
        if (htab[i] === fcode) { ent = codetab[i]; continue outer; }
      } while (htab[i] >= 0);
    }
    output(ent);
    ent = c;
    if (freeEnt < MAXMAXCODE) {
      codetab[i] = freeEnt++;
      htab[i] = fcode;
    } else {
      htab.fill(-1);
      freeEnt = clearCode + 2;
      clearFlg = true;
      output(clearCode);
    }
  }
  output(ent);
  output(eofCode);
  out.byte(0);   // block terminator
}

// ---------------------------------------------------------------- writer

export class GifWriter {
  private out = new Bytes();
  private prev: Uint8Array | null = null;
  constructor(readonly width: number, readonly height: number, palette: Uint8Array) {
    const o = this.out;
    o.str('GIF89a');
    o.word(width); o.word(height);
    o.byte(0xf7);          // global colour table, 8 bits, 256 entries
    o.byte(0);             // background index
    o.byte(0);             // pixel aspect
    for (let n = 0; n < 256 * 3; n++) o.byte(palette[n] ?? 0);
    // Loop forever (NETSCAPE2.0).
    o.byte(0x21); o.byte(0xff); o.byte(11); o.str('NETSCAPE2.0');
    o.byte(3); o.byte(1); o.word(0); o.byte(0);
  }

  /** Add a frame of palette indices (width x height), shown for
   *  `delayCs` hundredths of a second. */
  frame(indices: Uint8Array, delayCs: number): void {
    const W = this.width, H = this.height;
    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
    let data = indices;
    const prev = this.prev;
    if (prev) {
      // Only the rectangle that changed, unchanged pixels transparent.
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (indices[row + x] !== prev[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      data = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const src = (y0 + y) * W + x0;
        for (let x = 0; x < w; x++) {
          const v = indices[src + x];
          data[y * w + x] = v === prev[src + x] ? GIF_TRANSPARENT : v;
        }
      }
    }
    this.prev = indices;
    const o = this.out;
    // Graphic control: leave the frame in place, transparent index on.
    o.byte(0x21); o.byte(0xf9); o.byte(4);
    o.byte((1 << 2) | (prev ? 1 : 0));
    o.word(Math.max(2, Math.round(delayCs)));
    o.byte(GIF_TRANSPARENT);
    o.byte(0);
    // Image descriptor.
    o.byte(0x2c);
    o.word(x0); o.word(y0); o.word(x1 - x0 + 1); o.word(y1 - y0 + 1);
    o.byte(0);
    lzw(data, 8, o);
  }

  finish(): Uint8Array {
    this.out.byte(0x3b);
    return this.out.bytes();
  }
}
