// ============================================================================
// i18n.js — the server's half of the language option.
//
// The app translates itself in src/i18n; this is the same idea for the
// words the WORKER writes: emails now, Discord messages and push alerts
// next. English is the source. A locale catalog may leave a key out, and
// the English line shows instead, so a half-translated catalog degrades to
// English rather than to a blank.
//
// A player's language lives on users.locale (null = never chose; the app
// follows the device). Anything the server says TO a person (an email, a
// DM, a push) reads that column. A Discord slash command is the exception:
// Discord tells us the language of the person typing (interaction.locale),
// and that wins for the reply.
//
// Keep LOCALES in step with src/i18n/core.ts (LANGS).
// ============================================================================

import { EN } from './i18n/en.js';
import { PT_BR } from './i18n/pt-BR.js';

export const LOCALES = ['en', 'pt-BR'];
export const DEFAULT_LOCALE = 'en';

const CATALOGS = { en: EN, 'pt-BR': PT_BR };

/**
 * Anything a person or a client might send -> a supported locale, or null.
 * 'pt', 'pt-br', 'pt_BR', 'pt-PT' all land on pt-BR (the only Portuguese we
 * write); 'en-GB', 'en_US' land on 'en'. Unknown languages are null, so a
 * caller can tell "no preference" from "English".
 */
export function normalizeLocale(x) {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase().replace('_', '-');
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'pt' || s.startsWith('pt-')) return 'pt-BR';
  return null;
}

/** The locale to write in: the stored one, else whatever the caller knows
 *  (a request's language), else English. */
export function pickLocale(...candidates) {
  for (const c of candidates) {
    const n = normalizeLocale(c);
    if (n) return n;
  }
  return DEFAULT_LOCALE;
}

/** The first supported language in an Accept-Language header, or null. */
export function localeFromAcceptLanguage(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const n = normalizeLocale(part.split(';')[0]);
    if (n) return n;
  }
  return null;
}

function fill(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** One line in a locale, `{name}` placeholders filled from `vars`. */
export function tr(locale, key, vars) {
  const loc = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const s = CATALOGS[loc]?.[key] ?? EN[key];
  return s == null ? key : fill(s, vars);
}

/** A count-sensitive line: tries `key_one` / `key_other` (Intl.PluralRules,
 *  so Portuguese counts 0 as singular, as Portuguese does). `{n}` is set. */
export function trn(locale, key, n, vars) {
  const loc = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const cat = new Intl.PluralRules(loc).select(n);
  const k = `${key}_${cat === 'one' ? 'one' : 'other'}`;
  return tr(loc, k, { n, ...vars });
}

/** The two catalogs, for the parity test. */
export function catalogs() {
  return CATALOGS;
}
