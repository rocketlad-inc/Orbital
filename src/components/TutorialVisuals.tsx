// ============================================================
// TutorialVisuals — inline SVG illustrations for tutorial steps
// that have no menu on screen (Lorne's rule: every step either
// points at a live, open surface or carries a visual).
//
// House palette: amber #ffb84d (tutorial accent), teal #4ecdc4
// (player), sky #7fd4ff (info), red #ff5e5e (danger), muted
// #64809c. Each visual is ~300×110, drawn to read at card width
// with no text smaller than the card's own captions.
// ============================================================

import React from 'react';
import type { TutorialVisualId } from '../game/tutorialSteps';

const W = 300;
const H = 110;

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    viewBox={`0 0 ${W} ${H}`}
    width="100%"
    style={{ display: 'block', background: 'rgba(8, 14, 22, 0.7)', borderRadius: 6, border: '1px solid #1c2c3e' }}
    aria-hidden
  >
    {children}
  </svg>
);

/** Three win-condition emblems: gavel, 60% map pie, caged sun. */
const Victory = () => (
  <Frame>
    {/* Chancellor — laurel + star over a podium */}
    <g transform="translate(50,55)">
      <circle r={26} fill="none" stroke="#c4b5fd" strokeWidth={1.2} strokeDasharray="3 3" />
      <path d="M-10 12 L10 12 L7 -2 L-7 -2 Z" fill="rgba(196,181,253,0.25)" stroke="#c4b5fd" strokeWidth={1.2} />
      <path d="M0 -14 L2.6 -6.5 L10.5 -6.5 L4.2 -1.8 L6.6 5.5 L0 1 L-6.6 5.5 L-4.2 -1.8 L-10.5 -6.5 L-2.6 -6.5 Z"
        fill="#c4b5fd" />
      <text y={44} textAnchor="middle" fill="#c4b5fd" fontSize={9} letterSpacing={1.5} fontWeight={700}>CHANCELLOR</text>
    </g>
    {/* Domination — pie past 60% in player teal */}
    <g transform="translate(150,55)">
      <circle r={26} fill="none" stroke="#64809c" strokeWidth={1.2} />
      {/* 62% wedge */}
      <path d="M0 0 L0 -26 A26 26 0 1 1 -19.3 17.4 Z" fill="rgba(78,205,196,0.35)" stroke="#4ecdc4" strokeWidth={1.5} />
      <text y={4} textAnchor="middle" fill="#4ecdc4" fontSize={11} fontWeight={800}>60%</text>
      <text y={44} textAnchor="middle" fill="#4ecdc4" fontSize={9} letterSpacing={1.5} fontWeight={700}>DOMINATION</text>
    </g>
    {/* Engineering — sun in a segment cage */}
    <g transform="translate(250,55)">
      <circle r={10} fill="#ffb84d" opacity={0.9} />
      <circle r={10} fill="none" stroke="#ffdca8" strokeWidth={4} opacity={0.35} />
      {[0, 60, 120, 180, 240].map(a => (
        <path
          key={a}
          d="M0 -22 A22 22 0 0 1 18 -12.5"
          fill="none" stroke="#ffb84d" strokeWidth={2.5}
          transform={`rotate(${a})`}
        />
      ))}
      <text y={44} textAnchor="middle" fill="#ffb84d" fontSize={9} letterSpacing={1.2} fontWeight={700}>ENGINEERING</text>
    </g>
  </Frame>
);

/** Map controls: drag hand, zoom rings, click-a-world cursor. */
const MapControls = () => (
  <Frame>
    {/* Orbits + worlds */}
    <circle cx={150} cy={55} r={40} fill="none" stroke="#2a3d50" strokeWidth={1} />
    <circle cx={150} cy={55} r={22} fill="none" stroke="#2a3d50" strokeWidth={1} />
    <circle cx={150} cy={55} r={5} fill="#ffb84d" />
    <circle cx={172} cy={55} r={4} fill="#4ecdc4" />
    <circle cx={121} cy={30} r={3} fill="#8fa8bf" />
    {/* Drag arrows */}
    <g stroke="#7fd4ff" strokeWidth={1.6} fill="none" opacity={0.9}>
      <path d="M40 55 h-18 m4 -4 l-4 4 l4 4" />
      <path d="M60 35 v-14 m-4 4 l4 -4 l4 4" />
    </g>
    <text x={48} y={80} textAnchor="middle" fill="#7fd4ff" fontSize={8.5} letterSpacing={1}>DRAG · PAN</text>
    {/* Zoom rings */}
    <g transform="translate(252,42)" stroke="#7fd4ff" fill="none" opacity={0.9}>
      <circle r={7} strokeWidth={1.4} />
      <circle r={13} strokeWidth={1} strokeDasharray="2 2" />
      <path d="M5 5 l7 7" strokeWidth={1.6} />
    </g>
    <text x={252} y={80} textAnchor="middle" fill="#7fd4ff" fontSize={8.5} letterSpacing={1}>SCROLL · ZOOM</text>
    {/* Click cursor on the teal world */}
    <path d="M176 47 l6 14 l3 -5 l5 3 l2 -3 l-5 -3 l4 -4 Z" fill="#e8f4fb" stroke="#0a1018" strokeWidth={0.8} />
    <text x={150} y={104} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={1}>CLICK A WORLD — THE MAP IS THE MENU</text>
  </Frame>
);

