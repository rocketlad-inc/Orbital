// ============================================================
// RecapShare — passing a battle on, and the door into the game.
//
// A recap is the game's best advert and it had no way out: no share
// control on the page, and a small "Play Orbital" in the footer. In its
// first 53 days 413 recap links drew 162 views. Two pieces, used by the
// shared recap page:
//
//   RecapShareBar  copy the link, the phone's own share sheet, Reddit, X.
//                  The link is the bare /recap/<token>: its unfurl is the
//                  battle's own card (worker/recapShare.js).
//   RecapJoinCta   what this is and a real button to play, tagged
//                  ?from=recap so the admin "Where players came from"
//                  panel can say whether recaps bring anyone in.
// ============================================================

import React, { useState } from 'react';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

const SITE = 'https://orbital-empire.com';

export function recapUrl(token: string): string {
  return `${SITE}/recap/${encodeURIComponent(token)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and some in-app webviews: a selected textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function RecapShareBar({ token, text }: { token: string; text: string }) {
  useI18n();
  const [copied, setCopied] = useState(false);
  const url = recapUrl(token);
  const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };
  const native = async () => {
    try { await navigator.share({ title: text, text, url }); } catch { /* dismissed */ }
  };

  return (
    <div className="recap-share" role="group" aria-label={t('review.shared.share.label')}>
      <span className="recap-share__label">{t('review.shared.share.label')}</span>
      <button type="button" className="recap-share__btn recap-share__btn--main" onClick={copy}>
        {copied ? t('review.shared.share.copied') : t('review.shared.share.copy')}
      </button>
      {canNative && (
        <button type="button" className="recap-share__btn" onClick={native}>{t('review.shared.share.native')}</button>
      )}
      <a className="recap-share__btn" target="_blank" rel="noopener noreferrer"
        href={`https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`}>
        Reddit
      </a>
      <a className="recap-share__btn" target="_blank" rel="noopener noreferrer"
        href={`https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`}>
        X
      </a>
    </div>
  );
}

export function RecapJoinCta() {
  useI18n();
  return (
    <div className="recap-cta">
      <div className="recap-cta__text">
        <div className="recap-cta__title">{t('review.shared.cta.title')}</div>
        <div className="recap-cta__body">{t('review.shared.cta.body')}</div>
      </div>
      <a className="recap-cta__btn" href="/?from=recap">{t('review.shared.cta.play')}</a>
    </div>
  );
}
