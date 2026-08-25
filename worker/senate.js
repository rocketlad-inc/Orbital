// Senate agent module.
//
// Owns the political/legislative layer: the slider catalog, proposal
// lifecycle (debating -> voting -> passed/failed/withdrawn), vote casting
// with weight snapshotting, and the deferred-effect lookup helper that
// other systems use to read effective slider values.
//
// VOTE WEIGHT = 1 + one per SYSTEM controlled (systems.js). It is
// RECOMPUTED at cast time and snapshotted into senate_votes.weight, so a
// vote keeps the weight it was cast with even if the map moves under it
// — losing a system shouldn't retroactively rewrite a ballot.
//
// It used to be a raw body count, which made the senate a prize for
// grabbing moons rather than for holding ground: Jupiter and its four
// Galileans were five votes for what is strategically one place.
//
// The stored game_factions.senate_weight column is written each tick for
// the scoreboard, but never read here — the ballot always recomputes.
//
// Passed proposals do NOT mutate `games` columns directly. They insert into
// `senate_effects`; downstream systems (tick processor, build cost, fuel,
// combat, trade) call `getActiveSliders` to read the effective values.

import {
  factionTechLevels, gatingEnabled, hasFeature, lockedError,
} from './researchUnlocks.js';
import { voteWeights, weightBreakdown, WEIGHT_RULE } from './systems.js';
import {
  ensureTerm, currentTerm, termTicksFor, shapeTerm, remainingInCycle,
} from './senateTerms.js';

export { WEIGHT_RULE };

// `perFaction` decides whether a law may name a target.
//
// A slider law is either GENERAL (applies to every faction) or TARGETED
// (applies to exactly one, overriding the general value for them alone).
// Not every knob can be meaningfully aimed. A match-wide knob (one that
// describes the match itself rather than a faction's situation) sets
// perFaction:false, and the server rejects a target on it rather than
// writing a row that quietly does nothing. Every slider currently in the
// catalog IS aimable; the flag exists so the next match-wide one cannot
// be aimed by accident.
// Tick Interval Multiplier was removed 2026-08-06 (Lorne: "that's not a
// real thing to vote on"). It was also never consumed by anything — no
// code read tick_interval_multiplier, so a passed bill changed nothing.
// Zero proposals in prod history had ever selected it. Legacy rows, if
// any ever appear, fall out on their own: the resolver only applies
// slider ids present in SLIDER_BY_ID.
// ============================================================
// PLAIN LANGUAGE. Every surface a player reads about a law — the
// composer, the bill card they vote from, the laws-in-force list, both
// Discord cards, the Herald — gets its words from HERE and only here.
//
// It used to get them from the schema. The bill card literally printed
// the database column: "Sets ship_build_cost_multiplier to 0.5 for every
// faction". Even the tidied surfaces said "Ship Build Cost Multiplier
// −50%", which describes a setting rather than a consequence. Nobody
// wants a multiplier at 0.5; they want ships to be cheaper. (Lorne:
// "we are saying set buildcost to .5, not reduce ship construction costs
// by 50%... no one's going to know what austerity means".)
//
// Reading level is the specification, not a nicety: plain nouns, no
// policy jargon, no game-dev vocabulary, and never the word "multiplier".
//
// `lower`/`higher` are LAW NAMES — the same knob is two different laws
// depending on which way you push it, and naming them separately is what
// makes the senate read as legislation instead of a settings screen.
// `say` is the consequence in one sentence.
//
// Server-owned on purpose. Six consumers means six chances to drift, and
// this codebase's recurring defect is exactly that (the emblem tables,
// the three upkeep tables). The client renders these strings; it never
// composes its own.
// "100% more" and "200% more" are arithmetically correct and nobody
// talks that way. Past a doubling, say it in multiples — "twice as
// much" is instantly legible where "100% more" makes a reader stop and
// convert. Returns null below 2x, where percentages read fine.
const TIMES_WORD = [null, null, 'twice', 'three times', 'four times', 'five times'];
function timesWord(v) {
  return Number.isInteger(v) ? (TIMES_WORD[v] ?? `${v} times`) : null;
}

const PLAIN_LAW = {
  ship_build_cost_multiplier: {
    lower: 'Cheaper Ships', higher: 'Pricier Ships',
    say: (v, pct, x) => (
      v === 0 ? 'Ships are free to build.'
        : v < 1 ? `Ships cost ${pct}% less to build.`
          : x ? `Ships cost ${x} as much to build.`
            : `Ships cost ${pct}% more to build.`),
  },
  megastructure_cost_multiplier: {
    lower: 'Cheaper Megaprojects', higher: 'Pricier Megaprojects',
    say: (v, pct, x) => (
      v === 0 ? 'Megastructures cost nothing to raise.'
        : v < 1 ? `Megastructure frameworks cost ${pct}% less to complete.`
          : x ? `Megastructure frameworks cost ${x} as much to complete.`
            : `Megastructure frameworks cost ${pct}% more to complete.`),
  },
  metal_yield_multiplier: {
    lower: 'Less Metal', higher: 'More Metal',
    say: (v, pct, x) => (
      v === 0 ? 'Settlements mine no metal at all.'
        : v < 1 ? `Every settlement mines ${pct}% less metal.`
          : x ? `Every settlement mines ${x} as much metal.`
            : `Every settlement mines ${pct}% more metal.`),
  },
  gold_yield_multiplier: {
    lower: 'Fewer Credits', higher: 'More Credits',
    say: (v, pct, x) => (
      v === 0 ? 'Settlements earn no credits at all.'
        : v < 1 ? `Every settlement earns ${pct}% fewer credits.`
          : x ? `Every settlement earns ${x} as many credits.`
            : `Every settlement earns ${pct}% more credits.`),
  },
  science_yield_multiplier: {
    lower: 'Slower Research', higher: 'Faster Research',
    say: (v, pct, x) => (
      v === 0 ? 'Research stops completely.'
        : v < 1 ? `Research runs ${pct}% slower.`
          : x ? `Research runs ${x} as fast.`
            : `Research runs ${pct}% faster.`),
  },
  combat_damage_multiplier: {
    lower: 'Weaker Guns', higher: 'Stronger Guns',
    say: (v, pct, x) => (
      v === 0 ? 'Ships deal no damage at all.'
        : v < 1 ? `Ships deal ${pct}% less damage.`
          : x ? `Ships deal ${x} as much damage.`
            : `Ships deal ${pct}% more damage.`),
  },
  trade_tariff_pct: {
    // The odd one out: already a percentage, and only meaningful upward,
    // so both names describe the same direction rather than a pair.
    lower: 'No Trade Tax', higher: 'Trade Tax',
    say: (v) => (
      v <= 0 ? 'Trade deliveries arrive whole — no tax.'
        : `Trade deliveries arrive ${v}% smaller.`),
  },
  fleet_upkeep_multiplier: {
    lower: 'Cheaper Fleets', higher: 'Pricier Fleets',
    say: (v, pct, x) => (
      v === 0 ? 'Fleets cost nothing to keep.'
        : v < 1 ? `Keeping your ships costs ${pct}% less each tick.`
          : x ? `Keeping your ships costs ${x} as much each tick.`
            : `Keeping your ships costs ${pct}% more each tick.`),
  },
  rush_cost_multiplier: {
    lower: 'Cheaper Rush Jobs', higher: 'Pricier Rush Jobs',
    say: (v, pct, x) => (
      v < 1 ? `Rushing a build costs ${pct}% less.`
        : x ? `Rushing a build costs ${x} as much.`
          : `Rushing a build costs ${pct}% more.`),
  },
};

