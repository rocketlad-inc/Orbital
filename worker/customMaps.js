// ============================================================
// THE MAP MAKER'S SERVER (Lorne, 2026-10-14): save, load, share and copy
// player-built star systems. The format and every rule live in
// src/game/customMap.js, shared with the client, so what the Map Maker
// shows is what the server enforces. Hosting a game on a map is in
// index.js (handleHostMap), beside the room creation it reuses.
//
// STAGING ONLY for now: every route answers 404 unless ORBITAL_ENV is
// 'staging', so shipping this file to production exposes nothing.
// ============================================================

import { json, err } from './trades.js';
import { BODY_CATALOG, STARTING_BODY_OPTIONS } from './factions.js';
import { hasEntitlement } from './store.js';
import { isAdminEmail } from './admins.js';
import {
  normalizeMap, checkMap, blankMap, TYPE_INFO, newBodyId, hostBlockers, startWorlds,
} from '../src/game/customMap.js';

const MAX_MAPS_PER_USER = 50;
const MAX_JSON_BYTES = 200_000;
/** A request body is read as text and refused before parsing when it is
 *  far past anything a map can be (security review: a huge body cost CPU
 *  and memory before the 200 KB map cap was ever checked). */
const MAX_BODY_BYTES = 1_000_000;
async function readJson(req) {
  try {
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return null;
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return JSON.parse(text);
  } catch { return null; }
}
/** Bytes, not UTF-16 units: an emoji-heavy map counted half its size. */
const byteLength = (text) => new TextEncoder().encode(text).length;
const MAP_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const CODE_RE = /^ORB-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Is the Map Maker open to this player? Always on staging. On prod, the
 * `map_maker_enabled` runtime setting (admin Live Ops panel, no deploy)
 * opens it to everyone; while it is off, admins still have it, so the
 * house maps can be built and published before launch.
 */
export async function mapMakerEnabled(env, session = null) {
  if (env?.ORBITAL_ENV === 'staging') return true;
  if (session?.email && isAdminEmail(session.email)) return true;
  try {
    const { getSetting } = await import('./botSettings.js');
    return (await getSetting(env, 'map_maker_enabled')) === true;
  } catch {
    return false;
  }
}

// GET /api/maps/enabled — {enabled}: does the lobby show the Map Maker?
async function handleEnabled(_req, env, ctx) {
  return json({ enabled: await mapMakerEnabled(env, ctx.session) });
}

/** May this player host a game on a custom map? The Commission, or an
 *  operator (who needs to test it without buying it). */
