// ============================================================================
// configSchema.js — every tunable in the game, declared once.
//
// THIS FILE IS THE PRODUCT. The Editor page has no hand-written form
// controls; it renders itself from this array. Adding a new knob is a
// single entry here — a label, a default, bounds — and it appears in the
// admin UI, validates on write, and resolves at runtime, with no React
// touched and nobody needing me to wire it.
//
// That is the whole design goal: coverage should grow by DECLARATION,
// not by engineering.
//
// RULES FOR AN ENTRY
//   id       stable key. Renaming one orphans saved drafts, so don't.
//   group    which tab it lands under in the editor.
//   label    what a human calls it.
//   help     why you would touch it, and what breaks if you overdo it.
//   type     'number' | 'int' | 'bool' | 'enum'
//   def      the value the game shipped with. MUST match the constant it
//            replaces, or publishing an untouched draft silently rebalances
//            the game.
//   min/max  hard bounds. Enforced server-side on save, not just in the UI.
//   step     UI granularity only.
//   danger   true = shown with a warning; these can break a live economy.
//
// Every `def` below was read out of the source it replaces rather than
// remembered. If you change the constant in code, change it here too —
// or better, delete the constant and read the config.
// ============================================================================

export const GROUPS = [
  { id: 'yields', label: 'Yields & Growth', blurb: 'What worlds produce, and how fast settlements grow.' },
  { id: 'buildings', label: 'Buildings', blurb: 'Cost and effect of the compounding structures.' },
  { id: 'fleet', label: 'Fleet & Upkeep', blurb: 'What ships cost to own. Sim runs show this is what bankrupts empires.' },
  { id: 'combat', label: 'Combat', blurb: 'How often shots are exchanged and how hard they land.' },
  { id: 'research', label: 'Research', blurb: 'Tech cost curve and ceiling.' },
  { id: 'victory', label: 'Victory', blurb: 'What it takes to actually win.' },
  { id: 'map', label: 'Map Scale', blurb: 'Two global multipliers over the whole solar system. Also editable on the Map tab.' },
  { id: 'spawn', label: 'Spawn Rules', blurb: 'Who starts where. The 100-game sweep put best-vs-worst capital at 9.4x.' },
];

