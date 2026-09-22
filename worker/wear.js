// ============================================================
// wear.js — the Wear OS companion's whole server half.
//
// WHY THIS IS JSON WHEN THE WIDGET IS A PNG. The home-screen widget
// ships a rendered image because its layout lives in the APK and a
// redraw would otherwise cost a store release. A watch is the opposite
// problem: it is not a picture, it is three screens you scroll with a
// crown and press buttons on. Compose for Wear OS wants values — a
// number to animate, a row to scroll, a button to disable while a vote
// is in flight — and none of that survives being flattened to a bitmap.
//
// So the trade is deliberate and the cost is known: the watch's layout
// IS in the APK, and changing it is a release. What is NOT in the APK is
// any game rule. Every number below is derived here, by the same code
// the web client's own panels use, which is why the endpoint returns
// income per tick rather than the ledger rows to compute it from.
//
// ONE REQUEST, THREE SCREENS. A watch radio is the battery, and three
// endpoints would mean three wakeups for one glance. The state document
// carries the empire, the battles and the open bills together, because
// the player swipes between them in about a second and any of them
// being a tick older than the others would show.
//
// WHAT IT WILL NOT DO. The token is a capability, not a session (0134,
// 0136). This module adds exactly one write to the game — a senate vote
// on a bill whose window is already open — and it gets there through
// castVoteCore, the same function the in-game panel and the Discord
// buttons call. There is no route here that issues an order, reads a
// message, or hands back anything a session could be built from.
//
// Routes:
//   GET  /wear/<token>/state.json   everything the three screens show
//   POST /wear/<token>/vote         {proposalId, vote} -> castVoteCore
// ============================================================

import { resolveWidgetTokenRow, widgetSnapshot } from './widget.js';
import { battleSnapshot } from './battleWidget.js';
import { economySeries, economyAverages } from './economy.js';
import { castVoteCore } from './senate.js';
import { NON_WORLD_TYPES } from './systems.js';
import { cfg as loadGameConfig } from './gameConfig.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  // A watch caches aggressively on a metered link and a stale resource
  // count is the one thing this screen exists to not show.
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}
const err = (status, code, message) => json({ error: { code, message } }, { status });

export const WEAR_STATE_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/state\.json$/;
export const WEAR_VOTE_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/vote$/;

/**
 * Both routes start the same way: a token, resolved, and checked for
 * the scope this module requires.
 *
 * EVERY ROUTE HERE NEEDS 'wear', INCLUDING THE READ. It would be
 * defensible to let a card token read state.json — it shows nothing the
 * card does not already draw. It is not worth it: a single rule ("this
 * module is the wear scope") cannot be got wrong by the next route
 * added below it, and a two-rule module eventually grows a read route
 * that quietly became a write.
 */
export async function authorizeWear(env, token) {
  const row = await resolveWidgetTokenRow(env, token);
  if (!row) return { error: err(404, 'not_found', 'unknown or revoked token') };
  if (row.scope !== 'wear') {
    // 403 and not 404: the token is real, and telling its holder that
    // it is the wrong KIND of token is the difference between a watch
    // that says "re-pair me" and one that says nothing.
    return { error: err(403, 'wrong_scope', 'this token cannot drive a watch') };
  }
  return { userId: row.userId };
}

/** How much ledger to pull. The average itself is over the last ten
 *  SCORED ticks -- the same ten the Economy tab uses, so the watch and
 *  the panel never disagree about what "per tick" means -- and a tick
 *  only scores if it has a predecessor row to difference against. 24 is
 *  headroom for the gaps: a faction that joined mid-game, a tick the
 *  ledger missed, a restore. Asking for exactly ten reliably averaged
 *  over fewer. */
const INCOME_WINDOW_TICKS = 24;

/**
 * Income per tick, or nulls.
 *
 * NULL IS A REAL ANSWER AND THE WATCH DRAWS IT. A faction in its first
 * couple of ticks has no predecessor row to difference against, and a
 * game that has just been restored from a backup has a gap. Both cases
 * used to render as "+0 / TICK", which reads as "you are earning
 * nothing" rather than "we do not know yet" — the two look identical on
 * a 1.4 inch screen and only one of them should make a player worry.
 */
async function incomePerTick(env, gameId, factionId, currentTick) {
  try {
    const { series } = await economySeries(
      env, gameId, factionId, currentTick, INCOME_WINDOW_TICKS,
    );
    const avg = economyAverages(series, 10);
    if (!avg.sample_ticks) return { metal: null, gold: null, science: null, samples: 0 };
    return {
      metal: round1(avg.income_metal),
      gold: round1(avg.income_gold),
      science: round1(avg.income_science),
      upkeepMetal: round1(avg.upkeep_metal),
      upkeepGold: round1(avg.upkeep_gold),
      // Net is what the pool actually did, income minus upkeep minus
      // what the player spent. It is the honest headline for "am I
      // going up or down", and it is the one a player checks a watch to
      // see, so it is computed here rather than left as a subtraction
      // the client might get wrong.
      netMetal: round1(avg.net_metal),
      netGold: round1(avg.net_gold),
      samples: avg.sample_ticks,
    };
  } catch (e) {
    // The ledger is a convenience; the resource pools are the truth. A
    // watch that shows balances with no rate is far better than one
    // that shows an error because a ledger query failed.
    console.error('wear: income derivation failed', e);
    return { metal: null, gold: null, science: null, samples: 0 };
  }
}

