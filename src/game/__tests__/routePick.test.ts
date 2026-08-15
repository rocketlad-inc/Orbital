// Route picking — the geometry and the arbitration, tested without a
// canvas. Both are pure decisions that used to live nowhere: map
// picking was never wired, so neither had ever run.

import {
  beginRoutePick, endRoutePick, isRoutePicking, isPickEligible, isPickChosen,
  offerPick, offerPickCluster, setClusterHandler, fitToPoints,
  requestRouteFit, takeRouteFit,
} from '../routePick/store';

const req = (eligible: string[], chosen: string[] = []) => {
  const picked: string[] = [];
  beginRoutePick({
    eligibleBodyIds: new Set(eligible),
    chosenBodyIds: new Set(chosen),
    onPick: (id) => picked.push(id),
    onCancel: () => {},
  });
  return picked;
};

afterEach(() => { endRoutePick(); setClusterHandler(null); });

describe('pick mode gates every branch', () => {
  it('is off until asked, so single-player never enters it', () => {
    expect(isRoutePicking()).toBe(false);
    expect(isPickEligible('earth')).toBe(false);
    expect(isPickChosen('earth')).toBe(false);
    // A click outside pick mode is NOT consumed — the map must keep its
    // normal select behaviour.
    expect(offerPick('earth')).toBe(false);
  });

  it('consumes clicks on ineligible worlds instead of selecting them', () => {
    const picked = req(['earth']);
    // Consumed, but nothing picked: clicking a rock you cannot ship
    // from should do nothing, not quietly select it behind the panel.
    expect(offerPick('mars')).toBe(true);
    expect(picked).toEqual([]);
    expect(offerPick('earth')).toBe(true);
    expect(picked).toEqual(['earth']);
  });

  it('marks stops already on the circuit', () => {
    req(['earth', 'luna'], ['earth']);
    expect(isPickChosen('earth')).toBe(true);
    expect(isPickChosen('luna')).toBe(false);
    // Chosen stops stay pickable — re-adding a stop is legal.
    expect(isPickEligible('earth')).toBe(true);
  });
});

describe('clusters', () => {
  it('picks straight through when only one candidate is eligible', () => {
    const picked = req(['io']);
    let asked: string[] | null = null;
    setClusterHandler(ids => { asked = ids; });
    expect(offerPickCluster(['io', 'europa', 'jupiter'])).toBe(true);
    // A disambiguator with one option is just a slower click.
    expect(asked).toBeNull();
    expect(picked).toEqual(['io']);
  });

  it('asks which when several eligible worlds overlap', () => {
    const picked = req(['io', 'europa']);
    let asked: string[] | null = null;
    setClusterHandler(ids => { asked = ids; });
    offerPickCluster(['io', 'europa', 'jupiter']);
    // Only the eligible ones are offered, and nothing is picked yet.
    expect(asked).toEqual(['io', 'europa']);
    expect(picked).toEqual([]);
  });

  it('never stalls when no chooser is mounted', () => {
    const picked = req(['io', 'europa']);
    setClusterHandler(null);
    offerPickCluster(['io', 'europa']);
    expect(picked).toEqual(['io']);
  });

  it('consumes a click that hits nothing eligible', () => {
    const picked = req(['io']);
    expect(offerPickCluster(['jupiter', 'callisto'])).toBe(true);
    expect(picked).toEqual([]);
  });
});

describe('fit to bounds', () => {
  const vp = { width: 1000, height: 800 };

  it('centres on the set, not on the last stop picked', () => {
    const fit = fitToPoints([{ x: 0, y: 0 }, { x: 100, y: 50 }], vp);
    expect(fit).not.toBeNull();
    expect(fit!.x).toBeCloseTo(50);
    expect(fit!.y).toBeCloseTo(25);
  });

  it('frames the whole span with room to spare', () => {
    const fit = fitToPoints([{ x: -200, y: 0 }, { x: 200, y: 0 }], vp)!;
    // Every stop must land inside the viewport, or the fit did not fit.
    const halfW = vp.width / 2 / fit.scale;
    expect(200 - fit.x).toBeLessThan(halfW);
    expect(Math.abs(-200 - fit.x)).toBeLessThan(halfW);
  });

  it('does not slam to maximum zoom on a single stop', () => {
    const fit = fitToPoints([{ x: 10, y: 10 }], vp, { maxScale: 8 })!;
    expect(fit.scale).toBeLessThan(8);
    expect(fit.scale).toBeGreaterThan(0);
  });

  it('honours the zoom clamp', () => {
    const fit = fitToPoints([{ x: 0, y: 0 }, { x: 0.001, y: 0 }], vp, { maxScale: 4 })!;
    expect(fit.scale).toBeLessThanOrEqual(4);
  });

  it('returns null rather than NaN when nothing resolves', () => {
    expect(fitToPoints([], vp)).toBeNull();
    expect(fitToPoints([{ x: NaN, y: 0 }], vp)).toBeNull();
  });
});

describe('fit requests are consume-once', () => {
  it('does not re-frame every frame and fight the player panning', () => {
    requestRouteFit(['earth', 'luna']);
    expect(takeRouteFit()).toEqual(['earth', 'luna']);
    expect(takeRouteFit()).toBeNull();
  });
});
