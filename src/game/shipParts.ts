// ============================================================
// Ship parts — client mirror of worker/shipDesigns.js.
// DESIGN-identity-economy.md §2 is the authoritative spec.
//
// KEEP IN SYNC with the worker module. Server columns are metal/gold;
// the client calls the same resources ore/credits (same rename as
// everywhere else at the network boundary).
//
// MULTIPLAYER ONLY. The SP sim (gameContext) never creates parts —
// SP ships carry no `parts` field, so every helper here degrades to
// the identity for them (bare hull = today's ship exactly).
// ============================================================

import { ShipClassName, SHIP_CLASSES } from './shipClasses';

export type ShipPartId = 'kinetic' | 'energy' | 'shield' | 'armor' | 'engine' | 'detonator' | 'repair';

/** Damage type a weapon mount deals / a defensive part resists.
 *  The counter-matrix is REDUCTION-ONLY: shields cut kinetic, armor cuts
 *  energy, and neither type ever gets a damage BONUS against the defence
 *  that can't stop it — it simply arrives unreduced.
 *
 *  Gun copy says "Strong against 🪨 armor" anyway, and that is a
 *  deliberate call by Lorne, not an oversight: it is COMPARATIVE pick
 *  advice (into an armored target, kinetic is the better of the two
 *  guns), immediately followed by the only real number — what the
 *  counter takes off. Do not "correct" it into a damage bonus, and do
 *  not add a "+X% vs armor" figure; there is none to quote. */
export type DamageType = 'kinetic' | 'energy';

/** Legacy part ids from before the kinetic/energy split. `weapon` was
 *  an undifferentiated mount; it becomes kinetic (also the bare-hull
 *  default damage type), so old parts_json + saved designs keep working
 *  with no data migration. Applied on every read via sanitizeParts. */
const PART_ALIAS: Record<string, ShipPartId> = { weapon: 'kinetic' };

// --- Damage-type counter-matrix. Mirrors worker/shipDesigns.js. ---
// A defensive part cuts incoming damage of the type it counters to this
// factor, per part, multiplicatively. Non-countered damage passes at
// full. So 2 shields => kinetic ×0.61, meaning energy does ~1.65× kinetic
// against that hull — the "soft, roughly double" bite.
export const DAMAGE_MITIGATION_PER_PART = 0.78;
/** Shields counter kinetic; armor counters energy. */
const COUNTERED_BY: Record<DamageType, ShipPartId> = { kinetic: 'shield', energy: 'armor' };
/** Total incoming-damage reduction (mitigation × point-defense) is
 *  floored here — an 85% cap — so a stacked hull is brutal but killable. */
export const MITIGATION_FLOOR = 0.15;

/** HP per tick one Repair Bay restores to every friendly hull parked at the
 *  same body. KEEP IN SYNC with REPAIR_TENDER_PER_BAY in
 *  worker/shipDesigns.js — the server pays it, this quotes it. */
export const REPAIR_TENDER_PER_BAY = 8;

export interface ShipPartDef {
  id: ShipPartId;
  name: string;
  /** One-line effect description shown on the designer part card.
   *  For the detonator this is NOT the full disclosure — use
   *  detonatorDisclosure() wherever a detonator surfaces (spec §2.2:
   *  damage amount + friendly fire + ship consumed, all three,
   *  every time). */
  blurb: string;
  cost: { ore: number; credits: number };
  allowedOn: ShipClassName[];
  /** Tech track that scales this part's effect, for the designer UI. */
  techTrack: 'weapons' | 'energy_weapons' | 'shields' | 'armor' | 'propulsion';
  techNote: string;
  /** Weapons only: the damage type this mount deals. */
  damageType?: DamageType;
}

/** Part slots per hull. Freighter's single slot is engine/shield only.
 *  Colony ships have no designer at all (0 slots — filtered out of the
 *  ShipDesigner class tabs). */
export const SHIP_SLOT_COUNTS: Record<ShipClassName, number> = {
  corvette: 2,
  frigate: 4,
  destroyer: 6,
  freighter: 1,
  colony: 0,
};

/** Standard-issue fitting per hull — the "Default" template every player
 *  starts with, and the fallback when no design is active.
 *  KEEP IN SYNC with DEFAULT_LOADOUTS in worker/shipDesigns.js. */
export const DEFAULT_LOADOUTS: Record<ShipClassName, ShipPartId[]> = {
  corvette:  ['kinetic', 'engine'],
  frigate:   ['kinetic', 'kinetic', 'shield', 'engine'],
  destroyer: ['kinetic', 'kinetic', 'kinetic', 'shield', 'shield', 'engine'],
  freighter: ['engine'],
  colony:    [],
};

