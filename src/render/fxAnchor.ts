// ============================================================
// fxAnchor — a kill at a world stays AT the world.
//
// Lorne, 2026-10-21: "the effect of a ship exploding seems to be happening
// not where the ship is last seen, but closer to the planet, and then the
// debris floats away. Can we have the ship explode in place, and then its
// debris orbit the world?"
//
// The blast and the wreck were stored as fixed points in SPACE, but the
// planet they happened at keeps moving along its own orbit. At an hour a
// tick that is invisible; at the Studio's fast tempo a world covers
// several hull-lengths a second, so it slid into its own explosion and
// then left the wreck behind. Anchored, the effect is stored as a place
// AROUND the world: an angle and a distance in units of the world's DRAWN
// radius (so it holds at any zoom, the way battle layouts do), and the
// debris then laps the world at the parked fleet's own pace.
// ============================================================

import type { Body, Ship } from '../types';
import type { RenderContext } from './mapRenderer';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { drawnRadiusOf } from './bodyPresentation';
import { SHIP_VISUAL_ORBIT_MS, spinNowMs } from './tickPhase';

export interface BodyAnchor {
  bodyId: string;
  /** Angle around the world at the moment of death, world axes. */
  ang: number;
  /** Distance from the world's centre over its drawn radius. */
  rFrac: number;
  /** +1 / -1: which way round the hull was circling (world axes). */
  dir: number;
  /** spinNowMs() at death: the lap clock the parked hulls ride on. */
  spinMs0: number;
}

/** Farther out than this (in drawn radii) a death was not "at" the world:
 *  a hull killed in flight near it explodes where it was, in space. */
const MAX_ANCHOR_RADII = 8;

function drawnWorldRadius(body: Body, rc: Pick<RenderContext, 'presentation' | 'camera'>): number {
  const scale = rc.camera.scale > 0 ? rc.camera.scale : 1;
  return drawnRadiusOf(rc.presentation, body, scale) / scale;
}

/** Which way a parked hull circles its world, in world axes. */
export function orbitSense(ship: Pick<Ship, 'orbit'> | null | undefined, t: number): number {
  const o = ship?.orbit;
  if (!o || !(o.period > 0)) return 1;
  const a = localPositionAt(o, t);
  const b = localPositionAt(o, t + o.period / 64);
  const cross = a.x * b.y - a.y * b.x;
  return cross < 0 ? -1 : 1;
}

/** Pin a death at `world` to `body`, or null when it happened too far out
 *  to belong to it. */
export function anchorToBody(
  world: { x: number; y: number },
  body: Body | null | undefined,
  rc: Pick<RenderContext, 'presentation' | 'camera' | 'bodies' | 't'>,
  dir = 1,
): BodyAnchor | null {
  if (!body) return null;
  const bp = bodyPosition(body, rc.t, rc.bodies);
  const dx = world.x - bp.x, dy = world.y - bp.y;
  const r = drawnWorldRadius(body, rc);
  if (!(r > 0)) return null;
  const rFrac = Math.hypot(dx, dy) / r;
  if (rFrac > MAX_ANCHOR_RADII) return null;
  return { bodyId: body.id, ang: Math.atan2(dy, dx), rFrac, dir: dir < 0 ? -1 : 1, spinMs0: spinNowMs() };
}

/** Where an anchored effect is this frame. `orbit` false holds it still
 *  against the world (the blast itself); true laps it with the fleet
 *  (the debris). Null when the world is gone. */
export function anchoredWorldPos(
  a: BodyAnchor,
  rc: Pick<RenderContext, 'presentation' | 'camera' | 'bodies' | 't'>,
  orbit: boolean,
): { x: number; y: number } | null {
  const body = rc.bodies.find(b => b.id === a.bodyId);
  if (!body) return null;
  const bp = bodyPosition(body, rc.t, rc.bodies);
  const r = a.rFrac * drawnWorldRadius(body, rc);
  // spinNowMs() is 0 in lightweight mode, where parked hulls stop
  // circling too; the debris stops with them rather than jumping.
  const now = spinNowMs();
  const lap = orbit && now > 0 && a.spinMs0 > 0 ? (now - a.spinMs0) / SHIP_VISUAL_ORBIT_MS : 0;
  const ang = a.ang + a.dir * lap * Math.PI * 2;
  return { x: bp.x + Math.cos(ang) * r, y: bp.y + Math.sin(ang) * r };
}
