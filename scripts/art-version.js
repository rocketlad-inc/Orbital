// Re-stamp src/render/artVersion.ts after regenerating any world art.
//   node scripts/art-version.js   (or: npm run art:version)
// src/render/__tests__/artVersion.test.ts fails until this has been run.
const fs = require('fs');
const path = require('path');
const { artHash } = require('./art-hash');

const root = path.resolve(__dirname, '..');
const v = artHash(path.join(root, 'public'));
const out = path.join(root, 'src', 'render', 'artVersion.ts');
const src = fs.readFileSync(out, 'utf8').replace(/export const ART_VERSION = '[0-9a-f]*';/, `export const ART_VERSION = '${v}';`);
fs.writeFileSync(out, src);
console.log('ART_VERSION', v);
