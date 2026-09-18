// ============================================================
// HERALD STRIP — a belt's moons are in the belt.
//
// The territory chart pools rubble into bands so twenty dwarfs don't
// each claim a column. That pooling threw the rocks' MOONS on the
// floor: the band was assembled with `moons: []` and the per-body loop
// `continue`d before it used them. Harmless while a belt was eight bare
// rocks. The moment the Kuiper dwarfs were given their real satellites
// it meant the Herald drew thirteen pips for a band holding twenty
// worlds, and Charon, Vanth, Actaea, Hi'iaka, Namaka, Weywot, Dysnomia
// and MK 2 appeared NOWHERE on the published chart — including when a
// faction held one.
//
// Drives the REAL assembler against the REAL seeded world, and renders
// the REAL PNG, because the last three bugs in this area were all "the
// data was right and the picture was wrong".
//
// Run: node sim/heraldStrip.mjs [--png <path>]
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { buildTerritoryData, renderStripPng, renderStripPage, rowPlan } from '../worker/heraldStrip.js';
import { findBelts } from '../worker/systems.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gherald';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'The Test Zone','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?, 'setup','herald',900,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(G, 'uA').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);

const bodies = (await DB.prepare(
  `SELECT id, template_id, name, type, parent_body_id, orbit_radius, orbit_rp, orbit_ra
     FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`).bind(G).all()).results;
const byTpl = new Map(bodies.map(b => [b.template_id, b]));

// Two empires, so ownership actually reaches the chart. One takes a
// Kuiper MOON and nothing else out there — the exact case that used to
// be invisible.
const fac = (id, name, color, slot) => DB.prepare(
  `INSERT INTO game_factions (id,game_id,name,color,slot,status,joined_at)
   VALUES (?,?,?,?,?,'active',0)`).bind(id, G, name, color, slot).run();
await fac('fA', 'Test Alpha', '#ff5a5a', 40);
await fac('fB', 'Test Beta', '#4ecdc4', 41);
const own = (tplId, f) => DB.prepare(
  `UPDATE game_bodies SET owner_faction_id = ? WHERE game_id = ? AND template_id = ?`)
  .bind(f, G, tplId).run();
await own('earth', 'fA');
await own('ceres', 'fA');
await own('vesta', 'fA');
await own('charon', 'fB');     // a Plutino moon, no world
await own('hiiaka', 'fB');     // a Kuiper moon, no world
await own('eris', 'fB');

const data = await buildTerritoryData(env, G);
check('the chart builds', !!data);
const sectorOf = (label) => data.sectors.find(s => s.label === label);
const kuiper = sectorOf('Kuiper Belt');
const plutinos = sectorOf('The Plutinos');
const asteroid = sectorOf('Asteroid Belt');

// ---- every body that can hold ground is somewhere on the chart -------
// Not "most of them". The bug was a silent omission, so the guard has
// to be a closed set, not a spot check.
const drawn = new Set();
for (const s of data.sectors) {
  for (const b of s.bodies) drawn.add(b.name);
  for (const m of (s.moons || [])) drawn.add(m.name);
}
const shouldDraw = bodies.filter(b =>
  !['meteoroid', 'lagrange', 'megastructure', 'star'].includes(b.type));
const missing = shouldDraw.filter(b => !drawn.has(b.name)).map(b => b.name);
check('no body that can hold ground is left off the chart', missing.length === 0,
  `missing: ${missing.join(', ')}`);

// ---- the specific regression ----------------------------------------
const kuiperMoons = (kuiper?.moons || []).map(m => m.name);
for (const tpl of ['hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2', 'actaea', 'ilmare']) {
  const b = byTpl.get(tpl);
  check(`${b.name} is drawn with the belt its world sits in`,
    kuiperMoons.includes(b.name), kuiperMoons.join(', '));
}
for (const tpl of ['charon', 'vanth']) {
  const b = byTpl.get(tpl);
  check(`${b.name} is drawn with the Plutinos`,
    (plutinos?.moons || []).some(m => m.name === b.name),
    (plutinos?.moons || []).map(m => m.name).join(', '));
}
check('a belt with no moons still reports none', (asteroid?.moons || []).length === 0);

