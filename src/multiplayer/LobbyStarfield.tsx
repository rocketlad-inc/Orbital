// ============================================================
// LobbyStarfield — the sky behind the lobby.
//
// Three depth layers of stars drift past at different speeds, so the
// page feels like a window on a ship in motion rather than a wallpaper.
// Each layer is painted ONCE onto its own offscreen canvas, twice the
// viewport wide so it can wrap; a frame is then three drawImage calls
// plus a few dozen twinkling stars. Star colours follow real spectral
// classes (blue-white O/B to red M), weighted the way the sky is:
// mostly white and pale yellow, few blue, some orange and red.
//
// Cheap on purpose: capped at 2x device pixels and ~30 fps, stopped
// while the tab is hidden, and a still sky for prefers-reduced-motion.
// ============================================================

import React, { useEffect, useRef } from 'react';

type Twinkler = { x: number; y: number; r: number; c: string; phase: number; speed: number; layer: number };

const TINTS = [
  { c: '255,255,255', w: 40 },
  { c: '255,246,226', w: 24 },
  { c: '255,228,190', w: 12 },
  { c: '208,222,255', w: 12 },
  { c: '170,196,255', w: 5 },
  { c: '255,196,150', w: 5 },
  { c: '255,160,130', w: 2 },
];
const TINT_TOTAL = TINTS.reduce((s, t) => s + t.w, 0);

function tint(rand: () => number): string {
  let x = rand() * TINT_TOTAL;
  for (const t of TINTS) { x -= t.w; if (x <= 0) return t.c; }
  return TINTS[0].c;
}

