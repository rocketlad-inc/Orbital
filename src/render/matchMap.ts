// ============================================================
// The match film, on the map.
//
// A whole match is a MAP story — who owns which worlds, where the
// fleets are massing, when the system changes colour — and the map is
// the representation players already read. So this replays the game on
// the game's own terms: the planets as their map textures, ships as
// their map icons, territory as colour, with a camera that pans and
// zooms to the tick's event the way the 2D theatre recap does.
//
// It satisfies the same ReplayStage contract as the 3D stage, so the
// player, the API, the streaming and the event log are untouched.
// Nothing here needs three.js, so the chunk stays small.
// ============================================================

import { getPlanetTexture, getTerraformedTexture, hashStr, mulberry32 }
  from './planetTexture';
import {
  BODY_LABEL_ROW_HEIGHT, bodyLabelAlwaysOn, clearCanvas, drawBody, drawOrbit,
  drawSettlement, drawShip, drawStarfield, drawSystemRegions,
  drawTorchTrajectory, drawTransitShip, generateStarfield, planBodyLabels,
  shipLane, shipLaneOnly, MOON_ORBIT_MIN_PARENT_PX,
} from './mapRenderer';
import type { ShipFormation } from './mapRenderer';
import {
  drawDetonations, drawEngagementFire, drawWrecks, enqueueDetonation, spawnWreck,
} from './combatFx';
import type { RenderContext, StarfieldCache } from './mapRenderer';
import { flushLabels, resetReservations } from './labelLayer';
import { computeSystemRegions } from './systemRegions';
import { bodyPosition } from '../physics/orbitalMechanics';
import { withOpacity } from './colors';
import {
  adaptBodies, adaptFactions, adaptSettlements, adaptShips,
} from './matchAdapter';
import type { TransitLeg } from './matchAdapter';
import type { Body as GameBody, Ship as GameShip } from '../types';
import {
  MatchTimeline, mineEvents, bareId,
  type MatchSummary, type SnapshotRow, type ReplayStage, type MatchEvent,
  type MatchWorld,
} from './matchWorld';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

