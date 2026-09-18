// ============================================================
// THE KUIPER SHELL — the worlds added just past Pluto, and the
// secret bands they would otherwise have broken.
//
// Real astronomy puts almost every large body out here in a ring six
// units wide between 42 and 48 times Earth's distance from the sun.
// The catalogue keeps the true ORDER and spreads the true SPACING,
// which is what the shipped map already did by hand for Haumea,
// Quaoar and Makemake. These checks drive the REAL seeder and read
// back what it wrote, so a hand-edited orbit that breaks the ordering
// fails here rather than in someone's game.
//
// Run: node sim/kuiperShell.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

async function seed(tag, overrides = null) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gkuiper_${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'K','uA',0,0)`).bind(G).run();
  if (overrides) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms, published_ms)
       VALUES ('cfg_k','k','published', ?, 0, 0, 0)`).bind(JSON.stringify(overrides)).run();
  }
  await DB.prepare(
    `INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at,config_id)
     VALUES (?, 'setup',?,0,3600000,0,0,?)`).bind(G, `kuiper-${tag}`, overrides ? 'cfg_k' : null).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(G, 'uA').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  const rows = (await DB.prepare(
    `SELECT id, template_id, name, type, parent_body_id, radius, soi, orbit_radius, orbit_period, angle0, secret_kind
       FROM game_bodies WHERE game_id = ?`).bind(G).all()).results;
  return { DB, G, rows, byTpl: new Map(rows.map(r => [r.template_id, r])) };
}

const TAU = Math.PI * 2;
const { DB, G, rows, byTpl } = await seed('base');

// ---- everything arrived -------------------------------------------
const ADDED = ['orcus', 'vanth', 'ixion', 'mani', 'salacia', 'actaea', 'varuna',
  'aya', 'varda', 'ilmare', 'hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2'];
const missing = ADDED.filter(id => !byTpl.has(id));
check('every new body seeds', missing.length === 0, `missing: ${missing.join(', ')}`);

// ---- REAL ORDER IS THE PART THAT MUST STAY TRUE --------------------
// Distances are compressed and spread for play; the sequence is not.
// Anyone who looks these up should find them in the right order.
// Corrected when the shell was spread: the first pass had Haumea inside
// Varuna and Aya down among the inner belt worlds, neither of which is
// where they are. Aya is 2002 AW197 and is the OUTERMOST of the ordinary
// belt worlds.
const BY_REAL_DISTANCE = [
  'orcus', 'pluto', 'ixion',      // plutinos, 39.4-39.7 AU
  'mani', 'salacia',              // 41.9, 42.0
  'varuna', 'haumea', 'quaoar',   // 42.9, 43.2, 43.7
  'makemake', 'varda', 'aya',     // 45.4, 45.8, 47.4
  'eris', 'sedna',                // 67.8, 506
];
let ordered = true;
const seq = [];
for (let i = 1; i < BY_REAL_DISTANCE.length; i++) {
  const prev = byTpl.get(BY_REAL_DISTANCE[i - 1]);
  const cur = byTpl.get(BY_REAL_DISTANCE[i]);
  seq.push(`${cur.name} ${Math.round(cur.orbit_radius)}`);
  // Orcus and Pluto deliberately share an orbit (see below).
  if (cur.orbit_radius < prev.orbit_radius) ordered = false;
}
check('the shell runs in true distance order', ordered, seq.join(' | '));

// ---- Orcus is the anti-Pluto, permanently --------------------------
const pluto = byTpl.get('pluto');
const orcus = byTpl.get('orcus');
check('Orcus shares Pluto\'s orbit and year, so the pairing never drifts',
  orcus.orbit_radius === pluto.orbit_radius && orcus.orbit_period === pluto.orbit_period,
  `orcus ${orcus.orbit_radius}/${orcus.orbit_period} vs pluto ${pluto.orbit_radius}/${pluto.orbit_period}`);
const gap = Math.abs(((orcus.angle0 - pluto.angle0) + 2 * Math.PI) % (2 * Math.PI));
check('...half a lap out of phase, which is what makes it the anti-Pluto',
  Math.abs(gap - Math.PI) < 0.02, `gap ${gap.toFixed(3)} rad`);