const SLIDER_CATALOG = [
  {
    id: 'ship_build_cost_multiplier',
    label: 'Cost of building ships',
    description: 'How much metal and credits a shipyard charges for a hull.',
    default: 1.0,
    min: 0.5,
    max: 1.5,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'megastructure_cost_multiplier',
    label: 'Cost of megastructure projects',
    // PRICED AT PLACEMENT, not at delivery. A site snapshots its bill
    // onto itself the moment the framework goes down, which makes this
    // a FORWARD lever: the chamber cannot make a half-built Mega
    // Destroyer dearer, only the next one. That is deliberate — it
    // matches how every other pinned cost in the game behaves — and it
    // gives the floor a real race, because anyone who can get a
    // framework down before the vote closes locks in the old price.
    description: 'What a megastructure framework costs to complete. '
      + 'Priced when the framework is placed, so it never changes a project already under way.',
    default: 1.0,
    // Wider than ships either way. A megaproject is a strategic
    // decision rather than a line item, so the chamber should be able to
    // make one genuinely attractive or genuinely out of reach — which,
    // aimed at a single faction, is how a runaway leader gets priced out
    // of their second death star.
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  // Fuel Yield Multiplier used to sit here. Fuel was retired from the
  // economy (see actions.js: "Fuel was removed from the game economy"),
  // so the senate could pass a law about a resource nobody spends while
  // having no lever at all over the two everybody fights for. Replaced
  // with the three that are actually in the game.
  {
    id: 'metal_yield_multiplier',
    label: 'Metal from settlements',
    description: 'How much metal your settlements dig up each tick.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'gold_yield_multiplier',
    label: 'Credits from settlements',
    description: 'How many credits your settlements earn each tick. '
      + 'Ships are paid for in credits, so this decides how big a navy anyone can afford.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'science_yield_multiplier',
    label: 'Research speed',
    description: 'How fast everyone climbs the tech tree. '
      + 'Speeding it up makes the whole game shorter — tech is how it ends.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'combat_damage_multiplier',
    label: 'Weapon damage',
    description: 'How hard ships hit when they shoot. '
      + 'Point it at one player and their guns get weaker while everyone else fires as normal.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'trade_tariff_pct',
    label: 'Tax on trade deliveries',
    description: 'A cut taken out of every trade delivery when it arrives. '
      + 'The rate is locked in when the deal is struck, so a later law cannot re-tax cargo '
      + 'already on its way.',
    default: 0,
    min: 0,
    max: 50,
    step: 1,
    perFaction: true,
  },
  {
    id: 'fleet_upkeep_multiplier',
    label: 'Cost of keeping ships',
    description: 'The bill every player pays each tick just for owning a fleet. '
      + 'Push it to zero and fleets are free to keep; double it and big navies start to hurt.',
    default: 1.0,
    min: 0,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'rush_cost_multiplier',
    label: 'Cost of rushing builds',
    description: 'What it costs to pay a shipyard to finish early. '
      + 'Make it expensive enough and everyone has to wait their turn.',
    default: 1.0,
    min: 0.5,
    max: 3.0,
    step: 0.05,
    perFaction: true,
  },
];

const SLIDER_BY_ID = Object.fromEntries(SLIDER_CATALOG.map((s) => [s.id, s]));
/** Exported so the Discord vote card can describe a slider law in
 *  the same words the in-game senate uses. */
export { SLIDER_BY_ID, SLIDER_CATALOG };

/**
 * One law, in plain words: what to CALL it and what it DOES.
 *
 * The single source for every player-facing description of a slider law.
 * Returns null for an unknown slider rather than inventing wording — the
 * caller falls back to the label, which beats printing a column name.
 *
 *   describeSlider('ship_build_cost_multiplier', 0.5)
 *     -> { name: 'Cheaper Ships', effect: 'Ships cost 50% less to build.', … }
 */
export function describeSlider(sliderId, value) {
  const def = SLIDER_BY_ID[sliderId];
  const plain = PLAIN_LAW[sliderId];
  if (!def || !plain) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  const base = Number(def.default);
  // Percent AWAY FROM the default, which is what a reader cares about —
  // not the raw multiplier, and not percent of anything absolute.
  const pct = Math.round(Math.abs(v - base) * 100);
  const atDefault = Math.abs(v - base) < 1e-9;

  return {
    slider_id: sliderId,
    // Topic — what the bill is about, for pickers and headers.
    topic: def.label,
    // The law's NAME. At the default there is no law to name, and the
    // composer uses this to tell a proposer their bill does nothing.
    name: atDefault ? 'No Change' : (v < base ? plain.lower : plain.higher),
    // The consequence, one sentence, always ending in a period so it can
    // be dropped into running prose anywhere.
    effect: atDefault
      ? 'Nothing changes — this is already the rule.'
      : plain.say(v, pct, v > base ? timesWord(v) : null),
    at_default: atDefault,
    value: v,
    // Kept for the few places that still want the bare arithmetic
    // (the analytics tab, the sim). Not for player-facing copy.
    delta_pct: def.id === 'trade_tariff_pct' ? v : Math.round((v - base) * 100),
  };
}

/**
 * Every reachable value of a slider, pre-worded.
 *
 * Sent with the catalog so the composer can caption a drag in real time
 * without shipping a second copy of the phrasing rules to the browser.
 * The alternative — a client-side formatter mirroring PLAIN_LAW — is the
 * exact pattern that has drifted twice in this codebase already, and the
 * whole point of this pass is that there is ONE place the words live.
 *
 * Small: eight sliders, at most ~50 steps each, all short strings, and
 * only fetched while the senate tab is actually open.
 */
export function phraseTableFor(def) {
  const out = {};
  const step = def.step > 0 ? def.step : 1;
  // Integer loop so 0.05 steps don't accumulate float error into keys
  // the client can never match on.
  const steps = Math.round((def.max - def.min) / step);
  for (let i = 0; i <= steps; i++) {
    const raw = def.min + i * step;
    // Round to the step's own precision; 0.7000000000000001 as an object
    // key would simply never be looked up.
    const v = Math.round(raw * 1000) / 1000;
    const d = describeSlider(def.id, v);
    if (d) out[String(v)] = { name: d.name, effect: d.effect, at_default: d.at_default };
  }
  return out;
}

// Defaults when a proposal doesn't specify per-proposal durations. The
// new schema's debate_ticks/vote_ticks columns are nullable so legacy
// rows fall through to these constants on read.
const DEBATE_TICKS = 2;
const VOTE_TICKS = 1;
/** How long a passed slider law stands, in ticks.
 *
 *  Was 7, which at an hour per tick meant a law could be proposed,
 *  passed, and lapse between two logins — it did its work invisibly and
 *  read as "the law did nothing". 7 also covered under a third of the
 *  24-tick default term, so most of every term ran with no economic
 *  policy in force at all.
 *
 *  NO LONGER TRACKS senateTerms.DEFAULT_TERM_TICKS, deliberately. It was
 *  raised 24 -> 48 as a side effect of lengthening the vote window so a
 *  law could not lapse mid-term, and 48 hours turned out to be too long
 *  to live with: a law you disliked was the rule for two full days, and
 *  the chamber had nothing to do in between. Back to 24 per Lorne.
 *
 *  The vacuum that lockstep protected against is real but smaller than it
 *  reads: a minimum bill is MIN_DEBATE_TICKS + MIN_VOTE_TICKS = 18 ticks,
 *  so an active chamber can seat a replacement law inside a 48-tick term
 *  and keep policy standing continuously. What changes is that it now has
 *  to bother — a term no longer legislates itself once and coast.
 *
 *  Repeal (repeal_law) exists precisely because a standing law is a
 *  commitment, and at 24 the commitment is a day rather than two.
 *
 *  Laws already in flight keep the active_until_tick they were written
 *  with — this changes what NEW bills grant. The one 48-tick law that was
 *  standing when this landed was shortened by migration 0102, which is a
 *  one-off data fix and NOT a general rule: nothing here retroactively
 *  rewrites a law's term. */
const EFFECT_TICKS = 24;

// Per-proposal duration ranges, in TICKS.
//
// Debate and voting have SEPARATE floors, because they are solving
// different problems. Debate only needs to be long enough that the
// chamber can actually argue; the VOTE window has to be long enough that
// it cannot fit inside somebody's night.
//
// THE VOTE FLOOR IS 12, AND THE ARITHMETIC MATTERS. A window equal to a
// night can align exactly with that night: an 8-tick vote opening at
// 23:00 runs to 07:00 and contains zero waking hours. To GUARANTEE waking
// overlap the window must be strictly longer than the sleep block, so at
// the 1h cadence every live game runs, 12 leaves a four-hour margin at
// the worst possible start time. That margin is the whole feature — a
// bill that can END THE GAME (the chancellor vote is a win condition with
// no quorum) must never resolve while the table is asleep.
//
// This is deliberately the timezone-free fix. A longer window helps every
// player in every timezone at once, with no anchor hour to choose and
// nothing keyed off where anyone happens to live.
//
// Both floors stay plain tick counts so they scale with whatever cadence
// a game runs at rather than being pinned to wall clock. The legacy
// defaults (2 debate / 1 vote) sit below them and are raised to them, so
// a client that sends no durations gets the minimum, not a rubber stamp.
const MIN_DEBATE_TICKS = 6;
const MIN_VOTE_TICKS   = 12;
const DEBATE_MAX_TICKS = 48;
const VOTE_MAX_TICKS   = 24;

// ============================================================
// Bill kinds
// ------------------------------------------------------------
// 'slider_law' is the original — adjusts a global multiplier for
// EFFECT_TICKS ticks. The four new TARGETED kinds carry a
// `target_faction_id` in their payload and write a senate_effects
// row with effect_kind set to the bill kind + target set on it,
// so runtime checks (combat, harvest, trade) can ask "does this
// faction have an active <kind> aimed at it?" in one indexed lookup.
//
// Reparations is the odd one out: no ongoing effect, just a
// one-shot credits transfer at resolution time. It still writes
// a chronicle entry so the event log records it.
//
// 'chancellor_vote' is the win-condition bill: passing it ends the
// match with victory_type='chancellor', winner = candidate. Each
// faction can call this exactly ONCE per game (a failed/withdrawn
// proposal does not refund the attempt — see ONE_PER_GAME_STATUSES).
// ============================================================
// 'repeal_law' aims at a LAW rather than a faction: it ends a standing
// bill's effect early. It is the counterweight to a 24-tick law — without
// it a passed bill is simply the rule for a full term no matter how badly
// it lands, and the only recourse was to wait it out or pass an opposing
// law on the same slider (which stacks confusingly rather than undoing).
const BILL_KINDS = new Set([
  'slider_law', 'trade_embargo', 'war_authorization',
  'production_sanction', 'reparations', 'chancellor_vote',
  'repeal_law',
]);
const TARGETED_BILL_KINDS = new Set([
  'trade_embargo', 'war_authorization',
  'production_sanction', 'reparations', 'chancellor_vote',
]);
const ONGOING_EFFECT_KINDS = new Set([
  'trade_embargo', 'war_authorization', 'production_sanction',
]);
const ONE_PER_GAME_KINDS = new Set(['chancellor_vote']);
/** Statuses that count against the "once per game" limit. A withdrawn
 *  proposal returns the slot; a failed or voted-down one does not. */
const ONE_PER_GAME_STATUSES = new Set(['debating', 'voting', 'passed', 'failed']);

// Ongoing-effect durations. Sanctions hit harder than slider laws and
// last longer so the political consequence is felt.
const EMBARGO_EFFECT_TICKS         = 14;
const WAR_AUTH_EFFECT_TICKS        = 21;
const PROD_SANCTION_EFFECT_TICKS   = 14;
const PROD_SANCTION_MULTIPLIER     = 0.5;   // half yield while active

/** Reparations: target pays this many credits to every other active
 *  faction. Capped by what the target actually has — they don't go
 *  negative; the transfer is shrunk proportionally if they can't pay. */
const REPARATIONS_PER_FACTION = 200;

/**
 * Debate/vote windows for a bill that must finish inside its term.
 *
 * Pure so it can be tested directly (sim/senateTerms.mjs) — the
 * arithmetic here decides whether a bill can outlive the term that
 * spawned it, and "off by one tick" is invisible until a chairman
 * silently steals part of their successor's term.
 *
 * Returns { ok: false, roomLeft, needed } when the term is too short,
 * else { ok: true, debateTicks, voteTicks, voteOpens, voteCloses }.
 * INVARIANT when ok: voteCloses <= termEndTick.
 */
export function billWindow(termEndTick, proposedAt, wantDebate, wantVote) {
  const roomLeft = termEndTick - proposedAt;
  const needed = MIN_DEBATE_TICKS + MIN_VOTE_TICKS;
  if (roomLeft < needed) return { ok: false, roomLeft, needed };

  // The debate clamp reserves the VOTE's floor, not its own — debate may
  // eat everything except the room the vote is guaranteed. Reserving the
  // wrong floor here is how a long debate would silently squeeze the vote
  // back under the night-proof minimum the whole change exists to hold.
  const debateTicks = clampInt(
    wantDebate, MIN_DEBATE_TICKS, Math.min(DEBATE_MAX_TICKS, roomLeft - MIN_VOTE_TICKS),
    Math.max(DEBATE_TICKS, MIN_DEBATE_TICKS),
  );
  const voteTicks = clampInt(
    wantVote, MIN_VOTE_TICKS, Math.min(VOTE_MAX_TICKS, roomLeft - debateTicks),
    Math.max(VOTE_TICKS, MIN_VOTE_TICKS),
  );
  const voteOpens = proposedAt + debateTicks;
  return { ok: true, debateTicks, voteTicks, voteOpens, voteCloses: voteOpens + voteTicks };
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function effectiveDebateTicks(row) {
  return (row && row.debate_ticks != null && Number.isFinite(Number(row.debate_ticks)))
    ? Number(row.debate_ticks) : DEBATE_TICKS;
}
function effectiveVoteTicks(row) {
  return (row && row.vote_ticks != null && Number.isFinite(Number(row.vote_ticks)))
    ? Number(row.vote_ticks) : VOTE_TICKS;
}

// ---------- response helpers ----------

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}
function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return `${prefix}_${btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

// ---------- auth/context helpers ----------

async function loadGameAndFaction(env, gameId, session) {
  const game = await env.DB
    .prepare('SELECT g.id, g.current_tick, g.status, g.tick_interval_ms, r.host_id FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?')
    .bind(gameId)
    .first();
  if (!game) return { error: err(404, 'not_found', 'game not found') };
  const faction = await env.DB
    .prepare('SELECT id, name, color, status FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, session.user_id)
    .first();
  if (!faction) return { error: err(403, 'no_faction', 'you have no faction in this game') };
  return { game, faction };
}

/**
 * Every undestroyed body in the game, with just enough shape to group
 * into systems. Destroyed bodies are filtered (migration 0024) so an
 * asteroid wiped by a ram impact stops counting for its former owner.
 *
 * This reads ALL bodies, not the caller's visible ones: the senate
 * counts the real map. Fog of war hides what a PLAYER sees, never what
 * the chamber is.
 */
async function bodiesForWeight(env, gameId) {
  return (await env.DB
    .prepare(
      // orbit_radius/rp/ra feed the belt clustering (systems.js): a run of
      // neighbouring rubble is one system, and a rogue on a long ellipse
      // is its own. Without these columns every rock counts separately.
      `SELECT id, template_id, name, type, parent_body_id,
              orbit_period, orbit_radius, orbit_rp, orbit_ra,
              owner_faction_id
         FROM game_bodies
        WHERE game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all()).results ?? [];
}

/**
 * Senate vote weight: 1 + one per system controlled. See systems.js for
 * the grouping and the plurality rule, and WEIGHT_RULE for the sentence
 * every surface quotes.
 *
 * Replaced a raw body count, which made the senate a prize for grabbing
 * moons: Jupiter plus four Galileans was five votes for one place.
 */
async function voteWeightFor(env, gameId, factionId) {
  // The base 1 is a SEAT, and a dead empire doesn't hold one. Under the
  // old body count an eliminated faction fell to 0 on its own; a floor
  // would quietly hand it a vote back, so gate it explicitly.
  const alive = await env.DB
    .prepare(`SELECT 1 AS x FROM game_factions WHERE id = ? AND status = 'active'`)
    .bind(factionId).first();
  if (!alive) return 0;
  const bodies = await bodiesForWeight(env, gameId);
  return voteWeights(bodies, [factionId]).get(factionId) ?? 1;
}

/** Weight plus the systems that produced it — for "why is my vote a 4?" */
export async function voteWeightDetail(env, gameId, factionId) {
  return weightBreakdown(await bodiesForWeight(env, gameId), factionId);
}

// ---------- effective slider lookup ----------

/**
 * Returns { [sliderId]: effectiveValue } for `gameId` at `currentTick`.
 * For each slider, picks the most-recently-created active effect row
 * (active_from_tick <= currentTick < active_until_tick), falling back
 * to the catalog default if none exists.
 */
