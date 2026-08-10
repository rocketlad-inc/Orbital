// ============================================================
// HowToPlay — the "HOW TO PLAY" tab on the landing page.
//
// Written for someone who has never seen the game. Rules:
//   - Plain language. No jargon before it's explained.
//   - Every concept earns a picture. The screenshots are real
//     renderer output (public/howto/*.jpg) — captured by driving
//     the actual map renderer, not mockups.
//   - Ordered as a first session actually goes: what am I looking
//     at → what do I do first → how do I grow → how do I fight →
//     how do I win.
// ============================================================

import React from 'react';
import './HowToPlay.css';

interface Props {
  onSignIn: () => void;
}

/** One numbered teaching beat: picture on one side, words on the other. */
const Beat: React.FC<{
  n: number;
  title: string;
  img: string;
  alt: string;
  flip?: boolean;
  children: React.ReactNode;
}> = ({ n, title, img, alt, flip, children }) => (
  <section className={`htp-beat${flip ? ' htp-beat--flip' : ''}`}>
    <figure className="htp-shot">
      <img src={img} alt={alt} loading="lazy" width={1200} height={675} />
    </figure>
    <div className="htp-copy">
      <div className="htp-step">STEP {n}</div>
      <h3 className="htp-beat-title">{title}</h3>
      {children}
    </div>
  </section>
);

