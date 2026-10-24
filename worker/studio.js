// ============================================================================
// studio.js — the video studio: a JSON scene becomes a populated test game.
//
// WHY. Every marketing clip used to start with an afternoon of hand-written
// SQL: orbit radii from parkOrbitRadius, hit points from the class table,
// a city row per world, a war row per pair, a captain before a fleet could
// form, and a Room() conjured outside its Durable Object to plan a burn.
// Each shoot re-learned all of it. This module is that knowledge, once,
// behind one endpoint, so a scene reads like the shot it is for:
//
//   { "name": "Three-way at Earth",
//     "factions": [{ "key": "terra", "home": "earth", ... }, ...],
//     "wars": "all",
//     "ships": [{ "key": "terra_home", "owner": "terra", "at": "earth",
//                 "mix": { "destroyer": 4, "frigate": 4 }, "loadout": "mixed" }],
//     "orders": [{ "type": "move", "ships": "terra_moon", "to": "luna" }] }
//
// WHAT IT TOUCHES. Only games flagged is_test_game (it refuses anything
// else), and inside them only rows it created: every id it writes carries
// the `st_` mark, so `reset` deletes exactly its own work and a scene can
// be re-applied until the shot is right. A new scene is seated with agent
// players (handles `studio-<key>`) through the real lobby, so the game is
// a real game: ticks, combat, fog and the Herald all behave as they do for
// players. Camera factions are given Sensors 10 (Total Awareness), which
// is the game's own "see every ship" rule, so no fog code is special-cased.
//
// WHO. The admin allow-list (admins.js), or the agent key: an agent runs
// the same scene from scripts/studio.mjs without an admin cookie. Docs for
// both audiences: docs/STUDIO.md.
// ============================================================================

import { isAdminSession } from './admins.js';
import { constantTimeEqual, getOrCreateAgentUser } from './auth.js';
import { startGame } from './lobby.js';
import {
  BODY_CATALOG, SHIP_COMBAT_STATS, parkOrbitRadius, parkPhaseFor,
  isValidStartingBody, recomputeBodyOwnership,
} from './factions.js';
import { computeShipStats, DEFAULT_LOADOUTS, validateParts, LENIENT, SHIP_SLOT_COUNTS } from './shipDesigns.js';
import { openWarBetween } from './wars.js';
import { SLIDER_CATALOG, describeSlider } from './senate.js';
import { ensureCaptainFloor, ensureCaptains } from './captains.js';
import { EMBLEM_IDS } from './emblems.js';
import {
  STUDIO_MARK, SHIP_CLASSES, LOADOUT_PRESETS, FUEL_MAX, TAG, whenTick, expandScenario, EXAMPLES, solveMoveTiming, ROGUE_ASTEROIDS,
  expandTakeOrder,
} from './studioScene.js';
import {
  routes as actionRoutes, MEGA_STRIKE_CHARGE_TICKS, RAM_ASTEROID_G, RAM_G_ANCHOR, RAM_METAL_PER_DV,
} from './actions.js';
import { routes as tradeRoutesV2 } from './tradeRoutesV2.js';
import { routes as missileRoutes } from './missiles.js';
import { backfillMissingBodies } from './factions.js';
import { cfg as gameCfg, invalidate as invalidateCfg } from './gameConfig.js';
import { BY_ID as CONFIG_DIALS } from './configSchema.js';
import { spawnSunGatePair, SUN_GATE_SYSTEMS, SUN_GATE_WARNING_TICKS, gateOrder, handOffLandingSite, solGateId } from './sunGates.js';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS, MEGA_MU, MEGA_MAX_HP, MEGA_BODY_TYPE, periodForRadius, angle0For, bodyPositionAt } from './megastructures.js';
import { makeRouteMath } from './routeMath.js';
import { launchKaiju, kaijuShipId, kaijuFactionId, kaijuCarcassId, KAIJU_UNKNOWN_FACTION } from './kaiju.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message, extra = {}) {
  return json({ error: { code, message, ...extra } }, { status });
}
async function readJson(req) { try { return await req.json(); } catch { return null; } }

// ---------- auth ----------

/** The studio is for operators and their agents. Same 404 as an unmapped
 *  route for anyone else: probing learns nothing. */
async function allowed(req, env, session) {
  if (isAdminSession(session)) return true;
  const presented = req.headers.get('x-agent-key');
  if (env.AGENT_KEY && presented && (await constantTimeEqual(presented, env.AGENT_KEY))) return true;
  return false;
}

/** An agent player seated in THIS studio game may run its ticks: agent
 *  accounts exist only through the key, and a seat in a test game is the
 *  studio's own doing. Nobody else, and never a real game. */
async function allowedInGame(req, env, session, gameId) {
  if (await allowed(req, env, session)) return true;
  if (!session || !/@agents\.orbital\.local$/.test(String(session.email ?? ''))) return false;
  const row = await env.DB
    .prepare(`SELECT 1 AS x FROM room_members m JOIN games g ON g.id = m.room_id
               WHERE m.room_id = ? AND m.user_id = ? AND COALESCE(g.is_test_game, 0) = 1`)
    .bind(gameId, session.user_id).first();
  return !!row;
}

// ---------- the scene ----------

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

/** Seat the scene's factions in a fresh room through the real lobby and
 *  start it. Returns the game id. */
async function createStudioGame(env, spec, session) {
  const now = Date.now();
  const users = [];
  for (const f of spec.factions) {
    if (spec.seatMe && session && f.key === spec.viewer) {
      users.push({ id: session.user_id, display_name: session.display_name ?? 'Director' });
    } else {
      const u = await getOrCreateAgentUser(env.DB, f.handle);
      users.push({ id: u.id, display_name: u.display_name });
    }
  }
  const id = newRoomId();
  const roomName = `Studio: ${spec.name}`.slice(0, 60);
  const host = users[0];
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at, invite_code, password_hash, quick_join) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .bind(id, roomName, host.id, 'lobby', spec.factions.length, now, now, newInviteCode(), null),
    ...users.map((u, i) => env.DB
      .prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(id, u.id, now + i)),
  ]);
  await roomStub(env, id).fetch('https://room/init', {
    method: 'POST',
    body: JSON.stringify({
      meta: { id, name: roomName, hostId: host.id, status: 'lobby', maxPlayers: spec.factions.length, createdAt: now },
      members: Object.fromEntries(users.map(u => [u.id, { userId: u.id, displayName: u.display_name }])),
    }),
  });
  await env.DB.batch(spec.factions.map((f, i) => env.DB
    .prepare('UPDATE room_members SET empire_name = ?, chosen_starting_body = ?, color = ?, color2 = ?, emblem = ? WHERE room_id = ? AND user_id = ?')
    .bind(f.name, f.home, f.color, f.color2, f.emblem, id, users[i].id)));
  const started = await startGame(env, id);
  if (started.error) throw new Error(`could not start the scene: ${await started.error.text()}`);
  await env.DB
    .prepare('UPDATE games SET is_test_game = 1, tick_interval_ms = ?, next_tick_at = ? WHERE id = ?')
    .bind(spec.tickIntervalMs, now + spec.tickIntervalMs, id).run();
  return id;
}

/** Map scene faction keys to game_factions rows, by empire name first and
 *  then by seat order. */
async function resolveFactions(env, gameId, spec) {
  const rows = (await env.DB
    .prepare('SELECT id, slot, name, user_id FROM game_factions WHERE game_id = ? ORDER BY slot')
    .bind(gameId).all()).results ?? [];
  const byKey = new Map();
  spec.factions.forEach((f, i) => {
    const row = rows.find(r => r.name === f.name) ?? rows[i];
    if (!row) throw new Error(`faction '${f.key}' has no seat in ${gameId}`);
    byKey.set(f.key, row);
  });
  return byKey;
}

/** Delete everything a previous apply wrote. The mark makes this exact. */
async function resetStudioRows(env, gameId) {
  const like = `${gameId}:${STUDIO_MARK}%`;
  await env.DB.batch([
    // The event log keys entries to hulls without ON DELETE: after a
    // tick of combat, a studio hull is "the ship that fired", and the
    // hull cannot go until its entries do. A re-shot scene starts clean.
    env.DB.prepare('DELETE FROM chronicle_entries WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM game_ship_nodes WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM game_trade_route_ships WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, like),
    env.DB.prepare("DELETE FROM game_trade_route_stops WHERE game_id = ? AND route_id IN (SELECT id FROM game_trade_routes WHERE game_id = ? AND ship_id LIKE ?)").bind(gameId, gameId, like),
    env.DB.prepare('DELETE FROM game_trade_routes WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, like),
    // Captains sit on BOTH tables (captain.ship_id and ship.captain_id). The
    // hull goes; its captain returns to the bank, or the next apply finds
    // every captain still 'assigned' to a dead hull and seats no fleet.
    env.DB.prepare('UPDATE game_captains SET ship_id = NULL WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM game_ships WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM game_settlements WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM game_fleets WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM senate_votes WHERE proposal_id LIKE ?').bind(like),
    env.DB.prepare('DELETE FROM senate_effects WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM senate_proposals WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    env.DB.prepare('DELETE FROM senate_terms WHERE game_id = ? AND id LIKE ?').bind(gameId, like),
    // A sphere founded on a studio station goes with it (the station is
    // deleted above, and a sphere without its foundation collapses).
    env.DB.prepare(`UPDATE games SET dyson_controller_faction_id = NULL, dyson_foundation_settlement_id = NULL,
        dyson_started_at_tick = NULL, dyson_hp = NULL, dyson_station_last_hp = NULL,
        dyson_acc_fuel = 0, dyson_acc_ore = 0, dyson_acc_credits = 0, dyson_acc_science = 0
       WHERE id = ? AND dyson_foundation_settlement_id LIKE ?`).bind(gameId, like),
  ]);
  // Salvos a previous take launched (missiles.js ids '<game>:msl_<tick>_…').
  // Not studio-marked, but only ever in a test game here; a re-take starts
  // with none in the sky. Servers without missiles have no such rows.
  const msl = `${gameId}:msl_%`;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chronicle_entries WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, msl),
    env.DB.prepare('DELETE FROM game_ship_nodes WHERE game_id = ? AND ship_id LIKE ?').bind(gameId, msl),
    env.DB.prepare('DELETE FROM game_ships WHERE game_id = ? AND id LIKE ?').bind(gameId, msl),
  ]);
  await retireStudioSites(env, gameId);
  await resetKaiju(env, gameId);
}

/**
 * A previous take's megastructures (ids `<game>:st_mega_<key>`), RETIRED,
 * never deleted (2026-10-23). game_ships.parent_body_id is ON DELETE
 * CASCADE, so deleting a site silently deletes every hull parked at it,
 * and flight plans and chronicle lines that name it have no ON DELETE at
 * all, so D1 refuses the DELETE (megaLaunch.js learnt both the hard way).
 * The same moves megaLaunch makes when a slipway launches: whatever is
 * parked there drops to the world the site orbits, legs still flying to it
 * land there, the structure row goes and the body is marked destroyed.
 * The next apply brings a site back on the same id (upsertSite).
 *
 * A site a take FOUNDED (a mid-take `found` order, 2026-10-23) goes the
 * same way: the real handler names it '<game>:mega_<random>', with no
 * studio mark, so it is found by what only a player's founding leaves, a
 * founder and no ancient flag. Relics and discovered gates have neither.
 * Test games only ever reach this.
 */