/** Economy: settlement → collector → treasury flow. */
const Economy = () => (
  <Frame>
    <g transform="translate(48,52)">
      <circle r={16} fill="#2b3d52" stroke="#64809c" />
      <rect x={-5} y={-7} width={10} height={8} fill="#8fa8bf" />
      <text y={34} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={1}>SETTLEMENT</text>
    </g>
    <g stroke="#ffb84d" strokeWidth={1.6} fill="none">
      <path d="M72 52 h44 m-6 -4 l6 4 l-6 4" />
      <path d="M186 52 h44 m-6 -4 l6 4 l-6 4" />
    </g>
    <g transform="translate(150,52)">
      <circle r={15} fill="none" stroke="#4ecdc4" strokeWidth={1.6} />
      <path d="M-6 5 L0 -7 L6 5 Z" fill="rgba(78,205,196,0.4)" stroke="#4ecdc4" />
      <text y={33} textAnchor="middle" fill="#4ecdc4" fontSize={8.5} letterSpacing={1}>COLLECTOR</text>
    </g>
    <g transform="translate(252,52)">
      <rect x={-16} y={-11} width={32} height={22} rx={3} fill="rgba(255,184,77,0.15)" stroke="#ffb84d" strokeWidth={1.4} />
      <text y={4} textAnchor="middle" fill="#ffb84d" fontSize={10} fontWeight={800}>M·C·S</text>
      <text y={33} textAnchor="middle" fill="#ffb84d" fontSize={8.5} letterSpacing={1}>TREASURY</text>
    </g>
  </Frame>
);

/** Upkeep: treasury paying three hulls; red −25% when it runs dry. */
const Upkeep = () => (
  <Frame>
    <g transform="translate(52,48)">
      <rect x={-18} y={-13} width={36} height={26} rx={3} fill="rgba(255,184,77,0.15)" stroke="#ffb84d" strokeWidth={1.4} />
      <text y={4} textAnchor="middle" fill="#ffb84d" fontSize={10} fontWeight={800}>TREASURY</text>
    </g>
    {[0, 1, 2].map(i => (
      <g key={i} transform={`translate(${170 + i * 46},48)`}>
        <path d="M-12 0 L4 -7 L12 0 L4 7 Z" fill="rgba(78,205,196,0.35)" stroke="#4ecdc4" strokeWidth={1.3} />
      </g>
    ))}
    <g stroke="#ffb84d" strokeWidth={1.4} fill="none" opacity={0.9}>
      <path d="M74 48 h74 m-5 -4 l5 4 l-5 4" />
    </g>
    <circle cx={110} cy={40} r={4} fill="#ffd98a" />
    <circle cx={124} cy={52} r={3} fill="#ffd98a" />
    <text x={150} y={86} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={0.8}>
      EVERY HULL BILLS PER TICK · EMPTY TREASURY =
    </text>
    <text x={252} y={86} textAnchor="middle" fill="#ff5e5e" fontSize={9} fontWeight={800} letterSpacing={0.8}>
      −25% DMG
    </text>
  </Frame>
);

/** Senate: weighted vote bars + the one-shot chancellor star. */
const Senate = () => (
  <Frame>
    <g transform="translate(66,60)">
      {/* Podium */}
      <path d="M-16 14 L16 14 L11 -6 L-11 -6 Z" fill="rgba(196,181,253,0.25)" stroke="#c4b5fd" strokeWidth={1.3} />
      <circle cy={-14} r={6} fill="none" stroke="#c4b5fd" strokeWidth={1.3} />
      <text y={34} textAnchor="middle" fill="#c4b5fd" fontSize={8.5} letterSpacing={1}>ONE BID · EVER</text>
    </g>
    {/* Vote-weight bars = worlds held */}
    <g transform="translate(150,74)">
      {[{ h: 34, c: '#4ecdc4' }, { h: 22, c: '#ff8a40' }, { h: 14, c: '#c4b5fd' }, { h: 8, c: '#8fa8bf' }].map((b, i) => (
        <rect key={i} x={i * 22 - 8} y={-b.h} width={14} height={b.h} fill={b.c} opacity={0.75} rx={2} />
      ))}
      <text x={26} y={16} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={1}>VOTES = WORLDS HELD</text>
    </g>
    <text x={150} y={16} textAnchor="middle" fill="#c4b5fd" fontSize={9} letterSpacing={1.5} fontWeight={700}>
      BILLS BEND THE RULES FOR EVERYONE
    </text>
  </Frame>
);

