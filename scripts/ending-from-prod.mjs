#!/usr/bin/env node
// ============================================================================
// Build the end-of-game payload for a REAL finished game, from PRODUCTION data.
//
//   node scripts/ending-from-prod.mjs <gameId> [--as=<factionId|none>] [--out=<file>]
//
// It runs the very same buildEnding() the endpoint runs (worker/ending.js),
// against a tiny `env.DB` adapter that forwards each statement to
//
//   wrangler d1 execute orbital --remote --json --command "<sql, params inlined>"
//
// READ-ONLY by construction: the adapter refuses anything that does not start
// with SELECT or WITH, anything with a second statement, and has no run() at
// all. Nothing here can write to production.
//
//   --as=<factionId>  the viewer's empire (isMe). Default: the game's winner,
//                     so the isMe path is exercised. --as=none: nobody.
//   --out=<file>      default src/multiplayer/__fixtures__/ending.<gameId>.json
//
// Uses the already-installed local wrangler (authenticated for the production
// account). Windows ARM64 note: do NOT npm install; this script only spawns
// `node <repo>/node_modules/wrangler/bin/wrangler.js`.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnding } from '../worker/ending.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..');

function findWrangler() {
  // In a worktree the dependencies live in the main checkout, three levels up
  // (<root>/.claude/worktrees/<name>); in the main checkout they are local.
  const candidates = [
    path.join(repoDir, 'node_modules/wrangler/bin/wrangler.js'),
    path.resolve(repoDir, '../../../node_modules/wrangler/bin/wrangler.js'),
  ];
  const hit = candidates.find(existsSync);
  if (!hit) throw new Error(`wrangler not found; looked in:\n  ${candidates.join('\n  ')}`);
  return hit;
}
const WRANGLER = findWrangler();

/** Replace each `?` outside a quoted string with the next value, escaped. */
export function inlineParams(sql, args) {
  let out = '';
  let i = 0;
  let a = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '?') {
      if (a >= args.length) throw new Error('more ? placeholders than bound values');
      const v = args[a++];
      if (v === null || v === undefined) out += 'NULL';
      else if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new Error('non-finite number bound');
        out += String(v);
      } else if (typeof v === 'boolean') out += v ? '1' : '0';
      else if (typeof v === 'string') out += `'${v.replace(/'/g, "''")}'`;
      else throw new Error(`cannot inline a ${typeof v}`);
      i++;
    } else { out += c; i++; }
  }
  if (a !== args.length) throw new Error('more bound values than ? placeholders');
  return out;
}

export function assertReadOnly(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (!/^(SELECT|WITH)\b/i.test(flat)) throw new Error(`refusing non-SELECT statement: ${flat.slice(0, 60)}`);
  // A literal ';' inside a quoted value is fine; a bare one would be a second statement.
  const unquoted = flat.replace(/'(?:[^']|'')*'/g, "''");
  if (/;\s*\S/.test(unquoted)) throw new Error('refusing multi-statement SQL');
  return flat.replace(/;\s*$/, '');
}

function remoteSelect(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'orbital', '--remote', '--json', '--command', sql],
    { cwd: repoDir, maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
  let parsed;
  try { parsed = JSON.parse(out); } catch {
    parsed = JSON.parse(out.slice(out.indexOf('[')));   // tolerate a banner line
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(`D1 error for: ${sql.slice(0, 80)}`);
  return { success: true, results: first?.results ?? [], meta: first?.meta ?? {} };
}

class ReadOnlyStatement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new ReadOnlyStatement(this.sql, args); }
  _run() { return remoteSelect(assertReadOnly(inlineParams(this.sql, this.args))); }
  async all() { return this._run(); }
  async first(col) {
    const row = this._run().results[0] ?? null;
    return col === undefined ? row : (row ? row[col] : null);
  }
  // No run(): this adapter cannot write.
}

export const prodEnv = {
  DB: {
    prepare: (sql) => new ReadOnlyStatement(sql),
    /** Statements run one at a time; each is individually checked. */
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  },
};

/** Pretty JSON, but numeric arrays stay on one line (a series is 100+ numbers). */
function stringify(payload) {
  return JSON.stringify(payload, null, 2)
    .replace(/\[\s+(-?[\d.eE+]+(?:,\s+-?[\d.eE+]+)*)\s+\]/g, (_m, body) => `[${body.replace(/\s+/g, '')}]`)
    + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const gameId = args.find(a => !a.startsWith('--'));
  if (!gameId || !/^[A-Za-z0-9_-]{6,32}$/.test(gameId)) {
    console.error('usage: node scripts/ending-from-prod.mjs <gameId> [--as=<factionId|none>] [--out=<file>]');
    process.exit(2);
  }
  const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  let as = flag('as');
  if (as === undefined) {
    const g = await prodEnv.DB.prepare('SELECT winner_faction_id AS w FROM games WHERE id = ?').bind(gameId).first();
    as = g?.w ?? 'none';
  }
  const asFactionId = as === 'none' ? null : as;
  const payload = await buildEnding(prodEnv, gameId, null, { asFactionId, skipMembership: true });
  if (payload.error) {
    console.error(`cannot build: ${payload.error.status} ${payload.error.code} ${payload.error.message}`);
    process.exit(1);
  }
  const out = flag('out') ?? path.join(repoDir, 'src/multiplayer/__fixtures__', `ending.${gameId}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, stringify(payload));
  console.log(`wrote ${out}`);
  console.log(`${payload.game.name}: ${payload.factions.length} empires, ${payload.awards.length} awards, `
    + `${payload.series.ticks.length} series points, viewer=${asFactionId ?? 'nobody'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
