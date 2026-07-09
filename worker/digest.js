// ============================================================
// Daily Discord digest — "The Orbital Herald"
//
// Reads chronicle_entries since the last digest, CLUSTERS them into
// narrative stories (one battle, not six identical "X lost a ship"
// lines), and renders each story from a phrase bank so the same day
// never reads twice the same way. Posts a Discord embed styled as an
// in-world news bulletin.
//
// Wiring:
//   - env.DISCORD_DIGEST_WEBHOOK  (worker secret) — the webhook URL.
//     No secret set = digest silently disabled.
//   - maybeRunDailyDigest(env) is called from the every-minute cron
//     in worker/index.js. Self-gates: fires only when the UTC hour
//     matches DIGEST_HOUR_UTC and the game hasn't been digested in
//     the last ~20 hours (idempotent across cron re-fires).
//   - runDigestForGame(env, game, { force }) is the shared per-game
//     worker; { force: true } is used by the host's "Publish Herald
//     Now" button (worker/actions.js handleDigestNow) to bypass the
//     interval gate and always post something, even a quiet-day edition.
//   - digest_state table (migration 0034) tracks the per-game
//     high-water mark so each digest covers exactly the window since
//     the previous one.
// ============================================================

const DIGEST_HOUR_UTC = 21;
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Stories per section before we clamp to "...and N more incidents". */
const MAX_STORIES_PER_SECTION = 4;

// ------------------------------------------------------------
// Prose helpers
// ------------------------------------------------------------

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function numWord(n) { return n >= 0 && n <= 12 ? NUMBER_WORDS[n] : String(n); }
function shipsWord(n) { return n === 1 ? 'ship' : 'ships'; }
function plural(n, word, pluralWord) { return n === 1 ? word : (pluralWord ?? `${word}s`); }

/** Oxford-joined, italicized name list. Caps at `max`, tail becomes
 *  "...and N more" rather than a run-on sentence. Returns null for
 *  an empty list so callers can cleanly omit the clause. */
function nameList(names, max = 2) {
  const uniq = [...new Set((names || []).filter(Boolean))];
  if (uniq.length === 0) return null;
  const shown = uniq.slice(0, max).map(n => `*${n}*`);
  if (uniq.length <= max) {
    if (shown.length === 1) return shown[0];
    if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
    return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  }
  return `${shown.join(', ')}, and ${uniq.length - max} more`;
}

/** Picks a template, preferring one not already used this edition
 *  (tracked per bank-name in `used`) so two stories of the same shape
 *  in one report don't read identically. Falls back to a pure random
 *  pick once the bank is exhausted. */
function pickTemplate(bankName, bank, used) {
  if (bank.length === 1) return bank[0];
  let set = used.get(bankName);
  if (!set) { set = new Set(); used.set(bankName, set); }
  if (set.size >= bank.length) set.clear();      // exhausted — recycle
  for (let tries = 0; tries < 8; tries++) {
    const i = Math.floor(Math.random() * bank.length);
    if (!set.has(i)) { set.add(i); return bank[i]; }
  }
  return bank[Math.floor(Math.random() * bank.length)];
}

function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

// ------------------------------------------------------------
// Phrase banks — each entry is (ctx) => string. Grouped by story
// shape. Deliberately generous: the more variants, the longer this
// runs before a playtest group notices a repeat.
// ------------------------------------------------------------

