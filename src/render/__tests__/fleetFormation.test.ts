import { fleetFormationGroups, FLEET_ARC_WIDTH } from '../fleetFormation';

const ship = (id: string, fleetId?: string | null) => ({ id, fleetId });

describe('fleetFormationGroups', () => {
  it('groups hulls that share a fleet', () => {
    const g = fleetFormationGroups([
      ship('s1', 'f1'), ship('s2', 'f1'), ship('s3', 'f1'),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].members).toEqual(['s1', 's2', 's3']);
  });

  it('ignores unfleeted hulls entirely', () => {
    const g = fleetFormationGroups([
      ship('s1', 'f1'), ship('s2', 'f1'), ship('loner', null), ship('other'),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].members).not.toContain('loner');
    expect(g[0].members).not.toContain('other');
  });

  it('a fleet with one hull PRESENT is not a formation', () => {
    // The rest of the squadron is somewhere else. One ship in a line is
    // a ship; it keeps its real orbital position instead of being
    // teleported onto a formation bearing on its own.
    const g = fleetFormationGroups([ship('s1', 'f1'), ship('s2', 'f2')]);
    expect(g).toHaveLength(0);
  });

  it('holds the same bearing regardless of member order or losses', () => {
    const a = fleetFormationGroups([ship('s1', 'f1'), ship('s2', 'f1'), ship('s3', 'f1')]);
    const b = fleetFormationGroups([ship('s3', 'f1'), ship('s1', 'f1'), ship('s2', 'f1')]);
    expect(b[0].arcCenter).toBe(a[0].arcCenter);
    // A hull dies — the survivors must not swing across the planet.
    const c = fleetFormationGroups([ship('s1', 'f1'), ship('s2', 'f1')]);
    expect(c[0].arcCenter).toBe(a[0].arcCenter);
    // ...and their slots keep their order.
    expect(c[0].members).toEqual(['s1', 's2']);
  });

  it('bearings stay inside one turn', () => {
    for (const id of ['f1', 'fleet:abc', 'x', 'ZZZZZZZZ', '9QpVOPOcVnJz:flt1']) {
      const g = fleetFormationGroups([ship('a', id), ship('b', id)]);
      expect(g[0].arcCenter).toBeGreaterThanOrEqual(0);
      expect(g[0].arcCenter).toBeLessThan(Math.PI * 2);
    }
  });

  it('two fleets at one body get a stable, distinct order', () => {
    const g = fleetFormationGroups([
      ship('b1', 'beta'), ship('b2', 'beta'), ship('a1', 'alpha'), ship('a2', 'alpha'),
    ]);
    expect(g.map(x => x.fleetId)).toEqual(['alpha', 'beta']);
  });

  it('a formation arc is tighter than a battle line', () => {
    // Guards the intent rather than the number: a formation reads as one
    // object, a battle line as a firing front (arcWidth up to 0.8).
    expect(FLEET_ARC_WIDTH).toBeLessThan(0.8);
  });
});
