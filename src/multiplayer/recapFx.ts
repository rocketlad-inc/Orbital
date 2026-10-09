// ============================================================
// recapFx — the game's combat look, for the two recaps.
//
// The single-battle recap (BattleReview BattleRecap) and the whole-system
// view (TheatreRecap) both replay a battle record. They used to draw it
// with their own fire, their own explosions and their own size tables,
// and drifted from the map and from each other. Lorne, 2026-10-09:
// effects "up to parity with the game", hulls "sized appropriately to
// each other", then "do the whole system view too". Everything both
// recaps draw the same way lives here, built from the map's own pieces
// (fxArt, FX_TUNING, shipIconSize, the structure sheet), so the two
// cannot drift apart again.
// ============================================================

import {
  drawRound, drawMuzzle, drawBeam, drawCharge, drawSparks, drawHullHit, drawShieldHit, drawScorch,
  glowAt, ENERGY_FX, drawExplosion, drawHullBreakup,
} from '../render/fxArt';
import { drawBurn } from '../render/fxPrimitives';
import { FX_TUNING, kineticRoundsOf, burstSlots } from '../render/fxTuning';
import { hashStr } from '../render/planetTexture';
import { getShipIconImage } from '../render/shipIconCache';
import { getStructureIconImage } from '../render/structureIconCache';
import { shipIconSize } from '../render/mapRenderer';
import { isCapitalHull } from '../render/megastructureArt';
import { iconClassFor, type ShipIconClass, type ShipIconVariant } from '../components/ShipIcons';
import type { MegastructureKind } from '../game/megastructures';

// ---------------------------------------------------------------- hulls

const ICON_CLASSES: ShipIconClass[] = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];

/** The silhouette a hull class borrows (capitals have their own art; see
 *  hullImage), or null when the class is not a hull at all. */
export function iconClassOf(cls: string | null | undefined): ShipIconClass | null {
  const c = (cls ?? '').toLowerCase();
  if ((ICON_CLASSES as string[]).includes(c)) return c as ShipIconClass;
  if (isCapitalHull(c) || c === 'kaiju') return iconClassFor(c);
  return null;
}

/** A hull's full map size, px (mapRenderer shipIconSize: the Bold
 *  ladder), or null when the class is not a hull. Each recap scales it. */
export function gameHullPx(cls: string | null | undefined): number | null {
  const c = (cls ?? '').toLowerCase();
  return iconClassOf(c) ? shipIconSize(c, false) : null;
}

/** The sprite a hull is drawn with, as the map draws it: a capital hull
 *  from the structure sheet it was built from, everything else its own
 *  ship icon. */
export function hullImage(
  cls: string | null | undefined, color: string, variant: ShipIconVariant | undefined, trim: string | undefined,
): CanvasImageSource | null {
  const c = (cls ?? '').toLowerCase();
  if (isCapitalHull(c)) return getStructureIconImage(c as MegastructureKind, color, null, trim);
  const ic = iconClassOf(c);
  return ic ? getShipIconImage(ic, color, variant, trim) : null;
}

// ---------------------------------------------------------------- clock

/**
 * Each volley's launch time inside its beat, as a fraction of it.
 *
 * In the ORDER THE SERVER RESOLVED THEM (the shot log's order), spread
 * across most of the beat with a seeded nudge inside each slot, so a
 * fleet's fire rolls down the line and a killing shot lands after the
 * hits before it. A hashed slot per shot over a third of the beat read as
 * one synchronized salvo (Lorne, 2026-10-09).
 *
 * A hull MOVING INTO PLACE this beat (`movingUntil` gives the fraction
 * of the beat its move takes) neither fires nor is fired on until it is
 * there: shots to or from it are fitted, in the same order, between the
 * end of its move and the last launch that still lands inside the beat.
 */
export interface RecapClock {
  /** Launch, as a fraction of the beat. */
  launchOf: (sh: RecapShot) => number;
  /** When the volley lands, ms into the beat. */
  arriveMsOf: (sh: RecapShot) => number;
  /** When a hull that dies this beat goes up: as the LAST round to hit
   *  it lands (a held-back round must never fly into a wreck). */
  killMsOf: (id: string) => number;
}
export interface RecapShot {
  a: string | null; t: string | null; hit: number; dmg: number; kill: number;
  e?: number; abs?: number;
}
/** How long a volley is in the air, as a share of the beat: the game's
 *  own bolt time (a kinetic burst's last round, or a beam's whole burn). */
