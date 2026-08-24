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
