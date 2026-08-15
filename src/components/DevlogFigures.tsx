// ============================================================
// DevlogFigures — the drawn explanations inside a devlog post.
//
// THE PLACEHOLDER CONTRACT. Post bodies are authored HTML held in the
// database and sanitised on write (worker/devlog.js), which strips
// <svg> and every attribute — correctly, since that string is now
// user-editable and rendered with innerHTML on a public page. So a
// graphic cannot live in the body. Instead the body carries an EMPTY
// div with a known class and the page swaps it for the component of
// the same name (see DevlogBody in Changelog.tsx).
//
// That makes each class name below a contract shared by THREE places:
// the authored post HTML, ALLOWED_CLASSES in worker/devlog.js, and the
// registry at the foot of this file. Renaming one is renaming all
// three; a rename that misses the sanitiser fails silently, because a
// dropped class looks exactly like a post that never had a figure.
//
// NUMBERS ARE TYPED HERE, and that is a deliberate departure from
// CombatCharts, which computes every value from the live game tables.
// The difference is what the two charts are for. CombatCharts is a
// reference: it must describe the game as it is right now, so a hull
// retune has to move it. These are journalism — they describe what
// shipped on a stated date, and they are quoting scenarios
// (DESIGN-transit-combat.md, "What the numbers do") that no runtime
// function produces: there is no lookup that returns "oblique 45°,
// mid moon-hop". A figure that silently retuned itself after
// publication would misreport history, so these are frozen with the
// post that carries them.
//
// TEXT IS HTML, GEOMETRY IS SVG, and never the other way round. These
// figures render in a column that is 700px on a desktop and 340px on a
// phone, so an SVG scaled by viewBox scales its own text with it: any
// label inside the drawing is either oversized at one end or unreadable
// at the other. Everything a reader has to read is laid out by CSS at a
// fixed size; the SVGs carry lines and shapes only.
//
// COLOUR is CombatCharts' pair — teal #26a69a, amber #c98500 —
// re-used rather than re-picked, because it was validated for CVD
// separation and contrast against this exact dark surface, and two
// charts on one page disagreeing about what teal means is worse than
// either choice individually. Lighter tints appear only on thin
// strokes, where the validated weight reads as grey.
//
// SINGLE THEME, like CombatCharts: the devlog only exists on the dark
// landing surface.
// ============================================================

import React from 'react';
import './DevlogFigures.css';

// ------------------------------------------------------------------
// Shared shell
// ------------------------------------------------------------------

interface FigureProps {
  title: string;
  /** One line under the title. Says what is being measured, since a
   *  reader who scrolled straight to the picture has not read the
   *  paragraph that would otherwise have said it. */
  sub?: string;
  /** The take-away, in words, under the drawing. Every figure has one:
   *  these are published inside prose that a reader may well skip, so
   *  each has to survive being read entirely on its own. */
  note?: React.ReactNode;
  children: React.ReactNode;
}

const Figure: React.FC<FigureProps> = ({ title, sub, note, children }) => (
  <figure className="dfg">
    <figcaption className="dfg-cap">
      <span className="dfg-title">{title}</span>
      {sub && <span className="dfg-sub">{sub}</span>}
    </figcaption>
    {children}
    {note && <p className="dfg-note">{note}</p>}
  </figure>
);

/** Arrowhead as a plain polygon rather than an SVG <marker>. Markers
 *  are referenced by document-unique id, and a devlog page renders many
 *  posts at once — two figures defining the same marker id is a bug
 *  that only appears once a second post is published. */
function head(x: number, y: number, ux: number, uy: number, s = 7): string {
  const px = -uy;
  const py = ux;
  return [
    `${x},${y}`,
    `${x - ux * s + px * s * 0.55},${y - uy * s + py * s * 0.55}`,
    `${x - ux * s - px * s * 0.55},${y - uy * s - py * s * 0.55}`,
  ].join(' ');
}

// ------------------------------------------------------------------
// fig-hit-odds
// ------------------------------------------------------------------

/** DESIGN-transit-combat.md, "What the numbers do": a corvette
 *  (speed 0.85) firing on a freighter (0.55) at the live game's own
 *  acceleration. One attacker and one defender throughout, because the
 *  point of the chart is that GEOMETRY moves the number — a table that
 *  also varied the hulls would let a reader credit the spread to the
 *  ships instead. Written in descending order, which is also the order
 *  it must be read in. */