async function retireStudioSites(env, gameId) {
  const founded = ((await env.DB
    .prepare(`SELECT body_id FROM game_megastructures
               WHERE game_id = ? AND body_id LIKE ? AND founded_by_faction_id IS NOT NULL AND COALESCE(ancient, 0) = 0`)
    .bind(gameId, `${gameId}:mega_%`).all()).results ?? []).map(r => r.body_id);
  const parentOf = '(SELECT b.parent_body_id FROM game_bodies b WHERE b.id = game_ships.parent_body_id)';
  for (const [op, sites] of [['LIKE', `${gameId}:${STUDIO_MARK}mega_%`], ...founded.map(id => ['=', id])]) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE game_ships SET parent_body_id = ${parentOf} WHERE game_id = ? AND parent_body_id ${op} ?`).bind(gameId, sites),
      env.DB.prepare(
        `UPDATE game_ship_nodes SET target_body_id = (SELECT b.parent_body_id FROM game_bodies b WHERE b.id = game_ship_nodes.target_body_id)
          WHERE game_id = ? AND target_body_id ${op} ? AND status IN ('planned', 'committed', 'in_transit')`,
      ).bind(gameId, sites),
      // The log a take wrote about its sites (the launch of a finished
      // slipway is keyed '<site>_launched', and INSERT OR IGNORE would
      // keep the next take's from being written).
      env.DB.prepare(`DELETE FROM chronicle_entries WHERE game_id = ? AND (body_id ${op} ? OR id ${op} ?)`).bind(gameId, sites, sites),
      env.DB.prepare(`DELETE FROM game_megastructures WHERE game_id = ? AND body_id ${op} ?`).bind(gameId, sites),
      env.DB.prepare(
        `UPDATE game_bodies SET destroyed_at_tick = (SELECT current_tick FROM games WHERE id = ?)
          WHERE game_id = ? AND id ${op} ? AND destroyed_at_tick IS NULL`,
      ).bind(gameId, gameId, sites),
    ]);
  }
}

/**
 * A previous take's Leviathan (kaiju.js ids, fixed per game). Exactly
 * these rows and nothing else:
 *   - its hull: the event log keys kills to it with no ON DELETE, so its
 *     lines go first; its flight plans cascade;
 *   - the game_kaiju row, so a launch is possible again;
 *   - the once-only log lines ('<game>:kaiju:launched', ':revealed', ...),
 *     or chronicleOnce would refuse to announce the next take's reveal;
 *   - its carcass, RETIRED like a site (freighters may be parked on it),
 *     which kaiju.js die() brings back if the next take kills it too.
 * Its faction row stays (the log names it as actor and target, with no
 * ON DELETE); it goes back to 'Unknown' until the next take's reveal.
 */
async function resetKaiju(env, gameId) {
  const k = await env.DB.prepare('SELECT ship_id, faction_id FROM game_kaiju WHERE game_id = ?').bind(gameId).first();
  const sid = k?.ship_id ?? kaijuShipId(gameId);
  const fid = k?.faction_id ?? kaijuFactionId(gameId);
  const cid = kaijuCarcassId(gameId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chronicle_entries WHERE game_id = ? AND ship_id = ?').bind(gameId, sid),
    env.DB.prepare('DELETE FROM chronicle_entries WHERE game_id = ? AND id LIKE ?').bind(gameId, `${gameId}:kaiju:%`),
    env.DB.prepare('DELETE FROM game_ship_nodes WHERE game_id = ? AND ship_id = ?').bind(gameId, sid),
    env.DB.prepare('DELETE FROM game_ships WHERE game_id = ? AND id = ?').bind(gameId, sid),
    env.DB.prepare('DELETE FROM game_kaiju WHERE game_id = ?').bind(gameId),
    env.DB.prepare('UPDATE game_factions SET name = ? WHERE id = ? AND game_id = ?').bind(KAIJU_UNKNOWN_FACTION, fid, gameId),
    env.DB.prepare(
      `UPDATE game_ships SET parent_body_id = (SELECT b.parent_body_id FROM game_bodies b WHERE b.id = ?)
        WHERE game_id = ? AND parent_body_id = ?`,
    ).bind(cid, gameId, cid),
    env.DB.prepare(
      `UPDATE game_ship_nodes SET target_body_id = (SELECT b.parent_body_id FROM game_bodies b WHERE b.id = ?)
        WHERE game_id = ? AND target_body_id = ? AND status IN ('planned', 'committed', 'in_transit')`,
    ).bind(cid, gameId, cid),
    env.DB.prepare(
      `UPDATE game_bodies SET destroyed_at_tick = (SELECT current_tick FROM games WHERE id = ?)
        WHERE game_id = ? AND id = ? AND destroyed_at_tick IS NULL`,
    ).bind(gameId, gameId, cid),
  ]);
}

/**
 * Apply a validated scene to its game. Returns a summary: the game id,
 * each faction's seat and handle, every ship id by group, and what each
 * order did.
 */
export async function applyScenario(env, spec, { session = null } = {}) {
  let gameId = spec.gameId;
  let created = false;
  if (gameId) {
    const g = await env.DB.prepare('SELECT id, is_test_game FROM games WHERE id = ?').bind(gameId).first();
    if (!g) throw new Error(`no game ${gameId}`);
    if ((g.is_test_game ?? 0) !== 1) throw new Error(`${gameId} is not a test game; the studio only writes to test games`);
  } else {
    gameId = await createStudioGame(env, spec, session);
    created = true;
  }
  const game = await env.DB.prepare('SELECT current_tick, gating_enabled FROM games WHERE id = ?').bind(gameId).first();
  const tick = Number(game.current_tick) || 0;
  // Reset BEFORE the far systems (2026-10-23): a previous take's sites and
  // Leviathan are cleared before the dials and the gate step look at the
  // board. It touches only studio-marked rows and the kaiju's fixed ids.
  if (spec.reset) await resetStudioRows(env, gameId);
  const gateBirth = spec.farSystems ? await enableFarSystems(env, gameId, tick, spec) : null;
  const factions = await resolveFactions(env, gameId, spec);
  const fid = (key) => factions.get(key).id;

  const bodies = new Map(((await env.DB
    .prepare('SELECT id, template_id, name, type, radius, terraformed_at_tick, parent_body_id, owner_faction_id, destroyed_at_tick FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all()).results ?? []).map(b => [b.template_id, b]));
  const bodyOf = (tpl, where) => {
    const b = bodies.get(tpl);
    if (!b) throw new Error(`${where}: no world '${tpl}' in this game`);
    return b;
  };

  // Every faction sees everything: the game's own Total Awareness rule
  // (Sensors 10), plus whatever the scene asks for.
  const research = [{ faction: 'all', track: 'sensors', level: 10 }, ...spec.research];
  const techStmts = [];
  for (const r of research) {
    const targets = r.faction === 'all' ? [...factions.values()] : [factions.get(r.faction)];
    for (const f of targets) {
      techStmts.push(env.DB
        .prepare("INSERT OR REPLACE INTO faction_techs (game_id, faction_id, tech_id, status, started_at_tick, completed_at_tick, level) VALUES (?, ?, ?, 'completed', 0, 0, ?)")
        .bind(gameId, f.id, r.track, r.level));
    }
  }
  if (techStmts.length) await env.DB.batch(techStmts);
  const stockStmts = spec.factions.filter(f => f.metal != null || f.gold != null).map(f => env.DB
    .prepare('UPDATE game_factions SET metal = COALESCE(?, metal), gold = COALESCE(?, gold) WHERE id = ? AND game_id = ?')
    .bind(f.metal, f.gold, fid(f.key), gameId));
  if (stockStmts.length) await env.DB.batch(stockStmts);

  // ---- worlds ----
  const worldStmts = [];
  // Shield HP per level, the game's own dial (resolveShields derives the
  // cap the same way, so the next tick changes nothing).
  const shieldPer = spec.worlds.some(w => w.shields)
    ? Number((await gameCfg(env, gameId)).shield_hp_per_level ?? 120) : 0;
  for (const w of spec.worlds) {
    const b = bodyOf(w.body, 'worlds');
    if (w.thrusters) {
      if (b.type !== 'asteroid') throw new Error(`worlds: ${w.body} is not a rogue asteroid (${ROGUE_ASTEROIDS.join(', ')})`);
      // A take that ended in the ram consumed the rock (destroyed_at_tick)
      // or left one in flight: the re-shot scene starts with the rock on
      // its own orbit and no plan, every ram_* column cleared.
      worldStmts.push(env.DB.prepare(
        `UPDATE game_bodies SET destroyed_at_tick = NULL, ram_target_body_id = NULL, ram_start_tick = NULL,
                ram_flip_tick = NULL, ram_arrive_tick = NULL, ram_acceleration = NULL,
                ram_start_pos_x = NULL, ram_start_pos_y = NULL, ram_start_vel_x = NULL, ram_start_vel_y = NULL,
                ram_intercept_pos_x = NULL, ram_intercept_pos_y = NULL, ram_total_dv = NULL, ram_owned_by_faction_id = NULL
          WHERE id = ?`).bind(b.id));
      b.destroyed_at_tick = null;
    }
    if (w.owner) {
      worldStmts.push(env.DB.prepare(
        `UPDATE game_bodies SET owner_faction_id = ?, development_level = CASE WHEN development_level < 2 THEN 2 ELSE development_level END,
                claimed_at_tick = COALESCE(claimed_at_tick, ?), developed_at_tick = COALESCE(developed_at_tick, ?),
                terraformed_at_tick = CASE WHEN ? THEN COALESCE(terraformed_at_tick, ?) ELSE terraformed_at_tick END
          WHERE id = ?`).bind(fid(w.owner), tick, tick, w.living ? 1 : 0, tick, b.id));
    } else if (w.living) {
      worldStmts.push(env.DB.prepare('UPDATE game_bodies SET terraformed_at_tick = COALESCE(terraformed_at_tick, ?) WHERE id = ?').bind(tick, b.id));
    }
    if (w.living) b.terraformed_at_tick = b.terraformed_at_tick ?? tick;
    else {
      // A RAW world is raw (living: false), whatever the last take left on
      // it: a found 'pre_terraformed' secret, a terraform, a strike's scar
      // or a debris field (2026-10-23, the obliterate clip). Re-shooting an
      // obliteration used to start on the last take's rubble.
      worldStmts.push(env.DB.prepare(
        `UPDATE game_bodies SET terraformed_at_tick = NULL, terraform_acc_metal = 0, terraform_acc_gold = 0,
                terraform_completes_at_tick = NULL, sterilised_at_tick = NULL, obliterated_at_tick = NULL
          WHERE id = ?`).bind(b.id));
      b.terraformed_at_tick = null;
    }
    if (w.living) {
      // A take that ended in a Mega Destroyer strike leaves the world
      // scarred (sterilised_at_tick) and its settlements dead; a re-shot
      // scene starts with the world it describes. Test games only. The
      // second strike (a Mega Destroyer's, or the Leviathan's) leaves it a
      // debris field (obliterated_at_tick), cleared the same way.
      worldStmts.push(env.DB.prepare('UPDATE game_bodies SET sterilised_at_tick = NULL, obliterated_at_tick = NULL WHERE id = ?').bind(b.id));
      worldStmts.push(env.DB.prepare(
        'UPDATE game_settlements SET destroyed_at_tick = NULL, hp = hp_max WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NOT NULL',
      ).bind(gameId, b.id));
    }
    w.cities.forEach((name, i) => {
      worldStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population,
            surface_angle, created_at_tick, last_growth_tick, last_harvest_tick, has_collector)
         VALUES (?, ?, ?, ?, 'city', ?, 300, 300, 2, ?, ?, ?, ?, 1)`)
        .bind(`${gameId}:${STUDIO_MARK}c_${w.body}_${i}`, gameId, b.id, fid(w.owner ?? spec.viewer), name, (i * 2.1 + 0.4) % 6.28, tick, tick, tick));
      // Orbital Shields, full, as a finished building leaves them (2026-10-23,
      // for a clip of a siege breaking a shield): the level in the city's
      // buildings and the pool at its cap, so the bubble is up on frame one.
      if (w.shields) {
        worldStmts.push(env.DB.prepare(
          `UPDATE game_settlements SET buildings_json = json_set(COALESCE(buildings_json, '{}'), '$.shields', ?),
                  shield_hp = ?, shield_hp_max = ?, shield_down_tick = NULL
            WHERE id = ?`)
          .bind(w.shields, w.shields * shieldPer, w.shields * shieldPer, `${gameId}:${STUDIO_MARK}c_${w.body}_${i}`));
      }
    });
    for (let i = 0; i < w.stations; i++) {
      const r = Number(b.radius) + Math.max(3, 0.22 * Number(b.radius));
      // The first station on a thrusters world carries the Trajectory
      // Control Thrusters, the building the ram handler looks for.
      const built = w.thrusters && i === 0 ? JSON.stringify({ trajectory_thrusters: 1 }) : null;
      worldStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population,
            orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, created_at_tick, last_growth_tick, last_harvest_tick, has_collector, buildings_json)
         VALUES (?, ?, ?, ?, 'station', ?, 400, 400, 1, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`)
        .bind(`${gameId}:${STUDIO_MARK}s_${w.body}_${i}`, gameId, b.id, fid(w.owner ?? spec.viewer), `${b.name} Station ${i + 1}`, r, r, i * 2.5, tick, tick, tick, tick, built));
    }
  }
  if (worldStmts.length) await env.DB.batch(worldStmts);
  for (const w of spec.worlds) if (w.owner) await recomputeBodyOwnership(env.DB, gameId, bodyOf(w.body, 'worlds').id);

  // ---- the Dyson Sphere (sim/dysonRoutes.mjs is the same seed) ----
  if (spec.dyson) {
    const sol = bodyOf('sol', 'dyson');
    const owner = fid(spec.dyson.owner);
    const stId = `${gameId}:${STUDIO_MARK}dyson_found`;
    const r = Number(sol.radius) + Math.max(3, 0.22 * Number(sol.radius));
    const T = { ore: 15000, credits: 15000, science: 10000 };
    const p = spec.dyson.progress;
    const acc = { ore: Math.round(T.ore * p), credits: Math.round(T.credits * p), science: Math.round(T.science * p) };
    const hp = acc.ore + acc.credits + acc.science;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population,
            orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, created_at_tick, last_growth_tick, last_harvest_tick, has_collector)
         VALUES (?, ?, ?, ?, 'station', 'Dyson Foundation', ?, ?, 1, ?, ?, 0, 0, ?, ?, ?, ?, 1)`)
        .bind(stId, gameId, sol.id, owner, spec.dyson.stationHp, spec.dyson.stationHp, r, r, tick, tick, tick, tick),
      env.DB.prepare(
        `UPDATE games SET dyson_controller_faction_id = ?, dyson_foundation_settlement_id = ?, dyson_started_at_tick = ?,
            dyson_target_fuel = 0, dyson_target_ore = ?, dyson_target_credits = ?, dyson_target_science = ?, dyson_max_hp = ?,
            dyson_acc_fuel = 0, dyson_acc_ore = ?, dyson_acc_credits = ?, dyson_acc_science = ?, dyson_hp = ?,
            dyson_station_last_hp = NULL
          WHERE id = ?`)
        .bind(owner, stId, tick, T.ore, T.credits, T.science, T.ore + T.credits + T.science,
          acc.ore, acc.credits, acc.science, hp, gameId),
    ]);
  }

  // ---- meteoroids: seen by who should see them, and full again ----
  for (const m of spec.meteoroids) {
    const b = bodyOf(m.body, 'meteoroids');
    const who = m.discoveredBy === 'all' ? [...factions.values()] : [factions.get(m.discoveredBy)];
    await env.DB.batch([
      ...who.map(f => env.DB.prepare(
        'INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick) VALUES (?, ?, ?, ?)',
      ).bind(gameId, f.id, b.id, tick)),
      env.DB.prepare('UPDATE game_bodies SET mineral_remaining = COALESCE(?, mineral_initial), exhausted_at_tick = NULL WHERE id = ?')
        .bind(m.tons, b.id),
    ]);
  }

  // ---- silos (servers with the Missile Silo only: migrations 0178/0179) ----
  // The silo is a city building, so it goes in the owner's city on that
  // world: the capital on a home world, a studio city on a seeded one.
  const siloOut = [];
  for (const [i, s] of spec.silos.entries()) {
    const b = bodyOf(s.world, `silos[${i}]`);
    const owner = s.owner ? fid(s.owner) : (b.owner_faction_id ?? null);
    const city = await env.DB
      .prepare(`SELECT id, buildings_json FROM game_settlements
                 WHERE game_id = ? AND body_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
                   ${owner ? 'AND owner_faction_id = ?' : ''}
                 ORDER BY created_at_tick ASC LIMIT 1`)
      .bind(...(owner ? [gameId, b.id, owner] : [gameId, b.id])).first();
    if (!city) throw new Error(`silos[${i}]: no city on ${s.world}${s.owner ? ` owned by ${s.owner}` : ''}; seed one in worlds[]`);
    let bj = {};
    try { bj = JSON.parse(city.buildings_json || '{}') || {}; } catch { bj = {}; }
    bj.missile_silo = s.level;
    try {
      await env.DB.prepare(
        `UPDATE game_settlements SET buildings_json = ?, missile_stock = ?, missile_auto = ?, missile_salvo = ?,
                missile_reserve = ?, missile_orders_json = NULL WHERE id = ?`,
      ).bind(JSON.stringify(bj), s.stock, s.auto, s.salvo, s.reserve, city.id).run();
    } catch (e) {
      if (/no such column/i.test(String(e?.message))) throw new Error('this server has no Missile Silo (missile columns are missing)');
      throw e;
    }
    siloOut.push(`${s.world}: level ${s.level}, ${s.stock} missiles, auto ${s.auto}, salvo ${s.salvo}`);
  }

  // ---- megastructures (2026-10-23: a freighter delivering the last load
  // to a Weapons Station site needed one standing on the board) ----
  // The rows room.js spawnAncientStructure writes: a body of type
  // 'megastructure' on the gate rule's orbit around the `at` world, and
  // its game_megastructures row, here with an owner and the scene's
  // progress. Seen by every faction. The scene's key names it from here
  // on (ships.at, orders.move.to), as a world id would.
  const megaOut = [];
  if (spec.megastructures.length) {
    const live = (await env.DB
      .prepare(`SELECT id, name, type, parent_body_id, mu, soi, radius, orbit_radius, orbit_period
                  FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`)
      .bind(gameId).all()).results ?? [];
    const conf = await gameCfg(env, gameId);
    const bodyScale = Number(conf?.body_scale) > 0 ? Number(conf.body_scale) : 1;
    const everyone = ((await env.DB.prepare('SELECT id FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? []).map(r => r.id);
    const perHost = new Map();
    for (const [i, m] of spec.megastructures.entries()) {
      const where = `megastructures[${i}]`;
      const at = bodyOf(m.at, where);
      const host = live.find(b => b.id === at.id);
      if (!host) throw new Error(`${where}: ${m.at} is gone from this board`);
      const kind = MEGASTRUCTURES[m.kind];
      // The gate rule (spawnAncientStructure): clear of the surface,
      // inside the SOI. A second site at the same world rides the same
      // ring a third of a turn on, so the two never sit on each other.
      const soi = Number(host.soi) || 0;
      const rad = Number(host.radius) || 1;
      let r = soi > 0 ? Math.min(Math.max(rad * 2.5, soi * 0.35), soi * 0.8) : rad * 4;
      const nth = perHost.get(host.id) ?? 0;
      perHost.set(host.id, nth + 1);
      let angle = (Math.PI / 2 + nth * 2.1) % (2 * Math.PI);
      // Or where the scene puts it (2026-10-23): anywhere a player could
      // found a site, inside the world's sphere of influence and clear of
      // its surface (actions.js, deriveSiteOrbit). The ring hung the
      // weapons-station clip's station twelve Mars radii out, off every
      // frame that held Mars at a size worth seeing.
      if (m.orbit != null) {
        if (m.orbit < rad * 1.5) throw new Error(`${where}.orbit ${m.orbit} is inside ${host.name} or on its surface (radius ${rad}); give at least ${Math.ceil(rad * 1.5 * 10) / 10}`);
        if (soi > 0 && m.orbit > soi) throw new Error(`${where}.orbit ${m.orbit} is outside ${host.name}'s sphere of influence (${Math.round(soi * 10) / 10})`);
        r = m.orbit;
      }
      const period = periodForRadius(host, r, live);
      if (m.angle != null) angle = angle0For((m.angle * Math.PI) / 180, period, tick);
      const id = `${gameId}:${STUDIO_MARK}mega_${m.key}`;
      const name = m.name ?? (m.complete ? kind.label : `${kind.label} Site`);
      const owner = fid(m.owner);
      const radius = (kind.radius ?? 1.9) * bodyScale;
      const acc = m.complete
        ? { metal: kind.cost.metal, credits: kind.cost.credits }
        : { metal: Math.round(kind.cost.metal * m.progress), credits: Math.round(kind.cost.credits * m.progress) };
      await env.DB.batch([
        // An UPSERT, never INSERT OR REPLACE: REPLACE deletes the old row
        // first, and a body is never deleted (retireStudioSites). This is
        // also what brings back a site the last reset retired.
        env.DB.prepare(
          `INSERT INTO game_bodies
             (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
              orbit_radius, orbit_period, angle0, color, owner_faction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             template_id = excluded.template_id, name = excluded.name, type = excluded.type,
             parent_body_id = excluded.parent_body_id, radius = excluded.radius, soi = 0, mu = excluded.mu,
             orbit_radius = excluded.orbit_radius, orbit_period = excluded.orbit_period, angle0 = excluded.angle0,
             color = excluded.color, owner_faction_id = excluded.owner_faction_id, destroyed_at_tick = NULL`,
        ).bind(id, gameId, `mega_${m.kind}`, name, MEGA_BODY_TYPE, host.id, radius, MEGA_MU,
          r, period, angle, kind.color ?? '#c9a26b', owner),
        // hp explicit and full: the column default (200) is under the
        // breach line, so a site born with it is boardable at once.
        env.DB.prepare(
          `INSERT OR REPLACE INTO game_megastructures
             (body_id, game_id, kind, status, acc_metal, acc_credits, cost_metal, cost_credits,
              founded_by_faction_id, founded_at_tick, completed_at_tick, hp, ancient)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).bind(id, gameId, m.kind, m.complete ? 'complete' : 'building', acc.metal, acc.credits,
          kind.cost.metal, kind.cost.credits, owner, Math.max(0, tick - 10), m.complete ? Math.max(0, tick - 5) : null, MEGA_MAX_HP),
        ...everyone.map(f => env.DB.prepare(
          'INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick) VALUES (?, ?, ?, ?)',
        ).bind(gameId, f, id, tick)),
      ]);
      bodies.set(m.key, { id, template_id: m.key, name, type: MEGA_BODY_TYPE, radius, terraformed_at_tick: null,
        parent_body_id: host.id, owner_faction_id: owner, destroyed_at_tick: null });
      megaOut.push({ key: m.key, id, kind: m.kind, at: m.at, status: m.complete ? 'complete' : 'building',
        progress: m.progress, cost: kind.cost });
    }
  }

  // ---- ships ----
  const shipIds = {};          // group key -> [ids]
  const shipRows = new Map();  // id -> { owner, at }
  const shipStmts = [];
  for (const g of spec.ships) {
    const b = bodyOf(g.at, `ships.${g.key}`);
    const rp = parkOrbitRadius(Number(b.radius));
    shipIds[g.key] = [];
    const counters = {};
    g.hulls.forEach((cls, i) => {
      const id = `${gameId}:${STUDIO_MARK}${g.key}_${i}`;
      counters[cls] = (counters[cls] ?? 0) + 1;
      let parts = Array.isArray(g.loadout) ? g.loadout : LOADOUT_PRESETS[g.loadout](cls, i);
      const slots = SHIP_SLOT_COUNTS[cls] ?? 0;
      parts = (parts ?? []).slice(0, slots);
      const check = parts.length ? validateParts(cls, parts, LENIENT) : { ok: true, parts: [] };
      if (!check.ok) parts = (DEFAULT_LOADOUTS[cls] ?? []).slice(0, slots);
      const base = SHIP_COMBAT_STATS[cls] ?? { hp: 50, damage_per_tick: 0 };
      const st = parts.length ? computeShipStats(cls, parts, {}, SHIP_COMBAT_STATS) : base;
      const hpMax = Math.round(st.hp * g.hp);
      const fuel = FUEL_MAX[cls] ?? 100;
      const name = `${g.prefix} ${TAG[cls] ?? 'SH'}-${String(counters[cls]).padStart(2, '0')}`;
      shipStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_ships
           (id, game_id, owner_faction_id, name, ship_class, parent_body_id, orbit_rp, orbit_ra, orbit_omega, orbit_m0,
            orbit_epoch, orbit_direction, fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, icon_variant, parts_json, home_body_id,
            cargo_metal, cargo_gold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, gameId, fid(g.owner), name, cls, b.id, rp, rp, parkPhaseFor(id), tick, fuel, fuel, Math.max(0, tick - 1),
          hpMax, hpMax, st.damage_per_tick, g.variant, parts.length ? JSON.stringify(parts) : null, b.id,
          g.cargo?.metal ?? 0, g.cargo?.gold ?? 0));
      shipIds[g.key].push(id);
      shipRows.set(id, { owner: g.owner, at: b, cls });
    });
  }
  for (let i = 0; i < shipStmts.length; i += 40) await env.DB.batch(shipStmts.slice(i, i + 40));
  // THE CAMERA MUST BE IN RANGE. Sensors 10 reveals every hull, but a
  // world's owner, cities and skyline are presence-fogged: the viewer
  // sees them only at worlds where it has a ship or a claim, their
  // moons, their parent and its other moons (state.js visible_bodies).
  // So each scene world the viewer cannot see gets an observer hull of
  // the viewer's, parked where the rule lights it without putting the
  // hull in the fight: the parent planet for a moon, an empty moon for
  // a planet, the world itself as a last resort. Off with camera:false.
  const camStmts = [];
  if (spec.camera !== false && spec.viewer && factions.has(spec.viewer)) {
    const viewerId = fid(spec.viewer);
    const byId = new Map([...bodies.values()].map(b => [b.id, b]));
    const presence = new Set();
    for (const b of bodies.values()) if (b.owner_faction_id === viewerId) presence.add(b.id);
    for (const [, r] of shipRows) if (r.owner === spec.viewer) presence.add(r.at.id);
    // A sun by its type too: a far system's suns orbit its barycenter, and
    // "no parent" alone took Centauri A for a planet, so a far world was
    // watched from its sun, well out of sensor range (2026-10-23).
    const isStar = (b) => b.parent_body_id == null || b.type === 'star' || b.type === 'black_hole';
    const lit = (id) => {
      if (presence.has(id)) return true;
      const b = byId.get(id);
      for (const p of presence) {
        const pb = byId.get(p);
        if (!pb || isStar(pb)) continue;
        if (b.parent_body_id === p) return true;                       // moon of a presence world
        if (pb.parent_body_id === id && !isStar(b)) return true;        // parent of a presence moon
        if (pb.parent_body_id && pb.parent_body_id === b.parent_body_id && !isStar(byId.get(pb.parent_body_id))) return true; // sibling moon
      }
      return false;
    };
    const sceneBodies = new Set([...spec.ships.map(g => bodyOf(g.at, 'camera').id), ...spec.worlds.map(w => bodyOf(w.body, 'camera').id)]);
    const busy = new Set([...shipRows.values()].map(r => r.at.id));
    for (const id of sceneBodies) {
      if (lit(id)) continue;
      const b = byId.get(id);
      const parent = b.parent_body_id ? byId.get(b.parent_body_id) : null;
      let anchor = null;
      if (parent && !isStar(parent)) anchor = parent;                     // a moon: watch from its planet
      else {
        const moon = [...bodies.values()].find(m => m.parent_body_id === id && !busy.has(m.id) && m.destroyed_at_tick == null);
        anchor = moon ?? b;                                                // a planet: from a quiet moon, else itself
      }
      const camId = `${gameId}:${STUDIO_MARK}cam_${anchor.template_id}`;
      if (shipRows.has(camId)) continue;
      const rp = parkOrbitRadius(Number(anchor.radius));
      camStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_ships
           (id, game_id, owner_faction_id, name, ship_class, parent_body_id, orbit_rp, orbit_ra, orbit_omega, orbit_m0,
            orbit_epoch, orbit_direction, fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, icon_variant, parts_json, home_body_id)
         VALUES (?, ?, ?, ?, 'corvette', ?, ?, ?, 0, ?, ?, 1, 80, 80, 'active', ?, 40, 40, 0, 'A', NULL, ?)`)
        .bind(camId, gameId, viewerId, `Observer ${anchor.name}`, anchor.id, rp, rp, parkPhaseFor(camId), tick, Math.max(0, tick - 1), anchor.id));
      shipRows.set(camId, { owner: spec.viewer, at: anchor, cls: 'corvette' });
      presence.add(anchor.id);
      shipIds.camera = [...(shipIds.camera ?? []), camId];
    }
  }
  if (camStmts.length) await env.DB.batch(camStmts);

  // NOTHING BURIED WHERE THE TAKE HAPPENS (2026-10-23). Worlds roll hidden
  // secrets when a game is made, and a parked hull finds one on the next
  // tick (room.js resolveSecretReveal): a 'pre_terraformed' find turned the
  // obliterate clip's raw Callisto into a living ocean world on tick 1, and
  // its strike, armed to obliterate, stood down in silence at tick 7 (a
  // strike fires what was ordered or nothing). An ancient battery, a gate
  // or a derelict's offer would wreck a take the same way. So every world
  // the scene puts hulls at, lists, watches from or flies to is emptied of
  // what is still buried there. `secrets: true` keeps them, for a clip
  // that is about a find.
  if (!spec.secrets) {
    const quiet = new Set([...shipRows.values()].map(r => r.at.id));
    for (const w of spec.worlds) quiet.add(bodyOf(w.body, 'worlds').id);
    for (const o of spec.orders) if (o.type === 'move' && bodies.has(o.to)) quiet.add(bodies.get(o.to).id);
    if (spec.kaiju && bodies.has(spec.kaiju.at)) quiet.add(bodies.get(spec.kaiju.at).id);
    const ids = [...quiet];
    for (let i = 0; i < ids.length; i += 80) {
      const part = ids.slice(i, i + 80);
      await env.DB.prepare(`UPDATE game_bodies SET secret_kind = NULL WHERE game_id = ? AND secret_revealed = 0 AND id IN (${part.map(() => '?').join(',')})`)
        .bind(gameId, ...part).run();
    }
  }

  const shipsOf = (ref) => {
    const [key, idx] = String(ref).split('.');
    const ids = shipIds[key] ?? [];
    return idx != null ? ids.slice(Number(idx), Number(idx) + 1) : ids;
  };

  // ---- target orders ----
  for (const g of spec.ships) {
    if (!g.priority || !shipIds[g.key]?.length) continue;
    const ids = shipIds[g.key];
    await env.DB.prepare(`UPDATE game_ships SET target_priority = ? WHERE game_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(JSON.stringify(g.priority), gameId, ...ids).run();
  }

  // ---- wars ----
  const warIds = [];
  for (const [a, b] of spec.wars) {
    const id = await openWarBetween(env, gameId, tick, fid(a), fid(b), 'seeded');
    if (id) warIds.push(id);
  }

  // ---- laws: bills that passed, in force from this tick ----
  // The rows a real resolution writes (senate.js applyBillEffects): the
  // passed proposal, its ballots, and the effect row combat and the
  // economy read. Nothing here goes through the floor, so the chamber
  // shows a settled vote and a law in force the moment the scene lands.
  const lawIds = [];
  for (let i = 0; i < spec.laws.length; i++) {
    const l = spec.laws[i];
    const where = `laws[${i}]`;
    const pid = `${gameId}:${STUDIO_MARK}law_${i}`;
    const eid = `${gameId}:${STUDIO_MARK}eff_${i}`;
    const targetId = l.target ? fid(l.target) : null;
    const targetName = l.target ? factions.get(l.target).name : null;
    let kind, payload, title, summary;
    if (l.kind === 'law') {
      const d = describeSlider(l.slider, l.value);
      if (!d) throw new Error(`${where}: unknown Senate slider '${l.slider}'`);
      kind = 'slider_law';
      payload = { slider_id: l.slider, target_value: d.value, target_faction_id: targetId };
      title = l.title ?? (targetId ? `${d.name} for the ${targetName}` : d.name);
      summary = l.summary ?? d.effect;
    } else {
      kind = l.kind;
      payload = { target_faction_id: targetId };
      const words = {
        war_authorization: [`War authorised against the ${targetName}`, `The Senate sanctions war on the ${targetName}. Their ships take double damage for ${l.ticks} ticks.`],
        trade_embargo: [`Embargo on the ${targetName}`, `No trade deliveries reach the ${targetName} for ${l.ticks} ticks.`],
        production_sanction: [`Sanctions on the ${targetName}`, `The ${targetName}'s settlements yield half for ${l.ticks} ticks.`],
      }[kind];
      title = l.title ?? words[0];
      summary = l.summary ?? words[1];
    }
    const everyone = spec.factions.map(f => f.key);
    const yea = l.yea ?? everyone.filter(k => k !== l.target);
    const nay = l.nay ?? (l.target && !yea.includes(l.target) ? [l.target] : []);
    const castAt = Math.max(0, tick - 1);
    const stmts = [
      env.DB.prepare(
        `INSERT INTO senate_proposals (id, game_id, proposer_faction_id, kind, title, summary, payload, status,
           proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick, resolved_at_tick, effect_until_tick, debate_ticks, vote_ticks)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?, ?, ?, 1, 1)`,
      ).bind(pid, gameId, fid(l.proposer), kind, title, summary, JSON.stringify(payload),
        Math.max(0, tick - 2), castAt, tick, tick, tick + l.ticks),
    ];
    for (const [vote, keys] of [['yea', yea], ['nay', nay]]) {
      for (const k of keys) {
        stmts.push(env.DB.prepare('INSERT OR REPLACE INTO senate_votes (proposal_id, faction_id, vote, weight, cast_at_tick) VALUES (?, ?, ?, 1, ?)')
          .bind(pid, fid(k), vote, castAt));
      }
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO senate_effects (id, game_id, slider_id, value, effect_kind, target_faction_id, proposal_id,
         active_from_tick, active_until_tick, created_at_tick, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(eid, gameId, l.slider ?? '', l.value ?? 0, l.kind === 'law' ? 'slider' : l.kind, targetId, pid,
      tick, tick + l.ticks, tick, Date.now()));
    await env.DB.batch(stmts);
    lawIds.push({ id: pid, title, until_tick: tick + l.ticks });
  }
  // A chamber with laws has a chairman: the first law's proposer holds
  // the gavel for a term from this tick, unless a term already covers it
  // (the tick draws one otherwise, and the panel reads "not in session"
  // until then).
  if (spec.laws.length) {
    const covering = await env.DB
      .prepare('SELECT id FROM senate_terms WHERE game_id = ? AND start_tick <= ? AND end_tick > ? LIMIT 1')
      .bind(gameId, tick, tick).first();
    if (!covering) {
      const prior = await env.DB
        .prepare('SELECT COALESCE(MAX(term_index), -1) AS i, COALESCE(MAX(bag_cycle), 0) AS c FROM senate_terms WHERE game_id = ?')
        .bind(gameId).first();
      await env.DB.prepare(
        'INSERT INTO senate_terms (id, game_id, faction_id, term_index, bag_cycle, start_tick, end_tick, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(`${gameId}:${STUDIO_MARK}term`, gameId, fid(spec.laws[0].proposer), Number(prior?.i ?? -1) + 1, Number(prior?.c ?? 0), tick, tick + 48, Date.now()).run();
    }
  }

  // ---- fleets (captains first: a flagship must have one) ----
  const fleetIds = {};
  if (spec.fleets.length) {
    await ensureCaptainFloor(env.DB, gameId, tick);
    await ensureCaptains(env.DB, gameId, tick);
    for (const f of spec.fleets) {
      const members = f.groups.flatMap(shipsOf);
      if (members.length < 2) throw new Error(`fleet '${f.key}' needs at least 2 ships`);
      const owner = shipRows.get(members[0])?.owner;
      const flag = await env.DB
        .prepare(`SELECT id, captain_id FROM game_ships WHERE id IN (${members.map(() => '?').join(',')}) AND captain_id IS NOT NULL ORDER BY hp_max DESC LIMIT 1`)
        .bind(...members).first();
      if (!flag) throw new Error(`fleet '${f.key}': no captain could be assigned; add more hulls or fewer fleets`);
      const id = `${gameId}:${STUDIO_MARK}fl_${f.key}`;
      await env.DB.batch([
        env.DB.prepare('INSERT OR REPLACE INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, gameId, fid(owner), f.name, flag.captain_id, tick),
        env.DB.prepare(`UPDATE game_ships SET fleet_id = ?, fleet_detached = 0 WHERE id IN (${members.map(() => '?').join(',')})`).bind(id, ...members),
      ]);
      fleetIds[f.key] = id;
    }
  }

  // ---- the Leviathan, parked at a world, about to wind up (2026-10-23) ----
  // Born the game's own way (kaiju.js launchKaiju: its faction, its hull,
  // its HP rolled from the fleets just seeded, the game_kaiju row), but
  // with nowhere to fly: its "launch" is from the world itself, so the leg
  // planner is not asked. Then it is put where its hunt would leave it,
  // over its prey: phase 'hunting', the world its target. The next tick's
  // advanceKaiju winds it up (kaiju_charge_ticks) and reveals it, and the
  // strike after that is the game's own.
  let kaijuOut = null;
  if (spec.kaiju) {
    const at = bodyOf(spec.kaiju.at, 'kaiju');
    if (!['terrestrial', 'dwarf', 'moon'].includes(at.type)) throw new Error(`kaiju.at: ${at.name} is a ${at.type}; it eats terrestrial worlds, dwarfs and moons`);
    const capital = await env.DB
      .prepare(`SELECT 1 AS x FROM game_factions WHERE game_id = ? AND capital_body_id = ? AND status <> 'monster' LIMIT 1`)
      .bind(gameId, at.id).first();
    if (capital) throw new Error(`kaiju.at: ${at.name} is a capital, and the Leviathan never attacks one`);
    // A take it finished left the world a debris field; it starts whole.
    await env.DB.prepare('UPDATE game_bodies SET obliterated_at_tick = NULL WHERE id = ?').bind(at.id).run();
    // The system its gate leads to: the gate it leaves through when full.
    const sys = spec.gates === 'birth' ? gateOrder(gameId)[0] : SUN_GATE_SYSTEMS[0];
    const made = await launchKaiju(env, gameId, tick,
      { sys, arrival: tick, fromBodyId: at.id, landedNear: null, targetId: at.id },
      await gameCfg(env, gameId), { planLeg: async () => null });
    if (!made) throw new Error('kaiju: this game already has a Leviathan; re-apply with reset on');
    const sid = kaijuShipId(gameId);
    const hp = spec.kaiju.hp ?? made.hp;
    const rp = parkOrbitRadius(Number(at.radius));
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE game_ships SET orbit_rp = ?, orbit_ra = ?, orbit_omega = 0, orbit_m0 = ?, orbit_epoch = ?,
                hp = ?, hp_max = ? WHERE id = ? AND game_id = ?`,
      ).bind(rp, rp, parkPhaseFor(sid), tick, hp, hp, sid, gameId),
      env.DB.prepare(
        `UPDATE game_kaiju SET phase = 'hunting', target_body_id = ?, launched_at_tick = ?, hp_max = ?
          WHERE game_id = ?`,
      ).bind(at.id, tick - 1, hp, gameId),
    ]);
    kaijuOut = { ship: sid, at: spec.kaiju.at, hp, charge_ticks: spec.kaiju.chargeTicks,
      winds_up_at_tick: tick + 1, fires_at_tick: tick + 1 + spec.kaiju.chargeTicks };
  }

  // ---- orders ----
  const done = [];
  /** Things the scene asked for that the game could not do as asked. */
  const warnings = [];
  let room = null;
  for (const o of spec.orders) {
    if (o.type === 'move') {
      if (!room) { const { Room } = await import('./room.js'); room = new Room(null, env); }
      const to = bodyOf(o.to, 'orders.move');
      const ids = shipsOf(o.ships);
      // The natural trip of the GROUP from a given departure: its slowest
      // hull's, on that hull's own engine. Probed with the real planner and
      // the probe's nodes removed again.
      const tripAt = async (d) => {
        let longest = d;
        for (const id of ids) {
          const r = shipRows.get(id);
          const probe = await room.planLegForShip(gameId, d, id, fid(r.owner), r.at.id, to.id, null);
          longest = Math.max(longest, Number(probe) || d);
        }
        await env.DB.prepare('DELETE FROM game_ship_nodes WHERE game_id = ? AND status = ? AND ship_id IN (' + ids.map(() => '?').join(',') + ')')
          .bind(gameId, 'committed', ...ids).run();
        return longest - d;
      };
      // `arrive` is honoured by LEAVING LATER, never by flying slower
      // (solveMoveTiming): a hull always burns at its real engine.
      const want = o.arrive ? whenTick(o.arrive, tick) : null;
      const plan = await solveMoveTiming({ earliest: Math.max(tick, whenTick(o.depart, tick)), want, tripAt });
      const depart = plan.depart;
      if (plan.late) {
        warnings.push(`orders.move ${o.ships} -> ${o.to}: asked to arrive at tick ${want}, but the trip takes `
          + `${plan.arrive - depart} ticks; it arrives at tick ${plan.arrive}, as soon as it can`);
      }
      // A group flies together: every hull held to the slowest one's
      // arrival, as guards are paced to freighters. A lone hull flies its
      // own natural leg.
      const arrive = ids.length > 1 ? plan.arrive : null;
      const arrivals = [];
      for (const id of ids) {
        const r = shipRows.get(id);
        arrivals.push(await room.planLegForShip(gameId, depart, id, fid(r.owner), r.at.id, to.id, arrive));
      }
      if (o.settle === 'station') {
        await env.DB.prepare(`UPDATE game_ships SET deploy_on_arrival = 'station' WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
      }
      done.push({ type: 'move', ships: ids.length, to: o.to, depart, arrive: Math.max(...arrivals), ...(want != null ? { asked: want } : {}),
        ...(o.settle ? { settle: o.settle } : {}) });
    } else if (o.type === 'strike') {
      const [id] = shipsOf(o.ship);
      const r = shipRows.get(id);
      if (!r || r.cls !== 'mega_destroyer') throw new Error(`orders.strike: '${o.ship}' is not a Mega Destroyer`);
      const target = bodyOf(r.at.template_id, 'orders.strike');
      const mode = target.terraformed_at_tick != null || spec.worlds.some(w => w.body === target.template_id && w.living) ? 'sterilise' : 'obliterate';
      const ready = whenTick(o.ready, tick);
      await env.DB.prepare('UPDATE game_ships SET strike_target_body_id = ?, strike_ready_tick = ?, strike_mode = ? WHERE id = ?')
        .bind(target.id, ready, mode, id).run();
      done.push({ type: 'strike', ship: id, world: target.template_id, mode, ready, charge_ticks: MEGA_STRIKE_CHARGE_TICKS });
    } else if (o.type === 'trade') {
      const [id] = shipsOf(o.ship);
      const r = shipRows.get(id);
      const route = actionRoutes.find(x => x.method === 'POST' && x.pattern instanceof RegExp && x.pattern.source.includes('trade-routes$'));
      if (!route) throw new Error('trade route handler not found');
      const ownerUser = factions.get(r.owner).user_id;
      const url = new URL(`https://studio/api/games/${gameId}/trade-routes`);
      const req = new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ship_id: id, origin_body_id: bodyOf(o.from, 'orders.trade').id, dest_body_id: bodyOf(o.to, 'orders.trade').id }),
      });
      const res = await route.handle(req, env, { url, session: { user_id: ownerUser }, params: { gameId } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`orders.trade: ${body?.error?.message ?? res.status}`);
      done.push({ type: 'trade', ship: id, from: o.from, to: o.to, route_id: body?.route?.id ?? null });
    } else if (o.type === 'mine') {
      const [id] = shipsOf(o.ship);
      const r = shipRows.get(id);
      const route = tradeRoutesV2.find(x => x.method === 'POST' && x.pattern instanceof RegExp && x.pattern.source.includes('trade-routes\\/full$'));
      if (!route) throw new Error('mining route handler not found');
      const ownerUser = factions.get(r.owner).user_id;
      const url = new URL(`https://studio/api/games/${gameId}/trade-routes/full`);
      const req = new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Mining run',
          stops: [{ body_id: bodyOf(o.rock, 'orders.mine').id, action: 'mine' }, { body_id: bodyOf(o.to, 'orders.mine').id, action: 'dropoff' }],
          carrier_ship_ids: [id], loop_mode: 'count', loop_count: o.loops,
        }),
      });
      const res = await route.handle(req, env, { url, session: { user_id: ownerUser }, params: { gameId } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`orders.mine: ${body?.error?.message ?? res.status}`);
      done.push({ type: 'mine', ship: id, rock: o.rock, to: o.to, loops: o.loops, route_id: body?.route?.id ?? null });
    } else if (o.type === 'supply') {
      const ids = shipsOf(o.ships);
      const owner = factions.get(shipRows.get(ids[0]).owner);
      const r = await laySupplyRoute(env, gameId, {
        shipIds: ids, fromId: bodyOf(o.from, 'orders.supply').id, siteId: bodyOf(o.to, 'orders.supply').id,
        userId: owner.user_id, loops: o.loops,
      });
      done.push({ type: 'supply', ships: ids.length, from: o.from, to: o.to, loops: o.loops, ...r });
    } else if (o.type === 'ram') {
      const rock = bodyOf(o.asteroid, 'orders.ram');
      const target = bodyOf(o.target, 'orders.ram');
      const owner = factions.get(o.owner ?? spec.viewer);
      const r = await fireRam(env, gameId, {
        rockId: rock.id, targetId: target.id, factionId: owner.id, userId: owner.user_id,
        depart: Math.max(tick, whenTick(o.depart, tick)),
      });
      done.push({ type: 'ram', asteroid: o.asteroid, target: o.target, ...r });
    }
  }

  return {
    ok: true, game_id: gameId, created, tick,
    factions: spec.factions.map(f => ({ key: f.key, id: factions.get(f.key).id, name: f.name, handle: f.handle,
      seat_me: spec.seatMe && f.key === spec.viewer })),
    viewer: spec.viewer, ships: shipIds, fleets: fleetIds, wars: warIds.length, orders: done, laws: lawIds, silos: siloOut, warnings,
    megastructures: megaOut, kaiju: kaijuOut, ...(gateBirth ? { gate_birth: gateBirth } : {}),
  };
}

