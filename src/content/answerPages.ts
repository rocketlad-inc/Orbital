// ============================================================
// Answer pages: one page per question people ask a search engine or
// an AI assistant ("games like Neptune's Pride", "free browser 4X"...).
// Each answers its question honestly, about Orbital, and links to Play.
//
// English documents, like the changelog and press kit. Every claim was
// checked against the game on 2026-10-24 and matches the landing copy
// (src/i18n/parts/en/guide.ts). Keep it that way: when a rule changes,
// change the sentence. Do not mention solo play (not on prod) or the
// sun gates (a surprise).
//
// Landing.tsx turns each entry into a tab with its own URL, and
// scripts/prerender-pages.mjs writes each one out as static HTML for
// crawlers that do not run JavaScript. Adding a page is adding an entry
// here plus its path to public/sitemap.xml.
// ============================================================

export interface AnswerSection {
  heading: string;
  paragraphs?: string[];
  /** Bulleted points. */
  points?: string[];
  /** Numbered steps, for content that really is a sequence. */
  steps?: string[];
}

export interface AnswerPage {
  /** Also the tab id in Landing.tsx. */
  slug: string;
  path: string;
  /** Short name for footer links. */
  label: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  lede: string;
  image: { src: string; alt: string };
  sections: AnswerSection[];
  /** Small print under the page, e.g. a trademark note. */
  note?: string;
  /** A devlog post that tells the story behind this page. Linked only
   *  once it is published, so the page never points at a 404. */
  story?: { slug: string; label: string };
}

/** Heading over the links to the other pages. */
export const ANSWER_MORE = 'More about Orbital';

const PRICE ='Orbital is free with no ads, and nothing that affects the game is for sale. An optional one-time Commander’s Commission ($10) is cosmetic: ship designs, megastructure looks, premium emblems, and your games posted to your own Discord server.';