const HIT_ODDS: { label: string; pct: number; tone: 'full' | 'mid' | 'none'; tag?: string }[] = [
  { label: 'Parked at the same body', pct: 70.5, tone: 'full', tag: "today's odds" },
  { label: 'Matched formation at cruise', pct: 70.5, tone: 'full', tag: "today's odds" },
  { label: 'Just departed — the parting shot', pct: 63.8, tone: 'mid' },
  { label: 'Oblique 45°, moon hop', pct: 22.8, tone: 'mid' },
  { label: 'Beam pass, moon hop', pct: 19.1, tone: 'mid' },
  // Aim odds PLUS the shipped closing-speed bonus (+10% ramping in
  // from 50 u/t), because that is what a player actually rolls. The
  // bonus is why head-on now beats a crossing: coming straight at
  // someone is easy to aim at, it is just fleeting.
  { label: 'Head-on, interplanetary cruise', pct: 14.5, tone: 'mid' },
  { label: 'Crossing, interplanetary cruise', pct: 6.1, tone: 'none', tag: 'a snap shot' },
];

const HitOdds: React.FC = () => (
  <Figure
    title="What geometry is worth"
    sub="chance to hit per volley — one corvette firing on one freighter, same guns every row"
    note={
      <>
        The top two rows and the bottom row are the whole design. Match
        velocity and you are in a knife fight at the odds the game has
        always had; cross at cruise and you are shooting at nothing.
        Everything in between is a decision about how you approach.
      </>
    }
  >
    <div
      className="dfg-odds"
      role="img"
      aria-label={
        'Bar chart of chance to hit per volley, descending: '
        + HIT_ODDS.map(r => `${r.label}, ${r.pct} percent`).join('; ')
        + '. The two matched-velocity cases sit at 70.5 percent, a crossing '
        + 'at interplanetary cruise at 6.1 percent.'
      }
    >
      {HIT_ODDS.map(row => (
        <div className="dfg-odds-row" key={row.label}>
          <div className="dfg-odds-name">
            {row.label}
            {row.tag && <span className={`dfg-chip dfg-chip--${row.tone}`}>{row.tag}</span>}
          </div>
          <div className="dfg-track">
            {/* 2px floor so a 0.7% bar is still a mark on the page
                rather than nothing at all — the row means "almost
                never", not "no data". */}
            <div
              className={`dfg-fill dfg-fill--${row.tone}`}
              style={{ width: `max(2px, ${row.pct}%)` }}
            />
          </div>
          <div className="dfg-odds-val">{row.pct}%</div>
        </div>
      ))}
      <div className="dfg-odds-row dfg-odds-scale" aria-hidden="true">
        <div className="dfg-odds-name" />
        <div className="dfg-scale">
          <span>0</span><span>50%</span><span>100%</span>
        </div>
        <div className="dfg-odds-val" />
      </div>
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-crossing-vs-matched
// ------------------------------------------------------------------

/** The question this exists to answer, asked in review and then asked
 *  again by the first reader: "if two ships intersect, do they shoot at
 *  each other for the whole transfer?"
 *
 *  This figure was originally drawn as TWO panels — a crossing that
 *  does nothing and a matched pair that fights to the death — and that
 *  framing was wrong in a way worth recording, because it is the
 *  intuitive one. It reads as a binary, and the mechanic is a
 *  continuum: what governs the encounter is RELATIVE SPEED, and the
 *  interesting case is neither pole. Two ships on nearly parallel
 *  courses that nobody intended as a fight sit in range for three or
 *  four ticks and trade about one and a half hits. Drawing two poles
 *  hides the middle, which is exactly the case a reader spotted and
 *  the case that will actually surprise people in play.
 *
 *  Hence three panels ordered by relative speed, plus a strip of every
 *  measured point beneath them: the reader has to see a slope, not a
 *  switch. Numbers walked tick by tick through worker/transitCombat.js
 *  (corvette range 12, attacker speed 0.85, defender 0.55). */
const CROSS_SPECTRUM: {
  label: string; dv: string; hits: number; tone: 'none' | 'mid' | 'warn' | 'full'; tag?: string;
}[] = [
  // These two carry the closing-speed bonus (+10% ramping in from
  // 50 u/t). Head-on now beats a crossing, which is the point of it:
  // charging straight in is boresighted and easy to aim at, sweeping
  // past sideways is not. Everything below 50 u/t is untouched.
  { label: 'Head-on at cruise', dv: '378', hits: 0.24, tone: 'mid' },
  { label: 'Paths cross at cruise', dv: '211', hits: 0.15, tone: 'none' },
  { label: 'Beam pass, moon system', dv: '42', hits: 0.28, tone: 'mid' },
  { label: 'Loose convoy, near-parallel', dv: '10', hits: 1.46, tone: 'warn', tag: 'a fight nobody ordered' },
  { label: 'Near-matched', dv: '4', hits: 3.86, tone: 'warn' },
  { label: 'Matched, same lane', dv: '0.5', hits: 8.41, tone: 'full', tag: 'to the death' },
];
const CROSS_MAX = 8.41;

const CrossingVsMatched: React.FC = () => (
  <Figure
    title="It is a slope, not a switch"
    sub="what matters is speed between the two ships — not the angle they meet at"
    note={
      <>
        Crossing paths is not a battle. You pass, and it is over. But you
        do not have to plan a fight to get one. <b>Anything flying roughly
        alongside you is a running fight.</b> A small speed difference
        means three or four ticks of shooting. No difference at all means
        neither ship can leave, because a burn cannot be changed once it
        starts.
      </>
    }
  >
    <div className="dfg-three">
      <div className="dfg-panel">
        <div className="dfg-panel-head">
          <span className="dfg-panel-title">Cross</span>
          <span className="dfg-dv">Δv 211 u/tick</span>
        </div>
        <svg
          className="dfg-svg"
          viewBox="0 0 260 170"
          role="img"
          aria-label="Two flight paths crossing at a steep angle at high
            relative speed. Only a sliver of each path, where they intersect,
            falls inside weapon range."
        >
          {/* Both full trajectories, thin: the tick is mostly travel. */}
          <line x1="10" y1="155" x2="250" y2="25" className="dfg-path" />
          <line x1="20" y1="20" x2="240" y2="150" className="dfg-path dfg-path--b" />

          {/* The range envelope at closest approach. Dashed because it
              is a reach, not an object. */}
          <circle cx="134" cy="88" r="17" className="dfg-envelope" />

          {/* The overlap — the only stretch either ship can shoot in.
              Drawn thick so the eye reads LENGTH, which is the quantity
              that decides the encounter. */}
          <line x1="120.8" y1="95.1" x2="147.2" y2="80.9" className="dfg-overlap" />
          <line x1="121.1" y1="80.4" x2="146.9" y2="95.6" className="dfg-overlap dfg-overlap--b" />

          <polygon points={head(250, 25, 0.879, -0.476)} className="dfg-headA" />
          <polygon points={head(240, 150, 0.861, 0.509)} className="dfg-headB" />
        </svg>
        <div className="dfg-panel-stat">
          <span className="dfg-stat dfg-stat--none">0.15</span>
          <span className="dfg-stat-unit">hits landed, whole encounter</span>
        </div>
        <p className="dfg-panel-note">
          In range for a fraction of one tick. You pass, and it is over.
        </p>
      </div>

      <div className="dfg-panel dfg-panel--key">
        <div className="dfg-panel-head">
          <span className="dfg-panel-title">Near-parallel</span>
          <span className="dfg-dv">Δv 10 u/tick</span>
        </div>
        <svg
          className="dfg-svg"
          viewBox="0 0 260 170"
          role="img"
          aria-label="Two flight paths on almost the same heading, drifting
            slowly apart. They stay inside weapon range of each other for
            about four consecutive ticks in the middle of the flight."
        >
          {/* The stretch where they are close enough to shoot. Four
              ticks of it, in the middle of a flight neither of them
              planned as an engagement. */}
          <rect x="66" y="84" width="130" height="46" rx="10" className="dfg-zone" />

          <path d="M 10 80 Q 130 112 250 82" className="dfg-path" />
          <line x1="10" y1="118" x2="250" y2="118" className="dfg-path dfg-path--b" />

          {/* Eight ticks along each track; the four inside the zone are
              the volleys. Counting them is the point of the panel. */}
          <circle cx="10" cy="80" r="2.6" className="dfg-tickdot" />
          <circle cx="44.3" cy="87.9" r="2.6" className="dfg-tickdot" />
          <circle cx="78.6" cy="93.2" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="112.9" cy="96" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="147.1" cy="96.3" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="181.4" cy="94.1" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="215.7" cy="89.3" r="2.6" className="dfg-tickdot" />

          <circle cx="10" cy="118" r="2.6" className="dfg-tickdot dfg-tickdot--b" />
          <circle cx="44.3" cy="118" r="2.6" className="dfg-tickdot dfg-tickdot--b" />
          <circle cx="78.6" cy="118" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="112.9" cy="118" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="147.1" cy="118" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="181.4" cy="118" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="215.7" cy="118" r="2.6" className="dfg-tickdot dfg-tickdot--b" />

          <polygon points={head(250, 82, 0.968, -0.25)} className="dfg-headA" />
          <polygon points={head(250, 118, 1, 0)} className="dfg-headB" />
        </svg>
        <div className="dfg-panel-stat">
          <span className="dfg-stat dfg-stat--warn">1.46</span>
          <span className="dfg-stat-unit">hits landed, whole encounter</span>
        </div>
        <p className="dfg-panel-note">
          Three to four ticks of volleys between ships that never chose
          to engage. <b>This is the case that surprises people.</b>
        </p>
      </div>

      <div className="dfg-panel">
        <div className="dfg-panel-head">
          <span className="dfg-panel-title">Matched</span>
          <span className="dfg-dv">Δv 0.5 u/tick</span>
        </div>
        <svg
          className="dfg-svg"
          viewBox="0 0 260 170"
          role="img"
          aria-label="Two flight paths running parallel for the whole
            journey. The entire lane is inside weapon range, so both ships are
            in contact on every tick until arrival."
        >
          {/* The lane itself is the highlight: in range for its whole
              length, which is the contrast the panel is built on. */}
          <path d="M 14 120 Q 130 72 246 62" className="dfg-lane" />
          <path d="M 14 110 Q 130 62 246 52" className="dfg-path" />
          <path d="M 14 130 Q 130 82 246 72" className="dfg-path dfg-path--b" />

          <circle cx="90.6" cy="82.5" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="167.1" cy="63.2" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="90.6" cy="102.5" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />
          <circle cx="167.1" cy="83.2" r="3.2" className="dfg-tickdot dfg-tickdot--hot" />

          <polygon points={head(246, 52, 0.996, -0.086)} className="dfg-headA" />
          <polygon points={head(246, 72, 0.996, -0.086)} className="dfg-headB" />
        </svg>
        <div className="dfg-panel-stat">
          <span className="dfg-stat dfg-stat--full">8.41</span>
          <span className="dfg-stat-unit">hits landed, whole encounter</span>
        </div>
        <p className="dfg-panel-note">
          In range every tick, all the way there. About 70% each shot.
          Neither ship can leave.
        </p>
      </div>
    </div>

    {/* The three panels are samples off one curve. This is the curve —
        every geometry that was measured, ordered by the thing that
        actually drives it. */}
    <div
      className="dfg-spectrum"
      role="img"
      aria-label={
        'Expected hits landed over a whole encounter, as relative speed falls: '
        + CROSS_SPECTRUM.map(r => `${r.label}, ${r.dv} units per tick, ${r.hits} hits`).join('; ')
        + '. The count rises by more than two hundred times from the fastest '
        + 'crossing to a matched lane.'
      }
    >
      <div className="dfg-spec-head">
        <span>relative speed, fast → slow</span>
        <span>hits landed, whole encounter</span>
      </div>
      {CROSS_SPECTRUM.map(r => (
        <div className="dfg-spec-row" key={r.label}>
          <div className="dfg-spec-name">
            {r.label}
            {r.tag && <span className={`dfg-chip dfg-chip--${r.tone}`}>{r.tag}</span>}
          </div>
          <div className="dfg-spec-dv">{r.dv} u/t</div>
          <div className="dfg-track">
            <div
              className={`dfg-fill dfg-fill--${r.tone}`}
              style={{ width: `max(2px, ${(100 * r.hits) / CROSS_MAX}%)` }}
            />
          </div>
          <div className="dfg-spec-val">{r.hits.toFixed(2)}</div>
        </div>
      ))}
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-aim-exposure
// ------------------------------------------------------------------

/** Two panels per half, because each half is a comparison and neither
 *  half means anything alone. The revision this documents exists
 *  precisely because one number was doing both jobs. */
const AimExposure: React.FC = () => (
  <Figure
    title="Two different reasons a shot misses"
    sub="aim is geometry; exposure is time — and one number cannot carry both"
    note={
      <>
        Collapse these into a single "how fast is it going" term and
        flight can only ever be a penalty, which is what the first
        version got wrong. Split them and a radial departure and a beam
        pass at the <em>same speed</em> come out 45 points apart.
      </>
    }
  >
    <div className="dfg-half">
      <div className="dfg-half-head">
        <span className="dfg-half-title">Aim</span>
        <span className="dfg-half-sub">
          only sideways motion sweeps a target across your sights
        </span>
      </div>
      <div className="dfg-two">
        <div className="dfg-panel dfg-panel--flat">
          <svg
            className="dfg-svg dfg-svg--mini"
            viewBox="0 0 200 130"
            role="img"
            aria-label="A gunsight with a target closing head-on: the target
              is drawn twice, small then large, both dead centre. Its bearing
              never changes, only its size."
          >
            <circle cx="100" cy="66" r="34" className="dfg-reticle" />
            <circle cx="100" cy="66" r="13" className="dfg-reticle dfg-reticle--in" />
            <line x1="52" y1="66" x2="78" y2="66" className="dfg-cross" />
            <line x1="122" y1="66" x2="148" y2="66" className="dfg-cross" />
            <line x1="100" y1="18" x2="100" y2="44" className="dfg-cross" />
            <line x1="100" y1="88" x2="100" y2="114" className="dfg-cross" />
            {/* Same centre, twice the size: closing changes range and
                nothing else. */}
            <polygon points="91,66 106.3,60.4 106.3,71.6" className="dfg-target dfg-target--ghost" />
            <polygon points="83,66 111.9,55.5 111.9,76.5" className="dfg-target" />
          </svg>
          <p className="dfg-panel-note">
            <b>Head-on.</b> It sits still in the reticle and just grows.
            Nothing to track — easy to aim at.
          </p>
        </div>
        <div className="dfg-panel dfg-panel--flat">
          <svg
            className="dfg-svg dfg-svg--mini"
            viewBox="0 0 200 130"
            role="img"
            aria-label="The same gunsight with a target crossing it: three
              positions left to right, with a sweep arrow, so the sight has to
              swing the whole way across."
          >
            <circle cx="100" cy="66" r="34" className="dfg-reticle" />
            <circle cx="100" cy="66" r="13" className="dfg-reticle dfg-reticle--in" />
            <line x1="52" y1="66" x2="78" y2="66" className="dfg-cross" />
            <line x1="122" y1="66" x2="148" y2="66" className="dfg-cross" />
            <line x1="100" y1="18" x2="100" y2="44" className="dfg-cross" />
            <line x1="100" y1="88" x2="100" y2="114" className="dfg-cross" />
            <polygon points="63,66 47.5,60.4 47.5,71.6" className="dfg-target dfg-target--ghost2" />
            <polygon points="111,66 95.5,60.4 95.5,71.6" className="dfg-target dfg-target--ghost" />
            <polygon points="159,66 143.5,60.4 143.5,71.6" className="dfg-target dfg-target--warn" />
            <path d="M 54 30 Q 100 12 146 30" className="dfg-sweep" />
            <polygon points={head(146, 30, 0.72, 0.69, 8)} className="dfg-sweep-head" />
          </svg>
          <p className="dfg-panel-note">
            <b>Beam pass.</b> The bearing changes the whole time. This is
            the only motion that costs you the shot.
          </p>
        </div>
      </div>
    </div>

    <div className="dfg-half">
      <div className="dfg-half-head">
        <span className="dfg-half-title">Exposure</span>
        <span className="dfg-half-sub">
          how much of the tick it was in range to be shot at all
        </span>
      </div>
      <div className="dfg-two">
        <div className="dfg-panel dfg-panel--flat">
          <svg
            className="dfg-svg dfg-svg--mini"
            viewBox="0 0 200 130"
            role="img"
            aria-label="One tick of travel drawn as a long line, with the
              weapon's range envelope as a tiny circle crossing it near the
              middle. Only a sliver of the line is inside the envelope."
          >
            <line x1="8" y1="70" x2="186" y2="70" className="dfg-path dfg-path--dim" />
            <polygon points={head(192, 70, 1, 0)} className="dfg-headDim" />
            <line x1="8" y1="60" x2="8" y2="80" className="dfg-endtick" />
            <circle cx="100" cy="70" r="6" className="dfg-envelope dfg-envelope--tight" />
            <line x1="94" y1="70" x2="106" y2="70" className="dfg-overlap dfg-overlap--b" />
            <path d="M 94 82 L 94 88 L 106 88 L 106 82" className="dfg-bracket" />
          </svg>
          <p className="dfg-panel-note">
            <b>Fast contact.</b> A target crossing at 380 units a tick
            clears a 12-unit envelope in <b>6% of a tick</b>. Perfect aim
            is worth little with no time to use it.
          </p>
        </div>
        <div className="dfg-panel dfg-panel--flat">
          <svg
            className="dfg-svg dfg-svg--mini"
            viewBox="0 0 200 130"
            role="img"
            aria-label="The same envelope drawn much larger relative to the
              travel: one tick of movement is a short arrow that stays entirely
              inside the circle."
          >
            <circle cx="100" cy="70" r="44" className="dfg-envelope" />
            <line x1="86" y1="70" x2="108" y2="70" className="dfg-overlap" />
            <polygon points={head(114, 70, 1, 0)} className="dfg-headA" />
            <line x1="86" y1="60" x2="86" y2="80" className="dfg-endtick" />
          </svg>
          <p className="dfg-panel-note">
            <b>Slow contact.</b> A parked or matched target never leaves
            the envelope, so it is shootable for the <b>whole tick</b>.
            Drawn at its own scale — the envelope has not grown, the
            travel has shrunk.
          </p>
        </div>
      </div>
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-ship-range
// ------------------------------------------------------------------

/** Per-class reach, DESIGN-transit-combat.md R2. Drawn as circles on a
 *  shared scale rather than as bars: range is a radius in the world, and
 *  a bar chart would hide that a destroyer's envelope is not 1.67× a
 *  corvette's but 2.8× the area. */
const RANGES: { hull: string; range: number }[] = [
  { hull: 'Corvette', range: 12 },
  { hull: 'Frigate', range: 16 },
  { hull: 'Destroyer', range: 20 },
  { hull: 'Freighter', range: 0 },
  { hull: 'Colony', range: 0 },
];

const ShipRange: React.FC = () => (
  <Figure
    title="How far each hull can reach"
    sub="weapon range in world units, all five drawn to one scale"
    note={
      <>
        Bigger gun, longer reach — the corvette's edge is that it can{' '}
        <em>close</em>, not that it can reach. <b>Zero is not a typo:</b>{' '}
        an unarmed hull never initiates and is still perfectly targetable.
        Freighters run, they do not fight.
      </>
    }
  >
    <div className="dfg-ranges">
      {RANGES.map(r => (
        <div
          className={`dfg-range${r.range === 0 ? ' dfg-range--none' : ''}`}
          key={r.hull}
        >
          <svg
            className="dfg-svg"
            viewBox="-23 -23 46 46"
            role="img"
            aria-label={
              r.range === 0
                ? `${r.hull}: no weapon range. It never initiates and is always targetable.`
                : `${r.hull}: reach ${r.range} units in open space, ${r.range / 2} inside a planet's system.`
            }
          >
            {r.range > 0 && (
              <>
                <circle r={r.range} className="dfg-reach" />
                {/* Halved inside a sphere of influence: moon systems run
                    6-15 units between neighbours, so full reach covered
                    three orbits at once. */}
                <circle r={r.range / 2} className="dfg-reach dfg-reach--in" />
              </>
            )}
            <circle r={r.range === 0 ? 2.6 : 2} className="dfg-hull" />
          </svg>
          <div className="dfg-range-name">{r.hull}</div>
          <div className="dfg-range-val">{r.range === 0 ? '—' : r.range}</div>
        </div>
      ))}
    </div>
    <div className="dfg-legend">
      <span className="dfg-key"><span className="dfg-key-ring" /> open space</span>
      <span className="dfg-key"><span className="dfg-key-ring dfg-key-ring--in" /> inside a planet's system — halved</span>
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-vulnerable-window
// ------------------------------------------------------------------

/** A brachistochrone's speed profile, and the reason piracy happens at
 *  doors. Drawn without any text of its own — the labels below are HTML
 *  so they stay the same size on a phone as on a desktop. */
const VulnerableWindow: React.FC = () => (
  <Figure
    title="You get caught leaving or arriving"
    sub="speed over one flight — burn to the midpoint, flip, brake the rest of the way"
    note={
      <>
        Evasion tracks speed, and a torch flight is slowest at both ends.
        The vulnerable window is <b>about two ticks — one at each end —
        whatever the trip length</b>, because the first and last tick of
        any burn are identical. A fourteen-hour haul is two hours of
        exposure and twelve of untouchable cruise; long hauls are
        proportionally <em>safer</em>.
      </>
    }
  >
    <svg
      className="dfg-svg dfg-window"
      viewBox="0 0 700 190"
      role="img"
      aria-label="Speed rises in a straight line from zero at departure to a
        peak at the flip, then falls straight back to zero at arrival. The
        first and last tick, where speed is low, are shaded as catchable; the
        long fast middle is unshaded and untouchable."
    >
      <polygon points="40,160 350,30 660,160" className="dfg-win-fill" />

      {/* One tick wide at each end, on a fourteen-tick haul. The bands
          do not scale with the trip — that is the point of the figure. */}
      <rect x="40" y="22" width="44.3" height="138" className="dfg-win-band" />
      <rect x="615.7" y="22" width="44.3" height="138" className="dfg-win-band" />

      <polyline points="40,160 84.3,141.4" className="dfg-win-line" />
      <polyline points="84.3,141.4 350,30 615.7,141.4" className="dfg-win-line dfg-win-line--dim" />
      <polyline points="615.7,141.4 660,160" className="dfg-win-line" />

      <line x1="350" y1="30" x2="350" y2="160" className="dfg-win-flip" />
      <line x1="40" y1="160" x2="660" y2="160" className="dfg-win-axis" />
    </svg>
    <div className="dfg-window-x" aria-hidden="true">
      <span>depart</span>
      <span>flip — fastest</span>
      <span>arrive</span>
    </div>
    <div className="dfg-legend">
      <span className="dfg-key"><span className="dfg-key-band" /> catchable — one tick at each end</span>
      <span className="dfg-key"><span className="dfg-key-band dfg-key-band--off" /> untouchable — the entire cruise</span>
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-route-circuit
// ------------------------------------------------------------------

/** A route is a list of stops now, not an origin and a destination.
 *  Drawn as a chain with a return rule rather than as a ring: a ring
 *  reads well at 700px and collapses into an unreadable knot at 340,
 *  and the chain wraps to a column on a phone without losing the
 *  ordering, which is the thing being explained. */
const STOPS: { body: string; act: 'PICK UP' | 'DROP OFF'; cargo: string }[] = [
  { body: 'Ceres', act: 'PICK UP', cargo: 'metal' },
  { body: 'Mars', act: 'DROP OFF', cargo: 'metal' },
  { body: 'Earth', act: 'PICK UP', cargo: 'credits' },
  { body: 'Vesta', act: 'DROP OFF', cargo: 'credits' },
];

const RouteCircuit: React.FC = () => (
  <Figure
    title="A route is a circuit"
    sub="up to six stops, each one a pick up or a drop off, then it loops"
    note={
      <>
        The old route was an origin, a destination and one freighter
        shuttling between them. A circuit carries something on every
        leg, and more than one freighter can work it — on a two-stop
        run they start at opposite ends, so goods move both ways at once
        instead of in convoy.
      </>
    }
  >
    <div
      className="dfg-circuit"
      role="img"
      aria-label={
        'A four-stop trade circuit: '
        + STOPS.map(s => `${s.body}, ${s.act.toLowerCase()} ${s.cargo}`).join('; then ')
        + '; then it loops back to the first stop. A freighter is on the first leg.'
      }
    >
      {STOPS.map((s, i) => (
        <React.Fragment key={s.body}>
          <div className={`dfg-stop dfg-stop--${s.act === 'PICK UP' ? 'up' : 'off'}`}>
            <div className="dfg-stop-n">{i + 1}</div>
            <div className="dfg-stop-body">{s.body}</div>
            <div className="dfg-stop-act">{s.act}</div>
            <div className="dfg-stop-cargo">{s.cargo}</div>
          </div>
          {i < STOPS.length - 1 && (
            <div className="dfg-leg-arrow">
              {/* The freighter goes on one leg only. A marker on every
                  leg would read as four ships, which is a different
                  (and also true) picture — but not this one. */}
              {i === 0 && <span className="dfg-freighter">freighter</span>}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
    {/* The return leg, and its label UNDER it rather than sitting on
        it. A label centred on the rule has to punch an opaque hole in a
        background this component cannot know — the page is a starfield
        under a translucent panel — and at 320px the sentence is wider
        than the rule it would be sitting on. Below the rule it simply
        wraps. */}
    <div className="dfg-loop" aria-hidden="true" />
    <div className="dfg-loop-label" aria-hidden="true">
      loops — forever, or for a set number of runs
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// fig-folded-lane
// ------------------------------------------------------------------

/** Before and after, stacked rather than side by side: the two states
 *  differ in the number of LANES, and putting them in columns invites a
 *  reader to compare lane against lane instead of counting them. */
const FoldedLane: React.FC = () => (
  <Figure
    title="Folding a deal onto one lane"
    sub="a recurring deal used to commission two routes, each flying home empty"
    note={
      <>
        Every freighter on a folded lane collects <em>and</em> delivers
        at both ends. <b>Same ships, twice the trade.</b> Nobody gives up
        a hull — every freighter already working the deal comes across —
        so either party can just do it, without asking.
      </>
    }
  >
    <div className="dfg-fold">
      <div className="dfg-fold-block">
        <div className="dfg-fold-head">
          <span className="dfg-fold-tag">Before</span>
          <span className="dfg-fold-sub">two routes · 2 of 4 legs empty</span>
        </div>

        <div className="dfg-lanewrap" role="img" aria-label="Before: two
          separate routes between Ceres and Mars. Your route carries metal out
          and returns empty; their route carries credits the other way and also
          returns empty.">
          <div className="dfg-lane-row">
            <div className="dfg-node">Ceres</div>
            <div className="dfg-legs">
              <div className="dfg-leg dfg-leg--right">
                <span className="dfg-cargo">metal</span>
              </div>
              <div className="dfg-leg dfg-leg--left dfg-leg--empty">
                <span className="dfg-cargo dfg-cargo--empty">empty</span>
              </div>
            </div>
            <div className="dfg-node">Mars</div>
          </div>
          <div className="dfg-lane-name">your route</div>

          <div className="dfg-lane-row">
            <div className="dfg-node">Ceres</div>
            <div className="dfg-legs">
              <div className="dfg-leg dfg-leg--right dfg-leg--empty">
                <span className="dfg-cargo dfg-cargo--empty">empty</span>
              </div>
              <div className="dfg-leg dfg-leg--left">
                <span className="dfg-cargo">credits</span>
              </div>
            </div>
            <div className="dfg-node">Mars</div>
          </div>
          <div className="dfg-lane-name">their route</div>
        </div>
      </div>

      <div className="dfg-fold-arrow" aria-hidden="true">fold</div>

      <div className="dfg-fold-block dfg-fold-block--after">
        <div className="dfg-fold-head">
          <span className="dfg-fold-tag dfg-fold-tag--after">After</span>
          <span className="dfg-fold-sub">one lane · 0 of 4 legs empty</span>
        </div>

        <div className="dfg-lanewrap" role="img" aria-label="After: one lane
          between Ceres and Mars carrying metal out and credits back. Both
          freighters work it, and no leg is empty.">
          <div className="dfg-lane-row">
            <div className="dfg-node">Ceres</div>
            <div className="dfg-legs">
              <div className="dfg-leg dfg-leg--right">
                <span className="dfg-cargo">metal</span>
              </div>
              <div className="dfg-leg dfg-leg--left">
                <span className="dfg-cargo">credits</span>
              </div>
            </div>
            <div className="dfg-node">Mars</div>
          </div>
          <div className="dfg-lane-name">one lane, both freighters, both directions loaded</div>
        </div>
      </div>
    </div>
  </Figure>
);

// ------------------------------------------------------------------
// THE REGISTRY. Keys are the placeholder class names, verbatim — see
// the file header for the three places each one has to agree.
// ------------------------------------------------------------------
export const DEVLOG_FIGURES: Record<string, React.FC> = {
  'fig-hit-odds': HitOdds,
  'fig-crossing-vs-matched': CrossingVsMatched,
  'fig-aim-exposure': AimExposure,
  'fig-ship-range': ShipRange,
  'fig-vulnerable-window': VulnerableWindow,
  'fig-route-circuit': RouteCircuit,
  'fig-folded-lane': FoldedLane,
};
