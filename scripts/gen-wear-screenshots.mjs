// ============================================================
// The Wear OS store screenshots Play will not serve the watch app
// without.
//
//   node scripts/gen-wear-screenshots.mjs
//
// WHY THESE ARE GENERATED AND NOT CAPTURED. A captured screenshot needs
// a Wear emulator, the app installed on it, and a paired token planted
// in its prefs before any screen shows real data -- a pipeline worth
// building, but not before the app can reach a watch at all, which is
// what these unblock.
//
// SO THEY MUST MATCH THE REAL UI, and they are built to: the viewBox is
// 227dp square, which is a Wear screen at 2x density, so every size here
// is the literal sp/dp value from the Compose source beside it. The
// colours are the same constants Theme.kt carries, which are the widget
// card's, which are the game's.
//
// NOT part of the build. resvg and sharp are already dependencies, so
// this needs no install -- which matters here, because an npm install in
// this repo prunes the --no-save wrangler and takes deploys with it.
//
// Fonts come from the system rather than being vendored: the faces
// wanted are a plain sans and a monospace, which is what the watch
// actually renders (Compose's default and FontFamily.Monospace), and
// both exist on any machine this runs on.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const OUT = 'play/wear';
const SIZE = 1024;          // Play wants 384..3840 square for Wear.
const VB = 227;             // dp across a Wear screen at 2x density.

// ---- Theme.kt, to the byte --------------------------------------------
const INK = '#E2ECF5';
const DIM = '#7D92A6';
const ALARM = '#FF6A60';
const WARN = '#FFCA48';
const GOOD = '#7FFFA1';
const GROUND = '#080C13';
const TROUGH = '#16202C';
const METAL = '#B8C6D4';
const CREDIT = '#FFCA48';
const SCIENCE = '#6FD3FF';
const TEAL = '#4ECDC4';
const RIVAL = '#FF6A60';

const SANS = 'OrbitalSans';
const MONO = 'OrbitalMono';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, y, s, {
  fill = INK, size = 10, weight = 'normal', family = SANS, anchor = 'middle',
} = {}) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" `
    + `font-weight="${weight}" font-family="${family}" text-anchor="${anchor}">${esc(s)}</text>`;
}

