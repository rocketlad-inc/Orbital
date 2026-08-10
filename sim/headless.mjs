// ============================================================================
// headless.mjs — run a real Orbital game with no network and no Cloudflare.
//
// This is the fidelity experiment that has to pass before any balance
// simulation is worth trusting: boot a game using the SERVER's own
// seeding code, advance it with the SERVER's own resolveTick, and see
// whether the resulting world is shaped like a real one.
//
// Nothing in here reimplements a rule. The harness only supplies the two
// things a Durable Object gets for free in production and nowhere else:
//
//   env.DB          — the D1 shim (sim/d1.mjs), real SQLite underneath
//   state.storage   — a Map; the DO's little key/value scratchpad
//
// plus stubs for the parts of the runtime a headless game has no use for
// (websocket broadcast, the ROOM binding used for self-calls).
//
// Usage:  node sim/headless.mjs [ticks] [players] [seed]
//
// The seed is the map_seed. Same seed = same world = same outcome, which
// is what makes a surprising result investigable. Different seeds are the
// population a Monte Carlo run samples from.
// ============================================================================

import { pathToFileURL } from 'node:url';
import { SimD1 } from './d1.mjs';
import * as BOTS from './bots.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const TICKS = Number(process.argv[2] ?? 200);
const PLAYERS = Number(process.argv[3] ?? 4);
const SEED = process.argv[4] ?? 'sim-seed-0001';

/**
 * Victory: first to 200 living hulls AND 10,000 of every resource.
 *
 * Both conditions at once, deliberately — either alone is reachable by
 * a specialist, and the pair forces an empire to be broad. Fuel is not
 * counted: the economy rework retired it ("Fuel was removed from the
 * game economy", actions.js), so requiring 10k of a dead currency would
 * make the condition unreachable by accident rather than by design.
 */
export const VICTORY_SHIPS = 200;
export const VICTORY_RESOURCE = 10000;
/** Ticks between victory checks. See the note at the call site. */
const VICTORY_POLL = 10;

// ---------------------------------------------------------------------------
// Runtime stubs
// ---------------------------------------------------------------------------

/** The DO's durable key/value store. resolveTick barely touches it, but
 *  lobby/start does, and a missing method fails in a confusing place. */
function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { return m.delete(k); },
    async list() { return new Map(m); },
    async deleteAll() { m.clear(); },
    setAlarm() {},
    getAlarm() { return null; },
  };
}

/**
 * Everything a Room DO reads off `state`. Broadcasts are collected rather
 * than dropped: what the server chose to TELL players is itself a signal
 * — a tick that emits ships_destroyed is a tick where combat happened,
 * and that is free instrumentation for the balance work later.
 */
