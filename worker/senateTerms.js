// ============================================================
// Senate chairmanship — who holds the gavel, and for how long.
//
// One faction at a time controls the senate agenda. Only the chairman may
// put a bill on the floor, one bill runs at a time, and a bill must fit
// inside the term that spawned it (see senate.js). Everything here is
// about choosing and advancing the holder; the proposal rules live with
// the proposal handler.
//
// DESIGN NOTES that are easy to get wrong later:
//
//   * Term length is in TICKS. Live games run 30s–1h per tick, so any
//     wall-clock term would mean wildly different games. Same call
//     MIN_WINDOW_TICKS already made.
//
//   * Rotation is a SHUFFLED BAG. Everyone active serves once per cycle
//     before anyone repeats; order within a cycle is random. Pure random
//     starves people — with 7 players there is a 34% chance somebody sits
//     out a full rotation — and starving a player of the agenda in a game
//     where the agenda is the only route to a Chancellor win is not a fun
//     kind of unlucky.
//
//   * Eligibility is DERIVED from the term history, never stored. An
//     eliminated faction stops appearing in the active set and therefore
//     stops being drawn; a late joiner appears immediately and joins the
//     current cycle. No mutable bag to fall out of sync with reality.
//
//   * There is NO forfeit rule (Lorne's call). A silent chairman burns
//     the full term.
// ============================================================

/** Default term length in ticks. 48 against the now 18-tick minimum bill
 *  is still two bills per term, with room to spare. Overridable per game
 *  via gameConfig.
 *
 *  A TERM LENGTH SHOULD BE A WHOLE NUMBER OF DAYS. At the 1h cadence every
 *  live game runs, 24 and 48 keep a term's start pinned to the same hour
 *  of the day forever. Anything that is not a multiple of 24 walks: a
 *  36-tick term would start 9am, then 9pm, then 9am, so every other
 *  chancellorship — and every bill inside it — would land overnight. That
 *  is the very problem the 12-tick vote floor exists to prevent, so do not
 *  reintroduce it here by picking a "reasonable sounding" number.
 *
 *  Raised 24 -> 48 to buy room for the longer vote window. senate.js's
 *  EFFECT_TICKS was raised in lockstep at the time, but has since gone
 *  back to 24 (48-hour laws were too long to live with), so a term now
 *  fits two law periods rather than one. The term itself stays 48: it is
 *  floored at MIN_TERM_TICKS = 36 so that two minimum bills fit, and
 *  that reasoning is untouched by how long a passed law then stands. */
export const DEFAULT_TERM_TICKS = 48;

/** Bounds for the configurable term. The floor is two minimum bills —
 *  below that "as many bills as you can fit" stops meaning anything — and
 *  a minimum bill is now MIN_DEBATE_TICKS + MIN_VOTE_TICKS = 18, so the
 *  floor follows it up to 36. Left at 12 it would have been possible to
 *  configure a term too short to ever pass a single bill. */
export const MIN_TERM_TICKS = 36;
export const MAX_TERM_TICKS = 240;

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return `term_${btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Unbiased index in [0, n). Rejection-sampled so the modulo bias doesn't
 *  quietly favour early entries in the bag. */
function randomIndex(n) {
  if (n <= 1) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (let i = 0; i < 64; i++) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
  return buf[0] % n;   // astronomically unlikely; bias beats hanging
}

export async function termTicksFor(env, gameId) {
  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    const v = Math.floor(Number(conf.senate_term_ticks));
    if (Number.isFinite(v)) {
      return Math.max(MIN_TERM_TICKS, Math.min(MAX_TERM_TICKS, v));
    }
  } catch {
    // Config is optional; the senate must not stall because it is absent.
  }
  return DEFAULT_TERM_TICKS;
}

async function activeFactionIds(env, gameId) {
  const rows = (await env.DB
    .prepare(`SELECT id FROM game_factions WHERE game_id = ? AND status = 'active' ORDER BY slot ASC`)
    .bind(gameId)
    .all()).results ?? [];
  return rows.map(r => r.id);
}

/**
 * Pick the next chairman.
 *
 * Returns { factionId, bagCycle } or null when there is nobody to seat.
 *
 * The bag: within a cycle, every active faction serves once. When the
 * eligible set empties, the cycle advances and everyone is back in.
 * Because eligibility is recomputed from `senate_terms` each time, a
 * faction eliminated mid-cycle just stops being drawn, and one that joins
 * mid-cycle is eligible right away — which is the fair reading, since
 * they have not had a turn.
 */
export async function drawNextChairman(env, gameId, priorCycle) {
  const active = await activeFactionIds(env, gameId);
  if (active.length === 0) return null;

  let cycle = Number.isFinite(priorCycle) ? priorCycle : 0;
  const servedIn = async (c) => {
    const rows = (await env.DB
      .prepare('SELECT DISTINCT faction_id FROM senate_terms WHERE game_id = ? AND bag_cycle = ?')
      .bind(gameId, c)
      .all()).results ?? [];
    return new Set(rows.map(r => r.faction_id));
  };

  let served = await servedIn(cycle);
  let pool = active.filter(id => !served.has(id));
  if (pool.length === 0) {
    // Bag empty — refill. Everyone still active goes back in.
    cycle += 1;
    served = await servedIn(cycle);
    pool = active.filter(id => !served.has(id));
    // A fresh cycle can only be non-empty; if it somehow is (a rerun at
    // the same tick), fall back to the full active set rather than
    // returning null and leaving the senate headless.
    if (pool.length === 0) pool = active;
  }

  return { factionId: pool[randomIndex(pool.length)], bagCycle: cycle };
}

/** The term covering `tick`, or null. */
export async function currentTerm(env, gameId, tick) {
  return await env.DB
    .prepare(
      `SELECT * FROM senate_terms
        WHERE game_id = ? AND start_tick <= ? AND end_tick > ?
        ORDER BY term_index DESC LIMIT 1`,
    )
    .bind(gameId, tick, tick)
    .first();
}

async function latestTerm(env, gameId) {
  return await env.DB
    .prepare('SELECT * FROM senate_terms WHERE game_id = ? ORDER BY term_index DESC LIMIT 1')
    .bind(gameId)
    .first();
}

async function openTerm(env, gameId, tick, termTicks, priorTerm) {
  const draw = await drawNextChairman(
    env, gameId, priorTerm ? Number(priorTerm.bag_cycle) : 0,
  );
  if (!draw) return null;
  const id = newId();
  const termIndex = priorTerm ? Number(priorTerm.term_index) + 1 : 0;
  await env.DB
    .prepare(
      `INSERT INTO senate_terms
        (id, game_id, faction_id, term_index, bag_cycle, start_tick, end_tick, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, gameId, draw.factionId, termIndex, draw.bagCycle, tick, tick + termTicks, Date.now())
    .run();
  return await env.DB.prepare('SELECT * FROM senate_terms WHERE id = ?').bind(id).first();
}

