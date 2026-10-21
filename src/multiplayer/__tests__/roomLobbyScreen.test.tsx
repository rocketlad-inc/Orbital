/**
 * The room lobby screen, rendered (RoomLobbyScreen) over the fixture of a real
 * room, with the map and the network mocked. Covers the states the redesign is
 * about: the host with everyone in / alone, a player who has not finished
 * (gold "Set up" + checklist), a player who is ready, someone only watching,
 * Portuguese, the folds, the per-row kick menu, the empire editor opening in
 * place, and the chat as a dock (wide) or a tab with a teaser (phone), with
 * its unread badge.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

let mockUserId: string | undefined = 'fx1';
const mockMapProps: { current: Record<string, unknown> | null } = { current: null };

jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: mockUserId ? { id: mockUserId, is_premium: false } : null }),
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
jest.mock('../LobbyMapPreview', () => ({
  LobbyMapPreview: (props: Record<string, unknown>) => {
    mockMapProps.current = props;
    return require('react').createElement('div', { 'data-testid': props.inline ? 'map-inline' : 'map-stage' });
  },
}));
jest.mock('../CaptainRosterPicker', () => ({ CaptainRosterPicker: () => null }));
jest.mock('../SkinPicker', () => ({ SkinPicker: () => null }));

// eslint-disable-next-line import/first
import { apiFetch } from '../api';
// eslint-disable-next-line import/first
import { RoomLobbyScreen } from '../RoomLobbyScreen';
// eslint-disable-next-line import/first
import type { RoomLobbyScreenProps } from '../RoomLobbyScreen';
// eslint-disable-next-line import/first
import { FIXTURE_SEATS, fixtureSnapshot } from '../__fixtures__/roomLobby';
// eslint-disable-next-line import/first
import type { ChatLine } from '../roomLobbyModel';
// eslint-disable-next-line import/first
import { setLang } from '../../i18n/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockFetch = apiFetch as unknown as jest.Mock;

const FEED = {
  level: 'all', thread_url: null, following: true, discord_linked: true, forum_configured: true,
  is_host: true, discord_invite: null, server: null, host_name: 'Player 1', host_holds_commission: true,
};

function setWide(wide: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: q.includes('min-width: 900px') ? wide : false,
    media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function props(over: Partial<RoomLobbyScreenProps> & { viewerId?: string } = {}): RoomLobbyScreenProps {
  const viewerId = over.viewerId ?? 'fx1';
  return {
    roomId: 'fxRoom000001',
    snap: fixtureSnapshot(),
    viewerId,
    isHost: viewerId === 'fx1',
    started: false,
    myReady: !!FIXTURE_SEATS.find((s) => s.userId === viewerId)?.ready,
    error: null,
    onDismissError: jest.fn(),
    onBack: jest.fn(),
    onLeaveLobby: jest.fn(),
    onDeleteRoom: jest.fn(),
    onStart: jest.fn(),
    onToggleReady: jest.fn(),
    onKick: jest.fn(),
    onSeatsOpened: jest.fn(),
    empire: {
      myChoice: FIXTURE_SEATS.find((s) => s.userId === viewerId)?.world ?? null,
      empireName: '', onEmpireName: jest.fn(), bio: '', onBio: jest.fn(),
      onSaveEmpire: jest.fn(), saved: false,
      onPickFlag: jest.fn(), onPickBody: jest.fn(),
      namePools: { ship: [], captain: [], station: [], city: [] }, onSaveNamePools: jest.fn(), pastBanks: [],
    },
    rules: {
      draft: { name: 'The Zone of the Future', max: 8, interval: 3_600_000 },
      onDraft: jest.fn(), onSave: jest.fn(), saved: false,
    },
    chat: { log: [], draft: '', onDraft: jest.fn(), onSend: jest.fn() },
    ...over,
  };
}

async function render(p: RoomLobbyScreenProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<RoomLobbyScreen {...p} />); });
  await act(async () => { await Promise.resolve(); });
  return p;
}
async function rerender(p: RoomLobbyScreenProps) {
  await act(async () => { root!.render(<RoomLobbyScreen {...p} />); });
}

const $ = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const text = (sel: string) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const byText = (sel: string, t: string) => $$(sel).find((e) => (e.textContent ?? '').includes(t)) ?? null;
async function click(el: HTMLElement | null) {
  if (!el) throw new Error('nothing to click');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const line = (key: number, from: string, name: string, t: string): ChatLine => ({ key, from: { userId: from, displayName: name }, text: t, at: key });

beforeEach(() => {
  mockUserId = 'fx1';
  mockMapProps.current = null;
  setLang('en', false);
  try { sessionStorage.clear(); } catch { /* none */ }
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string) => (
    /\/feed$/.test(path) ? { ok: true, status: 200, data: FEED } : { ok: true, status: 200, data: {} }
  ));
  setWide(true);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe('wide: the map is the stage, the room panel is docked', () => {
  it('host, everyone in: the start card leads and the one action is Start match', async () => {
    await render(props());
    expect(text('.rl-start .rl-chip--gold')).toBe('Lobby · full');
    expect(text('.rl-verdict')).toBe('Everyone is in');
    expect(text('.rl-detail')).toBe('6 of 8 ready. Still setting up: Player 4 and Player 7.');
    const go = byText('.rl-start button', 'Start match') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    expect($$('.rl-facts .rl-chip').map((c) => c.textContent)).toEqual(['1-hour ticks', 'The Sol system', '8 seats']);
    expect(text('.rl-invite__code')).toBe('FNCN-NZZL');
    // eight pips, one with the host star, six ticked
    expect($$('.rl-pip').length).toBe(8);
    expect($$('.rl-pip__star').length).toBe(1);
    expect($$('.rl-pip__ck').length).toBe(6);
    // the start card is the first thing in the panel
    expect($('.rl-dock__scroll .rl-col')!.firstElementChild!.className).toContain('rl-start');
  });

  it('Start match calls the start flow', async () => {
    const p = await render(props());
    await click(byText('.rl-start button', 'Start match'));
    expect(p.onStart).toHaveBeenCalledTimes(1);
  });

  it('host alone: Start is disabled and the reason is on screen, not just a tooltip', async () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS.slice(0, 1));
    await render(props({ snap }));
    expect(text('.rl-verdict')).toBe('Waiting for players');
    const go = byText('.rl-start button', 'Start match') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.getAttribute('aria-describedby')).toBe('rl-start-reason');
    expect(text('#rl-start-reason')).toBe('Need at least 2 players');
    // seven open seats, shown quietly
    expect($$('.rl-pip.is-open').length).toBe(7);
    expect($$('.rl-prow.is-open').length).toBe(7);
  });

  it('the map frames itself into what the panel leaves visible, and picking on it claims a world', async () => {
    const p = await render(props({ viewerId: 'fx7' }));
    expect($('[data-testid=map-stage]')).not.toBeNull();
    expect(mockMapProps.current!.insetRight).toBeGreaterThan(0);
    (mockMapProps.current!.onPickBody as (id: string) => void)('mercury');
    expect(p.empire.onPickBody).toHaveBeenCalledWith('mercury');
  });

  it('the panel can be hidden to see the whole map, and brought back', async () => {
    await render(props());
    await click($('button[aria-label="Hide the room panel"]'));
    expect($('.rl-dock')).toBeNull();
    expect(mockMapProps.current!.insetRight).toBe(0);
    await click($('.rl-showpanel'));
    expect($('.rl-dock')).not.toBeNull();
  });

  it('a spectator gets the room and the map but no ready button, no empire card and no map picks', async () => {
    mockUserId = undefined;
    await render(props({ viewerId: 'nobody', isHost: false, myReady: false }));
    expect(byText('.rl-start button', 'I am ready')).toBeNull();
    expect(byText('.rl-start button', 'Start match')).toBeNull();
    expect($('.rl-you')).toBeNull();
    expect(mockMapProps.current!.onPickBody).toBeUndefined();
  });
});

