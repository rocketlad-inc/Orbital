// ============================================================
// CUSTOM-MAP RULES (2026-10-15 audit). Sol's rules leaking into games
// seeded from a Map Maker map, each pinned here against the REAL seeder
// (sim/headless.mjs runGame), the real grouping (worker/systems.js), the
// real Herald and digest code, and the lobby start path:
//
//   1  rocks beside a moon-bearing planet must not shrink every moon
//   2  dwarfs are their own systems; only 3+ asteroids make a belt
//   3  'random' discoveries draw from the ordinary pool only
//   4  the outer-orbit speed-up starts past the map's outermost planet
//   5  a custom room whose map will not load fails its start, never Sol
//   6  the star is called its name, not "The Core"
//   7  the Herald strip names the star in its colour
//   8  the digest locator never says "Kuiper Belt" on a custom map
//   9  default empire names come from the capital, not Sol
//  12  the star carries its own mu (Sol's mu x the sun's mass)
//
// Sol is the control throughout: each Sol-side answer must be exactly
// what it was.
//
// Run: node sim/customMapRules.mjs
// ============================================================

import { runGame } from './headless.mjs';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { normalizeMap, mapToCatalog, checkMap } from '../src/game/customMap.js';
import * as systems from '../worker/systems.js';
import * as factions from '../worker/factions.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};
const quietWarn = console.warn;
const quietError = console.error;
const hush = () => { console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.warn = quietWarn; console.error = quietError; };

const Y = (m, c, s) => ({ metal: m, credits: c, science: s });
let n = 0;
const body = (b) => ({ id: `r${(n++).toString(36)}`, rings: false, start: false, secret: null, yields: Y(3, 3, 3), angle: 0, ...b });

// ---- 1. the moon clamp ------------------------------------------------------
{
  // A planet with two moons, six rocks and a small dwarf right beside it.
  const home = body({ name: 'Hearth', type: 'terrestrial', parent: 'sun', orbit: 500, radius: 3, start: true });
  const map = normalizeMap({
    name: 'Rocky', sun: { name: 'Kel', size: 50, mass: 1 },
    bodies: [
      home,
      body({ name: 'Moona', type: 'moon', parent: home.id, orbit: 24, radius: 1.2 }),
      body({ name: 'Moonb', type: 'moon', parent: home.id, orbit: 38, radius: 1.2 }),
      ...[0, 1, 2, 3, 4, 5].map(k => body({ name: `Grit${k}`, type: 'rock', parent: 'sun', orbit: 503 + k, angle: k, mineral: { kind: 'metal', tons: 1000 } })),
      body({ name: 'Away', type: 'terrestrial', parent: 'sun', orbit: 1400, radius: 3, start: true }),
    ],
  });
  const raw = mapToCatalog(map);
  hush();
  const custom = factions.effectiveMoonScale(1, 1, raw, { custom: true });
  const customWide = factions.effectiveMoonScale(3, 1, raw, { custom: true });
  const solCeiling = factions.moonScaleCeiling(1);
  loud();
  check('1 rocks beside a moon-bearing planet leave moon_scale at 1', custom === 1, `got ${custom}`);
  check('1 a dial can still spread a custom map\'s moons', customWide === 3, `got ${customWide}`);
  // Sol: the shipped rule, recomputed here the old way.
  const reach = factions.moonReachByParent ? factions.moonReachByParent(factions.BODY_CATALOG) : null;
  if (reach) {
    const solid = factions.BODY_CATALOG.filter(b => b.parent === 'sol' && b.orbit_radius > 0 && b.type !== 'asteroid' && !b.far_system);
    let old = Infinity;
    for (const p of solid) {
      if (!reach[p.id]) continue;
      let near = Infinity;
      for (const o of solid) if (o.id !== p.id && o.orbit_radius !== p.orbit_radius) near = Math.min(near, Math.abs(o.orbit_radius - p.orbit_radius));
      if (Number.isFinite(near)) old = Math.min(old, (near * 0.9) / reach[p.id]);
    }
    check('1 Sol\'s moon ceiling is unchanged', old === solCeiling, `${old} vs ${solCeiling}`);
  }
  // In a seeded game every moon sits outside its planet.
  hush();
  const r = await runGame({ ticks: 1, players: 2, seed: 'cmr-moons', quiet: true, customMap: map, config: { moon_scale: 1 } });
  loud();
  const rows = (await r.env.DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(r.gameId).all()).results;
  const byId = new Map(rows.map(b => [b.id, b]));
  const moons = rows.filter(b => b.type === 'moon');
  const sunk = moons.filter(m => m.orbit_radius - m.radius < (byId.get(m.parent_body_id)?.radius ?? 0));
  check('1 no seeded moon sits inside its planet', moons.length === 2 && sunk.length === 0,
    moons.map(m => `${m.name} r${m.orbit_radius}`).join(', '));
  check('1 the seeded moons keep their authored orbits', moons.every(m => [24, 38].includes(Math.round(m.orbit_radius))),
    moons.map(m => m.orbit_radius).join(', '));
  // The checklist names worlds whose moon systems overlap at scale 1.
  const twin = normalizeMap({
    name: 'Twin', bodies: [
      { id: 'pa', name: 'Pa', type: 'terrestrial', parent: 'sun', orbit: 1000, start: true },
      { id: 'ma', name: 'Ma', type: 'moon', parent: 'pa', orbit: 100 },
      { id: 'pb', name: 'Pb', type: 'terrestrial', parent: 'sun', orbit: 1080, start: true },
    ],
  });
  check('1 checkMap warns when two moon systems overlap', checkMap(twin).some(i => i.code === 'moons_overlap'));
}

