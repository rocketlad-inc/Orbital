// ============================================================
// Devlog — the changelog page, editable at runtime.
//
//   GET    /api/devlog                 public; published posts, newest first
//   GET    /api/admin/devlog           admin; every post, drafts included
//   POST   /api/admin/devlog           admin; create
//   PATCH  /api/admin/devlog/:id       admin; edit any field
//   DELETE /api/admin/devlog/:id       admin; delete for real
//
// Publishing an update used to mean editing a .tsx constant, rebuilding
// the client and redeploying — so a typo in a published post cost a
// deploy, and only somebody with the repo could fix it.
//
// ON RENDERING HTML. Post bodies are authored HTML and the page sets
// them with dangerouslySetInnerHTML. That was safe while they were
// compile-time constants; the moment they arrive from a database it is
// a stored-XSS question, and "only admins can write them" is an access
// answer to an injection problem — it survives exactly until an admin
// session is stolen or an admin pastes something they were sent. So the
// body is sanitised HERE, on write, against an allow-list: anything not
// on it is dropped, script/style/iframe are dropped whole, and no
// attribute that can hold a URL or an event handler survives.
// ============================================================

import { isAdminSession } from './admins.js';
import { SEED_POSTS } from '../src/content/devlogPosts.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });

const err = (status, code, message) => json({ error: { code, message } }, status);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function newId() {
  return 'dl_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// ------------------------------------------------------------------
// SANITISER
//
// Deliberately an ALLOW-list of tags with NO attributes at all. The
// authored posts use exactly this vocabulary, and every attribute worth
// having on a devlog (there are none) is worth less than the class of
// bug it opens: `href`, `src`, `style` and `on*` are all injection
// surfaces, and an allow-list of attributes is a thing you have to keep
// getting right forever.
//
// The one exception is `class` on the table wrapper, because the Game 3
// notes carry `cl-tablewrap` / `cl-table` and the page's CSS keys off
// them. It is restricted to a fixed set of known class names rather
// than "any class", so it cannot be used to reach an unrelated rule.
// ------------------------------------------------------------------
const ALLOWED_TAGS = new Set([
  'p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i',
  'blockquote', 'code', 'pre', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
]);

/** Tags whose CONTENT must die with them. Dropping `<script>` while
 *  keeping its text would paste the payload into the page as prose,
 *  which is not obviously harmless and is definitely not intended. */
const VOID_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math']);

const ALLOWED_CLASSES = new Set(['cl-tablewrap', 'cl-table']);

export function sanitizeHtml(input) {
  let s = String(input ?? '');

  // 1. Kill dangerous elements INCLUDING their contents, first, so a
  //    payload cannot be reassembled from surviving text.
  for (const tag of VOID_CONTENT_TAGS) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi');
    s = s.replace(re, '');
    // Unclosed form: drop from the opening tag to the end rather than
    // leaving a live element behind.
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, 'i'), '');
  }
  // Comments can hide conditional-comment payloads in old engines and
  // carry nothing a post needs.
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Rewrite every remaining tag: keep it only if allow-listed, and
  //    strip every attribute except a known class on div/table.
  s = s.replace(/<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_m, close, rawName, attrs) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (close) return `</${name}>`;
    let keep = '';
    const cls = /class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs ?? '');
    if (cls) {
      const value = (cls[2] ?? cls[3] ?? '')
        .split(/\s+/)
        .filter(c => ALLOWED_CLASSES.has(c))
        .join(' ');
      if (value) keep = ` class="${value}"`;
    }
    return `<${name}${keep}>`;
  });

  return s;
}

// ------------------------------------------------------------------
// SEED. An empty table means a fresh database (or the migration that
// just created it), so the authored posts go in once. Guarded on a
// count rather than on "did the migration just run", because migrations
// re-apply on every request and a seed that ran twice would duplicate
// every post.
// ------------------------------------------------------------------
async function seedIfEmpty(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM devlog_posts').first();
  if (Number(row?.n ?? 0) > 0) return;
  const now = Date.now();
  // Highest sort_index first: SEED_POSTS is authored newest-first, so
  // the index counts DOWN and the page order matches the file order.
  let idx = SEED_POSTS.length;
  for (const p of SEED_POSTS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO devlog_posts
         (id, slug, title, date, lede, html, charts, published, sort_index,
          created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      newId(), p.slug, p.title, p.date ?? '', p.lede ?? '',
      sanitizeHtml(p.html ?? ''), p.charts ? 1 : 0, idx, now, now,
    ).run();
    idx -= 1;
  }
}

const toClient = (r) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  date: r.date,
  lede: r.lede,
  html: r.html,
  charts: Number(r.charts ?? 0) === 1,
  published: Number(r.published ?? 0) === 1,
  sort_index: Number(r.sort_index ?? 0),
  updated_at_ms: Number(r.updated_at_ms ?? 0),
});

// ---------- GET /api/devlog (public) ----------
async function handleList(_req, env) {
  try {
    await seedIfEmpty(env);
    const rows = (await env.DB.prepare(
      `SELECT * FROM devlog_posts WHERE published = 1
        ORDER BY sort_index DESC, created_at_ms DESC`,
    ).all()).results ?? [];
    return json({ posts: rows.map(toClient) });
  } catch (e) {
    // The page falls back to its compiled copy, so a devlog outage must
    // never be an error the visitor sees.
    console.error('devlog list failed', e);
    return json({ posts: [], degraded: true });
  }
}

