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
// moves on. Everyone is in orbit around the body, because that is where
// they were: each side holds its own altitude band, the far half of every
// orbit draws behind the world, and fire that crosses it is cut to the
// parts you could actually see. Real orbital elements are not stored
// (they would triple the frame size and a recap is about who shot whom,
// not about ephemeris), so the arrangement is declared rather than
// guessed, and the eye can follow one ship from the first shot to the
// last.
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
  DETONATION_LIFE_MS, DEBRIS_LIFE_MS, ENERGY_COLOR,
} from '../render/fxPrimitives';
// Settlements are drawn with the game's own rigs — the same station ring
// and city cluster the map and the world menu use.
import { drawCityCluster, drawStationStructure } from '../render/isoStructures';
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
  /** 'ship' | 'station' | 'city' (0097); absent on older battles. */
  kind?: string;
}

interface Frame {
  tick: number; seq: number; shots: number; hits: number; damage: number; kills: number;
  roster: Array<{
    id: string; fid: string | null; cls: string | null; name: string | null;
    hp: number; hpMax: number | null; dead: number;
    /** 'ship' | 'station' | 'city' (0097). Absent on battles recorded
     *  before settlements were entered in the roster at all. */
    kind?: string;
  }>;
  /** `e` is the attacker's energy fraction for that volley (0097) — the
   *  exact number the damage roll used. Absent on older battles, which
   *  fall back to the hull's recorded loadout. */
  shot_log: Array<{
    a: string | null; t: string | null; hit: number; dmg: number; kill: number;
    e?: number;
  }>;
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
// A volley is not a single event. Every gun on the board opening at the
// instant the beat starts, and every round landing together, is a drum
// hit rather than a battle — so each shot gets its own launch time inside
// the first part of the beat, seeded from its shooter and the tick so
// playback is identical every time.
const LAUNCH_SPREAD = 0.34;    // volleys go off across this much of a beat
const FLIGHT_FRAC = 0.28;      // and each round is in the air for this long
/** How long a round takes to bury itself in the hull it hit. Without
 *  this the bolt was clamped at the target and sat on its nose for the
 *  rest of the beat — the better part of a second, parked. */
const BURY_MS = 110;
/** Damage drains over this long once a round lands, so the bar moves
 *  with the hit that caused it. */
const DRAIN_MS = 420;

/** Light direction, unit vector pointing AWAY from the sun. The recap
 *  has no sun position — the battle record keeps who shot whom, not
 *  where the star was — so it picks one and holds it. A fixed key light
 *  is the honest choice: it makes the world read spherical without
 *  claiming to know an angle nothing recorded. */
const LIGHT_X = 0.74, LIGHT_Y = 0.67;

// Composition: everyone is in orbit, because that is where they were.
//
// A first cut laid the sides out as battle lines across open space. It
// was readable, and it was wrong: ships at a body are in orbit around it,
// and a recap that stands them in rows is describing a different game.
//
// The reason the lines existed was that a centred planet put itself
// between every pair of shooters. That is solved properly here rather
// than avoided: the far half of each orbit is drawn BEHIND the world, and
// a bolt whose path crosses the disc is clipped to the parts you could
// actually see. Ships passing behind the planet is not a problem to route
// around — it is the thing that sells the geometry.
const CANVAS_W = 760, CANVAS_H = 440;
const BODY_CX = CANVAS_W * 0.42, BODY_CY = CANVAS_H * 0.52, BODY_R = 84;

/** ry/rx for every orbit drawn here — the orbital plane seen from about
 *  20° above it. Dead side-on reads as a line, dead flat reads as a
 *  circle drawn on the screen rather than a path around a world. */
// Flatter than this and a side sweeping past the left or right limb
// foreshortens into a pile — which is exactly where the fleet happened to
// be the first time this was watched.
const ORBIT_TILT = 0.58;
/** Altitude of the first band above the surface, and the step between
 *  bands. Each faction parks in its own, which separates the sides
 *  without pinning them and is what a contested orbit looks like. */
// Sides are separated by ALTITUDE, not by bearing. Standing them on
// opposite sides of the world put it between them and made almost every
// exchange cross it; standing them side by side on one arc fixed that and
// packed both fleets into a crowd. Concentric bands solve both: the fire
// runs radially across the gap between two rings, which is short and
// nowhere near the middle, and each side gets the whole arc to spread
// along.
const BAND_0 = 72, BAND_GAP = 76;
/** A big side splits across adjacent altitudes inside its own band.
 *
 *  Radial separation is the one kind that survives the projection.
 *  Spacing along the arc does not: a circular orbit seen at an angle
 *  really does crowd its ships together as they swing past the limbs,
 *  and since that is what orbiting looks like, the answer is to spend
 *  fewer ships on the arc rather than to fake the motion. */
const SUB_BAND = 28, SUB_BAND_MIN = 6, SUB_BAND_MANY = 9;
/** Stations sit in a low, tight orbit of their own. */
const STATION_BAND = 44;
/** One revolution per ~78 seconds. Every band shares this rate. A real
 *  orbit is slower the higher it is, and letting the bands drift apart
 *  would be more truthful — but it also slowly scrambles the pairing a
 *  viewer is following, and the arrangement here is already declared
 *  rather than recorded. Truthfulness is spent on the shots, not on the
 *  ephemeris the record never kept. */
const ORBIT_RATE = (Math.PI * 2) / 78000;
/** How much of its band a side spreads across. Just under half the
 *  circle: wide enough to read as a fleet strung out along an orbit,
 *  tight enough that two sides stay two sides. */
// How much of its band a side spreads across, and the number that
// actually decides whether fire looks right.
//
// The server pairs shooters with targets round-robin across the whole
// fleet, not by proximity — so a recap gets plenty of shots between hulls
// at opposite ends of a formation. Wrap a formation around a world and
// those chords go straight through it, and the map's no-fire-through-a-
// body rule (which this honours) then eats a large share of the volley:
// the recap would draw far fewer bolts than were fired.
//
// So the arc is bounded by geometry rather than taste. The chord between
// the two extremes of an arc of half-angle a at radius r passes the
// centre at r·cos(a), and that has to clear the world:
//
//     r · cos(SIDE_ARC / 2)  >  BODY_R
//
// At the inner band (BODY_R + BAND_0 = 156) an arc of 1.8 clears by
// 156·cos(0.9) ≈ 97 against a radius of 84. Every side sits inside that,
// so essentially nothing is ever clipped, and the clipper stays as the
// backstop it should be.
const SIDE_ARC = 1.8;
/** A slight bearing offset on top of the altitude split, so two fleets
 *  of similar size do not sit exactly nose to nose all the way round.
 *  Deliberately small: bearing separation is what puts a world between
 *  two sides, and altitude separation is what keeps them apart without
 *  doing that. */
const SIDE_SEP = 0.18;
/** Where the whole engagement sits on the ring — the near face, angled
 *  down-right, so the fleets are between the viewer and the world for
 *  most of a revolution rather than behind it. */
const ENGAGEMENT_BEARING = 0.9;

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

type Kind = 'ship' | 'station' | 'city';

interface Station {
  kind: Kind;
  /** Semi-major axis of this combatant's orbit, canvas px. Unused for a
   *  city, which is ON the surface. */
  rx: number;
  /** Angle at t=0. A city's is its fixed spot on the globe. */
  phase0: number;
  /** Cities do not orbit — the world turns under them, which at this
   *  scale is the same picture and a great deal calmer. */
  fixed: boolean;
}

interface Formation {
  stations: Map<string, Station>;
  /** Each side's band radius, so the recap can trace the orbit itself in
   *  the faction's colour. Sprites are shaded hulls and a loud secondary
   *  trim can shout over the primary — the same trade the map makes — so
   *  the side's colour is stated once, on the path it holds. */
  bands: Array<{ fid: string; rx: number }>;
}

/**
 * Put every combatant in an orbit it keeps for the whole fight.
 *
 * Each faction takes its own altitude band and spreads its hulls across
 * an arc of it, so a viewer can follow one ship all the way through.
 * Stations drop to a low band of their own; cities are pinned to the
 * surface, because that is where cities are. Real orbital elements are
 * not recorded — the record keeps who shot whom, not ephemeris — so this
 * is declared, and declared once.
 */
function stationShips(frames: Frame[], participants: Participant[]): Formation {
  const order: string[] = [];
  const fidOf = new Map<string, string | null>();
  const kindOf = new Map<string, Kind>();
  const seen = new Set<string>();
  for (const f of frames) {
    for (const r of f.roster) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      order.push(r.id);
      fidOf.set(r.id, r.fid);
      kindOf.set(r.id, (r.kind as Kind) ?? 'ship');
    }
  }
  // Anything that was shot at, or did the shooting, but never appeared in
  // a roster. Battles recorded before settlements were entered in the
  // roster at all (0097) are full of these: the station everyone was
  // bombarding is a target id and nothing else, so the whole fleet
  // converged on a point with nothing drawn at it. The participant row
  // exists even for those — the recording pass has always written one for
  // every id it saw fire or take fire — so it can still be placed, named
  // where a name was captured, and given the right silhouette.
  const byId = new Map(participants.map(p => [p.ship_id, p]));
  for (const f of frames) {
    for (const sh of f.shot_log) {
      for (const id of [sh.a, sh.t]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        order.push(id);
        const p = byId.get(id);
        fidOf.set(id, p?.faction_id ?? null);
        const cls = (p?.ship_class ?? '').toLowerCase();
        kindOf.set(id, (p?.kind as Kind)
          ?? (cls === 'city' ? 'city' : cls === 'station' ? 'station'
              : iconClassOf(cls) ? 'ship' : 'station'));
      }
    }
  }
  // Biggest fleet takes the outer band, where the arc is longest and it
  // has the most room to spread; a side of three does not need it.
  //
  // Combatants with NO known owner do not get a band of their own. An old
  // record whose settlement never captured a faction would otherwise
  // invent a third side, push everyone else's orbit outward and shove the
  // real fleets off the canvas — a gap in the data quietly rearranging
  // the picture. They go in the low station band instead, which is where
  // an unowned installation belongs anyway.
  const sides = [...new Set(order.map(id => fidOf.get(id) ?? 'none'))]
    .filter(f => f !== 'none')
    .sort((a, b) =>
      order.filter(id => (fidOf.get(id) ?? 'none') === a).length
      - order.filter(id => (fidOf.get(id) ?? 'none') === b).length);
  const out = new Map<string, Station>();
  const bands: Formation['bands'] = [];

