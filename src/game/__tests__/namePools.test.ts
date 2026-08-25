import {
  sanitizeNames, parseNameList, parseNamePools, serializeNamePools,
  pickFromPool, poolsEqual, adoptServerPools,
  EMPTY_POOLS, POOL_MAX, NAME_MAX_LEN,
} from '../namePools';

describe('sanitizeNames', () => {
  it('trims, collapses whitespace and drops blanks', () => {
    expect(sanitizeNames(['  Endeavour ', '', '   ', 'Bold   Venture']))
      .toEqual(['Endeavour', 'Bold Venture']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(sanitizeNames(['Endeavour', 'ENDEAVOUR', 'endeavour']))
      .toEqual(['Endeavour']);
  });

  it('ignores non-strings rather than throwing', () => {
    expect(sanitizeNames([1, null, undefined, {}, 'Kestrel'] as unknown))
      .toEqual(['Kestrel']);
  });

  it('caps each name and the list', () => {
    const long = 'x'.repeat(NAME_MAX_LEN + 40);
    expect(sanitizeNames([long])[0]).toHaveLength(NAME_MAX_LEN);
    const many = Array.from({ length: POOL_MAX + 50 }, (_, i) => `Ship ${i}`);
    expect(sanitizeNames(many)).toHaveLength(POOL_MAX);
  });

  it('is safe on garbage input', () => {
    expect(sanitizeNames(null)).toEqual([]);
    expect(sanitizeNames('not an array')).toEqual([]);
  });
});

describe('parseNameList', () => {
  it('splits on newlines AND commas — people paste both', () => {
    expect(parseNameList('Endeavour\nResolute, Kestrel\r\nVigil'))
      .toEqual(['Endeavour', 'Resolute', 'Kestrel', 'Vigil']);
  });
  it('survives a trailing newline and stray separators', () => {
    expect(parseNameList('Alpha,,\n\nBeta,\n')).toEqual(['Alpha', 'Beta']);
  });
});

describe('parseNamePools', () => {
  it('returns empty pools for null, junk, or the wrong shape', () => {
    expect(parseNamePools(null)).toEqual(EMPTY_POOLS);
    expect(parseNamePools('{oh no')).toEqual(EMPTY_POOLS);
    expect(parseNamePools('"a string"')).toEqual(EMPTY_POOLS);
  });

  it('fills every kind even when the blob has only one', () => {
    const p = parseNamePools(JSON.stringify({ ship: ['Kestrel'] }));
    expect(p.ship).toEqual(['Kestrel']);
    expect(p.captain).toEqual([]);
    expect(p.station).toEqual([]);
    expect(p.city).toEqual([]);
  });

  it('sanitizes on the way in, so a hand-edited row cannot poison a game', () => {
    const p = parseNamePools(JSON.stringify({ ship: ['  Dup ', 'dup', 42] }));
    expect(p.ship).toEqual(['Dup']);
  });

  it('round-trips through serialize', () => {
    const pools = { ...EMPTY_POOLS, ship: ['Kestrel', 'Vigil'], city: ['Hearth'] };
    expect(parseNamePools(serializeNamePools(pools))).toEqual({
      ...EMPTY_POOLS, ship: ['Kestrel', 'Vigil'], city: ['Hearth'],
    });
  });
});

describe('pickFromPool', () => {
  it('hands out names IN ORDER, not at random', () => {
    const pool = ['Endeavour', 'Resolute', 'Kestrel'];
    expect(pickFromPool(pool, [])).toBe('Endeavour');
    expect(pickFromPool(pool, ['Endeavour'])).toBe('Resolute');
    expect(pickFromPool(pool, ['Endeavour', 'Resolute'])).toBe('Kestrel');
  });

  it('matches taken names case- and whitespace-insensitively', () => {
    expect(pickFromPool(['Endeavour', 'Resolute'], ['  endeavour '])).toBe('Resolute');
  });

  it('returns null when the pool is exhausted, so the caller can fall back', () => {
    expect(pickFromPool(['A'], ['a'])).toBeNull();
  });

  it('returns null for an empty or missing pool', () => {
    expect(pickFromPool([], ['x'])).toBeNull();
    expect(pickFromPool(undefined, [])).toBeNull();
  });
});

describe('poolsEqual', () => {
  it('is true for the same names in the same order', () => {
    expect(poolsEqual(
      { ...EMPTY_POOLS, ship: ['A', 'B'] },
      { ...EMPTY_POOLS, ship: ['A', 'B'] },
    )).toBe(true);
  });
  it('is order-sensitive — the order IS the handout order', () => {
    expect(poolsEqual(
      { ...EMPTY_POOLS, ship: ['A', 'B'] },
      { ...EMPTY_POOLS, ship: ['B', 'A'] },
    )).toBe(false);
  });
  it('treats a missing kind as empty', () => {
    expect(poolsEqual({ ship: ['A'] } as never, { ...EMPTY_POOLS, ship: ['A'] })).toBe(true);
  });
});

describe('adoptServerPools', () => {
  // REGRESSION — reported as "once I hit back or reload it disappears,
  // it only shows a zero where the number should be and a yellow dot".
  //
  // The row held 249 names. The editor mounted empty, the snapshot
  // arrived with the names, and the old rule ("adopt unless dirty")
  // read that same snapshot as making the editor dirty, so it never
  // adopted. Empty tabs, all flagged unsaved, over a full row.
  it('adopts a snapshot that lands on an untouched editor', () => {
    const server = { ...EMPTY_POOLS, ship: ['Chetzemoka', 'Tynan'], city: ['Coriolis'] };
    expect(adoptServerPools(EMPTY_POOLS, EMPTY_POOLS, server)).toBe(server);
  });

  it('keeps a draft the player has actually edited', () => {
    const typed = { ...EMPTY_POOLS, ship: ['Mine'] };
    const server = { ...EMPTY_POOLS, ship: ['Theirs'] };
    expect(adoptServerPools(typed, EMPTY_POOLS, server)).toBe(typed);
  });

  it('adopts again once the draft has caught up with the last snapshot', () => {
    const first = { ...EMPTY_POOLS, ship: ['A'] };
    const second = { ...EMPTY_POOLS, ship: ['A', 'B'] };
    // Draft equals the snapshot we last synced to: nothing to lose.
    expect(adoptServerPools(first, first, second)).toBe(second);
  });
});
