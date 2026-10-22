// A WHOLE BATTLE FIRES, NOT ITS TWO LEADS.
//
// Hulls in flight are drawn in screen-px formation and company slots, so
// two loose groups fighting side by side sit hundreds of px apart on
// screen. The reach test used those drawn spots: only the pair drawn
// closest passed, and in the Mega Destroyer take only the leads fired.
// Reach is a world rule, measured where the hulls truly are.

import { transitShotInReach } from '../combatFx';
import { SHIP_RANGE } from '../../game/firingWindows';
import type { RenderContext } from '../mapRenderer';
import type { Ship } from '../../types';

const rc = { bodies: [], t: 10, camera: { x: 0, y: 0, scale: 1.1 } } as unknown as RenderContext;
const flying = (id: string, x: number, y: number, cls = 'destroyer') =>
  ({ id, class: cls, transit: { pos: { x, y }, currentTransfer: {} } } as unknown as Ship);

describe('transit fire reach', () => {
  const reach = SHIP_RANGE.destroyer;

  it('hulls truly within reach fire, however far apart they are drawn', () => {
    expect(transitShotInReach(flying('a', 0, 0), flying('b', reach * 0.8, 0), rc)).toBe(true);
  });

  it('hulls truly out of reach never fire', () => {
    expect(transitShotInReach(flying('a', 0, 0), flying('b', reach * 3, 0), rc)).toBe(false);
  });

  it('an unarmed class never fires', () => {
    expect(transitShotInReach(flying('a', 0, 0, 'freighter'), flying('b', 1, 0), rc)).toBe(false);
  });
});
