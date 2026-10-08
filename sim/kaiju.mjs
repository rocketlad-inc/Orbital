// ============================================================
// THE LEVIATHAN — the second sun gate carried in on a monster, driven
// end to end through the REAL resolveTick (worker/kaiju.js).
//
// Lorne, 2026-10-07: launches from the unconnected far system at 2g,
// announced in the log; leaves the gate where it lands; then goes for
// the closest settled moons and small worlds one at a time, double-
// tapping each like a Mega Destroyer with the same wind-up. Picks:
// HP scaled to the game's fleets (capped 20,000), never a homeworld,
// leaves after N worlds, and a killed one leaves a carcass to salvage.
//
// Two games on live map dials:
//   A. The full hunt, with nobody shooting back: omen, launch, landing,
//      every hunt and strike, the leave and the exit through the gate.
//   B. The kill: a fleet waiting at its first prey, a beast on 1 HP.
//
// Run: node sim/kaiju.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import {
  kaijuHp, kaijuDials, pickPrey, kaijuShipId, kaijuFactionId, kaijuCarcassId,
} from '../worker/kaiju.js';
import { sunGatePlan, gateOrder, solGateId, siteId, emergeFlightTicks } from '../worker/sunGates.js';
import { hostilePairs, pairKey, atWarSql } from '../worker/wars.js';
import { invalidate } from '../worker/gameConfig.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// ---- 1. The pure rules ------------------------------------------------
{
  const d = kaijuDials({});
  check('defaults: appetite 5, one wind-up of fleet fire, 2,000..20,000 HP, 50 damage',
    d.appetite === 5 && d.hpTicks === 24 && d.hpMin === 2000 && d.hpMax === 20000 && d.damage === 50,
    JSON.stringify(d));
  // The table Lorne picked from: a destroyer lands 26% of 87.5 on a 0.50
  // target, a frigate 50% of 17.5, a corvette 74% of 3.5.
  const fleet = (n, cls, dmg) => Array.from({ length: n }, () => ({ ship_class: cls, damage_per_tick: dmg }));
  const tiny = kaijuHp(fleet(5, 'corvette', 3.5), d);
  check('a game of five corvettes gets the floor', tiny.hp === 2000, JSON.stringify(tiny));
  const mid = kaijuHp([...fleet(60, 'corvette', 3.5), ...fleet(4, 'frigate', 17.5), ...fleet(1, 'destroyer', 87.5)], d);
  check('a mid game is sized to one wind-up of everything it has',
    mid.hp > 2000 && mid.hp < 20000 && Math.abs(mid.hp - mid.perTick * 24) <= 100,
    `${mid.hp} HP from ${mid.perTick.toFixed(1)}/tick`);
  const big = kaijuHp([...fleet(330, 'corvette', 3.5), ...fleet(146, 'frigate', 17.5)], d);
  check('a big game hits the 20,000 cap', big.hp === 20000, JSON.stringify(big));
  check('...and a host can move the cap', kaijuHp(fleet(330, 'frigate', 17.5), kaijuDials({ kaiju_hp_max: 50000 })).hp > 20000);

  // Lorne, 2026-10-08: outer system first, then down the well at random.
  const { seededRand } = await import('../worker/sunGates.js');
  const map = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, r: (i + 1) * 20 }));   // 20..1000
  const picks = (fromR, left) => Array.from({ length: 300 },
    (_, n) => pickPrey(map, fromR, left, seededRand(`p${n}`)));
  {
    const first = picks(1200, 5);
    check('the first of five is from the outer fifth of the map',
      first.every(w => w.r > 800), `${Math.min(...first.map(w => w.r))}`);
    check('...picked at random within it', new Set(first.map(w => w.id)).size >= 8, `${new Set(first.map(w => w.id)).size} distinct`);
    const mid = picks(600, 3);
    check('every meal is further in than where it is', mid.every(w => w.r < 600), `${Math.max(...mid.map(w => w.r))}`);
    check('...from the outer third of what is left inside it', mid.every(w => w.r > 380), `${Math.min(...mid.map(w => w.r))}`);
    const last = picks(600, 1);
    check('the last meal can be anywhere further in',
      Math.min(...last.map(w => w.r)) <= 100 && last.every(w => w.r < 600));
  }
  check('nothing further in, nothing picked', pickPrey(map, 10, 3, seededRand('x')) === null
    && pickPrey([], 1000, 5, seededRand('y')) === null);
}