// ---- Kepler, against the catalogue's own anchor ---------------------
// T = 6720 * (a/1900)^1.5 reproduces the three originals to within a
// tick or two, so the new worlds are held to the same rule.
const keplerOk = [];
for (const id of ['ixion', 'mani', 'salacia', 'varuna', 'aya', 'varda']) {
  const b = byTpl.get(id);
  const want = pluto.orbit_period * Math.pow(b.orbit_radius / pluto.orbit_radius, 1.5);
  const off = Math.abs(b.orbit_period - want) / want;
  if (off > 0.005) keplerOk.push(`${b.name} off by ${(off * 100).toFixed(2)}%`);
}
check('every new world\'s year matches its distance', keplerOk.length === 0, keplerOk.join(', '));

// ---- moons sit inside their parent ---------------------------------
const moonProblems = [];
for (const id of ['vanth', 'actaea', 'ilmare', 'hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2']) {
  const m = byTpl.get(id);
  const parent = rows.find(r => r.id === m.parent_body_id);
  if (!parent) { moonProblems.push(`${m.name} has no parent row`); continue; }
  if (m.orbit_radius >= parent.soi) moonProblems.push(`${m.name} at ${m.orbit_radius} outside ${parent.name} soi ${parent.soi}`);
}
check('every new moon orbits inside its world\'s reach', moonProblems.length === 0, moonProblems.join('; '));

// ---- nobody starts out here ----------------------------------------
const factions = await import('../worker/factions.js');
const startable = new Set(factions.STARTING_BODY_OPTIONS.map(b => b.id));
const wrongStart = ADDED.filter(id => startable.has(id));
check('no new world is offered as a starting capital', wrongStart.length === 0, wrongStart.join(', '));

// ---- the map got bigger, and domination moved with it ---------------
const claimable = (await DB.prepare(
  `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL
     AND type NOT IN ('meteoroid','lagrange','megastructure')`).bind(G).first()).n;
check('the claimable map grew to 60 worlds', claimable === 60, String(claimable));
check('...so 60% domination now asks for 36, not 27', Math.floor(claimable * 0.6) + 1 === 37 || Math.ceil(claimable * 0.6) === 36, String(claimable));

// ---- SECRETS LAND IN THE RIGHT BAND --------------------------------
// The categoriser used to bucket every dwarf as 'belt' regardless of
// distance, so the ancient city — whose whole premise is that it sleeps
// in the belt — could be placed past Neptune. Fifteen new dwarfs would
// have made that the usual outcome.
const ceres = byTpl.get('ceres').orbit_radius;
const jupiter = byTpl.get('jupiter').orbit_radius;
const secrets = rows.filter(r => r.secret_kind);
check('every secret was placed', secrets.length >= 5, String(secrets.length));
const city = secrets.find(s => s.secret_kind === 'ancient_city');
check('the ancient city sleeps in the BELT, not past Neptune',
  !!city && city.orbit_radius >= ceres && city.orbit_radius < jupiter,
  city ? `${city.name} at ${Math.round(city.orbit_radius)} (belt is ${ceres}-${jupiter})` : 'not placed');
const far = secrets.filter(s => s.secret_kind === 'portal_to_sun' || s.secret_kind === 'pre_terraformed');
check('the portal and the prepared world stay in the outer system',
  far.every(s => s.orbit_radius >= jupiter || s.type === 'moon'),
  far.map(s => `${s.secret_kind}@${s.name}`).join(', '));

// Over many seeds the belt-only secret must NEVER escape the belt.
let escapes = 0;
for (let i = 0; i < 6; i++) {
  const s = await seed(`r${i}`);
  const c = s.rows.find(r => r.secret_kind === 'ancient_city');
  const cer = s.byTpl.get('ceres').orbit_radius, jup = s.byTpl.get('jupiter').orbit_radius;
  if (c && !(c.orbit_radius >= cer && c.orbit_radius < jup)) escapes += 1;
}
check('across six seeds the belt secret never leaves the belt', escapes === 0, `${escapes} escapes`);

