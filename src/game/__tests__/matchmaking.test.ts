// WHICH LOBBIES A NEWCOMER CAN BE SENT TO (worker/matchmaking.js).
//
// The Quick Join button and the win-back email both read this. The rule
// that matters is "can it start": on 2026-10-09 the first win-back batch
// pointed twelve people at a lobby whose host had been gone six days. It
// could fill; it could never begin. So a lobby only counts when it starts
// itself (Quick Join) or its host has been seen in the last 48 hours.

import { joinableLobbies, LOBBY_FRESH_MS, HOST_ACTIVE_MS } from '../../../worker/matchmaking.js';

const NOW = Date.UTC(2026, 9, 9, 1);

/** A fake D1 that evaluates the same rules over plain rows, and records the SQL. */
function fakeEnv(rooms: any[], users: Record<string, { last_visit_ms: number | null }>) {
  const seen: { sql: string; binds: unknown[] } = { sql: '', binds: [] };
  const env = {
    DB: {
      prepare(sql: string) {
        seen.sql = sql;
        return {
          bind(...binds: any[]) {
            seen.binds = binds;
            const [fresh, hostActive, exclude, only, limit] = binds;
            return {
              all: async () => ({
                results: rooms
                  .filter(r => r.status === 'lobby' && !r.password && r.updated_at > fresh && !r.started)
                  .filter(r => r.quick_join === 1 || (users[r.host]?.last_visit_ms ?? 0) > hostActive)
                  .filter(r => exclude == null || !r.members.includes(exclude))
                  .filter(r => only == null || r.id === only)
                  .map(r => ({ id: r.id, name: r.id, max_players: r.max, quick_join: r.quick_join, updated_at: r.updated_at, n: r.members.length }))
                  .sort((a, b) => (a.max_players - a.n) - (b.max_players - b.n) || b.updated_at - a.updated_at)
                  .slice(0, limit),
              }),
            };
          },
        };
      },
    },
  };
  return { env, seen };
}

const H = 3600_000;
const room = (id: string, over: object) => ({
  id, status: 'lobby', password: false, started: false, quick_join: 0, max: 4,
  updated_at: NOW - H, members: ['host'], host: 'host', ...over,
});

it('asks the database for startable lobbies only', async () => {
  const { env, seen } = fakeEnv([], {});
  await joinableLobbies(env, NOW);
  expect(seen.sql).toMatch(/r\.quick_join = 1 OR COALESCE\(h\.last_visit_ms, 0\) > \?2/);
  expect(seen.sql).toMatch(/password_hash IS NULL/);
  expect(seen.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM games/);
  expect(seen.binds.slice(0, 2)).toEqual([NOW - LOBBY_FRESH_MS, NOW - HOST_ACTIVE_MS]);
});

it('the 2026-10-09 lobbies: the abandoned one is not offered', async () => {
  const { env } = fakeEnv(
    [
      room('test', { members: ['kendel', 'a', 'b'], host: 'kendel', max: 4 }),
      room('pallas', { members: ['john', 'a', 'b', 'c'], host: 'john', max: 5, quick_join: 1 }),
      room('diplo', { members: ['jrg', 'a'], host: 'jrg', max: 6 }),
    ],
    {
      kendel: { last_visit_ms: NOW - 141 * H },  // gone six days
      john: { last_visit_ms: NOW - 23 * H },
      jrg: { last_visit_ms: NOW - 5 * H },
    },
  );
  const rows = await joinableLobbies(env, NOW);
  expect(rows.map(r => r.id)).toEqual(['pallas', 'diplo']);
});

it('a Quick Join room counts even when its host has gone: it starts itself', async () => {
  const { env } = fakeEnv([room('q', { quick_join: 1, host: 'ghost' })], { ghost: { last_visit_ms: null } });
  expect((await joinableLobbies(env, NOW)).map(r => r.id)).toEqual(['q']);
});

it('full lobbies never come back, whatever the database says', async () => {
  const { env } = fakeEnv([room('full', { members: ['host', 'a', 'b', 'c'], max: 4 })], { host: { last_visit_ms: NOW } });
  expect(await joinableLobbies(env, NOW)).toEqual([]);
});

it('a named lobby can be asked about on its own', async () => {
  const { env } = fakeEnv(
    [room('a', {}), room('b', { members: ['host', 'x'] })],
    { host: { last_visit_ms: NOW } },
  );
  expect((await joinableLobbies(env, NOW, { roomId: 'a' })).map(r => r.id)).toEqual(['a']);
  expect((await joinableLobbies(env, NOW, { excludeUserId: 'x' })).map(r => r.id)).toEqual(['a']);
});
