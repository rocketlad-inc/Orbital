// ============================================================
// TunablesPage — explore the playtest knobs from DESIGN.md §6
//
// Every slider here mirrors a constant that lives somewhere in
// worker/* or src/game/*. Sliding doesn't change the live game;
// this page is a visual sandbox for grokking the design space and
// previewing how the loop responds to each value.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useTurnBasedSettings } from '../state/turnBasedSettings';
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
  // Starting conditions
  startingMetal: 100,
  startingFuel: 200,
  startingGold: 50,
  combatShipsPerWorld: 2,
  cargoShipsPerWorld: 1,
  starterCityHp: 100,
  // Ship combat
  corvetteHp: 40, corvetteDmg: 5,
  frigateHp: 80,  frigateDmg: 10,
  destroyerHp: 200, destroyerDmg: 18,
  freighterHp: 60, freighterDmg: 0,
  // Build economy
  corvetteMetal: 15, corvetteBuildTicks: 30,
  frigateMetal: 30,  frigateBuildTicks: 60,
  destroyerMetal: 60, destroyerBuildTicks: 120,
  freighterMetal: 20, freighterBuildTicks: 45,
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
  // Tech cost curves
  weaponsBaseCost: 40, weaponsScaling: 1.7,
  armorBaseCost: 40, armorScaling: 1.7,
  propulsionBaseCost: 35, propulsionScaling: 1.6,
  flightBaseCost: 50, flightScaling: 1.7,
  constructionBaseCost: 50, constructionScaling: 1.8,
  industryBaseCost: 45, industryScaling: 1.7,
  sensorsBaseCost: 30, sensorsScaling: 1.5,
  // Tech effect magnitudes (per level)
  weaponsPerLevel: 0.10,     // +10% firepower
  armorPerLevel: 0.08,       // +8% HP
  propulsionPerLevel: 0.06,  // -6% transfer Δv cost
  flightPerLevel: 0.06,      // -6% travel time
  constructionPerLevel: 0.05,// -5% build cost
  industryPerLevel: 0.10,    // +10% settlement yield
  sensorsPerLevel: 0.12,     // +12% sensor range
  // Physics
  solMu: 6003,
  // Fog of war: sensor ranges per asset
  corvetteSensor: 150,
  frigateSensor: 200,
  destroyerSensor: 175,
  freighterSensor: 100,
  citySensor: 250,
  baseSensorRange: 400,       // station sensor range
  ghostLifetimeTicks: 50,     // ticks a last-known ghost stays visible
  burnSignatureDuration: 15,  // ticks of boosted visibility after a burn
  burnSignatureBoost: 2.5,    // sensor-range multiplier at the moment of burn
  // Combat cadence + maintenance
  autoCombatInterval: 20,     // ticks between auto-fire volleys
  repairPerTickAtCity: 2,     // HP/tick restored to ships at a city
  // AI behavior
  aiDecisionInterval: 50,
  aiActionBudget: 2,
  aiTargetFleetSize: 5,
  aiExpansionTargetColonies: 2,
  aiDefenseShipsPerBody: 1,
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
  // === Newly added ===
  // Starting conditions
  startingMetal:         'worker/factions.js STARTING_RESOURCES.metal',
  startingFuel:          'worker/factions.js STARTING_RESOURCES.fuel',
  startingGold:          'worker/factions.js STARTING_RESOURCES.gold',
  combatShipsPerWorld:   'worker/factions.js COMBAT_SHIPS_PER_WORLD',
  cargoShipsPerWorld:    'worker/factions.js CARGO_SHIPS_PER_WORLD',
  starterCityHp:         'worker/factions.js STARTER_CITY_HP',
  // Freighter (was missing)
  freighterHp:           'worker/factions.js SHIP_COMBAT_STATS.freighter.hp + src/game/shipClasses.ts FREIGHTER.hp',
  freighterDmg:          'worker/factions.js SHIP_COMBAT_STATS.freighter.damage_per_tick',
  freighterMetal:        'worker/actions.js SHIP_BUILD_COST.freighter.metal',
  freighterBuildTicks:   'worker/actions.js SHIP_BUILD_COST.freighter.build_ticks',
  // Tech effect magnitudes
  weaponsPerLevel:       'src/game/techs.ts TECH_DEFS.weapons.perLevel',
  armorPerLevel:         'src/game/techs.ts TECH_DEFS.armor.perLevel',
  propulsionPerLevel:    'src/game/techs.ts TECH_DEFS.propulsion.perLevel',
  flightPerLevel:        'src/game/techs.ts TECH_DEFS.flight.perLevel',
  constructionPerLevel:  'src/game/techs.ts TECH_DEFS.construction.perLevel',
  industryPerLevel:      'src/game/techs.ts TECH_DEFS.industry.perLevel',
  sensorsPerLevel:       'src/game/techs.ts TECH_DEFS.sensors.perLevel',
  // Sensor ranges per class
  corvetteSensor:        'src/game/visibility.ts SHIP_SENSOR_RANGE.corvette',
  frigateSensor:         'src/game/visibility.ts SHIP_SENSOR_RANGE.frigate',
  destroyerSensor:       'src/game/visibility.ts SHIP_SENSOR_RANGE.destroyer',
  freighterSensor:       'src/game/visibility.ts SHIP_SENSOR_RANGE.freighter',
  citySensor:            'src/game/visibility.ts SETTLEMENT_SENSOR_RANGE.city',
  // Fog of war timings
  ghostLifetimeTicks:    'src/game/visibility.ts GHOST_LIFETIME_TICKS',
  burnSignatureDuration: 'src/game/visibility.ts BURN_SIGNATURE_DURATION',
  burnSignatureBoost:    'src/game/visibility.ts BURN_SIGNATURE_BOOST',
  // Combat cadence + maintenance
  autoCombatInterval:    'src/game/combat.ts AUTO_COMBAT_INTERVAL (mirrored in worker/room.js)',
  repairPerTickAtCity:   'src/game/maintenance.ts REPAIR_PER_TICK_CITY',
  // AI behavior
  aiDecisionInterval:    'src/game/factionAI.ts AI_DECISION_INTERVAL',
  aiActionBudget:        'src/game/factionAI.ts ACTION_BUDGET',
  aiTargetFleetSize:     'src/game/factionAI.ts TARGET_FLEET_SIZE',
  aiExpansionTargetColonies: 'src/game/factionAI.ts EXPANSION_TARGET_COLONIES',
  aiDefenseShipsPerBody: 'src/game/factionAI.ts DEFENSE_SHIPS_PER_BODY',
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

      {/* ===== LIVE SETTINGS — these write to context, not just the JSON ===== */}
      <TurnBasedModeLiveSettings />

      {/* ===== Economy & Flow — primer diagrams ===== */}
      <Section
        eyebrow="00 · PRIMER"
        title="How the economy works"
        description="Three diagrams showing the resource loop, the build dependency graph, and where everything comes from. Read this first if the sliders below feel disconnected — it's the mental model the rest of the page tunes."
      >
        <ResourceFlowDiagram />
        <DependencyDiagram />
        <YieldSinkDiagram
          cityM={v.cityMetalBias}
          cityS={v.cityScienceBias}
          stationF={v.stationFuelBias}
          stationS={v.stationScienceBias}
          popMultPerLevel={v.popMultiplierPerLevel}
          popMax={v.popMax}
          harvestInterval={v.harvestInterval}
        />
      </Section>

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
        title="Players, worlds, and starter loadout"
        description="How many factions in a room, what they start with, and what arrives in their orbit on tick 0."
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
            <Slider
              label="Starter combat ships per world"
              value={v.combatShipsPerWorld}
              min={0} max={6} step={1}
              displayValue={`${v.combatShipsPerWorld}`}
              onChange={x => set('combatShipsPerWorld', x)}
              file="worker/factions.js COMBAT_SHIPS_PER_WORLD"
              notes="Frigates spawned at each owned body on game start."
            />
            <Slider
              label="Starter freighters per world"
              value={v.cargoShipsPerWorld}
              min={0} max={4} step={1}
              displayValue={`${v.cargoShipsPerWorld}`}
              onChange={x => set('cargoShipsPerWorld', x)}
              file="worker/factions.js CARGO_SHIPS_PER_WORLD"
            />
            <Slider
              label="Starter city HP"
              value={v.starterCityHp}
              min={20} max={500} step={10}
              displayValue={`${v.starterCityHp}`}
              onChange={x => set('starterCityHp', x)}
              file="worker/factions.js STARTER_CITY_HP"
            />
            <Slider
              label="Starting metal"
              value={v.startingMetal} min={0} max={1000} step={10}
              onChange={x => set('startingMetal', x)}
              file="worker/factions.js STARTING_RESOURCES.metal"
            />
            <Slider
              label="Starting fuel"
              value={v.startingFuel} min={0} max={1000} step={10}
              onChange={x => set('startingFuel', x)}
              file="worker/factions.js STARTING_RESOURCES.fuel"
            />
            <Slider
              label="Starting credits"
              value={v.startingGold} min={0} max={1000} step={5}
              onChange={x => set('startingGold', x)}
              file="worker/factions.js STARTING_RESOURCES.gold"
            />
          </div>
          <div className="section-visual">
            <FactionGrid maxPlayers={v.maxPlayers} worldsPerFaction={v.worldsPerFaction} />
            <StarterLoadoutSummary
              combatShips={v.combatShipsPerWorld}
              cargoShips={v.cargoShipsPerWorld}
              cityHp={v.starterCityHp}
              metal={v.startingMetal}
              fuel={v.startingFuel}
              gold={v.startingGold}
            />
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
            <Slider label="Freighter HP" value={v.freighterHp} min={10} max={200} step={5} onChange={x => set('freighterHp', x)}
              notes="No combat damage by design — cargo class only." />
            <Slider label="Freighter damage" value={v.freighterDmg} min={0} max={20} step={1} onChange={x => set('freighterDmg', x)}
              notes="0 = pacifist. Set non-zero to give freighters self-defense bite." />
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
            <Slider label="Freighter metal" value={v.freighterMetal} min={1} max={100} step={1} onChange={x => set('freighterMetal', x)} />
            <Slider label="Freighter build ticks" value={v.freighterBuildTicks} min={5} max={200} step={5} onChange={x => set('freighterBuildTicks', x)} />
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
            <TechRow techId="weapons"      label={`Weapons (+${(v.weaponsPerLevel*100).toFixed(0)}% firepower)`}     base={v.weaponsBaseCost}     scaling={v.weaponsScaling}     perLevel={v.weaponsPerLevel}      onBase={x => set('weaponsBaseCost', x)}     onScaling={x => set('weaponsScaling', x)}     onPerLevel={x => set('weaponsPerLevel', x)} />
            <TechRow techId="armor"        label={`Armor (+${(v.armorPerLevel*100).toFixed(0)}% HP)`}                 base={v.armorBaseCost}       scaling={v.armorScaling}       perLevel={v.armorPerLevel}        onBase={x => set('armorBaseCost', x)}       onScaling={x => set('armorScaling', x)}       onPerLevel={x => set('armorPerLevel', x)} />
            <TechRow techId="propulsion"   label={`Propulsion (−${(v.propulsionPerLevel*100).toFixed(0)}% Δv)`}        base={v.propulsionBaseCost}  scaling={v.propulsionScaling}  perLevel={v.propulsionPerLevel}   onBase={x => set('propulsionBaseCost', x)}  onScaling={x => set('propulsionScaling', x)}  onPerLevel={x => set('propulsionPerLevel', x)} />
            <TechRow techId="flight"       label={`Flight (−${(v.flightPerLevel*100).toFixed(0)}% travel time)`}      base={v.flightBaseCost}      scaling={v.flightScaling}      perLevel={v.flightPerLevel}       onBase={x => set('flightBaseCost', x)}      onScaling={x => set('flightScaling', x)}      onPerLevel={x => set('flightPerLevel', x)} />
            <TechRow techId="construction" label={`Construction (−${(v.constructionPerLevel*100).toFixed(0)}% build cost)`} base={v.constructionBaseCost} scaling={v.constructionScaling} perLevel={v.constructionPerLevel} onBase={x => set('constructionBaseCost', x)} onScaling={x => set('constructionScaling', x)} onPerLevel={x => set('constructionPerLevel', x)} />
            <TechRow techId="industry"     label={`Industry (+${(v.industryPerLevel*100).toFixed(0)}% yield)`}        base={v.industryBaseCost}    scaling={v.industryScaling}    perLevel={v.industryPerLevel}     onBase={x => set('industryBaseCost', x)}    onScaling={x => set('industryScaling', x)}    onPerLevel={x => set('industryPerLevel', x)} />
            <TechRow techId="sensors"      label={`Sensors (+${(v.sensorsPerLevel*100).toFixed(0)}% range)`}          base={v.sensorsBaseCost}     scaling={v.sensorsScaling}     perLevel={v.sensorsPerLevel}      onBase={x => set('sensorsBaseCost', x)}     onScaling={x => set('sensorsScaling', x)}     onPerLevel={x => set('sensorsPerLevel', x)} />
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

      {/* ===== Physics ===== */}
      <Section
        eyebrow="07 · PHYSICS"
        title="Orbital gravity"
        description="The Sun's gravitational parameter drives every Hohmann calculation. Higher μ = faster transfers and tighter Δv budgets."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider
              label="Sol μ (gravitational parameter)"
              value={v.solMu}
              min={1000} max={20_000} step={100}
              displayValue={v.solMu.toFixed(0)}
              onChange={x => set('solMu', x)}
              file="worker/room.js SOL_MU"
              notes="Default ≈ 6003 from Jupiter calibration."
            />
          </div>
          <div className="section-visual">
            <SensorRangePreview range={v.baseSensorRange} />
          </div>
        </div>
      </Section>

      {/* ===== Fog of war ===== */}
      <Section
        eyebrow="08 · FOG OF WAR"
        title="Sensors and intel"
        description="Sensor range per asset class, how long stale intel ghosts linger, and how much burning engines amplify your signature."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Corvette sensor range" value={v.corvetteSensor} min={20} max={600} step={10}
              displayValue={`${v.corvetteSensor}u`} onChange={x => set('corvetteSensor', x)}
              file="src/game/visibility.ts SHIP_SENSOR_RANGE.corvette" />
            <Slider label="Frigate sensor range" value={v.frigateSensor} min={20} max={600} step={10}
              displayValue={`${v.frigateSensor}u`} onChange={x => set('frigateSensor', x)} />
            <Slider label="Destroyer sensor range" value={v.destroyerSensor} min={20} max={600} step={10}
              displayValue={`${v.destroyerSensor}u`} onChange={x => set('destroyerSensor', x)} />
            <Slider label="Freighter sensor range" value={v.freighterSensor} min={20} max={600} step={10}
              displayValue={`${v.freighterSensor}u`} onChange={x => set('freighterSensor', x)} />
            <Slider label="City sensor range" value={v.citySensor} min={50} max={600} step={10}
              displayValue={`${v.citySensor}u`} onChange={x => set('citySensor', x)}
              file="src/game/visibility.ts SETTLEMENT_SENSOR_RANGE.city" />
            <Slider label="Station sensor range" value={v.baseSensorRange} min={50} max={800} step={10}
              displayValue={`${v.baseSensorRange}u`} onChange={x => set('baseSensorRange', x)}
              file="src/game/visibility.ts SETTLEMENT_SENSOR_RANGE.station"
              notes="Station is the longest-range platform; ~400u sees most of the inner system." />
            <Slider label="Ghost lifetime" value={v.ghostLifetimeTicks} min={5} max={200} step={5}
              displayValue={`${v.ghostLifetimeTicks} ticks`}
              onChange={x => set('ghostLifetimeTicks', x)}
              file="src/game/visibility.ts GHOST_LIFETIME_TICKS"
              notes="How long a last-known position stays visible after a ship leaves sensor range." />
            <Slider label="Burn signature duration" value={v.burnSignatureDuration} min={1} max={60} step={1}
              displayValue={`${v.burnSignatureDuration} ticks`}
              onChange={x => set('burnSignatureDuration', x)}
              file="src/game/visibility.ts BURN_SIGNATURE_DURATION"
              notes="How many ticks a ship is extra-visible after firing engines." />
            <Slider label="Burn signature boost" value={v.burnSignatureBoost} min={1} max={6} step={0.1}
              displayValue={`×${v.burnSignatureBoost.toFixed(1)}`}
              onChange={x => set('burnSignatureBoost', x)}
              file="src/game/visibility.ts BURN_SIGNATURE_BOOST"
              notes="Sensor-range multiplier at the moment of burn. Decays linearly to 1.0." />
          </div>
          <div className="section-visual">
            <SensorComparisonBars
              ships={{ corvette: v.corvetteSensor, frigate: v.frigateSensor, destroyer: v.destroyerSensor, freighter: v.freighterSensor }}
              settlements={{ city: v.citySensor, station: v.baseSensorRange }}
            />
          </div>
        </div>
      </Section>

      {/* ===== Combat cadence + maintenance ===== */}
      <Section
        eyebrow="09 · COMBAT & MAINTENANCE"
        title="Tempo of war and repair"
        description="How often colocated ships exchange volleys, and how fast ships parked at a friendly city heal."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Auto-combat interval"
              value={v.autoCombatInterval} min={1} max={100} step={1}
              displayValue={`${v.autoCombatInterval} ticks`}
              onChange={x => set('autoCombatInterval', x)}
              file="src/game/combat.ts AUTO_COMBAT_INTERVAL"
              notes="Ticks between volleys. Lower = faster fights." />
            <Slider label="Repair / tick at a city"
              value={v.repairPerTickAtCity} min={0} max={20} step={1}
              displayValue={`${v.repairPerTickAtCity} HP`}
              onChange={x => set('repairPerTickAtCity', x)}
              file="src/game/maintenance.ts REPAIR_PER_TICK_CITY" />
          </div>
          <div className="section-visual">
            <CombatTempoCard
              autoCombatInterval={v.autoCombatInterval}
              repairPerTick={v.repairPerTickAtCity}
              tickIntervalMs={v.tickIntervalMs}
              destroyerDmg={v.destroyerDmg}
              frigateHp={v.frigateHp}
            />
          </div>
        </div>
      </Section>

      {/* ===== AI behavior ===== */}
      <Section
        eyebrow="10 · AI BEHAVIOR"
        title="How AI factions play"
        description="The phased utility-AI from src/game/factionAI.ts. Phase weights (EXP/DEF/AGR) aren't on this page — edit them in code — but every gate that triggers a phase transition is."
      >
        <div className="section-grid">
          <div className="section-controls">
            <Slider label="Decision cycle interval"
              value={v.aiDecisionInterval} min={5} max={500} step={5}
              displayValue={`${v.aiDecisionInterval} ticks`}
              onChange={x => set('aiDecisionInterval', x)}
              file="src/game/factionAI.ts AI_DECISION_INTERVAL"
              notes="Lower = more reactive but noisier." />
            <Slider label="Action budget"
              value={v.aiActionBudget} min={1} max={6} step={1}
              displayValue={`${v.aiActionBudget}`}
              onChange={x => set('aiActionBudget', x)}
              file="src/game/factionAI.ts ACTION_BUDGET" />
            <Slider label="Target fleet size"
              value={v.aiTargetFleetSize} min={1} max={20} step={1}
              displayValue={`${v.aiTargetFleetSize} combat ships`}
              onChange={x => set('aiTargetFleetSize', x)}
              file="src/game/factionAI.ts TARGET_FLEET_SIZE" />
            <Slider label="Expansion target (colonies)"
              value={v.aiExpansionTargetColonies} min={1} max={6} step={1}
              displayValue={`${v.aiExpansionTargetColonies} colonies`}
              onChange={x => set('aiExpansionTargetColonies', x)}
              file="src/game/factionAI.ts EXPANSION_TARGET_COLONIES"
              notes="Settled bodies the AI wants before leaving EXPANSION phase." />
            <Slider label="Defense floor (ships per body)"
              value={v.aiDefenseShipsPerBody} min={0} max={5} step={1}
              displayValue={`${v.aiDefenseShipsPerBody} ship/body`}
              onChange={x => set('aiDefenseShipsPerBody', x)}
              file="src/game/factionAI.ts DEFENSE_SHIPS_PER_BODY"
              notes="Required combat garrison at every owned body before AGGRESSION unlocks." />
          </div>
          <div className="section-visual">
            <AIPhaseCard
              decisionInterval={v.aiDecisionInterval}
              actionBudget={v.aiActionBudget}
              targetFleet={v.aiTargetFleetSize}
              expansionTarget={v.aiExpansionTargetColonies}
              defenseFloor={v.aiDefenseShipsPerBody}
              tickIntervalMs={v.tickIntervalMs}
            />
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
  /** Magnitude of the tech's per-level effect (e.g. 0.10 = +10%/level).
   *  Surfaced as its own slider so the sandbox can tune both the cost
   *  curve and the payoff side-by-side. */
  perLevel: number;
  onBase: (v: number) => void;
  onScaling: (v: number) => void;
  onPerLevel: (v: number) => void;
}

