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

type Prefs = {
  address: string | null;
  herald: boolean;
  games: boolean;
  sending: boolean;
  categories: Record<string, string>;
};

export function EmailSettings() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<Prefs>('/api/users/me/email-prefs').then(res => {
      if (!live) return;
      if (res.ok) setPrefs(res.data);
      else setError('Could not load your email settings.');
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
    else setError('Could not save. Try again.');
  }

  if (!prefs) return <div className="pp-sub">{error ?? 'Loading…'}</div>;

  return (
    <div className="em-settings">
      {prefs.address ? (
        <div className="pp-sub">
          Sent to <b className="em-settings__addr">{prefs.address}</b>. Password resets always reach you.
        </div>
      ) : (
        <div className="pp-sub">This account has no email address that can receive mail.</div>
      )}
      {(['games', 'herald'] as const).map(key => (
        <label key={key} className="em-settings__row">
          <input
            type="checkbox"
            checked={prefs[key]}
            disabled={busy === key || !prefs.address}
            onChange={() => flip(key)}
          />
          <span>{prefs.categories[key]}</span>
        </label>
      ))}
      {error && <div className="pp-error">{error}</div>}
    </div>
  );
}
