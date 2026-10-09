// ============================================================
// recapGif — record the battle recap as an animated GIF, in the browser.
//
// Lorne, 2026-10-09: "Can you make a gif generator? So we can download and
// post the recap as a gif?" The recap renders any moment on demand (its
// renderer takes a playback position and a clock), so the recorder steps
// both at a fixed frame rate into an offscreen canvas, scales each frame
// down, and hands it to the GIF writer (render/gifEncoder). Nothing is
// screen-captured: what you get is exactly what the recap draws, at an
// even frame rate whatever the machine is doing.
// ============================================================

import { buildPalette, paletteMapper, GifWriter } from '../render/gifEncoder';

export type RecapRender = (g: CanvasRenderingContext2D, pos: number, nowMs: number) => void;

/** 12.5 frames a second: an exact 8-hundredths GIF delay, smooth enough
 *  for fire and turning hulls, half the bytes of 25. */
export const GIF_FRAME_MS = 80;
/** Width of the GIF; the recap's 760x440 scales to 600x347. Big enough to
 *  read the names, small enough for a Discord or Reddit post. */
export const GIF_WIDTH = 600;
/** The longest stretch one GIF covers, in beats (ticks): about 18
 *  seconds at the recap's 2.2s a beat. Past that a GIF stops being a
 *  clip and the file stops fitting where people post. */
export const GIF_MAX_BEATS = 8;

/** Which stretch of the battle a GIF covers: from the start of the beat
 *  the slider is on (the whole fight when it is short or the slider is at
 *  the start), for at most GIF_MAX_BEATS beats. */
export function gifSpan(pos: number, beats: number): { from: number; to: number } {
  const end = beats - 1 + 0.98;
  let from = beats <= GIF_MAX_BEATS ? 0 : Math.max(0, Math.floor(pos));
  // Not a sliver at the very end: back up so the clip is a full length.
  if (end - from < Math.min(GIF_MAX_BEATS, end)) from = Math.max(0, end - GIF_MAX_BEATS);
  return { from, to: Math.min(end, from + GIF_MAX_BEATS) };
}

export interface RecordOptions {
  render: RecapRender;
  /** Source canvas size (the recap's own). */
  srcW: number;
  srcH: number;
  from: number;
  to: number;
  tickMs: number;
  onProgress?: (k: number) => void;
  /** Checked between frames; true stops the recording. */
  cancelled?: () => boolean;
}

const yieldToUi = () => new Promise<void>(r => setTimeout(r, 0));

export async function recordRecapGif(o: RecordOptions): Promise<Blob | null> {
  const src = document.createElement('canvas');
  src.width = o.srcW; src.height = o.srcH;
  const sg = src.getContext('2d');
  const outW = GIF_WIDTH, outH = Math.round((o.srcH / o.srcW) * GIF_WIDTH);
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const og = out.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  if (!sg || !og) return null;
  og.imageSmoothingEnabled = true;
  og.imageSmoothingQuality = 'high';

  const n = Math.max(2, Math.ceil(((o.to - o.from) * o.tickMs) / GIF_FRAME_MS));
  // A fixed clock origin, so the same span records the same GIF.
  const t0 = 100000;
  const grab = (k: number) => {
    o.render(sg, o.from + (k * GIF_FRAME_MS) / o.tickMs, t0 + k * GIF_FRAME_MS);
    og.drawImage(src, 0, 0, outW, outH);
    return og.getImageData(0, 0, outW, outH).data;
  };

  // One palette for the whole clip, from frames spread across it.
  const samples: Uint8ClampedArray[] = [];
  const SAMPLES = 10;
  for (let s = 0; s < SAMPLES; s++) {
    if (o.cancelled?.()) return null;
    samples.push(new Uint8ClampedArray(grab(Math.floor((s / (SAMPLES - 1)) * (n - 1)))));
    await yieldToUi();
  }
  const pal = buildPalette(samples);
  const map = paletteMapper(pal);
  const gif = new GifWriter(outW, outH, pal);
  for (let k = 0; k < n; k++) {
    if (o.cancelled?.()) return null;
    const idx = new Uint8Array(outW * outH);
    map(grab(k), idx);
    gif.frame(idx, GIF_FRAME_MS / 10);
    o.onProgress?.((k + 1) / n);
    if (k % 2 === 1) await yieldToUi();
  }
  return new Blob([gif.finish()], { type: 'image/gif' });
}

/** Save a blob under a filename, as a download. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
