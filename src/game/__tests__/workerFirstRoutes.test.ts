// ============================================================
// Every public Worker route must be in run_worker_first.
//
// THE FAILURE THIS CATCHES IS INVISIBLE. Cloudflare serves static
// assets before the Worker for any path NOT listed in
// assets.run_worker_first, and not_found_handling is
// single-page-application — so an unlisted route does not 404. It
// returns index.html with a 200 and content-type text/html. The Worker
// handler never runs, no error is logged, and from the outside it looks
// like a working endpoint serving the wrong body.
//
// wrangler.jsonc already carried a comment warning about exactly this
// and a route still shipped without its entry, which is the argument
// for a test rather than a paragraph.
//
// Only routes matched on url.pathname inside index.js count: those are
// the ones that bypass the /api gate and therefore need their own
// prefix. Feature-module routes all live under /api/*, which is listed.
// ============================================================

import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..', '..', '..');

/** The prefixes Cloudflare will hand to the Worker before the assets. */
function runWorkerFirst(): string[] {
  const src = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  const out = new Set<string>();
  // Read every occurrence, so an environment block that drifts from the
  // top-level one is caught rather than averaged over.
  for (const m of src.matchAll(/"run_worker_first"\s*:\s*\[([^\]]*)\]/g)) {
    for (const p of m[1].matchAll(/"([^"]+)"/g)) out.add(p[1]);
  }
  return [...out];
}

/** How many times run_worker_first appears — every environment needs it. */
function occurrences(): number {
  const src = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  return [...src.matchAll(/"run_worker_first"\s*:/g)].length;
}

/** `/^\/widget\/([A-Za-z0-9_-]+)\.png$/` → `widget` */
function leadingSegment(reSource: string): string | null {
  const m = reSource.match(/^\^\\\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

describe('public worker routes', () => {
  const index = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');

  // Every `url.pathname.match(mod.SOME_RE)` in index.js.
  const referenced = [...index.matchAll(/url\.pathname\.match\(\s*([A-Za-z_$][\w$]*)\.([A-Z][A-Z0-9_]*)\s*\)/g)]
    .map(m => ({ mod: m[1], name: m[2] }));

  it('finds the pathname-matched routes at all', () => {
    // A guard on the guard: if index.js is refactored so this scan stops
    // matching, the test below would pass vacuously forever.
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('every pathname-matched route has a run_worker_first prefix', () => {
    const prefixes = runWorkerFirst();
    const workerDir = path.join(root, 'worker');
    const sources = fs.readdirSync(workerDir)
      .filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(workerDir, f), 'utf8'))
      .join('\n');

    const missing: string[] = [];
    for (const { name } of referenced) {
      const def = sources.match(new RegExp(`export const ${name}\\s*=\\s*(/[^;]+/)\\s*;`));
      if (!def) continue;                       // not a literal regex; skip
      const seg = leadingSegment(def[1].slice(1, -1));
      if (!seg) continue;
      const covered = prefixes.some(p => p === `/${seg}/*` || p === `/${seg}*` || p === `/${seg}`);
      if (!covered) missing.push(`${name} needs "/${seg}/*" in run_worker_first`);
    }
    expect(missing).toEqual([]);
  });

  it('every environment declares run_worker_first', () => {
    // A staging block that quietly lacks it would serve the SPA shell for
    // these routes there and nowhere else — the worst kind of drift,
    // because prod would look fine.
    expect(occurrences()).toBeGreaterThanOrEqual(2);
  });
});
