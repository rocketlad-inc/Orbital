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
    if (document.readyState === 'complete') { const t = window.setTimeout(go, eager ? 300 : 1200); return () => window.clearTimeout(t); }
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
    'Two to eight. Quick Join drops you into the fullest open game, or you can browse the lobby or invite friends to a private game. You can even join a game that has already started, as long as a home world is still free.'],
  ['Is Orbital like Neptune’s Pride?',
    'If you have played Neptune’s Pride, the rhythm will feel familiar: a shared map, turns that run on a real clock, and alliances that matter. Orbital sets it in the real solar system and adds orbital flight, ship design, a Senate that writes the rules, and three different ways to win.'],
];

export const LandingHome: React.FC<Props> = ({ onSignIn }) => (
  <main className="lh">
    {/* ── Hero ─────────────────────────────────────────────── */}
    <section className="lh-hero" aria-labelledby="lh-title">
      <div className="lh-hero__copy">
        <p className="lh-kicker">Free multiplayer space strategy · Plays in your browser</p>
        <h1 id="lh-title" className="lh-h1">
          Conquer the solar system.
          <span className="lh-h1__soft"> One hour at a time.</span>
        </h1>
        <p className="lh-lede">
          Orbital is a persistent real-time strategy game for two to eight players, set across
          the real Sol system. Send fleets between moving worlds, build and terraform colonies,
          bend the Senate to your will, and come back to find out what your rivals did overnight.
        </p>
        <div className="lh-cta">
          <button className="lh-btn lh-btn--primary" onClick={onSignIn}>Play free</button>
          <a className="lh-btn lh-btn--ghost" href="#how-it-plays">See how it plays</a>
        </div>
        <ul className="lh-facts" aria-label="At a glance">
          <li><strong>2–8</strong> players</li>
          <li><strong>1 hr</strong> turns, or your pick</li>
          <li><strong>3</strong> ways to win</li>
          <li><strong>$0</strong> no ads</li>
        </ul>
      </div>
      <div className="lh-hero__visual">
        <div className="lh-orbits" aria-hidden />
        <Frame caption="Recorded in a live eight-empire game: a siege at Mars, a raid caught mid-flight, a fleet action at Europa.">
          <Clip name="flight-mars-to-europa" w={960} h={540} eager
            alt="The camera pulls back from a battle over Mars, pans across the inner solar system past a fight between two fleets in flight, and dives into a battle over Europa." />
        </Frame>
      </div>
    </section>

    {/* ── How a turn works ─────────────────────────────────── */}
    <section className="lh-section" id="how-it-plays" aria-labelledby="lh-loop">
      <header className="lh-head">
        <p className="lh-kicker">How it plays</p>
        <h2 id="lh-loop" className="lh-h2">The game keeps running when you log off</h2>
        <p className="lh-sub">
          Turns resolve on the server on a real schedule. You don’t need to be online when they do,
          only when it matters.
        </p>
      </header>
      <div className="lh-loop">
        <ol className="lh-steps">
          <li>
            <span className="lh-steps__n" aria-hidden>01</span>
            <h3>Give your orders</h3>
            <p>Send fleets, queue ships at your yards, propose laws, make offers. A few minutes is enough.</p>
          </li>
          <li>
            <span className="lh-steps__n" aria-hidden>02</span>
            <h3>The clock ticks</h3>
            <p>Every turn, ships move, battles resolve and economies pay out — hourly by default, whether you’re watching or not.</p>
          </li>
          <li>
            <span className="lh-steps__n" aria-hidden>03</span>
            <h3>Read the briefing</h3>
            <p>The Situation Report shows what changed: fights in progress, fleets inbound, idle shipyards, decisions waiting on you.</p>
          </li>
        </ol>
        <Frame tone="panel" caption="The Situation Report, as a player saw it this morning.">
          <Shot name="panel-sitrep" w={380} h={556}
            alt="The Situation Report panel: thirteen hostiles inbound to Pallas, the Battle of Mars in progress, and four decisions waiting." />
        </Frame>
      </div>
      <p className="lh-note">Alerts reach you by browser notification, Discord or email.</p>
    </section>

    {/* ── Features ─────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-features">
      <header className="lh-head">
        <p className="lh-kicker">The game</p>
        <h2 id="lh-features" className="lh-h2">Everything an empire needs, and nothing it can take for granted</h2>
      </header>

      <article className="lh-feature">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">The real solar system is the map</h3>
          <p>
            From the Sun out past Pluto, every world sits where it really is and moves along its
            orbit. Distances change as the planets turn, so choosing when to launch is part of the plan,
            and a long flight is a commitment your rivals can see coming.
          </p>
          <ul className="lh-list">
            <li>Planets, moons, the asteroid belt, the Kuiper Belt and the Far Reach beyond it</li>
            <li>Even the Sun can be claimed</li>
            <li>Hidden discoveries: derelict warships, ancient databanks, lost gates</li>
          </ul>
        </div>
        <Frame caption="Eight empires across the inner system, the belt and the gas giants.">
          <Shot name="map-system" w={720} h={506}
            alt="The whole solar system zoomed out, ringed by each empire's territory, with fleets and outposts across it." />
        </Frame>
      </article>

      <article className="lh-feature lh-feature--flip">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">Design the fleet. Choose the fight.</h3>
          <p>
            Build corvettes, frigates and destroyers to your own designs. Railguns or energy lances,
            armour or shields, flak, repair bays: shields blunt kinetic fire and armour blunts energy,
            so the right loadout depends on who you’re fighting. Fleets clash in orbit, and can be
            caught and fought in mid-flight.
          </p>
          <ul className="lh-list">
            <li>Captains who rank up with every kill</li>
            <li>Megastructures: Warp Gates, Weapons Stations, the planet-wrecking Mega Destroyer</li>
            <li>Battles can be replayed afterwards as recaps</li>
          </ul>
        </div>
        <Frame caption="Railgun slugs and energy lances over Europa.">
          <Shot name="battle-europa" w={720} h={519}
            alt="Two fleets, orange and violet, exchange fire in orbit around Europa." />
        </Frame>
      </article>

      <article className="lh-feature">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">Build, terraform, expand</h3>
          <p>
            Plant stations in orbit and cities on the ground. Terraform raw worlds into living ones,
            raise forges, mints, labs and shipyards, and run freighters to haul what you mine back home.
            Every shipment is physical, and every shipment can be raided.
          </p>
          <ul className="lh-list">
            <li>Six research tracks, from weapons to sensors</li>
            <li>Trade with rivals on an open market</li>
            <li>Mine drifting meteoroids for metal and credits</li>
          </ul>
        </div>
        <Frame caption="A terraformed Mars: the capital, its buildings and the shipyard queue.">
          <Shot name="world-mars" w={720} h={498}
            alt="The Mars world menu: a red city on the planet's surface, its forge, mint, lab and shields, and the shipyard's build queue." />
        </Frame>
      </article>

      <article className="lh-feature lh-feature--flip">
        <div className="lh-feature__copy">
          <h3 className="lh-h3">Politics with teeth</h3>
          <p>
            Every game starts at peace. War is declared, not assumed, and ending one takes both sides.
            Sign pacts, trade and share intelligence, then take it to the Senate, where passed laws
            change yields, costs and damage for everyone, and sanctions land on whoever you name.
          </p>
          <ul className="lh-list">
            <li>Your vote weight grows with the systems you control</li>
            <li>The Sensors track decides how much you know about your rivals</li>
            <li>Alliances are made by players, not scripts</li>
          </ul>
        </div>
        <Frame tone="panel" caption="Standings, alliances and wars in a live game.">
          <Shot name="panel-empires" w={380} h={681}
            alt="The empire standings panel: eight factions, their resources and fleets, marked allied, neutral or at war." />
        </Frame>
      </article>
    </section>

    {/* ── Victory ──────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-win">
      <header className="lh-head">
        <p className="lh-kicker">Victory</p>
        <h2 id="lh-win" className="lh-h2">Three ways to win. Every rival can stop you.</h2>
      </header>
      <div className="lh-wins">
        <article className="lh-win">
          <Shot className="lh-win__img" name="raid-saturn" w={520} h={505} alt="A raiding fleet closing on Saturn." />
          <div className="lh-win__body">
            <h3 className="lh-h3">Domination</h3>
            <p>Hold more than 60% of the worlds in play (the host can change the bar). The Sun counts.</p>
          </div>
        </article>
        <article className="lh-win">
          <Shot className="lh-win__img" name="panel-victory" w={380} h={244} alt="The paths-to-victory tracker: the chancellor vote, the Dyson Sphere and domination." />
          <div className="lh-win__body">
            <h3 className="lh-h3">Supreme Chancellor</h3>
            <p>Win the Senate’s vote. Each empire gets one bid per game, and the vote stays open for 48 turns, long enough for rivals to rally against you.</p>
          </div>
        </article>
        <article className="lh-win">
          <Shot className="lh-win__img" name="dyson" w={520} h={491} alt="A Dyson Sphere under construction around the Sun." />
          <div className="lh-win__body">
            <h3 className="lh-h3">The Dyson Sphere</h3>
            <p>Found a station in orbit of the Sun and feed it 15,000 metal, 15,000 credits and 10,000 science. Rivals can destroy the foundation, and whoever rebuilds it keeps most of the progress.</p>
          </div>
        </article>
      </div>
    </section>

    {/* ── Scenes ───────────────────────────────────────────── */}
    <section className="lh-section" aria-labelledby="lh-scenes">
      <header className="lh-head">
        <p className="lh-kicker">From a live game</p>
        <h2 id="lh-scenes" className="lh-h2">Scenes from the war for Sol</h2>
      </header>
      <div className="lh-scenes">
        <Frame caption="From the whole system down to one battle in a single scroll.">
          <Clip name="zoom-system-to-mars" w={640} h={360} alt="The camera zooms from the whole solar system down to a battle over Mars." />
        </Frame>
        <Frame caption="A Mega Destroyer holds orbit over Luna. Two strikes and a world is rubble.">
          <Clip name="mega-destroyer-over-luna" w={640} h={360} alt="A Mega Destroyer in orbit over Luna, its red targeting ring around it." />
        </Frame>
        <Frame caption="Neptune’s fleet meets the defenders of Triton.">
          <Shot name="battle-triton" w={520} h={519} alt="Teal and pink fleets exchange fire around Triton." />
        </Frame>
        <Frame caption="Charon, under siege at the edge of the system.">
          <Shot name="battle-charon" w={520} h={505} alt="Yellow and teal fleets fight in orbit around Charon." />
        </Frame>
      </div>
    </section>

    {/* ── Platforms ────────────────────────────────────────── */}
    <section className="lh-section lh-platforms" aria-labelledby="lh-anywhere">
      <div className="lh-platforms__copy">
        <p className="lh-kicker">Anywhere</p>
        <h2 id="lh-anywhere" className="lh-h2">Your empire fits in your pocket</h2>
        <p className="lh-sub">
          Orbital runs in any modern browser on desktop, tablet and phone, with a layout built for touch.
          There is nothing to install. Android and Wear OS apps, with home-screen widgets, are in testing.
        </p>
        <button className="lh-btn lh-btn--primary" onClick={onSignIn}>Play free</button>
      </div>
      <div className="lh-phones">
        {[
          ['phone-battle-of-mars', 'The battle over Mars on a phone.'],
          ['phone-world-menu-earth', 'Earth’s world menu on a phone.'],
          ['phone-empires', 'The empire standings on a phone.'],
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
        <p className="lh-kicker">Questions</p>
        <h2 id="lh-faq" className="lh-h2">Before you take command</h2>
      </header>
      <div className="lh-faq__list">
        {FAQ.map(([q, a]) => (
          <details key={q} className="lh-q">
            <summary><h3>{q}</h3></summary>
            <p>{a}</p>
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
        <h2 id="lh-final" className="lh-h2">Your seat in the system is waiting</h2>
        <p className="lh-sub">Join an open game in one click, or start a private one for your group.</p>
        <button className="lh-btn lh-btn--primary lh-btn--lg" onClick={onSignIn}>Play free</button>
        <p className="lh-fine">Free · No download · No ads</p>
      </div>
    </section>
  </main>
);
