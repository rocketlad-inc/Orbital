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
  // Set of tech ids currently in flight (POSTed but /state hasn't yet
  // reconciled). Prevents the double-click race that fired multiple
  // research requests and made the second one bounce with a stale
  // 409 'insufficient_resources' even though the user saw enough science.
  const [inFlight, setInFlight] = React.useState<Set<TechId>>(new Set());
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
                      <span style={{ color: '#8a9fb3' }}>no bonus</span>
                    ) : (
                      <span style={{ color: '#6ee7b7' }}>
                        +{(effectAtLevel(def, lvl) * 100).toFixed(0)}% effect
                      </span>
                    )}
                  </div>
                </div>

                <div className="tech-card__cost">
                  <span style={{ color: '#8a9fb3' }}>Lv {lvl + 1} cost</span>
                  <span style={{ color: cost <= playerScience ? '#6ee7b7' : '#ffb84d' }}>
                    {cost} sci
                  </span>
                </div>

                <button
                  className={`tech-card__action ${isActive ? 'active' : ''}`}
                  onClick={async () => {
                    if (mpActions) {
                      // Multiplayer: instant repeatables. Server is the
                      // authority on cost and current level.
                      //
                      // Guard against double-click: track in-flight techIds
                      // in a Set, refuse to fire a second request for the
                      // same tech until /state has reconciled (the await
                      // returns then the polling interval kicks in).
                      if (inFlight.has(id)) return;
                      // Belt-and-suspenders science check using whatever
                      // /state most recently delivered. Avoids the round
                      // trip when we already know it'll 409.
                      if (cost > playerScience) return;
                      setInFlight(prev => new Set(prev).add(id));
                      try {
                        await mpActions.research({ techId: id });
                      } finally {
                        // Brief delay so the next /state poll (1.5s) lands
                        // before we let another click through — otherwise a
                        // fast clicker would burn through stale science.
                        setTimeout(() => {
                          setInFlight(prev => {
                            const next = new Set(prev);
                            next.delete(id);
                            return next;
                          });
                        }, 1800);
                      }
                      return;
                    }
                    if (isActive) cancelResearch();
                    else startResearch(id);
                  }}
                  disabled={
                    (!mpActions && isQueued && !isActive)
                    || (!!mpActions && (inFlight.has(id) || cost > playerScience))
                  }
                  title={
                    mpActions
                      ? (cost > playerScience
                        ? `Not enough science (need ${cost})`
                        : inFlight.has(id)
                          ? 'Researching…'
                          : `Spend ${cost} science to advance ${TECH_DEFS[id].name}`)
                      : isQueued ? 'Cancel current research first' : (isActive ? 'Cancel research' : 'Research this tech next')
                  }
                >
                  {mpActions
                    ? (inFlight.has(id) ? '…' : `Research (${cost} sci)`)
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
