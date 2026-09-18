// ============================================================
// The Google Play feature graphic — 1024x500, the banner at the top of
// the store listing.
//
//   node scripts/gen-play-feature-graphic.mjs
//
// The wordmark is converted to VECTOR OUTLINES rather than set as SVG
// <text>. The brand face is Audiowide, a webfont the site pulls from
// Google Fonts; it is not installed on this machine, so <text> would
// silently fall back to whatever fontconfig had lying around and the
// only symptom would be a graphic that looks subtly wrong. Outlines
// cannot fall back.
//
// Play crops this asset on some surfaces, so nothing that matters goes
// near the edges: the wordmark starts at x=92 and the mark's furthest
// point stops short of the right edge.
//
// NOT part of the build, and opentype.js is deliberately NOT a project
// dependency — nothing that ships needs it. Install it when you want to
// regenerate:  npm i --no-save opentype.js
// The font is vendored beside this script (Audiowide, SIL OFL) so the
// output does not depend on what happens to be installed.
// ============================================================

import sharp from 'sharp';
import opentype from 'opentype.js';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const W = 1024, H = 500;
const font = opentype.parse(readFileSync(new URL('./assets/Audiowide-Regular.ttf', import.meta.url)).buffer);

/** Outlines for one run of text, plus its measured width so the caller
 *  can centre or right-align without guessing. */
function textPath(str, x, y, size, { letterSpacing = 0 } = {}) {
  const scale = size / font.unitsPerEm;
  let cursor = x;
  const parts = [];
  for (const ch of str) {
    const glyph = font.charToGlyph(ch);
    parts.push(glyph.getPath(cursor, y, size).toPathData(2));
    cursor += glyph.advanceWidth * scale + letterSpacing;
  }
  return { d: parts.join(' '), width: cursor - x - letterSpacing };
}

// ---- starfield -----------------------------------------------------
// Seeded, so re-running this produces the same graphic rather than a
// different one every time.
let seed = 20260918;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const MARK_X = 800, MARK_Y = 250;
let stars = '';
for (let i = 0; i < 260; i++) {
  const x = rnd() * W, y = rnd() * H;
  // Thin the field out inside the mark so the ring stays legible.
  const d = Math.hypot((x - MARK_X) / 1.6, y - MARK_Y);
  if (d < 130 && rnd() < 0.75) continue;
  const r = 0.4 + rnd() * rnd() * 1.5;
  const a = (0.25 + rnd() * 0.6).toFixed(2);
  stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#fff" opacity="${a}"/>`;
}

// ---- wordmark and taglines ----------------------------------------
const title = textPath('ORBITAL', 92, 208, 82, { letterSpacing: 5 });
const line1 = textPath('BURN BETWEEN WORLDS', 94, 274, 21, { letterSpacing: 2.4 });
const line2 = textPath('ONE HOUR IS ONE TURN', 94, 306, 21, { letterSpacing: 2.4 });
const line3 = textPath('REAL-TIME STRATEGY ACROSS THE SOL SYSTEM', 94, 352, 14, { letterSpacing: 1.8 });

// ---- the mark ------------------------------------------------------
// Same 32-unit artwork as the app icon, scaled up and placed right.
const S = 13.6;
const mark = `
  <g transform="translate(${MARK_X} ${MARK_Y}) scale(${S}) translate(-16 -16)">
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
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="sphere" cx="0.36" cy="0.32" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.40"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
    </radialGradient>
    <clipPath id="planet"><circle cx="16" cy="16" r="6"/></clipPath>
    <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070b11"/>
      <stop offset="0.55" stop-color="#0c1320"/>
      <stop offset="1" stop-color="#070a10"/>
    </linearGradient>
    <radialGradient id="coldglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#3a78c2" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#3a78c2" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="warmglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffb84d" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffb84d" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ffdca8"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#ground)"/>
  ${stars}
  <ellipse cx="${MARK_X}" cy="${MARK_Y}" rx="430" ry="380" fill="url(#coldglow)"/>
  <ellipse cx="978" cy="181" rx="190" ry="190" fill="url(#warmglow)"/>

  <!-- The rest of the system: outer orbits, implied not drawn in full. -->
  <g transform="rotate(-22 ${MARK_X} ${MARK_Y})" fill="none" stroke="#ffb84d" stroke-width="1.2">
    <ellipse cx="${MARK_X}" cy="${MARK_Y}" rx="268" ry="111" opacity="0.13"/>
    <ellipse cx="${MARK_X}" cy="${MARK_Y}" rx="352" ry="146" opacity="0.08"/>
  </g>

  ${mark}

  <path d="${title.d}" fill="url(#ink)"/>
  <rect x="94" y="234" width="164" height="3" fill="#ffb84d"/>
  <path d="${line1.d}" fill="#b9cddd"/>
  <path d="${line2.d}" fill="#b9cddd"/>
  <path d="${line3.d}" fill="#8ba2b6"/>
</svg>`;

console.log('wordmark width', title.width.toFixed(1), '| line3 width', line3.width.toFixed(1));

// librsvg measures the document at 72dpi, so a density of 96 quietly
// renders 1365x667 instead of the 1024x500 Play demands. Render at 4x
// and downsample: exact dimensions, and smoother glyph edges than a
// 1:1 rasterisation would give.
mkdirSync(join(ROOT, 'play'), { recursive: true });
await sharp(Buffer.from(svg), { density: 288 })
  .resize(W, H, { fit: 'fill' })
  .png({ compressionLevel: 9 })
  .toFile(join(ROOT, 'play', 'feature-graphic-1024x500.png'));
console.log('wrote play/feature-graphic-1024x500.png');
