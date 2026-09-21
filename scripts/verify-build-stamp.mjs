// ============================================================
// verify-build-stamp — refuse to upload a build that disagrees with
// itself about which commit it is.
//
// Runs from wrangler's build hook, AFTER `npm run build`, so it is the
// last thing between a build and `wrangler versions upload`.
//
// WHY. Every Claude session deploys from the one shared main checkout.
// On 2026-09-21 two sessions built there at once: one fast-forwarded to
// 2c953f28 and started compiling; the other fast-forwarded to 4586b995
// and regenerated the version stamps underneath it. The version that
// shipped had a worker stamped 4586b99 and a client bundle compiled
// from 2c953f2 — so the "a newer build is live" banner appeared for
// every player and NO reload could clear it, because the server really
// was handing out a bundle older than itself. ("The reload box wont go
// away, no matter how much I reload.")
//
// Four things must name the same commit, or the upload stops:
//   git HEAD · worker/_version.js · src/_version.ts · the compiled bundle
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const shaIn = (text) => (text.match(/GIT_SHA\s*=\s*"([0-9a-f]{40})"/) ?? [])[1] ?? null;

const found = {};
try { found.head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
catch { found.head = null; }
found.worker = shaIn(read('worker/_version.js'));
found.client = shaIn(read('src/_version.ts'));

// The bundle the shell ACTUALLY loads — read from index.html rather than
// globbing build/static, so a leftover file from an older build can
// never be the one that gets checked.
try {
  const html = read('build/index.html');
  const main = (html.match(/\/static\/js\/(main\.[0-9a-f]+\.js)/) ?? [])[1];
  const js = main ? read(path.join('build/static/js', main)) : '';
  found.bundle = [found.head, found.worker, found.client]
    .find((s) => s && js.includes(`"${s}"`)) ?? (js ? 'none of the above' : null);
} catch { found.bundle = null; }

const shas = Object.values(found);
const agree = shas.every((s) => s && s === found.head);

if (!agree) {
  const s = (v) => (!v ? 'MISSING' : /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 8) : v);
  console.error('');
  console.error('  ✖ UPLOAD BLOCKED — this build disagrees with itself about which commit it is');
  console.error('');
  console.error(`      git HEAD          ${s(found.head)}`);
  console.error(`      worker stamp      ${s(found.worker)}`);
  console.error(`      client stamp      ${s(found.client)}`);
  console.error(`      compiled bundle   ${s(found.bundle)}`);
  console.error('');
  console.error('    Almost always: another session built or fast-forwarded in this');
  console.error('    same checkout while this build was running. Shipping it would');
  console.error('    show every player a "newer build is live" banner that no reload');
  console.error('    can clear. Wait for the other build to finish, then run the');
  console.error('    upload again — it rebuilds from scratch.');
  console.error('');
  process.exit(1);
}

console.log(`[verify-build-stamp] ${found.head.slice(0, 8)} everywhere ✓`);
