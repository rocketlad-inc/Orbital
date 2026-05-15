// ============================================================
// IntelPanel — Fog-of-war readout
// Summarises what the player's sensors are picking up: enemy ships
// tracked live, stale "last known" sightings, and the sensors doing
// the looking. Reads from VisibilityContext so the canvas and this
// panel always agree.
// ============================================================

import React, { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { useVisibility, GHOST_LIFETIME_TICKS } from '../state/visibilityContext';
import {
  SHIP_SENSOR_RANGE,
  SETTLEMENT_SENSOR_RANGE,
  BURN_SIGNATURE_DURATION,
} from '../game/visibility';
import './OverviewPanel.css';
import './IntelPanel.css';

interface IntelPanelProps {
  onClose: () => void;
}

export const IntelPanel: React.FC<IntelPanelProps> = ({ onClose }) => {
  const { gameState, selectShip } = useGameContext();
  const visibility = useVisibility();
  const tick = gameState.currentTick;

  // --- Sensor inventory (friendly assets contributing to vision) ---
  const sensors = useMemo(() => {
    const ships = gameState.ships.filter(s => s.ownedBy === 'player' && !s.transfer);
    const transitShips = gameState.ships.filter(s => s.ownedBy === 'player' && s.transfer);
    const cities = gameState.settlements.filter(s => s.ownedBy === 'player' && s.type === 'city');
    const stations = gameState.settlements.filter(s => s.ownedBy === 'player' && s.type === 'station');

    // Compute total coverage as a rough indicator (sum of sensor ranges —
    // not real area, just a "how much sky am I watching" number).
    let totalRange = 0;
    for (const s of ships) totalRange += SHIP_SENSOR_RANGE[s.class] ?? 25;
    for (const s of transitShips) totalRange += SHIP_SENSOR_RANGE[s.class] ?? 25;
    totalRange += cities.length * SETTLEMENT_SENSOR_RANGE.city;
    totalRange += stations.length * SETTLEMENT_SENSOR_RANGE.station;

    return {
      ships: ships.length + transitShips.length,
      cities: cities.length,
      stations: stations.length,
      totalRange: Math.round(totalRange),
    };
  }, [gameState.ships, gameState.settlements]);

  // --- Live tracking vs ghost ledger ---
  const intel = useMemo(() => {
    if (!visibility) {
      return { tracked: [], ghosts: [], total: 0 };
    }
    const enemyShips = gameState.ships.filter(s => s.ownedBy !== 'player');
    const tracked = enemyShips.filter(s => visibility.visibleShipIds.has(s.id));
    const ghosts: Array<{
      shipId: string;
      name: string;
      shipClass: string;
      ownedBy: string;
      bodyHint: string;
      ageTicks: number;
    }> = [];

    for (const [shipId, last] of visibility.lastSeen) {
      if (visibility.visibleShipIds.has(shipId)) continue;
      const age = tick - last.tick;
      if (age >= GHOST_LIFETIME_TICKS) continue;
      // Try to find a still-extant ship record (it may have been destroyed —
      // we still show a stale ghost so the player sees their old intel).
      const liveShip = gameState.ships.find(s => s.id === shipId);
      ghosts.push({
        shipId,
        name: liveShip?.name ?? 'unknown',
        shipClass: last.shipClass,
        ownedBy: last.ownedBy,
        bodyHint: liveShip?.transfer
          ? `in transit`
          : (liveShip?.orbit.parentBodyId ?? '?'),
        ageTicks: age,
      });
    }
    ghosts.sort((a, b) => a.ageTicks - b.ageTicks);

    return {
      tracked,
      ghosts,
      total: enemyShips.length,
    };
  }, [visibility, gameState.ships, tick]);

  const factionLookup = useMemo(() => {
    const out: Record<string, { color: string; name: string }> = {};
    for (const f of gameState.factions) out[f.id] = { color: f.color, name: f.name };
    return out;
  }, [gameState.factions]);

  const unknownCount = Math.max(0, intel.total - intel.tracked.length - intel.ghosts.length);

  return (
    <div className="overview-panel intel-panel" role="dialog" aria-label="Intel">
      <header className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">INTEL</div>
          <div className="overview-panel__title-sub">
            FOG-OF-WAR READOUT · TICK T+{Math.floor(tick)}
          </div>
        </div>
        <button className="overview-panel__close" onClick={onClose} title="Close">×</button>
      </header>

      <div className="intel-body">
        {/* === Top stats row === */}
        <div className="intel-stats">
          <StatCard label="Tracked" value={intel.tracked.length} accent="info" />
          <StatCard label="Last Known" value={intel.ghosts.length} accent="warn" />
          <StatCard label="Unknown" value={unknownCount} accent="danger" />
          <StatCard label="Total Hostiles" value={intel.total} accent="dim" />
        </div>

        {/* === Sensors === */}
        <section className="intel-section">
          <div className="intel-section-title">YOUR SENSORS</div>
          <div className="intel-sensors">
            <div className="sensor-row">
              <span className="sensor-icon ship">▸</span>
              <span className="sensor-label">SHIPS</span>
              <span className="sensor-value">{sensors.ships}</span>
            </div>
            <div className="sensor-row">
              <span className="sensor-icon city">■</span>
              <span className="sensor-label">CITIES</span>
              <span className="sensor-value">{sensors.cities}</span>
            </div>
            <div className="sensor-row">
              <span className="sensor-icon station">◆</span>
              <span className="sensor-label">STATIONS</span>
              <span className="sensor-value">{sensors.stations}</span>
            </div>
          </div>
          <div className="intel-sensor-footnote">
            Combined raw range: {sensors.totalRange} u · Press <kbd>V</kbd> to toggle coverage rings on the map
          </div>
        </section>

        {/* === Tracked enemies === */}
        <section className="intel-section">
          <div className="intel-section-title">
            TRACKED <span className="intel-count">({intel.tracked.length})</span>
          </div>
          {intel.tracked.length === 0 && (
            <div className="intel-empty">No hostiles in sensor range.</div>
          )}
          <div className="intel-list">
            {intel.tracked.map(s => {
              const faction = factionLookup[s.ownedBy];
              const burning = s.lastBurnTick !== undefined
                && tick - s.lastBurnTick < BURN_SIGNATURE_DURATION;
              return (
                <button
                  key={s.id}
                  className="intel-entry intel-entry--tracked"
                  onClick={() => selectShip(s.id)}
                >
                  <span className="entry-glyph" style={{ color: faction?.color || '#ff5e5e' }}>▸</span>
                  <span className="entry-main">
                    <span className="entry-name">{s.name}</span>
                    <span className="entry-sub">
                      {s.class.toUpperCase()} · {s.transfer ? 'in transit' : s.orbit.parentBodyId}
                      {burning && <span className="burn-tag"> · BURNING</span>}
                    </span>
                  </span>
                  <span
                    className="entry-faction"
                    style={{ color: faction?.color || '#ff5e5e' }}
                  >
                    {faction?.name.slice(0, 6).toUpperCase() ?? '???'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* === Last-known ghosts === */}
        <section className="intel-section">
          <div className="intel-section-title">
            LAST KNOWN <span className="intel-count">({intel.ghosts.length})</span>
          </div>
          {intel.ghosts.length === 0 && (
            <div className="intel-empty">No stale sightings.</div>
          )}
          <div className="intel-list">
            {intel.ghosts.map(g => {
              const faction = factionLookup[g.ownedBy];
              const freshness = 1 - g.ageTicks / GHOST_LIFETIME_TICKS;
              return (
                <button
                  key={g.shipId}
                  className="intel-entry intel-entry--ghost"
                  onClick={() => selectShip(g.shipId)}
                  style={{ opacity: 0.4 + freshness * 0.6 }}
                >
                  <span className="entry-glyph entry-glyph--dashed" style={{ color: faction?.color || '#6b8195' }}>◌</span>
                  <span className="entry-main">
                    <span className="entry-name">{g.name}</span>
                    <span className="entry-sub">
                      {g.shipClass.toUpperCase()} · last seen @ {g.bodyHint} · T-{g.ageTicks.toFixed(0)}
                    </span>
                  </span>
                  <span
                    className="entry-faction"
                    style={{ color: faction?.color || '#6b8195' }}
                  >
                    {faction?.name.slice(0, 6).toUpperCase() ?? '???'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

// ---- Stat card ----

interface StatCardProps {
  label: string;
  value: number;
  accent: 'info' | 'warn' | 'danger' | 'dim';
}

const StatCard: React.FC<StatCardProps> = ({ label, value, accent }) => (
  <div className={`stat-card stat-card--${accent}`}>
    <div className="stat-card__value">{value}</div>
    <div className="stat-card__label">{label}</div>
  </div>
);
