// ============================================================================
// email.js — the mail a website owes its players.
//
// Cloudflare Email Sending, through the `EMAIL` binding (wrangler.jsonc
// send_email). No binding = no mail: staging has none on purpose, so it
// can never write to a real inbox, same as every other outbound
// integration here.
//
// WHAT GOES BY EMAIL, and why so little:
//   account   welcome, password reset       no switch (it is your account)
//   games     a game you're in starts/ends  users.email_games
//   herald    ONE daily Herald, all games   users.email_herald
// Email is not a fourth copy of every phone alert. A player who gets an
// email per siege turns them all off, and then the password reset lands
// in a folder nobody reads.
//
// Same three rules as notify.js:
//   1. NEVER twice. Each send names its event in email_log.dedupe_key and
//      the unique index makes a repeat impossible. Claimed BEFORE sending.
//   2. NEVER load-bearing. A mail failure is logged and swallowed; it can
//      never fail the signup, the start or the tick that triggered it.
//   3. ALWAYS escapable. Every non-account mail carries a one-click
//      unsubscribe (List-Unsubscribe + List-Unsubscribe-Post, which Gmail
//      and Yahoo require of bulk senders) signed with EMAIL_LINK_SECRET.
// ============================================================================

const SITE = 'https://orbital-empire.com';
const FROM = { email: 'noreply@orbital-empire.com', name: 'Orbital' };
const REPLY_TO = 'support@orbital-empire.com';
const LOGO_URL = `${SITE}/press/logo/orbital-wordmark-gold.png`;

/** Agent accounts live on a domain that can never receive mail. */
const UNDELIVERABLE = /@agents\.orbital\.local$/i;

/** The switches a player can flip, and what the page calls them. */
export const EMAIL_CATEGORIES = {
  games: 'Game updates: when a game you are in starts and ends',
  herald: 'The daily Herald: one email a day covering all your games',
};

