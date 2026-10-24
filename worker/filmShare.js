// ============================================================================
// filmShare.js — what a match film link looks like where people paste it.
//
// The battle recap's twin (worker/recapShare.js), for the whole-match film.
// A /film/<token> link unfurled as the site's generic advert; now it shows
// the match it holds: its name, who won and how, how long it ran, who was in
// it, and what it cost.
//
//   GET /film/<token>            the app's page, with this match in its
//                                Open Graph / Twitter tags (HTMLRewriter)
//   GET /film/<token>/card.png   1200x630: the match's title card
//
// /film/* is in run_worker_first (wrangler.jsonc). Nothing here counts a
// view: crawlers fetch these, and the film's own /api/film call counts the
// people.
// ============================================================================

import {
  createSurface, fillRect, fillCircle, fillRadial, drawText, textWidth,
  encodePng, hexToRgb, drawLine,
} from './heraldPng.js';

const SITE = 'https://orbital-empire.com';
export const FILM_PAGE_RE = /^\/film\/([A-Za-z0-9_-]{8,64})\/?$/;
export const FILM_CARD_RE = /^\/film\/([A-Za-z0-9_-]{8,64})\/card\.png$/;

/** How a match was won, in a few plain words. */
const HOW = {
  engineering: 'built a Dyson Sphere',
  chancellor: 'was elected Chancellor',
  senate: 'won the Senate',
  annihilation: 'outlasted every rival',
  domination: 'conquered the system',
  hegemony: 'held the system',
  political: 'won the vote',
  last_standing: 'was the last empire standing',
};

/** Everything the preview needs about one shared match, or null. */
export async function filmSummary(env, token) {
  const row = await env.DB
    .prepare(
      `SELECT s.token, g.id AS game_id, g.status, g.victory_type, g.winner_faction_id,
              g.current_tick, r.name AS game_name
         FROM match_shares s
         JOIN games g ON g.id = s.game_id
         LEFT JOIN rooms r ON r.id = g.id
        WHERE s.token = ? AND s.revoked_at_ms IS NULL`,
    )
    .bind(token).first();
  if (!row) return null;
  const factions = (await env.DB
    .prepare(
      `SELECT id, name, color, status FROM game_factions
        WHERE game_id = ? AND id NOT LIKE '%:leviathan_f'
        ORDER BY (id = ?) DESC, status = 'eliminated', name`,
    )
    .bind(row.game_id, row.winner_faction_id ?? '').all()).results ?? [];
  const war = await env.DB
    .prepare('SELECT COUNT(*) AS battles, COALESCE(SUM(ships_lost), 0) AS lost FROM battles WHERE game_id = ?')
    .bind(row.game_id).first();
  const winner = factions.find(f => f.id === row.winner_faction_id) ?? null;
  return {
    token,
    gameName: row.game_name || 'An Orbital match',
    days: Math.max(0, Number(row.current_tick) || 0),
    finished: row.status === 'completed',
    how: HOW[row.victory_type] ?? null,
    winner: winner ? { name: winner.name, color: winner.color } : null,
    empires: factions.map(f => ({ name: f.name, color: f.color, out: f.status === 'eliminated' })),
    battles: Number(war?.battles) || 0,
    shipsLost: Number(war?.lost) || 0,
  };
}

/** Title, description and alt text for one match. Plain sentences. */
export function filmMeta(sum) {
  const title = sum.winner
    ? `${sum.gameName}: ${sum.winner.name} wins`
    : `${sum.gameName}: the match film`;
  const n = sum.empires.length;
  const parts = [
    sum.winner
      ? `${sum.winner.name} ${sum.how ?? 'won'} after ${sum.days} days`
      : `${n} empires, ${sum.days} days of war`,
    `${n} empire${n === 1 ? '' : 's'}, ${sum.battles} battle${sum.battles === 1 ? '' : 's'}, ${sum.shipsLost} ship${sum.shipsLost === 1 ? '' : 's'} lost`,
  ];
  const description = `${parts.join('. ')}. Watch the whole match as a two-minute film from Orbital, the free space strategy game set in the real solar system.`;
  const alt = `The match film of ${sum.gameName}: ${sum.empires.slice(0, 6).map(e => e.name).join(', ')}${sum.winner ? `; ${sum.winner.name} won` : ''}.`;
  return { title, description, alt };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const W = 1200;
const H = 630;

/** A cheap deterministic starfield, so every card has the same sky. */
function stars(s, seed) {
  let x = seed >>> 0 || 1;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 300; i++) {
    const sx = Math.floor(rnd() * W), sy = Math.floor(rnd() * H);
    const b = 120 + Math.floor(rnd() * 120);
    fillRect(s, sx, sy, rnd() < 0.12 ? 2 : 1, 1, [b, b, Math.min(255, b + 20)], 0.55 + rnd() * 0.4);
  }
}

