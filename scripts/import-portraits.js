#!/usr/bin/env node
// ============================================================
// Captain portrait importer
// ------------------------------------------------------------
// Turns a folder of portrait images into the web-ready set
// CaptainAvatar renders, and prints the AVATAR_IDS to paste into
// src/game/captains.ts.
//
// ASSET-AGNOSTIC ON PURPOSE. The art that prompted this (a Pillars of
// Eternity rip) is both copyrighted and the wrong genre, so the durable
// thing here is the pipeline, not the pictures. Point it at any folder
// of portraits and re-run.
//
//   node scripts/import-portraits.js <srcDir> [count]
//
// Sizing: CaptainAvatar is rendered at 14-44px, so 128px covers the
// largest use at DPR 3 with headroom and nothing more. WebP because
// these are photographic-ish busts where it beats PNG several times
// over, and this game already has a mobile performance problem that
// does not need a megabyte of faces added to it.
//
// Crop: source portraits are typically tall (210x330 here). A square
// taken from the TOP captures head-and-shoulders; centring it would cut
// the face in half and frame the chest.
// ============================================================

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = process.argv[2];
const COUNT = Number(process.argv[3] ?? 48);
const OUT = path.join(__dirname, '..', 'public', 'portraits');
const PX = 128;
const QUALITY = 80;

if (!SRC || !fs.existsSync(SRC)) {
  console.error('usage: node scripts/import-portraits.js <srcDir> [count]');
  process.exit(1);
}

const all = fs.readdirSync(SRC)
  .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
  .sort();
if (all.length === 0) { console.error('no images in ' + SRC); process.exit(1); }

// Even spread rather than the first N, so an alphabetical source does not
// hand back fifty variations of the same face.
const step = Math.max(1, Math.floor(all.length / COUNT));
const picked = [];
for (let i = 0; i < all.length && picked.length < COUNT; i += step) picked.push(all[i]);

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const ids = [];
  for (let i = 0; i < picked.length; i++) {
    const id = `p${i + 1}`;
    const src = path.join(SRC, picked[i]);
    const meta = await sharp(src).metadata();
    const side = Math.min(meta.width, meta.height);
    await sharp(src)
      .extract({
        left: Math.max(0, Math.round((meta.width - side) / 2)),
        top: Math.round(meta.height * 0.03),   // head-and-shoulders, not chest
        width: side,
        height: Math.min(side, meta.height - Math.round(meta.height * 0.03)),
      })
      .resize(PX, PX, { fit: 'cover' })
      .webp({ quality: QUALITY })
      .toFile(path.join(OUT, `${id}.webp`));
    ids.push(id);
  }

  const bytes = ids.reduce((n, id) => n + fs.statSync(path.join(OUT, `${id}.webp`)).size, 0);
  console.log(`wrote ${ids.length} portraits to public/portraits (${Math.round(bytes / 1024)}KB total, `
    + `${Math.round(bytes / ids.length / 1024 * 10) / 10}KB each)`);
  console.log('\nAVATAR_IDS for src/game/captains.ts:\n');
  console.log(`export const AVATAR_IDS = [${ids.map(i => `'${i}'`).join(',')}] as const;`);
})().catch(e => { console.error(e); process.exit(1); });