export const ANSWER_PAGES: AnswerPage[] = [
  {
    slug: 'like-neptunes-pride',
    path: '/games-like-neptunes-pride',
    label: 'Games like Neptune’s Pride',
    title: 'A Game Like Neptune’s Pride, Set in the Real Solar System — Orbital',
    description: 'Orbital is a free browser strategy game with the rhythm of Neptune’s Pride: a shared map, ticks on a real clock and alliances that matter, set across the real solar system.',
    eyebrow: 'Games like Neptune’s Pride',
    h1: 'Looking for a game like Neptune’s Pride?',
    lede: 'Orbital is a free multiplayer strategy game with the same rhythm: a shared map, ticks on a real clock, and alliances that hold or break while you are away. It is set in the real solar system and runs in your browser.',
    image: { src: '/howto/map-system.jpg', alt: 'The whole Sol system from above: the Sun at the centre, each empire’s territory shaded in its colour, and fleets marked across the orbits.' },
    sections: [
      {
        heading: 'What will feel familiar',
        points: [
          'Ticks resolve on the server on a real schedule, hourly by default. Give your orders, close the tab, and come back later.',
          'A game lasts days or weeks, not an evening, and it keeps running while you sleep.',
          'Diplomacy is between people: pacts, trades, promises and betrayals.',
          'Fleets take real time to arrive, and your rivals can see them coming.',
        ],
      },
      {
        heading: 'What Orbital adds',
        points: [
          'The real solar system is the map. Planets move along their orbits, so the distance between two worlds changes and choosing when to launch is part of the plan.',
          'You design your own warships: corvettes, frigates and destroyers with railguns or energy lances, armour or shields.',
          'A Senate whose laws change output, ship costs and combat damage for every empire, including the one that proposed them.',
          'Three ways to win: Domination (hold more than 60% of the worlds), Supreme Chancellor (win the Senate’s vote) or Engineering (build a Dyson Sphere around the Sun).',
          'Terraforming: raw worlds come alive when freighters deliver enough metal and credits, and every shipment can be raided.',
          'Every game starts at peace. War is declared, not assumed, and ending one takes both sides.',
        ],
      },
      {
        heading: 'Differences to know about',
        paragraphs: [
          'Orbital games have two to ten players. Hosts set the tick anywhere from a minute to a day, so one game can last an afternoon and another a month.',
          PRICE,
        ],
      },
      {
        heading: 'Getting started',
        paragraphs: [
          'Sign in with Google or an email address and Quick Join drops you into the fullest open game. You can join a game that has already started, as long as a home world is still free.',
        ],
      },
    ],
    note: 'Neptune’s Pride is a game by Iron Helmet Games. Orbital is not affiliated with it.',
    story: { slug: 'neptunes-pride-inspired-orbital', label: 'Read the story: how Neptune’s Pride inspired Orbital' },
  },
  {
    slug: 'real-solar-system',
    path: '/real-solar-system-strategy-game',
    label: 'Strategy in the real solar system',
    title: 'A Strategy Game Set in the Real Solar System — Orbital',
    description: 'Orbital is a free multiplayer strategy game played across the real solar system, where planets orbit, distances change and fleets take real time to cross them.',
    eyebrow: 'The real solar system',
    h1: 'A strategy game set in the real solar system',
    lede: 'Most space strategy games invent a galaxy. Orbital uses ours: the Sun, the planets and their moons, the asteroid belt and the Kuiper Belt, each where it really is and moving along its orbit.',
    image: { src: '/howto/map-world.jpg', alt: 'Earth’s world menu: the city’s buildings stand on the planet’s rim, each with its level and upgrade cost, and the station in orbit beside it.' },
    sections: [
      {
        heading: 'Orbits change the strategy',
        paragraphs: [
          'Because the planets turn, the distance between Earth and Mars this week is not the distance next month. A short hop today can be on the far side of the Sun later, so choosing when to launch is part of the plan.',
          'Ships accelerate and brake along their course and take real ticks to arrive. A long flight is a commitment your rivals can see coming, and fleets can be caught and fought in mid-flight.',
        ],
      },
      {
        heading: 'Every world has a job',
        points: [
          'Planets and moons take stations in orbit, and cities on the ground once they are terraformed.',
          'Raw worlds keep 90% of what they mine on the ground until you terraform them with freighter deliveries.',
          'The asteroid belt, the Kuiper Belt and the Far Reach beyond it, where the metal is.',
          'Drifting meteoroids can be mined for metal and credits.',
          'Even the Sun can be claimed. It is where the Dyson Sphere is built.',
        ],
      },
      {
        heading: 'How a game plays',
        paragraphs: [
          'Two to ten players share one solar system. Ticks resolve hourly by default, and the game keeps running when you log off. You win by Domination, by election as Supreme Chancellor, or by finishing a Dyson Sphere.',
          PRICE,
        ],
      },
    ],
  },
  {
    slug: 'free-browser-4x',
    path: '/free-browser-4x-game',
    label: 'Free 4X in your browser',
    title: 'Free Multiplayer 4X Space Game in Your Browser — Orbital',
    description: 'Orbital is a free multiplayer 4X space strategy game that runs in your browser: explore, expand, exploit and exterminate across the real solar system, with no download and no ads.',
    eyebrow: 'Free 4X in your browser',
    h1: 'A free 4X space game that runs in your browser',
    lede: 'Orbital is a multiplayer 4X strategy game with no download, no ads and nothing that affects the game for sale. Open the site, sign in and join a game.',
    image: { src: '/howto/map-battle.jpg', alt: 'A three-way battle at Earth: red, purple and blue fleets in orbit, beams and tracers crossing between them.' },
    sections: [
      {
        heading: 'Explore',
        paragraphs: ['The map is the real solar system, from the Sun out past Pluto. Hidden discoveries wait out there, from derelict warships to ancient databanks.'],
      },
      {
        heading: 'Expand',
        paragraphs: ['Plant stations in orbit and cities on the ground. Terraform raw worlds into living ones by running freighters to them, and build shipyards to push further out.'],
      },
      {
        heading: 'Exploit',
        paragraphs: ['Forges, mints and labs turn out metal, credits and science every tick. Six research tracks run from weapons to sensors, and you can trade with rivals on an open market. Every shipment is physical, and every shipment can be raided.'],
      },
      {
        heading: 'Exterminate',
        paragraphs: ['Design your own corvettes, frigates and destroyers. Shields blunt kinetic fire and armour blunts energy, so the right loadout depends on who you are fighting. Build Weapons Stations and the planet-wrecking Mega Destroyer, and replay your battles afterwards.'],
      },
      {
        heading: 'Built for the browser',
        points: [
          'Runs in any modern browser on desktop, tablet and phone, with a layout built for touch.',
          'Two to ten players per game, with hourly ticks by default.',
          'Alerts by browser notification, Discord or email.',
          'Android and Wear OS apps are in testing.',
        ],
      },
      {
        heading: 'Free, and fair',
        paragraphs: [PRICE],
      },
    ],
  },
  {
    slug: 'few-minutes-a-day',
    path: '/strategy-game-few-minutes-a-day',
    label: 'Strategy in a few minutes a day',
    title: 'A Strategy Game You Can Play a Few Minutes a Day — Orbital',
    description: 'Orbital is a free multiplayer space strategy game on a real clock: give orders in a few minutes, the server resolves the ticks while you are away, and a briefing tells you what changed.',
    eyebrow: 'A few minutes a day',
    h1: 'A strategy game you can play a few minutes a day',
    lede: 'Orbital runs on a real clock. You give orders, close the tab, and the game resolves on the server whether you are watching or not. A few check-ins a day is enough to run an empire.',
    image: { src: '/howto/map-terraform.jpg', alt: 'The world menu of Deimos, a raw moon: a station holds it, and the Terraform tab shows a metal and credit meter waiting for a freighter.' },
    sections: [
      {
        heading: 'The daily loop',
        steps: [
          'Give your orders: send fleets, queue ships at your yards, propose laws, make offers. A few minutes is enough.',
          'The clock ticks: ships move, battles resolve and economies pay out, hourly by default.',
          'Read the briefing: the Situation Report shows fights in progress, fleets inbound, idle shipyards and decisions waiting on you.',
        ],
      },
      {
        heading: 'Your empire keeps going while you are away',
        paragraphs: [
          'Freighters keep running their routes, armed stations defend themselves, and ships in flight keep flying. Nobody plays your empire for you, so set your orders before you log off. When something needs you, an alert reaches you by browser notification, Discord or email.',
        ],
      },
      {
        heading: 'Pick the pace',
        paragraphs: [
          'The default is one tick an hour. Hosts can choose anything from a tick a minute to a tick a day, and can set a different speed for different times of day, such as a slower clock overnight.',
          'Two to ten players share a game, and it runs until someone wins: by Domination, by election as Supreme Chancellor, or by building a Dyson Sphere.',
        ],
      },
      {
        heading: 'On your phone, too',
        paragraphs: ['Orbital runs in any modern browser on desktop, tablet and phone, with nothing to install. ' + PRICE],
      },
    ],
  },
];
