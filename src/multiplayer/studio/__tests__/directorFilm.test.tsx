// The film's frame loop (director.ts filmFrame), against a stand-in map
// built the way MapCanvas is: the camera is React state set from the
// 'orbital:studio-camera' event, and the draw is a closure a passive
// effect hands to a ref. Judges, 2026-10-23, round 3:
//   - the frame jumped once as the world came to rest (seven clips);
//   - the first frame of a take, and the first after a cut, were drawn
//     before the map had settled at the new view (dots, stand-in sprites,
//     select-and-strike's frame 0 on the wrong world);
//   - the world menu came up 2.2 s after its step ("building on a world");
//   - a followed freighter vanished for a frame at each `advance` cut.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { smoothedTick } from '../../../render/tickPhase';

const mockMap = {
  drawn: new Map<string, { x: number; y: number; ms: number }>(),
  /** The continuity guard's memory: where each hull was last drawn. */
  history: new Map<string, { x: number; y: number; ms: number; slide?: { fx: number; fy: number; t0: number } }>(),
  forgets: 0,
  /** Added to every hull's true position (an `advance` moving it far). */
  jump: 0,
};

jest.mock('../../../render/mapRenderer', () => ({
  drawnShipWorldPos: (id: string) => mockMap.drawn.get(id),
  recentDrawnShipWorldPos: (id: string, age: number) => {
    const e = mockMap.drawn.get(id);
    return e && performance.now() - e.ms <= age ? e : undefined;
  },
  forgetDrawnShips: () => { mockMap.forgets++; mockMap.drawn.clear(); mockMap.history.clear(); },
  torchTrajectorySamples: () => [],
  setStudioWashScale: () => {},
}));
// A hull flying along x at 100 units a tick.
jest.mock('../../../physics/torchTransfer', () => ({
  torchPositionFromSamples: (_s: unknown, t: number) => ({ x: 100 * t + mockMap.jump, y: 0 }),
}));
jest.mock('../../../game/combat', () => ({
  shipWorldPosition: (_s: unknown, t: number) => ({ x: 100 * t + mockMap.jump, y: 0 }),
}));
jest.mock('../../../physics/orbitalMechanics', () => ({
  bodyPosition: (b: { id: string }) => ({ x: b.id === 'europa' ? 50000 : 0, y: 0 }),
}));
jest.mock('../../api', () => ({
  apiFetch: async (url: string) => {
    if (/\/order$/.test(url)) mockMap.jump = 20000;   // the cut moves the hull far on
    return { ok: true, status: 200, data: {} };
  },
}));

// eslint-disable-next-line import/first
import { Director, Shot } from '../director';

interface Draw { cam: { x: number; y: number; scale: number }; tick: number; shipX: number; art: boolean; ms: number }

const state = {
  currentTick: 10, nextTickAt: null, tickIntervalMs: 300,
  bodies: [{ id: 'europa', radius: 1 }, { id: 'earth', radius: 1 }],
  ships: [{ id: 'g:st_a', transit: { currentTransfer: { arriveTick: 99 } } }],
};

/** The stand-in map. */
const draws: Draw[] = [];
const artLoaded = new Set<string>();
const artAsked = new Set<string>();
const LAYOUT = 5;          // drawn this far off the hull's true spot (its layout slot)
const SLIDE_MS = 900;      // the continuity guard closes a jump over this

function FakeMap() {
  const [cam, setCam] = useState({ x: -999, y: -999, scale: 0.01 });
  const renderRef = useRef<() => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setCam({ x: d.x, y: d.y, scale: d.scale });
    };
    window.addEventListener('orbital:studio-camera', on);
    return () => window.removeEventListener('orbital:studio-camera', on);
  }, []);
  const render = () => {
    const now = performance.now();
    const tick = smoothedTick(state.currentTick, state.nextTickAt, state.tickIntervalMs, now);
    const trueX = 100 * tick + mockMap.jump + LAYOUT;
    // The continuity guard: a jump is slid closed, not drawn.
    let x = trueX;
    const h = mockMap.history.get('g:st_a');
    if (h) {
      if (!h.slide && Math.abs(trueX - h.x) > 1000) h.slide = { fx: h.x, fy: 0, t0: now };
      if (h.slide) {
        const u = Math.min(1, (now - h.slide.t0) / SLIDE_MS);
        x = h.slide.fx + (trueX - h.slide.fx) * u;
        if (u >= 1) h.slide = undefined;
      }
    }
    mockMap.history.set('g:st_a', { x, y: 0, ms: now, slide: h?.slide });
    mockMap.drawn.set('g:st_a', { x, y: 0, ms: now });
    // Art is asked for on the first draw at a view, and lands on the wall clock.
    const key = `${Math.round(cam.x / 10000)}:${cam.scale.toFixed(3)}`;   // the region and zoom in view
    if (!artAsked.has(key)) { artAsked.add(key); setTimeout(() => artLoaded.add(key), 10); }
    draws.push({ cam, tick, shipX: x, art: artLoaded.has(key), ms: now });
  };
  useEffect(() => { renderRef.current = render; });
  useEffect(() => {
    (window as unknown as { __benchDraw?: () => number }).__benchDraw = () => { renderRef.current(); return 0; };
  }, []);
  return null;
}

