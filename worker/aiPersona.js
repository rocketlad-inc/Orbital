// ============================================================
// Who a computer empire IS (worker/aiEmpire.js): how it treats the
// person, and when it goes to war. Lorne's picks, 2026-10-24: three
// personalities, chosen per rival at setup or dealt by "Surprise me";
// actions only, no messages; difficulty is how sharply they play
// (aiTactics.js SHARPNESS), never what they are given.
//
//   ALLY     offers a non-aggression pact, then a defence pact and an
//            intel share. Declares on whoever goes to war with you. Never
//            turns on you unless you wrong it: break a pact with it or
//            attack it, and it holds a grudge.
//   WARLORD  refuses every pact. Declares on you once it has a fleet, aims
//            at your weakest world, and only makes peace when it is losing.
//   SNAKE    courts you: a non-aggression pact, then an intel share (which
//            lets it watch your fleet). Builds warships all the while.
//            When the odds are good, and on Ruthless when your fleet is
//            away or busy in another war, it declares: the declaration
//            breaks the pact, and the chronicle says so. Once it has
//            taken something, or is losing, it makes peace, and later
//            starts courting you again.
//
// Toward other computer empires every personality is the same: it fights
// back when attacked and makes peace after a while.
//
// Its memory lives in game_factions.ai_state (JSON): grudges, when it
// last made peace with whom, the Snake's phase.
// ============================================================

import { due, power, visibleFleet, myArmed, pickTarget, scout, SHARPNESS } from './aiTactics.js';

export const PERSONALITIES = ['ally', 'warlord', 'snake'];

/** "Surprise me", seat by seat, per difficulty. */
export const SURPRISE_DECKS = {
  peaceful: ['ally', 'ally', 'snake', 'warlord', 'ally'],
  normal: ['warlord', 'ally', 'snake', 'ally', 'warlord'],
  ruthless: ['warlord', 'snake', 'warlord', 'snake', 'ally'],
};

/** The economy each personality runs (aiEmpire.js DOCTRINES). */
export function doctrineFor(personality, seat) {
  if (personality === 'warlord') return 'rusher';
  if (personality === 'snake') return 'schemer';
  return seat % 2 === 0 ? 'expander' : 'economist';
}

/** The timings, in ticks (a tick is a turn), per difficulty.
 *  warlordFrom   the earliest a Warlord declares on you
 *  snakeFrom     the earliest a Snake looks for its opening
 *  snakePatience how long past snakeFrom it waits for a good one before
 *                it settles for an even fight
 *  cooldown      after a peace, how long before the same empire may
 *                declare on you again (and a Snake starts courting) */
export const TIMING = {
  peaceful: { warlordFrom: 72, snakeFrom: 96, snakePatience: 48, cooldown: 96 },
  normal: { warlordFrom: 36, snakeFrom: 60, snakePatience: 60, cooldown: 48 },
  ruthless: { warlordFrom: 18, snakeFrom: 40, snakePatience: 72, cooldown: 24 },
};
/** Ticks between two of its offers to the same empire. */
const OFFER_EVERY = 24;
/** A grudge lasts this long after the wrong. */
const GRUDGE_TICKS = 96;
/** Peace with another computer empire: accepted after, offered after. */
const BOT_PEACE_AFTER = 24;
const BOT_PEACE_OFFER = 48;
/** The Warlord and the Snake make peace when their visible fleet is
 *  below this share of the enemy's. */
const LOSING = 0.5;

/** Its memory, with defaults. */
export function readMemory(raw) {
  let m = {};
  try { m = raw ? JSON.parse(raw) : {}; } catch { m = {}; }
  return {
    grudge: m.grudge ?? {},       // factionId -> tick it ends
    peaceAt: m.peaceAt ?? {},     // factionId -> tick of the last peace
    worldsAt: m.worldsAt ?? {},   // factionId -> my world count when that war began
    snake: m.snake ?? 'court',    // 'court' | 'war'
    since: m.since ?? 0,          // tick the phase began
    warLast: m.warLast ?? [],     // who it was at war with last turn
  };
}

