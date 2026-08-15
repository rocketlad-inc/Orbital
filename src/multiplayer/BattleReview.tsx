// ============================================================
// BattleReview — page through a match's engagements and watch one back.
//
// The records this reads (migration 0092) are the first combat data the
// game keeps at the grain a player remembers a fight at: one body, one
// contiguous run of ticks, every shot attributed both ways. Everything
// here is a view onto that — nothing is recomputed, because the point of
// recording it was to stop guessing.
//
// The recap is the reason the per-tick frames exist. A frame is the board
// as it stood when the tick opened plus every shot fired during it, so
// playback draws the roster, animates the tracers, applies the damage and
// moves on. Ships are laid out on a ring around the body: real orbital
// positions are not stored (they would triple the frame size and a recap
// is about who shot whom, not about ephemeris), so each hull holds a
// stable seat for the whole battle and the eye can follow it.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';

interface BattleRow {
  id: string;
  body_id: string | null;
  body_name: string | null;
  started_tick: number;
  last_fire_tick: number;
  ended_tick: number | null;
  status: string;
  tick_count: number;
  shots: number;
  hits: number;
  damage: number;
  damage_raw: number;
  ships_lost: number;
  faction_count: number;
  factions: Array<{ id: string; name: string; color: string | null }>;
  victor: { id: string; name?: string; color?: string | null } | null;
  pacts_broken_during: string[];
}

interface Participant {
  ship_id: string; faction_id: string | null; ship_name: string | null;
  ship_class: string | null; hp_max: number | null; hp_start: number | null;
  hp_end: number | null; first_tick: number; last_tick: number;
  died_tick: number | null; killer_faction_id: string | null;
  shots: number; hits: number; shots_taken: number; hits_taken: number;
  damage_dealt: number; damage_taken: number; kills: number;
}

interface Frame {
  tick: number; seq: number; shots: number; hits: number; damage: number; kills: number;
  roster: Array<{
    id: string; fid: string | null; cls: string | null; name: string | null;
    hp: number; hpMax: number | null; dead: number;
  }>;
  shot_log: Array<{ a: string | null; t: string | null; hit: number; dmg: number; kill: number }>;
}

interface Detail {
  battle: BattleRow;
  sides: Array<{
    faction_id: string; name: string; color: string | null;
    committed: number; lost: number; shots: number; hits: number;
    damage_dealt: number; damage_taken: number; kills: number;
  }>;
  participants: Participant[];
  frames: Frame[];
  factions: Record<string, { name: string; color: string | null }>;
}

const NEUTRAL = '#8a9fb3';
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const r1 = (n: number) => Math.round((n ?? 0) * 10) / 10;

/**
 * An analytics widget must never cost you the app.
 *
 * This section reads freshly-recorded data whose shape is younger than
 * anything else on the page, so it is exactly where an unexpected null
 * will turn up first. The whole-app boundary already catches those, but
 * catching one HERE keeps the rest of the analytics usable and puts the
 * message next to the thing that failed instead of on a blank screen.
 */
class BattleBoundary extends React.Component<
  { children: React.ReactNode }, { msg: string | null }
