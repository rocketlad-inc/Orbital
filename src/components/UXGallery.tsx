// ============================================================
// UXGallery — 4 directions × {Desktop, Mobile, Spreadsheet} mockups
//
// Each mockup is static markup, not a working component. It's a
// visual exploration of how the player UX could be structured.
// ============================================================

import React, { useState } from 'react';
import './UXGallery.css';

interface UXGalleryProps {
  onBack: () => void;
}

type ViewMode = 'desktop' | 'mobile' | 'spreadsheet';

interface Direction {
  id: string;
  number: string;
  name: string;
  inspiredBy: string;
  tagline: string;
  pitch: string;
  pros: string[];
  cons: string[];
  Desktop: React.FC;
  Mobile: React.FC;
  Spreadsheet: React.FC;
  /** Which view the card opens on. Mobile-first studies open on 📱. */
  defaultView?: ViewMode;
}

// ============================================================
// Reusable mockup primitives
// ============================================================

const MiniOrbitalMap: React.FC<{ scale?: number; highlight?: string }> = ({ scale = 1 }) => (
  <svg viewBox="0 0 200 200" className="mock-mini-map" preserveAspectRatio="xMidYMid meet">
    {/* orbits */}
    <circle cx="100" cy="100" r="30" stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="100" cy="100" r="55" stroke="#3d4f60" strokeWidth="0.7" fill="none" />
    <circle cx="100" cy="100" r="78" stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="100" cy="100" r="95" stroke="#3d2820" strokeWidth="0.7" fill="none" />
    {/* sun */}
    <circle cx="100" cy="100" r="6" fill="#ffd180" />
    {/* mercury */}
    <circle cx="130" cy="100" r="1.6" fill="#b8c8d6" />
    {/* venus */}
    <circle cx="100" cy="155" r="2.3" fill="#e8c896" />
    {/* earth — pulse */}
    <circle cx="178" cy="100" r="3.2" fill="#4ecdc4" />
    <circle cx="178" cy="100" r="6" fill="none" stroke="#4ecdc4" strokeWidth="0.6" opacity="0.5" />
    {/* mars */}
    <circle cx="100" cy="5" r="2.4" fill="#d8784a" />
    {/* transfer arc */}
    <path d="M 178 100 Q 160 30 100 5" stroke="#ffb84d" strokeWidth="0.8" fill="none" strokeDasharray="2 2" />
    {/* ship */}
    <circle cx="142" cy="50" r="1.4" fill="#ffb84d" />
  </svg>
);

const StatChip: React.FC<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' }> = ({
  label, value, tone = 'neutral',
}) => (
  <div className={`mock-stat-chip mock-stat-chip--${tone}`}>
    <span className="mock-stat-chip__label">{label}</span>
    <span className="mock-stat-chip__value">{value}</span>
  </div>
);

const FakeRow: React.FC<{ cols: (string | number)[]; tone?: string }> = ({ cols, tone }) => (
  <div className={`mock-row ${tone ? `mock-row--${tone}` : ''}`}>
    {cols.map((c, i) => <span key={i} className="mock-row__cell">{c}</span>)}
  </div>
);

// ============================================================
// WORLD MENU STUDY — annotated-schematic body view
// (from Lorne's whiteboard sketch, 2026-07-19)
// ============================================================

/** Callout chip drawn inside an SVG scene: label + level + upgrade "+". */
const WMChip: React.FC<{
  x: number; y: number; w?: number; label: string; lv?: string; tone?: 'teal' | 'amber';
}> = ({ x, y, w = 58, label, lv, tone = 'teal' }) => {
  const c = tone === 'amber' ? '#ffb84d' : '#4ecdc4';
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width={w} height={22} rx={4} fill="rgba(13,21,32,0.88)" stroke={c} strokeWidth={0.8} />
      <text x={6} y={10} fontSize={7} fontFamily="Audiowide, monospace" fontWeight="bold" fill={c}>{label}</text>
      {lv && <text x={6} y={18.5} fontSize={6} fontFamily="Audiowide, monospace" fill="#8aa0b4">{lv}</text>}
      <text x={w - 11} y={15} fontSize={9} fontFamily="Audiowide, monospace" fill={c}>+</text>
    </g>
  );
};

/** Mobile map scene: the live map zoomed into Earth, with the world's
 *  controls overlaid in place — chips pinned to real structures, the
 *  shipyard popover open over the planet. No inspector panel exists. */
