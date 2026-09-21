// ============================================================
// The asteroid RAM must be priced and timed by the SERVER.
//
// handleRamAsteroid used to debit exactly the metal_cost it was sent and
// store exactly the arrive_tick it was sent, checking only that
// acceleration > 0 and metal_cost >= 0. A crafted POST fired a ram for
// 0 metal, at any acceleration, landing on any tick after start — and
// impact keys off ram_arrive_tick alone.
//
// This drives the REAL handler twice over:
//   - honest plans, built by the REAL client planner (planTorchTransfer
//     at the same accel BodyInspector uses) against several targets,
//     must still be accepted and charged exactly the quoted metal;
//   - crafted plans (0 metal, huge acceleration, instant arrival,
//     mismatched Δv) must be rejected with no metal taken.
//
// Run: npm run sim:ram
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes } from '../worker/actions.js';
import { planTorchTransfer, fromG } from '../src/physics/torchTransfer.ts';

// Client constants (src/components/BodyInspector.tsx). Not exported
// there, so mirrored — the point is to replay what the client sends.
const RAM_METAL_PER_DV = 50;
const RAM_ASTEROID_G = 0.005;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

async function callRoute(env, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle(
      { json: async () => body, headers: new Map() },
      env,
      { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } },
    );
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route for ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB,
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
};
const G = 'gramauth';
await DB.prepare(
  `INSERT INTO users (id,email,display_name,password_hash,created_at)
   VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(
  `INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'R','uA',0,0)`).bind(G).run();
await DB.prepare(
  `INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
   VALUES (?, 'setup','r-seed',40,3600000,0,0)`).bind(G).run();
await DB.prepare(
  `INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
   VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