export function emailConfigured(env) {
  return !!env?.EMAIL && typeof env.EMAIL.send === 'function';
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send one email. Never throws.
 *
 * @param opts.userId      recipient's user id (for the log; may be null)
 * @param opts.to          address
 * @param opts.kind        short label for the log (welcome, reset, ...)
 * @param opts.dedupeKey   stable name of the event; a repeat is dropped
 * @param opts.subject
 * @param opts.html
 * @param opts.text
 * @param opts.category    'games' | 'herald' — adds the unsubscribe headers
 * @returns {{sent:boolean, reason?:string}}
 */
export async function sendEmail(env, opts) {
  const { userId = null, to, kind, dedupeKey = null, subject, html, text, category = null } = opts;
  if (!emailConfigured(env)) return { sent: false, reason: 'not_configured' };
  if (!to || UNDELIVERABLE.test(to)) return { sent: false, reason: 'undeliverable' };

  // Claim first: two concurrent triggers (a tick resolving while a
  // player acts) must not both send.
  let logId = null;
  try {
    const res = await env.DB
      .prepare('INSERT INTO email_log (user_id, kind, dedupe_key, ok, created_ms) VALUES (?, ?, ?, 1, ?)')
      .bind(userId, kind, dedupeKey, Date.now())
      .run();
    logId = res.meta?.last_row_id ?? null;
  } catch {
    if (dedupeKey) return { sent: false, reason: 'already_sent' };
  }

  const headers = {};
  if (category && userId) {
    const unsub = await unsubscribeUrl(env, userId, category);
    if (unsub) {
      headers['List-Unsubscribe'] = `<${unsub}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
  }

  try {
    await env.EMAIL.send({
      to,
      from: FROM,
      replyTo: REPLY_TO,
      subject,
      html,
      text,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    return { sent: true };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    console.error(`email send failed (${kind})`, msg);
    if (logId != null) {
      try {
        await env.DB.prepare('UPDATE email_log SET ok = 0, error = ? WHERE id = ?').bind(msg, logId).run();
      } catch { /* bookkeeping only */ }
    }
    return { sent: false, reason: 'send_failed' };
  }
}

// ---------------------------------------------------------------------------
// Preferences + signed unsubscribe links
// ---------------------------------------------------------------------------

function prefColumn(category) {
  return category === 'herald' ? 'email_herald' : category === 'games' ? 'email_games' : null;
}

/** NULL = never said = on. */
export async function getEmailPrefs(env, userId) {
  const row = await env.DB
    .prepare('SELECT email, email_herald, email_games FROM users WHERE id = ?')
    .bind(userId).first();
  return {
    address: row?.email && !UNDELIVERABLE.test(row.email) ? row.email : null,
    herald: row?.email_herald == null ? true : row.email_herald === 1,
    games: row?.email_games == null ? true : row.email_games === 1,
  };
}

export async function setEmailPref(env, userId, category, enabled) {
  const col = prefColumn(category);
  if (!col) return false;
  await env.DB.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).bind(enabled ? 1 : 0, userId).run();
  return true;
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(env, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.EMAIL_LINK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** A link that switches one category off for one user, no sign-in. */
export async function unsubscribeUrl(env, userId, category) {
  if (!env.EMAIL_LINK_SECRET || !prefColumn(category)) return null;
  const sig = await hmac(env, `unsub:${userId}:${category}`);
  const t = `${b64url(new TextEncoder().encode(userId))}.${category}.${sig}`;
  return `${SITE}/api/email/unsubscribe?t=${t}`;
}

/** Verify a token from unsubscribeUrl. Returns {userId, category} or null. */
export async function readUnsubscribeToken(env, t) {
  if (!env.EMAIL_LINK_SECRET || typeof t !== 'string') return null;
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  const [uid64, category, sig] = parts;
  if (!prefColumn(category)) return null;
  let userId;
  try {
    userId = new TextDecoder().decode(Uint8Array.from(atob(uid64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
  } catch { return null; }
  const want = await hmac(env, `unsub:${userId}:${category}`);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { userId, category } : null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const C = {
  page: '#05080d', card: '#0d131c', border: '#1f2a38',
  ink: '#dbe6f0', dim: '#8ea1b3', gold: '#ffb84d', teal: '#4ecdc4',
};
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * The one layout every email wears. Table-based and inline-styled because
 * that is what survives Outlook and Gmail; dark because the game is.
 *
 * @param p.preheader  the grey line inboxes show after the subject
 * @param p.heading
 * @param p.body       trusted HTML (callers escape their own values)
 * @param p.cta        {label, url} optional button
 * @param p.footer     trusted HTML: why you got this
 * @param p.unsubUrl   optional
 */
export function layout(p) {
  const button = p.cta ? `
    <tr><td style="padding:8px 32px 28px">
      <a href="${esc(p.cta.url)}" style="display:inline-block;background:${C.gold};color:#1a1204;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;padding:13px 26px;border-radius:3px">${esc(p.cta.label)}</a>
    </td></tr>` : '';
  const unsub = p.unsubUrl
    ? `<br><a href="${esc(p.unsubUrl)}" style="color:${C.dim}">Unsubscribe</a> · <a href="${SITE}/?settings=email" style="color:${C.dim}">Email settings</a>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>${esc(p.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(p.preheader ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:${C.card};border:1px solid ${C.border};border-radius:4px">
    <tr><td style="padding:26px 32px 6px;border-bottom:1px solid ${C.border}">
      <a href="${SITE}" style="text-decoration:none"><img src="${LOGO_URL}" width="132" alt="ORBITAL" style="display:block;border:0;height:auto;color:${C.gold};font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:.2em"></a>
      <div style="height:18px"></div>
    </td></tr>
    <tr><td style="padding:26px 32px 6px;font-family:${FONT}">
      <h1 style="margin:0 0 14px;color:${C.ink};font-size:22px;line-height:1.3;font-weight:700">${esc(p.heading)}</h1>
      <div style="color:${C.ink};font-size:15px;line-height:1.6">${p.body}</div>
    </td></tr>
    ${button}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
    <tr><td style="padding:16px 32px;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim}">
      ${p.footer ?? ''}${unsub}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Plain-text twin. Every email ships both: some clients show only text,
 *  and a text part helps the spam score. */
export function textLayout({ heading, lines, cta, footer, unsubUrl }) {
  const out = [heading, '='.repeat(Math.min(60, heading.length)), '', ...lines];
  if (cta) out.push('', `${cta.label}: ${cta.url}`);
  out.push('', '--', footer ?? 'Orbital · orbital-empire.com');
  if (unsubUrl) out.push(`Unsubscribe: ${unsubUrl}`);
  return out.join('\n');
}

/** A room link the app opens straight into (App.tsx reads ?room=). */
export function roomUrl(roomId) {
  return `${SITE}/?room=${encodeURIComponent(roomId)}`;
}

// ---------------------------------------------------------------------------
// Account mail
// ---------------------------------------------------------------------------

export async function sendWelcome(env, user) {
  const name = user.display_name || 'Commander';
  const heading = `Welcome to Orbital, ${name}`;
  const lines = [
    'Your account is ready. Orbital is a strategy game across the whole Sol system, on a clock that keeps running while you are away.',
    'The fastest way in: press QUICK JOIN in the lobby and we will seat you in the game closest to starting.',
    'Each turn is an hour of real time, so check in when it suits you. A fleet you send tonight will have arrived by morning.',
  ];
  return sendEmail(env, {
    userId: user.id, to: user.email, kind: 'welcome', dedupeKey: `welcome:${user.id}`,
    subject: 'Welcome to Orbital',
    html: layout({
      preheader: 'Your account is ready. Quick Join seats you in a game in one click.',
      heading,
      body: lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
      cta: { label: 'Find a game', url: SITE },
      footer: `You are getting this because an Orbital account was created with this address. If that wasn't you, reply to this email and we will remove it.`,
    }),
    text: textLayout({
      heading, lines, cta: { label: 'Find a game', url: SITE },
      footer: "You are getting this because an Orbital account was created with this address. If that wasn't you, reply and we will remove it.",
    }),
  });
}

export async function sendPasswordReset(env, user, link, tokenHash) {
  const heading = 'Reset your password';
  const lines = [
    `Someone (hopefully you) asked to reset the password for the Orbital account ${user.email}.`,
    'The link below works once and expires in one hour. Using it signs you out on every other device.',
    "If you didn't ask for this, ignore this email. Your password stays as it is.",
  ];
  return sendEmail(env, {
    userId: user.id, to: user.email, kind: 'reset', dedupeKey: `reset:${tokenHash}`,
    subject: 'Reset your Orbital password',
    html: layout({
      preheader: 'This link works once and expires in one hour.',
      heading,
      body: lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
      cta: { label: 'Choose a new password', url: link },
      footer: 'Account security email. You get these whenever a password reset is requested for your address.',
    }),
    text: textLayout({
      heading, lines, cta: { label: 'Choose a new password', url: link },
      footer: 'Account security email from Orbital.',
    }),
  });
}

// ---------------------------------------------------------------------------
// Game mail
// ---------------------------------------------------------------------------

/** Humans in a game who can get mail and haven't turned game mail off. */
async function gameRecipients(env, gameId) {
  const rows = (await env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.email_games
         FROM room_members m JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ?`,
    )
    .bind(gameId).all()).results ?? [];
  return rows.filter(u => u.email && !UNDELIVERABLE.test(u.email) && u.email_games !== 0);
}

function tickWords(ms) {
  const m = Math.round((ms ?? 3600000) / 60000);
  if (m % 60 === 0) { const h = m / 60; return h === 1 ? 'an hour' : `${h} hours`; }
  return `${m} minutes`;
}

/** A game you are in has started. Never throws. */
export async function sendGameStarted(env, gameId) {
  try {
    if (!emailConfigured(env)) return;
    const g = await env.DB
      .prepare(`SELECT r.name, g.tick_interval_ms,
                       (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS players
                  FROM rooms r JOIN games g ON g.id = r.id WHERE r.id = ?`)
      .bind(gameId).first();
    if (!g) return;
    for (const u of await gameRecipients(env, gameId)) {
      const unsubUrl = await unsubscribeUrl(env, u.id, 'games');
      const heading = `${g.name} has begun`;
      const lines = [
        `Your game ${g.name} just started with ${g.players} players.`,
        `Each turn is ${tickWords(g.tick_interval_ms)} of real time, and the clock runs whether or not you are logged in. Pick your home world and send your first ships out before the neighbours do.`,
      ];
      await sendEmail(env, {
        userId: u.id, to: u.email, kind: 'game_started', category: 'games',
        dedupeKey: `game_started:${gameId}:${u.id}`,
        subject: `${g.name} has begun`,
        html: layout({
          preheader: `${g.players} empires, one Sol system. Your first turn is live.`,
          heading,
          body: lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
          cta: { label: 'Open the game', url: roomUrl(gameId) },
          footer: 'You are getting this because you joined this game on Orbital.',
          unsubUrl,
        }),
        text: textLayout({ heading, lines, cta: { label: 'Open the game', url: roomUrl(gameId) }, unsubUrl }),
      });
    }
  } catch (e) {
    console.error('sendGameStarted failed', e);
  }
}

/**
 * A host-run lobby just filled: tell the host their players are waiting.
 * Only the host can press START, and a full lobby of strangers stalls on
 * a host who wandered off. Once per room, ever. Never throws.
 *
 * A host who can't receive this (switched game mail off, or an agent
 * account) still gets a row in email_log under the room's key, so the
 * every-minute sweep below stops asking about that room.
 */
export async function sendLobbyFull(env, roomId) {
  try {
    if (!emailConfigured(env)) return;
    const r = await env.DB
      .prepare(`SELECT r.name, r.max_players, r.host_id, u.email, u.display_name, u.email_games,
                       (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS n
                  FROM rooms r JOIN users u ON u.id = r.host_id
                 WHERE r.id = ? AND r.status = 'lobby'
                   AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = r.id)`)
      .bind(roomId).first();
    if (!r || r.n < r.max_players) return;
    const dedupeKey = `lobby_full:${roomId}`;
    if (!r.email || UNDELIVERABLE.test(r.email) || r.email_games === 0) {
      try {
        await env.DB
          .prepare("INSERT INTO email_log (user_id, kind, dedupe_key, ok, error, created_ms) VALUES (?, 'lobby_full', ?, 0, 'skipped', ?)")
          .bind(r.host_id, dedupeKey, Date.now()).run();
      } catch { /* already recorded */ }
      return;
    }
    const unsubUrl = await unsubscribeUrl(env, r.host_id, 'games');
    const heading = 'Your lobby is full';
    const lines = [
      `All ${r.n} seats in ${r.name} are taken, and your players are waiting for you to start.`,
      'Only the host can start the game. Open the lobby and press START. Once it begins, the clock runs whether or not anyone is logged in.',
    ];
    const cta = { label: 'Start the game', url: roomUrl(roomId) };
    await sendEmail(env, {
      userId: r.host_id, to: r.email, kind: 'lobby_full', category: 'games', dedupeKey,
      subject: `${r.name} is full: start the game`,
      html: layout({
        preheader: `All ${r.n} seats are taken. Your players are waiting on you.`,
        heading,
        body: lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
        cta,
        footer: 'You are getting this because you host this lobby on Orbital.',
        unsubUrl,
      }),
      text: textLayout({ heading, lines, cta, unsubUrl }),
    });
  } catch (e) {
    console.error('sendLobbyFull failed', e);
  }
}

/**
 * Every-minute sweep for full lobbies that never got started: the backfill
 * for lobbies that filled before this email existed, and the net for any
 * path that adds a member without going through the join handlers (the
 * host's admin-add). The email_log key makes each room come up once.
 * A full Quick Join room should already have started itself; if one is
 * found, it is started here instead of mailing anyone.
 */
export async function sweepFullLobbies(env) {
  const rows = (await env.DB
    .prepare(`SELECT r.id, r.quick_join
                FROM rooms r
               WHERE r.status = 'lobby'
                 AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = r.id)
                 AND (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) >= r.max_players
                 AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.dedupe_key = 'lobby_full:' || r.id)
               LIMIT 20`)
    .all()).results ?? [];
  for (const r of rows) {
    if (r.quick_join === 1) {
      try {
        const { startGame } = await import('./lobby.js');
        await startGame(env, r.id);
      } catch (e) {
        console.error(`sweep: quick-join start failed for ${r.id}`, e);
      }
    } else {
      await sendLobbyFull(env, r.id);
    }
  }
}

const VICTORY_WORDS = {
  engineering: 'finished the Dyson Sphere around the Sun',
  domination: 'took control of most of the worlds',
  chancellor: 'was elected Supreme Chancellor by the Senate',
  annihilation: 'was the last empire left standing',
};

/** A game you are in has ended. Never throws. */
export async function sendGameOver(env, gameId) {
  try {
    if (!emailConfigured(env)) return;
    const g = await env.DB
      .prepare(`SELECT r.name, g.winner_faction_id, g.victory_type, g.current_tick,
                       wf.name AS winner_name, wf.user_id AS winner_user_id
                  FROM rooms r JOIN games g ON g.id = r.id
                  LEFT JOIN game_factions wf ON wf.id = g.winner_faction_id
                 WHERE r.id = ? AND g.status = 'completed'`)
      .bind(gameId).first();
    if (!g) return;
    const how = VICTORY_WORDS[g.victory_type] ?? 'won the game';
    const mine = new Map(((await env.DB
      .prepare('SELECT user_id, name FROM game_factions WHERE game_id = ? AND user_id IS NOT NULL')
      .bind(gameId).all()).results ?? []).map(f => [f.user_id, f.name]));
    for (const u of await gameRecipients(env, gameId)) {
      const won = g.winner_user_id && g.winner_user_id === u.id;
      const heading = won ? `Victory in ${g.name}` : `${g.name} is over`;
      const winner = g.winner_name ?? 'An empire';
      const lines = [
        won
          ? `You won. ${mine.get(u.id) ?? 'Your empire'} ${how} on turn ${g.current_tick}.`
          : `${winner} ${how} on turn ${g.current_tick}, and the game is over.`,
        !won && mine.has(u.id) ? `You played as ${mine.get(u.id)}. The full history of the game stays in Past Games, with its recaps and the final Herald.` : 'The full history of the game stays in Past Games, with its recaps and the final Herald.',
        'Ready for another? Quick Join seats you in the next game in one click.',
      ];
      const unsubUrl = await unsubscribeUrl(env, u.id, 'games');
      await sendEmail(env, {
        userId: u.id, to: u.email, kind: 'game_over', category: 'games',
        dedupeKey: `game_over:${gameId}:${u.id}`,
        subject: won ? `You won ${g.name}` : `${g.name}: ${winner} wins`,
        html: layout({
          preheader: won ? `${mine.get(u.id) ?? 'Your empire'} ${how}.` : `${winner} ${how}.`,
          heading,
          body: lines.map(l => `<p style="margin:0 0 14px">${esc(l)}</p>`).join(''),
          cta: { label: 'See how it ended', url: roomUrl(gameId) },
          footer: 'You are getting this because you played in this game on Orbital.',
          unsubUrl,
        }),
        text: textLayout({ heading, lines, cta: { label: 'See how it ended', url: roomUrl(gameId) }, unsubUrl }),
      });
    }
  } catch (e) {
    console.error('sendGameOver failed', e);
  }
}

// ---------------------------------------------------------------------------
// The daily Herald, by email
// ---------------------------------------------------------------------------

/** Discord-flavoured markdown from the Herald composer -> safe HTML. */
export function heraldMarkdownToHtml(md) {
  let s = esc(md ?? '');
  s = s.replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${C.ink}">$1</strong>`);
  s = s.replace(/__([^_]+)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, `<a href="$2" style="color:${C.teal}">$1</a>`);
  return s.replace(/\n/g, '<br>');
}

export function heraldMarkdownToText(md) {
  return String(md ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}

function easternDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
}

function easternHour(ms) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(ms));
  return Number(h) % 24;
}

const HERALD_EMAIL_HOUR_EASTERN = 12;

/**
 * Once a day, one email per player: that day's Herald for every active
 * game they are in that had news. Called from the every-minute cron; the
 * hour gate plus a per-day run marker make every other minute a no-op,
 * and the per-user dedupe key makes a partial re-run safe.
 */
export async function maybeSendDailyHeraldEmails(env, nowMs = Date.now()) {
  if (!emailConfigured(env) || !env.EMAIL_LINK_SECRET) return;
  if (easternHour(nowMs) !== HERALD_EMAIL_HOUR_EASTERN) return;
  const day = easternDay(nowMs);
  // One run per day across every cron minute in the hour.
  try {
    await env.DB
      .prepare('INSERT INTO email_log (user_id, kind, dedupe_key, ok, created_ms) VALUES (NULL, ?, ?, 1, ?)')
      .bind('herald_run', `herald_run:${day}`, nowMs).run();
  } catch {
    return;
  }

  const since = nowMs - 24 * 3600000;
  const games = (await env.DB
    .prepare(`SELECT g.id, g.current_tick, r.name
                FROM games g JOIN rooms r ON r.id = g.id
               WHERE g.status = 'active'
                 AND EXISTS (SELECT 1 FROM chronicle_entries c
                              WHERE c.game_id = g.id AND c.visibility = 'public'
                                AND c.created_at_ms > ?)`)
    .bind(since).all()).results ?? [];
  if (games.length === 0) return;

  const { composeHeraldForGame } = await import('./digest.js');
  const editions = new Map();
  for (const game of games) {
    try {
      editions.set(game.id, { game, ed: await composeHeraldForGame(env, game) });
    } catch (e) {
      console.error(`herald email compose failed for ${game.id}`, e);
    }
  }

  // Everyone who plays in one of those games, once each.
  const readers = new Map();
  for (const gameId of editions.keys()) {
    const rows = (await env.DB
      .prepare(`SELECT u.id, u.email, u.display_name, u.email_herald
                  FROM game_factions gf JOIN users u ON u.id = gf.user_id
                 WHERE gf.game_id = ?`)
      .bind(gameId).all()).results ?? [];
    for (const u of rows) {
      if (!u.email || UNDELIVERABLE.test(u.email) || u.email_herald === 0) continue;
      const r = readers.get(u.id) ?? { user: u, games: [] };
      if (!r.games.includes(gameId)) r.games.push(gameId);
      readers.set(u.id, r);
    }
  }

  for (const { user, games: ids } of readers.values()) {
    const eds = ids.map(id => editions.get(id)).filter(Boolean);
    if (eds.length === 0) continue;
    const lead = eds[0].ed;
    const unsubUrl = await unsubscribeUrl(env, user.id, 'herald');
    const sectionsHtml = eds.map(({ game, ed }) => `
      <div style="margin:0 0 26px;padding:0 0 22px;border-bottom:1px solid ${C.border}">
        <div style="color:${C.gold};font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 8px">${esc(game.name)} · Turn ${ed.tick}</div>
        <div style="color:${C.ink};font-size:18px;font-weight:700;line-height:1.3;margin:0 0 10px">${heraldMarkdownToHtml(ed.title)}</div>
        <div style="color:${C.ink};font-size:14px;line-height:1.6">${heraldMarkdownToHtml(ed.description)}</div>
        ${ed.fields.map(f => `<div style="margin:14px 0 0"><div style="color:${C.teal};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px">${heraldMarkdownToHtml(f.name)}</div><div style="color:${C.dim};font-size:14px;line-height:1.6">${heraldMarkdownToHtml(f.value)}</div></div>`).join('')}
        <div style="margin:14px 0 0"><a href="${esc(roomUrl(game.id))}" style="color:${C.teal};font-size:13px">Open ${esc(game.name)} →</a></div>
      </div>`).join('');
    const textLines = eds.flatMap(({ game, ed }) => [
      `${game.name.toUpperCase()} · TURN ${ed.tick}`,
      heraldMarkdownToText(ed.title), '',
      heraldMarkdownToText(ed.description),
      ...ed.fields.flatMap(f => ['', heraldMarkdownToText(f.name), heraldMarkdownToText(f.value)]),
      '', `Open the game: ${roomUrl(game.id)}`, '', '----', '',
    ]);
    const subjectLead = heraldMarkdownToText(lead.title).replace(/\s+/g, ' ').trim().slice(0, 90);
    await sendEmail(env, {
      userId: user.id, to: user.email, kind: 'herald', category: 'herald',
      dedupeKey: `herald:${user.id}:${day}`,
      subject: `The Orbital Herald: ${subjectLead}`,
      html: layout({
        preheader: eds.length > 1 ? `Today's news from your ${eds.length} games.` : `Today's news from ${eds[0].game.name}.`,
        heading: 'The Orbital Herald',
        body: sectionsHtml,
        footer: 'The daily Herald for the games you are playing on Orbital. One email a day, only when something happened.',
        unsubUrl,
      }),
      text: textLayout({ heading: 'The Orbital Herald', lines: textLines, unsubUrl }),
    });
  }
}
