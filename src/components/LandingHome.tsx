// ============================================================
// LandingHome — the marketing home page (orbital-empire.com/, signed out).
//
// Every claim here was checked against the code on 2026-10-02 (vote weight
// is per system controlled, peace is the default, the Dyson costs, the
// $10 Commission is cosmetic, Android/Wear are in CLOSED testing). Keep it
// that way: when a rule changes, change the sentence. The FAQ text is
// mirrored as FAQPage structured data in public/index.html; edit both.
//
// Images live in public/landing/ (crops of marketing/sol-wars-screenshots,
// made by scratchpad landing_images.py) and public/clips/ (looping clips).
// ============================================================

import React, { useEffect, useState } from 'react';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './LandingHome.css';

interface Props {
  onSignIn: () => void;
}

/** A responsive WebP at 1x/2x. `w` is the 1x width the file was cut at. */
const Shot: React.FC<{ name: string; w: number; h: number; alt: string; eager?: boolean; className?: string }> = ({ name, w, h, alt, eager, className }) => (
  <img
    className={className}
    src={`/landing/${name}-${w}.webp`}
    srcSet={`/landing/${name}-${w}.webp 1x, /landing/${name}-${w * 2}.webp 2x`}
    width={w}
    height={h}
    alt={alt}
    loading={eager ? 'eager' : 'lazy'}
    decoding="async"
  />
);

/** A looping clip. The still poster paints first (and is all a visitor who
 *  asked for reduced motion ever sees); the animated file swaps in once the
 *  page has loaded, so a 5 MB loop never competes with the first paint. */
const Clip: React.FC<{ name: string; w: number; h: number; alt: string; eager?: boolean }> = ({ name, w, h, alt, eager }) => {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
    if (reduce) return;
    const go = () => setLive(true);
    if (document.readyState === 'complete') { const timer = window.setTimeout(go, eager ? 300 : 1200); return () => window.clearTimeout(timer); }
    window.addEventListener('load', go, { once: true });
    return () => window.removeEventListener('load', go);
  }, [eager]);
  return (
    <img
      src={live ? `/clips/${name}.webp` : `/clips/${name}-poster.webp`}
      width={w}
      height={h}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      // @ts-expect-error fetchpriority is valid HTML; React 18 types lag.
      fetchpriority={eager ? 'high' : undefined}
    />
  );
};

/** Frame with HUD corner brackets — the game's own viewscreen language. */
const Frame: React.FC<{ children: React.ReactNode; caption?: string; tone?: 'map' | 'panel' }> = ({ children, caption, tone = 'map' }) => (
  <figure className={`lh-frame lh-frame--${tone}`}>
    <div className="lh-frame__view">
      {children}
      <span className="lh-tick lh-tick--tl" aria-hidden />
      <span className="lh-tick lh-tick--tr" aria-hidden />
      <span className="lh-tick lh-tick--bl" aria-hidden />
      <span className="lh-tick lh-tick--br" aria-hidden />
    </div>
    {caption && <figcaption className="lh-frame__caption">{caption}</figcaption>}
  </figure>
);

// FAQ — mirrored in public/index.html as FAQPage JSON-LD. Edit both.
export const FAQ: Array<[string, string]> = [
  ['Is Orbital free?',
    'Yes. Orbital is free to play with no ads, and nothing that affects the game is for sale. An optional one-time Commander’s Commission ($10) unlocks ship designs, megastructure looks, premium emblems, and your games posted to your own Discord server.'],
  ['Do I need to download anything?',
    'No. Orbital runs in any modern browser on desktop, tablet or phone. Sign in with Google or an email address and join a game straight away.'],
  ['How long does a game last?',
    'There is no turn limit: a game runs until someone wins. The default is one turn an hour, which suits checking in a few times a day. Hosts can choose anything from a turn a minute to a turn a day.'],
  ['What happens while I’m offline?',
    'Your empire keeps going. Turns resolve on schedule, freighters keep running their routes and armed stations defend themselves. Nobody plays your empire for you, so set your orders before you log off.'],
  ['How many players are in a game?',
    'Two to ten. Quick Join drops you into the fullest open game, or you can browse the lobby or invite friends to a private game. You can even join a game that has already started, as long as a home world is still free.'],
  ['Is Orbital like Neptune’s Pride?',
    'If you have played Neptune’s Pride, the rhythm will feel familiar: a shared map, turns that run on a real clock, and alliances that matter. Orbital sets it in the real solar system and adds orbital flight, ship design, a Senate that writes the rules, and three different ways to win.'],
];

