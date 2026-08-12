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

import { renderStripPng, STRIP_PUBLIC_URL } from './heraldStrip.js';
import { activeSanctions } from './senate.js';

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

/** How many factions get a full industry paragraph before the rest are
 *  swept into a single roundup line. The threshold above only filters
 *  out trivially small producers; in a busy window every surviving
 *  power clears it, and the section degenerates into one identical
 *  "N ships and M upgrades" sentence per faction. Two leads plus a
 *  roundup reads like a page of a newspaper; four leads read like a
 *  table someone set in prose. */
const INDUSTRY_MAX_PARAGRAPHS = 2;

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

/** "first", "second", … "tenth", then numeric ordinals. Research
 *  levels top out around ten, so the spelled forms cover the real
 *  range; the numeric fallback exists so a future rebalance can't
 *  print "the undefinedth tier". */
const ORDINAL_WORDS = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
];
function ordinal(n) {
  const i = Number(n);
  if (Number.isInteger(i) && i >= 0 && i < ORDINAL_WORDS.length) return ORDINAL_WORDS[i];
  const rem100 = i % 100, rem10 = i % 10;
  if (rem100 >= 11 && rem100 <= 13) return `${i}th`;
  return `${i}${rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th'}`;
}

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
// `n` can legitimately be 1 (three names, max 2 shown), so anything
// that says "others" has to agree in number — "and 1 others unlisted"
// was reaching real editions.
/** Tail for a list of WORLDS attached to a count of SETTLEMENTS. The
 *  two don't have to match — a faction can put three domes on one moon
 *  — so this deliberately counts nothing. */
const WORLD_LIST_VAGUE_TAIL = [
  () => ' and elsewhere',
  () => ' among other worlds',
  () => ' and points beyond',
  () => ', with more besides',
  () => ' and further out',
  () => ' among others',
  () => ' and elsewhere in the system',
  () => ', and worlds not listed here',
];

/** Trailing clause naming some of the destroyed ships.
 *
 *  It used to be a bare ", including *X* and *Y*", appended to whatever
 *  the template happened to end on — and plenty of them end on the
 *  WINNER: "…and nothing at all charged against Moose Authority,
 *  including *Constancy* and *Etesian*" reads as a list of Moose's
 *  losses, which is the exact opposite of the truth. Every variant here
 *  anchors on a word that can only mean the dead, so the clause stays
 *  correct no matter which faction the sentence mentioned last. */
const BATTLE_NAMES_CLAUSE = [
  n => `, ${n} among the lost`,
  n => `, ${n} among the dead`,
  n => `, ${n} among the wrecks`,
  n => `, ${n} on the casualty list`,
  n => `, ${n} among those destroyed`,
  n => `, ${n} named among the losses`,
  n => `, ${n} confirmed lost`,
  n => `, ${n} among the hulls that did not return`,
  n => `, ${n} listed among the destroyed`,
  n => `, ${n} among the casualties`,
  n => `, ${n} written off`,
  n => `, ${n} among the ships lost`,
];

/** Frames the chronicle's bare victory record as a cited fact rather
 *  than leaving it standing alone as the entire story. */
const VICTORY_DETAIL_CLAUSE = [
  d => `The official record reads: ${d}.`,
  d => `The registrar's entry is brief — ${d}.`,
  d => `For the archives: ${d}.`,
  d => `The declaration, in full: ${d}.`,
  d => `It is entered in the record as follows — ${d}.`,
  d => `The formal wording: ${d}.`,
  d => `Clerks recorded it plainly: ${d}.`,
  d => `The citation reads ${d}, and there it ends.`,
  d => `Set down for history: ${d}.`,
  d => `The ruling, as filed: ${d}.`,
  d => `The record will show ${d}.`,
  d => `Written into the archive this hour: ${d}.`,
];

/** Tail variants for a list that is followed by a casualty clause.
 *  The general bank leans on "among" ("among 2 more unnamed"), and the
 *  clause after it does too ("among those destroyed"), which collided
 *  in a real edition. These never use the word. */
const NAME_LIST_PLAIN_TAIL = [
  n => `, and ${n} more`,
  n => `, plus ${n} more`,
  n => `, and ${n} ${plural(n, 'other')}`,
  n => `, with ${n} more besides`,
  n => `, and ${n} unnamed`,
  n => `, plus ${n} unnamed`,
  n => `, and ${n} further ${plural(n, 'hull')}`,
  n => `, and ${n} besides`,
];

const NAME_LIST_MORE_TAIL = [
  n => `, and ${n} more`,
  n => `, plus ${n} more`,
  n => `, and ${n} ${plural(n, 'other')}`,
  n => `, with ${n} more besides`,
  n => `, among ${n} more unnamed`,
  n => ` — and ${n} more after that`,
  n => `, and ${n} ${plural(n, 'other')} unlisted`,
  n => `, plus ${n} not named here`,
];

/** Oxford-joined, italicized name list (ships/settlements — kept
 *  visually distinct from bold faction/body names). Caps at `max`,
 *  tail becomes a varied "...and N more"-style clause rather than a
 *  run-on sentence. Returns null for an empty list so callers can
 *  cleanly omit the clause. `used` (optional) threads into the same
 *  per-edition "don't repeat a bank" tracking every other phrase bank
 *  uses; omit only for call sites that can't reach it. */
function nameList(names, max = 2, used = null, total = null, tailBank = NAME_LIST_MORE_TAIL) {
  const kept = (names || []).filter(Boolean);
  // De-duplicate for DISPLAY only. Two ships can genuinely carry the
  // same name, and collapsing them used to silently shrink the tail
  // count: eighteen hulls built, one name repeated, and the clause read
  // "18 new ships — Damselfly, Slipstream, plus 15 not named here",
  // which adds to seventeen. A reader who checks the arithmetic once
  // and finds it wrong stops trusting every other number on the page,
  // including the casualty figures. `total` lets a caller that knows
  // the true count pin the tail to it.
  const uniq = [...new Set(kept)];
  if (uniq.length === 0) return null;
  const shown = uniq.slice(0, max).map(n => `*${n}*`);
  const trueTotal = Number.isFinite(total) ? total : kept.length;
  const remaining = trueTotal - shown.length;
  if (remaining <= 0) {
    if (shown.length === 1) return shown[0];
    if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
    return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  }
  const tail = used
    ? pickTemplate(tailBank === NAME_LIST_MORE_TAIL ? 'name_list_tail' : 'name_list_plain_tail', tailBank, used)(remaining)
    : tailBank[0](remaining);
  return `${shown.join(', ')}${tail}`;
}

/** Deterministic PRNG (mulberry32), seeded per edition.
 *
 *  Template choice used to be plain Math.random(), which is memoryless
 *  ACROSS editions: `used` only dedupes within a single paper, so
 *  nothing stopped six consecutive editions from all opening their
 *  industry column with "A busy day for X". Read one edition and the
 *  variety looks fine; read ten in a row — which is exactly what a
 *  player following a match does — and the paper reads like a dozen
 *  sentence shapes with the nouns swapped.
 *
 *  Seeding from the edition's tick fixes that without persisting any
 *  cross-run state: each edition gets its own entry point into every
 *  bank, and re-rendering the same edition is idempotent (which also
 *  makes the thing reviewable — regenerate and you get the same paper
 *  back, so a prose change is attributable to the change and not to
 *  the dice). */
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gcd(a, c) { while (c) { const t = c; c = a % c; a = t; } return a; }

/** A step size coprime to the bank length, so `(start + k*stride) % n`
 *  visits every template exactly once before repeating. Walking by a
 *  stride rather than sequentially matters because the banks were
 *  authored in batches — neighbouring entries tend to share a cadence,
 *  so a sequential walk would make one edition's four industry stories
 *  all sound like the same writer's run of drafts. */
function strideFor(n, rng) {
  if (n < 3) return 1;
  for (let tries = 0; tries < 12; tries++) {
    const s = 1 + Math.floor(rng() * (n - 1));
    if (gcd(s, n) === 1) return s;
  }
  return 1;
}

/** Picks a template, walking each bank in a per-edition scattered
 *  order so no two stories of the same shape in one paper read alike
 *  AND consecutive papers don't reuse the same openers. Exhausting a
 *  bank restarts the walk from a fresh offset rather than replaying
 *  the order just used. */
function pickTemplate(bankName, bank, used) {
  if (bank.length === 1) return bank[0];
  const rng = used.get('__rng') || Math.random;
  let cur = used.get(bankName);
  if (!cur || cur.k >= bank.length) {
    const spin = used.get('__spin') || 0;
    cur = { start: (Math.floor(rng() * bank.length) + spin) % bank.length, stride: strideFor(bank.length, rng), k: 0 };
    used.set(bankName, cur);
  }
  const i = (cur.start + cur.k * cur.stride) % bank.length;
  cur.k += 1;
  return bank[i];
}

function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

// ------------------------------------------------------------
// Second-reference short names
// ------------------------------------------------------------

/** Nouns that mark the "kind of polity" tail of a faction name, so
 *  "Sun Never Sets On The Solar Empire" can become "the Solar Empire". */
const ORG_NOUNS = new Set([
  'empire', 'federation', 'authority', 'republic', 'alliance', 'union',
  'coalition', 'dominion', 'collective', 'hegemony', 'consortium',
  'conclave', 'directorate', 'league', 'order', 'syndicate', 'imperium',
  'commonwealth', 'compact', 'concord', 'assembly', 'council', 'confederacy',
  'protectorate', 'ascendancy', 'combine', 'company', 'corporation', 'guild',
  'clan', 'horde', 'swarm', 'covenant', 'accord', 'triumvirate', 'regency',
]);

/** Derives a newspaper short form for each faction.
 *
 *  Players name their factions, and they name them LONG: a real match
 *  produced "Sun Never Sets On The Solar Empire", which the Herald
 *  then printed in full on every one of its five mentions in a single
 *  paragraph — and printed ":) Smiley Face Friends :)'s" as a
 *  possessive. A reviewer reading ten editions called this the single
 *  biggest drag on readability in the paper, which is right: it is
 *  also the one thing a real newspaper never does. Papers spell a name
 *  out once and use a short form forever after.
 *
 *  Candidates are tried in order of how much they read like something
 *  a subeditor would actually choose, and each is accepted only if it
 *  is shorter, unclaimed, and unambiguous — no candidate may appear
 *  inside ANY other faction's full name, or "the Empire" would refer
 *  to two different powers in the same sentence. A faction with no
 *  safe short form simply keeps its full name. */
function buildShortNames(fullNames) {
  const shorts = new Map();
  const taken = new Set();
  const lower = s => s.toLowerCase();

  for (const full of fullNames) {
    // Strip purely decorative edge tokens (":)" and friends) — that
    // alone rescues the possessive form.
    const tokens = full.trim().split(/\s+/);
    let lo = 0, hi = tokens.length - 1;
    while (lo <= hi && !/[A-Za-z0-9]/.test(tokens[lo])) lo++;
    while (hi >= lo && !/[A-Za-z0-9]/.test(tokens[hi])) hi--;
    const core = tokens.slice(lo, hi + 1).join(' ') || full;
    const words = core.split(/\s+/);
    const last = words[words.length - 1] ?? '';

    const candidates = [];
    // "The Empire of Lorne" -> "Lorne"; "Federation of Atlantis" -> "Atlantis"
    const ofMatch = core.match(/^(?:The\s+)?.+?\s+of\s+(.+)$/i);
    if (ofMatch) candidates.push(ofMatch[1]);
    // "...On The Solar Empire" -> "Solar Empire".
    //
    // Deliberately WITHOUT a leading article. Short forms land in
    // attributive slots the templates build by hand — "${count}
    // ${faction} ${shipsWord}" — and "the Solar Empire" there produces
    // "one the Solar Empire ship". A bare name is grammatical in every
    // position the banks can put it, which is also why wire copy writes
    // "Empire forces" rather than "the Empire's forces".
    if (words.length > 2 && ORG_NOUNS.has(lower(last))) {
      candidates.push(words.slice(-2).join(' '));
    }
    // ":) Smiley Face Friends :)" -> "Smiley Face Friends"
    if (core !== full) candidates.push(core);
    // "Moose Authority" -> "Moose"
    if (words.length > 1 && words[0].length >= 4 && lower(words[0]) !== 'the') {
      candidates.push(words[0]);
    }
    // last resort: "Moose Authority" -> "Authority"
    if (words.length > 1 && ORG_NOUNS.has(lower(last))) candidates.push(last);

    for (const cand of candidates) {
      if (!cand || cand.length >= full.length || cand.replace(/^the\s+/i, '').length < 3) continue;
      const key = lower(cand.replace(/^the\s+/i, ''));
      if (taken.has(key)) continue;
      // Ambiguous if it also names, or sits inside, some OTHER faction.
      if (fullNames.some(o => o !== full && lower(o).includes(key))) continue;
      shorts.set(full, cand);
      taken.add(key);
      break;
    }
  }
  return shorts;
}

/** True if the text so far ends on a count ("three ", "15 ") — the
 *  attributive slot the battle banks build by hand. A full faction name
 *  there produces "tore through three The Empire of Lorne ships", so it
 *  forfeits its first-mention grace and gets the short form. */
const COUNT_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
]);
function precededByCount(soFar) {
  const m = soFar.match(/(\S+)\s+$/);
  if (!m) return false;
  const w = m[1].replace(/[*_]/g, '').toLowerCase();
  return /^\d+$/.test(w) || COUNT_WORDS.has(w);
}

/** True if the text so far ends at a sentence boundary — used so a
 *  short form beginning "the " gets a capital when it opens a sentence
 *  ("the Solar Empire held." -> "The Solar Empire held."). Markdown
 *  emphasis markers are skipped, because the name is usually bolded and
 *  the asterisks sit between the boundary and the word. */
function atSentenceStart(soFar) {
  const t = soFar.replace(/[*_\s]+$/, '');
  return t === '' || /[.!?:;—\n]$/.test(t);
}

/** Replaces every occurrence of `needle` in `hay` after the first
 *  `skip` of them. Plain string scanning — faction names are arbitrary
 *  player text (":) Smiley Face Friends :)") and would have to be
 *  escaped to be used as a regex. */
function replaceAfter(hay, needle, replacement, skip) {
  if (!needle) return hay;
  let out = '', from = 0, seen = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) { out += hay.slice(from); return out; }
    out += hay.slice(from, at);
    if (seen < skip && !precededByCount(out)) {
      out += needle;
    } else {
      out += atSentenceStart(out)
        ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
        : replacement;
    }
    seen++;
    from = at + needle.length;
  }
}

/** Applies short names across a finished edition, in reading order.
 *
 *  Done as a pass over the rendered text rather than inside the banks
 *  because "is this the first mention?" is only answerable once the
 *  headline has been chosen and the sections ordered — which happens
 *  after every template has already run.
 *
 *  Headlines take the short form outright: a masthead has never spelled
 *  out a six-word polity, and the deck underneath carries the full name
 *  a line later anyway. */
function applyShortNames(embed, factionNames) {
  const fulls = [...new Set([...factionNames.values()].filter(Boolean))]
    // Longest first: "The Empire of Lorne" must be matched and consumed
    // before a shorter name that happens to sit inside it.
    .sort((a, z) => z.length - a.length);
  if (fulls.length === 0) return embed;
  const shorts = buildShortNames(fulls);
  if (shorts.size === 0) return embed;

  let title = embed.title ?? '';
  for (const full of fulls) {
    const s = shorts.get(full);
    if (!s) continue;
    title = replaceAfter(title, full.toUpperCase(), s.replace(/^the\s+/i, '').toUpperCase(), 0);
  }

  // One shared "already introduced" set across the whole edition, walked
  // in the order a reader's eye goes: deck first, then each field.
  const introduced = new Set();
  const shorten = (text) => {
    let out = text ?? '';
    for (const full of fulls) {
      const s = shorts.get(full);
      if (!s || !out.includes(full)) continue;
      // The POSSESSIVE gets no first-mention grace. ":) Smiley Face
      // Friends :)'s" is the exact string a reviewer singled out as
      // unreadable, and a name that already ends in punctuation only
      // gets worse with an apostrophe-s welded on. Shorten every one —
      // including the bolded form, which is how the banks actually
      // emit it (`**NAME**'s`), and which a plain `NAME's` needle
      // silently fails to match. A short form already ending in -s
      // takes the bare apostrophe ("Smiley Face Friends'").
      const tail = /s$/i.test(s) ? "'" : "'s";
      const boldPoss = `**${full}**'s`;
      const plainPoss = `${full}'s`;
      if (out.includes(boldPoss) || out.includes(plainPoss)) {
        out = replaceAfter(out, boldPoss, `**${s}**${tail}`, 0);
        out = replaceAfter(out, plainPoss, `${s}${tail}`, 0);
        // Count that as the introduction. Otherwise the full name turns
        // up LATER in the edition than the short one, which reads as
        // the paper getting more formal as it goes.
        introduced.add(full);
      }
      if (!out.includes(full)) { introduced.add(full); continue; }
      const skip = introduced.has(full) ? 0 : 1;
      out = replaceAfter(out, full, s, skip);
      introduced.add(full);
    }
    return out;
  };

  const description = shorten(embed.description);
  const fields = (embed.fields ?? []).map(f => ({ ...f, value: shorten(f.value) }));
  return { ...embed, title, description, fields };
}

const SETTLEMENT_LOSS_CLAUSE = [
  (nameStr, many, popClause) => ` The civil registry lists ${nameStr}${popClause} among the losses.`,
  (nameStr, many, popClause) => ` ${nameStr}${popClause} ${many ? 'are' : 'is'} gone as well.`,
  (nameStr, many, popClause) => ` Nothing habitable remains at ${nameStr}${popClause}.`,
  (nameStr, many, popClause) => ` The fighting also took ${nameStr}${popClause}. No warning was given, and none was possible.`,
  (nameStr, many, popClause) => ` Add to the ledger ${nameStr}${popClause}, ${many ? 'settlements' : 'a settlement'} of no military value whatsoever.`,
  (nameStr, many, popClause) => ` ${nameStr}${popClause} ${many ? 'were' : 'was'} struck in the same pass. Evacuation orders went out eleven minutes after the first hit.`,
  (nameStr, many, popClause) => ` Among the wreckage: ${nameStr}${popClause}, listed in the pre-war surveys as agricultural.`,
  (nameStr, many, popClause) => ` The same engagement erased ${nameStr}${popClause}.`,
  (nameStr, many, popClause) => ` Casualty accounting is ongoing at ${nameStr}${popClause}, where the habitat shells failed inside the hour.`,
  (nameStr, many, popClause) => ` ${nameStr}${popClause} ${many ? 'have' : 'has'} been struck from the settled-worlds index. The paperwork took longer than the bombardment.`,
  (nameStr, many, popClause) => ` Also destroyed: ${nameStr}${popClause}.`,
  (nameStr, many, popClause) => ` Survivors from ${nameStr}${popClause} are being counted at the nearest depot, though counted is a generous word for it.`,
  (nameStr, many, popClause) => ` The dock district at ${nameStr} burned for two days after the last ship left.`,
  (nameStr, many, popClause) => ` ${nameStr}${popClause} ${many ? 'were' : 'was'} lost with ${many ? 'them' : 'it'} — schools, water plant, the lot.`,
  (nameStr, many, popClause) => ` No shipyard sat at ${nameStr}. No garrison, no battery, no reason. ${nameStr} ${many ? 'are' : 'is'} rubble.`,
  (nameStr, many, popClause) => ` This desk notes, without comment, that ${nameStr}${popClause} ${many ? 'were' : 'was'} inhabited.`,
  (nameStr, many, popClause) => ` Add ${nameStr}${popClause} to the column that never gets a headline.`,
  (nameStr, many, popClause) => ` Relief traffic has been diverted toward ${nameStr}${popClause}. It will arrive too late to be relief.`,
  (nameStr, many, popClause) => ` The ${many ? 'settlements' : 'settlement'} at ${nameStr}${popClause} did not survive the engagement.`,
  (nameStr, many, popClause) => ` Ministry language for what happened to ${nameStr}${popClause} is "incidental habitation loss."`,
  (nameStr, many, popClause) => ` ${nameStr} ${many ? 'were' : 'was'} not evacuated. There was no one left in orbit to do the evacuating.`,
  (nameStr, many, popClause) => ` Refugee columns are moving out of ${nameStr}${popClause} on whatever hulls will take them.`,
  (nameStr, many, popClause) => ` And ${nameStr}${popClause} — ${many ? 'towns' : 'a town'} that built nothing more dangerous than grain silos — ${many ? 'are' : 'is'} finished.`,
  (nameStr, many, popClause) => ` The ${many ? 'names' : 'name'} of ${nameStr}${popClause} will appear in no dispatch after this one.`,
];

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
  // Parenthesised, not dash-delimited. Paired em-dashes close the aside
  // correctly mid-sentence but strand a dash against the full stop when
  // the clause ends the sentence ("…toward Kessik City — home to 2.4
  // million —."), and the bank has 24 shapes now, half of which put the
  // names last. Parentheses read correctly in every position.
  const popClause = totalPop > 0 ? ` (home to ${formatPopulation(totalPop)})` : '';
  return pickTemplate('settlement_loss', SETTLEMENT_LOSS_CLAUSE, used)(nameStr, many, popClause);
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
/** Capitalises the first letter of a rendered story, skipping any
 *  leading markdown emphasis. Templates that open on a spelled number
 *  ("three ships flying Moose colours were destroyed…") are otherwise
 *  printed lowercase at the head of a paragraph, because numWord()
 *  has no idea where in a sentence it landed. */
function capitalizeFirst(s) {
  const i = s.search(/[A-Za-z]/);
  if (i === -1) return s;
  return s.slice(0, i) + s.charAt(i).toUpperCase() + s.slice(i + 1);
}

function mkStory(baseWeight, used, narrativeBankName, narrativeBank, headlineBankName, headlineBank, ctx, extra = '') {
  const text = capitalizeFirst(pickTemplate(narrativeBankName, narrativeBank, used)(ctx)) + extra;
  const headline = pickTemplate(headlineBankName, headlineBank, used)(ctx);
  // Jitter off the same seeded stream as template choice, so an
  // edition is reproducible end to end — including which story wins
  // the headline, which is decided by weight.
  const rng = used.get('__rng') || Math.random;
  return { text, headline, weight: baseWeight + rng() };
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
  c => `A hard day for ${b(c.loser)}: ${b(c.winner)} forces destroyed ${numWord(c.count)} of their ships in the skies over ${c.bodyLoc}${c.namesClause}.`,
  c => `${b(c.winner)} pressed the attack at ${c.bodyLoc}, leaving ${b(c.loser)} with ${numWord(c.count)} fewer ${shipsWord(c.count)} to their name${c.namesClause}.`,
  c => `The wreckage of ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} now drifts around ${c.bodyLoc} after an engagement with ${b(c.winner)}${c.namesClause}.`,
  c => `${b(c.loser)} suffered a costly defeat near ${c.bodyLoc}; ${b(c.winner)} accounted for ${c.count === 1 ? 'the lone loss' : `all ${numWord(c.count)} losses`}${c.namesClause}.`,
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
  c => `${b(c.loser)} staggered out of ${c.bodyLoc} today, ${numWord(c.count)} ${shipsWord(c.count)} short after a mauling by ${b(c.winner)}${c.namesClause}.`,
  c => `Nothing was left to negotiate at ${c.bodyLoc} — ${b(c.winner)} erased ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} outright${c.namesClause}.`,
  c => `Distress calls poured out of ${c.bodyLoc} as ${b(c.winner)} tore through ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `${b(c.winner)} needed only one pass over ${c.bodyLoc} to put ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} out of commission${c.namesClause}.`,
  c => `${b(c.loser)} came away from ${c.bodyLoc} ${numWord(c.count)} ${shipsWord(c.count)} lighter, and ${b(c.winner)} came away whole${c.namesClause}.`,
  c => `At ${c.bodyLoc}, the shooting stopped only because there was nothing left of ${b(c.loser)} to shoot at: ${numWord(c.count)} ${shipsWord(c.count)} destroyed, ${b(c.winner)} untouched${c.namesClause}.`,
  c => `${numWord(c.count)} ${shipsWord(c.count)} flying ${b(c.loser)} colours ${plural(c.count, 'was', 'were')} destroyed at ${c.bodyLoc}. ${b(c.winner)} did not lose a hull${c.namesClause}.`,
  c => `The ledger from ${c.bodyLoc} reads badly for ${b(c.loser)}: ${numWord(c.count)} ${shipsWord(c.count)} lost, and nothing at all charged against ${b(c.winner)}${c.namesClause}.`,
  c => `Whatever ${b(c.loser)} meant to accomplish at ${c.bodyLoc}, it ended with ${numWord(c.count)} ${shipsWord(c.count)} burning and ${b(c.winner)} counting no losses${c.namesClause}.`,
  c => `Tugs were working the debris at ${c.bodyLoc} before the plating had cooled; ${b(c.loser)} is short ${numWord(c.count)} ${shipsWord(c.count)} and ${b(c.winner)} is short nothing${c.namesClause}.`,
  c => `${b(c.winner)} took the field at ${c.bodyLoc} and did not pay for it — ${numWord(c.count)} ${shipsWord(c.count)} of ${b(c.loser)} destroyed, its own roster unchanged${c.namesClause}.`,
  c => `A one-sided hour at ${c.bodyLoc} cost ${b(c.loser)} ${numWord(c.count)} ${shipsWord(c.count)} and cost ${b(c.winner)} nothing at all${c.namesClause}.`,
  c => `The repair bays of ${b(c.winner)} stood empty tonight, while ${b(c.loser)} was writing off ${numWord(c.count)} ${shipsWord(c.count)} lost at ${c.bodyLoc}${c.namesClause}.`,
  c => `Names were read out across ${b(c.loser)} stations this evening — ${numWord(c.count)} ${shipsWord(c.count)} lost at ${c.bodyLoc}, to a ${b(c.winner)} force that came home entire${c.namesClause}.`,
  c => `No ${b(c.winner)} hull was lost at ${c.bodyLoc}. The figure given for ${b(c.loser)} is ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `Total loss, and quickly. ${b(c.loser)} left ${numWord(c.count)} ${shipsWord(c.count)} at ${c.bodyLoc}; ${b(c.winner)} left with everything it brought${c.namesClause}.`,
  c => `Command traffic out of ${b(c.loser)} fell silent during the action at ${c.bodyLoc}, which cost it ${numWord(c.count)} ${shipsWord(c.count)} against no loss to ${b(c.winner)}${c.namesClause}.`,
  c => `${b(c.loser)} will be asked to explain ${c.bodyLoc}: ${numWord(c.count)} ${shipsWord(c.count)} destroyed, and not a scratch on ${b(c.winner)}${c.namesClause}.`,
  c => `Debris from ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} drifts over ${c.bodyLoc} tonight. ${b(c.winner)} has nothing to add to the tally${c.namesClause}.`,
  c => `Fighting at ${c.bodyLoc} ran long enough to destroy ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} and not long enough for ${b(c.winner)} to lose anything${c.namesClause}.`,
  c => `${b(c.winner)} went to ${c.bodyLoc} expecting a battle and conducted an execution — ${numWord(c.count)} ${shipsWord(c.count)} of ${b(c.loser)} destroyed, none of its own${c.namesClause}.`,
  c => `Officers of ${b(c.loser)} are calling the affair at ${c.bodyLoc} a probing action; the probe cost ${numWord(c.count)} ${shipsWord(c.count)}, and ${b(c.winner)} paid nothing to answer it${c.namesClause}.`,
  c => `Not one ${b(c.winner)} crew was posted missing at ${c.bodyLoc}, while ${b(c.loser)} counts ${numWord(c.count)} ${shipsWord(c.count)} gone${c.namesClause}.`,
  c => `Fire-control logs held by ${b(c.winner)} run to a few pages. The cost to ${b(c.loser)} at ${c.bodyLoc} runs to ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `Rarely is a defeat this tidy: ${numWord(c.count)} ${shipsWord(c.count)} of ${b(c.loser)} destroyed at ${c.bodyLoc}, and ${b(c.winner)} back at its moorings at full strength${c.namesClause}.`,
  c => `Beacons from ${numWord(c.count)} lost ${shipsWord(c.count)} are still transmitting over ${c.bodyLoc}. Every one of them belongs to ${b(c.loser)}; ${b(c.winner)} left the field intact${c.namesClause}.`,
  c => `Underwriters have opened files on ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} lost at ${c.bodyLoc}, and none at all for ${b(c.winner)}${c.namesClause}.`,
  c => `Escape pods recovered near ${c.bodyLoc} carried ${b(c.loser)} crews and no others: ${b(c.winner)} lost nothing there, ${b(c.loser)} ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
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
  c => `No attacker has come forward after ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} were lost near ${c.bodyLoc}${c.namesClause}.`,
  c => `Analysts have no explanation for the ${numWord(c.count)} ${shipsWord(c.count)} ${b(c.loser)} lost at ${c.bodyLoc}${c.namesClause}.`,
  c => `Something struck ${b(c.loser)}'s formation near ${c.bodyLoc}, and nobody has said what — ${numWord(c.count)} ${shipsWord(c.count)} gone${c.namesClause}.`,
  c => `Silence is the only report coming out of ${c.bodyLoc}, where ${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)}${c.namesClause}.`,
  c => `Unknown forces are being blamed for ${numWord(c.count)} ${b(c.loser)} ${shipsWord(c.count)} destroyed near ${c.bodyLoc}${c.namesClause}.`,
  c => `Ships simply stopped answering hails near ${c.bodyLoc} — ${b(c.loser)} confirms ${numWord(c.count)} ${shipsWord(c.count)} lost${c.namesClause}.`,
  c => `Whoever hit ${b(c.loser)} near ${c.bodyLoc} left no trace and no message — ${numWord(c.count)} ${shipsWord(c.count)} destroyed${c.namesClause}.`,
  c => `Command has no answer for the ${numWord(c.count)} ${shipsWord(c.count)} ${b(c.loser)} lost near ${c.bodyLoc}${c.namesClause}.`,
  c => `Officials from ${b(c.loser)} say they still don't know who hit them near ${c.bodyLoc}, only that ${numWord(c.count)} ${shipsWord(c.count)} are gone${c.namesClause}.`,
  c => `Fear is spreading through ${b(c.loser)}'s ranks after ${numWord(c.count)} ${shipsWord(c.count)} vanished near ${c.bodyLoc} without a trace${c.namesClause}.`,
  c => `Question marks hang over ${c.bodyLoc}, where ${b(c.loser)} lost ${numWord(c.count)} ${shipsWord(c.count)} to an attacker nobody can name${c.namesClause}.`,
  c => `Sources close to ${b(c.loser)} say the ${numWord(c.count)} ${shipsWord(c.count)} lost near ${c.bodyLoc} never sent a distress call at all${c.namesClause}.`,
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
  c => `SILENT DEATH AT ${c.body.toUpperCase()}`,
  c => `UNKNOWN HAND STRIKES AT ${c.body.toUpperCase()}`,
  c => `GHOST FLEET BLAMED FOR ${c.body.toUpperCase()} LOSSES`,
  c => `VANISHED WITHOUT A TRACE NEAR ${c.body.toUpperCase()}`,
  c => `UNCLAIMED ATTACK ROCKS ${c.loser.toUpperCase()}`,
  c => `DARKNESS OVER ${c.body.toUpperCase()}`,
  c => `TRACELESS STRIKE LEAVES ${c.loser.toUpperCase()} REELING`,
  c => `FACELESS ENEMY HITS ${c.loser.toUpperCase()} AT ${c.body.toUpperCase()}`,
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
  c => `${c.bodyLoc} turned into a slaughterhouse for both sides — ${b(c.factionA)} lost ${numWord(c.countA)}${c.namesAClause}, ${b(c.factionB)} lost ${numWord(c.countB)}${c.namesBClause}.`,
  c => `Sensors over ${c.bodyLoc} recorded simultaneous losses: ${numWord(c.countA)} for ${b(c.factionA)}, ${numWord(c.countB)} for ${b(c.factionB)}.`,
  c => `Wreckage from both ${b(c.factionA)} and ${b(c.factionB)} now drifts through ${c.bodyLoc}, ${numWord(c.countA)} and ${numWord(c.countB)} hulls respectively.`,
  c => `The toll at ${c.bodyLoc} runs both ways tonight — ${numWord(c.countA)} ${b(c.factionA)} ${shipsWord(c.countA)} down, ${numWord(c.countB)} ${b(c.factionB)} ${shipsWord(c.countB)} down.`,
  c => `Grim arithmetic over ${c.bodyLoc}: ${b(c.factionA)} minus ${numWord(c.countA)}, ${b(c.factionB)} minus ${numWord(c.countB)}, and the fight isn't over.`,
  c => `Survivors from both fleets straggled home from ${c.bodyLoc} after ${b(c.factionA)} and ${b(c.factionB)} traded ${numWord(c.countA)} and ${numWord(c.countB)} losses.`,
  c => `Command staff on both sides are calling ${c.bodyLoc} a wash — ${numWord(c.countA)} for ${b(c.factionA)}, ${numWord(c.countB)} for ${b(c.factionB)}.`,
  c => `${c.bodyLoc} changed hands zero times today despite heavy fighting — ${b(c.factionA)} down ${numWord(c.countA)}, ${b(c.factionB)} down ${numWord(c.countB)}.`,
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
  c => `${c.body.toUpperCase()} LEFT IN RUINS BY BOTH FLEETS`,
  c => `HEAVY LOSSES ON BOTH SIDES AT ${c.body.toUpperCase()}`,
  c => `${c.factionA.toUpperCase()}, ${c.factionB.toUpperCase()} TRADE BLOWS AT ${c.body.toUpperCase()}`,
  c => `GRIM TOLL AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} CHANGES HANDS TO NO ONE`,
  c => `DRAW DECLARED AT ${c.body.toUpperCase()}`,
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
  c => `${b(c.winner)} broke ${b(c.loser)}'s line at ${c.bodyLoc}, losing ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to claim ${numWord(c.loserCount)} kills.`,
  c => `Outmatched from the start, ${b(c.loser)} shed ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} at ${c.bodyLoc} while ${b(c.winner)} escaped with ${numWord(c.winnerCount)}.`,
  c => `${b(c.winner)} left no doubt at ${c.bodyLoc}, sinking ${numWord(c.loserCount)} of ${b(c.loser)}'s ${shipsWord(c.loserCount)} for ${numWord(c.winnerCount)} of its own.`,
  c => `The margin at ${c.bodyLoc} was brutal: ${numWord(c.loserCount)} ${b(c.loser)} ${shipsWord(c.loserCount)} destroyed against ${numWord(c.winnerCount)} lost by ${b(c.winner)}.`,
  c => `${b(c.loser)} never recovered its footing at ${c.bodyLoc}, ceding ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} to ${b(c.winner)}'s ${numWord(c.winnerCount)}.`,
  c => `Tactical superiority carried ${b(c.winner)} at ${c.bodyLoc} — ${numWord(c.winnerCount)} lost to inflict ${numWord(c.loserCount)} on ${b(c.loser)}.`,
  c => `Wreckage tells the tale at ${c.bodyLoc}: ${numWord(c.loserCount)} hulls belong to ${b(c.loser)}, only ${numWord(c.winnerCount)} to ${b(c.winner)}.`,
  c => `${b(c.winner)} pressed every advantage at ${c.bodyLoc}, walking away with ${numWord(c.winnerCount)} losses to ${b(c.loser)}'s ${numWord(c.loserCount)}.`,
  c => `Few expected ${b(c.loser)} to hold ${c.bodyLoc}, and it showed — ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} gone to ${b(c.winner)}'s ${numWord(c.winnerCount)}.`,
  c => `By the time the guns fell silent at ${c.bodyLoc}, ${b(c.winner)} had lost ${numWord(c.winnerCount)} against ${numWord(c.loserCount)} for ${b(c.loser)}.`,
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
  c => `${c.winner.toUpperCase()} BREAKS ${c.loser.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `ROUT AT ${c.body.toUpperCase()}`,
  c => `${c.loser.toUpperCase()} CRUSHED AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} SWEEPS THE FIELD AT ${c.body.toUpperCase()}`,
  c => `NO CONTEST AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} WRECKAGE TELLS THE TALE`,
  c => `${c.winner.toUpperCase()} LEAVES ${c.loser.toUpperCase()} REELING AT ${c.body.toUpperCase()}`,
  c => `LOPSIDED LOSSES AT ${c.body.toUpperCase()}`,
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
  c => `Victory came at a price for ${b(c.winner)} at ${c.bodyLoc} — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost to claim ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `Both fleets left ${c.bodyLoc} diminished, though ${b(c.winner)} held the field, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `Casualties ran high on both sides at ${c.bodyLoc}, but ${b(c.winner)} came out ahead, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `The ledger from ${c.bodyLoc} favors ${b(c.winner)} by a slim margin — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost against ${numWord(c.loserCount)} of ${b(c.loser)}'s.`,
  c => `Blood was spent freely at ${c.bodyLoc}, and ${b(c.winner)} spent less of it, ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to ${numWord(c.loserCount)}.`,
  c => `Two fleets ground each other down at ${c.bodyLoc} before ${b(c.winner)} came out on top, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `Numbers favored no one at ${c.bodyLoc}, but ${b(c.winner)} finished with fewer losses — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to ${numWord(c.loserCount)}.`,
  c => `Close as it gets: ${b(c.winner)} took ${c.bodyLoc}, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `Every ship counted at ${c.bodyLoc}, and ${b(c.winner)} counted just enough to win, losing ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to take ${numWord(c.loserCount)}.`,
  c => `Ships burned on both sides at ${c.bodyLoc} before ${b(c.winner)} pulled ahead, ${numWord(c.loserCount)} to ${numWord(c.winnerCount)}.`,
  c => `Margins don't get much thinner than ${c.bodyLoc}, where ${b(c.winner)} beat ${b(c.loser)} by losing only ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} to ${numWord(c.loserCount)}.`,
  c => `Fighting at ${c.bodyLoc} chewed through both fleets before ${b(c.winner)} came out on top, ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost to claim ${numWord(c.loserCount)}.`,
  c => `${b(c.winner)} holds ${c.body} tonight, at a cost of ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} against the ${numWord(c.loserCount)} lost by ${b(c.loser)}.`,
  c => `At ${c.bodyLoc}, both sides left wreckage behind: ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} for ${b(c.loser)}, ${numWord(c.winnerCount)} for ${b(c.winner)}.`,
  c => `${numWord(c.loserCount)} ${shipsWord(c.loserCount)} of ${b(c.loser)} and ${numWord(c.winnerCount)} of ${b(c.winner)} were destroyed at ${c.bodyLoc}; the difference is the whole story.`,
  c => `The result at ${c.bodyLoc} goes to ${b(c.winner)} on a count of ${numWord(c.loserCount)} to ${numWord(c.winnerCount)} — not a margin anyone will put on a banner.`,
  c => `${b(c.loser)} lost ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} at ${c.bodyLoc}. ${b(c.winner)} lost ${numWord(c.winnerCount)} and is calling the day its own.`,
  c => `Salvage tenders from both powers are working the same debris field over ${c.body}, ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} of it belonging to ${b(c.loser)} and ${numWord(c.winnerCount)} to ${b(c.winner)}.`,
  c => `Hospital berths on either side of ${c.body} are full. ${b(c.winner)} counts ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost, ${b(c.loser)} ${numWord(c.loserCount)}.`,
  c => `Victory is the word ${b(c.winner)} is using for ${c.body}; ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} of its own did not come back, and ${numWord(c.loserCount)} of ${b(c.loser)} did not either.`,
  c => `Fighting over ${c.bodyLoc} went on well past the point either fleet could afford, ending with ${b(c.loser)} down ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} and ${b(c.winner)} down ${numWord(c.winnerCount)}.`,
  c => `Neither ${b(c.winner)} nor ${b(c.loser)} will want to repeat ${c.body}: ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} lost by the former, ${numWord(c.loserCount)} by the latter.`,
  c => `A win of sorts for ${b(c.winner)} at ${c.bodyLoc}, where ${numWord(c.loserCount)} ${b(c.loser)} ${shipsWord(c.loserCount)} and ${numWord(c.winnerCount)} of its own were destroyed.`,
  c => `The bill for ${b(c.winner)} at ${c.bodyLoc} came to ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)}; the bill for ${b(c.loser)} came to ${numWord(c.loserCount)}.`,
  c => `Watch officers on both sides described the action at ${c.body} as confused. ${b(c.loser)} lost ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} in the confusion, ${b(c.winner)} ${numWord(c.winnerCount)}.`,
  c => `Reactor plumes were still visible from ${c.body} at dawn, marking ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} lost by ${b(c.loser)} and ${numWord(c.winnerCount)} by ${b(c.winner)}.`,
  c => `Fortune, and not much of it, went to ${b(c.winner)} at ${c.bodyLoc}: ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} of its own destroyed against ${numWord(c.loserCount)} of ${b(c.loser)}.`,
  c => `${b(c.loser)} withdrew from ${c.bodyLoc} in reasonable order, having lost ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} to the ${numWord(c.winnerCount)} it took from ${b(c.winner)}.`,
  c => `The engagement at ${c.bodyLoc} was settled by a count of ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} to ${numWord(c.winnerCount)}, in favour of ${b(c.winner)}.`,
  c => `Yards on both sides of the line have work now — ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} gone from ${b(c.winner)}, ${numWord(c.loserCount)} from ${b(c.loser)}, all of it at ${c.bodyLoc}.`,
  c => `Fought down to the last serviceable gun, the action at ${c.body} cost ${b(c.loser)} ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} and ${b(c.winner)} ${numWord(c.winnerCount)}.`,
  c => `${b(c.winner)} claims ${c.body}, and the claim is not being disputed; ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} of its own and ${numWord(c.loserCount)} of ${b(c.loser)} were destroyed proving it.`,
  c => `Little separated the two fleets at ${c.bodyLoc} except the final count: ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} for ${b(c.loser)}, ${numWord(c.winnerCount)} for ${b(c.winner)}.`,
  c => `Crews of ${b(c.winner)} are being stood down rather than resupplied after ${c.body}, where ${numWord(c.winnerCount)} ${shipsWord(c.winnerCount)} ${plural(c.winnerCount, 'was', 'were')} lost against ${numWord(c.loserCount)} of ${b(c.loser)}.`,
  c => `The name ${c.body} will sit badly in both fleets: ${b(c.loser)} lost ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} there, ${b(c.winner)} ${numWord(c.winnerCount)}.`,
  c => `Deep-space relays carried the tally from ${c.body} before either capital was ready for it — ${numWord(c.loserCount)} ${shipsWord(c.loserCount)} lost by ${b(c.loser)}, ${numWord(c.winnerCount)} by ${b(c.winner)}.`,
];

