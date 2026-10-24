// ============================================================
// Who a computer empire IS (worker/aiEmpire.js): how it treats the
// others, and when it goes to war. Lorne's picks, 2026-10-24: three
// personalities, chosen per rival at setup or dealt by "Surprise me";
// actions only, no messages; difficulty is how sharply they play
// (aiTactics.js SHARPNESS), never what they are given.
//
//   ALLY     offers non-aggression pacts, then a defence pact and an intel
//            share to its closest partner (you, when you are in the game).
//            Declares on whoever goes to war with a partner. Never turns on
//            anyone unless wronged: break a pact with it or attack it, and
//            it holds a grudge.
//   WARLORD  refuses every pact. Once it has a fleet it picks a victim
//            (you, when you are in the game; else the weakest fleet it can
//            see) and comes for its weakest world. Makes peace only when it
//            is losing.
//   SNAKE    courts everyone: non-aggression pacts, then intel shares (which
//            let it watch their fleets). Builds warships all the while. When
//            the odds are good (on Ruthless, when the victim's fleet is away
//            or busy in another war) it declares on one partner, you first:
//            the declaration breaks the pact, and the chronicle says so.
//            Once it has taken something, or is losing, it makes peace, and
//            later starts courting again.
//
// The person is preferred, never required: in a game of computer empires
// alone (the overnight crucible) each one plays the same rules against
// the others.
//
// Its memory lives in game_factions.ai_state (JSON): grudges, when it
// last made peace with whom, the Snake's phase and victim.
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

/** The timings, in ticks, per difficulty.
 *  warlordFrom   the earliest a Warlord declares
 *  snakeFrom     the earliest a Snake looks for its opening
 *  snakePatience how long past snakeFrom it waits for a good one before
 *                it settles for an even fight
 *  cooldown      after a peace, how long before the same empire may be
 *                attacked by it again (and a Snake courts it again)
 *  wars          most wars a Warlord starts at once */
export const TIMING = {
  peaceful: { warlordFrom: 72, snakeFrom: 96, snakePatience: 48, cooldown: 96, wars: 1 },
  normal: { warlordFrom: 36, snakeFrom: 60, snakePatience: 60, cooldown: 48, wars: 1 },
  ruthless: { warlordFrom: 18, snakeFrom: 40, snakePatience: 72, cooldown: 24, wars: 2 },
};
/** A trial's Warlord declares from this tick. */
export const TRIAL_WARLORD_FROM = 20;
/** Ticks between two of its offers to the same empire. */
const OFFER_EVERY = 24;
/** A grudge lasts this long after the wrong. */
const GRUDGE_TICKS = 96;
/** Peace in a war outside its personality's plans: accepted after,
 *  offered after. */
const PEACE_AFTER = 24;
const PEACE_OFFER = 48;
/** The Warlord and the Snake make peace when their visible fleet is
 *  below this share of the enemy's. */
const LOSING = 0.5;
/** A war in which no world has changed hands for this many ticks ends in
 *  peace, whoever the empires are (the crucible: four wars open for 5000
 *  ticks, nobody attacking, nobody yielding). */
const STALEMATE = 150;
/** The defensive pacts (an Ally answers for these partners). */
const DEFENSIVE = new Set(['nap', 'defense_pact']);

