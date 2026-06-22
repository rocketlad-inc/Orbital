// ============================================================
// Landing - Marketing page shown before sign-in
// ============================================================

import React, { useEffect, useRef } from 'react';
import './Landing.css';

interface LandingProps {
  /** Triggered by the Login button or any CTA. Reveals the auth overlay. */
  onSignIn: () => void;
  /** Open the playtest-knobs sandbox. */
  onShowTunables?: () => void;
  /** Open the player-UX exploration gallery. */
  onShowUX?: () => void;
}

export const Landing: React.FC<LandingProps> = ({ onSignIn, onShowTunables, onShowUX }) => {
  const starfieldRef = useRef<HTMLCanvasElement>(null);

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
    <div className="landing">
      <canvas ref={starfieldRef} className="landing-starfield" />

      {/* Top nav */}
      <header className="landing-nav">
        <div className="landing-brand">
          <span className="brand-glyph">◉</span>
          <span className="brand-text">ORBITAL</span>
        </div>
        <div className="landing-nav-actions">
          {onShowUX && (
            <button className="landing-nav-link" onClick={onShowUX}>
              UX LAB
            </button>
          )}
          {onShowTunables && (
            <button className="landing-nav-link" onClick={onShowTunables}>
              TUNABLES
            </button>
          )}
          <button className="landing-login-btn" onClick={onSignIn}>
            LOGIN
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="landing-hero">
        <div className="hero-eyebrow">A REAL-TIME ORBITAL STRATEGY GAME</div>
        <h1 className="hero-title">
          ORBITAL
        </h1>
        <div className="hero-tagline">
          Burn between worlds. Build an empire across the Sol system.
          <br />
          Win by science, by conquest, or by building a sphere around the sun.
        </div>
        <div className="hero-cta">
          <button className="cta-primary" onClick={onSignIn}>
            ENTER COMMAND
          </button>
          <a className="cta-secondary" href="#what-is-it">
            LEARN MORE ↓
          </a>
        </div>

        {/* Inline animated solar system mock */}
        <div className="hero-mock" aria-hidden="true">
          <SolarSystemMock />
        </div>
      </section>

      {/* What is Orbital */}
      <section className="landing-section" id="what-is-it">
        <div className="section-eyebrow">— WHAT IS ORBITAL?</div>
        <h2 className="section-title">A Solar System on Rails</h2>
        <div className="section-body">
          <p>
            Orbital is a real-time strategy game played across the inner planets,
            the asteroid belt, and the gas giants. Ships ride a continuous-thrust
            torch from origin to target &mdash; every transfer commits you to a
            flight time and a fuel cost you can&rsquo;t take back, computed
            from the ship&rsquo;s engine and the distance to the rendezvous.
          </p>
          <p>
            Stake a claim by deploying <strong>cities on planets</strong> and{' '}
            <strong>stations in orbit</strong>. Both extract the body&rsquo;s
            yields, then ship them home through your collector network. Upgrade
            with forges, mints, labs, weapon platforms, and shipyards. Drop a
            collector or watch your income pile up unused.
          </p>
          <p>
            When two factions want the same moon, ships engage at range and
            settlements return fire. Veteran hulls grow deadlier with every kill;
            destroyers can shatter a city, but only if they survive the trip home
            to refuel.
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="landing-section landing-features-section">
        <div className="section-eyebrow">— THE LOOP</div>
        <h2 className="section-title">Four pillars of empire</h2>
        <div className="features-grid">
          <FeatureCard
            icon="↗"
            title="Torch trajectories"
            body="Plan transfers between any two bodies. The brachistochrone solver computes the burn schedule and fuel cost; chain legs together to patrol multiple moons. Faster engines come from the tech tree."
          />
          <FeatureCard
            icon="■"
            title="Cities, stations & upgrades"
            body="Drop cities for ore, mints, and labs. Station shipyards in orbit for fleet production and weapon platforms. Every settlement levels up — forges deepen, weapons heavier, science compounds."
          />
          <FeatureCard
            icon="◈"
            title="Fleets, combat & veterans"
            body="Build corvettes, frigates, destroyers, and freighters. Group them into fleets that transfer as one. Every kill bumps a hull&rsquo;s rank with permanent damage and HP bonuses — a senior destroyer is worth retreating."
          />
          <FeatureCard
            icon="✦"
            title="Research & exploration"
            body="Seven tech tracks scale weapons, armor, propulsion, sensors, and yields. Hidden caches, derelict warships, and ancient databanks wait on random moons — every match seeds them differently. Send ships out to find them."
          />
        </div>
      </section>

      {/* Three Paths to Victory */}
      <section className="landing-section">
        <div className="section-eyebrow">— THREE PATHS TO VICTORY</div>
        <h2 className="section-title">Decide how you win.</h2>
        <div className="features-grid">
          <FeatureCard
            icon="⚛"
            title="Science"
            body="Research every track to the top. Seven disciplines, ten levels each — the early levels are cheap but the last few are punishing. Found by the player whose labs run hottest."
          />
          <FeatureCard
            icon="✕"
            title="Military"
            body="Eliminate every rival settlement off the map. Pick your moment, build your destroyers, and start with the ones that can&rsquo;t fight back. Permanent. Loud."
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
          <ScreenshotCard caption="The Sol system at start — bodies, orbits, faction colors.">
            <ScreenshotSolarSystem />
          </ScreenshotCard>
          <ScreenshotCard caption="Plan a transfer. Pick a target, the torch curve appears with Δv and arrival ETA.">
            <ScreenshotTransfer />
          </ScreenshotCard>
          <ScreenshotCard caption="Deploy a city, name it, queue upgrades, watch population grow and stockpiles fill.">
            <ScreenshotSettlement />
          </ScreenshotCard>
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

      <footer className="landing-footer">
        <div className="footer-line">
          ORBITAL · v0.2 prototype · built with TypeScript, React, and a lot of brachistochrone
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
  caption: string;
  children: React.ReactNode;
}

