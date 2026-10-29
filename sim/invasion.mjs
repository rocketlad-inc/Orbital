// ============================================================
// THE THREE BODY EVENT, driven end to end through the REAL resolveTick
// (worker/invasion.js).
//
// Lorne, 2026-10-28 (phase 1 rewritten the same evening):
//   1. A structure with 10,000 hull points starts, hidden, in orbit of an
//      outer planet on the right of the system. Once an empire's sensors
//      find it, it switches on: science drops 25% and one more point each
//      tick, until it is destroyed. Nothing in the log says why.
//   2. 24 ticks after it switches on, a fleet leaves Verdant (Alpha
//      Centauri) on a trip 75% as long as a player's ship needs.
//   3. At a random point on the right of the solar system it lays a gate
//      wired to a twin on the rim of Centauri that faces Sol.
//   4. It takes the nearest settled world, digs in for 40 ticks, takes
//      Earth, then raises destroyers and takes the home worlds one by one.
//
// Run: node sim/invasion.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import {
  invasionDials, blightMult, rollStartTick, invaderTicks, blightFor,
  invasionFactionId, invasionGateId, invasionTwinId, invasionSiteId, invasionEmitterId,
} from '../worker/invasion.js';
import { legTicks, SHIP_ENGINE_ACCEL } from '../worker/burn.js';
import { makeRouteMath } from '../worker/routeMath.js';
import { invalidate } from '../worker/gameConfig.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// ---- 1. The pure rules ------------------------------------------------
{
  const d = invasionDials({ invasion: 1, far_systems: 1 });
  check("on needs the far systems", d.on && !invasionDials({ invasion: 1 }).on && !invasionDials({ far_systems: 1 }).on);
  check("defaults: 25% down, +1 a tick, capped at 65%, 24 ticks to launch, 10,000 hull, 75% trip time",
    d.debuff === 0.25 && d.growth === 0.01 && d.maxCut === 0.65 && d.launchDelay === 24
      && d.emitterHp === 10000 && d.speed === 0.75, JSON.stringify(d));

  const table = [0, 1, 10, 20, 39].map(k => Math.round(blightMult(100, null, 100 + k, d) * 100));
  check("the blight is 75% the tick the emitter comes on and deepens a point a tick: 75, 74, 65, 55, 36",
    table.join() === "75,74,65,55,36", table.join());
  check("it stops deepening at the ceiling: 35% from the 40th tick on, however long it runs",
    Math.round(blightMult(100, null, 140, d) * 100) === 35 && Math.round(blightMult(100, null, 900, d) * 100) === 35);
  check("it is absent before the emitter is on, and gone the tick it is destroyed",
    blightMult(100, null, 99, d) === 1 && blightMult(null, null, 5, d) === 1
      && blightMult(100, 130, 129, d) < 1 && blightMult(100, 130, 130, d) === 1 && blightMult(100, 130, 500, d) === 1);

  const starts = Array.from({ length: 40 }, (_, i) => rollStartTick(`g${i}`, d));
  check("the start tick is seeded inside the window and varies by game",
    starts.every(t => t >= d.start && t <= d.end) && new Set(starts).size > 10
      && rollStartTick("same", d) === rollStartTick("same", d));

  const ratio = [3000, 9000, 30000].map(dist => invaderTicks(dist, 0.75) / legTicks(dist, SHIP_ENGINE_ACCEL));
  check("their trip is about 75% of a player hull on a long haul (short hops round up to whole ticks)",
    ratio.every(r => r >= 0.74 && r <= 0.8), ratio.map(r => r.toFixed(3)).join());
}

// ---- 2. A real game ---------------------------------------------------
const LIVE = { far_systems: 1, system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4 };