const WMMapMobile: React.FC = () => (
  <svg viewBox="0 0 240 434" className="ux-wm-svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <radialGradient id="wm-planet-m" cx="38%" cy="32%" r="85%">
        <stop offset="0%" stopColor="#2a6b74" />
        <stop offset="55%" stopColor="#1a4a56" />
        <stop offset="100%" stopColor="#0d2e3a" />
      </radialGradient>
    </defs>
    {/* starfield */}
    {[[18,30,.5],[66,52,.35],[150,24,.55],[222,84,.3],[30,150,.4],[210,150,.5],
      [16,330,.35],[228,340,.4],[40,392,.3],[196,398,.5],[120,66,.3],[88,140,.25]]
      .map(([x,y,o],i) => <circle key={i} cx={x} cy={y} r={0.9} fill="#d8e4ee" opacity={o} />)}
    {/* heliocentric orbit passing through */}
    <path d="M -20 44 Q 120 14 260 52" stroke="#2d4255" strokeWidth={1} fill="none" />
    {/* Luna, further out */}
    <circle cx={214} cy={44} r={3.5} fill="#9fb3c8" />
    <text x={214} y={54} fontSize={5.5} fontFamily="Audiowide, monospace" fill="#5a7085" textAnchor="middle">LUNA</text>
    {/* station orbit */}
    <circle cx={120} cy={300} r={118} fill="none" stroke="#3d5568" strokeWidth={0.8} strokeDasharray="3 4" />
    {/* the planet — this IS the menu */}
    <circle cx={120} cy={300} r={92} fill="url(#wm-planet-m)" stroke="#2b5e58" strokeWidth={1} />
    {/* selection brackets (same treatment the map uses today) */}
    <g stroke="#ffb84d" strokeWidth={1.5} fill="none" opacity={0.9}>
      <path d="M 20 214 L 20 200 L 34 200" />
      <path d="M 206 200 L 220 200 L 220 214" />
      <path d="M 220 386 L 220 400 L 206 400" />
      <path d="M 34 400 L 20 400 L 20 386" />
    </g>
    {/* city structures on the rim */}
    <ellipse cx={80} cy={220} rx={36} ry={13} fill="#ffb84d" opacity={0.05} />
    <path d="M 54 233 L 62 229 L 70 233 Z" fill="#3d5a6b" />
    <rect x={55} y={233} width={14} height={8} fill="#46687c" />
    <line x1={59} y1={234.5} x2={59} y2={240.5} stroke="#1c2a3a" strokeWidth={1.2} />
    <line x1={65} y1={234.5} x2={65} y2={240.5} stroke="#1c2a3a" strokeWidth={1.2} />
    <rect x={82} y={200} width={3.5} height={16} fill="#3d5a6b" />
    <rect x={88} y={194} width={4} height={22} fill="#46687c" />
    <line x1={90} y1={194} x2={90} y2={188} stroke="#8aa0b4" strokeWidth={0.8} />
    <circle cx={90} cy={187} r={1.2} fill="#67e8f9" />
    <rect x={94} y={203} width={14} height={8} fill="#46687c" />
    <rect x={105} y={197} width={3} height={6} fill="#3d5a6b" />
    <circle cx={106.5} cy={194} r={1.2} fill="#8aa0b4" opacity={0.55} />
    {/* surface callouts — pinned to the structures */}
    <line x1={62} y1={127} x2={86} y2={202} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={62} y1={175} x2={60} y2={230} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={62} y1={223} x2={98} y2={206} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <WMChip x={4} y={116} label="LAB" lv="LV 2 · +50% sci" />
    <WMChip x={4} y={164} label="MINT" lv="LV 1 · +25% cred" />
    <WMChip x={4} y={212} label="FORGE" lv="LV 3 · +75% metal" />
    {/* the station — at the TOP of its orbit, directly above the planet,
        so the whole stack (station, popover, planet) fits a narrow screen */}
    <rect x={118.75} y={170} width={2.5} height={24} fill="#9fb3c8" />
    <rect x={113} y={172} width={4.5} height={2.5} fill="#23445c" stroke="#46687c" strokeWidth={0.4} />
    <rect x={121.5} y={172} width={4.5} height={2.5} fill="#23445c" stroke="#46687c" strokeWidth={0.4} />
    <ellipse cx={120} cy={182} rx={7} ry={2.5} fill="none" stroke="#8aa0b4" strokeWidth={1.2} />
    <rect x={117} y={179} width={6} height={6} rx={1} fill="#46687c" />
    <circle cx={120} cy={169} r={1} fill="#ffb84d" />
    {/* station callouts flank it left and right */}
    <line x1={64} y1={79} x2={114} y2={173} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={176} y1={79} x2={127} y2={180} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <WMChip x={4} y={68} w={60} label="WEAPONS" lv="LV 1" />
    <WMChip x={176} y={68} w={60} label="ORB. LAB" lv="LV 1" />
    {/* shipyard chip — tapped, so its popover is open ON the map */}
    <line x1={140} y1={121} x2={128} y2={183} stroke="#ffb84d" strokeWidth={0.7} opacity={0.6} />
    <WMChip x={140} y={110} w={94} label="SHIPYARD" lv="LV 2 · 2 SLOTS" tone="amber" />
    <line x1={186} y1={132} x2={186} y2={140} stroke="#ffb84d" strokeWidth={0.8} />
    <g>
      <rect x={130} y={140} width={104} height={100} rx={6} fill="rgba(10,17,27,0.94)" stroke="#ffb84d" strokeWidth={0.9} />
      <text x={137} y={153} fontSize={7} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d">SHIPYARD — LV 2</text>
      <line x1={137} y1={158} x2={227} y2={158} stroke="#2a3d50" strokeWidth={0.8} />
      <text x={137} y={170} fontSize={6} fontFamily="Audiowide, monospace" fill="#d8e4ee">▰▰▱ Frigate "Aegis"</text>
      <text x={227} y={170} fontSize={6} fontFamily="Audiowide, monospace" fill="#ffb84d" textAnchor="end">T+8</text>
      <text x={137} y={182} fontSize={6} fontFamily="Audiowide, monospace" fill="#8aa0b4">▱▱▱ Corvette "Dart"</text>
      <text x={227} y={182} fontSize={6} fontFamily="Audiowide, monospace" fill="#8aa0b4" textAnchor="end">queued</text>
      <rect x={136} y={190} width={92} height={16} rx={3} fill="rgba(255,184,77,0.16)" stroke="#ffb84d" strokeWidth={0.8} />
      <text x={182} y={201} fontSize={7} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d" textAnchor="middle">+ BUILD SHIP</text>
      <rect x={136} y={212} width={92} height={14} rx={3} fill="rgba(42,61,80,0.4)" stroke="#4a6178" strokeWidth={0.8} />
      <text x={182} y={222} fontSize={6} fontFamily="Audiowide, monospace" fill="#b8c8d6" textAnchor="middle">⬆ UPGRADE · 60M 80C</text>
    </g>
    {/* map chrome */}
    <rect x={6} y={8} width={56} height={16} rx={8} fill="rgba(13,21,32,0.85)" stroke="#4a6178" strokeWidth={0.8} />
    <text x={34} y={19} fontSize={7} fontFamily="Audiowide, monospace" fill="#b8c8d6" textAnchor="middle">← SYSTEM</text>
    {/* selected-body label, exactly where the map draws it */}
    <text x={120} y={414} fontSize={11} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d" textAnchor="middle">EARTH</text>
    <text x={120} y={425} fontSize={7} fontFamily="Audiowide, monospace" fill="#ffd700" textAnchor="middle">2M · 6C · 3S</text>
    <text x={120} y={433} fontSize={6} fontFamily="Audiowide, monospace" fill="#8aa0b4" textAnchor="middle">HP 100 · POP 3/5 · COLLECTOR ✓ · +2.4M +7.2C +3.6S /t</text>
  </svg>
);

