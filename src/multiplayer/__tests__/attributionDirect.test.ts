// Direct visits: a browser that arrives with no tag and no referring site
// (typed address, bookmark) is reported as a landing the first time it
// shows up, so the traffic table has a "direct" line. Later loads of the
// same browser do not report again; an informative arrival always does.
import { captureAttribution } from '../attribution';

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];

function visit(url: string, referrer = '') {
  window.history.replaceState(null, '', url);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
  captureAttribution();
}
const lands = () => calls.filter(c => c.url === '/api/visit' && c.body.step === 'land');

beforeAll(() => {
  // jsdom has no crypto.getRandomValues, which the browser id needs.
  if (!globalThis.crypto?.getRandomValues) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
    });
  }
});

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({});
  };
});

describe('direct visits', () => {
  it('reports the first untagged, unreferred arrival as a landing', () => {
    visit('/');
    expect(lands()).toHaveLength(1);
    const a = lands()[0]!.body.a as Record<string, unknown>;
    expect(a.from).toBeUndefined();
    expect(a.referrer).toBeUndefined();
    expect(typeof lands()[0]!.body.anon).toBe('string');
  });

  it('does not report the same browser again when it comes back direct', () => {
    visit('/');
    visit('/');
    visit('/how-to-play');
    expect(lands()).toHaveLength(1);
  });

  it('still reports a tagged arrival after a direct one, so the server can take the row over', () => {
    visit('/');
    visit('/?from=r-space', 'https://www.reddit.com/');
    const all = lands();
    expect(all).toHaveLength(2);
    expect((all[1]!.body.a as Record<string, unknown>).from).toBe('r-space');
  });

  it('reports a referred arrival as before', () => {
    visit('/', 'https://www.google.com/');
    expect(lands()).toHaveLength(1);
    expect((lands()[0]!.body.a as Record<string, unknown>).referrer).toBe('www.google.com');
  });
});