  sides.forEach((side, si) => {
    const mine = order.filter(id => (fidOf.get(id) ?? 'none') === side);
    // Where this side's arc is centred: the sides fall in beside each
    // other around the engagement bearing, not across the world from one
    // another.
    const centre = ENGAGEMENT_BEARING + (si - (sides.length - 1) / 2) * SIDE_SEP;
    const rx = BODY_R + BAND_0 + si * BAND_GAP;

    const hulls = mine.filter(id => kindOf.get(id) !== 'city');
    const cities = mine.filter(id => kindOf.get(id) === 'city');

    const lanes = hulls.length > SUB_BAND_MANY ? 3
      : hulls.length > SUB_BAND_MIN ? 2 : 1;
    const slots = Math.ceil(hulls.length / lanes);
    hulls.forEach((id, i) => {
      // Consecutive hulls go into DIFFERENT lanes, so neighbours are
      // separated radially and the arc only has to carry every Nth ship.
      const slot = Math.floor(i / lanes);
      const spread = slots <= 1 ? 0 : (slot / (slots - 1) - 0.5) * SIDE_ARC;
      const isStation = kindOf.get(id) === 'station';
      const lane = (i % lanes) * SUB_BAND;
      out.set(id, {
        kind: isStation ? 'station' : 'ship',
        // A station keeps station: low orbit, and out of the lane its
        // own fleet is flying.
        rx: isStation ? BODY_R + STATION_BAND : rx + lane,
        phase0: centre + spread,
        fixed: false,
      });
    });
    // Cities go on the globe, spaced across the face TOWARD the viewer
    // and keyed off the id so the same city is always in the same place.
    // Kept on the near hemisphere deliberately: a city on the far side
    // would be correct and invisible, and a settlement is usually what
    // the fight is about.
    cities.forEach((id, i) => {
      const spread = cities.length === 1 ? 0.5 : (i + 0.5) / cities.length;
      out.set(id, {
        kind: 'city',
        rx: BODY_R * 0.55,
        // 0.45..2.69 rad — the whole near face, never behind the limb.
        phase0: 0.45 + spread * 2.24 + ((hashStr(id) % 100) / 100 - 0.5) * 0.25,
        fixed: true,
      });
    });
    if (hulls.some(id => kindOf.get(id) !== 'station')) {
      bands.push({ fid: side, rx });
    }
  });

