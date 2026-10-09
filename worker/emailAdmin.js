// ============================================================================
// emailAdmin.js — the admin panel's Email tab, and the open pixel.
//
//   GET  /api/admin/email/winback          template + defaults + metrics + queue
//   PUT  /api/admin/email/winback          { enabled?, overrides? }
//   POST /api/admin/email/winback/preview  { locale, mode, overrides } -> html
//   POST /api/admin/email/winback/test     { locale, mode, overrides } -> mail to you
//   GET  /api/email/o/<token>.gif          the open pixel (public, signed)
//
// The preview and the test send render through the same renderWinback()
// the cron sends with (worker/winback.js), so what the panel shows is the
// mail people get. Edits are per language and fall back to the catalog
// when blank; the switch is off until someone turns it on.
// ============================================================================

import { isAdminEmail } from './analytics.js';
import { catalogs } from './i18n.js';
import { emailConfigured, sendEmail, readOpenToken } from './email.js';
import {
  TEMPLATE_ID, EDITABLE_FIELDS, EDITABLE_LOCALES, MAX_FIELD_CHARS, WINBACK_HERO_SRC,
  WINBACK_AFTER_MS, WINBACK_HOURLY_CAP,
  cleanOverrides, loadWinbackTemplate, composeWinback, renderWinback,
  planWinback, eligibleAccounts, openLobbies, cardDetails,
} from './winback.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const err = (status, code, message) => json({ error: { code, message } }, status);
const admin = ctx => ctx.session && isAdminEmail(ctx.session.email);

