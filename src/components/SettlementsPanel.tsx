// ============================================================
// SettlementsPanel — full list of bodies with production & ships
// Stellaris/KSP-style overview. Click a row to focus that body.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { bodyProductionRates } from '../game/economy';
import './OverviewPanel.css';

interface SettlementsPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'owned' | 'occupied' | 'producing';

export const SettlementsPanel: React.FC<SettlementsPanelProps> = ({ onClose }) => {
  const { gameState, selectBody, focusBody, uiState } = useGameContext();
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => {
    return gameState.bodies
      .filter(b => b.type !== 'star') // skip Sol
      .map(body => {
        const shipsHere = gameState.ships.filter(
          s => !s.transfer && s.orbit.parentBodyId === body.id
        );
        const playerShipsHere = shipsHere.filter(s => s.ownedBy === 'player');
        const enemyShipsHere = shipsHere.filter(s => s.ownedBy === 'enemy');
        const freighters = shipsHere.filter(s => s.class === 'freighter' && s.ownedBy === 'player');
        const production = bodyProductionRates(body);
        const harvestMul = freighters.length;
        return {
          body,
          shipsHere,
          playerShipsHere,
          enemyShipsHere,
          freighterCount: freighters.length,
          production: {
            fuel: production.fuel * harvestMul,
            ore: production.ore * harvestMul,
            credits: production.credits * harvestMul,
          },
          potential: production, // 1× rate even without freighter
        };
      })
      .filter(r => {
        if (filter === 'owned') return r.body.ownedBy === 'player';
        if (filter === 'occupied') return r.playerShipsHere.length > 0 || r.body.ownedBy === 'player';
        if (filter === 'producing') return r.freighterCount > 0;
        return true;
      })
      .sort((a, b) => {
        // Owned first, then occupied, then by name
        const aScore = (a.body.ownedBy === 'player' ? 2 : 0) + (a.playerShipsHere.length > 0 ? 1 : 0);
        const bScore = (b.body.ownedBy === 'player' ? 2 : 0) + (b.playerShipsHere.length > 0 ? 1 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return a.body.name.localeCompare(b.body.name);
      });
  }, [gameState.bodies, gameState.ships, filter]);

  const handleRowClick = (bodyId: string) => {
    selectBody(bodyId);
    focusBody(bodyId);
  };

  const ownerBadge = (ownedBy?: string) => {
    if (ownedBy === 'player') return <span className="owner-badge owner-badge--player">Player</span>;
    if (ownedBy === 'enemy') return <span className="owner-badge owner-badge--enemy">Enemy</span>;
    return <span className="owner-badge owner-badge--neutral">Neutral</span>;
  };

  return (
    <div className="overview-panel">
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Settlements</div>
          <div className="overview-panel__title-sub">Production · Holdings · Garrisons</div>
        </div>
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="overview-panel__filters">
        {(['all', 'owned', 'occupied', 'producing'] as Filter[]).map(f => (
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
          <div className="overview-empty">No settlements match the current filter.</div>
        ) : (
          <table className="overview-table">
            <thead>
              <tr>
                <th>Body</th>
                <th>Owner</th>
                <th>Garrison</th>
                <th>Production / tick</th>
                <th className="col-num">Freighters</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isSelected = uiState.selectedBodyId === r.body.id;
                const hasProd = r.potential.fuel > 0 || r.potential.ore > 0 || r.potential.credits > 0;
                return (
                  <tr
                    key={r.body.id}
                    className={isSelected ? 'selected' : ''}
                    onClick={() => handleRowClick(r.body.id)}
                  >
                    <td>
                      <div className="body-cell">
                        <span className="body-cell__icon" style={{ background: r.body.color }} />
                        <div>
                          <div className="body-cell__name">{r.body.name}</div>
                          <div className="body-cell__type">
                            {r.body.type.replace('_', ' ')}{r.body.parent && r.body.parent !== 'sol' ? ` · ${r.body.parent}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>{ownerBadge(r.body.ownedBy)}</td>
                    <td>
                      {r.shipsHere.length === 0 ? (
                        <span className="col-muted">—</span>
                      ) : (
                        <span>
                          {r.playerShipsHere.length > 0 && (
                            <span style={{ color: '#4ecdc4' }}>{r.playerShipsHere.length}P </span>
                          )}
                          {r.enemyShipsHere.length > 0 && (
                            <span style={{ color: '#ff5e5e' }}>{r.enemyShipsHere.length}E</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      {hasProd ? (
                        <div className="prod-rates">
                          <span className={`prod-rate ${r.production.fuel > 0 ? 'prod-rate--fuel' : 'prod-rate--zero'}`}>
                            {r.production.fuel > 0 ? `+${r.production.fuel}` : '—'} fuel
                          </span>
                          <span className={`prod-rate ${r.production.ore > 0 ? 'prod-rate--ore' : 'prod-rate--zero'}`}>
                            {r.production.ore > 0 ? `+${r.production.ore}` : '—'} ore
                          </span>
                          <span className={`prod-rate ${r.production.credits > 0 ? 'prod-rate--credits' : 'prod-rate--zero'}`}>
                            {r.production.credits > 0 ? `+${r.production.credits}` : '—'} CR
                          </span>
                        </div>
                      ) : (
                        <span className="col-muted">no resources</span>
                      )}
                    </td>
                    <td className="col-num">
                      {r.freighterCount > 0 ? r.freighterCount : <span className="col-muted">0</span>}
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