/** Dyson: caged sun with freighters pumping from Sol. */
const Dyson = () => (
  <Frame>
    <g transform="translate(90,55)">
      <circle r={16} fill="#ffb84d" opacity={0.9} />
      <circle r={16} fill="none" stroke="#ffdca8" strokeWidth={6} opacity={0.25} />
      {/* Partial cage — progress */}
      {[0, 45, 90, 135].map(a => (
        <path key={a} d="M0 -26 A26 26 0 0 1 17 -19.5" fill="none" stroke="#ffb84d" strokeWidth={2.6}
          transform={`rotate(${a})`} />
      ))}
      {/* Scaffold remainder */}
      <circle r={26} fill="none" stroke="#ffb84d" strokeWidth={1} strokeDasharray="3 4" opacity={0.35} />
    </g>
    {/* Freighters queued at Sol pumping in */}
    {[0, 1].map(i => (
      <g key={i} transform={`translate(${168 + i * 42},55)`}>
        <rect x={-9} y={-5} width={14} height={10} rx={2} fill="rgba(78,205,196,0.35)" stroke="#4ecdc4" strokeWidth={1.2} />
        <path d={`M-14 0 h-14 m4 -3 l-4 3 l4 3`} stroke="#4ecdc4" strokeWidth={1.3} fill="none" />
      </g>
    ))}
    <text x={185} y={86} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={0.8}>
      FREIGHTERS AT SOL PUMP YOUR TREASURY IN
    </text>
    <text x={90} y={16} textAnchor="middle" fill="#ff5e5e" fontSize={8.5} letterSpacing={0.8}>
      DAMAGE BURNS PROGRESS OFF
    </text>
  </Frame>
);

/** Situation report + herald: ranked inbox rows + a front page. */
const Herald = () => (
  <Frame>
    {/* Inbox rows */}
    <g transform="translate(20,22)">
      {[
        { c: '#ff5e5e', label: 'NOW — under attack', w: 118 },
        { c: '#ffb84d', label: 'DECISION — idle yard', w: 104 },
        { c: '#8fa8bf', label: 'OPPORTUNITY', w: 88 },
      ].map((r, i) => (
        <g key={i} transform={`translate(0,${i * 22})`}>
          <rect width={130} height={15} rx={3} fill="rgba(20,32,44,0.9)" stroke="#2a3d50" />
          <circle cx={9} cy={7.5} r={3} fill={r.c} />
          <rect x={17} y={5} width={r.w - 26} height={5} rx={2} fill={r.c} opacity={0.55} />
        </g>
      ))}
      <text x={65} y={80} textAnchor="middle" fill="#8fa8bf" fontSize={8.5} letterSpacing={1}>EVERY ROW IS A LINK</text>
    </g>
    {/* Herald front page */}
    <g transform="translate(190,16)">
      <rect width={92} height={64} rx={3} fill="rgba(20,32,44,0.9)" stroke="#ffb84d" strokeWidth={1.2} />
      <text x={46} y={13} textAnchor="middle" fill="#ffb84d" fontSize={7.5} letterSpacing={1.4} fontWeight={800}>THE ORBITAL HERALD</text>
      <rect x={8} y={20} width={76} height={7} rx={2} fill="#e8f4fb" opacity={0.85} />
      <rect x={8} y={32} width={56} height={4} rx={2} fill="#8fa8bf" opacity={0.6} />
      <rect x={8} y={40} width={64} height={4} rx={2} fill="#8fa8bf" opacity={0.6} />
      <rect x={8} y={48} width={48} height={4} rx={2} fill="#8fa8bf" opacity={0.6} />
      <text x={46} y={92} textAnchor="middle" fill="#ffb84d" fontSize={8.5} letterSpacing={1}>THE WAR'S FRONT PAGE</text>
    </g>
  </Frame>
);

const VISUALS: Record<TutorialVisualId, React.FC> = {
  victory: Victory,
  'map-controls': MapControls,
  economy: Economy,
  upkeep: Upkeep,
  senate: Senate,
  dyson: Dyson,
  herald: Herald,
};

export const TutorialVisual: React.FC<{ id: TutorialVisualId }> = ({ id }) => {
  const V = VISUALS[id];
  if (!V) return null;
  return (
    <div style={{ margin: '8px 0 2px' }}>
      <V />
    </div>
  );
};
