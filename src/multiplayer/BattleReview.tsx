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
// moves on. Each side forms a battle line and every hull holds one station
// for the whole fight: real orbital positions are not stored (they would
// triple the frame size and a recap is about who shot whom, not about
// ephemeris), so the arrangement is declared rather than guessed, and the
// eye can follow one ship from the first shot to the last.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';
import { getShipIconImage } from '../render/shipIconCache';
import { getEmblemImage } from '../render/emblemCache';
import {
  getPlanetTexture, getTerraformedTexture, getCloudTexture,
  terraformFraction, hashStr, mulberry32,
} from '../render/planetTexture';
import {
  drawBolt, drawBlast, drawDebris, drawWreckShards, drawMuzzleFlash,
  drawShieldFlare, drawTexturedDisk, drawSphereLighting, drawBurn,
  DETONATION_LIFE_MS, DEBRIS_LIFE_MS,
} from '../render/fxPrimitives';
import { damageProfile } from '../game/shipParts';
import { deriveSecondary } from '../game/colorUtils';
import { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import { Body } from '../types';

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
  // Livery and loadout, snapshotted when the hull first appeared (0096).
  // Null on battles recorded before that, which is why every use falls
  // back to the class default rather than assuming.
  icon_variant: string | null; parts: string | null;
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
  factions: Record<string, {
    name: string; color: string | null; color2?: string | null; emblem?: string | null;
  }>;
  /** The world it was fought over, in the shape the planet painter wants.
   *  Null for a deep-space engagement or a body since removed. */
  body: Body | null;
}

const NEUTRAL = '#8a9fb3';

/** Trim a label to fit a pixel width, with an ellipsis. The HUD had a
 *  hard character cut, which truncated one faction mid-word and still
 *  overran into the count beside it. */
function fitText(g: CanvasRenderingContext2D, s: string, maxPx: number): string {
  if (g.measureText(s).width <= maxPx) return s;
  let out = s;
  while (out.length > 1 && g.measureText(out + '…').width > maxPx) out = out.slice(0, -1);
  return out + '…';
}

// The hand-rolled hull dot and its rim highlight are gone: hulls are now
// the game's own sprites in the owner's own livery, which carries faction
// and class better than a coloured circle sized by a lookup table ever did.

/** A frame index that is always in range. Guards the one shape that
 *  produces `undefined.tick`: a non-finite position. */
function clampFrame(pos: number, len: number): number {
  if (!(len > 0)) return 0;
  const i = Math.floor(Number(pos));
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(len - 1, i);
}
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
//
// This draws the fight with the GAME's art, not with a diagram of it.
// The planet is the real cached surface texture, cloud deck, terminator
// and terraform crossfade. The hulls are the real ship sprites in the
// owner's real livery, down to the icon variant the player picked. The
// bolts, blasts, sparks and wrecks come from fxPrimitives, which is the
// same code the map draws them with — so a kill here looks like a kill
// there, and will keep looking like it when either changes.
//
// The one thing that is NOT the game's is the layout. Real orbital
// positions are not recorded (they would triple a frame and a recap is
// about who shot whom, not about ephemeris), so hulls hold stable seats
// on a ring. The ring turns slowly, because a fleet at a body is in
// orbit and a pinned board reads as a diagram; it turns as ONE piece, so
// the relative geometry a viewer is following never changes.
// ------------------------------------------------------------

const TICK_MS = 2200;          // a tick reads as a beat, not a flicker
const TRACER_FRAC = 0.55;      // shots fly over the first half of the beat

/** Light direction, unit vector pointing AWAY from the sun. The recap
 *  has no sun position — the battle record keeps who shot whom, not
 *  where the star was — so it picks one and holds it. A fixed key light
 *  is the honest choice: it makes the world read spherical without
 *  claiming to know an angle nothing recorded. */
const LIGHT_X = 0.74, LIGHT_Y = 0.67;

