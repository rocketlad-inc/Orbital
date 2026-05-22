// ============================================================
// Solar System Catalog — 23 bodies in the playable solar system.
//
// Originally seeded the four hardcoded "scenarios" used to demo the
// game before AI existed. Those scenarios are gone now (replaced by
// SinglePlayerSetup); this file is the canonical body catalog and
// nothing more. Mirrors worker/factions.js BODY_CATALOG (server side).
//
// Consumers:
//   - src/state/singlePlayerSetup.ts — reads SHARED_BODIES to seed
//     new single-player campaigns and lists starting capitals
//   - src/state/index.ts — re-exports SHARED_BODIES
// ============================================================

import { Body } from '../types';

const TWO_PI = 2 * Math.PI;

// MU_SOL derived from Jupiter's orbit: 4π²·460³/800²
// Kept exported in case the orbital-mechanics code wants the same value.
export const MU_SOL = 4 * Math.PI * Math.PI * Math.pow(460, 3) / Math.pow(800, 2);

// Full solar system — 23 bodies matching the HTML prototype
export const SHARED_BODIES: Body[] = [
  // Star
  {
    id: 'sol', name: 'Sol', type: 'star',
    radius: 10, soi: Infinity, mu: 0,
    color: '#ffd180', orbitRadius: 0, orbitPeriod: 0, angle0: 0,
  },
  // Terrestrial planets
  // Inner system scaled up ~1.4× on orbit radius and ~1.8× on SOI so
  // ships orbiting at low altitude don't visually overlap with moons.
  // Periods follow Kepler's 3rd law (T ∝ a^1.5).
  {
    id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol',
    radius: 2, soi: 22, mu: 50, color: '#8c8680',
    orbitRadius: 72, orbitPeriod: 49, angle0: 4.40,
    resources: { fuel: 0, gold: 2, metal: 5, science: 1 },
  },
  {
    id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 43, mu: 150, color: '#e8cda0',
    orbitRadius: 134, orbitPeriod: 126, angle0: 3.18,
    resources: { fuel: 1, gold: 1, metal: 3, science: 4 },
  },
  {
    id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 54, mu: 100, color: '#4a90d9',
    orbitRadius: 186, orbitPeriod: 205, angle0: 1.75,
    resources: { fuel: 3, gold: 2, metal: 3, science: 5 },
  },
  {
    id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol',
    radius: 2.5, soi: 43, mu: 80, color: '#c1440e',
    orbitRadius: 283, orbitPeriod: 386, angle0: 6.20,
    resources: { fuel: 1, gold: 1, metal: 6, science: 3 },
  },
  // Earth's moon — orbit pushed out so Luna doesn't kiss the Earth's
  // ship-orbit envelope at low altitude.
  {
    id: 'luna', name: 'Luna', type: 'moon', parent: 'earth',
    radius: 1.5, soi: 8, mu: 5, color: '#c0c0c0',
    orbitRadius: 20, orbitPeriod: TWO_PI * Math.sqrt(8000 / 100), angle0: 0,
    resources: { fuel: 0, gold: 0, metal: 2, science: 2 },
  },
  // Asteroid belt — five bodies share the 310-radius orbit, spaced 72°
  // apart so the belt feels populated and ships can resource-hop between
  // them without leaving the ring.
  {
    id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 0.5, color: '#6b6b6b',
    orbitRadius: 310, orbitPeriod: 443, angle0: 1.20,
    resources: { fuel: 1, gold: 3, metal: 5, science: 1 },
  },
  {
    id: 'vesta', name: 'Vesta', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.3, color: '#a89888',
    orbitRadius: 310, orbitPeriod: 443, angle0: 2.46,
    resources: { fuel: 0, gold: 2, metal: 6, science: 1 },
  },
  {
    id: 'pallas', name: 'Pallas', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.25, color: '#80706a',
    orbitRadius: 310, orbitPeriod: 443, angle0: 3.71,
    resources: { fuel: 0, gold: 1, metal: 5, science: 2 },
  },
  {
    id: 'hygiea', name: 'Hygiea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2, color: '#75655a',
    orbitRadius: 310, orbitPeriod: 443, angle0: 4.97,
    resources: { fuel: 1, gold: 1, metal: 5, science: 1 },
  },
  {
    id: 'juno', name: 'Juno', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2, color: '#aa9070',
    orbitRadius: 310, orbitPeriod: 443, angle0: 6.23,
    resources: { fuel: 0, gold: 3, metal: 4, science: 1 },
  },

  // ============================================================
  // ROGUE ASTEROIDS — small settable bodies that can host
  // Trajectory Control Thrusters. Rich in metal + credits to
  // make the early-game rush worthwhile; sparse on fuel + science
  // so they're not strictly better than planets/moons. Once a
  // faction builds the TT building, they unlock the RAM action
  // and can crash this rock into another body.
  //
  // Three belt-class entries (circular, intermingled with the
  // existing dwarfs) + three Kuiper-class entries with long
  // eccentric paths swinging between the mid-inner system and
  // far outside Pluto. Names are evocative-but-fictional so they
  // don't collide with any real-world body.
  // ============================================================
  {
    id: 'midas', name: 'Midas', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04, color: '#c8a872',
    orbitRadius: 295, orbitPeriod: 415, angle0: 0.4,
    resources: { fuel: 0, gold: 6, metal: 8, science: 0 },
  },
  {
    id: 'styx_rock', name: 'Styx', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04, color: '#7a6858',
    orbitRadius: 320, orbitPeriod: 470, angle0: 3.0,
    resources: { fuel: 0, gold: 5, metal: 9, science: 0 },
  },
  {
    id: 'iron_anna', name: 'Iron Anna', type: 'asteroid', parent: 'sol',
    radius: 0.7, soi: 2, mu: 0.05, color: '#9a7a5a',
    orbitRadius: 340, orbitPeriod: 515, angle0: 5.1,
    resources: { fuel: 0, gold: 4, metal: 10, science: 1 },
  },
  // Kuiper-class — long elliptical paths. orbit_rp brings them
  // through the inner system on perihelion (~200 units, between
  // Mars and the belt); orbit_ra puts apohelion way out past
  // Pluto (~2000-3500 units). orbitRadius = (rp+ra)/2 = semi-
  // major axis. orbitPeriod from Kepler's third around Sol.
  {
    id: 'black_sky', name: 'Black Sky', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03, color: '#3a3030',
    orbitRadius: 1100,                          // a = (rp+ra)/2
    orbitPeriod: 2960, angle0: 0,
    orbit_rp: 200, orbit_ra: 2000,
    orbit_omega: 0.4, orbit_m0: 1.2,
    resources: { fuel: 0, gold: 7, metal: 9, science: 0 },
  },
  {
    id: 'vagrant', name: 'Vagrant', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03, color: '#5a4838',
    orbitRadius: 1450,
    orbitPeriod: 4470, angle0: 0,
    orbit_rp: 250, orbit_ra: 2650,
    orbit_omega: 2.1, orbit_m0: 4.7,
    resources: { fuel: 0, gold: 8, metal: 8, science: 1 },
  },
  {
    id: 'augustin', name: 'Augustín', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03, color: '#6a5040',
    orbitRadius: 1900,
    orbitPeriod: 6660, angle0: 0,
    orbit_rp: 300, orbit_ra: 3500,
    orbit_omega: 4.6, orbit_m0: 3.1,
    resources: { fuel: 0, gold: 9, metal: 7, science: 1 },
  },

  // Gas giants
  {
    id: 'jupiter', name: 'Jupiter', type: 'gas_giant', parent: 'sol',
    radius: 8, soi: 160, mu: 1000, color: '#d4a574',
    orbitRadius: 460.0, orbitPeriod: 800.0, angle0: 0.60,
    resources: { fuel: 6, gold: 1, metal: 1, science: 2 },
  },
  {
    id: 'saturn', name: 'Saturn', type: 'gas_giant', parent: 'sol',
    radius: 7, soi: 140, mu: 600, color: '#e8d5a3',
    orbitRadius: 843.2, orbitPeriod: 1987, angle0: 0.87,
    resources: { fuel: 5, gold: 2, metal: 1, science: 3 },
  },
  // Jupiter's Galilean moons
  {
    id: 'io', name: 'Io', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5, color: '#e8d44d',
    orbitRadius: 22, orbitPeriod: TWO_PI * Math.sqrt(10648 / 1000), angle0: 0,
    resources: { fuel: 2, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5, color: '#b8c8d8',
    orbitRadius: 34, orbitPeriod: TWO_PI * Math.sqrt(39304 / 1000), angle0: 1.57,
    resources: { fuel: 1, gold: 0, metal: 1, science: 6 },
  },
  {
    id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 8, color: '#8a7e72',
    orbitRadius: 50, orbitPeriod: TWO_PI * Math.sqrt(125000 / 1000), angle0: 3.14,
    resources: { fuel: 1, gold: 2, metal: 4, science: 3 },
  },
  {
    id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 6, color: '#5a5a5a',
    orbitRadius: 75, orbitPeriod: TWO_PI * Math.sqrt(421875 / 1000), angle0: 4.71,
    resources: { fuel: 0, gold: 3, metal: 3, science: 2 },
  },
  // Saturn's moons
  {
    id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn',
    radius: 1, soi: 3, mu: 2, color: '#f0f0f0',
    orbitRadius: 20, orbitPeriod: TWO_PI * Math.sqrt(8000 / 600), angle0: 0,
    resources: { fuel: 3, gold: 0, metal: 1, science: 6 },
  },
  {
    id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn',
    radius: 1.5, soi: 4, mu: 4, color: '#a0a0a0',
    orbitRadius: 37, orbitPeriod: TWO_PI * Math.sqrt(50653 / 600), angle0: 2.09,
    resources: { fuel: 1, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn',
    radius: 2, soi: 7, mu: 10, color: '#cc9944',
    orbitRadius: 65, orbitPeriod: TWO_PI * Math.sqrt(274625 / 600), angle0: 4.19,
    resources: { fuel: 5, gold: 1, metal: 2, science: 5 },
  },
  // Outer system compressed: Uranus/Neptune brought ~35-45% closer in
  // so a 200-tick match can actually reach them. Periods recomputed
  // per Kepler.
  {
    id: 'uranus', name: 'Uranus', type: 'ice_giant', parent: 'sol',
    radius: 5, soi: 110, mu: 200, color: '#73c2d6',
    orbitRadius: 1100, orbitPeriod: 2960, angle0: 5.47,
    resources: { fuel: 4, gold: 1, metal: 2, science: 4 },
  },
  {
    id: 'neptune', name: 'Neptune', type: 'ice_giant', parent: 'sol',
    radius: 5, soi: 120, mu: 250, color: '#3366cc',
    orbitRadius: 1500, orbitPeriod: 4710, angle0: 5.32,
    resources: { fuel: 4, gold: 2, metal: 1, science: 5 },
  },
  // Uranus moons — five-moon system (Miranda inner, Oberon outer).
  {
    id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus',
    radius: 1, soi: 3, mu: 1.5, color: '#a8a8a8',
    orbitRadius: 12, orbitPeriod: TWO_PI * Math.sqrt(1728 / 200), angle0: 0.78,
    resources: { fuel: 0, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 2.5, color: '#b0a898',
    orbitRadius: 18, orbitPeriod: TWO_PI * Math.sqrt(5832 / 200), angle0: 2.10,
    resources: { fuel: 0, gold: 2, metal: 3, science: 2 },
  },
  {
    id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 3, color: '#6a655e',
    orbitRadius: 26, orbitPeriod: TWO_PI * Math.sqrt(17576 / 200), angle0: 4.60,
    resources: { fuel: 0, gold: 1, metal: 4, science: 1 },
  },
  {
    id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4, color: '#909090',
    orbitRadius: 35, orbitPeriod: TWO_PI * Math.sqrt(42875 / 200), angle0: 0,
    resources: { fuel: 0, gold: 2, metal: 4, science: 2 },
  },
  {
    id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4, color: '#888070',
    orbitRadius: 50, orbitPeriod: TWO_PI * Math.sqrt(125000 / 200), angle0: 3.14,
    resources: { fuel: 0, gold: 3, metal: 3, science: 2 },
  },
  // Neptune moons — Proteus inner, Triton mid, Nereid outer.
  {
    id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 3, color: '#7a7a7a',
    orbitRadius: 28, orbitPeriod: TWO_PI * Math.sqrt(21952 / 250), angle0: 1.20,
    resources: { fuel: 1, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune',
    radius: 1.5, soi: 5, mu: 5, color: '#b8d0e0',
    orbitRadius: 45, orbitPeriod: TWO_PI * Math.sqrt(91125 / 250), angle0: 0,
    resources: { fuel: 2, gold: 1, metal: 2, science: 5 },
  },
  {
    id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 2, color: '#aab8c4',
    orbitRadius: 78, orbitPeriod: TWO_PI * Math.sqrt(474552 / 250), angle0: 3.95,
    resources: { fuel: 1, gold: 2, metal: 2, science: 3 },
  },
  // Outer dwarf planets — compressed proportionally with Uranus/Neptune
  // so the trans-Neptunian neighborhood is still distinct but reachable.
  // Kuiper belt is metal-rich late-game territory.
  {
    id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 12, mu: 2, color: '#c8b898',
    orbitRadius: 1900, orbitPeriod: 6720, angle0: 4.17,
    resources: { fuel: 0, gold: 4, metal: 2, science: 3 },
  },
  {
    id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto',
    radius: 1, soi: 3, mu: 1, color: '#9a8c7c',
    orbitRadius: 6, orbitPeriod: TWO_PI * Math.sqrt(216 / 2), angle0: 0,
    resources: { fuel: 0, gold: 1, metal: 6, science: 2 },
  },
  {
    id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8, color: '#d8d0c0',
    orbitRadius: 2050, orbitPeriod: 7520, angle0: 0.95,
    resources: { fuel: 0, gold: 2, metal: 6, science: 2 },
  },
  {
    id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8, color: '#c89868',
    orbitRadius: 2200, orbitPeriod: 8360, angle0: 3.30,
    resources: { fuel: 0, gold: 3, metal: 5, science: 2 },
  },
  {
    id: 'quaoar', name: 'Quaoar', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.6, color: '#a09080',
    orbitRadius: 2100, orbitPeriod: 7800, angle0: 5.10,
    resources: { fuel: 0, gold: 2, metal: 6, science: 1 },
  },
  {
    id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 1, color: '#e0e0e0',
    orbitRadius: 2400, orbitPeriod: 9560, angle0: 1.80,
    resources: { fuel: 0, gold: 5, metal: 1, science: 4 },
  },
  {
    id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 8, mu: 0.7, color: '#b06040',
    orbitRadius: 3500, orbitPeriod: 16800, angle0: 2.55,
    resources: { fuel: 0, gold: 3, metal: 7, science: 3 },
  },

  // ============================================================
  // ALPHA CENTAURI ANALOGUE — far binary system, reachable via the
  // warp gate seeded onto a random Sol-side Kuiper body each match
  // (see seedWarpGates in src/state/singlePlayerSetup.ts). Direct
  // travel is also possible if you've got the fuel and patience —
  // brachistochrone time at default engine accel is ~150 ticks.
  //
  // The system is laid out as P-type (circumbinary): two stars
  // orbit a common barycenter very tightly relative to the
  // surrounding planets. For a circumbinary planet to be stable,
  // its orbit radius needs to be roughly ≥ 3-5× the stellar
  // separation — otherwise the time-varying gravitational tug of
  // the two stars destabilizes it (real-world examples like
  // Kepler-16b sit at this threshold). With our stars at ±18 / ±28
  // from the barycenter (max separation ~46), the inner planet at
  // r=400 sits comfortably outside the chaos zone.
  //
  // Both stars share orbitPeriod so they stay diametrically
  // opposite — our simplified Kepler model doesn't enforce
  // barycentric coupling on its own, so we lock it via period +
  // phase. Real Alpha Cen A/B orbit their barycenter on an
  // 80-year eccentric path (11-36 AU range); we collapse that
  // to a fast circular orbit so the visual is recognisably
  // "two suns going around each other" rather than "two stars
  // that look static for the whole match."
  //
  // Barycenter is anchored at a distance from Sol via a parent-of-
  // sol orbit with effectively-infinite period — the body system
  // requires every non-root to orbit something, so we use Sol as a
  // pretend parent and crank the period so it doesn't drift on
  // gameplay timescales. radius=0.5 keeps it nearly invisible
  // (renderer min-draws at 3px so it's a tiny gray dot at the
  // barycenter, which actually reads as "centre of mass" nicely).
  //
  // DISTANCE TUNING: 265,000 world units gives a brachistochrone
  // direct-travel time of exactly 200 ticks at DEFAULT_ENGINE_ACCEL
  // (formula t = 2·√(d/a), a=26.52, so 265,200 → 200 ticks). The
  // intent is "you can SEE Centauri at max zoom-out but it's juuust
  // off-frame at default zoom" — the gate is the practical way in.
  // MIN_SCALE was lowered to 0.0012 so the system fits on a typical
  // 1000-1200px canvas at full zoom-out.
  // ============================================================
  {
    id: 'binary_barycenter', name: 'Centauri Barycenter', type: 'lagrange', parent: 'sol',
    radius: 0.5, soi: 0, mu: 0, color: '#3a3a44',
    orbitRadius: 265000, orbitPeriod: 1e12, angle0: 0,  // east of Sol
  },
  {
    id: 'centauri_a', name: 'Centauri A', type: 'star', parent: 'binary_barycenter',
    radius: 8, soi: 35, mu: 200, color: '#ffe082',
    // angle0=0 → starts at +X relative to barycenter
    orbitRadius: 18, orbitPeriod: 240, angle0: 0,
  },
  {
    id: 'centauri_b', name: 'Centauri B', type: 'star', parent: 'binary_barycenter',
    radius: 6, soi: 28, mu: 150, color: '#ff8a5e',
    // angle0=π → starts at -X, opposite Centauri A. Same period keeps
    // them locked opposite each other for the entire match.
    orbitRadius: 28, orbitPeriod: 240, angle0: Math.PI,
  },
  // Circumbinary worlds. Periods follow a rough √r scaling so the
  // outer worlds visibly lag behind the inner one, same as Kepler's
  // 3rd law in Sol — keeps the visual recognisably "planetary."
  // Science-rich worlds — discovering this system is meant to be
  // genuinely transformative for the player's research economy.
  // Verdant alone produces more science/harvest than any Sol body.
  {
    id: 'verdant', name: 'Verdant', type: 'terrestrial', parent: 'binary_barycenter',
    radius: 4, soi: 60, mu: 150, color: '#3aaf6e',
    orbitRadius: 400, orbitPeriod: 700, angle0: 0.3,
    resources: { fuel: 6, gold: 4, metal: 6, science: 18 },
  },
  {
    id: 'crimson', name: 'Crimson', type: 'gas_giant', parent: 'binary_barycenter',
    radius: 9, soi: 110, mu: 350, color: '#d35454',
    orbitRadius: 850, orbitPeriod: 2100, angle0: 2.1,
    resources: { fuel: 12, gold: 0, metal: 0, science: 14 },
  },
  {
    id: 'prismara', name: 'Prismara', type: 'moon', parent: 'crimson',
    radius: 1.8, soi: 9, mu: 6, color: '#c0a8ff',
    orbitRadius: 26, orbitPeriod: 90, angle0: 0,
    resources: { fuel: 0, gold: 6, metal: 4, science: 12 },
  },
  {
    id: 'cinder', name: 'Cinder', type: 'terrestrial', parent: 'binary_barycenter',
    radius: 3, soi: 40, mu: 90, color: '#a8553a',
    orbitRadius: 1400, orbitPeriod: 4400, angle0: 4.7,
    resources: { fuel: 0, gold: 8, metal: 5, science: 15 },
  },
  // Outer dwarf — the return-gate body. The warp_gate secret on this
  // is hardcoded by singlePlayerSetup (it always exists, always points
  // back to Sol's randomized Centauri-side gate).
  {
    id: 'farspire', name: 'Farspire', type: 'dwarf', parent: 'binary_barycenter',
    radius: 1.5, soi: 9, mu: 1, color: '#9088b0',
    orbitRadius: 2400, orbitPeriod: 10000, angle0: 1.5,
    resources: { fuel: 0, gold: 3, metal: 4, science: 10 },
  },

  // ============================================================
  // CYGNUS X-1 ANALOGUE — stellar-mass black hole + companion star
  // X-ray binary, ~225 ticks direct from Sol on the opposite side
  // (orbitRadius 340,000, angle0=π → west of Sol). Reachable via a
  // second warp gate randomized onto a different Kuiper body each
  // match (see seedWarpGates in singlePlayerSetup).
  //
  // PHYSICS: black holes don't usually live alone. Real-world
  // stellar-mass BHs (5-30 M☉) typically formed from a supernova
  // and were gravitationally bound to a companion that survived
  // the blast. The companion sheds gas onto the BH via stellar
  // wind or Roche-lobe overflow, forming an accretion disk that
  // glows in X-ray (this is how we detect most stellar BHs — pure
  // BHs alone are invisible). Cygnus X-1 is the textbook example:
  // a ~21 M☉ BH paired with a ~40 M☉ blue supergiant (HDE 226868)
  // at ~0.2 AU separation, orbital period ~5.6 days.
  //
  // We model: a central black_hole body at the system's barycenter
  // with a hot blue-white companion star orbiting tightly (matches
  // the X-ray-binary observation). Around them, a few wandering
  // worlds — stripped, irradiated, metal-rich from supernova ejecta,
  // and unusually high in science yield because every probe sent
  // there is rewriting astrophysics textbooks. Outer dwarf hosts
  // the return gate.
  //
  // Stable planets around X-ray binaries are rare but theoretically
  // possible if they orbit FAR from the binary (beyond the disk
  // truncation radius — we put the inner world at r=500, ~10× the
  // BH-companion separation). Their existence here is implicitly
  // "they survived because they were already far out when the
  // primary went supernova."
  // ============================================================
  {
    id: 'bh_barycenter', name: 'Cygnus Barycenter', type: 'lagrange', parent: 'sol',
    radius: 0.5, soi: 0, mu: 0, color: '#3a3a44',
    orbitRadius: 340000, orbitPeriod: 1e12, angle0: Math.PI,  // west of Sol
  },
  {
    id: 'cygnus_x', name: 'Cygnus X', type: 'black_hole', parent: 'bh_barycenter',
    // Small visible radius — the event horizon is tiny compared to
    // a star. The custom renderer draws the accretion disk much
    // bigger (3× the body radius) so it reads as a glowing eye.
    radius: 4, soi: 50, mu: 600, color: '#000000',
    // Same period as the companion, phased π apart so they stay
    // opposite each other across the barycenter (matches binary-
    // star bookkeeping). Mass ratio ~1:2 (BH heavier than companion
    // — real Cygnus X-1 is the reverse, but flipping it here keeps
    // the BH closer to the barycenter for visual cleanliness).
    orbitRadius: 12, orbitPeriod: 180, angle0: 0,
  },
  {
    id: 'hde_226868', name: 'HDE 226868', type: 'star', parent: 'bh_barycenter',
    // Blue-white supergiant donor star. Color picked to read as
    // "hot massive star" against the dark BH.
    radius: 7, soi: 30, mu: 300, color: '#a8d0ff',
    orbitRadius: 24, orbitPeriod: 180, angle0: Math.PI,
  },
  // Surviving worlds — irradiated by the X-ray emission, enriched
  // by supernova ejecta. Science yields are exceptional because
  // every measurement out here is a new physics result.
  {
    id: 'requiem', name: 'Requiem', type: 'terrestrial', parent: 'bh_barycenter',
    radius: 3, soi: 40, mu: 80, color: '#5a3a4a',  // dark irradiated rock
    orbitRadius: 500, orbitPeriod: 900, angle0: 1.2,
    resources: { fuel: 0, gold: 6, metal: 10, science: 20 },
  },
  {
    id: 'vellichor', name: 'Vellichor', type: 'gas_giant', parent: 'bh_barycenter',
    // X-ray-bleached gas giant — methane stripped, hydrogen ionized,
    // visual hue tends toward pale blue-violet.
    radius: 8, soi: 95, mu: 320, color: '#8870b0',
    orbitRadius: 1000, orbitPeriod: 2600, angle0: 3.4,
    resources: { fuel: 14, gold: 0, metal: 0, science: 16 },
  },
  {
    id: 'echelon', name: 'Echelon', type: 'terrestrial', parent: 'bh_barycenter',
    // Heavy-element world — supernova ejecta seeded it with gold,
    // uranium, exotic isotopes.
    radius: 3.5, soi: 45, mu: 110, color: '#b89060',
    orbitRadius: 1700, orbitPeriod: 5800, angle0: 5.3,
    resources: { fuel: 0, gold: 14, metal: 8, science: 18 },
  },
  // Outer dwarf — the return-gate body for this system. The warp_gate
  // secret here points back to whichever Sol KBO got picked as the
  // Cygnus-side gate. Like Farspire, resources are middling — the
  // payoff is the shortcut.
  {
    id: 'reliquary', name: 'Reliquary', type: 'dwarf', parent: 'bh_barycenter',
    radius: 1.5, soi: 9, mu: 1, color: '#706878',
    orbitRadius: 2800, orbitPeriod: 12000, angle0: 0.8,
    resources: { fuel: 0, gold: 4, metal: 5, science: 12 },
  },
];

/** Body ids in the Centauri binary system. Exported so the regular
 *  secret seeder can exclude them — we don't want a portal_to_sun
 *  landing on Verdant and quietly warping returning explorers back
 *  to Sol. The dedicated warp gates handle all inter-system travel. */
export const BINARY_SYSTEM_BODY_IDS: ReadonlySet<string> = new Set([
  'binary_barycenter',
  'centauri_a', 'centauri_b',
  'verdant', 'crimson', 'prismara', 'cinder',
  'farspire',
]);

/** Body ids in the Cygnus X-1 analogue system. Same exclusion logic
 *  as the Centauri set. */
export const BLACK_HOLE_SYSTEM_BODY_IDS: ReadonlySet<string> = new Set([
  'bh_barycenter',
  'cygnus_x', 'hde_226868',
  'requiem', 'vellichor', 'echelon',
  'reliquary',
]);

/** Sol-side Kuiper-belt bodies eligible to host a random warp gate.
 *  Pluto is excluded by player request (charming little binary planet,
 *  leave it alone). Two of these are picked at seed time without
 *  replacement — one for the Centauri gate, one for the Cygnus gate. */
export const SOL_GATE_CANDIDATES: readonly string[] = [
  'haumea', 'makemake', 'quaoar', 'eris', 'sedna',
];

/** The binary system's return gate — Farspire, the outermost dwarf
 *  in Centauri. Hardcoded; same outer-system silhouette as Sol's KBOs. */
export const BINARY_RETURN_GATE_ID = 'farspire';

/** The black-hole system's return gate — Reliquary, the outermost
 *  dwarf in Cygnus. Hardcoded mirror of Farspire. */
export const BLACK_HOLE_RETURN_GATE_ID = 'reliquary';

// (Everything below — SHARED_FACTIONS, getScenario, createScenario1-4,
// freshResources/Tech, withOwnership, ScenarioType, SCENARIO_DESCRIPTIONS —
// was removed when single-player switched to SinglePlayerSetup. Factions
// are now created dynamically from the setup screen by
// src/state/singlePlayerSetup.ts.)
