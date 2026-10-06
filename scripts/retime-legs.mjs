// ============================================================
// retime-legs — re-time every live leg flown on an older burn as if it
// had launched with today's (worker/burn.js: the push builds 0.05g -> 1g
// over 48 ticks, then a 9x brake).
//
//   node scripts/retime-legs.mjs <env>            dry run, every active game
//   node scripts/retime-legs.mjs <env> --apply
//
// WHY. Each leg keeps the burn it was committed with (accel, brake_accel,
// accel_ramp, migrations 0088 / 0155 / 0158), so the faster burn only
// reached orders given after it shipped. Lorne, 2026-10-06: "retime
// everything in flight".
//
// HOW. A leg keeps its launch point and launch tick, so it stays on its
// own line and the player sees it further along it, never jumping back.
// Its arrival becomes launch + the new burn's trip time (never earlier
// than next tick), and the stored plan is re-fitted to that arrival with
// shapeForArrival — the same back-solve the server uses for trade legs.
// It is applied only when it lands SOONER — unless --allow-later, which
// also moves legs whose old burn was FASTER than today's (the linear
// build-up flown for a few hours on 2026-10-06 beat the exponential one
// that replaced it). A later leg is drawn further back along its line.
//
// "Old" means anything not on today's burn exactly (see isCurrent): flat,
// linear, or exponential from a different floor. An old leg is re-flown
// from today's floor with its hull's engine parts carried over.
//
//   - Hulls moving together (a fleet, an escort paced to its carrier:
//     same faction, target, launch and arrival) get ONE new arrival, the
//     latest of theirs, so nothing splits.
//   - Queued legs move up behind the leg before them, keeping any wait
//     the player put between them, and depart from the world they will
//     really be at, when they will really be there.
//   - Left exactly as they are: rendezvous legs and the ships they
//     follow (re-timing either breaks the meeting), hulls a Gravity Sink
//     is holding, gate hops, and everything after any of those in the
//     same ship's queue.
//
// SAFE TO RE-RUN. A leg already on the new burn is only ever shifted
// behind a moved predecessor. Every write is guarded on the row's old
// launch and arrival ticks, so a leg the tick changed in the meantime is
// skipped, not clobbered. A rollback file is written before applying.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRouteMath } from '../worker/routeMath.js';
import {
  legTicks, shapeForArrival, SHIP_ENGINE_ACCEL, SHIP_ENGINE_G, MAX_ENGINE_G, GROWTH_TAU,
} from '../worker/burn.js';