export const SCHEMA = [
  // ---- yields ------------------------------------------------------------
  {
    id: 'yield_mult_per_pop', group: 'yields', type: 'number',
    label: 'Yield bonus per population', def: 0.1, min: 0, max: 1, step: 0.01,
    help: 'Each point of settlement population multiplies output by this much. '
      + 'Compounds with buildings, so small changes here move the whole late game.',
  },
  {
    id: 'pop_growth_interval', group: 'yields', type: 'int',
    label: 'Ticks per population growth', def: 20, min: 1, max: 200, step: 1,
    help: 'Lower grows empires faster. This is the main lever on overall game pace.',
  },
  {
    id: 'pop_max', group: 'yields', type: 'int',
    label: 'Maximum population (0 = uncapped)', def: 0, min: 0, max: 500, step: 1,
    help: 'Population ceiling per settlement. 0 means no ceiling — a world you '
      + 'hold keeps growing for as long as you hold it, which is the point: '
      + 'holding ground should compound. The yield bonus is LINEAR in '
      + 'population (1 + rate x (pop-1)), not exponential, so uncapping grows '
      + 'income steadily rather than explosively.',
  },
  {
    id: 'terraform_cost_metal', group: 'yields', type: 'int',
    label: 'Terraform metal cost', def: 124, min: 0, max: 5000, step: 1,
    help: 'Metal a terraform supply line must deliver to a raw world before '
      + 'the transformation window opens.',
  },
  {
    id: 'terraform_cost_credits', group: 'yields', type: 'int',
    label: 'Terraform credit cost', def: 124, min: 0, max: 5000, step: 1,
    help: 'Credits a terraform supply line must deliver to a raw world before '
      + 'the transformation window opens.',
  },
  {
    id: 'terraform_duration_ticks', group: 'yields', type: 'int',
    label: 'Terraform duration (ticks)', def: 24, min: 1, max: 500, step: 1,
    help: 'Ticks the transformation takes once the full payload has been '
      + 'delivered. The world terraforms at the end of the window.',
  },

  {
    id: 'terraform_cost_growth', group: 'yields', type: 'number',
    label: 'Terraform cost growth per world', def: 1.0, min: 1, max: 3, step: 0.05,
    help: 'Multiplier compounding per world you have ALREADY terraformed, so '
      + 'the Nth terraform costs base x growth^(N-1). 1.0 is flat. Above 1.0 '
      + 'this is the brake on a runaway leader: the empire with eight worlds '
      + 'pays more for its ninth than a rival pays for their second.',
  },

  // ---- starting hand -----------------------------------------------------
  // These were constants in worker/factions.js until the terraforming
  // balance pass. They are the single most-adjusted numbers in any 4X and
  // the sweep needs to vary them, so they belong here where a host (and
  // the simulator) can reach them.
  // 300/300 is a MEASURED default, not a guess — sim/economySweep.mjs,
  // 100 games across ten economies, plus a 100-game control run with a
  // freighter-heavy doctrine. Reach is the share of empires that COMMIT
  // to expanding and actually finish a terraform inside 250 ticks:
  //
  //   100/100    50%    first world t+95    best:worst wealth 7.1x
  //   200/200    80%    first world t+66    3.2x
  //   300/300   100%    first world t+70    4.0x  (3.8x in the control)
  //
  // At the old 100/100 half of the empires that tried to expand never
  // finished a single world — a coin flip, not a decision. 300 is the
  // only setting where every committed expander got there in both runs.
  //
  // The counter-intuitive column is the third. Funding the opening did
  // not hand the leader a bigger lead; inequality FELL. A thin purse
  // does not restrain a runaway, it adds variance — every empire gambles
  // the same small stake and the winner is whoever the dice favoured.
  // The 200-vs-300 gap in that column (4.0x vs 3.2x) flipped sign between
  // the two runs, so treat it as noise; the reach difference did not.
  {
    id: 'starting_metal', group: 'yields', type: 'int',
    label: 'Starting metal', def: 300, min: 0, max: 5000, step: 10,
    help: 'Metal each empire opens with.',
  },
  {
    id: 'starting_credits', group: 'yields', type: 'int',
    label: 'Starting credits', def: 300, min: 0, max: 5000, step: 10,
    help: 'Credits each empire opens with. Credits carry fleet upkeep AND the '
      + 'credit half of every terraform, so this is the tighter of the two.',
  },
  {
    // id keeps its legacy name — stored game configs reference it.
    id: 'no_collector_pool_fraction', group: 'yields', type: 'number',
    label: 'Raw-world yield to faction pool', def: 0.10, min: 0, max: 1, step: 0.01,
    help: 'Share of a settlement\'s output that reaches the empire pool on a RAW '
      + '(un-terraformed) world. The remainder banks as local stockpile. '
      + 'Terraformed worlds always pay 100% to pool.',
  },

  // ---- buildings ---------------------------------------------------------
  {
    id: 'forge_per_level', group: 'buildings', type: 'number',
    label: 'Forge: metal bonus per level', def: 0.25, min: 0, max: 2, step: 0.05,
    help: 'Compounds as (1 + x)^level. At 0.25 a three-level forge nearly doubles metal.',
  },
  {
    id: 'mint_per_level', group: 'buildings', type: 'number',
    label: 'Mint: credit bonus per level', def: 0.25, min: 0, max: 2, step: 0.05,
    help: 'Compounds as (1 + x)^level. Sim games that built mints reached 100k+ credits; '
      + 'ones that did not could not cover fleet upkeep at all.',
  },
  {
    id: 'lab_per_level', group: 'buildings', type: 'number',
    label: 'Lab: science bonus per level', def: 0.25, min: 0, max: 2, step: 0.05,
    help: 'Compounds as (1 + x)^level. Held at parity with forge and mint by the economy rework; '
      + 'breaking parity is what left science 2.5x behind before.',
  },
  {
    id: 'ship_cost_mult', group: 'fleet', type: 'number',
    label: 'Ship price multiplier', def: 1.0, min: 0.1, max: 5, step: 0.05,
    help: 'Scales hull AND part cost at queue time. The lever for "are '
      + 'warships worth what they cost" — stacks with the senate build-cost '
      + 'law and the Construction discount rather than replacing either.',
  },
  {
    id: 'building_cost_mult', group: 'buildings', type: 'number',
    label: 'Building price multiplier', def: 1.0, min: 0.1, max: 5, step: 0.05,
    help: 'Scales every building level\'s cost. Buildings are the economy\'s '
      + 'main sink, so this is the primary dial against treasuries that '
      + 'balloon with nothing to buy.',
  },
  {
    id: 'building_cost_scaling', group: 'buildings', type: 'number',
    label: 'Cost growth per building level', def: 1.6, min: 1, max: 4, step: 0.05,
    help: 'Each level costs this multiple of the last. Below ~1.3 compounding runs away; '
      + 'above ~2.5 nobody builds past level two.',
  },
  {
    id: 'building_time_scaling', group: 'buildings', type: 'number',
    label: 'Build time growth per level', def: 1.3, min: 1, max: 3, step: 0.05,
    help: 'Same idea as cost scaling, applied to construction ticks.',
  },

  // ---- fleet -------------------------------------------------------------
  {
    id: 'upkeep_corvette_gold', group: 'fleet', type: 'number',
    label: 'Corvette upkeep (credits/tick)', def: 0.25, min: 0, max: 20, step: 0.05,
    help: 'Cheapest hull. In sim runs a corvette swarm was the fastest route to insolvency.',
  },
  {
    id: 'upkeep_frigate_gold', group: 'fleet', type: 'number',
    label: 'Frigate upkeep (credits/tick)', def: 0.5, min: 0, max: 20, step: 0.05,
  },
  {
    id: 'upkeep_frigate_metal', group: 'fleet', type: 'number',
    label: 'Frigate upkeep (metal/tick)', def: 0.5, min: 0, max: 20, step: 0.05,
  },
  {
    id: 'upkeep_destroyer_gold', group: 'fleet', type: 'number',
    label: 'Destroyer upkeep (credits/tick)', def: 1, min: 0, max: 20, step: 0.05,
  },
  {
    id: 'upkeep_destroyer_metal', group: 'fleet', type: 'number',
    label: 'Destroyer upkeep (metal/tick)', def: 1, min: 0, max: 20, step: 0.05,
  },
  {
    id: 'upkeep_freighter_gold', group: 'fleet', type: 'number',
    label: 'Freighter upkeep (credits/tick)', def: 1, min: 0, max: 20, step: 0.05,
  },
  {
    id: 'arrears_damage_mult', group: 'fleet', type: 'number',
    label: 'Damage multiplier while in arrears', def: 0.75, min: 0.1, max: 1, step: 0.05,
    danger: true,
    help: 'Unpaid fleets fight at this fraction of normal damage. 100/100 sim games ended with '
      + 'at least one bankrupt empire, so this penalty currently applies a lot.',
  },
  {
    id: 'cargo_cap', group: 'fleet', type: 'int',
    label: 'Freighter cargo capacity', def: 500, min: 1, max: 100000, step: 10,
  },

  // ---- combat ------------------------------------------------------------
  {
    id: 'auto_combat_interval', group: 'combat', type: 'int',
    label: 'Ticks between automatic exchanges', def: 3, min: 1, max: 50, step: 1,
    danger: true,
    help: 'How often co-located hostiles trade fire. Lowering it makes wars resolve much faster '
      + 'and sharply favours whoever has the bigger fleet on arrival.',
  },
  {
    id: 'transit_combat_enabled', group: 'combat', type: 'int',
    label: 'Transit combat (0 = off, 1 = on)', def: 0, min: 0, max: 1, step: 1,
    danger: true,
    help: 'Ships in flight can shoot and be shot at (DESIGN-transit-combat.md). Off by default: '
      + 'turn it on in a sim room, not a live match. Fights at a body are numerically unchanged '
      + 'either way — the rules only differ once somebody is moving.',
  },
  {
    id: 'transit_evasion_v_ref', group: 'combat', type: 'number',
    label: 'Transit evasion reference (units/tick)', def: 45, min: 10, max: 500, step: 5,
    danger: true,
    help: 'The CROSSING rate at which a target becomes twice as hard to hit. Lower = transit is '
      + 'deadlier to cross in front of. Carried over from an earlier model that measured total '
      + 'relative speed, so it wants re-tuning against real telemetry before anyone trusts it.',
  },
  {
    id: 'station_dmg_per_weapons_level', group: 'combat', type: 'number',
    label: 'Station damage per weapons level', def: 8, min: 0, max: 100, step: 1,
    help: 'Defensive output of a station per level of its weapons building.',
  },
  {
    id: 'repair_station', group: 'combat', type: 'number',
    label: 'Station repair (HP/tick)', def: 2, min: 0, max: 100, step: 0.5,
    help: 'Hull repaired per tick for ships docked at a friendly station.',
  },
  {
    id: 'city_base_hp', group: 'combat', type: 'int',
    label: 'City base HP', def: 300, min: 1, max: 100000, step: 10,
    help: 'Structure a new city is founded with, and what a starting capital gets. '
      + 'Tripled from 100: settlements were falling faster than a defender could respond '
      + 'at an hour per tick.',
  },
  {
    id: 'station_base_hp', group: 'combat', type: 'int',
    label: 'Station base HP', def: 400, min: 1, max: 100000, step: 10,
    help: 'Structure a new station is deployed with. 60 -> 180 -> 400: at combat v2 '
      + 'damage a fitted destroyer hits for ~135, so 180 was under two volleys. '
      + '400 buys a defender three, and puts stations ABOVE cities (300) — an '
      + 'orbital weapons platform should outlast a surface settlement.',
  },
  {
    id: 'shield_hp_per_level', group: 'combat', type: 'int',
    label: 'Shield HP per level', def: 120, min: 0, max: 100000, step: 10,
    help: 'Orbital shield pool = this x building level, so level 3 is 360 on top of the '
      + '300 structure a city has. Shields absorb damage first and regenerate; structure '
      + 'does neither. This is the main dial on how survivable a defended world is.',
  },
  {
    id: 'shield_regen_per_tick', group: 'combat', type: 'number',
    label: 'Shield regen per tick', def: 6, min: 0, max: 1000, step: 1,
    help: 'Pool recovered each tick, up to the maximum. At 6/tick a level-3 shield refills '
      + 'in about an hour of game time — long enough that a raid still costs the defender '
      + 'something, short enough that they are not permanently crippled.',
  },
  {
    id: 'shield_down_grace_ticks', group: 'combat', type: 'int',
    label: 'Ticks before a collapsed shield regenerates', def: 5, min: 0, max: 200, step: 1,
    help: 'After the pool hits zero it stays down this long before recovering. Without it a '
      + 'shield that just broke would soak the very next volley, and no bombardment could '
      + 'ever break through.',
  },
  {
    id: 'repair_grace_ticks', group: 'combat', type: 'int',
    label: 'Ticks after combat before repair resumes', def: 3, min: 0, max: 50, step: 1,
  },

  // ---- research ----------------------------------------------------------
  {
    id: 'research_base_cost', group: 'research', type: 'number',
    label: 'Base research cost', def: 15, min: 1, max: 1000, step: 1,
    help: 'Science for the first level of any track.',
  },
  {
    id: 'research_cost_scaling', group: 'research', type: 'number',
    label: 'Research cost growth per level', def: 1.72, min: 1, max: 4, step: 0.01,
    danger: true,
    help: 'Each level costs this multiple of the last. The single biggest lever on how long '
      + 'a match runs before the tech tree is exhausted.',
  },
  {
    id: 'tech_max_level', group: 'research', type: 'int',
    label: 'Maximum tech level', def: 10, min: 1, max: 50, step: 1,
  },

  // ---- victory -----------------------------------------------------------
  {
    id: 'victory_ships', group: 'victory', type: 'int',
    label: 'Ships required to win', def: 200, min: 1, max: 5000, step: 10,
    help: 'Living hulls needed for the industrial victory. Sim empires peaked around 143 over '
      + '1500 ticks, so 200 is reachable but demanding.',
  },
  {
    id: 'victory_resource', group: 'victory', type: 'int',
    label: 'Each resource required to win', def: 10000, min: 1, max: 1000000, step: 500,
    help: 'Metal, credits AND science must each reach this. Fuel is excluded — it was retired '
      + 'from the economy and requiring it would make victory unreachable by accident.',
  },
  {
    id: 'domination_fraction', group: 'victory', type: 'number',
    label: 'Map share for domination victory', def: 0.6, min: 0.1, max: 1, step: 0.05,
    help: 'Fraction of bodies one empire must hold to win outright.',
  },

  // ---- map ---------------------------------------------------------------
  //
  // Two global multipliers, deliberately knobs rather than a bulk edit
  // that rewrites 45 bodies. One value stays one value: the shipped
  // catalogue keeps flowing through, per-body edits still compose on top,
  // and a later retune of Jupiter is not frozen out by a config carrying
  // its own copy of the solar system.
  {
    id: 'system_scale', group: 'map', type: 'number',
    label: 'System scale (orbit spread)', def: 1, min: 0.1, max: 10, step: 0.05,
    danger: true,
    help: 'Multiplies every PLANET orbit. 2 doubles the distance between worlds and so '
      + 'roughly doubles travel times — the strongest single lever on game pace. Moon orbits '
      + 'are left alone on purpose: they are measured from their planet, and stretching them '
      + 'would push moons outside their parent\'s sphere of influence.',
  },
  {
    id: 'body_scale', group: 'map', type: 'number',
    label: 'Planetoid scale (body size)', def: 1, min: 0.1, max: 10, step: 0.05,
    danger: true,
    help: 'Multiplies every body radius and sphere of influence together, so capture ranges '
      + 'stay proportional to the worlds they belong to. Watch the capital floor: at 0.5 most '
      + 'moons drop under it and the spawn pool collapses. The map shows this live.',
  },

  // ---- spawn -------------------------------------------------------------
  {
    id: 'min_capital_radius', group: 'spawn', type: 'number',
    label: 'Smallest body that can be a capital', def: 1.5, min: 0.1, max: 10, step: 0.1,
    danger: true,
    help: 'Planets and moons at or above this radius only. At 1.5 the pool is 14 bodies. '
      + 'Dropping to 1.0 re-admits Nereid, Proteus, Charon and Deimos, which measured in the '
      + 'bottom half of every sweep — best-vs-worst capital was 9.4x before this floor existed.',
  },
  {
    id: 'min_capital_science', group: 'spawn', type: 'int',
    label: 'Minimum science yield for a capital', def: 2, min: 0, max: 10, step: 1,
    help: 'A science-dead homeworld can never climb the tech tree. Relaxed automatically if too '
      + 'few bodies qualify for the player count — the size floor never is.',
  },
];