async function seed(G, extra = {}, third = false) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const now = Date.now();
  for (const u of third ? ['u1', 'u2', 'u3'] : ['u1', 'u2']) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
      .bind(u, `${u}@t`, u, now).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Deep','u1',?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?,'setup','invasion',0,3600000,?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
  if (third) await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u3',?,'venus')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'k', 'archived', ?, 0, 0)`)
    .bind(`cfg_${G}`, JSON.stringify({ ...LIVE, invasion: 1, invasion_start: 5, invasion_end: 5, ...extra })).run();
  await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${G}`, G).run();
  invalidate(G);
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
  const fA = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first());
  const fB = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first());
  const settle = async (tpl, owner, type = 'station') => {
    const id = `${G}:${tpl}`;
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 400, 400, 1, 0, 0)`,
    ).bind(`st_${G}_${tpl}`, G, id, owner, type, `${tpl} base`).run();
    await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(owner, id).run();
  };
  // A player hull parked at a body: a scout to find things, or a gun to break them.
  const park = async (name, owner, bodyId, dmg = 0) => {
    await DB.prepare(
      `INSERT INTO game_ships
         (id, game_id, owner_faction_id, name, ship_class, parent_body_id, orbit_rp, orbit_ra, orbit_omega,
          orbit_m0, orbit_epoch, orbit_direction, fuel, fuel_max, status, built_at_tick,
          hp, hp_max, damage_per_tick, stance)
       VALUES (?, ?, ?, ?, 'frigate', ?, 6, 6, 0, 0, 0, 1, 0, 0, 'active', 0, 5000, 5000, ?, 'attack')`,
    ).bind(`${G}:${name}`, G, owner, name, bodyId, dmg).run();
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
  return { env, DB, fA, fB, settle, park, run, room };
}

const inv = (DB, G) => DB.prepare('SELECT * FROM game_invasion WHERE game_id = ?').bind(G).first();
const kinds = async (DB, G) => (await DB.prepare(
  `SELECT kind, tick_number, body_id, payload, visibility FROM chronicle_entries
    WHERE game_id = ? AND kind LIKE 'invasion_%' ORDER BY tick_number, created_at_ms`).bind(G).all()).results ?? [];