// ---------- GET /api/admin/devlog ----------
async function handleAdminList(_req, env, { session }) {
  if (!isAdminSession(session)) return err(404, 'not_found', 'not found');
  await seedIfEmpty(env);
  const rows = (await env.DB.prepare(
    `SELECT * FROM devlog_posts ORDER BY sort_index DESC, created_at_ms DESC`,
  ).all()).results ?? [];
  return json({ posts: rows.map(toClient) });
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

/** Shared field validation. Returns { error } or { fields }. */
function readFields(body, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('slug') || !partial) {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return { error: err(400, 'bad_slug',
        'slug must be lowercase letters, numbers and dashes (max 64)') };
    }
    out.slug = slug;
  }
  if (has('title') || !partial) {
    const title = String(body.title ?? '').trim();
    if (!title) return { error: err(400, 'bad_request', 'a post needs a title') };
    if (title.length > 200) return { error: err(400, 'bad_request', 'title is too long') };
    out.title = title;
  }
  if (has('date') || !partial) out.date = String(body.date ?? '').trim().slice(0, 60);
  if (has('lede') || !partial) out.lede = String(body.lede ?? '').trim().slice(0, 600);
  if (has('html') || !partial) {
    const raw = String(body.html ?? '');
    // 512KB of HTML is far past any real post and well inside D1's row
    // limits; the cap exists so a paste accident cannot wedge the table.
    if (raw.length > 512_000) return { error: err(413, 'too_large', 'post body is too large') };
    out.html = sanitizeHtml(raw);
  }
  if (has('charts')) out.charts = body.charts ? 1 : 0;
  if (has('published')) out.published = body.published ? 1 : 0;
  if (has('sort_index')) {
    const n = Number(body.sort_index);
    if (!Number.isFinite(n)) return { error: err(400, 'bad_request', 'sort_index must be a number') };
    out.sort_index = Math.trunc(n);
  }
  return { fields: out };
}

// ---------- POST /api/admin/devlog ----------
async function handleCreate(req, env, { session }) {
  if (!isAdminSession(session)) return err(404, 'not_found', 'not found');
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const got = readFields(body, { partial: false });
  if (got.error) return got.error;
  const f = got.fields;

  const clash = await env.DB.prepare('SELECT id FROM devlog_posts WHERE slug = ?')
    .bind(f.slug).first();
  if (clash) return err(409, 'slug_taken', 'another post already uses that slug');

  // A new post goes to the TOP by default: you write the newest update
  // most of the time, and having to set a number to achieve the normal
  // case is the kind of friction that gets a feature abandoned.
  const top = await env.DB.prepare('SELECT COALESCE(MAX(sort_index), 0) AS n FROM devlog_posts').first();
  const now = Date.now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO devlog_posts
       (id, slug, title, date, lede, html, charts, published, sort_index,
        created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, f.slug, f.title, f.date ?? '', f.lede ?? '', f.html ?? '',
    f.charts ?? 0,
    // Default to DRAFT. Publishing is a decision, and an editor that
    // puts half-written prose on the front page the moment you hit save
    // is one nobody drafts in.
    f.published ?? 0,
    f.sort_index ?? (Number(top?.n ?? 0) + 1),
    now, now,
  ).run();

  const row = await env.DB.prepare('SELECT * FROM devlog_posts WHERE id = ?').bind(id).first();
  return json({ ok: true, post: toClient(row) });
}

// ---------- PATCH /api/admin/devlog/:id ----------
async function handleUpdate(req, env, { session, params }) {
  if (!isAdminSession(session)) return err(404, 'not_found', 'not found');
  const { id } = params;
  const existing = await env.DB.prepare('SELECT * FROM devlog_posts WHERE id = ?').bind(id).first();
  if (!existing) return err(404, 'not_found', 'no such post');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const got = readFields(body, { partial: true });
  if (got.error) return got.error;
  const f = got.fields;

  if (f.slug && f.slug !== existing.slug) {
    const clash = await env.DB.prepare('SELECT id FROM devlog_posts WHERE slug = ? AND id != ?')
      .bind(f.slug, id).first();
    if (clash) return err(409, 'slug_taken', 'another post already uses that slug');
  }

  const keys = Object.keys(f);
  if (keys.length === 0) return json({ ok: true, post: toClient(existing) });
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE devlog_posts SET ${sets}, updated_at_ms = ? WHERE id = ?`,
  ).bind(...keys.map(k => f[k]), Date.now(), id).run();

  const row = await env.DB.prepare('SELECT * FROM devlog_posts WHERE id = ?').bind(id).first();
  return json({ ok: true, post: toClient(row) });
}

// ---------- DELETE /api/admin/devlog/:id ----------
async function handleDelete(_req, env, { session, params }) {
  if (!isAdminSession(session)) return err(404, 'not_found', 'not found');
  const row = await env.DB.prepare('SELECT id FROM devlog_posts WHERE id = ?')
    .bind(params.id).first();
  if (!row) return err(404, 'not_found', 'no such post');
  await env.DB.prepare('DELETE FROM devlog_posts WHERE id = ?').bind(params.id).run();
  return json({ ok: true });
}

export const routes = [
  { method: 'GET', pattern: '/api/devlog', auth: 'optional', handle: handleList },
  { method: 'GET', pattern: '/api/admin/devlog', auth: 'required', handle: handleAdminList },
  { method: 'POST', pattern: '/api/admin/devlog', auth: 'required', handle: handleCreate },
  {
    method: 'PATCH',
    pattern: /^\/api\/admin\/devlog\/(?<id>[A-Za-z0-9_-]+)$/,
    auth: 'required',
    handle: handleUpdate,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/admin\/devlog\/(?<id>[A-Za-z0-9_-]+)$/,
    auth: 'required',
    handle: handleDelete,
  },
];