// ---- and it all still holds on a stretched map ----------------------
const wide = await seed('wide', { system_scale: 4, moon_scale: 8, body_scale: 2, randomize_orbits: 1 });
const wPluto = wide.byTpl.get('pluto'), wOrcus = wide.byTpl.get('orcus');
check('[scale 4] Orcus is still locked opposite Pluto',
  wOrcus.orbit_radius === wPluto.orbit_radius
  && Math.abs(Math.abs(((wOrcus.angle0 - wPluto.angle0) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI) < 0.02);
const wMoons = ['vanth', 'actaea', 'ilmare', 'hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2']
  .map(id => wide.byTpl.get(id))
  .filter(m => m.orbit_radius >= wide.rows.find(r => r.id === m.parent_body_id).soi);
check('[scale 4] every moon is still inside its world', wMoons.length === 0,
  wMoons.map(m => m.name).join(', '));

// ---- BACKFILL INTO A RUNNING, STRETCHED GAME -----------------------
// This is the path the live 8-player map takes: it was seeded before
// these worlds existed, at system_scale 4 / moon_scale 8 / body_scale 2
// / outer_orbit_speedup 4 with its phases shuffled. Backfill used to
// scale the heliocentric orbit and nothing else, which on that map
// means half-size worlds whose moons orbit eight times too tightly and
// whose years run four times too long.
const DIALS = { system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4, randomize_orbits: 1 };
const live = await seed('live', DIALS);
const factionsMod = await import('../worker/factions.js');

// Rewind it to a map that predates the shell, then let backfill rebuild.
const SHELL = ['orcus','vanth','ixion','mani','salacia','actaea','varuna','aya','varda','ilmare','hiiaka','namaka','weywot','dysnomia','mk2'];
await live.DB.prepare(
  `DELETE FROM game_bodies WHERE game_id = ? AND template_id IN (${SHELL.map(() => '?').join(',')})`,
).bind(live.G, ...SHELL).run();
const before = (await live.DB.prepare('SELECT COUNT(*) n FROM game_bodies WHERE game_id = ?').bind(live.G).first()).n;
const added = await factionsMod.backfillMissingBodies({ DB: live.DB }, live.G);
check('backfill puts the whole shell into a running game', added === 15, String(added));

const back = new Map((await live.DB.prepare(
  `SELECT template_id, name, type, parent_body_id, radius, soi, orbit_radius, orbit_period, angle0
     FROM game_bodies WHERE game_id = ?`).bind(live.G).all()).results.map(r => [r.template_id, r]));

// Against a world that was SEEDED into the same map, not against the catalogue.
const seededDwarf = back.get('makemake');   // present since worldgen
const backfilled = back.get('varda');       // arrived just now
check('a backfilled world is the same size as one seeded beside it',
  Math.abs(backfilled.radius - seededDwarf.radius) < 0.35,
  `varda r=${backfilled.radius} vs makemake r=${seededDwarf.radius}`);
// Bracketed by two worlds that were SEEDED, so this measures the
// backfilled body against originals rather than against its own cohort.
check('...and sits in the right place in the order',
  backfilled.orbit_radius > seededDwarf.orbit_radius
  && backfilled.orbit_radius < back.get('eris').orbit_radius,
  `varda ${backfilled.orbit_radius}, makemake ${seededDwarf.orbit_radius}, eris ${back.get('eris').orbit_radius}`);

// Years: an outer world gets the same speed-up its neighbours got.
const yearRatio = backfilled.orbit_period / seededDwarf.orbit_period;
const distRatio = Math.pow(backfilled.orbit_radius / seededDwarf.orbit_radius, 1.5);
check('a backfilled outer world keeps its neighbours\' rhythm, not a 4x-slower one',
  Math.abs(yearRatio - distRatio) / distRatio < 0.02,
  `year ratio ${yearRatio.toFixed(3)} vs distance implies ${distRatio.toFixed(3)}`);

// Moons: spread by the same moon_scale the map was built with.
const seededMoon = back.get('charon');
const newMoon = back.get('vanth');
check('a backfilled moon is spread like the moons already there',
  newMoon.orbit_radius > seededMoon.orbit_radius * 0.5
  && newMoon.orbit_radius < seededMoon.orbit_radius * 1.5,
  `vanth ${newMoon.orbit_radius} vs charon ${seededMoon.orbit_radius}`);
check('...and still inside its world',
  newMoon.orbit_radius < back.get('orcus').soi,
  `vanth ${newMoon.orbit_radius} vs orcus soi ${back.get('orcus').soi}`);

// The phase lock has to answer to the SHUFFLED Pluto, not the catalogue.
const lPluto = back.get('pluto'), lOrcus = back.get('orcus');
const lGap = Math.abs(((lOrcus.angle0 - lPluto.angle0) + TAU) % TAU);
check('backfilled Orcus locks onto the Pluto THIS map actually has',
  lOrcus.orbit_radius === lPluto.orbit_radius && Math.abs(lGap - Math.PI) < 0.02,
  `gap ${lGap.toFixed(3)} rad (pluto angle ${lPluto.angle0.toFixed(3)})`);

check('backfill is idempotent', await factionsMod.backfillMissingBodies({ DB: live.DB }, live.G) === 0);

console.log(bad === 0 ? '\nALL KUIPER-SHELL CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