// ---- A. Emitter, discovery, blight, launch, trip, gate --------------------
{
  const G = 'invA';
  const conf = { ...LIVE, invasion: 1, invasion_start: 5, invasion_end: 5 };
  const { DB, fA, park, run } = await seed(G);
  const base = await seed('invB', { invasion: 0 });
  const science = async (db, fid) => Number((await db.prepare('SELECT science FROM game_factions WHERE id = ?').bind(fid).first()).science);
  const both = async (t) => { await run(t); await base.run(t); };

  for (let t = 1; t <= 4; t++) await both(t);
  let row = await inv(DB, G);
  check("the event row exists, with the start tick the config asked for", row?.start_tick === 5 && row.phase === 'pending', JSON.stringify(row));

  await both(5);
  row = await inv(DB, G);
  check("at the start tick the emitter is placed and hidden", row.phase === 'hidden' && row.emitter_body_id === invasionEmitterId(G), JSON.stringify(row));
  const em = await DB.prepare(
    `SELECT b.parent_body_id, b.owner_faction_id, b.type, h.type AS host_type, m.kind, m.hp, m.status
       FROM game_bodies b JOIN game_megastructures m ON m.body_id = b.id
       JOIN game_bodies h ON h.id = b.parent_body_id WHERE b.id = ?`).bind(invasionEmitterId(G)).first();
  check("it is a 10,000-hull structure in orbit of a gas or ice giant", em?.kind === "blight_emitter" && em.hp === 10000
    && em.status === "complete" && ["gas-giant", "ice-giant"].includes(em.host_type), JSON.stringify(em));
  const rm = makeRouteMath(DB, G);
  const hostPos = await rm.bodyPosAt(em.parent_body_id, 5);
  check("...on the right side of the system (+x)", hostPos.x > 0, JSON.stringify(hostPos));
  check("...owned by the invaders, so ordinary siege can break it", em.owner_faction_id === invasionFactionId(G));
  const seen = (await DB.prepare("SELECT COUNT(*) AS n FROM game_body_discoveries WHERE body_id = ?").bind(invasionEmitterId(G)).first()).n;
  check("nobody has seen it, and the log says nothing", seen === 0 && (await kinds(DB, G)).length === 0);

  // Nobody is near: it stays hidden, and science is untouched.
  await both(6); await both(7);
  row = await inv(DB, G);
  check("still hidden while no empire's sensors cover it", row.phase === "hidden" && row.activated_tick == null);
  check("...and science is untouched", (await science(DB, fA.id)) === (await science(base.DB, base.fA.id)));

  // A scout arrives at the planet it orbits.
  await park("scout", fA.id, em.parent_body_id);
  await both(8);
  row = await inv(DB, G);
  check("a scout at the planet finds it and switches it on that tick", row.phase === "blight" && row.activated_tick === 8
    && row.found_by_faction_id === fA.id, JSON.stringify(row));
  const disc = await DB.prepare("SELECT faction_id FROM game_body_discoveries WHERE body_id = ?").bind(invasionEmitterId(G)).all();
  check("the finder, and only the finder, can now see it", disc.results.length === 1 && disc.results[0].faction_id === fA.id);
  const found = (await kinds(DB, G)).filter(k => k.kind === "invasion_emitter_found");
  check("they are told in their own log (private to them)", found.length === 1 && JSON.parse(found[0].visibility).join() === fA.id, JSON.stringify(found));
  check("and nobody else is told anything", (await kinds(DB, G)).every(k => k.kind === "invasion_emitter_found"));

  // The blight, tick by tick, through the real harvest.
  let withEvent = 0, without = 0;
  const phaseAt = {};
  for (let t = 9; t <= 47; t++) {
    const a0 = await science(DB, fA.id), b0 = await science(base.DB, base.fA.id);
    await both(t);
    withEvent += (await science(DB, fA.id)) - a0; without += (await science(base.DB, base.fA.id)) - b0;
    phaseAt[t] = (await inv(DB, G)).phase;
  }
  const share = withEvent / without;
  check("science really is cut: about 55% of an ordinary game over the first 40 ticks (75% falling to 36%)",
    without > 20 && share > 0.49 && share < 0.62, `${withEvent} of ${without} = ${share.toFixed(3)}`);
  check("the fleet waits 24 ticks after the emitter comes on, then goes", phaseAt[31] === "blight" && phaseAt[32] === "transit",
    `${phaseAt[31]} / ${phaseAt[32]}`);
  row = await inv(DB, G);

  // The blight outlives the launch and sits at its ceiling.
  const mid = await blightFor(DB, G, 60, conf);
  check("it keeps running after the fleet has left, held at 35% of normal science", mid && Math.abs(mid.multiplier - 0.35) < 1e-9, JSON.stringify(mid));
  check("the state payload carries a number and no lapse date", mid.until_tick >= 1e9);

  const fleet = (await DB.prepare(`SELECT ship_class, parent_body_id FROM game_ships WHERE owner_faction_id = ? AND status = 'active'`)
    .bind(invasionFactionId(G)).all()).results;
  check("14 hulls left Verdant: 8 frigates, 4 destroyers, 2 colony ships",
    fleet.length === 14 && fleet.filter(s => s.ship_class === "frigate").length === 8
      && fleet.filter(s => s.ship_class === "destroyer").length === 4
      && fleet.filter(s => s.ship_class === "colony").length === 2, JSON.stringify(fleet.slice(0, 3)));
  const faction = await DB.prepare("SELECT status, user_id FROM game_factions WHERE id = ?").bind(invasionFactionId(G)).first();
  check("they are a monster-status faction with no seat", faction?.status === "monster" && faction.user_id == null);
  const launched = (await kinds(DB, G)).filter(k => k.kind === "invasion_launched");
  check("everyone is told of the launch, once", launched.length === 1 && launched[0].tick_number === 32, JSON.stringify(launched));

  const a = await rm.bodyPosAt(`${G}:verdant`, 32);
  const b = await rm.bodyPosAt(invasionSiteId(G), row.arrive_tick);
  const playerT = legTicks(Math.hypot(b.x - a.x, b.y - a.y), SHIP_ENGINE_ACCEL);
  const theirT = row.arrive_tick - 32;
  check("their trip is about 75% of a player hull's over the same lane",
    theirT / playerT >= 0.74 && theirT / playerT <= 0.8, `${theirT} vs ${playerT} = ${(theirT / playerT).toFixed(3)}`);
  check("the landing point is on the right of the solar system (+x)", b.x > 0, JSON.stringify(b));

  // Shoot the emitter down with a real siege: a gun parked on it.
  const hp0 = (await DB.prepare("SELECT hp FROM game_megastructures WHERE body_id = ?").bind(invasionEmitterId(G)).first()).hp;
  await park("gun", fA.id, invasionEmitterId(G), 4000);
  await both(48);
  const hp1 = (await DB.prepare("SELECT hp FROM game_megastructures WHERE body_id = ?").bind(invasionEmitterId(G)).first())?.hp;
  check("a gun parked on it wears its hull down, as it would any enemy structure", hp1 < hp0, `${hp0} -> ${hp1}`);
  let destroyedAt = null;
  const sciAfter = { e: 0, b: 0 };
  for (let t = 49; t <= 60; t++) {
    const a0 = await science(DB, fA.id), b0 = await science(base.DB, base.fA.id);
    await both(t);
    const r = await inv(DB, G);
    if (r.emitter_destroyed_tick != null && destroyedAt == null) { destroyedAt = r.emitter_destroyed_tick; continue; }
    if (destroyedAt != null) { sciAfter.e += (await science(DB, fA.id)) - a0; sciAfter.b += (await science(base.DB, base.fA.id)) - b0; }
  }
  check("it is destroyed when its hull runs out", destroyedAt != null && destroyedAt <= 52, `${destroyedAt}`);
  const gone = await DB.prepare("SELECT (SELECT COUNT(*) FROM game_megastructures WHERE body_id = ?) AS m, (SELECT destroyed_at_tick FROM game_bodies WHERE id = ?) AS d")
    .bind(invasionEmitterId(G), invasionEmitterId(G)).first();
  check("the structure is gone from the board", gone.m === 0 && gone.d != null, JSON.stringify(gone));
  check("the blight is switched off", (await blightFor(DB, G, destroyedAt, conf)) === null && (await blightFor(DB, G, 500, conf)) === null);
  check("...and science is back to an ordinary game's", sciAfter.b > 3 && sciAfter.e / sciAfter.b > 0.9, `${sciAfter.e} of ${sciAfter.b}`);
  const down = (await kinds(DB, G)).filter(k => k.kind === "invasion_emitter_destroyed");
  check("everyone is told it is destroyed", down.length === 1, JSON.stringify(down));
  check("the fleet already launched is not recalled", (await inv(DB, G)).phase === "transit");

  // On to the gate.
  let t = 61;
  for (; t <= row.arrive_tick + 3; t++) {
    await run(t);
    if ((await inv(DB, G)).phase !== "transit") break;
  }
  row = await inv(DB, G);
  check("on arrival the gate goes down and the siege begins", row.phase === "siege", row.phase);
  const gate = await DB.prepare(
    `SELECT m.status, m.partner_body_id, m.founded_by_faction_id, m.hp, b.owner_faction_id FROM game_megastructures m
       JOIN game_bodies b ON b.id = m.body_id WHERE m.body_id = ?`).bind(invasionGateId(G)).first();
  const twin = await DB.prepare(`SELECT m.status, m.partner_body_id, b.parent_body_id, b.owner_faction_id FROM game_megastructures m JOIN game_bodies b ON b.id = m.body_id WHERE m.body_id = ?`)
    .bind(invasionTwinId(G)).first();
  check("the gate is theirs, complete, with a twin",
    gate?.status === "complete" && gate.owner_faction_id === invasionFactionId(G) && gate.hp > 0
      && gate.partner_body_id === invasionTwinId(G) && twin?.partner_body_id === invasionGateId(G), JSON.stringify({ gate, twin }));
  check("both ends are OWNED by the invaders, which is what lets a siege wear them down",
    twin?.owner_faction_id === invasionFactionId(G));
  check("the twin is in the Centauri system, orbiting its barycenter", twin?.parent_body_id === `${G}:binary_barycenter`, twin?.parent_body_id);
  {
    const rm2 = makeRouteMath(DB, G);
    const tq = await rm2.bodyPosAt(invasionTwinId(G), row.phase_tick);
    const bq = await rm2.bodyPosAt(`${G}:binary_barycenter`, row.phase_tick);
    const toSol = Math.atan2(0 - bq.y, 0 - bq.x), toTwin = Math.atan2(tq.y - bq.y, tq.x - bq.x);
    const off = Math.abs(Math.atan2(Math.sin(toTwin - toSol), Math.cos(toTwin - toSol))) * 180 / Math.PI;
    check("the twin sits on the rim facing Sol (within 45 degrees of the line to the Sun)", off <= 45.5, `${off.toFixed(1)} degrees off`);
    const worlds = (await DB.prepare(`SELECT orbit_radius, orbit_ra FROM game_bodies WHERE parent_body_id = ? AND type IN ('terrestrial','dwarf','moon','gas-giant','ice-giant')`).bind(`${G}:binary_barycenter`).all()).results;
    const outer = Math.max(...worlds.map(w => Number(w.orbit_ra ?? w.orbit_radius) || 0));
    const rTwin = Math.hypot(tq.x - bq.x, tq.y - bq.y);
    check("...just past the outermost world of that system", rTwin > outer && rTwin < outer * 1.4, `${Math.round(rTwin)} vs ${Math.round(outer)}`);
  }
  // A real siege breaks the gate, too.
  await park("gategun", fA.id, invasionGateId(G), 100);
  await run(t + 1); await run(t + 2); await run(t + 3);
  const gHp = (await DB.prepare("SELECT hp FROM game_megastructures WHERE body_id = ?").bind(invasionGateId(G)).first()).hp;
  check("a gun parked on their gate wears it down (it is breakable, unlike a sun gate)", gHp < gate.hp, `${gate.hp} -> ${gHp}`);
  const ks = (await kinds(DB, G)).map(k => k.kind);
  check("the log tells it in order", ks.indexOf("invasion_launched") < ks.indexOf("invasion_emitter_destroyed")
    && ks.indexOf("invasion_emitter_destroyed") < ks.indexOf("invasion_gate"), ks.join());
}

