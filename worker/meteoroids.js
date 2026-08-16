// ============================================================
// Meteoroids — the minable rocks, generated per game.
//
// THIRTY of them, procedural and reproducible from map_seed, spawned at
// game start and invisible until a faction discovers them.
//
// NOT the existing `asteroid` type, on purpose. Asteroids are
// hand-authored, settleable real estate you claim and keep. A meteoroid
// is consumable: you work it, it runs dry, it is removed. One type
// carrying both meanings would put a "but not this kind" branch in
// every settle, claim and build path — and players would try to found
// cities on rocks that are about to vanish.
//
// DISTRIBUTION — three populations, each with a different job:
//
//   12 AT PLANETARY L3. The far side of a planet's orbit is genuinely
//   dead space: nobody has any reason to be there. L3 is permanently
//   stable in phase — identical orbit radius means identical period, so
//   the rock stays 180 degrees opposite its planet forever, and a route
//   there stays valid for the rock's whole life. It also builds a
//   piracy lane by construction: a run from a planet to its own L3
//   crosses the full diameter of that orbit, so both ends sit near
//   infrastructure with a long, exposed middle. `lagrange` was already
//   a declared body type that nothing seeded — the vocabulary existed
//   unused.
//
//   10 IN THE BELT (330-420, circular). Mixed in among Ceres, Vesta,
//   Pallas, Hygiea and Juno. The easy, contested, early-game rocks.
//
//   8 KUIPER (2800-5000, eccentric). These are the interesting ones:
//   an eccentric orbit makes a route's economics TIME-DEPENDENT, cheap
//   to work at periapsis and brutal at apoapsis. No other route in this
//   game has that property, and it falls out of the orbit for free.
//
// SPEED IS NORMAL, and that is a deliberate divergence. Every existing
// rogue runs at HALF its Kepler-consistent period so it is hard to
// chase. A meteoroid is a resource to work, not a prize to race for, so
// it keeps honest orbital mechanics. Written down because the
// surrounding convention says otherwise and a future reader will
// reasonably assume this was an oversight.
// ============================================================

/** Catalogue names: MTR-01..MTR-30. Unambiguous, sortable, zero
 *  authoring, and it reads like a survey. The discovering faction may
 *  rename it afterwards — that is what makes the map a record of who
 *  found what. */
const designation = (n) => `MTR-${String(n).padStart(2, '0')}`;

/** The twelve worlds whose far side is worth filling. The inner four,
 *  the four giants, and the big Kuiper objects — the bodies players
 *  actually operate around. There are ~19 sun-orbiting bodies, so one
 *  opposite EVERY body would eat the whole budget on places nobody
 *  goes anyway. */
const L3_HOSTS = [
  'mercury', 'venus', 'earth', 'mars',
  'jupiter', 'saturn', 'uranus', 'neptune',
  'pluto', 'eris', 'sedna', 'makemake',
];

/** What a rock is made of. Metal and gold only — NOT science.
 *  The research drain clamps spend to income each tick, so delivered
 *  science is spending power for that tick rather than a bank balance:
 *  a science rock would be one tick of enormous rush potential and then
 *  nothing, which is a different mechanic wearing a mining costume. If
 *  a science burst is wanted later it should be designed as a burst,
 *  deliberately, not arrive as a side effect of tonnage. */
const KINDS = ['metal', 'gold'];

const TWO_PI = Math.PI * 2;

/**
 * Build the meteoroid rows for a game.
 *
 * @param rand  the game's seeded PRNG (makeRand(map_seed)) — passed in
 *              rather than created here so meteoroids draw from the SAME
 *              stream as the rest of worldgen and a given seed keeps
 *              producing a given world.
 * @param hosts the already-built sun-orbiting body templates, needed for
 *              the L3 pairings (radius, period and angle of the host).
 * @returns     body templates in the same shape the seeder inserts.
 */