export async function getActiveSliders(env, gameId, currentTick, factionId = null) {
  const resolve = await getSliderResolver(env, gameId, currentTick);
  return resolve(factionId);
}

/**
 * One query, then O(1) per faction — for the tick loop, which needs
 * effective values for many factions in the same step and must not fire
 * a query per settlement.
 *
 * Returns `resolve(factionId)`: pass a faction to get the values that
 * apply TO THAT FACTION; pass null/undefined for the general law only.
 *
 * Resolution order, weakest to strongest:
 *   1. catalog default
 *   2. GENERAL laws (target_faction_id IS NULL), oldest to newest
 *   3. TARGETED laws aimed at this faction, oldest to newest
 *
 * A targeted law OVERRIDES the general one rather than multiplying with
 * it. Stacking would make the senate's output hard to predict from the
 * floor — with an override, "Lorne pays 1.5×" means Lorne pays 1.5×, no
 * matter what else is on the books.
 *
 * Passing no faction deliberately yields general-only. Every call site
 * that cannot name a faction therefore behaves exactly as it did before
 * targeting existed, instead of silently picking up someone else's law.
 */
export async function getSliderResolver(env, gameId, currentTick) {
  const base = {};
  for (const s of SLIDER_CATALOG) base[s.id] = s.default;

  let rows = [];
  try {
    // Filter by effect_kind='slider' so the targeted-sanction rows
    // (trade_embargo, war_authorization, production_sanction — which keep
    // slider_id '') don't short-circuit through the SLIDER_BY_ID gate.
    const res = await env.DB
      .prepare(
        `SELECT slider_id, value, target_faction_id, created_at_ms
           FROM senate_effects
          WHERE game_id = ?
            AND effect_kind = 'slider'
            AND active_from_tick <= ?
            AND active_until_tick > ?`,
      )
      .bind(gameId, currentTick, currentTick)
      .all();
    rows = res.results ?? [];
  } catch (e) {
    // Same defensive posture as hasActiveSanction: a senate read must
    // never take down the economy pass that calls it.
    console.error('getSliderResolver query failed (using defaults)', e);
    return () => ({ ...base });
  }

  // created_at_ms ascending so later rows overwrite earlier ones.
  const sorted = rows.slice().sort((a, b) => a.created_at_ms - b.created_at_ms);
  const general = {};
  const targeted = new Map();          // factionId -> { sliderId: value }
  for (const r of sorted) {
    if (!SLIDER_BY_ID[r.slider_id]) continue;
    if (r.target_faction_id) {
      const m = targeted.get(r.target_faction_id) ?? {};
      m[r.slider_id] = r.value;
      targeted.set(r.target_faction_id, m);
    } else {
      general[r.slider_id] = r.value;
    }
  }

  const generalView = { ...base, ...general };
  const cache = new Map();
  return (factionId) => {
    if (!factionId) return generalView;
    const hit = cache.get(factionId);
    if (hit) return hit;
    const mine = targeted.get(factionId);
    const view = mine ? { ...generalView, ...mine } : generalView;
    cache.set(factionId, view);
    return view;
  };
}

/**
 * The laws actually BITING a faction right now, in plain words.
 *
 * getSliderResolver answers "what number applies"; this answers "what is
 * in force, what does it do, and when does it lapse" — which is what a
 * player-facing readout needs. Same precedence as the resolver (general
 * laws oldest-to-newest, then targeted laws for this faction overriding
 * them) so the chip in the top bar can never disagree with the economy it
 * is describing. Rows sitting at the catalog default are dropped: those
 * are not laws, they are the absence of one.
 *
 * Returns [{ slider_id, topic, name, effect, value, until_tick }],
 * soonest-to-lapse first. Never throws — a senate read must not break a
 * state fetch.
 */
export async function activeLawsFor(env, gameId, currentTick, factionId = null) {
  let rows = [];
  try {
    const res = await env.DB
      .prepare(
        `SELECT slider_id, value, target_faction_id, created_at_ms, active_until_tick,
                proposal_id
           FROM senate_effects
          WHERE game_id = ?
            AND effect_kind = 'slider'
            AND active_from_tick <= ?
            AND active_until_tick > ?`,
      )
      .bind(gameId, currentTick, currentTick)
      .all();
    rows = res.results ?? [];
  } catch (e) {
    console.error('activeLawsFor query failed', e);
    return [];
  }

  // Oldest first so a later row overwrites an earlier one, exactly as
  // getSliderResolver does. Keep the WINNING row whole so its expiry
  // travels with the value the player is being shown.
  const sorted = rows.slice().sort((a, b) => a.created_at_ms - b.created_at_ms);
  const winner = new Map();            // sliderId -> row
  for (const r of sorted) {
    if (!SLIDER_BY_ID[r.slider_id]) continue;
    if (r.target_faction_id && r.target_faction_id !== factionId) continue;
    const prev = winner.get(r.slider_id);
    // A targeted law beats a general one regardless of age; between two of
    // the same scope, newer wins (the sort already handles that).
    if (prev && prev.target_faction_id && !r.target_faction_id) continue;
    winner.set(r.slider_id, r);
  }

  const out = [];
  for (const r of winner.values()) {
    const d = describeSlider(r.slider_id, r.value);
    if (!d || d.at_default) continue;
    out.push({
      slider_id: d.slider_id,
      topic: d.topic,
      name: d.name,
      effect: d.effect,
      value: d.value,
      until_tick: r.active_until_tick,
      // The bill that granted this law — what a repeal bill aims at.
      proposal_id: r.proposal_id ?? null,
    });
  }
  out.sort((a, b) => a.until_tick - b.until_tick);
  return out;
}

async function listActiveEffectRows(env, gameId, currentTick) {
  const rows = await env.DB
    .prepare(
      `SELECT id, slider_id, value, effect_kind, target_faction_id,
              active_from_tick, active_until_tick
         FROM senate_effects
        WHERE game_id = ?
          AND active_until_tick > ?
        ORDER BY active_until_tick ASC`,
    )
    .bind(gameId, currentTick)
    .all();
  return rows.results ?? [];
}

/**
 * Is there an active <effectKind> sanction aimed at <factionId> right
 * now? Used by combat (war_authorization), trade-route delivery
 * (trade_embargo), and body harvest (production_sanction). Returns a
 * boolean; callers don't need the row contents.
 *
 * Cheap: single indexed query (idx_senate_effects_target). Safe to call
 * once per tick per relevant entity.
 */
/**
 * Every ongoing sanction currently in force, with the tick it lapses.
 *
 * Exists because a sanction was INVISIBLE to the player: /state carried
 * no sanction data at all, so a faction taking double damage under a War
 * Authorization had no way to see it was happening, let alone how much
 * longer it lasted. The only surface was the senate's resolved-bill list
 * (last 10), which showed an absolute "active until tick N" and then
 * scrolled away entirely.
 *
 * Returns rows, not booleans — the caller needs `ticks_left` to count
 * down. hasActiveSanction stays the hot-path predicate; this is the
 * once-per-/state read.
 */
export async function activeSanctions(env, gameId, currentTick) {
  try {
    const rows = (await env.DB
      .prepare(
        `SELECT effect_kind, target_faction_id, active_from_tick, active_until_tick
           FROM senate_effects
          WHERE game_id = ?
            AND effect_kind != 'slider'
            AND active_from_tick <= ?
            AND active_until_tick > ?
          ORDER BY active_until_tick ASC`,
      )
      .bind(gameId, currentTick, currentTick)
      .all()).results ?? [];
    return rows.map(r => ({
      kind: r.effect_kind,
      target_faction_id: r.target_faction_id,
      until_tick: r.active_until_tick,
      ticks_left: Math.max(0, Number(r.active_until_tick) - currentTick),
    }));
  } catch (e) {
    // Same defensive posture as hasActiveSanction: a senate read must
    // never take down the /state call that embeds it.
    console.error('activeSanctions query failed', e);
    return [];
  }
}

/**
 * Every SLIDER law in force right now, shaped for display.
 *
 * The companion to activeSanctions(), and it existed nowhere: a passed
 * slider law wrote its effect row, silently changed the economy, and the
 * only trace a player could find was one line in the event log that
 * scrolled away. The senate had no "here is the law of the land" view at
 * all, so the chamber showed bills being voted on and never what those
 * votes had actually produced.
 *
 * Carries the proposal title so a law reads as the thing people argued
 * over ("Let's get to work!") rather than as a schema identifier, and
 * `delta_pct` so the UI doesn't have to know that 0.5 means −50% while
 * a tariff of 0.5 means half a percentage point.
 *
 * Same defensive posture as activeSanctions: never throws.
 */
export async function activeLaws(env, gameId, currentTick) {
  try {
    const rows = (await env.DB
      .prepare(
        `SELECT e.slider_id, e.value, e.target_faction_id, e.proposal_id,
                e.active_from_tick, e.active_until_tick,
                p.title AS proposal_title,
                gf.name AS target_name, gf.color AS target_color, gf.emblem AS target_emblem
           FROM senate_effects e
           LEFT JOIN senate_proposals p ON p.id = e.proposal_id
           LEFT JOIN game_factions gf ON gf.id = e.target_faction_id
          WHERE e.game_id = ?
            AND e.effect_kind = 'slider'
            AND e.active_from_tick <= ?
            AND e.active_until_tick > ?
          ORDER BY e.active_until_tick ASC`,
      )
      .bind(gameId, currentTick, currentTick)
      .all()).results ?? [];

    return rows.map((r) => {
      const def = SLIDER_BY_ID[r.slider_id] ?? null;
      const value = Number(r.value);
      const said = describeSlider(r.slider_id, value);
      return {
        slider_id: r.slider_id,
        // The law's NAME and what it DOES, in that order — this is what
        // the laws-in-force list leads with. `label` is the topic, kept
        // for anything that wants the subject rather than the law.
        law_name: said?.name ?? def?.label ?? r.slider_id,
        effect_text: said?.effect ?? null,
        label: def?.label ?? r.slider_id,
        description: def?.description ?? null,
        value,
        default_value: def?.default ?? null,
        delta_pct: said?.delta_pct ?? 0,
        is_pct: r.slider_id === 'trade_tariff_pct',
        proposal_id: r.proposal_id,
        proposal_title: r.proposal_title ?? null,
        target_faction_id: r.target_faction_id,
        target_name: r.target_name ?? null,
        target_color: r.target_color ?? null,
        target_emblem: r.target_emblem ?? null,
        until_tick: r.active_until_tick,
        ticks_left: Math.max(0, Number(r.active_until_tick) - currentTick),
      };
    });
  } catch (e) {
    console.error('activeLaws query failed', e);
    return [];
  }
}

export async function hasActiveSanction(env, gameId, currentTick, factionId, effectKind) {
  if (!factionId || !effectKind) return false;
  // Defensive: sanctions are an optional overlay queried from the
  // hot tick loop (trade auto-pilot, combat). The effect_kind /
  // target_faction_id columns arrived in migration 0031; if a game's
  // DB hasn't applied it yet (new worker code racing the migration),
  // this query throws "no such column" and — because the caller wraps
  // the whole trade loop in one try/catch — stalls EVERY freighter for
  // EVERY player. A missing sanction table must never break core
  // trade or combat: on any DB error, treat the faction as un-sanctioned.
  try {
    const row = await env.DB
      .prepare(
        `SELECT 1 AS x FROM senate_effects
          WHERE game_id = ?
            AND effect_kind = ?
            AND target_faction_id = ?
            AND active_from_tick <= ?
            AND active_until_tick > ?
          LIMIT 1`,
      )
      .bind(gameId, effectKind, factionId, currentTick, currentTick)
      .first();
    return !!row;
  } catch (e) {
    console.error('hasActiveSanction query failed (treating as un-sanctioned)', e);
    return false;
  }
}

// ---------- proposal shaping ----------

