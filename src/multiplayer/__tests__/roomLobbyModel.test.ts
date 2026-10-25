/**
 * What the room lobby SAYS (roomLobbyModel): the start card's headline and
 * detail for the host, a player and one who has not finished, with 0..8
 * players; the ready counts; how the players still setting up are named with
 * 1, 2, 3 and more names; the empire checklist; the chat unread badge; and
 * the one-line rule facts.
 */
import {
  badgeText, buildEmpire, buildPlayers, buildStartCard, chatTeaser, ruleFacts, rulesSummary,
  tickFact, tickLabel, unreadCount, whoList,
} from '../roomLobbyModel';
import type { ChatLine, LobbyPlayer } from '../roomLobbyModel';
import { fixtureSnapshot, FIXTURE_SEATS } from '../__fixtures__/roomLobby';
import { getLang, setLang } from '../../i18n/core';

/** The first n seats, all ready unless told otherwise, as the viewer `viewerId` sees them. */
const players = (n: number, viewerId: string, over: Record<string, Partial<(typeof FIXTURE_SEATS)[number]>> = {}) => {
  const seats = FIXTURE_SEATS.slice(0, n).map((s) => ({ ...s, ready: true, ...(over[s.userId] ?? {}) }));
  return buildPlayers(fixtureSnapshot(seats), viewerId);
};

afterEach(() => setLang('en', false));

