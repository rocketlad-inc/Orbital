// ============================================================================
// bots.mjs — scripted empires, so the sim plays instead of idling.
//
// The passive sweep measured the game's starting hand. To measure the
// game itself you need someone making decisions, and the decisions have
// to go through the SAME doors a player uses: worker/actions.js route
// handlers, with a fabricated session. A bot that wrote to game_ships
// directly would be testing SQL, not Orbital — it would sail past every
// cost check, tech gate and cooldown that constitutes the balance we are
// trying to measure.
//
// So each bot builds a real Request, hands it to the real handler, and
// gets a real rejection when it tries something the rules forbid. Those
// rejections are DATA: a doctrine that spends half the game being told
// "insufficient metal" is a doctrine the economy does not support.
//
// ON HONESTY. These bots are not good players and are not trying to be.
// They are consistent ones — each expresses a single doctrine so that a
// win rate can be attributed to the doctrine rather than to cleverness.
// Any result here describes Orbital as played by simple agents; it is a
// strong signal about ECONOMIC structure (does this path even function?)
// and a weak one about skilled play. Treat a 70% win rate as "look here",
// never as "this is imbalanced".
// ============================================================================

import * as actions from '../worker/actions.js';

/** Find a route handler by the shape of its pattern + method, so the bots
 *  break loudly if a route is renamed rather than silently no-opping. */
function route(method, marker) {
  const r = actions.routes.find(
    x => x.method === method && String(x.pattern).includes(marker),
  );
  if (!r) throw new Error(`bots: no ${method} route matching ${marker}`);
  return r;
}

const R = {
  build: () => route('POST', 'build$'),
  settlement: () => route('POST', 'settlement$'),
  research: () => route('POST', 'research$'),
  transfer: () => route('POST', 'transfer$'),
};

/**
 * How long a colony ship should claim it needs.
 *
 * WORTH KNOWING: the server does not derive this. handleCommitTransfer
 * takes `arrival_t` from the caller and validates only that it is a
 * finite number after `scheduled_t`; the real trip time is planned
 * CLIENT-side by a brachistochrone burn (src/physics/torchTransfer.ts,
 * T = t1 + t2 over the boost/brake profile). So a caller can name any
 * arrival it likes, and the sim is a caller.
 *
 * That leaves the harness with a choice, and only one honest option.
 * Reimplementing the torch solver here would mean the sim carrying its
 * own physics — the exact drift this whole design avoids — and guessing
 * optimistically would hand the Expander free tempo and manufacture the
 * very result we are testing for. So this estimate is deliberately
 * PESSIMISTIC: a flat floor plus generous time per unit of orbital
 * separation, biased slower than a real player's burn.
 *
 * The bias direction is the point. If expansion still looks strong while
 * its ships fly slower than they would in a real game, that finding is
 * robust. If expansion looks weak, this number is a suspect and the next
 * step is to check it before believing the result.
 */
function transitTicks(fromR, toR) {
  const d = Math.abs((toR ?? 0) - (fromR ?? 0));
  return Math.max(8, Math.ceil(d / 12));
}

/**
 * Call a real action handler as a player. Returns {ok, status, data} and
 * never throws on a rejection — being refused is a normal, informative
 * outcome for a bot.
 */
