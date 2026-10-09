import { gateRouteFor } from '../gateRoute';
import { MegastructureState } from '../megastructures';
import { Body } from '../../types';

// A Sol, a Centauri barycenter in orbit around it, the sun gate pair
// between them, and a player warp gate pair inside Sol.
const body = (id: string, parent: string | null, name = id): Body =>
  ({ id, name, parent } as unknown as Body);
const bodies = [
  body('sol', null, 'Sol'),
  body('earth', 'sol', 'Earth'),
  body('luna', 'earth', 'Luna'),
  body('bary', 'sol', 'Centauri Barycenter'),
  body('acen', 'bary', 'Alpha Centauri A'),
  body('proxb', 'acen', 'Proxima b'),
  body('sg', 'sol', 'Centauri Gate'),
  body('sgfar', 'bary', 'Sol Gate'),
  body('wa', 'sol', 'Gate A'),
  body('wb', 'sol', 'Gate B'),
];
const site = (bodyId: string, partner: string, transitFraction: number | null): MegastructureState =>
  ({ bodyId, kind: 'warp_gate', status: 'complete', partnerBodyId: partner, transitFraction } as unknown as MegastructureState);
const megas = {
  sg: site('sg', 'sgfar', 0.1),
  sgfar: site('sgfar', 'sg', 0.1),
  wa: site('wa', 'wb', null),
  wb: site('wb', 'wa', null),
};

describe('gateRouteFor (mirror of the server gate autopilot)', () => {
  it('a leg from a gate to its far end is the crossing, at the gate\'s own price', () => {
    expect(gateRouteFor(bodies, megas, 'sg', 'sgfar', 156)).toEqual(
      { gateName: 'Centauri Gate', crossing: true, etaTicks: 16 });
    expect(gateRouteFor(bodies, megas, 'wa', 'wb', 12)?.etaTicks).toBe(3);
  });

  it('Sol to a far world goes in at the Sol end; coming home, at the far end', () => {
    expect(gateRouteFor(bodies, megas, 'luna', 'proxb', 180)).toEqual(
      { gateName: 'Centauri Gate', crossing: false, etaTicks: null });
    expect(gateRouteFor(bodies, megas, 'proxb', 'earth', 180)?.gateName).toBe('Sol Gate');
  });

  it('leaves alone: legs inside one system, short legs, and hulls that do not fit', () => {
    expect(gateRouteFor(bodies, megas, 'earth', 'luna', 180)).toBeNull();
    expect(gateRouteFor(bodies, megas, 'acen', 'proxb', 180)).toBeNull();
    expect(gateRouteFor(bodies, megas, 'earth', 'proxb', 10)).toBeNull();
    expect(gateRouteFor(bodies, megas, 'sg', 'sgfar', 156, 'mega_destroyer')).toBeNull();
    expect(gateRouteFor(bodies, megas, 'luna', 'proxb', 180, 'kaiju')).toBeNull();
  });

  it('an unfinished or unwired gate does nothing', () => {
    const building = { ...megas, sg: { ...megas.sg, status: 'building' as const } };
    expect(gateRouteFor(bodies, building, 'sg', 'sgfar', 156)).toBeNull();
    expect(gateRouteFor(bodies, undefined, 'sg', 'sgfar', 156)).toBeNull();
  });
});
