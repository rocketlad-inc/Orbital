// React side of the translation core: a hook that re-renders the
// calling component when the language changes, and the language picker.

import React, { useEffect, useReducer } from 'react';
import './i18n.css';
import { LANGS, Lang, getLang, setLang, subscribeLang, t, tn } from './core';

/** Use in any component that shows text: it re-renders on a language
 *  change. Returns { t, tn, lang }. (Plain `t` from core also works,
 *  but only a component using this hook updates when the language
 *  flips.) */
export function useI18n() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeLang(bump), []);
  return { t, tn, lang: getLang() };
}

export const useT = () => useI18n().t;

/**
 * The language picker. A real <select> (so keyboards, screen readers and
 * phones all work), each language named in itself.
 *
 * `onChosen` lets the signed-in caller save the choice on the account.
 */
export function LanguageSwitch({
  onChosen, className, compact,
}: { onChosen?: (lang: Lang) => void; className?: string; compact?: boolean }) {
  const { t: tr, lang } = useI18n();
  return (
    <label className={`i18n-switch ${className ?? ''}`} title={tr('lang.label')}>
      <span className="i18n-switch__globe" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="8" cy="8" r="6.5" /><ellipse cx="8" cy="8" rx="2.8" ry="6.5" /><path d="M1.5 8h13" />
        </svg>
      </span>
      <span className="i18n-switch__sr">{tr('lang.label')}</span>
      <select
        className="i18n-switch__select"
        value={lang}
        aria-label={tr('lang.label')}
        onChange={(e) => {
          const next = e.target.value as Lang;
          setLang(next);
          onChosen?.(next);
        }}
      >
        {LANGS.map(l => (
          <option key={l.code} value={l.code}>{compact ? l.short : l.name}</option>
        ))}
      </select>
    </label>
  );
}
