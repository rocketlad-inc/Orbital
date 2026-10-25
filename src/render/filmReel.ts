// ============================================================
// filmReel — the match film's EDIT: which moments of a match make the
// cut, how long each one gets, and what plays in between.
//
// THE BRIEF (Lorne, 2026-10-21): the end-of-match film should be the
// thing players share, "a fast paced version of what the player saw":
// zoom in on the big battles, pull back for the greater context, and
// caption it from the event log. The old director gave every tick of a
// 526-tick match screen time (a 9.4 minute film); a share-length film
// has to CHOOSE.
//
// So the film is planned as an edit against a RUNTIME BUDGET that grows
// gently with the match (about 45 s for a short game, at most 100 s):
//
//   intro     a title card over the opening state of the system
//   battle    the deadliest stretch of a big fight, framed close
//   beat      a headline from the event log (a war, a conquest, the
//             Leviathan, a megastructure), framed on its world or wide
//   montage   everything between, as a time-lapse of the whole map:
//             territory spreading, fleets streaming, with the minor
//             headlines running as a ticker
//   finale    the result
//
// Scenes cover contiguous tick ranges and carry their own seconds, so
// the player's existing clock (rateAt: seconds per tick) plays the edit
// unchanged: a montage runs at up to 80 ticks a second, a battle at
// about one tick a second, an intro or a beat slower still.
//
// Pure: no canvas, no DOM, no i18n. matchMap.ts measures the match and
// words the captions; this only decides.
// ============================================================

export type ReelKind = 'intro' | 'battle' | 'beat' | 'montage' | 'finale';
/** How the camera frames a scene: the whole occupied system, a fight
 *  close in, or a world's news at a middle distance. */
export type Framing = 'system' | 'battle' | 'world' | 'track';

/** How many ticks a crossing is shown flying (matchMap draws it so). */
export const FLEET_FLIGHT_TICKS = 4;

/** A fleet in flight: hulls of one empire leaving one world for another
 *  together. The camera follows it (framing 'track'). */
export interface FleetMove {
  from: string; to: string; fid: string | null;
  /** Hulls in it. */
  n: number;
  /** The tick it lands. */
  arrive: number;
}

export interface ReelBattle {
  body: string;
  /** The whole engagement, merged across ticks. */
  from: number; to: number;
  /** Hulls present at the height of it, and hulls lost in it. */
  peak: number; lost: number;
  /** The two biggest empires present at the height of it. */
  sides: string[];
  /** The stretch worth showing: where the dying happened. [a, b). */
  window: [number, number];
  /** How many empires had ships there at the height of it. */
  present?: number;
  /** The most hulls in the fight at one time (all sides). */
  atOnce?: number;
  /** What the film calls it: "The First Battle of Mars" when a world saw
   *  more than one, else "The Battle of Mars" (matchMap names them). */
  name?: string;
  /** Its theatre: the worlds where hulls died (a planet's moons fight
   *  as part of the planet's battle). */
  theatre?: string[];
  /** The fleet that flew in to start it, when the record shows one. */
  approach?: FleetMove;
  /** The story's say (the Saga Engine): over 1 a fight the story is about,
   *  under 1 one it is not. Multiplies the battle's weight. */
  boost?: number;
}

export interface ReelBeat {
  tick: number;
  kind: string;
  /** The world it happened at, if it happened at one the film can show. */
  body: string | null;
  /** How much it deserves the screen (0 = ticker line only). */
  weight: number;
  /** Who did it, and to whom, where the log says. */
  fid: string | null;
  target: string | null;
  /** Its event-log line, already worded. */
  text: string;
  /** The log row's payload, for the caption's own wording. */
  data?: Record<string, unknown>;
  /** Seconds the scene holds, overriding the weight's (an elimination). */
  hold?: number;
  /** Ticks the scene opens before `tick` (default 2). Something that
   *  APPEARS on its tick (the Leviathan surfacing) opens one before. */
  lead?: number;
  /** Its own place for the variety rule: a scene that is a different story
   *  from the fight at the same world (a veteran's death) is no repeat. */
  place?: string;
}

