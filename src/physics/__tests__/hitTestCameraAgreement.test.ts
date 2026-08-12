// [pure] The camera used to HIT-TEST must equal the camera used to DRAW.
//
// Regression guard for the live report: "I click Move to Target and the
// world I'm hovering over doesn't highlight, but wiggling the mouse
// around seemingly random parts of the screen DOES highlight it."
//
// Cause: two independent derivations of "where is the camera really".
// The render path treats camera.x/y as an OFFSET from the focused body
// while the world menu is up (upper-limb framing), eases position, and
// eases scale. effectiveCamera() did none of those, so every hit box sat
// a fixed distance from the sprite it belonged to.
//
// These tests encode the two rules the fix relies on:
//   1. the projection must be fed the SAME camera the frame was drawn
//      with (offset + easing included), and
//   2. overlapping hit boxes resolve to the NEAREST body, not the first
//      one in gameState.bodies.
// Kept in step with hitCam + the hit loops in MapCanvas.tsx.

interface Cam { x: number; y: number; scale: number }

/** Mirror of the RENDER path's camera derivation (MapCanvas render()). */
function renderedCamera(opts: {
  rawX: number; rawY: number; scale: number;
  focusPos?: { x: number; y: number };
  worldMenuActive?: boolean;
}): Cam {
  const { rawX, rawY, scale, focusPos, worldMenuActive } = opts;
  if (!focusPos) return { x: rawX, y: rawY, scale };
  // While the world menu is up camera.x/y is an offset from the body.
  return worldMenuActive
    ? { x: focusPos.x + rawX, y: focusPos.y + rawY, scale }
    : { x: focusPos.x, y: focusPos.y, scale };
}

/** Projection used by both draw and hit test. */
function project(world: { x: number; y: number }, cam: Cam, canvas: { width: number; height: number }) {
  return {
    x: canvas.width / 2 + (world.x - cam.x) * cam.scale,
    y: canvas.height / 2 + (world.y - cam.y) * cam.scale,
  };
}

/** Mirror of the fixed hit loop: nearest inside its radius wins. */
function pickBody(
  click: { x: number; y: number },
  bodies: Array<{ id: string; world: { x: number; y: number }; radius: number }>,
  cam: Cam,
  canvas: { width: number; height: number },
): string | null {
  let pickId: string | null = null;
  let pickDist = Infinity;
  for (const b of bodies) {
    const p = project(b.world, cam, canvas);
    const r = Math.max(12, b.radius * cam.scale + 8);
    const d = Math.hypot(click.x - p.x, click.y - p.y);
    if (d < r && d < pickDist) { pickDist = d; pickId = b.id; }
  }
  return pickId;
}

const CANVAS = { width: 1200, height: 800 };

describe('[pure] hit-test camera must match the drawn camera', () => {
  // Saturn-system geometry from the live game (trYDmIK-kqGc, tick 35).
  const titan = { x: 1093.05, y: 1263.54 };
  const enceladus = { id: 'enceladus', world: { x: 1069.69, y: 1326.22 }, radius: 1 };
  const saturn = { id: 'saturn', world: { x: 1051.48, y: 1317.95 }, radius: 7 };

  it('aims true while a world-menu offset is active (the live bug)', () => {
    // Menu up: the renderer pans the view by the offset so the focused
    // body sits low in the frame.
    const OFFSET = { x: 0, y: -18 };
    const drawn = renderedCamera({
      rawX: OFFSET.x, rawY: OFFSET.y, scale: 10,
      focusPos: titan, worldMenuActive: true,
    });

    // The player puts the cursor exactly on the drawn sprite.
    const onScreen = project(enceladus.world, drawn, CANVAS);

    // Hit-testing with the DRAWN camera finds it.
    expect(pickBody(onScreen, [saturn, enceladus], drawn, CANVAS)).toBe('enceladus');

    // Hit-testing with the OLD effectiveCamera (offset dropped) does not:
    // the box sits |offset| * scale away — 180px here.
    const stale = renderedCamera({
      rawX: OFFSET.x, rawY: OFFSET.y, scale: 10,
      focusPos: titan, worldMenuActive: false,
    });
    expect(pickBody(onScreen, [saturn, enceladus], stale, CANVAS)).not.toBe('enceladus');
  });

  it('aims true mid-zoom, when the drawn scale is still easing', () => {
    const eased = renderedCamera({ rawX: 0, rawY: 0, scale: 6.4, focusPos: titan });
    const target = renderedCamera({ rawX: 0, rawY: 0, scale: 10, focusPos: titan });

    const onScreen = project(enceladus.world, eased, CANVAS);

    expect(pickBody(onScreen, [saturn, enceladus], eased, CANVAS)).toBe('enceladus');
    // Using the un-eased target scale misses by the zoom ratio.
    expect(pickBody(onScreen, [saturn, enceladus], target, CANVAS)).not.toBe('enceladus');
  });

  it('resolves overlapping boxes to the NEAREST body, not array order', () => {
    // Zoomed out far enough that Saturn's padded box (7*scale+8) covers
    // Enceladus, which orbits only 20 units out. Saturn is listed first.
    const cam = renderedCamera({ rawX: 0, rawY: 0, scale: 0.5, focusPos: titan });
    const onEnceladus = project(enceladus.world, cam, CANVAS);

    const rSaturn = Math.max(12, saturn.radius * cam.scale + 8);
    const gap = Math.hypot(
      ...(([
        project(saturn.world, cam, CANVAS).x - onEnceladus.x,
        project(saturn.world, cam, CANVAS).y - onEnceladus.y,
      ]) as [number, number]),
    );
    // Precondition: the boxes really do overlap at this zoom.
    expect(gap).toBeLessThan(rSaturn);

    // Nearest still wins, so the moon stays reachable.
    expect(pickBody(onEnceladus, [saturn, enceladus], cam, CANVAS)).toBe('enceladus');
  });

  it('still picks the planet when the cursor is actually on the planet', () => {
    const cam = renderedCamera({ rawX: 0, rawY: 0, scale: 10, focusPos: titan });
    const onSaturn = project(saturn.world, cam, CANVAS);
    expect(pickBody(onSaturn, [saturn, enceladus], cam, CANVAS)).toBe('saturn');
  });

  it('returns null on genuinely empty space', () => {
    const cam = renderedCamera({ rawX: 0, rawY: 0, scale: 10, focusPos: titan });
    expect(pickBody({ x: 5, y: 5 }, [saturn, enceladus], cam, CANVAS)).toBeNull();
  });
});