const ScreenshotCard: React.FC<ScreenshotCardProps> = ({ caption, children }) => (
  <div className="screenshot-card">
    <div className="screenshot-frame">{children}</div>
    <div className="screenshot-caption">{caption}</div>
  </div>
);

// ============================================================
// Inline SVG mocks — represent the game's visual language without
// needing actual screenshot assets.
// ============================================================

const SolarSystemMock: React.FC = () => (
  <svg viewBox="0 0 600 360" className="hero-mock-svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff8e0" stopOpacity="0.95" />
        <stop offset="40%" stopColor="#ffd180" stopOpacity="0.7" />
        <stop offset="100%" stopColor="#ffa940" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="sunCore" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff8e0" />
        <stop offset="55%" stopColor="#ffd180" />
        <stop offset="100%" stopColor="#ffa940" />
      </radialGradient>
      <radialGradient id="earthGrad" cx="35%" cy="35%" r="65%">
        <stop offset="0%" stopColor="#7fb3d5" />
        <stop offset="80%" stopColor="#2c5d82" />
        <stop offset="100%" stopColor="#0a1e2e" />
      </radialGradient>
      <radialGradient id="marsGrad" cx="35%" cy="35%" r="65%">
        <stop offset="0%" stopColor="#d8784a" />
        <stop offset="80%" stopColor="#8a3b1e" />
        <stop offset="100%" stopColor="#2c130a" />
      </radialGradient>
    </defs>

    {/* Orbits */}
    <circle cx="300" cy="180" r="90" stroke="#2d4255" strokeWidth="1" fill="none" />
    <circle cx="300" cy="180" r="150" stroke="#3d2820" strokeWidth="1" fill="none" />

    {/* Sun glow + core */}
    <circle cx="300" cy="180" r="80" fill="url(#sunGlow)" />
    <circle cx="300" cy="180" r="14" fill="url(#sunCore)" />

    {/* Earth */}
    <circle cx="390" cy="180" r="9" fill="url(#earthGrad)" />
    <text x="390" y="208" textAnchor="middle" className="mock-label">EARTH</text>

    {/* Mars */}
    <circle cx="225" cy="245" r="7" fill="url(#marsGrad)" />
    <text x="225" y="270" textAnchor="middle" className="mock-label">MARS</text>

    {/* Bezier transfer arc */}
    <path
      d="M 390 180 C 410 100, 280 90, 225 245"
      stroke="#ffb84d"
      strokeWidth="1.5"
      fill="none"
      strokeDasharray="0"
    />

    {/* Ship */}
    <g transform="translate(330 130)">
      <circle r="4" fill="#4ecdc4" />
      <line x1="0" y1="0" x2="6" y2="-3" stroke="#6ee7b7" strokeWidth="1.5" />
      <text x="0" y="-12" textAnchor="middle" className="mock-label-sm">ROCINANTE</text>
    </g>
  </svg>
);

