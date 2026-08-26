// EVERY PUBLIC CHRONICLE KIND HAS TO REACH THE PAPER.
//
// The Herald fetches every public row in its window and hands the whole
// list to each story builder. A kind no builder claims is discarded
// without a word — no error, no log line, no gap in the output. So the
// failure mode of forgetting one is a newspaper that simply never
// mentions a feature, for as long as nobody thinks to check.
//
// Nine had accumulated that way: asteroid_launched, gate_transit,
// gate_link_severed, senate_reaped, trade_shipment_lost, asset_sold and
// the three megastructure lifecycle kinds. All logged, all fetched, none
// ever printed.
//
// This test reads the worker's own INSERT statements and requires each
// public kind to be claimed. It only sees inserts that spell the kind as
// a literal inside VALUES, which is how every current call site is
// written; a future one that binds the kind as a parameter would slip
// past, so the registry is still worth reading by eye.

import fs from 'fs';
import path from 'path';

// jsdom has no TextEncoder and worker/auth.js builds one at module load.
/* eslint-disable @typescript-eslint/no-var-requires */
(global as unknown as { TextEncoder: unknown }).TextEncoder = require('util').TextEncoder;
const { HERALD_HANDLED_KINDS } = require('../../../worker/digest.js');

const WORKER = path.resolve(__dirname, '../../..', 'worker');

/** Kinds written with visibility 'public', by source file. */
function publicKindsEmitted(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of fs.readdirSync(WORKER)) {
    if (!file.endsWith('.js') || file.startsWith('_') || file === 'digest.js') continue;
    const src = fs.readFileSync(path.join(WORKER, file), 'utf8');
    for (const m of src.matchAll(/INSERT (?:OR IGNORE )?INTO chronicle_entries[\s\S]{0,700}?VALUES\s*\(([^)]*)\)/g)) {
      const values = m[1];
      if (!values.includes("'public'")) continue;      // faction-scoped: never in the digest
      // The kind is the first literal in the tuple that is not the
      // visibility column itself.
      const literals = [...values.matchAll(/'([a-z][a-z0-9_]{3,40})'/g)]
        .map(x => x[1])
        .filter(x => x !== 'public');
      if (literals.length === 0) continue;             // kind is bound, not spelled
      const kind = literals[0];
      const list = found.get(kind) ?? [];
      if (!list.includes(file)) list.push(file);
      found.set(kind, list);
    }
  }
  return found;
}

describe('Herald coverage', () => {
  const emitted = publicKindsEmitted();

  it('finds the public chronicle inserts at all', () => {
    // A guard on the guard: if the scan silently stops matching, this
    // suite would pass while checking nothing.
    expect(emitted.size).toBeGreaterThan(15);
    expect([...emitted.keys()]).toContain('ship_destroyed');
  });

  it('claims every public kind the worker writes', () => {
    const unclaimed = [...emitted.entries()]
      .filter(([kind]) => !HERALD_HANDLED_KINDS.has(kind))
      .map(([kind, files]) => `${kind} (${files.join(', ')})`);
    expect(unclaimed).toEqual([]);
  });

  it('claims the nine that used to fall through', () => {
    for (const kind of [
      'asteroid_launched', 'gate_transit', 'gate_link_severed', 'senate_reaped',
      'trade_shipment_lost', 'asset_sold',
      'megastructure_complete', 'megastructure_claimed', 'megastructure_abandoned',
    ]) {
      expect(HERALD_HANDLED_KINDS.has(kind)).toBe(true);
    }
  });

  // The registry is hand-maintained, so it can drift the other way too:
  // a handler kept for a kind nothing writes any more is dead weight the
  // next reader has to disprove.
  it('lists nothing the worker never writes', () => {
    const src = fs.readdirSync(WORKER)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .map(f => fs.readFileSync(path.join(WORKER, f), 'utf8'))
      .join('\n');
    const orphans = [...HERALD_HANDLED_KINDS].filter(k => !src.includes(`'${k}'`));
    expect(orphans).toEqual([]);
  });
});