/**
 * FIRE A RAM the way a player does (2026-10-23): the plan the inspector
 * computes, posted to the real handler (actions.js handleRamAsteroid) as
 * the rock's owner, so the server's own checks pass judgement on it.
 *
 * The inspector's plan (BodyInspector.tsx): the rock's position at the
 * departure, its velocity by finite difference, and the brachistochrone
 * time T = 2 sqrt(gap / a) iterated against the target's motion, at the
 * thrusters' push (RAM_ASTEROID_G x G_ANCHOR, within the handler's own
 * ceiling; see below). Two departures from it, both for
 * the film: the arrival is a WHOLE tick (impact is resolved on a tick,
 * and a fractional arrival leaves the rock pinned at the intercept until
 * the next one), and the push is eased to land exactly on that tick
 * (a = 4 gap / T^2, never above the ceiling). At the full push over the
 * rounded-up time the map's integrator, which brakes from the flip at
 * plan.acceleration, would stop short and jump the last stretch.
 *
 * Metal: the owner is topped up by exactly the cost first, so the take
 * spends nothing; a refused ram takes the top-up back. A refusal throws
 * with the handler's own message.
 */
async function fireRam(env, gameId, { rockId, targetId, factionId, userId, depart }) {
  const route = actionRoutes.find(x => x.method === 'POST' && x.pattern instanceof RegExp
    && x.pattern.source.includes('bodies') && x.pattern.source.endsWith('\\/ram$'));
  if (!route) throw new Error('ram handler not found');
  const rm = makeRouteMath(env.DB, gameId);
  // The push a player's ram gets. The handler's ceiling is
  // max(faction engine_g, RAM_ASTEROID_G), but the inspector plans at
  // fromG(faction.engineG ?? RAM_ASTEROID_G) and multiplayer factions
  // carry no engineG, so every ram in play flies at RAM_ASTEROID_G; at
  // engine_g (0.05) a studio rock crossed to Mars in 7 ticks, ten times
  // the push anyone has seen.
  const aMax = RAM_ASTEROID_G * RAM_G_ANCHOR;
  const s = depart;
  const p0 = await rm.bodyPosAt(rockId, s);
  const pa = await rm.bodyPosAt(rockId, s - 0.01);
  const pb = await rm.bodyPosAt(rockId, s + 0.01);
  const v0 = { x: (pb.x - pa.x) / 0.02, y: (pb.y - pa.y) / 0.02 };
  const gapAt = async (T) => {
    const q = await rm.bodyPosAt(targetId, s + T);
    return { q, d: Math.hypot(q.x - p0.x, q.y - p0.y) };
  };
  let T = 0;
  for (let i = 0; i < 20; i++) {
    const next = 2 * Math.sqrt((await gapAt(T)).d / aMax) * 1.01;
    const settled = Math.abs(next - T) < 1e-4;
    T = next;
    if (settled) break;
  }
  let n = Math.max(1, Math.ceil(T));
  let at = await gapAt(n);
  for (let guard = 0; (aMax * n * n) / 4 < at.d && guard < 1000; guard++) at = await gapAt(++n);
  if ((aMax * n * n) / 4 < at.d) throw new Error('orders.ram: the thrusters cannot reach that world');
  const a = Math.min(aMax, (4 * at.d) / (n * n));
  const dv = a * n;
  const metal = Math.ceil(dv * RAM_METAL_PER_DV);
  await env.DB.prepare('UPDATE game_factions SET metal = metal + ? WHERE id = ?').bind(metal, factionId).run();
  const url = new URL(`https://studio/api/games/${gameId}/bodies/${rockId}/ram`);
  const res = await route.handle(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target_body_id: targetId, start_tick: s, flip_tick: s + n / 2, arrive_tick: s + n, acceleration: a,
      start_pos_x: p0.x, start_pos_y: p0.y, start_vel_x: v0.x, start_vel_y: v0.y,
      intercept_pos_x: at.q.x, intercept_pos_y: at.q.y, total_dv: dv, metal_cost: metal,
    }),
  }), env, { url, session: { user_id: userId }, params: { gameId, bodyId: rockId } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    await env.DB.prepare('UPDATE game_factions SET metal = MAX(0, metal - ?) WHERE id = ?').bind(metal, factionId).run();
    throw new Error(`orders.ram refused: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return { depart: s, flip: s + n / 2, arrive: s + n, ticks: n, metal_cost: metal, accel_g: a / RAM_G_ANCHOR };
}

/**
 * A SUPPLY RUN the way a player lays one (2026-10-23, the construction
 * clip): the route composer's own endpoint (tradeRoutesV2.js
 * handleCreateFull), a pickup at the dock world and the site as the
 * drop-off, posted as the freighters' owner, so every rule a player meets
 * (a dock to load at, a site you may supply, the carrier cap your research
 * allows, a free hull) passes judgement on it. The freight comes out of
 * the treasury at the dock (routeMath.js planSiteDraw), so seed the
 * faction's metal and gold. The endpoint dispatches at once: the hulls
 * load and leave on the tick the route is laid. Returns the route and,
 * per hull, the tick it lands at the first stop it flies to.
 */
async function laySupplyRoute(env, gameId, { shipIds, fromId, siteId, userId, loops = null, name = null }) {
  const route = tradeRoutesV2.find(x => x.method === 'POST' && x.pattern instanceof RegExp && x.pattern.source.includes('trade-routes\\/full$'));
  if (!route) throw new Error('route composer handler not found');
  const url = new URL(`https://studio/api/games/${gameId}/trade-routes/full`);
  const res = await route.handle(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: name ?? 'Supply run',
      stops: [{ body_id: fromId, action: 'pickup' }, { body_id: siteId, action: 'dropoff' }],
      carrier_ship_ids: shipIds, loop_mode: loops ? 'count' : 'forever', ...(loops ? { loop_count: loops } : {}),
    }),
  }), env, { url, session: { user_id: userId }, params: { gameId } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `the route was refused (${res.status})`);
  const legs = ((await env.DB
    .prepare(`SELECT ship_id, MAX(arrival_at_tick) AS arrive FROM game_ship_nodes
               WHERE game_id = ? AND status IN ('committed', 'in_transit') AND ship_id IN (${shipIds.map(() => '?').join(',')})
               GROUP BY ship_id`)
    .bind(gameId, ...shipIds).all()).results ?? []).map(r => ({ ship: r.ship_id, arrive: r.arrive }));
  return { route_id: body?.route?.id ?? null, dispatched: !!body?.dispatched, legs };
}

