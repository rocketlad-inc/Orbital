// Franz's map playtest (2026-10): overlapping hulls could not be told
// apart by clicking, a one-ship box opened no panel, and stations with no
// guns drew bolts at invaders.

import { boxSingleTarget, cyclePick, orderPickHits } from '../mapPick';
import { settlementHasGuns } from '../combatFx';
import type { Fleet, Settlement, Ship } from '../../types';

describe('orderPickHits', () => {
  it('sorts nearest first and keeps one entry per id (its nearest)', () => {
    expect(orderPickHits([
      { id: 'a', d: 9 }, { id: 'b', d: 3 }, { id: 'a', d: 1 }, { id: 'c', d: 5 },
    ])).toEqual(['a', 'b', 'c']);
  });

  it('keeps scan order on a tie, matching the single-pick winner', () => {
    expect(orderPickHits([{ id: 'x', d: 4 }, { id: 'y', d: 4 }])).toEqual(['x', 'y']);
  });
});

describe('cyclePick — overlapping hulls', () => {
  it('a lone hull resolves to itself, selected or not', () => {
    expect(cyclePick(['a'], undefined, null)).toEqual({ id: 'a', order: [], index: 0 });
    expect(cyclePick(['a'], 'a', ['a', 'b'])).toEqual({ id: 'a', order: [], index: 0 });
  });

  it('nothing under the pointer is nothing', () => {
    expect(cyclePick([], 'a', null)).toBeNull();
  });

  it('first click on a pile takes the nearest, exactly as before', () => {
    expect(cyclePick(['a', 'b', 'c'], undefined, null)).toEqual({ id: 'a', order: ['a', 'b', 'c'], index: 0 });
    // Something ELSE selected elsewhere on the map: still the nearest.
    expect(cyclePick(['a', 'b'], 'z', null)?.id).toBe('a');
  });

  it('clicking the selected hull again moves to the next, and wraps', () => {
    let order: string[] | null = null;
    let sel: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = cyclePick(['a', 'b', 'c'], sel, order)!;
      sel = r.id; order = r.order; seen.push(r.id);
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a']);
  });

  it('the remembered order holds while the hulls drift and the nearest changes', () => {
    // Three interceptors; between clicks the ranking reshuffles. Without
    // the remembered order this ping-pongs between the two nearest.
    const r1 = cyclePick(['a', 'b', 'c'], undefined, null)!;
    const r2 = cyclePick(['b', 'a', 'c'], r1.id, r1.order)!;
    expect(r2.id).toBe('b');
    const r3 = cyclePick(['a', 'b', 'c'], r2.id, r2.order)!;
    expect(r3.id).toBe('c');
  });

  it('a hull that left drops out; one that arrived joins the end', () => {
    const r = cyclePick(['b', 'd'], 'b', ['a', 'b', 'c'])!;
    expect(r.order).toEqual(['b', 'd']);
    expect(r.id).toBe('d');
  });
});

describe('boxSingleTarget — a one-ship box opens that ship', () => {
  const ship = (id: string, fleetId?: string, fleetDetached?: boolean) =>
    ({ id, fleetId, fleetDetached, ownedBy: 'player' } as unknown as Ship);
  const none = () => undefined;

  it('exactly one ship', () => {
    expect(boxSingleTarget(['a'], [ship('a')], [], none)).toBe('a');
  });

  it('nothing caught, or two unrelated ships: no single target', () => {
    expect(boxSingleTarget([], [], [], none)).toBeNull();
    expect(boxSingleTarget(['a', 'b'], [ship('a'), ship('b')], [], none)).toBeNull();
  });

  it('a folded fleet: every hull resolves to its flagship', () => {
    const slots = new Map([['a', 'lead'], ['b', 'lead'], ['lead', 'lead']]);
    expect(boxSingleTarget(['a', 'lead', 'b'], [ship('a', 'f'), ship('b', 'f'), ship('lead', 'f')], [],
      id => slots.get(id))).toBe('lead');
  });

  it('a small unfolded fleet with its flagship in the box: the flagship', () => {
    const fleets = [{ id: 'f', leadShipId: 'L' } as Fleet];
    expect(boxSingleTarget(['x', 'L'], [ship('x', 'f'), ship('L', 'f')], fleets, none)).toBe('L');
  });

  it('two members without the flagship, a detached member, or two fleets: still a group', () => {
    const fleets = [{ id: 'f', leadShipId: 'L' } as Fleet];
    expect(boxSingleTarget(['x', 'y'], [ship('x', 'f'), ship('y', 'f')], fleets, none)).toBeNull();
    expect(boxSingleTarget(['x', 'L'], [ship('x', 'f', true), ship('L', 'f')], fleets, none)).toBeNull();
    expect(boxSingleTarget(['x', 'L'], [ship('x', 'g'), ship('L', 'f')], fleets, none)).toBeNull();
  });
});

describe('settlementHasGuns — only a station with a Weapons module fires', () => {
  const stl = (over: Partial<Settlement>) =>
    ({ id: 's', type: 'station', hp: 100, buildings: {}, ...over } as unknown as Settlement);

  it('a station with no Weapons module has no guns', () => {
    expect(settlementHasGuns(stl({}))).toBe(false);
    expect(settlementHasGuns(stl({ buildings: undefined }))).toBe(false);
    expect(settlementHasGuns(stl({ buildings: { shipyard: 2 } as Settlement['buildings'] }))).toBe(false);
  });

  it('a station with Weapons 1+ fires', () => {
    expect(settlementHasGuns(stl({ buildings: { weapons: 1 } as Settlement['buildings'] }))).toBe(true);
  });

  it('a city never fires, whatever it has built', () => {
    expect(settlementHasGuns(stl({ type: 'city', buildings: { weapons: 3 } as Settlement['buildings'] }))).toBe(false);
  });

  it('a dead station does not fire', () => {
    expect(settlementHasGuns(stl({ hp: 0, buildings: { weapons: 2 } as Settlement['buildings'] }))).toBe(false);
  });
});