/**
 * CURRENCY SPLIT (2026-08-09). Metal buys KINETIC + SHIELD; credits buy
 * ENERGY + ARMOR. The pairing is CROSSED on purpose, and that crossing —
 * not the 8:1 ratio — is the whole mechanism.
 *
 * Shield stops kinetic; armor stops energy. So a one-currency empire
 * ends up holding the defense that is useless against what its enemy
 * actually shoots: a mono-metal empire fields kinetic guns and shields,
 * a credit empire shoots energy, and shields do nothing about energy.
 * You cannot build a complete warship on a single currency, which makes
 * economic diversity a MILITARY requirement rather than a preference.
 *
 * The previous 3:1 spread paired metal with kinetic AND armor — same
 * side, and therefore inert: a mono-metal empire already carried the
 * right defense against a credit empire, so nobody ever had to trade.
 *
 * 8:1 rather than 1:0 because the sim measured a 9.4x spawn imbalance in
 * starting yields; at 1:0 a metal-poor spawn simply could not field the
 * energy half of the game. At 8:1 every design stays buildable, just
 * expensively.
 *
 * KEEP IN SYNC with SHIP_PART_DEFS in worker/shipDesigns.js.
 */
export const SHIP_PART_DEFS: Record<ShipPartId, ShipPartDef> = {
  kinetic: {
    id: 'kinetic',
    name: 'Kinetic Mount',
    blurb: '+40% hull base damage, kinetic. Strong against 🪨 armor. Each 🛡 shield cuts damage by 22% (compounding).',
    cost: { ore: 8, credits: 1 },
    allowedOn: ['corvette', 'frigate', 'destroyer'],
    techTrack: 'weapons',
    techNote: 'Kinetic Weapons tech: +10%/lvl to this mount',
    damageType: 'kinetic',
  },
  energy: {
    id: 'energy',
    name: 'Energy Mount',
    blurb: '+40% hull base damage, energy. Strong against 🛡 shields. Each 🪨 armor plate cuts damage by 22% (compounding).',
    cost: { ore: 1, credits: 8 },
    allowedOn: ['corvette', 'frigate', 'destroyer'],
    techTrack: 'energy_weapons',
    techNote: 'Energy Weapons tech: +10%/lvl to this mount',
    damageType: 'energy',
  },
  shield: {
    id: 'shield',
    name: 'Shield Array',
    blurb: '+35% hull base HP. Cuts incoming ⚔ KINETIC by 22% per array, compounding: 22% / 39% / 53% for 1 / 2 / 3. No effect on ⚡ energy.',
    cost: { ore: 8, credits: 1 },
    allowedOn: ['corvette', 'frigate', 'destroyer', 'freighter'],
    techTrack: 'shields',
    techNote: 'Shields tech: +8%/lvl to this array',
  },
  armor: {
    id: 'armor',
    name: 'Armor Plate',
    blurb: '+35% hull base HP. Cuts incoming ⚡ ENERGY by 22% per plate, compounding: 22% / 39% / 53% for 1 / 2 / 3. No effect on ⚔ kinetic.',
    cost: { ore: 1, credits: 8 },
    allowedOn: ['corvette', 'frigate', 'destroyer', 'freighter'],
    techTrack: 'armor',
    techNote: 'Armor tech: +8%/lvl to this plate',
  },
  engine: {
    id: 'engine',
    name: 'Booster Engine',
    blurb: '+speed per engine: arrives sooner AND harder to hit. Caps out.',
    cost: { ore: 2, credits: 6 },
    allowedOn: ['corvette', 'frigate', 'destroyer', 'freighter'],
    techTrack: 'propulsion',
    techNote: 'Propulsion tech: +6%/lvl to this part',
  },
  detonator: {
    id: 'detonator',
    name: 'Fusion Detonator',
    // Full disclosure lives in detonatorDisclosure(); this short line
    // still names all three consequences per the spec's UX rule.
    blurb: 'Self-destruct charge: massive blast, hits friend AND foe, ship is destroyed.',
    cost: { ore: 10, credits: 10 },
    allowedOn: ['corvette', 'frigate', 'destroyer'],
    techTrack: 'weapons',
    techNote: 'Weapons tech: +5%/lvl to blast (half rate)',
  },
  repair: {
    id: 'repair',
    name: 'Repair Bay',
    blurb: `Field tender: repairs ONE friendly ship parked at the same body — the worst off — at ${REPAIR_TENDER_PER_BAY} HP/tick. Works anywhere, no station needed. Only fits a freighter.`,
    cost: { ore: 4, credits: 10 },
    allowedOn: ['freighter'],
    techTrack: 'armor',
    techNote: 'Flat rate — repair scales with shipyards, not tech',
  },
};