export const flightFrac = (tickMs: number) => FX_TUNING.boltMs / tickMs;
/** Volleys of hulls already in place go off across this much of a beat. */
export const LAUNCH_SPREAD = 0.48;
/** Latest a volley may launch and still land, and finish its impact,
 *  inside the beat. */
export const launchLast = (tickMs: number) =>
  1 - flightFrac(tickMs) - FX_TUNING.impactMs / tickMs - 0.01;

export function recapClock(
  shots: readonly RecapShot[], tick: number, tickMs: number,
  movingUntil: (id: string | null) => number | null,
): RecapClock {
  const index = new Map(shots.map((sh, n) => [sh, n]));
  const n = Math.max(1, shots.length);
  const flight = flightFrac(tickMs);
  const last = launchLast(tickMs);
  const launchOf = (sh: RecapShot) => {
    const nudge = (hashStr(`${sh.a ?? ''}>${sh.t ?? ''}@${tick}`) % 997) / 997;
    const slot = ((index.get(sh) ?? 0) + 0.15 + nudge * 0.7) / n;
    const wait = Math.max(movingUntil(sh.a) ?? 0, movingUntil(sh.t) ?? 0);
    return wait > 0 ? wait + slot * Math.max(0, last - wait) : slot * LAUNCH_SPREAD;
  };
  const arriveMsOf = (sh: RecapShot) => (launchOf(sh) + flight) * tickMs;
  const kills = new Map<string, number>();
  for (const sh of shots) if (sh.kill && sh.t) kills.set(sh.t, arriveMsOf(sh));
  for (const sh of shots) {
    if (!sh.t || !sh.hit || !kills.has(sh.t)) continue;
    const at = arriveMsOf(sh);
    if (at > kills.get(sh.t)!) kills.set(sh.t, at);
  }
  const fallback = (LAUNCH_SPREAD / 2 + flight) * tickMs;
  return { launchOf, arriveMsOf, killMsOf: (id) => kills.get(id) ?? fallback };
}

// ---------------------------------------------------------------- fire

