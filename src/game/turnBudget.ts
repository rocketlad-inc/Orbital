// ============================================================
// Turn-Based Mode budget summary
//
// Aggregates "what will happen on the next COMMIT TURN" into a single
// digestible shape: planned transfers, in-flight builds, research draw.
// Used by the TopBar to render an at-a-glance summary next to the
// COMMIT TURN button — players see "3 orders queued, -36 fuel" without
// having to open every ship panel and sum mentally.
//
// Pure helper — no React, no I/O. Called every render but the shape is
// small (handful of numbers + counts) so allocation pressure is fine.
// ============================================================

import { GameState } from '../types';
import { TECH_DEFS, TechId } from './techs';

export interface TurnBudgetItem {
  /** Short label, e.g. "3 transfers" or "Frigate at Earth". */
  label: string;
  /** Optional sub-detail shown in smaller text. */
  detail?: string;
}

export interface TurnBudget {
  /** Faction this budget is for. */
  factionId: string;
  /** Resources the faction has right now. */
  pool: { fuel: number; ore: number; credits: number; science: number };
  /** Cost the upcoming turn will draw from `pool` (only items NOT yet
   *  deducted by the reducer — planned transfers, etc.). Builds are
   *  paid at order time so they don't count here. */
  plannedSpend: { fuel: number };
  /** Items that will fire during the next commit. Used to print the
   *  per-line summary under the COMMIT TURN button. */
  plannedItems: TurnBudgetItem[];
  /** In-flight build orders that may complete during the turn jump. */
  buildItems: TurnBudgetItem[];
  /** Current research: id + ticks-to-complete estimate at current rate. */
  research: { techId: TechId | null; progressPct: number } | null;
  /** True if planned spend exceeds the matching pool. Soft warning only —
   *  the player is still allowed to commit (some orders fire over many
   *  ticks and they may earn resources between now and then). */
  overspend: { fuel: boolean };
}

/**
 * Build a faction's turn-budget snapshot for the next COMMIT TURN.
 * @param state Current game state.
 * @param factionId Which faction we're summarizing (usually 'player').
 * @param ticksAhead How far the next commit will jump. Used to estimate
 *                   which build orders will land during the turn.
 */
export function computeTurnBudget(
  state: GameState,
  factionId: string,
  ticksAhead: number,
): TurnBudget {
  const myShips = state.ships.filter(s => s.ownedBy === factionId);
  const myBuilds = state.buildOrders.filter(b => b.ownedBy === factionId);
  const pool = state.resources[factionId] ?? { fuel: 0, ore: 0, credits: 0, science: 0 };

  // === Planned transfers ====================================
  // Each planned order will eventually become a 'committed' burn and
  // burn fuel = round(|deltav| * 10) (matches ShipPanel's commit math).
  // We only count 'planned' status here — 'committed' ones already had
  // their cost reserved when the player clicked COMMIT on the ship panel
  // (well, the cost is actually deducted at firing time in the reducer,
  // but the player has already accepted the spend at plan time).
  let plannedFuel = 0;
  const transferItems: TurnBudgetItem[] = [];
  for (const ship of myShips) {
    for (const order of ship.orders) {
      if (order.status !== 'planned' && order.status !== 'committed') continue;
      if (order.type !== 'transfer') continue;
      const cost = Math.round(Math.abs(order.deltav) * 10);
      plannedFuel += cost;
      transferItems.push({
        label: `${ship.name} → ${order.label?.split('→').pop()?.trim() ?? '?'}`,
        detail: `-${cost} fuel · Δv ${Math.abs(order.deltav).toFixed(2)}`,
      });
    }
  }

  // === Builds in flight ====================================
  // Already paid for, but the player wants to know which ones will
  // complete during the upcoming jump so they can plan around new
  // ships appearing.
  const tickNow = state.currentTick;
  const tickEnd = tickNow + ticksAhead;
  const buildItems: TurnBudgetItem[] = [];
  for (const b of myBuilds) {
    const remaining = Math.max(0, b.completeTick - tickNow);
    const completesThisTurn = b.completeTick <= tickEnd;
    buildItems.push({
      label: `${b.shipName} (${b.shipClass})`,
      detail: completesThisTurn
        ? `LANDS THIS TURN`
        : `T-${remaining.toFixed(0)} ticks`,
    });
  }

  // === Research progress ====================================
  const tech = state.factionTech?.[factionId];
  let research: TurnBudget['research'] = null;
  if (tech?.researching) {
    const techId = tech.researching as TechId;
    const def = TECH_DEFS[techId];
    if (def) {
      const curLevel = tech.levels[techId] ?? 0;
      const cost = Math.ceil(def.baseCost * Math.pow(curLevel + 1, def.costScaling));
      const pct = Math.min(100, Math.max(0, (tech.progress / cost) * 100));
      research = { techId, progressPct: pct };
    }
  }

  const overspend = { fuel: plannedFuel > pool.fuel };

  return {
    factionId,
    pool,
    plannedSpend: { fuel: plannedFuel },
    plannedItems: transferItems,
    buildItems,
    research,
    overspend,
  };
}
