// ============================================================
// Slider laws — from a passed bill through to a charged ship.
//
// Exists because of a player report that read as a correctness bug and
// turned out to be an ANNOUNCEMENT bug: a ship_build_cost_multiplier law
// passed at 0.5, the server genuinely charged half price, and every
// surface a player could see kept quoting the full price. There was no
// "law passed" post in Discord, no laws-in-force list in the senate, and
// the build menu rendered SHIP_CLASSES base costs with no multiplier at
// all. Three separate silences over a system that was working.
//
// So this sim asserts the whole chain, not just the arithmetic:
//   1. a passed slider law writes an active senate_effects row
//   2. activeLaws() reports it (the in-game surface)
//   3. buildCostFactors() folds it into what a hull costs
//   4. resolveSenate ATTEMPTS a Discord result post
//
// (4) is the one worth explaining. Every Discord call in the tick is
// wrapped in try/catch by design — an outage must not fail a resolution
// already written to D1 — which means a ReferenceError in that block
// (the `discord` free-identifier trap this codebase has hit repeatedly)
// would be swallowed and look exactly like success. The stub fetch below
// records calls so "we tried" is an assertion rather than an assumption.
//
// Run: npm run sim:laws
// ============================================================

import { seedGameWorld } from '../worker/factions.js';
import {
  resolveSenate, activeLaws, getActiveSliders,
  describeSlider, phraseTableFor, SLIDER_CATALOG,
} from '../worker/senate.js';
import { buildCostFactors } from '../worker/buildCost.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

/** Records every outbound Discord call so the test can assert the tick
 *  reached the publisher instead of silently catching its way past it. */