/**
 * Dials a scene needs, on a config of the game's own (`cfg_studio_<id>`;
 * the published one is left alone). Written only when something differs,
 * so a re-take on the same dials changes nothing.
 */
async function patchStudioConfig(env, gameId, patch) {
  const g = await env.DB
    .prepare('SELECT g.config_id, c.overrides FROM games g LEFT JOIN game_configs c ON c.id = g.config_id WHERE g.id = ?')
    .bind(gameId).first();
  let ov = {};
  try { ov = JSON.parse(g?.overrides || '{}') || {}; } catch { ov = {}; }
  if (Object.entries(patch).every(([k, v]) => Number(ov[k]) === Number(v))) return;
  const id = `cfg_studio_${gameId}`.slice(0, 64);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO game_configs (id, name, status, overrides, created_ms, updated_ms)
                    VALUES (?, 'studio: far systems', 'archived', ?, ?, ?)`)
      .bind(id, JSON.stringify({ ...ov, ...patch }), now, now),
    env.DB.prepare('UPDATE games SET config_id = ? WHERE id = ?').bind(id, gameId),
  ]);
  invalidateCfg(gameId);
}

/**
 * The far systems on a studio board: the game's own far_systems dial, the
 * far bodies added the way a running game gets them (backfillMissingBodies),
 * and then the gate:
 *
 *   gates: true    the Centauri sun gate pair spawned already open, and the
 *                  game's own gate sequence marked long finished, so no
 *                  second gate (or Leviathan) arrives mid-take.
 *   gates: 'birth' (2026-10-23, the clip of a gate leaving the Sun) nothing
 *                  spawned: the omen is set for this tick, so the next tick
 *                  starts the ripples and the game's own tick sends the
 *                  first gate out SUN_GATE_WARNING_TICKS later. The gap to
 *                  the second gate is the dial's maximum, so it (and a
 *                  Leviathan) cannot come mid-take. Returns what to expect.
 *
 * A scene with the Leviathan also turns the kaiju dial on, with its
 * wind-up (kaiju_charge_ticks).
 */
async function enableFarSystems(env, gameId, tick, spec) {
  const patch = { far_systems: 1 };
  if (spec.gates === 'birth') patch.sun_gate_interval = CONFIG_DIALS.sun_gate_interval.max;
  if (spec.kaiju) { patch.kaiju = 1; patch.kaiju_charge_ticks = spec.kaiju.chargeTicks; }
  await patchStudioConfig(env, gameId, patch);
  await backfillMissingBodies(env, gameId, { farOnly: true });
  if (spec.gates === 'birth') {
    // The gate rows are fixed per game and INSERT OR IGNORE, and a body is
    // never deleted, so a board whose gate is already out cannot film the
    // birth again: it would "spawn" into the rows that are already there.
    const out = await env.DB
      .prepare(`SELECT 1 AS x FROM game_bodies WHERE game_id = ? AND id LIKE ? LIMIT 1`)
      .bind(gameId, `${gameId}:sungate_%`).first();
    if (out) throw new Error("gates: 'birth' needs a board whose sun gates have not come out yet; apply the scene without game_id for a fresh game");
    await env.DB.prepare('UPDATE games SET sun_gate_tick = ? WHERE id = ?').bind(tick, gameId).run();
    const sys = gateOrder(gameId)[0];
    return { omen_tick: tick, gate_leaves_sun_at_tick: tick + SUN_GATE_WARNING_TICKS, system: sys.label, gate: sys.solGate };
  }
  if (spec.gates) {
    // Past the whole sequence: the last gate leaves the Sun at
    // omen + warning + interval, and the event stops looking 200 ticks
    // after that. The interval is read, not assumed: a 'birth' take on
    // this board left it at the dial's maximum.
    const conf = await gameCfg(env, gameId);
    const interval = Number(conf.sun_gate_interval) || 40;
    await env.DB.prepare('UPDATE games SET sun_gate_tick = ? WHERE id = ?')
      .bind(tick - (SUN_GATE_WARNING_TICKS + interval + 400), gameId).run();
    const sys = SUN_GATE_SYSTEMS[0];
    await spawnSunGatePair(env, gameId, sys, tick - 40, conf);
    // LANDED MEANS THE SITE IS GONE (2026-10-23). The game's own sun gate
    // step hands a landing site to its gate and retires it on the landing
    // tick, but the omen above is set so far back that the step never
    // looks again, so the site stood for the whole take on the gate's
    // exact orbit and the map drew the gate as "CENTAURI GATE LANDING
    // SITE" (the colony clip). Done here, the step's own write, once the
    // stored gate has landed (an older board keeps its first landing).
    const g = await env.DB
      .prepare('SELECT emerge_until_tick FROM game_bodies WHERE id = ? AND destroyed_at_tick IS NULL')
      .bind(solGateId(gameId, sys)).first();
    if (g && (g.emerge_until_tick == null || Number(g.emerge_until_tick) <= tick)) {
      await handOffLandingSite(env.DB, gameId, sys, tick);
    }
  }
  return null;
}

/**
 * POST /api/admin/studio/games/:gameId/order  (mid-take, from a shot's 'order' step)
 *
 *   { type: 'move', ships: ['st_col_0'], to: 'verdant', settle?: 'station' }
 *     a leg from wherever each hull is parked now, with the real planner.
 *   { type: 'gate', ship: 'st_col_0', then?: { to: 'verdant', settle?: 'station' } }
 *     through the sun gate the hull is parked on: the player's own
 *     crossing (so the gate flashes), and then the leg on from the far end,
 *     departing as it lands.
 *   { type: 'deliver', ship: 'st_fr_0', site: 'ws' }
 *     the parked hull hands its hold to the construction site it sits at
 *     (a scene megastructure's key, a site body's template or full id):
 *     the player's own delivery (actions.js handleDeliverToSite).
 *   { type: 'launch', world: 'earth', owner?: 'terra', target: 'mars', count: 4 }
 *     a salvo from the Missile Silo in that world's city (the owner's, or
 *     the first silo city there), the player's own launch (missiles.js).
 *   { type: 'ram', asteroid: 'midas', target: 'mars' }
 *     the rock's thrusters owner rams it now (fireRam).
 *   { type: 'found', ship: 'st_cs_0', kind: 'warp_gate', orbit: 18, bearing: 90 }
 *     the parked colony ship lays a site's foundation `orbit` units from
 *     its world (actions.js handlePlaceFramework); answers with the site.
 *   { type: 'supply', ships: ['st_fr_0'], from: 'earth', site: 'last' }
 *     freighters on a supply run from a dock to a site (laySupplyRoute).
 * Shapes are checked first (studioScene.js expandTakeOrder).
 * Each answers with the game handler's own reply, or its refusal.
 */
async function handleOrder(req, env, { session, params }) {
  const { gameId } = params;
  if (!(await allowedInGame(req, env, session, gameId))) return err(404, 'not_found', 'no such route');
  const g = await env.DB.prepare('SELECT id, is_test_game, current_tick FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  const res = await runOrder(req, env, gameId, Number(g.current_tick) || 0);
  // THE MAP SEES IT NOW, not at the next tick (2026-10-23). A player's
  // order bumps state_version at the dispatch choke point (index.js) so the
  // next /state misses its cache; this path is not under /api/games/, and
  // a founded site stayed invisible, the colony ship still parked, until a
  // tick rolled the cache key. The director refetches after an order.
  if (res.ok) {
    try { await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(gameId).run(); }
    catch (e) { console.error('studio order: state_version bump failed', e); }
  }
  return res;
}

async function runOrder(req, env, gameId, tick) {
  let o;
  try { o = expandTakeOrder(await readJson(req)); } catch (e) { return err(400, 'bad_order', e.message); }
  const full = (s) => { const raw = String(s ?? ''); return raw.startsWith(`${gameId}:`) ? raw : `${gameId}:${raw}`; };
  const bodyId = async (tpl) => {
    const b = await env.DB.prepare('SELECT id FROM game_bodies WHERE game_id = ? AND template_id = ? AND destroyed_at_tick IS NULL LIMIT 1')
      .bind(gameId, String(tpl ?? '')).first();
    return b?.id ?? null;
  };
  // A construction site, as an order names it: 'last' (the site founded
  // most recently), a scene megastructure's key, a site's id, or its
  // template ('mega_warp_gate', the newest of that kind a faction founded).
  const siteFor = async (key) => {
    const k = String(key ?? '');
    const live = `FROM game_megastructures m JOIN game_bodies b ON b.id = m.body_id
                  WHERE m.game_id = ? AND b.destroyed_at_tick IS NULL`;
    if (k === 'last') {
      return (await env.DB.prepare(`SELECT m.body_id AS id ${live} AND m.founded_by_faction_id IS NOT NULL AND COALESCE(m.ancient, 0) = 0
                                    ORDER BY m.founded_at_tick DESC, b.rowid DESC LIMIT 1`).bind(gameId).first())?.id ?? null;
    }
    const byId = (await env.DB.prepare(`SELECT m.body_id AS id ${live} AND m.body_id IN (?, ?) LIMIT 1`)
      .bind(gameId, `${gameId}:${STUDIO_MARK}mega_${k}`, full(k)).first())?.id;
    if (byId) return byId;
    return (await env.DB.prepare(`SELECT m.body_id AS id ${live} AND b.template_id = ?
                                  ORDER BY (m.founded_by_faction_id IS NOT NULL) DESC, m.founded_at_tick DESC, b.rowid DESC LIMIT 1`)
      .bind(gameId, k).first())?.id ?? null;
  };
  const shipRow = (id) => env.DB
    .prepare('SELECT s.id, s.name, s.owner_faction_id, s.parent_body_id, s.status, f.user_id FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id WHERE s.id = ? AND s.game_id = ?')
    .bind(id, gameId).first();
  const { Room } = await import('./room.js');
  const room = new Room(null, env);
  const leg = async (ship, depart, fromId, toTpl, settle) => {
    const to = await bodyId(toTpl);
    if (!to) throw new Error(`no world '${toTpl}'`);
    const arrive = await room.planLegForShip(gameId, depart, ship.id, ship.owner_faction_id, fromId, to, null);
    if (settle === 'station') await env.DB.prepare(`UPDATE game_ships SET deploy_on_arrival = 'station' WHERE id = ?`).bind(ship.id).run();
    return arrive;
  };
  try {
    if (o?.type === 'move') {
      const out = [];
      for (const s of (Array.isArray(o.ships) ? o.ships : [o.ships])) {
        const ship = await shipRow(full(s));
        if (!ship || ship.status !== 'active' || !ship.parent_body_id) throw new Error(`${s} is not parked`);
        out.push({ ship: ship.id, arrive: await leg(ship, tick, ship.parent_body_id, o.to, o.settle) });
      }
      return json({ ok: true, type: 'move', legs: out });
    }
    if (o?.type === 'gate') {
      const ship = await shipRow(full(o.ship));
      if (!ship) return err(404, 'not_found', `no ship ${o.ship}`);
      const route = actionRoutes.find(x => x.method === 'POST' && x.pattern instanceof RegExp && x.pattern.source.endsWith('\\/gate$'));
      if (!route) throw new Error('gate handler not found');
      const url = new URL(`https://studio/api/games/${gameId}/ships/${ship.id}/gate`);
      const res = await route.handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
        env, { url, session: { user_id: ship.user_id }, params: { gameId, shipId: ship.id } });
      const body = await res.json().catch(() => null);
      if (!res.ok) return err(409, 'gate', body?.error?.message ?? `gate refused (${res.status})`);
      let then = null;
      if (o.then?.to) then = { to: o.then.to, arrive: await leg(ship, Number(body.arrive_at_tick), body.to.id, o.then.to, o.then.settle) };
      return json({ ok: true, type: 'gate', through: body.from?.name, lands: body.arrive_at_tick, then });
    }
    if (o?.type === 'deliver') {
      const ship = await shipRow(full(o.ship));
      if (!ship) return err(404, 'not_found', `no ship ${o.ship}`);
      const key = String(o.site ?? '');
      const site = await siteFor(key);
      if (!site) throw new Error(`no construction site '${key}'`);
      const route = actionRoutes.find(x => x.method === 'POST' && x.pattern instanceof RegExp
        && x.pattern.source.includes('megastructures') && x.pattern.source.endsWith('\\/deliver$'));
      if (!route) throw new Error('deliver handler not found');
      const url = new URL(`https://studio/api/games/${gameId}/megastructures/${site}/deliver`);
      const res = await route.handle(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ship_id: ship.id }),
      }), env, { url, session: { user_id: ship.user_id }, params: { gameId, siteId: site } });
      const body = await res.json().catch(() => null);
      if (!res.ok) return err(409, 'deliver', body?.error?.message ?? `delivery refused (${res.status})`);
      return json({ ok: true, type: 'deliver', ...body });
    }
    if (o.type === 'found') {
      // THE PLAYER'S OWN FOUNDING (actions.js handlePlaceFramework): the
      // parked colony ship, a point in the sphere of influence of the world
      // it is parked at, posted as its owner, so the research gates, the
      // Construction Module, the neighbourhood rule and the Senate's price
      // all pass judgement. The hull is spent; the site is a new body
      // ('<game>:mega_<random>'), named '<Kind> Site'. The point is worked
      // out here from `orbit` and `angle` or `bearing` at this tick.
      const ship = await shipRow(full(o.ship));
      if (!ship) return err(404, 'not_found', `no ship ${o.ship}`);
      if (ship.status !== 'active' || !ship.parent_body_id) throw new Error(`${o.ship} is not parked at a world`);
      const live = (await env.DB
        .prepare(`SELECT id, name, type, parent_body_id, radius, soi, orbit_radius, orbit_period, angle0
                    FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`)
        .bind(gameId).all()).results ?? [];
      const byId = new Map(live.map(b => [b.id, b]));
      const host = byId.get(ship.parent_body_id);
      if (!host) throw new Error(`${o.ship} is parked at a world that is gone`);
      const rad = Number(host.radius) || 1;
      const soi = Number(host.soi) || 0;
      if (o.orbit < rad * 1.5) throw new Error(`found.orbit ${o.orbit} is inside ${host.name} or on its surface (radius ${rad}); give at least ${Math.ceil(rad * 1.5 * 10) / 10}`);
      if (soi > 0 && o.orbit > soi) throw new Error(`found.orbit ${o.orbit} is outside ${host.name}'s sphere of influence (${Math.round(soi * 10) / 10})`);
      const c = bodyPositionAt(host, byId, tick);
      let theta;
      if (o.angle != null) theta = (o.angle * Math.PI) / 180;
      else {
        // The world's heading: its motion in the Sun's frame, by finite
        // difference, as fireRam takes a rock's velocity.
        const a = bodyPositionAt(host, byId, tick - 0.01);
        const b = bodyPositionAt(host, byId, tick + 0.01);
        theta = Math.atan2(b.y - a.y, b.x - a.x) + (o.bearing * Math.PI) / 180;
      }
      const x = c.x + Math.cos(theta) * o.orbit;
      const y = c.y + Math.sin(theta) * o.orbit;
      const route = actionRoutes.find(r => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.source.endsWith('\\/place-framework$'));
      if (!route) throw new Error('place-framework handler not found');
      const url = new URL(`https://studio/api/games/${gameId}/ships/${ship.id}/place-framework`);
      const res = await route.handle(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: o.kind, x, y, ...(o.variant ? { variant: o.variant } : {}) }),
      }), env, { url, session: { user_id: ship.user_id }, params: { gameId, shipId: ship.id } });
      const body = await res.json().catch(() => null);
      if (!res.ok) return err(409, 'found', body?.error?.message ?? `founding refused (${res.status})`);
      const deg = ((theta * 180) / Math.PI % 360 + 360) % 360;
      return json({
        ok: true, type: 'found', tick, site: body.site.id, key: String(body.site.id).replace(/^[^:]+:/, ''),
        name: body.site.name, kind: o.kind, at: host.name, orbit: o.orbit, angle: Math.round(deg * 10) / 10,
      });
    }
    if (o.type === 'supply') {
      const site = await siteFor(o.site);
      if (!site) throw new Error(`no construction site '${o.site}'`);
      const from = await bodyId(o.from);
      if (!from) throw new Error(`no world '${o.from}'`);
      const ships = [];
      for (const s of o.ships) {
        const ship = await shipRow(full(s));
        if (!ship) return err(404, 'not_found', `no ship ${s}`);
        ships.push(ship);
      }
      if (new Set(ships.map(s => s.owner_faction_id)).size > 1) throw new Error('supply: the freighters on one route belong to one empire');
      try {
        const r = await laySupplyRoute(env, gameId, {
          shipIds: ships.map(s => s.id), fromId: from, siteId: site, userId: ships[0].user_id, loops: o.loops, name: o.name,
        });
        return json({ ok: true, type: 'supply', tick, site, ...r });
      } catch (e) {
        return err(409, 'supply', String(e?.message ?? e));
      }
    }
    if (o?.type === 'launch') {
      const world = await bodyId(o.world);
      if (!world) throw new Error(`no world '${o.world}'`);
      const target = await bodyId(o.target);
      if (!target) throw new Error(`no world '${o.target}'`);
      const count = Math.max(1, Math.min(25, Math.floor(Number(o.count) || 1)));
      let owner = null;
      if (o.owner != null) {
        // A scene faction key (its seat is the agent studio-<key>), an
        // agent handle, an empire name, or a faction id.
        const k = String(o.owner);
        const f = await env.DB
          .prepare(`SELECT f.id FROM game_factions f LEFT JOIN users u ON u.id = f.user_id
                     WHERE f.game_id = ? AND (f.id = ? OR f.name = ? OR u.email IN (?, ?)) LIMIT 1`)
          .bind(gameId, full(k), k, `agent+studio-${k}@agents.orbital.local`, `agent+${k}@agents.orbital.local`).first();
        if (!f) throw new Error(`no faction '${k}' in this game`);
        owner = f.id;
      }
      const cities = (await env.DB
        .prepare(`SELECT s.id, s.buildings_json, f.user_id FROM game_settlements s
                    JOIN game_factions f ON f.id = s.owner_faction_id
                   WHERE s.game_id = ? AND s.body_id = ? AND s.type = 'city' AND s.destroyed_at_tick IS NULL
                     ${owner ? 'AND s.owner_faction_id = ?' : ''}
                   ORDER BY (s.id LIKE ?) DESC, s.created_at_tick ASC`)
        .bind(...(owner ? [gameId, world, owner] : [gameId, world]), `${gameId}:${STUDIO_MARK}%`).all()).results ?? [];
      const city = cities.find(c => {
        try { return Number(JSON.parse(c.buildings_json || '{}')?.missile_silo) >= 1; } catch { return false; }
      });
      if (!city) throw new Error(`no city with a Missile Silo on ${o.world}${o.owner ? ` owned by ${o.owner}` : ''}; seed one with silos[]`);
      const route = missileRoutes.find(x => x.method === 'POST' && x.pattern.source.endsWith('missiles\\/launch$'));
      if (!route) throw new Error('missile launch handler not found');
      const url = new URL(`https://studio/api/games/${gameId}/settlements/${encodeURIComponent(city.id)}/missiles/launch`);
      const res = await route.handle(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_body_id: target, count }),
      }), env, { url, session: { user_id: city.user_id }, params: { gameId, settlementId: encodeURIComponent(city.id) } });
      const body = await res.json().catch(() => null);
      if (!res.ok) return err(409, 'launch', body?.error?.message ?? `launch refused (${res.status})`);
      return json({ ok: true, type: 'launch', city: city.id, ...body });
    }
    if (o?.type === 'ram') {
      const rock = await bodyId(o.asteroid);
      if (!rock) throw new Error(`no asteroid '${o.asteroid}'`);
      const target = await bodyId(o.target);
      if (!target) throw new Error(`no world '${o.target}'`);
      const owner = await env.DB
        .prepare(`SELECT s.owner_faction_id AS fid, f.user_id FROM game_settlements s
                    JOIN game_factions f ON f.id = s.owner_faction_id
                   WHERE s.game_id = ? AND s.body_id = ? AND s.destroyed_at_tick IS NULL
                     AND s.buildings_json LIKE '%trajectory_thrusters%' LIMIT 1`)
        .bind(gameId, rock).first();
      if (!owner) throw new Error(`${o.asteroid} has no station with thrusters; seed it with worlds[].thrusters`);
      const r = await fireRam(env, gameId, { rockId: rock, targetId: target, factionId: owner.fid, userId: owner.user_id, depart: tick });
      return json({ ok: true, type: 'ram', asteroid: o.asteroid, target: o.target, ...r });
    }
    return err(400, 'bad_request', "type must be 'move', 'gate', 'deliver', 'found', 'supply', 'launch' or 'ram'");
  } catch (e) {
    return err(400, 'bad_order', String(e?.message ?? e));
  }
}