const [envName, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
const ALLOW_LATER = flags.includes('--allow-later');
// --skip=<gameId>, repeatable: games to leave exactly as they are (the
// frozen marketing showcase, whose staged ships must not move).
const SKIP = flags.filter(f => f.startsWith('--skip=')).map(f => f.slice('--skip='.length))
  .filter(id => /^[A-Za-z0-9_-]+$/.test(id));
if (!envName) {
  console.error('usage: node scripts/retime-legs.mjs <env> [--skip=<gameId> ...] [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';
const ENV_FLAG = envName === 'production' ? '' : ` --env ${envName}`;

function d1(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

// ---- every live leg of every ship that has an old one ----------------
const LIVE = `('committed','in_transit')`;
const allLegs = d1(`
  SELECT n.id, n.game_id, n.ship_id, n.sequence, n.status, n.target_body_id,
         n.scheduled_t, n.arrival_at_tick, n.launch_x, n.launch_y, n.launch_vx, n.launch_vy,
         n.accel, n.brake_accel, n.accel_ramp, n.accel_max, n.accel_tau, n.flip_tick,
         n.rv_follow_ship_id, n.sink_held_until_tick,
         s.owner_faction_id, s.parent_body_id, g.current_tick
    FROM game_ship_nodes n
    JOIN game_ships s ON s.id = n.ship_id
    JOIN games g ON g.id = n.game_id AND g.status = 'active'
   WHERE n.status IN ${LIVE}
     ${SKIP.length ? `AND n.game_id NOT IN (${SKIP.map(g => `'${g}'`).join(', ')})` : ''}`);
// ON TODAY'S BURN means today's build exactly: the same growth time AND
// the same floor-to-top ratio (MAX / SHIP g). Server legs scale accel and
// max together, so the ratio holds for them too. Anything else — a flat
// push, the linear build, or the exponential build from the old 0.05g
// floor — is old.
const TOP_RATIO = MAX_ENGINE_G / SHIP_ENGINE_G;
const isCurrent = (l) => l.accel_tau != null && Math.abs(Number(l.accel_tau) - GROWTH_TAU) < 1e-6
  && Number(l.accel) > 0 && Math.abs(Number(l.accel_max) / Number(l.accel) - TOP_RATIO) < 1e-6;
const shipsWithOld = new Set(allLegs.filter(l => !isCurrent(l)).map(l => l.ship_id));
const legs = allLegs.filter(l => shipsWithOld.has(l.ship_id));
// A leg's launch push carries its hull's engine parts. Every burn before
// the 0.02g floor launched from 0.05g, so the same hull now launches from
// accel x (SHIP_ENGINE_G / its old floor); a leg with a build tells us
// its floor directly (max / accel = top / floor).
const newLaunchPush = (l) => {
  const a = Number(l.accel);
  if (!(a > 0)) return SHIP_ENGINE_ACCEL;
  const oldFloorG = Number(l.accel_max) > a ? MAX_ENGINE_G * a / Number(l.accel_max) : 0.05;
  return a * (SHIP_ENGINE_G / oldFloorG);
};
const followed = new Set(d1(`
  SELECT DISTINCT rv_follow_ship_id AS id FROM game_ship_nodes
   WHERE status IN ${LIVE} AND rv_follow_ship_id IS NOT NULL`).map(r => r.id));
const gameIds = [...new Set(legs.map(l => l.game_id))];
console.log(`${DB_NAME}: ${legs.length} live legs on ${new Set(legs.map(l => l.ship_id)).size} ships in ${gameIds.length} games`);

// ---- body positions, from each game's own rows (routeMath) -----------
const maths = new Map();
for (const g of gameIds) {
  const rows = d1(`
    SELECT id, parent_body_id, orbit_radius, orbit_period, angle0,
           orbit_rp, orbit_ra, orbit_omega, orbit_m0
      FROM game_bodies WHERE game_id = '${g}'`);
  const m = makeRouteMath({ prepare: () => ({ bind: () => ({ first: async () => null }) }) }, g);
  m.preloadBodies(rows);
  maths.set(g, m);
}
const posAt = (g, id, t) => maths.get(g).bodyPosAt(id, t);
const velAt = async (g, id, t) => {
  const a = await posAt(g, id, t), b = await posAt(g, id, t + 0.01);
  return { x: (b.x - a.x) / 0.01, y: (b.y - a.y) / 0.01 };
};

// ---- chains -----------------------------------------------------------
const chains = new Map();
for (const l of legs) {
  if (!chains.has(l.ship_id)) chains.set(l.ship_id, []);
  chains.get(l.ship_id).push(l);
}
for (const c of chains.values()) c.sort((a, b) => a.sequence - b.sequence);

const excludedWhy = (l) =>
  l.rv_follow_ship_id ? 'rendezvous'
  : followed.has(l.ship_id) ? 'followed by a rendezvous'
  : (l.sink_held_until_tick != null && Number(l.sink_held_until_tick) >= Number(l.current_tick)) ? 'gravity sink'
  : String(l.id).includes(':gn_') ? 'gate hop'
  : null;

// Walk every chain depth by depth: a leg's departure depends on its
// predecessor's NEW arrival, and that arrival is only final once its
// lockstep group (fleet / escort) has agreed on one.
const state = new Map();           // ship -> { prevOld, prevNew, frozen }
for (const id of chains.keys()) state.set(id, { prevOld: null, prevNew: null, frozen: false });
const plans = [];                  // computed updates
const skipped = new Map();
const maxDepth = Math.max(...[...chains.values()].map(c => c.length));

for (let depth = 0; depth < maxDepth; depth++) {
  const level = [];
  const keyOf = (l) => `${l.game_id}|${l.owner_faction_id}|${l.target_body_id}|${Number(l.scheduled_t)}|${Number(l.arrival_at_tick)}`;
  const excludedKeys = new Set();
  for (const [shipId, chain] of chains) {
    const l = chain[depth];
    const st = state.get(shipId);
    if (!l || st.frozen) continue;
    const why = excludedWhy(l);
    if (why) {
      st.frozen = true;
      skipped.set(why, (skipped.get(why) ?? 0) + 1);
      excludedKeys.add(keyOf(l));
      continue;
    }
    const now = Number(l.current_tick);
    const oldS = Number(l.scheduled_t), oldE = Number(l.arrival_at_tick);
    const launched = oldS <= now;
    const newS = launched || st.prevNew == null ? oldS : st.prevNew + Math.max(0, oldS - st.prevOld);
    const origin = depth === 0 ? l.parent_body_id : chain[depth - 1].target_body_id;
    const hasPlan = l.launch_x != null && l.accel != null;
    // Launch point: the one it flew from, or (queued) its world at its
    // real departure.
    let L, V = null;
    if (launched && hasPlan) L = { x: Number(l.launch_x), y: Number(l.launch_y) };
    else {
      L = await posAt(l.game_id, origin, newS);
      if (!launched) V = await velAt(l.game_id, origin, newS);
    }
    const old = !isCurrent(l);
    // An old leg is re-flown from today's floor; a current one keeps its own.
    const a0 = old ? newLaunchPush(l) : Number(l.accel);
    let natE;
    if (old) {
      let T = Math.max(1, oldE - oldS);
      for (let i = 0; i < 6; i++) {
        const p = await posAt(l.game_id, l.target_body_id, newS + T);
        T = legTicks(Math.max(0.01, Math.hypot(p.x - L.x, p.y - L.y)), a0);
      }
      natE = newS + Math.ceil(T);
    } else {
      natE = newS + (oldE - oldS);   // already on the new burn: same length
    }
    natE = Math.max(natE, launched ? now + 1 : natE);
    level.push({ l, shipId, oldS, oldE, newS, natE, L, V, a0, hasPlan, launched, old });
  }
  // Lockstep: hulls that were moving together stay together — one new
  // arrival for the group, the latest of theirs. A group with an excluded
  // member (see excludedWhy) is left alone entirely, or it would split.
  const groups = new Map();
  for (const c of level) {
    const k = keyOf(c.l);
    groups.set(k, Math.max(groups.get(k) ?? -Infinity, c.natE));
  }
  for (const c of level) {
    const k = keyOf(c.l);
    const st = state.get(c.shipId);
    if (excludedKeys.has(k)) {
      st.frozen = true;
      skipped.set('fleet-mate left alone', (skipped.get('fleet-mate left alone') ?? 0) + 1);
      continue;
    }
    const shifted = c.newS !== c.oldS;
    // In place, a leg only ever gets SOONER (unless --allow-later); moved
    // behind a re-timed predecessor, it takes the group's arrival from its
    // new departure.
    const finalE = shifted || ALLOW_LATER ? groups.get(k) : Math.min(groups.get(k), c.oldE);
    st.prevOld = c.oldE;
    st.prevNew = finalE;
    if (!shifted && finalE === c.oldE) continue;
    plans.push({ ...c, newE: finalE });
  }
}

// ---- the writes -------------------------------------------------------
const round = (v) => Math.round(v * 1e6) / 1e6;
const writes = [];
const rollback = [];
for (const p of plans) {
  const { l } = p;
  const guard = `WHERE id = '${l.id}' AND scheduled_t = ${l.scheduled_t} AND arrival_at_tick = ${l.arrival_at_tick} AND status IN ${LIVE}`;
  const set = [`scheduled_t = ${p.newS}`, `arrival_at_tick = ${p.newE}`];
  if (p.hasPlan || !p.launched) {
    const ip = await posAt(l.game_id, l.target_body_id, p.newE);
    const d = Math.max(0.01, Math.hypot(ip.x - p.L.x, ip.y - p.L.y));
    const sh = shapeForArrival(d, p.newE - p.newS, p.a0);
    const vx = p.V ? p.V.x : Number(l.launch_vx ?? 0);
    const vy = p.V ? p.V.y : Number(l.launch_vy ?? 0);
    set.push(
      `launch_x = ${round(p.L.x)}`, `launch_y = ${round(p.L.y)}`,
      `launch_vx = ${round(vx)}`, `launch_vy = ${round(vy)}`,
      `accel = ${round(sh.accel)}`, `accel_ramp = NULL`, `accel_max = ${round(sh.max)}`,
      `accel_tau = ${round(sh.tau)}`,
      `brake_accel = ${round(sh.brake)}`, `flip_tick = ${round(p.newS + sh.t1)}`,
    );
  }
  writes.push(`UPDATE game_ship_nodes SET ${set.join(', ')} ${guard}`);
  const q = (v) => (v == null ? 'NULL' : Number(v));
  rollback.push(`UPDATE game_ship_nodes SET scheduled_t = ${l.scheduled_t}, arrival_at_tick = ${l.arrival_at_tick}, `
    + `launch_x = ${q(l.launch_x)}, launch_y = ${q(l.launch_y)}, launch_vx = ${q(l.launch_vx)}, launch_vy = ${q(l.launch_vy)}, `
    + `accel = ${q(l.accel)}, accel_ramp = ${q(l.accel_ramp)}, accel_max = ${q(l.accel_max)}, accel_tau = ${q(l.accel_tau)}, `
    + `brake_accel = ${q(l.brake_accel)}, flip_tick = ${q(l.flip_tick)} WHERE id = '${l.id}'`);
}

// ---- the report -------------------------------------------------------
const byGame = new Map();
for (const p of plans) {
  const g = byGame.get(p.l.game_id) ?? { inFlight: 0, queued: 0, sooner: [], later: [] };
  if (p.launched) g.inFlight++; else g.queued++;
  const delta = p.oldE - p.newE;
  if (delta >= 0) g.sooner.push(delta); else g.later.push(-delta);
  byGame.set(p.l.game_id, g);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1].toFixed(1) : '-'; };
const mx = (a) => (a.length ? Math.max(...a).toFixed(1) : '-');
console.log(`\n${plans.length} legs re-timed${ALLOW_LATER ? ' (later arrivals allowed)' : ''}; left alone:`, Object.fromEntries(skipped));
for (const [g, v] of byGame) {
  console.log(`  ${g}: ${v.inFlight} in flight + ${v.queued} queued | sooner ${v.sooner.length} (median ${med(v.sooner)}, max ${mx(v.sooner)}) | later ${v.later.length} (median ${med(v.later)}, max ${mx(v.later)})`);
}
const arriveNext = plans.filter(p => p.launched && p.newE === Number(p.l.current_tick) + 1).length;
console.log(`  arriving next tick (the new burn would already have landed them): ${arriveNext}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(os.tmpdir(), 'orbital-retime');
fs.mkdirSync(dir, { recursive: true });
const rbFile = path.join(dir, `rollback-${envName}-${stamp}.sql`);
fs.writeFileSync(rbFile, rollback.map(s => `${s};`).join('\n'), 'utf8');
console.log(`\nrollback: ${rbFile}`);
if (!APPLY) { console.log('dry run: nothing written (add --apply)'); process.exit(0); }
if (!writes.length) { console.log('nothing to write'); process.exit(0); }
const file = path.join(dir, `retime-${envName}-${stamp}.sql`);
fs.writeFileSync(file, writes.map(s => `${s};`).join('\n'), 'utf8');
execSync(`npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --yes --file "${file}"`, { stdio: 'inherit' });
console.log(`applied ${writes.length} updates (${file})`);