const BATTLE_NARROW_HEADLINE = [
  c => `${c.winner.toUpperCase()} CLAIMS COSTLY WIN AT ${c.body.toUpperCase()}`,
  c => `HARD-FOUGHT VICTORY FOR ${c.winner.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} EDGES OUT ${c.loser.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `${c.winner.toUpperCase()} SCRAPES BY AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} COULD HAVE GONE EITHER WAY`,
  c => `NARROW MARGIN DECIDES ${c.body.toUpperCase()}`,
  c => `COSTLY VICTORY AT ${c.body.toUpperCase()}`,
  c => `VICTORY, BUT BARELY, AT ${c.body.toUpperCase()}`,
  c => `BOTH SIDES BLED AT ${c.body.toUpperCase()}`,
  c => `CLOSE CALL AT ${c.body.toUpperCase()}`,
  c => `BLOODY MARGIN DECIDES ${c.body.toUpperCase()}`,
  c => `THIN VICTORY FOR ${c.winner.toUpperCase()}`,
  c => `TOO CLOSE TO CALL AT ${c.body.toUpperCase()}`,
  c => `EVERY SHIP COUNTED AT ${c.body.toUpperCase()}`,
  c => `PYRRHIC WIN FOR ${c.winner.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `GRINDING FIGHT ENDS AT ${c.body.toUpperCase()}`,
];

const BATTLE_CHAOS = [
  c => `${c.bodyLoc} descended into chaos as ${numWord(c.partyCount)} factions clashed at once. Casualties: ${c.sideList}.`,
  c => `A free-for-all erupted at ${c.bodyLoc} — ${c.sideList}.`,
  c => `No fewer than ${numWord(c.partyCount)} powers traded fire over ${c.bodyLoc} today: ${c.sideList}.`,
  c => `The battle of ${c.bodyLoc} drew in ${numWord(c.partyCount)} factions before it was over: ${c.sideList}.`,
  c => `Nobody thought to call a truce at ${c.bodyLoc} — ${numWord(c.partyCount)} factions went in, and only wreckage came out: ${c.sideList}.`,
  c => `${c.bodyLoc} turned into a shooting gallery with ${numWord(c.partyCount)} sides trading fire at once: ${c.sideList}.`,
  c => `Total confusion reigned at ${c.bodyLoc} as ${numWord(c.partyCount)} powers collided: ${c.sideList}.`,
  c => `When the smoke cleared over ${c.bodyLoc}, ${numWord(c.partyCount)} factions were counting losses: ${c.sideList}.`,
  c => `Flags from ${numWord(c.partyCount)} powers flew over ${c.bodyLoc} today, and none of them flew home unscathed: ${c.sideList}.`,
  c => `Reports from ${c.bodyLoc} describe a tangle of ${numWord(c.partyCount)} factions with no clear front line: ${c.sideList}.`,
  c => `Chaos doesn't begin to cover what happened at ${c.bodyLoc}, where ${numWord(c.partyCount)} sides opened fire at once: ${c.sideList}.`,
  c => `Everyone had a stake in ${c.bodyLoc}, and everyone paid for it — ${numWord(c.partyCount)} factions, ${c.sideList}.`,
  c => `Multiple fleets, one battlefield: ${c.bodyLoc} saw ${numWord(c.partyCount)} factions grind each other down: ${c.sideList}.`,
  c => `Confusion was the only victor at ${c.bodyLoc}, where ${numWord(c.partyCount)} powers fought without a clear line of battle: ${c.sideList}.`,
  c => `Smoke still hangs over ${c.bodyLoc} after ${numWord(c.partyCount)} factions collided with no coordination and less mercy: ${c.sideList}.`,
  c => `Gunfire came from every direction at ${c.bodyLoc} as ${numWord(c.partyCount)} factions piled into the same fight: ${c.sideList}.`,
  c => `Factions numbering ${numWord(c.partyCount)} converged on ${c.bodyLoc} with predictably messy results: ${c.sideList}.`,
  c => `Combat logs from ${c.bodyLoc} read like a casualty list from every side at once: ${c.sideList}.`,
  c => `Order broke down entirely at ${c.bodyLoc} once ${numWord(c.partyCount)} factions arrived within firing range of each other: ${c.sideList}.`,
  c => `Pandemonium at ${c.bodyLoc} left ${numWord(c.partyCount)} factions counting their own dead: ${c.sideList}.`,
];

// --- GANG-UP: two or more powers on one victim -------------------------
//
// The dominant endgame shape, and previously unwritable. One victim with
// two credited killers used to fail the `killerSet.size === 1` test and
// fall through to the ATTACKER-UNKNOWN bank — the paper reported a
// coordinated execution as an unsolved mystery. `attackers` is the
// formatted list; `tollClause` is empty when the victim never landed a
// hit, which is itself the story.
const BATTLE_GANG_UP = [
  c => `${c.attackers} fell on ${b(c.victim)} together at ${c.bodyLoc} — ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.namesClause}${c.tollClause}.`,
  c => `It took ${numWord(c.attackerCount)} of them: ${c.attackers} converged on ${b(c.victim)} at ${c.bodyLoc}, leaving ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} in pieces${c.tollClause}.`,
  c => `${b(c.victim)} was caught between ${c.attackers} at ${c.bodyLoc}. ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} did not survive the crossfire${c.tollClause}.`,
  c => `A coordinated kill at ${c.bodyLoc}: ${c.attackers} split ${numWord(c.victimCount)} ${b(c.victim)} ${shipsWord(c.victimCount)} between them${c.tollClause}.`,
  c => `No allies came for ${b(c.victim)} at ${c.bodyLoc} — ${c.attackers} took ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} apart at their leisure${c.namesClause}${c.tollClause}.`,
  c => `${c.attackers} arrived at ${c.bodyLoc} from different vectors and left with the same result: ${numWord(c.victimCount)} ${b(c.victim)} ${shipsWord(c.victimCount)} destroyed${c.tollClause}.`,
  c => `Together, ${c.attackers} cornered ${b(c.victim)} at ${c.bodyLoc}, leaving ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} wrecked${c.tollClause}.`,
  c => `Caught between ${c.attackers} at ${c.bodyLoc}, ${b(c.victim)} lost ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} before anyone could break off${c.namesClause}${c.tollClause}.`,
  c => `Numbers decided ${c.bodyLoc}: ${c.attackers} against a single target, ${b(c.victim)}, for ${numWord(c.victimCount)} ${shipsWord(c.victimCount)}${c.tollClause}.`,
  c => `Between ${c.attackers}, ${b(c.victim)} never had a lane out of ${c.bodyLoc} — ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.tollClause}.`,
  c => `When ${c.attackers} converge on one target, this is what's left: ${numWord(c.victimCount)} ${b(c.victim)} ${shipsWord(c.victimCount)}, gone at ${c.bodyLoc}${c.tollClause}.`,
  c => `The math never favored ${b(c.victim)} at ${c.bodyLoc}, not against ${c.attackers} at once — ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.tollClause}.`,
  c => `Outnumbered from the start, ${b(c.victim)} lost ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} to ${c.attackers} at ${c.bodyLoc}${c.namesClause}${c.tollClause}.`,
  c => `Ganged up on at ${c.bodyLoc}, ${b(c.victim)} went down to ${c.attackers} — ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.tollClause}.`,
  c => `Surrounded at ${c.bodyLoc} by ${c.attackers}, ${b(c.victim)} had no clean line of retreat and paid for it: ${numWord(c.victimCount)} ${shipsWord(c.victimCount)}${c.tollClause}.`,
  c => `Nowhere to run at ${c.bodyLoc} — ${c.attackers} closed on ${b(c.victim)} from every side, ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.tollClause}.`,
  c => `What ${b(c.victim)} faced at ${c.bodyLoc} wasn't a battle so much as a pincer: ${c.attackers}, and ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} to show for it${c.tollClause}.`,
  c => `Reports from ${c.bodyLoc} confirm ${c.attackers} timed their strike together, leaving ${b(c.victim)} down ${numWord(c.victimCount)} ${shipsWord(c.victimCount)}${c.namesClause}${c.tollClause}.`,
  c => `Once ${c.attackers} picked their moment at ${c.bodyLoc}, ${b(c.victim)} never stood a chance — ${numWord(c.victimCount)} ${shipsWord(c.victimCount)} lost${c.tollClause}.`,
  c => `Two fronts, one grave: ${c.attackers} hit ${b(c.victim)} from either side of ${c.bodyLoc}, costing ${numWord(c.victimCount)} ${shipsWord(c.victimCount)}${c.tollClause}.`,
];

const BATTLE_GANG_UP_HEADLINE = [
  c => `${c.victim.toUpperCase()} SURROUNDED AT ${c.body.toUpperCase()}`,
  c => `${numWord(c.attackerCount).toUpperCase()} AGAINST ONE AT ${c.body.toUpperCase()}`,
  c => `THEY CAME FOR ${c.victim.toUpperCase()} TOGETHER`,
  c => `${c.body.toUpperCase()}: A COORDINATED KILL`,
  c => `NO ALLIES CAME: ${c.victim.toUpperCase()} CUT DOWN AT ${c.body.toUpperCase()}`,
  c => `${c.victim.toUpperCase()} CAUGHT IN THE CROSSFIRE AT ${c.body.toUpperCase()}`,
  c => `CORNERED: ${c.victim.toUpperCase()} DOWN AT ${c.body.toUpperCase()}`,
  c => `PINCER MOVE ENDS ${c.victim.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `OUTNUMBERED ${c.victim.toUpperCase()} FALLS AT ${c.body.toUpperCase()}`,
  c => `GANGED UP: ${c.body.toUpperCase()} TURNS DEADLY FOR ${c.victim.toUpperCase()}`,
  c => `TIMED STRIKE LEAVES ${c.victim.toUpperCase()} IN PIECES`,
  c => `GROUP TACTICS DECIDE ${c.body.toUpperCase()}`,
  c => `TWO FRONTS, ONE GRAVE AT ${c.body.toUpperCase()}`,
  c => `OUTFLANKED: ${c.victim.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `NUMBERS WIN AT ${c.body.toUpperCase()}`,
  c => `MULTIPLE ATTACKERS CONVERGE ON ${c.victim.toUpperCase()}`,
];

// --- MELEE ROUT: 3+ powers in, one of them annihilated -----------------
//
// The multi-faction branch used to have no ratio logic at all, so a
// 15-1-1 slaughter read as "total confusion reigned". It wasn't
// confusion; one side was executed while the others traded scratches.
const BATTLE_MELEE_ROUT = [
  c => `${numWord(c.partyCount)} powers met at ${c.bodyLoc} and only ${b(c.worst)} paid for it — ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} lost against ${numWord(c.othersCount)} for everyone else combined.`,
  c => `It was billed as a ${numWord(c.partyCount)}-way battle at ${c.bodyLoc}. It ended as an execution: ${c.sideList}.`,
  c => `${b(c.worst)} walked into ${numWord(c.partyCount)}-sided fighting at ${c.bodyLoc} and absorbed almost all of it: ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} lost against ${numWord(c.othersCount)} for everyone else combined.`,
  c => `The melee at ${c.bodyLoc} had ${numWord(c.partyCount)} sides and one loser: ${c.sideList}.`,
  c => `Whatever ${b(c.worst)} expected at ${c.bodyLoc}, it wasn't this — ${c.sideList}.`,
  c => `Call it a battle if you like — at ${c.bodyLoc}, ${b(c.worst)} did the dying alone, ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} against ${numWord(c.othersCount)} for everyone else.`,
  c => `What started as a ${numWord(c.partyCount)}-way brawl at ${c.bodyLoc} ended as a one-sided slaughter: ${c.sideList}.`,
  c => `By the time the guns fell silent over ${c.bodyLoc}, ${b(c.worst)} alone had lost ${numWord(c.worstCount)} ${shipsWord(c.worstCount)}, against ${numWord(c.othersCount)} shared by the rest.`,
  c => `Losses at ${c.bodyLoc} tell the whole story: ${c.sideList}.`,
  c => `Numbers from ${c.bodyLoc} don't lie — ${b(c.worst)} absorbed the war while ${numWord(c.partyCount)} other powers barely traded shots: ${c.sideList}.`,
  c => `Analysts are calling ${c.bodyLoc} the most lopsided ${numWord(c.partyCount)}-way engagement in memory: ${c.sideList}.`,
  c => `Only ${b(c.worst)} left ${c.bodyLoc} in ruin — ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} against ${numWord(c.othersCount)} spread across everyone else.`,
  c => `That ${c.bodyLoc} drew ${numWord(c.partyCount)} factions hardly mattered once the tally came in: ${b(c.worst)} lost ${numWord(c.worstCount)}, the rest lost ${numWord(c.othersCount)} between them.`,
  c => `In a fight that drew ${numWord(c.partyCount)} factions to ${c.bodyLoc}, only one of them bled: ${b(c.worst)}, for ${numWord(c.worstCount)} ${shipsWord(c.worstCount)}.`,
  c => `Nothing about ${c.bodyLoc} resembled a fair engagement once ${b(c.worst)}'s losses came in at ${numWord(c.worstCount)} against a combined ${numWord(c.othersCount)} for the rest.`,
  c => `One side did all the dying at ${c.bodyLoc}: ${c.sideList}.`,
  c => `Wreckage at ${c.bodyLoc} belongs almost entirely to ${b(c.worst)} — ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} against ${numWord(c.othersCount)} for the rest combined.`,
  c => `So much for an even fight at ${c.bodyLoc} — ${b(c.worst)} took ${numWord(c.worstCount)} ${shipsWord(c.worstCount)} of losses while the rest split ${numWord(c.othersCount)}.`,
  c => `Correspondents counted ${numWord(c.partyCount)} flags at ${c.bodyLoc} and one body count that mattered: ${b(c.worst)}'s.`,
  c => `History will record ${numWord(c.partyCount)} factions at ${c.bodyLoc}, though only ${b(c.worst)} paid for it — ${c.sideList}.`,
];

const BATTLE_MELEE_ROUT_HEADLINE = [
  c => `${c.worst.toUpperCase()} GUTTED IN ${c.body.toUpperCase()} MELEE`,
  c => `${numWord(c.partyCount).toUpperCase()} SIDES, ONE LOSER: ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()}: NOT A BATTLE, AN EXECUTION`,
  c => `${c.worst.toUpperCase()} ABSORBS THE WHOLE WAR AT ${c.body.toUpperCase()}`,
  c => `ONE-WAY MELEE AT ${c.body.toUpperCase()}`,
  c => `SLAUGHTER AT ${c.body.toUpperCase()}`,
  c => `LOPSIDED CARNAGE AT ${c.body.toUpperCase()}`,
  c => `UNEVEN ODDS, UGLY RESULT: ${c.body.toUpperCase()}`,
  c => `TALLY FROM ${c.body.toUpperCase()}: ONE SIDE BLED`,
  c => `WRECKAGE OF ${c.worst.toUpperCase()} LITTERS ${c.body.toUpperCase()}`,
  c => `SO MUCH FOR A FAIR FIGHT AT ${c.body.toUpperCase()}`,
  c => `CALLED A BATTLE, LOOKED LIKE AN EXECUTION`,
  c => `ANALYSTS: ${c.body.toUpperCase()} MOST LOPSIDED YET`,
  c => `HISTORY WON'T FORGET ${c.worst.toUpperCase()}'S LOSSES AT ${c.body.toUpperCase()}`,
  c => `NO CONTEST AT ${c.body.toUpperCase()}`,
  c => `ONLY ${c.worst.toUpperCase()} PAID THE PRICE AT ${c.body.toUpperCase()}`,
];

const BATTLE_CHAOS_HEADLINE = [
  c => `CHAOS AT ${c.body.toUpperCase()}: ${numWord(c.partyCount).toUpperCase()}-WAY BATTLE ERUPTS`,
  c => `FREE-FOR-ALL AT ${c.body.toUpperCase()} LEAVES WRECKAGE ACROSS THE SYSTEM`,
  c => `${c.body.toUpperCase()} DESCENDS INTO CHAOS`,
  c => `EVERYONE'S AT WAR: MELEE ENGULFS ${c.body.toUpperCase()}`,
  c => `${numWord(c.partyCount).toUpperCase()}-SIDED BATTLE ROYALE AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} TURNS INTO A SHOOTING GALLERY`,
  c => `ANARCHY AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()}: WHEN EVERYONE SHOWED UP TO FIGHT`,
  c => `PANDEMONIUM AT ${c.body.toUpperCase()}`,
  c => `GUNFIRE FROM EVERY DIRECTION AT ${c.body.toUpperCase()}`,
  c => `MULTI-SIDED BRAWL LEAVES ${c.body.toUpperCase()} IN RUINS`,
  c => `NOBODY WON AT ${c.body.toUpperCase()}`,
  c => `TOTAL CONFUSION REIGNS AT ${c.body.toUpperCase()}`,
  c => `MELEE WITH NO CLEAR SIDES AT ${c.body.toUpperCase()}`,
  c => `WAR OF ALL AGAINST ALL AT ${c.body.toUpperCase()}`,
  c => `SMOKE OVER ${c.body.toUpperCase()} AS FACTIONS COLLIDE`,
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
  c => `${c.bodyLoc} smolders under a fresh crater today${c.attacker ? `, and ${b(c.attacker)} has taken credit` : ', with no one claiming the strike'}.`,
  c => `Debris rained down on ${c.bodyLoc} this cycle${c.attacker ? ` — ${b(c.attacker)} wanted it seen` : ', origin unknown'}.`,
  c => `Half the yield, all the damage: ${c.bodyLoc} took an asteroid to the surface${c.attacker ? ` at ${b(c.attacker)}'s hand` : ''}.`,
  c => `Tremors shook ${c.bodyLoc} today as a rock struck home${c.attacker ? `, hurled by ${b(c.attacker)}` : ''}.`,
  c => `Engineers are still counting the damage on ${c.bodyLoc} after ${c.attacker ? `${b(c.attacker)}'s kinetic strike` : 'an unclaimed kinetic strike'}.`,
  c => `Fires still burn on ${c.bodyLoc} tonight, testament to ${c.attacker ? `${b(c.attacker)}'s handiwork` : 'a rock with no signature'}.`,
  c => `Production charts for ${c.bodyLoc} crashed overnight — blame the crater${c.attacker ? ` ${b(c.attacker)} left behind` : ' no one has claimed'}.`,
  c => `Word from ${c.bodyLoc}: a strike from orbit has cut output in half${c.attacker ? `, and ${b(c.attacker)} isn't hiding it` : ''}.`,
  c => `Governors on ${c.bodyLoc} are demanding answers after a kinetic strike${c.attacker ? ` traced to ${b(c.attacker)}` : ' with no known origin'}.`,
  c => `Orbital tracking stations logged the rock's path straight into ${c.bodyLoc}${c.attacker ? `, launched by ${b(c.attacker)}` : ', launched by persons unknown'}.`,
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
  c => `${c.body.toUpperCase()} LEFT SMOLDERING AFTER STRIKE`,
  c => `ORBITAL ROCK SLAMS INTO ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} OUTPUT HALVED IN ATTACK`,
  c => `TREMORS ROCK ${c.body.toUpperCase()} AFTER IMPACT`,
  c => `${c.body.toUpperCase()} GOVERNORS DEMAND ANSWERS`,
  c => `NO CLAIM YET IN ${c.body.toUpperCase()} STRIKE`,
];

const SHIP_DETONATED = [
  c => `${b(c.actor)}'s ${c.shipName} went out in a blaze at ${c.bodyLoc} — the crew triggered the core rather than surrender, ${c.destroyedText}.`,
  c => `Rather than be boarded, ${b(c.actor)}'s ${c.shipName} self-destructed at ${c.bodyLoc}. ${c.destroyedText}.`,
  c => `${c.shipName} took itself apart at ${c.bodyLoc} in a final act of defiance — ${b(c.actor)} confirms the detonation, ${c.destroyedText}.`,
  c => `A last stand at ${c.bodyLoc}: ${b(c.actor)}'s ${c.shipName} blew its core rather than fall into enemy hands, ${c.destroyedText}.`,
  c => `The crew of ${c.shipName} chose the void over defeat, detonating at ${c.bodyLoc}. ${c.destroyedText}.`,
  c => `${b(c.actor)} lost ${c.shipName} to a deliberate detonation at ${c.bodyLoc} — ${c.destroyedText}.`,
  c => `No surrender at ${c.bodyLoc}: ${c.shipName} went up rather than go dark quietly, ${c.destroyedText}.`,
  c => `Better to burn than surrender — that was the calculus aboard ${c.shipName} at ${c.bodyLoc} when ${b(c.actor)}'s crew triggered the core, ${c.destroyedText}.`,
  c => `Defiance, not defeat, is how ${b(c.actor)} is framing the loss of ${c.shipName} at ${c.bodyLoc} — the crew detonated rather than strike their colors, ${c.destroyedText}.`,
  c => `Sooner than hand ${c.shipName} over intact, its crew blew the core at ${c.bodyLoc}, ${c.destroyedText}.`,
  c => `Witnesses at ${c.bodyLoc} watched ${c.shipName} light up from within — ${b(c.actor)} says the crew chose detonation over capture, ${c.destroyedText}.`,
  c => `Fire consumed ${c.shipName} at ${c.bodyLoc} by its own crew's hand rather than an enemy's, ${c.destroyedText}.`,
  c => `Instead of striking colors at ${c.bodyLoc}, ${b(c.actor)}'s crew aboard ${c.shipName} chose the core switch, ${c.destroyedText}.`,
  c => `Nothing was left to capture at ${c.bodyLoc} once ${c.shipName}'s crew triggered the detonation themselves, ${c.destroyedText}.`,
  c => `Records confirm ${c.shipName} was lost to a deliberate self-destruct at ${c.bodyLoc}, not enemy fire — ${c.destroyedText}.`,
  c => `One last message came from ${c.shipName} before it went up at ${c.bodyLoc}: refusal, not distress. ${c.destroyedText}.`,
  c => `Detonation, not defeat, ended ${c.shipName} at ${c.bodyLoc} — ${b(c.actor)}'s crew chose the switch over the boarding party, ${c.destroyedText}.`,
  c => `Self-destruction claimed ${c.shipName} at ${c.bodyLoc} before the enemy could close the distance, ${c.destroyedText}.`,
  c => `Facing capture at ${c.bodyLoc}, ${c.shipName}'s crew answered with the core override, ${c.destroyedText}.`,
  c => `Given the choice at ${c.bodyLoc}, ${b(c.actor)}'s crew aboard ${c.shipName} chose the blast over the brig, ${c.destroyedText}.`,
];

const SHIP_DETONATED_HEADLINE = [
  c => `SUICIDE STRIKE AT ${c.body.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SHIP SELF-DESTRUCTS AT ${c.body.toUpperCase()}`,
  c => `LAST STAND AT ${c.body.toUpperCase()}`,
  c => `${c.body.toUpperCase()} ROCKED BY DELIBERATE BLAST`,
  c => `NO SURRENDER: ${c.actor.toUpperCase()} DETONATES AT ${c.body.toUpperCase()}`,
  c => `DEFIANT CREW BLOWS THE CORE AT ${c.body.toUpperCase()}`,
  c => `CORE OVERRIDE ENDS ${c.actor.toUpperCase()} SHIP AT ${c.body.toUpperCase()}`,
  c => `BLAZE OF DEFIANCE AT ${c.body.toUpperCase()}`,
  c => `BETTER DEAD THAN BOARDED, SAYS ${c.actor.toUpperCase()}`,
  c => `SELF-DESTRUCT AT ${c.body.toUpperCase()}`,
  c => `CREW CHOOSES BLAST OVER CAPTURE AT ${c.body.toUpperCase()}`,
  c => `RATHER BURN THAN SURRENDER AT ${c.body.toUpperCase()}`,
  c => `FINAL DEFIANCE AT ${c.body.toUpperCase()}`,
  c => `FIRE FROM WITHIN AT ${c.body.toUpperCase()}`,
  c => `DETONATION OVER SURRENDER AT ${c.body.toUpperCase()}`,
  c => `REFUSAL AT ${c.body.toUpperCase()}: ${c.actor.toUpperCase()} SHIP GOES DARK BY ITS OWN HAND`,
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
  name => ` Command confirms Captain ${b(name)} was killed when the hull failed.`,
  name => ` Casualty rolls now carry the name of Captain ${b(name)}.`,
  name => ` No survivors were pulled from Captain ${b(name)}'s section of the wreck.`,
  name => ` Fleet records close the file on Captain ${b(name)}, killed in action.`,
  name => ` Word from salvage crews: Captain ${b(name)} did not make it out.`,
  name => ` Reports from the scene confirm Captain ${b(name)} among the dead.`,
  name => ` Bridge logs end abruptly with Captain ${b(name)} still at the con.`,
  name => ` Salvage teams recovered no survivors, Captain ${b(name)} included.`,
  name => ` Final muster marks Captain ${b(name)} killed in the engagement.`,
  name => ` Sources aboard confirm Captain ${b(name)} perished with the vessel.`,
];

const CAPTAIN_RESCUED_CLAUSE = [
  name => ` Captain ${b(name)} was pulled from the wreck alive.`,
  name => ` Captain ${b(name)} survived and is already back on duty.`,
  name => ` A rescue craft reached Captain ${b(name)} before the hull cooled.`,
  name => ` Captain ${b(name)} made it out — the ship didn't.`,
  name => ` Command confirms Captain ${b(name)} recovered, shaken but alive.`,
  name => ` Captain ${b(name)} lives to fly again.`,
  name => ` Salvage crews pulled Captain ${b(name)} from the wreckage unharmed.`,
  name => ` Word from medical bay: Captain ${b(name)} will make a full recovery.`,
  name => ` Fleet command reports Captain ${b(name)} safe and accounted for.`,
  name => ` Rescue teams reached Captain ${b(name)} in time.`,
  name => ` Against the odds, Captain ${b(name)} walked away.`,
  name => ` Reports confirm Captain ${b(name)} escaped the wreck under their own power.`,
  name => ` The escape pod carrying Captain ${b(name)} was recovered intact.`,
  name => ` Good news from the front: Captain ${b(name)} is safe.`,
  name => ` No serious injuries reported for Captain ${b(name)}, now resting.`,
  name => ` Sources confirm Captain ${b(name)} came through without a scratch.`,
];

/** "…and X came through without a scratch" — the clause naming whoever
 *  won a multi-sided battle without losing a hull. It was a single
 *  hardcoded sentence, which made it one of the most-repeated strings
 *  in the paper: every three-way fight with a clean winner ended on
 *  the identical eight words. Takes the already-bolded name list and
 *  the count, so it can agree in number.
 *  `n` is the number of unscathed FACTIONS, not ships. */
const UNSCATHED_CLAUSE = [
  (who, n) => ` ${who} came through without a scratch.`,
  (who, n) => ` ${who} ${n === 1 ? 'walked' : 'walked'} away untouched.`,
  (who, n) => ` Not a hull lost on ${who}'s side.`,
  (who, n) => ` ${who} ${plural(n, 'is', 'are')} not on the casualty list at all.`,
  (who, n) => ` ${who} finished the day with the same fleet ${plural(n, 'it', 'they')} started with.`,
  (who, n) => ` ${who} paid nothing for the privilege.`,
  (who, n) => ` The butcher's bill skipped ${who} entirely.`,
  (who, n) => ` ${who} ${plural(n, 'took', 'took')} no losses worth reporting.`,
  (who, n) => ` No wreckage bore ${who}'s colors.`,
  (who, n) => ` ${who} came away clean.`,
  (who, n) => ` Whatever it cost, ${who} did not pay it.`,
  (who, n) => ` ${who} ${plural(n, 'ends', 'end')} the engagement at full strength.`,
  (who, n) => ` Salvage crews found nothing of ${who}'s to recover.`,
  (who, n) => ` ${who} ${plural(n, 'emerged', 'emerged')} without a single hull to replace.`,
];

// When the captain's fate isn't resolved within THIS digest's window
// (rescued/lost row fell outside it, or the lookup simply missed) —
// say only what's certain: someone commanded the ship. No claim about
// what happened to them.
const CAPTAIN_UNKNOWN_FATE_CLAUSE = [
  name => ` Captain ${b(name)} was in command.`,
  name => ` Captain ${b(name)} was aboard at the time.`,
  name => ` Captain ${b(name)} held the command post.`,
  name => ` Records list Captain ${b(name)} as commanding officer.`,
  name => ` The bridge answered to Captain ${b(name)}.`,
  name => ` Fleet logs name Captain ${b(name)} as officer in charge.`,
  name => ` Command records show Captain ${b(name)} in charge at the time.`,
  name => ` Duty rosters place Captain ${b(name)} in command.`,
  name => ` Ship's log names Captain ${b(name)} as commanding officer.`,
  name => ` No word yet beyond this: Captain ${b(name)} was in command.`,
];

const INDUSTRY_BOTH = [
  c => `${b(c.faction)} launched ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} and completed ${numWord(c.buildCount)} construction project${plural(c.buildCount, '')} today${c.shipNamesClause}.`,
  c => `A busy day for ${b(c.faction)}: ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} completed${c.shipNamesClause}.`,
  c => `${b(c.faction)}'s shipyards and engineers both delivered — ${numWord(c.shipCount)} vessel${plural(c.shipCount, '')} and ${numWord(c.buildCount)} finished project${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Industry hummed for ${b(c.faction)} today: ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} and ${numWord(c.buildCount)} completed upgrade${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `The fleet and the ledgers both grew for ${b(c.faction)} — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} launched, ${numWord(c.buildCount)} project${plural(c.buildCount, '')} closed out${c.shipNamesClause}.`,
  c => `${b(c.faction)} rolled out ${numWord(c.shipCount)} new hull${plural(c.shipCount, '')} while crews finished ${numWord(c.buildCount)} construction project${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Shipyards and construction crews for ${b(c.faction)} both delivered — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}, ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Fresh hulls and finished infrastructure for ${b(c.faction)}: ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} and ${numWord(c.buildCount)} project${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `${b(c.faction)} had a productive stretch — ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} in service and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} online${c.shipNamesClause}.`,
  c => `No slowdown for ${b(c.faction)}: ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} joined the fleet as ${numWord(c.buildCount)} construction project${plural(c.buildCount, '')} wrapped up${c.shipNamesClause}.`,
  c => `Two fronts of progress for ${b(c.faction)} — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned, ${numWord(c.buildCount)} project${plural(c.buildCount, '')} completed${c.shipNamesClause}.`,
  c => `${b(c.faction)} closed the day with ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} and ${numWord(c.buildCount)} finished upgrade${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Crews across ${b(c.faction)}'s holdings delivered on both fronts — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} and ${numWord(c.buildCount)} project${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Between the yards and the work sites, ${b(c.faction)} logged ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} and ${numWord(c.buildCount)} completed upgrade${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `${b(c.faction)} reported ${numWord(c.shipCount)} ship${plural(c.shipCount, '')} commissioned alongside ${numWord(c.buildCount)} construction project${plural(c.buildCount, '')} finished${c.shipNamesClause}.`,
  c => `Steady output from ${b(c.faction)}: ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} launched and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} completed${c.shipNamesClause}.`,
  c => `Both the fleet register and the infrastructure ledger moved for ${b(c.faction)} — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}, ${numWord(c.buildCount)} project${plural(c.buildCount, '')}${c.shipNamesClause}.`,
  c => `Engineers and shipwrights alike stayed busy for ${b(c.faction)}, finishing ${numWord(c.buildCount)} project${plural(c.buildCount, '')} and launching ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)}${c.shipNamesClause}.`,
  c => `${b(c.faction)} posted gains on two fronts today — ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned and ${numWord(c.buildCount)} upgrade${plural(c.buildCount, '')} finished${c.shipNamesClause}.`,
  c => `It was all go for ${b(c.faction)}: ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} entered service as ${numWord(c.buildCount)} construction project${plural(c.buildCount, '')} closed out${c.shipNamesClause}.`,
  c => `${b(c.faction)} closed out ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} on the ground and put ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} in the sky${c.shipNamesClause}.`,
  c => `Welders and surveyors both earned their pay under ${b(c.faction)} this period: ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} away from dock, ${numWord(c.buildCount)} ${plural(c.buildCount, 'site', 'sites')} handed over.`,
  c => `Scaffolding came down at ${numWord(c.buildCount)} ${b(c.faction)} ${plural(c.buildCount, 'site', 'sites')} while the yards released ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}${c.shipNamesClause}.`,
  c => `Two sets of books, one good shift: ${b(c.faction)} records ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} complete and ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned.`,
  c => `Under ${b(c.faction)} management, ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} reached completion — and the same window saw ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} accepted into service${c.shipNamesClause}.`,
  c => `Progress reports from ${b(c.faction)} arrive in duplicate: ${numWord(c.buildCount)} finished ${plural(c.buildCount, 'project', 'projects')} from the construction office, ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} from the yards.`,
  c => `The ledger is short and the shift was not: ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} completed for ${b(c.faction)}, ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} added to its register${c.shipNamesClause}.`,
  c => `${b(c.faction)} spent the period building in two directions at once, finishing ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} and commissioning ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}.`,
  c => `Cargo manifests, survey stakes, and a fresh set of hull numbers: ${b(c.faction)} completed ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} and sent out ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}${c.shipNamesClause}.`,
  c => `Somewhere in ${b(c.faction)} territory a foreman is still signing paperwork — ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} finished, ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} released to the fleet.`,
  c => `${b(c.faction)}'s construction office reported ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} finished; its dockmaster reported ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} cleared for space${c.shipNamesClause}.`,
  c => `Dust settled over ${numWord(c.buildCount)} completed ${plural(c.buildCount, 'site', 'sites')} in ${b(c.faction)} space, and ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} left dock while it did.`,
  c => `Add ${numWord(c.buildCount)} finished ${plural(c.buildCount, 'project', 'projects')} to ${b(c.faction)}'s column, then add ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)} beneath it${c.shipNamesClause}.`,
  c => `Keels were laid and foundations poured in the same week under ${b(c.faction)}: ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} complete, ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned.`,
  c => `Finished at last, ${numWord(c.buildCount)} ${b(c.faction)} ${plural(c.buildCount, 'project', 'projects')} came off the works schedule — and ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} came off the slipways${c.shipNamesClause}.`,
  c => `Ledgers out of ${b(c.faction)} show ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} struck from the works list and ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} entered on the fleet roll.`,
  c => `Quietly, and without ceremony, ${b(c.faction)} completed ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} and commissioned ${numWord(c.shipCount)} ${shipsWord(c.shipCount)}${c.shipNamesClause}.`,
  c => `Prefab domes went up at ${numWord(c.buildCount)} ${b(c.faction)} ${plural(c.buildCount, 'site', 'sites')}; ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} went out from its yards.`,
  c => `Whatever ${b(c.faction)} pays its engineers, it appears to be working: ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} finished and ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned${c.shipNamesClause}.`,
  c => `Both halves of ${b(c.faction)}'s industrial base filed returns this period — ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} completed, ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} delivered.`,
  c => `Reports filed from ${b(c.faction)} work sites confirm ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} finished, with ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} commissioned in the same window${c.shipNamesClause}.`,
  c => `The hard part of ${b(c.faction)}'s week was apparently getting the paperwork signed: ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} done, ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} away.`,
  c => `Steel was cut and concrete was poured to equal effect across ${b(c.faction)} holdings, which recorded ${numWord(c.buildCount)} completed ${plural(c.buildCount, 'project', 'projects')} and ${numWord(c.shipCount)} new ${shipsWord(c.shipCount)}${c.shipNamesClause}.`,
  c => `${b(c.faction)} finished ${numWord(c.buildCount)} ${plural(c.buildCount, 'project', 'projects')} and, before the shift ended, sent ${numWord(c.shipCount)} ${shipsWord(c.shipCount)} out past the marker buoys.`,
];