// ---------------------------------------------------------------------------
// Bodies
//
// The map is not a list of knobs. 45 worlds x 7 editable fields would be
// 315 entries in SCHEMA, which would drown the tabs and read as noise.
// It is TABULAR data, so it gets its own shape: overrides.bodies is a
// sparse map of templateId -> { field: value }, and only the fields a
// human actually moved are stored.
//
// Sparseness matters more here than anywhere else. If the editor wrote
// all 45 bodies back on every save, a later change to the shipped catalog
// — a new moon, a retuned yield — would be invisible to every existing
// config, because each one would be carrying a full frozen copy of the
// old solar system.
// ---------------------------------------------------------------------------

export const BODY_FIELDS = [
  {
    id: 'orbit_radius', label: 'Orbit radius', type: 'number', min: 5, max: 20000, step: 1,
    help: 'Distance from the star. Drives travel time, which body neighbours which, '
      + 'and belt grouping — the sim clusters rubble within 1.25x of its neighbour.',
  },
  {
    id: 'radius', label: 'Body size', type: 'number', min: 0.1, max: 30, step: 0.1,
    help: 'Physical size. Also decides capital eligibility: anything below the spawn '
      + 'floor (default 1.5) can never be a homeworld.',
  },
  { id: 'yield_metal', label: 'Metal / tick', type: 'int', min: 0, max: 100, step: 1 },
  { id: 'yield_gold', label: 'Credits / tick', type: 'int', min: 0, max: 100, step: 1 },
  {
    id: 'yield_science', label: 'Science / tick', type: 'int', min: 0, max: 100, step: 1,
    help: 'Also gates capitals: a world below the spawn science floor is skipped '
      + 'when assigning homeworlds, because a science-dead start cannot climb the tree.',
  },
  { id: 'yield_fuel', label: 'Fuel / tick', type: 'int', min: 0, max: 100, step: 1,
    help: 'Fuel was retired from the economy; kept editable so the column is not a lie.' },
  {
    id: 'soi', label: 'Sphere of influence', type: 'number', min: 0, max: 500, step: 1,
    help: 'Capture radius for ships. Too small and moons become unreachable; too large '
      + 'and neighbouring bodies fight over the same space.',
  },
];

