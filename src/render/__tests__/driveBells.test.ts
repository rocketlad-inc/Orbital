// A BURN LEAVES THE ENGINES THE HULL ACTUALLY HAS.
//
// The transit plume (fxPrimitives drawThrustExhaust) draws a torch from
// every drive() bell in the hull's design, mirrored as the renderer
// mirrors it. A ship class whose designs lost their drives would burn
// from nothing -- these keep every letter of every class supplied.

import { shipDesign, hasShipDesign, driveBellsOf } from '../hulls';
import { driveBellsFor } from '../shipIconCache';
import { DEFAULT_SHIP_ICONS } from '../../components/ShipIcons';

const CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony', 'mega_destroyer', 'mobile_foundry'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

describe('engine bells', () => {
  // These designs draw no drive() bells (the U frigate's warp nacelles
  // among them): they burn from the class's stern layout, as every hull
  // did before. A design that LOSES its bells shows up here.
  const NO_BELLS = ['frigate:U', 'freighter:U', 'colony:D', 'colony:V', 'mega_destroyer:C'];

  it('every other ship design has bells, inside its box', () => {
    const bad: string[] = [];
    const none: string[] = [];
    for (const cls of CLASSES) {
      for (const v of LETTERS) {
        if (!hasShipDesign(cls, v)) continue;
        const bells = driveBellsOf(shipDesign(cls, v)!);
        if (!bells.length) none.push(`${cls}:${v}`);
        if (bells.some(b => b.x < 0 || b.x > 64 || Math.abs(b.y) > 32 || b.r <= 0)) bad.push(`${cls}:${v}`);
      }
    }
    expect(bad).toEqual([]);
    expect(none).toEqual(NO_BELLS);
  });

  it('mirrors an off-centre bell and keeps a centreline one single', () => {
    const d = { name: 't', parts: [{ t: 'drive', x: 10, y: 6, r: 2 }, { t: 'drive', x: 12, y: 0, r: 3 }, { t: 'drive', x: 8, y: 4, r: 1, m: false }] };
    const bells = driveBellsOf(d);
    expect(bells).toEqual([
      { x: 10, y: -6, r: 2 }, { x: 10, y: 6, r: 2 }, { x: 12, y: -0, r: 3 }, { x: 8, y: 4, r: 1 },
    ]);
  });

  it('an unknown letter burns from the class default, like the icon it draws', () => {
    for (const cls of ['corvette', 'frigate', 'destroyer']) {
      expect(driveBellsFor(cls, 'Z')).toEqual(driveBellsFor(cls, DEFAULT_SHIP_ICONS[cls as keyof typeof DEFAULT_SHIP_ICONS]));
    }
    expect(driveBellsFor('warp_toaster', null)).toBeNull();
  });
});
