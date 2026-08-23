// Lab harness for MatchStage: real game data, no admin login needed.
import fixture from './match.json';
import { createMatchMap as createMatchStage } from '../render/matchMap';
import type { MatchSummary, SnapshotRow } from '../render/matchWorld';

const SINK = 'http://127.0.0.1:5079/';
const canvas = document.createElement('canvas');
canvas.width = 1280; canvas.height = 720;
document.body.appendChild(canvas);

const summary = (fixture as any).summary as MatchSummary;
const rows = (fixture as any).rows as SnapshotRow[];
const __t0 = performance.now();
const stage = createMatchStage(summary, canvas);
(window as any).__buildMs = Math.round(performance.now() - __t0);
const __t1 = performance.now();
stage.applyRows(rows);
(window as any).__applyMs = Math.round(performance.now() - __t1);

(window as any).__mview = (m: 'auto' | 'wide') => stage.setView?.(m);
(window as any).__mshot = async (name: string, tick: number, frac = 0) => {
  // Let the eased camera converge: single-frame captures otherwise
  // always catch it mid-pan.
  for (let i = 0; i < 90; i++) stage.setTick(tick, frac);
  stage.render();
  await fetch(SINK, { method: 'POST', body: `${name}|${canvas.toDataURL('image/png')}` });
  return 'ok';
};
(window as any).__mstats = (tick: number) => {
  const w = stage.worldAt(tick);
  return { ships: w.ships.size, stls: w.stls.size, factions: w.stock.size,
    synthetic: w.synthetic, rows: rows.length };
};
(window as any).__merr = [];
window.addEventListener('error', e => (window as any).__merr.push(String(e.message)));

/**
 * Film the match the way it actually plays: step the clock continuously
 * so the eased camera composes as it does in playback, and post every
 * Nth frame as a JPEG. Single-frame captures lie about a director whose
 * whole grammar is the move between shots.
 */
(window as any).__mfilm = async (t0: number, t1: number, dt: number, every: number) => {
  let i = 0, shot = 0;
  for (let t = t0; t <= t1; t += dt) {
    const tick = Math.floor(t);
    stage.setTick(tick, t - tick);
    stage.render();
    if (i % every === 0) {
      const name = 'pz' + String(shot).padStart(4, '0') + '.jpg';
      await fetch(SINK, { method: 'POST', body: `${name}|${canvas.toDataURL('image/jpeg', 0.82)}` });
      shot++;
    }
    i++;
  }
  return shot;
};

// The stage and its canvas, so probes can be written from the console
// without rebuilding the bundle for each question.
(window as any).__stage = stage;
(window as any).__canvas = canvas;

/**
 * How much course line actually reaches the screen: pixels in the
 * trajectory's teal, per tick. The only honest test of "I can't see any
 * trajectory lines", because it measures the output rather than the
 * intent. Strided so a whole match can be swept without stalling the
 * renderer.
 */
(window as any).__mtrace = (t0: number, t1: number, stride = 3) => {
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const W = canvas.width, H = canvas.height;
  let hot = 0, ticks = 0;
  const px: number[] = [];
  for (let t = t0; t <= t1; t++) {
    stage.setTick(t, 0.5);
    stage.render();
    const d = g.getImageData(0, 0, W, H).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * stride) {
      if (d[i] < 150 && d[i + 1] > 165 && d[i + 2] > 165
          && Math.abs(d[i + 1] - d[i + 2]) < 45 && d[i + 1] - d[i] > 55) n++;
    }
    ticks++;
    if (n > 12) { hot++; px.push(n); }
  }
  px.sort((a, b) => a - b);
  return { ticks, withCourse: hot, pct: Math.round(100 * hot / ticks),
    medianPx: px.length ? px[px.length >> 1] : 0 };
};
