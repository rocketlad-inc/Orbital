/**
 * The end-of-game page, mounted the way the provider mounts it: EndingScreen
 * with a `meta` (status 'completed') and a mocked apiFetch. Covers the report
 * arriving (every section renders), the report failing (the verdict, the
 * actions and the Commission still render, quietly), the wait (a skeleton
 * built from meta), who is shown the Commission, and the Portuguese flip.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import type { EndingPayload } from '../endingTypes';

type U = { is_premium?: boolean } | null;
let mockUser: U = { is_premium: false };
let mockSellable = true;

jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../api', () => ({
  apiFetch: jest.fn(),
  startCommissionCheckout: jest.fn(async () => null),
}));
jest.mock('../commission', () => ({
  ...jest.requireActual('../commission'),
  canBuyHere: () => mockSellable,
  openCommissionInBrowser: jest.fn(),
  logCommission: jest.fn(),
}));
jest.mock('../MatchReplay', () => ({ MatchReplay: () => null }));

// eslint-disable-next-line import/first
import { apiFetch, startCommissionCheckout } from '../api';
// eslint-disable-next-line import/first
import { logCommission, openCommissionInBrowser } from '../commission';
// eslint-disable-next-line import/first
import { EndingScreen } from '../EndingScreen';
// eslint-disable-next-line import/first
import { EndingMeta } from '../EndingPage';
// eslint-disable-next-line import/first
import { buildTimeline, withViewer } from '../endingModel';
// eslint-disable-next-line import/first
import { setLang } from '../../i18n/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const load = (id: string): EndingPayload =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '__fixtures__', `ending.${id}.json`), 'utf8'));
const MEGA = load('ghhqbPbWz64Y');
const SIX = load('CAWEFbsSGyBI');
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function metaFor(d: EndingPayload): EndingMeta {
  const me = d.factions.find(f => f.isMe);
  const w = d.factions.find(f => f.id === d.game.winnerFactionId);
  return {
    winnerFactionId: d.game.winnerFactionId,
    winnerName: w?.name ?? null,
    victoryType: d.game.victoryType,
    myFactionId: me?.id ?? null,
    factions: d.factions.map(f => ({ id: f.id, name: f.name, color: f.color, color2: f.color2, emblem: f.emblem, status: f.finalStatus })),
  };
}

let host: HTMLDivElement;
let root: Root;
const returned = jest.fn();

async function mount(meta: EndingMeta, answer: () => Promise<unknown>) {
  (apiFetch as jest.Mock).mockImplementation(async (p: string) => (p.includes('/ending') ? answer() : { ok: true, status: 200, data: {} }));
  await act(async () => { root.render(<EndingScreen gameId="g1" meta={meta} onReturn={returned} />); });
  await act(async () => { await Promise.resolve(); });
  // The screen is a lazy chunk and its data a mocked fetch: under a loaded
  // machine (the full suite) two microtask flushes are not always enough, so
  // wait, boundedly, until the page has actually drawn its actions.
  for (let i = 0; i < 60 && !/Return to lobby/.test(host.textContent ?? ''); i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
  }
}
const text = () => host.textContent ?? '';
const button = (label: RegExp) => Array.from(host.querySelectorAll('button')).find(b => label.test(b.textContent ?? ''));

beforeEach(() => {
  mockUser = { is_premium: false };
  mockSellable = true;
  try { localStorage.clear(); } catch { /* fine */ }
  setLang('en', false);
  (startCommissionCheckout as jest.Mock).mockReset().mockResolvedValue(null);
  (logCommission as jest.Mock).mockReset();
  (openCommissionInBrowser as jest.Mock).mockReset();
  returned.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('EndingScreen: the report arrives', () => {
  it('renders the verdict, your empire, standings, superlatives, the shape of the game and the actions', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).toContain('Stonekin of Mars');
    expect(text()).toContain('Elected Supreme Chancellor by the Senate');
    expect(text()).toContain('Your empire');
    expect(text()).toContain('2nd');
    expect(text()).toContain('Final standings');
    expect(text()).toContain('Superlatives');
    expect(text()).toContain('Warmonger');
    expect(text()).toContain('The shape of the game');
    expect(host.querySelectorAll('svg[role="img"]').length).toBeGreaterThanOrEqual(3);
    expect(text()).toContain('The biggest fights');
    expect(button(/Watch the match film/)).toBeDefined();
    expect(button(/Return to lobby/)).toBeDefined();
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false');
  });

  it('VICTORY for the winner, and a spectator gets no Your-empire card', async () => {
    const win = withViewer(MEGA, 'winner');
    await mount(metaFor(win), async () => ({ ok: true, status: 200, data: win }));
    expect(host.querySelector('h1')?.textContent).toBe('VICTORY');
    act(() => root.unmount());
    root = createRoot(host);
    const spec = withViewer(MEGA, 'none');
    await mount(metaFor(spec), async () => ({ ok: true, status: 200, data: spec }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).not.toContain('Your empire');
    expect(text()).toContain('Final standings');
  });

  it('a game with few awards shows only those, with no empty group', async () => {
    const d = withViewer(SIX, 'winner');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    expect(host.querySelectorAll('.ep-aw')).toHaveLength(9);
  });

  it('flips to Portuguese live with numbers read the Portuguese way', async () => {
    const d = withViewer(SIX, 'winner');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    await act(async () => { setLang('pt-BR', false); });
    expect(host.querySelector('h1')?.textContent).toBe('VITÓRIA');
    expect(text()).toContain('Classificação final');
    expect(text()).toContain('6.233');
    expect(text()).toContain('1º');
  });
});