describe('a player', () => {
  it('who has not finished: the empire card is gold, says Set up, and lists what is left', async () => {
    const p = await render(props({ viewerId: 'fx7', isHost: false, myReady: false }));
    const card = $('.rl-you')!;
    expect(card.className).toContain('is-todo');
    expect(text('.rl-you__nm')).toBe('Name your empire');
    const setup = byText('.rl-you button', 'Set up')!;
    expect(setup.className).toContain('rl-btn--gold');
    expect($$('.rl-check li').map((li) => li.textContent!.replace(/still to do|done/g, '').trim())).toEqual(
      ['Name', 'Flag', 'Starting world', 'Captains (optional)'],
    );
    expect($$('.rl-check li.is-no').length).toBe(2);
    expect(text('.rl-you__world')).toBe('No starting world yet. Click a free world on the map.');
    // the headline and the one primary action
    expect(text('.rl-verdict')).toBe('Waiting for the host');
    expect(text('.rl-detail')).toBe('Set up your empire, then press ready. Player 1 starts the match.');
    const ready = byText('.rl-start button', 'I am ready') as HTMLButtonElement;
    expect(ready.getAttribute('aria-pressed')).toBe('false');
    await click(ready);
    expect(p.onToggleReady).toHaveBeenCalledTimes(1);
    expect(byText('.rl-start button', 'Start match')).toBeNull();
  });

  it('who is ready: the headline says so and the button is the pressed state', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    expect(text('.rl-verdict')).toBe('You are ready');
    expect(text('.rl-detail')).toBe('6 of 8 ready. Player 1 starts the match.');
    const btn = byText('.rl-start button', 'You are ready') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toContain('rl-btn--teal');
    // a finished empire is one calm line with Edit, no checklist
    expect($('.rl-you')!.className).not.toContain('is-todo');
    expect(byText('.rl-you button', 'Edit')).not.toBeNull();
    expect($('.rl-check')).toBeNull();
    expect(text('.rl-you__sub')).toBe('Flying as Player 5 · note set');
  });

  it('does not get the host\'s kick menus or Start', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    expect($$('.rl-menu--row').length).toBe(0);
  });

  it('renders in Portuguese, with Start match as Iniciar partida', async () => {
    setLang('pt-BR', false);
    await render(props());
    expect(byText('.rl-start button', 'Iniciar partida')).not.toBeNull();
    expect(text('.rl-verdict')).toBe('Todos entraram');
    expect(text('.rl-players-h, #rl-players-h')).toBe('Jogadores');
    expect(text('.rl-chatdock__hd')).toContain('8 na sala');
    expect($('.rl-chatdock')!.getAttribute('aria-label')).toBe('Bate-papo da sala');
  });
});

