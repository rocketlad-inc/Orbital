// THE CLIENT BODY CATALOG IS A HAND-MAINTAINED MIRROR, AND IT DRIFTED.
//
// src/state/mockGameState.ts copies worker/factions.js BODY_CATALOG so the
// lobby backdrop can draw the solar system with no server data. CRA refuses
// imports from outside src/, so the copy cannot be replaced by an import —
// which means the only thing standing between it and rot is a test.
//
// It rotted. The fifteen Kuiper bodies added in 2026-09 never arrived, and
// when the shell was spread and split at the Kuiper cliff, Haumea, Quaoar,
// Makemake and Eris kept their pre-spread orbits. Nineteen bodies wrong or
// absent, in the map players look at while choosing where to start, and
// nothing said a word.
//
// Compared against the SOURCE TEXT of factions.js rather than its module,
// because the module applies SYSTEM_SCALE at load and the mirror holds
// pre-scale values — reading the literals means no scaling arithmetic here
// to get wrong in its own right.

import fs from 'fs';
import path from 'path';
import { SHARED_BODIES } from '../mockGameState';

const catalogSrc = fs.readFileSync(
  path.resolve(__dirname, '../../..', 'worker/factions.js'), 'utf8',
);

/** id -> { radius, period } as literally written in the catalogue. A
 *  period given as an expression (moons use TWO_PI * sqrt(...)) comes
 *  back null and is skipped: the point is the orbits, not the algebra. */
function catalogEntries(): Map<string, { r: number; t: number | null }> {
  const out = new Map<string, { r: number; t: number | null }>();
  const re = /\{\s*id:\s*'([a-z0-9_]+)'[\s\S]{0,400}?orbit_radius:\s*([\d.]+),\s*orbit_period:\s*([^,\n]+),/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(catalogSrc)) !== null) {
    const t = /^[\d.]+$/.test(m[3].trim()) ? Number(m[3]) : null;
    if (!out.has(m[1])) out.set(m[1], { r: Number(m[2]), t });
  }
  return out;
}

describe('mockGameState mirrors the server body catalogue', () => {
  const cat = catalogEntries();
  const mirror = new Map(SHARED_BODIES.map(b => [b.id, b]));

  it('parses a catalogue worth checking against', () => {
    // Guards the regex itself: a mirror test that silently matches
    // nothing is worse than no test, because it reads as green.
    expect(cat.size).toBeGreaterThan(40);
    expect(cat.get('earth')).toBeTruthy();
    expect(cat.get('sedna')).toBeTruthy();
  });

  it('every body it claims to have sits where the catalogue puts it', () => {
    const wrong: string[] = [];
    for (const [id, b] of mirror) {
      const c = cat.get(id);
      if (!c) continue;                       // client-only (binary/black-hole demo maps)
      if (Math.abs((b.orbitRadius ?? 0) - c.r) > 0.51) {
        wrong.push(`${id} radius ${b.orbitRadius} != ${c.r}`);
      }
      if (c.t != null && Math.abs((b.orbitPeriod ?? 0) - c.t) > 1) {
        wrong.push(`${id} period ${b.orbitPeriod} != ${c.t}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('carries the whole outer shell, moons included', () => {
    // The exact omission: the lobby drew an outer system that stopped
    // at Pluto while the game ran one that reached Sedna.
    const SHELL = [
      'pluto', 'charon', 'orcus', 'vanth', 'ixion', 'mani',
      'salacia', 'actaea', 'varuna', 'haumea', 'hiiaka', 'namaka',
      'quaoar', 'weywot', 'varda', 'ilmare', 'makemake', 'mk2',
      'aya', 'eris', 'dysnomia', 'sedna',
    ];
    expect(SHELL.filter(id => !mirror.has(id))).toEqual([]);
  });

  it('keeps the shell in true distance order, like the catalogue', () => {
    const order = ['pluto', 'ixion', 'mani', 'salacia', 'varuna', 'haumea',
      'quaoar', 'makemake', 'varda', 'aya', 'eris', 'sedna'];
    const radii = order.map(id => mirror.get(id)!.orbitRadius ?? 0);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]);
    }
  });
});