/** Desktop take on the same idea — wider frame, same diegetic overlay. */
const WMMapDesktop: React.FC = () => (
  <svg viewBox="0 0 560 340" className="ux-wm-svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <radialGradient id="wm-planet-d" cx="38%" cy="32%" r="85%">
        <stop offset="0%" stopColor="#2a6b74" />
        <stop offset="55%" stopColor="#1a4a56" />
        <stop offset="100%" stopColor="#0d2e3a" />
      </radialGradient>
    </defs>
    {[[30,40,.5],[120,26,.35],[260,60,.5],[380,30,.4],[470,70,.35],[540,150,.5],
      [40,240,.3],[80,320,.4],[300,326,.35],[430,300,.3],[520,250,.45],[350,140,.25]]
      .map(([x,y,o],i) => <circle key={i} cx={x} cy={y} r={1} fill="#d8e4ee" opacity={o} />)}
    <path d="M -20 36 Q 260 8 580 44" stroke="#2d4255" strokeWidth={1} fill="none" />
    <circle cx={195} cy={205} r={130} fill="none" stroke="#3d5568" strokeWidth={0.8} strokeDasharray="3 4" />
    <circle cx={195} cy={205} r={100} fill="url(#wm-planet-d)" stroke="#2b5e58" strokeWidth={1} />
    <g stroke="#ffb84d" strokeWidth={1.5} fill="none" opacity={0.9}>
      <path d="M 88 112 L 88 98 L 102 98" />
      <path d="M 288 98 L 302 98 L 302 112" />
      <path d="M 302 298 L 302 312 L 288 312" />
      <path d="M 102 312 L 88 312 L 88 298" />
    </g>
    <ellipse cx={148} cy={126} rx={38} ry={13} fill="#ffb84d" opacity={0.05} />
    <path d="M 126 131 L 134 127 L 142 131 Z" fill="#3d5a6b" />
    <rect x={127} y={131} width={14} height={9} fill="#46687c" />
    <rect x={150} y={106} width={3.5} height={16} fill="#3d5a6b" />
    <rect x={156} y={100} width={4} height={22} fill="#46687c" />
    <line x1={158} y1={100} x2={158} y2={94} stroke="#8aa0b4" strokeWidth={0.8} />
    <circle cx={158} cy={93} r={1.2} fill="#67e8f9" />
    <rect x={162} y={108} width={14} height={8} fill="#46687c" />
    <rect x={173} y={102} width={3} height={6} fill="#3d5a6b" />
    <line x1={66} y1={75} x2={154} y2={112} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={66} y1={129} x2={130} y2={133} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={66} y1={183} x2={166} y2={114} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <WMChip x={8} y={64} label="LAB" lv="LV 2 · +50% sci" />
    <WMChip x={8} y={118} label="MINT" lv="LV 1 · +25% cred" />
    <WMChip x={8} y={172} label="FORGE" lv="LV 3 · +75% metal" />
    <rect x={300} y={119} width={2.5} height={24} fill="#9fb3c8" />
    <rect x={294.5} y={121} width={4.5} height={2.5} fill="#23445c" stroke="#46687c" strokeWidth={0.4} />
    <rect x={303} y={121} width={4.5} height={2.5} fill="#23445c" stroke="#46687c" strokeWidth={0.4} />
    <ellipse cx={301.2} cy={131} rx={7} ry={2.5} fill="none" stroke="#8aa0b4" strokeWidth={1.2} />
    <rect x={298.2} y={128} width={6} height={6} rx={1} fill="#46687c" />
    <circle cx={301.2} cy={118} r={1} fill="#ffb84d" />
    <line x1={368} y1={55} x2={304} y2={120} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <line x1={368} y1={103} x2={300} y2={126} stroke="#4ecdc4" strokeWidth={0.7} opacity={0.55} />
    <WMChip x={368} y={44} w={62} label="WEAPONS" lv="LV 1" />
    <WMChip x={368} y={92} w={62} label="ORB. LAB" lv="LV 1" />
    <line x1={360} y1={157} x2={308} y2={135} stroke="#ffb84d" strokeWidth={0.7} opacity={0.6} />
    <WMChip x={360} y={146} w={94} label="SHIPYARD" lv="LV 2 · 2 SLOTS" tone="amber" />
    <line x1={400} y1={168} x2={400} y2={178} stroke="#ffb84d" strokeWidth={0.8} />
    <g>
      <rect x={360} y={178} width={150} height={100} rx={6} fill="rgba(10,17,27,0.94)" stroke="#ffb84d" strokeWidth={0.9} />
      <text x={368} y={192} fontSize={7.5} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d">SHIPYARD — LV 2 · 2 SLOTS</text>
      <line x1={368} y1={198} x2={502} y2={198} stroke="#2a3d50" strokeWidth={0.8} />
      <text x={368} y={210} fontSize={6.5} fontFamily="Audiowide, monospace" fill="#d8e4ee">▰▰▱ Frigate "Aegis"</text>
      <text x={502} y={210} fontSize={6.5} fontFamily="Audiowide, monospace" fill="#ffb84d" textAnchor="end">T+8</text>
      <text x={368} y={222} fontSize={6.5} fontFamily="Audiowide, monospace" fill="#8aa0b4">▱▱▱ Corvette "Dart"</text>
      <text x={502} y={222} fontSize={6.5} fontFamily="Audiowide, monospace" fill="#8aa0b4" textAnchor="end">queued</text>
      <rect x={366} y={230} width={138} height={16} rx={3} fill="rgba(255,184,77,0.16)" stroke="#ffb84d" strokeWidth={0.8} />
      <text x={435} y={241} fontSize={7} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d" textAnchor="middle">+ BUILD SHIP</text>
      <rect x={366} y={252} width={138} height={14} rx={3} fill="rgba(42,61,80,0.4)" stroke="#4a6178" strokeWidth={0.8} />
      <text x={435} y={262} fontSize={6} fontFamily="Audiowide, monospace" fill="#b8c8d6" textAnchor="middle">⬆ UPGRADE YARD · 60M 80C</text>
    </g>
    <circle cx={478} cy={296} r={6} fill="#9fb3c8" />
    <text x={478} y={310} fontSize={6} fontFamily="Audiowide, monospace" fill="#5a7085" textAnchor="middle">LUNA</text>
    <rect x={8} y={8} width={60} height={16} rx={8} fill="rgba(13,21,32,0.85)" stroke="#4a6178" strokeWidth={0.8} />
    <text x={38} y={19} fontSize={7} fontFamily="Audiowide, monospace" fill="#b8c8d6" textAnchor="middle">← SYSTEM</text>
    <text x={552} y={18} fontSize={6} fontFamily="Audiowide, monospace" fill="#5a7085" textAnchor="end">HOVER A CHIP · CLICK TO ACT</text>
    <text x={195} y={326} fontSize={12} fontFamily="Audiowide, monospace" fontWeight="bold" fill="#ffb84d" textAnchor="middle">EARTH</text>
    <text x={195} y={337} fontSize={7} fontFamily="Audiowide, monospace" fill="#ffd700" textAnchor="middle">2M · 6C · 3S · HP 100 · POP 3/5 · COLLECTOR ✓</text>
  </svg>
);

const WorldMenu_Mobile: React.FC = () => (
  <div className="ux-wm2-frame">
    <div className="ux-wm2-bar">
      <span className="ux-wm2-res"><b style={{ color: '#a0a0a0' }}>M</b> 27,983</span>
      <span className="ux-wm2-res"><b style={{ color: '#ffd700' }}>C</b> 10,967</span>
      <span className="ux-wm2-res"><b style={{ color: '#67e8f9' }}>S</b> 182</span>
      <span className="ux-wm2-tick">T 4,812 ▶</span>
    </div>
    <div className="ux-wm2-map"><WMMapMobile /></div>
    <div className="ux-wm2-dock">
      <span className="ux-wm2-dock__btn is-on">◉ MAP</span>
      <span className="ux-wm2-dock__btn">⚑ FLEET</span>
      <span className="ux-wm2-dock__btn">⚒ BUILD</span>
      <span className="ux-wm2-dock__btn">⚛ TECH</span>
    </div>
  </div>
);

