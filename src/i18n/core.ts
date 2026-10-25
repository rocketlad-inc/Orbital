// ============================================================
// Translation core.
//
// English is the SOURCE language (src/i18n/en.ts): every string is
// written there first, under a key, and the other catalogs translate
// the same keys. A key a catalog lacks falls back to English, so a
// half-translated screen is readable rather than broken, and
// src/i18n/__tests__/catalogs.test.ts fails the build if a catalog
// has a key English does not, or uses different {placeholders}.
//
//   t('lobby.nav.browse')                    plain
//   t('lobby.hero.welcome', { name })        "Welcome back, {name}"
//   tn('card.seatsLeft', 3)                  plural: card.seatsLeft_one /
//                                            card.seatsLeft_other (CLDR
//                                            rules for the language, except
//                                            zero is always plural: "0 mundos")
//
// Which language: the player's own choice (kept in this browser and, once
// signed in, on their account so it follows them to the phone app), else
// the browser's language, else English.
//
// Adding a language: add it to LANGS, add src/i18n/<code>.ts typed as
// Catalog, and import it in CATALOGS below. Nothing else changes.
// ============================================================

import { en } from './en';
import { ptBR } from './pt-BR';

export type Lang = 'en' | 'pt-BR';
export type Key = keyof typeof en;
export type Catalog = Partial<Record<Key, string>>;

/** Name each language writes about ITSELF: the picker must be readable
 *  by someone who cannot read the current language. */
export const LANGS: Array<{ code: Lang; name: string; short: string }> = [
  { code: 'en', name: 'English', short: 'EN' },
  { code: 'pt-BR', name: 'Português (Brasil)', short: 'PT' },
];

const CATALOGS: Record<Lang, Catalog> = { en, 'pt-BR': ptBR };

const STORAGE_KEY = 'orbital.lang';

export function isLang(x: unknown): x is Lang {
  return x === 'en' || x === 'pt-BR';
}

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch { /* blocked storage: fall through */ }
  try {
    for (const l of navigator.languages ?? [navigator.language]) {
      if (/^pt\b/i.test(l ?? '')) return 'pt-BR';
      if (/^en\b/i.test(l ?? '')) return 'en';
    }
  } catch { /* no navigator (tests, SSR) */ }
  return 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang { return current; }

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Switch language. `persist` writes it to this browser; the picker also
 *  saves it on the account (see LanguageSwitch). */
export function setLang(lang: Lang, persist = true): void {
  if (lang === current) return;
  current = lang;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  }
  try { document.documentElement.lang = lang; } catch { /* no document */ }
  listeners.forEach(fn => fn());
}

try { document.documentElement.lang = current; } catch { /* no document */ }

/** A number filling a {placeholder}: a fraction takes the language's
 *  decimal mark (2.4 reads "2,4" in Portuguese). Whole numbers stay as
 *  they are, so a tick ("T+1500") or a year never gains a separator; a
 *  caller wanting thousands grouping passes fmtNumber(n). */
function varText(v: string | number, lang: Lang): string {
  if (typeof v !== 'number' || Number.isInteger(v) || !Number.isFinite(v) || lang === 'en') return String(v);
  return String(v).replace('.', decimalMark(lang));
}
function decimalMark(lang: Lang): string {
  return lang === 'pt-BR' ? ',' : '.';
}

function fill(s: string, vars: Record<string, string | number> | undefined, lang: Lang): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? varText(vars[k], lang) : m));
}

function lookup(key: string, lang: Lang): string {
  const own = (CATALOGS[lang] as Record<string, string | undefined>)[key];
  if (own != null) return own;
  return (en as Record<string, string>)[key] ?? key;
}

/** Translate `key`, filling {placeholders}. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  return fill(lookup(key, current), vars, current);
}

/** `t` for an EXPLICIT language instead of the player's current one. For
 *  text that must be built in a language other than the one on screen (the
 *  event-log headlines are built twice: once in English for the audit log
 *  and the classifiers, once in the player's language for display). */
