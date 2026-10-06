// ============================================================
// skins.js — colony and station skins (migration 0154).
//
// The catalogue the server enforces. The art lives client-side
// (src/render/settlementSkins.ts, which mirrors these ids); the server
// only knows which ids exist and which one per kind is free.
//
//   PATCH /api/users/me/skins  { city_skin?, station_skin? }  account default
//   lobby PATCH (lobby.js)     the same two fields, per-game override
//
// A value of null (or 'default') clears the choice. An unknown id is a
// client bug and is refused, not coerced. A premium id needs the
// Commission at the moment it is PICKED; what is DRAWN is decided again
// at read time (state.js), so a refund falls back to the free look.
// ============================================================

import { hasEntitlement } from './store.js';

export const CITY_SKINS = ['towers', 'hive', 'spires', 'domes', 'ziggurat'];
export const STATION_SKINS = ['hub', 'wheel', 'citadel', 'spindle', 'lattice'];
export const FREE_SKIN = { city: 'towers', station: 'hub' };

const CATALOGUE = { city: CITY_SKINS, station: STATION_SKINS };

/**
 * normalizeSkin('city', 'hive') -> 'hive'; null/''/'default' -> null
 * (clear the choice); anything else -> undefined (refuse it).
 */
export function normalizeSkin(kind, v) {
  if (v === null || v === undefined || v === '' || v === 'default') return null;
  return CATALOGUE[kind]?.includes(v) ? v : undefined;
}

/** null when allowed, else an error body {status, code, message}. */
export async function validateSkinChoice(env, userId, kind, raw) {
  const v = normalizeSkin(kind, raw);
  if (v === undefined) return { status: 400, code: 'bad_request', message: `unknown ${kind} style` };
  if (v && v !== FREE_SKIN[kind] && !(await hasEntitlement(env, userId))) {
    return { status: 403, code: 'premium_required', message: 'that style needs the Commander’s Commission' };
  }
  return null;
}

/**
 * Build SET clauses for whichever skin fields a body carries, validating
 * each. Shared by the account and lobby endpoints so the two can never
 * disagree on what is allowed. Returns { sets, args } or { error }.
 */
export async function skinUpdates(env, userId, body) {
  const sets = [];
  const args = [];
  for (const [field, kind] of [['city_skin', 'city'], ['station_skin', 'station']]) {
    if (body?.[field] === undefined) continue;
    const bad = await validateSkinChoice(env, userId, kind, body[field]);
    if (bad) return { error: bad };
    const v = normalizeSkin(kind, body[field]);
    if (v === null) sets.push(`${field} = NULL`);
    else { sets.push(`${field} = ?`); args.push(v); }
  }
  return { sets, args };
}

/** PATCH /api/users/me/skins — the account default, used in every game. */
async function handleAccountSkins(req, env, { session }) {
  const body = await req.json().catch(() => null);
  const res = await skinUpdates(env, session.user_id, body);
  if (res.error) {
    return new Response(JSON.stringify({ error: { code: res.error.code, message: res.error.message } }), {
      status: res.error.status, headers: { 'content-type': 'application/json' },
    });
  }
  if (!res.sets.length) {
    return new Response(JSON.stringify({ error: { code: 'bad_request', message: 'nothing to update' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  await env.DB
    .prepare(`UPDATE users SET ${res.sets.join(', ')} WHERE id = ?`)
    .bind(...res.args, session.user_id)
    .run();
  // Skins are resolved when state is read, so a running game shows the
  // new default at once, as long as its state cache is invalidated.
  await env.DB
    .prepare(`UPDATE games SET state_version = state_version + 1
               WHERE status = 'active'
                 AND id IN (SELECT game_id FROM game_factions WHERE user_id = ?)`)
    .bind(session.user_id)
    .run();
  const row = await env.DB
    .prepare('SELECT city_skin, station_skin FROM users WHERE id = ?')
    .bind(session.user_id)
    .first();
  return new Response(JSON.stringify({ city_skin: row?.city_skin ?? null, station_skin: row?.station_skin ?? null }), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * SQL for the skin an empire is DRAWN with, for a game_factions alias
 * `gf`: the lobby override, else the account default, and only while the
 * player holds the Commission (no entitlement -> NULL -> the free look).
 * Needs `rm` (room_members on room_id = game_id) and `u` (users) joined.
 */
export const DRAWN_SKIN_SQL = (field) => `CASE WHEN EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = gf.user_id)
                THEN COALESCE(rm.${field}, u.${field}) END`;

export const routes = [
  { method: 'PATCH', pattern: '/api/users/me/skins', auth: 'required', handle: handleAccountSkins },
];
