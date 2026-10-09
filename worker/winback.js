// ============================================================================
// winback.js — one email to a player who signed up and never sat down.
//
// WHO: an account at least 48 hours old that has never joined a lobby or a
// game (no room_members row, no game_factions row), can take mail, and has
// not turned game mail off. Once per account, ever (email_log dedupe key
// `winback:<user>`), so a backfill of every old account and the steady
// trickle of new ones are the same query.
//
// WHERE TO: never a specific seat. Seats fill and lobbies start while an
// email sits unread, so the button is /?play=winback and the room is
// chosen when it is CLICKED, by Quick Join (worker/index.js
// handleQuickJoin): the open lobby with the fewest seats left, or a fresh
// self-starting room. The email only names the best lobby at send time,
// as a hook.
//
// HOW MANY, and when there is nowhere to go (planWinback):
//   seat  an open public lobby exists. Mail at most two people per open
//         seat (not everyone clicks), capped per hour, newest signups
//         first; the next hour sends more if seats are still open.
//   pool  nothing is open, but at least POOL_MIN people are waiting. Mail
//         POOL_SIZE of them in the same minute: the first to click opens
//         a Quick Join room, and everyone after lands in it, so they fill
//         one game together instead of each waiting alone in their own.
//   hold  nothing is open and too few are waiting. Send nothing; look
//         again next hour.
//
// Lobbies only. A running game is never offered: a newcomer should start
// even with everyone else.
// ============================================================================

import { tr, normalizeLocale } from './i18n.js';
import { emailConfigured, sendEmail, layout, textLayout, esc, unsubscribeUrl } from './email.js';

export const WINBACK_AFTER_MS = 48 * 3600 * 1000;
export const WINBACK_HOURLY_CAP = 20;
export const WINBACK_PER_SEAT = 2;
export const POOL_MIN = 4;
export const POOL_SIZE = 8;
/** Quick Join's own freshness bar: a lobby untouched for a week is a trap. */
const LOBBY_FRESH_MS = 7 * 24 * 3600 * 1000;
/** The self-starting room a pool click opens (worker/index.js QUICK_JOIN_SEATS). */
const POOL_ROOM_SEATS = 5;

/** The button. App.tsx reads ?play=winback once the reader is signed in. */
export const WINBACK_URL = 'https://orbital-empire.com/?play=winback&from=winback';

/**
 * Decide this hour's sends. Pure, so the rules are testable without a DB.
 *
 * @param eligible  waiting accounts, newest signup first
 * @param lobbies   open public lobbies, best first (fewest seats left)
 * @returns {{ mode: 'seat'|'pool'|'hold', recipients: object[], room: object|null }}
 */
export function planWinback({ eligible, lobbies }) {
  if (!eligible.length) return { mode: 'hold', recipients: [], room: null };
  const open = lobbies.filter(l => l.n < l.max_players);
  if (open.length) {
    const seats = open.reduce((s, l) => s + (l.max_players - l.n), 0);
    const budget = Math.min(WINBACK_HOURLY_CAP, seats * WINBACK_PER_SEAT);
    return { mode: 'seat', recipients: eligible.slice(0, budget), room: open[0] };
  }
  if (eligible.length >= POOL_MIN) {
    return { mode: 'pool', recipients: eligible.slice(0, POOL_SIZE), room: null };
  }
  return { mode: 'hold', recipients: [], room: null };
}

