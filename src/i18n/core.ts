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
//                                            rules for the language, so
//                                            Portuguese counts 0 as "one")
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

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function lookup(key: string, lang: Lang): string {
  const own = (CATALOGS[lang] as Record<string, string | undefined>)[key];
  if (own != null) return own;
  return (en as Record<string, string>)[key] ?? key;
}

/** Translate `key`, filling {placeholders}. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  return fill(lookup(key, current), vars);
}

/** `t` for an EXPLICIT language instead of the player's current one. For
 *  text that must be built in a language other than the one on screen (the
 *  event-log headlines are built twice: once in English for the audit log
 *  and the classifiers, once in the player's language for display). */
export function tIn(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  return fill(lookup(key, lang), vars);
}

/** `tk` for an explicit language: a run-time key with an English fallback. */
export function tkIn(lang: Lang, key: string, english: string, vars?: Record<string, string | number>): string {
  const own = (CATALOGS[lang] as Record<string, string | undefined>)[key];
  return fill(own ?? english, vars);
}

/** Translate a key that is built at run time (`data.tech.${id}.name`) or
 *  that lives next to the data it names. `english` is what shows when the
 *  language is English or the catalog has no entry, so adding a new tech,
 *  ship or world never leaves a blank. Static strings should use t(). */
export function tk(key: string, english: string, vars?: Record<string, string | number>): string {
  const own = (CATALOGS[current] as Record<string, string | undefined>)[key];
  return fill(own ?? english, vars);
}

/** Keys that have plural forms, named without the _one/_other suffix. */
export type PluralKey = Extract<Key, `${string}_other`> extends `${infer B}_other` ? B : never;

/** Translate a counted phrase. `{n}` is filled in automatically. */
export function tn(key: PluralKey, n: number, vars?: Record<string, string | number>): string {
  return tnIn(current, key, n, vars);
}

/** `tn` for an explicit language (same plural rules and fallbacks). */
export function tnIn(lang: Lang, key: PluralKey, n: number, vars?: Record<string, string | number>): string {
  const rule = new Intl.PluralRules(lang).select(n);   // zero|one|two|few|many|other
  const pick = (r: string) => (CATALOGS[lang] as Record<string, string | undefined>)[`${key}_${r}`];
  const s = pick(rule) ?? (en as Record<string, string>)[`${key}_${rule}`]
    ?? pick('other') ?? (en as Record<string, string>)[`${key}_other`] ?? String(key);
  return fill(s, { n: fmtNumberIn(lang, n), ...vars });
}

/** 7.5 reads "7,5" in Portuguese. */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(current, opts).format(n);
}

/** `fmtNumber` for an explicit language. */
export function fmtNumberIn(lang: Lang, n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang, opts).format(n);
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
