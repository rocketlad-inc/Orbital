// ============================================================================
// winback.js — one email to a player who signed up and never sat down.
//
// WHO: an account at least 48 hours old that has never joined a lobby or a
// game (no room_members row, no game_factions row), can take mail, and has
// not turned game mail off. Once per account, ever (email_log dedupe key
// `winback:<user>`), so a backfill of every old account and the steady
// trickle of new ones are the same query.
//
// WHERE TO: an existing game whenever there is one. Each email names ONE
// joinable lobby (worker/matchmaking.js: public, a free seat, and able to
// start), and its button (/?play=winback&seat=<lobby>) seats the reader
// there through Quick Join if it still has room when they click. If it
// filled or started meanwhile, Quick Join's usual order takes over: the
// next joinable lobby, closest to starting first, and only then a fresh
// self-starting room.
//
// HOW MANY, and when there is nowhere to go (planWinback):
//   seat  joinable lobbies exist. Each one gets two invitations per open
//         seat (not everyone clicks), fullest lobby first, newest signups
//         first, capped per hour. Invitations still out from the last day
//         count against a lobby, so the next hour only tops up the
//         difference. Twelve emails never all chase the same last seat.
//
// The button signs its reader in (worker/emailLogin.js): most of these
// people have not been back since they signed up, and a forgotten
// password should not stand between them and the seat.
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

import { tr, trn, normalizeLocale } from './i18n.js';
import { emailConfigured, sendEmail, layout, textLayout, esc, unsubscribeUrl, OPEN_PIXEL } from './email.js';
import { joinableLobbies } from './matchmaking.js';

export const WINBACK_AFTER_MS = 48 * 3600 * 1000;
export const WINBACK_HOURLY_CAP = 20;
export const WINBACK_PER_SEAT = 2;
export const POOL_MIN = 4;
export const POOL_SIZE = 8;
/** The self-starting room a pool click opens (worker/index.js QUICK_JOIN_SEATS). */
const POOL_ROOM_SEATS = 5;

/** The button. App.tsx reads ?play=winback once the reader is signed in. */
export const WINBACK_URL = 'https://orbital-empire.com/?play=winback&from=winback';
/** A test email's button: the lobby, without taking anyone's seat. */
export const WINBACK_TEST_URL = 'https://orbital-empire.com/?from=winback-test';

/** The button for one email: the lobby it names goes first at click time. */
export function winbackUrl(roomId, { test = false } = {}) {
  if (test) return WINBACK_TEST_URL;
  return roomId ? `${WINBACK_URL}&seat=${encodeURIComponent(roomId)}` : WINBACK_URL;
}
/** The header picture: a crop of the Battle of Mars press still (a JPEG,
 *  because Outlook will not show WebP). */
export const WINBACK_HERO_SRC = 'https://orbital-empire.com/press/email/winback-hero.jpg';

// ---------------------------------------------------------------------------
// The editable copy (admin panel, worker/emailAdmin.js). Every line of the
// message itself can be rewritten per language; the room card's labels
// cannot, because they mirror the game browser's. An override that is
// missing or blank falls back to the catalog (worker/i18n/*.js), so
// "reset to default" is deleting the override, and a new language gets
// the catalog's words until someone edits them.
// ---------------------------------------------------------------------------