/**
 * Make sure the game has a sitting chairman at `tick`, and return the
 * term. Called once per tick from resolveSenate.
 *
 * Handles three cases:
 *   1. No term at all (first tick after this ships, or a fresh game).
 *   2. The current term has run out — open the next one.
 *   3. The chairman was ELIMINATED mid-term. This is not the forfeit rule
 *      Lorne declined: forfeit judges behaviour (proposed nothing), this
 *      is a state (cannot ever propose again). Leaving a dead player
 *      holding the gavel would freeze the senate for the rest of the term
 *      with no possible recovery.
 *
 * Catch-up: a game whose ticks advanced while this code was not deployed
 * would otherwise need one term per missed window. The loop is bounded so
 * a long gap can't spin — it back-fills at most MAX_CATCHUP_TERMS and
 * then snaps the newest term to cover the current tick.
 */
const MAX_CATCHUP_TERMS = 8;

export async function ensureTerm(env, gameId, tick) {
  const termTicks = await termTicksFor(env, gameId);
  let term = await currentTerm(env, gameId, tick);

  // Case 3: sitting chairman is gone. Close the term here and fall
  // through to open a successor at this tick.
  if (term) {
    const stillActive = await env.DB
      .prepare(`SELECT 1 AS x FROM game_factions WHERE id = ? AND status = 'active'`)
      .bind(term.faction_id)
      .first();
    if (!stillActive) {
      await env.DB
        .prepare(`UPDATE senate_terms SET end_tick = ?, ended_reason = 'eliminated' WHERE id = ?`)
        .bind(tick, term.id)
        .run();
      term = null;
    }
  }
  if (term) return term;

  let prior = await latestTerm(env, gameId);
  for (let i = 0; i < MAX_CATCHUP_TERMS; i++) {
    // Start where the previous term left off so term boundaries stay on a
    // clean grid, but never in the future and never before the game's
    // current tick minus one term (which would be pure back-fill).
    const start = prior ? Math.max(Number(prior.end_tick), tick - termTicks + 1) : tick;
    const opened = await openTerm(env, gameId, Math.min(start, tick), termTicks, prior);
    if (!opened) return null;                       // no active factions
    if (Number(opened.end_tick) > tick) return opened;
    prior = opened;
  }
  // Gap too large to walk. Seat someone covering NOW rather than looping.
  return await openTerm(env, gameId, tick, termTicks, prior);
}

/** Shape a term for the client. */
export function shapeTerm(term, tick) {
  if (!term) return null;
  return {
    id: term.id,
    faction_id: term.faction_id,
    term_index: Number(term.term_index),
    bag_cycle: Number(term.bag_cycle),
    start_tick: Number(term.start_tick),
    end_tick: Number(term.end_tick),
    ticks_remaining: Math.max(0, Number(term.end_tick) - tick),
  };
}

/**
 * Who has NOT yet held the gavel this cycle, in slot order.
 *
 * Shown in the client so a player can see roughly how far off their turn
 * is. Deliberately not an ordered queue — the draw is random within the
 * cycle, so promising an order would be a lie.
 */
export async function remainingInCycle(env, gameId, bagCycle) {
  const active = await activeFactionIds(env, gameId);
  const served = new Set((((await env.DB
    .prepare('SELECT DISTINCT faction_id FROM senate_terms WHERE game_id = ? AND bag_cycle = ?')
    .bind(gameId, bagCycle)
    .all()).results) ?? []).map(r => r.faction_id));
  return active.filter(id => !served.has(id));
}
