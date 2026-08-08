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
const SLIDER_CATALOG = [
  {
    id: 'ship_build_cost_multiplier',
    label: 'Ship Build Cost Multiplier',
    description: 'Scales every resource cost in shipyard build queues. Cheap fleets vs. expensive prestige builds.',
    default: 1.0,
    min: 0.5,
    max: 1.5,
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
    label: 'Metal Yield Multiplier',
    description: 'Per-tick metal production from every settlement is multiplied by this value. '
      + 'Applies to everyone, including whoever proposed it.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'gold_yield_multiplier',
    label: 'Credit Yield Multiplier',
    description: 'Per-tick credit production from every settlement is multiplied by this value. '
      + 'Fleet upkeep is paid in credits, so this is the closest thing the senate has to a '
      + 'lever on how big a navy the whole system can afford.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'science_yield_multiplier',
    label: 'Science Yield Multiplier',
    description: 'Per-tick science production from every settlement is multiplied by this value. '
      + 'Raising it shortens the whole game; the tech tree is what ends it.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'combat_damage_multiplier',
    label: 'Combat Damage Multiplier',
    description: 'Scales the damage a faction DEALS in every engagement. Aimed at one faction it is '
      + 'a disarmament order: their guns hit softer, everyone else fires as normal.',
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'trade_tariff_pct',
    label: 'Trade Tariff (%)',
    description: 'Skims a percentage off what a faction RECEIVES in trade. Snapshotted per delivery '
      + 'when the deal is struck, so a later law cannot re-price cargo already in flight.',
    default: 0,
    min: 0,
    max: 50,
    step: 1,
    perFaction: true,
  },
  {
    id: 'fleet_upkeep_multiplier',
    label: 'Fleet Upkeep Multiplier',
    description: 'Scales per-tick fleet maintenance. 0 suspends upkeep entirely; 2 makes standing armies genuinely expensive.',
    default: 1.0,
    min: 0,
    max: 2.0,
    step: 0.05,
    perFaction: true,
  },
  {
    id: 'rush_cost_multiplier',
    label: 'Rush Cost Multiplier',
    description: 'Scales the price of rushing shipyard orders. High values make patience the law of the land.',
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

// Defaults when a proposal doesn't specify per-proposal durations. The
// new schema's debate_ticks/vote_ticks columns are nullable so legacy
// rows fall through to these constants on read.
const DEBATE_TICKS = 2;
const VOTE_TICKS = 1;
const EFFECT_TICKS = 7;

// Per-proposal duration ranges, in TICKS but floored in REAL TIME.
//
// Debate and voting each get at least six hours of wall clock (Lorne).
// A tick-count floor cannot express that: live games run ticks from 30
// seconds to 60 minutes, so "2 ticks" is a one-minute rubber stamp in
// one game and two hours in another. Every player deserves a night's
// sleep before a bill that can END THE GAME resolves — the chancellor
// vote is a win condition and it should not be possible to slip one
// past a table that happened to be offline.
//
// The MAX stays generous but is always at least the floor, so a fast-tick
// game can't end up with min > max and a clamp that throws.
const MIN_WINDOW_MS = 6 * 60 * 60 * 1000;   // six hours, each phase
const DEBATE_MAX_TICKS = 48;
const VOTE_MAX_TICKS   = 24;

/** Ticks that cover MIN_WINDOW_MS at this game's cadence, at least 1. */
export function minWindowTicks(tickIntervalMs) {
  const ms = Number(tickIntervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return 1;   // malformed row: don't block the senate
  return Math.max(1, Math.ceil(MIN_WINDOW_MS / ms));
}

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
const BILL_KINDS = new Set([
  'slider_law', 'trade_embargo', 'war_authorization',
  'production_sanction', 'reparations', 'chancellor_vote',
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
    // tick_interval_ms drives the 6-hour debate/vote floor: ticks are
    // 30s in one live game and 60min in another, so a fixed tick count
    // would mean six hours here and fifteen minutes there.
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
    .prepare(`SELECT vote, SUM(weight) AS w, COUNT(*) AS n FROM senate_votes WHERE proposal_id = ? GROUP BY vote`)
    .bind(proposalId)
    .all();
  const tot = { yea: { weight: 0, count: 0 }, nay: { weight: 0, count: 0 }, abstain: { weight: 0, count: 0 } };
  for (const r of rows.results ?? []) {
    if (tot[r.vote]) { tot[r.vote].weight = r.w ?? 0; tot[r.vote].count = r.n ?? 0; }
  }
  return tot;
}

function shapeProposal(row, totals, callerVote) {
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
  };
}

async function shapeOne(env, row, callerFactionId) {
  const totals = await loadProposalTotals(env, row.id);
  let callerVote = null;
  if (callerFactionId) {
    const v = await env.DB
      .prepare('SELECT vote FROM senate_votes WHERE proposal_id = ? AND faction_id = ?')
      .bind(row.id, callerFactionId)
      .first();
    callerVote = v?.vote ?? null;
  }
  return shapeProposal(row, totals, callerVote);
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
    // The six-hour debate/vote floor in THIS game's ticks. Sent rather
    // than hardcoded client-side: it depends on tick_interval_ms, which
    // varies 30s..60min across live games, and a second copy of the rule
    // is the thing that drifts.
    min_window_ticks: minWindowTicks(ctx.game.tick_interval_ms),
    debate_max_ticks: Math.max(DEBATE_MAX_TICKS, minWindowTicks(ctx.game.tick_interval_ms)),
    vote_max_ticks: Math.max(VOTE_MAX_TICKS, minWindowTicks(ctx.game.tick_interval_ms)),
    sliders: SLIDER_CATALOG.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      default: s.default,
      min: s.min,
      max: s.max,
      step: s.step,
      per_faction: s.perFaction !== false,
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

  // Research gate. VOTING is deliberately never gated — a new player is
  // part of the senate from tick one and can always weigh in on someone
  // else's bill. What research buys is the right to SET the agenda:
  // Society 5 to put any bill on the floor, Society 6 for the Chancellor
  // election specifically, since that bill can end the game.
  if (await gatingEnabled(env, gameId)) {
    const levels = await factionTechLevels(env, gameId, ctx.faction.id);
    const needed = kind === 'chancellor_vote' ? 'senate.chancellor' : 'senate.propose';
    if (!hasFeature(needed, levels, true)) {
      const e = lockedError(needed);
      return err(403, e.code, e.message);
    }
  }

  const { title, summary } = body;
  if (typeof title !== 'string' || title.trim().length < 1 || title.length > 80) {
    return err(400, 'bad_request', 'title must be 1-80 chars');
  }
  if (typeof summary !== 'string' || summary.trim().length < 1 || summary.length > 500) {
    return err(400, 'bad_request', 'summary must be 1-500 chars');
  }

  // 1-active-proposal-per-faction cooldown (any kind, any status that's
  // still resolving) — keeps a single faction from spamming the docket.
  const active = await env.DB
    .prepare(`SELECT id FROM senate_proposals WHERE game_id = ? AND proposer_faction_id = ? AND status IN ('debating','voting') LIMIT 1`)
    .bind(gameId, ctx.faction.id)
    .first();
  if (active) return err(429, 'cooldown', 'your faction already has an active proposal');

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
  const floorTicks = minWindowTicks(ctx.game.tick_interval_ms);
  const debateMax = Math.max(DEBATE_MAX_TICKS, floorTicks);
  const voteMax   = Math.max(VOTE_MAX_TICKS,   floorTicks);
  const debateTicks = clampInt(body.debate_ticks, floorTicks, debateMax, Math.max(DEBATE_TICKS, floorTicks));
  const voteTicks   = clampInt(body.vote_ticks,   floorTicks, voteMax,   Math.max(VOTE_TICKS,   floorTicks));

  const id = newId('prop');
  const proposedAt = ctx.game.current_tick;
  const voteOpens  = proposedAt + debateTicks;
  const voteCloses = voteOpens + voteTicks;

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

  const row = await env.DB.prepare('SELECT * FROM senate_proposals WHERE id = ?').bind(id).first();
  const shaped = await shapeOne(env, row, ctx.faction.id);

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

  const out = [];
  for (const r of rows) out.push(await shapeOne(env, r, ctx.faction.id));
  return json({ current_tick: ctx.game.current_tick, proposals: out });
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

  const shaped = await shapeOne(env, row, ctx.faction.id);
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
 *  slider_law uses the legacy EFFECT_TICKS (7) so existing balance
 *  doesn't shift; sanctions bite for longer; one-shot kinds don't
 *  read this. */
const EFFECT_TICKS_BY_KIND = {
  slider_law:           EFFECT_TICKS,
  trade_embargo:        EMBARGO_EFFECT_TICKS,
  war_authorization:    WAR_AUTH_EFFECT_TICKS,
  production_sanction:  PROD_SANCTION_EFFECT_TICKS,
  reparations:          0,   // one-shot
  chancellor_vote:      0,   // one-shot, ends the match
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
  // Phase 0: rescue any proposal stuck in 'debating' past its FULL
  // window (vote_closes_at_tick already elapsed). This handles
  // proposals that survived a code/schema gap where Phase 1 never
  // fired. Force them to 'failed' so the senate doesn't accrete
  // permanent zombies. Idempotent: it only catches rows whose entire
  // debate+vote schedule has already passed.
  try {
    await env.DB
      .prepare("UPDATE senate_proposals SET status = 'failed', resolved_at_tick = ? WHERE game_id = ? AND status = 'debating' AND vote_closes_at_tick <= ?")
      .bind(tick, gameId, tick).run();
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
  for (const p of toResolve) {
    try {
      const totals = await loadProposalTotals(env, p.id);
      const passed = totals.yea.weight > totals.nay.weight;
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
            yea_weight: totals.yea.weight,
            nay_weight: totals.nay.weight,
            abstain_weight: totals.abstain.weight,
            effect_until_tick: effectUntil,
            ...(sideEffects ?? {}),
          }),
          Date.now(),
        ).run();

      resolved += 1;
    } catch (e) {
      console.error("resolveSenate: proposal resolution failed", e, { proposalId: p.id });
    }
  }

  if (opened > 0 || resolved > 0) {
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
