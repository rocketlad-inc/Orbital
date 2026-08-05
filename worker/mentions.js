// ============================================================================
// mentions.js — the bot answers when spoken to.
//
// WHY THIS IS A POLLER AND NOT AN EVENT HANDLER
//
// Discord delivers messages over the Gateway websocket. A Cloudflare
// Worker cannot hold one — it is request-scoped — and the HTTP
// interactions endpoint we already run receives ONLY interactions: slash
// commands, buttons, modals, autocomplete. An @mention in ordinary chat
// is not an interaction and never arrives there. A Durable Object could
// in principle hold a gateway socket with alarm-driven heartbeats, but
// that is a stateful, reconnect-logic-heavy component to own forever so
// the bot can say hello.
//
// So: the per-minute cron that already runs asks the channel "anything
// new?" over REST. Worst-case latency is one minute. In a game where a
// tick is an hour, that is not the constraint anyone will notice.
//
// WHAT WE CAN ACTUALLY SEE
//
// Verified against the live channel before writing any of this: the bot
// reads messages fine (200, authors, mention arrays) but `content` comes
// back EMPTY on every message, because the MESSAGE CONTENT privileged
// intent is off in the developer portal.
//
// Discord documents an exception — content is delivered regardless of
// the intent for messages that @mention the app — and those are exactly
// the messages this file cares about. But the probe could not confirm it
// (no mention existed in the sample), so this code treats content as a
// BONUS, never a requirement:
//
//   • It decides WHETHER to reply from the `mentions` array alone, which
//     is always present.
//   • It decides WHAT to say from the text if there is text, and falls
//     back to a useful default when there isn't.
//
// That way it works today, and gets sharper the moment the intent is on,
// with no code change.
// ============================================================================

import { getSettings } from './botSettings.js';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Where the read cursor lives.
 *
 * It shares the bot_settings TABLE but deliberately not botSettings.js's
 * get/setSetting, which whitelist against DEFAULTS and reject anything
 * else. That whitelist is correct — it stops a typo'd key from silently
 * becoming config — and this is not config: it is internal bookkeeping
 * an operator should never see or edit in the control panel. Since
 * getSettings() also filters to DEFAULTS keys, this row stays invisible
 * to the UI exactly as it should.
 *
 * (First cut called setSetting and ignored its {ok:false} return, so the
 * cursor never persisted and every poll re-read the same window.)
 */
const CURSOR_KEY = 'mentions_last_message_id';

async function readCursor(env) {
  try {
    const row = await env.DB
      .prepare('SELECT value FROM bot_settings WHERE key = ?').bind(CURSOR_KEY).first();
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

async function writeCursor(env, id) {
  await env.DB
    .prepare(
      `INSERT INTO bot_settings (key, value, updated_ms, updated_by)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_ms = excluded.updated_ms`,
    )
    .bind(CURSOR_KEY, JSON.stringify(id), Date.now())
    .run();
}

/** Never answer a backlog. On first run — or after the bot has been down
 *  — replying to every mention since the dawn of the server would be a
 *  burst of noise nobody asked for. Older than this and we skip it and
 *  just move the cursor. */
const MAX_AGE_MS = 15 * 60 * 1000;

/** Per-poll ceiling. A spam run should cost the channel a handful of
 *  replies, not fifty. */
const MAX_REPLIES_PER_POLL = 3;

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

/** Discord snowflake -> ms. The top 42 bits are a timestamp from the
 *  Discord epoch; this is how we age a message without trusting a
 *  separate field. */
function snowflakeMs(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return 0; }
}

// ---------------------------------------------------------------------------
// What to say
// ---------------------------------------------------------------------------

/**
 * Route on the text when we have it. Deliberately keyword matching and
 * not an LLM call: this runs on every mention, in a cron, and a bot that
 * costs money per hello is a bot that gets switched off. The keywords
 * mirror the slash commands so there is one mental model, not two.
 */
function intentOf(text) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  if (/\b(fleet|ships?|navy|hulls?)\b/.test(t)) return 'fleet';
  if (/\b(research|tech|science)\b/.test(t)) return 'research';
  if (/\b(bill|senate|vote|law)\b/.test(t)) return 'bills';
  if (/\b(map|territory|who owns|border)\b/.test(t)) return 'map';
  if (/\b(status|empire|how am i|doing)\b/.test(t)) return 'status';
  if (/\b(help|commands?|what can you)\b/.test(t)) return 'help';
  if (/\b(hi|hello|hey|yo|sup|thanks|thank you)\b/.test(t)) return 'greet';
  return null;
}

/**
 * Voice note: dry, procedural, a station operator on a long shift. It
 * should never pretend to be a person or to know things it doesn't. When
 * it can't read the message it says so plainly rather than bluffing a
 * reply to a question it never saw.
 */
const GREETINGS = [
  'Comms open. Ask me for `status`, `fleet`, `research`, `bills` or `map`.',
  'Receiving you. Try `status`, `fleet`, `research`, `bills` or `map`.',
  'Station actual, listening. `status`, `fleet`, `research`, `bills`, `map`.',
];