function makeState(broadcasts) {
  return {
    id: { toString: () => 'sim-room' },
    storage: makeStorage(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    blockConcurrencyWhile: async (fn) => fn(),
    _broadcasts: broadcasts,
  };
}

/**
 * Run one whole game headless and return what happened.
 *
 * Exported so a sweep can call it thousands of times in-process. Each
 * call gets its own in-memory database, so runs cannot contaminate each
 * other — which matters more than it sounds: a shared DB would let one
 * game's chronicle rows leak into another's statistics.
 */
export async function runGame({ ticks = 200, players = 4, seed = 'sim-seed-0001', quiet = false, doctrines = null, doctrineOffset = 0, config = null } = {}) {
  const TICKS = ticks, PLAYERS = players, SEED = seed;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const t0 = Date.now();
  const DB = new SimD1(':memory:');
  const applied = DB.applyMigrations(MIGRATIONS);
  log(`schema:  ${applied} migrations applied`);

  const broadcasts = [];
  const env = {
    DB,
    // Self-calls to the room DO. The only ones the start path makes are
    // /settings and /game-started; both are safe to answer with defaults
    // here because the sim has no lobby UI to configure.
    ROOM: {
      idFromName: (n) => ({ toString: () => n }),
      get: () => ({
        fetch: async (url) => {
          if (String(url).includes('/settings')) {
            return new Response(JSON.stringify({ tick_interval_ms: 3600000 }),
              { headers: { 'content-type': 'application/json' } });
          }
          return new Response(null, { status: 204 });
        },
      }),
    },
  };

  // ---- players -----------------------------------------------------------
  // Inserted directly: account creation is password hashing and session
  // plumbing, none of which is a game rule.
  const now = Date.now();
  const roomId = 'simroom00001';
  const users = [];
  for (let i = 0; i < PLAYERS; i++) {
    const id = `simuser${i}`;
    users.push(id);
    await DB.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, created_at)
       VALUES (?, ?, ?, 'x', ?)`,
    ).bind(id, `sim${i}@example.invalid`, `Sim Player ${i}`, now).run();
  }

  await DB.prepare(
    `INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at)
     VALUES (?, ?, ?, 'lobby', ?, ?, ?)`,
  ).bind(roomId, 'Headless Sim', users[0], PLAYERS, now, now).run();

  for (const u of users) {
    await DB.prepare(
      `INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)`,
    ).bind(roomId, u, now).run();
  }

  // ---- start the game with the REAL seeder --------------------------------
  //
  // seedGameWorld is the load-bearing call: it builds the bodies from
  // BODY_CATALOG, assigns capitals and starting fleets, and applies the
  // fair-spawn rules. A sim that seeded its own world would be measuring
  // a different game from tick zero.
  //
  // We insert the games row ourselves rather than going through the lobby
  // start handler for exactly one reason: MAP_SEED. handleStart mints a
  // random one from crypto.getRandomValues, and seedGameWorld feeds it to
  // a mulberry32 PRNG (factions.js makeRand) to pick who spawns where.
  // That is the game's only real dice roll, and a balance harness needs
  // to control it — pin the seed and a surprising result is reproducible;
  // vary the seed and you are sampling the actual distribution of starts.
  // Everything else handleStart does (room status, DO handshake) is lobby
  // bookkeeping, not a game rule.
  await DB.prepare(
    `INSERT INTO games (id, status, map_seed, current_tick, tick_interval_ms, created_at, started_at)
     VALUES (?, 'setup', ?, 0, ?, ?, ?)`,
  ).bind(roomId, SEED, 3600000, now, now).run();
  await DB.prepare("UPDATE rooms SET status = 'in_progress', updated_at = ? WHERE id = ?")
    .bind(now, roomId).run();

  // Parameter sweeps live or die on this: a published game_configs row
  // pinned to the game, so the REAL cfg() path serves the overrides and
  // the sim measures the same resolution order production uses. Writing
  // the knobs straight into the tick would be measuring a model.
  //
  // invalidate() is not optional. gameConfig memoises for 30s keyed on
  // gameId AND on '__published__' for the unpinned lookup; a sweep runs
  // hundreds of games inside that window, so without a flush every game
  // after the first would silently inherit the first game's config and
  // the whole sweep would report one data point drawn N times.
  // ALWAYS flush, config or not. Every sim game reuses the same roomId,
  // so gameConfig's per-game memo hits across runs inside its 30s TTL —
  // caught in testing when a no-config run inherited the previous run's
  // 777-metal purse. An uncleared cache here silently collapses a whole
  // sweep to one data point sampled N times.
  {
    const gc = await import('../worker/gameConfig.js');
    gc.invalidate();
  }
  if (config && Object.keys(config).length > 0) {
    const cfgId = `cfg_${roomId}`;
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms, published_ms)
       VALUES (?, 'sweep', 'published', ?, ?, ?, ?)`,
    ).bind(cfgId, JSON.stringify(config), now, now, now).run();
    await DB.prepare('UPDATE games SET config_id = ? WHERE id = ?').bind(cfgId, roomId).run();
    const gc = await import('../worker/gameConfig.js');
    gc.invalidate();
  }

  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, roomId);
  await DB.prepare("UPDATE games SET status = 'active' WHERE id = ?").bind(roomId).run();

  const seeded = {
    bodies: (await DB.prepare('SELECT COUNT(*) c FROM game_bodies WHERE game_id = ?').bind(roomId).first())?.c,
    factions: (await DB.prepare('SELECT COUNT(*) c FROM game_factions WHERE game_id = ?').bind(roomId).first())?.c,
    ships: (await DB.prepare('SELECT COUNT(*) c FROM game_ships WHERE game_id = ?').bind(roomId).first())?.c,
  };
  log(`seeded:  ${seeded.bodies} bodies, ${seeded.factions} factions, ${seeded.ships} ships`);
  if (!seeded.bodies || !seeded.factions) throw new Error('world did not seed');

  // ---- drive the real tick loop -------------------------------------------
  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(broadcasts), env);
  room.broadcast = (msg) => { broadcasts.push(msg); };

  // Assign a doctrine to each seat. Rotating by index rather than at
  // random keeps a seed fully reproducible, and rotating the OFFSET
  // across seeds stops any archetype from being permanently welded to a
  // spawn — otherwise a sweep would measure "is slot 0 good" instead of
  // "is rushing good".
  const seatFactions = (await DB.prepare(
    'SELECT id, user_id, slot FROM game_factions WHERE game_id = ? ORDER BY slot',
  ).bind(roomId).all()).results;
  const names = doctrines ?? [];
  const seats = seatFactions.map((f, i) => ({
    factionId: f.id,
    userId: f.user_id,
    doctrine: names.length ? BOTS.ARCHETYPES[names[(i + doctrineOffset) % names.length]] : null,
  }));
  const tally = {};
  let midpoint = null;
  let winner = null;

  const tickTimes = [];
  let ticksPlayed = TICKS;
  for (let tick = 1; tick <= TICKS; tick++) {
    const t = Date.now();
    // Orders BEFORE the tick resolves, which is the real sequence: a
    // player queues during the hour, the tick executes at the end of it.
    for (const s of seats) {
      if (!s.doctrine) continue;
      try {
        await BOTS.takeTurn(env, {
          gameId: roomId, userId: s.userId, factionId: s.factionId,
          doctrine: s.doctrine, tick, tally,
        });
      } catch (e) {
        tally[`bot_threw_${e.message.slice(0, 40)}`] = (tally[`bot_threw_${e.message.slice(0, 40)}`] ?? 0) + 1;
      }
    }
    await room.resolveTick(roomId, tick);
    tickTimes.push(Date.now() - t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tick, roomId).run();

    // Victory check. Polled every VICTORY_POLL ticks rather than every
    // tick because it is an aggregate over ships and the answer cannot
    // change quickly at these rates — a fleet does not go from 190 to 200
    // hulls inside ten ticks. Sampling costs one query per ten ticks
    // instead of one per tick, and the reported win tick is accurate to
    // the poll interval, which is stated rather than hidden.
    if (!winner && tick % VICTORY_POLL === 0) {
      const done = await DB.prepare(
        `SELECT f.id, f.name,
                (SELECT COUNT(*) FROM game_ships s
                  WHERE s.owner_faction_id = f.id AND s.hp > 0) ships
           FROM game_factions f
          WHERE f.game_id = ? AND f.status = 'active'
            AND f.metal >= ? AND f.gold >= ? AND f.science >= ?`,
      ).bind(roomId, VICTORY_RESOURCE, VICTORY_RESOURCE, VICTORY_RESOURCE).all();
      const champ = (done.results ?? []).find(r => (r.ships ?? 0) >= VICTORY_SHIPS);
      if (champ) winner = { factionId: champ.id, name: champ.name, tick, ships: champ.ships };
    }

    // Halfway snapshot. One extra query per game buys the snowball
    // question: does a lead at the midpoint predict the finish? A game
    // where it always does has no comeback; one where it never does has
    // no consequence to the first half.
    if (tick === Math.floor(TICKS / 2)) {
      midpoint = (await DB.prepare(
        `SELECT id, metal, gold, science,
                (SELECT COUNT(*) FROM game_bodies b WHERE b.owner_faction_id = f.id) bodies
           FROM game_factions f WHERE f.game_id = ?`,
      ).bind(roomId).all()).results;
    }
    if (!quiet && tick % 50 === 0) process.stdout.write(`  tick ${tick}\r`);
    // Once the condition is met the match is decided; simulating the
    // remainder costs time and teaches nothing.
    if (winner) { ticksPlayed = tick; break; }
  }

  // ---- what came out ------------------------------------------------------
  const facs = (await DB.prepare(
    `SELECT f.id, name, metal, gold, science, fuel,
            (SELECT COUNT(*) FROM game_ships s WHERE s.owner_faction_id = f.id AND s.hp > 0) ships,
            (SELECT COUNT(*) FROM game_bodies b WHERE b.owner_faction_id = f.id) bodies
       FROM game_factions f WHERE f.game_id = ? ORDER BY f.slot`,
  ).bind(roomId).all()).results;

  const chron = (await DB.prepare(
    `SELECT kind, COUNT(*) n FROM chronicle_entries WHERE game_id = ?
      GROUP BY kind ORDER BY n DESC LIMIT 8`,
  ).bind(roomId).all()).results;

  const wall = Date.now() - t0;
  const avg = tickTimes.reduce((a, b) => a + b, 0) / (tickTimes.length || 1);

  if (!quiet) {
    log(`\n--- after ${TICKS} ticks ---`);
    for (const f of facs) {
      log(`  ${String(f.name).slice(0, 26).padEnd(28)} `
        + `${String(f.bodies).padStart(2)} bodies  ${String(f.ships).padStart(2)} ships  `
        + `M${Math.round(f.metal)} C${Math.round(f.gold)} S${Math.round(f.science)}`);
    }
    log('\n--- chronicle ---');
    for (const c of chron) log(`  ${String(c.n).padStart(4)}  ${c.kind}`);
    log(`\n--- performance ---`);
    log(`  ${wall} ms total, ${avg.toFixed(2)} ms/tick, ${DB.queries} queries`);
    log(`  projected 500-tick game: ${((avg * 500) / 1000).toFixed(1)}s`);
    log(`  broadcasts emitted: ${broadcasts.length}`);
  }

  // Attach each seat's doctrine so a sweep can attribute outcomes, plus
  // the two things that explain an outcome: where it started, and how far
  // up the tree it got.
  const bySeat = new Map(seats.map(s2 => [s2.factionId, s2.doctrine?.name ?? null]));

  // Capital template ('earth', 'mars', ...) rather than the game-scoped
  // id, so spawn quality can be pooled ACROSS games.
  const capitals = new Map((await DB.prepare(
    `SELECT f.id, b.template_id FROM game_factions f
       JOIN game_bodies b ON b.id = f.capital_body_id WHERE f.game_id = ?`,
  ).bind(roomId).all()).results.map(r => [r.id, r.template_id]));

  const techs = new Map((await DB.prepare(
    `SELECT faction_id, SUM(level) lv, COUNT(*) tracks
       FROM faction_techs WHERE game_id = ? GROUP BY faction_id`,
  ).bind(roomId).all()).results.map(r => [r.faction_id, r]));

  const mid = new Map((midpoint ?? []).map(m => [m.id, m]));

  const facsOut = facs.map(f => ({
    ...f,
    doctrine: bySeat.get(f.id) ?? null,
    capital: capitals.get(f.id) ?? null,
    techLevels: techs.get(f.id)?.lv ?? 0,
    midWealth: (() => {
      const m = mid.get(f.id);
      return m ? (m.metal ?? 0) + (m.gold ?? 0) + (m.science ?? 0) : null;
    })(),
    midBodies: mid.get(f.id)?.bodies ?? null,
  }));

  return {
    seed: SEED, ticks: TICKS, ticksPlayed, winner, factions: facsOut,
    chronicle: chron, wall, avgTick: avg, broadcasts: broadcasts.length, tally,
    // The live handles, so a diagnostic can interrogate the finished
    // world instead of inferring its state from aggregates. The sweep
    // ignores these; they cost nothing to hand back and they are the
    // difference between "expansion looks stalled" and knowing which
    // gate it stalled at.
    env, gameId: roomId,
  };
}

async function main() {
  await runGame({ ticks: TICKS, players: PLAYERS, seed: SEED });
}

// Run the CLI only when this file IS the program. Without the guard,
// importing runGame() executes main() as a side effect and it reads the
// IMPORTER's argv — sweep.mjs's "30 seeds, 300 ticks" was parsed here as
// "300 players", which seedGameWorld correctly refused since the catalog
// only has 44 claimable worlds.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('\nSIM FAILED:', e.message);
    console.error(e.stack?.split('\n').slice(1, 6).join('\n'));
    process.exit(1);
  });
}
