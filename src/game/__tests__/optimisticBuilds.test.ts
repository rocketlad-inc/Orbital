import {
  carryOptimisticBuilds, isOptimisticBuildId, OPTIMISTIC_TTL_MS,
  trackPendingBuild, resolveServerOrderId, __resetPendingBuilds,
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

describe('resolveServerOrderId', () => {
  beforeEach(() => __resetPendingBuilds());

  it('passes a server-owned id straight through', async () => {
    await expect(resolveServerOrderId('mars:b1abc')).resolves.toBe('mars:b1abc');
  });

  // THE REPORTED BUG: cancelling a row the client had drawn but the
  // server had not yet named posted "opt_..." and got back 404 "build
  // order not found" — for a row sitting on screen.
  it('resolves an optimistic id to the id the build request came back with', async () => {
    const id = `opt_${NOW}_corvette`;
    trackPendingBuild(id, Promise.resolve('mars:b1abc'), NOW);
    await expect(resolveServerOrderId(id)).resolves.toBe('mars:b1abc');
  });

  it('waits for a request still in flight', async () => {
    const id = `opt_${NOW}_frigate`;
    let settle: (v: string | null) => void = () => {};
    trackPendingBuild(id, new Promise<string | null>(r => { settle = r; }), NOW);
    const pending = resolveServerOrderId(id);
    settle('mars:b2xyz');
    await expect(pending).resolves.toBe('mars:b2xyz');
  });

  it('answers null for a build the server rejected — nothing to cancel', async () => {
    const id = `opt_${NOW}_colony`;
    trackPendingBuild(id, Promise.resolve(null), NOW);
    await expect(resolveServerOrderId(id)).resolves.toBeNull();
  });

  it('answers null for an id it never saw, rather than posting it', async () => {
    await expect(resolveServerOrderId(`opt_${NOW}_destroyer`)).resolves.toBeNull();
  });

  it('forgets registrations old enough that nobody is still clicking them', async () => {
    const stale = `opt_${NOW}_corvette`;
    trackPendingBuild(stale, Promise.resolve('mars:b1abc'), NOW);
    // A later build prunes the map.
    trackPendingBuild(`opt_${NOW + 90_000}_frigate`, Promise.resolve('mars:b9zzz'), NOW + 90_000);
    await expect(resolveServerOrderId(stale)).resolves.toBeNull();
  });
});
