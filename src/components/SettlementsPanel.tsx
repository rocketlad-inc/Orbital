// ============================================================
// SettlementsPanel — overview of all deployed settlements
// (cities and stations). Shows production, stockpile, HP,
// population, and lets the user jump to any of them.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { settlementYield, SETTLEMENT_DEFS } from '../game/settlements';
import { deriveSecondary } from '../game/colorUtils';
import './OverviewPanel.css';

// Translucent fill from a hex colour, for faction-tinted owner badges.
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface SettlementsPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy' | 'cities' | 'stations';

export const SettlementsPanel: React.FC<SettlementsPanelProps> = ({ onClose }) => {
  const { gameState, selectSettlement, selectBody, focusBody, selectedSettlementId } = useGameContext();
  const [filter, setFilter] = useState<Filter>('player');

  const rows = useMemo(() => {
    return gameState.settlements
      .map(settlement => {
        const body = gameState.bodies.find(b => b.id === settlement.bodyId);
        const ownerFaction = gameState.factions.find(f => f.id === settlement.ownedBy);
        const ownerFreighters = gameState.ships.filter(s =>
          s.ownedBy === settlement.ownedBy &&
          s.class === 'freighter' &&
          !s.transit &&
          s.orbit.parentBodyId === settlement.bodyId
        );
        const yields = body ? settlementYield(settlement, body) : { fuel: 0, ore: 0, credits: 0 };
        return { settlement, body, ownerFaction, ownerFreighters, yields };
      })
      .filter(r => {
        if (filter === 'player') return r.settlement.ownedBy === 'player';
        if (filter === 'enemy') return r.settlement.ownedBy === 'enemy';
        if (filter === 'cities') return r.settlement.type === 'city';
        if (filter === 'stations') return r.settlement.type === 'station';
        return true;
      })
      .sort((a, b) => {
        // Player first, then alphabetically
        const aP = a.settlement.ownedBy === 'player' ? 0 : 1;
        const bP = b.settlement.ownedBy === 'player' ? 0 : 1;
        if (aP !== bP) return aP - bP;
        return a.settlement.name.localeCompare(b.settlement.name);
      });
  }, [gameState.settlements, gameState.bodies, gameState.factions, gameState.ships, filter]);

  const handleRowClick = (settlementId: string, bodyId: string) => {
    selectSettlement(settlementId);
    selectBody(bodyId);
    focusBody(bodyId);
  };

  // Faction id -> display name + two-tone colour (mirrors FleetPanel and
  // the map §5). Fixes the OWNER column showing a raw faction id
  // ("FY2AB2S47DSP:F2") instead of the empire name, and carries the
  // players' colours into the list.
  const factionById = useMemo(() => {
    const m = new Map<string, { name: string; color: string; color2: string }>();
    for (const f of gameState.factions) {
      m.set(f.id, { name: f.name, color: f.color, color2: f.color2 || deriveSecondary(f.color) });
    }
    return m;
  }, [gameState.factions]);

  const factionOf = (ownedBy: string): { name: string; color: string; color2: string } => {
    if (ownedBy === 'player') return { name: 'You', color: '#4ecdc4', color2: deriveSecondary('#4ecdc4') };
    if (ownedBy === 'enemy') return { name: 'Enemy', color: '#ff5e5e', color2: deriveSecondary('#ff5e5e') };
    const f = factionById.get(ownedBy);
    if (f) return f;
    // Unknown id: show the short suffix, never the game-namespaced id.
    return { name: ownedBy.split(':').pop() ?? ownedBy, color: '#8a9fb3', color2: deriveSecondary('#8a9fb3') };
  };

  const ownerBadge = (ownedBy: string) => {
    const { name, color, color2 } = factionOf(ownedBy);
    return (
      <span
        className="owner-badge"
        style={{
          color, borderColor: color, background: hexToRgba(color, 0.12),
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        {/* two-tone swatch: primary / secondary split, same livery as the map */}
        <span
          aria-hidden
          style={{
            width: 10, height: 10, borderRadius: 2, flexShrink: 0,
            background: `linear-gradient(135deg, ${color} 0%, ${color} 62%, ${color2} 62%, ${color2} 100%)`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
          }}
        />
        {name}
      </span>
    );
  };

  const renderHpBar = (s: { hp: number; maxHp: number }) => {
    const ratio = s.hp / s.maxHp;
    const hpClass = ratio > 0.66 ? 'good' : ratio > 0.33 ? 'mid' : 'low';
    return (
      <div className="status-bar">
        <div className="status-bar__fill">
          <div
            className={`status-bar__inner status-bar__inner--hp-${hpClass}`}
            style={{ width: `${Math.max(0, ratio * 100)}%` }}
          />
        </div>
        <span className="status-bar__text">{Math.round(s.hp)}/{s.maxHp}</span>
      </div>
    );
  };

  // Aggregate stats for the player
  const playerStats = useMemo(() => {
    const player = gameState.settlements.filter(s => s.ownedBy === 'player');
    return {
      total: player.length,
      cities: player.filter(s => s.type === 'city').length,
      stations: player.filter(s => s.type === 'station').length,
      totalPop: player.reduce((sum, s) => sum + s.population, 0),
      stockpile: player.reduce(
        (acc, s) => ({
          fuel: acc.fuel + s.stockpile.fuel,
          ore: acc.ore + s.stockpile.ore,
          credits: acc.credits + s.stockpile.credits,
        }),
        { fuel: 0, ore: 0, credits: 0 }
      ),
    };
  }, [gameState.settlements]);

  return (
    <div className="overview-panel">
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Settlements</div>
          <div className="overview-panel__title-sub">
            {playerStats.total} player · {playerStats.cities} cities · {playerStats.stations} stations · pop {playerStats.totalPop}
            {playerStats.total > 0 && (
              <>
                {' · stockpile '}
                <span style={{ color: '#a0a0a0' }}>{Math.floor(playerStats.stockpile.ore)}M</span>
                {' '}
                <span style={{ color: '#ffd700' }}>{Math.floor(playerStats.stockpile.credits)}C</span>
              </>
            )}
          </div>
        </div>
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="overview-panel__filters">
        {(['player', 'enemy', 'cities', 'stations', 'all'] as Filter[]).map(f => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="overview-panel__body">
        {rows.length === 0 ? (
          <div className="overview-empty">
            No settlements match the filter.
            {filter === 'player' && (
              <div style={{ marginTop: 8, fontSize: 10 }}>
                Deploy a city or station from a body's inspector to start a colony.
              </div>
            )}
          </div>
        ) : (
          <table className="overview-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Owner</th>
                <th>Location</th>
                <th>HP</th>
                <th className="col-num">Pop</th>
                <th>Yield / harvest</th>
                <th>Stockpile</th>
                <th className="col-num">Freighters</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ settlement: s, body, ownerFreighters, yields }) => {
                const isSelected = selectedSettlementId === s.id;
                const def = SETTLEMENT_DEFS[s.type];
                const hasStockpile = s.stockpile.ore > 0 || s.stockpile.credits > 0;
                return (
                  <tr
                    key={s.id}
                    className={isSelected ? 'selected' : ''}
                    onClick={() => handleRowClick(s.id, s.bodyId)}
                  >
                    <td>
                      <div className="body-cell">
                        <span
                          className="body-cell__icon"
                          style={{
                            background: body?.color || '#888',
                            borderRadius: s.type === 'city' ? '50%' : '2px',
                          }}
                        />
                        <div>
                          <div className="body-cell__name">{s.name}</div>
                          <div className="body-cell__type">{def.displayName}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge status-badge--${s.type === 'city' ? 'building' : 'orbiting'}`}>
                        {s.type}
                      </span>
                    </td>
                    <td>{ownerBadge(s.ownedBy)}</td>
                    <td>
                      <span className="col-muted">
                        {body?.name || s.bodyId}
                        {body?.parent && body.parent !== 'sol' ? ` · ${body.parent}` : ''}
                      </span>
                    </td>
                    <td>{renderHpBar(s)}</td>
                    <td className="col-num">{s.population}</td>
                    <td>
                      <div className="prod-rates">
                        <span className={`prod-rate ${yields.ore > 0 ? 'prod-rate--ore' : 'prod-rate--zero'}`}>
                          {yields.ore > 0 ? `+${yields.ore.toFixed(1)}` : '—'} metal
                        </span>
                        <span className={`prod-rate ${yields.credits > 0 ? 'prod-rate--credits' : 'prod-rate--zero'}`}>
                          {yields.credits > 0 ? `+${yields.credits.toFixed(1)}` : '—'} CR
                        </span>
                      </div>
                    </td>
                    <td>
                      {hasStockpile ? (
                        <div className="prod-rates">
                          {s.stockpile.ore > 0 && (
                            <span className="prod-rate prod-rate--ore">{Math.floor(s.stockpile.ore)}M</span>
                          )}
                          {s.stockpile.credits > 0 && (
                            <span className="prod-rate prod-rate--credits">{Math.floor(s.stockpile.credits)}C</span>
                          )}
                        </div>
                      ) : (
                        <span className="col-muted">empty</span>
                      )}
                    </td>
                    <td className="col-num">
                      {ownerFreighters.length > 0 ? (
                        <span style={{ color: '#4ecdc4' }}>{ownerFreighters.length}</span>
                      ) : (
                        <span className="col-muted">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
