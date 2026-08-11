// ============================================================
// Situation report — the terraforming section.
//
// Exists because the live board couldn't test it: production has
// exactly ONE owned raw world and it has zero progress, which is
// precisely the case the section stays SILENT about. So every branch
// that actually prints was unexercised, and "the query runs" is not the
// same as "the right line comes out".
//
// The bug this locks down is the one the section was built for: a world
// with a half-delivered payload and no freighter feeding it sits at 40%
// forever and nothing tells you. If STALLED ever stops printing, that
// world goes invisible again.
//
// Run: npm run sim:sitrep
// ============================================================

import { buildSituationReport } from '../worker/situationReport.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const G = 'gsitrep';
const COST = 124;   // shipped terraform_cost_metal / _credits

/** A game with one faction and a set of worlds in given terraform states. */
async function seed(worlds) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u1','a@b','Player','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Sitrep','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'active','s',100,0)`).bind(G).run();
  await DB.prepare(
    `INSERT INTO game_factions (id,game_id,user_id,slot,name,color,status,
                                capital_body_id,reputation,senate_weight,
                                metal,fuel,gold,science,research_progress,joined_at)
     VALUES ('f0',?,'u1',0,'Testers','#ff7043','active',NULL,0,1,0,0,0,0,0,0)`,
  ).bind(G).run();

  for (const w of worlds) {
    await DB.prepare(
      `INSERT INTO game_bodies
         (id, game_id, template_id, name, type, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id,
          terraformed_at_tick, terraform_acc_metal, terraform_acc_gold,
          terraform_completes_at_tick)
       VALUES (?,?,?,?,'moon',10,20,1,500,100,0,'#888',?,
               NULL,?,?,?)`,
    ).bind(`${G}:${w.id}`, G, w.id, w.name, w.owned ? 'f0' : null,
           w.accM ?? 0, w.accC ?? 0, w.doneAt ?? null).run();
    for (let i = 0; i < (w.routes ?? 0); i++) {
      await DB.prepare(
        `INSERT INTO game_trade_routes
           (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
            status, kind, created_at_tick)
         VALUES (?,?,'f0',?,?,?, 'returning','terraform',0)`,
      ).bind(`r_${w.id}_${i}`, G, `sh_${w.id}_${i}`, `${G}:origin`, `${G}:${w.id}`).run();
    }
  }
  return { env, DB };
}

/**
 * The terraform field's text, or null when the section is absent.
 *
 * Fields hang off rep.embed.fields — this originally read rep.fields,
 * which is undefined, so EVERY case returned null and the two
 * "should print nothing" assertions passed for entirely the wrong
 * reason. Hence the sanity check below: if the report has no fields at
 * all then the harness is broken, not the feature, and a silent pass
 * would be worse than a failure.
 */
async function tfField(worlds) {
  const { env } = await seed(worlds);
  const rep = await buildSituationReport(env, G, 'u1');
  if (!rep) throw new Error('harness: buildSituationReport returned null');
  const all = rep.embed?.fields ?? [];
  if (all.length === 0) throw new Error('harness: report has no fields at all');
  const f = all.find(x => String(x.name).includes('Terraforming'));
  return f ? f.value : null;
}

let bad = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { bad++; if (detail !== undefined) console.log(`        got: ${detail}`); }
};

// 1. THE CASE THE SECTION EXISTS FOR. Half a payload, nobody hauling.
{
  const v = await tfField([
    { id: 'io', name: 'Io', owned: true, accM: 62, accC: 62, routes: 0 },
  ]);
  check('stalled world is reported', !!v && v.includes('STALLED'), v);
  check('stalled world shows its percentage', !!v && v.includes('50%'), v);
}

// 2. Supplied worlds report progress, not a stall.
{
  const v = await tfField([
    { id: 'io', name: 'Io', owned: true, accM: 62, accC: 62, routes: 2 },
  ]);
  check('fed world is NOT called stalled', !!v && !v.includes('STALLED'), v);
  check('fed world names its route count', !!v && v.includes('2 routes feeding'), v);
}

// 3. Payload in, clock running.
{
  const v = await tfField([
    { id: 'io', name: 'Io', owned: true, accM: 124, accC: 124, doneAt: 106 },
  ]);
  check('finishing world counts down', !!v && v.includes('6') && /green in/i.test(v), v);
}

// 4. SILENCE. A raw world nobody started is an opportunity, not news —
//    and an un-owned world is none of our business. This is what keeps
//    the report from becoming the status dump it exists not to be.
{
  const v = await tfField([
    { id: 'ariel', name: 'Ariel', owned: true, accM: 0, accC: 0, routes: 0 },
  ]);
  check('never-started world prints nothing', v === null, v);
}
{
  const v = await tfField([
    { id: 'x', name: 'Rival World', owned: false, accM: 62, accC: 62, routes: 0 },
  ]);
  check('someone else\'s terraform prints nothing', v === null, v);
}

// 5. The limiting half sets the percentage: metal full, credits empty is
//    0%, not 50%. Reporting the average would tell a player they were
//    halfway when they had delivered none of one resource.
{
  const v = await tfField([
    { id: 'io', name: 'Io', owned: true, accM: 124, accC: 0, routes: 1 },
  ]);
  check('percent tracks the LIMITING resource', !!v && v.includes('0%'), v);
}

// 6. Ordering: the thing you must act on outranks the thing that is fine.
{
  const v = await tfField([
    { id: 'a', name: 'Fedworld', owned: true, accM: 62, accC: 62, routes: 3 },
    { id: 'b', name: 'Stuckworld', owned: true, accM: 30, accC: 30, routes: 0 },
  ]);
  const ok = !!v && v.indexOf('Stuckworld') < v.indexOf('Fedworld');
  check('stalled sorts above merely-progressing', ok, v);
}

console.log('');
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('the terraform section says the right thing, and stays quiet otherwise');