export const TEMPLATE_ID = 'winback';
export const EDITABLE_LOCALES = ['en', 'pt-BR'];
export const EDITABLE_FIELDS = [
  { key: 'email.winback.seat.subject', label: 'Subject (a game is filling up)', vars: [] },
  { key: 'email.winback.seat.preheader', label: 'Preview text (a game is filling up)', vars: ['name', 'n', 'max'] },
  { key: 'email.winback.seat.heading', label: 'Heading (a game is filling up)', vars: [] },
  { key: 'email.winback.seat.l1', label: 'Intro, above the card (a game is filling up)', vars: [] },
  { key: 'email.winback.seat.autostart', label: 'Under the card: a Quick Join lobby', vars: [] },
  { key: 'email.winback.seat.host', label: 'Under the card: a lobby its host starts', vars: [] },
  { key: 'email.winback.pool.subject', label: 'Subject (a new game is forming)', vars: [] },
  { key: 'email.winback.pool.preheader', label: 'Preview text (a new game is forming)', vars: [] },
  { key: 'email.winback.pool.heading', label: 'Heading (a new game is forming)', vars: [] },
  { key: 'email.winback.pool.l1', label: 'Intro, above the card (a new game is forming)', vars: [] },
  { key: 'email.winback.pool.autostart', label: 'Under the card (a new game is forming)', vars: ['n'] },
  { key: 'email.winback.l2', label: 'Closing line (both versions)', vars: [] },
  { key: 'email.winback.cta', label: 'Button', vars: [] },
  { key: 'email.winback.footer', label: 'Footer: why you got this', vars: [] },
  { key: 'email.winback.heroAlt', label: 'Header picture description (shown when pictures are off)', vars: [] },
];
const EDITABLE_KEYS = new Set(EDITABLE_FIELDS.map(f => f.key));
export const MAX_FIELD_CHARS = 600;