const SEND_KINDS = ['winback_seat', 'winback_pool'];
const PLAYING_RECENT_MS = 3 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** A lobby to show in the preview when none is open right now. */
const SAMPLE_ROOM = {
  id: 'sample', name: 'Open game · Titan', n: 3, max_players: 5, quick_join: 1,
  host_name: 'Rocketlad', tick_ms: 3600000,
  members: [
    { name: 'Rocketlad', is_host: true },
    { name: 'milky', is_host: false },
    { name: 'Iron Anna', is_host: false },
  ],
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Every win-back send with what became of it. One row per recipient (the
 * email goes once per account), so a few thousand at most.
 *   opened   the pixel was fetched at least once
 *   clicked  Quick Join was called from the email's button
 *   joined   sat down in any lobby or game after the send
 *   playing  holds an empire in a running game and visited in the last 3 days
 */
export async function winbackMetrics(env, nowMs = Date.now()) {
  const rows = (await env.DB
    .prepare(
      `SELECT e.id, e.user_id, e.kind, e.ok, e.error, e.created_ms, e.opened_ms, e.open_count,
              u.display_name, u.email, u.email_games, u.last_visit_ms,
              (SELECT c.created_ms FROM email_log c WHERE c.dedupe_key = 'winback_click:' || e.user_id) AS clicked_ms,
              (SELECT MIN(m.joined_at) FROM room_members m
                WHERE m.user_id = e.user_id AND m.joined_at >= e.created_ms) AS joined_ms,
              EXISTS (SELECT 1 FROM game_factions gf JOIN games g ON g.id = gf.game_id
                       WHERE gf.user_id = e.user_id AND g.status = 'active'
                         AND COALESCE(gf.status, '') NOT IN ('eliminated', 'vacated')) AS in_game
         FROM email_log e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.kind IN ('winback_seat', 'winback_pool')
        ORDER BY e.created_ms DESC
        LIMIT 5000`,
    )
    .all()).results ?? [];

  const blank = () => ({ sent: 0, failed: 0, opened: 0, clicked: 0, joined: 0, playing: 0, unsubscribed: 0 });
  const totals = blank();
  const byMode = { seat: blank(), pool: blank() };
  const days = new Map();
  const today = Math.floor(nowMs / DAY_MS);
  for (let d = today - 13; d <= today; d++) days.set(d, { day: new Date(d * DAY_MS).toISOString().slice(0, 10), sent: 0, opened: 0, clicked: 0 });

  const recent = [];
  for (const r of rows) {
    const mode = r.kind === 'winback_pool' ? 'pool' : 'seat';
    const playing = !!r.in_game && (r.last_visit_ms ?? 0) > nowMs - PLAYING_RECENT_MS;
    const f = {
      sent: r.ok === 1, failed: r.ok !== 1, opened: r.ok === 1 && r.opened_ms != null,
      clicked: r.clicked_ms != null, joined: r.joined_ms != null, playing,
      unsubscribed: r.email_games === 0,
    };
    for (const bucket of [totals, byMode[mode]]) {
      for (const k of Object.keys(bucket)) if (f[k]) bucket[k]++;
    }
    const d = days.get(Math.floor(r.created_ms / DAY_MS));
    if (d && f.sent) { d.sent++; if (f.opened) d.opened++; if (f.clicked) d.clicked++; }
    if (recent.length < 40) {
      recent.push({
        name: r.display_name ?? '(deleted account)', email: r.email ?? null, mode,
        sent_ms: r.created_ms, ok: r.ok === 1, error: r.ok === 1 ? null : (r.error ?? 'failed'),
        opened_ms: r.opened_ms ?? null, open_count: r.open_count ?? 0,
        clicked_ms: r.clicked_ms ?? null, joined_ms: r.joined_ms ?? null, playing,
        unsubscribed: f.unsubscribed,
      });
    }
  }
  return { totals, byMode, daily: [...days.values()], recent };
}

/** Who is waiting, and what the next hourly run would do with them. */
async function winbackQueue(env, tpl, nowMs = Date.now()) {
  const c = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
        WHERE u.created_at <= ?
          AND u.email IS NOT NULL
          AND u.email NOT LIKE '%@agents.orbital.local'
          AND COALESCE(u.email_games, 1) <> 0
          AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM game_factions gf WHERE gf.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.dedupe_key = 'winback:' || u.id)`,
    )
    .bind(nowMs - WINBACK_AFTER_MS).first();
  const waiting = Number(c?.n) || 0;
  const plan = planWinback({ eligible: await eligibleAccounts(env, nowMs), lobbies: await openLobbies(env, nowMs) });
  const nextRunMs = (Math.floor(nowMs / 3600000) + 1) * 3600000;
  return {
    waiting,
    enabled: tpl.enabled,
    next_run_ms: tpl.enabled ? nextRunMs : null,
    next: {
      mode: plan.mode,
      count: plan.recipients.length,
      room: plan.room ? { name: plan.room.name, n: plan.room.n, max_players: plan.room.max_players } : null,
    },
    hourly_cap: WINBACK_HOURLY_CAP,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function fieldDefaults() {
  const cats = catalogs();
  return EDITABLE_FIELDS.map(f => ({
    ...f,
    defaults: Object.fromEntries(EDITABLE_LOCALES.map(L => [L, cats[L]?.[f.key] ?? cats.en?.[f.key] ?? ''])),
  }));
}

async function handleGet(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const now = Date.now();
  const tpl = await loadWinbackTemplate(env);
  const [metrics, queue] = await Promise.all([winbackMetrics(env, now), winbackQueue(env, tpl, now)]);
  return json({
    id: TEMPLATE_ID,
    enabled: tpl.enabled,
    overrides: tpl.overrides,
    updated_ms: tpl.updated_ms,
    updated_by: tpl.updated_by,
    fields: fieldDefaults(),
    locales: EDITABLE_LOCALES,
    max_chars: MAX_FIELD_CHARS,
    hero_default: WINBACK_HERO_SRC,
    email_configured: emailConfigured(env),
    metrics,
    queue,
  });
}

async function handlePut(req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'expected JSON'); }
  const cur = await loadWinbackTemplate(env);
  let overrides = cur.overrides;
  if (body?.overrides !== undefined) {
    const cleaned = cleanOverrides(body.overrides);
    if (cleaned.error) return err(400, 'bad_request', cleaned.error);
    overrides = cleaned.overrides;
  }
  const enabled = typeof body?.enabled === 'boolean' ? body.enabled : cur.enabled;
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO email_templates (id, enabled, overrides, updated_ms, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, overrides = excluded.overrides,
                                     updated_ms = excluded.updated_ms, updated_by = excluded.updated_by`,
    )
    .bind(TEMPLATE_ID, enabled ? 1 : 0, JSON.stringify(overrides), now, ctx.session.email ?? null)
    .run();
  return json({ ok: true, enabled, overrides, updated_ms: now });
}