/** Seeded so a resize repaints the same sky instead of a new one. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per layer: stars per 10k px², radius range, brightness, drift px/s.
const LAYERS = [
  { density: 5.2, rMin: 0.35, rMax: 0.8, aMin: 0.25, aMax: 0.6, drift: 2.2 },
  { density: 1.6, rMin: 0.6, rMax: 1.2, aMin: 0.45, aMax: 0.85, drift: 5.5 },
  { density: 0.32, rMin: 1.0, rMax: 1.8, aMin: 0.7, aMax: 1.0, drift: 11 },
];

export function LobbyStarfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let W = 0, H = 0, dpr = 1;
    let layers: HTMLCanvasElement[] = [];
    let backdrop: HTMLCanvasElement | null = null;
    let twinklers: Twinkler[] = [];
    let raf = 0;
    let last = 0;
    const t0 = performance.now();

    const paint = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const rand = rng(1969);

      // The still part: deep ground, a faint Milky Way band, and a few
      // soft nebulae. Painted once.
      backdrop = document.createElement('canvas');
      backdrop.width = canvas.width;
      backdrop.height = canvas.height;
      const b = backdrop.getContext('2d')!;
      b.scale(dpr, dpr);
      const ground = b.createLinearGradient(0, 0, 0, H);
      ground.addColorStop(0, '#05080f');
      ground.addColorStop(1, '#070b13');
      b.fillStyle = ground;
      b.fillRect(0, 0, W, H);
      // Milky Way: a wide diagonal band of haze plus dense faint dust.
      b.save();
      b.translate(W * 0.5, H * 0.5);
      b.rotate(-0.42);
      const bandH = Math.max(W, H) * 0.34;
      const band = b.createLinearGradient(0, -bandH, 0, bandH);
      band.addColorStop(0, 'rgba(120,140,190,0)');
      band.addColorStop(0.5, 'rgba(150,160,210,0.07)');
      band.addColorStop(1, 'rgba(120,140,190,0)');
      b.fillStyle = band;
      b.fillRect(-W * 1.5, -bandH, W * 3, bandH * 2);
      for (let i = 0; i < (W * H) / 140; i++) {
        const u = (rand() - 0.5) * W * 2.4;
        const v = (rand() + rand() + rand() - 1.5) * bandH * 0.55;
        b.fillStyle = `rgba(210,220,255,${0.05 + rand() * 0.12})`;
        b.fillRect(u, v, 0.8, 0.8);
      }
      b.restore();
      const nebulae = [
        { x: 0.12, y: 0.22, r: 0.42, c: '90,60,160', a: 0.10 },
        { x: 0.86, y: 0.12, r: 0.38, c: '255,170,80', a: 0.07 },
        { x: 0.72, y: 0.78, r: 0.46, c: '40,120,150', a: 0.08 },
        { x: 0.30, y: 0.92, r: 0.34, c: '160,70,110', a: 0.05 },
      ];
      for (const n of nebulae) {
        const R = Math.max(W, H) * n.r;
        const g = b.createRadialGradient(W * n.x, H * n.y, 0, W * n.x, H * n.y, R);
        g.addColorStop(0, `rgba(${n.c},${n.a})`);
        g.addColorStop(1, `rgba(${n.c},0)`);
        b.fillStyle = g;
        b.fillRect(0, 0, W, H);
      }

      // Drifting layers, each twice as wide as the screen so it wraps.
      twinklers = [];
      layers = LAYERS.map((L, li) => {
        const c = document.createElement('canvas');
        c.width = Math.round(W * 2 * dpr);
        c.height = Math.round(H * dpr);
        const x = c.getContext('2d')!;
        x.scale(dpr, dpr);
        const n = Math.round((W * 2 * H) / 10000 * L.density);
        for (let i = 0; i < n; i++) {
          const px = rand() * W;           // paint in the first half...
          const py = rand() * H;
          const r = L.rMin + rand() * (L.rMax - L.rMin);
          const a = L.aMin + rand() * (L.aMax - L.aMin);
          const col = tint(rand);
          // A few of the nearest stars twinkle (drawn live, not baked).
          if (li === 2 && rand() < 0.35) {
            twinklers.push({ x: px, y: py, r, c: col, phase: rand() * Math.PI * 2, speed: 0.6 + rand() * 1.4, layer: li });
            continue;
          }
          for (const dx of [0, W]) {         // ...and again one screen right
            if (r > 1.2) {
              const g = x.createRadialGradient(px + dx, py, 0, px + dx, py, r * 4);
              g.addColorStop(0, `rgba(${col},${a * 0.35})`);
              g.addColorStop(1, `rgba(${col},0)`);
              x.fillStyle = g;
              x.fillRect(px + dx - r * 4, py - r * 4, r * 8, r * 8);
            }
            x.fillStyle = `rgba(${col},${a})`;
            x.beginPath();
            x.arc(px + dx, py, r, 0, Math.PI * 2);
            x.fill();
          }
        }
        return c;
      });
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;          // ~30 fps is plenty for a sky
      last = now;
      draw((now - t0) / 1000);
    };

    const draw = (t: number) => {
      if (!backdrop) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(backdrop, 0, 0);
      const wPx = W * dpr;
      layers.forEach((layer, i) => {
        const off = reduce ? 0 : ((t * LAYERS[i].drift * dpr) % wPx);
        ctx.drawImage(layer, -off, 0);
      });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const s of twinklers) {
        const off = reduce ? 0 : (t * LAYERS[s.layer].drift) % W;
        let x = s.x - off;
        if (x < 0) x += W;
        const a = reduce ? 0.85 : 0.55 + 0.45 * Math.sin(s.phase + t * s.speed);
        const g = ctx.createRadialGradient(x, s.y, 0, x, s.y, s.r * 5);
        g.addColorStop(0, `rgba(${s.c},${a * 0.5})`);
        g.addColorStop(1, `rgba(${s.c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - s.r * 5, s.y - s.r * 5, s.r * 10, s.r * 10);
        ctx.fillStyle = `rgba(${s.c},${a})`;
        ctx.beginPath();
        ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduce) { draw(0); return; }
      raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else start();
    };
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { paint(); start(); }, 150);
    };

    paint();
    start();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="lx-stars" aria-hidden />;
}
