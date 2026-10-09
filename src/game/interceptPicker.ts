// ============================================================
// The intercept picker's rules — grouping, standing and the radar
// layout — kept out of the panels so the ship panel, the group bar and
// the map overlay all read one answer.
//
// WHY GROUP AT ALL. A live board offered "33 reachable" that were three
// fleets: one row per hull buried the one fleet you were at war with
// among nineteen allied ships. A fleet flies as one unit, and loose hulls
// of one empire bound for the same world on the same tick arrive as one
// unit, so the picker lists the unit.
// ============================================================

import type { Fleet, Ship } from '../types';
import { makePeaceCheck } from './peace';

export type Standing = 'war' | 'allied' | 'peace' | 'yours';

/** Who a hull belongs to, in the game's own diplomacy terms: the same
 *  allies the map treats as friendly, and war only where one is declared. */
export function standingOf(
  ownerId: string,
  alliedFactionIds?: readonly string[],
  warPairs?: readonly string[],
): Standing {
  if (ownerId === 'player') return 'yours';
  if (alliedFactionIds?.includes(ownerId)) return 'allied';
  return makePeaceCheck(warPairs)('player', ownerId) ? 'peace' : 'war';
}

export interface FlightGroup {
  /** 'fleet:<id>' or 'loose:<owner>|<destination>|<arrival tick>'. */
  key: string;
  /** The hull the group is solved and drawn from: the fleet's lead, else
   *  the one with a captain, else the first by name. */
  lead: Ship;
  members: Ship[];
  fleet: Fleet | null;
}

/**
 * Hulls in flight that fly as one: a fleet's members, or loose hulls of one
 * empire bound for the same world on the same tick. Parked hulls and hulls
 * with no destination are not in flight and are left out.
 */
export function groupFlights(ships: readonly Ship[], fleets: readonly Fleet[]): FlightGroup[] {
  const fleetById = new Map(fleets.map(f => [f.id, f]));
  const buckets = new Map<string, Ship[]>();
  for (const s of ships) {
    const tr = s.transit?.currentTransfer;
    if (!tr?.targetBodyId) continue;
    const key = s.fleetId && fleetById.has(s.fleetId)
      ? `fleet:${s.fleetId}`
      : `loose:${s.ownedBy}|${tr.targetBodyId}|${Math.round(tr.arriveTick)}`;
    const list = buckets.get(key);
    if (list) list.push(s); else buckets.set(key, [s]);
  }
  const out: FlightGroup[] = [];
  for (const [key, members] of buckets) {
    members.sort((a, b) => a.name.localeCompare(b.name));
    const fleet = key.startsWith('fleet:') ? fleetById.get(key.slice(6)) ?? null : null;
    const lead = (fleet && members.find(m => m.id === fleet.leadShipId))
      ?? members.find(m => !!m.captainName)
      ?? members[0];
    out.push({ key, lead, members, fleet });
  }
  return out;
}

/** Head count by class, largest first: "8 corvettes, 6 frigates". */
export function makeupOf(members: readonly Ship[]): Array<{ cls: string; n: number }> {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.class, (counts.get(m.class) ?? 0) + 1);
  return [...counts.entries()]
    .map(([cls, n]) => ({ cls, n }))
    .sort((a, b) => b.n - a.n || a.cls.localeCompare(b.cls));
}

// ---- The radar ---------------------------------------------------------
//
// Radius is TICKS UNTIL YOU MEET, on a log scale so a 6t escort and a
// 140t Kuiper run share one scope; direction is WHERE you meet, from your
// own position. Rings sit on round tick counts.

export const SCOPE_RINGS = [5, 10, 20, 40, 80, 160, 320] as const;

/** The scope's outer edge in ticks: the smallest of 20/40/80/160/320 that
 *  fits every meeting shown. */
export function scopeTMax(meetIns: readonly number[]): number {
  const m = Math.max(0, ...meetIns);
  return [20, 40, 80, 160, 320].find(t => t >= m) ?? 320;
}

export function scopeRadius(ticks: number, R: number, tMax: number): number {
  const k = Math.max(3, tMax / 16);
  const f = Math.log1p(Math.max(0, ticks) / k) / Math.log1p(tMax / k);
  return R * Math.min(1, Math.max(0, f));
}

export interface ScopeItem {
  key: string;
  /** Bearing of the meeting point from you, radians, screen axes (y down). */
  angle: number;
  meetIn: number;
  /** Your soonest arrival at their destination, for a meeting at the door. */
  myEta: number | null;
  /** Blip diameter, px. */
  size: number;
}