const TechRow: React.FC<TechRowProps> = ({
  label, base, scaling, perLevel, onBase, onScaling, onPerLevel,
}) => (
  <div className="tun-tech-row">
    <div className="tun-tech-label">{label}</div>
    <div className="tun-tech-controls">
      <Slider label="base cost" value={base} min={1} max={500} step={1} onChange={onBase} />
      <Slider label="scaling" value={scaling} min={1.0} max={3.0} step={0.05} displayValue={scaling.toFixed(2)} onChange={onScaling} />
      <Slider
        label="per level"
        value={perLevel}
        min={0}
        max={0.5}
        step={0.01}
        displayValue={`${(perLevel * 100).toFixed(0)}%`}
        onChange={onPerLevel}
      />
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

// ============================================================
// Placeholder primers — referenced from the page above
// (sections 00 PRIMER and 02 FACTIONS) but never implemented;
// the build broke without these. Minimal labeled cards that
// surface the relevant numbers without the full visualization.
// ============================================================

/**
 * Resource flow diagram — left to right: body yields → settlement stockpile
 * → freighter → faction pool → spent on builds + tech.
 *
 * Inline SVG with named boxes + labeled arrows. Static (no slider deps);
 * just explains the loop.
 */
const ResourceFlowDiagram: React.FC = () => (
  <div className="vis-flow">
    <div className="vis-flow-title">RESOURCE FLOW</div>
    <svg viewBox="0 0 720 200" className="vis-flow-svg">
      {/* Boxes */}
      <FlowNode x={20}  y={70} w={120} h={60} title="BODY" sub="metal · fuel · credits · science" color="#a89878" />
      <FlowNode x={180} y={70} w={130} h={60} title="SETTLEMENT" sub="harvests every N ticks" color="#ff8c69" />
      <FlowNode x={350} y={70} w={120} h={60} title="FREIGHTER" sub="ferries to pool" color="#4ecdc4" />
      <FlowNode x={510} y={70} w={130} h={60} title="FACTION POOL" sub="metal · fuel · credits · sci" color="#ffb84d" />
      {/* Spend lanes */}
      <FlowNode x={550} y={5}  w={130} h={36} title="→ SHIP BUILDS" sub="metal + credits"  color="#67e8f9" small />
      <FlowNode x={550} y={160} w={130} h={36} title="→ SETTLEMENTS" sub="metal + credits" color="#67e8f9" small />
      <FlowNode x={50}  y={155} w={180} h={36} title="→ TECH" sub="science (from yield)"  color="#67e8f9" small />
      {/* Arrows */}
      <FlowArrow x1={140} y1={100} x2={180} y2={100} label={`× pop mult`} />
      <FlowArrow x1={310} y1={100} x2={350} y2={100} label={`when freighter at body`} />
      <FlowArrow x1={470} y1={100} x2={510} y2={100} />
      {/* Pool → spends */}
      <FlowArrow x1={615} y1={70} x2={615} y2={41}  vertical />
      <FlowArrow x1={615} y1={130} x2={615} y2={160} vertical />
      {/* Tech feedback — pool reaches back to settlement (industry) */}
      <FlowArrow x1={550} y1={172} x2={230} y2={172} label="science earns industry / yield buff" reverse />
    </svg>
  </div>
);

/**
 * Build-dependency diagram. Arrow tail = prerequisite, arrow head = unlock.
 */
const DependencyDiagram: React.FC = () => (
  <div className="vis-flow">
    <div className="vis-flow-title">BUILD DEPENDENCIES</div>
    <svg viewBox="0 0 720 180" className="vis-flow-svg">
      <FlowNode x={20}  y={70}  w={120} h={50} title="STATION" sub="orbital shipyard" color="#4ecdc4" />
      <FlowNode x={200} y={20}  w={130} h={50} title="SHIPS" sub="corvette · frigate · destroyer · freighter" color="#ffb84d" small />
      <FlowNode x={20}  y={20}  w={120} h={36} title="FREIGHTER" sub="needed to deploy" color="#4ecdc4" small />
      <FlowNode x={200} y={120} w={130} h={50} title="SETTLEMENTS" sub="city · station" color="#ffb84d" small />
      <FlowNode x={380} y={70}  w={120} h={50} title="SCIENCE" sub="from settlement yield" color="#67e8f9" />
      <FlowNode x={550} y={70}  w={150} h={50} title="TECH LEVELS" sub="weapons · armor · …" color="#ec407a" />
      {/* Arrows */}
      <FlowArrow x1={140} y1={88} x2={200} y2={50}  label="enables" />
      <FlowArrow x1={140} y1={40} x2={200} y2={135} label="enables" />
      <FlowArrow x1={330} y1={140} x2={380} y2={105} label="harvests" />
      <FlowArrow x1={500} y1={95} x2={550} y2={95}  label="spends" />
      <text x={360} y={172} className="vis-flow-note" textAnchor="middle">
        TECH boosts: firepower (weapons) · HP (armor) · build cost (construction) · yield (industry) · sensor range (sensors)
      </text>
    </svg>
  </div>
);

// (Original FlowNode + FlowArrow primitives are defined further down,
// alongside the per-section visual cards. Duplicates were removed here
// to satisfy the TS no-duplicate-declaration check.)

// ============================================================
// Per-section visualization cards
// ============================================================

interface SensorComparisonProps {
  ships: { corvette: number; frigate: number; destroyer: number; freighter: number };
  settlements: { city: number; station: number };
}

/**
 * Horizontal bar chart comparing sensor range across every asset class.
 * Bars are scaled by the highest range so even a 600u station fits.
 */
const SensorComparisonBars: React.FC<SensorComparisonProps> = ({ ships, settlements }) => {
  const rows = [
    { name: 'Freighter', value: ships.freighter, color: '#a89878' },
    { name: 'Corvette',  value: ships.corvette,  color: '#4ecdc4' },
    { name: 'Destroyer', value: ships.destroyer, color: '#ff5e5e' },
    { name: 'Frigate',   value: ships.frigate,   color: '#ffb84d' },
    { name: 'City',      value: settlements.city,    color: '#6ee7b7' },
    { name: 'Station',   value: settlements.station, color: '#67e8f9' },
  ];
  const max = Math.max(...rows.map(r => r.value));
  return (
    <div className="vis-sensor-bars">
      <div className="vis-bar-header">SENSOR RANGE BY ASSET</div>
      {rows.map(r => (
        <div className="vis-bar-row" key={r.name}>
          <span className="vis-bar-name" style={{ color: r.color }}>{r.name}</span>
          <div className="vis-bar-cell" style={{ flex: 1 }}>
            <div className="vis-bar-track">
              <div className="vis-bar-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
            </div>
            <span className="vis-bar-num">{r.value}u</span>
          </div>
        </div>
      ))}
      <div className="vis-derived">
        Solar system spans ~460u. Station at {settlements.station}u sees{' '}
        {settlements.station >= 460
          ? <span className="vis-good">the whole inner system</span>
          : <span className="vis-warn">~{Math.round((settlements.station / 460) * 100)}% of it</span>}.
      </div>
    </div>
  );
};

interface CombatTempoProps {
  autoCombatInterval: number;
  repairPerTick: number;
  tickIntervalMs: number;
  destroyerDmg: number;
  frigateHp: number;
}

/** Derived stats card for the combat section — translates the cadence
 *  numbers into a wall-clock expectation. */
const CombatTempoCard: React.FC<CombatTempoProps> = ({
  autoCombatInterval, repairPerTick, tickIntervalMs, destroyerDmg, frigateHp,
}) => {
  // Wall-clock time for one volley
  const volleyMs = autoCombatInterval * tickIntervalMs;
  const volleyStr = volleyMs < 60_000
    ? `${(volleyMs / 1000).toFixed(0)}s`
    : volleyMs < 3_600_000
      ? `${(volleyMs / 60_000).toFixed(1)}m`
      : volleyMs < 86_400_000
        ? `${(volleyMs / 3_600_000).toFixed(1)}h`
        : `${(volleyMs / 86_400_000).toFixed(1)}d`;
  // Damage per volley to a frigate, time-to-kill estimate
  const ttk = destroyerDmg > 0 ? Math.ceil(frigateHp / destroyerDmg) : Infinity;
  return (
    <div className="vis-card">
      <div className="vis-bar-header">DERIVED</div>
      <div className="vis-card-row">
        <span>Wall-clock per volley</span>
        <strong>{volleyStr}</strong>
      </div>
      <div className="vis-card-row">
        <span>Destroyer-vs-Frigate TTK</span>
        <strong>{Number.isFinite(ttk) ? `${ttk} volleys` : '—'}</strong>
      </div>
      <div className="vis-card-row">
        <span>Frigate full-heal at city</span>
        <strong>{repairPerTick > 0 ? `${Math.ceil(frigateHp / repairPerTick)} ticks` : '—'}</strong>
      </div>
    </div>
  );
};

interface AIPhaseCardProps {
  decisionInterval: number;
  actionBudget: number;
  targetFleet: number;
  expansionTarget: number;
  defenseFloor: number;
  tickIntervalMs: number;
}

/** AI phase summary — explains what triggers each transition. */
const AIPhaseCard: React.FC<AIPhaseCardProps> = ({
  decisionInterval, actionBudget, targetFleet, expansionTarget, defenseFloor, tickIntervalMs,
}) => {
  const wallClock = decisionInterval * tickIntervalMs;
  const wallStr = wallClock < 60_000
    ? `${(wallClock / 1000).toFixed(0)}s`
    : wallClock < 3_600_000
      ? `${(wallClock / 60_000).toFixed(1)}m`
      : `${(wallClock / 3_600_000).toFixed(1)}h`;
  return (
    <div className="vis-card">
      <div className="vis-bar-header">AI PHASE GATES</div>
      <div className="vis-card-row">
        <span style={{ color: '#6ee7b7' }}>EXPANSION</span>
        <strong>colonies &lt; {expansionTarget}</strong>
      </div>
      <div className="vis-card-row">
        <span style={{ color: '#ffb84d' }}>DEFENSE</span>
        <strong>any body has &lt; {defenseFloor} combat ship</strong>
      </div>
      <div className="vis-card-row">
        <span style={{ color: '#ff5e5e' }}>AGGRESSION</span>
        <strong>all defended, fleet → {targetFleet}</strong>
      </div>
      <div className="vis-derived">
        Decision every {decisionInterval} ticks ≈ {wallStr} wall-clock · up to{' '}
        <strong>{actionBudget}</strong> action{actionBudget === 1 ? '' : 's'} per cycle
      </div>
    </div>
  );
};

const YieldSinkDiagram: React.FC<{
  cityM: number;
  cityS: number;
  stationF: number;
  stationS: number;
  popMultPerLevel: number;
  popMax: number;
  harvestInterval: number;
}> = ({ cityM, cityS, stationF, stationS, popMultPerLevel, popMax, harvestInterval }) => (
  <div className="vis-card">
    <div className="vis-caption">
      <strong>Yield biases</strong>
      <span className="vis-caption-dim">
        {' · '}city M×{cityM.toFixed(2)} S×{cityS.toFixed(2)}
        {' · '}station F×{stationF.toFixed(2)} S×{stationS.toFixed(2)}
        {' · '}pop +{(popMultPerLevel * 100).toFixed(0)}%/lvl → max ×{(1 + popMultPerLevel * popMax).toFixed(2)}
        {' · '}harvest every {harvestInterval}t
      </span>
    </div>
  </div>
);

const StarterLoadoutSummary: React.FC<{
  combatShips: number;
  cargoShips: number;
  cityHp: number;
  metal: number;
  fuel: number;
  gold: number;
}> = ({ combatShips, cargoShips, cityHp, metal, fuel, gold }) => (
  <div className="vis-card">
    <div className="vis-caption">
      <strong>Per-faction starter loadout</strong>
      <span className="vis-caption-dim">
        {' · '}{combatShips} combat + {cargoShips} cargo
        {' · '}city HP {cityHp}
        {' · '}pool M{metal} F{fuel} C{gold}
      </span>
    </div>
  </div>
);

// ============================================================
// SVG diagram primitives used by ResourceFlowDiagram and
// DependencyDiagram above. Each component is one positioned
// shape inside the parent <svg>, so the call site fully drives
// layout via x/y/w/h.
// ============================================================

interface FlowNodeProps {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  color: string;
  small?: boolean;
}

const FlowNode: React.FC<FlowNodeProps> = ({ x, y, w, h, title, sub, color, small }) => {
  const titleSize = small ? 8 : 11;
  const subSize = small ? 6 : 8;
  const titleY = sub ? y + h / 2 - 2 : y + h / 2 + titleSize / 3;
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={4}
        fill="rgba(10,14,20,0.6)" stroke={color} strokeWidth={1.5}
      />
      <text
        x={x + w / 2} y={titleY} textAnchor="middle"
        fill={color} fontSize={titleSize} fontWeight={600}
        fontFamily="var(--font-body)"
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2} y={y + h / 2 + subSize + 2} textAnchor="middle"
          fill="#a5b7ca" fontSize={subSize}
          fontFamily="var(--font-body)"
        >
          {sub}
        </text>
      )}
    </g>
  );
};