// ---- 2. A real game ---------------------------------------------------
const LIVE = { far_systems: 1, system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4 };

async function seed(G, extra) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const now = Date.now();
  for (const u of ['u1', 'u2']) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
      .bind(u, `${u}@t`, u, now).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Deep','u1',?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?,'setup','kaiju',0,3600000,?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'k', 'archived', ?, 0, 0)`)
    .bind(`cfg_${G}`, JSON.stringify({ ...LIVE, kaiju: 1, sun_gate_start: 5, sun_gate_end: 5, sun_gate_interval: 10, ...extra })).run();
  await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${G}`, G).run();
  invalidate(G);
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
  const fA = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first());
  const fB = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first());
  // Prey: settlements out on small worlds and moons, by template.
  const settle = async (tpl, owner, type = 'station') => {
    const id = `${G}:${tpl}`;
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 400, 400, 1, 0, 0)`,
    ).bind(`st_${G}_${tpl}`, G, id, owner, type, `${tpl} base`).run();
    await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(owner, id).run();
  };
  const { Room } = await import('../worker/room.js');
  const store = new Map();
  const room = new Room({
    storage: {
      async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
      async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
      async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
    },
    blockConcurrencyWhile: async (f) => f(),
    getWebSockets: () => [],
    broadcast: () => {},
  }, env);
  const run = async (t) => {
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
    await room.resolveTick(G, t);
  };
  return { env, DB, fA, fB, settle, run, room };
}

const kRow = (DB, G) => DB.prepare('SELECT * FROM game_kaiju WHERE game_id = ?').bind(G).first();
const kShip = (DB, G) => DB.prepare('SELECT * FROM game_ships WHERE id = ?').bind(kaijuShipId(G)).first();
const kinds = async (DB, G) => (await DB.prepare(
  `SELECT kind, tick_number, body_id, payload FROM chronicle_entries
    WHERE game_id = ? AND (kind LIKE 'kaiju_%' OR (kind IN ('terraform_destroyed','world_obliterated')
      AND json_extract(payload, '$.cause') = 'kaiju') OR kind LIKE 'sun_gate_%')
    ORDER BY tick_number, created_at_ms`).bind(G).all()).results ?? [];

