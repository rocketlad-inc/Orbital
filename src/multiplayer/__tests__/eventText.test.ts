// The headline builder, pinned.
//
// ENGLISH is a contract: combatLog (the English headline) feeds the
// EventLog / RecapOverlay classifiers, logger.log and the exports. The
// expected strings below are what the original in-provider formatEvent
// printed for the same rows (captured before it was moved into eventText.ts
// and also fuzzed against it over ~100k random payloads), so a wording
// "fix" here is a deliberate contract change: update the classifiers too.

import { formatChronicleEvent, secretMessage } from '../eventText';
import { getLang, setLang } from '../../i18n/core';

const ctx = { factionNameById: new Map([['f1', 'Cerean Union'], ['f2', 'Zed Corp']]) };

type Row = [label: string, kind: string, actor: string | null, target: string | null, tick: number,
  payload: unknown, expectedEn: string];

const ROWS: Row[] = [
  ["game_started 3 named", "game_started", null, null, 0, {"factions": [{"name": "Cerean Union"}, {"name": "Zed Corp"}, {"name": "Orion"}]},
    "T+0  🚀 The game begins — 3 factions: Cerean Union, Zed Corp, Orion"],
  ["game_started 1 named", "game_started", null, null, 0, {"factions": [{"name": "Cerean Union"}]},
    "T+0  🚀 The game begins — 1 faction: Cerean Union"],
  ["game_started none", "game_started", null, null, 0, {},
    "T+0  🚀 The game begins — 0 factions"],
  ["faction_eliminated", "faction_eliminated", "f1", null, 32, {},
    "T+32  ☠ Cerean Union has lost its last settlement and is out of the war"],
  ["faction_eliminated payload name", "faction_eliminated", null, null, 32, {"faction_name": "Orion"},
    "T+32  ☠ Orion has lost its last settlement and is out of the war"],
  ["faction_revived", "faction_revived", "f2", null, 12, {},
    "T+12  Zed Corp has founded a new settlement and is back in the war"],
  ["faction_joined", "faction_joined", null, null, 12, {"name": "Orion", "capital_name": "Ceres"},
    "T+12  Orion joins the game — capital at Ceres"],
  ["faction_joined bare", "faction_joined", null, null, 12, {},
    "T+12  A new faction joins the game — capital at an unclaimed world"],
  ["ship_destroyed plain", "ship_destroyed", "f1", null, 12, {"ship_name": "VSS Tuskegee", "ship_class": "frigate", "body_name": "Mars"},
    "T+12  Cerean Union's frigate VSS Tuskegee destroyed at Mars"],
  ["ship_destroyed class-led name", "ship_destroyed", "f1", null, 12, {"ship_name": "Frigate T3-900", "ship_class": "frigate", "body_name": "Mars", "owner_faction_name": "Cerean Union"},
    "T+12  Cerean Union's Frigate T3-900 destroyed at Mars"],
  ["ship_destroyed killer ship", "ship_destroyed", "f1", null, 12, {"ship_name": "Tug", "ship_class": "freighter", "body_name": "Io", "killer_faction_id": "f2", "killer_faction_name": "Zed Corp", "killer_ship_name": "HMS Grudge"},
    "T+12  Cerean Union's freighter Tug destroyed at Io by HMS Grudge (Zed Corp)"],
  ["ship_destroyed killer faction only", "ship_destroyed", "f1", null, 12, {"ship_name": "Tug", "ship_class": "freighter", "body_name": "Io", "killer_faction_id": "f2"},
    "T+12  Cerean Union's freighter Tug destroyed at Io by Zed Corp"],
  ["ship_destroyed in transit", "ship_destroyed", "f1", null, 12, {"ship_name": "Tug", "ship_class": "freighter", "body_name": "Io", "in_transit": true, "dest_body_name": "Europa", "killer_faction_id": "f2", "killer_faction_name": "Zed Corp"},
    "T+12  Cerean Union's freighter Tug destroyed in transit, Io → Europa by Zed Corp"],
  ["ship_destroyed in transit deep", "ship_destroyed", "f1", null, 12, {"ship_name": "Tug", "in_transit": true},
    "T+12  Cerean Union's ship Tug destroyed in transit, deep space"],
  ["ship_destroyed bare", "ship_destroyed", null, null, 12, {},
    "T+12  Unknown's ship Unknown destroyed at space"],
  ["captain_lost", "captain_lost", "f1", null, 12, {"captain_name": "Ace", "captain_rank": 3, "ship_name": "Tug", "body_name": "Titan"},
    "T+12  Captain Ace of the Tug went down with the ship at Titan. 3 kills."],
  ["captain_lost transit", "captain_lost", "f1", null, 12, {"captain_name": "Ace", "in_transit": true, "dest_body_name": "Mars", "body_name": "Titan"},
    "T+12  Captain Ace went down with the ship in transit, Titan → Mars."],
  ["captain_lost transit deep", "captain_lost", "f1", null, 12, {"captain_name": "Ace", "in_transit": true},
    "T+12  Captain Ace went down with the ship in deep space."],
  ["captain_lost bare", "captain_lost", "f1", null, 12, {},
    "T+12  Captain The captain went down with the ship at deep space."],
  ["captain_rescued", "captain_rescued", "f1", null, 12, {"captain_name": "Ace", "captain_rank": 1, "ship_name": "Tug", "body_name": "Titan"},
    "T+12  Captain Ace was recovered from the wreck at Titan and awaits reassignment. 1 kills."],
  ["ship_damaged many", "ship_damaged", "f2", null, 12, {"count": 4, "total_damage": 120, "body_name": "Mars"},
    "T+12  Zed Corp: 4 ships take fire at Mars (120 damage)"],
  ["ship_damaged one with hp", "ship_damaged", "f1", null, 12, {"count": 1, "body_name": "Mars", "ships": [{"ship_name": "Tug", "damage": 40, "hp_after": 60, "hp_max": 100}]},
    "T+12  Cerean Union's Tug takes 40 damage at Mars · 60/100 HP"],
  ["ship_damaged one no hp", "ship_damaged", "f1", null, 12, {"total_damage": 15, "in_transit": true, "dest_body_name": "Venus", "body_name": "Earth"},
    "T+12  Cerean Union's A ship takes 15 damage in transit, Earth → Venus"],
  ["ship_damaged bare", "ship_damaged", null, null, 12, {},
    "T+12  Unknown's A ship takes undefined damage at deep space"],
  ["settlement_destroyed capital", "settlement_destroyed", "f1", null, 12, {"is_capital": true, "body_name": "Earth", "killer_faction_id": "f2", "killer_faction_name": "Zed Corp", "wrecked": true},
    "T+12  ⚠ Cerean Union's CAPITAL on Earth has fallen by Zed Corp — left in ruins"],
  ["settlement_destroyed named city", "settlement_destroyed", "f1", null, 12, {"settlement_name": "Cerean Union Capital", "settlement_type": "city", "body_name": "Oberon", "killer_faction_id": "f2"},
    "T+12  Cerean Union Capital (city) on Oberon destroyed by Zed Corp"],
  ["settlement_destroyed named station ruins", "settlement_destroyed", "f1", null, 12, {"settlement_name": "Alpha Base", "settlement_type": "station", "body_name": "Luna", "wrecked": true},
    "T+12  Cerean Union's Alpha Base (station) on Luna destroyed — left in ruins"],
  ["settlement_destroyed unnamed", "settlement_destroyed", "f1", null, 12, {},
    "T+12  Cerean Union's settlement on unknown body destroyed"],
  ["settlement_seized new", "settlement_seized", "f2", null, 12, {"body_name": "Luna", "settlement_type": "station"},
    "T+12  ▲ Zed Corp seized the ruins of a station on Luna — every building a level down"],
  ["settlement_seized retaken", "settlement_seized", "f2", null, 12, {"retaken": true},
    "T+12  ▲ Zed Corp retook the ruins of its settlement on a world — every building a level down"],
  ["settlement_razed", "settlement_razed", "f2", null, 12, {"body_name": "Luna"},
    "T+12  ✕ Zed Corp razed the ruins on Luna"],
  ["ship_detonated", "ship_detonated", "f1", null, 12, {"ship_name": "Boomer", "body_name": "Mars", "damage": 80, "destroyed_count": 3},
    "T+12  💥 Cerean Union's Boomer detonated at Mars — 80 damage to every ship in orbit, 3 destroyed"],
  ["ship_detonated bare", "ship_detonated", "f1", null, 12, {},
    "T+12  💥 Cerean Union's a ship detonated at orbit — 0 damage to every ship in orbit, 0 destroyed"],
  ["builds_destroyed 1", "builds_destroyed", "f1", null, 12, {"body_name": "Mars", "builds_lost": 1},
    "T+12  🏭 Cerean Union's shipyard at Mars fell — 1 ship under construction destroyed"],
  ["builds_destroyed 4", "builds_destroyed", "f1", null, 12, {"body_name": "Mars", "builds_lost": 4},
    "T+12  🏭 Cerean Union's shipyard at Mars fell — 4 ships under construction destroyed"],
  ["builds_destroyed none", "builds_destroyed", "f1", null, 12, {},
    "T+12  🏭 Cerean Union's shipyard at a body fell — 0 ships under construction destroyed"],
  ["ship_retreated chosen", "ship_retreated", "f1", null, 12, {"ship_name": "Tug", "from_body_name": "Mars", "to_body_name": "Earth", "hp": 20.4, "hp_max": 100, "destination": "chosen"},
    "T+12  🏳 Cerean Union's Tug broke off from Mars (20/100 hp) — retreating to Earth, its chosen port for repairs"],
  ["ship_retreated home", "ship_retreated", "f1", null, 12, {"ship_name": "Cerean Union Flagship", "from_body_name": "Mars", "to_body_name": "Earth", "destination": "home"},
    "T+12  🏳 Cerean Union Flagship broke off from Mars — retreating home to Earth for repairs"],
  ["ship_retreated nearest", "ship_retreated", "f1", null, 12, {"ship_name": "Tug"},
    "T+12  🏳 Cerean Union's Tug broke off from the line — retreating to a friendly shipyard for repairs"],
  ["ship_retreated no repairs chosen", "ship_retreated", "f1", null, 12, {"ship_name": "Tug", "repairs": false, "destination": "chosen", "to_body_name": "Luna"},
    "T+12  🏳 Cerean Union's Tug broke off from the line — falling back to Luna, its chosen port — no shipyard there, so no repairs"],
  ["ship_retreated no repairs home", "ship_retreated", "f1", null, 12, {"ship_name": "Tug", "repairs": false, "destination": "home", "to_body_name": "Luna"},
    "T+12  🏳 Cerean Union's Tug broke off from the line — falling back home to Luna — no shipyard there, so no repairs"],
  ["ship_retreated no repairs nearest", "ship_retreated", "f1", null, 12, {"ship_name": "Tug", "repairs": false, "to_body_name": "Luna", "hp": 5, "hp_max": 50},
    "T+12  🏳 Cerean Union's Tug broke off from the line (5/50 hp) — falling back to Luna — no shipyard there, so no repairs"],
  ["asteroid_launched", "asteroid_launched", "f1", null, 12, {"asteroid_name": "Rock 7", "target_name": "Venus", "ticks_to_impact": 9},
    "T+12  ⚠ Cerean Union diverts Rock 7 toward Venus — impact in T-9 ticks"],
  ["asteroid_launched bare", "asteroid_launched", null, null, 12, {},
    "T+12  ⚠ Unknown diverts an asteroid toward a planet — impact in T-0 ticks"],
  ["asteroid_impact 1", "asteroid_impact", "f1", null, 12, {"asteroid_name": "Rock 7", "target_name": "Venus", "settlements_destroyed": 1},
    "T+12  💥 IMPACT — Rock 7 struck Venus, 1 settlement destroyed (Cerean Union)"],
  ["asteroid_impact 3 anon", "asteroid_impact", null, null, 12, {"settlements_destroyed": 3},
    "T+12  💥 IMPACT — asteroid struck a body, 3 settlements destroyed"],
  ["asteroid_impact sol", "asteroid_impact", "f1", null, 12, {"asteroid_name": "Rock 7", "sol_special": true},
    "T+12  Rock 7 evaporated into Sol (no effect) — launched by Cerean Union"],
  ["settlement_built named", "settlement_built", "f1", null, 12, {"settlement_type": "city", "settlement_name": "Alpha", "body_name": "Mars"},
    "T+12  Cerean Union founded city Alpha on Mars"],
  ["settlement_built unnamed", "settlement_built", "f1", null, 12, {"settlement_type": "station", "body_name": "Mars"},
    "T+12  Cerean Union founded station on Mars"],
  ["ship_built named", "ship_built", "f1", null, 12, {"ship_class": "corvette", "ship_name": "Corvette T3-1", "body_name": "Mars"},
    "T+12  Cerean Union's yard at Mars launched a corvette Corvette T3-1"],
  ["ship_built unnamed", "ship_built", "f1", null, 12, {"ship_class": "frigate", "body_name": "Mars"},
    "T+12  Cerean Union's yard at Mars launched a frigate"],
  ["dyson_initiated", "dyson_initiated", "f1", null, 12, {},
    "T+12  ☀ Cerean Union laid the foundation of a DYSON SPHERE at Sol — the engineering victory clock is running"],
  ["dyson_milestone", "dyson_milestone", "f1", null, 12, {"pct": 50},
    "T+12  ☀ Cerean Union's Dyson Sphere reached 50% completion"],
  ["dyson_damaged", "dyson_damaged", "f1", null, 12, {"damage": 300, "pct": 41},
    "T+12  💥 The Dyson Sphere took fire at Sol — 300 construction destroyed, Cerean Union's great work holds at 41%"],
  ["dyson_collapsed foundation", "dyson_collapsed", "f1", null, 12, {"reason": "foundation destroyed", "progress_lost": 900},
    "T+12  💥 THE DYSON SPHERE HAS FALLEN — its foundation station was destroyed; 900 units of Cerean Union's progress erased. The Sol slot stands open."],
  ["dyson_collapsed bombardment", "dyson_collapsed", "f1", null, 12, {"progress_lost": 900},
    "T+12  💥 THE DYSON SPHERE HAS FALLEN — sustained bombardment broke the lattice; 900 units of Cerean Union's progress erased. The Sol slot stands open."],
  ["terraform_begun", "terraform_begun", "f1", null, 12, {"body_name": "Mars", "duration": 24},
    "T+12  ◌ Cerean Union's terraforming payload landed on Mars — transformation completes in 24 ticks"],
  ["terraform_begun bare", "terraform_begun", "f1", null, 12, {},
    "T+12  ◌ Cerean Union's terraforming payload landed on a world — transformation completes in 24 ticks"],
  ["terraform_complete", "terraform_complete", "f1", null, 12, {"body_name": "Mars"},
    "T+12  🌍 MARS LIVES — Cerean Union's terraforming is complete. Full yield, city rights, trade dock — permanently."],
  ["kaiju_omen", "kaiju_omen", null, null, 12, {"system": "Cygnus", "launch_in": 6},
    "T+12  ✶ Something is stirring at Cygnus — something enormous, turning toward the Sun. It moves in 6 ticks"],
  ["kaiju_omen bare", "kaiju_omen", null, null, 12, {},
    "T+12  ✶ Something is stirring at a far star — something enormous, turning toward the Sun. It moves in 6 ticks"],
  ["kaiju_launched near", "kaiju_launched", null, null, 12, {"system": "Cygnus", "near": "Pluto", "arrive_tick": 160},
    "T+12  ✶ SOMETHING HAS LEFT CYGNUS — an object on a burn no engine could make, heading for the Sun. It stops in the Far Reach out past Pluto at T+160. It does not answer hails"],
  ["kaiju_launched no near", "kaiju_launched", null, null, 12, {"system": "Cygnus", "arrive_tick": 160},
    "T+12  ✶ SOMETHING HAS LEFT CYGNUS — an object on a burn no engine could make, heading for the Sun. It stops in the Far Reach at T+160. It does not answer hails"],
  ["kaiju_hunting first rest", "kaiju_hunting", null, null, 12, {"first": true, "carried": false, "gate": "Sun Gate", "world": "Mars", "arrive_tick": 170},
    "T+12  ✶ THE OBJECT HAS ARRIVED — it came to rest beside the Sun Gate. It is moving again, toward Mars (there at T+170)"],
  ["kaiju_hunting first open", "kaiju_hunting", null, null, 12, {"first": true, "gate": "Sun Gate", "world": "Mars", "arrive_tick": 170},
    "T+12  ✶ THE OBJECT HAS ARRIVED — where it stopped, the Sun Gate has opened. It is moving again, toward Mars (there at T+170)"],
  ["kaiju_hunting later", "kaiju_hunting", null, null, 12, {"world": "Venus", "arrive_tick": 180},
    "T+12  🦑 The Leviathan is coming for Venus — there at T+180"],
  ["kaiju_revealed", "kaiju_revealed", null, null, 12, {"system": "Cygnus", "world": "Mars", "fires_at_tick": 175, "hp": 1234567},
    "T+12  🦑 IT IS ALIVE — the thing from Cygnus is a creature the size of a moon: the LEVIATHAN. It is winding up over Mars to strike at T+175, with 1,234,567 HP. Every empire is at war with it"],
  ["kaiju_revealed bare", "kaiju_revealed", null, null, 12, {},
    "T+12  🦑 IT IS ALIVE — the thing from the far star is a creature the size of a moon: the LEVIATHAN. It is winding up over a world to strike at T+NaN, with 0 HP. Every empire is at war with it"],
  ["kaiju_charging break", "kaiju_charging", null, null, 12, {"world": "Mars", "fires_at_tick": 175},
    "T+12  🦑 The Leviathan is winding up over Mars — it strikes at T+175, breaking it apart. Kill it first"],
  ["kaiju_charging scorch", "kaiju_charging", null, null, 12, {"world": "Mars", "fires_at_tick": 175, "mode": "sterilise", "raw": true},
    "T+12  🦑 The Leviathan is winding up over Mars — it strikes at T+175, scorching every settlement off it. Kill it first"],
  ["kaiju_charging strip", "kaiju_charging", null, null, 12, {"world": "Mars", "fires_at_tick": 175, "mode": "sterilise"},
    "T+12  🦑 The Leviathan is winding up over Mars — it strikes at T+175, stripping its biosphere. Kill it first"],
  ["terraform_destroyed kaiju scorched", "terraform_destroyed", null, null, 12, {"cause": "kaiju", "body_name": "Mars", "raw": true, "settlements_lost": 2},
    "T+12  🦑 MARS SCORCHED — the Leviathan burned its surface bare with 2 settlements, and is winding up again"],
  ["terraform_destroyed kaiju stripped", "terraform_destroyed", null, null, 12, {"cause": "kaiju", "world": "Mars"},
    "T+12  🦑 MARS STRIPPED — the Leviathan burned its biosphere away, and is winding up again"],
  ["terraform_destroyed kaiju stripped 1", "terraform_destroyed", null, null, 12, {"cause": "kaiju", "world": "Mars", "settlements_lost": 1},
    "T+12  🦑 MARS STRIPPED — the Leviathan burned its biosphere away with 1 settlement, and is winding up again"],
  ["world_obliterated kaiju", "world_obliterated", null, null, 12, {"cause": "kaiju", "body_name": "Mars", "settlements_lost": 1},
    "T+12  🦑 MARS IS GONE — the Leviathan broke it apart, with 1 settlement. A debris field orbits where it stood"],
  ["world_obliterated kaiju none", "world_obliterated", null, null, 12, {"cause": "kaiju", "body_name": "Mars"},
    "T+12  🦑 MARS IS GONE — the Leviathan broke it apart. A debris field orbits where it stood"],
  ["kaiju_leaving full eaten", "kaiju_leaving", null, null, 12, {"why": "full", "eaten": ["Mars", "Venus"], "gate": "Sun Gate"},
    "T+12  🦑 The Leviathan has eaten its fill (Mars, Venus) — it is heading back to the Sun Gate"],
  ["kaiju_leaving none", "kaiju_leaving", null, null, 12, {},
    "T+12  🦑 The Leviathan has nothing left it will eat — it is heading back to the gate"],
  ["kaiju_gone", "kaiju_gone", null, null, 12, {"gate": "Sun Gate"},
    "T+12  🦑 The Leviathan went back through the Sun Gate. Nobody knows if it will return"],
  ["kaiju_gone bare", "kaiju_gone", null, null, 12, {},
    "T+12  🦑 The Leviathan went back through the gate. Nobody knows if it will return"],
  ["kaiju_dead killer ship", "kaiju_dead", null, null, 12, {"world": "Mars", "killer_faction_name": "Zed Corp", "killer_ship_name": "HMS Grudge", "tons": 54321},
    "T+12  🦑 THE LEVIATHAN IS DEAD — it fell at Mars; Zed Corp, aboard the HMS Grudge, landed the killing blow. Its carcass is 54,321 t of metal for any mining rig"],
  ["kaiju_dead killer", "kaiju_dead", null, null, 12, {"world": "Mars", "killer_faction_name": "Zed Corp", "tons": 100},
    "T+12  🦑 THE LEVIATHAN IS DEAD — it fell at Mars; Zed Corp landed the killing blow. Its carcass is 100 t of metal for any mining rig"],
  ["kaiju_dead bare", "kaiju_dead", null, null, 12, {},
    "T+12  🦑 THE LEVIATHAN IS DEAD — it fell at deep space. Its carcass is 0 t of metal for any mining rig"],
  ["terraform_destroyed mega", "terraform_destroyed", "f1", null, 12, {"cause": "mega_destroyer", "body_name": "Mars"},
    "T+12  ✹ MARS IS DEAD — Cerean Union's Mega Destroyer burned its biosphere away from orbit. Another strike would leave nothing of it at all."],
  ["world_obliterated mega", "world_obliterated", "f1", null, 12, {"body_name": "Mars"},
    "T+12  ✹ MARS IS GONE — Cerean Union's Mega Destroyer broke it apart. A debris field orbits where it stood; it no longer counts as a world."],
  ["terraform_destroyed asteroid", "terraform_destroyed", "f1", null, 12, {"body_name": "Mars", "asteroid_name": "Rock 7"},
    "T+12  ☄ MARS IS DEAD — Cerean Union drove Rock 7 into a living world; its biosphere is gone"],
  ["mega_strike_charging full", "mega_strike_charging", "f1", "f2", 12, {"world": "Mars", "ship": "Doom 1", "fires_at_tick": 40, "mode": "obliterate"},
    "T+12  ✹ MARS IS BEING AIMED AT — Cerean Union's Doom 1 is charging on Zed Corp's world; it fires on tick 40, and this shot destroys the world"],
  ["mega_strike_charging bare", "mega_strike_charging", "f1", null, 12, {},
    "T+12  ✹ A LIVING WORLD IS BEING AIMED AT — Cerean Union's a Mega Destroyer is charging on it"],
  ["mega_strike_aborted moved", "mega_strike_aborted", "f1", null, 12, {"world": "Mars", "reason": "moved"},
    "T+12  ○ Cerean Union's strike on MARS is off — the hull broke off the charge"],
  ["mega_strike_aborted stood down", "mega_strike_aborted", "f1", null, 12, {"world": "Mars"},
    "T+12  ○ Cerean Union's strike on MARS is off — they stood down"],
  ["megastructure_abandoned", "megastructure_abandoned", "f1", null, 12, {"structure": "Warp Gate Site"},
    "T+12  ⌾ WARP GATE SITE GOES DARK — Cerean Union is gone, and their structure stands unclaimed. The first hull to reach it takes it."],
  ["megastructure_claimed", "megastructure_claimed", "f2", null, 12, {"structure": "Warp Gate Site"},
    "T+12  ⬢ Zed Corp claimed the derelict WARP GATE SITE — salvage, not conquest: nobody was left to stop them."],
  ["megastructure_captured op toll", "megastructure_captured", "f2", "f1", 12, {"structure": "Warp Gate Site", "was_complete": true, "lost_metal": 120.4},
    "T+12  ⬢ WARP GATE SITE TAKEN — Zed Corp boarded Cerean Union's operational structure — 120 metal of work was wrecked in the boarding"],
  ["megastructure_captured site", "megastructure_captured", "f2", "f1", 12, {"structure": "Gravity Sink Site"},
    "T+12  ⬢ GRAVITY SINK SITE TAKEN — Zed Corp boarded Cerean Union's construction site"],
  ["megastructure_captured nobody", "megastructure_captured", "f2", null, 12, {},
    "T+12  ⬢ A STRUCTURE TAKEN — Zed Corp boarded nobody's construction site"],
  ["megastructure_destroyed denied", "megastructure_destroyed", "f2", "f1", 12, {"structure": "Warp Gate Site", "denied_metal": 300},
    "T+12  ✖ WARP GATE SITE RAZED — Zed Corp destroyed Cerean Union's structure rather than take it; 300 metal denied to everyone"],
  ["megastructure_destroyed", "megastructure_destroyed", "f2", "f1", 12, {"structure": "Warp Gate Site"},
    "T+12  ✖ WARP GATE SITE RAZED — Zed Corp destroyed Cerean Union's structure rather than take it"],
  ["ship_rush_botched", "ship_rush_botched", "f1", null, 12, {"ship_class": "destroyer", "ship_name": "Destroyer T3-2", "body_name": "Mars", "rush_count": 2},
    "T+12  ⚠ Cerean Union rushed the destroyer Destroyer T3-2 at Mars (rush ×2) — corners were cut; it will launch at HALF hull"],
  ["ship_rush_botched unnamed", "ship_rush_botched", "f1", null, 12, {"ship_class": "frigate"},
    "T+12  ⚠ Cerean Union rushed the frigate at a yard — corners were cut; it will launch at HALF hull"],
  ["fleet_arrears entered", "fleet_arrears", "f1", null, 12, {"entered": true},
    "T+12  💸 Cerean Union's treasury ran dry — fleet upkeep unpaid, ships fight at −25% damage"],
  ["fleet_arrears cleared", "fleet_arrears", "f1", null, 12, {},
    "T+12  💰 Cerean Union cleared its fleet-upkeep debt — full combat effectiveness restored"],
  ["building_completed", "building_completed", "f1", null, 12, {"building_kind": "mint", "new_level": 3, "settlement_name": "Cerean Union Capital", "body_name": "Earth"},
    "T+12  Cerean Union Capital on Earth completed mint L3"],
  ["building_completed bare", "building_completed", "f1", null, 12, {},
    "T+12  Cerean Union's settlement on a body completed building L1"],
  ["sun_gate_omen first", "sun_gate_omen", null, null, 12, {"gate_in": 12},
    "T+12  ☀ Something strange is emerging from the Sun — it will be out in 12 ticks"],
  ["sun_gate_omen again", "sun_gate_omen", null, null, 12, {"index": 1},
    "T+12  ☀ Something else is emerging from the Sun — it will be out in 6 ticks"],
  ["sun_gate_emerged full", "sun_gate_emerged", null, null, 12, {"system": "Cygnus", "near": "Pluto", "arrive_tick": 200},
    "T+12  ◎ A gate to Cygnus has come out of the Sun, burning for the Far Reach — it stops out past Pluto at T+200; its landing site is marked on the map"],
  ["sun_gate_emerged near only", "sun_gate_emerged", null, null, 12, {"system": "Cygnus", "near": "Pluto"},
    "T+12  ◎ A gate to Cygnus has come out of the Sun, burning for the Far Reach — it stops out past Pluto; its landing site is marked on the map"],
  ["sun_gate_emerged at only", "sun_gate_emerged", null, null, 12, {"system": "Cygnus", "arrive_tick": 200},
    "T+12  ◎ A gate to Cygnus has come out of the Sun, burning for the Far Reach at T+200; its landing site is marked on the map"],
  ["sun_gate_emerged bare", "sun_gate_emerged", null, null, 12, {},
    "T+12  ◎ A gate to another star has come out of the Sun, burning for the Far Reach; its landing site is marked on the map"],
  ["gate_transit first", "gate_transit", "f1", null, 12, {"first": true, "ship": "Tug", "from": "Sun Gate", "to": "Beta"},
    "T+12  ◎ Cerean Union was FIRST through the Sun Gate: the Tug is crossing to Beta"],
  ["gate_transit sun gate", "gate_transit", "f1", null, 12, {"sun_gate": true, "to_system": "Cygnus", "ship": "Cerean Union Tug", "from": "Sun Gate"},
    "T+12  ◎ Cerean Union Tug went through the Sun Gate, crossing to Cygnus"],
  ["gate_transit bare", "gate_transit", null, null, 12, {},
    "T+12  ◎ Unknown's a hull went through the a gate, crossing to the far side"],
  ["sun_gate_opened", "sun_gate_opened", null, null, 12, {"gate": "Sun Gate", "system": "Cygnus"},
    "T+12  ◎ The Sun Gate is open — park on it to launch to Cygnus at a tenth of the burn"],
  ["sun_gate_opened bare", "sun_gate_opened", null, null, 12, {},
    "T+12  ◎ The The gate is open — park on it to launch to another star at a tenth of the burn"],
  ["secret_discovered", "secret_discovered", "f1", null, 12, {"kind": "derelict_warship", "body_name": "Ceres", "message": "Ceres: DISCOVERY — a derelict destroyer is salvageable. Claimed."},
    "T+12  🔍 Cerean Union: Ceres: DISCOVERY — a derelict destroyer is salvageable. Claimed."],
  ["secret_discovered no message", "secret_discovered", "f1", null, 12, {"kind": "warp_gate", "body_name": "Ceres"},
    "T+12  🔍 Cerean Union: warp_gate at Ceres"],
  ["secret_discovered bare", "secret_discovered", null, null, 12, {},
    "T+12  🔍 Unknown: something at a body"],
  ["victory detail", "victory", "f1", null, 12, {"victoryType": "engineering", "detail": "Dyson Sphere complete"},
    "T+12  👑 GAME OVER — Cerean Union wins: Dyson Sphere complete"],
  ["victory domination", "victory", "f2", null, 12, {"victoryType": "domination", "detail": "Controls 7 of 10 worlds (70%)"},
    "T+12  👑 GAME OVER — Zed Corp wins: Controls 7 of 10 worlds (70%)"],
  ["victory none", "victory", null, null, 12, {},
    "T+12  👑 GAME OVER — Unknown wins"],
  ["trade_accepted pacts", "trade_accepted", "f1", "f2", 12, {"offer": {"metal": 100.4, "gold": 20}, "request": {"science": 5, "fuel": 3}, "pacts": ["nap", "intel_share"]},
    "T+12  ⚖ Cerean Union traded 100 metal, 20 credits → Zed Corp for 3 fuel, 5 science + Non-Aggression Pact, Intel-Share Pact"],
  ["trade_accepted plain", "trade_accepted", "f1", "f2", 12, {"offer": {}, "request": null},
    "T+12  ⚖ Cerean Union traded nothing → Zed Corp for nothing"],
  ["meteoroid_found tons", "meteoroid_found", "f1", null, 12, {"name": "Rock 9", "tons": 400, "kind": "gold"},
    "T+12  ◈ Survey found Rock 9 — 400 credits"],
  ["meteoroid_found metal", "meteoroid_found", "f1", null, 12, {"name": "Rock 9", "tons": 400},
    "T+12  ◈ Survey found Rock 9 — 400 metal"],
  ["meteoroid_found bare", "meteoroid_found", "f1", null, 12, {},
    "T+12  ◈ Survey found a meteoroid"],
  ["meteoroid_exhausted", "meteoroid_exhausted", "f1", null, 12, {"name": "Rock 9"},
    "T+12  ◇ Rock 9 is worked out"],
  ["meteoroid_exhausted bare", "meteoroid_exhausted", "f1", null, 12, {},
    "T+12  ◇ A meteoroid is worked out"],
  ["ship_refitted fee", "ship_refitted", "f1", null, 12, {"ship_name": "Tug", "design_name": "Hauler Mk2", "body_name": "Earth", "fee_metal": 50.4, "fee_gold": 10},
    "T+12  ⟳ Tug refitted to Hauler Mk2 at Earth (50M 10C)"],
  ["ship_refitted bare", "ship_refitted", "f1", null, 12, {},
    "T+12  ⟳ A ship refitted to its new design at a friendly world"],
  ["treaty_signed nap", "treaty_signed", "f1", "f2", 12, {"kind": "nap"},
    "T+12  🕊 Cerean Union & Zed Corp signed Non-Aggression Pact"],
  ["treaty_signed defense", "treaty_signed", "f1", "f2", 12, {"kind": "defense_pact"},
    "T+12  🕊 Cerean Union & Zed Corp signed Defense Pact"],
  ["treaty_signed bare", "treaty_signed", "f1", "f2", 12, {},
    "T+12  🕊 Cerean Union & Zed Corp signed pact"],
  ["treaty_broken intel", "treaty_broken", "f1", "f2", 12, {"kind": "intel_share"},
    "T+12  ⚔ Cerean Union broke the Intel-Share Pact with Zed Corp — war resumes"],
  ["senate_vote passed tally", "senate_vote", null, null, 12, {"title": "Embargo Zed", "outcome": "passed", "bill_kind": "trade_embargo", "yea_weight": 5, "nay_weight": 2, "abstain_weight": 1},
    "T+12  ⚖ Senate: “Embargo Zed” [trade embargo] PASSED — 5 yea / 2 nay / 1 abstain"],
  ["senate_vote failed", "senate_vote", null, null, 12, {"title": "Tax", "outcome": "failed", "bill_kind": "slider_law", "yea_weight": 1, "nay_weight": 4},
    "T+12  ⚖ Senate: “Tax” [slider law] FAILED — 1 yea / 4 nay"],
  ["senate_vote other", "senate_vote", null, null, 12, {"outcome": "tied"},
    "T+12  ⚖ Senate: “a motion” TIED"],
  ["senate_vote bare", "senate_vote", null, null, 12, {},
    "T+12  ⚖ Senate: “a motion” RESOLVED"],
  ["senate_law_expired held", "senate_law_expired", null, null, 12, {"title": "Embargo Zed", "bill_kind": "trade_embargo", "ticks_in_force": 14},
    "T+12  ⌛ Senate: “Embargo Zed” [trade embargo] LAPSED — stood 14 ticks"],
  ["senate_law_expired bare", "senate_law_expired", null, null, 12, {},
    "T+12  ⌛ Senate: “a law” LAPSED"],
  ["senate_reaped", "senate_reaped", "f2", null, 12, {"title": "Tax"},
    "T+12  ⚖ Senate: “Tax” by Zed Corp expired unvoted — never reached the floor"],
  ["senate_term", "senate_term", "f1", null, 12, {"term_index": 2, "start_tick": 100, "end_tick": 148},
    "T+12  🔨 Senate: Cerean Union takes the chair for term 3 — holds the floor 48 ticks, until T+148"],
  ["tech_advanced level", "tech_advanced", "f1", null, 12, {"tech_id": "weapons", "level": 3},
    "T+12  Cerean Union completed weapons L3"],
  ["tech_advanced bare", "tech_advanced", "f1", null, 12, {},
    "T+12  Cerean Union completed research"],
  ["trade_route_run tariff", "trade_route_run", null, null, 12, {"delivered": {"metal": 100.4, "gold": 20}, "sender_faction_id": "f1", "recipient_faction_id": "f2", "loop": 7, "tariff_pct": 10},
    "T+12  ⟳ Trade route: Cerean Union → Zed Corp delivered 100M 20C (−10% tariff) — run #7"],
  ["trade_route_run nothing", "trade_route_run", null, null, 12, {"sender_faction_id": "f1", "recipient_faction_id": "f2", "loop": 1},
    "T+12  ⟳ Trade route: Cerean Union → Zed Corp delivered nothing — run #1"],
  ["trade_route_done", "trade_route_done", null, null, 12, {"sender_faction_id": "f1", "recipient_faction_id": "f2", "loops": 12},
    "T+12  ⏹ Trade route Cerean Union → Zed Corp finished its last run — 12 delivered in all"],
  ["trade_route_done bare", "trade_route_done", null, null, 12, {},
    "T+12  ⏹ Trade route Unknown → Unknown finished its last run"],
  ["trade_lane_consolidated 2", "trade_lane_consolidated", null, null, 12, {"ships": ["a", "b"]},
    "T+12  ⇄ Standing trade folded onto one lane — 2 freighters now collect and deliver at both ends"],
  ["trade_lane_consolidated 1", "trade_lane_consolidated", null, null, 12, {"ships": ["a"]},
    "T+12  ⇄ Standing trade folded onto one lane — 1 freighter now collect and deliver at both ends"],
  ["trade_lane_consolidated none", "trade_lane_consolidated", null, null, 12, {},
    "T+12  ⇄ Standing trade folded onto one lane"],
  ["trade_agreement_ended starved", "trade_agreement_ended", "f1", null, 12, {"reason": "starved", "reason_text": "ended — a shipment could not be covered", "faction_a_id": "f1", "faction_b_id": "f2", "faction_a_name": "Cerean Union", "faction_b_name": "Zed Corp"},
    "T+12  ⏹ Standing trade between Cerean Union and Zed Corp ended — a shipment could not be covered"],
  ["trade_agreement_ended cancelled", "trade_agreement_ended", "f1", null, 12, {"reason": "cancelled", "reason_text": "called off", "faction_a_id": "f1", "faction_b_id": "f2"},
    "T+12  ⏹ Standing trade between Cerean Union and Zed Corp called off"],
  ["trade_agreement_ended bare", "trade_agreement_ended", "f1", null, 12, {},
    "T+12  ⏹ Standing trade between Unknown and Unknown ended"],
  ["trade_delivered", "trade_delivered", null, null, 12, {"recipient_faction_id": "f2", "metal": 100.6, "science": 4},
    "T+12  Trade delivered to Zed Corp: 101M 4S"],
  ["trade_delivered empty", "trade_delivered", null, null, 12, {"recipient_faction_id": "f2"},
    "T+12  Trade delivered to Zed Corp: an empty hold"],
  ["trade_shipment_lost killer", "trade_shipment_lost", null, null, 12, {"sender_faction_id": "f1", "recipient_faction_id": "f2", "gold": 20, "killer_faction_id": "f3"},
    "T+12  📦 Shipment lost: Cerean Union → Zed Corp (20C) — intercepted by Unknown"],
  ["trade_shipment_lost", "trade_shipment_lost", null, null, 12, {"sender_faction_id": "f1", "recipient_faction_id": "f2"},
    "T+12  📦 Shipment lost: Cerean Union → Zed Corp (its cargo)"],
  ["unformatted kind", "senate_passed", null, null, 12, {},
    "T+12  senate_passed"],
  ["bad json", "ship_destroyed", "f1", null, 12, "not json",
    "T+12  Cerean Union's ship Unknown destroyed at space"],
];