function fillVars(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/** tr(), but an admin override wins when it says something. */
function makeT(L, overrides) {
  const mine = overrides?.[L] ?? {};
  return (key, vars) => {
    const o = mine[key];
    return typeof o === 'string' && o.trim() ? fillVars(o, vars) : tr(L, key, vars);
  };
}

/**
 * Keep only what the editor may set: known keys, known languages, short
 * strings, and an https picture. Returns { overrides } or { error }.
 */
export function cleanOverrides(input) {
  if (!input || typeof input !== 'object') return { overrides: {} };
  const out = {};
  for (const L of EDITABLE_LOCALES) {
    const src = input[L];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!EDITABLE_KEYS.has(k) || typeof v !== 'string') continue;
      const s = v.trim();
      if (!s) continue;
      if (s.length > MAX_FIELD_CHARS) return { error: `${k} is longer than ${MAX_FIELD_CHARS} characters` };
      (out[L] ??= {})[k] = s;
    }
  }
  if (typeof input.hero_src === 'string' && input.hero_src.trim()) {
    const u = input.hero_src.trim();
    if (!/^https:\/\/[^\s"'<>]+$/.test(u) || u.length > 500) return { error: 'The header picture must be an https:// address' };
    out.hero_src = u;
  }
  return { overrides: out };
}

/** The saved template: { enabled, overrides, updated_ms }. Off if never saved. */
export async function loadWinbackTemplate(env) {
  let row = null;
  try {
    row = await env.DB
      .prepare('SELECT enabled, overrides, updated_ms, updated_by FROM email_templates WHERE id = ?')
      .bind(TEMPLATE_ID).first();
  } catch { /* table missing until 0164 runs: off */ }
  let overrides = {};
  try { overrides = JSON.parse(row?.overrides || '{}') || {}; } catch { overrides = {}; }
  return { enabled: row?.enabled === 1, overrides, updated_ms: row?.updated_ms ?? null, updated_by: row?.updated_by ?? null };
}

/**
 * Decide this hour's sends. Pure, so the rules are testable without a DB.
 *
 * Each open seat is worth WINBACK_PER_SEAT invitations IN TOTAL, not per
 * hour: invitations already out for a lobby (sent within the last
 * INVITE_WINDOW_MS to someone who has not sat down anywhere since) count
 * against it, and only the difference is sent. A lobby whose seats are
 * all spoken for is left alone until those invitations lapse or fill.
 *
 * @param eligible  waiting accounts, newest signup first
 * @param lobbies   joinable lobbies, best first (fewest seats left)
 * @param pending   { [lobbyId]: invitations still out }
 * @returns {{ mode: 'seat'|'pool'|'hold', reason?: string, sends: {user, room}[],
 *             recipients: object[], rooms: {room, count, pending}[] }}
 *   room is null for a pool send; reason says why a hold is a hold
 */
export function planWinback({ eligible, lobbies, pending = {} }) {
  const hold = (reason, rooms = []) => ({ mode: 'hold', reason, sends: [], recipients: [], rooms });
  if (!eligible.length) return hold('nobody_waiting');
  const open = lobbies.filter(l => l.n < l.max_players);
  if (open.length) {
    const sends = [];
    const rooms = [];
    let next = 0;
    for (const room of open) {
      const out = Math.max(0, Number(pending[room.id]) || 0);
      const want = Math.max(0, (room.max_players - room.n) * WINBACK_PER_SEAT - out);
      let count = 0;
      while (count < want && next < eligible.length && sends.length < WINBACK_HOURLY_CAP) {
        sends.push({ user: eligible[next++], room });
        count++;
      }
      if (count || out) rooms.push({ room, count, pending: out });
    }
    if (!sends.length) return hold('invited', rooms);
    return { mode: 'seat', sends, recipients: sends.map(s => s.user), rooms };
  }
  if (eligible.length >= POOL_MIN) {
    const sends = eligible.slice(0, POOL_SIZE).map(user => ({ user, room: null }));
    return { mode: 'pool', sends, recipients: sends.map(s => s.user), rooms: [] };
  }
  return hold('too_few');
}

/** How long an unanswered invitation still holds its seat. */
export const INVITE_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Invitations still out, per lobby: win-back emails from the last day that
 * named a lobby, to people who have not sat down anywhere since.
 */
export async function pendingInvitations(env, nowMs = Date.now()) {
  try {
    const rows = (await env.DB
      .prepare(
        `SELECT e.room_id, COUNT(*) AS n
           FROM email_log e
          WHERE e.kind = 'winback_seat' AND e.ok = 1 AND e.room_id IS NOT NULL AND e.created_ms > ?
            AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.user_id = e.user_id AND m.joined_at >= e.created_ms)
          GROUP BY e.room_id`,
      )
      .bind(nowMs - INVITE_WINDOW_MS).all()).results ?? [];
    return Object.fromEntries(rows.map(r => [r.room_id, Number(r.n) || 0]));
  } catch {
    return {}; // before 0165 there is no room_id: count nothing, as before
  }
}

export async function eligibleAccounts(env, nowMs) {
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

/** The lobbies Quick Join would seat someone in, best first. */
export async function openLobbies(env, nowMs) {
  return joinableLobbies(env, nowMs);
}

// ---------------------------------------------------------------------------
// The room card: the game browser's open-lobby card (src/multiplayer/
// LobbyCards.tsx GameCard + lobby.css .lx-card), rebuilt for mail. Mail
// clients have no flex or grid and are unreliable with rgba, so it is
// tables, and every tint is pre-blended onto the card's own surface.
// ---------------------------------------------------------------------------

const K = {
  surface: '#121b27',   // --lx-surface-2
  line: '#222d3c',      // --lx-line over the surface
  ink: '#e8f0f7', ink2: '#aebdcc', ink3: '#7a8ca0',
  teal: '#4ecdc4', chip: '#193039',             // .lx-chip--open
  gold: '#ffb84d', goldInk: '#1d1404',
  gold2: '#ffcb7a', tagBg: '#25282a', tagLine: '#594a32',  // .lx-tag--quick
  emptySeat: '#3a4757', // --lx-line-2, dashed
};
const CARD_FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const DEFAULT_TICK_MS = 3600000;

/** LobbyCards.tsx initials(): letters and digits only, first + last. */
export function initials(name) {
  const parts = String(name ?? '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] ?? '');
  return (a + b).toUpperCase();
}

/** LobbyCards.tsx hueOf() + .lx-avatar__initials hsl(h 45% 38%), as hex:
 *  the same name gets the same colour in the inbox as in the browser. */
export function avatarHex(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  h %= 360;
  const s = 0.45, l = 0.38;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** LobbyCards.tsx turnSpeed(): "1-hour turns", "30-minute turns". */
function turnSpeed(L, ms) {
  const s = (ms > 0 ? ms : DEFAULT_TICK_MS) / 1000;
  const tenth = x => Math.round(x * 10) / 10;
  if (s < 60) return trn(L, 'email.winback.card.turnsSec', Math.round(s));
  const m = s / 60;
  if (m < 60) return trn(L, 'email.winback.card.turnsMin', tenth(m));
  return trn(L, 'email.winback.card.turnsHour', tenth(m / 60));
}

function avatarCell(p) {
  const ring = p.is_host ? `border:2px solid ${K.gold};width:28px;height:28px;` : 'width:32px;height:32px;';
  return `<td style="padding:0 6px 0 0"><div title="${esc(p.name)}" style="${ring}border-radius:50%;background:${avatarHex(p.name)};color:#ffffff;font:700 12px/${p.is_host ? 28 : 32}px ${CARD_FONT};text-align:center">${esc(initials(p.name))}</div></td>`;
}

function emptyCell() {
  return `<td style="padding:0 6px 0 0"><div style="width:29px;height:29px;border-radius:50%;border:1.5px dashed ${K.emptySeat}"></div></td>`;
}

/**
 * @param card { name, n, max, quick, host, members:[{name,is_host}], tickMs, forming }
 *   forming = the pool case: a game that opens when the first reader clicks.
 */
export function roomCardHtml(L, card, ctaLabel = tr(L, 'email.winback.cta'), href = WINBACK_URL) {
  const open = Math.max(0, card.max - card.n);
  const members = (card.members ?? []).slice(0, 10);
  const empties = Math.min(open, 10 - members.length);
  const avatars = members.map(avatarCell).join('') + Array.from({ length: empties }, emptyCell).join('');
  const sub = card.forming
    ? tr(L, 'email.winback.card.forming')
    : tr(L, 'email.winback.card.hosted', { host: card.host });
  const quick = card.quick
    ? `<span style="display:inline-block;padding:3px 8px;border-radius:6px;background:${K.tagBg};border:1px solid ${K.tagLine};color:${K.gold2};font:600 12px ${CARD_FONT}">${esc(tr(L, 'email.winback.card.quick'))}</span>`
    : '';
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;background:${K.surface};border:1px solid ${K.line};border-radius:14px">
  <tr><td style="padding:18px 18px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td align="left"><span style="display:inline-block;padding:5px 10px;border-radius:999px;background:${K.chip};color:${K.teal};font:600 13px ${CARD_FONT}">&#9679;&nbsp;${esc(trn(L, 'email.winback.card.status', open))}</span></td>
      <td align="right">${quick}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:12px 18px 0;font:700 20px/1.2 ${CARD_FONT};color:${K.ink}">${esc(card.name)}</td></tr>
  <tr><td style="padding:4px 18px 0;font:13px ${CARD_FONT};color:${K.ink3}">${esc(sub)}</td></tr>
  <tr><td style="padding:14px 18px 0">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${avatars}</tr></table>
  </td></tr>
  <tr><td style="padding:8px 18px 0;font:13px ${CARD_FONT};color:${K.ink3}">${esc(tr(L, 'email.winback.card.players', { n: card.n, max: card.max }))} · <b style="color:${K.teal};font-weight:600">${esc(tr(L, 'email.winback.card.open', { n: open }))}</b></td></tr>
  <tr><td style="padding:12px 18px 0;font:13px ${CARD_FONT};color:${K.ink2}"><span style="color:${K.ink3};font-size:11px;letter-spacing:.12em;text-transform:uppercase">${esc(tr(L, 'email.winback.card.speed'))}</span>&nbsp;&nbsp;${esc(turnSpeed(L, card.tickMs))}</td></tr>
  <tr><td style="padding:16px 18px 18px">
    <a href="${esc(href)}" style="display:block;background:${K.gold};color:${K.goldInk};font:700 15px/42px ${CARD_FONT};text-align:center;text-decoration:none;border-radius:10px">${esc(ctaLabel)}</a>
  </td></tr>
</table>`;
}

/** The card as plain text, for the text part. */
function roomCardText(L, card) {
  const open = Math.max(0, card.max - card.n);
  const sub = card.forming ? tr(L, 'email.winback.card.forming') : tr(L, 'email.winback.card.hosted', { host: card.host });
  return [
    `[ ${card.name} ]  ${trn(L, 'email.winback.card.status', open)}`,
    sub,
    `${tr(L, 'email.winback.card.players', { n: card.n, max: card.max })} · ${tr(L, 'email.winback.card.open', { n: open })} · ${turnSpeed(L, card.tickMs)}`,
  ];
}

/**
 * Everything one reader sees. Exported for the preview and the tests.
 * @param room  for 'seat': { name, n, max_players, quick_join, host_name, members, tick_ms }
 */
export function composeWinback(locale, mode, room, overrides = {}, { test = false, href = null } = {}) {
  const L = normalizeLocale(locale) ?? 'en';
  const T = makeT(L, overrides);
  const seat = mode === 'seat' && !!room;
  const card = seat
    ? { name: room.name, n: room.n, max: room.max_players, quick: room.quick_join === 1,
        host: room.host_name ?? tr(L, 'email.defaultName'), members: room.members ?? [], tickMs: room.tick_ms }
    : { name: tr(L, 'email.winback.card.newName'), n: 0, max: POOL_ROOM_SEATS, quick: true,
        members: [], tickMs: DEFAULT_TICK_MS, forming: true };
  const intro = T(seat ? 'email.winback.seat.l1' : 'email.winback.pool.l1');
  const after = [
    seat
      ? T(room.quick_join === 1 ? 'email.winback.seat.autostart' : 'email.winback.seat.host')
      : T('email.winback.pool.autostart', { n: POOL_ROOM_SEATS }),
    T('email.winback.l2'),
  ];
  // A real send passes `href`: the reader's own sign-in link
  // (worker/emailLogin.js), which lands on the same seat link.
  const url = href || winbackUrl(seat ? room.id : null, { test });
  const cta = { label: T('email.winback.cta'), url };
  return {
    L,
    subject: T(seat ? 'email.winback.seat.subject' : 'email.winback.pool.subject'),
    preheader: seat
      ? T('email.winback.seat.preheader', { name: room.name, n: room.n, max: room.max_players })
      : T('email.winback.pool.preheader'),
    heading: T(seat ? 'email.winback.seat.heading' : 'email.winback.pool.heading'),
    intro,
    after,
    card,
    cardHtml: roomCardHtml(L, card, cta.label, url),
    lines: [intro, '', ...roomCardText(L, card), '', ...after],
    cta,
    hero: { src: overrides?.hero_src || WINBACK_HERO_SRC, alt: T('email.winback.heroAlt'), href: url },
    footer: T('email.winback.footer'),
  };
}

/** The whole email body: intro, the card (it carries the button), the rest. */
export function winbackBodyHtml(c, { trackOpens = false } = {}) {
  const p = s => `<p style="margin:0 0 14px">${esc(s)}</p>`;
  return p(c.intro) + c.cardHtml + c.after.map(p).join('') + (trackOpens ? OPEN_PIXEL : '');
}

/** The full message, as sendEmail wants it. Shared by the cron and the
 *  admin panel's preview and test send, so all three are the same mail. */
export function renderWinback(c, { unsubUrl = null, trackOpens = false } = {}) {
  return {
    subject: c.subject,
    html: layout({
      locale: c.L,
      preheader: c.preheader,
      heading: c.heading,
      hero: c.hero,
      body: winbackBodyHtml(c, { trackOpens }),
      footer: esc(c.footer),
      unsubUrl,
    }),
    text: textLayout({ locale: c.L, heading: c.heading, lines: c.lines, cta: c.cta, footer: c.footer, unsubUrl }),
  };
}

async function sendWinback(env, user, mode, room, overrides, nowMs) {
  const roomId = mode === 'seat' && room ? room.id : null;
  // The button signs its reader in (a week, once); null falls back to the
  // plain seat link, which works after an ordinary sign-in.
  const { issueLoginLink } = await import('./emailLogin.js');
  const href = await issueLoginLink(env, { userId: user.id, roomId, nowMs });
  const c = composeWinback(user.locale, mode, room, overrides, { href });
  const unsubUrl = await unsubscribeUrl(env, user.id, 'games');
  return sendEmail(env, {
    userId: user.id, to: user.email, kind: `winback_${mode}`, category: 'games',
    dedupeKey: `winback:${user.id}`, roomId,
    ...renderWinback(c, { unsubUrl, trackOpens: true }),
  });
}

/** Who is already in the lobby, its host, and its turn speed, for the card. */
export async function cardDetails(env, room) {
  const members = (await env.DB
    .prepare(
      `SELECT u.display_name AS name, (m.user_id = r.host_id) AS is_host
         FROM room_members m JOIN users u ON u.id = m.user_id JOIN rooms r ON r.id = m.room_id
        WHERE m.room_id = ? ORDER BY m.joined_at`,
    )
    .bind(room.id).all()).results ?? [];
  // A lobby's speed lives in its Room DO until the game starts (the
  // game browser asks the same way, worker/lobby.js).
  let tickMs = DEFAULT_TICK_MS;
  try {
    const res = await env.ROOM.get(env.ROOM.idFromName(room.id)).fetch('https://room/settings');
    if (res.ok) tickMs = (await res.json()).tick_interval_ms || DEFAULT_TICK_MS;
  } catch { /* the default is what an untouched lobby runs at */ }
  return {
    ...room,
    members: members.map(m => ({ name: m.name || 'Player', is_host: !!m.is_host })),
    host_name: members.find(m => m.is_host)?.name ?? null,
    tick_ms: tickMs,
  };
}

/**
 * Called from the every-minute cron. One pass per hour (a run marker in
 * email_log, like the Herald's), never throws.
 */
export async function maybeSendWinbackEmails(env, nowMs = Date.now()) {
  if (!emailConfigured(env) || !env.EMAIL_LINK_SECRET) return;
  // Off until switched on in the admin panel, and checked before the run
  // marker so a switched-off email leaves no trace in the log.
  const tpl = await loadWinbackTemplate(env);
  if (!tpl.enabled) return;
  const hour = Math.floor(nowMs / 3600000);
  try {
    await env.DB
      .prepare('INSERT INTO email_log (user_id, kind, dedupe_key, ok, created_ms) VALUES (NULL, ?, ?, 1, ?)')
      .bind('winback_run', `winback_run:${hour}`, nowMs).run();
  } catch {
    return; // this hour already ran
  }
  const { pruneLoginTokens } = await import('./emailLogin.js');
  await pruneLoginTokens(env, nowMs);
  const eligible = await eligibleAccounts(env, nowMs);
  if (!eligible.length) return;
  const plan = planWinback({
    eligible,
    lobbies: await openLobbies(env, nowMs),
    pending: await pendingInvitations(env, nowMs),
  });
  if (!plan.sends.length) return;
  // Each named lobby's card (who sits there, its speed), looked up once.
  const detailed = new Map();
  for (const { room } of plan.rooms) {
    try { detailed.set(room.id, await cardDetails(env, room)); }
    catch (e) { console.error('winback card details failed', e); detailed.set(room.id, room); }
  }
  for (const { user, room } of plan.sends) {
    try {
      await sendWinback(env, user, plan.mode, room ? detailed.get(room.id) ?? room : null, tpl.overrides, nowMs);
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
