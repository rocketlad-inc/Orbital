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
import { StructureIcon, StructureScaffold, variantsFor } from '../../components/StructureIcons';
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
    k => variantsFor(k).map(v => [k, v] as const),
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
      const [a, b, c] = variantsFor(kind).map(v => markupFor(kind, v));
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
    variantsFor(kind).map(v => markupFor(kind, v));

  /**
   * The HULL path's geometry — the first drawn path after <defs>.
   *
   * These assertions used to look for <circle> elements, which was
   * right when the sprites were stroked outlines and wrong the moment
   * they became filled silhouettes. IconFrame FILLS the first child, so
   * a ring is now one path with an outer contour and an inner contour
   * and fillRule="evenodd" — there is no circle element to find, and a
   * test looking for one reported a perfectly good torus as "not a
   * ring".
   */
  function hull(svg: string): { d: string; evenOdd: boolean } {
    const after = svg.slice(svg.indexOf('</defs>'));
    const m = after.match(/<path([^>]*)d="([^"]+)"/);
    return { d: m ? m[2] : '', evenOdd: !!m && m[1].includes('evenodd') };
  }

  /** Subpaths in a `d` string — an M command starts each one. */
  const subpaths = (d: string) => (d.match(/M/g) ?? []).length;
  /** Arc commands, which is how a bowl differs from a ring. */
  const arcs = (d: string) => (d.match(/[Aa](?=[\s\d])/g) ?? []).length;

  it('every warp gate is a ring with a real hole through it', () => {
    for (const svg of each('warp_gate')) {
      const h = hull(svg);
      // A hole is a hole: evenodd, and two contours to punch it with.
      expect(h.evenOdd).toBe(true);
      expect(subpaths(h.d)).toBeGreaterThanOrEqual(2);
    }
  });

  it('every gravity sink is a collar with the well open through it', () => {
    for (const svg of each('gravity_sink')) {
      const h = hull(svg);
      expect(h.evenOdd).toBe(true);
      expect(subpaths(h.d)).toBeGreaterThanOrEqual(2);
    }
  });

  it('every weapons station points barrels outward', () => {
    for (const svg of each('weapons_station')) {
      // A barrel reaches the edge of the 32x32 box. Checked on
      // coordinates rather than path commands: an earlier version only
      // matched an X, so a station with vertical barrels looked unarmed.
      const cs = [...svg.slice(svg.indexOf('</defs>')).matchAll(/[-\d.]+/g)]
        .map(Number).filter(n => Number.isFinite(n));
      expect(cs.some(n => n <= 2 || n >= 30)).toBe(true);
    }
  });

  it('every deep array is a bowl, not a ring', () => {
    for (const svg of each('deep_array')) {
      const h = hull(svg);
      // A dish is ONE arc closed back across its chord. A ring takes
      // four (two per circle) and would fail here — which is the point:
      // it is the check that stops the Array turning into a torus.
      expect(arcs(h.d)).toBe(1);
      expect(h.evenOdd).toBe(false);
    }
  });

  it('no null field is a bowl — it is a cage around a core', () => {
    for (const svg of each('null_field')) {
      const h = hull(svg);
      // The Array listens and looks like it; the Null Field is an
      // emitter caging something you cannot see into. Mixing the two up
      // is the easy mistake here, so: never a single-arc bowl, and
      // always a core at the centre.
      expect(arcs(h.d)).not.toBe(1);
      expect(svg).toMatch(/<circle cx="16" cy="16"/);
    }
  });

  it('the mega destroyer keeps two Death Stars and adds other shapes', () => {
    // The first cut was three spheres, which was right about the fantasy
    // and wrong about variety: a picker where every option is a circle
    // is not a picker. Two stay round — including the one with the
    // superlaser — and the rest are silhouettes that say world-killer
    // without saying Death Star.
    const all = each('mega_destroyer');
    expect(all.length).toBeGreaterThanOrEqual(5);
    const round = all.filter(svg => /<circle cx="16" cy="16" r="1[0-9]"/.test(svg));
    expect(round.length).toBe(2);
    expect(all.length - round.length).toBeGreaterThanOrEqual(3);
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
