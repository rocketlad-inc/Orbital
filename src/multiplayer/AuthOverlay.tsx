// ============================================================
// The sign-in page (Lorne, 2026-10-24: "We have a huge amount of drop off
// on that page"). Of the 153 new visitors who clicked Play in the last 30
// days, about 45 tried to sign in at all (29 of them with Google).
//
// So: the game is on screen (a starfield, a planet's edge, a live clip),
// Google first, a short email form that opens on Create account, and a
// way in with no form at all: Try out a Solo Game (worker/trial.js).
// ============================================================

import React, { useCallback, useState } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from './api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { trackVisitStep } from './attribution';
import { LobbyStarfield } from './LobbyStarfield';
import { t, getLang } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';
import './multiplayer.css';
import './authScreen.css';

type Mode = 'signup' | 'login' | 'forgot';

export function AuthOverlay({ onBack, onTrial }: {
  /** Back to the landing page. */
  onBack?: () => void;
  /** Try out a Solo Game: the Play for Free trial, no account. */
  onTrial?: () => void;
  /** Retired (the guest path); kept for type-compat. */
  onGuest?: () => void;
}) {
  useI18n();
  const { signIn, signUp, signInWithGoogle, googleClientId } = useAuth();
  const [mode, setMode] = useState<Mode>('signup');
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (m: Mode) => {
    setMode(m);
    setError(null);
    setResetSent(false);
    if (m === 'signup') trackVisitStep('signup_tab');
  };

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
    trackVisitStep(mode === 'signup' ? 'email_try' : 'login_try');
    const problem = mode === 'signup'
      ? await signUp(email, password, displayName)
      : await signIn(email, password);
    setBusy(false);
    if (problem) { setError(problem); trackVisitStep('auth_error'); }
  }

  const onGoogleCredential = useCallback(async (idToken: string) => {
    setError(null);
    setBusy(true);
    trackVisitStep('google_try');
    const problem = await signInWithGoogle(idToken);
    setBusy(false);
    if (problem) { setError(problem); trackVisitStep('auth_error'); }
  }, [signInWithGoogle]);

  return (
    <div className="ax">
      <LobbyStarfield />
      <div className="ax-sky" aria-hidden="true" />
      <div className="ax-planet" aria-hidden="true" />

      <header className="ax-top">
        {onBack ? (
          <button type="button" className="ax-back" onClick={onBack}>{t('auth.back')}</button>
        ) : <span />}
        <LanguageSwitch compact />
      </header>

      <main className="ax-main">
        <section className="ax-pitch" aria-hidden="true">
          <div className="ax-brand">ORBITAL</div>
          <h1 className="ax-headline">{t('auth.headline')}</h1>
          <figure className="ax-clip">
            <img src="/clips/mega-destroyer-jupiter-to-earth.webp" alt="" loading="lazy" />
            <figcaption>{t('auth.clipCaption')}</figcaption>
          </figure>
        </section>

        <section className="ax-side">
          <form className="ax-card" onSubmit={onSubmit}>
            <div className="ax-brand ax-brand--card">ORBITAL</div>

            {mode === 'forgot' ? (
              <>
                <h2 className="ax-title">{t('auth.subtitle.forgot')}</h2>
                {resetSent ? (
                  <p className="ax-note">{t('auth.sentBefore')}<strong>{email}</strong>{t('auth.sentAfter')}</p>
                ) : (
                  <>
                    <p className="ax-note">{t('auth.forgotIntro')}</p>
                    <label className="ax-label" htmlFor="auth-forgot-email">{t('common.email')}</label>
                    <input id="auth-forgot-email" name="username" className="ax-input" type="email" required
                      autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      value={email} onChange={(e) => setEmail(e.target.value)} />
                    <button className="ax-go" type="submit" disabled={busy}>
                      {busy ? t('auth.sending') : t('auth.sendLink')}
                    </button>
                  </>
                )}
                <button type="button" className="ax-link" onClick={() => pick('login')}>{t('auth.backToSignin')}</button>
              </>
            ) : (
              <>
                <div className="ax-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={mode === 'signup'}
                    className={mode === 'signup' ? 'is-on' : ''} onClick={() => pick('signup')}>
                    {t('auth.tab.signup')}
                  </button>
                  <button type="button" role="tab" aria-selected={mode === 'login'}
                    className={mode === 'login' ? 'is-on' : ''} onClick={() => pick('login')}>
                    {t('auth.tab.signin')}
                  </button>
                </div>

                {googleClientId && (
                  <div className="ax-google">
                    <GoogleSignInButton
                      clientId={googleClientId}
                      onCredential={onGoogleCredential}
                      onError={(msg) => { setError(msg); trackVisitStep('google_error'); }}
                      disabled={busy}
                    />
                    <div className="ax-or"><span>{t('auth.orEmailShort')}</span></div>
                  </div>
                )}

                {/* Stable id/name + autocomplete=username so password
                    managers treat this as ONE login form. */}
                <label className="ax-label" htmlFor="auth-email">{t('common.email')}</label>
                <input id="auth-email" name="username" className="ax-input" type="email" required
                  autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={email} onChange={(e) => setEmail(e.target.value)} />

                <label className="ax-label" htmlFor="auth-password">{t('common.password')}</label>
                <div className="ax-pw">
                  <input id="auth-password" name="password" className="ax-input" required minLength={8}
                    type={showPw ? 'text' : 'password'}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" className="ax-pw__toggle" onClick={() => setShowPw(v => !v)}
                    aria-pressed={showPw} aria-label={showPw ? t('auth.hidePw') : t('auth.showPw')}>
                    {showPw ? t('auth.hidePw') : t('auth.showPw')}
                  </button>
                </div>

                {mode === 'signup' && (
                  <>
                    <label className="ax-label" htmlFor="auth-callsign">
                      {t('auth.callSign')} <span className="ax-optional">{t('auth.optional')}</span>
                    </label>
                    <input id="auth-callsign" name="displayName" className="ax-input" type="text" maxLength={40}
                      value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" />
                  </>
                )}

                {error && <div className="ax-error" role="alert">{error}</div>}

                <button className="ax-go" type="submit" disabled={busy}>
                  {busy ? t('auth.working') : mode === 'signup' ? t('auth.go.signup') : t('auth.go.signin')}
                </button>
                {mode === 'login' && (
                  <button type="button" className="ax-link" onClick={() => pick('forgot')}>{t('auth.forgotLink')}</button>
                )}
              </>
            )}
          </form>

          {onTrial && (
            <div className="ax-solo">
              <div className="ax-or ax-or--solo"><span>{t('auth.orNoAccount')}</span></div>
              <button type="button" className="ax-solo__btn" onClick={() => { trackVisitStep('trial_click'); onTrial(); }}>
                <span className="ax-solo__title">{t('auth.solo.title')}</span>
                <span className="ax-solo__sub">{t('auth.solo.sub')}</span>
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
