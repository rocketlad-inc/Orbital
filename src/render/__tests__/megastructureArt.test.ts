// THE WORDS UNDER THE BAR HAVE TO MATCH THE SHAPE ON THE MAP.
//
// The site panel prints a stage name and the map draws a stage. They are
// the same function's output and the same thresholds, which is the only
// reason they cannot disagree — so the thresholds are pinned here rather
// than left as two numbers that happen to match today.
//
// withAlpha is the other thing worth a test: it parses the catalogue's
// hex colours into canvas gradient stops, and a silent failure there
// does not throw, it just paints everything the same fallback grey.

import { buildStageName, BUILD_STAGES, withAlpha } from '../megastructureArt';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS } from '../../game/megastructures';

describe('build stages', () => {
  it('names every quarter of the build', () => {
    expect(buildStageName(0)).toBe('Keel laid');
    expect(buildStageName(0.24)).toBe('Keel laid');
    expect(buildStageName(0.25)).toBe('Frame');
    expect(buildStageName(0.49)).toBe('Frame');
    expect(buildStageName(0.5)).toBe('Plating');
    expect(buildStageName(0.74)).toBe('Plating');
    expect(buildStageName(0.75)).toBe('Fitting out');
    expect(buildStageName(1)).toBe('Fitting out');
  });

  it('a site with nothing delivered still reads as something', () => {
    // Not "" and not "Unknown". A framework with no freight in it has
    // had its keel laid, and saying so is what stops the panel looking
    // broken on the tick a site is placed.
    expect(buildStageName(0)).toBeTruthy();
  });

  it('the thresholds rise and start at zero', () => {
    expect(BUILD_STAGES[0].at).toBe(0);
    const ats = BUILD_STAGES.map(s => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it('survives nonsense rather than printing undefined', () => {
    for (const bad of [-1, 2, NaN]) {
      expect(typeof buildStageName(bad)).toBe('string');
      expect(buildStageName(bad).length).toBeGreaterThan(0);
    }
  });
});

describe('withAlpha', () => {
  it('turns a catalogue colour into a gradient stop', () => {
    expect(withAlpha('#7fd4ff', 0.5)).toBe('rgba(127, 212, 255, 0.5)');
  });

  it('accepts the form the catalogue actually stores', () => {
    // Every structure colour must parse. A miss does not throw — it
    // silently paints the fallback grey, so every sprite in the game
    // would quietly lose its identity and nothing would fail.
    for (const kind of MEGASTRUCTURE_KINDS) {
      const out = withAlpha(MEGASTRUCTURES[kind].color, 1);
      expect({ kind, fellBack: out.startsWith('rgba(160, 190, 210') })
        .toEqual({ kind, fellBack: false });
    }
  });

  it('falls back rather than emitting invalid CSS', () => {
    // An unparseable colour must still produce something canvas accepts,
    // because addColorStop throws on a bad string and would take the
    // whole frame down with it.
    for (const bad of ['', 'red', '#fff', 'nonsense']) {
      expect(withAlpha(bad, 0.4)).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
    }
  });
});
