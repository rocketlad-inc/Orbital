// ============================================================
// TunablesPage — explore the playtest knobs from DESIGN.md §6
//
// Every slider here mirrors a constant that lives somewhere in
// worker/* or src/game/*. Sliding doesn't change the live game;
// this page is a visual sandbox for grokking the design space and
// previewing how the loop responds to each value.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import './TunablesPage.css';

interface TunablesPageProps {
  onBack: () => void;
}

// === Defaults (mirrors of constants in worker/* and src/game/*) ===
const DEFAULTS = {
  // Match shape
  tickIntervalMs: 60_000,        // 1 minute default for preview (real default = 24h)
  // Faction & seeding
  worldsPerFaction: 2,
  maxPlayers: 4,
  // Ship combat
  corvetteHp: 40, corvetteDmg: 5,
  frigateHp: 80,  frigateDmg: 10,
  destroyerHp: 200, destroyerDmg: 18,
  // Build economy
  corvetteMetal: 15, corvetteBuildTicks: 30,
  frigateMetal: 30,  frigateBuildTicks: 60,
  destroyerMetal: 60, destroyerBuildTicks: 120,
  // Settlements
  settlementCost: 30,
  cityHp: 100, stationHp: 60,
  cityMetalBias: 1.2, cityScienceBias: 0.8,
  stationFuelBias: 1.1, stationScienceBias: 1.4,
  popGrowthInterval: 20,
  harvestInterval: 10,
  popMax: 10,
  popMultiplierPerLevel: 0.1,
  settlementCombatDmg: 4,
  // Tech
  weaponsBaseCost: 40, weaponsScaling: 1.7,
  armorBaseCost: 40, armorScaling: 1.7,
  propulsionBaseCost: 35, propulsionScaling: 1.6,
  flightBaseCost: 50, flightScaling: 1.7,
  constructionBaseCost: 50, constructionScaling: 1.8,
  industryBaseCost: 45, industryScaling: 1.7,
  sensorsBaseCost: 30, sensorsScaling: 1.5,
  // Physics
  solMu: 6003,
  // Fog of war
  baseSensorRange: 200,
  // VFX
  damageFlashMs: 500,
};

/**
 * Maps every tunable in DEFAULTS to the file + constant that actually
 * owns it in the codebase. Used by the export so when you upload the
 * JSON back, the file paths tell us exactly where to apply each value.
 */
const TUNABLE_FILES: Record<keyof typeof DEFAULTS, string> = {
  tickIntervalMs:        'worker/lobby.js handleStart tick_interval_ms',
  worldsPerFaction:      'worker/factions.js WORLDS_PER_PLAYER',
  maxPlayers:            'worker/index.js handleCreateRoom',
  // Ship combat
  corvetteHp:            'worker/factions.js SHIP_COMBAT_STATS.corvette.hp',
  corvetteDmg:           'worker/factions.js SHIP_COMBAT_STATS.corvette.damage_per_tick',
  frigateHp:             'worker/factions.js SHIP_COMBAT_STATS.frigate.hp',
  frigateDmg:            'worker/factions.js SHIP_COMBAT_STATS.frigate.damage_per_tick',
  destroyerHp:           'worker/factions.js SHIP_COMBAT_STATS.destroyer.hp',
  destroyerDmg:          'worker/factions.js SHIP_COMBAT_STATS.destroyer.damage_per_tick',
  // Build economy
  corvetteMetal:         'worker/actions.js SHIP_BUILD_COST.corvette.metal',
  corvetteBuildTicks:    'worker/actions.js SHIP_BUILD_COST.corvette.build_ticks',
  frigateMetal:          'worker/actions.js SHIP_BUILD_COST.frigate.metal',
  frigateBuildTicks:     'worker/actions.js SHIP_BUILD_COST.frigate.build_ticks',
  destroyerMetal:        'worker/actions.js SHIP_BUILD_COST.destroyer.metal',
  destroyerBuildTicks:   'worker/actions.js SHIP_BUILD_COST.destroyer.build_ticks',
  // Settlements
  settlementCost:        'worker/actions.js SETTLEMENT_COST.metal',
  cityHp:                'worker/actions.js handleDeploySettlement city hp',
  stationHp:             'worker/actions.js handleDeploySettlement station hp',
  cityMetalBias:         'worker/room.js resolveTick city M bias',
  cityScienceBias:       'worker/room.js resolveTick city S bias',
  stationFuelBias:       'worker/room.js resolveTick station F bias',
  stationScienceBias:    'worker/room.js resolveTick station S bias',
  popGrowthInterval:     'worker/room.js POP_GROWTH_INTERVAL',
  harvestInterval:       'worker/room.js HARVEST_INTERVAL',
  popMax:                'worker/room.js POP_MAX',
  popMultiplierPerLevel: 'worker/room.js settlement pop multiplier',
  settlementCombatDmg:   'worker/room.js SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP',
  // Tech
  weaponsBaseCost:       'worker/actions.js TECH_DEFS.weapons.baseCost',
  weaponsScaling:        'worker/actions.js TECH_DEFS.weapons.costScaling',
  armorBaseCost:         'worker/actions.js TECH_DEFS.armor.baseCost',
  armorScaling:          'worker/actions.js TECH_DEFS.armor.costScaling',
  propulsionBaseCost:    'worker/actions.js TECH_DEFS.propulsion.baseCost',
  propulsionScaling:     'worker/actions.js TECH_DEFS.propulsion.costScaling',
  flightBaseCost:        'worker/actions.js TECH_DEFS.flight.baseCost',
  flightScaling:         'worker/actions.js TECH_DEFS.flight.costScaling',
  constructionBaseCost:  'worker/actions.js TECH_DEFS.construction.baseCost',
  constructionScaling:   'worker/actions.js TECH_DEFS.construction.costScaling',
  industryBaseCost:      'worker/actions.js TECH_DEFS.industry.baseCost',
  industryScaling:       'worker/actions.js TECH_DEFS.industry.costScaling',
  sensorsBaseCost:       'worker/actions.js TECH_DEFS.sensors.baseCost',
  sensorsScaling:        'worker/actions.js TECH_DEFS.sensors.costScaling',
  // Physics
  solMu:                 'worker/room.js SOL_MU (mirrored in src/physics/orbitalMechanics.ts GRAVITATIONAL_PARAMS.SOL)',
  // Fog of war
  baseSensorRange:       'src/game/visibility.ts SETTLEMENT_SENSOR_RANGE.station',
  // VFX
  damageFlashMs:         'src/render/mapRenderer.ts DAMAGE_FLASH_DURATION_MS',
};

