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

function tabFromPath(): LandingTab {
  if (typeof window === 'undefined') return 'about';
  return TAB_PATHS[window.location.pathname] ?? 'about';
}

export const Landing: React.FC<LandingProps> = ({ onSignIn, authed = false, onExit }) => {
  const starfieldRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<LandingTab>(tabFromPath);

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
        <div className="landing-brand">
          <span className="brand-glyph">◉</span>
          <span className="brand-text">ORBITAL</span>
        </div>
        <div className="landing-nav-actions">
          <button
            className={`landing-tab-btn${tab === 'about' ? ' is-active' : ''}`}
            onClick={() => setTab('about')}
          >
            ABOUT
          </button>
          <button
            className={`landing-tab-btn${tab === 'howto' ? ' is-active' : ''}`}
            onClick={() => setTab('howto')}
          >
            HOW TO PLAY
          </button>
          <button
            className={`landing-tab-btn${tab === 'changelog' ? ' is-active' : ''}`}
            onClick={() => setTab('changelog')}
          >
            CHANGELOG
          </button>
          {authed ? (
            <button className="landing-login-btn" onClick={onExit}>
              ← BACK TO GAME
            </button>
          ) : (
            <button className="landing-login-btn" onClick={onSignIn}>
              LOGIN
            </button>
          )}
        </div>
      </header>

      {tab === 'howto' && <HowToPlay onSignIn={onSignIn} />}

      {tab === 'privacy' && <PrivacyPolicy />}

      {tab === 'press' && <PressKit />}

      {tab === 'credits' && <Credits />}

      {tab === 'changelog' && (
        <Changelog
          ctaLabel={authed ? '← BACK TO GAME' : 'PLAY ORBITAL'}
          onCta={authed ? (onExit ?? onSignIn) : onSignIn}
        />
      )}

      {tab === 'about' && (
        <>
      {/* Hero */}
      <section className="landing-hero">
        <div className="hero-eyebrow">A REAL-TIME ORBITAL STRATEGY GAME</div>
        <h1 className="hero-title">
          ORBITAL
        </h1>
        <div className="hero-tagline">
          Burn between worlds. Build an empire across the Sol system.
          <br />
          One hour per turn, running whether you&rsquo;re watching or not.
          <br />
          Win by conquest, by politics, or by building a sphere around the sun.
        </div>
        <div className="hero-cta">
          <button className="cta-primary" onClick={onSignIn}>
            ENTER COMMAND
          </button>
          <a className="cta-secondary" href="#what-is-it">
            LEARN MORE ↓
          </a>
        </div>

        <div className="hero-shot">
          <img
            src="/screenshots/hero-battle-of-mars-1920.webp"
            srcSet="/screenshots/hero-battle-of-mars-960.webp 960w, /screenshots/hero-battle-of-mars-1920.webp 1920w"
            sizes="(max-width: 820px) 100vw, 780px"
            width={1920}
            height={1533}
            alt="A live game: three fleets fight in orbit over the Martian Combine's capital on Mars."
          />
        </div>
      </section>

      {/* What is Orbital */}
      <section className="landing-section" id="what-is-it">
        <div className="section-eyebrow">— WHAT IS ORBITAL?</div>
        <h2 className="section-title">A Solar System on Rails</h2>
        <div className="section-body">
          <p>
            Orbital is a real-time strategy game played across the whole Sol
            system &mdash; inner planets, the asteroid belt, the gas giants and
            their moons, out to the dwarf worlds of the Kuiper belt. Ships ride
            a continuous-thrust torch from origin to target: every transfer
            commits you to a flight time you can&rsquo;t take back, computed
            from the ship&rsquo;s engine and the distance to the rendezvous.
          </p>
          <p>
            The clock never stops. A turn is an hour of real time and the
            simulation ticks whether or not you&rsquo;re logged in, so an empire
            runs in the background and you drop in to give orders &mdash; a
            fleet you sent last night has arrived, fought, and repaired by
            morning. Play it solo against the sim, or share a system with a
            lobby of other people.
          </p>
          <p>
            Stake a claim by deploying <strong>cities on planets</strong> and{' '}
            <strong>stations in orbit</strong>. Raw worlds hoard their harvest
            on-site &mdash; run freighter supply lines to{' '}
            <strong>terraform</strong> them, and a living world pays its full
            yield home, hosts cities, and anchors your trade. Upgrade with
            forges, mints, labs, weapon platforms, and shipyards.
          </p>
          <p>
            When two factions want the same moon, fleets trade fire one target
            at a time &mdash; warships first, then the freighters, and only once
            the orbit is clear does anyone touch a settlement. Armed stations
            shoot back; cities never do. Veteran hulls grow deadlier with every
            kill, and a mauled destroyer has to limp back to a shipyard to
            repair.
          </p>
          <p>
            Rivals are people, so the fight is only half the game. Sign
            non-aggression pacts and defence treaties, swap resources through
            player-to-player trade offers, run freighters on standing trade
            routes, and take proposals to a <strong>senate</strong> whose votes
            bend the rules for everyone &mdash; damage multipliers, embargoes,
            formal declarations of war.
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="landing-section landing-features-section">
        <div className="section-eyebrow">— THE LOOP</div>
        <h2 className="section-title">Six pillars of empire</h2>
        <div className="features-grid">
          <FeatureCard
            icon="↗"
            title="Torch trajectories"
            body="Plan transfers between any two bodies. The brachistochrone solver computes the burn schedule and arrival time; chain legs together to patrol multiple moons. Faster engines come from the tech tree — and from the 🔥 boosters you fit in the ship designer."
          />
          <FeatureCard
            icon="■"
            title="Cities, stations & upgrades"
            body="Drop cities for metal, mints, and labs. Station shipyards in orbit for fleet production and weapon platforms. Every settlement levels up — forges deepen, weapons heavier, science compounds."
          />
          <FeatureCard
            icon="◈"
            title="Fleets, combat & veterans"
            body="Build corvettes, frigates, destroyers, and freighters. Group them into fleets that transfer as one. Combat is round-robin: each hull picks one target, warships before civilians, orbit before ground. Every kill bumps a rank with permanent damage and HP bonuses — a senior destroyer is worth retreating."
          />
          <FeatureCard
            icon="⚙"
            title="Ship designer & captains"
            body="Design your own hulls — weapons, shields, armour plate, engines, detonators — and pick the silhouette they fly under. Name your ships, then crew them with captains whose traits carry real weight: sharper gunnery, tougher hulls, longer sensor reach."
          />
          <FeatureCard
            icon="⚖"
            title="Diplomacy & the senate"
            body="Non-aggression pacts, defence treaties, intel sharing. Trade resources directly with rivals or run freighters on repeating routes. Propose motions to a shared senate — embargoes, war authorisations, economy-wide multipliers — and live with whatever passes."
          />
          <FeatureCard
            icon="✦"
            title="Research & exploration"
            body="Six tech tracks — weapons, defense, propulsion, construction, society, sensors — each capped at level 10. You start with a corvette and a colony ship; everything else is behind research, arriving one piece at a time. Sensors are their own ladder: rival fleet counts, economies, loadouts and finally the whole map. Hidden caches, derelict warships, and ancient databanks wait on random moons; every match seeds them differently."
          />
        </div>
      </section>

      {/* Three Paths to Victory */}
      <section className="landing-section">
        <div className="section-eyebrow">— THREE PATHS TO VICTORY</div>
        <h2 className="section-title">Decide how you win.</h2>
        <div className="features-grid">
          <FeatureCard
            icon="◉"
            title="Domination"
            body="Claim more than 60% of the worlds on the map — anywhere a station can orbit counts, the sun included. Expand faster than your rivals can, or take what they&rsquo;ve built. Loud or quiet, territory wins."
          />
          <FeatureCard
            icon="🏛"
            title="Political"
            body="Get elected Supreme Chancellor. Every planet you hold is a vote in the Senate — build a coalition, call the chancellor bill to the floor, and end the war with a gavel instead of a fleet."
          />
          <FeatureCard
            icon="☀"
            title="Engineering"
            body="Build the Dyson Sphere around the sun. Lay the foundation at a Sol-orbit station, then run freighters in to deliver every resource it asks for. Rivals can blow up the foundation."
          />
        </div>
      </section>

      {/* Screenshots */}
      <section className="landing-section">
        <div className="section-eyebrow">— FROM THE BRIDGE</div>
        <h2 className="section-title">What you&rsquo;ll see</h2>
        <div className="screenshots-grid">
          <ScreenshotCard
            name="system-overview"
            alt="The whole Sol system zoomed out, with fleets and markers spread across its regions."
            caption="The whole system at once: eight empires, from the inner worlds out past Pluto."
          />
          <ScreenshotCard
            name="mega-destroyer-over-luna"
            height={450}
            alt="A Mega Destroyer's targeting ring locked onto Luna while a station burns nearby."
            caption="A Mega Destroyer takes aim at Luna. Two strikes and a world is rubble."
          />
          <ScreenshotCard
            name="dyson-sphere"
            height={540}
            alt="The Dyson Sphere, a dashed ring of segments, partly built around the Sun."
            caption="The Dyson Sphere, well under way. Finish it and you win the game."
          />
          <ScreenshotCard
            name="world-menu-earth"
            alt="Earth's world menu, showing its settlement, buildings and stockpiles."
            caption="Every world has a menu: settle it, build on it, trade from it."
          />
          <ScreenshotCard
            name="fleet-panel"
            alt="A fleet selected over Mars, with its ships and orders listed in the side panel."
            caption="Fleets fly as one. Pick a target and they burn there on a real trajectory."
          />
          <ScreenshotCard
            name="situation-report"
            alt="The Situation Report panel listing wars, threats and what needs attention."
            caption="The Situation Report tells you what changed while you were away."
          />
        </div>

        <h3 className="phone-title">And on your phone</h3>
        <div className="phone-strip">
          <PhoneShot name="phone-battle-of-mars" alt="The battle over Mars on a phone screen." />
          <PhoneShot name="phone-world-menu-earth" alt="Earth's world menu on a phone screen." />
          <PhoneShot name="phone-empires" alt="The empires standings on a phone screen." />
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="landing-section landing-cta-section">
        <h2 className="cta-title">Pick a faction. Lay the first stone.</h2>
        <button className="cta-primary cta-large" onClick={onSignIn}>
          CREATE ACCOUNT
        </button>
        <div className="cta-sub">Free. No download. Runs in your browser. Solo or multiplayer.</div>
      </section>
        </>
      )}

      <footer className="landing-footer">
        <div className="footer-line">
          ORBITAL · v0.3 alpha · built with TypeScript, React, and a lot of brachistochrone
        </div>
        <div className="footer-line">
          <button className="footer-link" onClick={() => setTab('press')}>Press kit</button>
          {' · '}
          <button className="footer-link" onClick={() => setTab('privacy')}>Privacy Policy</button>
          {' · '}
          <button className="footer-link" onClick={() => setTab('credits')}>Credits</button>
        </div>
      </footer>
    </div>
  );
};

