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
//     matches noon Eastern (DST-aware) and the game hasn't been digested in
//     the last ~20 hours (idempotent across cron re-fires).
//   - runDigestForGame(env, game, { force }) is the shared per-game
//     worker; { force: true } is used by the host's "Publish Herald
//     Now" button (worker/actions.js handleDigestNow) to bypass the
//     interval gate, cover a fixed trailing 12h window, and always
//     post something, even a quiet-day edition.
//   - digest_state table (migration 0034) tracks the per-game
//     high-water mark so each SCHEDULED digest covers exactly the
//     window since the previous one.
// ============================================================

/** Publish hour, in US Eastern local time (noon). Checked via Intl
 *  against the America/New_York zone so it stays at local noon across
 *  DST — noon EDT in summer (16:00 UTC), noon EST in winter (17:00 UTC)
 *  — instead of a hardcoded UTC hour that would drift an hour twice a
 *  year. Cron fires every minute; this gates to the noon-Eastern hour. */
const DIGEST_HOUR_EASTERN = 12;

/** True during the noon-Eastern clock hour, DST-correct. */
function isEasternDigestHour(nowMs) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date(nowMs));
  // hour12:false yields "24" for midnight in some ICU builds — normalize.
  const hour = Number(h) % 24;
  return hour === DIGEST_HOUR_EASTERN;
}

const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const FORCE_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/** Stories per section before we clamp to "...and N more incidents". */
const MAX_STORIES_PER_SECTION = 4;

/** Battle newsworthiness: casualty count first, shape second. A
 *  6-ship one-sided massacre must always outrank a 2-ship mutual
 *  skirmish, so every battle shape shares this exact formula rather
 *  than each having its own base. */
const BATTLE_BASE_WEIGHT = 380;
const BATTLE_PER_CASUALTY = 20;

/** A reciprocal 2-faction battle (both sides credited kills against
 *  each other) is classified by casualty ratio, not just "did both
 *  sides lose something": >=3x is a rout despite the other side
 *  landing a hit or two, 1.5-3x is a costly-but-clear win, <1.5x is a
 *  genuine standoff. Catches the "7 MCRN ships vs 1 CIS ship = no
 *  clear victor" bug — that's not a stalemate, CIS won decisively. */
const BATTLE_DECISIVE_RATIO = 3;
const BATTLE_NARROW_RATIO = 1.5;

/** Below this combined ships+builds total, a faction's industry news
 *  gets rolled into ONE shared "everyone else" line instead of its
 *  own paragraph. Without this, a healthy 4-5 faction game fills the
 *  Industry section with routine one-liners every single edition —
 *  the digest's own version of the wallpaper the situation report
 *  already solved for idle freighters. */
const INDUSTRY_COLLAPSE_THRESHOLD = 5;

// ------------------------------------------------------------
// Prose helpers
// ------------------------------------------------------------

// AP style: spell zero through nine, digits from 10 up. Also keeps the
// paper internally consistent — before this fix, most sections spelled
// numbers up to twelve while the Trade ledger never spelled any of
// them, so "ten hulls" and "20 cargo runs" sat two paragraphs apart.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function numWord(n) { return n >= 0 && n <= 9 ? NUMBER_WORDS[n] : String(n); }

// Settlement `population` is an internal game stat (1-10, a development
// tier — src/game/settlements.ts GROWTH_INTERVAL/POP_MAX). For newspaper
// copy it stands in for a real populace: 1 pop = 200,000 people. Display
// layer only — mirrors src/game/flavorEngine.ts's formatPopulation
// (same constant, duplicated because client TS and this worker JS don't
// share a module).
const POP_PER_UNIT = 200_000;
function formatPopulation(units) {
  const people = units * POP_PER_UNIT;
  if (people >= 1_000_000) {
    const millions = people / 1_000_000;
    const str = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
    return `${str} million`;
  }
  return people.toLocaleString('en-US');
}
function shipsWord(n) { return n === 1 ? 'ship' : 'ships'; }
function plural(n, word, pluralWord) { return n === 1 ? word : (pluralWord ?? `${word}s`); }

/** Bold-wraps a proper noun for narrative body text (factions, body
 *  names). Never used in headline banks — Discord embed TITLES don't
 *  render markdown, so bolding there would show literal asterisks. */
function b(s) { return s ? `**${s}**` : s; }

// Naive title-case for player-typed strings (Senate bill titles) that
// otherwise sit in the newspaper's voice looking like a chat message
// ("the down with sean bill" next to "The Empire of Lorne broke
// ground..."). Doesn't try to preserve deliberate internal caps
// (McKay -> Mckay) — a rare cost worth paying for the common case of
// all-lowercase or all-caps player input reading like a headline.
const TITLE_CASE_MINOR = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
  'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'if', 'vs',
]);
function titleCase(s) {
  if (!s) return s;
  const words = s.trim().split(/\s+/);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i !== 0 && i !== words.length - 1 && TITLE_CASE_MINOR.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Truncation-tail phrase bank for nameList — was a single hardcoded
 *  ", and N more" with zero variation, which made it the single
 *  most-repeated fragment in the whole paper (it showed up in nearly
 *  every casualty/ship/settlement list). Now rotates like everything
 *  else. Each entry takes the remainder count and returns the full
 *  trailing clause, including its own leading punctuation. */
const NAME_LIST_MORE_TAIL = [
  n => `, and ${n} more`,
  n => `, plus ${n} more`,
  n => `, and ${n} others`,
  n => `, with ${n} more besides`,
  n => `, among ${n} more unnamed`,
  n => ` — and ${n} more after that`,
  n => `, and ${n} others unlisted`,
  n => `, plus ${n} not named here`,
];

/** Oxford-joined, italicized name list (ships/settlements — kept
 *  visually distinct from bold faction/body names). Caps at `max`,
 *  tail becomes a varied "...and N more"-style clause rather than a
 *  run-on sentence. Returns null for an empty list so callers can
 *  cleanly omit the clause. `used` (optional) threads into the same
 *  per-edition "don't repeat a bank" tracking every other phrase bank
 *  uses; omit only for call sites that can't reach it. */
function nameList(names, max = 2, used = null) {
  const uniq = [...new Set((names || []).filter(Boolean))];
  if (uniq.length === 0) return null;
  const shown = uniq.slice(0, max).map(n => `*${n}*`);
  if (uniq.length <= max) {
    if (shown.length === 1) return shown[0];
    if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
    return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  }
  const remaining = uniq.length - max;
  const tail = used
    ? pickTemplate('name_list_tail', NAME_LIST_MORE_TAIL, used)(remaining)
    : NAME_LIST_MORE_TAIL[0](remaining);
  return `${shown.join(', ')}${tail}`;
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

/** "was also lost" clause for settlements destroyed alongside ships in
 *  a battle. Folds in total population when we have it — a bare name
 *  ("the settlement Qualor II Depot was also lost") reads as a line
 *  item; naming how many colonists went with it gives the loss actual
 *  weight. Population is a small stat (settlements cap at 10), so it's
 *  a numeral readout rather than a counted noun, same reasoning as the
 *  client-side flavor bank. Gracefully omits the clause for older
 *  chronicle rows that predate pop_lost (totalPop <= 0). */
function settlementLossClause(names, totalPop, used) {
  if (!names.length) return '';
  const nameStr = nameList(names, 2, used);
  const many = names.length > 1;
  // Closed on both sides as a proper parenthetical aside — a dash that
  // only opens ("New City — home to 600,000 was lost") runs the aside
  // straight into the verb with no boundary.
  const popClause = totalPop > 0 ? ` — home to ${formatPopulation(totalPop)} —` : '';
  return ` The settlement${many ? 's' : ''} ${nameStr}${popClause} ${many ? 'were' : 'was'} also lost in the fighting.`;
}

/** Builds a story object: renders BOTH a body sentence (narrative
 *  bank) and a short ALL-CAPS headline (headline bank) from the same
 *  context, tags it with a newsworthiness weight (+ small jitter so
 *  equal-weight days don't always crown the same kind of story), and
 *  returns { text, headline, weight }. `text` gets `extra` appended
 *  verbatim (used for trailing clauses like "the settlement X was
 *  also lost"). Narrative templates apply b()/bodyLoc themselves;
 *  headline templates read the same ctx but only ever touch the
 *  PLAIN fields (faction names, ctx.body) so nothing here needs to
 *  duplicate ctx per bank. */
function mkStory(baseWeight, used, narrativeBankName, narrativeBank, headlineBankName, headlineBank, ctx, extra = '') {
  const text = pickTemplate(narrativeBankName, narrativeBank, used)(ctx) + extra;
  const headline = pickTemplate(headlineBankName, headlineBank, used)(ctx);
  return { text, headline, weight: baseWeight + Math.random() };
}

// ------------------------------------------------------------
// Body location resolver
// ------------------------------------------------------------

/** Batch-resolves every body id referenced in this digest into a
 *  plain name and a "located" narrative form:
 *    moon (parent is a planet)         -> "Ganymede, in the Jupiter system"
 *    dwarf/asteroid orbiting the star  -> "Sedna, in the Kuiper Belt"
 *                                          (main-belt dwarfs <1000 units
 *                                          out get "the asteroid belt";
 *                                          matches game_bodies orbit_radius:
 *                                          Ceres/Vesta/etc = 360, Pluto/
 *                                          Haumea/Quaoar/Eris/Sedna = 1900-3500)
 *    major planet / star / lagrange    -> no clause, name alone is
 *                                          unambiguous
 *  Only `.full` carries markdown (bold proper nouns baked in) —
 *  `.name` stays completely plain because it's the field headline
 *  templates read, and Discord embed titles don't render markdown. */
async function buildBodyLocator(env, gameId, bodyIds) {
  const ids = [...new Set(bodyIds.filter(Boolean))];
  const byId = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await env.DB
      .prepare(`SELECT id, name, type, parent_body_id, orbit_radius FROM game_bodies WHERE game_id = ? AND id IN (${placeholders})`)
      .bind(gameId, ...ids)
      .all()).results ?? [];
    for (const r of rows) byId.set(r.id, r);
    const missingParents = [...new Set(rows.map(r => r.parent_body_id).filter(p => p && !byId.has(p)))];
    if (missingParents.length > 0) {
      const ph2 = missingParents.map(() => '?').join(',');
      const parentRows = (await env.DB
        .prepare(`SELECT id, name, type FROM game_bodies WHERE game_id = ? AND id IN (${ph2})`)
        .bind(gameId, ...missingParents)
        .all()).results ?? [];
      for (const r of parentRows) if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }

  const locator = new Map();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    let clause = null;
    if (r.type === 'moon' && r.parent_body_id) {
      const parent = byId.get(r.parent_body_id);
      if (parent) clause = `in the **${parent.name}** system`;
    } else if ((r.type === 'dwarf' || r.type === 'asteroid') && r.parent_body_id) {
      const parent = byId.get(r.parent_body_id);
      if (parent && parent.type === 'star') {
        clause = (r.orbit_radius ?? 0) > 1000 ? 'in the **Kuiper Belt**' : 'in the asteroid belt';
      }
    }
    locator.set(id, { name: r.name, full: clause ? `**${r.name}**, ${clause}` : `**${r.name}**` });
  }
  return locator;
}

/** Looks up a body's {name, full} pair; falls back to the raw name we
 *  already had on hand (from the chronicle payload) when the body
 *  can't be resolved (deleted, cross-game edge case, etc.) so a
 *  lookup miss never blanks out the location entirely. */
function locate(locator, bodyId, fallbackName) {
  const entry = bodyId ? locator.get(bodyId) : null;
  if (entry) return entry;
  const name = fallbackName || 'deep space';
  return { name, full: `**${name}**` };
}