const BATTLE_ONE_SIDED_KNOWN = [
  c => `${c.loser} was routed at ${c.body} today — ${numWord(c.count)} ${shipsWord(c.count)} lost to ${c.winner}${c.namesClause}.`,
  c => `A hard day for ${c.loser}: ${c.winner} forces destroyed ${numWord(c.count)} of their ${shipsWord(c.count)} in the skies over ${c.body}${c.namesClause}.`,
  c => `${c.winner} pressed the attack at ${c.body}, leaving ${c.loser} with ${numWord(c.count)} fewer ${shipsWord(c.count)} to their name${c.namesClause}.`,
  c => `The wreckage of ${numWord(c.count)} ${c.loser} ${shipsWord(c.count)} now drifts around ${c.body} after an engagement with ${c.winner}${c.namesClause}.`,
  c => `${c.loser} suffered a costly defeat near ${c.body}; ${c.winner} accounted for all ${numWord(c.count)} losses${c.namesClause}.`,
  c => `No mercy at ${c.body} — ${c.winner} sent ${numWord(c.count)} ${c.loser} ${shipsWord(c.count)} to the void${c.namesClause}.`,
  c => `${c.winner} claimed a decisive victory over ${c.loser} in the skies above ${c.body}, downing ${numWord(c.count)} vessels${c.namesClause}.`,
  c => `Reports from ${c.body} confirm ${c.loser} lost ${numWord(c.count)} ${shipsWord(c.count)} to ${c.winner} in a one-sided clash${c.namesClause}.`,
  c => `${c.loser}'s presence at ${c.body} was shattered by ${c.winner} — ${numWord(c.count)} ${shipsWord(c.count)} confirmed destroyed${c.namesClause}.`,
  c => `The skies over ${c.body} ran red for ${c.loser} today, with ${c.winner} claiming ${numWord(c.count)} kill${c.count === 1 ? '' : 's'}${c.namesClause}.`,
];

const BATTLE_ONE_SIDED_UNKNOWN = [
  c => `${c.loser} lost ${numWord(c.count)} ${shipsWord(c.count)} near ${c.body} under circumstances that remain unclear${c.namesClause}.`,
  c => `Distress signals went silent over ${c.body} — ${c.loser} confirms ${numWord(c.count)} ${shipsWord(c.count)} destroyed, cause unknown${c.namesClause}.`,
  c => `${c.loser} reports ${numWord(c.count)} ${shipsWord(c.count)} lost at ${c.body}. No attacker has claimed responsibility${c.namesClause}.`,
  c => `Wreckage at ${c.body}: ${numWord(c.count)} ${c.loser} ${shipsWord(c.count)} gone, and no one is talking${c.namesClause}.`,
];

const BATTLE_MUTUAL = [
  c => `A fierce engagement erupted over ${c.body} between ${c.factionA} and ${c.factionB}. When the dust settled, ${c.factionA} had lost ${numWord(c.countA)} ${shipsWord(c.countA)}${c.namesAClause}, while ${c.factionB} counted ${numWord(c.countB)} of their own destroyed${c.namesBClause}.`,
  c => `${c.body} became a battlefield today as ${c.factionA} and ${c.factionB} traded blows — ${numWord(c.countA)} ${c.factionA} ${shipsWord(c.countA)} down, ${numWord(c.countB)} from ${c.factionB}.`,
  c => `Neither side backed down at ${c.body}: ${c.factionA} lost ${numWord(c.countA)}, ${c.factionB} lost ${numWord(c.countB)}, and the standoff continues.`,
  c => `Mutual destruction at ${c.body} — ${c.factionA} (${numWord(c.countA)} ${shipsWord(c.countA)}) and ${c.factionB} (${numWord(c.countB)} ${shipsWord(c.countB)}) both paid a steep price.`,
  c => `The battle for ${c.body} has no clear victor: ${numWord(c.countA)} ${c.factionA} vessels and ${numWord(c.countB)} ${c.factionB} vessels now litter the wreckage field.`,
  c => `${c.factionA} and ${c.factionB} clashed violently over ${c.body}, each side counting their dead — ${numWord(c.countA)} and ${numWord(c.countB)} ${shipsWord(c.countA + c.countB)} respectively.`,
];