export async function loadProposalTotals(env, proposalId) {
  const rows = await env.DB
    // ELIMINATED FACTIONS DO NOT VOTE. quorumFor already counts only
    // status='active' factions in the denominator, but the tally summed every
    // ballot ever cast on the proposal -- so a faction wiped out mid-bill kept
    // its yea on the books and could still carry or block a law it no longer
    // had any stake in. Join to the roster and count the living.
    .prepare(`SELECT v.vote, SUM(v.weight) AS w, COUNT(*) AS n
                FROM senate_votes v
                JOIN game_factions f ON f.id = v.faction_id
               WHERE v.proposal_id = ? AND f.status = 'active'
               GROUP BY v.vote`)
    .bind(proposalId)
    .all();
  const tot = { yea: { weight: 0, count: 0 }, nay: { weight: 0, count: 0 }, abstain: { weight: 0, count: 0 } };
  for (const r of rows.results ?? []) {
    if (tot[r.vote]) { tot[r.vote].weight = r.w ?? 0; tot[r.vote].count = r.n ?? 0; }
  }
  return tot;
}

// ============================================================
// QUORUM (Lorne): a MAJORITY of the players in the game must engage with
// a bill before it can pass. Abstain counts — "present and neutral" is
// engagement, and without it a player who wants a bill to proceed but
// has no opinion has no way to help it over the line.
//
// THE DENOMINATOR IS EVERY LIVING FACTION. Eliminated factions are out —
// they have no seat and no vote — but an idle player still holds theirs.
//
// An earlier build shrank the denominator to players with a recent
// session, on the reasoning that six of the eight live games have zero
// or one player seen in a week and would otherwise be unable to pass
// anything ever again. Lorne overruled it: a seat in the chamber belongs
// to the empire, not to whether its owner logged in this week, and a
// senate that quietly stops counting absent members is not one players
// can reason about. The consequence is real and accepted — an abandoned
// game's senate stops legislating, which is arguably the correct
// description of an abandoned game.
//
// MAJORITY, not half: floor(n/2) + 1. For odd counts these agree (7 -> 4
// either way); for even ones majority is the stricter reading and the
// one the rule is stated in (4 players -> 3, not 2).
// ============================================================

/**
 * The vote bar for this game: how many factions must engage.
 *
 * Returns { eligible, quorum } — `eligible` is every non-eliminated
 * faction, which is both the denominator and what the client shows.
 */
export async function quorumFor(env, gameId) {
  const rows = (await env.DB
    .prepare(`SELECT id FROM game_factions WHERE game_id = ? AND status = 'active'`)
    .bind(gameId)
    .all()).results ?? [];

  const eligible = rows.length;
  return {
    eligible,
    eligible_ids: rows.map(r => r.id),
    // eligible 0 gives a quorum of 1, which nothing can meet — the safe
    // direction for a game with no living factions.
    quorum: Math.floor(eligible / 2) + 1,
  };
}

/** Engagement headcount for a bill: every faction that cast ANYTHING. */
export function votesCastCount(totals) {
  return (totals?.yea?.count ?? 0) + (totals?.nay?.count ?? 0) + (totals?.abstain?.count ?? 0);
}

function shapeProposal(row, totals, callerVote, ballots, quorum = null) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
  return {
    id: row.id,
    game_id: row.game_id,
    proposer_faction_id: row.proposer_faction_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    payload,
    status: row.status,
    proposed_at_tick: row.proposed_at_tick,
    vote_opens_at_tick: row.vote_opens_at_tick,
    vote_closes_at_tick: row.vote_closes_at_tick,
    resolved_at_tick: row.resolved_at_tick,
    effect_until_tick: row.effect_until_tick,
    debate_ticks: effectiveDebateTicks(row),
    vote_ticks:   effectiveVoteTicks(row),
    totals,
    caller_vote: callerVote ?? null,
    // Who has voted, and how. The turnout readout and the blocking-
    // coalition builder both need per-faction ballots, not just the
    // aggregate — "who is still out" is the actionable half.
    ballots: ballots ?? [],
    // Quorum context travels WITH the bill so the client can render
    // "Quorum 3 of 4" live rather than discovering at resolution that a
    // bill everyone thought was winning died for lack of a room.
    quorum: quorum ? {
      required: quorum.quorum,
      cast: votesCastCount(totals),
      eligible: quorum.eligible,
      met: votesCastCount(totals) >= quorum.quorum,
    } : null,
  };
}

async function loadBallots(env, proposalId) {
  const rows = await env.DB
    .prepare('SELECT faction_id, vote, weight FROM senate_votes WHERE proposal_id = ?')
    .bind(proposalId)
    .all();
  return rows.results ?? [];
}

async function shapeOne(env, row, callerFactionId, quorum = null) {
  const totals = await loadProposalTotals(env, row.id);
  const ballots = await loadBallots(env, row.id);
  let callerVote = null;
  if (callerFactionId) {
    const v = await env.DB
      .prepare('SELECT vote FROM senate_votes WHERE proposal_id = ? AND faction_id = ?')
      .bind(row.id, callerFactionId)
      .first();
    callerVote = v?.vote ?? null;
  }
  return shapeProposal(row, totals, callerVote, ballots, quorum);
}

// ---------- handlers ----------

async function handleListSliders(_req, env, { params, session }) {
  const { gameId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;
  // Two views. `effective_value` is what applies to the CALLER — a law
  // aimed at them is the number they actually pay, so that is the one
  // their panel must lead with. `general_value` is the floor's law, kept
  // alongside so the UI can show "1.5x (general 1.0x)" and make it
  // obvious when you personally are being singled out.
  const resolve = await getSliderResolver(env, gameId, ctx.game.current_tick);
  const mine = resolve(ctx.faction?.id ?? null);
  const general = resolve(null);
  const effects = await listActiveEffectRows(env, gameId, ctx.game.current_tick);
  return json({
    current_tick: ctx.game.current_tick,
    // Duration bounds, sent rather than hardcoded client-side so a second
    // copy of the rule can't drift from this one. Debate and vote carry
    // SEPARATE floors now; min_window_ticks is kept as the smaller of the
    // two so an older client that only knows the one field still gets a
    // legal value it can send rather than one the server would reject.
    min_window_ticks: Math.min(MIN_DEBATE_TICKS, MIN_VOTE_TICKS),
    min_debate_ticks: MIN_DEBATE_TICKS,
    min_vote_ticks: MIN_VOTE_TICKS,
    debate_max_ticks: DEBATE_MAX_TICKS,
    vote_max_ticks: VOTE_MAX_TICKS,
    sliders: SLIDER_CATALOG.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      default: s.default,
      min: s.min,
      max: s.max,
      step: s.step,
      per_faction: s.perFaction !== false,
      // Every reachable value, already worded, so the composer can
      // caption a drag without the browser owning any phrasing rules.
      phrases: phraseTableFor(s),
      // What the rule in force right now actually means for the caller.
      current: describeSlider(s.id, mine[s.id]),
      effective_value: mine[s.id],
      general_value: general[s.id],
      targeted_at_me: mine[s.id] !== general[s.id],
    })),
    active_effects: effects,
  });
}