export function generateMeteoroids(rand, hosts) {
  const byId = new Map(hosts.map(h => [h.id, h]));
  const out = [];
  let n = 0;

  const push = (t) => { out.push(t); };

  /** Tonnage. Deliberately NOT tuned to compete with terraforming: a
   *  terraform is 124 metal + 124 credits ONCE — well under a single
   *  freighter load — for a permanent 100%-yield world, and it does not
   *  escalate at the default growth of 1.0. No sane rock beats that as
   *  an income stream. So these are sized for TEMPO and CONTEST: a few
   *  freighter loads each, worth fighting over, gone soon enough to
   *  matter. Belt rocks are smaller and safer; the Kuiper hauls are the
   *  payday that justifies the trip. */
  const tonnage = (min, max) => Math.round((min + rand() * (max - min)) / 25) * 25;

  // ---- 12 at planetary L3 -----------------------------------------
  for (const hostId of L3_HOSTS) {
    const host = byId.get(hostId);
    if (!host) continue;               // a trimmed map is not an error
    n += 1;
    push({
      id: `mtr_${hostId}_l3`,
      name: designation(n),
      type: 'lagrange',
      parent: 'sol',
      radius: 0.3 + rand() * 0.15,
      soi: 0,
      mu: 0,
      // SAME radius and period as the host: that is what pins it
      // opposite forever. Half a turn of phase offset is the L3 point.
      orbit_radius: host.orbit_radius,
      orbit_period: host.orbit_period,
      angle0: (host.angle0 + Math.PI) % TWO_PI,
      color: '#8b7d6b',
      yield: { metal: 0, fuel: 0, gold: 0, science: 0 },
      mineral_kind: KINDS[Math.floor(rand() * KINDS.length)],
      mineral_initial: tonnage(600, 1400),
      l3_host: hostId,
    });
  }

  // ---- 10 in the belt ---------------------------------------------
  for (let i = 0; i < 10; i++) {
    n += 1;
    const r = 330 + rand() * 90;
    push({
      id: `mtr_belt_${i}`,
      name: designation(n),
      type: 'meteoroid',
      parent: 'sol',
      radius: 0.25 + rand() * 0.15,
      soi: 0,
      mu: 0,
      orbit_radius: r,
      // Kepler-consistent, at NORMAL speed (see the header note).
      orbit_period: Math.round(TWO_PI * Math.sqrt((r * r * r) / 4000)),
      angle0: rand() * TWO_PI,
      color: '#7d7367',
      yield: { metal: 0, fuel: 0, gold: 0, science: 0 },
      mineral_kind: KINDS[Math.floor(rand() * KINDS.length)],
      mineral_initial: tonnage(400, 900),
    });
  }

  // ---- 8 eccentric Kuiper -----------------------------------------
  for (let i = 0; i < 8; i++) {
    n += 1;
    const ra = 2800 + rand() * 2200;          // apoapsis, way out
    const rp = 300 + rand() * 900;            // periapsis, reaching inward
    const a = (ra + rp) / 2;                  // semi-major axis
    push({
      id: `mtr_kuiper_${i}`,
      name: designation(n),
      type: 'meteoroid',
      parent: 'sol',
      radius: 0.3 + rand() * 0.2,
      soi: 0,
      mu: 0,
      orbit_radius: a,
      orbit_period: Math.round(TWO_PI * Math.sqrt((a * a * a) / 4000)),
      angle0: rand() * TWO_PI,
      color: '#6f6b78',
      yield: { metal: 0, fuel: 0, gold: 0, science: 0 },
      // The eccentric pair the renderer and the physics both read.
      orbit_rp: rp,
      orbit_ra: ra,
      orbit_omega: rand() * TWO_PI,
      orbit_m0: rand() * TWO_PI,
      mineral_kind: KINDS[Math.floor(rand() * KINDS.length)],
      // The payday: a long haul on a moving target should be worth it.
      mineral_initial: tonnage(1200, 2400),
    });
  }

  return out;
}

export const METEOROID_COUNT = 30;
export { designation as meteoroidDesignation, L3_HOSTS };
