// GET /api/games/:gameId/trade-summary — everything the Trade panel's
// PRIVATE tab shows, in one round trip.
//
// The panel used to fetch six endpoints every five seconds: /me,
// /factions, /trades, /pacts, /trade-agreements and /asset-deals. Each
// is cheap; six of them, per open panel, per player, on a five-second
// clock, is most of the request volume a trading player generates — and
// the game has had input-lag reports. The client now refreshes on the
// room's push events with a slow poll behind them, and asks once.
//
// COMPOSED, NOT REWRITTEN. Each part is produced by the real handler
// for that endpoint, invoked in-process with the caller's own session,
// so every visibility rule (Sensors-gated rival intel on /factions, who
// may see which offer on /trades) is the one already in force. A second
// implementation of six payloads would drift from the first within a
// week. A part that fails is reported as null and the client falls back
// to the single endpoint for it; one bad part never blanks the panel.

import * as trades from './trades.js';
import * as factions from './factions.js';
import * as actions from './actions.js';

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

const PARTS = [
  { key: 'me', mod: factions, path: (g) => `/api/games/${g}/me` },
  { key: 'factions', mod: factions, path: (g) => `/api/games/${g}/factions` },
  { key: 'trades', mod: trades, path: (g) => `/api/games/${g}/trades` },
  { key: 'pacts', mod: trades, path: (g) => `/api/games/${g}/pacts` },
  { key: 'agreements', mod: trades, path: (g) => `/api/games/${g}/trade-agreements` },
  { key: 'asset_deals', mod: actions, path: (g) => `/api/games/${g}/asset-deals` },
];

async function callGet(mod, path, env, session) {
  for (const r of mod.routes ?? []) {
    if (r.method !== 'GET') continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const url = new URL(`https://orbital.internal${path}`);
    const res = await r.handle(new Request(url, { method: 'GET' }), env, {
      url, params: m.groups ?? {}, session,
    });
    if (!res || res.status >= 400) return null;
    return res.json();
  }
  return null;
}

async function handleTradeSummary(_req, env, { session, params }) {
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) {
    return new Response(JSON.stringify({ error: { code: 'bad_request', message: 'invalid game id' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const settled = await Promise.allSettled(
    PARTS.map(p => callGet(p.mod, p.path(gameId), env, session)),
  );
  const out = {};
  PARTS.forEach((p, i) => {
    const s = settled[i];
    if (s.status === 'rejected') console.error('trade-summary part failed', p.key, s.reason);
    out[p.key] = s.status === 'fulfilled' ? s.value : null;
  });
  // No faction, no panel: mirror what /me alone would have said.
  if (!out.me) {
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no faction for this user in this game' } }),
      { status: 404, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-summary$/,
    auth: 'required',
    handle: handleTradeSummary,
  },
];