const WorldMenu_Desktop: React.FC = () => (
  <div className="ux-wm2-frame">
    <div className="ux-wm2-bar">
      <span className="ux-wm2-res"><b style={{ color: '#a0a0a0' }}>METAL</b> 27,983</span>
      <span className="ux-wm2-res"><b style={{ color: '#ffd700' }}>CREDITS</b> 10,967</span>
      <span className="ux-wm2-res"><b style={{ color: '#67e8f9' }}>SCIENCE</b> 182</span>
      <span className="ux-wm2-tick">TICK 4,812 · RUNNING ▶</span>
    </div>
    <div className="ux-wm2-map"><WMMapDesktop /></div>
  </div>
);

const WorldMenu_Sheet: React.FC = () => (
  <div className="ux-wm-sheet">
    <div className="mock-section-head">EARTH — STRUCTURES</div>
    <FakeRow cols={['STRUCTURE', 'SITE', 'LV', 'EFFECT', '⬆ COST']} tone="head" />
    <FakeRow cols={['Forge', 'surface', '3', '+75% metal', '40M 20C']} />
    <FakeRow cols={['Mint', 'surface', '1', '+25% cred', '25M 30C']} />
    <FakeRow cols={['Lab', 'surface', '2', '+50% sci', '30M 25C']} />
    <FakeRow cols={['Weapons', 'station', '1', 'PDC +30%', '35M 40C']} />
    <FakeRow cols={['Orbital Lab', 'station', '1', '+40% sci', '30M 45C']} />
    <FakeRow cols={['Shipyard', 'station', '2', '2 slots', '60M 80C']} />
    <div className="mock-section-head">BUILD QUEUE</div>
    <FakeRow cols={['Frigate "Aegis"', 'slot 1', 'T+8']} />
    <FakeRow cols={['Corvette "Dart"', 'slot 2', 'queued']} />
  </div>
);

const WORLD_MENU_STUDY: Direction = {
  id: 'world-menu',
  number: '05',
  name: 'WORLD OVERLAY — THE MAP IS THE MENU',
  inspiredBy: "Lorne's whiteboard · diegetic map UI",
  tagline: 'Zoom into a world and its controls fade in on the map itself.',
  pitch:
    'Round two from the whiteboard: no inspector panel at all. Zoom close to a world ' +
    'you own and its callout chips fade in ON the map, pinned to the actual ' +
    "structures — the city's Forge, Mint and Lab on the surface, the station's " +
    'Weapons and Lab on its real orbit. Tap a chip and its detail opens as a popover ' +
    'right there over the planet (shown: the Shipyard queue, mid-build). Back out and ' +
    'the chips dissolve into the normal map. One continuous space, zero context switches.',
  pros: [
    'Zero context switch — you never leave the map',
    'Callouts pin to the real structures, not a list',
    'LOD-gated: chips only exist at close zoom',
  ],
  cons: [
    'Chips must dodge orbits, ships and each other',
    'Popovers get tight on small phones',
    'Harder to bulk-manage than a table',
  ],
  Desktop: WorldMenu_Desktop,
  Mobile: WorldMenu_Mobile,
  Spreadsheet: WorldMenu_Sheet,
  defaultView: 'mobile',
};

// ============================================================
// 1. COMMAND BRIDGE — Stellaris-inspired multi-panel
// ============================================================

const CommandBridge_Desktop: React.FC = () => (
  <div className="ux-cb-desk">
    <div className="ux-cb-desk__top">
      <span className="ux-cb-desk__brand">◉ COMMANDER · SOLAR DIRECTORATE</span>
      <div className="ux-cb-desk__res">
        <StatChip label="FUEL" value="2,481" tone="good" />
        <StatChip label="METAL" value="1,720" />
        <StatChip label="CRED" value="619" />
        <StatChip label="SCI" value="142" tone="warn" />
      </div>
      <div className="ux-cb-desk__time">
        <span className="mock-pill">⏸</span><span className="mock-pill mock-pill--on">1×</span>
        <span className="mock-pill">10×</span><span className="mock-pill">100×</span>
        <span className="mock-cycle">DAY 412 · YEAR 2.3</span>
      </div>
    </div>
    <div className="ux-cb-desk__body">
      <aside className="ux-cb-desk__rail">
        <div className="mock-section-head">EMPIRE</div>
        <div className="mock-nav-row mock-nav-row--on">◆ Settlements <span>14</span></div>
        <div className="mock-nav-row">◇ Fleet <span>23</span></div>
        <div className="mock-nav-row">⚛ Research <span>3/7</span></div>
        <div className="mock-nav-row">⚖ Diplomacy <span>2</span></div>
        <div className="mock-section-head">SITUATION</div>
        <div className="mock-nav-row mock-nav-row--warn">⚠ Threats <span>4</span></div>
        <div className="mock-nav-row">⏱ Events <span>11</span></div>
      </aside>
      <div className="ux-cb-desk__map">
        <MiniOrbitalMap />
        <div className="ux-cb-desk__map-overlay">
          <span className="mock-alert">⚠ Hostile incoming → EARTH (T+12)</span>
        </div>
      </div>
      <aside className="ux-cb-desk__panel">
        <div className="mock-section-head">SELECTED · EARTH YARDS</div>
        <div className="mock-bar"><span>HP</span><span className="mock-bar__fill" style={{ width: '78%' }} /><span>78/100</span></div>
        <div className="mock-bar"><span>POP</span><span className="mock-bar__fill" style={{ width: '40%' }} /><span>2/5</span></div>
        <div className="mock-kv">+3.3 fuel/tick · +2.4 metal</div>
        <div className="mock-section-head">BUILD QUEUE</div>
        <FakeRow cols={['Frigate "Aegis"', 'T+8']} />
        <FakeRow cols={['Destroyer "Anvil"', 'T+47']} />
        <div className="mock-btn mock-btn--primary">+ BUILD SHIP</div>
        <div className="mock-btn">⛏ DEPLOY CITY</div>
      </aside>
    </div>
    <div className="ux-cb-desk__bottom">
      <span className="mock-tick">T+0287</span>
      <span>Earth Yards finished Aegis (frigate)</span>
      <span className="mock-tick">T+0285</span>
      <span>Ai-1 frigate detected entering Mars SOI</span>
      <span className="mock-tick">T+0270</span>
      <span>Research: Armor Lv1 completed (+8% hull)</span>
    </div>
  </div>
);

