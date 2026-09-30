// ============================================================
// Hull art (visual overhaul, STAGING ONLY — see dev branch).
//
// Every ship, capital hull and megastructure is authored in one small
// data language (engine.ts) and shaded from the owning empire's two
// tones: the PRIMARY builds the body (lit top half, base, shadowed
// plates, drive glow), the SECONDARY trims it (livery, panel lines,
// edges). There is no separate ring or halo: the hull is the flag.
//
// This module is the typed front door. It hands back a complete <svg>
// string for any (family, variant, colours), which the React icon
// components mount and the canvas caches rasterise — so the map, the
// lists and the pickers can never show different art for one ship.
// ============================================================

import { palette, render } from './engine';
import { CORVETTE } from './corvette';
import { FRIGATE } from './frigate';
import { DESTROYER } from './destroyer';
import { FREIGHTER } from './freighter';
import { COLONY } from './colony';
import { MEGA_DESTROYER, MOBILE_FOUNDRY, STRUCTURES, SCAFFOLD } from './capital';
import { CORVETTE_HOMAGE, FRIGATE_HOMAGE, DESTROYER_HOMAGE, FREIGHTER_HOMAGE, COLONY_HOMAGE } from './homage';

export interface HullDesign { name: string; note?: string; premium?: boolean; parts: unknown[] }
type DesignSet = Record<string, HullDesign>;

const SHIP_SETS: Record<string, DesignSet> = {
  corvette: { ...CORVETTE, ...CORVETTE_HOMAGE }, frigate: { ...FRIGATE, ...FRIGATE_HOMAGE },
  destroyer: { ...DESTROYER, ...DESTROYER_HOMAGE }, freighter: { ...FREIGHTER, ...FREIGHTER_HOMAGE },
  colony: { ...COLONY, ...COLONY_HOMAGE },
  mega_destroyer: MEGA_DESTROYER, mobile_foundry: MOBILE_FOUNDRY,
};

/** The design for a ship class + variant letter, falling back to A so an
 *  unknown letter (a newer build's variant) still draws a hull. */
export function shipDesign(shipClass: string, variant?: string | null): HullDesign | null {
  const set = SHIP_SETS[shipClass];
  if (!set) return null;
  return set[variant ?? 'A'] ?? set.A ?? null;
}

/** A megastructure's design by kind + variant. */
export function structureDesign(kind: string, variant?: string | null): HullDesign | null {
  if (kind === 'mega_destroyer' || kind === 'mobile_foundry') return shipDesign(kind, variant);
  const set = (STRUCTURES as Record<string, DesignSet>)[kind];
  if (!set) return null;
  return set[variant ?? 'A'] ?? set.A ?? null;
}

/** Whether this exact variant has a design (no fallback to A). */
export function hasStructureDesign(kind: string, variant: string): boolean {
  if (kind === 'mega_destroyer' || kind === 'mobile_foundry') return !!SHIP_SETS[kind]?.[variant];
  return !!(STRUCTURES as Record<string, DesignSet>)[kind]?.[variant];
}

/** A construction site's frame at build stage 0-3 (any kind: what is
 *  being built shows as the finished silhouette ghosted behind it). */
export function scaffoldDesign(stage: number): HullDesign {
  return (SCAFFOLD as HullDesign[])[Math.max(0, Math.min(3, Math.round(stage)))];
}

/** Display name of a variant (pickers, galleries). */
export function hullName(shipClass: string, variant: string): string | null {
  return SHIP_SETS[shipClass]?.[variant]?.name ?? null;
}

const inner = new Map<string, string>();
function innerMarkup(d: HullDesign, key: string, primary: string, secondary?: string): string {
  const k = `${key}|${primary}|${secondary ?? ''}`;
  let s = inner.get(k);
  if (s === undefined) {
    s = render(d.parts, palette(primary, secondary)) as string;
    inner.set(k, s);
    if (inner.size > 2000) inner.delete(inner.keys().next().value as string);
  }
  return s;
}

/** Just the drawing (no <svg> wrapper), for React to mount inside its own <svg>. */
export function hullInnerSvg(d: HullDesign, key: string, primary: string, secondary?: string): string {
  return innerMarkup(d, key, primary, secondary);
}

/** A complete standalone SVG document (64-unit viewBox, nose toward +x). */
export function hullSvgString(d: HullDesign, key: string, size: number, primary: string, secondary?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${innerMarkup(d, key, primary, secondary)}</svg>`;
}