const INDUSTRY_BOTH_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS FLEET AND INFRASTRUCTURE`,
  c => `${c.faction.toUpperCase()} DELIVERS ON ALL FRONTS`,
  c => `NEW SHIPS AND UPGRADES FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} BUILDS UP FLEET AND HOLDINGS`,
  c => `DOUBLE DUTY FOR ${c.faction.toUpperCase()}'S YARDS`,
  c => `${c.faction.toUpperCase()} POSTS GAINS ON TWO FRONTS`,
  c => `FLEET AND INFRASTRUCTURE GROW FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} HAS A PRODUCTIVE DAY`,
  c => `SHIPYARDS AND ENGINEERS DELIVER FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STRENGTHENS FLEET AND HOLDINGS`,
  c => `A BUSY DAY OF INDUSTRY FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} SCORES ON SHIPS AND UPGRADES`,
  c => `STEADY GAINS ACROSS THE BOARD FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} LOGS NEW HULLS AND NEW UPGRADES`,
  c => `TWO FRONTS OF PROGRESS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ROUNDS OUT A FULL DAY OF INDUSTRY`,
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
  c => `${b(c.faction)} christened ${numWord(c.count)} new ${shipsWord(c.count)} today${c.namesClause}.`,
  c => `Dockworkers for ${b(c.faction)} logged ${numWord(c.count)} completed hull${plural(c.count, '')}${c.namesClause}.`,
  c => `${numWord(c.count)} fresh keel${plural(c.count, '')} joined ${b(c.faction)}'s fleet register today${c.namesClause}.`,
  c => `${b(c.faction)}'s production lines turned out ${numWord(c.count)} new ${shipsWord(c.count)}${c.namesClause}.`,
  c => `Another batch off the slipway: ${numWord(c.count)} ${shipsWord(c.count)} for ${b(c.faction)}${c.namesClause}.`,
  c => `${b(c.faction)} took delivery of ${numWord(c.count)} new ${shipsWord(c.count)} today${c.namesClause}.`,
  c => `Steel met space today as ${b(c.faction)} launched ${numWord(c.count)} new ${shipsWord(c.count)}${c.namesClause}.`,
  c => `${b(c.faction)}'s yards logged another ${numWord(c.count)} hull${plural(c.count, '')} complete${c.namesClause}.`,
];

const INDUSTRY_SHIPS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} EXPANDS ITS FLEET`,
  c => `NEW HULLS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} SHIPYARDS DELIVER`,
  c => `FRESH HULLS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} PUTS NEW SHIPS TO SEA`,
  c => `${c.faction.toUpperCase()}'S FLEET GROWS AGAIN`,
  c => `${c.faction.toUpperCase()} CHRISTENS NEW FLEET`,
  c => `MORE HULLS JOIN ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} TAKES DELIVERY OF NEW SHIPS`,
  c => `PRODUCTION LINES DELIVER FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ADDS TO ITS FLEET REGISTER`,
  c => `NEW KEELS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ROLLS OUT MORE SHIPS`,
  c => `SLIPWAYS BUSY FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} COMMISSIONS NEW VESSELS`,
  c => `${c.faction.toUpperCase()} EXPANDS PRODUCTION OUTPUT`,
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
  c => `Engineers for ${b(c.faction)} wrapped up ${numWord(c.count)} project${plural(c.count, '')} today.`,
  c => `Work crews delivered ${numWord(c.count)} completed upgrade${plural(c.count, '')} for ${b(c.faction)}.`,
  c => `${b(c.faction)} checked ${numWord(c.count)} construction project${plural(c.count, '')} off the list today.`,
  c => `Building permits closed out for ${b(c.faction)}: ${numWord(c.count)} project${plural(c.count, '')} finished.`,
  c => `The work sites were busy for ${b(c.faction)} — ${numWord(c.count)} upgrade${plural(c.count, '')} completed.`,
  c => `${b(c.faction)} finished ${numWord(c.count)} upgrade${plural(c.count, '')} without a single new hull to show for it.`,
  c => `Foundations and framework both came together for ${b(c.faction)}, ${numWord(c.count)} project${plural(c.count, '')} in all.`,
  c => `Ground crews for ${b(c.faction)} completed ${numWord(c.count)} project${plural(c.count, '')} today.`,
  c => `${b(c.faction)} reported ${numWord(c.count)} finished construction project${plural(c.count, '')}.`,
  c => `Slow and steady for ${b(c.faction)}: ${numWord(c.count)} upgrade${plural(c.count, '')} completed, no launches to report.`,
  c => `Holdings across ${b(c.faction)}'s territory saw ${numWord(c.count)} completed project${plural(c.count, '')}.`,
  c => `${b(c.faction)} logged ${numWord(c.count)} finished upgrade${plural(c.count, '')} on the construction ledger.`,
];

const INDUSTRY_BUILDINGS_ONLY_HEADLINE = [
  c => `${c.faction.toUpperCase()} UPGRADES INFRASTRUCTURE`,
  c => `CONSTRUCTION MILESTONE FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STRENGTHENS ITS HOLDINGS`,
  c => `STEADY PROGRESS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} FINISHES NEW UPGRADES`,
  c => `WORK CREWS DELIVER FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} CLOSES OUT CONSTRUCTION PROJECTS`,
  c => `NO NEW SHIPS, BUT PROGRESS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} CHECKS PROJECTS OFF THE LIST`,
  c => `GROUND CREWS DELIVER FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} REPORTS FINISHED UPGRADES`,
  c => `INFRASTRUCTURE GAINS FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} WRAPS UP CONSTRUCTION WORK`,
  c => `SLOW AND STEADY FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} LOGS COMPLETED PROJECTS`,
  c => `BUILDING WORK PAYS OFF FOR ${c.faction.toUpperCase()}`,
];

// The below-threshold "everyone else" line — see
// INDUSTRY_COLLAPSE_THRESHOLD. Deliberately low-key phrasing; this is
// the digest's equivalent of small print, not a headline.
const INDUSTRY_COLLAPSED = [
  c => `Elsewhere in the system, smaller yards stayed busy — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} completed across ${numWord(c.factionCount)} ${plural(c.factionCount, 'faction')}, led by ${b(c.leader)}.`,
  c => `Routine industry across the rest of the system: ${numWord(c.totalShips)} new ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} finished project${plural(c.totalBuilds, '')}, with ${b(c.leader)} out front.`,
  c => `Minor shipyards kept humming — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} logged among ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'power')}, ${b(c.leader)} chief among them.`,
  c => `Quiet but steady: ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'faction')} together finished ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')}, ${b(c.leader)} leading the pack.`,
  c => `Small yards, steady work: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} across the rest of the field, ${b(c.leader)} ahead of the pack.`,
  c => `The lesser powers weren't idle either — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} completed project${plural(c.totalBuilds, '')} between them, ${b(c.leader)} in front.`,
  c => `Background noise from the smaller powers: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} project${plural(c.totalBuilds, '')} finished across ${numWord(c.factionCount)} ${plural(c.factionCount, 'faction')}, ${b(c.leader)} setting the pace.`,
  c => `Nothing dramatic among the smaller factions — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} logged, ${b(c.leader)} out ahead.`,
  c => `Filed for the record: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} completed project${plural(c.totalBuilds, '')} among ${numWord(c.factionCount)} lesser ${plural(c.factionCount, 'power')}, led by ${b(c.leader)}.`,
  c => `The rest of the field turned in modest numbers — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)}, ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')}, ${b(c.leader)} on top.`,
  c => `Unremarkable but present: ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'faction')} added ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} project${plural(c.totalBuilds, '')} between them, ${b(c.leader)} in the lead.`,
  c => `Little that moves markets, but ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} came out of the smaller yards, ${b(c.leader)} chief among them.`,
  c => `Down the standings, ${numWord(c.factionCount)} ${plural(c.factionCount, 'faction')} combined for ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} finished project${plural(c.totalBuilds, '')}, ${b(c.leader)} leading.`,
  c => `Modest gains from the minor powers: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')}, ${b(c.leader)} first among them.`,
  c => `In brief: the smaller yards produced ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} finished project${plural(c.totalBuilds, '')}, ${b(c.leader)} out front.`,
  c => `Also on the books, ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'faction')} finished ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} project${plural(c.totalBuilds, '')}, ${b(c.leader)} leading the group.`,
  c => `For the record, the lesser powers logged ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')}, ${b(c.leader)} ahead of the rest.`,
  c => `Business as usual among ${numWord(c.factionCount)} smaller ${plural(c.factionCount, 'faction')} — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)}, ${numWord(c.totalBuilds)} project${plural(c.totalBuilds, '')}, ${b(c.leader)} on top.`,
  c => `Further down the ledger, ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} upgrade${plural(c.totalBuilds, '')} came from the smaller powers, ${b(c.leader)} leading.`,
  c => `A footnote worth noting: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} completed project${plural(c.totalBuilds, '')} among the minor factions, ${b(c.leader)} pacing the group.`,
];

const INDUSTRY_COLLAPSED_HEADLINE = [
  () => `INDUSTRY TICKS ALONG ACROSS THE SYSTEM`,
  () => `A QUIET DAY IN THE YARDS`,
  c => `${c.leader.toUpperCase()} LEADS A ROUTINE DAY OF INDUSTRY`,
  () => `SMALL YARDS, STEADY WORK`,
  () => `SMALLER POWERS STAY BUSY`,
  () => `NOTHING TO SEE HERE, JUST ROUTINE INDUSTRY`,
  c => `${c.leader.toUpperCase()} PACES A QUIET FIELD`,
  () => `BUSINESS AS USUAL IN THE OUTER YARDS`,
  () => `MINOR POWERS, MODEST GAINS`,
  c => `${c.leader.toUpperCase()} LEADS THE ALSO-RANS`,
  () => `THE LEDGER'S FINE PRINT`,
  () => `ANOTHER UNREMARKABLE DAY OF INDUSTRY`,
  c => `${c.leader.toUpperCase()} TOPS A MODEST FIELD`,
  () => `ROUTINE NUMBERS FROM THE SMALLER YARDS`,
  () => `STEADY WORK, NOTHING DRAMATIC`,
  c => `${c.leader.toUpperCase()} OUT FRONT IN A QUIET FIELD`,
];

/** The rest of the field: real powers that simply weren't the top two
 *  producers this edition. Distinct from INDUSTRY_COLLAPSED, which is
 *  about genuinely small yards — calling a faction that launched
 *  thirty ships a "minor power" is just wrong, and the reader can see
 *  the number sitting right there in the sentence. */
const INDUSTRY_FIELD = [
  c => `Behind them, ${b(c.leader)} led the rest of the field — ${numWord(c.totalShips)} more ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} further ${plural(c.totalBuilds, 'project')} across ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')}.`,
  c => `The other ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')} were not idle either: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} between them, ${b(c.leader)} out front.`,
  c => `Elsewhere on the boards, ${b(c.leader)} paced ${numWord(c.factionCount)} other ${plural(c.factionCount, 'power')} to ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} finished ${plural(c.totalBuilds, 'project')}.`,
  c => `Add ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} from the ${plural(c.factionCount, 'one remaining power', numWord(c.factionCount) + ' remaining powers')}, with ${b(c.leader)} contributing most of it.`,
  c => `${b(c.leader)} headed the chasing pack — ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')}, ${numWord(c.totalShips)} ${shipsWord(c.totalShips)}, ${numWord(c.totalBuilds)} completed ${plural(c.totalBuilds, 'project')}.`,
  c => `Further down the register: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} spread across ${numWord(c.factionCount)} more ${plural(c.factionCount, 'power')}, ${b(c.leader)} the busiest of them.`,
  c => `The remaining yards logged ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} — ${b(c.leader)} accounted for the largest share.`,
  c => `Not to be discounted: ${numWord(c.factionCount)} other ${plural(c.factionCount, 'power')} put up ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')}, led by ${b(c.leader)}.`,
  c => `${b(c.leader)} topped the balance of the field, which added ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} to the system's total.`,
  c => `Everyone else combined — ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')} — managed ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')}, ${b(c.leader)} leading.`,
  c => `Beyond the two front-runners, ${b(c.leader)} was busiest: ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')} across ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')}.`,
  c => `A respectable showing from the rest of the board — ${numWord(c.totalShips)} ${shipsWord(c.totalShips)}, ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')}, ${b(c.leader)} in front of ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')}.`,
  c => `The rest of the system contributed ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')}, most of it under ${b(c.leader)}'s flag.`,
  c => `Also on the slate: ${numWord(c.factionCount)} ${plural(c.factionCount, 'power')} turning out ${numWord(c.totalShips)} ${shipsWord(c.totalShips)} and ${numWord(c.totalBuilds)} ${plural(c.totalBuilds, 'project')}, ${b(c.leader)} setting the pace.`,
];

const INDUSTRY_FIELD_HEADLINE = [
  c => `${c.leader.toUpperCase()} LEADS THE CHASING PACK`,
  () => 'THE REST OF THE FIELD KEEPS PACE',
  c => `${c.leader.toUpperCase()} BUSIEST OF THE REST`,
  () => 'BEHIND THE FRONT-RUNNERS, STEADY OUTPUT',
  c => `${c.leader.toUpperCase()} TOPS THE BALANCE OF THE BOARD`,
  () => 'THE OTHER YARDS WERE NOT IDLE',
  c => `${c.leader.toUpperCase()} HEADS THE REMAINING POWERS`,
  () => 'FURTHER DOWN THE REGISTER',
  c => `${c.leader.toUpperCase()} PACES THE ALSO-BUILDING`,
  () => 'OUTPUT SPREAD ACROSS THE FIELD',
  c => `${c.leader.toUpperCase()} OUT FRONT BEYOND THE TOP TWO`,
  () => 'THE BALANCE OF THE BOARD REPORTS IN',
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
  c => `Settlers loyal to ${b(c.faction)} raised ${numWord(c.count)} new colony flag${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} pushed its borders outward, founding ${numWord(c.count)} settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Fresh domes rose under ${b(c.faction)}'s banner — ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} logged ${numWord(c.count)} new colony registration${plural(c.count, '')} today${c.entriesClause}.`,
  c => `Another day, another outpost for ${b(c.faction)} — ${numWord(c.count)} founded${c.entriesClause}.`,
  c => `${b(c.faction)}'s survey teams struck ground for ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Empty coordinates became home today: ${b(c.faction)} founded ${numWord(c.count)} settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `${b(c.faction)} widened its reach with ${numWord(c.count)} new settlement${plural(c.count, '')}${c.entriesClause}.`,
  c => `Registries updated to show ${numWord(c.count)} new settlement${plural(c.count, '')} under ${b(c.faction)}${c.entriesClause}.`,
  c => `${b(c.faction)} isn't slowing down — ${numWord(c.count)} new settlement${plural(c.count, '')} founded${c.entriesClause}.`,
  c => `${b(c.faction)} put ${numWord(c.count)} new ${plural(c.count, 'settlement', 'settlements')} on the charts${c.entriesClause}.`,
  c => `Survey stakes first, prefab domes second: ${b(c.faction)} now counts ${numWord(c.count)} more ${plural(c.count, 'holding', 'holdings')}${c.entriesClause}.`,
  c => `The charts were redrawn again this period, with ${numWord(c.count)} fresh ${plural(c.count, 'settlement', 'settlements')} registered to ${b(c.faction)}${c.entriesClause}.`,
  c => `Landing craft in ${b(c.faction)} livery unloaded prefab housing for ${numWord(c.count)} new ${plural(c.count, 'colony', 'colonies')}${c.entriesClause}.`,
  c => `Somewhere cold and airless, ${numWord(c.count)} ${b(c.faction)} ${plural(c.count, 'settlement', 'settlements')} switched on the lights for the first time${c.entriesClause}.`,
  c => `${b(c.faction)} raised ${numWord(c.count)} new ${plural(c.count, 'settlement', 'settlements')} this period${c.entriesClause}.`,
  c => `Charter documents were filed for ${numWord(c.count)} ${b(c.faction)} ${plural(c.count, 'colony', 'colonies')}${c.entriesClause}.`,
  c => `Not content with the ground it held, ${b(c.faction)} took ${numWord(c.count)} ${plural(c.count, 'parcel', 'parcels')} more${c.entriesClause}.`,
  c => `Survey teams working under ${b(c.faction)} contract handed off ${numWord(c.count)} finished ${plural(c.count, 'site', 'sites')}${c.entriesClause}.`,
  c => `A quiet period at the frontier office, aside from ${numWord(c.count)} new ${plural(c.count, 'charter', 'charters')} granted to ${b(c.faction)}${c.entriesClause}.`,
  c => `${b(c.faction)} now flies its colours over ${numWord(c.count)} more ${plural(c.count, 'site', 'sites')}${c.entriesClause}.`,
  c => `Habitation modules landed and pressurised for ${b(c.faction)}, ${numWord(c.count)} ${plural(c.count, 'settlement', 'settlements')} in all${c.entriesClause}.`,
  c => `Add ${numWord(c.count)} more ${plural(c.count, 'entry', 'entries')} to ${b(c.faction)}'s column of the colonial register${c.entriesClause}.`,
  c => `The rock is cold, the air comes bottled, and ${b(c.faction)} has ${numWord(c.count)} new ${plural(c.count, 'settlement', 'settlements')} regardless${c.entriesClause}.`,
  c => `Officials confirmed ${numWord(c.count)} ${plural(c.count, 'foundation', 'foundations')} laid under the ${b(c.faction)} flag${c.entriesClause}.`,
  c => `Where there was nothing, ${b(c.faction)} now maintains ${numWord(c.count)} ${plural(c.count, 'settlement', 'settlements')}${c.entriesClause}.`,
  c => `${b(c.faction)} spent the period putting colonists ashore, ${numWord(c.count)} ${plural(c.count, 'landing', 'landings')} in total${c.entriesClause}.`,
  c => `Cargo holds emptied into pressure tents: ${numWord(c.count)} new ${b(c.faction)} ${plural(c.count, 'settlement', 'settlements')} are on the books${c.entriesClause}.`,
  c => `First shipments of ore are already promised from ${numWord(c.count)} newly founded ${b(c.faction)} ${plural(c.count, 'colony', 'colonies')}${c.entriesClause}.`,
  c => `Nothing dramatic, only ${numWord(c.count)} more ${plural(c.count, 'settlement', 'settlements')} standing to ${b(c.faction)}'s name${c.entriesClause}.`,
  c => `${b(c.faction)} signed off on ${numWord(c.count)} new ${plural(c.count, 'outpost', 'outposts')}${c.entriesClause}.`,
  c => `Domes, a water plant, a landing strip scraped flat — the usual list, run through ${numWord(c.count)} ${plural(c.count, 'time', 'times')} for ${b(c.faction)}${c.entriesClause}.`,
  c => `The colonial registry closed the period ${numWord(c.count)} ${plural(c.count, 'name', 'names')} longer, all of them ${b(c.faction)}'s${c.entriesClause}.`,
  c => `Settlers went down the ramp under ${b(c.faction)} charter at ${numWord(c.count)} separate ${plural(c.count, 'landing site', 'landing sites')}${c.entriesClause}.`,
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
  c => `${c.faction.toUpperCase()} WIDENS ITS BORDERS`,
  c => `NEW OUTPOSTS RISE FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} LOGS NEW COLONIES`,
  c => `SETTLERS BREAK GROUND FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} REGISTERS NEW TERRITORY`,
  c => `ANOTHER OUTPOST FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} PUSHES INTO NEW GROUND`,
  c => `DOMES RISE UNDER ${c.faction.toUpperCase()}`,
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
  c => `${b(c.faction)} plants its flag at ${c.bodyLoc}, and the system takes notice.`,
  c => `Scouts report a new banner over ${c.bodyLoc}: ${b(c.faction)} has arrived.`,
  c => `${b(c.faction)} breaks ground at ${c.bodyLoc}, its first foothold in the system.`,
  c => `Correspondents confirm a new capital at ${c.bodyLoc}, seat of ${b(c.faction)}.`,
  c => `Another flag rises: ${b(c.faction)} has claimed ${c.bodyLoc} as its own.`,
  c => `${b(c.faction)} announces itself with a capital at ${c.bodyLoc}.`,
  c => `Long empty, ${c.bodyLoc} now answers to ${b(c.faction)}.`,
  c => `Sensors pick up new activity at ${c.bodyLoc} — ${b(c.faction)} has moved in.`,
  c => `${b(c.faction)} takes its place among the powers, capital fixed at ${c.bodyLoc}.`,
  c => `Reports confirm ${b(c.faction)} founded at ${c.bodyLoc} this cycle.`,
  c => `Neighbors wake to a new capital: ${b(c.faction)} at ${c.bodyLoc}.`,
  c => `Fresh to the system, ${b(c.faction)} sets down roots at ${c.bodyLoc}.`,
];

const FACTION_ARRIVAL_HEADLINE = [
  c => `NEW POWER ENTERS THE SYSTEM: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ARRIVES, SETTLES ${c.body.toUpperCase()}`,
  c => `A NEW FLAG FLIES OVER ${c.body.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} STEPS ONTO THE STAGE`,
  c => `WHO IS ${c.faction.toUpperCase()}?`,
  c => `${c.body.toUpperCase()} WELCOMES A NEW FLAG`,
  c => `${c.faction.toUpperCase()} FOUNDS NEW CAPITAL`,
  c => `FRESH ARRIVAL: ${c.faction.toUpperCase()} SETTLES IN`,
  c => `${c.faction.toUpperCase()} STAKES ITS CLAIM`,
  c => `SCOUTS SPOT NEW BANNER OVER ${c.body.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} BREAKS GROUND AT ${c.body.toUpperCase()}`,
  c => `ANOTHER FLAG RISES OVER ${c.body.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} JOINS THE FIELD`,
  c => `CAPITAL CONFIRMED: ${c.faction.toUpperCase()} AT ${c.body.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} SETS DOWN ROOTS AT ${c.body.toUpperCase()}`,
  c => `FIRST SIGHTING: ${c.faction.toUpperCase()} AT ${c.body.toUpperCase()}`,
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
  // Legacy kind — kept so chronicles from pre-terraforming games still
  // render; nothing seeds it anymore.
  free_collector: [
    'revived a derelict freight hub — a free city and collector now widen their logistics network',
    'got an old cargo relay humming again, adding a free city and collector to their holdings',
  ],
  pre_terraformed: [
    'charted a world the ancients already prepped for life — terraformed, empty, and waiting for a flag',
    'found green under the dust: a fully terraformed world, abandoned before anyone alive could name it',
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
  c => `${b(c.a)} and ${b(c.b)} have concluded ${c.pactName}, sealed before witnesses.`,
  c => `The chancelleries confirm it: ${c.pactName} now binds ${b(c.a)} and ${b(c.b)}.`,
  c => `Negotiators close the book on months of talks — ${b(c.a)} and ${b(c.b)} have entered ${c.pactName}.`,
  c => `Ink dries on ${c.pactName} between ${b(c.a)} and ${b(c.b)}.`,
  c => `${b(c.b)} joins ${b(c.a)} in ${c.pactName}, ending a long stretch of silence between the two.`,
  c => `Correspondents confirm ${b(c.a)} and ${b(c.b)} have ratified ${c.pactName}.`,
  c => `Where there was distance, there is now ${c.pactName}: ${b(c.a)} and ${b(c.b)} have signed.`,
  c => `Envoys from ${b(c.a)} and ${b(c.b)} shook hands on ${c.pactName} this morning.`,
  c => `${b(c.a)} formalizes ${c.pactName} with ${b(c.b)}, closing a chapter of uncertainty.`,
  c => `Officials confirm ${c.pactName} between ${b(c.a)} and ${b(c.b)} takes effect immediately.`,
  c => `${b(c.b)} accepts terms: ${c.pactName} with ${b(c.a)} is now binding.`,
  c => `Long in the drafting, ${c.pactName} between ${b(c.a)} and ${b(c.b)} is finally signed.`,
  c => `The chamber was half empty when ${b(c.a)} and ${b(c.b)} concluded ${c.pactName} this morning.`,
  c => `${b(c.a)} and ${b(c.b)} are bound by ${c.pactName} as of today, on terms neither delegation cared to read aloud.`,
  c => `Terms of ${c.pactName} between ${b(c.a)} and ${b(c.b)} were lodged with the registry before noon and made public an hour after that.`,
  c => `There is now ${c.pactName} standing between ${b(c.a)} and ${b(c.b)}, which is more than stood there yesterday.`,
  c => `Two delegations, one long table, ${c.pactName}: ${b(c.a)} and ${b(c.b)} closed the matter without a raised voice.`,
  c => `Older hands will note that ${b(c.a)} and ${b(c.b)} have stood in this hall before; the paper this time is ${c.pactName}.`,
  c => `This paper has watched ${c.pactName} outlast the ink, and watched the reverse. ${b(c.a)} and ${b(c.b)} concluded theirs today.`,
  c => `Whether ${c.pactName} survives contact with the next dispute is a question for ${b(c.a)} and ${b(c.b)}, not for the clerks who filed it.`,
  c => `Under ${c.pactName} concluded today, ${b(c.a)} and ${b(c.b)} take on obligations that both sides describe as modest.`,
  c => `Flags of ${b(c.a)} and ${b(c.b)} hung together over the hall while ${c.pactName} was read into the record.`,
  c => `Observers counted two signatures on ${c.pactName} and not one smile between ${b(c.a)} and ${b(c.b)}.`,
  c => `${b(c.b)} and ${b(c.a)} — the order of names was argued over longer than the text — are now party to ${c.pactName}.`,
  c => `A courier carried ${c.pactName} out of the hall before the delegations of ${b(c.a)} and ${b(c.b)} had left their seats.`,
  c => `Another season, another agreement: ${b(c.a)} and ${b(c.b)} concluded ${c.pactName} today, and the wire will keep the file open.`,
  c => `Ratification of ${c.pactName} was announced from both capitals within the hour, ${b(c.a)} first and ${b(c.b)} a little after.`,
  c => `The wording of ${c.pactName} runs to a few paragraphs; the history between ${b(c.a)} and ${b(c.b)} runs considerably longer.`,
  c => `Nothing in ${c.pactName} obliges ${b(c.a)} or ${b(c.b)} to like one another, and the ceremony reflected as much.`,
  c => `Merchant houses working the lanes between ${b(c.a)} and ${b(c.b)} will price ${c.pactName} into their manifests by the end of the week.`,
  c => `Word of ${c.pactName} reached the outer stations by relay, well ahead of any explanation from ${b(c.a)} or ${b(c.b)}.`,
  c => `${b(c.a)} concluded ${c.pactName} with ${b(c.b)} today. The customary photographs were taken; the customary assurances followed.`,
  c => `Talks widely expected to collapse produced ${c.pactName} instead, and ${b(c.a)} and ${b(c.b)} both look faintly surprised by it.`,
  c => `Ink is cheap and fleets are not: a fair summary of ${c.pactName} concluded this week by ${b(c.a)} and ${b(c.b)}.`,
  c => `For as long as it holds, ${c.pactName} governs relations between ${b(c.a)} and ${b(c.b)}. The clause on notice of withdrawal is very short.`,
  c => `Staff officers on both sides spent the afternoon reading ${c.pactName} for what it does not say, ${b(c.a)} and ${b(c.b)} alike.`,
];

const TREATY_SIGNED_HEADLINE = [
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} SIGN HISTORIC ACCORD`,
  c => `PEACE AT LAST: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} INK DEAL`,
  c => `NEW ALLIANCE: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()} FORMALIZE TIES`,
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} FIND COMMON GROUND`,
  c => `ACCORD REACHED BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} EXTENDS A HAND TO ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} SEALS PACT WITH ${c.b.toUpperCase()}`,
  c => `TERMS SET: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} PUT PEN TO PAPER`,
  c => `TREATY TAKES EFFECT BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} RATIFIES DEAL WITH ${c.b.toUpperCase()}`,
  c => `ENVOYS CLOSE THE DEAL: ${c.a.toUpperCase()}, ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} AND ${c.b.toUpperCase()} END THE STANDOFF`,
  c => `LONG TALKS YIELD PACT FOR ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} WELCOMES ${c.b.toUpperCase()} TO THE TABLE`,
  c => `DEAL DONE: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
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
  c => `${b(c.a)} severs ties with ${b(c.b)}, and the treaty dies with them.`,
  c => `Cold silence now stands where ${b(c.a)} and ${b(c.b)} once had terms.`,
  c => `${b(c.b)} wakes to find ${b(c.a)} has renounced their pact.`,
  c => `No warning, no ceremony — ${b(c.a)} simply stopped honoring its word to ${b(c.b)}.`,
  c => `${b(c.a)} declares the accord with ${b(c.b)} null and void.`,
  c => `Analysts note the accord between ${b(c.a)} and ${b(c.b)} quietly expired into hostility.`,
  c => `${b(c.a)} burns the last bridge to ${b(c.b)}.`,
  c => `Relations sour overnight as ${b(c.a)} abandons its commitments to ${b(c.b)}.`,
  c => `${b(c.b)} is left holding a treaty ${b(c.a)} no longer recognizes.`,
  c => `Officials confirm the pact between ${b(c.a)} and ${b(c.b)} has lapsed by choice, not accident.`,
  c => `${b(c.a)} cuts loose from ${b(c.b)}, citing terms no longer in its interest.`,
  c => `Barely dry, the ink between ${b(c.a)} and ${b(c.b)} is already worthless.`,
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
  c => `${c.a.toUpperCase()} SEVERS TIES WITH ${c.b.toUpperCase()}`,
  c => `PACT DEAD: ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} RENOUNCES DEAL WITH ${c.b.toUpperCase()}`,
  c => `COLD SILENCE BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
  c => `${c.a.toUpperCase()} CUTS LOOSE FROM ${c.b.toUpperCase()}`,
  c => `NO CEREMONY AS ${c.a.toUpperCase()} QUITS THE PACT`,
  c => `${c.a.toUpperCase()} BURNS THE LAST BRIDGE TO ${c.b.toUpperCase()}`,
  c => `RELATIONS SOUR BETWEEN ${c.a.toUpperCase()} AND ${c.b.toUpperCase()}`,
];

