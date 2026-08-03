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
  enabled = false;
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
    if (!this.enabled) return;
    this.actionMs = ms;
    this.actionAt = performance.now();
    this.pending = true;
  }
  recordFetch(ms: number) { if (this.enabled) { this.fetchMs = ms; this.polls++; } }
  recordSkip() { if (this.enabled) this.skipped++; }
  recordMap(ms: number, ships: number) {
    if (!this.enabled) return;
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
      }
    }));
  }
  recordFrame(ms: number) { if (this.enabled) this.frameMs = ms; }
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
  useEffect(() => {
    if (!perf.enabled) return;
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
    const id = setInterval(() => force(n => n + 1), 250);
    return () => { cancelAnimationFrame(raf); clearInterval(id); };
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
      <div style={cell}><span>polls / skipped</span><span>{perf.polls} / {perf.skipped}</span></div>
    </div>
  );
}
