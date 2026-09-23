// ============================================================
// PerfHud — an on-screen stopwatch for "why does this feel slow".
//
// Three speculative latency fixes shipped without moving the needle for
// one playtester while another player in the SAME game reported no
// problem. Same game = same payload, so the difference is that player's
// machine — and it cannot be measured from anyone else's. So: measure
// it on theirs.
//
// Enable with ?perf=1 (sticky — stored in localStorage so a reload or
// an in-game navigation keeps it on; ?perf=0 turns it off). Everything
// here is inert until enabled: the record* functions are plain field
// writes on a module singleton, and the component isn't mounted.
//
// What each number answers:
//   ACTION   POST round-trip. High => network/server, not the client.
//   FETCH    /state round-trip. High => server assembly cost.
//   MAP      serverToGameState: JSON -> GameState. CPU-bound, scales
//            with ship count. High => this player's CPU is the problem.
//   PAINT    state applied -> next frame painted. React commit + canvas
//            redraw. High => render cost, and the real culprit for
//            "clicking feels mushy" even when the network is fine.
//   CLICK→UI End to end: action fired -> pixels changed. THE number.
//   FRAME    rolling frame interval. 16ms = 60fps; 100ms+ = the whole
//            app is janky regardless of any network work.
//   STALLS   raw frame gaps >50 / >250 ms this window, and the worst
//            one. UNSMOOTHED — see recordRawInterval.
//   LONGTASK PerformanceObserver 'longtask' entries this window: how
//            many, total ms, worst. The browser's own word for "the
//            main thread was busy for 50ms+", whatever the cause.
//   INPUT    pointerdown/keydown -> next painted frame, p50 / max. The
//            number a player means by "input lag".
// ============================================================

import React, { useEffect, useState } from 'react';
import { GIT_SHA } from '../_version';

interface Sample { action: number; fetch: number; map: number; paint: number; total: number; }

class PerfBus {
  /** HUD visibility. Sampling/reporting runs regardless — the whole point
   *  is to collect from players who never type ?perf=1. */
  enabled = false;
  gameId: string | null = null;
  private lastSentAt = 0;

  // ---- session-scoped rolling metrics (the "animations are slowing
  // down" signal, which per-click sampling cannot see) ----
  readonly sessionId = Math.random().toString(36).slice(2, 12);
  readonly startedAt = Date.now();
  private frames: number[] = [];
  private draws: number[] = [];
  // WHERE THE DRAW GOES. draw_p50 said a frame cost 211ms and nothing
  // about which part (2026-09-23: one player at 4 fps with an asteroid in
  // flight and 415 hulls in transit; a probe board with the same ram drew
  // in 3ms). MapCanvas marks phase boundaries; each frame's split is
  // kept and the heartbeat ships per-phase p50/p95.
  private phaseFrames: Array<Record<string, number>> = [];
  private phaseCur: Record<string, number> = {};
  private phaseT = 0;
  private longFrames = 0;
  // ---- STALL TELEMETRY (per heartbeat window; reset on send) ----
  //
  // The frame fields above are an EMA of visible frames with anything
  // over 250ms discarded as "not a frame". That was the right call for
  // fps, and it is exactly why the live game's input lag is invisible in
  // 16,000 heartbeats: a 400ms stall is smoothed into a 4ms bump on the
  // EMA if it survives the cap at all, and the ones that matter don't.
  // These count the raw gaps — no smoothing, no cap short of "the tab was
  // not rendering" — alongside the browser's own long-task entries and a
  // direct input->paint measure. The smoothed fields stay for continuity.
  /** Raw rAF intervals over 50ms / over 250ms this window. */
  rawOver50 = 0;
  rawOver250 = 0;
  /** Worst raw rAF interval this window, ms. */
  rawMaxMs = 0;
  /** 'longtask' entries: count, summed duration, worst duration. */
  longTaskN = 0;
  longTaskMs = 0;
  longTaskMaxMs = 0;
  /** pointerdown/keydown -> painted, ms. Capped: a window has at most a
   *  few hundred inputs, but a held key autorepeats. */
  private inputLat: number[] = [];
  private ltObserver: PerformanceObserver | null = null;
  settlements = 0;
  inTransit = 0;
  zoom = 0;
  /** Offscreen canvas MB the renderer holds. Set from MapCanvas's frame
   *  loop, which is the only place that can count it. Matters because
   *  heap_mb is NULL on iOS — Safari hides performance.memory — and iOS
   *  is where the crashes were. */
  canvasMb = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private gpu: string | null = null;
  /** Rolling fps for the HUD, and the "is it degrading" comparison. */
  lastHbFps = 0;
  firstHbFps = 0;
  last: Sample = { action: 0, fetch: 0, map: 0, paint: 0, total: 0 };
  fetchMs = 0;
  mapMs = 0;
  frameMs = 0;
  ships = 0;
  polls = 0;
  skipped = 0;
  /** Wall-clock of the most recent player action, so the paint that
   *  follows can be attributed to it (and only to it — a paint from a
   *  routine poll must not masquerade as click latency). */
  private actionAt = 0;
  private actionMs = 0;
  private pending = false;

