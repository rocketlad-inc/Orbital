import { filterIntercepts } from '../interceptSearch';
import { trajectoryRole } from '../../render/mapRenderer';
import type { Ship } from '../../types';

// Shaped on the live board: fartmaster's list held 192 contacts, mostly
// his own, with Noah's Mega Destroyer (Stonekin, bound for Jupiter) in
// among them.
type Row = { name: string; owner: string; dest: string };
const ROWS: Row[] = [
  { name: 'Diligent', owner: 'yours', dest: 'Jupiter' },
  { name: 'Bulkhead', owner: 'yours', dest: 'Jupiter' },
  { name: 'Mega Destroyer', owner: 'Stonekin of Mars', dest: 'Jupiter' },
  { name: 'Prosperity', owner: 'Stonekin of Mars', dest: 'Ceres' },
  { name: 'Vigilant', owner: 'yours', dest: 'Mars' },
];
const fields = (r: Row) => ({ shipName: r.name, ownerName: r.owner, destName: r.dest });
const names = (rs: Row[]) => rs.map(r => r.name);

describe('intercept search', () => {
  it('a blank query shows everything, untouched', () => {
    expect(filterIntercepts(ROWS, '', fields)).toBe(ROWS);
    expect(filterIntercepts(ROWS, '   ', fields)).toBe(ROWS);
  });

  it('finds by ship name, any case', () => {
    expect(names(filterIntercepts(ROWS, 'mega', fields))).toEqual(['Mega Destroyer']);
    expect(names(filterIntercepts(ROWS, 'MEGA', fields))).toEqual(['Mega Destroyer']);
  });

  it('finds by owner, so one word pulls up a whole empire', () => {
    expect(names(filterIntercepts(ROWS, 'stonekin', fields)))
      .toEqual(['Mega Destroyer', 'Prosperity']);
  });

  it('finds by destination', () => {
    expect(names(filterIntercepts(ROWS, 'ceres', fields))).toEqual(['Prosperity']);
  });

  it('"yours" finds your own hulls', () => {
    expect(names(filterIntercepts(ROWS, 'yours', fields)))
      .toEqual(['Diligent', 'Bulkhead', 'Vigilant']);
  });

  it('nothing matching is an empty list, not an error', () => {
    expect(filterIntercepts(ROWS, 'zzz', fields)).toEqual([]);
  });
});

describe('which names read red', () => {
  // The list reuses the map's rule so the two never disagree.
  const hull = (ownedBy: string) => ({ ownedBy } as unknown as Ship);
  it('a rival who is not an ally is hostile', () => {
    expect(trajectoryRole(hull('f5'), 'player', new Set())).toBe('hostile');
  });
  it('your own hulls and your allies are not', () => {
    expect(trajectoryRole(hull('player'), 'player', new Set())).toBe('mine');
    expect(trajectoryRole(hull('f2'), 'player', new Set(['f2']))).toBe('neutral');
  });
});