const NEUTRAL = '#8a9fb3';
const CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
const iconClassOf = (c: string | null): ShipIconClass =>
  (CLASSES.includes((c ?? '').toLowerCase())
    ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

type Body = MatchSummary['bodies'][number];

export function createMatchMap(
  summary: MatchSummary, canvas: HTMLCanvasElement,
): ReplayStage & { _shots: () => unknown[];
  _audit: (tick: number, frac?: number) => unknown[] } {
  const ctx = canvas.getContext('2d')!;
  let W = canvas.width || 1280, H = canvas.height || 720, DPR = 1;

  const bodies = summary.bodies;
  const byId = new Map(bodies.map(b => [b.id, b]));
  const byIdRaw = byId;
  const faction = (fid: string | null) => summary.factions.find(f => f.id === fid);
  const colorOf = (fid: string | null) => faction(fid)?.color || NEUTRAL;
  /**
   * An empire's colour, lifted to a luminance that survives being read
   * as small text over a territory band.
   *
   * Measured on a shipped frame: the NEPTUNE label came out at 1.29:1
   * against the band it crossed, because a hue chosen to look right as a
   * 10px roster swatch is not automatically legible as 11px type on a
   * saturated ground. Identity is kept; the value is raised until it
   * reads.
   */
  const liftedOf = (fid: string | null) => {
    const h = (colorOf(fid) || NEUTRAL).replace('#', '');
    const n = h.length === 3
      ? h.split('').map(c => parseInt(c + c, 16))
      : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    if (n.some(v => Number.isNaN(v))) return 'rgba(206,222,238,0.95)';
    const lum = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
    const FLOOR = 168;
    if (lum >= FLOOR) return `rgb(${n[0]},${n[1]},${n[2]})`;
    const k = Math.min(2.6, FLOOR / Math.max(1, lum));
    const lift = (v: number) => Math.round(Math.min(255, 40 + v * k));
    return `rgb(${lift(n[0])},${lift(n[1])},${lift(n[2])})`;
  };
  const color2Of = (fid: string | null) =>
    faction(fid)?.color2 || faction(fid)?.color || NEUTRAL;

  // ---- layout ----------------------------------------------------------
  //
  // Map units. Orbits are log-compressed — real proportions are empty —
  // and every orbit clears its parent's disc plus a gap, so moons never
  // sit inside their planet.
  // THE GAME'S OWN BODIES. Adapted once -- orbit radii, periods and
  // angles are the record, so the recap's worlds move exactly where the
  // game's do rather than along a scale this file invented.
  const gameBodies = adaptBodies(summary);
  const gameFactions = adaptFactions(summary);
  const byGame = new Map(gameBodies.map(b => [b.id, b]));
  let starfield: StarfieldCache | null = null;
  const spawnedWrecks = new Set<string>();
  let lastDeathTick = -1;

  /** Radii in WORLD units, which is what the camera fitters want. */
  const bodyR = new Map<string, number>(gameBodies.map(b => [b.id, b.radius]));
  for (const b of bodies) {
    bodyR.set(b.id, b.type === 'star' ? 26
      : Math.max(4, Math.min(18, 3 + (Number(b.radius) || 1) * 2.2)));
  }
  // MOONS ARE NOT PLANETS. One log curve for every orbit put Luna's ring
  // at 198 map units against Earth's own 386 around the sun, and
  // Callisto at 282 against Jupiter's 445 -- moon systems swinging out
  // across neighbouring tracks. Moons now sit in a compact rank-ordered
  // stack hugging their parent (order preserved, distance not), and
  // planets get a roomier curve so the inner system is not cramped.
  const starId = bodies.find(b => b.type === 'star')?.id ?? '';

  /**
   * Where a world is, in game world units.
   *
   * This used to be a bespoke layout: a sqrt orbit scale, a moon budget
   * that fitted satellites into the nearest orbital gap, and a hand-rolled
   * parent-recursive position. All of it existed only because the recap
   * was drawing its own map. The game already solves this, and solving it
   * a second way is what put Jupiter's moons through the asteroid belt.
   */
  const pos = (id: string, t: number): { x: number; y: number } => {
    const b = byGame.get(id);
    if (!b) return { x: 0, y: 0 };
    return bodyPosition(b, t, gameBodies);
  };

  const drawableAt = (b: Body, tick: number) =>
    (b.type === 'star' || (!!b.parent_body_id && !!b.orbit_period))
    && !(b.destroyed_at_tick != null && tick >= b.destroyed_at_tick);

  // The political wash used to be built here: orbital lanes derived from
  // this file's own compressed radii, with hand-tuned widths, an
  // ownership vote per lane and a contested state. All of it is
  // computeSystemRegions() in the game, which is where the rule actually
  // lives -- and the reason the first attempt came out as a rainbow
  // donut was that it copied the game's constants into a layout with a
  // different scale.

  // ---- data ------------------------------------------------------------
  const timeline = new MatchTimeline();
  let events: MatchEvent[] = [];
  /**
   * A SCENE, not a slot.
   *
   * Shots used to be ten-tick windows on a fixed grid, and the director
   * only chose what to point at inside each one. That is a metronome,
   * not a director: a six-tick battle between twenty-five hulls got
   * exactly as much film as six ticks of nothing, and a fight that ran
   * thirty ticks was chopped into three unrelated shots. A scene takes
   * its length from the thing it is about, and carries its own pace.
   */
  type Shot = {
    from: number; to: number;
    bodyId: string | null;
    /** Why this beat won the screen. */
    weight: number;
    /** Seconds of film per tick: the director controls TIME as well. */
    rate: number;
    note: string;
    /** Hulls present at the height of it, and hulls lost, where it applies. */
    hulls?: number;
    lost?: number;
    /** The two largest empires present, at the height of it. */
    sides?: string[];
  };
  let shots: Shot[] = [];

  /**
   * Layout audit. Off unless a harness turns it on, and it only records
   * what was already computed, so it costs nothing in the product. The
   * point is to answer "does anything overlap?" by measuring the boxes
   * the renderer actually drew, over every tick, rather than by looking
   * at a handful of frames and hoping they were representative.
   */
  type DebugRect = { kind: string; x: number; y: number;
    w: number; h: number; text: string };
  let debugRects: DebugRect[] | null = null;
  const note = (kind: string, x: number, y: number,
                w: number, h: number, text = '') => {
    if (debugRects) debugRects.push({ kind, x, y, w, h, text });
  };
  /** Scraps shorter than half this are folded into a neighbour. */
  const MIN_SHOT_TICKS = 6;
  /** Seconds per tick across a quiet stretch -- a brisk clip. */
  const FILLER_RATE = 0.3;
  const MAX_RATE = 2.4;
  /** Screen time a scene gets for merely mattering, plus what weight buys. */
  const SCENE_BASE_SECONDS = 6;
  const SCENE_SPREAD_SECONDS = 17;
  /** No single scene may run away with the film. */
  const MAX_SCENE_SECONDS = 24;
  /** A quiet stretch is a breath, not an interlude. */
  const FILLER_MAX_SECONDS = 9;
  /** However brisk the pace, a scene must be long enough to read. */
  const MIN_SCENE_SECONDS = 2.5;
  /** How many fleet plates one frame may carry before it stops reading. */
  // THE GAME'S OWN SPRITE-SIZE RAMP. A hull drawn at full size whatever
  // the zoom is bigger than the world it orbits: at Mars the ring of
  // sprites swallowed the planet, both moon orbits and all three names.
  // MapCanvas ramps hull size with how many pixels the anchoring world
  // actually occupies, so a system grows its ships in as you dive toward
  // it instead of popping a wall of full-size hulls.
  const ORBIT_SHIP_MIN_SCALE = 0.5;
  const SPRITE_FULL_PX = 34;
  const TRANSIT_SHIP_MIN_SIZE = 0.5;
  const TRANSIT_FULL_CAM_SCALE = 0.5;
  const TRANSIT_MIN_CAM_SCALE = 0.0012;
  /** Angular span a whole engagement occupies -- about 86 degrees. */
  const BATTLE_SECTOR = 1.5;

  /** How many ticks a crossing is shown flying. */
  const TRANSIT_TICKS = 4;
  const MAX_CHIPS = 14;
  /** How many courses may cross one frame before they become weather. */
  const MAX_TRANSITS = 6;
  /** A shot with fewer worlds than this in it is a shot of nothing. */
  const MIN_BODIES_IN_SHOT = 4;
  /** Nothing is drawn with its top edge inside this margin. */
  const TOP_SAFE = 26;
  /**
   * Standings over the whole match, computed once when rows arrive.
   *
   * Rank changes and eliminations were happening silently -- the panel
   * simply re-sorted and a row greyed out -- so the two most dramatic
   * things in a campaign passed unmarked. Precomputing is also what lets
   * the stockpile bars share ONE scale: normalised per row they were
   * every bar full, which is worse than no bar.
   */
  const rankAt = new Map<number, Map<string, number>>();
  const elimAt = new Map<string, number>();
  /** Worlds changing hands, per tick: the campaign's real headlines. */
  const captureAt = new Map<number, Array<{ body: string; from: string | null;
    to: string | null }>>();
  const leadAt = new Map<number, string>();
  let stockMax = 1;
  /** Ticks on which at least one hull changes world, and where from. */
  /**
   * Hulls that stop existing, and the world they were at when they did.
   *
   * The record has no death event -- a lost ship is simply absent from
   * the next tick -- so a loss reached the film only as an orange ring
   * pulsing at the body. The game already knows how to end a ship: it
   * detonates, then leaves wreckage tumbling for WRECK_LIFE_TICKS, which
   * is six ticks, expiring on the GAME clock so it survives the film's
   * variable pacing.
   */
  const deathAt = new Map<number, Array<{ id: string; body: string }>>();
  const transitAt = new Map<number, Array<{ id: string; from: string; to: string;
    fid: string | null; cls: string; iv: ShipIconVariant }>>();
  const rebuildTransits = () => {
    transitAt.clear();
    deathAt.clear();
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    let prev = timeline.worldAt(lo);
    for (let t = lo + 1; t <= hi; t++) {
      const now = timeline.worldAt(t);
      const moves: Array<{ id: string; from: string; to: string;
        fid: string | null; cls: string; iv: ShipIconVariant }> = [];
      for (const [id, sh] of now.ships) {
        const was = prev.ships.get(id);
        if (!was || !was.parent || !sh.parent || was.parent === sh.parent) continue;
        moves.push({ id, from: was.parent, to: sh.parent,
          fid: sh.fid, cls: sh.cls, iv: sh.iv });
      }
      const gone: Array<{ id: string; body: string }> = [];
      for (const [id, was] of prev.ships) {
        if (now.ships.has(id) || !was.parent) continue;
        gone.push({ id, body: was.parent });
      }
      if (gone.length) deathAt.set(t, gone);
      if (moves.length) transitAt.set(t - 1, moves);
      prev = now;
    }
  };

  const rebuildStandings = () => {
    rankAt.clear(); elimAt.clear(); captureAt.clear(); leadAt.clear();
    stockMax = 1;
    const ownerPrev = new Map<string, string | null>();
    let leaderPrev: string | null = null;
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    const alive = new Set<string>();
    for (let t = lo; t <= hi; t++) {
      const w = timeline.worldAt(t);
      const worlds = new Map<string, number>();
      for (const st of w.stls.values()) {
        if (st.fid) worlds.set(st.fid, (worlds.get(st.fid) ?? 0) + 1);
      }
      const fleets = new Map<string, number>();
      for (const sh of w.ships.values()) {
        const k = sh.fid ?? 'n'; fleets.set(k, (fleets.get(k) ?? 0) + 1);
      }
      for (const v of w.stock.values()) {
        for (const n of v) stockMax = Math.max(stockMax, n || 0);
      }
      const order = [...summary.factions].sort((x, y) =>
        (worlds.get(y.id) ?? 0) - (worlds.get(x.id) ?? 0)
        || (fleets.get(y.id) ?? 0) - (fleets.get(x.id) ?? 0));
      const m = new Map<string, number>();
      order.forEach((f, i) => m.set(f.id, i + 1));
      rankAt.set(t, m);

      // Worlds changing hands. A capture is the single most captionable
      // thing a campaign does, and it was invisible: the film cut to a
      // world and told you who owned it, never that it had just fallen.
      const ownerNow = new Map<string, string | null>();
      for (const st of w.stls.values()) if (st.fid) ownerNow.set(st.body, st.fid);
      for (const [body, to] of ownerNow) {
        const from = ownerPrev.get(body) ?? null;
        if (from !== to) {
          if (!captureAt.has(t)) captureAt.set(t, []);
          captureAt.get(t)!.push({ body, from, to });
        }
      }
      for (const [body, from] of ownerPrev) {
        if (!ownerNow.has(body) && from) {
          if (!captureAt.has(t)) captureAt.set(t, []);
          captureAt.get(t)!.push({ body, from, to: null });
        }
      }
      ownerPrev.clear();
      for (const [k, v] of ownerNow) ownerPrev.set(k, v);

      const leadNow = order[0]?.id ?? null;
      if (leadNow && leadNow !== leaderPrev && (worlds.get(leadNow) ?? 0) > 0) {
        leadAt.set(t, leadNow);
        leaderPrev = leadNow;
      }
      for (const f of summary.factions) {
        const has = (worlds.get(f.id) ?? 0) + (fleets.get(f.id) ?? 0) > 0;
        if (has) alive.add(f.id);
        else if (alive.has(f.id) && !elimAt.has(f.id)) elimAt.set(f.id, t);
      }
    }
  };

  /**
   * THE DIRECTOR.
   *
   * Two passes. First it asks what actually happened and turns each
   * answer into a candidate scene that knows its own span: battles at
   * one world merge across the ticks they run, so a long siege is one
   * held shot rather than three; a world changing hands is a scene; a
   * bill landing is a scene. Then the candidates compete for the reel,
   * heaviest first, and the ticks nobody claimed become wide shots of
   * the system -- the honest framing for a stretch where the news is
   * that fleets are moving and yards are building.
   *
   * Weight is measured, not assumed: hulls actually present at the
   * height of the fight, and hulls that died in it.
   */
  const rebuildShots = () => {
    events = mineEvents(timeline.rows, summary);
    shots = [];
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    if (hi < lo) return;
    const cands: Shot[] = [];

    // --- battles at one world, merged into one engagement --------------
    const spansOf = new Map<string, Array<[number, number]>>();
    for (const b of summary.battles) {
      if (!b.body_id || !byId.has(b.body_id)) continue;
      const arr = spansOf.get(b.body_id) ?? [];
      arr.push([b.started_tick, b.ended_tick ?? b.started_tick]);
      spansOf.set(b.body_id, arr);
    }
    for (const [body, spans] of spansOf) {
      spans.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      let cur: [number, number] = [spans[0][0], spans[0][1]];
      for (let i = 1; i < spans.length; i++) {
        // Two ticks apart still reads as one fight, not two.
        if (spans[i][0] <= cur[1] + 2) cur[1] = Math.max(cur[1], spans[i][1]);
        else { merged.push(cur); cur = [spans[i][0], spans[i][1]]; }
      }
      merged.push(cur);
      for (const [s0, e0] of merged) {
        if (!drawableAt(byId.get(body)!, s0)) continue;
        // How big was it, really? Count hulls present at the height of
        // it rather than trusting that a battle row means a battle.
        let peak = 0;
        let sides: string[] = [];
        const step = Math.max(1, Math.floor((e0 - s0) / 4));
        for (let t = s0; t <= e0; t += step) {
          let n = 0;
          const per = new Map<string, number>();
          for (const sh of timeline.worldAt(t).ships.values()) {
            if (sh.parent !== body) continue;
            n++;
            if (sh.fid) per.set(sh.fid, (per.get(sh.fid) ?? 0) + 1);
          }
          if (n > peak) {
            peak = n;
            // Who was actually there in force at the height of it. A
            // battle captioned as pure hull arithmetic -- "20 hulls
            // engaged, 8 lost" -- tells a viewer nothing about the
            // balance of power, which is the whole reason to watch.
            sides = [...per.entries()].sort((x, y) => y[1] - x[1])
              .slice(0, 2).map(e => e[0]);
          }
        }
        let lost = 0;
        for (const ev of events) {
          if (ev.kind === 'loss' && ev.bodyId === body
            && ev.tick >= s0 && ev.tick <= e0) lost += ev.count ?? 1;
        }
        const span = e0 - s0 + 1;
        cands.push({ from: s0, to: e0 + 1, bodyId: body,
          weight: peak * 2 + lost * 6 + span * 2, rate: 0,
          hulls: peak, lost, sides, note: 'battle' });
      }
    }

    // --- a world changing hands ----------------------------------------
    for (const [t, list] of captureAt) {
      for (const c of list) {
        if (!byId.has(c.body) || !drawableAt(byId.get(c.body)!, t)) continue;
        cands.push({ from: t - 1, to: t + 3, bodyId: c.body,
          weight: 120, rate: 0, note: c.to ? 'capture' : 'driven off' });
      }
    }

    // --- a bill landing belongs to nowhere: hold the system ------------
    for (const bill of summary.senate ?? []) {
      const at = bill.resolved_at_tick;
      if (at == null) continue;
      cands.push({ from: at - 1, to: at + 3, bodyId: null,
        weight: 70, rate: 0, note: 'senate' });
    }

    // --- the heaviest beat owns the tick --------------------------------
    const N = hi - lo + 1;
    const owner: number[] = new Array(N).fill(-1);
    cands.sort((a, b) => b.weight - a.weight);
    cands.forEach((c, i) => {
      for (let t = Math.max(lo, c.from); t < Math.min(hi + 1, c.to); t++) {
        if (owner[t - lo] < 0) owner[t - lo] = i;
      }
    });

    // --- runs of one owner become scenes; unclaimed ticks go wide -------
    let i0 = 0;
    while (i0 < N) {
      let i1 = i0;
      while (i1 + 1 < N && owner[i1 + 1] === owner[i0]) i1++;
      const who = owner[i0];
      const from = lo + i0, to = lo + i1 + 1;
      if (who < 0) {
        let moves = 0;
        for (let t = from; t < to; t++) moves += transitAt.get(t)?.length ?? 0;
        shots.push({ from, to, bodyId: null, weight: 0, rate: 0,
          note: moves >= (to - from) ? 'fleets under way' : 'the system builds' });
      } else {
        shots.push({ ...cands[who], from, to });
      }
      i0 = i1 + 1;
    }

    // --- fold away scraps ------------------------------------------------
    // A one-tick scene is a flicker, not a shot: absorb anything too
    // short into its weightier neighbour.
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].to - shots[i].from >= MIN_SHOT_TICKS / 2) continue;
      const prev = shots[i - 1], next = shots[i + 1];
      if (prev && (!next || prev.weight >= next.weight)) {
        prev.to = shots[i].to; shots.splice(i, 1);
      } else if (next) {
        next.from = shots[i].from; shots.splice(i, 1);
      }
    }
    // Neighbouring scenes about the same subject are one scene.
    for (let i = shots.length - 1; i > 0; i--) {
      const a = shots[i - 1], b = shots[i];
      if (a.bodyId === b.bodyId) {
        a.to = b.to; a.weight = Math.max(a.weight, b.weight);
        shots.splice(i, 1);
      }
    }

    // --- pace: the big moments get the seconds ---------------------------
    // Film time is the director's other lever, and the one that was
    // missing entirely: at a flat second per tick, a siege and a lull
    // were weighted identically by the clock no matter how well the
    // camera was aimed.
    // BUDGET SECONDS, THEN DERIVE THE RATE -- not the other way round.
    //
    // Setting a per-tick rate from weight paid a long battle twice: once
    // for being important and again for being long. The Mars engagement
    // ran 55 ticks at 1.7s each, so ONE held shot took ninety-three
    // seconds -- 27% of the whole film on a single frame of reference.
    // What a scene actually needs is enough SCREEN TIME to register;
    // whether that is spent slowly over four ticks or briskly over fifty
    // is a consequence, not the goal.
    const peakW = Math.max(1, ...shots.map(x => x.weight));
    for (const sh of shots) {
      const span = Math.max(1, sh.to - sh.from);
      let secs: number;
      if (sh.weight <= 0) {
        secs = Math.min(FILLER_MAX_SECONDS, span * FILLER_RATE);
      } else {
        secs = SCENE_BASE_SECONDS
          + SCENE_SPREAD_SECONDS * Math.sqrt(sh.weight / peakW);
      }
      // A scene too short to read is wasted film; a scene long enough to
      // outstay the match is worse.
      secs = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, secs));
      sh.rate = Math.min(MAX_RATE, Math.max(0.18, secs / span));
    }
  };

  /** Seconds of film per tick at this point in the match. */
  const rateAt = (tick: number) => {
    if (!shots.length) rebuildShots();
    const sh = shots.find(x => tick >= x.from && tick < x.to);
    return sh ? sh.rate : 1;
  };

  /**
   * What the senate is doing at a tick.
   *
   * A bill runs proposed -> debating -> voting -> resolved, and every one
   * of those is a campaign beat the film had no idea about. Vote weight
   * comes from worlds held, so the chamber is also a second scoreboard.
   */
  type SenatePhase = 'debate' | 'vote' | 'resolved' | null;
  const senateAt = (tick: number) => {
    const bills = summary.senate ?? [];
    for (const b of bills) {
      const prop = b.proposed_at_tick ?? 0;
      const opens = b.vote_opens_at_tick ?? prop;
      const closes = b.vote_closes_at_tick ?? opens;
      if (tick >= prop && tick < opens) return { bill: b, phase: 'debate' as SenatePhase };
      if (tick >= opens && tick <= closes) return { bill: b, phase: 'vote' as SenatePhase };
      const res = b.resolved_at_tick;
      if (res != null && tick > res && tick <= res + 6) {
        return { bill: b, phase: 'resolved' as SenatePhase };
      }
    }
    return { bill: null, phase: null as SenatePhase };
  };

  // ---- camera ----------------------------------------------------------
  //
  // x,y = map point at canvas centre; scale = px per map unit. The
  // director sets a target per shot; the camera eases toward it every
  // frame, so every take is a move and no cut is a jump.
  const cam = { x: 0, y: 0, scale: 1 };
  const target = { x: 0, y: 0, scale: 1 };
  let camInit = false;
  let lastFocus: string | null = null;
  let viewMode: 'auto' | 'wide' = 'auto';

  /** Right-hand panel width; the camera keeps the subject clear of it. */
  // The panel is wider: three of eight empire names were truncated in
  // every frame, and there was dead canvas to its left in nearly all
  // of them.
  const PANEL_W = 300;
  const SAFE = 44;
  /** The timeline lives here; the camera must never compose under it. */
  const SAFE_BOTTOM = 78;

  const fitAll = (t: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bodies) {
      if (!drawableAt(b, Math.floor(t))) continue;
      const p = pos(b.id, t);
      const r = (bodyR.get(b.id) ?? 4) + 8;
      x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
      y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
    }
    if (!isFinite(x0)) { target.x = 0; target.y = 0; target.scale = 1; return; }
    const bw = Math.max(40, x1 - x0), bh = Math.max(40, y1 - y0);
    const availW = W - PANEL_W - SAFE * 2;
    const availH = H - SAFE - SAFE_BOTTOM;
    target.scale = Math.min(availW / bw, availH / bh) * 0.96;
    // Centre in the space LEFT of the panel, not the raw canvas, so the
    // system is never half-hidden behind the empire list.
    target.x = (x0 + x1) / 2 + (PANEL_W / 2) / target.scale;
    target.y = (y0 + y1) / 2 + (SAFE_BOTTOM - SAFE) / 2 / target.scale;
  };

  /**
   * Frame the tick's subject: the body, its fleet ring and its effect
   * radius, filling a healthy share of the frame.
   *
   * Reviewers measured event subjects at 4-13% of frame width against a
   * ~30-45% norm for shipped replays. The fit box is the whole event,
   * not the body's centre, and there is a zoom floor so a small moon
   * still reads.
   */
  const fitBody = (id: string, t: number) => {
    const p = pos(id, t);
    const br = bodyR.get(id) ?? 6;
    // The frame is the BODY PLUS ITS HARBOUR, and it must fill the shot.
    // Reviewers measured subjects at 1.4-5% of canvas against a 30-45%
    // norm: the old extent was dominated by a +46 constant, so a small
    // asteroid framed the same as a gas giant and rendered ~23px in a
    // 1280 frame. Extent scales with the body, and the body itself has a
    // floor in screen pixels so a rock still reads.
    // FRAME THE NEIGHBOURHOOD, not the rock. Five of eight frames were
    // one isolated body at ~3% of canvas: you could not tell where in
    // the system the event was, and the fleets in harbour at nearby
    // worlds -- the film's whole force-disposition story -- were off
    // screen. The fit box is the body plus its siblings and its parent.
    const b0 = byId.get(id)!;
    const kin = bodies.filter(x => x.id === id
      || x.id === b0.parent_body_id
      || (x.parent_body_id && x.parent_body_id === b0.parent_body_id));
    let kx0 = p.x - br, kx1 = p.x + br, ky0 = p.y - br, ky1 = p.y + br;
    for (const k of kin) {
      if (!drawableAt(k, Math.floor(t))) continue;
      const q = pos(k.id, t);
      const kr = (bodyR.get(k.id) ?? 4) + 22;
      kx0 = Math.min(kx0, q.x - kr); kx1 = Math.max(kx1, q.x + kr);
      ky0 = Math.min(ky0, q.y - kr); ky1 = Math.max(ky1, q.y + kr);
    }
    // Never let the neighbourhood swallow the subject: cap how far the
    // box may extend from the focused body.
    const CAP = br + 190;
    kx0 = Math.max(kx0, p.x - CAP); kx1 = Math.min(kx1, p.x + CAP);
    ky0 = Math.max(ky0, p.y - CAP); ky1 = Math.min(ky1, p.y + CAP);
    const bw = Math.max(2 * (br + 26), kx1 - kx0);
    const bh = Math.max(2 * (br + 26), ky1 - ky0);
    const availW = W - PANEL_W - SAFE * 2;
    const availH = H - SAFE - SAFE_BOTTOM;
    let sc = Math.min(availW / bw, availH / bh) * 0.9;
    // Floor: the focused body must still read as a body.
    sc = Math.max(sc, 30 / Math.max(2, br));

    // A SHOT MUST CONTAIN SOMETHING BESIDES ITS SUBJECT.
    //
    // Framing on the subject and its kin is right for a planet with
    // moons and wrong for a lone asteroid: an isolated rock filled the
    // frame with black, and two reviewers independently reported those
    // as shots held on nothing. Pull back until at least a few worlds
    // are in the picture, so a capture out in the belt is still a
    // capture SOMEWHERE.
    // Widening blindly until the count is met loses the subject: a lone
    // asteroid pulled the camera back so far it became a six-pixel dot
    // in its own scene. Instead, GROW THE FIT BOX to take in the nearest
    // few worlds. The subject stays centred and sized, and the shot
    // gains the context that says where in the system this is.
    // Only neighbours close enough to be worth showing. Out in the belt
    // the "nearest" world can be half a system away, and taking it into
    // the box explodes the frame: the zoom floor then clamps the scale
    // and the centring lands the camera BETWEEN the subject and its
    // distant neighbour, framing neither. Measured: a battle at Pluto
    // rendered as empty starfield under its own caption.
    const REACH = Math.max(260, br * 26);
    const near = bodies
      .filter(b => b.id !== id && drawableAt(b, Math.floor(t)))
      .map(b => { const q = pos(b.id, t);
        return { q, d: Math.hypot(q.x - p.x, q.y - p.y) }; })
      .filter(m => m.d <= REACH)
      .sort((m, n) => m.d - n.d)
      .slice(0, MIN_BODIES_IN_SHOT - 1);
    for (const { q } of near) {
      kx0 = Math.min(kx0, q.x - 24); kx1 = Math.max(kx1, q.x + 24);
      ky0 = Math.min(ky0, q.y - 24); ky1 = Math.max(ky1, q.y + 24);
    }
    const bw2 = Math.max(2 * (br + 26), kx1 - kx0);
    const bh2 = Math.max(2 * (br + 26), ky1 - ky0);
    sc = Math.min(sc, Math.min(availW / bw2, availH / bh2) * 0.9);
    // ...but never so far back that the subject stops reading as a world.
    sc = Math.max(sc, 22 / Math.max(2, br));
    // AND OUT IN THE EMPTY PLACES, GO CLOSER. Adding neighbours cannot
    // rescue a shot in the belt or the outer system, because there are
    // none -- measured at 2.9% lit pixels for a battle at Pluto. When
    // the neighbourhood really is bare, let the subject fill the frame
    // instead: a big world on black is a portrait, a small one is a
    // shot of nothing.
    if (near.length < 2) {
      sc = Math.max(sc, (H - SAFE_BOTTOM) * 0.24 / Math.max(2, br));
    }
    // ONE SUBJECT SIZE, WHATEVER THE WORLD. Measured across the reel:
    // an identical event rendered Neptune at 22px and Hygiea at 165px --
    // a 7.5x swing for the same kind of beat, which makes the camera
    // look like it is obeying a rule the viewer cannot infer. The
    // subject is held between roughly a fifth and a third of the frame.
    const vh = H - SAFE_BOTTOM - SAFE;
    sc = Math.max(sc, vh * 0.10 / Math.max(2, br));
    sc = Math.min(sc, vh * 0.19 / Math.max(2, br));
    target.scale = sc;
    // If the box does not actually fit at the scale we settled on, the
    // box centre is a lie -- centre on the subject instead.
    const fits = bw2 * sc <= availW && bh2 * sc <= availH;
    const lean = fits ? 0.45 : 0;
    // Weighted toward the subject rather than the centroid of the box,
    // so the world the scene is about does not drift to a corner.
    target.x = (p.x * (1 - lean) + ((kx0 + kx1) / 2) * lean)
      + (PANEL_W / 2) / sc;
    target.y = (p.y * (1 - lean) + ((ky0 + ky1) / 2) * lean)
      + (SAFE_BOTTOM - SAFE) / 2 / sc;
  };

  const toPx = (p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - cam.x) * cam.scale, y: H / 2 + (p.y - cam.y) * cam.scale });

  const aim = (t: number, dTicks: number) => {
    if (!shots.length) rebuildShots();
    const shot = shots.find(s => t >= s.from && t < s.to) ?? shots[shots.length - 1];
    const rawFocus = viewMode === 'auto' && shot?.bodyId && byId.has(shot.bodyId)
      && drawableAt(byId.get(shot.bodyId)!, Math.floor(t)) ? shot.bodyId : null;

    // THE BREATH. A campaign film needs the grand scale as often as the
    // detail: the whole map is the context that makes a single fight
    // mean anything. Every shot now opens WIDE on the system, pushes in
    // to its subject, holds, and pulls back out before the cut -- so the
    // viewer is repeatedly reminded where in the war they are.
    let focusId = rawFocus;
    let blend = 0;   // 0 = system wide, 1 = fully on the subject
    if (shot && rawFocus) {
      const span = Math.max(1, shot.to - shot.from);
      const u = Math.max(0, Math.min(1, (t - shot.from) / span));
      // A SCENE NEVER LEAVES ITS SUBJECT.
      //
      // The breath used to swing all the way out to the system at each
      // end of a shot. Two reviewers independently reported the result
      // as the film's worst fault without being able to see the cause:
      // a caption reading "THE BATTLE FOR PLUTO" over a frame showing
      // Earth, Luna, Mercury and Venus. The scene was right and the
      // caption was right; the camera was simply somewhere else at that
      // moment. A push-in that starts at three-quarters keeps the
      // subject in frame for every tick the caption is up.
      // And no residual push at all. Even a blend starting at 0.75 --
      // a quarter of the way toward the system view -- was enough to
      // push the subject into a corner of its own establishing frame.
      // Context is not this scene's job: the director already spends
      // whole scenes on the wide system between the close ones.
      blend = 1;
    } else if (rawFocus) {
      blend = 1;
    }
    if (focusId && blend > 0.02) {
      fitBody(focusId, t);
      if (blend < 0.995) {
        const bx = target.x, by = target.y, bs = target.scale;
        fitAll(t);
        target.x += (bx - target.x) * blend;
        target.y += (by - target.y) * blend;
        // Scale interpolates geometrically: a linear blend between two
        // very different zooms spends most of its time near the wide end.
        target.scale = Math.exp(Math.log(target.scale)
          + (Math.log(bs) - Math.log(target.scale)) * blend);
      }
    } else {
      focusId = null;
      fitAll(t);
    }

    // Only a firmly-held subject counts as "the shot" for cut purposes;
    // the wide ends of the breath must not each read as a new target.
    const focusKey = blend > 0.5 ? focusId : null;
    curFocus = focusId;
    if (!camInit) {
      cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      camInit = true; lastFocus = focusKey; return;
    }
    // CUT, DON'T PAN, when the subject changes to somewhere far away.
    // A pan between distant bodies at event zoom crosses nothing but
    // starfield -- three reviewers independently reported those as dead
    // frames. A cut costs one frame; a pan costs seconds of empty film.
    // A SCENE BOUNDARY IS ALWAYS A CUT, never a drift. Easing across
    // one meant the opening seconds of a scene were spent travelling
    // from the last one, with the new caption already on screen naming
    // a world still off camera. The settled frame was always correct,
    // which is exactly why a still-frame audit could not see this and
    // a reel sampled during motion could.
    const shotKey = shot ? `${shot.from}:${shot.bodyId ?? ''}` : '';
    if (shotKey !== lastShot) {
      cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      lastShot = shotKey; lastFocus = focusKey;
    } else if (focusKey !== lastFocus) {
      const far = Math.hypot(target.x - cam.x, target.y - cam.y) * cam.scale;
      const zoomJump = Math.max(target.scale / cam.scale, cam.scale / target.scale);
      if (far > W * 0.75 || zoomJump > 2.5) {
        cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      }
      lastFocus = focusKey;
    }
    // Frame-rate INDEPENDENT easing. A fixed per-frame k converges in a
    // second at 60fps and takes half a shot at 12fps, so the camera's
    // speed silently depended on the machine.
    const k = 1 - Math.exp(-7 * Math.max(0.0001, Math.min(0.5, dTicks)));
    cam.x += (target.x - cam.x) * k;
    cam.y += (target.y - cam.y) * k;
    cam.scale += (target.scale - cam.scale) * k;

    // GUARANTEE: never render a frame with nothing in it.
    let visible = false;
    for (const b of bodies) {
      if (!drawableAt(b, Math.floor(t))) continue;
      const q = toPx(pos(b.id, t));
      const r = (bodyR.get(b.id) ?? 4) * cam.scale;
      if (q.x > -r && q.x < W - PANEL_W + r && q.y > -r && q.y < H + r) {
        visible = true; break;
      }
    }
    if (!visible) { cam.x = target.x; cam.y = target.y; cam.scale = target.scale; }
  };
  // ---- starfield (own, cheap, parallaxed) ------------------------------
  const stars: Array<[number, number, number]> = [];
  {
    const rnd = mulberry32(0x5a7e);
    for (let i = 0; i < 420; i++) stars.push([rnd(), rnd(), 0.4 + rnd() * 1.4]);
  }

  // ---- textures --------------------------------------------------------
  const bodyLike = (b: Body, t: number) => ({
    id: bareId(b.id), type: b.type, color: b.color || '#b06a3f',
    radius: b.radius, orbitRadius: b.orbit_radius ?? 0,
    terraformedAtTick: b.terraformed_at_tick, terraformCompletesAtTick: null,
    resources: { metal: 0, fuel: 0, gold: 0, science: 0 },
    _t: t,
  }) as any;

  // ---- state -----------------------------------------------------------
  let world: MatchWorld = timeline.worldAt(summary.ticks.lo ?? 0);
  let worldTick = -1;
  let curTick = 0, curFrac = 0;
  /** Hulls drawn mid-crossing this frame; harbour stacks skip them. */
  let transiting = new Set<string>();
  /** The scene the camera last composed for; a change is a cut. */
  let lastShot = '';
  /** The body this scene is about, so the frame can spend detail on it. */
  let curFocus: string | null = null;

  let lastT = -1;
  function setTick(tick: number, frac: number) {
    if (tick !== worldTick) {
      world = timeline.worldAt(tick);
      worldTick = tick;
    }
    curTick = tick; curFrac = frac;
    const t = tick + frac;
    const d = lastT < 0 ? 1 : Math.abs(t - lastT);
    lastT = t;
    aim(t, d);
  }

  // ---- render ----------------------------------------------------------
  function render() {
    const t = curTick + curFrac;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, W, H);
    // THE MAP HAS ITS OWN RECT AND STAYS IN IT. Planets were drawing
    // over the timeline and under the empire panel; a camera safe area
    // alone cannot fix that, because bodies OTHER than the subject land
    // wherever the orbit puts them.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W - PANEL_W + 6, H - SAFE_BOTTOM + 10);
    ctx.clip();

    // ---- THE GAME DRAWS THE GAME ------------------------------------
    //
    // Everything that used to stand here was a second implementation of
    // the map -- starfield, political wash, orbit rings, worlds, name
    // collision, hulls, courses -- roughly five hundred lines of it, all
    // re-derived and all worse than the original. Three review rounds
    // said the same thing in the same words: the panel reads as shipped
    // work and the map reads as instrumentation. Of course it did.
    //
    // It is now the game's renderer, handed adapted state. Ownership
    // rings, territory bands, moon spacing, label collision, fleet ring
    // phasing and transit lanes are all the game's own solutions.
    const gameSettlements = adaptSettlements(world);

    // Worlds with a battle running on this tick, straight off the record.
    const fightingNow = new Set<string>();
    for (const b of summary.battles) {
      if (!b.body_id) continue;
      if (curTick >= b.started_tick
        && curTick <= (b.ended_tick ?? b.started_tick)) fightingNow.add(b.body_id);
    }

    // Ownership is a per-tick fact, so it is stamped onto the shared
    // bodies each frame rather than baked in at adapt time.
    const ownerOf = new Map<string, string>();
    for (const st of gameSettlements) ownerOf.set(st.bodyId, st.ownedBy);
    for (const b of gameBodies) {
      const o = ownerOf.get(b.id);
      if (o) b.ownedBy = o; else delete (b as { ownedBy?: string }).ownedBy;
    }

    // Crossings in flight right now, keyed by hull.
    const legs = new Map<string, TransitLeg>();
    for (let tk = curTick - 1; tk <= curTick + TRANSIT_TICKS; tk++) {
      for (const mv of transitAt.get(tk) ?? []) {
        if (legs.has(mv.id)) continue;
        const arrive = tk + 1, depart = arrive - TRANSIT_TICKS;
        if (t < depart || t > arrive) continue;
        if (!byGame.has(mv.from) || !byGame.has(mv.to)) continue;
        legs.set(mv.id, { id: mv.id, from: mv.from, to: mv.to, depart, arrive });
      }
    }

    const gameShips = adaptShips(world, t, legs,
      id => byGame.get(id)?.radius ?? 4,
      id => {
        const b = byGame.get(id);
        return b ? bodyPosition(b, t, gameBodies) : null;
      });

    const rc: RenderContext = {
      ctx, canvas,
      camera: { x: cam.x, y: cam.y, scale: cam.scale },
      t,
      bodies: gameBodies,
      factions: gameFactions,
      settlements: gameSettlements,
      nowMs: performance.now(),
      // WHERE THE HULLS ACTUALLY LANDED. drawShip writes each sprite's
      // true centre here after every offset it applies -- orbit phase,
      // tick interpolation, formation spread. The tracer code below used
      // to re-derive those positions and drift off the visible ship;
      // now it fires from where the ship was really drawn.
      shipHitboxes: new Map<string, { x: number; y: number; r: number }>(),
    };

    const shown = (b: GameBody) =>
      b.destroyedAtTick == null || curTick < b.destroyedAtTick;

    // The label layer is a per-frame queue: drawBody REQUESTS a name and
    // nothing appears until it is flushed. Without this the recap drew a
    // map with no world names on it at all -- which is exactly what the
    // first frame off the new renderer showed.
    resetReservations();

    drawStarfield(starfield, rc);
    drawSystemRegions(
      computeSystemRegions(gameBodies, gameFactions, gameSettlements), rc);

    for (const b of gameBodies) {
      if (!shown(b) || !b.parent) continue;
      drawOrbit(b, rc, withOpacity(b.color, 0.35));
    }

    // Names, placed by the game's own collision planner -- the thing this
    // file spent four rounds reimplementing as a `placed[]` array.
    const cands: Array<{ id: string; x: number; belowAnchor: number;
      aboveAnchor: number; width: number; priority: number }> = [];
    for (const b of gameBodies) {
      if (!shown(b)) continue;
      const cp = toPx(bodyPosition(b, t, gameBodies));
      const r = Math.max(3, b.radius * cam.scale);
      ctx.font = '10px "Audiowide", monospace';
      cands.push({
        id: b.id, x: cp.x,
        belowAnchor: cp.y + r + 14,
        aboveAnchor: cp.y - r - 14 - BODY_LABEL_ROW_HEIGHT,
        width: ctx.measureText((b.name || '').toUpperCase()).width,
        priority: b.ownedBy ? 3 : bodyLabelAlwaysOn(b) ? 4 : 5,
      });
    }
    const labelRows = planBodyLabels(cands);

    for (const b of gameBodies) {
      if (!shown(b)) continue;
      // Yields off: a recap is a film, not an intel screen.
      drawBody(b, rc, false, false, false, labelRows.get(b.id) ?? 0, false);
    }

    for (const st of gameSettlements) {
      const b = byGame.get(st.bodyId);
      if (b && shown(b)) drawSettlement(st, b, gameFactions, rc);
    }

    // FLEETS, ORGANISED THE WAY THE GAME ORGANISES THEM.
    //
    // Passing only {index, total} phased hulls evenly around one ring,
    // which is the game's PEACETIME arrangement -- so a battle drew both
    // sides interleaved on a single circle, every hull overlapping its
    // enemy and the orbit rings underneath. The game instead stages a
    // fight as LINES: each faction gets its own arc of an ~86 degree
    // sector, the lines share a wheel direction so they hold their
    // facing, and every hull carries a radial lane so classes do not sit
    // on top of each other. Out of combat it buckets by altitude, so a
    // parking ring and a station ring stay separate rings.
    const parked = new Map<string, GameShip[]>();
    for (const sh of gameShips) {
      if (sh.transit) continue;
      const k = sh.orbit.parentBodyId;
      const arr = parked.get(k);
      if (arr) arr.push(sh); else parked.set(k, [sh]);
    }

    const formationOf = new Map<string, ShipFormation>();
    for (const [bid, atBody] of parked) {
      // A REPLAY KNOWS BETTER THAN THE LIVE GAME DOES. MapCanvas has to
      // infer hostility from pacts and armament; the record simply says
      // whether a battle was running at this world on this tick.
      const owners = [...new Set(atBody.map(x => x.ownedBy).filter(Boolean))];
      if (fightingNow.has(bid) && owners.length >= 2) {
        const spacing = owners.length > 1 ? BATTLE_SECTOR / (owners.length - 1) : 0;
        const arcWidth = Math.min(spacing * 0.55, 0.8);
        const arcDir = atBody[0].orbit.direction ?? 1;
        owners.forEach((owner, k) => {
          const arcCenter = -BATTLE_SECTOR / 2 + spacing * k;
          const mine = atBody.filter(x => x.ownedBy === owner);
          mine.forEach((x, i) => formationOf.set(x.id, {
            index: i, total: mine.length, lane: shipLane(x),
            arcCenter, arcWidth, arcDir,
          }));
        });
        continue;
      }
      // Peacetime: sub-bucket by altitude so separate rings stay separate.
      const buckets = new Map<string, GameShip[]>();
      for (const x of atBody) {
        const sma = ((x.orbit.rp ?? 0) + (x.orbit.ra ?? 0)) / 2;
        const key = String(Math.round(sma));
        const list = buckets.get(key);
        if (list) list.push(x); else buckets.set(key, [x]);
      }
      for (const list of buckets.values()) {
        if (list.length === 1) {
          formationOf.set(list[0].id, shipLaneOnly(list[0]));
          continue;
        }
        list.forEach((x, i) => formationOf.set(x.id, {
          index: i, total: list.length, lane: shipLane(x),
        }));
      }
    }

    // Hull size ramps with how big the anchoring world is on screen.
    const anchorOf = (bid: string): string => {
      const b = byGame.get(bid);
      if (!b || !b.parent) return bid;
      const par = byGame.get(b.parent);
      return par && par.type !== 'star' ? b.parent : bid;
    };
    const spriteSizeFor = (bid: string): number => {
      const anchor = byGame.get(anchorOf(bid));
      const px = (anchor?.radius ?? 4) * cam.scale;
      return Math.max(ORBIT_SHIP_MIN_SCALE, Math.min(1,
        ORBIT_SHIP_MIN_SCALE + (1 - ORBIT_SHIP_MIN_SCALE)
          * (px - MOON_ORBIT_MIN_PARENT_PX)
          / (SPRITE_FULL_PX - MOON_ORBIT_MIN_PARENT_PX)));
    };
    const transitScale = (() => {
      const sc = Math.max(TRANSIT_MIN_CAM_SCALE, cam.scale);
      const u = Math.max(0, Math.min(1,
        Math.log(sc / TRANSIT_MIN_CAM_SCALE)
          / Math.log(TRANSIT_FULL_CAM_SCALE / TRANSIT_MIN_CAM_SCALE)));
      return TRANSIT_SHIP_MIN_SIZE + (1 - TRANSIT_SHIP_MIN_SIZE) * u;
    })();

    for (const [bid, arr] of parked) {
      const sz = spriteSizeFor(bid);
      for (const sh of arr) {
        drawShip(sh, rc, false, formationOf.get(sh.id), sz);
      }
    }

    // SHIPS THAT DIED IN THE LAST SIX TICKS ARE STILL ON SCREEN.
    // spawnWreck is a one-shot per hull, so it is guarded -- and the
    // guard is dropped when the clock runs backwards, or scrubbing back
    // over a battle would show no wreckage the second time.
    if (curTick < lastDeathTick) spawnedWrecks.clear();
    lastDeathTick = curTick;
    for (let dt = Math.max(0, curTick - 6); dt <= curTick; dt++) {
      for (const d of deathAt.get(dt) ?? []) {
        if (spawnedWrecks.has(d.id)) continue;
        const host = byGame.get(d.body);
        if (!host) continue;
        spawnedWrecks.add(d.id);
        // Where the hull was: on its parking ring, not at the world's
        // centre, so a wreck is left where the ship actually was.
        const bp = bodyPosition(host, dt, gameBodies);
        const ring = Math.max(host.radius * 2.1, host.radius + 9);
        const ang = ((hashStr(d.id) % 1000) / 1000) * Math.PI * 2;
        spawnWreck(d.id,
          { x: bp.x + Math.cos(ang) * ring, y: bp.y + Math.sin(ang) * ring },
          10, performance.now(), dt);
        enqueueDetonation(`${d.id}:${dt}`, d.body, null);
      }
    }
    drawWrecks(rc, performance.now());
    drawDetonations(rc, performance.now());

    // RATE OF FIRE IS THE GAME'S PROBLEM, NOT THIS FILE'S.
    //
    // The tracers here were hand-rolled: seven salvoes a tick, endpoints
    // picked by a seeded RNG, staggered by hand. drawEngagementFire is
    // the real thing -- a wall-clock duty cycle rather than a per-tick
    // burst, kinetic and energy bolts mixed at each hull's real ratio,
    // and bolts that will not fire through a planet. It reads
    // `lastCombatTick`, which the record supplies exactly: a hull is
    // engaged if it is parked at a world the battle table says was
    // fighting on this tick.
    for (const sh of gameShips) {
      if (sh.transit) continue;
      if (fightingNow.has(sh.orbit.parentBodyId)) sh.lastCombatTick = curTick;
    }
    drawEngagementFire(rc, gameShips, gameSettlements,
      performance.now(), curTick);

    // Names, painted now that every world and hull has staked its claim.
    flushLabels(ctx, cam.scale, canvas.width, canvas.height);

    // Who is in harbour where, for the tracer and caption code below.
    const harbour = new Map<string, Map<string, string[]>>();
    for (const [bid, arr] of parked) {
      const perF = new Map<string, string[]>();
      for (const sh of arr) {
        const k = sh.ownedBy || 'n';
        const list = perF.get(k);
        if (list) list.push(sh.id); else perF.set(k, [sh.id]);
      }
      harbour.set(bid, perF);
    }
    const shipPx = new Map<string, { x: number; y: number; fid: string | null }>();
    for (const sh of gameShips) {
      const hit = rc.shipHitboxes?.get(sh.id);
      if (hit) shipPx.set(sh.id, { x: hit.x, y: hit.y, fid: sh.ownedBy || null });
    }
    // The worlds as drawn, so a callout is never printed across one.
    const discs: Array<{ x: number; y: number; r: number }> = [];
    for (const b of gameBodies) {
      if (!shown(b)) continue;
      const cp = toPx(bodyPosition(b, t, gameBodies));
      discs.push({ x: cp.x, y: cp.y, r: Math.max(3, b.radius * cam.scale) });
    }

    // Hulls between worlds, on the game's trajectory art and in its lanes.
    const transiting = new Set<string>();
    for (const sh of gameShips) {
      if (!sh.transit) continue;
      transiting.add(sh.id);
      const samples = drawTorchTrajectory(
        sh.transit.currentTransfer, gameBodies, rc, undefined, true);
      drawTransitShip(sh, rc, false, samples, transitScale);
    }

    // Where the caption ends up, so the body names can keep clear of it.
    let capRect: { x: number; y: number; w: number; h: number } | null = null;
    // Boxes pinned to the worlds their news belongs to, filled below and
    // drawn after the labels so nothing is written across them.
    const callouts: Array<{ bodyId: string; text: string; note: string;
      fid: string | null; rank: number }> = [];
    const callRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    const calloutAt: Array<{ c: { bodyId: string; text: string; note: string;
      fid: string | null; rank: number };
      rect: { x: number; y: number; w: number; h: number };
      px: { x: number; y: number }; r0: number }> = [];

    // Events at this tick: battles pulse, losses flash, foundings ring.
    for (const b of summary.battles) {
      const end = b.ended_tick ?? b.started_tick;
      if (curTick < b.started_tick || curTick > end || !b.body_id) continue;
      const id = b.body_id;
      if (!byId.has(id)) continue;
      const p = toPx(pos(id, t));
      const r = (bodyR.get(id) ?? 4) * cam.scale + 14;
      // COMBAT IS ITS OWN CHANNEL, never a hue from the empire palette.
      // The old red ring read as Frowny Face's pink ownership halo, so a
      // contested rock and an owned rock looked the same.
      const pulse = 0.5 + 0.5 * Math.sin(t * 9);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r + pulse * 5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(210,235,255,${(1 - pulse) * 0.35})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 8 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
      // THEY SHOOT AT EACH OTHER. This used to be random chords drawn
      // near the planet; now every tracer runs from one real hull to
      // another real hull of an opposing faction, using the positions
      // those icons were actually drawn at. Rounds are staggered across
      // the tick so a battle is a rolling exchange, not a starburst.
      const perF = harbour.get(id);
      if (perF) {
        const sides = [...perF.entries()].filter(([k]) => k !== 'n');
        // ONE SIDE PRESENT IS A BOMBARDMENT, NOT A GAP. 19 of this
        // match's 68 battles have hulls from a single faction at the
        // body -- a fleet working over a world it does not hold. Those
        // ships fire on the planet itself rather than standing silent.
        if (sides.length === 1) {
          const rnd = mulberry32(hashStr(id) * 11 + curTick);
          const [fid2, ids2] = sides[0];
          const col = colorOf(fid2);
          const SAL = 5;
          for (let k = 0; k < SAL; k++) {
            const sp = shipPx.get(ids2[Math.floor(rnd() * ids2.length)]);
            if (!sp) continue;
            const u = (curFrac - k / SAL) * SAL * 1.6;
            if (u <= 0 || u >= 1.35) continue;
            // Land on the disc's near edge, not its centre.
            const ang2 = Math.atan2(sp.y - p.y, sp.x - p.x);
            const br2 = (bodyR.get(id) ?? 5) * cam.scale;
            const tx = p.x + Math.cos(ang2) * br2, ty = p.y + Math.sin(ang2) * br2;
            const flight = Math.min(1, u);
            const dx2 = tx - sp.x, dy2 = ty - sp.y;
            const hx = sp.x + dx2 * flight, hy = sp.y + dy2 * flight;
            const tail2 = Math.min(0.3, flight);
            ctx.strokeStyle = hexA(col, 0.95);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(sp.x + dx2 * Math.max(0, flight - tail2),
              sp.y + dy2 * Math.max(0, flight - tail2));
            ctx.lineTo(hx, hy); ctx.stroke();
            if (u > 1) {
              const k2 = (u - 1) / 0.35;
              ctx.fillStyle = `rgba(255,220,160,${(1 - k2) * 0.9})`;
              ctx.beginPath(); ctx.arc(tx, ty, 2 + k2 * 8, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
        if (sides.length >= 2) {
          const rnd = mulberry32(hashStr(id) * 7 + curTick);
          const SALVOES = 7;
          for (let k = 0; k < SALVOES; k++) {
            const ai = Math.floor(rnd() * sides.length);
            let bi = Math.floor(rnd() * sides.length);
            if (bi === ai) bi = (bi + 1) % sides.length;
            const shooters = sides[ai][1], targets = sides[bi][1];
            if (!shooters.length || !targets.length) continue;
            const sp = shipPx.get(shooters[Math.floor(rnd() * shooters.length)]);
            const tp = shipPx.get(targets[Math.floor(rnd() * targets.length)]);
            if (!sp || !tp) continue;
            // Each salvo has its own slot in the tick, so shots leave,
            // fly and land instead of all existing at once.
            const t0 = k / SALVOES;
            const u = (curFrac - t0) * SALVOES * 1.6;
            if (u <= 0 || u >= 1.35) continue;
            const dx = tp.x - sp.x, dy = tp.y - sp.y;
            const flight = Math.min(1, u);
            const hx = sp.x + dx * flight, hy = sp.y + dy * flight;
            const tail = Math.min(0.28, flight);
            // A SALVO IS SEVERAL PARALLEL BEAMS IN AMBER, which is how
            // the game draws fire: a battery firing together, not one
            // hairline. Offset perpendicular to the line of fire.
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len;
            for (let bi = -1; bi <= 1; bi++) {
              const off = bi * 2.2;
              ctx.strokeStyle = bi === 0
                ? 'rgba(255,214,140,0.98)' : 'rgba(232,150,60,0.85)';
              ctx.lineWidth = bi === 0 ? 2 : 1.3;
              ctx.beginPath();
              ctx.moveTo(sp.x + dx * Math.max(0, flight - tail) + nx * off,
                sp.y + dy * Math.max(0, flight - tail) + ny * off);
              ctx.lineTo(hx + nx * off, hy + ny * off);
              ctx.stroke();
            }
            const col = colorOf(sp.fid);
            // Muzzle flash while the round is leaving the gun.
            if (u < 0.3) {
              ctx.fillStyle = hexA(col, (1 - u / 0.3) * 0.9);
              ctx.beginPath();
              ctx.arc(sp.x, sp.y, 2.5 + (1 - u / 0.3) * 3, 0, Math.PI * 2);
              ctx.fill();
            }
            // Impact on arrival.
            if (u > 1) {
              const k2 = (u - 1) / 0.35;
              ctx.fillStyle = `rgba(255,235,190,${(1 - k2) * 0.95})`;
              ctx.beginPath();
              ctx.arc(tp.x, tp.y, 2 + k2 * 7, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }

    for (const e of events) {
      if (e.tick !== curTick || !e.bodyId || !byId.has(e.bodyId)) continue;
      const p = toPx(pos(e.bodyId, t));
      const r0 = (bodyR.get(e.bodyId) ?? 4) * cam.scale;
      const k = Math.min(1, curFrac);
      if (e.kind === 'loss') {
        ctx.fillStyle = `rgba(255,150,70,${(1 - k) * 0.5})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 10 + k * 26, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'founded' || e.kind === 'fallen') {
        const fid = ownerOf.get(e.bodyId) ?? null;
        ctx.strokeStyle = hexA(e.kind === 'founded' ? colorOf(fid) : '#ff6a5a', 1 - k);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 4 + k * 30, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // CAPTION: VERB-LED, WITH A CONSEQUENCE. The old fallback said
    // "Body — Empire", a sentence that is true on every tick of the
    // match, so the director's cuts read as stopping on nothing.
    {
      const onScreen = summary.battles.filter(b => b.body_id
        && curTick >= b.started_tick && curTick <= (b.ended_tick ?? b.started_tick)
        && byId.has(b.body_id));
      const caps = captureAt.get(curTick) ?? [];
      // WHAT HAPPENS AT A WORLD IS SAID AT THAT WORLD. A single caption
      // could only ever narrate one place, so on a busy tick the film
      // picked one fight and left the other nine unremarked -- and when
      // the shot was wide, that one caption sat over the map describing
      // something the viewer had no way to locate. Every world-specific
      // event now gets its own small box pinned to its own world, and the
      // lower third is left for the things that genuinely belong to no
      // single place: a bill, an elimination, a change of lead.
      const sceneNow = shots.find(x => curTick >= x.from && curTick < x.to);
      const sceneBody = sceneNow && sceneNow.weight > 0 ? sceneNow.bodyId : null;
      const seenCall = new Set<string>();
      const wantCall = (bodyId: string, text: string, note: string,
                        fid: string | null, rank: number) => {
        if (seenCall.has(bodyId)) return;
        const b = byId.get(bodyId);
        if (!b || !drawableAt(b, curTick)) return;
        seenCall.add(bodyId);
        callouts.push({ bodyId, text, note, fid, rank });
      };
      // Ranked, because when more is happening than there is room for it
      // is the captures that matter and the stray loss that can wait.
      for (const c of caps) {
        // The lower third already carries this world's news in full.
        if (sceneBody && c.body === sceneBody) continue;
        const nm = byId.get(c.body)?.name ?? 'this world';
        if (c.to) {
          wantCall(c.body, c.from ? `${nm} FALLS` : `${nm} SETTLED`,
            faction(c.to)?.name ?? '', c.to, 0);
        } else {
          wantCall(c.body, `${nm} LOST`,
            faction(c.from)?.name ?? 'driven off', c.from, 0);
        }
      }
      for (const e of events) {
        if (!e.bodyId || e.kind === 'pact') continue;
        if (Math.abs(e.tick - curTick) > 1) continue;
        const nm = byId.get(e.bodyId)?.name ?? 'this world';
        if (e.kind === 'loss') {
          const n = e.count ?? 1;
          wantCall(e.bodyId, `${n} ship${n === 1 ? '' : 's'} lost`, nm, null, 2);
        } else if (e.kind === 'founded') wantCall(e.bodyId, `${nm} SETTLED`, '', null, 1);
        else if (e.kind === 'fallen') wantCall(e.bodyId, `${nm} — colony lost`, '', null, 1);
      }
      for (const b of onScreen) {
        // The lower third is already naming the scene's own battle; a
        // second box saying it at the same world is just noise.
        if (sceneBody && b.body_id === sceneBody) continue;
        const nm = byId.get(b.body_id!)?.name ?? 'this world';
        const sides = [...(harbour.get(b.body_id!)?.keys() ?? [])]
          .filter(k => k !== 'n').map(k => faction(k)?.name ?? '')
          .filter(Boolean).slice(0, 2);
        wantCall(b.body_id!, `Battle at ${nm}`,
          sides.length >= 2 ? sides.join(' vs ') : '', null, 3);
      }
      callouts.sort((a, b) => a.rank - b.rank);
      callouts.length = Math.min(callouts.length, 5);

      // THE LOWER THIRD SPEAKS FOR THE SCENE IT IS IN.
      //
      // It used to pick a system-wide line regardless of what the
      // director was actually showing, so the largest engagement in the
      // match -- fifty-eight hulls at Saturn -- was captioned "6 fleets
      // under way", and the same string captioned the frame after it. A
      // caption that ignores its own scene is worse than none: it tells
      // the viewer to look for something that is not there.
      //
      // So: when the scene is about something, say what it is and how
      // big. Only a scene that is genuinely about the system at large
      // gets a system-wide line.
      let line = '', sub = '';
      const sc = shots.find(x => curTick >= x.from && curTick < x.to);
      const scName = sc?.bodyId ? byId.get(sc.bodyId)?.name ?? '' : '';
      if (sc && sc.weight > 0 && scName) {
        if (sc.note === 'battle') {
          line = `THE BATTLE FOR ${scName.toUpperCase()}`;
          const who = (sc.sides ?? []).map(f => faction(f)?.name ?? '')
            .filter(Boolean);
          const bits: string[] = [];
          if (who.length >= 2) bits.push(who.join(' vs '));
          else if (who.length === 1) bits.push(who[0]);
          if (sc.hulls) bits.push(`${sc.hulls} hulls`);
          if (sc.lost) bits.push(`${sc.lost} lost`);
          sub = bits.join(' · ');
        } else if (sc.note === 'capture') {
          line = `${scName.toUpperCase()} CHANGES HANDS`;
          // Which is only half the news. Who took it, and off whom, is
          // the half that tells you what it MEANT.
          const cp = [...captureAt.values()].flat()
            .find(c => c.body === sc.bodyId);
          if (cp && cp.to) {
            const to = faction(cp.to)?.name;
            const fr = cp.from ? faction(cp.from)?.name : null;
            if (to) sub = fr ? `${to} takes it from ${fr}` : `${to} settles it`;
          }
        } else if (sc.note === 'driven off') {
          line = `${scName.toUpperCase()} — THE GARRISON IS DRIVEN OFF`;
        }
      }
      if (!line && sc && sc.weight <= 0) {
        // A WIDE SHOT IS STILL A SCENE. One sampled frame carried no
        // headline at all, so at that moment the viewer had nothing on
        // screen telling them what they were watching. A quiet stretch
        // is about the state of the war, so say what that state is.
        const rank = rankAt.get(curTick);
        let top: string | null = null;
        if (rank) for (const [fid, r] of rank) if (r === 1) top = fid;
        if (top) {
          let worlds = 0;
          for (const st3 of world.stls.values()) if (st3.fid === top) worlds++;
          line = sc.note === 'fleets under way'
            ? 'FLEETS UNDER WAY' : 'THE SYSTEM BUILDS';
          sub = `${faction(top)?.name ?? 'The leader'} leads · ${worlds} worlds`;
        }
      }
      if (!line) {
        if (onScreen.length >= 3) {
          line = `${onScreen.length} battles across the system`;
        } else if (caps.length >= 2) {
          line = `${caps.length} worlds change hands`;
        } else if ((transitAt.get(curTick)?.length ?? 0) >= 3) {
          line = `${transitAt.get(curTick)!.length} fleets under way`;
        }
      }
      // Eliminations and lead changes are headline events in their own
      // right; they used to happen only as a number change in the panel.
      for (const [fid, tk] of elimAt) {
        // Only once the clock has reached it: this used to print "T+186"
        // in a box sitting above a clock reading T+185.
        if (curTick >= tk && curTick - tk <= 3) {
          line = `${faction(fid)?.name ?? 'An empire'} ELIMINATED`;
          sub = '';
        }
      }
      // A bill landing outranks a quiet map moment: it changes the
      // rules for everyone, which is the biggest thing that can happen
      // on a tick with no shooting.
      {
        const { bill, phase } = senateAt(curTick);
        const res = bill?.resolved_at_tick;
        if (bill && res != null && Math.abs(res - curTick) <= 1) {
          const passed = bill.status === 'passed';
          line = `SENATE — "${bill.title || bill.kind}" ${passed ? 'PASSES' : 'FAILS'}`;
          let yea = 0, nay = 0;
          for (const v of bill.votes) {
            if (v.vote === 'yea') yea += v.weight || 1;
            else if (v.vote === 'nay') nay += v.weight || 1;
          }
          sub = `${yea} yea · ${nay} nay`
            + (bill.proposer_faction_id
              ? ` · proposed by ${faction(bill.proposer_faction_id)?.name ?? 'a member'}`
              : '');
        } else if (bill && phase === 'vote' && !line) {
          line = `SENATE VOTES — "${bill.title || bill.kind}"`;
        }
      }

      const lead = leadAt.get(curTick);
      if (lead && !line) {
        line = `${faction(lead)?.name ?? 'A new empire'} TAKES THE LEAD`;
      }

      // THE FILM HAS AN ENDING.
      //
      // Both rounds, every reviewer: the reel simply stops. The last
      // frame carried a routine settle caption and the winner was
      // recoverable only by reading a number in a side panel and
      // noticing which colour had flooded the map. A match film that
      // does not say who won is not a match film.
      if (curTick >= (summary.ticks.hi ?? 0) - 1) {
        const rank = rankAt.get(curTick);
        let champ: string | null = null;
        if (rank) for (const [fid, r] of rank) if (r === 1) champ = fid;
        if (champ) {
          const w = world;
          let worlds = 0, hulls = 0;
          for (const st2 of w.stls.values()) if (st2.fid === champ) worlds++;
          for (const sh2 of w.ships.values()) if (sh2.fid === champ) hulls++;
          const nm = faction(champ)?.name ?? 'An empire';
          const cx = (W - PANEL_W) / 2, cy = H / 2 - 40;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(4,8,14,0.9)';
          ctx.fillRect(cx - 300, cy - 62, 600, 124);
          ctx.strokeStyle = hexA(colorOf(champ), 0.9);
          ctx.lineWidth = 2;
          ctx.strokeRect(cx - 300 + 1, cy - 62 + 1, 598, 122);
          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillStyle = 'rgba(150,175,200,0.9)';
          ctx.fillText('V I C T O R Y', cx, cy - 38);
          ctx.font = '700 30px system-ui, sans-serif';
          ctx.fillStyle = liftedOf(champ);
          ctx.fillText(nm, cx, cy - 2);
          ctx.font = '400 14px system-ui, sans-serif';
          ctx.fillStyle = '#c3d3e4';
          ctx.fillText(`${worlds} worlds held · ${hulls} hulls · ${curTick} ticks`,
            cx, cy + 32);
          line = '';
        }
      }

      if (line) {
        // A LOWER THIRD, NOT A SPEECH BUBBLE. The caption used to hang off
        // whichever body the shot was on, so it wandered into other
        // worlds' labels -- reported in three separate rounds, and not
        // fixable by nudging, because at some zoom the anchor always lands
        // on something. Pinning it above the timeline, the way match film
        // has always captioned itself, makes the collision impossible
        // rather than merely unlikely.
        ctx.font = '700 22px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const wMain = ctx.measureText(line).width;
        ctx.font = '13px system-ui, sans-serif';
        const wSub = sub ? ctx.measureText(sub).width : 0;
        const boxW = Math.min(W - PANEL_W - 40, Math.max(wMain, wSub) + 34);
        const boxH = sub ? 60 : 40;
        const cx = (W - PANEL_W) / 2;
        const cy = H - SAFE_BOTTOM - boxH - 16;
        capRect = { x: cx - boxW / 2, y: cy, w: boxW, h: boxH };
        note('caption', capRect.x, capRect.y, capRect.w, capRect.h, line);
        ctx.fillStyle = 'rgba(4,8,14,0.88)';
        ctx.fillRect(cx - boxW / 2, cy, boxW, boxH);
        ctx.strokeStyle = 'rgba(150,180,215,0.45)';
        ctx.strokeRect(cx - boxW / 2 + 0.5, cy + 0.5, boxW - 1, boxH - 1);
        ctx.fillStyle = '#f4f8fd';
        ctx.font = '700 22px system-ui, sans-serif';
        ctx.fillText(line, cx, cy + 7);
        if (sub) {
          ctx.fillStyle = '#a8bccf';
          ctx.font = '13px system-ui, sans-serif';
          ctx.fillText(sub, cx, cy + 36);
        }
      }
    }

    // Labels, after everything so they sit on top.
    // Body names as the game sets them: uppercase, letter-spaced, a
    // muted blue-grey, and no plate behind them.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    // Work out where each world's box wants to sit before the names are
    // laid out, so a name never has to be squeezed around a box that has
    // not been positioned yet.
    for (const c of callouts) {
      const b = byId.get(c.bodyId);
      if (!b) continue;
      const pc = toPx(pos(c.bodyId, t));
      const r0 = (bodyR.get(c.bodyId) ?? 6) * cam.scale;
      // Pinned news sits a clear step below the headline, and an
      // incidental loss a step below that: size has to mean something.
      ctx.font = c.rank <= 1 ? '600 12px system-ui, sans-serif'
        : '600 10px system-ui, sans-serif';
      const wMain = ctx.measureText(c.text).width;
      ctx.font = '9px system-ui, sans-serif';
      const wNote = c.note ? ctx.measureText(c.note).width : 0;
      const bw = Math.max(wMain, wNote) + 18;
      const bh = c.note ? 32 : 20;
      // Above the world by preference, then below, then to either side:
      // whichever first lands clear of the boxes already placed.
      const tries = [
        [pc.x - bw / 2, pc.y - r0 - 12 - bh],
        [pc.x - bw / 2, pc.y + r0 + 12],
        [pc.x + r0 + 12, pc.y - bh / 2],
        [pc.x - r0 - 12 - bw, pc.y - bh / 2],
        [pc.x - bw / 2, pc.y - r0 - 20 - bh * 2],
      ];
      let put: { x: number; y: number; w: number; h: number } | null = null;
      for (const [bx, by] of tries) {
        const rect = { x: bx, y: by, w: bw, h: bh };
        if (rect.x < 6 || rect.x + bw > W - PANEL_W - 6) continue;
        if (rect.y < 6 || rect.y + bh > H - SAFE_BOTTOM - 6) continue;
        // Including the worlds themselves: a box printed across the
        // disc it points at was reported in both rounds, and the label
        // solver had already learned this lesson separately.
        const onWorld = discs.some(d =>
          Math.abs(d.x - (rect.x + bw / 2)) < d.r + bw / 2 - 4
          && Math.abs(d.y - (rect.y + bh / 2)) < d.r + bh / 2 - 2);
        const hits = onWorld
          || callRects.some(q =>
          Math.abs((q.x + q.w / 2) - (rect.x + bw / 2)) < (q.w + bw) / 2 + 6
          && Math.abs((q.y + q.h / 2) - (rect.y + bh / 2)) < (q.h + bh) / 2 + 6)
          || (capRect != null
            && Math.abs((capRect.x + capRect.w / 2) - (rect.x + bw / 2))
              < (capRect.w + bw) / 2 + 6
            && Math.abs((capRect.y + capRect.h / 2) - (rect.y + bh / 2))
              < (capRect.h + bh) / 2 + 6);
        if (!hits) { put = rect; break; }
      }
      if (put) { callRects.push(put); calloutAt.push({ c, rect: put, px: pc, r0 }); }
    }

    // The body-name pass that used to sit here -- a `placed[]` array, a
    // twelve-pixel band test, seeded rows for chips, lanes and captions --
    // is gone. planBodyLabels() above solves the same problem with the
    // solver the game ships, against the same anchors drawBody derives
    // internally, so names and worlds can no longer disagree.

    // The boxes themselves, last of all: a leader down to the world so
    // there is never a question which one the news belongs to.
    for (const { c, rect, px, r0 } of calloutAt) {
      const col = c.fid ? colorOf(c.fid) : 'rgba(150,180,215,0.75)';
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const dx = px.x - cx, dy = px.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = hexA(c.fid ? colorOf(c.fid) : '#9db0c4', 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + (dx / len) * (rect.h / 2 + 2), cy + (dy / len) * (rect.h / 2 + 2));
      ctx.lineTo(px.x - (dx / len) * (r0 + 2), px.y - (dy / len) * (r0 + 2));
      ctx.stroke();
      note('callout', rect.x, rect.y, rect.w, rect.h, c.text);
      ctx.fillStyle = 'rgba(5,9,15,0.92)';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = hexA(c.fid ? colorOf(c.fid) : '#9db0c4', 0.8);
      ctx.lineWidth = 1.2;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = c.rank <= 1 ? '#eef4fb' : 'rgba(214,228,241,0.82)';
      ctx.font = c.rank <= 1 ? '600 12px system-ui, sans-serif'
        : '600 10px system-ui, sans-serif';
      ctx.fillText(c.text, rect.x + rect.w / 2, rect.y + 4);
      if (c.note) {
        // Never the raw empire colour: the same slot measured 3.26:1 for
        // one empire and 7.91:1 for another, decided purely by who owned
        // the world.
        ctx.fillStyle = c.fid ? liftedOf(c.fid) : '#9db2c6';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillText(c.note, rect.x + rect.w / 2, rect.y + 18);
      }
    }

    ctx.restore();   // end map clip
    drawHud(t);
  }

  // ---- HUD: the clock and the empires ---------------------------------
  //
  // This is where the metrics earn their keep on screen: every faction's
  // fleet size and stockpiles, live per tick, in its own colour.
  function drawHud(t: number) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const fleets = new Map<string, number>();
    for (const s2 of world.ships.values()) {
      const k = s2.fid ?? 'n'; fleets.set(k, (fleets.get(k) ?? 0) + 1);
    }
    const worlds = new Map<string, number>();
    for (const s2 of world.stls.values()) {
      if (!s2.fid) continue; worlds.set(s2.fid, (worlds.get(s2.fid) ?? 0) + 1);
    }

    // SORTED BY WORLDS, THEN FLEET. The panel used to sit in seat order,
    // so the leader was indistinguishable from an eliminated empire in
    // the same 11px type -- you could not name who was winning at any
    // moment. Rank is now the row order, and overtakes are visible.
    const rows = [...summary.factions].sort((x, y) =>
      (worlds.get(y.id) ?? 0) - (worlds.get(x.id) ?? 0)
      || (fleets.get(y.id) ?? 0) - (fleets.get(x.id) ?? 0)).slice(0, 9);

    const PW = PANEL_W - 12, rowH = 32;
    const px0 = W - PW - 8, py0 = 10;
    const panelH = rows.length * rowH + 34;
    ctx.fillStyle = 'rgba(4,8,14,0.8)';
    ctx.fillRect(px0, py0, PW, panelH);
    ctx.strokeStyle = 'rgba(120,150,190,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(px0 + 0.5, py0 + 0.5, PW - 1, panelH - 1);

    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#7f97ad';
    ctx.fillText('EMPIRE', px0 + 26, py0 + 8);
    ctx.textAlign = 'right';
    ctx.fillText('FLEET · WORLDS', px0 + PW - 10, py0 + 8);

    rows.forEach((f, i) => {
      const y = py0 + 24 + i * rowH;
      const nWorlds = worlds.get(f.id) ?? 0, nShips = fleets.get(f.id) ?? 0;
      // Eliminated empires are dimmed and struck, not drawn at full
      // brightness with stale bars implying a live economy.
      const dead = nWorlds === 0 && nShips === 0;
      ctx.globalAlpha = dead ? 0.34 : 1;
      if (i === 0 && !dead) {
        ctx.fillStyle = 'rgba(120,160,210,0.12)';
        ctx.fillRect(px0 + 2, y - 3, PW - 4, rowH - 2);
      }
      ctx.fillStyle = '#6f88a3';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), px0 + 8, y + 2);
      ctx.fillStyle = f.color || NEUTRAL;
      ctx.fillRect(px0 + 20, y + 2, 9, 9);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
      ctx.strokeRect(px0 + 20.5, y + 2.5, 8, 8);

      // A FIXED GUTTER for the numbers, and the name truncated to fit.
      // Two empires' fleet counts were unreadable in every frame because
      // the name column and the count column shared pixels.
      const GUT = 96;
      const nameMax = PW - 34 - GUT - 10;
      ctx.fillStyle = dead ? '#8d9aa6' : '#e6f0f8';
      ctx.font = '600 11px system-ui, sans-serif';
      let nm = f.name;
      if (ctx.measureText(nm).width > nameMax) {
        while (nm.length > 1 && ctx.measureText(nm + '…').width > nameMax) {
          nm = nm.slice(0, -1);
        }
        nm += '…';
      }
      ctx.fillText(nm, px0 + 34, y + 1);
      if (dead) {
        const wpx = ctx.measureText(nm).width;
        ctx.strokeStyle = '#8d9aa6'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px0 + 34, y + 7);
        ctx.lineTo(px0 + 34 + wpx, y + 7); ctx.stroke();
      }
      // WORLDS IS THE SORT KEY, SO WORLDS IS THE BIG NUMBER. Printing
      // fleet large next to a worlds-ordered list made rank look wrong:
      // "62·18 / 28·12 / 61·11" reads as a broken sort.
      ctx.textAlign = 'right';
      ctx.fillStyle = dead ? '#7c8895' : '#e6f0f8';
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.fillText(String(nWorlds), px0 + PW - 10, y - 2);
      ctx.fillStyle = dead ? '#66707c' : '#8ea3b8';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(nShips + (nShips === 1 ? ' ship' : ' ships'),
        px0 + PW - 34, y + 3);

      // Rank movement, held briefly so an overtake is an event you see.
      const rNow = rankAt.get(curTick)?.get(f.id);
      const rWas = rankAt.get(Math.max(0, curTick - 6))?.get(f.id);
      if (!dead && rNow != null && rWas != null && rNow !== rWas) {
        const up = rNow < rWas;
        ctx.fillStyle = up ? '#6ee7a5' : '#ff8f7a';
        ctx.font = '700 9px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText((up ? '\u25b2' : '\u25bc') + Math.abs(rNow - rWas),
          px0 + 8, y + 13);
      }

      // ONE stacked bar with a legend, not four unlabelled hairlines.
      // The old bars had no scale, no units and no key, so they taught
      // the viewer to ignore them.
      if (!dead) {
        const st = world.stock.get(f.id) ?? [0, 0, 0];
        // ONE SCALE FOR THE WHOLE MATCH. Normalised per row, every
        // bar rendered near-full and cross-empire comparison -- the
        // only reason to draw them -- was impossible.
        // Square-root scale. On a linear match-wide scale the first
        // half of the film was 3%-fill nubs carrying no information.
        const total = Math.sqrt(stockMax) * 3;
        // metal, credits, science -- the three resources the game has.
        const cols = ['#9aa7b6', '#e8c36a', '#6fb4ee'];
        let bx = px0 + 34;
        const bw = PW - 44;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, y + 18, bw, 7);
        for (let k = 0; k < 3; k++) {
          const seg = (Math.sqrt(Math.max(0, st[k])) / total) * bw;
          if (seg <= 0.4) continue;
          ctx.fillStyle = cols[k];
          ctx.fillRect(bx, y + 18, seg, 7);
          bx += seg;
        }
      }
      ctx.globalAlpha = 1;
    });

    // Legend for the stacked bar, once, under the panel.
    {
      const ly = py0 + panelH + 6;
      const keys: Array<[string, string]> = [['metal', '#9aa7b6'],
        ['credits', '#e8c36a'], ['science', '#6fb4ee']];
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let lx = px0 + 4;
      for (const [name, col] of keys) {
        ctx.fillStyle = col; ctx.fillRect(lx, ly - 3, 7, 7);
        ctx.fillStyle = '#8ea3b8';
        ctx.fillText(name, lx + 10, ly + 1);
        lx += 12 + ctx.measureText(name).width + 10;
      }
    }

    // ---- the senate --------------------------------------------------
    //
    // The chamber gets its own strip under the standings: which bill is
    // live, what phase it is in, and how the vote is falling. Weight is
    // worlds held, so this doubles as a second reading of the balance
    // of power.
    {
      const { bill, phase } = senateAt(curTick);
      const sx = W - PANEL_W - 8, sy = py0 + panelH + 22;
      const sw = PANEL_W - 12;
      const sh = bill ? 62 : 26;
      ctx.fillStyle = 'rgba(4,8,14,0.8)';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = 'rgba(120,150,190,0.25)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#7f97ad';
      ctx.fillText('THE SENATE', sx + 10, sy + 7);
      if (!bill) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#5d7189';
        ctx.fillText('in recess', sx + sw - 10, sy + 7);
      } else {
        const label = phase === 'debate' ? 'DEBATING'
          : phase === 'vote' ? 'VOTING'
          : bill.status === 'passed' ? 'PASSED' : 'FAILED';
        const lc = phase === 'vote' ? '#e8c36a'
          : phase === 'resolved'
            ? (bill.status === 'passed' ? '#6ee7a5' : '#ff8f7a')
            : '#8ea3b8';
        ctx.textAlign = 'right';
        ctx.fillStyle = lc;
        ctx.fillText(label, sx + sw - 10, sy + 7);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#e6f0f8';
        ctx.font = '600 12px system-ui, sans-serif';
        let ttl = bill.title || bill.kind;
        const tmax = sw - 20;
        if (ctx.measureText(ttl).width > tmax) {
          while (ttl.length > 1 && ctx.measureText(ttl + '…').width > tmax) {
            ttl = ttl.slice(0, -1);
          }
          ttl += '…';
        }
        ctx.fillText(ttl, sx + 10, sy + 21);

        // The vote as a weighted bar: yea / nay / not yet cast.
        let yea = 0, nay = 0;
        for (const v of bill.votes) {
          if (v.vote === 'yea') yea += v.weight || 1;
          else if (v.vote === 'nay') nay += v.weight || 1;
        }
        const cast = yea + nay;
        const barW2 = sw - 20;
        const total = Math.max(1, cast);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(sx + 10, sy + 40, barW2, 7);
        ctx.fillStyle = '#6ee7a5';
        ctx.fillRect(sx + 10, sy + 40, (yea / total) * barW2, 7);
        ctx.fillStyle = '#ff8f7a';
        ctx.fillRect(sx + 10 + (yea / total) * barW2, sy + 40,
          (nay / total) * barW2, 7);
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = '#8ea3b8';
        ctx.textAlign = 'left';
        ctx.fillText('yea ' + yea, sx + 10, sy + 50);
        ctx.textAlign = 'right';
        ctx.fillText('nay ' + nay, sx + sw - 10, sy + 50);
      }
    }

    // ---- clock + timeline -------------------------------------------
    //
    // Nothing said where a tick fell in the match. The bar shows the
    // whole war at a glance, with a mark at every battle.
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    const barY = H - 26, barX = 16, barW = W - PW - 40;
    // A gradient scrim across the full width: bodies that do bleed to
    // the bottom edge stay legible instead of fighting the rail.
    const scrim = ctx.createLinearGradient(0, H - 88, 0, H);
    scrim.addColorStop(0, 'rgba(3,6,13,0)');
    scrim.addColorStop(1, 'rgba(3,6,13,0.92)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, H - 88, W, 88);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 3);
    // Binned into a histogram so the war has a SHAPE -- a build, a peak
    // and a tail -- rather than an undifferentiated picket fence.
    {
      const BINS = 72;
      const bin = new Array(BINS).fill(0);
      for (const bt of summary.battles) {
        const f = (bt.started_tick - lo) / Math.max(1, hi - lo);
        bin[Math.max(0, Math.min(BINS - 1, Math.floor(f * BINS)))]++;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      ctx.fillRect(barX, barY - 5, barW, 1);
      const peak = Math.max(1, ...bin);
      const bwid = barW / BINS;
      for (let i = 0; i < BINS; i++) {
        if (!bin[i]) continue;
        const hgt = 4 + (bin[i] / peak) * 14;
        ctx.fillStyle = 'rgba(255,130,95,0.8)';
        ctx.fillRect(barX + i * bwid, barY - 4 - hgt, Math.max(1.2, bwid - 0.8), hgt);
      }
    }
    // Senate marks sit above the battle histogram: the political track
    // and the military one, on one timeline.
    for (const b of summary.senate ?? []) {
      const at = b.resolved_at_tick ?? b.vote_closes_at_tick;
      if (at == null) continue;
      const f = (at - lo) / Math.max(1, hi - lo);
      ctx.fillStyle = b.status === 'passed'
        ? 'rgba(110,231,165,0.9)' : 'rgba(255,143,122,0.9)';
      ctx.beginPath();
      ctx.arc(barX + f * barW, barY - 26, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const fx = (Math.floor(t) - lo) / Math.max(1, hi - lo);
    ctx.fillStyle = '#6fb4ee';
    ctx.fillRect(barX, barY, Math.max(1, fx * barW), 3);
    ctx.beginPath();
    ctx.arc(barX + fx * barW, barY + 1.5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#e6f0f8';
    const clockTxt = 'T+' + Math.floor(t);
    ctx.fillText(clockTxt, barX, barY - 6);
    const cw = ctx.measureText(clockTxt).width;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#7f97ad';
    ctx.fillText(' / ' + hi, barX + cw + 3, barY - 6);
    const clockW = cw + 3 + ctx.measureText(' / ' + hi).width;
    // Reconstructed stretches are shaded INSIDE the rail, so the label
    // shows which span it covers instead of sitting on every frame as a
    // permanent watermark.
    const firstLive = summary.firstLiveTick;
    if (firstLive != null && firstLive > lo) {
      const fw = ((firstLive - lo) / Math.max(1, hi - lo)) * barW;
      ctx.fillStyle = 'rgba(150,175,200,0.3)';
      ctx.fillRect(barX, barY - 3, fw, 9);
      if (Math.floor(t) < firstLive) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#7f97ad';
        ctx.font = '9px system-ui, sans-serif';
        // Placed after the clock pair has been measured, never under it.
        ctx.fillText('REBUILT FROM THE RECORD', barX + clockW + 16, barY - 7);
      }
    }
  }

  function resize(w: number, h: number) {
    // ONE BACKING PIXEL PER CSS PIXEL, because that is the contract the
    // game's renderer is written to: it draws in BACKING-STORE pixels and
    // reads canvas.width directly in twenty-odd places (see the note in
    // MapCanvas about a device-pixel-ratio transform making every planet,
    // ship and label come out ~1.8x too big). Matching it is what makes
    // worldToCanvas and this file's toPx the same function.
    DPR = 1;
    W = w; H = h;
    canvas.width = Math.round(w); canvas.height = Math.round(h);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    starfield = generateStarfield(canvas.width, canvas.height);
  }
  resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);

  return {
    setTick, render, resize,
    applyRows: (rows: SnapshotRow[]) => {
      timeline.append(rows); rebuildStandings(); rebuildTransits(); rebuildShots();
    },
    dispose: () => { /* nothing held */ },
    worldAt: (tick: number) => timeline.worldAt(tick),
    setView: (mode: 'auto' | 'wide') => { viewMode = mode; },
    rateAt,
    // The cut list, for harnesses and probes; not part of the contract.
    _shots: () => shots.map(x => ({ ...x })),
    /** Render one frame recording every box drawn, and hand them back. */
    _audit: (tick: number, frac = 0.5) => {
      for (let i = 0; i < 90; i++) setTick(tick, frac);
      debugRects = [];
      render();
      const out = debugRects; debugRects = null;
      return out;
    },
  };
}

// ---- helpers ------------------------------------------------------------

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (n.some(v => Number.isNaN(v))) return `rgba(138,159,179,${a})`;
  return `rgba(${n[0]},${n[1]},${n[2]},${Math.max(0, Math.min(1, a))})`;
}

/**
 * A fleet chip, drawn the way the game draws them: a black rounded
 * plate with a bright faction-coloured border, a small glyph, and the
 * count in white. These are the strongest thing on the real map -- you
 * read force disposition off the chips, not off the hulls.
 */
function badge(ctx: CanvasRenderingContext2D, x: number, y: number,
               text: string, color: string) {
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const w = tw + 22, h = 18, r = 5;
  const x0 = x - w / 2, y0 = y - h / 2;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + w, y0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(6,10,16,0.94)';
  ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  ctx.stroke();
  // Glyph: a small hull mark in the faction's colour.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0 + 6, y0 + 5);
  ctx.lineTo(x0 + 14, y0 + 9);
  ctx.lineTo(x0 + 6, y0 + 13);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f2f7fc';
  ctx.fillText(text, x0 + 17, y);
}