export const BODY_FIELD_BY_ID = Object.fromEntries(BODY_FIELDS.map(f => [f.id, f]));

/** Validate one body override map. Same total-rejection rule as knobs. */
export function validateBodies(bodies) {
  const clean = {};
  const errors = {};
  for (const [tpl, fields] of Object.entries(bodies ?? {})) {
    if (typeof tpl !== 'string' || !/^[a-z0-9_]{1,40}$/.test(tpl)) {
      errors[tpl] = 'bad_template_id';
      continue;
    }
    const out = {};
    for (const [f, raw] of Object.entries(fields ?? {})) {
      const def = BODY_FIELD_BY_ID[f];
      if (!def) { errors[`${tpl}.${f}`] = 'unknown_field'; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { errors[`${tpl}.${f}`] = 'not_a_number'; continue; }
      if (def.type === 'int' && !Number.isInteger(n)) { errors[`${tpl}.${f}`] = 'must_be_integer'; continue; }
      if (def.min != null && n < def.min) { errors[`${tpl}.${f}`] = `below_min_${def.min}`; continue; }
      if (def.max != null && n > def.max) { errors[`${tpl}.${f}`] = `above_max_${def.max}`; continue; }
      out[f] = n;
    }
    if (Object.keys(out).length) clean[tpl] = out;
  }
  return { clean, errors };
}

/** id -> entry, for validation and lookup. */
export const BY_ID = Object.fromEntries(SCHEMA.map(s => [s.id, s]));

/** The shipped game, as a plain object. This is what a game runs with when
 *  no config has ever been published. */
export function defaults() {
  const out = {};
  for (const s of SCHEMA) out[s.id] = s.def;
  return out;
}

/**
 * Coerce and bound-check one value. Returns {ok, value} or {ok:false,
 * reason}. Enforced on WRITE, server-side — a bad number reaching the tick
 * loop is far more expensive than a rejected form submission.
 */
export function validate(id, raw) {
  const s = BY_ID[id];
  if (!s) return { ok: false, reason: 'unknown_key' };
  if (s.type === 'bool') return { ok: true, value: !!raw };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not_a_number' };
  if (s.type === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'must_be_integer' };
  if (s.min != null && n < s.min) return { ok: false, reason: `below_min_${s.min}` };
  if (s.max != null && n > s.max) return { ok: false, reason: `above_max_${s.max}` };
  return { ok: true, value: n };
}

/** Validate a whole override object, dropping nothing silently. */
export function validateAll(obj) {
  const clean = {};
  const errors = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const r = validate(k, v);
    if (r.ok) clean[k] = r.value;
    else errors[k] = r.reason;
  }
  return { clean, errors };
}
