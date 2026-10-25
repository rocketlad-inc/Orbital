// Bundled by scripts/prerender-pages.mjs (esbuild, node) and run once per
// build: the landing pages rendered to static markup with the SAME
// components and English catalog the site uses, so the crawler copy can
// never drift from the page people see.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingHome, FAQ } from '../../src/components/LandingHome';
import { HowToPlay } from '../../src/components/HowToPlay';
import { PressKit } from '../../src/components/PressKit';
import { Credits } from '../../src/components/Credits';
import { PrivacyPolicy } from '../../src/components/PrivacyPolicy';
import { AnswerPage } from '../../src/components/AnswerPage';
import { ANSWER_PAGES } from '../../src/content/answerPages';
import { SEED_POSTS } from '../../src/content/devlogPosts';
import { primeDevlogPosts, type DevlogPost } from '../../src/content/devlogStore';
import { PAGE_META, DOC_PATH } from '../../src/content/pageMeta';
import { setLang } from '../../src/i18n/core';

const noop = () => {};

export { ANSWER_PAGES, SEED_POSTS, FAQ, PAGE_META, DOC_PATH };

/** path -> body markup. Titles and descriptions come from the caller.
 *  `posts` is the live devlog, so links to posts match what is published. */
export function renderPages(posts: DevlogPost[]): Record<string, string> {
  setLang('en', false);
  primeDevlogPosts(posts);
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);
  const out: Record<string, string> = {
    '/': html(<LandingHome onSignIn={noop} />),
    '/how-to-play': html(<HowToPlay onSignIn={noop} />),
    '/press': html(<PressKit />),
    '/credits': html(<Credits />),
    '/privacy': html(<PrivacyPolicy />),
  };
  for (const p of ANSWER_PAGES) out[p.path] = html(<AnswerPage page={p} onSignIn={noop} onOpen={noop} />);
  return out;
}
