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
import './multiplayer.css';

export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('The two passwords don’t match.'); return; }
    setBusy(true);
    const res = await apiFetch('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError(res.error?.message ?? 'Could not reset the password. Try again.');
  }

  // A full page load, not a state flip: the new session cookie is already
  // set, and a fresh load is the one path that picks it up everywhere.
  const goToGame = () => { window.location.assign('/'); };

  return (
    <div className="mp-overlay">
      <form className="mp-card" onSubmit={onSubmit}>
        <h1 className="mp-title">ORBITAL</h1>
        <div className="mp-subtitle">{done ? 'PASSWORD CHANGED' : 'CHOOSE A NEW PASSWORD'}</div>

        {done ? (
          <>
            <p className="mp-auth-note">
              Your password is changed and you&rsquo;re signed in. Every other device has been
              signed out.
            </p>
            <button type="button" className="mp-submit" onClick={goToGame}>Continue to Orbital</button>
          </>
        ) : !token ? (
          <>
            <p className="mp-auth-note">
              This link is missing its code. Open the link from your email again, or ask for a new one
              from the sign-in screen.
            </p>
            <button type="button" className="mp-submit" onClick={goToGame}>Go to sign in</button>
          </>
        ) : (
          <>
            {/* A hidden username field lets password managers file the new
                password against the right account. */}
            <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
            <label className="mp-label" htmlFor="reset-password">New password</label>
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
            <label className="mp-label" htmlFor="reset-confirm">Type it again</label>
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
            <p className="mp-auth-note">At least 8 characters.</p>
            <button className="mp-submit" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
            <button type="button" className="mp-auth-link" onClick={goToGame}>Back to sign in</button>
          </>
        )}

        <div className="mp-error">{error || ''}</div>
      </form>
    </div>
  );
}