const ev = (r: Row) => ({
  tick_number: r[4], kind: r[1], actor_faction_id: r[2], target_faction_id: r[3],
  payload: typeof r[5] === 'string' ? r[5] : JSON.stringify(r[5]),
});

/** Every kind the provider's formatter knows (plus one it does not). */
const KINDS = [
  'game_started', 'faction_eliminated', 'faction_revived', 'faction_joined', 'ship_destroyed', 'captain_lost',
  'captain_rescued', 'ship_damaged', 'settlement_destroyed', 'settlement_seized', 'settlement_razed',
  'ship_detonated', 'builds_destroyed', 'ship_retreated', 'asteroid_launched', 'asteroid_impact',
  'settlement_built', 'ship_built', 'dyson_initiated', 'dyson_milestone', 'dyson_damaged', 'dyson_collapsed',
  'terraform_begun', 'terraform_complete', 'kaiju_omen', 'kaiju_launched', 'kaiju_hunting', 'kaiju_revealed',
  'kaiju_charging', 'terraform_destroyed', 'world_obliterated', 'kaiju_leaving', 'kaiju_gone', 'kaiju_dead',
  'mega_strike_charging', 'mega_strike_aborted', 'megastructure_abandoned', 'megastructure_claimed',
  'megastructure_captured', 'megastructure_destroyed', 'ship_rush_botched', 'fleet_arrears',
  'building_completed', 'sun_gate_omen', 'sun_gate_emerged', 'gate_transit', 'sun_gate_opened',
  'secret_discovered', 'victory', 'trade_accepted', 'meteoroid_found', 'meteoroid_exhausted', 'ship_refitted',
  'treaty_signed', 'treaty_broken', 'senate_vote', 'senate_law_expired', 'senate_reaped', 'senate_term',
  'tech_advanced', 'trade_route_run', 'trade_route_done', 'trade_lane_consolidated', 'trade_agreement_ended',
  'trade_delivered', 'trade_shipment_lost',
];

