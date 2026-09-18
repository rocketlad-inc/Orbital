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

// The 'urgent' category was removed after it over-fired (see alerts.js).
// It is deliberately absent here, which retires its toggle from /notify
// and the settings panel — a switch that controls nothing is worse than
// no switch. Old notification_log rows still carry the string; nothing
// reads CATEGORIES to render history, so they remain intact.
export const CATEGORIES = {
  dm: 'Messages from other factions',
  senate: 'Senate bills and closing votes',
  economy: 'Upkeep arrears and build problems',
  // A day of pressure as ONE narrative. It still carries the fighting and
  // the inbound fleets, but it is no longer the only thing that does, so
  // muting it is no longer the same as going blind — see combat/inbound
  // below, and the warning the settings panel shows when all three are off.
  digest: 'Your daily situation report — combat, inbound fleets, votes',
  nudge: 'Reminders when you have been away',
  // Its own switch, apart from 'dm': a new post is addressed to nobody
  // in particular, and a player who mutes the board must still hear
  // about an offer made to THEM.
  market: 'New posts on the open market, and your own posts expiring',
  // Standing agreements ending. This HAD a producer
  // (tradeAgreements.js) and no entry here, which meant it sent fine —
  // categoryEnabled treats a missing row as enabled — but appeared in no
  // settings surface, so it was the one alert a player could not turn
  // off. Declared, not removed: the producer is real and wanted.
  trade: 'Standing trade agreements ending',
  // BACK FROM THE DEAD, AND ONLY BECAUSE THE PHONE EXISTS. Both of these
  // were removed for over-firing when Discord was the only transport —
  // an hourly DM about a siege that lasts forty ticks. They return
  // defaulted OFF for Discord and ON for the phone (see
  // CATEGORY_DEFAULTS), because a lock-screen line you swipe away is a
  // different proposition from a DM, and keyed on the EVENT rather than
  // on a time bucket, which is the actual reason they failed before.
  combat: 'Fighting involving your ships or settlements',
  inbound: 'Hostile fleets setting out for somewhere you hold',
};

/**
 * Where a category goes when the player has never said.
 *
 * Absent from this map means "on, everywhere", which is every category
 * that predates the phone. An entry names only the transports that
 * differ, and a player's own saved row always wins over anything here.
 */
export const CATEGORY_DEFAULTS = {
  combat: { discord: false },
  inbound: { discord: false },
};

function defaultEnabled(category, transport) {
  return CATEGORY_DEFAULTS[category]?.[transport] ?? true;
}

/**
 * The transports a preference can be expressed for.
 *
 * 'discord' is the historical `enabled` column and still the default for
 * every caller that does not say otherwise, so nothing that predates
 * push has to know this exists.
 */
export const TRANSPORTS = ['discord', 'push'];

/** One row's answer for one transport. NULL push_enabled is not "off":
 *  it means the player never expressed a phone-specific wish, so the
 *  shared switch still speaks for them. See migration 0133. */
function rowSaysEnabled(row, transport, category) {
  if (!row) return defaultEnabled(category, transport);
  if (transport === 'push') {
    return row.push_enabled == null ? !!row.enabled : !!row.push_enabled;
  }
  return !!row.enabled;
}

// 'combat' was retired the same way and has since come BACK, with a real
// producer behind it again (alerts.js) and an event-shaped dedupe key.
// The rule that retired it still stands and is the reason it took a
// second transport to justify: a switch a player turns ON must produce
// something, and one that fires every tick about the same siege gets the
// whole channel muted.

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

// ---------------------------------------------------------------------------
// Consent — the gate above the per-category prefs.
//
// Categories answer "which DMs do I want". This answers the question that
// comes first: "do I want DMs at all". A player links Discord to vote on
// senate cards; treating that as permission to message them is us
// deciding for them. Some want the server posts and nothing else, and
// they are right to.
//
// NULL = never asked (no DMs), 1 = yes, 0 = server only. Migration 0059.
// ---------------------------------------------------------------------------

/** Has this user said yes to DMs? Unasked and declined both mean no. */
export async function hasDmConsent(env, userId) {
  try {
    const row = await env.DB
      .prepare('SELECT dm_consent FROM users WHERE id = ?').bind(userId).first();
    return row?.dm_consent === 1;
  } catch {
    // Fail CLOSED, unlike categoryEnabled below. A pref lookup failing
    // should not silence an alert someone asked for; a consent lookup
    // failing must not message someone who never did.
    return false;
  }
}

/** Record an answer. `consent` true = DM me, false = server only. */
export async function setDmConsent(env, userId, consent) {
  await env.DB
    .prepare('UPDATE users SET dm_consent = ?, dm_consent_ms = ? WHERE id = ?')
    .bind(consent ? 1 : 0, Date.now(), userId)
    .run();
}