// ---- 2. belts and start-sharing groups -------------------------------------------
{
  const G = 'g';
  const row = (id, name, type, parent, r) => ({
    id: `${G}:${id}`, template_id: id, name, type, parent_body_id: parent ? `${G}:${parent}` : null,
    orbit_radius: r, orbit_period: 100, owner_faction_id: null, obliterated_at_tick: null, look_json: null,
  });
  const custom = [
    row('sol', 'Kel', 'star', null, 0),
    row('cm_p', 'Hearth', 'terrestrial', 'sol', 300),
    row('cm_d1', 'Dwarfa', 'dwarf', 'sol', 800),
    row('cm_d2', 'Dwarfb', 'dwarf', 'sol', 2000),
    row('cm_d3', 'Dwarfc', 'dwarf', 'sol', 5000),
    row('cm_a1', 'Asta', 'asteroid', 'sol', 1000),
    row('cm_a2', 'Astb', 'asteroid', 'sol', 1050),
    row('cm_a3', 'Astc', 'asteroid', 'sol', 1100),
    row('cm_b1', 'Pair1', 'asteroid', 'sol', 3000),
    row('cm_b2', 'Pair2', 'asteroid', 'sol', 3100),
  ];
  const root = systems.makeSystemRootOf(custom);
  const dw = ['cm_d1', 'cm_d2', 'cm_d3'].map(t => root(`${G}:${t}`));
  check('2 each dwarf is its own system on a custom map', new Set(dw).size === 3 && dw.every((x, i) => x === `${G}:cm_d${i + 1}`), dw.join(', '));
  const belts = systems.findBelts(custom);
  check('2 three asteroids make one belt, two make none', belts.length === 1 && belts[0].members.length === 3 && belts[0].label === 'Asteroid Belt',
    JSON.stringify(belts.map(b => [b.label, b.members.map(m => m.name)])));
  check('2 a lone asteroid pair is not a belt', root(`${G}:cm_b1`) === `${G}:cm_b1`);
  // Sol: dwarfs past Neptune still make the Kuiper Belt.
  const solRows = factions.BODY_CATALOG.filter(b => !b.far_system).map(b => row(b.id, b.name, b.type, b.parent, b.orbit_radius));
  const solBelts = systems.findBelts(solRows).map(b => b.label);
  check('2 Sol keeps its Kuiper Belt and Asteroid Belt', solBelts.includes('Kuiper Belt') && solBelts.includes('Asteroid Belt'), solBelts.join(', '));
  // The checklist: a start dwarf on a start planet's ring shares its system.
  const ring = normalizeMap({
    name: 'Ring', bodies: [
      { id: 'pa', name: 'Pa', type: 'terrestrial', parent: 'sun', orbit: 600, start: true, yields: Y(3, 3, 3) },
      { id: 'da', name: 'Da', type: 'dwarf', parent: 'sun', orbit: 610, angle: 3, radius: 2, start: true, yields: Y(3, 3, 3) },
      { id: 'pb', name: 'Pb', type: 'terrestrial', parent: 'sun', orbit: 2000, start: true, yields: Y(3, 3, 3) },
    ],
  });
  const close = checkMap(ring).find(i => i.code === 'starts_close');
  check('2 checkMap warns when a start world shares a start planet\'s ring', !!close && close.bodyIds.includes('da') && close.bodyIds.includes('pa'),
    JSON.stringify(close?.params));
}

