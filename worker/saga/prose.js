// ============================================================================
// saga/prose.js — the Saga Engine's word machinery.
//
// The same discipline as the Herald (worker/digest.js), for the same
// reasons, and no model anywhere: every sentence is a hand-written template
// with holes, and every choice between templates is DETERMINISTIC, so the
// same match always gets the same film and a change in the output is a
// change in the code, never in the dice.
//
//   * A seeded generator per film (mulberry32, the Herald's makeRng).
//   * A WALK through each bank instead of a draw: a permutation keyed to
//     the film's seed and the bank's name, advanced once per use, so no
//     line repeats inside a film until its bank is spent.
//   * A FILM ORDINAL, the Herald's edition counter: the nth film the
//     engine ever wrote enters every bank at a different point, so two
//     matches finishing back to back never open the same way.
//   * Subject-keyed picks: a line chosen by an empire's id keeps that
//     empire's voice the same everywhere it appears.
//   * Claims are checked against the numbers: big words only when the
//     numbers carry them (the Herald's HEADLINE_SUPERLATIVES).
// ============================================================================

/** mulberry32: small, fast, and identical everywhere it runs. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Avalanche mixer: inputs on a cadence stop producing outputs on one. */
export function mix32(x) {
  let h = (x | 0) + 0x9e3779b9 | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return Math.abs(h ^ (h >>> 15));
}

/** Stable hash of a string. */
export function hashOf(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a; }

/** A step coprime to n, so (start + k*step) % n visits every entry once. */
function strideFor(n, salt) {
  if (n < 3) return 1;
  const want = 1 + (mix32(salt) % (n - 1));
  for (let s = want; s < want + n; s++) {
    const c = ((s - 1) % (n - 1)) + 1;
    if (gcd(c, n) === 1) return c;
  }
  return 1;
}

/**
 * The walker: one per film. `pick(bankName, bank)` returns the next entry
 * of that bank's permutation; the permutation and its entry point are fixed
 * by (seed, ordinal, bankName). `pickFor(subject, ...)` keys the entry to a
 * subject instead, so an empire always speaks in the same register.
 * Exact sentences are never printed twice in one film (`seen`).
 */
export class Walker {
  constructor(seed, ordinal = 0) {
    this.seed = seed >>> 0;
    this.ordinal = Math.max(0, ordinal | 0);
    this.cursors = new Map();
    this.seen = new Set();
  }

  /**
   * A bank's walk: a fixed permutation (start + i*step) for this bank, and
   * the WINDOW this film reads from it. Film k begins k*advance places along
   * the permutation, advance coprime with the bank's length and at least
   * two, so consecutive films read disjoint windows (a film draws one or two
   * lines from most banks) and the whole bank is used before any line
   * repeats across films. (A raw `ordinal * step` is a multiple of `step`,
   * and in a three-line bank every film opened on the same line.)
   */
  _order(name, n) {
    // ONE permutation per bank for every film (not seeded by the game), so
    // the films' windows tile it instead of landing at random.
    const start = mix32(hashOf(name)) % n;
    const step = strideFor(n, hashOf(name) + 7);
    let advance = 2;
    while (n > 2 && gcd(advance, n) !== 1) advance++;
    return { start, step, offset: n > 1 ? (this.ordinal * advance) % n : 0 };
  }

  /** The next unused entry of a bank (a function or a string). */
  pick(name, bank, ok = () => true) {
    if (!bank?.length) return null;
    const n = bank.length;
    const { start, step, offset } = this._order(name, n);
    let k = this.cursors.get(name) ?? 0;
    for (let tries = 0; tries < n; tries++, k++) {
      const entry = bank[(start + ((offset + k) % n) * step) % n];
      if (!ok(entry)) continue;
      this.cursors.set(name, k + 1);
      return entry;
    }
    this.cursors.set(name, k);
    return null;
  }

