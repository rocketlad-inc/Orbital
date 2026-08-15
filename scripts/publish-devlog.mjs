// ============================================================
// publish-devlog — push an authored post into the LIVE devlog table.
//
//   node scripts/publish-devlog.mjs <slug> <body.html> [lede.txt] [--title "..."] [--date "..."]
//
// Normally posts are written in the admin editor, which is the whole
// point of the devlog service. This exists for the one case the editor
// cannot cover: replacing a post's body wholesale from a file that was
// authored in the repo (a long article, drafted and reviewed as a diff)
// without hand-pasting several kilobytes into a textarea.
//
// It writes SQL for `wrangler d1 execute` rather than calling the admin
// API, because the API needs an admin session cookie and this runs from
// a terminal.
//
// THE BODY IS RUN THROUGH THE REAL SANITISER FIRST. A direct D1 write
// bypasses the API, so without this the file could store markup the
// editor itself would have refused — and the invariant "everything in
// devlog_posts.html has been sanitised" would quietly stop being true.
// Same function, same allow-list, no second implementation to drift.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeHtml } from '../worker/devlog.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const positional = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const [slug, htmlPath, ledePath] = positional;
if (!slug || !htmlPath) {
  console.error('usage: publish-devlog.mjs <slug> <body.html> [lede.txt] [--title "..."] [--date "..."] [--out file.sql]');
  process.exit(1);
}

const rawHtml = fs.readFileSync(htmlPath, 'utf8');
const html = sanitizeHtml(rawHtml);
const lede = ledePath && fs.existsSync(ledePath)
  ? fs.readFileSync(ledePath, 'utf8').trim()
  : null;

// Report what the sanitiser removed. Silence here would be the bug: an
// author whose figure placeholder was stripped needs to hear about it
// before the post is live, not after.
const dropped = rawHtml.length - html.length;
console.log(`body: ${rawHtml.length} chars in, ${html.length} out` +
  (dropped ? ` (${dropped} stripped by the sanitiser — check this is what you expected)` : ' (nothing stripped)'));
const figs = [...html.matchAll(/class="(fig-[a-z-]+)"/g)].map(m => m[1]);
console.log(`figures kept: ${figs.length ? figs.join(', ') : '(none)'}`);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const sets = [
  `html = ${q(html)}`,
  `updated_at_ms = ${Date.now()}`,
];
if (lede) sets.push(`lede = ${q(lede)}`);
if (flag('title')) sets.push(`title = ${q(flag('title'))}`);
if (flag('date')) sets.push(`date = ${q(flag('date'))}`);

const sql = `UPDATE devlog_posts SET ${sets.join(', ')} WHERE slug = ${q(slug)};\n`;
const out = flag('out') ?? path.join(path.dirname(htmlPath), `publish-${slug}.sql`);
fs.writeFileSync(out, sql, 'utf8');
console.log(`\nwrote ${out}`);
console.log('apply with:');
console.log(`  npx wrangler d1 execute orbital --remote --file "${out}"`);
