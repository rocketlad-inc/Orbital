import React, { useCallback, useState } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from './api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { t, getLang } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';
import './multiplayer.css';

export function AuthOverlay({ onGuest }: { onGuest?: () => void }) {
  useI18n();
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
      const res = await apiFetch('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email, locale: getLang() }) });
      setBusy(false);
      if (res.ok) setResetSent(true);
      else setError(t('auth.err.sendFailed'));
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
      <div className="mp-lang"><LanguageSwitch /></div>
      <form className="mp-card" onSubmit={onSubmit}>
        <h1 className="mp-title">ORBITAL</h1>
        <div className="mp-subtitle">{mode === 'forgot' ? t('auth.subtitle.forgot') : t('auth.subtitle.signin')}</div>

        {mode === 'forgot' ? (
          resetSent ? (
            <>
              <p className="mp-auth-note">
                {t('auth.sentBefore')}<strong>{email}</strong>{t('auth.sentAfter')}
              </p>
              <button
                type="button"
                className="mp-submit"
                onClick={() => { setMode('login'); setResetSent(false); setError(null); }}
              >{t('auth.backToSignin')}</button>
            </>
          ) : (
            <>
              <p className="mp-auth-note">{t('auth.forgotIntro')}</p>
              <label className="mp-label" htmlFor="auth-forgot-email">{t('common.email')}</label>
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
                {busy ? t('auth.sending') : t('auth.sendLink')}
              </button>
              <button
                type="button"
                className="mp-auth-link"
                onClick={() => { setMode('login'); setError(null); }}
              >{t('auth.backToSignin')}</button>
            </>
          )
        ) : (<>
        <div className="mp-tabs">
          <button
            type="button"
            className={`mp-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError(null); }}
          >{t('auth.tab.signin')}</button>
          <button
            type="button"
            className={`mp-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => { setMode('signup'); setError(null); }}
          >{t('auth.tab.signup')}</button>
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
              {t('auth.orEmail')}
            </div>
          </div>
        )}

        {mode === 'signup' && (
          <>
            <label className="mp-label" htmlFor="auth-callsign">{t('auth.callSign')}</label>
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
        <label className="mp-label" htmlFor="auth-email">{t('common.email')}</label>
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

        <label className="mp-label" htmlFor="auth-password">{t('common.password')}</label>
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
          {mode === 'signup' ? t('auth.tab.signup') : t('auth.tab.signin')}
        </button>
        {mode === 'login' && (
          <button
            type="button"
            className="mp-auth-link"
            onClick={() => { setMode('forgot'); setError(null); setResetSent(false); }}
          >{t('auth.forgotLink')}</button>
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
