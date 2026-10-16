// ============================================================
// CUSTOM MAPS — the Map Maker's format, its rules, and the bridge to the
// seeder. Shared by the client (src/mapmaker) and the worker
// (worker/customMaps.js, worker/factions.js seedGameWorld), so the
// checklist a player sees while building is the same check the server
// runs before it lets them host.
//
// UNITS are the shipped catalogue's own (worker/factions.js BODY_CATALOG
// after SYSTEM_SCALE): Earth orbits at 372, Jupiter at 920, Neptune at
// 3000. A custom map is then scaled by the game's dials exactly like Sol,
// so a hand-made system plays at the same size and pace as the real one.
//
// Plain JS (with customMap.d.ts) because the worker imports it too.
// ============================================================

export const MAP_VERSION = 1;
export const MAX_BODIES = 200;
export const MAX_NAME = 24;

/** What a player can place. Server spellings (gas-giant, not gas_giant). */
export const BODY_TYPES = ['terrestrial', 'gas-giant', 'ice-giant', 'dwarf', 'moon', 'asteroid', 'rock'];

/** Per-type defaults and bounds: radius (body size), mass (mu, for the
 *  years of its moons) and its sphere of influence before moons widen it.
 *  Taken from the shipped worlds (Earth r3/soi54, Jupiter r8/soi160...). */
export const TYPE_INFO = {
  terrestrial: { label: 'Planet', radius: [1.5, 5, 3], mu: 100, soi: 50, color: '#4f8a3c', surface: 'verdant' },
  'gas-giant': { label: 'Gas giant', radius: [5, 11, 8], mu: 1000, soi: 150, color: '#d4a574', surface: 'gas' },
  'ice-giant': { label: 'Ice giant', radius: [4, 8, 5], mu: 220, soi: 115, color: '#73c2d6', surface: 'ice' },
  dwarf: { label: 'Dwarf', radius: [0.8, 2.5, 1.5], mu: 1, soi: 10, color: '#c8b898', surface: 'barren' },
  moon: { label: 'Moon', radius: [0.6, 3, 1.5], mu: 5, soi: 6, color: '#a0a6ad', surface: 'barren' },
  asteroid: { label: 'Asteroid', radius: [0.4, 1.2, 0.7], mu: 0.1, soi: 3, color: '#8f8676', surface: 'barren' },
  rock: { label: 'Rock', radius: [0.3, 0.6, 0.45], mu: 0, soi: 0, color: '#8b7d6b', surface: null },
};

/** Surface looks the renderer can paint (src/render/planetTexture.ts). */
export const SURFACES = ['verdant', 'ocean', 'desert', 'rocky', 'barren', 'ice', 'lava', 'toxic', 'gas', 'storm'];

/** Hidden discoveries a map may place. The outer-reach ancients, the
 *  caches and the classic finds; the gate pairs are left out (they assume
 *  Sol's own outer worlds). 'random' leaves the kind to the seed. */
export const MAP_SECRETS = [
  'ancient_city', 'pre_terraformed', 'derelict_warship', 'resource_cache', 'ancient_databank',
  'ancient_capital', 'ancient_relay', 'ancient_station', 'deep_cache',
];
/** Discoveries that need a world a city can stand on. */
const SURFACE_SECRETS = new Set(['ancient_city', 'pre_terraformed']);
export function secretFits(kind, type) {
  if (!kind || kind === 'random') return true;
  if (!MAP_SECRETS.includes(kind)) return false;
  if (type === 'rock') return false;
  if (SURFACE_SECRETS.has(kind)) return type === 'terrestrial' || type === 'moon' || type === 'dwarf';
  return true;
}

/** Worlds a player can start on: somewhere a city can stand. */
export function canStartOn(type) {
  return type === 'terrestrial' || type === 'moon' || type === 'dwarf';
}

/** Orbit limits, map units. A sun's child from Mercury-close to past Sedna;
 *  a moon from Phobos-close to wide. */
export const ORBIT_LIMITS = { sun: [60, 14000], moon: [6, 400] };
export const RESOURCE_MAX = 30;
export const SUN_LIMITS = { size: [30, 90], mass: [0.4, 2.5] };

/** Sol's own law for a year: T = 0.0808 r^1.5 (Earth 372 -> 580). */
export const SUN_YEAR_K = 0.0808;
/** The sky behind the system: a deep-space tint. */
export const BACKDROPS = ['deep', 'blue', 'crimson', 'emerald', 'violet', 'amber'];
export const TEXT_LIMITS = { blurb: 400, lore: 200, secretName: 40, secretText: 240 };
/**
 * SECTORS are bands of orbit round the sun, drawn by the map maker. On a
 * custom map they REPLACE the game's automatic "systems" (worker/
 * systems.js, src/game/systemGrouping.ts) for every world inside them:
 * senate vote weight, the outliner's headers, the map's region shading,
 * the Herald's strip. A moon is in its planet's sector. A world outside
 * every band groups automatically, as on any map.
 *
 * Bands, not slices: worlds orbit at different speeds, so a wedge would
 * lose its planets within days. A band holds what orbits inside it
 * forever.
 */
export const MAX_SECTORS = 12;
export const SECTOR_COLORS = ['#4ecdc4', '#ffb84d', '#b98cff', '#6ee7b7', '#ff6b9d', '#7fd4ff', '#e8e36b', '#ff8a5c'];