export interface Volley {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Shooter and target hit radii, px (a hull's half-size plus a little). */
  sR: number;
  tR: number;
  energy: boolean;
  hit: boolean;
  /** Damage through, and what defences held (the record's `abs`). */
  dmg: number;
  abs: number;
  targetKind: 'ship' | 'station' | 'city';
  targetShields: number;
  targetArmor: number;
  shooterCls: string | undefined;
  /** ms since this volley launched. */
  within: number;
  /** ms the volley is in the air. */
  flightMs: number;
  seed: number;
  nowMs: number;
}

/**
 * One volley, as the map draws it (combatFx drawEngagementFire, fxArt):
 * a kinetic hull fires a BURST, one round per corvette, two per frigate,
 * three per destroyer, each with its own muzzle flash and a small hit as
 * it lands; an energy hull charges its emitter and burns a beam across.
 * Then the impact, by the map's counters: shields light up under kinetic
 * fire, armor scatters a beam, everything else takes the flash or the
 * burn. What a recap knows and the map does not, it keeps: a volley that
 * MISSED flies wide and lands on nothing, and a settlement whose shield
 * held most of it is hit on its bubble.
 *
 * The caller sets the 'lighter' composite and skips volleys outside
 * [0, flightMs + impactMs].
 */
export function drawVolley(g: CanvasRenderingContext2D, v: Volley): void {
  const { from, to, sR, tR, energy, within, flightMs, seed, nowMs } = v;
  const hitAng = Math.atan2(from.y - to.y, from.x - to.x);
  let faceX = to.x + Math.cos(hitAng) * tR * 0.3;
  let faceY = to.y + Math.sin(hitAng) * tR * 0.3;
  const bubble = v.hit && v.targetKind !== 'ship' && v.abs > (v.dmg || 0) * 0.5
    ? { x: to.x, y: to.y, r: tR * 1.6 + Math.max(2, tR * 0.3) } : null;
  if (bubble) {
    faceX = bubble.x + Math.cos(hitAng) * bubble.r;
    faceY = bubble.y + Math.sin(hitAng) * bubble.r;
  }
  if (!v.hit) {
    const side = (seed & 1) ? 1 : -1;
    const off = tR * 1.4 + Math.max(3, tR * 0.6);
    faceX = to.x + Math.cos(hitAng + Math.PI / 2) * off * side - Math.cos(hitAng) * tR;
    faceY = to.y + Math.sin(hitAng + Math.PI / 2) * off * side - Math.sin(hitAng) * tR;
  }

  const ang0 = Math.atan2(faceY - from.y, faceX - from.x);
  const mx = from.x + Math.cos(ang0) * sR * 0.45;
  const my = from.y + Math.sin(ang0) * sR * 0.45;
  if (within < flightMs) {
    if (energy) {
      const bw = Math.max(1.5, Math.min(3.4, sR * 0.11)) * Math.min(1, sR / 12);
      if (within < FX_TUNING.chargeMs) {
        drawCharge(g, mx, my, bw * 2.4, within / FX_TUNING.chargeMs, nowMs, seed);
      } else {
        const bk = (within - FX_TUNING.chargeMs) / Math.max(1, flightMs - FX_TUNING.chargeMs);
        const beamA = (bk < 0.12 ? bk / 0.12 : bk > 0.75 ? 1 - (bk - 0.75) / 0.25 : 1)
          * (v.hit ? 1 : 0.55);
        drawBeam(g, mx, my, faceX, faceY, bw, beamA, nowMs, seed);
        if (v.hit && !bubble) {
          drawScorch(g, faceX, faceY, tR * 0.35, Math.min(0.9, bk * 0.5), hitAng, seed ^ 0x51);
        }
      }
    } else {
      const rw = Math.max(1.1, Math.min(2.4, sR * 0.075)) * Math.min(1, sR / 12);
      const burst = burstSlots(kineticRoundsOf(v.shooterCls));
      const gap = FX_TUNING.roundGapMs;
      const flight = Math.max(120, flightMs - (burst.slots - 1) * gap);
      for (let rd = burst.first; rd < burst.slots; rd++) {
        const w2 = within - rd * gap;
        if (w2 < 0) continue;
        const k = w2 / flight;
        if (w2 < FX_TUNING.muzzleMs) drawMuzzle(g, mx, my, ang0, sR * 0.6, 1 - w2 / FX_TUNING.muzzleMs);
        if (k >= 1) {
          const lk = (k - 1) / 0.35;
          if (v.hit && lk < 1 && !bubble) drawHullHit(g, faceX, faceY, hitAng, tR * 0.28, lk, seed + rd);
          continue;
        }
        const hx = mx + (faceX - mx) * k, hy = my + (faceY - my) * k;
        const dist = Math.hypot(faceX - mx, faceY - my);
        const len = Math.min(dist * k, Math.max(10, Math.min(30, dist * 0.14)) * Math.max(0.7, rw / 1.6)
          * Math.min(1, sR / 12));
        const ux = (faceX - mx) / (dist || 1), uy = (faceY - my) / (dist || 1);
        drawRound(g, hx - ux * len, hy - uy * len, hx, hy, rw, v.hit ? 1 : 0.6);
      }
    }
    return;
  }

  if (!v.hit) return;
  const ik = (within - flightMs) / FX_TUNING.impactMs;
  if (ik >= 1) return;
  if (bubble) {
    drawShieldHit(g, bubble.x, bubble.y, bubble.r, hitAng, ik, 0.8, seed,
      energy ? ENERGY_FX : undefined);
  } else if (energy) {
    if (v.targetArmor > 0) {
      glowAt(g, faceX, faceY, tR * 0.5, ENERGY_FX.core, ENERGY_FX.glow, (1 - ik) * 0.6);
      drawSparks(g, faceX, faceY, hitAng, 1.9, 6, tR * 1.5, ik, seed, ENERGY_FX, Math.max(0.8, tR * 0.06));
    } else {
      drawScorch(g, faceX, faceY, tR * 0.42, 0.45 + ik * 0.55, hitAng, seed ^ 0x51);
    }
  } else if (v.targetKind === 'ship' && v.targetShields > 0) {
    drawShieldHit(g, to.x, to.y, Math.max(Math.min(8, tR + 3), tR + 3), hitAng, ik,
      Math.min(1, v.targetShields / 3), seed);
  } else {
    drawHullHit(g, faceX, faceY, hitAng, tR * 0.5, ik, seed);
  }
}

// ---------------------------------------------------------------- loss

/** Beats a wreck holds and fades over: combatFx WRECK_LIFE_TICKS. */
export const WRECK_LIFE_TICKS = 6;

/** A wreck's opacity at `ageMs`, as the map fades one (full for two
 *  thirds of its life, then out), never below `floor`. */
export function wreckAlpha(ageMs: number, tickMs: number, floor = 0): number {
  const k = ageMs / (WRECK_LIFE_TICKS * tickMs);
  return Math.max(floor, k < 0.66 ? 1 : 1 - (k - 0.66) / 0.34);
}

/** A hull coming apart as ITSELF: its own sprite in charred pieces
 *  (fxArt drawHullBreakup), as the map draws a wreck. */
export function drawHullWreck(
  g: CanvasRenderingContext2D, img: CanvasImageSource, size: number, heading: number,
  x: number, y: number, ageMs: number, id: string, alpha: number,
): void {
  drawHullBreakup(g, { img, size, heading }, x, y, 1, ageMs, hashStr(id), alpha);
}

/** The fireball a death goes up in, sized to what died (mapRenderer's
 *  'destruction' flash: hit radius x 1.3). */
export function drawDeathBlast(
  g: CanvasRenderingContext2D, x: number, y: number, hitR: number, sinceMs: number, id: string,
): void {
  if (sinceMs < 0 || sinceMs >= FX_TUNING.explosionMs) return;
  drawExplosion(g, x, y, hitR * 1.3, sinceMs / FX_TUNING.explosionMs, hashStr(id) >>> 0);
}

/**
 * A hull on fire, by the map's rule (combatFx drawBattleDamageStates): a
 * hull hit this beat or last catches a moment after the round lands, and
 * a crippled one (under FX_TUNING.crippledBelow) burns until it dies.
 */
export function drawDamageFire(
  g: CanvasRenderingContext2D, x: number, y: number, baseR: number, frac: number,
  hit: { firstHitMs: number | null; beatMs: number; hitLastBeat: boolean },
  id: string, nowMs: number, dim = 1, minR = 6,
): void {
  const recent = (hit.firstHitMs != null && hit.beatMs >= hit.firstHitMs) || hit.hitLastBeat;
  const crippled = frac < FX_TUNING.crippledBelow;
  if (!recent && !crippled) return;
  let ramp = 1;
  if (hit.firstHitMs != null && !hit.hitLastBeat && !crippled) {
    const phase = ((hashStr(id) % 1000) / 1000) * FX_TUNING.igniteDelayMs;
    ramp = Math.max(0, Math.min(1, (hit.beatMs - hit.firstHitMs - phase) / FX_TUNING.igniteRampMs));
  }
  const sev = Math.max(recent ? 0.5 : 0.25, 1 - frac);
  if (ramp > 0.01) drawBurn(g, x, y, Math.max(minR, baseR * 0.8), sev * ramp * dim, nowMs, hashStr(id));
}

// ---------------------------------------------------------------- flight

/**
 * A hull's nose and its burn while it moves into place, as the map's
 * shaped burns fly (mapRenderer drawTorchShip): it boosts nose-first,
 * FLIPS at the middle, and brakes engine-first with the flame ahead of
 * its motion, then swings onto its orbit as the burn dies. A hull that
 * arrives from off the board is already on its brake when it comes into
 * view (`brakeOnly`).
 *
 * `k` is how far through the move it is (0..1), `travel` its direction of
 * motion, `settle` the heading it ends on. Returns the hull's heading,
 * the plume's intensity (0..1) and its length multiplier (the map's 1.4
 * through the hard brake).
 */
export function burnPose(
  k: number, travel: number, settle: number, brakeOnly: boolean,
): { heading: number; burn: number; lengthMul: number } {
  const wrap = (a: number) => {
    let d = a % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  const smooth = (u: number) => { const c = Math.max(0, Math.min(1, u)); return c * c * (3 - 2 * c); };
  const retro = travel + Math.PI;
  // The last fifth: onto the orbit, the plume dying mid-turn.
  const s = smooth((k - 0.8) / 0.2);
  if (!brakeOnly && k < 0.5) {
    // Boost, with the flip over the last moments of it.
    const flip = smooth((k - 0.44) / 0.06);
    return {
      heading: travel + Math.PI * flip,
      burn: (0.55 + 0.45 * (k / 0.5)) * Math.abs(Math.cos(Math.PI * flip)),
      lengthMul: 0.7 + 0.7 * (k / 0.5),
    };
  }
  const bk = brakeOnly ? k : (k - 0.5) / 0.5;
  return {
    heading: retro + wrap(settle - retro) * s,
    burn: Math.max(0, 1 - bk * bk * 1.15) * (1 - s),
    lengthMul: 1.4,
  };
}