// ------------------------------------------------------------
// Phrase banks — narrative (sentence, body copy) paired with headline
// (short ALL-CAPS, front-page style) for every story shape. Each
// entry is (ctx) => string. Narrative templates read ctx.bodyLoc for
// the first/primary body mention (pre-bolded + located) and wrap
// repeat mentions / faction names in b(); headline templates read the
// plain ctx.body / ctx.faction / etc. fields and .toUpperCase() them.
// Deliberately generous: the more variants, the longer this runs
// before a playtest group notices a repeat.
// ------------------------------------------------------------

const BATTLE_ONE_SIDED_KNOWN = [
  c => `${b(c.loser)} was routed at ${c.bodyLoc} today — ${numWord(c.count)} ${shipsWord(c.count)} lost to ${b(c.winner)}${c.namesClause}.`,
  // "of their ships" is always plural in this partitive slot — "one of
  // their ship" (shipsWord(1)) read as a real grammar bug in a live
  // digest, so this stays hardcoded rather than count-driven.
  c => `A hard day for ${b(c.loser)}: ${b(c.winner)} forces destroyed ${numWord(c.count)} of their ships in the skies over ${c.bodyLoc}${c.namesClause}.`,
  c => `${b(c.winner)} pressed the attack at ${c.bodyLoc}, leaving ${b(c.loser)} with ${numWord(c.count)} fewer ${shipsWord(c.count)} to their name${c.namesClause}.`,
  c => `The wreckage of ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} now drifts around ${c.bodyLoc} after an engagement with ${b(c.winner)}${c.namesClause}.`,
  c => `${b(c.loser)} suffered a costly defeat near ${c.bodyLoc}; ${b(c.winner)} accounted for all ${numWord(c.count)} losses${c.namesClause}.`,
  c => `No mercy at ${c.bodyLoc} — ${b(c.winner)} sent ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} to the void${c.namesClause}.`,
  c => `${b(c.winner)} claimed a decisive victory over ${b(c.loser)} in the skies above ${c.bodyLoc}, downing ${numWord(c.count)} vessel${plural(c.count, '')}${c.namesClause}.`,
  c => `Reports from ${c.bodyLoc} confirm ${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)} to ${b(c.winner)} in a one-sided clash${c.namesClause}.`,
  c => `${b(c.loser)}'s presence at ${c.bodyLoc} was shattered by ${b(c.winner)} — ${numWord(c.count)} ${shipsWord(c.count)} confirmed destroyed${c.namesClause}.`,
  c => `The skies over ${c.bodyLoc} ran red for ${b(c.loser)} today, with ${b(c.winner)} claiming ${numWord(c.count)} kill${c.count === 1 ? '' : 's'}${c.namesClause}.`,
  c => `${b(c.winner)} caught ${b(c.loser)} flat-footed at ${c.bodyLoc}, leaving ${numWord(c.count)} ${shipsWord(c.count)} burning in the dark${c.namesClause}.`,
  c => `It was over quickly at ${c.bodyLoc}: ${b(c.winner)} put ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} out of the fight for good${c.namesClause}.`,
  c => `${b(c.loser)} limped away from ${c.bodyLoc} short ${numWord(c.count)} ${shipsWord(c.count)}, courtesy of ${b(c.winner)}${c.namesClause}.`,
  c => `${b(c.winner)} struck first and struck hard at ${c.bodyLoc} — ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} never stood a chance${c.namesClause}.`,
  c => `The butcher's bill from ${c.bodyLoc} reads ${numWord(c.count)} for ${b(c.loser)}, zero for ${b(c.winner)}${c.namesClause}.`,
  c => `${b(c.loser)} will remember ${c.bodyLoc} for a long time — ${b(c.winner)} left them ${numWord(c.count)} ${shipsWord(c.count)} lighter${c.namesClause}.`,
  c => `A brutal showing by ${b(c.winner)} at ${c.bodyLoc}: ${numWord(c.count)} ${b(c.loser)} hull${plural(c.count, '')} reduced to debris${c.namesClause}.`,
  c => `${b(c.winner)} swept the field at ${c.bodyLoc}, taking ${numWord(c.count)} ${shipsWord(c.count)} from ${b(c.loser)} without loss${c.namesClause}.`,
  c => `Salvage crews are already picking through ${numWord(c.count)} wreck${plural(c.count, '')} at ${c.bodyLoc} after ${b(c.winner)} finished with ${b(c.loser)}${c.namesClause}.`,
  c => `${b(c.loser)} sent ${numWord(c.count)} ${shipsWord(c.count)} to ${c.bodyLoc} and got none of them back — ${b(c.winner)} saw to that${c.namesClause}.`,
];

const BATTLE_ONE_SIDED_KNOWN_HEADLINE = [
  c => `${c.loser.toUpperCase()} ROUTED AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} CRUSHES ${c.loser.toUpperCase()} FLEET AT ${c.body.toUpperCase()}`,
  c => `${numWord(c.count).toUpperCase()} ${c.loser.toUpperCase()} ${shipsWord(c.count).toUpperCase()} DOWN IN ${c.body.toUpperCase()} AMBUSH`,
  c => `BLOODBATH AT ${c.body.toUpperCase()}: ${c.loser.toUpperCase()} DECIMATED`,
  c => `${c.winner.toUpperCase()} DOMINANT IN ${c.body.toUpperCase()} STRIKE`,
  c => `NO SURVIVORS: ${c.loser.toUpperCase()} FLEET WIPED OUT NEAR ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} FALLS SILENT AFTER ${c.winner.toUpperCase()} ASSAULT`,
  c => `${c.winner.toUpperCase()} STRIKES FIRST AT ${c.body.toUpperCase()}`,
  c => `${c.loser.toUpperCase()} CAUGHT OFF GUARD AT ${c.body.toUpperCase()}`,
  c => `SLAUGHTER AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} LEAVES NOTHING BUT WRECKAGE AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} INCIDENT: ${c.loser.toUpperCase()} TAKES HEAVY LOSSES`,
  c => `ONE-SIDED AT ${c.body.toUpperCase()}: ${c.winner.toUpperCase()} UNCHALLENGED`,
  c => `${c.loser.toUpperCase()} FLEET GUTTED NEAR ${c.body.toUpperCase()}`,
];

const BATTLE_ONE_SIDED_UNKNOWN = [
  c => `${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)} near ${c.bodyLoc} under circumstances that remain unclear${c.namesClause}.`,
  c => `Distress signals went silent over ${c.bodyLoc} — ${b(c.loser)} confirms ${numWord(c.count)} ${shipsWord(c.count)} destroyed, cause unknown${c.namesClause}.`,
  c => `${b(c.loser)} reports ${numWord(c.count)} ${shipsWord(c.count)} lost at ${c.bodyLoc}. No attacker has claimed responsibility${c.namesClause}.`,
  c => `Wreckage at ${c.bodyLoc}: ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} gone, and no one is talking${c.namesClause}.`,
  c => `${b(c.loser)} counts ${numWord(c.count)} ${shipsWord(c.count)} missing near ${c.bodyLoc}; the attacker's identity remains a mystery${c.namesClause}.`,
  c => `Static and silence — that's all that's left at ${c.bodyLoc} after ${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `Investigators are combing the debris field at ${c.bodyLoc}, where ${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)} to persons unknown${c.namesClause}.`,
  c => `${b(c.loser)} has opened an inquiry after ${numWord(c.count)} ${shipsWord(c.count)} vanished near ${c.bodyLoc}${c.namesClause}.`,
];

const BATTLE_ONE_SIDED_UNKNOWN_HEADLINE = [
  c => `MYSTERY AT ${c.body.toUpperCase()}: ${c.loser.toUpperCase()} LOSES ${c.count === 1 ? 'A SHIP' : numWord(c.count).toUpperCase() + ' SHIPS'}`,
  c => `${c.loser.toUpperCase()} SHIPS VANISH NEAR ${c.body.toUpperCase()}`,
  c => `UNEXPLAINED LOSSES REPORTED AT ${c.body.toUpperCase()}`,
  c => `WHO ATTACKED ${c.loser.toUpperCase()}? ${c.body.toUpperCase()} INCIDENT BAFFLES ANALYSTS`,
  c => `NO ANSWERS AT ${c.body.toUpperCase()}`,
  c => `${c.loser.toUpperCase()} DEMANDS ANSWERS AFTER ${c.body.toUpperCase()} LOSSES`,
  c => `SHADOW ATTACK NEAR ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()}: THE ATTACKER NO ONE SAW`,
];

const BATTLE_MUTUAL = [
  c => `A fierce engagement erupted over ${c.bodyLoc} between ${b(c.factionA)} and ${b(c.factionB)}. When the dust settled, ${b(c.factionA)} had lost ${numWord(c.countA)} ${shipsWord(c.countA)}${c.namesAClause}, while ${b(c.factionB)} counted ${numWord(c.countB)} of their own destroyed${c.namesBClause}.`,
  c => `${c.bodyLoc} became a battlefield today as ${b(c.factionA)} and ${b(c.factionB)} traded blows — ${numWord(c.countA)} ${b(c.factionA)} ${shipsWord(c.countA)} down, ${numWord(c.countB)} from ${b(c.factionB)}.`,
  c => `Neither side backed down at ${c.bodyLoc}: ${b(c.factionA)} lost ${numWord(c.countA)}, ${b(c.factionB)} lost ${numWord(c.countB)}, and the standoff continues.`,
  c => `Mutual destruction at ${c.bodyLoc} — ${b(c.factionA)} (${numWord(c.countA)} ${shipsWord(c.countA)}) and ${b(c.factionB)} (${numWord(c.countB)} ${shipsWord(c.countB)}) both paid a steep price.`,
  c => `The battle for ${c.bodyLoc} has no clear victor: ${numWord(c.countA)} ${b(c.factionA)} vessel${plural(c.countA, '')} and ${numWord(c.countB)} ${b(c.factionB)} vessel${plural(c.countB, '')} now litter the wreckage field.`,
  c => `${b(c.factionA)} and ${b(c.factionB)} clashed violently over ${c.bodyLoc}, each side counting their dead — ${numWord(c.countA)} and ${numWord(c.countB)} ${shipsWord(c.countA + c.countB)} respectively.`,
  c => `Both fleets bled at ${c.bodyLoc} — ${b(c.factionA)} lost ${numWord(c.countA)}, ${b(c.factionB)} lost ${numWord(c.countB)}, and neither side is claiming victory.`,
  c => `${c.bodyLoc} is littered with hulls tonight: ${numWord(c.countA)} belonging to ${b(c.factionA)}, ${numWord(c.countB)} to ${b(c.factionB)}.`,
  c => `An ugly draw at ${c.bodyLoc} — ${b(c.factionA)} and ${b(c.factionB)} each limped away having lost ${numWord(c.countA)} and ${numWord(c.countB)} ${shipsWord(c.countA + c.countB)} respectively.`,
  c => `Both ${b(c.factionA)} and ${b(c.factionB)} are counting their dead at ${c.bodyLoc} tonight, ${numWord(c.countA)} and ${numWord(c.countB)} strong.`,
  c => `Nobody won at ${c.bodyLoc}. ${b(c.factionA)} lost ${numWord(c.countA)}; ${b(c.factionB)} lost ${numWord(c.countB)}. Both fleets have withdrawn.`,
  c => `A brutal exchange over ${c.bodyLoc} left ${b(c.factionA)} down ${numWord(c.countA)} and ${b(c.factionB)} down ${numWord(c.countB)}, with nothing decided.`,
];

const BATTLE_MUTUAL_HEADLINE = [
  c => `WAR ERUPTS AT ${c.body.toUpperCase()}`,
  c => `${c.factionA.toUpperCase()} AND ${c.factionB.toUpperCase()} CLASH OVER ${c.body.toUpperCase()}`,
  c => `BLOODY STALEMATE AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} BURNS AS TWO FLEETS COLLIDE`,
  c => `NEITHER SIDE YIELDS AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} A BLOODY DRAW`,
  c => `NO WINNERS AT ${c.body.toUpperCase()}`,
  c => `${c.factionA.toUpperCase()} VS ${c.factionB.toUpperCase()}: BOTH BLEED AT ${c.body.toUpperCase()}`,
  c => `MUTUAL LOSSES REPORTED AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} STANDOFF LEAVES BOTH FLEETS SHATTERED`,
];

// A reciprocal 2-faction battle where the casualty ratio is >=3x —
// both sides landed hits, but it's a rout, not a stalemate.
const BATTLE_DECISIVE = [
  c => `${b(c.winner)} won a decisive victory at ${c.bodyLoc}, losing only ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} while destroying ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `${b(c.loser)} put up a fight at ${c.bodyLoc}, but ${b(c.winner)} came out on top — ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} lost against just ${numWord(c.winnerCount)} for ${b(c.winner)}.`,
  c => `The numbers tell the story at ${c.bodyLoc}: ${b(c.winner)} dominated, trading ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} for ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `${b(c.winner)} emerged the clear victor at ${c.bodyLoc} despite resistance from ${b(c.loser)} — final count ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `A lopsided fight at ${c.bodyLoc}: ${b(c.loser)} lost ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} to ${b(c.winner)}'s ${numWord(c.winnerCount)}.`,
  c => `${b(c.winner)} made it look easy at ${c.bodyLoc}, giving up just ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to take ${numWord(c.loserCount)} from ${b(c.loser)}.`,
  c => `${b(c.loser)} paid dearly at ${c.bodyLoc}: ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} gone against a mere ${numWord(c.winnerCount)} for ${b(c.winner)}.`,
  c => `One-sided despite the fight: ${b(c.winner)} took ${c.bodyLoc}, losing ${numWord(c.winnerCount)} to ${b(c.loser)}'s ${numWord(c.loserCount)}.`,
  c => `${b(c.winner)} held the advantage from the opening shot at ${c.bodyLoc}, finishing ${numWord(c.loserCount)} to ${numWord(c.winnerCount)} over ${b(c.loser)}.`,
  c => `Command of ${c.bodyLoc} goes to ${b(c.winner)} after a decisive exchange — ${numWord(c.loserCount)} ${b(c.loser)} ${shipsWord(c.loserCount)} lost to just ${numWord(c.winnerCount)}.`,
];