export async function canHostMaps(env, session) {
  if (!session) return false;
  if (isAdminEmail(session.email)) return true;
  return hasEntitlement(env, session.user_id);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
  return `ORB-${s.slice(0, 4)}-${s.slice(4)}`;
}
function newMapId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'map_' + [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

function summary(row, map) {
  const issues = checkMap(map);
  return {
    id: row.id,
    name: row.name,
    share_code: row.share_code,
    updated_ms: row.updated_ms,
    created_ms: row.created_ms,
    hosted_count: row.hosted_count ?? 0,
    bodies: map.bodies.length,
    blockers: issues.filter(i => i.level === 'block').length,
    warnings: issues.filter(i => i.level === 'warn').length,
    sun_color: map.sun.color,
    // The gallery (0167).
    published: Number(row.published ?? 0) === 1,
    published_ms: row.published_ms ?? null,
    remix_count: row.remix_count ?? 0,
    blurb: map.blurb ?? '',
  };
}

function parseStored(text) {
  try { return normalizeMap(JSON.parse(text)); } catch { return blankMap(); }
}

/** THE SECRET-HIDING RULE, said once (import, remix, gallery preview): a
 *  map whose owner keeps its discoveries secret reaches anyone else with
 *  every hand-placed discovery turned to "left to chance", and with no
 *  custom name or message to give the answer away. Mutates and returns
 *  the map. */
function hideSecretsFor(map, ownerId, viewerId) {
  if (ownerId === viewerId || !map.settings?.shareHidesSecrets) return map;
  for (const b of map.bodies) {
    if (b.secret) b.secret = 'random';
    b.secretName = '';
    b.secretText = '';
  }
  return map;
}

/** A gallery card: everything the browser needs to list a map and draw a
 *  mini system, and nothing more. `thumb.bodies` is the sun's own
 *  children only (moons omitted), each [orbit, angle, radius, color, type]. */
function galleryItem(row, map, viewerId) {
  const r1 = (n) => Math.round(Number(n) * 10) / 10;
  return {
    id: row.id,
    name: row.name,
    blurb: map.blurb ?? '',
    author: row.author ?? null,
    hosted_count: row.hosted_count ?? 0,
    remix_count: row.remix_count ?? 0,
    published_ms: row.published_ms ?? null,
    bodies: map.bodies.length,
    starts: startWorlds(map).worlds.length,
    thumb: {
      sun: { color: map.sun.color, size: map.sun.size },
      backdrop: map.settings?.backdrop ?? 'deep',
      bodies: map.bodies.filter(b => b.parent === 'sun')
        .map(b => [Math.round(b.orbit), Math.round(b.angle * 1000) / 1000, r1(b.radius), b.color, b.type]),
    },
    mine: row.owner_user_id === viewerId,
  };
}

/** Read and clean a map from a request body; [map] or [null, response]. */
async function mapFromBody(req) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return [null, err(400, 'bad_request', 'invalid body')];
  const raw = body.map;
  if (!raw || typeof raw !== 'object') return [null, err(400, 'bad_request', 'map required')];
  const map = normalizeMap(raw);
  if (typeof body.name === 'string' && body.name.trim()) map.name = normalizeMap({ ...map, name: body.name }).name;
  const text = JSON.stringify(map);
  if (byteLength(text) > MAX_JSON_BYTES) return [null, err(413, 'too_large', 'that map is too large to save')];
  return [{ map, text }];
}

