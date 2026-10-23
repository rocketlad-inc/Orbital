// ============================================================================
// studioScene.js — the studio's scene language, as pure functions.
//
// Everything here runs without a database: expandScenario turns the JSON a
// director writes into a checked, normalised plan, and the same function
// backs the editor's Validate button, the CLI's dry run and the unit tests.
// studio.js is the half that writes rows. docs/STUDIO.md describes the
// language for people and agents.
// ============================================================================

import { isValidStartingBody, BODY_CATALOG } from './factions.js';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS } from './megastructures.js';

/** auth.js's agent-handle rule, repeated here so this module stays
 *  loadable without the crypto that auth.js sets up at import. */
const isValidAgentHandle = (h) => typeof h === 'string' && /^[a-z0-9][a-z0-9_-]{0,30}$/.test(h);
import { DEFAULT_LOADOUTS } from './shipDesigns.js';
import { normalizeEmblem, EMBLEM_IDS } from './emblems.js';

/** The studio mark. Every row the studio writes has it in the id, which is
 *  what makes `reset` safe: nothing without it is ever deleted. */
export const STUDIO_MARK = 'st_';

export const SHIP_CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony', 'mega_destroyer', 'mobile_foundry'];
const WARSHIPS = new Set(['corvette', 'frigate', 'destroyer']);
export const FUEL_MAX = { corvette: 80, frigate: 200, destroyer: 300, freighter: 400, colony: 100, mega_destroyer: 600, mobile_foundry: 600 };

/** Loadout presets, by class. 'mixed' puts every weapon kind on the board
 *  so a clip shows beams, tracers, flak and mines in one fight. */
export const LOADOUT_PRESETS = {
  default: (cls) => DEFAULT_LOADOUTS[cls] ?? [],
  kinetic: (cls) => ({ corvette: ['kinetic', 'engine'], frigate: ['kinetic', 'kinetic', 'armor', 'engine'], destroyer: ['kinetic', 'kinetic', 'kinetic', 'kinetic', 'armor', 'engine'] })[cls] ?? DEFAULT_LOADOUTS[cls] ?? [],
  energy: (cls) => ({ corvette: ['energy', 'engine'], frigate: ['energy', 'energy', 'shield', 'engine'], destroyer: ['energy', 'energy', 'energy', 'energy', 'shield', 'engine'] })[cls] ?? DEFAULT_LOADOUTS[cls] ?? [],
  mixed: (cls, i) => {
    const sets = {
      corvette: [['kinetic', 'engine'], ['energy', 'engine'], ['flak', 'engine']],
      frigate: [['kinetic', 'kinetic', 'armor', 'engine'], ['energy', 'energy', 'shield', 'engine'], ['flak', 'kinetic', 'shield', 'engine'], ['detonator', 'energy', 'armor', 'engine']],
      destroyer: [['kinetic', 'kinetic', 'kinetic', 'energy', 'armor', 'engine'], ['energy', 'energy', 'energy', 'kinetic', 'shield', 'engine'], ['flak', 'flak', 'kinetic', 'energy', 'shield', 'engine']],
    }[cls];
    return sets ? sets[i % sets.length] : (DEFAULT_LOADOUTS[cls] ?? []);
  },
};

export const TAG = { corvette: 'CV', frigate: 'FF', destroyer: 'DD', freighter: 'FR', colony: 'CS', mega_destroyer: 'MD', mobile_foundry: 'MF' };

const isKey = (s) => typeof s === 'string' && /^[a-z][a-z0-9_]{0,30}$/.test(s);
const isBody = (s) => typeof s === 'string' && /^[a-z0-9_-]{1,40}$/.test(s);
const catalogBody = (id) => BODY_CATALOG.find(b => b.id === id) ?? null;

/** The rogue asteroids a station's Trajectory Control Thrusters can fly
 *  (the catalogue's asteroids around the Sun: midas, styx_rock, ...). */
export const ROGUE_ASTEROIDS = BODY_CATALOG.filter(b => b.type === 'asteroid' && b.parent === 'sol').map(b => b.id);
/** What the Leviathan eats (kaiju.js KAIJU_PREY_TYPES; repeated here so
 *  this module stays free of the tick's imports). */
const KAIJU_PREY = new Set(['terrestrial', 'dwarf', 'moon']);
/** The Leviathan's wind-up when a scene does not say: the Mega
 *  Destroyer's (actions.js MEGA_STRIKE_CHARGE_TICKS). */