const TICK_INTERVAL_OPTIONS = [
  { ms: 30_000,      label: '30s' },
  { ms: 60_000,      label: '1m' },
  { ms: 300_000,     label: '5m' },
  { ms: 1_800_000,   label: '30m' },
  { ms: 3_600_000,   label: '1h' },
  { ms: 21_600_000,  label: '6h' },
  { ms: 43_200_000,  label: '12h' },
  { ms: 86_400_000,  label: '24h' },
];

function formatTickInterval(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(0)}h`;
  return `${(ms / 86_400_000).toFixed(0)}d`;
}

export const TunablesPage: React.FC<TunablesPageProps> = ({ onBack }) => {
  const [v, setV] = useState(DEFAULTS);
  const set = <K extends keyof typeof DEFAULTS>(key: K, value: number) =>
    setV(prev => ({ ...prev, [key]: value }));

  const reset = () => setV(DEFAULTS);

  /**
   * Bundle the current slider values + their file/constant locations into
   * a JSON file and trigger a browser download. Upload the file back to
   * Claude in chat and ask for the values to be applied — the fileMap
   * tells the maintainer exactly which file + constant each value owns.
   */
  const exportTunables = () => {
    const payload = {
      schema: 'orbital-tunables-v1',
      exportedAt: new Date().toISOString(),
      summary: {
        totalKnobs: Object.keys(v).length,
        changedFromDefault: Object.keys(v).filter(
          k => v[k as keyof typeof DEFAULTS] !== DEFAULTS[k as keyof typeof DEFAULTS],
        ),
      },
      values: v,
      defaults: DEFAULTS,
      fileMap: TUNABLE_FILES,
      notes: [
        'Each key in `values` maps to a file location via `fileMap`.',
        'Compare against `defaults` to see what the player tuned.',
        'Apply changed values to the listed files to make them live.',
      ],
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `orbital-tunables-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tunables-page">
      <header className="tunables-nav">
        <button className="tunables-back" onClick={onBack}>← BACK</button>
        <div className="tunables-brand">
          <span className="brand-glyph">◉</span>
          <span className="brand-text">ORBITAL · TUNABLES</span>
        </div>
        <div className="tunables-nav-actions">
          <button className="tunables-export" onClick={exportTunables} title="Download these values as JSON">
            ⤓ EXPORT
          </button>
          <button className="tunables-reset" onClick={reset}>RESET</button>
        </div>
      </header>

      <div className="tunables-intro">
        <h1>Playtest Knobs</h1>
        <p>
          Every constant the game tuner cares about lives here. Sliding doesn't
          change the live game — this is a sandbox for previewing how each
          value reshapes the loop. Each block maps to a section of
          <code>DESIGN.md §6</code>.
        </p>
      </div>

      {/* ===== Time & Tempo ===== */}
      <Section
        eyebrow="01 · TIME"
        title="Tempo of the game"
        description="How long a tick is in wall time, and how many ticks fill the match. The visual on the right shows Earth orbiting at the chosen tick rate — fast tick = visibly fast inner system."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider
              label="Tick interval"
              value={v.tickIntervalMs}
              min={30_000}
              max={86_400_000}
              step={1}
              displayValue={formatTickInterval(v.tickIntervalMs)}
              onChange={x => set('tickIntervalMs', snapToTickInterval(x))}
              file="worker/lobby.js handleStart"
              notes="30s → 24h. Server hibernates between ticks; longer interval = lower CF cost."
            />
          </div>
          <div className="section-visual">
            <MiniSolarSystem tickIntervalMs={v.tickIntervalMs} />
          </div>
        </div>
      </Section>

      {/* ===== Match shape ===== */}
      <Section
        eyebrow="02 · MATCH SHAPE"
        title="Players and worlds"
        description="How many factions in a room and what they start with."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider
              label="Max players"
              value={v.maxPlayers}
              min={2}
              max={8}
              step={1}
              displayValue={`${v.maxPlayers}`}
              onChange={x => set('maxPlayers', x)}
              file="worker/index.js handleCreateRoom"
              notes="Hard ceiling is 8 (FACTION_NAMES count)."
            />
            <Slider
              label="Worlds per faction"
              value={v.worldsPerFaction}
              min={1}
              max={4}
              step={1}
              displayValue={`${v.worldsPerFaction}`}
              onChange={x => set('worldsPerFaction', x)}
              file="worker/factions.js WORLDS_PER_PLAYER"
              notes="Capital + extras. With 22 worlds and 8 players × 4 = 32, the seeder runs out."
            />
          </div>
          <div className="section-visual">
            <FactionGrid maxPlayers={v.maxPlayers} worldsPerFaction={v.worldsPerFaction} />
          </div>
        </div>
      </Section>

      {/* ===== Ship combat stats ===== */}
      <Section
        eyebrow="03 · SHIPS"
        title="Ship combat stats"
        description="Per-class HP and damage per tick. The bar chart on the right scales with your slider values."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Corvette HP" value={v.corvetteHp} min={10} max={200} step={5} onChange={x => set('corvetteHp', x)} file="worker/factions.js SHIP_COMBAT_STATS" />
            <Slider label="Corvette damage" value={v.corvetteDmg} min={1} max={50} step={1} onChange={x => set('corvetteDmg', x)} />
            <Slider label="Frigate HP" value={v.frigateHp} min={20} max={400} step={5} onChange={x => set('frigateHp', x)} />
            <Slider label="Frigate damage" value={v.frigateDmg} min={1} max={50} step={1} onChange={x => set('frigateDmg', x)} />
            <Slider label="Destroyer HP" value={v.destroyerHp} min={50} max={800} step={10} onChange={x => set('destroyerHp', x)} />
            <Slider label="Destroyer damage" value={v.destroyerDmg} min={1} max={80} step={1} onChange={x => set('destroyerDmg', x)} />
          </div>
          <div className="section-visual">
            <ShipStatBars
              corvette={{ hp: v.corvetteHp, dmg: v.corvetteDmg }}
              frigate={{ hp: v.frigateHp, dmg: v.frigateDmg }}
              destroyer={{ hp: v.destroyerHp, dmg: v.destroyerDmg }}
            />
          </div>
        </div>
      </Section>

      {/* ===== Build economy ===== */}
      <Section
        eyebrow="04 · BUILD ECONOMY"
        title="Build cost and time"
        description="Metal cost and tick count to construct each class."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Corvette metal" value={v.corvetteMetal} min={1} max={100} step={1} onChange={x => set('corvetteMetal', x)} file="worker/actions.js SHIP_BUILD_COST" />
            <Slider label="Corvette build ticks" value={v.corvetteBuildTicks} min={5} max={200} step={5} onChange={x => set('corvetteBuildTicks', x)} />
            <Slider label="Frigate metal" value={v.frigateMetal} min={1} max={200} step={1} onChange={x => set('frigateMetal', x)} />
            <Slider label="Frigate build ticks" value={v.frigateBuildTicks} min={10} max={400} step={10} onChange={x => set('frigateBuildTicks', x)} />
            <Slider label="Destroyer metal" value={v.destroyerMetal} min={1} max={400} step={1} onChange={x => set('destroyerMetal', x)} />
            <Slider label="Destroyer build ticks" value={v.destroyerBuildTicks} min={20} max={800} step={20} onChange={x => set('destroyerBuildTicks', x)} />
          </div>
          <div className="section-visual">
            <BuildEconomyChart
              tickIntervalMs={v.tickIntervalMs}
              corvette={{ metal: v.corvetteMetal, ticks: v.corvetteBuildTicks }}
              frigate={{ metal: v.frigateMetal, ticks: v.frigateBuildTicks }}
              destroyer={{ metal: v.destroyerMetal, ticks: v.destroyerBuildTicks }}
            />
          </div>
        </div>
      </Section>

      {/* ===== Settlements ===== */}
      <Section
        eyebrow="05 · SETTLEMENTS"
        title="Cities and stations"
        description="Cost, HP, yield biases. City favors metal, station favors science."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Settlement cost (metal)" value={v.settlementCost} min={5} max={150} step={5} onChange={x => set('settlementCost', x)} file="worker/actions.js SETTLEMENT_COST" />
            <Slider label="City HP" value={v.cityHp} min={20} max={400} step={10} onChange={x => set('cityHp', x)} />
            <Slider label="Station HP" value={v.stationHp} min={10} max={300} step={5} onChange={x => set('stationHp', x)} />
            <Slider label="Pop growth interval" value={v.popGrowthInterval} min={5} max={100} step={1} onChange={x => set('popGrowthInterval', x)} file="worker/room.js POP_GROWTH_INTERVAL" notes="Ticks per +1 pop, capped at pop max." />
            <Slider label="Harvest interval" value={v.harvestInterval} min={1} max={50} step={1} onChange={x => set('harvestInterval', x)} file="worker/room.js HARVEST_INTERVAL" />
            <Slider label="Pop cap" value={v.popMax} min={1} max={30} step={1} onChange={x => set('popMax', x)} file="worker/room.js POP_MAX" />
            <Slider label="Pop yield multiplier (per level)" value={v.popMultiplierPerLevel} min={0} max={0.5} step={0.01} onChange={x => set('popMultiplierPerLevel', x)} notes="Yield = base × (1 + this × (pop−1))" />
            <Slider label="Settlement combat dmg" value={v.settlementCombatDmg} min={0} max={20} step={1} onChange={x => set('settlementCombatDmg', x)} file="worker/room.js SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP" notes="hp / hostile ship / tick" />
          </div>
          <div className="section-visual">
            <SettlementYieldBars
              cityMetal={v.cityMetalBias}
              cityScience={v.cityScienceBias}
              stationFuel={v.stationFuelBias}
              stationScience={v.stationScienceBias}
              popMultiplier={v.popMultiplierPerLevel}
              popMax={v.popMax}
            />
          </div>
        </div>
      </Section>

      {/* ===== Tech tree ===== */}
      <Section
        eyebrow="06 · TECH"
        title="Tech cost curves"
        description="Cost = ⌈baseCost × (level+1)^scaling⌉. Higher scaling slows snowballing; higher base makes early levels expensive."
      >
        <div className="section-grid">
          <div className="section-controls">
            <TechRow techId="weapons" label="Weapons (+10% firepower)" base={v.weaponsBaseCost} scaling={v.weaponsScaling} onBase={x => set('weaponsBaseCost', x)} onScaling={x => set('weaponsScaling', x)} />
            <TechRow techId="armor" label="Armor (+8% HP)" base={v.armorBaseCost} scaling={v.armorScaling} onBase={x => set('armorBaseCost', x)} onScaling={x => set('armorScaling', x)} />
            <TechRow techId="propulsion" label="Propulsion (−6% Δv)" base={v.propulsionBaseCost} scaling={v.propulsionScaling} onBase={x => set('propulsionBaseCost', x)} onScaling={x => set('propulsionScaling', x)} />
            <TechRow techId="flight" label="Flight (−6% travel time)" base={v.flightBaseCost} scaling={v.flightScaling} onBase={x => set('flightBaseCost', x)} onScaling={x => set('flightScaling', x)} />
            <TechRow techId="construction" label="Construction (−5% build cost)" base={v.constructionBaseCost} scaling={v.constructionScaling} onBase={x => set('constructionBaseCost', x)} onScaling={x => set('constructionScaling', x)} />
            <TechRow techId="industry" label="Industry (+10% yield)" base={v.industryBaseCost} scaling={v.industryScaling} onBase={x => set('industryBaseCost', x)} onScaling={x => set('industryScaling', x)} />
            <TechRow techId="sensors" label="Sensors (+12% range)" base={v.sensorsBaseCost} scaling={v.sensorsScaling} onBase={x => set('sensorsBaseCost', x)} onScaling={x => set('sensorsScaling', x)} />
          </div>
          <div className="section-visual">
            <TechCostCurve
              techs={[
                { name: 'weapons', base: v.weaponsBaseCost, scaling: v.weaponsScaling, color: '#ff5e5e' },
                { name: 'armor', base: v.armorBaseCost, scaling: v.armorScaling, color: '#ffb84d' },
                { name: 'propulsion', base: v.propulsionBaseCost, scaling: v.propulsionScaling, color: '#4ecdc4' },
                { name: 'flight', base: v.flightBaseCost, scaling: v.flightScaling, color: '#6ee7b7' },
                { name: 'construction', base: v.constructionBaseCost, scaling: v.constructionScaling, color: '#a89878' },
                { name: 'industry', base: v.industryBaseCost, scaling: v.industryScaling, color: '#d4a574' },
                { name: 'sensors', base: v.sensorsBaseCost, scaling: v.sensorsScaling, color: '#67e8f9' },
              ]}
            />
          </div>
        </div>
      </Section>

      {/* ===== Physics & sensors ===== */}
      <Section
        eyebrow="07 · PHYSICS"
        title="Gravity and sensor reach"
        description="The Sun's gravitational parameter drives every Hohmann calculation. Sensor range is the radius your assets can see hostile ships through."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider
              label="Sol μ (gravitational parameter)"
              value={v.solMu}
              min={1000}
              max={20_000}
              step={100}
              displayValue={v.solMu.toFixed(0)}
              onChange={x => set('solMu', x)}
              file="worker/room.js SOL_MU"
              notes="Default ≈ 6003 from Jupiter calibration. Higher μ = faster transfers."
            />
            <Slider
              label="Base sensor range (station)"
              value={v.baseSensorRange}
              min={50}
              max={600}
              step={10}
              displayValue={`${v.baseSensorRange}u`}
              onChange={x => set('baseSensorRange', x)}
              file="src/game/visibility.ts SETTLEMENT_SENSOR_RANGE"
              notes="Solar system spans ~460u. Station at 400u sees most of the inner system."
            />
          </div>
          <div className="section-visual">
            <SensorRangePreview range={v.baseSensorRange} />
          </div>
        </div>
      </Section>

      {/* ===== VFX ===== */}
      <Section
        eyebrow="08 · VFX"
        title="Visual effects"
        description="Tuning for cosmetic effects that don't change gameplay. The live preview on the right pulses at the chosen interval so you can feel the duration before exporting."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider
              label="Damage flash duration"
              value={v.damageFlashMs}
              min={100}
              max={2000}
              step={50}
              displayValue={`${v.damageFlashMs}ms`}
              onChange={x => set('damageFlashMs', x)}
              file="src/render/mapRenderer.ts DAMAGE_FLASH_DURATION_MS"
              notes="Wall-clock duration of the red halo when a ship/settlement takes damage. Tied to real time, not game ticks, so it feels the same at any sim speed."
            />
          </div>
          <div className="section-visual">
            <DamageFlashPreview durationMs={v.damageFlashMs} />
          </div>
        </div>
      </Section>

      <footer className="tunables-foot">
        <p>
          Want to make these stick? Edit the corresponding file under <code>worker/</code> or
          <code>src/game/</code> and ship a PR. This page is the map; the values themselves
          live in code.
        </p>
        <button className="tunables-back-foot" onClick={onBack}>← BACK TO LANDING</button>
      </footer>
    </div>
  );
};

