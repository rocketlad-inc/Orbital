// ============================================================
// gen-app-icons — the Android/PWA icon set, rendered from the SAME
// artwork as the favicon.
//
//   node scripts/gen-app-icons.mjs
//
// WHY A SCRIPT AND NOT CHECKED-IN ART. The mark is an SVG (the orbit
// ring, Earth, and the moon riding the ring). Hand-exporting eight PNGs
// once means the day the mark changes, the launcher icon silently keeps
// the old one — the same two-copies-of-one-truth failure this codebase
// keeps getting bitten by. The PNGs ARE committed (the build must not
// need sharp, and CI must not need it either), but they are generated,
// and re-running this is how you update them.
//
// TWO SHAPES, because Android asks for two different things:
//
//   "any"      — the icon as drawn, rounded tile and all. Used by the
//                web app install prompt and older launchers.
//   "maskable" — Android crops the icon to whatever shape the launcher
//                uses (circle, squircle, teardrop). It guarantees only
//                the central 80% circle survives. So the art is drawn
//                full-bleed on the brand ground with the CONTENT scaled
//                into that safe zone. Ship the un-padded icon as
//                maskable and every round-icon launcher shaves the
//                orbit ring off.
// ============================================================

import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'icons');

/** The mark, parameterised by how much of the tile the art may use.
 *  `inset` 1 fills the tile; 0.72 pulls it into the maskable safe zone. */
function markSvg({ inset = 1, rounded = true, transparent = false } = {}) {
  // The art is authored in a 32x32 box; scale it about the centre.
  const s = inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512">
  <defs>
    <radialGradient id="sphere" cx="0.36" cy="0.32" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.40"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
    </radialGradient>
    <clipPath id="planet"><circle cx="16" cy="16" r="6"/></clipPath>
  </defs>
  ${transparent ? '' : `<rect width="32" height="32"${rounded ? ' rx="7"' : ''} fill="#0a0e14"/>`}
  <g transform="translate(16 16) scale(${s}) translate(-16 -16)">
    <g transform="rotate(-22 16 16)">
      <ellipse cx="16" cy="16" rx="13" ry="5.4" fill="none" stroke="#ffb84d" stroke-width="1.5"/>
    </g>
    <circle cx="16" cy="16" r="6" fill="#3a78c2"/>
    <g clip-path="url(#planet)">
      <ellipse cx="14" cy="14.5" rx="2.4" ry="1.8" fill="#3f8a4f"/>
      <ellipse cx="18.2" cy="18" rx="1.8" ry="1.5" fill="#3f8a4f"/>
    </g>
    <circle cx="16" cy="16" r="6" fill="url(#sphere)"/>
    <g transform="rotate(-22 16 16)"><circle cx="29" cy="16" r="2.1" fill="#ffd27f"/></g>
  </g>
</svg>`;
}

// density=512 renders the 32-unit viewBox crisply before downscaling.
const render = (svg, size) =>
  sharp(Buffer.from(svg), { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const TARGETS = [
  // [file, pixels, shape]
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['icon-maskable-192.png', 192, 'maskable'],
  ['icon-maskable-512.png', 512, 'maskable'],
  // Bubblewrap generates every launcher density from one source; 1024
  // gives it headroom.
  ['icon-1024.png', 1024, 'any'],
  ['icon-maskable-1024.png', 1024, 'maskable'],
  // THE PLAY LISTING ICON IS ITS OWN SHAPE, and neither of the other two
  // will do. Play rounds the store icon itself, so uploading the
  // already-rounded 'any' tile gets it rounded twice and the corners
  // come out chewed. The maskable tile is square but holds its art
  // inside the 80% circle every launcher might crop to, which on a store
  // card that crops nothing just reads as a small icon adrift in a black
  // square. So: square, opaque, art nearly full-bleed.
  ['icon-play-512.png', 512, 'play'],
];

const SHAPES = {
  any: { inset: 1, rounded: true },
  maskable: { inset: 0.72, rounded: false },
  play: { inset: 0.92, rounded: false },
};

mkdirSync(OUT, { recursive: true });
for (const [file, size, shape] of TARGETS) {
  writeFileSync(join(OUT, file), await render(markSvg(SHAPES[shape]), size));
  console.log(`wrote public/icons/${file} (${size}px, ${shape})`);
}

// ---- Android launcher icons ---------------------------------------
//
// The same artwork again, at the densities the platform asks for. TWO
// SETS, for the same reason the web needs two purposes:
//
//   ic_launcher             the square legacy icon, used below API 26.
//   ic_launcher_foreground  the ADAPTIVE foreground, which the launcher
//                           composites over a solid background and masks
//                           to whatever shape it likes. Android reserves
//                           the outer ring of the 108dp canvas for
//                           parallax and cropping, so the art is drawn
//                           small and TRANSPARENT — the launcher supplies
//                           both the shape and the ground.
const ANDROID_RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const DENSITIES = [['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]];

for (const [density, legacy, adaptive] of DENSITIES) {
  const dir = join(ANDROID_RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher.png'), await render(markSvg({ inset: 1, rounded: true }), legacy));
  writeFileSync(join(dir, 'ic_launcher_foreground.png'),
    await render(markSvg({ inset: 0.62, rounded: false, transparent: true }), adaptive));
  console.log(`wrote android mipmap-${density} (${legacy}px legacy, ${adaptive}px adaptive)`);
}
console.log('\nIcons written. They are committed — re-run this only when the mark changes.');