describe('EndingScreen: the report fails', () => {
  it.each([404, 403, 409, 500])('falls back to the verdict, the actions and the Commission on a %i', async (status) => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), async () => ({ ok: false, status, error: null }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).toContain('Stonekin of Mars');
    expect(text()).not.toContain('Final standings');
    expect(host.querySelectorAll('svg[role="img"]')).toHaveLength(0);
    expect(button(/Return to lobby/)).toBeDefined();
    expect(button(/Take a look/)).toBeDefined();
    expect(text().toLowerCase()).not.toContain('error');
    expect(text().toLowerCase()).not.toContain('failed');
  });

  it('a thrown fetch is the same quiet fallback', async () => {
    const d = withViewer(MEGA, 'winner');
    await mount(metaFor(d), async () => { throw new Error('offline'); });
    expect(host.querySelector('h1')?.textContent).toBe('VICTORY');
    expect(button(/Return to lobby/)).toBeDefined();
  });
});

describe('EndingScreen: while it loads', () => {
  it('shows the result from meta at once, as a skeleton', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), () => new Promise(() => { /* never answers */ }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).toContain('Stonekin of Mars');
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('.ep-skel').length).toBeGreaterThan(0);
    expect(text()).not.toContain('Final standings');
  });
});

describe('EndingScreen: who is shown the Commission', () => {
  const ok = (d: EndingPayload) => async () => ({ ok: true, status: 200, data: d });

  it('an empire that survived, not a holder: shown, once, with the right button', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    expect(text()).toContain('Same empire, new lines.');
    expect(text()).toContain('Nothing that changes the game.');
    expect(text()).toContain('$10, once');
    // jsdom has no IntersectionObserver, so the view logs at once
    expect(logCommission).toHaveBeenCalledWith('endgame', 'view');
    expect(localStorage.getItem('orbital.commission.endgame.g1')).not.toBeNull();
    act(() => { button(/Take a look/)?.click(); });
    expect(logCommission).toHaveBeenCalledWith('endgame', 'click');
    expect(startCommissionCheckout).toHaveBeenCalledWith('endgame');
  });

  it('draws the plug ships in the viewer\'s own colours', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    const html = host.querySelector('.ep-cm__fleet')?.innerHTML.toLowerCase() ?? '';
    expect(host.querySelectorAll('.ep-cm__sh svg')).toHaveLength(10);
    expect(html).toContain('#26c6da'); // Tritalowda's colour
  });

  it('not again for the same game', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    localStorage.setItem('orbital.commission.endgame.g1', '1');
    await mount(metaFor(d), ok(d));
    expect(text()).not.toContain('Same empire, new lines.');
    expect(logCommission).not.toHaveBeenCalled();
  });

  it('not to an eliminated empire, a holder, a spectator or a signed-out viewer', async () => {
    const gone = withViewer(MEGA, 'Ember Syndicate');
    await mount(metaFor(gone), ok(gone));
    expect(text()).not.toContain('Same empire, new lines.');
    act(() => root.unmount()); root = createRoot(host);

    mockUser = { is_premium: true };
    const tri = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(tri), ok(tri));
    expect(text()).not.toContain('Same empire, new lines.');
    act(() => root.unmount()); root = createRoot(host);

    mockUser = { is_premium: false };
    const spec = withViewer(MEGA, 'none');
    await mount(metaFor(spec), ok(spec));
    expect(text()).not.toContain('Same empire, new lines.');
    act(() => root.unmount()); root = createRoot(host);

    mockUser = null;
    await mount(metaFor(tri), ok(tri));
    expect(text()).not.toContain('Same empire, new lines.');
  });

  it('in the Android app the button opens the phone\'s browser instead of selling', async () => {
    mockSellable = false;
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    act(() => { button(/Get it in your browser/)?.click(); });
    expect(openCommissionInBrowser).toHaveBeenCalledWith('endgame');
    expect(startCommissionCheckout).not.toHaveBeenCalled();
  });

  it('is never above the verdict', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    const h1 = host.querySelector('h1') as Element;
    const plug = host.querySelector('.ep-cm') as Element;
    expect(h1.compareDocumentPosition(plug) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('EndingScreen: the actions', () => {
  it('Return to lobby calls back, and the film opens in the page and replaces the plug', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    expect(host.querySelector('.ep-cm')).not.toBeNull();
    await act(async () => { button(/Watch the match film/)?.click(); });
    expect(host.querySelector('.ep-film')).not.toBeNull();
    expect(host.querySelector('.ep-cm')).toBeNull();
    expect(button(/Hide the match film/)).toBeDefined();
    act(() => { button(/Return to lobby/)?.click(); });
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('Escape does nothing destructive', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    act(() => { host.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(returned).not.toHaveBeenCalled();
    expect(host.querySelector('h1')).not.toBeNull();
  });
});

describe('EndingScreen: the timeline', () => {
  const ok = (d: EndingPayload) => async () => ({ ok: true, status: 200, data: d });

  it('sits between the standings and the superlatives, as an ordered list', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    const sections = Array.from(host.querySelectorAll('section[aria-labelledby]')).map(s => s.getAttribute('aria-labelledby'));
    expect(sections.indexOf('ep-standings-h')).toBeGreaterThanOrEqual(0);
    expect(sections.indexOf('ep-tl-h')).toBe(sections.indexOf('ep-standings-h') + 1);
    expect(sections.indexOf('ep-awards-h')).toBe(sections.indexOf('ep-tl-h') + 1);
    const list = host.querySelector('ol.ep-tl') as HTMLOListElement;
    expect(list.querySelectorAll(':scope > li')).toHaveLength(MEGA.timeline.length);
    expect(text()).toContain('How it unfolded');
    expect(text()).toContain('The game begins');
    expect(text()).toContain('Day 1');
    expect(text()).toContain('Stonekin of Mars wins');
  });

  it('every clipped battle is a real link to its recap, with an aria-label naming the battle', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    const links = Array.from(host.querySelectorAll('a.ep-btn--clip')) as HTMLAnchorElement[];
    const clips = MEGA.timeline.filter(m => m.clip);
    expect(links).toHaveLength(clips.length);
    expect(links.map(a => a.getAttribute('href'))).toEqual(clips.map(m => m.clip?.path));
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('aria-label')).toMatch(/^Watch the replay clip: Battle of /);
      expect(a.textContent).toContain('Watch the clip');
    }
  });

  it('YOU tags follow the viewer', async () => {
    const d = withViewer(MEGA, 'Tritalowda');
    await mount(metaFor(d), ok(d));
    const tagged = host.querySelectorAll('.ep-tl .ep-tl-kind .ep-tag--you').length;
    const expected = buildTimeline(d).filter(r => r.mine).length;
    expect(tagged).toBe(expected);
    expect(tagged).toBeGreaterThan(0);
  });

  it('is hidden for a missing or tiny timeline', async () => {
    const none = clone(withViewer(MEGA, 'winner')) as Partial<EndingPayload>;
    delete none.timeline;
    await mount(metaFor(none as EndingPayload), ok(none as EndingPayload));
    expect(host.querySelector('ol.ep-tl')).toBeNull();
    expect(text()).toContain('Final standings');
    act(() => root.unmount()); root = createRoot(host);
    const tiny = clone(withViewer(MEGA, 'winner'));
    tiny.timeline = tiny.timeline.slice(0, 2);
    await mount(metaFor(tiny), ok(tiny));
    expect(host.querySelector('ol.ep-tl')).toBeNull();
  });

  it('reads in Portuguese, with the Portuguese day label and sentences', async () => {
    const d = withViewer(SIX, 'winner');
    await mount(metaFor(d), ok(d));
    await act(async () => { setLang('pt-BR', false); });
    expect(text()).toContain('Como tudo aconteceu');
    expect(text()).toContain('O jogo começa');
    expect(text()).toContain('Dia 1');
    expect(text()).toContain('Assistir ao clipe');
    expect(text()).toMatch(/declara guerra a/);
  });
});
