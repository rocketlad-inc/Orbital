import React, { useCallback, useState } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from './api';
import { GoogleSignInButton } from './GoogleSignInButton';
import './multiplayer.css';

export function AuthOverlay({ onGuest }: { onGuest?: () => void }) {
  const { signIn, signUp, signInWithGoogle, googleClientId } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    if (mode === 'forgot') {
      // The server answers the same whether or not the address has an
      // account, so this screen says the same thing either way too.
      const res = await apiFetch('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      setBusy(false);
      if (res.ok) setResetSent(true);
      else setError('Could not send the link. Try again in a moment.');
      return;
    }
    const err = mode === 'signup'
      ? await signUp(email, password, displayName)
      : await signIn(email, password);
    setBusy(false);
    if (err) setError(err);
  }

  const onGoogleCredential = useCallback(async (idToken: string) => {
    setError(null);
    setBusy(true);
    const err = await signInWithGoogle(idToken);
    setBusy(false);
    if (err) setError(err);
  }, [signInWithGoogle]);

  return (
    <div className="mp-overlay">
      <form className="mp-card" onSubmit={onSubmit}>
        <h1 className="mp-title">ORBITAL</h1>
        <div className="mp-subtitle">{mode === 'forgot' ? 'RESET YOUR PASSWORD' : 'SIGN IN TO COMMAND'}</div>

        {mode === 'forgot' ? (
          resetSent ? (
            <>
              <p className="mp-auth-note">
                If there is an account for <strong>{email}</strong>, a reset link is on its way.
                It works once and expires in an hour. Check your spam folder if it hasn&rsquo;t
                arrived in a few minutes.
              </p>
              <button
                type="button"
                className="mp-submit"
                onClick={() => { setMode('login'); setResetSent(false); setError(null); }}
              >Back to sign in</button>
            </>
          ) : (
            <>
              <p className="mp-auth-note">
                Enter the email you signed up with and we&rsquo;ll send you a link to choose a new password.
              </p>
              <label className="mp-label" htmlFor="auth-forgot-email">Email</label>
              <input
                id="auth-forgot-email"
                name="username"
                className="mp-input"
                type="email"
                required
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="mp-submit" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                className="mp-auth-link"
                onClick={() => { setMode('login'); setError(null); }}
              >Back to sign in</button>
            </>
          )
        ) : (<>
        <div className="mp-tabs">
          <button
            type="button"
            className={`mp-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError(null); }}
          >Sign in</button>
          <button
            type="button"
            className={`mp-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => { setMode('signup'); setError(null); }}
          >Create account</button>
        </div>

        {googleClientId && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10, margin: '4px 0 14px' }}>
            <GoogleSignInButton
              clientId={googleClientId}
              onCredential={onGoogleCredential}
              onError={(msg) => setError(msg)}
              disabled={busy}
            />
            <div style={{ textAlign: 'center', fontSize: 10, color: '#6b8195', letterSpacing: '0.12em' }}>
              — OR USE EMAIL —
            </div>
          </div>
        )}

        {mode === 'signup' && (
          <>
            <label className="mp-label" htmlFor="auth-callsign">Call sign</label>
            <input
              id="auth-callsign"
              name="displayName"
              className="mp-input"
              type="text"
              maxLength={40}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
          </>
        )}

        {/* Stable id/name + autocomplete=username so Safari/password
            managers treat this as ONE persistent login form (username +
            password pair) and don't re-prompt to save on each edit. */}
        <label className="mp-label" htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          name="username"
          className="mp-input"
          type="email"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="mp-label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          name="password"
          className="mp-input"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button className="mp-submit" type="submit" disabled={busy}>
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        {mode === 'login' && (
          <button
            type="button"
            className="mp-auth-link"
            onClick={() => { setMode('forgot'); setError(null); setResetSent(false); }}
          >Forgot password?</button>
        )}
        </>)}

        <div className="mp-error">{error || ''}</div>
      </form>
      {/* Guest → Single Player entry RETIRED (per Lorne, usability
          report): guest mode dropped visitors into the deprecated SP
          engine — broken shell states and all — as their first taste
          of the game. The prop is kept for type-compat but ignored. */}
    </div>
  );
}