  /** An entry keyed to a subject (an empire, a captain). */
  pickFor(subject, name, bank, ok = () => true) {
    if (!bank?.length) return null;
    const n = bank.length;
    for (let hop = 0; hop < n; hop++) {
      const entry = bank[(mix32(hashOf(`${name}:${subject}`) + hop * 2654435761 + this.ordinal) % n)];
      if (ok(entry)) return entry;
    }
    return null;
  }

  /**
   * Render a template with its context, refusing an exact sentence already
   * printed in this film and one whose claims the context denies; walks on
   * to the next entry when refused. Returns '' if nothing in the bank fits.
   */
  say(name, bank, ctx, { subject = null, claims = null } = {}) {
    const tried = new Set();
    for (let i = 0; i < (bank?.length ?? 0); i++) {
      const tpl = subject != null
        ? this.pickFor(subject, name, bank, t => !tried.has(t))
        : this.pick(name, bank, t => !tried.has(t));
      if (tpl == null) break;
      tried.add(tpl);
      const text = tidy(typeof tpl === 'function' ? tpl(ctx) : String(tpl));
      if (!text || this.seen.has(text)) continue;
      if (claims && overclaims(text, claims)) continue;
      this.seen.add(text);
      return text;
    }
    return '';
  }
}

/** Collapse doubled spaces and spaces before punctuation. */
export function tidy(s) {
  // Only a stray space between a word and its punctuation: names like
  // ":) Smiley Face Friends :)" keep theirs.
  // A name ending in s takes a bare apostrophe: "Wonks'", not "Wonks's".
  return String(s ?? '').replace(/\s+/g, ' ').replace(/(\w)\s+([,.;!?])(?=\s|$)/g, '$1$2')
    .replace(/([A-Za-z]s)'s\b/g, "$1'").trim();
}

// ---------------------------------------------------------------------------
// Claims. A sentence with holes can be true of its numbers and still lie
// ("the worst" on a tie). These are the Herald's two guards, for the words
// the saga banks use.
// ---------------------------------------------------------------------------

/** Big words and the casualties they need (the Herald's ladder). */
const SUPERLATIVES = [
  [/\b(annihilat|wiped out|no survivors|massacre|erased)/i, 10],
  [/\b(crush|slaughter|bloodbath|gutted|decimated|catastroph)/i, 7],
  [/\b(routed|shatter|butcher)/i, 5],
  [/\b(costly|brutal|bloody|savage|punishing)/i, 4],
];
const CLAIM_RULES = [
  { flag: 'strictExtreme', re: /\b(the worst|hardest|heaviest|biggest|largest|most of anyone|richest|deadliest)\b/i },
  { flag: 'whole', re: /\b(every (empire|flag|world|fleet)|all of them|nobody else|no one else)\b/i },
];

/** True when `text` asserts more than `claims` allows. */
export function overclaims(text, claims) {
  if (Number.isFinite(claims.losses)) {
    for (const [re, floor] of SUPERLATIVES) if (re.test(text) && claims.losses < floor) return true;
  }
  for (const r of CLAIM_RULES) if (claims[r.flag] === false && r.re.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Numbers and names in words.
// ---------------------------------------------------------------------------

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** Small numbers in words, larger ones as figures with separators. */
export function numWord(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 0 && v < SMALL.length ? SMALL[v] : v.toLocaleString('en-US');
}
export const cap = (s) => { const t = String(s ?? ''); return t ? t[0].toUpperCase() + t.slice(1) : t; };
export const plural = (n, one, many = `${one}s`) => (Math.abs(Number(n)) === 1 ? one : many);
/** "A, B and C". */
export function listOf(names) {
  const a = names.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
/** More than half, half, most... a fraction in words a crawl can use. */
export function shareWord(k, n) {
  if (n <= 0) return '';
  const f = k / n;
  if (f >= 1) return 'every one';
  if (f > 0.5) return 'more than half';
  if (f === 0.5) return 'half';
  if (f >= 0.3) return 'a third or more';
  return `${numWord(k)} of ${numWord(n)}`;
}