const round1 = (n) => Math.round(Number(n ?? 0) * 10) / 10;

/**
 * The bills this faction can still vote on, and the ones it already has.
 *
 * IT RETURNS VOTED BILLS TOO, which the widget's `bills` count
 * deliberately does not. A count is a nag and should go to zero; a
 * screen is a record, and a player who has voted wants to see what they
 * voted and be able to change it while the window is open — which
 * castVoteCore allows, by updating rather than refusing.
 *
 * THE WINDOW, NOT THE STATUS. Same reasoning as castVoteCore: the
 * resolver flips debating -> voting on a tick boundary, so a bill can
 * be votable for a moment while still marked 'debating'. Listing by
 * status alone would hide a bill the vote route would happily accept.
 */
async function openBills(env, gameId, factionId, currentTick) {
  const rows = (await env.DB
    .prepare(
      `SELECT p.id, p.kind, p.title, p.summary, p.status,
              p.vote_closes_at_tick, v.vote AS my_vote,
              (SELECT COALESCE(SUM(weight), 0) FROM senate_votes w
                WHERE w.proposal_id = p.id AND w.vote = 'yea') AS yea,
              (SELECT COALESCE(SUM(weight), 0) FROM senate_votes w
                WHERE w.proposal_id = p.id AND w.vote = 'nay') AS nay
         FROM senate_proposals p
         LEFT JOIN senate_votes v ON v.proposal_id = p.id AND v.faction_id = ?2
        WHERE p.game_id = ?1
          AND p.status IN ('voting', 'debating')
          AND ?3 >= p.vote_opens_at_tick
          AND ?3 < p.vote_closes_at_tick
        ORDER BY (v.vote IS NOT NULL), p.vote_closes_at_tick ASC
        LIMIT 12`,
    )
    .bind(gameId, factionId, currentTick).all()).results ?? [];

  return rows.map(r => ({
    id: String(r.id),
    kind: String(r.kind || ''),
    title: String(r.title || ''),
    summary: String(r.summary || ''),
    // Ticks left, not the absolute tick. A watch shows "CLOSES IN 3T";
    // the player would otherwise have to hold the current tick in their
    // head to read the number at all.
    closesIn: Math.max(0, Number(r.vote_closes_at_tick ?? 0) - currentTick),
    myVote: r.my_vote ? String(r.my_vote) : null,
    yea: Number(r.yea ?? 0),
    nay: Number(r.nay ?? 0),
  }));
}

/**
 * GET /wear/<token>/state.json
 *
 * The three screens in one document. widgetSnapshot and battleSnapshot
 * are reused verbatim rather than re-queried: they already encode the
 * rules that took the widget several passes to get right — which game to
 * show a player who is in three, what an eliminated faction's counts
 * mean, and the treaty exclusion that stops an ally reading as inbound.
 */
export async function handleWearState(_req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;

  const snap = await widgetSnapshot(env, auth.userId);
  if (!snap) {
    // A real account with no faction anywhere. Not an error: a new
    // player who paired a watch before joining a game is in exactly
    // this state, and the watch has a screen for it.
    return json({ ok: true, state: 'none' });
  }

  const live = snap.state === 'live';
  // widgetSnapshot knows this and does not return it; everything below
  // keys on it, so it is resolved once rather than three times.
  const me = live ? await factionIdFor(env, snap.gameId, auth.userId) : null;

  // Only a live game is worth the extra queries. An eliminated faction
  // has nothing to vote on and no battles of its own, and an ended game
  // cannot be acted on at all — the same rule the widget card follows.
  //
  // In parallel, and each one swallowing its own failure: a watch that
  // shows resources and an empty battle list is useful, and one that
  // shows a spinner because the senate query timed out is not.
  const [battle, income, bills, extras] = await Promise.all([
    live ? battleSnapshot(env, auth.userId).catch(e => {
      console.error('wear: battle snapshot failed', e);
      return null;
    }) : null,
    live && me ? incomePerTick(env, snap.gameId, me, snap.tick) : null,
    live && me ? openBills(env, snap.gameId, me, snap.tick).catch(e => {
      console.error('wear: senate list failed', e);
      return [];
    }) : [],
    live && me ? complicationExtras(env, snap.gameId, me).catch(e => {
      console.error('wear: complication extras failed', e);
      return null;
    }) : null,
  ]);

  return json({
    ok: true,
    state: snap.state,
    game: snap.game,
    gameId: snap.gameId,
    faction: snap.faction,
    color: snap.color,
    tick: snap.tick,
    nextTickAt: snap.nextTickAt,
    // Server time, so the watch counts down from a clock it can trust.
    // A watch's own clock is usually right and occasionally minutes out,
    // and "NEXT TICK IN -4M" is the kind of thing a player screenshots.
    now: Date.now(),
    resources: {
      metal: snap.metal,
      credits: snap.gold,
      science: snap.science,
    },
    perTick: income,
    attention: {
      fighting: snap.fighting,
      inbound: snap.inbound,
      bills: snap.bills,
      unread: snap.unread,
      offers: snap.offers,
    },
    battles: battle?.battles ?? [],
    threats: battle?.threats ?? [],
    senate: bills,
    // For the complications: your hull count, domination as the win check
    // counts it, and the situation log's own badge with its age.
    ships: extras?.ships ?? null,
    domination: extras?.domination ?? null,
    situation: extras?.situation ?? null,
  });
}

