#!/usr/bin/env node
// ============================================================
// PRERENDER THE LANDING PAGES, for crawlers that run no JavaScript.
//
// The site is one React shell, so every URL used to answer with the same
// 566 characters of text: to ChatGPT's search crawler (and Bing's, which
// it leans on) /how-to-play and /changelog did not exist. ChatGPT already
// sends players who take seats; it can only recommend what it can read.
//
// After `react-scripts build`, this renders each landing page with the
// site's own components and English catalog (scripts/prerender/render.tsx)
// and writes it into a copy of the built shell:
//
//   build/index.html          /            (also the SPA fallback)
//   build/how-to-play.html    /how-to-play (assets serve /x from x.html)
//   ...one per page, the answer pages included
//
// Each copy gets its own <title>, description, social tags and canonical,
// and the page text in <div id="seo-page">. People never see that copy:
// a head script marks <html class="js"> and CSS hides it before first
// paint, and src/index.tsx removes it before React renders.
//
// The changelog comes from the live devlog (/api/devlog), so posts
// published without a deploy are in it; the compiled seed posts are the
// fallback when that cannot be reached.
//
// Also writes build/llms.txt (https://llmstxt.org): a plain-text summary
// of the game with links, for AI assistants.
// ============================================================

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const SITE = 'https://orbital-empire.com';
const require = createRequire(import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function loadRenderer() {
  const esbuild = require('esbuild');
  const outfile = path.join(ROOT, 'node_modules', '.cache', 'prerender', 'render.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'scripts', 'prerender', 'render.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.webp': 'empty' },
    external: ['react', 'react-dom'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  delete require.cache[outfile];
  return require(outfile);
}

/** Live devlog posts, or null. Never fails the build. */
async function livePosts() {
  try {
    const res = await fetch(`${SITE}/api/devlog`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const rows = (await res.json())?.posts;
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch {
    return null;
  }
}

function changelogMarkup(posts) {
  const [newest, ...older] = posts;
  const body = (html) => `<div class="cl-body">${html}</div>`;
  return `<div class="cl"><div class="cl-hero"><div class="cl-eyebrow">— DEVLOG</div>`
    + `<h1 class="cl-title">${esc(newest.title)}</h1><div class="cl-date">${esc(newest.date)}</div>`
    + `<div class="cl-lede">${esc(newest.lede)}</div></div>${body(newest.html)}`
    + older.map(p => `<section class="cl-post" id="${esc(p.slug)}"><div class="cl-post-head">`
      + `<div class="cl-eyebrow">— EARLIER</div><h2 class="cl-post-title">${esc(p.title)}</h2>`
      + `<div class="cl-date">${esc(p.date)}</div><div class="cl-post-lede">${esc(p.lede)}</div></div>`
      + `${body(p.html)}</section>`).join('')
    + `</div>`;
}

/** Site links, so a crawler landing on any page can reach every other. */
function navMarkup(pages) {
  const link = (p) => `<a href="${p.path}">${esc(p.label)}</a>`;
  return `<nav class="seo-nav" aria-label="Site">${pages.map(link).join(' ')}</nav>`;
}

function setMeta(html, attr, name, value) {
  const re = new RegExp(`(<meta ${attr}="${name}" content=")[^"]*(")`);
  if (!re.test(html)) throw new Error(`prerender: shell has no <meta ${attr}="${name}">`);
  return html.replace(re, `$1${esc(value)}$2`);
}

function pageHtml(shell, { path: p, title, description, body, nav, keepFaq }) {
  const url = `${SITE}${p}`;
  let html = shell.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  html = setMeta(html, 'name', 'description', description);
  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', description);
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'name', 'twitter:title', title);
  html = setMeta(html, 'name', 'twitter:description', description);
  // The FAQ structured data belongs to the page that shows the FAQ.
  if (!keepFaq) html = html.replace(/<script type="application\/ld\+json">\{"@context": ?"https:\/\/schema\.org", ?"@type": ?"FAQPage"[\s\S]*?<\/script>/, '');
  const head = `<link rel="canonical" href="${url}">`
    + `<script>document.documentElement.classList.add('js')</script>`
    // Without scripts the app's scroll lock (html/body overflow: hidden)
    // would pin a reader to the first screen.
    + `<style>.js .seo-page{display:none}html:not(.js),html:not(.js) body{overflow:auto!important;height:auto!important}.seo-nav{display:flex;flex-wrap:wrap;gap:8px 20px;max-width:1100px;margin:0 auto;padding:16px;font-family:'Chakra Petch',system-ui,sans-serif}.seo-nav a{color:#ffb84d}</style>`;
  if (!html.includes('</head>')) throw new Error('prerender: shell has no </head>');
  html = html.replace('</head>', `${head}</head>`);
  // The old no-JS note repeated the home page; the page itself is here now.
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, '<noscript><p style="text-align:center;font-family:system-ui,sans-serif;color:#aebccb">Orbital runs in your browser. Turn on JavaScript to play.</p></noscript>');
  // Nothing in the hidden copy may download for people: the live page
  // loads its own images. Lazy images inside display:none never load.
  const quiet = body.replace(/loading="eager"/g, 'loading="lazy"').replace(/ fetchpriority="high"/g, '');
  const block = `<div id="seo-page" class="seo-page">${nav}<main>${quiet}</main>${nav}</div>`;
  if (!html.includes('<div id="root"></div>')) throw new Error('prerender: shell has no empty #root');
  return html.replace('<div id="root"></div>', `${block}<div id="root"></div>`);
}

function llmsTxt({ ANSWER_PAGES, PAGE_META, FAQ, posts }) {
  const strip = (s) => s.replace(/<[^>]+>/g, '');
  const lines = [
    '# Orbital',
    '',
    `> ${PAGE_META.about.description} Free to play in any modern browser at ${SITE}/, with no download and no ads.`,
    '',
    'Orbital (also searched for as "Orbital Empire") is a persistent multiplayer space strategy game for two to ten players, set across the real solar system. Ticks resolve on the server on a real clock, one an hour by default (hosts choose anything from a tick a minute to a tick a day), so a game runs for days or weeks and keeps going while players are offline. Players build and terraform colonies, design warships, trade, pass laws in a Senate, and win by Domination (more than 60% of the worlds), by election as Supreme Chancellor, or by building a Dyson Sphere around the Sun. Every game starts at peace; war is declared.',
    '',
    '## Play',
    '',
    `- [Play Orbital](${SITE}/): sign in with Google or email; Quick Join drops you into the fullest open game`,
    `- [How to play](${SITE}/how-to-play): ${PAGE_META.howto.description}`,
    '',
    '## Questions',
    '',
    ...ANSWER_PAGES.map(p => `- [${p.h1}](${SITE}${p.path}): ${p.description}`),
    '',
    '## FAQ',
    '',
    ...FAQ.flatMap(([q, a]) => [`### ${q}`, '', a, '']),
    '## News',
    '',
    `- [Changelog](${SITE}/changelog): ${PAGE_META.changelog.description}`,
    ...posts.slice(0, 5).map(p => `- [${strip(p.title)}](${SITE}/changelog#${p.slug}) (${p.date}): ${strip(p.lede)}`),
    '',
    '## Optional',
    '',
    `- [Press kit](${SITE}/press): ${PAGE_META.press.description}`,
    `- [Credits](${SITE}/credits)`,
    `- [Privacy](${SITE}/privacy)`,
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const shellPath = path.join(BUILD, 'index.html');
  const shell = fs.readFileSync(shellPath, 'utf8');
  if (shell.includes('id="seo-page"')) throw new Error('prerender: build/index.html is already prerendered; rebuild first');

  const { renderPages, ANSWER_PAGES, SEED_POSTS, FAQ, PAGE_META, DOC_PATH } = await loadRenderer();
  const bodies = renderPages();
  const live = await livePosts();
  const posts = live ?? SEED_POSTS;
  bodies['/changelog'] = changelogMarkup(posts);

  const docs = [
    ['about', 'The game'], ['howto', 'How to play'], ['changelog', 'Changelog'],
    ['press', 'Press kit'], ['privacy', 'Privacy'], ['credits', 'Credits'],
  ].map(([tab, label]) => ({ path: DOC_PATH[tab], label, ...PAGE_META[tab] }));
  const answers = ANSWER_PAGES.map(p => ({ path: p.path, label: p.label, title: p.title, description: p.description }));
  const all = [...docs, ...answers];
  const nav = navMarkup(all);

  for (const page of all) {
    const body = bodies[page.path];
    if (!body) throw new Error(`prerender: nothing rendered for ${page.path}`);
    const html = pageHtml(shell, { ...page, body, nav, keepFaq: page.path === '/' });
    const file = page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`;
    fs.writeFileSync(path.join(BUILD, file), html);
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
    console.log(`prerender: ${page.path.padEnd(36)} ${file.padEnd(40)} ${text} chars of text`);
  }
  fs.writeFileSync(path.join(BUILD, 'llms.txt'), llmsTxt({ ANSWER_PAGES, PAGE_META, FAQ, posts }));
  console.log(`prerender: llms.txt; changelog from ${live ? 'the live devlog' : 'the seed posts (devlog unreachable)'}, ${posts.length} posts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
