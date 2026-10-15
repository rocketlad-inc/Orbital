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

import { json, err, readJson } from './trades.js';
import { BODY_CATALOG, STARTING_BODY_OPTIONS } from './factions.js';
import { hasEntitlement } from './store.js';
import { isAdminEmail } from './admins.js';
import {
  normalizeMap, checkMap, blankMap, TYPE_INFO, newBodyId,
} from '../src/game/customMap.js';

const MAX_MAPS_PER_USER = 50;
const MAX_JSON_BYTES = 200_000;
const MAP_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const CODE_RE = /^ORB-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** The Map Maker is a staging feature until it ships. */
export function mapMakerEnabled(env) {
  return env?.ORBITAL_ENV === 'staging';
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
  };
}

function parseStored(text) {
  try { return normalizeMap(JSON.parse(text)); } catch { return blankMap(); }
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
  if (text.length > MAX_JSON_BYTES) return [null, err(413, 'too_large', 'that map is too large to save')];
  return [{ map, text }];
}

async function ownMap(env, session, id) {
  if (!MAP_ID_RE.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM custom_maps WHERE id = ? AND owner_user_id = ?')
    .bind(id, session.user_id).first();
}

const gate = (handler) => async (req, env, ctx) => {
  if (!mapMakerEnabled(env)) return err(404, 'not_found', 'not found');
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
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM custom_maps WHERE owner_user_id = ?')
    .bind(ctx.session.user_id).first();
  if (Number(count?.n ?? 0) >= MAX_MAPS_PER_USER) {
    return err(409, 'too_many_maps', `you can keep up to ${MAX_MAPS_PER_USER} maps; delete one first`);
  }
  const now = Date.now();
  const id = newMapId();
  let code = randomCode();
  for (let i = 0; i < 4; i++) {
    const clash = await env.DB.prepare('SELECT 1 AS x FROM custom_maps WHERE share_code = ?').bind(code).first();
    if (!clash) break;
    code = randomCode();
  }
  await env.DB.prepare(
    `INSERT INTO custom_maps (id, owner_user_id, name, map_json, share_code, copied_from, hosted_count, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  ).bind(id, ctx.session.user_id, got.map.name, got.text, code, now, now).run();
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

// PUT /api/maps/:id {map}
async function handlePut(req, env, ctx) {
  const row = await ownMap(env, ctx.session, ctx.params.id);
  if (!row) return err(404, 'not_found', 'map not found');
  const [got, bad] = await mapFromBody(req);
  if (bad) return bad;
  const now = Date.now();
  await env.DB.prepare('UPDATE custom_maps SET name = ?, map_json = ?, updated_ms = ? WHERE id = ?')
    .bind(got.map.name, got.text, now, row.id).run();
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
  const map = parseStored(src.map_json);
  if (src.owner_user_id !== ctx.session.user_id && map.settings.shareHidesSecrets) {
    for (const b of map.bodies) if (b.secret) b.secret = 'random';
  }
  map.name = normalizeMap({ ...map, name: `${map.name} (copy)` }).name;
  const req2 = new Request('https://x/api/maps', { method: 'POST', body: JSON.stringify({ map }) });
  const res = await handleCreate(req2, env, ctx);
  if (res.status === 201) {
    const out = await res.json();
    await env.DB.prepare('UPDATE custom_maps SET copied_from = ? WHERE id = ?').bind(src.id, out.summary.id).run();
    return json(out, { status: 201 });
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
  { method: 'GET', pattern: '/api/maps', auth: 'required', handle: gate(handleList) },
  { method: 'POST', pattern: '/api/maps', auth: 'required', handle: gate(handleCreate) },
  { method: 'POST', pattern: '/api/maps/import', auth: 'required', handle: gate(handleImport) },
  { method: 'GET', pattern: '/api/maps/template/sol', auth: 'required', handle: gate(handleSolTemplate) },
  { method: 'GET', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handleGet) },
  { method: 'PUT', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handlePut) },
  { method: 'DELETE', pattern: /^\/api\/maps\/(?<id>map_[A-Za-z0-9]+)$/, auth: 'required', handle: gate(handleDelete) },
];

/** Seats a custom-map room can hold: one per start world (capped at the
 *  game's seat maximum by the caller). Null for an ordinary room. */
export async function customSeatCap(env, roomId) {
  const map = await roomCustomMap(env, roomId);
  if (!map) return null;
  const { startWorlds } = await import('../src/game/customMap.js');
  return startWorlds(map).worlds.length;
}

/** For seeding: the snapshot a room was hosted with, cleaned, or null. */
export async function roomCustomMap(env, gameId) {
  try {
    const row = await env.DB.prepare('SELECT custom_map_json FROM rooms WHERE id = ?').bind(gameId).first();
    if (!row?.custom_map_json) return null;
    return normalizeMap(JSON.parse(row.custom_map_json));
  } catch {
    return null;
  }
}
