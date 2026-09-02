// WHERE A BODY APPEARS IN A GROUPED LIST.
//
// The route composer's Add Stop picker grouped candidates by what they
// ORBIT, which looks equivalent to grouping by system and is not.
// Neptune's moons have parent Neptune and grouped under NEPTUNE
// correctly; Neptune itself has parent Sol, so the planet turned up in a
// second SOL group beside Quaoar — demoted to a satellite entry in its
// own system. Reported as "Neptune shows up twice in spirit", which is
// exactly the confusion: one name, two places, at 1am, mid-route.
//
// This pins the RULE rather than the picker's markup: the system root of
// a planet with moons is itself.

import { makeSystemRootOf, systemLabel } from '../systemGrouping';
import type { Body } from '../../types';

const body = (id: string, name: string, parent: string | null, orbitRadius: number): Body => ({
  id, name, parent: parent ?? undefined, orbitRadius,
  radius: 4, type: parent === 'sol' || parent === null ? 'terrestrial' : 'moon',
} as unknown as Body);

// Neptune and its three moons, plus a Kuiper neighbour that shares its
// parent — the exact shape of the report.
const BODIES: Body[] = [
  body('sol', 'Sol', null, 0),
  body('neptune', 'Neptune', 'sol', 12000),
  body('proteus', 'Proteus', 'neptune', 224),
  body('triton', 'Triton', 'neptune', 360),
  body('nereid', 'Nereid', 'neptune', 900),
  body('quaoar', 'Quaoar', 'sol', 17000),
];

describe('stop picker grouping', () => {
  const rootOf = makeSystemRootOf(BODIES);

  it('a planet with moons anchors its own system', () => {
    expect(rootOf('neptune')).toBe('neptune');
  });

  it('its moons land in that same group', () => {
    for (const m of ['proteus', 'triton', 'nereid']) expect(rootOf(m)).toBe('neptune');
  });

  it('Neptune is never filed under the group its neighbour is in', () => {
    // The bug in one line: same key for Neptune and Quaoar meant the
    // planet was listed as a peer of a Kuiper object.
    expect(rootOf('neptune')).not.toBe(rootOf('quaoar'));
  });

  it('the group is named for the system, not the star', () => {
    expect(systemLabel(BODIES, rootOf('triton'))).toBe('Neptune System');
  });

  it('a moonless star-orbiter still groups somewhere sane', () => {
    // Quaoar has no satellites, so it roots to itself and is named
    // plainly — no "System" suffix for a body that is not one.
    expect(systemLabel(BODIES, rootOf('quaoar'))).toBe('Quaoar');
  });
});