/** The room the preview shows: the lobby the next run would name, else a sample. */
async function previewRoom(env) {
  try {
    const lobbies = await openLobbies(env, Date.now());
    const open = lobbies.find(l => l.n < l.max_players);
    if (open) return { room: await cardDetails(env, open), source: 'live' };
  } catch { /* fall through to the sample */ }
  return { room: SAMPLE_ROOM, source: 'sample' };
}

async function readDraft(req) {
  let body;
  try { body = await req.json(); } catch { return { error: 'expected JSON' }; }
  const locale = EDITABLE_LOCALES.includes(body?.locale) ? body.locale : 'en';
  const mode = body?.mode === 'pool' ? 'pool' : 'seat';
  const cleaned = cleanOverrides(body?.overrides ?? {});
  if (cleaned.error) return { error: cleaned.error };
  return { locale, mode, overrides: cleaned.overrides };
}

async function handlePreview(req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const d = await readDraft(req);
  if (d.error) return err(400, 'bad_request', d.error);
  const { room, source } = d.mode === 'seat' ? await previewRoom(env) : { room: null, source: null };
  const c = composeWinback(d.locale, d.mode, room, d.overrides);
  const m = renderWinback(c);
  return json({ subject: m.subject, preheader: c.preheader, html: m.html, text: m.text, room_source: source });
}

async function handleTest(req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  if (!emailConfigured(env)) return err(503, 'not_configured', 'Email is not set up on this server');
  const d = await readDraft(req);
  if (d.error) return err(400, 'bad_request', d.error);
  const { room } = d.mode === 'seat' ? await previewRoom(env) : { room: null };
  const c = composeWinback(d.locale, d.mode, room, d.overrides);
  const m = renderWinback(c);
  // One test per 20 seconds per admin: a double-click is not two emails.
  const slot = Math.floor(Date.now() / 20000);
  const res = await sendEmail(env, {
    userId: ctx.session.user_id, to: ctx.session.email, kind: 'winback_test',
    dedupeKey: `winback_test:${ctx.session.user_id}:${slot}`,
    subject: `[Test] ${m.subject}`, html: m.html, text: m.text,
  });
  if (!res.sent) {
    return err(res.reason === 'already_sent' ? 429 : 502, res.reason ?? 'send_failed',
      res.reason === 'already_sent' ? 'A test just went out. Try again in a few seconds.' : 'The test email did not send.');
  }
  return json({ ok: true, to: ctx.session.email });
}

// The smallest transparent GIF.
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), ch => ch.charCodeAt(0));

async function handleOpen(_req, env, ctx) {
  try {
    const id = await readOpenToken(env, ctx.params?.t);
    if (id != null) {
      await env.DB
        .prepare('UPDATE email_log SET opened_ms = COALESCE(opened_ms, ?), open_count = open_count + 1 WHERE id = ?')
        .bind(Date.now(), id).run();
    }
  } catch (e) {
    console.error('open pixel failed', e);
  }
  // Always the picture, recorded or not: a broken image in someone's
  // inbox is worse than a missed count.
  return new Response(PIXEL, {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private, max-age=0' },
  });
}

export const routes = [
  { method: 'GET',  pattern: '/api/admin/email/winback', auth: 'required', handle: handleGet },
  { method: 'PUT',  pattern: '/api/admin/email/winback', auth: 'required', handle: handlePut },
  { method: 'POST', pattern: '/api/admin/email/winback/preview', auth: 'required', handle: handlePreview },
  { method: 'POST', pattern: '/api/admin/email/winback/test', auth: 'required', handle: handleTest },
  { method: 'GET',  pattern: /^\/api\/email\/o\/(?<t>[0-9]{1,15}\.[A-Za-z0-9_-]{22})\.gif$/, auth: 'none', handle: handleOpen },
];