async function ownMap(env, session, id) {
  if (!MAP_ID_RE.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM custom_maps WHERE id = ? AND owner_user_id = ?')
    .bind(id, session.user_id).first();
}

const gate = (handler) => async (req, env, ctx) => {
  if (!(await mapMakerEnabled(env, ctx.session))) return err(404, 'not_found', 'not found');
  return handler(req, env, ctx);
};

// GET /api/maps — your maps, newest first, plus whether you can host.
async function handleList(_req, env, ctx) {
  const rows = (await env.DB
    .prepare(`SELECT * FROM custom_maps WHERE owner_user_id = ? ORDER BY updated_ms DESC LIMIT ?`)
    .bind(ctx.session.user_id, MAX_MAPS_PER_USER).all()).results ?? [];
  return json({
    maps: rows.map(r => summary(r, parseStored(r.map_json))),
    can_host: await canHostMaps(env, ctx.session),
  });
}

// POST /api/maps {map, name?} — a new map.
async function handleCreate(req, env, ctx) {
  const [got, bad] = await mapFromBody(req);
  if (bad) return bad;
  const now = Date.now();
  const id = newMapId();
  let code = randomCode();
  for (let i = 0; i < 4; i++) {
    const clash = await env.DB.prepare('SELECT 1 AS x FROM custom_maps WHERE share_code = ?').bind(code).first();
    if (!clash) break;
    code = randomCode();
  }
  // The cap is checked INSIDE the insert, so ten saves racing at 49
  // maps cannot all get through (security review: 10 concurrent POSTs
  // left 59 rows).
  const ins = await env.DB.prepare(
    `INSERT INTO custom_maps (id, owner_user_id, name, map_json, share_code, copied_from, hosted_count, created_ms, updated_ms)
     SELECT ?, ?, ?, ?, ?, NULL, 0, ?, ?
      WHERE (SELECT COUNT(*) FROM custom_maps WHERE owner_user_id = ?) < ?`,
  ).bind(id, ctx.session.user_id, got.map.name, got.text, code, now, now, ctx.session.user_id, MAX_MAPS_PER_USER).run();
  if ((ins.meta?.changes ?? 0) !== 1) {
    return err(409, 'too_many_maps', `you can keep up to ${MAX_MAPS_PER_USER} maps; delete one first`);
  }
  const row = await env.DB.prepare('SELECT * FROM custom_maps WHERE id = ?').bind(id).first();
  return json({ map: got.map, summary: summary(row, got.map) }, { status: 201 });
}

// GET /api/maps/:id
async function handleGet(_req, env, ctx) {
  const row = await ownMap(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  const map = parseStored(row.map_json);
  return json({ map, summary: summary(row, map) });
}

// PUT /api/maps/:id {map, base_updated_ms?}
// base_updated_ms: the updated_ms the editor last opened or saved. When
// the map was saved since (another tab, another device), the edit is
// refused as 'stale' rather than written over that newer save; the
// editor then keeps its version as a new map. Without it (older
// clients), last write wins as before.
async function handlePut(req, env, ctx) {
  const row = await ownMap(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  // readJson keeps its size cap; a bad body is answered by mapFromBody.
  const peek = await readJson(req.clone());
  const base = Number.isFinite(peek?.base_updated_ms) ? Number(peek.base_updated_ms) : null;
  const stale = () => json({
    error: { code: 'stale', message: 'this map was saved somewhere else since you opened it' },
    summary: summary(row, parseStored(row.map_json)),
  }, { status: 409 });
  if (base != null && Number(row.updated_ms) > base) return stale();
  const [got, bad] = await mapFromBody(req);
  if (bad) return bad;
  const now = Math.max(Date.now(), Number(row.updated_ms) + 1);
  // The base is checked again INSIDE the write, so two saves racing from
  // the same base cannot both land.
  const res = base != null
    ? await env.DB.prepare('UPDATE custom_maps SET name = ?, map_json = ?, updated_ms = ? WHERE id = ? AND updated_ms <= ?')
      .bind(got.map.name, got.text, now, row.id, base).run()
    : await env.DB.prepare('UPDATE custom_maps SET name = ?, map_json = ?, updated_ms = ? WHERE id = ?')
      .bind(got.map.name, got.text, now, row.id).run();
  if (base != null && (res.meta?.changes ?? 1) === 0) return stale();
  return json({ map: got.map, summary: summary({ ...row, name: got.map.name, updated_ms: now }, got.map) });
}

// DELETE /api/maps/:id
async function handleDelete(_req, env, ctx) {
  const row = await ownMap(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  await env.DB.prepare('DELETE FROM custom_maps WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
}

// POST /api/maps/import {code} — a copy of someone's map, as your own.
// A map whose owner keeps its discoveries secret arrives with each
// hand-placed discovery turned to "left to chance": you get the board,
// not the answers.
async function handleImport(req, env, ctx) {
  const body = await readJson(req);
  const code = String(body?.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!CODE_RE.test(code)) return err(400, 'bad_code', 'a share code looks like ORB-7KQ2-HELN');
  const src = await env.DB.prepare('SELECT * FROM custom_maps WHERE share_code = ?').bind(code).first();
  if (!src) return err(404, 'not_found', 'no map has that code');
  return copyAsMine(env, ctx, src);
}

/** A copy of `src` (a custom_maps row) in the caller's maps: secrets
 *  hidden by the rule above, "(copy)" on the name, copied_from set, and
 *  the 50-map cap respected. 201 {map, summary} or the refusal. */
async function copyAsMine(env, ctx, src) {
  const map = hideSecretsFor(parseStored(src.map_json), src.owner_user_id, ctx.session.user_id);
  map.name = normalizeMap({ ...map, name: `${map.name} (copy)` }).name;
  const req2 = new Request('https://x/api/maps', { method: 'POST', body: JSON.stringify({ map }) });
  const res = await handleCreate(req2, env, ctx);
  if (res.status === 201) {
    const out = await res.json();
    await env.DB.prepare('UPDATE custom_maps SET copied_from = ? WHERE id = ?').bind(src.id, out.summary.id).run();
    out.summary.copied_from = src.id;
    return json(out, { status: 201 });
  }
  return res;
}

// ---- THE GALLERY (0167) ------------------------------------------------------
// Published maps from everyone. Publishing is the owner's choice and needs
// a map that could actually be hosted; remixing copies a published map
// (or your own) into your maps under the same secret-hiding rule as a
// share code.

// POST /api/maps/:id/publish {on: boolean}
async function handlePublish(req, env, ctx) {
  const row = await ownMap(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  const body = await readJson(req);
  if (!body || typeof body.on !== 'boolean') return err(400, 'bad_request', 'on (true or false) required');
  const map = parseStored(row.map_json);
  const now = Date.now();
  if (body.on) {
    const blockers = hostBlockers(map);
    if (blockers.length > 0) {
      return json({
        error: { code: 'map_blocked', message: 'fix what the checklist blocks before publishing' },
        blockers,
      }, { status: 409 });
    }
    if (!String(row.name ?? '').trim()) return err(400, 'name_required', 'give the map a name before publishing');
    // A map already in the gallery keeps its place in "new".
    const publishedMs = Number(row.published ?? 0) === 1 && row.published_ms ? row.published_ms : now;
    await env.DB.prepare('UPDATE custom_maps SET published = 1, published_ms = ? WHERE id = ?')
      .bind(publishedMs, row.id).run();
    return json({ summary: summary({ ...row, published: 1, published_ms: publishedMs }, map) });
  }
  await env.DB.prepare('UPDATE custom_maps SET published = 0 WHERE id = ?').bind(row.id).run();
  return json({ summary: summary({ ...row, published: 0 }, map) });
}

const GALLERY_MAX = 30;
const SCORE_SQL = '(c.hosted_count * 3 + c.remix_count)';

// GET /api/maps/gallery?sort=popular|new&q=&limit=30&before=<cursor>
//
// Keyset pagination: `before` is the `next` value of the previous page,
// an opaque string. Popular = hosted*3 + remixes, then newest; New =
// newest published first. q is a case-insensitive match on the name.
async function handleGallery(_req, env, ctx) {
  const sp = ctx.url?.searchParams ?? new URLSearchParams();
  const sort = sp.get('sort') === 'new' ? 'new' : 'popular';
  const limit = Math.max(1, Math.min(GALLERY_MAX, Math.floor(Number(sp.get('limit')) || GALLERY_MAX)));
  const q = String(sp.get('q') ?? '').trim().slice(0, 40);
  const where = ['c.published = 1'];
  const binds = [];
  if (q) {
    where.push(`c.name LIKE ? ESCAPE '\\'`);
    binds.push(`%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
  }
  // The cursor: "score.published_ms.id" (popular) or "published_ms.id" (new).
  const before = String(sp.get('before') ?? '');
  if (before) {
    const parts = before.split('.');
    const id = parts.pop();
    const nums = parts.map(Number);
    const okId = MAP_ID_RE.test(String(id));
    if (sort === 'new' && okId && nums.length === 1 && nums.every(Number.isFinite)) {
      where.push('(c.published_ms < ? OR (c.published_ms = ? AND c.id < ?))');
      binds.push(nums[0], nums[0], id);
    } else if (sort === 'popular' && okId && nums.length === 2 && nums.every(Number.isFinite)) {
      where.push(`(${SCORE_SQL} < ? OR (${SCORE_SQL} = ? AND (c.published_ms < ? OR (c.published_ms = ? AND c.id < ?))))`);
      binds.push(nums[0], nums[0], nums[1], nums[1], id);
    } else {
      return err(400, 'bad_cursor', 'that page cursor is not valid');
    }
  }
  const order = sort === 'new'
    ? 'c.published_ms DESC, c.id DESC'
    : `${SCORE_SQL} DESC, c.published_ms DESC, c.id DESC`;
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.owner_user_id, c.name, c.map_json, c.hosted_count, c.remix_count, c.published_ms,
            ${SCORE_SQL} AS score, u.display_name AS author
       FROM custom_maps c LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?`,
  ).bind(...binds, limit).all()).results ?? [];
  // A published map later edited into one nobody can host stays
  // published (autosave would otherwise yank it mid-edit) but is kept
  // out of the gallery until it is fixed.
  const items = rows
    .map(r => [r, parseStored(r.map_json)])
    .filter(([, m]) => hostBlockers(m).length === 0)
    .map(([r, m]) => galleryItem(r, m, ctx.session.user_id));
  const last = rows[rows.length - 1];
  const next = rows.length === limit && last
    ? (sort === 'new' ? `${last.published_ms}.${last.id}` : `${last.score}.${last.published_ms}.${last.id}`)
    : null;
  return json({ items, next, sort });
}

/** A map the caller may see in the gallery: published, or their own. */
async function galleryRow(env, session, id) {
  if (!MAP_ID_RE.test(String(id))) return null;
  return env.DB.prepare(
    `SELECT c.*, u.display_name AS author
       FROM custom_maps c LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.id = ? AND (c.published = 1 OR c.owner_user_id = ?)`,
  ).bind(id, session.user_id).first();
}

// GET /api/maps/gallery/:id — {map, item}: a published map to preview
// before remixing, under the secret-hiding rule.
async function handleGalleryGet(_req, env, ctx) {
  const row = await galleryRow(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  const map = hideSecretsFor(parseStored(row.map_json), row.owner_user_id, ctx.session.user_id);
  return json({ map, item: galleryItem(row, map, ctx.session.user_id) });
}

// POST /api/maps/:id/remix — a published map (or your own) copied into
// your maps. Counts as a remix only when it is somebody else's.
async function handleRemix(_req, env, ctx) {
  const src = await galleryRow(env, ctx.session, ctx.params.id);
  if (!src) return err(404, 'not_found', 'map not found');
  const res = await copyAsMine(env, ctx, src);
  if (res.status === 201 && src.owner_user_id !== ctx.session.user_id) {
    // Once per person per map: remix-and-delete in a loop counts once.
    const first = await env.DB.prepare(
      'INSERT OR IGNORE INTO custom_map_remixes (map_id, user_id, created_ms) VALUES (?, ?, ?)',
    ).bind(src.id, ctx.session.user_id, Date.now()).run();
    if ((first.meta?.changes ?? 0) === 1) {
      await env.DB.prepare('UPDATE custom_maps SET remix_count = remix_count + 1 WHERE id = ?').bind(src.id).run();
    }
  }
  return res;
}

/** Our Solar System as a map: the shipped catalogue (no far systems, no
 *  generated rocks), every world renamable and movable. */
export function solTemplate() {
  const map = blankMap('Our Solar System');
  const sol = BODY_CATALOG.find(b => b.id === 'sol');
  map.sun = { name: sol?.name ?? 'Sun', color: '#ffd180', size: Math.min(90, Math.max(30, sol?.radius ?? 50)), mass: 1 };
  const starts = new Set(STARTING_BODY_OPTIONS.map(b => b.id));
  const kept = BODY_CATALOG.filter(b => !b.far_system && b.type !== 'star' && b.type !== 'lagrange'
    && b.type !== 'black_hole' && b.type !== 'meteoroid' && b.orbit_rp == null);
  const idMap = new Map();
  const taken = new Set();
  for (const b of kept) {
    const clean = String(b.id).replace(/[^a-z0-9]/g, '').slice(0, 12);
    const id = clean && !taken.has(clean) ? clean : newBodyId(taken);
    taken.add(id);
    idMap.set(b.id, id);
  }
  const SURFACE = {
    earth: 'ocean', mars: 'desert', venus: 'toxic', mercury: 'barren', io: 'lava', europa: 'ice',
    titan: 'toxic', ganymede: 'ice', callisto: 'barren', enceladus: 'ice', triton: 'ice', luna: 'barren',
  };
  const RINGS = new Set(['saturn', 'uranus']);
  for (const b of kept) {
    const type = TYPE_INFO[b.type] ? b.type : null;
    if (!type) continue;
    const isMoon = b.type === 'moon';
    const parent = isMoon ? idMap.get(b.parent) : 'sun';
    if (isMoon && !parent) continue;
    map.bodies.push({
      id: idMap.get(b.id), name: b.name, type, parent: parent ?? 'sun',
      orbit: b.orbit_radius, angle: b.angle0 ?? 0, radius: b.radius,
      yields: { metal: b.yield.metal, credits: b.yield.gold, science: b.yield.science },
      color: b.color, surface: SURFACE[b.id] ?? TYPE_INFO[type].surface, rings: RINGS.has(b.id),
      start: starts.has(b.id), secret: null,
    });
  }
  return normalizeMap(map);
}

// GET /api/maps/template/sol
async function handleSolTemplate() {
  return json({ map: solTemplate() });
}

export const routes = [
  { method: 'GET', pattern: '/api/maps/enabled', auth: 'required', handle: handleEnabled },
  { method: 'GET', pattern: '/api/maps', auth: 'required', handle: gate(handleList) },
  { method: 'POST', pattern: '/api/maps', auth: 'required', handle: gate(handleCreate) },
  { method: 'POST', pattern: '/api/maps/import', auth: 'required', handle: gate(handleImport) },
  { method: 'GET', pattern: '/api/maps/template/sol', auth: 'required', handle: gate(handleSolTemplate) },
  { method: 'GET', pattern: '/api/maps/gallery', auth: 'required', handle: gate(handleGallery) },
  { method: 'GET', pattern: /^\/api\/maps\/gallery\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handleGalleryGet) },
  { method: 'POST', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)\/publish$/, auth: 'required', handle: gate(handlePublish) },
  { method: 'POST', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)\/remix$/, auth: 'required', handle: gate(handleRemix) },
  { method: 'GET', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handleGet) },
  { method: 'PUT', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handlePut) },
  { method: 'DELETE', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handleDelete) },
];

/** Seats a custom-map room can hold: one per start world (capped at the
 *  game's seat maximum by the caller). Null for an ordinary room. */
export async function customSeatCap(env, roomId) {
  // A room whose snapshot cannot be read has no seat cap to offer: the
  // lobby's settings edits carry on, and the start refuses cleanly
  // (seed_failed, lobby reopened) rather than every edit erroring.
  try {
    const map = await roomCustomMap(env, roomId);
    if (!map) return null;
    return startWorlds(map).worlds.length;
  } catch (e) {
    console.error('customSeatCap: unreadable custom map', roomId, e);
    return null;
  }
}

/** For seeding: the snapshot a room was hosted with, cleaned.
 *
 *  NULL MEANS "NO CUSTOM MAP", NOTHING ELSE. A room that was hosted on a
 *  map (custom_map_id set, or a snapshot present) whose snapshot is missing
 *  or will not parse THROWS: swallowing that used to return null, and the
 *  seeder built Sol under a custom room's rules (cfg() keys custom_map off
 *  custom_map_id). The seeder's caller (lobby.startGame) undoes the start.
 *  A failed lookup throws too: it cannot tell the two apart. */
export async function roomCustomMap(env, gameId) {
  const row = await env.DB.prepare('SELECT custom_map_id, custom_map_json FROM rooms WHERE id = ?').bind(gameId).first();
  if (!row?.custom_map_json && !row?.custom_map_id) return null;
  if (!row.custom_map_json) throw new Error(`room ${gameId}: hosted on custom map ${row.custom_map_id} but carries no snapshot`);
  let parsed;
  try {
    parsed = JSON.parse(row.custom_map_json);
  } catch (e) {
    throw new Error(`room ${gameId}: custom map snapshot is not JSON (${e?.message || e})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`room ${gameId}: custom map snapshot is not a map`);
  }
  return normalizeMap(parsed);
}
