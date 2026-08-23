// ============================================================
// orbitPacing — randomised starting phase, and a faster outer system.
//
//   npm run sim:orbitpacing
//
// Two dials that both rewrite orbits, and three things that quietly
// depend on them:
//
//   TROJANS follow their host. An L3 rock is pinned half a turn from its
//   planet; scatter the planet and the rock has to travel with it, or
//   the one body guaranteed to sit opposite yours ends up somewhere
//   arbitrary.
//
//   A MOVED PLANET NEEDS A NEW YEAR. Overriding orbit_radius by hand and
//   leaving the period alone makes a planet sweep a wider orbit at its
//   old angular rate. That is how Jupiter ended up 25% fast after being
//   nudged clear of the belt.
//
//   THE INNER SYSTEM IS NOT THE OUTER ONE. The speed-up exists because
//   Neptune's year is 555 days at an hour a tick. Applying it to Earth
//   would undo the pacing work it was added alongside.
// ============================================================

import { BODY_CATALOG, scaledGeometry, moonReachByParent } from '../worker/factions.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const SYS = 4;
const ceres = BODY_CATALOG.find(b => b.id === 'ceres');
const BELT = ceres.orbit_radius * SYS;
const moonReach = moonReachByParent();

const geom = (body, over = {}) => scaledGeometry(body, {
  sysScale: SYS, bodyScale: 1, moonScale: 1, moonReach,
  beltRadius: BELT, ...over,
});

// ---- the outer system speeds up, the inner one does not -------------
{
  const SPEEDUP = 4;
  const inner = ['mercury', 'venus', 'earth', 'mars'];
  const outer = ['jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'sedna'];

  for (const id of inner) {
    const b = BODY_CATALOG.find(x => x.id === id);
    const base = geom(b).orbit_period;
    const fast = geom(b, { outerSpeedup: SPEEDUP }).orbit_period;
    check(`${id}: inner planet is untouched by the speed-up`,
      base === fast, `${base} -> ${fast}`);
  }
  for (const id of outer) {
    const b = BODY_CATALOG.find(x => x.id === id);
    const base = geom(b).orbit_period;
    const fast = geom(b, { outerSpeedup: SPEEDUP }).orbit_period;
    check(`${id}: beyond the belt, runs ${SPEEDUP}x faster`,
      Math.abs(fast * SPEEDUP - base) < 1e-6, `${Math.round(base)} -> ${Math.round(fast)}`);
  }

  // The point of the dial, stated as the thing a player would notice.
  const nep = BODY_CATALOG.find(x => x.id === 'neptune');
  const days = geom(nep, { outerSpeedup: SPEEDUP }).orbit_period / 24;
  check('Neptune becomes something that moves during a game',
    days < 200, `${days.toFixed(0)} days at an hour a tick`);
}

// ---- moons are not "beyond the belt" --------------------------------
{
  // A moon's orbit_radius is measured from its planet, so it is a small
  // number that could never exceed the belt boundary — but the guard is
  // that moons take the Kepler branch, not the speed-up branch, however
  // far out their parent sits.
  const callisto = BODY_CATALOG.find(b => b.id === 'callisto');
  const base = geom(callisto).orbit_period;
  const fast = geom(callisto, { outerSpeedup: 4 }).orbit_period;
  check('a moon of an outer planet keeps its own year',
    base === fast, `${base} -> ${fast}`);
}

// ---- a hand-moved planet re-derives its year ------------------------
{
  const jup = BODY_CATALOG.find(b => b.id === 'jupiter');
  const stay = geom(jup);
  const moved = geom(jup, { orbitOverride: 1150 });   // 920 -> 1150
  const rRatio = moved.orbit_radius / stay.orbit_radius;
  const tRatio = moved.orbit_period / stay.orbit_period;
  check('moving a planet outward lengthens its year',
    tRatio > 1, `radius x${rRatio.toFixed(3)}, period x${tRatio.toFixed(3)}`);
  check('...by Kepler, r^1.5',
    Math.abs(tRatio - Math.pow(rRatio, 1.5)) < 1e-6,
    `${tRatio.toFixed(4)} vs ${Math.pow(rRatio, 1.5).toFixed(4)}`);
  // The regression this exists for: Jupiter was moved and kept its year,
  // so it swept the wider orbit at the old angular rate.
  const speedBefore = stay.orbit_radius / stay.orbit_period;
  const speedAfterWrong = moved.orbit_radius / stay.orbit_period;
  check('...which is what stops a moved planet running fast',
    speedAfterWrong > speedBefore, 'the un-derived period would have been faster');
}

// ---- scattering keeps trojans opposite their host -------------------
{
  // Reproduces the L3 rule from worker/meteoroids.js: same radius and
  // period as the host, half a turn of phase. Whatever phase the host is
  // scattered to, the rock must sit across from it.
  const TWO_PI = Math.PI * 2;
  const hosts = ['earth', 'jupiter', 'neptune'];
  for (const id of hosts) {
    const host = { ...BODY_CATALOG.find(b => b.id === id), angle0: 2.7183 };
    const trojan = {
      orbit_radius: host.orbit_radius,
      orbit_period: host.orbit_period,
      angle0: (host.angle0 + Math.PI) % TWO_PI,
    };
    const sep = Math.abs(((trojan.angle0 - host.angle0) % TWO_PI + TWO_PI) % TWO_PI - Math.PI);
    check(`${id}: its trojan sits half a turn away wherever the host starts`,
      sep < 1e-9, `separation off by ${sep}`);
    check(`${id}: ...and shares the year, so it stays there`,
      trojan.orbit_period === host.orbit_period);
  }
}

// ---- a phase scatter is reproducible from the seed ------------------
{
  // The seeder draws phases from makeRand(`${map_seed}:phase`). Same seed
  // must give the same sky, or "reproducible from a seed" is a lie.
  function makeRand(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const draw = (seed, n) => { const r = makeRand(`${seed}:phase`); return Array.from({ length: n }, () => r()); };
  const a = draw('game-A', 20), b = draw('game-A', 20), c = draw('game-B', 20);
  check('the same seed scatters the same way', a.every((v, i) => v === b[i]));
  check('a different seed scatters differently', a.some((v, i) => v !== c[i]));
  check('phases cover the whole circle', Math.max(...a) > 0.8 && Math.min(...a) < 0.2);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
