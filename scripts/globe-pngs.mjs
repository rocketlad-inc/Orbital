// PNG copies of the globes for the watch, made at build time.
//
// The watch's planet sprites are drawn on the server (worker/planetSprite.js)
// with resvg, and resvg-wasm cannot read WebP: handed a WebP globe it draws
// nothing at all (tested, 2026-10-01). So every build writes a 256 px PNG
// of each public/globes/*.webp into public/globes-png/, which ships with the
// static assets for the server to read through its ASSETS binding. 256 px
// covers the watch's largest planet (192 px) with room; each is ~60 KB.
// A 48 px set goes in public/globes-png/s/ for the watch face's map, which
// draws every world at once and needs a few pixels of each, not 256.
//
// Generated, never committed (public/globes-png is git-ignored): the globes
// are the one source, so these cannot drift from them.
//   node scripts/globe-pngs.mjs   (runs as part of npm run build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public', 'globes');
const out = path.join(root, 'public', 'globes-png');
const SIZES = [[256, out], [48, path.join(out, 's')]];

for (const [, dir] of SIZES) fs.mkdirSync(dir, { recursive: true });
let made = 0, kept = 0;
for (const name of fs.readdirSync(src).filter(n => n.endsWith('.webp')).sort()) {
  const from = path.join(src, name);
  for (const [size, dir] of SIZES) {
    const to = path.join(dir, name.replace(/\.webp$/, '.png'));
    // Only redo what changed: a build should not re-encode 116 images.
    if (fs.existsSync(to) && fs.statSync(to).mtimeMs >= fs.statSync(from).mtimeMs) { kept++; continue; }
    await sharp(from).resize(size, size).png({ compressionLevel: 9 }).toFile(to);
    made++;
  }
}
console.log(`globe PNGs: ${made} made, ${kept} up to date -> public/globes-png`);