async function buildReply(env, discordId, text, canReadText) {
  const cmds = await import('./commands.js');
  const intent = intentOf(text);

  if (intent === 'help' || (!intent && canReadText)) {
    return {
      content: [
        "I answer to `@` and to slash commands.",
        '',
        '• `status` — resources, holdings, anything awaiting you',
        '• `fleet` — where your ships are',
        '• `research` — what you are building toward',
        '• `bills` — what is on the senate floor and your vote weight',
        '• `map` — the current territory strip',
        '',
        '_Slash commands answer privately; mentions answer here._',
      ].join('\n'),
    };
  }

  if (intent === 'greet') {
    // Vary by the caller's id, not at random — Math.random is banned in
    // some execution paths here and a stable greeting per person reads
    // as recognition rather than a slot machine.
    const i = Number(BigInt(discordId) % BigInt(GREETINGS.length));
    return { content: GREETINGS[i] };
  }

  const map = {
    fleet: cmds.cmdFleet,
    research: cmds.cmdResearch,
    bills: cmds.cmdBills,
    map: cmds.cmdMap,
    status: cmds.cmdStatus,
  };
  const fn = map[intent] ?? cmds.cmdStatus;

  // The slash-command handlers return a full interaction response. We
  // want the payload inside it, posted as a normal channel message —
  // reusing them means /status and "@bot status" can never disagree.
  const res = await fn(env, discordId);
  const data = res?.data ?? {};

  const prefix = canReadText ? null
    // Honest about the blind spot: without the message-content intent we
    // know we were pinged but not what was asked. Better to say so than
    // to answer a question nobody asked and look broken.
    : '_(I can see you pinged me but not what you wrote — here is your status. '
      + 'Slash commands take specifics.)_';

  const out = {};
  if (data.embeds) out.embeds = data.embeds;
  if (data.content || prefix) {
    out.content = [prefix, data.content].filter(Boolean).join('\n');
  }
  if (!out.embeds && !out.content) out.content = 'Nothing to report.';
  return out;
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

/**
 * Look for new mentions and answer them. Safe to call every minute; safe
 * to call concurrently (worst case a duplicate reply, never a crash).
 *
 * Cursor semantics: we advance to the newest message we SAW, not the
 * newest we answered. Otherwise one un-answerable message (an unlinked
 * player, a failed send) would pin the cursor and we would re-read the
 * same window forever.
 */
export async function pollMentions(env) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, reason: 'no_bot_token' };

  const settings = await getSettings(env);
  if (settings.mentions_enabled === false) return { ok: false, reason: 'disabled' };

  const discord = await import('./discord.js');
  const channelId = await discord.resolveChannelIdPublic(env);
  if (!channelId) return { ok: false, reason: 'no_channel' };

  const appRes = await botFetch(env, 'GET', '/applications/@me');
  if (!appRes.ok) return { ok: false, reason: `app_${appRes.status}` };
  const botId = (await appRes.json())?.id;
  if (!botId) return { ok: false, reason: 'no_app_id' };

  const cursor = await readCursor(env);

  const qs = cursor ? `?after=${cursor}&limit=50` : '?limit=10';
  const res = await botFetch(env, 'GET', `/channels/${channelId}/messages${qs}`);
  if (!res.ok) {
    return { ok: false, reason: `fetch_${res.status}` };
  }
  const msgs = await res.json();
  if (!Array.isArray(msgs) || msgs.length === 0) return { ok: true, seen: 0, replied: 0 };

  // Discord returns newest-first; answer in the order they were said.
  msgs.reverse();
  const newest = msgs[msgs.length - 1].id;

  // First ever run: adopt the cursor and answer nothing. Otherwise
  // switching this on would dump replies into a channel mid-conversation.
  if (!cursor) {
    await writeCursor(env, newest);
    return { ok: true, seen: msgs.length, replied: 0, note: 'cursor initialised', newest };
  }

  const now = Date.now();
  let replied = 0;
  for (const m of msgs) {
    if (replied >= MAX_REPLIES_PER_POLL) break;
    if (m.author?.bot) continue;
    const mentioned = (m.mentions ?? []).some(u => u.id === botId);
    if (!mentioned) continue;
    if (now - snowflakeMs(m.id) > MAX_AGE_MS) continue;

    try {
      const linked = await env.DB
        .prepare('SELECT id FROM users WHERE discord_id = ?')
        .bind(m.author.id).first();

      const payload = linked
        ? await buildReply(env, m.author.id, m.content ?? '', !!(m.content ?? '').trim())
        : {
            content: 'I do not know which empire is yours yet. Open Orbital → '
              + 'Notifications → **Connect Discord**, then ping me again.',
          };

      // Reply-to, so an answer in a busy channel is attached to the
      // question. fail_if_not_exists:false means a deleted question
      // degrades to a normal message instead of erroring.
      payload.message_reference = { message_id: m.id, fail_if_not_exists: false };
      payload.allowed_mentions = { parse: [] };   // never ping anyone back

      const post = await botFetch(env, 'POST', `/channels/${channelId}/messages`, payload);
      if (post.ok) replied += 1;
      else console.error('mention reply failed', post.status, await post.text().catch(() => ''));
    } catch (e) {
      console.error('mention handling threw', e, { id: m.id });
    }
  }

  await writeCursor(env, newest);
  return { ok: true, seen: msgs.length, replied };
}