export const ALL_PART_IDS: ShipPartId[] = ['kinetic', 'energy', 'shield', 'armor', 'engine', 'detonator', 'repair'];

/** Single-glyph icon per part, for compact loadout summaries (ShipDesigner
 *  library rows, FleetPanel ship rows). One source of truth so the two
 *  surfaces never drift. */
export const PART_GLYPH: Record<ShipPartId, string> = {
  kinetic: '⚔',
  energy: '⚡',
  shield: '🛡',
  armor: '🪨',
  engine: '🔥',
  detonator: '☠',
  repair: '🔧',
};

/** Fixed display order for a loadout summary — weapon, shield, engine,
 *  detonator — so the same parts always read the same way regardless of
 *  the order they were fitted in. */
const GLYPH_ORDER: ShipPartId[] = ['kinetic', 'energy', 'shield', 'armor', 'engine', 'detonator', 'repair'];

/**
 * Compact loadout summary for a ship's parts, e.g. "⚔×2 🛡 🔥" or
 * "bare hull". Groups by part kind in a fixed order; a count suffix is
 * shown only when >1. Returns null when the ship carries no parts field
 * at all (SP ship / colony / freighter with an empty slot) so callers can
 * choose to render nothing rather than "bare hull" where that's noise.
 */
export function loadoutSummary(parts: readonly string[] | undefined): string | null {
  if (!parts) return null;
  const clean = sanitizeParts(parts);
  if (clean.length === 0) return 'bare hull';
  return GLYPH_ORDER
    .map(id => {
      const n = clean.filter(p => p === id).length;
      if (n === 0) return null;
      return n > 1 ? `${PART_GLYPH[id]}×${n}` : PART_GLYPH[id];
    })
    .filter(Boolean)
    .join(' ');
}

const WEAPON_DMG_PCT = 0.40;
const SHIELD_HP_PCT = 0.35;
const ENGINE_TRAVEL_PCT = 0.15;
const DETONATOR_HP_FRAC = 0.50;
const WEAPONS_TECH_PER_LVL = 0.10;
const ARMOR_TECH_PER_LVL = 0.08;
const PROPULSION_TECH_PER_LVL = 0.06;
const DETONATOR_TECH_PER_LVL = WEAPONS_TECH_PER_LVL / 2;

/** Narrow an untyped string[] (e.g. server parts_json) to known part ids,
 *  mapping legacy ids (weapon -> kinetic) through PART_ALIAS first. */
export function sanitizeParts(raw: unknown): ShipPartId[] {
  if (!Array.isArray(raw)) return [];
  const out: ShipPartId[] = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const id = (PART_ALIAS[p] ?? p) as ShipPartId;
    if (id in SHIP_PART_DEFS) out.push(id);
  }
  return out;
}

// ------------------------------------------------------------
// Damage-type model — mirrored in worker/shipDesigns.js.
// ------------------------------------------------------------

/**
 * Fraction of a loadout's weapon output that is each damage type.
 * A hull with no weapon mounts (bare hull, freighter, or a target with
 * only defensive parts) deals 100% kinetic — the neutral default, so
 * every legacy/undesigned ship behaves exactly as before.
 */
export function damageProfile(parts: readonly string[] | undefined): Record<DamageType, number> {
  const k = countPart(parts, 'kinetic');
  const e = countPart(parts, 'energy');
  const total = k + e;
  if (total === 0) return { kinetic: 1, energy: 0 };
  return { kinetic: k / total, energy: e / total };
}

/**
 * Incoming-damage multiplier a TARGET's defensive parts apply, blended
 * by the ATTACKER's damage profile. Shields cut kinetic, armor cuts
 * energy, each 0.78^count; the untouched type passes at full. Returns a
 * value in (0, 1]; 1.0 means no mitigation (no relevant parts).
 */
export function defenseMitigation(
  targetParts: readonly string[] | undefined,
  profile: Record<DamageType, number>,
): number {
  const kMit = Math.pow(DAMAGE_MITIGATION_PER_PART, countPart(targetParts, COUNTERED_BY.kinetic));
  const eMit = Math.pow(DAMAGE_MITIGATION_PER_PART, countPart(targetParts, COUNTERED_BY.energy));
  return profile.kinetic * kMit + profile.energy * eMit;
}

