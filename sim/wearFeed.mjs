// ============================================================
// WEAR FEED -- what worlds.json now carries for the watch, and the
// face map drawn from it.
//
// Runs the real wearWorldsData against an in-memory D1 holding a small
// war, and checks the fields the watch app's phase-4 release reads:
//   - `art`, the art version the watch clears its picture caches on;
//   - `fx`, the combat tuning, which must be the game's own numbers;
//   - `hulls`, each class's default drawing, versioned;
//   - per hull `fk` (its flak mounts) and `fs` (enemy flak's hold on it);
// then renders the face map (worker/wearFace.js) from the same data with
// the real 48 px globes, and writes it out to look at.
//
// Run: npm run sim:wearfeed   (writes node_modules/.cache/wear-face.png)
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WASM_BYTES = readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
const ROOT = process.cwd();

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const G = 'g_feed';
const TICK = 300;

await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u1','a@t','A','x',0), ('u2','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Feed Test','u1',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,next_tick_at,created_at)
                  VALUES (?, 'active','s',?,?,0)`).bind(G, TICK, Date.now() + 20 * 60000).run();
await DB.prepare(`INSERT INTO game_factions
                    (id,game_id,slot,name,color,status,joined_at,user_id,metal,fuel,gold,science)
                  VALUES ('f1',?,0,'Alpha Concord','#4ecdc4','active',0,'u1',1,0,1,1),
                         ('f2',?,1,'Red Star','#ff5a4e','active',0,'u2',1,0,1,1)`)
  .bind(G, G).run();
await DB.prepare(`INSERT INTO game_wars (id,game_id,faction_a,faction_b,declared_by,declared_at_tick)
                  VALUES ('w12',?,'f1','f2','f2',0)`).bind(G).run();

// Real templates, so the systems and globes are the game's.
const body = (tpl, name, type, orbit, period, angle, owner, parent = 'sol') => DB.prepare(
  `INSERT INTO game_bodies (id,game_id,template_id,name,type,radius,mu,color,owner_faction_id,
     parent_body_id,orbit_radius,orbit_period,angle0)
   VALUES (?,?,?,?,?,1,1,'#8899aa',?,?,?,?,?)`)
  .bind(`${G}:${tpl}`, G, tpl, name, type, owner, parent ? `${G}:${parent}` : null, orbit, period, angle).run();
await body('sol', 'Sol', 'star', 0, 1, 0, null, null);
await body('mercury', 'Mercury', 'terrestrial', 39, 88, 0.4, null);
await body('venus', 'Venus', 'terrestrial', 72, 225, 2.1, 'f2');
await body('earth', 'Earth', 'terrestrial', 100, 365, 1.0, 'f1');
await body('mars', 'Mars', 'terrestrial', 152, 687, 3.9, 'f1');
await body('jupiter', 'Jupiter', 'gas-giant', 520, 4333, 5.2, 'f2');
await body('saturn', 'Saturn', 'gas-giant', 954, 10759, 0.7, null);
await body('neptune', 'Neptune', 'ice-giant', 3007, 60190, 2.6, null);

const ship = (id, owner, at, parts, cls = 'frigate') => DB.prepare(
  `INSERT INTO game_ships (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
     orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,fuel,fuel_max,hp,hp_max,status,built_at_tick,
     parts_json,last_combat_tick)
   VALUES (?,?,?,?,?,?,1,1,0,0,0,10,10,80,100,'active',0,?,?)`)
  .bind(id, G, owner, id, cls, `${G}:${at}`, JSON.stringify(parts), TICK).run();

// Over Mars: two of mine (one fitting flak twice) against two of theirs.
await ship('m1', 'f1', 'mars', ['flak', 'flak']);
await ship('m2', 'f1', 'mars', ['kinetic']);
await ship('r1', 'f2', 'mars', ['energy']);
await ship('r2', 'f2', 'mars', ['kinetic', 'shield']);
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,started_at_ms,status,faction_count)
   VALUES ('bat',?,?,'Mars',290,?,0,'active',2)`).bind(G, `${G}:mars`, TICK).run();
for (const [id, f] of [['m1', 'f1'], ['m2', 'f1'], ['r1', 'f2'], ['r2', 'f2']]) {
  await DB.prepare(
    `INSERT INTO battle_participants (battle_id,ship_id,faction_id,ship_name,ship_class,hp_max,hp_start,hp_end,first_tick,last_tick)
     VALUES ('bat',?,?,?,'frigate',100,100,80,290,?)`).bind(id, f, id, TICK).run();
}