export const LandingHome: React.FC<Props> = ({ onSignIn }) => {
  useI18n();
  return (
  <main className="lh">
    {/* ── Hero ─────────────────────────────────────────────── */}
    <section className="lh-hero" aria-labelledby="lh-title">
      <div className="lh-hero__copy">
        <p className="lh-kicker">{t('landing.hero.kicker')}</p>
        <h1 id="lh-title" className="lh-h1">
          {t('landing.hero.h1')}
          <span className="lh-h1__soft"> {t('landing.hero.h1soft')}</span>
        </h1>
        <p className="lh-lede">
          {t('landing.hero.lede')}
        </p>
        <div className="lh-cta">
          <button className="lh-btn lh-btn--primary" onClick={onSignIn}>{t('landing.hero.play')}</button>
          <a className="lh-btn lh-btn--ghost" href="#how-it-plays">{t('landing.hero.see')}</a>
        </div>
        <ul className="lh-facts" aria-label={t('landing.hero.glance')}>
          <li><strong>2–10</strong> {t('landing.hero.f1')}</li>
          <li><strong>{t('landing.hero.f2a')}</strong> {t('landing.hero.f2b')}</li>
          <li><strong>3</strong> {t('landing.hero.f3')}</li>
          <li><strong>$0</strong> {t('landing.hero.f4')}</li>
        </ul>
      </div>
      <div className="lh-hero__visual">
        <div className="lh-orbits" aria-hidden />
        <Frame caption={t('landing.hero.caption')}>
          <Clip name="flight-mars-to-europa" w={960} h={540} eager
            alt={t('landing.hero.clipAlt')} />
        </Frame>
      </div>
    </section>

    {/* ── How a turn works ─────────────────────────────────── */}
    <section className="lh-section" id="how-it-plays" aria-labelledby="lh-loop">
      <header className="lh-head">
        <p className="lh-kicker">{t('landing.loop.kicker')}</p>
        <h2 id="lh-loop" className="lh-h2">{t('landing.loop.title')}</h2>
        <p className="lh-sub">
          {t('landing.loop.sub')}
        </p>
      </header>
      <div className="lh-loop">
        <ol className="lh-steps">
          <li>
            <span className="lh-steps__n" aria-hidden>01</span>
            <h3>{t('landing.loop.s1.title')}</h3>
            <p>{t('landing.loop.s1.body')}</p>
          </li>
          <li>
            <span className="lh-steps__n" aria-hidden>02</span>
            <h3>{t('landing.loop.s2.title')}</h3>
            <p>{t('landing.loop.s2.body')}</p>
          </li>
          <li>
            <span className="lh-steps__n" aria-hidden>03</span>
            <h3>{t('landing.loop.s3.title')}</h3>
            <p>{t('landing.loop.s3.body')}</p>
          </li>
        </ol>
        <Frame tone="panel" caption={t('landing.loop.caption')}>
          <Shot name="panel-sitrep" w={380} h={556}
            alt={t('landing.loop.shotAlt')} />
        </Frame>
      </div>
      <p className="lh-note">{t('landing.loop.note')}</p>
    </section>

    {/* ── Features ─────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-features">
      <header className="lh-head">
        <p className="lh-kicker">{t('landing.features.kicker')}</p>
        <h2 id="lh-features" className="lh-h2">{t('landing.features.title')}</h2>
      </header>

      <article className="lh-feature">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">{t('landing.f1.title')}</h3>
          <p>
            {t('landing.f1.body')}
          </p>
          <ul className="lh-list">
            <li>{t('landing.f1.l1')}</li>
            <li>{t('landing.f1.l2')}</li>
            <li>{t('landing.f1.l3')}</li>
          </ul>
        </div>
        <Frame caption={t('landing.f1.caption')}>
          <Shot name="map-system" w={720} h={506}
            alt={t('landing.f1.shotAlt')} />
        </Frame>
      </article>

      <article className="lh-feature lh-feature--flip">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">{t('landing.f2.title')}</h3>
          <p>
            {t('landing.f2.body')}
          </p>
          <ul className="lh-list">
            <li>{t('landing.f2.l1')}</li>
            <li>{t('landing.f2.l2')}</li>
            <li>{t('landing.f2.l3')}</li>
          </ul>
        </div>
        <Frame caption={t('landing.f2.caption')}>
          <Shot name="battle-europa" w={720} h={519}
            alt={t('landing.f2.shotAlt')} />
        </Frame>
      </article>

      <article className="lh-feature">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">{t('landing.f3.title')}</h3>
          <p>
            {t('landing.f3.body')}
          </p>
          <ul className="lh-list">
            <li>{t('landing.f3.l1')}</li>
            <li>{t('landing.f3.l2')}</li>
            <li>{t('landing.f3.l3')}</li>
          </ul>
        </div>
        <Frame caption={t('landing.f3.caption')}>
          <Shot name="world-mars" w={720} h={498}
            alt={t('landing.f3.shotAlt')} />
        </Frame>
      </article>

      <article className="lh-feature lh-feature--flip">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">{t('landing.f4.title')}</h3>
          <p>
            {t('landing.f4.body')}
          </p>
          <ul className="lh-list">
            <li>{t('landing.f4.l1')}</li>
            <li>{t('landing.f4.l2')}</li>
            <li>{t('landing.f4.l3')}</li>
          </ul>
        </div>
        <Frame tone="panel" caption={t('landing.f4.caption')}>
          <Shot name="panel-empires" w={380} h={681}
            alt={t('landing.f4.shotAlt')} />
        </Frame>
      </article>
    </section>

    {/* ── Victory ──────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-win">
      <header className="lh-head">
        <p className="lh-kicker">{t('landing.win.kicker')}</p>
        <h2 id="lh-win" className="lh-h2">{t('landing.win.title')}</h2>
      </header>
      <div className="lh-wins">
        <article className="lh-win">
          <Shot className="lh-win__img" name="raid-saturn" w={520} h={505} alt={t('landing.win.raidAlt')} />
          <div className="lh-win__body">
            <h3 className="lh-h3">{t('landing.win.dom.title')}</h3>
            <p>{t('landing.win.dom.body')}</p>
          </div>
        </article>
        <article className="lh-win">
          <Shot className="lh-win__img" name="panel-victory" w={380} h={244} alt={t('landing.win.trackerAlt')} />
          <div className="lh-win__body">
            <h3 className="lh-h3">{t('landing.win.chan.title')}</h3>
            <p>{t('landing.win.chan.body')}</p>
          </div>
        </article>
        <article className="lh-win">
          <Shot className="lh-win__img" name="dyson" w={520} h={491} alt={t('landing.win.dysonAlt')} />
          <div className="lh-win__body">
            <h3 className="lh-h3">{t('landing.win.dyson.title')}</h3>
            <p>{t('landing.win.dyson.body')}</p>
          </div>
        </article>
      </div>
    </section>

    {/* ── Scenes ───────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-scenes">
      <header className="lh-head">
        <p className="lh-kicker">{t('landing.scenes.kicker')}</p>
        <h2 id="lh-scenes" className="lh-h2">{t('landing.scenes.title')}</h2>
      </header>
      <div className="lh-scenes">
        <Frame caption={t('landing.scenes.zoomCaption')}>
          <Clip name="zoom-system-to-mars" w={640} h={360} alt={t('landing.scenes.zoomAlt')} />
        </Frame>
        <Frame caption={t('landing.scenes.megaCaption')}>
          <Clip name="mega-destroyer-over-luna" w={640} h={360} alt={t('landing.scenes.megaAlt')} />
        </Frame>
        <Frame caption={t('landing.scenes.tritonCaption')}>
          <Shot name="battle-triton" w={520} h={519} alt={t('landing.scenes.tritonAlt')} />
        </Frame>
        <Frame caption={t('landing.scenes.charonCaption')}>
          <Shot name="battle-charon" w={520} h={505} alt={t('landing.scenes.charonAlt')} />
        </Frame>
      </div>
    </section>

    {/* ── Platforms ────────────────────────────────────────── */}
    <section className="lh-section lh-platforms" aria-labelledby="lh-anywhere">
      <div className="lh-platforms__copy">
        <p className="lh-kicker">{t('landing.anywhere.kicker')}</p>
        <h2 id="lh-anywhere" className="lh-h2">{t('landing.anywhere.title')}</h2>
        <p className="lh-sub">
          {t('landing.anywhere.sub')}
        </p>
        <button className="lh-btn lh-btn--primary" onClick={onSignIn}>{t('landing.hero.play')}</button>
      </div>
      <div className="lh-phones">
        {[
          ['phone-battle-of-mars', t('landing.anywhere.phone1')],
          ['phone-world-menu-earth', t('landing.anywhere.phone2')],
          ['phone-empires', t('landing.anywhere.phone3')],
        ].map(([name, alt]) => (
          <div className="lh-phone" key={name}>
            <img src={`/screenshots/${name}-360.webp`} srcSet={`/screenshots/${name}-360.webp 1x, /screenshots/${name}-720.webp 2x`}
              width={360} height={799} alt={alt} loading="lazy" decoding="async" />
          </div>
        ))}
      </div>
    </section>

    {/* ── FAQ ──────────────────────────────────────────────── */}
    <section className="lh-section lh-faq" aria-labelledby="lh-faq">
      <header className="lh-head">
        <p className="lh-kicker">{t('landing.faq.kicker')}</p>
        <h2 id="lh-faq" className="lh-h2">{t('landing.faq.title')}</h2>
      </header>
      <div className="lh-faq__list">
        {FAQ.map(([q, a], i) => (
          <details key={q} className="lh-q">
            <summary><h3>{tk(`landing.faq.${i + 1}.q`, q)}</h3></summary>
            <p>{tk(`landing.faq.${i + 1}.a`, a)}</p>
          </details>
        ))}
      </div>
    </section>

    {/* ── Closing CTA ──────────────────────────────────────── */}
    <section className="lh-final" aria-labelledby="lh-final">
      <div className="lh-final__bg" aria-hidden>
        <Shot name="battle-europa" w={720} h={519} alt="" />
      </div>
      <div className="lh-final__copy">
        <h2 id="lh-final" className="lh-h2">{t('landing.final.title')}</h2>
        <p className="lh-sub">{t('landing.final.sub')}</p>
        <button className="lh-btn lh-btn--primary lh-btn--lg" onClick={onSignIn}>{t('landing.hero.play')}</button>
        <p className="lh-fine">{t('landing.final.fine')}</p>
      </div>
    </section>
  </main>
  );
};
