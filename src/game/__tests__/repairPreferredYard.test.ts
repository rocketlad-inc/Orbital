import { preferredYardBodyId } from '../repair';
import type { Ship, Settlement, Body } from '../../types';

/**
 * The REPAIR button and the fleet panel's bulk repair send a hull to the
 * same port the auto-retreat would: chosen -> home -> nearest, restricted
 * to yards because a plain station does not heal (migration 0126).
 * Geometry-free cases only; the nearest fallback is covered by the
 * existing nearestShipyardBodyId behaviour.
 */
const station = (bodyId: string, ownedBy = 'player', yard = true): Settlement => ({
  id: `st_${bodyId}`, bodyId, ownedBy, type: 'station', hp: 100,
  buildings: yard ? { shipyard: 1 } : {},
} as unknown as Settlement);

const hull = (at: string, extra: Partial<Ship> = {}): Ship => ({
  id: 'h1', ownedBy: 'player', orbit: { parentBodyId: at }, ...extra,
} as unknown as Ship);

const bodies = [] as Body[];   // never consulted on the chosen/home paths

describe('preferredYardBodyId — chosen, then home, then nearest, yards only', () => {
  it('sends a hull to its chosen port when that port has a yard', () => {
    const s = [station('earth'), station('phobos')];
    expect(preferredYardBodyId(hull('mars', { homeBodyId: 'earth', retreatBodyId: 'phobos' }), s, bodies, 0))
      .toBe('phobos');
  });

  it('falls through to home when the chosen port has no yard', () => {
    const s = [station('earth'), station('phobos', 'player', false)];
    expect(preferredYardBodyId(hull('mars', { homeBodyId: 'earth', retreatBodyId: 'phobos' }), s, bodies, 0))
      .toBe('earth');
  });

  it('uses home when nothing is chosen', () => {
    const s = [station('earth'), station('phobos')];
    expect(preferredYardBodyId(hull('mars', { homeBodyId: 'earth' }), s, bodies, 0)).toBe('earth');
  });

  it('ignores a home or chosen port held by somebody else', () => {
    const s = [station('earth', 'rival'), station('phobos', 'rival')];
    // No yard of ours anywhere: nearest has nothing to offer either.
    expect(preferredYardBodyId(hull('mars', { homeBodyId: 'earth', retreatBodyId: 'phobos' }), s, bodies, 0))
      .toBeNull();
  });

  it('returns null when the hull is already sitting at the port it would go to', () => {
    const s = [station('earth')];
    expect(preferredYardBodyId(hull('earth', { homeBodyId: 'earth' }), s, bodies, 0)).toBeNull();
  });
});