// ---- a moon nobody would otherwise see carries its holder ------------
const held = (kuiper?.moons || []).find(m => m.name === byTpl.get('hiiaka').name);
check('a Kuiper moon shows its holder', held?.owner === 'fB', String(held?.owner));
check('...and counts toward who holds the band',
  (kuiper.bodies.concat(kuiper.moons)).filter(x => x.owner === 'fB').length >= 2);

// ---- the band still fits on the page --------------------------------
check('a belt band is not wider than the cap allows',
  data.sectors.every(s => s.weight <= 2.4 && s.weight >= 0.9),
  data.sectors.map(s => `${s.label} ${s.weight.toFixed(2)}`).join(', '));
check('the Kuiper band is the widest column',
  kuiper.weight === Math.max(...data.sectors.map(s => s.weight)),
  data.sectors.map(s => `${s.label} ${s.weight.toFixed(2)}`).join(', '));

// ---- the pip grid spreads rather than stranding a remainder ----------
check('thirteen worlds over four rows read 4/3/3/3',
  rowPlan(13, 4).join('/') === '4/3/3/3', rowPlan(13, 4).join('/'));
check('seven moons over two rows read 4/3',
  rowPlan(7, 6).join('/') === '4/3', rowPlan(7, 6).join('/'));
check('a full row stays a full row', rowPlan(8, 4).join('/') === '4/4');
check('every plan spends exactly its pips and none overflows',
  [1, 2, 3, 5, 7, 8, 11, 13, 20, 31].every((n) => {
    const p = rowPlan(n, 4);
    return p.reduce((a, x) => a + x, 0) === n && Math.max(...p) <= 4 && Math.min(...p) >= 1;
  }));

// ---- and the picture actually renders --------------------------------
const png = await renderStripPng(env, G, { data, width: 550, height: 440 });
check('the PNG renders', png instanceof Uint8Array && png.length > 2000, `${png?.length} bytes`);
check('it is a PNG', png && png[0] === 0x89 && png[1] === 0x50);
const html = renderStripPage(data, { width: 1200, height: 420 });
check('the HTML chart embeds the moons it must draw',
  html.includes(byTpl.get('hiiaka').name) && html.includes('bandCaption'));
// The inline script is emitted from a template literal, where \w and \s
// are unrecognised escapes that collapse to bare letters. The shipped
// page carried /[^w s'-]/g, so shortName() stripped every letter that
// wasn't a w or an s and returned "" — the holder line under an owned
// sector was blank for any empire without a flag emblem. Assert on the
// EMITTED text, because the bug is invisible in the source.
{
  // Lift the EMITTED function out of the page and run it, because the
  // bug is invisible in the source — it only exists after the template
  // literal has eaten the escapes.
  // eslint-disable-next-line no-new-func
  const shortName = new Function('n', html.match(/function shortName\(n\)\{([\s\S]*?)\n\}/)[1]);
  check('an empire name survives the emitted shortName',
    shortName('The Test Beta') === 'TEST BETA', JSON.stringify(shortName('The Test Beta')));
  check('...and it still strips the leading article and punctuation',
    shortName('The Wu-Tang Clan!') === 'WU-TANG CLAN', JSON.stringify(shortName('The Wu-Tang Clan!')));
}

const pngArg = process.argv.indexOf('--png');
if (pngArg > 0 && process.argv[pngArg + 1]) {
  const fs = await import('node:fs');
  const out = process.argv[pngArg + 1];
  const big = await renderStripPng(env, G, { data, width: 1100, height: 760 });
  fs.writeFileSync(out, big);
  // ALSO the size the Herald actually attaches — the one a reader sees.
  fs.writeFileSync(out.replace(/\.png$/, '.attached.png'), png);
  console.log(`\nwrote ${out} and ${out.replace(/\.png$/, '.attached.png')}`);
}
const htmlArg = process.argv.indexOf('--html');
if (htmlArg > 0 && process.argv[htmlArg + 1]) {
  (await import('node:fs')).writeFileSync(process.argv[htmlArg + 1], html);
  console.log(`wrote ${process.argv[htmlArg + 1]}`);
}

console.log('\n' + data.sectors.map(s =>
  `${s.label.padEnd(16)} ${String(s.bodies.length).padStart(2)} worlds ` +
  `${String((s.moons || []).length).padStart(2)} moons  w=${s.weight.toFixed(2)}`).join('\n'));

console.log(bad === 0 ? '\nALL HERALD STRIP CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