/** Map units clear of the sun's disc a world's near edge must sit, and
 *  clear of its planet's a moon's (checkMap 'sun_close', 'moon_inside').
 *  The game draws both at their true radius; the margin is for the glow
 *  and so the two read apart at a glance. */
const SUN_MARGIN = 10;
const MOON_MARGIN = 2;
/** Planet types, and how near a planet's ring a loose world must sit to be
 *  filed in its system: worker/systems.js PLANET_TYPES and
 *  CO_ORBITAL_TOLERANCE (server spellings; this is map data). */
const PLANET_TYPES = new Set(['terrestrial', 'gas-giant', 'ice-giant']);
const CO_ORBITAL_TOLERANCE = 0.05;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9]{1,12}$/;
const SECTOR_ID_RE = /^s[a-z0-9]{1,11}$/;
/** RegExp.test stringifies: ["aa"] passes ID_RE as "aa" and is then kept
 *  as an array, which no Set or === can match, so duplicate ids and
 *  array colours slipped through to the seeder and broke the game start
 *  (security review, 2026-10-15). Every id and colour must BE a string. */
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isColor = (v) => typeof v === 'string' && COLOR_RE.test(v);
const isSectorId = (v) => typeof v === 'string' && SECTOR_ID_RE.test(v);
/** Invisible and direction-flipping characters: control codes, zero-width
 *  marks, bidi overrides. A name that holds them can read as something
 *  else in the Herald, a Discord post or the chronicle. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** Free text a player wrote: control characters out, runs of blank lines
 *  squeezed, trimmed and capped. Never HTML: every reader renders it as
 *  plain text. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim().slice(0, max);
}

/** A blank map: one sun. */
export function blankMap(name = 'Untitled system') {
  return {
    v: MAP_VERSION,
    name,
    sun: { name: 'Helion', color: '#ffd180', size: 50, mass: 1 },
    blurb: '',
    bodies: [],
    sectors: [],
    settings: { shareHidesSecrets: true, backdrop: 'deep' },
  };
}

/** A fresh body id, unique within `taken`. */
export function newBodyId(taken, rand = Math.random) {
  for (;;) {
    const id = 'b' + Math.floor(rand() * 36 ** 6).toString(36);
    if (!taken.has(id)) return id;
  }
}

/** Clean a map from anywhere (the client, a share code, the database):
 *  every number clamped, every string trimmed, unknown keys dropped,
 *  orphans re-parented to the sun, moons of moons flattened. Never throws. */
