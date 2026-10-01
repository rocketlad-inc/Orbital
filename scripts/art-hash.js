// Fingerprint of the world art (public/globes, surfaces, rings, rocks).
//
// The art keeps its file names when it is regenerated, so the version in
// its URLs (src/render/artVersion.ts) is what tells a device its cached
// copy is stale. This hash IS that version: any byte of any art file
// changes it. Shared by scripts/art-version.js (writes it) and
// src/render/__tests__/artVersion.test.ts (fails if it is out of date).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ART_DIRS = ['globes', 'surfaces', 'rings', 'rocks'];

function listFiles(dir, base) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function artHash(publicDir) {
  const h = crypto.createHash('sha1');
  for (const d of ART_DIRS) {
    for (const rel of listFiles(path.join(publicDir, d), publicDir)) {
      h.update(rel);
      h.update(fs.readFileSync(path.join(publicDir, rel)));
    }
  }
  return h.digest('hex').slice(0, 12);
}

module.exports = { artHash, ART_DIRS };