function stubDiscord(env) {
  const calls = [];
  env.DISCORD_BOT_TOKEN = 'stub-token';
  // channelForGame() needs BOTH a channel and at least one linked player
  // (gameHasDiscordAudience), or every publisher returns 'no_channel'
  // and the assertions below would pass against a bot that never fired.
  env.DISCORD_CHANNEL_ID = 'c1';
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = JSON.parse(init?.body ?? 'null'); } catch { /* multipart etc. */ }
    calls.push({ url: String(url), method: init?.method ?? 'GET', body });
    return new Response(JSON.stringify({ id: `msg_${calls.length}` }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

async function seed(players = 4, gameId = 'glaw') {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Law Test','host',0,0)`).bind(gameId).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms)
                    VALUES (?, 'setup','law-seed',0,0,3600000)`).bind(gameId).run();
  for (let i = 0; i < players; i++) {
    const uid = i === 0 ? 'host' : `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at)
                      VALUES (?,?,?)`).bind(gameId, uid, i).run();
  }
  await seedGameWorld(env, gameId);
  const factionIds = ((await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(gameId).all()).results ?? [])
    .map(r => r.id);
  // The colour sim once passed against a game with ZERO factions because
  // seedGameWorld early-returns on the wrong status. Never again.
  check('seed produced factions', factionIds.length === players, `got ${factionIds.length}`);
  return { env, DB, gameId, factionIds };
}

/** Put a slider bill on the floor with `voters` voting yea, then run the
 *  tick that closes it. */
async function passLaw(env, DB, gameId, id, sliderId, value, voters, target = null) {
  await DB.prepare(
    `INSERT INTO senate_proposals
      (id, game_id, proposer_faction_id, kind, title, summary, payload, status,
       proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick, debate_ticks, vote_ticks)
     VALUES (?, ?, ?, 'slider_law', ?, 'summary', ?, 'voting', 0, 0, 5, 6, 6)`,
  ).bind(
    id, gameId, voters[0], "Let's get to work!",
    JSON.stringify({ slider_id: sliderId, target_value: value, target_faction_id: target }),
  ).run();
  for (const f of voters) {
    await DB.prepare(`INSERT INTO senate_votes (proposal_id,faction_id,vote,weight,cast_at_tick)
                      VALUES (?,?,'yea',1,0)`).bind(id, f).run();
  }
  await DB.prepare(`UPDATE games SET current_tick = 5 WHERE id = ?`).bind(gameId).run();
  await resolveSenate(env, gameId, 5);
}

async function main() {
  const { env, DB, gameId, factionIds } = await seed(4);
  const calls = stubDiscord(env);
  await DB.prepare(`UPDATE users SET discord_id = 'd_host' WHERE id = 'host'`).run();

  // 3 of 4 vote yea: over the majority-of-living-factions quorum bar.
  await passLaw(env, DB, gameId, 'p_build', 'ship_build_cost_multiplier', 0.5,
    factionIds.slice(0, 3));

  const prop = await DB.prepare(`SELECT status, effect_until_tick FROM senate_proposals WHERE id='p_build'`).first();
  check('bill passed', prop?.status === 'passed', prop?.status);

  // --- 1. the effect row ---
  const eff = await DB.prepare(
    `SELECT slider_id, value, effect_kind, active_from_tick, active_until_tick
       FROM senate_effects WHERE game_id = ?`).bind(gameId).first();
  check('slider effect row written', !!eff, 'no row');
  check('effect carries the voted value', Number(eff?.value) === 0.5, eff?.value);
  check('effect is live at the resolving tick',
    Number(eff?.active_from_tick) <= 5 && Number(eff?.active_until_tick) > 5,
    `${eff?.active_from_tick}..${eff?.active_until_tick}`);

  // --- 2. the in-game surface ---
  const laws = await activeLaws(env, gameId, 5);
  check('activeLaws reports exactly one law', laws.length === 1, laws.length);
  const law = laws[0] ?? {};
  check('law is NAMED, not described by its knob',
    law.law_name === 'Cheaper Ships', law.law_name);
  check('law says what it does in a sentence',
    law.effect_text === 'Ships cost 50% less to build.', law.effect_text);
  check('law carries the plain topic', law.label === 'Cost of building ships', law.label);
  check('law reads as −50%', law.delta_pct === -50, law.delta_pct);
  check('law carries the bill title people argued over',
    law.proposal_title === "Let's get to work!", law.proposal_title);
  check('law counts down', law.ticks_left > 0, law.ticks_left);
  check('general law has no target', law.target_faction_id === null, law.target_faction_id);

  // --- 3. what a hull actually costs ---
  const sliders = await getActiveSliders(env, gameId, 5, factionIds[0]);
  check('resolver sees the multiplier',
    Number(sliders.ship_build_cost_multiplier) === 0.5, sliders.ship_build_cost_multiplier);
  const factors = await buildCostFactors(env, gameId, factionIds[0], 5);
  check('buildCostFactors.law is the law', factors.law === 0.5, factors.law);
  check('buildCostFactors.mult halves the price', factors.mult === 0.5, factors.mult);
  // A 60M hull must quote 30M, using the server's own scale-then-ceil.
  check('a 60M hull quotes 30M', Math.ceil(60 * factors.mult) === 30,
    Math.ceil(60 * factors.mult));

  // --- 4. Discord actually got told ---
  // The free-identifier trap: `discord` was a block-local dynamic import
  // in sibling blocks, so a bare `discord.publishSenateResolved(...)`
  // bundles fine and throws only at runtime — straight into a catch.
  const posts = calls.filter(c => c.method === 'POST' && c.url.includes('/messages'));
  const titles = posts.map(c => c.body?.embeds?.[0]?.title ?? '').filter(Boolean);
  check('a result card was posted', posts.length > 0,
    `${calls.length} discord calls, none a message POST`);
  check('the card announces ratification',
    titles.some(t => t.startsWith('✅')), JSON.stringify(titles));

  // --- 5. after the window, the law is gone ---
  const until = Number(eff?.active_until_tick ?? 0);
  await DB.prepare(`UPDATE games SET current_tick = ? WHERE id = ?`).bind(until, gameId).run();
  await resolveSenate(env, gameId, until);
  const after = await activeLaws(env, gameId, until);
  check('law drops out of activeLaws once its window closes', after.length === 0, after.length);
  const lapsedFactors = await buildCostFactors(env, gameId, factionIds[0], until);
  check('price returns to base after the law lapses', lapsedFactors.mult === 1, lapsedFactors.mult);
  const lapseTitles = calls
    .filter(c => c.method === 'POST' && c.url.includes('/messages'))
    .map(c => c.body?.embeds?.[0]?.title ?? '');
  check('the lapse was announced too',
    lapseTitles.some(t => t.startsWith('⌛')), JSON.stringify(lapseTitles));

  // --- 6. a targeted law names its target ---
  const { env: e2, DB: d2, gameId: g2, factionIds: f2 } = await seed(4, 'glaw2');
  stubDiscord(e2);
  await d2.prepare(`UPDATE users SET discord_id = 'd_host' WHERE id = 'host'`).run();
  await passLaw(e2, d2, g2, 'p_tgt', 'metal_yield_multiplier', 0.5, f2.slice(0, 3), f2[3]);
  const tLaws = await activeLaws(e2, g2, 5);
  const tgt = tLaws.find(l => l.target_faction_id);
  check('targeted law records its target', !!tgt, JSON.stringify(tLaws.map(l => l.slider_id)));
  check('targeted law carries the target name', !!tgt?.target_name, tgt?.target_name);

  // --- 7. plain language, enforced ---
  //
  // Reading level is a specification here, not a preference, so it gets
  // assertions rather than a code review. The failure this guards is a
  // slow one: someone adds a slider, copies the shape of the entry above
  // it, forgets the PLAIN_LAW row, and the surface silently falls back
  // to printing a column name again — which is exactly the defect this
  // pass existed to remove.
  const JARGON = [
    'multiplier', 'modifier', 'slider', 'yield', 'upkeep',
    'faction_id', 'per-tick', 'scales', '_',
  ];
  for (const def of SLIDER_CATALOG) {
    const lo = describeSlider(def.id, def.min);
    const hi = describeSlider(def.id, def.max);
    const mid = describeSlider(def.id, def.default);
    check(`${def.id}: has plain wording at both ends`, !!lo && !!hi,
      `${lo ? '' : 'min missing '}${hi ? '' : 'max missing'}`);
    if (!lo || !hi || !mid) continue;

    // The two directions must be DIFFERENT laws. A single name covering
    // both ends means the player can't tell from the headline whether
    // the bill helps or hurts them.
    check(`${def.id}: the two directions are named differently`,
      lo.name !== hi.name, `${lo.name} / ${hi.name}`);
    check(`${def.id}: the default is flagged as doing nothing`,
      mid.at_default && mid.name === 'No Change', `${mid.name} ${mid.at_default}`);

    for (const [end, said] of [['min', lo], ['max', hi]]) {
      const text = `${said.name} ${said.effect}`.toLowerCase();
      const found = JARGON.filter(w => text.includes(w));
      check(`${def.id} @${end}: no jargon in "${said.name} — ${said.effect}"`,
        found.length === 0, `contains ${found.join(', ')}`);
      // A sentence, so it can be dropped into running prose anywhere.
      check(`${def.id} @${end}: effect is a sentence`,
        /^[A-Z].*\.$/.test(said.effect), said.effect);
    }

    // The topic name is what the composer's picker shows. Same rule.
    const label = def.label.toLowerCase();
    check(`${def.id}: topic name is plain ("${def.label}")`,
      !JARGON.some(w => w !== 'yield' && w !== 'upkeep' && label.includes(w)), def.label);
  }

  // Every step of every slider must have wording — the composer looks
  // phrases up by value and shows a bare number when the lookup misses.
  for (const def of SLIDER_CATALOG) {
    const step = def.step > 0 ? def.step : 1;
    const steps = Math.round((def.max - def.min) / step);
    let missing = 0;
    for (let i = 0; i <= steps; i++) {
      const v = Math.round((def.min + i * step) * 1000) / 1000;
      if (!describeSlider(def.id, v)) missing++;
    }
    check(`${def.id}: all ${steps + 1} reachable values are worded`,
      missing === 0, `${missing} missing`);
  }

  // --- 8. the composer can actually FIND the wording ---
  //
  // The phrase table is keyed by value-as-string, and the browser looks
  // it up from a range input's value. Float steps are the trap: the
  // server writing "0.7000000000000001" or the client asking for it
  // means every lookup misses and the composer silently degrades to
  // "Sets the value to 0.7" — the exact codery phrasing being removed
  // here, reappearing through a rounding mismatch nobody would notice.
  //
  // This reproduces the CLIENT's key expression (lawPhrase in
  // SenatePanel.tsx) against the SERVER's table for every step a range
  // input can actually land on.
  for (const def of SLIDER_CATALOG) {
    const table = phraseTableFor(def);
    const step = def.step > 0 ? def.step : 1;
    const steps = Math.round((def.max - def.min) / step);
    let miss = 0; let firstMiss = null;
    for (let i = 0; i <= steps; i++) {
      // What the browser hands back: min + i*step, unrounded.
      const fromInput = def.min + i * step;
      const key = String(Math.round(fromInput * 1000) / 1000);
      if (!table[key]) { miss++; firstMiss ??= `${fromInput} -> "${key}"`; }
    }
    check(`${def.id}: every drag position finds its wording`,
      miss === 0, `${miss} misses, first ${firstMiss}`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
