/**
 * @jest-environment node
 */
// THE WIN-BACK EMAIL'S ADMIN SIDE: edits, opens and numbers
// (worker/winback.js, worker/email.js, worker/emailAdmin.js).
//
// Node environment: the open pixel is signed with WebCrypto HMAC, which
// jsdom does not provide.

import { webcrypto } from 'crypto';
import {
  composeWinback, renderWinback, cleanOverrides, WINBACK_HERO_SRC, MAX_FIELD_CHARS,
} from '../../../worker/winback.js';

// The Workers runtime has a global `crypto`; this jest Node does not.
if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
import { sendEmail, openToken, readOpenToken, OPEN_PIXEL } from '../../../worker/email.js';
import { winbackMetrics } from '../../../worker/emailAdmin.js';

const room = {
  id: 'r1', name: 'Open game · Titan', n: 3, max_players: 5, quick_join: 1,
  host_name: 'Rocketlad', tick_ms: 3_600_000,
  members: [{ name: 'Rocketlad', is_host: true }, { name: 'milky', is_host: false }, { name: 'Iron Anna', is_host: false }],
};

describe('edits override the catalog', () => {
  it('an override wins, with its {placeholders} filled', () => {
    const c = composeWinback('en', 'seat', room, {
      en: {
        'email.winback.seat.subject': 'Your fleet is waiting',
        'email.winback.seat.preheader': '{name}: {n}/{max} aboard',
        'email.winback.cta': 'Launch',
      },
    });
    expect(c.subject).toBe('Your fleet is waiting');
    expect(c.preheader).toBe('Open game · Titan: 3/5 aboard');
    expect(c.cta.label).toBe('Launch');
    expect(c.cardHtml).toContain('>Launch</a>');
  });

  it('a blank override falls back to the default', () => {
    const c = composeWinback('en', 'seat', room, { en: { 'email.winback.seat.subject': '   ' } });
    expect(c.subject).toBe('A game of Orbital is filling up');
  });

  it('an English edit leaves Portuguese alone', () => {
    const c = composeWinback('pt-BR', 'seat', room, { en: { 'email.winback.seat.subject': 'Changed' } });
    expect(c.subject).toBe('Um jogo de Orbital está enchendo');
  });

  it('the header picture can be swapped, and defaults otherwise', () => {
    expect(composeWinback('en', 'pool', null, {}).hero.src).toBe(WINBACK_HERO_SRC);
    expect(composeWinback('en', 'pool', null, { hero_src: 'https://example.com/a.jpg' }).hero.src).toBe('https://example.com/a.jpg');
  });

  it('only the real send carries the open pixel', () => {
    const c = composeWinback('en', 'seat', room, {});
    expect(renderWinback(c).html).not.toContain(OPEN_PIXEL);
    expect(renderWinback(c, { trackOpens: true }).html).toContain(OPEN_PIXEL);
  });
});

describe('cleanOverrides', () => {
  it('keeps known keys and languages, drops the rest and the blanks', () => {
    const { overrides } = cleanOverrides({
      en: { 'email.winback.cta': ' Go ', 'email.winback.card.quick': 'nope', 'email.welcome.subject': 'nope', 'email.winback.l2': '' },
      fr: { 'email.winback.cta': 'Allez' },
      'pt-BR': { 'email.winback.cta': 'Vai' },
    });
    expect(overrides).toEqual({ en: { 'email.winback.cta': 'Go' }, 'pt-BR': { 'email.winback.cta': 'Vai' } });
  });

  it('refuses a field that is too long', () => {
    const r = cleanOverrides({ en: { 'email.winback.cta': 'x'.repeat(MAX_FIELD_CHARS + 1) } });
    expect(r.error).toMatch(/longer than/);
  });

  it('refuses a picture that is not https', () => {
    expect(cleanOverrides({ hero_src: 'http://example.com/a.jpg' }).error).toMatch(/https/);
    expect(cleanOverrides({ hero_src: 'javascript:alert(1)' }).error).toMatch(/https/);
    expect(cleanOverrides({ hero_src: 'https://x.com/a.jpg" onerror="x' }).error).toMatch(/https/);
  });
});