// ---- E. The backstop, and an emitter destroyed before the fleet goes --------
{
  const G = "invE";
  const { DB, run } = await seed(G, { invasion_start: 3, invasion_end: 3, invasion_reveal_after: 10, invasion_launch_delay: 5 });
  for (let t = 1; t <= 12; t++) await run(t);
  let row = await inv(DB, G);
  check("nobody finds it: it stays hidden until the backstop", row.phase === "hidden", row.phase);
  await run(13);
  row = await inv(DB, G);
  check("...then switches itself on, with no finder", row.phase === "blight" && row.activated_tick === 13 && row.found_by_faction_id == null, JSON.stringify(row));
  check("an unfound emitter tells no one anything", (await kinds(DB, G)).length === 0);
  await DB.prepare("UPDATE game_megastructures SET hp = 0 WHERE body_id = ?").bind(invasionEmitterId(G)).run();
  await run(14);
  row = await inv(DB, G);
  check("destroyed before the fleet leaves, the blight ends", row.emitter_destroyed_tick === 14);
  for (let t = 15; t <= 18; t++) await run(t);
  check("...but the fleet still goes, 24 ticks (here 5) after it came on", (await inv(DB, G)).phase === "transit");
}

// ---- B. The conquest ----------------------------------------------------
{
  const G = "invC";
  // Skip straight to the war: the emitter shows itself at once and the fleet leaves two ticks later.
  const { DB, fA, fB, settle, run } = await seed(G, {
    invasion_start: 3, invasion_end: 3, invasion_reveal_after: 1, invasion_launch_delay: 2, invasion_hunker_ticks: 12,
  }, true);
  await settle("ganymede", fB.id);
  const rm = makeRouteMath(DB, G);
  const phases = [];
  let last = null;
  const step = async (t) => {
    await run(t);
    const r = await inv(DB, G);
    if (r && r.phase !== last) { phases.push(`${r.phase}@${t}`); last = r.phase; }
    return r;
  };
  const until = async (from, max, pred) => {
    let t = from;
    for (; t < from + max; t++) { const r = await step(t); if (r && pred(r)) return { t, r }; }
    return { t, r: await inv(DB, G) };
  };
  const landed = await until(1, 200, r => r.phase === "siege");
  const site = await rm.bodyPosAt(invasionSiteId(G), landed.t);
  const settled = (await DB.prepare(
    `SELECT s.body_id FROM game_settlements s JOIN game_factions f ON f.id = s.owner_faction_id
      WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL AND f.status <> 'monster'`).bind(G).all()).results;
  const ranked = [];
  for (const w of settled) { const q = await rm.bodyPosAt(w.body_id, landed.t); ranked.push({ id: w.body_id, d: Math.hypot(q.x - site.x, q.y - site.y) }); }
  ranked.sort((a, b) => a.d - b.d);

  const sieged = await until(landed.t, 400, r => r.phase === "build");
  check("the fleet takes a world and digs in", sieged.r.phase === "build", phases.join(" "));
  const held = sieged.r.held_body_id;
  check("the world it takes is the settled one nearest the gate", held === ranked[0]?.id,
    `${held} vs ${ranked.map(r => `${r.id.split(":")[1]} ${Math.round(r.d)}`).join(", ")}`);
  const mine = await DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL").bind(held).first();
  check("a settlement of theirs stands on it", mine?.owner_faction_id === invasionFactionId(G), JSON.stringify(mine));
  const lost = await DB.prepare("SELECT COUNT(*) AS n FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NOT NULL AND owner_faction_id <> ?").bind(held, invasionFactionId(G)).first();
  check("the empire that held it lost its settlement in ordinary combat", lost.n >= 1);
  let ks = (await kinds(DB, G)).map(k => k.kind);
  check("the log tells it as it happens", ks.includes("invasion_assault") && ks.includes("invasion_world_taken"), ks.join());

  const b0 = (await inv(DB, G)).built;
  await until(sieged.t + 1, 8, () => false);
  const b1 = (await inv(DB, G)).built;
  check("they raise a frigate every 4 ticks while their gate stands", b1 - b0 === 2, `${b0} -> ${b1}`);
  const base = await DB.prepare("SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id = ? AND parent_body_id = ? AND ship_class = 'frigate' AND status = 'active' AND built_at_tick > ?")
    .bind(invasionFactionId(G), held, sieged.t).first();
  check("...at the world they hold", base.n === 2, `${base.n}`);

  // The counterplay: capture their gate (a capture changes the BODY's owner) and the ships stop.
  await DB.prepare("UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?").bind(fA.id, invasionGateId(G)).run();
  const t2 = (await DB.prepare("SELECT current_tick AS t FROM games WHERE id = ?").bind(G).first()).t;
  await until(t2 + 1, 6, () => false);
  const b2 = (await inv(DB, G)).built;
  check("capture their gate and no more ships come", b2 === b1, `${b1} -> ${b2}`);
  await DB.prepare("UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?").bind(invasionFactionId(G), invasionGateId(G)).run();

  const toEarth = await until(t2 + 7, 200, r => r.phase === "earth" || r.phase === "conquest");
  check("after the dig-in they turn on Earth", ["earth", "conquest"].includes(toEarth.r.phase), phases.join(" "));
  const earth = await until(toEarth.t, 400, r => r.phase === "conquest" || r.phase === "done");
  check("Earth falls and they move on to the home worlds", ["conquest", "done"].includes(earth.r.phase), phases.join(" "));
  const eSet = await DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL").bind(`${G}:earth`).first();
  check("Earth is theirs", eSet?.owner_faction_id === invasionFactionId(G), JSON.stringify(eSet));
  ks = (await kinds(DB, G)).map(k => k.kind);
  check("...and the log says Earth fell", ks.includes("invasion_earth_taken"), ks.join());

  const tail = await until(earth.t, 500, r => r.phase === "done" || r.phase === "repelled");
  check("they take the home worlds one by one and it ends", tail.r.phase === "done", `${JSON.stringify(tail.r)} tick=${tail.t}`);
  const marsLost = await DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL").bind(fB.capital_body_id).first();
  check("the other home world fell to them", marsLost?.owner_faction_id === invasionFactionId(G), JSON.stringify(marsLost));
  const stat = await DB.prepare("SELECT status FROM games WHERE id = ?").bind(G).first();
  check("it is an event, not an ending: the game goes on", stat.status === "active", stat.status);
  const destroyers = await DB.prepare("SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id = ? AND ship_class = 'destroyer' AND built_at_tick >= ?").bind(invasionFactionId(G), earth.t).first();
  check("holding Earth, they raised destroyers", destroyers.n >= 1, `${destroyers.n}`);
  console.log(`        phases: ${phases.join(" -> ")}`);
}