const SENATE_PASSED = [
  c => `The Senate has passed "${c.title}" — the ${b(c.actor)} delegation's motion carries.`,
  c => `By vote of the assembly, "${c.title}" is now law.`,
  c => `The chamber rules in favor: "${c.title}" passes.`,
  c => `Lawmakers have given "${c.title}" the green light.`,
  c => `It's official: "${c.title}" clears the Senate floor.`,
  c => `After debate, the chamber sides with "${c.title}".`,
  c => `${b(c.actor)}'s motion carries the day as "${c.title}" becomes law.`,
  c => `Delegates vote to enact "${c.title}", handing ${b(c.actor)} a win.`,
  c => `A majority holds: "${c.title}" is adopted.`,
  c => `Consensus formed quickly around "${c.title}", and it passes.`,
  c => `Members approve "${c.title}" without much drama.`,
  c => `${b(c.actor)} secures passage of "${c.title}" on the floor today.`,
  c => `Votes are tallied and "${c.title}" stands approved.`,
  c => `Passage comes easily for "${c.title}", backed by ${b(c.actor)}.`,
  c => `Few objections met "${c.title}" on its way to passage.`,
  c => `Floor debate ends in favor of "${c.title}".`,
  c => `${b(c.actor)} watches its proposal, "${c.title}", cross the finish line.`,
  c => `Enacted today: "${c.title}", championed by ${b(c.actor)}.`,
  c => `Support held firm and "${c.title}" is now the law of the system.`,
  c => `Records show "${c.title}" passing with room to spare.`,
];

const SENATE_PASSED_HEADLINE = [
  c => `SENATE PASSES "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS APPROVE "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" CLEARS THE SENATE`,
  c => `CHAMBER SIDES WITH "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" BECOMES LAW`,
  c => `MAJORITY BACKS "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" WINS FLOOR VOTE`,
  c => `VOTE CARRIES "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" ADOPTED BY THE CHAMBER`,
  c => `DELEGATES ENACT "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" CLEARS FLOOR VOTE`,
  c => `MEMBERS GREENLIGHT "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" NOW THE LAW`,
  c => `FLOOR APPROVES "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" SAILS THROUGH`,
  c => `CONSENSUS CARRIES "${c.title.toUpperCase()}"`,
];

const SENATE_FAILED = [
  c => `The Senate has rejected "${c.title}", proposed by ${b(c.actor)}.`,
  c => `"${c.title}" fails to carry the chamber.`,
  c => `The assembly votes down "${c.title}".`,
  c => `Lawmakers weren't convinced — "${c.title}" goes down.`,
  c => `The gavel falls against "${c.title}".`,
  c => `"${c.title}" couldn't find the votes it needed.`,
  c => `${b(c.actor)}'s motion collapses as "${c.title}" fails to pass.`,
  c => `Opposition holds firm and "${c.title}" is voted down.`,
  c => `No majority formed for "${c.title}".`,
  c => `Delegates turn back "${c.title}" on the floor today.`,
  c => `A narrow margin sinks "${c.title}".`,
  c => `Support never materialized for "${c.title}", proposed by ${b(c.actor)}.`,
  c => `Floor debate turns against "${c.title}".`,
  c => `Objections pile up and "${c.title}" stalls out.`,
  c => `${b(c.actor)} watches its proposal, "${c.title}", die on the floor.`,
  c => `Tallies confirm "${c.title}" short of the votes needed.`,
  c => `Members turn down "${c.title}" after brief debate.`,
  c => `Rejected outright: "${c.title}", backed by ${b(c.actor)}.`,
  c => `Little enthusiasm greeted "${c.title}", and it shows in the count.`,
  c => `Records show "${c.title}" failing by a wide margin.`,
];

// A bill that dies for want of a quorum did NOT lose a debate, and the
// SENATE_FAILED prose ("lawmakers weren't convinced", "couldn't find the
// votes it needed") would be a straight falsehood about it — the votes
// were never cast at all. Separate bank, separate blame: the story is
// the empty chamber, not the motion.
const SENATE_NO_QUORUM = [
  c => `"${c.title}" died without a quorum — only ${numWord(c.cast)} of the ${numWord(c.required)} delegations required even turned up to vote.`,
  c => `The chamber could not muster a quorum for "${c.title}". ${b(c.actor)}'s motion lapsed unread.`,
  c => `Benches sat empty as "${c.title}" came to a vote. ${numWord(c.cast)} delegations answered; ${numWord(c.required)} were needed.`,
  c => `No quorum, no law: "${c.title}" fell for want of attendance, not argument.`,
  c => `${b(c.actor)} brought "${c.title}" to the floor and found the floor deserted. The motion dies procedurally.`,
  c => `"${c.title}" never reached a tally — the assembly was short of the ${numWord(c.required)} delegations a vote requires.`,
  c => `${b(c.actor)} called a vote on "${c.title}" and drew only ${numWord(c.cast)} delegations — short of the ${numWord(c.required)} required.`,
  c => `Attendance, not opposition, killed "${c.title}" today.`,
  c => `Clerks counted ${numWord(c.cast)} delegations present for "${c.title}" — the chamber needed ${numWord(c.required)}.`,
  c => `Empty seats told the story as "${c.title}" failed to reach a quorum.`,
  c => `Sparse turnout doomed "${c.title}" before a single vote was cast.`,
  c => `${b(c.actor)}'s bill, "${c.title}", never got a hearing; too few showed up.`,
  c => `Quorum call fails: "${c.title}" is shelved, not defeated.`,
  c => `Only ${numWord(c.cast)} delegations bothered to appear for "${c.title}", leaving it short of the ${numWord(c.required)} required.`,
  c => `Absent delegations left "${c.title}" stranded without a vote.`,
  c => `A thin chamber meant "${c.title}" went nowhere today.`,
  c => `Procedure, not politics, ended "${c.title}" — the floor simply wasn't full enough.`,
  c => `Nobody voted against "${c.title}"; nobody showed up to vote for it either.`,
  c => `Headcount fell short for "${c.title}", and the motion lapsed.`,
  c => `Turnout never reached the ${numWord(c.required)} delegations "${c.title}" needed to come to a vote.`,
];

const SENATE_NO_QUORUM_HEADLINE = [
  c => `"${c.title.toUpperCase()}" DIES ON EMPTY BENCHES`,
  c => `NO QUORUM: "${c.title.toUpperCase()}" LAPSES`,
  c => `CHAMBER TOO THIN TO VOTE ON "${c.title.toUpperCase()}"`,
  c => `ABSENTEEISM KILLS "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" STALLS FOR WANT OF A QUORUM`,
  c => `SPARSE TURNOUT SINKS "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" NEVER REACHES A VOTE`,
  c => `EMPTY BENCHES DOOM "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" SHELVED FOR LACK OF ATTENDANCE`,
  c => `TOO FEW SHOW UP FOR "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" LAPSES UNREAD`,
  c => `QUORUM CALL FAILS ON "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" STRANDED WITHOUT A VOTE`,
  c => `THIN CHAMBER SIDELINES "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" GOES UNCOUNTED`,
  c => `HEADCOUNT SHORT FOR "${c.title.toUpperCase()}"`,
];

// The gavel changing hands. Written to carry the DEADLINE, because that
// is the only actionable fact in it — a term is agenda control with an
// expiry, and a reader's question is "how long do I have to lobby them".
const SENATE_CHAIR = [
  c => `${b(c.actor)} has taken the Senate chair for term ${c.termNumber}, holding the floor until tick ${c.termEnd}.`,
  c => `The gavel passes to ${b(c.actor)}. For the next ${numWord(c.termSpan)} ticks, the Senate's agenda is theirs alone to set.`,
  c => `Lots drawn, ${b(c.actor)} presides. Delegations with business before the chamber have until tick ${c.termEnd} to make their case.`,
  c => `${b(c.actor)} assumes the chair. No other delegation may table a bill before tick ${c.termEnd}.`,
  c => `Term ${c.termNumber} opens under ${b(c.actor)}, who holds the sole power to call a vote for ${numWord(c.termSpan)} ticks.`,
  c => `The rotation falls to ${b(c.actor)}, whose ${numWord(c.termSpan)}-tick term ends at ${c.termEnd}. Whatever they decline to put on the floor goes unproposed.`,
  c => `${b(c.actor)} claims the chair, agenda power theirs until tick ${c.termEnd}.`,
  c => `A new term begins: ${b(c.actor)} controls the docket for ${numWord(c.termSpan)} ticks.`,
  c => `Under ${b(c.actor)}'s gavel, no bill reaches the floor unless they allow it — the term runs until tick ${c.termEnd}.`,
  c => `${b(c.actor)} settles into the chair for term ${c.termNumber}, with authority lasting ${numWord(c.termSpan)} ticks.`,
  c => `Chair passes to ${b(c.actor)}; the clock on their authority stops at tick ${c.termEnd}.`,
  c => `Business before the Senate now runs through ${b(c.actor)}, and will until tick ${c.termEnd}.`,
  c => `${b(c.actor)} takes the podium for ${numWord(c.termSpan)} ticks, sole author of what gets a vote.`,
  c => `Delegations hoping to legislate will need ${b(c.actor)}'s blessing until tick ${c.termEnd}.`,
  c => `For the next ${numWord(c.termSpan)} ticks, nothing reaches the Senate floor without ${b(c.actor)}'s say-so.`,
  c => `Power over the agenda shifts to ${b(c.actor)}, effective through tick ${c.termEnd}.`,
  c => `${b(c.actor)} opens term ${c.termNumber} with full control of the docket, good until tick ${c.termEnd}.`,
  c => `Colleagues concede the floor to ${b(c.actor)} for the next ${numWord(c.termSpan)} ticks.`,
  c => `Nothing gets proposed without ${b(c.actor)}'s consent until tick ${c.termEnd}.`,
  c => `Hands change on the gavel: ${b(c.actor)} presides for ${numWord(c.termSpan)} ticks.`,
];

const SENATE_CHAIR_HEADLINE = [
  c => `${c.actor.toUpperCase()} TAKES THE SENATE CHAIR`,
  c => `THE GAVEL PASSES TO ${c.actor.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} TO SET THE AGENDA THIS TERM`,
  c => `TERM ${c.termNumber}: ${c.actor.toUpperCase()} PRESIDES`,
  c => `${c.actor.toUpperCase()} CLAIMS AGENDA CONTROL`,
  c => `NEW SENATE TERM OPENS UNDER ${c.actor.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} HOLDS THE FLOOR`,
  c => `CHAIR CHANGES HANDS: ${c.actor.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} NAMED SENATE CHAIR`,
  c => `POWER SHIFTS TO ${c.actor.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} CONTROLS THE DOCKET`,
  c => `AGENDA POWER: ${c.actor.toUpperCase()} FOR TERM ${c.termNumber}`,
  c => `${c.actor.toUpperCase()} SEIZES THE GAVEL`,
  c => `SOLE AUTHOR OF THE AGENDA: ${c.actor.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} OPENS TERM ${c.termNumber}`,
  c => `DELEGATIONS DEFER TO ${c.actor.toUpperCase()}`,
];

const SENATE_FAILED_HEADLINE = [
  c => `SENATE REJECTS "${c.title.toUpperCase()}"`,
  c => `LAWMAKERS BLOCK "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" GOES DOWN`,
  c => `GAVEL FALLS AGAINST "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" VOTED DOWN`,
  c => `NO MAJORITY FOR "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" FAILS ON THE FLOOR`,
  c => `OPPOSITION SINKS "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" SHORT OF THE VOTES`,
  c => `DELEGATES TURN BACK "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" STALLS OUT`,
  c => `MEMBERS REJECT "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" DIES ON THE FLOOR`,
  c => `NARROW MARGIN SINKS "${c.title.toUpperCase()}"`,
  c => `"${c.title.toUpperCase()}" FALLS SHORT`,
  c => `FLOOR TURNS AGAINST "${c.title.toUpperCase()}"`,
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
  c => `Silence falls across the system — ${b(c.faction)} has no rivals left to fight.`,
  c => `The banners of every other power have fallen. ${b(c.faction)} alone remains flying.`,
  c => `A new age begins under ${b(c.faction)}. The old order is ash.`,
  c => `Peace, of a kind, arrives at last — ${b(c.faction)} has ended the war by winning it.`,
  c => `No treaty was needed. ${b(c.faction)} simply outlasted everyone else.`,
  c => `From a hundred battles, one name emerges: ${b(c.faction)}.`,
  c => `Generations from now, this will be remembered as the day ${b(c.faction)} won everything.`,
  c => `The last resistance has been swept aside. ${b(c.faction)} governs uncontested.`,
  c => `What began as one faction among many ends with ${b(c.faction)} alone at the top.`,
  c => `Tonight the Herald prints its final wartime edition — ${b(c.faction)} has won it all.`,
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
  c => `${c.faction.toUpperCase()} ENDS THE WAR`,
  c => `ONE FLAG REMAINS: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} TAKES THE SYSTEM`,
  c => `SILENCE FALLS AS ${c.faction.toUpperCase()} WINS`,
  c => `${c.faction.toUpperCase()} OUTLASTS ALL RIVALS`,
  c => `A NEW ORDER: ${c.faction.toUpperCase()}`,
];

const ELIMINATION = [
  c => `${b(c.faction)} has fallen. Their banners lie in the dust.`,
  c => `The story of ${b(c.faction)} ends here.`,
  c => `${b(c.faction)} has been eliminated from the system.`,
  c => `${b(c.faction)}'s flag has come down for the last time.`,
  c => `No more ships, no more worlds. ${b(c.faction)} is gone.`,
  c => `The system will not remember ${b(c.faction)} kindly, but it will not remember them long either — they are finished.`,
  c => `Silence follows where ${b(c.faction)} once held ground.`,
  c => `It's over for ${b(c.faction)} — no fleet, no territory, nothing left to defend.`,
  c => `Once a power in this system, ${b(c.faction)} now exists only in the record.`,
  c => `Empires end quietly more often than not; ${b(c.faction)}'s ended today.`,
  c => `Banners that once flew for ${b(c.faction)} have been struck for good.`,
  c => `Every world, every hull, every claim — ${b(c.faction)} has lost them all.`,
  c => `Nothing remains of ${b(c.faction)} but the record of what they held.`,
  c => `Gone: ${b(c.faction)}, and everything they built.`,
  c => `Their last world fell, and with it, ${b(c.faction)} itself.`,
  c => `Ships scattered, worlds seized, and now ${b(c.faction)} is nothing at all.`,
  c => `Worlds change hands; ${b(c.faction)} no longer has any left to lose.`,
  c => `After everything, ${b(c.faction)} leaves the board with nothing.`,
  c => `When the count was taken, ${b(c.faction)} had nothing left to count.`,
  c => `Finished: ${b(c.faction)} holds no ships, no worlds, no future.`,
];

const ELIMINATION_HEADLINE = [
  c => `${c.faction.toUpperCase()} FALLS`,
  c => `THE END FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} ELIMINATED FROM THE SYSTEM`,
  c => `${c.faction.toUpperCase()}'S FLAG COMES DOWN`,
  c => `GONE: ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} WIPED FROM THE MAP`,
  c => `SILENCE WHERE ${c.faction.toUpperCase()} ONCE STOOD`,
  c => `FINISHED: ${c.faction.toUpperCase()} OUT OF THE WAR`,
  c => `NO SHIPS, NO WORLDS, NO ${c.faction.toUpperCase()}`,
  c => `LAST WORLD LOST: ${c.faction.toUpperCase()} DONE`,
  c => `EMPIRE OF ${c.faction.toUpperCase()} COLLAPSES`,
  c => `ERASED FROM THE MAP: ${c.faction.toUpperCase()}`,
  c => `CURTAIN FALLS ON ${c.faction.toUpperCase()}`,
  c => `EXTINGUISHED: ${c.faction.toUpperCase()}`,
  c => `OUT OF THE FIGHT FOR GOOD: ${c.faction.toUpperCase()}`,
  c => `DONE: ${c.faction.toUpperCase()} HOLDS NOTHING`,
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
  c => `Freight offices confirmed ${numWord(c.count)} delivery run${plural(c.count, '')} completed today.`,
  c => `Cargo holds emptied on schedule — ${numWord(c.count)} run${plural(c.count, '')} logged across the lanes.`,
  c => `Shipping lanes stayed clear: ${numWord(c.count)} ${c.count === 1 ? 'delivery' : 'deliveries'} recorded today.`,
  c => `Dockmasters logged ${numWord(c.count)} completed cargo run${plural(c.count, '')} today.`,
  c => `Routine traffic on the trade lanes today — ${numWord(c.count)} ${c.count === 1 ? 'delivery' : 'deliveries'} closed out.`,
  c => `Nothing held up in transit: ${numWord(c.count)} freighter run${plural(c.count, '')} completed without incident.`,
  c => `Commerce moved as expected — ${numWord(c.count)} shipment${plural(c.count, '')} reached port today.`,
  c => `Ports across the system processed ${numWord(c.count)} ${c.count === 1 ? 'delivery' : 'deliveries'} today.`,
  c => `Business as usual on the freight lines: ${numWord(c.count)} run${plural(c.count, '')} completed.`,
  c => `Another day, another ${numWord(c.count)} cargo run${plural(c.count, '')} for the merchant marine.`,
  c => `Tallying the day's freight: ${numWord(c.count)} ${c.count === 1 ? 'delivery' : 'deliveries'} completed system-wide.`,
  c => `Steady traffic through the trade lanes left ${numWord(c.count)} run${plural(c.count, '')} on the books.`,
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
  () => 'QUIET SKIES, EMPTY DESK',
  () => 'THE SYSTEM TAKES A BREATH',
  () => 'NOT MUCH TO SAY TODAY',
  () => 'PEACE BREAKS OUT, BRIEFLY',
  () => 'STILLNESS REIGNS IN THE BLACK',
  () => 'NO SIGNAL, NO STORY',
  () => 'EVERYONE STAYED HOME TODAY',
  () => 'THE WIRE COMES UP EMPTY',
];

const QUIET_DAY_BODY = [
  () => 'No battles, no new colonies, no discoveries to report since the last edition. The presses idle; the void abides.',
  () => 'The system rests today. Every faction holds its position; nothing more to tell.',
  () => 'A rare calm has settled over the system. Even the merchants have little to report.',
  () => 'Correspondents across the system report nothing worth the ink today.',
  () => 'For once, the front page has nowhere to point.',
  () => 'The factions held their positions and their fire alike. Nothing more to add.',
  () => 'No skirmishes, no landings, no headlines. The Herald prints this instead.',
  () => 'Scouts returned with nothing to log. The stars kept their secrets today.',
  () => 'Not a single flare crossed the sensors today.',
  () => 'Even the rumor mill has gone quiet. Take the silence as good news.',
  () => 'Ledgers show no losses and no gains. A wash of a day.',
  () => 'Nothing burned, nothing broke, nothing changed hands. So it goes.',
  () => 'Scanners logged empty space and little else.',
  () => 'Ships came and went and nothing happened worth naming.',
  () => 'Peace, it turns out, does not sell papers, but here it is anyway.',
  () => 'An uneventful cycle closes the books with nothing new to add.',
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
  (n, s) => `…${n} more incident${s} logged before deadline, unprinted.`,
  (n, s) => `…another ${n} incident${s} on file, no room to run them.`,
  (n, s) => `…the desk logged ${n} more incident${s} than space allowed.`,
  (n, s) => `…${n} additional incident${s} sit in the queue for next edition.`,
  (n, s) => `…space ran out before ${n} more incident${s} could make print.`,
  (n, s) => `…the wire carried ${n} more incident${s} than these pages allow.`,
  (n, s) => `…editors trimmed ${n} more incident${s} for lack of column space.`,
  (n, s) => `…${n} more incident${s} remain in the notebook, untold.`,
  (n, s) => `…and ${n} further incident${s}, held over on the grounds that the paper is only so wide.`,
  (n, s) => `…the presses were already turning when ${n} more incident${s} came off the wire.`,
  (n, s) => `…${n} more incident${s} exist. They are not here. The compositor has gone home.`,
  (n, s) => `…our night editor read ${n} more incident${s} aloud, then put them in a drawer.`,
  (n, s) => `…${n} additional incident${s}, filed, spiked, and briefly mourned.`,
  (n, s) => `…there were ${n} more incident${s}; there was not more paper.`,
  (n, s) => `…a correspondent's ${n} remaining incident${s} arrived eleven minutes after we locked the page.`,
  (n, s) => `…blame the typesetter, the ink budget, or the ${n} surplus incident${s} that would not fit.`,
  (n, s) => `…${n} more incident${s} were considered, weighed, and left on the floor.`,
  (n, s) => `…column inches being finite, ${n} incident${s} will keep until tomorrow.`,
  (n, s) => `…we have ${n} more incident${s} and, regrettably, an edition that ends here.`,
  (n, s) => `…a galley proof came back with ${n} incident${s} crossed out in red.`,
  (n, s) => `…somewhere beneath a fold that never existed lie ${n} further incident${s}.`,
  (n, s) => `…subscribers wanting the other ${n} incident${s} are invited to imagine them.`,
  (n, s) => `…${n} incident${s} more, every one of them somebody's bad day, none of them printed.`,
  (n, s) => `…the wire kept chattering long after we closed: ${n} incident${s} unread until morning.`,
  (n, s) => `…we ran the important ones, and the other ${n} incident${s} will have to be important tomorrow.`,
  (n, s) => `…of the ${n} incident${s} still on the spike, this desk expresses no opinion.`,
  (n, s) => `…a further ${n} incident${s} lost the argument with the advertising department.`,
  (n, s) => `…paper costs what it costs; ${n} incident${s} therefore go unset.`,
  (n, s) => `…our copy boy is still holding ${n} incident${s} nobody has time to read.`,
  (n, s) => `…${n} incident${s} were sacrificed so that this sentence could fit.`,
  (n, s) => `…for the ${n} incident${s} we left out, our sincere and entirely theoretical apologies.`,
  (n, s) => `…ink, patience, and page four all ran out at once, taking ${n} incident${s} with them.`,
];

// Shared between buildPoliticsStories (treaty_signed) and
// buildTradeStories (a trade that bundled a pact) so the two don't
// carry independent copies that could drift.
const PACT_NAMES = {
  defense_pact: 'a defense pact',
  nap: 'a non-aggression pact',
  trade_agreement: 'a trade agreement',
};

/** Oxford-joins a pact list. `join(' and ')` produced "a non-aggression
 *  pact and a defense pact and a treaty" — three instruments strung
 *  together with no punctuation, which reads as a parser dumping every
 *  flag it found rather than a sentence anyone wrote. Also dedupes:
 *  the payload can carry the same pact kind twice, and "a treaty and a
 *  treaty" is worse than either. */
function joinPacts(names) {
  const uniq = [...new Set(names)];
  if (uniq.length === 0) return '';
  if (uniq.length === 1) return uniq[0];
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
  return `${uniq.slice(0, -1).join(', ')}, and ${uniq[uniq.length - 1]}`;
}

/** A "trade" of nothing for nothing is not a trade — it's a diplomatic
 *  agreement that happens to travel on the trade rail. Rendering it
 *  through the exchange banks produced lines like "**X** released
 *  nothing, **Y** released nothing — sealed with a defense pact",
 *  which a reader can only parse as a bug. These get their own voice:
 *  the pact IS the story. */
const PACT_ONLY_DEAL = [
  c => `No cargo moved, but ${b(c.proposer)} and ${b(c.responder)} left the table bound by ${c.pactList}.`,
  c => `${b(c.proposer)} and ${b(c.responder)} exchanged no goods today — only signatures, and ${c.pactList} to show for them.`,
  c => `Nothing crossed the docks between ${b(c.proposer)} and ${b(c.responder)}. Everything crossed the negotiating table: ${c.pactList}.`,
  c => `A purely diplomatic sitting: ${b(c.proposer)} and ${b(c.responder)} came away with ${c.pactList} and not a gram of freight.`,
  c => `${b(c.proposer)} and ${b(c.responder)} settled on paper alone — ${c.pactList}, no shipment attached.`,
  c => `The manifest was empty and the protocol folder was not: ${b(c.proposer)} and ${b(c.responder)} now hold ${c.pactList}.`,
  c => `Envoys for ${b(c.proposer)} and ${b(c.responder)} skipped the haggling entirely and went straight to ${c.pactList}.`,
  c => `${b(c.proposer)} asked nothing of ${b(c.responder)}, and ${b(c.responder)} gave nothing back. What they signed instead: ${c.pactList}.`,
  c => `Terms without tonnage: ${b(c.proposer)} and ${b(c.responder)} concluded ${c.pactList}, then adjourned.`,
  c => `A handshake, no hold space: ${c.pactList} now stands between ${b(c.proposer)} and ${b(c.responder)}.`,
  c => `${b(c.proposer)} and ${b(c.responder)} put their names to ${c.pactList}. No resources changed hands, and none were asked for.`,
  c => `The ledgers stayed blank while the diplomats worked: ${b(c.proposer)} and ${b(c.responder)} emerged with ${c.pactList}.`,
  c => `Whatever ${b(c.proposer)} and ${b(c.responder)} wanted from each other, it wasn't freight — they signed ${c.pactList} and left it there.`,
  c => `An agreement of intent rather than inventory: ${b(c.proposer)} and ${b(c.responder)} are now party to ${c.pactList}.`,
  c => `Cargo bays stayed shut. ${b(c.proposer)} and ${b(c.responder)} spent the session on ${c.pactList} instead.`,
  c => `${b(c.proposer)} and ${b(c.responder)} traded nothing but assurances today, formalized as ${c.pactList}.`,
];

const PACT_ONLY_DEAL_HEADLINE = [
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} SIGN, SHIP NOTHING`,
  c => `NO CARGO, ONLY SIGNATURES`,
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} COME TO TERMS`,
  c => `PAPER, NOT FREIGHT, AT THE TABLE`,
  c => `${c.responder.toUpperCase()} JOINS ${c.proposer.toUpperCase()} ON PAPER`,
  c => `DIPLOMATS WORK, DOCKS STAY QUIET`,
  c => `AN AGREEMENT WITHOUT A SHIPMENT`,
  c => `${c.proposer.toUpperCase()} CLOSES A CARGO-FREE DEAL`,
  c => `TERMS WITHOUT TONNAGE`,
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} SETTLE ON PAPER`,
  c => `EMPTY MANIFEST, FULL PROTOCOL FOLDER`,
  c => `SIGNATURES EXCHANGED, NOTHING ELSE`,
];

const TRADE_ACCEPTED = [
  c => `${b(c.proposer)} and ${b(c.responder)} struck a deal — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `A trade cleared between ${b(c.proposer)} and ${b(c.responder)}: ${c.offerText} changed hands for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.proposer)} sent ${c.offerText} to ${b(c.responder)} and got ${c.requestText} in return${c.pactClause}.`,
  c => `The merchants close the books on a new arrangement — ${b(c.proposer)} traded ${c.offerText} to ${b(c.responder)} for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.responder)} accepted terms from ${b(c.proposer)}: ${c.requestText} for ${c.offerText}${c.pactClause}.`,
  c => `A quiet exchange between ${b(c.proposer)} and ${b(c.responder)} — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `Terms were finalized between ${b(c.proposer)} and ${b(c.responder)} — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.responder)} and ${b(c.proposer)} finalized terms: ${c.requestText} for ${c.offerText}${c.pactClause}.`,
  c => `Negotiators for ${b(c.proposer)} and ${b(c.responder)} signed off on an exchange — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `Word from the trade desk: ${b(c.proposer)} handed over ${c.offerText} to ${b(c.responder)} for ${c.requestText}${c.pactClause}.`,
  c => `${b(c.proposer)} parted with ${c.offerText} to secure ${c.requestText} from ${b(c.responder)}${c.pactClause}.`,
  c => `Books balanced for both sides as ${b(c.proposer)} swapped ${c.offerText} for ${c.requestText} with ${b(c.responder)}${c.pactClause}.`,
  c => `Cargo manifests changed hands — ${b(c.proposer)} delivered ${c.offerText} to ${b(c.responder)} in exchange for ${c.requestText}${c.pactClause}.`,
  c => `Officials confirmed the transfer: ${c.offerText} from ${b(c.proposer)} to ${b(c.responder)}, ${c.requestText} coming back${c.pactClause}.`,
  c => `A shipment of ${c.offerText} left ${b(c.proposer)} bound for ${b(c.responder)}, with ${c.requestText} arriving in return${c.pactClause}.`,
  c => `Talks between ${b(c.proposer)} and ${b(c.responder)} closed with an exchange — ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `The exchange was brief but final: ${b(c.proposer)} gave up ${c.offerText}, ${b(c.responder)} handed over ${c.requestText}${c.pactClause}.`,
  c => `Traders logged another deal — ${b(c.proposer)} handed over ${c.offerText}, ${b(c.responder)} sent back ${c.requestText}${c.pactClause}.`,
  c => `Ledgers updated after ${b(c.proposer)} and ${b(c.responder)} settled on ${c.offerText} for ${c.requestText}${c.pactClause}.`,
  c => `Both sides signed off: ${b(c.proposer)} released ${c.offerText}, ${b(c.responder)} released ${c.requestText}${c.pactClause}.`,
];

const TRADE_ACCEPTED_HEADLINE = [
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} STRIKE A DEAL`,
  c => `NEW TRADE BETWEEN ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
  c => `${c.proposer.toUpperCase()} CUTS A DEAL WITH ${c.responder.toUpperCase()}`,
  c => `MERCHANTS SEAL EXCHANGE: ${c.proposer.toUpperCase()} / ${c.responder.toUpperCase()}`,
  c => `${c.proposer.toUpperCase()} REACHES TERMS WITH ${c.responder.toUpperCase()}`,
  c => `TRADE DESK CONFIRMS ${c.proposer.toUpperCase()}-${c.responder.toUpperCase()} DEAL`,
  c => `${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()} CLOSE THE BOOKS`,
  c => `EXCHANGE FINALIZED: ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
  c => `${c.proposer.toUpperCase()} SIGNS OFF ON ${c.responder.toUpperCase()} EXCHANGE`,
  c => `TERMS SET BETWEEN ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
  c => `${c.proposer.toUpperCase()} TRADES WITH ${c.responder.toUpperCase()}`,
  c => `DEAL DONE: ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
  c => `${c.responder.toUpperCase()} STRIKES TERMS WITH ${c.proposer.toUpperCase()}`,
  c => `NEGOTIATORS CLOSE ${c.proposer.toUpperCase()}-${c.responder.toUpperCase()} DEAL`,
  c => `${c.proposer.toUpperCase()} SEALS EXCHANGE WITH ${c.responder.toUpperCase()}`,
  c => `LEDGERS SETTLE FOR ${c.proposer.toUpperCase()} AND ${c.responder.toUpperCase()}`,
];

const BUILDS_DESTROYED = [
  c => `${b(c.actor)}'s shipyard at ${c.bodyLoc} went up along with everything on the slipways — ${c.countText} lost mid-build.`,
  c => `Construction never finished at ${c.bodyLoc}: ${b(c.actor)}'s yard was hit, taking ${c.countText} down with it.`,
  c => `${c.countText} died on the slipways at ${c.bodyLoc} when ${b(c.actor)}'s shipyard was destroyed before the hulls could launch.`,
  c => `${b(c.actor)} loses more than a building at ${c.bodyLoc} — the yard's destruction took ${c.countText} still under construction.`,
  c => `The gantries at ${c.bodyLoc} came down in fire, and with them ${c.countText} ${b(c.actor)} had under construction.`,
  c => `Nothing survived the strike on ${c.bodyLoc}'s yard — ${b(c.actor)} loses ${c.countText}, none of them finished.`,
  c => `Half-built and unlucky: ${c.countText} at ${c.bodyLoc} went down with ${b(c.actor)}'s shipyard.`,
  c => `Slipways at ${c.bodyLoc} are cinders now — ${b(c.actor)} loses ${c.countText}, none of them seaworthy.`,
  c => `Fire swept the yard at ${c.bodyLoc}, and ${b(c.actor)} counts ${c.countText} among the wreckage.`,
  c => `No hulls will launch from ${c.bodyLoc} this edition — ${b(c.actor)}'s yard, and the ${c.countText} on it, are gone.`,
  c => `Investors at ${b(c.actor)} watch ${c.countText} vanish at ${c.bodyLoc}, along with the shipyard that housed them.`,
  c => `Caught mid-build, ${c.countText} went down when the strike hit ${b(c.actor)}'s yard at ${c.bodyLoc}.`,
  c => `Wreckage is all that's left of the yard at ${c.bodyLoc}: ${b(c.actor)} loses ${c.countText}, unfinished and unarmed.`,
  c => `Dark now, the shipyard at ${c.bodyLoc} took ${c.countText} down with it — ${b(c.actor)} had nothing ready to launch.`,
  c => `Smoke still hangs over ${c.bodyLoc} where ${b(c.actor)}'s yard once stood — ${c.countText} were lost with it.`,
  c => `Unfinished and unmourned, ${c.countText} went down when ${b(c.actor)}'s shipyard at ${c.bodyLoc} took a direct hit.`,
  c => `Plans on paper, hulls in ash — ${b(c.actor)} loses ${c.countText} when the yard at ${c.bodyLoc} came under fire.`,
  c => `Keels laid and never finished: ${c.countText} went down with ${b(c.actor)}'s shipyard at ${c.bodyLoc}.`,
  c => `Total loss at ${c.bodyLoc} — ${b(c.actor)}'s shipyard is gone, and ${c.countText} with it.`,
  c => `Before the welds could cool, ${c.bodyLoc} took a direct hit and ${b(c.actor)} lost ${c.countText} on the slipways.`,
];

const BUILDS_DESTROYED_HEADLINE = [
  c => `${c.body.toUpperCase()} YARD DESTROYED MID-BUILD`,
  c => `${c.actor.toUpperCase()} LOSES SHIPYARD AND SLIPWAYS AT ${c.body.toUpperCase()}`,
  c => `UNFINISHED HULLS LOST IN ${c.body.toUpperCase()} STRIKE`,
  c => `FLAMES CLAIM ${c.actor.toUpperCase()}'S SHIPYARD`,
  c => `SLIPWAYS CLEARED BY FIRE AT ${c.body.toUpperCase()}`,
  c => `${c.countText.toUpperCase()} LOST IN ${c.body.toUpperCase()} STRIKE`,
  () => 'NO HULLS TO SHOW FOR IT',
  c => `REDUCED TO WRECKAGE AT ${c.body.toUpperCase()}`,
  c => `FIRE GUTS ${c.actor.toUpperCase()}'S SHIPYARD`,
  c => `KEELS LOST BEFORE LAUNCH AT ${c.body.toUpperCase()}`,
  () => 'CONSTRUCTION HALTED BY FIRE',
  c => `SHIPYARD ERASED FROM THE MAP AT ${c.body.toUpperCase()}`,
  c => `TOTAL LOSS AT ${c.body.toUpperCase()}`,
  () => 'HULLS NEVER CLEAR THE SLIPWAYS',
  c => `STRIKE AT ${c.body.toUpperCase()} ENDS SHIPBUILDING PROGRAM`,
  c => `WRECKAGE WHERE THE YARD STOOD AT ${c.body.toUpperCase()}`,
];

