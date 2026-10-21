/**
 * The room lobby's behaviour, through LobbyView (RoomDetail): the data flow the
 * redesign must not have changed. apiFetch and the room socket are mocked, so
 * this covers ready (optimistic, over the websocket), start (and its failure),
 * kick / leave / delete with their confirms, saving the empire and the rules,
 * chat history + send over the socket, picks, the late-join branch, loading,
 * and a socket that gives up.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

let mockUserId = 'fx1';

jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: mockUserId, is_premium: false } }),
}));
jest.mock('../api', () => ({
  apiFetch: jest.fn(),
  startCommissionCheckout: jest.fn(async () => null),
}));
jest.mock('../commission', () => ({
  ...jest.requireActual('../commission'),
  logCommission: jest.fn(),
  openCommissionInBrowser: jest.fn(),
}));
jest.mock('../LobbyMapPreview', () => ({ LobbyMapPreview: () => null }));
jest.mock('../CaptainRosterPicker', () => ({ CaptainRosterPicker: () => null }));
jest.mock('../SkinPicker', () => ({ SkinPicker: () => null }));

const mockSock: { handlers: Record<string, (...a: any[]) => void> | null; ws: { readyState: number; send: jest.Mock } } = {
  handlers: null,
  ws: { readyState: 1, send: jest.fn() },
};
jest.mock('../roomSocket', () => ({
  connectRoomSocket: (_id: string, handlers: Record<string, (...a: any[]) => void>) => {
    mockSock.handlers = handlers;
    return { current: () => mockSock.ws, close: jest.fn() };
  },
}));

// eslint-disable-next-line import/first
import { apiFetch } from '../api';
// eslint-disable-next-line import/first
import { LobbyView } from '../LobbyView';
// eslint-disable-next-line import/first
import { FIXTURE_SEATS, fixtureSnapshot } from '../__fixtures__/roomLobby';
// eslint-disable-next-line import/first
import type { RoomSnapshot } from '../api';
// eslint-disable-next-line import/first
import { setLang } from '../../i18n/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockFetch = apiFetch as unknown as jest.Mock;
const ROOM = 'fxRoom000001';

const FEED = {
  level: 'headlines', thread_url: null, following: false, discord_linked: false, forum_configured: true,
  is_host: true, discord_invite: null, server: null, host_name: 'Player 1', host_holds_commission: false,
};

let snapshot: RoomSnapshot;
let routes: Record<string, (init?: RequestInit) => unknown>;
let root: Root | null = null;
let host: HTMLElement | null = null;
const onEnterGame = jest.fn();
const onExitRoom = jest.fn();

const ok = (data: unknown = {}) => ({ ok: true, status: 200, data });
const fail = (code: string) => ({ ok: false, status: 409, error: { code, message: code } });

function wide(w: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: q.includes('min-width: 900px') ? w : false, media: q,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  });
}

const $ = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const text = (sel: string) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const byText = (sel: string, t: string) => $$(sel).find((e) => (e.textContent ?? '').includes(t)) ?? null;
async function click(el: HTMLElement | null) {
  if (!el) throw new Error('nothing to click');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
const callsTo = (method: string, re: RegExp) => mockFetch.mock.calls.filter((c) => (c[1]?.method ?? 'GET') === method && re.test(c[0]));

async function mount(viewer: string, snap: RoomSnapshot = fixtureSnapshot()) {
  mockUserId = viewer;
  snapshot = snap;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<LobbyView initialRoomId={ROOM} onEnterGame={onEnterGame} onExitRoom={onExitRoom} />);
  });
  await flush();
  await act(async () => { mockSock.handlers?.onOpen?.(mockSock.ws); });
}

beforeEach(() => {
  setLang('en', false);
  wide(true);
  try { sessionStorage.clear(); } catch { /* none */ }
  onEnterGame.mockReset();
  onExitRoom.mockReset();
  mockSock.handlers = null;
  mockSock.ws = { readyState: 1, send: jest.fn() };
  (window as unknown as { confirm: unknown }).confirm = jest.fn(() => true);
  (window as unknown as { alert: unknown }).alert = jest.fn();
  routes = {};
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${path}`;
    for (const [k, fn] of Object.entries(routes)) if (k === key) return fn(init);
    if (key === `GET /api/lobby/rooms/${ROOM}`) return ok(snapshot);
    if (/\/feed$/.test(path) && method === 'GET') return ok(FEED);
    if (/name-pools\/history/.test(path)) return ok({ banks: [] });
    return ok({});
  });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe('loading', () => {
  it('says so until the room arrives', async () => {
    mockFetch.mockImplementation(() => new Promise(() => undefined));
    mockUserId = 'fx1';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<LobbyView initialRoomId={ROOM} onEnterGame={onEnterGame} onExitRoom={onExitRoom} />); });
    expect(host.textContent).toBe('Loading room…');
  });

  it('a socket that gives up is an error, not an endless spinner, even before the room loads', async () => {
    mockFetch.mockImplementation(() => new Promise(() => undefined));
    mockUserId = 'fx1';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<LobbyView initialRoomId={ROOM} onEnterGame={onEnterGame} onExitRoom={onExitRoom} />); });
    await act(async () => { mockSock.handlers!.onGiveUp!('forbidden'); });
    expect(host.textContent).toMatch(/will not accept a connection/);
  });
});

describe('the host', () => {
  it('sees the screen and starts the match; a failure shows as an alert', async () => {
    await mount('fx1');
    expect(text('.rl-verdict')).toBe('Everyone is in');
    routes[`POST /api/lobby/rooms/${ROOM}/start`] = () => fail('not_enough_players');
    await click(byText('.rl-start button', 'Start match'));
    expect(callsTo('POST', /\/start$/).length).toBe(1);
    expect($('.rl-alert')).not.toBeNull();
    expect($('.rl-alert')!.getAttribute('role')).toBe('alert');
  });

  it('the start button is disabled with fewer than two players', async () => {
    await mount('fx1', fixtureSnapshot(FIXTURE_SEATS.slice(0, 1)));
    expect((byText('.rl-start button', 'Start match') as HTMLButtonElement).disabled).toBe(true);
    await click(byText('.rl-start button', 'Start match'));
    expect(callsTo('POST', /\/start$/).length).toBe(0);
  });

  it('kicks after the confirm, and not without it', async () => {
    await mount('fx1');
    await click($$('.rl-menu--row button')[0]);
    (window.confirm as jest.Mock).mockReturnValueOnce(false);
    await click($('[role=menuitem]'));
    expect(callsTo('POST', /\/kick$/).length).toBe(0);
    await click($$('.rl-menu--row button')[0]);
    await click($('[role=menuitem]'));
    expect(window.confirm).toHaveBeenLastCalledWith('Kick Player 2?');
    const kick = callsTo('POST', /\/kick$/);
    expect(kick.length).toBe(1);
    expect(JSON.parse(kick[0][1].body)).toEqual({ user_id: 'fx2' });
  });

  it('saves the rules: name, max players and tick interval, then says Saved', async () => {
    await mount('fx1');
    await click(byText('.rl-fold__btn', 'Game rules'));
    const form = $('.rl-form')!;
    const name = form.querySelector('input[type=text]') as HTMLInputElement;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
    };
    await act(async () => { set(name, 'Renamed'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    const sel = form.querySelector('select') as HTMLSelectElement;
    await act(async () => { set(sel, '7200000'); sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    const patch = callsTo('PATCH', /\/settings$/);
    expect(patch.length).toBe(1);
    expect(JSON.parse(patch[0][1].body)).toEqual({ name: 'Renamed', max_players: 8, tick_interval_ms: 7_200_000 });
    expect(text('.rl-form .rl-saved')).toBe('Saved');
  });

  it('deletes the room after a confirm and leaves', async () => {
    await mount('fx1');
    await click($('.rl-bar .rl-menu button'));
    await click(byText('[role=menuitem]', 'Delete room'));
    await flush();
    expect(window.confirm).toHaveBeenCalledWith('Delete "The Zone of the Future"? This permanently removes the game for everyone in it.');
    expect(callsTo('DELETE', new RegExp(`/api/rooms/${ROOM}$`)).length).toBe(1);
    expect(onExitRoom).toHaveBeenCalled();
  });

  it('leaving as the only member deletes the lobby (the old rule), others hand it over', async () => {
    await mount('fx1', fixtureSnapshot(FIXTURE_SEATS.slice(0, 1)));
    await click($('.rl-bar .rl-menu button'));
    await click(byText('[role=menuitem]', 'Leave lobby'));
    await flush();
    expect(callsTo('DELETE', new RegExp(`/api/rooms/${ROOM}$`)).length).toBe(1);
    expect(onExitRoom).toHaveBeenCalled();
  });

  it('a failed delete is reported and the room stays', async () => {
    await mount('fx1');
    routes[`DELETE /api/rooms/${ROOM}`] = () => fail('nope');
    await click($('.rl-bar .rl-menu button'));
    await click(byText('[role=menuitem]', 'Delete room'));
    await flush();
    expect(onExitRoom).not.toHaveBeenCalled();
    expect($('.rl-alert')).not.toBeNull();
  });
});

describe('a player', () => {
  it('ready is optimistic and goes over the websocket; pressing again undoes it', async () => {
    await mount('fx4');
    const btn = () => byText('.rl-start button', 'ready')!;
    expect(text('.rl-start button.rl-btn--gold')).toBe('I am ready');
    await click(btn());
    expect(mockSock.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ready', ready: true }));
    expect(text('.rl-verdict')).toBe('You are ready');   // before the server has answered
    await click(byText('.rl-start button', 'You are ready'));
    expect(mockSock.ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ready', ready: false }));
  });

  it('on a dead socket the click asks for a reconnect instead of throwing', async () => {
    await mount('fx4');
    mockSock.ws.readyState = 3;
    await click(byText('.rl-start button', 'I am ready'));
    expect(mockSock.ws.send).not.toHaveBeenCalled();
    expect(text('.rl-verdict')).toBe('Waiting for the host');
  });

  it('leaves after the confirm and the seat is freed', async () => {
    await mount('fx4');
    await click($('.rl-bar .rl-menu button'));
    expect($$('[role=menuitem]').map((i) => i.textContent)).toEqual(['Leave lobby']);
    await click($('[role=menuitem]'));
    await flush();
    expect(callsTo('POST', /\/leave$/).length).toBe(1);
    expect(onExitRoom).toHaveBeenCalled();
  });

  it('Back keeps the seat: it only goes back', async () => {
    await mount('fx4');
    await click($('button[aria-label="Back to my games"]'));
    expect(onExitRoom).toHaveBeenCalled();
    expect(callsTo('POST', /\/leave$/).length).toBe(0);
  });

  it('saves the empire name and note, then says Saved', async () => {
    await mount('fx7');
    await click(byText('.rl-you button', 'Set up'));
    const form = byText('.rl-editor form', 'Save empire')!;
    const input = form.querySelector('input') as HTMLInputElement;
    const area = form.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' Verdan Concord ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Gardeners.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    const patch = callsTo('PATCH', /\/me$/);
    expect(JSON.parse(patch[patch.length - 1][1].body)).toEqual({ empire_name: 'Verdan Concord', bio: 'Gardeners.' });
    expect(text('.rl-editor .rl-saved')).toBe('Saved');
  });

  it('picks a flag colour, and an exclusive-colour refusal is said in words', async () => {
    await mount('fx7');
    await click(byText('.rl-you button', 'Set up'));
    routes[`PATCH /api/lobby/rooms/${ROOM}/me`] = () => fail('color_taken');
    const free = $$('.rl-editor .rl-swatches')[0].querySelector('button:not(:disabled)') as HTMLElement;
    await click(free);
    await flush();
    expect($('.rl-alert')!.textContent).toContain('Another player already flies that color');
  });

  it('claims a starting world: optimistic, PATCHed, and shown on the map and in the card at once', async () => {
    await mount('fx7');
    routes[`PATCH /api/lobby/rooms/${ROOM}/me`] = () => new Promise(() => undefined);   // the server is slow
    await click(byText('.rl-you button', 'Set up'));
    await click(byText('.lobby-body-card', 'Mercury'));
    const patch = callsTo('PATCH', /\/me$/);
    expect(JSON.parse(patch[patch.length - 1][1].body)).toEqual({ chosen_starting_body: 'mercury' });
    expect(text('.rl-you__world')).toContain('Starting on Mercury.');
  });

  it('a rejected pick rolls back', async () => {
    await mount('fx7');
    routes[`PATCH /api/lobby/rooms/${ROOM}/me`] = () => fail('body_taken');
    await click(byText('.rl-you button', 'Set up'));
    await click(byText('.lobby-body-card', 'Mercury'));
    await flush();
    expect(text('.rl-you__world')).toContain('No starting world yet.');
    expect($('.rl-alert')).not.toBeNull();
  });
});

describe('chat', () => {
  it('history arrives over the socket, and a new line is sent as a chat frame and clears the box', async () => {
    await mount('fx1');
    await act(async () => {
      mockSock.handlers!.onMessage!({ data: JSON.stringify({ type: 'chat_history', messages: [
        { from: { userId: 'fx3', displayName: 'Player 3' }, text: 'earlier', at: 1 },
      ] }) });
    });
    expect($$('.rl-chatdock .rl-chat__line').map((l) => l.textContent)).toEqual(['Player 3earlier']);
    const input = $('.rl-chatdock input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hello room');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { $('.rl-chatdock form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mockSock.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chat', text: 'hello room' }));
    expect((($('.rl-chatdock input')) as HTMLInputElement).value).toBe('');
    // the server's broadcast of the line shows it
    await act(async () => {
      mockSock.handlers!.onMessage!({ data: JSON.stringify({ type: 'chat', from: { userId: 'fx1', displayName: 'Player 1' }, text: 'hello room', at: 2 }) });
    });
    expect($$('.rl-chatdock .rl-chat__line').pop()!.textContent).toBe('youhello room');
  });

  it('on a phone an incoming line lights the Chat tab', async () => {
    wide(false);
    await mount('fx1');
    await act(async () => {
      mockSock.handlers!.onMessage!({ data: JSON.stringify({ type: 'chat', from: { userId: 'fx3', displayName: 'Player 3' }, text: 'psst', at: 2 }) });
    });
    expect($$('.rl-tab')[1].querySelector('.rl-badge')!.textContent).toBe('1');
    expect(text('.rl-teaser')).toContain('Player 3: psst');
  });
});

describe('a room that has started', () => {
  it('is the lobby\'s status, players and chat, with no start, ready, empire or rules', async () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS, { game_id: 'G1', current_tick: 5, status: 'running' });
    snap.game_id = 'G1';
    routes['GET /api/games/G1/joinable-bodies'] = () => ok({ already_joined: true, bodies: [] });
    await mount('fx1', snap);
    expect(text('.rl-start .rl-chip--gold')).toBe('In progress · tick 5');
    expect(byText('.rl-start button', 'Start match')).toBeNull();
    expect($('.rl-you')).toBeNull();
    expect(byText('.rl-fold__btn', 'Game rules')).toBeNull();
    expect($$('.rl-prow').length).toBeGreaterThan(0);
    expect(onEnterGame).toHaveBeenCalledWith(ROOM, 'G1');
  });

  it('late join: someone with no faction picks an unclaimed world and founds a capital', async () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS, { game_id: 'G1', current_tick: 5 });
    snap.game_id = 'G1';
    routes['GET /api/games/G1/joinable-bodies'] = () => ok({
      already_joined: false,
      bodies: [
        { id: 'mercury', name: 'Mercury', type: 'terrestrial', yield: { metal: 4, fuel: 0, gold: 1, science: 1 } },
        { id: 'luna', name: 'Luna', type: 'moon', yield: { metal: 3, fuel: 0, gold: 0, science: 1 } },
      ],
    });
    routes['POST /api/games/G1/late-join'] = () => ok({ ok: true, faction_id: 'f1' });
    await mount('fx9', snap);
    await flush();
    expect(text('.rl-late h2')).toBe('Join the war');
    const found = byText('.rl-late button', 'Found my capital') as HTMLButtonElement;
    expect(found.disabled).toBe(true);
    await click(byText('.lobby-body-card', 'Luna'));
    expect(found.disabled).toBe(false);
    await click(found);
    await flush();
    const post = callsTo('POST', /late-join$/);
    expect(JSON.parse(post[0][1].body)).toEqual({ chosen_body: 'luna' });
    expect(onEnterGame).toHaveBeenCalledWith(ROOM, 'G1');
  });

  it('late join with nothing left says there is no open seat', async () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS, { game_id: 'G1' });
    snap.game_id = 'G1';
    routes['GET /api/games/G1/joinable-bodies'] = () => ok({ already_joined: false, bodies: [] });
    await mount('fx9', snap);
    await flush();
    expect(text('.rl-late .rl-empty')).toMatch(/no open seat/);
    await click(byText('.rl-late button', 'Back'));
    expect(onExitRoom).toHaveBeenCalled();
  });
});
