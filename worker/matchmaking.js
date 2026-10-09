// ============================================================================
// matchmaking.js — which lobbies a newcomer can be sent to.
//
// One definition, used by the Quick Join button (worker/index.js
// handleQuickJoin) and the win-back email (worker/winback.js), so a
// lobby the email names is a lobby the click can seat you in.
//
// A lobby is JOINABLE when it is public (no password), has not started,
// has a free seat, was touched in the last week, and CAN START:
//   - a Quick Join room starts itself when its last seat fills, or
//   - its host has visited in the last 48 hours, so someone is there to
//     press START.
// The second rule is the one that matters. On 2026-10-09 the first
// win-back batch pointed twelve people at "test", a lobby whose host
// had been gone six days: it could fill, and it could never begin.
//
// Best first: fewest seats left (closest to starting), then most
// recently active.
// ============================================================================

export const LOBBY_FRESH_MS = 7 * 24 * 3600 * 1000;
export const HOST_ACTIVE_MS = 48 * 3600 * 1000;

/**
 * @param opts.excludeUserId  leave out lobbies this person already sits in
 * @param opts.roomId         only this lobby (is it still joinable?)
 * @returns rows { id, name, max_players, quick_join, updated_at, n }, n < max_players
 */
export async function joinableLobbies(env, nowMs = Date.now(), { excludeUserId = null, roomId = null, limit = 10 } = {}) {
  const rows = (await env.DB
    .prepare(
      `SELECT r.id, r.name, r.max_players, r.quick_join, r.updated_at,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS n
         FROM rooms r JOIN users h ON h.id = r.host_id
        WHERE r.status = 'lobby'
          AND r.password_hash IS NULL
          AND r.updated_at > ?1
          AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = r.id)
          AND (r.quick_join = 1 OR COALESCE(h.last_visit_ms, 0) > ?2)
          AND (?3 IS NULL OR NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?3))
          AND (?4 IS NULL OR r.id = ?4)
        ORDER BY (r.max_players - (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id)) ASC,
                 r.updated_at DESC
        LIMIT ?5`,
    )
    .bind(nowMs - LOBBY_FRESH_MS, nowMs - HOST_ACTIVE_MS, excludeUserId, roomId, limit)
    .all()).results ?? [];
  return rows.filter(r => r.n < r.max_players);
}

/**
 * Take one seat in one lobby, or nothing. The count is re-checked inside
 * the INSERT, so two people racing for the last seat cannot both get it.
 * Returns true when this call added the member.
 */
export async function takeSeat(env, roomId, userId, nowMs = Date.now()) {
  const ins = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at)
       SELECT ?1, ?2, ?3
        WHERE (SELECT COUNT(*) FROM room_members WHERE room_id = ?1)
            < (SELECT max_players FROM rooms WHERE id = ?1 AND status = 'lobby')`,
    )
    .bind(roomId, userId, nowMs)
    .run();
  return (ins.meta?.changes ?? 0) === 1;
}
