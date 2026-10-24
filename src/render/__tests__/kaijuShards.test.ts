/**
 * THE BREAK'S SHARDS ARE ROCK, AND THEY FALL UNDER THE FLEET.
 *
 * Studio clip "The Leviathan attacks Io" (judges, 2026-10-23, f345-f377):
 * the broken world burst into ~28 flat, fully saturated yellow triangles
 * over the grey rubble and over the guard fleet. drawStrike filled every
 * shard with `body.color` (Io's map-dot yellow, not the ash-grey globe on
 * screen), and drew them in the FX pass after the hulls.
 */
import fs from 'fs';
import path from 'path';
import { RenderContext } from '../mapRenderer';
import {
  spawnKaijuStrike, drawKaijuFx, drawKaijuShards, kaijuShardTones, resetKaijuFx, KAIJU_BREAK_MS,
} from '../kaijuFx';
import type { Body } from '../../types';

const W = 1280, H = 720;
const IO_YELLOW = '#e8d44a';

type Fill = { style: string; alpha: number };
function recordingCtx() {
  const fills: Fill[] = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = { canvas: { width: W, height: H }, globalAlpha: 1, fillStyle: '#000' };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (..._args: unknown[]) => {
        if (prop === 'fill' || prop === 'fillRect') fills.push({ style: String(t.fillStyle), alpha: Number(t.globalAlpha) });
        if (prop.startsWith('create')) return gradient;
        if (prop === 'measureText') return { width: 10 };
        return undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

const sol = { id: 'sol', name: 'Sol', type: 'star', radius: 20, parent: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0, color: '#ff0' } as unknown as Body;
const io = {
  id: 'io', name: 'Io', type: 'moon', radius: 1.2, parent: 'sol', orbitRadius: 300, orbitPeriod: 1e9, angle0: 0.3,
  color: IO_YELLOW, sterilisedAtTick: 3,
} as unknown as Body;

let clock = 5_000_000;
beforeEach(() => {
  resetKaijuFx();
  clock += 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  // jsdom has no canvas: the glow sprite cache logs on every miss.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function frame() {
  const { ctx, fills } = recordingCtx();
  const rc = {
    ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
    camera: { x: 300 * Math.cos(0.3), y: 300 * Math.sin(0.3), scale: 80 }, bodies: [sol, io], t: 20, nowMs: clock, factions: [],
  } as unknown as RenderContext;
  return { rc, fills };
}

/** Saturation (HSL) of an rgb()/hex fill, 0..1. */
function saturation(style: string): number {
  let r: number, g: number, b: number;
  const m = /rgba?\(([^)]+)\)/.exec(style);
  if (m) [r, g, b] = m[1].split(',').map(v => Number(v.trim()) / 255);
  else {
    const n = parseInt(style.replace('#', ''), 16);
    r = ((n >> 16) & 255) / 255; g = ((n >> 8) & 255) / 255; b = (n & 255) / 255;
  }
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return 0;
  return (mx - mn) / (1 - Math.abs(2 * l - 1));
}

/** Opaque flat fills: the rock itself (the violet heat is rgba, glows are
 *  gradients). */
const rock = (fills: Fill[]) => fills.filter(f => f.alpha > 0.05 && /^(#|rgb\()/.test(f.style));

describe('the shards of a broken world', () => {
  it('are rock-coloured and shaded, never the world\'s map-dot colour', () => {
    spawnKaijuStrike('brk', 'io', 'break');
    clock += KAIJU_BREAK_MS * 0.7;            // just after the burst
    const { rc, fills } = frame();
    drawKaijuShards(rc, clock);
    const shards = rock(fills);
    expect(shards.length).toBeGreaterThanOrEqual(28);
    expect(shards.some(f => f.style.toLowerCase() === IO_YELLOW)).toBe(false);
    for (const f of shards) expect(saturation(f.style)).toBeLessThan(0.2);
    // Lit and shadowed faces: at least two tones, one clearly darker.
    expect(new Set(shards.map(f => f.style)).size).toBeGreaterThanOrEqual(2);
  });

  it('keep a trace of a living world\'s hue but none once it is ash', () => {
    const living = kaijuShardTones(IO_YELLOW, 0);
    const ash = kaijuShardTones(IO_YELLOW, 1);
    expect(saturation(living.lit)).toBeGreaterThan(saturation(ash.lit));
    expect(saturation(ash.lit)).toBeLessThan(0.1);
  });

  it('are drawn in the under-hull pass, not over the fleet with the rest of the strike', () => {
    spawnKaijuStrike('brk', 'io', 'break');
    clock += KAIJU_BREAK_MS * 0.7;
    const top = frame();
    drawKaijuFx(top.rc, clock);
    // The strike's own pass (after the hulls) draws no rock now; only its
    // flash and shockwave, which are light.
    expect(rock(top.fills).length).toBe(0);
    // And MapCanvas draws the shard pass with the wrecks, before any hull.
    const src = fs.readFileSync(path.join(__dirname, '../../components/MapCanvas.tsx'), 'utf8');
    const shardsAt = src.indexOf('drawKaijuShards(renderContext');
    const shipsAt = src.indexOf('drawShip(ship, renderContext');
    expect(shardsAt).toBeGreaterThan(0);
    expect(shardsAt).toBeLessThan(shipsAt);
  });

  it('draw nothing before the burst', () => {
    spawnKaijuStrike('brk', 'io', 'break');
    clock += KAIJU_BREAK_MS * 0.3;
    const { rc, fills } = frame();
    drawKaijuShards(rc, clock);
    expect(fills.length).toBe(0);
  });
});