/**
 * Ships, domination and the situation badge, for the watch complications.
 *
 * DOMINATION IS THE WIN CHECK'S ARITHMETIC (room.js): worlds only
 * (NON_WORLD_TYPES), undestroyed, owned by owner_faction_id, and a win
 * is STRICTLY MORE than domination_fraction of them -- so `need` is the
 * smallest count that wins, which is what the ring fills toward.
 */
async function complicationExtras(env, gameId, factionId) {
  const types = [...NON_WORLD_TYPES];
  const marks = types.map(() => '?').join(', ');
  const [ships, worlds, badge, conf] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND status = 'active' AND hp > 0`,
    ).bind(gameId, factionId).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN owner_faction_id = ? THEN 1 ELSE 0 END) AS owned
         FROM game_bodies
        WHERE game_id = ? AND destroyed_at_tick IS NULL AND type NOT IN (${marks})`,
    ).bind(factionId, gameId, ...types).first(),
    env.DB.prepare(
      'SELECT count, now, updated_ms FROM situation_badges WHERE game_id = ? AND faction_id = ?',
    ).bind(gameId, factionId).first().catch(() => null),
    loadGameConfig(env, gameId).catch(() => null),
  ]);
  const fraction = Number(conf?.domination_fraction) || 0.6;
  const total = Number(worlds?.total ?? 0);
  return {
    ships: Number(ships?.n ?? 0),
    domination: total > 0 ? {
      owned: Number(worlds?.owned ?? 0),
      total,
      need: Math.floor(total * fraction) + 1,
      fraction,
    } : null,
    situation: badge ? {
      count: Number(badge.count ?? 0),
      now: !!badge.now,
      at: Number(badge.updated_ms ?? 0),
    } : null,
  };
}

/** The faction row id for this user in this game. widgetSnapshot knows
 *  it and does not return it, and the rest of the world keys on it. */
export async function factionIdFor(env, gameId, userId) {
  const row = await env.DB
    .prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId).first();
  return row ? String(row.id) : null;
}

/**
 * POST /wear/<token>/vote  {proposalId, vote}
 *
 * THE ONE WRITE. It goes through castVoteCore, which owns every rule
 * that makes a vote legal — the window, the weight snapshot, the
 * update-don't-duplicate on a changed mind — so this handler's whole job
 * is to turn a token into a faction and hand over.
 *
 * IT MIRRORS TO DISCORD, like the in-game route, and for the same
 * reason: a bill voted from a watch showed a stale tally in the channel,
 * and people read the channel and believe it.
 */
export async function handleWearVote(req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;

  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const proposalId = String(body?.proposalId ?? '');
  const vote = String(body?.vote ?? '');
  if (!proposalId) return err(400, 'bad_request', 'proposalId required');

  const snap = await widgetSnapshot(env, auth.userId);
  if (!snap) return err(404, 'no_faction', 'no faction to vote with');
  if (snap.state !== 'live') return err(409, 'not_live', 'this game is not accepting votes');

  const me = await factionIdFor(env, snap.gameId, auth.userId);
  if (!me) return err(404, 'no_faction', 'no faction to vote with');

  // The proposal must belong to the game the watch is showing. Without
  // this check a token could vote in ANY game its user has a faction in
  // by sending a proposal id from another one — the watch would never
  // do it, which is exactly why the server has to be the one that says
  // no.
  const res = await castVoteCore(env, {
    gameId: snap.gameId,
    proposalId,
    factionId: me,
    currentTick: snap.tick,
    vote,
  });
  if (!res.ok) return err(res.status, res.code, res.message);

  try {
    const discord = await import('./discord.js');
    await discord.refreshSenateCard(env, proposalId);
  } catch (e) {
    console.error('wear: refreshSenateCard failed', e);
  }

  // The freshly-voted bill back, so the watch can redraw that one row
  // without spending another radio wakeup on the whole document.
  const bills = await openBills(env, snap.gameId, me, snap.tick);
  return json({
    ok: true,
    weight: res.weight,
    bill: bills.find(b => b.id === proposalId) ?? null,
  });
}
