// THE CATALOGUE EXISTS TWICE AND HAS TO AGREE.
//
// worker/megastructures.js prices a site when the framework goes down;
// src/game/megastructures.ts quotes that price in the picker BEFORE the
// player commits a colony ship to it. A drift between them is a lie told
// at exactly the moment it costs the most — the same failure the hull
// tables produced, where the designer advertised double the firepower
// the yard delivered for the whole of a pacing pass.
//
// So this parses the worker module and compares it entry for entry,
// rather than trusting two hand-maintained objects to stay level.

import fs from 'fs';
import path from 'path';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS, progressOf, remainingFor, loadsRemaining,
  MEGA_MAX_HP, MEGA_SEIZE_HP_FRAC, MEGA_REGEN_PER_TICK, isBreached,
  MEGA_STRIKE_CHARGE_TICKS, GATE_TRANSIT_FRACTION, gateTransitTicks } from '../megastructures';
import { stationDamage } from '../../../worker/megastructures.js';
import { RESEARCH_UNLOCKS } from '../researchUnlocks';

const worker = fs.readFileSync(
  path.resolve(__dirname, '../../..', 'worker/megastructures.js'), 'utf8',
);

/** Parse MEGASTRUCTURES out of the worker bundle. */
function serverCatalogue(): Record<string, {
  label: string; family: string; feature: string; metal: number; credits: number; radius: number;
}> {
  const i = worker.indexOf('export const MEGASTRUCTURES = {');
  if (i < 0) throw new Error('no MEGASTRUCTURES in worker/megastructures.js');
  const block = worker.slice(i, worker.indexOf('\n};', i));
  const out: Record<string, {
    label: string; family: string; feature: string; metal: number; credits: number; radius: number;
  }> = {};
  const re = /(\w+):\s*\{\s*label:\s*'([^']+)',\s*family:\s*'(\w+)',\s*feature:\s*'([^']+)',\s*cost:\s*\{\s*metal:\s*(\d+),\s*credits:\s*(\d+)\s*\},\s*radius:\s*([\d.]+)/g;
  for (const m of block.matchAll(re)) {
    out[m[1]] = {
      label: m[2], family: m[3], feature: m[4],
      metal: Number(m[5]), credits: Number(m[6]), radius: Number(m[7]),
    };
  }
  return out;
}

describe('the catalogue matches the server', () => {
  const srv = serverCatalogue();

  it('parsed all seven from the worker', () => {
    expect(Object.keys(srv).sort()).toEqual([...MEGASTRUCTURE_KINDS].sort());
  });

  it.each(MEGASTRUCTURE_KINDS)('%s', (kind) => {
    const c = MEGASTRUCTURES[kind];
    const s = srv[kind];
    expect(s ? kind : `${kind} MISSING from the worker catalogue`).toBe(kind);
    expect({
      label: c.label, family: c.family, feature: c.feature,
      metal: c.cost.metal, credits: c.cost.credits, radius: c.radius,
    }).toEqual(s);
  });

  it('effect numbers match, field for field', () => {
    // The picker quotes these next to the price and the tick applies
    // them. A drift is the designer/yard split again, in a different
    // table: you weigh a 700-unit gun against its cost and get a
    // different gun.
    const block = worker.slice(worker.indexOf('export const MEGASTRUCTURES = {'));
    for (const kind of MEGASTRUCTURE_KINDS) {
      const i = block.indexOf(`  ${kind}: {`);
      const eff = /effect:\s*\{([^}]*)\}/.exec(block.slice(i, i + 900));
      expect(eff ? kind : `${kind}: no effect block in the worker`).toBe(kind);
      const srv: Record<string, number> = {};
      for (const m of eff![1].matchAll(/(\w+):\s*([\d.]+)/g)) srv[m[1]] = Number(m[2]);
      expect({ kind, ...MEGASTRUCTURES[kind].effect }).toEqual({ kind, ...srv });
    }
  });

  it('every fixed structure that should DO something has numbers', () => {
    // A structure with an empty effect block does nothing when finished.
    // Two of them legitimately have none — a gate's behaviour is its
    // partner link, and the Mega Destroyer's is its strike — so this
    // pins the rest rather than demanding all seven.
    for (const kind of ['weapons_station', 'gravity_sink', 'deep_array', 'null_field', 'mobile_foundry'] as const) {
      expect({ kind, keys: Object.keys(MEGASTRUCTURES[kind].effect).length > 0 })
        .toEqual({ kind, keys: true });
    }
  });

  it('the capture rule is the same number on both sides', () => {
    // Stated once here rather than duplicated as a constant: the client
    // never applies it, it only explains it, so the assertion is that
    // the worker still keeps 70%.
    const m = /CAPTURE_PROGRESS_KEPT = ([\d.]+)/.exec(worker);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0.7);
  });
});

describe('every structure is actually reachable', () => {
  it.each(MEGASTRUCTURE_KINDS)('%s has a research row', (kind) => {
    // A feature id with no unlock row is UNGATED, not locked —
    // hasFeature returns true for anything it does not recognise. So a
    // typo here does not hide a structure, it hands it out for free.
    const row = RESEARCH_UNLOCKS.find(u => u.feature === MEGASTRUCTURES[kind].feature);
    expect(row ? kind : `${kind}: no RESEARCH_UNLOCKS row for ${MEGASTRUCTURES[kind].feature}`)
      .toBe(kind);
  });

  it('the Construction Module gates them all and is reachable itself', () => {
    const row = RESEARCH_UNLOCKS.find(u => u.feature === 'part.construction');
    expect(row).toBeDefined();
    expect(row!.level).toBeLessThanOrEqual(10);
  });
});

describe('progress reads honestly', () => {
  const site = { accMetal: 0, accCredits: 0, costMetal: 5000, costCredits: 7000 };

  it('a fresh site is at zero', () => {
    expect(progressOf(site)).toBe(0);
  });

  it('all the metal and none of the credits is still zero', () => {
    // The WORSE bucket. Reporting 50% here would tell a player they were
    // halfway when they had not delivered a single credit.
    expect(progressOf({ ...site, accMetal: 5000 })).toBe(0);
  });

  it('finished is exactly one, and overpaying does not exceed it', () => {
    expect(progressOf({ ...site, accMetal: 5000, accCredits: 7000 })).toBe(1);
    expect(progressOf({ ...site, accMetal: 9e9, accCredits: 9e9 })).toBe(1);
  });

  it('remaining never goes negative', () => {
    const r = remainingFor({ ...site, accMetal: 9e9, accCredits: 9e9 });
    expect(r).toEqual({ metal: 0, credits: 0 });
  });

  it('quotes the freighter loads still owed, which is the real cost', () => {
    // 5000 metal + 7000 credits at a 400 hold: 13 + 18.
    expect(loadsRemaining(site)).toBe(31);
    expect(loadsRemaining({ ...site, accMetal: 5000 })).toBe(18);
    expect(loadsRemaining({ ...site, accMetal: 5000, accCredits: 7000 })).toBe(0);
  });
});

