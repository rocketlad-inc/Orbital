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
  const {
    gameState, startResearch, cancelResearch,
    enqueueResearch, dequeueResearch, moveResearchUp,
  } = useGameContext();
  const mpActions = useMultiplayerActions();
  // Set of tech ids currently in flight (POSTed but /state hasn't yet
  // reconciled). Prevents the double-click race that fired multiple
  // research requests and made the second one bounce with a stale
  // 409 'insufficient_resources' even though the user saw enough science.
  const [inFlight, setInFlight] = React.useState<Set<TechId>>(new Set());
  const tech = gameState.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
  const queue = tech.queue ?? [];
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

      {/* SP queue strip — MP keeps the single-shot research model and
          hides this block. Shows queued techs as chips with up-arrow
          and × controls so the player can re-order or remove. */}
      {!mpActions && queue.length > 0 && (
        <div
          style={{
            display: 'flex', flexWrap: 'wrap', gap: 6,
            padding: '8px 12px',
            background: 'rgba(78, 205, 196, 0.05)',
            borderBottom: '1px solid #2a3d50',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 10, color: '#8a9fb3', letterSpacing: '0.1em', marginRight: 4 }}>
            QUEUE
          </span>
          {(queue as TechId[]).map((qid, qi) => {
            const qdef = TECH_DEFS[qid];
            const qlvl = tech.levels[qid] ?? 0;
            return (
              <span
                key={qid}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 6px 3px 8px',
                  border: '1px solid #4ecdc4', borderRadius: 4,
                  fontSize: 11, color: '#d8e4ee',
                }}
                title={`${qdef.name} → level ${qlvl + 1}`}
              >
                <span style={{ color: '#8a9fb3', fontSize: 9 }}>{qi + 1}.</span>
                <span>{qdef.icon} {qdef.name}</span>
                {qi > 0 && (
                  <button
                    onClick={() => moveResearchUp(qid)}
                    title="Move up"
                    aria-label="Move up"
                    style={{
                      width: 16, height: 16, padding: 0,
                      background: 'transparent', border: 'none',
                      color: '#4ecdc4', cursor: 'pointer', fontSize: 11,
                    }}
                  >↑</button>
                )}
                <button
                  onClick={() => dequeueResearch(qid)}
                  title="Remove from queue"
                  aria-label="Remove"
                  style={{
                    width: 16, height: 16, padding: 0,
                    background: 'transparent', border: 'none',
                    color: '#ff5e5e', cursor: 'pointer', fontSize: 11,
                  }}
                >×</button>
              </span>
            );
          })}
        </div>
      )}

      <div className="overview-panel__body">
        <div className="tech-grid">
          {ALL_TECH_IDS.map((id) => {
            const def = TECH_DEFS[id];
            const lvl = tech.levels[id] ?? 0;
            const cost = nextLevelCost(lvl, def);
            const isActive = tech.researching === id;
            const queueIndex = queue.indexOf(id);
            const isQueued = queueIndex >= 0;
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

                {/* SP card actions: Research / Cancel / Queue / Remove
                    based on the tech's relationship to the player's
                    current research + queue. MP keeps the single-button
                    instant-research flow. */}
                {mpActions ? (
                  <button
                    className={`tech-card__action ${isActive ? 'active' : ''}`}
                    onClick={async () => {
                      if (inFlight.has(id)) return;
                      if (cost > playerScience) return;
                      setInFlight(prev => new Set(prev).add(id));
                      try {
                        await mpActions.research({ techId: id });
                      } finally {
                        setTimeout(() => {
                          setInFlight(prev => {
                            const next = new Set(prev);
                            next.delete(id);
                            return next;
                          });
                        }, 1800);
                      }
                    }}
                    disabled={inFlight.has(id) || cost > playerScience}
                    title={cost > playerScience
                      ? `Not enough science (need ${cost})`
                      : inFlight.has(id)
                        ? 'Researching…'
                        : `Spend ${cost} science to advance ${def.name}`}
                  >
                    {inFlight.has(id) ? '…' : `Research (${cost} sci)`}
                  </button>
                ) : isActive ? (
                  <button
                    className="tech-card__action active"
                    onClick={cancelResearch}
                    title="Cancel current research (loses progress)"
                  >Cancel</button>
                ) : isQueued ? (
                  <button
                    className="tech-card__action"
                    onClick={() => dequeueResearch(id)}
                    title={`Remove from queue (position ${queueIndex + 1})`}
                    style={{ borderColor: '#ff5e5e', color: '#ff5e5e' }}
                  >Remove (#{queueIndex + 1})</button>
                ) : (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="tech-card__action"
                      onClick={() => startResearch(id)}
                      title={tech.researching
                        ? `Switch focus to ${def.name} (abandons current progress)`
                        : `Start researching ${def.name}`}
                    >Research</button>
                    {tech.researching && (
                      <button
                        className="tech-card__action"
                        onClick={() => enqueueResearch(id)}
                        title={`Queue ${def.name} after current research`}
                        style={{ borderColor: '#4ecdc4', color: '#4ecdc4' }}
                      >+ Queue</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
