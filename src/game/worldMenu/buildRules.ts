// ============================================================
// World-menu build rules — MULTIPLAYER ONLY display layer.
//
// Thin, pure presentation logic over the game's existing settlement
// rules (canHostCity, buildingLevel, buildingCostForNextLevel…).
// Nothing here re-implements game logic: the menu asks the same
// questions BodyInspector/BuildPanel already ask, and only decides
// how to arrange and word the answers.
// ============================================================

import { Body, BuildingKind, Settlement } from '../../types';
import {
  buildingCostForNextLevel,
  buildingLevel,
  canHostCity,
} from '../settlements';

/** The build columns the menu shows. Lab is hostType 'any' in
 *  BUILDING_DEFS — on a surface-capable world it lives in the SURFACE
 *  column (city socket); on a no-surface world (gas giant, star) it
 *  migrates to the ORBIT column so the capability is never lost. */
export function columnsFor(body: Pick<Body, 'type'>): {
  surface: BuildingKind[];
  orbit: BuildingKind[];
} {
  if (canHostCity(body as Body)) {
    return { surface: ['forge', 'mint', 'lab'], orbit: ['weapons', 'shipyard'] };
  }
  return { surface: [], orbit: ['weapons', 'shipyard', 'lab'] };
}

/** Compact cost string for the next level of a building. */
export function costText(kind: BuildingKind, currentLevel: number): string {
  const c = buildingCostForNextLevel(kind, currentLevel);
  const parts: string[] = [];
  if (c.ore) parts.push(`${c.ore} ore`);
  if (c.credits) parts.push(`${c.credits} cr`);
  if (c.fuel) parts.push(`${c.fuel} fuel`);
  return parts.join(' + ') || 'free';
}

export type BuildStatus =
  | { state: 'no-host'; text: string }
  | { state: 'queued'; level: number; targetLevel: number; ticksLeft: number; text: string }
  | { state: 'ready'; level: number; text: string };

/**
 * Status for one build button.
 *   settlement = the socket this building lives in (city or station at
 *   the focused body, owned by the viewer), or null when none exists.
 */
export function buildStatus(
  kind: BuildingKind,
  settlement: Settlement | null,
  opts: { currentTick: number; noHostText: string },
): BuildStatus {
  if (!settlement) {
    return { state: 'no-host', text: opts.noHostText };
  }
  const level = buildingLevel(settlement, kind);
  const q = settlement.buildingQueue;
  if (q && q.kind === kind) {
    const ticksLeft = Math.max(0, q.completeTick - opts.currentTick);
    return {
      state: 'queued',
      level,
      targetLevel: q.targetLevel,
      ticksLeft,
      text: `building LV ${q.targetLevel} · T-${ticksLeft}`,
    };
  }
  if (level === 0) {
    return { state: 'ready', level, text: `not built · ${costText(kind, 0)}` };
  }
  return { state: 'ready', level, text: `LV ${level} ↑ · ${costText(kind, level)}` };
}

/** The lock wording when a column has no socket to build into. */
export function noHostText(column: 'surface' | 'orbit', body: Pick<Body, 'type'>): string {
  if (column === 'surface') {
    return canHostCity(body as Body) ? 'no city yet' : 'no surface';
  }
  return 'no station yet';
}