const BATTLE_CHAOS = [
  c => `${c.body} descended into chaos as ${numWord(c.sides.length)} factions clashed at once. Casualties: ${c.sideList}.`,
  c => `A free-for-all erupted at ${c.body} — ${c.sideList}.`,
  c => `No fewer than ${numWord(c.sides.length)} powers traded fire over ${c.body} today: ${c.sideList}.`,
  c => `The battle of ${c.body} drew in ${numWord(c.sides.length)} factions before it was over: ${c.sideList}.`,
];

const ASTEROID_IMPACT = [
  c => `${c.attacker ?? 'An unknown aggressor'} hurled a rock across the void, striking ${c.body} and scarring its surface for good.`,
  c => `An act of war: ${c.body} took a direct asteroid impact today, its yields crippled for the foreseeable future.`,
  c => `The skies fell silent, then ${c.body} was struck — ${c.attacker ?? 'the culprit'} claims the blow.`,
  c => `${c.body} bears fresh scars after an asteroid strike widely attributed to ${c.attacker ?? 'unknown forces'}.`,
  c => `A kinetic strike hit ${c.body} today, halving its productivity. ${c.attacker ? `${c.attacker} is believed responsible.` : 'No one has claimed the attack.'}`,
];

const INDUSTRY_BOTH = [
  c => `${c.faction}'s shipyards ran hot today — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} launched${c.shipNamesClause}, alongside ${numWord(c.buildCount)} completed construction project${plural(c.buildCount, '')}.`,
  c => `Industry hums for ${c.faction}: ${numWord(c.shipCount)} hulls rolled out${c.shipNamesClause} and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} finished.`,
  c => `${c.faction} expanded on every front today — new ships${c.shipNamesClause} and completed infrastructure alike.`,
];

const INDUSTRY_SHIPS_ONLY = [
  c => `${c.faction} launched ${numWord(c.count)} new ${shipsWord(c.count)} today${c.namesClause}.`,
  c => `Fresh hulls for ${c.faction}: ${numWord(c.count)} ${shipsWord(c.count)} rolled out of the yards${c.namesClause}.`,
  c => `${c.faction}'s shipyards delivered ${numWord(c.count)} vessel${plural(c.count, '')}${c.namesClause}.`,
  c => `The fleet of ${c.faction} grows — ${numWord(c.count)} ${shipsWord(c.count)} commissioned${c.namesClause}.`,
  c => `${numWord(c.count)} new ${shipsWord(c.count)} joined ${c.faction}'s ranks today${c.namesClause}.`,
  c => `${c.faction} rolled ${numWord(c.count)} new hull${plural(c.count, '')} off the line${c.namesClause}.`,
];

const INDUSTRY_BUILDINGS_ONLY = [
  c => `${c.faction} completed ${numWord(c.count)} construction project${plural(c.count, '')} today.`,
  c => `Infrastructure milestone for ${c.faction}: ${numWord(c.count)} upgrade${plural(c.count, '')} finished.`,
  c => `${c.faction}'s engineers finished ${numWord(c.count)} project${plural(c.count, '')} across their holdings.`,
  c => `Construction crews for ${c.faction} closed out ${numWord(c.count)} project${plural(c.count, '')}.`,
];