// ---- A. The hunt --------------------------------------------------------
{
  const G = 'gkaiju';
  const { DB, fA, fB, settle, run } = await seed(G, { kaiju_appetite: 2 });
  for (const tpl of ['pluto', 'titan', 'callisto', 'eris']) await settle(tpl, fA.id);
  await settle('ganymede', fB.id);
  // Living world: the double tap.
  await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 1 WHERE id = ?').bind(`${G}:titan`).run();

  const plan = sunGatePlan(G, 5, { sun_gate_interval: 10 });
  const kSys = plan[1].sys;
  check(`the second gate is the Leviathan's, from ${kSys.label}`, plan[1].emergeTick === 21, String(plan[1].emergeTick));

  const log = [];
  let prev = null;
  const targets = [];
  let launchedAt = null;
  for (let t = 1; t <= 400; t++) {
    await run(t);
    const k = await kRow(DB, G);
    if (k && launchedAt == null) launchedAt = t;
    if (k && (k.phase !== prev?.phase || k.target_body_id !== prev?.target_body_id)) {
      log.push(`T${t} ${k.phase} -> ${k.target_body_id ?? '-'} (eaten ${k.eaten})`);
      if (k.target_body_id && !targets.includes(k.target_body_id)) targets.push(k.target_body_id);
    }
    prev = k;
    if (k?.phase === 'gone') break;
  }
  console.log('      ' + log.join('\n      '));
  const k = await kRow(DB, G);
  const ship = await kShip(DB, G);
  const fac = await DB.prepare('SELECT * FROM game_factions WHERE id = ?').bind(kaijuFactionId(G)).first();
  const rows = await kinds(DB, G);
  const has = (kind, pred = () => true) => rows.some(r => r.kind === kind && pred(JSON.parse(r.payload || '{}'), r));

  check('the omen is written six ticks before the launch, naming the system',
    has('kaiju_omen', (p, r) => r.tick_number === 15 && p.system === kSys.label), JSON.stringify(rows.filter(r => r.kind === 'kaiju_omen')));
  check('no plain "something else from the Sun" omen for that gate',
    !has('sun_gate_omen', p => Number(p.index) === 1));
  check('it launches on the tick the second gate was due', launchedAt === 21, String(launchedAt));
  check('the beast belongs to a monster faction with no seat',
    fac?.status === 'monster' && fac.user_id == null && ship?.owner_faction_id === fac.id, JSON.stringify(fac));
  check('with no fleets in the game it gets the floor HP', ship?.hp_max === 2000, String(ship?.hp_max));
  const launch = rows.find(r => r.kind === 'kaiju_launched');
  const lp = JSON.parse(launch?.payload || '{}');
  check('the launch is announced with its arrival tick', !!launch && lp.arrive_tick === k.arrive_tick, launch?.payload);
  {
    // The flight: from the far barycenter to the landing site at 2g.
    const site = await DB.prepare('SELECT * FROM game_bodies WHERE id = ?').bind(siteId(G, kSys)).first();
    const T = k.arrive_tick - k.launched_at_tick;
    check('the trip is a 2g burn across interstellar space (dozens of ticks)', T >= 15 && T <= 80, `${T} ticks`);
    check('the landing site existed from the launch', site?.emerge_from_tick === 21, JSON.stringify(site?.emerge_from_tick));
    const gate = await DB.prepare('SELECT * FROM game_bodies WHERE id = ?').bind(solGateId(G, kSys)).first();
    check('the gate itself does not exist until it is dropped',
      gate?.emerge_from_tick === k.arrive_tick && gate?.emerge_until_tick === k.arrive_tick, JSON.stringify(gate));
  }
  check('on landing the hunt begins and the gate opens', has('kaiju_hunting', p => p.first === true)
    && has('sun_gate_opened', p => p.kaiju === true));
  const capitals = new Set([fA.capital_body_id, fB.capital_body_id]);
  check('never once a homeworld', targets.every(t => !capitals.has(t)), targets.join(', '));
  {
    // Down the well: each world it goes for is closer to the Sun than the
    // last (heliocentric distance of the world's own system).
    const helio = async (id) => {
      let b = await DB.prepare('SELECT parent_body_id, orbit_radius FROM game_bodies WHERE id = ?').bind(id).first();
      while (b && b.parent_body_id && b.parent_body_id !== `${G}:sol`) {
        b = await DB.prepare('SELECT parent_body_id, orbit_radius FROM game_bodies WHERE id = ?').bind(b.parent_body_id).first();
      }
      return Number(b?.orbit_radius) || 0;
    };
    const prey = targets.slice(1, -1);   // site first, gate last
    const rs = [];
    for (const t of prey) rs.push(await helio(t));
    check('it works down the well, every meal further in',
      prey.length >= 2 && rs.every((r, i) => i === 0 || r < rs[i - 1] + 1e-6),
      prey.map((t, i) => `${t.split(':')[1]}@${Math.round(rs[i])}`).join(' > '));
  }
  {
    // 2g across the dark, 0.5g between worlds so fleets can catch it.
    const { fromG } = await import('../worker/burn.js');
    const legs = (await DB.prepare(`SELECT sequence, accel_max, accel, arrival_at_tick, committed_at_tick
                                       FROM game_ship_nodes WHERE ship_id = ? ORDER BY sequence`)
      .bind(kaijuShipId(G)).all()).results;
    const push = (n) => Math.max(Number(n.accel_max) || 0, Number(n.accel) || 0);
    const inSystem = legs.slice(1);
    check('between worlds its push never passes 0.5g',
      inSystem.length >= 2 && inSystem.every(n => push(n) <= fromG(0.5) * 1.02),
      legs.map(n => `${(push(n) / fromG(1)).toFixed(2)}g`).join(', '));
    check('...while the crossing from its star runs hotter', push(legs[0]) > fromG(0.5),
      `${(push(legs[0]) / fromG(1)).toFixed(2)}g`);
  }
  check('it winds up for the full Mega Destroyer charge before every strike',
    rows.filter(r => r.kind === 'kaiju_charging').every(r => JSON.parse(r.payload).fires_at_tick - r.tick_number === 24));
  const broken = rows.filter(r => r.kind === 'world_obliterated');
  check('it broke exactly its appetite of worlds (2)', broken.length === 2 && k.eaten === 2,
    `${broken.length} broken, eaten ${k.eaten}: ${k.eaten_json}`);
  const titanBroken = broken.some(r => r.body_id === `${G}:titan`);
  if (titanBroken) {
    check('a living world took two strikes: stripped, then broken',
      has('terraform_destroyed', (p, r) => r.body_id === `${G}:titan`));
  }
  // Two strikes for every world, living or not (Lorne, 2026-10-08):
  // scorch or strip, then break, 24 T apart.
  {
    const per = broken.map(b => {
      const first = rows.filter(r => r.kind === 'terraform_destroyed' && r.body_id === b.body_id);
      return { w: b.body_id.split(':')[1], n: first.length, gap: first[0] ? b.tick_number - first[0].tick_number : null,
        raw: first[0] ? !!JSON.parse(first[0].payload).raw : null };
    });
    check('every world it broke took two strikes, a day apart',
      per.length > 0 && per.every(p => p.n === 1 && p.gap === 24), JSON.stringify(per));
    check('...a raw world scorched first, not skipped to the kill', per.some(p => p.raw === true), JSON.stringify(per));
  }
  const settlementsLeft = (await DB.prepare(
    `SELECT COUNT(*) n FROM game_settlements WHERE game_id = ? AND destroyed_at_tick IS NULL AND body_id IN (${broken.map(() => '?').join(',')})`,
  ).bind(G, ...broken.map(r => r.body_id)).first()).n;
  check('everything on a broken world is gone', settlementsLeft === 0, String(settlementsLeft));
  check('then it left, and went through the gate', has('kaiju_leaving', p => p.why === 'full') && has('kaiju_gone')
    && k.phase === 'gone' && ship.status === 'departed', `${k.phase} / ${ship.status}`);
  const caps = (await DB.prepare(`SELECT COUNT(*) n FROM game_captains WHERE ship_id = ?`).bind(ship.id).first()).n;
  check('nobody ever crewed it', caps === 0);

  // At war with everyone, and nobody can make peace.
  const war = await hostilePairs({ DB }, G);
  check('every empire is at war with it', war.has(pairKey(fac.id, fA.id)) && war.has(pairKey(fac.id, fB.id))
    && !war.has(pairKey(fA.id, fB.id)));
  const w = await DB.prepare(`SELECT ${atWarSql('?2', '?3')} AS w`).bind(G, fA.id, fac.id).first();
  const p = await DB.prepare(`SELECT ${atWarSql('?2', '?3')} AS w`).bind(G, fA.id, fB.id).first();
  check('...and the SQL rule agrees', Number(w.w) === 1 && Number(p.w) === 0, JSON.stringify([w, p]));
  const victory = (await DB.prepare(`SELECT COUNT(*) n FROM game_factions WHERE game_id = ? AND status = 'active'`).bind(G).first()).n;
  check('it is not an "active empire" for victory, senate or elimination', victory === 2, String(victory));

  // The Herald: one Leviathan story an edition, a paragraph a moment.
  const { composeHeraldForTickRange } = await import('../worker/digest.js');
  const h = await composeHeraldForTickRange({ DB }, { id: G, name: 'Deep' }, 0, k.gone_at_tick);
  const text = `${h.title}\n${h.description}\n${h.fields.map(f => `${f.name}\n${f.value}`).join('\n')}`;
  // It leads the edition: the lead story is the description, a paragraph
  // a moment. (A battle desk story may also name it, as the attacker.)
  const lead = h.description.split('\n\n').slice(1);
  check('the Herald leads with the whole hunt, a paragraph a moment',
    lead.length >= 8 && lead.filter(p => /Leviathan|creature|beast|monster|gate/i.test(p)).length >= 5,
    `${lead.length} paragraphs\n${text.slice(0, 600)}`);
  check('...and the Leviathan holds no row in the standings',
    !h.fields.some(f => /Where things stand/.test(f.name) && /Leviathan/.test(f.value)),
    h.fields.find(f => /Where things stand/.test(f.name))?.value);
  check('...with nothing unfilled in it', !/undefined|NaN|\{|\}/.test(text), text.slice(0, 600));
  console.log(`      Herald: ${h.title}`);
  if (process.argv.includes('--herald')) console.log(text);
}