// ---------- handlers ----------

async function handleCatalog(req, env, { session }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  return json({
    classes: SHIP_CLASSES,
    loadouts: Object.keys(LOADOUT_PRESETS),
    default_loadouts: DEFAULT_LOADOUTS,
    slots: SHIP_SLOT_COUNTS,
    stats: SHIP_COMBAT_STATS,
    emblems: EMBLEM_IDS,
    bodies: BODY_CATALOG.map(b => ({ id: b.id, name: b.name, type: b.type, parent: b.parent, radius: b.radius, start: isValidStartingBody(b.id) })),
    strike_charge_ticks: MEGA_STRIKE_CHARGE_TICKS,
    // Senate sliders a scene's `laws` may set: id, label, range, default.
    sliders: SLIDER_CATALOG.map(s => ({ id: s.id, label: s.label, min: s.min, max: s.max, default: s.default, per_faction: s.perFaction !== false })),
    sanctions: ['war_authorization', 'trade_embargo', 'production_sanction'],
    // A scene's `megastructures[].kind`, with what each costs to finish.
    megastructures: MEGASTRUCTURE_KINDS.map(k => ({ kind: k, label: MEGASTRUCTURES[k].label, cost: MEGASTRUCTURES[k].cost })),
    // Worlds a station's thrusters can ram (`worlds[].thrusters`).
    rogue_asteroids: ROGUE_ASTEROIDS,
    examples: EXAMPLES,
  });
}