export function normalizeMap(input) {
  const m = input && typeof input === 'object' ? input : {};
  const sunIn = m.sun && typeof m.sun === 'object' ? m.sun : {};
  const out = {
    v: MAP_VERSION,
    name: cleanName(m.name, 'Untitled system', 40),
    sun: {
      name: cleanName(sunIn.name, 'Helion'),
      color: isColor(sunIn.color) ? sunIn.color : '#ffd180',
      size: clamp(num(sunIn.size, 50), ...SUN_LIMITS.size),
      mass: clamp(num(sunIn.mass, 1), ...SUN_LIMITS.mass),
    },
    blurb: cleanText(m.blurb, TEXT_LIMITS.blurb),
    bodies: [],
    sectors: normalizeSectors(m.sectors),
    settings: {
      shareHidesSecrets: m.settings?.shareHidesSecrets !== false,
      backdrop: BACKDROPS.includes(m.settings?.backdrop) ? m.settings.backdrop : 'deep',
    },
  };
  const raw = Array.isArray(m.bodies) ? m.bodies.slice(0, MAX_BODIES) : [];
  const seen = new Set();
  const typeOf = new Map();
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    if (!isId(b.id) || seen.has(b.id)) continue;
    if (!BODY_TYPES.includes(b.type)) continue;
    seen.add(b.id);
    typeOf.set(b.id, b.type);
  }
  for (const b of raw) {
    if (!b || !seen.has(b.id) || out.bodies.some(x => x.id === b.id)) continue;
    const info = TYPE_INFO[b.type];
    // A moon orbits a world that orbits the sun; anything else orbits the
    // sun. A moon whose world is gone is set loose round the sun.
    let parent = 'sun';
    if (b.type === 'moon') {
      const pt = typeOf.get(b.parent);
      if (pt && pt !== 'moon' && pt !== 'rock' && pt !== 'asteroid') parent = b.parent;
    }
    const lim = parent === 'sun' ? ORBIT_LIMITS.sun : ORBIT_LIMITS.moon;
    const y = b.yields && typeof b.yields === 'object' ? b.yields : {};
    const body = {
      id: b.id,
      name: cleanName(b.name, info.label),
      type: b.type,
      parent,
      orbit: clamp(num(b.orbit, lim[0] * 2), lim[0], lim[1]),
      angle: ((num(b.angle, 0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
      radius: clamp(num(b.radius, info.radius[2]), info.radius[0], info.radius[1]),
      yields: {
        metal: clamp(Math.round(num(y.metal, 0)), 0, RESOURCE_MAX),
        credits: clamp(Math.round(num(y.credits, 0)), 0, RESOURCE_MAX),
        science: clamp(Math.round(num(y.science, 0)), 0, RESOURCE_MAX),
      },
      color: isColor(b.color) ? b.color : info.color,
      surface: SURFACES.includes(b.surface) ? b.surface : info.surface,
      rings: !!b.rings && (b.type === 'gas-giant' || b.type === 'ice-giant' || b.type === 'terrestrial'),
      start: !!b.start && canStartOn(b.type),
      secret: (b.secret === 'random' || MAP_SECRETS.includes(b.secret)) && secretFits(b.secret, b.type) ? b.secret : null,
      lore: cleanText(b.lore, TEXT_LIMITS.lore),
      secretName: '',
      secretText: '',
    };
    // A hand-placed discovery can carry its own name and message. A
    // discovery left to chance has no fixed kind to describe, so none.
    if (body.secret && body.secret !== 'random') {
      body.secretName = cleanText(b.secretName, TEXT_LIMITS.secretName).replace(/\n/g, ' ');
      body.secretText = cleanText(b.secretText, TEXT_LIMITS.secretText);
    }
    if (b.type === 'rock') {
      const mn = b.mineral && typeof b.mineral === 'object' ? b.mineral : {};
      body.mineral = {
        kind: mn.kind === 'gold' ? 'gold' : 'metal',
        tons: clamp(Math.round(num(mn.tons, 1200) / 25) * 25, 200, 5000),
      };
      body.yields = { metal: 0, credits: 0, science: 0 };
      body.start = false;
      body.secret = null;
      body.secretName = '';
      body.secretText = '';
    }
    out.bodies.push(body);
  }
  // Parents before children, so the seeder can insert in order.
  out.bodies.sort((a, b) => (a.parent === 'sun' ? 0 : 1) - (b.parent === 'sun' ? 0 : 1));
  return out;
}

/** Bands sorted outward, never overlapping (a later band starts where
 *  the one inside it ends), each at least 10 wide, at most MAX_SECTORS. */
function normalizeSectors(input) {
  const raw = Array.isArray(input) ? input.slice(0, MAX_SECTORS * 2) : [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object' || !isSectorId(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    let inner = clamp(num(s.inner, 0), 0, ORBIT_LIMITS.sun[1] * 1.1);
    let outer = clamp(num(s.outer, inner + 100), 0, ORBIT_LIMITS.sun[1] * 1.1);
    if (outer < inner) [inner, outer] = [outer, inner];
    out.push({
      id: s.id,
      name: cleanName(s.name, 'Sector'),
      color: isColor(s.color) ? s.color : SECTOR_COLORS[out.length % SECTOR_COLORS.length],
      inner: Math.round(inner),
      outer: Math.round(outer),
    });
  }
  out.sort((a, b) => a.inner - b.inner);
  const kept = [];
  for (const s of out) {
    const prev = kept[kept.length - 1];
    if (prev && s.inner < prev.outer) s.inner = prev.outer;
    if (s.outer - s.inner < 10) continue;
    kept.push(s);
    if (kept.length >= MAX_SECTORS) break;
  }
  return kept;
}

/** The sector a body is in: by its own orbit, or (a moon) its planet's. */
export function sectorOf(map, body) {
  if (!map.sectors?.length) return null;
  let orbit = body.orbit;
  if (body.parent !== 'sun') {
    const p = map.bodies.find(x => x.id === body.parent);
    if (!p) return null;
    orbit = p.orbit;
  }
  return map.sectors.find(s => orbit >= s.inner && orbit < s.outer) ?? null;
}

/** A fresh sector id, unique within `taken`. */
export function newSectorId(taken, rand = Math.random) {
  for (;;) {
    const id = 's' + Math.floor(rand() * 36 ** 6).toString(36);
    if (!taken.has(id)) return id;
  }
}

function cleanName(v, fallback, max = MAX_NAME) {
  const s = typeof v === 'string' ? v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return s || fallback;
}

/** A body's year in ticks before the game's dials: Sol's law for the sun's
 *  children (scaled by its mass), Kepler on the parent's mass for moons. */
export function bodyYear(map, body) {
  if (body.parent === 'sun') {
    return SUN_YEAR_K * Math.pow(body.orbit, 1.5) / Math.sqrt(map.sun.mass || 1);
  }
  const p = map.bodies.find(x => x.id === body.parent);
  const mu = p ? TYPE_INFO[p.type].mu * (p.radius / TYPE_INFO[p.type].radius[2]) : 100;
  return 2 * Math.PI * Math.sqrt(Math.pow(body.orbit, 3) / Math.max(1, mu));
}

/** A world's sphere of influence: its type's, widened to hold its moons. */
export function bodySoi(map, body) {
  const base = TYPE_INFO[body.type].soi * (body.radius / TYPE_INFO[body.type].radius[2]);
  let reach = 0;
  for (const m of map.bodies) {
    if (m.parent === body.id) reach = Math.max(reach, m.orbit + TYPE_INFO.moon.soi + 4);
  }
  return Math.max(base, reach);
}

/** Where a body sits on the map (map units, sun at 0,0), at its angle. */
export function bodyPos(map, body, dAngle = 0) {
  if (body.parent === 'sun') {
    const a = body.angle + dAngle;
    return { x: Math.cos(a) * body.orbit, y: Math.sin(a) * body.orbit };
  }
  const p = map.bodies.find(x => x.id === body.parent);
  const pp = p ? bodyPos(map, p, dAngle) : { x: 0, y: 0 };
  const a = body.angle + dAngle * 3;
  return { x: pp.x + Math.cos(a) * body.orbit, y: pp.y + Math.sin(a) * body.orbit };
}

/** The worlds players may start on. Marked ones if any are marked; else
 *  the game's own rule: a planet, moon or dwarf of size 1.5+ with some
 *  science (worker/factions.js isCapitalWorthy + spawn floor). */
export function startWorlds(map) {
  const marked = map.bodies.filter(b => b.start && canStartOn(b.type));
  if (marked.length > 0) return { worlds: marked, marked: true };
  return {
    worlds: map.bodies.filter(b => canStartOn(b.type) && b.radius >= 1.5 && b.yields.science >= 2),
    marked: false,
  };
}

/**
 * THE CHECKLIST. Every issue the Map Maker shows, and the one the server
 * re-runs before hosting: level 'block' stops a game being hosted, 'warn'
 * is advice, 'ok' is a reassurance line. Each names the bodies involved
 * so "Show me" can select them.
 *
 * Titles and details are English (the server sends blocker titles in a
 * 409). `params` carries the counts and names each sentence is built
 * from, so the client can rebuild it in the player's language
 * (src/mapmaker/mmText.ts issueText, keyed by `code`).
 */
export function checkMap(input) {
  const map = normalizeMap(input);
  const out = [];
  const add = (level, code, title, detail, bodyIds = [], params = {}) => out.push({ level, code, title, detail, bodyIds, params });
  const world = map.bodies.filter(b => b.type !== 'rock');

  const st = startWorlds(map);
  if (st.worlds.length < 2) {
    add('block', 'too_few_starts', `Start worlds: ${st.worlds.length}`,
      st.marked
        ? 'A game needs at least 2. Mark more planets, moons or dwarfs with "Players may start here".'
        : 'A game needs at least 2 worlds a player can start on: a planet, moon or dwarf of medium size or bigger with science 2+.',
      st.worlds.map(b => b.id), { count: st.worlds.length, marked: st.marked });
  } else {
    add('ok', 'starts', `Start worlds: ${st.worlds.length}`,
      `${st.marked ? 'Marked by you.' : 'Picked automatically: planets, moons and dwarfs big enough, with science.'} Seats up to ${Math.min(10, st.worlds.length)} players.`,
      st.worlds.map(b => b.id), { count: st.worlds.length, marked: st.marked, seats: Math.min(10, st.worlds.length) });
    const dull = st.worlds.filter(b => b.yields.science < 2);
    if (dull.length) {
      add('warn', 'start_no_science', `${dull.length} start world${dull.length > 1 ? 's have' : ' has'} little science`,
        'Research needs science 2 or more at home. Players starting there will fall behind.', dull.map(b => b.id),
        { count: dull.length });
    }
    // Two start worlds in one moon system: next-door neighbours from tick 1.
    // So are a planet and a world sharing its ring: outside a sector the
    // game files a dwarf or loose moon within 5% of a planet's orbit as
    // part of that planet's system (worker/systems.js coOrbitalHosts), so
    // both homes would sit in one senate seat.
    const ringHost = (b) => {
      if (b.parent !== 'sun' || PLANET_TYPES.has(b.type) || sectorOf(map, b)) return null;
      const host = map.bodies.find(p => p.parent === 'sun' && PLANET_TYPES.has(p.type) && !sectorOf(map, p)
        && Math.abs(p.orbit - b.orbit) <= b.orbit * CO_ORBITAL_TOLERANCE);
      return host ? host.id : null;
    };
    const regionOf = (b) => (b.parent === 'sun' ? (ringHost(b) ?? b.id) : b.parent);
    const byRegion = new Map();
    for (const b of st.worlds) {
      const r = regionOf(b);
      byRegion.set(r, [...(byRegion.get(r) ?? []), b]);
    }
    const crowded = [...byRegion.values()].filter(g => g.length > 1);
    if (crowded.length) {
      add('warn', 'starts_close', 'Start worlds share a planet\'s orbit',
        `${crowded.map(g => g.map(b => b.name).join(' and ')).join('; ')} start as next-door neighbours. Their first wars will be early.`,
        crowded.flat().map(b => b.id), { groups: crowded.map(g => g.map(b => b.name)) });
    }
  }

  // Orbits that overlap: two of the sun's worlds whose spheres of
  // influence cross. Ships and labels pile up, and at full zoom-out one
  // hides behind the other.
  const suns = world.filter(b => b.parent === 'sun' && b.type !== 'asteroid')
    .sort((a, b) => a.orbit - b.orbit);
  const tight = [];
  for (let i = 1; i < suns.length; i++) {
    const a = suns[i - 1], b = suns[i];
    if (b.orbit - a.orbit >= (bodySoi(map, a) + bodySoi(map, b)) * 0.5) continue;
    // Worlds sharing (nearly) one orbit are only crowded if they also sit
    // close round it: a mirrored map puts four homes on one orbit a
    // quarter-turn apart, and that is the point, not a clash.
    const pa = bodyPos(map, a), pb = bodyPos(map, b);
    if (Math.abs(b.orbit - a.orbit) < 1 && Math.hypot(pa.x - pb.x, pa.y - pb.y) > (bodySoi(map, a) + bodySoi(map, b)) * 2) continue;
    tight.push([a, b]);
  }
  if (tight.length) {
    add('warn', 'orbits_close', `${tight.length} pair${tight.length > 1 ? 's' : ''} of orbits nearly touching`,
      `${tight.slice(0, 3).map(([a, b]) => `${a.name} and ${b.name}`).join('; ')}${tight.length > 3 ? '…' : ''}. Space them out so each world reads on its own.`,
      [...new Set(tight.flat().map(b => b.id))],
      { count: tight.length, pairs: tight.slice(0, 3).map(([a, b]) => [a.name, b.name]), more: tight.length > 3 });
  }

  // Moons that would leave their planet's pull.
  const strays = map.bodies.filter(b => b.parent !== 'sun' && b.orbit > 300);
  if (strays.length) {
    add('warn', 'moon_far', 'Moons far from their planet',
      `${strays.map(b => b.name).join(', ')} orbit${strays.length === 1 ? 's' : ''} very wide. They read as their planet's, but take a long trip to reach.`,
      strays.map(b => b.id), { count: strays.length, names: strays.map(b => b.name) });
  }

  // WORLDS INSIDE THE SUN. The game draws the sun at its size in map units
  // and every world at its radius (src/render/bodyPresentation.ts: true
  // radius x zoom), so a world whose near edge is inside size + margin
  // sits in the sun's disc and glow. Sizes run to 90, orbits from 60.
  const scorched = map.bodies.filter(b => b.parent === 'sun' && b.orbit - b.radius < map.sun.size + SUN_MARGIN);
  if (scorched.length) {
    add('warn', 'sun_close', `${scorched.length} world${scorched.length > 1 ? 's' : ''} inside the sun`,
      `${scorched.map(b => b.name).join(', ')} orbit${scorched.length === 1 ? 's' : ''} inside ${map.sun.name}'s disc. Move ${scorched.length === 1 ? 'it' : 'them'} out past ${Math.ceil(map.sun.size + SUN_MARGIN)}, or shrink the sun.`,
      scorched.map(b => b.id), { count: scorched.length, names: scorched.map(b => b.name), sun: map.sun.name, min: Math.ceil(map.sun.size + SUN_MARGIN) });
  }

  // MOONS INSIDE THEIR PLANET: the moon's disc touches the planet's.
  const byId = new Map(map.bodies.map(b => [b.id, b]));
  const sunk = map.bodies.filter(b => {
    const p = b.parent !== 'sun' ? byId.get(b.parent) : null;
    return !!p && b.orbit - b.radius < p.radius + MOON_MARGIN;
  });
  if (sunk.length) {
    add('warn', 'moon_inside', `${sunk.length} moon${sunk.length > 1 ? 's' : ''} inside ${sunk.length > 1 ? 'their planets' : 'its planet'}`,
      `${sunk.map(b => b.name).join(', ')} orbit${sunk.length === 1 ? 's' : ''} so close ${sunk.length === 1 ? 'it overlaps its' : 'they overlap their'} planet. Widen the orbit.`,
      sunk.map(b => b.id), { count: sunk.length, names: sunk.map(b => b.name) });
  }

  // MOON SYSTEMS THAT OVERLAP. The game keeps a custom map's moons at
  // their drawn orbits (worker/factions.js effectiveMoonScale never
  // shrinks a custom map below 1), so two worlds whose moons reach into
  // each other's space stay that way. Same test as the game's clamp:
  // 90% of the gap against both moon reaches. Pairs orbits_close already
  // names are left to it.
  const reachOf = (b) => map.bodies.reduce((r, m) => (m.parent === b.id ? Math.max(r, m.orbit) : r), 0);
  const tightKey = new Set(tight.map(([a, b]) => `${a.id}|${b.id}`));
  const tangled = [];
  for (let i = 0; i < suns.length; i++) {
    for (let j = i + 1; j < suns.length; j++) {
      const a = suns[i], b = suns[j];
      const reach = reachOf(a) + reachOf(b);
      if (!reach || Math.abs(b.orbit - a.orbit) < 1) continue;
      if (Math.abs(b.orbit - a.orbit) * 0.9 >= reach) continue;
      if (tightKey.has(`${a.id}|${b.id}`)) continue;
      tangled.push([a, b]);
    }
  }
  if (tangled.length) {
    add('warn', 'moons_overlap', `${tangled.length} pair${tangled.length > 1 ? 's' : ''} of moon systems overlapping`,
      `${tangled.slice(0, 3).map(([a, b]) => `${a.name} and ${b.name}`).join('; ')}${tangled.length > 3 ? '…' : ''}. Their moons cross each other's space; space the worlds out or pull the moons in.`,
      [...new Set(tangled.flat().map(b => b.id))],
      { count: tangled.length, pairs: tangled.slice(0, 3).map(([a, b]) => [a.name, b.name]), more: tangled.length > 3 });
  }

  const names = new Map();
  for (const b of [{ id: 'sun', name: map.sun.name }, ...map.bodies]) {
    const k = b.name.toLowerCase();
    names.set(k, [...(names.get(k) ?? []), b.id]);
  }
  const dupes = [...names.values()].filter(ids => ids.length > 1);
  if (dupes.length) {
    add('warn', 'names_dup', `${dupes.length} name${dupes.length > 1 ? 's are' : ' is'} used twice`,
      'Players tell worlds apart by name. Give each its own.', dupes.flat().filter(id => id !== 'sun'),
      { count: dupes.length });
  } else {
    add('ok', 'names', 'Names', 'Every world has its own name.');
  }

  const tot = world.reduce((s, b) => ({
    metal: s.metal + b.yields.metal, credits: s.credits + b.yields.credits, science: s.science + b.yields.science,
  }), { metal: 0, credits: 0, science: 0 });
  if (tot.metal + tot.credits + tot.science === 0) {
    add('warn', 'no_resources', 'No resources anywhere', 'Nothing on this map yields metal, credits or science. Nobody can build.');
  } else {
    for (const [k, label] of [['metal', 'metal'], ['credits', 'credits'], ['science', 'science']]) {
      if (tot[k] === 0) add('warn', `none_${k}`, `No ${label} on the map`, `Nothing yields ${label}. Players will be stuck without it.`);
    }
    add('ok', 'resources', 'Resources across the map',
      `Metal ${tot.metal} · credits ${tot.credits} · science ${tot.science} per tick if every world is claimed.`,
      [], { ...tot });
  }

  if (map.sectors.length) {
    const worldsIn = (s) => world.filter(b => sectorOf(map, b)?.id === s.id);
    const empty = map.sectors.filter(s => worldsIn(s).length === 0);
    if (empty.length) {
      add('warn', 'sector_empty', `${empty.length} empty sector${empty.length > 1 ? 's' : ''}`,
        `${empty.map(s => s.name).join(', ')} hold${empty.length === 1 ? 's' : ''} no worlds: nobody can ever control ${empty.length === 1 ? 'it' : 'them'}. Widen ${empty.length === 1 ? 'it' : 'them'} or move a world in.`,
        [], { count: empty.length, names: empty.map(s => s.name) });
    }
    // START WORLDS SHARING A SECTOR (the four-agent playtest, 2026-10-15:
    // four mirrored homes on one orbit sat in one band, so the senate saw
    // a four-way tie for 650 ticks and every empire stayed at one vote).
    // Bands are orbits, so homes on one orbit always share a band. That
    // can be the point (a brawl over the home ring), so this warns.
    const starts = startWorlds(map).worlds;
    for (const s of map.sectors) {
      const here = starts.filter(b => sectorOf(map, b)?.id === s.id);
      if (here.length < 2) continue;
      add('warn', 'sector_starts', `${here.length} start worlds share ${s.name}`,
        `${here.map(b => b.name).join(', ')} all start in ${s.name}. It is contested from the first tick and gives nobody a senate vote until one empire holds most of it. Fine for a brawl over the home ring; for a race, give each home a band of its own.`,
        here.map(b => b.id), { count: here.length, sector: s.name, names: here.map(b => b.name) });
    }
    const loose = world.filter(b => b.parent === 'sun' && !sectorOf(map, b));
    if (loose.length) {
      add('warn', 'sector_loose', `${loose.length} world${loose.length > 1 ? 's' : ''} outside every sector`,
        'They group the automatic way (a planet with its moons, rubble into belts). Widen a band to take them in, if you mean them to belong.',
        loose.map(b => b.id), { count: loose.length });
    }
    const names = new Map();
    for (const s of map.sectors) names.set(s.name.toLowerCase(), (names.get(s.name.toLowerCase()) ?? 0) + 1);
    if ([...names.values()].some(n => n > 1)) {
      add('warn', 'sector_names', 'Two sectors share a name', 'The senate and the outliner name sectors; give each its own.');
    }
    add('ok', 'sectors', `${map.sectors.length} sector${map.sectors.length > 1 ? 's' : ''}`,
      `${map.sectors.map(s => `${s.name} (${worldsIn(s).length})`).join(' · ')}. Each is one vote in the senate for whoever holds most of its worlds.`,
      [], { count: map.sectors.length, list: map.sectors.map(s => [s.name, worldsIn(s).length]) });
  }

  const secrets = map.bodies.filter(b => b.secret);
  const placed = secrets.filter(b => b.secret !== 'random').length;
  add('ok', 'secrets', 'Discoveries',
    secrets.length
      ? `${placed} hand-placed, ${secrets.length - placed} left to chance.`
      : 'None hidden. Add some from a world\'s Secrets tab, or leave the map without.',
    [], { placed, chance: secrets.length - placed });
  if (map.bodies.length >= MAX_BODIES) {
    add('warn', 'max_bodies', `${MAX_BODIES} bodies`, 'That is the most one map can hold.', [], { max: MAX_BODIES });
  }
  return out;
}

/** Hosting is refused while any issue is a blocker. */
export function hostBlockers(map) {
  return checkMap(map).filter(i => i.level === 'block');
}

/**
 * THE BRIDGE TO THE SEEDER: catalogue entries in BODY_CATALOG's shape,
 * parents first, before the game's dials (worker/factions.js scales them
 * with scaledGeometry like any Sol body). The sun keeps the id 'sol' --
 * the whole game finds the star by that id -- under the map's own name.
 * Every other id is `cm_<id>`, so a custom world can never inherit a
 * shipped world's art or flavour by sharing its id.
 */
export function mapToCatalog(input) {
  const map = normalizeMap(input);
  const idOf = (id) => (id === 'sun' ? 'sol' : `cm_${id}`);
  const out = [{
    id: 'sol', name: map.sun.name, type: 'star', parent: null,
    radius: map.sun.size, soi: null, mu: 0,
    orbit_radius: 0, orbit_period: 0, angle0: 0,
    color: map.sun.color,
    yield: { metal: 0, fuel: 0, gold: 0, science: 0 },
    // The sun's colour, and the map's sky (deep space draws nothing extra).
    look: { star: map.sun.color, ...(map.settings.backdrop && map.settings.backdrop !== 'deep' ? { backdrop: map.settings.backdrop } : {}) },
  }];
  for (const b of map.bodies) {
    const info = TYPE_INFO[b.type];
    const sec = sectorOf(map, b);
    const entry = {
      id: idOf(b.id),
      name: b.name,
      type: b.type === 'rock' ? 'meteoroid' : b.type,
      parent: idOf(b.parent),
      radius: b.radius,
      soi: b.type === 'rock' ? 0 : Math.round(bodySoi(map, b) * 10) / 10,
      mu: b.type === 'rock' ? 0 : info.mu * (b.radius / info.radius[2]),
      orbit_radius: b.orbit,
      orbit_period: Math.max(4, bodyYear(map, b)),
      angle0: b.angle,
      color: b.color,
      yield: { metal: b.yields.metal, fuel: 0, gold: b.yields.credits, science: b.yields.science },
      look: {
        surface: b.surface, rings: b.rings,
        ...(b.lore ? { lore: b.lore } : {}),
        // The sector travels with each body (look_json), so every place
        // that groups bodies -- server and client -- reads it off the row
        // it already has. Band radii stay in map units; the game draws a
        // sector round its members' real (scaled) orbits.
        ...(sec ? { sector: { id: sec.id, name: sec.name, color: sec.color } } : {}),
      },
      custom_start: b.start,
      custom_secret: b.secret,
      custom_secret_name: b.secretName || null,
      custom_secret_text: b.secretText || null,
    };
    if (b.type === 'rock') {
      entry.mineral_kind = b.mineral.kind;
      entry.mineral_initial = b.mineral.tons;
    }
    out.push(entry);
  }
  return out;
}

/** The ids (catalogue form) players may start on. */
export function startTemplateIds(input) {
  const map = normalizeMap(input);
  return new Set(startWorlds(map).worlds.map(b => `cm_${b.id}`));
}

// ---------------------------------------------------------------------------
// NAMES. Themes for the dice button and "Rename by theme".
// ---------------------------------------------------------------------------
const THEMES = {
  Mythic: {
    a: ['Aeth', 'Bront', 'Cal', 'Dra', 'Eir', 'Fen', 'Gal', 'Hel', 'Iss', 'Kor', 'Ly', 'Mor', 'Ner', 'Or', 'Pyr', 'Rhe', 'Sel', 'Thal', 'Ur', 'Vey', 'Zeph'],
    b: ['a', 'e', 'i', 'o', 'ae', 'ei'],
    c: ['ra', 'nos', 'tes', 'lyx', 'ssa', 'rion', 'thea', 'mir', 'dor', 'phae', 'los', 'rak'],
  },
  Latin: {
    a: ['Aur', 'Caec', 'Ferr', 'Glac', 'Ign', 'Lap', 'Lum', 'Noct', 'Pall', 'Rub', 'Sil', 'Terr', 'Umbr', 'Vit', 'Aqu', 'Fulg'],
    b: ['i', 'a', 'e', 'u'],
    c: ['us', 'a', 'um', 'is', 'ae', 'ia', 'ens', 'or'],
  },
  Corporate: {
    a: ['Halcyon', 'Meridian', 'Vantage', 'Apex', 'Kestrel', 'Lattice', 'Nimbus', 'Quorum', 'Ridgeline', 'Summit', 'Tessera', 'Vector'],
    b: [' '], c: ['One', 'Prime', 'Works', 'Holdings', 'Reach', 'Station', 'Yards', 'Point', 'Annex', 'Labs'],
  },
  Whimsical: {
    a: ['Biscuit', 'Pickle', 'Noodle', 'Puddle', 'Wobble', 'Marble', 'Teacup', 'Pebble', 'Dumpling', 'Crumpet', 'Fizz', 'Mitten'],
    b: [' '], c: ['Rock', 'Ball', 'World', 'Place', 'Lump', 'Top', 'Moon', 'Patch'],
  },
};
export const NAME_THEMES = ['Mythic', 'Latin', 'Corporate', 'Numbered', 'Whimsical'];

/** A name in `theme`, avoiding `taken` (lower-case). `rand` for seeding. */
export function makeName(theme, taken = new Set(), rand = Math.random, index = 0, sunName = 'Helion') {
  if (theme === 'Numbered') {
    const greek = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'];
    for (let i = index; i < index + 400; i++) {
      const n = i < greek.length ? `${sunName} ${greek[i]}` : `${sunName} ${i + 1}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }
  const t = THEMES[theme] ?? THEMES.Mythic;
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  for (let i = 0; i < 60; i++) {
    const n = theme === 'Corporate' || theme === 'Whimsical'
      ? `${pick(t.a)}${pick(t.b)}${pick(t.c)}`
      : `${pick(t.a)}${rand() < 0.4 ? pick(t.b) : ''}${pick(t.c)}`;
    const name = n.charAt(0).toUpperCase() + n.slice(1);
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `${pick(t.a)} ${Math.floor(rand() * 900 + 100)}`;
}

/** A seeded random stream, for the generator and the dice. */
export function seededRand(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * THE GENERATOR ("Generate one for me"): a whole system from a few
 * sliders, which the player then edits like any other map.
 *   planets 3-14, moons [min,max] per planet, belts 0-3,
 *   richness 0.5 (lean) .. 2 (generous), starts 2-10, spread 0.7..1.5.
 */
export function generateMap(opts = {}) {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
  const rand = seededRand(seed);
  const theme = opts.theme ?? 'Mythic';
  const planets = clamp(Math.round(num(opts.planets, 7)), 2, 14);
  const moonsMin = clamp(Math.round(num(opts.moonsMin, 0)), 0, 5);
  const moonsMax = clamp(Math.round(num(opts.moonsMax, 3)), moonsMin, 6);
  const belts = clamp(Math.round(num(opts.belts, 1)), 0, 3);
  const rich = clamp(num(opts.richness, 1), 0.4, 2.5);
  const starts = clamp(Math.round(num(opts.starts, 8)), 2, 10);
  const spread = clamp(num(opts.spread, 1), 0.6, 1.6);
  const map = blankMap(opts.name ?? 'Generated system');
  const taken = new Set();
  const ids = new Set();
  map.sun.name = makeName(theme, taken, rand);
  taken.add(map.sun.name.toLowerCase());
  map.sun.color = ['#ffd180', '#ffe9b0', '#ffb36b', '#fff4e0', '#ff9b6b'][Math.floor(rand() * 5)];
  const name = (i) => { const n = makeName(theme, taken, rand, i, map.sun.name); taken.add(n.toLowerCase()); return n; };
  const id = () => { const x = newBodyId(ids, rand); ids.add(x); return x; };
  const r = (lo, hi) => lo + rand() * (hi - lo);
  const yields = (bias) => {
    const base = () => Math.round(r(0, 6) * rich);
    const y = { metal: base(), credits: base(), science: base() };
    if (bias) y[bias] = Math.min(RESOURCE_MAX, y[bias] + Math.round(r(3, 7) * rich));
    return y;
  };
  // Orbits on a loose geometric ladder, Mercury-close to Kuiper-far.
  let orbit = 150 * spread;
  const beltSlots = new Set();
  for (let i = 0; i < belts; i++) beltSlots.add(Math.floor(r(1, planets)));
  for (let i = 0; i < planets; i++) {
    orbit *= r(1.32, 1.6);
    if (beltSlots.has(i)) {
      const n = Math.round(r(5, 9));
      for (let k = 0; k < n; k++) {
        map.bodies.push({
          id: id(), name: name(i), type: 'asteroid', parent: 'sun',
          orbit: orbit * r(0.97, 1.03), angle: (k / n) * Math.PI * 2 + r(-0.2, 0.2),
          radius: r(0.5, 1), yields: yields('metal'), color: '#8f8676', surface: 'barren',
        });
      }
      orbit *= r(1.25, 1.4);
    }
    const outer = orbit > 1400 * spread;
    const type = outer ? (rand() < 0.55 ? 'gas-giant' : rand() < 0.6 ? 'ice-giant' : 'dwarf')
      : (rand() < 0.15 ? 'gas-giant' : 'terrestrial');
    const info = TYPE_INFO[type];
    const surface = type === 'terrestrial' ? ['verdant', 'ocean', 'desert', 'rocky', 'lava', 'toxic', 'ice'][Math.floor(rand() * 7)] : info.surface;
    const color = {
      verdant: '#4f8a3c', ocean: '#2f8fd6', desert: '#c9a36b', rocky: '#9a8a78', lava: '#d65a2a', toxic: '#9ab83c', ice: '#cfe8f2',
      gas: ['#d4a574', '#c98b5a', '#e0c08a'][Math.floor(rand() * 3)], barren: '#c8b898',
    }[surface] ?? info.color;
    const p = {
      id: id(), name: name(i), type, parent: 'sun', orbit, angle: r(0, Math.PI * 2),
      radius: r(info.radius[0] + (info.radius[2] - info.radius[0]) * 0.5, info.radius[1] * 0.85),
      yields: yields(['metal', 'credits', 'science'][Math.floor(rand() * 3)]),
      color, surface, rings: type !== 'terrestrial' && rand() < 0.35,
    };
    map.bodies.push(p);
    const moons = Math.round(r(moonsMin, moonsMax + (type === 'gas-giant' ? 2 : 0)));
    let mo = p.radius * 4 + 8;
    for (let k = 0; k < moons; k++) {
      mo *= r(1.35, 1.7);
      map.bodies.push({
        id: id(), name: name(i), type: 'moon', parent: p.id, orbit: Math.min(mo, 260), angle: r(0, Math.PI * 2),
        radius: r(0.8, 2.2), yields: yields(), color: '#a0a6ad', surface: rand() < 0.3 ? 'ice' : 'barren',
      });
    }
  }
  // Start worlds: the most liveable, spread across regions, science topped up.
  const cands = map.bodies.filter(b => canStartOn(b.type) && b.radius >= 1.5)
    .sort((a, b) => (b.yields.science + b.radius) - (a.yields.science + a.radius));
  const used = new Set();
  for (const b of cands) {
    if (map.bodies.filter(x => x.start).length >= starts) break;
    const region = b.parent === 'sun' ? b.id : b.parent;
    if (used.has(region)) continue;
    used.add(region);
    b.start = true;
    b.yields.science = Math.max(b.yields.science, 2);
  }
  // A few discoveries left to chance, on worlds nobody starts on.
  const free = map.bodies.filter(b => !b.start && b.type !== 'rock');
  for (let i = 0; i < Math.min(4, free.length); i++) {
    free.splice(Math.floor(rand() * free.length), 1)[0].secret = 'random';
  }
  map.name = opts.name ?? `${map.sun.name} system`;
  return normalizeMap(map);
}