describe('players', () => {
  it('one row each: empire first, then the player with tags, then where they start', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    const rows = $$('.rl-plist .rl-prow:not(.is-open)');
    expect(rows.length).toBe(8);
    expect(rows[0].querySelector('.rl-emp')!.textContent).toBe('Outie Empire');
    expect(rows[0].querySelector('.rl-who')!.textContent).toContain('Player 1');
    expect(rows[0].querySelector('.rl-tag--host')).not.toBeNull();
    expect(rows[0].querySelector('.rl-holder')).not.toBeNull();   // the Commission mark
    expect(rows[0].querySelector('.rl-world')!.textContent).toBe('starts on Triton');
    expect(rows[4].querySelector('.rl-who')!.textContent).toContain('you');
    expect(rows[6].querySelector('.rl-emp')!.textContent).toBe('No empire name yet');
    expect(rows[6].querySelector('.rl-world')!.textContent).toBe('no starting world yet');
  });

  it('a note is one line until tapped', async () => {
    await render(props());
    const note = $('.rl-clamp')!;
    expect(note.getAttribute('aria-expanded')).toBe('false');
    await click(note);
    expect(note.getAttribute('aria-expanded')).toBe('true');
    expect(note.className).toContain('is-open');
  });

  it('the host removes a player from the row menu, which hands over id and name', async () => {
    const p = await render(props());
    const menus = $$('.rl-menu--row');
    expect(menus.length).toBe(7);   // everyone but the host
    await click(menus[0].querySelector('button')!);
    expect(menus[0].querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    const item = $('[role=menuitem]')!;
    expect(item.textContent).toBe('Remove from room');
    await click(item);
    expect(p.onKick).toHaveBeenCalledWith('fx2', 'Player 2');
    expect($('[role=menu]')).toBeNull();
  });
});

