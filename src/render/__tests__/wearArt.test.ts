// THE WATCH AND WIDGETS DRAW WHAT THE GAME DRAWS.
//
// Their pictures are made on the server: ships from the hull designs
// (worker/shipIconRaster.js), flags and the Herald's emblems from art
// generated out of FactionEmblem.tsx (scripts/gen-emblem-art.tsx). Two
// ways that silently goes wrong, and these catch both:
//   - an emblem added to the game (free or premium) that nobody
//     regenerated for: it would draw as a plain dot on the watch, which
//     is exactly how the ten premium emblems shipped before;
//   - the server's default ship letter drifting from the game's, so an
//     unpicked hull looks different on the wrist than on the map.

import fs from 'fs';
import path from 'path';
import { EMBLEM_IDS, PREMIUM_EMBLEM_IDS } from '../../game/emblems';
import { DEFAULT_SHIP_ICONS } from '../../components/ShipIcons';

const worker = path.resolve(__dirname, '../../../worker');
const read = (f: string) => fs.readFileSync(path.join(worker, f), 'utf8');

describe('watch and widget art', () => {
  const all = [...EMBLEM_IDS, ...PREMIUM_EMBLEM_IDS];

  it('every emblem, premium included, has its SVG on the server (run scripts/gen-emblem-art.tsx)', () => {
    const src = read('generated/emblemSvgs.js');
    const missing = all.filter(id => !src.includes(`"${id}":"<svg`));
    expect(missing).toEqual([]);
  });

  it('every emblem, premium included, has its Herald mask', () => {
    const src = read('_emblemMasks.js');
    const missing = all.filter(id => !new RegExp(`^\\s+${id}: '[A-Za-z0-9+/=]+',`, 'm').test(src));
    expect(missing).toEqual([]);
  });

  it("the server's default ship letters are the game's", () => {
    const src = read('shipIconRaster.js');
    for (const [cls, v] of Object.entries(DEFAULT_SHIP_ICONS)) {
      expect(src).toMatch(new RegExp(`${cls}: '${v}'`));
    }
  });
});
