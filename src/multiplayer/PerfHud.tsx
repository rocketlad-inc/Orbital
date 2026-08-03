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
// ============================================================

import React, { useEffect, useState } from 'react';

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
  private longFrames = 0;
  settlements = 0;
  inTransit = 0;
  zoom = 0;
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
    this.frameMs = ms;
    // Only count frames the player could actually SEE. rAF is throttled
    // to ~1fps in a hidden tab, so counting those would report a
    // catastrophic frame rate for anyone who alt-tabs.
    if (document.visibilityState === 'visible' && ms < 5000) {
      this.frames.push(ms);
      if (ms > 50) this.longFrames++;
    }
  }

  /** Map draw cost, timed inside the render call. Separating this from
   *  frame interval distinguishes "our canvas work is heavy" from
   *  "something else on the page is stalling the main thread". */
  recordDraw(ms: number) {
    if (document.visibilityState === 'visible') this.draws.push(ms);
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

  /** Start the once-a-minute session heartbeat. Idempotent — the
   *  provider may re-run its effect on re-render. */
  startHeartbeat() {
    if (this.hbTimer) return;
    if (this.gpu === null) this.gpu = detectGpu();
    this.hbTimer = setInterval(() => this.sendHeartbeat(), 60_000);
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
    const longFrames = this.longFrames;
    this.longFrames = 0;

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
          heap_mb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
          heap_limit_mb: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
          ships: this.ships,
          settlements: this.settlements,
          in_transit: this.inTransit,
          zoom: this.zoom,
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
    const tick = () => {
      const now = performance.now();
      // EMA so one hitch doesn't dominate, but sustained jank shows.
      perf.recordFrame(perf.frameMs * 0.9 + (now - prev) * 0.1);
      prev = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