async function eligibleAccounts(env, nowMs) {
  return (await env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.locale
         FROM users u
        WHERE u.created_at <= ?
          AND u.email IS NOT NULL
          AND u.email NOT LIKE '%@agents.orbital.local'
          AND COALESCE(u.email_games, 1) <> 0
          AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM game_factions gf WHERE gf.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.dedupe_key = 'winback:' || u.id)
        ORDER BY u.created_at DESC
        LIMIT ?`,
    )
    .bind(nowMs - WINBACK_AFTER_MS, Math.max(WINBACK_HOURLY_CAP, POOL_SIZE))
    .all()).results ?? [];
}

/** The same rooms Quick Join would seat someone in, best first. */
async function openLobbies(env, nowMs) {
  return (await env.DB
    .prepare(
      `SELECT r.id, r.name, r.max_players, r.quick_join,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS n
         FROM rooms r
        WHERE r.status = 'lobby'
          AND r.password_hash IS NULL
          AND r.updated_at > ?
          AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = r.id)
        ORDER BY (r.max_players - (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id)) ASC,
                 r.updated_at DESC
        LIMIT 10`,
    )
    .bind(nowMs - LOBBY_FRESH_MS)
    .all()).results ?? [];
}

/** Subject, lines and button for one reader. Exported for the preview. */
export function composeWinback(locale, mode, room) {
  const L = normalizeLocale(locale) ?? 'en';
  const seat = mode === 'seat' && room;
  const lines = seat
    ? [
        tr(L, 'email.winback.seat.l1', { name: room.name, n: room.n, max: room.max_players }),
        tr(L, room.quick_join === 1 ? 'email.winback.seat.autostart' : 'email.winback.seat.host'),
      ]
    : [tr(L, 'email.winback.pool.l1', { n: POOL_ROOM_SEATS })];
  lines.push(tr(L, 'email.winback.l2'));
  return {
    L,
    subject: tr(L, seat ? 'email.winback.seat.subject' : 'email.winback.pool.subject'),
    preheader: seat
      ? tr(L, 'email.winback.seat.preheader', { name: room.name, n: room.n, max: room.max_players })
      : tr(L, 'email.winback.pool.preheader'),
    heading: tr(L, seat ? 'email.winback.seat.heading' : 'email.winback.pool.heading'),
    lines,
    cta: { label: tr(L, 'email.winback.cta'), url: WINBACK_URL },
    footer: tr(L, 'email.winback.footer'),
  };
}

async function sendWinback(env, user, mode, room) {
  const c = composeWinback(user.locale, mode, room);
  const unsubUrl = await unsubscribeUrl(env, user.id, 'games');
  return sendEmail(env, {
    userId: user.id, to: user.email, kind: `winback_${mode}`, category: 'games',
    dedupeKey: `winback:${user.id}`,
    subject: c.subject,
    html: layout({
      locale: c.L,
      preheader: c.preheader,
      heading: c.heading,
      body: c.lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
      cta: c.cta,
      footer: esc(c.footer),
      unsubUrl,
    }),
    text: textLayout({ locale: c.L, heading: c.heading, lines: c.lines, cta: c.cta, footer: c.footer, unsubUrl }),
  });
}

/**
 * Called from the every-minute cron. One pass per hour (a run marker in
 * email_log, like the Herald's), never throws.
 */
export async function maybeSendWinbackEmails(env, nowMs = Date.now()) {
  if (!emailConfigured(env) || !env.EMAIL_LINK_SECRET) return;
  const hour = Math.floor(nowMs / 3600000);
  try {
    await env.DB
      .prepare('INSERT INTO email_log (user_id, kind, dedupe_key, ok, created_ms) VALUES (NULL, ?, ?, 1, ?)')
      .bind('winback_run', `winback_run:${hour}`, nowMs).run();
  } catch {
    return; // this hour already ran
  }
  const eligible = await eligibleAccounts(env, nowMs);
  if (!eligible.length) return;
  const plan = planWinback({ eligible, lobbies: await openLobbies(env, nowMs) });
  for (const user of plan.recipients) {
    try {
      await sendWinback(env, user, plan.mode, plan.room);
    } catch (e) {
      console.error(`winback send failed for ${user.id}`, e);
    }
  }
}

/**
 * The click: Quick Join was called from a winback link. Recorded once per
 * account next to the send, so the funnel (sent -> clicked -> seated ->
 * still playing) reads out of email_log + room_members. Never throws.
 */
export async function recordWinbackClick(env, userId) {
  try {
    await env.DB
      .prepare("INSERT INTO email_log (user_id, kind, dedupe_key, ok, created_ms) VALUES (?, 'winback_click', ?, 1, ?)")
      .bind(userId, `winback_click:${userId}`, Date.now()).run();
  } catch { /* already clicked once */ }
}