  // Whatever is left has no known owner: park it low, spread across the
  // engagement bearing so several unknowns do not stack on one point.
  const orphans = order.filter(id => !out.has(id));
  orphans.forEach((id, i) => {
    const spread = orphans.length === 1 ? 0 : (i / (orphans.length - 1) - 0.5) * 1.1;
    out.set(id, {
      kind: kindOf.get(id) === 'city' ? 'city' : 'station',
      rx: kindOf.get(id) === 'city' ? BODY_R * 0.55 : BODY_R + STATION_BAND,
      phase0: kindOf.get(id) === 'city'
        ? 0.45 + (i + 0.5) / Math.max(1, orphans.length) * 2.24
        : ENGAGEMENT_BEARING + spread,
      fixed: kindOf.get(id) === 'city',
    });
  });
  return { stations: out, bands };
}

/**
 * The visible parts of a shot, given that a world is in the way.
 *
 * This is the map's rule: combatFx's occludedByBody refuses to draw any
 * tracer whose line passes near the body it is fought around. A middle
 * version tried to be cleverer — it carried depth, and let a hull in
 * FRONT of the disc shoot across it, on the grounds that this view looks
 * down on the orbital plane at an angle so half the fleet really is
 * between you and the world. That is geometrically true and it looks
 * wrong: an opaque planet with a bolt drawn over its face reads as a shot
 * going THROUGH the planet, whichever side of it the shooter is on.
 *
 * So the silhouette wins, exactly as it does on the map, and the layout
 * carries the weight instead: sides sit in ADJACENT orbital slots, close
 * enough to engage across open space, so there is hardly ever anything to
 * hide. When there is, the impact still lands — the damage, the flare and
 * the blast are drawn from the record regardless of whether the line
 * itself was in view.
 *
 * Depth still decides what is drawn in front of what; see pointVisible.
 */
