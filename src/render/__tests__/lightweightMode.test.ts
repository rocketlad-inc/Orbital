// [pure] Lightweight mode toggle.
//
// The escape hatch for "my iPhone cannot draw this". The render branches
// it gates are trivial (a flat disk instead of a texture blit); the part
// with actual logic is this state machine, and it has to survive a
// reload, a private-mode browser with no localStorage, and a subscriber
// list that must not leak.

describe('[pure] lightweight mode', () => {
  const KEY = 'orbital:lightweight';

  beforeEach(() => {
    localStorage.clear();
    document.body.className = '';
    jest.resetModules();
  });

  const load = () => require('../lightweightMode');

  it('defaults off with no stored flag', () => {
    expect(load().isLightweight()).toBe(false);
    expect(document.body.classList.contains('lightweight')).toBe(false);
  });

  it('survives a reload — the stored flag is read at import', () => {
    localStorage.setItem(KEY, '1');
    const m = load();
    expect(m.isLightweight()).toBe(true);
    // Stamped before first paint so a reload never flashes the expensive
    // treatment before the class lands.
    expect(document.body.classList.contains('lightweight')).toBe(true);
  });

  it('persists on, and clears the key rather than storing "0"', () => {
    const m = load();
    m.setLightweight(true);
    expect(m.isLightweight()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    m.setLightweight(false);
    expect(m.isLightweight()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drives the body class both ways', () => {
    const m = load();
    m.setLightweight(true);
    expect(document.body.classList.contains('lightweight')).toBe(true);
    m.setLightweight(false);
    expect(document.body.classList.contains('lightweight')).toBe(false);
  });

  it('notifies subscribers on change and not on a no-op', () => {
    const m = load();
    const seen: boolean[] = [];
    m.subscribeLightweight((on: boolean) => seen.push(on));
    m.setLightweight(true);
    m.setLightweight(true);      // already on — must not re-notify
    m.setLightweight(false);
    expect(seen).toEqual([true, false]);
  });

  it('stops notifying after unsubscribe', () => {
    const m = load();
    const seen: boolean[] = [];
    const off = m.subscribeLightweight((on: boolean) => seen.push(on));
    m.setLightweight(true);
    off();
    m.setLightweight(false);
    expect(seen).toEqual([true]);
  });

  // ------------------------------------------------------------
  // The cosmetic ship spin — the thing Lorne actually saw still moving
  // ------------------------------------------------------------
  describe('cosmetic ship spin', () => {
    it('freezes the spin clock, parking hulls at their TRUE angle', () => {
      localStorage.setItem(KEY, '1');
      const { spinNowMs } = require('../tickPhase');
      // A frozen clock means lapFraction 0, which makes shipDisplayTick
      // an identity on t.
      expect(spinNowMs()).toBe(0);
      const { shipDisplayTick } = require('../tickPhase');
      for (const [t, period] of [[10, 39], [0, 100], [123.5, 7]]) {
        expect(shipDisplayTick(t, period, spinNowMs())).toBe(t);
      }
    });

    it('still spins when lightweight is off', () => {
      const { spinNowMs, shipDisplayTick, SHIP_VISUAL_ORBIT_MS } = require('../tickPhase');
      expect(spinNowMs()).toBeGreaterThan(0);
      // Mid-lap must displace t; this is the animation being removed.
      const mid = SHIP_VISUAL_ORBIT_MS / 2;
      expect(shipDisplayTick(10, 40, mid)).toBeCloseTo(10 + 20, 6);
    });

    it('pins the animation clock to zero so age math goes negative', () => {
      // Every wall-clock effect is a phase function of ctx.nowMs, and the
      // transient flashes bail on age < 0 rather than freezing mid-bloom.
      const { FROZEN_ANIM_MS } = load();
      expect(FROZEN_ANIM_MS).toBe(0);
      const realStamp = 1234;              // any performance.now() value
      expect(FROZEN_ANIM_MS - realStamp).toBeLessThan(0);
    });
  });

  it('caps frames below the phone cap but never stops the clock', () => {
    const { LIGHTWEIGHT_MIN_FRAME_MS } = load();
    // Must be SLOWER than the 30fps phone cap to buy anything...
    expect(LIGHTWEIGHT_MIN_FRAME_MS).toBeGreaterThan(1000 / 30);
    // ...and must stay finite. Bodies orbit continuously and ships
    // interpolate between ticks, so a zero-frame renderer would freeze
    // the system between polls rather than merely simplify it.
    expect(Number.isFinite(LIGHTWEIGHT_MIN_FRAME_MS)).toBe(true);
    expect(LIGHTWEIGHT_MIN_FRAME_MS).toBeLessThanOrEqual(1000 / 10);
  });
});
