// The Leviathan's set pieces (kaijuFx.ts) reach the screen through the
// pending-FX queue: its strikes play as ITS strikes, not the Mega
// Destroyer's beam or a generic boom, and its death is never a stock
// explosion with a wreck left on top.

import { ingestChronicleFx, drainVisibleFx, resetPendingFx, PendingFx } from '../pendingFx';
import { spawnKaijuStrike, spawnKaijuDeath, kaijuHoldsWorldWhole, hasActiveKaijuFx, resetKaijuFx, isKaijuShipId, KAIJU_BREAK_MS } from '../kaijuFx';

function drainAll(): PendingFx[] {
  const fired: PendingFx[] = [];
  let now = performance.now();
  for (let i = 0; i < 20; i++) {
    now += 1000;
    drainVisibleFx(now, () => ({ x: 100, y: 100 }), (fx) => { fired.push(fx); });
  }
  return fired;
}

describe('Leviathan effects', () => {
  beforeEach(() => {
    resetPendingFx();
    resetKaijuFx();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('routes its strikes and death to its own set pieces', () => {
    ingestChronicleFx('g1', [
      { id: 'a', kind: 'terraform_destroyed', bodyId: 'titan', cause: 'kaiju' },
      { id: 'b', kind: 'world_obliterated', bodyId: 'titan', cause: 'kaiju' },
      { id: 'c', kind: 'kaiju_dead', bodyId: 'titan' },
    ]);
    expect(drainAll().map(f => f.kind)).toEqual(['kaiju_scorch', 'kaiju_break', 'kaiju_death']);
  });

  it('leaves a Mega Destroyer strike as it was', () => {
    ingestChronicleFx('g2', [
      { id: 'a', kind: 'terraform_destroyed', bodyId: 'mars', cause: 'mega_destroyer' },
      { id: 'b', kind: 'world_obliterated', bodyId: 'mars' },
    ]);
    expect(drainAll().map(f => f.kind)).toEqual(['sterilise', 'destruction']);
  });

  it('never plays a generic boom for the beast itself', () => {
    ingestChronicleFx('g3', [
      { id: 'a', kind: 'ship_destroyed', bodyId: 'titan', shipId: 'leviathan' },
      { id: 'b', kind: 'ship_destroyed', bodyId: 'titan', shipId: 's12_0_abcde' },
    ]);
    expect(drainAll().map(f => f.id)).toEqual(['b']);
    expect(isKaijuShipId('g3:leviathan')).toBe(true);
    expect(isKaijuShipId('g3:leviathan_carcass')).toBe(false);
  });

  it('holds a world whole while it is crushed, then lets it break', () => {
    const t0 = performance.now();
    spawnKaijuStrike('x', 'titan', 'break');
    expect(kaijuHoldsWorldWhole('titan', t0 + 100)).toBe(true);
    expect(kaijuHoldsWorldWhole('titan', t0 + KAIJU_BREAK_MS * 0.9)).toBe(false);
    expect(kaijuHoldsWorldWhole('ganymede', t0 + 100)).toBe(false);
  });

  it('dies once, however many ways the news arrives', () => {
    const t0 = performance.now();
    spawnKaijuDeath('live:g:leviathan', '');
    spawnKaijuDeath('kaiju_dead_row', 'titan');
    expect(hasActiveKaijuFx(t0 + 10)).toBe(true);
    // Only one death is running: the second call was ignored.
    resetKaijuFx();
    expect(hasActiveKaijuFx(t0 + 10)).toBe(false);
  });
});
