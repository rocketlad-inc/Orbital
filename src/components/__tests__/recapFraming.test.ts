// Recap scene framing + effect selection (2026-07-27).
//
// THE BUG THIS PINS: the old zoom was
//     scale = RECAP_ZOOM_BOOST * (MOON_ORBIT_MIN_PARENT_PX + 4) / radius
// i.e. scale = K / radius, so rendered radius = radius x scale = K for
// EVERY body. Earth, Jupiter and a moon all framed as the same ~18px
// speck, with moons and ships off-frame. The replacement fits the
// content extent instead. Rules are mirrored here because the real ones
// live inside a render effect that needs a canvas + live game state.

const RECAP_ZOOM_BOOST = 1.1;
const OLD_K = RECAP_ZOOM_BOOST * (12 + 4); // MOON_ORBIT_MIN_PARENT_PX + 4

interface Body { id: string; radius: number; moons: number[] }

/** Live map values (game_bodies, prod). */
const EARTH: Body = { id: 'earth', radius: 3, moons: [20] };
const JUPITER: Body = { id: 'jupiter', radius: 8, moons: [12, 25, 45, 75] };
const GANYMEDE: Body = { id: 'ganymede', radius: 2, moons: [] };
const MARS: Body = { id: 'mars', radius: 2.5, moons: [11, 19] };

const clamp = (v: number) => Math.max(2, Math.min(60, v));
const oldScale = (b: Body) => clamp(OLD_K / Math.max(0.5, b.radius));

/** New rule: frame the content this scene actually needs. */
function needRadius(b: Body): number {
  const parked = (b.radius || 4) + 4;
  const need = b.moons.length > 0 ? Math.max(...b.moons) * 1.15 : parked * 3.5;
  return Math.max(need, parked * 3);
}
function newScale(b: Body, halfMin = 540): number {
  return clamp(RECAP_ZOOM_BOOST * (halfMin * 0.62) / needRadius(b));
}
const renderedPx = (b: Body, scale: number) => b.radius * scale;
const systemPx = (b: Body, scale: number) =>
  (b.moons.length ? Math.max(...b.moons) : 0) * scale;

const ALL = [EARTH, JUPITER, GANYMEDE, MARS];

describe('recap framing — the old rule collapsed every body to one size', () => {
  it('old scale rendered EVERY body at the same ~18px (radius cancels out)', () => {
    const sizes = ALL.map(b => renderedPx(b, oldScale(b)));
    for (const px of sizes) expect(px).toBeCloseTo(OLD_K, 5);
    expect(new Set(sizes.map(p => p.toFixed(3))).size).toBe(1);
  });

  it('old scale left Earth a speck', () => {
    expect(renderedPx(EARTH, oldScale(EARTH))).toBeLessThan(20);
  });
});

describe('recap framing — the new rule fits content', () => {
  it('gives each body a DIFFERENT, size-appropriate scale', () => {
    const scales = ALL.map(b => newScale(b));
    expect(new Set(scales.map(s => s.toFixed(3))).size).toBe(ALL.length);
  });

  it('makes Earth readable instead of a speck', () => {
    const px = renderedPx(EARTH, newScale(EARTH));
    expect(px).toBeGreaterThan(35);
    expect(px).toBeGreaterThan(renderedPx(EARTH, oldScale(EARTH)) * 2);
  });

  it('frames a planet out to its outermost moon, inside the viewport', () => {
    for (const b of [EARTH, JUPITER, MARS]) {
      const span = systemPx(b, newScale(b));
      expect(span).toBeGreaterThan(200);   // moons clearly separated...
      expect(span).toBeLessThan(540);      // ...and still on screen
    }
  });

  it('frames a moonless body close enough to see its parked hulls', () => {
    // Ships park at radius + 4 game units.
    const parkedPx = ((GANYMEDE.radius || 4) + 4) * newScale(GANYMEDE);
    expect(parkedPx).toBeGreaterThan(60);
    expect(renderedPx(GANYMEDE, newScale(GANYMEDE))).toBeGreaterThan(25);
  });

  it('clears the 200px system-label collapse, so narrated moons get named', () => {
    // The recap captions specific moons ("...works up in Ganymede orbit"),
    // which is useless if the label is collapsed at that zoom.
    for (const b of [EARTH, JUPITER, MARS]) {
      expect(systemPx(b, newScale(b))).toBeGreaterThan(200);
    }
  });

  it('stays inside the camera clamp for every body', () => {
    for (const b of ALL) {
      expect(newScale(b)).toBeGreaterThanOrEqual(2);
      expect(newScale(b)).toBeLessThanOrEqual(60);
    }
  });

  it('adapts to viewport size rather than assuming one screen', () => {
    expect(newScale(JUPITER, 300)).toBeLessThan(newScale(JUPITER, 800));
  });
});

describe('recap effects — the good beats are no longer silent', () => {
  function fxFor(line: string): 'boom' | 'bloom' | 'spark' | undefined {
    if (/DISCOVERY|databank|stargate|warp gate/i.test(line)) return 'bloom';
    if (/destroyed|fell|impact|detonat|stops transmitting|debris|lost with|went down/i.test(line)) return 'boom';
    if (/founded|took delivery|launched|completed|colonis|coloniz|settled|claimed|recovered|rescued|elected|ratified|passed|signed|delivered|advanced|breakthrough/i.test(line)) return 'spark';
    return undefined;
  }

  it('fires a firework on the beat from the screenshot that played nothing', () => {
    expect(fxFor('Sun Never Sets On The Solar Empire took delivery of the Scylla this cycle.'))
      .toBe('spark');
  });

  it('covers the other celebratory beats', () => {
    expect(fxFor('The Empire of Lorne founded city New Lorneland on Miranda')).toBe('spark');
    expect(fxFor('Captain Vela Ordoñez was recovered from the wreck of the Osprey')).toBe('spark');
    expect(fxFor('yard at Vesta launched a corvette Razorback')).toBe('spark');
  });

  it('still reads destruction as a blast, and destruction WINS over celebration', () => {
    expect(fxFor('corvette Comet destroyed at Deimos')).toBe('boom');
    // Contains "founded" but is a death — must not read as a celebration.
    expect(fxFor('the colony they founded was destroyed')).toBe('boom');
    expect(fxFor('Captain Iris Okafor went down with the Temperance')).toBe('boom');
  });

  it('keeps discoveries on the purple bloom', () => {
    expect(fxFor('DISCOVERY: an ancient databank')).toBe('bloom');
  });
});