// ---------------------------------------------------------------------
// EVERY ACTION MUST QUALIFY THE IDS IT SENDS.
//
// MultiplayerGameProvider strips the "<gameId>:" namespace off BODY ids
// at the deserialization boundary, so a client-side site id reads
// 'mega_audit2' while the server still keys on 'abc123:mega_audit2'.
// Every other action in the file re-attaches the prefix with qualify()
// on the way out; the megastructure actions were written without it and
// all four body-id endpoints answered 404.
//
// That failure is invisible in the worst way. The sink's pass list has
// an optimistic update, so the box ticked, sat there for a beat, and
// silently un-ticked itself when the server's refusal arrived — a
// setting that looks applied and is not, on the one structure whose
// whole job is deciding who gets through.
//
// Ship ids are NOT stripped, so qualify() is a pass-through there; it
// stays anyway, because "which ids are namespaced client-side" is
// exactly the kind of thing that changes underneath a caller.
describe('megastructure actions qualify their ids', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../', 'multiplayer/MultiplayerActionsContext.tsx'), 'utf8',
  );

  // Matched on the FULL path fragment, not the trailing verb: '/settings'
  // alone also hits /turn/settings, which is a different endpoint that
  // takes no id at all.
  const ENDPOINTS = [
    'ships/${encodeURIComponent(qualify(shipId))}/place-framework',
    'megastructures/${encodeURIComponent(qualify(siteId))}/deliver',
    'megastructures/${encodeURIComponent(qualify(siteId))}/pair',
    'ships/${encodeURIComponent(qualify(shipId))}/gate',
    'ships/${encodeURIComponent(qualify(shipId))}/strike',
    'megastructures/${encodeURIComponent(qualify(siteId))}/seize',
    'megastructures/${encodeURIComponent(qualify(siteId))}/settings',
  ];

  it.each(ENDPOINTS)('%s is called with a qualified id', (path) => {
    expect(src).toContain(path);
  });

  it('body ids in request bodies are qualified too', () => {
    // ship_id on deliver, partner_body_id on pair. A raw id here 404s
    // just as hard as one in the path, and is easier to miss.
    expect(src).toContain('ship_id: qualify(shipId)');
    // null is the UNPAIR signal and must not be turned into 'gameId:null'.
    expect(src).toContain('partner_body_id: partnerBodyId ? qualify(partnerBodyId) : null');
  });
});

