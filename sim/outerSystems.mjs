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
  coOrbitalHosts, PLUTINO_TEMPLATES,
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

// ---- exactly two places past the planets ---------------------------
const outerBelts = belts.filter(b => b.id === 'belt:plutino' || b.id === 'belt:kuiper');
check('there are exactly two outer groups', outerBelts.length === 2,
  belts.map(b => b.label).join(', '));
check('and they are named for what they are',
  outerBelts.some(b => b.label === 'The Plutinos') && outerBelts.some(b => b.label === 'Kuiper Belt'),
  outerBelts.map(b => b.label).join(', '));

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
for (const id of ['haumea', 'quaoar', 'makemake', 'eris']) {
  check(`${byTpl.get(id).name} keeps its place in the belt despite having a moon`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}
for (const id of ['mani', 'salacia', 'varuna', 'aya', 'varda', 'sedna']) {
  check(`${byTpl.get(id).name} is in the Kuiper Belt`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}
for (const id of ['hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2', 'actaea', 'ilmare']) {
  check(`${byTpl.get(id).name} follows its world into the belt`,
    rootOf(byTpl.get(id).id) === kuiperRoot, labelOf(rootOf(byTpl.get(id).id)));
}
check('Sedna no longer stands alone', rootOf(byTpl.get('sedna').id) === kuiperRoot);

// ---- adopted by the ring they share ---------------------------------
const adopted = coOrbitalHosts(bodies);
const uranus = byTpl.get('uranus'), neptune = byTpl.get('neptune');

// A CROSSING ORBIT IS NOT A RING (Lorne). The seeded rogues carry
// nominal radii that land on Uranus and Neptune exactly, but each sweeps
// from inside the asteroid belt to past Eris. They are Kuiper objects
// that happen to average out near a planet, and they file by reach.
for (const id of ['black_sky', 'vagrant', 'augustin']) {
  const b = byTpl.get(id);
  check(`${b.name} files with the Kuiper Belt, not the planet it averages near`,
    rootOf(b.id) === kuiperRoot && !adopted.has(b.id),
    labelOf(rootOf(b.id)));
}
check('...and holds none of the belt\'s ring',
  findBelts(bodies).find(x => x.id === 'belt:kuiper')
    .laneMembers.every(m => m.template_id !== 'black_sky'));

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
check('no Kuiper world is mistaken for a ring-sharer',
  !['haumea', 'quaoar', 'makemake', 'eris', 'mani', 'salacia', 'varda', 'aya', 'varuna']
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
check('the whole map is 10 systems or fewer', systems.length <= 10,
  `${systems.length}: ${systems.map(s => s.label).join(', ')}`);

// ---- CLIENT AND SERVER AGREE ----------------------------------------
// The files say these must match. A senate counting a different map
// from the one being drawn is the bug this guards.
const server = await import('../worker/systems.js');
const clientSrc = (await import('node:fs')).readFileSync(
  new URL('../src/game/systemGrouping.ts', import.meta.url), 'utf8');
check('the client declares the same Plutinos',
  [...server.PLUTINO_TEMPLATES].every(id => clientSrc.includes(`'${id}'`))
  && /PLUTINO_IDS = new Set\(\['pluto', 'orcus', 'ixion'\]\)/.test(clientSrc));
check('the client uses the same co-orbital tolerance',
  /CO_ORBITAL_TOLERANCE = 0\.05/.test(clientSrc));
check('the client draws the same two outer groups',
  /'belt:plutino', label: 'The Plutinos'/.test(clientSrc)
  && /'belt:kuiper', label: 'Kuiper Belt'/.test(clientSrc));
check('the client drops the satellite test too',
  /isBeltable\(b\) && !adopted\.has\(b\.id\)/.test(clientSrc));
check('the client folds a moon into its world\'s belt',
  /const rootBelt = belts\.byBody\.get\(rawRoot\)/.test(clientSrc));

console.log(bad === 0 ? '\nALL OUTER-SYSTEM CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
