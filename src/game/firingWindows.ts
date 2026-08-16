// ============================================================
// firingWindows — WHEN a pair of hulls can shoot each other.
//
// The Situation Report used to answer "how close will they get", which is
// the wrong question. Closest approach is an INSTANT; what decides whether
// you lose a ship is the DURATION you spend inside someone's envelope, and
// how many volleys that buys them. A window also collapses the ambiguity
// the old readout left behind — if no window opens, there is no
// engagement, full stop, rather than a scary number with no consequence.
//
// This is a forecast only in the loosest sense. A committed burn CANNOT be
// re-aimed (that is the whole bargain of transit combat), so both hulls'
// future positions are already determined. The window is not a prediction;
// it is arithmetic on decisions already made.
//
// THE ASYMMETRY IS THE POINT. Reach belongs to the ATTACKER'S class —
// corvette 12, frigate 16, destroyer 20, freighter and colony 0 — and is
// halved inside a planet's sphere of influence. So two hulls closing on
// each other have TWO different windows, and a destroyer opens fire on a
// corvette eight units before the corvette can answer. A single "intercept
// at T+139" line cannot express that; two windows can.
//
// One derivation: the roots come from rangeWindow in worker/transitCombat.js,
// the same module the server's tick calls. Not a mirror — the same file.
// ============================================================

import { Body, GameState, Ship } from '../types';
import { getShipClass } from './shipClasses';

// ---- MIRROR of worker/transitCombat.js — KEEP IN SYNC ----
//
// The worker module cannot be imported here: CRA refuses relative imports
// that escape src/. Jest resolves them fine, which is why the test suite
// imports the real thing while production code has always had to mirror
// it — the inline closest-approach block this module replaces was itself
// a copy for exactly this reason.
//
// So the mirror is unavoidable; what is avoidable is having FIVE of them.
// This is now the one client-side copy, and every surface that wants a
// firing window reads it from here.
//
// V_REF, AIM_FLOOR and the per-class reaches are the tuning constants the
// server scores engagements on. If they change there, change them here —
// a disagreement means the panel promises a shot the tick will not fire.

/** Per-class weapon reach. Freighter and colony are 0: they NEVER shoot. */
const SHIP_RANGE: Record<string, number> = {
  corvette: 12, frigate: 16, destroyer: 20, freighter: 0, colony: 0,
};
/** Reference crossing speed for the aim penalty. */
const V_REF = 45;
/** Floor on aim before exposure is applied. */
const AIM_FLOOR = 0.05;
const EPS = 1e-9;

/** Roots of |r0 + w*t| = range, UNCLAMPED. Null when never entered. */
function rangeWindow(
  r0: { x: number; y: number }, w: { x: number; y: number }, range: number,
): { tEnter: number; tExit: number } | null {
  if (!(range > 0)) return null;
  const a = w.x * w.x + w.y * w.y;
  const c = r0.x * r0.x + r0.y * r0.y - range * range;
  if (a < EPS) return c <= 0 ? { tEnter: -Infinity, tExit: Infinity } : null;
  const b = 2 * (r0.x * w.x + r0.y * w.y);
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const s = Math.sqrt(disc);
  return { tEnter: (-b - s) / (2 * a), tExit: (-b + s) / (2 * a) };
}

/** Crossing component of relative velocity, evaluated AT TICK START.
 *  Evaluating at closest approach is the classic trap: there r is
 *  perpendicular to w by definition, so everything reads as crossing and
 *  the decomposition silently collapses into the model it replaced. */
function crossingComponent(
  r0: { x: number; y: number }, w: { x: number; y: number },
): number {
  const rLen = Math.hypot(r0.x, r0.y);
  if (rLen < EPS) return Math.hypot(w.x, w.y);
  const ux = r0.x / rLen, uy = r0.y / rLen;
  const along = w.x * ux + w.y * uy;
  return Math.hypot(w.x - along * ux, w.y - along * uy);
}

/** Aim penalty from the crossing component. */
const aimFactor = (wT: number): number => 1 + wT / V_REF;

