// ============================================================
// Daily Discord digest — "The Orbital Herald"
//
// Reads chronicle_entries since the last digest, CLUSTERS them into
// narrative stories (one battle, not six identical "X lost a ship"
// lines), WEIGHS each story by newsworthiness, and leads with the
// biggest one as a real newspaper-style ALL-CAPS headline — the embed
// title, not buried in a bullet list. Everything else follows below
// as "in other news," rendered from the same phrase banks so the
// same day never reads twice the same way.
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

/** Battle newsworthiness: casualty count first, shape second. A
 *  6-ship one-sided massacre must always outrank a 2-ship mutual
 *  skirmish, so all three battle shapes (one-sided/mutual/chaos)
 *  share this exact formula rather than each having its own base. */
const BATTLE_BASE_WEIGHT = 380;
const BATTLE_PER_CASUALTY = 20;

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

/** Builds a story object: renders BOTH a body sentence (narrative
 *  bank) and a short ALL-CAPS headline (headline bank) from the same
 *  context, tags it with a newsworthiness weight (+ small jitter so
 *  equal-weight days don't always crown the same kind of story), and
 *  returns { text, headline, weight }. `text` gets `extra` appended
 *  verbatim (used for the "settlement also lost" trailing clause). */
function mkStory(baseWeight, used, narrativeBankName, narrativeBank, headlineBankName, headlineBank, ctx, extra = '') {
  const text = pickTemplate(narrativeBankName, narrativeBank, used)(ctx) + extra;
  const headline = pickTemplate(headlineBankName, headlineBank, used)(ctx);
  return { text, headline, weight: baseWeight + Math.random() };
}

// ------------------------------------------------------------
// Phrase banks — narrative (sentence, body copy) paired with headline
// (short ALL-CAPS, front-page style) for every story shape. Each
// entry is (ctx) => string. Deliberately generous: the more variants,
// the longer this runs before a playtest group notices a repeat.
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

const BATTLE_ONE_SIDED_KNOWN_HEADLINE = [
  c => `${c.loser.toUpperCase()} ROUTED AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} CRUSHES ${c.loser.toUpperCase()} FLEET AT ${c.body.toUpperCase()}`,
  c => `${numWord(c.count).toUpperCase()} ${c.loser.toUpperCase()} ${shipsWord(c.count).toUpperCase()} DOWN IN ${c.body.toUpperCase()} AMBUSH`,
  c => `BLOODBATH AT ${c.body.toUpperCase()}: ${c.loser.toUpperCase()} DECIMATED`,
  c => `${c.winner.toUpperCase()} DOMINANT IN ${c.body.toUpperCase()} STRIKE`,
  c => `NO SURVIVORS: ${c.loser.toUpperCase()} FLEET WIPED OUT NEAR ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} FALLS SILENT AFTER ${c.winner.toUpperCase()} ASSAULT`,
];

const BATTLE_ONE_SIDED_UNKNOWN = [
  c => `${c.loser} lost ${numWord(c.count)} ${shipsWord(c.count)} near ${c.body} under circumstances that remain unclear${c.namesClause}.`,
  c => `Distress signals went silent over ${c.body} — ${c.loser} confirms ${numWord(c.count)} ${shipsWord(c.count)} destroyed, cause unknown${c.namesClause}.`,
  c => `${c.loser} reports ${numWord(c.count)} ${shipsWord(c.count)} lost at ${c.body}. No attacker has claimed responsibility${c.namesClause}.`,
  c => `Wreckage at ${c.body}: ${numWord(c.count)} ${c.loser} ${shipsWord(c.count)} gone, and no one is talking${c.namesClause}.`,
];

