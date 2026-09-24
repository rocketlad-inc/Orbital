// ============================================================
// Name banks follow the player, not the lobby.
//
// Custom name pools (migration 0114) live on room_members, one row per
// player per room, so every new game started with four empty lists. A
// player who uploaded hundreds of names for one match had to find the
// file and upload them all again for the next (2026-09-24).
//
// Two answers, because there are two moments:
//
//   JOINING. carryNamePools copies the player's most recent non-empty
//   bank into the room they just entered — only if that room has none
//   yet, so it never overwrites a list made here, and never resurrects
//   one they cleared (an emptied list saves as [] arrays, not NULL).
//
//   ALREADY SAT IN A LOBBY. handleNamePoolHistory lists their past
//   banks so the editor can offer "use names from a past game".
//
// Nothing new is stored: the history IS the room_members rows.
// ============================================================

import { parseNamePools, NAME_KINDS } from '../src/game/namePools.js';

/** A row whose bank holds at least one name. json_valid first: the
 *  column is free text, and a malformed row must not fail the query. */
const HAS_NAMES = (a) => `json_valid(${a}.name_pools) AND (
     COALESCE(json_array_length(${a}.name_pools, '$.ship'), 0)
   + COALESCE(json_array_length(${a}.name_pools, '$.captain'), 0)
   + COALESCE(json_array_length(${a}.name_pools, '$.station'), 0)
   + COALESCE(json_array_length(${a}.name_pools, '$.city'), 0)) > 0`;

/**
 * Give a player who just joined roomId their most recent bank.
 * Best-effort: a failure here must never cost anyone their seat.
 *
 * Also fills the player's faction in a RUNNING game (late join), which
 * reads game_factions.name_pools and was never seeded at all for a
 * latecomer.
 */
export async function carryNamePools(env, roomId, userId) {
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE room_members
            SET name_pools = (
              SELECT p.name_pools FROM room_members p
               WHERE p.user_id = ?1 AND p.room_id != ?2 AND ${HAS_NAMES('p')}
               ORDER BY p.joined_at DESC LIMIT 1)
          WHERE room_id = ?2 AND user_id = ?1 AND name_pools IS NULL`,
      ).bind(userId, roomId),
      env.DB.prepare(
        `UPDATE game_factions
            SET name_pools = (SELECT m.name_pools FROM room_members m
                               WHERE m.room_id = ?2 AND m.user_id = ?1)
          WHERE game_id = ?2 AND user_id = ?1 AND name_pools IS NULL`,
      ).bind(userId, roomId),
    ]);
  } catch (e) {
    console.warn('carryNamePools failed', e);
  }
}

const HISTORY_MAX = 8;

/**
 * GET /api/lobby/name-pools/history — the caller's own past banks,
 * newest first, identical banks listed once, empty ones left out.
 * ?exclude=<roomId> leaves out the lobby asking.
 */
export async function handleNamePoolHistory(req, env, ctx) {
  const exclude = new URL(req.url).searchParams.get('exclude') ?? '';
  const rows = (await env.DB
    .prepare(
      `SELECT m.room_id, m.joined_at, m.name_pools, r.name AS room_name
         FROM room_members m
         LEFT JOIN rooms r ON r.id = m.room_id
        WHERE m.user_id = ? AND m.room_id != ? AND ${HAS_NAMES('m')}
        ORDER BY m.joined_at DESC
        LIMIT 40`,
    )
    .bind(ctx.session.user_id, exclude)
    .all()).results ?? [];

  const seen = new Set();
  const banks = [];
  for (const r of rows) {
    const pools = parseNamePools(r.name_pools);
    const key = JSON.stringify(pools);
    if (seen.has(key)) continue;
    seen.add(key);
    const counts = Object.fromEntries(NAME_KINDS.map(k => [k, pools[k].length]));
    if (NAME_KINDS.every(k => counts[k] === 0)) continue;
    banks.push({
      room_id: r.room_id,
      room_name: r.room_name ?? 'A past game',
      joined_at: r.joined_at,
      counts,
      pools,
    });
    if (banks.length >= HISTORY_MAX) break;
  }
  return new Response(JSON.stringify({ banks }), {
    headers: { 'content-type': 'application/json' },
  });
}
