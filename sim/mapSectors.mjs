// ============================================================
// AUTHORED SECTORS, end to end (Lorne, 2026-10-15): a custom map's
// sectors replace the automatic systems everywhere -- the senate, the
// faction roster, /state, the Herald -- on the real server code over an
// in-memory D1.
//
// The trap this guards: a sector travels in game_bodies.look_json, and a
// body row only carries look_json where a SELECT asks for it. A SELECT
// that forgets it silently turns the sectors back into automatic systems
// on that one surface, so the senate counts a different map from the
// one the outliner shows. Every SELECT that feeds a grouping is driven
// (or, where driving it needs a whole watch session, read) below.
//
// Run: node sim/mapSectors.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { normalizeMap, hostBlockers, mapToCatalog } from '../src/game/customMap.js';
import { summarizeSystems, voteWeights } from '../worker/systems.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- the map ---------------------------------------------------------------
// Two sectors: the Inner Reach (two start worlds, one with a moon) and the
// Shoals (a giant with two moons and three asteroids that would otherwise
// be a belt). One start world and a planet with a moon sit outside every
// band and keep the automatic grouping.
const w = (id, type, orbit, extra = {}) => ({
  id, type, orbit, parent: 'sun', name: id.toUpperCase(),
  yields: { metal: 4, credits: 4, science: 2 }, ...extra,
});
const map = normalizeMap({
  name: 'Sector Test',
  sun: { name: 'Helion' },
  bodies: [
    w('aa', 'terrestrial', 300, { start: true, name: 'Eirenos' }),
    w('ab', 'terrestrial', 450, { start: true, name: 'Neraphae' }),
    w('am', 'moon', 30, { parent: 'ab', name: 'Pell' }),
    w('ba', 'gas-giant', 1000, { name: 'Vastor' }),
    w('bm', 'moon', 60, { parent: 'ba', name: 'Ilo' }),
    w('bn', 'moon', 90, { parent: 'ba', name: 'Ama' }),
    w('r1', 'asteroid', 1100, { name: 'Shard' }),
    w('r2', 'asteroid', 1130, { name: 'Flake' }),
    w('r3', 'asteroid', 1160, { name: 'Grit' }),
    w('ca', 'terrestrial', 2000, { start: true, name: 'Loner' }),
    w('cb', 'terrestrial', 2600, { name: 'Far' }),
    w('cm', 'moon', 40, { parent: 'cb', name: 'Wisp' }),
  ],
  sectors: [
    { id: 'sinr', name: 'Inner Reach', color: '#4ecdc4', inner: 200, outer: 600 },
    { id: 'sshl', name: 'The Shoals', color: '#ffb84d', inner: 900, outer: 1300 },
  ],
});
check('the map keeps both sectors and can be hosted',
  map.sectors.length === 2 && hostBlockers(map).length === 0,
  `${map.sectors.length} sectors; ${hostBlockers(map).map(i => i.title).join('; ')}`);
const catalog = mapToCatalog(map);
check('the catalogue puts the sector on every world in a band, moons included',
  ['cm_aa', 'cm_ab', 'cm_am'].every(id => catalog.find(c => c.id === id)?.look?.sector?.id === 'sinr')
  && ['cm_ba', 'cm_bm', 'cm_bn', 'cm_r1', 'cm_r2', 'cm_r3'].every(id => catalog.find(c => c.id === id)?.look?.sector?.id === 'sshl')
  && ['sol', 'cm_ca', 'cm_cb', 'cm_cm'].every(id => !catalog.find(c => c.id === id)?.look?.sector));

// ---- a game seeded from it ---------------------------------------------------
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ORBITAL_ENV: 'staging' };
for (const u of ['u0', 'u1', 'u2']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?, ?, ?, 'x', 0)`)
    .bind(u, `${u}@t`, u.toUpperCase()).run();
}
const room = 'gsect1';
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at,custom_map_id,custom_map_json) VALUES (?, 'Sector game','u0',0,0,'m1',?)`)
  .bind(room, JSON.stringify(map)).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at) VALUES (?, 'setup','sect-seed',0,0)`).bind(room).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'cm_aa'), (?,?,1,'cm_ab'), (?,?,2,'cm_ca')`)
  .bind(room, 'u0', room, 'u1', room, 'u2').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, room);