const COLONY_FOUNDED = [
  c => `${c.faction} broke ground on ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Expansion continues for ${c.faction} — ${numWord(c.count)} new outpost${plural(c.count, '')} established${c.entriesClause}.`,
  c => `${c.faction} planted ${numWord(c.count)} new flag${plural(c.count, '')} in the system${c.entriesClause}.`,
  c => `New territory for ${c.faction}: ${numWord(c.count)} settlement${plural(c.count, '')} founded${c.entriesClause}.`,
  c => `${c.faction}'s colonists made landfall — ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
];

const FACTION_ARRIVAL = [
  c => `${c.faction} has entered the system, establishing their capital at ${c.body}.`,
  c => `A new power rises: ${c.faction} stakes their claim at ${c.body}.`,
  c => `${c.faction} joins the fray, founding their homeworld on ${c.body}.`,
  c => `Newcomers to the system: ${c.faction} has arrived and settled at ${c.body}.`,
];

const DISCOVERY_LEADIN = [
  'Word from the frontier: ',
  'Scouts report: ',
  'A dispatch just in — ',
  'From the outer reaches: ',
  'Explorers have uncovered something: ',
  'Field notes from the edge of the system: ',
];

const TREATY_SIGNED = [
  c => `${c.a} and ${c.b} have signed ${c.pactName}, formalizing new terms between their peoples.`,
  c => `Diplomats rejoice: ${c.a} and ${c.b} inked ${c.pactName} today.`,
  c => `${c.a} and ${c.b} put pen to paper on ${c.pactName}.`,
  c => `A new accord: ${c.a} and ${c.b} have agreed to ${c.pactName}.`,
];

const TREATY_BROKEN = [
  c => `${c.a} tore up their pact with ${c.b} — the accord lies in ruins.`,
  c => `Diplomacy fails: ${c.a} has broken their treaty with ${c.b}.`,
  c => `The peace between ${c.a} and ${c.b} is over.`,
  c => `${c.a} has withdrawn from its agreement with ${c.b}, effective immediately.`,
];

const SENATE_PASSED = [
  c => `The Senate has passed "${c.title}" — the ${c.actor} delegation's motion carries.`,
  c => `By vote of the assembly, "${c.title}" is now law.`,
  c => `The chamber rules in favor: "${c.title}" passes.`,
];

const SENATE_FAILED = [
  c => `The Senate has rejected "${c.title}", proposed by ${c.actor}.`,
  c => `"${c.title}" fails to carry the chamber.`,
  c => `The assembly votes down "${c.title}".`,
];

const VICTORY = [
  c => `${c.faction} stands triumphant — victory is theirs.`,
  c => `The long campaign is over: ${c.faction} has won.`,
  c => `History remembers this day: ${c.faction} claims final victory.`,
  c => `It is finished. ${c.faction} rules the system.`,
  c => `${c.faction} has achieved what no other power could — total victory.`,
];

const ELIMINATION = [
  c => `${c.faction} has fallen. Their banners lie in the dust.`,
  c => `The story of ${c.faction} ends here.`,
  c => `${c.faction} has been eliminated from the system.`,
];

const TRADE_LEDGER = [
  c => `${c.count} freighter ${c.count === 1 ? 'delivery' : 'deliveries'} completed across all routes today.`,
  c => `The logistics corps moved ${c.count} shipment${plural(c.count, '')} safely to port.`,
  c => `${c.count} successful cargo run${plural(c.count, '')} recorded across the system.`,
  c => `Merchant fleets completed ${c.count} delivery run${plural(c.count, '')} today.`,
];

// ------------------------------------------------------------
// Story builders — cluster raw chronicle rows into narrative units
// per section, then render each via the phrase banks above.
// ------------------------------------------------------------