const CommandBridge_Mobile: React.FC = () => (
  <div className="ux-cb-mob">
    <div className="ux-cb-mob__top">
      <span>◉ DIRECTORATE</span>
      <span className="mock-pill mock-pill--mini">T+287</span>
    </div>
    <div className="ux-cb-mob__res">
      <StatChip label="F" value="2.4K" tone="good" />
      <StatChip label="O" value="1.7K" />
      <StatChip label="$" value="619" />
      <StatChip label="⚛" value="142" tone="warn" />
    </div>
    <div className="ux-cb-mob__map"><MiniOrbitalMap /></div>
    <div className="ux-cb-mob__sit">
      <span className="mock-alert mock-alert--mini">⚠ Incoming → Earth (T+12)</span>
    </div>
    <div className="ux-cb-mob__tabs">
      <div className="mock-tab mock-tab--on">◉ MAP</div>
      <div className="mock-tab">◆ EMPIRE</div>
      <div className="mock-tab">◇ FLEET</div>
      <div className="mock-tab">⚛ TECH</div>
      <div className="mock-tab">⚖ DIPL</div>
    </div>
  </div>
);

const CommandBridge_Sheet: React.FC = () => (
  <div className="ux-cb-sheet">
    <div className="ux-cb-sheet__tabs">
      <div className="mock-tab mock-tab--on">SETTLEMENTS · 14</div>
      <div className="mock-tab">SHIPS · 23</div>
      <div className="mock-tab">BUILDS · 6</div>
      <div className="mock-tab">TECH · 3/7</div>
      <div className="mock-tab mock-tab--warn">THREATS · 4</div>
    </div>
    <div className="ux-cb-sheet__head">
      <FakeRow cols={['NAME', 'BODY', 'TYPE', 'HP', 'POP', 'YIELD/T', 'STATUS']} tone="head" />
    </div>
    <div className="ux-cb-sheet__rows">
      <FakeRow cols={['Earth Yards', 'Earth', 'Station', '78/100', '2/5', '+3.3F +2.4O', 'Building Aegis']} tone="alt" />
      <FakeRow cols={['Earth City', 'Earth', 'City', '200/200', '1/3', '+3.0F +3.6O', 'Stable']} />
      <FakeRow cols={['Mars Outpost', 'Mars', 'Outpost', '40/60', '0/2', '+1.2F', 'Damaged']} tone="bad" />
      <FakeRow cols={['Luna Yards', 'Luna', 'Station', '95/100', '3/3', '+2.0F +1.4O', 'Idle']} tone="alt" />
      <FakeRow cols={['Ceres Mine', 'Ceres', 'Outpost', '55/60', '1/2', '+4.0O', 'Stable']} />
      <FakeRow cols={['Titan Refinery', 'Titan', 'City', '180/200', '2/3', '+5.5F', 'Stable']} tone="alt" />
    </div>
  </div>
);

// ============================================================
// 2. MISSION CONTROL — KSP-inspired map + telemetry
// ============================================================

const MissionControl_Desktop: React.FC = () => (
  <div className="ux-mc-desk">
    <div className="ux-mc-desk__map"><MiniOrbitalMap /></div>
    <div className="ux-mc-desk__corner ux-mc-desk__corner--tl">
      <div className="mock-readout">
        <div className="mock-readout__label">Δv BUDGET</div>
        <div className="mock-readout__value">8.42 <span>km/s</span></div>
        <div className="mock-readout__sub">─── used 1.44 ─── remaining 6.98</div>
      </div>
    </div>
    <div className="ux-mc-desk__corner ux-mc-desk__corner--tr">
      <div className="mock-readout">
        <div className="mock-readout__label">NEXT EVENT</div>
        <div className="mock-readout__value mock-readout__value--amber">T-00:47</div>
        <div className="mock-readout__sub">Vanguard arrives MERCURY</div>
      </div>
    </div>
    <div className="ux-mc-desk__corner ux-mc-desk__corner--bl">
      <div className="mock-readout mock-readout--mini">
        <div className="mock-readout__label">VANGUARD · FRIGATE</div>
        <div className="mock-mini-grid">
          <span>fuel</span><span>106kt</span>
          <span>hp</span><span>78/100</span>
          <span>spd</span><span>11.4 km/s</span>
          <span>orbit</span><span>Earth→Mercury</span>
        </div>
      </div>
    </div>
    <div className="ux-mc-desk__bottom">
      <div className="mock-timeline">
        <div className="mock-timeline__head">
          <span>NOW</span>
          <span>T+47</span>
          <span>T+128</span>
          <span>T+260</span>
          <span>T+400</span>
        </div>
        <div className="mock-timeline__track">
          <span className="mock-timeline__node" style={{ left: '12%' }}>◆ Burn 1.44</span>
          <span className="mock-timeline__node mock-timeline__node--amber" style={{ left: '34%' }}>● Arrive Mercury</span>
          <span className="mock-timeline__node" style={{ left: '58%' }}>◆ Burn 0.91</span>
          <span className="mock-timeline__node" style={{ left: '82%' }}>● Arrive Venus</span>
        </div>
      </div>
      <div className="mock-mc-controls">
        <span className="mock-btn mock-btn--mini">+ NODE</span>
        <span className="mock-btn mock-btn--mini">EXEC</span>
        <span className="mock-btn mock-btn--mini">ABORT</span>
        <span className="mock-pill mock-pill--on">100×</span>
      </div>
    </div>
  </div>
);

const MissionControl_Mobile: React.FC = () => (
  <div className="ux-mc-mob">
    <div className="ux-mc-mob__map"><MiniOrbitalMap /></div>
    <div className="ux-mc-mob__badge">
      <div className="mock-readout__label">T-00:47</div>
      <div className="mock-readout__sub">VANGUARD → MERCURY</div>
    </div>
    <div className="ux-mc-mob__sheet">
      <div className="mock-grab" />
      <div className="mock-readout mock-readout--mini">
        <div className="mock-readout__label">VANGUARD</div>
        <div className="mock-mini-grid">
          <span>Δv left</span><span>6.98</span>
          <span>fuel</span><span>106</span>
          <span>hp</span><span>78</span>
          <span>arrive</span><span>T-47</span>
        </div>
      </div>
      <div className="ux-mc-mob__actions">
        <span className="mock-btn mock-btn--big">▶ EXEC NEXT</span>
        <span className="mock-btn mock-btn--big mock-btn--ghost">+ NODE</span>
      </div>
    </div>
  </div>
);