// ---- B. The kill --------------------------------------------------------
{
  const G = 'gkaijukill';
  const { DB, fA, settle, run } = await seed(G, { kaiju_appetite: 3 });
  await settle('pluto', fA.id);
  let t = 1;
  for (; t <= 400; t++) {
    await run(t);
    const k = await kRow(DB, G);
    if (k?.phase === 'hunting' && k.target_body_id) break;
  }
  const k0 = await kRow(DB, G);
  // A fleet waits where it is headed, and its hide is down to almost nothing.
  for (let i = 0; i < 6; i++) {
    await DB.prepare(
      `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, 'destroyer', ?, 8, 8, 0, 0, 0, 1, 99, 99, 'active', 0, 1000, 1000, 87.5)`,
    ).bind(`${G}:hunter${i}`, G, fA.id, `Harpoon ${i}`, k0.target_body_id).run();
  }
  await DB.prepare('UPDATE game_ships SET hp = 1 WHERE id = ?').bind(kaijuShipId(G)).run();
  let dead = null;
  for (t += 1; t <= 600; t++) {
    await run(t);
    const k = await kRow(DB, G);
    if (k?.phase === 'dead') { dead = k; break; }
  }
  check('a fleet waiting at its prey kills it', !!dead, `phase ${(await kRow(DB, G))?.phase}`);
  if (dead) {
    const carcass = await DB.prepare('SELECT * FROM game_bodies WHERE id = ?').bind(kaijuCarcassId(G)).first();
    check('its carcass stays where it died, as a metal salvage field',
      carcass?.type === 'meteoroid' && carcass.mineral_kind === 'metal'
      && carcass.mineral_remaining === 1000 && carcass.parent_body_id === dead.died_at_body_id,
      JSON.stringify(carcass && { type: carcass.type, kind: carcass.mineral_kind, left: carcass.mineral_remaining, parent: carcass.parent_body_id, died: dead.died_at_body_id }));
    const seen = (await DB.prepare(`SELECT COUNT(*) n FROM game_body_discoveries WHERE body_id = ?`).bind(kaijuCarcassId(G)).first()).n;
    check('every empire knows where the carcass is', seen === 2, String(seen));
    const rows = await kinds(DB, G);
    const d = rows.find(r => r.kind === 'kaiju_dead');
    const p = JSON.parse(d?.payload || '{}');
    check('the death is in the log with the killer named', !!d && !!p.killer_faction_name, d?.payload);
  }
}

