// ONE MARKER PER FLEET, AND NOBODY DISAPPEARS.
//
// A 147-hull fleet drew 147 sprites, 147 trajectories and 147 hitboxes
// stacked on one point. The reduction is the whole point of the module,
// so it is asserted numerically rather than eyeballed — and so is the
// failure mode that matters more: a ship must never be collapsed into a
// marker that isn't being drawn.

import {
  groupFleetsForRender, escortOffsets, mergeCoincidentMarkers, escortStandoffFor,
  MAX_ESCORT_SPRITES, MARKER_MERGE_MAX_SPAN_PX,
} from '../fleetGrouping';
import type { FleetMarker } from '../fleetGrouping';
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

describe('mergeCoincidentMarkers', () => {
  const mk = (id: string, n: number, over: Partial<FleetMarker> = {}): FleetMarker => ({
    fleetId: 'f1', leadShipId: id, isFlagship: false,
    memberCount: n, escorts: Math.min(n - 1, MAX_ESCORT_SPRITES),
    overflow: Math.max(0, n - 1 - MAX_ESCORT_SPRITES), ...over,
  });
  const at = (pts: Record<string, [number, number]>) =>
    (id: string) => (pts[id] ? { x: pts[id][0], y: pts[id][1] } : undefined);

  it('THE HYGIEA PILE: five badges on one heap become one total', () => {
    // Lorne's screenshot. One squadron launched from Hygiea to five
    // destinations: five places, five markers, all still sitting on the
    // same few pixels, wearing 28 / 24 / 12 / 12 / 50. The answer to
    // "how big is that fleet" is 126, and the map said it five times.
    const markers = [
      mk('a', 28, { isFlagship: true }), mk('b', 24), mk('c', 12),
      mk('d', 12), mk('e', 50),
    ];
    const r = mergeCoincidentMarkers(markers, at({
      a: [400, 300], b: [420, 310], c: [440, 295], d: [455, 320], e: [470, 300],
    }));
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].memberCount).toBe(126);
    expect(r.markers[0].leadShipId).toBe('a');
    expect(r.swallowed).toEqual(new Set(['b', 'c', 'd', 'e']));
  });

  it('a merged badge still caps its escort dots and reports the rest as overflow', () => {
    const r = mergeCoincidentMarkers(
      [mk('a', 28, { isFlagship: true }), mk('b', 98)],
      at({ a: [100, 100], b: [110, 105] }),
    );
    const m = r.markers[0];
    expect(m.escorts).toBe(MAX_ESCORT_SPRITES);
    expect(1 + m.escorts + m.overflow).toBe(126);
  });

  it('markers that are far apart keep their own badges', () => {
    // Zoomed IN, the same five are spread across the map and each one
    // is a real, separate answer to "what is over there".
    const r = mergeCoincidentMarkers(
      [mk('a', 28, { isFlagship: true }), mk('b', 24)],
      at({ a: [100, 100], b: [900, 700] }),
    );
    expect(r.markers).toHaveLength(2);
    expect(r.swallowed.size).toBe(0);
  });

  it('never merges across fleets, however stacked they are', () => {
    const r = mergeCoincidentMarkers(
      [mk('a', 30, { isFlagship: true }), mk('b', 40, { fleetId: 'f2', isFlagship: true })],
      at({ a: [300, 300], b: [302, 301] }),
    );
    expect(r.markers).toHaveLength(2);
    expect(r.markers.map(m => m.memberCount).sort((x, y) => x - y)).toEqual([30, 40]);
  });

  it('caps a merged pile by its SPAN, so a strung-out fleet does not chain into one badge', () => {
    // Each link is within the merge radius of the next, so a purely
    // transitive rule would swallow the whole 400px column onto the
    // leader - the "a fleet is not a place" bug wearing a hat.
    const pts: Record<string, [number, number]> = {};
    const markers: FleetMarker[] = [];
    for (let i = 0; i < 11; i++) {
      const id = `s${i}`;
      markers.push(mk(id, 5, { isFlagship: i === 0 }));
      pts[id] = [100, 100 + i * 40];
    }
    const r = mergeCoincidentMarkers(markers, at(pts));
    expect(r.markers.length).toBeGreaterThan(1);
    const widest = Math.max(...r.markers.map(m => m.memberCount));
    expect(widest).toBeLessThanOrEqual(5 * (Math.floor(MARKER_MERGE_MAX_SPAN_PX / 40) + 1));
  });

  it('leaves a marker alone when its lead has no drawn position', () => {
    // Fogged, off-screen, or simply not drawn yet. Guessing a position
    // would merge it into a pile it may be nowhere near.
    const r = mergeCoincidentMarkers(
      [mk('a', 28, { isFlagship: true }), mk('ghost', 24)],
      at({ a: [400, 300] }),
    );
    expect(r.markers).toHaveLength(2);
    expect(r.swallowed.size).toBe(0);
  });

  it('every marker is either kept or swallowed, and never both', () => {
    const markers = [mk('a', 5, { isFlagship: true }), mk('b', 5), mk('c', 5)];
    const r = mergeCoincidentMarkers(markers, at({
      a: [200, 200], b: [210, 205], c: [900, 900],
    }));
    for (const m of markers) {
      const kept = r.markers.some(x => x.leadShipId === m.leadShipId);
      expect(kept !== r.swallowed.has(m.leadShipId)).toBe(true);
    }
  });

  it('is deterministic regardless of input order', () => {
    const pts = at({ a: [400, 300], b: [420, 310], c: [440, 295] });
    const one = mergeCoincidentMarkers([mk('a', 9, { isFlagship: true }), mk('b', 4), mk('c', 7)], pts);
    const two = mergeCoincidentMarkers([mk('c', 7), mk('b', 4), mk('a', 9, { isFlagship: true })], pts);
    expect(one.markers).toEqual(two.markers);
    expect([...one.swallowed].sort()).toEqual([...two.swallowed].sort());
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

  it('keeps the nearest escort clear of the flagship hull', () => {
    // MapCanvas passes spacing ~= the flagship's drawn radius, so an
    // offset shorter than one spacing lands ON the sprite. Shipped that
    // way once: the first rank sat on the hull and the marker read as
    // one smudged blob rather than a leader with a formation behind it.
    const spacing = 10;
    const nearest = Math.min(
      ...escortOffsets(12, spacing, 0).map(o => Math.hypot(o.dx, o.dy)),
    );
    expect(nearest).toBeGreaterThan(spacing);
  });

  it('never draws an escort inside the flagship, at ANY hull size', () => {
    // THE MEGA DESTROYER BUG. `spacing` is clamped to <=11px so a 60-hull
    // wedge does not sprawl, and the standoff used to be derived from it
    // — about 14px, whatever the flagship's size. A corvette is smaller
    // than that so it looked fine; a mega destroyer is far bigger and
    // wore its own leading rank like a hat. Invisible at the convenient
    // size, obvious at the real one, so this sweeps the range.
    for (let hullR = 3; hullR <= 40; hullR++) {
      const spacing = Math.max(5, Math.min(11, hullR * 0.95));
      const offs = escortOffsets(12, spacing, 0.7, escortStandoffFor(hullR, spacing));
      const nearest = Math.min(...offs.map(o => Math.hypot(o.dx, o.dy)));
      expect(nearest).toBeGreaterThan(hullR);
    }
  });

  it('is deterministic, so hulls do not shimmer between frames', () => {
    expect(escortOffsets(9, 6, 1.2)).toEqual(escortOffsets(9, 6, 1.2));
  });
});
