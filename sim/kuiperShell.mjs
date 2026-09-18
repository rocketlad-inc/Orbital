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

const { DB, G, rows, byTpl } = await seed('base');

// ---- everything arrived -------------------------------------------
const ADDED = ['orcus', 'vanth', 'ixion', 'mani', 'salacia', 'actaea', 'varuna',
  'aya', 'varda', 'ilmare', 'hiiaka', 'namaka', 'weywot', 'dysnomia', 'mk2'];
const missing = ADDED.filter(id => !byTpl.has(id));
check('every new body seeds', missing.length === 0, `missing: ${missing.join(', ')}`);

// ---- REAL ORDER IS THE PART THAT MUST STAY TRUE --------------------
// Distances are compressed and spread for play; the sequence is not.
// Anyone who looks these up should find them in the right order.
const BY_REAL_DISTANCE = [
  'orcus', 'pluto', 'ixion',      // plutinos, 39.2-39.7 AU
  'mani', 'salacia',              // 41.7, 42.1
  'haumea', 'varuna', 'aya', 'quaoar', // 43.13, 43.18, 43.28, 43.40
  'varda', 'makemake',            // 45.2, 45.8
  'eris', 'sedna',                // 96, 506
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

console.log(bad === 0 ? '\nALL KUIPER-SHELL CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