const A = (await DB.prepare(
  'SELECT id, engine_g FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results[0];
const ROCK = `${G}:styx_rock`;
await DB.prepare(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max,
     created_at_tick, buildings_json)
   VALUES ('s_ram', ?, ?, ?, 'city', 'Launchpad', 100, 100, 0, '{"trajectory_thrusters":1}')`,
).bind(G, ROCK, A.id).run();

// Client-shape bodies, as MultiplayerGameProvider.bodyToClient maps them.
const rows = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(G).all()).results;
const strip = (id) => (id == null ? undefined : id.slice(id.indexOf(':') + 1));
const bodies = rows.map(b => ({
  id: strip(b.id), name: b.name, type: b.type, parent: strip(b.parent_body_id),
  orbitRadius: b.orbit_radius ?? 0, orbitPeriod: b.orbit_period ?? 0, angle0: b.angle0 ?? 0,
  orbit_rp: b.orbit_rp ?? undefined, orbit_ra: b.orbit_ra ?? undefined,
  orbit_omega: b.orbit_omega ?? undefined, orbit_m0: b.orbit_m0 ?? undefined,
}));
const { bodyPosition } = await import('../src/physics/orbitalMechanics.ts');

const NOW = 40;
const pool = async () => (await DB.prepare('SELECT metal FROM game_factions WHERE id = ?').bind(A.id).first()).metal;
const bank = (m) => DB.prepare('UPDATE game_factions SET metal = ? WHERE id = ?').bind(m, A.id).run();
const unram = () => DB.prepare(
  `UPDATE game_bodies SET ram_target_body_id = NULL, ram_arrive_tick = NULL WHERE id = ?`).bind(ROCK).run();

// Exactly what RamControlsSection computes and mpActions.ram posts.
function clientPlan(targetLocalId, g, tick = NOW) {
  const rock = bodies.find(b => b.id === 'styx_rock');
  const dh = 0.01;
  const p1 = bodyPosition(rock, tick - dh, bodies);
  const p2 = bodyPosition(rock, tick + dh, bodies);
  const pos = bodyPosition(rock, tick, bodies);
  const vel = { x: (p2.x - p1.x) / (2 * dh), y: (p2.y - p1.y) / (2 * dh) };
  const a = fromG(g);
  const plan = planTorchTransfer({ pos, vel }, targetLocalId, a, a, tick, bodies);
  return {
    target_body_id: `${G}:${targetLocalId}`,
    start_tick: plan.startTick, flip_tick: plan.flipTick, arrive_tick: plan.arriveTick,
    acceleration: plan.acceleration,
    start_pos_x: plan.startPos.x, start_pos_y: plan.startPos.y,
    start_vel_x: plan.startVel.x, start_vel_y: plan.startVel.y,
    intercept_pos_x: plan.interceptPos.x, intercept_pos_y: plan.interceptPos.y,
    total_dv: plan.totalDv,
    metal_cost: Math.ceil(plan.totalDv * RAM_METAL_PER_DV),
  };
}
const ram = (payload) => callRoute(env, 'POST', `/api/games/${G}/bodies/${ROCK}/ram`, 'uA', payload);

// --- 1. Honest plans still go through, charged exactly the quote ----
// Both accels an honest client can send: the documented asteroid g
// (what MP actually uses — factions there carry no engineG) and the
// faction's engine_g (the `??`'s left operand).
for (const g of [RAM_ASTEROID_G, A.engine_g ?? 0.05]) {
  for (const t of ['mars', 'earth', 'jupiter', 'luna', 'sol', 'iron_anna', 'black_sky', 'vagrant']) {
    await unram();
    await bank(1e9);
    const p = clientPlan(t, g);
    const before = await pool();
    const res = await ram(p);
    const charged = before - await pool();
    check(`honest ram styx->${t} @${g}g accepted, charged ${p.metal_cost}`,
      res.status === 201 && charged === p.metal_cost,
      `status ${res.status} ${JSON.stringify(res.body).slice(0, 160)} charged ${charged}`);
  }
}

// --- 2. Crafted plans are rejected and take nothing ------------------
const crafted = [];
{
  const p = clientPlan('mars', RAM_ASTEROID_G);
  // The headline exploit: free, and effectively instant.
  const a = 1e6;
  crafted.push(['metal_cost 0 + huge acceleration', {
    ...p, acceleration: a, flip_tick: NOW + 0.5, arrive_tick: NOW + 1,
    total_dv: 0, metal_cost: 0 }]);
  // Honest acceleration, but free.
  crafted.push(['honest plan with metal_cost 0', { ...p, metal_cost: 0 }]);
  // Honest price for a lie: total_dv under-reported to match metal 0.
  crafted.push(['total_dv understated to make it cheap', { ...p, total_dv: 0.001, metal_cost: 1 }]);
  // Self-consistent (dv = a·T, price = ceil(dv·50)) but lands next tick.
  const T = 1;
  crafted.push(['consistent dv/price but arrives next tick', {
    ...p, flip_tick: NOW + T / 2, arrive_tick: NOW + T,
    total_dv: p.acceleration * T, metal_cost: Math.ceil(p.acceleration * T * RAM_METAL_PER_DV) }]);
  // Faster than any honest client (1000x asteroid g, 100x engine_g),
  // with dv and price consistent for the claimed times.
  const fastA = p.acceleration * 1000;
  const fastT = 2 * Math.sqrt(1e5 / fastA);
  crafted.push(['acceleration above the faction ceiling', {
    ...p, acceleration: fastA, flip_tick: NOW + fastT / 2, arrive_tick: NOW + fastT,
    total_dv: fastA * fastT, metal_cost: Math.ceil(fastA * fastT * RAM_METAL_PER_DV) }]);
}
for (const [label, payload] of crafted) {
  await unram();
  await bank(1e9);
  const res = await ram(payload);
  const after = await pool();
  const row = await DB.prepare('SELECT ram_target_body_id FROM game_bodies WHERE id = ?').bind(ROCK).first();
  check(`rejects: ${label}`,
    res.status === 400 && after === 1e9 && row.ram_target_body_id == null,
    `status ${res.status} ${JSON.stringify(res.body).slice(0, 160)} metal ${after} ram ${row.ram_target_body_id}`);
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