const raster = await import('../worker/shipIconRaster.js');
raster.configureRasterizer(WASM_BYTES);
const { wearWorldsData } = await import('../worker/wearWorlds.js');
const { faceSvg, faceGlobeNames } = await import('../worker/wearFace.js');
const { rasterSvgPng } = await import('../worker/planetSprite.js');
const { FX_TUNING } = await import('../src/render/fxTuning.ts');
const { WEAR_ART_VERSION } = await import('../src/render/artVersion.ts');

const data = await wearWorldsData(env, 'u1');
check('the feed is live', data.state === 'live', JSON.stringify(data).slice(0, 200));

// ---- the new top-level fields ----
check('it names the art version the watch keys its caches on', data.art === WEAR_ART_VERSION, data.art);
check("its combat tuning IS the game's (one source, not a copy)", data.fx === FX_TUNING
  || JSON.stringify(data.fx) === JSON.stringify(FX_TUNING));
check('...including the slowed fire rate', data.fx.beatMs === 2400 && data.fx.boltMs === 750, `${data.fx.beatMs}/${data.fx.boltMs}`);
check('the tuning survives the trip as JSON the watch parses', (() => {
  const back = JSON.parse(JSON.stringify(data.fx));
  return back.kinetic.glow === FX_TUNING.kinetic.glow && back.v === FX_TUNING.v;
})());
check('every class has a default hull, versioned',
  ['corvette', 'frigate', 'destroyer', 'freighter', 'colony', 'mega_destroyer', 'mobile_foundry']
    .every(c => (data.hulls?.[c] ?? '').startsWith(`${c}:`) && data.hulls[c].includes(`~${WEAR_ART_VERSION}:green`)),
  JSON.stringify(data.hulls));

// ---- flak ----
const mars = data.worlds.find(w => w.name === 'Mars');
check('Mars is in the feed with its four hulls', mars?.ships?.length === 4, JSON.stringify(mars?.ships?.map(s => s.id)));
const by = Object.fromEntries((mars?.ships ?? []).map(s => [s.id, s]));
check('a hull carries its flak mounts', by.m1?.fk === 2 && by.m2?.fk === 0, `m1 ${by.m1?.fk}, m2 ${by.m2?.fk}`);
// Two enemy mounts: 0.95^2 = 0.9025, so (1 - 0.9025) / 0.5 = 0.195.
check("an enemy hull feels that flak, by the server's own rule", Math.abs((by.r1?.fs ?? 0) - 0.2) < 0.011,
  `r1 fs=${by.r1?.fs}`);
check('...and so does every enemy in the orbit', (by.r2?.fs ?? 0) > 0, `r2 fs=${by.r2?.fs}`);
check('my own flak never slows my own hulls', by.m1?.fs === undefined && by.m2?.fs === undefined,
  `m1 ${by.m1?.fs}, m2 ${by.m2?.fs}`);

// ---- the face ----
const names = faceGlobeNames(data);
check('the face asks for Sol and the worlds that have globes', names.includes('sol') && names.includes('earth') && names.includes('jupiter'),
  names.join(','));
const globes = new Map();
for (const n of names) {
  const p = path.join(ROOT, 'public', 'globes-png', 's', `${n}.png`);
  if (existsSync(p)) globes.set(n, readFileSync(p).toString('base64'));
}
check('48 px globe copies exist (scripts/globe-pngs.mjs ran)', globes.has('earth') && globes.has('sol'));
const svg = faceSvg(data, 320, globes);
check('the face draws worlds from their globes', (svg.match(/<image /g) ?? []).length >= 6,
  `${(svg.match(/<image /g) ?? []).length} images`);
check('the face rings a battlefield', svg.includes('stroke="#ff6a60"'));
const png = await rasterSvgPng(svg, 320);
check('the face rasterises to a PNG', png && png[1] === 0x50 && png.length > 4000, `bytes ${png?.length}`);
const empty = faceSvg({ systems: [], factions: {} }, 320);
check('a feed with no systems still draws (no NaN)', !empty.includes('NaN'));
const geometry = svg.replace(/base64,[^"]*/g, '');
check('the face has no NaN anywhere (its geometry; base64 can spell it)', !geometry.includes('NaN'));
mkdirSync(path.join(ROOT, 'node_modules', '.cache'), { recursive: true });
if (png) writeFileSync(path.join(ROOT, 'node_modules', '.cache', 'wear-face.png'), png);

console.log(bad ? `\n${bad} FAILED` : '\nALL WEAR FEED CHECKS PASS');
process.exit(bad ? 1 : 0);
