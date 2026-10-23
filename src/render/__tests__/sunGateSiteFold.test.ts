// A landed sun gate is never folded into its own landing site
// (2026-10-23, the colony clip).
//
// A site is a point of empty space on the orbit the gate stops on
// (worker/sunGates.js), type 'lagrange' and orbiting the Sun, so the
// presentation classed it as a PLANET. A gate is a structure, ranked
// below every world. While both stood on the same spot -- the moment a
// gate lands, until the server retires the site, and for a whole Studio
// take where the site was never retired -- the sibling pass folded the
// gate into the site, and the map drew only the reticle and its label,
// "CENTAURI GATE LANDING SITE", under a ship that then crossed with no
// gate in sight.

import { computePresentation, type PresentBody } from '../bodyPresentation';

const SOL: PresentBody = { id: 'g:sol', type: 'star', radius: 50, parent: null };
const GATE: PresentBody = { id: 'g:sungate_centauri', type: 'megastructure', radius: 2.85, parent: 'g:sol', orbitRadius: 25000 };
const SITE: PresentBody = { id: 'g:sungate_centauri_site', type: 'lagrange', radius: 2.85, parent: 'g:sol', orbitRadius: 25000 };

const at: Record<string, { x: number; y: number }> = {
  'g:sol': { x: -50000, y: 0 },
  'g:sungate_centauri': { x: 500, y: 300 },
  'g:sungate_centauri_site': { x: 500, y: 300 },
};
const pos = (id: string) => at[id] ?? null;

describe('a landed sun gate and its landing site', () => {
  it('shows the gate, not the site, when they stand on one spot', () => {
    const p = computePresentation([SOL, GATE, SITE], 30, pos, null, { w: 1920, h: 1080 }, null, 100);
    expect(p.shown.get('g:sungate_centauri')).toBe(1);
    expect(p.shown.get('g:sungate_centauri_site') ?? 1).toBeLessThan(0.5);
    expect(p.host.get('g:sungate_centauri_site')).toBe('g:sungate_centauri');
  });

  it('leaves a site alone while its gate is still in flight', () => {
    // In flight the gate sits out the sibling pass (isInFlight): the site
    // is the one marker of where it will stop.
    const flying = { ...GATE, emerge: { untilTick: 200 } };
    const p = computePresentation([SOL, flying, SITE], 30, pos, null, { w: 1920, h: 1080 }, null, 100);
    expect(p.shown.get('g:sungate_centauri_site')).toBe(1);
    expect(p.shown.get('g:sungate_centauri')).toBe(1);
  });

  it('still lets a site fold a world-sized neighbour as before', () => {
    // Only the gate/site pair changes: a dwarf on the site's spot still
    // goes under the reticle, as it always did.
    const DWARF: PresentBody = { id: 'g:makemake', type: 'dwarf', radius: 1, parent: 'g:sol', orbitRadius: 25000 };
    const near: Record<string, { x: number; y: number }> = { ...at, 'g:makemake': { x: 503, y: 300 } };
    const p = computePresentation([SOL, SITE, DWARF], 30, (id) => near[id] ?? null, null, { w: 1920, h: 1080 }, null, 100);
    expect(p.shown.get('g:sungate_centauri_site')).toBe(1);
    expect(p.shown.get('g:makemake') ?? 1).toBeLessThan(0.5);
  });
});
