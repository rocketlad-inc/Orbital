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
  MEGA_STRIKE_CHARGE_TICKS } from '../megastructures';
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
    // The check lives in the `destBody.type === 'megastructure'` branch
    // of the route validator, which is a route handler rather than its
    // own function — so this reads the branch directly.
    const i = actions.indexOf("if (destBody.type === 'megastructure')");
    expect(i).toBeGreaterThan(-1);
    const branch = actions.slice(i, actions.indexOf("routeKind = 'megastructure'", i));
    expect(branch).toMatch(/destBody\.owner_faction_id !== me\.id/);
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
    expect(MEGA_MAX_HP).toBe(200);
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
    // It must read the owner AND compare it to the route's faction.
    expect(block).toMatch(/b\.owner_faction_id/);
    expect(block).toMatch(/siteHere\.owner_faction_id !== r\.owner_faction_id/);
    // Stalled, not cancelled — the itinerary is fine again the moment
    // the site is taken back.
    expect(block).toMatch(/status = 'stalled'/);
  });

  it('the V2 validator agrees with the creation endpoint', () => {
    expect(v2).toMatch(/site\.owner_faction_id !== factionId/);
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
