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
// The 2D map is the stage. A whole match is a map story -- territory,
// fleets massing, the system changing colour -- and the 3D film could
// not carry any of that. The 3D stage still exists for battles; this
// player never imports it, so its chunk has no three.js in it.
import { createMatchMap } from '../render/matchMap';
import {
  type ReplayStage as MatchStage, type MatchSummary, type SnapshotRow,
  mineEvents, type MatchEvent,
} from '../render/matchWorld';
import './BattleCinema.css';

const TICK_SECONDS = 1;

/**
 * The whole-match film.
 *
 * Two ways in, one component. Signed in, it reads the game's own
 * endpoints; behind a share link it reads the token's, where the token
 * IS the permission and there is no session to send. Everything after
 * the fetch is identical on purpose -- a shared page rendered by a
 * stripped-down second copy is a page that quietly drifts from the real
 * one, which is the trap the battle recap avoided the same way.
 */
export function MatchReplay(
  { gameId, token }: { gameId?: string; token?: string },
) {
  // A token names its own game server-side, so the caller never supplies
  // one; a signed-in viewer supplies a game and has a session.
  const src = token
    ? { summary: `/api/film/${encodeURIComponent(token)}`,
        replay: (from: number) =>
          `/api/film/${encodeURIComponent(token)}/replay?from=${from}&limit=900`,
        init: undefined as RequestInit | undefined }
    : { summary: `/api/admin/games/${gameId}/match/summary`,
        replay: (from: number) =>
          `/api/admin/games/${gameId}/match/replay?from=${from}&limit=900`,
        init: { credentials: 'include' } as RequestInit };
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
  // A diagnostic strip. The first real viewing reported "not playing, no
  // error", and nothing on screen said which of rows / stage / loop /
  // fetch had failed. Now the strip does.
  const [diag, setDiag] = useState({ rows: 0, ships: 0, fetch: 'idle',
    frames: 0, stage: 'no' });

  const posRef = useRef(0); const playRef = useRef(true);
  const speedRef = useRef(1);
  playRef.current = playing; speedRef.current = speed;

  useEffect(() => {
    let live = true;
    fetch(src.summary, src.init)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => { if (live) setSummary(j); })
      .catch(e => { if (live) setErr(e?.message || 'summary failed'); });
    return () => { live = false; };
  }, [src.summary]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !summary) return;
    if (summary.ticks.lo == null) {
      setErr('No ticks recorded for this match yet (the per-tick recorder and '
        + 'the backfill sweep both write match_snapshots; check the cron).');
      return;
    }
    let stage: MatchStage;
    try {
      stage = createMatchMap(summary, cv);
    } catch (e: any) {
      setErr('Stage failed to build: ' + (e?.message || String(e)));
      return;
    }
    stageRef.current = stage;
    setDiag(d => ({ ...d, stage: 'ok' }));
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
        const url = src.replay(from);
        setDiag(d => ({ ...d, fetch: `GET from=${from}…` }));
        let r: Response;
        try { r = await fetch(url, src.init); }
        catch (e: any) {
          setDiag(d => ({ ...d, fetch: 'network error: ' + (e?.message || e) }));
          return;
        }
        if (!r.ok) {
          setDiag(d => ({ ...d, fetch: `HTTP ${r.status}` }));
          setErr(`replay page failed: HTTP ${r.status}`); return;
        }
        const j = await r.json();
        if (dead) return;
        collected.push(...j.rows);
        stage.applyRows(j.rows);
        setEvents(mineEvents(collected, summary));
        setDiag(d => ({ ...d, rows: collected.length,
          fetch: `ok (${j.rows.length} rows, next=${j.nextFrom})` }));
        // eslint-disable-next-line no-console
        console.info('[match-replay] page', from, '→', j.rows.length, 'rows; next', j.nextFrom);
        from = j.nextFrom;
      }
    })();

    let raf = 0; let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(200, Math.max(0, now - last));
      last = now;
      if (playRef.current) {
        // The director's pace, not a flat clock: heavy scenes play at up
        // to ~2.4s a tick, quiet stretches at ~0.3s. The speed selector
        // multiplies on top.
        const rate = stage.rateAt?.(Math.floor(posRef.current)) ?? TICK_SECONDS;
        const next = posRef.current
          + (dt / (rate * 1000)) * speedRef.current;
        if (next >= hi) {
          posRef.current = hi; playRef.current = false; setPlaying(false);
        } else {
          posRef.current = next;
        }
        // The scrubber and clock need ~10 updates a second, not sixty:
        // every setPos re-renders the event log under the film.
        if ((frames % 6) === 0) setPos(posRef.current);
      }
      const t = Math.floor(posRef.current);
      try {
        stage.setTick(t, posRef.current - t);
        stage.render();
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[match-replay] frame failed at tick', t, e);
        setErr('Frame failed at tick ' + t + ': ' + (e?.message || String(e)));
        cancelAnimationFrame(raf);
        return;
      }
      frames++;
      if ((frames & 31) === 0) {
        const w = stage.worldAt(t);
        setDiag(d => ({ ...d, frames, ships: w.ships.size }));
      }
    };
    let frames = 0;
    raf = requestAnimationFrame(loop);
    return () => {
      dead = true; cancelAnimationFrame(raf); ro.disconnect();
      stage.dispose(); stageRef.current = null;
    };
  }, [summary, src.summary]);   // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (p: number) => {
    posRef.current = Math.max(range[0], Math.min(range[1], p));
    setPos(posRef.current);
  };

  const factionName = (fid: string | null) =>
    summary?.factions.find(f => f.id === fid)?.name ?? 'Unaligned';
  const bodyName = (bid: string | null) =>
    summary?.bodies.find(b => b.id === bid || b.id.endsWith(':' + (bid ?? '')))
      ?.name ?? bid ?? 'deep space';

  // The film says what happens AT a world on that world; the log is
  // where the rest of the match is written down, including the things
  // that belong to no single place -- a bill carried, an empire gone.
  // Those used to exist only as a caption that flashed for a tick.
  const visibleEvents = useMemo(() => {
    const rows: Array<{ tick: number; kind: string; bodyId: string | null;
      text: string; count?: number }> = [];
    for (const e of events) {
      rows.push({ tick: e.tick, kind: e.kind, bodyId: e.bodyId,
        text: '', count: (e as { count?: number }).count });
    }
    for (const bill of summary?.senate ?? []) {
      const at = bill.resolved_at_tick;
      if (at == null) continue;
      let yea = 0, nay = 0;
      for (const v of bill.votes) {
        if (v.vote === 'yea') yea += v.weight || 1;
        else if (v.vote === 'nay') nay += v.weight || 1;
      }
      rows.push({ tick: at, kind: 'senate', bodyId: null,
        text: `"${bill.title || bill.kind}" `
          + `${bill.status === 'passed' ? 'passed' : 'failed'} ${yea}–${nay}` });
    }
    rows.sort((a, b) => a.tick - b.tick);
    return rows.slice(0, 500);
  }, [events, summary]);
  const liveTick = Math.floor(pos);

  if (err) {
    return <div style={{ color: '#ff8a80', fontSize: 12, padding: 12 }}>{err}</div>;
  }
  return (
    <div className="cinema cinema-match">
      <div className="cinema-main">
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

      <div style={{ fontSize: 10, color: '#6f88a3', fontFamily: 'monospace',
        padding: '0 2px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>stage {diag.stage}</span>
        <span>rows {diag.rows}</span>
        <span>ships@tick {diag.ships}</span>
        <span>frames {diag.frames}</span>
        <span>fetch {diag.fetch}</span>
      </div>
      </div>

      <ol className="cinema-log" aria-label="Match log">
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
                {e.kind === 'senate' && <>senate {e.text}</>}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