export function tIn(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  return fill(lookup(key, lang), vars, lang);
}

/** `tk` for an explicit language: a run-time key with an English fallback. */
export function tkIn(lang: Lang, key: string, english: string, vars?: Record<string, string | number>): string {
  const own = (CATALOGS[lang] as Record<string, string | undefined>)[key];
  return fill(own ?? english, vars, lang);
}

/** Translate a key that is built at run time (`data.tech.${id}.name`) or
 *  that lives next to the data it names. `english` is what shows when the
 *  language is English or the catalog has no entry, so adding a new tech,
 *  ship or world never leaves a blank. Static strings should use t(). */
export function tk(key: string, english: string, vars?: Record<string, string | number>): string {
  const own = (CATALOGS[current] as Record<string, string | undefined>)[key];
  return fill(own ?? english, vars, current);
}

/** The plural category for `n` in `lang`. CLDR files Portuguese 0 under
 *  "one", but Brazilians write "0 estações", "0 naves": "0 estação" read as a
 *  typo to a Brazilian tester (2026-10-24). So zero takes the plural here,
 *  in every language this game speaks. */
export function pluralRule(lang: Lang, n: number): string {
  if (n === 0) return 'other';
  return new Intl.PluralRules(lang).select(n);
}

/** Keys that have plural forms, named without the _one/_other suffix. */
export type PluralKey = Extract<Key, `${string}_other`> extends `${infer B}_other` ? B : never;

/** Translate a counted phrase. `{n}` is filled in automatically. */
export function tn(key: PluralKey, n: number, vars?: Record<string, string | number>): string {
  return tnIn(current, key, n, vars);
}

/** `tn` for an explicit language (same plural rules and fallbacks). */
export function tnIn(lang: Lang, key: PluralKey, n: number, vars?: Record<string, string | number>): string {
  const rule = pluralRule(lang, n);   // zero|one|two|few|many|other
  const pick = (r: string) => (CATALOGS[lang] as Record<string, string | undefined>)[`${key}_${r}`];
  const s = pick(rule) ?? (en as Record<string, string>)[`${key}_${rule}`]
    ?? pick('other') ?? (en as Record<string, string>)[`${key}_other`] ?? String(key);
  return fill(s, { n: fmtNumberIn(lang, n), ...vars }, lang);
}

/** Building an Intl.NumberFormat costs far more than using one, and these
 *  run while rendering (and on the map, every frame): one per language and
 *  option set. */
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
function numberFormat(lang: Lang, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = opts ? `${lang}|${JSON.stringify(opts)}` : lang;
  let f = NUMBER_FORMATS.get(key);
  if (!f) { f = new Intl.NumberFormat(lang, opts); NUMBER_FORMATS.set(key, f); }
  return f;
}

/** 7.5 reads "7,5" in Portuguese. */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return numberFormat(current, opts).format(n);
}

/** `fmtNumber` for an explicit language. */
export function fmtNumberIn(lang: Lang, n: number, opts?: Intl.NumberFormatOptions): string {
  return numberFormat(lang, opts).format(n);
}

/** `n.toFixed(digits)` for the screen, in the player's language: 0.92 is
 *  "0,92" and 1.375 "1,375" in Portuguese. Use it for every decimal a
 *  player reads; keep toFixed for CSS, SVG and ids. */
export function fmtFixed(n: number, digits: number): string {
  return numberFormat(current, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Up to `digits` decimals, trailing zeros dropped: Math.round(v * 10) / 10
 *  for the screen ("2,4", "3"). */
export function fmtDecimal(n: number, digits = 1): string {
  return numberFormat(current, { maximumFractionDigits: digits }).format(n);
}

/** "2 days ago", "yesterday": the browser already knows every language's
 *  words for these, so they are not in the catalogs. */
export function relativeTime(deltaMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(current, { numeric: 'auto', style: 'short' });
  const s = Math.round(deltaMs / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/** For the tests: every catalog, by language. */
export function catalogs(): Record<Lang, Catalog> { return CATALOGS; }