const BATTLE_DECISIVE_HEADLINE = [
  c => `${c.winner.toUpperCase()} WINS DECISIVELY AT ${c.body.toUpperCase()}`,
  c => `${c.loser.toUpperCase()} OUTGUNNED AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} TAKES ${c.body.toUpperCase()} DESPITE RESISTANCE`,
  c => `LOPSIDED BATTLE AT ${c.body.toUpperCase()}: ${c.winner.toUpperCase()} PREVAILS`,
  c => `${c.winner.toUpperCase()} MAKES IT LOOK EASY AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} FALLS TO ${c.winner.toUpperCase()}`,
  c => `${c.loser.toUpperCase()} PAYS DEARLY AT ${c.body.toUpperCase()}`,
  c => `CLEAR WINNER AT ${c.body.toUpperCase()}: ${c.winner.toUpperCase()}`,
];

// A reciprocal 2-faction battle where the ratio is closer (1.5x-3x) —
// a real win, but a costly one, not a curb-stomp.
const BATTLE_NARROW = [
  c => `${b(c.winner)} narrowly held ${c.bodyLoc}, losing ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to claim ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `A costly win for ${b(c.winner)} at ${c.bodyLoc} — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost, but ${b(c.loser)} came off worse with ${numWord(c.loserCount)}.`,
  c => `${b(c.winner)} edged out ${b(c.loser)} at ${c.bodyLoc} in a hard-fought exchange: ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `Neither side left ${c.bodyLoc} unscathed, but ${b(c.winner)} claimed the field — ${numWord(c.loserCount)} ${b(c.loser)} ${shipsWord(c.loserCount)} down to ${numWord(c.winnerCount)} of their own.`,
  c => `${b(c.winner)} paid full price for ${c.bodyLoc}, trading ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} for ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `It could have gone either way at ${c.bodyLoc}. In the end ${b(c.winner)} held on, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `${b(c.loser)} made ${b(c.winner)} bleed for ${c.bodyLoc} — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost against ${numWord(c.loserCount)} of their own.`,
  c => `A grinding fight at ${c.bodyLoc} tips to ${b(c.winner)} by the narrowest of margins: ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
];

const BATTLE_NARROW_HEADLINE = [
  c => `${c.winner.toUpperCase()} CLAIMS COSTLY WIN AT ${c.body.toUpperCase()}`,
  c => `HARD-FOUGHT VICTORY FOR ${c.winner.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} EDGES OUT ${c.loser.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} SCRAPES BY AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} COULD HAVE GONE EITHER WAY`,
  c => `NARROW MARGIN DECIDES ${c.body.toUpperCase()}`,
];

const BATTLE_CHAOS = [
  c => `${c.bodyLoc} descended into chaos as ${numWord(c.sides.length)} factions clashed at once. Casualties: ${c.sideList}.`,
  c => `A free-for-all erupted at ${c.bodyLoc} — ${c.sideList}.`,
  c => `No fewer than ${numWord(c.sides.length)} powers traded fire over ${c.bodyLoc} today: ${c.sideList}.`,
  c => `The battle of ${c.bodyLoc} drew in ${numWord(c.sides.length)} factions before it was over: ${c.sideList}.`,
  c => `Nobody thought to call a truce at ${c.bodyLoc} — ${numWord(c.sides.length)} factions went in, and only wreckage came out: ${c.sideList}.`,
  c => `${c.bodyLoc} turned into a shooting gallery with ${numWord(c.sides.length)} sides trading fire at once: ${c.sideList}.`,
  c => `Total confusion reigned at ${c.bodyLoc} as ${numWord(c.sides.length)} powers collided: ${c.sideList}.`,
  c => `When the smoke cleared over ${c.bodyLoc}, ${numWord(c.sides.length)} factions were counting losses: ${c.sideList}.`,
];

const BATTLE_CHAOS_HEADLINE = [
  c => `CHAOS AT ${c.body.toUpperCase()}: ${numWord(c.sides.length).toUpperCase()}-WAY BATTLE ERUPTS`,
  c => `FREE-FOR-ALL AT ${c.body.toUpperCase()} LEAVES WRECKAGE ACROSS THE SYSTEM`,
  c => `${c.body.toUpperCase()} DESCENDS INTO CHAOS`,
  c => `EVERYONE'S AT WAR: MELEE ENGULFS ${c.body.toUpperCase()}`,
  c => `${numWord(c.sides.length).toUpperCase()}-SIDED BATTLE ROYALE AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} TURNS INTO A SHOOTING GALLERY`,
  c => `ANARCHY AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()}: WHEN EVERYONE SHOWED UP TO FIGHT`,
];

const ASTEROID_IMPACT = [
  c => `${c.attacker ? b(c.attacker) : 'An unknown aggressor'} hurled a rock across the void, striking ${c.bodyLoc} and scarring its surface for good.`,
  c => `An act of war: ${c.bodyLoc} took a direct asteroid impact today, its yields crippled for the foreseeable future.`,
  c => `The skies fell silent, then ${c.bodyLoc} was struck — ${c.attacker ? b(c.attacker) : 'the culprit'} claims the blow.`,
  c => `${c.bodyLoc} bears fresh scars after an asteroid strike widely attributed to ${c.attacker ? b(c.attacker) : 'unknown forces'}.`,
  c => `A kinetic strike hit ${c.bodyLoc} today, halving its productivity. ${c.attacker ? `${b(c.attacker)} is believed responsible.` : 'No one has claimed the attack.'}`,
  c => `${c.bodyLoc} took a rock to the face today — productivity is in ruins${c.attacker ? `, and ${b(c.attacker)} isn't denying involvement` : ', and the culprit is still unknown'}.`,
  c => `Sirens over ${c.bodyLoc}: a kinetic strike has left the surface scarred${c.attacker ? ` — ${b(c.attacker)} is the prime suspect` : ''}.`,
  c => `${c.attacker ? b(c.attacker) : 'Someone'} turned a rock into a weapon today, and ${c.bodyLoc} is paying for it.`,
  c => `No warning, no declaration — just a rock and a crater. ${c.bodyLoc} won't recover its old yields for some time${c.attacker ? `. ${b(c.attacker)} claims the strike` : ''}.`,
  c => `${c.bodyLoc} joins the list of worlds scarred by orbital bombardment${c.attacker ? `, courtesy of ${b(c.attacker)}` : ', attacker unconfirmed'}.`,
];

const ASTEROID_IMPACT_HEADLINE = [
  c => `ACT OF WAR: ${c.body.toUpperCase()} STRUCK BY ASTEROID`,
  c => `${(c.attacker ?? 'UNKNOWN FORCES').toUpperCase()} LAUNCHES ROCK AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} SCARRED IN KINETIC STRIKE`,
  c => `PANIC AS ASTEROID HITS ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} REELS FROM ORBITAL BOMBARDMENT`,
  c => `ROCK FALLS ON ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} CRATERED IN SURPRISE STRIKE`,
  c => `WHO THREW THE ROCK AT ${c.body.toUpperCase()}?`,
  c => `KINETIC WARFARE COMES TO ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} YIELDS CRIPPLED BY IMPACT`,
];

const SHIP_DETONATED = [
  c => `${b(c.actor)}'s ${c.shipName} went out in a blaze at ${c.bodyLoc} — the crew triggered the core rather than surrender, ${c.destroyedText}.`,
  c => `Rather than be boarded, ${b(c.actor)}'s ${c.shipName} self-destructed at ${c.bodyLoc}. ${c.destroyedText}.`,
  c => `${c.shipName} took itself apart at ${c.bodyLoc} in a final act of defiance — ${b(c.actor)} confirms the detonation, ${c.destroyedText}.`,
  c => `A last stand at ${c.bodyLoc}: ${b(c.actor)}'s ${c.shipName} blew its core rather than fall into enemy hands, ${c.destroyedText}.`,
  c => `The crew of ${c.shipName} chose the void over defeat, detonating at ${c.bodyLoc}. ${c.destroyedText}.`,
  c => `${b(c.actor)} lost ${c.shipName} to a deliberate detonation at ${c.bodyLoc} — ${c.destroyedText}.`,
  c => `No surrender at ${c.bodyLoc}: ${c.shipName} went up rather than go dark quietly, ${c.destroyedText}.`,
];

const SHIP_DETONATED_HEADLINE = [
  c => `SUICIDE STRIKE AT ${c.body.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SHIP SELF-DESTRUCTS AT ${c.body.toUpperCase()}`,
  c => `LAST STAND AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} ROCKED BY DELIBERATE BLAST`,
  c => `NO SURRENDER: ${c.actor.toUpperCase()} DETONATES AT ${c.body.toUpperCase()}`,
];

// Appended to a single-ship-loss battle story when that ship had a
// named captain aboard (worker/room.js now sends captain_name on
// ship_destroyed rows). Split lost/rescued/unknown because the
// captain's actual fate is a SEPARATE chronicle row (captain_lost /
// captain_rescued, fired by the same survival roll worker/room.js
// resolveCaptainOnDeath does right after the kill) — asserting "died"
// here would flatly contradict a rescue reported two lines down.
// Reserved for single-ship stories only: folding a name into an
// already-clustered multi-ship list reads as clutter, not gravity.
const CAPTAIN_LOST_CLAUSE = [
  name => ` Captain ${b(name)} died at the helm.`,
  name => ` Captain ${b(name)} went down with the ship.`,
  name => ` Command lists Captain ${b(name)} among the dead.`,
  name => ` Captain ${b(name)} did not survive the engagement.`,
  name => ` The name Captain ${b(name)} now joins the roll of the fallen.`,
  name => ` Captain ${b(name)} was still aboard when the hull gave out.`,
];

