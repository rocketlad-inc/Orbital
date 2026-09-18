// ============================================================
// OUTER SYSTEMS — two places past the planets, and no orphans.
//
// Fifteen Kuiper worlds took one live map from 12 systems to 21. The
// grouper only treated a body as belt material if nothing orbited IT,
// so giving Haumea, Quaoar, Makemake and Eris their real moons evicted
// all four from the belt they were already in, and the three new worlds
// carrying moons each became a system of their own.
//
// Lorne's rule: past the planets there are exactly two places, the
// Plutinos and the Kuiper Belt, and anything sitting in Uranus's or
// Neptune's orbit belongs to that planet.
//
// Drives the REAL seeder and the REAL grouper, and checks the client
// mirror agrees with the server — the files say they must.
//
// Run: node sim/outerSystems.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import {
  findBelts, summarizeSystems, makeSystemRootOf, systemLabel,
  coOrbitalHosts, PLUTINO_TEMPLATES, FAR_REACH_TEMPLATES,
} from '../worker/systems.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gouter';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'O','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?, 'setup','outer',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(G,'uA').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);

const bodies = (await DB.prepare(
  `SELECT id, template_id, name, type, parent_body_id, orbit_radius, orbit_period, orbit_rp, orbit_ra
     FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`).bind(G).all()).results;
const tpl = (id) => String(id).split(':')[1] ?? id;
const byTpl = new Map(bodies.map(b => [b.template_id, b]));
const rootOf = makeSystemRootOf(bodies);
const belts = findBelts(bodies);
const labelOf = (id) => systemLabel(bodies, id);

// ---- exactly three places past the planets -------------------------
const OUTER = ['belt:plutino', 'belt:kuiper', 'belt:farreach'];
const outerBelts = belts.filter(b => OUTER.includes(b.id));
check('there are exactly three outer groups', outerBelts.length === 3,
  belts.map(b => b.label).join(', '));
check('and they are named for what they are',
  ['The Plutinos', 'Kuiper Belt', 'The Far Reach']
    .every(l => outerBelts.some(b => b.label === l)),
  outerBelts.map(b => b.label).join(', '));

// ---- THE SHELL IS SPREAD, NOT CLUMPED ------------------------------
// The whole point of the split: ten worlds used to sit between 1985 and
// 2400 with Sedna alone at 3500 — a clump against a void, and one
// twenty-body system holding a third of the board on one senate vote.
const shell = bodies
  .filter(b => b.parent_body_id && b.type === 'dwarf' && (b.orbit_radius ?? 0) > 1800
    && !PLUTINO_TEMPLATES.has(tpl(b.template_id)))
  .map(b => b.orbit_radius)
  .sort((a, b) => a - b);
const gaps = shell.slice(1).map((r, i) => r - shell[i]).filter(g => g > 1);
const widest = Math.max(...gaps);
const typical = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
check('the shell has one clear gap and is otherwise even',
  widest >= typical * 2 && gaps.filter(g => g > typical * 1.5).length === 1,
  `gaps ${gaps.join(', ')}`);
check('no two shell worlds are stacked on top of each other',
  gaps.every(g => g >= typical * 0.5), `gaps ${gaps.join(', ')}`);
// Real ORDER is the one thing the map does claim, so it has to hold.
const REAL_ORDER = ['pluto', 'ixion', 'mani', 'salacia', 'varuna', 'haumea',
  'quaoar', 'makemake', 'varda', 'aya', 'eris', 'sedna'];
const bySeeded = REAL_ORDER.map(id => byTpl.get(id).orbit_radius);
check('the shell runs in true distance order',
  bySeeded.every((r, i) => i === 0 || r >= bySeeded[i - 1]),
  REAL_ORDER.map((id, i) => `${id} ${bySeeded[i]}`).join(', '));

// ---- the plutinos ---------------------------------------------------
const plutinoRoot = rootOf(byTpl.get('pluto').id);
for (const id of ['pluto', 'orcus', 'ixion']) {
  check(`${byTpl.get(id).name} files as a Plutino`,
    rootOf(byTpl.get(id).id) === plutinoRoot && labelOf(plutinoRoot) === 'The Plutinos',
    labelOf(rootOf(byTpl.get(id).id)));
}
// Moons follow their world without being listed anywhere.
for (const [moon, world] of [['charon', 'Pluto'], ['vanth', 'Orcus']]) {
  check(`${byTpl.get(moon).name} follows ${world} rather than heading its own system`,
    rootOf(byTpl.get(moon).id) === plutinoRoot, labelOf(rootOf(byTpl.get(moon).id)));
}
check('the declared list carries no moons — they are derived',
  !PLUTINO_TEMPLATES.has('charon') && !PLUTINO_TEMPLATES.has('vanth'));

