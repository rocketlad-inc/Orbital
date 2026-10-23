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

import { hashStr, mulberry32 } from './planetTexture';
import { MIN_CAMERA_SCALE } from './cameraLimits';
import {
  BODY_LABEL_ROW_HEIGHT, bodyLabelAlwaysOn, computeTransitFormations, placeInFormation,
  drawAsteroidBeltDust, drawBody, drawOrbit, drawOwnershipLayer,
  drawSettlement, drawShip, drawStarfield, drawSystemRegions,
  drawTorchTrajectory, drawTransitShip, forgetDrawnShips, generateStarfield, planBodyLabels,
} from './mapRenderer';
import type { ShipFormation } from './mapRenderer';
import {
  drawArrivalFlashes, drawEngagementFire, drawWrecks, spawnArrivalFlash, spawnWreck,
} from './combatFx';
import { drawBlast, drawDebris } from './fxPrimitives';
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
import { computePresentation, drawnRadiusOf, hullReveal, hullSize } from './bodyPresentation';
import { battlePlacement, battleScale, forgetBattleGlides, liveBattleFor, type BattleUnit, type LiveBattle } from './battleLayoutLive';
import { shipIconSize } from './mapRenderer';
import { getShipClass } from '../game/shipClasses';
import { getEmblemImage } from './emblemCache';
import { getLang, tIn, type Key } from '../i18n/core';
import {
  battleWindow, filmSecondsAt, planReel, reelRate, reelSeconds, sceneAt,
  type ReelBattle, type ReelBeat, type ReelScene,
} from './filmReel';
import { beatCaption, billName, broadcastCopy, buildBeats, captionFor, type Caption } from './filmCaptions';
import {
  drawBattleTally, drawClock, drawCountChips, drawLowerThird, drawProgress,
  drawResultCard, drawStandings, drawTicker, drawTitleCard, drawVignette,
  liftColor, unitOf, type FilmFaction, type StandingRow, type TallySide,
  drawBattleVerdict, drawProgressMeter, shortName, drawHookLine, drawDysonShell, drawSenateCard,
  drawToasts, drawOutCards, drawHomePin,
} from './filmOverlay';

