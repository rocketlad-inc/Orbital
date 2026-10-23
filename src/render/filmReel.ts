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
export type Framing = 'system' | 'battle' | 'world';

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
  /** Ticks the scene opens before `tick` (default 2). Something that
   *  APPEARS on its tick (the Leviathan surfacing) opens one before. */
  lead?: number;
}

export interface ReelFacts {
  lo: number;
  hi: number;
  battles: ReelBattle[];
  beats: ReelBeat[];
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
}

export interface ReelOptions {
  /** Override the runtime budget, seconds. */
  targetSeconds?: number;
  /** The world the result is about (the star of a Dyson Sphere win). */
  finaleBody?: string | null;
}

export const INTRO_SECONDS = 3.4;
export const FINALE_SECONDS = 5.2;
export const BEAT_SECONDS = 2.4;
/** A beat's shortest and longest hold, by weight. */
// Room for the camera to travel there (a zoom out over the map and in on
// the world, about a second) before the moment lands.
export const BEAT_MIN_SECONDS = 4.1;
export const BEAT_MAX_SECONDS = 4.9;
/** A battle gets this much for mattering, plus up to SPREAD for size. */
// Big battles get time to shine (Lorne, 2026-10-22): the deadliest fight
// of a match runs about fourteen seconds, at about a second a day.
export const BATTLE_BASE_SECONDS = 4.5;
export const BATTLE_SPREAD_SECONDS = 9.5;
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
/** Gaps narrower than this are absorbed by the scene before them. */
const MIN_GAP_TICKS = 3;

/** The film's length for a match of this many ticks. */
export function reelBudget(span: number): number {
  // About two minutes for a big match (Lorne, 2026-10-22: "it can be
  // longer, and cover more incidents"): ~80 s for 160 days, ~130 s for 525.
  return Math.max(65, Math.min(140, Math.round(60 + Math.max(0, span) * 0.135)));
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

  // The bookends. A one-tick match is all bookend.
  const introTo = Math.min(lo + 1, hi);
  const finaleFrom = Math.max(introTo, hi - 1);

  type Cand = { kind: 'battle' | 'beat'; from: number; to: number; weight: number;
    /** Where it happened, for the variety rule. */
    place: string | null;
    /** The two sides of a battle, for the same rule: one rivalry once. */
    pair?: string | null;
    /** A chosen battle this beat cuts short to fit (see fitted). */
    trims?: { battle: Cand; to: number };
    seconds: number; framing: Framing; bodyId: string | null;
    battle?: ReelBattle; beat?: ReelBeat };
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
    const from = Math.max(introTo, b.window[0]);
    const to = Math.min(finaleFrom, b.window[1]);
    if (to <= from) continue;
    // ON THE HEADLINES' SCALE. Raw battle weight is hull arithmetic and
    // runs into the hundreds in a big match, which let every battle
    // outrank the Leviathan dying; scaled, the deadliest fight of the
    // match sits level with the biggest headline.
    const rel = Math.sqrt(w / peakW);
    cands.push({ kind: 'battle', from, to, weight: BATTLE_WEIGHT_FLOOR + BATTLE_WEIGHT_SPREAD * rel,
      place: b.body, pair: b.sides.length >= 2 ? [...b.sides].sort().join('|') : null,
      // ...but never slower than about a second and a quarter a day: a
      // four-day fight held fourteen seconds is slow motion.
      seconds: Math.min(BATTLE_BASE_SECONDS + BATTLE_SPREAD_SECONDS * rel, Math.max(BATTLE_BASE_SECONDS, (to - from) * 1.25)),
      framing: 'battle', bodyId: b.body, battle: b });
  }
  for (const e of f.beats) {
    if (e.weight <= 0) continue;
    // Three ticks with the event in the MIDDLE one: a row stamped tick t
    // happened on the way from t-1 to t, so a scene opening at t-1 showed
    // the aftermath (a carcass, a world already taken). Opening at t-2
    // shows the attacker arrive, the moment, then the result.
    const from = Math.max(introTo, Math.min(finaleFrom - 1, e.tick - (e.lead ?? 2)));
    const to = Math.min(finaleFrom, from + 3);
    if (to <= from) continue;
    // Weight buys time: a declaration is a quick read, a capital falling
    // or the Leviathan dying holds longer. A flat 2.4 s was a metronome.
    // An ARC told at one place -- the Leviathan surfacing then breaking a
    // world, a Sphere begun then struck at 99% -- is different pictures,
    // not repeats: the climax took the repeat discount and lost its scene.
    const place = /^(kaiju|dyson)_/.test(e.kind) ? `arc:${e.kind}` : e.body ?? `${e.kind}:${e.target ?? e.fid ?? ""}`;
    cands.push({ kind: 'beat', from, to, weight: e.weight, place, pair: null,
      seconds: Math.max(BEAT_MIN_SECONDS, Math.min(BEAT_MAX_SECONDS, BEAT_MIN_SECONDS + (e.weight - 60) / 60)), framing: e.body ? 'world' : 'system',
      bodyId: e.body, beat: e });
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
    let cost = 0, cur = introTo;
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
  let used = INTRO_SECONDS + FINALE_SECONDS;
  const pool = [...cands];
  for (;;) {
    let best = -1, bestW = 0, bestC: Cand | null = null;
    for (let i = 0; i < pool.length; i++) {
      const c = fitted(pool[i]);
      if (!c) continue;
      // Two headlines at one world back to back are one shot jump-cut.
      if (c.kind === 'beat' && chosen.some(x => x.kind === 'beat' && x.place === c.place
        && Math.abs(x.from - c.from) <= 20)) continue;
      if (used + c.seconds + montageFloor([...chosen, c]) > target) continue;
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
  scenes.push({ kind: 'intro', from: lo, to: introTo, seconds: INTRO_SECONDS,
    framing: 'system', bodyId: null, extras: [] });
  let cur = introTo;
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
      framing: c.framing, bodyId: c.bodyId, battle: c.battle, beat: c.beat, extras: [] });
    cur = c.to;
  }
  pushMontage(cur, finaleFrom);
  scenes.push({ kind: 'finale', from: finaleFrom, to: hi, seconds: FINALE_SECONDS,
    framing: opts.finaleBody ? 'world' : 'system', bodyId: opts.finaleBody ?? null, extras: [] });

  // ---- montage pace: spend what is left -------------------------------
  const fixed = scenes.filter(s => s.kind !== 'montage').reduce((a, s) => a + s.seconds, 0);
  const montages = scenes.filter(s => s.kind === 'montage');
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
