// ============================================================
// TORCH SANDBOX — Body definitions
// ============================================================
// Heliocentric bodies only — no SOIs, no patched conics. The Expanse-
// style brachistochrone model ignores gravity entirely (thrust is so
// dominant that solar gravity matters less than 0.1% for any trip
// shorter than weeks). We only need each body's instantaneous position
// at any tick.
//
// Distance/period values inherited from the physics sandbox so
// trajectories visually match (e.g. Mars at ~200 game units from Sol).

export interface Body {
  id: string;
  name: string;
  type: 'star' | 'terrestrial' | 'gas-giant' | 'ice-giant' | 'dwarf';
  radius: number;        // visual radius
  color: string;
  orbitRadius: number;   // distance from Sol (0 for Sol)
  orbitPeriod: number;   // ticks per full orbit (0 for Sol)
  angle0: number;        // angle at tick 0 (radians)
}

export const BODIES: Body[] = [
  { id: 'sol', name: 'Sol', type: 'star', radius: 10, color: '#ffd180',
    orbitRadius: 0, orbitPeriod: 0, angle0: 0 },
  { id: 'mercury', name: 'Mercury', type: 'terrestrial', radius: 2, color: '#8c8680',
    orbitRadius: 51.3, orbitPeriod: 29.8, angle0: 4.40 },
  { id: 'venus', name: 'Venus', type: 'terrestrial', radius: 3, color: '#e8cda0',
    orbitRadius: 95.9, orbitPeriod: 76.2, angle0: 3.18 },
  { id: 'earth', name: 'Earth', type: 'terrestrial', radius: 3, color: '#4a90d9',
    orbitRadius: 132.6, orbitPeriod: 123.8, angle0: 1.75 },
  { id: 'mars', name: 'Mars', type: 'terrestrial', radius: 2.5, color: '#c1440e',
    orbitRadius: 202.1, orbitPeriod: 233.1, angle0: 6.20 },
  { id: 'ceres', name: 'Ceres', type: 'dwarf', radius: 1.5, color: '#6b6b6b',
    orbitRadius: 310, orbitPeriod: 443, angle0: 1.20 },
  { id: 'jupiter', name: 'Jupiter', type: 'gas-giant', radius: 8, color: '#d4a574',
    orbitRadius: 460.0, orbitPeriod: 800.0, angle0: 0.60 },
  { id: 'saturn', name: 'Saturn', type: 'gas-giant', radius: 7, color: '#e8d5a3',
    orbitRadius: 843.2, orbitPeriod: 1987, angle0: 0.87 },
  { id: 'uranus', name: 'Uranus', type: 'ice-giant', radius: 5, color: '#73c2d6',
    orbitRadius: 1697, orbitPeriod: 5665, angle0: 5.47 },
  { id: 'neptune', name: 'Neptune', type: 'ice-giant', radius: 5, color: '#3366cc',
    orbitRadius: 2659, orbitPeriod: 11114, angle0: 5.32 },
];

export const BY_ID: Record<string, Body> = Object.fromEntries(
  BODIES.map(b => [b.id, b]),
);

const TWO_PI = Math.PI * 2;

/** Heliocentric position of a body at time `t` (ticks). */
export function bodyPosition(body: Body, t: number): { x: number; y: number } {
  if (body.orbitRadius === 0) return { x: 0, y: 0 };
  const angle = body.angle0 + (TWO_PI * t) / body.orbitPeriod;
  return {
    x: Math.cos(angle) * body.orbitRadius,
    y: Math.sin(angle) * body.orbitRadius,
  };
}

/** Heliocentric velocity vector of a body at time `t` (game-units / tick). */
export function bodyVelocity(body: Body, t: number): { x: number; y: number } {
  if (body.orbitRadius === 0) return { x: 0, y: 0 };
  const omega = (TWO_PI) / body.orbitPeriod;  // angular velocity
  const angle = body.angle0 + omega * t;
  return {
    x: -Math.sin(angle) * body.orbitRadius * omega,
    y:  Math.cos(angle) * body.orbitRadius * omega,
  };
}