export const KAIJU_DEFAULT_CHARGE = 24;

/**
 * Normalise and validate a scene. Pure: no database, so it is unit-tested
 * on its own and the editor can validate before it applies. Throws an
 * Error whose message names the field, so the author can fix it.
 */
export function expandScenario(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('scene must be an object');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 50) : 'Untitled scene';
  const gameId = typeof raw.game_id === 'string' && raw.game_id ? raw.game_id : null;

  // ---- factions ----
  const factions = Array.isArray(raw.factions) ? raw.factions : [];
  if (!gameId && factions.length < 2) throw new Error('a new scene needs at least 2 factions');
  if (factions.length > 10) throw new Error('at most 10 factions');
  const keys = new Set();
  const fx = factions.map((f, i) => {
    if (!isKey(f?.key)) throw new Error(`factions[${i}].key must be a short lowercase slug`);
    if (keys.has(f.key)) throw new Error(`duplicate faction key '${f.key}'`);
    keys.add(f.key);
    const home = typeof f.home === 'string' ? f.home : null;
    if (!gameId && !isValidStartingBody(home)) throw new Error(`factions[${i}].home '${home}' is not a starting world`);
    const handle = typeof f.handle === 'string' ? f.handle : `studio-${f.key}`;
    if (!isValidAgentHandle(handle)) throw new Error(`factions[${i}].handle '${handle}' is not a valid agent handle`);
    const color = typeof f.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : null;
    const color2 = typeof f.color2 === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.color2) ? f.color2 : null;
    return {
      key: f.key, name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 40) : f.key,
      home, handle, color, color2, emblem: normalizeEmblem(f.emblem ?? EMBLEM_IDS[i % EMBLEM_IDS.length]),
    };
  });
  const need = (k, where) => { if (!keys.has(k)) throw new Error(`${where}: unknown faction '${k}'`); };

  // ---- wars ----
  let wars = [];
  if (raw.wars === 'all') {
    for (let a = 0; a < fx.length; a++) for (let b = a + 1; b < fx.length; b++) wars.push([fx[a].key, fx[b].key]);
  } else if (Array.isArray(raw.wars)) {
    wars = raw.wars.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) throw new Error(`wars[${i}] must be a pair`);
      need(p[0], `wars[${i}]`); need(p[1], `wars[${i}]`);
      if (p[0] === p[1]) throw new Error(`wars[${i}]: a faction cannot war itself`);
      return [p[0], p[1]];
    });
  }

  // ---- worlds ----
  const worlds = (Array.isArray(raw.worlds) ? raw.worlds : []).map((w, i) => {
    if (!isBody(w?.body)) throw new Error(`worlds[${i}].body is required`);
    if (w.owner != null) need(w.owner, `worlds[${i}]`);
    const cities = Array.isArray(w.cities) ? w.cities.map(c => String(c).slice(0, 40)) : [];
    if (cities.length > 6) throw new Error(`worlds[${i}]: at most 6 cities`);
    const stations = Math.max(0, Math.min(2, Number(w.stations) || 0));
    // Orbital Shields at a level on every studio city here (the building
    // lives on cities, never stations: actions.js BUILDING_DEFS.shields).
    let shields = null;
    if (w.shields != null) {
      shields = Number(w.shields);
      if (!Number.isInteger(shields) || shields < 1 || shields > 10) throw new Error(`worlds[${i}].shields must be a level from 1 to 10`);
      if (cities.length === 0) throw new Error(`worlds[${i}].shields: shields stand on cities; list at least one city`);
    }
    // Trajectory Control Thrusters on the studio station, so the rock can
    // be rammed into a world (an `orders` ram). A station building, and
    // only on a rogue asteroid, as in play.
    if (w.thrusters != null && typeof w.thrusters !== 'boolean') throw new Error(`worlds[${i}].thrusters must be true or false`);
    const thrusters = w.thrusters === true;
    if (thrusters) {
      if (stations < 1) throw new Error(`worlds[${i}].thrusters are a station building: add stations: 1`);
      const cat = catalogBody(w.body);
      if (cat && cat.type !== 'asteroid') throw new Error(`worlds[${i}].thrusters: ${w.body} is not a rogue asteroid (${ROGUE_ASTEROIDS.join(', ')})`);
      if (w.living === true) throw new Error(`worlds[${i}]: an asteroid cannot be terraformed; leave living out`);
    }
    return { body: w.body, owner: w.owner ?? null, living: w.living !== false && !thrusters, cities, stations, shields, thrusters };
  });

  // ---- ships ----
  const groupKeys = new Set();
  const ships = (Array.isArray(raw.ships) ? raw.ships : []).map((g, i) => {
    if (!isKey(g?.key)) throw new Error(`ships[${i}].key must be a short lowercase slug`);
    if (groupKeys.has(g.key)) throw new Error(`duplicate ship group '${g.key}'`);
    groupKeys.add(g.key);
    need(g.owner, `ships[${i}]`);
    if (!isBody(g.at)) throw new Error(`ships[${i}].at (a world) is required`);
    let mix = {};
    if (g.mix && typeof g.mix === 'object') mix = g.mix;
    else if (typeof g.class === 'string') mix = { [g.class]: Number(g.count) || 1 };
    else throw new Error(`ships[${i}] needs class+count or mix`);
    const hulls = [];
    for (const [cls, n] of Object.entries(mix)) {
      if (!SHIP_CLASSES.includes(cls)) throw new Error(`ships[${i}]: unknown class '${cls}'`);
      const k = Math.max(0, Math.min(60, Number(n) || 0));
      for (let j = 0; j < k; j++) hulls.push(cls);
    }
    if (hulls.length === 0) throw new Error(`ships[${i}] has no hulls`);
    if (hulls.length > 60) throw new Error(`ships[${i}]: at most 60 hulls per group`);
    const loadout = g.loadout ?? 'mixed';
    if (!(Array.isArray(loadout) || typeof loadout === 'string' && LOADOUT_PRESETS[loadout])) {
      throw new Error(`ships[${i}].loadout must be default|kinetic|energy|mixed or a parts array`);
    }
    const hp = Number.isFinite(Number(g.hp)) ? Math.max(0.1, Math.min(20, Number(g.hp))) : 1;
    const variant = typeof g.variant === 'string' && /^[A-Z]$/.test(g.variant) ? g.variant : 'A';
    // The fleet's target order, as the game's orders give it: 'big'
    // (capitals first, so a fleet goes for the Mega Destroyer), 'small',
    // 'civilian', or a list of categories. Absent = the game's own ladder.
    const PRIORITY = {
      big: ['capital', 'destroyer', 'frigate', 'corvette', 'civilian', 'settlement'],
      small: ['corvette', 'frigate', 'destroyer', 'capital', 'civilian', 'settlement'],
      civilian: ['civilian', 'corvette', 'frigate', 'destroyer', 'capital', 'settlement'],
    };
    let priority = null;
    if (g.priority != null) {
      if (typeof g.priority === 'string' && PRIORITY[g.priority]) priority = PRIORITY[g.priority];
      else if (Array.isArray(g.priority) && g.priority.length && g.priority.every(c => typeof c === 'string' && /^[a-z_]{3,20}$/.test(c))) priority = g.priority;
      else throw new Error(`ships[${i}].priority must be big, small, civilian or a list of categories`);
    }
    // A loaded hold, on every hull of the group: a freighter parked at a
    // construction site with the load it is about to hand over (a
    // mid-take `deliver`). `credits` is the game's word for gold.
    let cargo = null;
    if (g.cargo != null) {
      if (typeof g.cargo !== 'object' || Array.isArray(g.cargo)) throw new Error(`ships[${i}].cargo must be { metal, gold }`);
      const amt = (v, k) => {
        if (v == null) return 0;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`ships[${i}].cargo.${k} must be a number from 0 to 100000`);
        return Math.floor(n);
      };
      cargo = { metal: amt(g.cargo.metal, 'metal'), gold: amt(g.cargo.gold ?? g.cargo.credits, 'gold') };
    }
    return {
      key: g.key, owner: g.owner, at: g.at, hulls, loadout, hp, variant, priority, cargo,
      prefix: typeof g.prefix === 'string' ? g.prefix.slice(0, 8) : g.owner.slice(0, 3).toUpperCase() + 'S',
    };
  });
  const needGroup = (k, where) => {
    const base = String(k).split('.')[0];
    if (!groupKeys.has(base)) throw new Error(`${where}: unknown ship group '${k}'`);
  };

  // ---- fleets ----
  const fleets = (Array.isArray(raw.fleets) ? raw.fleets : []).map((f, i) => {
    if (!isKey(f?.key)) throw new Error(`fleets[${i}].key must be a short lowercase slug`);
    const groups = Array.isArray(f.ships) ? f.ships : [f.ships];
    groups.forEach(gk => needGroup(gk, `fleets[${i}]`));
    return { key: f.key, name: typeof f.name === 'string' ? f.name.slice(0, 40) : f.key, groups: groups.map(String) };
  });

  // ---- research ----
  const research = (Array.isArray(raw.research) ? raw.research : []).map((r, i) => {
    if (r?.faction !== 'all') need(r?.faction, `research[${i}]`);
    if (!/^[a-z_]{3,24}$/.test(String(r.track))) throw new Error(`research[${i}].track`);
    return { faction: r.faction, track: r.track, level: Math.max(0, Math.min(12, Number(r.level) || 0)) };
  });

  // ---- orders ----
  const orders = (Array.isArray(raw.orders) ? raw.orders : []).map((o, i) => {
    const where = `orders[${i}]`;
    const depart = parseWhen(o?.depart ?? '+1', where);
    switch (o?.type) {
      case 'move': {
        needGroup(o.ships, where);
        if (!isBody(o.to)) throw new Error(`${where}.to is required`);
        if (o.settle != null && o.settle !== 'station') throw new Error(`${where}.settle must be 'station'`);
        return { type: 'move', ships: String(o.ships), to: o.to, depart, arrive: o.arrive != null ? parseWhen(o.arrive, where) : null,
          settle: o.settle === 'station' ? 'station' : null };
      }
      // A freighter with a mining rig flies out to a meteoroid, fills its
      // hold, and brings the haul home: the player's own mining route
      // (trade-routes/full, a mine stop and a drop-off), run `loops` times.
      case 'mine': {
        needGroup(o.ship, where);
        if (!isBody(o.rock) || !isBody(o.to)) throw new Error(`${where}: rock and to are required`);
        const loops = Math.max(1, Math.min(20, Math.floor(Number(o.loops) || 1)));
        return { type: 'mine', ship: String(o.ship), rock: o.rock, to: o.to, loops };
      }
      case 'strike': {
        needGroup(o.ship, where);
        return { type: 'strike', ship: String(o.ship), ready: parseWhen(o.ready ?? '+1', where) };
      }
      case 'trade': {
        needGroup(o.ship, where);
        if (!isBody(o.from) || !isBody(o.to)) throw new Error(`${where}: from and to are required`);
        return { type: 'trade', ship: String(o.ship), from: o.from, to: o.to };
      }
      // A rogue asteroid driven into a world: the player's own ram, with
      // the plan worked out server-side as the inspector works it out. The
      // rock must be seeded with a thrusters station in worlds[], whose
      // owner fires it.
      case 'ram': {
        if (!isBody(o.asteroid) || !isBody(o.target)) throw new Error(`${where}: asteroid and target are required`);
        if (o.asteroid === o.target) throw new Error(`${where}: an asteroid cannot ram itself`);
        const rock = worlds.find(w => w.body === o.asteroid && w.thrusters);
        if (!rock) throw new Error(`${where}: ${o.asteroid} needs a worlds[] entry with stations: 1 and thrusters: true`);
        return { type: 'ram', asteroid: o.asteroid, target: o.target, depart, owner: rock.owner };
      }
      default: throw new Error(`${where}.type must be move, strike, trade, mine or ram`);
    }
  });

  // ---- laws: bills that already passed, in force from the tick the scene lands ----
  // A slider law ('law') names a Senate slider and a value, for everyone or
  // aimed at one faction. A sanction (war_authorization: the target's ships
  // take double damage; trade_embargo; production_sanction) always names
  // its target. Ballots default to everyone-for except the target.
  const LAW_KINDS = ['law', 'war_authorization', 'trade_embargo', 'production_sanction'];
  const laws = (Array.isArray(raw.laws) ? raw.laws : []).map((l, i) => {
    const where = `laws[${i}]`;
    const kind = l?.kind ?? 'law';
    if (!LAW_KINDS.includes(kind)) throw new Error(`${where}.kind must be ${LAW_KINDS.join(', ')}`);
    const target = l?.target == null || l.target === '' ? null : String(l.target);
    if (target) need(target, where);
    if (kind !== 'law' && !target) throw new Error(`${where}: a ${kind} needs a target faction`);
    let slider = null;
    let value = null;
    if (kind === 'law') {
      if (!/^[a-z_]{3,40}$/.test(String(l?.slider))) throw new Error(`${where}.slider must name a Senate slider (the catalog lists them)`);
      slider = String(l.slider);
      value = Number(l.value);
      if (!Number.isFinite(value)) throw new Error(`${where}.value must be a number`);
    }
    const proposer = l?.proposer != null ? String(l.proposer) : (fx.find(f => f.key !== target)?.key ?? fx[0]?.key);
    need(proposer, `${where}.proposer`);
    const ballots = (v, what) => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new Error(`${where}.${what} must be a list of faction keys`);
      return v.map((k, j) => { need(String(k), `${where}.${what}[${j}]`); return String(k); });
    };
    const defaultTicks = { law: 24, war_authorization: 21, trade_embargo: 14, production_sanction: 14 }[kind];
    const ticks = Math.max(1, Math.min(500, Math.floor(Number(l?.ticks)) || defaultTicks));
    const title = typeof l?.title === 'string' && l.title.trim() ? l.title.trim().slice(0, 80) : null;
    const summary = typeof l?.summary === 'string' && l.summary.trim() ? l.summary.trim().slice(0, 500) : null;
    return { kind, slider, value, target, proposer, yea: ballots(l?.yea, 'yea'), nay: ballots(l?.nay, 'nay'), ticks, title, summary };
  });

  // ---- silos: a Missile Silo in the owner's city on a world ----
  // level 1-5 (5 missiles a level), stock (defaults to full), auto 'off' |
  // 'missiles' (shoot down incoming salvos) | 'fleets' (also fire at hostile
  // groups bound for the world), salvo = missiles per auto launch.
  const silos = (Array.isArray(raw.silos) ? raw.silos : []).map((s, i) => {
    const where = `silos[${i}]`;
    if (!isBody(s?.world)) throw new Error(`${where}.world is required`);
    if (s.owner != null) need(String(s.owner), where);
    const level = Math.max(1, Math.min(5, Math.floor(Number(s.level) || 1)));
    const stock = s.stock == null ? level * 5 : Math.max(0, Math.min(level * 5, Math.floor(Number(s.stock) || 0)));
    const auto = s.auto ?? 'fleets';
    if (!['off', 'missiles', 'fleets'].includes(auto)) throw new Error(`${where}.auto must be off, missiles or fleets`);
    const salvo = Math.max(1, Math.min(25, Math.floor(Number(s.salvo) || 2)));
    const reserve = Math.max(0, Math.min(stock, Math.floor(Number(s.reserve) || 0)));
    return { world: s.world, owner: s.owner != null ? String(s.owner) : null, level, stock, auto, salvo, reserve };
  });

  // ---- the far systems and their gate ----
  // far_systems: Alpha Centauri and Cygnus X-1 on this board (the game's own
  // far_systems dial). gates: the Centauri sun gate pair, already open.
  // gates: 'birth' (2026-10-23, for a clip of the first gate leaving the
  // Sun): nothing pre-spawned; the omen starts on the next tick and the
  // game's own tick sends the first gate out six ticks after it.
  if (raw.gates != null && raw.gates !== true && raw.gates !== false && raw.gates !== 'birth') {
    throw new Error("gates must be true (already open) or 'birth' (the first gate leaves the Sun during the take)");
  }
  let gates = raw.gates === 'birth' ? 'birth' : raw.gates === true;

  // ---- the Leviathan, parked at a world and about to wind up ----
  // { at, charge_ticks?, hp? }. It starts hunting `at` (never a
  // homeworld: it never attacks one), winds up for charge_ticks (the
  // game's 24 by default, the kaiju_charge_ticks dial) and strikes as in
  // play. It leaves through its sun gate when it is full, so a scene with
  // it has the far systems and a gate (gates: true unless 'birth').
  let kaiju = null;
  if (raw.kaiju != null && raw.kaiju !== false) {
    const k = raw.kaiju;
    if (typeof k !== 'object' || Array.isArray(k)) throw new Error("kaiju must be { at: '<world>', charge_ticks?, hp? }");
    if (!isBody(k.at)) throw new Error('kaiju.at (the world it starts on) is required');
    const cat = catalogBody(k.at);
    if (cat && !KAIJU_PREY.has(cat.type)) throw new Error(`kaiju.at: it eats terrestrial worlds, dwarfs and moons; ${k.at} is a ${cat.type}`);
    if (fx.some(f => f.home === k.at)) throw new Error(`kaiju.at: ${k.at} is a homeworld, and the Leviathan never attacks one`);
    let chargeTicks = KAIJU_DEFAULT_CHARGE;
    if (k.charge_ticks != null) {
      chargeTicks = Number(k.charge_ticks);
      if (!Number.isInteger(chargeTicks) || chargeTicks < 1 || chargeTicks > 240) throw new Error('kaiju.charge_ticks must be a whole number of ticks from 1 to 240');
    }
    let hp = null;
    if (k.hp != null) {
      hp = Number(k.hp);
      if (!Number.isFinite(hp) || hp < 100 || hp > 500000) throw new Error('kaiju.hp must be a number from 100 to 500000');
      hp = Math.round(hp);
    }
    kaiju = { at: k.at, chargeTicks, hp };
    if (!gates) gates = true;
  }
  const farSystems = !!gates || raw.far_systems === true;

  // ---- megastructures: a site or a finished structure orbiting a world ----
  // { key, kind, at, owner, progress?: 0..1, complete?: bool, name? }. The
  // key names the site wherever a world can be named (ships.at,
  // orders.move.to, a mid-take deliver).
  const megaKeys = new Set();
  const megastructures = (Array.isArray(raw.megastructures) ? raw.megastructures : []).map((m, i) => {
    const where = `megastructures[${i}]`;
    if (!isKey(m?.key)) throw new Error(`${where}.key must be a short lowercase slug`);
    if (megaKeys.has(m.key)) throw new Error(`duplicate megastructure key '${m.key}'`);
    megaKeys.add(m.key);
    if (catalogBody(m.key)) throw new Error(`${where}.key '${m.key}' is a world id; ships and orders name the site by its key, so pick another`);
    if (!MEGASTRUCTURES[m.kind]) throw new Error(`${where}.kind must be one of ${MEGASTRUCTURE_KINDS.join(', ')}`);
    if (!isBody(m.at)) throw new Error(`${where}.at (the world it orbits) is required`);
    need(m.owner, where);
    if (m.complete != null && typeof m.complete !== 'boolean') throw new Error(`${where}.complete must be true or false`);
    const p = m.progress == null ? 0 : Number(m.progress);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`${where}.progress must be from 0 to 1`);
    const complete = m.complete === true || p >= 1;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 40) : null;
    // Where it orbits (2026-10-23), as a player may place a site anywhere
    // in the world's sphere of influence: `orbit` units from its centre,
    // standing at `angle` degrees on the tick the scene lands. Checked
    // against the world itself when the scene is applied.
    const place = {};
    if (m.orbit != null) {
      const o = Number(m.orbit);
      if (!Number.isFinite(o) || o <= 0) throw new Error(`${where}.orbit must be a distance in map units from the world's centre`);
      place.orbit = o;
    }
    if (m.angle != null) {
      const a = Number(m.angle);
      if (!Number.isFinite(a)) throw new Error(`${where}.angle must be in degrees`);
      place.angle = ((a % 360) + 360) % 360;
    }
    return { key: m.key, kind: m.kind, at: m.at, owner: m.owner, progress: complete ? 1 : p, complete, name, ...place };
  });

  // ---- the Dyson Sphere: one per match, at the Sun ----
  // progress 0..0.99 of the way built (never complete: that ends the game),
  // on a foundation station of station_hp at Sol. Its fall comes from that
  // station's damage, as in play.
  let dyson = null;
  if (raw.dyson != null) {
    const d = raw.dyson;
    need(String(d?.owner), 'dyson');
    const p = Number(d?.progress ?? 0.95);
    dyson = {
      owner: String(d.owner),
      progress: Math.max(0, Math.min(0.99, Number.isFinite(p) ? p : 0.95)),
      stationHp: Math.max(100, Math.min(100000, Math.floor(Number(d?.station_hp) || 4000))),
    };
  }

  // ---- meteoroids: discovered (so they are seen and minable) and full ----
  const meteoroids = (Array.isArray(raw.meteoroids) ? raw.meteoroids : []).map((m, i) => {
    const where = `meteoroids[${i}]`;
    if (!isBody(m?.body)) throw new Error(`${where}.body is required (e.g. mtr_belt_0)`);
    const by = m.discovered_by == null ? 'all' : String(m.discovered_by);
    if (by !== 'all') need(by, where);
    const tons = m.tons == null ? null : Math.max(1, Math.min(5000, Math.floor(Number(m.tons) || 0)));
    return { body: m.body, tons, discoveredBy: by };
  });

  return {
    name, gameId, factions: fx, wars, worlds, ships, fleets, research, orders, laws, silos,
    farSystems, gates, dyson, meteoroids, megastructures, kaiju,
    viewer: typeof raw.viewer === 'string' ? raw.viewer : (fx[0]?.key ?? null),
    camera: raw.camera !== false,   // observer hulls so the viewer sees every scene world
    secrets: raw.secrets === true,  // keep the secrets buried at scene worlds (default: emptied)
    seatMe: raw.seat_me === true,
    reset: raw.reset !== false,
    tickIntervalMs: Number.isFinite(Number(raw.tick_interval_ms)) ? Number(raw.tick_interval_ms) : 3600000,
  };
}

