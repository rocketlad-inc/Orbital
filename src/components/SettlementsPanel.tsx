// ============================================================
// SettlementsPanel — overview of all deployed settlements
// (cities and stations). Shows production, stockpile, HP,
// population, and lets the user jump to any of them.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { settlementYield, SETTLEMENT_DEFS } from '../game/settlements';
import './OverviewPanel.css';

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

  const ownerBadge = (ownedBy: string) => {
    if (ownedBy === 'player') return <span className="owner-badge owner-badge--player">Player</span>;
    if (ownedBy === 'enemy') return <span className="owner-badge owner-badge--enemy">Enemy</span>;
    return <span className="owner-badge owner-badge--neutral">{ownedBy}</span>;
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
                <span style={{ color: '#ffb84d' }}>{Math.floor(playerStats.stockpile.fuel)}F</span>
                {' '}
                <span style={{ color: '#a0a0a0' }}>{Math.floor(playerStats.stockpile.ore)}O</span>
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
                const hasStockpile = s.stockpile.fuel > 0 || s.stockpile.ore > 0 || s.stockpile.credits > 0;
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
                        <span className={`prod-rate ${yields.fuel > 0 ? 'prod-rate--fuel' : 'prod-rate--zero'}`}>
                          {yields.fuel > 0 ? `+${yields.fuel.toFixed(1)}` : '—'} fuel
                        </span>
                        <span className={`prod-rate ${yields.ore > 0 ? 'prod-rate--ore' : 'prod-rate--zero'}`}>
                          {yields.ore > 0 ? `+${yields.ore.toFixed(1)}` : '—'} ore
                        </span>
                        <span className={`prod-rate ${yields.credits > 0 ? 'prod-rate--credits' : 'prod-rate--zero'}`}>
                          {yields.credits > 0 ? `+${yields.credits.toFixed(1)}` : '—'} CR
                        </span>
                      </div>
                    </td>
                    <td>
                      {hasStockpile ? (
                        <div className="prod-rates">
                          {s.stockpile.fuel > 0 && (
                            <span className="prod-rate prod-rate--fuel">{Math.floor(s.stockpile.fuel)}F</span>
                          )}
                          {s.stockpile.ore > 0 && (
                            <span className="prod-rate prod-rate--ore">{Math.floor(s.stockpile.ore)}O</span>
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