const BATTLE_ONE_SIDED_UNKNOWN_HEADLINE = [
  c => `MYSTERY AT ${c.body.toUpperCase()}: ${c.loser.toUpperCase()} LOSES ${c.count === 1 ? 'A SHIP' : numWord(c.count).toUpperCase() + ' SHIPS'}`,
  c => `${c.loser.toUpperCase()} SHIPS VANISH NEAR ${c.body.toUpperCase()}`,
  c => `UNEXPLAINED LOSSES REPORTED AT ${c.body.toUpperCase()}`,
  c => `WHO ATTACKED ${c.loser.toUpperCase()}? ${c.body.toUpperCase()} INCIDENT BAFFLES ANALYSTS`,
];

const BATTLE_MUTUAL = [
  c => `A fierce engagement erupted over ${c.body} between ${c.factionA} and ${c.factionB}. When the dust settled, ${c.factionA} had lost ${numWord(c.countA)} ${shipsWord(c.countA)}${c.namesAClause}, while ${c.factionB} counted ${numWord(c.countB)} of their own destroyed${c.namesBClause}.`,
  c => `${c.body} became a battlefield today as ${c.factionA} and ${c.factionB} traded blows — ${numWord(c.countA)} ${c.factionA} ${shipsWord(c.countA)} down, ${numWord(c.countB)} from ${c.factionB}.`,
  c => `Neither side backed down at ${c.body}: ${c.factionA} lost ${numWord(c.countA)}, ${c.factionB} lost ${numWord(c.countB)}, and the standoff continues.`,
  c => `Mutual destruction at ${c.body} — ${c.factionA} (${numWord(c.countA)} ${shipsWord(c.countA)}) and ${c.factionB} (${numWord(c.countB)} ${shipsWord(c.countB)}) both paid a steep price.`,
  c => `The battle for ${c.body} has no clear victor: ${numWord(c.countA)} ${c.factionA} vessel${plural(c.countA, '')} and ${numWord(c.countB)} ${c.factionB} vessel${plural(c.countB, '')} now litter the wreckage field.`,
  c => `${c.factionA} and ${c.factionB} clashed violently over ${c.body}, each side counting their dead — ${numWord(c.countA)} and ${numWord(c.countB)} ${shipsWord(c.countA + c.countB)} respectively.`,
];

const BATTLE_MUTUAL_HEADLINE = [
  c => `WAR ERUPTS AT ${c.body.toUpperCase()}`,
  c => `${c.factionA.toUpperCase()} AND ${c.factionB.toUpperCase()} CLASH OVER ${c.body.toUpperCase()}`,
  c => `BLOODY STALEMATE AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} BURNS AS TWO FLEETS COLLIDE`,
  c => `NEITHER SIDE YIELDS AT ${c.body.toUpperCase()}`,
];

const BATTLE_CHAOS = [
  c => `${c.body} descended into chaos as ${numWord(c.sides.length)} factions clashed at once. Casualties: ${c.sideList}.`,
  c => `A free-for-all erupted at ${c.body} — ${c.sideList}.`,
  c => `No fewer than ${numWord(c.sides.length)} powers traded fire over ${c.body} today: ${c.sideList}.`,
  c => `The battle of ${c.body} drew in ${numWord(c.sides.length)} factions before it was over: ${c.sideList}.`,
];

const BATTLE_CHAOS_HEADLINE = [
  c => `CHAOS AT ${c.body.toUpperCase()}: ${numWord(c.sides.length).toUpperCase()}-WAY BATTLE ERUPTS`,
  c => `FREE-FOR-ALL AT ${c.body.toUpperCase()} LEAVES WRECKAGE ACROSS THE SYSTEM`,
  c => `${c.body.toUpperCase()} DESCENDS INTO CHAOS`,
  c => `EVERYONE'S AT WAR: MELEE ENGULFS ${c.body.toUpperCase()}`,
];

const ASTEROID_IMPACT = [
  c => `${c.attacker ?? 'An unknown aggressor'} hurled a rock across the void, striking ${c.body} and scarring its surface for good.`,
  c => `An act of war: ${c.body} took a direct asteroid impact today, its yields crippled for the foreseeable future.`,
  c => `The skies fell silent, then ${c.body} was struck — ${c.attacker ?? 'the culprit'} claims the blow.`,
  c => `${c.body} bears fresh scars after an asteroid strike widely attributed to ${c.attacker ?? 'unknown forces'}.`,
  c => `A kinetic strike hit ${c.body} today, halving its productivity. ${c.attacker ? `${c.attacker} is believed responsible.` : 'No one has claimed the attack.'}`,
];

