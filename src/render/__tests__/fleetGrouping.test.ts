// ONE MARKER PER FLEET, AND NOBODY DISAPPEARS.
//
// A 147-hull fleet drew 147 sprites, 147 trajectories and 147 hitboxes
// stacked on one point. The reduction is the whole point of the module,
// so it is asserted numerically rather than eyeballed — and so is the
// failure mode that matters more: a ship must never be collapsed into a
// marker that isn't being drawn.

import { groupFleetsForRender, escortOffsets, MAX_ESCORT_SPRITES } from '../fleetGrouping';
import type { Ship, Fleet } from '../../types';

const ship = (id: string, over: Partial<Ship> = {}): Ship => ({
  id, name: id, class: 'destroyer', ownedBy: 'player',
  orbit: { parentBodyId: 'earth' },
  ...over,
} as unknown as Ship);

const fleet = (id: string, leadShipId: string, over: Partial<Fleet> = {}): Fleet => ({
  id, name: id, shipIds: [], leadShipId, ownedBy: 'player', ...over,
} as unknown as Fleet);

/** N hulls in one fleet, first one leading. */
const squadron = (n: number, fid = 'f1') => {
  const ships = Array.from({ length: n }, (_, i) => ship(`s${i}`, { fleetId: fid }));
  return { ships, fleets: [fleet(fid, 's0')] };
};