export const HowToPlay: React.FC<Props> = ({ onSignIn }) => (
  <div className="htp">
    <header className="htp-hero">
      <div className="htp-eyebrow">— HOW TO PLAY</div>
      <h1 className="htp-title">Your first hour in Orbital</h1>
      <p className="htp-lede">
        Orbital is a strategy game about running a space empire across the
        real solar system. You found colonies, build ships, trade, argue in
        a senate, and fight over planets. It plays in your browser, and it
        keeps running when you close the tab.
      </p>
      <div className="htp-facts">
        <div className="htp-fact">
          <b>1 hour = 1 turn</b>
          <span>The clock never stops. Give orders, come back later.</span>
        </div>
        <div className="htp-fact">
          <b>No download</b>
          <span>It runs in the browser, on desktop or phone.</span>
        </div>
        <div className="htp-fact">
          <b>3 ways to win</b>
          <span>Out-vote, out-build, or out-fight everyone else.</span>
        </div>
      </div>
    </header>

    <Beat
      n={1}
      title="The map is the game"
      img="/howto/map-system.jpg"
      alt="The Sol system map: the sun at the centre, planets on their orbit rings, with two factions' ships parked at Earth and Mars."
    >
      <p>
        This is the solar system, seen from above. The sun sits in the middle
        and every planet moves along its ring in real time — <b>the planets
        actually orbit</b>, so the distance between two worlds changes from
        week to week.
      </p>
      <p>
        Drag to look around, scroll to zoom. Everything you'll ever click is
        on this map: <b>click a world to open it</b>, click a ship to give it
        orders. Colours mean ownership — your things are one colour, each
        rival another.
      </p>
    </Beat>

    <Beat
      n={2}
      title="Your homeworld makes everything"
      img="/howto/map-world.jpg"
      alt="Zoomed in on Earth: a green terraformed world with a city and station, four ships in orbit around it."
      flip
    >
      <p>
        You start with one world and a few ships. Zoom in and it becomes a
        place: a <b>city</b> on the surface, a <b>station</b> in orbit, and
        your fleet circling above.
      </p>
      <p>
        Open a world and you get its build menu. Cities make{' '}
        <b>metal, credits and science</b> every hour, and you spend those on
        upgrades — a forge for metal, a mint for credits, a lab for science —
        and on new ships. Better buildings mean more income, which means more
        ships. That's the loop.
      </p>
    </Beat>

    <Beat
      n={3}
      title="Raw worlds hoard. Terraformed worlds pay"
      img="/howto/map-terraform.jpg"
      alt="Mars mid-transformation: a dusty world glowing with a new atmosphere, two freighters in orbit delivering the payload."
    >
      <p>
        Most worlds out there are <b>raw</b> — dead rock. A raw world will
        take a station, but it won't take a city, and it keeps 90% of what it
        digs up sitting on the ground instead of sending it home.
      </p>
      <p>
        To fix that you <b>terraform</b> it: claim it with a station, then
        point a freighter at it on a supply route. The freighter hauls metal
        and credits until the world's meter fills, then the transformation
        runs and the planet comes alive — oceans, weather, the lot. Now it
        pays you in full and can hold a city. This is permanent, and it's how
        a one-planet empire becomes a real one.
      </p>
    </Beat>

    <Beat
      n={4}
      title="Fights happen where fleets meet"
      img="/howto/map-battle.jpg"
      alt="A battle at Mars: a teal fleet and an orange fleet in facing arcs around the planet, weapon fire crossing between them."
      flip
    >
      <p>
        There's no separate battle screen. If your ships and someone else's
        ships are at the same world and you're hostile, they shoot — you
        watch it happen on the map.
      </p>
      <p>
        Warships are targeted first, then freighters, and only once the orbit
        is clear can anyone bombard the settlements below. Armed stations
        shoot back; cities never do. Damaged ships limp home to a shipyard to
        repair, and ships that survive fights get better at fighting.
      </p>
    </Beat>

    <Beat
      n={5}
      title="Three ways to win"
      img="/howto/map-dyson.jpg"
      alt="A Dyson Sphere under construction around the sun: a partial amber lattice ringing the star, freighters delivering supplies."
    >
      <p>
        <b>Domination</b> — own more than 60% of the worlds that can hold a
        settlement. The straightforward one: take everything.
      </p>
      <p>
        <b>Chancellor</b> — get the senate to elect you. Every faction votes
        on laws that change the rules for everyone, and votes are weighted by
        how many worlds you hold. Politics is a real path, not decoration.
      </p>
      <p>
        <b>Engineering</b> — build a <b>Dyson Sphere</b> around the sun
        (pictured). It's enormously expensive and everyone can see it going
        up, so the moment you start, you become the target. Finish it and you
        win outright.
      </p>
    </Beat>

    <section className="htp-quick">
      <h2 className="htp-h2">The short version</h2>
      <ol className="htp-list">
        <li><b>Open your homeworld</b> and queue an upgrade — a forge is a fine first pick.</li>
        <li><b>Build a ship or two.</b> A colony ship claims new worlds; a freighter moves cargo.</li>
        <li><b>Send a colony ship somewhere new</b> and drop a station to claim the world.</li>
        <li><b>Terraform it</b> with a freighter supply route so it starts paying full income.</li>
        <li><b>Pick your win</b> and build toward it — more worlds, more votes, or the sphere.</li>
      </ol>
      <p className="htp-note">
        The game walks you through all of this the first time you play, with
        an interactive tutorial that opens the right menus and waits while
        you actually do each step.
      </p>
    </section>

    <section className="htp-faq">
      <h2 className="htp-h2">Questions people ask</h2>
      <dl>
        <dt>Do I have to be online all the time?</dt>
        <dd>
          No — that's the point. A turn is an hour of real time and the
          simulation runs without you. Most people check in a couple of times
          a day, give orders, and get on with their lives.
        </dd>

        <dt>What happens while I'm gone?</dt>
        <dd>
          Your worlds keep producing, your ships keep flying the orders you
          gave them, and fights resolve on their own. When you come back
          there's a report waiting that tells you what happened.
        </dd>

        <dt>Can I lose everything in one night?</dt>
        <dd>
          Not out of nowhere. Attacks take time to arrive because ships have
          to physically cross the distance, and you get warning when
          something hostile is inbound.
        </dd>

        <dt>Is it hard?</dt>
        <dd>
          The first hour is guided. The depth is there when you want it —
          custom ship designs, senate politics, trade deals — but you can
          play a perfectly good game with cities, ships, and a map.
        </dd>
      </dl>
    </section>

    <section className="htp-cta">
      <h2 className="htp-h2">That's it. Go start one.</h2>
      <button className="cta-primary cta-large" onClick={onSignIn}>
        CREATE ACCOUNT
      </button>
      <div className="htp-cta-sub">Free. No download. Solo or with friends.</div>
    </section>
  </div>
);
