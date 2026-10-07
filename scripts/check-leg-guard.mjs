// ============================================================
// check-leg-guard — replay stored legs through worker/legGuard.js and
// report every one it would have refused. Read-only.
//
//   node scripts/check-leg-guard.mjs <production|staging> [--limit=N]
//
// Run before the guard is trusted on an environment: a legitimate client
// plans exactly at its hull's limits, so the guard must refuse NONE of
// the legs real clients committed. Legs from earlier burns (other caps)
// are checked on their push only; legs on today's burn get the full check.
// ============================================================

import { execSync } from 'node:child_process';
import { GROWTH_TAU, MAX_ENGINE_G, SHIP_ENGINE_G } from '../worker/burn.js';
import { hullLimits, legRefusal } from '../worker/legGuard.js';
import { makeRouteMath } from '../worker/routeMath.js';

const [envName, ...flags] = process.argv.slice(2);
const LIMIT = Number((flags.find(f => f.startsWith('--limit=')) ?? '--limit=3000').slice(8));
if (!['production', 'staging'].includes(envName)) {
  console.error('usage: node scripts/check-leg-guard.mjs <production|staging> [--limit=N]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';
const ENV_FLAG = envName === 'production' ? '' : ` --env ${envName}`;

const lit = (v) => (v === null || v === undefined) ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const inline = (sql, p) => { let i = 0; return sql.replace(/\?(\d+)?/g, (_, n) => lit(p[n ? Number(n) - 1 : i++])); };
function q(sql) {
  const one = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = execSync(`npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --json --command "${one.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}
const DB = {
  prepare: (sql) => ({
    _p: [], bind(...p) { this._p = p; return this; },
    async all() { return { results: q(inline(sql, this._p)) }; },
    async first() { return q(inline(sql, this._p))[0] ?? null; },
  }),
};

const allLegs = q(`
  SELECT n.id, n.game_id, n.ship_id, n.target_body_id, n.scheduled_t, n.arrival_at_tick,
         n.launch_x, n.launch_y, n.accel, n.brake_accel, n.accel_ramp, n.accel_max, n.accel_tau,
         n.rv_follow_ship_id, n.status
    FROM game_ship_nodes n
   WHERE n.accel IS NOT NULL AND n.arrival_at_tick IS NOT NULL AND n.target_body_id IS NOT NULL
   ORDER BY n.rowid DESC LIMIT ${LIMIT}`);
// Only legs a PLAYER committed through the transfer endpoints, which is
// all the guard sees: their ids come from actions.js newNodeId
// (`<ship>:n<base36 ms><4 random>`). Trade, delivery, retreat and gate
// legs are planned by the server itself (shapeForArrival scales a whole
// burn to a fixed arrival, so its push can sit above the hull's own).
const legs = allLegs.filter(l => /:n[0-9a-z]{9,}$/.test(l.id));
console.log(`${allLegs.length} stored legs with a plan; ${legs.length} committed by players`);

const byGame = new Map();
for (const l of legs) (byGame.get(l.game_id) ?? byGame.set(l.game_id, []).get(l.game_id)).push(l);

const topRatio = MAX_ENGINE_G / SHIP_ENGINE_G;
let pushChecked = 0, fullChecked = 0;
const refused = [];
for (const [gameId, gl] of byGame) {
  const limits = await hullLimits(DB, gameId, gl.map(l => l.ship_id));
  const rm = makeRouteMath(DB, gameId);
  const bodies = q(`SELECT * FROM game_bodies WHERE game_id = ${lit(gameId)}`);
  rm.preloadBodies(bodies);
  for (const l of gl) {
    const a0max = limits.get(l.ship_id);
    if (!(a0max > 0)) continue;   // ship gone
    const plan = {
      acc: l.accel, amax: l.accel_max, atau: l.accel_tau, rmp: l.accel_ramp, brk: l.brake_accel,
    };
    // Today's burn: exponential at GROWTH_TAU, topping at topRatio x its push.
    const current = l.accel_tau != null && Math.abs(l.accel_tau - GROWTH_TAU) < 1e-6
      && l.accel_max != null && Math.abs(l.accel_max / l.accel - topRatio) < 1e-6;
    let why;
    if (current) {
      fullChecked += 1;
      let distance = null;
      if (!l.rv_follow_ship_id && l.launch_x != null) {
        const t = await rm.bodyPosAt(l.target_body_id, l.arrival_at_tick);
        distance = Math.hypot(t.x - l.launch_x, t.y - l.launch_y);
      }
      why = legRefusal({ a0max, plan, depart: l.scheduled_t, arrive: l.arrival_at_tick, distance });
    } else {
      // An older burn had a different floor. Its cap-to-push ratio says
      // which: 20 (0.05g -> 1g) or 50 (0.02g -> 1g) on the 1g-top burns;
      // a linear build or a flat push was the 0.05g era. Judge the push
      // against THAT floor.
      pushChecked += 1;
      const ratio = l.accel_max != null ? l.accel_max / l.accel : null;
      const eraFloorG = ratio != null && l.accel_tau != null ? 1 / ratio : 0.05;
      const eraA0max = a0max * (eraFloorG / SHIP_ENGINE_G);
      why = legRefusal({ a0max: eraA0max, plan: { acc: l.accel }, depart: 0, arrive: null, distance: null });
    }
    if (why) refused.push({ id: l.id, why, status: l.status, ratio: +(l.accel / a0max).toFixed(3) });
  }
}
console.log(`full check: ${fullChecked} legs on today's burn; push check: ${pushChecked} older legs`);
console.log(refused.length ? `WOULD REFUSE ${refused.length}:` : 'refuses none');
for (const r of refused.slice(0, 40)) console.log(' ', JSON.stringify(r));
process.exit(refused.length ? 1 : 0);