const ScreenshotSolarSystem: React.FC = () => (
  <svg viewBox="0 0 400 240" className="screenshot-svg" preserveAspectRatio="xMidYMid slice">
    <rect width="400" height="240" fill="#0a0e14" />
    {/* Stars */}
    {Array.from({ length: 60 }).map((_, i) => {
      const x = (i * 47) % 400;
      const y = (i * 89) % 240;
      const r = ((i * 13) % 100) > 90 ? 1.2 : 0.6;
      return <circle key={i} cx={x} cy={y} r={r} fill="rgba(220,230,255,0.6)" />;
    })}

    <defs>
      <radialGradient id="ss1Sun" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff8e0" />
        <stop offset="60%" stopColor="#ffd180" />
        <stop offset="100%" stopColor="rgba(255,169,64,0)" />
      </radialGradient>
    </defs>

    {/* Orbits */}
    <circle cx="200" cy="120" r="50" stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="85" stroke="#3d2820" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="115" stroke="#5a3a1a" strokeWidth="0.7" fill="none" />

    {/* Sun */}
    <circle cx="200" cy="120" r="40" fill="url(#ss1Sun)" />
    <circle cx="200" cy="120" r="8" fill="#fff8e0" />
    <text x="200" y="140" textAnchor="middle" className="ss-label">SOL</text>

    {/* Inner planet */}
    <circle cx="250" cy="120" r="4" fill="#7fb3d5" />
    <text x="250" y="135" textAnchor="middle" className="ss-label">EARTH</text>

    {/* Mid planet */}
    <circle cx="200" cy="205" r="3.5" fill="#d8784a" />
    <text x="200" y="220" textAnchor="middle" className="ss-label">MARS</text>

    {/* Outer planet (gas giant w/ ring) */}
    <ellipse cx="115" cy="120" rx="11" ry="2.5" stroke="#d4a574" strokeWidth="0.8" fill="none" />
    <circle cx="115" cy="120" r="6" fill="#d4a574" />
    <text x="115" y="138" textAnchor="middle" className="ss-label">JUPITER</text>

    {/* Ship */}
    <circle cx="245" cy="115" r="2.5" fill="#4ecdc4" />
  </svg>
);

const ScreenshotTransfer: React.FC = () => (
  <svg viewBox="0 0 400 240" className="screenshot-svg" preserveAspectRatio="xMidYMid slice">
    <rect width="400" height="240" fill="#0a0e14" />
    {Array.from({ length: 50 }).map((_, i) => {
      const x = (i * 41) % 400;
      const y = (i * 71) % 240;
      return <circle key={i} cx={x} cy={y} r={0.7} fill="rgba(220,230,255,0.5)" />;
    })}

    <defs>
      <radialGradient id="ss2Sun" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff8e0" />
        <stop offset="60%" stopColor="#ffd180" />
        <stop offset="100%" stopColor="rgba(255,169,64,0)" />
      </radialGradient>
    </defs>

    <circle cx="200" cy="120" r="55" stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="95" stroke="#3d2820" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="30" fill="url(#ss2Sun)" />
    <circle cx="200" cy="120" r="6" fill="#fff8e0" />

    {/* Earth */}
    <circle cx="255" cy="120" r="4.5" fill="#7fb3d5" />
    <text x="255" y="135" textAnchor="middle" className="ss-label">EARTH</text>

    {/* Mars (ghost — future pos) */}
    <circle cx="180" cy="210" r="4" fill="#d8784a" fillOpacity="0.4" />
    <circle cx="180" cy="210" r="4" stroke="#d8784a" strokeWidth="0.8" fill="none" strokeDasharray="2 2" />
    <text x="180" y="225" textAnchor="middle" className="ss-label" fill="rgba(216,120,74,0.7)">MARS T+45</text>

    {/* Dashed Bezier arc — planned transfer */}
    <path
      d="M 255 120 C 320 70, 230 60, 180 210"
      stroke="#ffb84d"
      strokeWidth="1.5"
      fill="none"
      strokeDasharray="5 5"
    />

    {/* Departure marker (diamond at Earth) */}
    <g transform="translate(255 120)">
      <polygon points="0,-5 5,0 0,5 -5,0" fill="none" stroke="#ffb84d" strokeWidth="1.2" />
    </g>

    {/* HUD-style info */}
    <g transform="translate(20 30)">
      <rect width="135" height="50" fill="rgba(10,14,20,0.85)" stroke="#ffb84d" strokeWidth="1" />
      <text x="8" y="14" className="ss-label" fill="#ffb84d">EARTH → MARS</text>
      <text x="8" y="28" className="ss-info">Δv 4.6 km/s</text>
      <text x="8" y="40" className="ss-info">ETA T+45</text>
    </g>
  </svg>
);