/** null = never answered, true/false = their answer. */
export async function dmConsentState(env, userId) {
  try {
    const row = await env.DB
      .prepare('SELECT dm_consent FROM users WHERE id = ?').bind(userId).first();
    if (row?.dm_consent == null) return null;
    return row.dm_consent === 1;
  } catch {
    return null;
  }
}

/** Has this user switched the category off? Absent row = enabled. */
export async function categoryEnabled(env, userId, category, transport = 'discord') {
  try {
    const row = await env.DB
      .prepare('SELECT enabled, push_enabled FROM notification_prefs WHERE user_id = ? AND category = ?')
      .bind(userId, category).first();
    return rowSaysEnabled(row, transport, category);
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
/**
 * Tell a player something.
 *
 * TWO TRANSPORTS, ONE CALL. Discord reaches whoever linked an account;
 * web push reaches the phone in their pocket. Every existing caller gets
 * both by doing nothing, which is the point — eighteen call sites had
 * already decided the category, the wording and the dedupe key, and
 * making each of them push too would be eighteen chances to miss one.
 *
 * THE RETURN VALUE STILL DESCRIBES DISCORD. `/link`, the trade buttons
 * and the digest command all read `.sent` to tell a Discord user whether
 * their DM arrived; if this started reporting "well, the phone got it"
 * those replies would start lying. Push reports separately in `.pushed`.
 */
export async function sendDm(env, opts) {
  // Independent of Discord entirely: a player who never linked an
  // account still has a phone, and that is most of the point.
  let pushed = false;
  try {
    const { pushToUser } = await import('./push.js');
    const res = await pushToUser(env, {
      ...opts,
      url: opts.url ?? '/',
    });
    pushed = !!res.sent;
  } catch (e) {
    // A push failure must never cost the Discord DM below.
    console.error('push fan-out failed', e);
  }
  const discord = await sendDiscordDm(env, opts);
  return { ...discord, pushed };
}

async function sendDiscordDm(env, opts) {
  const { userId, category, dedupeKey = null, embed, components } = opts;
  if (!env.DISCORD_BOT_TOKEN) return { sent: false, reason: 'no_bot_token' };

  try {
    const user = await env.DB
      .prepare('SELECT discord_id FROM users WHERE id = ?')
      .bind(userId).first();
    if (!user?.discord_id) return { sent: false, reason: 'not_linked' };

    // Consent first, and BEFORE the dedupe claim below. Checking it after
    // would burn the dedupe key on a message that was never sent, so the
    // moment the player opted in they'd be permanently silenced about
    // that exact event.
    if (!(await hasDmConsent(env, userId))) {
      return { sent: false, reason: 'no_dm_consent' };
    }

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

export async function getPrefs(env, userId, transport = 'discord') {
  const out = {};
  for (const k of Object.keys(CATEGORIES)) out[k] = defaultEnabled(k, transport);
  try {
    const rows = (await env.DB
      .prepare('SELECT category, enabled, push_enabled FROM notification_prefs WHERE user_id = ?')
      .bind(userId).all()).results ?? [];
    // Ignore rows for RETIRED categories. Deleting a category doesn't
    // delete the rows players already saved against it, and echoing
    // 'urgent'/'combat' back out would resurrect them in any surface
    // that renders prefs directly — the admin grid does.
    for (const r of rows) if (r.category in out) out[r.category] = rowSaysEnabled(r, transport, r.category);
  } catch { /* defaults */ }
  return out;
}

export async function setPref(env, userId, category, enabled, transport = 'discord') {
  if (!CATEGORIES[category]) return false;
  const v = enabled ? 1 : 0;
  // Two statements rather than one parameterised column name, because
  // each must leave the OTHER transport's answer exactly as it found it.
  // The upsert names only its own column, so writing a phone preference
  // for a category the player never touched inserts enabled = 1 (Discord
  // keeps its default) instead of silently muting Discord too.
  if (transport === 'push') {
    await env.DB
      .prepare(
        `INSERT INTO notification_prefs (user_id, category, enabled, push_enabled, updated_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, category) DO UPDATE SET
           push_enabled = excluded.push_enabled, updated_ms = excluded.updated_ms`,
      )
      .bind(userId, category, defaultEnabled(category, 'discord') ? 1 : 0, v, Date.now())
      .run();
    return true;
  }
  await env.DB
    .prepare(
      `INSERT INTO notification_prefs (user_id, category, enabled, updated_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, category) DO UPDATE SET
         enabled = excluded.enabled, updated_ms = excluded.updated_ms`,
    )
    .bind(userId, category, v, Date.now())
    .run();
  return true;
}

export async function setAllPrefs(env, userId, enabled, transport = 'discord') {
  for (const k of Object.keys(CATEGORIES)) await setPref(env, userId, k, enabled, transport);
}