const CAPTAIN_RESCUED_CLAUSE = [
  name => ` Captain ${b(name)} was pulled from the wreck alive.`,
  name => ` Captain ${b(name)} survived and is already back on duty.`,
  name => ` A rescue craft reached Captain ${b(name)} before the hull cooled.`,
  name => ` Captain ${b(name)} made it out — the ship didn't.`,
  name => ` Command confirms Captain ${b(name)} recovered, shaken but alive.`,
  name => ` Captain ${b(name)} lives to fly again.`,
];

// When the captain's fate isn't resolved within THIS digest's window
// (rescued/lost row fell outside it, or the lookup simply missed) —
// say only what's certain: someone commanded the ship. No claim about
// what happened to them.
const CAPTAIN_UNKNOWN_FATE_CLAUSE = [
  name => ` Captain ${b(name)} was in command.`,
  name => ` Captain ${b(name)} was aboard at the time.`,
];

const INDUSTRY_BOTH = [
  c => `${b(c.faction)}'s shipyards ran hot today — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} launched${c.shipNamesClause}, alongside ${numWord(c.buildCount)} completed construction project${plural(c.buildCount, '')}.`,
  c => `Industry hums for ${b(c.faction)}: ${numWord(c.shipCount)} hulls rolled out${c.shipNamesClause}, and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} finished.`,
  c => `${b(c.faction)} expanded on every front today — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)}${c.shipNamesClause}, plus ${numWord(c.buildCount)} finished construction project${plural(c.buildCount, '')}.`,
  c => `Not a quiet day for ${b(c.faction)} — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} launched${c.shipNamesClause} and ${numWord(c.buildCount)} project${plural(c.buildCount, '')} closed out.`,
  c => `${b(c.faction)}'s engineers earned their pay today: ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)}${c.shipNamesClause}, ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} finished.`,
  c => `Both the yards and the crews delivered for ${b(c.faction)} — ${numWord(c.shipCount)} hull${plural(c.shipCount, '')}${c.shipNamesClause}, plus ${numWord(c.buildCount)} completed project${plural(c.buildCount, '')}.`,
];

const INDUSTRY_BOTH_HEADLINE = [
  c => `${c.faction.toUpperCase()} RAMPS UP PRODUCTION ON ALL FRONTS`,
  c => `BUSY DAY FOR ${c.faction.toUpperCase()} SHIPYARDS AND ENGINEERS`,
  c => `${c.faction.toUpperCase()} DELIVERS ON EVERY FRONT`,
  c => `A GOOD DAY FOR ${c.faction.toUpperCase()}'S ENGINEERS AND SHIPWRIGHTS`,
];

const INDUSTRY_SHIPS_ONLY = [
  c => `${b(c.faction)} launched ${numWord(c.count)} new ${shipsWord(c.count)} today${c.namesClause}.`,
  c => `Fresh hulls for ${b(c.faction)}: ${numWord(c.count)} ${shipsWord(c.count)} rolled out of the yards${c.namesClause}.`,
  c => `${b(c.faction)}'s shipyards delivered ${numWord(c.count)} vessel${plural(c.count, '')}${c.namesClause}.`,
  c => `The fleet of ${b(c.faction)} grows — ${numWord(c.count)} ${shipsWord(c.count)} commissioned${c.namesClause}.`,
  c => `${numWord(c.count)} new ${shipsWord(c.count)} joined ${b(c.faction)}'s ranks today${c.namesClause}.`,
  c => `${b(c.faction)} rolled ${numWord(c.count)} new hull${plural(c.count, '')} off the line${c.namesClause}.`,
  c => `${b(c.faction)} put ${numWord(c.count)} new ${shipsWord(c.count)} into service today${c.namesClause}.`,
  c => `Fresh off the line for ${b(c.faction)}: ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `${b(c.faction)}'s yards didn't rest today — ${numWord(c.count)} new hull${plural(c.count, '')}${c.namesClause}.`,
  c => `${numWord(c.count)} more ${shipsWord(c.count)} for ${b(c.faction)}'s growing fleet${c.namesClause}.`,
  c => `Crews cheered as ${numWord(c.count)} new ${shipsWord(c.count)} slid out of ${b(c.faction)}'s yards${c.namesClause}.`,
  c => `${b(c.faction)} announced ${numWord(c.count)} new commission${plural(c.count, '')} to the fleet register${c.namesClause}.`,
];

const INDUSTRY_SHIPS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS ITS FLEET`,
  c => `NEW HULLS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} SHIPYARDS DELIVER`,
  c => `FRESH HULLS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} PUTS NEW SHIPS TO SEA`,
  c => `${c.faction.toUpperCase()}'S FLEET GROWS AGAIN`,
];

const INDUSTRY_BUILDINGS_ONLY = [
  c => `${b(c.faction)} completed ${numWord(c.count)} construction project${plural(c.count, '')} today.`,
  c => `Infrastructure milestone for ${b(c.faction)}: ${numWord(c.count)} upgrade${plural(c.count, '')} finished.`,
  c => `${b(c.faction)}'s engineers finished ${numWord(c.count)} project${plural(c.count, '')} across their holdings.`,
  c => `Construction crews for ${b(c.faction)} closed out ${numWord(c.count)} project${plural(c.count, '')}.`,
  c => `${b(c.faction)}'s construction crews had a productive day — ${numWord(c.count)} project${plural(c.count, '')} finished.`,
  c => `No new hulls for ${b(c.faction)} today, but ${numWord(c.count)} upgrade${plural(c.count, '')} came online.`,
  c => `${b(c.faction)} strengthened its holdings with ${numWord(c.count)} completed upgrade${plural(c.count, '')}.`,
  c => `Quiet but steady progress for ${b(c.faction)}: ${numWord(c.count)} construction project${plural(c.count, '')} wrapped up.`,
];

const INDUSTRY_BUILDINGS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} UPGRADES INFRASTRUCTURE`,
  c => `CONSTRUCTION MILESTONE FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STRENGTHENS ITS HOLDINGS`,
  c => `STEADY PROGRESS FOR ${c.faction.toUpperCase()}`,
];

// The below-threshold "everyone else" line — see
// INDUSTRY_COLLAPSE_THRESHOLD. Deliberately low-key phrasing; this is
// the digest's equivalent of small print, not a headline.
const INDUSTRY_COLLAPSED = [
  c => `Elsewhere in the system, smaller yards stayed busy — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} completed across ${numWord(c.factionCount)} ${plural(c.factionCount, 'faction')}, led by ${b(c.leader)}.`,
  c => `Routine industry across the rest of the system: ${numWord(c.totalShips)} new ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} finished project${plural(c.totalBuilds, '')}, with ${b(c.leader)} out front.`,
  c => `Minor shipyards kept humming — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} logged among ${numWord(c.factionCount)} smaller powers, ${b(c.leader)} chief among them.`,
  c => `Quiet but steady: ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'faction')} together finished ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')}, ${b(c.leader)} leading the pack.`,
  c => `Small yards, steady work: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} across the rest of the field, ${b(c.leader)} ahead of the pack.`,
  c => `The lesser powers weren't idle either — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} completed project${plural(c.totalBuilds, '')} between them, ${b(c.leader)} in front.`,
];

const INDUSTRY_COLLAPSED_HEADLINE = [
  () => `INDUSTRY TICKS ALONG ACROSS THE SYSTEM`,
  () => `A QUIET DAY IN THE YARDS`,
  c => `${c.leader.toUpperCase()} LEADS A ROUTINE DAY OF INDUSTRY`,
  () => `SMALL YARDS, STEADY WORK`,
];

const COLONY_FOUNDED = [
  c => `${b(c.faction)} broke ground on ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Expansion continues for ${b(c.faction)} — ${numWord(c.count)} new outpost${plural(c.count, '')} established${c.entriesClause}.`,
  c => `${b(c.faction)} planted ${numWord(c.count)} new flag${plural(c.count, '')} in the system${c.entriesClause}.`,
  c => `New territory for ${b(c.faction)}: ${numWord(c.count)} settlement${plural(c.count, '')} founded${c.entriesClause}.`,
  c => `${b(c.faction)}'s colonists made landfall — ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} put down roots again — ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `The frontier shrinks a little more: ${b(c.faction)} founded ${numWord(c.count)} settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} claimed new ground today, with ${numWord(c.count)} settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Colonists under ${b(c.faction)}'s banner broke ground on ${numWord(c.count)} new site${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} added ${numWord(c.count)} settlement${plural(c.count, '')} to its holdings${c.entriesClause}.`,
];