// ---- C. Repelled --------------------------------------------------------
{
  const G = "invD";
  const { DB, run } = await seed(G, { invasion_start: 3, invasion_end: 3, invasion_reveal_after: 1, invasion_launch_delay: 2 });
  let t = 1;
  for (; t < 250; t++) { await run(t); if ((await inv(DB, G))?.phase === "siege") break; }
  await DB.prepare("UPDATE game_ships SET status = 'destroyed', hp = 0 WHERE owner_faction_id = ? AND ship_class <> 'colony'").bind(invasionFactionId(G)).run();
  await run(t + 1);
  const r = await inv(DB, G);
  check("wipe out the fleet and the invasion is repelled", r.phase === "repelled", r.phase);
  const k = (await kinds(DB, G)).map(x => x.kind);
  check("...and everyone is told", k.includes("invasion_repelled"), k.join());
  await run(t + 2); await run(t + 3);
  check("and it stays over", (await inv(DB, G)).phase === "repelled");
  const { gateStands } = await import("../worker/invasion.js");
  check("(their gate, once laid, stands)", await gateStands(DB, G));
  await DB.batch([
    DB.prepare("DELETE FROM game_megastructures WHERE body_id = ?").bind(invasionGateId(G)),
    DB.prepare("UPDATE game_bodies SET destroyed_at_tick = ? WHERE id = ?").bind(t, invasionGateId(G)),
  ]);
  check("a destroyed gate no longer stands", !(await gateStands(DB, G)));
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
