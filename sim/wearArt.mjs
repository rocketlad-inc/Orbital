// ============================================================
// WEAR ART -- the watch's planets and flags, drawn by the real routes.
//
// The watch and the widgets draw what the server draws, so these run the
// actual handlers (planetSprite.handleWearPlanet, wearFlag.handleWearFlag)
// with a stand-in ASSETS binding that serves public/ from disk:
//   - every world with a globe in the game is drawn FROM that globe
//     (public/globes-png, made by scripts/globe-pngs.mjs at build);
//   - a world with no globe still draws, from the procedural painter;
//   - every emblem, the ten premium ones included, is a real picture;
//   - keys carry the art version, and old six-field keys still draw.
//
// Run: npm run sim:weararts
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WASM_BYTES = readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
const ROOT = process.cwd();

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const raster = await import('../worker/shipIconRaster.js');
raster.configureRasterizer(WASM_BYTES);
const planetSvg = await import('../worker/planetSvg.js');
const planetSprite = await import('../worker/planetSprite.js');
const wearFlag = await import('../worker/wearFlag.js');
const { WEAR_ART_VERSION } = await import('../src/render/artVersion.ts');
const { EMBLEM_IDS, PREMIUM_EMBLEM_IDS } = await import('../src/game/emblems.ts');

// public/ from disk, the way the Worker's ASSETS binding serves it.
let assetHits = 0;
const env = {
  ASSETS: {
    async fetch(req) {
      const p = path.join(ROOT, 'public', decodeURIComponent(new URL(req.url).pathname));
      if (!existsSync(p)) return new Response('not found', { status: 404 });
      assetHits++;
      return new Response(readFileSync(p), { headers: { 'content-type': 'image/png' } });
    },
  },
};
const req = new Request('https://orbital-empire.com/wear/planet/x/96.png');

/** Count opaque pixels in a PNG by decoding it with resvg (an SVG <image>). */
async function opaqueOf(res) {
  const { Resvg } = await import('@resvg/resvg-wasm');
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  const img = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><image href="data:image/png;base64,${b64}" width="96" height="96"/></svg>`).render();
  let n = 0;
  for (let i = 3; i < img.pixels.length; i += 4) if (img.pixels[i] > 200) n++;
  return n;
}

check('globe PNGs exist (scripts/globe-pngs.mjs ran)', existsSync(path.join(ROOT, 'public', 'globes-png', 'earth.png')));
await raster.rasterReady();

// ---- planets ----
const row = (id, type, extra = {}) => ({ id: `g:${id}`, type, color: '#7799bb', terraformed_at_tick: null, orbit_radius: 100, yield_metal: 2, ...extra });
const key = planetSvg.spriteKey(row('earth', 'terrestrial', { terraformed_at_tick: 3 }));
check('a sprite key carries the art version', key.endsWith(`~v${WEAR_ART_VERSION}`), key);
check('...and still parses', !!planetSvg.parseSpriteKey(key));
check('an old six-field key (cached by watches before) still parses',
  !!planetSvg.parseSpriteKey('mars~terrestrial~c1440e~0~0~0'));

for (const [id, type, tf] of [['earth', 'terrestrial', 1], ['mars', 'terrestrial', 0], ['luna', 'moon', 1], ['jupiter', 'gas-giant', 0], ['saturn', 'gas-giant', 0], ['phobos', 'moon', 0]]) {
  const k = planetSvg.spriteKey(row(id, type, { terraformed_at_tick: tf ? 3 : null }));
  const before = assetHits;
  const res = await planetSprite.handleWearPlanet(req, env, { params: { key: k, px: '96' } });
  const fromGlobe = assetHits > before;
  const opaque = res.ok ? await opaqueOf(res) : 0;
  // A ringed world's sprite is twice the disc across (planetSvg RING_PAD),
  // so its disc covers a quarter of the picture.
  const need = planetSvg.ringed(id) ? 1200 : 2500;
  check(`${id}${tf ? ' (terraformed)' : ''} is drawn from its globe`, res.ok && fromGlobe && opaque > need,
    `status ${res.status}, globe ${fromGlobe}, opaque ${opaque}`);
}
{
  const k = planetSvg.spriteKey(row('nowhere_rock', 'asteroid'));
  const before = assetHits;
  const res = await planetSprite.handleWearPlanet(req, env, { params: { key: k, px: '96' } });
  check('a world with no globe still draws, from the painter', res.ok && assetHits === before && await opaqueOf(res) > 1500,
    `status ${res.status}`);
}

// ---- flags ----
const all = [...EMBLEM_IDS, ...PREMIUM_EMBLEM_IDS];
let flagBad = [];
for (const id of all) {
  const res = await wearFlag.handleWearFlag(null, env, { params: { id, px: '64' } });
  const opaque = res.ok ? await opaqueOf(res) : 0;
  if (!res.ok || opaque < 150) flagBad.push(`${id}(${res.status},${opaque})`);
}
check(`all ${all.length} emblems draw as real pictures, the ${PREMIUM_EMBLEM_IDS.length} premium ones included`,
  flagBad.length === 0, flagBad.join(', '));
const nf = await wearFlag.handleWearFlag(null, env, { params: { id: 'no_such_emblem', px: '64' } });
check('an unknown emblem is a 404 (the watch draws its plain dot)', nf.status === 404);

console.log(bad ? `\n${bad} FAILED` : '\nALL WEAR ART CHECKS PASS');
process.exit(bad ? 1 : 0);
