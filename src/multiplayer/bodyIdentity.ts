// ============================================================
// How a server body row becomes the Body the renderer draws.
//
// Two conversions, both of which the live game has always done at the
// /state boundary and neither of which is cosmetic:
//
//   * The type is hyphenated in the database ('gas-giant') and
//     underscored in the client ('gas_giant'). The texture painter
//     branches on the underscored form, so a raw row paints a gas giant
//     as a rocky world — every branch misses and it falls through to the
//     terrestrial path.
//
//   * Body ids are namespaced per game as '<gameId>:<localId>'. The
//     surface art is SEEDED ON body.id, so the same world drawn from a
//     namespaced id gets different continents, different craters,
//     different clouds and a different biome than the one the player has
//     been looking at all game.
//
// They lived inside MultiplayerGameProvider, which meant anything else
// reading bodies straight from an API — the battle recap, the system
// view — quietly drew a different planet. One definition, imported by
// both, so that cannot drift again.
// ============================================================

import type { Body } from '../types';

/** 'gas-giant' -> 'gas_giant'. Anything already in client form passes
 *  through untouched, so this is safe to apply twice. */
export function mapBodyType(t: string): Body['type'] {
  if (t === 'gas-giant') return 'gas_giant';
  if (t === 'ice-giant') return 'ice_giant';
  return (t as Body['type']);
}

/**
 * Server body ids are namespaced per game ("Reemucleoytj:jupiter"). The
 * rest of the client compares against the bare literals, and — the part
 * that matters here — the planet texture is seeded on the id, so the
 * prefix has to come off or the world looks like a different world.
 */
export function stripGameId(id: string | null | undefined): string | undefined {
  if (id == null) return undefined;
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
}

/**
 * A body row from an admin/share endpoint, in the shape the renderer
 * expects. Only the fields the surface art actually reads are required;
 * everything else rides along untouched.
 */
export function toRenderBody<T extends { id: string; type: string }>(b: T): T & Body {
  return {
    ...(b as unknown as Body),
    ...b,
    id: stripGameId(b.id) ?? b.id,
    type: mapBodyType(b.type),
  } as T & Body;
}