const rect = (x, y, w, h, fill, r = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;

/** The round display. A Wear screenshot is a square frame with a round
 *  screen in it, and cropping the corners is what makes it read as a
 *  watch rather than a small phone. */
function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${SIZE}" height="${SIZE}">
  <rect width="${VB}" height="${VB}" fill="#000000"/>
  <clipPath id="screen"><circle cx="${VB / 2}" cy="${VB / 2}" r="${VB / 2}"/></clipPath>
  <g clip-path="url(#screen)">
    <rect width="${VB}" height="${VB}" fill="${GROUND}"/>
    ${inner}
  </g>
</svg>`;
}

/** TimeText: the Wear Scaffold draws the clock at the top of every
 *  screen, so every screenshot has one. */
const clock = text(VB / 2, 16, '10:09', { fill: INK, size: 9, family: MONO });

// ---- 1. Empire ---------------------------------------------------------
// EmpireScreen.kt: faction in its own colour, tick + countdown beneath,
// then three resource rows each carrying its per-tick rate.
function empire() {
  const rows = [
    ['METAL', '5.0K', '+40/T', METAL, GOOD],
    ['CREDITS', '2.4K', '+25/T', CREDIT, GOOD],
    ['SCIENCE', '900', '+12/T', SCIENCE, GOOD],
  ];
  let y = 92;
  const body = rows.map(([label, amount, rate, ink, rateInk]) => {
    const block = [
      text(30, y, label, { fill: DIM, size: 6.5, family: MONO, anchor: 'start' }),
      text(30, y + 15, amount, { fill: ink, size: 18, weight: 'bold', family: MONO, anchor: 'start' }),
      text(VB - 30, y + 10, rate, { fill: rateInk, size: 11, family: MONO, anchor: 'end' }),
    ].join('');
    y += 30;
    return block;
  }).join('');

  return frame([
    clock,
    text(VB / 2, 56, 'VERDAN CONCORD', { fill: TEAL, size: 13, weight: 'bold' }),
    text(VB / 2, 70, 'TICK 412 · NEXT IN 4M12S', { fill: DIM, size: 8.5, family: MONO }),
    body,
    text(VB / 2, 190, '2 FIGHTING', { fill: ALARM, size: 10, family: MONO }),
    text(VB / 2, 203, '1 TO VOTE', { fill: WARN, size: 10, family: MONO }),
  ].join(''));
}

// ---- 2. Situation ------------------------------------------------------
// BattlesScreen.kt: the damage-weighted bar first, then each side on its
// own livery rail with hull pips coloured by health -- and grey where
// sensors do not reach.
function situation() {
  const pips = (x, y, healths) => healths.map((h, i) => {
    const fill = h == null ? DIM : h >= 66 ? GOOD : h >= 33 ? WARN : ALARM;
    return rect(x + i * 5, y, 3, 3, fill, 1);
  }).join('');

  const battle = (y, body, kills, lost, mineDmg, rivalDmg, mineHp, rivalHp, known) => {
    const total = mineDmg + rivalDmg;
    const w = VB - 60;
    const mineW = (w * mineDmg) / total;
    return [
      text(30, y, body, { fill: INK, size: 11, weight: 'bold', family: MONO, anchor: 'start' }),
      text(VB - 30, y, `+${kills} −${lost}`, {
        fill: lost > kills ? ALARM : GOOD, size: 9, family: MONO, anchor: 'end',
      }),
      rect(30, y + 5, w, 4, TROUGH, 2),
      rect(30, y + 5, mineW, 4, TEAL, 2),
      rect(30 + mineW, y + 5, w - mineW, 4, RIVAL, 2),
      // side 1 — yours
      rect(30, y + 14, 2.5, 8, TEAL, 1.2),
      text(36, y + 21, 'YOU', { fill: INK, size: 8, family: MONO, anchor: 'start' }),
      pips(VB - 95, y + 16, mineHp),
      text(VB - 30, y + 21, String(mineHp.length), { fill: DIM, size: 8, family: MONO, anchor: 'end' }),
      // side 2 — theirs
      rect(30, y + 26, 2.5, 8, RIVAL, 1.2),
      text(36, y + 33, 'KEPLER REACH', { fill: DIM, size: 8, family: MONO, anchor: 'start' }),
      pips(VB - 95, y + 28, rivalHp),
      text(VB - 30, y + 33, String(rivalHp.length), { fill: DIM, size: 8, family: MONO, anchor: 'end' }),
      known ? '' : text(30, y + 42, 'NO SENSOR COVERAGE', {
        fill: DIM, size: 6.5, family: MONO, anchor: 'start',
      }),
    ].join('');
  };

  return frame([
    clock,
    text(VB / 2, 40, 'SITUATION', { fill: INK, size: 11, weight: 'bold', family: MONO }),
    battle(62, 'VESTA', 3, 1, 420, 260, [88, 71, 44], [95, 30], true),
    // The second fight is outside sensor range: the shape still draws,
    // the rival's condition does not. Grey is "unknown", never a shade
    // of hurt.
    battle(118, 'CERES', 0, 2, 140, 380, [22, 61], [null, null, null], false),
    // INSET FURTHER THAN THE ROWS ABOVE, because the screen is ROUND.
    // At y=196 the circle is only 156dp across, so a row on the same
    // 30dp margin as the ones at eye level loses its first and last
    // glyph -- which is what a real Wear layout inset would have
    // prevented and what a square mockup would never have shown.
    text(VB / 2, 178, 'INBOUND', { fill: WARN, size: 8.5, family: MONO }),
    text(44, 191, 'PALLAS', { fill: INK, size: 10, family: MONO, anchor: 'start' }),
    text(VB - 44, 191, '4 · IN 2T', { fill: WARN, size: 10, family: MONO, anchor: 'end' }),
  ].join(''));
}

// ---- 3. Senate ---------------------------------------------------------
// SenateScreen.kt: the bill, its clock, the tally by WEIGHT, and three
// buttons with the one you chose filled in.
function senate() {
  const card = (y, h) => rect(18, y, VB - 36, h, TROUGH, 12);
  const chip = (cx, y, label, tint, chosen) => [
    rect(cx - 21, y, 42, 16, chosen ? tint : GROUND, 8),
    text(cx, y + 11, label, {
      fill: chosen ? GROUND : tint, size: 8.5,
      weight: chosen ? 'bold' : 'normal', family: MONO,
    }),
  ].join('');

  return frame([
    clock,
    text(VB / 2, 38, 'SENATE', { fill: INK, size: 11, weight: 'bold', family: MONO }),
    card(50, 106),
    text(VB / 2, 66, 'CENSURE THE REACH', { fill: INK, size: 11, weight: 'bold' }),
    text(VB / 2, 80, 'Trade sanctions for three', { fill: DIM, size: 8.5 }),
    text(VB / 2, 90, 'ticks.', { fill: DIM, size: 8.5 }),
    text(VB / 2, 104, 'CLOSES IN 4T', { fill: WARN, size: 8, family: MONO }),
    rect(30, 112, VB - 60, 4, TROUGH, 2),
    rect(30, 112, (VB - 60) * 0.62, 4, GOOD, 2),
    rect(30 + (VB - 60) * 0.62, 112, (VB - 60) * 0.38, 4, ALARM, 2),
    text(VB / 2, 125, '8 / 5', { fill: DIM, size: 8, family: MONO }),
    chip(VB / 2 - 48, 132, 'YEA', GOOD, true),
    chip(VB / 2, 132, 'NAY', ALARM, false),
    chip(VB / 2 + 48, 132, 'ABS', DIM, false),
    card(168, 50),
    text(VB / 2, 184, 'OPEN THE LANES', { fill: INK, size: 11, weight: 'bold' }),
    text(VB / 2, 196, 'CLOSES IN 9T', { fill: WARN, size: 8, family: MONO }),
  ].join(''));
}

// ---- render ------------------------------------------------------------

/** A plain sans and a monospace, which is what Compose draws on the
 *  watch. Tried in order; the first that exists wins. */
function pickFont(candidates, what) {
  for (const p of candidates) if (existsSync(p)) return readFileSync(p);
  throw new Error(`no ${what} font found; tried:\n  ${candidates.join('\n  ')}`);
}

const sans = pickFont([
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
], 'sans');
const mono = pickFont([
  'C:/Windows/Fonts/consola.ttf',
  'C:/Windows/Fonts/cour.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/System/Library/Fonts/Menlo.ttc',
], 'monospace');

await initWasm(readFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm'));
mkdirSync(OUT, { recursive: true });

const screens = [
  ['1-empire', empire()],
  ['2-situation', situation()],
  ['3-senate', senate()],
];

for (const [name, svg] of screens) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    font: {
      fontBuffers: [sans, mono],
      // The SVG asks for OrbitalSans / OrbitalMono, which no font
      // declares -- so resvg falls back, and the fallback is the first
      // buffer. Naming the families explicitly is what keeps the
      // monospace rows monospaced.
      defaultFontFamily: SANS,
      loadSystemFonts: false,
    },
  });
  const png = r.render().asPng();
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log(`${OUT}/${name}.png  ${(png.length / 1024).toFixed(0)} KB  ${SIZE}x${SIZE}`);
}