const COLONY_FOUNDED_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS THE FRONTIER`,
  c => `NEW SETTLEMENTS RISE FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STAKES NEW CLAIM`,
  c => `${c.faction.toUpperCase()} PLANTS ITS FLAG`,
  c => `${c.faction.toUpperCase()} PUTS DOWN ROOTS`,
  c => `THE FRONTIER SHRINKS: ${c.faction.toUpperCase()} EXPANDS`,
  c => `${c.faction.toUpperCase()} CLAIMS NEW GROUND`,
  c => `NEW COLONIES FOR ${c.faction.toUpperCase()}`,
];

const FACTION_ARRIVAL = [
  c => `${b(c.faction)} has entered the system, establishing their capital at ${c.bodyLoc}.`,
  c => `A new power rises: ${b(c.faction)} stakes their claim at ${c.bodyLoc}.`,
  c => `${b(c.faction)} joins the fray, founding their homeworld on ${c.bodyLoc}.`,
  c => `Newcomers to the system: ${b(c.faction)} has arrived and settled at ${c.bodyLoc}.`,
  c => `The system has a new player: ${b(c.faction)} makes ${c.bodyLoc} home.`,
  c => `${b(c.faction)} steps onto the stage, raising its banner over ${c.bodyLoc}.`,
  c => `Word spreads of a new faction — ${b(c.faction)}, now settled at ${c.bodyLoc}.`,
  c => `${c.bodyLoc} welcomes its newest resident: ${b(c.faction)}.`,
];

const FACTION_ARRIVAL_HEADLINE = [
  c => `NEW POWER ENTERS THE SYSTEM: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ARRIVES, SETTLES ${c.body.toUpperCase()}`,
  c => `A NEW FLAG FLIES OVER ${c.body.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STEPS ONTO THE STAGE`,
  c => `WHO IS ${c.faction.toUpperCase()}?`,
  c => `${c.body.toUpperCase()} WELCOMES A NEW FLAG`,
];

const DISCOVERY_LEADIN = [
  'Word from the frontier: ',
  'Scouts report: ',
  'A dispatch just in — ',
  'From the outer reaches: ',
  'Explorers have uncovered something: ',
  'Field notes from the edge of the system: ',
  'Fresh off the wire: ',
  'A courier ship just docked with news: ',
  'From the edge of the charts: ',
  'Survey logs, just released: ',
  'Word reaches the Herald: ',
  'Out past the shipping lanes: ',
];

const DISCOVERY_HEADLINE = [
  c => `ANCIENT SECRETS UNCOVERED AT ${c.bodyName.toUpperCase()}`,
  c => `MYSTERY SOLVED AT ${c.bodyName.toUpperCase()}`,
  c => `EXPEDITION STRIKES GOLD AT ${c.bodyName.toUpperCase()}`,
  c => `THE PAST SPEAKS: DISCOVERY AT ${c.bodyName.toUpperCase()}`,
  c => `WHAT WAS FOUND AT ${c.bodyName.toUpperCase()}?`,
  c => `${c.faction.toUpperCase()} STRIKES IT RICH AT ${c.bodyName.toUpperCase()}`,
  c => `SECRETS OF ${c.bodyName.toUpperCase()} REVEALED`,
  c => `${c.faction.toUpperCase()} UNEARTHS THE UNKNOWN AT ${c.bodyName.toUpperCase()}`,
  c => `WHAT SLEPT BENEATH ${c.bodyName.toUpperCase()}?`,
  c => `HISTORY UNEARTHED AT ${c.bodyName.toUpperCase()}`,
];

// Third-person newspaper payoffs, one array per BodySecretKind — 2
// phrasings each for a little variety without a huge bank. Rendered
// off the chronicle row's structured `kind` field, NOT scraped from
// free text: the old approach regex-matched worker/room.js's
// chronicleMessage, which is hand-duplicated (and can drift) from
// src/game/secrets.ts, and both copies are written in second person
// ("your banner," "your pool") for the in-game toast — exactly wrong
// for a third-person in-world paper, and with no faction attribution
// at all since the raw text never named anyone.
const DISCOVERY_PAYOFFS = {
  portal_to_sun: [
    'uncovered an ancient stargate — every ship arriving here now warps straight to Sol',
    'found a stargate buried in the old rock; the passage now flings arriving hulls back to Sol',
  ],
  warp_gate: [
    'stumbled on a warp gate that flings arriving ships clear across the void',
    'activated a dormant warp gate — a shortcut now spans the void for anyone who arrives here',
  ],
  ancient_city: [
    'reactivated a long-abandoned colony — a free city, complete with a working Lab, now flies their banner',
    'breathed life back into a buried settlement; a new city and its Lab are now theirs to keep',
  ],
  free_collector: [
    'revived a derelict freight hub — a free city and collector now widen their logistics network',
    'got an old cargo relay humming again, adding a free city and collector to their holdings',
  ],
  derelict_warship: [
    'salvaged a derelict destroyer drifting in the dark, claiming the hulk for their fleet',
    'found a dead warship still spaceworthy and towed it home to their yards',
  ],
  resource_cache: [
    'unearthed a buried cache — 500 metal and 500 credits added to their coffers',
    'cracked open a forgotten stockpile, walking away with 500 metal and 500 credits',
  ],
};
const DISCOVERY_PAYOFF_FALLBACK = 'uncovered a secret whose full nature the histories do not record';

/** ancient_databank is the one kind with a genuinely dynamic detail —
 *  which tech track leveled up (worker/room.js picks it at random and
 *  now stores it as payload.tech_id). Built at call time instead of
 *  living in the static DISCOVERY_PAYOFFS map. */
function databankPayoffs(techName) {
  const t = techName || 'a hidden discipline';
  return [
    `cracked an intact databank, teaching their engineers a trick worth a level in ${t}`,
    `recovered a functioning databank — their engineers walked away a level wiser in ${t}`,
  ];
}

const TREATY_SIGNED = [
  c => `${b(c.a)} and ${b(c.b)} have signed ${c.pactName}, formalizing new terms between their peoples.`,
  c => `Diplomats rejoice: ${b(c.a)} and ${b(c.b)} inked ${c.pactName} today.`,
  c => `${b(c.a)} and ${b(c.b)} put pen to paper on ${c.pactName}.`,
  c => `A new accord: ${b(c.a)} and ${b(c.b)} have agreed to ${c.pactName}.`,
  c => `${b(c.a)} and ${b(c.b)} have found common ground, agreeing to ${c.pactName}.`,
  c => `Pens moved and terms were struck: ${b(c.a)} and ${b(c.b)} now stand under ${c.pactName}.`,
  c => `After quiet talks, ${b(c.a)} and ${b(c.b)} have committed to ${c.pactName}.`,
  c => `${b(c.a)} extends a hand to ${b(c.b)} — ${c.pactName} is now in effect.`,
];

const TREATY_SIGNED_HEADLINE = [
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} SIGN HISTORIC ACCORD`,
  c => `PEACE AT LAST: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} INK DEAL`,
  c => `NEW ALLIANCE: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} FORMALIZE TIES`,
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} FIND COMMON GROUND`,
  c => `ACCORD REACHED BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} EXTENDS A HAND TO ${c.b.toUpperCase()}`,
];

const TREATY_BROKEN = [
  c => `${b(c.a)} tore up their pact with ${b(c.b)} — the accord lies in ruins.`,
  c => `Diplomacy fails: ${b(c.a)} has broken their treaty with ${b(c.b)}.`,
  c => `The peace between ${b(c.a)} and ${b(c.b)} is over.`,
  c => `${b(c.a)} has withdrawn from its agreement with ${b(c.b)}, effective immediately.`,
  c => `Trust is gone between ${b(c.a)} and ${b(c.b)} — the accord is dead.`,
  c => `${b(c.a)} has walked away from the table with ${b(c.b)}, treaty in tatters.`,
  c => `Whatever peace existed between ${b(c.a)} and ${b(c.b)} is finished as of today.`,
  c => `${b(c.a)} tears up the ink shared with ${b(c.b)}. The two are on their own again.`,
];

const TREATY_BROKEN_HEADLINE = [
  c => `CEASEFIRE COLLAPSES: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} AT ODDS AGAIN`,
  c => `${c.a.toUpperCase()} TEARS UP PACT WITH ${c.b.toUpperCase()}`,
  c => `DIPLOMACY FAILS BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `ALLIANCE IN RUINS: ${c.a.toUpperCase()} WALKS AWAY FROM ${c.b.toUpperCase()}`,
  c => `ACCORD DEAD: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} WALKS AWAY FROM THE TABLE`,
  c => `TRUST BROKEN BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()}: BACK TO SQUARE ONE`,
];

const SENATE_PASSED = [
  c => `The Senate has passed "${c.title}" — the ${b(c.actor)} delegation's motion carries.`,
  c => `By vote of the assembly, "${c.title}" is now law.`,
  c => `The chamber rules in favor: "${c.title}" passes.`,
  c => `Lawmakers have given "${c.title}" the green light.`,
  c => `It's official: "${c.title}" clears the Senate floor.`,
  c => `After debate, the chamber sides with "${c.title}".`,
];

const SENATE_PASSED_HEADLINE = [
  c => `SENATE PASSES "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS APPROVE "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" CLEARS THE SENATE`,
  c => `CHAMBER SIDES WITH "${c.title.toUpperCase()}"`,
];

const SENATE_FAILED = [
  c => `The Senate has rejected "${c.title}", proposed by ${b(c.actor)}.`,
  c => `"${c.title}" fails to carry the chamber.`,
  c => `The assembly votes down "${c.title}".`,
  c => `Lawmakers weren't convinced — "${c.title}" goes down.`,
  c => `The gavel falls against "${c.title}".`,
  c => `"${c.title}" couldn't find the votes it needed.`,
];

const SENATE_FAILED_HEADLINE = [
  c => `SENATE REJECTS "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS BLOCK "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" GOES DOWN`,
  c => `GAVEL FALLS AGAINST "${c.title.toUpperCase()}"`,
];

const VICTORY = [
  c => `${b(c.faction)} stands triumphant — victory is theirs.`,
  c => `The long campaign is over: ${b(c.faction)} has won.`,
  c => `History remembers this day: ${b(c.faction)} claims final victory.`,
  c => `It is finished. ${b(c.faction)} rules the system.`,
  c => `${b(c.faction)} has achieved what no other power could — total victory.`,
  c => `The war is done, and ${b(c.faction)} is left standing.`,
  c => `Every rival has fallen or bowed. ${b(c.faction)} rules alone.`,
  c => `The Herald closes this chapter with ${b(c.faction)} victorious.`,
  c => `In the end, only ${b(c.faction)} remained. The system is theirs.`,
  c => `Let the record show: ${b(c.faction)} won the war.`,
];

const VICTORY_HEADLINE = [
  c => `${c.faction.toUpperCase()} WINS THE WAR`,
  c => `VICTORY: ${c.faction.toUpperCase()} TRIUMPHANT`,
  c => `IT IS OVER — ${c.faction.toUpperCase()} REIGNS SUPREME`,
  c => `${c.faction.toUpperCase()} CLAIMS FINAL VICTORY`,
  c => `HISTORY IS MADE: ${c.faction.toUpperCase()} PREVAILS`,
  c => `${c.faction.toUpperCase()} STANDS ALONE`,
  c => `THE WAR IS OVER`,
  c => `${c.faction.toUpperCase()} WRITES THE FINAL CHAPTER`,
  c => `ALL HAIL ${c.faction.toUpperCase()}`,
  c => `THE LAST FLAG STANDING: ${c.faction.toUpperCase()}`,
];

const ELIMINATION = [
  c => `${b(c.faction)} has fallen. Their banners lie in the dust.`,
  c => `The story of ${b(c.faction)} ends here.`,
  c => `${b(c.faction)} has been eliminated from the system.`,
  c => `${b(c.faction)}'s flag has come down for the last time.`,
  c => `No more ships, no more worlds. ${b(c.faction)} is gone.`,
  c => `The system will not remember ${b(c.faction)} kindly, but it will not remember them long either — they are finished.`,
];

const ELIMINATION_HEADLINE = [
  c => `${c.faction.toUpperCase()} FALLS`,
  c => `THE END FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ELIMINATED FROM THE SYSTEM`,
  c => `${c.faction.toUpperCase()}'S FLAG COMES DOWN`,
  c => `GONE: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} WIPED FROM THE MAP`,
];

const TRADE_LEDGER = [
  c => `${numWord(c.count)} freighter ${c.count === 1 ? 'delivery' : 'deliveries'} completed across all routes today.`,
  c => `The logistics corps moved ${numWord(c.count)} shipment${plural(c.count, '')} safely to port.`,
  c => `${numWord(c.count)} successful cargo run${plural(c.count, '')} recorded across the system.`,
  c => `Merchant fleets completed ${numWord(c.count)} delivery run${plural(c.count, '')} today.`,
  c => `Trade never stopped — ${numWord(c.count)} run${plural(c.count, '')} logged by the merchant marine today.`,
  c => `The markets stayed open: ${numWord(c.count)} cargo transfer${plural(c.count, '')} cleared without incident.`,
  c => `Quiet efficiency from the trade lanes — ${numWord(c.count)} delivery run${plural(c.count, '')} completed.`,
  c => `${numWord(c.count)} freighter run${plural(c.count, '')} closed out the ledgers today.`,
];

const QUIET_DAY_HEADLINE = [
  () => 'ALL QUIET ACROSS THE SYSTEM',
  () => 'A DAY OF PEACE — NOTHING TO REPORT',
  () => 'THE VOID HOLDS ITS BREATH',
  () => 'SLOW NEWS DAY IN THE BLACK',
  () => 'NOTHING TO REPORT TODAY',
  () => 'THE HERALD FINDS LITTLE TO PRINT',
  () => 'CALM SKIES ACROSS THE SYSTEM',
  () => 'A RARE MOMENT OF PEACE',
];

const QUIET_DAY_BODY = [
  () => 'No battles, no new colonies, no discoveries to report since the last edition. The presses idle; the void abides.',
  () => 'The system rests today. Every faction holds its position; nothing more to tell.',
  () => 'A rare calm has settled over the system. Even the merchants have little to report.',
  () => 'Correspondents across the system report nothing worth the ink today.',
  () => 'For once, the front page has nowhere to point.',
  () => 'The factions held their positions and their fire alike. Nothing more to add.',
];

/** Fixed tail bank for a section's overflow ("...and N more incidents
 *  to report") — was a single hardcoded string, which meant the exact
 *  same sentence closed out multiple sections in the same edition. */
const MORE_INCIDENTS_TAIL = [
  (n, s) => `…and ${n} more incident${s} to report.`,
  (n, s) => `…plus ${n} additional incident${s} logged by our correspondents.`,
  (n, s) => `…with ${n} further incident${s} awaiting fuller coverage.`,
  (n, s) => `…and ${n} more incident${s} the wire hasn't room to print.`,
  (n, s) => `…and ${n} more incident${s} besides.`,
  (n, s) => `…${n} more incident${s} came in too late to make the front page.`,
];

