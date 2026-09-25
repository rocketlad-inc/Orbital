// ============================================================
// PressKit — /press. Everything a writer, streamer or store curator
// needs without having to ask: the facts, copy they can paste, and
// screenshots and logos they can download.
//
// The files live in public/press/ and were made from the staged
// eight-empire showcase game (marketing/sol-wars-screenshots): full-size
// JPEGs, WebP thumbnails, and two zips. Cloudflare serves static assets
// up to 25 MiB each, so the zips are split (screenshots / logos) rather
// than one bundle of the original PNGs, which was 30 MB.
//
// Facts here must stay true. Multiplayer only (single player is retired),
// 2-8 players, the Android app is in TESTING on Play, not public.
// ============================================================

import React, { useState } from 'react';

const SHORT = 'A real-time strategy game across the whole Sol system, played in your browser.';

const MEDIUM =
  'Orbital is a free multiplayer strategy game set across the Sol system, from Mercury out to the '
  + 'Kuiper Belt. Up to eight empires settle worlds, fly fleets on real trajectories and fight for '
  + 'the system on a clock that keeps running when you log off. Win by conquest, by politics in the '
  + 'Senate, or by building a Dyson Sphere around the Sun.';

const LONG = [
  'Orbital is a real-time strategy game played across the whole Sol system: the inner planets, the '
  + 'asteroid belt, the gas giants and their moons, and out past Pluto to the Kuiper Belt. It runs in '
  + 'a web browser on desktop, tablet and phone, and it is free to play.',
  'The clock never stops. Each game ticks on a real schedule, an hour a turn by default, whether or '
  + 'not you are logged in. Players drop in to give orders: a fleet sent last night has arrived, '
  + 'fought and repaired by morning.',
  'Up to eight empires share a system. They settle cities and stations, terraform raw worlds into '
  + 'living ones, run freighters on supply lines and design their own warships. Every flight is a '
  + 'real continuous-thrust trajectory with a travel time you cannot take back.',
  'The fight is only half the game. Rivals sign pacts, trade resources, declare wars and pass laws '
  + 'in a shared Senate. There are three ways to win: hold most of the worlds, get elected Supreme '
  + 'Chancellor, or finish the Dyson Sphere around the Sun before anyone can tear it down.',
].join('\n\n');

const FACTS: Array<[string, React.ReactNode]> = [
  ['Game', <>Orbital <span className="press-muted">(listed on Google Play as Orbital Empire)</span></>],
  ['Genre', 'Real-time multiplayer 4X strategy'],
  ['Setting', 'The Sol system, Mercury to the Kuiper Belt'],
  ['Players', '2 to 8 per game'],
  ['Pace', 'Runs on a real clock, one turn an hour by default; hosts can pick faster games'],
  ['Platforms', 'Web browser on desktop, tablet and phone. Android and Wear OS apps in testing'],
  ['Price', 'Free to play'],
  ['Status', 'Alpha, in active development since May 2026'],
  ['Website', <a className="doc-link" href="https://orbital-empire.com">orbital-empire.com</a>],
];

const FEATURES = [
  ['Real trajectories', 'Ships fly continuous-thrust burns between any two bodies. Distance and engine decide the flight time, and once a fleet commits it is on its way.'],
  ['A game that keeps going', 'Turns tick on a real clock. Empires run while their players sleep, and a Situation Report says what changed while you were away.'],
  ['Settle and terraform', 'Cities on planets, stations in orbit. Raw worlds hoard what they mine; terraform them and they pay their full yield home.'],
  ['Fleets and a ship designer', 'Design hulls part by part, crew them with captains, and send them out as fleets. Veterans get deadlier with every kill.'],
  ['Superweapons', 'Mega Destroyers can sterilise a world, and a second strike reduces it to a debris field. Wrecked cities can be rebuilt or razed by whoever takes them.'],
  ['Diplomacy and a Senate', 'Pacts, defence treaties, trade offers and declared wars. Every world held is a vote on the laws everyone has to live with.'],
  ['Three ways to win', 'Hold most of the worlds, win the Senate, or complete the Dyson Sphere around the Sun.'],
];