export interface ReelFacts {
  lo: number;
  hi: number;
  battles: ReelBattle[];
  beats: ReelBeat[];
  /** The biggest fleets in flight, for tracking shots of their own. */
  fleets?: FleetMove[];
}

export interface ReelScene {
  kind: ReelKind;
  /** Ticks [from, to). Always at least one tick. */
  from: number;
  to: number;
  /** Seconds of film the scene runs for. */
  seconds: number;
  framing: Framing;
  bodyId: string | null;
  battle?: ReelBattle;
  /** The headline a beat scene is about. */
  beat?: ReelBeat;
  /** Other log lines that fall inside the scene, for its ticker. */
  extras: ReelBeat[];
  /** The opening act: the roll call ('opening', each empire introduced on
   *  its home world as its first orders go out) and the land grab. */
  act?: 'opening' | 'landgrab';
  /** Which part of a big battle's arc this is: its first shots, the thick
   *  of it, or how it ends. */
  phase?: 'open' | 'peak' | 'close';
  /** The fleet a tracking shot follows. */
  track?: FleetMove;
}

export interface ReelOptions {
  /** Override the runtime budget, seconds. */
  targetSeconds?: number;
  /** The world the result is about (the star of a Dyson Sphere win). */
  finaleBody?: string | null;
  /** THE OPENING ACT runs to this tick (the first war, say): one scene of
   *  its own, the roll call and the land grab, never cut across. */
  openingTo?: number;
  /** The Saga Engine's timings: the cold open with its crawl, the opening
   *  act with every empire's card, the finale with its roll call. */
  introSeconds?: number;
  openingSeconds?: number;
  /** The roll call's own scene: this many days of the match over this many
   *  seconds of the opening (the rest is the land grab). */
  rollCallTicks?: number;
  rollCallSeconds?: number;
  finaleSeconds?: number;
  /** The share of the runtime kept for the wide shots between scenes (the
   *  establishing shots): the story scenes may not eat into it. */
  establishing?: number;
  /** Big battles told as arcs (open, peak, close). Default on. */
  arcs?: boolean;
}

/** EVERY SCENE HOLDS THIS MUCH LONGER than it was cut at. Players could
 *  not read the captions at the old pace (Lorne, 2026-10-24), so the
 *  film runs up to 3:30 and each scene stays up a fifth longer. */
export const FILM_PACE = 1.2;

/** How long the opening act runs: the roll call, then the land grab. */
export const OPENING_SECONDS = 13 * FILM_PACE;

export const INTRO_SECONDS = 3.4 * FILM_PACE;
export const FINALE_SECONDS = 5.2 * FILM_PACE;
export const BEAT_SECONDS = 2.4 * FILM_PACE;
/** A beat's shortest and longest hold, by weight. */
// Room for the camera to travel there (a zoom out over the map and in on
// the world, about a second) before the moment lands.
export const BEAT_MIN_SECONDS = 4.1 * FILM_PACE;
export const BEAT_MAX_SECONDS = 4.9 * FILM_PACE;
/** A battle gets this much for mattering, plus up to SPREAD for size. */
// Big battles get time to shine (Lorne, 2026-10-22): the deadliest fight
// of a match runs about seventeen seconds.
export const BATTLE_BASE_SECONDS = 4.5 * FILM_PACE;
export const BATTLE_SPREAD_SECONDS = 9.5 * FILM_PACE;
/** The longest stretch of a fight the film will show, in ticks. */
export const BATTLE_WINDOW_TICKS = 14;
/** A montage never runs faster than this many seconds per tick (80 t/s)... */
export const MONTAGE_MIN_RATE = 0.0125;
/** ...or slower than this, however much budget is left over. */
export const MONTAGE_MAX_RATE = 0.35;
/** A montage short of this is a flicker; it borrows from the budget. */
export const MONTAGE_MIN_SECONDS = 0.7;
/** A time-lapse shorter than this is not played: the film cuts across it. */
export const MONTAGE_SKIP_SECONDS = 1.5;
/** What a skipped time-lapse costs: less than any frame, so none lands in it. */
export const SKIPPED_SECONDS = 1e-6;
/** A battle's weight against the headlines': the smallest fight that
 *  makes the cut, and what the deadliest one adds over it. */
