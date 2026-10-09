// ============================================================
// Landing - Marketing page shown before sign-in
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import './Landing.css';
import { HowToPlay } from './HowToPlay';
import { PrivacyPolicy } from './PrivacyPolicy';
import { Changelog } from './Changelog';
import { PressKit } from './PressKit';
import { Credits } from './Credits';
import { LandingHome } from './LandingHome';
import { t, tk, type Key } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';

interface LandingProps {
  /** Triggered by the Login button or any CTA. Reveals the auth overlay. */
  onSignIn: () => void;
  /** True when a SIGNED-IN player is here for a doc route (/changelog,
   *  /how-to-play). They already have an account, so the nav must offer a
   *  way back to their game instead of a Login button that does nothing
   *  useful. */
  authed?: boolean;
  /** Leave the doc route and return to the game. Required when authed. */
  onExit?: () => void;
}

type LandingTab = 'about' | 'howto' | 'changelog' | 'privacy' | 'press' | 'credits';

/** Tabs that own a URL, so they can be linked to directly. The changelog
 *  exists to be pasted into Discord — a tab you can only reach by
 *  clicking is not shareable, which would defeat the point. The worker
 *  serves the SPA shell for unknown paths (wrangler.jsonc
 *  not_found_handling), so /changelog reaches the app and we pick the tab
 *  back out of the path here. */
const TAB_PATHS: Record<string, LandingTab> = {
  '/changelog': 'changelog',
  '/how-to-play': 'howto',
  // Google Play will not publish an app without a reachable policy URL.
  '/privacy': 'privacy',
  '/press': 'press',
  '/credits': 'credits',
};
const PATH_FOR_TAB: Partial<Record<LandingTab, string>> = {
  changelog: '/changelog',
  howto: '/how-to-play',
  privacy: '/privacy',
  press: '/press',
  credits: '/credits',
};

/** Per-page title and description (search results and browser tabs). */
const PAGE_META: Record<LandingTab, { title: string; description: string }> = {
  about: {
    title: 'Orbital — Free Real-Time Space Strategy Game in Your Browser',
    description: 'A free multiplayer space strategy game set across the real solar system. Two to ten players, turns that keep running while you’re offline, and three ways to win.',
  },
  howto: {
    title: 'How to Play Orbital — Space Strategy Guide for New Commanders',
    description: 'Learn Orbital in minutes: turns, fleets and flight, settling and terraforming worlds, combat, the Senate, and the three ways to win.',
  },
  changelog: {
    title: 'Orbital Changelog — Every Update, Newest First',
    description: 'Every change to Orbital, the free real-time space strategy game, written in plain language, newest first.',
  },
  press: {
    title: 'Orbital Press Kit — Facts, Screenshots, Clips and Logos',
    description: 'Everything for writing about Orbital: the fact sheet, descriptions, full-size screenshots, looping clips, logos and key art.',
  },
  privacy: {
    title: 'Privacy Policy — Orbital',
    description: 'What Orbital collects, why, and how to have it deleted.',
  },
  credits: {
    title: 'Credits — Orbital',
    description: 'The people and open-source work behind Orbital, including the captain portraits from the Naev project.',
  },
};

/** Title and description for the tab, in the player's language. The press,
 *  privacy, changelog and credits pages are English documents, so theirs stay. */
function pageMeta(tab: LandingTab): { title: string; description: string } {
  const m = PAGE_META[tab];
  if (tab === 'about' || tab === 'howto') {
    return { title: tk(`site.meta.${tab}.title`, m.title), description: tk(`site.meta.${tab}.desc`, m.description) };
  }
  return m;
}

function tabFromPath(): LandingTab {
  if (typeof window === 'undefined') return 'about';
  return TAB_PATHS[window.location.pathname] ?? 'about';
}