const SHIP_RETREATED = [
  c => `${b(c.actor)}'s ${c.shipName} broke off from ${c.fromLoc}${c.hpText}, falling back to ${c.toLoc} for repairs.`,
  c => `Battered but afloat: ${b(c.actor)}'s ${c.shipName} disengaged at ${c.fromLoc}${c.hpText} and is running for ${c.toLoc}.`,
  c => `${c.shipName} pulled out of the fight at ${c.fromLoc}${c.hpText} — ${b(c.actor)} is routing it to ${c.toLoc}.`,
  c => `${b(c.actor)} pulled ${c.shipName} back from ${c.fromLoc}${c.hpText} rather than lose it. Bound for ${c.toLoc}.`,
  c => `Contact broke at ${c.fromLoc}${c.hpText} — ${c.shipName} is limping toward ${c.toLoc}.`,
  c => `Damage control crews aboard ${c.shipName} bought her a way out of ${c.fromLoc}${c.hpText}; she's now bound for ${c.toLoc}.`,
  c => `Discretion won out at ${c.fromLoc}: ${b(c.actor)} withdrew ${c.shipName}${c.hpText} rather than press the engagement, sending her to ${c.toLoc}.`,
  c => `Withdrawal, not defeat: ${c.shipName} slips clear of ${c.fromLoc}${c.hpText}, ${b(c.actor)} routing her to ${c.toLoc}.`,
  c => `Not a loss, just a retreat: ${b(c.actor)}'s ${c.shipName} disengaged at ${c.fromLoc}${c.hpText} and is headed for ${c.toLoc}.`,
  c => `Tactical withdrawal logged at ${c.fromLoc} this edition — ${b(c.actor)}'s ${c.shipName}${c.hpText} is en route to ${c.toLoc}.`,
  c => `Under her own power still, ${c.shipName} left ${c.fromLoc}${c.hpText} and set course for ${c.toLoc}.`,
  c => `Living to fight another day, ${c.shipName} pulls clear of ${c.fromLoc}${c.hpText} and steams for ${c.toLoc}.`,
  c => `Rather than risk the hull, ${b(c.actor)} ordered ${c.shipName} clear of ${c.fromLoc}${c.hpText}; she's making for ${c.toLoc}.`,
  c => `Repair crews at ${c.toLoc} are standing by for ${c.shipName}, pulled out of ${c.fromLoc}${c.hpText} by ${b(c.actor)}.`,
  c => `A cautious call from ${b(c.actor)}: ${c.shipName} disengages at ${c.fromLoc}${c.hpText} and turns for ${c.toLoc}.`,
  c => `Scorched but salvageable, ${c.shipName} withdrew from ${c.fromLoc}${c.hpText}, ${b(c.actor)} sending her toward ${c.toLoc} for repairs.`,
  c => `Strategic withdrawal, says ${b(c.actor)} — ${c.shipName} breaks off from ${c.fromLoc}${c.hpText}, bound for ${c.toLoc}.`,
  c => `Still under thrust, ${c.shipName} pulls back from ${c.fromLoc}${c.hpText} with ${c.toLoc} as her next port of call.`,
  c => `No hero's stand for ${c.shipName} — ${b(c.actor)} orders her clear of ${c.fromLoc}${c.hpText} and toward ${c.toLoc}.`,
  c => `Cutting her losses, ${b(c.actor)} pulls ${c.shipName} from ${c.fromLoc}${c.hpText} and points her toward ${c.toLoc}.`,
];

const SHIP_RETREATED_HEADLINE = [
  c => `${c.actor.toUpperCase()} PULLS BACK FROM ${c.fromBody.toUpperCase()}`,
  c => `${c.shipName.toUpperCase()} DISENGAGES AT ${c.fromBody.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SHIP LIMPS TOWARD ${c.toBody.toUpperCase()}`,
  c => `OUT OF THE FIGHT: ${c.shipName.toUpperCase()} BREAKS OFF AT ${c.fromBody.toUpperCase()}`,
  c => `DAMAGED ${c.shipName.toUpperCase()} HEADS FOR ${c.toBody.toUpperCase()}`,
  () => 'TACTICAL WITHDRAWAL, NOT A LOSS',
  c => `WITHDRAWAL LOGGED AT ${c.fromBody.toUpperCase()}`,
  c => `BOUND FOR ${c.toBody.toUpperCase()}: ${c.shipName.toUpperCase()} PULLS OUT`,
  () => 'NOT A CASUALTY, JUST A RETREAT',
  c => `RUNNING FOR REPAIRS AT ${c.toBody.toUpperCase()}`,
  c => `FIGHT ENDS EARLY FOR ${c.actor.toUpperCase()} AT ${c.fromBody.toUpperCase()}`,
  () => 'DISCRETION WINS OUT THIS ROUND',
  c => `STEAMING FOR ${c.toBody.toUpperCase()}`,
  c => `ORDERED CLEAR OF ${c.fromBody.toUpperCase()}`,
  c => `REPAIRS AWAIT ${c.shipName.toUpperCase()} AT ${c.toBody.toUpperCase()}`,
  () => 'A CAUTIOUS CALL, NOT A ROUT',
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
      // Pin the "…and N more" tail to the real loss count, not to how
      // many of the dead we happen to have names for — "six wrecks …
      // including Ricochet, Lynx, plus 2 not named here" adds to four.
      const names = nameList([...bucket.shipNames], 2, used, bucket.count, NAME_LIST_PLAIN_TAIL);
      const ctx = {
        loser: owner, winner, body: locBody.name, bodyLoc: locBody.full, count: bucket.count,
        namesClause: names ? pickTemplate('battle_names', BATTLE_NAMES_CLAUSE, used)(names) : '',
      };

      // TWO OR MORE credited killers, one victim: a gang-up, not a
      // mystery. This used to fail `killerSet.size === 1`, fall through
      // to `winner = null`, and print the ATTACKER-UNKNOWN bank — the
      // paper announced "the attacker's identity remains a mystery"
      // while holding both attackers' names. It is also the single most
      // common endgame shape, so it is worth its own voice.
      if (killerSet.size > 1) {
        const attackerNames = [...killerSet];
        const gangCtx = {
          ...ctx,
          victim: owner,
          victimCount: bucket.count,
          attackerCount: attackerNames.length,
          attackers: attackerNames.map(b).join(attackerNames.length === 2 ? ' and ' : ', ')
            .replace(/, ([^,]+)$/, ', and $1'),
          // The victim is the ONLY faction losing hulls here, so they
          // landed nothing — say so, because "and took none of them with
          // it" is the difference between a battle and a killing.
          tollClause: ', and not one of them was taken down in return',
        };
        let gangExtra = settlementLossClause(bucket.settlementNames, bucket.settlementPop, used);
        stories.push(mkStory(
          BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * bucket.count,
          used, 'battle_gang_up', BATTLE_GANG_UP,
          'battle_gang_up_hl', BATTLE_GANG_UP_HEADLINE, gangCtx, gangExtra,
        ));
        continue;
      }
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
        const namesA = nameList(bucketA.shipNames, 2, used, countA);
        const namesB = nameList(bucketB.shipNames, 2, used, countB);
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
      // 3+ factions, or an asymmetric shape.
      const sides = victims
        .map(v => ({ faction: v, count: cluster.losses.get(v).count }))
        .sort((a, c) => c.count - a.count);
      const sideList = sides.map(s => `${b(s.faction)} lost ${numWord(s.count)}`).join('; ');
      const total = sides.reduce((s, x) => s + x.count, 0);
      const weight = BATTLE_BASE_WEIGHT + BATTLE_PER_CASUALTY * total;

      // PARTICIPANTS, not victims. `sides` only lists factions that LOST
      // hulls, so a power that won cleanly was invisible: a three-way
      // where two sides bled printed "two factions went in", and the
      // headline bank rendered the oxymoron "TWO-SIDED BATTLE ROYALE".
      // Anyone credited with a kill was there, whether or not it cost
      // them anything.
      const partySet = new Set([...victims, ...killerSet]);
      const partyCount = partySet.size;
      // Winners are otherwise unnamed in the casualty list — say who
      // walked away clean, because that IS the outcome of the battle.
      const unscathed = [...killerSet].filter(k => !cluster.losses.has(k));
      const cleanClause = unscathed.length
        ? pickTemplate('unscathed_clause', UNSCATHED_CLAUSE, used)(unscathed.map(b).join(' and '), unscathed.length)
        : '';

      const worst = sides[0];
      const othersCount = total - worst.count;
      const ctx = {
        body: locBody.name, bodyLoc: locBody.full,
        sides, sideList, partyCount,
        worst: worst.faction, worstCount: worst.count, othersCount,
      };

      // Ratio logic, which this branch never had: one faction absorbing
      // the overwhelming majority of a multi-sided fight is a rout, not
      // "total confusion". Same threshold the 2-faction branch uses.
      const lopsided = othersCount === 0
        || worst.count / Math.max(1, othersCount) >= BATTLE_DECISIVE_RATIO;
      stories.push(lopsided
        ? mkStory(weight, used, 'battle_melee_rout', BATTLE_MELEE_ROUT, 'battle_melee_rout_hl', BATTLE_MELEE_ROUT_HEADLINE, ctx, cleanClause)
        : mkStory(weight, used, 'battle_chaos', BATTLE_CHAOS, 'battle_chaos_hl', BATTLE_CHAOS_HEADLINE, ctx, cleanClause));
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
  const majors = [];
  for (const [faction, bucket] of byFaction) {
    const shipCount = bucket.ships.length;
    const buildCount = bucket.builds.length;
    const total = shipCount + buildCount;
    if (total === 0) continue;
    if (total < INDUSTRY_COLLAPSE_THRESHOLD) {
      collapsed.push({ faction, shipCount, buildCount, total });
      continue;
    }
    majors.push({ faction, bucket, shipCount, buildCount, total });
  }

  // Threshold alone wasn't enough. In a busy window EVERY surviving
  // power clears it, so the column became one "N ships and M upgrades"
  // line per faction — four paragraphs of the same sentence with the
  // nouns swapped, every edition, which a reader of ten editions
  // correctly called wallpaper. A real paper leads with the biggest
  // producers and sweeps the rest into a roundup, so: at most two
  // full paragraphs, everyone else summarized.
  majors.sort((a, c) => c.total - a.total);
  const leads = majors.slice(0, INDUSTRY_MAX_PARAGRAPHS);
  const restOfField = majors.slice(INDUSTRY_MAX_PARAGRAPHS);

  for (const m of leads) {
    const { faction, bucket, shipCount, buildCount, total } = m;
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

  // Real powers that simply weren't the top two — summarized, but NOT
  // through INDUSTRY_COLLAPSED, whose prose ("minor factions",
  // "smaller yards") would be a straight falsehood about a power that
  // just launched thirty ships.
  if (restOfField.length > 0) {
    const totalShips = restOfField.reduce((s, f) => s + f.shipCount, 0);
    const totalBuilds = restOfField.reduce((s, f) => s + f.buildCount, 0);
    const ctx = {
      totalShips, totalBuilds,
      leader: restOfField[0].faction,
      factionCount: restOfField.length,
    };
    stories.push(mkStory(35, used, 'industry_field', INDUSTRY_FIELD, 'industry_field_hl', INDUSTRY_FIELD_HEADLINE, ctx));
  }

  // "Filed for the record: zero ships and one completed project among
  // one lesser power" is not a sentence worth the column inch. Below a
  // floor the roundup says nothing the reader wanted, so say nothing.
  const collapsedTotal = collapsed.reduce((s, f) => s + f.total, 0);
  if (collapsed.length > 0 && collapsedTotal >= 3) {
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
      // The list here is of BODIES, but the count in the sentence is of
      // SETTLEMENTS, and several can share a world — so a numeric tail
      // ("five new settlements at Oberon, Umbriel, and 2 more") invites
      // the reader to add four and find five. Dedupe the worlds and use
      // a tail that counts nothing.
      const worlds = [...new Set(entries.map(e => e.body).filter(Boolean))];
      const shown = worlds.slice(0, 2).map(n => `*${n}*`);
      if (shown.length === 0) {
        entriesClause = '';
      } else if (worlds.length <= 2) {
        entriesClause = ` at ${shown.join(' and ')}`;
      } else {
        const tail = pickTemplate('world_list_tail', WORLD_LIST_VAGUE_TAIL, used)();
        entriesClause = ` at ${shown.join(', ')}${tail}`;
      }
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

  // One agreement, one story.
  //
  // A three-part accord is chronicled as three treaty_signed rows, and
  // the Senate column duly printed three near-identical sentences about
  // the same handshake — then the trade column printed a fourth naming
  // all three pacts, and the shipping column printed the cargo twice
  // more. A reviewer reading ten editions called the section "a
  // stutter", and the diagnosis was exact: the paper was reporting the
  // database's row count instead of the world's event.
  //
  // Group by unordered faction pair, then tell it once with the pacts
  // joined. Same for a rupture, which had the same shape in reverse.
  const pairKey = (x, y) => [x, y].sort().join(' ');
  const signed = new Map();   // pair -> { a, b, pacts: [] }
  const broken = new Map();   // pair -> { a, b }
  for (const row of rows) {
    const p = safeJson(row.payload);
    const key = pairKey(row.actor_faction_id ?? '', row.target_faction_id ?? '');
    if (row.kind === 'treaty_signed') {
      let g = signed.get(key);
      if (!g) { g = { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id), pacts: [] }; signed.set(key, g); }
      g.pacts.push(PACT_NAMES[p.kind] ?? 'a treaty');
    } else if (row.kind === 'treaty_broken') {
      if (!broken.has(key)) broken.set(key, { a: nameOf(row.actor_faction_id), b: nameOf(row.target_faction_id) });
    }
  }
  for (const g of signed.values()) {
    // A pair that signed AND tore up terms in the same window is a
    // rupture story, not a signing one — don't report both.
    const ctx = { a: g.a, b: g.b, pactName: joinPacts(g.pacts) || 'a treaty' };
    stories.push(mkStory(150 + 10 * g.pacts.length, used, 'treaty_signed', TREATY_SIGNED, 'treaty_signed_hl', TREATY_SIGNED_HEADLINE, ctx));
  }
  for (const g of broken.values()) {
    stories.push(mkStory(350, used, 'treaty_broken', TREATY_BROKEN, 'treaty_broken_hl', TREATY_BROKEN_HEADLINE, g));
  }

  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'treaty_signed' || row.kind === 'treaty_broken') {
      continue;   // handled above, grouped
    } else if (row.kind === 'senate_vote') {
      // Title-cased for display only — player-typed titles otherwise sit
      // lowercase/shouty next to properly-cased faction/body names.
      const ctx = {
        title: titleCase(p.title ?? 'a motion'),
        actor: nameOf(row.actor_faction_id),
        cast: Number(p.quorum_cast ?? 0),
        required: Number(p.quorum_required ?? 0),
      };
      if (p.outcome === 'passed') {
        stories.push(mkStory(120, used, 'senate_passed', SENATE_PASSED, 'senate_passed_hl', SENATE_PASSED_HEADLINE, ctx));
      } else if (p.failed_quorum) {
        // Ranked ABOVE an ordinary defeat. A chamber that cannot fill
        // its own benches is a bigger story than a motion losing a
        // vote, and it is the one piece of news that might actually
        // change reader behaviour — the fix is to show up.
        stories.push(mkStory(200, used, 'senate_no_quorum', SENATE_NO_QUORUM, 'senate_no_quorum_hl', SENATE_NO_QUORUM_HEADLINE, ctx));
      } else {
        stories.push(mkStory(120, used, 'senate_failed', SENATE_FAILED, 'senate_failed_hl', SENATE_FAILED_HEADLINE, ctx));
      }
    } else if (row.kind === 'senate_term') {
      const start = Number(p.start_tick ?? 0);
      const end = Number(p.end_tick ?? 0);
      const ctx = {
        // nameOf() substitutes 'an unnamed faction' rather than returning
        // null, so a ?? chain behind it would never fire. Check the
        // faction map directly and fall back to the name the chronicle
        // captured at seating time.
        actor: factionNames.get(row.actor_faction_id) ?? p.faction_name ?? 'a delegation',
        termNumber: Number(p.term_index ?? 0) + 1,
        termEnd: end,
        termSpan: Math.max(0, end - start),
      };
      // Below a resolved bill: who holds the gavel matters less than
      // what the chamber actually did with it.
      stories.push(mkStory(100, used, 'senate_chair', SENATE_CHAIR, 'senate_chair_hl', SENATE_CHAIR_HEADLINE, ctx));
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
    const pactNames = [...new Set(pacts.map(k => PACT_NAMES[k] ?? 'a treaty'))];
    const pactList = joinPacts(pactNames);
    const offerText = fmtBundle(p.offer);
    const requestText = fmtBundle(p.request);
    const ctx = {
      proposer: nameOf(row.actor_faction_id),
      responder: nameOf(row.target_faction_id),
      offerText,
      requestText,
      pactList,
      pactClause: pactList ? ` — sealed with ${pactList}` : '',
    };

    // Nothing offered AND nothing requested: the pact is the entire
    // event, so tell it as one. (Nothing on BOTH sides with no pact
    // either is a null event — nothing happened, don't print it.)
    if (offerText === 'nothing' && requestText === 'nothing') {
      if (pactNames.length === 0) continue;
      stories.push(mkStory(135, used, 'pact_only_deal', PACT_ONLY_DEAL, 'pact_only_deal_hl', PACT_ONLY_DEAL_HEADLINE, ctx));
      continue;
    }

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
      // The chronicle's `detail` is a bare record line ("X elected
      // Supreme Chancellor by senate vote"), and printing it alone as
      // the whole story read to a cold reader as a truncated string.
      // It is a fine SUPPORTING fact, so frame it as one and let the
      // Herald's own voice carry the announcement.
      const detail = (typeof p.detail === 'string' ? p.detail.trim().replace(/\.+$/, '') : '');
      const lead = pickTemplate('victory', VICTORY, used)(ctx);
      const text = detail
        ? `${lead} ${pickTemplate('victory_detail', VICTORY_DETAIL_CLAUSE, used)(detail)}`
        : lead;
      const headline = pickTemplate('victory_hl', VICTORY_HEADLINE, used)(ctx);
      // A match ends exactly once. Whatever else happened in the same
      // window — and the last window of a real game is the bloodiest —
      // it is not a bigger story than the war ending. The old weight of
      // 1000 lost the headline to an ordinary endgame melee in a real
      // edition, so the paper closed a ten-issue war without telling
      // the reader who won.
      stories.push({ text, headline, weight: 1_000_000 });
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
  (c) => `Sol has a new skeleton. **${c.faction}** sank the first foundation struts of a **Dyson Sphere** into orbit today, a project so large that finishing it may no longer require winning a single battle.`,
  (c) => `Word from the inner system: **${c.faction}** has committed to a **Dyson Sphere.** Analysts note the obvious — nothing built that close to the sun can be built quietly, and nothing that valuable stays unmolested for long.`,
  (c) => `Groundbreaking at Sol. **${c.faction}**'s foundation station now orbits the star it intends to cage, the opening move in a project measured in years, not campaigns.`,
  (c) => `History does not usually announce itself, but **${c.faction}** managed it anyway — a foundation platform locked into solar orbit, the first bolt in what could be the war's final structure.`,
  (c) => `The system's oldest dream has a builder. **${c.faction}** has staked its foundation at Sol, and every fleet with a grudge now has a single coordinate to remember.`,
  (c) => `No faction attempts a **Dyson Sphere** by accident. **${c.faction}**'s foundation went up at Sol this cycle, a declaration that outlasts any single fleet lost defending it.`,
  (c) => `Engineers at Sol report the first stable foundation ring in the star's history, courtesy of **${c.faction}**. What comes next will take longer than most alliances survive.`,
  (c) => `A target has been drawn on the sun. **${c.faction}** broke ground on a **Dyson Sphere** at Sol, and every admiral in range is now recalculating fuel ranges.`,
  (c) => `Foundation confirmed: **${c.faction}** has begun the long climb toward a completed **Dyson Sphere.** The lattice is unarmed, unfinished, and already the most contested real estate in the system.`,
  (c) => `The math of the thing is brutal — a **Dyson Sphere** takes forever to build and a single afternoon to burn. **${c.faction}** started anyway, foundation locked in at Sol.`,
  (c) => `Sol's light now falls on scaffolding. **${c.faction}** has begun what it hopes ends the war outright: a **Dyson Sphere**, foundation laid, clock started.`,
  (c) => `Every war has a project too big to ignore. **${c.faction}** just started one, driving the first foundation piles of a **Dyson Sphere** into solar orbit.`,
  (c) => `The foundation is small. The ambition is not. **${c.faction}** has begun a **Dyson Sphere** at Sol, and the whole system now has a reason to watch the sun.`,
  (c) => `Construction crews report the foundation stable and the danger obvious — **${c.faction}** has staked its claim on Sol itself, first strut of a **Dyson Sphere** in place.`,
  (c) => `A single foundation platform now orbits the star. It belongs to **${c.faction}**, and it is the opening line of a **Dyson Sphere** the rest of the system will spend years arguing over.`,
  (c) => `Sol has not seen traffic like this before. **${c.faction}**'s haulers are already inbound with the first loads for a **Dyson Sphere** whose foundation went in today.`,
  (c) => `The race for the sun has a leader. **${c.faction}** laid its foundation at Sol first, and being first is the only advantage a **Dyson Sphere** ever really offers.`,
  (c) => `Long before it can win the war, a **Dyson Sphere** must simply survive. **${c.faction}**'s foundation went up at Sol today — the survival part starts now.`,
];
const DYSON_INITIATED_HEADLINE = [
  () => 'GROUND BROKEN AT SOL',
  (c) => `${c.faction.toUpperCase()} REACHES FOR THE SUN`,
  () => 'A CAGE FOR THE STAR',
  (c) => `${c.faction.toUpperCase()} LAYS THE FIRST STRUT`,
  () => 'THE LONGEST PROJECT BEGINS',
  (c) => `SOL CLAIMED BY ${c.faction.toUpperCase()}`,
  () => 'FOUNDATION AT THE STAR',
  (c) => `${c.faction.toUpperCase()} BREAKS GROUND ON A SUN`,
  () => 'THE SPHERE BEGINS',
  (c) => `${c.faction.toUpperCase()}'S GAMBLE AT SOL`,
  () => 'SCAFFOLDING AROUND A STAR',
  (c) => `FIRST BOLT, ${c.faction.toUpperCase()}`,
  () => 'A TARGET DRAWN ON THE SUN',
  (c) => `${c.faction.toUpperCase()} BETS ON THE LONG GAME`,
  () => 'THE CLOCK STARTS AT SOL',
  (c) => `${c.faction.toUpperCase()} STAKES THE STAR`,
];
const DYSON_MILESTONE = [
  (c) => `The **Dyson Sphere** stands at **${c.pct}%** — **${c.faction}**'s engineers report the lattice holding. The countdown the whole system pretends not to hear grows louder.`,
  (c) => `**${c.faction}**'s sun-cage reached **${c.pct}%** completion this edition. Diplomats are polite about it. Admirals are not.`,
  (c) => `Another ring closed. **${c.faction}**'s **Dyson Sphere** now sits at **${c.pct}%**, and the arithmetic of finishing it grows harder to ignore with every point.`,
  (c) => `Sol's light dims by a fraction more. **${c.faction}** has pushed the sphere to **${c.pct}%**, and rival war rooms are reportedly recalculating their timelines.`,
  (c) => `The lattice grows. **${c.faction}** now claims **${c.pct}%** of a completed **Dyson Sphere**, a number that means less to the public than it does to every fleet commander in range.`,
  (c) => `Progress report from the sun: **${c.pct}%.** **${c.faction}**'s crews keep hauling, and the system keeps counting the days until someone decides waiting is no longer an option.`,
  (c) => `**${c.faction}** crossed **${c.pct}%** on its **Dyson Sphere** this cycle, close enough now that rivals are debating whether interception is still cheaper than surrender.`,
  (c) => `No fireworks accompanied the number, only the number itself: **${c.pct}%** of a **Dyson Sphere**, credited to **${c.faction}**, climbing.`,
  (c) => `The sun-cage tightens. **${c.faction}** reports **${c.pct}%** completion, and every faction with a fleet to spare is quietly asking whether that fleet has better uses.`,
  (c) => `Construction logs out of Sol put **${c.faction}** at **${c.pct}%.** The megaproject remains unfinished, unarmed at the edges, and increasingly hard to bomb into irrelevance.`,
  (c) => `Halfway thoughts arrive early in a project this size. **${c.faction}**'s lattice sits at **${c.pct}%**, and the system is already arguing about what happens if it finishes.`,
  (c) => `Engineers confirm **${c.pct}%** on **${c.faction}**'s **Dyson Sphere.** The remaining work grows smaller. The remaining danger does not.`,
  (c) => `Word from the foundation station: **${c.pct}%.** **${c.faction}** continues its long climb toward a finished star, one shipment at a time.`,
  (c) => `The number on every situation board this cycle is **${c.pct}%** — **${c.faction}**'s share of a caged sun, growing whether the rest of the system likes it or not.`,
  (c) => `**${c.faction}** edges the **Dyson Sphere** to **${c.pct}%.** Somewhere, a rival admiral is doing the same math everyone else is doing, and not liking the answer.`,
  (c) => `Sol's captors report steady work. **${c.faction}** now holds **${c.pct}%** of the sphere, and the gap between ambition and completion keeps closing.`,
  (c) => `Fresh figures from the lattice: **${c.pct}%**, all of it **${c.faction}**'s. The project that was supposed to take forever no longer feels quite so far off.`,
  (c) => `**${c.faction}**'s engineers log another milestone — **${c.pct}%** — on a structure that grows more decisive, and more vulnerable, with each passing point.`,
  (c) => `The star burns behind an ever-thicker cage. **${c.faction}** now sits at **${c.pct}%**, and the system's patience is not keeping pace with the construction schedule.`,
  (c) => `Every percentage point is a headline now. This cycle's: **${c.pct}%**, credited to **${c.faction}**, and watched by every fleet with a reason to care.`,
];
const DYSON_MILESTONE_HEADLINE = [
  (c) => `SPHERE AT ${c.pct}%`,
  (c) => `${c.pct}% OF A SUN, CLAIMED`,
  (c) => `${c.faction.toUpperCase()} PASSES ${c.pct}%`,
  () => 'THE LATTICE TIGHTENS',
  (c) => `${c.pct}% AND CLIMBING`,
  () => 'COUNTDOWN AT THE STAR',
  (c) => `${c.faction.toUpperCase()}'S CAGE, ${c.pct}% CLOSED`,
  () => 'THE SUN, MOSTLY CAGED',
  (c) => `${c.pct}% COMPLETE, SYSTEM WATCHES`,
  () => 'ANOTHER RING SEALED',
  (c) => `${c.faction.toUpperCase()} EDGES CLOSER`,
  () => 'THE MATH GETS HARDER',
  (c) => `${c.pct}%: THE NUMBER EVERYONE KNOWS`,
  () => 'PATIENCE THINS AT SOL',
  (c) => `${c.faction.toUpperCase()} LOGS ${c.pct}%`,
  () => 'A STAR, HALF-CAUGHT',
];
const DYSON_DAMAGED = [
  (c) => `The **Dyson Sphere** took fire at Sol — **${c.damage}** units of construction burned off the lattice under bombardment. **${c.faction}**'s great work stands at **${c.pct}%** and bleeding.`,
  (c) => `Battle at the sun: raiders hammered **${c.faction}**'s Dyson foundation, erasing **${c.damage}** of accumulated work. The sphere holds at **${c.pct}%** — for now.`,
  (c) => `Fire found the lattice. **${c.damage}** units of **${c.faction}**'s **Dyson Sphere** burned off in a single engagement, leaving the structure at **${c.pct}%** and every crew aboard reassigned to repairs.`,
  (c) => `Smoke over Sol. Attackers stripped **${c.damage}** units from **${c.faction}**'s sun-cage before withdrawing, dropping the sphere to **${c.pct}%** and rattling every hauler still inbound.`,
  (c) => `**${c.faction}**'s **Dyson Sphere** absorbed a direct strike this cycle — **${c.damage}** units of work gone, the lattice now standing at **${c.pct}%**, scorched but intact.`,
  (c) => `The sun-cage bled today. Raiders burned **${c.damage}** units off **${c.faction}**'s foundation, and the structure limps forward at **${c.pct}%.**`,
  (c) => `Sol reports casualties in construction, not just crew. **${c.faction}** lost **${c.damage}** units of the sphere to bombardment, now sitting at **${c.pct}%.**`,
  (c) => `An assault at the foundation station cost **${c.faction}** dearly — **${c.damage}** units erased from the **Dyson Sphere**, which now stands at **${c.pct}%** under repair crews' watch.`,
  (c) => `Not enough to collapse it, but enough to hurt: **${c.damage}** units torn from **${c.faction}**'s sphere in the latest raid, the total now **${c.pct}%.**`,
  (c) => `The lattice groaned but held. **${c.faction}** confirms **${c.damage}** units lost to enemy fire at Sol, leaving the **Dyson Sphere** at **${c.pct}%.**`,
  (c) => `Hostile fire reached the foundation ring this cycle, stripping **${c.damage}** units from **${c.faction}**'s **Dyson Sphere** and leaving it at **${c.pct}%**, exposed and unrepaired.`,
  (c) => `Every faction watching the sun took note: **${c.faction}**'s sphere absorbed **${c.damage}** units of damage, now standing at **${c.pct}%**, a reminder that nothing built at Sol is safe from it.`,
  (c) => `Reports from the foundation confirm the worst rumor first — **${c.faction}** was hit. **${c.damage}** units of the **Dyson Sphere** are gone, the lattice now reading **${c.pct}%.**`,
  (c) => `A raiding fleet slipped past the picket line and found the lattice exposed. **${c.damage}** units of **${c.faction}**'s work burned, the sphere now at **${c.pct}%.**`,
  (c) => `The sphere survives, barely richer for the experience. **${c.faction}** logs **${c.damage}** units lost to bombardment, the structure now standing at **${c.pct}%.**`,
  (c) => `Sol's newest scar belongs to **${c.faction}** — **${c.damage}** units of construction stripped away, the **Dyson Sphere** left at **${c.pct}%** and defended more heavily than ever.`,
  (c) => `Hulls burned bright against the star as attackers tore **${c.damage}** units off **${c.faction}**'s foundation, dropping the sphere to **${c.pct}%.**`,
  (c) => `The foundation held, the schedule did not. **${c.faction}** absorbed **${c.damage}** units of losses at Sol, the **Dyson Sphere** now at **${c.pct}%** and behind where it started the week.`,
  (c) => `Enemy fire reached the lattice this cycle. **${c.faction}** reports **${c.damage}** units erased and the sphere standing at **${c.pct}%**, a wound the whole system can see.`,
  (c) => `The star burned through the smoke of its own defense. **${c.faction}** lost **${c.damage}** units of the **Dyson Sphere** to the raid, the total now **${c.pct}%.**`,
];
const DYSON_DAMAGED_HEADLINE = [
  () => 'THE SPHERE BLEEDS',
  () => 'FIRE AT THE FOUNDATION',
  () => 'SMOKE OVER SOL',
  (c) => `${c.faction.toUpperCase()} TAKES A HIT`,
  () => 'THE LATTICE SCORCHED',
  (c) => `${c.faction.toUpperCase()}'S CAGE, DAMAGED`,
  () => 'A WOUND AT THE STAR',
  (c) => `SPHERE DOWN TO ${c.pct}%`,
  () => 'RAIDERS REACH THE LATTICE',
  () => 'THE FOUNDATION UNDER FIRE',
  (c) => `${c.faction.toUpperCase()} DEFENDS A BURNING STAR`,
  () => 'THE CAGE CRACKS, NOT BREAKS',
  () => 'CONSTRUCTION, INTERRUPTED',
  (c) => `${c.pct}% AND SCARRED`,
  () => 'SOL UNDER SIEGE',
  () => 'THE SPHERE HOLDS, BARELY',
];
// King of the hill: a knocked-off builder leaves the lattice BEHIND.
// The collapse story now has two shapes — annihilation (progress ground
// to zero) and abandonment (the shell survives, claimable by anyone).
const DYSON_COLLAPSED = [
  (c) => c.kept > 0
    ? `The king is off the hill: **${c.faction}** lost the sun-cage ${c.reason === 'foundation destroyed' ? 'when its foundation was destroyed' : 'under sustained attack'}, and a masterless lattice does not keep well — **${c.abandon}%** of the surviving construction sheared away in the days after. **${c.kept}** units still hang there at **${c.pct}%**, and every fleet in the system knows the number.`
    : `It fell. **${c.faction}**'s sun-cage collapsed ${c.reason === 'foundation destroyed' ? 'when its foundation was destroyed' : 'under sustained attack'} — **${c.lost}** units of the grandest project in history, erased in a single stroke. The Sol slot stands open for whoever dares next.`,
  (c) => c.kept > 0
    ? `**${c.faction}** has been thrown off the **Dyson Sphere.** ${c.reason === 'foundation destroyed' ? 'Their foundation station was blown out of Sol orbit' : 'Bombardment broke their hold'}, and with no hand on the helm **${c.abandon}%** of the remaining work tore loose — scaffolding adrift, crews gone. What is left hangs at **${c.pct}%**, unclaimed. The first faction to lay a new foundation at Sol inherits all of it.`
    : `The **Dyson Sphere is gone.** ${c.reason === 'foundation destroyed' ? 'Its foundation station was blown out of Sol orbit' : 'Sustained bombardment finally broke the lattice'}, and with it **${c.faction}**'s bid to end the war by engineering. Every unit of progress — **${c.lost}** in all — is dust in the solar wind.`,
  (c) => c.kept > 0
    ? `Sol has a ghost ship now. **${c.faction}** lost control of its **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'when the foundation station went dark' : 'under a bombardment it could not answer'}, and **${c.abandon}%** of the unmanned lattice tore free before crews could stabilize it. **${c.kept}** units remain, sitting at **${c.pct}%**, waiting for a new flag.`
    : `Nothing remains. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'went dark the moment its foundation was destroyed' : 'came apart under bombardment it never withstood'}, taking **${c.lost}** units of work with it. The sun burns unclaimed again.`,
  (c) => c.kept > 0
    ? `**${c.faction}**'s hold on the sun broke ${c.reason === 'foundation destroyed' ? 'the instant its foundation was destroyed' : 'under weeks of grinding attack'}. The lattice did not wait for a new owner — **${c.abandon}%** sheared off within days, leaving **${c.kept}** units adrift at **${c.pct}%.** The derelict is real, and it is up for grabs.`
    : `The greatest structure in the system is a memory. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was wiped out when its foundation was destroyed' : 'was ground down by relentless bombardment'}, and **${c.lost}** units of labor vanished with it.`,
  (c) => c.kept > 0
    ? `A derelict now orbits the star. **${c.faction}** lost the **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'to a strike on its foundation station' : 'to attackers it could not repel'}, and **${c.abandon}%** of the unguarded lattice fell away before anyone could hold it together. **${c.kept}** units remain at **${c.pct}%**, and Sol has never been more contested.`
    : `The sun is bare again. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'ended when its foundation was destroyed' : 'ended under sustained enemy fire'}, and **${c.lost}** units of construction — years of hauling, by any measure — are simply gone.`,
  (c) => c.kept > 0
    ? `**${c.faction}** no longer holds the sphere. ${c.reason === 'foundation destroyed' ? 'Its foundation station was destroyed outright' : 'It was bombed off the project entirely'}, and in the leaderless days that followed, **${c.abandon}%** of the structure broke loose. **${c.kept}** units drift there still, at **${c.pct}%**, an open prize at Sol.`
    : `Every hauler run, every escort, every unit of construction — gone. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was erased when its foundation was destroyed' : 'was erased by sustained bombardment'}, **${c.lost}** units lost in total.`,
  (c) => c.kept > 0
    ? `The foundation fell silent. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'watched its foundation station die outright' : 'could not hold the line against sustained attack'}, and the sphere it built has become common property in waiting — **${c.abandon}%** torn loose, **${c.kept}** units surviving at **${c.pct}%.**`
    : `Sol's would-be cage is scrap and light now. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'saw its foundation destroyed outright' : 'saw its lattice ground apart under bombardment'}, and **${c.lost}** units of the war's most ambitious project are unrecoverable.`,
  (c) => c.kept > 0
    ? `Command has gone dark on the sun-cage. **${c.faction}**'s claim ended ${c.reason === 'foundation destroyed' ? 'when the foundation station was destroyed' : 'under an attack it never repelled'}, and **${c.abandon}%** of the abandoned structure has since crumbled away. **${c.kept}** units remain at **${c.pct}%** — a derelict, not a ruin.`
    : `There is a hole where a sun-cage used to be. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was finished off when its foundation was destroyed' : 'was finished off by sustained bombardment'}, **${c.lost}** units erased in the process.`,
  (c) => c.kept > 0
    ? `**${c.faction}** built for years and lost it in a day. ${c.reason === 'foundation destroyed' ? 'The foundation station was destroyed' : 'The position was overrun'}, and **${c.abandon}%** of what remained fell apart soon after. **${c.kept}** units of derelict lattice now sit at **${c.pct}%**, waiting on whoever moves first.`
    : `Silence at Sol where there used to be construction traffic. **${c.faction}**'s sphere ${c.reason === 'foundation destroyed' ? 'was wiped clean when its foundation was destroyed' : 'was wiped clean by an unanswered bombardment'}, **${c.lost}** units gone for good.`,
  (c) => c.kept > 0
    ? `The lattice outlived its builder, if only barely. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'lost the foundation station to a direct strike' : 'was driven off the project by force'}, and **${c.abandon}%** of the leftover structure has since sheared away, leaving **${c.kept}** units at **${c.pct}%** for the taking.`
    : `A star's worth of ambition, undone in one report. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was destroyed along with its foundation' : 'was destroyed by sustained enemy fire'}, **${c.lost}** units lost with no trace.`,
  (c) => c.kept > 0
    ? `Sol's newest fixture is a wreck with a price on it. **${c.faction}** lost its grip ${c.reason === 'foundation destroyed' ? 'the moment the foundation station fell' : 'under an assault it could not survive'}, and **${c.abandon}%** of the orphaned lattice broke away in the aftermath. **${c.kept}** units remain, parked at **${c.pct}%.**`
    : `No derelict, no salvage, no second chance — just absence. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'ceased to exist when its foundation was destroyed' : 'ceased to exist under sustained bombardment'}, **${c.lost}** units erased entirely.`,
  (c) => c.kept > 0
    ? `What **${c.faction}** built, it could not keep. ${c.reason === 'foundation destroyed' ? 'The foundation station was blown apart' : 'The site was overwhelmed by force'}, and **${c.abandon}%** of the leaderless structure has since come loose. **${c.kept}** units hang at **${c.pct}%**, unclaimed and unguarded.`
    : `The sun burns clean of scaffolding once more. **${c.faction}**'s hold ${c.reason === 'foundation destroyed' ? 'ended the moment its foundation was destroyed' : 'ended under bombardment it could not weather'}, **${c.lost}** units gone with it.`,
  (c) => c.kept > 0
    ? `Analysts are already calling it the shortest reign at Sol on record. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'lost its foundation station to enemy action' : 'lost the position to enemy action'}, and **${c.abandon}%** of the abandoned lattice tore free soon after. **${c.kept}** units remain at **${c.pct}%**, a prize now, not a project.`
    : `Every gram of that lattice is gone. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was obliterated with its foundation' : 'was obliterated under bombardment'}, **${c.lost}** units lost in the collapse.`,
  (c) => c.kept > 0
    ? `The flag came down at the sun. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'saw its foundation station destroyed' : 'was driven off by force'}, and in the vacuum that followed, **${c.abandon}%** of the structure broke apart. **${c.kept}** units sit at **${c.pct}%**, unowned.`
    : `Where a **Dyson Sphere** stood, there is now only wreckage and rumor. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'lost everything when its foundation was destroyed' : 'lost everything under relentless bombardment'}, **${c.lost}** units gone.`,
  (c) => c.kept > 0
    ? `Ambition outran defense. **${c.faction}** ${c.reason === 'foundation destroyed' ? 'watched its foundation station go dark for good' : 'was pushed off the project entirely'}, and **${c.abandon}%** of the leftover lattice has since drifted apart. **${c.kept}** units remain at **${c.pct}%**, waiting on a new claimant.`
    : `The books close on **${c.faction}**'s bid for the sun. Its **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'died with its foundation station' : 'died under sustained bombardment'}, **${c.lost}** units of history erased.`,
  (c) => c.kept > 0
    ? `Not gone, only leaderless. **${c.faction}**'s **Dyson Sphere** slipped its owner ${c.reason === 'foundation destroyed' ? 'when the foundation station was destroyed' : 'under an attack that finally broke through'}, and **${c.abandon}%** of the drifting structure has since fallen away. **${c.kept}** units sit at **${c.pct}%.**`
    : `Total loss confirmed at Sol. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was annihilated along with its foundation' : 'was annihilated by sustained bombardment'} — **${c.lost}** units, gone without residue.`,
  (c) => c.kept > 0
    ? `Loss reports out of Sol confirm **${c.faction}**'s fall from the project ${c.reason === 'foundation destroyed' ? 'after its foundation station was destroyed' : 'after sustained attack broke its hold'}. **${c.abandon}%** of the surviving lattice sheared free soon after, leaving **${c.kept}** units at **${c.pct}%** for whoever claims it next.`
    : `The star's captors are gone, and so is their cage. **${c.faction}**'s **Dyson Sphere** ${c.reason === 'foundation destroyed' ? 'was destroyed with its foundation' : 'was ground to nothing by bombardment'}, **${c.lost}** units unrecoverable.`,
];
const DYSON_COLLAPSED_HEADLINE = [
  (c) => c.kept > 0 ? 'THE SPHERE STANDS MASTERLESS' : 'THE SPHERE HAS FALLEN',
  (c) => c.kept > 0 ? 'KING OFF THE HILL' : 'A SUN UNCAGED',
  (c) => c.kept > 0 ? 'A DERELICT AT SOL' : 'NOTHING LEFT OF THE LATTICE',
  (c) => c.kept > 0 ? `${c.faction.toUpperCase()} LOSES THE HILL` : `${c.faction.toUpperCase()}'S SPHERE, ERASED`,
  (c) => c.kept > 0 ? 'THE CAGE, ORPHANED' : 'THE CAGE, DESTROYED',
  (c) => c.kept > 0 ? 'UNCLAIMED AND DRIFTING' : 'TOTAL LOSS AT THE STAR',
  (c) => c.kept > 0 ? `SPHERE ADRIFT AT ${c.pct}%` : `${c.lost} UNITS, GONE`,
  (c) => c.kept > 0 ? 'THE THRONE AT SOL, EMPTY' : 'THE PROJECT, ANNIHILATED',
  (c) => c.kept > 0 ? 'A PRIZE, NOT A PROJECT' : 'ASHES OVER SOL',
  (c) => c.kept > 0 ? 'THE LATTICE OUTLIVES ITS BUILDER' : 'THE SUN, BARE AGAIN',
  (c) => c.kept > 0 ? 'SOL SLOT OPEN, SHELL INTACT' : 'THE WORK, UNDONE',
  (c) => c.kept > 0 ? 'NO HAND ON THE HELM' : 'YEARS OF HAULING, VANISHED',
  (c) => c.kept > 0 ? `${c.faction.toUpperCase()} THROWN OFF THE PROJECT` : `${c.faction.toUpperCase()}'S BID, ENDED`,
  (c) => c.kept > 0 ? 'THE SHELL SURVIVES' : 'THE SHELL DOES NOT SURVIVE',
  (c) => c.kept > 0 ? 'SOL WAITS ON A NEW FLAG' : 'SOL WAITS ON A NEW BUILDER',
  (c) => c.kept > 0 ? 'THE HILL, UP FOR GRABS' : 'THE PROJECT, ERASED WHOLE',
];

const DYSON_CLAIMED = [
  (c) => `**${c.faction}** has seized the abandoned **Dyson Sphere** — a new foundation at Sol, and **${c.pct}%** of someone else's life's work now counts toward THEIR victory. Construction resumes where it stopped.`,
  (c) => `The sun-cage has a new keeper: **${c.faction}** claimed the derelict sphere at **${c.pct}%** complete. Everything the last builder hauled up the gravity well now belongs to the new flag.`,
  (c) => `Inheritance, not invention: **${c.faction}** has planted a fresh foundation on the derelict shell at Sol, adopting **${c.pct}%** of a project it never began.`,
  (c) => `A new flag flies over the ruins of someone else's ambition. **${c.faction}** claimed the abandoned **Dyson Sphere**, picking up construction at **${c.pct}%** without laying a single early strut.`,
  (c) => `Sol changes hands again. **${c.faction}** moved fast enough to claim the derelict lattice before any rival could, folding **${c.pct}%** of inherited progress into its own war effort.`,
  (c) => `The vultures got there first this time. **${c.faction}** has taken the unguarded **Dyson Sphere**, absorbing **${c.pct}%** of construction that cost another faction dearly to build.`,
  (c) => `What one faction lost, another now owns. **${c.faction}** claimed the derelict shell at Sol, inheriting **${c.pct}%** of work it did not spend a single hauler building.`,
  (c) => `Foundation re-laid, ownership transferred. **${c.faction}** has taken control of the abandoned sphere at **${c.pct}%**, and the countdown the system feared is running again — for a new leader.`,
  (c) => `A masterless lattice does not stay masterless long. **${c.faction}** claimed the derelict **Dyson Sphere** at **${c.pct}%**, and the race resumes as if nothing was ever lost.`,
  (c) => `The gravity well has a new landlord. **${c.faction}** seized the abandoned foundation at Sol, taking ownership of **${c.pct}%** completion built entirely by someone else's hands.`,
  (c) => `Salvage rights at Sol went to **${c.faction}** this cycle — the derelict **Dyson Sphere**, standing at **${c.pct}%**, is theirs now, along with every risk that comes with it.`,
  (c) => `**${c.faction}** did not build the sphere. **${c.faction}** simply arrived first. The derelict at **${c.pct}%** now belongs to the new flag planted at its foundation.`,
  (c) => `Ownership at Sol is a matter of who shows up. **${c.faction}** claimed the drifting **Dyson Sphere** at **${c.pct}%**, and construction crews report back to work under a new banner.`,
  (c) => `The derelict did not wait long for a claimant. **${c.faction}** seized it at **${c.pct}%** complete, and the sphere's fate is once again tied to a single faction's fortunes.`,
  (c) => `Sol's most valuable wreck has an owner again. **${c.faction}** claimed the abandoned lattice, inheriting **${c.pct}%** of a project some other faction bled to build.`,
  (c) => `The system watched to see who would move first. **${c.faction}** did, planting a foundation over the derelict shell and claiming **${c.pct}%** of work already done.`,
  (c) => `A quiet transfer of the loudest kind: **${c.faction}** now holds the **Dyson Sphere** at **${c.pct}%**, inherited whole from a builder that no longer exists.`,
  (c) => `Whoever hesitates at Sol loses the derelict to someone who does not. **${c.faction}** claimed it this cycle, absorbing **${c.pct}%** of orphaned construction.`,
  (c) => `The shell found its new master. **${c.faction}** claimed the abandoned **Dyson Sphere** at **${c.pct}%**, and the project's second chapter begins under unfamiliar management.`,
  (c) => `Nothing about the derelict changed except its ownership. **${c.faction}** now controls the sphere at **${c.pct}%**, every prior hauler run counted as its own.`,
];
const DYSON_CLAIMED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} TAKES THE HILL`,
  () => 'A DERELICT SUN-CAGE, CLAIMED',
  (c) => `${c.faction.toUpperCase()} INHERITS THE SPHERE`,
  () => 'NEW FLAG OVER OLD RUINS',
  (c) => `SOL CHANGES HANDS: ${c.faction.toUpperCase()}`,
  () => 'THE VULTURES WIN THIS ROUND',
  (c) => `${c.faction.toUpperCase()} SEIZES THE SHELL`,
  () => 'SALVAGE RIGHTS AWARDED',
  (c) => `${c.pct}% INHERITED BY ${c.faction.toUpperCase()}`,
  () => 'THE MASTERLESS LATTICE, MASTERED',
  (c) => `${c.faction.toUpperCase()} MOVES FASTEST`,
  () => 'A NEW LANDLORD AT THE STAR',
  (c) => `${c.faction.toUpperCase()} PLANTS A FLAG ON THE WRECK`,
  () => 'THE RACE RESUMES',
  (c) => `${c.faction.toUpperCase()} TAKES WHAT WAS LEFT`,
  () => 'OWNERSHIP, TRANSFERRED AT SOL',
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
      const ctx = {
        faction,
        reason: p.reason ?? '',
        lost: p.progress_lost ?? 0,
        kept: p.progress_kept ?? 0,
        // Older entries predate the abandonment toll; 20 is what the
        // rule was when it shipped, so back-issues still read sensibly.
        abandon: p.abandon_pct ?? 20,
        pct: p.pct ?? 0,
      };
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
  // A wide edition can span several milestones for the same sphere.
  // Printing each one turns a single fact into a contradiction — one
  // real edition reported "25%" and then "50%" in the same column with
  // nothing to reconcile them, leaving the reader unable to say how
  // far along the thing actually was. Only the LATEST crossing is news;
  // the earlier ones are already implied by it.
  const latestMilestone = new Map();   // faction -> { pct, row }
  for (const row of rows) {
    if (row.kind !== 'dyson_milestone') continue;
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    const pct = Number(p.pct) || 0;
    const prev = latestMilestone.get(faction);
    if (!prev || pct >= prev.pct) latestMilestone.set(faction, { pct, row });
  }
  const keptMilestoneRows = new Set([...latestMilestone.values()].map(v => v.row));

  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'dyson_initiated') {
      stories.push(mkStory(500, used, 'dyson_initiated', DYSON_INITIATED, 'dyson_initiated_hl', DYSON_INITIATED_HEADLINE, { faction }));
    } else if (row.kind === 'dyson_claimed') {
      // Seizing a half-built wonder outranks breaking ground on one.
      stories.push(mkStory(600, used, 'dyson_claimed', DYSON_CLAIMED, 'dyson_claimed_hl', DYSON_CLAIMED_HEADLINE, { faction, pct: p.pct ?? 0 }));
    } else if (row.kind === 'dyson_milestone') {
      if (!keptMilestoneRows.has(row)) continue;
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
  (c) => `**${c.faction}** paid double to rush the ${c.cls} **${c.name}** out of the yards at ${c.bodyLoc} — and got what rushing buys: she'll launch at half hull, welds still smoking.`,
  (c) => `Corners were cut at ${c.bodyLoc}: **${c.faction}**'s rushed ${c.cls} **${c.name}** will leave the slips at half integrity. The yard foreman was unavailable for comment.`,
  (c) => `Rivets skipped, deadlines kept: **${c.faction}**'s ${c.cls} **${c.name}** rolls out of ${c.bodyLoc} at half hull, and nobody's apologizing for it.`,
  (c) => `Overtime pay bought speed, not quality — the ${c.cls} **${c.name}** departs ${c.bodyLoc} under **${c.faction}** colors with her hull barely half-finished.`,
  (c) => `Nobody at ${c.bodyLoc} wanted to sign off on the ${c.cls} **${c.name}**, but **${c.faction}** rushed her out anyway, half hull and all.`,
  (c) => `Half a hull is still a hull, **${c.faction}** insists, as the rushed ${c.cls} **${c.name}** clears ${c.bodyLoc} weeks ahead of schedule and years short of ready.`,
  (c) => `Scaffolding was still bolted to her flank when the ${c.cls} **${c.name}** left ${c.bodyLoc} — **${c.faction}**'s idea of an early delivery.`,
  (c) => `Inspectors at ${c.bodyLoc} flagged the ${c.cls} **${c.name}** for incomplete plating before **${c.faction}** ordered her out anyway.`,
  (c) => `Welding crews at ${c.bodyLoc} clocked out mid-seam when **${c.faction}**'s rush order came through on the ${c.cls} **${c.name}**.`,
  (c) => `Deadlines beat craftsmanship at ${c.bodyLoc} this edition: **${c.faction}**'s ${c.cls} **${c.name}** launches with her hull at half strength.`,
  (c) => `Paperwork says finished; the hull says otherwise — **${c.faction}**'s ${c.cls} **${c.name}** ships out of ${c.bodyLoc} half-built.`,
  (c) => `Money moved fast at ${c.bodyLoc}, but the welding torches couldn't keep up, and **${c.faction}**'s ${c.cls} **${c.name}** shows it.`,
  (c) => `Yard workers at ${c.bodyLoc} warned **${c.faction}** the ${c.cls} **${c.name}** wasn't ready. She launched anyway.`,
  (c) => `Under-plated and over-budget, the ${c.cls} **${c.name}** slips out of ${c.bodyLoc} at half hull under **${c.faction}**'s rush contract.`,
  (c) => `Speed has a price, and **${c.faction}** just paid it: the ${c.cls} **${c.name}** leaves ${c.bodyLoc} with her hull half-finished.`,
  (c) => `Sparks were still flying over ${c.bodyLoc} when the rushed ${c.cls} **${c.name}** cleared the gantries under **${c.faction}**'s flag.`,
  (c) => `Hull integrity reports from ${c.bodyLoc} read "incomplete," but **${c.faction}** launched the ${c.cls} **${c.name}** on schedule regardless.`,
  (c) => `Foremen at ${c.bodyLoc} called it reckless; **${c.faction}** called it necessary — either way, the ${c.cls} **${c.name}** ships half-built.`,
  (c) => `Time pressure at ${c.bodyLoc} won out over quality control, and **${c.faction}**'s rushed ${c.cls} **${c.name}** bears the scars.`,
  (c) => `Cutting corners caught up with **${c.faction}** at ${c.bodyLoc}: the ${c.cls} **${c.name}** departs at half hull strength.`,
];
const RUSH_BOTCHED_HEADLINE = [
  () => 'HASTE MAKES HALF A HULL',
  (c) => `BOTCHED JOB AT ${(c.body || 'THE YARDS').toUpperCase()}`,
  (c) => `${c.faction.toUpperCase()} RUSHES ${c.cls.toUpperCase()} OUT HALF-BUILT`,
  (c) => `${c.name.toUpperCase()} LAUNCHES AT HALF HULL`,
  (c) => `RUSH ORDER CRIPPLES ${c.cls.toUpperCase()}`,
  () => 'WELDS STILL SMOKING AT LAUNCH',
  (c) => `SPEED OVER SAFETY AT ${(c.body || 'THE YARDS').toUpperCase()}`,
  () => 'DEADLINE BEATS THE WELDING CREW',
  (c) => `${c.cls.toUpperCase()} LEAVES DOCK UNFINISHED`,
  () => 'CORNERS CUT, HULL EXPOSED',
  (c) => `SCAFFOLDING STILL BOLTED TO ${c.name.toUpperCase()}`,
  (c) => `HALF-BUILT ${c.cls.toUpperCase()} CLEARS THE GANTRY`,
  (c) => `${(c.body || 'THE YARDS').toUpperCase()} YARD SKIPS FINAL CHECKS`,
  () => 'INCOMPLETE HULL, ON SCHEDULE ANYWAY',
  (c) => `NO TIME TO FINISH ${c.name.toUpperCase()}`,
  () => 'PAPERWORK SAYS DONE, HULL DISAGREES',
];
const ARREARS_ENTERED = [
  (c) => `**${c.faction}**'s treasury ran dry this edition — fleet wages unpaid, and every one of its hulls fights at three-quarters strength until the debts clear.`,
  (c) => `Paymasters at **${c.faction}** stopped issuing wages this cycle, and the fleet feels it: every hull now fights at three-quarters strength.`,
  (c) => `The ledgers came back red for **${c.faction}** — crews go unpaid, and combat effectiveness drops to three-quarters until the books balance.`,
  (c) => `Empty coffers, angry crews: **${c.faction}** enters arrears this edition, its ships fighting at three-quarters strength until wages resume.`,
  (c) => `Debt collectors would have a field day with **${c.faction}**'s books — fleet pay has stopped, and so has a quarter of its combat strength.`,
  (c) => `Quartermasters report **${c.faction}** can no longer cover fleet wages; every hull answers the bell at three-quarters strength until the debt clears.`,
  (c) => `No pay, no full strength: **${c.faction}**'s fleet slides into arrears, fighting at three-quarters until the treasury recovers.`,
  (c) => `Bills came due at **${c.faction}** and nobody could cover them — the fleet now operates at three-quarters strength, wages frozen.`,
  (c) => `Word from the paymaster's office: **${c.faction}** has missed fleet payroll, and every hull will fight under-strength until the debt is settled.`,
  (c) => `Treasury officials at **${c.faction}** confirm the obvious — the coffers are empty, and the fleet fights at three-quarters strength for it.`,
  (c) => `Unpaid and undersupplied, **${c.faction}**'s crews now serve at three-quarters combat strength while the treasury searches for solvency.`,
  (c) => `Credit ran out for **${c.faction}** this edition; wages stopped, and so did a quarter of the fleet's fighting edge.`,
  (c) => `Arrears notices went out across **${c.faction}**'s fleet this edition — full pay suspended, full strength along with it.`,
  (c) => `Somewhere in **${c.faction}**'s accounting office, a ledger stopped balancing, and now every hull fights at three-quarters strength for the privilege.`,
  (c) => `Fleet morale takes a hit at **${c.faction}**: paychecks bounced, and combat readiness dropped to three-quarters until the debt clears.`,
  (c) => `Insolvency caught up with **${c.faction}** this edition — wages unpaid, hulls fighting at three-quarters strength until the treasury refills.`,
  (c) => `Payroll clerks at **${c.faction}** posted the bad news: no pay this cycle, and every ship fights at three-quarters strength for it.`,
  (c) => `Red ink spread through **${c.faction}**'s ledgers this edition, and the fleet pays for it in reduced combat strength — three-quarters, until debts clear.`,
  (c) => `Coffers scraped bare, **${c.faction}** enters arrears — crews unpaid, hulls capped at three-quarters strength until the balance is settled.`,
  (c) => `Deficit posted, wages frozen — **${c.faction}**'s fleet now fights at three-quarters strength until the debt clears.`,
];
const ARREARS_ENTERED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} CAN'T MAKE PAYROLL`,
  () => 'FLEET FIGHTS SHORT ON PAY',
  (c) => `TREASURY RUNS DRY AT ${c.faction.toUpperCase()}`,
  () => 'ARREARS DECLARED FLEET-WIDE',
  (c) => `NO PAY FOR ${c.faction.toUpperCase()}'S FLEET`,
  (c) => `COFFERS EMPTY AT ${c.faction.toUpperCase()}`,
  () => 'PAYCHECKS BOUNCE FLEET-WIDE',
  (c) => `WAGES FROZEN ACROSS ${c.faction.toUpperCase()}`,
  (c) => `DEFICIT POSTED AT ${c.faction.toUpperCase()}`,
  () => 'CREWS UNPAID, COMBAT STRENGTH CUT',
  () => 'UNDER-STRENGTH AND UNDERPAID',
  (c) => `RED INK SINKS ${c.faction.toUpperCase()}`,
  (c) => `PAYROLL MISSED AT ${c.faction.toUpperCase()}`,
  () => 'INSOLVENCY HITS THE FLEET',
  (c) => `THE BILLS COME DUE FOR ${c.faction.toUpperCase()}`,
  () => 'THREE-QUARTERS STRENGTH, ZERO PAY',
];
const ARREARS_CLEARED = [
  (c) => `**${c.faction}** cleared its fleet-upkeep debts — full combat pay restored, full combat effectiveness with it.`,
  (c) => `Auditors confirm **${c.faction}**'s books are square again — every hull returns to full combat strength this edition.`,
  (c) => `The debt is paid: **${c.faction}**'s fleet draws full wages once more, and fights like it.`,
  (c) => `Coffers refilled at **${c.faction}**, and with them the fleet's full fighting strength.`,
  (c) => `Back pay went out across **${c.faction}**'s fleet this edition — arrears cleared, full strength restored.`,
  (c) => `Ledgers balanced at **${c.faction}** this edition; the fleet fights at full strength again, wages current.`,
  (c) => `No more red ink for **${c.faction}** — the treasury cleared its debts, and every hull is back to full combat power.`,
  (c) => `Relief in the ranks: **${c.faction}**'s crews are paid in full again, and the fleet's strength shows it.`,
  (c) => `Solvency returned to **${c.faction}** this edition, and with it every hull's full combat effectiveness.`,
  (c) => `Treasury officials at **${c.faction}** report the debts settled — full pay, full strength, fleet-wide.`,
  (c) => `Paymasters at **${c.faction}** cleared every outstanding wage this edition, restoring the fleet to full fighting trim.`,
  (c) => `Squared accounts, squared shoulders: **${c.faction}**'s fleet stands at full strength again after clearing its arrears.`,
  (c) => `A clean ledger closed out for **${c.faction}** this edition, and every hull in the fleet fights at full effectiveness once more.`,
  (c) => `Wages resumed across **${c.faction}**'s fleet this edition, debts cleared and combat strength back to full.`,
  (c) => `Fiscal discipline paid off for **${c.faction}** — the arrears are gone, and so is the penalty on its fleet's strength.`,
  (c) => `Crews across **${c.faction}**'s fleet collected back pay this edition, and every hull is fighting at full strength again.`,
  (c) => `Good news from the counting house: **${c.faction}** has cleared its debts, and the fleet is back to full combat readiness.`,
  (c) => `Deficit erased, discipline restored — **${c.faction}**'s fleet fights at full strength once again this edition.`,
  (c) => `Full pay is flowing again through **${c.faction}**'s fleet, its arrears cleared and its combat edge restored.`,
  (c) => `Empty coffers filled back up at **${c.faction}**, and the fleet's full fighting strength returned with them.`,
];
const ARREARS_CLEARED_HEADLINE = [
  (c) => `${c.faction.toUpperCase()} SQUARES ITS DEBTS`,
  () => 'FULL PAY RESTORED FLEET-WIDE',
  (c) => `BOOKS BALANCED AT ${c.faction.toUpperCase()}`,
  () => 'ARREARS CLEARED, STRENGTH RESTORED',
  (c) => `TREASURY REFILLED AT ${c.faction.toUpperCase()}`,
  () => 'DEBTS PAID, FLEET AT FULL STRENGTH',
  (c) => `BACK PAY REACHES ${c.faction.toUpperCase()}'S FLEET`,
  () => 'SOLVENCY RETURNS TO THE FLEET',
  (c) => `WAGES CURRENT ACROSS ${c.faction.toUpperCase()}`,
  () => 'RED INK WIPED CLEAN',
  (c) => `STRENGTH RESTORED AT ${c.faction.toUpperCase()}`,
  () => 'CREWS PAID, GUNS AT FULL POWER',
  (c) => `DEFICIT ERASED AT ${c.faction.toUpperCase()}`,
  () => 'FLEET REGAINS FULL COMBAT TRIM',
  (c) => `DUES SETTLED AT ${c.faction.toUpperCase()}`,
  () => 'THE LEDGER CLOSES CLEAN',
];