export const BATTLE_WEIGHT_FLOOR = 80;
export const BATTLE_WEIGHT_SPREAD = 100;
/** Each earlier scene at the same place multiplies a candidate by this. */
export const REPEAT_DISCOUNT = 0.55;
/** A battle this many ticks long, and at least this big against the
 *  match's biggest (sqrt of weight), is told as an arc. */
export const ARC_MIN_TICKS = 18;
export const ARC_MIN_REL = 0.45;
/** An arc's opening and closing scenes, seconds; a tracking shot. */
export const ARC_OPEN_SECONDS = 4.6 * FILM_PACE;
export const ARC_CLOSE_SECONDS = 4.4 * FILM_PACE;
export const TRACK_SECONDS = 5.4 * FILM_PACE;
/** The smallest fleet that gets a tracking shot of its own. */
export const TRACK_MIN_HULLS = 24;
/** Gaps narrower than this are absorbed by the scene before them. */
const MIN_GAP_TICKS = 3;

/**
 * THE MOST FILM TIME ONE FRAME MAY TAKE, in ms. A hitch in the player (a
 * 200 ms frame) used to advance the whole film six frames' worth at once:
 * every hull lurched, and the effects running on the wall clock fell out
 * of step with the positions running on the film's. Past this a slow frame
 * slows the film for a moment instead of skipping it.
 */
export const FILM_STEP_MAX_MS = 50;

/** The film's length for a match of this many ticks. */
export function reelBudget(span: number): number {
  // About two minutes for a big match (Lorne, 2026-10-22: "it can be
  // longer, and cover more incidents"): ~95 s for 160 days, ~155 s for 525,
  // at the slower pace (FILM_PACE).
  return Math.max(78, Math.min(168, Math.round((60 + Math.max(0, span) * 0.135) * FILM_PACE)));
}

/** Seconds a battle earns: base plus a share that grows with its weight. */
export function battleWeight(b: Pick<ReelBattle, 'peak' | 'lost' | 'window'>): number {
  // Losses first: a battle is the ships that died in it.
  return b.peak + b.lost * 8 + (b.window[1] - b.window[0]);
}

/**
 * The window of a fight worth showing: the BATTLE_WINDOW_TICKS-long
 * stretch with the most losses (ties to the earliest), within [from, to).
 * `deathsAt(t)` is hulls lost at the battle's world on tick t.
 */
export function battleWindow(from: number, to: number,
  deathsAt: (t: number) => number, width = BATTLE_WINDOW_TICKS): [number, number] {
  const span = Math.max(1, to - from);
  if (span <= width) return [from, from + span];
  let best = from, bestN = -1, run = 0;
  for (let t = from; t < from + width; t++) run += deathsAt(t);
  bestN = run; best = from;
  for (let s = from + 1; s + width <= to; s++) {
    run += deathsAt(s + width - 1) - deathsAt(s - 1);
    if (run > bestN) { bestN = run; best = s; }
  }
  return [best, best + width];
}

/**
 * Plan the edit. Deterministic for the same facts.
 */