  recordAction(ms: number) {
    this.actionMs = ms;
    this.actionAt = performance.now();
    this.pending = true;
  }
  recordFetch(ms: number) { this.fetchMs = ms; this.polls++; }
  recordSkip() { this.skipped++; }
  recordMap(ms: number, ships: number) {
    this.mapMs = ms;
    this.ships = ships;
    // Measure through to the frame that actually shows it: rAF fires
    // before paint, so a nested rAF lands after the browser has
    // composited — that is when the player genuinely SEES the change.
    const applied = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const painted = performance.now();
      const paint = painted - applied;
      if (this.pending) {
        this.pending = false;
        this.last = {
          action: Math.round(this.actionMs),
          fetch: Math.round(this.fetchMs),
          map: Math.round(ms),
          paint: Math.round(paint),
          total: Math.round(painted - this.actionAt),
        };
        this.report(this.last);
      }
    }));
  }
  recordFrame(ms: number) {
    // Only count frames the player could actually SEE. rAF is throttled
    // to ~1fps in a hidden tab, so counting those would report a
    // catastrophic frame rate for anyone who alt-tabs.
    //
    // This gate now covers `frameMs` as well. It used to sit BELOW the
    // assignment, so a hidden-tab sample still landed in frameMs — and
    // frameMs is what MapCanvas's adaptive-resolution stepper reads, so
    // a single alt-tab shrank the canvas backing store and the map
    // visibly "zoomed in". Holding the last good value is the right
    // failure mode: a stale reading beats a fabricated one.
    if (document.visibilityState !== 'visible' || ms >= 5000) return;
    this.frameMs = ms;
    // Capped: outside a game no heartbeat drains these, and a lobby
    // left open overnight must not grow arrays forever.
    if (this.frames.length < 20_000) this.frames.push(ms);
    if (ms > 50) this.longFrames++;
  }

  /** A raw rAF-to-rAF gap, visible tab only, unsmoothed. The 5000ms
   *  guard is the same "we were not rendering at all" line recordFrame
   *  draws (OS sleep, debugger); everything under it is a stall the
   *  player sat through and is counted as such. */
  recordRawInterval(ms: number) {
    if (document.visibilityState !== 'visible' || ms >= 5000) return;
    if (ms > 50) this.rawOver50++;
    if (ms > 250) this.rawOver250++;
    if (ms > this.rawMaxMs) this.rawMaxMs = ms;
  }

  /** One input's latency to the frame that showed its result. */
  recordInputLatency(ms: number) {
    if (this.inputLat.length < 2_000) this.inputLat.push(ms);
  }

  /** Map draw cost, timed inside the render call. Separating this from
   *  frame interval distinguishes "our canvas work is heavy" from
   *  "something else on the page is stalling the main thread". */
  /** Start timing a frame's phases. */
  phaseStart() {
    this.phaseCur = {};
    this.phaseT = performance.now();
  }

  /** Close the phase that ran since the last mark, under `name`. */
  phase(name: string) {
    const t = performance.now();
    this.phaseCur[name] = (this.phaseCur[name] ?? 0) + (t - this.phaseT);
    this.phaseT = t;
  }

  /** Keep this frame's split (visible frames only, like draws). */
  phaseCommit() {
    if (document.visibilityState === 'visible' && this.phaseFrames.length < 5_000) {
      this.phaseFrames.push(this.phaseCur);
    }
  }

  recordDraw(ms: number) {
    if (document.visibilityState === 'visible' && this.draws.length < 20_000) {
      this.draws.push(ms);
    }
  }

  recordScene(ships: number, settlements: number, inTransit: number, zoom: number) {
    this.ships = ships;
    this.settlements = settlements;
    this.inTransit = inTransit;
    this.zoom = zoom;
  }

  private pct(arr: number[], q: number): number {
    if (arr.length === 0) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  }

  /** HUD reads of the running input window (four times a second while
   *  the overlay is up; never on the hot path). */
  inputP50(): number { return this.pct(this.inputLat, 0.5); }
  inputMaxMs(): number { return this.inputLat.length ? Math.max(...this.inputLat) : 0; }

  /** Start the once-a-minute session heartbeat. Idempotent — the
   *  provider may re-run its effect on re-render. */
  startHeartbeat() {
    if (this.hbTimer) return;
    if (this.gpu === null) this.gpu = detectGpu();
    this.hbTimer = setInterval(() => this.sendHeartbeat(), 60_000);
    // Long tasks, from the browser's own accounting. Chromium reports
    // these; Firefox and Safari do not (supportedEntryTypes says so), in
    // which case the fields simply stay 0 and the raw-gap counters above
    // carry the signal there.
    try {
      const PO = (window as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (PO && (PO.supportedEntryTypes ?? []).includes('longtask')) {
        this.ltObserver = new PO(list => {
          for (const e of list.getEntries()) {
            this.longTaskN++;
            this.longTaskMs += e.duration;
            if (e.duration > this.longTaskMaxMs) this.longTaskMaxMs = e.duration;
          }
        });
        this.ltObserver.observe({ type: 'longtask', buffered: true });
      }
    } catch { /* diagnostics only */ }
    // A session that ends before the first minute would otherwise report
    // nothing at all, and short frustrated sessions are exactly the ones
    // worth seeing. Flush on the way out.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.sendHeartbeat();
    });
    window.addEventListener('pagehide', () => this.sendHeartbeat());
  }

  private sendHeartbeat() {
    if (!this.gameId) return;
    const frames = this.frames;
    // Need a meaningful window; a handful of frames yields noise.
    if (frames.length < 30) return;
    this.frames = [];
    const draws = this.draws;
    this.draws = [];
    const phaseFrames = this.phaseFrames;
    this.phaseFrames = [];
    const phaseNames = new Set<string>();
    for (const fr of phaseFrames) for (const k of Object.keys(fr)) phaseNames.add(k);
    const phases: Record<string, [number, number]> = {};
    for (const k of phaseNames) {
      const xs = phaseFrames.map(fr => fr[k] ?? 0);
      phases[k] = [Math.round(this.pct(xs, 0.5) * 10) / 10, Math.round(this.pct(xs, 0.95) * 10) / 10];
    }
    const longFrames = this.longFrames;
    this.longFrames = 0;
    // Stall window: snapshot and reset together with the frame window so
    // every counter in one row describes the same minute.
    const rawOver50 = this.rawOver50, rawOver250 = this.rawOver250, rawMaxMs = this.rawMaxMs;
    const longTaskN = this.longTaskN, longTaskMs = this.longTaskMs, longTaskMaxMs = this.longTaskMaxMs;
    const inputLat = this.inputLat;
    this.rawOver50 = 0; this.rawOver250 = 0; this.rawMaxMs = 0;
    this.longTaskN = 0; this.longTaskMs = 0; this.longTaskMaxMs = 0;
    this.inputLat = [];

    const avgFrame = frames.reduce((x, y) => x + y, 0) / frames.length;
    // 1% LOW: mean of the worst 1% of frames, expressed as fps. This is
    // the number that matches "it feels choppy" — an average frame rate
    // stays respectable while brief stalls ruin the experience.
    const sorted = [...frames].sort((x, y) => y - x);
    const worstN = Math.max(1, Math.floor(frames.length * 0.01));
    const worstMean = sorted.slice(0, worstN).reduce((x, y) => x + y, 0) / worstN;

    const fpsAvg = Math.round(1000 / Math.max(1, avgFrame));
    if (!this.firstHbFps) this.firstHbFps = fpsAvg;
    this.lastHbFps = fpsAvg;

    const nav = navigator as Navigator & { deviceMemory?: number };
    const mem = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;

    try {
      void fetch(`/api/games/${this.gameId}/perf/session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          session_id: this.sessionId,
          session_ms: Date.now() - this.startedAt,
          fps_avg: fpsAvg,
          fps_low1: Math.round(1000 / Math.max(1, worstMean)),
          frame_p50: Math.round(this.pct(frames, 0.5)),
          frame_p95: Math.round(this.pct(frames, 0.95)),
          long_frames: longFrames,
          frames_seen: frames.length,
          draw_p50: Math.round(this.pct(draws, 0.5)),
          draw_p95: Math.round(this.pct(draws, 0.95)),
          phases: phaseFrames.length ? JSON.stringify(phases) : null,
          // STALL FIELDS. Not yet columns on perf_heartbeats — the worker
          // binds named fields only, so these ride along ignored until
          // the migration lands (see the commit that added them).
          raw_over50: rawOver50,
          raw_over250: rawOver250,
          raw_max_ms: Math.round(rawMaxMs),
          longtask_n: longTaskN,
          longtask_ms: Math.round(longTaskMs),
          longtask_max_ms: Math.round(longTaskMaxMs),
          input_n: inputLat.length,
          input_p50: Math.round(this.pct(inputLat, 0.5)),
          input_max_ms: inputLat.length ? Math.round(Math.max(...inputLat)) : 0,
          heap_mb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
          heap_limit_mb: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
          ships: this.ships,
          settlements: this.settlements,
          in_transit: this.inTransit,
          zoom: this.zoom,
          canvas_mb: this.canvasMb,
          // WHICH BUILD produced this sample. Without it, aggregates
          // silently mix clients from before and after a fix and the
          // only way to judge a change is to wait for another report.
          git_sha: GIT_SHA,
          gpu: this.gpu,
          cores: nav.hardwareConcurrency ?? null,
          mem_gb: nav.deviceMemory ?? null,
          dpr: window.devicePixelRatio,
          screen_w: window.screen?.width ?? null,
          screen_h: window.screen?.height ?? null,
          mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
          ua: navigator.userAgent,
        }),
      }).catch(() => {});
    } catch { /* never disturb the game */ }
  }

  /** Ship one sample to the server, at most every 30s per session, and
   *  only for real player actions — idle players send nothing. Failures
   *  are swallowed: diagnostics must never disturb the game. */
  private report(sample: Sample) {
    const now = Date.now();
    if (!this.gameId) return;
    if (now - this.lastSentAt < 30_000) return;
    this.lastSentAt = now;
    const nav = navigator as Navigator & { deviceMemory?: number };
    try {
      void fetch(`/api/games/${this.gameId}/perf`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          ...sample,
          frame: Math.round(this.frameMs),
          ships: this.ships,
          cores: nav.hardwareConcurrency ?? null,
          mem: nav.deviceMemory ?? null,
          canvas_mb: this.canvasMb,
          git_sha: GIT_SHA,
          mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
          ua: navigator.userAgent,
        }),
      }).catch(() => {});
    } catch { /* never disturb the game */ }
  }
}

// GPU string via the WebGL debug extension. Queried once, lazily, on a
// throwaway canvas — some browsers//privacy modes withhold it, in which
// case we simply report null rather than retrying every heartbeat.
function detectGpu(): string | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return null;
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '').slice(0, 120) || null;
  } catch { return null; }
}

export const perf = new PerfBus();

// Sticky enable: ?perf=1 flips it on and persists, so the tester sets
// it once and can navigate/reload without losing the overlay.
try {
  const q = new URLSearchParams(window.location.search).get('perf');
  if (q === '1') localStorage.setItem('orbital:perf', '1');
  if (q === '0') localStorage.removeItem('orbital:perf');
  perf.enabled = localStorage.getItem('orbital:perf') === '1';
} catch { /* private mode — stay off */ }

const cell: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 };

// Software-rasterizer detection: ANGLE reporting the Microsoft Basic
// Render Driver / SwiftShader / llvmpipe means the browser is drawing
// this canvas on the CPU - no code change of ours can make that fast,
// but the player can fix it in browser settings in ten seconds. Tell
// them once.
export function isSoftwareRenderer(gpu: string | null): boolean {
  return !!gpu && /microsoft basic|swiftshader|llvmpipe|software/i.test(gpu);
}

export function SoftwareRenderWarning() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('orbital:swWarnDismissed')) return;
      const gpu = detectGpu();
      if (isSoftwareRenderer(gpu)) setShow(true);
    } catch { /* private mode */ }
  }, []);
  if (!show) return null;
  return (
    <div style={{
      position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9000, maxWidth: 460, background: 'rgba(46, 26, 8, 0.96)',
      border: '1px solid #c9a84c', borderRadius: 8, padding: '10px 14px',
      font: '12.5px/1.5 sans-serif', color: '#e8d9b0',
    }}>
      <b>Orbital is running without GPU acceleration.</b> Your browser is
      drawing the map in software, which makes everything feel slow. Enable
      hardware acceleration in your browser settings (Settings → System in
      Chrome/Edge, Settings → Performance in Firefox), then restart the
      browser.
      <button
        onClick={() => {
          try { localStorage.setItem('orbital:swWarnDismissed', '1'); } catch { /* ok */ }
          setShow(false);
        }}
        style={{
          marginLeft: 10, background: 'none', border: '1px solid #c9a84c',
          borderRadius: 4, color: '#e8d9b0', cursor: 'pointer', padding: '2px 8px',
        }}
      >Got it</button>
    </div>
  );
}

export function PerfHud() {
  const [, force] = useState(0);
  // Frame sampling runs for EVERY player, HUD or not — frame time is the
  // headline signal for "the whole app is janky", and the players we most
  // need it from are exactly the ones who will never type ?perf=1. One
  // rAF callback doing two multiplications is free next to the map's own
  // render loop.
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    // rAF suspends entirely while the tab is hidden, so `prev` goes
    // stale and the first callback after a return measures the WHOLE
    // time away — minutes, in ms. Feeding that to the EMA poisons it for
    // dozens of frames. Anything past this cap isn't a frame we rendered
    // slowly, it's a gap where we didn't render at all (backgrounded,
    // debugger paused, OS sleep); drop it and re-baseline.
    const MAX_PLAUSIBLE_FRAME_MS = 250;
    const tick = () => {
      const now = performance.now();
      const dt = now - prev;
      prev = now;
      // The raw gap first, before the cap and the EMA throw it away —
      // this is the stall the player felt, at its real size.
      perf.recordRawInterval(dt);
      if (dt <= MAX_PLAUSIBLE_FRAME_MS) {
        // EMA so one hitch doesn't dominate, but sustained jank shows.
        perf.recordFrame(perf.frameMs * 0.9 + dt * 0.1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF suspends in a hidden tab, so the first tick after a return
    // spans the whole absence. Re-baseline on the way back so it is not
    // booked as a stall (the raw counters have no 250ms cap to hide it).
    const onVis = () => { if (document.visibilityState === 'visible') prev = performance.now(); };
    document.addEventListener('visibilitychange', onVis);

    // INPUT -> PAINT. From the event's own timestamp (queued before our
    // handler even ran, which is where a busy main thread shows up) to
    // the frame after the next — rAF fires before paint, so the nested
    // rAF is the first moment the result is on the glass. Same measure
    // recordMap uses for /state paints. One in flight at a time: a held
    // key would otherwise stack thousands of rAF pairs.
    let inputPending = false;
    const onInput = (e: Event) => {
      if (inputPending || document.visibilityState !== 'visible') return;
      const now = performance.now();
      const ts = e.timeStamp;
      const t0 = (Number.isFinite(ts) && ts > 0 && ts <= now && now - ts < 10_000) ? ts : now;
      inputPending = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        inputPending = false;
        perf.recordInputLatency(performance.now() - t0);
      }));
    };
    window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
    window.addEventListener('keydown', onInput, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointerdown', onInput, { capture: true });
      window.removeEventListener('keydown', onInput, { capture: true });
    };
  }, []);
  // Repaint the overlay only while it is actually on screen.
  useEffect(() => {
    if (!perf.enabled) return;
    const id = setInterval(() => force(n => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  if (!perf.enabled) return null;
  const L = perf.last;
  const warn = (v: number, lim: number) => ({ color: v > lim ? '#ff6b6b' : '#7fd8cf' });
  return (
    <div style={{
      position: 'fixed', bottom: 8, left: 8, zIndex: 99999,
      background: 'rgba(6,12,20,0.92)', border: '1px solid #2b8f88',
      borderRadius: 6, padding: '8px 10px', font: '11px/1.5 monospace',
      color: '#cdd9e4', minWidth: 210, pointerEvents: 'none',
    }}>
      <div style={{ color: '#7fd8cf', letterSpacing: '0.08em', marginBottom: 4 }}>
        PERF · last action
      </div>
      <div style={cell}><span>CLICK→UI</span><b style={warn(L.total, 800)}>{L.total || '—'} ms</b></div>
      <div style={cell}><span>· action POST</span><span style={warn(L.action, 400)}>{L.action || '—'}</span></div>
      <div style={cell}><span>· /state fetch</span><span style={warn(L.fetch, 500)}>{L.fetch || '—'}</span></div>
      <div style={cell}><span>· map state</span><span style={warn(L.map, 150)}>{L.map || '—'}</span></div>
      <div style={cell}><span>· paint</span><span style={warn(L.paint, 200)}>{L.paint || '—'}</span></div>
      <div style={{ ...cell, marginTop: 5, borderTop: '1px solid #24384a', paddingTop: 4 }}>
        <span>frame</span>
        <span style={warn(perf.frameMs, 40)}>{Math.round(perf.frameMs)} ms · {Math.round(1000 / Math.max(1, perf.frameMs))} fps</span>
      </div>
      <div style={cell}><span>ships</span><span>{perf.ships}</span></div>
      <div style={cell}>
        <span>stalls &gt;50/&gt;250 · max</span>
        <span style={warn(perf.rawMaxMs, 250)}>{perf.rawOver50}/{perf.rawOver250} · {Math.round(perf.rawMaxMs)}</span>
      </div>
      <div style={cell}>
        <span>long tasks n · ms · max</span>
        <span style={warn(perf.longTaskMaxMs, 250)}>{perf.longTaskN} · {Math.round(perf.longTaskMs)} · {Math.round(perf.longTaskMaxMs)}</span>
      </div>
      <div style={cell}>
        <span>input→paint p50 / max</span>
        <span style={warn(perf.inputMaxMs(), 200)}>{Math.round(perf.inputP50())} / {Math.round(perf.inputMaxMs())}</span>
      </div>
      {perf.firstHbFps > 0 && (
        <div style={cell}>
          <span>fps now / start</span>
          <span style={warn(perf.firstHbFps - perf.lastHbFps, 10)}>
            {perf.lastHbFps} / {perf.firstHbFps}
          </span>
        </div>
      )}
      <div style={cell}><span>polls / skipped</span><span>{perf.polls} / {perf.skipped}</span></div>
    </div>
  );
}
