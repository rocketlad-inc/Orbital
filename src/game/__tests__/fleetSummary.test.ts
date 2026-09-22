// THE NUMBERS ON A FLEET'S CARD.
//
// Every figure here reaches a player as a claim about their squadron, so
// each one is pinned against a fleet built to break it: detached members
// that must not count toward strength, a split fleet that must say so,
// a hull at 5% that an average would hide.

import { summarizeFleet, fleetHeadlineStatus } from '../fleetSummary';
import type { Ship } from '../../types';
import type { ShipStatus } from '../systemGrouping';

const MAX: Record<string, number> = { destroyer: 1000, corvette: 40, frigate: 120 };
const DMG: Record<string, number> = { destroyer: 50, corvette: 5, frigate: 20, freighter: 0 };
const maxHpOf = (s: Ship) => MAX[s.class] ?? 60;
const damageOf = (s: Ship) => DMG[s.class] ?? 0;

const parked = (id: string, cls: string, body = 'mars', over: Partial<Ship> = {}): Ship => ({
  id, name: id, class: cls, ownedBy: 'player', fleetId: 'f1',
  orbit: { parentBodyId: body }, ...over,
} as unknown as Ship);

const flying = (id: string, cls: string, dest: string, arriveTick: number): Ship => ({
  id, name: id, class: cls, ownedBy: 'player', fleetId: 'f1',
  orbit: { parentBodyId: 'earth' },
  transit: { currentTransfer: { targetBodyId: dest, arriveTick } },
} as unknown as Ship);

describe('summarizeFleet', () => {
  it('adds up strength across the attached hulls', () => {
    const s = summarizeFleet(
      [parked('a', 'destroyer'), parked('b', 'destroyer'), parked('c', 'corvette')],
      100, maxHpOf, damageOf,
    );
    expect(s.hpMax).toBe(2040);
    expect(s.hp).toBe(2040);          // no hp field = full strength
    expect(s.hpPct).toBe(100);
    expect(s.firepower).toBe(105);
    expect(s.armed).toBe(3);
    expect(s.composition).toEqual([
      { cls: 'destroyer', count: 2 },
      { cls: 'corvette', count: 1 },
    ]);
  });

  it('a DETACHED member is listed but does not count toward strength', () => {
    // It stepped out of formation and takes its own orders; counting its
    // guns in the fleet's firepower would describe a fight the fleet
    // cannot actually bring.
    const s = summarizeFleet(
      [parked('a', 'destroyer'), parked('b', 'destroyer', 'mars', { fleetDetached: true })],
      100, maxHpOf, damageOf,
    );
    expect(s.attached.map(m => m.id)).toEqual(['a']);
    expect(s.detached.map(m => m.id)).toEqual(['b']);
    expect(s.firepower).toBe(50);
    expect(s.hpMax).toBe(1000);
  });

  it('reports the WORST hull, which an average would hide', () => {
    const s = summarizeFleet(
      [parked('a', 'destroyer'), parked('b', 'destroyer', 'mars', { hp: 50 } as Partial<Ship>)],
      100, maxHpOf, damageOf,
    );
    expect(s.hpPct).toBe(53);         // looks healthy on average...
    expect(s.worstHpPct).toBe(5);     // ...with one hull about to go
  });

  it('unarmed hulls count toward hull but not toward guns', () => {
    const s = summarizeFleet(
      [parked('a', 'freighter'), parked('b', 'freighter')], 100, maxHpOf, damageOf,
    );
    expect(s.firepower).toBe(0);
    expect(s.armed).toBe(0);
    expect(s.hpMax).toBe(120);
  });

  it('a fleet under way reports the LAST hull\'s arrival, not the first', () => {
    // A fleet has arrived when all of it has.
    const s = summarizeFleet(
      [flying('a', 'destroyer', 'vesta', 150), flying('b', 'corvette', 'vesta', 180)],
      100, maxHpOf, damageOf,
    );
    expect(s.places).toEqual([{ kind: 'transit', bodyId: 'vesta', count: 2, eta: 80 }]);
  });

  it('a SPLIT fleet reports every place, biggest group first', () => {
    const s = summarizeFleet(
      [
        parked('a', 'destroyer', 'callisto'), parked('b', 'destroyer', 'callisto'),
        parked('c', 'destroyer', 'europa'),
        flying('d', 'destroyer', 'vesta', 120),
      ],
      100, maxHpOf, damageOf,
    );
    expect(s.places.map(p => [p.kind, p.bodyId, p.count])).toEqual([
      ['parked', 'callisto', 2],
      ['parked', 'europa', 1],
      ['transit', 'vesta', 1],
    ]);
  });

  it('an empty fleet reads as full rather than NaN', () => {
    const s = summarizeFleet([], 100, maxHpOf, damageOf);
    expect(s.hpPct).toBe(100);
    expect(s.worstHpPct).toBe(100);
    expect(s.places).toEqual([]);
  });
});

describe('fleetHeadlineStatus', () => {
  const st = (cls: string): ShipStatus => ({ label: cls, cls, title: '' });

  it('one hull under fire makes the fleet IN COMBAT', () => {
    const r = fleetHeadlineStatus([st('orbiting'), st('orbiting'), st('combat')])!;
    expect(r.status.cls).toBe('combat');
    expect(r.count).toBe(1);          // and says how many, so it is not overstated
  });

  it('a fleet all doing the same thing reports that, with the full count', () => {
    const r = fleetHeadlineStatus([st('transit'), st('transit')])!;
    expect(r.status.cls).toBe('transit');
    expect(r.count).toBe(2);
  });

  it('nothing to report for an empty fleet', () => {
    expect(fleetHeadlineStatus([])).toBeNull();
  });
});
