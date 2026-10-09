// The recap's GIF writer, round-tripped through a small independent
// decoder: every frame must come back exactly as the indices that went in
// (frames after the first are stored as a changed rectangle with
// transparent holes, so the decoder composites them as a viewer would).

import { buildPalette, paletteMapper, GifWriter, GIF_TRANSPARENT } from '../gifEncoder';
import { gifSpan } from '../../multiplayer/recapGif';

function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = []; dict[eoi] = [];
    size = minCodeSize + 1;
  };
  reset();
  let pos = 0, bit = 0, prev: number[] | null = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      if (data[pos] & (1 << bit)) code |= 1 << i;
      if (++bit === 8) { bit = 0; pos++; }
    }
    return code;
  };
  let o = 0;
  while (pos < data.length) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else entry = [...(prev ?? []), (prev ?? [])[0]];
    for (const v of entry) out[o++] = v;
    if (prev) dict.push([...prev, entry[0]]);
    if (dict.length === (1 << size) && size < 12) size++;
    prev = entry;
  }
  return out;
}

function decode(bytes: Uint8Array) {
  const W = bytes[6] | (bytes[7] << 8), H = bytes[8] | (bytes[9] << 8);
  let p = 13 + 256 * 3;
  const frames: Uint8Array[] = [];
  const delays: number[] = [];
  let canvas = new Uint8Array(W * H);
  let transparent = -1, delay = 0;
  while (p < bytes.length) {
    const b = bytes[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        const packed = bytes[p + 1];
        delay = bytes[p + 2] | (bytes[p + 3] << 8);
        transparent = packed & 1 ? bytes[p + 4] : -1;
      }
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p++;
      continue;
    }
    if (b === 0x2c) {
      const x = bytes[p] | (bytes[p + 1] << 8), y = bytes[p + 2] | (bytes[p + 3] << 8);
      const w = bytes[p + 4] | (bytes[p + 5] << 8), h = bytes[p + 6] | (bytes[p + 7] << 8);
      p += 9;
      const min = bytes[p++];
      const chunks: number[] = [];
      while (bytes[p] !== 0) { const n = bytes[p++]; for (let i = 0; i < n; i++) chunks.push(bytes[p++]); }
      p++;
      const px = lzwDecode(Uint8Array.from(chunks), min, w * h);
      const next = canvas.slice();
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const v = px[j * w + i];
        if (v !== transparent) next[(y + j) * W + x + i] = v;
      }
      canvas = next;
      frames.push(canvas);
      delays.push(delay);
    }
  }
  return { W, H, frames, delays };
}

describe('GIF writer', () => {
  it('round-trips an animation exactly, changed rectangles and all', () => {
    const W = 200, H = 120;
    const src: Uint8Array[] = [];
    for (let f = 0; f < 6; f++) {
      const idx = new Uint8Array(W * H);
      for (let i = 0; i < idx.length; i++) idx[i] = ((i * 2654435761) >>> 24) % 200;   // noise: fills the 4096-code table, forcing a clear
      for (let y = 10; y < 18; y++) for (let x = 5 + f * 6; x < 13 + f * 6; x++) idx[y * W + x] = 250;
      src.push(idx);
    }
    src.push(src[5].slice());   // a frame with nothing changed
    const pal = new Uint8Array(256 * 3).map((_, i) => (i * 37) & 255);
    const gw = new GifWriter(W, H, pal);
    for (const f of src) gw.frame(f, 8);
    const out = decode(gw.finish());
    expect(out.W).toBe(W);
    expect(out.H).toBe(H);
    expect(out.frames).toHaveLength(src.length);
    out.frames.forEach((f, n) => expect(Array.from(f)).toEqual(Array.from(src[n])));
    expect(out.delays.every(d => d === 8)).toBe(true);
  });

  it('builds a palette that leaves the transparent index free and maps colours closely', () => {
    const px = new Uint8ClampedArray(4 * 300);
    for (let i = 0; i < 300; i++) {
      px[i * 4] = (i * 13) & 255; px[i * 4 + 1] = (i * 7) & 255; px[i * 4 + 2] = (i * 3) & 255; px[i * 4 + 3] = 255;
    }
    const pal = buildPalette([px]);
    const map = paletteMapper(pal);
    const idx = new Uint8Array(300);
    map(px, idx);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      expect(idx[i]).not.toBe(GIF_TRANSPARENT);
      const k = idx[i] * 3;
      worst = Math.max(worst, Math.abs(pal[k] - px[i * 4]) + Math.abs(pal[k + 1] - px[i * 4 + 1]) + Math.abs(pal[k + 2] - px[i * 4 + 2]));
    }
    expect(worst).toBeLessThan(40);
  });
});

describe('which stretch a recap GIF covers', () => {
  // The whole fight, every time: an 8-tick clip from the slider "cut off
  // early" (Lorne, 2026-10-09).
  it('takes a short fight whole', () => {
    expect(gifSpan(5)).toEqual({ from: 0, to: 4.98 });
  });
  it('takes a long fight whole, to the end of its last beat', () => {
    expect(gifSpan(55)).toEqual({ from: 0, to: 54.98 });
  });
  it('covers a one-tick fight', () => {
    expect(gifSpan(1)).toEqual({ from: 0, to: 0.98 });
  });
});