type Shot = { slug: string; title: string };
const GROUPS: Array<{ title: string; ratio: string; size: string; wide: boolean; shots: Shot[] }> = [
  {
    title: 'Battles and the map', ratio: '16:9', size: '2880 × 1620', wide: true, shots: [
      { slug: 'battle-of-mars-16x9', title: 'Battle of Mars' },
      { slug: 'battle-of-europa-16x9', title: 'Battle of Europa' },
      { slug: 'raid-on-saturn-16x9', title: 'Raid on Saturn' },
      { slug: 'battle-of-triton-16x9', title: 'Battle of Triton' },
      { slug: 'battle-of-charon-16x9', title: 'Battle of Charon' },
      { slug: 'mega-destroyer-over-luna-16x9', title: 'Mega Destroyer over Luna' },
      { slug: 'dyson-sphere-16x9', title: 'The Dyson Sphere' },
      { slug: 'earth-gate-16x9', title: 'The Earth gate' },
      { slug: 'inner-system-16x9', title: 'The inner system' },
      { slug: 'system-overview-16x9', title: 'The whole system' },
    ],
  },
  {
    title: 'Interface', ratio: '16:9', size: '2880 × 1620', wide: true, shots: [
      { slug: 'fleet-panel-16x9', title: 'A fleet over Mars' },
      { slug: 'world-menu-earth-16x9', title: 'Earth’s world menu' },
      { slug: 'world-menu-mars-16x9', title: 'Mars’s world menu' },
      { slug: 'event-log-16x9', title: 'Event log' },
      { slug: 'situation-report-16x9', title: 'Situation Report' },
      { slug: 'empires-16x9', title: 'Empires and standings' },
      { slug: 'market-16x9', title: 'Market' },
      { slug: 'research-16x9', title: 'Research' },
    ],
  },
  {
    title: 'Square', ratio: '1:1', size: '1620 × 1620', wide: false, shots: [
      { slug: 'battle-of-mars-1x1', title: 'Battle of Mars' },
      { slug: 'dyson-sphere-1x1', title: 'The Dyson Sphere' },
      { slug: 'mega-destroyer-over-luna-1x1', title: 'Mega Destroyer over Luna' },
      { slug: 'battle-of-triton-1x1', title: 'Battle of Triton' },
    ],
  },
  {
    title: 'Phone', ratio: '9:20', size: '1082 × 2402', wide: false, shots: [
      { slug: 'battle-of-mars-9x16', title: 'Battle of Mars' },
      { slug: 'situation-report-9x16', title: 'Situation Report' },
      { slug: 'empires-9x16', title: 'Empires' },
      { slug: 'world-menu-earth-9x16', title: 'Earth’s world menu' },
    ],
  },
  {
    title: 'Tablet and ultrawide', ratio: '4:3 · 21:9', size: '2048 × 1536 · 2560 × 1080', wide: true, shots: [
      { slug: 'battle-of-europa-4x3', title: 'Battle of Europa (4:3)' },
      { slug: 'system-overview-4x3', title: 'The whole system (4:3)' },
      { slug: 'battle-of-mars-21x9', title: 'Battle of Mars (21:9)' },
      { slug: 'system-overview-21x9', title: 'The whole system (21:9)' },
    ],
  },
];

