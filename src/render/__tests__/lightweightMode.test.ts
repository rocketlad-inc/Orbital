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
