// ============================================================
// SAVE YOUR EMPIRE — turning a Play for Free trial into an account
// (worker/trial.js, Lorne 2026-10-24).
//
// One sheet, opened by an 'orbital:save-empire' event ({ reason }) from
// anywhere: the menu (top left), the first try at leaving the page, ten
// minutes of play, or an action that needs an account. Google, or email
// + password (+ call sign); "I have an account" signs in instead. Either
// way the server moves the trial game into the account (claimShadow),
// and the player keeps playing where they are: AuthContext swaps the
// user and the app re-enters the same game.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../AuthContext';
import { GoogleSignInButton } from '../GoogleSignInButton';
import { t } from '../../i18n/core';
import { useI18n } from '../../i18n/react';
import './trial.css';

export type SaveReason = 'menu' | 'leaving' | 'time' | 'account';

/** Open the sheet from anywhere. */
export function openSaveEmpire(reason: SaveReason) {
  try { window.dispatchEvent(new CustomEvent('orbital:save-empire', { detail: { reason } })); } catch { /* no window */ }
}

const LEAD: Record<SaveReason, 'trial.save.lead.menu' | 'trial.save.lead.leaving' | 'trial.save.lead.time' | 'trial.save.lead.account'> = {
  menu: 'trial.save.lead.menu',
  leaving: 'trial.save.lead.leaving',
  time: 'trial.save.lead.time',
  account: 'trial.save.lead.account',
};

/** Mounted once for a trial (shadow) account; renders the sheet when asked. */
export function SaveEmpireHost() {
  useI18n();
  const { user } = useAuth();
  const [reason, setReason] = useState<SaveReason | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const r = (e as CustomEvent).detail?.reason;
      setReason(r === 'leaving' || r === 'time' || r === 'account' ? r : 'menu');
    };
    window.addEventListener('orbital:save-empire', onOpen as EventListener);
    return () => window.removeEventListener('orbital:save-empire', onOpen as EventListener);
  }, []);
  // Saved: the account is real now, the sheet has done its job.
  useEffect(() => { if (user && !user.shadow) setReason(null); }, [user]);
  if (!reason || !user?.shadow) return null;
  return <SaveEmpireSheet reason={reason} onClose={() => setReason(null)} />;
}

function SaveEmpireSheet({ reason, onClose }: { reason: SaveReason; onClose: () => void }) {
  useI18n();
  const { signIn, signUp, signInWithGoogle, googleClientId } = useAuth();
  const [mode, setMode] = useState<'new' | 'have'>('new');
  const [callSign, setCallSign] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const saved = () => {
    try { window.dispatchEvent(new CustomEvent('orbital:toast', { detail: { text: t('trial.save.done') } })); } catch { /* */ }
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const problem = mode === 'new' ? await signUp(email, password, callSign) : await signIn(email, password);
    setBusy(false);
    if (problem) setError(problem);
    else saved();
  }

  const onGoogle = useCallback(async (idToken: string) => {
    setError(null);
    setBusy(true);
    const problem = await signInWithGoogle(idToken);
    setBusy(false);
    if (problem) setError(problem);
    else saved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInWithGoogle]);

  return createPortal(
    <div className="save-empire" role="dialog" aria-modal="true" aria-labelledby="save-empire-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="save-empire__card" onSubmit={onSubmit}>
        <div className="save-empire__eyebrow">{t('trial.save.eyebrow')}</div>
        <h2 id="save-empire-title" className="save-empire__title">{t('trial.save.title')}</h2>
        <p className="save-empire__lead">{t(LEAD[reason])}</p>

        <div className="save-empire__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'new'}
            className={mode === 'new' ? 'is-on' : ''} onClick={() => { setMode('new'); setError(null); }}>
            {t('trial.save.tab.new')}
          </button>
          <button type="button" role="tab" aria-selected={mode === 'have'}
            className={mode === 'have' ? 'is-on' : ''} onClick={() => { setMode('have'); setError(null); }}>
            {t('trial.save.tab.have')}
          </button>
        </div>

        {googleClientId && (
          <div className="save-empire__google">
            <GoogleSignInButton clientId={googleClientId} onCredential={onGoogle}
              onError={(msg) => setError(msg)} disabled={busy} />
            <div className="save-empire__or">{t('auth.orEmail')}</div>
          </div>
        )}

        {mode === 'new' && (
          <>
            <label className="save-empire__label" htmlFor="save-callsign">{t('auth.callSign')}</label>
            <input id="save-callsign" className="save-empire__input" type="text" maxLength={40}
              value={callSign} onChange={(e) => setCallSign(e.target.value)} autoComplete="nickname" />
          </>
        )}
        <label className="save-empire__label" htmlFor="save-email">{t('common.email')}</label>
        <input id="save-email" name="username" className="save-empire__input" type="email" required
          autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="save-empire__label" htmlFor="save-password">{t('common.password')}</label>
        <input id="save-password" name="password" className="save-empire__input" type="password" required minLength={8}
          autoComplete={mode === 'new' ? 'new-password' : 'current-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} />

        {error && <div className="save-empire__error" role="alert">{error}</div>}

        <button className="save-empire__go" type="submit" disabled={busy}>
          {busy ? t('trial.save.busy') : mode === 'new' ? t('trial.save.go.new') : t('trial.save.go.have')}
        </button>
        <p className="save-empire__fine">{t('trial.save.fine')}</p>
        <button type="button" className="save-empire__later" onClick={onClose} disabled={busy}>
          {t('trial.save.later')}
        </button>
      </form>
    </div>,
    document.body,
  );
}