/** Trim a label to fit a width at a scale. */
function fit(text, scale, maxW) {
  let t = String(text ?? '').toUpperCase();
  if (textWidth(t, scale) <= maxW) return t;
  while (t.length > 2 && textWidth(t + '…', scale) > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** A string's hash, for the sky's seed. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The preview picture: the match's title card, in the film's own look. */
export async function renderFilmCard(sum) {
  const s = createSurface(W, H, [4, 6, 11]);
  stars(s, hash(sum.token));

  // The star the match was fought round, off the right edge, with its
  // empires ringed round it in their colours.
  const scx = 920, scy = 330;
  fillRadial(s, scx, scy, 330, [255, 170, 80], 0.22, 0);
  fillRadial(s, scx, scy, 150, [255, 200, 120], 0.55, 0);
  fillCircle(s, scx, scy, 70, [255, 196, 110], 1);
  fillCircle(s, scx, scy, 54, [255, 226, 160], 1);
  const ring = sum.empires.slice(0, 10);
  ring.forEach((e, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, ring.length)) * Math.PI * 2;
    const r = 150 + (i % 3) * 46;
    const x = scx + Math.cos(a) * r, y = scy + Math.sin(a) * r;
    fillCircle(s, x, y, e.out ? 9 : 13, hexToRgb(e.color), e.out ? 0.45 : 1);
  });
  // Shade the left of the frame so the text always reads.
  for (let x = 0; x < 760; x++) {
    const a = x < 600 ? 0.8 : 0.8 * (1 - (x - 600) / 160);
    fillRect(s, x, 0, 1, H, [4, 6, 11], a);
  }

  const L = 64;
  const textW = 620;
  drawText(s, 'MATCH FILM', L, 58, 3, [255, 200, 120], 0.95);
  const nameScale = textWidth(sum.gameName.toUpperCase(), 8) <= textW ? 8 : 5;
  drawText(s, fit(sum.gameName, nameScale, textW), L, 86, nameScale, [255, 246, 236], 1);
  drawText(s, `${sum.empires.length} EMPIRES · ${sum.days} DAYS`, L, 86 + nameScale * 7 + 18, 2, [190, 185, 200], 0.9);

  // Who was in it: winner first, the fallen dimmed.
  let y = 236;
  const rows = sum.empires.slice(0, 5);
  for (const e of rows) {
    const col = hexToRgb(e.color);
    fillCircle(s, L + 8, y + 10, 8, col, e.out ? 0.5 : 1);
    drawText(s, fit(e.name, 3, 440), L + 28, y, 3, e.out ? [150, 145, 155] : [236, 232, 238], e.out ? 0.8 : 0.97);
    if (e.out) drawText(s, 'OUT', L + textW - 30, y + 2, 2, [255, 120, 110], 0.85, 'right');
    y += 44;
  }
  if (sum.empires.length > rows.length) {
    drawText(s, `+${sum.empires.length - rows.length} MORE`, L + 28, y, 2, [170, 160, 170], 0.85);
  }

  // The verdict.
  const vy = H - 112;
  drawLine(s, L, vy - 16, L + textW, vy - 16, [255, 200, 120], 0.25, 2);
  if (sum.winner) {
    drawText(s, fit(`${sum.winner.name} wins`, 4, textW), L, vy, 4, hexToRgb(sum.winner.color), 1);
    if (sum.how) drawText(s, fit(sum.how, 2, textW), L, vy + 40, 2, [210, 200, 190], 0.9);
  } else {
    drawText(s, sum.finished ? 'NO EMPIRE SURVIVES' : 'THE WAR GOES ON', L, vy, 4, [210, 200, 205], 0.95);
  }

  // The invitation.
  drawText(s, 'WATCH THE FILM', W - 48, H - 62, 3, [255, 200, 120], 1, 'right');
  drawText(s, 'ORBITAL-EMPIRE.COM', W - 48, H - 34, 2, [200, 190, 180], 0.9, 'right');

  return encodePng(s);
}

const CARD_CACHE = new Map();

export async function handleFilmCard(req, env, token) {
  // A PNG drawn in plain JS is real CPU, and every crawler asks for it:
  // the edge cache serves the repeats, the isolate's map a cold edge.
  const edge = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL(req.url).origin + new URL(req.url).pathname);
  if (edge) {
    const hit = await edge.match(key);
    if (hit) return hit;
  }
  const sum = await filmSummary(env, token);
  if (!sum) return new Response('no such film', { status: 404 });
  let png = CARD_CACHE.get(token);
  if (!png) {
    png = await renderFilmCard(sum);
    if (CARD_CACHE.size > 50) CARD_CACHE.delete(CARD_CACHE.keys().next().value);
    CARD_CACHE.set(token, png);
  }
  const res = new Response(png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
  });
  if (edge) {
    try { await edge.put(key, res.clone()); } catch { /* the card still goes out */ }
  }
  return res;
}

/** The app's page for /film/<token>, with this match in its preview tags. */
export async function handleFilmPage(req, env, token) {
  // A fresh request for the shell: a forwarded If-None-Match could earn a
  // bodiless 304, and there would be nothing to rewrite.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', req.url)));
  let sum = null;
  try { sum = await filmSummary(env, token); } catch (e) { console.error('film summary failed', e); }
  if (!sum || typeof HTMLRewriter === 'undefined') return shell;

  const { title, description, alt } = filmMeta(sum);
  const url = `${SITE}/film/${token}`;
  const image = `${SITE}/film/${token}/card.png`;
  const set = (value) => ({ element(el) { el.setAttribute('content', value); } });
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(`${title} · Orbital`); } })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[property="og:url"]', set(url))
    .on('meta[property="og:image"]', set(image))
    .on('meta[property="og:image:alt"]', set(alt))
    .on('meta[property="og:image:width"]', set(String(W)))
    .on('meta[property="og:image:height"]', set(String(H)))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[name="twitter:image"]', set(image))
    .on('meta[name="twitter:image:alt"]', set(alt))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', url); } })
    // The home page's crawler copy (scripts/prerender-pages.mjs) is not this page.
    .on('#seo-page', { element(el) { el.remove(); } })
    .transform(shell);
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'public, max-age=300');
  return new Response(out.body, { status: shell.status === 404 ? 200 : shell.status, headers });
}
