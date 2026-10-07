// ============================================================
// EmailSettings — the two email switches (worker/email.js).
//
// Email carries little on purpose: the daily Herald and the start and
// end of your games. Account mail (password resets) has no switch.
// Every email's "Email settings" link lands on the Profile tab, which
// renders this.
// ============================================================

import React, { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

type Prefs = {
  address: string | null;
  herald: boolean;
  games: boolean;
  sending: boolean;
  categories: Record<string, string>;
};

export function EmailSettings() {
  useI18n();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<Prefs>('/api/users/me/email-prefs').then(res => {
      if (!live) return;
      if (res.ok) setPrefs(res.data);
      else setError(t('emailSettings.loadFailed'));
    });
    return () => { live = false; };
  }, []);

  async function flip(key: 'herald' | 'games') {
    if (!prefs) return;
    setBusy(key);
    setError(null);
    const res = await apiFetch<Prefs>('/api/users/me/email-prefs', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: !prefs[key] }),
    });
    setBusy(null);
    if (res.ok) setPrefs(res.data);
    else setError(t('emailSettings.saveFailed'));
  }

  if (!prefs) return <div className="pp-sub">{error ?? t('emailSettings.loading')}</div>;

  return (
    <div className="em-settings">
      {prefs.address ? (
        <div className="pp-sub">
          {t('emailSettings.sentTo')}<b className="em-settings__addr">{prefs.address}</b>{t('emailSettings.resetsAlways')}
        </div>
      ) : (
        <div className="pp-sub">{t('emailSettings.noAddress')}</div>
      )}
      {(['games', 'herald'] as const).map(key => (
        <label key={key} className="em-settings__row">
          <input
            type="checkbox"
            checked={prefs[key]}
            disabled={busy === key || !prefs.address}
            onChange={() => flip(key)}
          />
          <span>{key === 'games' ? t('emailSettings.games') : t('emailSettings.herald')}</span>
        </label>
      ))}
      {error && <div className="pp-error">{error}</div>}
    </div>
  );
}
