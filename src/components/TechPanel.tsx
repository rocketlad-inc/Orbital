// ============================================================
// TechPanel — Neptune's Pride / Stellaris repeatables tech tree.
//
// Six tracks, each with infinite levels. Click a track to queue
// research; science drains automatically each tick. Modifiers
// scale linearly per level, costs scale super-linearly.
// ============================================================

import React, { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  ALL_TECH_IDS, TECH_DEFS, TechId,
  effectAtLevel, nextLevelCost,
} from '../game/techs';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import './OverviewPanel.css';
import './TechPanel.css';

interface TechPanelProps {
  onClose: () => void;
}

export const TechPanel: React.FC<TechPanelProps> = ({ onClose }) => {
  const { gameState, startResearch, cancelResearch } = useGameContext();
  const mpActions = useMultiplayerActions();
  const tech = gameState.factionTech.player ?? { levels: {}, researching: null, progress: 0 };
  const playerScience = gameState.resources.player?.science ?? 0;

  // Total level count across all techs (a vanity stat shown in subtitle).
  const totalLevels = useMemo(
    () => Object.values(tech.levels).reduce((s, n) => s + (n ?? 0), 0),
    [tech.levels],
  );

  const activeDef = tech.researching ? TECH_DEFS[tech.researching as TechId] : null;
  const activeLevel = tech.researching ? (tech.levels[tech.researching as TechId] ?? 0) : 0;
  const activeCost = activeDef ? nextLevelCost(activeLevel, activeDef) : 0;
  const activePct = activeCost > 0 ? Math.min(100, (tech.progress / activeCost) * 100) : 0;

  return (
    <div className="overview-panel">
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Research</div>
          <div className="overview-panel__title-sub">
            {totalLevels} levels researched · {Math.floor(playerScience)} science available
            {activeDef && (
              <> · researching <span style={{ color: '#6ee7b7' }}>{activeDef.name} {activeLevel + 1}</span></>
            )}
          </div>
        </div>
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      {activeDef && (
        <div className="tech-active">
          <div className="tech-active__row">
            <div className="tech-active__icon">{activeDef.icon}</div>
            <div className="tech-active__info">
              <div className="tech-active__name">
                {activeDef.name} <span className="tech-active__lvl">→ level {activeLevel + 1}</span>
              </div>
              <div className="tech-active__effect">
                Next: {activeDef.effectText} (total +{((activeLevel + 1) * activeDef.perLevel * 100).toFixed(0)}%)
              </div>
              <div className="tech-active__bar">
                <div className="tech-active__bar-fill" style={{ width: `${activePct}%` }} />
              </div>
              <div className="tech-active__bar-text">
                {Math.floor(tech.progress)} / {activeCost} science · {Math.floor(activePct)}%
              </div>
            </div>
            <button
              className="tech-active__cancel"
              onClick={cancelResearch}
              title="Cancel research (loses progress)"
            >Cancel</button>
          </div>
        </div>
      )}

      <div className="overview-panel__body">
        <div className="tech-grid">
          {ALL_TECH_IDS.map((id) => {
            const def = TECH_DEFS[id];
            const lvl = tech.levels[id] ?? 0;
            const cost = nextLevelCost(lvl, def);
            const isActive = tech.researching === id;
            const isQueued = !!tech.researching && !isActive;
            return (
              <div
                key={id}
                className={`tech-card ${isActive ? 'active' : ''}`}
              >
                <div className="tech-card__head">
                  <div className="tech-card__icon">{def.icon}</div>
                  <div className="tech-card__name">{def.name}</div>
                  <div className="tech-card__level">Lv {lvl}</div>
                </div>
                <div className="tech-card__desc">{def.description}</div>

                <div className="tech-card__effect">
                  <div className="tech-card__effect-label">Per level</div>
                  <div className="tech-card__effect-value">{def.effectText}</div>
                </div>

                <div className="tech-card__effect">
                  <div className="tech-card__effect-label">Current</div>
                  <div className="tech-card__effect-value">
                    {lvl === 0 ? (
                      <span style={{ color: '#6b8195' }}>no bonus</span>
                    ) : (
                      <span style={{ color: '#6ee7b7' }}>
                        +{(effectAtLevel(def, lvl) * 100).toFixed(0)}% effect
                      </span>
                    )}
                  </div>
                </div>

                <div className="tech-card__cost">
                  <span style={{ color: '#6b8195' }}>Lv {lvl + 1} cost</span>
                  <span style={{ color: cost <= playerScience ? '#6ee7b7' : '#ffb84d' }}>
                    {cost} sci
                  </span>
                </div>

                <button
                  className={`tech-card__action ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    if (mpActions) {
                      // Multiplayer: instant repeatables. Server is the
                      // authority on cost and current level — the local
                      // call also fires to keep single-player happy and
                      // give optimistic feedback while /state catches up.
                      mpActions.research({ techId: id });
                      return;
                    }
                    if (isActive) cancelResearch();
                    else startResearch(id);
                  }}
                  disabled={!mpActions && (isQueued && !isActive)}
                  title={
                    mpActions
                      ? `Spend ${cost} science to advance ${TECH_DEFS[id].name}`
                      : isQueued ? 'Cancel current research first' : (isActive ? 'Cancel research' : 'Research this tech next')
                  }
                >
                  {mpActions
                    ? `Research (${cost} sci)`
                    : isActive ? 'Researching…' : isQueued ? 'Queue full' : 'Research'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
