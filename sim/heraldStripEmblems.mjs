// ============================================================
// Herald strip — the emblem stamp on sector ownership labels.
//
// The strip PNG is a hand-rolled pixel surface with no canvas and no
// SVG rasteriser, so emblems are stamped from baked 1-bit masks
// (worker/_emblemMasks.js). This guards the three things that can go
// wrong with that arrangement:
//
//   1. the mask table is empty/blank and nothing is actually drawn —
//      the image would still render, just without emblems, and no
//      error would ever surface
//   2. an unknown emblem id throws instead of falling back
//   3. a faction with no emblem stops getting its NAME
//
// Run: npm run sim:strip
// ============================================================

import { renderStripPng } from '../worker/heraldStrip.js';
import { EMBLEM_MASKS, forEachMaskPixel } from '../worker/_emblemMasks.js';

const body = (name, owner) => ({ name, owner, type: 'terrestrial', combat: false, orbitRadius: 100 });
const base = () => ({
  game: { id: 'g', name: 'Test', tick: 100, status: 'active' },
  factions: {
    f0: { name: 'Ares Directorate', color: '#ff7043', color2: '#ffab91', emblem: 'anchor' },
    f1: { name: 'Boreal Compact',   color: '#42a5f5', color2: '#90caf9', emblem: 'crown'  },
  },
  sectors: [
    { label: 'MERCURY', order: 1, weight: 1, bodies: [body('Mercury', 'f0')], moons: [] },
    { label: 'MARS',    order: 2, weight: 1, bodies: [body('Mars', 'f1')],    moons: [] },
    { label: 'CERES',   order: 3, weight: 1, bodies: [body('Ceres', null)],   moons: [] },
  ],
  starOwner: 'f0', starCombat: false, bodyCount: 3, combatCount: 0,
});

let bad = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { bad++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const bytes = (p) => new Uint8Array(p);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Every baked mask must have ink. A silently-blank table would render a
// perfectly valid image with no emblems on it.
{
  const ids = Object.keys(EMBLEM_MASKS);
  const blank = ids.filter(id => { let n = 0; forEachMaskPixel(id, () => n++); return n === 0; });
  check(`all ${ids.length} baked masks have ink`, ids.length > 0 && blank.length === 0, `blank: ${blank}`);
}

const withEmblems = bytes(await renderStripPng(null, 'g', { data: base() }));

// Strip the emblems: must still render, and must look DIFFERENT.
const noEmb = base();
for (const k of Object.keys(noEmb.factions)) noEmb.factions[k].emblem = null;
const withNames = bytes(await renderStripPng(null, 'g', { data: noEmb }));

check('renders with emblems', withEmblems.length > 0);
check('renders with names (no emblem)', withNames.length > 0);
check('emblem output DIFFERS from name output', !same(withEmblems, withNames),
  'identical images means the stamp drew nothing');

// An unknown id must degrade to the name, not throw.
const bogus = base();
bogus.factions.f0.emblem = 'not_a_real_emblem';
bogus.factions.f1.emblem = 'also_fake';
let bogusOut = null;
try { bogusOut = bytes(await renderStripPng(null, 'g', { data: bogus })); }
catch (e) { check('unknown emblem id does not throw', false, e.message); }
if (bogusOut) {
  check('unknown emblem id does not throw', true);
  check('unknown emblem id falls back to the NAME', same(bogusOut, withNames),
    'should be byte-identical to the names render');
}

console.log('');
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('sector labels fly the flag, and fall back to the name when they cannot');