// ---- 3. discoveries left to chance ----------------------------------------------
{
  const catalog = Array.from({ length: 400 }, (_, i) => ({
    id: `cm_x${i}`, type: ['terrestrial', 'moon', 'dwarf', 'asteroid', 'gas-giant'][i % 5], custom_secret: 'random',
  }));
  let s = 1;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = factions.customMapSecrets(catalog, new Map(), rand);
  const prizes = [...out.values()].filter(k => ['ancient_capital', 'ancient_station', 'deep_cache'].includes(k));
  check('3 a random discovery never rolls a Far Reach prize', prizes.length === 0, `${prizes.length} of ${out.size}: ${[...new Set(prizes)].join(', ')}`);
  const placed = factions.customMapSecrets([{ id: 'cm_y', type: 'dwarf', custom_secret: 'ancient_capital' }], new Map(), rand);
  check('3 a hand-placed prize is kept', placed.get('cm_y') === 'ancient_capital');
}

// ---- 4, 6, 7, 8, 9, 12: one seeded custom game --------------------------------------------
{
  const home = body({ name: 'Aurel', type: 'terrestrial', parent: 'sun', orbit: 400, radius: 3, start: true });
  const giant = body({ name: 'Colossus', type: 'gas-giant', parent: 'sun', orbit: 1200, radius: 8 });
  const map = normalizeMap({
    name: 'Ardent', sun: { name: 'Ardent', color: '#7fd4ff', size: 50, mass: 2 },
    bodies: [
      home,
      giant,
      body({ name: 'Vesk', type: 'terrestrial', parent: 'sun', orbit: 950, radius: 3, start: true }),
      body({ name: 'Farhold', type: 'dwarf', parent: 'sun', orbit: 3000, radius: 2, start: true }),
      body({ name: 'Shard1', type: 'asteroid', parent: 'sun', orbit: 2000, radius: 0.7 }),
      body({ name: 'Shard2', type: 'asteroid', parent: 'sun', orbit: 2050, radius: 0.7 }),
      body({ name: 'Shard3', type: 'asteroid', parent: 'sun', orbit: 2100, radius: 0.7 }),
    ],
  });
  const raw = mapToCatalog(map);
  // Guarded so the sim also runs (and fails) against the code before the fix.
  const edge = factions.customBeltRadius ?? (() => NaN);
  check('4 a custom map\'s belt edge is its outermost planet', edge(raw, 2) === 2400, String(edge(raw, 2)));
  check('4 a map with no planets has no speed-up edge', edge(raw.filter(b => b.type !== 'terrestrial' && b.type !== 'gas-giant'), 1) === Infinity);

  hush();
  const r = await runGame({ ticks: 1, players: 3, seed: 'cmr-game', quiet: true, customMap: map, config: { outer_orbit_speedup: 4 } });
  loud();
  const { env, gameId } = r;
  const DB = env.DB;
  const rows = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(gameId).all()).results;
  const tpl = (name) => rows.find(b => b.name === name);
  const want = (name) => raw.find(b => b.name === name).orbit_period;
  // Vesk (950) sits inside Colossus (1200) but past Sol's Ceres edge (720),
  // which used to speed it up. Farhold (3000) is past the last planet.
  const ratio = (name) => want(name) / tpl(name).orbit_period;
  check('4 a world inside the outermost planet keeps its year', Math.abs(ratio('Vesk') - 1) < 1e-9 && Math.abs(ratio('Aurel') - 1) < 1e-9,
    `Vesk x${ratio('Vesk')}, Aurel x${ratio('Aurel')}`);
  check('4 a world past the outermost planet runs 4x faster', Math.abs(ratio('Farhold') - 4) < 1e-9, `x${ratio('Farhold')}`);

  // 6: the star's label.
  const sys = systems.summarizeSystems(rows);
  const starSys = sys.find(s => s.rootId === `${gameId}:sol`);
  check('6 the custom star is called its name', !!starSys && starSys.label === 'Ardent' && !sys.some(s => s.label === 'The Core'),
    sys.map(s => s.label).join(', '));

  // 12: the star's mu.
  const star = rows.find(b => b.type === 'star');
  const SOL_MU = 4 * Math.PI * Math.PI * Math.pow(460, 3) / Math.pow(800, 2);
  check('12 the custom star carries Sol\'s mu x its mass', Math.abs(star.mu - SOL_MU * 2) < 1e-6, String(star.mu));

  // 9: default names.
  const facs = (await DB.prepare('SELECT f.name, b.name AS cap FROM game_factions f JOIN game_bodies b ON b.id = f.capital_body_id WHERE f.game_id = ?').bind(gameId).all()).results;
  check('9 default empire names come from the capital', facs.length === 3 && facs.every(f => f.name === `House of ${f.cap}`),
    facs.map(f => `${f.name} @ ${f.cap}`).join('; '));

  // 7: the Herald strip.
  const strip = await import('../worker/heraldStrip.js');
  const data = await strip.buildTerritoryData(env, gameId);
  check('7 the Herald strip names the star in its own colour', data.starName === 'ARDENT' && data.starColor === '#7fd4ff',
    `${data.starName} ${data.starColor}`);
  const page = strip.renderStripPage(data);
  check('7 the strip page carries the star name', page.includes('"starName":"ARDENT"'));
  let png = null;
  try { png = await strip.renderStripPng(env, gameId, { data }); } catch (e) { png = e; }
  check('7 the strip PNG renders with the custom star', png instanceof Uint8Array && png.length > 1000, String(png?.message ?? png?.length));

  // 8: the locator.
  const digest = await import('../worker/digest.js');
  const ids = ['Farhold', 'Shard2', 'Aurel'].map(nm => tpl(nm).id);
  const loc = digest.buildBodyLocator ? await digest.buildBodyLocator(env, gameId, ids) : new Map();
  const full = ids.map(id => loc.get(id)?.full ?? '');
  check('8 the locator never says Kuiper Belt on a custom map', full.every(f => !/Kuiper/.test(f)), full.join(' | '));
  check('8 an asteroid is placed in its belt', /in the \*\*Asteroid Belt\*\*/.test(full[1]), full[1]);
  check('8 a lone dwarf is named alone', full[0] === '**Farhold**', full[0]);
}

