// ============================================================
// PHYSICS SANDBOX — Body definitions
// ============================================================
// Self-contained. Do NOT import from src/physics (the live game's
// Bezier-only system). This module is the source of truth for the
// sandbox solar system.
//
// Distances/periods inherited from the HTML prototype: Jupiter is
// anchored at orbitRadius=460 / orbitPeriod=800 (1 tick ≈ 5.4 days),
// MU_SOL is derived from that pair via 4π²r³/T². Moon orbits are
// scaled inward to fit comfortably within their parents' SOIs while
// preserving Kepler period ratios.

export interface Body {
  id: string;
  name: string;
  type: 'star' | 'terrestrial' | 'gas-giant' | 'ice-giant' | 'moon' | 'dwarf';
  parent: string | null;     // parent body id, or null for the star
  radius: number;             // visual radius (world units)
  soi: number;                // sphere of influence radius (world units; Infinity for Sol)
  mu: number;                 // gravitational parameter (0 for star — derived from Jupiter)
  color: string;
  orbitRadius: number;        // distance from parent (world units, 0 for the star)
  orbitPeriod: number;        // ticks per full orbit (0 for the star)
  angle0: number;             // mean anomaly at t=0 (radians)
}

const TWO_PI = Math.PI * 2;

export const BODIES: Body[] = [
  { id: 'sol', name: 'Sol', type: 'star', parent: null, radius: 10, soi: Infinity, mu: 0,
    color: '#ffd180', orbitRadius: 0, orbitPeriod: 0, angle0: 0 },

  // Inner system
  { id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol', radius: 2, soi: 12, mu: 50,
    color: '#8c8680', orbitRadius: 51.3, orbitPeriod: 29.8, angle0: 4.40 },
  { id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol', radius: 3, soi: 24, mu: 150,
    color: '#e8cda0', orbitRadius: 95.9, orbitPeriod: 76.2, angle0: 3.18 },
  { id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol', radius: 3, soi: 30, mu: 100,
    color: '#4a90d9', orbitRadius: 132.6, orbitPeriod: 123.8, angle0: 1.75 },
  { id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', radius: 1.5, soi: 4, mu: 5,
    color: '#c0c0c0', orbitRadius: 12, orbitPeriod: TWO_PI * Math.sqrt(1728 / 100), angle0: 0 },
  { id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol', radius: 2.5, soi: 24, mu: 80,
    color: '#c1440e', orbitRadius: 202.1, orbitPeriod: 233.1, angle0: 6.20 },

  // Belt
  { id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sol', radius: 1.5, soi: 9, mu: 0.5,
    color: '#6b6b6b', orbitRadius: 310, orbitPeriod: 443, angle0: 1.20 },

  // Jupiter + Galileans
  { id: 'jupiter', name: 'Jupiter', type: 'gas-giant', parent: 'sol', radius: 8, soi: 160, mu: 1000,
    color: '#d4a574', orbitRadius: 460.0, orbitPeriod: 800.0, angle0: 0.60 },
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter', radius: 1.5, soi: 5, mu: 5,
    color: '#e8d44d', orbitRadius: 22, orbitPeriod: TWO_PI * Math.sqrt(10648 / 1000), angle0: 0 },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter', radius: 1.5, soi: 5, mu: 5,
    color: '#b8c8d8', orbitRadius: 34, orbitPeriod: TWO_PI * Math.sqrt(39304 / 1000), angle0: 1.57 },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter', radius: 2, soi: 6, mu: 8,
    color: '#8a7e72', orbitRadius: 50, orbitPeriod: TWO_PI * Math.sqrt(125000 / 1000), angle0: 3.14 },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter', radius: 2, soi: 6, mu: 6,
    color: '#5a5a5a', orbitRadius: 75, orbitPeriod: TWO_PI * Math.sqrt(421875 / 1000), angle0: 4.71 },

  // Saturn + Titan (slim — full Saturn moon system is overkill for a sandbox)
  { id: 'saturn', name: 'Saturn', type: 'gas-giant', parent: 'sol', radius: 7, soi: 140, mu: 600,
    color: '#e8d5a3', orbitRadius: 843.2, orbitPeriod: 1987, angle0: 0.87 },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn', radius: 2, soi: 7, mu: 10,
    color: '#cc9944', orbitRadius: 65, orbitPeriod: TWO_PI * Math.sqrt(274625 / 600), angle0: 4.19 },
];

export const BY_ID: Record<string, Body> = Object.fromEntries(BODIES.map(b => [b.id, b]));

// μ for Sol derived from Jupiter's orbital pair: μ = 4π²r³/T². For non-Sol
// parents, return the hand-set mu (inflated for playable SOIs).
export const MU_SOL =
  4 * Math.PI * Math.PI *
  Math.pow(BY_ID['jupiter'].orbitRadius, 3) /
  Math.pow(BY_ID['jupiter'].orbitPeriod, 2);

export function muOf(bodyId: string): number {
  if (bodyId === 'sol') return MU_SOL;
  const b = BY_ID[bodyId];
  return b ? b.mu : 100;
}
