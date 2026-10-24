// ============================================================================
// saga/index.js — the Saga Engine's front door: build a finished match's film
// script, keep it with the game's data (game_sagas), and hand it out.
//
// Automatic: the script is written when a match ends (room.js / senate.js
// call buildAndStoreSaga next to the final Herald), and again the first time
// a film is opened if it is missing or was written by an older engine. No
// player does anything.
// ============================================================================

import { readDossier } from './dossier.js';
import { buildScript, scriptText, SAGA_ENGINE_VERSION } from './engine.js';
import { isAdminEmail } from '../admins.js';

export { SAGA_ENGINE_VERSION };

async function storedSaga(env, gameId) {
  try {
    return await env.DB.prepare(
      'SELECT engine_version AS v, ordinal, script FROM game_sagas WHERE game_id = ?',
    ).bind(gameId).first();
  } catch { return null; }
}

/**
 * Build the script for a finished game and store it. Returns the script, or
 * null when the game is not finished (or not found). A rebuild keeps the
 * film's place in the sequence (its ordinal), so its words only change when
 * the engine does.
 */
export async function buildAndStoreSaga(env, gameId) {
  const prev = await storedSaga(env, gameId);
  const D = await readDossier(env, gameId, prev ? { ordinal: prev.ordinal } : {});
  if (!D) return null;
  const script = buildScript(D);
  await env.DB.prepare(
    `INSERT INTO game_sagas (game_id, engine_version, ordinal, script, built_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET engine_version = excluded.engine_version,
       ordinal = excluded.ordinal, script = excluded.script, built_at_ms = excluded.built_at_ms`,
  ).bind(gameId, SAGA_ENGINE_VERSION, script.ordinal, JSON.stringify(script), Date.now()).run();
  return script;
}

/**
 * The script for a game's film: the stored one, or a fresh build when there
 * is none yet or it was written by an older engine. Never throws; null for a
 * game that is still being played.
 */
export async function sagaFor(env, gameId) {
  try {
    const row = await storedSaga(env, gameId);
    if (row && Number(row.v) === SAGA_ENGINE_VERSION) return JSON.parse(row.script);
    return await buildAndStoreSaga(env, gameId);
  } catch (e) {
    console.error('saga: build failed', gameId, e);
    return null;
  }
}

/**
 * The script read, for an admin: GET /api/admin/games/<id>/saga
 *   ?rebuild=1   write it again now
 *   ?text=1      the film as plain text (the "script read")
 */
async function handleSagaRead(req, env, { session, params, url }) {
  if (!session || !isAdminEmail(session.email)) {
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }),
      { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const gameId = params.gameId;
  const script = url.searchParams.get('rebuild') ? await buildAndStoreSaga(env, gameId) : await sagaFor(env, gameId);
  if (!script) {
    return new Response(JSON.stringify({ error: { code: 'not_finished', message: 'no film for this game yet' } }),
      { status: 409, headers: { 'content-type': 'application/json' } });
  }
  if (url.searchParams.get('text')) {
    const D = await readDossier(env, gameId, { ordinal: script.ordinal });
    return new Response(scriptText(script, D), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response(JSON.stringify(script), { headers: { 'content-type': 'application/json' } });
}

export const routes = [
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/saga$/, auth: 'required', handle: handleSagaRead },
];
