// EVERY BODY REFERENCE CROSSING THE WIRE MUST BE STRIPPED.
//
// Server body ids are namespaced "<gameId>:<localId>". The provider maps
// bodies to their LOCAL half — `body.id` is "mtr_belt_3", not
// "g7:mtr_belt_3" — so any other field that points at a body has to be
// stripped too, or comparисons against `body.id` silently never match.
//
// That is exactly what happened to manual mining: `mining_body_id` was
// copied through raw, so `ship.miningBodyId === rock.id` compared
// "g7:mtr_belt_3" with "mtr_belt_3" and was false forever. The server was
// mining correctly and the hold was visibly filling, while both the ship
// panel and the rock card kept offering "Begin mining". Nothing errored —
// the two halves just never met.
//
// The provider already strips `parent_body_id` and `ram_target_body_id`.
// This asserts the rule holds for the whole set rather than per-field
// vigilance, which is what failed.

import { stripGameId } from '../bodyIdentity';

describe('stripGameId', () => {
  it('removes a game namespace', () => {
    expect(stripGameId('tXWhq80tSrZU:mtr_belt_3')).toBe('mtr_belt_3');
  });

  it('leaves an already-local id alone', () => {
    expect(stripGameId('mtr_belt_3')).toBe('mtr_belt_3');
  });

  it('passes null/undefined through rather than inventing an id', () => {
    expect(stripGameId(null as unknown as string)).toBeFalsy();
    expect(stripGameId(undefined as unknown as string)).toBeFalsy();
  });
});

describe('the provider strips every body-pointing field', () => {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../MultiplayerGameProvider.tsx'), 'utf8',
  ) as string;

  // Wire fields that name a body. Each must be wrapped in stripGameId
  // where it is copied onto a client object.
  const BODY_FIELDS = [
    'parent_body_id',
    'ram_target_body_id',
    'mining_body_id',
  ];

  it.each(BODY_FIELDS)('%s is stripped where it is mapped', (field) => {
    // A line DECLARES the field when it starts with it (a wire-type
    // member); anything else mentioning it is USING it, and a use must
    // be stripped. Discriminating on position beats trying to exclude
    // type syntax — the first version of this filter threw away the very
    // line it was meant to catch, because the inline cast
    // `(s as { mining_body_id?: string | null })` contains a `?:`.
    // The rule is about ASSIGNMENT onto a client object, not every
    // mention. Reading the raw id to key a server-side lookup
    // (`muOf(s.parent_body_id)`) or to test for null is fine and must
    // not be flagged — an earlier version of this filter failed on both
    // and would have pushed someone to "fix" correct code.
    const lines = src.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      if (!t.includes(field)) return false;
      if (t.startsWith('//') || t.startsWith('*')) return false;
      if (t.startsWith(field)) return false;            // wire-type member
      return /^[A-Za-z_$][\w$]*\s*:/.test(t);           // clientProp: <expr>
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(`${field} :: ${l.trim()}`).toContain('stripGameId');
    }
  });
});