/** '+3' = three ticks from now; a bare number = an absolute tick. */
function parseWhen(v, where) {
  if (typeof v === 'number' && Number.isFinite(v)) return { abs: Math.floor(v) };
  const m = /^\+(\d{1,3})$/.exec(String(v));
  if (m) return { rel: Number(m[1]) };
  throw new Error(`${where}: times are '+N' ticks from now or an absolute tick`);
}
export const whenTick = (w, now) => (w.abs != null ? w.abs : now + w.rel);

/**
 * WHEN A MOVE LEAVES, so it lands at `want` on its OWN engine.
 *
 * `arrive` used to be handed to the leg planner as the arrival, and the
 * planner shapes the burn to land on it: a 16-tick hop asked to take 40
 * flew on a twentieth of its engine (a Mega Destroyer at 0.44 units/tick²
 * against a normal 8-16), crawling through the shot while everything else
 * in it flew (Lorne, 2026-10-21: "an incoherent mess"). Now the hull flies
 * the leg a player's order would give it, and a later arrival is a later
 * departure.
 *
 * `tripAt(depart)` is the natural trip in ticks for a departure at that
 * tick (worlds move, so it is re-asked as the departure moves). Returns
 * the departure, the arrival, and `late` when even leaving at `earliest`
 * cannot make `want`, in which case it arrives as soon as it can.
 * With no `want` it leaves at `earliest` and lands when it lands.
 */