function buildBattleStories(rows, used) {
  const stories = [];

  // --- ship_destroyed + settlement_destroyed, clustered by body ---
  const byBody = new Map();
  for (const row of rows) {
    if (row.kind !== 'ship_destroyed' && row.kind !== 'settlement_destroyed') continue;
    const p = safeJson(row.payload);
    const bodyId = row.body_id ?? 'unknown';
    if (!byBody.has(bodyId)) byBody.set(bodyId, { body: p.body_name ?? 'deep space', losses: new Map() });
    const cluster = byBody.get(bodyId);
    const owner = p.owner_faction_name ?? 'An unknown faction';
    const killer = p.killer_faction_name ?? null;
    if (!cluster.losses.has(owner)) cluster.losses.set(owner, { shipNames: [], settlementNames: [], count: 0, killers: new Map() });
    const bucket = cluster.losses.get(owner);
    bucket.count += 1;
    if (row.kind === 'ship_destroyed' && p.ship_name) bucket.shipNames.push(p.ship_name);
    if (row.kind === 'settlement_destroyed' && p.settlement_name) bucket.settlementNames.push(p.settlement_name);
    bucket.killers.set(killer, (bucket.killers.get(killer) ?? 0) + 1);
  }

  for (const [, cluster] of byBody) {
    const victims = [...cluster.losses.keys()];
    // Killer(s) credited across all victims at this body (excluding null/unknown).
    const killerSet = new Set();
    for (const [, bucket] of cluster.losses) {
      for (const k of bucket.killers.keys()) if (k) killerSet.add(k);
    }

    if (victims.length === 1) {
      const [owner] = victims;
      const bucket = cluster.losses.get(owner);
      const winner = killerSet.size === 1 ? [...killerSet][0] : null;
      const names = nameList([...bucket.shipNames]);
      const ctx = {
        loser: owner, winner, body: cluster.body, count: bucket.count,
        namesClause: names ? `, including ${names}` : '',
      };
      const bank = winner ? BATTLE_ONE_SIDED_KNOWN : BATTLE_ONE_SIDED_UNKNOWN;
      let text = pickTemplate(winner ? 'battle_one_sided' : 'battle_unknown', bank, used)(ctx);
      if (bucket.settlementNames.length > 0) {
        const sNames = nameList(bucket.settlementNames, 2);
        text += ` The settlement${bucket.settlementNames.length > 1 ? 's' : ''} ${sNames} ${bucket.settlementNames.length > 1 ? 'were' : 'was'} also lost in the fighting.`;
      }
      stories.push(text);
    } else if (victims.length === 2 && killerSet.size === 2 && victims.every(v => killerSet.has(v))) {
      // Reciprocal: both victims are also credited as killers of the other — a real mutual battle.
      const [a, b] = victims;
      const bucketA = cluster.losses.get(a);
      const bucketB = cluster.losses.get(b);
      const namesA = nameList(bucketA.shipNames);
      const namesB = nameList(bucketB.shipNames);
      const ctx = {
        factionA: a, countA: bucketA.count, namesAClause: namesA ? ` (${namesA})` : '',
        factionB: b, countB: bucketB.count, namesBClause: namesB ? ` (${namesB})` : '',
        body: cluster.body,
      };
      stories.push(pickTemplate('battle_mutual', BATTLE_MUTUAL, used)(ctx));
    } else {
      // 3+ factions, or an asymmetric shape — describe as chaos.
      const sides = victims
        .map(v => ({ faction: v, count: cluster.losses.get(v).count }))
        .sort((a, b) => b.count - a.count);
      const sideList = sides.map(s => `${s.faction} lost ${numWord(s.count)}`).join('; ');
      stories.push(pickTemplate('battle_chaos', BATTLE_CHAOS, used)({ body: cluster.body, sides, sideList }));
    }
  }

  // --- asteroid impacts: always their own dramatic mini-story ---
  for (const row of rows) {
    if (row.kind !== 'asteroid_impact') continue;
    const p = safeJson(row.payload);
    const attacker = p.attacker_faction_name ?? null; // not currently stored, kept forward-compat
    const ctx = { attacker, body: p.target_name ?? row.body_id ?? 'a nearby world' };
    stories.push(pickTemplate('asteroid_impact', ASTEROID_IMPACT, used)(ctx));
  }

  return stories;
}

