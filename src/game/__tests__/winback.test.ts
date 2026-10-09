// THE WIN-BACK EMAIL (worker/winback.js): who gets mailed this hour, and
// what each version says.
//
// The rules that matter: invite people into the games that already exist,
// spread across every open lobby so nobody chases a seat twelve others
// were sent to; never more mail than the open seats can absorb; pool the
// waiting into one fresh game only when nothing is open, and hold rather
// than send three people to wait alone. And every line has to render in
// both languages with no stray {placeholder}.

import {
  planWinback, composeWinback, initials, avatarHex,
  WINBACK_HOURLY_CAP, WINBACK_PER_SEAT, POOL_MIN, POOL_SIZE, WINBACK_URL, WINBACK_TEST_URL,
} from '../../../worker/winback.js';
import { initials as browserInitials } from '../../multiplayer/LobbyCards';

const people = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `u${i}` }));
const lobby = (n: number, max: number, extra: object = {}) =>
  ({ id: `r${n}-${max}`, name: 'Open game · Titan', n, max_players: max, quick_join: 1, ...extra });

describe('planWinback', () => {
  it('sends nothing when nobody is waiting', () => {
    expect(planWinback({ eligible: [], lobbies: [lobby(3, 5)] }))
      .toEqual({ mode: 'hold', reason: 'nobody_waiting', sends: [], recipients: [], rooms: [] });
  });

  it('spreads invitations across every open lobby, two per seat', () => {
    const near = lobby(3, 5);   // 2 seats
    const wide = lobby(1, 8);   // 7 seats
    const plan = planWinback({ eligible: people(30), lobbies: [near, wide] });
    expect(plan.mode).toBe('seat');
    expect(plan.rooms.map(r => [r.room.id, r.count])).toEqual([[near.id, 4], [wide.id, 14]]);
    expect(plan.sends).toHaveLength((2 + 7) * WINBACK_PER_SEAT);
    // each email names the lobby its reader was assigned to
    expect(plan.sends.slice(0, 4).every(s => s.room === near)).toBe(true);
    expect(plan.sends.slice(4).every(s => s.room === wide)).toBe(true);
  });

  it('the first batch on 2026-10-09: twelve people no longer chase one seat', () => {
    // test (3/4), Pallas (4/5, Quick), Diplo (2/6): six seats between them
    const lobbies = [lobby(3, 4, { id: 'test' }), lobby(4, 5, { id: 'pallas' }), lobby(2, 6, { id: 'diplo' })];
    const plan = planWinback({ eligible: people(12), lobbies });
    const per = Object.fromEntries(plan.rooms.map(r => [r.room.id, r.count]));
    expect(per).toEqual({ test: 2, pallas: 2, diplo: 8 });
  });

  it('counts invitations already out, and only tops up the difference', () => {
    // Diplo has 4 seats (8 invitations' worth); 5 are still out from last hour
    const diplo = lobby(2, 6, { id: 'diplo' });
    const plan = planWinback({ eligible: people(20), lobbies: [diplo], pending: { diplo: 5 } });
    expect(plan.rooms).toEqual([{ room: diplo, count: 3, pending: 5 }]);
    expect(plan.sends).toHaveLength(3);
  });

  it('holds when every open seat already has its invitations out', () => {
    const pallas = lobby(4, 5, { id: 'pallas' });
    const plan = planWinback({ eligible: people(20), lobbies: [pallas], pending: { pallas: 2 } });
    expect(plan.mode).toBe('hold');
    expect(plan.reason).toBe('invited');
    expect(plan.rooms).toEqual([{ room: pallas, count: 0, pending: 2 }]);
  });

  it('a saturated lobby does not stop invitations to the next one', () => {
    const plan = planWinback({
      eligible: people(20),
      lobbies: [lobby(4, 5, { id: 'a' }), lobby(1, 4, { id: 'b' })],
      pending: { a: 2, elsewhere: 9 },
    });
    expect(plan.rooms.map(r => [r.room.id, r.count, r.pending])).toEqual([['a', 0, 2], ['b', 6, 0]]);
  });

  it('a real send can carry its own sign-in link', () => {
    const href = 'https://orbital-empire.com/api/email/go?t=abc';
    const c = composeWinback('en', 'seat', seated(3, 5, { id: 'PV48OAq76SrJ' }), {}, { href });
    expect(c.cta.url).toBe(href);
    expect(c.hero.href).toBe(href);
    expect(c.cardHtml).toContain(`href="${href}"`);
  });

  it('fills the lobby closest to starting first when invitations run short', () => {
    const plan = planWinback({ eligible: people(3), lobbies: [lobby(4, 5, { id: 'a' }), lobby(1, 6, { id: 'b' })] });
    expect(plan.rooms.map(r => [r.room.id, r.count])).toEqual([['a', 2], ['b', 1]]);
  });

  it('never exceeds the hourly cap, however many seats are open', () => {
    const plan = planWinback({ eligible: people(100), lobbies: [lobby(1, 10), lobby(1, 10), lobby(1, 10)] });
    expect(plan.recipients).toHaveLength(WINBACK_HOURLY_CAP);
  });

  it('keeps newest signups first', () => {
    const plan = planWinback({ eligible: people(10), lobbies: [lobby(4, 5)] });
    expect(plan.recipients.map(u => u.id)).toEqual(['u0', 'u1']);
  });

  it('ignores a lobby that is already full', () => {
    const plan = planWinback({ eligible: people(2), lobbies: [lobby(5, 5)] });
    expect(plan.mode).toBe('hold');
  });

  it('pools the waiting into one fresh game when nothing is open', () => {
    const plan = planWinback({ eligible: people(50), lobbies: [] });
    expect(plan.mode).toBe('pool');
    expect(plan.rooms).toEqual([]);
    expect(plan.sends.every(s => s.room === null)).toBe(true);
    expect(plan.recipients).toHaveLength(POOL_SIZE);
  });

  it('holds when too few are waiting to fill a game together', () => {
    const plan = planWinback({ eligible: people(POOL_MIN - 1), lobbies: [] });
    expect(plan.mode).toBe('hold');
    expect(plan.recipients).toHaveLength(0);
  });
});

