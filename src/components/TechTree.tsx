// ============================================================
// TechTree — the whole ladder at once.
//
// The research CARDS answer "what does one more level of this track buy
// me". They deliberately show only level+1, because committing science
// is a next-step decision. What they cannot answer is the question a
// player asks once they have a plan: WHERE IS THE THING I WANT, and
// what do I have to walk past to reach it.
//
// So this is the same table read the other way — every track, every
// level, laid out as a grid. Rows are levels because that is the axis
// costs live on: level 5 costs 839 science on any track, so a row is a
// price tier and reading across it is reading what that price buys.
//
// It renders from RESEARCH_UNLOCKS directly rather than from a
// hand-maintained copy. That is the whole design constraint — a tree
// view that lists unlocks separately is a second source of truth, and
// this codebase's recurring bug is two copies of one table drifting.
// ============================================================

import React, { useMemo } from 'react';
import {
  ALL_TECH_IDS, TECH_DEFS, TechId, TECH_MAX_LEVEL, nextLevelCost,
} from '../game/techs';
import { RESEARCH_UNLOCKS, UnlockRow } from '../game/researchUnlocks';
import './TechTree.css';

export type CellState = 'owned' | 'next' | 'locked';

export interface TreeCell {
  track: TechId;
  level: number;
  unlocks: UnlockRow[];
  state: CellState;
}

export interface TreeRow {
  level: number;
  /** Science for THIS level, on any track. */
  cost: number;
  /** True when every track charges the same for this level, which is
   *  what lets the gutter print one number instead of six. */
  uniformCost: boolean;
  cells: TreeCell[];
}

type Levels = Partial<Record<TechId, number>>;

/**
 * The grid, derived from RESEARCH_UNLOCKS. Pure so it can be asserted
 * against the table without rendering.
 */
export function buildTechTree(levels: Levels = {}): TreeRow[] {
  const rows: TreeRow[] = [];
  for (let level = 1; level <= TECH_MAX_LEVEL; level++) {
    const costs = ALL_TECH_IDS.map(t => nextLevelCost(level - 1, TECH_DEFS[t]));
    const cells = ALL_TECH_IDS.map<TreeCell>((track) => {
      const have = levels[track] ?? 0;
      return {
        track,
        level,
        unlocks: RESEARCH_UNLOCKS.filter(u => u.track === track && u.level === level),
        state: level <= have ? 'owned' : level === have + 1 ? 'next' : 'locked',
      };
    });
    rows.push({
      level,
      cost: costs[0],
      uniformCost: costs.every(c => c === costs[0]),
      cells,
    });
  }
  return rows;
}

interface TechTreeProps {
  levels: Levels;
  /** False for grandfathered games, where nothing is actually locked. */
  gatingEnabled: boolean;
  /**
   * MP only. Queue every level between here and this cell. The tree is
   * where a player forms a plan ("I want Convoy Logistics"), so it is
   * where the plan should be actionable — otherwise they read the goal
   * here and then count levels by hand back on the cards.
   */
  onQueuePath?: (track: TechId, level: number) => void;
  /** Level each track reaches once the active project and queue drain. */
  committed?: Partial<Record<TechId, number>>;
}

