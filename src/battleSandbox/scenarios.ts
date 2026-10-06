// ============================================================
// Battle test-page scenarios: who is fighting over the world.
//
// Rosters are seeded, so "Large" is the same fight every time unless the
// page rerolls. Sizes are the game's own drawn sprite sizes (mapRenderer
// SHIP_ICON_REST_SIZE x SHIP_ICON_SCALE x REGULAR_SHIP_BOOST; capital
// hulls skip the boost), so the layout is solved against real pixels.
// ============================================================

import type { OBShip } from '../render/orbitBattleLayout';

export type ShipClass = 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'mega_destroyer';

export const CLASS_PX: Record<ShipClass, number> = {
  corvette: 14 * 3,
  frigate: 17 * 3,
  destroyer: 22 * 3,
  freighter: 16 * 3,
  mega_destroyer: 38 * 2,
};

export interface SandboxFaction {
  id: string;
  name: string;
  color: string;
  color2: string;
  /** Kinetic rounds or energy beams, for the look of its fire. */
  weapon: 'kinetic' | 'energy';
}

export const FACTIONS: SandboxFaction[] = [
  { id: 'a', name: 'Solar Directorate', color: '#ff8a3d', color2: '#ffd36b', weapon: 'kinetic' },
  { id: 'b', name: 'Vexan Concord', color: '#8b6cff', color2: '#5fd8ff', weapon: 'energy' },
  { id: 'c', name: 'Tal Free Worlds', color: '#3fd0a5', color2: '#e9f871', weapon: 'kinetic' },
];

export interface SandboxShip extends OBShip {
  cls: ShipClass;
  name: string;
}

export type ScenarioId = 'small' | 'medium' | 'large' | 'three';

export const SCENARIOS: Record<ScenarioId, { label: string; blurb: string }> = {
  small:  { label: 'Small',     blurb: '4 vs 3: a skirmish' },
  medium: { label: 'Medium',    blurb: '24 vs 20, a few fleets a side' },
  large:  { label: 'Large',     blurb: '75 vs 65, fleets, capitals and stragglers' },
  three:  { label: 'Three-way', blurb: '30 vs 26 vs 18' },
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One side's roster: `fleets` fleets of roughly even size plus loose hulls. */
function side(faction: string, count: number, fleets: number, capitals: number, R: () => number): SandboxShip[] {
  const out: SandboxShip[] = [];
  const pick = (): ShipClass => {
    const x = R();
    return x < 0.42 ? 'corvette' : x < 0.72 ? 'frigate' : x < 0.9 ? 'destroyer' : 'freighter';
  };
  for (let i = 0; i < count; i++) {
    const cls: ShipClass = i < capitals ? 'mega_destroyer' : pick();
    // Most hulls belong to a fleet; about one in six is a straggler.
    const fleet = fleets > 0 && R() > 0.16 ? `${faction}-f${Math.floor(R() * fleets)}` : null;
    out.push({
      id: `${faction}-${i}`,
      name: `${faction.toUpperCase()}-${i}`,
      faction,
      fleet,
      cls,
      size: CLASS_PX[cls],
      armed: cls !== 'freighter',
    });
  }
  return out;
}

export function buildScenario(id: ScenarioId, seed = 1): SandboxShip[] {
  const R = rng(seed * 104729 + id.length);
  switch (id) {
    case 'small':  return [...side('a', 4, 1, 0, R), ...side('b', 3, 1, 0, R)];
    case 'medium': return [...side('a', 24, 3, 0, R), ...side('b', 20, 2, 0, R)];
    case 'large':  return [...side('a', 75, 5, 1, R), ...side('b', 65, 4, 1, R)];
    case 'three':  return [...side('a', 30, 3, 0, R), ...side('b', 26, 2, 0, R), ...side('c', 18, 2, 0, R)];
    default:       return [];
  }
}
