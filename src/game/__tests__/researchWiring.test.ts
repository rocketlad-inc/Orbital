// A DECLARED GATE THAT NOTHING CONSULTS IS NOT A GATE.
//
// RESEARCH_UNLOCKS is a catalogue of requirements. It gates nothing by
// itself: the *_FEATURE maps are what the designer, the build menu and
// the server's requireParts/requireBuilding actually read. An unlock
// with no map entry is a requirement the research screen advertises and
// nothing enforces.
//
// This has now happened twice, to two different things I shipped in one
// day:
//   part.mining        declared at Industry 7,     wired nowhere
//   building.telescope declared at Construction 7, wired nowhere
//
// Both were free from turn one in games with gating switched ON. Neither
// could be caught by inspection: the unlock row looked right, the
// definition looked right, both halves were individually correct, and
// only the JOIN between them was missing. The client's own BUILDING_FEATURE
// carries a comment warning about exactly this, and it happened anyway —
// which is the argument for a test rather than a comment.
//
// The reverse direction matters too: a gate the client shows and the
// server ignores is a lie the other way (the button greys out, a crafted
// POST still succeeds), so the two maps must name the same set.

import fs from 'fs';
import path from 'path';
import {
  RESEARCH_UNLOCKS, PART_FEATURE, HULL_FEATURE, BUILDING_FEATURE,
} from '../researchUnlocks';
import { SHIP_PART_DEFS, ALL_PART_IDS } from '../shipParts';

const serverSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../worker/researchUnlocks.js'), 'utf8',
);

/** Pull `export const NAME = { ... }` out of the server module. */
function serverMap(name: string): Record<string, string> {
  const i = serverSrc.indexOf(`export const ${name}`);
  expect(i).toBeGreaterThan(-1);
  const body = serverSrc.slice(i, serverSrc.indexOf('};', i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(\w+):\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
}

const CLIENT_MAPS: [string, Record<string, string | undefined>][] = [
  ['PART_FEATURE', PART_FEATURE],
  ['HULL_FEATURE', HULL_FEATURE],
  ['BUILDING_FEATURE', BUILDING_FEATURE],
];

/** Features that gate a buildable THING (as opposed to a passive perk
 *  like damageControl or transferLanes, which have no catalogue entry). */
const GATEABLE = /^(part|hull|building)\./;

describe('every declared unlock is wired to something that enforces it', () => {
  const declared = RESEARCH_UNLOCKS
    .map(u => String(u.feature))
    .filter(f => GATEABLE.test(f));

  const wired = new Set<string>();
  for (const [, map] of CLIENT_MAPS) {
    for (const v of Object.values(map)) if (v) wired.add(v);
  }

  it('there are gateable unlocks, or this test is vacuous', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)('%s is reachable through a FEATURE map', (feature) => {
    expect(wired.has(feature)).toBe(true);
  });
});

describe('the maps name only things that exist', () => {
  // Folded in from the retired partGates.test.ts: a FEATURE map entry
  // for a part that no longer exists is a gate on nothing, and hides a
  // rename that was only half done.
  it('PART_FEATURE names only real parts', () => {
    for (const partId of Object.keys(PART_FEATURE)) {
      expect(ALL_PART_IDS).toContain(partId);
      expect(SHIP_PART_DEFS[partId as keyof typeof SHIP_PART_DEFS]).toBeDefined();
    }
  });
});

describe('client and server agree on which things are gated', () => {
  it.each(CLIENT_MAPS.map(([n]) => n))('%s names the same set on both sides', (name) => {
    const srv = serverMap(name);
    const cli = CLIENT_MAPS.find(([n]) => n === name)![1];

    for (const [key, feature] of Object.entries(cli)) {
      if (!feature) continue;
      // A gate the CLIENT enforces must exist on the server, or the
      // button greys out while a crafted POST sails through.
      expect(`${name}.${key} on the server`).toBe(
        srv[key] ? `${name}.${key} on the server` : `MISSING (client says ${feature})`,
      );
      expect(srv[key]).toBe(feature);
    }
  });

  it('BUILDING_FEATURE: server-only keys are real BuildingKinds or documented', () => {
    // The server carries `armor: 'building.armor'`, which is vestigial —
    // 'armor' is a research TRACK, not a BuildingKind. The client omits
    // it deliberately and says so. Anything ELSE server-only would be a
    // building the client never locks.
    const srv = serverMap('BUILDING_FEATURE');
    const clientKeys = new Set(Object.keys(BUILDING_FEATURE));
    const KNOWN_VESTIGIAL = new Set(['armor']);
    for (const key of Object.keys(srv)) {
      if (clientKeys.has(key) || KNOWN_VESTIGIAL.has(key)) continue;
      throw new Error(
        `server gates building '${key}' but the client does not — the build `
        + 'button would render enabled and the server would refuse it',
      );
    }
  });
});

// ---------------------------------------------------------------
// AND THE REQUIREMENT ITSELF MUST EXIST ON THE SERVER.
//
// Wiring the FEATURE map is only half of it. hasFeature reads a second
// table — REQUIREMENTS — and treats an unknown feature as UNLOCKED:
//
//     const req = REQUIREMENTS[feature];
//     if (!req) return true;
//
// So a feature that is mapped but has no requirement row gates NOTHING
// on the server, while the client (which derives its requirements from
// its own RESEARCH_UNLOCKS) happily draws a lock. Client says no, server
// says yes, and the only way to notice is to try it.
//
// That is exactly what shipped this morning: part.mining and
// building.telescope were added to the maps and never to REQUIREMENTS.
// The earlier version of this file compared the two FEATURE maps and
// passed, because both maps agreed — the missing table was one level
// further down. Found by driving the API as a zero-research faction.
// ---------------------------------------------------------------
describe('every client unlock has a server requirement', () => {
  const i = serverSrc.indexOf('export const REQUIREMENTS');
  const block = serverSrc.slice(i, serverSrc.indexOf('\n};', i));
  const srv: Record<string, { track: string; level: number }> = {};
  for (const m of block.matchAll(/'([\w.]+)':\s*\{\s*track:\s*'(\w+)',\s*level:\s*(\d+)/g)) {
    srv[m[1]] = { track: m[2], level: Number(m[3]) };
  }

  it('parsed the server requirements table', () => {
    expect(Object.keys(srv).length).toBeGreaterThan(20);
  });

  it.each(RESEARCH_UNLOCKS.map(u => [String(u.feature), u.track, u.level] as const))(
    '%s exists server-side at the same track and level',
    (feature, track, level) => {
      // A missing row is not a smaller version of a wrong row — it is
      // silently ungated, which is worse than a mismatch.
      expect(srv[feature] ? feature : `${feature} MISSING from server REQUIREMENTS`).toBe(feature);
      expect(srv[feature]).toEqual({ track, level });
    },
  );
});