await DB.prepare(`UPDATE games SET status = 'active' WHERE id = ?`).bind(room).run();

const rows = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(room).all()).results;
const row = (tpl) => rows.find(r => r.template_id === tpl);
const sectorOfRow = (tpl) => { try { return JSON.parse(row(tpl)?.look_json ?? '{}').sector ?? null; } catch { return null; } };
check('look_json carries the sector on every world in a band, moons included',
  ['cm_aa', 'cm_ab', 'cm_am'].every(t => sectorOfRow(t)?.name === 'Inner Reach' && sectorOfRow(t)?.color === '#4ecdc4')
  && ['cm_ba', 'cm_bm', 'cm_bn', 'cm_r1', 'cm_r2', 'cm_r3'].every(t => sectorOfRow(t)?.name === 'The Shoals'),
  rows.map(r => `${r.template_id}:${r.look_json}`).join('\n        '));
check('...and on nothing outside one', ['sol', 'cm_ca', 'cm_cb', 'cm_cm'].every(t => row(t) && !sectorOfRow(t)));

// Ownership, set by hand so the arithmetic is known. Settlements cleared:
// the Herald falls back to them where a body has no owner.
const fids = Object.fromEntries((await DB.prepare('SELECT user_id, id FROM game_factions WHERE game_id = ?').bind(room).all())
  .results.map(r => [r.user_id, r.id]));
const [A, B, C] = [fids.u0, fids.u1, fids.u2];
await DB.prepare('DELETE FROM game_settlements WHERE game_id = ?').bind(room).run();
await DB.prepare('UPDATE game_bodies SET owner_faction_id = NULL WHERE game_id = ?').bind(room).run();
const own = async (tpl, fid) => DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE game_id = ? AND template_id = ?')
  .bind(fid, room, tpl).run();
// Inner Reach: A holds all three. Automatically that would be TWO
// systems (Eirenos; Neraphae + Pell); as a sector it is one.
await own('cm_aa', A); await own('cm_ab', A); await own('cm_am', A);
// The Shoals: A one rock, B one rock -> a tie, worth nothing.
await own('cm_r1', A); await own('cm_r2', B);
// Loner (automatic, a world of its own): C.
await own('cm_ca', C);

// ---- the senate ----------------------------------------------------------------
const { voteWeightDetail } = await import('../worker/senate.js');
const detailA = await voteWeightDetail(env, room, A);
const detailB = await voteWeightDetail(env, room, B);
check('the senate counts a sector as a system: most of its worlds is +1',
  detailA.weight === 2 && detailA.controlled.map(c => c.label).join() === 'Inner Reach',
  JSON.stringify(detailA));
check('...and a tied sector is contested and worth nothing',
  detailB.weight === 1 && detailB.contesting.some(c => c.label === 'The Shoals' && c.contested)
  && detailA.contesting.some(c => c.label === 'The Shoals' && c.contested),
  JSON.stringify(detailB));
check('...while a world outside every band is still its own automatic system',
  (await voteWeightDetail(env, room, C)).controlled.map(c => c.label).join() === 'Loner');
// The same rows WITHOUT look_json: the automatic map the senate would have
// counted. Proves the sectors are what moved the number.
const freshRows = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(room).all()).results;
const auto = voteWeights(freshRows.map(({ look_json, ...r }) => r), [A, B, C]);
const sect = voteWeights(freshRows, [A, B, C]);
check('sectors change the vote: without them A would hold Eirenos and Neraphae as two systems',
  auto.get(A) === 3 && sect.get(A) === 2, `auto ${auto.get(A)} vs sectors ${sect.get(A)}`);
const labels = summarizeSystems(freshRows).map(s => s.label).sort();
check('the systems are the two sectors plus the automatic rest',
  labels.includes('Inner Reach') && labels.includes('The Shoals') && labels.includes('Loner') && labels.includes('Far System')
  && !labels.includes('Vastor System') && !labels.some(l => /Belt/.test(l)),
  labels.join(', '));