// ---- Sol control: the same surfaces, unchanged --------------------------------------
{
  hush();
  const r = await runGame({ ticks: 1, players: 3, seed: 'cmr-sol', quiet: true });
  loud();
  const { env, gameId } = r;
  const rows = (await env.DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(gameId).all()).results;
  const star = rows.find(b => b.type === 'star');
  check('Sol: the star is seeded with mu 0, as before', star.mu === 0, String(star.mu));
  const sys = systems.summarizeSystems(rows);
  check('Sol: The Core is still The Core', sys.some(s => s.label === 'The Core'));
  const facs = (await env.DB.prepare('SELECT name FROM game_factions WHERE game_id = ? ORDER BY slot').bind(gameId).all()).results;
  check('Sol: default empire names are the stock list', facs.map(f => f.name).join('|') === 'Solar Directorate|Outer Alliance|Mars Combine',
    facs.map(f => f.name).join('|'));
  const strip = await import('../worker/heraldStrip.js');
  const data = await strip.buildTerritoryData(env, gameId);
  check('Sol: the strip still says SOL in stock gold', data.starName === null && data.starColor === null && strip.renderStripPage(data).includes('"SOL"'));
  const digest = await import('../worker/digest.js');
  const eris = rows.find(b => b.template_id === 'eris');
  const loc = digest.buildBodyLocator ? await digest.buildBodyLocator(env, gameId, [eris.id]) : new Map();
  check('Sol: a far dwarf is still in the Kuiper Belt', loc.get(eris.id)?.full === '**Eris** in the **Kuiper Belt**', loc.get(eris.id)?.full);
}

