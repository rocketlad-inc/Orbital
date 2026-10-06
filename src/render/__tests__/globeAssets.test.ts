// ============================================================
// EVERY REGISTERED GLOBE HAS ITS FILES.
//
// A world listed in GLOBE_IDS loads three images (the still sprite, the
// spinning map and its double-resolution twin) and, unless it is in
// NO_TF_GLOBE, the same three again for its terraformed twin. A missing
// file is not an error anywhere: the image just never loads and the world
// quietly keeps its procedural face for good. That is exactly how the far
// systems looked before 2026-10-06, by design — this makes sure no world
// ever ends up that way by accident.
//
// Read as TEXT from the source, like the other mirror tests, so the
// registry under test is the one the renderer actually uses.
// ============================================================

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const src = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const idsIn = (block: string) => Array.from(block.matchAll(/'([a-z0-9_]+)'/g)).map(m => m[1]);

const planet = src('src/render/planetTexture.ts');
const globeIds = idsIn(planet.match(/const GLOBE_IDS = new Set\(\[([\s\S]*?)\]\);/)![1]);
const noTf = new Set(idsIn(planet.match(/const NO_TF_GLOBE = new Set\(\[([\s\S]*?)\]\);/)![1]));

const exists = (rel: string) => fs.existsSync(path.join(root, 'public', rel));

describe('globe art on disk', () => {
  it('parsed the registry', () => {
    expect(globeIds.length).toBeGreaterThan(50);
    expect(globeIds).toContain('earth');
  });

  it('every globe has its sprite, its map and its hi-res map', () => {
    const missing: string[] = [];
    for (const id of globeIds) {
      const keys = noTf.has(id) ? [id] : [id, `${id}_tf`];
      for (const k of keys) {
        for (const f of [`globes/${k}.webp`, `surfaces/${k}.webp`, `surfaces/hi/${k}.webp`]) {
          if (!exists(f)) missing.push(f);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('the far systems are drawn from real maps now, not procedural', () => {
    for (const id of ['verdant', 'thistle', 'sorrel', 'crimson', 'prismara', 'scoria', 'umber',
      'cinder', 'clinker', 'farspire', 'requiem', 'lacrimosa', 'sanctus', 'vellichor', 'elegy',
      'vesper', 'threnody', 'echelon', 'gilt', 'reliquary']) {
      expect(`${id}: ${globeIds.includes(id)}`).toBe(`${id}: true`);
    }
  });

  it('every star look names a photosphere that exists', () => {
    const renderer = src('src/render/mapRenderer.ts');
    const photos = Array.from(renderer.matchAll(/photo: '([a-z0-9_]+)'/g)).map(m => m[1]);
    expect(photos).toEqual(expect.arrayContaining(['sol', 'centauri_a', 'centauri_b', 'hde_226868']));
    expect(photos.filter(p => !exists(`globes/${p}.webp`))).toEqual([]);
  });
});