// Shared between buildPoliticsStories (treaty_signed) and
// buildTradeStories (a trade that bundled a pact) so the two don't
// carry independent copies that could drift.
const PACT_NAMES = {
  defense_pact: 'a defense pact',
  nap: 'a non-aggression pact',
  trade_agreement: 'a trade agreement',
};

const TRADE_ACCEPTED = [
  c => `${b(c.proposer)} and ${b(c.responder)} struck a deal — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `A trade cleared between ${b(c.proposer)} and ${b(c.responder)}: ${c.offerText} changed hands for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.proposer)} sent ${c.offerText} to ${b(c.responder)} and got ${c.requestText} in return${c.pactClause}.`,
  c => `The merchants close the books on a new arrangement — ${b(c.proposer)} traded ${c.offerText} to ${b(c.responder)} for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.responder)} accepted terms from ${b(c.proposer)}: ${c.requestText} for ${c.offerText}${c.pactClause}.`,
  c => `A quiet exchange between ${b(c.proposer)} and ${b(c.responder)} — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
];

const TRADE_ACCEPTED_HEADLINE = [
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} STRIKE A DEAL`,
  c => `NEW TRADE BETWEEN ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
  c => `${c.proposer.toUpperCase()} CUTS A DEAL WITH ${c.responder.toUpperCase()}`,
  c => `MERCHANTS SEAL EXCHANGE: ${c.proposer.toUpperCase()} / ${c.responder.toUpperCase()}`,
];

const BUILDS_DESTROYED = [
  c => `${b(c.actor)}'s shipyard at ${c.bodyLoc} went up along with everything on the slipways — ${c.countText} lost mid-build.`,
  c => `Construction never finished at ${c.bodyLoc}: ${b(c.actor)}'s yard was hit, taking ${c.countText} down with it.`,
  c => `${c.countText} died on the slipways at ${c.bodyLoc} when ${b(c.actor)}'s shipyard was destroyed before the hulls could launch.`,
  c => `${b(c.actor)} loses more than a building at ${c.bodyLoc} — the yard's destruction took ${c.countText} still under construction.`,
];

const BUILDS_DESTROYED_HEADLINE = [
  c => `${c.body.toUpperCase()} YARD DESTROYED MID-BUILD`,
  c => `${c.actor.toUpperCase()} LOSES SHIPYARD AND SLIPWAYS AT ${c.body.toUpperCase()}`,
  c => `UNFINISHED HULLS LOST IN ${c.body.toUpperCase()} STRIKE`,
];

const SHIP_RETREATED = [
  c => `${b(c.actor)}'s ${c.shipName} broke off from ${c.fromLoc}${c.hpText}, falling back to ${c.toLoc} for repairs.`,
  c => `Battered but afloat: ${b(c.actor)}'s ${c.shipName} disengaged at ${c.fromLoc}${c.hpText} and is running for ${c.toLoc}.`,
  c => `${c.shipName} pulled out of the fight at ${c.fromLoc}${c.hpText} — ${b(c.actor)} is routing it to ${c.toLoc}.`,
  c => `${b(c.actor)} pulled ${c.shipName} back from ${c.fromLoc}${c.hpText} rather than lose it. Bound for ${c.toLoc}.`,
];

const SHIP_RETREATED_HEADLINE = [
  c => `${c.actor.toUpperCase()} PULLS BACK FROM ${c.fromBody.toUpperCase()}`,
  c => `${c.shipName.toUpperCase()} DISENGAGES AT ${c.fromBody.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SHIP LIMPS TOWARD ${c.toBody.toUpperCase()}`,
];

// ------------------------------------------------------------
// Story builders — cluster raw chronicle rows into narrative units
// per section, then render each via the phrase banks above. Every
// story returned is { text, headline, weight }.
// ------------------------------------------------------------

/** captain_name -> 'lost' | 'rescued', built from captain_lost /
 *  captain_rescued rows in the same digest window. Both are chronicled
 *  separately from the ship_destroyed row they belong to (see
 *  worker/room.js resolveCaptainOnDeath), so a battle story that wants
 *  to name a captain's fate has to cross-reference rather than assume. */
function buildCaptainFateMap(rows) {
  const fate = new Map();
  for (const row of rows) {
    if (row.kind !== 'captain_lost' && row.kind !== 'captain_rescued') continue;
    const p = safeJson(row.payload);
    if (typeof p.captain_name === 'string' && p.captain_name) {
      fate.set(p.captain_name, row.kind === 'captain_lost' ? 'lost' : 'rescued');
    }
  }
  return fate;
}

function buildBattleStories(rows, used, locator, captainFate) {
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
    if (!cluster.losses.has(owner)) {
      cluster.losses.set(owner, { shipNames: [], shipCaptains: [], settlementNames: [], settlementPop: 0, count: 0, killers: new Map() });
    }
    const bucket = cluster.losses.get(owner);
    bucket.count += 1;
    if (row.kind === 'ship_destroyed') {
      if (p.ship_name) bucket.shipNames.push(p.ship_name);
      if (typeof p.captain_name === 'string' && p.captain_name) bucket.shipCaptains.push(p.captain_name);
    }
    if (row.kind === 'settlement_destroyed') {
      if (p.settlement_name) bucket.settlementNames.push(p.settlement_name);
      bucket.settlementPop += Number(p.pop_lost) || 0;
    }
    bucket.killers.set(killer, (bucket.killers.get(killer) ?? 0) + 1);
  }

  for (const [bodyId, cluster] of byBody) {
    const locBody = locate(locator, bodyId === 'unknown' ? null : bodyId, cluster.body);
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
      const names = nameList([...bucket.shipNames], 2, used);
      const ctx = {
        loser: owner, winner, body: locBody.name, bodyLoc: locBody.full, count: bucket.count,
        namesClause: names ? `, including ${names}` : '',
      };
      let extra = settlementLossClause(bucket.settlementNames, bucket.settlementPop, used);
      // Only for a single named ship — a multi-ship loss already gets
      // its gravity from the casualty count + ship-name list, and
      // stacking captain names onto that list would clutter rather
      // than add weight.
      if (bucket.count === 1 && bucket.shipCaptains.length === 1) {
        const capName = bucket.shipCaptains[0];
        const capFate = captainFate.get(capName);
        // Distinct bank + key per fate rather than one shared key across
        // three differently-sized banks — pickTemplate's "don't repeat"
        // tracking is per bank-name, and mixing banks under one key
        // would muddy that rotation for no benefit.
        const [bankName, bank] = capFate === 'lost' ? ['captain_lost_clause', CAPTAIN_LOST_CLAUSE]
          : capFate === 'rescued' ? ['captain_rescued_clause', CAPTAIN_RESCUED_CLAUSE]
          : ['captain_unknown_clause', CAPTAIN_UNKNOWN_FATE_CLAUSE];
        extra += pickTemplate(bankName, bank, used)(capName);
      }
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * bucket.count;
      stories.push(winner
        ? mkStory(weight, used, 'battle_one_sided', BATTLE_ONE_SIDED_KNOWN, 'battle_one_sided_hl', BATTLE_ONE_SIDED_KNOWN_HEADLINE, ctx, extra)
        : mkStory(weight, used, 'battle_unknown', BATTLE_ONE_SIDED_UNKNOWN, 'battle_unknown_hl', BATTLE_ONE_SIDED_UNKNOWN_HEADLINE, ctx, extra));
    } else if (victims.length === 2 && killerSet.size === 2 && victims.every(v => killerSet.has(v))) {
      // Reciprocal: both victims are also credited as killers of the
      // other — a real two-sided battle. Classify the OUTCOME by
      // casualty ratio rather than assuming "both sides lost ships"
      // automatically means "no clear victor" — 7 losses vs 1 is a
      // rout, not a stalemate.
      const [fa, fb] = victims;
      const bucketA = cluster.losses.get(fa);
      const bucketB = cluster.losses.get(fb);
      const countA = bucketA.count;
      const countB = bucketB.count;
      const total = countA + countB;
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * total;

      let settlementExtra = '';
      const settlementLosers = [];
      if (bucketA.settlementNames.length) settlementLosers.push({ who: fa, names: bucketA.settlementNames, pop: bucketA.settlementPop });
      if (bucketB.settlementNames.length) settlementLosers.push({ who: fb, names: bucketB.settlementNames, pop: bucketB.settlementPop });
      if (settlementLosers.length > 0) {
        settlementExtra = ' ' + settlementLosers.map(s => {
          const many = s.names.length > 1;
          const popClause = s.pop > 0 ? ` — home to ${formatPopulation(s.pop)} —` : '';
          return `${b(s.who)} also lost the settlement${many ? 's' : ''} ${nameList(s.names, 2, used)}${popClause} in the fighting.`;
        }).join(' ');
      }

      const lo = Math.min(countA, countB);
      const hi = Math.max(countA, countB);
      const ratio = hi / Math.max(1, lo);

      if (ratio < BATTLE_NARROW_RATIO) {
        // Genuinely close — true "no clear victor."
        const namesA = nameList(bucketA.shipNames, 2, used);
        const namesB = nameList(bucketB.shipNames, 2, used);
        const ctx = {
          factionA: fa, countA, namesAClause: namesA ? ` (${namesA})` : '',
          factionB: fb, countB, namesBClause: namesB ? ` (${namesB})` : '',
          body: locBody.name, bodyLoc: locBody.full,
        };
        stories.push(mkStory(weight, used, 'battle_mutual', BATTLE_MUTUAL, 'battle_mutual_hl', BATTLE_MUTUAL_HEADLINE, ctx, settlementExtra));
      } else {
        const winner = countA <= countB ? fa : fb;
        const loser = countA <= countB ? fb : fa;
        const winnerCount = lo;
        const loserCount = hi;
        const ctx = { winner, loser, winnerCount, loserCount, body: locBody.name, bodyLoc: locBody.full };
        if (ratio >= BATTLE_DECISIVE_RATIO) {
          stories.push(mkStory(weight, used, 'battle_decisive', BATTLE_DECISIVE, 'battle_decisive_hl', BATTLE_DECISIVE_HEADLINE, ctx, settlementExtra));
        } else {
          stories.push(mkStory(weight, used, 'battle_narrow', BATTLE_NARROW, 'battle_narrow_hl', BATTLE_NARROW_HEADLINE, ctx, settlementExtra));
        }
      }
    } else {
      // 3+ factions, or an asymmetric shape — describe as chaos.
      const sides = victims
        .map(v => ({ faction: v, count: cluster.losses.get(v).count }))
        .sort((a, c) => c.count - a.count);
      const sideList = sides.map(s => `${b(s.faction)} lost ${numWord(s.count)}`).join('; ');
      const total = sides.reduce((s, x) => s + x.count, 0);
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * total;
      stories.push(mkStory(weight, used, 'battle_chaos', BATTLE_CHAOS, 'battle_chaos_hl', BATTLE_CHAOS_HEADLINE, { body: locBody.name, bodyLoc: locBody.full, sides, sideList }));
    }
  }

  // --- asteroid impacts: always their own dramatic mini-story ---
  for (const row of rows) {
    if (row.kind !== 'asteroid_impact') continue;
    const p = safeJson(row.payload);
    const attacker = p.attacker_faction_name ?? null; // not currently stored, kept forward-compat
    const locBody = locate(locator, row.body_id, p.target_name ?? 'a nearby world');
    const ctx = { attacker, body: locBody.name, bodyLoc: locBody.full };
    stories.push(mkStory(700, used, 'asteroid_impact', ASTEROID_IMPACT, 'asteroid_impact_hl', ASTEROID_IMPACT_HEADLINE, ctx));
  }

  // --- ship detonations: a deliberate self-destruct, always dramatic ---
  for (const row of rows) {
    if (row.kind !== 'ship_detonated') continue;
    const p = safeJson(row.payload);
    const destroyedCount = Number(p.destroyed_count) || 0;
    const destroyedText = destroyedCount > 0
      ? `taking ${numWord(destroyedCount)} ${shipsWord(destroyedCount)} down with it`
      : 'though the blast caught nothing else';
    const locBody = locate(locator, row.body_id, p.body_name ?? 'deep space');
    const ctx = {
      actor: p.owner_faction_name ?? 'An unknown faction',
      shipName: p.ship_name ?? 'a ship',
      body: locBody.name, bodyLoc: locBody.full, destroyedText,
    };
    const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * (destroyedCount + 1);
    stories.push(mkStory(weight, used, 'ship_detonated', SHIP_DETONATED, 'ship_detonated_hl', SHIP_DETONATED_HEADLINE, ctx));
  }

  // --- shipyards destroyed mid-build, alongside a settlement loss ---
  for (const row of rows) {
    if (row.kind !== 'builds_destroyed') continue;
    const p = safeJson(row.payload);
    const count = Number(p.builds_lost) || 0;
    if (count <= 0) continue;
    const locBody = locate(locator, row.body_id, p.body_name ?? 'a nearby world');
    const ctx = {
      actor: p.owner_faction_name ?? 'An unknown faction',
      body: locBody.name, bodyLoc: locBody.full,
      countText: `${numWord(count)} ${shipsWord(count)}`,
    };
    const weight = 300 + BATTLE_PER_CASUALTY * count;
    stories.push(mkStory(weight, used, 'builds_destroyed', BUILDS_DESTROYED, 'builds_destroyed_hl', BUILDS_DESTROYED_HEADLINE, ctx));
  }

  // --- ships retreating from a fight — low-weight status update, not
  // a casualty, so it'll never outrank a real loss for the headline,
  // and is the first thing MAX_STORIES_PER_SECTION truncates away on
  // a heavy battle day (it's appended last, and the section isn't
  // otherwise weight-sorted). ---
  for (const row of rows) {
    if (row.kind !== 'ship_retreated') continue;
    const p = safeJson(row.payload);
    const fromLoc = locate(locator, row.body_id ?? p.from_body_id, p.from_body_name ?? 'the line');
    const toLoc = locate(locator, p.to_body_id, p.to_body_name ?? 'a friendly yard');
    const hp = Number(p.hp);
    const hpMax = Number(p.hp_max);
    const hpText = Number.isFinite(hp) && Number.isFinite(hpMax) && hpMax > 0
      ? ` at ${Math.round((hp / hpMax) * 100)}% HP`
      : '';
    const ctx = {
      actor: p.owner_faction_name ?? 'An unknown faction',
      shipName: p.ship_name ?? 'a ship',
      fromLoc: fromLoc.full, fromBody: fromLoc.name,
      toLoc: toLoc.full, toBody: toLoc.name,
      hpText,
    };
    stories.push(mkStory(150, used, 'ship_retreated', SHIP_RETREATED, 'ship_retreated_hl', SHIP_RETREATED_HEADLINE, ctx));
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
  // Factions big enough to earn their own paragraph vs. everyone else,
  // who get rolled into one combined line (INDUSTRY_COLLAPSE_THRESHOLD)
  // — otherwise every faction with a single freighter gets a headline
  // slot every single edition, which drowns the section in wallpaper.
  const collapsed = [];
  for (const [faction, bucket] of byFaction) {
    const shipCount = bucket.ships.length;
    const buildCount = bucket.builds.length;
    const total = shipCount + buildCount;
    if (total === 0) continue;
    if (total < INDUSTRY_COLLAPSE_THRESHOLD) {
      collapsed.push({ faction, shipCount, buildCount, total });
      continue;
    }
    const shipNames = nameList(bucket.ships, 2, used);
    const shipNamesClause = shipNames ? ` — ${shipNames}` : '';
    const weight = 40 + 3 * total; // routine news — rarely the headline
    if (shipCount > 0 && buildCount > 0) {
      stories.push(mkStory(weight, used, 'industry_both', INDUSTRY_BOTH, 'industry_both_hl', INDUSTRY_BOTH_HEADLINE, { faction, shipCount, buildCount, shipNamesClause }));
    } else if (shipCount > 0) {
      stories.push(mkStory(weight, used, 'industry_ships', INDUSTRY_SHIPS_ONLY, 'industry_ships_hl', INDUSTRY_SHIPS_ONLY_HEADLINE, { faction, count: shipCount, namesClause: shipNamesClause }));
    } else {
      stories.push(mkStory(weight, used, 'industry_builds', INDUSTRY_BUILDINGS_ONLY, 'industry_builds_hl', INDUSTRY_BUILDINGS_ONLY_HEADLINE, { faction, count: buildCount }));
    }
  }

  if (collapsed.length > 0) {
    collapsed.sort((a, c) => c.total - a.total);
    const totalShips = collapsed.reduce((s, f) => s + f.shipCount, 0);
    const totalBuilds = collapsed.reduce((s, f) => s + f.buildCount, 0);
    const leader = collapsed[0];
    const ctx = { totalShips, totalBuilds, leader: leader.faction, factionCount: collapsed.length };
    const weight = 30 + collapsed.length; // stays quiet — this is background noise, not news
    stories.push(mkStory(weight, used, 'industry_collapsed', INDUSTRY_COLLAPSED, 'industry_collapsed_hl', INDUSTRY_COLLAPSED_HEADLINE, ctx));
  }

  return stories;
}