const NEUTRAL = '#8a9fb3';
/** Log lines that ride the ticker: the news, not the bookkeeping. */
const TICKER_KINDS = new Set([
  'settlement_seized', 'settlement_destroyed', 'settlement_razed', 'ship_detonated',
  'war_declared', 'war_ended', 'treaty_broken', 'faction_eliminated', 'faction_revived',
  'megastructure_complete', 'megastructure_captured', 'megastructure_destroyed',
  'dyson_initiated', 'dyson_milestone', 'dyson_collapsed', 'terraform_destroyed',
  'world_obliterated', 'senate_vote', 'kaiju_launched', 'kaiju_hunting', 'kaiju_revealed',
  'kaiju_charging', 'kaiju_dead', 'sun_gate_emerged', 'sun_gate_opened',
  'mega_strike_charging', 'asteroid_impact', 'missile_strike',
]);
/** Film seconds between two ticker lines coming up, and each one's life. */
const TICKER_GAP_SECONDS = 0.7;
/** War, peace and pact banners: the least gap between two, and their life. */
const TOAST_GAP_SECONDS = 0.5;
const TOAST_LIFE_SECONDS = 3.0;
const TICKER_LIFE_SECONDS = 2.6;
const CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- iconClassOf — icon refactor in flight
const iconClassOf = (c: string | null): ShipIconClass =>
  (CLASSES.includes((c ?? '').toLowerCase())
    ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

type Body = MatchSummary['bodies'][number];

export function createMatchMap(
  summary: MatchSummary, canvas: HTMLCanvasElement,
): ReplayStage & { _shots: () => unknown[];
  _audit: (tick: number, frac?: number) => unknown[];
  _deaths: (tick: number) => unknown[];
  _probe: () => unknown;
  _facts: () => unknown; _trace: () => unknown } {
  const ctx = canvas.getContext('2d')!;
  let W = canvas.width || 1280, H = canvas.height || 720, DPR = 1;

  const bodies = summary.bodies;
  const byId = new Map(bodies.map(b => [b.id, b]));
  const faction = (fid: string | null) => summary.factions.find(f => f.id === fid);
  const colorOf = (fid: string | null) => faction(fid)?.color || NEUTRAL;
  /** The players: the Leviathan's faction is a monster, not an empire. */
  const empires = summary.factions.filter(f => !/:leviathan_f$/.test(f.id));
  const filmFactions = new Map<string, FilmFaction>(summary.factions.map(f => [f.id,
    { id: f.id, name: f.name, color: f.color || NEUTRAL, emblem: f.emblem ?? null }]));
  const filmFaction = (fid: string | null | undefined) => (fid ? filmFactions.get(fid) : undefined);
  // Start the emblem rasters now: they land a frame or two later.
  for (const f of filmFactions.values()) getEmblemImage(f.emblem ?? null, liftColor(f.color, 150));
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
  /** Crossings in flight at a tick, keyed by hull. */
  const legsAt = (tick: number, at: number) => {
    const out = new Map<string, TransitLeg>();
    for (let tk = tick - 1; tk <= tick + TRANSIT_TICKS; tk++) {
      for (const mv of transitAt.get(tk) ?? []) {
        if (out.has(mv.id)) continue;
        const arrive = tk + 1, depart = arrive - TRANSIT_TICKS;
        if (at < depart || at > arrive) continue;
        if (!byGame.has(mv.from) || !byGame.has(mv.to)) continue;
        out.set(mv.id, { id: mv.id, from: mv.from, to: mv.to, depart, arrive });
      }
    }
    return out;
  };

  // The adapted world, held across the frames of a single tick. Rebuilt
  // when the tick changes; see the note at the use site.
  let adaptedTick = -1;
  let adaptedShips: GameShip[] = [];
  let adaptedStls: ReturnType<typeof adaptSettlements> = [];
  let adaptedLegs = new Map<string, TransitLeg>();

  /** Crossings whose landing has already been punctuated. */
  const arrivedSeen = new Set<string>();
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

  /**
   * WORLDS THE MATCH MADE. The record has no creation tick, so the event
   * log supplies it: the Leviathan's carcass exists from its death, a sun
   * gate from the first one leaving the Sun. Drawn from tick one, the
   * film showed a corpse labelled LEVIATHAN CARCASS while its caption
   * said the beast was feeding.
   */
  const appearsAt = new Map<string, number>();
  {
    const first = (kind: string) => (summary.chronicle ?? []).find(r => r.kind === kind)?.tick_number;
    const dead = first('kaiju_dead'), gate = first('sun_gate_emerged') ?? first('sun_gate_opened');
    for (const b of bodies) {
      if (/leviathan_carcass$/.test(b.id) && dead != null) appearsAt.set(b.id, dead);
      else if (/:sungate_[a-z0-9]+(_far)?$/.test(b.id) && gate != null) appearsAt.set(b.id, gate);
    }
  }
  /** Worlds a weapon or the Leviathan broke apart, from the log: the
   *  record kept drawing MK 2 whole under "MK 2 is devoured". */
  const goneAt = new Map<string, number>();
  for (const r of summary.chronicle ?? []) {
    if (r.kind === 'world_obliterated' && r.body_id && !goneAt.has(r.body_id)) goneAt.set(r.body_id, r.tick_number);
  }
  const drawableAt = (b: Body, tick: number) =>
    (b.type === 'star' || (!!b.parent_body_id && !!b.orbit_period))
    && !(b.destroyed_at_tick != null && tick >= b.destroyed_at_tick)
    && !((appearsAt.get(b.id) ?? -Infinity) > tick)
    && !((goneAt.get(b.id) ?? Infinity) <= tick);

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
  /** The edit: scenes with their own pace (filmReel). */
  let scenes: ReelScene[] = [];
  /** The battle the title card plays over. */
  let teaser: ReelScene | null = null;
  /** The display clock: the match clock, except during the cold open. */
  let dispT = 0;
  /** The film's own clock, which the edit and the graphics follow. */
  let clockT = 0;
  /** How far each world's battle layout reaches, over the world's own
   *  radius (band.rOut / refR), from the last frame drawn; and the most
   *  each battle scene has needed, so its framing only ever widens. */
  const battleReach = new Map<string, number>();
  const sceneExtent = new Map<ReelScene, number>();
  /** Each dying hull's own moment within its last tick (0.12..0.88). */
  const killPhase = (id: string) => 0.12 + 0.76 * ((hashStr(`${id}:k`) % 1000) / 1000);
  /** The scene playing now (set by the camera). */
  let curScene: ReelScene | undefined;
  let filmTotal = 0;
  /** Each empire's first world, for the roll call. */
  const homes: Array<{ fid: string; body: string }> = [];
  /** Every colony founded in the opening act, with the film second it lands. */
  let built: Array<{ at: number; body: string; fid: string }> = [];
  /** The roll call: when the first pin lands, the gap between pins, and
   *  when they lift off for the land grab (film seconds into the act). */
  const ROLL_CALL_AT = 0.5, ROLL_CALL_STEP = 0.32, ROLL_CALL_END = 5.2;
  /** War, peace and pact banners, with the film second each comes up. */
  let toasts: Array<{ at: number; kind: 'war' | 'peace' | 'pact' | 'broken'; a: string; b: string }> = [];
  /** Smaller headlines, with the film second each one comes up. */
  let ticker: Array<{ beat: ReelBeat; start: number }> = [];

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
  const TRANSIT_SHIP_MIN_SIZE = 0.5;
  const TRANSIT_FULL_CAM_SCALE = 0.5;
  const TRANSIT_MIN_CAM_SCALE = MIN_CAMERA_SCALE;
  /** How long a hull's death flash runs, in ticks. */
  const BLAST_TICKS = 1.5;
  /** How many ticks a crossing is shown flying. */
  const TRANSIT_TICKS = 4;
  /** Nothing is drawn with its top edge inside this margin. */
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
  const deathAt = new Map<number, Array<{ id: string; body: string; fid: string | null; cls: string }>>();
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
      const gone: Array<{ id: string; body: string; fid: string | null; cls: string }> = [];
      for (const [id, was] of prev.ships) {
        if (now.ships.has(id) || !was.parent) continue;
        gone.push({ id, body: was.parent, fid: was.fid ?? null, cls: was.cls });
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
   * THE EDIT (filmReel.ts).
   *
   * The film is planned as an edit against a runtime budget: the biggest
   * battles and the event log's headlines win scenes, everything between
   * them plays as a fast time-lapse of the whole map. What follows only
   * MEASURES the match for the planner: each fight merged across the
   * ticks it ran, how many hulls were there at the height of it, how many
   * died and when, and the event log weighed and placed (filmCaptions).
   */
  const rebuildShots = () => {
    events = mineEvents(timeline.rows, summary);
    scenes = [];
    // A page of rows just landed: who is where may have changed.
    occupiedCache.clear();
    home = undefined;
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    if (hi < lo) return;

    const deathsAtBody = (body: string, t: number) =>
      (deathAt.get(t) ?? []).reduce((n, d) => n + (d.body === body ? 1 : 0), 0);
    // A world changing hands is the point of a siege: the log's own
    // settlement rows, per world and tick.
    const fallsAt = new Map<string, number[]>();
    for (const r of summary.chronicle ?? []) {
      if (!r.body_id || !/^settlement_(seized|destroyed|razed)$/.test(r.kind)) continue;
      const a = fallsAt.get(r.body_id) ?? [];
      a.push(r.tick_number);
      fallsAt.set(r.body_id, a);
    }
    const fallsAtBody = (body: string, t: number) =>
      (fallsAt.get(body) ?? []).reduce((n, x) => n + (x === t ? 1 : 0), 0);

    // --- battles at one world, merged into one engagement --------------
    const battles: ReelBattle[] = [];
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
      for (const [s0, e00] of merged) {
        if (!drawableAt(byId.get(body)!, s0)) continue;
        // The fight's record can end a few ticks before the world it was
        // about actually falls; the fall is the end of the story.
        let e0 = e00;
        for (const x of fallsAt.get(body) ?? []) if (x > e0 && x <= e00 + 8) e0 = x;
        // The stretch worth showing is where the dying happened, and
        // above all where the world fell.
        const window = battleWindow(s0, e0 + 1,
          t => deathsAtBody(body, t) + 6 * fallsAtBody(body, t));
        // How big was it, really? Hulls present at the height of the
        // window, and who was there in force.
        // ENGAGED is every hull that was there across the window (a peak
        // count let "21 engaged, 26 lost" through), and the SIDES are the
        // two empires that fought hardest: most hulls there plus twice
        // the hulls they lost. The world's owner heads it only if it was
        // in the fight at all.
        const seen = new Set<string>();
        const most = new Map<string, number>();
        const lostBy = new Map<string, number>();
        for (let t = window[0]; t < window[1]; t++) {
          const per = new Map<string, number>();
          for (const [id, sh] of timeline.worldAt(t).ships) {
            if (sh.parent !== body) continue;
            seen.add(id);
            if (sh.fid) per.set(sh.fid, (per.get(sh.fid) ?? 0) + 1);
          }
          for (const [f, n] of per) most.set(f, Math.max(most.get(f) ?? 0, n));
        }
        let lost = 0;
        for (let t = window[0]; t < window[1] + 1; t++) {
          for (const d of deathAt.get(t) ?? []) {
            if (d.body !== body) continue;
            lost++;
            seen.add(d.id);
            if (d.fid) lostBy.set(d.fid, (lostBy.get(d.fid) ?? 0) + 1);
          }
        }
        const score = (f: string) => (most.get(f) ?? 0) + 2 * (lostBy.get(f) ?? 0);
        const fought = [...new Set([...most.keys(), ...lostBy.keys()])]
          .filter(f => score(f) > 0).sort((x, y) => score(y) - score(x));
        const sides = fought.slice(0, 2);
        // THE DEFENDER IS NAMED. A world's owner that fought for it is one
        // of the two sides even when two attackers out-fought it: "Battle
        // for Mars: Tritalowda vs Ministry, +4 more" hid the empire whose
        // capital it was.
        let holder: string | null = null, holderPop = -1;
        for (const st of timeline.worldAt(window[0]).stls.values()) {
          if (st.body !== body || !st.fid || st.pop <= holderPop) continue;
          holder = st.fid; holderPop = st.pop;
        }
        if (holder && fought.includes(holder) && !sides.includes(holder) && sides.length === 2) sides[1] = holder;
        const present = fought.length;
        const peak = seen.size;
        const atOnce = [...most.values()].reduce((a, b) => a + b, 0);
        battles.push({ body, from: s0, to: e0 + 1, peak, lost, sides, window, atOnce,
          present: Math.max(present, sides.length) });
      }
    }

    // --- the event log, weighed and placed ------------------------------
    let beats: ReelBeat[] = buildBeats(summary, {
      lang: getLang(),
      // On the tick BEFORE: a world destroyed by the event is gone by its tick.
      drawable: (id, t) => byId.has(id) && drawableAt(byId.get(id)!, t - 1),
    });
    if (!summary.chronicle) {
      // An older server sends no log: worlds changing hands are still in
      // the record, so they still make the cut, uncaptioned beyond that.
      beats = [];
      for (const [t, list] of captureAt) {
        for (const c of list) {
          if (!c.to || !byId.has(c.body) || !drawableAt(byId.get(c.body)!, t)) continue;
          beats.push({ tick: t, kind: 'settlement_seized', body: c.body, weight: 75,
            fid: c.to, target: c.from, text: '',
            data: { body_name: byId.get(c.body)?.name ?? '' } });
        }
      }
    }

    // AN EMPIRE'S END HAPPENS SOMEWHERE: on the last world it held.
    for (const e of beats) {
      if (e.kind !== 'faction_eliminated' || e.body || !e.fid) continue;
      for (let t = e.tick - 1; t >= Math.max(lo, e.tick - 12) && !e.body; t--) {
        for (const st of timeline.worldAt(t).stls.values()) {
          if (st.fid === e.fid && byId.has(st.body) && drawableAt(byId.get(st.body)!, e.tick)) {
            e.body = st.body; break;
          }
        }
      }
    }

    // THE END OF AN EMPIRE IS A SCENE OF ITS OWN: opened a day earlier on
    // the siege of its last world, held longer, and its toll counted.
    {
      const fidByName = new Map(summary.factions.map(f => [f.name, f.id]));
      for (const e of beats) {
        if (e.kind !== 'faction_eliminated' || e.weight <= 0) continue;
        e.lead = 3;
        e.hold = 7.2;
        const names = [...(Array.isArray(e.data?.together) ? e.data!.together as string[] : []),
          String(e.data?.faction_name ?? '')];
        const toll = names.map(n => {
          const fid = fidByName.get(n) ?? (n === e.data?.faction_name ? e.fid : null);
          if (!fid) return null;
          let peak = 0, lost = 0;
          const step = Math.max(1, Math.floor((e.tick - lo) / 60));
          for (let t = lo; t <= e.tick; t += step) {
            const row = standingsAt(t).find(r => r.faction.id === fid);
            if (row) peak = Math.max(peak, row.worlds);
          }
          for (const [t, list] of deathAt) if (t <= e.tick) for (const d of list) if (d.fid === fid) lost++;
          return { fid, peak, lost };
        }).filter(Boolean);
        e.data = { ...e.data, toll };
      }
    }

    // THE LEVIATHAN'S SCENES GO WHERE THE LEVIATHAN IS. Its log rows name
    // the world it is after; the beast itself is parked at a sun gate, or
    // at the moon it is eating, and that is the shot.
    const kaijuAt = (tick: number): string | null => {
      for (const sh of timeline.worldAt(tick).ships.values()) if (sh.cls === 'kaiju' && sh.parent) return sh.parent;
      return null;
    };
    for (const e of beats) {
      const isKaiju = /^kaiju_/.test(e.kind) || e.data?.cause === 'kaiju';
      if (!isKaiju || e.kind === 'kaiju_omen') continue;
      // THE KILL ON SCREEN. The beast's hull is gone a tick before the
      // log's row: anchor the scene on the tick it actually dies in, so
      // the death lands mid-scene, not in its first second.
      if (e.kind === 'kaiju_dead') {
        let t = e.tick;
        while (t > e.tick - 4 && !kaijuAt(t - 1)) t--;
        if (kaijuAt(t - 1)) e.tick = t;
      }
      // Its arrival is a hull APPEARING at the end of its tick: one tick
      // of lead, so it is on screen for two thirds of the scene.
      if (e.kind === 'kaiju_hunting' && e.data?.carried) e.lead = 1;
      const at = kaijuAt(e.tick) ?? kaijuAt(e.tick - 1);
      if (at && byId.has(at) && drawableAt(byId.get(at)!, e.tick)) e.body = at;
    }

    // WHAT EACH LAW DID, measured from the record: ships built while ship
    // costs were halved, fleets grown while upkeep was cut, the losses of
    // an empire the Senate authorised war on, the reparations paid out.
    for (const e of beats) {
      if (e.kind !== 'senate_vote' || e.weight <= 0) continue;
      const p = (e.data ?? {}) as Record<string, unknown>;
      const inner = (p.payload ?? {}) as Record<string, unknown>;
      const until = Math.min(hi, Number(p.effect_until_tick) || e.tick + 24);
      const days = Math.max(0, until - e.tick);
      const slider = String(inner.slider_id ?? '');
      const name = (id: unknown) => shortName(filmFaction(String(id ?? ''))?.name ?? '');
      let impact = '';
      if (p.bill_kind === 'reparations' && Number(p.transferred) > 0) {
        impact = T('senate.paid', { n: Number(p.transferred).toLocaleString('en-US'), k: Number(p.recipients) || 0 });
      } else if (p.bill_kind === 'war_authorization') {
        const target = String(p.target_faction_id ?? inner.target_faction_id ?? '');
        let n = 0;
        for (let t = e.tick + 1; t <= until; t++) for (const d of deathAt.get(t) ?? []) if (d.fid === target) n++;
        if (n > 0) impact = T('senate.lost', { b: name(target), n, d: days });
      } else if (/ship_build|rush/.test(slider)) {
        const seen = new Set(timeline.worldAt(e.tick).ships.keys());
        let n = 0;
        for (let t = e.tick + 1; t <= until; t++) {
          for (const id of timeline.worldAt(t).ships.keys()) if (!seen.has(id)) { seen.add(id); n++; }
        }
        if (n > 0) impact = T('senate.built', { n });
      } else if (/upkeep/.test(slider)) {
        const a = timeline.worldAt(e.tick).ships.size, b = timeline.worldAt(until).ships.size;
        if (b !== a) impact = T('senate.fleets', { a, b });
      }
      e.data = { ...p, impact,
        term: p.effect_until_tick == null && p.bill_kind !== 'war_authorization' ? T('senate.forever') : T('senate.for', { d: days }) };
    }

    lastFacts = { battles, beats: [...beats].filter(b => b.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 40)
      .map(b => ({ tick: b.tick, kind: b.kind, w: Math.round(b.weight), body: b.body, text: b.text.slice(0, 60) })) };
    const dysonBody = (summary.chronicle ?? []).find(r => r.kind === 'dyson_initiated')?.body_id ?? null;
    // THE OPENING ACT runs to just before the first war: the roll call and
    // the land grab, never a nine-second time-lapse.
    const firstWar = (summary.chronicle ?? []).find(r => r.kind === 'war_declared')?.tick_number;
    const span = hi - lo;
    const openingTo = Math.round(Math.max(lo + span * 0.12, Math.min(lo + span * 0.35,
      firstWar != null ? firstWar - 3 : lo + span * 0.25)));
    scenes = planReel({ lo, hi, battles, beats }, {
      finaleBody: summary.game.victory_type === 'engineering' && dysonBody && byId.has(dysonBody)
        ? dysonBody : null,
      openingTo,
    });
    filmTotal = reelSeconds(scenes);
    captionCache.clear();
    usedTitles.clear();
    montageTop.clear();
    kaijuGlossed = false;
    for (const sc of scenes) captionOf(sc);
    // THE COLD OPEN: the title plays over the deadliest fight of the
    // match, then the film cuts back to how it began. A feed gives a clip
    // about a second to show it is worth watching.
    teaser = null;
    let teaserW = -1;
    for (const s of scenes) {
      if (s.kind !== 'battle' || !s.battle) continue;
      const w = s.battle.lost * 6 + s.battle.peak;
      if (w > teaserW) { teaserW = w; teaser = s; }
    }
    sceneExtent.clear();
    sceneFocus.clear();

    // NO BREATHING ZOOM and NO HELD WHIZZ. A time-lapse too short to read
    // is a time cut (filmReel skips it); one long enough to play is the
    // wide shot. Held close, a short one ran a day and a half a frame and
    // hulls crossed the screen between two frames.
    systemFrames.clear();
    travelSeconds.clear();

    buildToasts();
    homes.length = 0;
    built = [];
    {
      const opening = scenes.find(x => x.act === 'opening');
      const firstOf = new Set<string>();
      for (const r of summary.chronicle ?? []) {
        if (r.kind !== 'settlement_built' || !r.actor_faction_id || !r.body_id || !byGame.has(r.body_id)) continue;
        if (!firstOf.has(r.actor_faction_id) && r.tick_number <= lo + 3 && !/:leviathan_f$/.test(r.actor_faction_id)) {
          firstOf.add(r.actor_faction_id);
          homes.push({ fid: r.actor_faction_id, body: r.body_id });
        }
        if (opening && r.tick_number >= opening.from && r.tick_number < opening.to) {
          built.push({ at: filmSecondsAt(scenes, r.tick_number), body: r.body_id, fid: r.actor_faction_id });
        }
      }
    }

    // --- the ticker: smaller headlines, spaced so each can be read ------
    ticker = [];
    let lastStart = -Infinity;
    for (const s of scenes) {
      if (s.kind === 'intro' || s.kind === 'finale') continue;
      const sEnd = filmSecondsAt(scenes, s.to);
      for (const e of s.extras) {
        if (!TICKER_KINDS.has(e.kind) || !e.text) continue;
        const at = filmSecondsAt(scenes, e.tick);
        const start = Math.max(at, lastStart + TICKER_GAP_SECONDS);
        // Late by more than a moment, it is no longer news: drop it.
        if (start - at > 0.6 || start > sEnd + 0.2) continue;
        ticker.push({ beat: e, start });
        lastStart = start;
      }
    }
  };

  /**
   * EVERY DECLARATION OF WAR, and every peace, pact and broken pact, as a
   * banner at the moment it happens, in whatever scene that is. One that
   * falls in a stretch the film cuts across comes up as the next scene
   * opens; they stack (three at most) rather than queue out of their time.
   */
  const buildToasts = () => {
    toasts = [];
    const seen = new Set<string>();
    const rows = (summary.chronicle ?? []).filter(r => /^(war_declared|war_ended|treaty_signed|treaty_broken)$/.test(r.kind));
    let lastAt = -Infinity;
    for (const r of rows) {
      const a = r.actor_faction_id ?? null, b = r.target_faction_id ?? null;
      if (!a || !b) continue;
      const pair = [a, b].sort().join('|');
      const kind = r.kind === 'war_declared' ? 'war' : r.kind === 'war_ended' ? 'peace'
        : r.kind === 'treaty_broken' ? 'broken' : 'pact';
      // A pact is signed as three treaties at once: one banner.
      const key = `${kind}:${pair}:${r.tick_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Not over the cold open or the result.
      const sc = sceneAt(scenes, r.tick_number);
      if (!sc || sc.kind === 'intro' || sc.kind === 'finale') continue;
      // The scene that IS this war says it already.
      if (sc.kind === 'beat' && sc.beat?.kind === 'war_declared'
        && (sc.beat.target === b || sc.beat.fid === a) && Math.abs(sc.beat.tick - r.tick_number) <= 12) continue;
      const at = Math.max(filmSecondsAt(scenes, r.tick_number), lastAt + TOAST_GAP_SECONDS);
      toasts.push({ at, kind, a, b });
      lastAt = at;
    }
  };

  /** Seconds of film per tick at this point in the match. */
  const rateAt = (tick: number) => {
    if (!scenes.length) rebuildShots();
    return reelRate(scenes, tick);
  };

  // ---- camera ----------------------------------------------------------
  //
  // x,y = map point at canvas centre; scale = px per map unit.
  //
  // THE CAMERA IS A FUNCTION OF THE FILM CLOCK, not an easing state. Each
  // scene has a FRAME (the occupied system, a battle close in, a world at
  // a middle distance), and every boundary between scenes is a move from
  // the last frame to the next: a push in from the system to the world
  // the news is at, a pull back out to the system after it, a cut where
  // the next subject is not in the last shot at all. Computed from the
  // clock, the same instant always frames the same way, so scrubbing,
  // pausing and an exported film all agree.
  const cam = { x: 0, y: 0, scale: 1 };
  let viewMode: 'auto' | 'wide' = 'auto';
  type Frame = { x: number; y: number; scale: number };

  /** Where in the frame the subject sits: a little above centre, clear
   *  of the lower third. */
  const FOCUS_Y = 0.44;
  /** A drawn subject's radius as a share of the frame height. */
  const BATTLE_SUBJECT = 0.1;
  const WORLD_SUBJECT = 0.12;

  /** The star system a world belongs to (its root star). */
  const systemOf = (id: string): string => {
    let cur = byId.get(id);
    for (let i = 0; i < 8 && cur?.parent_body_id; i++) {
      const up = byId.get(cur.parent_body_id);
      if (!up) break;
      cur = up;
    }
    return cur?.id ?? id;
  };

  /**
   * Who is somewhere over a scene: worlds settled, or with hulls parked,
   * sampled across its span. The system shot frames THESE, not the whole
   * map out to the last rock in the belt.
   */
  const occupiedCache = new Map<string, string[]>();
  let home: string | null | undefined;
  const homeSystem = (): string | null => {
    if (home !== undefined) return home;
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    const perSys = new Map<string, number>();
    for (let t = lo; t <= hi; t += Math.max(1, Math.floor((hi - lo) / 24))) {
      for (const st of timeline.worldAt(t).stls.values()) {
        if (!byId.has(st.body)) continue;
        const s = systemOf(st.body);
        perSys.set(s, (perSys.get(s) ?? 0) + 1);
      }
    }
    home = [...perSys.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return home;
  };
  const occupiedOver = (from: number, to: number): string[] => {
    const key = `${from}:${to}`;
    const hit = occupiedCache.get(key);
    if (hit) return hit;
    const weight = new Map<string, number>();
    const step = Math.max(1, Math.floor((to - from) / 6));
    for (let t = from; t <= Math.max(from, to - 1); t += step) {
      const w = timeline.worldAt(t);
      for (const st of w.stls.values()) weight.set(st.body, (weight.get(st.body) ?? 0) + 3);
      for (const sh of w.ships.values()) if (sh.parent) weight.set(sh.parent, (weight.get(sh.parent) ?? 0) + 1);
    }
    // ONE SYSTEM for every wide shot: the one the match was fought in.
    // Chosen per scene, a late flurry out past a sun gate swung the last
    // wide shot to another star and left the frame black.
    const sys = homeSystem();
    let ids = [...weight.keys()].filter(id => byId.has(id)
      && drawableAt(byId.get(id)!, from) && systemOf(id) === sys);
    // An outpost far out past everyone else should not shrink the war to
    // a speck: keep the worlds within reach of where the weight is.
    if (sys && ids.length > 3) {
      const t0 = (from + to) / 2;
      const c = pos(sys, t0);
      const d = ids.map(id => { const p = pos(id, t0); return { id, d: Math.hypot(p.x - c.x, p.y - c.y), w: weight.get(id) ?? 0 }; })
        .sort((a, b) => a.d - b.d);
      const total = d.reduce((s2, x) => s2 + x.w, 0);
      let acc = 0, cutD = d[d.length - 1].d;
      for (const x of d) { acc += x.w; if (acc >= total * 0.88) { cutD = x.d; break; } }
      ids = d.filter(x => x.d <= cutD * 1.2).map(x => x.id);
    }
    if (sys) ids.push(sys);
    occupiedCache.set(key, ids);
    return ids;
  };

  /** Margins the graphics take: the clock and standings above, the
   *  lower third below. */
  const safe = () => {
    const u = unitOf(H);
    return { top: 120 * u, bottom: 210 * u, side: 60 * u };
  };

  /** Each wide shot's one frame (see systemFrame). */
  const systemFrames = new Map<ReelScene | undefined, Frame>();
  const systemFrame = (s: ReelScene | undefined, t: number): Frame => {
    // ONE FRAME FOR THE WHOLE SHOT. Re-centred on the occupied worlds at
    // every instant, the wide shot swam 30-66 px a frame as the system
    // turned under a time-lapse: framed once, over the worlds' places
    // across the scene, it holds still and they turn inside it.
    const hit = systemFrames.get(s);
    if (hit) return hit;
    const lo = summary.ticks.lo ?? 0;
    const ids = s ? occupiedOver(s.from, s.to) : occupiedOver(lo, lo + 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const at = s ? [0, 0.25, 0.5, 0.75, 1].map(k => s.from + (s.to - s.from) * k) : [t];
    for (const id of ids) {
      for (const ti of at) {
        const p = pos(id, ti);
        const r = (bodyR.get(id) ?? 4) + 10;
        x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
        y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
      }
    }
    if (!isFinite(x0)) return { x: 0, y: 0, scale: 1 };
    const m = safe();
    const bw = Math.max(60, x1 - x0), bh = Math.max(60, y1 - y0);
    const availW = W - m.side * 2, availH = H - m.top - m.bottom;
    const scale = Math.max(MIN_CAMERA_SCALE, Math.min(availW / bw, availH / bh) * 0.92);
    const cy = (y0 + y1) / 2;
    // Centre the box in the space between the graphics.
    const midY = (m.top + (H - m.bottom)) / 2;
    const f = { x: (x0 + x1) / 2, y: cy + (H / 2 - midY) / scale, scale };
    if (s) systemFrames.set(s, f);
    return f;
  };

  const bodyFrame = (id: string, t: number, share: number): Frame => {
    const p = pos(id, t);
    // The game's own radius: close in, a world draws at true size, and
    // its battle layout scales with it.
    const r = Math.max(0.5, byGame.get(id)?.radius ?? bodyR.get(id) ?? 6);
    const scale = Math.max(MIN_CAMERA_SCALE, (H * share) / r);
    return { x: p.x, y: p.y + (H / 2 - H * FOCUS_Y) / scale, scale };
  };

  const subjectOf = (s: ReelScene | undefined, t: number): string | null =>
    s && s.kind === 'intro' && teaser ? subjectOf(teaser, t)
    : s && s.bodyId && s.framing !== 'system' && byId.has(s.bodyId)
      && (drawableAt(byId.get(s.bodyId)!, Math.floor(t))
        // The shot stays on a world for a moment after it is destroyed:
        // the break-up is the picture.
        || (goneAt.get(s.bodyId) ?? -Infinity) > t - 3) ? s.bodyId : null;

  /** Where in a world's orbit a scene's action is: the centroid of the
   *  hulls there when the scene was first framed (drawn-radius units). */
  const sceneFocus = new Map<ReelScene, { ang: number; r: number; side: number }>();
  const focusOf = (s: ReelScene, subj: string) => {
    const hit = sceneFocus.get(s);
    if (hit) return hit;
    let sx = 0, sy = 0, n = 0;
    for (const [, v] of lastSeen) {
      if (v.body !== subj) continue;
      sx += Math.cos(v.ang) * v.rFrac; sy += Math.sin(v.ang) * v.rFrac; n++;
    }
    const seed = (hashStr(`${s.from}:${subj}`) % 1000) / 1000;
    const f = n >= 3 && Math.hypot(sx, sy) / n > 0.2
      ? { ang: Math.atan2(sy, sx), r: Math.min(2.5, Math.hypot(sx, sy) / n), side: seed < 0.5 ? -1 : 1 }
      : { ang: seed * Math.PI * 2, r: 1.6, side: seed < 0.5 ? -1 : 1 };
    // Only settle once hulls have been seen there, or the first frame
    // would pin a guess for the whole scene.
    if (n >= 3) sceneFocus.set(s, f);
    return f;
  };
  /** A battle at a world the film has already fought over. */
  const repeatVisit = (s: ReelScene) => {
    for (const x of scenes) {
      if (x === s) return false;
      if (x.kind === 'battle' && x.bodyId === s.bodyId) return true;
    }
    return false;
  };

  /** A scene's own frame at an instant, with its slow drift. */
  const frameOf = (s0: ReelScene | undefined, t: number, prog: number): Frame => {
    // The cold open is framed as the battle it shows.
    const s = s0 && s0.kind === 'intro' && teaser ? teaser : s0;
    const subj = viewMode === 'wide' ? null : subjectOf(s, t);
    if (!s || !subj) {
      const f = systemFrame(s, t);
      return { ...f, scale: f.scale * (1 + 0.025 * prog) };
    }
    let share = WORLD_SUBJECT;
    // FRAME WHAT IS THERE, not the planet: the whole layout of the ships
    // at the world (both lines, the station) inside the space between the
    // graphics. A big battle is a wider shot than a skirmish, and a world
    // whose news is a fleet arriving shows the fleet.
    const reach = Math.max(sceneExtent.get(s) ?? 0, battleReach.get(subj) ?? 0)
      || (s.framing === 'battle' ? 2.2 : 0);
    if (reach) sceneExtent.set(s, reach);
    if (s.framing === 'battle') share = Math.min(BATTLE_SUBJECT * 1.4, 0.34 / reach);
    else if (reach) share = Math.min(WORLD_SUBJECT * 1.3, 0.34 / reach);
    // THE LEVIATHAN is drawn at over four times its world's width: a
    // shot framed on the world had the beast off the edge of it.
    const k0 = s.beat?.kind ?? '';
    if (/^kaiju_/.test(k0) || s.beat?.data?.cause === 'kaiju') share = Math.min(share, 0.05);
    if (/^kaiju_/.test(k0) || s.beat?.data?.cause === 'kaiju') share = Math.max(share, 0.07);
    const f = bodyFrame(subj, t, share);
    // THE DIRECTOR INSIDE THE SHOT. A locked-off frame for seven seconds
    // read as a still, however much was dying in it. A battle opens wide,
    // pushes in toward where the fleets are thickest, and eases back as
    // the verdict lands; a second fight at the same world is shot from the
    // other side, tighter. A world's news drifts across the frame.
    const sm = (a: number, b: number, v: number) => { const q = Math.max(0, Math.min(1, (v - a) / (b - a))); return q * q * (3 - 2 * q); };
    let k: number, offFrac = 0, lateral = 0;
    const foc = focusOf(s, subj);
    let sweep = 0;
    if (s.framing === 'battle' && s.seconds > 7) {
      // A BIG BATTLE IS THREE SETUPS in one continuous move: the whole
      // fight established wide, a push in that sweeps round the orbit
      // through the thick of it, and a pull back out for the verdict.
      const inn = sm(0.06, 0.42, prog), out = sm(0.64, 0.96, prog);
      k = 0.8 + 0.52 * inn - 0.6 * out;
      offFrac = 0.55 * inn * (1 - out);
      sweep = (sm(0.2, 0.7, prog) - 0.5) * 1.1 * foc.side;
    } else if (s.framing === 'battle') {
      const again = repeatVisit(s);
      const push = sm(0, 0.62, prog) - 0.55 * sm(0.72, 1, prog);
      k = (again ? 1.12 : 0.86) + (again ? 0.22 : 0.36) * push;
      offFrac = 0.5 * push * (again ? -1 : 1);
    } else {
      k = 1 + 0.16 * prog;
      lateral = (prog - 0.5) * 0.14 * (foc.side);
    }
    const rw = drawnWorldR(byGame.get(subj)!) * foc.r;
    const ang = foc.ang + sweep;
    const cx = Math.cos(ang) * rw * offFrac, cy = Math.sin(ang) * rw * offFrac;
    const sc = f.scale * k;
    return { x: f.x + cx + (lateral * W) / sc,
      y: f.y - (H / 2 - H * FOCUS_Y) / f.scale + (H / 2 - H * FOCUS_Y) / sc + cy,
      scale: sc };
  };

  /** Where a world point lands on screen under a frame. */
  const onScreen = (f: Frame, p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - f.x) * f.scale, y: H / 2 + (p.y - f.y) * f.scale });

  const toPx = (p: { x: number; y: number }) => onScreen(cam, p);

  /** How "wide" the shot is right now: 1 = the system, 0 = a world. The
   *  overlay uses it to swap the standings for the battle tally. */
  let overview = 1;

  /** Each scene's travel in, seconds (fixed per scene: captions wait on it). */
  const travelSeconds = new Map<ReelScene, number>();
  /** The move playing now: the world it is travelling to, and how far. */
  let travel: { to: string; e: number } | null = null;
  /**
   * The smooth zoom-and-pan path from one frame to another (van Wijk and
   * Nuij, 2003): out as far as the distance needs, across, and in. `S` is
   * its length; `at(e)` the frame at a share of it.
   */
  const zoomPath = (a: Frame, b: Frame) => {
    const rho = 1.42;
    const w0 = W / a.scale, w1 = W / b.scale;
    const dx = b.x - a.x, dy = b.y - a.y;
    const u1 = Math.hypot(dx, dy);
    if (u1 < 1e-6 * Math.max(w0, w1)) {
      const S = Math.abs(Math.log(w1 / w0)) / rho;
      return { S, at: (e: number) => ({ x: a.x + dx * e, y: a.y + dy * e, scale: W / (w0 * Math.pow(w1 / w0, e)) }) };
    }
    const bI = (i: 0 | 1) => {
      const wi = i ? w1 : w0;
      return (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho ** 4 * u1 * u1) / (2 * wi * rho * rho * u1);
    };
    const rI = (i: 0 | 1) => { const bb = bI(i); return Math.log(-bb + Math.sqrt(bb * bb + 1)); };
    const r0 = rI(0), r1 = rI(1);
    const S = (r1 - r0) / rho;
    const at = (e: number) => {
      const sv = S * e;
      const u = (w0 / (rho * rho)) * (Math.cosh(r0) * Math.tanh(rho * sv + r0) - Math.sinh(r0));
      const w = (w0 * Math.cosh(r0)) / Math.cosh(rho * sv + r0);
      return { x: a.x + (dx * u) / u1, y: a.y + (dy * u) / u1, scale: W / w };
    };
    return { S: Number.isFinite(S) ? S : 0, at };
  };

  /** True while a frame is laid out unseen at the shot's destination. */
  let priming = false;
  /** A leg's ease: gentle at both ends, even through the middle. */
  const easeLeg = (q: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, q)));
  /**
   * HOW THE CAMERA GETS THERE. Between two worlds: up to a frame that
   * holds both and the star (so where it is reads on the map), a beat to
   * read it, and down on the next world. To or from the system shot: one
   * leg. Each leg runs evenly along its zoom-and-pan path; an S-curve over
   * the whole move put all of it in eight frames.
   */
  const travelPlan = (s: ReelScene, a: Frame, b: Frame, subj: string | null, fromSubj: string | null, t: number) => {
    const both = !!subj && !!fromSubj;
    let peak: Frame | null = null;
    if (both) {
      const star = pos(systemOf(subj!), t);
      const pts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, star];
      const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
      const y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
      const m = safe();
      const sc = Math.min(a.scale, b.scale,
        Math.min((W - m.side * 2) / Math.max(1, x1 - x0), (H - m.top - m.bottom) / Math.max(1, y1 - y0)) * 0.8);
      peak = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale: Math.max(MIN_CAMERA_SCALE, sc) };
    }
    const legs = peak ? [zoomPath(a, peak), zoomPath(peak, b)] : [zoomPath(a, b)];
    // A leg from a close-up to the whole system is a ~1,000x zoom: under a
    // second it ran 40% a frame (a whoosh, measured), so a long one takes
    // up to 1.6 s.
    const legSec = legs.map(l => Math.max(1.1, Math.min(1.6, 0.8 + 0.14 * l.S)));
    const hold = peak ? 0.35 : 0;
    let total = legSec.reduce((x, y) => x + y, 0) + hold;
    // Never more than half the scene: the moment still has to land.
    const room = s.seconds * 0.62;
    const k = total > room ? room / total : 1;
    total *= k;
    const l0 = legSec[0] * k, h = hold * k;
    travelSeconds.set(s, total);
    return {
      total, end: b,
      at: (el: number) => {
        if (!peak) { const e = easeLeg(el / l0); return { frame: legs[0].at(e), e }; }
        if (el < l0) return { frame: legs[0].at(easeLeg(el / l0)), e: 0.5 * (el / l0) };
        if (el < l0 + h) return { frame: peak, e: 0.5 };
        const q = (el - l0 - h) / Math.max(0.01, total - l0 - h);
        return { frame: legs[1].at(easeLeg(q)), e: 0.5 + 0.5 * q };
      },
    };
  };

  const aim = (tClock: number) => {
    if (!scenes.length) rebuildShots();
    const idx = Math.max(0, scenes.findIndex(x => tClock >= x.from && tClock < x.to));
    const s = scenes[idx] ?? scenes[scenes.length - 1];
    const prev = idx > 0 ? scenes[idx - 1] : undefined;
    const t0 = filmSecondsAt(scenes, s?.from ?? tClock);
    const el = filmSecondsAt(scenes, tClock) - t0;
    const prog = s ? Math.max(0, Math.min(1, el / Math.max(0.01, s.seconds))) : 0;
    // World positions at the time on SCREEN (the cold open shows a later
    // moment than the clock reads).
    const t = dispT;
    let f = frameOf(s, t, prog);
    const subj = viewMode === 'wide' ? null : subjectOf(s, t);
    let wideNow = subj ? 0 : 1;

    // THE CAMERA TRAVELS BETWEEN WORLDS (Lorne, 2026-10-22: "zoom out and
    // in on planets, so players keep a spatial understanding of where
    // everything is"). Every change of subject is one continuous move on
    // the van Wijk-Nuij path: out over the map as far as the distance
    // needs, across, and in on the next world, which is marked on the way.
    // A scene skipped as a time cut is not a shot: travel from the last
    // one actually seen.
    let from: ReelScene | undefined = prev;
    for (let j = idx - 1; j >= 0 && from && from.seconds < 0.01; j--) from = scenes[j - 1];
    const fromSubj = viewMode === 'wide' ? null : subjectOf(from, t);
    // Out of the cold open is a cut: the clock has jumped back.
    const fromTeaser = from?.kind === 'intro' && !!teaser;
    travel = null;
    if (s && from && !fromTeaser && !priming && !(subj && fromSubj === subj) && (subj || fromSubj)) {
      const a = frameOf(from, t, 1);
      const plan = travelPlan(s, a, f, subj, fromSubj, t);
      if (el < plan.total) {
        const at = plan.at(el);
        f = at.frame;
        // How wide the frame is, between the close shots and the system:
        // the standings fade in with the map, out with the world.
        const sys = systemFrame(undefined, t);
        const wClose = Math.min(W / a.scale, W / plan.end.scale) || 1, wSys = W / sys.scale;
        wideNow = Math.max(0, Math.min(1, Math.log(Math.max(1, (W / f.scale) / wClose))
          / Math.max(0.1, Math.log(Math.max(1.01, wSys / wClose)))));
        if (!subj) wideNow = Math.max(wideNow, at.e);
        if (subj) travel = { to: subj, e: at.e };
      }
    }
    overview = wideNow;
    curFocus = subj;
    curScene = s;
    cam.x = f.x; cam.y = f.y; cam.scale = f.scale;
  };
  // ---- starfield (own, cheap, parallaxed) ------------------------------
  const stars: Array<[number, number, number]> = [];
  {
    const rnd = mulberry32(0x5a7e);
    for (let i = 0; i < 420; i++) stars.push([rnd(), rnd(), 0.4 + rnd() * 1.4]);
  }

  // ---- textures --------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- bodyLike
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- transiting
  let transiting = new Set<string>();
  /** The body this scene is about, so the frame can spend detail on it. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- curFocus
  let curFocus: string | null = null;
  /**
   * Where each hull was last drawn, as an offset from its world in map
   * units. A hull that dies is gone from the next tick's record, and its
   * blast has to go off where it WAS -- in its battle line, not at some
   * spot on a ring the film made up.
   */
  const lastSeen = new Map<string, { body: string; ang: number; rFrac: number }>();
  /**
   * THE DYSON SPHERE, rebuilt from the log: begun, its 25/50/75%
   * milestones, the last damage report, complete at an engineering win.
   * The game draws the lattice from this (drawDysonLattice); the film
   * never passed it, so the victory the match was won by was never seen.
   */
  const dysonKeys: Array<[number, number]> = [];
  let dysonDone: number | null = null;
  for (const r of summary.chronicle ?? []) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(r.payload || '{}') ?? {}; } catch { /* ignore */ }
    if (r.kind === 'dyson_initiated') dysonKeys.push([r.tick_number, 0]);
    else if (/^dyson_(milestone|damaged)$/.test(r.kind) && typeof p.pct === 'number') {
      // A strike's row says where the Sphere fell TO; it stood higher
      // the tick before, which is what the meter must read going in (it
      // read 97% under "A last strike on the Sphere at 99%").
      const max = Number(p.max_hp), before = Number(p.hp) + Number(p.progress_lost);
      const prevT = dysonKeys.length ? dysonKeys[dysonKeys.length - 1][0] : -Infinity;
      if (r.kind === 'dyson_damaged' && max > 0 && before > 0 && r.tick_number - 1 > prevT) {
        dysonKeys.push([r.tick_number - 1, Math.min(1, before / max)]);
      }
      dysonKeys.push([r.tick_number, p.pct / 100]);
    } else if (r.kind === 'dyson_collapsed') dysonKeys.push([r.tick_number, 0]);
    else if (r.kind === 'victory' && p.victoryType === 'engineering') dysonDone = r.tick_number;
  }
  const dysonAt = (t: number): { progress: number; complete: boolean } | undefined => {
    if (!dysonKeys.length || t < dysonKeys[0][0]) return undefined;
    if (dysonDone != null && t >= dysonDone) return { progress: 1, complete: true };
    let i = dysonKeys.length - 1;
    while (i > 0 && dysonKeys[i][0] > t) i--;
    const [t0, p0] = dysonKeys[i];
    const next = dysonKeys[i + 1] ?? (dysonDone != null ? [dysonDone, 1] as [number, number] : null);
    const p = next ? p0 + (next[1] - p0) * Math.max(0, Math.min(1, (t - t0) / Math.max(1, next[0] - t0))) : p0;
    return { progress: p, complete: false };
  };
  /** The last frame's presentation, for work done before this frame's. */
  let lastPres: ReturnType<typeof computePresentation> | null = null;
  /** A world's drawn radius in map units at the current zoom. */
  const drawnWorldR = (b: GameBody) =>
    drawnRadiusOf(lastPres, b, cam.scale) / Math.max(1e-6, cam.scale);
  /** Harness probe: what the planner was given. */
  let lastFacts: unknown = null;
  /** Harness probe: what the last frame drew at the scene's subject. */
  let probing = false;
  let lastProbe: unknown = null;

  function setTick(tick0: number, frac0: number) {
    let tick = tick0, frac = frac0;
    dispT = tick0 + frac0;
    clockT = dispT;
    // THE COLD OPEN: while the title card is up, the screen shows the
    // match's deadliest fight, two ticks of it at battle pace.
    const s = scenes.length ? scenes.find(x => dispT >= x.from && dispT < x.to) : undefined;
    if (s && s.kind === 'intro' && teaser && viewMode !== 'wide') {
      const u = Math.max(0, Math.min(1, (dispT - s.from) / Math.max(1, s.to - s.from)));
      const span = Math.min(2.5, teaser.to - teaser.from - 0.01);
      const mid = Math.max(teaser.from, (teaser.from + teaser.to) / 2 - span / 2);
      dispT = mid + u * span;
      tick = Math.floor(dispT); frac = dispT - tick;
    }
    if (tick !== worldTick) {
      world = timeline.worldAt(tick);
      worldTick = tick;
    }
    curTick = tick; curFrac = frac;
    aim(tick0 + frac0);
  }

  // ---- render ----------------------------------------------------------
  /** The scene the last frame was framed for. */
  let primedFor: ReelScene | undefined | null = null;
  /**
   * FRAMED RIGHT ON THE FIRST FRAME. A shot's framing reads the fleet
   * layout at its world (battleReach), which only a drawn frame measures:
   * the first frame after every cut was framed without it and the second
   * re-framed, a 26% zoom pop after each cut. On a new scene, a frame is
   * laid out unseen first, and the camera aimed again from it.
   */
  function render() {
    if (curScene !== primedFor) {
      primedFor = curScene;
      // Every scene change is a cut: nothing carries over from the shot
      // before (see forgetDrawnShips).
      forgetDrawnShips();
      forgetBattleGlides();
      if (curFocus) {
        battleReach.delete(curFocus);
        if (curScene) sceneExtent.delete(curScene);
        // Laid out AT THE DESTINATION: a world is only measured once it is
        // on screen, and a travel starts far from it, so the framing
        // snapped as it arrived (a 20% zoom pop on the last frames).
        const was = tracing;
        tracing = false;
        priming = true;
        aim(clockT);
        renderOnce();
        priming = false;
        tracing = was;
        aim(clockT);
      }
    }
    renderOnce();
  }
  function renderOnce() {
    const t = curTick + curFrac;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, W, H);
    // FULL BLEED. The film is the map edge to edge; its graphics float
    // over it (filmOverlay), so there is no panel to keep clear of.
    ctx.save();

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
    if (adaptedTick !== curTick) {
      // ADAPTED STATE IS PER TICK, NOT PER FRAME. The roster only changes
      // when the tick does; rebuilding it on every animation frame threw
      // away a Ship object per hull sixty times a second.
      adaptedTick = curTick;
      adaptedStls = adaptSettlements(world);
      adaptedLegs = legsAt(curTick, t);
      adaptedShips = adaptShips(world, t, adaptedLegs,
        id => byGame.get(id)?.radius ?? 4,
        id => {
          const b = byGame.get(id);
          return b ? bodyPosition(b, t, gameBodies) : null;
        },
        summary.parts);
    }
    // WHERE A CROSSING RUNS, every frame. The record knows only which
    // world a hull left and which it reached, and the crossing used to
    // run centre to centre: every departing hull rose out of the middle
    // of its planet's disc and drifted slowly outward (at a close-up's
    // pace, a fleet leaving read as fleas falling off the world), and
    // every arrival sank into the next one's core. A crossing now leaves
    // from where the hull was parked, riding its world, and ends on the
    // destination's parking band, facing the way it came in.
    for (const sh of adaptedShips) {
      const leg = adaptedLegs.get(sh.id);
      if (!leg || !sh.transit) continue;
      const a = byGame.get(leg.from), b = byGame.get(leg.to);
      if (!a || !b) continue;
      const pa = bodyPosition(a, t, gameBodies);
      const pb = bodyPosition(b, t, gameBodies);
      const ra = drawnWorldR(a), rb = drawnWorldR(b);
      const seen = lastSeen.get(sh.id);
      const from = seen && seen.body === a.id
        ? { x: pa.x + Math.cos(seen.ang) * seen.rFrac * ra, y: pa.y + Math.sin(seen.ang) * seen.rFrac * ra }
        : (() => { const d = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
          return { x: pa.x + (pb.x - pa.x) / d * ra * 2.1, y: pa.y + (pb.y - pa.y) / d * ra * 2.1 }; })();
      const d2 = Math.hypot(from.x - pb.x, from.y - pb.y) || 1;
      const to = { x: pb.x + (from.x - pb.x) / d2 * rb * 2.1, y: pb.y + (from.y - pb.y) / d2 * rb * 2.1 };
      const span = Math.max(1, leg.arrive - leg.depart);
      const u = Math.max(0, Math.min(1, (t - leg.depart) / span));
      const e = u * u * (3 - 2 * u);
      sh.transit.pos.x = from.x + (to.x - from.x) * e;
      sh.transit.pos.y = from.y + (to.y - from.y) * e;
      const plan = sh.transit.currentTransfer;
      if (plan) {
        plan.startPos = { x: from.x, y: from.y };
        plan.interceptPos = { x: to.x, y: to.y };
      }
    }
    const gameSettlements = adaptedStls;
    const legs = adaptedLegs;
    const gameShips = adaptedShips;

    // Worlds with a battle running on this tick, straight off the record.
    const fightingNow = new Set<string>();
    for (const b of summary.battles) {
      if (!b.body_id) continue;
      if (curTick >= b.started_tick
        && curTick <= (b.ended_tick ?? b.started_tick)) fightingNow.add(b.body_id);
    }

    // Ownership is a per-tick fact stamped onto the shared bodies.
    const ownerOf = new Map<string, string>();
    for (const st of gameSettlements) ownerOf.set(st.bodyId, st.ownedBy);
    for (const b of gameBodies) {
      const o = ownerOf.get(b.id);
      if (o) b.ownedBy = o; else delete (b as { ownedBy?: string }).ownedBy;
    }

    // FORMATIONS BEFORE THE CONTEXT. Hulls sharing a course fly one line
    // in an arrowhead round their true position (computeTransitFormations)
    // instead of stacking nine sprites on one point. The line and the hull
    // both read this map, which is why it has to exist before either.
    const transitFormations = computeTransitFormations(gameShips);

    const rc: RenderContext = {
      ctx, canvas,
      camera: { x: cam.x, y: cam.y, scale: cam.scale },
      t,
      transitFormations,
      bodies: gameBodies,
      factions: gameFactions,
      settlements: gameSettlements,
      dysonSphere: dysonAt(t),
      nowMs: performance.now(),
      // WHERE THE HULLS ACTUALLY LANDED. drawShip writes each sprite's
      // true centre here after every offset it applies -- orbit phase,
      // tick interpolation, formation spread. The tracer code below used
      // to re-derive those positions and drift off the visible ship;
      // now it fires from where the ship was really drawn.
      shipHitboxes: new Map<string, { x: number; y: number; r: number }>(),
    };

    const shown = (b: GameBody) =>
      (b.destroyedAtTick == null || curTick < b.destroyedAtTick)
      && !((appearsAt.get(b.id) ?? -Infinity) > curTick)
      && !((goneAt.get(b.id) ?? Infinity) <= curTick);

    // THE MULTIPLAYER MAP'S PRESENTATION (bodyPresentation.ts): every
    // world's drawn size, moons folding into their planet at a distance,
    // and which world a folded world's ships count toward. This is what
    // the players looked at all match, so it is what their film shows.
    const posPx = new Map<string, { x: number; y: number }>();
    const liveBodies = gameBodies.filter(shown);
    const liveById = new Map(liveBodies.map(b => [b.id, b]));
    rc.presentation = computePresentation(liveBodies, cam.scale, id => {
      const hit = posPx.get(id);
      if (hit) return hit;
      const b = liveById.get(id);
      if (!b) return null;
      const cp = toPx(bodyPosition(b, t, gameBodies));
      posPx.set(id, cp);
      return cp;
    }, curFocus, { w: W, h: H }, null, curTick);
    const pres = rc.presentation;
    lastPres = pres;
    const hostOf = (id: string) => pres.host.get(id) ?? id;

    // VIEWPORT CULL.
    //
    // rc.bodies stays the COMPLETE list -- bodyPosition walks it for
    // parents and computeSystemRegions is a system-wide answer -- but
    // nothing off camera needs painting. The live game gets away without
    // this because it sits at map zoom most of the time; the film spends
    // half its length pushed in on one world, where fifty-two of
    // fifty-three worlds are off screen and were still being drawn in
    // full: texture, cloud deck, ownership ring, settlement structures.
    const MARGIN = 160;
    const onCamera = (b: GameBody) => {
      const cp = toPx(bodyPosition(b, t, gameBodies));
      const r = drawnRadiusOf(pres, b, cam.scale);
      return cp.x + r > -MARGIN && cp.x - r < W + MARGIN
        && cp.y + r > -MARGIN && cp.y - r < H + MARGIN;
    };
    const visible = gameBodies.filter(b => shown(b) && onCamera(b));
    const visibleIds = new Set(visible.map(b => b.id));

    // The label layer is a per-frame queue: drawBody REQUESTS a name and
    // nothing appears until it is flushed. Without this the recap drew a
    // map with no world names on it at all -- which is exactly what the
    // first frame off the new renderer showed.
    resetReservations();

    drawStarfield(starfield, rc);
    // The territory wash, quieter than the live map: on a film frame the
    // worlds and the fleets carry the picture, and full-strength bands
    // read as a target, not a solar system.
    ctx.save();
    // Mid-move (part way between a close shot and the system) the bands
    // sweep the whole frame: keep them low then, so a move is never a flash.
    // ...and continuous: a switch at 5% and 95% of the move popped the
    // bands on and off between two frames.
    // (and lower still while the camera travels: the bands at mid zoom
    // fill the frame, and swept through they read as a strobe).
    ctx.globalAlpha = 0.32 * (1 - (travel ? 0.9 : 0.5) * Math.sin(Math.PI * Math.max(0, Math.min(1, overview))));
    drawSystemRegions(
      computeSystemRegions(gameBodies, gameFactions, gameSettlements), rc);
    ctx.restore();

    // Cosmetic specks through the belt, so it stops reading as five
    // lonely rocks all sitting at the same radius.
    drawAsteroidBeltDust(rc);

    for (const b of visible) {
      if (!b.parent) continue;
      drawOrbit(b, rc, withOpacity(b.color, 0.35));
    }

    // Names, placed by the game's own collision planner -- the thing this
    // file spent four rounds reimplementing as a `placed[]` array.
    const cands: Array<{ id: string; x: number; belowAnchor: number;
      aboveAnchor: number; width: number; priority: number }> = [];
    for (const b of visible) {
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

    for (const b of visible) {
      // Yields off: a recap is a film, not an intel screen.
      drawBody(b, rc, false, false, false, labelRows.get(b.id) ?? 0, false);
    }

    // WHO HOLDS THIS WORLD, AT CLOSE RANGE.
    //
    // drawOwnershipLayer bails out once the system wash is fully faded
    // in, because at map zoom the wash IS the territory answer. The
    // corollary is the half of the film that is pushed in, where the
    // wash has faded and this layer is the only thing saying who owns
    // what -- and it was never called, so close shots carried no
    // ownership information at all. Drawn after the bodies so the halo
    // sits around the world rather than under it.
    drawOwnershipLayer(visible, rc);

    for (const st of gameSettlements) {
      if (!visibleIds.has(st.bodyId)) continue;
      const b = byGame.get(st.bodyId);
      if (b) drawSettlement(st, b, gameFactions, rc);
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

    // KILLS LAND THROUGH THE TICK. The record says only which hulls are
    // gone by the next tick, and every one of them used to blow up on the
    // tick boundary: one flash a second and then a still battle. Each
    // now goes at its own moment within the tick, on a seed from its id.
    const vanishAt = new Map<string, number>();
    for (const d of deathAt.get(curTick + 1) ?? []) vanishAt.set(d.id, killPhase(d.id));

    // THE GAME'S WHOLE-ORBIT LAYOUT, AT EVERY WORLD (battleLayoutLive):
    // whoever is parked takes as much of the orbit as their ships need,
    // each side its own contiguous share facing the others across open
    // space, the station opposite the fight. It is how a battle looks in
    // the game, so it is how the film's battles look.
    const formationOf = new Map<string, ShipFormation>();
    const liveBattles = new Map<string, LiveBattle>();
    /** 0 = a count chip, 1 = the hulls themselves (hullReveal). */
    const revealOf = (bid: string) =>
      hostOf(bid) !== bid ? 0 : hullReveal(byGame.get(bid), cam.scale);
    for (const [bid, atBody] of parked) {
      const body = byGame.get(bid);
      if (!body || !visibleIds.has(bid) || revealOf(bid) <= 0.01) continue;
      atBody.sort((a, b) => (a.id < b.id ? -1 : 1));
      const units: BattleUnit[] = atBody.map(x => ({
        id: x.id, owner: x.ownedBy, group: null,
        sizePx: shipIconSize(x.class, false),
        armed: (getShipClass(x.class)?.damagePerTick ?? 0) > 0,
      }));
      const owners = [...new Set(atBody.map(x => x.ownedBy))].sort();
      const station = gameSettlements.find(st => st.bodyId === bid && st.type === 'station');
      const lb = liveBattleFor(bid, body.radius, atBody[0].orbit.direction ?? 1,
        units, owners, station?.id);
      liveBattles.set(bid, lb);
      for (const u of units) formationOf.set(u.id, { index: 0, total: 1, battle: lb });
    }
    rc.liveBattles = liveBattles;
    for (const [bid, lb] of liveBattles) {
      battleReach.set(bid, Math.max(1.2, (lb.layout.band?.rOut ?? lb.refR * 2) / lb.refR));
    }

    // Where the hulls are too small to read, the game shows a count per
    // empire instead; so does the film.
    const chips: Array<{ bid: string; counts: Map<string, number>; alpha: number }> = [];
    const chipAgg = new Map<string, Map<string, number>>();
    for (const [bid, arr] of parked) {
      const rv = revealOf(bid);
      if (rv < 0.99) {
        const host = hostOf(bid);
        if (!visibleIds.has(host) && !visibleIds.has(bid)) continue;
        let m = chipAgg.get(host);
        if (!m) { m = new Map(); chipAgg.set(host, m); }
        for (const sh of arr) if (sh.ownedBy) m.set(sh.ownedBy, (m.get(sh.ownedBy) ?? 0) + 1);
      }
      if (rv <= 0.01) continue;
      const sz = hullSize(byGame.get(bid), cam.scale);
      ctx.save();
      ctx.globalAlpha = rv;
      for (const sh of arr) {
        // A hull that dies this tick goes when its own blast does.
        if ((vanishAt.get(sh.id) ?? 2) <= curFrac) continue;
        drawShip(sh, rc, false, formationOf.get(sh.id), sz);
      }
      ctx.restore();
    }
    for (const [host, counts] of chipAgg) {
      chips.push({ bid: host, counts, alpha: 1 - revealOf(host) });
    }

    if (probing) {
      const bid = curFocus;
      const at = bid ? (parked.get(bid) ?? []) : [];
      lastProbe = { focus: bid, scale: cam.scale, parked: at.length,
        reveal: bid ? revealOf(bid) : null, host: bid ? hostOf(bid) : null,
        visible: bid ? visibleIds.has(bid) : null,
        drawnR: bid && byGame.get(bid) ? drawnRadiusOf(pres, byGame.get(bid)!, cam.scale) : null,
        reach: bid ? battleReach.get(bid) ?? null : null,
        hits: at.slice(0, 6).map(sh => { const h = rc.shipHitboxes?.get(sh.id); return h ? [Math.round(h.x), Math.round(h.y)] : null; }),
        center: bid ? toPx(pos(bid, t)) : null,
        lb: (() => {
          const lb = bid ? liveBattles.get(bid) : undefined;
          if (!lb || !at.length) return null;
          const pl = battlePlacement(lb, at[0].id, performance.now());
          return { refR: lb.refR, placed: lb.layout.placements.size, band: lb.layout.band,
            k: battleScale(lb, drawnRadiusOf(pres, byGame.get(bid!)!, cam.scale)),
            pl: pl ? [Math.round(pl.x), Math.round(pl.y)] : null,
            orbit: [at[0].orbit.parentBodyId, Math.round(at[0].orbit.rp ?? 0), at[0].class],
            formation: !!formationOf.get(at[0].id)?.battle };
        })() };
    }
    // Remember where each hull was drawn, against its world, in units of
    // the world's DRAWN radius (as fxAnchor does). Far out a world is drawn
    // several times its true size and its battle layout with it, so an
    // offset kept in map units from a wide shot put a close-up's blasts
    // out in empty space, radii away from the fight.
    for (const sh of gameShips) {
      if (sh.transit) continue;
      const hb = rc.shipHitboxes?.get(sh.id);
      const host = byGame.get(sh.orbit.parentBodyId);
      if (!hb || !host) continue;
      const c0 = toPx(bodyPosition(host, t, gameBodies));
      const r0 = drawnRadiusOf(pres, host, cam.scale);
      if (!(r0 > 0)) continue;
      lastSeen.set(sh.id, { body: host.id,
        ang: Math.atan2(hb.y - c0.y, hb.x - c0.x), rFrac: Math.hypot(hb.x - c0.x, hb.y - c0.y) / r0 });
    }

    // SHIPS THAT DIED IN THE LAST SIX TICKS ARE STILL ON SCREEN.
    // spawnWreck is a one-shot per hull, so it is guarded -- and the
    // guard is dropped when the clock runs backwards, or scrubbing back
    // over a battle would show no wreckage the second time.
    if (curTick < lastDeathTick) spawnedWrecks.clear();
    lastDeathTick = curTick;
    // ONE ANSWER FOR WHERE A HULL DIED. The blast used to come from
    // enqueueDetonation, which positions on bodyPosition(bodyId) -- it
    // exists for asteroid impacts AT a world, so every explosion went
    // off at the planet's centre while the wreckage it belonged to sat
    // correctly out on the parking ring. Two places deciding one
    // position is how they came to disagree, so now there is one.
    const deathPos = (shipId: string, bodyId: string, atTick: number) => {
      const host = byGame.get(bodyId);
      if (!host) return null;
      const bp = bodyPosition(host, atTick, gameBodies);
      // The world's drawn radius, in map units, at this zoom.
      const rw = drawnRadiusOf(pres, host, cam.scale) / cam.scale;
      // Where it was last drawn, when the film saw it.
      const seen = lastSeen.get(shipId);
      if (seen && seen.body === bodyId) {
        return { x: bp.x + Math.cos(seen.ang) * seen.rFrac * rw, y: bp.y + Math.sin(seen.ang) * seen.rFrac * rw };
      }
      const ring = rw * 2.1;
      const ang = ((hashStr(shipId) % 1000) / 1000) * Math.PI * 2;
      return { x: bp.x + Math.cos(ang) * ring, y: bp.y + Math.sin(ang) * ring };
    };
    for (let dt = Math.max(0, curTick - 6); dt <= curTick + 1; dt++) {
      for (const d of deathAt.get(dt) ?? []) {
        // When it went: its own moment within the tick before it was gone.
        const tb = dt - 1 + killPhase(d.id);
        if (t < tb) continue;
        // Where the hull is NOW relative to its world, at the world's
        // position NOW: computed at the death tick, the blast stayed where
        // the world had been while the world moved on along its orbit.
        const wp = deathPos(d.id, d.body, t);
        if (!wp) continue;
        if (!spawnedWrecks.has(d.id)) {
          spawnedWrecks.add(d.id);
          // ANCHORED TO THE WORLD (fxAnchor), at the hull's own size: a
          // wreck is the dead hull's picture breaking up, and stored as a
          // point in space it hung there while the world sailed on --
          // ship-shaped debris peeling off a moving planet like fleas.
          spawnWreck(d.id, wp, shipIconSize(d.cls, false) * hullSize(byGame.get(d.body), cam.scale),
            performance.now(), tb, { bodyId: d.body, dir: 1 });
        }
        // The blast, on the GAME clock like the wreckage it belongs to.
        // A wall-clock flash would be a different length of film at
        // 0.3s a tick than at 2.4s, and the director changes that pace
        // scene by scene.
        const k = (t - tb) / BLAST_TICKS;
        if (k >= 0 && k < 1) {
          const cp = toPx(wp);
          if (d.cls === 'kaiju') {
            // THE LEVIATHAN GOES UP AT ITS OWN SIZE: a 60 px fireball under
            // a 400 px monster read as it blinking out. One blast the size
            // of the body it was drawn at, and the body bursting along its
            // length after it.
            const R = Math.max(60, lastBeastR.get(d.id) ?? 0);
            drawBlast(ctx, cp.x, cp.y, k, d.id, (R * 1.1) / 10);
            for (let j = 1; j <= 3; j++) {
              const kj = (t - tb - j * 0.12) / BLAST_TICKS;
              if (kj <= 0 || kj >= 1) continue;
              const a = (hashStr(`${d.id}:${j}`) % 628) / 100;
              drawBlast(ctx, cp.x + Math.cos(a) * R * 0.6, cp.y + Math.sin(a) * R * 0.6, kj, `${d.id}:${j}`, (R * 0.55) / 10);
            }
          } else {
            drawBlast(ctx, cp.x, cp.y, k, d.id, 1);
          }
          drawDebris(ctx, cp.x, cp.y, 10, k, d.id);
        }
      }
    }
    drawWrecks(rc, performance.now());
    // THE MOMENT A WORLD CHANGES HANDS, on the world. The ownership ring
    // flipping colour was the whole event, and a viewer never saw it: a
    // conquest is a shockwave in the taker's colour, a fall is a burst of
    // fire, landing on the tick the log stamps.
    {
      const b = curScene?.kind === 'beat' ? curScene.beat : undefined;
      const fx = b && b.body && /^(settlement_(seized|destroyed|razed)|faction_(eliminated|comeback|revived))$/.test(b.kind)
        ? b : undefined;
      const gb = fx?.body ? byGame.get(fx.body) : undefined;
      const k = fx ? (t - fx.tick + 0.15) / 1.2 : -1;
      if (fx && gb && visibleIds.has(gb.id) && k >= 0 && k < 1) {
        const cp = toPx(pos(gb.id, t));
        const rr = drawnRadiusOf(pres, gb, cam.scale);
        const takes = /seized|comeback|revived/.test(fx.kind);
        const col = takes && fx.fid ? colorOf(fx.fid) : '#ff9a4d';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(cp.x, cp.y, rr * 0.2, cp.x, cp.y, rr * 1.5);
        g.addColorStop(0, hexA(col, 0.55 * (1 - k)));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cp.x, cp.y, rr * 1.5, 0, Math.PI * 2); ctx.fill();
        for (const lag of [0, 0.18]) {
          const q = Math.max(0, Math.min(1, (k - lag) / (1 - lag)));
          if (q <= 0 || q >= 1) continue;
          const e = 1 - Math.pow(1 - q, 3);
          ctx.strokeStyle = hexA(col, 0.9 * (1 - q));
          ctx.lineWidth = Math.max(2, rr * 0.07 * (1 - q));
          ctx.beginPath(); ctx.arc(cp.x, cp.y, rr * (1.05 + 2.4 * e), 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
    }
    // THE OPENING ACT on the map: each empire pinned to its home world in
    // turn (the roll call), then every colony lighting up in its founder's
    // colour as it is settled (the land grab).
    if (curScene?.act === 'opening') {
      const fsNow = filmSecondsAt(scenes, clockT);
      const el0 = fsNow - filmSecondsAt(scenes, curScene.from);
      const u = unitOf(H);
      homes.forEach((h, i) => {
        const gb = byGame.get(h.body);
        const f = filmFaction(h.fid);
        if (!gb || !f || !shown(gb)) return;
        const k = Math.min((el0 - ROLL_CALL_AT - i * ROLL_CALL_STEP) / 0.3, (ROLL_CALL_END - el0) / 0.5);
        if (k <= 0) return;
        const cp = toPx(pos(gb.id, t));
        drawHomePin(ctx, H, f, cp.x, cp.y - drawnRadiusOf(pres, gb, cam.scale), k);
      });
      ctx.save();
      for (const b of built) {
        const k = (fsNow - b.at) / 1.1;
        if (k < 0 || k >= 1) continue;
        const gb = byGame.get(b.body);
        if (!gb || !shown(gb)) continue;
        const cp = toPx(pos(gb.id, t));
        const col = colorOf(b.fid);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = liftColor(col, 150);
        ctx.lineWidth = Math.max(1.5, 3 * u * (1 - k));
        ctx.beginPath(); ctx.arc(cp.x, cp.y, (8 + 34 * Math.sqrt(k)) * u, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = liftColor(col, 150);
        ctx.beginPath(); ctx.arc(cp.x, cp.y, 4 * u, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    // A WAR DECLARED on the map: while its banner is up, a red line from
    // the aggressor's capital to its target's.
    if (overview > 0.35) {
      const fsNow = filmSecondsAt(scenes, clockT);
      const capital = (fid: string) => {
        let best: string | null = null, pop = -1;
        for (const st of world.stls.values()) if (st.fid === fid && st.pop > pop && byGame.has(st.body)) { best = st.body; pop = st.pop; }
        return best;
      };
      ctx.save();
      for (const ts of toasts) {
        if (ts.kind !== 'war') continue;
        const k = (fsNow - ts.at) / TOAST_LIFE_SECONDS;
        if (k < 0 || k >= 1) continue;
        const ca = capital(ts.a), cb = capital(ts.b);
        if (!ca || !cb || ca === cb) continue;
        const pa = toPx(pos(ca, t)), pb = toPx(pos(cb, t));
        const grow = Math.min(1, k / 0.25);
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        const nx = -(pb.y - pa.y) * 0.18, ny = (pb.x - pa.x) * 0.18;
        ctx.globalAlpha = overview * Math.min(1, (1 - k) / 0.2) * 0.9;
        ctx.strokeStyle = '#ff5a4e';
        ctx.lineWidth = Math.max(2, 3 * unitOf(H));
        ctx.setLineDash([10 * unitOf(H), 7 * unitOf(H)]);
        ctx.beginPath();
        // Drawn out from the aggressor as it is declared.
        const steps = 24;
        for (let i = 0; i <= steps * grow; i++) {
          const q = i / steps;
          const x = (1 - q) * (1 - q) * pa.x + 2 * (1 - q) * q * (mx + nx) + q * q * pb.x;
          const y = (1 - q) * (1 - q) * pa.y + 2 * (1 - q) * q * (my + ny) + q * q * pb.y;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    // WHERE THE CAMERA IS GOING, marked on the map as it travels: a
    // reticle round the next world and its name, so the zoom out reads as
    // "here is where this is", not as a swoop.
    if (travel) {
      const gb = byGame.get(travel.to);
      if (gb && shown(gb)) {
        const cp = toPx(pos(gb.id, t));
        const u = unitOf(H);
        const rr = Math.max(drawnRadiusOf(pres, gb, cam.scale) * 1.45, 26 * u);
        const a = Math.min(1, travel.e / 0.15) * (1 - Math.max(0, (travel.e - 0.75) / 0.25));
        if (a > 0.01) {
          ctx.save();
          ctx.globalAlpha = a;
          ctx.strokeStyle = 'rgba(246,241,227,0.95)';
          ctx.lineWidth = Math.max(1.5, 2.5 * u);
          ctx.beginPath(); ctx.arc(cp.x, cp.y, rr, 0, Math.PI * 2); ctx.stroke();
          for (let q = 0; q < 4; q++) {
            const ang = q * Math.PI / 2 + Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(cp.x + Math.cos(ang) * rr * 1.08, cp.y + Math.sin(ang) * rr * 1.08);
            ctx.lineTo(cp.x + Math.cos(ang) * (rr * 1.08 + 12 * u), cp.y + Math.sin(ang) * (rr * 1.08 + 12 * u));
            ctx.stroke();
          }
          const nm = byId.get(gb.id)?.name ?? '';
          if (nm) {
            ctx.font = `400 ${Math.round(26 * u)}px "Audiowide", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(246,241,227,0.95)';
            ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6 * u;
            ctx.fillText(nm.toUpperCase(), cp.x, cp.y - rr - 18 * u);
          }
          ctx.restore();
        }
      }
    }
    // THE DYSON SPHERE, built where everyone can see it.
    if (dysonBodyId && visibleIds.has(dysonBodyId)) {
      const fin = finaleDyson();
      const dy0 = fin ?? dysonAt(t);
      const gb = byGame.get(dysonBodyId);
      if (dy0 && gb) {
        const cp = toPx(pos(dysonBodyId, t));
        const flare = fin ? fin.flare : 0;
        const rr = drawnRadiusOf(pres, gb, cam.scale);
        drawDysonShell(ctx, cp.x, cp.y, rr, dy0.progress, dy0.complete,
          dysonOwner ? colorOf(dysonOwner) : null, flare, performance.now(), fin ? fin.seal : undefined);
        // THE CLIMAX IS LIGHT FROM THE STAR, not a wash over the frame: a
        // bloom off the sealed shell and one shockwave rolling out across
        // the fleets. The frame's edges stay dark and the graphics, drawn
        // after this, stay crisp. (A full-frame white fill read as an
        // exposure glitch to every judge.)
        const fe = finaleEl();
        const a = fe - DYSON_SEALED_AT;
        if (fin && a >= 0 && a < 1.6) {
          const reach = Math.hypot(W, H);
          const pulse = a < 0.1 ? a / 0.1 : Math.exp(-(a - 0.1) * 2.6);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const R0 = rr * 1.6;
          const bloomR = R0 + (reach * 0.55 - R0) * Math.min(1, a / 0.35);
          const g = ctx.createRadialGradient(cp.x, cp.y, R0 * 0.3, cp.x, cp.y, bloomR);
          g.addColorStop(0, `rgba(255,246,226,${0.75 * pulse})`);
          g.addColorStop(0.35, `rgba(255,214,150,${0.32 * pulse})`);
          g.addColorStop(1, 'rgba(255,190,120,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cp.x, cp.y, bloomR, 0, Math.PI * 2); ctx.fill();
          const k = Math.min(1, a / 1.1);
          if (k < 1) {
            const ease = 1 - Math.pow(1 - k, 3);
            ctx.strokeStyle = `rgba(255,232,190,${0.85 * (1 - k)})`;
            ctx.lineWidth = Math.max(2, unitOf(H) * 14 * (1 - k));
            ctx.beginPath(); ctx.arc(cp.x, cp.y, R0 + (reach - R0) * ease, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
        }
      }
    }
    for (const [bid, gt] of goneAt) {
      const k = (t - gt) / 2.2;
      if (k < 0 || k >= 1) continue;
      const gb = byGame.get(bid);
      if (!gb) continue;
      const cp = toPx(pos(bid, t));
      const r0 = drawnRadiusOf(pres, gb, cam.scale);
      drawBlast(ctx, cp.x, cp.y, k, bid, Math.max(1, r0 / 14));
      drawDebris(ctx, cp.x, cp.y, r0 * 1.4, k, bid);
    }

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
    // In a battle shot the guns run hotter than the live map's duty
    // cycle: the film shows a fight at a tick a second, and at the live
    // rate a battle read as two fleets parked side by side.
    const fireClock = curScene?.kind === 'battle' || curScene?.kind === 'intro' ? 1.8 : 1;
    drawEngagementFire(rc, gameShips, gameSettlements,
      performance.now() * fireClock, curTick);

    // A FLEET ARRIVING IS A BEAT. The film is largely about hulls moving
    // between worlds and every crossing simply stopped when it got there.
    //
    // Driven off the leg's own arrival tick rather than a frame-to-frame
    // diff of who is in transit: the reel can be scrubbed, and a diff
    // would fire a flash every time the playhead was dragged backwards
    // past a landing. Keyed by hull AND tick so a hull that makes the
    // same crossing twice flashes twice.
    for (const leg of legs.values()) {
      if (curTick < leg.arrive) continue;
      const key = `${leg.id}@${leg.arrive}`;
      if (arrivedSeen.has(key)) continue;
      arrivedSeen.add(key);
      spawnArrivalFlash(leg.id, performance.now());
    }
    drawArrivalFlashes(rc, gameShips, performance.now());

    // Names, painted now that every world and hull has staked its claim.
    flushLabels(ctx, cam.scale, canvas.width, canvas.height);

    // Hulls between worlds, on the game's trajectory art, in formation,
    // sized up as the camera closes in.
    const transitScale = (() => {
      const sc = Math.max(TRANSIT_MIN_CAM_SCALE, cam.scale);
      const u = Math.max(0, Math.min(1,
        Math.log(sc / TRANSIT_MIN_CAM_SCALE)
          / Math.log(TRANSIT_FULL_CAM_SCALE / TRANSIT_MIN_CAM_SCALE)));
      // Smaller still in a wide shot, where a full-size hull dwarfs the
      // worlds it is flying between.
      return (TRANSIT_SHIP_MIN_SIZE + (1 - TRANSIT_SHIP_MIN_SIZE) * u) * (1 - 0.35 * overview);
    })();
    const transiting = new Set<string>();
    for (const sh of gameShips) {
      if (!sh.transit) continue;
      transiting.add(sh.id);
      const samples = drawTorchTrajectory(
        sh.transit.currentTransfer, gameBodies, rc, undefined, true,
        false, curTick, sh.id);
      drawTransitShip(sh, rc, false, placeInFormation(sh.id, samples, rc, transitScale), transitScale);
    }

    // Events at this tick: battles pulse, losses flash, foundings ring.
    for (const b of summary.battles) {
      const end = b.ended_tick ?? b.started_tick;
      if (curTick < b.started_tick || curTick > end || !b.body_id) continue;
      const id = b.body_id;
      if (!byId.has(id)) continue;
      const gb = byGame.get(id);
      if (!gb || !visibleIds.has(id)) continue;
      const p = toPx(pos(id, t));
      const dr = drawnRadiusOf(pres, gb, cam.scale);
      // Close in, the battle draws itself; the ring is the far read.
      const far = 1 - Math.max(0, Math.min(1, (dr - 18) / 30));
      if (far <= 0.01) continue;
      const r = dr + 14;
      ctx.save();
      ctx.globalAlpha = far;
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
      ctx.restore();
      // The tracers that used to be drawn here are gone. They were a
      // second firing system running alongside drawEngagementFire: seven
      // salvoes crammed into every tick, endpoints picked by a seeded
      // RNG. The game fires one volley per BOLT_MS + BEAT_MS -- 1.1
      // seconds -- so at a brisk 0.3s/tick this file was drawing roughly
      // twenty-three shots a second over the top of the real thing.
    }

    for (const e of events) {
      if (e.tick !== curTick || !e.bodyId || !byId.has(e.bodyId)) continue;
      const gb = byGame.get(e.bodyId);
      if (!gb || !visibleIds.has(e.bodyId)) continue;
      const p = toPx(pos(e.bodyId, t));
      const r0 = drawnRadiusOf(pres, gb, cam.scale);
      const k = Math.min(1, curFrac);
      // These rings are the FAR read. Close in, a filled disc washed the
      // whole world orange once a tick -- a strobe over every battle --
      // and the blasts and wreckage already say it there.
      const farK = 1 - Math.max(0, Math.min(1, (r0 - 18) / 30));
      if (farK <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = farK;
      if (e.kind === 'loss') {
        ctx.fillStyle = `rgba(255,150,70,${(1 - k) * 0.5})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 10 + k * 26, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'founded' || e.kind === 'fallen') {
        const fid = ownerOf.get(e.bodyId) ?? null;
        ctx.strokeStyle = hexA(e.kind === 'founded' ? colorOf(fid) : '#ff6a5a', 1 - k);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 4 + k * 30, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    // Count chips where hulls are too small to read.
    for (const c of chips) {
      const gb = byGame.get(c.bid);
      if (!gb || !visibleIds.has(c.bid)) continue;
      const p = toPx(pos(c.bid, t));
      const r0 = drawnRadiusOf(pres, gb, cam.scale);
      const list = [...c.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([fid, n]) => ({ faction: filmFaction(fid)!, n })).filter(x => x.faction);
      drawCountChips(ctx, H, p.x, p.y + r0 + 16 * unitOf(H), list, c.alpha);
    }

    // How big the Leviathan was last drawn, for its death (see the blast).
    for (const sh of adaptedShips) {
      if (sh.class !== 'kaiju') continue;
      const h = rc.shipHitboxes?.get(sh.id);
      // Its hitbox is the head; the drawn body runs about 2.6 times that.
      if (h) lastBeastR.set(sh.id, h.r * 2.6);
    }

    if (tracing) {
      // WHERE EVERYTHING WAS DRAWN, this frame: the frame-to-frame audit
      // (a hull that jumps, pops or flickers between two frames) reads
      // this, not a sampled still.
      const meta = new Map(adaptedShips.map(sh => [sh.id, sh]));
      lastTrace = {
        t, scene: curScene ? scenes.indexOf(curScene) : -1,
        cam: { x: cam.x, y: cam.y, scale: cam.scale },
        // Hulls dying this tick (they vanish under their blast: not a pop).
        dying: [...vanishAt.keys()],
        ships: [...(rc.shipHitboxes ?? new Map()).entries()].map(([id, h]) => {
          const sh = meta.get(id);
          return [id, Math.round(h.x * 10) / 10, Math.round(h.y * 10) / 10, Math.round(h.r * 10) / 10,
            sh?.transit ? 1 : 0, sh?.orbit?.parentBodyId ?? null];
        }),
        bodies: visible.map(b => {
          const p = toPx(bodyPosition(b, t, gameBodies));
          return [b.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10,
            Math.round(drawnRadiusOf(pres, b, cam.scale) * 10) / 10];
        }),
      };
    }

    ctx.restore();
    drawFilm();
  }
  /** The Leviathan's drawn radius (screen px), last frame it was drawn. */
  const lastBeastR = new Map<string, number>();
  /** The frame-to-frame audit's record of the last frame (see render). */
  let tracing = false;
  let lastTrace: unknown = null;

  // ---- the film's graphics (filmOverlay) -------------------------------
  //
  // Everything over the map: the standings while the shot is wide, the
  // tally while it is on a battle, the lower third naming each moment
  // from the event log, the ticker of smaller headlines, the clock, and
  // the title and result cards at either end.
  const T = (k: string, vars?: Record<string, string | number>) =>
    tIn(getLang(), `replay.film.${k}` as Key, vars);

  /** When the log says each empire was knocked out (the game's own
   *  ruling: a fleet with no world left is out), else when the record
   *  shows it with nothing at all. */
  const outAt = new Map<string, number>();
  for (const r of summary.chronicle ?? []) {
    if (r.kind === 'faction_eliminated' && r.actor_faction_id) outAt.set(r.actor_faction_id, r.tick_number);
    if (r.kind === 'faction_revived' && r.actor_faction_id) outAt.delete(r.actor_faction_id);
  }
  const standingsAt = (tick: number): StandingRow[] => {
    const w = timeline.worldAt(tick);
    // WORLDS, not settlements: a city and a station on one world is one.
    const held = new Map<string, Set<string>>();
    for (const st of w.stls.values()) {
      if (!st.fid) continue;
      let set = held.get(st.fid);
      if (!set) { set = new Set(); held.set(st.fid, set); }
      set.add(st.body);
    }
    const ships = new Map<string, number>();
    for (const sh of w.ships.values()) if (sh.fid) ships.set(sh.fid, (ships.get(sh.fid) ?? 0) + 1);
    const outTick = (fid: string) => {
      const o = outAt.get(fid) ?? elimAt.get(fid);
      return o != null && o <= tick ? o : null;
    };
    return empires.map(f => ({
      row: {
        faction: filmFaction(f.id)!,
        worlds: held.get(f.id)?.size ?? 0,
        ships: ships.get(f.id) ?? 0,
        out: outTick(f.id) != null && !(held.get(f.id)?.size),
      },
      o: outTick(f.id),
    })).sort((a, b) => Number(a.row.out) - Number(b.row.out)
      // The fallen in the order they fell: the last one out ranks highest.
      || (b.o ?? 0) - (a.o ?? 0)
      || b.row.worlds - a.row.worlds || b.row.ships - a.row.ships)
      .map(x => x.row);
  };

  const captionCache = new Map<ReelScene, Caption>();
  /** Every title already on screen: none is shown twice. */
  const usedTitles = new Set<string>();
  /** The headline a time-lapse carries, so the ticker does not repeat it. */
  const montageTop = new Map<ReelScene, ReelBeat>();
  /**
   * A TIME-LAPSE SAYS WHAT CHANGED. "X leads" over every one of them was
   * eighteen identical captions in a row, and named a leader who then
   * lost. A montage now carries its biggest headline; failing that, a
   * change of leader; failing that, nothing.
   */
  const montageCaption = (s: ReelScene): Caption | null => {
    // The first one is the start of the story: who, and where.
    if (s.from <= (summary.ticks.lo ?? 0) + 1) {
      return { kicker: T('kicker.start'), title: T('title.begin', { n: empires.length }), sub: '', fid: null };
    }
    // Time-lapses too short to read a line in carry none.
    if (s.seconds < MONTAGE_CAPTION_SECONDS) return null;
    const name = (id: string | null | undefined) => filmFaction(id)?.name ?? '';
    const world = (id: string | null | undefined) => (id && byId.get(id)?.name) || '';
    // Only news worth a headline: a slider law or a found relic is ticker.
    const tops = s.extras.filter(e => TICKER_KINDS.has(e.kind) && e.weight >= MONTAGE_HEADLINE_WEIGHT
      && !/^dyson_milestone$/.test(e.kind))
      .sort((a, b) => b.weight - a.weight || a.tick - b.tick);
    for (const top of tops) {
      const cap = beatCaption(top, T, name, world);
      if (!cap.title || usedTitles.has(cap.title)) continue;
      montageTop.set(s, top);
      // Its own kind's kicker (WAR, ELIMINATED...), not a generic one.
      return { kicker: cap.kicker || T('kicker.fastForward'), title: cap.title, sub: '', fid: top.fid };
    }
    const i = scenes.indexOf(s);
    const leadOf = (x: ReelScene) => standingsAt(Math.floor((x.from + x.to) / 2))[0];
    const now = leadOf(s);
    const before = scenes.slice(0, i).reverse().find(x => x.kind === 'montage');
    if (!now || now.worlds <= 0 || (before && leadOf(before)?.faction.id === now.faction.id)) return null;
    return { kicker: T('kicker.lead'), title: T('title.leads', { a: now.faction.name }),
      sub: T('sub.leads', { worlds: now.worlds, ships: now.ships }), fid: now.faction.id };
  };
  const captionOf = (s: ReelScene): Caption => {
    let c = captionCache.get(s);
    if (!c && s.kind === 'montage') {
      c = montageCaption(s) ?? { kicker: '', title: '', sub: '', fid: null };
      captionCache.set(s, c);
    }
    if (!c) {
      c = captionFor(s, {
        lang: getLang(), summary,
        leaderAt: tick => {
          const top = standingsAt(tick)[0];
          return top && top.worlds > 0 ? { fid: top.faction.id, worlds: top.worlds, ships: top.ships } : null;
        },
        winner: summary.game.winner_faction_id ?? null,
      });
      // The Leviathan is introduced the first time it appears: a stranger
      // has no idea what it is.
      if (s.kind === 'beat' && /^kaiju_/.test(s.beat?.kind ?? '') && !kaijuGlossed) {
        kaijuGlossed = true;
        c = { ...c, sub: T('sub.kaijuGloss') };
      }
      // THE STAKES, the moment the Sphere is begun: an engineering win is
      // a race, and a newcomer has to know it is one.
      if (s.kind === 'beat' && s.beat?.kind === 'dyson_initiated') {
        c = { ...c, sub: T('sub.dysonStakes', { a: shortName(filmFaction(s.beat.fid)?.name ?? '') }) };
      }
      // A second fight at the same world is the next chapter, not a repeat.
      if (s.kind === 'battle' && repeatVisit(s)) {
        c = { ...c, title: T('title.battleAgain', { world: byId.get(s.bodyId ?? '')?.name ?? '' }) };
      }
      captionCache.set(s, c);
    }
    if (c.title) usedTitles.add(c.title);
    return c;
  };
  let kaijuGlossed = false;

  /** A battle's two sides, as they stand at this tick. */
  const seat = (fid: string) => summary.factions.findIndex(f => f.id === fid);
  const tallyOf = (b: ReelBattle, tick: number): TallySide[] => [...b.sides].sort((x, y) => seat(x) - seat(y)).map(fid => {
    // The hulls ON SCREEN at the world: a fleet still flying in is not
    // in the fight yet, and counting it put numbers over an empty orbit.
    // ...less any whose blast has already gone off this tick.
    const dying = new Set((deathAt.get(tick + 1) ?? []).map(d => d.id));
    let ships = 0;
    for (const sh of adaptedShips) {
      if (sh.transit || sh.orbit.parentBodyId !== b.body || sh.ownedBy !== fid) continue;
      if (dying.has(sh.id) && killPhase(sh.id) <= curFrac) continue;
      ships++;
    }
    let lost = 0;
    for (let k = b.window[0] + 1; k <= tick + 1; k++) {
      for (const d of deathAt.get(k) ?? []) {
        if (d.body === b.body && d.fid === fid && (k <= tick || killPhase(d.id) <= curFrac)) lost++;
      }
    }
    return { faction: filmFaction(fid)!, ships, lost };
  }).filter(x => x.faction);

  /** A time-lapse shorter than this carries no caption. */
  const MONTAGE_CAPTION_SECONDS = 1.6;
  /** The least a log row must weigh to headline a time-lapse. */
  const MONTAGE_HEADLINE_WEIGHT = 40;
  /** The finale holds its image this long before the table comes up. */
  const FINALE_CARD_AT = 2.8;
  /** Film seconds into the finale, or -1 outside it. */
  const finaleEl = () => {
    const sc = scenes[scenes.length - 1];
    if (!sc || sc.kind !== 'finale' || clockT < sc.from) return -1;
    return filmSecondsAt(scenes, clockT) - filmSecondsAt(scenes, sc.from);
  };
  /**
   * THE SPHERE COMPLETES ON SCREEN. The win lands on the match's last
   * tick, which the finale only reaches as the film ends, so the shell sat
   * at 99% under "The Dyson Sphere is complete". In the finale it ticks to
   * 100%, the segments lock, and it flares.
   */
  const finaleDyson = (): { progress: number; complete: boolean; flare: number; seal: number } | null => {
    if (summary.game.victory_type !== 'engineering' || !dysonOwner) return null;
    const el = finaleEl();
    if (el < 0) return null;
    const p0 = Math.min(0.99, dysonKeys.length ? dysonKeys[dysonKeys.length - 1][1] : 0.99);
    // The last segment lights, then the shell SEALS round the star, one
    // gap after another; the meter reads 100% on the frame it closes.
    const lit = DYSON_LIT_AT, sealed = DYSON_SEALED_AT;
    const seal = Math.max(0, Math.min(1, (el - lit) / (sealed - lit)));
    const flare = el < sealed ? 0 : Math.max(0, Math.sin(Math.min(1, (el - sealed) / 1.2) * Math.PI));
    return { progress: el < lit ? p0 + (1 - p0) * (el / lit) : 1, complete: el >= sealed, flare, seal };
  };
  /** Finale seconds: the last segment lit, and the shell sealed. */
  const DYSON_LIT_AT = 0.7;
  const DYSON_SEALED_AT = 1.3;
  /** The cold open runs this long as pure action before the title. */
  const HOOK_SECONDS = 1.4;
  /** Who is building the Dyson Sphere, if anyone, and round which star. */
  const dysonOwner = (summary.chronicle ?? []).find(r => r.kind === 'dyson_initiated')?.actor_faction_id ?? null;
  const dysonBodyId = (summary.chronicle ?? []).find(r => r.kind === 'dyson_initiated')?.body_id ?? null;
  /** Film seconds at which each Dyson milestone lands (for the meter's flash). */
  const dysonFlashAt = () => (summary.chronicle ?? [])
    .filter(r => r.kind === 'dyson_milestone' || r.kind === 'dyson_damaged')
    .map(r => filmSecondsAt(scenes, r.tick_number));

  /** When a scene's caption may come up: once a push in has arrived. */
  const landAt = (s: ReelScene) => {
    // A caption comes up as the camera arrives, not while it travels.
    return Math.max(0, (travelSeconds.get(s) ?? 0) - 0.15);
  };

  function drawFilm() {
    // The CLOCK's time: the cold open shows a later moment than this.
    const t = clockT;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawVignette(ctx, W, H);
    if (!scenes.length) return;
    const idx = Math.max(0, scenes.findIndex(x => t >= x.from && t < x.to));
    const s = scenes[idx] ?? scenes[scenes.length - 1];
    const fs = filmSecondsAt(scenes, t);
    const el = fs - filmSecondsAt(scenes, s.from);
    const intro = s.kind === 'intro';
    const finale = s.kind === 'finale';
    const card = intro ? 1 - Math.max(0, Math.min(1, (el - (s.seconds - 0.8)) / 0.8)) : finale ? 1 : 0;
    const hud = intro ? 0 : 1 - card;

    // The race while the shot is wide; the fight while it is close.
    drawStandings(ctx, W, H, standingsAt(curTick).slice(0, 5),
      hud * overview, { worlds: T('worlds', { n: '' }).trim(), brand: T('worldsHeld') });
    if (s.kind === 'battle' && s.battle) {
      const sides = tallyOf(s.battle, curTick);
      const more = Math.max(0, (s.battle.present ?? 2) - 2);
      drawBattleTally(ctx, W, H, sides, hud * (1 - overview) * Math.min(1, Math.max(0, (el - landAt(s)) / 0.3)),
        'VS', more, more ? T('more', { n: more }) : '');
      // WHO HOLDS THE FIELD, as the fight closes.
      const prog = el / Math.max(0.01, s.seconds);
      // THE VERDICT IS THE SCOREBOARD'S. Whoever has the most ships left in
      // the fight wins it, and only once the fight is nearly over: a stamp
      // naming the world's owner read "Tritalowda holds Europa" over 0 vs
      // 26, and "Ministry holds Earth" while it was still behind.
      if (prog > 0.8 && sides.length) {
        const top = [...sides].sort((a, b) => b.ships - a.ships)[0];
        const second = [...sides].sort((a, b) => b.ships - a.ships)[1];
        // A clear margin, or no call: 77 vs 70 named the side that then
        // lost the field.
        if (top.ships > 0 && (!second || top.ships >= 1.5 * second.ships)) {
          // "Holds" only when every settlement on the world is theirs.
          let mine = 0, theirs = 0;
          for (const st of world.stls.values()) {
            if (st.body !== s.battle.body || !st.fid) continue;
            if (st.fid === top.faction.id) mine++; else theirs++;
          }
          const where = byId.get(s.battle.body)?.name ?? '';
          const key = mine > 0 && theirs === 0 ? 'verdict' : 'verdictWin';
          drawBattleVerdict(ctx, W, H, T(key, { a: shortName(top.faction.name), world: where }).toUpperCase(),
            top.faction.color, ((prog - 0.8) / 0.08) * (1 - overview) * hud);
        }
      }
    }
    // THE SENATE AT WORK: the law, the vote, what came of it.
    if (s.kind === 'beat' && s.beat?.kind === 'senate_vote' && s.beat.data?.bill_kind !== 'chancellor_vote') {
      const p = s.beat.data ?? {};
      drawSenateCard(ctx, W, H, {
        label: T('senate.label'), bill: billName(String(p.title ?? '')),
        yea: Number(p.yea_weight) || 0, nay: Number(p.nay_weight) || 0,
        term: String(p.term ?? ''), impact: String(p.impact ?? ''),
        more: Number(p.also) > 0 ? T('senate.more', { n: Number(p.also) }) : '',
      }, (el - 0.35) / 0.3, (el - (s.seconds - 0.25)) / 0.25);
    }
    // A victory being BUILT, on screen while it is built.
    const fin = finaleDyson();
    const dy = fin ?? dysonAt(curTick + curFrac);
    if (dy && dysonOwner && (!dy.complete || fin)) {
      const flash = fin ? (fin.complete ? 1 - Math.min(1, (el - DYSON_SEALED_AT) / 1.2) : 0)
        : Math.max(0, ...dysonFlashAt().map(at => (fs >= at ? 1 - (fs - at) / 1.2 : 0)));
      // In the finale the meter stays up until the table, to hit 100%.
      const alpha = fin ? (el < FINALE_CARD_AT ? 1 : 0) : hud;
      // The meter says what the caption says: a Sphere headline's own
      // number while it is up (97% under "at 99%" was a contradiction),
      // and 100% only on the frame the shell seals.
      const said = s.kind === 'beat' && /^dyson_(damaged|milestone)$/.test(s.beat?.kind ?? '')
        ? Number(s.beat?.data?.pct) / 100 : NaN;
      const shown = fin ? (fin.complete ? 1 : Math.min(0.999, fin.progress))
        : Number.isFinite(said) ? said : dy.progress;
      drawProgressMeter(ctx, W, H, T('meter.dyson'), shown, colorOf(dysonOwner), alpha, flash,
        T('meter.dysonNote', { a: shortName(filmFaction(dysonOwner)?.name ?? '') }));
    }

    // The clock, and how fast the film is running when it is fast.
    const perTick = s.seconds / Math.max(1, s.to - s.from);
    const x = Math.round(1 / Math.max(0.001, perTick));
    drawClock(ctx, W, H, curTick + curFrac, s.kind === 'montage' && x >= 4 ? `${T('ff')} \u25B8\u25B8` : null, hud,
      T('dayLabel'));

    // The lower third: what this scene is. Drawn before the ticker, which
    // keeps clear of how far it reaches.
    const cap = !intro && !finale ? captionOf(s) : null;
    let ltRight = 0;
    if (s.act === 'opening') {
      // Two captions: who is here (with the roll call), then the land grab.
      const n = built.length;
      const most = new Map<string, number>();
      for (const b of built) most.set(b.fid, (most.get(b.fid) ?? 0) + 1);
      const lead = [...most.entries()].sort((a, b) => b[1] - a[1])[0];
      if (el < ROLL_CALL_END) {
        ltRight = drawLowerThird(ctx, W, H, { kicker: T('kicker.start'), title: T('title.begin', { n: empires.length }),
          sub: '', color: null }, el / 0.2, (el - (ROLL_CALL_END - 0.2)) / 0.2);
      } else if (n > 0) {
        ltRight = drawLowerThird(ctx, W, H, { kicker: T('land.kicker'),
          title: T('land.title', { n, d: Math.max(1, s.to - s.from) }),
          sub: lead ? T('land.sub', { a: shortName(filmFaction(lead[0])?.name ?? ''), k: lead[1] }) : '',
          color: lead ? colorOf(lead[0]) : null },
        (el - ROLL_CALL_END - 0.15) / 0.2, (el - (s.seconds - 0.2)) / 0.2);
      }
    } else if (cap && cap.title && !(s.kind === 'montage' && s.seconds < 1.1)) {
      const c = cap;
      // A montage line is a quick read: in and out briskly.
      // SNAP IN, HOLD, SNAP OUT: a 1.3 s fade left a two-second beat
      // fully legible for under one.
      ltRight = drawLowerThird(ctx, W, H, { kicker: c.kicker, title: c.title, sub: c.sub,
        color: c.fid ? colorOf(c.fid) : null },
      el / 0.2, (el - (s.seconds - 0.18)) / 0.18);
    }

    // EVERY WAR, PEACE AND PACT, as it happens (see buildToasts).
    const liveToasts = intro || finale ? [] : toasts.filter(x => fs >= x.at && fs < x.at + TOAST_LIFE_SECONDS).slice(-3);
    if (liveToasts.length) {
      drawToasts(ctx, W, H, liveToasts.reverse().map(x => {
        const a = filmFaction(x.a), b = filmFaction(x.b);
        const na = shortName(a?.name ?? ''), nb = shortName(b?.name ?? '');
        return { kind: x.kind, a, b, life: (fs - x.at) / TOAST_LIFE_SECONDS,
          text: T(`toast.${x.kind}`, { a: na, b: nb }) };
      }));
    }
    // AN EMPIRE'S END: its card, slammed on as it falls.
    if (s.kind === 'beat' && s.beat?.kind === 'faction_eliminated' && Array.isArray(s.beat.data?.toll)) {
      const fell = filmSecondsAt(scenes, s.beat.tick - 0.4);
      const killer = typeof s.beat.data?.killer_faction_name === 'string' ? shortName(s.beat.data.killer_faction_name) : '';
      const toll = s.beat.data!.toll as Array<{ fid: string; peak: number; lost: number }>;
      const day = s.beat.tick;
      const cards = toll.map(x => {
        const f = filmFaction(x.fid);
        return f ? { faction: f, stamp: T('out.stamp'), lines: [
          `${T('out.lasted', { d: day })} · ${T('out.peak', { n: x.peak })}`,
          `${T('out.lost', { n: x.lost })}${killer && toll.length === 1 ? ` · ${T('out.by', { k: killer })}` : ''}`,
        ] } : null;
      }).filter((x): x is NonNullable<typeof x> => !!x);
      drawOutCards(ctx, W, H, cards, fs - fell, (el - (s.seconds - 0.25)) / 0.25);
    }

    // The ticker: one line, about what is in shot (never under a banner).
    // Never beside a caption: two lines of news at once read as one
    // ghosting behind the other.
    if (hud > 0.5 && s.kind === 'montage' && !ltRight && !liveToasts.length && W - 56 * unitOf(H) - Math.max(W * 0.6, ltRight + 48 * unitOf(H)) > 320 * unitOf(H)) {
      // A time-lapse device only: it never repeats the headline already
      // up, and on a held shot it stays on the world in shot.
      const top = montageTop.get(s);
      const subj = curFocus;
      const live = ticker.filter(x2 => fs >= x2.start && fs < x2.start + TICKER_LIFE_SECONDS
        && x2.beat !== top
        && (!subj || x2.beat.body === subj)).slice(-1);
      drawTicker(ctx, W, H, live.map(x2 => ({ text: broadcastCopy(x2.beat.text),
        faction: filmFaction(x2.beat.fid), life: (fs - x2.start) / TICKER_LIFE_SECONDS })),
      Math.max(W * 0.6, ltRight + 48 * unitOf(H)));
    }

    if (intro) {
      const c = captionOf(s);
      if (teaser?.battle) {
        drawHookLine(ctx, W, H, T('hook', { n: teaser.battle.peak }), el / 1.0, (el - (HOOK_SECONDS - 0.15)) / 0.15);
      }
      const at = teaser ? HOOK_SECONDS : 0;
      drawTitleCard(ctx, W, H, c, empires.map(f => filmFaction(f.id)!).filter(Boolean),
        (el - at) / 0.35, (el - (s.seconds - 0.4)) / 0.4, teaser ? 0.8 : 1);
    }
    // Out of the cold open, a dip through black: the clock jumps back
    // five hundred days and the frame should say so.
    const prevScene = scenes[idx - 1];
    if (prevScene?.kind === 'intro' && teaser && el < 0.35) {
      ctx.fillStyle = `rgba(0,0,0,${0.9 * (1 - el / 0.35)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (finale) {
      const c = captionOf(s);
      // The winner heads the table, however it won: a Senate election or
      // a Dyson Sphere is not decided by worlds held.
      const winner = summary.game.winner_faction_id ?? null;
      const table = standingsAt(summary.ticks.hi ?? curTick)
        .sort((a, b) => Number(b.faction.id === winner) - Number(a.faction.id === winner));
      // The last shot breathes first: the camera holds the final map
      // before the card comes up.
      // THE PAYOFF FIRST, then the table: the decisive image held clean
      // with its reason, and only then the standings.
      const why = summary.game.victory_type === 'engineering' && dysonOwner ? T('title.dysonDone')
        : c.title;
      drawLowerThird(ctx, W, H, { kicker: c.kicker, title: why,
        sub: summary.game.victory_type === 'engineering' ? T('sub.engineering') : '',
        color: c.fid ? colorOf(c.fid) : null }, (el - (finaleDyson() ? DYSON_SEALED_AT + 0.1 : 0.9)) / 0.2,
        (el - (FINALE_CARD_AT - 0.15)) / 0.15);
      // The table comes in once the light has rolled out.
      drawResultCard(ctx, W, H, { ...c, color: c.fid ? colorOf(c.fid) : null },
        table, (el - FINALE_CARD_AT) / 0.6,
        { worlds: T('worlds', { n: '' }).trim(), ships: T('ships', { n: '' }).trim(), url: T('url'),
          out: T('out') },
        !!winner);
    }
    drawProgress(ctx, W, H, filmTotal > 0 ? fs / filmTotal : 0);
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
    systemFrames.clear();
    canvas.width = Math.round(w); canvas.height = Math.round(h);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    starfield = generateStarfield(canvas.width, canvas.height);
  }
  resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);

  return {
    setTick, render, resize,
    applyRows: (rows: SnapshotRow[]) => {
      timeline.append(rows); rebuildStandings(); rebuildTransits(); rebuildShots();
      // The page that just landed can add detail to a tick already on
      // screen, so the adapted world held for the current tick is stale.
      adaptedTick = -1;
    },
    dispose: () => { /* nothing held */ },
    worldAt: (tick: number) => timeline.worldAt(tick),
    setView: (mode: 'auto' | 'wide') => { viewMode = mode; },
    rateAt,
    _facts: () => lastFacts,
    _trace: () => { tracing = true; return lastTrace; },
    _probe: () => {
      probing = true;
      const lp = lastProbe as { hits?: Array<[number, number] | null> } | null;
      const px = (lp?.hits ?? []).map(h => h ? Array.from(ctx.getImageData(h[0], h[1], 1, 1).data) : null);
      return { ...(lp ?? {}), px };
    },
    // The cut list, for harnesses and probes; not part of the contract.
    _shots: () => scenes.map(x => ({ kind: x.kind, from: x.from, to: x.to,
      seconds: +x.seconds.toFixed(2), framing: x.framing, bodyId: x.bodyId,
      title: captionOf(x).title, sub: captionOf(x).sub, extras: x.extras.length })),
    /**
     * Where each hull that died on a tick is placed, against the world it
     * died at. A probe rather than a feature: the blast and the wreck are
     * meant to sit on the parking ring, and the two of them drifting apart
     * is exactly the bug this exists to catch.
     */
    _deaths: (tick: number) => (deathAt.get(tick) ?? []).map(d => {
      const host = byGame.get(d.body);
      if (!host) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- bp
      const bp = bodyPosition(host, tick, gameBodies);
      const ring = Math.max(host.radius * 2.1, host.radius + 9);
      const ang = ((hashStr(d.id) % 1000) / 1000) * Math.PI * 2;
      return {
        id: d.id, body: d.body, bodyRadius: host.radius,
        offsetWorld: ring,
        dx: Math.cos(ang) * ring, dy: Math.sin(ang) * ring,
      };
    }).filter(Boolean),
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