/**
 * What percentage of its countered damage type gets THROUGH `n` matching
 * defensive parts — 100 at n=0, 78 at n=1, 61 at n=2, and so on, floored
 * by MITIGATION_FLOOR the way room.js floors the blended result.
 *
 * Exists so UI copy quotes the real constants instead of hardcoding
 * "78%" in a dozen strings that then drift when the matrix is tuned.
 */
export function mitigationPct(n: number): number {
  return Math.round(
    Math.max(MITIGATION_FLOOR, Math.pow(DAMAGE_MITIGATION_PER_PART, Math.max(0, n))) * 100,
  );
}

/**
 * How much damage `n` countering parts REMOVE — 0, 22, 39, 53, 63...
 *
 * The complement of mitigationPct, and the number players actually want.
 * "Cuts it to 78%" was read as a 32% reduction by the game's own designer,
 * and two parts were assumed to stack to 64%. Neither is right: one part
 * removes 22%, and the second removes 22% of what SURVIVED the first, so
 * two compound to 39% rather than adding to 44%. Copy that quotes a
 * per-part figure without the ladder invites exactly that addition, so
 * every surface using this should also show reductionLadder().
 */
export function reductionPct(n: number): number {
  return 100 - mitigationPct(n);
}

/** "22% / 39% / 53% for 1 / 2 / 3" — the compounding made unmissable. */
export function reductionLadder(upTo: number = 3): string {
  const cuts: number[] = [];
  for (let i = 1; i <= upTo; i++) cuts.push(reductionPct(i));
  return cuts.map(c => `${c}%`).join(' / ');
}

export function countPart(parts: readonly string[] | undefined, id: ShipPartId): number {
  if (!parts) return 0;
  let n = 0;
  for (const p of parts) if (p === id) n++;
  return n;
}

/**
 * Cost escalation for STACKING the same part. The k-th copy of a part
 * type costs base × ESCALATION^(k-1), so a triple-kinetic destroyer pays
 * a real premium over a single-mount one.
 *
 * Why: hull + part costs were FLAT, so a fully-armed destroyer (48 metal
 * / 37 credits) cost less than a single mid-tier building upgrade — the
 * strongest unit in the game was effectively free and there was nothing
 * to spend a mature economy on. Escalation makes heavy loadouts a real
 * investment and gives specialisation a price, without taxing the player
 * who fits one of each.
 *
 * KEEP IN SYNC with worker/shipDesigns.js partsCost().
 */
export const PART_STACK_ESCALATION = 1.75;

/** Sum of part costs (hull cost NOT included), with stacking escalation.
 *  Rounded per-part so client and server agree exactly on integers. */
export function partsCost(parts: readonly ShipPartId[]): { ore: number; credits: number } {
  const seen: Partial<Record<ShipPartId, number>> = {};
  let ore = 0, credits = 0;
  for (const p of parts) {
    const def = SHIP_PART_DEFS[p];
    if (!def) continue;
    const n = (seen[p] ?? 0);           // copies already counted
    seen[p] = n + 1;
    const mul = Math.pow(PART_STACK_ESCALATION, n);
    ore += Math.round(def.cost.ore * mul);
    credits += Math.round(def.cost.credits * mul);
  }
  return { ore, credits };
}

/**
 * Refit fee (DESIGN-fleet-economy §2): half the ADDED parts' escalated
 * price. Per part type, copies kept from the old loadout are free,
 * removed copies refund NOTHING, and each added copy is priced at its
 * stack position in the NEW loadout. Applied per resource with ceil so
 * quotes stay integers. KEEP IN SYNC with refitFee in
 * worker/shipDesigns.js — the client's quote must equal the server's charge.
 */
export const REFIT_MULTIPLIER = 0.5;

function stackCost(counts: Partial<Record<ShipPartId, number>>): { ore: number; credits: number } {
  let ore = 0, credits = 0;
  for (const [p, n] of Object.entries(counts) as [ShipPartId, number][]) {
    const def = SHIP_PART_DEFS[p];
    if (!def) continue;
    for (let k = 0; k < n; k++) {
      const mul = Math.pow(PART_STACK_ESCALATION, k);
      ore += Math.round(def.cost.ore * mul);
      credits += Math.round(def.cost.credits * mul);
    }
  }
  return { ore, credits };
}

