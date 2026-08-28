// "All of neptune turned into a gate!?"
//
// A discovered stargate stands up two REAL gate bodies -- one in orbit
// of the world that hid it, one in close solar orbit. The older model
// redrew the HOST BODY as the gate ("drawn INSTEAD of the host body's
// disc... deliberately drawn LARGER than the host"), from when the
// portal WAS the body rather than a pair of doors. Both survived, so a
// discovery on Neptune turned the ice giant itself into a giant ring
// AND parked a "Neptune Gate" next to it.
//
// A host with a real gate child is an ordinary world again.

import { isRevealedWarpGate } from '../mapRenderer';
import { Body } from '../../types';

const mkBody = (o: Partial<Body> & { id: string }): Body => ({
  name: o.id,
  type: 'ice-giant',
  radius: 24,
  orbitRadius: 3000,
  ...o,
} as unknown as Body);

describe('isRevealedWarpGate', () => {
  it('claims a revealed portal host with no gate body (legacy games)', () => {
    const neptune = mkBody({
      id: 'neptune',
      secret: { kind: 'portal_to_sun', revealed: true },
    } as never);
    expect(isRevealedWarpGate(neptune)).toBe(true);
  });

  it('leaves the host alone once a real gate orbits it', () => {
    const neptune = mkBody({
      id: 'neptune',
      secret: { kind: 'portal_to_sun', revealed: true, supersededByGate: true },
    } as never);
    expect(isRevealedWarpGate(neptune)).toBe(false);
  });

  it('ignores an unrevealed secret', () => {
    const neptune = mkBody({
      id: 'neptune',
      secret: { kind: 'portal_to_sun' },
    } as never);
    expect(isRevealedWarpGate(neptune)).toBe(false);
  });

  it('ignores a body with no secret at all', () => {
    expect(isRevealedWarpGate(mkBody({ id: 'proteus' }))).toBe(false);
  });

  it('does not claim a non-gate secret', () => {
    const b = mkBody({
      id: 'iapetus',
      secret: { kind: 'ancient_city', revealed: true },
    } as never);
    expect(isRevealedWarpGate(b)).toBe(false);
  });
});