function buildIndustryStories(rows, used) {
  const byFaction = new Map();
  for (const row of rows) {
    if (row.kind !== 'ship_built' && row.kind !== 'building_completed') continue;
    const p = safeJson(row.payload);
    const faction = p.owner_faction_name ?? 'An unknown faction';
    if (!byFaction.has(faction)) byFaction.set(faction, { ships: [], builds: [] });
    const bucket = byFaction.get(faction);
    if (row.kind === 'ship_built' && p.ship_name) bucket.ships.push(p.ship_name);
    if (row.kind === 'building_completed') bucket.builds.push(p.building_kind ?? 'upgrade');
  }

  const stories = [];
  for (const [faction, bucket] of byFaction) {
    const shipCount = bucket.ships.length;
    const buildCount = bucket.builds.length;
    if (shipCount === 0 && buildCount === 0) continue;
    const shipNames = nameList(bucket.ships);
    const shipNamesClause = shipNames ? ` — ${shipNames}` : '';
    if (shipCount > 0 && buildCount > 0) {
      stories.push(pickTemplate('industry_both', INDUSTRY_BOTH, used)({ faction, shipCount, buildCount, shipNamesClause }));
    } else if (shipCount > 0) {
      stories.push(pickTemplate('industry_ships', INDUSTRY_SHIPS_ONLY, used)({ faction, count: shipCount, namesClause: shipNamesClause }));
    } else {
      stories.push(pickTemplate('industry_builds', INDUSTRY_BUILDINGS_ONLY, used)({ faction, count: buildCount }));
    }
  }
  return stories;
}

function buildColonyStories(rows, used) {
  const stories = [];

  const byFaction = new Map();
  for (const row of rows) {
    if (row.kind !== 'settlement_built') continue;
    const p = safeJson(row.payload);
    const faction = p.owner_faction_name ?? 'An unknown faction';
    if (!byFaction.has(faction)) byFaction.set(faction, []);
    byFaction.get(faction).push({ name: p.settlement_name, body: p.body_name, type: p.settlement_type });
  }
  for (const [faction, entries] of byFaction) {
    const bodyNames = nameList(entries.map(e => e.body));
    const entriesClause = bodyNames ? ` at ${bodyNames}` : '';
    stories.push(pickTemplate('colony_founded', COLONY_FOUNDED, used)({ faction, count: entries.length, entriesClause }));
  }

  for (const row of rows) {
    if (row.kind !== 'faction_joined') continue;
    const p = safeJson(row.payload);
    stories.push(pickTemplate('faction_arrival', FACTION_ARRIVAL, used)({
      faction: p.name ?? 'A new faction',
      body: p.capital_name ?? 'an unclaimed world',
    }));
  }

  return stories;
}

function buildDiscoveryStories(rows, used) {
  const stories = [];
  for (const row of rows) {
    if (row.kind !== 'secret_discovered') continue;
    const p = safeJson(row.payload);
    const raw = typeof p.message === 'string' ? p.message : null;
    if (!raw) continue;
    const m = raw.match(/^(.+?):\s*DISCOVERY\s*—\s*(.+)$/);
    const leadIn = pickTemplate('discovery_leadin', DISCOVERY_LEADIN, used);
    if (m) {
      stories.push(`${leadIn}at ${m[1]}, ${m[2]}`);
    } else {
      stories.push(`${leadIn}${raw}`);
    }
  }
  return stories;
}

function buildPoliticsStories(rows, used, factionNames) {
  const stories = [];
  const nameOf = (id) => factionNames.get(id) ?? 'an unnamed faction';

  const PACT_NAMES = {
    defense_pact: 'a defense pact',
    nap: 'a non-aggression pact',
    trade_agreement: 'a trade agreement',
  };

  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'treaty_signed') {
      stories.push(pickTemplate('treaty_signed', TREATY_SIGNED, used)({
        a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id),
        pactName: PACT_NAMES[p.kind] ?? 'a treaty',
      }));
    } else if (row.kind === 'treaty_broken') {
      stories.push(pickTemplate('treaty_broken', TREATY_BROKEN, used)({
        a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id),
      }));
    } else if (row.kind === 'senate_vote') {
      const bank = p.outcome === 'passed' ? SENATE_PASSED : SENATE_FAILED;
      stories.push(pickTemplate(`senate_${p.outcome}`, bank, used)({
        title: p.title ?? 'a motion', actor: nameOf(row.actor_faction_id),
      }));
    }
  }
  return stories;
}

function buildVictoryStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'victory') {
      if (typeof p.detail === 'string' && p.detail.length > 0) {
        stories.push(`${p.detail}.`);
      } else {
        stories.push(pickTemplate('victory', VICTORY, used)({ faction: factionNames.get(row.actor_faction_id) ?? 'A faction' }));
      }
    } else if (row.kind === 'faction_eliminated') {
      stories.push(pickTemplate('elimination', ELIMINATION, used)({ faction: factionNames.get(row.actor_faction_id) ?? 'A faction' }));
    }
  }
  return stories;
}

// ------------------------------------------------------------
// Embed assembly
// ------------------------------------------------------------

const SECTION_META = {
  battles:     { title: '⚔️  From the front lines', color: 0xff5e5e },
  colonies:    { title: '🏙️  Expansion report',     color: 0x4ecdc4 },
  discoveries: { title: '✨  Dispatches from deep space', color: 0x67e8f9 },
  industry:    { title: '🏗️  Industry & shipping',  color: 0xffb84d },
  politics:    { title: '🏛️  Halls of the Senate',  color: 0xc4b5fd },
  victory:     { title: '👑  History in the making', color: 0xffd700 },
};

function fieldFromStories(title, stories) {
  if (stories.length === 0) return null;
  const shown = stories.slice(0, MAX_STORIES_PER_SECTION);
  const more = stories.length - shown.length;
  let value = shown.join('\n\n');
  if (more > 0) value += `\n\n…and ${more} more incident${more === 1 ? '' : 's'} to report.`;
  if (value.length > 1020) value = value.slice(0, 1017) + '…';
  return { name: title, value };
}

/** Build the embed for one game. Returns null when the day was
 *  entirely uneventful (no stories + no trades) so we skip the post
 *  rather than spam "nothing happened". */
function composeEmbed(gameName, tick, rows, factionNames, tradesDelta) {
  const used = new Map(); // bank-name -> Set(indices used this edition)

  const sections = {
    victory:     buildVictoryStories(rows, used, factionNames),
    battles:     buildBattleStories(rows, used),
    politics:    buildPoliticsStories(rows, used, factionNames),
    discoveries: buildDiscoveryStories(rows, used),
    colonies:    buildColonyStories(rows, used),
    industry:    buildIndustryStories(rows, used),
  };

  const fields = [];
  for (const key of ['victory', 'battles', 'politics', 'discoveries', 'colonies', 'industry']) {
    const field = fieldFromStories(SECTION_META[key].title, sections[key]);
    if (field) fields.push(field);
  }

  if (tradesDelta > 0) {
    fields.push({ name: '📦  Trade ledger', value: pickTemplate('trade_ledger', TRADE_LEDGER, used)({ count: tradesDelta }) });
  }

  if (fields.length === 0) return null;

  const color = sections.victory.length > 0 ? SECTION_META.victory.color
    : sections.battles.length > 0 ? SECTION_META.battles.color
    : SECTION_META.colonies.color;

  return {
    title: `🗞️  The Orbital Herald — ${gameName}`,
    description: `*All the news from tick T+${tick}. Reporting from across the system.*`,
    color,
    fields,
    footer: { text: 'Daily digest · The Orbital Herald' },
    timestamp: new Date().toISOString(),
  };
}

// ------------------------------------------------------------
// Entry points
// ------------------------------------------------------------

/**
 * Digest one game. Shared by the daily cron and the host's
 * "publish now" button.
 *
 * @param game  { id, current_tick, name }
 * @param opts.force  true = skip the once-per-day interval gate AND
 *   post a "quiet day" edition when there's nothing to report (the
 *   button should always visibly do something); the cron leaves both
 *   behaviors off.
 * @returns {posted: boolean, events: number, reason?: string}
 */