const ASTEROID_IMPACT_HEADLINE = [
  c => `ACT OF WAR: ${c.body.toUpperCase()} STRUCK BY ASTEROID`,
  c => `${(c.attacker ?? 'UNKNOWN FORCES').toUpperCase()} LAUNCHES ROCK AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} SCARRED IN KINETIC STRIKE`,
  c => `PANIC AS ASTEROID HITS ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} REELS FROM ORBITAL BOMBARDMENT`,
];

const INDUSTRY_BOTH = [
  c => `${c.faction}'s shipyards ran hot today — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} launched${c.shipNamesClause}, alongside ${numWord(c.buildCount)} completed construction project${plural(c.buildCount, '')}.`,
  c => `Industry hums for ${c.faction}: ${numWord(c.shipCount)} hulls rolled out${c.shipNamesClause} and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} finished.`,
  c => `${c.faction} expanded on every front today — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)}${c.shipNamesClause}, plus ${numWord(c.buildCount)} finished construction project${plural(c.buildCount, '')}.`,
];

const INDUSTRY_BOTH_HEADLINE = [
  c => `${c.faction.toUpperCase()} RAMPS UP PRODUCTION ON ALL FRONTS`,
  c => `BUSY DAY FOR ${c.faction.toUpperCase()} SHIPYARDS AND ENGINEERS`,
];

const INDUSTRY_SHIPS_ONLY = [
  c => `${c.faction} launched ${numWord(c.count)} new ${shipsWord(c.count)} today${c.namesClause}.`,
  c => `Fresh hulls for ${c.faction}: ${numWord(c.count)} ${shipsWord(c.count)} rolled out of the yards${c.namesClause}.`,
  c => `${c.faction}'s shipyards delivered ${numWord(c.count)} vessel${plural(c.count, '')}${c.namesClause}.`,
  c => `The fleet of ${c.faction} grows — ${numWord(c.count)} ${shipsWord(c.count)} commissioned${c.namesClause}.`,
  c => `${numWord(c.count)} new ${shipsWord(c.count)} joined ${c.faction}'s ranks today${c.namesClause}.`,
  c => `${c.faction} rolled ${numWord(c.count)} new hull${plural(c.count, '')} off the line${c.namesClause}.`,
];

const INDUSTRY_SHIPS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS ITS FLEET`,
  c => `NEW HULLS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} SHIPYARDS DELIVER`,
];

const INDUSTRY_BUILDINGS_ONLY = [
  c => `${c.faction} completed ${numWord(c.count)} construction project${plural(c.count, '')} today.`,
  c => `Infrastructure milestone for ${c.faction}: ${numWord(c.count)} upgrade${plural(c.count, '')} finished.`,
  c => `${c.faction}'s engineers finished ${numWord(c.count)} project${plural(c.count, '')} across their holdings.`,
  c => `Construction crews for ${c.faction} closed out ${numWord(c.count)} project${plural(c.count, '')}.`,
];

const INDUSTRY_BUILDINGS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} UPGRADES INFRASTRUCTURE`,
  c => `CONSTRUCTION MILESTONE FOR ${c.faction.toUpperCase()}`,
];

const COLONY_FOUNDED = [
  c => `${c.faction} broke ground on ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Expansion continues for ${c.faction} — ${numWord(c.count)} new outpost${plural(c.count, '')} established${c.entriesClause}.`,
  c => `${c.faction} planted ${numWord(c.count)} new flag${plural(c.count, '')} in the system${c.entriesClause}.`,
  c => `New territory for ${c.faction}: ${numWord(c.count)} settlement${plural(c.count, '')} founded${c.entriesClause}.`,
  c => `${c.faction}'s colonists made landfall — ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
];

