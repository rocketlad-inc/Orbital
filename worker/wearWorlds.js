// ============================================================
// The watch's window into the game: the systems and the Porthole.
//
//   GET /wear/<token>/worlds.json      every world you have ships at,
//                                      with every ship in that orbit,
//                                      and every system laid out
//   GET /wear/icon/<key>/<px>.png      the real ship icon, as a PNG
//
// THE PORTHOLE is one world per page on the watch: the planet, your
// ships going around it, the rivals sharing the orbit, and -- when the
// world is a battlefield -- who is shooting at whom. So this sends, per
// world, every ship parked there (not in transit), its icon, its hull
// health, its fleet and whether it leads it, whether it is in the fight
// and the ship it last fired on.
//
// EVERY WORLD YOUR SENSORS REACH, not only the ones you are at (Lorne:
// "tab through each system, see all the worlds in that system, and click
// one to see the ships in orbit. But only show the ships in orbit if
// within sensor range"). WHICH worlds is the game's own answer: this
// asks the /state handler, as the player, and takes its `visible_to_me`
// -- presence, moons and parents, every friendly and allied sensor at
// the map's scale, Deep Space Arrays, rival Null Fields -- rather than a
// second copy of those rules that would drift. Ships parked at any of
// those worlds are listed; everywhere else the watch shows the world and
// says it is out of sensor range.
//
// NO SENSOR FOG ON WHO IS IN A SHARED ORBIT. Lorne: "There is no
// scenario where rival ships share an orbit and you cant see them." So
// every ship at these worlds is listed, whoever owns it, which is also
// why only worlds you are AT are sent.
//
// BUT A RIVAL'S HEALTH STAYS A SENSORS QUESTION, exactly as on the battle
// card: "a hull you can see shooting at you is not a secret; how badly
// it is hurt is." Without coverage of the world (sensor_coverage level
// 2, coveredBodies), a rival hull goes out with hp null and the icon's
// UNKNOWN colouring -- the grey the game draws it in -- so the Porthole
// shows the ship and withholds its condition, and Sensors research keeps
// meaning what it means everywhere else.
//
// THE SYSTEMS are what the bezel turns through: the game's own grouping
// (The Core, the Earth System, the Asteroid Belt, the Kuiper Belt...),
// each world placed along its orbit, belts as a grid, each carrying a
// badge of your ships. Tap a world and the Porthole opens on it.
//
// THE ICON IS THE GAME'S ShipIcon, never a lookalike: the same generated
// SVG the battle card rasterises (generated/shipIconSvgs.js via
// shipIconRaster.js), keyed class:variant:health exactly as the
// situation log colours it. It is public and immutable per key, so the
// watch fetches each once and keeps it.
// ============================================================

import { authorizeWear, factionIdFor } from './wear.js';
import { widgetSnapshot } from './widget.js';
import { makeSystemRootOf, systemLabel, isWorld, summarizeSystems } from './systems.js';
import { bodyPositionAt } from './megastructures.js';
import { configureRasterizer, rasterReady, rasterIcon, iconKey } from './shipIconRaster.js';
import { coveredBodies } from './battleWidget.js';
import { callGame } from './wearOrders.js';
import { encodePng } from './heraldPng.js';
import { spriteKey } from './planetSvg.js';
import { SHIP_ICON_SVGS } from './generated/shipIconSvgs.js';

export const WEAR_WORLDS_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/worlds\.json$/;
export const WEAR_ICON_RE = /^\/wear\/icon\/([a-z_]+:[A-S]:(?:green|amber|red|unknown))\/(\d{2,3})\.png$/;

/** A world with more hulls than this is drawn as its biggest ones plus a
 *  count: a 1.4 inch screen cannot show 140 ships as anything but noise,
 *  and the payload stays small. Yours are kept before rivals'. */