// ============================================================
// Feature card
// ============================================================

interface FeatureCardProps {
  icon: string;
  title: string;
  body: string;
}

const FeatureCard: React.FC<FeatureCardProps> = ({ icon, title, body }) => (
  <div className="feature-card">
    <div className="feature-icon">{icon}</div>
    <div className="feature-title">{title}</div>
    <div className="feature-body">{body}</div>
  </div>
);

// ============================================================
// Screenshot card wrapper
// ============================================================

interface ScreenshotCardProps {
  /** Base name under /screenshots/; the -800 and -1600 WebP copies must exist. */
  name: string;
  alt: string;
  caption: string;
  /** Pixel height of the 800-wide copy (for layout before it loads). */
  height?: number;
}

// Real frames from a staged eight-empire game. Click through for the big copy.
const ScreenshotCard: React.FC<ScreenshotCardProps> = ({ name, alt, caption, height = 450 }) => (
  <figure className="screenshot-card">
    <a className="screenshot-frame" href={`/screenshots/${name}-1600.webp`} target="_blank" rel="noopener">
      <img
        src={`/screenshots/${name}-800.webp`}
        srcSet={`/screenshots/${name}-800.webp 800w, /screenshots/${name}-1600.webp 1600w`}
        sizes="(max-width: 700px) 100vw, 360px"
        width={800}
        height={height}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </a>
    <figcaption className="screenshot-caption">{caption}</figcaption>
  </figure>
);

const PhoneShot: React.FC<{ name: string; alt: string }> = ({ name, alt }) => (
  <a className="phone-frame" href={`/screenshots/${name}-720.webp`} target="_blank" rel="noopener">
    <img
      src={`/screenshots/${name}-360.webp`}
      srcSet={`/screenshots/${name}-360.webp 360w, /screenshots/${name}-720.webp 720w`}
      sizes="220px"
      width={360}
      height={799}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  </a>
);