function buildFleetEconomyStories(rows, used, factionNames, locator) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'ship_rush_botched') {
      const loc = locate(locator, row.body_id, p.body_name);
      // House convention: narrative templates read bodyLoc (bold,
      // located form), headline templates read plain body.
      stories.push(mkStory(90, used, 'rush_botched', RUSH_BOTCHED, 'rush_botched_hl', RUSH_BOTCHED_HEADLINE, {
        faction,
        cls: p.ship_class ?? 'ship',
        name: p.ship_name ?? 'an unnamed hull',
        body: loc.name,
        bodyLoc: loc.full,
      }));
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
// Terraforming beats (DESIGN-terraforming stage 8). Three moments:
// the payload landing (window opens), the world flipping, and the
// one thing that can ever undo it — an asteroid. The first two are
// expansion news; the last is an atrocity and reads like one.
// ------------------------------------------------------------

const TERRAFORM_BEGUN = [
  (c) => `The last freighter has landed at ${c.bodyName}: **${c.faction}**'s terraforming payload is complete, and the machines are waking. In **${c.duration} ticks** the world turns green — if it still flies their flag when the clock runs out.`,
  (c) => `**${c.faction}** delivered the final tonnes to **${c.bodyName}** this edition. The transformation window is open; atmosphere processors are spinning up. Whoever holds the world when they finish, keeps it.`,
  (c) => `Freighters have finished unloading at **${c.bodyName}**: **${c.faction}**'s terraforming payload is down, and the first machines are stirring. **${c.duration} ticks** stand between this rock and a green one — assuming nobody takes it first.`,
  (c) => `Atmosphere processors ignited over **${c.bodyName}** this edition, marking **${c.faction}**'s terraforming bid. **${c.duration} ticks** on the clock, and the world stays vulnerable to whoever can seize it before it turns.`,
  (c) => `Ground crews confirm the payload is fully unpacked at **${c.bodyName}**. **${c.faction}** has opened the transformation window; **${c.duration} ticks** remain before the world locks in green, if it locks in at all.`,
  (c) => `Confirmed: **${c.faction}**'s terraforming machinery is active on **${c.bodyName}**. The world will not be finished for **${c.duration} ticks** — plenty of time for a rival fleet to end this before it starts.`,
  (c) => `At **${c.bodyName}**, the waking hum of terraforming engines marks **${c.faction}**'s opening move. **${c.duration} ticks** until the transformation locks — until then, the world remains anyone's to take.`,
  (c) => `Word from **${c.bodyName}**: the last of **${c.faction}**'s freighters has touched down, and the terraforming clock now reads **${c.duration} ticks**. The world stays exposed for every tick of it.`,
  (c) => `Processors are online at **${c.bodyName}**. **${c.faction}** committed the tonnage needed to begin transformation, with **${c.duration} ticks** standing between vacuum and a living sky — if the flag holds that long.`,
  (c) => `Engineers report full ignition at **${c.bodyName}**, the last piece of **${c.faction}**'s terraforming freight now burning down. **${c.duration} ticks** to go, and the world is theirs to lose.`,
  (c) => `Colonists on **${c.bodyName}** felt the ground shift this edition, as **${c.faction}**'s terraforming machines came online. **${c.duration} ticks** separate this world from green — a window rivals will not ignore.`,
  (c) => `Reports out of **${c.bodyName}** confirm the terraforming window has opened under **${c.faction}**'s flag. **${c.duration} ticks** on the countdown, and the world remains contestable until it hits zero.`,
  (c) => `Survey teams clocked the first tremors of transformation at **${c.bodyName}** this edition, courtesy of **${c.faction}**. **${c.duration} ticks** until the world turns — provided nobody knocks the flag down first.`,
  (c) => `Terraforming has begun in earnest at **${c.bodyName}**. **${c.faction}** lit the processors with **${c.duration} ticks** left on the clock, and the world stays fair game to any fleet that can reach it.`,
  (c) => `Payload delivery at **${c.bodyName}** is complete, and **${c.faction}**'s machines are already reworking the air. **${c.duration} ticks** stand between dust and a living world — an interval the wary will not waste.`,
  (c) => `Clocks started running at **${c.bodyName}** this edition: **${c.faction}** has begun the long work of turning it green. **${c.duration} ticks** remain, and the world is vulnerable for every one of them.`,
  (c) => `Vacuum is giving way at **${c.bodyName}**, where **${c.faction}**'s terraforming payload has finished unloading. **${c.duration} ticks** to a living world — assuming the flag survives that long.`,
  (c) => `Regolith is stirring at **${c.bodyName}** under **${c.faction}**'s new machinery. **${c.duration} ticks** until the transformation completes, and the world remains open to conquest until then.`,
  (c) => `Dust storms over **${c.bodyName}** are the last sign of the old world, as **${c.faction}**'s terraforming engines spin up. **${c.duration} ticks** on the countdown, and the outcome is not yet guaranteed.`,
  (c) => `News from **${c.bodyName}** this edition: **${c.faction}** has begun terraforming in full. **${c.duration} ticks** until the world locks in — until then, it belongs to whoever can hold it.`,
];
const TERRAFORM_BEGUN_HEADLINE = [
  (c) => `THE MACHINES WAKE ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `${(c.bodyName || '?').toUpperCase()} BEGINS TO TURN`,
  (c) => `TERRAFORMING BEGINS AT ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `${(c.faction || 'UNKNOWN FACTION').toUpperCase()} OPENS THE TRANSFORMATION WINDOW`,
  (c) => `LAST FREIGHTER DOWN ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `GREEN DAWN COMING TO ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `PROCESSORS IGNITE OVER ${(c.bodyName || '?').toUpperCase()}`,
  () => 'ATMOSPHERE ENGINES COME ONLINE',
  () => 'A VULNERABLE ROAD TO GREEN',
  (c) => `COUNTDOWN BEGINS OVER ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `WORLD ENGINES SPIN UP ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `FIRST LIGHT FOR ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `MACHINERY STIRS ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `CLOCK STARTS ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `DUST GIVES WAY AT ${(c.bodyName || '?').toUpperCase()}`,
  () => 'PAYLOAD DELIVERED, CLOCK RUNNING',
];
const TERRAFORM_COMPLETE = [
  (c) => `**${c.bodyName} is alive.** Oceans where there was regolith, weather where there was vacuum — **${c.faction}**'s terraformers have finished their work, permanently. The world now pays full yield to its keeper's coffers, hosts cities, and anchors trade.`,
  (c) => `Green dawn at **${c.bodyName}**: the transformation is complete and irreversible. **${c.faction}** has added a living world to the map — full income, city rights, and a trade dock, forever.`,
  (c) => `Oceans now cover **${c.bodyName}**, and the change is permanent. **${c.faction}**'s terraforming is complete — full yield, city rights, and a trade dock follow, forever.`,
  (c) => `Cities are already breaking ground on **${c.bodyName}**, newly and permanently alive under **${c.faction}**'s flag. The transformation is finished; there is no undoing it by ordinary means.`,
  (c) => `Full yield flows from **${c.bodyName}** as of this edition: **${c.faction}**'s terraforming project has closed the loop, turning a dead rock into a living world, permanently.`,
  (c) => `Trade routes are already bending toward **${c.bodyName}**, freshly terraformed and irreversibly alive under **${c.faction}**. A dock rises where there was only dust.`,
  (c) => `Confirmed: **${c.bodyName}** has crossed over. **${c.faction}**'s terraforming is complete and permanent — cities, trade, and full income, all locked in for good.`,
  (c) => `At **${c.bodyName}**, the sky finally has weather in it. **${c.faction}** has finished the transformation, and the world now stands as a permanent, living addition to their holdings.`,
  (c) => `News from **${c.bodyName}** this edition: the terraforming is done. **${c.faction}** now holds a fully living world — permanent income, permanent cities, permanent claim.`,
  (c) => `Colonists on **${c.bodyName}** breathed unfiltered air for the first time this edition, as **${c.faction}**'s terraforming reached completion. The world is alive, and it is theirs for good.`,
  (c) => `Engineers have signed off on **${c.bodyName}**: the transformation is finished, permanent, irreversible. **${c.faction}** now counts a living world among its holdings, complete with cities and trade.`,
  (c) => `Survey ships report **${c.bodyName}** fully transformed — oceans, weather, biosphere, all of it. **${c.faction}**'s claim is now permanent, backed by full yield and a working trade dock.`,
  (c) => `Vacuum is a memory on **${c.bodyName}**. **${c.faction}**'s terraforming has finished its work, and the world now stands permanently alive — full income, city rights, and trade, forever theirs.`,
  (c) => `Regolith gave way to soil on **${c.bodyName}** this edition, marking the permanent completion of **${c.faction}**'s terraforming effort. The world will never be barren again.`,
  (c) => `Weather systems are running on **${c.bodyName}** for the first time in its history. **${c.faction}** has finished the terraforming — the change is permanent, and the world is theirs.`,
  (c) => `Rivers now cut across **${c.bodyName}**, proof that **${c.faction}**'s terraforming has reached completion. The transformation cannot be undone by any ordinary act of war.`,
  (c) => `Skies over **${c.bodyName}** cleared to blue this edition, the final mark of **${c.faction}**'s finished terraforming. Full yield, cities, and trade follow — permanently.`,
  (c) => `Rain fell on **${c.bodyName}** for the first time in its history, as **${c.faction}**'s terraforming closed out complete and irreversible. The world is alive, and it will stay that way.`,
  (c) => `Winds move freely across **${c.bodyName}** now that **${c.faction}**'s terraforming has finished. A dead world became a living one, permanently, with cities and trade to follow.`,
  (c) => `Forests are taking root on **${c.bodyName}**, the clearest sign yet that **${c.faction}**'s terraforming is complete. The world is alive now, and short of an atrocity, it will remain so.`,
];
const TERRAFORM_COMPLETE_HEADLINE = [
  (c) => `${(c.bodyName || '?').toUpperCase()} LIVES`,
  (c) => `A NEW WORLD FOR ${(c.faction || '?').toUpperCase()}`,
  (c) => `GREEN DAWN OVER ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `TERRAFORMING COMPLETE AT ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `${(c.faction || 'UNKNOWN FACTION').toUpperCase()} CLAIMS A LIVING WORLD`,
  (c) => `OCEANS RETURN TO ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `FULL YIELD ON ${(c.bodyName || '?').toUpperCase()}`,
  () => 'PERMANENT AND ALIVE',
  (c) => `CITIES RISE ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `TRADE DOCK OPENS AT ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `SKIES CLEAR OVER ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `WEATHER COMES TO ${(c.bodyName || '?').toUpperCase()}`,
  () => 'FROM DUST TO A LIVING WORLD',
  (c) => `NO GOING BACK FOR ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `RAIN FALLS ON ${(c.bodyName || '?').toUpperCase()}`,
  (c) => `FORESTS TAKE ROOT ON ${(c.bodyName || '?').toUpperCase()}`,
];
const TERRAFORM_DESTROYED = [
  (c) => `**${c.bodyName} is dead.** The asteroid ${c.asteroidName ? `**${c.asteroidName}** ` : ''}${c.faction ? `driven by **${c.faction}** ` : ''}struck a LIVING world — oceans boiled, atmosphere torn away, a generation of terraforming erased in one strike. The histories will not be kind.`,
  (c) => `They killed a world today. ${c.faction ? `**${c.faction}**'s ` : 'An '}asteroid ${c.asteroidName ? `— **${c.asteroidName}** — ` : ''}fell on **${c.bodyName}** and took its biosphere with it. What was green is regolith again; nothing short of terraforming it anew will bring it back.`,
  (c) => `Grief settles over **${c.bodyName}** this edition. ${c.faction ? `**${c.faction}** sent ` : 'Someone sent '}an asteroid${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} into a living world, and the biosphere did not survive the impact. Oceans boiled in minutes; the dead do not come back on their own.`,
  (c) => `Call it what it is: an atrocity. ${c.asteroidName ? `**${c.asteroidName}**` : 'An asteroid'} struck **${c.bodyName}**${c.faction ? `, hurled there by **${c.faction}**` : ''}, and a living world was murdered in a single strike. The atmosphere is gone; so is the century of work that built it.`,
  (c) => `No warning reached **${c.bodyName}** before the strike. ${c.faction ? `**${c.faction}**'s ` : 'An unmarked '}asteroid${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} came out of the dark and erased a living world in an instant. Terraforming, undone; a generation of work, gone.`,
  (c) => `Silence now where there was weather. ${c.asteroidName ? `The asteroid **${c.asteroidName}**` : 'An asteroid'} tore into **${c.bodyName}**${c.faction ? `, aimed there by **${c.faction}**` : ''}, and a living world stopped breathing. This is not warfare. This is murder of a world.`,
  (c) => `Word from **${c.bodyName}** has stopped this edition. ${c.faction ? `**${c.faction}** put ` : 'Someone put '}an asteroid${c.asteroidName ? ` named **${c.asteroidName}**` : ''} through its atmosphere, and a living world went dark. Nothing but fresh terraforming will ever bring it back.`,
  (c) => `Ash where there were rivers. ${c.asteroidName ? `**${c.asteroidName}**` : 'An asteroid'} came down on **${c.bodyName}**${c.faction ? `, sent by **${c.faction}**` : ''}, and a living world's biosphere ended in one violent instant. The histories will name this an atrocity, not a battle.`,
  (c) => `Nothing survived the impact at **${c.bodyName}**. ${c.faction ? `**${c.faction}**'s asteroid` : 'An asteroid'}${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} struck a world that had oceans, weather, and cities, and left none of it standing. Terraforming took generations; the killing took seconds.`,
  (c) => `Reports confirm the worst at **${c.bodyName}**: a living world, struck dead by ${c.asteroidName ? `the asteroid **${c.asteroidName}**` : 'an asteroid'}${c.faction ? `, launched by **${c.faction}**` : ''}. Oceans boiled off in an afternoon. This paper does not call that combat.`,
  (c) => `Outrage is spreading over the fate of **${c.bodyName}**, where ${c.faction ? `**${c.faction}** ` : 'someone '}sent an asteroid${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} into a living world's atmosphere and left it a corpse of regolith. There is no honor claimed in this, only ash.`,
  (c) => `Weather stopped on **${c.bodyName}** this edition, the moment ${c.asteroidName ? `**${c.asteroidName}**` : 'an asteroid'} hit${c.faction ? `, guided in by **${c.faction}**` : ''}. A living world's biosphere is gone in a single strike, and no fleet action will ever restore it — only terraforming, from scratch.`,
  (c) => `Mourning is the only honest word for **${c.bodyName}** today. ${c.faction ? `**${c.faction}** ` : 'An unknown hand '}drove an asteroid${c.asteroidName ? `, **${c.asteroidName}**,` : ''} into a living world, and its oceans, air, and cities went with it.`,
  (c) => `Terraforming took a generation to finish on **${c.bodyName}**. ${c.asteroidName ? `**${c.asteroidName}**` : 'An asteroid'} took it apart in one strike${c.faction ? `, at **${c.faction}**'s hand` : ''}. What was alive this morning is regolith tonight.`,
  (c) => `Cities that stood on **${c.bodyName}** this morning are gone tonight. ${c.faction ? `**${c.faction}** ` : 'Someone '}put an asteroid${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} through the atmosphere of a living world, and the paper will not soften the word: atrocity.`,
  (c) => `Biosphere collapse is confirmed at **${c.bodyName}**. ${c.asteroidName ? `The asteroid **${c.asteroidName}**` : 'An asteroid'} struck a living world${c.faction ? ` under **${c.faction}**'s order` : ''}, and everything that made it green is gone in a single strike. Recovery, if it ever comes, starts from zero.`,
  (c) => `Every ocean on **${c.bodyName}** boiled away this edition. ${c.faction ? `**${c.faction}** is named as the hand behind ` : 'No one has yet claimed '}the asteroid${c.asteroidName ? ` **${c.asteroidName}**` : ''} that struck it — a living world, killed outright, its terraforming erased.`,
  (c) => `Fire fell on **${c.bodyName}** this edition, and a living world did not survive it. ${c.faction ? `**${c.faction}** is responsible for ` : 'No claim has been made for '}the strike${c.asteroidName ? `, carried out by **${c.asteroidName}**` : ''}. The dead do not come back without decades of new work.`,
  (c) => `Air that took a generation to build is gone from **${c.bodyName}** in a single afternoon. ${c.faction ? `**${c.faction}**'s asteroid` : 'An asteroid'}${c.asteroidName ? `, **${c.asteroidName}**,` : ''} struck a living world and left nothing green behind.`,
  (c) => `Condemnation is already loud over **${c.bodyName}**. ${c.faction ? `**${c.faction}** ` : 'Whoever '}sent an asteroid${c.asteroidName ? ` — **${c.asteroidName}** —` : ''} into a living world committed the paper's harshest charge: world-killing, not warfare.`,
];
const TERRAFORM_DESTROYED_HEADLINE = [
  (c) => `${(c.bodyName || 'A WORLD').toUpperCase()} IS DEAD`,
  () => 'THEY KILLED A LIVING WORLD',
  () => 'A WORLD MURDERED IN ONE STRIKE',
  (c) => `${(c.faction || 'UNKNOWN HANDS').toUpperCase()} KILLED A LIVING WORLD`,
  () => 'ATROCITY IN THE DARK',
  (c) => `OCEANS BOILED ON ${(c.bodyName || 'A WORLD').toUpperCase()}`,
  () => 'GENERATIONS OF WORK, GONE',
  (c) => `${(c.asteroidName || 'AN ASTEROID').toUpperCase()} KILLED A WORLD`,
  () => 'NO WARNING, NO SURVIVORS',
  (c) => `BIOSPHERE GONE FROM ${(c.bodyName || 'A WORLD').toUpperCase()}`,
  () => 'THIS WAS NOT WARFARE',
  (c) => `LIGHTS OUT ON ${(c.bodyName || 'A WORLD').toUpperCase()}`,
  () => 'GONE IN A SINGLE STRIKE',
  () => 'MOURNING FOR A DEAD WORLD',
  () => 'CONDEMNATION SPREADS AFTER STRIKE',
  (c) => `AIR TORN FROM ${(c.bodyName || 'A WORLD').toUpperCase()}`,
];

/** Terraform lifecycle beats. begun/complete are expansion news; the
 *  asteroid beat is filed under battles at near-Dyson-collapse weight —
 *  killing a living world IS the front page. */
function buildTerraformStories(rows, used, factionNames) {
  const colonies = [];
  const battles = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'terraform_begun') {
      colonies.push(mkStory(180, used, 'terraform_begun', TERRAFORM_BEGUN, 'terraform_begun_hl', TERRAFORM_BEGUN_HEADLINE, {
        faction, bodyName: p.body_name ?? 'a distant world', duration: p.duration ?? 24,
      }));
    } else if (row.kind === 'terraform_complete') {
      // A permanent new living world outranks any routine expansion —
      // enough to headline a quiet edition.
      colonies.push(mkStory(400, used, 'terraform_complete', TERRAFORM_COMPLETE, 'terraform_complete_hl', TERRAFORM_COMPLETE_HEADLINE, {
        faction, bodyName: p.body_name ?? 'a distant world',
      }));
    } else if (row.kind === 'terraform_destroyed') {
      battles.push(mkStory(800, used, 'terraform_destroyed', TERRAFORM_DESTROYED, 'terraform_destroyed_hl', TERRAFORM_DESTROYED_HEADLINE, {
        faction: row.actor_faction_id ? faction : null,
        bodyName: p.body_name ?? 'a living world',
        asteroidName: p.asteroid_name ?? null,
      }));
    }
  }
  return { colonies, battles };
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

