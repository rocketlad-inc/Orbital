// ============================================================================
// configAdmin.js — the API behind the Editor page.
//
// Draft -> test -> publish, admin-only. Every route is gated on
// isAdminEmail; a knob that changes combat maths is not something to
// protect with an unguessable URL.
//
// Design notes worth keeping:
//
//   * Overrides are stored SPARSE. Saving a draft writes only the keys
//     that differ from the shipped default, so a draft that touches one
//     number stays one key wide and inherits every future default change
//     instead of freezing the whole game at today's values.
//
//   * Publishing ARCHIVES the previous published config rather than
//     deleting it. Games pin config_id forever, and a running match whose
//     config row vanished would silently fall back to defaults — a
//     mid-game rebalance nobody asked for.
//
//   * Validation is server-side and total. The UI bounds are a courtesy;
//     this is the gate.
// ============================================================================

import { SCHEMA, GROUPS, BODY_FIELDS, defaults, validateAll, validateBodies } from './configSchema.js';
import { CATALOG_FOR_EDITOR } from './factions.js';
import { invalidate } from './gameConfig.js';
import { isAdminEmail } from './analytics.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const err = (status, code, message) => json({ error: { code, message } }, status);

function admin(ctx) {
  return ctx.session && isAdminEmail(ctx.session.email);
}