export const TechTree: React.FC<TechTreeProps> = ({
  levels, gatingEnabled, onQueuePath, committed,
}) => {
  const rows = useMemo(() => buildTechTree(levels), [levels]);

  const { earned, total } = useMemo(() => {
    const t = RESEARCH_UNLOCKS.length;
    const e = RESEARCH_UNLOCKS.filter(u => (levels[u.track] ?? 0) >= u.level).length;
    return { earned: e, total: t };
  }, [levels]);

  // Cumulative science to take one track from nothing to level N. Shown
  // in the gutter tooltip, because the per-level price badly understates
  // what a deep unlock costs: level 10 is 4744, but GETTING there is
  // 16,026.
  const cumulative = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (let l = 1; l <= TECH_MAX_LEVEL; l++) {
      sum += nextLevelCost(l - 1, TECH_DEFS[ALL_TECH_IDS[0]]);
      out.push(sum);
    }
    return out;
  }, []);

  return (
    <div className="techtree">
      <div className="techtree__legend">
        <span className="techtree__sum">{earned} of {total} unlocks earned</span>
        <span className="techtree__key techtree__key--owned">researched</span>
        <span className="techtree__key techtree__key--next">next level</span>
        <span className="techtree__key techtree__key--locked">locked</span>
      </div>

      {!gatingEnabled && (
        <div className="techtree__note">
          This game predates feature gating — everything below is already
          available to you, whatever your level.
        </div>
      )}

      <div className="techtree__scroll">
        <div className="techtree__grid">
          <div className="techtree__corner">Lv</div>
          {ALL_TECH_IDS.map((id) => (
            <div key={id} className="techtree__head" title={TECH_DEFS[id].description}>
              <span className="techtree__head-icon">{TECH_DEFS[id].icon}</span>
              <span className="techtree__head-name">{TECH_DEFS[id].name}</span>
              <span className="techtree__head-lvl">Lv {levels[id] ?? 0}</span>
            </div>
          ))}

          {rows.map(row => (
            <React.Fragment key={row.level}>
              <div
                className="techtree__gutter"
                title={`${row.cost} science for level ${row.level}`
                  + ` · ${cumulative[row.level - 1].toLocaleString()} to take a track this far`}
              >
                <span className="techtree__gutter-lvl">{row.level}</span>
                {row.uniformCost && (
                  <span className="techtree__gutter-cost">{row.cost}</span>
                )}
              </div>

              {row.cells.map((cell) => {
                const empty = cell.unlocks.length === 0;
                // Reachable = not yet owned. Clicking queues the levels
                // in between; a cell already covered by the queue says so
                // rather than offering to queue it twice.
                const onWay = (committed?.[cell.track] ?? 0) >= cell.level;
                const canQueue = !!onQueuePath && cell.state !== 'owned' && !onWay;
                const steps = cell.level - (committed?.[cell.track] ?? levels[cell.track] ?? 0);
                const queueHint = canQueue
                  ? `\n\nClick to queue ${steps} ${TECH_DEFS[cell.track].name} `
                    + `${steps === 1 ? 'level' : 'levels'} and reach this.`
                  : onWay && cell.state !== 'owned'
                    ? '\n\nAlready covered by your research queue.'
                    : '';
                const baseTitle = empty
                  ? `${TECH_DEFS[cell.track].name} ${cell.level}: ${TECH_DEFS[cell.track].effectText}, no new unlock`
                  : cell.unlocks.map(u => `${u.label} — ${u.blurb}`).join('\n\n');
                return (
                  <div
                    key={`${cell.track}-${cell.level}`}
                    className={
                      `techtree__cell techtree__cell--${cell.state}`
                      + (empty ? ' techtree__cell--empty' : '')
                      + (canQueue ? ' techtree__cell--queueable' : '')
                      + (onWay && cell.state !== 'owned' ? ' techtree__cell--onway' : '')
                    }
                    title={baseTitle + queueHint}
                    role={canQueue ? 'button' : undefined}
                    tabIndex={canQueue ? 0 : undefined}
                    onClick={canQueue ? () => onQueuePath!(cell.track, cell.level) : undefined}
                    onKeyDown={canQueue
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onQueuePath!(cell.track, cell.level);
                          }
                        }
                      : undefined}
                  >
                    {empty ? (
                      <span className="techtree__scaling">
                        {TECH_DEFS[cell.track].effectText}
                      </span>
                    ) : (
                      cell.unlocks.map(u => (
                        <span key={u.feature} className="techtree__unlock">
                          {u.label}
                        </span>
                      ))
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="techtree__foot">
        Every level pays its track's passive bonus. Cells showing only a
        percentage are scaling levels — they still make everything you
        already own better.
      </div>
    </div>
  );
};