async function act(env, r, { gameId, userId, params = {}, body = {} }) {
  const req = new Request('https://sim/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await r.handle(req, env, {
    session: { user_id: userId },
    params: { gameId, ...params },
  });
  let data = null;
  try { data = await res.clone().json(); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Doctrines
//
// Each is { name, research, wants(state) -> [intents] }. Intents are
// declarative so the executor can apply them uniformly and tally what got
// refused. Keeping doctrine separate from execution is what lets a new
// archetype be a dozen lines rather than a new bot.
// ---------------------------------------------------------------------------

// A doctrine MUST research the gate for every hull it wants to build.
// The first run ignored this and the results were quietly worthless:
// hull.frigate needs construction 3 and hull.freighter needs propulsion 1
// (worker/researchUnlocks.js), so Rusher never built a frigate and
// Economist — whose only hull was the freighter — never built ANYTHING.
// Economist was therefore an identical twin of Technocrat wearing 3500
// rejected build calls, and their near-identical scores were an artifact
// rather than a finding. Corvette and colony are ungated.
export const ARCHETYPES = {
  // Hulls first, worry later. Tests whether military tempo is affordable.
  rusher: {
    name: 'Rusher',
    research: ['weapons', 'construction', 'armor'],   // construction 3 -> frigate
    build: ['corvette', 'corvette', 'frigate'],
    colonise: false,
    buildEvery: 6,
  },
  // Take ground. The expansion path the economy rework was aimed at.
  expander: {
    name: 'Expander',
    research: ['construction', 'propulsion', 'industry'],
    build: ['colony', 'freighter'],
    colonise: true,
    buildEvery: 10,
  },
  // Sit on the capital and compound. The control for "is expansion
  // actually necessary, or can you win by doing nothing well?"
  economist: {
    name: 'Economist',
    research: ['propulsion', 'industry', 'construction'],   // propulsion 1 -> freighter
    build: ['freighter'],
    colonise: false,
    buildEvery: 14,
  },
  // Straight up the tech tree. Tests whether research outruns economy.
  technocrat: {
    name: 'Technocrat',
    research: ['sensors', 'industry', 'weapons'],
    build: [],
    colonise: false,
    buildEvery: 0,
  },
};

// ---------------------------------------------------------------------------
// The bot loop
// ---------------------------------------------------------------------------

/**
 * One faction's decisions for one tick.
 *
 * Deliberately cheap: a handful of reads and at most a couple of writes.
 * This runs per faction per tick across thousands of games, so anything
 * clever here costs an order of magnitude in sweep time.
 */
export async function takeTurn(env, { gameId, userId, factionId, doctrine, tick, tally }) {
  const DB = env.DB;
  // Attribute every outcome to the DOCTRINE, not just the run. A global
  // "520 insufficient_resources" says the economy is tight; the same
  // number split by doctrine says WHICH strategy it is tight for, which
  // is the difference between an observation and a lead.
  const bump = (k) => {
    const key = `${doctrine.name}:${k}`;
    tally[key] = (tally[key] ?? 0) + 1;
  };

  // --- research: keep something always in progress ------------------------
  // Cheap to check, and an idle research slot is pure waste — the passive
  // sweep showed science piling up unspent.
  const fac = await DB
    .prepare('SELECT research_tech_id, metal, gold, science FROM game_factions WHERE id = ?')
    .bind(factionId).first();

  if (!fac?.research_tech_id && doctrine.research.length) {
    const pick = doctrine.research[tick % doctrine.research.length];
    const r = await act(env, R.research(), {
      gameId, userId, body: { tech_id: pick, queue: doctrine.research },
    });
    bump(r.ok ? 'research_ok' : `research_rej_${r.data?.error?.code ?? r.status}`);
  }

  // --- shipbuilding at any shipyard we hold -------------------------------
  if (doctrine.buildEvery && tick % doctrine.buildEvery === 0 && doctrine.build.length) {
    const yard = await DB
      .prepare(
        `SELECT id FROM game_bodies
          WHERE game_id = ? AND owner_faction_id = ? AND shipyard_level > 0
            AND destroyed_at_tick IS NULL LIMIT 1`,
      ).bind(gameId, factionId).first();
    if (yard) {
      const cls = doctrine.build[(tick / doctrine.buildEvery) % doctrine.build.length | 0];
      const r = await act(env, R.build(), {
        gameId, userId, params: { bodyId: yard.id }, body: { ship_class: cls },
      });
      bump(r.ok ? 'build_ok' : `build_rej_${r.data?.error?.code ?? r.status}`);
    } else {
      bump('build_no_yard');
    }
  }

  // --- expansion: send a colony ship somewhere unclaimed, then settle -----
  if (doctrine.colonise) {
    // A colony ship already parked on an unowned body is the moment to
    // plant. Checked first so we never leave one sitting idle.
    const parked = await DB
      .prepare(
        `SELECT s.id, s.parent_body_id
           FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
          WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony'
            AND s.hp > 0 AND b.owner_faction_id IS NULL
            -- Same landability rule as the transfer target. A colony ship
            -- that ends up over a gas giant would otherwise retry the
            -- settle every single tick for the rest of the game.
            AND b.type NOT IN ('star', 'gas-giant', 'ice-giant')
            AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                             WHERE n.ship_id = s.id AND n.status = 'in_transit')
          LIMIT 1`,
      ).bind(gameId, factionId).first();

    if (parked) {
      const r = await act(env, R.settlement(), {
        gameId, userId, params: { bodyId: parked.parent_body_id }, body: { type: 'city' },
      });
      bump(r.ok ? 'settle_ok' : `settle_rej_${r.data?.error?.code ?? r.status}`);
    } else {
      // Otherwise push an idle colony ship at the nearest unclaimed rock.
      // "Nearest" by orbit radius rather than true transfer cost — the
      // server plans the real trajectory, and a bot picking imperfect
      // targets is a bot, not a bug.
      const idle = await DB
        .prepare(
          `SELECT s.id, b.orbit_radius
             FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
            WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony'
              AND s.hp > 0
              AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                               WHERE n.ship_id = s.id AND n.status = 'in_transit')
            LIMIT 1`,
        ).bind(gameId, factionId).first();
      if (idle) {
        const target = await DB
          .prepare(
            // Cities cannot go on a star or a gas/ice giant (actions.js
            // handleDeploySettlement). Filtering here rather than
            // discovering it via 200 rejections keeps the bot's refusal
            // tally meaningful: what is left should be genuine economic
            // pressure, not the bot repeatedly trying to colonise Jupiter.
            `SELECT id, orbit_radius FROM game_bodies
              WHERE game_id = ? AND owner_faction_id IS NULL AND destroyed_at_tick IS NULL
                AND parent_body_id IS NOT NULL
                AND type NOT IN ('star', 'gas-giant', 'ice-giant')
              ORDER BY ABS(COALESCE(orbit_radius,0) - ?) LIMIT 1`,
          ).bind(gameId, idle.orbit_radius ?? 0).first();
        if (target) {
          const r = await act(env, R.transfer(), {
            gameId, userId, params: { shipId: idle.id },
            body: {
              target_body_id: target.id,
              scheduled_t: tick,
              arrival_t: tick + transitTicks(idle.orbit_radius, target.orbit_radius),
              replace: true,
            },
          });
          bump(r.ok ? 'transfer_ok' : `transfer_rej_${r.data?.error?.code ?? r.status}`);
        }
      }
    }
  }
}
