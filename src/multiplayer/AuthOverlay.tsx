import React, { useCallback, useState } from 'react';
import { useAuth } from './AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import './multiplayer.css';

export function AuthOverlay({ onGuest }: { onGuest?: () => void }) {
  const { signIn, signUp, signInWithGoogle, googleClientId } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
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
        <div className="mp-subtitle">SIGN IN TO COMMAND</div>

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
            <label className="mp-label">Call sign</label>
            <input
              className="mp-input"
              type="text"
              maxLength={40}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
          </>
        )}

        <label className="mp-label">Email</label>
        <input
          className="mp-input"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="mp-label">Password</label>
        <input
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

        <div className="mp-error">{error || ''}</div>
      </form>
      {onGuest && (
        <button
          className="mp-guest-btn"
          onClick={onGuest}
        >
          Continue as Guest → Single Player
        </button>
      )}
    </div>
  );
}
