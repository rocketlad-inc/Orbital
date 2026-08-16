// A DECLARED GATE THAT NOTHING CONSULTS IS NOT A GATE.
//
// RESEARCH_UNLOCKS listed the Mining Rig at Industry 7, with a blurb
// explaining that a mining economy should cost commitments on more than
// one track. PART_FEATURE — the map the designer and the server's
// requireParts actually read — had no 'mining' key. So the rig was free
// from turn one, in games with research gating switched ON, while the
// research screen advertised a requirement that never fired.
//
// Nothing could catch that by inspection: the unlock row looked right,
// the part definition looked right, and both halves were individually
// correct. Only the JOIN between them was missing.
//
// This is the same failure as buildMenuReach, one layer over: a thing is
// defined, costed and described, and then never wired to the table that
// gives it effect.

import fs from 'fs';
import path from 'path';
import { RESEARCH_UNLOCKS, PART_FEATURE } from '../researchUnlocks';
import { ALL_PART_IDS, SHIP_PART_DEFS } from '../shipParts';

describe('every declared part unlock is actually wired', () => {
  const partUnlocks = RESEARCH_UNLOCKS.filter(u => String(u.feature).startsWith('part.'));

  it('there is at least one, or this test is vacuous', () => {
    expect(partUnlocks.length).toBeGreaterThan(0);
  });

  it.each(partUnlocks.map(u => [String(u.feature), u] as const))(
    '%s is reachable through PART_FEATURE',
    (feature) => {
      const wired = Object.values(PART_FEATURE).includes(feature as never);
      expect(wired).toBe(true);
    },
  );

  it('PART_FEATURE names only real parts', () => {
    for (const partId of Object.keys(PART_FEATURE)) {
      expect(ALL_PART_IDS).toContain(partId);
      expect(SHIP_PART_DEFS[partId as keyof typeof SHIP_PART_DEFS]).toBeDefined();
    }
  });
});

describe('the server agrees about which parts are gated', () => {
  // A gate the client shows and the server ignores is a lie in the
  // other direction: the button greys out, and a crafted POST still
  // saves the design.
  const serverSrc = fs.readFileSync(
    path.resolve(__dirname, '../../../worker/researchUnlocks.js'), 'utf8',
  );
  const block = /export const PART_FEATURE = \{([\s\S]*?)\};/.exec(serverSrc);

  it('the server exposes a PART_FEATURE map', () => {
    expect(block).toBeTruthy();
  });

  it.each(Object.keys(PART_FEATURE))('server gates %s too', (partId) => {
    expect(block![1]).toMatch(new RegExp(`\\b${partId}\\s*:`));
  });
});