describe('the open pixel', () => {
  const env = { EMAIL_LINK_SECRET: 'test-secret' };

  it('a token names its send and nothing else', async () => {
    const t = await openToken(env, 42);
    expect(await readOpenToken(env, t)).toBe(42);
    expect(await readOpenToken(env, t!.replace(/^42\./, '43.'))).toBeNull();
    expect(await readOpenToken(env, '42.AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    expect(await readOpenToken({ EMAIL_LINK_SECRET: 'other' }, t)).toBeNull();
    expect(await readOpenToken(env, 'garbage')).toBeNull();
  });

  it('sendEmail turns the marker into a picture named after the log row', async () => {
    let sent: any = null;
    const db = {
      prepare: () => ({ bind: () => ({ run: async () => ({ meta: { last_row_id: 7 } }) }) }),
    };
    const res = await sendEmail(
      { ...env, DB: db, EMAIL: { send: async (m: any) => { sent = m; } } },
      { to: 'a@b.com', kind: 'winback_seat', subject: 's', html: `<p>hi</p>${OPEN_PIXEL}`, text: 't' },
    );
    expect(res.sent).toBe(true);
    expect(sent.html).not.toContain(OPEN_PIXEL);
    const m = /\/api\/email\/o\/([^"]+)\.gif/.exec(sent.html);
    expect(m).not.toBeNull();
    expect(await readOpenToken(env, m![1])).toBe(7);
  });

  it('mail without the marker is untouched', async () => {
    let sent: any = null;
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { last_row_id: 8 } }) }) }) };
    await sendEmail(
      { ...env, DB: db, EMAIL: { send: async (m: any) => { sent = m; } } },
      { to: 'a@b.com', kind: 'welcome', subject: 's', html: '<p>hi</p>', text: 't' },
    );
    expect(sent.html).toBe('<p>hi</p>');
  });
});

describe('winbackMetrics', () => {
  const NOW = Date.UTC(2026, 9, 8, 12);
  const H = 3600_000;
  const row = (over: object) => ({
    id: 1, user_id: 'u', kind: 'winback_seat', ok: 1, error: null, created_ms: NOW - 5 * H,
    opened_ms: null, open_count: 0, display_name: 'P', email: 'p@x.com', email_games: null,
    last_visit_ms: null, clicked_ms: null, joined_ms: null, in_game: 0, ...over,
  });
  const rows = [
    row({ user_id: 'a', opened_ms: NOW - 4 * H, open_count: 2, clicked_ms: NOW - 4 * H, joined_ms: NOW - 4 * H, in_game: 1, last_visit_ms: NOW - H }),
    row({ user_id: 'b', opened_ms: NOW - 3 * H, clicked_ms: NOW - 3 * H, joined_ms: NOW - 3 * H, in_game: 1, last_visit_ms: NOW - 5 * 24 * H }),
    row({ user_id: 'c', kind: 'winback_pool', opened_ms: NOW - 2 * H }),
    row({ user_id: 'd', kind: 'winback_pool', email_games: 0 }),
    row({ user_id: 'e', ok: 0, error: 'boom' }),
  ];
  const env = { DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } };

  it('counts the funnel out of what was actually sent', async () => {
    const m = await winbackMetrics(env, NOW);
    expect(m.totals).toEqual({ sent: 4, failed: 1, opened: 3, clicked: 2, joined: 2, playing: 1, unsubscribed: 1 });
    expect(m.byMode.seat.sent).toBe(2);
    expect(m.byMode.pool).toMatchObject({ sent: 2, opened: 1, unsubscribed: 1 });
  });

  it('a player who stopped visiting is not still playing', async () => {
    const m = await winbackMetrics(env, NOW);
    expect(m.recent.find(r => r.joined_ms && !r.playing)).toBeTruthy();
  });

  it('fourteen days, today last, sends on the day they went', async () => {
    const m = await winbackMetrics(env, NOW);
    expect(m.daily).toHaveLength(14);
    expect(m.daily[13]).toEqual({ day: '2026-10-08', sent: 4, opened: 3, clicked: 2 });
  });
});