// ---------------------------------------------------------------------
// THE SHIP-CLASS TRANSLATOR MUST CARRY EVERY CLASS THE SERVER BUILDS.
//
// translateShipClass maps server ship_class -> Ship['class'] with a
// `default: return 'frigate'`. That default is right for a class this
// build has never heard of, and catastrophic for one it has: the two
// mega hulls were absent from the switch and silently arrived as
// frigates. Nothing errored. The Ship['class'] union already named
// them, the server sent them correctly, and three finished features
// just stopped appearing — the capital-hull sprites (isCapitalHull
// never matched), the Mega Destroyer's charge button, and the
// foundry's build panel — each looking unbuilt rather than mis-wired.
//
// So this asserts against the SERVER's own hull list rather than a
// hand-copied one. A new hull added server-side fails here until the
// translator learns about it.
describe('translateShipClass carries every server hull', () => {
  const provider = fs.readFileSync(
    path.resolve(__dirname, '../../', 'multiplayer/MultiplayerGameProvider.tsx'), 'utf8',
  );
  const switchBlock = (() => {
    const i = provider.indexOf('function translateShipClass');
    expect(i).toBeGreaterThan(-1);
    return provider.slice(i, provider.indexOf('\n}', i));
  })();

  // The hull classes a megastructure can launch as. These are exactly
  // the kinds whose catalogue entry says it becomes a ship.
  const MEGA_HULLS = MEGASTRUCTURE_KINDS.filter(k => MEGASTRUCTURES[k].family === 'mobile');

  it('knows about at least the two mega hulls', () => {
    expect(MEGA_HULLS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(MEGA_HULLS)('%s is an explicit case, not the default', (kind) => {
    expect(switchBlock).toContain(`case '${kind}':`);
  });
});

// ---------------------------------------------------------------------
// YOU CANNOT SUPPLY A STRUCTURE YOU DO NOT OWN.
//
// Reported from a live game: a rival's Mega Destroyer at 88% showed
// "Run a supply route here" as the panel's primary button, on a card
// whose own subtitle said "not yours". Both server paths that accept
// freight — the standing trade route and the by-hand deliver — were
// written without an ownership check, while the terraform branch
// sitting directly below the route one has always had it. So a misclick
// could pour a faction's entire metal income into finishing the weapon
// pointed at them.
//
// Capture stays available and keeps 70% of the previous owner's freight,
// which is the intended way to acquire somebody else's work.
describe('supplying a megastructure requires owning it', () => {
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );

  /** The body of a named handler, up to the next top-level function. */
  function handlerBody(name: string): string {
    const i = actions.indexOf(`async function ${name}(`);
    expect(i).toBeGreaterThan(-1);
    const next = actions.indexOf('\nasync function ', i + 1);
    return actions.slice(i, next === -1 ? actions.length : next);
  }

  it('the hand-delivery endpoint refuses a site owned by someone else', () => {
    const body = handlerBody('handleDeliverToSite');
    // It must both READ the owner and REFUSE on a mismatch. Selecting
    // the column and never comparing it is the exact shape of the bug.
    expect(body).toMatch(/b\.owner_faction_id/);
    expect(body).toMatch(/owner_faction_id !== me\.id/);
    expect(body).toMatch(/not_owner/);
  });

  it('a trade-route dropoff at a site checks the same thing', () => {
    const i = actions.indexOf("if (destBody.type === 'megastructure')");
    expect(i).toBeGreaterThan(-1);
    const branch = actions.slice(i, actions.indexOf("routeKind = 'megastructure'", i));
    expect(branch).toMatch(/maySupplySite\(/);
    expect(branch).toMatch(/not_owner/);
  });
});

// ---------------------------------------------------------------------
// THE SEIZE BUTTONS MUST MIRROR THE SEIZE RULE.
//
// They used to render on every rival site with the requirement written
// underneath as a footnote, so the ordinary case was a player with no
// fleet within a system of the thing clicking Capture and being told no.
// A control that only works under a condition should state the
// condition and stay dark until it holds.
describe('capture/destroy are gated on real force', () => {
  const card = fs.readFileSync(
    path.resolve(__dirname, '../../', 'multiplayer/MegastructureCard.tsx'), 'utf8',
  );

  it('counts armed hulls at the site, excluding haulers', () => {
    expect(card).toMatch(/parentBodyId === site\.bodyId/);
    // A freighter parked at a gate is not an occupying force — the
    // server says so too (ship_class NOT IN ('freighter', 'colony')).
    expect(card).toMatch(/class !== 'freighter'/);
    expect(card).toMatch(/class !== 'colony'/);
  });

  it('requires your force present and no rival force', () => {
    expect(card).toMatch(/myForce\.length > 0 && rivalForce\.length === 0/);
  });

  it('hides the supply controls on a site that is not yours', () => {
    // The route button is inside the !mine ? ... : ... split, so it
    // cannot render for a non-owner.
    expect(card).toMatch(/\{!mine \? \(/);
  });
});

// ---------------------------------------------------------------------
// HULL POINTS: THE TWO CATALOGUES MUST AGREE.
//
// Taking a structure used to be a presence check — park an armed hull,
// have nobody else's there, done. Lorne read the card and asked the
// right question: "I have not lowered its HP, so why do I have an
// option to capture?" Nothing that costs twelve thousand metal should
// change hands because a corvette drifted past it.
//
// A drift between these numbers is the expensive kind: the card would
// draw a bar against one maximum while the server refused boarding
// against another, so a player would watch a structure hit what looked
// like 15% and be told it was still holding.
describe('hull point constants are mirrored', () => {
  function num(src: string, name: string): number {
    const m = src.match(new RegExp(`export const ${name} = ([0-9.]+)`));
    expect(m).toBeTruthy();
    return Number(m![1]);
  }

  it('MEGA_MAX_HP matches the worker', () => {
    expect(num(worker, 'MEGA_MAX_HP')).toBe(MEGA_MAX_HP);
    // 200 was calibrated against a destroyer's BASE 22.5 damage — a hull
    // with no mounts, which nobody flies. Real destroyers do 60-130, so
    // the original figure was under two ticks of one ship. See the
    // balance arithmetic below.
    expect(MEGA_MAX_HP).toBe(3000);
  });

  it('the breach fraction matches the worker', () => {
    expect(num(worker, 'MEGA_SEIZE_HP_FRAC')).toBe(MEGA_SEIZE_HP_FRAC);
    expect(MEGA_SEIZE_HP_FRAC).toBe(0.2);
  });

  it('the regen rate matches the worker', () => {
    expect(num(worker, 'MEGA_REGEN_PER_TICK')).toBe(MEGA_REGEN_PER_TICK);
  });

  it('isBreached agrees at, above and below the line', () => {
    const line = MEGA_MAX_HP * MEGA_SEIZE_HP_FRAC;
    expect(isBreached({ hp: line })).toBe(true);      // AT the line counts
    expect(isBreached({ hp: line - 1 })).toBe(true);
    expect(isBreached({ hp: line + 1 })).toBe(false);
    expect(isBreached({ hp: 0 })).toBe(true);
    expect(isBreached({ hp: MEGA_MAX_HP })).toBe(false);
  });
});

// ---------------------------------------------------------------------
// THE SIEGE RULES HAVE TO HOLD TOGETHER.
//
// Three separate places have to agree that "breached" means the same
// thing: the seize endpoint that refuses boarding, the tick pass that
// applies damage and repair, and every structure effect that switches
// off. Miss one and the hull bar becomes decoration on that structure.
describe('siege wiring', () => {
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const state = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/state.js'), 'utf8',
  );

  it('seizing refuses an undamaged structure', () => {
    const i = actions.indexOf('async function handleSeizeSite(');
    const body = actions.slice(i, actions.indexOf('\nasync function ', i + 1));
    expect(body).toMatch(/isBreached\(site\.hp\)/);
    expect(body).toMatch(/not_breached/);
  });

  it('the siege pass runs every tick and can both damage and repair', () => {
    expect(room).toContain('await this.resolveMegastructureSiege(gameId, tick)');
    const i = room.indexOf('async resolveMegastructureSiege(');
    const body = room.slice(i, room.indexOf('\n  /**', i + 1));
    // Damage from hostiles, repair otherwise. Both directions, clamped.
    expect(body).toMatch(/Math\.max\(0, hp - incoming\)/);
    expect(body).toMatch(/Math\.min\(MEGA_MAX_HP, hp \+ MEGA_REGEN_PER_TICK\)/);
    // Haulers are not a siege — same exclusion the seize check uses.
    expect(body).toMatch(/NOT IN \('freighter', 'colony'\)/);
    // A hull mid-burn still carries its old parent_body_id.
    expect(body).toMatch(/inFlight\.has/);
    // Peace is asked of the shared helper, never re-implemented.
    expect(body).toMatch(/this\.peacePairsAt\(gameId, tick\)/);
  });

  it('every structure effect switches off when breached', () => {
    // Weapons station and gravity sink live in the tick; the two sensor
    // structures are decided in the state serializer.
    const roomGuards = room.match(/AND m\.hp > \?/g) ?? [];
    expect(roomGuards.length).toBeGreaterThanOrEqual(2);
    expect(state).toMatch(/AND m\.hp > \?/);
    expect(state).toMatch(/MEGA_BREACH_HP/);
  });

  it('hp reaches the client', () => {
    expect(state).toMatch(/settings_json, hp,/);
  });
});

// ---------------------------------------------------------------------
// THE CHARGE CLOCK IS IN FOUR PLACES AND HAS TO READ THE SAME IN ALL OF
// THEM.
//
// The server arms the strike, the tick fires it, the ship panel counts
// it down, and a confirm dialog tells you how long you have before your
// own world dies. That dialog had the number typed into it as a string,
// so halving the constant from 48 to 24 would have left it promising
// two days on a one-day fuse — a lie told at the exact moment it costs
// the most.
describe('mega strike charge is mirrored everywhere', () => {
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../../', 'components/ShipPanel.tsx'), 'utf8',
  );

  it('client and server agree', () => {
    const m = actions.match(/export const MEGA_STRIKE_CHARGE_TICKS = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(MEGA_STRIKE_CHARGE_TICKS);
  });

  it('is 24', () => {
    expect(MEGA_STRIKE_CHARGE_TICKS).toBe(24);
  });

  it('no UI copy hardcodes a tick count', () => {
    // Every mention in the panel must be the constant, not a literal.
    const strikeCopy = panel.slice(
      panel.indexOf('MEGA DESTROYER STRIKE'),
      panel.indexOf('MEGA DESTROYER STRIKE') + 4000,
    );
    expect(strikeCopy).not.toMatch(/\b48 ticks?\b/);
    expect(strikeCopy).not.toMatch(/\b24 ticks?\b/);
    expect(strikeCopy).toMatch(/\$\{MEGA_STRIKE_CHARGE_TICKS\}/);
  });
});

// ---------------------------------------------------------------------
// THE FOUNDRY'S YARD TAB.
//
// The one hull in the game that IS a shipyard had no way to build
// anything from its own panel — the slots were only reachable from the
// BODY's menu, which is the last place a player looks after selecting
// the ship they just spent nine thousand metal on.
describe('the foundry builds from its own panel', () => {
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../../', 'components/ShipPanel.tsx'), 'utf8',
  );
  const build = fs.readFileSync(
    path.resolve(__dirname, '../../', 'components/BuildPanel.tsx'), 'utf8',
  );

  it('has a yard tab, gated on being a parked foundry', () => {
    expect(panel).toMatch(/'yard'/);
    expect(panel).toMatch(/ship\.class === 'mobile_foundry' && !ship\.transit/);
  });

  it('renders the real BuildPanel rather than a second implementation', () => {
    // A hand-rolled copy would drift from the queue, the slot pips and
    // the senate price law within a release.
    expect(panel).toMatch(/<BuildPanel bodyId=/);
  });

  it('BuildPanel accepts an explicit body and prefers it', () => {
    // Without the override it reads the map selection, which is empty
    // when a SHIP is selected — so the tab would render nothing.
    expect(build).toMatch(/bodyId \?\? uiState\.selectedBodyId/);
  });
});

// ---------------------------------------------------------------------
// SUPPLY OWNERSHIP HAS THREE DOORS AND THEY MUST ALL BE LOCKED.
//
// Restricting supply to the owner went in on the route-creation
// endpoint and on hand delivery, and missed the other two: the V2
// validator (which serves create, project AND edit) still carried a
// comment saying "anyone may supply a site, including an ally's", and
// the TICK's unload had no check at all.
//
// The tick was the one that mattered. Creating a route to a rival's
// structure was refused, but a route created before a capture kept
// running afterwards — your freighters hauling your metal into the
// thing that had just been taken off you, reporting successful trips
// the whole way.
describe('you cannot supply a structure you do not own', () => {
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );
  const v2 = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/tradeRoutesV2.js'), 'utf8',
  );

  it('the tick refuses to unload into somebody else\'s site', () => {
    const i = room.indexOf('const siteHere = await DB');
    expect(i).toBeGreaterThan(-1);
    const block = room.slice(i, i + 2200);
    // It must read the owner AND put it through the shared rule.
    expect(block).toMatch(/b\.owner_faction_id/);
    expect(block).toMatch(/maySupplySite\(/);
    // Stalled, not cancelled — the itinerary is fine again the moment
    // the site is taken back.
    expect(block).toMatch(/status = 'stalled'/);
  });

  it('ALL FOUR doors share one definition of who may supply', () => {
    // Freight can enter a site four ways: route creation, the V2
    // validator (create/project/edit), hand delivery, and the tick's
    // unload. Three of them once disagreed with each other, which is how
    // a captured site went on being fed for free — and the fix at the
    // time only reached two. One helper, four call sites, no room for a
    // fifth opinion.
    const mega = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/megastructures.js'), 'utf8',
    );
    expect(mega).toMatch(/export function maySupplySite/);
    // Read locally — `actions` belongs to a different describe's scope.
    const acts = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
    );
    for (const src of [acts, v2, room]) expect(src).toMatch(/maySupplySite\(/);
    // actions.js holds TWO of them (route creation and hand delivery).
    expect((acts.match(/maySupplySite\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the V2 validator agrees with the creation endpoint', () => {
    expect(v2).toMatch(/maySupplySite\(/);
    expect(v2).toMatch(/not_owner/);
    // The old comment asserted the opposite rule and outlived it.
    expect(v2).not.toMatch(/anyone may supply a site/);
  });
});

// ---------------------------------------------------------------------
// A STRUCTURE CHANGING HANDS IS A PUBLIC EVENT.
//
// handleSeizeSite wrote no chronicle entry on either branch, so the
// loudest thing in the system happened in silence while a Mega
// Destroyer merely CHARGING got a public record.
describe('seizing a structure is recorded', () => {
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const provider = fs.readFileSync(
    path.resolve(__dirname, '../../', 'multiplayer/MultiplayerGameProvider.tsx'), 'utf8',
  );

  it.each(['megastructure_captured', 'megastructure_destroyed'])(
    '%s is written and rendered', (kind) => {
      expect(actions).toContain(kind);
      // An entry nobody can read is not a record.
      expect(provider).toContain(kind);
    });

  it('names who lost it, not just who took it', () => {
    // target_faction_id carries the previous owner; without it the log
    // says a structure moved and leaves everyone guessing whose.
    const i = actions.indexOf('async function chronicleSeize');
    const body = actions.slice(i, actions.indexOf('\n}', i));
    expect(body).toMatch(/site\.owner_faction_id/);
    expect(body).toMatch(/'public'/);
  });
});

// ---------------------------------------------------------------------
// THE SIEGE HAS TO ANNOUNCE ITSELF.
//
// The pacing was tuned around the owner getting a chance to answer — a
// destroyer needs ~10 ticks, and the damage reverses at +2/tick the
// moment the attacker leaves. All of that assumed a warning that did
// not exist: you found out when the structure was gone.
describe('a structure under attack raises a situation row', () => {
  const sit = fs.readFileSync(
    path.resolve(__dirname, '../../', 'hooks/useSituationItems.ts'), 'utf8',
  );

  it('has a category, a label and a tier', () => {
    expect(sit).toMatch(/'structure_siege'/);
    expect(sit).toMatch(/structure_siege: 'Structure under attack'/);
    expect(sit).toMatch(/structure_siege: 'now'/);
  });

  it('fires on HULL, not on hostile presence', () => {
    // A warship passing through is not news. One that has taken thirty
    // points off your gate is the whole story.
    const i = sit.indexOf('A STRUCTURE OF YOURS IS BEING BROKEN OPEN');
    expect(i).toBeGreaterThan(-1);
    const block = sit.slice(i, i + 2600);
    expect(block).toMatch(/site\.hp >= MEGA_MAX_HP\) continue/);
    expect(block).toMatch(/isBreached\(site\)/);
    // Owner-only: a rival's structure being broken is not your alert.
    expect(block).toMatch(/ownedBy !== 'player'\) continue/);
  });
});

// ---------------------------------------------------------------------
// AND IT HAS TO BE VISIBLE ON THE MAP.
describe('a damaged structure shows it', () => {
  const renderer = fs.readFileSync(
    path.resolve(__dirname, '../../', 'render/mapRenderer.ts'), 'utf8',
  );

  it('draws a hull ring below full health', () => {
    expect(renderer).toMatch(/hullFrac < 1/);
    expect(renderer).toMatch(/hullFrac <= MEGA_SEIZE_HP_FRAC/);
  });

  it('the ring is fed real hull, not a placeholder', () => {
    expect(renderer).toMatch(/st\.hp \/ MEGA_MAX_HP/);
  });
});

// ---------------------------------------------------------------------
// AND THE CATALOGUE MUST NOT PROMISE WHAT IS NOT BUILT.
describe('the catalogue does not advertise vapourware', () => {
  it('the weapons station no longer claims to be upgradable', () => {
    // Tiers were specced, reserved a settings_json slot, and then cut.
    // The blurb outlived the decision and went on offering an upgrade
    // path with no field, no endpoint and no UI behind it.
    for (const k of MEGASTRUCTURE_KINDS) {
      expect(MEGASTRUCTURES[k].blurb).not.toMatch(/upgradable/i);
    }
    expect(worker).not.toMatch(/Upgradable/);
  });
});

// ---------------------------------------------------------------------
// THE DEFENDER HAS TO BE ABLE TO SEE THE CLOCK.
//
// The charge exists for exactly one reason: to give the target a window
// to act. Everything needed to show it had been reaching the client
// since day one — /state sends strike_ready_tick for RIVAL ships too,
// and the client type carries it — and the only UI that rendered it was
// gated on owning the hull. So the single player who could not act on
// the countdown was the only one who could see it, and cutting 48 to 24
// halved a warning that was never being delivered.
describe('a charging strike is visible to the target', () => {
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../../', 'components/ShipPanel.tsx'), 'utf8',
  );
  const sit = fs.readFileSync(
    path.resolve(__dirname, '../../', 'hooks/useSituationItems.ts'), 'utf8',
  );
  const renderer = fs.readFileSync(
    path.resolve(__dirname, '../../', 'render/mapRenderer.ts'), 'utf8',
  );
  const provider = fs.readFileSync(
    path.resolve(__dirname, '../../', 'multiplayer/MultiplayerGameProvider.tsx'), 'utf8',
  );
  const state = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/state.js'), 'utf8',
  );

  it('the server sends the clock for rival hulls, not just your own', () => {
    // If this ever narrows to own-ships, every readout below goes dark
    // for the one person who needs it.
    expect(state).toMatch(/s\.strike_target_body_id, s\.strike_ready_tick/);
  });

  it('the ship-tab countdown is NOT gated on ownership', () => {
    const i = panel.indexOf('THE COUNTDOWN, FOR EVERYONE');
    expect(i).toBeGreaterThan(-1);
    const block = panel.slice(i, i + 900);
    expect(block).toMatch(/ship\.strikeReadyTick != null && \(\(\) =>/);
    // The guard that must NOT be there.
    expect(block).not.toMatch(/isOwn && ship\.strikeReadyTick/);
  });

  it('but the controls stay owner-only', () => {
    // Reading the clock is intelligence; standing it down is an order.
    expect(panel).toMatch(/isOwn && mpActions && ship\.class === 'mega_destroyer'/);
  });

  it('the map draws a ring that CLOSES as it charges', () => {
    // Closing, not emptying: a ring completing reads as a thing being
    // made ready, which is what is happening. It is also the opposite
    // direction to the structure hull ring, so one viewer never sees
    // two rings meaning opposite things by the same shape.
    expect(renderer).toMatch(/function drawStrikeCharge/);
    expect(renderer).toMatch(/1 - left \/ MEGA_STRIKE_CHARGE_TICKS/);
    // Drawn for any visible hull, not only your own.
    expect(renderer).toMatch(/ship\.strikeReadyTick != null\) \{/);
  });

  it('raises a situation row in both directions', () => {
    expect(sit).toMatch(/'strike_incoming'/);
    expect(sit).toMatch(/'strike_mine'/);
    expect(sit).toMatch(/strike_incoming: 'now'/);
    // "A world of yours" must include one you have merely settled — the
    // settlements are what actually die.
    const i = sit.indexOf('A MEGA DESTROYER IS WINDING UP');
    const block = sit.slice(i, i + 2600);
    expect(block).toMatch(/st\.bodyId === world\.id && st\.ownedBy === 'player'/);
    // Soonest first, whatever else shares the tier.
    expect(block).toMatch(/sortKey: left/);
  });

  it('the chronicle line is readable, and so is the all-clear', () => {
    // It printed as the raw slug "mega_strike_charging" for its whole
    // life — the one public warning in the mechanic, unreadable.
    expect(provider).toMatch(/ev\.kind === 'mega_strike_charging'/);
    expect(provider).toMatch(/ev\.kind === 'mega_strike_aborted'/);
  });

  it('the all-clear is actually written, not just formatted', () => {
    const actions = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
    );
    expect(actions).toMatch(/'mega_strike_aborted'/);
    // Only when it was really armed — a stand-down on an idle hull is
    // not news.
    expect(actions).toMatch(/wasArmed/);
  });

  it('the Herald knows all four events exist', () => {
    const digest = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/digest.js'), 'utf8',
    );
    for (const k of ['mega_strike_charging', 'mega_strike_aborted',
      'megastructure_captured', 'megastructure_destroyed']) {
      expect(digest).toContain(k);
    }
    // Registered, not merely defined.
    expect(digest).toMatch(/\.\.\.buildMegastructureStories\(/);
  });
});

// ---------------------------------------------------------------------
// BALANCE, AS ARITHMETIC.
//
// Every number in this system was first calibrated against a ship's BASE
// stats — the damage a hull does with no weapon mounts, which is a ship
// nobody flies. That single mistake made the structure HP wrong by an
// order of magnitude, left the Weapons Station frozen at the power of a
// fresh-out-of-the-yard destroyer, and made the Mega Destroyer fight
// like a corvette. These tests do the comparison in the open so the next
// change to either side has to face it.
describe('megastructure combat is balanced against real ships', () => {
  // Mirrors shipDesigns.js: dmgBonus = 0.40 x (1 + 0.10 x lvl) x mounts.
  const shipDamage = (base: number, mounts: number, lvl: number) =>
    base * (1 + 0.40 * (1 + 0.10 * lvl) * mounts);
  // p = atk^2 / (atk^2 + def^2)
  const hit = (atk: number, def: number) => (atk * atk) / (atk * atk + def * def);

  const DESTROYER_BASE = 22.5;
  const SETTLEMENT_SPEED = 0.30;

  it('a real destroyer hits far harder than its base stat', () => {
    // The number every earlier calibration used was 22.5. This is what a
    // destroyer actually fields.
    expect(shipDamage(DESTROYER_BASE, 6, 10)).toBeCloseTo(130.5, 1);
    expect(shipDamage(DESTROYER_BASE, 6, 3)).toBeCloseTo(92.7, 1);
  });

  it('a structure survives a real siege rather than two ticks of one', () => {
    // One well-fitted destroyer, net of repair, must need a long
    // commitment; a squadron should manage it but not trivially.
    const solo = shipDamage(DESTROYER_BASE, 6, 5) - MEGA_REGEN_PER_TICK;
    const toBreach = MEGA_MAX_HP * (1 - MEGA_SEIZE_HP_FRAC);
    expect(toBreach / solo).toBeGreaterThan(15);      // a lone hull: slow
    const squad = shipDamage(DESTROYER_BASE, 6, 5) * 3 - MEGA_REGEN_PER_TICK;
    expect(toBreach / squad).toBeGreaterThan(4);      // three hulls: real work
    expect(toBreach / squad).toBeLessThan(12);        // ...but achievable
  });

  it('repair outruns a corvette screen, which is the point of repair', () => {
    // Two corvette mounts at max Weapons. If this ever drops below the
    // regen rate, a single cheap hull can grind any structure down given
    // enough unattended ticks — the exact failure repair exists to stop.
    const corvette = shipDamage(3.5, 2, 10);
    expect(corvette).toBeLessThan(MEGA_REGEN_PER_TICK);
  });

  it('the station tracks Weapons research instead of standing still', () => {
    const lo = stationDamage(DESTROYER_BASE, 0);
    const hi = stationDamage(DESTROYER_BASE, 10);
    expect(hi).toBeGreaterThan(lo * 1.5);
    // Three targets at a well-fitted destroyer's total output — spread
    // rather than concentrated, which is the trade an emplacement makes.
    const stationOutput = hi * 3 * hit(SETTLEMENT_SPEED, SETTLEMENT_SPEED);
    const destroyerOutput = shipDamage(DESTROYER_BASE, 6, 10) * hit(SETTLEMENT_SPEED, SETTLEMENT_SPEED);
    expect(stationOutput / destroyerOutput).toBeGreaterThan(1);
    expect(stationOutput / destroyerOutput).toBeLessThan(2.5);
  });

  it('the Mega Destroyer trades accuracy for a devastating hit', () => {
    const MEGA_SPEED = 0.08;
    const MEGA_DMG = 350;
    const acc = hit(MEGA_SPEED, SETTLEMENT_SPEED);
    expect(acc).toBeLessThan(0.10);                 // it misses most shots
    // ...and when it lands, it deletes a frigate outright.
    expect(MEGA_DMG).toBeGreaterThan(164);
    // Expected output lands near one well-fitted destroyer: earned
    // through variance rather than volume.
    const expected = MEGA_DMG * acc;
    expect(expected).toBeGreaterThan(15);
    expect(expected).toBeLessThan(40);
  });

  it('everything hits the Mega Destroyer back', () => {
    // "It is a death star; everyone can hit it" — the counterweight to
    // the damage above.
    expect(hit(SETTLEMENT_SPEED, 0.08)).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------
// THE GAPS BETWEEN THIS SYSTEM AND THE REST OF THE GAME.
describe('megastructures are wired into the rest of the game', () => {
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );

  it('a station can be shot back at, at range', () => {
    // It reached 700 units and could only be damaged by hulls parked ON
    // it, so most of a system was an annulus where it fired for free.
    expect(room).toMatch(/COUNTER-BATTERY/);
    expect(room).toMatch(/megaReturn\.set/);
    expect(room).toMatch(/hp = MAX\(0, hp - \?\) WHERE body_id/);
  });

  it('capital hulls are a target-priority category', () => {
    // Three literal ship_class matches meant the biggest hull in the
    // game could never be RANKED — only reached by the fallback ladder.
    expect(actions).toMatch(/'capital'/);
    expect(room).toMatch(/cat === 'capital'/);
    expect(room).toMatch(/CAPITAL_CLASSES/);
  });

  it('a stored five-key priority still validates', () => {
    // Every ship already carrying orders has the pre-capital list. A
    // strict permutation check would have rejected the next edit of all
    // of them.
    expect(actions).toMatch(/LEGACY_PRIORITY_KEYS/);
  });

  it('capital hulls get the armour research every other hull gets', () => {
    // They take no fittings by design — that is an argument about
    // mounts, not about a faction's metallurgy.
    const i = room.indexOf('async launchCompletedMobileSites');
    const body = room.slice(i, room.indexOf('\n  /**', i + 1));
    expect(body).toMatch(/1 \+ 0\.08 \* capDefLvl/);
  });
});

// ---------------------------------------------------------------------
// CO-FUNDING, AND WHAT IT DOES NOT GRANT.
//
// A construction pact is the sanctioned version of the thing that used
// to happen by accident: freight flowing into somebody else's site. It
// grants exactly one right — the right to fund, and to pair gates — and
// deliberately no ceasefire, no vision, no defence.
//
// That separation is what makes "you lose everything on betrayal" work
// without a rule of its own. The BENEFITS of a co-funded structure ride
// the OTHER treaties: an Array shares vision with allies, a Weapons
// Station holds fire on peace partners. Fund a partner's Array with no
// alliance and you get nothing; hold one and lose it, and the vision
// goes with it.
describe('the construction pact grants funding and nothing else', () => {
  const trades = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/trades.js'), 'utf8',
  );
  const state2 = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/state.js'), 'utf8',
  );
  const mega = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/megastructures.js'), 'utf8',
  );

  it('is a real pact kind', () => {
    expect(trades).toMatch(/'construction_pact'/);
  });

  it('does NOT make you allies — no shared vision', () => {
    // allyIds feeds the sensor CTEs. If construction_pact ever lands in
    // that list, co-funding a gate quietly hands over your fog.
    const i = state2.indexOf('const allyRowsP');
    const q = state2.slice(i, i + 900);
    expect(q).toMatch(/'defense_pact', 'intel_share'/);
    expect(q).not.toMatch(/construction_pact/);
  });

  it('does NOT make you peaceful — the guns stay live', () => {
    // peacePairsAt is nap + defense_pact only. Two factions can co-fund
    // a gate and still be shooting at each other over it.
    const room3 = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
    );
    const i = room3.indexOf('async peacePairsAt');
    const q = room3.slice(i, i + 900);
    expect(q).toMatch(/'nap', 'defense_pact'/);
    expect(q).not.toMatch(/construction_pact/);
  });

  it('asks whether the OWNER is my partner, not whether I am my own', () => {
    // The set is MY partners, so the membership test is on the owner.
    // Inverted, it refuses every legitimate co-build while looking
    // perfectly reasonable — which is exactly what it did until a live
    // pact failed to open the door.
    const i = mega.indexOf('export function maySupplySite');
    const body = mega.slice(i, mega.indexOf('\n}', i));
    expect(body).toMatch(/partners\.has\(ownerFactionId\)/);
    expect(body).not.toMatch(/partners\.has\(factionId\)/);
  });

  it('the per-site veto beats the pact', () => {
    const i = mega.indexOf('export function maySupplySite');
    const body = mega.slice(i, mega.indexOf('\n}', i));
    expect(body).toMatch(/excludedIds/);
  });

  it('a gate link that loses its pact is swept', () => {
    // A door into a former partner's capital is the most dangerous
    // stale state the game can hold. Self-healing rather than
    // event-driven, so capture of one end is caught too.
    const room3 = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
    );
    expect(room3).toMatch(/async snapUnauthorisedGateLinks/);
    expect(room3).toMatch(/await this\.snapUnauthorisedGateLinks\(gameId, tick\)/);
    // Ancient gates belong to nobody and their link predates every
    // treaty — never ours to cut.
    const i = room3.indexOf('async snapUnauthorisedGateLinks');
    const body = room3.slice(i, room3.indexOf('\n  /**', i + 1));
    expect(body).toMatch(/ba\.owner_faction_id IS NOT NULL/);
  });

  it('the senate can price megaprojects, per faction or for everyone', () => {
    const senate = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/senate.js'), 'utf8',
    );
    expect(senate).toMatch(/id: 'megastructure_cost_multiplier'/);
    // perFaction gives BOTH levers: the resolver layers a targeted law
    // over the general one.
    const i = senate.indexOf("id: 'megastructure_cost_multiplier'");
    expect(senate.slice(i, i + 1800)).toMatch(/perFaction: true/);
  });

  it('the price is stamped at placement, so a law cannot re-price a build', () => {
    const acts = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
    );
    expect(acts).toMatch(/megastructure_cost_multiplier/);
    expect(acts).toMatch(/megaCostMetal, megaCostCredits/);
  });
});

