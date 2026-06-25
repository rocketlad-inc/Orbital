// ============================================================
// VictoryOverlay — renders when GameState.status === 'completed'.
// Shows the winning faction, the victory type, and a button to
// return to the setup screen for a new campaign.
// ============================================================

import React from 'react';
import { useGameContext } from '../state/gameContext';
import './VictoryOverlay.css';

interface Props {
  onNewGame: () => void;
}

const VICTORY_LABEL: Record<string, string> = {
  engineering: 'ENGINEERING VICTORY',
  military:    'MILITARY VICTORY',
  science:     'SCIENCE VICTORY',
  chancellor:  'POLITICAL VICTORY',
  // Legacy types kept for back-compat with old replays.
  hegemony: 'HEGEMONY VICTORY',
  wealth:   'ECONOMIC VICTORY',
  tiebreak: 'TIEBREAK VICTORY',
};

const VICTORY_BLURB: Record<string, string> = {
  engineering: 'completed the Sol Dyson Sphere',
  military:    'eliminated every rival empire',
  science:     'mastered every tech track',
  chancellor:  'was elected Supreme Chancellor by a majority of the Senate',
  // Legacy types kept for back-compat with old replays.
  hegemony: 'controls the most worlds at game end',
  wealth:   'amassed the greatest wealth at game end',
  tiebreak: 'won on slot tiebreaker',
};

export const VictoryOverlay: React.FC<Props> = ({ onNewGame }) => {
  const { gameState } = useGameContext();

  if (gameState.status !== 'completed') return null;

  const winner = gameState.factions.find(f => f.id === gameState.winnerFactionId);
  const victoryType = gameState.victoryType ?? 'hegemony';
  const playerWon = gameState.winnerFactionId === 'player';

  // Per-faction stats so the player can see how things shook out
  const stats = gameState.factions.map(f => {
    const ownedBodies = new Set<string>();
    for (const s of gameState.settlements) {
      if (s.ownedBy === f.id) ownedBodies.add(s.bodyId);
    }
    const res = gameState.resources[f.id];
    const wealth = res ? res.fuel + res.ore + res.credits + res.science : 0;
    const ships = gameState.ships.filter(sh => sh.ownedBy === f.id).length;
    return {
      faction: f,
      bodies: ownedBodies.size,
      wealth: Math.round(wealth),
      ships,
      isWinner: f.id === gameState.winnerFactionId,
    };
  });

  stats.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    if (a.bodies !== b.bodies) return b.bodies - a.bodies;
    return b.wealth - a.wealth;
  });

  return (
    <div className="victory-overlay">
      <div className="victory-card">
        <div className={`victory-banner ${playerWon ? 'won' : 'lost'}`}>
          {playerWon ? 'VICTORY' : 'GAME OVER'}
        </div>

        <div className="victory-winner">
          <div className="victory-winner-eyebrow">{VICTORY_LABEL[victoryType]}</div>
          <div
            className="victory-winner-name"
            style={{ color: winner?.color ?? '#d8e4ee' }}
          >
            {winner?.name ?? 'Unknown'}
          </div>
          <div className="victory-winner-blurb">{VICTORY_BLURB[victoryType]}</div>
        </div>

        <div className="victory-stats">
          <div className="victory-stats-head">
            <span>FACTION</span>
            <span>BODIES</span>
            <span>SHIPS</span>
            <span>WEALTH</span>
          </div>
          {stats.map(s => (
            <div
              key={s.faction.id}
              className={`victory-stat-row ${s.isWinner ? 'is-winner' : ''}`}
            >
              <span
                className="victory-stat-name"
                style={{ color: s.faction.color }}
              >
                {s.isWinner && '◆ '}
                {s.faction.name}
              </span>
              <span className="victory-stat-num">{s.bodies}</span>
              <span className="victory-stat-num">{s.ships}</span>
              <span className="victory-stat-num">{s.wealth}</span>
            </div>
          ))}
        </div>

        <div className="victory-footer">
          <div className="victory-footer-meta">
            Match ended at T+{Math.floor(gameState.currentTick)}
          </div>
          <button className="victory-button" onClick={onNewGame}>
            ▶ NEW CAMPAIGN
          </button>
        </div>
      </div>
    </div>
  );
};
