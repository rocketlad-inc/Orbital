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
 *  migrates to the ORBIT column so the capability is never lost.
 *
 *  THIS is the list that decides what a multiplayer player can build.
 *  Not BUILDING_DEFS, and not BodyInspector's CITY_BUILDINGS — that
 *  component only renders when isMultiplayer is false or the world-menu
 *  kill-switch is off, so in practice nobody sees it. A building can be
 *  fully wired server-side, costed, gated, migrated and tested, and
 *  still be unbuildable because it is missing from this array. Orbital
 *  Shields shipped that way twice: once missing from CITY_BUILDINGS,
 *  and once "fixed" by adding it there instead of here.
 *
 *  Surface holds at most 4 entries — WorldMenuOverlay's COL_MAX_H
 *  budgets the column at 4 buttons. A 5th needs that constant raised. */
export function columnsFor(body: Pick<Body, 'type'>): {
  surface: BuildingKind[];
  orbit: BuildingKind[];
} {
  if (canHostCity(body as Body)) {
    // lab is hostType 'any' server-side — stations research too.
    return {
      // THIS LIST IS THE BUILD MENU. A building defined in
      // BUILDING_DEFS but missing here is fully implemented, costed,
      // researched — and unreachable, because nothing renders a button
      // for it. That is how trajectory_thrusters sat unbuildable across
      // every game ever played, and it is exactly how the telescope
      // behaved for its first hours: defined, gated, tested, invisible.
      // ADD NEW BUILDINGS HERE OR THEY DO NOT EXIST.
      // SHIELDS STAY ON THE GROUND. They were moved to the station for
      // about an hour on 2026-08-16 and moved back: stations already die
      // before cities, so a station-hosted pool is gone before the city
      // it was bought to protect is even threatened. The TELESCOPE takes
      // orbit instead — passive infrastructure, so losing it first costs
      // vision rather than a defence — which also keeps surface at the
      // four buttons COL_MAX_H budgets.
      surface: ['forge', 'mint', 'lab', 'shields'],
      orbit: ['weapons', 'shipyard', 'lab', 'telescope'],
    };
  }
  // No surface: shields go with it. The pool protects a city's
  // structure, and a body that can't host a city has none to protect.
  //
  // ASTEROIDS ALSO GET TRAJECTORY THRUSTERS, the building that unlocks
  // the RAM action. It is station-hosted (a colony ship drops a station
  // on a rock; a city was impossible once terraforming gated cities on
  // terraformed worlds and left asteroids un-terraformable) and
  // server-side buildingAllowedAt already restricts it to
  // body.type === 'asteroid', so this mirrors that gate rather than
  // inventing a second one.
  //
  // It was missing here, which is the whole reason ZERO thrusters and
  // zero rams exist in the game's entire history: the card was added to
  // BodyInspector's list, and BodyInspector is the SP / kill-switch
  // panel that multiplayer never renders. Precisely the failure this
  // file's header warns about, and the second time this exact building
  // has been fixed into the wrong array.
  //
  // Orbit goes 3 -> 4 for asteroids only, which is exactly COL_MAX_H's
  // four-button budget. A fifth entry here needs that constant raised.
  if (body.type === 'asteroid') {
    return { surface: [], orbit: ['weapons', 'shipyard', 'lab', 'trajectory_thrusters'] };
  }
  return { surface: [], orbit: ['weapons', 'shipyard', 'lab'] };
}

/** Compact cost string for the next level of a building. */
export function costText(kind: BuildingKind, currentLevel: number): string {
  const c = buildingCostForNextLevel(kind, currentLevel);
  const parts: string[] = [];
  // Display sweep: the resource is METAL everywhere players see it —
  // `ore` survives only as the internal field name.
  if (c.ore) parts.push(`${c.ore} metal`);
  if (c.credits) parts.push(`${c.credits} cr`);
  if (c.fuel) parts.push(`${c.fuel} fuel`);
  return parts.join(' + ') || 'free';
}

export type BuildStatus =
  | { state: 'no-host'; text: string }
  | { state: 'queued'; level: number; targetLevel: number; ticksLeft: number; text: string }
  // Waiting behind the active build. `position` is 1-based: 1 = next up.
  // No countdown, because when it starts depends on what's ahead of it.
  | { state: 'backlogged'; level: number; targetLevel: number; position: number; text: string }
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
  // Queued behind the active build. A kind can appear more than once
  // (Forge L2 then L3); the FIRST occurrence is the one we label, since
  // that is the next one of this kind to land.
  const backlog = settlement.buildingBacklog ?? [];
  const at = backlog.findIndex(o => o.kind === kind);
  if (at >= 0) {
    return {
      state: 'backlogged',
      level,
      targetLevel: backlog[at].targetLevel,
      position: at + 1,
      text: `queued #${at + 1} · LV ${backlog[at].targetLevel}`,
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
