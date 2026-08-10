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
import { CombatCharts } from './CombatCharts';

interface Props {
  onSignIn: () => void;
}

/** One numbered teaching beat: picture on one side, words on the other.
 *  Most beats carry a real screenshot (`img`). Trade and the senate live
 *  in DOM panels rather than on the map canvas, so those two carry a
 *  labelled diagram (`diagram`) instead — drawn as a diagram on purpose,
 *  not dressed up to look like a screenshot it isn't. */
const Beat: React.FC<{
  n: number;
  title: string;
  img?: string;
  alt?: string;
  diagram?: React.ReactNode;
  flip?: boolean;
  children: React.ReactNode;
}> = ({ n, title, img, alt, diagram, flip, children }) => (
  <section className={`htp-beat${flip ? ' htp-beat--flip' : ''}`}>
    <figure className="htp-shot">
      {img
        ? <img src={img} alt={alt} loading="lazy" width={1200} height={675} />
        : diagram}
    </figure>
    <div className="htp-copy">
      <div className="htp-step">STEP {n}</div>
      <h3 className="htp-beat-title">{title}</h3>
      {children}
    </div>
  </section>
);

const SVG_W = 640;
const SVG_H = 360;

/** Trade: two empires swapping goods, hauled physically by freighter. */
const TradeDiagram = () => (
  <svg
    className="htp-diagram"
    viewBox={`0 0 ${SVG_W} ${SVG_H}`}
    role="img"
    aria-label="A trade between two empires: your world sends metal, their world sends science, carried by freighters that can be raided in transit. A senate tariff skims a percentage off what arrives."
  >
    <rect width={SVG_W} height={SVG_H} fill="#080d14" />
    {/* your world */}
    <g transform="translate(96,180)">
      <circle r={44} fill="rgba(78,205,196,0.18)" stroke="#4ecdc4" strokeWidth={1.8} />
      <path d="M-20 6 Q-8 -14 10 -5 Q22 3 17 14 Q0 25 -14 18 Z" fill="rgba(110,231,183,0.5)" />
      <text y={70} textAnchor="middle" fill="#4ecdc4" fontSize={13} fontWeight={700} letterSpacing={2}>YOU</text>
    </g>
    {/* their world */}
    <g transform="translate(544,180)">
      <circle r={44} fill="rgba(255,138,77,0.16)" stroke="#ff8a4d" strokeWidth={1.8} />
      <path d="M-18 4 Q-6 -13 12 -6 Q23 2 17 13 Q0 24 -13 16 Z" fill="rgba(255,179,122,0.45)" />
      <text y={70} textAnchor="middle" fill="#ff8a4d" fontSize={13} fontWeight={700} letterSpacing={2}>THEM</text>
    </g>

    {/* outbound leg — label sits ABOVE the lane so it never sits on the
        dashes, and the freighter rides the lane it's actually hauling. */}
    <g>
      <path d="M150 128 H470" stroke="#4ecdc4" strokeWidth={2} strokeDasharray="7 6" fill="none" opacity={0.7} />
      <path d="M470 128 l-12 -6 v12 z" fill="#4ecdc4" />
      <g transform="translate(238,128)">
        <rect x={-46} y={-30} width={92} height={22} rx={4}
          fill="rgba(78,205,196,0.16)" stroke="#4ecdc4" strokeWidth={1.2} />
        <text y={-14} textAnchor="middle" fill="#d8f5f2" fontSize={12} fontWeight={700}>500 METAL</text>
      </g>
      <g transform="translate(384,128)">
        <rect x={-17} y={-9} width={34} height={18} rx={3}
          fill="rgba(127,212,255,0.4)" stroke="#7fd4ff" strokeWidth={1.4} />
        <path d="M-17 -3 L-27 0 L-17 3 Z" fill="#ff9e4a" />
      </g>
    </g>

    {/* return leg */}
    <g>
      <path d="M470 232 H150" stroke="#ff8a4d" strokeWidth={2} strokeDasharray="7 6" fill="none" opacity={0.7} />
      <path d="M150 232 l12 -6 v12 z" fill="#ff8a4d" />
      <g transform="translate(392,232)">
        <rect x={-52} y={8} width={104} height={22} rx={4}
          fill="rgba(255,138,77,0.14)" stroke="#ff8a4d" strokeWidth={1.2} />
        <text y={24} textAnchor="middle" fill="#ffd9c2" fontSize={12} fontWeight={700}>300 SCIENCE</text>
      </g>
      <g transform="translate(246,232)">
        <rect x={-17} y={-9} width={34} height={18} rx={3}
          fill="rgba(127,212,255,0.4)" stroke="#7fd4ff" strokeWidth={1.4} />
        <path d="M17 -3 L27 0 L17 3 Z" fill="#ff9e4a" />
      </g>
    </g>

    {/* the caption that carries the actual lesson */}
    <text x={SVG_W / 2} y={182} textAnchor="middle" fill="#ff8080" fontSize={12} letterSpacing={0.6}>
      freighters in transit can be raided
    </text>

    <text x={SVG_W / 2} y={30} textAnchor="middle" fill="#8fa8bf" fontSize={11.5} letterSpacing={2}>
      GOODS ARE PHYSICALLY DELIVERED
    </text>
    {/* tariff — centred at the foot, clear of the world labels */}
    <text x={SVG_W / 2} y={322} textAnchor="middle" fill="#c4b5fd" fontSize={11} letterSpacing={0.6}>
      a senate tariff skims a % of whatever arrives
    </text>
  </svg>
);