/** The pacts on my side of the table, by other faction. */
async function myTreaties(env, gameId, me) {
  const rows = (await env.DB.prepare(
    `SELECT t.kind, t.status, t.broken_at_tick, t.breaker_faction_id,
            o.faction_id AS other, m.signed_at_tick AS mine_at, o.signed_at_tick AS theirs_at
       FROM treaties t
       JOIN treaty_signatories m ON m.treaty_id = t.id AND m.faction_id = ?
       JOIN treaty_signatories o ON o.treaty_id = t.id AND o.faction_id != ?
      WHERE t.game_id = ?`,
  ).bind(me, me, gameId).all()).results ?? [];
  const live = new Map();     // other -> [{kind, since}]
  const broken = [];          // {other, by, at}
  for (const r of rows) {
    if (r.status === 'active' && r.mine_at != null && r.theirs_at != null) {
      if (!live.has(r.other)) live.set(r.other, []);
      live.get(r.other).push({ kind: r.kind, since: Math.max(Number(r.mine_at), Number(r.theirs_at)) });
    } else if (r.status === 'broken') {
      broken.push({ other: r.other, by: r.breaker_faction_id, at: Number(r.broken_at_tick ?? 0) });
    }
  }
  return { live, broken };
}

/** My open offers, by responder. */
async function myOpenOffers(env, gameId, me) {
  const rows = (await env.DB.prepare(
    `SELECT responder_faction_id FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  return new Set(rows.map(r => r.responder_faction_id));
}

/**
 * One turn of diplomacy. Returns { foes, force, mem }: who to fight this
 * turn (every empire it is at war with), whether a strike was just
 * launched (fight now whatever the odds), and its updated memory.
 */
export async function conduct(env, ctx) {
  const { view, rm, call, note, personality, difficulty, last, wars, gameId } = ctx;
  const mem = ctx.mem;
  const tick = view.tick;
  const me = view.me;
  const H = view.human;
  const T = TIMING[difficulty] ?? TIMING.normal;
  const sharp = SHARPNESS[difficulty] ?? SHARPNESS.normal;
  const myWars = wars.filter(w => w.faction_a === me || w.faction_b === me);
  const enemyOf = (w) => (w.faction_a === me ? w.faction_b : w.faction_a);
  const warWith = new Map(myWars.map(w => [enemyOf(w), w]));
  const { live: pacts, broken } = await myTreaties(env, gameId, me);
  const offered = await myOpenOffers(env, gameId, me);
  const myWorlds = [...view.owner.values()].filter(o => o === me).length;

  // ---- memory: grudges for wrongs done to me ------------------------
  for (const b of broken) {
    if (b.by && b.by !== me && tick - b.at <= GRUDGE_TICKS) mem.grudge[b.by] = Math.max(mem.grudge[b.by] ?? 0, b.at + GRUDGE_TICKS);
  }
  for (const w of myWars) {
    if (w.declared_by && w.declared_by !== me) {
      mem.grudge[w.declared_by] = Math.max(mem.grudge[w.declared_by] ?? 0, Number(w.declared_at_tick ?? tick) + GRUDGE_TICKS);
    }
    if (mem.worldsAt[enemyOf(w)] == null) mem.worldsAt[enemyOf(w)] = myWorlds;
  }
  for (const f of Object.keys(mem.worldsAt)) if (!warWith.has(f)) delete mem.worldsAt[f];
  const grudge = (f) => (mem.grudge[f] ?? -1) > tick;
  // A war that was there last turn and is gone now ended in peace.
  for (const f of mem.warLast) if (!warWith.has(f)) mem.peaceAt[f] = tick;
  mem.warLast = [...warWith.keys()];

  // Losing: its visible fleet well below the enemy's, or a world gone.
  const losing = (f) => {
    const mineP = power(myArmed(view));
    const theirs = power(visibleFleet(view, f));
    return (theirs > 0 && mineP < LOSING * theirs) || myWorlds < (mem.worldsAt[f] ?? myWorlds);
  };
  const tookSomething = (f) => myWorlds > (mem.worldsAt[f] ?? myWorlds);

  const declare = async (f, label) => {
    const r = await call('POST', '/wars/declare', { target_faction_id: f });
    note(label, r);
    if (r.ok) mem.worldsAt[f] = myWorlds;
    return r.ok;
  };
  const endWar = async (f, label) => {
    const r = await call('POST', '/wars/end', { target_faction_id: f });
    note(label, r);
    return r;
  };
  const offerPacts = async (f, kinds, label) => {
    if (offered.has(f)) return;
    const r = await call('POST', '/trades', {
      responder_faction_id: f, offer: {}, request: {}, offer_pacts: kinds, request_pacts: [],
    });
    note(label, r);
    if (r.ok) offered.add(f);
  };

  // ---- offers addressed to me ----------------------------------------
  const inbox = (await env.DB.prepare(
    `SELECT id, proposer_faction_id, offer_metal, offer_gold, offer_science,
            request_metal, request_fuel, request_gold, request_science, offer_pacts, request_pacts
       FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  for (const o of inbox) {
    const asks = Number(o.request_metal) + Number(o.request_fuel) + Number(o.request_gold) + Number(o.request_science);
    let pactList = [];
    try { pactList = [...JSON.parse(o.offer_pacts || '[]'), ...JSON.parse(o.request_pacts || '[]')]; } catch { pactList = ['?']; }
    const from = o.proposer_faction_id;
    const wantsPeace = from === H
      ? (personality === 'ally' && !grudge(from)) || (personality === 'snake' && mem.snake === 'court')
      : !grudge(from) && personality !== 'warlord';
    // A gift with no strings, or pacts it wants: yes. Anything that costs
    // it resources: no (version one has no freighters to deliver with).
    const take = asks === 0 && (pactList.length === 0 || (wantsPeace && pactList.every(p => p !== '?')));
    note(take ? 'offer_accept' : 'offer_decline',
      await call('POST', `/trades/${encodeURIComponent(o.id)}/${take ? 'accept' : 'decline'}`, {}));
  }

  let force = false;

  // ---- the person ----------------------------------------------------
  if (H) {
    const war = warWith.get(H);
    const peace = pacts.get(H) ?? [];
    const hasNap = peace.some(p => p.kind === 'nap' || p.kind === 'defense_pact');
    const cooled = tick - (mem.peaceAt[H] ?? -9999) >= T.cooldown;

    if (personality === 'ally') {
      if (war) {
        // At war with you only because you wronged it, or you started it.
        if (w_ceasefireFrom(war, H) && (!grudge(H) || tick - Number(war.declared_at_tick) >= 24)) {
          await endWar(H, 'ceasefire_accept');
        } else if (!war.ceasefire_by && !grudge(H) && tick - Number(war.declared_at_tick) >= 12) {
          await endWar(H, 'ceasefire_offer');
        }
      } else if (grudge(H) && !hasNap && difficulty !== 'peaceful') {
        await declare(H, 'declare_grudge');
      } else if (!hasNap && due(tick, last, OFFER_EVERY, 2)) {
        await offerPacts(H, ['nap'], 'offer_nap');
      } else if (hasNap && !peace.some(p => p.kind === 'defense_pact')
                 && tick - Math.min(...peace.map(p => p.since)) >= 24 && due(tick, last, OFFER_EVERY * 2, 7)) {
        await offerPacts(H, ['defense_pact', 'intel_share'], 'offer_alliance');
      }
      // Your wars are its wars.
      for (const f of view.enemiesOf(H)) {
        if (f === me || warWith.has(f) || view.factions.get(f)?.status === 'monster') continue;
        if (myArmed(view).length >= 2 && due(tick, last, 6, 1)) await declare(f, 'declare_for_ally');
      }
    }

    if (personality === 'warlord') {
      if (war) {
        if (w_ceasefireFrom(war, H) && losing(H)) await endWar(H, 'ceasefire_accept');
        else if (!war.ceasefire_by && losing(H)) await endWar(H, 'ceasefire_offer');
      } else if (tick >= T.warlordFrom && cooled && myArmed(view).length >= 3) {
        await declare(H, 'declare');
      }
    }

    if (personality === 'snake') {
      if (war) {
        mem.snake = 'war';
        if (w_ceasefireFrom(war, H) && (tookSomething(H) || losing(H))) await endWar(H, 'ceasefire_accept');
        else if (!war.ceasefire_by && (tookSomething(H) || losing(H))) await endWar(H, 'ceasefire_offer');
      } else {
        if (mem.snake === 'war') { mem.snake = 'court'; mem.since = tick; }
        if (!hasNap && cooled && due(tick, last, OFFER_EVERY, 4)) {
          await offerPacts(H, ['nap'], 'offer_nap');
        } else if (hasNap && !peace.some(p => p.kind === 'intel_share') && due(tick, last, OFFER_EVERY * 2, 9)) {
          await offerPacts(H, ['intel_share'], 'offer_intel');
        }
        // The opening. It needs to see you first: a friendly visit to your
        // capital before the window opens (an intel share makes it moot).
        const strike = myArmed(view);
        const target = strike.length && tick >= T.snakeFrom - 12
          ? await pickTarget(view, rm, new Set([H]), strike, { opening: true, against: new Set([H]) }) : null;
        if (!target && strike.length && tick >= T.snakeFrom - 12) {
          const r = await scout(view, rm, call, view.factions.get(H)?.capital_body_id);
          if (r) note('snake_visit', r);
        }
        if (tick >= T.snakeFrom && cooled) {
          if (target) {
            const mine = power(strike);
            const patient = tick < T.snakeFrom + T.snakePatience;
            const busy = view.enemiesOf(H).length > 0;
            const away = target.guarded === 0 && visibleFleet(view, H).length > 0;
            const odds = mine >= Math.max(sharp.margin, 1) * target.theirs;
            const go = difficulty === 'peaceful'
              ? true
              : difficulty === 'ruthless'
                ? (odds && (busy || away)) || (!patient && mine >= target.theirs)
                : odds || (!patient && mine >= target.theirs);
            if (go && await declare(H, 'betray')) {
              mem.snake = 'war';
              mem.since = tick;
              force = true;
            } else note('snake_waits');
          }
        }
      }
    }

  }

  // ---- other computer empires: fight back, then make peace -----------
  for (const [f, w] of warWith) {
    if (f === H || view.factions.get(f)?.status === 'monster') continue;
    const age = tick - Number(w.declared_at_tick ?? tick);
    // The Ally keeps fighting your enemies while they are at war with you.
    if (personality === 'ally' && H && view.atWar(H, f)) continue;
    if (w_ceasefireFrom(w, f) && age >= BOT_PEACE_AFTER) await endWar(f, 'bot_ceasefire_accept');
    else if (!w.ceasefire_by && age >= BOT_PEACE_OFFER) await endWar(f, 'bot_ceasefire_offer');
  }

  // The view was read before this turn's declarations: a betrayal adds
  // its victim here.
  const foes = new Set(view.enemiesOf(me));
  if (force && H) foes.add(H);
  return { foes, force, mem };
}

/** Did `other` offer this war a ceasefire (so ending it now accepts)? */
function w_ceasefireFrom(w, other) {
  return !!w.ceasefire_by && w.ceasefire_by === other;
}

/** How it votes: for itself, for its friend, against its enemy. */
export function voteFor(p, ctx) {
  const { me, human, personality, enemies, mem, tick } = ctx;
  if (p.proposer_faction_id === me) return 'yea';
  let payload = {};
  try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
  const target = payload?.target_faction_id ?? null;
  if (target === me) return 'nay';
  const friendly = personality === 'ally' || (personality === 'snake' && mem.snake === 'court');
  if (human && friendly && !((mem.grudge[human] ?? -1) > tick)) {
    if (p.proposer_faction_id === human) return 'yea';
    if (target === human) return 'nay';
  }
  if (human && personality === 'warlord') {
    if (p.proposer_faction_id === human) return 'nay';
    if (target === human) return 'yea';
  }
  if (target && enemies.has(target)) return 'yea';
  if (p.proposer_faction_id && enemies.has(p.proposer_faction_id)) return 'nay';
  // A chancellor bid by the person: the only bill that can end the game.
  if (p.kind === 'chancellor_vote' && p.proposer_faction_id === human) return friendly ? 'abstain' : 'nay';
  return 'abstain';
}