export function clipOutsideDisc(
  x1: number, y1: number,
  x2: number, y2: number,
  cx: number, cy: number, r: number,
): Array<[number, number, number, number]> {
  const dx = x2 - x1, dy = y2 - y1;
  const whole: Array<[number, number, number, number]> = [[x1, y1, x2, y2]];
  if (dx * dx + dy * dy < 1e-9) return [];
  const bFrom = 0, bTo = 1;

  // When is it inside the silhouette?
  const a = dx * dx + dy * dy;
  const fx = x1 - cx, fy = y1 - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return whole;                        // misses the disc
  const sq = Math.sqrt(disc);
  const dFrom = (-b - sq) / (2 * a);
  const dTo = (-b + sq) / (2 * a);

  // Hidden is the overlap of the two, on the segment itself.
  const hFrom = Math.max(0, bFrom, dFrom);
  const hTo = Math.min(1, bTo, dTo);
  if (hTo <= hFrom) return whole;                     // no overlap

  const at = (t: number): [number, number] => [x1 + dx * t, y1 + dy * t];
  const out: Array<[number, number, number, number]> = [];
  if (hFrom > 0.001) { const [ax, ay] = at(hFrom); out.push([x1, y1, ax, ay]); }
  if (hTo < 0.999) { const [bx, by] = at(hTo); out.push([bx, by, x2, y2]); }
  return out;
}

