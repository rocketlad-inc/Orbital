// ============================================================
// The cinematic recap of a single battle: the 3D stage, a transport,
// and the fight written out underneath it.
//
// The stage does the rendering and the directing — it precomputes its
// own shot list and moves the camera through the action. Everything
// here is the machinery around it: a clock, a scrubber, and a log.
//
// TWO THINGS THIS FILE EXISTS TO GET RIGHT, both learned from the 2D
// recap that came before it:
//
//   THE LAST BEAT MUST PLAY. Playback used to stop ON the final beat at
//   t=0, which meant the last tick of the battle -- the one with the
//   kill in it -- was never drawn, and the result was unreachable.
//   Playback here runs to beats, not beats-1, and holds at the end.
//
//   THE CLOCK ONLY GOES FORWARD. The camera eases on the delta between
//   frames; hand it a negative one (by scrubbing backwards, or by a
//   clock that rewinds) and the easing coefficient goes negative and
//   catapults the camera out of the scene. Deltas are clamped.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createStage, TICK_MS, type Stage } from '../render3d/BattleStage';
import './BattleCinema.css';
import type { TheatreDetail } from './TheatreRecap';

/** A row of battle_shots, as the cinema endpoint serves it. */
interface ShotRow {
  tick_number: number;
  attacker_ship_id: string | null; attacker_faction_id: string | null;
  attacker_class: string | null;
  target_ship_id: string | null; target_faction_id: string | null;
  target_class: string | null;
  hit: number; damage: number; damage_raw: number; killed: number;
  energy_share: number | null;
}
export interface CinemaDetail extends TheatreDetail { shots?: ShotRow[] }

const fmt = (n: number) => Math.round(n * 10) / 10;

export function BattleCinema({ detail }: { detail: CinemaDetail }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const [beats, setBeats] = useState(0);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Live refs for the animation loop: it is created once, and reading
  // React state inside it would close over the first render's values.
  const posRef = useRef(0);
  const playRef = useRef(true);
  const speedRef = useRef(1);
  playRef.current = playing;
  speedRef.current = speed;

  // ---- names, so the log can say who ----
  const shipName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of detail.battles) {
      for (const p of b.participants ?? []) {
        if (p.ship_name) m.set(p.ship_id, p.ship_name);
      }
    }
    return m;
  }, [detail]);
  const who = (id: string | null) =>
    (id && (shipName.get(id) || id.slice(-6))) || 'unknown';
  const factionName = (fid: string | null) =>
    (fid && detail.factions[fid]?.name) || 'Unaligned';
  const factionColor = (fid: string | null) =>
    (fid && detail.factions[fid]?.color) || '#8a9fb3';

  /** The battle's own ticks, so the log and the reel share a timeline. */
  const ticks = useMemo(() => {
    const s = new Set<number>();
    for (const b of detail.battles) for (const f of b.frames ?? []) s.add(f.tick);
    return [...s].sort((a, b) => a - b);
  }, [detail]);

  /** Shots grouped by tick, kills first — a tick's headline is its dead. */
  const byTick = useMemo(() => {
    const m = new Map<number, ShotRow[]>();
    for (const s of detail.shots ?? []) {
      const a = m.get(s.tick_number);
      if (a) a.push(s); else m.set(s.tick_number, [s]);
    }
    for (const rows of m.values()) rows.sort((x, y) => y.killed - x.killed);
    return m;
  }, [detail]);

  // ---- the stage ----
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const stage = createStage(detail, cv);
    stageRef.current = stage;
    setBeats(stage.beats);

    const fit = () => {
      const r = cv.getBoundingClientRect();
      stage.resize(Math.max(320, r.width), Math.max(180, r.height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Clamped, and never negative: a tab that was backgrounded returns
      // a delta of several seconds and would jump the reel forward past
      // a whole shot; a rewound clock would invert the camera easing.
      const dt = Math.min(120, Math.max(0, now - last));
      last = now;
      if (playRef.current) {
        const next = posRef.current + (dt / TICK_MS) * speedRef.current;
        // Hold on the final beat rather than stopping short of it: the
        // last tick is the one with the kill in it.
        if (next >= stage.beats) {
          posRef.current = stage.beats;
          playRef.current = false;
          setPlaying(false);
        } else {
          posRef.current = next;
        }
        setPos(posRef.current);
      }
      stage.setPos(posRef.current);
      stage.render();
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.dispose();
      stageRef.current = null;
    };
  }, [detail]);

  const seek = (p: number) => {
    posRef.current = Math.max(0, Math.min(beats, p));
    setPos(posRef.current);
  };
  const replay = () => { seek(0); setPlaying(true); };

  /** Which tick the reel is currently showing, for log highlighting. */
  const liveTick = ticks.length
    ? ticks[Math.min(ticks.length - 1, Math.floor(pos))] : null;
  const elapsed = (pos * TICK_MS) / 1000;
  const total = (beats * TICK_MS) / 1000;

  return (
    <div className="cinema">
      <div className="cinema-screen">
        <canvas ref={canvasRef} />
      </div>

      <div className="cinema-transport">
        <button
          type="button"
          onClick={() => (pos >= beats ? replay() : setPlaying(p => !p))}
          aria-label={pos >= beats ? 'Replay' : playing ? 'Pause' : 'Play'}
        >
          {pos >= beats ? '↺' : playing ? '‖' : '▶'}
        </button>
        <input
          type="range" min={0} max={Math.max(0.001, beats)} step={0.01}
          value={pos}
          onChange={e => { setPlaying(false); seek(Number(e.target.value)); }}
          aria-label="Scrub"
        />
        <span className="cinema-clock">
          {elapsed.toFixed(1)}s / {total.toFixed(1)}s
        </span>
        <select
          value={speed} onChange={e => setSpeed(Number(e.target.value))}
          aria-label="Speed"
        >
          <option value={0.5}>0.5&times;</option>
          <option value={1}>1&times;</option>
          <option value={2}>2&times;</option>
          <option value={4}>4&times;</option>
        </select>
      </div>

      <ol className="cinema-log">
        {ticks.map((t, i) => {
          const rows = byTick.get(t) ?? [];
          const kills = rows.filter(r => r.killed);
          const dmg = rows.reduce((a, r) => a + (r.damage || 0), 0);
          const held = rows.reduce(
            (a, r) => a + Math.max(0, (r.damage_raw || 0) - (r.damage || 0)), 0);
          return (
            <li
              key={t}
              className={t === liveTick ? 'tick live' : 'tick'}
              onClick={() => { setPlaying(false); seek(i); }}
            >
              <div className="tick-head">
                <span className="tick-n">Tick {t}</span>
                <span className="tick-sum">
                  {rows.length} shot{rows.length === 1 ? '' : 's'}
                  {' · '}{fmt(dmg)} damage
                  {held > 0.05 ? ` · ${fmt(held)} absorbed` : ''}
                </span>
              </div>
              {kills.map((k, n) => (
                <div className="kill" key={n}>
                  <span
                    className="pip"
                    style={{ background: factionColor(k.attacker_faction_id) }}
                  />
                  <strong>{who(k.target_ship_id)}</strong>
                  {` (${k.target_class ?? 'ship'}, ${factionName(k.target_faction_id)})`}
                  {' destroyed by '}
                  <strong>{who(k.attacker_ship_id)}</strong>
                  {` — ${fmt(k.damage)} damage`}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