async function handleCreateProposal(req, env, { params, session }) {
  const { gameId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  // Bill kind. Defaults to 'slider_law' so a legacy client that doesn't
  // send `kind` keeps working — only the new fields (target_faction_id,
  // candidate_faction_id) are required for the new kinds.
  const kind = typeof body.kind === 'string' ? body.kind : 'slider_law';
  if (!BILL_KINDS.has(kind)) return err(400, 'bad_request', `unknown bill kind '${kind}'`);

  // ---- THE GAVEL ------------------------------------------------------
  // Only the sitting chairman sets the agenda. Everything below (floor
  // clear, bill fits the term) hangs off the term, so resolve it first.
  const term = await currentTerm(env, gameId, ctx.game.current_tick);
  if (!term) {
    return err(409, 'no_session', 'the senate is not in session');
  }
  if (term.faction_id !== ctx.faction.id) {
    const chair = await env.DB
      .prepare('SELECT name FROM game_factions WHERE id = ?')
      .bind(term.faction_id).first();
    return err(
      403, 'not_chairman',
      `only the chairman may put a bill on the floor — ${chair?.name ?? 'another faction'} holds the gavel until tick ${term.end_tick}`,
    );
  }

  // ONE BILL AT A TIME, game-wide. The old rule was one per FACTION,
  // which meant nothing once only one faction can propose; this is the
  // rule that actually shapes a term into a budget. It also guarantees
  // the floor is clear at handover, because a bill can never outlive the
  // term that spawned it (see the fit check below).
  const onFloor = await env.DB
    .prepare(`SELECT id, title FROM senate_proposals WHERE game_id = ? AND status IN ('debating','voting') LIMIT 1`)
    .bind(gameId)
    .first();
  if (onFloor) {
    return err(409, 'floor_busy', `the floor is occupied by "${onFloor.title}" — one bill at a time`);
  }

  // Research gate. VOTING is deliberately never gated — a new player is
  // part of the senate from tick one and can always weigh in on someone
  // else's bill.
  //
  // RE-POINTED (Sean/Lorne): slider laws are now free to any chairman.
  // Requiring Industry 5 to say ANYTHING left the early senate dead for
  // everyone, and with the gavel already rationing who may speak, a
  // research gate on top of it was rationing twice. Industry 5 stops
  // meaning "may I speak" and starts meaning "may I punish".
  if (await gatingEnabled(env, gameId)) {
    // repeal_law is ungated for the same reason slider_law is: it is the
    // UNDO for an ungated bill. Gating it would mean a chamber that can
    // pass an economic law but not take it back — asymmetric, and on a
    // 24-tick window that traps a game under a bad law for a full term.
    const needed = kind === 'chancellor_vote' ? 'senate.chancellor'
                 : kind === 'slider_law'      ? null
                 : kind === 'repeal_law'      ? null
                 : 'senate.propose';
    if (needed) {
      const levels = await factionTechLevels(env, gameId, ctx.faction.id);
      if (!hasFeature(needed, levels, true)) {
        const e = lockedError(needed);
        return err(403, e.code, e.message);
      }
    }
  }

  const { title, summary } = body;
  if (typeof title !== 'string' || title.trim().length < 1 || title.length > 80) {
    return err(400, 'bad_request', 'title must be 1-80 chars');
  }
  if (typeof summary !== 'string' || summary.trim().length < 1 || summary.length > 500) {
    return err(400, 'bad_request', 'summary must be 1-500 chars');
  }

  // Per-faction lifetime gate for one-shot kinds (e.g. chancellor_vote).
  // Withdrawn proposals don't count — the player can re-aim. Resolved
  // ones (passed/failed) do count: a failed chancellor bid burns your shot.
  if (ONE_PER_GAME_KINDS.has(kind)) {
    const past = await env.DB
      .prepare(
        `SELECT id FROM senate_proposals
          WHERE game_id = ?
            AND proposer_faction_id = ?
            AND kind = ?
            AND status IN ('debating','voting','passed','failed')
          LIMIT 1`,
      )
      .bind(gameId, ctx.faction.id, kind)
      .first();
    if (past) return err(409, 'already_used', `your faction has already attempted a ${kind} this game`);
  }

  // Per-kind validation + payload shape. Each kind owns its own narrow
  // contract so a malformed bill never reaches resolution time.
  const payload = await buildBillPayload(env, gameId, ctx.faction.id, kind, body);
  if (payload.error) return payload.error;

  // Per-proposal durations, floored at six real hours for THIS game's
  // tick cadence. The old defaults (2 debate / 1 vote) are below the
  // floor on every cadence, so they are raised to it rather than used
  // verbatim — a client that sends nothing gets the minimum, not a
  // rubber stamp.
  const proposedAt = ctx.game.current_tick;

  // THE BILL MUST FIT INSIDE THE TERM.
  //
  // Without this, a chairman proposing near the end of their term leaves
  // a bill occupying the floor well into the NEXT chairman's term — and
  // since only one bill runs at a time, the successor inherits a
  // shortened term through no fault of their own. Requiring the bill to
  // resolve before the term ends removes that entirely: no bill ever
  // crosses a handover, so the floor is always clean when the gavel
  // moves.
  //
  // It also turns window length into a real decision. A 24-tick term
  // fits exactly two minimum-length bills; spend a longer debate on the
  // first and you have spent the second.
  const win = billWindow(
    Number(term.end_tick), proposedAt, body.debate_ticks, body.vote_ticks,
  );
  if (!win.ok) {
    return err(
      409, 'term_too_short',
      `only ${win.roomLeft} ticks left in your term — a bill needs at least ${win.needed}`,
    );
  }
  const { debateTicks, voteTicks, voteOpens, voteCloses } = win;

  const id = newId('prop');

  await env.DB
    .prepare(
      `INSERT INTO senate_proposals
        (id, game_id, proposer_faction_id, kind, title, summary, payload, status,
         proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick,
         debate_ticks, vote_ticks)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'debating', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, gameId, ctx.faction.id, kind, title.trim(), summary.trim(),
      JSON.stringify(payload.data),
      proposedAt, voteOpens, voteCloses, debateTicks, voteTicks,
    )
    .run();

  // The proposer votes for their own bill, automatically.
  //
  // You obviously support the thing you just filed, and under quorum
  // that first vote is worth more than a formality: five of the eleven
  // bills ever proposed drew ZERO votes, two of them from proposers who
  // never voted on their own motion. This guarantees every bill starts
  // one vote toward the room it needs.
  //
  // Not final — the vote is a normal senate_votes row, so the proposer
  // can switch to abstain (or nay, if they change their mind mid-debate)
  // through the usual endpoint while the window is open.
  try {
    const weight = await voteWeightFor(env, gameId, ctx.faction.id);
    await env.DB
      .prepare(`INSERT INTO senate_votes (proposal_id, faction_id, vote, weight, cast_at_tick)
                VALUES (?, ?, 'yea', ?, ?)`)
      .bind(id, ctx.faction.id, weight, proposedAt)
      .run();
  } catch (e) {
    // A failed auto-vote must not cost the player their bill — they can
    // always cast it by hand.
    console.error('proposer auto-vote failed', e, { proposalId: id });
  }

  const row = await env.DB.prepare('SELECT * FROM senate_proposals WHERE id = ?').bind(id).first();
  const shaped = await shapeOne(env, row, ctx.faction.id, await quorumFor(env, gameId));

  // Announce the bill to Discord straight away so the debate window has
  // somewhere to happen. Fully isolated: a Discord outage, a missing
  // token, or a slow API must never fail the player's proposal — they
  // already have their bill, the announcement is a bonus.
  try {
    const discord = await import('./discord.js');
    await discord.publishSenateProposed(env, gameId, row, ctx.faction.name ?? null);
  } catch (e) {
    console.error('publishSenateProposed failed', e, { proposalId: id });
  }

  // Broadcast so other clients show the new proposal immediately
  // (badge + toast) instead of waiting up to 5s for the next poll.
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
    await stub.fetch('https://room/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'senate',
        event: 'proposed',
        proposal_id: id,
        proposer_faction_id: ctx.faction.id,
        proposer_faction_name: ctx.faction.name,
        title: title.trim(),
        bill_kind: kind,
        ...payload.broadcast,           // per-kind extras (slider_id, target name, candidate name…)
        debate_ticks: debateTicks,
        vote_ticks: voteTicks,
        vote_opens_at_tick: voteOpens,
        vote_closes_at_tick: voteCloses,
      }),
    });
  } catch { /* best-effort */ }

  return json({ proposal: shaped }, { status: 201 });
}

/**
 * Per-kind payload builder. Returns either `{ data, broadcast }` on
 * success or `{ error }` (a Response) on validation failure. Keeps the
 * validation per-kind so the main handler stays a thin dispatcher.
 *
 * For TARGETED kinds we look up the target faction to: (a) reject
 * targeting yourself, (b) reject targeting a non-existent faction, and
 * (c) embed the target's display name in the broadcast payload so
 * clients can show "Embargo against Mars Confederacy" in the toast
 * without an extra round-trip.
 */
async function buildBillPayload(env, gameId, proposerFactionId, kind, body) {
  // REPEAL: aims at a standing law, not a faction. Validated here so a
  // bill that could never resolve sensibly is refused at the door rather
  // than sitting on the floor for a term and then no-opping.
  if (kind === 'repeal_law') {
    const targetId = typeof body.target_proposal_id === 'string' ? body.target_proposal_id : '';
    if (!targetId) return { error: err(400, 'bad_request', 'target_proposal_id required') };

    const game = await env.DB
      .prepare('SELECT current_tick FROM games WHERE id = ?')
      .bind(gameId).first();
    const nowTick = Number(game?.current_tick ?? 0);

    const target = await env.DB
      .prepare(
        `SELECT id, title, kind, payload, status, effect_until_tick, repealed_at_tick
           FROM senate_proposals
          WHERE id = ? AND game_id = ?`,
      )
      .bind(targetId, gameId).first();
    if (!target) return { error: err(404, 'not_found', 'no such law') };
    if (target.status !== 'passed') {
      return { error: err(409, 'not_a_law', 'only a bill that actually passed can be repealed') };
    }
    if (target.repealed_at_tick != null) {
      return { error: err(409, 'already_repealed', 'that law has already been repealed') };
    }
    // Must still be standing. A lapsed law needs no repeal, and a
    // one-shot (reparations, chancellor) has nothing ongoing to undo.
    if (target.effect_until_tick == null || Number(target.effect_until_tick) <= nowTick) {
      return { error: err(409, 'not_in_force', 'that law is not in force — nothing to repeal') };
    }
    // One live repeal per law. Two bills racing to kill the same law
    // means the second one resolves against something already dead.
    const rival = await env.DB
      .prepare(
        `SELECT id FROM senate_proposals
          WHERE game_id = ? AND kind = 'repeal_law'
            AND status IN ('debating','voting')
            AND json_extract(payload, '$.target_proposal_id') = ?
          LIMIT 1`,
      )
      .bind(gameId, targetId).first();
    if (rival) {
      return { error: err(409, 'repeal_pending', 'a repeal of that law is already on the floor') };
    }

    // Carry the target's wording so the vote card, the chronicle and the
    // Discord post can all say what is being struck down without
    // re-reading the target row.
    let targetEffect = null;
    try {
      const tp = JSON.parse(target.payload || '{}');
      if (target.kind === 'slider_law' && tp.slider_id) {
        targetEffect = describeSlider(tp.slider_id, tp.target_value)?.effect ?? null;
      }
    } catch { /* optional */ }

    const data = {
      target_proposal_id: target.id,
      target_title: target.title,
      target_kind: target.kind,
      target_effect: targetEffect,
    };
    return { data, broadcast: data };
  }

  if (kind === 'slider_law') {
    const slider = SLIDER_BY_ID[body.slider_id];
    if (!slider) return { error: err(400, 'bad_request', 'unknown slider_id') };
    const v = Number(body.target_value);
    if (!Number.isFinite(v)) return { error: err(400, 'bad_request', 'target_value must be a number') };
    if (v < slider.min || v > slider.max) return { error: err(400, 'bad_request', `target_value out of range [${slider.min}, ${slider.max}]`) };

    // Optional target. Absent/empty => a GENERAL law binding everyone,
    // which is the whole prior behaviour of this bill kind.
    const aimedAt = typeof body.target_faction_id === 'string' && body.target_faction_id
      ? body.target_faction_id
      : null;
    if (!aimedAt) {
      return {
        data: { slider_id: body.slider_id, target_value: v, target_faction_id: null },
        broadcast: { slider_id: body.slider_id, target_value: v, target_faction_id: null },
      };
    }
    if (slider.perFaction === false) {
      return { error: err(400, 'not_targetable', `${slider.label} applies to the whole match and cannot target one faction`) };
    }
    // Self-targeting is ALLOWED here, unlike the sanction kinds. A
    // sanction aimed at yourself is theatre; a slider law aimed at
    // yourself is a bid for privilege ("grant us 1.5x metal") or a
    // concession offered in a negotiation. Either way the floor still
    // has to vote for it, so it is a political move, not an exploit.
    const target = await env.DB
      .prepare('SELECT id, name FROM game_factions WHERE id = ? AND game_id = ? AND status = ?')
      .bind(aimedAt, gameId, 'active')
      .first();
    if (!target) return { error: err(404, 'not_found', 'target faction not found / not active') };
    return {
      data: { slider_id: body.slider_id, target_value: v, target_faction_id: aimedAt },
      broadcast: {
        slider_id: body.slider_id, target_value: v,
        target_faction_id: aimedAt, target_faction_name: target.name,
      },
    };
  }

  // The four targeted-sanction kinds + chancellor_vote all carry a
  // single faction id pointer in the payload. Look it up once.
  const targetField = kind === 'chancellor_vote' ? 'candidate_faction_id' : 'target_faction_id';
  const targetId = body[targetField];
  if (typeof targetId !== 'string' || !targetId) {
    return { error: err(400, 'bad_request', `${targetField} required for ${kind}`) };
  }
  // Self-targeting rule:
  //   - chancellor_vote: ALLOWED (you can nominate yourself; commonly do)
  //   - all sanction kinds: REJECTED (no self-flagellation theatre)
  if (kind !== 'chancellor_vote' && targetId === proposerFactionId) {
    return { error: err(400, 'self_target', 'cannot target your own faction') };
  }
  const target = await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE id = ? AND game_id = ? AND status = ?')
    .bind(targetId, gameId, 'active')
    .first();
  if (!target) return { error: err(404, 'not_found', `target faction not found / not active`) };

  return {
    data: { [targetField]: targetId },
    broadcast: { [targetField]: targetId, target_faction_name: target.name },
  };
}

async function handleListProposals(req, env, { url, params, session }) {
  const { gameId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;

  const status = url.searchParams.get('status');
  let rows;
  if (status) {
    rows = await env.DB
      .prepare(`SELECT * FROM senate_proposals WHERE game_id = ? AND status = ? ORDER BY proposed_at_tick DESC, id DESC LIMIT 100`)
      .bind(gameId, status)
      .all();
    rows = rows.results ?? [];
  } else {
    const active = await env.DB
      .prepare(`SELECT * FROM senate_proposals WHERE game_id = ? AND status IN ('debating','voting') ORDER BY vote_closes_at_tick ASC`)
      .bind(gameId)
      .all();
    const resolved = await env.DB
      .prepare(`SELECT * FROM senate_proposals WHERE game_id = ? AND status IN ('passed','failed','withdrawn') ORDER BY COALESCE(resolved_at_tick, proposed_at_tick) DESC, id DESC LIMIT 10`)
      .bind(gameId)
      .all();
    rows = [...(active.results ?? []), ...(resolved.results ?? [])];
  }

  // One quorum + term read for the whole list. Both are properties of the
  // game at this tick, so shaping each bill against its own lookup would
  // be N round-trips for one answer.
  const termTicks = await termTicksFor(env, gameId);
  const quorum = await quorumFor(env, gameId);
  const term = await currentTerm(env, gameId, ctx.game.current_tick);

  const out = [];
  for (const r of rows) out.push(await shapeOne(env, r, ctx.faction.id, quorum));

  // Session context: who holds the gavel, how long they have, and
  // whether THIS caller may put something up right now. The client needs
  // a reason string, not just a boolean — "you can't propose" with no
  // explanation reads as a bug.
  const floorBusy = rows.some(r => r.status === 'debating' || r.status === 'voting');
  const roomLeft = term ? Number(term.end_tick) - ctx.game.current_tick : 0;
  const isChair = !!term && term.faction_id === ctx.faction.id;
  let cannotProposeReason = null;
  if (!term) cannotProposeReason = 'The senate is not in session.';
  else if (!isChair) cannotProposeReason = 'You do not hold the gavel.';
  else if (floorBusy) cannotProposeReason = 'A bill is already on the floor.';
  else if (roomLeft < MIN_DEBATE_TICKS + MIN_VOTE_TICKS) {
    cannotProposeReason = `Only ${roomLeft} ticks left in your term — a bill needs ${MIN_DEBATE_TICKS + MIN_VOTE_TICKS}.`;
  }

  return json({
    current_tick: ctx.game.current_tick,
    // Rides along so deadlines can speak wall-clock: "closes in 6 ticks"
    // is arithmetic homework at 1 tick = 1 hour and simply wrong across
    // games with different tick rates.
    tick_interval_ms: ctx.game.tick_interval_ms ?? null,
    proposals: out,
    // The law of the land. Rides this call rather than getting its own
    // fetch: the panel that shows bills is the panel that must show what
    // past bills DID, and one round trip should answer both.
    laws: await activeLaws(env, gameId, ctx.game.current_tick),
    session: {
      term: shapeTerm(term, ctx.game.current_tick),
      term_ticks: termTicks,
      is_chairman: isChair,
      // Deliberately `!cannotProposeReason` rather than a second copy of
      // the same conditions: this flag and the reason string above are one
      // decision, and when they were written twice a constant could be
      // renamed under one of them and not the other.
      can_propose: !cannotProposeReason,
      cannot_propose_reason: cannotProposeReason,
      floor_busy: floorBusy,
      // Who is still waiting for a turn this cycle. Unordered on purpose:
      // the draw is random within a cycle, so showing a queue would
      // promise an order that doesn't exist.
      awaiting_turn: term ? await remainingInCycle(env, gameId, Number(term.bag_cycle)) : [],
      quorum: {
        required: quorum.quorum,
        eligible: quorum.eligible,
        eligible_ids: quorum.eligible_ids,
      },
    },
  });
}

async function handleGetProposal(_req, env, { params, session }) {
  const { gameId, proposalId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;

  const row = await env.DB
    .prepare('SELECT * FROM senate_proposals WHERE id = ? AND game_id = ?')
    .bind(proposalId, gameId)
    .first();
  if (!row) return err(404, 'not_found', 'proposal not found');

  const shaped = await shapeOne(
    env, row, ctx.faction.id,
    await quorumFor(env, gameId),
  );
  const votes = await env.DB
    .prepare(
      `SELECT sv.faction_id, sv.vote, sv.weight, sv.cast_at_tick, gf.name AS faction_name, gf.color AS faction_color
         FROM senate_votes sv
         JOIN game_factions gf ON gf.id = sv.faction_id
        WHERE sv.proposal_id = ?
        ORDER BY sv.cast_at_tick ASC`,
    )
    .bind(proposalId)
    .all();
  return json({ current_tick: ctx.game.current_tick, proposal: shaped, votes: votes.results ?? [] });
}

/**
 * Cast (or change) a faction's vote on a proposal. Transport-agnostic —
 * the HTTP handler and the Discord interactions handler both call this
 * with an already-resolved factionId, so the window rules + planet-count
 * weight + one-row-per-faction upsert live in exactly one place.
 *
 * Returns { ok: true, weight, row } on success, or
 * { ok: false, status, code, message } describing the rejection, so the
 * caller can shape it into an HTTP error or a Discord reply as needed.
 */
export async function castVoteCore(env, { gameId, proposalId, factionId, currentTick, vote }) {
  if (!['yea', 'nay', 'abstain'].includes(vote)) {
    return { ok: false, status: 400, code: 'bad_request', message: 'vote must be yea, nay, or abstain' };
  }
  const row = await env.DB
    .prepare('SELECT * FROM senate_proposals WHERE id = ? AND game_id = ?')
    .bind(proposalId, gameId)
    .first();
  if (!row) return { ok: false, status: 404, code: 'not_found', message: 'proposal not found' };

  // Voting window is [vote_opens_at_tick, vote_closes_at_tick). Status is
  // flipped debating->voting at a tick boundary by the resolver, but a
  // vote may arrive in the gap between the window opening and the resolver
  // running — so accept 'debating' too, as long as the window is open.
  const inWindow = currentTick >= row.vote_opens_at_tick && currentTick < row.vote_closes_at_tick;
  if (!inWindow || (row.status !== 'voting' && row.status !== 'debating')) {
    return { ok: false, status: 409, code: 'not_voting', message: 'this proposal is not in its voting window' };
  }

  const weight = await voteWeightFor(env, gameId, factionId);

  const existing = await env.DB
    .prepare('SELECT 1 AS x FROM senate_votes WHERE proposal_id = ? AND faction_id = ?')
    .bind(proposalId, factionId)
    .first();
  if (existing) {
    await env.DB
      .prepare('UPDATE senate_votes SET vote = ?, weight = ?, cast_at_tick = ? WHERE proposal_id = ? AND faction_id = ?')
      .bind(vote, weight, currentTick, proposalId, factionId)
      .run();
  } else {
    await env.DB
      .prepare('INSERT INTO senate_votes (proposal_id, faction_id, vote, weight, cast_at_tick) VALUES (?, ?, ?, ?, ?)')
      .bind(proposalId, factionId, vote, weight, currentTick)
      .run();
  }
  return { ok: true, weight, row };
}

async function handleVote(req, env, { params, session }) {
  const { gameId, proposalId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;

  const body = await readJson(req);
  const res = await castVoteCore(env, {
    gameId,
    proposalId,
    factionId: ctx.faction.id,
    currentTick: ctx.game.current_tick,
    vote: body?.vote,
  });
  if (!res.ok) return err(res.status, res.code, res.message);

  // Mirror the vote onto the Discord card BEFORE returning. Without this,
  // a bill voted on in-game showed a stale tally in the channel — people
  // read it and believed it. (This block sat after the return for one
  // release and therefore did nothing.)
  try {
    const discord = await import('./discord.js');
    await discord.refreshSenateCard(env, proposalId);
  } catch (e) {
    console.error('refreshSenateCard (in-game vote) failed', e);
  }

  const shaped = await shapeOne(env, res.row, ctx.faction.id);
  return json({ proposal: shaped, your_weight: res.weight });
}

async function handleWithdraw(_req, env, { params, session }) {
  const { gameId, proposalId } = params;
  const ctx = await loadGameAndFaction(env, gameId, session);
  if (ctx.error) return ctx.error;

  const row = await env.DB
    .prepare('SELECT * FROM senate_proposals WHERE id = ? AND game_id = ?')
    .bind(proposalId, gameId)
    .first();
  if (!row) return err(404, 'not_found', 'proposal not found');
  if (row.proposer_faction_id !== ctx.faction.id) return err(403, 'not_proposer', 'only the proposer can withdraw');
  if (row.status !== 'debating') return err(409, 'not_withdrawable', 'can only withdraw while debating');

  await env.DB
    .prepare(`UPDATE senate_proposals SET status = 'withdrawn', resolved_at_tick = ? WHERE id = ?`)
    .bind(ctx.game.current_tick, proposalId)
    .run();
  const updated = await env.DB.prepare('SELECT * FROM senate_proposals WHERE id = ?').bind(proposalId).first();
  return json({ proposal: await shapeOne(env, updated, ctx.faction.id) });
}

// ---------- dev tick endpoint ----------
//
// WILL BE REPLACED BY tick processor in the game-loop agent's work.
// For now, the host can poke this endpoint to advance the game by one tick
// and trigger senate phase transitions (debating->voting, voting->resolved).

/** How long each bill kind's effect lasts after passing, in ticks.
 *  slider_law uses EFFECT_TICKS (24 — half a term); sanctions have their
 *  own windows; one-shot kinds don't read this. */
const EFFECT_TICKS_BY_KIND = {
  slider_law:           EFFECT_TICKS,
  trade_embargo:        EMBARGO_EFFECT_TICKS,
  war_authorization:    WAR_AUTH_EFFECT_TICKS,
  production_sanction:  PROD_SANCTION_EFFECT_TICKS,
  reparations:          0,   // one-shot
  chancellor_vote:      0,   // one-shot, ends the match
  repeal_law:           0,   // one-shot: it ends someone ELSE's window
};

/**
 * Apply the per-kind effects of a PASSED bill. Returns an object of
 * extra fields to merge into the chronicle entry for transparency
 * (target name, amount transferred, etc.) — or `null` if the bill kind
 * has no side effects beyond the chronicle row itself.
 *
 * Idempotency: only ever called from resolveSenate at the tick a bill
 * transitions to status='passed', so it runs exactly once per bill.
 *
 * Effect-row strategy:
 *   slider_law → 1 row, no target, slider_id + value set
 *   trade_embargo / war_authorization / production_sanction →
 *     1 row each, target_faction_id set, slider_id NULL, value NULL
 *   reparations → no effect row; mutates target.gold and recipients
 *     atomically inside this call
 *   chancellor_vote → no effect row; mutates games.status / winner /
 *     victory_type to end the match
 */
async function applyBillEffects(env, gameId, tick, proposal, payload, effectUntil) {
  const kind = proposal.kind;
  const now = Date.now();

  if (kind === 'slider_law') {
    if (!payload.slider_id || !SLIDER_BY_ID[payload.slider_id]) return null;
    const effectId = newId("eff");
    // target_faction_id NULL = general law. A non-null target makes this
    // row apply to that faction alone; getSliderResolver layers it over
    // the general value for them and leaves everyone else untouched.
    const aimedAt = payload.target_faction_id || null;
    await env.DB
      .prepare(
        "INSERT INTO senate_effects " +
        "(id, game_id, slider_id, value, effect_kind, target_faction_id, proposal_id, active_from_tick, active_until_tick, created_at_tick, created_at_ms) " +
        "VALUES (?, ?, ?, ?, 'slider', ?, ?, ?, ?, ?, ?)"
      )
      .bind(effectId, gameId, payload.slider_id, Number(payload.target_value), aimedAt, proposal.id, tick, effectUntil, tick, now)
      .run();
    return aimedAt ? { target_faction_id: aimedAt } : null;
  }

  // REPEAL: end the target law's window right now.
  //
  // This is the one bill kind that MUTATES another bill, so it is written
  // in strict order: kill the effect rows first (that is what the economy
  // reads), then close the target's own window, then stamp
  // repealed_at_tick, and only then stamp expiry_logged_at_tick to stop
  // the generic "Lapsed" card also firing for a law the chamber
  // deliberately struck down. If any step throws, the next tick's expiry
  // sweep still retires the law correctly — it just narrates it as a
  // lapse rather than a repeal, which is the safe way to fail.
  if (kind === 'repeal_law') {
    const targetId = payload.target_proposal_id;
    if (!targetId) return null;

    const target = await env.DB
      .prepare(
        `SELECT id, title, kind, effect_until_tick, resolved_at_tick
           FROM senate_proposals
          WHERE id = ? AND game_id = ? AND status = 'passed'`,
      )
      .bind(targetId, gameId).first();
    // Already gone (lapsed while this bill was debated, or repealed by a
    // race). Nothing to undo; the chronicle below still records the vote.
    if (!target || target.effect_until_tick == null
        || Number(target.effect_until_tick) <= tick) {
      return { target_title: payload.target_title ?? null, already_gone: true };
    }

    const ticksLeft = Math.max(0, Number(target.effect_until_tick) - tick);

    // active_until_tick is EXCLUSIVE in every read (`active_until_tick >
    // currentTick`), so setting it to `tick` makes the law inert from this
    // tick forward without rewriting history.
    await env.DB
      .prepare('UPDATE senate_effects SET active_until_tick = ? WHERE game_id = ? AND proposal_id = ? AND active_until_tick > ?')
      .bind(tick, gameId, targetId, tick).run();
    await env.DB
      .prepare('UPDATE senate_proposals SET effect_until_tick = ?, repealed_at_tick = ?, expiry_logged_at_tick = ? WHERE id = ?')
      .bind(tick, tick, tick, targetId).run();

    try {
      const discord = await import('./discord.js');
      const mover = await env.DB
        .prepare('SELECT name FROM game_factions WHERE id = ?')
        .bind(proposal.proposer_faction_id).first();
      await discord.publishLawRepealed(env, gameId, {
        title: target.title,
        effect: payload.target_effect ?? null,
        movedBy: mover?.name ?? null,
        ticksLeft,
      });
    } catch (e) {
      console.error('publishLawRepealed failed', e, { targetId });
    }

    return {
      target_proposal_id: targetId,
      target_title: target.title,
      target_kind: target.kind,
      ticks_cut_short: ticksLeft,
    };
  }

  if (ONGOING_EFFECT_KINDS.has(kind)) {
    const target = payload.target_faction_id;
    if (!target) return null;
    const effectId = newId("eff");
    // slider_id + value are declared NOT NULL (migration 0004), but a
    // sanction bill is not a slider law and has no slider/value. Write
    // sentinels ('' / 0) instead of NULL — the previous NULLs threw a
    // NOT NULL constraint violation, which the per-proposal catch
    // swallowed AFTER the bill was already marked 'passed', so every
    // embargo / war authorization / production sanction silently wrote
    // no effect row and hasActiveSanction() always returned false.
    // getActiveSliders() filters on effect_kind='slider', so the ''
    // slider_id here never pollutes slider reads.
    await env.DB
      .prepare(
        "INSERT INTO senate_effects " +
        "(id, game_id, slider_id, value, effect_kind, target_faction_id, proposal_id, active_from_tick, active_until_tick, created_at_tick, created_at_ms) " +
        "VALUES (?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(effectId, gameId, kind, target, proposal.id, tick, effectUntil, tick, now)
      .run();

    // war_authorization side effect: break any active peace pacts
    // (NAP, defense_pact, intel_share) that the target is signed onto.
    // Without this, formally declaring war while still in a NAP would
    // be incoherent — the Senate has overruled the treaty.
    if (kind === 'war_authorization') {
      await env.DB
        .prepare(
          `UPDATE treaties SET status = 'broken', broken_at_tick = ?
            WHERE game_id = ?
              AND status = 'active'
              AND broken_at_tick IS NULL
              AND id IN (
                SELECT t.id FROM treaties t
                JOIN treaty_signatories ts ON ts.treaty_id = t.id
               WHERE t.game_id = ? AND ts.faction_id = ?
              )`,
        )
        .bind(tick, gameId, gameId, target)
        .run();
    }
    return { target_faction_id: target };
  }

  if (kind === 'reparations') {
    const target = payload.target_faction_id;
    if (!target) return null;
    // Recipients: every other active faction (not the target, not eliminated).
    const recipients = (await env.DB
      .prepare(`SELECT id FROM game_factions WHERE game_id = ? AND status = 'active' AND id != ?`)
      .bind(gameId, target)
      .all()).results ?? [];
    if (recipients.length === 0) return { transferred: 0, recipients: 0 };

    // Target pays REPARATIONS_PER_FACTION per recipient, capped by their
    // current gold (no negative balances). If they can't pay full freight
    // we pro-rate so every recipient gets the same partial slice.
    const targetRow = await env.DB
      .prepare(`SELECT gold FROM game_factions WHERE id = ? AND game_id = ?`)
      .bind(target, gameId).first();
    const targetGold = Number(targetRow?.gold ?? 0);
    const desired = REPARATIONS_PER_FACTION * recipients.length;
    const totalTransfer = Math.min(targetGold, desired);
    const perRecipient = Math.floor(totalTransfer / recipients.length);
    if (perRecipient <= 0) return { transferred: 0, recipients: recipients.length, capped: true };

    const actualTotal = perRecipient * recipients.length;
    await env.DB
      .prepare(`UPDATE game_factions SET gold = gold - ? WHERE id = ? AND game_id = ?`)
      .bind(actualTotal, target, gameId)
      .run();
    for (const r of recipients) {
      await env.DB
        .prepare(`UPDATE game_factions SET gold = gold + ? WHERE id = ? AND game_id = ?`)
        .bind(perRecipient, r.id, gameId)
        .run();
    }
    return { transferred: actualTotal, per_recipient: perRecipient, recipients: recipients.length };
  }

  if (kind === 'chancellor_vote') {
    const candidate = payload.candidate_faction_id;
    if (!candidate) return null;
    // Verify candidate is still around (eliminated mid-vote means the
    // chancellorship is moot). Fail closed: pass becomes a no-op.
    const cand = await env.DB
      .prepare(`SELECT id, name FROM game_factions WHERE id = ? AND game_id = ? AND status = 'active'`)
      .bind(candidate, gameId).first();
    if (!cand) return { invalidated: true };

    // End the match. The existing chronicle 'victory' kind + the games
    // row mutation are the same path the three objective victories take
    // (see room.js checkVictory) — VictoryOverlay listens on
    // game.status === 'completed'.
    const completedAt = Date.now();
    await env.DB
      .prepare(`UPDATE games SET status = 'completed', winner_faction_id = ?, victory_type = 'chancellor', completed_at = ? WHERE id = ?`)
      .bind(candidate, completedAt, gameId)
      .run();
    const chronicleId = newId("chr");
    await env.DB
      .prepare(
        "INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms) " +
        "VALUES (?, ?, ?, 'victory', ?, ?, 'public', ?)"
      )
      .bind(
        chronicleId, gameId, tick, candidate,
        JSON.stringify({ victoryType: 'chancellor', detail: `${cand.name} elected Supreme Chancellor by senate vote` }),
        completedAt,
      ).run();
    // Announce the win NOW rather than waiting for tomorrow's Herald.
    // Non-throwing by construction; the match is already recorded as won
    // above, so a Discord failure cannot undo the victory.
    try {
      const { publishFinalEdition } = await import('./digest.js');
      await publishFinalEdition(env, gameId);
    } catch (e) {
      console.error('final edition (chancellor) failed', e);
    }
    return { winner_faction_id: candidate, victory_type: 'chancellor' };
  }

  return null;
}

/**
 * Resolve the Senate for a given tick. Idempotent and non-throwing: a
 * failure here must NOT kill the surrounding resolveTick. Returns a
 * summary so the caller can log/test.
 *
 * Phase 1: debating -> voting where vote_opens_at_tick <= tick.
 * Phase 2: voting -> passed/failed where vote_closes_at_tick <= tick.
 *          Passed proposals write a senate_effects row spanning
 *          [tick, tick+EFFECT_TICKS) so downstream consumers (build
 *          cost, combat damage) see them on the same tick they ratify.
 */
export async function resolveSenate(env, gameId, tick) {
  // Phase -1: seat a chairman. Runs before anything else so a game that
  // has never had a term gets one on the first tick after this ships,
  // and so an eliminated chairman is replaced before the proposal
  // handler can consult the term. Isolated: a rotation failure must not
  // stop bills already on the floor from resolving.
  let term = null;
  try {
    term = await ensureTerm(env, gameId, tick);
    // A term whose start IS this tick was just opened, so announce it.
    // Comparing start_tick beats having ensureTerm return a flag: this
    // stays correct even when the rotation ran inside a catch-up loop or
    // a retried tick.
    if (term && Number(term.start_tick) === tick) {
      const chair = await env.DB
        .prepare('SELECT name FROM game_factions WHERE id = ?')
        .bind(term.faction_id).first();
      await env.DB
        .prepare(
          `INSERT INTO chronicle_entries
             (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'senate_term', ?, ?, 'public', ?)`,
        )
        .bind(
          newId('chr'), gameId, tick, term.faction_id,
          JSON.stringify({
            faction_name: chair?.name ?? null,
            term_index: Number(term.term_index),
            bag_cycle: Number(term.bag_cycle),
            start_tick: Number(term.start_tick),
            end_tick: Number(term.end_tick),
          }),
          Date.now(),
        ).run();
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
        await stub.fetch('https://room/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'senate', event: 'term',
            chairman_faction_id: term.faction_id,
            chairman_name: chair?.name ?? null,
            end_tick: Number(term.end_tick),
          }),
        });
      } catch { /* best-effort */ }

      // Announce to the channel + DM the new chairman. Isolated on its
      // own: a Discord failure must not prevent the term from being
      // seated, and the term is already committed above.
      try {
        const discord = await import('./discord.js');
        await discord.publishChairmanSeated(env, gameId, term, chair?.name ?? 'A faction');
      } catch (e) {
        console.error('publishChairmanSeated failed', e, { termId: term.id });
      }
    }
  } catch (e) {
    console.error('resolveSenate: term rotation failed', e);
  }

  // Phase 0: rescue any proposal stuck in 'debating' past its FULL
  // window (vote_closes_at_tick already elapsed). This handles
  // proposals that survived a code/schema gap where Phase 1 never
  // fired. Force them to 'failed' so the senate doesn't accrete
  // permanent zombies. Idempotent: it only catches rows whose entire
  // debate+vote schedule has already passed.
  try {
    // Read the doomed rows BEFORE the flip — D1 has no RETURNING here,
    // and a bill that dies without a single line in the chronicle just
    // vanishes from its proposer's point of view. Rare by design (this
    // is a safety net), but "rare and silent" is the worst combination
    // to debug from a player report.
    const reaped = (await env.DB
      .prepare(
        `SELECT id, title, kind, proposer_faction_id, proposed_at_tick, vote_closes_at_tick
           FROM senate_proposals
          WHERE game_id = ? AND status = 'debating' AND vote_closes_at_tick <= ?`,
      )
      .bind(gameId, tick).all()).results ?? [];

    await env.DB
      .prepare("UPDATE senate_proposals SET status = 'failed', resolved_at_tick = ? WHERE game_id = ? AND status = 'debating' AND vote_closes_at_tick <= ?")
      .bind(tick, gameId, tick).run();

    for (const z of reaped) {
      try {
        await env.DB
          .prepare(
            "INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms) " +
            "VALUES (?, ?, ?, 'senate_reaped', ?, ?, 'public', ?)",
          )
          .bind(
            newId("chr"), gameId, tick, z.proposer_faction_id,
            JSON.stringify({
              proposal_id: z.id,
              title: z.title,
              bill_kind: z.kind,
              proposed_at_tick: z.proposed_at_tick,
              vote_closes_at_tick: z.vote_closes_at_tick,
            }),
            Date.now(),
          ).run();
      } catch (e) {
        console.error('resolveSenate: reap chronicle failed', e, { proposalId: z.id });
      }
    }
    if (reaped.length > 0) {
      // Loud on purpose: this net only catches bills that never opened
      // for voting, which means something upstream skipped Phase 1.
      console.warn('resolveSenate: reaped proposals that never opened', {
        gameId, tick, count: reaped.length,
      });
    }
  } catch (e) {
    console.error("resolveSenate: zombie reap failed", e);
  }

  let opened = 0;
  try {
    // Capture which proposals are about to open BEFORE the UPDATE, so we
    // can announce exactly those to Discord (the UPDATE is a set-based
    // flip with no RETURNING in D1).
    const openingRows = (await env.DB
      .prepare("SELECT * FROM senate_proposals WHERE game_id = ? AND status = 'debating' AND vote_opens_at_tick <= ?")
      .bind(gameId, tick).all()).results ?? [];

    const res = await env.DB
      .prepare("UPDATE senate_proposals SET status = 'voting' WHERE game_id = ? AND status = 'debating' AND vote_opens_at_tick <= ?")
      .bind(gameId, tick).run();
    opened = res?.meta?.changes ?? 0;

    // Publish a vote card (embed + Yea/Nay/Abstain buttons) to Discord for
    // each newly-opened proposal. Best-effort and fully isolated: a Discord
    // outage or missing secrets must never stall the senate tick, so each
    // publish is caught individually and the feature no-ops when unwired.
    if (openingRows.length > 0) {
      try {
        const discord = await import('./discord.js');
        for (const p of openingRows) {
          try {
            await discord.publishSenateVoteOpen(env, gameId, p);
          } catch (e) {
            console.error('publishSenateVoteOpen failed', e, { proposalId: p.id });
          }
        }
      } catch (e) {
        console.error('resolveSenate: discord publish batch failed', e);
      }
    }
  } catch (e) {
    console.error("resolveSenate: phase 1 failed", e);
  }

  const toResolve = (await env.DB
    .prepare("SELECT * FROM senate_proposals WHERE game_id = ? AND status = 'voting' AND vote_closes_at_tick <= ?")
    .bind(gameId, tick).all()).results ?? [];

  // Vote-window-elapsed proposals: tally + dispatch on bill kind.
  // Per-kind effect ticks live in EFFECT_TICKS_BY_KIND below so each bill
  // can choose how long its sanction bites without changing the slider_law
  // legacy of 7-tick windows.
  let resolved = 0;
  // One quorum reading for the whole batch — seated-ness is a property of
  // the game at this tick, not of an individual bill, and re-querying per
  // bill could give two bills resolving on the same tick different bars.
  let quorumCtx = null;
  if (toResolve.length > 0) {
    try {
      quorumCtx = await quorumFor(env, gameId);
    } catch (e) {
      console.error('resolveSenate: quorum lookup failed', e);
    }
  }
  for (const p of toResolve) {
    try {
      const totals = await loadProposalTotals(env, p.id);
      // QUORUM: at least half the SEATED players must have engaged.
      // A quorum failure is indistinguishable from a defeat in outcome
      // (the bill fails either way) but is recorded separately in the
      // chronicle, because "nobody showed up" and "the room said no" are
      // very different pieces of political news.
      const cast = votesCastCount(totals);
      const required = quorumCtx?.quorum ?? 0;
      const quorumMet = cast >= required;
      const passed = quorumMet && totals.yea.weight > totals.nay.weight;
      const status = passed ? "passed" : "failed";
      const effectTicks = EFFECT_TICKS_BY_KIND[p.kind] ?? EFFECT_TICKS;
      const effectUntil = passed && ONGOING_EFFECT_KINDS.has(p.kind) ? tick + effectTicks
                       : passed && p.kind === 'slider_law' ? tick + effectTicks
                       : null;  // one-shot kinds (reparations, chancellor_vote) don't park an effect
      await env.DB
        .prepare("UPDATE senate_proposals SET status = ?, resolved_at_tick = ?, effect_until_tick = ? WHERE id = ?")
        .bind(status, tick, effectUntil, p.id).run();

      let payload = {};
      try { payload = JSON.parse(p.payload || "{}"); } catch { /* keep default */ }

      // Per-kind effect application. The chronicle entry (further down)
      // captures the kind + outcome for every bill regardless.
      const sideEffects = passed ? await applyBillEffects(env, gameId, tick, p, payload, effectUntil) : null;

      const chronicleId = newId("chr");
      await env.DB
        .prepare(
          "INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms) " +
          "VALUES (?, ?, ?, 'senate_vote', ?, ?, 'public', ?)"
        )
        .bind(
          chronicleId, gameId, tick, p.proposer_faction_id,
          JSON.stringify({
            proposal_id: p.id,
            title: p.title,
            bill_kind: p.kind,
            payload,
            outcome: status,
            // Distinguishes "voted down" from "nobody came". The Herald
            // reads this to write the right sentence, and it's the
            // signal we'll watch to decide whether the quorum bar is set
            // too high for real tables.
            failed_quorum: !quorumMet,
            quorum_required: required,
            quorum_cast: cast,
            quorum_eligible: quorumCtx?.eligible ?? null,
            yea_weight: totals.yea.weight,
            nay_weight: totals.nay.weight,
            abstain_weight: totals.abstain.weight,
            effect_until_tick: effectUntil,
            ...(sideEffects ?? {}),
          }),
          Date.now(),
        ).run();

      // Tell the channel how it ended. Until this, Discord narrated a
      // bill through debate and voting and then said nothing at all —
      // a law could pass and re-price the whole economy in silence.
      // Isolated: a Discord outage must not fail a resolution that has
      // already been written to D1.
      try {
        const discord = await import('./discord.js');
        await discord.publishSenateResolved(env, gameId, p, {
          passed, quorumMet, cast, required,
          eligible: quorumCtx?.eligible ?? 0,
          yea: totals.yea.weight,
          nay: totals.nay.weight,
          abstain: totals.abstain.weight,
          effectUntil, tick,
        });
      } catch (e) {
        console.error('publishSenateResolved failed', e, { proposalId: p.id });
      }
      // And strip the buttons off the original vote card. It already
      // knows to drop them for a non-voting bill; nothing was calling it
      // on the tick path, so a closed vote kept live-looking Yea/Nay
      // buttons that silently did nothing.
      try {
        const discord = await import('./discord.js');
        await discord.refreshSenateCard(env, p.id);
      } catch (e) {
        console.error('refreshSenateCard (resolution) failed', e, { proposalId: p.id });
      }

      resolved += 1;
    } catch (e) {
      console.error("resolveSenate: proposal resolution failed", e, { proposalId: p.id });
    }
  }

  // Phase 3: LAWS THAT LAPSED.
  //
  // Nothing used to mark the end of a law. Its modifier applied for as
  // long as every read filtered `active_until_tick > tick`, so it simply
  // stopped matching one tick — no card, no Herald line, nothing in the
  // chronicle. A tariff that had shaped the economy for its whole run
  // just stopped, which reads as a bug rather than as the rule expiring.
  //
  // Announce-only: the effect was ALREADY inert by virtue of the filter,
  // so this deliberately writes no game state beyond the stamp. If this
  // pass ever started clearing effects it would become load-bearing, and
  // a failure here would silently extend laws forever.
  //
  // `<= tick` not `= tick`, because resolveSenate can be handed a
  // catch-up batch after an idle stretch; the stamp is what keeps it to
  // one card per law.
  let expired = 0;
  try {
    const lapsed = (await env.DB
      .prepare(
        `SELECT id, title, kind, proposer_faction_id, resolved_at_tick, effect_until_tick
           FROM senate_proposals
          WHERE game_id = ? AND status = 'passed'
            AND effect_until_tick IS NOT NULL
            AND effect_until_tick <= ?
            AND expiry_logged_at_tick IS NULL`,
      )
      .bind(gameId, tick).all()).results ?? [];

    for (const law of lapsed) {
      try {
        await env.DB
          .prepare(
            "INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms) " +
            "VALUES (?, ?, ?, 'senate_law_expired', ?, ?, 'public', ?)",
          )
          .bind(
            newId("chr"), gameId, tick, law.proposer_faction_id,
            JSON.stringify({
              proposal_id: law.id,
              title: law.title,
              bill_kind: law.kind,
              // How long it actually stood, for the Herald's prose and
              // for judging whether effect windows are tuned sanely.
              ticks_in_force: Math.max(
                0, Number(law.effect_until_tick) - Number(law.resolved_at_tick ?? law.effect_until_tick),
              ),
              expired_at_tick: Number(law.effect_until_tick),
            }),
            Date.now(),
          ).run();
        // Stamp AFTER the insert: if the insert throws we retry next
        // tick rather than marking a card as delivered that never was.
        await env.DB
          .prepare('UPDATE senate_proposals SET expiry_logged_at_tick = ? WHERE id = ?')
          .bind(tick, law.id).run();
        // Same silence as the resolution card had: Discord watched laws
        // arrive and never saw one leave.
        try {
          const discord = await import('./discord.js');
          await discord.publishLawExpired(env, gameId, {
            title: law.title,
            kind: law.kind,
            ticksInForce: Math.max(
              0, Number(law.effect_until_tick) - Number(law.resolved_at_tick ?? law.effect_until_tick),
            ),
          });
        } catch (e) {
          console.error('publishLawExpired failed', e, { proposalId: law.id });
        }
        expired += 1;
      } catch (e) {
        console.error('resolveSenate: law expiry announce failed', e, { proposalId: law.id });
      }
    }
  } catch (e) {
    console.error('resolveSenate: law expiry sweep failed', e);
  }

  // ---- Phase 4: warn before a law lapses (4h, then 1h) ----------------
  //
  // Laws stand a full term now, so a lapse is both easy to miss and
  // expensive to miss: the economy silently reverts, and re-passing costs
  // debate + vote ticks. The warnings only help if they arrive with
  // enough runway to actually move a bill, hence two of them.
  //
  // WALL CLOCK, not ticks. tick_interval_ms is per-game (an hour here, 30
  // seconds in a sim room), so "4 hours left" measured in ticks would
  // mean something different in every lobby. ticksLeft * interval is the
  // real remaining time.
  //
  // Announce-only, like the expiry sweep: writes no game state beyond its
  // stamp, so a failure here can never extend or shorten a law. Stamped
  // AFTER a successful post so a failed post retries next tick.
  try {
    const g = await env.DB
      .prepare('SELECT tick_interval_ms FROM games WHERE id = ?')
      .bind(gameId).first();
    const intervalMs = Number(g?.tick_interval_ms ?? 0);
    // No sane interval => no way to convert ticks into hours; skip
    // rather than guess and post nonsense.
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      const HOUR_MS = 3600 * 1000;
      // Ordered loudest-last: if a catch-up batch crosses both windows in
      // one tick, the 4h stamp lands first and the 1h card is the one the
      // channel sees most recently.
      const STAGES = [
        { hours: 4, col: 'warn_4h_logged_at_tick' },
        { hours: 1, col: 'warn_1h_logged_at_tick' },
      ];
      for (const stage of STAGES) {
        // A threshold shorter than one tick is unreachable: with hour-long
        // ticks there is no moment "1 hour out" that a tick observes
        // before the law is already gone. Fire it at the last tick before
        // expiry instead of never firing it at all.
        const ticksForStage = Math.max(1, Math.floor((stage.hours * HOUR_MS) / intervalMs));
        const rows = (await env.DB
          .prepare(
            `SELECT id, title, kind, payload, effect_until_tick
               FROM senate_proposals
              WHERE game_id = ? AND status = 'passed'
                AND effect_until_tick IS NOT NULL
                AND effect_until_tick > ?
                AND effect_until_tick - ? <= ?
                AND ${stage.col} IS NULL
                AND repealed_at_tick IS NULL`,
          )
          .bind(gameId, tick, tick, ticksForStage).all()).results ?? [];

        for (const law of rows) {
          try {
            // Say what it DOES, not just its name — the same wording the
            // top bar and the vote card use.
            let effect = null;
            try {
              const payload = JSON.parse(law.payload || '{}');
              if (law.kind === 'slider_law' && payload.slider_id) {
                effect = describeSlider(payload.slider_id, payload.target_value)?.effect ?? null;
              }
            } catch { /* effect line is optional */ }

            const discord = await import('./discord.js');
            const out = await discord.publishLawExpiring(env, gameId, {
              title: law.title,
              kind: law.kind,
              effect,
              hoursLeft: stage.hours,
              untilTick: Number(law.effect_until_tick),
            });
            // Stamp even when the post was SUPPRESSED by policy (cards
            // off, no Discord audience for this game) — retrying those
            // every tick forever would be a query storm for a decision
            // that will not change. Only a transport failure retries.
            const suppressed = out && out.posted === false
              && ['no_bot_token', 'disabled', 'no_channel'].includes(out.reason);
            if (out?.posted || suppressed) {
              await env.DB
                .prepare(`UPDATE senate_proposals SET ${stage.col} = ? WHERE id = ?`)
                .bind(tick, law.id).run();
            }
          } catch (e) {
            console.error('resolveSenate: law-expiring warn failed', e,
              { proposalId: law.id, hours: stage.hours });
          }
        }
      }
    }
  } catch (e) {
    console.error('resolveSenate: law-expiring sweep failed', e);
  }

  if (opened > 0 || resolved > 0 || expired > 0) {
    try {
      const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
      await stub.fetch("https://room/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "senate", event: "resolved", opened, resolved, tick }),
      });
    } catch { /* swallow */ }
  }

  return { opened, resolved };
}

