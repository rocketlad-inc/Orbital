/**
 * The profile's trophy case, mounted with a mocked apiFetch: the medals and
 * the recent list when the awards arrive, the empty / loading / "checking"
 * states and their timed re-fetches, the quiet failure, Show all, and the
 * Portuguese flip. The sample is the real fixtures' winners (profileAwardsSample).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import type { EndingPayload } from '../endingTypes';

jest.mock('../api', () => ({ apiFetch: jest.fn() }));

// eslint-disable-next-line import/first
import { apiFetch } from '../api';
// eslint-disable-next-line import/first
import { ProfileAwards } from '../ProfileAwards';
// eslint-disable-next-line import/first
import { buildSample } from '../profileAwardsSample';
// eslint-disable-next-line import/first
import { setLang } from '../../i18n/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const load = (id: string): EndingPayload =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '__fixtures__', `ending.${id}.json`), 'utf8'));
const FIXTURES = [load('sMu08u1ySzRJ'), load('ghhqbPbWz64Y'), load('CAWEFbsSGyBI')];

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const mocked = apiFetch as jest.Mock;

let host: HTMLDivElement;
let root: Root;

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
async function mount(...answers: unknown[]) {
  const queue = [...answers];
  mocked.mockImplementation(async () => (queue.length > 1 ? queue.shift() : queue[0]));
  await act(async () => { root.render(<ProfileAwards />); });
  await flush();
}
const text = () => host.textContent ?? '';
const tiles = () => Array.from(host.querySelectorAll('.pa-tile'));
const rows = () => Array.from(host.querySelectorAll('.pa-row'));
const more = () => host.querySelector<HTMLButtonElement>('.pa-more');

beforeEach(() => {
  setLang('en', false);
  mocked.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); jest.useRealTimers(); });

describe('ProfileAwards: the awards arrive', () => {
  it('asks for the signed-in player\'s awards and draws one medal per kind, then the recent list', async () => {
    await mount(ok(buildSample(FIXTURES)));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][0]).toBe('/api/users/me/awards');

    expect(host.querySelector('h2')?.textContent).toBe('Superlatives');
    expect(text()).toContain('Earned in games you have played to the end');
    // Warmonger, Ace, Heavy hitter, Iron wall, Last stand, Instigator, Landlord,
    // Deepest pockets, Scholar, Shipwright, Master trader, Statesman: all twelve kinds.
    expect(tiles()).toHaveLength(12);
    expect(host.querySelectorAll('ul').length).toBe(2);

    // Most-earned first: Ace and Shipwright were won in all three games.
    const first = tiles()[0];
    expect(first.querySelector('.pa-tile__ttl')?.textContent).toBe('Ace');
    expect(first.querySelector('.pa-tile__count')?.textContent).toContain('×3');
    expect(first.textContent).toContain('28');       // best: Mastodon-69's 28 kills
    expect(first.textContent).toContain('kills');
    expect(first.textContent).toContain('The MEGA Zone');
    // A kind earned once has no count badge.
    const scholar = tiles().find(x => x.querySelector('.pa-tile__ttl')?.textContent === 'Scholar');
    expect(scholar?.querySelector('.pa-tile__count')).toBeNull();
    // A tile does not name the ship; hull awards do that in the recent list.
    expect(first.textContent).not.toContain('Mastodon-69');
  });

  it('lists the latest six with the ship, game, empire, date and tags', async () => {
    await mount(ok(buildSample(FIXTURES)));
    expect(rows()).toHaveLength(6);
    const ace = rows().find(r => r.textContent?.includes('Truman'));
    expect(ace).toBeDefined();
    expect(ace?.textContent).toContain('Truman, Destroyer');
    expect(ace?.textContent).toContain('The NEXT Zone');
    expect(ace?.textContent).toContain('as The Ministry of Silly Wonks');
    expect(ace?.textContent).toContain('Won the game');
    expect(ace?.textContent).toContain('Tied');          // the real tie: 13 kills each
    expect(ace?.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1792252947914).toISOString());
    expect(ace?.querySelector('time')?.textContent).toMatch(/2026/);
    const warmonger = rows().find(r => r.textContent?.includes('Warmonger'));
    expect(warmonger?.textContent).toContain('305');
    expect(warmonger?.textContent).toContain('ships destroyed');
    expect(warmonger?.textContent).not.toContain('Tied');
  });

  it('shows the captain with a hull award when the ship has one', async () => {
    await mount(ok(buildSample(FIXTURES, { many: true })));
    await act(async () => { more()?.click(); });
    expect(text()).toContain('Mastodon-69, Destroyer · Capt. Ahsoka Tano');
  });

  it('Show all reveals the rest (up to 60) and Show fewer puts it back', async () => {
    await mount(ok(buildSample(FIXTURES, { many: true })));
    expect(rows()).toHaveLength(6);
    expect(more()?.textContent).toBe('Show all 60');
    expect(more()?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { more()?.click(); });
    expect(rows()).toHaveLength(60);
    expect(more()?.textContent).toBe('Show fewer');
    expect(more()?.getAttribute('aria-expanded')).toBe('true');
    expect(more()?.getAttribute('aria-controls')).toBe(host.querySelectorAll('ul')[1].id);
    await act(async () => { more()?.click(); });
    expect(rows()).toHaveLength(6);
  });

  it('offers no Show all for six awards or fewer', async () => {
    await mount(ok(buildSample([FIXTURES[0]])));
    expect(rows()).toHaveLength(5);
    expect(more()).toBeNull();
  });
});

describe('ProfileAwards: the quiet states', () => {
  it('shows a skeleton while loading', async () => {
    mocked.mockImplementation(() => new Promise(() => { /* never answers */ }));
    await act(async () => { root.render(<ProfileAwards />); });
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('.pa-skel').length).toBeGreaterThan(0);
    expect(tiles()).toHaveLength(0);
  });

  it('says what earns an award when there are none yet, with no fake medals', async () => {
    await mount(ok({ gamesFinished: 3, gamesWithAwards: 0, totals: [], awards: [], pending: 0 }));
    expect(text()).toContain('Finish a game to start your collection.');
    expect(text()).toContain('most ships destroyed');
    expect(tiles()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
  });

  it.each([
    ['the request fails', { ok: false, status: 500, error: null }],
    ['the player is signed out', { ok: false, status: 401, error: { code: 'unauthorized', message: 'no' } }],
    ['the answer is not the shape we asked for', ok({ nope: true })],
    ['there are no finished games', ok({ gamesFinished: 0, gamesWithAwards: 0, totals: [], awards: [], pending: 0 })],
  ])('is not there at all when %s', async (_why, answer) => {
    await mount(answer);
    expect(host.innerHTML).toBe('');
  });

  it('is not there when the request throws', async () => {
    mocked.mockImplementation(async () => { throw new Error('boom'); });
    await act(async () => { root.render(<ProfileAwards />); });
    await flush();
    expect(host.innerHTML).toBe('');
  });
});

