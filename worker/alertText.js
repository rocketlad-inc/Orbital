// ============================================================================
// alertText.js — the few game words that notification text shares.
//
// A resource and a treaty are named inside many sentences (a trade offer's
// "They give you", the market's "Gives:", a war announcement). They come
// from the catalog (alert.res.*, alert.pact.*) so a Portuguese sentence
// says "créditos" and "pacto de defesa" instead of splicing in English.
// An id with no catalog line falls back to the id itself.
// ============================================================================

import { tr } from './i18n.js';

/** 'metal' | 'fuel' | 'gold' | 'science' -> the word a player reads. */
export function resWord(locale, key) {
  const k = `alert.res.${key}`;
  const s = tr(locale, k);
  return s === k ? String(key) : s;
}

/** 'nap' | 'defense_pact' | ... -> 'nap' | 'defense pact' (English). */
export function pactName(locale, kind) {
  const k = `alert.pact.${kind}`;
  const s = tr(locale, k);
  return s === k ? String(kind).replace(/_/g, ' ') : s;
}

/** A number with the grouping a language expects (1,234 / 1.234). */
export function fmtN(locale, n) {
  return Math.round(Number(n) || 0).toLocaleString(locale === 'pt-BR' ? 'pt-BR' : 'en-US');
}
