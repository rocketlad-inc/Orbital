// THE ART VERSION MUST MATCH THE ART.
//
// World art is cached on devices for a year (public/_headers, public/sw.js)
// under URLs carrying ART_VERSION. If the art changes and the version does
// not, every returning player keeps the old maps forever. So the version is
// a fingerprint of the files, and this recomputes it.

import fs from 'fs';
import path from 'path';
import { ART_VERSION, WEAR_ART_VERSION, artUrl } from '../artVersion';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { artHash, wearArtHash, ART_DIRS } = require('../../../scripts/art-hash');

const root = path.resolve(__dirname, '../../..');

describe('world art caching', () => {
  it('ART_VERSION is the fingerprint of the art on disk (run npm run art:version)', () => {
    expect(ART_VERSION).toBe(artHash(path.join(root, 'public')));
  });

  it('WEAR_ART_VERSION is the fingerprint of the watch art sources (run npm run art:version)', () => {
    expect(WEAR_ART_VERSION).toBe(wearArtHash(root));
  });

  it('every art URL in the client goes through artUrl', () => {
    // A bare '/globes/...' would be cached for a year with no version to
    // move it on: the stale-forever case this whole scheme exists to stop.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n);
        if (fs.statSync(f).isDirectory()) { if (n !== '__tests__') walk(f); } else if (/\.(ts|tsx)$/.test(n)) files.push(f);
      }
    };
    walk(path.join(root, 'src'));
    const bare = new RegExp(`['\`](/(${ART_DIRS.join('|')})/)`);
    const offenders = files.filter(f => !f.endsWith(`${path.sep}artVersion.ts`)).filter(f => {
      const s = fs.readFileSync(f, 'utf8');
      return s.split('\n').some(line => bare.test(line) && !/artUrl\(/.test(line));
    }).map(f => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('the art folders are cached long-term and the worker keeps them', () => {
    const headers = fs.readFileSync(path.join(root, 'public', '_headers'), 'utf8');
    const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
    for (const d of ART_DIRS) {
      expect(headers).toMatch(new RegExp(`/${d}/\\*\\s*\\n\\s*Cache-Control: public, max-age=31536000, immutable`));
      expect(sw).toMatch(new RegExp(`/${d}/`));
    }
    expect(artUrl('/globes/mars.webp')).toBe(`/globes/mars.webp?v=${ART_VERSION}`);
  });
});