export interface ScopePoint {
  x: number;
  y: number;
  /** The destination world on the same line, at your soonest arrival. */
  pin: { x: number; y: number } | null;
}

/**
 * Place blips on a scope of radius R centred at (C, C). Overlapping blips
 * are pushed apart sideways; none may drift more than a few px inward of
 * its own time, so "sooner" stays "closer".
 */
export function layoutScope(items: readonly ScopeItem[], R: number, tMax: number, C = R): Map<string, ScopePoint> {
  const pts = items.map(it => {
    const r0 = scopeRadius(it.meetIn, R, tMax);
    return { it, r0, x: C + Math.cos(it.angle) * r0, y: C + Math.sin(it.angle) * r0 };
  });
  for (let pass = 0; pass < 300; pass++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const need = (a.it.size + b.it.size) / 2 + 2;
        if (d >= need) continue;
        const push = (need - d) / 2;
        const ux = d > 0.01 ? dx / d : Math.cos(i + j), uy = d > 0.01 ? dy / d : Math.sin(i + j);
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
        moved = true;
      }
    }
    for (const p of pts) {
      const dx = p.x - C, dy = p.y - C;
      const r = Math.hypot(dx, dy) || 0.01;
      const lo = Math.max(0, p.r0 - 6);
      const hi = Math.max(lo, R - p.it.size / 2);
      const rr = Math.min(Math.max(r, lo), hi);
      p.x = C + (dx / r) * rr;
      p.y = C + (dy / r) * rr;
    }
    if (!moved) break;
  }
  const out = new Map<string, ScopePoint>();
  for (const p of pts) {
    const pinR = p.it.myEta == null ? null : scopeRadius(p.it.myEta, R, tMax);
    out.set(p.it.key, {
      x: p.x,
      y: p.y,
      pin: pinR == null ? null : { x: C + Math.cos(p.it.angle) * pinR, y: C + Math.sin(p.it.angle) * pinR },
    });
  }
  return out;
}

// ---- SHOW: framing the course ------------------------------------------

export interface ScreenArea { l: number; r: number; t: number; b: number }
export interface WorldBox { minX: number; minY: number; maxX: number; maxY: number }

/** Bounding box of the points that make up a course. */
export function worldBoxOf(pts: ReadonlyArray<{ x: number; y: number }>): WorldBox | null {
  if (pts.length === 0) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** The camera that frames `box` inside `area` of a W x H screen: the map
 *  the panels leave uncovered, not the whole window. An unfocused camera's
 *  x/y is the world point at the SCREEN centre, so it is shifted by how far
 *  the area's centre sits from it. */
export function framingCamera(box: WorldBox, area: ScreenArea, W: number, H: number) {
  const aw = Math.max(120, area.r - area.l), ah = Math.max(120, area.b - area.t);
  // Generous margin: a torch arc can bow outside the straight line
  // between its endpoints, and a tight box would crop the very curve.
  const w = Math.max(40, (box.maxX - box.minX) * 1.4);
  const h = Math.max(40, (box.maxY - box.minY) * 1.4);
  const scale = Math.max(0.02, Math.min(3, Math.min(aw / w, ah / h)));
  return {
    x: (box.minX + box.maxX) / 2 - ((area.l + area.r) / 2 - W / 2) / scale,
    y: (box.minY + box.maxY) / 2 - ((area.t + area.b) / 2 - H / 2) / scale,
    scale,
    zoomLevel: (scale > 1.2 ? 3 : scale > 0.35 ? 2 : 1) as 1 | 2 | 3,
  };
}

/** Width of the desktop pop-out (InterceptPicker.css .ip--popout). */
export const POPOUT_WIDTH = 392;

/** The part of the map a SHOW should use: beside the pop-out on a
 *  desktop, above the sheet on a phone. */
export function freeMapArea(isMobile: boolean, popLeft: number | null, W: number, H: number): ScreenArea {
  if (isMobile) {
    const sheetTop = document.querySelector('.bottom-sheet')?.getBoundingClientRect().top ?? H * 0.55;
    return { l: 8, r: W - 8, t: 110, b: Math.max(200, sheetTop - 8) };
  }
  return { l: (popLeft ?? 296) + POPOUT_WIDTH + 24, r: W - 72, t: 70, b: H - 24 };
}
