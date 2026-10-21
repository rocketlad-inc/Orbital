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
import { STUDIO_MARK, SHIP_CLASSES, LOADOUT_PRESETS, FUEL_MAX, TAG, whenTick, expandScenario, EXAMPLES } from './studioScene.js';
import { routes as actionRoutes, MEGA_STRIKE_CHARGE_TICKS } from './actions.js';

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
  const factions = await resolveFactions(env, gameId, spec);
  const fid = (key) => factions.get(key).id;

  const bodies = new Map(((await env.DB
    .prepare('SELECT id, template_id, name, radius, terraformed_at_tick, parent_body_id, owner_faction_id, destroyed_at_tick FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all()).results ?? []).map(b => [b.template_id, b]));
  const bodyOf = (tpl, where) => {
    const b = bodies.get(tpl);
    if (!b) throw new Error(`${where}: no world '${tpl}' in this game`);
    return b;
  };

  if (spec.reset) await resetStudioRows(env, gameId);

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

  // ---- worlds ----
  const worldStmts = [];
  for (const w of spec.worlds) {
    const b = bodyOf(w.body, 'worlds');
    if (w.owner) {
      worldStmts.push(env.DB.prepare(
        `UPDATE game_bodies SET owner_faction_id = ?, development_level = CASE WHEN development_level < 2 THEN 2 ELSE development_level END,
                claimed_at_tick = COALESCE(claimed_at_tick, ?), developed_at_tick = COALESCE(developed_at_tick, ?),
                terraformed_at_tick = CASE WHEN ? THEN COALESCE(terraformed_at_tick, ?) ELSE terraformed_at_tick END
          WHERE id = ?`).bind(fid(w.owner), tick, tick, w.living ? 1 : 0, tick, b.id));
    } else if (w.living) {
      worldStmts.push(env.DB.prepare('UPDATE game_bodies SET terraformed_at_tick = COALESCE(terraformed_at_tick, ?) WHERE id = ?').bind(tick, b.id));
    }
    w.cities.forEach((name, i) => {
      worldStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population,
            surface_angle, created_at_tick, last_growth_tick, last_harvest_tick, has_collector)
         VALUES (?, ?, ?, ?, 'city', ?, 300, 300, 2, ?, ?, ?, ?, 1)`)
        .bind(`${gameId}:${STUDIO_MARK}c_${w.body}_${i}`, gameId, b.id, fid(w.owner ?? spec.viewer), name, (i * 2.1 + 0.4) % 6.28, tick, tick, tick));
    });
    for (let i = 0; i < w.stations; i++) {
      const r = Number(b.radius) + Math.max(3, 0.22 * Number(b.radius));
      worldStmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population,
            orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, created_at_tick, last_growth_tick, last_harvest_tick, has_collector)
         VALUES (?, ?, ?, ?, 'station', ?, 400, 400, 1, ?, ?, 0, ?, ?, ?, ?, ?, 1)`)
        .bind(`${gameId}:${STUDIO_MARK}s_${w.body}_${i}`, gameId, b.id, fid(w.owner ?? spec.viewer), `${b.name} Station ${i + 1}`, r, r, i * 2.5, tick, tick, tick, tick));
    }
  }
  if (worldStmts.length) await env.DB.batch(worldStmts);
  for (const w of spec.worlds) if (w.owner) await recomputeBodyOwnership(env.DB, gameId, bodyOf(w.body, 'worlds').id);

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
            orbit_epoch, orbit_direction, fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, icon_variant, parts_json, home_body_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, gameId, fid(g.owner), name, cls, b.id, rp, rp, parkPhaseFor(id), tick, fuel, fuel, Math.max(0, tick - 1),
          hpMax, hpMax, st.damage_per_tick, g.variant, parts.length ? JSON.stringify(parts) : null, b.id));
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
    const isStar = (b) => b.parent_body_id == null;
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

  const shipsOf = (ref) => {
    const [key, idx] = String(ref).split('.');
    const ids = shipIds[key] ?? [];
    return idx != null ? ids.slice(Number(idx), Number(idx) + 1) : ids;
  };

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

  // ---- orders ----
  const done = [];
  let room = null;
  for (const o of spec.orders) {
    if (o.type === 'move') {
      if (!room) { const { Room } = await import('./room.js'); room = new Room(null, env); }
      const to = bodyOf(o.to, 'orders.move');
      const ids = shipsOf(o.ships);
      const depart = Math.max(tick, whenTick(o.depart, tick));
      let arrive = o.arrive ? whenTick(o.arrive, tick) : null;
      // A group flies together: plan once to learn the slowest leg, then
      // hold every hull to that arrival, as guards are paced to freighters.
      if (arrive == null && ids.length > 1) {
        let longest = 0;
        for (const id of ids) {
          const r = shipRows.get(id);
          const probe = await room.planLegForShip(gameId, depart, id, fid(r.owner), r.at.id, to.id, null);
          longest = Math.max(longest, Number(probe) || 0);
        }
        await env.DB.prepare('DELETE FROM game_ship_nodes WHERE game_id = ? AND status = ? AND ship_id IN (' + ids.map(() => '?').join(',') + ')')
          .bind(gameId, 'committed', ...ids).run();
        arrive = longest;
      }
      const arrivals = [];
      for (const id of ids) {
        const r = shipRows.get(id);
        arrivals.push(await room.planLegForShip(gameId, depart, id, fid(r.owner), r.at.id, to.id, arrive));
      }
      done.push({ type: 'move', ships: ids.length, to: o.to, depart, arrive: Math.max(...arrivals) });
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
    }
  }

  return {
    ok: true, game_id: gameId, created, tick,
    factions: spec.factions.map(f => ({ key: f.key, id: factions.get(f.key).id, name: f.name, handle: f.handle,
      seat_me: spec.seatMe && f.key === spec.viewer })),
    viewer: spec.viewer, ships: shipIds, fleets: fleetIds, wars: warIds.length, orders: done, laws: lawIds, silos: siloOut,
  };
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
  let last = null;
  for (let i = 0; i < n; i++) {
    const res = await roomStub(env, gameId).fetch('https://room/tick-now', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, gameId }),
    });
    last = await res.json().catch(() => null);
  }
  const after = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  return json({ ok: true, ticks: n, from: g.current_tick, current_tick: after?.current_tick ?? null, last });
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
  };
}

export const routes = [
  { method: 'GET', pattern: '/api/admin/studio/catalog', auth: 'required', handle: handleCatalog },
  { method: 'GET', pattern: '/api/admin/studio/games', auth: 'required', handle: handleList },
  { method: 'POST', pattern: '/api/admin/studio/validate', auth: 'required', handle: handleValidate },
  { method: 'POST', pattern: '/api/admin/studio/games', auth: 'required', handle: handleApply },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/tick$/, auth: 'required', handle: handleTick },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/reset$/, auth: 'required', handle: handleReset },
  { method: 'POST', pattern: /^\/api\/admin\/studio\/games\/(?<gameId>[A-Za-z0-9_-]{6,32})\/close$/, auth: 'required', handle: handleClose },
];
