// PROSE MUST NOT HARD-CODE A TECH'S POSITION.
//
// Four surfaces told the player where to find a tech by spelling the
// track and level into a string: three trade surfaces said "Convoy
// Logistics (Society 7)" / "Trade Armadas (Society 8)", and the ship
// panel said "Deep Scan (Sensors 5)".
//
// Every one of those was correct when written, which is exactly why it
// is dangerous. Moving the convoy rows to Propulsion 4/5 turned all
// three trade strings into directions to a column that no longer held
// the tech — and nothing failed, because a string is not a reference.
// Advice that sends a player to the wrong track is worse than silence:
// they go look, find nothing, and stop trusting the hint.
//
// requirementLabel() reads the position out of RESEARCH_UNLOCKS at
// render time. This test is the other half — it stops the next person
// from typing the position back in.

import fs from 'fs';
import path from 'path';
import { requirementLabel, requirementFor, RESEARCH_UNLOCKS } from '../researchUnlocks';
import { TECH_DEFS, ALL_TECH_IDS } from '../techs';

const SRC = path.resolve(__dirname, '../..');

/** Every .ts/.tsx under src/, tests excluded. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') sources(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Comments removed, so only what ships to the player is searched.
 *  Over-stripping is safe here: this asserts an ABSENCE, so the worst a
 *  greedy strip can do is miss a hit, never invent one. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('requirementLabel', () => {
  it('names the track as the PLAYER sees it, not by its id', () => {
    // The trap this exists for: the track id is 'industry' but every
    // screen calls it SOCIETY, so a player told to advance "Industry"
    // goes looking for a track that is not on the board.
    expect(TECH_DEFS.industry.name).toBe('Society');
    const label = requirementLabel('part.mining');
    expect(label).toContain('Society');
    expect(label).not.toContain('industry');
  });

  it('reads position out of the table rather than a copy of it', () => {
    for (const u of RESEARCH_UNLOCKS) {
      const req = requirementFor(u.feature)!;
      expect(requirementLabel(u.feature))
        .toBe(`${req.label} (${TECH_DEFS[req.track].name} ${req.level})`);
    }
  });

  it('returns null for something that was never gated', () => {
    expect(requirementLabel('nonsense' as never)).toBeNull();
  });

  it('follows a tech when it moves track', () => {
    // Convoys were Society 7/8 and are Propulsion 4/5. Asserting the
    // CURRENT table rather than a literal keeps this true after the
    // next move, while still proving the label is derived.
    const convoy = requirementFor('trade.convoy2')!;
    expect(requirementLabel('trade.convoy2'))
      .toBe(`Convoy Logistics (${TECH_DEFS[convoy.track].name} ${convoy.level})`);
  });
});

describe('no shipped string hard-codes a track and level', () => {
  const files = sources(SRC);
  const names = ALL_TECH_IDS.map(id => TECH_DEFS[id].name);
  // "(Society 7)", "(Sensors 5)" — the shape these hints always took.
  const hardcoded = new RegExp(`\\((?:${names.join('|')})\\s+\\d+\\)`, 'g');

  it('found the source tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(names)('%s', (track) => {
    const re = new RegExp(`\\(${track}\\s+\\d+\\)`);
    const offenders = files
      .filter(f => re.test(codeOnly(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(SRC, f));
    // If this fails: replace the literal with requirementLabel(feature).
    expect(offenders).toEqual([]);
  });

  it('reports every offender at once, so a sweep is one pass', () => {
    const all: string[] = [];
    for (const f of files) {
      for (const m of codeOnly(fs.readFileSync(f, 'utf8')).matchAll(hardcoded)) {
        all.push(`${path.relative(SRC, f)}: ${m[0]}`);
      }
    }
    expect(all).toEqual([]);
  });
});