const MAX_SHIPS_PER_WORLD = 40;

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function handleWearWorlds(_req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;

  const snap = await widgetSnapshot(env, auth.userId);
  // AN ELIMINATED PLAYER STILL WATCHES. The game goes on around them and
  // the map still shows it; the watch said "NO SYSTEMS" instead, which
  // read as broken. Only a game that has ENDED has nothing to show.
  if (!snap || (snap.state !== 'live' && snap.state !== 'eliminated')) {
    return json({ ok: true, state: snap?.state ?? 'none', worlds: [], systems: [] });
  }
  const gameId = snap.gameId;
  const tick = snap.tick;
  const me = await factionIdFor(env, gameId, auth.userId);
  if (!me) return json({ ok: true, state: 'none', worlds: [], systems: [] });

  const seen = await visibleBodies(env, auth.userId, gameId);
  const [bodiesRes, shipsRes, factionsRes, battlesRes, fightersRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, template_id, name, type, parent_body_id, radius, orbit_radius, orbit_period,
              angle0, color, owner_faction_id, terraformed_at_tick, yield_metal
         FROM game_bodies
        WHERE game_id = ?1 AND destroyed_at_tick IS NULL`,
    ).bind(gameId).all(),
    // Every hull PARKED at a world where I have a hull parked. A ship in
    // transit still carries its origin in parent_body_id, so the
    // in_transit node is what rules it out. Subqueries, not bound id
    // lists: D1 caps a statement at 100 parameters.
    env.DB.prepare(
      `WITH parked AS (
         SELECT s.* FROM game_ships s
          WHERE s.game_id = ?1 AND s.status = 'active' AND s.hp > 0
            AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                             WHERE n.ship_id = s.id AND n.status = 'in_transit')
       )
       SELECT p.id, p.name, p.ship_class, p.icon_variant, p.hp, p.hp_max,
              p.owner_faction_id, p.parent_body_id, p.fleet_id, p.fleet_detached,
              p.last_target_id,
              (f.flag_captain_id IS NOT NULL AND f.flag_captain_id = p.captain_id) AS flagship
         FROM parked p
         LEFT JOIN game_fleets f ON f.id = p.fleet_id
        WHERE p.parent_body_id IN (SELECT parent_body_id FROM parked WHERE owner_faction_id = ?2)
           OR p.parent_body_id IN (SELECT value FROM json_each(?3))
        ORDER BY p.parent_body_id, (p.owner_faction_id = ?2) DESC, p.hp_max DESC
        LIMIT 1500`,
    ).bind(gameId, me, JSON.stringify([...(seen ?? [])])).all(),
    env.DB.prepare('SELECT id, name, color FROM game_factions WHERE game_id = ?1').bind(gameId).all(),
    env.DB.prepare(
      `SELECT id, body_id, last_fire_tick, started_tick
         FROM battles
        WHERE game_id = ?1 AND status = 'active' AND body_id IS NOT NULL`,
    ).bind(gameId).all(),
    env.DB.prepare(
      `SELECT p.ship_id
         FROM battle_participants p
         JOIN battles b ON b.id = p.battle_id
        WHERE b.game_id = ?1 AND b.status = 'active' AND p.died_tick IS NULL`,
    ).bind(gameId).all(),
  ]);

  const bodies = bodiesRes.results ?? [];
  const byId = new Map(bodies.map(b => [b.id, b]));
  const factions = {};
  for (const f of factionsRes.results ?? []) factions[f.id] = { name: f.name, color: f.color };
  const fighting = new Set((fightersRes.results ?? []).map(r => r.ship_id));
  const battleAt = new Map();
  for (const b of battlesRes.results ?? []) {
    battleAt.set(b.body_id, {
      // "Firing" is a shot this tick or the last one. A battle can be
      // open with nobody in range yet; the watch draws that differently.
      firing: (Number(b.last_fire_tick) || -99) >= tick - 1,
      since: b.started_tick,
    });
  }

  // ---- worlds ---------------------------------------------------------
  const byWorld = new Map();
  for (const s of shipsRes.results ?? []) {
    let w = byWorld.get(s.parent_body_id);
    if (!w) { w = []; byWorld.set(s.parent_body_id, w); }
    w.push(s);
  }
  const covered = await coveredBodies(env, gameId, me, [...byWorld.keys()]);
  const worlds = [];
  for (const [bodyId, list] of byWorld) {
    const body = byId.get(bodyId);
    if (!body) continue;
    const counts = {};
    for (const s of list) counts[s.owner_faction_id] = (counts[s.owner_faction_id] ?? 0) + 1;
    const shown = list.slice(0, MAX_SHIPS_PER_WORLD);
    const shownIds = new Set(shown.map(s => s.id));
    const parent = body.parent_body_id ? byId.get(body.parent_body_id) : null;
    worlds.push({
      id: body.id,
      name: body.name,
      type: body.type,
      color: body.color,
      radius: Number(body.radius) || 1,
      parent: parent && parent.type !== 'star' ? parent.name : null,
      owner: body.owner_faction_id ?? null,
      sp: spriteKey(body),
      battle: battleAt.get(bodyId) ?? null,
      counts,
      ships: shown.map(s => {
        const visible = s.owner_faction_id === me || covered.has(bodyId);
        const pct = visible && s.hp_max > 0
          ? Math.max(0, Math.min(100, Math.round((s.hp / s.hp_max) * 100)))
          : null;
        const inFight = fighting.has(s.id);
        return {
          id: s.id,
          n: s.name,
          k: iconKey(s.ship_class, s.icon_variant, pct),
          cls: s.ship_class,
          hp: pct,
          f: s.owner_faction_id,
          fl: s.fleet_id && !s.fleet_detached ? s.fleet_id : null,
          lead: !!s.flagship,
          c: inFight,
          // Only a target the watch can draw a tracer to: in this fight,
          // in this orbit, on screen.
          t: inFight && s.last_target_id && shownIds.has(s.last_target_id) ? s.last_target_id : null,
        };
      }),
    });
  }
  // Burning worlds first, then where most of your hulls are.
  worlds.sort((a, b) =>
    (b.battle ? 1 : 0) - (a.battle ? 1 : 0)
    || (b.counts[me] ?? 0) - (a.counts[me] ?? 0));

  // ---- the systems --------------------------------------------------------
  //
  // THE BEZEL MOVES BETWEEN SYSTEMS, AND THEY ARE THE GAME'S SYSTEMS:
  // makeSystemRootOf / systemLabel from systems.js, the grouping the
  // senate, the Herald and (mirrored) the outliner and the map use. So the
  // watch says "Kuiper Belt" exactly where the map does, and a moon files
  // under its planet the way the outliner files it.
  //
  // LAYOUT, per Lorne: a system is drawn along its orbits wherever that
  // is possible -- the planet in the middle, its moons on their rings at
  // their angle this tick -- and a belt (Asteroid Belt, Plutinos, Kuiper
  // Belt, Far Reach), whose rocks share one star-orbit and would pile
  // into a smear, is laid out as a grid.
  //
  // THE BADGE IS YOUR SHIPS, the game's zoomed-out count. Rival counts
  // only where you have ships in that same orbit: anywhere else what is
  // parked there is a sensors question, and this route does not answer it.
  const worldBodies = bodies.filter(isWorld);
  const rootOf = makeSystemRootOf(worldBodies);
  const worldById = new Map(worlds.map(w => [w.id, w]));
  const TWO_PI = Math.PI * 2;
  const localAngle = (b) => (Number(b.angle0) || 0)
    + (Number(b.orbit_period) > 0 ? (TWO_PI * tick * 0.7) / Number(b.orbit_period) : 0);
  const heliocentric = (b) => {
    let cur = b;
    for (let i = 0; cur && i < 6; i++) {
      const p = cur.parent_body_id ? byId.get(cur.parent_body_id) : null;
      if (!p || p.type === 'star') return Number(cur.orbit_radius) || 0;
      cur = p;
    }
    return 0;
  };
  const sysMap = new Map();
  for (const b of worldBodies) {
    if (b.type === 'star') continue;
    const rootId = rootOf(b.id);
    let sys = sysMap.get(rootId);
    if (!sys) {
      sys = {
        id: rootId,
        label: systemLabel(worldBodies, rootId),
        layout: String(rootId).startsWith('belt:') ? 'grid' : 'orbits',
        at: 0,
        bodies: [],
      };
      sysMap.set(rootId, sys);
    }
    const w = worldById.get(b.id);
    const parent = b.parent_body_id ? byId.get(b.parent_body_id) : null;
    sys.bodies.push({
      id: b.id,
      name: b.name,
      type: b.type,
      color: b.color,
      radius: Number(b.radius) || 1,
      // The parent INSIDE this system, for ring layout: a moon's planet.
      // Null for a body that orbits the star (a planet, a belt rock).
      parent: parent && parent.type !== 'star' && rootOf(parent.id) === rootId ? parent.id : null,
      orbit: Number(b.orbit_radius) || 0,
      angle: Math.round(localAngle(b) * 1000) / 1000,
      owner: b.owner_faction_id ?? null,
      // The world's sprite, /wear/planet/<sp>/<px>.png: the game's own
      // planet art (planetSvg.js), so it looks on the wrist as on the map.
      sp: spriteKey(b),
      mine: w ? (w.counts[me] ?? 0) : 0,
      rivals: w ? Object.entries(w.counts).reduce((n, [f, c]) => (f === me ? n : n + c), 0) : 0,
      // Per empire, so each count wears its owner's colour. Only where
      // the world is already in this feed (you are there, or sensors
      // reach it) -- the same rule as the Porthole's ships.
      counts: w ? w.counts : {},
      battle: battleAt.has(b.id) ? (battleAt.get(b.id).firing ? 'firing' : 'open') : null,
      // In sensor range (or yours to see): its Porthole shows its ships.
      seen: !!w || !!seen?.has(b.id),
      // Sun-centred, for the watch face's system map (the Systems page
      // lays bodies out by ring and angle instead).
      ...(() => {
        const pos = bodyPositionAt(b, byId, tick);
        return pos ? { hx: Math.round(pos.x * 1000) / 1000, hy: Math.round(pos.y * 1000) / 1000 } : {};
      })(),
    });
    const h = heliocentric(b);
    if (!sys.at || h < sys.at) sys.at = h;
  }
  // WHO HOLDS EACH SYSTEM, by the senate's own rule (summarizeSystems:
  // strict plurality of owned worlds, a tie is contested). The face's map
  // paints each system's band in its controller's colour, the way the
  // game's zoomed-out map shades territory.
  const control = new Map(summarizeSystems(worldBodies).map(x => [x.rootId, x]));
  const systems = [...sysMap.values()]
    .map(sys => ({
      ...sys,
      controller: control.get(sys.id)?.controller ?? null,
      contested: !!control.get(sys.id)?.contested,
      mine: sys.bodies.reduce((n, b) => n + b.mine, 0),
      battle: sys.bodies.some(b => b.battle === 'firing') ? 'firing'
        : sys.bodies.some(b => b.battle) ? 'open' : null,
    }))
    // Out from the Sun, the order the bezel turns through them.
    .sort((a, b) => a.at - b.at);

  return json({
    ok: true,
    state: snap.state,
    tick,
    now: Date.now(),
    me,
    factions,
    worlds,
    systems,
  });
}

/**
 * The worlds this player can see right now: the game's /state handler's
 * own visible set (visible_body_ids), asked as the player. Null when the state cannot
 * be had, and the feed then falls back to the worlds you are at.
 */
async function visibleBodies(env, userId, gameId) {
  try {
    const r = await callGame(env, null, userId, 'GET', `/api/games/${encodeURIComponent(gameId)}/state`, null);
    if (r.status !== 200 || !Array.isArray(r.body?.visible_body_ids)) return null;
    return new Set(r.body.visible_body_ids);
  } catch (e) {
    console.error('wear worlds: visibility lookup failed', e);
    return null;
  }
}

/** The real ship icon, straight alpha, as a PNG. */
export async function handleWearIcon(_req, env, { params }) {
  const key = params.key;
  const px = Math.max(24, Math.min(160, Number(params.px) || 64));
  if (!SHIP_ICON_SVGS[key]) return new Response('no such icon', { status: 404 });
  try {
    const { default: wasm } = await import('./resvgWasm.js');
    configureRasterizer(wasm);
  } catch (e) {
    console.error('wear icon: rasteriser load failed', e);
  }
  if (!(await rasterReady())) return new Response('icons unavailable', { status: 503 });
  const icon = rasterIcon(key, px);
  if (!icon) return new Response('icon failed', { status: 500 });
  // resvg hands back PREMULTIPLIED rgba; a PNG is straight alpha. Left
  // premultiplied, every soft edge of the hull renders dark.
  const data = new Uint8Array(icon.px.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = icon.px[i + 3];
    data[i + 3] = a;
    if (a === 0) continue;
    data[i] = Math.min(255, Math.round((icon.px[i] * 255) / a));
    data[i + 1] = Math.min(255, Math.round((icon.px[i + 1] * 255) / a));
    data[i + 2] = Math.min(255, Math.round((icon.px[i + 2] * 255) / a));
  }
  const png = await encodePng({ w: icon.w, h: icon.h, data });
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // The key names the drawing exactly; it only changes if the
      // generator reruns, which renames nothing.
      'cache-control': 'public, max-age=604800',
    },
  });
}