export function planReel(f: ReelFacts, opts: ReelOptions = {}): ReelScene[] {
  const lo = f.lo, hi = Math.max(f.lo + 1, f.hi);
  const span = hi - lo;
  const target = opts.targetSeconds ?? reelBudget(span);
  const introSec = opts.introSeconds ?? INTRO_SECONDS;
  const openingSec = opts.openingSeconds ?? OPENING_SECONDS;
  const finaleSec = opts.finaleSeconds ?? FINALE_SECONDS;
  /** What the story scenes may spend: the rest is for the wide shots. */
  const sceneBudget = target * (1 - Math.max(0, Math.min(0.5, opts.establishing ?? 0)));

  // The bookends. A one-tick match is all bookend.
  const introTo = Math.min(lo + 1, hi);
  const finaleFrom = Math.max(introTo, hi - 1);
  const openTo = opts.openingTo != null && opts.openingTo - introTo >= 6 && opts.openingTo < finaleFrom - 6
    ? opts.openingTo : null;

  type Cand = { kind: 'battle' | 'beat'; from: number; to: number; weight: number;
    /** Where it happened, for the variety rule. */
    place: string | null;
    /** The two sides of a battle, for the same rule: one rivalry once. */
    pair?: string | null;
    /** A chosen battle this beat cuts short to fit (see fitted). */
    trims?: { battle: Cand; to: number };
    seconds: number; framing: Framing; bodyId: string | null;
    battle?: ReelBattle; beat?: ReelBeat;
    phase?: 'open' | 'peak' | 'close'; track?: FleetMove };
  const cands: Cand[] = [];
  const peakW = Math.max(1, ...f.battles.map(battleWeight));
  /** A fight a quarter the size of the match's biggest reads as a lull
   *  between them: 42 ships between 178 and 277 broke the escalation. */
  const tooSmall = (b: ReelBattle) =>
    b.peak < 12 || b.lost < 3 || (b.atOnce ?? 99) < 24 || b.window[1] - b.window[0] < 3;
  const biggest = Math.max(0, ...f.battles.filter(b => !tooSmall(b)).map(b => b.peak));
  for (const b of f.battles) {
    const w = battleWeight(b);
    // A skirmish of two hulls is a ticker line, not a scene; nor is a
    // standoff where nobody died.
    // Too small or too brief to be a battle on screen: a single tick of
    // record held for four seconds is a freeze frame.
    if (tooSmall(b) || b.peak < biggest * 0.25) continue;
    const from = Math.max(openTo ?? introTo, b.window[0]);
    const to = Math.min(finaleFrom, b.window[1]);
    if (to <= from) continue;
    // ON THE HEADLINES' SCALE. Raw battle weight is hull arithmetic and
    // runs into the hundreds in a big match, which let every battle
    // outrank the Leviathan dying; scaled, the deadliest fight of the
    // match sits level with the biggest headline.
    const rel = Math.sqrt(w / peakW);
    const weight = (BATTLE_WEIGHT_FLOOR + BATTLE_WEIGHT_SPREAD * rel) * (b.boost ?? 1);
    // A BIG, LONG BATTLE IS AN ARC (Lorne, 2026-10-24: "set up and played
    // off"): its first shots, with the fleet that started it flying in;
    // a cut away to the rest of the war; back for the thick of it; and,
    // if it ran on, how it ended.
    const arc = opts.arcs !== false && b.to - b.from >= ARC_MIN_TICKS && rel >= ARC_MIN_REL;
    cands.push({ kind: 'battle', from, to, weight,
      place: b.body, pair: b.sides.length >= 2 ? [...b.sides].sort().join('|') : null,
      // ...but never slower than about a second and a quarter a day: a
      // four-day fight held fourteen seconds is slow motion.
      seconds: Math.min(BATTLE_BASE_SECONDS + BATTLE_SPREAD_SECONDS * rel, Math.max(BATTLE_BASE_SECONDS, (to - from) * 1.25)),
      framing: 'battle', bodyId: b.body, battle: b, phase: arc ? 'peak' : undefined });
    if (arc) {
      const floor = openTo ?? introTo;
      const ap = b.approach;
      const o0 = Math.max(floor, ap ? ap.arrive - FLEET_FLIGHT_TICKS - 1 : b.from - 1);
      const o1 = Math.min(from, ap ? ap.arrive + 2 : b.from + 3, finaleFrom);
      if (o1 - o0 >= 3 && o1 <= from) {
        cands.push({ kind: 'battle', from: o0, to: o1, weight: weight * 0.85, place: `${b.body}:open`, pair: null,
          seconds: ap ? TRACK_SECONDS : ARC_OPEN_SECONDS, framing: ap ? 'track' : 'battle', bodyId: b.body,
          battle: b, phase: 'open', track: ap });
      }
      const c0 = Math.max(to + 3, b.to - 3), c1 = Math.min(finaleFrom, b.to + 1);
      if (c1 - c0 >= 3) {
        cands.push({ kind: 'battle', from: c0, to: c1, weight: weight * 0.6, place: `${b.body}:close`, pair: null,
          seconds: ARC_CLOSE_SECONDS, framing: 'battle', bodyId: b.body, battle: b, phase: 'close' });
      }
    }
  }
  for (const e of f.beats) {
    if (e.weight <= 0) continue;
    // Three ticks with the event in the MIDDLE one: a row stamped tick t
    // happened on the way from t-1 to t, so a scene opening at t-1 showed
    // the aftermath (a carcass, a world already taken). Opening at t-2
    // shows the attacker arrive, the moment, then the result.
    // The opening act tells its own story (the land grab): its headlines
    // ride in it.
    if (openTo != null && e.tick < openTo) continue;
    const from = Math.max(openTo ?? introTo, Math.min(finaleFrom - 1, e.tick - (e.lead ?? 2)));
    // A longer lead is a longer scene (an empire's last stand), never a
    // shorter after.
    // An empire's last stand (lead 3) also keeps two days AFTER its fall:
    // the card that marks it needs time on screen, not the scene's last
    // second.
    const to = Math.min(finaleFrom, from + ((e.lead ?? 2) >= 3 ? (e.lead ?? 2) + 2 : 3));
    if (to <= from) continue;
    // Weight buys time: a declaration is a quick read, a capital falling
    // or the Leviathan dying holds longer. A flat 2.4 s was a metronome.
    // An ARC told at one place -- the Leviathan surfacing then breaking a
    // world, a Sphere begun then struck at 99% -- is different pictures,
    // not repeats: the climax took the repeat discount and lost its scene.
    const place = e.place ?? (/^(kaiju|dyson)_/.test(e.kind) ? `arc:${e.kind}` : e.body ?? `${e.kind}:${e.target ?? e.fid ?? ""}`);
    cands.push({ kind: 'beat', from, to, weight: e.weight, place, pair: null,
      seconds: e.hold ?? Math.max(BEAT_MIN_SECONDS, Math.min(BEAT_MAX_SECONDS, BEAT_MIN_SECONDS + (e.weight - 60) / 60)), framing: e.body ? 'world' : 'system',
      bodyId: e.body, beat: e });
  }
  // THE ARMADAS: a big fleet in flight gets a tracking shot of its own.
  const tracked = new Set(f.battles.map(b => b.approach).filter(Boolean));
  for (const fm of f.fleets ?? []) {
    if (tracked.has(fm) || fm.n < TRACK_MIN_HULLS) continue;
    const from = Math.max(openTo ?? introTo, fm.arrive - FLEET_FLIGHT_TICKS - 1);
    const to = Math.min(finaleFrom, fm.arrive + 1);
    if (to - from < 3) continue;
    const beat: ReelBeat = { tick: fm.arrive, kind: 'fleet_moving', body: fm.to, weight: 0, fid: fm.fid, target: null,
      text: '', data: { n: fm.n, from: fm.from, to: fm.to } };
    cands.push({ kind: 'beat', from, to, weight: 50 + Math.min(70, fm.n), place: `track:${fm.to}`, pair: null,
      seconds: TRACK_SECONDS, framing: 'track', bodyId: fm.to, beat, track: fm });
  }
  // Heaviest first; ties to the earlier moment so the plan is stable.
  cands.sort((a, b) => b.weight - a.weight || a.from - b.from);

  /**
   * What a candidate is worth GIVEN what is already in the cut. A third
   * "Battle for Earth" says less than a first anything else, and a match
   * whose first half has no scenes in it reads as starting halfway: so a
   * repeat place is discounted, and a moment far from everything chosen
   * is worth more.
   */
  const worth = (c: Cand, chosen: Cand[]) => {
    const repeats = chosen.filter(x => (x.place != null && x.place === c.place)
      || (x.pair != null && x.pair === c.pair)).length;
    let gap = span;
    for (const x of chosen) gap = Math.min(gap, Math.abs((x.from + x.to) / 2 - (c.from + c.to) / 2));
    const spread = Math.min(1, gap / Math.max(1, span / 6));
    return c.weight * Math.pow(REPEAT_DISCOUNT, repeats) * (0.75 + 0.5 * spread);
  };

  const chosen: Cand[] = [];
  const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
    a.from < b.to + 1 && b.from < a.to + 1;
  /** The least the montages can cost, given the scenes chosen so far. */
  const montageFloor = (scenes: Cand[]) => {
    const sorted = [...scenes].sort((a, b) => a.from - b.from);
    let cost = 0, cur = openTo ?? introTo;
    const gap = (a: number, b: number) => {
      const n = b - a;
      if (n >= MIN_GAP_TICKS) cost += Math.max(MONTAGE_MIN_SECONDS, n * MONTAGE_MIN_RATE);
    };
    for (const s of sorted) { gap(cur, s.from); cur = Math.max(cur, s.to); }
    gap(cur, finaleFrom);
    return cost;
  };
  /**
   * A BATTLE BENDS AROUND A HEADLINE. A one-tick beat on the last tick of
   * a fight threw the whole fight out: the deadliest battle of a match
   * (126 ships, 31 lost) lost its scene to the Senate vote on its final
   * tick. Trim the battle to the longest stretch clear of what is chosen.
   */
  const fitted = (c: Cand): Cand | null => {
    if (!chosen.some(x => overlaps(x, c))) return c;
    if (c.kind !== 'battle') {
      // A beat can give up its third tick (event first, a tick after) when
      // that is what fits beside a fight.
      const short = { ...c, to: Math.min(c.to, c.from + 2) };
      if (short.to - short.from >= 1 && !chosen.some(x => overlaps(x, short))) return short;
      // ...and a headline can take the end of a chosen FIGHT, if the fight
      // keeps three ticks: the last strike on a 99% Sphere landed inside
      // the final battle's window and lost its scene to it.
      const hit = chosen.filter(x => overlaps(x, short));
      if (hit.length === 1 && hit[0].kind === 'battle') {
        const bt = hit[0];
        const keepTo = short.from - 1;
        if (keepTo - bt.from >= 3 && bt.from < short.from) {
          return { ...short, trims: { battle: bt, to: keepTo } };
        }
      }
      return null;
    }
    let best: [number, number] | null = null;
    for (let a = c.from; a < c.to; a++) {
      for (let b = c.to; b > a; b--) {
        const t = { from: a, to: b };
        if (chosen.some(x => overlaps(x, t))) continue;
        if (!best || b - a > best[1] - best[0]) best = [a, b];
        break;
      }
    }
    if (!best || best[1] - best[0] < 3) return null;
    return { ...c, from: best[0], to: best[1],
      seconds: c.seconds * Math.max(0.6, (best[1] - best[0]) / Math.max(1, c.to - c.from)) };
  };
  let used = introSec + finaleSec + (openTo != null ? openingSec : 0);
  const pool = [...cands];
  for (;;) {
    let best = -1, bestW = 0, bestC: Cand | null = null;
    for (let i = 0; i < pool.length; i++) {
      const c = fitted(pool[i]);
      if (!c) continue;
      // Two headlines at one world back to back are one shot jump-cut.
      if (c.kind === 'beat' && chosen.some(x => x.kind === 'beat' && x.place === c.place
        && Math.abs(x.from - c.from) <= 20)) continue;
      if (used + c.seconds + montageFloor([...chosen, c]) > sceneBudget) continue;
      const w = worth(c, chosen);
      if (w > bestW + 1e-9) { best = i; bestW = w; bestC = c; }
    }
    if (best < 0 || !bestC) break;
    pool.splice(best, 1);
    const c = bestC;
    if (c.trims) {
      const bt = c.trims.battle;
      const was = bt.to - bt.from;
      bt.to = c.trims.to;
      const cut = bt.seconds * (1 - Math.max(0.6, (bt.to - bt.from) / Math.max(1, was)));
      bt.seconds -= cut;
      used -= cut;
      delete c.trims;
    }
    chosen.push(c);
    used += c.seconds;
  }
  chosen.sort((a, b) => a.from - b.from);

  // ---- lay the timeline out ------------------------------------------
  const scenes: ReelScene[] = [];
  scenes.push({ kind: 'intro', from: lo, to: introTo, seconds: introSec,
    framing: 'system', bodyId: null, extras: [] });
  let cur = introTo;
  if (openTo != null) {
    // THE ROLL CALL IS SLOW: its first few days stretched over every
    // empire's card, so each is on its home world as its first ships leave
    // (Lorne, 2026-10-25); the land grab then runs at the opening's pace.
    const rcTo = opts.rollCallSeconds && opts.rollCallTicks
      ? Math.min(openTo - 3, introTo + opts.rollCallTicks) : null;
    if (rcTo != null && rcTo > introTo) {
      scenes.push({ kind: 'montage', from: introTo, to: rcTo, seconds: opts.rollCallSeconds!,
        framing: 'system', bodyId: null, extras: [], act: 'opening' });
      scenes.push({ kind: 'montage', from: rcTo, to: openTo, seconds: Math.max(4, openingSec - opts.rollCallSeconds!),
        framing: 'system', bodyId: null, extras: [], act: 'landgrab' });
    } else {
      scenes.push({ kind: 'montage', from: introTo, to: openTo, seconds: openingSec,
        framing: 'system', bodyId: null, extras: [], act: 'opening' });
    }
    cur = openTo;
  }
  const pushMontage = (a: number, b: number) => {
    if (b <= a) return;
    if (b - a < MIN_GAP_TICKS && scenes.length) {
      // Too short to be a scene: the scene before it simply runs on.
      const prev = scenes[scenes.length - 1];
      // At time-lapse pace: a battle's two ticks must not become four.
      const r = Math.min(MONTAGE_MAX_RATE, prev.seconds / Math.max(1, prev.to - prev.from));
      prev.seconds += r * (b - a);
      prev.to = b;
      return;
    }
    scenes.push({ kind: 'montage', from: a, to: b, seconds: 0,
      framing: 'system', bodyId: null, extras: [] });
  };
  for (const c of chosen) {
    pushMontage(cur, c.from);
    scenes.push({ kind: c.kind, from: c.from, to: c.to, seconds: c.seconds,
      framing: c.framing, bodyId: c.bodyId, battle: c.battle, beat: c.beat, extras: [],
      ...(c.phase ? { phase: c.phase } : {}), ...(c.track ? { track: c.track } : {}) });
    cur = c.to;
  }
  pushMontage(cur, finaleFrom);
  scenes.push({ kind: 'finale', from: finaleFrom, to: hi, seconds: finaleSec,
    framing: opts.finaleBody ? 'world' : 'system', bodyId: opts.finaleBody ?? null, extras: [] });

  // ---- montage pace: spend what is left -------------------------------
  const fixed = scenes.filter(s => s.kind !== 'montage' || s.act).reduce((a, s) => a + s.seconds, 0);
  const montages = scenes.filter(s => s.kind === 'montage' && !s.act);
  const left = Math.max(0, target - fixed);
  // Share by the square root of length: a long quiet stretch earns more
  // film than a short one, but not proportionally more -- it is quiet.
  const share = montages.map(m => Math.sqrt(m.to - m.from));
  const total = share.reduce((a, b) => a + b, 0) || 1;
  montages.forEach((m, i) => {
    const n = m.to - m.from;
    const want = left * share[i] / total;
    m.seconds = Math.min(n * MONTAGE_MAX_RATE,
      Math.max(MONTAGE_MIN_SECONDS, n * MONTAGE_MIN_RATE, want));
  });
  // A TIME CUT, NOT A WHIZZ. A time-lapse too short to read the map in
  // ran a day and a half per frame: held close, hulls crossed the screen
  // between two frames (400-1,600 px, measured frame to frame). The film
  // now cuts straight to the next scene and the day counter jumps, as an
  // edit does; what it frees goes to the time-lapses long enough to play.
  const skip = montages.filter((m, i) => m.seconds < MONTAGE_SKIP_SECONDS && !(i === 0 && m.from === introTo));
  if (skip.length) {
    const kept = montages.filter(m => !skip.includes(m));
    const spare = skip.reduce((a, m) => a + m.seconds, 0);
    for (const m of skip) m.seconds = SKIPPED_SECONDS;
    const keptShare = kept.map(m => Math.sqrt(m.to - m.from));
    const kTotal = keptShare.reduce((a, b) => a + b, 0) || 1;
    kept.forEach((m, i) => {
      m.seconds = Math.min((m.to - m.from) * MONTAGE_MAX_RATE, m.seconds + spare * keptShare[i] / kTotal);
    });
  }

  // ---- every remaining headline rides in the scene it falls in --------
  const headline = new Set(scenes.map(s => s.beat).filter(Boolean));
  for (const e of f.beats) {
    if (headline.has(e)) continue;
    const s = scenes.find(x => e.tick >= x.from && e.tick < x.to)
      ?? (e.tick >= hi ? scenes[scenes.length - 1] : undefined);
    if (s) s.extras.push(e);
  }
  for (const s of scenes) {
    s.extras.sort((a, b) => a.tick - b.tick || b.weight - a.weight);
  }
  return scenes;
}