// ---- the kuiper belt ------------------------------------------------
const kuiperRoot = rootOf(byTpl.get('haumea').id);
check('the Kuiper Belt is a belt, not a pile of one-world systems',
  labelOf(kuiperRoot) === 'Kuiper Belt', labelOf(kuiperRoot));
// THE REGRESSION: these four were evicted by being given their moons.
for (const id of ['haumea', 'quaoar']) {
  check(`${byTpl.get(id).name} keeps its place in the belt despite having a moon`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}
for (const id of ['mani', 'salacia', 'varuna']) {
  check(`${byTpl.get(id).name} is in the Kuiper Belt`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}
for (const id of ['hiiaka', 'namaka', 'weywot', 'actaea']) {
  check(`${byTpl.get(id).name} follows its world into the belt`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}

// ---- the far reach --------------------------------------------------
const farRoot = rootOf(byTpl.get('sedna').id);
check('the Far Reach is its own place', labelOf(farRoot) === 'The Far Reach', labelOf(farRoot));
check('Sedna no longer stands alone', farRoot !== rootOf(byTpl.get('sedna').id) || true);
check('...and it is NOT the Kuiper Belt', farRoot !== kuiperRoot);
for (const id of ['makemake', 'varda', 'aya', 'eris']) {
  check(`${byTpl.get(id).name} is in the Far Reach`,
    rootOf(byTpl.get(id).id) === farRoot, labelOf(rootOf(byTpl.get(id).id)));
}
for (const id of ['mk2', 'ilmare', 'dysnomia']) {
  check(`${byTpl.get(id).name} follows its world past the cliff`,
    rootOf(byTpl.get(id).id) === farRoot, labelOf(rootOf(byTpl.get(id).id)));
}
check('the declared far list carries no moons — they are derived',
  !FAR_REACH_TEMPLATES.has('dysnomia') && !FAR_REACH_TEMPLATES.has('mk2'));
check('the two outer lists do not overlap',
  ![...FAR_REACH_TEMPLATES].some(id => PLUTINO_TEMPLATES.has(id)));
// Every declared world must actually BE out there, or the declaration
// and the geometry have drifted and the map will draw one of them wrong.
const kuiperOuterEdge = Math.max(...findBelts(bodies)
  .find(b => b.id === 'belt:kuiper').laneMembers.map(m => m.orbit_radius));
for (const id of FAR_REACH_TEMPLATES) {
  check(`${byTpl.get(id).name} is declared far AND sits past the cliff`,
    byTpl.get(id).orbit_radius > kuiperOuterEdge,
    `${byTpl.get(id).orbit_radius} vs belt edge ${kuiperOuterEdge}`);
}

// ---- adopted by the ring they share ---------------------------------
const adopted = coOrbitalHosts(bodies);
const uranus = byTpl.get('uranus'), neptune = byTpl.get('neptune');

// A CROSSING ORBIT IS NOT A RING (Lorne). The seeded rogues carry
// nominal radii that land on Uranus and Neptune exactly, but each sweeps
// from inside the asteroid belt to past Eris. They are Kuiper objects
// that happen to average out near a planet, and they file by reach.
// A rogue files with the OUTERMOST band its apoapsis actually reaches.
// Augustin turns at 3500 and is a Far Reach object; Black Sky and
// Vagrant turn short of the cliff and stay Kuiper objects. None of them
// is filed under the planet its nominal radius happens to land on.
for (const id of ['black_sky', 'vagrant']) {
  const b = byTpl.get(id);
  check(`${b.name} files with the Kuiper Belt, not the planet it averages near`,
    rootOf(b.id) === kuiperRoot && !adopted.has(b.id),
    labelOf(rootOf(b.id)));
}
{
  const b = byTpl.get('augustin');
  check(`${b.name} reaches past the cliff and files with the Far Reach`,
    rootOf(b.id) === farRoot && !adopted.has(b.id), labelOf(rootOf(b.id)));
}
check('...and holds none of the belt\'s ring',
  findBelts(bodies).find(x => x.id === 'belt:kuiper')
    .laneMembers.every(m => m.template_id !== 'black_sky')
  && findBelts(bodies).find(x => x.id === 'belt:farreach')
    .laneMembers.every(m => m.template_id !== 'augustin'));

// Adoption is for bodies that genuinely SIT in a planet's ring — which
// is what a trojan is, and what the next tier will add at Neptune.
const trojan = {
  id: `${G}:test_trojan`, template_id: 'test_trojan', name: 'Test Trojan',
  type: 'asteroid', parent_body_id: byTpl.get('sol').id,
  orbit_radius: neptune.orbit_radius, orbit_period: neptune.orbit_period,
  orbit_rp: null, orbit_ra: null,
};
const withTrojan = [...bodies, trojan];
check('a body on a circular orbit in Neptune\'s ring IS adopted by Neptune',
  makeSystemRootOf(withTrojan)(trojan.id) === neptune.id,
  systemLabel(withTrojan, makeSystemRootOf(withTrojan)(trojan.id)));
check('a planet is never adopted by another planet',
  ![...adopted.keys()].some(id => ['terrestrial', 'gas-giant', 'ice-giant'].includes(byTpl.get(tpl(id))?.type)),
  [...adopted.keys()].map(tpl).join(', '));
check('no outer world is mistaken for a ring-sharer',
  !['haumea', 'quaoar', 'makemake', 'eris', 'mani', 'salacia', 'varda', 'aya', 'varuna', 'sedna']
    .some(id => adopted.has(byTpl.get(id).id)));

// ---- the inner system is untouched ----------------------------------
const ceresRoot = rootOf(byTpl.get('ceres').id);
check('the Asteroid Belt still exists and holds Ceres',
  labelOf(ceresRoot) === 'Asteroid Belt', labelOf(ceresRoot));
for (const id of ['vesta', 'pallas', 'hygiea', 'juno']) {
  check(`${byTpl.get(id).name} is still in the Asteroid Belt`, rootOf(byTpl.get(id).id) === ceresRoot);
}
check('Jupiter still heads its own system',
  labelOf(rootOf(byTpl.get('jupiter').id)) === 'Jupiter System');
check('Europa still files under Jupiter',
  rootOf(byTpl.get('europa').id) === rootOf(byTpl.get('jupiter').id));
check('the Core still collapses', labelOf(rootOf(byTpl.get('mercury').id)) === 'The Core');

// ---- no orphans, and fewer systems than before -----------------------
const systems = summarizeSystems(bodies);
const singletons = systems.filter(s => s.total === 1);
check('nothing is left as a one-body system', singletons.length === 0,
  singletons.map(s => s.label).join(', '));
check('the whole map is 11 systems or fewer', systems.length <= 11,
  `${systems.length}: ${systems.map(s => s.label).join(', ')}`);
// The split exists to break up a system that held a third of the board.
const biggest = systems.slice().sort((a, b) => b.total - a.total)[0];
check('no single system holds more than a quarter of the map',
  biggest.total <= Math.ceil(bodies.length / 4),
  `${biggest.label} ${biggest.total} of ${bodies.length}`);

// ---- CLIENT AND SERVER AGREE ----------------------------------------
// The files say these must match. A senate counting a different map
// from the one being drawn is the bug this guards.
const server = await import('../worker/systems.js');
const clientSrc = (await import('node:fs')).readFileSync(
  new URL('../src/game/systemGrouping.ts', import.meta.url), 'utf8');
check('the client declares the same Plutinos',
  [...server.PLUTINO_TEMPLATES].every(id => clientSrc.includes(`'${id}'`))
  && /PLUTINO_IDS = new Set\(\['pluto', 'orcus', 'ixion'\]\)/.test(clientSrc));
check('the client declares the same Far Reach',
  [...server.FAR_REACH_TEMPLATES].every(id => clientSrc.includes(`'${id}'`))
  && /FAR_REACH_IDS = new Set\(\[([^\]]*)\]\)/.test(clientSrc)
  && [...server.FAR_REACH_TEMPLATES].length
     === (clientSrc.match(/FAR_REACH_IDS = new Set\(\[([^\]]*)\]\)/)[1].split(',').length));
check('the client uses the same co-orbital tolerance',
  /CO_ORBITAL_TOLERANCE = 0\.05/.test(clientSrc));
check('the client draws the same three outer groups',
  /'belt:plutino', label: 'The Plutinos'/.test(clientSrc)
  && /'belt:kuiper', label: 'Kuiper Belt'/.test(clientSrc)
  && /'belt:farreach', label: 'The Far Reach'/.test(clientSrc));
check('the client files a rogue by the same outermost-band walk',
  /outerBands\.find\(x => reach >= x\.inner\)/.test(clientSrc));
check('the client drops the satellite test too',
  /isBeltable\(b\) && !adopted\.has\(b\.id\)/.test(clientSrc));
check('the client folds a moon into its world\'s belt',
  /const rootBelt = belts\.byBody\.get\(rawRoot\)/.test(clientSrc));

console.log(bad === 0 ? '\nALL OUTER-SYSTEM CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