export function refitFee(
  oldParts: readonly ShipPartId[],
  newParts: readonly ShipPartId[],
): { ore: number; credits: number } {
  const count = (parts: readonly ShipPartId[]) => {
    const c: Partial<Record<ShipPartId, number>> = {};
    for (const p of parts) c[p] = (c[p] ?? 0) + 1;
    return c;
  };
  const oldC = count(oldParts);
  const newC = count(newParts);
  const kept: Partial<Record<ShipPartId, number>> = {};
  for (const [p, n] of Object.entries(newC) as [ShipPartId, number][]) {
    kept[p] = Math.min(n, oldC[p] ?? 0);
  }
  const full = stackCost(newC);
  const retained = stackCost(kept);
  return {
    ore: Math.ceil(Math.max(0, full.ore - retained.ore) * REFIT_MULTIPLIER),
    credits: Math.ceil(Math.max(0, full.credits - retained.credits) * REFIT_MULTIPLIER),
  };
}

/**
 * Travel-time multiplier from engine parts: (1 − 0.15·techBoost)^n.
 * Propulsion tech boosts the per-engine effect (+6%/lvl). Floor 0.1 so
 * a stacked destroyer can't hit zero-time transfers.
 */
export function engineTravelMultiplier(
  parts: readonly string[] | undefined,
  propulsionLvl: number = 0,
): number {
  const n = countPart(parts, 'engine');
  if (n <= 0) return 1;
  const perEngine = Math.min(0.9, ENGINE_TRAVEL_PCT * (1 + PROPULSION_TECH_PER_LVL * Math.max(0, propulsionLvl)));
  return Math.max(0.1, Math.pow(1 - perEngine, n));
}

/**
 * Acceleration multiplier that realizes the travel-time multiplier
 * under the brachistochrone T = 2·√(d/a): scaling time by m means
 * scaling acceleration by 1/m². Applied where the transfer planner
 * picks the ship's engine accel (client-side — the server accepts the
 * client's arrival_t as-is; see handleCommitTransfer).
 */
export function engineAccelMultiplier(
  parts: readonly string[] | undefined,
  propulsionLvl: number = 0,
): number {
  const m = engineTravelMultiplier(parts, propulsionLvl);
  return 1 / (m * m);
}

/**
 * Combat stats for a hull + loadout at the given tech levels. Bare
 * hull returns the class-def stats untouched (tech scales PART effects
 * only — a bare hull is today's ship no matter the research state).
 */
export function computeDesignStats(
  shipClass: ShipClassName,
  parts: readonly ShipPartId[],
  techLevels: Partial<Record<string, number>> = {},
): {
  hp: number;
  damagePerTick: number;
  speed: number;
  travelTimeMult: number;
  /** Hull + parts, in client resource names. */
  totalCost: { ore: number; credits: number };
} {
  const def = SHIP_CLASSES[shipClass];
  const kineticLvl = Math.max(0, techLevels.weapons ?? 0);
  const energyLvl = Math.max(0, techLevels.energy_weapons ?? 0);
  const shieldsLvl = Math.max(0, techLevels.shields ?? 0);
  const armorLvl = Math.max(0, techLevels.armor ?? 0);
  const propulsionLvl = Math.max(0, techLevels.propulsion ?? 0);
  const nKinetic = countPart(parts, 'kinetic');
  const nEnergy = countPart(parts, 'energy');
  const nShields = countPart(parts, 'shield');
  const nArmor = countPart(parts, 'armor');
  // Server hull base is worker SHIP_COMBAT_STATS which matches the
  // class def hp/damagePerTick for every class except freighter hp
  // (server 30 vs client def 60) — use the server-authoritative bases
  // so the designer preview matches what the yard actually delivers.
  const base = SERVER_HULL_BASE[shipClass];
  // Each mount type scales with its own weapon tech; each defensive part
  // with its own defensive tech. Same per-part % and per-level rate as
  // before the split.
  const dmgBonus = WEAPON_DMG_PCT * (
    (1 + WEAPONS_TECH_PER_LVL * kineticLvl) * nKinetic
    + (1 + WEAPONS_TECH_PER_LVL * energyLvl) * nEnergy
  );
  const hpBonus = SHIELD_HP_PCT * (
    (1 + ARMOR_TECH_PER_LVL * shieldsLvl) * nShields
    + (1 + ARMOR_TECH_PER_LVL * armorLvl) * nArmor
  );
  const pc = partsCost(parts);
  return {
    hp: Math.round(base.hp * (1 + hpBonus)),
    damagePerTick: Math.round(base.damagePerTick * (1 + dmgBonus) * 10) / 10,
    // COMBAT V2: the designer quotes speed live so a player watching the
    // number move while fitting an engine learns the rule for free.
    speed: Math.round(combatSpeedOf(shipClass, parts) * 1000) / 1000,
    travelTimeMult: engineTravelMultiplier(parts, propulsionLvl),
    totalCost: { ore: def.cost.ore + pc.ore, credits: def.cost.credits + pc.credits },
  };
}

