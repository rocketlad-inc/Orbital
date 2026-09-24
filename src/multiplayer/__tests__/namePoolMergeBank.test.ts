// [pure] "Names from a past game" adds to the draft; it never replaces it.
//
// Picking the wrong game from the list must cost nothing: every name
// typed in this lobby survives, the past bank's names follow it, and a
// name in both is listed once (case-insensitively, like every list).

import { mergeBank } from '../NamePoolEditor';
import { EMPTY_POOLS, POOL_MAX } from '../../game/namePools';

describe('[pure] mergeBank', () => {
  it('an empty draft takes the whole bank, in order', () => {
    const bank = { ...EMPTY_POOLS, ship: ['Endeavour', 'Resolute'], city: ['New Lorneland'] };
    expect(mergeBank({ ...EMPTY_POOLS }, bank)).toEqual(bank);
  });

  it('keeps what is already here first, then adds the bank', () => {
    const draft = { ...EMPTY_POOLS, ship: ['Kestrel'] };
    const bank = { ...EMPTY_POOLS, ship: ['Endeavour', 'kestrel'] };
    expect(mergeBank(draft, bank).ship).toEqual(['Kestrel', 'Endeavour']);
  });

  it('touches every list, not only the open tab', () => {
    const bank = { ship: ['A'], captain: ['B'], station: ['C'], city: ['D'] };
    const out = mergeBank({ ...EMPTY_POOLS }, bank);
    expect([out.ship, out.captain, out.station, out.city]).toEqual([['A'], ['B'], ['C'], ['D']]);
  });

  it('respects the list cap', () => {
    const many = Array.from({ length: POOL_MAX }, (_, i) => `Old ${i}`);
    const out = mergeBank({ ...EMPTY_POOLS, ship: ['Mine'] }, { ...EMPTY_POOLS, ship: many });
    expect(out.ship).toHaveLength(POOL_MAX);
    expect(out.ship[0]).toBe('Mine');
  });
});