interface FlowArrowProps {
  x1: number; y1: number; x2: number; y2: number;
  label?: string;
  vertical?: boolean;
  /** Render the arrowhead at the start (x1/y1) instead of the end —
   *  used for feedback loops where the arrow points "back" upstream. */
  reverse?: boolean;
}

const FlowArrow: React.FC<FlowArrowProps> = ({ x1, y1, x2, y2, label, vertical, reverse }) => {
  const ax = reverse ? x1 : x2;
  const ay = reverse ? y1 : y2;
  const lineColor = '#67e8f9';
  const head = vertical
    ? [`${ax - 4},${ay + (reverse ? 6 : -6)}`, `${ax + 4},${ay + (reverse ? 6 : -6)}`]
    : [`${ax + (reverse ? 6 : -6)},${ay - 4}`, `${ax + (reverse ? 6 : -6)},${ay + 4}`];
  const labelX = (x1 + x2) / 2;
  const labelY = (y1 + y2) / 2 - (vertical ? 0 : 6);
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={lineColor} strokeWidth={1.2} opacity={0.7} />
      <polygon points={`${ax},${ay} ${head.join(' ')}`} fill={lineColor} opacity={0.85} />
      {label && (
        <text
          x={labelX} y={labelY} textAnchor="middle"
          fill="#b8c8d6" fontSize={7}
          fontFamily="var(--font-body)"
        >
          {label}
        </text>
      )}
    </g>
  );
};