const MissionControl_Sheet: React.FC = () => (
  <div className="ux-mc-sheet">
    <div className="ux-mc-sheet__title">MANEUVER SCHEDULE · DAY 412</div>
    <div className="ux-mc-sheet__gantt">
      <div className="mock-gantt-row">
        <span className="mock-gantt-row__label">Vanguard</span>
        <span className="mock-gantt-bar" style={{ left: '10%', width: '28%' }}>Earth → Mercury</span>
        <span className="mock-gantt-bar mock-gantt-bar--queued" style={{ left: '42%', width: '20%' }}>Capture burn</span>
      </div>
      <div className="mock-gantt-row">
        <span className="mock-gantt-row__label">Sentinel</span>
        <span className="mock-gantt-bar mock-gantt-bar--amber" style={{ left: '4%', width: '40%' }}>Earth → Venus</span>
      </div>
      <div className="mock-gantt-row">
        <span className="mock-gantt-row__label">Hauler</span>
        <span className="mock-gantt-bar mock-gantt-bar--queued" style={{ left: '30%', width: '36%' }}>Earth → Luna (queued)</span>
      </div>
      <div className="mock-gantt-row">
        <span className="mock-gantt-row__label">Aegis</span>
        <span className="mock-gantt-bar mock-gantt-bar--red" style={{ left: '0%', width: '12%' }}>Building</span>
        <span className="mock-gantt-bar" style={{ left: '14%', width: '24%' }}>Earth → Mars (auto)</span>
      </div>
    </div>
    <div className="ux-mc-sheet__telem">
      <FakeRow cols={['SHIP', 'STATUS', 'Δv USED', 'Δv REM', 'FUEL', 'HP', 'ETA']} tone="head" />
      <FakeRow cols={['Vanguard', 'In transit', '1.44', '6.98', '106', '78', 'T-47']} tone="alt" />
      <FakeRow cols={['Sentinel', 'In transit', '0.48', '7.94', '112', '100', 'T-83']} />
      <FakeRow cols={['Hauler', 'Orbit Earth', '0.00', '8.42', '100', '60', '—']} tone="alt" />
      <FakeRow cols={['Aegis', 'Building', '—', '—', '—', '—', 'T+8']} />
    </div>
  </div>
);

// ============================================================
// 3. TACTICAL HUD — Warzone/RTS-inspired action-first
// ============================================================

const TacticalHud_Desktop: React.FC = () => (
  <div className="ux-th-desk">
    <div className="ux-th-desk__map"><MiniOrbitalMap /></div>
    <div className="ux-th-desk__minimap"><MiniOrbitalMap /></div>
    <div className="ux-th-desk__alerts">
      <div className="mock-toast mock-toast--red">⚠ HOSTILE ENGAGED · EARTH</div>
      <div className="mock-toast mock-toast--amber">◆ Frigate Aegis completed</div>
      <div className="mock-toast">⚛ Weapons Lv2 ready</div>
    </div>
    <div className="ux-th-desk__wheel">
      <div className="mock-wheel">
        <span className="mock-wheel__slice" style={{ transform: 'rotate(0deg) translateY(-44px)' }}>⚔</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(72deg) translateY(-44px)' }}>◈</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(144deg) translateY(-44px)' }}>⛏</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(216deg) translateY(-44px)' }}>⚛</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(288deg) translateY(-44px)' }}>⊕</span>
        <span className="mock-wheel__center">VANGUARD</span>
      </div>
    </div>
    <div className="ux-th-desk__bar">
      <span className="mock-action">⚔ <span>Q</span><br/>ATTACK</span>
      <span className="mock-action">◈ <span>W</span><br/>TRANSFER</span>
      <span className="mock-action">⛏ <span>E</span><br/>BUILD</span>
      <span className="mock-action">⚛ <span>R</span><br/>RESEARCH</span>
      <span className="mock-action">⊕ <span>T</span><br/>DEFEND</span>
      <span className="mock-action mock-action--cd">⚡ <span>F</span><br/>BURN</span>
    </div>
    <div className="ux-th-desk__top">
      <StatChip label="POW" value="∎∎∎∎∘∘" tone="good" />
      <StatChip label="THR" value="4" tone="bad" />
      <span className="mock-cycle">⏰ T+287</span>
    </div>
  </div>
);

const TacticalHud_Mobile: React.FC = () => (
  <div className="ux-th-mob">
    <div className="ux-th-mob__map"><MiniOrbitalMap /></div>
    <div className="ux-th-mob__toast">⚠ HOSTILE → EARTH</div>
    <div className="ux-th-mob__wheel">
      <div className="mock-wheel mock-wheel--mob">
        <span className="mock-wheel__slice" style={{ transform: 'rotate(0deg) translateY(-32px)' }}>⚔</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(90deg) translateY(-32px)' }}>◈</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(180deg) translateY(-32px)' }}>⛏</span>
        <span className="mock-wheel__slice" style={{ transform: 'rotate(270deg) translateY(-32px)' }}>⚛</span>
        <span className="mock-wheel__center">VANGUARD</span>
      </div>
    </div>
    <div className="ux-th-mob__thumb">
      <span className="mock-action mock-action--thumb">⚔ ATTACK</span>
      <span className="mock-action mock-action--thumb">◈ MOVE</span>
      <span className="mock-action mock-action--thumb">⊕ DEFEND</span>
    </div>
  </div>
);

const TacticalHud_Sheet: React.FC = () => (
  <div className="ux-th-sheet">
    <div className="ux-th-sheet__title">ORDER QUEUE · drag to reprioritize</div>
    <FakeRow cols={['#', 'UNIT', 'ORDER', 'TARGET', 'ETA', 'COST']} tone="head" />
    <div className="mock-order-row mock-order-row--active">
      <span>1</span><span>Vanguard</span><span>⚔ Attack</span><span>Hostile @ Earth</span><span>T+0</span><span>—</span>
    </div>
    <div className="mock-order-row">
      <span>2</span><span>Earth Yards</span><span>⛏ Build Frigate</span><span>"Aegis"</span><span>T+8</span><span>30O · 25C</span>
    </div>
    <div className="mock-order-row">
      <span>3</span><span>Sentinel</span><span>◈ Transfer</span><span>Earth → Venus</span><span>T+83</span><span>Δv 0.48</span>
    </div>
    <div className="mock-order-row mock-order-row--paused">
      <span>4</span><span>Hauler</span><span>◈ Transfer</span><span>Earth → Luna</span><span>—</span><span>paused</span>
    </div>
    <div className="mock-order-row">
      <span>5</span><span>—</span><span>⚛ Research</span><span>Armor Lv2</span><span>T+140</span><span>40 sci</span>
    </div>
    <div className="ux-th-sheet__foot">
      <span className="mock-btn mock-btn--mini">+ ADD ORDER</span>
      <span className="mock-btn mock-btn--mini">▶ RUN ALL</span>
      <span className="mock-btn mock-btn--mini mock-btn--ghost">PAUSE</span>
    </div>
  </div>
);

// ============================================================
// 4. EMPIRE MANAGER — Clash of Clans / card-based
// ============================================================