/** Seconds of film per tick at a tick. */
export function reelRate(scenes: readonly ReelScene[], tick: number): number {
  const s = sceneAt(scenes, tick);
  return s ? s.seconds / Math.max(1, s.to - s.from) : 1;
}

/** The scene playing at a (fractional) tick. */
export function sceneAt(scenes: readonly ReelScene[], t: number): ReelScene | undefined {
  if (!scenes.length) return undefined;
  for (const s of scenes) if (t >= s.from && t < s.to) return s;
  return t < scenes[0].from ? scenes[0] : scenes[scenes.length - 1];
}

/** Seconds of film already played when the clock reads `t`. */
export function filmSecondsAt(scenes: readonly ReelScene[], t: number): number {
  let acc = 0;
  for (const s of scenes) {
    const n = Math.max(1, s.to - s.from);
    if (t >= s.to) { acc += s.seconds; continue; }
    if (t > s.from) acc += (t - s.from) * (s.seconds / n);
    break;
  }
  return acc;
}

/** The whole film's length, seconds. */
export function reelSeconds(scenes: readonly ReelScene[]): number {
  return scenes.reduce((a, s) => a + s.seconds, 0);
}

/**
 * Advance the film clock by `seconds`, spending them tick by tick at each
 * tick's own rate. A frame's worth of time at montage pace is more than
 * one tick, and stepping by the rate of the tick it started in carried
 * the clock clean past the start of the next scene: a 2.6 s headline
 * played for 0.7 s.
 */
export function advanceClock(rateAt: (tick: number) => number, pos: number,
  seconds: number, hi = Infinity): number {
  let p = pos, left = seconds;
  for (let guard = 0; left > 1e-9 && p < hi && guard < 10000; guard++) {
    const tick = Math.floor(p);
    // A skipped time-lapse runs at ~zero seconds a tick: the floor must
    // stay below it, or a frame lands inside the cut.
    const r = Math.max(1e-9, rateAt(tick));
    const need = (tick + 1 - p) * r;
    if (left < need) { p += left / r; left = 0; break; }
    left -= need;
    p = tick + 1;
  }
  return Math.min(p, hi);
}
