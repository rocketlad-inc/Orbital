// ============================================================
// Text the WORKER wrote, in the language on screen.
//
// Some server payloads carry their own translations next to the English
// (worker/senate.js lawI18n: `{ name, effect, i18n: { 'pt-BR': { name,
// effect } } }`). The words still live in one place, the worker
// catalogs; the client only picks the copy for the current language, so a
// switch mid-game needs no refetch. Call it at RENDER time, inside a
// component that uses useI18n(), never when the payload is stored.
// ============================================================

import { getLang } from './core';

/** `base` with every non-null field of its current-language copy (its
 *  `i18n[lang]`) laid over it. */
export function inLang<T extends { i18n?: Record<string, object | undefined> | null }>(base: T): T {
  const own = base.i18n?.[getLang()];
  if (!own) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(own)) if (v != null) out[k] = v;
  return out as T;
}
