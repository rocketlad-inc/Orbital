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
  drawTorchTrajectory, drawTransitShip, generateStarfield, planBodyLabels,
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
import { battlePlacement, battleScale, liveBattleFor, type BattleUnit, type LiveBattle } from './battleLayoutLive';
import { shipIconSize } from './mapRenderer';
import { getShipClass } from '../game/shipClasses';
import { getEmblemImage } from './emblemCache';
import { getLang, tIn, type Key } from '../i18n/core';
import {
  battleWindow, filmSecondsAt, planReel, reelRate, reelSeconds,
  type ReelBattle, type ReelBeat, type ReelScene,
} from './filmReel';
import { beatCaption, buildBeats, captionFor, type Caption } from './filmCaptions';
import {
  drawBattleTally, drawClock, drawCountChips, drawLowerThird, drawProgress,
  drawResultCard, drawStandings, drawTicker, drawTitleCard, drawVignette,
  liftColor, unitOf, type FilmFaction, type StandingRow, type TallySide,
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
  _facts: () => unknown } {
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
  const drawableAt = (b: Body, tick: number) =>
    (b.type === 'star' || (!!b.parent_body_id && !!b.orbit_period))
    && !(b.destroyed_at_tick != null && tick >= b.destroyed_at_tick)
    && !((appearsAt.get(b.id) ?? -Infinity) > tick);

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
  let filmTotal = 0;
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
  const deathAt = new Map<number, Array<{ id: string; body: string; fid: string | null }>>();
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
      const gone: Array<{ id: string; body: string; fid: string | null }> = [];
      for (const [id, was] of prev.ships) {
        if (now.ships.has(id) || !was.parent) continue;
        gone.push({ id, body: was.parent, fid: was.fid ?? null });
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
        const present = fought.length;
        const peak = seen.size;
        battles.push({ body, from: s0, to: e0 + 1, peak, lost, sides, window,
          present: Math.max(present, sides.length) });
      }
    }

    // --- the event log, weighed and placed ------------------------------
    let beats: ReelBeat[] = buildBeats(summary, {
      lang: getLang(),
      drawable: (id, t) => byId.has(id) && drawableAt(byId.get(id)!, t),
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

    lastFacts = { battles, beats: beats.length };
    const dysonBody = (summary.chronicle ?? []).find(r => r.kind === 'dyson_initiated')?.body_id ?? null;
    scenes = planReel({ lo, hi, battles, beats }, {
      finaleBody: summary.game.victory_type === 'engineering' && dysonBody && byId.has(dysonBody)
        ? dysonBody : null,
    });
    filmTotal = reelSeconds(scenes);
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
  /** Seconds a push in or a pull out takes. */
  const MOVE_SECONDS = 1.15;
  /** A drawn subject's radius as a share of the frame height. */
  const BATTLE_SUBJECT = 0.1;
  const WORLD_SUBJECT = 0.085;

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

  const systemFrame = (s: ReelScene | undefined, t: number): Frame => {
    const lo = summary.ticks.lo ?? 0;
    const ids = s ? occupiedOver(s.from, s.to) : occupiedOver(lo, lo + 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const p = pos(id, t);
      const r = (bodyR.get(id) ?? 4) + 10;
      x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
      y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
    }
    if (!isFinite(x0)) return { x: 0, y: 0, scale: 1 };
    const m = safe();
    const bw = Math.max(60, x1 - x0), bh = Math.max(60, y1 - y0);
    const availW = W - m.side * 2, availH = H - m.top - m.bottom;
    const scale = Math.max(MIN_CAMERA_SCALE, Math.min(availW / bw, availH / bh) * 0.92);
    const cy = (y0 + y1) / 2;
    // Centre the box in the space between the graphics.
    const midY = (m.top + (H - m.bottom)) / 2;
    return { x: (x0 + x1) / 2, y: cy + (H / 2 - midY) / scale, scale };
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
      && drawableAt(byId.get(s.bodyId)!, Math.floor(t)) ? s.bodyId : null;

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
    const f = bodyFrame(subj, t, share);
    // A slow push: a held shot is never a still. A battle opens a touch
    // wide and closes in on the fight.
    const k = s.framing === 'battle' ? 0.92 + 0.14 * prog : 1 + 0.045 * prog;
    return { x: f.x, y: f.y - (H / 2 - H * FOCUS_Y) / f.scale + (H / 2 - H * FOCUS_Y) / (f.scale * k),
      scale: f.scale * k };
  };

  /** Where a world point lands on screen under a frame. */
  const onScreen = (f: Frame, p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - f.x) * f.scale, y: H / 2 + (p.y - f.y) * f.scale });

  /**
   * Blend two frames so a chosen world point travels smoothly across the
   * screen while the zoom changes geometrically: a push in reads as
   * diving toward the subject, not as a pan that happens to zoom.
   */
  const blendFrames = (a: Frame, b: Frame, e: number, anchor: { x: number; y: number } | null): Frame => {
    const scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * e);
    if (!anchor) {
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, scale };
    }
    const sa = onScreen(a, anchor), sb = onScreen(b, anchor);
    const sx = sa.x + (sb.x - sa.x) * e, sy = sa.y + (sb.y - sa.y) * e;
    return { x: anchor.x - (sx - W / 2) / scale, y: anchor.y - (sy - H / 2) / scale, scale };
  };

  const toPx = (p: { x: number; y: number }) => onScreen(cam, p);

  /** How "wide" the shot is right now: 1 = the system, 0 = a world. The
   *  overlay uses it to swap the standings for the battle tally. */
  let overview = 1;

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
    const prevSubj = viewMode === 'wide' ? null : subjectOf(prev, t);
    let wideNow = subj ? 0 : 1;

    // A push in is a fixed beat; a pull back out to the system takes the
    // time-lapse it opens (a 0.4 s whip from a close-up to the whole map
    // read as a snap, with the territory bands flaring through it).
    const pullOut = !!prevSubj && !subj;
    const move = pullOut ? Math.min(1.6, (s?.seconds ?? 1) * 0.85)
      : Math.min(MOVE_SECONDS, (s?.seconds ?? 1) * 0.42);
    // Out of the cold open is a cut: the clock has jumped back.
    const fromTeaser = prev?.kind === 'intro' && !!teaser;
    if (prev && !fromTeaser && el < move && !(subj && prevSubj === subj)) {
      const from = frameOf(prev, t, 1);
      const e = (() => { const u = el / move; return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; })();
      // Pushing in: the new subject must already be in the last shot,
      // or the move is a whip across empty space -- cut instead.
      let cut = false;
      let anchor: { x: number; y: number } | null = null;
      if (subj && !prevSubj) {
        const p = pos(subj, t);
        const q = onScreen(from, p);
        cut = q.x < 0 || q.x > W || q.y < 0 || q.y > H;
        anchor = p;
      } else if (prevSubj && !subj) {
        anchor = pos(prevSubj, t);
        const q = onScreen(f, anchor);
        cut = q.x < 0 || q.x > W || q.y < 0 || q.y > H;
      } else if (subj && prevSubj) {
        cut = true;   // world to world: a straight cut
      }
      if (!cut) {
        f = blendFrames(from, f, e, anchor);
        const wFrom = prevSubj ? 0 : 1;
        wideNow = wFrom + (wideNow - wFrom) * e;
      }
    }
    overview = wideNow;
    curFocus = subj;
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
  const lastSeen = new Map<string, { body: string; dx: number; dy: number }>();
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
  function render() {
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
    } else {
      // Same roster, new instant: the only thing that reads `t` within a
      // tick is how far along its crossing a hull in flight has got.
      for (const sh of adaptedShips) {
        const leg = adaptedLegs.get(sh.id);
        if (!leg || !sh.transit) continue;
        const a = byGame.get(leg.from), b = byGame.get(leg.to);
        if (!a || !b) continue;
        const pa = bodyPosition(a, t, gameBodies);
        const pb = bodyPosition(b, t, gameBodies);
        const span = Math.max(1, leg.arrive - leg.depart);
        const u = Math.max(0, Math.min(1, (t - leg.depart) / span));
        const e = u * u * (3 - 2 * u);
        sh.transit.pos.x = pa.x + (pb.x - pa.x) * e;
        sh.transit.pos.y = pa.y + (pb.y - pa.y) * e;
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
      && !((appearsAt.get(b.id) ?? -Infinity) > curTick);

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
    ctx.globalAlpha = 0.5;
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
      for (const sh of arr) drawShip(sh, rc, false, formationOf.get(sh.id), sz);
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
    // Remember where each hull was drawn, against its world.
    for (const sh of gameShips) {
      if (sh.transit) continue;
      const hb = rc.shipHitboxes?.get(sh.id);
      const host = byGame.get(sh.orbit.parentBodyId);
      if (!hb || !host) continue;
      const bp = bodyPosition(host, t, gameBodies);
      lastSeen.set(sh.id, { body: host.id,
        dx: (hb.x - W / 2) / cam.scale + cam.x - bp.x,
        dy: (hb.y - H / 2) / cam.scale + cam.y - bp.y });
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
      // Where it was last drawn, when the film saw it.
      const seen = lastSeen.get(shipId);
      if (seen && seen.body === bodyId) return { x: bp.x + seen.dx, y: bp.y + seen.dy };
      const ring = Math.max(host.radius * 2.1, host.radius + 9);
      const ang = ((hashStr(shipId) % 1000) / 1000) * Math.PI * 2;
      return { x: bp.x + Math.cos(ang) * ring, y: bp.y + Math.sin(ang) * ring };
    };
    for (let dt = Math.max(0, curTick - 6); dt <= curTick; dt++) {
      for (const d of deathAt.get(dt) ?? []) {
        const wp = deathPos(d.id, d.body, dt);
        if (!wp) continue;
        if (!spawnedWrecks.has(d.id)) {
          spawnedWrecks.add(d.id);
          spawnWreck(d.id, wp, 10, performance.now(), dt);
        }
        // The blast, on the GAME clock like the wreckage it belongs to.
        // A wall-clock flash would be a different length of film at
        // 0.3s a tick than at 2.4s, and the director changes that pace
        // scene by scene.
        const k = (t - dt) / BLAST_TICKS;
        if (k >= 0 && k < 1) {
          const cp = toPx(wp);
          drawBlast(ctx, cp.x, cp.y, k, d.id);
          drawDebris(ctx, cp.x, cp.y, 10, k, d.id);
        }
      }
    }
    drawWrecks(rc, performance.now());

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

    ctx.restore();
    drawFilm();
  }

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
  /**
   * A TIME-LAPSE SAYS WHAT CHANGED. "X leads" over every one of them was
   * eighteen identical captions in a row, and named a leader who then
   * lost. A montage now carries its biggest headline; failing that, a
   * change of leader; failing that, nothing.
   */
  const montageCaption = (s: ReelScene): Caption | null => {
    const top = s.extras.filter(e => TICKER_KINDS.has(e.kind))
      .sort((a, b) => b.weight - a.weight || a.tick - b.tick)[0];
    const kicker = T(s.from <= (summary.ticks.lo ?? 0) + 1 ? 'kicker.start' : 'kicker.fastForward');
    if (top) {
      const cap = beatCaption(top, T, id => filmFaction(id)?.name ?? '', id => (id && byId.get(id)?.name) || '');
      return { kicker, title: cap.title, sub: '', fid: top.fid };
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
      captionCache.set(s, c);
    }
    return c;
  };

  /** A battle's two sides, as they stand at this tick. */
  const tallyOf = (b: ReelBattle, tick: number): TallySide[] => b.sides.map(fid => {
    // The hulls ON SCREEN at the world: a fleet still flying in is not
    // in the fight yet, and counting it put numbers over an empty orbit.
    let ships = 0;
    for (const sh of adaptedShips) {
      if (!sh.transit && sh.orbit.parentBodyId === b.body && sh.ownedBy === fid) ships++;
    }
    let lost = 0;
    for (let k = b.window[0] + 1; k <= tick; k++) {
      for (const d of deathAt.get(k) ?? []) if (d.body === b.body && d.fid === fid) lost++;
    }
    return { faction: filmFaction(fid)!, ships, lost };
  }).filter(x => x.faction);

  /** When a scene's caption may come up: once a push in has arrived. */
  const landAt = (s: ReelScene) => {
    const i = scenes.indexOf(s);
    const prev = i > 0 ? scenes[i - 1] : undefined;
    const pushIn = s.framing !== 'system' && !!s.bodyId && (!prev || prev.framing === 'system')
      && prev?.kind !== 'intro';
    return pushIn ? Math.min(MOVE_SECONDS * 0.7, s.seconds * 0.3) : 0;
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
      hud * overview, { worlds: T('worlds', { n: '' }).trim(), brand: T('intro.untitled') });
    if (s.kind === 'battle' && s.battle) {
      drawBattleTally(ctx, W, H, tallyOf(s.battle, curTick), hud * (1 - overview));
    }

    // The clock, and how fast the film is running when it is fast.
    const perTick = s.seconds / Math.max(1, s.to - s.from);
    const x = Math.round(1 / Math.max(0.001, perTick));
    drawClock(ctx, W, H, curTick + curFrac, s.kind === 'montage' && x >= 4 ? `${T('ff')} \u25B8\u25B8` : null, hud);

    // The ticker: smaller headlines, as they happen.
    if (hud > 0.5) {
      const live = ticker.filter(x2 => fs >= x2.start && fs < x2.start + TICKER_LIFE_SECONDS).slice(-2);
      drawTicker(ctx, W, H, live.map(x2 => ({ text: x2.beat.text,
        faction: filmFaction(x2.beat.fid), life: (fs - x2.start) / TICKER_LIFE_SECONDS })),
      W * 0.6);
    }

    // The lower third: what this scene is.
    const cap = !intro && !finale ? captionOf(s) : null;
    if (cap && cap.title && !(s.kind === 'montage' && s.seconds < 1.1)) {
      const c = cap;
      // A montage line is a quick read: in and out briskly.
      const fade = s.kind === 'montage' ? Math.min(0.3, s.seconds * 0.22) : 0.45;
      drawLowerThird(ctx, W, H, { kicker: c.kicker, title: c.title, sub: c.sub,
        color: c.fid ? colorOf(c.fid) : null },
      (el - landAt(s)) / (fade + 0.1), (el - (s.seconds - fade)) / fade);
    }

    if (intro) {
      const c = captionOf(s);
      drawTitleCard(ctx, W, H, c, empires.map(f => filmFaction(f.id)!).filter(Boolean),
        el / 0.5, (el - (s.seconds - 0.6)) / 0.6, teaser ? 0.55 : 1);
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
      drawResultCard(ctx, W, H, { ...c, color: c.fid ? colorOf(c.fid) : null },
        table, (el - 1.2) / 1.0,
        { worlds: T('worlds', { n: '' }).trim(), ships: T('ships', { n: '' }).trim(), url: T('url') },
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

