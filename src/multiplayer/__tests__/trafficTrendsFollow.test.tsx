// The referral chart follows the top five by itself: the dashboard re-reads
// its data every minute, and a new source that climbs in must be drawn
// without anyone clicking it. A hand pick is the viewer's own.

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { TrafficTrends, TrendConfig, TrendRow } from '../AdminTrafficTrends';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / DAY) * DAY + 3_600_000;
const cfg: TrendConfig = {
  title: 'Per source, per day',
  metrics: [{ key: 'visitors', label: 'Visitors' }, { key: 'signed_up', label: 'Signed up' }],
  name: (s) => s,
  store: 'test.follow',
  item: ['source', 'sources'],
  base: 'visitors',
};
/** One row per source for each of the last 3 days. */
const rowsFor = (volumes: Record<string, number>): TrendRow[] =>
  Object.entries(volumes).flatMap(([source, v]) =>
    [2, 1, 0].map(d => ({ day_ms: Math.floor(NOW / DAY) * DAY - d * DAY, source, visitors: v, signed_up: 0 })));

const BASE = { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10 };

let host: HTMLDivElement;
let root: Root;
const show = (volumes: Record<string, number>) =>
  act(() => { root.render(<TrafficTrends rows={rowsFor(volumes)} now={NOW} config={cfg} />); });
const buttons = () => [...host.querySelectorAll('button')] as HTMLButtonElement[];
const chip = (name: string) => {
  const b = buttons().find(x => x.classList.contains('tt-chip') && x.textContent?.startsWith(name) && /^\d/.test((x.textContent ?? '').slice(name.length)));
  if (!b) throw new Error(`no chip for ${name}`);
  return b;
};
const drawn = (name: string) => chip(name).getAttribute('aria-pressed') === 'true';
const press = (label: string) => act(() => { buttons().find(b => b.textContent === label)!.click(); });
const following = () => host.textContent?.includes('following the top 5') ?? false;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
});
beforeEach(() => {
  try { localStorage.clear(); } catch { /* */ }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('a new source that climbs into the top five is drawn without a click', () => {
  show(BASE);
  expect(['a', 'b', 'c', 'd', 'e'].every(drawn)).toBe(true);
  expect(drawn('f')).toBe(false);
  // The next minute's read brings a referral link that is suddenly the busiest.
  show({ ...BASE, newcomer: 100 });
  expect(drawn('newcomer')).toBe(true);
  expect(drawn('e')).toBe(false); // the fifth place made room
  expect(['a', 'b', 'c', 'd'].every(drawn)).toBe(true);
  expect(following()).toBe(true);
});

test('a quiet new source gets a chip but no line', () => {
  show(BASE);
  show({ ...BASE, quiet: 1 });
  expect(chip('quiet')).toBeTruthy();
  expect(drawn('quiet')).toBe(false);
});

test('picking by hand stops the following', () => {
  show(BASE);
  act(() => { chip('f').click(); }); // a sixth line, by choice
  expect(following()).toBe(false);
  show({ ...BASE, newcomer: 100 });
  expect(drawn('newcomer')).toBe(false); // the viewer's picks are left alone
  expect(drawn('f')).toBe(true);
  expect(drawn('e')).toBe(true);
});

test('Top 5 starts following again', () => {
  show(BASE);
  press('Clear');
  expect(drawn('a')).toBe(false);
  press('Top 5');
  show({ ...BASE, newcomer: 100 });
  expect(drawn('newcomer')).toBe(true);
});

test('a choice saved before following existed stays a hand pick', () => {
  localStorage.setItem('test.follow', JSON.stringify({ picked: ['f'] }));
  show(BASE);
  expect(drawn('f')).toBe(true);
  expect(drawn('a')).toBe(false);
  show({ ...BASE, newcomer: 100 });
  expect(drawn('newcomer')).toBe(false);
});