/** p = atk^2 / (atk^2 + (def*k)^2), floored, times exposure. */
function hitChance(atkSpeed: number, defSpeed: number, k: number, f: number): number {
  const a2 = atkSpeed * atkSpeed;
  const d2 = (defSpeed * k) * (defSpeed * k);
  const aimed = a2 + d2 <= 0 ? 0 : a2 / (a2 + d2);
  return Math.max(AIM_FLOOR, aimed) * f;
}
// ---- end mirror ----

export interface FiringWindow {
  /** Absolute tick (fractional) the envelope opens / closes. */
  opensAt: number;
  closesAt: number;
  /** True when the shooting has already started. */
  open: boolean;
  /** Ticks of exposure — how many volleys this buys. */
  duration: number;
  /** Per-shot probability at the moment of closest approach inside the
   *  window, using the same aim model the server scores on. */
  hitChance: number;
  /** Closing speed at the window's open, in units/tick. The "delta v"
   *  a player asks about: high closing speed means a short, hard-to-aim
   *  pass; near zero means a long, accurate grind. */
  closingSpeed: number;
  /** WHERE the DEFENDER is when the window opens — the spot on the map
   *  the shooting starts at. Deliberately the defender's position, not
   *  the midpoint or the shooter's: the marker answers "where does my
   *  ship get hit", and a midpoint marker would sit in empty space
   *  between two hulls and belong to neither. */
  atPoint: Pt;
}

export interface InterceptForecast {
  ship: Ship;
  foe: Ship;
  /** What the FOE can do to you. Null when they can never reach. */
  incoming: FiringWindow | null;
  /** What YOU can do back. Null for an unarmed hull — a freighter's
   *  SHIP_RANGE is 0, so it never returns fire however close it gets. */
  outgoing: FiringWindow | null;
}

type Pt = { x: number; y: number };

/** Reach for one attacker, halved inside a planet's sphere of influence —
 *  the same in-system cut the server applies. */
export function reachOf(cls: string, inSystem: boolean): number {
  const base = (SHIP_RANGE as Record<string, number>)[cls] ?? 0;
  return inSystem ? base * 0.5 : base;
}

/**
 * Walk both hulls forward and stitch the per-tick roots into one window.
 *
 * Sampling tick by tick rather than solving in closed form because the
 * trajectories are torch arcs under acceleration, not straight lines —
 * within ONE tick the segment approximation is what the server itself
 * uses, so agreeing with it per-tick is agreeing with it exactly.
 */
function windowFor(
  posA: (t: number) => Pt,
  posB: (t: number) => Pt,
  reach: number,
  atkSpeed: number,
  defSpeed: number,
  fromTick: number,
  horizon: number,
): FiringWindow | null {
  if (!(reach > 0)) return null;               // unarmed: never a window
  let opensAt: number | null = null;
  let closesAt = 0;
  let bestP = 0;
  let closingAtOpen = 0;
  let openPt: Pt = { x: 0, y: 0 };

  for (let k = 0; k < horizon; k++) {
    const t = fromTick + k;
    const a0 = posA(t), a1 = posA(t + 1);
    const b0 = posB(t), b1 = posB(t + 1);
    const r0 = { x: a0.x - b0.x, y: a0.y - b0.y };
    const w = { x: (a1.x - a0.x) - (b1.x - b0.x), y: (a1.y - a0.y) - (b1.y - b0.y) };
    const win = rangeWindow(r0, w, reach);
    if (!win) { if (opensAt !== null) break; continue; }
    const enter = Math.max(0, win.tEnter);
    const exit = Math.min(1, win.tExit);
    if (exit <= enter) { if (opensAt !== null) break; continue; }

    if (opensAt === null) {
      opensAt = t + enter;
      closingAtOpen = Math.hypot(w.x, w.y);
      // Lerp the DEFENDER (posB) across the tick to the entry instant.
      // Linear within one tick is the same approximation the server's
      // segment test uses, so the marker lands where the tick will
      // actually judge the shot.
      openPt = { x: b0.x + (b1.x - b0.x) * enter, y: b0.y + (b1.y - b0.y) * enter };
    }
    closesAt = t + exit;

    // Aim quality inside this tick, from the SAME decomposition the tick
    // uses: the crossing component evaluated at TICK START. Evaluating it
    // at closest approach is the classic trap — there r is perpendicular
    // to w by definition, so everything reads as crossing and the model
    // silently collapses.
    const wT = crossingComponent(r0, w);
    const k2 = aimFactor(wT);
    const p = hitChance(atkSpeed, defSpeed, k2, 1);
    if (p > bestP) bestP = p;
    // A window that ran to the very end of this tick may continue; one
    // that closed inside it is done.
    if (exit < 1) break;
  }

  if (opensAt === null) return null;
  return {
    opensAt,
    closesAt,
    open: opensAt <= fromTick,
    duration: Math.max(0, closesAt - opensAt),
    hitChance: bestP,
    closingSpeed: closingAtOpen,
    atPoint: openPt,
  };
}