afterEach(() => setLang('en', false));

describe('English headlines (the machine-truth contract)', () => {
  it('has a sample for every kind', () => {
    const have = new Set(ROWS.map(r => r[1]));
    expect(KINDS.filter(k => !have.has(k))).toEqual([]);
  });

  it.each(ROWS.map(r => [r[0], r] as const))('%s', (_label: string, r: Row) => {
    expect(formatChronicleEvent(ev(r), ctx, 'en')).toBe(r[6]);
  });

  it('does not depend on the language on screen', () => {
    setLang('pt-BR', false);
    for (const r of ROWS) expect(formatChronicleEvent(ev(r), ctx, 'en')).toBe(r[6]);
  });
});

// Words of the English templates. A Portuguese headline must contain none of
// them: names (factions, ships, worlds) are data and stay as given, and the
// samples use names without these words.
// (\p{L} lookarounds, not \b: "até" and "sóis" would trip \bat\b and \bis\b.)
const ENGLISH_TEMPLATE_WORD = /(?<![\p{L}\p{N}])(the|has|was|were|of|at|on|by|is|are|to|and|from|with|its|it|for|into|your|you|their|them|this|went|took|lost|first|won)(?![\p{L}\p{N}])/u;

describe('Portuguese headlines', () => {
  it('leave no English template words in any sample', () => {
    const leaks: string[] = [];
    for (const r of ROWS) {
      const pt = formatChronicleEvent(ev(r), ctx, 'pt-BR');
      // the raw-kind fallback for a kind with no formatter is not a template
      if (r[1] === 'senate_passed') continue;
      const body = pt.replace(/^T\+\d+\s+/, '');
      if (ENGLISH_TEMPLATE_WORD.test(body)) leaks.push(`${r[0]}: ${pt}`);
    }
    expect(leaks).toEqual([]);
  });

  it('keeps the T+n prefix and the glyph, and names exactly as given', () => {
    const r = ROWS.find(x => x[0] === 'ship_destroyed killer ship')!;
    const pt = formatChronicleEvent(ev(r), ctx, 'pt-BR');
    expect(pt).toBe('T+12  Destruição de Cargueiro Tug de Cerean Union em Io por HMS Grudge (Zed Corp)');
    expect(formatChronicleEvent(ev(ROWS.find(x => x[0] === 'game_started 3 named')!), ctx, 'pt-BR'))
      .toBe('T+0  🚀 O jogo começa — 3 facções: Cerean Union, Zed Corp, Orion');
  });

  it('renders a handful of kinds in full', () => {
    const f = (label: string) => formatChronicleEvent(ev(ROWS.find(x => x[0] === label)!), ctx, 'pt-BR');
    expect(f('faction_eliminated')).toBe('T+32  ☠ Cerean Union perdeu seu último assentamento e está fora da guerra');
    expect(f('captain_lost')).toBe('T+12  O capitão Ace, da nave Tug, morreu com a nave em Titan. 3 abates.');
    expect(f('settlement_destroyed capital')).toBe('T+12  ⚠ A CAPITAL de Cerean Union em Earth caiu por Zed Corp — restam apenas ruínas');
    expect(f('settlement_destroyed named city')).toBe('T+12  Destruição de Cerean Union Capital (cidade) em Oberon por Zed Corp');
    expect(f('builds_destroyed 4')).toBe('T+12  🏭 O estaleiro de Cerean Union em Mars caiu — 4 naves em construção destruídas');
    expect(f('asteroid_impact 1')).toBe('T+12  💥 IMPACTO — Rock 7 atingiu Venus, 1 assentamento destruído (Cerean Union)');
    expect(f('dyson_milestone')).toBe('T+12  ☀ A Esfera de Dyson de Cerean Union chegou a 50% de conclusão');
    expect(f('kaiju_revealed')).toBe('T+12  🦑 ELE ESTÁ VIVO — a coisa vinda de Cygnus é uma criatura do tamanho de uma lua: o LEVIATÃ. Ele está se preparando sobre Mars para atacar em T+175, com 1.234.567 de HP. Todo império está em guerra com ele');
    expect(f('kaiju_dead killer ship')).toBe('T+12  🦑 O LEVIATÃ ESTÁ MORTO — ele caiu em Mars; Zed Corp, a bordo do HMS Grudge, deu o golpe final. Sua carcaça tem 54.321 t de metal para qualquer equipamento de mineração');
    expect(f('building_completed')).toBe('T+12  Cerean Union Capital em Earth concluiu Casa da Moeda Nv 3');
    expect(f('tech_advanced level')).toBe('T+12  Cerean Union concluiu Armas Nv 3');
    expect(f('treaty_signed nap')).toBe('T+12  🕊 Cerean Union e Zed Corp assinaram o Pacto de Não Agressão');
    expect(f('senate_vote passed tally')).toBe('T+12  ⚖ Senado: “Embargo Zed” [embargo comercial] APROVADO — 5 sim / 2 não / 1 abstenção');
    expect(f('trade_accepted pacts')).toBe('T+12  ⚖ Cerean Union negociou 100 de metal, 20 de créditos → Zed Corp em troca de 3 de combustível, 5 de ciência + Pacto de Não Agressão, Pacto de Compartilhamento de Inteligência');
    expect(f('trade_route_run tariff')).toBe('T+12  ⟳ Rota comercial: Cerean Union → Zed Corp entregou 100M 20C (tarifa de −10%) — viagem nº 7');
    expect(f('meteoroid_found tons')).toBe('T+12  ◈ O levantamento encontrou Rock 9 — 400 de créditos');
  });

  it('uses the singular for 0 and 1 (Portuguese counts 0 as one) and the plural above', () => {
    const f = (label: string) => formatChronicleEvent(ev(ROWS.find(x => x[0] === label)!), ctx, 'pt-BR');
    expect(f('trade_lane_consolidated 1')).toContain('1 cargueiro agora coleta');
    expect(f('trade_lane_consolidated 2')).toContain('2 cargueiros agora coletam');
  });

  it('puts the owner after the thing and drops the stutter of an owner-named capital', () => {
    const f = (label: string) => formatChronicleEvent(ev(ROWS.find(x => x[0] === label)!), ctx, 'pt-BR');
    expect(f('building_completed')).toMatch(/^T\+12 {2}Cerean Union Capital em Earth/);
    expect(f('gate_transit sun gate')).toBe('T+12  ◎ Cerean Union Tug passou pelo Sun Gate, cruzando para Cygnus');
  });

  it('rebuilds server-composed text from the payload, and shows the server text when it cannot', () => {
    const f = (label: string) => formatChronicleEvent(ev(ROWS.find(x => x[0] === label)!), ctx, 'pt-BR');
    expect(f('secret_discovered')).toBe('T+12  🔍 Cerean Union: Ceres: DESCOBERTA — um destróier abandonado pode ser recuperado. Reivindicado.');
    expect(f('victory domination')).toBe('T+12  👑 FIM DE JOGO — Zed Corp vence: Controla 7 de 10 mundos (70%)');
    expect(f('victory detail')).toBe('T+12  👑 FIM DE JOGO — Cerean Union vence: Esfera de Dyson concluída');
    expect(f('trade_agreement_ended starved')).toBe('T+12  ⏹ Comércio fixo entre Cerean Union e Zed Corp foi encerrado — uma remessa não pôde ser coberta');
    // an unknown reason and an unknown discovery keep the server's English
    const odd = (kind: string, payload: object) => formatChronicleEvent(
      { tick_number: 1, kind, payload: JSON.stringify(payload), actor_faction_id: 'f1', target_faction_id: null }, ctx, 'pt-BR');
    expect(odd('trade_agreement_ended', { reason: 'new_reason', reason_text: 'ended — brand new', faction_a_name: 'A', faction_b_name: 'B' }))
      .toBe('T+1  ⏹ Comércio fixo entre A e B ended — brand new');
    expect(odd('secret_discovered', { kind: 'new_find', body_name: 'Ceres', message: 'Ceres: DISCOVERY — something new' }))
      .toBe('T+1  🔍 Cerean Union: Ceres: DISCOVERY — something new');
  });

  it('formats big numbers the Portuguese way, only for display', () => {
    const r = ROWS.find(x => x[0] === 'kaiju_revealed')!;
    expect(formatChronicleEvent(ev(r), ctx, 'en')).toContain('1,234,567 HP');
    expect(formatChronicleEvent(ev(r), ctx, 'pt-BR')).toContain('1.234.567 de HP');
    // tick numbers are never grouped
    const big = formatChronicleEvent({ tick_number: 12345, kind: 'kaiju_gone', payload: '{}' }, ctx, 'pt-BR');
    expect(big.startsWith('T+12345 ')).toBe(true);
  });

  it('formats for the language it is given, whatever is on screen', () => {
    expect(getLang()).toBe('en');
    const r = ROWS.find(x => x[0] === 'faction_revived')!;
    expect(formatChronicleEvent(ev(r), ctx, 'pt-BR')).toBe('T+12  Zed Corp fundou um novo assentamento e voltou à guerra');
    expect(getLang()).toBe('en');
  });
});

