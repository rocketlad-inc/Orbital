// ============================================================
// The far systems' own rules, client side.
//
// Centauri is a binary: two suns pour twice the light on anything in
// orbit, so a STATION there yields double (Lorne, 2026-10-06). Mirrors
// BINARY_SYSTEM_TEMPLATE_IDS / BINARY_STATION_MUL in worker/systems.js,
// held together by src/game/__tests__/farSystems.test.ts.
// ============================================================

import type { Body } from '../types';

export const BINARY_SYSTEM_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'verdant', 'thistle', 'sorrel', 'crimson', 'prismara', 'scoria', 'umber',
  'cinder', 'clinker', 'farspire',
]);

export const BINARY_STATION_MUL = 2;

/** Catalogue id of a client body (ids arrive stripped, but tolerate a
 *  game prefix the way templateIdOf does). */
function templateOf(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

export function isBinarySystemBody(body: Pick<Body, 'id'>): boolean {
  return BINARY_SYSTEM_TEMPLATE_IDS.has(templateOf(body.id));
}

/** What a station's yield is multiplied by at this body. */
export function binaryStationMul(body: Pick<Body, 'id'>): number {
  return isBinarySystemBody(body) ? BINARY_STATION_MUL : 1;
}