const COLONY_FOUNDED_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS THE FRONTIER`,
  c => `NEW SETTLEMENTS RISE FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STAKES NEW CLAIM`,
  c => `${c.faction.toUpperCase()} PLANTS ITS FLAG`,
];

const FACTION_ARRIVAL = [
  c => `${c.faction} has entered the system, establishing their capital at ${c.body}.`,
  c => `A new power rises: ${c.faction} stakes their claim at ${c.body}.`,
  c => `${c.faction} joins the fray, founding their homeworld on ${c.body}.`,
  c => `Newcomers to the system: ${c.faction} has arrived and settled at ${c.body}.`,
];

const FACTION_ARRIVAL_HEADLINE = [
  c => `NEW POWER ENTERS THE SYSTEM: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ARRIVES, SETTLES ${c.body.toUpperCase()}`,
  c => `A NEW FLAG FLIES OVER ${c.body.toUpperCase()}`,
];

const DISCOVERY_LEADIN = [
  'Word from the frontier: ',
  'Scouts report: ',
  'A dispatch just in — ',
  'From the outer reaches: ',
  'Explorers have uncovered something: ',
  'Field notes from the edge of the system: ',
];

const DISCOVERY_HEADLINE = [
  c => `ANCIENT SECRETS UNCOVERED AT ${c.bodyName.toUpperCase()}`,
  c => `MYSTERY SOLVED AT ${c.bodyName.toUpperCase()}`,
  c => `EXPEDITION STRIKES GOLD AT ${c.bodyName.toUpperCase()}`,
  c => `THE PAST SPEAKS: DISCOVERY AT ${c.bodyName.toUpperCase()}`,
  c => `WHAT WAS FOUND AT ${c.bodyName.toUpperCase()}?`,
];

const TREATY_SIGNED = [
  c => `${c.a} and ${c.b} have signed ${c.pactName}, formalizing new terms between their peoples.`,
  c => `Diplomats rejoice: ${c.a} and ${c.b} inked ${c.pactName} today.`,
  c => `${c.a} and ${c.b} put pen to paper on ${c.pactName}.`,
  c => `A new accord: ${c.a} and ${c.b} have agreed to ${c.pactName}.`,
];

const TREATY_SIGNED_HEADLINE = [
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} SIGN HISTORIC ACCORD`,
  c => `PEACE AT LAST: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} INK DEAL`,
  c => `NEW ALLIANCE: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} FORMALIZE TIES`,
];

const TREATY_BROKEN = [
  c => `${c.a} tore up their pact with ${c.b} — the accord lies in ruins.`,
  c => `Diplomacy fails: ${c.a} has broken their treaty with ${c.b}.`,
  c => `The peace between ${c.a} and ${c.b} is over.`,
  c => `${c.a} has withdrawn from its agreement with ${c.b}, effective immediately.`,
];

const TREATY_BROKEN_HEADLINE = [
  c => `CEASEFIRE COLLAPSES: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} AT ODDS AGAIN`,
  c => `${c.a.toUpperCase()} TEARS UP PACT WITH ${c.b.toUpperCase()}`,
  c => `DIPLOMACY FAILS BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `ALLIANCE IN RUINS: ${c.a.toUpperCase()} WALKS AWAY FROM ${c.b.toUpperCase()}`,
];

const SENATE_PASSED = [
  c => `The Senate has passed "${c.title}" — the ${c.actor} delegation's motion carries.`,
  c => `By vote of the assembly, "${c.title}" is now law.`,
  c => `The chamber rules in favor: "${c.title}" passes.`,
];

const SENATE_PASSED_HEADLINE = [
  c => `SENATE PASSES "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS APPROVE "${c.title.toUpperCase()}"`,
];

const SENATE_FAILED = [
  c => `The Senate has rejected "${c.title}", proposed by ${c.actor}.`,
  c => `"${c.title}" fails to carry the chamber.`,
  c => `The assembly votes down "${c.title}".`,
];

