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
  TECH_MAX_LEVEL,
} from '../game/techs';
import { unlocksAt } from '../game/researchUnlocks';
import { computeIncomePerTick } from '../game/settlements';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
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
  // Server-side research rejection shown as a banner at the top of
  // the tech list. Without this the button just flickers from "…" to
  // the un-clicked state when the server returns 409 tech_maxed or
  // 409 insufficient_resources, with no explanation.
  const [researchError, setResearchError] = React.useState<string | null>(null);
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

  // Science actually REACHING the pool each tick. Research advances at
  // exactly this rate (worker/room.js research drain), so it's what the
  // ETA must be computed from — not the banked pool, which can't be
  // spent to rush a project.
  const scienceRate = useMemo(() => {
    const lvl = tech.levels?.industry ?? 0;
    const yieldMul = 1 + TECH_DEFS.industry.perLevel * lvl;
    try {
      return computeIncomePerTick(
        'player', gameState.settlements, gameState.bodies, gameState.ships, yieldMul,
      ).delivered.science;
    } catch { return 0; }
  }, [gameState.settlements, gameState.bodies, gameState.ships, tech.levels]);

  /** Ticks until the active level completes at the current income rate.
   *  null when there's no project or no income (the caller renders a
   *  "stalled" note instead of a misleading Infinity). */
  const etaTicks = useMemo(() => {
    if (!activeDef || activeCost <= 0) return null;
    const remaining = activeCost - tech.progress;
    if (remaining <= 0) return 0;
    if (scienceRate <= 0) return null;
    return Math.ceil(remaining / scienceRate);
  }, [activeDef, activeCost, tech.progress, scienceRate]);

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
                {etaTicks != null && (
                  <span style={{ color: '#6ee7b7', marginLeft: 6 }}>
                    · done in {etaTicks} tick{etaTicks === 1 ? '' : 's'}
                  </span>
                )}
                {etaTicks == null && scienceRate <= 0 && (
                  <span style={{ color: '#ff5e5e', marginLeft: 6 }}>
                    · stalled — no science income
                  </span>
                )}
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
          <span style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.1em', marginRight: 4 }}>
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
                <span style={{ color: '#b8c8d6', fontSize: 9 }}>{qi + 1}.</span>
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

      {researchError && (
        // MP server rejected the research spend (tech_maxed or
        // insufficient_resources, usually). Surface inline rather than
        // letting the button silently flicker back to its idle state.
        <button
          onClick={() => setResearchError(null)}
          style={{
            margin: '8px 12px 0', padding: '6px 10px',
            background: 'rgba(255, 94, 94, 0.1)',
            border: '1px solid #ff5e5e', borderRadius: 4,
            color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
            fontFamily: 'inherit', textAlign: 'left',
            cursor: 'pointer',
            // The panel body uses width 100% so this banner needs the
            // same accounting (margin already provides side padding).
            width: 'calc(100% - 24px)',
          }}
          title="Click to dismiss"
        >⚠ {researchError}</button>
      )}

      <div className="overview-panel__body">
        <div className="tech-grid">
          {ALL_TECH_IDS.map((id) => {
            const def = TECH_DEFS[id];
            const lvl = tech.levels[id] ?? 0;
            const isMaxed = lvl >= TECH_MAX_LEVEL;
            const cost = nextLevelCost(lvl, def);
            const isActive = tech.researching === id;
            // Fill % of the committed project — the science income poured
            // in so far vs what this level costs.
            const progressPct = isActive && cost > 0
              ? Math.min(100, Math.floor((tech.progress / cost) * 100))
              : 0;
            const queueIndex = queue.indexOf(id);
            const isQueued = queueIndex >= 0;
            return (
              <div
                key={id}
                className={`tech-card ${isActive ? 'active' : ''} ${isMaxed ? 'maxed' : ''}`}
              >
                <div className="tech-card__head">
                  <div className="tech-card__icon">{def.icon}</div>
                  <div className="tech-card__name">{def.name}</div>
                  <div className="tech-card__level">
                    {isMaxed ? `MAX ${TECH_MAX_LEVEL}` : `Lv ${lvl}`}
                  </div>
                </div>
                <div className="tech-card__desc">{def.description}</div>

                <div className="tech-card__effect">
                  <div className="tech-card__effect-label">Per level</div>
                  <div className="tech-card__effect-value">{def.effectText}</div>
                </div>

                {/* What the NEXT level actually gives you. This is the
                    whole point of the gated rollout: a track has to
                    advertise its reward before you commit science to it,
                    or picking research is a blind guess. Levels past the
                    unlock rungs are pure scaling and say so. */}
                {!isMaxed && (
                  <div className="tech-card__effect">
                    <div className="tech-card__effect-label">Lv {lvl + 1} unlocks</div>
                    <div className="tech-card__effect-value">
                      {(() => {
                        const next = unlocksAt(id, lvl + 1);
                        if (next.length === 0) {
                          return <span style={{ color: '#b8c8d6' }}>scaling only</span>;
                        }
                        return (
                          <span style={{ color: '#ffb84d' }} title={next.map(u => u.blurb).join(' · ')}>
                            {next.map(u => u.label).join(', ')}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                )}

                <div className="tech-card__effect">
                  <div className="tech-card__effect-label">Current</div>
                  <div className="tech-card__effect-value">
                    {lvl === 0 ? (
                      <span style={{ color: '#b8c8d6' }}>no bonus</span>
                    ) : (
                      <span style={{ color: '#6ee7b7' }}>
                        +{(effectAtLevel(def, lvl) * 100).toFixed(0)}% effect
                      </span>
                    )}
                  </div>
                </div>

                <div className="tech-card__cost">
                  {isMaxed ? (
                    <>
                      <span style={{ color: '#b8c8d6' }}>Max level reached</span>
                      <span style={{ color: '#ffb84d' }}>—</span>
                    </>
                  ) : (
                    <>
                      <span style={{ color: '#b8c8d6' }}>Lv {lvl + 1} cost</span>
                      <span style={{ color: cost <= playerScience ? '#6ee7b7' : '#ffb84d' }}>
                        {cost} sci
                      </span>
                    </>
                  )}
                </div>

                {/* SP card actions: Research / Cancel / Queue / Remove
                    based on the tech's relationship to the player's
                    current research + queue. MP keeps the single-button
                    instant-research flow. Maxed techs short-circuit to
                    an inert "MAXED" pill — no further research possible. */}
                {isMaxed ? (
                  <div
                    className="tech-card__action"
                    style={{
                      color: '#ffb84d',
                      borderColor: '#ffb84d',
                      background: 'rgba(255, 184, 77, 0.08)',
                      textAlign: 'center',
                      cursor: 'default',
                    }}
                    title="This tech has reached the global cap."
                  >★ MAXED</div>
                ) : mpActions ? (
                  <button
                    className={`tech-card__action ${isActive ? 'active' : ''}`}
                    onClick={async () => {
                      if (inFlight.has(id)) return;
                      // No affordability gate any more: committing to a
                      // project is free. Science income fills it over
                      // the following ticks (server-side drain).
                      setInFlight(prev => new Set(prev).add(id));
                      setResearchError(null);
                      try {
                        const res = await mpActions.research({ techId: id });
                        if (!res.ok) {
                          setResearchError(humanizeMpError(res.code, res.error, 'research'));
                        }
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
                    disabled={inFlight.has(id)}
                    title={isActive
                      ? `Currently researching ${def.name} — ${progressPct}% of ${cost} science`
                      : `Commit to ${def.name}. Your science income fills it each tick (${cost} science needed).`}
                  >
                    {inFlight.has(id)
                      ? '…'
                      : isActive
                        ? `Researching · ${progressPct}%`
                        : scienceRate > 0
                          ? `Set project · ${Math.ceil(cost / scienceRate)}t`
                          : `Set project (${cost} sci)`}
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
