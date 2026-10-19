// ============================================================
// OFFERED DISCOVERIES — a found ship is a choice, not a bill.
//
// Lorne, 2026-10-18: "We need to add an option to refuse a structure/craft
// a player discovers. Sometimes they can't afford it."
//
// Two finds hand a player something that costs upkeep every tick: a
// derelict destroyer and an ancient capital ship (a Mega Destroyer or a
// Mobile Foundry). They used to be minted the moment a ship parked, and
// nothing in the game can scrap a hull, so a player who could not carry
// the bill was in arrears (the whole fleet at -25% damage) with no way
// out. Now the find waits as an OFFER to the empire whose ship found it:
//
//   - CLAIM: the ship is minted exactly as before and the find is public.
//   - REFUSE: nothing is minted and nothing is charged. The find stays on
//     the world, still hidden, for ANOTHER empire to find; the refuser's
//     ships no longer trigger it.
//   - NO ANSWER in OFFER_TICKS: claimed for them, which is what used to
//     happen at once. An empire eliminated meanwhile claims nothing, and
//     the find goes back to waiting for someone else.
//
// Every other kind (cities, caches, gates, ancient stations...) carries no
// upkeep and is revealed as before (room.js resolveSecretReveal).
// ============================================================

import { parkOrbitRadius } from './factions.js';
import { capitalHullInsert } from './megaLaunch.js';
import { parsePartsJson, computeShipStats, shipBaseStatsFromCfg, DEFAULT_LOADOUTS } from './shipDesigns.js';
import { cfg as loadGameConfig } from './gameConfig.js';

/** Finds that wait for a yes. */
export const OFFER_KINDS = new Set(['derelict_warship', 'ancient_capital']);
/** Ticks to decide before the find is claimed for you (a day at 1h ticks). */
export const OFFER_TICKS = 24;

/** Fuel a destroyer launches with -- FUEL_MAX in the build path. */
const DESTROYER_FUEL_MAX = 300;

/**
 * THE SALVAGED DESTROYER IS A MODERN ONE (Lorne, 2026-10-07: "Fix the
 * destroyers you find in discovery so they are a modern, updated
 * destroyer"). Exactly what the finder's own yard would launch today:
 * their ACTIVE destroyer design (else the standard-issue fit), stats from
 * computeShipStats on their tech and the game's ship config, full fuel,
 * at the defence-tech ceiling, wearing the design's silhouette.
 */
export async function salvagedDestroyer(env, gameId, factionId) {
  const design = await env.DB
    .prepare(
      `SELECT parts_json, icon_variant FROM game_ship_designs
        WHERE game_id = ? AND faction_id = ? AND ship_class = 'destroyer' AND is_active = 1
        LIMIT 1`,
    )
    .bind(gameId, factionId).first();
  let parts = design ? parsePartsJson('destroyer', design.parts_json) : [];
  if (parts.length === 0) parts = [...DEFAULT_LOADOUTS.destroyer];
  const tech = Object.fromEntries(((await env.DB
    .prepare(
      `SELECT tech_id, level FROM faction_techs
        WHERE game_id = ? AND faction_id = ? AND tech_id IN ('weapons','armor','shields')`,
    )
    .bind(gameId, factionId).all()).results ?? []).map(r => [r.tech_id, Number(r.level) || 0]));
  const CFG = await loadGameConfig(env, gameId).catch(() => null);
  const stats = computeShipStats('destroyer', parts, tech, shipBaseStatsFromCfg(CFG));
  const defenseLvl = Math.max(Number(tech.armor ?? 0), Number(tech.shields ?? 0));
  const iconVariant = design?.icon_variant && /^[A-Z]$/.test(design.icon_variant) ? design.icon_variant : null;
  return {
    parts,
    iconVariant,
    hpMax: stats.hp,
    hp: stats.hp * (1 + 0.08 * defenseLvl),
    damage: stats.damage_per_tick,
    fuel: DESTROYER_FUEL_MAX,
  };
}

/** The hull class an offer would put in the finder's fleet. */
export function offerShipClass(offer) {
  return offer.kind === 'ancient_capital' ? (offer.capital_kind || 'mega_destroyer') : 'destroyer';
}

/** What the ship would cost every tick, from the game's own rates (the
 *  same config the upkeep pass bills from), before any Senate law. */
export function offerUpkeep(conf, shipClass) {
  const n = (k) => Math.max(0, Number(conf?.[k] ?? 0) || 0);
  return { gold: n(`upkeep_${shipClass}_gold`), metal: n(`upkeep_${shipClass}_metal`) };
}

/** Hold a find for its finder. Statements for the reveal's batch: the
 *  offer row and a chronicle line only the finder sees. */