const ScreenshotSettlement: React.FC = () => (
  <svg viewBox="0 0 400 240" className="screenshot-svg" preserveAspectRatio="xMidYMid slice">
    <rect width="400" height="240" fill="#0a0e14" />
    {Array.from({ length: 40 }).map((_, i) => {
      const x = (i * 53) % 400;
      const y = (i * 67) % 240;
      return <circle key={i} cx={x} cy={y} r={0.6} fill="rgba(220,230,255,0.4)" />;
    })}

    <defs>
      <radialGradient id="ss3Mars" cx="35%" cy="35%" r="65%">
        <stop offset="0%" stopColor="#e8915a" />
        <stop offset="80%" stopColor="#8a3b1e" />
        <stop offset="100%" stopColor="#1a0a05" />
      </radialGradient>
    </defs>

    {/* Mars centered */}
    <circle cx="160" cy="120" r="55" fill="url(#ss3Mars)" />
    <circle cx="160" cy="120" r="65" stroke="rgba(216,120,74,0.3)" strokeWidth="2" fill="none" />

    {/* Surface city (square on surface) */}
    <g transform="translate(195 95)">
      <rect x="-3.5" y="-3.5" width="7" height="7" fill="#ff4444" stroke="#0a0e14" strokeWidth="1" />
      <circle cx="-4" cy="-8" r="0.8" fill="#ff4444" />
      <circle cx="-1" cy="-8" r="0.8" fill="#ff4444" />
      <circle cx="2" cy="-8" r="0.8" fill="#ff4444" />
    </g>

    {/* Orbital station (diamond on ring) */}
    <circle cx="160" cy="120" r="78" stroke="rgba(255,68,68,0.2)" strokeWidth="0.5" fill="none" strokeDasharray="2 3" />
    <g transform="translate(230 75)">
      <polygon points="0,-4.5 4.5,0 0,4.5 -4.5,0" fill="#ff4444" stroke="#0a0e14" strokeWidth="1" />
    </g>

    <text x="160" y="195" textAnchor="middle" className="ss-label">MARS</text>

    {/* HUD panel */}
    <g transform="translate(240 30)">
      <rect width="140" height="95" fill="rgba(10,14,20,0.9)" stroke="#2a3d50" strokeWidth="1" />
      <text x="8" y="14" className="ss-label" fill="#ffb84d">SETTLEMENTS</text>

      <g transform="translate(0 22)">
        <rect x="6" y="0" width="128" height="28" fill="rgba(255,184,77,0.08)" stroke="#ffb84d" strokeWidth="0.8" />
        <text x="12" y="11" className="ss-info" fill="#ff4444">■ NEW SHANGHAI</text>
        <text x="12" y="22" className="ss-info-sm">HP 200/200 · POP 3</text>
      </g>

      <g transform="translate(0 56)">
        <rect x="6" y="0" width="128" height="28" fill="rgba(78,205,196,0.05)" stroke="#2a3d50" strokeWidth="0.8" />
        <text x="12" y="11" className="ss-info" fill="#ff4444">◆ ARES STATION</text>
        <text x="12" y="22" className="ss-info-sm">HP 88/100 · POP 1</text>
      </g>
    </g>
  </svg>
);