function newId() {
  return `cfg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** GET /api/admin/config/schema — the knob catalogue + shipped defaults.
 *  The Editor renders itself from this, so a knob added to configSchema.js
 *  appears in the UI with no client change. */
async function handleSchema(_req, _env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  return json({
    groups: GROUPS, schema: SCHEMA, defaults: defaults(),
    bodyFields: BODY_FIELDS, catalog: CATALOG_FOR_EDITOR,
  });
}

/** GET /api/admin/config — every config, newest first. */
async function handleList(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const rows = (await env.DB
    .prepare(
      `SELECT c.id, c.name, c.status, c.notes, c.parent_id,
              c.created_ms, c.updated_ms, c.published_ms,
              (SELECT COUNT(*) FROM games g WHERE g.config_id = c.id) games
         FROM game_configs c ORDER BY c.updated_ms DESC LIMIT 100`,
    ).all()).results ?? [];
  return json({
    configs: rows.map(r => ({ ...r, overrides: undefined })),
  });
}

/** GET /api/admin/config/:id — one config with its overrides. */
async function handleGet(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const row = await env.DB
    .prepare('SELECT * FROM game_configs WHERE id = ?').bind(ctx.params.id).first();
  if (!row) return err(404, 'not_found', 'no such config');
  let overrides = {};
  try { overrides = JSON.parse(row.overrides || '{}'); } catch { /* corrupt -> empty */ }
  return json({ config: { ...row, overrides } });
}

/** POST /api/admin/config — create a draft, optionally cloned. */
async function handleCreate(req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  let body = {};
  try { body = await req.json(); } catch { /* empty is fine */ }

  let overrides = {};
  let parentId = null;
  if (body.clone_from) {
    const src = await env.DB
      .prepare('SELECT id, overrides FROM game_configs WHERE id = ?')
      .bind(body.clone_from).first();
    if (!src) return err(404, 'not_found', 'clone source not found');
    try { overrides = JSON.parse(src.overrides || '{}'); } catch { /* ignore */ }
    parentId = src.id;
  }

  const id = newId();
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO game_configs (id, name, status, overrides, notes, parent_id,
                                 created_by, created_ms, updated_ms)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, String(body.name || 'Untitled draft').slice(0, 80),
      JSON.stringify(overrides), body.notes ?? null, parentId,
      ctx.session.user_id, now, now)
    .run();
  return json({ ok: true, id });
}

/**
 * PATCH /api/admin/config/:id — save knob values.
 *
 * Takes a FULL value map and stores only what differs from the shipped
 * default (see the sparse-storage note up top). Rejects the whole write
 * if any value is out of bounds rather than saving a partially-valid
 * config — half-applied balance is worse than a failed save.
 */
async function handleUpdate(req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const row = await env.DB
    .prepare('SELECT id, status FROM game_configs WHERE id = ?').bind(ctx.params.id).first();
  if (!row) return err(404, 'not_found', 'no such config');
  if (row.status !== 'draft') {
    return err(409, 'not_draft', 'published and archived configs are immutable — clone it first');
  }

  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }

  const patch = {};
  if (body.values && typeof body.values === 'object') {
    const { clean, errors } = validateAll(body.values);
    if (Object.keys(errors).length) {
      return json({ error: { code: 'invalid_values', message: 'some values were out of range' }, errors }, 400);
    }
    const def = defaults();
    for (const [k, v] of Object.entries(clean)) if (v !== def[k]) patch[k] = v;
  }

  // Map edits. Stored sparse per body per field, for the same reason the
  // knobs are: a config carrying a full copy of the solar system would
  // never see a later change to the shipped catalogue.
  if (body.bodies && typeof body.bodies === 'object') {
    const { clean, errors } = validateBodies(body.bodies);
    if (Object.keys(errors).length) {
      return json({ error: { code: 'invalid_bodies', message: 'some body edits were out of range' }, errors }, 400);
    }
    if (Object.keys(clean).length) patch.bodies = clean;
  }

  const now = Date.now();
  await env.DB
    .prepare('UPDATE game_configs SET overrides = ?, name = COALESCE(?, name), notes = COALESCE(?, notes), updated_ms = ? WHERE id = ?')
    .bind(JSON.stringify(patch), body.name ?? null, body.notes ?? null, now, ctx.params.id)
    .run();
  invalidate();
  return json({ ok: true, overrides: patch, changed: Object.keys(patch).length });
}

/** POST /api/admin/config/:id/publish — make this the config new games use. */
async function handlePublish(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const row = await env.DB
    .prepare('SELECT id, status FROM game_configs WHERE id = ?').bind(ctx.params.id).first();
  if (!row) return err(404, 'not_found', 'no such config');

  const now = Date.now();
  // Archive rather than delete — games pin config_id forever.
  await env.DB.batch([
    env.DB.prepare("UPDATE game_configs SET status = 'archived' WHERE status = 'published'"),
    env.DB.prepare("UPDATE game_configs SET status = 'published', published_ms = ?, updated_ms = ? WHERE id = ?")
      .bind(now, now, ctx.params.id),
  ]);
  invalidate();
  return json({ ok: true, published: ctx.params.id });
}

/** POST /api/admin/config/:id/unpublish — fall back to shipped defaults. */
async function handleUnpublish(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  await env.DB
    .prepare("UPDATE game_configs SET status = 'archived', updated_ms = ? WHERE id = ? AND status = 'published'")
    .bind(Date.now(), ctx.params.id).run();
  invalidate();
  return json({ ok: true });
}

/** DELETE /api/admin/config/:id — drafts only, and only if unused. */
async function handleDelete(_req, env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  const row = await env.DB
    .prepare(
      `SELECT c.status, (SELECT COUNT(*) FROM games g WHERE g.config_id = c.id) games
         FROM game_configs c WHERE c.id = ?`,
    ).bind(ctx.params.id).first();
  if (!row) return err(404, 'not_found', 'no such config');
  if (row.status !== 'draft') return err(409, 'not_draft', 'only drafts can be deleted');
  if ((row.games ?? 0) > 0) {
    return err(409, 'in_use', `${row.games} game(s) reference this config — archive instead`);
  }
  await env.DB.prepare('DELETE FROM game_configs WHERE id = ?').bind(ctx.params.id).run();
  return json({ ok: true });
}

/**
 * POST /api/admin/config/:id/simulate — run the headless balance sweep
 * against this draft, WITHOUT publishing it.
 *
 * Deliberately not implemented in the Worker: sim/ runs on Node with
 * node:sqlite and a local D1 shim, neither of which exists here. Rather
 * than pretend, this returns the exact command to run — the sim reads
 * a config id and applies it the same way a real game would.
 */
async function handleSimulate(_req, _env, ctx) {
  if (!admin(ctx)) return err(404, 'not_found', 'no such route');
  return json({
    ok: true,
    runnable: false,
    reason: 'The simulator runs on Node (node:sqlite + a local D1 shim); a Worker cannot host it.',
    command: `npm run sim:sweep -- 20 500 bots ${ctx.params.id}`,
    hint: 'Run that locally against a copy of the config to see 20 games of balance effect before publishing.',
  });
}

export const routes = [
  { method: 'GET',    pattern: '/api/admin/config/schema', auth: 'required', handle: handleSchema },
  { method: 'GET',    pattern: '/api/admin/config',        auth: 'required', handle: handleList },
  { method: 'POST',   pattern: '/api/admin/config',        auth: 'required', handle: handleCreate },
  { method: 'GET',    pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)$/, auth: 'required', handle: handleGet },
  { method: 'PATCH',  pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)$/, auth: 'required', handle: handleUpdate },
  { method: 'DELETE', pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)$/, auth: 'required', handle: handleDelete },
  { method: 'POST',   pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)\/publish$/,   auth: 'required', handle: handlePublish },
  { method: 'POST',   pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)\/unpublish$/, auth: 'required', handle: handleUnpublish },
  { method: 'POST',   pattern: /^\/api\/admin\/config\/(?<id>cfg_[A-Za-z0-9]+)\/simulate$/,  auth: 'required', handle: handleSimulate },
];
