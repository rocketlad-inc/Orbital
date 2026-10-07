// ============================================================
// "Your watch is asking to give orders."
//
// THE QUESTION HAS TO FIND THE GAME, not the other way round. The old
// grant lived in a script in the page shell and only ran when the launch
// URL loaded a fresh document — so with the game already open, tapping
// ALLOW ORDERS on the watch brought the app forward and asked nothing,
// which is precisely what players reported. This polls for a pending
// ask instead, so the question turns up wherever the game is: already
// open, opened a minute later, or opened tomorrow.
//
// The ask itself is filed by the watch against its own token
// (worker/wearRequests.js); answering it here, behind the session
// cookie, is what mints the orders token. Declining leaves the watch
// exactly as it was — paired, read-only, still able to vote.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/core';
import { apiErrorText } from '../i18n/apiErrors';
import { useI18n } from '../i18n/react';

interface Pending { code: string; at: number }

/** Quiet: a watch pairing is rare, and this runs for the whole session. */
const POLL_MS = 20_000;

export function WatchOrdersPrompt() {
  useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A denial should not immediately re-ask on the next poll.
  const answered = useRef<Set<string>>(new Set());

  const check = useCallback(async () => {
    try {
      const r = await fetch('/api/me/wear-requests', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const req: Pending | null = j?.request ?? null;
      setPending(req && !answered.current.has(req.code) ? req : null);
    } catch {
      /* offline, or signed out: ask again on the next beat */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const beat = () => { if (alive && document.visibilityState === 'visible') check(); };
    beat();
    const id = window.setInterval(beat, POLL_MS);
    // The common case is the phone being picked up seconds after the
    // watch asked, so a wake is worth a check of its own.
    document.addEventListener('visibilitychange', beat);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [check]);

  const decide = async (allow: boolean) => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/me/wear-requests/${encodeURIComponent(pending.code)}/${allow ? 'allow' : 'deny'}`, {
        method: 'POST',
        credentials: 'include',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(apiErrorText(j?.error, 'mp.watch.errFail'));
        setBusy(false);
        return;
      }
      answered.current.add(pending.code);
      setPending(null);
    } catch {
      setError(t('mp.watch.errNet'));
    }
    setBusy(false);
  };

  if (!pending) return null;

  return (
    <div className="mp-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="watch-orders-title">
      <div className="mp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mp-modal__title" id="watch-orders-title">{t('mp.watch.title')}</div>
        <div className="mp-modal__desc">
          {t('mp.watch.p1')}
          <br /><br />
          {t('mp.watch.p2')}
          {error && <><br /><br /><span style={{ color: 'var(--mp-hostile)' }}>{error}</span></>}
        </div>
        <div className="mp-modal__actions">
          <button type="button" className="mp-btn" onClick={() => decide(false)} disabled={busy}>{t('mp.watch.notNow')}</button>
          <button type="button" className="mp-btn mp-btn--primary" onClick={() => decide(true)} disabled={busy}>
            {busy ? t('mp.watch.allowing') : t('mp.watch.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
