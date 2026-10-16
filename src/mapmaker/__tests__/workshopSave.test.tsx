/**
 * The workshop's saving (review, 2026-10-15, H1-H3 and 8):
 *  - text typed into a field whose inspector goes away before it blurs
 *    is still saved (it used to leave a "pending" edit that stopped the
 *    autosave for good);
 *  - an edit made while a save is in flight is saved after it;
 *  - a map deleted elsewhere saves as a new map; one saved elsewhere
 *    since it was opened is never written over;
 *  - a focus and blur on an untouched template saves nothing.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { blankMap, normalizeMap, type CustomMap, type MapBody } from '../../game/customMap';

type Call = { path: string; method: string; body: Record<string, unknown> | null };
type Res = { ok: boolean; status: number; data?: unknown; error?: { code: string; message: string } | null };
const mockCalls: Call[] = [];
let mockAnswer: (c: Call) => Res | Promise<Res> = () => ({ ok: true, status: 200, data: { maps: [], can_host: false } });
jest.mock('../../multiplayer/api', () => ({
  apiFetch: (path: string, init: RequestInit = {}) => {
    const c = { path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    mockCalls.push(c);
    return Promise.resolve(mockAnswer(c));
  },
  startCommissionCheckout: () => Promise.resolve(null),
}));

// eslint-disable-next-line import/first
import { Workshop } from '../MapMaker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class RO { observe() { /* jsdom has no layout */ } disconnect() { /* nothing to undo */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;

const body = (id: string, over: Partial<MapBody> = {}): MapBody => ({
  id, name: id.toUpperCase(), type: 'terrestrial', parent: 'sun', orbit: 300, angle: 0, radius: 3,
  yields: { metal: 3, credits: 3, science: 3 }, color: '#4f8a3c', surface: 'verdant', rings: false, start: false, secret: null,
  ...over,
} as MapBody);
const MAP: CustomMap = normalizeMap({ ...blankMap('Test'), bodies: [body('pa'), body('pb', { orbit: 900 })] });
const summary = (id: string, updated: number) => ({
  id, name: 'Test', share_code: 'ORB-AAAA-BBBB', updated_ms: updated, hosted_count: 0, bodies: 2, blockers: 0, warnings: 0, sun_color: '#ffd180',
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  jest.useFakeTimers();
  mockCalls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
  try { localStorage.clear(); } catch { /* none */ }
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const tick = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
function typeInto(el: HTMLTextAreaElement, text: string) {
  act(() => { el.focus(); setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const pitch = () => host.querySelector('textarea[aria-label="Map pitch"]') as HTMLTextAreaElement;
const saves = () => mockCalls.filter(c => c.method === 'PUT' || c.method === 'POST');

function open(id: string | null, base: number | null = 100) {
  act(() => root.render(<Workshop initial={MAP} initialId={id} opts={{ base }} onExit={() => { /* stays */ }} />));
}

it('text typed into a field that goes away before it blurs is still autosaved', async () => {
  mockAnswer = (c) => (c.method === 'PUT' ? { ok: true, status: 200, data: { map: c.body!.map, summary: summary('map_a', 200) } } : { ok: true, status: 200, data: { maps: [], can_host: false } });
  open('map_a');
  typeInto(pitch(), 'Six worlds round a hungry sun.');
  // Select the sun in the tree: the map inspector (and its textarea) goes.
  const sunRow = [...host.querySelectorAll('button.mm-tree__row')].find(b => b.textContent?.includes('SUN')) as HTMLButtonElement;
  act(() => { sunRow.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await tick(3500);
  const put = saves();
  expect(put).toHaveLength(1);
  expect((put[0].body!.map as CustomMap).blurb).toBe('Six worlds round a hungry sun.');
  expect(put[0].body!.base_updated_ms).toBe(100);
});

it('an edit made while a save is in flight is saved after it', async () => {
  let release: (r: Res) => void = () => { /* set below */ };
  let n = 0;
  mockAnswer = (c) => {
    if (c.method !== 'PUT') return { ok: true, status: 200, data: { maps: [], can_host: false } };
    n++;
    const r = { ok: true, status: 200, data: { map: c.body!.map, summary: summary('map_a', 100 + n * 100) } };
    return n === 1 ? new Promise<Res>(res => { release = () => res(r); }) : r;
  };
  open('map_a');
  typeInto(pitch(), 'First.');
  act(() => pitch().blur());
  await tick(3500);
  expect(saves()).toHaveLength(1);
  // Edit while that save hangs, then let it finish.
  typeInto(pitch(), 'Second.');
  act(() => pitch().blur());
  await tick(3500);
  await act(async () => { release({ ok: true, status: 200 }); });
  await flush();
  await tick(3500);
  const all = saves();
  expect(all.length).toBeGreaterThanOrEqual(2);
  const last = all[all.length - 1];
  expect((last.body!.map as CustomMap).blurb).toBe('Second.');
  // ...from the base the first save answered with.
  expect(last.body!.base_updated_ms).toBe(200);
});

it('a map deleted elsewhere saves as a new map', async () => {
  mockAnswer = (c) => (c.method === 'PUT' ? { ok: false, status: 404, error: { code: 'not_found', message: 'map not found' } }
    : c.method === 'POST' ? { ok: true, status: 201, data: { map: c.body!.map, summary: summary('map_new', 300) } }
      : { ok: true, status: 200, data: { maps: [], can_host: false } });
  open('map_gone');
  typeInto(pitch(), 'Still here.');
  act(() => pitch().blur());
  await tick(3500);
  expect(saves().map(c => c.method)).toEqual(['PUT', 'POST']);
  expect(host.textContent).toContain('All changes saved');
});

it('a map saved elsewhere since it was opened is not written over: this version becomes "(conflict)"', async () => {
  mockAnswer = (c) => (c.method === 'PUT' ? { ok: false, status: 409, error: { code: 'stale', message: 'stale' } }
    : c.method === 'POST' ? { ok: true, status: 201, data: { map: c.body!.map, summary: { ...summary('map_new', 300), name: 'Test (conflict)' } } }
      : { ok: true, status: 200, data: { maps: [], can_host: false } });
  open('map_a');
  typeInto(pitch(), 'Mine.');
  act(() => pitch().blur());
  await tick(3500);
  const all = saves();
  expect(all.map(c => c.method)).toEqual(['PUT', 'POST']);
  expect((all[1].body!.map as CustomMap).name).toBe('Test (conflict)');
  expect(host.textContent).toContain('saved as a new map');
});

it('a focus and blur on an untouched template saves nothing and leaves nothing to undo', async () => {
  open(null, null);
  act(() => { pitch().focus(); pitch().blur(); });
  await tick(5000);
  expect(saves()).toHaveLength(0);
  const undo = host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
  expect(undo.disabled).toBe(true);
  expect(host.textContent).toContain('Not saved yet');
});