> {
  constructor(p: { children: React.ReactNode }) { super(p); this.state = { msg: null }; }
  static getDerivedStateFromError(e: unknown) {
    return { msg: String((e as Error)?.message ?? e) };
  }
  componentDidCatch(e: unknown) { console.error('BattleReview crashed', e); }
  render() {
    if (this.state.msg) {
      return (
        <div className="mp-error" style={{ lineHeight: 1.6 }}>
          The battle view hit an error: <b>{this.state.msg}</b>
          <div style={{ color: NEUTRAL, fontSize: 11, marginTop: 4 }}>
            The rest of the analytics still works. The full trace is in the
            diagnostic log.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function BattleReview(props: { gameId: string }) {
  return <BattleBoundary><BattleReviewInner {...props} /></BattleBoundary>;
}

function BattleReviewInner({ gameId }: { gameId: string }) {
  const [list, setList] = useState<BattleRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const res = await apiFetch<{ battles: BattleRow[] }>(`/api/admin/games/${gameId}/battles`);
      if (dead) return;
      if (res.ok) { setList(res.data.battles); setErr(null); }
      else setErr(`Battles failed to load (HTTP ${res.status}).`);
    })();
    return () => { dead = true; };
  }, [gameId]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let dead = false;
    (async () => {
      const res = await apiFetch<Detail>(
        `/api/admin/games/${gameId}/battles/${encodeURIComponent(openId)}?shots=0`);
      if (dead) return;
      if (res.ok) setDetail(res.data);
      else setErr(`Battle failed to load (HTTP ${res.status}).`);
    })();
    return () => { dead = true; };
  }, [gameId, openId]);

  if (err) return <div className="mp-error">{err}</div>;
  if (!list) return <div style={{ color: NEUTRAL, padding: 12 }}>Loading battles…</div>;
  if (list.length === 0) {
    return (
      <div style={{ color: NEUTRAL, padding: 12, lineHeight: 1.6 }}>
        No battles recorded for this match yet. A battle opens on the first shot
        at a body and closes after six quiet ticks — matches played before
        battle recording shipped have none.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '0 0 300px', maxHeight: 620, overflowY: 'auto' }}>
        {list.map(b => (
          <BattleCard key={b.id} b={b} open={b.id === openId}
            onClick={() => setOpenId(b.id === openId ? null : b.id)} />
        ))}
      </div>
      <div style={{ flex: '1 1 480px', minWidth: 380 }}>
        {!openId && <div style={{ color: NEUTRAL, padding: 12 }}>Pick a battle to review.</div>}
        {openId && !detail && <div style={{ color: NEUTRAL, padding: 12 }}>Loading…</div>}
        {detail && <BattleDetail d={detail} />}
      </div>
    </div>
  );
}

function BattleCard({ b, open, onClick }: { b: BattleRow; open: boolean; onClick: () => void }) {
  const span = (b.ended_tick ?? b.last_fire_tick) - b.started_tick + 1;
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
        background: open ? '#16273a' : '#0d151f',
        border: `1px solid ${open ? '#3d6b96' : '#22303f'}`,
        borderRadius: 6, padding: '8px 10px', cursor: 'pointer', color: '#cfe0ee',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <b style={{ fontSize: 12 }}>{b.body_name ?? b.body_id ?? 'Deep space'}</b>
        <span style={{ fontSize: 10, color: NEUTRAL }}>T+{b.started_tick}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, margin: '5px 0', flexWrap: 'wrap' }}>
        {b.factions.map(f => (
          <span key={f.id} style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 7,
            border: `1px solid ${f.color ?? NEUTRAL}`, color: f.color ?? NEUTRAL,
          }}>{f.name}</span>
        ))}
      </div>
      <div style={{ fontSize: 10, color: NEUTRAL, fontVariantNumeric: 'tabular-nums' }}>
        {span} tick{span === 1 ? '' : 's'} · {b.shots} shots · {pct(b.hits, b.shots)}% hit
        {b.ships_lost > 0 && <> · <span style={{ color: '#ff8a80' }}>{b.ships_lost} lost</span></>}
        {b.status === 'active' && <> · <span style={{ color: '#ffb84d' }}>live</span></>}
      </div>
      {b.pacts_broken_during.length > 0 && (
        <div style={{ fontSize: 9, color: '#ffb84d', marginTop: 3 }}>
          ⚠ a pact broke during this fight
        </div>
      )}
    </button>
  );
}

