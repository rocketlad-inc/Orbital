// ============================================================
// Reparations: the chairman names the amount per recipient.
//
// Until now the bill's only input was a target; the server paid a fixed
// 200 credits to every other faction and the form said nothing about it
// (a player asked in Discord "how much do I make them give?"). The
// chairman now sets the figure when filing. This sim holds the contract:
//
//   1. the bill carries the amount in its payload (default 200 when the
//      chairman names none, so an older client and bills already on the
//      floor behave exactly as before)
//   2. a nonsense amount is refused at the door, not voted on
//   3. a passed bill moves EXACTLY amount x recipients, from the target
//      to every other active faction, and no more than the target holds
//      (pro-rated evenly when they cannot cover it)
//
// Run: npm run sim:reparations
// ============================================================

import { seedGameWorld } from '../worker/factions.js';
import {
  resolveSenate, buildBillPayload, reparationsAmountOf,
  REPARATIONS_MIN_PER_FACTION, REPARATIONS_MAX_PER_FACTION,
} from '../worker/senate.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

async function seed(players = 4, gameId = 'grep') {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Rep Test','host',0,0)`).bind(gameId).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms)
                    VALUES (?, 'setup','rep-seed',0,0,3600000)`).bind(gameId).run();
  for (let i = 0; i < players; i++) {
    const uid = i === 0 ? 'host' : `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)`).bind(gameId, uid, i).run();
  }
  await seedGameWorld(env, gameId);
  const factionIds = ((await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(gameId).all()).results ?? []).map(r => r.id);
  check('seed produced factions', factionIds.length === players, `got ${factionIds.length}`);
  return { env, DB, gameId, factionIds };
}

const goldOf = async (DB, id) => Number((await DB.prepare('SELECT gold FROM game_factions WHERE id = ?').bind(id).first()).gold);
const setGold = (DB, id, g) => DB.prepare('UPDATE game_factions SET gold = ? WHERE id = ?').bind(g, id).run();

/** File a reparations bill straight onto the floor and close the vote. */
async function passReparations(env, DB, gameId, id, voters, payload) {
  await DB.prepare(
    `INSERT INTO senate_proposals
      (id, game_id, proposer_faction_id, kind, title, summary, payload, status,
       proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick, debate_ticks, vote_ticks)
     VALUES (?, ?, ?, 'reparations', 'Pay up', 'summary', ?, 'voting', 0, 0, 5, 6, 6)`,
  ).bind(id, gameId, voters[0], JSON.stringify(payload)).run();
  for (const f of voters) {
    await DB.prepare(`INSERT INTO senate_votes (proposal_id,faction_id,vote,weight,cast_at_tick)
                      VALUES (?,?,'yea',1,0)`).bind(id, f).run();
  }
  await DB.prepare(`UPDATE games SET current_tick = 5 WHERE id = ?`).bind(gameId).run();
  await resolveSenate(env, gameId, 5);
  return DB.prepare('SELECT status FROM senate_proposals WHERE id = ?').bind(id).first();
}

async function main() {
  // ---- the amount rides in the payload ----------------------------------
  {
    const { env, gameId, factionIds } = await seed(4, 'grepA');
    const [chair, target] = factionIds;
    const base = { target_faction_id: target };

    const dflt = await buildBillPayload(env, gameId, chair, 'reparations', base);
    check('no amount named: the bill carries the historic 200', dflt.data?.amount_per_faction === 200 && dflt.data?.target_faction_id === target, dflt);

    const named = await buildBillPayload(env, gameId, chair, 'reparations', { ...base, amount_per_faction: 750 });
    check('a named amount is carried in the payload and the broadcast', named.data?.amount_per_faction === 750 && named.broadcast?.amount_per_faction === 750, named);

    const asText = await buildBillPayload(env, gameId, chair, 'reparations', { ...base, amount_per_faction: '40' });
    check('a number typed into a form field (a string) is accepted', asText.data?.amount_per_faction === 40, asText);

    const lo = await buildBillPayload(env, gameId, chair, 'reparations', { ...base, amount_per_faction: REPARATIONS_MIN_PER_FACTION });
    const hi = await buildBillPayload(env, gameId, chair, 'reparations', { ...base, amount_per_faction: REPARATIONS_MAX_PER_FACTION });
    check('the lower and upper bounds themselves are allowed', lo.data?.amount_per_faction === REPARATIONS_MIN_PER_FACTION && hi.data?.amount_per_faction === REPARATIONS_MAX_PER_FACTION);

    for (const bad of [0, -5, 1.5, REPARATIONS_MAX_PER_FACTION + 1, 'lots', NaN]) {
      const r = await buildBillPayload(env, gameId, chair, 'reparations', { ...base, amount_per_faction: bad });
      const status = r.error?.status;
      check(`an amount of ${String(bad)} is refused with a 400, not put to a vote`, status === 400 && !r.data, { status, data: r.data });
    }

    const self = await buildBillPayload(env, gameId, chair, 'reparations', { target_faction_id: chair, amount_per_faction: 100 });
    check('you still cannot aim reparations at yourself', self.error?.status === 400, self.error?.status);
    const none = await buildBillPayload(env, gameId, chair, 'reparations', { amount_per_faction: 100 });
    check('and a target is still required', none.error?.status === 400, none.error?.status);

    check('reparationsAmountOf: own figure, else the default for a bill that never named one',
      reparationsAmountOf({ amount_per_faction: 300 }) === 300
      && reparationsAmountOf({}) === 200 && reparationsAmountOf(null) === 200
      && reparationsAmountOf({ amount_per_faction: 'x' }) === 200 && reparationsAmountOf({ amount_per_faction: 99999 }) === 200);
  }

  // ---- a passed bill moves exactly what it says -------------------------
  {
    const { env, DB, gameId, factionIds } = await seed(4, 'grepB');
    const [a, b, c, target] = factionIds;
    for (const f of [a, b, c]) await setGold(DB, f, 1000);
    await setGold(DB, target, 5000);
    const st = await passReparations(env, DB, gameId, 'p500', [a, b, c], { target_faction_id: target, amount_per_faction: 500 });
    check('the bill passed', st?.status === 'passed', st);
    check('the target paid 500 x 3 recipients = 1500', await goldOf(DB, target) === 5000 - 1500, await goldOf(DB, target));
    check('each other faction received exactly 500', (await Promise.all([a, b, c].map(f => goldOf(DB, f)))).every(g => g === 1500));
  }

  // ---- a bill filed before the amount was settable still pays 200 --------
  {
    const { env, DB, gameId, factionIds } = await seed(4, 'grepC');
    const [a, b, c, target] = factionIds;
    for (const f of [a, b, c]) await setGold(DB, f, 0);
    await setGold(DB, target, 10000);
    await passReparations(env, DB, gameId, 'pold', [a, b, c], { target_faction_id: target });
    check('a legacy bill (no amount in its payload) still pays the old 200 each',
      (await Promise.all([a, b, c].map(f => goldOf(DB, f)))).every(g => g === 200) && await goldOf(DB, target) === 10000 - 600);
  }

  // ---- the target cannot pay full freight: shared out evenly, never below zero
  {
    const { env, DB, gameId, factionIds } = await seed(4, 'grepD');
    const [a, b, c, target] = factionIds;
    for (const f of [a, b, c]) await setGold(DB, f, 0);
    await setGold(DB, target, 1000);
    await passReparations(env, DB, gameId, 'pcap', [a, b, c], { target_faction_id: target, amount_per_faction: 5000 });
    const got = await Promise.all([a, b, c].map(f => goldOf(DB, f)));
    check('asking 5000 each of a target holding 1000: it pays what it has, split evenly (333 each)',
      got.every(g => g === 333) && await goldOf(DB, target) === 1000 - 999, { got, target: await goldOf(DB, target) });
    check('the target never goes negative', await goldOf(DB, target) >= 0);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