// ---- 5. a custom room whose map will not load ------------------------------------
{
  const { roomCustomMap } = await import('../worker/customMaps.js');
  const lobby = await import('../worker/lobby.js');
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: {
      idFromName: (x) => ({ toString: () => x }),
      get: () => ({ fetch: async (url) => (String(url).includes('/settings')
        ? new Response(JSON.stringify({ tick_interval_ms: 3600000 }), { headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 204 })) }),
    },
  };
  const now = Date.now();
  for (const u of ['u1', 'u2']) {
    await DB.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)").bind(u, `${u}@example.invalid`, u, now).run();
  }
  const room = async (id, mapId, json) => {
    await DB.prepare(`INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at, custom_map_id, custom_map_json)
      VALUES (?, ?, 'u1', 'lobby', 4, ?, ?, ?, ?)`).bind(id, id, now, now, mapId, json).run();
    for (const u of ['u1', 'u2']) await DB.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').bind(id, u, now).run();
  };
  await room('plainroom001', null, null);
  await room('brokenroom01', 'map_x', '{"name": "half a map"');
  await room('missingroom1', 'map_y', null);
  check('5 a room with no custom map has none', (await roomCustomMap(env, 'plainroom001')) === null);
  let threw = null;
  try { await roomCustomMap(env, 'brokenroom01'); } catch (e) { threw = e; }
  check('5 a broken snapshot throws instead of reading as Sol', !!threw, 'returned without throwing');
  threw = null;
  try { await roomCustomMap(env, 'missingroom1'); } catch (e) { threw = e; }
  check('5 a custom room with no snapshot throws', !!threw);
  hush();
  const res = await lobby.startGame(env, 'brokenroom01');
  loud();
  const status = (await DB.prepare('SELECT status FROM rooms WHERE id = ?').bind('brokenroom01').first())?.status;
  const bodies = (await DB.prepare('SELECT COUNT(*) c FROM game_bodies WHERE game_id = ?').bind('brokenroom01').first())?.c;
  const game = await DB.prepare('SELECT id FROM games WHERE id = ?').bind('brokenroom01').first();
  check('5 the start fails and the lobby reopens, no Sol seeded', !!res.error && status === 'lobby' && bodies === 0 && !game,
    `error=${!!res.error} status=${status} bodies=${bodies} game=${!!game}`);
}

console.log(bad === 0 ? '\nALL CUSTOM-MAP RULE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