describe('the header menu: leave and delete', () => {
  it('a player can leave; only the host can delete', async () => {
    const p = await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    await click($('.rl-bar .rl-menu button'));
    expect($$('[role=menuitem]').map((i) => i.textContent)).toEqual(['Leave lobby']);
    await click($('[role=menuitem]'));
    expect(p.onLeaveLobby).toHaveBeenCalledTimes(1);
  });

  it('the host gets both, and Back goes back', async () => {
    const p = await render(props());
    await click($('.rl-bar .rl-menu button'));
    expect($$('[role=menuitem]').map((i) => i.textContent)).toEqual(['Leave lobby', 'Delete room']);
    await click($$('[role=menuitem]')[1]);
    expect(p.onDeleteRoom).toHaveBeenCalledTimes(1);
    await click($('button[aria-label="Back to my games"]'));
    expect(p.onBack).toHaveBeenCalledTimes(1);
  });

  it('an error is a dismissable alert under the header', async () => {
    const p = await render(props({ error: 'Start failed' }));
    expect(text('.rl-alert')).toBe('Start failed');
    expect($('.rl-alert')!.getAttribute('role')).toBe('alert');
    await click($('.rl-alert button'));
    expect(p.onDismissError).toHaveBeenCalled();
  });
});

describe('folds and the editor', () => {
  it('Game rules is a one-line summary until opened; the host sees Edit and the fields, the player the values', async () => {
    await render(props());
    const btn = byText('.rl-fold__btn', 'Game rules')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain('8 seats · 1-hour ticks · The Sol system');
    expect(btn.textContent).toContain('Edit');
    expect(document.getElementById(btn.getAttribute('aria-controls')!)!.hidden).toBe(true);
    await click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(false);
    expect((body.querySelector('input[type=text]') as HTMLInputElement).value).toBe('The Zone of the Future');
    expect((body.querySelector('input[type=number]') as HTMLInputElement).min).toBe('2');
    expect((body.querySelector('input[type=number]') as HTMLInputElement).max).toBe('10');
    expect(body.querySelectorAll('select option').length).toBe(11);
    const inBody = (t: string) => Array.from(body.querySelectorAll('button')).find((b) => b.textContent === t);
    expect(inBody('Save changes')).toBeDefined();
    expect(inBody('Delete room')!.className).toContain('rl-btn--danger');
  });

  it('Save changes and Delete room are wired', async () => {
    const p = await render(props());
    await click(byText('.rl-fold__btn', 'Game rules'));
    await act(async () => { byText('.rl-form button', 'Save changes')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(p.rules.onSave).toHaveBeenCalledTimes(1);
    await click(byText('.rl-form button', 'Delete room'));
    expect(p.onDeleteRoom).toHaveBeenCalledTimes(1);
  });

  it('a player sees the rules read-only', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    const btn = byText('.rl-fold__btn', 'Game rules')!;
    expect(btn.textContent).not.toContain('Edit');
    await click(btn);
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(body.querySelector('input')).toBeNull();
    expect(body.textContent).toContain('Only the host can change these.');
  });

  it('the Discord feed is a fold with the level and the hint; its controls are the existing ones', async () => {
    await render(props());
    const btn = byText('.rl-fold__btn', 'Discord feed')!;
    expect(btn.textContent).toContain('Everything · tap to change');
    await click(btn);
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(false);
    expect(body.querySelector('[data-testid=game-feed-level]')).not.toBeNull();
    expect(body.querySelector('[data-testid=game-feed-locale]')).not.toBeNull();
    expect(body.querySelector('[data-testid=server-feed]')).not.toBeNull();   // the host's own-server perk
  });

  it('Your empire: Edit opens the editor in place, with every control', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    const edit = byText('.rl-you button', 'Edit')!;
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    const editor = $('.rl-editor')!;
    expect(editor.closest('[hidden]')).not.toBeNull();
    await click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(edit.textContent).toBe('Close');
    expect(editor.closest('[hidden]')).toBeNull();
    // name, note, save, flag (16 + 16 swatches, emblems), starting world, custom names
    expect(editor.querySelectorAll('input[type=text]').length).toBeGreaterThanOrEqual(1);
    expect(editor.querySelector('textarea')).not.toBeNull();
    expect(editor.querySelectorAll('.rl-swatch').length).toBe(32);
    expect(editor.querySelectorAll('.rl-emblem').length).toBeGreaterThan(26);
    expect(editor.querySelectorAll('.lobby-body-card').length).toBe(13);
    expect(editor.querySelector('details.rl-names')).not.toBeNull();
    expect(editor.textContent).toContain('Commander’s Commission');   // the upsell for the locked emblems
  });

  it('picking a flag colour, an emblem and a world goes through the existing handlers', async () => {
    const p = await render(props({ viewerId: 'fx7', isHost: false, myReady: false }));
    await click(byText('.rl-you button', 'Set up'));
    const swatches = $$('.rl-editor .rl-swatches')[0].querySelectorAll('button');
    const free = Array.from(swatches).find((b) => !(b as HTMLButtonElement).disabled && b.getAttribute('aria-pressed') === 'false')!;
    await click(free as HTMLElement);
    expect(p.empire.onPickFlag).toHaveBeenCalledWith('color', expect.stringMatching(/^#/));
    // a colour another player flies is taken and cannot be chosen
    const taken = Array.from(swatches).filter((b) => (b as HTMLButtonElement).disabled);
    expect(taken.length).toBeGreaterThan(5);
    const mercury = byText('.lobby-body-card', 'Mercury')!;
    await click(mercury);
    expect(p.empire.onPickBody).toHaveBeenCalledWith('mercury');
    const earth = byText('.lobby-body-card', 'Earth') as HTMLButtonElement;
    expect(earth.disabled).toBe(true);   // Player 5 holds it
  });

  it('saving the empire is the existing flow', async () => {
    const p = await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    await click(byText('.rl-you button', 'Edit'));
    await act(async () => { byText('.rl-editor button', 'Save empire')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(p.empire.onSaveEmpire).toHaveBeenCalledTimes(1);
  });
});

describe('chat on a wide screen: a dock on the map', () => {
  it('is open by default, input always visible, empty state in words', async () => {
    await render(props());
    const dock = $('.rl-chatdock') as HTMLElement;
    expect(dock.hidden).toBe(false);
    expect(dock.querySelector('.rl-empty')!.textContent).toBe('No messages yet. Say hello to your players.');
    expect(dock.querySelector('input')).not.toBeNull();
    expect(dock.textContent).toContain('8 in the room');
    // there is no chat fold in the panel and no phone teaser
    expect(byText('.rl-fold__btn', 'Lobby chat')).toBeNull();
    expect($('.rl-teaser')).toBeNull();
  });

  it('sends and shows lines, own and others', async () => {
    const p = props({ chat: { log: [line(1, 'fx3', 'Player 3', 'hello'), line(2, 'fx1', 'Player 1', 'hi')], draft: 'next', onDraft: jest.fn(), onSend: jest.fn((e: React.FormEvent) => e.preventDefault()) } });
    await render(p);
    const lines = $$('.rl-chatdock .rl-chat__line');
    expect(lines.map((l) => l.textContent)).toEqual(['Player 3hello', 'youhi']);
    expect(lines[1].className).toContain('is-mine');
    const form = $('.rl-chatdock form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(p.chat.onSend).toHaveBeenCalledTimes(1);
  });

  it('minimises to a pill, remembers it, counts new lines while minimised and clears them on open', async () => {
    const base = props();
    await render(base);
    await click($('button[aria-label="Minimise chat"]'));
    expect(sessionStorage.getItem('orbital.roomChatMin')).toBe('1');
    expect(($('.rl-chatdock') as HTMLElement).hidden).toBe(true);
    const pill = $('.rl-chatpill')!;
    expect(pill.querySelector('.rl-badge')).toBeNull();
    await rerender({ ...base, chat: { ...base.chat, log: [line(1, 'fx3', 'Player 3', 'a'), line(2, 'fx3', 'Player 3', 'b'), line(3, 'fx1', 'Player 1', 'mine')] } });
    expect($('.rl-chatpill .rl-badge')!.textContent).toBe('2');   // my own line does not count
    expect($('.rl-chatpill')!.getAttribute('aria-label')).toBe('Open chat: 2 new messages');
    await click($('.rl-chatpill'));
    expect($('.rl-chatpill')).toBeNull();
    expect(sessionStorage.getItem('orbital.roomChatMin')).toBe('0');
    expect(($('.rl-chatdock') as HTMLElement).hidden).toBe(false);
  });

  it('starts minimised when it was left minimised', async () => {
    sessionStorage.setItem('orbital.roomChatMin', '1');
    await render(props());
    expect($('.rl-chatpill')).not.toBeNull();
  });
});

describe('phone: tabs, a chat teaser, the map pane', () => {
  beforeEach(() => setWide(false));

  it('Room | Chat | Map, the Room tab selected, the start card first and the teaser under it', async () => {
    await render(props());
    const tabs = $$('.rl-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Room', 'Chat', 'Map']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect($('.rl-dock')).toBeNull();
    const col = $('#rl-pane-room .rl-col')!;
    expect(col.children[0].className).toContain('rl-start');
    expect(col.children[1].className).toContain('rl-teaser');
    expect(text('.rl-teaser')).toContain('No messages yet. Say hello.');
    // the stage map is not drawn; the map pane is mounted only on its tab
    expect($('[data-testid=map-stage]')).toBeNull();
    expect($('[data-testid=map-inline]')).toBeNull();
  });

  it('the teaser shows the latest line and its Open button switches to the Chat tab', async () => {
    const base = props();
    await render({ ...base, chat: { ...base.chat, log: [line(1, 'fx3', 'Player 3', 'anyone for Titan?')] } });
    expect(text('.rl-teaser')).toContain('Player 3: anyone for Titan?');
    expect($('.rl-teaser .rl-badge')!.textContent).toBe('1');
    await click($('.rl-teaser'));
    expect($$('.rl-tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(($('#rl-pane-chat') as HTMLElement).hidden).toBe(false);
    expect(($('#rl-pane-room') as HTMLElement).hidden).toBe(true);
    // reading it clears the unread badge
    expect($('.rl-tab .rl-badge')).toBeNull();
  });

  it('the Chat tab shows an unread badge while another tab is showing', async () => {
    const base = props();
    await render(base);
    expect($('.rl-tab .rl-badge')).toBeNull();
    await rerender({ ...base, chat: { ...base.chat, log: [line(1, 'fx3', 'Player 3', 'a'), line(2, 'fx4', 'Player 4', 'b')] } });
    expect($$('.rl-tab')[1].querySelector('.rl-badge')!.textContent).toBe('2');
    expect($$('.rl-tab')[1].querySelector('.rl-badge')!.getAttribute('aria-label')).toBe('2 new messages');
  });

  it('the Chat tab is the full chat with the input in reach', async () => {
    await render(props({ chat: { log: [], draft: '', onDraft: jest.fn(), onSend: jest.fn() } }));
    await click($$('.rl-tab')[1]);
    const pane = $('#rl-pane-chat')!;
    expect(pane.querySelector('input')).not.toBeNull();
    expect(pane.querySelector('.rl-empty')!.textContent).toBe('No messages yet. Say hello to your players.');
    expect($('.rl-page')!.className).toContain('is-fill');
  });

  it('arrow keys move between the tabs', async () => {
    await render(props());
    await act(async () => { $('#rl-tab-room')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect($$('.rl-tab')[1].getAttribute('aria-selected')).toBe('true');
  });

  it('the Map tab mounts the map in place with the Your starting world card; "Pick on the map" gets there', async () => {
    await render(props({ viewerId: 'fx7', isHost: false, myReady: false }));
    await click(byText('.rl-you .rl-you__world button', 'Pick on the map'));
    expect($$('.rl-tab')[2].getAttribute('aria-selected')).toBe('true');
    expect($('[data-testid=map-inline]')).not.toBeNull();
    expect(mockMapProps.current!.inline).toBe(true);
    expect(typeof mockMapProps.current!.onPickBody).toBe('function');
    expect(text('.rl-mapcard')).toContain('Pick a world');
    expect(text('.rl-mapcard')).toContain('Tap a free world on the map to claim it.');
  });

  it('with a world claimed the card names it and says how to move', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    await click($$('.rl-tab')[2]);
    expect(text('.rl-mapcard .rl-you__nm')).toBe('Earth');
    expect(text('.rl-mapcard .rl-you__sub')).toBe('Disciples of Robert Moses starts here. Tap another free world to move.');
  });

  it('on a phone the world line has the button; on desktop it is only the hint', async () => {
    await render(props({ viewerId: 'fx5', isHost: false, myReady: true }));
    expect(text('.rl-you__world')).toContain('Starting on Earth.');
    expect(byText('.rl-you__world button', 'Pick on the map')).not.toBeNull();
  });
});