const members = [
  { name: 'Rocketlad', is_host: true },
  { name: 'milky', is_host: false },
  { name: 'Iron Anna', is_host: false },
];
const seated = (n: number, max: number, extra: object = {}) =>
  lobby(n, max, { members: members.slice(0, n), host_name: 'Rocketlad', tick_ms: 1_800_000, ...extra });

describe('composeWinback', () => {
  const cases: Array<[string, 'seat' | 'pool', object | null]> = [
    ['seat, self-starting', 'seat', seated(3, 5)],
    ['seat, host starts', 'seat', seated(3, 10, { quick_join: 0 })],
    ['seat, details unavailable', 'seat', lobby(3, 5)],
    ['pool', 'pool', null],
  ];
  for (const locale of ['en', 'pt-BR']) {
    for (const [label, mode, room] of cases) {
      it(`${locale}: ${label} renders every line and the card`, () => {
        const c = composeWinback(locale, mode, room);
        const all = [c.subject, c.preheader, c.heading, c.intro, ...c.after, ...c.lines.filter(Boolean), c.cta.label, c.footer];
        for (const s of all) {
          expect(typeof s).toBe('string');
          expect(s.length).toBeGreaterThan(0);
          expect(s).not.toMatch(/[{}]|undefined|NaN|email\.winback/);
        }
        expect(c.cardHtml).not.toMatch(/undefined|NaN|email\.winback|\{n\}|\{max\}|\{host\}/);
        const want = mode === 'seat' && room && (room as { id?: string }).id
          ? `${WINBACK_URL}&seat=${(room as { id: string }).id}` : WINBACK_URL;
        expect(c.cta.url).toBe(want);
        expect(c.cardHtml).toContain(`href="${want.replace(/&/g, '&amp;')}"`);
      });
    }
  }

  it('the card shows the lobby the way the game browser does', () => {
    const c = composeWinback('en', 'seat', seated(3, 5));
    expect(c.cardHtml).toContain('Open game · Titan');
    expect(c.cardHtml).toContain('Open · 2 seats left');
    expect(c.cardHtml).toContain('Hosted by Rocketlad');
    expect(c.cardHtml).toContain('3 of 5 players');
    expect(c.cardHtml).toContain('2 open');
    expect(c.cardHtml).toContain('30-minute turns');
    expect(c.cardHtml).toContain('>Quick<');
    // three faces, two dashed empty seats, the host ringed in gold
    expect((c.cardHtml.match(/title="/g) ?? []).length).toBe(3);
    expect((c.cardHtml.match(/dashed/g) ?? []).length).toBe(2);
    expect(c.cardHtml).toMatch(/border:2px solid #ffb84d[^>]*>RO</);
    expect(c.after[0]).toMatch(/starts on its own/);
  });

  it('a regular lobby says the host starts it, and wears no Quick tag', () => {
    const c = composeWinback('en', 'seat', seated(3, 10, { quick_join: 0 }));
    expect(c.after[0]).toMatch(/host starts it/);
    expect(c.cardHtml).not.toContain('>Quick<');
  });

  it('the pool card is a fresh game with every seat empty', () => {
    const c = composeWinback('en', 'pool', null);
    expect(c.cardHtml).toContain('A new game');
    expect(c.cardHtml).toContain('0 of 5 players');
    expect(c.cardHtml).toContain('1-hour turns');
    expect((c.cardHtml.match(/dashed/g) ?? []).length).toBe(5);
  });

  it('the button names the lobby the email shows', () => {
    const c = composeWinback('en', 'seat', seated(3, 5, { id: 'PV48OAq76SrJ' }));
    expect(c.cta.url).toBe('https://orbital-empire.com/?play=winback&from=winback&seat=PV48OAq76SrJ');
    expect(c.hero.href).toBe(c.cta.url);
  });

  it('a test email never takes a seat', () => {
    const c = composeWinback('en', 'seat', seated(3, 5), {}, { test: true });
    expect(c.cta.url).toBe(WINBACK_TEST_URL);
    expect(c.cta.url).not.toContain('play=');
    expect(c.cardHtml).not.toContain('play=winback');
  });

  it('player names are escaped', () => {
    const c = composeWinback('en', 'seat', seated(1, 5, { members: [{ name: '<b>x</b>', is_host: true }], host_name: '<b>x</b>' }));
    expect(c.cardHtml).not.toContain('<b>x</b>');
  });
});

describe('the card matches the game browser', () => {
  it('initials are the game browser\'s own', () => {
    for (const name of ['[agent] lobby-review', 'Rocketlad', 'Iron Anna', 'milky#1099', 'ação real', '', '!!!']) {
      expect(initials(name)).toBe(browserInitials(name));
    }
  });

  it('avatar colour is the browser\'s hsl(h 45% 38%) for the same name', () => {
    // hueOf('milky') in LobbyCards.tsx, then CSS hsl(h 45% 38%)
    let h = 0;
    for (const ch of 'milky') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    h %= 360;
    const hex = avatarHex('milky');
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    expect((max + min) / 2).toBeCloseTo(0.38, 1);
    let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    hue = (hue * 60 + 360) % 360;
    expect(Math.abs(hue - h)).toBeLessThan(2);
  });
});
