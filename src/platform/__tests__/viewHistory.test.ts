// Back and Forward walk home page -> lobby -> game (playtest 2026-10-24, D7).
// A fake History with a real stack, so back() is what a browser does.
import { syncView, viewOf, resetViewHistory, type AppView } from '../viewHistory';

class FakeHistory {
  entries: Array<{ state: unknown; url: string }> = [{ state: null, url: '/' }];
  i = 0;
  onPop: ((state: unknown) => void) | null = null;
  get state() { return this.entries[this.i].state; }
  get length() { return this.entries.length; }
  pushState(state: unknown, _t: string, url?: string) {
    this.entries.length = this.i + 1;
    this.entries.push({ state, url: url ?? this.entries[this.i].url });
    this.i++;
  }
  replaceState(state: unknown, _t: string, url?: string) {
    this.entries[this.i] = { state, url: url ?? this.entries[this.i].url };
  }
  back() { if (this.i > 0) { this.i--; this.onPop?.(this.state); } }
  forward() { if (this.i < this.entries.length - 1) { this.i++; this.onPop?.(this.state); } }
}

const loc = { pathname: '/', search: '', hash: '' } as Location;
const lobby: AppView = { view: 'lobby' };
const game = (roomId: string): AppView => ({ view: 'game', roomId });

function setup() {
  resetViewHistory();
  const h = new FakeHistory();
  // The app: shows whatever the popped entry names, then re-syncs (a no-op).
  let shown: AppView | null = null;
  const show = (v: AppView) => { shown = v; syncView(v, h as unknown as History, loc); };
  h.onPop = (state) => { const v = viewOf(state); if (v) show(v); };
  return { h, show, shown: () => shown };
}

describe('view history', () => {
  it('Back from the lobby goes home; Back from a game goes to the lobby', () => {
    const { h, show, shown } = setup();
    show(lobby);                         // launch lands in the lobby
    expect(h.entries.map(e => viewOf(e.state)?.view)).toEqual(['landing', 'lobby']);
    show(game('r1'));                    // Enter a game
    expect(h.length).toBe(3);
    h.back();
    expect(shown()).toEqual(lobby);
    h.back();
    expect(shown()).toEqual({ view: 'landing' });
    h.forward();
    h.forward();
    expect(shown()).toEqual(game('r1'));
    expect(h.entries.every(e => e.url === '/')).toBe(true);   // "/" serves every view
  });

  it('leaving a game from its menu steps back instead of piling up entries', () => {
    const { h, show } = setup();
    show(lobby);
    show(game('r1'));
    show(lobby);                          // the in-game Leave button
    expect(h.i).toBe(1);
    expect(h.length).toBe(3);             // Forward still reaches the game
    show(game('r2'));                     // a different game replaces it
    expect(h.length).toBe(3);
    expect(viewOf(h.state)).toEqual(game('r2'));
  });

  it('a launch straight into a game still has the lobby and home behind it', () => {
    const { h, show, shown } = setup();
    show(game('trial'));
    expect(h.entries.map(e => viewOf(e.state)?.view)).toEqual(['landing', 'game']);
    show(lobby);                          // pushes: the lobby was never below it
    h.back();
    expect(shown()).toEqual(game('trial'));
  });

  it('a reload keeps the stack it finds', () => {
    const { h, show } = setup();
    show(lobby);
    show(game('r1'));
    resetViewHistory();                   // the page reloads; history survives
    show(game('r1'));
    expect(h.length).toBe(3);
  });

  it('ignores entries it did not tag', () => {
    expect(viewOf(null)).toBeNull();
    expect(viewOf({ tab: 'howto' })).toBeNull();
    expect(viewOf({ 'orbital:back-guard': true })).toBeNull();
    expect(viewOf({ orbitalView: 'game' })).toBeNull();
  });
});