// Composition. An earlier cut ringed both fleets around a centred planet,
// which looked right until it played: every shot between the two sides ran
// straight through the world they were fighting over, and the middle of
// the board became a knot of crossing lines with the planet behind it.
//
// So the world sits off in a corner as a limb — bigger, closer, and never
// between anybody — and the fleets form battle lines facing each other
// across open space. Nothing is hidden and no bolt crosses rock.
const CANVAS_W = 760, CANVAS_H = 440;
const BODY_CX = CANVAS_W * 0.10, BODY_CY = CANVAS_H * 0.95, BODY_R = 150;
const BATTLE_CX = CANVAS_W * 0.56, BATTLE_CY = CANVAS_H * 0.48;
const LINE_DIST = 175;   // how far each side's line stands off the middle
const HULL_GAP = 40;     // spacing along a line
const RANK_GAP = 44;     // second rank sits this far behind the first
const RANK_MAX = 7;      // more hulls than this and the side forms up two deep

/** Sprite size per class, mirroring the map's hierarchy so a destroyer
 *  outweighs a corvette here exactly as much as it does there.
 *
 *  Sized up from a first pass that drew them at roughly half the map's
 *  on-screen size: at that scale the shaded hull swallowed the owner's
 *  colour and every ship read as grey, which defeats the entire point of
 *  drawing the real sprite in the real livery. */
const RECAP_ICON_SIZE: Record<string, number> = {
  corvette: 23, frigate: 28, freighter: 27, colony: 27, destroyer: 36,
};
const ICON_CLASSES: ShipIconClass[] = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];

function iconClassOf(cls: string | null): ShipIconClass | null {
  const c = (cls ?? '').toLowerCase();
  return (ICON_CLASSES as string[]).includes(c) ? (c as ShipIconClass) : null;
}
function iconSizeOf(cls: string | null): number {
  return RECAP_ICON_SIZE[(cls ?? '').toLowerCase()] ?? 18;
}

interface Station {
  x: number; y: number; face: number; phase: number;
  /** How far outboard this hull's label has to hang to clear the rank
   *  standing behind it. Front-rank labels in a two-deep line must clear
   *  the whole second rank, or they land on top of it. */
  labelOff: number;
}

/**
 * A fixed station for every hull, so the eye can follow one ship across
 * the whole fight.
 *
 * Each faction forms a line abreast, standing off the middle on its own
 * bearing and facing across it; a side deeper than RANK_MAX falls in two
 * ranks, which is what a fleet of thirteen actually looks like and what
 * keeps it inside the frame. Real orbital positions are not recorded, and
 * inventing drifting ones would make a recap harder to read, not more
 * honest — so the arrangement is declared, and declared once.
 */
interface Formation {
  stations: Map<string, Station>;
  /** Each side's front rank as a segment, so the recap can lay a faint
   *  line of battle in the faction's colour under its ships. Sprites are
   *  shaded hulls and a loud secondary trim can shout over the primary —
   *  the same trade the map makes — so the side's colour is stated once,
   *  underneath, where nothing has to compete with it. */
  lines: Array<{ fid: string; x1: number; y1: number; x2: number; y2: number }>;
}

function stationShips(frames: Frame[]): Formation {
  const order: string[] = [];
  const fidOf = new Map<string, string | null>();
  for (const f of frames) {
    for (const r of f.roster) {
      if (!order.includes(r.id)) { order.push(r.id); fidOf.set(r.id, r.fid); }
    }
  }
  const sides = [...new Set(order.map(id => fidOf.get(id) ?? 'none'))];
  const out = new Map<string, Station>();
  const lines: Formation['lines'] = [];
  sides.forEach((side, si) => {
    const mine = order.filter(id => (fidOf.get(id) ?? 'none') === side);
    // Two sides face each other across the middle (π and 0); more than
    // two share the compass evenly.
    const dir = Math.PI + (si / Math.max(1, sides.length)) * Math.PI * 2;
    const lx = BATTLE_CX + Math.cos(dir) * LINE_DIST;
    const ly = BATTLE_CY + Math.sin(dir) * LINE_DIST;
    const perp = dir + Math.PI / 2;
    const perRank = mine.length > RANK_MAX ? Math.ceil(mine.length / 2) : mine.length;
    mine.forEach((id, i) => {
      const rank = Math.floor(i / perRank);
      const slot = i % perRank;
      const inRank = Math.min(perRank, mine.length - rank * perRank);
      const t = (slot - (inRank - 1) / 2) * HULL_GAP;
      const back = rank * RANK_GAP;
      const twoDeep = mine.length > perRank;
      out.set(id, {
        x: lx + Math.cos(perp) * t + Math.cos(dir) * back,
        y: ly + Math.sin(perp) * t + Math.sin(dir) * back,
        face: dir + Math.PI,                       // bows toward the enemy
        phase: ((hashStr(id) % 1000) / 1000) * Math.PI * 2,
        labelOff: (twoDeep && rank === 0 ? RANK_GAP + 24 : 10),
      });
    });
    const front = Math.min(perRank, mine.length);
    const half = ((front - 1) / 2) * HULL_GAP + 16;
    if (side !== 'none' && front > 0) {
      lines.push({
        fid: side,
        x1: lx + Math.cos(perp) * -half, y1: ly + Math.sin(perp) * -half,
        x2: lx + Math.cos(perp) * half, y2: ly + Math.sin(perp) * half,
      });
    }
  });
  return { stations: out, lines };
}

