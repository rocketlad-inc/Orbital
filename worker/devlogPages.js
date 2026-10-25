// ============================================================
// A devlog post's own page, /devlog/<slug>, for crawlers and link
// previews: the app's page wearing this post's title, description and
// canonical, with the post itself as plain HTML in #seo-page (the copy
// scripts/prerender-pages.mjs puts there for the other pages; people
// never see it, src/index.tsx removes it before React renders the post).
//
// Rendered from the database on request rather than at build time, so a
// post published from the admin page is readable the moment it is
// published, not at the next deploy. /devlog/* and /sitemap.xml are in
// run_worker_first (wrangler.jsonc).
//
// The body is the stored HTML, which worker/devlog.js sanitised on write
// against its allow-list; everything else is escaped here.
// ============================================================

const SITE = 'https://orbital-empire.com';

export const DEVLOG_PAGE_RE = /^\/devlog\/([a-z0-9][a-z0-9-]{0,63})\/?$/;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "21 October 2026" -> ISO date, else the row's own timestamp. */
function isoDate(display, fallbackMs) {
  const t = Date.parse(display);
  const ms = Number.isFinite(t) ? t : Number(fallbackMs) || 0;
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null;
}

function postMarkup(post, others) {
  const more = others.map(p =>
    `<li><a href="/devlog/${esc(p.slug)}">${esc(p.title)}</a> <span class="cl-more-date">${esc(p.date)}</span></li>`).join('');
  return `<nav class="seo-nav" aria-label="Site"><a href="/">Orbital</a> <a href="/how-to-play">How to play</a> <a href="/changelog">Devlog</a></nav>`
    + `<main><div class="cl"><div class="cl-hero"><div class="cl-eyebrow"><a href="/changelog">— DEVLOG</a></div>`
    + `<h1 class="cl-title">${esc(post.title)}</h1><div class="cl-date">${esc(post.date)}</div>`
    + `<div class="cl-lede">${esc(post.lede)}</div></div>`
    + `<article class="cl-body">${post.html ?? ''}</article>`
    + `<p class="cl-cta"><a href="/">Play Orbital free in your browser</a></p>`
    + (more ? `<nav class="cl-more" aria-label="More from the devlog"><div class="cl-eyebrow">MORE FROM THE DEVLOG</div><ul>${more}</ul></nav>` : '')
    + `</div></main>`;
}

/** The app's page for /devlog/<slug>, wearing this post. */
export async function handleDevlogPage(req, env, slug) {
  // A fresh request for the shell: a forwarded If-None-Match could earn a
  // bodiless 304, and there would be nothing to rewrite.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', req.url)));
  const post = await env.DB.prepare(
    'SELECT slug, title, date, lede, html, created_at_ms, updated_at_ms FROM devlog_posts WHERE slug = ? AND published = 1',
  ).bind(slug).first();
  if (!post || typeof HTMLRewriter === 'undefined') {
    // The app still renders (it shows the whole devlog for an unknown
    // post); the status tells crawlers there is no such page.
    return new Response(shell.body, { status: post ? 200 : 404, headers: shell.headers });
  }
  const others = (await env.DB.prepare(
    `SELECT slug, title, date FROM devlog_posts WHERE published = 1 AND slug != ?
      ORDER BY sort_index DESC, created_at_ms DESC LIMIT 20`,
  ).bind(slug).all()).results ?? [];

  const title = `${post.title} — Orbital devlog`;
  const description = post.lede || `${post.title}: an update to Orbital, the free real-time space strategy game.`;
  const url = `${SITE}/devlog/${post.slug}`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description,
    url,
    mainEntityOfPage: url,
    datePublished: isoDate(post.date, post.created_at_ms),
    dateModified: isoDate('', post.updated_at_ms) ?? isoDate(post.date, post.created_at_ms),
    image: `${SITE}/og-card-v2.jpg`,
    author: { '@type': 'Organization', name: 'Orbital', url: `${SITE}/` },
    publisher: { '@type': 'Organization', name: 'Orbital', url: `${SITE}/` },
    about: { '@type': 'VideoGame', name: 'Orbital', url: `${SITE}/` },
  };
  // "</" cannot appear inside the script element.
  const ldJson = JSON.stringify(ld).replace(/</g, '\\u003c');

  const set = (value) => ({ element(el) { el.setAttribute('content', value); } });
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:type"]', set('article'))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[property="og:url"]', set(url))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[name="twitter:description"]', set(description))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', url); } })
    // The home page's structured data (the game, its FAQ) is not this page's.
    .on('script[type="application/ld+json"]', { element(el) { el.remove(); } })
    .on('head', { element(el) { el.append(`<script type="application/ld+json">${ldJson}</script>`, { html: true }); } })
    .on('#seo-page', { element(el) { el.setInnerContent(postMarkup(post, others), { html: true }); } })
    .transform(shell);
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'public, max-age=300');
  return new Response(out.body, { status: 200, headers });
}

/** The static sitemap (public/sitemap.xml) plus every published post. */
export async function handleSitemap(req, env) {
  const base = await env.ASSETS.fetch(new Request(new URL('/sitemap.xml', req.url)));
  const xml = await base.text();
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT slug, date, created_at_ms, updated_at_ms FROM devlog_posts WHERE published = 1
        ORDER BY sort_index DESC, created_at_ms DESC`,
    ).all()).results ?? [];
  } catch (e) {
    console.error('sitemap: devlog posts failed', e);
  }
  const urls = rows.map(r => {
    const mod = isoDate('', r.updated_at_ms) ?? isoDate(r.date, r.created_at_ms);
    return `  <url><loc>${SITE}/devlog/${esc(r.slug)}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}<changefreq>monthly</changefreq><priority>0.6</priority></url>\n`;
  }).join('');
  const body = xml.includes('</urlset>') ? xml.replace('</urlset>', `${urls}</urlset>`) : xml;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