// ============================================================
// Turn-Based Mode — LIVE settings (unlike the rest of the page,
// these write to a React context that the in-game sim loop reads).
// Persisted to localStorage so a refresh keeps the player in TBM.
//
// SP-only for now. MP needs server-side turn collection (see
// worker/room.js alarm), which is out of scope for this prototype —
// hence the note + the disabled toggle path in TopBar.
// ============================================================
const TurnBasedModeLiveSettings: React.FC = () => {
  const { enabled, ticksPerTurn, setEnabled, setTicksPerTurn } = useTurnBasedSettings();

  return (
    <Section
      eyebrow="LIVE · EXPERIMENTAL"
      title="Turn-Based Mode"
      description="Suspend the realtime sim loop and only advance time when you click COMMIT TURN. Each commit jumps the sim forward by the number of ticks below — long enough for transfers to start firing, short enough that you still get a per-turn pulse. Single-player only; multiplayer would need server-side turn collection."
    >
      <div className="section-grid">
        <div className="section-controls">
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 0',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 18, height: 18, cursor: 'pointer' }}
            />
            <span>
              <strong style={{ color: enabled ? '#ffb84d' : '#d8e4ee' }}>
                {enabled ? 'TURN-BASED MODE: ON' : 'TURN-BASED MODE: OFF'}
              </strong>
              <div style={{ color: '#b8c8d6', fontSize: 10, marginTop: 2 }}>
                {enabled
                  ? 'Realtime is suppressed. Use COMMIT TURN in the top bar.'
                  : 'Game runs in realtime. Toggle on to switch flows.'}
              </div>
            </span>
          </label>

          <Slider
            label="Ticks per turn"
            value={ticksPerTurn}
            min={1}
            max={200}
            step={1}
            onChange={setTicksPerTurn}
            displayValue={`${ticksPerTurn} ticks`}
          />
          <p style={{ color: '#b8c8d6', fontSize: 10, marginTop: 6 }}>
            One tick ≈ a few minutes of in-game time on the default schedule.
            20 ticks ≈ ~2.5 game-hours, enough for short transfers to begin
            and for AI factions to make a couple of decisions.
          </p>
        </div>
        <div
          className="section-visual"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              padding: '24px 28px',
              border: `2px solid ${enabled ? '#ffb84d' : '#2a3d50'}`,
              borderRadius: 6,
              background: enabled ? 'rgba(255, 184, 77, 0.08)' : 'transparent',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: '#b8c8d6' }}>EACH TURN</div>
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: enabled ? '#ffb84d' : '#4a6275',
                margin: '6px 0',
              }}
            >
              +{ticksPerTurn}
            </div>
            <div style={{ fontSize: 10, color: '#b8c8d6' }}>ticks per commit</div>
          </div>
          <div style={{ fontSize: 10, color: '#b8c8d6', textAlign: 'center', maxWidth: 220 }}>
            Plan all your orders, then click <strong>▶ COMMIT TURN</strong> in
            the top bar to resolve them.
          </div>
        </div>
      </div>
    </Section>
  );
};