// ---------------------------------------------------------------------
// A GATE FLINGS YOU; IT DOES NOT TELEPORT YOU.
//
// The first cut of this gave gates a cooldown between transits, which
// was the wrong reading: the gate should compress the FLIGHT, not gate
// re-entry. A crossing that would take ten ticks under your own engines
// takes three, and the hull is genuinely in flight for them.
//
// That is the whole reason this version is better. An instant hop
// sidestepped every system the game already has; a real burn plugs
// straight into them — the hull is visible, interceptable, and a
// Gravity Sink can pluck it out mid-crossing like anything else.
describe('a gate compresses the flight', () => {
  const acts = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const workerMega = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/megastructures.js'), 'utf8',
  );

  it('the fraction is mirrored', () => {
    const m = workerMega.match(/export const GATE_TRANSIT_FRACTION = ([0-9.]+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(GATE_TRANSIT_FRACTION);
    expect(GATE_TRANSIT_FRACTION).toBe(0.25);
  });

  it('ten ticks becomes three — rounded UP, never free', () => {
    expect(gateTransitTicks(10)).toBe(3);
    expect(gateTransitTicks(4)).toBe(1);
    expect(gateTransitTicks(1)).toBe(1);
    // A gate is fast, not instant: nothing rounds down to zero.
    expect(gateTransitTicks(0)).toBe(1);
    expect(gateTransitTicks(NaN)).toBe(1);
    expect(gateTransitTicks(Infinity)).toBe(1);
  });

  it('the trip is a real transit node, not a teleport', () => {
    const i = acts.indexOf('async function handleGateTransit');
    const body = acts.slice(i, acts.indexOf('\n}', acts.indexOf('trip_ticks', i)));
    // It flies through the SAME machinery as any other burn: a committed
    // node the tick promotes, rather than a second kind of flight.
    expect(body).toMatch(/INSERT INTO game_ship_nodes/);
    expect(body).toMatch(/'committed'/);
    // ...and no longer just moves the ship.
    expect(body).not.toMatch(/UPDATE game_ships SET parent_body_id = \? WHERE id = \?/);
  });

  it('is priced off the burn it replaced, with the faction first', () => {
    const i = acts.indexOf('async function handleGateTransit');
    const body = acts.slice(i, i + 6000);
    expect(body).toMatch(/computeLegTicks\(me\.id, gate\.body_id, far\.id, tick\)/);
    expect(body).toMatch(/GATE_TRANSIT_FRACTION/);
  });

  it('a non-finite leg cannot make the trip instant', () => {
    // Infinity and NaN both sail through Math.ceil into the bind, where
    // D1 stores NULL — which reads back as "no travel time at all".
    const i = acts.indexOf('async function handleGateTransit');
    const body = acts.slice(i, i + 6000);
    expect(body).toMatch(/Number\.isFinite\(raw\) && raw > 0/);
    expect(body).toMatch(/Math\.max\(1, Math\.ceil\(legTicks \* GATE_TRANSIT_FRACTION\)\)/);
  });

  it('nothing is left of the retired cooldown', () => {
    // An unused column with a plausible name is a trap for whoever reads
    // the schema next.
    expect(acts).not.toMatch(/transit_cooldown_until_tick/);
    expect(workerMega).not.toMatch(/GATE_COOLDOWN_FRACTION/);
  });
});

// ---------------------------------------------------------------------
// A STRUCTURE IS NOT TERRITORY.
//
// Megastructure sites are game_bodies — that is what buys them an orbit,
// a position, sensor visibility and an owner for free, and it is the
// decision that made the whole feature affordable. The cost is that
// every pre-existing piece of code counting "bodies you own" silently
// started counting them.
//
// Two of those were scoring systems, and both were exploitable:
//
//   DOMINATION counted every body, so each structure you raised added
//   one to your tally AND one to the total. (A+N)/(T+N) beats A/T for
//   any A < T, so building warp gates was a strictly better path to the
//   win than taking planets — and it diluted every rival's share on the
//   way. Worse, the political map is settlement-derived, so the map and
//   the win condition were counting different things: the game could
//   declare a winner the map never showed.
//
//   SENATE WEIGHT is one vote per system controlled, on strict
//   plurality of bodies owned. Three cheap gates parked around Neptune
//   took the Neptune system without a settlement — continuous political
//   power bought with construction freight.
describe('megastructures do not count as territory', () => {
  const victory = fs.readFileSync(
    path.resolve(__dirname, '../', 'victory.ts'), 'utf8',
  );
  const systems = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/systems.js'), 'utf8',
  );

  it('the domination win ignores them', () => {
    const i = victory.indexOf('function claimableBodies');
    const body = victory.slice(i, victory.indexOf('\n}', i));
    expect(body).toMatch(/type !== 'megastructure'/);
  });

  it('senate system control ignores them', () => {
    // Skipped before the tally, so they leave both the numerator and
    // the system's total alone — a gate is not a world in that system
    // any more than it is a world you own.
    expect(systems).toMatch(/b\.type === 'megastructure'\) continue/);
  });

  it('the exploit maths is what it is', () => {
    // Pinned so the reasoning survives even if the code moves: adding a
    // body you own always raises your share, which is why "just build
    // more structures" was a winning line.
    const share = (a: number, t: number) => a / t;
    expect(share(5, 20)).toBeLessThan(share(6, 21));
    expect(share(6, 21)).toBeLessThan(share(7, 22));
  });

// ---------------------------------------------------------------------
// ASSET DEALS: selling a hull or a world for freight.
//
// The delicate part of a sale is not the transfer, it is what happens
// when it goes wrong halfway. A buyer paying in instalments to a
// stranger is exposed for the whole time their freighters are in the
// air, and every rule below exists to bound that exposure.
describe('asset deals hand over on delivery', () => {
  const deals = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/assetDeals.js'), 'utf8',
  );
  const acts = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );

  it('a world is sold by transferring its settlement', () => {
    // Body ownership in this game is DERIVED from settlements, so the
    // settlement is the deed. Writing game_bodies.owner_faction_id
    // directly would be a claim the rest of the game disagrees with the
    // moment ownership is recomputed.
    const i = deals.indexOf('export async function fulfilDeal');
    const body = deals.slice(i, deals.indexOf('\n}', i));
    expect(body).toMatch(/UPDATE game_settlements SET owner_faction_id/);
    expect(body).not.toMatch(/UPDATE game_bodies SET owner_faction_id/);
  });

  it('the seller is paid only at handover', () => {
    // Freight sits escrowed in the meter until the asset actually
    // moves. Paying per delivery would let a seller take two instalments
    // and walk, which makes paying a stranger over several runs a
    // coin flip instead of a trade.
    const i = deals.indexOf('export async function fulfilDeal');
    const body = deals.slice(i, deals.indexOf('\n}', i));
    expect(body).toMatch(/UPDATE game_factions SET metal = metal \+ \?/);
    // ...and the transfer, the payment and the closure are ONE batch.
    expect(body).toMatch(/env\.DB\.batch\(\[/);
  });

  it('a dead deal refunds the buyer', () => {
    const i = deals.indexOf('export async function voidDeal');
    const body = deals.slice(i, deals.indexOf('\n}', i));
    expect(body).toMatch(/deal\.buyer_faction_id/);
    expect(body).toMatch(/status = 'void'/);
  });

  it('the asset is re-checked at handover, not trusted from the offer', () => {
    // The seller has had every tick since the proposal to scrap the
    // hull or lose the world.
    const i = deals.indexOf('export async function fulfilDeal');
    const body = deals.slice(i, deals.indexOf('\n}', i));
    expect(body).toMatch(/await assetState\(/);
  });

  it('payment must physically arrive at the asset', () => {
    const i = acts.indexOf('async function handlePayAssetDeal');
    const body = acts.slice(i, acts.indexOf('\n}\n', i));
    expect(body).toMatch(/ship\.parent_body_id !== deal\.delivery_body_id/);
    // And it drains the hold, so the freight is really spent.
    expect(body).toMatch(/cargo_metal = MAX\(0, cargo_metal - \?\)/);
  });

  it('cancelling is not a way to keep the instalments', () => {
    const i = acts.indexOf('async function handleCancelAssetDeal');
    const body = acts.slice(i, acts.indexOf('\n}\n', i));
    expect(body).toMatch(/voidDeal\(/);
  });

  it('a scrapped asset kills the deal from the tick', () => {
    expect(room).toMatch(/async sweepAssetDeals/);
    expect(room).toMatch(/await this\.sweepAssetDeals\(gameId, tick\)/);
  });

  it('paid fraction takes the WORSE bucket', () => {
    // All the metal and none of the credits is not half paid in any
    // sense the seller cares about — same rule site progress uses.
    const i = deals.indexOf('export function paidFraction');
    const body = deals.slice(i, deals.indexOf('\n}', i));
    expect(body).toMatch(/Math\.min\(fm, fc\)/);
  });
});

  it('the standings display counts the same bodies the win does', () => {
    // countOwnedBodiesPerFaction feeds the domination progress readout
    // and its own doc says it mirrors the victory check EXACTLY. Fixing
    // the win condition without it would have left the standings
    // reporting the old, inflated number — a player told they held 17%
    // against a threshold measured on something else.
    const factions = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'worker/factions.js'), 'utf8',
    );
    const i = factions.indexOf('async function countOwnedBodiesPerFaction');
    const body = factions.slice(i, factions.indexOf('\n}', i));
    expect(body).toMatch(/type <> 'megastructure'/);
  });
});

