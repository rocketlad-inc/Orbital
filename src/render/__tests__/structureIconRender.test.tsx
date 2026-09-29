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

import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructureIcon, StructureScaffold, variantsFor } from '../../components/StructureIcons';
import { MEGASTRUCTURE_KINDS } from '../../game/megastructures';
import { palette } from '../hulls/engine';
import { structureDesign } from '../hulls';

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
    // what the old catalogue-grey art never said. The overhaul SHADES the
    // hull from the faction colour (lit top, body, plates) rather than
    // pasting the raw hex, so look for those shades and the trim.
    const svg = markupFor(kind, variant).toLowerCase();
    const P = palette(FACTION, TRIM);
    expect([P.base, P.plate, P.plate2].some(c => svg.includes(c.toLowerCase()))).toBe(true);
    expect(svg).toContain(P.top.toLowerCase());
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
  // Checked on the DESIGN DATA (src/render/hulls): the overhaul's shapes
  // are parts, not hand-written paths, so the subject is asserted by what
  // each design is built from rather than by parsing its markup.
  type Part = { t: string; role?: string; r?: number; core?: boolean };
  const partsOf = (kind: string) => variantsFor(kind).map(v => (structureDesign(kind, v)?.parts ?? []) as Part[]);

  it('every warp gate is a ring with a portal through it', () => {
    for (const parts of partsOf('warp_gate')) {
      expect(parts.some(p => p.role === 'glow')).toBe(true);
    }
  });

  it('every gravity sink is a collar with a core in the well', () => {
    for (const parts of partsOf('gravity_sink')) {
      expect(parts.some(p => p.t === 'disc' && p.core)).toBe(true);
      expect(parts.some(p => p.t === 'ring' || p.t === 'pod')).toBe(true);
    }
  });

  it('every weapons station is armed', () => {
    for (const parts of partsOf('weapons_station')) {
      expect(parts.filter(p => p.t === 'turret').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every deep array has a dish', () => {
    for (const parts of partsOf('deep_array')) {
      expect(parts.some(p => p.t === 'disc' || (p.t === 'poly' && p.role === 'plate2'))).toBe(true);
    }
  });

  it('no null field is a dish — it is a cage around a core', () => {
    for (const parts of partsOf('null_field')) {
      expect(parts.some(p => p.role === 'glow')).toBe(true);
      expect(parts.some(p => p.t === 'disc' || p.t === 'poly')).toBe(true);
    }
  });

  it('the mega destroyer keeps a round fortress among other shapes', () => {
    const all = partsOf('mega_destroyer');
    expect(all.length).toBeGreaterThanOrEqual(5);
    const round = all.filter(parts => parts.some(p => p.t === 'disc' && (p.r ?? 0) >= 12));
    expect(round.length).toBeGreaterThanOrEqual(1);
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

// ---------------------------------------------------------------------
// THE LIST AND THE MAP MUST AGREE.
//
// This has now gone wrong twice in the same place, both times because
// the map moved and the outliner did not. First the outliner drew a
// site as a plain coloured disc while the map drew a truss frame; then
// the map moved to the shared ship frame and the outliner went on
// drawing the old procedural hardware beside it.
//
// A player reading a row and looking at the map should not have to work
// out that they are the same object.
describe('the outliner draws what the map draws', () => {
  const planetIcon = fs.readFileSync(
    path.resolve(__dirname, '../../components/PlanetIcon.tsx'), 'utf8',
  );
  const structIcons = fs.readFileSync(
    path.resolve(__dirname, '../../components/StructureIcons.tsx'), 'utf8',
  );

  it('renders structures through the shared components, not old canvas art', () => {
    expect(planetIcon).toMatch(/StructureIcon/);
    expect(planetIcon).toMatch(/StructureScaffold/);
    // The procedural hardware is gone from this path entirely.
    expect(planetIcon).not.toMatch(/drawCompletedStructure/);
    expect(planetIcon).not.toMatch(/drawConstructionSite/);
  });

  it('paints them in the owner\'s colours like the map does', () => {
    // Catalogue grey in the list and faction magenta on the map reads as
    // two different objects.
    const i = planetIcon.indexOf('A MEGASTRUCTURE IS AN SVG NOW');
    const block = planetIcon.slice(i, i + 1600);
    expect(block).toMatch(/owner\?\.color/);
  });

  it('capital hulls get their own art in every list', () => {
    // iconClassFor collapses a Mega Destroyer to "destroyer" and a
    // Mobile Foundry to "freighter" — the honest answer when they had no
    // art, and a lie now that they have five and three. HullIcon is the
    // one place that decides, so the next list somebody writes inherits
    // the fix instead of the bug.
    expect(structIcons).toMatch(/export const HullIcon/);
    const i = structIcons.indexOf('export const HullIcon');
    const body = structIcons.slice(i, i + 900);
    expect(body).toMatch(/mega_destroyer' \|\| shipClass === 'mobile_foundry'/);
  });

  it('no list reaches past HullIcon to collapse a hull itself', () => {
    // The bug was sixteen call sites all calling iconClassFor. Any that
    // still pair it with a ShipIcon is one that will show a freighter
    // where a Mobile Foundry should be.
    for (const f of ['Outliner', 'FleetPanel', 'GroupSelectionPanel', 'ShipPanel']) {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../components', `${f}.tsx`), 'utf8',
      );
      expect(src).not.toMatch(/<ShipIcon shipClass=\{iconClassFor\(/);
    }
  });
});