const EmpireManager_Desktop: React.FC = () => (
  <div className="ux-em-desk">
    <div className="ux-em-desk__left">
      <div className="mock-section-head">YOUR EMPIRE</div>
      <div className="mock-card">
        <div className="mock-card__title">★ EARTH</div>
        <div className="mock-card__sub">Capital · 2 holdings</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '78%' }} /></div>
        <div className="mock-card__cta">MANAGE →</div>
      </div>
      <div className="mock-card">
        <div className="mock-card__title">◇ LUNA</div>
        <div className="mock-card__sub">Outpost · 1 holding</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '95%' }} /></div>
        <div className="mock-card__cta">MANAGE →</div>
      </div>
      <div className="mock-card mock-card--warn">
        <div className="mock-card__title">⚠ MARS</div>
        <div className="mock-card__sub">Contested · 1 holding</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '40%' }} /></div>
        <div className="mock-card__cta">DEFEND →</div>
      </div>
    </div>
    <div className="ux-em-desk__center">
      <MiniOrbitalMap />
      <div className="mock-em-stat-strip">
        <StatChip label="FUEL" value="2.4K" tone="good" />
        <StatChip label="METAL" value="1.7K" />
        <StatChip label="CRED" value="619" />
        <StatChip label="SCI" value="142" tone="warn" />
      </div>
    </div>
    <div className="ux-em-desk__right">
      <div className="mock-section-head">IN PROGRESS</div>
      <div className="mock-job">
        <span className="mock-job__icon">⛏</span>
        <div>
          <div className="mock-job__title">Frigate "Aegis"</div>
          <div className="mock-bar mock-bar--mini"><span className="mock-bar__fill" style={{ width: '74%' }} /></div>
          <div className="mock-job__time">T+8</div>
        </div>
      </div>
      <div className="mock-job">
        <span className="mock-job__icon">⚛</span>
        <div>
          <div className="mock-job__title">Armor Lv1</div>
          <div className="mock-bar mock-bar--mini"><span className="mock-bar__fill" style={{ width: '40%' }} /></div>
          <div className="mock-job__time">T+22</div>
        </div>
      </div>
      <div className="mock-job">
        <span className="mock-job__icon">◈</span>
        <div>
          <div className="mock-job__title">Vanguard → Mercury</div>
          <div className="mock-bar mock-bar--mini"><span className="mock-bar__fill" style={{ width: '60%' }} /></div>
          <div className="mock-job__time">T+47</div>
        </div>
      </div>
      <div className="mock-btn mock-btn--primary">+ START NEW JOB</div>
    </div>
  </div>
);

const EmpireManager_Mobile: React.FC = () => (
  <div className="ux-em-mob">
    <div className="ux-em-mob__top">
      <StatChip label="F" value="2.4K" tone="good" />
      <StatChip label="O" value="1.7K" />
      <StatChip label="$" value="619" />
      <StatChip label="⚛" value="142" tone="warn" />
    </div>
    <div className="ux-em-mob__cards">
      <div className="mock-card">
        <div className="mock-card__title">★ EARTH</div>
        <div className="mock-card__sub">Capital · 2 holdings · ⛏ building Aegis</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '78%' }} /></div>
        <div className="mock-card__cta">MANAGE →</div>
      </div>
      <div className="mock-card mock-card--warn">
        <div className="mock-card__title">⚠ MARS</div>
        <div className="mock-card__sub">Contested · hostile fleet inbound T+12</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '40%' }} /></div>
        <div className="mock-card__cta">DEFEND →</div>
      </div>
      <div className="mock-card">
        <div className="mock-card__title">◇ LUNA</div>
        <div className="mock-card__sub">Outpost · idle</div>
        <div className="mock-bar"><span className="mock-bar__fill" style={{ width: '95%' }} /></div>
        <div className="mock-card__cta">MANAGE →</div>
      </div>
    </div>
    <div className="ux-em-mob__nav">
      <div className="mock-tab mock-tab--on">⌂ EMPIRE</div>
      <div className="mock-tab">◉ MAP</div>
      <div className="mock-tab">⚛ TECH</div>
    </div>
  </div>
);

const EmpireManager_Sheet: React.FC = () => (
  <div className="ux-em-sheet">
    <div className="ux-em-sheet__title">EMPIRE ASSETS · all holdings, ships, jobs</div>
    <div className="ux-em-sheet__filters">
      <span className="mock-pill mock-pill--on">ALL · 23</span>
      <span className="mock-pill">SETTLE · 14</span>
      <span className="mock-pill">SHIPS · 6</span>
      <span className="mock-pill">BUILDS · 3</span>
      <span className="mock-pill">⚠ ALERT · 2</span>
    </div>
    <FakeRow cols={['ASSET', 'TYPE', 'LOCATION', 'STATUS', 'OUTPUT', 'ACTION']} tone="head" />
    <FakeRow cols={['Earth Yards', 'Station', 'Earth', 'Building Aegis · T+8', '+3.3F +2.4O', '▶ Manage']} tone="alt" />
    <FakeRow cols={['Earth City', 'City', 'Earth', 'Stable', '+3.0F +3.6O', '▶ Manage']} />
    <FakeRow cols={['Luna Yards', 'Station', 'Luna', 'Idle', '+2.0F +1.4O', '▶ Manage']} tone="alt" />
    <FakeRow cols={['Mars Outpost', 'Outpost', 'Mars', '⚠ Damaged · 40 HP', '+1.2F', '▶ Defend']} tone="bad" />
    <FakeRow cols={['Vanguard', 'Frigate', 'Earth → Mercury', 'In transit · T+47', '—', '▶ Manage']} />
    <FakeRow cols={['Sentinel', 'Frigate', 'Earth → Venus', 'In transit · T+83', '—', '▶ Manage']} tone="alt" />
    <FakeRow cols={['Hauler', 'Freighter', 'Earth', 'Idle', '—', '▶ Deploy']} />
  </div>
);

// ============================================================
// Directions registry
// ============================================================

