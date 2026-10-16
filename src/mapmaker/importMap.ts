// ============================================================
// IMPORT A MAP FROM TEXT — a file someone exported, or what an AI chat
// answered when asked for a system (aiPrompt.ts). The AI part is why this
// is forgiving: the JSON may sit inside prose or a ``` fence, carry
// comments and trailing commas, nest moons inside their planets, name a
// parent instead of giving its id, measure orbits in AU or km and angles
// in degrees, and spell types and keys its own way. Everything it can
// read becomes a CustomMap through normalizeMap (the same cleaning the
// server does), and every change that matters to the author comes back
// as a note, so the editor can say what was altered instead of hiding it.
//
// Pure: no DOM, no fetch. The Workshop opens the result unsaved.
// ============================================================

import {
  BACKDROPS, MAP_SECRETS, MAX_BODIES, MAX_SECTORS, ORBIT_LIMITS, RESOURCE_MAX, SUN_LIMITS, SURFACES,
  TYPE_INFO, canStartOn, newBodyId, newSectorId, normalizeMap, secretFits,
} from '../game/customMap';
import type { CustomMap, MapBodyType, MapSecret, MapSurface } from '../game/customMap';

/** Longest text the importer reads (the server caps a saved map at 200KB). */
export const IMPORT_MAX_CHARS = 1_000_000;

export type ImportNoteCode =
  | 'overCap' | 'skipped' | 'auOrbits' | 'kmOrbits' | 'kmMoons' | 'orbitsMade' | 'orbitsClamped' | 'degrees'
  | 'kmRadius' | 'yieldsScaled' | 'typeGuessed' | 'madeMoons' | 'moonsLifted' | 'orphanMoons'
  | 'startsDropped' | 'secretUnknown' | 'secretsDropped' | 'surfaceUnknown' | 'sectorsDropped' | 'parentByName';

/** One thing the importer changed or guessed. `n` counts it; `names`
 *  lists up to a few of the worlds involved. */
export interface ImportNote { code: ImportNoteCode; n: number; names?: string[] }

export type ImportError = 'empty' | 'tooBig' | 'noJson' | 'badJson' | 'notAMap';
export type ImportResult =
  | { ok: true; map: CustomMap; notes: ImportNote[] }
  | { ok: false; error: ImportError; detail?: string };

// ---- reading the JSON out of the text -------------------------------------