// ============================================================
// Section + Slider helpers
// ============================================================

interface SectionProps {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ eyebrow, title, description, children }) => (
  <section className="tun-section">
    <div className="tun-section-head">
      <div className="tun-section-eyebrow">{eyebrow}</div>
      <h2 className="tun-section-title">{title}</h2>
      <p className="tun-section-desc">{description}</p>
    </div>
    {children}
  </section>
);

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  displayValue?: string;
  file?: string;
  notes?: string;
}

const Slider: React.FC<SliderProps> = ({ label, value, min, max, step, onChange, displayValue, file, notes }) => (
  <div className="tun-slider">
    <div className="tun-slider-head">
      <span className="tun-slider-label">{label}</span>
      <span className="tun-slider-value">{displayValue ?? value.toString()}</span>
    </div>
    <input
      className="tun-slider-input"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
    />
    {(file || notes) && (
      <div className="tun-slider-meta">
        {file && <code className="tun-slider-file">{file}</code>}
        {notes && <span className="tun-slider-notes">{notes}</span>}
      </div>
    )}
  </div>
);

interface TechRowProps {
  techId: string;
  label: string;
  base: number;
  scaling: number;
  onBase: (v: number) => void;
  onScaling: (v: number) => void;
}

const TechRow: React.FC<TechRowProps> = ({ label, base, scaling, onBase, onScaling }) => (
  <div className="tun-tech-row">
    <div className="tun-tech-label">{label}</div>
    <div className="tun-tech-controls">
      <Slider label="base cost" value={base} min={1} max={500} step={1} onChange={onBase} />
      <Slider label="scaling" value={scaling} min={1.0} max={3.0} step={0.05} displayValue={scaling.toFixed(2)} onChange={onScaling} />
    </div>
  </div>
);