async function handleList(req, env, { session }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  const rows = (await env.DB.prepare(
    `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms, g.created_at
       FROM games g JOIN rooms r ON r.id = g.id
      WHERE COALESCE(g.is_test_game, 0) = 1 AND r.name LIKE 'Studio:%'
      ORDER BY g.created_at DESC LIMIT 40`).all()).results ?? [];
  return json({ games: rows });
}

async function handleValidate(req, env, { session }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  const body = await readJson(req);
  try {
    const spec = expandScenario(body);
    return json({ ok: true, summary: summarize(spec) });
  } catch (e) {
    return err(400, 'bad_scene', e.message);
  }
}

async function handleApply(req, env, { session }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  const body = await readJson(req);
  let spec;
  try { spec = expandScenario(body); } catch (e) { return err(400, 'bad_scene', e.message); }
  try {
    const out = await applyScenario(env, spec, { session });
    return json(out, { status: spec.gameId ? 200 : 201 });
  } catch (e) {
    console.error('studio apply failed', e);
    return err(409, 'apply_failed', e.message);
  }
}

/** Run N ticks now, whoever hosts the room: the studio is the director. */
async function handleTick(req, env, { session, params }) {
  const { gameId } = params;
  if (!(await allowedInGame(req, env, session, gameId))) return err(404, 'not_found', 'no such route');
  const g = await env.DB.prepare('SELECT id, is_test_game, current_tick FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  const body = await readJson(req);
  const n = Math.max(1, Math.min(12, Number(body?.n) || 1));
  // `expect`: the tick the caller is advancing FROM. A retried request
  // whose first try went through (an error reply, the tick committed)
  // finds the game already past it and does nothing, so a retry can never
  // tick twice (it did: a Studio take ran a tick ahead, 2026-10-22).
  if (body?.expect != null && Number(body.expect) !== Number(g.current_tick)) {
    return json({ ok: true, ticks: 0, from: g.current_tick, current_tick: g.current_tick, already: true });
  }
  let last = null;
  for (let i = 0; i < n; i++) {
    const res = await roomStub(env, gameId).fetch('https://room/tick-now', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // freshConfig: the room re-reads this game's dials before the tick
      // (room.js /tick-now), so the dials a scene just set (far systems,
      // the Leviathan's wind-up) are the ones its first tick runs on.
      body: JSON.stringify({ force: true, gameId, freshConfig: true }),
    });
    last = await res.json().catch(() => null);
  }
  const after = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  return json({ ok: true, ticks: n, from: g.current_tick, current_tick: after?.current_tick ?? null, last });
}

