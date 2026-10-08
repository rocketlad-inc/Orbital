// ============================================================
// World-menu pixel probe (diagnostic, temporary).
//
// "Lorneland and the city is still wiggling" (2026-10-07). The camera
// probe proved the focused world's centre, radius, zoom and the canvas
// size all hold still to 0.1 px on his machine while it quivers. So the
// remaining question is PIXELS: does the city's name tag actually move,
// and does it move when the city is drawn (canvas state) or only by the
// end of the frame (something drawn over it)?
//
// Twice a second while a world menu is open, at two points in the frame:
//   'mid' -- right after the close-up city is drawn
//   'end' -- after everything else has been drawn
// it copies two small regions into a private, CPU-backed scratch canvas
// (never reading the map canvas itself, so Chrome keeps it on the GPU):
//   tag   -- the city name tag: centroid of its bright text pixels
//   patch -- a bit of planet surface beside the city: mean pixel change
// and, at 'mid', the canvas transform the city was drawn with.
// ============================================================

const TAG_W = 160, TAG_H = 44, PATCH = 48, EVERY_MS = 500;

interface Stage { lastTag: { x: number; y: number } | null; lastPatch: Uint8ClampedArray | null; maxShift: number; shifts: number; maxDiff: number; diffs: number }
const fresh = (): Stage => ({ lastTag: null, lastPatch: null, maxShift: 0, shifts: 0, maxDiff: 0, diffs: 0 });
const stages: Record<'mid' | 'end', Stage> = { mid: fresh(), end: fresh() };
let maxTf = 0;
let scratch: HTMLCanvasElement | null = null;
let sctx: CanvasRenderingContext2D | null = null;
let sampling = false;
let lastSampleAt = -1e9;

/** Call once per frame before the 'mid' sample: decides whether this
 *  frame is sampled (both stages sample the same frames). */
export function wmProbeFrame(nowMs: number, open: boolean): void {
  sampling = open && nowMs - lastSampleAt >= EVERY_MS;
  if (sampling) lastSampleAt = nowMs;
  if (!open) { stages.mid.lastTag = stages.end.lastTag = null; stages.mid.lastPatch = stages.end.lastPatch = null; }
}

export function wmProbeSample(
  stage: 'mid' | 'end', cv: HTMLCanvasElement, g: CanvasRenderingContext2D,
  c: { x: number; y: number; r: number },
): void {
  if (!sampling) return;
  try {
    if (stage === 'mid') {
      const m = g.getTransform();
      maxTf = Math.max(maxTf, Math.abs(m.e) + Math.abs(m.f) + Math.abs(m.b) * 1000 + Math.abs(m.c) * 1000);
    }
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = TAG_W; scratch.height = TAG_H + PATCH;
      sctx = scratch.getContext('2d', { willReadFrequently: true });
    }
    if (!sctx) return;
    const tx = Math.round(c.x - c.r * 0.42 - TAG_W / 2), ty = Math.round(c.y - c.r * 1.1 - TAG_H * 0.6);
    const px = Math.round(c.x + c.r * 0.12), py = Math.round(c.y - c.r * 0.82);
    sctx.clearRect(0, 0, TAG_W, TAG_H + PATCH);
    sctx.drawImage(cv, tx, ty, TAG_W, TAG_H, 0, 0, TAG_W, TAG_H);
    sctx.drawImage(cv, px, py, PATCH, PATCH, 0, TAG_H, PATCH, PATCH);
    const tag = sctx.getImageData(0, 0, TAG_W, TAG_H).data;
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < tag.length; i += 4) {
      const lum = tag[i] * 0.3 + tag[i + 1] * 0.59 + tag[i + 2] * 0.11;
      if (lum > 170) { const p = i / 4; sx += p % TAG_W; sy += Math.floor(p / TAG_W); n++; }
    }
    const st = stages[stage];
    if (n > 20) {
      const cur = { x: sx / n, y: sy / n };
      if (st.lastTag) {
        const d = Math.hypot(cur.x - st.lastTag.x, cur.y - st.lastTag.y);
        if (d > st.maxShift) st.maxShift = d;
        if (d > 0.3) st.shifts++;
      }
      st.lastTag = cur;
    }
    const patch = sctx.getImageData(0, TAG_H, PATCH, PATCH).data;
    if (st.lastPatch && st.lastPatch.length === patch.length) {
      let sum = 0;
      for (let i = 0; i < patch.length; i += 4) {
        sum += Math.abs(patch[i] - st.lastPatch[i]) + Math.abs(patch[i + 1] - st.lastPatch[i + 1]) + Math.abs(patch[i + 2] - st.lastPatch[i + 2]);
      }
      const mean = sum / (PATCH * PATCH * 3);
      if (mean > st.maxDiff) st.maxDiff = mean;
      if (mean > 1) st.diffs++;
    }
    st.lastPatch = new Uint8ClampedArray(patch);
  } catch { /* diagnostics must never disturb the game */ }
}

/** The window's results for the heartbeat, then reset. Null if no menu. */
export function wmProbeTake(): Record<string, [number, number]> | null {
  const any = stages.mid.lastTag || stages.end.lastTag || stages.mid.maxShift || stages.end.maxShift
    || stages.mid.maxDiff || stages.end.maxDiff || maxTf;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const out: Record<string, [number, number]> | null = any ? {
    wmtagm: [r1(stages.mid.maxShift), stages.mid.shifts],
    wmtage: [r1(stages.end.maxShift), stages.end.shifts],
    wmpatm: [r1(stages.mid.maxDiff), stages.mid.diffs],
    wmpate: [r1(stages.end.maxDiff), stages.end.diffs],
    wmtf: [r1(maxTf), 0],
  } : null;
  for (const k of ['mid', 'end'] as const) {
    const s = stages[k];
    s.maxShift = 0; s.shifts = 0; s.maxDiff = 0; s.diffs = 0;
  }
  maxTf = 0;
  return out;
}
