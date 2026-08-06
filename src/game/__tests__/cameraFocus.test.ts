import { releaseFocusPosition } from '../cameraFocus';
import { Body } from '../../types';

// Minimal heliocentric bodies. bodyPosition needs orbit elements; a
// circular orbit at radius R with zero phase is enough to prove the
// camera lands ON the body rather than at world origin.
const mk = (id: string, orbitRadius: number, parent?: string): Body => ({
  id, name: id, type: 'terrestrial', parent: parent ?? 'sol',
  radius: 1, soi: 5, mu: 1,
  orbitRadius, orbitPeriod: 100, angle0: 0,
} as unknown as Body);

const SOL = { ...mk('sol', 0), type: 'star', parent: undefined } as unknown as Body;
const EARTH = mk('earth', 400);
const BODIES: Body[] = [SOL, EARTH];

describe('releaseFocusPosition', () => {
  test('THE BUG: releasing focus must not drop the camera at world origin', () => {
    // World origin is the Sun. Focus mode pins x/y to (0,0), so clearing
    // focusedBodyId without repairing them teleported the player to Sol
    // — which is what a stray double-click on empty space did.
    const camera = { x: 0, y: 0, focusedBodyId: 'earth' };
    const pos = releaseFocusPosition(camera, BODIES, 0);
    expect(Math.hypot(pos.x, pos.y)).toBeGreaterThan(1);
  });

  test('lands exactly on the focused body, so the release is a visual no-op', () => {
    const camera = { x: 0, y: 0, focusedBodyId: 'earth' };
    const pos = releaseFocusPosition(camera, BODIES, 0);
    expect(Math.round(Math.hypot(pos.x, pos.y))).toBe(400);
  });

  test('tracks the body as it orbits — not a stale launch position', () => {
    const a = releaseFocusPosition({ x: 0, y: 0, focusedBodyId: 'earth' }, BODIES, 0);
    const b = releaseFocusPosition({ x: 0, y: 0, focusedBodyId: 'earth' }, BODIES, 25);
    // Quarter period on a 100-tick orbit: the body has genuinely moved.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1);
    // ...but stayed on its circle.
    expect(Math.round(Math.hypot(b.x, b.y))).toBe(400);
  });

  test('no focus to release: stored coordinates are already the truth', () => {
    const camera = { x: 123, y: -456, focusedBodyId: undefined };
    expect(releaseFocusPosition(camera, BODIES, 0)).toEqual({ x: 123, y: -456 });
  });

  test('focused body gone (destroyed / absent) falls back, never throws', () => {
    const camera = { x: 77, y: 88, focusedBodyId: 'ghost' };
    expect(releaseFocusPosition(camera, BODIES, 0)).toEqual({ x: 77, y: 88 });
  });

  test('focusing the Sun itself still releases without a jump', () => {
    const camera = { x: 0, y: 0, focusedBodyId: 'sol' };
    const pos = releaseFocusPosition(camera, BODIES, 0);
    expect(Math.round(Math.hypot(pos.x, pos.y))).toBe(0);
  });
});
