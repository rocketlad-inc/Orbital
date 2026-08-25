// MIGRATION NUMBERS MUST BE UNIQUE.
//
// This project has been bitten twice. A duplicate 0089 once took
// production down, and a duplicate 0115 left game_megastructures without
// its abandoned_at_tick column on staging while three files — including
// a per-tick pass — queried it.
//
// The applier keys on the FILENAME, so a collision does not fail loudly.
// Two files simply race for the same slot in a sorted list and one of
// them can end up unapplied, with the only symptom a column that is not
// there. That is the worst shape a bug can have: silent, schema-level,
// and discovered by a query throwing in production.
//
// A four-line test is the whole fix.

import fs from 'fs';
import path from 'path';

const DIR = path.resolve(__dirname, '../../..', 'migrations');

describe('migration numbering', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every file starts with a four-digit number', () => {
    for (const f of files) expect(f).toMatch(/^\d{4}_/);
  });

  // NINE COLLISIONS ALREADY EXIST, inherited. They are listed rather
  // than renamed because renaming an applied migration re-runs it under
  // a new name on every live database, and the value of tidying history
  // does not come close to the risk of that.
  //
  // 0089 is the pair that once took production down. The applier keys on
  // the FILENAME, so both halves of a collision do get applied — what is
  // ambiguous is their ORDER, which alphabetical sorting decides and
  // nobody chose. Two migrations that touch the same table and disagree
  // about which runs first is the whole bug.
  const KNOWN_COLLISIONS = new Set([
    '0033', '0034', '0054', '0062', '0088', '0089', '0090', '0098', '0100',
  ]);

  it('no NEW migration reuses a number', () => {
    const seen = new Map<string, string>();
    const fresh: string[] = [];
    for (const f of files) {
      const n = f.slice(0, 4);
      const prev = seen.get(n);
      if (prev) {
        if (!KNOWN_COLLISIONS.has(n)) fresh.push(`${n}: ${prev} and ${f}`);
      } else {
        seen.set(n, f);
      }
    }
    expect(fresh).toEqual([]);
  });

  it('the inherited collisions have not grown', () => {
    // If a legacy number stops colliding it should leave the list, and
    // if the list stops matching reality this test is lying.
    const counts = new Map<string, number>();
    for (const f of files) {
      const n = f.slice(0, 4);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const n of KNOWN_COLLISIONS) {
      expect({ n, count: counts.get(n) ?? 0 }).toEqual({ n, count: 2 });
    }
  });
});
