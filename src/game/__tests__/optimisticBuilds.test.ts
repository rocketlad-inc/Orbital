import {
  carryOptimisticBuilds, isOptimisticBuildId, OPTIMISTIC_TTL_MS,
} from '../optimisticBuilds';
import { BuildOrder } from '../../types';

const NOW = 1_700_000_000_000;

const order = (over: Partial<BuildOrder> & { id: string }): BuildOrder => ({
  bodyId: 'mars',
  shipClass: 'corvette',
  ownedBy: 'player',
  startTick: 10,
  completeTick: 18,
  shipName: 'Endeavour',
  status: 'waiting',
  ...over,
});

const opt = (t = NOW, over: Partial<BuildOrder> = {}) =>
  order({ id: `opt_${t}_corvette`, ...over });

describe('carryOptimisticBuilds', () => {
  // THE REPORTED BUG. Order a hull, the row appears, the next poll
  // lands carrying a snapshot taken before the write was visible, and
  // the queue empties itself under the player — who orders it again.
  it('keeps a row the incoming snapshot has not caught up with', () => {
    const local = [opt()];
    const merged = carryOptimisticBuilds(local, [], NOW + 400);
    expect(merged).toHaveLength(1);
    expect(merged[0].shipName).toBe('Endeavour');
  });

  it('drops the local row once the server row for it arrives', () => {
    const server = [order({ id: 'srv-1' })];
    const merged = carryOptimisticBuilds([opt()], server, NOW + 1500);
    expect(merged).toEqual(server);          // no duplicate row
  });

  it('never shadows the server list — server rows always come through', () => {
    const server = [order({ id: 'srv-1', shipName: 'Resolute' })];
    const merged = carryOptimisticBuilds([opt()], server, NOW + 100);
    expect(merged.map(o => o.shipName)).toEqual(['Resolute', 'Endeavour']);
  });

  it('matches one server row per twin, so a duplicate name cannot collapse both', () => {
    // Two hulls ordered with the same typed name; the server confirms
    // one. A plain key test would clear both and flicker the queue.
    const local = [opt(NOW), opt(NOW + 1)];
    const merged = carryOptimisticBuilds(local, [order({ id: 'srv-1' })], NOW + 200);
    expect(merged).toHaveLength(2);
  });

  it('distinguishes rows by body and class, not name alone', () => {
    const local = [opt(NOW, { bodyId: 'luna' })];
    const merged = carryOptimisticBuilds(local, [order({ id: 'srv-1' })], NOW + 200);
    expect(merged).toHaveLength(2);           // the Mars row is not this one
  });

  it('expires a row the server never confirmed, so a lost request leaves no ghost', () => {
    const merged = carryOptimisticBuilds([opt()], [], NOW + OPTIMISTIC_TTL_MS + 1);
    expect(merged).toEqual([]);
  });

  it('holds the row for the whole TTL — expiring early IS the bug', () => {
    const merged = carryOptimisticBuilds([opt()], [], NOW + OPTIMISTIC_TTL_MS - 1);
    expect(merged).toHaveLength(1);
  });

  it('carries nothing but optimistic rows — server-owned ids are the snapshot\'s business', () => {
    const stale = [order({ id: 'srv-old', shipName: 'Kestrel' })];
    expect(carryOptimisticBuilds(stale, [], NOW)).toEqual([]);
  });

  it('returns the server array itself when there is nothing to carry', () => {
    const server = [order({ id: 'srv-1' })];
    expect(carryOptimisticBuilds([], server, NOW)).toBe(server);
  });

  it('treats an unparseable id as new rather than instantly expired', () => {
    const merged = carryOptimisticBuilds([order({ id: 'opt_weird' })], [], NOW);
    expect(merged).toHaveLength(1);
  });
});

describe('isOptimisticBuildId', () => {
  it('knows both mints from a server id', () => {
    expect(isOptimisticBuildId(`opt_${NOW}_frigate`)).toBe(true);
    expect(isOptimisticBuildId('bo_12345')).toBe(false);
  });
});