/** Senate: weighted votes on a bill that rebinds the rules for everyone. */
const SenateDiagram = () => (
  <svg
    className="htp-diagram"
    viewBox={`0 0 ${SVG_W} ${SVG_H}`}
    role="img"
    aria-label="A senate bill to raise metal yield. Factions vote with weight equal to one plus one per system they control; a majority of living factions must engage for the bill to pass, and the new law then applies to everyone."
  >
    <rect width={SVG_W} height={SVG_H} fill="#080d14" />

    {/* the bill */}
    <g transform="translate(320,56)">
      <rect x={-160} y={-30} width={320} height={56} rx={6}
        fill="rgba(196,181,253,0.10)" stroke="#c4b5fd" strokeWidth={1.5} />
      <text y={-10} textAnchor="middle" fill="#c4b5fd" fontSize={10.5} letterSpacing={2.4}>BILL ON THE FLOOR</text>
      <text y={13} textAnchor="middle" fill="#efeaff" fontSize={15} fontWeight={700}>METAL YIELD ×1.5</text>
    </g>

    {/* voters, sized by weight */}
    <text x={320} y={116} textAnchor="middle" fill="#8fa8bf" fontSize={11} letterSpacing={1.6}>
      VOTE WEIGHT = 1 + 1 PER SYSTEM YOU CONTROL
    </text>
    {[
      { x: 128, name: 'YOU', w: 4, col: '#4ecdc4', vote: 'YEA' },
      { x: 320, name: 'RIVAL', w: 3, col: '#ff8a4d', vote: 'NAY' },
      { x: 512, name: 'THIRD', w: 2, col: '#ffd27a', vote: 'YEA' },
    ].map(v => (
      <g key={v.name} transform={`translate(${v.x},170)`}>
        <circle r={26} fill={`${v.col}22`} stroke={v.col} strokeWidth={1.6} />
        <text y={5} textAnchor="middle" fill={v.col} fontSize={16} fontWeight={800}>×{v.w}</text>
        <text y={44} textAnchor="middle" fill={v.col} fontSize={11} fontWeight={700} letterSpacing={1.4}>{v.name}</text>
        <text y={59} textAnchor="middle" fill={v.vote === 'YEA' ? '#7fffa1' : '#ff8080'} fontSize={10.5} letterSpacing={1.2}>{v.vote}</text>
      </g>
    ))}

    {/* tally */}
    <g transform="translate(320,268)">
      <text y={-12} textAnchor="middle" fill="#8fa8bf" fontSize={10.5} letterSpacing={1.6}>TALLY</text>
      <rect x={-160} y={0} width={320} height={16} rx={4} fill="rgba(255,255,255,0.06)" />
      {/* 6 yea of 9 total */}
      <rect x={-160} y={0} width={213} height={16} rx={4} fill="rgba(127,255,161,0.45)" />
      <text x={-150} y={12} fill="#0a1a10" fontSize={11} fontWeight={800}>YEA 6</text>
      <text x={150} y={12} textAnchor="end" fill="#ffb0b0" fontSize={11} fontWeight={800}>NAY 3</text>
    </g>

    {/* outcome */}
    <text x={320} y={318} textAnchor="middle" fill="#7fffa1" fontSize={12.5} fontWeight={700} letterSpacing={1.2}>
      PASSED — THE LAW NOW APPLIES TO EVERY EMPIRE
    </text>
    <text x={320} y={340} textAnchor="middle" fill="#64809c" fontSize={10.5}>
      a majority of living factions must vote for anything to pass
    </text>
  </svg>
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
      title="Trade is a shipment, not a menu"
      diagram={<TradeDiagram />}
      flip
    >
      <p>
        You can strike deals with other players: metal, credits, fuel and
        science in whatever mix you both agree to. You can also sign{' '}
        <b>pacts</b> — non-aggression, mutual defence, or research sharing.
      </p>
      <p>
        The catch is that goods don't teleport. When a deal is accepted,
        each side loads a freighter at one of their terraformed worlds and
        flies it to the other's. <b>That freighter can be intercepted.</b>{' '}
        A trade route across contested space is a real risk, and escorting a
        shipment is a legitimate use of a warship.
      </p>
    </Beat>

    <Beat
      n={5}
      title="Fights happen where fleets meet"
      img="/howto/map-battle.jpg"
      alt="A battle at Mars: a teal fleet and an orange fleet in facing arcs around the planet, weapon fire crossing between them."
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
      n={6}
      title="The senate writes the rules"
      diagram={<SenateDiagram />}
      flip
    >
      <p>
        There's a galactic senate, and it is not decoration — it changes the
        actual numbers everyone plays by. Bills can raise or cut{' '}
        <b>metal, credit and science output</b>, change what ships cost to
        build, adjust <b>combat damage</b>, set a <b>tariff</b> on trade, or
        move fleet upkeep. A passed law applies to <b>every empire</b>,
        including the one that proposed it.
      </p>
      <p>
        Your vote isn't one vote. <b>Weight is 1, plus 1 for every system
        you control</b> — and you control a system by owning more of its
        bodies than anyone else. Grabbing a moon is therefore also a
        political act. A bill needs a majority of the living factions to
        actually engage before it can pass, so ignoring the chamber is how
        you get governed by someone else.
      </p>
      <p>
        The senate can also aim things at a specific player: authorise war
        on them, embargo their trade, or sanction their production.
      </p>
    </Beat>

    <Beat
      n={7}
      title="Three ways to win"
      img="/howto/map-dyson.jpg"
      alt="A Dyson Sphere under construction around the sun: a partial amber lattice ringing the star, freighters delivering supplies."
    >
      <p>
        <b>Domination</b> — own more than 60% of the worlds that can hold a
        settlement. The straightforward one: take everything.
      </p>
      <p>
        <b>Chancellor</b> — get the senate to elect you. It's a single bill
        that can only be run once per game, and it needs the chamber behind
        it, so this is the payoff for the systems you control and the
        friends you made trading. Politics is a real path, not decoration.
      </p>
      <p>
        <b>Engineering</b> — build a <b>Dyson Sphere</b> around the sun
        (pictured). It's enormously expensive and everyone can see it going
        up, so the moment you start, you become the target. Finish it and you
        win outright.
      </p>
    </Beat>

    <CombatCharts />

    <section className="htp-quick">
      <h2 className="htp-h2">The short version</h2>
      <ol className="htp-list">
        <li><b>Open your homeworld</b> and queue an upgrade — a forge is a fine first pick.</li>
        <li><b>Build a ship or two.</b> A colony ship claims new worlds; a freighter moves cargo.</li>
        <li><b>Send a colony ship somewhere new</b> and drop a station to claim the world.</li>
        <li><b>Terraform it</b> with a freighter supply route so it starts paying full income.</li>
        <li><b>Talk to people.</b> Trade for what you're short of, and vote on the bills that set everyone's rules.</li>
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

        <dt>Do I have to fight?</dt>
        <dd>
          No. Trade, terraforming and the senate are a complete way to play —
          plenty of games are decided by who controlled the most systems and
          therefore the most votes. Being useful to your neighbours is a real
          strategy, and non-aggression pacts exist for exactly this reason.
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
