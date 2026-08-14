// ============================================================
// Upkeep currency follows the loadout.
//
// Player report (Lorne, live game): metal income +50/tick against
// credits at −7/tick, holding the outer metal belt (Titan 7M/1C, Rhea
// 6M/1C, Enceladus 5M/0C, Saturn 9M/1C — against a map-wide 141M/126C,
// so the map is balanced and the REGION is not). The squeeze was upkeep:
// three of five hull classes billed credits ONLY (corvette 0.25C/0M,
// freighter 1C/0M), so no empire could float a fleet on metal no matter
// what its worlds produced. The fleet in that report paid −6.25 credits
// against −0.50 metal: a 12.5:1 credit bill against 7.5:1 metal income,
// exactly opposed.
//
// The rule now: "currency per tick is proportional to distribution of
// loadout." Kinetic/shield are metal-side (8/1), energy/armor
// credit-side (1/8), so what a hull is MADE of decides what it DRAINS.
//
// The invariant that makes this safe to ship to live games: TOTAL
// UPKEEP IS UNCHANGED. This moves a bill between pockets; it must never
// resize one. Every case below checks that first.
//
// Run: npm run sim:upkeep
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { upkeepSplit, HULL_COST, partsCost } from '../worker/shipDesigns.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Live defaults (worker/configSchema.js).
const TOTALS = {
  corvette:  { gold: 0.25, metal: 0 },
  frigate:   { gold: 0.5,  metal: 0.5 },
  destroyer: { gold: 1,    metal: 1 },
  freighter: { gold: 1,    metal: 0 },
  colony:    { gold: 0,    metal: 0 },
};

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

// ---- 1. THE INVARIANT: totals never move -----------------------------
{
  const loadouts = [
    [], ['kinetic'], ['energy'], ['kinetic', 'kinetic'], ['energy', 'armor'],
    ['kinetic', 'shield'], ['engine'], ['detonator'], ['kinetic', 'energy'],
  ];
  let worst = 0;
  for (const cls of Object.keys(TOTALS)) {
    const want = TOTALS[cls].gold + TOTALS[cls].metal;
    for (const parts of loadouts) {
      const u = upkeepSplit(cls, parts, TOTALS[cls]);
      worst = Math.max(worst, Math.abs((u.gold + u.metal) - want));
    }
  }
  check('total upkeep is preserved for every class × loadout',
    worst < 1e-9, `worst drift ${worst}`);
}

// ---- 2. The split actually tracks the loadout ------------------------
{
  const T = TOTALS.corvette;             // 0.25 total, historically 100% credits
  const kinetic = upkeepSplit('corvette', ['kinetic'], T);   // 8M/1C part
  const energy  = upkeepSplit('corvette', ['energy'],  T);   // 1M/8C part
  check('an all-metal corvette pays mostly METAL',
    kinetic.metal > kinetic.gold * 5,
    `${kinetic.metal.toFixed(3)}M vs ${kinetic.gold.toFixed(3)}C`);
  check('an all-credit corvette pays mostly CREDITS',
    energy.gold > energy.metal * 5,
    `${energy.metal.toFixed(3)}M vs ${energy.gold.toFixed(3)}C`);
  check('the two are mirror images (same total, opposite mix)',
    near(kinetic.metal, energy.gold) && near(kinetic.gold, energy.metal),
    JSON.stringify({ kinetic, energy }));
  // 8:1 part → 8/9 of the bill in metal.
  check('mix matches the part cost ratio exactly (8:1 → 8/9 metal)',
    near(kinetic.metal, 0.25 * 8 / 9),
    `${kinetic.metal} vs ${0.25 * 8 / 9}`);
}

// ---- 3. A bare hull uses its OWN build ratio, not credits-only -------
{
  const bare = upkeepSplit('corvette', [], TOTALS.corvette);
  const hull = HULL_COST.corvette;       // 20M / 16C
  check('a bare corvette no longer pays 100% credits',
    bare.metal > 0, JSON.stringify(bare));
  check('bare hull mix = hull build-cost mix',
    near(bare.metal, 0.25 * hull.metal / (hull.metal + hull.gold)),
    `${bare.metal} vs ${0.25 * hull.metal / (hull.metal + hull.gold)}`);
  const bareF = upkeepSplit('freighter', [], TOTALS.freighter);
  check('a bare freighter splits too (was 1.00C / 0M)',
    bareF.metal > 0.5 && bareF.gold < 0.5,
    JSON.stringify(bareF));
}