// ---------------------------------------------------------------------
// DERELICTS.
//
// Elimination is "no live settlements", which a faction can hit while
// still holding a Weapons Station, a gate network and a Null Field.
// Nothing touched them, so a dead player's guns kept firing on everyone
// with no owner left to negotiate with.
describe('structures go derelict when their faction dies', () => {
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );
  const acts = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );
  const workerMega = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/megastructures.js'), 'utf8',
  );

  it('the tick abandons them', () => {
    expect(room).toMatch(/async abandonDeadFactionStructures/);
    expect(room).toMatch(/await this\.abandonDeadFactionStructures\(gameId, tick\)/);
    const i = room.indexOf('async abandonDeadFactionStructures');
    const body = room.slice(i, room.indexOf('\n  /**', i + 1));
    expect(body).toMatch(/f\.status = 'eliminated'/);
    // Ownership to NULL is what silences the guns: every effect pass
    // already asks who owns the thing before firing.
    expect(body).toMatch(/UPDATE game_bodies SET owner_faction_id = NULL/);
    // A dead empire's sink must stop choosing who gets through.
    expect(body).toMatch(/settings_json = NULL/);
  });

  it('an ancient gate is NOT claimable', () => {
    // Ancients are unowned too. One faction holding the map's only
    // permanent crossing would be a different game, so the two are told
    // apart on history rather than on a missing owner.
    const i = workerMega.indexOf('export function isAbandoned');
    const body = workerMega.slice(i, workerMega.indexOf('\n}', i));
    expect(body).toMatch(/abandoned_at_tick != null/);
    expect(body).toMatch(/founded_by_faction_id != null/);
  });

  it('claiming needs presence, not force', () => {
    const i = acts.indexOf('async function handleClaimSite');
    const body = acts.slice(i, acts.indexOf('\n}\n', i));
    // Any hull, parked. No breach check and no armed-hull check —
    // there is nobody to fight.
    expect(body).toMatch(/parent_body_id = \? AND owner_faction_id = \?/);
    expect(body).not.toMatch(/isBreached/);
    expect(body).not.toMatch(/NOT IN \('freighter', 'colony'\)/);
    // ...and it refuses a hull that merely launched from here.
    expect(body).toMatch(/mid-burn/);
  });

  it('a claimed derelict stops reading as derelict', () => {
    const i = acts.indexOf('async function handleClaimSite');
    const body = acts.slice(i, acts.indexOf('\n}\n', i));
    expect(body).toMatch(/abandoned_at_tick = NULL/);
  });

  it('both events are readable', () => {
    const provider = fs.readFileSync(
      path.resolve(__dirname, '../../', 'multiplayer/MultiplayerGameProvider.tsx'), 'utf8',
    );
    expect(provider).toMatch(/megastructure_abandoned/);
    expect(provider).toMatch(/megastructure_claimed/);
  });
});