function BattleDetail({ d }: { d: Detail }) {
  const b = d.battle;
  const colorOf = (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL;
  const nameOf = (fid: string | null) => (fid && d.factions[fid]?.name) || 'unknown';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, color: '#e6f0f8', fontSize: 15 }}>
          {b.body_name ?? 'Deep space'} · T+{b.started_tick}–{b.ended_tick ?? b.last_fire_tick}
        </h3>
        <span style={{ fontSize: 11, color: NEUTRAL }}>
          {b.victor ? <>victor <b style={{ color: colorOf(b.victor.id) }}>{b.victor.name}</b></> : 'no clear victor'}
        </span>
      </div>

      <BattleRecap d={d} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
        {d.sides.map(s => (
          <div key={s.faction_id} style={{
            flex: '1 1 190px', background: '#0d151f', borderRadius: 6,
            border: `1px solid ${s.color ?? NEUTRAL}`, padding: '8px 10px',
          }}>
            <b style={{ color: s.color ?? NEUTRAL, fontSize: 12 }}>{s.name}</b>
            <div style={{ fontSize: 10, color: '#cfe0ee', marginTop: 4, lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
              committed <b>{s.committed}</b> · lost <b style={{ color: s.lost ? '#ff8a80' : undefined }}>{s.lost}</b><br />
              {s.hits}/{s.shots} hits ({pct(s.hits, s.shots)}%)<br />
              dealt <b>{r1(s.damage_dealt)}</b> · took <b>{r1(s.damage_taken)}</b>
            </div>
          </div>
        ))}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr style={{ color: NEUTRAL, textAlign: 'left' }}>
            <th style={{ padding: '4px 6px' }}>Hull</th>
            <th style={{ padding: '4px 6px' }}>Hit%</th>
            <th style={{ padding: '4px 6px' }}>Dealt</th>
            <th style={{ padding: '4px 6px' }}>Taken</th>
            <th style={{ padding: '4px 6px' }}>Kills</th>
            <th style={{ padding: '4px 6px' }}>Fate</th>
          </tr>
        </thead>
        <tbody>
          {d.participants.map(p => (
            <tr key={p.ship_id} style={{ borderTop: '1px solid #1b2836', opacity: p.died_tick != null ? 0.65 : 1 }}>
              <td style={{ padding: '4px 6px' }}>
                <span style={{ color: colorOf(p.faction_id) }}>■</span>{' '}
                {p.ship_name ?? p.ship_id}
                <span style={{ color: NEUTRAL }}> {p.ship_class}</span>
              </td>
              <td style={{ padding: '4px 6px' }}>{pct(p.hits, p.shots)}%</td>
              <td style={{ padding: '4px 6px' }}>{r1(p.damage_dealt)}</td>
              <td style={{ padding: '4px 6px' }}>{r1(p.damage_taken)}</td>
              <td style={{ padding: '4px 6px' }}>{p.kills || ''}</td>
              <td style={{ padding: '4px 6px', color: p.died_tick != null ? '#ff8a80' : NEUTRAL }}>
                {p.died_tick != null
                  ? `lost T+${p.died_tick}${p.killer_faction_id ? ` to ${nameOf(p.killer_faction_id)}` : ''}`
                  : `${r1(p.hp_end ?? 0)}/${r1(p.hp_max ?? 0)} hp`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------
// The recap.
// ------------------------------------------------------------

const TICK_MS = 2200;          // a tick reads as a beat, not a flicker
const TRACER_FRAC = 0.55;      // shots fly over the first half of the beat

/** Stable seat for every hull, so the eye can follow one ship across the
 *  whole fight. Sides are split onto opposing arcs — real orbital
 *  positions are not recorded, and inventing drifting ones would make a
 *  recap harder to read, not more honest. */
function seatShips(frames: Frame[]) {
  const order: string[] = [];
  const fidOf = new Map<string, string | null>();
  for (const f of frames) {
    for (const r of f.roster) {
      if (!order.includes(r.id)) { order.push(r.id); fidOf.set(r.id, r.fid); }
    }
  }
  const sides = [...new Set(order.map(id => fidOf.get(id) ?? 'none'))];
  const seats = new Map<string, { x: number; y: number }>();
  for (const side of sides) {
    const mine = order.filter(id => (fidOf.get(id) ?? 'none') === side);
    const idx = sides.indexOf(side);
    // Each faction gets its own arc of the ring, evenly spaced.
    const base = (idx / Math.max(1, sides.length)) * Math.PI * 2;
    const spread = (Math.PI * 2) / Math.max(1, sides.length) * 0.72;
    mine.forEach((id, i) => {
      const a = base + (mine.length === 1 ? 0 : (i / (mine.length - 1) - 0.5) * spread);
      seats.set(id, { x: Math.cos(a), y: Math.sin(a) });
    });
  }
  return seats;
}

export function BattleRecap({ d }: { d: Detail }) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);          // fractional frame index
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);

  const frames = d.frames;
  const seats = useMemo(() => seatShips(frames), [frames]);
  const colorOf = useCallback(
    (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL, [d.factions]);

  // Advance the clock. Position is fractional so the draw can interpolate
  // inside a beat — the tracers fly, then the damage lands.
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setPos(p => {
        const next = p + dt / TICK_MS;
        if (next >= frames.length - 1 + 0.999) { setPlaying(false); return frames.length - 1; }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, frames.length]);

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width, H = canvas.height;
    const i = Math.min(frames.length - 1, Math.floor(pos));
    const t = Math.min(1, Math.max(0, pos - i));
    const frame = frames[i];
    if (!frame) return;

    g.fillStyle = '#05070c';
    g.fillRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34;

    // The world being fought over.
    g.fillStyle = '#101d2b';
    g.beginPath(); g.arc(cx, cy, R * 0.42, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#1d3448';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R * 0.42, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#587a96';
    g.font = '11px system-ui'; g.textAlign = 'center';
    g.fillText(d.battle.body_name ?? '', cx, cy + 4);

    // Damage applied so far this beat, so a hull's bar drains as the
    // tracers reach it rather than snapping at the tick boundary.
    const landed = new Map<string, number>();
    const applied = Math.max(0, (t - TRACER_FRAC) / (1 - TRACER_FRAC));
    for (const s of frame.shot_log) {
      if (!s.t || !s.hit) continue;
      landed.set(s.t, (landed.get(s.t) ?? 0) + s.dmg * applied);
    }

    const posOf = (id: string) => {
      const seat = seats.get(id) ?? { x: 0, y: -1 };
      return { x: cx + seat.x * R, y: cy + seat.y * R };
    };

    // Tracers.
    for (const s of frame.shot_log) {
      if (!s.a || !s.t) continue;
      const from = posOf(s.a), to = posOf(s.t);
      const travel = Math.min(1, t / TRACER_FRAC);
      if (travel <= 0) continue;
      const hx = from.x + (to.x - from.x) * travel;
      const hy = from.y + (to.y - from.y) * travel;
      const shooter = frame.roster.find(r => r.id === s.a);
      g.strokeStyle = s.hit ? colorOf(shooter?.fid ?? null) : '#3a4a5a';
      g.globalAlpha = s.hit ? 0.85 : 0.35;
      g.lineWidth = s.hit ? 1.6 : 1;
      g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(hx, hy); g.stroke();
      if (s.hit && travel >= 1) {
        g.globalAlpha = Math.max(0, 1 - applied);
        g.fillStyle = s.kill ? '#ff5e5e' : '#ffd08a';
        g.beginPath(); g.arc(to.x, to.y, s.kill ? 7 : 4, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }

    // Hulls.
    for (const r of frame.roster) {
      const p = posOf(r.id);
      const hp = Math.max(0, r.hp - (landed.get(r.id) ?? 0));
      const frac = r.hpMax ? Math.max(0, Math.min(1, hp / r.hpMax)) : 1;
      const dying = r.dead === 1;
      g.globalAlpha = dying ? 1 - applied * 0.85 : 1;
      g.fillStyle = colorOf(r.fid);
      g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2); g.fill();
      // hp ring
      g.strokeStyle = frac > 0.5 ? '#6ee7b7' : frac > 0.25 ? '#ffb84d' : '#ff5e5e';
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(p.x, p.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = '#cfe0ee';
      g.font = '9px system-ui';
      g.textAlign = p.x < cx ? 'right' : 'left';
      g.fillText(r.name ?? r.id, p.x + (p.x < cx ? -15 : 15), p.y + 3);
    }

    // Beat label.
    g.textAlign = 'left';
    g.fillStyle = '#8a9fb3'; g.font = '11px system-ui';
    g.fillText(`T+${frame.tick}`, 10, 18);
    g.fillText(`${frame.shots} shots · ${frame.hits} hit`
      + (frame.kills ? ` · ${frame.kills} lost` : ''), 10, 32);
  }, [pos, frames, seats, colorOf, d.battle.body_name]);

  if (frames.length === 0) {
    return <div style={{ color: NEUTRAL, padding: 8 }}>No frames recorded for this battle.</div>;
  }
  const idx = Math.min(frames.length - 1, Math.floor(pos));

  return (
    <div style={{ margin: '10px 0' }}>
      <canvas ref={cv} width={520} height={300}
        style={{ width: '100%', maxWidth: 520, borderRadius: 8, border: '1px solid #22303f', display: 'block' }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button
          onClick={() => {
            if (pos >= frames.length - 1) setPos(0);
            setPlaying(p => !p);
          }}
          style={{
            background: '#16273a', border: '1px solid #3d6b96', borderRadius: 5,
            color: '#cfe0ee', padding: '3px 10px', cursor: 'pointer', fontSize: 11,
          }}
        >{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <input
          type="range" min={0} max={frames.length - 1} step={0.02} value={pos}
          onChange={e => { setPlaying(false); setPos(Number(e.target.value)); }}
          style={{ flex: 1 }}
          aria-label="Scrub the battle"
        />
        <span style={{ fontSize: 10, color: NEUTRAL, minWidth: 76, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          T+{frames[idx].tick} · {idx + 1}/{frames.length}
        </span>
      </div>
    </div>
  );
}