/** Server-authoritative hull combat bases (worker/factions.js
 *  SHIP_COMBAT_STATS). KEEP IN SYNC. */
export const SERVER_HULL_BASE: Record<
  ShipClassName,
  { hp: number; damagePerTick: number; speed: number }
> = {
  corvette: { hp: 40, damagePerTick: 7, speed: 0.85 },
  frigate: { hp: 100, damagePerTick: 20.25, speed: 0.50 },
  destroyer: { hp: 400, damagePerTick: 45, speed: 0.30 },
  freighter: { hp: 60, damagePerTick: 0, speed: 0.55 },
  colony: { hp: 60, damagePerTick: 0, speed: 0.55 },
};

/** Reference hull for travel normalisation — a frigate's trip is unchanged
 *  by COMBAT V2 and everything else moves relative to it. */
export const FRIGATE_SPEED = 0.50;
/** One engine's speed multiplier — the reciprocal of the -15% travel time
 *  the part already shipped with, so engine behaviour is preserved. */
export const ENGINE_SPEED_MUL = 1 / 0.85;
/** Ceiling on speed, for BOTH the hit roll and travel. Written as 1/0.85 so a
 *  fully-engined corvette (0.85 * (1/0.85)^2) lands exactly on it rather than
 *  being clipped a hair short and looking like a wasted slot. */
export const SPEED_CAP = 1 / 0.85;

/** COMBAT V2 speed for a hull + loadout. Mirrors worker/shipDesigns.js
 *  shipSpeed — KEEP IN SYNC. Tech is deliberately excluded: Propulsion
 *  raises the per-engine travel step elsewhere. */
export function combatSpeedOf(shipClass: ShipClassName, parts: readonly string[] | undefined): number {
  const base = SERVER_HULL_BASE[shipClass]?.speed ?? FRIGATE_SPEED;
  return Math.min(SPEED_CAP, base * Math.pow(ENGINE_SPEED_MUL, countPart(parts, 'engine')));
}

/** Chance `attacker` lands a shot on `defender`, both as 0-1 speeds.
 *  Symmetric; mirrors are always 50%; never 0 or 1. */
export function hitChanceOf(atkSpeed: number, defSpeed: number): number {
  const a = atkSpeed * atkSpeed;
  const d = defSpeed * defSpeed;
  return a + d <= 0 ? 0.5 : a / (a + d);
}

/**
 * Travel-time multiplier for a speed, normalised so a frigate is unchanged.
 *
 * Callers that want ACCELERATION must square the ratio instead: trip time is
 * brachistochrone T = 2*sqrt(d/a), so a linear speed ratio needs a squared
 * accel ratio. Getting this wrong makes a corvette 23% faster instead of 41%
 * and nobody can see why.
 */
export function travelMultiplierOf(speed: number): number {
  return FRIGATE_SPEED / Math.max(0.01, speed);
}
/** Acceleration multiplier that realises travelMultiplierOf under T=2*sqrt(d/a). */
export function travelAccelMultiplierOf(speed: number): number {
  const r = Math.max(0.01, speed) / FRIGATE_SPEED;
  return r * r;
}

/** Blast damage: 50% of max HP per detonator, Weapons tech at half rate. */
export function detonatorDamage(hpMax: number, detonatorCount: number, weaponsLvl: number = 0): number {
  return Math.round(
    Math.max(0, hpMax) * DETONATOR_HP_FRAC * Math.max(0, detonatorCount)
    * (1 + DETONATOR_TECH_PER_LVL * Math.max(0, weaponsLvl)),
  );
}

/**
 * REQUIRED detonator copy (spec §2.2): every surface where a detonator
 * appears must state ALL THREE — the damage amount, that it hits
 * friend and foe alike, and that the ship is destroyed.
 */
export function detonatorDisclosure(damage: number): string {
  return `Detonate: deal ${damage} damage (50% of max HP per detonator) to every ship in this orbit — friend or foe alike. This ship is destroyed.`;
}