export async function solveMoveTiming({ earliest, want, tripAt, maxIter = 4 }) {
  let depart = earliest;
  let trip = await tripAt(depart);
  if (want == null) return { depart, arrive: depart + trip, late: false };
  for (let i = 0; i < maxIter; i++) {
    const next = Math.max(earliest, Math.floor(want - trip));
    if (next === depart) break;
    depart = next;
    trip = await tripAt(depart);
  }
  const arrive = depart + trip;
  return { depart, arrive, late: arrive > want + 1e-9 };
}

/** Scenes the editor offers as starting points. The first is the shot
 *  that started this module: a three-way fight at Earth with a wing
 *  breaking off for the Moon, and a second war out at Titan. */
export const EXAMPLES = {
  three_way_earth_and_titan: {
    name: 'Three-way at Earth, war at Titan',
    tick_interval_ms: 3600000,
    factions: [
      { key: 'terra', name: 'Terran Directorate', home: 'earth', color: '#4fc3f7', color2: '#0b2a3d', emblem: 'star' },
      { key: 'mars', name: 'Martian Combine', home: 'mars', color: '#ff4d3a', color2: '#3a0d08', emblem: 'hammer' },
      { key: 'jove', name: 'Jovian Hegemony', home: 'ganymede', color: '#a879ff', color2: '#22123f', emblem: 'crown' },
      { key: 'saturn', name: 'Saturnine Concord', home: 'titan', color: '#ff9a2e', color2: '#3d2008', emblem: 'ring' },
      { key: 'neptune', name: 'Neptunian Tide', home: 'triton', color: '#1ed6c6', color2: '#06302c', emblem: 'trident' },
    ],
    viewer: 'terra',
    wars: [['terra', 'mars'], ['terra', 'jove'], ['mars', 'jove'], ['saturn', 'neptune']],
    worlds: [{ body: 'luna', owner: 'terra', living: true, cities: ['Tycho'] }],
    ships: [
      { key: 'terra_home', owner: 'terra', at: 'earth', mix: { destroyer: 4, frigate: 5, corvette: 4 }, loadout: 'mixed', hp: 1.5, prefix: 'TDS' },
      { key: 'terra_moon', owner: 'terra', at: 'earth', mix: { frigate: 3, corvette: 2 }, loadout: 'kinetic', hp: 1.5, prefix: 'TDS' },
      { key: 'mars_siege', owner: 'mars', at: 'earth', mix: { destroyer: 4, frigate: 4, corvette: 3 }, loadout: 'mixed', hp: 1.5, prefix: 'MCS' },
      { key: 'jove_siege', owner: 'jove', at: 'earth', mix: { destroyer: 5, frigate: 3, corvette: 3 }, loadout: 'energy', hp: 1.5, prefix: 'JHS' },
      { key: 'saturn_home', owner: 'saturn', at: 'titan', mix: { destroyer: 3, frigate: 4, corvette: 4 }, loadout: 'mixed', hp: 1.5, prefix: 'SCS' },
      { key: 'neptune_raid', owner: 'neptune', at: 'titan', mix: { destroyer: 4, frigate: 3, corvette: 3 }, loadout: 'kinetic', hp: 1.5, prefix: 'NTS' },
    ],
    fleets: [{ key: 'moon_wing', owner: 'terra', name: 'Lunar Wing', ships: ['terra_moon'] }],
    orders: [{ type: 'move', ships: 'terra_moon', to: 'luna', depart: '+1' }],
  },
  mega_destroyer_venus: {
    name: 'Mega Destroyer over Venus',
    factions: [
      { key: 'terra', name: 'Terran Directorate', home: 'earth', color: '#4fc3f7', color2: '#0b2a3d', emblem: 'star' },
      { key: 'jove', name: 'Jovian Hegemony', home: 'ganymede', color: '#a879ff', color2: '#22123f', emblem: 'crown' },
    ],
    viewer: 'jove',
    worlds: [{ body: 'venus', owner: 'terra', living: true, cities: ['Aphrodite Terra', 'Ishtar', 'Maxwell Station'] }],
    ships: [{ key: 'md', owner: 'jove', at: 'venus', class: 'mega_destroyer', count: 1, prefix: 'JHS' }],
    orders: [{ type: 'strike', ship: 'md.0', ready: '+2' }],
  },
  senate_double_damage: {
    name: 'The Senate authorises war',
    factions: [
      { key: 'terra', name: 'Terran Directorate', home: 'earth', color: '#4fc3f7', color2: '#0b2a3d', emblem: 'star' },
      { key: 'mars', name: 'Martian Combine', home: 'mars', color: '#ff4d3a', color2: '#3a0d08', emblem: 'hammer' },
      { key: 'jove', name: 'Jovian Hegemony', home: 'ganymede', color: '#a879ff', color2: '#22123f', emblem: 'crown' },
    ],
    viewer: 'terra',
    wars: [['terra', 'mars']],
    // Terra's guns hit twice as hard, and Mars takes double damage: two bills, both passed.
    laws: [
      { slider: 'combat_damage_multiplier', value: 2, target: 'terra', proposer: 'terra', title: 'Stronger Guns for Terra', yea: ['terra', 'jove'], nay: ['mars'] },
      { kind: 'war_authorization', target: 'mars', proposer: 'terra', title: 'War on Mars', yea: ['terra', 'jove'], nay: ['mars'] },
    ],
    ships: [
      { key: 'terra_home', owner: 'terra', at: 'earth', mix: { destroyer: 4, frigate: 4, corvette: 4 }, loadout: 'mixed', hp: 1.5, prefix: 'TDS' },
      { key: 'mars_siege', owner: 'mars', at: 'earth', mix: { destroyer: 4, frigate: 4, corvette: 4 }, loadout: 'mixed', hp: 1.5, prefix: 'MCS' },
    ],
  },
  supply_line: {
    name: 'Supply line Mars to Ceres',
    factions: [
      { key: 'mars', name: 'Martian Combine', home: 'mars', color: '#ff4d3a', color2: '#3a0d08', emblem: 'hammer' },
      { key: 'terra', name: 'Terran Directorate', home: 'earth', color: '#4fc3f7', color2: '#0b2a3d', emblem: 'star' },
    ],
    viewer: 'mars',
    worlds: [{ body: 'ceres', owner: 'mars', living: true, cities: ['Piazzi Station'] }],
    ships: [{ key: 'fr', owner: 'mars', at: 'mars', class: 'freighter', count: 1, loadout: 'default', prefix: 'MCS' }],
    orders: [{ type: 'trade', ship: 'fr.0', from: 'mars', to: 'ceres' }],
  },
};

