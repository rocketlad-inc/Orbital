// ============================================================
// AnswerPage — one page from src/content/answerPages.ts: a question
// people ask (games like Neptune's Pride, free browser 4X...) answered
// about Orbital, ending in Play.
//
// Links are real <a href>s so search engines and AI crawlers can follow
// them; a plain click stays in the app (onOpen) instead of reloading.
// ============================================================

import React from 'react';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { ANSWER_PAGES, ANSWER_MORE, type AnswerPage as Page } from '../content/answerPages';
import './AnswerPage.css';

interface Props {
  page: Page;
  onSignIn: () => void;
  /** Open another landing page by path, without a reload. */
  onOpen: (path: string) => void;
}

export const AnswerPage: React.FC<Props> = ({ page, onSignIn, onOpen }) => {
  useI18n();
  const go = (path: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(path);
  };
  const others = ANSWER_PAGES.filter(p => p.slug !== page.slug);
  return (
    <article className="ap">
      <header className="ap-hero">
        <div className="ap-eyebrow">{page.eyebrow}</div>
        <h1 className="ap-title">{page.h1}</h1>
        <p className="ap-lede">{page.lede}</p>
        <div className="ap-actions">
          <button className="ap-btn ap-btn--primary" onClick={onSignIn}>{t('landing.hero.play')}</button>
          <a className="ap-btn" href="/how-to-play" onClick={go('/how-to-play')}>{t('site.nav.howto')}</a>
        </div>
      </header>

      <figure className="ap-shot">
        <img src={page.image.src} alt={page.image.alt} width={1200} height={675} loading="lazy" decoding="async" />
      </figure>

      {page.sections.map(s => (
        <section key={s.heading} className="ap-section">
          <h2 className="ap-h2">{s.heading}</h2>
          {s.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}
          {s.points && <ul>{s.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          {s.steps && <ol>{s.steps.map((p, i) => <li key={i}>{p}</li>)}</ol>}
        </section>
      ))}

      <div className="ap-cta">
        <button className="ap-btn ap-btn--primary ap-btn--lg" onClick={onSignIn}>{t('landing.hero.play')}</button>
        <p className="ap-fine">{t('landing.final.fine')}</p>
      </div>

      <nav className="ap-more" aria-label={ANSWER_MORE}>
        <h2 className="ap-more__title">{ANSWER_MORE}</h2>
        <ul>
          <li><a href="/" onClick={go('/')}>{t('site.nav.about')}</a></li>
          <li><a href="/how-to-play" onClick={go('/how-to-play')}>{t('site.nav.howto')}</a></li>
          {others.map(p => (
            <li key={p.slug}><a href={p.path} onClick={go(p.path)}>{p.label}</a></li>
          ))}
        </ul>
      </nav>

      {page.note && <p className="ap-note">{page.note}</p>}
    </article>
  );
};