/** A deterministic starfield for this battle. Seeded from the battle id
 *  so the same fight always plays against the same sky. */
function makeStars(seed: string, w: number, h: number) {
  const rng = mulberry32(hashStr(seed + ':stars'));
  return Array.from({ length: 150 }, () => ({
    x: rng() * w, y: rng() * h,
    r: 0.4 + rng() * 0.9,
    a: 0.18 + rng() * 0.5,
    ph: rng() * Math.PI * 2,
  }));
}

export function BattleRecap({ d }: { d: Detail }) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);          // fractional frame index
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);
  const posRef = useRef(0);
  posRef.current = pos;

  const frames = d.frames;
  const formation = useMemo(() => stationShips(frames), [frames]);
  const stations = formation.stations;
  const colorOf = useCallback(
    (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL, [d.factions]);
  /** Trim colour, by the same rule the map uses: the faction's declared
   *  secondary, or one derived from the primary when they never set one. */
  const trimOf = useCallback((fid: string | null) => {
    const f = fid ? d.factions[fid] : null;
    if (!f?.color) return undefined;
    return f.color2 || deriveSecondary(f.color);
  }, [d.factions]);

  /** Per-hull livery and loadout, keyed by ship id. Participants carry
   *  what the hull looked like when it fought, including hulls that did
   *  not survive to be looked up afterwards. */
  const hulls = useMemo(() => {
    const m = new Map<string, {
      variant: ShipIconVariant | undefined; energy: boolean; cls: string | null;
    }>();
    for (const p of d.participants) {
      let energy = false;
      try {
        const parts = p.parts ? JSON.parse(p.parts) : null;
        if (Array.isArray(parts)) energy = damageProfile(parts).energy >= 0.5;
      } catch { /* an unreadable loadout is a kinetic one */ }
      m.set(p.ship_id, {
        variant: (p.icon_variant as ShipIconVariant) || undefined,
        energy,
        cls: p.ship_class,
      });
    }
    return m;
  }, [d.participants]);

  /** Who killed each hull that died, by flag. The participant row records
   *  the credited killer, so the recap never has to infer it from who
   *  happened to be shooting. */
  const killerOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of d.participants) {
      if (p.died_tick == null || !p.killer_faction_id) continue;
      m.set(p.ship_id, d.factions[p.killer_faction_id]?.name ?? p.killer_faction_id);
    }
    return m;
  }, [d.participants, d.factions]);

  const stars = useMemo(() => makeStars(d.battle.id, CANVAS_W, CANVAS_H), [d.battle.id]);

  // Rasterizing an SVG sprite is asynchronous, so ask for every hull's
  // icon as soon as the battle opens rather than on the frame it is
  // first needed — otherwise the opening beat plays as fallback dots.
  useEffect(() => {
    for (const p of d.participants) {
      const cls = iconClassOf(p.ship_class);
      if (!cls) continue;
      const col = (p.faction_id && d.factions[p.faction_id]?.color) || NEUTRAL;
      getShipIconImage(cls, col, (p.icon_variant as ShipIconVariant) || undefined, trimOf(p.faction_id));
    }
  }, [d.participants, d.factions, trimOf]);

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

  // The draw runs CONTINUOUSLY, not only while playing. Two reasons, both
  // load-bearing: sprites and emblems rasterize asynchronously and land on
  // some later frame, so a paused board that drew once would keep showing
  // the fallback dots forever; and a paused board should still breathe —
  // the world turns, engines idle, wrecks tumble. A fight frozen solid
  // reads as a screenshot of a recap rather than a recap.
  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let live = true;
    let handle = 0;

    const draw = (nowMs: number) => {
      if (!live) return;
      handle = requestAnimationFrame(draw);
      const W = canvas.width, H = canvas.height;
      const p = posRef.current;
      const i = clampFrame(p, frames.length);
      const t = Math.min(1, Math.max(0, p - i));
      const frame = frames[i];
      if (!frame) return;

      g.fillStyle = '#05070c';
      g.fillRect(0, 0, W, H);

      // Sky. Twinkle is seeded per star so the field shimmers instead of
      // pulsing as one sheet.
      for (const s of stars) {
        g.fillStyle = `rgba(203, 225, 245, ${(s.a * (0.75 + 0.25 * Math.sin(nowMs / 900 + s.ph))).toFixed(3)})`;
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
      }

      const cx = BODY_CX, cy = BODY_CY, bodyR = BODY_R;

      // ---- the world being fought over ----------------------------
      const body = d.body;
      if (body) {
        const tf = terraformFraction(body, frame.tick);
        const tex = tf >= 1 ? (getTerraformedTexture(body) ?? getPlanetTexture(body))
          : getPlanetTexture(body);
        // Surface drift is wall-clock, like the map's: ticks are minutes
        // apart, so a tick-driven spin would be frozen.
        const drift = nowMs * bodyR * 0.000035;
        if (tex) {
          drawTexturedDisk(g, tex, cx, cy, bodyR, drift);
          if (tf > 0 && tf < 1) {
            const tfTex = getTerraformedTexture(body);
            if (tfTex) {
              g.save(); g.globalAlpha = tf;
              drawTexturedDisk(g, tfTex, cx, cy, bodyR, drift);
              g.restore();
            }
          }
          const clouds = getCloudTexture(body);
          if (clouds) {
            g.save(); g.globalAlpha = 0.5;
            drawTexturedDisk(g, clouds, cx, cy, bodyR, drift * 1.3);
            g.restore();
          }
          drawSphereLighting(g, cx, cy, bodyR, LIGHT_X, LIGHT_Y);
        } else {
          g.fillStyle = body.color || '#101d2b';
          g.beginPath(); g.arc(cx, cy, bodyR, 0, Math.PI * 2); g.fill();
          drawSphereLighting(g, cx, cy, bodyR, LIGHT_X, LIGHT_Y);
        }
      } else {
        // Deep space: nothing to draw but the name of nowhere.
        g.strokeStyle = '#16222f';
        g.setLineDash([3, 5]);
        g.beginPath(); g.arc(cx, cy, bodyR, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
      // Caption the limb from the corner it fills. Sitting it ON the limb
      // put it straight through the near line's labels.
      g.fillStyle = '#9dbdd8';
      g.font = '13px system-ui'; g.textAlign = 'left';
      g.fillText(d.battle.body_name ?? 'deep space', 12, H - 14);

      // Each side's line of battle, laid down before the ships so the
      // hulls sit ON it.
      for (const ln of formation.lines) {
        const c0 = colorOf(ln.fid);
        g.save();
        g.globalAlpha = 0.30;
        g.strokeStyle = c0;
        g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(ln.x1, ln.y1); g.lineTo(ln.x2, ln.y2); g.stroke();
        g.globalAlpha = 0.10;
        g.lineWidth = 9;
        g.beginPath(); g.moveTo(ln.x1, ln.y1); g.lineTo(ln.x2, ln.y2); g.stroke();
        g.restore();
      }

      // ---- board state at this instant -----------------------------
      // Damage applied so far this beat, so a hull's ring drains as the
      // bolts reach it rather than snapping at the tick boundary.
      const applied = Math.max(0, (t - TRACER_FRAC) / (1 - TRACER_FRAC));
      const landed = new Map<string, number>();
      for (const s of frame.shot_log) {
        if (!s.t || !s.hit) continue;
        landed.set(s.t, (landed.get(s.t) ?? 0) + s.dmg * applied);
      }

      // Everything killed on an EARLIER beat, and how many beats ago —
      // frames carry `dead` only on the tick a hull dies, so the wreck
      // set has to be accumulated.
      const deadBefore = new Map<string, number>();
      for (let k = 0; k < i; k++) {
        for (const r of frames[k].roster) if (r.dead === 1 && !deadBefore.has(r.id)) {
          deadBefore.set(r.id, i - k);
        }
      }

      const standings = (() => {
        const m = new Map<string, {
          name: string; color: string; emblem: string | null;
          alive: number; committed: number; lost: number;
        }>();
        for (const s of d.sides) {
          m.set(s.faction_id, {
            name: s.name, color: s.color ?? NEUTRAL,
            emblem: d.factions[s.faction_id]?.emblem ?? null,
            alive: 0, committed: s.committed, lost: 0,
          });
        }
        const seen = new Set<string>();
        for (const f of frames) {
          for (const r of f.roster) {
            if (seen.has(r.id) || !r.fid) continue;
            seen.add(r.id);
            const row = m.get(r.fid);
            if (row) row.alive++;
          }
        }
        for (const id of deadBefore.keys()) {
          const owner = frames.flatMap(f => f.roster).find(r => r.id === id);
          const row = owner?.fid ? m.get(owner.fid) : null;
          if (row) { row.alive--; row.lost++; }
        }
        return [...m.values()];
      })();

      // Station-keeping: every hull holds its slot but breathes around it,
      // so a line at rest reads as ships holding formation rather than as
      // pins in a board.
      const FALLBACK: Station = { x: BATTLE_CX, y: BATTLE_CY, face: 0, phase: 0, labelOff: 10 };
      const stOf = (id: string) => stations.get(id) ?? FALLBACK;
      const posOf = (id: string) => {
        const s = stOf(id);
        return {
          x: s.x + Math.cos(nowMs / 3300 + s.phase) * 2.2,
          y: s.y + Math.sin(nowMs / 2600 + s.phase) * 2.6,
        };
      };

      // Who each hull is shooting this beat — a ship should be pointed at
      // what it is firing on, and pointed along its orbit otherwise.
      const aimOf = new Map<string, string>();
      for (const s of frame.shot_log) {
        if (s.a && s.t && !aimOf.has(s.a)) aimOf.set(s.a, s.t);
      }

      // ---- wrecks, under the living fleet ---------------------------
      // A hull that died earlier stays on the board: without it the roster
      // silently shrinks and a viewer cannot tell a loss from a ship that
      // stopped being drawn. Held at k=0.5 so they never fade out of a
      // recap that may run for a hundred beats — a wreck at Ganymede is
      // still there at the end of the fight.
      for (const [id, ago] of deadBefore) {
        const q = posOf(id);
        drawWreckShards(g, q.x, q.y, Math.max(6, iconSizeOf(hulls.get(id)?.cls ?? null) * 0.5),
          Math.min(0.5, ago / 40), id, nowMs);
      }

      // ---- hulls ----------------------------------------------------
      for (const r of frame.roster) {
        if (deadBefore.has(r.id)) continue;
        const q = posOf(r.id);
        const meta = hulls.get(r.id);
        const col = colorOf(r.fid);
        const size = iconSizeOf(r.cls ?? meta?.cls ?? null);
        const target = aimOf.get(r.id);
        // Face the target while firing, otherwise hold the line's bearing.
        const heading = target && target !== r.id
          ? Math.atan2(posOf(target).y - q.y, posOf(target).x - q.x)
          : stOf(r.id).face;
        const dying = r.dead === 1;
        // A dying hull is at full strength until the shot that kills it
        // actually lands; after that it is a blast, drawn below.
        if (dying && applied > 0.02) continue;

        // Engine idle glow at the stern, exactly as the map does it —
        // parked fleets that don't glow read as cardboard.
        const pulse = 0.6 + 0.4 * Math.sin(nowMs / 420 + ((hashStr(r.id) % 1000) / 1000) * Math.PI * 2);
        const gx = q.x - Math.cos(heading) * size * 0.46;
        const gy = q.y - Math.sin(heading) * size * 0.46;
        const gr = Math.max(2.5, size * 0.2);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(255, 158, 74, ${(0.16 * pulse).toFixed(3)})`;
        g.beginPath(); g.arc(gx, gy, gr, 0, Math.PI * 2); g.fill();
        g.fillStyle = `rgba(255, 220, 168, ${(0.28 * pulse).toFixed(3)})`;
        g.beginPath(); g.arc(gx, gy, gr * 0.45, 0, Math.PI * 2); g.fill();
        g.restore();

        const cls = iconClassOf(r.cls ?? meta?.cls ?? null);
        const icon = cls ? getShipIconImage(cls, col, meta?.variant, trimOf(r.fid)) : null;
        if (icon) {
          g.save();
          g.translate(q.x, q.y);
          g.rotate(heading);
          g.drawImage(icon, -size / 2, -size / 2, size, size);
          g.restore();
        } else {
          // Sprite still rasterizing, or a class with no icon. Same
          // fallback the map uses: a filled dot in the owner's colour, so
          // the board is never empty and never mislabelled.
          g.fillStyle = col;
          g.beginPath(); g.arc(q.x, q.y, size * 0.3, 0, Math.PI * 2); g.fill();
        }

        // A hull in trouble looks like it. Same fires and smoke the map
        // lights a battered ship with, severity scaled off how far its
        // health has actually fallen — so "losing badly" is something the
        // board shows before the HUD has to say it.
        const hp = Math.max(0, r.hp - (landed.get(r.id) ?? 0));
        const frac = r.hpMax ? Math.max(0, Math.min(1, hp / r.hpMax)) : 1;
        if (frac < 0.6) {
          drawBurn(g, q.x, q.y, size * 0.5,
            Math.min(1, (0.6 - frac) / 0.5), nowMs, hashStr(r.id));
        }

        // Damage as the map's own hp bar — same geometry, same three
        // colours. An earlier cut ringed each hull instead, and a ring in
        // bright green around a green ship read as a shield bubble, not as
        // health; worse, an entire fleet lightly scratched looked like a
        // fleet of bubbles. A bar under the hull says the same thing and
        // says it the way the rest of the game says it.
        if (frac < 0.999) {
          const barW = Math.max(18, size * 1.1), barH = 3;
          const bx = q.x - barW / 2, by = q.y + size * 0.62;
          g.fillStyle = '#2a3d50';
          g.fillRect(bx, by, barW, barH);
          g.fillStyle = frac > 0.5 ? '#6ee7b7' : frac > 0.25 ? '#ffb84d' : '#ff5e5e';
          g.fillRect(bx, by, barW * frac, barH);
        }

        // Only name what the eye can follow. Eighteen labels is a wall of
        // text; the big hulls and the dying carry theirs. Labels hang on
        // the OUTBOARD side of each line so they never fall across the
        // space the shooting happens in.
        if (size >= 27 || dying) {
          const st = stOf(r.id);
          const outward = Math.cos(st.face) < 0 ? 1 : -1;  // away from the middle
          g.fillStyle = dying ? '#ff8a80' : '#cfe0ee';
          g.font = '10px system-ui';
          g.textAlign = outward > 0 ? 'left' : 'right';
          g.fillText(r.name ?? r.id, q.x + outward * (size * 0.5 + st.labelOff), q.y + 3);
        }
      }

      // ---- weapons ---------------------------------------------------
      // Bolts, muzzle flashes and impacts all blend additively, the way
      // the map's do. Timing is REAL milliseconds inside the beat, not a
      // fraction of it: a slow-motion recap should still show a shell
      // landing at the speed a shell lands.
      const beatMs = t * TICK_MS;
      const travelMs = TRACER_FRAC * TICK_MS;
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const s of frame.shot_log) {
        if (!s.a || !s.t) continue;
        const from = posOf(s.a), to = posOf(s.t);
        const travel = Math.min(1, t / TRACER_FRAC);
        if (travel <= 0) continue;
        const shooter = frame.roster.find(r => r.id === s.a);
        const col = colorOf(shooter?.fid ?? null);
        const energy = hulls.get(s.a)?.energy ?? false;
        const ang = Math.atan2(to.y - from.y, to.x - from.x);

        // A miss is a bolt that goes past, not a bolt in another colour:
        // it flies wide and keeps going, which is what a miss looks like.
        const wide = s.hit ? 0 : 0.13;
        const ex = from.x + (to.x - from.x) * travel + Math.cos(ang + Math.PI / 2) * wide * 60 * travel;
        const ey = from.y + (to.y - from.y) * travel + Math.sin(ang + Math.PI / 2) * wide * 60 * travel;

        drawBolt(g, from.x, from.y, ex, ey, col, s.hit ? 0.9 : 0.4, energy);

        // Muzzle flash for the first moments of the volley.
        if (beatMs < 130) {
          drawMuzzleFlash(g, from.x, from.y, ang, energy ? '#7fd4ff' : col,
            (1 - beatMs / 130) * 0.9, iconSizeOf(shooter?.cls ?? null) / 20);
        }

        // Impact. A hit that the hull survives flares its shields; a hit
        // that kills it goes to the blast pass below.
        if (s.hit && !s.kill && travel >= 1) {
          const sinceMs = beatMs - travelMs;
          if (sinceMs >= 0 && sinceMs < 260) {
            const tgt = frame.roster.find(r => r.id === s.t);
            drawShieldFlare(g, to.x, to.y, iconSizeOf(tgt?.cls ?? null) * 0.6,
              ang + Math.PI, (1 - sinceMs / 260) * 0.8, energy ? '#bfe9ff' : '#ffd08a');
          }
        }
      }

      // Deaths: the real blast and the real debris, run at real speed
      // from the instant the killing shot lands.
      for (const r of frame.roster) {
        if (r.dead !== 1 || deadBefore.has(r.id)) continue;
        const sinceMs = beatMs - travelMs;
        if (sinceMs < 0) continue;
        const q = posOf(r.id);
        const scale = iconSizeOf(r.cls ?? null) / 24;
        if (sinceMs < DETONATION_LIFE_MS) {
          drawBlast(g, q.x, q.y, sinceMs / DETONATION_LIFE_MS, r.id, scale);
        }
        if (sinceMs < DEBRIS_LIFE_MS) {
          drawDebris(g, q.x, q.y, iconSizeOf(r.cls ?? null) * 0.5, sinceMs / DEBRIS_LIFE_MS, r.id);
        }
      }
      g.restore();

      // ---- what the shots actually did ---------------------------------
      // Floating damage, straight off the shot log. A recap that only
      // drains a bar leaves the viewer estimating; the record holds the
      // exact number, so print it and stop making them guess. Rises and
      // fades over ~900ms from the moment of impact, stacked per target so
      // four hits on one hull don't overprint into a smear.
      const stack = new Map<string, number>();
      g.textAlign = 'center';
      for (const s of frame.shot_log) {
        if (!s.t || !s.hit || !(s.dmg > 0)) continue;
        const sinceMs = beatMs - travelMs;
        if (sinceMs < 0 || sinceMs > 900) continue;
        const n = stack.get(s.t) ?? 0;
        stack.set(s.t, n + 1);
        const to = posOf(s.t);
        const rise = (sinceMs / 900) * 26;
        const alpha = 1 - (sinceMs / 900) ** 2;
        g.fillStyle = `rgba(255, 176, 120, ${alpha.toFixed(3)})`;
        g.font = `${s.kill ? 'bold ' : ''}11px system-ui`;
        // The killing blow's number drops BELOW the hull: above it is
        // where the "lost to" callout goes, and the two were overprinting
        // on the one hull where both fire at once.
        g.fillText(`-${Math.round(s.dmg)}`,
          to.x + (n % 2 ? 14 : -14),
          s.kill ? to.y + 22 + rise : to.y - 12 - rise - n * 5);
      }

      // A kill gets named. The record knows which hull went and which flag
      // took it, and that pairing is the single most memorable fact in any
      // engagement — it should not be something a viewer has to piece
      // together from a counter ticking down.
      for (const r of frame.roster) {
        if (r.dead !== 1 || deadBefore.has(r.id)) continue;
        const sinceMs = beatMs - travelMs;
        if (sinceMs < 120 || sinceMs > 1600) continue;
        const killer = killerOf.get(r.id);
        const q = posOf(r.id);
        const alpha = Math.min(1, (sinceMs - 120) / 220) * (1 - Math.max(0, (sinceMs - 1100) / 500));
        const head = `${r.name ?? r.id} lost`;
        const sub = killer ? `to ${killer}` : '';
        // A backing plate, because a kill in a crowded line lands on top
        // of the hull labels either side of it — and the one line a
        // viewer most needs to read is the one that must not be legible
        // "unless the formation happens to be sparse there".
        g.font = 'bold 12px system-ui';
        const wHead = g.measureText(head).width;
        g.font = '10px system-ui';
        const plateW = Math.max(wHead, sub ? g.measureText(sub).width : 0) + 14;
        const plateH = sub ? 30 : 18;
        const plateY = q.y - 44;
        g.fillStyle = `rgba(8, 12, 18, ${(alpha * 0.78).toFixed(3)})`;
        g.fillRect(q.x - plateW / 2, plateY, plateW, plateH);
        g.strokeStyle = `rgba(255, 138, 128, ${(alpha * 0.45).toFixed(3)})`;
        g.lineWidth = 1;
        g.strokeRect(q.x - plateW / 2, plateY, plateW, plateH);
        g.fillStyle = `rgba(255, 138, 128, ${alpha.toFixed(3)})`;
        g.font = 'bold 12px system-ui';
        g.fillText(head, q.x, plateY + 13);
        if (sub) {
          g.fillStyle = `rgba(190, 210, 228, ${(alpha * 0.85).toFixed(3)})`;
          g.font = '10px system-ui';
          g.fillText(sub, q.x, plateY + 25);
        }
      }

      // ---- HUD --------------------------------------------------------
      // Who is in this, and how the sides stand RIGHT NOW. Without it a
      // viewer watches coloured hulls trade fire with no idea which
      // colour is losing.
      g.textAlign = 'left';
      g.fillStyle = '#8a9fb3'; g.font = '12px system-ui';
      g.fillText(`T+${frame.tick}`, 12, 20);
      g.fillText(`${frame.shots} shots · ${frame.hits} hit`
        + (frame.kills ? ` · ${frame.kills} lost` : ''), 12, 36);

      let ly = 20;
      for (const s of standings) {
        const swatchX = W - 168;
        const emblem = getEmblemImage(s.emblem, s.color);
        g.textAlign = 'left';
        if (emblem) {
          g.drawImage(emblem, swatchX - 2, ly - 11, 13, 13);
        } else {
          g.fillStyle = s.color;
          g.fillRect(swatchX, ly - 8, 8, 8);
        }
        g.fillStyle = '#cfe0ee';
        g.fillText(fitText(g, s.name, 100), swatchX + 17, ly);
        g.textAlign = 'right';
        g.fillStyle = s.lost > 0 ? '#ff8a80' : '#8a9fb3';
        g.fillText(`${s.alive}/${s.committed}`, W - 12, ly);
        ly += 16;
      }
    };

    handle = requestAnimationFrame(draw);
    return () => { live = false; cancelAnimationFrame(handle); };
  }, [frames, stations, formation, colorOf, trimOf, hulls, killerOf, stars,
      d.battle.body_name, d.sides, d.factions, d.body]);

  if (frames.length === 0) {
    return <div style={{ color: NEUTRAL, padding: 8 }}>No frames recorded for this battle.</div>;
  }
  // Clamped, not trusted: Math.min(len-1, NaN) is NaN, and frames[NaN]
  // is undefined — which is the exact shape of the crash reported from
  // the live app and never reproduced here.
  const idx = clampFrame(pos, frames.length);

  return (
    <div style={{ margin: '10px 0' }}>
      <canvas ref={cv} width={760} height={440}
        style={{ width: '100%', maxWidth: 760, borderRadius: 8, border: '1px solid #22303f', display: 'block' }} />
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
          type="range" min={0} max={Math.max(0.0001, frames.length - 1)} step={0.02}
          value={Number.isFinite(pos) ? pos : 0}
          onChange={e => {
            setPlaying(false);
            const v = Number(e.target.value);
            setPos(Number.isFinite(v) ? v : 0);
          }}
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
