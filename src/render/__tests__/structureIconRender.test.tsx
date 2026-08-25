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
import { StructureIcon, STRUCTURE_VARIANTS } from '../../components/StructureIcons';
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