// ---- C. The double tap --------------------------------------------------
{
  const G = 'gkaijutap';
  const { DB, fA, settle, run } = await seed(G, { kaiju_appetite: 1 });
  await settle('titan', fA.id, 'city');
  await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 1 WHERE id = ?').bind(`${G}:titan`).run();
  // Titan the only world it may eat (the rest already rubble), so the
  // random pick has to be the living world.
  await DB.prepare(`UPDATE game_bodies SET obliterated_at_tick = 0
                     WHERE game_id = ? AND id <> ? AND type IN ('terrestrial', 'dwarf', 'moon')
                       AND id NOT IN (SELECT capital_body_id FROM game_factions WHERE capital_body_id IS NOT NULL)`)
    .bind(G, `${G}:titan`).run();
  for (let t = 1; t <= 400; t++) {
    await run(t);
    if ((await kRow(DB, G))?.phase === 'gone') break;
  }
  const rows = await kinds(DB, G);
  const at = (kind) => rows.filter(r => r.kind === kind && r.body_id === `${G}:titan`);
  const charges = at('kaiju_charging');
  check('a living world: wind-up, strip, wind-up again, break',
    charges.length === 2 && at('terraform_destroyed').length === 1 && at('world_obliterated').length === 1
    && JSON.parse(charges[0].payload).mode === 'sterilise' && JSON.parse(charges[1].payload).mode === 'obliterate'
    && at('terraform_destroyed')[0].tick_number < at('world_obliterated')[0].tick_number,
    rows.map(r => `T${r.tick_number} ${r.kind}`).join(', '));
  const k = await kRow(DB, G);
  check('...counted as ONE world eaten, then it leaves', k.eaten === 1 && k.phase === 'gone', `${k.eaten} ${k.phase}`);
}