/** Is a single point in view, or is it behind the world? */
export function pointVisible(
  x: number, y: number, z: number, cx: number, cy: number, r: number,
): boolean {
  if (z >= 0) return true;
  return Math.hypot(x - cx, y - cy) > r;
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
  const formation = useMemo(
    () => stationShips(frames, d.participants), [frames, d.participants]);
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

  /**
   * Combatants that never appear in a roster.
   *
   * Battles recorded before settlements were entered in the roster (0097)
   * are full of these: the station a whole fleet was bombarding exists
   * only as a target id in the shot log. The participant row was always
   * written — the recording pass writes one for every id it sees fire or
   * take fire — so the hull can be reconstructed well enough to stand on
   * the board and be shot at, which is the difference between a recap
   * that reads and one where ten ships fire at nothing.
   *
   * No hp bar: per-tick health for these was never recorded, and a full
   * green bar would be a claim rather than a gap.
   */
  const phantoms = useMemo(() => {
    const inRoster = new Set<string>();
    for (const f of frames) for (const r of f.roster) inRoster.add(r.id);
    return d.participants
      .filter(p => !inRoster.has(p.ship_id))
      .map(p => ({
        diedTick: p.died_tick,
        row: {
          id: p.ship_id, fid: p.faction_id, cls: p.ship_class,
          name: p.ship_name, hp: 1, hpMax: null as number | null, dead: 0,
          kind: p.kind ?? ((p.ship_class ?? '').toLowerCase() === 'city' ? 'city' : 'station'),
        },
      }));
  }, [frames, d.participants]);

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
      const body = d.body;

      // ---- board state at this instant -----------------------------
      // Damage applied so far this beat, so a hull's bar drains as the
      // bolts reach it rather than snapping at the tick boundary.
      const beatMs = t * TICK_MS;
      // Each shot keeps its own clock. Seeded from shooter, target and
      // tick, so a replay is identical every time and one hull's volley
      // does not go off on the same frame as everybody else's.
      const shotClock = (sh: Frame['shot_log'][number], tick: number) => {
        const launch = ((hashStr(`${sh.a ?? ''}>${sh.t ?? ''}@${tick}`) % 997) / 997) * LAUNCH_SPREAD;
        return { launch, arriveMs: (launch + FLIGHT_FRAC) * TICK_MS };
      };
      /** When the shot that killed this hull actually lands. */
      const killTimes = new Map<string, number>();
      for (const sh of frame.shot_log) {
        if (sh.kill && sh.t) killTimes.set(sh.t, shotClock(sh, frame.tick).arriveMs);
      }
      const killMs = (id: string) =>
        killTimes.get(id) ?? (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;

      // Damage drains from the moment ITS OWN round lands, so a bar moves
      // with the hit that caused it rather than with the tick boundary.
      const landed = new Map<string, number>();
      for (const sh of frame.shot_log) {
        if (!sh.t || !sh.hit) continue;
        const k = Math.max(0, Math.min(1, (beatMs - shotClock(sh, frame.tick).arriveMs) / DRAIN_MS));
        if (k > 0) landed.set(sh.t, (landed.get(sh.t) ?? 0) + sh.dmg * k);
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
      // Phantoms carry a died_tick rather than a per-frame flag.
      for (const p of phantoms) {
        if (p.diedTick != null && frame.tick > p.diedTick) {
          deadBefore.set(p.row.id, Math.max(1, frame.tick - p.diedTick));
        }
      }
      // The board for this beat: the recorded roster plus anything that
      // was in the fight without ever being written into one.
      const board = [
        ...frame.roster,
        ...phantoms
          .filter(p => p.diedTick == null || frame.tick <= p.diedTick)
          .map(p => ({ ...p.row, dead: p.diedTick === frame.tick ? 1 : 0 })),
      ];

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
        const count = (id: string, fid: string | null) => {
          if (seen.has(id) || !fid) return;
          seen.add(id);
          const row = m.get(fid);
          if (row) row.alive++;
        };
        for (const f of frames) for (const r of f.roster) count(r.id, r.fid);
        // Committed comes from the participant rows, which include hulls
        // that never made it into a roster — so the alive tally has to as
        // well, or a side reads as 3/6 with nothing missing.
        for (const p of phantoms) count(p.row.id, p.row.fid);
        for (const id of deadBefore.keys()) {
          const owner = frames.flatMap(f => f.roster).find(r => r.id === id);
          const row = owner?.fid ? m.get(owner.fid) : null;
          if (row) { row.alive--; row.lost++; }
        }
        return [...m.values()];
      })();

      // ---- where everything is, right now ---------------------------
      const FALLBACK: Station = { kind: 'ship', rx: BODY_R + BAND_0, phase0: 0, fixed: false };
      const stOf = (id: string) => stations.get(id) ?? FALLBACK;
      const angOf = (id: string) => {
        const s = stOf(id);
        return s.fixed ? s.phase0 : s.phase0 + nowMs * ORBIT_RATE;
      };
      const posOf = (id: string) => {
        const s = stOf(id);
        const a = angOf(id);
        return { x: cx + Math.cos(a) * s.rx, y: cy + Math.sin(a) * s.rx * ORBIT_TILT };
      };
      /** Positive on the near side of the world, negative behind it. The
       *  view looks down on the orbital plane from slightly above, so the
       *  lower half of each ellipse is the half between you and the
       *  planet. */
      const depthOf = (id: string) => Math.sin(angOf(id));
      /** Prograde heading along the ellipse — a ship should be pointed
       *  the way it is actually travelling when it isn't shooting. */
      const tangentOf = (id: string) => {
        const a = angOf(id);
        return Math.atan2(Math.cos(a) * ORBIT_TILT, -Math.sin(a));
      };

      // Who each hull is shooting this beat.
      const aimOf = new Map<string, string>();
      for (const s of frame.shot_log) {
        if (s.a && s.t && !aimOf.has(s.a)) aimOf.set(s.a, s.t);
      }
      // Stations that fired at any point: a station with guns has a
      // Weapons module, and that is the one building level the record
      // can honestly infer rather than invent.
      const armedStations = new Set<string>();
      for (const f of frames) for (const s of f.shot_log) if (s.a) armedStations.add(s.a);

      /** Trace one faction's band. Split into the half behind the world
       *  and the half in front, drawn either side of the planet, so the
       *  orbit itself passes behind it. */
      const traceBand = (rx: number, color: string, front: boolean) => {
        g.save();
        g.globalAlpha = front ? 0.22 : 0.12;
        g.strokeStyle = color;
        g.lineWidth = 1.2;
        g.beginPath();
        g.ellipse(cx, cy, rx, rx * ORBIT_TILT, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
        g.stroke();
        g.restore();
      };

      // ---- one combatant --------------------------------------------
      // Shared by the behind-the-world pass and the in-front pass, so a
      // ship looks the same whichever side of the planet it is on — only
      // dimmer, and drawn earlier.
      const drawCombatant = (
        r: Frame['roster'][number], dim: number,
      ) => {
        const q = posOf(r.id);
        const meta = hulls.get(r.id);
        const col = colorOf(r.fid);
        const kind = (r.kind as Kind) ?? stOf(r.id).kind ?? 'ship';
        const dying = r.dead === 1;
        // A dying hull holds until the shot that kills it lands; after
        // that it is a blast, drawn with the weapons pass.
        if (dying && beatMs >= killMs(r.id)) return;

        const hp = Math.max(0, r.hp - (landed.get(r.id) ?? 0));
        const frac = r.hpMax ? Math.max(0, Math.min(1, hp / r.hpMax)) : 1;
        const size = kind === 'ship' ? iconSizeOf(r.cls ?? meta?.cls ?? null) : 34;

        g.save();
        g.globalAlpha = dim;

        if (kind === 'station') {
          // The game's own station rig — ring, hub and modules. Weapons
          // shows only on a station that actually fired.
          g.save();
          g.translate(q.x, q.y);
          g.scale(0.85, 0.85);
          drawStationStructure(g, {
            weaponsLevel: armedStations.has(r.id) ? 1 : 0,
            shipyardLevel: 0, labLevel: 0, thrustersLevel: 0,
            factionColor: col, builds: [], nowMs,
          });
          g.restore();
        } else if (kind === 'city') {
          g.save();
          g.translate(q.x, q.y);
          drawCityCluster(g, { population: 4 } as never, col);
          g.restore();
        } else {
          const target = aimOf.get(r.id);
          const heading = target && target !== r.id
            ? Math.atan2(posOf(target).y - q.y, posOf(target).x - q.x)
            : tangentOf(r.id);

          // Engine idle glow at the stern, exactly as the map does it —
          // parked fleets that don't glow read as cardboard.
          const pulse = 0.6 + 0.4 * Math.sin(nowMs / 420 + ((hashStr(r.id) % 1000) / 1000) * Math.PI * 2);
          const gx = q.x - Math.cos(heading) * size * 0.46;
          const gy = q.y - Math.sin(heading) * size * 0.46;
          const gr = Math.max(2.5, size * 0.2);
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.fillStyle = `rgba(255, 158, 74, ${(0.16 * pulse * dim).toFixed(3)})`;
          g.beginPath(); g.arc(gx, gy, gr, 0, Math.PI * 2); g.fill();
          g.fillStyle = `rgba(255, 220, 168, ${(0.28 * pulse * dim).toFixed(3)})`;
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
            // fallback the map uses: a filled dot in the owner's colour,
            // so the board is never empty and never mislabelled.
            g.fillStyle = col;
            g.beginPath(); g.arc(q.x, q.y, size * 0.3, 0, Math.PI * 2); g.fill();
          }
        }

        // A combatant in trouble looks like it. Same fires and smoke the
        // map lights a battered ship with, severity scaled off how far
        // its health has actually fallen.
        if (frac < 0.6) {
          drawBurn(g, q.x, q.y, size * 0.5,
            Math.min(1, (0.6 - frac) / 0.5) * dim, nowMs, hashStr(r.id));
        }

        // Damage as the map's own hp bar — same geometry, same three
        // colours. An earlier cut ringed each hull instead, and a ring in
        // bright green around a green ship read as a shield bubble, not
        // as health.
        if (frac < 0.999) {
          const barW = Math.max(18, size * 1.1), barH = 3;
          const bx = q.x - barW / 2, by = q.y + size * 0.62;
          g.fillStyle = '#2a3d50';
          g.fillRect(bx, by, barW, barH);
          g.fillStyle = frac > 0.5 ? '#6ee7b7' : frac > 0.25 ? '#ffb84d' : '#ff5e5e';
          g.fillRect(bx, by, barW * frac, barH);
        }

        // Only name what the eye can follow. Eighteen labels is a wall of
        // text — the big hulls, every settlement (there are few and they
        // are landmarks) and anything dying carry theirs. The label hangs
        // radially outward, away from the world, so it never lies across
        // the orbit it belongs to.
        // Destroyers, every settlement (there are few and they are
        // landmarks) and anything dying. Labelling frigates too turned the
        // near limb into a stack of overlapping names.
        if (size >= 34 || kind !== 'ship' || dying) {
          const a = angOf(r.id);
          const outX = Math.cos(a) >= 0 ? 1 : -1;
          g.fillStyle = dying ? '#ff8a80' : (kind === 'ship' ? '#cfe0ee' : '#e2d7b8');
          g.font = '10px system-ui';
          g.textAlign = outX > 0 ? 'left' : 'right';
          // A battle recorded before settlements were rostered has no
          // name for one, and a raw row id is worse than the plain word
          // for what it is.
          const label = r.name ?? (kind === 'ship' ? r.id : kind);
          g.fillText(label, q.x + outX * (size * 0.5 + 10), q.y + 3);
        }
        g.restore();
      };

      // Which side of the world each living combatant is on this frame.
      const living = board.filter(r => !deadBefore.has(r.id));
      const behind = living.filter(r => stOf(r.id).kind !== 'city' && depthOf(r.id) < 0);
      const infront = living.filter(r => stOf(r.id).kind !== 'city' && depthOf(r.id) >= 0);
      const surface = living.filter(r => stOf(r.id).kind === 'city');

      // ---- wrecks ----------------------------------------------------
      // A hull that died earlier stays on the board: without it the
      // roster silently shrinks and a viewer cannot tell a loss from a
      // ship that stopped being drawn. Wrecks keep orbiting — they are
      // still up there. Held at k=0.5 so they never fade out of a recap
      // that may run for a hundred beats.
      const drawWreck = (id: string, ago: number) => {
        const q = posOf(id);
        drawWreckShards(g, q.x, q.y, Math.max(6, iconSizeOf(hulls.get(id)?.cls ?? null) * 0.5),
          Math.min(0.5, ago / 40), id, nowMs);
      };

      // ---- BEHIND THE WORLD ------------------------------------------
      for (const b of formation.bands) traceBand(b.rx, colorOf(b.fid), false);
      for (const [id, ago] of deadBefore) if (depthOf(id) < 0) drawWreck(id, ago);
      for (const r of behind) drawCombatant(r, 0.55);

      // ---- the world being fought over -------------------------------
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

      // ---- ON and IN FRONT OF THE WORLD -------------------------------
      for (const r of surface) drawCombatant(r, 1);
      for (const b of formation.bands) traceBand(b.rx, colorOf(b.fid), true);
      for (const [id, ago] of deadBefore) if (depthOf(id) >= 0) drawWreck(id, ago);
      for (const r of infront) drawCombatant(r, 1);

      g.fillStyle = '#9dbdd8';
      g.font = '13px system-ui'; g.textAlign = 'left';
      g.fillText(d.battle.body_name ?? 'deep space', 12, H - 14);

      // ---- weapons ---------------------------------------------------
      // Bolts, muzzle flashes and impacts all blend additively, the way
      // the map's do. Timing is REAL milliseconds inside the beat, not a
      // fraction of it: a slow-motion recap should still show a shell
      // landing at the speed a shell lands.
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const s of frame.shot_log) {
        if (!s.a || !s.t) continue;
        const w = shotClock(s, frame.tick);
        // Not fired yet, or long since buried.
        if (t < w.launch) continue;
        const flown = Math.min(1, (t - w.launch) / FLIGHT_FRAC);
        const sinceHit = beatMs - w.arriveMs;
        if (sinceHit > BURY_MS) continue;

        const from = posOf(s.a), to = posOf(s.t);
        const shooter = board.find(r => r.id === s.a);
        const col = colorOf(shooter?.fid ?? null);
        // The weapon this volley was actually fired with, recorded per
        // shot (0097). Falls back to the hull's loadout for battles taped
        // before that, and to kinetic for anything older still.
        const energy = (s.e != null ? s.e >= 0.5 : (hulls.get(s.a)?.energy ?? false));
        const ang = Math.atan2(to.y - from.y, to.x - from.x);

        // A miss is a bolt that goes past, not a bolt in another colour:
        // it flies wide and keeps going, which is what a miss looks like.
        const wide = s.hit ? 0 : 0.13;
        const ex = from.x + (to.x - from.x) * flown + Math.cos(ang + Math.PI / 2) * wide * 60 * flown;
        const ey = from.y + (to.y - from.y) * flown + Math.sin(ang + Math.PI / 2) * wide * 60 * flown;

        // A kinetic round is a SHELL, and a shell is a streak that crosses
        // the gap — not a line that grows out of the muzzle. Drawing it
        // from the shooter to the moving head is what made a board of
        // kinetic fire look like a field of long lasers. Hard-capped, so
        // a long-range shot cannot stretch back into beam territory.
        //
        // Energy keeps the full run, because a lance IS the whole line —
        // that is the difference between the two weapons, and it is the
        // same call the map makes.
        const reach = Math.hypot(ex - from.x, ey - from.y);
        const gap = Math.hypot(to.x - from.x, to.y - from.y);
        const streak = Math.min(reach, Math.max(14, Math.min(30, gap * 0.22)));

        // Once it lands, the round goes INTO the hull: the head stops and
        // the tail runs on to meet it. Held at the target instead, the
        // bolt sat on the ship's nose for the rest of the beat.
        const bury = sinceHit > 0 ? Math.min(1, sinceHit / BURY_MS) : 0;
        const alpha = (s.hit ? 0.9 : 0.4) * (energy ? 1 - bury : 1);
        const tailBack = energy ? reach : streak * (1 - bury);
        if (tailBack <= 0.5) continue;
        const tailX = ex - Math.cos(ang) * tailBack;
        const tailY = ey - Math.sin(ang) * tailBack;

        // Never across the world. This is the map's rule (combatFx's
        // occludedByBody drops any tracer whose line passes near the body
        // it is fought around) and it is applied here for the reason it
        // exists there: a bolt drawn over a planet's face reads as going
        // THROUGH the planet, whichever side of it the shooter is on.
        // The sides sit in adjacent orbital slots precisely so this
        // almost never has anything to hide.
        const pieces = clipOutsideDisc(tailX, tailY, ex, ey, cx, cy, bodyR);
        pieces.forEach(([ax, ay, bx, by], pi) => {
          // Only the last piece carries the real leading edge; the others
          // end where the world cut them, and a bright impact dot there
          // is a flash on empty limb.
          drawBolt(g, ax, ay, bx, by, col, alpha, energy, pi === pieces.length - 1);
        });

        // Muzzle flash for the first moments of THIS volley — only if the
        // shooter itself is in view.
        const sinceFire = beatMs - w.launch * TICK_MS;
        if (sinceFire >= 0 && sinceFire < 130
            && pointVisible(from.x, from.y, depthOf(s.a), cx, cy, bodyR)) {
          drawMuzzleFlash(g, from.x, from.y, ang, energy ? ENERGY_COLOR : col,
            (1 - sinceFire / 130) * 0.9, iconSizeOf(shooter?.cls ?? null) / 20);
        }

        // Impact. A hit the target survives flares its shields; a hit
        // that kills it goes to the blast pass below.
        if (s.hit && !s.kill && sinceHit >= 0 && sinceHit < 260
            && pointVisible(to.x, to.y, depthOf(s.t), cx, cy, bodyR)) {
          const tgt = board.find(r => r.id === s.t);
          drawShieldFlare(g, to.x, to.y, iconSizeOf(tgt?.cls ?? null) * 0.6,
            ang + Math.PI, (1 - sinceHit / 260) * 0.8, energy ? '#bfe9ff' : '#ffd08a');
        }
      }

      // Deaths: the real blast and the real debris, run at real speed
      // from the instant the killing shot lands — not from a beat-wide
      // average, so a hull that dies to the last volley of a tick goes up
      // when that volley arrives.
      for (const r of board) {
        if (r.dead !== 1 || deadBefore.has(r.id)) continue;
        const sinceMs = beatMs - killMs(r.id);
        if (sinceMs < 0) continue;
        const q = posOf(r.id);
        if (!pointVisible(q.x, q.y, depthOf(r.id), cx, cy, bodyR)) continue;
        const scale = ((r.kind as Kind) ?? 'ship') === 'ship'
          ? iconSizeOf(r.cls ?? null) / 24 : 1.6;   // a station goes up bigger
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
        // Off this round's own arrival, so the number appears with the
        // hit that produced it and not with the beat.
        const sinceMs = beatMs - shotClock(s, frame.tick).arriveMs;
        if (sinceMs < 0 || sinceMs > 900) continue;
        const n = stack.get(s.t) ?? 0;
        stack.set(s.t, n + 1);
        const to = posOf(s.t);
        const rise = (sinceMs / 900) * 26;
        const alpha = 1 - (sinceMs / 900) ** 2;
        g.fillStyle = `rgba(255, 176, 120, ${alpha.toFixed(3)})`;
        g.font = `${s.kill ? 'bold ' : ''}11px system-ui`;
        // The killing blow's number drops BELOW the target: above it is
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
      for (const r of board) {
        if (r.dead !== 1 || deadBefore.has(r.id)) continue;
        const sinceMs = beatMs - killMs(r.id);
        if (sinceMs < 120 || sinceMs > 1600) continue;
        const killer = killerOf.get(r.id);
        const q = posOf(r.id);
        const alpha = Math.min(1, (sinceMs - 120) / 220) * (1 - Math.max(0, (sinceMs - 1100) / 500));
        const head = `${r.name ?? r.id} lost`;
        const sub = killer ? `to ${killer}` : '';
        // A backing plate, because a kill in a crowded orbit lands on top
        // of the labels either side of it — and the one line a viewer
        // most needs to read is the one that must not be legible only
        // when the formation happens to be sparse there.
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
  }, [frames, stations, formation, colorOf, trimOf, hulls, killerOf, phantoms, stars,
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
