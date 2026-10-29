// Direct visits: a browser that arrives with no tag and no referring site
// (typed address, bookmark) is reported as a landing the first time it
// shows up, so the traffic table has a "direct" line. Later loads of the
// same browser do not report again; an informative arrival always does.
import { captureAttribution } from '../attribution';
// @ts-ignore — plain JS worker module
import { readAttribution } from '../../../worker/attribution.js';

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

  it('files a visit from TikTok’s built-in browser under tiktok, though it sends no referrer', () => {
    const real = navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 musical_ly_2024 BytedanceWebview/d8a21c6',
    });
    try {
      visit('/');
      const a = lands()[0]!.body.a as Record<string, unknown>;
      expect(a.referrer).toBe('tiktok.com');
      expect(a.in_app).toBe('tiktok');
      expect(readAttribution(a)!.source).toBe('tiktok');
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: real });
    }
  });

  it('keeps a link tag over the TikTok guess, and never guesses for other browsers', () => {
    const real = navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 TikTok 38.0' });
    try {
      visit('/?from=tt-launch');
      expect(readAttribution(lands()[0]!.body.a as Record<string, unknown>)!.source).toBe('tt-launch');
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: real });
    }
    calls = [];
    window.localStorage.clear();
    visit('/');
    expect((lands()[0]!.body.a as Record<string, unknown>).referrer).toBeUndefined();
  });

  it('reports a referred arrival as before', () => {
    visit('/', 'https://www.google.com/');
    expect(lands()).toHaveLength(1);
    expect((lands()[0]!.body.a as Record<string, unknown>).referrer).toBe('www.google.com');
  });
});
