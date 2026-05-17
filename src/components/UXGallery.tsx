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
    <circle cx="130" cy="100" r="1.6" fill="#8a9fb3" />
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
// 1. COMMAND BRIDGE — Stellaris-inspired multi-panel
// ============================================================

const CommandBridge_Desktop: React.FC = () => (
  <div className="ux-cb-desk">
    <div className="ux-cb-desk__top">
      <span className="ux-cb-desk__brand">◉ COMMANDER · SOLAR DIRECTORATE</span>
      <div className="ux-cb-desk__res">
        <StatChip label="FUEL" value="2,481" tone="good" />
        <StatChip label="ORE" value="1,720" />
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
        <div className="mock-kv">+3.3 fuel/tick · +2.4 ore</div>
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
        <StatChip label="ORE" value="1.7K" />
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
  const [view, setView] = useState<ViewMode>('desktop');
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