// ---------------------------------------------------------------------
// A SOLD HULL ARRIVES CLEAN.
//
// Found reviewing the feat/real-physics merge. Asset deals were written
// before prod's branch added a family of per-ship order columns, and a
// transfer only cleared the three that existed at the time. Everything
// added since would have ridden along to the buyer.
//
// The armed charges are the reason this is a security bug and not an
// untidiness: detonate_at_tick is a TIMED self-destruct, arrival_action
// can be 'detonate', and detonate_hp_pct / detonate_on_hostile /
// detonate_at_guard are dead-man switches. A seller could arm a hull,
// sell it, take the freight, and watch it go off in the buyer's fleet.
describe('selling a ship hands over a clean hull', () => {
  const deals = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/assetDeals.js'), 'utf8',
  );
  const transfer = (() => {
    const i = deals.indexOf("deal.asset_kind === 'ship'");
    return deals.slice(i, deals.indexOf('.bind(deal.buyer_faction_id', i));
  })();

  it('clears the NOT NULL charges to their default, not to NULL', () => {
    // detonate_on_hostile and fleet_detached are NOT NULL DEFAULT 0.
    // Nulling them fails the constraint and takes the WHOLE transfer
    // batch with it — the sale then cannot complete at all, which is
    // how this was caught: a live sale returned a D1 NOT NULL error
    // instead of handing over the hull.
    expect(transfer).toMatch(/detonate_on_hostile = 0/);
    expect(transfer).toMatch(/fleet_detached = 0/);
  });

  it.each([
    'detonate_at_tick',      // timed self-destruct
    'detonate_hp_pct',       // dead-man switch
    'detonate_at_guard',
    'detonate_mine_mode',
    'arrival_action',        // can be 'detonate'
    'arrival_guard',
  ])('clears the armed charge %s', (col) => {
    expect(transfer).toMatch(new RegExp(`${col} = NULL`));
  });

  it.each([
    'target_priority', 'mining_body_id', 'stance', 'retreat_hp_pct',
    'refit_pending_design_id', 'strike_target_body_id', 'strike_ready_tick',
  ])('clears the standing order %s', (col) => {
    expect(transfer).toMatch(new RegExp(`${col} = NULL`));
  });

  it('leaves the fleet behind, flag and all', () => {
    // fleet_detached must go with fleet_id: a hull carrying the detached
    // flag into a NEW fleet sits out its moves and looks broken for
    // reasons the buyer cannot see.
    expect(transfer).toMatch(/fleet_id = NULL/);
    expect(transfer).toMatch(/fleet_detached = 0/);
  });

  it('covers every order column the ships table has', () => {
    // THE POINT OF THIS TEST. A new per-ship order column added by any
    // branch must be added here too, or it silently rides along with the
    // next sale. Listed explicitly so adding one to the schema and not
    // to the transfer fails loudly.
    const ORDER_COLUMNS = [
      'fleet_id', 'fleet_detached', 'target_priority', 'mining_body_id',
      'stance', 'retreat_hp_pct', 'refit_pending_design_id',
      'strike_target_body_id', 'strike_ready_tick', 'arrival_action',
      'arrival_guard', 'detonate_hp_pct', 'detonate_at_tick',
      'detonate_at_guard', 'detonate_on_hostile', 'detonate_mine_mode',
      'captain_id',
    ];
    const missing = ORDER_COLUMNS.filter(c => !transfer.includes(c));
    expect(missing).toEqual([]);
  });

  // THE OFFICER IS NOT CARGO.
  //
  // game_captains links both ways — it has its own ship_id — so a
  // one-sided clear leaves the seller's named officer listed as
  // commanding a hull that now belongs to a rival, and unassignable on
  // the seller's roster because they are "already on a ship". The code
  // comment claimed this was handled well before the code did it.
  it('releases the captain on BOTH sides of the link', () => {
    expect(transfer).toMatch(/captain_id = NULL/);
    expect(deals).toMatch(
      /UPDATE game_captains SET ship_id = NULL WHERE game_id = \? AND ship_id = \?/,
    );
  });

  it('leaves the captain in the bank rather than benched', () => {
    // benched_at_tick records a PLAYER decision to hold someone in
    // reserve. A sale is not that decision, so the release must not
    // stamp it — same resting state bankMemberCaptains uses.
    const crew = deals.slice(deals.indexOf('const crew ='), deals.indexOf('await env.DB.batch'));
    expect(crew).not.toMatch(/benched_at_tick/);
  });

  it('does not strip a captain when the asset is a settlement', () => {
    // The crew statement is ship-only. Running it for a settlement sale
    // would match nothing today, but the guard is cheap and the failure
    // would be silent.
    expect(deals).toMatch(/const crew = deal\.asset_kind === 'ship'/);
  });
});

