/**
 * @jest-environment node
 */
// THE SIGN-IN BUTTON IN THE WIN-BACK EMAIL (worker/emailLogin.js).
//
// What has to hold: a link scanner fetching the email's link spends
// nothing; the reader's click signs them in exactly once and lands them
// on the lobby the email named; a spent, expired or garbled link still
// lands them there, just without signing in; and no other site can post
// a token at us.

import { webcrypto } from 'crypto';
import {
  issueLoginLink, landingPage, spendLoginToken, seatPath, routes, LOGIN_TOKEN_TTL_MS,
} from '../../../worker/emailLogin.js';

if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// The Workers runtime has Request/Response; this jest Node does not.
// Just the parts the handlers touch.
class Hdrs {
  private m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) { for (const [k, v] of Object.entries(init)) this.m.set(k.toLowerCase(), v); }
  get(k: string) { return this.m.get(k.toLowerCase()) ?? null; }
}
class FakeResponse {
  status: number; headers: Hdrs; private body: string | null;
  constructor(body: string | null, init: { status?: number; headers?: Record<string, string> } = {}) {
    this.body = body; this.status = init.status ?? 200; this.headers = new Hdrs(init.headers);
  }
  async text() { return this.body ?? ''; }
}
(globalThis as any).Response = FakeResponse;

function Request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers = new Hdrs(init.headers);
  return {
    url, method: init.method ?? 'GET', headers,
    formData: async () => new URLSearchParams(init.body ?? ''),
  } as any;
}

/** Just enough D1 for these statements, over plain arrays. */
function fakeDb() {
  const tokens: any[] = [];
  const sessions: any[] = [];
  const users = new Map([['u1', { id: 'u1', last_login_at: null as number | null }]]);
  const db = {
    tokens, sessions, users,
    prepare(sql: string) {
      return {
        bind(...b: any[]) {
          return {
            run: async () => {
              if (sql.startsWith('INSERT INTO email_login_tokens')) {
                tokens.push({ token_hash: b[0], user_id: b[1], purpose: b[2], room_id: b[3], created_ms: b[4], expires_ms: b[5], used_ms: null });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE email_login_tokens SET used_ms')) {
                const t = tokens.find(x => x.token_hash === b[1] && x.used_ms == null && x.expires_ms > b[2]);
                if (t) t.used_ms = b[0];
                return { meta: { changes: t ? 1 : 0 } };
              }
              if (sql.startsWith('INSERT INTO sessions')) {
                sessions.push({ token: b[0], user_id: b[1] });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE users SET last_login_at')) {
                users.get(b[1])!.last_login_at = b[0];
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('DELETE FROM email_login_tokens')) return { meta: { changes: 0 } };
              throw new Error(`unexpected SQL: ${sql}`);
            },
            first: async () => {
              const t = tokens.find(x => x.token_hash === b[0]);
              if (!t) return null;
              if (sql.includes('JOIN users')) return users.has(t.user_id) ? { user_id: t.user_id, room_id: t.room_id } : null;
              return { room_id: t.room_id };
            },
          };
        },
      };
    },
  };
  return db;
}

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;

it('mints a link to our own landing page, storing only a hash', async () => {
  const db = fakeDb();
  const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'PV48OAq76SrJ', nowMs: 1000 });
  expect(url).toMatch(/^https:\/\/orbital-empire\.com\/api\/email\/go\?t=[A-Za-z0-9_-]{43}$/);
  expect(db.tokens).toHaveLength(1);
  expect(db.tokens[0].token_hash).not.toContain(tokenOf(url!));
  expect(db.tokens[0]).toMatchObject({ user_id: 'u1', room_id: 'PV48OAq76SrJ', purpose: 'winback', expires_ms: 1000 + LOGIN_TOKEN_TTL_MS });
});

it('the landing page posts the token back and spends nothing itself', async () => {
  const db = fakeDb();
  const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'r1', nowMs: Date.now() });
  const get = routes.find(r => r.method === 'GET')!;
  const res = await get.handle(new Request(url!), { DB: db }, { url: new URL(url!) });
  const html = await res.text();
  expect(res.headers.get('content-type')).toMatch(/text\/html/);
  expect(html).toContain('method="post" action="/api/email/go"');
  expect(html).toContain(`value="${tokenOf(url!)}"`);
  expect(db.tokens[0].used_ms).toBeNull();
  expect(db.sessions).toHaveLength(0);
});

it('the landing page never echoes a garbled token into the page', () => {
  expect(landingPage('"><script>alert(1)</script>')).not.toContain('<script>alert');
});

it('one click signs in once, and lands on the lobby the email named', async () => {
  const db = fakeDb();
  const now = Date.now();
  const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'PV48OAq76SrJ', nowMs: now });
  const first = await spendLoginToken({ DB: db }, tokenOf(url!), 'ua', now + 1000);
  expect(first).toMatchObject({ ok: true, roomId: 'PV48OAq76SrJ' });
  expect(first!.cookie).toMatch(/^orbital_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  expect(db.sessions).toEqual([{ token: expect.any(String), user_id: 'u1' }]);

  const again = await spendLoginToken({ DB: db }, tokenOf(url!), 'ua', now + 2000);
  expect(again).toEqual({ ok: false, roomId: 'PV48OAq76SrJ' });
  expect(db.sessions).toHaveLength(1);
});

it('an expired link does not sign in', async () => {
  const db = fakeDb();
  const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: null, nowMs: 0 });
  const res = await spendLoginToken({ DB: db }, tokenOf(url!), 'ua', LOGIN_TOKEN_TTL_MS + 1);
  expect(res).toEqual({ ok: false, roomId: null });
  expect(db.sessions).toHaveLength(0);
});

it('a garbled token is refused before the database is asked', async () => {
  expect(await spendLoginToken({ DB: fakeDb() }, 'short', 'ua')).toBeNull();
  expect(await spendLoginToken({ DB: fakeDb() }, "x'; DROP TABLE users;--xxxxxxxxxxxxxxxxxxxxxxxxx", 'ua')).toBeNull();
});

describe('POST /api/email/go', () => {
  const post = routes.find(r => r.method === 'POST')!;
  const form = (t: string, origin?: string) => new Request('https://orbital-empire.com/api/email/go', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
    body: `t=${encodeURIComponent(t)}`,
  });

  it('signs in and sends you to the seat', async () => {
    const db = fakeDb();
    const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'PV48OAq76SrJ', nowMs: Date.now() });
    const res = await post.handle(form(tokenOf(url!), 'https://orbital-empire.com'), { DB: db }, {});
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?play=winback&from=winback&seat=PV48OAq76SrJ');
    expect(res.headers.get('set-cookie')).toMatch(/^orbital_session=/);
  });

  it('a spent link still goes to the seat, without signing in', async () => {
    const db = fakeDb();
    const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'r1abcd', nowMs: Date.now() });
    await post.handle(form(tokenOf(url!)), { DB: db }, {});
    const res = await post.handle(form(tokenOf(url!)), { DB: db }, {});
    expect(res.headers.get('location')).toBe(seatPath('r1abcd'));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('another site cannot post a token at us', async () => {
    const db = fakeDb();
    const url = await issueLoginLink({ DB: db }, { userId: 'u1', roomId: 'r1abcd', nowMs: Date.now() });
    const res = await post.handle(form(tokenOf(url!), 'https://evil.example'), { DB: db }, {});
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(db.tokens[0].used_ms).toBeNull();
  });
});
