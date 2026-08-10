#!/usr/bin/env node
// ============================================================================
// agent.mjs — call the Orbital API as an agent player, without anyone
// having to paste a credential into a chat window every month.
//
// THE PROBLEM THIS SOLVES. Agent sessions last 30 days, so the old flow
// was "Lorne runs a curl, pastes the token to Claude, Claude uses it" —
// once a month, plus every time a session got lost. That is friction for
// him and it puts a live credential in a transcript.
//
// THE SHAPE. The secret lives in ONE local file that git cannot see, and
// nothing ever prints it — not the key, not the minted token. This script
// reads it, mints (and caches) a session, makes the call, and prints only
// the API's response. So a credential never enters a command line, a
// shell history, or a conversation.
//
// SETUP — once, ever:
//   echo "AGENT_KEY=<the key you set with wrangler secret put>" > .agent.local
// or, if you would rather not have the minting key on disk, paste a token
// you minted yourself and it will be used until it expires:
//   echo "AGENT_TOKEN=<token>" > .agent.local
//
// USAGE:
//   node scripts/agent.mjs GET  /api/games/<id>/state
//   node scripts/agent.mjs POST /api/games/<id>/senate/proposals/<pid>/vote '{"vote":"yea"}'
//   node scripts/agent.mjs whoami
//
// The cached session is written to .agent.session (also git-ignored) and
// reused until it is inside its last day, so repeated calls mint nothing.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRED = path.join(ROOT, '.agent.local');
const CACHE = path.join(ROOT, '.agent.session');
const BASE = process.env.ORBITAL_BASE || 'https://orbital-empire.com';
const HANDLE = process.env.ORBITAL_AGENT_HANDLE || 'claude';

class Fail extends Error {}
/** Abort with a message. THROWS rather than calling process.exit(): on
 *  Windows, exiting while a fetch's libuv handles are still closing trips
 *  an UV_HANDLE_CLOSING assertion and the process aborts with a C-level
 *  stack trace instead of the error you wrote. Caught at the bottom. */
function die(msg) { throw new Fail(msg); }

/** Parse KEY=value lines. Never logged, never returned wholesale. */
function readCreds() {
  if (!fs.existsSync(CRED)) {
    die(`No credential file.\n\n`
      + `  Create ${path.relative(ROOT, CRED)} with ONE of:\n`
      + `    AGENT_KEY=<the AGENT_KEY secret>     (mints sessions forever)\n`
      + `    AGENT_TOKEN=<a session token>        (works until it expires)\n\n`
      + `  It is git-ignored. Nothing here is ever printed.`);
  }
  const out = {};
  for (const line of fs.readFileSync(CRED, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function mint(key) {
  const res = await fetch(`${BASE}/api/agent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Agent-Key': key },
    body: JSON.stringify({ handle: HANDLE }),
  });
  if (res.status === 404) {
    // The endpoint 404s for BOTH "secret unset" and "wrong key" on
    // purpose — it never confirms it exists. So this message has to name
    // both causes rather than guess.
    die('404 from /api/agent/session — either AGENT_KEY is unset on the '
      + 'Worker, or the key in .agent.local does not match it. '
      + '(The endpoint deliberately cannot tell you which.)');
  }
  if (!res.ok) die(`Mint failed: HTTP ${res.status}`);
  const j = await res.json();
  const all = readCache();
  all[HANDLE] = { token: j.token, expires_at: j.expires_at };
  fs.writeFileSync(CACHE, JSON.stringify(all), 'utf8');
  return j.token;
}

/**
 * Cached sessions, KEYED BY HANDLE.
 *
 * The cache was a single unkeyed blob, which is fine for one agent and
 * silently wrong for two: running with ORBITAL_AGENT_HANDLE=rival would
 * hand back the cached `claude` token, so both "agents" would act as the
 * same player and a multi-agent test would look like it passed while
 * testing nothing. Keyed per handle now.
 */
function readCache() {
  if (!fs.existsSync(CACHE)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    // Tolerate the old single-session shape rather than throwing on it.
    return j && typeof j === 'object' && !j.token ? j : {};
  } catch { return {}; }
}

function cached() {
  const entry = readCache()[HANDLE];
  // Re-mint inside the last day rather than at the boundary, so a long
  // task cannot have its session die halfway through.
  if (entry?.token && entry.expires_at && entry.expires_at - Date.now() > 24 * 3600 * 1000) {
    return entry.token;
  }
  return null;
}

async function token() {
  const hit = cached();
  if (hit) return hit;
  const creds = readCreds();
  if (creds.AGENT_KEY) return mint(creds.AGENT_KEY);
  if (creds.AGENT_TOKEN) return creds.AGENT_TOKEN;
  die('.agent.local has neither AGENT_KEY nor AGENT_TOKEN.');
}

/**
 * Undo Git Bash's path mangling.
 *
 * MSYS rewrites any argument that looks like a POSIX path into a Windows
 * one, so `/api/users/me/rooms` arrives as
 * `C:/Program Files/Git/api/users/me/rooms` and the URL becomes
 * `https://orbital-empire.comC:/...` — which fails DNS on the nonsense
 * host `orbital-empire.comc` and reads like a server problem. Rather than
 * make every caller remember MSYS_NO_PATHCONV=1, recover the real path:
 * anything from the first `/api/` onward is what was meant.
 */
function normalizePath(p) {
  if (!p) return p;
  const i = p.indexOf('/api/');
  if (i > 0) return p.slice(i);              // strip an injected prefix
  return p.startsWith('/') ? p : `/${p}`;    // tolerate 'api/...' too
}

async function main() {
  const [, , methodRaw, pathRaw, bodyRaw] = process.argv;
  if (!methodRaw) die('usage: node scripts/agent.mjs <METHOD> <path> [json]  |  whoami');

  const tok = await token();

  const apiPath = normalizePath(pathRaw);
  const url = methodRaw === 'whoami' ? `${BASE}/api/auth/me` : `${BASE}${apiPath ?? ''}`;
  if (methodRaw !== 'whoami' && !pathRaw) {
    die('usage: node scripts/agent.mjs <METHOD> <path> [json]');
  }

  const res = await fetch(url, {
    method: methodRaw === 'whoami' ? 'GET' : methodRaw.toUpperCase(),
    headers: {
      authorization: `Bearer ${tok}`,
      ...(bodyRaw ? { 'content-type': 'application/json' } : {}),
    },
    ...(bodyRaw ? { body: bodyRaw } : {}),
  });
  const text = await res.text();
  console.log(res.status);
  console.log(text);
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Fail ? e.message : e);
  process.exitCode = 1;
});