// ---------------------------------------------------------------------
// FULL-REGRESSION FINDINGS (2026-08-25 staging sweep). Two holes, both
// of the same species: an action the game accepts and then silently
// undoes or ignores, so the player never learns the rule.
describe('regression: orders and captures that silently do nothing', () => {
  const actions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8',
  );

  // A corvette with detonate_hp_pct=50 fought from full health to 10%
  // and never blew: every detonation path resolves through
  // detonateShip, which no-ops on a hull with no Detonator part.
  it('refuses to ARM a detonation order on a hull with no detonator', () => {
    expect(actions).toMatch(/no_detonator/);
    // All four arming paths are covered by the same guard…
    const guard = actions.slice(
      actions.indexOf('const arming ='), actions.indexOf("'no_detonator'"));
    for (const path of [
      'detonate_hp_pct', 'detonate_at_tick',
      'detonate_on_hostile', "arrival_action === 'detonate'",
    ]) expect(guard).toContain(path);
    // …and clearing back to null must stay allowed — the guard tests
    // non-null/true values only, so a hull that lost its detonator can
    // still be disarmed.
    expect(guard).toMatch(/detonate_hp_pct !== null/);
  });

  // An eliminated faction seized a station; abandonDeadFactionStructures
  // re-derelicted it on the NEXT tick. The button worked, the prize
  // evaporated, nothing said why.
  it('refuses seize and claim for an eliminated faction', () => {
    const count = (actions.match(
      /me\.status === 'eliminated'/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);   // seize + claim
    // The guard can only work if requireMyFaction actually SELECTs
    // status — it did not, before this fix.
    expect(actions).toContain('SELECT id, slot, status');
  });
});