export function offerStatements(env, { gameId, bodyId, bodyName, kind, factionId, tick, capitalKind = null }) {
  const expires = tick + OFFER_TICKS;
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO discovery_offers
         (game_id, body_id, faction_id, kind, capital_kind, status, offered_tick, expires_tick)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(gameId, bodyId, factionId, kind, capitalKind, tick, expires),
    env.DB.prepare(
      `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'discovery_offer', ?, ?, ?, ?, ?)`,
    ).bind(
      `doffer_${bodyId.slice(-12)}_${Math.random().toString(36).slice(2, 8)}`, gameId, tick, factionId, bodyId,
      JSON.stringify({ kind, body_name: bodyName, capital_kind: capitalKind, expires_tick: expires }),
      JSON.stringify([factionId]), Date.now(),
    ),
  ];
}

/** The public line a claimed find writes: the same words the reveal
 *  always used, with a custom map's own name and message laid over. */
function claimedChronicle(kind, bodyName, capitalKind, customName, customText) {
  let message;
  let extra = {};
  if (kind === 'ancient_capital') {
    message = capitalKind === 'mega_destroyer'
      ? `${bodyName}: DISCOVERY — a derelict Mega Destroyer drifting dark at the edge of the system. Its reactor answers your hail. Claimed.`
      : `${bodyName}: DISCOVERY — a derelict Mobile Foundry, slipways intact. A shipyard at the edge of the system, and it is yours.`;
    extra = { capital_kind: capitalKind };
  } else {
    message = `${bodyName}: DISCOVERY — a derelict destroyer is salvageable. Claimed.`;
  }
  if (customName || customText) {
    const reward = message;
    const title = customName || 'DISCOVERY';
    const tail = customText || reward.replace(/^[^:]*:\s*DISCOVERY\s*[—-]\s*/, '');
    message = `${bodyName}: ${title} — ${tail}`;
    extra = {
      ...extra,
      ...(customName ? { custom_name: customName } : {}),
      ...(customText ? { custom_text: customText } : {}),
      reward_message: reward,
    };
  }
  return { message, extra };
}

/**
 * Claim a pending offer: the ship joins the finder's fleet and the find
 * becomes public, exactly as an immediate reveal used to. Safe to race: the
 * offer flips pending -> claimed in one guarded UPDATE, and only the call
 * that flipped it mints anything.
 * Returns { ok, code? }.
 */
export async function claimOffer(env, { gameId, bodyId, factionId, tick }) {
  const flip = await env.DB.prepare(
    `UPDATE discovery_offers SET status = 'claimed', resolved_tick = ?
      WHERE game_id = ? AND body_id = ? AND faction_id = ? AND status = 'pending'`,
  ).bind(tick, gameId, bodyId, factionId).run();
  if ((flip.meta?.changes ?? 0) === 0) return { ok: false, code: 'no_offer' };
  const offer = await env.DB.prepare(
    'SELECT kind, capital_kind FROM discovery_offers WHERE game_id = ? AND body_id = ? AND faction_id = ?',
  ).bind(gameId, bodyId, factionId).first();
  const body = await env.DB.prepare(
    'SELECT name, radius, secret_name, secret_text FROM game_bodies WHERE id = ? AND game_id = ?',
  ).bind(bodyId, gameId).first();
  if (!offer || !body) return { ok: false, code: 'not_found' };

  const stmts = [
    env.DB.prepare(
      `UPDATE game_bodies
          SET secret_revealed = 1, secret_discovered_by_faction_id = ?, secret_discovered_at_tick = ?
        WHERE id = ? AND secret_revealed = 0`,
    ).bind(factionId, tick, bodyId),
  ];
  if (offer.kind === 'ancient_capital') {
    // A deterministic id + INSERT OR IGNORE, so it can never be minted twice.
    const ins = await capitalHullInsert(env, {
      shipId: `${bodyId}_relic`, gameId, ownerId: factionId, kind: offer.capital_kind || 'mega_destroyer',
      name: `Relic of ${body.name}`, parentBodyId: bodyId, tick,
    });
    if (ins) stmts.push(ins);
  } else {
    // A destroyer for the finder, parked in a tight orbit, built exactly
    // as their own yard would build one today (salvagedDestroyer).
    const shipId = `${gameId}:wreck_${bodyId.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
    const rp = parkOrbitRadius(body.radius);
    const wreck = await salvagedDestroyer(env, gameId, factionId);
    stmts.push(env.DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick,
         hp, hp_max, damage_per_tick, icon_variant, parts_json, home_body_id)
       VALUES (?, ?, ?, ?, 'destroyer', ?,
               ?, ?, 0, 0, ?, 1,
               ?, ?, 'active', ?,
               ?, ?, ?, ?, ?, ?)`,
    ).bind(shipId, gameId, factionId, `${body.name} Salvage`, bodyId,
      rp, rp, tick,
      wreck.fuel, wreck.fuel, tick,
      wreck.hp, wreck.hpMax, wreck.damage, wreck.iconVariant,
      JSON.stringify(wreck.parts), bodyId));
  }
  const { message, extra } = claimedChronicle(offer.kind, body.name, offer.capital_kind, body.secret_name, body.secret_text);
  stmts.push(env.DB.prepare(
    `INSERT INTO chronicle_entries
      (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
     VALUES (?, ?, ?, 'secret_discovered', ?, ?, ?, 'public', ?)`,
  ).bind(
    `secret_${bodyId.slice(-12)}_${Math.random().toString(36).slice(2, 8)}`, gameId, tick, factionId, bodyId,
    JSON.stringify({ kind: offer.kind, body_name: body.name, message, ...extra }), Date.now(),
  ));
  await env.DB.batch(stmts);
  return { ok: true };
}

