// The Growth tab's frame: four headline cards, section tabs that remember
// the last one, and one Sources table in place of two that listed the same
// sources.

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Growth, Overview } from '../AdminOverview';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / DAY) * DAY + 3_600_000;
const today = Math.floor(NOW / DAY) * DAY;
const funnel = { visitors: 0, players: 0, engaged: 0, pressed_play: 0, tried: 0, started: 0, errors: 0, signed_up: 0, seated: 0, came_back: 0 };
const cohort = (i: number, size: number) => ({
  week_ms: today - (5 - i) * 7 * DAY, size, seated: 0, played: 0, r1: 1, r7: 0, r14: 0, r28: 0, e1: 4, e7: 0, e14: 0, e28: 0,
});

const data = {
  now: NOW,
  rollup: { through_ms: NOW, behind_ms: null },
  kpis: {} as never, daily: [], heat_grid: [], usage: [],
  cohorts: [74, 52, 34, 21, 54].map((s, i) => cohort(i, s)),
  sources: [
    { source: 'r-space', signups: 12, signups_30d: 12, joined: 8, came_back: 0, latest_ms: NOW, referrers: null },
    { source: 'direct', signups: 72, signups_30d: 72, joined: 40, came_back: 10, latest_ms: NOW, referrers: null },
  ],
  journey: {
    signed_up: 84, eligible_1d: 80, eligible_7d: 60,
    steps: [
      { id: 'played', label: 'Opened the game', n: 80, median_ms: 1000 },
      { id: 'seated', label: 'Took a seat in a game', n: 45, median_ms: 2000 },
    ],
  },
  traffic: {
    campaigns: [{ ...funnel, source: 'r-space', campaign: '', phones: 0, clicks: 0, latest_ms: NOW, visitors: 217 }],
    ads: [], devices: [], countries: [],
    daily: [
      { ...funnel, day_ms: today - DAY, source: 'r-space', visitors: 200 },
      { ...funnel, day_ms: today, source: 'r-space', visitors: 17 },
      { ...funnel, day_ms: today, source: 'reddit', visitors: 30 },
    ],
  },
} as unknown as Overview;

let host: HTMLDivElement;
let root: Root;
const show = (d: Overview) => act(() => { root.render(<Growth data={d} />); });
const buttons = () => [...host.querySelectorAll('button')] as HTMLButtonElement[];
const tab = (label: string) => buttons().find(b => b.getAttribute('role') === 'tab' && b.textContent === label)!;
const click = (el: HTMLElement) => act(() => { el.click(); });

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

test('four headline cards: visits, signups, seats and the next-day return', () => {
  show(data);
  const cards = [...host.querySelectorAll('.gr-kpi')].map(c => c.textContent ?? '');
  expect(cards).toHaveLength(4);
  expect(cards[0]).toContain('Visits');
  expect(cards[0]).toContain('247'); // 200 + 17 + 30
  expect(cards[1]).toContain('Signed up');
  expect(cards[1]).toContain('84'); // 12 + 72
  expect(cards[2]).toContain('Took a seat');
  expect(cards[2]).toContain('45');
  expect(cards[2]).toContain('54%'); // 45 of 84
  expect(cards[3]).toContain('Came back the next day');
});

test('it opens on Acquisition: the chart, the link generator and ONE Sources panel', () => {
  show(data);
  expect(tab('Acquisition').getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).toContain('Link generator');
  expect(host.textContent).toContain('Per source, per day');
  expect(host.textContent).toContain('New accounts per week');
  expect(host.textContent).not.toContain('Where players came from');
  expect(host.textContent).not.toContain('Link and ad traffic');
  const panelTitles = [...host.querySelectorAll('.ao-phead__title')].map(h => h.textContent);
  expect(panelTitles.filter(t => t === 'Sources')).toHaveLength(1);
});

test('the Sources table opens on the visit funnel, every column the old traffic table had', () => {
  show(data);
  const heads = [...host.querySelectorAll('thead th')].map(h => h.textContent ?? '').join('|');
  for (const col of ['Source', 'Campaign', 'Visitors', 'Engaged', 'Pressed Play', 'Trial game', 'Started sign-up',
    'Errors', 'Signed up', 'Took a seat', 'Came back', 'On a phone', 'Ad clicks', 'Latest']) {
    expect(heads).toContain(col);
  }
  expect(host.textContent).toContain('217');
});

test('the other panels live on their own tabs, nothing removed', () => {
  show(data);
  click(tab('Activation'));
  expect(host.textContent).toContain('What new players actually do');
  expect(host.textContent).not.toContain('Link generator');
  click(tab('Retention'));
  expect(host.textContent).toContain('Do new players come back?');
  expect(buttons().some(b => b.textContent === 'Invites')).toBe(false); // an older server sends none
});

test('Accounts shows the account table with a Visits column, and Visits by campaign brings the funnel back', () => {
  show(data);
  click(buttons().find(b => b.textContent === 'Accounts')!);
  const heads = [...host.querySelectorAll('thead th')].map(h => h.textContent);
  expect(heads.slice(0, 3)).toEqual(['Source', 'Visits', 'Signups']);
  const row = [...host.querySelectorAll('tbody tr')].find(r => r.textContent?.startsWith('r-space'))!;
  expect(row.textContent).toContain('217');
  const direct = [...host.querySelectorAll('tbody tr')].find(r => r.textContent?.startsWith('direct'))!;
  expect(direct.textContent).toContain('—'); // a typed address has no visits to count
  click(buttons().find(b => b.textContent === 'Visits by campaign')!);
  expect([...host.querySelectorAll('thead th')].map(h => h.textContent).join('|')).toContain('Campaign');
});

test('the glossary starts closed', () => {
  show(data);
  expect(host.textContent).toContain('What each column means');
  expect(host.querySelector('details.ao-gloss')!.hasAttribute('open')).toBe(false);
});

test('the tab you left open is the one you come back to', () => {
  show(data);
  click(tab('Retention'));
  act(() => root.unmount());
  root = createRoot(host);
  show(data);
  expect(tab('Retention').getAttribute('aria-selected')).toBe('true');
});

test('without traffic data it still works: no Visits card, no chart', () => {
  show({ ...data, traffic: undefined } as Overview);
  const cards = [...host.querySelectorAll('.gr-kpi')].map(c => c.textContent ?? '');
  expect(cards).toHaveLength(3);
  expect(cards.some(c => c.includes('Visits'))).toBe(false);
  expect(host.textContent).not.toContain('Link generator');
  expect([...host.querySelectorAll('thead th')].map(h => h.textContent)[1]).toBe('Signups');
});
