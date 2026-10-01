// Re-stamp src/render/artVersion.ts after regenerating any world art.
//   node scripts/art-version.js   (or: npm run art:version)
// src/render/__tests__/artVersion.test.ts fails until this has been run.
const fs = require('fs');
const path = require('path');
const { artHash, wearArtHash } = require('./art-hash');

const root = path.resolve(__dirname, '..');
const v = artHash(path.join(root, 'public'));
const out = path.join(root, 'src', 'render', 'artVersion.ts');
const w = wearArtHash(root);
const src = fs.readFileSync(out, 'utf8')
  .replace(/export const ART_VERSION = '[0-9a-f]*';/, `export const ART_VERSION = '${v}';`)
  .replace(/export const WEAR_ART_VERSION = '[0-9a-f]*';/, `export const WEAR_ART_VERSION = '${w}';`);
fs.writeFileSync(out, src);
console.log('ART_VERSION', v, 'WEAR_ART_VERSION', w);