/** Refuse a pending offer: nothing minted, nothing charged, and the find
 *  waits on the world for someone else. Returns { ok, code? }. */
export async function refuseOffer(env, { gameId, bodyId, factionId, tick }) {
  const flip = await env.DB.prepare(
    `UPDATE discovery_offers SET status = 'refused', resolved_tick = ?
      WHERE game_id = ? AND body_id = ? AND faction_id = ? AND status = 'pending'`,
  ).bind(tick, gameId, bodyId, factionId).run();
  if ((flip.meta?.changes ?? 0) === 0) return { ok: false, code: 'no_offer' };
  const offer = await env.DB.prepare(
    'SELECT kind, capital_kind FROM discovery_offers WHERE game_id = ? AND body_id = ? AND faction_id = ?',
  ).bind(gameId, bodyId, factionId).first();
  const body = await env.DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(bodyId).first();
  await env.DB.prepare(
    `INSERT INTO chronicle_entries
       (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
     VALUES (?, ?, ?, 'discovery_refused', ?, ?, ?, ?, ?)`,
  ).bind(
    `drefuse_${bodyId.slice(-12)}_${Math.random().toString(36).slice(2, 8)}`, gameId, tick, factionId, bodyId,
    JSON.stringify({ kind: offer?.kind ?? null, body_name: body?.name ?? '', capital_kind: offer?.capital_kind ?? null }),
    JSON.stringify([factionId]), Date.now(),
  ).run().catch(() => { /* the refusal stands without its line */ });
  return { ok: true };
}

/** The tick's sweep: an offer nobody answered is claimed for its finder,
 *  as finds always were; one whose empire is gone simply lapses, and the
 *  find goes back to waiting. Returns how many were settled. */
export async function settleExpiredOffers(env, gameId, tick) {
  const due = (await env.DB.prepare(
    `SELECT o.body_id, o.faction_id, f.status AS faction_status
       FROM discovery_offers o
       LEFT JOIN game_factions f ON f.id = o.faction_id
      WHERE o.game_id = ? AND o.status = 'pending' AND o.expires_tick <= ?`,
  ).bind(gameId, tick).all()).results ?? [];
  let n = 0;
  for (const d of due) {
    try {
      if (d.faction_status === 'active') {
        const r = await claimOffer(env, { gameId, bodyId: d.body_id, factionId: d.faction_id, tick });
        if (r.ok) n += 1;
      } else {
        await env.DB.prepare(
          `UPDATE discovery_offers SET status = 'lapsed', resolved_tick = ?
            WHERE game_id = ? AND body_id = ? AND faction_id = ? AND status = 'pending'`,
        ).bind(tick, gameId, d.body_id, d.faction_id).run();
        n += 1;
      }
    } catch (e) {
      console.error('discovery offer settle failed', d, e);
    }
  }
  return n;
}

// ---------------------------------------------------------------- routes

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const err = (status, code, message) => json({ error: { code, message } }, { status });

// POST /api/games/:gameId/discoveries/:bodyId/claim | refuse
async function handleAnswer(req, env, ctx) {
  const { gameId, bodyId, verb } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const body = decodeURIComponent(bodyId);
  if (!body.startsWith(`${gameId}:`)) return err(400, 'bad_request', 'invalid world id');
  const me = await env.DB
    .prepare('SELECT id, status FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, ctx.session.user_id).first();
  if (!me) return err(403, 'not_member', 'not in this game');
  if (me.status !== 'active') return err(409, 'eliminated', 'your empire is gone');
  const game = await env.DB.prepare('SELECT current_tick, status FROM games WHERE id = ?').bind(gameId).first();
  if (!game || game.status !== 'active') return err(409, 'not_active', 'this game is not running');
  const tick = Number(game.current_tick ?? 0);
  const r = verb === 'claim'
    ? await claimOffer(env, { gameId, bodyId: body, factionId: me.id, tick })
    : await refuseOffer(env, { gameId, bodyId: body, factionId: me.id, tick });
  if (!r.ok) return err(409, r.code ?? 'no_offer', 'that find is no longer waiting for an answer');
  return json({ ok: true, status: verb === 'claim' ? 'claimed' : 'refused' });
}

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/discoveries\/(?<bodyId>[^/]+)\/(?<verb>claim|refuse)$/,
    auth: 'required',
    handle: handleAnswer,
  },
];