async function handleDevTick(_req, env, { params, session }) {
  const { gameId } = params;
  const game = await env.DB
    .prepare("SELECT g.id, g.current_tick, r.host_id FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?")
    .bind(gameId)
    .first();
  if (!game) return err(404, "not_found", "game not found");
  if (game.host_id !== session.user_id) return err(403, "not_host", "only the host may advance the tick");

  const newTick = (game.current_tick ?? 0) + 1;
  await env.DB.prepare("UPDATE games SET current_tick = ? WHERE id = ?").bind(newTick, gameId).run();

  const { opened, resolved } = await resolveSenate(env, gameId, newTick);
  return json({ ok: true, current_tick: newTick, opened, resolved });
}

// ---------- routes ----------

const GAME_ID = '[A-Za-z0-9_-]{6,32}';
const PROP_ID = '[A-Za-z0-9_-]{1,80}';

/**
 * GET .../senate/weight — your vote weight and the systems behind it.
 *
 * A bare number invites the exact confusion this rework was meant to end
 * ("why does it say 18 when two people voted?"). Shipping the reasoning
 * alongside the number means the panel can show its work, and a player
 * deciding where to attack can see which system is one body from
 * flipping.
 */
async function handleWeight(_req, env, { params, session }) {
  const ctx = await loadGameAndFaction(env, params.gameId, session);
  if (ctx.error) return ctx.error;
  const detail = await voteWeightDetail(env, params.gameId, ctx.faction.id);
  return json({ ...detail, rule: WEIGHT_RULE });
}

export const routes = [
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/weight$`),
    auth: 'required',
    handle: handleWeight,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/sliders$`),
    auth: 'required',
    handle: handleListSliders,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/proposals$`),
    auth: 'required',
    handle: handleCreateProposal,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/proposals$`),
    auth: 'required',
    handle: handleListProposals,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/proposals/(?<proposalId>${PROP_ID})$`),
    auth: 'required',
    handle: handleGetProposal,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/proposals/(?<proposalId>${PROP_ID})/vote$`),
    auth: 'required',
    handle: handleVote,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/proposals/(?<proposalId>${PROP_ID})/withdraw$`),
    auth: 'required',
    handle: handleWithdraw,
  },
  // WILL BE REPLACED BY tick processor in the game-loop agent's work.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/senate/tick$`),
    auth: 'required',
    handle: handleDevTick,
  },
];