/** The JSON in `text`: the whole of it, else a ``` fence, else the span
 *  from the first brace to the last. Each is tried as strict JSON first,
 *  then loosened (comments, trailing commas, single or curly quotes,
 *  bare keys, Python's True/None). */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: 'noJson' | 'badJson'; detail?: string } {
  const src = text.replace(/^﻿/, '').trim();
  const candidates: string[] = [src];
  for (const m of src.matchAll(/```[a-zA-Z]*[^\S\n]*\n?([\s\S]*?)```/g)) candidates.push(m[1].trim());
  // Every top-level {...} or [...] in the prose, biggest first: an answer
  // that shows a format sketch before the real map still finds the map.
  candidates.push(...balancedBlocks(src).sort((a, b) => b.length - a.length).slice(0, 12));
  const firstObj = src.indexOf('{'), lastObj = src.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(src.slice(firstObj, lastObj + 1));
  const firstArr = src.indexOf('['), lastArr = src.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(src.slice(firstArr, lastArr + 1));
  const shaped = candidates.filter(c => /^[[{]/.test(c));
  if (!shaped.length) return { ok: false, error: 'noJson' };
  let detail: string | undefined;
  for (const c of shaped) {
    for (const pass of [(s: string) => s, loosen]) {
      try {
        const v: unknown = JSON.parse(pass(c));
        if (v && typeof v === 'object') return { ok: true, value: v };
      } catch (e) {
        detail ??= e instanceof Error ? e.message : String(e);
      }
    }
  }
  return { ok: false, error: 'badJson', detail };
}

/** The spans of `src` that open with { or [ and close at the matching
 *  bracket, outside any string. */
function balancedBlocks(src: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (depth > 0 && c === '"') { quote = c; continue; }
    if (c === '{' || c === '[') { if (depth++ === 0) start = i; }
    else if ((c === '}' || c === ']') && depth > 0 && --depth === 0) out.push(src.slice(start, i + 1));
  }
  return out;
}

const OPEN_QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '”': '”', '‘': '’' };
const BARE_WORDS: Record<string, string> = { True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null' };

/** JSON-ish to JSON. A small scanner, so nothing inside a string is
 *  touched. */
function loosen(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  /** Index of the next character that is not space or a comment. */
  const skip = (j: number): number => {
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (src[j] === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
      return j;
    }
  };
  while (i < n) {
    const c = src[i];
    const close = OPEN_QUOTES[c];
    if (close) {
      let s = '';
      i++;
      while (i < n && src[i] !== close && !(close === '”' && src[i] === '"')) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          // \' is not a JSON escape; the rest pass through.
          s += src[i + 1] === "'" ? "'" : ch + src[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') s += '\\"';
        else if (ch === '\n') s += '\\n';
        else if (ch === '\r') s += '';
        else if (ch === '\t') s += '\\t';
        else s += ch;
        i++;
      }
      i++;
      out += `"${s}"`;
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skip(i); continue; }
    if (c === ',') {
      const j = skip(i + 1);
      if (src[j] === '}' || src[j] === ']') { i = j; continue; }
    }
    if (/[A-Za-z_$]/.test(c) && !/[0-9.]/.test(src[i - 1] ?? '')) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      // A bare key, a Python constant, or a bare word as a value
      // (type: planet) read as the string it meant.
      if (src[skip(j)] === ':') out += JSON.stringify(word);
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else out += BARE_WORDS[word] ?? JSON.stringify(word);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---- small readers --------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Keys compared without case, spaces, dashes or underscores. */
const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** The first of `keys` present on `o` (keys matched loosely). */
function pick(o: Obj, keys: string[]): unknown {
  const want = keys.map(squash);
  for (const w of want) {
    for (const k of Object.keys(o)) if (squash(k) === w && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}

/** A number with an optional unit: 1.5, "1.5 AU", "384,400 km", "45°". */
function quantity(v: unknown): { n: number; unit: '' | 'au' | 'km' | 'deg' | 'rad' } | null {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v, unit: '' } : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const m = /^(-?[\d.]+(?:e[+-]?\d+)?)\s*(million|billion)?\s*([a-z°]*)/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'million') n *= 1e6;
  if (m[2] === 'billion') n *= 1e9;
  const u = m[3];
  const unit = u === 'au' ? 'au' : /^(km|kilomet)/.test(u) ? 'km' : /^(°|deg)/.test(u) ? 'deg' : /^rad/.test(u) ? 'rad' : '';
  return { n, unit };
}

const truthy = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(yes|true|y|1|x)$/i.test(v.trim()));
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function hexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  return null;
}

// ---- the vocabularies -----------------------------------------------------

const TYPE_ALIASES: Record<string, MapBodyType> = {
  terrestrial: 'terrestrial', planet: 'terrestrial', rocky: 'terrestrial', rockyplanet: 'terrestrial',
  terrestrialplanet: 'terrestrial', earthlike: 'terrestrial', superearth: 'terrestrial', terran: 'terrestrial',
  world: 'terrestrial', habitable: 'terrestrial', oceanworld: 'terrestrial', desertworld: 'terrestrial',
  gasgiant: 'gas-giant', jovian: 'gas-giant', giant: 'gas-giant', gas: 'gas-giant', gasplanet: 'gas-giant', hotjupiter: 'gas-giant',
  icegiant: 'ice-giant', neptunian: 'ice-giant', uranian: 'ice-giant', minineptune: 'ice-giant',
  dwarf: 'dwarf', dwarfplanet: 'dwarf', plutoid: 'dwarf', planetoid: 'dwarf', tno: 'dwarf', kuiperobject: 'dwarf',
  moon: 'moon', satellite: 'moon', naturalsatellite: 'moon', moonlet: 'moon',
  asteroid: 'asteroid', minorplanet: 'asteroid', planetesimal: 'asteroid',
  rock: 'rock', meteoroid: 'rock', ore: 'rock', orerock: 'rock', comet: 'rock', mineral: 'rock', miningrock: 'rock', debris: 'rock',
};
/** Collection keys that say what their members are. */
const LIST_KEYS: Array<[string, MapBodyType | null]> = [
  ['bodies', null], ['worlds', null], ['objects', null], ['celestialbodies', null], ['orbiters', null],
  ['planets', 'terrestrial'], ['gasgiants', 'gas-giant'], ['icegiants', 'ice-giant'],
  ['dwarfs', 'dwarf'], ['dwarfplanets', 'dwarf'], ['asteroids', 'asteroid'], ['moons', 'moon'],
  ['rocks', 'rock'], ['meteoroids', 'rock'],
];
/** Keys under a body that hold what orbits it. */
const CHILD_KEYS = ['moons', 'satellites', 'children', 'orbiters', 'bodies'];

const SURFACE_ALIASES: Record<string, MapSurface> = {
  verdant: 'verdant', jungle: 'verdant', forest: 'verdant', green: 'verdant', lush: 'verdant', temperate: 'verdant', earthlike: 'verdant', garden: 'verdant', habitable: 'verdant',
  ocean: 'ocean', water: 'ocean', oceanic: 'ocean', sea: 'ocean', aquatic: 'ocean',
  desert: 'desert', arid: 'desert', sand: 'desert', dune: 'desert', dry: 'desert',
  rocky: 'rocky', rock: 'rocky', stone: 'rocky', mountainous: 'rocky', cratered: 'rocky',
  barren: 'barren', dead: 'barren', grey: 'barren', gray: 'barren', airless: 'barren', dust: 'barren',
  ice: 'ice', icy: 'ice', frozen: 'ice', snow: 'ice', glacial: 'ice', tundra: 'ice',
  lava: 'lava', volcanic: 'lava', molten: 'lava', magma: 'lava', infernal: 'lava',
  toxic: 'toxic', acid: 'toxic', acidic: 'toxic', poison: 'toxic', sulfur: 'toxic', sulphur: 'toxic', haze: 'toxic',
  gas: 'gas', banded: 'gas', gaseous: 'gas', clouds: 'gas', cloudy: 'gas',
  storm: 'storm', stormy: 'storm', storms: 'storm', tempest: 'storm', cyclone: 'storm',
};

const SECRET_ALIASES: Record<string, MapSecret | 'random'> = {
  random: 'random', chance: 'random', unknown: 'random', mystery: 'random', surprise: 'random', any: 'random', yes: 'random', true: 'random',
  ancientcity: 'ancient_city', city: 'ancient_city', ruins: 'ancient_city', lostcity: 'ancient_city',
  preterraformed: 'pre_terraformed', terraformed: 'pre_terraformed',
  derelictwarship: 'derelict_warship', derelict: 'derelict_warship', warship: 'derelict_warship', wreck: 'derelict_warship', destroyer: 'derelict_warship',
  resourcecache: 'resource_cache', cache: 'resource_cache', stash: 'resource_cache', hoard: 'resource_cache',
  ancientdatabank: 'ancient_databank', databank: 'ancient_databank', archive: 'ancient_databank', library: 'ancient_databank',
  ancientcapital: 'ancient_capital', capitalship: 'ancient_capital', megadestroyer: 'ancient_capital', foundry: 'ancient_capital',
  ancientrelay: 'ancient_relay', relay: 'ancient_relay', sensorrelay: 'ancient_relay', beacon: 'ancient_relay',
  ancientstation: 'ancient_station', station: 'ancient_station', weaponsstation: 'ancient_station', fortress: 'ancient_station', turret: 'ancient_station',
  deepcache: 'deep_cache', vault: 'deep_cache',
};

const BACKDROP_ALIASES: Record<string, CustomMap['settings']['backdrop']> = {
  deep: 'deep', black: 'deep', dark: 'deep', deepspace: 'deep', none: 'deep', default: 'deep', space: 'deep',
  blue: 'blue', azure: 'blue', cyan: 'blue', teal: 'blue', navy: 'blue',
  crimson: 'crimson', red: 'crimson', scarlet: 'crimson', blood: 'crimson',
  emerald: 'emerald', green: 'emerald', jade: 'emerald',
  violet: 'violet', purple: 'violet', magenta: 'violet', indigo: 'violet', pink: 'violet',
  amber: 'amber', gold: 'amber', golden: 'amber', orange: 'amber', yellow: 'amber', brown: 'amber',
};

/** A star's spectral class to the colour of its light. */
const STAR_CLASS: Record<string, string> = {
  O: '#9bb0ff', B: '#aabfff', A: '#cad7ff', F: '#f8f4e8', G: '#ffd180', K: '#ffb26b', M: '#ff7b4f',
};
const SUN_WORDS = new Set(['sun', 'star', 'sol', 'primary', 'root', 'system', 'center', 'centre']);

/** A planet's radius in km to map units: Earth (6371 km) is 3, and the
 *  square root keeps Jupiter (69911 km) at about 10 rather than 33. */
const kmToRadius = (km: number) => 3 * Math.sqrt(km / 6371);
/** Map units per AU (Earth's orbit) and per km from a moon's planet (the
 *  Moon's 384,400 km is 20). */
const AU = 372;
const KM_PER_AU = 149_597_871;
const MOON_KM = 20 / 384_400;
const MOON_AU = KM_PER_AU * MOON_KM;

// ---- the importer ---------------------------------------------------------

interface Flat {
  src: Obj;
  /** Index in `flat` of the world this was nested under. */
  nestedIn: number | null;
  hint: MapBodyType | null;
  name: string;
  id: string;
}

/** Text in, map out (or why not). */
export function importMapText(raw: string): ImportResult {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  if (raw.length > IMPORT_MAX_CHARS) return { ok: false, error: 'tooBig' };
  const parsed = extractJson(raw);
  if (!parsed.ok) return parsed;
  return importMapValue(parsed.value);
}

/** The root of a parsed value: the map itself, or a wrapper round it. */
function findRoot(v: unknown): Obj | null {
  if (Array.isArray(v)) {
    // A list of maps (take the first), or a list of bodies.
    const first = v.find(isObj);
    if (first && (first.bodies || first.planets || first.sun || first.star)) return findRoot(first);
    return { bodies: v };
  }
  if (!isObj(v)) return null;
  for (const k of ['map', 'system', 'starSystem', 'solarSystem', 'customMap', 'data', 'result']) {
    const inner = pick(v, [k]);
    if (isObj(inner) && (pick(inner, ['bodies', 'planets', 'worlds', 'sun', 'star', 'objects']) !== undefined)) return inner;
  }
  return v;
}

/** A parsed value to a map (exported for the tests). */
export function importMapValue(value: unknown): ImportResult {
  const root = findRoot(value);
  if (!root) return { ok: false, error: 'notAMap' };
  const notes = new Map<ImportNoteCode, ImportNote>();
  const note = (code: ImportNoteCode, name?: string, by = 1) => {
    const it = notes.get(code) ?? { code, n: 0, names: [] };
    it.n += by;
    if (name && it.names!.length < 4 && !it.names!.includes(name)) it.names!.push(name);
    notes.set(code, it);
  };

  // The star: an object, a name, or loose keys on the root.
  const starRaw = pick(root, ['sun', 'star', 'primary', 'centralStar']);
  const star: Obj = isObj(starRaw) ? starRaw : typeof starRaw === 'string' ? { name: starRaw } : {};
  const spectral = text(pick(star, ['spectralClass', 'spectralType', 'class', 'type']) ?? pick(root, ['spectralClass', 'starClass'])).trim().toUpperCase();
  const sunColor = hexColor(pick(star, ['color', 'colour', 'hex'])) ?? hexColor(pick(root, ['starColor', 'sunColor'])) ?? STAR_CLASS[spectral[0]] ?? undefined;
  const sunSizeQ = quantity(pick(star, ['size', 'radius']));
  const sunMassQ = quantity(pick(star, ['mass', 'solarMass', 'solarMasses']));
  const sunName = text(pick(star, ['name', 'title']) ?? pick(root, ['starName', 'sunName'])).trim();

  // Every body, flat, remembering what it was nested under.
  const flat: Flat[] = [];
  let skipped = 0;
  const walk = (list: unknown, hint: MapBodyType | null, nestedIn: number | null, depth: number) => {
    if (!Array.isArray(list)) {
      // { "Earth": {...}, "Mars": {...} } — keyed by name.
      if (isObj(list)) {
        walk(Object.entries(list).map(([k, b]) => (isObj(b) ? { name: k, ...b } : b)), hint, nestedIn, depth);
      }
      return;
    }
    for (const item of list) {
      // "moons": ["Phobos", "Deimos"] names worlds without saying more.
      const b = typeof item === 'string' && item.trim() ? { name: item } : item;
      if (!isObj(b)) { skipped++; continue; }
      const i = flat.length;
      flat.push({ src: b, nestedIn, hint, name: text(pick(b, ['name', 'title', 'label'])).trim(), id: '' });
      if (depth < 4) {
        for (const k of CHILD_KEYS) {
          const kids = pick(b, [k]);
          if (kids !== undefined && typeof kids === 'object') walk(kids, k === 'moons' || k === 'satellites' ? 'moon' : null, i, depth + 1);
        }
      }
    }
  };
  const listed = new Set<unknown>();
  for (const [key, hint] of LIST_KEYS) {
    const list = pick(root, [key]);
    if (list && typeof list === 'object' && !listed.has(list)) { listed.add(list); walk(list, hint, null, 0); }
  }
  // A tree grown from the star: { star: { planets: [...] } }.
  for (const [key, hint] of LIST_KEYS) {
    const list = pick(star, [key]);
    if (list && typeof list === 'object' && !listed.has(list)) { listed.add(list); walk(list, hint, null, 0); }
  }
  if (!flat.length && !isObj(starRaw) && !sunName && pick(root, ['name', 'title']) === undefined) {
    return { ok: false, error: 'notAMap' };
  }
  if (skipped) note('skipped', undefined, skipped);

  // Ids: kept when valid and unique, made otherwise. Every spelling a
  // parent might use (old id, name) points at the new id.
  const taken = new Set<string>();
  const byRef = new Map<string, number>();
  const byName = new Map<string, number>();
  flat.forEach((f, i) => {
    const rawId = text(pick(f.src, ['id', 'key', 'slug']));
    const clean = rawId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      || f.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    f.id = clean && !taken.has(clean) ? clean : newBodyId(taken);
    taken.add(f.id);
    if (rawId) { byRef.set(rawId, i); byRef.set(rawId.toLowerCase(), i); }
    if (f.name && !byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), i);
  });
  const sunRef = (s: string) => SUN_WORDS.has(squash(s)) || (!!sunName && s.trim().toLowerCase() === sunName.toLowerCase());

  // Types and parents.
  const types: MapBodyType[] = [];
  const parentIdx: Array<number | null> = [];
  flat.forEach((f, i) => {
    const t = text(pick(f.src, ['type', 'kind', 'class', 'category', 'bodyType']));
    let type: MapBodyType | null = null;
    if (t) {
      const s = squash(t);
      type = TYPE_ALIASES[s] ?? null;
      if (!type) {
        type = /icegiant|neptun/.test(s) ? 'ice-giant' : /gas|jovian|giant/.test(s) ? 'gas-giant' : /dwarf/.test(s) ? 'dwarf'
          : /moon|satellite/.test(s) ? 'moon' : /asteroid/.test(s) ? 'asteroid' : /comet|meteor|ore|rock/.test(s) && !/planet/.test(s) ? 'rock'
          : /planet|world|terra/.test(s) ? 'terrestrial' : null;
        note('typeGuessed', f.name || t);
      }
    }
    if (!type && f.hint) type = f.hint;
    if (!type) type = f.nestedIn != null ? 'moon' : 'terrestrial';
    if (!t && !f.hint && f.nestedIn == null) note('typeGuessed', f.name);
    types.push(type);

    let parent: number | null = f.nestedIn;
    const p = pick(f.src, ['parent', 'parentId', 'orbits', 'orbiting', 'host', 'hostPlanet', 'planet', 'primary']);
    if (parent == null && (typeof p === 'string' || typeof p === 'number')) {
      const s = String(p).trim();
      if (!sunRef(s)) {
        const hit = byRef.get(s) ?? byRef.get(s.toLowerCase());
        const named = hit == null ? byName.get(s.toLowerCase()) : undefined;
        if (hit != null && hit !== i) parent = hit;
        else if (named != null && named !== i) { parent = named; note('parentByName', f.name); }
        else if (type === 'moon') note('orphanMoons', f.name);
      }
    }
    parentIdx.push(parent);
  });
  // A moon's world must orbit the sun: a moon of a moon is lifted to the
  // world its parent circles. Anything else nested under a world becomes
  // that world's moon.
  flat.forEach((f, i) => {
    let p = parentIdx[i];
    let lifted = false;
    for (let hops = 0; p != null && parentIdx[p] != null && hops < 5; hops++) { p = parentIdx[p]; lifted = true; }
    if (p != null && (types[p] === 'moon' || types[p] === 'rock' || types[p] === 'asteroid')) {
      // Small things cannot hold moons: both orbit the sun, side by side.
      p = null;
      note('orphanMoons', f.name);
    }
    if (lifted) note('moonsLifted', f.name);
    parentIdx[i] = p;
    if (p != null && types[i] !== 'moon') { types[i] = 'moon'; note('madeMoons', f.name); }
  });

  // Orbits: map units, unless every sun orbit is too small to be (AU), or
  // the values are kilometres.
  const orbitQ = flat.map(f => {
    const au = quantity(pick(f.src, ['au', 'orbitAU', 'distanceAU', 'semiMajorAxisAU', 'smaAU']));
    if (au) return { n: au.n, unit: 'au' as const };
    const km = quantity(pick(f.src, ['orbitKm', 'distanceKm', 'semiMajorAxisKm']));
    if (km) return { n: km.n, unit: 'km' as const };
    return quantity(pick(f.src, ['orbit', 'orbitRadius', 'orbitalRadius', 'distance', 'dist', 'semiMajorAxis', 'sma', 'a', 'orbitDistance']));
  });
  const sunKids = flat.map((_, i) => i).filter(i => parentIdx[i] == null);
  const plainSun = sunKids.map(i => orbitQ[i]).filter(q => q && q.unit === '').map(q => q!.n);
  const sunInAu = plainSun.length > 0 && plainSun.every(n => n > 0 && n < ORBIT_LIMITS.sun[0]);
  const sunInKm = plainSun.length > 0 && plainSun.every(n => n > 1e6);
  const moonKids = flat.map((_, i) => i).filter(i => parentIdx[i] != null);
  const plainMoon = moonKids.map(i => orbitQ[i]).filter(q => q && q.unit === '').map(q => q!.n);
  const moonInKm = plainMoon.length > 0 && plainMoon.every(n => n > 2000);
  const orbits: Array<number | null> = flat.map((_, i) => {
    const q = orbitQ[i];
    if (!q || !(q.n > 0)) return null;
    const moon = parentIdx[i] != null;
    // A unit the value named is no news; one the importer inferred is.
    if (q.unit === 'au' || (!moon && q.unit === '' && sunInAu)) { if (q.unit === '') note('auOrbits'); return q.n * (moon ? MOON_AU : AU); }
    if (q.unit === 'km' || (q.unit === '' && (moon ? moonInKm : sunInKm))) {
      if (q.unit === '') note(moon ? 'kmMoons' : 'kmOrbits');
      return moon ? q.n * MOON_KM : (q.n / KM_PER_AU) * AU;
    }
    return q.n;
  });
  // Missing orbits are spaced out rather than piled on one ring: sun
  // worlds outward from the furthest given, moons outward round their world.
  let nextSun = Math.max(0, ...sunKids.map(i => orbits[i] ?? 0));
  const nextMoon = new Map<number, number>();
  flat.forEach((f, i) => {
    if (orbits[i] != null) return;
    const p = parentIdx[i];
    if (p == null) {
      nextSun = !nextSun ? 150 : Math.min(ORBIT_LIMITS.sun[1], Math.round(nextSun < 1500 ? nextSun * 1.35 : nextSun + 450));
      orbits[i] = nextSun;
    } else {
      const last = nextMoon.get(p) ?? Math.max(8, ...moonKids.filter(k => parentIdx[k] === p).map(k => orbits[k] ?? 0));
      orbits[i] = Math.round(last + 10);
      nextMoon.set(p, orbits[i]!);
    }
    note('orbitsMade', f.name);
  });
  flat.forEach((f, i) => {
    const lim = parentIdx[i] == null ? ORBIT_LIMITS.sun : ORBIT_LIMITS.moon;
    const o = orbits[i]!;
    if (o < lim[0] || o > lim[1]) note('orbitsClamped', f.name);
  });

  // Angles: radians, unless any is past a full turn (degrees). Missing
  // ones are spread by the golden angle so worlds don't line up.
  const angleQ = flat.map(f => quantity(pick(f.src, ['angle', 'position', 'phase', 'theta', 'longitude', 'meanAnomaly', 'startAngle', 'angleDeg', 'degrees'])));
  const inDegrees = angleQ.some(q => q && (q.unit === 'deg' || (q.unit === '' && Math.abs(q.n) > Math.PI * 2 + 0.01)));
  if (inDegrees) note('degrees');
  const angles = angleQ.map((q, i) => (q ? (q.unit === 'deg' || (q.unit === '' && inDegrees) ? (q.n * Math.PI) / 180 : q.n) : (i * 2.39996) % (Math.PI * 2)));

  // Sizes: map units, words, or kilometres.
  const radii = flat.map((f, i) => {
    const info = TYPE_INFO[types[i]];
    const v = pick(f.src, ['radius', 'size', 'diameter', 'radiusKm']);
    if (typeof v === 'string') {
      const w = squash(v);
      const at = ({ tiny: 0, small: 0.2, medium: 0.5, average: 0.5, normal: 0.5, large: 0.8, big: 0.8, huge: 1, massive: 1, giant: 1 } as Record<string, number>)[w];
      if (at != null) return info.radius[0] + (info.radius[1] - info.radius[0]) * at;
    }
    const q = quantity(v);
    if (!q) return undefined;
    const diameter = pick(f.src, ['diameter']) !== undefined && pick(f.src, ['radius', 'size']) === undefined;
    const r = diameter ? q.n / 2 : q.n;
    if (q.unit === 'km' || r > 20) { note('kmRadius', f.name); return kmToRadius(r); }
    return r;
  });

  // Yields: a 0–30 scale. A map that used a bigger one is scaled down
  // whole, so its worlds keep their balance against each other.
  const yieldsRaw = flat.map(f => {
    const y = pick(f.src, ['yields', 'yield', 'resources', 'output', 'production', 'economy']);
    const o: Obj = isObj(y) ? y : f.src;
    const n = (keys: string[]) => { const q = quantity(pick(o, keys)); return q && q.n > 0 ? q.n : 0; };
    return {
      metal: n(['metal', 'metals', 'ore', 'minerals', 'iron', 'industry']),
      credits: n(['credits', 'gold', 'money', 'trade', 'income', 'wealth', 'commerce']),
      science: n(['science', 'research', 'knowledge', 'tech', 'technology']),
    };
  });
  const maxYield = Math.max(0, ...yieldsRaw.flatMap(y => [y.metal, y.credits, y.science]));
  const yScale = maxYield > RESOURCE_MAX ? RESOURCE_MAX / maxYield : 1;
  if (yScale < 1) note('yieldsScaled', undefined, Math.round(maxYield));

  // Everything else, one body at a time.
  const bodies = flat.map((f, i) => {
    const type = types[i];
    const s = f.src;
    const surfaceRaw = text(pick(s, ['surface', 'biome', 'terrain', 'climate', 'look', 'appearance', 'environment']));
    let surface: MapSurface | undefined;
    if (surfaceRaw) {
      const w = squash(surfaceRaw);
      surface = (SURFACES as string[]).includes(w) ? (w as MapSurface) : SURFACE_ALIASES[w]
        ?? Object.entries(SURFACE_ALIASES).find(([k]) => w.includes(k))?.[1];
      if (!surface && type !== 'rock') note('surfaceUnknown', f.name || surfaceRaw);
    }

    let secret: MapSecret | 'random' | null = null;
    let secretName = '', secretText = '';
    const sr = pick(s, ['secret', 'discovery', 'hidden', 'treasure', 'anomaly', 'mystery', 'artifact', 'artefact']);
    if (sr !== undefined && sr !== false) {
      const so: Obj = isObj(sr) ? sr : {};
      const kindRaw = isObj(sr) ? text(pick(so, ['kind', 'type', 'id'])) : sr === true ? 'random' : text(sr);
      const k = squash(kindRaw);
      secret = (MAP_SECRETS as string[]).includes(kindRaw.trim().toLowerCase()) ? (kindRaw.trim().toLowerCase() as MapSecret)
        : SECRET_ALIASES[k] ?? Object.entries(SECRET_ALIASES).find(([a]) => a.length > 3 && k.includes(a))?.[1] ?? null;
      if (!secret) { secret = 'random'; if (kindRaw) note('secretUnknown', f.name || kindRaw); }
      secretName = text(pick(so, ['name', 'title']) ?? pick(s, ['secretName', 'discoveryName']));
      secretText = text(pick(so, ['text', 'message', 'description', 'lore']) ?? pick(s, ['secretText', 'discoveryText']));
      if (!secretFits(secret, type) || type === 'rock') note('secretsDropped', f.name);
    }

    const wantsStart = truthy(pick(s, ['start', 'startWorld', 'startingWorld', 'spawn', 'home', 'homeworld', 'homeWorld', 'capital', 'playerStart', 'isStart', 'starting', 'startable']));
    if (wantsStart && !canStartOn(type)) note('startsDropped', f.name);

    const mineralRaw = pick(s, ['mineral', 'ore', 'deposit']);
    const mo: Obj = isObj(mineralRaw) ? mineralRaw : {};
    const goldy = /gold/i.test(text(isObj(mineralRaw) ? pick(mo, ['kind', 'type']) : mineralRaw));

    const y = yieldsRaw[i];
    return {
      id: f.id,
      name: f.name,
      type,
      parent: parentIdx[i] == null ? 'sun' : flat[parentIdx[i]!].id,
      orbit: orbits[i],
      angle: angles[i],
      radius: radii[i],
      yields: { metal: y.metal * yScale, credits: y.credits * yScale, science: y.science * yScale },
      color: hexColor(pick(s, ['color', 'colour', 'hex'])) ?? undefined,
      surface,
      rings: truthy(pick(s, ['rings', 'hasRings', 'ringed', 'ring'])) || (Array.isArray(pick(s, ['rings'])) && (pick(s, ['rings']) as unknown[]).length > 0),
      start: wantsStart,
      secret,
      secretName,
      secretText,
      lore: text(pick(s, ['lore', 'description', 'desc', 'flavor', 'flavour', 'story', 'notes', 'blurb'])),
      ...(type === 'rock' ? {
        mineral: {
          kind: goldy ? 'gold' : 'metal',
          tons: quantity(pick(mo, ['tons', 'amount', 'size', 'quantity']) ?? pick(s, ['tons']))?.n,
        },
      } : {}),
    };
  });

  // Over the cap: worlds round the sun first, so no moon loses its world.
  bodies.sort((a, b) => (a.parent === 'sun' ? 0 : 1) - (b.parent === 'sun' ? 0 : 1));
  if (bodies.length > MAX_BODIES) note('overCap', undefined, bodies.length - MAX_BODIES);

  // Sectors: in map units, or AU when they read like it.
  const sectorsRaw = pick(root, ['sectors', 'regions', 'zones', 'bands']);
  const sectorList = Array.isArray(sectorsRaw) ? sectorsRaw.filter(isObj) : [];
  const edges = sectorList.map(sc => [
    quantity(pick(sc, ['inner', 'from', 'start', 'min', 'innerOrbit', 'innerRadius'])),
    quantity(pick(sc, ['outer', 'to', 'end', 'max', 'outerOrbit', 'outerRadius'])),
  ] as const);
  const edgeVals = edges.flat().filter(q => q && q.unit === '').map(q => q!.n);
  const sectorsAu = edgeVals.length > 0 && edgeVals.every(n => n >= 0 && n < ORBIT_LIMITS.sun[0]) && Math.max(...edgeVals) > 0;
  const sectorTaken = new Set<string>();
  const sectors = sectorList.slice(0, MAX_SECTORS * 2).map((sc, i) => {
    const conv = (q: ReturnType<typeof quantity>) => (q ? (q.unit === 'au' || (q.unit === '' && sectorsAu) ? q.n * AU : q.unit === 'km' ? (q.n / KM_PER_AU) * AU : q.n) : undefined);
    const id = newSectorId(sectorTaken);
    sectorTaken.add(id);
    return {
      id,
      name: text(pick(sc, ['name', 'title', 'label'])),
      color: hexColor(pick(sc, ['color', 'colour'])) ?? undefined,
      inner: conv(edges[i][0]),
      outer: conv(edges[i][1]),
    };
  });

  const backdropRaw = text(pick(isObj(root.settings) ? root.settings : {}, ['backdrop']) ?? pick(root, ['backdrop', 'sky', 'background', 'nebula', 'skyColor']));
  const bw = squash(backdropRaw);
  const backdrop = (BACKDROPS as string[]).includes(bw) ? bw : BACKDROP_ALIASES[bw] ?? Object.entries(BACKDROP_ALIASES).find(([k]) => bw.includes(k))?.[1];

  // In map units, or in suns (1 = ours, drawn at 50).
  const sunSize = sunSizeQ ? (sunSizeQ.n > SUN_LIMITS.size[1] * 4 ? undefined : sunSizeQ.n <= 5 ? sunSizeQ.n * 50 : sunSizeQ.n) : undefined;
  const sunMass = sunMassQ ? (sunMassQ.n > 1e3 ? undefined : sunMassQ.n) : undefined;
  const map = normalizeMap({
    name: text(pick(root, ['name', 'title', 'systemName', 'mapName'])),
    blurb: text(pick(root, ['blurb', 'description', 'pitch', 'summary', 'tagline', 'intro'])),
    sun: { name: sunName, color: sunColor, size: sunSize, mass: sunMass },
    bodies,
    sectors,
    settings: {
      shareHidesSecrets: isObj(root.settings) ? root.settings.shareHidesSecrets !== false : true,
      backdrop,
    },
  });
  if (sectorList.length > map.sectors.length) note('sectorsDropped', undefined, sectorList.length - map.sectors.length);

  return { ok: true, map, notes: [...notes.values()].map(n => (n.names?.length ? n : { code: n.code, n: n.n })) };
}

/** The map as a file's text: exactly what the importer reads back. */
export function exportMapText(map: CustomMap): string {
  return JSON.stringify(normalizeMap(map), null, 2);
}

/** A safe file name for a map. */
export function exportFileName(map: CustomMap): string {
  const base = map.name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40);
  return `${base || 'map'}.orbital-map.json`;
}