describe('discovery sentences', () => {
  // worker/room.js composes these; the English rebuild must match them
  // character for character or the Portuguese one is built from a lie.
  const SERVER: Array<[string, Record<string, unknown>, string]> = [
    ['portal_to_sun', {}, 'Ceres: DISCOVERY — an ancient stargate, and its twin in close solar orbit. The pair is live: anything that can reach one end steps out of the other.'],
    ['ancient_city', {}, 'Ceres: DISCOVERY — a long-abandoned colony reactivates under your banner — a free city with a working Lab.'],
    ['pre_terraformed', {}, 'Ceres: DISCOVERY — a world the ancients already prepped for life. Terraformed and waiting; claim it and build.'],
    ['derelict_warship', {}, 'Ceres: DISCOVERY — a derelict destroyer is salvageable. Claimed.'],
    ['resource_cache', {}, 'Ceres: DISCOVERY — a buried cache — +500 metal + 500 credits to your pool.'],
    ['ancient_databank', { tech_id: 'sensors' }, 'Ceres: DISCOVERY — an intact databank teaches your engineers a new trick. sensors +1.'],
    ['ancient_capital', { capital_kind: 'mega_destroyer' }, 'Ceres: DISCOVERY — a derelict Mega Destroyer drifting dark at the edge of the system. Its reactor answers your hail. Claimed.'],
    ['ancient_capital', { capital_kind: 'mobile_foundry' }, 'Ceres: DISCOVERY — a derelict Mobile Foundry, slipways intact. A shipyard at the edge of the system, and it is yours.'],
    ['ancient_relay', {}, 'Ceres: DISCOVERY — an ancient sensor relay, still listening, answering to nobody. Breach it and seize it to make its eyes yours.'],
    ['ancient_station', {}, 'Ceres: DISCOVERY — an ancient weapons station wakes and opens fire on everything in reach. Breach it and seize it to turn its guns.'],
    ['far_gate', { twin_name: 'Pluto' }, 'Ceres: DISCOVERY — an ancient gate, and its twin orbiting Pluto. The pair is live: anything that can reach one end steps out of the other.'],
    ['far_gate', {}, 'Ceres: DISCOVERY — an ancient gate, and its twin in close solar orbit.'],
    ['deep_cache', { metal: 600, credits: 1200 }, 'Ceres: DISCOVERY — a deep cache sealed against the cold. +600 metal + 1200 credits to your pool.'],
    ['precursor_orrery', {}, "Ceres: DISCOVERY — a precursor orrery, built to follow the two suns and still turning. It answers to you now: a working station, and Centauri's suns pay a station double."],
    ['horizon_archive', { science: 40 }, 'Ceres: DISCOVERY — the Horizon Archive, a record of everything the ancients measured at the event horizon. +40 science to your pool.'],
  ];

  it.each(SERVER.map(s => [s[0] + ' ' + JSON.stringify(s[1]), s] as const))('English rebuild = server text: %s', (_n: string, s: [string, Record<string, unknown>, string]) => {
    expect(secretMessage('en', { kind: s[0], body_name: 'Ceres', ...s[1] })).toBe(s[2]);
  });

  it('every one has a Portuguese sentence with no English template left', () => {
    for (const [kind, extra] of SERVER) {
      const pt = secretMessage('pt-BR', { kind, body_name: 'Ceres', ...extra })!;
      expect(pt).toMatch(/^Ceres: DESCOBERTA — /);
      expect(pt).not.toMatch(ENGLISH_TEMPLATE_WORD);
    }
  });

  it('says nothing when the payload cannot support the sentence', () => {
    expect(secretMessage('pt-BR', { kind: 'deep_cache', body_name: 'Ceres' })).toBeNull();
    expect(secretMessage('pt-BR', { kind: 'who_knows', body_name: 'Ceres' })).toBeNull();
    expect(secretMessage('pt-BR', { kind: 'derelict_warship' })).toBeNull();
  });
});