export const Landing: React.FC<LandingProps> = ({ onSignIn, authed = false, onExit }) => {
  const starfieldRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<LandingTab>(tabFromPath);
  const { lang } = useI18n();

  // Keep the address bar in step with the tab, so the link a player
  // copies is the page they are looking at. pushState (not replaceState)
  // so Back walks the tabs the way people expect.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const want = PATH_FOR_TAB[tab] ?? '/';
    if (window.location.pathname !== want) {
      window.history.pushState({ tab }, '', want + window.location.search);
    }
  }, [tab]);

  // ...and follow the browser's Back/Forward buttons.
  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // SEO: index.html is the same document for every path (the game too), so
  // the page's title, description and canonical are set here, per tab. The
  // static HTML carries no canonical on purpose: one pointing at "/" would
  // tell search engines /changelog and /how-to-play are duplicates of it.
  useEffect(() => {
    const meta = pageMeta(tab);
    const prevTitle = document.title;
    document.title = meta.title;
    const desc = document.querySelector('meta[name="description"]');
    const prevDesc = desc?.getAttribute('content') ?? null;
    if (desc) desc.setAttribute('content', meta.description);
    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = `https://orbital-empire.com${PATH_FOR_TAB[tab] ?? '/'}`;
    // Leaving the landing (into the game) puts a plain title back.
    return () => {
      document.title = prevTitle.startsWith('Orbital') ? 'Orbital' : prevTitle;
      if (desc && prevDesc !== null) desc.setAttribute('content', prevDesc);
    };
  }, [tab, lang]);

  // Switching tabs scrolls back to the top — otherwise you land
  // mid-page in the new content with no idea where you are. NOTE:
  // `.landing` is the scroller (overflow-y: auto), not the window, so
  // window.scrollTo does nothing here.
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [tab]);

  // Draw a procedural starfield as a backdrop, redraw on resize.
  useEffect(() => {
    const canvas = starfieldRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const w = window.innerWidth;
      const h = window.innerHeight * 2; // tall enough for scroll
      canvas.width = w;
      canvas.height = h;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      // Nebula blobs
      const blobs = [
        { x: w * 0.2, y: h * 0.15, r: 280, color: 'rgba(80, 60, 130, 0.06)' },
        { x: w * 0.85, y: h * 0.4, r: 320, color: 'rgba(60, 90, 150, 0.06)' },
        { x: w * 0.35, y: h * 0.75, r: 260, color: 'rgba(140, 80, 90, 0.05)' },
      ];
      for (const b of blobs) {
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, b.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
      }

      // Stars
      const count = Math.floor((w * h) / 700);
      for (let i = 0; i < count; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = Math.random();
        if (r > 0.985) {
          const halo = ctx.createRadialGradient(x, y, 0, x, y, 4.5);
          halo.addColorStop(0, 'rgba(255,240,200,0.45)');
          halo.addColorStop(1, 'rgba(255,240,200,0)');
          ctx.fillStyle = halo;
          ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
          ctx.fillStyle = 'rgba(255,248,220,0.95)';
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        } else if (r > 0.93) {
          ctx.fillStyle = `rgba(220,230,255,${0.7 + Math.random() * 0.3})`;
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        } else if (r > 0.7) {
          ctx.fillStyle = `rgba(200,210,225,${0.4 + Math.random() * 0.3})`;
          ctx.fillRect(x, y, 0.8, 0.8);
        } else {
          ctx.fillStyle = `rgba(170,180,200,${0.18 + Math.random() * 0.22})`;
          ctx.fillRect(x, y, 0.6, 0.6);
        }
      }
    };

    render();
    window.addEventListener('resize', render);
    return () => window.removeEventListener('resize', render);
  }, []);

  return (
    <div className="landing" ref={scrollRef}>
      <canvas ref={starfieldRef} className="landing-starfield" />

      {/* Top nav */}
      <header className="landing-nav">
        <button className="landing-brand" onClick={() => setTab('about')} aria-label={t('site.homeAria')}>
          <span className="brand-glyph" aria-hidden>◉</span>
          <span className="brand-text">ORBITAL</span>
        </button>
        <nav className="landing-nav-tabs" aria-label={t('site.sectionsAria')}>
          {([
            ['about', 'site.nav.about'],
            ['howto', 'site.nav.howto'],
            ['changelog', 'site.nav.changelog'],
            ['press', 'site.nav.press'],
          ] as Array<[LandingTab, Key]>).map(([id, labelKey]) => (
            <button
              key={id}
              className={`landing-tab-btn${tab === id ? ' is-active' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>
        <div className="landing-nav-actions">
          <LanguageSwitch compact />
          {authed ? (
            <button className="landing-cta-btn" onClick={onExit}>{t('site.back')}</button>
          ) : (
            <>
              <button className="landing-login-btn" onClick={onSignIn}>{t('site.signIn')}</button>
              <button className="landing-cta-btn" onClick={onSignIn}>{t('site.playFree')}</button>
            </>
          )}
        </div>
      </header>

      {tab === 'howto' && <HowToPlay onSignIn={onSignIn} />}

      {tab === 'privacy' && <PrivacyPolicy />}

      {tab === 'press' && <PressKit />}

      {tab === 'credits' && <Credits />}

      {tab === 'changelog' && (
        <Changelog
          ctaLabel={authed ? t('site.changelogBack') : t('site.changelogPlay')}
          onCta={authed ? (onExit ?? onSignIn) : onSignIn}
        />
      )}

      {tab === 'about' && <LandingHome onSignIn={onSignIn} />}

      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__brand">
            <span className="brand-glyph" aria-hidden>◉</span>
            <span className="brand-text">ORBITAL</span>
            <p className="landing-footer__tag">{t('site.footerTag')}</p>
          </div>
          <nav className="landing-footer__links" aria-label={t('site.footerAria')}>
            <button className="footer-link" onClick={() => setTab('howto')}>{t('site.nav.howto')}</button>
            <button className="footer-link" onClick={() => setTab('changelog')}>{t('site.nav.changelog')}</button>
            <button className="footer-link" onClick={() => setTab('press')}>{t('site.footer.press')}</button>
            <button className="footer-link" onClick={() => setTab('privacy')}>{t('site.footer.privacy')}</button>
            <button className="footer-link" onClick={() => setTab('credits')}>{t('site.footer.credits')}</button>
          </nav>
        </div>
        <div className="landing-footer__legal">© {new Date().getFullYear()} Orbital · orbital-empire.com</div>
      </footer>
    </div>
  );
};