const SENATE_FAILED_HEADLINE = [
  c => `SENATE REJECTS "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS BLOCK "${c.title.toUpperCase()}"`,
];

const VICTORY = [
  c => `${c.faction} stands triumphant — victory is theirs.`,
  c => `The long campaign is over: ${c.faction} has won.`,
  c => `History remembers this day: ${c.faction} claims final victory.`,
  c => `It is finished. ${c.faction} rules the system.`,
  c => `${c.faction} has achieved what no other power could — total victory.`,
];

const VICTORY_HEADLINE = [
  c => `${c.faction.toUpperCase()} WINS THE WAR`,
  c => `VICTORY: ${c.faction.toUpperCase()} TRIUMPHANT`,
  c => `IT IS OVER — ${c.faction.toUpperCase()} REIGNS SUPREME`,
  c => `${c.faction.toUpperCase()} CLAIMS FINAL VICTORY`,
  c => `HISTORY IS MADE: ${c.faction.toUpperCase()} PREVAILS`,
];

const ELIMINATION = [
  c => `${c.faction} has fallen. Their banners lie in the dust.`,
  c => `The story of ${c.faction} ends here.`,
  c => `${c.faction} has been eliminated from the system.`,
];

const ELIMINATION_HEADLINE = [
  c => `${c.faction.toUpperCase()} FALLS`,
  c => `THE END FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ELIMINATED FROM THE SYSTEM`,
];

const TRADE_LEDGER = [
  c => `${c.count} freighter ${c.count === 1 ? 'delivery' : 'deliveries'} completed across all routes today.`,
  c => `The logistics corps moved ${c.count} shipment${plural(c.count, '')} safely to port.`,
  c => `${c.count} successful cargo run${plural(c.count, '')} recorded across the system.`,
  c => `Merchant fleets completed ${c.count} delivery run${plural(c.count, '')} today.`,
];

const QUIET_DAY_HEADLINE = [
  () => 'ALL QUIET ACROSS THE SYSTEM',
  () => 'A DAY OF PEACE — NOTHING TO REPORT',
  () => 'THE VOID HOLDS ITS BREATH',
  () => 'SLOW NEWS DAY IN THE BLACK',
];

const QUIET_DAY_BODY = [
  () => 'No battles, no new colonies, no discoveries to report since the last edition. The presses idle; the void abides.',
  () => 'The system rests today. Every faction holds its position; nothing more to tell.',
  () => 'A rare calm has settled over the system. Even the merchants have little to report.',
];

