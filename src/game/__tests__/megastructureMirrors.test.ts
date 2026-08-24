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
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS, progressOf, remainingFor, loadsRemaining } from '../megastructures';
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