/**
 * POST /api/admin/studio/games/:gameId/strike  { ship: 'st_md_0', ticks: 3 }
 *
 * Arm a Mega Destroyer over the world it is parked at, firing `ticks`
 * ticks from now. A shot calls this the moment the hull has arrived: the
 * tick clears any strike armed while a hull is flying or away from its
 * target, so a scene cannot arm one before the burn. Writes what the
 * player's own order writes (actions.js handleMegaStrike), charge
 * chronicle included, with a short charge instead of the 24-tick one.
 */
async function handleStrike(req, env, { session, params }) {
  const { gameId } = params;
  if (!(await allowedInGame(req, env, session, gameId))) return err(404, 'not_found', 'no such route');
  const g = await env.DB.prepare('SELECT id, is_test_game, current_tick FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  const body = await readJson(req);
  const raw = String(body?.ship ?? '');
  const shipId = raw.startsWith(`${gameId}:`) ? raw : `${gameId}:${raw}`;
  const ticks = Math.max(1, Math.min(48, Math.floor(Number(body?.ticks) || MEGA_STRIKE_CHARGE_TICKS)));
  const ship = await env.DB
    .prepare(`SELECT id, name, owner_faction_id, parent_body_id, ship_class, status FROM game_ships WHERE id = ? AND game_id = ?`)
    .bind(shipId, gameId).first();
  if (!ship) return err(404, 'not_found', `no ship ${raw}`);
  if (ship.ship_class !== 'mega_destroyer') return err(409, 'not_a_mega', `${ship.name} is not a Mega Destroyer`);
  if (ship.status !== 'active') return err(409, 'gone', `${ship.name} is gone`);
  const flying = await env.DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(ship.id).first();
  if (flying || !ship.parent_body_id) return err(409, 'in_flight', `${ship.name} has not arrived yet`);
  const target = await env.DB
    .prepare(`SELECT id, name, terraformed_at_tick, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ?`)
    .bind(ship.parent_body_id, gameId).first();
  if (!target) return err(409, 'nowhere', 'it is not over a world');
  const mode = target.terraformed_at_tick != null ? 'sterilise' : 'obliterate';
  const tick = Number(g.current_tick) || 0;
  const ready = tick + ticks;
  await env.DB.batch([
    env.DB.prepare('UPDATE game_ships SET strike_target_body_id = ?, strike_ready_tick = ?, strike_mode = ? WHERE id = ?')
      .bind(target.id, ready, mode, ship.id),
    env.DB.prepare(
      `INSERT INTO chronicle_entries
        (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'mega_strike_charging', ?, ?, ?, ?, 'public', ?)`,
    ).bind(`mdcharge_${crypto.randomUUID().slice(0, 10)}`, gameId, tick, ship.owner_faction_id, target.id,
      target.owner_faction_id ?? null,
      JSON.stringify({ world: target.name, ship: ship.name, fires_at_tick: ready, mode }), Date.now()),
  ]);
  return json({ ok: true, ship: ship.id, world: target.name, mode, fires_at_tick: ready });
}

/**
 * POST /api/admin/studio/games/:gameId/hull  { ship: 'st_mega_0', hp: 250 }
 *
 * Set a hull's HP mid-shot, so a death lands on cue: the kill itself
 * still comes from the next tick's real combat. Fire distribution varies
 * from take to take, so a scripted ending ("then it is destroyed") needs
 * this rather than tuned HP. Test games only; never above hp_max.
 */
async function handleHull(req, env, { session, params }) {
  const { gameId } = params;
  if (!(await allowedInGame(req, env, session, gameId))) return err(404, 'not_found', 'no such route');
  const g = await env.DB.prepare('SELECT id, is_test_game FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  const body = await readJson(req);
  const raw = String(body?.ship ?? '');
  const shipId = raw.startsWith(`${gameId}:`) ? raw : `${gameId}:${raw}`;
  const hp = Number(body?.hp);
  if (!Number.isFinite(hp) || hp <= 0) return err(400, 'bad_request', 'hp must be a positive number');
  const r = await env.DB
    .prepare(`UPDATE game_ships SET hp = MIN(?, hp_max) WHERE id = ? AND game_id = ? AND status = 'active'`)
    .bind(hp, shipId, gameId).run();
  if (!r.meta?.changes) return err(404, 'not_found', `no active ship ${raw}`);
  return json({ ok: true, ship: shipId, hp });
}

async function handleReset(req, env, { session, params }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  const { gameId } = params;
  const g = await env.DB.prepare('SELECT id, is_test_game FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  await resetStudioRows(env, gameId);
  return json({ ok: true });
}

/** Close a studio game: it leaves everyone's lists and stops ticking. */
async function handleClose(req, env, { session, params }) {
  if (!(await allowed(req, env, session))) return err(404, 'not_found', 'no such route');
  const { gameId } = params;
  const g = await env.DB.prepare('SELECT id, is_test_game FROM games WHERE id = ?').bind(gameId).first();
  if (!g || (g.is_test_game ?? 0) !== 1) return err(404, 'not_found', 'no such test game');
  await env.DB.batch([
    env.DB.prepare("UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ?").bind(Date.now(), gameId),
    env.DB.prepare("UPDATE games SET status = 'abandoned', completed_at = ? WHERE id = ?").bind(Date.now(), gameId),
  ]);
  return json({ ok: true });
}

function summarize(spec) {
  return {
    name: spec.name, game: spec.gameId ?? '(new)', factions: spec.factions.map(f => `${f.key} @ ${f.home ?? '?'}`),
    wars: spec.wars.length, worlds: spec.worlds.length,
    ships: spec.ships.map(g => `${g.key}: ${g.hulls.length} at ${g.at} (${g.owner})`),
    fleets: spec.fleets.map(f => f.key), orders: spec.orders.map(o => o.type),
    laws: spec.laws.map(l => l.kind === 'law' ? `${l.slider}=${l.value}${l.target ? ' on ' + l.target : ''}` : `${l.kind} on ${l.target}`),
    gates: spec.gates || false,
    megastructures: spec.megastructures.map(m => `${m.key}: ${m.kind} at ${m.at} (${m.owner}, ${m.complete ? 'complete' : `${Math.round(m.progress * 100)}%`})`),
    kaiju: spec.kaiju ? `Leviathan at ${spec.kaiju.at}, ${spec.kaiju.chargeTicks}-tick wind-up` : null,
  };
}

export const routes = [
  { method: 'GET', pattern: '/api/admin/studio/catalog', auth: 'required', handle: handleCatalog },
  { method: 'GET', pattern: '/api/admin/studio/games', auth: 'required', handle: handleList },
  { method: 'POST', pattern: '/api/admin/studio/validate', auth: 'required', handle: handleValidate },
  { method: 'POST', pattern: '/api/admin/studio/games', auth: 'required', handle: handleApply },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/tick$/, auth: 'required', handle: handleTick },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/strike$/, auth: 'required', handle: handleStrike },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/hull$/, auth: 'required', handle: handleHull },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/order$/, auth: 'required', handle: handleOrder },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/reset$/, auth: 'required', handle: handleReset },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/close$/, auth: 'required', handle: handleClose },
];
