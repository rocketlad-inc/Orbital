#!/usr/bin/env node
// ============================================================================
// The Saga Engine on REAL finished matches, from PRODUCTION data: the
// "script read". Prints, for each match, the film the engine would make:
// its crawl, its cast, its stories, its scenes and every word on screen.
//
//   node scripts/saga-from-prod.mjs <gameId ...> [--refresh] [--json]
//   node scripts/saga-from-prod.mjs --all            (every finished match)
//
// It runs the very same readDossier() the worker runs (worker/saga/dossier.js)
// against a READ-ONLY adapter (scripts/ending-from-prod.mjs: SELECT only, one
// statement at a time, no run()), and keeps each match's dossier in the OS
// temp folder so a second read is instant. --refresh fetches again.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prodEnv } from './ending-from-prod.mjs';
import { readDossier } from '../worker/saga/dossier.js';
import { buildScript, scriptText } from '../worker/saga/engine.js';

const CACHE = path.join(os.tmpdir(), 'orbital-saga');

async function allFinished() {
  const r = await prodEnv.DB.prepare(
    `SELECT g.id FROM games g
      WHERE g.status = 'completed' AND g.winner_faction_id IS NOT NULL
        AND (SELECT COUNT(*) FROM game_factions f WHERE f.game_id = g.id) >= 3
        AND (SELECT COUNT(*) FROM match_snapshots s WHERE s.game_id = g.id) > 100
      ORDER BY g.completed_at DESC`).all();
  return r.results.map(x => x.id);
}

export async function dossierFor(gameId, { refresh = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `dossier.${gameId}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const d = await readDossier(prodEnv, gameId, { ordinal: 0 });
  if (!d) throw new Error(`${gameId}: not a finished game`);
  writeFileSync(file, JSON.stringify(d));
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  let ids = args.filter(a => !a.startsWith('--'));
  if (flags.has('--all')) ids = await allFinished();
  if (!ids.length) {
    console.error('usage: node scripts/saga-from-prod.mjs <gameId ...> | --all [--refresh] [--json] [--fetch-only]');
    process.exit(2);
  }
  for (const [i, id] of ids.entries()) {
    let d;
    try { d = await dossierFor(id, { refresh: flags.has('--refresh') }); }
    catch (e) { console.error(`${id}: ${e.message}`); continue; }
    if (flags.has('--fetch-only')) { console.log(`${id}: dossier ok`); continue; }
    // In a run over many matches each film gets its own place in the
    // sequence, as it would have on the server.
    const script = buildScript({ ...d, ordinal: i });
    console.log(flags.has('--json') ? JSON.stringify(script, null, 2) : scriptText(script, d));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