function buildColonyStories(rows, used, locator) {
  const stories = [];

  const byFaction = new Map();
  for (const row of rows) {
    if (row.kind !== 'settlement_built') continue;
    const p = safeJson(row.payload);
    const faction = p.owner_faction_name ?? 'An unknown faction';
    if (!byFaction.has(faction)) byFaction.set(faction, []);
    byFaction.get(faction).push({ name: p.settlement_name, body: p.body_name, bodyId: row.body_id, type: p.settlement_type });
  }
  for (const [faction, entries] of byFaction) {
    // Single settlement: name where it is. Multiple in one edition:
    // fall back to a plain italic list — stacking N location clauses
    // in one sentence reads as clutter rather than news.
    let entriesClause;
    if (entries.length === 1) {
      const locBody = locate(locator, entries[0].bodyId, entries[0].body);
      entriesClause = ` at ${locBody.full}`;
    } else {
      const bodyNames = nameList(entries.map(e => e.body), 2, used);
      entriesClause = bodyNames ? ` at ${bodyNames}` : '';
    }
    const weight = 100 + 5 * entries.length;
    stories.push(mkStory(weight, used, 'colony_founded', COLONY_FOUNDED, 'colony_founded_hl', COLONY_FOUNDED_HEADLINE, { faction, count: entries.length, entriesClause }));
  }

  for (const row of rows) {
    if (row.kind !== 'faction_joined') continue;
    const p = safeJson(row.payload);
    const locBody = locate(locator, p.capital_body_id, p.capital_name ?? 'an unclaimed world');
    const ctx = { faction: p.name ?? 'A new faction', body: locBody.name, bodyLoc: locBody.full };
    stories.push(mkStory(220, used, 'faction_arrival', FACTION_ARRIVAL, 'faction_arrival_hl', FACTION_ARRIVAL_HEADLINE, ctx));
  }

  return stories;
}

/** Discoveries are driven off the chronicle row's structured `kind`
 *  (and, for ancient_databank, the new `tech_id` field) rather than
 *  parsing the free-text `message` — see DISCOVERY_PAYOFFS above for
 *  why. Also the only section that previously had NO faction
 *  attribution at all; now reads it off `actor_faction_id` like every
 *  other section already does. */
function buildDiscoveryStories(rows, used, locator, factionNames) {
  const stories = [];
  for (const row of rows) {
    if (row.kind !== 'secret_discovered') continue;
    const p = safeJson(row.payload);
    const kind = typeof p.kind === 'string' ? p.kind : null;
    const faction = factionNames.get(row.actor_faction_id) ?? 'An unnamed crew';
    const locBody = locate(locator, row.body_id, p.body_name ?? 'the frontier');

    const payoffBank = kind === 'ancient_databank'
      ? databankPayoffs(p.tech_id ? titleCase(String(p.tech_id).replace(/_/g, ' ')) : null)
      : (kind && DISCOVERY_PAYOFFS[kind]) || null;
    const payoff = payoffBank ? payoffBank[Math.floor(Math.random() * payoffBank.length)] : DISCOVERY_PAYOFF_FALLBACK;

    const leadIn = pickTemplate('discovery_leadin', DISCOVERY_LEADIN, used);
    const text = `${leadIn}at ${locBody.full}, ${b(faction)} ${payoff}.`;
    const headline = pickTemplate('discovery_hl', DISCOVERY_HEADLINE, used)({ bodyName: locBody.name, faction });
    stories.push({ text, headline, weight: 250 + Math.random() });
  }
  return stories;
}

function buildPoliticsStories(rows, used, factionNames) {
  const stories = [];
  const nameOf = (id) => factionNames.get(id) ?? 'an unnamed faction';

  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'treaty_signed') {
      const ctx = { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id), pactName: PACT_NAMES[p.kind] ?? 'a treaty' };
      stories.push(mkStory(150, used, 'treaty_signed', TREATY_SIGNED, 'treaty_signed_hl', TREATY_SIGNED_HEADLINE, ctx));
    } else if (row.kind === 'treaty_broken') {
      const ctx = { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id) };
      stories.push(mkStory(350, used, 'treaty_broken', TREATY_BROKEN, 'treaty_broken_hl', TREATY_BROKEN_HEADLINE, ctx));
    } else if (row.kind === 'senate_vote') {
      // Title-cased for display only — player-typed titles otherwise sit
      // lowercase/shouty next to properly-cased faction/body names.
      const ctx = { title: titleCase(p.title ?? 'a motion'), actor: nameOf(row.actor_faction_id) };
      if (p.outcome === 'passed') {
        stories.push(mkStory(120, used, 'senate_passed', SENATE_PASSED, 'senate_passed_hl', SENATE_PASSED_HEADLINE, ctx));
      } else {
        stories.push(mkStory(120, used, 'senate_failed', SENATE_FAILED, 'senate_failed_hl', SENATE_FAILED_HEADLINE, ctx));
      }
    }
  }
  return stories;
}

/** trade_accepted rows carry the full offer/request + any bundled
 *  pacts — previously the ONLY trace of an individual trade in the
 *  Herald was the aggregate "Trade ledger" delivery count, which
 *  can't name who traded what with whom. */
