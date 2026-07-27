// System-level label collapse (2026-07-26).
//
// A moon's label is suppressed while its system is a tight knot on screen
// so the cluster reads as one place ("URANUS") instead of five overlapping
// name+yield stacks. Threshold is the system's on-screen RADIUS:
//   systemPx(anchor) = outermost moon's orbitRadius × camera.scale
// Calibrated against Lorne's screenshot of the Uranus system (the map's
// worst case at 5 moons): Oberon's orbit is 50u and rendered ~170px from
// Uranus there, i.e. camera.scale ≈ 3.4.
//
// The rule is replicated here (it lives inline in MapCanvas's render loop,
// which needs a canvas + game state to exercise) so the CALIBRATION is
// locked: if someone retunes the constant, these expectations fail loudly.

const SYSTEM_LABEL_COLLAPSE_PX = 200;

/** Outermost-moon orbit radius per system, from the live map (game_bodies). */
const OUTER_ORBIT: Record<string, number> = {
  neptune: 78,
  jupiter: 75,
  saturn: 65,
  uranus: 50,
  mars: 19,
};

const systemPx = (system: string, scale: number) => OUTER_ORBIT[system] * scale;
const collapsed = (system: string, scale: number) =>
  systemPx(system, scale) < SYSTEM_LABEL_COLLAPSE_PX;
/** Scale at which a system's moon labels start showing. */
const revealScale = (system: string) => SYSTEM_LABEL_COLLAPSE_PX / OUTER_ORBIT[system];

describe('system label collapse — calibration against the screenshot', () => {
  const SCREENSHOT_SCALE = 3.4;

  it('reproduces the screenshot geometry (Oberon ~170px out at scale 3.4)', () => {
    expect(systemPx('uranus', SCREENSHOT_SCALE)).toBeCloseTo(170, 0);
  });

  it('collapses Uranus at the screenshot zoom — just URANUS, no moon stack', () => {
    expect(collapsed('uranus', SCREENSHOT_SCALE)).toBe(true);
  });

  it('reveals the moons on a modest zoom-in past the screenshot', () => {
    expect(revealScale('uranus')).toBeCloseTo(4.0, 1);
    // ~18% closer than the screenshot: present, not a cliff far away.
    expect(revealScale('uranus') / SCREENSHOT_SCALE).toBeLessThan(1.25);
    expect(collapsed('uranus', 4.1)).toBe(false);
  });
});

describe('system label collapse — scales sensibly across systems', () => {
  it('wide systems separate sooner than tight ones', () => {
    const order = Object.keys(OUTER_ORBIT).sort((a, b) => revealScale(a) - revealScale(b));
    // Neptune (78u) opens first; Mars (19u) last.
    expect(order[0]).toBe('neptune');
    expect(order[order.length - 1]).toBe('mars');
  });

  it('keeps Phobos/Deimos collapsed at mid zoom (they used to shove labels across the map)', () => {
    expect(collapsed('mars', 3.4)).toBe(true);
    expect(collapsed('mars', 8)).toBe(true);
  });

  it('every system does eventually reveal — the collapse is never permanent', () => {
    for (const s of Object.keys(OUTER_ORBIT)) {
      expect(collapsed(s, revealScale(s) + 0.01)).toBe(false);
    }
  });

  it('collapses every system when pulled out to the full solar view', () => {
    for (const s of Object.keys(OUTER_ORBIT)) {
      expect(collapsed(s, 0.5)).toBe(true);
    }
  });
});