// ---- D. Launched into a game whose gates are already open ---------------
{
  const G = 'gkaijunow';
  const { DB, fA, settle, run, room } = await seed(G, { kaiju: 0, kaiju_appetite: 1 });
  await settle('titania', fA.id);
  let t = 1;
  for (; t <= 120; t++) await run(t);
  const open = (await DB.prepare(`SELECT COUNT(*) n FROM game_megastructures WHERE game_id = ? AND transit_fraction IS NOT NULL`).bind(G).first()).n;
  check('with the dial off, both gates come out of the Sun as before', open === 4 && !(await kRow(DB, G)), String(open));
  // The host tool: turn it on and launch it now.
  const cfgRow = await DB.prepare('SELECT overrides FROM game_configs WHERE id = ?').bind(`cfg_${G}`).first();
  await DB.prepare('UPDATE game_configs SET overrides = ? WHERE id = ?')
    .bind(JSON.stringify({ ...JSON.parse(cfgRow.overrides), kaiju: 1 }), `cfg_${G}`).run();
  invalidate(G);
  const { launchKaijuNow } = await import('../worker/kaiju.js');
  const { cfg } = await import('../worker/gameConfig.js');
  const conf = await cfg({ DB }, G);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  const made = await launchKaijuNow({ DB }, G, t, conf, {
    planLeg: (shipId, factionId, fromId, toId, arrive) => room.planLegForShip(G, t, shipId, factionId, fromId, toId, arrive),
  });
  check('launchKaijuNow sends it at an open gate', !!made?.hp && !!made.gate, JSON.stringify(made));
  const again = await launchKaijuNow({ DB }, G, t, conf, { planLeg: async () => {} });
  check('...and only once a game', again?.error === 'already_had_one', JSON.stringify(again));
  const k0 = await kRow(DB, G);
  for (t += 1; t <= k0.arrive_tick + 120; t++) {
    await run(t);
    if ((await kRow(DB, G))?.phase === 'gone') break;
  }
  const rows = await kinds(DB, G);
  const launch = rows.find(r => r.kind === 'kaiju_launched');
  const arrived = rows.find(r => r.kind === 'kaiju_hunting' && JSON.parse(r.payload).first);
  check('it says it brought no gate, and that it came to one',
    JSON.parse(launch?.payload || '{}').carried === false && JSON.parse(arrived?.payload || '{}').carried === false,
    `${launch?.payload} / ${arrived?.payload}`);
  const k = await kRow(DB, G);
  check('...then hunts and leaves like any other', k.eaten === 1 && k.phase === 'gone', `${k.eaten} ${k.phase}`);
  const { composeHeraldForTickRange } = await import('../worker/digest.js');
  const h = await composeHeraldForTickRange({ DB }, { id: G, name: 'Now' }, t - 400, t);
  const lead = h.description.split('\n\n').slice(1).join('\n');
  check('the Herald never claims it carried a gate in', !/(carries|carrying|dropped|left|set|shed|let go of|unfolded)[^.]*gate/i.test(lead), lead);
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nALL LEVIATHAN CHECKS PASS');