// ------------------------------------------------------------
// Story builders — cluster raw chronicle rows into narrative units
// per section, then render each via the phrase banks above. Every
// story returned is { text, headline, weight }.
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
      let extra = '';
      if (bucket.settlementNames.length > 0) {
        const sNames = nameList(bucket.settlementNames, 2);
        extra = ` The settlement${bucket.settlementNames.length > 1 ? 's' : ''} ${sNames} ${bucket.settlementNames.length > 1 ? 'were' : 'was'} also lost in the fighting.`;
      }
      // Weight is casualty-count-first, same formula across all three
      // battle shapes (one-sided/mutual/chaos) — a 6-ship one-sided
      // massacre must outrank a 2-ship mutual skirmish for the
      // front-page slot; total dead matters more than the shape of
      // the fight. BATTLE_BASE_WEIGHT / BATTLE_PER_CASUALTY shared below.
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * bucket.count;
      stories.push(winner
        ? mkStory(weight, used, 'battle_one_sided', BATTLE_ONE_SIDED_KNOWN, 'battle_one_sided_hl', BATTLE_ONE_SIDED_KNOWN_HEADLINE, ctx, extra)
        : mkStory(weight, used, 'battle_unknown', BATTLE_ONE_SIDED_UNKNOWN, 'battle_unknown_hl', BATTLE_ONE_SIDED_UNKNOWN_HEADLINE, ctx, extra));
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
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * (bucketA.count + bucketB.count);
      stories.push(mkStory(weight, used, 'battle_mutual', BATTLE_MUTUAL, 'battle_mutual_hl', BATTLE_MUTUAL_HEADLINE, ctx));
    } else {
      // 3+ factions, or an asymmetric shape — describe as chaos.
      const sides = victims
        .map(v => ({ faction: v, count: cluster.losses.get(v).count }))
        .sort((a, b) => b.count - a.count);
      const sideList = sides.map(s => `${s.faction} lost ${numWord(s.count)}`).join('; ');
      const total = sides.reduce((s, x) => s + x.count, 0);
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * total;
      stories.push(mkStory(weight, used, 'battle_chaos', BATTLE_CHAOS, 'battle_chaos_hl', BATTLE_CHAOS_HEADLINE, { body: cluster.body, sides, sideList }));
    }
  }

  // --- asteroid impacts: always their own dramatic mini-story ---
  for (const row of rows) {
    if (row.kind !== 'asteroid_impact') continue;
    const p = safeJson(row.payload);
    const attacker = p.attacker_faction_name ?? null; // not currently stored, kept forward-compat
    const ctx = { attacker, body: p.target_name ?? row.body_id ?? 'a nearby world' };
    stories.push(mkStory(700, used, 'asteroid_impact', ASTEROID_IMPACT, 'asteroid_impact_hl', ASTEROID_IMPACT_HEADLINE, ctx));
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
    const weight = 40 + 3 * (shipCount + buildCount); // routine news — rarely the headline
    if (shipCount > 0 && buildCount > 0) {
      stories.push(mkStory(weight, used, 'industry_both', INDUSTRY_BOTH, 'industry_both_hl', INDUSTRY_BOTH_HEADLINE, { faction, shipCount, buildCount, shipNamesClause }));
    } else if (shipCount > 0) {
      stories.push(mkStory(weight, used, 'industry_ships', INDUSTRY_SHIPS_ONLY, 'industry_ships_hl', INDUSTRY_SHIPS_ONLY_HEADLINE, { faction, count: shipCount, namesClause: shipNamesClause }));
    } else {
      stories.push(mkStory(weight, used, 'industry_builds', INDUSTRY_BUILDINGS_ONLY, 'industry_builds_hl', INDUSTRY_BUILDINGS_ONLY_HEADLINE, { faction, count: buildCount }));
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
    const weight = 100 + 5 * entries.length;
    stories.push(mkStory(weight, used, 'colony_founded', COLONY_FOUNDED, 'colony_founded_hl', COLONY_FOUNDED_HEADLINE, { faction, count: entries.length, entriesClause }));
  }

  for (const row of rows) {
    if (row.kind !== 'faction_joined') continue;
    const p = safeJson(row.payload);
    const ctx = { faction: p.name ?? 'A new faction', body: p.capital_name ?? 'an unclaimed world' };
    stories.push(mkStory(220, used, 'faction_arrival', FACTION_ARRIVAL, 'faction_arrival_hl', FACTION_ARRIVAL_HEADLINE, ctx));
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
    const bodyName = m ? m[1] : 'the frontier';
    const text = m ? `${leadIn}at ${m[1]}, ${m[2]}` : `${leadIn}${raw}`;
    const headline = pickTemplate('discovery_hl', DISCOVERY_HEADLINE, used)({ bodyName });
    stories.push({ text, headline, weight: 250 + Math.random() });
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
      const ctx = { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id), pactName: PACT_NAMES[p.kind] ?? 'a treaty' };
      stories.push(mkStory(150, used, 'treaty_signed', TREATY_SIGNED, 'treaty_signed_hl', TREATY_SIGNED_HEADLINE, ctx));
    } else if (row.kind === 'treaty_broken') {
      const ctx = { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id) };
      stories.push(mkStory(350, used, 'treaty_broken', TREATY_BROKEN, 'treaty_broken_hl', TREATY_BROKEN_HEADLINE, ctx));
    } else if (row.kind === 'senate_vote') {
      const ctx = { title: p.title ?? 'a motion', actor: nameOf(row.actor_faction_id) };
      if (p.outcome === 'passed') {
        stories.push(mkStory(120, used, 'senate_passed', SENATE_PASSED, 'senate_passed_hl', SENATE_PASSED_HEADLINE, ctx));
      } else {
        stories.push(mkStory(120, used, 'senate_failed', SENATE_FAILED, 'senate_failed_hl', SENATE_FAILED_HEADLINE, ctx));
      }
    }
  }
  return stories;
}

function buildVictoryStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'victory') {
      const faction = factionNames.get(row.actor_faction_id) ?? 'A faction';
      const ctx = { faction };
      const text = (typeof p.detail === 'string' && p.detail.length > 0) ? `${p.detail}.` : pickTemplate('victory', VICTORY, used)(ctx);
      const headline = pickTemplate('victory_hl', VICTORY_HEADLINE, used)(ctx);
      stories.push({ text, headline, weight: 1000 + Math.random() });
    } else if (row.kind === 'faction_eliminated') {
      const ctx = { faction: factionNames.get(row.actor_faction_id) ?? 'A faction' };
      stories.push(mkStory(900, used, 'elimination', ELIMINATION, 'elimination_hl', ELIMINATION_HEADLINE, ctx));
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
  let value = shown.map(s => s.text).join('\n\n');
  if (more > 0) value += `\n\n…and ${more} more incident${more === 1 ? '' : 's'} to report.`;
  if (value.length > 1020) value = value.slice(0, 1017) + '…';
  return { name: title, value };
}

/** Build the embed for one game. Headline-forward: the single
 *  highest-weighted story becomes the embed's ALL-CAPS title (with
 *  its narrative sentence as the deck, under a masthead line), and is
 *  removed from its section so it isn't shown twice. Everything else
 *  renders as before, grouped by section. Returns null when the day
 *  was entirely uneventful (no stories + no trades) so we skip the
 *  post rather than spam "nothing happened". */
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

  // Find the single most newsworthy story across every section.
  let topStory = null;
  let topSection = null;
  for (const key of Object.keys(sections)) {
    for (const story of sections[key]) {
      if (!topStory || story.weight > topStory.weight) { topStory = story; topSection = key; }
    }
  }

  if (!topStory && tradesDelta <= 0) return null;

  // Pull the headline story out of its section so it isn't repeated
  // in the body — it's already "above the fold" in the description.
  if (topStory) {
    sections[topSection] = sections[topSection].filter(s => s !== topStory);
  }

  const fields = [];
  for (const key of ['victory', 'battles', 'politics', 'discoveries', 'colonies', 'industry']) {
    const field = fieldFromStories(SECTION_META[key].title, sections[key]);
    if (field) fields.push(field);
  }

  if (tradesDelta > 0) {
    fields.push({ name: '📦  Trade ledger', value: pickTemplate('trade_ledger', TRADE_LEDGER, used)({ count: tradesDelta }) });
  }

  const masthead = `🗞️ **THE ORBITAL HERALD** · ${gameName} · T+${tick}`;
  const title = topStory ? topStory.headline : pickTemplate('quiet_hl', QUIET_DAY_HEADLINE, used)();
  const deck = topStory ? topStory.text : pickTemplate('quiet_body', QUIET_DAY_BODY, used)();
  const description = `${masthead}\n\n${deck}`;

  const color = (topSection && SECTION_META[topSection]) ? SECTION_META[topSection].color : SECTION_META.colonies.color;

  return {
    title,
    description,
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

  // Forced editions always publish — a quiet day (no stories, no
  // trades) still gets a headline-styled "all quiet" bulletin so the
  // host's test button visibly works.
  if (!embed && force) {
    const used = new Map();
    embed = {
      title: pickTemplate('quiet_hl', QUIET_DAY_HEADLINE, used)(),
      description: `🗞️ **THE ORBITAL HERALD** · ${game.name ?? game.id} · T+${game.current_tick ?? 0} · Special Edition\n\n${pickTemplate('quiet_body', QUIET_DAY_BODY, used)()}`,
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