describe('groupFleetsForRender', () => {
  it('collapses a megafleet to a single drawn hull', () => {
    const { ships, fleets } = squadron(147);
    const g = groupFleetsForRender(ships, fleets);
    expect(g.draws.size).toBe(1);
    expect(g.draws.has('s0')).toBe(true);
    expect(g.collapsed.size).toBe(146);
  });

  it('every ship is either drawn or collapsed — never neither', () => {
    // The bug this guards is a hull vanishing off the map entirely.
    const { ships, fleets } = squadron(147);
    const g = groupFleetsForRender(ships, fleets);
    for (const s of ships) {
      const drawn = g.draws.has(s.id);
      const folded = g.collapsed.has(s.id);
      expect(drawn !== folded).toBe(true);   // exactly one, never both
    }
  });

  it('a collapsed hull is always folded into a marker that IS drawn', () => {
    const { ships, fleets } = squadron(50);
    const g = groupFleetsForRender(ships, fleets);
    expect(g.markerByLeadShip.size).toBe(1);
    for (const leadId of g.markerByLeadShip.keys()) {
      expect(g.draws.has(leadId)).toBe(true);
    }
  });

  it('the marker counts the whole squadron and splits it into escorts + overflow', () => {
    const { ships, fleets } = squadron(147);
    const m = groupFleetsForRender(ships, fleets).markerByLeadShip.get('s0')!;
    expect(m.memberCount).toBe(147);
    expect(m.escorts).toBe(MAX_ESCORT_SPRITES);
    // flagship + escorts + overflow accounts for every hull, exactly.
    expect(1 + m.escorts + m.overflow).toBe(147);
  });

  it('a small fleet shows every escort and no overflow badge', () => {
    const { ships, fleets } = squadron(6);
    const m = groupFleetsForRender(ships, fleets).markerByLeadShip.get('s0')!;
    expect(m.escorts).toBe(5);
    expect(m.overflow).toBe(0);
  });

  it('two hulls are not a crowd — both keep drawing', () => {
    const { ships, fleets } = squadron(2);
    const g = groupFleetsForRender(ships, fleets);
    expect(g.draws.size).toBe(2);
    expect(g.markerByLeadShip.size).toBe(0);
  });

  it('a DETACHED member draws itself and leaves the count', () => {
    // Detaching is the player saying "that one scouts ahead". Hiding it
    // would delete the feature.
    const { ships, fleets } = squadron(10);
    ships[3].fleetDetached = true;
    const g = groupFleetsForRender(ships, fleets);
    expect(g.draws.has('s3')).toBe(true);
    expect(g.collapsed.has('s3')).toBe(false);
    expect(g.markerByLeadShip.get('s0')!.memberCount).toBe(9);
  });

  it('a leaderless fleet elects a stand-in rather than vanishing', () => {
    // Flagship lost: leadShipId points at a hull that is gone. The
    // squadron must still be ON the map — the failure mode is allowed to
    // be "the marker is not the flagship", never "your fleet is
    // invisible".
    const { ships } = squadron(20);
    const g = groupFleetsForRender(ships, [fleet('f1', 'ghost')]);
    expect(g.markerByLeadShip.size).toBe(1);
    const m = [...g.markerByLeadShip.values()][0];
    expect(m.isFlagship).toBe(false);
    expect(m.memberCount).toBe(20);
    expect(g.draws.has(m.leadShipId)).toBe(true);
  });

  it('a fleet row missing entirely still puts a marker on the map', () => {
    const { ships } = squadron(20);
    const g = groupFleetsForRender(ships, []);
    expect(g.markerByLeadShip.size).toBe(1);
    expect([...g.markerByLeadShip.values()][0].isFlagship).toBe(false);
  });

  it('membership is counted off the SHIPS, so a dead member cannot hold a slot', () => {
    // fleets[] lags ships[] by up to one poll. If the count came from
    // fleet.shipIds the badge would report hulls that no longer exist.
    const { ships, fleets } = squadron(5);
    fleets[0].shipIds = ['s0', 's1', 's2', 's3', 's4', 'sDead', 'sAlsoDead'];
    const m = groupFleetsForRender(ships, fleets).markerByLeadShip.get('s0')!;
    expect(m.memberCount).toBe(5);
  });

  it('a member somewhere ELSE is never folded into the flagship', () => {
    // THE BUG THIS FILE ALMOST SHIPPED. A fleet is not a place: the
    // probe game had a squadron parked at Sol with one hauler three legs
    // away, mid-burn to Neptune. Collapsing on fleet id alone erased the
    // hauler and its whole trajectory while the outliner went on
    // listing it. Found by opening the game and reading the panel.
    const ships = [
      ship('s0', { fleetId: 'f1' }),
      ship('s1', { fleetId: 'f1' }),
      ship('s2', { fleetId: 'f1' }),
      ship('away', {
        fleetId: 'f1',
        transit: { currentTransfer: { targetBodyId: 'neptune' } },
      } as Partial<Ship>),
    ];
    const g = groupFleetsForRender(ships, [fleet('f1', 's0')]);
    expect(g.draws.has('away')).toBe(true);
    expect(g.collapsed.has('away')).toBe(false);
    // ...and it is not counted into a marker it is nowhere near.
    expect(g.markerByLeadShip.get('s0')!.memberCount).toBe(3);
  });

  it('hulls parked at different bodies cluster separately', () => {
    const here = Array.from({ length: 5 }, (_, i) =>
      ship(`h${i}`, { fleetId: 'f1', orbit: { parentBodyId: 'earth' } } as Partial<Ship>));
    const there = Array.from({ length: 4 }, (_, i) =>
      ship(`t${i}`, { fleetId: 'f1', orbit: { parentBodyId: 'mars' } } as Partial<Ship>));
    const g = groupFleetsForRender([...here, ...there], [fleet('f1', 'h0')]);
    expect(g.markerByLeadShip.size).toBe(2);
    expect(g.markerByLeadShip.get('h0')!.memberCount).toBe(5);
    expect(g.markerByLeadShip.get('h0')!.isFlagship).toBe(true);
    // The detachment at Mars has no flagship, so it elects a stable
    // stand-in rather than leaving four hulls uncollapsed.
    const mars = [...g.markerByLeadShip.values()].find(m => !m.isFlagship)!;
    expect(mars.memberCount).toBe(4);
    expect(mars.leadShipId).toBe('t0');
  });

  it('a fleet flying one leg together still collapses', () => {
    const flying = Array.from({ length: 20 }, (_, i) => ship(`f${i}`, {
      fleetId: 'f1',
      transit: { currentTransfer: { targetBodyId: 'juno' } },
    } as Partial<Ship>));
    const g = groupFleetsForRender(flying, [fleet('f1', 'f0')]);
    expect(g.draws.size).toBe(1);
    expect(g.markerByLeadShip.get('f0')!.memberCount).toBe(20);
  });

  it('ships in no fleet are untouched', () => {
    const loose = [ship('a'), ship('b'), ship('c')];
    const g = groupFleetsForRender(loose, []);
    expect(g.draws.size).toBe(3);
    expect(g.collapsed.size).toBe(0);
  });

  it('two fleets collapse independently', () => {
    const a = Array.from({ length: 30 }, (_, i) => ship(`a${i}`, { fleetId: 'fa' }));
    const b = Array.from({ length: 40 }, (_, i) => ship(`b${i}`, { fleetId: 'fb' }));
    const g = groupFleetsForRender([...a, ...b], [fleet('fa', 'a0'), fleet('fb', 'b0')]);
    expect(g.draws.size).toBe(2);
    expect(g.markerByLeadShip.get('a0')!.memberCount).toBe(30);
    expect(g.markerByLeadShip.get('b0')!.memberCount).toBe(40);
  });
});

describe('escortOffsets', () => {
  it('places exactly the requested number', () => {
    for (const n of [1, 2, 5, 12]) {
      expect(escortOffsets(n, 6, 0)).toHaveLength(n);
    }
  });

  it('holds every escort astern of the leader', () => {
    // Heading 0 means "facing +x", so every escort should sit at
    // negative x — behind. A formation drawn ahead of its flagship
    // reads as the fleet flying backwards.
    for (const o of escortOffsets(12, 6, 0)) {
      expect(o.dx).toBeLessThan(0);
    }
  });

  it('rotates with the heading', () => {
    const east = escortOffsets(3, 6, 0);
    const north = escortOffsets(3, 6, Math.PI / 2);
    // Same formation, rotated a quarter turn. Facing +x, astern is -x;
    // facing +y, astern is -y — so the sterns match in sign, they do
    // not invert. (Asserted the negative first, which was the test
    // being wrong rather than the code.)
    expect(north[0].dy).toBeCloseTo(east[0].dx, 5);
  });

  it('is deterministic, so hulls do not shimmer between frames', () => {
    expect(escortOffsets(9, 6, 1.2)).toEqual(escortOffsets(9, 6, 1.2));
  });
});