export async function runDigestForGame(env, game, { force = false } = {}) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return { posted: false, events: 0, reason: 'webhook_not_configured' };

  const now = Date.now();
  const state = await env.DB
    .prepare('SELECT last_digest_ms, last_entry_ms, trades_snapshot FROM digest_state WHERE game_id = ?')
    .bind(game.id)
    .first();
  const lastDigestMs = state?.last_digest_ms ?? 0;
  if (!force && now - lastDigestMs < MIN_INTERVAL_MS) {
    return { posted: false, events: 0, reason: 'already_ran_today' };
  }

  const sinceMs = state?.last_entry_ms || (now - FIRST_RUN_LOOKBACK_MS);

  // Public entries only — the digest goes to a shared channel, so
  // faction-scoped intel (visibility = JSON array) must not leak.
  // body_id is pulled so battle stories can cluster by location.
  const rows = (await env.DB
    .prepare(
      `SELECT kind, actor_faction_id, target_faction_id, body_id, payload, created_at_ms
         FROM chronicle_entries
        WHERE game_id = ? AND created_at_ms > ? AND visibility = 'public'
        ORDER BY created_at_ms ASC
        LIMIT 200`,
    )
    .bind(game.id, sinceMs)
    .all()).results ?? [];

  const factions = (await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
    .bind(game.id)
    .all()).results ?? [];
  const factionNames = new Map(factions.map(f => [f.id, f.name]));

  const tradesNow = (await env.DB
    .prepare(`SELECT COALESCE(SUM(trades_completed), 0) AS n
                FROM game_ships WHERE game_id = ? AND status = 'active'`)
    .bind(game.id)
    .first())?.n ?? 0;
  const tradesDelta = Math.max(0, tradesNow - (state?.trades_snapshot ?? tradesNow));

  let embed = composeEmbed(game.name ?? game.id, game.current_tick ?? 0, rows, factionNames, tradesDelta);

  // Forced editions always publish — a quiet day gets a short
  // "all quiet" bulletin so the host's test button visibly works.
  if (!embed && force) {
    embed = {
      title: `🗞️  The Orbital Herald — ${game.name ?? game.id}`,
      description: `*Special edition, tick T+${game.current_tick ?? 0}.*\n\nAll quiet across the system. No battles, no new colonies, no discoveries to report since the last edition. The presses idle; the void abides.`,
      color: SECTION_META.colonies.color,
      footer: { text: 'Host-triggered edition · The Orbital Herald' },
      timestamp: new Date().toISOString(),
    };
  }

  // Advance the high-water mark whether or not we post — a fully
  // quiet day should not accumulate into tomorrow's window as
  // "yesterday's news".
  const maxEntryMs = rows.length > 0 ? rows[rows.length - 1].created_at_ms : now;
  await env.DB
    .prepare(
      `INSERT INTO digest_state (game_id, last_digest_ms, last_entry_ms, trades_snapshot)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         last_digest_ms = excluded.last_digest_ms,
         last_entry_ms = excluded.last_entry_ms,
         trades_snapshot = excluded.trades_snapshot`,
    )
    .bind(game.id, now, maxEntryMs, tradesNow)
    .run();

  if (!embed) return { posted: false, events: rows.length, reason: 'quiet_day' };

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    console.error(`digest webhook post failed for ${game.id}: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, events: rows.length, reason: `webhook_${res.status}` };
  }
  return { posted: true, events: rows.length };
}

/**
 * Entry point — called from the every-minute cron. Cheap early-outs:
 * no webhook secret, wrong hour, or already digested recently.
 */
export async function maybeRunDailyDigest(env) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return;                              // feature off

  const now = Date.now();
  if (new Date(now).getUTCHours() !== DIGEST_HOUR_UTC) return;

  const games = (await env.DB
    .prepare(`SELECT g.id, g.current_tick, r.name
                FROM games g JOIN rooms r ON r.id = g.id
               WHERE g.status = 'active'`)
    .all()).results ?? [];

  for (const game of games) {
    try {
      await runDigestForGame(env, game, { force: false });
    } catch (e) {
      // One game's digest failure must not block the others.
      console.error(`daily digest failed for game ${game.id}`, e);
    }
  }
}
