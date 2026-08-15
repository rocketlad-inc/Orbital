// Types for worker/transitCombat.js, so the client-side test suite (and
// anything else in src/) can import the SAME module the tick runs rather
// than a TypeScript mirror of it. A mirror is how the server and client
// drifted apart in the first place — see the note at the top of the .js.

export interface Vec2 { x: number; y: number }

export const V_REF: number;
export const AIM_FLOOR: number;
export const OCCLUSION_FACTOR: number;
export const SHIP_RANGE: Record<string, number>;

export interface LaunchPlan {
  launchX: number; launchY: number;
  launchVx: number; launchVy: number;
  accel: number;
  flipTick: number;
  startTick: number;
  arriveTick: number;
  interceptX: number; interceptY: number;
  targetBodyId: string;
}

export function torchStateAt(
  plan: LaunchPlan,
  bodyVelAt: (bodyId: string, t: number) => Vec2,
  t: number,
): { pos: Vec2; vel: Vec2 };

export function segmentIntersectsDisk(a: Vec2, b: Vec2, c: Vec2, r: number): boolean;
export function hasLineOfSight(
  from: Vec2, to: Vec2, bodies: Array<{ x: number; y: number; radius?: number }>,
): boolean;

export function closestApproach(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): {
  dMin: number; dv: number; tStar: number; r0: Vec2; w: Vec2;
};

/** Crossing (tangential) component of `w`. MUST be given `r0` — the
 *  separation at TICK START. At closest approach the split degenerates. */
export function crossingComponent(r0: Vec2, w: Vec2): number;

export function aimFactor(wT: number, vRef?: number): number;

/** Fraction of the tick the pair spent within `range`, solved exactly as
 *  the overlap of the relative segment with the disk. */
export function exposure(r0: Vec2, w: Vec2, range: number): number;

export function hitChance(
  atkSpeed: number, defSpeed: number, k: number, f: number, floor?: number,
): number;

export interface Combatant {
  p0: Vec2; p1: Vec2;
  speed: number;
  shipClass?: string;
}

export function engagement(
  attacker: Combatant,
  defender: Combatant,
  opts?: { range?: number; vRef?: number; floor?: number; sees?: boolean },
): {
  engaged: boolean;
  dMin: number; dv: number; tStar: number;
  wT: number; k: number; f: number; p: number;
};