/**
 * Every hostile that will get a shot at one of your hulls, and every hull
 * of yours that will get one back.
 *
 * `posOf` is injected rather than imported so the caller supplies whatever
 * it already trusts for ship positions (the Situation Report steps torch
 * plans; the renderer knows where it actually drew things). Keeping this
 * module free of that choice is what lets the panel, the ship card and the
 * map marker all read one answer.
 */
export function forecastIntercepts(
  gameState: GameState,
  tick: number,
  mine: readonly Ship[],
  posOf: (s: Ship, t: number) => Pt,
  opts: { horizon?: number; atPeace?: (a: string, b: string) => boolean; inSystem?: (p: Pt) => boolean } = {},
): InterceptForecast[] {
  const horizon = opts.horizon ?? 12;
  const atPeace = opts.atPeace ?? (() => false);
  const inSystem = opts.inSystem ?? (() => false);
  const out: InterceptForecast[] = [];

  for (const ship of mine) {
    if (!ship.transit) continue;
    const myClass = getShipClass(ship.class);
    for (const foe of gameState.ships) {
      if (foe.ownedBy === ship.ownedBy) continue;
      if ((foe.hp ?? 1) <= 0) continue;
      if (atPeace(ship.ownedBy, foe.ownedBy)) continue;
      const foeClass = getShipClass(foe.class);
      // Neither side armed → nothing to forecast. Checked before the
      // walk because the walk is the expensive part.
      const foeReachBase = (SHIP_RANGE as Record<string, number>)[foe.class] ?? 0;
      const myReachBase = (SHIP_RANGE as Record<string, number>)[ship.class] ?? 0;
      if (foeReachBase <= 0 && myReachBase <= 0) continue;

      const pA = (t: number) => posOf(ship, t);
      const pB = (t: number) => posOf(foe, t);
      const here = pA(tick);
      const sys = inSystem(here);

      const incoming = windowFor(
        pB, pA, reachOf(foe.class, sys),
        foeClass.speed ?? 0.5, myClass.speed ?? 0.5, tick, horizon,
      );
      const outgoing = windowFor(
        pA, pB, reachOf(ship.class, sys),
        myClass.speed ?? 0.5, foeClass.speed ?? 0.5, tick, horizon,
      );
      if (!incoming && !outgoing) continue;
      out.push({ ship, foe, incoming, outgoing });
    }
  }
  // Soonest threat first — the one a player can still do something about.
  out.sort((a, b) => (a.incoming?.opensAt ?? Infinity) - (b.incoming?.opensAt ?? Infinity));
  return out;
}

/** One line a player can act on. Deliberately leads with WHEN, not with
 *  distance — distance was the old readout and it told nobody anything. */
export function describeWindow(w: FiringWindow | null, tick: number): string {
  if (!w) return 'no firing solution';
  const pct = Math.round(w.hitChance * 100);
  if (w.open) {
    return `firing NOW, closes T+${w.closesAt.toFixed(0)} `
      + `(${w.duration.toFixed(1)} ticks left, ~${pct}%/shot)`;
  }
  return `opens T+${w.opensAt.toFixed(0)}, closes T+${w.closesAt.toFixed(0)} `
    + `(${w.duration.toFixed(1)} ticks, ~${pct}%/shot, closing ${w.closingSpeed.toFixed(1)}/t)`;
}

/** Unused import guard — Body is referenced only in the type position of
 *  callers today, kept so the signature can take bodies without churn. */
export type { Body };
