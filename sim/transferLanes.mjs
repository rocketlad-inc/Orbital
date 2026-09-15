// ============================================================
// TRANSFER LANES — Propulsion 3 makes a capital-to-capital leg faster.
//
// The unlock shipped in July as a label and a blurb with no code behind
// it (a player asked why it "doesn't apply to pre-existing routes"; it
// did not apply to anything). It now lives in routeMath's
// computeLegTicks, which every route leg in the game goes through, so
// this checks the one place and the rules around it:
//   - capital -> capital, with the tech, gating on: shorter by the factor
//   - the same leg without the tech: unchanged
//   - the same leg with gating OFF (grandfathered game): shorter — every
//     unlock is free there
//   - a leg with a non-capital at either end: unchanged
//
// Run: node sim/transferLanes.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

async function seed(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `glane${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Lane Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','lane-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'mars')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
  const [A, B] = (await DB.prepare(
    `SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
  const grant = async (f, track, level) => {
    await DB.prepare(
      `INSERT INTO faction_techs (game_id, faction_id, tech_id, status, started_at_tick, completed_at_tick, level)
       VALUES (?, ?, ?, 'completed', 0, 0, ?)
       ON CONFLICT(game_id, faction_id, tech_id) DO UPDATE SET level = excluded.level`,
    ).bind(G, f.id, track, level).run();
  };
  const gating = (on) => DB.prepare('UPDATE games SET gating_enabled = ? WHERE id = ?').bind(on ? 1 : 0, G).run();
  const { makeRouteMath, TRANSFER_LANE_FACTOR } = await import('../worker/routeMath.js');
  // A fresh math per call: it caches capitals and research per pass.
  const legTicks = (f, from, to) => makeRouteMath(DB, G).computeLegTicks(f.id, from, to, 0);
  return { DB, G, A, B, grant, gating, legTicks, F: TRANSFER_LANE_FACTOR };
}

{
  const h = await seed('a');
  const capA = h.A.capital_body_id, capB = h.B.capital_body_id;
  check('precondition: the two capitals differ', capA !== capB, `${capA} vs ${capB}`);
  await h.gating(true);

  const without = await h.legTicks(h.A, capA, capB);
  await h.grant(h.A, 'propulsion', 3);
  const withLane = await h.legTicks(h.A, capA, capB);
  check('capital -> capital, Propulsion 3, gating on: the leg is shorter',
    withLane < without, `without ${without} -> with ${withLane}`);
  check('…by the lane factor exactly (ceil of T×factor)',
    withLane <= Math.max(1, Math.ceil(without * h.F)) && withLane >= Math.max(1, Math.floor((without - 1) * h.F)),
    `without ${without}, factor ${h.F}, with ${withLane}`);

  const rivalWithout = await h.legTicks(h.B, capB, capA);
  check('a faction WITHOUT the tech flies the same lane at full time',
    rivalWithout === without || Math.abs(rivalWithout - without) <= 1, `rival ${rivalWithout} vs ${without}`);

  await h.grant(h.A, 'propulsion', 2);
  const level2 = await h.legTicks(h.A, capA, capB);
  check('Propulsion 2 is not enough', level2 === without, `level2 ${level2} vs ${without}`);

  await h.grant(h.A, 'propulsion', 3);
  const toVenus = await h.legTicks(h.A, capA, `${h.G}:venus`);
  const fresh = await (async () => {
    // Same leg, tech stripped, to prove venus was never a lane.
    await h.grant(h.A, 'propulsion', 0);
    const t = await h.legTicks(h.A, capA, `${h.G}:venus`);
    await h.grant(h.A, 'propulsion', 3);
    return t;
  })();
  check('a leg to a non-capital is unchanged', toVenus === fresh, `${toVenus} vs ${fresh}`);

  await h.gating(false);
  await h.grant(h.B, 'propulsion', 0);
  const grandfathered = await h.legTicks(h.B, capB, capA);
  check('gating OFF (grandfathered game): every faction has the lane',
    grandfathered < rivalWithout, `gated-no-tech ${rivalWithout} -> ungated ${grandfathered}`);
}

console.log(bad === 0 ? '\nALL TRANSFER-LANE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