// ---------------------------------------------------------------------
// DETONATOR MATH (clownking's report, 2026-08-25): tooltip promised
// 1391, the blast dealt 892, and the copy said 50% after the constant
// moved to 25%. Three mirrors have to agree for the promise to equal
// the payout: the fraction, the copy, and the HP BASE the damage is
// priced off.
describe('detonator damage: the promise equals the payout', () => {
  const clientParts = fs.readFileSync(
    path.resolve(__dirname, '..', 'shipParts.ts'), 'utf8');
  const workerDesigns = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/shipDesigns.js'), 'utf8');
  const workerActions = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8');
  const workerRoom = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8');
  const workerEff = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/effectiveHp.js'), 'utf8');
  const workerState = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/state.js'), 'utf8');

  const fracOf = (src: string) => {
    const m = src.match(/DETONATOR_HP_FRAC\s*=\s*([\d.]+)/);
    return m ? Number(m[1]) : NaN;
  };

  it('client and worker agree on the blast fraction', () => {
    expect(fracOf(clientParts)).toBe(fracOf(workerDesigns));
    expect(fracOf(clientParts)).toBeGreaterThan(0);
  });

  it('the disclosure copy DERIVES its percentage from the constant', () => {
    // "50% of max HP" sat in the string for a full release after the
    // constant was halved. No literal percent belongs in this copy.
    expect(clientParts).not.toMatch(/\d+% of max HP per detonator/);
    expect(clientParts).toMatch(/DETONATOR_HP_FRAC \* 100/);
  });

  it('both server detonation sites price the blast off the EFFECTIVE ceiling', () => {
    // actions.js (manual trigger) and room.js detonateShip (all four
    // tick-pass paths) must feed effectiveHpMaxOf, not stored hp_max.
    expect(workerActions).toMatch(/effectiveHpMaxOf\(env\.DB, gameId, shipId\)/);
    expect(workerRoom).toMatch(/effectiveHpMaxOf\(this\.env\.DB, gameId, ship\.id\)/);
    for (const src of [workerActions, workerRoom]) {
      expect(src).not.toMatch(/detonatorDamage\(ship\.hp_max/);
      // Survivors carry the damage stamp on BOTH paths — the manual
      // endpoint used to skip it, so its blasts were invisible to the
      // client's damage FX and the battle recorder.
      expect(src).toMatch(/SET hp = \?, last_damaged_tick = \? WHERE id = \?/);
    }
  });

  it('effectiveHp.js mirrors the /state ceiling factor for factor', () => {
    // Same constants in both, or a hull's blast stops matching its own
    // health bar: rank +1%/lvl, armor/shields +8%/lvl, Bulwark 1.10,
    // fleet aura halved.
    for (const src of [workerEff, workerState]) {
      expect(src).toMatch(/0\.01 \* Math\.max\(0, /);
      expect(src).toMatch(/1 \+ 0\.08 \* Math\.max\(/);
      expect(src).toContain('1.10');
      expect(src).toMatch(/\(1\.10 - 1\) \/ 2/);
    }
    // Veterancy is CAPTAIN-ONLY: both must read the captain's rank
    // (COALESCE), never the legacy hull column. Caught live: the
    // helper's first draft read s.rank and priced a blast off rank 5
    // while /state served the same hull as rank 0.
    expect(workerEff).toMatch(/COALESCE\(c\.rank, 0\)/);
    expect(workerState).toMatch(/COALESCE\(c\.rank, 0\)/);
  });
});
