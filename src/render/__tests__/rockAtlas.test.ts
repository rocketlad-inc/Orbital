// THE ROCK ART MUST MATCH THE LAYOUT THE MAP CUTS IT BY.
//
// A meteoroid tumbles by cutting frames out of a baked atlas
// (public/rocks/{metal,gold}-N.webp). The map only knows the atlas by its
// numbers: how many looks, frames, columns and pixels a frame. Regenerate
// the art at another size and forget the constant, and every rock is
// drawn from the wrong corner of the sheet: a sliver of one frame and a
// sliver of the next, spinning. Nothing errors; it just looks broken.

import fs from 'fs';
import path from 'path';
import { ROCK_ATLAS } from '../mapRenderer';

const rocks = path.resolve(__dirname, '../../../public/rocks');

/** Canvas size of an extended-format WebP (the only kind that carries
 *  alpha, which the rocks need). */
function webpSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  expect(b.toString('ascii', 12, 16)).toBe('VP8X');
  const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
  const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
  return { w, h };
}

describe('tumbling rock atlases', () => {
  const rows = Math.ceil(ROCK_ATLAS.frames / ROCK_ATLAS.cols);
  for (const kind of ['metal', 'gold']) {
    for (let look = 0; look < ROCK_ATLAS.looks; look++) {
      it(`${kind}-${look} is ${ROCK_ATLAS.cols}x${rows} frames of ${ROCK_ATLAS.frame}px`, () => {
        const { w, h } = webpSize(path.join(rocks, `${kind}-${look}.webp`));
        expect(w).toBe(ROCK_ATLAS.cols * ROCK_ATLAS.frame);
        expect(h).toBe(rows * ROCK_ATLAS.frame);
      });
    }
  }
});