const DIRECTIONS: Direction[] = [
  {
    id: 'command-bridge',
    number: '01',
    name: 'COMMAND BRIDGE',
    inspiredBy: 'Stellaris · EVE Online',
    tagline: 'Empire-scale management. Multi-panel layout, dense data, persistent context.',
    pitch:
      'Three zones always visible: empire rail on the left, map in the center, contextual panel on the right. A top strip for resources and time, a bottom strip for the rolling event log. Optimized for desktop monitors and players who want everything one click away.',
    pros: ['Maximum information density', 'Every system reachable in 1 click', 'Stable spatial memory'],
    cons: ['Hostile to narrow screens', 'Steep first impression', 'Lots of small targets'],
    Desktop: CommandBridge_Desktop,
    Mobile: CommandBridge_Mobile,
    Spreadsheet: CommandBridge_Sheet,
  },
  {
    id: 'mission-control',
    number: '02',
    name: 'MISSION CONTROL',
    inspiredBy: 'KSP · Children of a Dead Earth',
    tagline: 'Map first. Telemetry second. Burn timing front and center.',
    pitch:
      'The orbital map is the UI. Corner readouts show only what matters right now: Δv budget, next-event countdown, selected vessel telemetry. A bottom timeline strip shows every upcoming maneuver across the empire on one line. Built for players who love the physics.',
    pros: ['Cinematic, never crowds the map', 'Burn timing is unmissable', 'Calm aesthetic'],
    cons: ['Empire-management feels secondary', 'Could feel sparse on big screens', 'Heavy on monospace numerics'],
    Desktop: MissionControl_Desktop,
    Mobile: MissionControl_Mobile,
    Spreadsheet: MissionControl_Sheet,
  },
  {
    id: 'tactical-hud',
    number: '03',
    name: 'TACTICAL HUD',
    inspiredBy: 'Warzone · StarCraft · DOTA',
    tagline: 'Action-first. Hotkeyed abilities, radial wheel, combat-streamlined.',
    pitch:
      'A combat-game HUD: minimap top-right, ability bar bottom-center with hotkeys, alert toasts cascading from the right. Right-click (or long-press on mobile) any unit to open a radial command wheel. The strategic layer stays present but every fight feels like an action moment.',
    pros: ['Fastest possible per-action latency', 'Reads as a "real game"', 'Hotkeys reward mastery'],
    cons: ['Hostile to first-time players without a tutorial', 'Hides long-form planning behind layers', 'Wheel on mobile = thumb workout'],
    Desktop: TacticalHud_Desktop,
    Mobile: TacticalHud_Mobile,
    Spreadsheet: TacticalHud_Sheet,
  },
  {
    id: 'empire-manager',
    number: '04',
    name: 'EMPIRE MANAGER',
    inspiredBy: 'Clash of Clans · Hearthstone',
    tagline: 'Card-based. Tap-to-manage. Optional cinematic map.',
    pitch:
      'Every holding and every job is a card. Mobile shows one card at a time, tap to expand. Desktop puts three columns side-by-side: empire on the left, map in the middle, in-progress jobs on the right. Maximum approachable. Plays as well with one thumb as with a mouse.',
    pros: ['Lowest skill floor', 'Mobile-first by default', 'Big tap targets'],
    cons: ['Light on situational map awareness', 'Risks feeling like a mobile freemium game', 'Card sprawl with 20+ holdings'],
    Desktop: EmpireManager_Desktop,
    Mobile: EmpireManager_Mobile,
    Spreadsheet: EmpireManager_Sheet,
  },
];

// ============================================================
// Page
// ============================================================

const ViewToggle: React.FC<{
  current: ViewMode;
  onChange: (v: ViewMode) => void;
}> = ({ current, onChange }) => (
  <div className="ux-view-toggle">
    <button
      className={`ux-view-toggle__btn ${current === 'desktop' ? 'is-on' : ''}`}
      onClick={() => onChange('desktop')}
    >🖥 DESKTOP</button>
    <button
      className={`ux-view-toggle__btn ${current === 'mobile' ? 'is-on' : ''}`}
      onClick={() => onChange('mobile')}
    >📱 MOBILE</button>
    <button
      className={`ux-view-toggle__btn ${current === 'spreadsheet' ? 'is-on' : ''}`}
      onClick={() => onChange('spreadsheet')}
    >▤ SPREADSHEET</button>
  </div>
);

const DirectionCard: React.FC<{ direction: Direction }> = ({ direction }) => {
  const [view, setView] = useState<ViewMode>(direction.defaultView ?? 'desktop');
  const Mockup = view === 'desktop' ? direction.Desktop
    : view === 'mobile' ? direction.Mobile
    : direction.Spreadsheet;

  return (
    <article className="ux-card" id={direction.id}>
      <header className="ux-card__head">
        <div className="ux-card__title-block">
          <span className="ux-card__num">{direction.number}</span>
          <div>
            <h2 className="ux-card__name">{direction.name}</h2>
            <span className="ux-card__tag">Inspired by · {direction.inspiredBy}</span>
          </div>
        </div>
        <ViewToggle current={view} onChange={setView} />
      </header>

      <p className="ux-card__pitch">{direction.pitch}</p>

      <div className={`ux-card__stage ux-card__stage--${view}`}>
        <div className={`ux-device-frame ux-device-frame--${view}`}>
          <Mockup />
        </div>
      </div>

      <footer className="ux-card__foot">
        <div className="ux-card__col">
          <div className="ux-card__col-head ux-card__col-head--pro">+ STRENGTHS</div>
          <ul>{direction.pros.map(p => <li key={p}>{p}</li>)}</ul>
        </div>
        <div className="ux-card__col">
          <div className="ux-card__col-head ux-card__col-head--con">− TRADE-OFFS</div>
          <ul>{direction.cons.map(c => <li key={c}>{c}</li>)}</ul>
        </div>
      </footer>
    </article>
  );
};

export const UXGallery: React.FC<UXGalleryProps> = ({ onBack }) => {
  return (
    <div className="ux-gallery">
      <header className="ux-gallery__nav">
        <button className="ux-gallery__back" onClick={onBack}>← BACK</button>
        <span className="ux-gallery__brand">◉ ORBITAL · UX EXPLORATIONS</span>
      </header>

      <section className="ux-gallery__intro">
        <div className="ux-gallery__eyebrow">PLAYER UX · FOUR SWINGS</div>
        <h1 className="ux-gallery__title">Four ways the player could live inside this game.</h1>
        <p className="ux-gallery__lede">
          Each direction is a complete take on the same problem: how should a commander
          actually <em>play</em> Orbital? Every card includes a desktop layout, a mobile
          layout, and a tight-screen <strong>spreadsheet mode</strong> that strips away
          the visuals when you just need the data.
        </p>
        <div className="ux-gallery__legend">
          <span className="ux-gallery__legend-item">🖥 Desktop · 1440px+</span>
          <span className="ux-gallery__legend-item">📱 Mobile · 414×896</span>
          <span className="ux-gallery__legend-item">▤ Spreadsheet · any size, data-first</span>
        </div>
      </section>

      <section className="ux-gallery__featured">
        <div className="ux-gallery__eyebrow">NEW · FOCUSED STUDY</div>
        <h2 className="ux-gallery__featured-title">The World Menu, from the whiteboard</h2>
        <p className="ux-gallery__lede">
          The world menu overlaid <strong>on the live map</strong>: zoom into a world
          and callout chips fade in, pinned to the structures themselves — tap one
          and its panel opens right over the planet. Mobile-first; flip the toggle
          for desktop and spreadsheet takes.
        </p>
        <DirectionCard direction={WORLD_MENU_STUDY} />
      </section>

      <div className="ux-gallery__grid">
        {DIRECTIONS.map(d => <DirectionCard key={d.id} direction={d} />)}
      </div>

      <footer className="ux-gallery__outro">
        <div className="ux-gallery__outro-title">Picking one isn't the goal here</div>
        <p>
          These aren't proposals to ship — they're four genuinely different shapes for the
          same game. Mix and match: the Tactical HUD's hotkey bar could live inside the
          Command Bridge. The Empire Manager's cards could be the mobile expression of the
          Mission Control desktop. The spreadsheet mode on every card is the same idea:
          there's always a fallback when the screen gets tight or the player just wants
          the numbers.
        </p>
      </footer>
    </div>
  );
};