describe('ProfileAwards: past games still being checked', () => {
  const tick = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };

  it('says so, asks again after ~4s, and settles once everything is in', async () => {
    jest.useFakeTimers();
    await mount(
      ok(buildSample(FIXTURES, { games: 1, pending: 2 })),
      ok(buildSample(FIXTURES, { games: 3, pending: 0 })),
    );
    expect(text()).toContain('Checking 2 more past games…');
    expect(tiles().length).toBeGreaterThan(0);
    expect(mocked).toHaveBeenCalledTimes(1);

    await tick(3900);
    expect(mocked).toHaveBeenCalledTimes(1);
    await tick(200);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('Checking');
    expect(rows().length).toBe(6);

    await tick(60_000);
    expect(mocked).toHaveBeenCalledTimes(2);          // nothing pending: no more asking
  });

  it('uses the singular for one game, and shows "checking" alone while nothing is in yet', async () => {
    jest.useFakeTimers();
    await mount(ok({ gamesFinished: 1, gamesWithAwards: 0, totals: [], awards: [], pending: 1 }));
    expect(text()).toContain('Checking 1 more past game…');
    expect(text()).not.toContain('Finish a game');
    expect(tiles()).toHaveLength(0);
  });

  it('keeps asking only while the count shrinks, and never more than four more times', async () => {
    jest.useFakeTimers();
    const step = (pending: number) => ok(buildSample(FIXTURES, { games: 1, pending }));
    await mount(step(9), step(8), step(7), step(6), step(5), step(4), step(3));
    await tick(4000);
    expect(mocked).toHaveBeenCalledTimes(2);
    await tick(5900);
    expect(mocked).toHaveBeenCalledTimes(2);          // the next wait is 6s, not before
    await tick(200);
    expect(mocked).toHaveBeenCalledTimes(3);
    await tick(6000);
    await tick(6000);
    expect(mocked).toHaveBeenCalledTimes(5);          // first load + four re-fetches
    await tick(120_000);
    expect(mocked).toHaveBeenCalledTimes(5);
  });

  it('stops when the count stops shrinking', async () => {
    jest.useFakeTimers();
    await mount(ok(buildSample(FIXTURES, { games: 1, pending: 2 })));   // same answer every time
    await tick(4000);
    expect(mocked).toHaveBeenCalledTimes(2);
    await tick(120_000);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Checking 2 more past games…');
  });

  it('keeps what is on screen if a re-fetch fails', async () => {
    jest.useFakeTimers();
    await mount(ok(buildSample(FIXTURES, { games: 1, pending: 2 })), { ok: false, status: 500, error: null });
    await tick(4000);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(tiles().length).toBeGreaterThan(0);
    await tick(120_000);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('stops asking when it unmounts', async () => {
    jest.useFakeTimers();
    await mount(ok(buildSample(FIXTURES, { games: 1, pending: 2 })));
    act(() => root.unmount());
    root = createRoot(host);
    await tick(120_000);
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileAwards: Portuguese', () => {
  it('flips live: titles and units from the ending page, numbers and dates the Portuguese way', async () => {
    await mount(ok(buildSample(FIXTURES)));
    await act(async () => { setLang('pt-BR', false); });
    expect(host.querySelector('h2')?.textContent).toBe('Destaques');
    expect(text()).toContain('Conquistados nos jogos que você jogou até o fim');
    expect(text()).toContain('Melhor');
    expect(text()).toContain('Belicista');             // ending.award.warmonger.title
    expect(text()).toContain('Muralha de ferro');      // a long title that must wrap
    expect(text()).toContain('Venceu o jogo');
    expect(text()).toContain('Empate');
    expect(text()).toContain('como The Ministry of Silly Wonks');
    expect(text()).toContain('Ver todos (21)');
    expect(text()).toContain('naves destruídas');
    const date = host.querySelector('time')?.textContent ?? '';
    expect(date).toMatch(/2026/);
    expect(date).toMatch(/out/i);
    // The tile for Heavy hitter: 7.747 uses a dot for thousands.
    const heavy = tiles().find(x => x.querySelector('.pa-tile__ttl')?.textContent === 'Peso-pesado');
    expect(heavy?.textContent).toContain('7.747');
  });

  it('says the empty and checking lines in Portuguese', async () => {
    setLang('pt-BR', false);
    await mount(ok({ gamesFinished: 2, gamesWithAwards: 0, totals: [], awards: [], pending: 0 }));
    expect(text()).toContain('Termine um jogo para começar sua coleção.');
  });
});
