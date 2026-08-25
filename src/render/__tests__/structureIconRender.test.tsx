// THE SPRITES HAVE TO ACTUALLY RENDER.
//
// The element-budget test reads the source; this one runs it. The map
// rasterises these through renderToStaticMarkup and hands the result to
// an Image as a data URL — so anything that throws, or emits empty
// markup, or forgets the faction colour, becomes a silently blank
// structure on the map rather than an error anybody sees.
//
// I could not check this in a browser (the preview pane would not
// composite), so it is checked here instead: same render path the cache
// uses, one assertion per sprite.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructureIcon, StructureScaffold, STRUCTURE_VARIANTS } from '../../components/StructureIcons';
import { MEGASTRUCTURE_KINDS } from '../../game/megastructures';

const FACTION = '#c94fd6';
const TRIM = '#ffd166';

function markupFor(kind: string, variant: string): string {
  return renderToStaticMarkup(
    React.createElement(StructureIcon, {
      kind: kind as never, variant: variant as never,
      color: FACTION, color2: TRIM, size: 64,
    }),
  );
}

describe('every structure sprite renders', () => {
  const cases = MEGASTRUCTURE_KINDS.flatMap(
    k => STRUCTURE_VARIANTS.map(v => [k, v] as const),
  );

  it.each(cases)('%s / %s produces real svg', (kind, variant) => {
    const svg = markupFor(kind, variant);
    expect(svg.startsWith('<svg')).toBe(true);
    // Not an empty frame: a sprite with no geometry is a blank on the map.
    expect(svg).toMatch(/<(path|circle)\b/);
    expect(svg.length).toBeGreaterThan(200);
  });

  it.each(cases)('%s / %s wears the faction colour', (kind, variant) => {
    // Ownership is the first thing a silhouette should say, and it is
    // what the old catalogue-grey art never said.
    expect(markupFor(kind, variant).toLowerCase()).toContain(FACTION.toLowerCase());
  });

  it('the three variants of a kind are genuinely different art', () => {
    // A registry that points two letters at the same component would
    // give the player a choice that changes nothing.
    for (const kind of MEGASTRUCTURE_KINDS) {
      const [a, b, c] = STRUCTURE_VARIANTS.map(v => markupFor(kind, v));
      expect(a).not.toEqual(b);
      expect(b).not.toEqual(c);
      expect(a).not.toEqual(c);
    }
  });

  it('an unknown variant falls back rather than blanking', () => {
    // A save from a newer build, or a hand-edited row.
    const svg = markupFor('warp_gate', 'Z');
    expect(svg).toMatch(/<(path|circle)\b/);
  });
});

// ---------------------------------------------------------------------
// THE SILHOUETTE STILL HAS TO BE THE THING.
//
// The first pass matched the ships' STYLE and lost some of the subjects
// on the way: a gate became a pair of crescents, the sink became a
// pincer, the array grew a variant with no dish. Style is the easy half.
// A sprite that is beautifully consistent and no longer depicts what it
// names is worse than the busy art it replaced.
//
// These pin the identity of each family against its ORIGINAL art, which
// is where the intent is written down:
//   warp gate       a big ring you fly through, aperture open
//   weapons station a fort with barrels pointing out
//   gravity sink    rings marching inward, holding a hole open
//   deep array      a dish. THIS is the radar dish.
//   null field      pylons caging a core — NOT a dish
describe('every silhouette still depicts its subject', () => {
  const each = (kind: string) =>
    STRUCTURE_VARIANTS.map(v => markupFor(kind, v));

  /** Radii of real <circle> elements. Deliberately NOT a bare /r="/
   *  match: IconFrame injects a radialGradient with r="0.5" for the
   *  engine glow, and picking that up made a perfectly good ring look
   *  like it had a half-pixel aperture. */
  function circleRadii(svg: string): number[] {
    // The engine glow is excluded: IconFrame bakes a small
    // gradient-filled circle at the stern of everything it draws, and
    // counting it made a perfectly good ring look like it had a
    // four-pixel aperture. (It is also, strictly, a thruster on a
    // station with no engines — faint enough to live with, and the
    // price of sharing one frame with the ships.)
    return [...svg.matchAll(/<circle[^>]*?r="([\d.]+)"[^>]*>/g)]
      .filter(m => !m[0].includes('fill="url('))
      .map(m => Number(m[1]));
  }

  /** Every numeric coordinate in the drawing commands. */
  function coords(svg: string): number[] {
    return [...svg.matchAll(/[-\d.]+/g)].map(Number).filter(n => Number.isFinite(n));
  }

  it('every warp gate is a ring with an open aperture', () => {
    for (const svg of each('warp_gate')) {
      // A ring reads as a big outer boundary with a clear hole. Both a
      // large radius and a smaller inner one, or an outer polygon plus
      // an inner circle.
      const rs = circleRadii(svg);
      expect(rs.length).toBeGreaterThanOrEqual(1);
      // The aperture is never filled in by a centre dot: the smallest
      // circle in a gate is still something you could fly through.
      expect(Math.min(...rs)).toBeGreaterThanOrEqual(5);
    }
  });

  it('every weapons station points barrels outward', () => {
    for (const svg of each('weapons_station')) {
      // A barrel is geometry that reaches the very edge of the 32x32
      // box. A fort with nothing past its own hull reads as a crate.
      // Checked on COORDINATES rather than a path-command regex: the
      // first version only matched an X, so a station whose barrels all
      // ran vertically looked barrel-less.
      const cs = coords(svg.slice(svg.indexOf('</defs>')));
      expect(cs.some(n => n <= 2 || n >= 30)).toBe(true);
    }
  });

  it('every gravity sink is concentric', () => {
    for (const svg of each('gravity_sink')) {
      // Rings marching in: at least two circles sharing the centre.
      const centred = [...svg.matchAll(/cx="16" cy="16"/g)].length;
      expect(centred).toBeGreaterThanOrEqual(2);
    }
  });

  it('every deep array has a dish', () => {
    for (const svg of each('deep_array')) {
      // A dish is an arc — the one shape a bowl cannot be drawn without.
      expect(svg).toMatch(/[Aa] ?\d/);
    }
  });

  it('no null field is a dish — it is a cage around a core', () => {
    for (const svg of each('null_field')) {
      // The Array listens and looks like it; the Null Field is an
      // emitter. Mixing them up is the easiest mistake here, and the
      // one Lorne flagged.
      expect(svg).not.toMatch(/[Aa] ?1[0-9]/);
      // A caged core: something centred, and pylons around it.
      expect(svg).toMatch(/cx="16" cy="16"/);
    }
  });

  it('the scaffold grows through its stages and never vanishes', () => {
    const seen = new Set<string>();
    for (let stage = 0; stage <= 3; stage++) {
      const svg = renderToStaticMarkup(
        React.createElement(StructureScaffold, {
          stage, color: FACTION, color2: TRIM, size: 64,
        }),
      );
      expect(svg).toMatch(/<path/);
      seen.add(svg);
    }
    // Four genuinely different frames — a stage that draws the same as
    // the one before it tells the player nothing happened.
    expect(seen.size).toBe(4);
  });
});