/** Its memory, with defaults. */
export function readMemory(raw) {
  let m = {};
  try { m = raw ? JSON.parse(raw) : {}; } catch { m = {}; }
  return {
    grudge: m.grudge ?? {},       // factionId -> tick it ends
    peaceAt: m.peaceAt ?? {},     // factionId -> tick of the last peace
    worldsAt: m.worldsAt ?? {},   // factionId -> my world count when that war began
    snake: m.snake ?? 'court',    // 'court' | 'war'
    victim: m.victim ?? null,     // the Snake's (or Warlord's) current target
    since: m.since ?? 0,          // tick the phase began
    warLast: m.warLast ?? [],     // who it was at war with last turn
    front: m.front ?? {},         // factionId -> { key, since }: the war's map, unchanged since
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

/** Small, stable per-pair offset, so one empire's offers to several
 *  others land on different ticks rather than all at once. */
function spread(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h % OFFER_EVERY;
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
  // A Play for Free trial (trial.js): the Warlord comes at tick 20,
  // about ten minutes in at 30 s ticks (Lorne's pick).
  const T = ctx.trial ? { ...(TIMING[difficulty] ?? TIMING.normal), warlordFrom: TRIAL_WARLORD_FROM }
                      : (TIMING[difficulty] ?? TIMING.normal);
  const sharp = SHARPNESS[difficulty] ?? SHARPNESS.normal;
  const enemyOf = (w) => (w.faction_a === me ? w.faction_b : w.faction_a);
  // A war with an empire that is gone never formally ends: ignore it (the
  // crucible scouted a dead capital 200 times and filed bills against it).
  const standing = (f) => view.factions.get(f)?.status === 'active';
  const myWars = wars.filter(w => (w.faction_a === me || w.faction_b === me) && standing(enemyOf(w)));
  const warWith = new Map(myWars.map(w => [enemyOf(w), w]));
  const { live: pacts, broken } = await myTreaties(env, gameId, me);
  const offered = await myOpenOffers(env, gameId, me);
  const myWorlds = [...view.owner.values()].filter(o => o === me).length;
  const rivals = [...view.factions.values()]
    .filter(f => f.id !== me && f.status === 'active').map(f => f.id);

  // ---- memory --------------------------------------------------------
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
  // The front: both sides' world counts. Unchanged for STALEMATE ticks,
  // the war is going nowhere.
  const worldsOf = (f) => [...view.owner.values()].filter(o => o === f).length;
  for (const f of warWith.keys()) {
    const key = `${myWorlds}:${worldsOf(f)}`;
    if (mem.front[f]?.key !== key) mem.front[f] = { key, since: tick };
  }
  for (const f of Object.keys(mem.front)) if (!warWith.has(f)) delete mem.front[f];
  const stalled = (f) => warWith.has(f) && tick - (mem.front[f]?.since ?? tick) >= STALEMATE;
  // A war that was there last turn and is gone now ended in peace.
  for (const f of mem.warLast) if (!warWith.has(f)) mem.peaceAt[f] = tick;
  mem.warLast = [...warWith.keys()];

  const grudge = (f) => (mem.grudge[f] ?? -1) > tick;
  const cooled = (f) => tick - (mem.peaceAt[f] ?? -9999) >= T.cooldown;
  const pactsWith = (f) => pacts.get(f) ?? [];
  const hasPeace = (f) => pactsWith(f).some(p => DEFENSIVE.has(p.kind));
  const losing = (f) => {
    const mineP = power(myArmed(view));
    const theirs = power(visibleFleet(view, f));
    return (theirs > 0 && mineP < LOSING * theirs) || myWorlds < (mem.worldsAt[f] ?? myWorlds);
  };
  const tookSomething = (f) => myWorlds > (mem.worldsAt[f] ?? myWorlds);
  const ageOf = (f) => tick - Number(warWith.get(f)?.declared_at_tick ?? tick);
  const theyOffered = (f) => !!warWith.get(f)?.ceasefire_by && warWith.get(f).ceasefire_by === f;

  const declare = async (f, label) => {
    const r = await call('POST', '/wars/declare', { target_faction_id: f });
    note(label, r);
    if (r.ok) { mem.worldsAt[f] = myWorlds; warWith.set(f, { declared_by: me, declared_at_tick: tick }); }
    return r.ok;
  };
  const endWar = async (f, label) => note(label, await call('POST', '/wars/end', { target_faction_id: f }));
  const offerPacts = async (f, kinds, label) => {
    if (offered.has(f)) return;
    const r = await call('POST', '/trades', {
      responder_faction_id: f, offer: {}, request: {}, offer_pacts: kinds, request_pacts: [],
    });
    note(label, r);
    if (r.ok) offered.add(f);
  };
  // Who it is willing to sign with.
  const friendlyTo = (f) => {
    if (grudge(f)) return false;
    if (personality === 'warlord') return false;
    if (personality === 'snake') return !(mem.snake === 'war' && mem.victim === f);
    return true;
  };

  // ---- offers addressed to me ----------------------------------------
  const inbox = (await env.DB.prepare(
    `SELECT id, proposer_faction_id, request_metal, request_fuel, request_gold, request_science,
            offer_pacts, request_pacts
       FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  for (const o of inbox) {
    const asks = Number(o.request_metal) + Number(o.request_fuel) + Number(o.request_gold) + Number(o.request_science);
    let pactList = [];
    try { pactList = [...JSON.parse(o.offer_pacts || '[]'), ...JSON.parse(o.request_pacts || '[]')]; } catch { pactList = ['?']; }
    // A gift with no strings, or pacts with someone it is friendly to:
    // yes. Anything that costs it resources: no (no freighter deliveries
    // yet).
    const take = asks === 0 && (pactList.length === 0 || (friendlyTo(o.proposer_faction_id) && !pactList.includes('?')));
    note(take ? 'offer_accept' : 'offer_decline',
      await call('POST', `/trades/${encodeURIComponent(o.id)}/${take ? 'accept' : 'decline'}`, {}));
  }

  let force = false;
  const handled = new Set();   // wars whose peace this personality decided

  // ---- ALLY ----------------------------------------------------------
  if (personality === 'ally') {
    for (const f of rivals) {
      if (warWith.has(f)) continue;
      if (grudge(f) && !hasPeace(f) && difficulty !== 'peaceful') { await declare(f, 'declare_grudge'); continue; }
      if (!hasPeace(f) && !grudge(f) && due(tick, last, OFFER_EVERY, spread(f))) await offerPacts(f, ['nap'], 'offer_nap');
    }
    // One closest partner: the person when present, else its oldest pact.
    const partners = rivals.filter(hasPeace);
    const best = (H && partners.includes(H)) ? H
      : partners.sort((a, b) => Math.min(...pactsWith(a).map(p => p.since)) - Math.min(...pactsWith(b).map(p => p.since)))[0];
    if (best && !pactsWith(best).some(p => p.kind === 'defense_pact')
        && tick - Math.min(...pactsWith(best).map(p => p.since)) >= 24 && due(tick, last, OFFER_EVERY * 2, 7)) {
      await offerPacts(best, ['defense_pact', 'intel_share'], 'offer_alliance');
    }
    // A partner's wars are its wars (never at the cost of breaking a pact).
    for (const p of partners) {
      for (const x of view.enemiesOf(p)) {
        if (x === me || warWith.has(x) || hasPeace(x) || view.factions.get(x)?.status === 'monster') continue;
        if (myArmed(view).length >= 2 && due(tick, last, 6, 1)) await declare(x, 'declare_for_ally');
      }
    }
    for (const [f] of warWith) {
      if (view.factions.get(f)?.status === 'monster') continue;
      if (stalled(f)) continue;
      handled.add(f);
      // It keeps fighting a partner's enemy while that war lasts.
      if (partners.some(p => view.atWar(p, f))) continue;
      if (theyOffered(f) && (!grudge(f) || ageOf(f) >= PEACE_AFTER)) await endWar(f, 'ceasefire_accept');
      else if (!warWith.get(f).ceasefire_by && !grudge(f) && ageOf(f) >= 12) await endWar(f, 'ceasefire_offer');
    }
  }

  // ---- WARLORD -------------------------------------------------------
  if (personality === 'warlord') {
    const started = [...warWith.values()].filter(w => w.declared_by === me).length;
    if (tick >= T.warlordFrom && started < T.wars && myArmed(view).length >= 3) {
      // The person first; else the weakest fleet it can see.
      const open = rivals.filter(f => !warWith.has(f) && cooled(f) && view.factions.get(f)?.status !== 'monster');
      const victim = (H && open.includes(H)) ? H
        : open.sort((a, b) => power(visibleFleet(view, a)) - power(visibleFleet(view, b)))[0];
      if (victim && await declare(victim, victim === H ? 'declare' : 'declare_rival')) mem.victim = victim;
    }
    for (const [f] of warWith) {
      if (view.factions.get(f)?.status === 'monster' || stalled(f)) continue;
      handled.add(f);
      if (theyOffered(f) && losing(f)) await endWar(f, 'ceasefire_accept');
      else if (!warWith.get(f).ceasefire_by && losing(f)) await endWar(f, 'ceasefire_offer');
    }
  }

  // ---- SNAKE ---------------------------------------------------------
  if (personality === 'snake') {
    if (mem.snake === 'war' && mem.victim && !warWith.has(mem.victim)) { mem.snake = 'court'; mem.since = tick; mem.victim = null; }
    // Court everyone it is not at war with.
    for (const f of rivals) {
      if (warWith.has(f) || !friendlyTo(f)) continue;
      if (!hasPeace(f) && cooled(f) && due(tick, last, OFFER_EVERY, spread(f))) await offerPacts(f, ['nap'], 'offer_nap');
      else if (hasPeace(f) && !pactsWith(f).some(p => p.kind === 'intel_share') && due(tick, last, OFFER_EVERY * 2, (spread(f) + 9) % 48)) {
        await offerPacts(f, ['intel_share'], 'offer_intel');
      }
    }
    if (mem.snake === 'court' && tick >= T.snakeFrom - 12) {
      // Its victim: the person first, else whichever partner offers the
      // best opening. It must see them first: a friendly visit to their
      // capital (an intel share makes that moot).
      const candidates = (H && !warWith.has(H) && cooled(H)) ? [H]
        : rivals.filter(f => !warWith.has(f) && cooled(f) && view.factions.get(f)?.status !== 'monster');
      const strike = myArmed(view);
      let best = null;
      for (const f of candidates) {
        if (!strike.length) break;
        const tgt = await pickTarget(view, rm, new Set([f]), strike, { opening: true, against: new Set([f]) });
        if (tgt && (!best || tgt.score > best.tgt.score)) best = { f, tgt };
      }
      if (!best && strike.length) {
        const f = candidates[0];
        const r = f ? await scout(view, rm, call, view.factions.get(f)?.capital_body_id) : null;
        if (r) note('snake_visit', r);
      }
      if (best && tick >= T.snakeFrom) {
        const mine = power(strike);
        const patient = tick < T.snakeFrom + T.snakePatience;
        const busy = view.enemiesOf(best.f).length > 0;
        const away = best.tgt.guarded === 0 && visibleFleet(view, best.f).length > 0;
        const odds = mine >= Math.max(sharp.margin, 1) * best.tgt.theirs;
        const go = difficulty === 'peaceful'
          ? true
          : difficulty === 'ruthless'
            ? (odds && (busy || away)) || (!patient && mine >= best.tgt.theirs)
            : odds || (!patient && mine >= best.tgt.theirs);
        if (go && await declare(best.f, best.f === H ? 'betray' : 'betray_rival')) {
          mem.snake = 'war';
          mem.victim = best.f;
          mem.since = tick;
          force = true;
        } else note('snake_waits');
      }
    }
    if (mem.snake === 'war' && mem.victim && warWith.has(mem.victim) && !stalled(mem.victim)) {
      const v = mem.victim;
      handled.add(v);
      if (theyOffered(v) && (tookSomething(v) || losing(v))) await endWar(v, 'ceasefire_accept');
      else if (!warWith.get(v).ceasefire_by && (tookSomething(v) || losing(v))) await endWar(v, 'ceasefire_offer');
    }
  }

  // ---- a stalemate ends every war, whatever the personality -------------
  for (const [f, w] of warWith) {
    if (!stalled(f) || view.factions.get(f)?.status === 'monster') continue;
    handled.add(f);
    if (theyOffered(f)) await endWar(f, 'stalemate_accept');
    else if (!w.ceasefire_by) await endWar(f, 'stalemate_offer');
  }

  // ---- every other war: fight back, then make peace -------------------
  for (const [f, w] of warWith) {
    if (handled.has(f) || view.factions.get(f)?.status === 'monster') continue;
    if (theyOffered(f) && ageOf(f) >= PEACE_AFTER) await endWar(f, 'peace_accept');
    else if (!w.ceasefire_by && ageOf(f) >= PEACE_OFFER) await endWar(f, 'peace_offer');
  }

  // The view was read before this turn's declarations: add them.
  const foes = new Set(view.enemiesOf(me).filter(standing));
  for (const [f, w] of warWith) if (w.declared_by === me && w.declared_at_tick === tick) foes.add(f);
  return { foes, force, mem };
}

/** How it votes: for itself, for its friends, against its enemies. */
export function voteFor(p, ctx) {
  const { me, human, personality, enemies, mem, tick } = ctx;
  if (p.proposer_faction_id === me) return 'yea';
  let payload = {};
  try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
  const target = payload?.target_faction_id ?? null;
  if (target === me) return 'nay';
  const wronged = (f) => (mem.grudge[f] ?? -1) > tick;
  const friendOf = (f) => !!f && !enemies.has(f) && !wronged(f)
    && (personality === 'ally' || (personality === 'snake' && mem.victim !== f));
  if (friendOf(p.proposer_faction_id)) return 'yea';
  if (target && friendOf(target)) return 'nay';
  if (target && enemies.has(target)) return 'yea';
  if (p.proposer_faction_id && enemies.has(p.proposer_faction_id)) return 'nay';
  if (personality === 'warlord' && human) {
    if (p.proposer_faction_id === human) return 'nay';
    if (target === human) return 'yea';
  }
  // A chancellor bid can end the game: only a friend's gets its vote.
  if (p.kind === 'chancellor_vote') return friendOf(p.proposer_faction_id) ? 'yea' : 'nay';
  return 'abstain';
}
