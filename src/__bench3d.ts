// TEMPORARY 3D reel bench. Bundled to the scratchpad, driven from the
// browser, deleted from the tree afterwards — the repo convention is that
// the bench harness does not live in src (commit e14c4b37).
//
// Two rules from DESIGN-cinematic-recap.md §3 that this obeys:
//   * "The instrument must not exceed the product." The stage is built by
//     createStage with NO overrides, so exposure, lighting, tone mapping
//     and staging are exactly what a player sees. The bench only decides
//     WHEN to sample and how big the canvas is.
//   * Frames are reproducible: BattleStage reads no clock (no
//     performance.now/Date.now anywhere in it), so a given `pos` always
//     renders the same image and rounds are comparable.

import { createStage, type Stage } from './render3d/BattleStage';

interface BenchState {
  stage: Stage | null;
  canvas: HTMLCanvasElement | null;
  w: number;
  h: number;
}
const S: BenchState = { stage: null, canvas: null, w: 1600, h: 900 };

/** Build the stage over a real cinema payload at a realistic viewport. */
function init(detail: unknown, w = 1600, h = 900) {
  dispose();
  // Claim the capture flag BEFORE createStage builds its WebGL context:
  // preserveDrawingBuffer is a context-creation attribute, so setting this
  // afterwards would silently do nothing and every sheet would come back
  // blank. The product ships with it off -- holding that buffer is what
  // gets Safari to kill a tab -- so this bench is the thing that asks.
  (window as { __orbitalCapture?: boolean }).__orbitalCapture = true;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.style.width = `${Math.min(w, 900)}px`;
  canvas.style.height = 'auto';
  canvas.id = 'bench-canvas';
  document.body.appendChild(canvas);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stage = createStage(detail as any, canvas);
  stage.resize(w, h);
  S.stage = stage; S.canvas = canvas; S.w = w; S.h = h;
  return { beats: stage.beats, w, h };
}

function dispose() {
  try { S.stage?.dispose(); } catch { /* ignore */ }
  if (S.canvas?.parentNode) S.canvas.parentNode.removeChild(S.canvas);
  S.stage = null; S.canvas = null;
}

/** Render one frame and hand back a full-resolution PNG. */
function hero(pos: number, quality = 0.94): string {
  if (!S.stage || !S.canvas) throw new Error('bench not initialised');
  S.stage.setPos(pos);
  S.stage.render();
  // JPEG: a 1600x900 PNG of a starfield is megabytes and the transport
  // caps out. Quality 0.94 keeps plate detail and bolt cores honest.
  return S.canvas.toDataURL('image/jpeg', quality);
}

/**
 * Contact sheet: N frames tiled in reading order with the beat number
 * burned in, so a reviewer can cite "frame 14" and I can reproduce it
 * exactly from the same pos.
 */
function sheet(
  positions: number[], cols = 6, cellW = 480, cellH = 270, quality = 0.9,
): string {
  if (!S.stage || !S.canvas) throw new Error('bench not initialised');
  const rows = Math.ceil(positions.length / cols);
  const pad = 2, labelH = 16;
  const out = document.createElement('canvas');
  out.width = cols * (cellW + pad) - pad;
  out.height = rows * (cellH + labelH + pad) - pad;
  const g = out.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, out.width, out.height);

  positions.forEach((p, i) => {
    S.stage!.setPos(p);
    S.stage!.render();
    const cx = (i % cols) * (cellW + pad);
    const cy = Math.floor(i / cols) * (cellH + labelH + pad);
    g.drawImage(S.canvas!, cx, cy, cellW, cellH);
    g.fillStyle = '#0a0a0a';
    g.fillRect(cx, cy + cellH, cellW, labelH);
    g.fillStyle = '#9fb4c6';
    g.font = '11px monospace';
    g.fillText(`#${i}  pos ${p.toFixed(2)}`, cx + 4, cy + cellH + 12);
  });
  return out.toDataURL('image/jpeg', quality);
}

/** Evenly spaced sample positions across the whole reel. */
function spread(n: number): number[] {
  const beats = S.stage?.beats ?? 1;
  const last = Math.max(0, beats - 1);
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (i / (n - 1)) * last));
}

function stats() { return S.stage?.stats() ?? {}; }

(window as unknown as Record<string, unknown>).__bench = {
  init, dispose, hero, sheet, spread, stats,
  get beats() { return S.stage?.beats ?? 0; },
};