describe('whoList: who is still setting up', () => {
  it('names one, two and three people in a sentence', () => {
    expect(whoList([])).toBe('');
    expect(whoList(['Ana'])).toBe('Ana');
    expect(whoList(['Ana', 'Bo'])).toBe('Ana and Bo');
    expect(whoList(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo and Cy');
  });
  it('counts past three instead of listing everyone', () => {
    expect(whoList(['Ana', 'Bo', 'Cy', 'Di'])).toBe('Ana, Bo and 2 more');
    expect(whoList(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A, B and 5 more');
  });
  it('is Portuguese when the language is', () => {
    setLang('pt-BR', false);
    expect(whoList(['Ana', 'Bo'])).toBe('Ana e Bo');
    expect(whoList(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo e Cy');
    expect(whoList(['Ana', 'Bo', 'Cy', 'Di'])).toBe('Ana, Bo e mais 2');
  });
});

describe('the start card, host', () => {
  it('alone: waits for players, cannot start, and says why', () => {
    const m = buildStartCard({ players: players(1, 'fx1'), maxPlayers: 8, started: false });
    expect(m.viewer).toBe('host');
    expect(m.headline).toBe('Waiting for players');
    expect(m.detail).toMatch(/at least 2 players/);
    expect(m.canStart).toBe(false);
    expect(m.startReason).toBe('Need at least 2 players');
    expect(m.phase).toBe('Lobby · 7 seats open');
  });

  it('two in, both ready: everyone is ready and the match can start', () => {
    const m = buildStartCard({ players: players(2, 'fx1'), maxPlayers: 8, started: false });
    expect(m.headline).toBe('Everyone is ready');
    expect(m.detail).toBe('All 2 players are ready.');
    expect(m.canStart).toBe(true);
    expect(m.startReason).toBeNull();
  });

  it('someone still setting up: counts the ready and names them', () => {
    const m = buildStartCard({ players: players(8, 'fx1', { fx4: { ready: false }, fx7: { ready: false } }), maxPlayers: 8, started: false });
    expect(m.headline).toBe('Everyone is in');
    expect(m.detail).toBe('6 of 8 ready. Still setting up: Player 4 and Player 7.');
    expect(m.readyCount).toBe(6);
    expect(m.stillSettingUp).toEqual(['Player 4', 'Player 7']);
    expect(m.full).toBe(true);
    expect(m.phase).toBe('Lobby · full');
  });

  it('the host is always counted ready (the server never checks), so is never named as waiting', () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS.slice(0, 3).map((s) => ({ ...s, ready: false })));
    const m = buildStartCard({ players: buildPlayers(snap, 'fx1'), maxPlayers: 8, started: false });
    expect(m.stillSettingUp).toEqual(['Player 2', 'Player 3']);
    expect(m.readyCount).toBe(1);
    expect(m.detail).toBe('1 of 3 ready. Still setting up: Player 2 and Player 3.');
  });

  it('one, two, three and more names in the sentence', () => {
    const cases: Array<[number, string]> = [
      [1, 'Player 2.'], [2, 'Player 2 and Player 3.'], [3, 'Player 2, Player 3 and Player 4.'], [5, 'Player 2, Player 3 and 3 more.'],
    ];
    for (const [waiting, tail] of cases) {
      const over = Object.fromEntries(FIXTURE_SEATS.slice(1, 1 + waiting).map((s) => [s.userId, { ready: false }]));
      const m = buildStartCard({ players: players(8, 'fx1', over), maxPlayers: 8, started: false });
      expect(m.detail.endsWith(tail)).toBe(true);
    }
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('with %i players the seats and the verdict stay coherent', (n) => {
    const ps = n === 0 ? [] : players(n, 'fx1');
    const m = buildStartCard({ players: ps, maxPlayers: 8, started: false });
    expect(m.total).toBe(n);
    expect(m.seatsOpen).toBe(8 - n);
    expect(m.phase).toBe(n === 8 ? 'Lobby · full' : n === 7 ? 'Lobby · 1 seat open' : `Lobby · ${8 - n} seats open`);
    expect(m.canStart).toBe(n >= 2);
    if (n === 0) expect(m.viewer).toBe('spectator');
    if (n >= 2) expect(m.headline).toBe('Everyone is ready');
  });

  it('a running match says so instead of offering a start', () => {
    const m = buildStartCard({ players: players(4, 'fx1'), maxPlayers: 8, started: true, currentTick: 12 });
    expect(m.phase).toBe('In progress · tick 12');
    expect(m.canStart).toBe(false);
    expect(m.startReason).toBeNull();
  });
});

describe('the start card, player', () => {
  it('unfinished and not ready: waiting for the host, set up first', () => {
    const m = buildStartCard({ players: players(8, 'fx7', { fx7: { ready: false } }), maxPlayers: 8, started: false });
    expect(m.viewer).toBe('player');
    expect(m.headline).toBe('Waiting for the host');
    expect(m.detail).toBe('Set up your empire, then press ready. Player 1 starts the match.');
    expect(m.iAmReady).toBe(false);
    expect(m.canStart).toBe(false);
    expect(m.startReason).toBeNull();
  });

  it('finished but not ready: just press ready', () => {
    const m = buildStartCard({ players: players(8, 'fx4', { fx4: { ready: false } }), maxPlayers: 8, started: false });
    expect(m.detail).toBe('Press ready when you are set. Player 1 starts the match.');
  });

  it('ready: "You are ready" and the count', () => {
    const m = buildStartCard({ players: players(8, 'fx5', { fx4: { ready: false } }), maxPlayers: 8, started: false });
    expect(m.headline).toBe('You are ready');
    expect(m.detail).toBe('7 of 8 ready. Player 1 starts the match.');
    expect(m.iAmReady).toBe(true);
  });

  it('the optimistic ready flag wins over the snapshot for the viewer only', () => {
    const snap = fixtureSnapshot(FIXTURE_SEATS.map((s) => ({ ...s, ready: s.userId === 'fx1' })));
    const ps = buildPlayers(snap, 'fx5', { ready: true });
    expect(ps.find((p) => p.userId === 'fx5')!.ready).toBe(true);
    expect(ps.find((p) => p.userId === 'fx3')!.ready).toBe(false);
  });

  it('someone who is not in the room is a spectator: no ready, no start', () => {
    const m = buildStartCard({ players: players(4, 'nobody'), maxPlayers: 8, started: false });
    expect(m.viewer).toBe('spectator');
    expect(m.canStart).toBe(false);
    expect(m.startReason).toBeNull();
    expect(m.headline).toBe('Waiting for the host');
  });

  it('is in Portuguese when the language is', () => {
    setLang('pt-BR', false);
    const host = buildStartCard({ players: players(8, 'fx1', { fx4: { ready: false } }), maxPlayers: 8, started: false });
    expect(host.headline).toBe('Todos entraram');
    expect(host.detail).toBe('7 de 8 prontos. Ainda se preparando: Player 4.');
    expect(host.phase).toBe('Sala · lotada');
  });
});

describe('your empire', () => {
  const me = (id: string, over: Partial<LobbyPlayer> = {}): LobbyPlayer => ({ ...players(8, id).find((p) => p.userId === id)!, ...over });

  it('finished: calm, one line, the checklist is all done', () => {
    const e = buildEmpire(me('fx1'));
    expect(e.unfinished).toBe(false);
    expect(e.title).toBe('Outie Empire');
    expect(e.sub).toBe('Flying as Player 1 · note set');
    expect(e.world).toBe('Triton');
    expect(e.checks.map((c) => c.state)).toEqual(['done', 'done', 'done', 'optional']);
  });

  it('no note: the line does not claim one', () => {
    expect(buildEmpire(me('fx3')).sub).toBe('Flying as Player 3');
  });

  it('nothing set up: gold, a nudge to name it, three things left, captains optional', () => {
    const e = buildEmpire(me('fx7'));
    expect(e.unfinished).toBe(true);
    expect(e.title).toBe('Name your empire');
    expect(e.hasName).toBe(false);
    expect(e.sub).toBe('You are in the room as Player 7. Finish setting up, then ready up.');
    expect(e.checks.map((c) => `${c.key}:${c.state}`)).toEqual(['name:todo', 'flag:done', 'world:todo', 'captains:optional']);
  });

  it('named and placed but no flag colour yet: only the flag is missing', () => {
    const e = buildEmpire(me('fx1', { color: null }));
    expect(e.unfinished).toBe(true);
    expect(e.sub).toBe('Pick your flag colours to finish setting up.');
    expect(e.checks.map((c) => c.state)).toEqual(['done', 'todo', 'done', 'optional']);
  });
});

describe('players', () => {
  it('resolves worlds by name, empire by presence, and flags the host and the viewer', () => {
    const ps = players(8, 'fx5');
    const outie = ps[0];
    expect(outie).toMatchObject({ name: 'Player 1', empire: 'Outie Empire', world: 'Triton', isHost: true, isMe: false, commissioned: true });
    expect(ps[4].isMe).toBe(true);
    const nameless = ps[6];
    expect(nameless.empire).toBeNull();
    expect(nameless.world).toBeNull();
  });
  it('knows who is online', () => {
    const ps = players(8, 'fx1');
    expect(ps.find((p) => p.userId === 'fx4')!.online).toBe(false);
    expect(ps.find((p) => p.userId === 'fx2')!.online).toBe(true);
  });
  it('the viewer\'s optimistic world pick shows at once', () => {
    const ps = buildPlayers(fixtureSnapshot(), 'fx7', { worldId: 'luna' });
    expect(ps.find((p) => p.isMe)!.world).toBe('Luna');
  });
});

describe('the rules, in one line', () => {
  it('seats, speed and map', () => {
    const f = ruleFacts(fixtureSnapshot());
    expect(f).toEqual({ speed: '1-hour ticks', map: 'The Sol system', seats: '8 seats' });
    expect(rulesSummary(f)).toBe('8 seats · 1-hour ticks · The Sol system');
  });
  it('a custom map is named by its maker', () => {
    const snap = { ...fixtureSnapshot(), custom_map: { name: 'The Long Dark' } };
    expect(ruleFacts(snap).map).toBe('The Long Dark');
  });
  it('speeds in seconds, minutes and fractions of an hour', () => {
    expect(tickFact(30_000)).toBe('30-second ticks');
    expect(tickFact(450_000)).toBe('7.5-minute ticks');
    expect(tickFact(86_400_000)).toBe('24-hour ticks');
    setLang('pt-BR', false);
    expect(tickFact(450_000)).toBe('ticks de 7,5 min');
    expect(getLang()).toBe('pt-BR');
  });
  it('the picker label for a known interval, a short form for an unknown one', () => {
    expect(tickLabel(3_600_000)).toBe('1h (async · DEFAULT)');
    expect(tickLabel(5_400_000)).toBe('1.5-hour ticks');
  });
});

describe('chat: unread and the teaser', () => {
  const line = (key: number, from: string, text: string): ChatLine => ({ key, from: { userId: from, displayName: `Name ${from}` }, text, at: key });
  const log = [line(1, 'a', 'hi'), line(2, 'me', 'hello'), line(3, 'b', 'ready?'), line(4, 'b', 'go')];

  it('counts other people\'s lines since the chat was last on screen', () => {
    expect(unreadCount(log, 0, 'me')).toBe(3);
    expect(unreadCount(log, 2, 'me')).toBe(2);
    expect(unreadCount(log, 4, 'me')).toBe(0);
  });
  it('your own lines never count, and a stale pointer is clamped', () => {
    expect(unreadCount([line(1, 'me', 'x')], 0, 'me')).toBe(0);
    expect(unreadCount(log, 99, 'me')).toBe(0);
    expect(unreadCount(log, -3, 'me')).toBe(3);
  });
  it('increments as lines arrive while minimised', () => {
    let seen = log.length;   // closed with everything read
    expect(unreadCount(log, seen, 'me')).toBe(0);
    const more = [...log, line(5, 'c', 'one more')];
    expect(unreadCount(more, seen, 'me')).toBe(1);
    seen = more.length;      // opened: read
    expect(unreadCount(more, seen, 'me')).toBe(0);
  });
  it('the badge reads nothing, the number, then 9+', () => {
    expect([0, 1, 9, 10, 40].map(badgeText)).toEqual(['', '1', '9', '9+', '9+']);
  });
  it('the teaser is the newest line, or an invitation to say hello', () => {
    expect(chatTeaser([], 'me')).toBe('No messages yet. Say hello.');
    expect(chatTeaser(log, 'me')).toBe('Name b: go');
    expect(chatTeaser([line(1, 'me', 'first')], 'me')).toBe('you: first');
  });
});