// ---- 4. Colony stays free; unknown class is ignored by callers -------
{
  const c = upkeepSplit('colony', ['kinetic'], TOTALS.colony);
  check('a zero-total class stays free', c.gold === 0 && c.metal === 0, JSON.stringify(c));
}

// ---- 5. Stack escalation is respected (uses partsCost, not a count) --
{
  const one = partsCost(['kinetic']);
  const two = partsCost(['kinetic', 'kinetic']);
  check('stacking escalates part cost (sanity for the ratio source)',
    two.metal > one.metal * 2 - 1, `${one.metal} → ${two.metal}`);
  const u = upkeepSplit('destroyer', ['kinetic', 'kinetic', 'energy'], TOTALS.destroyer);
  const pc = partsCost(['kinetic', 'kinetic', 'energy']);
  check('a mixed loadout lands between the extremes, on the cost ratio',
    near(u.metal, 2 * pc.metal / (pc.metal + pc.gold)),
    `${u.metal} vs ${2 * pc.metal / (pc.metal + pc.gold)}`);
}

// ---- 6. END TO END: the real tick bills what the helper says ---------
{
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = 'gupkeep1';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'U','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','up-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G,'uA',G,'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
  const [A] = (await DB.prepare(
    `SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;

  // One faction, two corvettes: one all-metal, one all-credit.
  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  for (const [id, parts] of [['ship_kin1', ['kinetic']], ['ship_nrg1', ['energy']]]) {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, parts_json)
       VALUES (?, ?, ?, ?, 'corvette', ?, 2,2,0,0,0,1, 99,99,'active',0, 40,40, 3, ?)`,
    ).bind(id, G, A.id, id, A.capital_body_id, JSON.stringify(parts)).run();
  }
  // Deterministic wallet, no income: yields off so upkeep is the only mover.
  await DB.prepare('UPDATE game_bodies SET yield_metal=0, yield_gold=0, yield_science=0 WHERE game_id = ?').bind(G).run();
  await DB.prepare('DELETE FROM game_settlements WHERE game_id = ?').bind(G).run();
  await DB.prepare(`UPDATE game_factions SET metal=1000, gold=1000, fuel=0, science=0,
                    upkeep_carry_gold=0, upkeep_carry_metal=0, arrears_gold=0, arrears_metal=0
                    WHERE game_id = ?`).bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};

  const before = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(A.id).first();
  const N = 20;
  for (let t = 1; t <= N; t++) {
    await room.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  }
  const after = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(A.id).first();

  const spentM = before.metal - after.metal;
  const spentG = before.gold - after.gold;
  const kin = upkeepSplit('corvette', ['kinetic'], TOTALS.corvette);
  const nrg = upkeepSplit('corvette', ['energy'],  TOTALS.corvette);
  const expM = (kin.metal + nrg.metal) * N;
  const expG = (kin.gold  + nrg.gold)  * N;

  // Billing carries fractional remainders tick to tick, so allow a
  // rounding window of one whole unit rather than demanding exactness.
  check('the real tick charged the metal the helper predicts',
    Math.abs(spentM - expM) <= 1.01, `charged ${spentM}, expected ~${expM.toFixed(2)}`);
  check('the real tick charged the credits the helper predicts',
    Math.abs(spentG - expG) <= 1.01, `charged ${spentG}, expected ~${expG.toFixed(2)}`);
  check('a metal-fitted fleet really does draw metal from the treasury',
    spentM > 0, `metal spent ${spentM} — the whole point of the change`);
  check('total charged still equals the old flat total',
    Math.abs((spentM + spentG) - 0.5 * N) <= 2.01,
    `charged ${spentM + spentG} vs flat ${0.5 * N}`);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