let root: Root;
let container: HTMLDivElement;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  if (!window.fetch) (window as unknown as { fetch: unknown }).fetch = async () => new Response('{}');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<FakeMap />);
  await sleep(20);
});
afterAll(() => { root.unmount(); });

let selectBodyHook: (() => void) | null = null;
function director(): Director {
  const d = new Director({
    gameId: 'g',
    state: () => state as never,
    mapCanvas: () => null,
    deselect: () => {},
    selectBody: () => { selectBodyHook?.(); },
  });
  d.artWaitMs = 200;
  return d;
}

/** Film the whole shot; the last draw of each frame is the frame kept. */
async function film(d: Director, shot: Shot): Promise<Draw[]> {
  draws.length = 0;
  const kept: Draw[] = [];
  const total = d.openFilm(shot);
  try {
    for (let k = 0; k < total; k++) {
      await d.filmFrame();
      kept.push(draws[draws.length - 1]);
    }
  } finally { d.closeFilm(); }
  return kept;
}

beforeEach(() => {
  mockMap.drawn.clear(); mockMap.history.clear(); mockMap.forgets = 0; mockMap.jump = 0;
  artLoaded.clear(); artAsked.clear();
  selectBodyHook = null;
});

describe('the film frame loop', () => {
  it('places the camera where the map draws the followed hull, every frame, as the world comes to rest', async () => {
    // No tick steps: the one glide runs and the world comes to rest
    // inside the shot. The camera follows the hull the whole way.
    const kept = await film(director(), {
      seconds: 1.2, fps: 30, speed: 300, steps: [{ at: 0, do: 'focus', target: 'ship:st_a', scale: 1 }],
    });
    const moved = kept.filter((f, i) => i > 0 && f.shipX !== kept[i - 1].shipX).length;
    expect(moved).toBeGreaterThan(5);            // the hull did move
    for (const f of kept) expect(Math.abs(f.cam.x - f.shipX)).toBeLessThan(1e-6);
  }, 20000);

  it('keeps no frame the map drew before it had the view, or before its art had landed', async () => {
    const kept = await film(director(), {
      seconds: 0.8, fps: 30, speed: 300, steps: [
        { at: 0, do: 'focus', target: 'ship:st_a', scale: 1 },
        { at: 0.4, do: 'focus', target: 'europa', scale: 2 },   // a hard cut, no skip
      ],
    });
    for (const f of kept) expect(f.art).toBe(true);
    // The cut lands on its own frame: the frame at 0.4 s is on Europa.
    expect(kept[12].cam.x).toBe(50000);
    // And every draw inside the cut, kept or not, had the cut's camera.
    const cutDraws = draws.filter(d => d.cam.x === 50000);
    const firstAfterCut = draws.findIndex(d => d.cam.x === 50000);
    expect(draws.slice(firstAfterCut).every(d => d.cam.x === 50000)).toBe(true);
    expect(cutDraws.length).toBeGreaterThan(3);   // it settled before the kept frame
  }, 20000);

  it('forgets where hulls were drawn at a time cut, so the followed hull lands where it is', async () => {
    const kept = await film(director(), {
      seconds: 0.6, fps: 30, speed: 300, steps: [
        { at: 0, do: 'focus', target: 'ship:st_a', scale: 1 },
        // The order moves the hull 20,000 units on (as an `advance` does),
        // and the cut skips 200 ms with it.
        { at: 0.2, do: 'order', order: { type: 'move' } },
        { at: 0.2, do: 'skip', ms: 200 },
      ],
    });
    const after = kept[6];
    // Drawn where it truly is (no slide back across the jump), and the
    // camera on it.
    expect(after.shipX).toBeCloseTo(100 * after.tick + 20000 + LAYOUT, 6);
    expect(Math.abs(after.cam.x - after.shipX)).toBeLessThan(1e-6);
  }, 20000);

  it("lets the page's own work see the film's clock while the director waits", async () => {
    // The world menu's fade stamps its start in an effect, on a later task.
    let stamp = -1;
    selectBodyHook = () => { setTimeout(() => { stamp = performance.now(); }, 0); };
    const d = director();
    const total = d.openFilm({ seconds: 0.5, fps: 30, speed: 300, steps: [{ at: 0.2, do: 'world', body: 'earth' }] });
    let filmNow = -1;
    try {
      for (let k = 0; k < total; k++) {
        await d.filmFrame();
        if (stamp >= 0 && filmNow < 0) filmNow = performance.now();
      }
    } finally { d.closeFilm(); }
    expect(stamp).toBeGreaterThanOrEqual(0);
    // Stamped within a frame of the film's time, not seconds ahead on the wall clock.
    expect(Math.abs(filmNow - stamp)).toBeLessThanOrEqual(1000 / 30 + 1e-6);
  }, 20000);
});
