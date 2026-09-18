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
function markSvg({ inset = 1, rounded = true } = {}) {
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
  <rect width="32" height="32"${rounded ? ' rx="7"' : ''} fill="#0a0e14"/>
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
  // [file, pixels, maskable?]
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
  // Bubblewrap generates every launcher density from one source, and the
  // Play listing wants a 512 square of its own. 1024 gives both headroom.
  ['icon-1024.png', 1024, false],
  ['icon-maskable-1024.png', 1024, true],
];

mkdirSync(OUT, { recursive: true });
for (const [file, size, maskable] of TARGETS) {
  const svg = markSvg(maskable ? { inset: 0.72, rounded: false } : { inset: 1, rounded: true });
  writeFileSync(join(OUT, file), await render(svg, size));
  console.log(`wrote public/icons/${file} (${size}px${maskable ? ', maskable' : ''})`);
}
console.log('\nIcons written. They are committed — re-run this only when the mark changes.');