const LOGOS = [
  { file: 'orbital-app-icon-1024.png', title: 'App icon', note: '1024 × 1024 PNG', bg: 'dark' },
  { file: 'orbital-wordmark-gold.png', title: 'Wordmark, gold', note: 'Transparent PNG, for dark backgrounds', bg: 'dark' },
  { file: 'orbital-wordmark-white.png', title: 'Wordmark, white', note: 'Transparent PNG, for dark or photo backgrounds', bg: 'dark' },
  { file: 'orbital-wordmark-dark.png', title: 'Wordmark, dark', note: 'Transparent PNG, for light backgrounds', bg: 'light' },
  { file: 'orbital-key-art-2400x1260.jpg', title: 'Key art', note: '2400 × 1260 JPG (also 1200 × 630)', bg: 'dark' },
];

const CopyBlock: React.FC<{ label: string; text: string }> = ({ label, text }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked: the text is on screen to select by hand */ }
  };
  return (
    <div className="press-copy">
      <div className="press-copy__head">
        <span className="press-copy__label">{label}</span>
        <button className="press-copy__btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
};

export const PressKit: React.FC = () => (
  <section className="landing-doc press">
    <h1 className="doc-title">Press kit</h1>
    <p className="doc-lede">
      Facts, copy and images for writing about Orbital. Everything on this page is free to use in
      coverage, reviews, videos and store features. No need to ask first.
    </p>

    <div className="press-downloads">
      <a className="press-dl" href="/press/orbital-screenshots.zip" download>
        <span className="press-dl__title">All 30 screenshots</span>
        <span className="press-dl__meta">ZIP · 7.4 MB · full-size JPG</span>
      </a>
      <a className="press-dl" href="/press/orbital-logos.zip" download>
        <span className="press-dl__title">Logos and key art</span>
        <span className="press-dl__meta">ZIP · 0.7 MB · PNG and JPG</span>
      </a>
    </div>

    <h2>Fact sheet</h2>
    <dl className="press-facts">
      {FACTS.map(([k, v]) => (
        <div className="press-facts__row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>

    <h2>Descriptions</h2>
    <CopyBlock label="One line" text={SHORT} />
    <CopyBlock label="Short (about 60 words)" text={MEDIUM} />
    <CopyBlock label="Long (about 200 words)" text={LONG} />

    <h2>Features</h2>
    <ul className="press-features">
      {FEATURES.map(([t, b]) => (
        <li key={t}><strong>{t}.</strong> {b}</li>
      ))}
    </ul>

    <h2>Screenshots</h2>
    <p>
      All from one live eight-empire game. Click any image for the full-size file.
    </p>
    {GROUPS.map(g => (
      <div className="press-group" key={g.title}>
        <h3>{g.title} <span className="press-muted">· {g.ratio} · {g.size}</span></h3>
        <div className={`press-grid${g.wide ? '' : ' press-grid--narrow'}`}>
          {g.shots.map(s => (
            <a className="press-shot" key={s.slug} href={`/press/screenshots/orbital-${s.slug}.jpg`} target="_blank" rel="noopener">
              <img src={`/press/thumbs/orbital-${s.slug}.webp`} alt={s.title} loading="lazy" decoding="async" />
              <span>{s.title}</span>
            </a>
          ))}
        </div>
      </div>
    ))}

    <h2>Logos and key art</h2>
    <div className="press-grid press-grid--logos">
      {LOGOS.map(l => (
        <a className="press-logo" key={l.file} href={`/press/logo/${l.file}`} target="_blank" rel="noopener">
          <span className={`press-logo__art press-logo__art--${l.bg}`}>
            <img src={`/press/logo/${l.file}`} alt={l.title} loading="lazy" decoding="async" />
          </span>
          <span className="press-logo__title">{l.title}</span>
          <span className="press-muted">{l.note}</span>
        </a>
      ))}
    </div>

    <h2>What’s new</h2>
    <p>
      Every update is written up in the <a className="doc-link" href="/changelog">changelog</a>,
      in plain language, newest first.
    </p>

    <h2>Contact</h2>
    <p>
      Press, review access, interviews and anything else:{' '}
      <a className="doc-link" href="mailto:press@orbital-empire.com">press@orbital-empire.com</a>
    </p>
  </section>
);