// ---- /state: every faction's senate weight ------------------------------------
const { routes: stateRoutes } = await import('../worker/state.js');
const stateRoute = stateRoutes.find(r => r.method === 'GET' && r.pattern.test(`/api/games/${room}/state`));
const stRes = await stateRoute.handle(new Request(`https://x/api/games/${room}/state`), env,
  { session: { user_id: 'u0' }, params: { gameId: room } });
const st = await stRes.json();
const weightIn = (fid) => (st.factions ?? []).find(f => f.id === fid)?.senate_weight;
check('/state scores the senate by sector', stRes.ok && weightIn(A) === 2 && weightIn(B) === 1 && weightIn(C) === 2,
  `${stRes.status} A=${weightIn(A)} B=${weightIn(B)} C=${weightIn(C)}`);
const stBody = (st.bodies ?? []).find(b => String(b.id).endsWith(':cm_am') || b.id === 'cm_am');
check('...and sends each body its sector in look_json for the client',
  stBody && JSON.parse(stBody.look_json ?? '{}').sector?.id === 'sinr', JSON.stringify(stBody?.look_json));

// ---- the faction roster ---------------------------------------------------------
const listRoute = factions.routes.find(r => r.method === 'GET' && String(r.pattern) === String(/^\/api\/games\/(?<gameId>[^/]+)\/factions$/));
const lsRes = await listRoute.handle(new Request(`https://x/api/games/${room}/factions`), env,
  { session: { user_id: 'u0' }, params: { gameId: room } });
const ls = await lsRes.json();
const roster = (Array.isArray(ls) ? ls : ls.factions) ?? [];
const fa = roster.find(f => f.id === A);
check('the roster counts systems by sector', fa?.systems_owned === 1 && fa?.systems_total === labels.length,
  `${lsRes.status} owned ${fa?.systems_owned} total ${fa?.systems_total} of ${labels.length}`);

// ---- the Herald ---------------------------------------------------------------
const { buildTerritoryData } = await import('../worker/heraldStrip.js');
const herald = await buildTerritoryData(env, room);
const cols = herald.sectors.map(s => s.label);
check('the Herald strip shows each sector as one column, named for it',
  cols.filter(l => l === 'Inner Reach').length === 1 && cols.filter(l => l === 'The Shoals').length === 1
  && !cols.includes('EIRENOS') && !cols.includes('Eirenos') && !cols.includes('Vastor') && !cols.some(l => /Belt/.test(l)),
  cols.join(' | '));
const shoals = herald.sectors.find(s => s.label === 'The Shoals');
check('...holding its worlds and their moons',
  shoals?.bodies.length === 4 && shoals?.moons.length === 2
  && herald.sectors.find(s => s.label === 'Inner Reach')?.bodies.length === 2
  && herald.sectors.find(s => s.label === 'Inner Reach')?.moons.length === 1,
  JSON.stringify(shoals));
check('...in order out from the sun, among the automatic columns',
  cols.indexOf('Inner Reach') < cols.indexOf('The Shoals') && cols.indexOf('The Shoals') < cols.indexOf('Loner')
  && cols.indexOf('Loner') < cols.indexOf('Far'), cols.join(' | '));

const { renderStripPng, renderStripPage } = await import('../worker/heraldStrip.js');
const png = await renderStripPng(env, room, { data: herald, width: 550, height: 440 });
const html = renderStripPage(herald, { width: 1200, height: 420 });
check('...and both renderers draw it', png?.byteLength > 1000 && html.includes('Inner Reach') && html.includes('The Shoals'),
  `png ${png?.byteLength}`);

// ---- every SELECT that feeds a grouping asks for look_json ----------------------
// Driven above: senate.js bodiesForWeight, state.js sensorBodies, factions.js
// countSystemsPerFaction, heraldStrip.js. The watch's needs a paired
// device and a whole session, so its SELECT is read instead.
const wearSrc = readFileSync(new URL('../worker/wearWorlds.js', import.meta.url), 'utf8');
const wearSelect = wearSrc.match(/SELECT id, template_id, name, type, parent_body_id, radius[\s\S]*?FROM game_bodies/)?.[0] ?? '';
check("the watch's systems read look_json too", /look_json/.test(wearSelect), wearSelect.slice(0, 200));

console.log(bad === 0 ? '\nALL MAP-SECTOR CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
