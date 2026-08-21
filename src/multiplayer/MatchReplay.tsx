// ============================================================
// The match replay player: an entire game as a film.
//
// The same machinery as BattleCinema — a clock that only goes forward,
// a scrubber, a hold on the final tick — at campaign tempo: ONE SECOND
// PER TICK, the pace the whole metric expansion was pointed at.
//
// Pages stream in while the film plays. The stage accepts rows in
// order and the player never blocks on the full record: a match with
// twenty thousand ticks starts playing off its first page.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createMatchStage, type MatchStage, type MatchSummary, type SnapshotRow,
  mineEvents, type MatchEvent,
} from '../render3d/MatchStage';
import './BattleCinema.css';

const TICK_SECONDS = 1;

export function MatchReplay({ gameId }: { gameId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<MatchStage | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [synUpTo, setSynUpTo] = useState<number | null>(null);

  const posRef = useRef(0); const playRef = useRef(true);
  const speedRef = useRef(1);
  playRef.current = playing; speedRef.current = speed;

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/games/${gameId}/match/summary`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => { if (live) setSummary(j); })
      .catch(e => { if (live) setErr(e?.message || 'summary failed'); });
    return () => { live = false; };
  }, [gameId]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !summary) return;
    const stage = createMatchStage(summary, cv);
    stageRef.current = stage;
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    setRange([lo, hi]);
    setSynUpTo(summary.firstLiveTick);
    posRef.current = lo;

    const fit = () => {
      const r = cv.getBoundingClientRect();
      stage.resize(Math.max(320, r.width), Math.max(180, r.height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);

    // Stream pages while playing; the film starts on page one.
    let dead = false;
    const collected: SnapshotRow[] = [];
    (async () => {
      let from = lo;
      while (!dead && from != null) {
        const r = await fetch(
          `/api/admin/games/${gameId}/match/replay?from=${from}&limit=900`,
          { credentials: 'include' });
        if (!r.ok) { setErr(`replay page failed: HTTP ${r.status}`); return; }
        const j = await r.json();
        if (dead) return;
        collected.push(...j.rows);
        stage.applyRows(j.rows);
        setEvents(mineEvents(collected, summary));
        from = j.nextFrom;
      }
    })();

    let raf = 0; let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(200, Math.max(0, now - last));
      last = now;
      if (playRef.current) {
        const next = posRef.current
          + (dt / (TICK_SECONDS * 1000)) * speedRef.current;
        if (next >= hi) {
          posRef.current = hi; playRef.current = false; setPlaying(false);
        } else {
          posRef.current = next;
        }
        setPos(posRef.current);
      }
      const t = Math.floor(posRef.current);
      stage.setTick(t, posRef.current - t);
      stage.render();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      dead = true; cancelAnimationFrame(raf); ro.disconnect();
      stage.dispose(); stageRef.current = null;
    };
  }, [summary, gameId]);

  const seek = (p: number) => {
    posRef.current = Math.max(range[0], Math.min(range[1], p));
    setPos(posRef.current);
  };

  const factionName = (fid: string | null) =>
    summary?.factions.find(f => f.id === fid)?.name ?? 'Unaligned';
  const bodyName = (bid: string | null) =>
    summary?.bodies.find(b => b.id === bid || b.id.endsWith(':' + (bid ?? '')))
      ?.name ?? bid ?? 'deep space';

  const visibleEvents = useMemo(
    () => events.filter(e => e.kind !== 'pact' || true).slice(0, 400),
    [events]);
  const liveTick = Math.floor(pos);

  if (err) {
    return <div style={{ color: '#ff8a80', fontSize: 12, padding: 12 }}>{err}</div>;
  }
  return (
    <div className="cinema">
      <div className="cinema-screen">
        <canvas ref={canvasRef} />
        {synUpTo != null && liveTick < synUpTo && (
          <div style={{
            position: 'absolute', top: 8, right: 10, fontSize: 10,
            color: '#9fb3c8', background: 'rgba(10,16,24,0.7)',
            padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em',
          }}>RECONSTRUCTED</div>
        )}
      </div>

      <div className="cinema-transport">
        <button type="button"
          onClick={() => (pos >= range[1]
            ? (seek(range[0]), setPlaying(true))
            : setPlaying(p => !p))}
          aria-label={pos >= range[1] ? 'Replay' : playing ? 'Pause' : 'Play'}>
          {pos >= range[1] ? '↺' : playing ? '‖' : '▶'}
        </button>
        <input type="range" min={range[0]} max={Math.max(range[0] + 0.001, range[1])}
          step={0.01} value={pos}
          onChange={e => { setPlaying(false); seek(Number(e.target.value)); }}
          aria-label="Scrub" />
        <span className="cinema-clock">
          T+{liveTick} / {range[1]}
        </span>
        <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
          aria-label="Speed">
          <option value={1}>1 s/tick</option>
          <option value={4}>4&times;</option>
          <option value={15}>15&times;</option>
          <option value={60}>60&times;</option>
        </select>
      </div>

      <ol className="cinema-log">
        {visibleEvents.map((e, i) => (
          <li key={i}
            className={e.tick === liveTick ? 'tick live' : 'tick'}
            onClick={() => { setPlaying(false); seek(e.tick); }}>
            <div className="tick-head">
              <span className="tick-n">T+{e.tick}</span>
              <span className="tick-sum">
                {e.kind === 'battle' && <>battle at <strong>{bodyName(e.bodyId)}</strong></>}
                {e.kind === 'loss' && <>ships lost near <strong>{bodyName(e.bodyId)}</strong></>}
                {e.kind === 'founded' && <>settlement founded on <strong>{bodyName(e.bodyId)}</strong></>}
                {e.kind === 'fallen' && <>settlement lost on <strong>{bodyName(e.bodyId)}</strong></>}
                {e.kind === 'pact' && <>a pact was signed</>}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