// === Helpers =================================================

function snapToTickInterval(ms: number): number {
  let best = TICK_INTERVAL_OPTIONS[0].ms;
  let bestDist = Math.abs(Math.log(ms) - Math.log(best));
  for (const opt of TICK_INTERVAL_OPTIONS) {
    const d = Math.abs(Math.log(ms) - Math.log(opt.ms));
    if (d < bestDist) { best = opt.ms; bestDist = d; }
  }
  return best;
}

// ============================================================
// Visualizations
// ============================================================

/** Animated mini solar system. Earth completes ~one orbit per
 *  (123.8 ticks × tickInterval) of real time, but we compress to keep
 *  the visualization perceptible — fastest interval gives ~5s/orbit,
 *  slowest gives ~120s/orbit. The relative speed faithfully reflects
 *  the tick-rate slider position. */
const MiniSolarSystem: React.FC<{ tickIntervalMs: number }> = ({ tickIntervalMs }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pull tickIntervalMs into a ref so the rAF closure stays fresh
  const intervalRef = useRef(tickIntervalMs);
  useEffect(() => { intervalRef.current = tickIntervalMs; }, [tickIntervalMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const cx = W / 2;
    const cy = H / 2;

    let raf: number;
    const start = performance.now();
    const bodies = [
      // [orbital radius px, real-period-at-slowest-seconds, color]
      { r: 30,  period: 0.24, color: '#a89878', name: 'M' },
      { r: 45,  period: 0.62, color: '#e8c074', name: 'V' },
      { r: 65,  period: 1.0,  color: '#7fb3d5', name: 'E' },
      { r: 85,  period: 1.88, color: '#d8784a', name: 'M' },
      { r: 130, period: 11.86, color: '#d4a574', name: 'J' },
    ];

    const render = (now: number) => {
      const elapsedSec = (now - start) / 1000;
      // Speed factor: at 30s tick (fastest) → 24×, at 24h tick (slowest) → 1×.
      // log-scale across our 8 fixed intervals.
      const slowestMs = 86_400_000;
      const fastestMs = 30_000;
      const t = Math.log(slowestMs / intervalRef.current) / Math.log(slowestMs / fastestMs);
      const speed = 1 + t * 23; // 1 → 24

      // Clear
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, W, H);

      // Faint orbits
      ctx.strokeStyle = 'rgba(45, 66, 85, 0.6)';
      ctx.lineWidth = 0.5;
      for (const b of bodies) {
        ctx.beginPath();
        ctx.arc(cx, cy, b.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Sun
      const sunGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
      sunGrad.addColorStop(0, '#fff8e0');
      sunGrad.addColorStop(0.6, '#ffd180');
      sunGrad.addColorStop(1, '#ffa940');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();

      // Sun glow
      const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, 28);
      glow.addColorStop(0, 'rgba(255, 209, 128, 0.4)');
      glow.addColorStop(1, 'rgba(255, 154, 60, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - 28, cy - 28, 56, 56);

      // Planets
      for (const b of bodies) {
        const angle = (elapsedSec * speed / b.period) * 0.3; // tunable visual scale
        const x = cx + Math.cos(angle) * b.r;
        const y = cy + Math.sin(angle) * b.r;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="vis-solar-system-wrap">
      <canvas ref={canvasRef} className="vis-solar-system" />
      <div className="vis-caption">
        1 tick = <strong>{formatTickInterval(tickIntervalMs)}</strong>
        <span className="vis-caption-dim"> · Earth orbit = 123.8 ticks</span>
      </div>
    </div>
  );
};

/** Grid of faction-colored boxes representing how many worlds get
 *  carved up at game start. */
const FactionGrid: React.FC<{ maxPlayers: number; worldsPerFaction: number }> = ({ maxPlayers, worldsPerFaction }) => {
  const colors = ['#ff5e5e', '#4ecdc4', '#ffb84d', '#a89878', '#67e8f9', '#fda4af', '#c4b5fd', '#6ee7b7'];
  const totalWorlds = 22; // bodies excluding Sol
  const consumed = maxPlayers * worldsPerFaction;
  const unclaimed = Math.max(0, totalWorlds - consumed);
  const overflow = consumed > totalWorlds;

  return (
    <div className="vis-faction-grid">
      <div className="vis-grid-header">FACTIONS × WORLDS</div>
      <div className="vis-grid-cells">
        {Array.from({ length: maxPlayers }).map((_, i) => (
          <div key={i} className="vis-faction-row" style={{ color: colors[i] }}>
            <span className="vis-faction-name">FACTION {i + 1}</span>
            <span className="vis-faction-worlds">
              {Array.from({ length: worldsPerFaction }).map((_, j) => (
                <span key={j} className="vis-world-dot" style={{ background: colors[i] }} />
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="vis-grid-summary">
        <div>{consumed} worlds claimed of {totalWorlds}</div>
        {overflow
          ? <div className="vis-warn">⚠ Seeder will run out — {consumed - totalWorlds} faction-worlds will be unassigned</div>
          : <div className="vis-good">{unclaimed} worlds remain neutral</div>}
      </div>
    </div>
  );
};

/** HP and DMG bar chart per ship class. */
const ShipStatBars: React.FC<{
  corvette: { hp: number; dmg: number };
  frigate: { hp: number; dmg: number };
  destroyer: { hp: number; dmg: number };
}> = ({ corvette, frigate, destroyer }) => {
  const ships = [
    { name: 'Corvette', ...corvette, color: '#4ecdc4' },
    { name: 'Frigate', ...frigate, color: '#ffb84d' },
    { name: 'Destroyer', ...destroyer, color: '#ff5e5e' },
  ];
  const maxHp = Math.max(...ships.map(s => s.hp));
  const maxDmg = Math.max(...ships.map(s => s.dmg));

  return (
    <div className="vis-ship-bars">
      <div className="vis-bar-header">
        <span style={{ flex: 1 }}>CLASS</span>
        <span style={{ width: 90 }}>HP</span>
        <span style={{ width: 90 }}>DMG/tick</span>
      </div>
      {ships.map(s => (
        <div className="vis-bar-row" key={s.name}>
          <span className="vis-bar-name" style={{ color: s.color }}>{s.name}</span>
          <div className="vis-bar-cell">
            <div className="vis-bar-track">
              <div className="vis-bar-fill" style={{ width: `${(s.hp / maxHp) * 100}%`, background: s.color }} />
            </div>
            <span className="vis-bar-num">{s.hp}</span>
          </div>
          <div className="vis-bar-cell">
            <div className="vis-bar-track">
              <div className="vis-bar-fill" style={{ width: `${(s.dmg / maxDmg) * 100}%`, background: s.color }} />
            </div>
            <span className="vis-bar-num">{s.dmg}</span>
          </div>
        </div>
      ))}
      <div className="vis-derived">
        <div>Frigate vs Destroyer DPS swap-out: <strong>{(frigate.dmg / destroyer.dmg * 100).toFixed(0)}%</strong></div>
        <div>Time to kill Frigate: corvette <strong>{Math.ceil(frigate.hp / corvette.dmg)}t</strong> · destroyer <strong>{Math.ceil(frigate.hp / destroyer.dmg)}t</strong></div>
      </div>
    </div>
  );
};

/** Build cost + time visualization. Shows real-time-to-build under current
 *  tick interval. */
const BuildEconomyChart: React.FC<{
  tickIntervalMs: number;
  corvette: { metal: number; ticks: number };
  frigate: { metal: number; ticks: number };
  destroyer: { metal: number; ticks: number };
}> = ({ tickIntervalMs, corvette, frigate, destroyer }) => {
  const ships = [
    { name: 'Corvette', ...corvette, color: '#4ecdc4' },
    { name: 'Frigate', ...frigate, color: '#ffb84d' },
    { name: 'Destroyer', ...destroyer, color: '#ff5e5e' },
  ];
  const realTime = (ticks: number) => {
    const ms = ticks * tickIntervalMs;
    if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    return `${(ms / 86_400_000).toFixed(1)}d`;
  };

  return (
    <div className="vis-build-chart">
      <div className="vis-build-header">CLASS · METAL · TICKS · REAL TIME</div>
      {ships.map(s => (
        <div className="vis-build-row" key={s.name}>
          <span className="vis-build-name" style={{ color: s.color }}>{s.name}</span>
          <span className="vis-build-stat">{s.metal}M</span>
          <span className="vis-build-stat">{s.ticks}t</span>
          <span className="vis-build-stat vis-build-realtime">≈ {realTime(s.ticks)}</span>
        </div>
      ))}
      <div className="vis-derived">
        Per-tick metal velocity for one of each:{' '}
        <strong>{((corvette.metal / corvette.ticks) + (frigate.metal / frigate.ticks) + (destroyer.metal / destroyer.ticks)).toFixed(2)}</strong> M/t
      </div>
    </div>
  );
};

/** Settlement yield comparison bars. Shows city vs station resource bias at
 *  maximum population. */
const SettlementYieldBars: React.FC<{
  cityMetal: number; cityScience: number;
  stationFuel: number; stationScience: number;
  popMultiplier: number; popMax: number;
}> = ({ cityMetal, cityScience, stationFuel, stationScience, popMultiplier, popMax }) => {
  const popMult = 1 + popMultiplier * (popMax - 1);
  const cityYield = { metal: cityMetal * popMult, science: cityScience * popMult };
  const stationYield = { fuel: stationFuel * popMult, science: stationScience * popMult };
  const maxVal = Math.max(cityYield.metal, cityYield.science, stationYield.fuel, stationYield.science);

  return (
    <div className="vis-settlement">
      <div className="vis-settlement-row">
        <div className="vis-settlement-header" style={{ color: '#ff5e5e' }}>■ CITY · pop {popMax}</div>
        <YieldBar label="METAL" value={cityYield.metal} max={maxVal} color="#a89878" />
        <YieldBar label="SCIENCE" value={cityYield.science} max={maxVal} color="#67e8f9" />
      </div>
      <div className="vis-settlement-row">
        <div className="vis-settlement-header" style={{ color: '#4ecdc4' }}>◆ STATION · pop {popMax}</div>
        <YieldBar label="FUEL" value={stationYield.fuel} max={maxVal} color="#ffb84d" />
        <YieldBar label="SCIENCE" value={stationYield.science} max={maxVal} color="#67e8f9" />
      </div>
      <div className="vis-derived">
        Pop multiplier at max: <strong>×{popMult.toFixed(2)}</strong>
      </div>
    </div>
  );
};

const YieldBar: React.FC<{ label: string; value: number; max: number; color: string }> = ({ label, value, max, color }) => (
  <div className="vis-yield-row">
    <span className="vis-yield-label">{label}</span>
    <div className="vis-yield-track">
      <div className="vis-yield-fill" style={{ width: `${(value / max) * 100}%`, background: color }} />
    </div>
    <span className="vis-yield-num">×{value.toFixed(2)}</span>
  </div>
);

/** Tech cost curve plot — log-y axis would be nicer but linear is fine
 *  for the first 10 levels. */
const TechCostCurve: React.FC<{
  techs: { name: string; base: number; scaling: number; color: string }[];
}> = ({ techs }) => {
  const W = 360;
  const H = 220;
  const PAD = 28;
  const maxLevel = 9;
  const allCosts = techs.flatMap(t =>
    Array.from({ length: maxLevel + 1 }, (_, i) => Math.ceil(t.base * Math.pow(i + 1, t.scaling)))
  );
  const maxCost = Math.max(...allCosts);

  const xAt = (level: number) => PAD + (level / maxLevel) * (W - 2 * PAD);
  const yAt = (cost: number) => H - PAD - (cost / maxCost) * (H - 2 * PAD);

  return (
    <div className="vis-tech-curve">
      <svg viewBox={`0 0 ${W} ${H}`} className="vis-tech-svg">
        {/* axes */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#2a3d50" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#2a3d50" />
        {/* y-axis ticks */}
        {[0.25, 0.5, 0.75].map(f => (
          <g key={f}>
            <line x1={PAD - 3} x2={PAD} y1={yAt(maxCost * f)} y2={yAt(maxCost * f)} stroke="#2a3d50" />
            <text x={PAD - 5} y={yAt(maxCost * f) + 3} textAnchor="end" className="vis-axis-label">{Math.round(maxCost * f)}</text>
          </g>
        ))}
        <text x={PAD - 5} y={yAt(maxCost) + 3} textAnchor="end" className="vis-axis-label">{maxCost}</text>
        {/* x-axis ticks */}
        {[0, 3, 6, 9].map(l => (
          <text key={l} x={xAt(l)} y={H - PAD + 12} textAnchor="middle" className="vis-axis-label">L{l + 1}</text>
        ))}
        {/* curves */}
        {techs.map(t => {
          const points = Array.from({ length: maxLevel + 1 }, (_, i) => {
            const cost = Math.ceil(t.base * Math.pow(i + 1, t.scaling));
            return `${xAt(i)},${yAt(cost)}`;
          }).join(' ');
          return (
            <g key={t.name}>
              <polyline points={points} fill="none" stroke={t.color} strokeWidth="1.4" opacity="0.85" />
              {/* endpoint dot */}
              <circle
                cx={xAt(maxLevel)}
                cy={yAt(Math.ceil(t.base * Math.pow(maxLevel + 1, t.scaling)))}
                r="2.5"
                fill={t.color}
              />
            </g>
          );
        })}
      </svg>
      <div className="vis-tech-legend">
        {techs.map(t => (
          <span key={t.name} className="vis-tech-legend-item">
            <span className="vis-tech-legend-dot" style={{ background: t.color }} />
            {t.name}
          </span>
        ))}
      </div>
      <div className="vis-derived">
        Cost at L10 ranges from <strong>{Math.min(...techs.map(t => Math.ceil(t.base * Math.pow(maxLevel + 1, t.scaling))))}</strong>
        {' '}to <strong>{Math.max(...techs.map(t => Math.ceil(t.base * Math.pow(maxLevel + 1, t.scaling))))}</strong> science.
      </div>
    </div>
  );
};

/** Solar-system overhead view with a sensor-range ring at Earth's orbit. */
const SensorRangePreview: React.FC<{ range: number }> = ({ range }) => {
  const W = 360, H = 220;
  const cx = W / 2, cy = H / 2;
  // Game units; solar system spans ~460
  const scale = (H - 40) / 920; // fit ±460 vertically
  const px = (u: number) => u * scale;

  const orbits = [
    { r: 70,  color: '#a89878', name: 'Mercury' },
    { r: 100, color: '#e8c074', name: 'Venus' },
    { r: 132, color: '#7fb3d5', name: 'Earth' },
    { r: 202, color: '#d8784a', name: 'Mars' },
    { r: 460, color: '#d4a574', name: 'Jupiter' },
  ];

  return (
    <div className="vis-sensor-range">
      <svg viewBox={`0 0 ${W} ${H}`} className="vis-sensor-svg">
        {/* Faint orbits */}
        {orbits.map(o => (
          <circle key={o.name} cx={cx} cy={cy} r={px(o.r)} stroke="#2a3d50" strokeWidth="0.5" fill="none" />
        ))}
        {/* Sun */}
        <circle cx={cx} cy={cy} r="3" fill="#ffd180" />
        {/* Earth */}
        <circle cx={cx + px(132)} cy={cy} r="2.5" fill="#7fb3d5" />
        {/* Sensor radius ring at Earth */}
        <circle
          cx={cx + px(132)}
          cy={cy}
          r={px(range)}
          stroke="#4ecdc4"
          strokeWidth="1"
          fill="rgba(78, 205, 196, 0.08)"
          strokeDasharray="3 3"
        />
        {/* Labels */}
        <text x={cx + px(132)} y={cy - 6} textAnchor="middle" className="vis-axis-label" fill="#7fb3d5">EARTH</text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="vis-axis-label">SOL</text>
      </svg>
      <div className="vis-derived">
        At range <strong>{range}u</strong>, an asset at Earth can see
        {' '}{range >= 70 ? <span className="vis-good">Mercury (70u)</span> : <span className="vis-warn">nothing inward</span>},
        {' '}{range >= 70 ? <span className="vis-good">Mars at closest (~70u)</span> : <span className="vis-warn">never Mars</span>},
        {' '}and {range >= 328 ? <span className="vis-good">Jupiter sometimes</span> : <span className="vis-warn">never Jupiter</span>}.
      </div>
    </div>
  );
};

/** Live preview of the damage flash. Fires a fresh halo every
 *  (durationMs × 1.6) so the user can see one flash complete before the
 *  next starts. Uses the same shape + opacity ramp as drawDamageFlash so
 *  what you preview is what you get in-game. */
const DamageFlashPreview: React.FC<{ durationMs: number }> = ({ durationMs }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pull durationMs through a ref so the rAF closure stays fresh without
  // tearing down the effect every slider tick.
  const durationRef = useRef(durationMs);
  useEffect(() => { durationRef.current = durationMs; }, [durationMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;

    let raf: number;
    let lastFireMs = performance.now();

    const render = (nowMs: number) => {
      // Background
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, W, H);

      const dur = durationRef.current;
      // Refire every dur × 1.6 so each flash gets to complete before the next
      if (nowMs - lastFireMs > dur * 1.6) lastFireMs = nowMs;
      const age = nowMs - lastFireMs;

      // Layout: three ship-marker positions across the strip
      const cy = H / 2;
      const positions = [W * 0.25, W * 0.5, W * 0.75];
      const baseR = 14;

      for (const cx of positions) {
        // Flash halo (same math as drawDamageFlash)
        if (age < dur) {
          const freshness = 1 - age / dur;
          const haloR = baseR * (2.5 + (1 - freshness) * 1.5);
          const grad = ctx.createRadialGradient(cx, cy, baseR * 0.6, cx, cy, haloR);
          grad.addColorStop(0, `rgba(255, 90, 90, ${0.55 * freshness})`);
          grad.addColorStop(0.6, `rgba(255, 60, 60, ${0.25 * freshness})`);
          grad.addColorStop(1, 'rgba(255, 60, 60, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
          ctx.fill();
        }

        // Ship "icon" — a small cyan triangle so the flash has something
        // to wrap around
        ctx.fillStyle = '#4ecdc4';
        ctx.strokeStyle = '#0a0e14';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 8, cy);
        ctx.lineTo(cx - 5, cy - 5);
        ctx.lineTo(cx - 5, cy + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="vis-flash-wrap">
      <canvas ref={canvasRef} className="vis-flash-canvas" />
      <div className="vis-caption">
        Flash duration: <strong>{durationMs}ms</strong>
        <span className="vis-caption-dim"> · loops at {(durationMs * 1.6 / 1000).toFixed(2)}s</span>
      </div>
    </div>
  );
};
