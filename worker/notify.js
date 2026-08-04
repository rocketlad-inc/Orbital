// ============================================================================
// notify.js — private Discord DMs to individual players.
//
// The bot's other surfaces are broadcast: a digest on a schedule, a vote
// card in a channel. This is the one that reaches a PERSON — "your city
// is under attack", "you have a message", "the vote closes and you
// haven't voted".
//
// Three rules the whole file is built around:
//
//  1. NEVER twice. Every send carries a dedupe key naming the thing being
//     reported; a unique index makes a repeat physically impossible. A
//     notifier that double-pings is worse than one that stays quiet.
//  2. NEVER load-bearing. Sending is best-effort and swallowed. A closed
//     DM, a rate limit, or a Discord outage must never fail the player
//     action that triggered it.
//  3. ALWAYS escapable. Opt-out per category via /notify. Over-notifying
//     is how this becomes muted, and a muted bot is worth less than no
//     bot at all.
// ============================================================================

const DISCORD_API = 'https://discord.com/api/v10';

export const CATEGORIES = {
  dm: 'Messages from other factions',
  combat: 'Attacks on your ships and settlements',
  senate: 'Senate bills and closing votes',
  economy: 'Upkeep arrears and build problems',
  digest: 'Your daily situation report',
  nudge: 'Reminders when you have been away',
};

function botFetch(env, method, path, body) {
  return fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Open (or fetch) the 1:1 channel with a user. Discord returns the same
 *  channel on repeat calls, so this is safe to call per notification. */
async function openDmChannel(env, discordId) {
  const res = await botFetch(env, 'POST', '/users/@me/channels', { recipient_id: discordId });
  if (!res.ok) return null;
  const ch = await res.json().catch(() => null);
  return ch?.id ?? null;
}

/** Has this user switched the category off? Absent row = enabled. */
async function categoryEnabled(env, userId, category) {
  try {
    const row = await env.DB
      .prepare('SELECT enabled FROM notification_prefs WHERE user_id = ? AND category = ?')
      .bind(userId, category).first();
    return !row || !!row.enabled;
  } catch {
    return true;    // pref table trouble must not silence real alerts
  }
}

/**
 * Send one DM.
 *
 * @param opts.userId     Orbital user id (must have a linked discord_id)
 * @param opts.category   key of CATEGORIES — gates on the user's prefs
 * @param opts.dedupeKey  stable id of the thing being reported; a repeat
 *                        is dropped before Discord is ever called
 * @param opts.embed      Discord embed object
 * @param opts.components optional button rows
 * @returns {sent:boolean, reason?:string}
 */
export async function sendDm(env, opts) {
  const { userId, category, dedupeKey = null, embed, components } = opts;
  if (!env.DISCORD_BOT_TOKEN) return { sent: false, reason: 'no_bot_token' };

  try {
    const user = await env.DB
      .prepare('SELECT discord_id FROM users WHERE id = ?')
      .bind(userId).first();
    if (!user?.discord_id) return { sent: false, reason: 'not_linked' };

    if (!(await categoryEnabled(env, userId, category))) {
      return { sent: false, reason: 'opted_out' };
    }

    // Claim the dedupe key BEFORE sending. Doing it after would leave a
    // window where two concurrent triggers both send, which is exactly
    // the case (a tick resolving while a player acts) that produces
    // duplicates.
    if (dedupeKey) {
      try {
        await env.DB
          .prepare('INSERT INTO notification_log (user_id, game_id, category, dedupe_key, ok, created_ms) VALUES (?, ?, ?, ?, 1, ?)')
          .bind(userId, opts.gameId ?? null, category, dedupeKey, Date.now())
          .run();
      } catch {
        return { sent: false, reason: 'already_sent' };   // unique index fired
      }
    }

    const channelId = await openDmChannel(env, user.discord_id);
    if (!channelId) return { sent: false, reason: 'dm_closed' };

    const payload = { embeds: [embed] };
    if (components) payload.components = components;
    const res = await botFetch(env, 'POST', `/channels/${channelId}/messages`, payload);
    if (!res.ok) {
      // A player with DMs closed is the common case and not an error
      // worth shouting about; anything else is.
      if (res.status !== 403) {
        console.error(`dm send failed ${res.status}`, await res.text().catch(() => ''));
      }
      if (dedupeKey) {
        try {
          await env.DB.prepare('UPDATE notification_log SET ok = 0 WHERE user_id = ? AND dedupe_key = ?')
            .bind(userId, dedupeKey).run();
        } catch { /* bookkeeping only */ }
      }
      return { sent: false, reason: `http_${res.status}` };
    }
    if (!dedupeKey) {
      try {
        await env.DB
          .prepare('INSERT INTO notification_log (user_id, game_id, category, dedupe_key, ok, created_ms) VALUES (?, ?, ?, NULL, 1, ?)')
          .bind(userId, opts.gameId ?? null, category, Date.now())
          .run();
      } catch { /* bookkeeping only */ }
    }
    return { sent: true };
  } catch (e) {
    console.error('sendDm threw', e);
    return { sent: false, reason: 'exception' };
  }
}

/** Resolve a faction to the human behind it (null for AI/vacated seats). */
export async function userIdForFaction(env, factionId) {
  try {
    const row = await env.DB
      .prepare('SELECT user_id FROM game_factions WHERE id = ?')
      .bind(factionId).first();
    return row?.user_id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preferences (read/write; the /notify command is the player-facing surface)
// ---------------------------------------------------------------------------

export async function getPrefs(env, userId) {
  const out = {};
  for (const k of Object.keys(CATEGORIES)) out[k] = true;
  try {
    const rows = (await env.DB
      .prepare('SELECT category, enabled FROM notification_prefs WHERE user_id = ?')
      .bind(userId).all()).results ?? [];
    for (const r of rows) out[r.category] = !!r.enabled;
  } catch { /* defaults */ }
  return out;
}

export async function setPref(env, userId, category, enabled) {
  if (!CATEGORIES[category]) return false;
  await env.DB
    .prepare(
      `INSERT INTO notification_prefs (user_id, category, enabled, updated_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, category) DO UPDATE SET
         enabled = excluded.enabled, updated_ms = excluded.updated_ms`,
    )
    .bind(userId, category, enabled ? 1 : 0, Date.now())
    .run();
  return true;
}

export async function setAllPrefs(env, userId, enabled) {
  for (const k of Object.keys(CATEGORIES)) await setPref(env, userId, k, enabled);
}