function buildTradeStories(rows, used, factionNames) {
  const stories = [];
  const nameOf = (id) => factionNames.get(id) ?? 'an unnamed faction';

  const fmtBundle = (b) => {
    if (!b || typeof b !== 'object') return 'nothing';
    const parts = [];
    if ((b.metal ?? 0) > 0)   parts.push(`${numWord(Math.round(b.metal))} metal`);
    if ((b.fuel ?? 0) > 0)    parts.push(`${numWord(Math.round(b.fuel))} fuel`);
    if ((b.gold ?? 0) > 0)    parts.push(`${numWord(Math.round(b.gold))} credits`);
    if ((b.science ?? 0) > 0) parts.push(`${numWord(Math.round(b.science))} science`);
    return parts.length ? parts.join(', ') : 'nothing';
  };

  for (const row of rows) {
    if (row.kind !== 'trade_accepted') continue;
    const p = safeJson(row.payload);
    const pacts = Array.isArray(p.pacts) ? p.pacts : [];
    const pactNames = pacts.map(k => PACT_NAMES[k] ?? 'a treaty');
    const pactClause = pactNames.length > 0 ? ` — sealed with ${pactNames.join(' and ')}` : '';
    const ctx = {
      proposer: nameOf(row.actor_faction_id),
      responder: nameOf(row.target_faction_id),
      offerText: fmtBundle(p.offer),
      requestText: fmtBundle(p.request),
      pactClause,
    };
    // Routine unless it bundled a pact, same "rarely the headline"
    // register as industry — a pact bundled in makes it a bit more
    // newsworthy without approaching treaty_signed's own weight.
    const weight = pactNames.length > 0 ? 130 : 60;
    stories.push(mkStory(weight, used, 'trade_accepted', TRADE_ACCEPTED, 'trade_accepted_hl', TRADE_ACCEPTED_HEADLINE, ctx));
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
// Dyson Sphere — megaproject coverage. The sphere is the win-condition
// wonder, so its beats carry front-page gravity: an attack on it is a
// BATTLE story weighted above any ordinary engagement, a collapse sits
// just under a victory, and the laying of the foundation is history in
// the making. Kinds emitted by worker/actions.js (dyson_initiated) and
// worker/room.js tickDysonSphere (dyson_damaged / dyson_milestone /
// dyson_collapsed).
// ------------------------------------------------------------

const DYSON_INITIATED = [
  (c) => `**${c.faction}** has laid the foundation of a **Dyson Sphere** at Sol — the greatest engineering work ever attempted. Every hauler they can spare now matters, and every rival knows exactly where to point its guns.`,
  (c) => `Cranes over the sun: **${c.faction}** began construction of a **Dyson Sphere** at Sol today. If the lattice closes, the war is over — the only question is whether the galaxy lets it close.`,
];
const DYSON_INITIATED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} DARES THE IMPOSSIBLE`,
  () => 'A SPHERE RISES OVER SOL',
];
const DYSON_MILESTONE = [
  (c) => `The **Dyson Sphere** stands at **${c.pct}%** — **${c.faction}**'s engineers report the lattice holding. The countdown the whole system pretends not to hear grows louder.`,
  (c) => `**${c.faction}**'s sun-cage reached **${c.pct}%** completion this edition. Diplomats are polite about it. Admirals are not.`,
];
const DYSON_MILESTONE_HEADLINE = [
  (c) => `SPHERE AT ${c.pct}%`,
  (c) => `${c.pct}% OF A SUN, CLAIMED`,
];
const DYSON_DAMAGED = [
  (c) => `The **Dyson Sphere** took fire at Sol — **${c.damage}** units of construction burned off the lattice under bombardment. **${c.faction}**'s great work stands at **${c.pct}%** and bleeding.`,
  (c) => `Battle at the sun: raiders hammered **${c.faction}**'s Dyson foundation, erasing **${c.damage}** of accumulated work. The sphere holds at **${c.pct}%** — for now.`,
];
const DYSON_DAMAGED_HEADLINE = [
  () => 'THE SPHERE BLEEDS',
  () => 'FIRE AT THE FOUNDATION',
];
const DYSON_COLLAPSED = [
  (c) => `The **Dyson Sphere is gone.** ${c.reason === 'foundation destroyed' ? 'Its foundation station was blown out of Sol orbit' : 'Sustained bombardment finally broke the lattice'}, and with it **${c.faction}**'s bid to end the war by engineering. Every unit of progress — **${c.lost}** in all — is dust in the solar wind.`,
  (c) => `It fell. **${c.faction}**'s sun-cage collapsed ${c.reason === 'foundation destroyed' ? 'when its foundation was destroyed' : 'under sustained attack'} — **${c.lost}** units of the grandest project in history, erased in a single stroke. The Sol slot stands open for whoever dares next.`,
];
const DYSON_COLLAPSED_HEADLINE = [
  () => 'THE SPHERE HAS FALLEN',
  () => 'A SUN UNCAGED',
];

/** Dyson battle beats — damage + collapse — for the BATTLES section. */
function buildDysonBattleStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'dyson_damaged') {
      const ctx = { faction, damage: p.damage ?? 0, pct: p.pct ?? 0 };
      // Above any ordinary engagement (BATTLE_BASE_WEIGHT 380) and
      // scaling with how much progress actually burned.
      const weight = 450 + Math.min(200, (p.damage ?? 0) / 10);
      stories.push(mkStory(weight, used, 'dyson_damaged', DYSON_DAMAGED, 'dyson_damaged_hl', DYSON_DAMAGED_HEADLINE, ctx));
    } else if (row.kind === 'dyson_collapsed') {
      const ctx = { faction, reason: p.reason ?? '', lost: p.progress_lost ?? 0 };
      // Just under a victory (1000) — losing the wonder IS the story.
      stories.push(mkStory(850, used, 'dyson_collapsed', DYSON_COLLAPSED, 'dyson_collapsed_hl', DYSON_COLLAPSED_HEADLINE, ctx));
    }
  }
  return stories;
}

/** Dyson construction beats — initiation + milestones — for the
 *  "History in the making" section. */
function buildDysonHistoryStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'dyson_initiated') {
      stories.push(mkStory(500, used, 'dyson_initiated', DYSON_INITIATED, 'dyson_initiated_hl', DYSON_INITIATED_HEADLINE, { faction }));
    } else if (row.kind === 'dyson_milestone') {
      // Later milestones are bigger news — 75% outranks a treaty broken.
      stories.push(mkStory(250 + (p.pct ?? 0) * 2, used, 'dyson_milestone', DYSON_MILESTONE, 'dyson_milestone_hl', DYSON_MILESTONE_HEADLINE, { faction, pct: p.pct ?? 0 }));
    }
  }
  return stories;
}

// ------------------------------------------------------------
// Fleet-economy beats (rush botches + arrears) — color for the
// industry column. Chronicled by worker/actions.js / worker/room.js.
// ------------------------------------------------------------

const RUSH_BOTCHED = [
  (c) => `**${c.faction}** paid double to rush the ${c.cls} **${c.name}** out of the yards at ${c.body} — and got what rushing buys: she'll launch at half hull, welds still smoking.`,
  (c) => `Corners were cut at ${c.body}: **${c.faction}**'s rushed ${c.cls} **${c.name}** will leave the slips at half integrity. The yard foreman was unavailable for comment.`,
];
const RUSH_BOTCHED_HEADLINE = [
  () => 'HASTE MAKES HALF A HULL',
  (c) => `BOTCHED JOB AT ${(c.body || 'THE YARDS').toUpperCase()}`,
];
const ARREARS_ENTERED = [
  (c) => `**${c.faction}**'s treasury ran dry this edition — fleet wages unpaid, and every one of its hulls fights at three-quarters strength until the debts clear.`,
];
const ARREARS_ENTERED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} CAN'T MAKE PAYROLL`,
];
const ARREARS_CLEARED = [
  (c) => `**${c.faction}** cleared its fleet-upkeep debts — full combat pay restored, full combat effectiveness with it.`,
];
const ARREARS_CLEARED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} SQUARES ITS DEBTS`,
];

function buildFleetEconomyStories(rows, used, factionNames, locator) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'ship_rush_botched') {
      const loc = locate(locator, row.body_id, p.body_name);
      const ctx = {
        faction,
        cls: p.ship_class ?? 'ship',
        name: p.ship_name ?? 'an unnamed hull',
        body: loc.full,
      };
      stories.push(mkStory(90, used, 'rush_botched', RUSH_BOTCHED, 'rush_botched_hl', RUSH_BOTCHED_HEADLINE, { ...ctx, body: loc.name }));
    } else if (row.kind === 'fleet_arrears') {
      if (p.entered === true) {
        stories.push(mkStory(200, used, 'arrears_entered', ARREARS_ENTERED, 'arrears_entered_hl', ARREARS_ENTERED_HEADLINE, { faction }));
      } else {
        stories.push(mkStory(80, used, 'arrears_cleared', ARREARS_CLEARED, 'arrears_cleared_hl', ARREARS_CLEARED_HEADLINE, { faction }));
      }
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
  trades:      { title: '🤝  Deals struck',          color: 0x67e8f9 },
  victory:     { title: '👑  History in the making', color: 0xffd700 },
};

function fieldFromStories(title, stories, used) {
  if (stories.length === 0) return null;
  const shown = stories.slice(0, MAX_STORIES_PER_SECTION);
  const more = stories.length - shown.length;
  let value = shown.map(s => s.text).join('\n\n');
  if (more > 0) {
    const s = more === 1 ? '' : 's';
    const tail = pickTemplate('more_incidents_tail', MORE_INCIDENTS_TAIL, used)(more, s);
    value += `\n\n${tail}`;
  }
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
function composeEmbed(gameName, tick, rows, factionNames, tradesDelta, locator) {
  const used = new Map(); // bank-name -> Set(indices used this edition)

  const captainFate = buildCaptainFateMap(rows);
  const sections = {
    // Dyson beats merge into the existing columns: an attack on the
    // sphere IS a battle (and outweighs any ordinary engagement); its
    // founding and milestones are history in the making.
    victory:     [
      ...buildVictoryStories(rows, used, factionNames),
      ...buildDysonHistoryStories(rows, used, factionNames),
    ],
    battles:     [
      ...buildDysonBattleStories(rows, used, factionNames),
      ...buildBattleStories(rows, used, locator, captainFate),
    ],
    politics:    buildPoliticsStories(rows, used, factionNames),
    discoveries: buildDiscoveryStories(rows, used, locator, factionNames),
    colonies:    buildColonyStories(rows, used, locator),
    trades:      buildTradeStories(rows, used, factionNames),
    industry:    [
      ...buildIndustryStories(rows, used),
      ...buildFleetEconomyStories(rows, used, factionNames, locator),
    ],
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
  for (const key of ['victory', 'battles', 'politics', 'discoveries', 'colonies', 'trades', 'industry']) {
    const field = fieldFromStories(SECTION_META[key].title, sections[key], used);
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

/** Every body id a digest window's rows could reference, including
 *  the one kind (faction_joined) whose chronicle row doesn't set the
 *  body_id COLUMN — its location lives in the payload instead. */
function collectBodyIds(rows) {
  const ids = [];
  for (const row of rows) {
    if (row.body_id) ids.push(row.body_id);
    if (row.kind === 'faction_joined') {
      const p = safeJson(row.payload);
      if (p.capital_body_id) ids.push(p.capital_body_id);
    }
  }
  return ids;
}

/**
 * Digest one game. Shared by the daily cron and the host's
 * "publish now" button.
 *
 * @param game  { id, current_tick, name }
 * @param opts.force  true = skip the once-per-day interval gate AND
 *   post a "quiet day" edition when there's nothing to report (the
 *   button should always visibly do something); the cron leaves both
 *   behaviors off. Forced runs also use a fixed trailing 12h window
 *   (FORCE_LOOKBACK_MS) instead of the incremental high-water mark,
 *   so "Publish Herald Now" always shows the last 12 hours no matter
 *   when it's clicked or how recently a digest last ran.
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

  // Forced (button) editions: always the trailing 12h from right now.
  // Scheduled (cron) editions: incremental — since the last edition's
  // high-water mark, falling back to a 24h lookback on the very first run.
  const sinceMs = force
    ? now - FORCE_LOOKBACK_MS
    : (state?.last_entry_ms || (now - FIRST_RUN_LOOKBACK_MS));

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

  const locator = await buildBodyLocator(env, game.id, collectBodyIds(rows));

  const tradesNow = (await env.DB
    .prepare(`SELECT COALESCE(SUM(trades_completed), 0) AS n
                FROM game_ships WHERE game_id = ? AND status = 'active'`)
    .bind(game.id)
    .first())?.n ?? 0;
  const tradesDelta = Math.max(0, tradesNow - (state?.trades_snapshot ?? tradesNow));

  let embed = composeEmbed(game.name ?? game.id, game.current_tick ?? 0, rows, factionNames, tradesDelta, locator);

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
  if (!isEasternDigestHour(now)) return;              // only at noon Eastern

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
