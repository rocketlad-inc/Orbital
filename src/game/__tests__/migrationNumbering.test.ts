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

  // COLLISIONS ARE LISTED RATHER THAN RENAMED, because renaming an
  // applied migration re-runs it under a new name on every live
  // database, and the value of tidying history does not come close to
  // the risk of that.
  //
  // WHAT A COLLISION DOES AND DOES NOT DO. Both halves are applied:
  // scripts/bundle-migrations.js maps every file 1:1 by filename, and
  // worker/index.js keys the _migrations ledger on `name TEXT PRIMARY
  // KEY`. You can see both halves of the 0089 pair sitting in the
  // generated bundle today. So a duplicate number cannot cause a
  // migration to be SKIPPED.
  //
  // What it does cost is ORDER. Alphabetical sorting decides which half
  // runs first and nobody chose it, so two migrations that touch the
  // same table and disagree about sequence is the real hazard — which
  // is what 0089 was.
  //
  // 0104-0113 arrived as a BLOCK when feat/real-physics merged into
  // dev. Two long-lived branches each numbered forward from 0103, which
  // is not a mistake anyone made — it is what a merge of two release
  // lines produces. Each pair is safe on the ordering test above:
  // prod's half touches match/build/mine tables, the megastructure half
  // touches only game_megastructures, which its own 0104 creates.
  const KNOWN_COLLISIONS = new Set([
    '0033', '0034', '0054', '0062', '0088', '0089', '0090', '0098', '0100',
    // the feat/real-physics <- dev merge
    '0104', '0105', '0106', '0107', '0108', '0109', '0110', '0111', '0112', '0113',
    // 0114 -- asset_deals and name_pools, written by two agents against
    // the same head within a day. Listed rather than renamed for the
    // reason above: both halves are already applied on prod (checked in
    // the _migrations ledger), so a rename would re-run one of them and
    // fail on a column that already exists. Order-safe either way --
    // asset_deals CREATEs a table of its own, name_pools ALTERs two it
    // never touches.
    '0114',
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

  // 0113 is the one THREE-way collision: feat/real-physics landed two
  // files on it (fleet_cohesion, match_shares) before dev added a third.
  // Recorded rather than smoothed over, because a number carrying three
  // files is worth seeing in a list.
  const EXPECTED_COUNT: Record<string, number> = { '0113': 3 };

  it('the inherited collisions have not grown', () => {
    // If a legacy number stops colliding it should leave the list, and
    // if the list stops matching reality this test is lying.
    const counts = new Map<string, number>();
    for (const f of files) {
      const n = f.slice(0, 4);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const n of KNOWN_COLLISIONS) {
      const want = EXPECTED_COUNT[n] ?? 2;
      expect({ n, count: counts.get(n) ?? 0 }).toEqual({ n, count: want });
    }
  });
});