// Discord's hard cap on an embed field value.
const FIELD_VALUE_LIMIT = 1024;
// Assembly budget, leaving room for an overflow tail to be appended.
const FIELD_VALUE_BUDGET = 900;

/** Cuts at the last sentence end inside `limit`, falling back to the
 *  last word boundary — never mid-word. The old behavior (render
 *  everything, then `slice(0, 1017) + '…'`) put "…were also l…" into a
 *  real edition: a guillotined word reads as a broken renderer, which
 *  costs more credibility than the dropped sentence was worth. */
function clipToSentence(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - 1);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence > limit * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return `${word > 0 ? head.slice(0, word) : head}…`;
}

/** Renders one section. Takes whole stories while they fit and lets
 *  the overflow tail absorb the rest, rather than cutting the last one
 *  off mid-sentence — a story that never appears is invisible, a story
 *  chopped in half looks like a bug.
 *
 *  `allowTail` is rationed by the caller: the "…and N more incidents"
 *  device is meant to suggest a world larger than the page, and it
 *  does that exactly once. Appended to all seven sections of every
 *  edition it stops reading as a wink and starts reading as the paper
 *  apologizing for itself. */
function fieldFromStories(title, stories, used, { allowTail = true } = {}) {
  if (stories.length === 0) return null;

  const shown = [];
  let len = 0;
  for (const s of stories.slice(0, MAX_STORIES_PER_SECTION)) {
    const add = (shown.length ? 2 : 0) + s.text.length;
    if (shown.length > 0 && len + add > FIELD_VALUE_BUDGET) break;
    shown.push(s);
    len += add;
  }
  // Only reachable when a SINGLE story outruns the whole budget.
  const texts = shown.map((s, i) =>
    (i === 0 && shown.length === 1) ? clipToSentence(s.text, FIELD_VALUE_LIMIT - 4) : s.text);

  let value = texts.join('\n\n');
  const more = stories.length - shown.length;
  if (more > 0 && allowTail) {
    const s = more === 1 ? '' : 's';
    const tail = pickTemplate('more_incidents_tail', MORE_INCIDENTS_TAIL, used)(more, s);
    if (value.length + 2 + tail.length <= FIELD_VALUE_LIMIT) value += `\n\n${tail}`;
  }
  return { name: title, value, shownCount: shown.length };
}

/** Build the embed for one game. Headline-forward: the single
 *  highest-weighted story becomes the embed's ALL-CAPS title (with
 *  its narrative sentence as the deck, under a masthead line), and is
 *  removed from its section so it isn't shown twice. Everything else
 *  renders as before, grouped by section. Returns null when the day
 *  was entirely uneventful (no stories + no trades) so we skip the
 *  post rather than spam "nothing happened". */
/**
 * Sanctions currently IN FORCE, as a standing field with a countdown.
 *
 * Not a story: every other section is built from chronicle events ("the
 * Senate passed X"), which fire once and never mention the thing again.
 * A sanction is a STATE that persists for days of real time, and the
 * question players actually have — "how much longer does this last?" —
 * had no answer anywhere in the game. So the Herald re-states it every
 * edition with the remaining ticks, and it simply disappears from the
 * paper when it lapses.
 */
function sanctionsField(sanctions, factionNames) {
  if (!sanctions || sanctions.length === 0) return null;
  const LABEL = {
    war_authorization:   n => `⚔️ **War Authorization** on ${n} — all damage dealt to them is doubled`,
    trade_embargo:       n => `🚫 **Trade Embargo** on ${n} — deliveries blocked`,
    production_sanction: n => `🏭 **Production Sanction** on ${n} — yields halved`,
  };
  const lines = [];
  // Soonest to lapse first: that is the one with a decision attached.
  for (const sx of [...sanctions].sort((a, b) => a.ticks_left - b.ticks_left)) {
    const fmt = LABEL[sx.kind];
    if (!fmt) continue;
    const who = factionNames.get(sx.target_faction_id) ?? 'an unnamed power';
    const t = sx.ticks_left;
    const clock = t <= 0 ? 'lapses this tick'
      : t === 1 ? '**1 tick** remaining'
      : `**${t} ticks** remaining`;
    lines.push(`${fmt(b(who))} · ${clock}`);
  }
  if (lines.length === 0) return null;
  const value = clipToSentence(lines.join('\n'), FIELD_VALUE_LIMIT - 4);
  return { name: '⚖️  Sanctions in force', value };
}

/** Closing editorial line for the edition that carries the victory.
 *  `who` arrives already bolded. */
const FINAL_WORD = [
  who => `The war is over, and ${who} is what remains standing. This desk will file no further editions on it.`,
  who => `That is the end of it. ${who} holds the system, and the presses go quiet.`,
  who => `Whatever the settlement costs, ${who} will be the one setting the terms. The Herald closes its file on this war.`,
  who => `${who} has won. Everything after this is bookkeeping, and other papers can do it.`,
  who => `The shooting stops here. ${who} takes the system, and the rest take stock.`,
  who => `An ending, of a kind: ${who} prevails, and the survivors begin counting what it cost them.`,
  who => `So it falls to ${who}. The Herald thanks its correspondents, several of whom did not come home.`,
  who => `${who} stands first among the powers, and there is no longer anyone positioned to argue. Final edition.`,
  who => `The last dispatch of the war: ${who} victorious, the lanes quiet, the yards suddenly without orders.`,
  who => `History will record ${who}. This paper records the rest — who they beat, and what it took.`,
];

/**
 * The final reckoning — a war-total retrospective, printed only in the
 * edition that carries the victory.
 *
 * Same self-imposed rule as the standings box: derived only from the
 * rows in hand, so a historical preview can never print a number it
 * has no right to. In the edition that ends a match those rows ARE the
 * endgame, which is exactly the period a closing summary should cover.
 */
function finalReckoningField(rows, factionNames) {
  const victoryRow = rows.find(r => r.kind === 'victory');
  if (!victoryRow) return null;
  const p = safeJson(victoryRow.payload);
  const winner = factionNames.get(victoryRow.actor_faction_id) ?? 'the victor';

  const VICTORY_KIND = {
    chancellor: 'election to the Supreme Chancellorship',
    conquest:   'conquest',
    dyson:      'completion of the Dyson Sphere',
    economic:   'economic supremacy',
    science:    'scientific supremacy',
  };
  const how = VICTORY_KIND[p.victoryType] ?? null;

  let hullsLost = 0, worldsRazed = 0;
  const eliminated = [];
  for (const row of rows) {
    if (row.kind === 'ship_destroyed') hullsLost++;
    else if (row.kind === 'settlement_destroyed') worldsRazed++;
    else if (row.kind === 'faction_eliminated') {
      const n = factionNames.get(row.actor_faction_id);
      if (n) eliminated.push(n);
    }
  }

  const lines = [];
  lines.push(how
    ? `**${winner}** takes the system by ${how}.`
    : `**${winner}** takes the system.`);
  const toll = [];
  if (hullsLost > 0) toll.push(`**${hullsLost}** ${plural(hullsLost, 'hull', 'hulls')} lost`);
  if (worldsRazed > 0) toll.push(`**${worldsRazed}** ${plural(worldsRazed, 'settlement', 'settlements')} razed`);
  if (toll.length) lines.push(`In this final period alone: ${toll.join(', ')}.`);
  if (eliminated.length) {
    lines.push(`${plural(eliminated.length, 'Faction', 'Factions')} that did not survive the war: ${eliminated.map(n => `**${n}**`).join(', ')}.`);
  }
  lines.push('');
  lines.push(`*${pickTemplateStatic(FINAL_WORD, `${winner}:${hullsLost}`)(`**${winner}**`)}*`);

  return { name: '🕯️  The final reckoning', value: clipToSentence(lines.join('\n'), FIELD_VALUE_LIMIT - 4) };
}

/** Deterministic pick for the handful of call sites that sit outside a
 *  `used` walk — same input, same line, no cross-edition drift. */
function pickTemplateStatic(bank, seedish) {
  const s = String(seedish ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return bank[Math.abs(h) % bank.length];
}

/**
 * Standings — "who is actually winning?"
 *
 * A reviewer read ten consecutive editions and could not answer that
 * question at any point, which is a damning thing to say about a
 * strategy game's newspaper: every battle was reported and the war was
 * invisible. This is the fix, with one hard constraint — it is derived
 * ENTIRELY from the same chronicle rows the rest of the edition is
 * built from.
 *
 * That constraint is not laziness. The obvious implementation is to
 * query live game state, but the Herald also renders historical
 * editions (an admin previewing T+88 of a finished match), and live
 * state would print today's standings on a paper dated six weeks ago —
 * confidently, and wrongly. A net-change box is honest in both cases:
 * it says what moved DURING this window, which is what a newspaper
 * reports anyway. "Gained/lost since the last edition" is a real
 * standings column; "current totals" would have been a lie half the
 * time it rendered.
 */
function standingsField(rows, factionNames) {
  const stat = new Map();   // faction name -> tallies
  const touch = (name) => {
    if (!name) return null;
    let s = stat.get(name);
    if (!s) { s = { built: 0, lost: 0, founded: 0, razed: 0 }; stat.set(name, s); }
    return s;
  };

  for (const row of rows) {
    const p = safeJson(row.payload);
    if (row.kind === 'ship_built') {
      const s = touch(p.owner_faction_name); if (s) s.built++;
    } else if (row.kind === 'settlement_built') {
      const s = touch(p.owner_faction_name); if (s) s.founded++;
    } else if (row.kind === 'ship_destroyed') {
      const s = touch(p.owner_faction_name ?? factionNames.get(row.actor_faction_id)); if (s) s.lost++;
    } else if (row.kind === 'settlement_destroyed') {
      const s = touch(p.owner_faction_name ?? factionNames.get(row.target_faction_id)); if (s) s.razed++;
    }
  }
  if (stat.size < 2) return null;

  const rank = [...stat.entries()]
    .map(([name, s]) => ({ name, ...s, net: (s.built - s.lost) + 3 * (s.founded - s.razed) }))
    // A power with no activity at all this window is not news.
    .filter(r => r.built || r.lost || r.founded || r.razed)
    .sort((a, z) => z.net - a.net);
  if (rank.length < 2) return null;

  const sign = n => (n > 0 ? `+${n}` : String(n));
  const lines = rank.slice(0, 6).map((r) => {
    const fleet = r.built - r.lost;
    const ground = r.founded - r.razed;
    // An arrow the eye can sort on without reading the numbers.
    const trend = r.net > 2 ? '▲' : r.net < -2 ? '▼' : '▬';
    return `${trend} **${r.name}** · fleet ${sign(fleet)} · worlds ${sign(ground)}`;
  });
  return {
    name: '📊  Where things stand',
    value: clipToSentence(
      `${lines.join('\n')}\n*Net change this edition — hulls gained less hulls lost, settlements founded less settlements razed.*`,
      FIELD_VALUE_LIMIT - 4,
    ),
  };
}

// ================================================================
// NEW CONTENT CATEGORIES (2026-08 Herald depth pass) — banks for
// event kinds the digest never had a voice for: research, trade
// delivery, game start, and the fleet-organization lifecycle.
// ================================================================

const FLEET_FLAG_LOST = [
  c => `The **${c.fleetName}** sails without a flag captain tonight — ${b(c.actor)}'s command post stands empty.`,
  c => `${b(c.actor)}'s **${c.fleetName}** has lost its flag officer. Command reverts to whoever inherits the bridge.`,
  c => `Vacant now, the flag deck of the **${c.fleetName}** awaits a name. ${b(c.actor)} has not filled the post.`,
  c => `No captain answers for the **${c.fleetName}** tonight — the post has gone empty under ${b(c.actor)}'s flag.`,
  c => `A gap opens in ${b(c.actor)}'s chain of command: the **${c.fleetName}** now has no flag officer.`,
  c => `Silence from the bridge of the **${c.fleetName}**. ${b(c.actor)}'s fleet is, for now, headless.`,
  c => `Dispatches confirm no flag captain aboard the **${c.fleetName}**. ${b(c.actor)} has not yet named a replacement.`,
  c => `Command of the **${c.fleetName}** sits unclaimed tonight, a vacancy in ${b(c.actor)}'s ranks.`,
  c => `Whoever last held the flag aboard the **${c.fleetName}** holds it no longer — ${b(c.actor)}'s formation is without a leader.`,
  c => `${b(c.actor)} faces an empty flag deck aboard the **${c.fleetName}**, command adrift until further notice.`,
  c => `Officers aboard the **${c.fleetName}** answer to no one tonight. The flag post is empty, and ${b(c.actor)} has said nothing.`,
  c => `An unfamiliar quiet settles over the **${c.fleetName}** — its flag captain gone, its orders unsigned, under ${b(c.actor)}'s banner.`,
  c => `Broken now, the chain of command aboard the **${c.fleetName}** waits to be repaired. ${b(c.actor)} must find who fills it.`,
  c => `Somewhere aboard the **${c.fleetName}**, a chair sits empty where a flag captain once stood, under ${b(c.actor)}'s colors.`,
];

const FLEET_FLAG_LOST_HEADLINE = [
  c => `THE ${c.fleetName.toUpperCase()} GOES LEADERLESS`,
  c => `${c.actor.toUpperCase()} FLEET WITHOUT A FLAG CAPTAIN`,
  c => `FLAG DECK EMPTY ABOARD THE ${c.fleetName.toUpperCase()}`,
  c => `NO ONE HOLDS THE FLAG ON THE ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} FACES A COMMAND VACANCY`,
  c => `${c.fleetName.toUpperCase()} SAILS UNCOMMANDED`,
  c => `COMMAND GAP OPENS ABOARD THE ${c.fleetName.toUpperCase()}`,
  c => `${c.fleetName.toUpperCase()} LOSES ITS FLAG OFFICER`,
  c => `SILENCE ON THE BRIDGE OF THE ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SCRAMBLES FOR A NEW FLAG CAPTAIN`,
  c => `A VACANT POST ABOARD THE ${c.fleetName.toUpperCase()}`,
  c => `HEADLESS: THE ${c.fleetName.toUpperCase()} AWAITS A CAPTAIN`,
];

const FLEET_FLAG_PROMOTED = [
  c => `${b(c.actor)} has named Captain ${b(c.captainName)} flag officer of the **${c.fleetName}**.`,
  c => `A new flag captain for the **${c.fleetName}**: ${b(c.actor)} has given Captain ${b(c.captainName)} command.`,
  c => `Captain ${b(c.captainName)} now holds the flag aboard the **${c.fleetName}**, by order of ${b(c.actor)}.`,
  c => `The bridge of the **${c.fleetName}** has a new occupant. ${b(c.actor)} names Captain ${b(c.captainName)} to the post.`,
  c => `Question of command resolved: Captain ${b(c.captainName)} takes the flag aboard the **${c.fleetName}**, per ${b(c.actor)}.`,
  c => `Promotion orders confirm Captain ${b(c.captainName)} as flag officer of ${b(c.actor)}'s **${c.fleetName}**.`,
  c => `From this watch forward, the **${c.fleetName}** answers to Captain ${b(c.captainName)}, appointed by ${b(c.actor)}.`,
  c => `${b(c.actor)} elevates Captain ${b(c.captainName)} to flag rank aboard the **${c.fleetName}**.`,
  c => `Command of the **${c.fleetName}** passes to Captain ${b(c.captainName)}, on ${b(c.actor)}'s order.`,
  c => `Pennants change hands: Captain ${b(c.captainName)} assumes the flag of the **${c.fleetName}** for ${b(c.actor)}.`,
  c => `Officer records list Captain ${b(c.captainName)} as the new flag captain of ${b(c.actor)}'s **${c.fleetName}**.`,
  c => `Flag rank goes to Captain ${b(c.captainName)}, tapped by ${b(c.actor)} to lead the **${c.fleetName}**.`,
  c => `No longer without a commander, the **${c.fleetName}** now flies under Captain ${b(c.captainName)}, named by ${b(c.actor)}.`,
  c => `Word of the appointment spreads quickly: Captain ${b(c.captainName)} now commands ${b(c.actor)}'s **${c.fleetName}**.`,
];

const FLEET_FLAG_PROMOTED_HEADLINE = [
  c => `${c.captainName.toUpperCase()} TAKES COMMAND OF THE ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} NAMES NEW FLAG CAPTAIN`,
  c => `NEW FLAG OFFICER FOR THE ${c.fleetName.toUpperCase()}`,
  c => `CAPTAIN ${c.captainName.toUpperCase()} PROMOTED TO FLAG RANK`,
  c => `${c.fleetName.toUpperCase()} GETS A NEW COMMANDER`,
  c => `${c.actor.toUpperCase()} ELEVATES ${c.captainName.toUpperCase()} TO THE FLAG DECK`,
  c => `COMMAND OF THE ${c.fleetName.toUpperCase()} CHANGES HANDS`,
  c => `${c.captainName.toUpperCase()} NAMED FLAG CAPTAIN`,
  c => `A NEW PENNANT FOR THE ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} SETTLES COMMAND OF THE ${c.fleetName.toUpperCase()}`,
  c => `FLAG RANK GOES TO ${c.captainName.toUpperCase()}`,
  c => `THE ${c.fleetName.toUpperCase()} ANSWERS TO ${c.captainName.toUpperCase()} NOW`,
];

const FLEET_FORMED = [
  c => `${b(c.actor)} has organized ${numWord(c.shipCount)} ships into a new formation, the **${c.fleetName}**${c.flagCaptainClause}.`,
  c => `A new fleet takes shape under ${b(c.actor)}'s banner: the **${c.fleetName}**, ${numWord(c.shipCount)} ships strong${c.flagCaptainClause}.`,
  c => `Dockyard registries now list the **${c.fleetName}**, ${numWord(c.shipCount)} hulls formally grouped under ${b(c.actor)}${c.flagCaptainClause}.`,
  c => `In a formal muster, ${b(c.actor)} has christened the **${c.fleetName}**, drawing together ${numWord(c.shipCount)} ships${c.flagCaptainClause}.`,
  c => `Word from the yards: the **${c.fleetName}** is official, ${numWord(c.shipCount)} ships bound under one command for ${b(c.actor)}${c.flagCaptainClause}.`,
  c => `Loose hulls no longer — ${numWord(c.shipCount)} ships now sail together as the **${c.fleetName}**, raised by ${b(c.actor)}${c.flagCaptainClause}.`,
  c => `${b(c.actor)} folds ${numWord(c.shipCount)} vessels into a single chain of command: the **${c.fleetName}**${c.flagCaptainClause}.`,
  c => `The **${c.fleetName}** enters the record today, ${numWord(c.shipCount)} ships strong and flying colors for ${b(c.actor)}${c.flagCaptainClause}.`,
  c => `Rival war rooms take note: ${b(c.actor)} has consolidated ${numWord(c.shipCount)} ships into the **${c.fleetName}**${c.flagCaptainClause}.`,
  c => `Out of scattered squadrons, ${b(c.actor)} has built the **${c.fleetName}** — ${numWord(c.shipCount)} ships under a single order${c.flagCaptainClause}.`,
  c => `Naval clerks confirm the paperwork: ${numWord(c.shipCount)} ships, one name, the **${c.fleetName}**, answering to ${b(c.actor)}${c.flagCaptainClause}.`,
  c => `Analysts note the concentration of force: ${numWord(c.shipCount)} ships massed under ${b(c.actor)}'s new **${c.fleetName}**${c.flagCaptainClause}.`,
  c => `Ship's manifests are updated as ${numWord(c.shipCount)} ships join ${b(c.actor)}'s newly organized **${c.fleetName}**${c.flagCaptainClause}.`,
  c => `Talk in the officers' mess turns to the **${c.fleetName}**, ${b(c.actor)}'s new formation of ${numWord(c.shipCount)} ships${c.flagCaptainClause}.`,
];

const FLEET_FORMED_HEADLINE = [
  c => `${c.actor.toUpperCase()} FORMS THE ${c.fleetName.toUpperCase()}`,
  c => `NEW FLEET FOR ${c.actor.toUpperCase()}`,
  c => `THE ${c.fleetName.toUpperCase()} IS BORN`,
  c => `SHIPS UNITE UNDER ONE BANNER FOR ${c.actor.toUpperCase()}`,
  c => `A NEW FORMATION TAKES THE FIELD: ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} CHRISTENS THE ${c.fleetName.toUpperCase()}`,
  c => `SCATTERED HULLS BECOME THE ${c.fleetName.toUpperCase()}`,
  c => `FLEET CONSOLIDATION FOR ${c.actor.toUpperCase()}`,
  c => `${c.fleetName.toUpperCase()} JOINS THE ORDER OF BATTLE`,
  c => `FRESH MUSTER FOR ${c.actor.toUpperCase()}`,
  c => `ONE NAME, MANY HULLS: THE ${c.fleetName.toUpperCase()}`,
  c => `${c.actor.toUpperCase()} STANDS UP THE ${c.fleetName.toUpperCase()}`,
];

const GAME_STARTED = [
  c => `The Herald begins publication today. ${c.factionCount} powers enter the system, each holding ${c.worldsPerPlayer} worlds — and a war ahead of them.`,
  c => `First edition: ${c.factionCount} factions have taken up positions across the system, ${c.worldsPerPlayer} worlds apiece. Let the record show how it began.`,
  c => `Correspondents confirm ${c.factionCount} factions now hold their opening worlds, ${c.worldsPerPlayer} each. The system's long silence ends here.`,
  c => `Under the banner of ${b(c.gameName)}, ${c.factionCount} powers have staked their claims — ${c.worldsPerPlayer} worlds to a name — and the clock starts now.`,
  c => `Ink is barely dry and already there is news: ${c.factionCount} factions stand at their starting lines, ${c.worldsPerPlayer} worlds each.`,
  c => `No treaties yet, no wars declared — only ${c.factionCount} factions, ${c.worldsPerPlayer} worlds each, and the waiting.`,
  c => `Today the system counts ${c.factionCount} sovereign powers for the first time, each seated on ${c.worldsPerPlayer} worlds.`,
  c => `Astronomers mark the hour: ${c.factionCount} factions have opened their books, ${c.worldsPerPlayer} worlds listed under each name.`,
  c => `A new masthead, a new war: ${b(c.gameName)} enters the record with ${c.factionCount} factions and ${c.worldsPerPlayer} worlds each.`,
  c => `Before there were battles, there were only these numbers: ${c.factionCount} factions, ${c.worldsPerPlayer} worlds apiece. History starts counting from here.`,
  c => `Every faction begins equal tonight — ${c.factionCount} of them, ${c.worldsPerPlayer} worlds each, none yet ahead.`,
  c => `Word reaches every corner of the system: ${c.factionCount} powers have arrived, ${c.worldsPerPlayer} worlds already under their control.`,
  c => `Editors note the date for posterity — ${c.factionCount} factions founded, ${c.worldsPerPlayer} worlds each, not a shot fired yet.`,
  c => `Somewhere among ${c.factionCount} new powers, a victor is already decided. The Herald simply does not know which one yet.`,
];

const GAME_STARTED_HEADLINE = [
  () => 'THE HERALD BEGINS PUBLICATION',
  c => `${c.factionCount} POWERS ENTER THE SYSTEM`,
  () => 'A NEW WAR OPENS ITS FIRST PAGE',
  c => `${c.factionCount} FACTIONS TAKE THEIR POSITIONS`,
  () => 'FIRST EDITION: THE LONG SILENCE ENDS',
  c => `${c.factionCount} FLAGS RAISED, ZERO SHOTS FIRED`,
  () => 'OPENING BELL FOR A NEW WAR',
  c => `${c.factionCount} POWERS STAKE THEIR CLAIMS`,
  () => 'HISTORY BEGINS COUNTING FROM HERE',
  c => `${c.factionCount} FACTIONS FOUNDED OVERNIGHT`,
  () => 'NO TREATIES YET, NO WARS DECLARED',
  c => `${c.factionCount} SOVEREIGN POWERS, ONE SYSTEM`,
];

const TECH_ADVANCED = [
  c => `${b(c.faction)}'s ${c.track} program advanced to level ${numWord(c.level)}.`,
  c => `${b(c.faction)} researchers logged a breakthrough in ${c.track} — level ${numWord(c.level)} now active.`,
  c => `Level ${numWord(c.level)} ${c.track} research cleared for ${b(c.faction)}.`,
  c => `${b(c.faction)}'s ${c.track} division reached level ${numWord(c.level)} today.`,
  c => `A new tier of ${c.track} work went live for ${b(c.faction)}: level ${numWord(c.level)}.`,
  c => `${b(c.faction)} posted another gain in ${c.track}, now at level ${numWord(c.level)}.`,
  c => `Engineers for ${b(c.faction)} signed off on level ${numWord(c.level)} ${c.track} designs.`,
  c => `${b(c.faction)}'s labs closed out level ${numWord(c.level)} in ${c.track}.`,
  c => `Progress noted: ${b(c.faction)} moved ${c.track} research to level ${numWord(c.level)}.`,
  c => `${b(c.faction)} filed papers confirming level ${numWord(c.level)} ${c.track} status.`,
  c => `The ${c.track} program at ${b(c.faction)} ticked up to level ${numWord(c.level)}.`,
  c => `${b(c.faction)}'s ${c.track} researchers cleared their level ${numWord(c.level)} milestone.`,
  c => `Quiet gains for ${b(c.faction)}: ${c.track} now sits at level ${numWord(c.level)}.`,
  c => `${b(c.faction)} expanded ${c.track === 'Sensors' ? 'detection range' : c.track.toLowerCase() + ' capability'} to level ${numWord(c.level)}.`,
  c => `${c.track === 'Weapons' ? 'Armament' : c.track} designs cleared level ${numWord(c.level)} certification for ${b(c.faction)}.`,
  c => `${b(c.faction)}'s ${c.track === 'Propulsion' ? 'engine' : c.track} engineers reached level ${numWord(c.level)}.`,
  c => `${c.track === 'Defense' ? 'Armor plating' : c.track + ' work'} for ${b(c.faction)} advanced to level ${numWord(c.level)}.`,
  c => `${b(c.faction)}'s ${c.track === 'Construction' ? 'shipyards' : c.track + ' teams'} certified level ${numWord(c.level)} standards.`,
  c => `${c.track === 'Society' ? 'Governance reforms' : c.track + ' research'} pushed ${b(c.faction)} to level ${numWord(c.level)}.`,
  c => `${b(c.faction)}'s ${c.track} program hit level ${numWord(c.level)}${c.level >= 8 ? ', a rare tier for the region' : ''}.`,
  c => `${b(c.faction)} gunners will meet the next engagement with ${numWord(c.level)} ${plural(c.level, 'generation', 'generations')} of ${c.track} work behind them, and the ships across from them will notice.`,
  c => `The ${c.track} programme has reached its ${ordinal(c.level)} standard. What that buys, in plain terms, is a shorter argument the next time two fleets meet.`,
  c => `Fewer surprises. That is the whole of what level ${c.level} ${c.track} means for ${b(c.faction)}, and it is not a small thing.`,
  c => `A first pass, a tenth pass — the yards of ${b(c.faction)} rarely say which. This one is the ${ordinal(c.level)}, and the hulls coming out of it are not the hulls that went in.`,
  c => `${b(c.faction)} certified ${c.track} to level ${c.level}. Rivals who mapped the old capabilities are now working from a stale chart.`,
  c => `Level ${c.level} in ${c.track}. Translated out of the ministry's dialect: the fleet gets somewhere sooner, and arrives in better shape than it used to.`,
  c => `Observers who track such things put ${b(c.faction)} at the ${ordinal(c.level)} tier of ${c.track} — far enough along that the advantage now shows up in the fighting rather than the filings.`,
  c => `The ${c.track} board of ${b(c.faction)} has signed off on level ${c.level}. Signing off and surviving contact are different disciplines, and only one of them has been demonstrated.`,
  c => `Something changed in ${b(c.faction)}'s ${c.track} doctrine this quarter — level ${c.level}, by the official count. Crews will feel it before the analysts explain it.`,
  c => `${c.track} work at level ${c.level} means ${b(c.faction)} can now attempt things that would have been reckless a year ago. Whether they should is a separate question.`,
  c => `Level ${c.level} ${c.track}. ${b(c.faction)} did not announce it; the shipping lanes did, by getting faster.`,
  c => `${b(c.faction)} has ${numWord(c.level)} ${plural(c.level, 'level', 'levels')} of ${c.track} on the books now. The first bought competence. Each one after has bought margin, and margin is what wins long wars.`,
  c => `Engineering circles report a ${c.track} advance to level ${c.level} within ${b(c.faction)}. The practical effect is that fewer of their ships will die of things that used to kill ships.`,
  c => `A ${c.track} milestone for ${b(c.faction)}, the ${ordinal(c.level)}. Milestones are markers on a road, and this road leads somewhere the neighbours would rather it did not.`,
  c => `The machinery of state in ${b(c.faction)} turned over a notch this week — ${c.track}, level ${c.level}. Duller than a battle, and likelier to decide one.`,
  c => `Level ${c.level} ${c.track} certification. ${b(c.faction)} yards can build what they could not build last season, at scales they could not manage.`,
  c => `${b(c.faction)} reached the ${ordinal(c.level)} rung of ${c.track}. Sceptics note that no advance has yet stopped a determined broadside; optimists note that this one narrows the odds.`,
  c => `What ${c.track} at level ${c.level} does for ${b(c.faction)} is buy time — time to see, time to turn, time to decide. Wars are lost by commanders who ran out of all three.`,
  c => `The ${ordinal(c.level)} standard in ${c.track} is now current across ${b(c.faction)} service. Older designs are not obsolete so much as outvoted.`,
  c => `Quietly, without ceremony, ${b(c.faction)} moved ${c.track} to level ${c.level}. Ceremony would have told the rivals what they now have to discover the hard way.`,
  c => `${b(c.faction)}'s ${c.track} sits at ${c.level} of a possible ten. That is the sort of figure that means nothing until the shooting starts and everything afterward.`,
  c => `Level ${c.level}, ${c.track}. Every such advance is an argument that the next war will be shorter, and ${b(c.faction)} has now made that argument ${numWord(c.level)} ${plural(c.level, 'time', 'times')}.`,
  c => `The ${c.track} directorate of ${b(c.faction)} reports level ${c.level} attained. Directorates report a great many things; this one will be visible in the wreckage.`,
  c => `Doctrine follows capability, and capability in ${b(c.faction)}'s ${c.track} now stands at ${numWord(c.level)}. Expect the doctrine to catch up by the next campaign season.`,
];

const TECH_ADVANCED_HEADLINE = [
  c => `${c.faction.toUpperCase()} ADVANCES ${c.track.toUpperCase()} RESEARCH`,
  c => `${c.track.toUpperCase()} PROGRAM REACHES LEVEL ${c.level}`,
  c => `RESEARCH GAIN FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} CLEARS LEVEL ${c.level} ${c.track.toUpperCase()}`,
  c => `${c.track.toUpperCase()} MILESTONE FOR ${c.faction.toUpperCase()}`,
  c => `LEVEL ${c.level} ${c.track.toUpperCase()} CERTIFIED FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} LABS LOG ${c.track.toUpperCase()} GAIN`,
  c => `NEW ${c.track.toUpperCase()} TIER FOR ${c.faction.toUpperCase()}`,
  c => `${c.faction.toUpperCase()} TICKS UP IN ${c.track.toUpperCase()}`,
  c => `RESEARCHERS CLOSE OUT ${c.track.toUpperCase()} LEVEL ${c.level}`,
  c => `${c.faction.toUpperCase()}'S ${c.track.toUpperCase()} PROGRAM ADVANCES`,
  c => `ANOTHER STEP FORWARD IN ${c.track.toUpperCase()} FOR ${c.faction.toUpperCase()}`,
  c => `${c.track.toUpperCase()} DIVISION HITS LEVEL ${c.level}`,
  c => `QUIET GAINS: ${c.faction.toUpperCase()} ${c.track.toUpperCase()} UP`,
  c => `${c.faction.toUpperCase()} LOGS ${c.track.toUpperCase()} BREAKTHROUGH`,
  c => `SHORT BULLETIN: ${c.track.toUpperCase()} LEVEL ${c.level} FOR ${c.faction.toUpperCase()}`,
];

const TRADE_DELIVERED = [
  c => `A freighter from ${b(c.sender)} reached ${c.bodyLoc} today, delivering ${c.bundleText} to ${b(c.recipient)}.`,
  c => `Cargo confirmed: ${c.bundleText} from ${b(c.sender)} arrived safely at ${c.bodyLoc}, bound for ${b(c.recipient)}.`,
  c => `${b(c.recipient)} took delivery of ${c.bundleText} at ${c.bodyLoc}, shipped by ${b(c.sender)}.`,
  c => `Transit complete: ${b(c.sender)}'s freighter closed the loop with ${b(c.recipient)}, ${c.bundleText} unloaded at ${c.bodyLoc}.`,
  c => `${b(c.sender)}'s convoy made port at ${c.bodyLoc}, handing off ${c.bundleText} to ${b(c.recipient)}.`,
  c => `Logistics desk confirms: ${c.bundleText} landed at ${c.bodyLoc} for ${b(c.recipient)}, courtesy of ${b(c.sender)}.`,
  c => `No interception, no delay — ${c.bundleText} from ${b(c.sender)} reached ${b(c.recipient)} at ${c.bodyLoc}.`,
  c => `${b(c.recipient)}'s dockworkers signed for ${c.bundleText} out of ${b(c.sender)} at ${c.bodyLoc}.`,
  c => `Route held firm — ${b(c.sender)}'s freighter delivered ${c.bundleText} to ${b(c.recipient)} at ${c.bodyLoc}.`,
  c => `${c.bundleText} changed hands at ${c.bodyLoc}, completing the run between ${b(c.sender)} and ${b(c.recipient)}.`,
  c => `Supply lines held: a run from ${b(c.sender)} concluded at ${c.bodyLoc}, with ${c.bundleText} handed to ${b(c.recipient)}.`,
  c => `${b(c.sender)} completed its delivery obligation to ${b(c.recipient)}: ${c.bundleText}, unloaded at ${c.bodyLoc}.`,
  c => `Freight manifests show ${c.bundleText} arrived at ${c.bodyLoc}, closing the books on the ${b(c.sender)}-${b(c.recipient)} deal.`,
  c => `${b(c.recipient)} confirmed receipt of ${c.bundleText} at ${c.bodyLoc}, shipped in from ${b(c.sender)}.`,
  c => `Onboard manifest confirmed, ${b(c.sender)}'s freighter carrying ${c.bundleText} for ${b(c.recipient)} touched down at ${c.bodyLoc}.`,
  c => `Safe passage: ${b(c.sender)}'s shipment of ${c.bundleText} reached ${c.bodyLoc} and ${b(c.recipient)}'s waiting hands.`,
  c => `${b(c.sender)} and ${b(c.recipient)} settled their trade today — ${c.bundleText} unloaded at ${c.bodyLoc}.`,
  c => `Dock records at ${c.bodyLoc} list ${c.bundleText} inbound from ${b(c.sender)}, consigned to ${b(c.recipient)}.`,
  c => `${b(c.recipient)}'s ledgers close on the deal: ${c.bundleText} arrived at ${c.bodyLoc} from ${b(c.sender)}.`,
  c => `Another route cleared without loss — ${b(c.sender)}'s freighter delivered ${c.bundleText} to ${b(c.recipient)} at ${c.bodyLoc}.`,
];

const TRADE_DELIVERED_HEADLINE = [
  c => `CARGO ARRIVES AT ${c.body.toUpperCase()}`,
  c => `${c.sender.toUpperCase()} DELIVERY REACHES ${c.recipient.toUpperCase()}`,
  c => `FREIGHTER DOCKS AT ${c.body.toUpperCase()}`,
  c => `${c.recipient.toUpperCase()} TAKES DELIVERY FROM ${c.sender.toUpperCase()}`,
  c => `SHIPMENT LANDS AT ${c.body.toUpperCase()}`,
  c => `TRADE ROUTE CLEARS FOR ${c.sender.toUpperCase()}`,
  c => `${c.body.toUpperCase()} RECEIVES ${c.sender.toUpperCase()} CARGO`,
  c => `SAFE PASSAGE FOR ${c.sender.toUpperCase()} FREIGHTER`,
  c => `${c.recipient.toUpperCase()} CONFIRMS CARGO RECEIPT`,
  c => `DELIVERY COMPLETE AT ${c.body.toUpperCase()}`,
  c => `${c.sender.toUpperCase()} CARGO REACHES ${c.recipient.toUpperCase()}`,
  c => `DOCKS AT ${c.body.toUpperCase()} RECEIVE FREIGHT`,
  c => `${c.recipient.toUpperCase()} AND ${c.sender.toUpperCase()} CLOSE TRADE RUN`,
  c => `FREIGHT RUN ENDS AT ${c.body.toUpperCase()}`,
  c => `${c.sender.toUpperCase()} SHIPMENT REACHES ${c.body.toUpperCase()}`,
  c => `ROUTE HOLDS: CARGO REACHES ${c.recipient.toUpperCase()}`,
];


// ------------------------------------------------------------
// Research beats — the single most common event in the game (tech
// levels advance far more often than ships launch) and previously had
// no Herald voice at all. Deliberately routine-weight, same register as
// industry: this is background progress, never the headline.
// ------------------------------------------------------------

// Mirrors the TRACK_NAME map in worker/researchUnlocks.js lockedError —
// duplicated rather than imported because modules stay independent
// bundles by convention in this codebase (see worker/store.js header).
const TECH_TRACK_NAMES = {
  weapons: 'Weapons', armor: 'Defense', propulsion: 'Propulsion',
  construction: 'Construction', industry: 'Society', sensors: 'Sensors',
};

function buildTechStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    if (row.kind !== 'tech_advanced') continue;
    const p = safeJson(row.payload);
    const faction = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    const track = TECH_TRACK_NAMES[p.tech_id] ?? titleCase(String(p.tech_id ?? 'research').replace(/_/g, ' '));
    const level = Number(p.level) || 1;
    // Same "rarely the headline" register as industry — scales gently
    // with level so a faction closing in on Sensors 10 reads as a
    // bigger deal than their first point in Weapons, without ever
    // approaching battle weight.
    const weight = 25 + 2 * level;
    stories.push(mkStory(weight, used, 'tech_advanced', TECH_ADVANCED, 'tech_advanced_hl', TECH_ADVANCED_HEADLINE, { faction, track, level }));
  }
  return stories;
}

