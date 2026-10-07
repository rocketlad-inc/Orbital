// ============================================================
// /reset-password?token=... — where the password-reset email lands.
//
// An auth-bypass route like /recap: the person clicking it is, by
// definition, not signed in. The token is the permission; the server
// spends it in the same statement that checks it (one use, one hour),
// signs every other device out, and signs this one in.
// ============================================================

import React, { useState } from 'react';
import { apiFetch } from './api';
import { t } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';
import './multiplayer.css';

export function ResetPassword({ token }: { token: string }) {
  useI18n();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError(t('reset.err.mismatch')); return; }
    setBusy(true);
    const res = await apiFetch('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError(apiErrorText(res.error, 'reset.err.failed'));
  }

  // A full page load, not a state flip: the new session cookie is already
  // set, and a fresh load is the one path that picks it up everywhere.
  const goToGame = () => { window.location.assign('/'); };

  return (
    <div className="mp-overlay">
      <div className="mp-lang"><LanguageSwitch /></div>
      <form className="mp-card" onSubmit={onSubmit}>
        <h1 className="mp-title">ORBITAL</h1>
        <div className="mp-subtitle">{done ? t('reset.subtitleDone') : t('reset.subtitle')}</div>

        {done ? (
          <>
            <p className="mp-auth-note">{t('reset.doneBody')}</p>
            <button type="button" className="mp-submit" onClick={goToGame}>{t('reset.continue')}</button>
          </>
        ) : !token ? (
          <>
            <p className="mp-auth-note">{t('reset.noToken')}</p>
            <button type="button" className="mp-submit" onClick={goToGame}>{t('reset.toSignin')}</button>
          </>
        ) : (
          <>
            {/* A hidden username field lets password managers file the new
                password against the right account. */}
            <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
            <label className="mp-label" htmlFor="reset-password">{t('reset.newPw')}</label>
            <input
              id="reset-password"
              name="new-password"
              className="mp-input"
              type="password"
              required
              minLength={8}
              maxLength={200}
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label className="mp-label" htmlFor="reset-confirm">{t('reset.again')}</label>
            <input
              id="reset-confirm"
              name="confirm-password"
              className="mp-input"
              type="password"
              required
              minLength={8}
              maxLength={200}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <p className="mp-auth-note">{t('reset.minLength')}</p>
            <button className="mp-submit" type="submit" disabled={busy}>
              {busy ? t('reset.saving') : t('reset.submit')}
            </button>
            <button type="button" className="mp-auth-link" onClick={goToGame}>{t('auth.backToSignin')}</button>
          </>
        )}

        <div className="mp-error">{error || ''}</div>
      </form>
    </div>
  );
}
