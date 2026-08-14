// ============================================================
// The FOUND button must quote — and GATE ON — the price the server
// will actually charge.
//
// "Do we show this price on the build city button?" We did: as the
// literals 30 and 20, in three places in WorldMenuOverlay, one of them
// the affordability check. But the server charges 20% less when a
// Colonist captain sits at the body (handleDeploySettlement), so a
// player holding 24-29 metal saw a DISABLED button for a build the
// server would have accepted. A UI that forbids a legal move is worse
// than one that merely quotes a stale number.
//
// This drives the REAL handler to pin both prices, so the numbers the
// client now reads from /state (me.settlement_cost) can't drift from
// the ones actually charged.
//
// Run: npm run sim:found
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { SETTLEMENT_COST, COLONIST_FOUND_MULT, routes } from '../worker/actions.js';

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
    return JSON.parse(await res.text());
  }
  throw new Error(`no route for ${method} ${path}`);
}

async function seed(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  const G = `gfound${tag}`;
  await DB.prepare(
    `INSERT INTO users (id,email,display_name,password_hash,created_at)
     VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(
    `INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'F','uA',0,0)`).bind(G).run();
  await DB.prepare(
    `INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
     VALUES (?, 'setup','f-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(
    `INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
     VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();

  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

  const A = (await DB.prepare(
    `SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results[0];
  // Clear the seeded starting fleet so only captains we plant are present.
  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();

  const pool = () => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(A.id).first();
  const bank = (metal, gold) =>
    DB.prepare('UPDATE game_factions SET metal = ?, gold = ? WHERE id = ?').bind(metal, gold, A.id).run();
  const found = (name) =>
    callRoute(env, 'POST', `/api/games/${G}/bodies/${A.capital_body_id}/settlement`, 'uA',
      { type: 'station', name });

  // Plant a ship at the capital carrying the Colonist trait.
  const addColonist = async () => {
    await DB.prepare(
      `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, captain_id)
       VALUES ('ship_col${tag}', ?, ?, 'Pioneer', 'corvette', ?, 2,2,0,0,0,1, 9,9,'active',0, 40,40, 3, 'cap_col${tag}')`,
    ).bind(G, A.id, A.capital_body_id).run();
    await DB.prepare(
      `INSERT INTO game_captains (id, game_id, faction_id, name, rank, traits_json, ship_id, status, created_at_tick)
       VALUES ('cap_col${tag}', ?, ?, 'Colonist Cap', 0, '["colonist"]', 'ship_col${tag}', 'active', 0)`,
    ).bind(G, A.id).run();
  };

  return { env, DB, G, A, pool, bank, found, addColonist };
}

const discounted = {
  metal: Math.ceil(SETTLEMENT_COST.metal * COLONIST_FOUND_MULT),
  gold: Math.ceil(SETTLEMENT_COST.gold * COLONIST_FOUND_MULT),
};

// --- 1. No colonist → the base price the button quotes -------------
{
  const s = await seed('1');
  await s.bank(500, 500);
  const before = await s.pool();
  const res = await s.found('Base Price');
  const after = await s.pool();
  check('found on ground we already hold succeeds', !res.error, JSON.stringify(res).slice(0, 200));
  check(`charges the quoted base price (${SETTLEMENT_COST.metal}M / ${SETTLEMENT_COST.gold}C)`,
    before.metal - after.metal === SETTLEMENT_COST.metal
    && before.gold - after.gold === SETTLEMENT_COST.gold,
    `actually charged ${before.metal - after.metal}M / ${before.gold - after.gold}C`);
}

// --- 2. Colonist captain → the discount is real, not cosmetic ------
{
  const s = await seed('2');
  await s.addColonist();
  await s.bank(500, 500);
  const before = await s.pool();
  const res = await s.found('Discounted');
  const after = await s.pool();
  check('found with a Colonist captain at the body succeeds', !res.error, JSON.stringify(res).slice(0, 200));
  check(`Colonist cuts the price to ${discounted.metal}M / ${discounted.gold}C`,
    before.metal - after.metal === discounted.metal && before.gold - after.gold === discounted.gold,
    `actually charged ${before.metal - after.metal}M / ${before.gold - after.gold}C`);
}

// --- 3. THE BUG: a wallet holding exactly the DISCOUNTED price -----
// The old button gated on the base price and greyed this out.
{
  const s = await seed('3');
  await s.addColonist();
  await s.bank(discounted.metal, discounted.gold);
  const res = await s.found('Exactly Enough');
  check('a wallet holding EXACTLY the discounted price is accepted by the server',
    !res.error, `server said: ${JSON.stringify(res).slice(0, 200)}`);
  check('...and that price is strictly below the base the old button gated on',
    discounted.metal < SETTLEMENT_COST.metal && discounted.gold < SETTLEMENT_COST.gold,
    `${discounted.metal}/${discounted.gold} vs ${SETTLEMENT_COST.metal}/${SETTLEMENT_COST.gold}`);
}

// --- 4. Genuinely broke → still refused, so the gate isn't just off -
{
  const s = await seed('4');
  await s.addColonist();
  await s.bank(discounted.metal - 1, discounted.gold);
  const res = await s.found('Too Poor');
  check('one metal short of the discounted price is still refused',
    !!res.error, `expected an error, got: ${JSON.stringify(res).slice(0, 200)}`);
}

// --- 5. A colonist who has ALREADY DEPARTED must not move the price -
// game_ships.parent_body_id still names the departure body all through
// the flight (room.js: "Ships actually IN FLIGHT don't fight"), so a
// naive query counts an officer who left. The client excludes
// in-transit hulls when it quotes; if the server didn't, it would
// charge 24M behind a button gating on 30M — the same lockout.
{
  const s = await seed('5');
  await s.addColonist();
  await s.DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind,
       scheduled_t, dv_prograde, fuel_cost, status)
     VALUES ('node_t5', ?, 'ship_col5', 0, 'periapsis', 0, 1, 0, 'in_transit')`,
  ).bind(s.G).run();
  await s.bank(500, 500);
  const before = await s.pool();
  const res = await s.found('Colonist Already Gone');
  const after = await s.pool();
  check('found still succeeds with the colonist in flight', !res.error, JSON.stringify(res).slice(0, 200));
  check('a departed colonist gets NO discount (full price charged)',
    before.metal - after.metal === SETTLEMENT_COST.metal
    && before.gold - after.gold === SETTLEMENT_COST.gold,
    `charged ${before.metal - after.metal}M / ${before.gold - after.gold}C, `
    + `expected the base ${SETTLEMENT_COST.metal}M / ${SETTLEMENT_COST.gold}C`);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