// ------------------------------------------------------------
// Trade delivery — the payoff of the logistics loop. trade_accepted
// (above) is the handshake; this is the freighter actually landing,
// which can in principle be intercepted along the way and wasn't.
// ------------------------------------------------------------

function buildTradeDeliveredStories(rows, used, factionNames, locator) {
  const stories = [];
  const nameOf = (id) => factionNames.get(id) ?? 'an unnamed faction';
  const fmtBundle = (p) => {
    const parts = [];
    if ((p.metal ?? 0) > 0)   parts.push(`${numWord(Math.round(p.metal))} metal`);
    if ((p.fuel ?? 0) > 0)    parts.push(`${numWord(Math.round(p.fuel))} fuel`);
    if ((p.gold ?? 0) > 0)    parts.push(`${numWord(Math.round(p.gold))} credits`);
    if ((p.science ?? 0) > 0) parts.push(`${numWord(Math.round(p.science))} science`);
    return parts.length ? parts.join(', ') : 'an empty hold';
  };
  // A delivery whose deal was already reported in this same edition is
  // the same event told twice — the reader gets "X and Y settled their
  // trade, 7000 science" and then, three lines later, "Y took delivery
  // of 7000 science". The deal is the story; the freight arriving is a
  // footnote to it. Report the arrival only when the deal itself fell
  // outside this window.
  const dealtPairs = new Set();
  for (const row of rows) {
    if (row.kind !== 'trade_accepted') continue;
    dealtPairs.add([row.actor_faction_id ?? '', row.target_faction_id ?? ''].sort().join(' '));
  }

  for (const row of rows) {
    if (row.kind !== 'trade_delivered') continue;
    const p = safeJson(row.payload);
    const pair = [p.sender_faction_id ?? row.actor_faction_id ?? '', p.recipient_faction_id ?? ''].sort().join(' ');
    if (dealtPairs.has(pair)) continue;
    const loc = locate(locator, row.body_id, p.body_name);
    const ctx = {
      sender: nameOf(p.sender_faction_id ?? row.actor_faction_id),
      recipient: nameOf(p.recipient_faction_id),
      bundleText: fmtBundle(p),
      bodyLoc: loc.full,
      body: loc.name,
    };
    // Below trade_accepted's own weight — the deal was already the
    // news; the delivery is confirmation, not a new agreement.
    stories.push(mkStory(45, used, 'trade_delivered', TRADE_DELIVERED, 'trade_delivered_hl', TRADE_DELIVERED_HEADLINE, ctx));
  }
  return stories;
}

// ------------------------------------------------------------
// Game start — fires exactly once, at tick 0, before any faction has
// done anything. No single-faction subject; it's the paper's opening
// edition, and it belongs in "History in the making" alongside VICTORY,
// the bookend it eventually gets written against.
// ------------------------------------------------------------

function buildGameStartedStories(rows, used, gameName) {
  const stories = [];
  for (const row of rows) {
    if (row.kind !== 'game_started') continue;
    const p = safeJson(row.payload);
    const factionCount = Array.isArray(p.factions) ? p.factions.length : 0;
    if (factionCount === 0) continue;
    const worldsPerPlayer = Number(p.starter_fleet?.worlds_per_player) || 0;
    const ctx = { gameName: gameName || 'Orbital', factionCount, worldsPerPlayer };
    // High enough to headline a quiet first edition, nowhere near
    // VICTORY (1000) or ELIMINATION (900) — this is a beginning, not
    // an ending.
    stories.push(mkStory(300, used, 'game_started', GAME_STARTED, 'game_started_hl', GAME_STARTED_HEADLINE, ctx));
  }
  return stories;
}

// ------------------------------------------------------------
// Fleet lifecycle — formation, a new flag captain, and the gap left
// when one is lost. Organizational news, same weight class as routine
// industry: real, but never the headline.
// ------------------------------------------------------------

function buildFleetLifecycleStories(rows, used, factionNames) {
  const stories = [];
  for (const row of rows) {
    const p = safeJson(row.payload);
    const actor = p.faction_name ?? factionNames.get(row.actor_faction_id) ?? 'A faction';
    if (row.kind === 'fleet_formed') {
      const shipCount = Number(p.ships) || 0;
      const flagCaptainClause = p.flag_captain ? `, under Captain ${b(p.flag_captain)}` : '';
      stories.push(mkStory(40, used, 'fleet_formed', FLEET_FORMED, 'fleet_formed_hl', FLEET_FORMED_HEADLINE, {
        actor, fleetName: p.fleet_name ?? 'an unnamed fleet', shipCount, flagCaptainClause,
      }));
    } else if (row.kind === 'fleet_flag_promoted') {
      if (!p.flag_captain) continue; // nothing to report without a name
      stories.push(mkStory(35, used, 'fleet_flag_promoted', FLEET_FLAG_PROMOTED, 'fleet_flag_promoted_hl', FLEET_FLAG_PROMOTED_HEADLINE, {
        actor, fleetName: p.fleet_name ?? 'an unnamed fleet', captainName: p.flag_captain,
      }));
    } else if (row.kind === 'fleet_flag_lost') {
      stories.push(mkStory(50, used, 'fleet_flag_lost', FLEET_FLAG_LOST, 'fleet_flag_lost_hl', FLEET_FLAG_LOST_HEADLINE, {
        actor, fleetName: p.fleet_name ?? 'an unnamed fleet',
      }));
    }
  }
  return stories;
}

function composeEmbed(gameName, tick, rows, factionNames, tradesDelta, locator, sanctions = []) {
  // bank-name -> { start, stride, k } walk state, plus the '__rng' the
  // walks are drawn from. Seeded off the edition's tick (and the game
  // name, so two matches publishing the same tick don't print the same
  // sentence shapes) — see makeRng for why this isn't Math.random.
  const used = new Map();
  let seed = tick * 2654435761;
  for (let i = 0; i < String(gameName ?? '').length; i++) {
    seed = (Math.imul(seed, 31) + String(gameName).charCodeAt(i)) | 0;
  }
  used.set('__rng', makeRng(seed));
  used.set('__spin', Math.abs(tick | 0));

  const captainFate = buildCaptainFateMap(rows);
  // Terraform beats split across two columns: begun/complete are
  // expansion news, the asteroid kill is a battle-page atrocity.
  const terraform = buildTerraformStories(rows, used, factionNames);
  const sections = {
    // Dyson beats merge into the existing columns: an attack on the
    // sphere IS a battle (and outweighs any ordinary engagement); its
    // founding and milestones are history in the making.
    victory:     [
      ...buildVictoryStories(rows, used, factionNames),
      ...buildDysonHistoryStories(rows, used, factionNames),
      ...buildGameStartedStories(rows, used, gameName),
    ],
    battles:     [
      ...buildDysonBattleStories(rows, used, factionNames),
      ...terraform.battles,
      ...buildBattleStories(rows, used, locator, captainFate),
    ],
    politics:    buildPoliticsStories(rows, used, factionNames),
    discoveries: buildDiscoveryStories(rows, used, locator, factionNames),
    colonies:    [
      ...terraform.colonies,
      ...buildColonyStories(rows, used, locator),
    ],
    trades:      [
      ...buildTradeStories(rows, used, factionNames),
      ...buildTradeDeliveredStories(rows, used, factionNames, locator),
    ],
    industry:    [
      ...buildIndustryStories(rows, used),
      ...buildFleetEconomyStories(rows, used, factionNames, locator),
      ...buildTechStories(rows, used, factionNames),
      ...buildFleetLifecycleStories(rows, used, factionNames),
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

  // A sanction in force is news even on an otherwise quiet day — it is
  // the whole reason this feature exists ("how much longer does the 2x
  // damage last?"). Without this the countdown would vanish on exactly
  // the slow days when a player most wants to check it.
  const sf = sanctionsField(sanctions, factionNames);
  if (!topStory && tradesDelta <= 0 && !sf) return null;

  // Pull the headline story out of its section so it isn't repeated
  // in the body — it's already "above the fold" in the description.
  if (topStory) {
    sections[topSection] = sections[topSection].filter(s => s !== topStory);
  }

  // The "…and N more incidents" line is a sign-off about the size of
  // the world beyond the page. Printed on all seven sections it read as
  // boilerplate; pinned to whichever section overflowed most, it landed
  // mid-document with three sections still to come, which reads as a
  // misplaced footer. It is one line, it covers the whole edition, and
  // it goes at the bottom — so it is totalled across every section and
  // appended once, to the last field rendered.
  const SECTION_ORDER = ['victory', 'battles', 'politics', 'discoveries', 'colonies', 'trades', 'industry'];
  let droppedTotal = 0;
  const fields = [];
  for (const key of SECTION_ORDER) {
    const field = fieldFromStories(SECTION_META[key].title, sections[key], used, { allowTail: false });
    if (field) {
      droppedTotal += Math.max(0, sections[key].length - field.shownCount);
      fields.push({ name: field.name, value: field.value });
    }
  }

  // Standing state, not events — appended after the story sections so
  // the paper reads news-first, then "still in force".
  if (sf) fields.push(sf);

  // The scoreboard the paper never had. Goes below the news, above the
  // sign-off — a reader who wants the state of the war can jump to it
  // without reading four battle reports to infer it.
  const standings = standingsField(rows, factionNames);
  if (standings) fields.push(standings);

  if (tradesDelta > 0) {
    fields.push({ name: '📦  Trade ledger', value: pickTemplate('trade_ledger', TRADE_LEDGER, used)({ count: tradesDelta }) });
  }

  // A war that ends gets a last word. Without this the final edition
  // of a ten-issue run closed on a routine note about an under-plated
  // destroyer, and a reader who had followed the whole match was left
  // without an ending — the single biggest complaint an outside reader
  // levelled at the paper.
  const closing = finalReckoningField(rows, factionNames);
  if (closing) fields.push(closing);

  // One sign-off for the whole edition, on the last field, where a
  // footer belongs.
  if (droppedTotal >= 2 && fields.length > 0) {
    const tail = pickTemplate('more_incidents_tail', MORE_INCIDENTS_TAIL, used)(droppedTotal, droppedTotal === 1 ? '' : 's');
    const last = fields[fields.length - 1];
    if (last.value.length + 2 + tail.length <= FIELD_VALUE_LIMIT) {
      last.value += `\n\n${tail}`;
    }
  }

  const masthead = `🗞️ **THE ORBITAL HERALD** · ${gameName} · T+${tick}`;
  const title = topStory ? topStory.headline : pickTemplate('quiet_hl', QUIET_DAY_HEADLINE, used)();
  const deck = topStory ? topStory.text : pickTemplate('quiet_body', QUIET_DAY_BODY, used)();
  const description = `${masthead}\n\n${deck}`;

  const color = (topSection && SECTION_META[topSection]) ? SECTION_META[topSection].color : SECTION_META.colonies.color;

  // Short names are applied LAST, over the finished text: "first
  // mention" is a property of reading order, which only exists once the
  // headline has been pulled and the sections laid out.
  return applyShortNames({
    title,
    description,
    color,
    fields,
    footer: { text: 'Daily digest · The Orbital Herald' },
    timestamp: new Date().toISOString(),
  }, factionNames);
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
export async function runDigestForGame(env, game, { force = false, final = false } = {}) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return { posted: false, events: 0, reason: 'webhook_not_configured' };

  // Sim / load-test / QA rooms tick away in prod alongside the real
  // match, and every one of them was filing editions to the same
  // channel. No Discord-linked player in the game means no audience for
  // an edition about it. A FORCED run (the host's "Publish Herald Now")
  // still publishes — a human explicitly asked for that one.
  if (!force) {
    try {
      const discord = await import('./discord.js');
      if (!(await discord.gameHasDiscordAudience(env, game.id))) {
        return { posted: false, events: 0, reason: 'no_discord_audience' };
      }
    } catch { /* fail open — a real edition matters more */ }
  }

  const now = Date.now();
  const state = await env.DB
    .prepare('SELECT last_digest_ms, last_entry_ms, trades_snapshot FROM digest_state WHERE game_id = ?')
    .bind(game.id)
    .first();
  const lastDigestMs = state?.last_digest_ms ?? 0;
  if (!force && !final && now - lastDigestMs < MIN_INTERVAL_MS) {
    return { posted: false, events: 0, reason: 'already_ran_today' };
  }

  // Forced (button) editions: always the trailing 12h from right now.
  // Scheduled (cron) editions: incremental — since the last edition's
  // high-water mark, falling back to a 24h lookback on the very first run.
  // FINAL editions publish EVERYTHING still unpublished, and skip the
  // once-a-day guard. A match ends once, so its last edition cannot use
  // the forced button's rolling 12h window — measured on the real case:
  // a forced publish would have carried the victory but silently dropped
  // 11.5h of the game's final day, and two hours later would have
  // dropped the victory too. Incremental window, no interval guard.
  const sinceMs = final
    ? (state?.last_entry_ms || (now - FIRST_RUN_LOOKBACK_MS))
    : force
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

  const sanctions = await activeSanctions(env, game.id, game.current_tick ?? 0);
  let embed = composeEmbed(game.name ?? game.id, game.current_tick ?? 0, rows, factionNames, tradesDelta, locator, sanctions);

  // Forced editions always publish — a quiet day (no stories, no
  // trades) still gets a headline-styled "all quiet" bulletin so the
  // host's test button visibly works.
  if (!embed && (force || final)) {
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

  // ---- territory strip ---------------------------------------------------
  // Attach the ownership chart when we can render one. Two paths, and the
  // Herald publishes either way — a missing image must never cost the
  // edition.
  const stripUrl = STRIP_PUBLIC_URL(env, game.id);
  let stripPng = null;
  try {
    stripPng = await renderStripPng(env, game.id, { width: 550, height: 440 });
  } catch (e) {
    console.error('herald strip render failed', e);
  }
  if (stripPng) {
    // attachment:// resolves against the multipart file posted alongside.
    embed = { ...embed, image: { url: 'attachment://territory.png' } };
  } else if (stripUrl) {
    // Rasterising is self-contained, so this branch means something
    // genuinely broke. Link the live chart rather than dropping the
    // territory report entirely — the edition still goes out.
    embed = {
      ...embed,
      fields: [
        ...(embed.fields ?? []),
        { name: 'Territory', value: `[View the current map](${stripUrl})` },
      ],
    };
  }

  let res;
  if (stripPng) {
    // Discord takes the embed as a `payload_json` part with the image as
    // a sibling file part. FormData sets its own multipart boundary, so
    // we must NOT set content-type ourselves here.
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ embeds: [embed] }));
    form.append('files[0]', new Blob([stripPng], { type: 'image/png' }), 'territory.png');
    res = await fetch(webhook, { method: 'POST', body: form });
  } else {
    res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  }
  if (!res.ok) {
    console.error(`digest webhook post failed for ${game.id}: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, events: rows.length, reason: `webhook_${res.status}` };
  }
  return { posted: true, events: rows.length };
}

/**
 * READ-ONLY edition composer for the IN-GAME herald reader (P4 polish:
 * the digest was Discord-only — players inside the game had no access
 * to the newspaper being written about their war). Same clustering,
 * weights, and phrase banks as the Discord edition over a trailing
 * window, but: no webhook post, no digest_state mutation (the Discord
 * cadence is untouched), and a quiet day still returns a readable
 * "all quiet" edition instead of null. Public chronicle rows only, so
 * it leaks nothing the Discord channel wouldn't.
 */
export async function composeHeraldForGame(env, game, lookbackMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const sinceMs = now - lookbackMs;
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

  // No trades-delta bookkeeping here — that snapshot belongs to the
  // Discord edition's incremental state and must not be disturbed.
  const sanctions = await activeSanctions(env, game.id, game.current_tick ?? 0);
  let embed = composeEmbed(game.name ?? game.id, game.current_tick ?? 0, rows, factionNames, 0, locator, sanctions);
  if (!embed) {
    const used = new Map();
    embed = {
      title: pickTemplate('quiet_hl', QUIET_DAY_HEADLINE, used)(),
      description: `🗞️ **THE ORBITAL HERALD** · ${game.name ?? game.id} · T+${game.current_tick ?? 0}\n\n${pickTemplate('quiet_body', QUIET_DAY_BODY, used)()}`,
      fields: [],
    };
  }
  return {
    title: embed.title ?? '',
    description: embed.description ?? '',
    fields: (embed.fields ?? []).map(f => ({ name: f.name, value: f.value })),
    tick: game.current_tick ?? 0,
    generated_at_ms: now,
    window_hours: Math.round(lookbackMs / 3600000),
  };
}

/**
 * Admin preview: compose a Herald edition from a TICK range rather than
 * a wall-clock lookback. composeHeraldForGame anchors to Date.now(),
 * which is exactly wrong for previewing a completed game's history —
 * "now minus 24h" finds nothing in a match that ended months ago.
 * Chronicle rows carry tick_number directly (indexed), so this filters
 * on that instead and otherwise reuses composeEmbed byte for byte —
 * whatever this renders is provably what the real edition would have
 * looked like at that point in the game.
 *
 * Read-only: never touches digest_state, so it cannot disturb the
 * live Discord cadence no matter how often an admin calls it.
 */
export async function composeHeraldForTickRange(env, game, fromTick, toTick) {
  // DESC + re-reverse, not ASC + LIMIT: composeHeraldForGame's 200-row
  // cap is tuned for its actual live cadence (a ~20-24h rolling window
  // rarely holds that many events), but an admin-chosen tick range can
  // legitimately span a chaotic endgame — a 44-tick slice of a real
  // completed match hit 418 public rows. ORDER BY ... ASC LIMIT 200
  // silently drops the TAIL of the window, which is exactly where a
  // victory or elimination row sits. Ordering DESC and reversing after
  // the fact means truncation (if it ever happens at this raised cap)
  // drops the OLDEST events instead — the ones least likely to be why
  // an admin picked this window in the first place.
  const rowsDesc = (await env.DB
    .prepare(
      `SELECT kind, actor_faction_id, target_faction_id, body_id, payload, created_at_ms, tick_number
         FROM chronicle_entries
        WHERE game_id = ? AND tick_number > ? AND tick_number <= ? AND visibility = 'public'
        ORDER BY tick_number DESC, id DESC
        LIMIT 500`,
    )
    .bind(game.id, fromTick, toTick)
    .all()).results ?? [];
  const rows = rowsDesc.slice().reverse();

  const factions = (await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
    .bind(game.id)
    .all()).results ?? [];
  const factionNames = new Map(factions.map(f => [f.id, f.name]));
  const locator = await buildBodyLocator(env, game.id, collectBodyIds(rows));

  let embed = composeEmbed(game.name ?? game.id, toTick, rows, factionNames, 0, locator, []);
  if (!embed) {
    const used = new Map();
    embed = {
      title: pickTemplate('quiet_hl', QUIET_DAY_HEADLINE, used)(),
      description: `🗞️ **THE ORBITAL HERALD** · ${game.name ?? game.id} · T+${toTick}\n\n${pickTemplate('quiet_body', QUIET_DAY_BODY, used)()}`,
      fields: [],
    };
  }
  return {
    title: embed.title ?? '',
    description: embed.description ?? '',
    fields: (embed.fields ?? []).map(f => ({ name: f.name, value: f.value })),
    from_tick: fromTick,
    to_tick: toTick,
    row_count: rows.length,
  };
}

/**
 * Entry point — called from the every-minute cron. Cheap early-outs:
 * no webhook secret, wrong hour, or already digested recently.
 */
/**
 * Publish a game's FINAL edition immediately, the moment it is won.
 *
 * The daily-sweep fix above guarantees the victory edition eventually
 * posts, but "eventually" is up to 24h — and the end of a match is the
 * one story nobody wants to read tomorrow. This runs the same Herald
 * with force:true (12h trailing window, skips the once-a-day interval
 * guard), so the win posts as the headline while people are still
 * looking at it.
 *
 * Safe to call twice: runDigestForGame advances last_entry_ms, so the
 * cron sweep's EXISTS clause then finds nothing left to publish.
 *
 * NEVER throws. It is called from the tick's victory path, and a Discord
 * outage must not stop a game from being marked won.
 */
export async function publishFinalEdition(env, gameId) {
  try {
    if (!env.DISCORD_DIGEST_WEBHOOK) return;
    const game = await env.DB
      .prepare(`SELECT g.id, g.current_tick, r.name
                  FROM games g JOIN rooms r ON r.id = g.id
                 WHERE g.id = ?`)
      .bind(gameId)
      .first();
    if (!game) return;
    await runDigestForGame(env, game, { final: true });
  } catch (e) {
    console.error('publishFinalEdition failed', e);
  }
}

export async function maybeRunDailyDigest(env) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return;                              // feature off

  const now = Date.now();
  // Hour and master switch are now runtime settings, so the Herald can be
  // rescheduled or paused from the control panel without a deploy.
  try {
    const cfg = await (await import('./botSettings.js')).getSettings(env);
    if (!cfg.herald_enabled) return;
    if (!(await import('./botSettings.js')).isEasternHour(now, cfg.herald_hour_eastern)) return;
  } catch {
    if (!isEasternDigestHour(now)) return;            // settings unavailable
  }

  // Active games, PLUS any completed game still holding unpublished
  // entries.
  //
  // `status = 'active'` alone orphaned every game's final edition. A
  // victory flips status to 'completed' in the same tick it is written
  // to the chronicle, so the batch containing the win — and, for a
  // chancellor victory, the senate vote that caused it — could never be
  // selected again. Live case: game FY2Ab2s47dsP ended at T+441 with 148
  // unpublished entries including its `victory` row; the Herald had run
  // 13h earlier and simply never came back for them. The most important
  // edition of a match was the one guaranteed to be lost.
  //
  // The EXISTS clause self-terminates: runDigestForGame advances
  // last_entry_ms whether or not it posts, so a completed game yields
  // exactly one final edition and is never selected again.
  const games = (await env.DB
    .prepare(`SELECT g.id, g.current_tick, r.name
                FROM games g
                JOIN rooms r ON r.id = g.id
                LEFT JOIN digest_state d ON d.game_id = g.id
               WHERE g.status = 'active'
                  OR (g.status = 'completed'
                      AND EXISTS (SELECT 1 FROM chronicle_entries c
                                   WHERE c.game_id = g.id
                                     AND c.visibility = 'public'
                                     AND c.created_at_ms > COALESCE(d.last_entry_ms, 0)))`)
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
