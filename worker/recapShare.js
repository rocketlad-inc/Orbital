// ============================================================================
// recapShare.js — what a battle recap link looks like where people paste it.
//
// A recap link pasted into Discord or Reddit used to unfurl as the site's
// generic advert: no battle, no names, no winner. In its first 53 days
// the game minted 413 recap links and they drew 162 views. A link that
// shows the fight it holds is the cheapest word of mouth there is.
//
//   GET /recap/<token>            the app's page, with this battle's
//                                 title, description and picture in the
//                                 Open Graph / Twitter tags (HTMLRewriter)
//   GET /recap/<token>/card.png   1200x630: the world as the map draws it
//                                 (its globe, terraformed if it was), who
//                                 fought, who lost what, who won
//
// /recap/* is in run_worker_first (wrangler.jsonc). Nothing here counts a
// view: crawlers fetch these, and the page's own /api/recap call already
// counts the people.
// ============================================================================

import {
  createSurface, fillRect, fillCircle, fillRadial, drawText, textWidth,
  encodePng, hexToRgb, drawLine,
} from './heraldPng.js';

const SITE = 'https://orbital-empire.com';
export const RECAP_PAGE_RE = /^\/recap\/([A-Za-z0-9_-]{8,64})\/?$/;
export const RECAP_CARD_RE = /^\/recap\/([A-Za-z0-9_-]{8,64})\/card\.png$/;

/**
 * Everything the preview needs about one shared battle, or null when the
 * link is unknown or revoked.
 */
export async function recapSummary(env, token) {
  const row = await env.DB
    .prepare(
      `SELECT s.token, b.id, b.game_id, b.body_id, b.body_name, b.started_tick, b.ended_tick,
              b.last_fire_tick, b.shots, b.ships_lost, b.settlements_lost, b.victor_faction_id,
              r.name AS game_name
         FROM battle_shares s
         JOIN battles b ON b.id = s.battle_id
         LEFT JOIN rooms r ON r.id = s.game_id
        WHERE s.token = ? AND s.revoked_at_ms IS NULL`,
    )
    .bind(token).first();
  if (!row) return null;

  const sides = (await env.DB
    .prepare(
      `SELECT p.faction_id, f.name, f.color,
              COUNT(*) AS committed,
              SUM(CASE WHEN p.died_tick IS NOT NULL THEN 1 ELSE 0 END) AS lost,
              SUM(p.kills) AS kills
         FROM battle_participants p
         LEFT JOIN game_factions f ON f.id = p.faction_id
        WHERE p.battle_id = ? AND p.faction_id IS NOT NULL
        GROUP BY p.faction_id
        ORDER BY committed DESC`,
    )
    .bind(row.id).all()).results ?? [];

  const ace = await env.DB
    .prepare(
      `SELECT p.ship_name, p.captain_name, p.kills, f.name AS faction, f.color
         FROM battle_participants p LEFT JOIN game_factions f ON f.id = p.faction_id
        WHERE p.battle_id = ? AND p.kills > 0
        ORDER BY p.kills DESC, p.damage_dealt DESC LIMIT 1`,
    )
    .bind(row.id).first();

  let body = null;
  if (row.body_id) {
    body = await env.DB
      .prepare(
        `SELECT id, name, type, color, orbit_radius, yield_metal, terraformed_at_tick
           FROM game_bodies WHERE id = ? AND game_id = ?`,
      )
      .bind(row.body_id, row.game_id).first();
  }
  const endTick = row.ended_tick ?? row.last_fire_tick;
  const victor = row.victor_faction_id ? sides.find(s => s.faction_id === row.victor_faction_id) ?? null : null;

  return {
    token,
    gameName: row.game_name ?? 'Orbital',
    bodyName: row.body_name ?? body?.name ?? 'deep space',
    body,
    // As it looked during the fight: a world terraformed since shows raw.
    terraformed: body?.terraformed_at_tick != null && body.terraformed_at_tick <= endTick,
    startTick: row.started_tick,
    endTick,
    turns: Math.max(1, endTick - row.started_tick + 1),
    shots: row.shots ?? 0,
    shipsLost: row.ships_lost ?? 0,
    sides: sides.map(s => ({
      name: s.name ?? 'Unknown empire', color: s.color ?? '#8899aa',
      committed: Number(s.committed) || 0, lost: Number(s.lost) || 0, kills: Number(s.kills) || 0,
    })),
    victor: victor ? { name: victor.name ?? 'Unknown empire', color: victor.color ?? '#8899aa' } : null,
    ace: ace ? { ship: ace.ship_name, captain: ace.captain_name, kills: ace.kills, faction: ace.faction, color: ace.color } : null,
  };
}

/** Title, description and alt text for one battle. Plain sentences. */
export function recapMeta(sum) {
  const title = `Battle of ${sum.bodyName}${sum.victor ? `: ${sum.victor.name} wins` : ''}`;
  const n = sum.sides.length;
  const parts = [
    sum.victor ? `${sum.victor.name} won the battle of ${sum.bodyName}` : `No clear victor at ${sum.bodyName}`,
    `${n} empire${n === 1 ? '' : 's'}, ${sum.shipsLost} ship${sum.shipsLost === 1 ? '' : 's'} lost over ${sum.turns} turn${sum.turns === 1 ? '' : 's'}`,
  ];
  if (sum.ace?.captain && sum.ace.kills >= 2) {
    parts.push(`Captain ${sum.ace.captain} of the ${sum.ace.ship} took ${sum.ace.kills}`);
  }
  const description = `${parts.join('. ')}. Replay every shot from this game of Orbital, the free space strategy game set in the real solar system.`;
  const alt = `${sum.bodyName} as it looked during the battle, with ${sum.sides.slice(0, 4).map(s => s.name).join(', ')}${sum.victor ? `; ${sum.victor.name} won` : ''}.`;
  return { title, description, alt };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const W = 1200;
const H = 630;

/** Straight-alpha source-over of a picture onto the surface. */
function blit(s, img, ox, oy) {
  for (let y = 0; y < img.h; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= s.h) continue;
    for (let x = 0; x < img.w; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= s.w) continue;
      const si = (y * img.w + x) * 4;
      const a = img.data[si + 3] / 255;
      if (a <= 0) continue;
      const di = (ty * s.w + tx) * 4;
      s.data[di] = Math.round(img.data[si] * a + s.data[di] * (1 - a));
      s.data[di + 1] = Math.round(img.data[si + 1] * a + s.data[di + 1] * (1 - a));
      s.data[di + 2] = Math.round(img.data[si + 2] * a + s.data[di + 2] * (1 - a));
    }
  }
}

/** A cheap deterministic starfield, so every card has the same sky. */
function stars(s, seed) {
  let x = seed >>> 0 || 1;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 260; i++) {
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

/**
 * The preview picture. `planet` is optional straight-alpha pixels of the
 * world (from rasterSvgPixels); without it the card still reads.
 */
export async function renderRecapCard(sum, planet = null) {
  const s = createSurface(W, H, [5, 7, 12]);
  stars(s, (sum.startTick * 2654435761) ^ sum.shipsLost);

  // The world, large, off the right edge, with a warm battle glow.
  const PR = 520;
  const pcx = 930, pcy = 330;
  fillRadial(s, pcx, pcy, PR * 0.78, [255, 110, 60], 0.18, 0);
  if (planet) blit(s, planet, Math.round(pcx - planet.w / 2), Math.round(pcy - planet.h / 2));
  else fillCircle(s, pcx, pcy, PR / 2, hexToRgb(sum.body?.color || '#556677'), 1);
  // Shade the left of the frame so the text always reads over the world.
  for (let x = 0; x < 760; x++) {
    const a = x < 560 ? 0.82 : 0.82 * (1 - (x - 560) / 200);
    fillRect(s, x, 0, 1, H, [5, 7, 12], a);
  }

  const L = 64;
  const textW = 600;
  drawText(s, 'BATTLE OF', L, 58, 3, [255, 150, 110], 0.95);
  const nameScale = textWidth(sum.bodyName.toUpperCase(), 9) <= textW ? 9 : 6;
  drawText(s, fit(sum.bodyName, nameScale, textW), L, 84, nameScale, [255, 244, 236], 1);
  drawText(s, fit(`${sum.gameName} · turns ${sum.startTick}-${sum.endTick}`, 2, textW), L, 84 + nameScale * 7 + 18, 2, [190, 170, 175], 0.9);

  // The sides: who came, what they lost.
  let y = 236;
  const rows = sum.sides.slice(0, 5);
  for (const side of rows) {
    const col = hexToRgb(side.color);
    fillCircle(s, L + 8, y + 10, 8, col, 1);
    drawText(s, fit(side.name, 3, 380), L + 28, y, 3, [236, 230, 234], 0.97);
    const lost = `LOST ${side.lost} OF ${side.committed}`;
    drawText(s, lost, L + textW - 30, y + 2, 2, side.lost ? [255, 160, 150] : [150, 200, 190], 0.9, 'right');
    // a thin bar: what came, with the lost share in red
    const bw = textW - 58;
    const lostW = side.committed ? Math.round(bw * side.lost / side.committed) : 0;
    fillRect(s, L + 28, y + 26, bw, 4, col, 0.55);
    if (lostW) fillRect(s, L + 28, y + 26, lostW, 4, [220, 70, 70], 0.95);
    y += 48;
  }
  if (sum.sides.length > rows.length) {
    drawText(s, `+${sum.sides.length - rows.length} MORE`, L + 28, y, 2, [170, 160, 170], 0.85);
  }

  // The verdict.
  const vy = H - 112;
  drawLine(s, L, vy - 16, L + textW, vy - 16, [255, 140, 110], 0.25, 2);
  if (sum.victor) {
    drawText(s, fit(`${sum.victor.name} wins`, 4, textW), L, vy, 4, hexToRgb(sum.victor.color), 1);
  } else {
    drawText(s, 'NO CLEAR VICTOR', L, vy, 4, [200, 190, 195], 0.95);
  }
  drawText(s, `${sum.shipsLost} SHIPS LOST · ${sum.shots} SHOTS`, L, vy + 40, 2, [210, 190, 185], 0.9);

  // The invitation.
  drawText(s, 'WATCH THE REPLAY', W - 48, H - 62, 3, [255, 200, 120], 1, 'right');
  drawText(s, 'ORBITAL-EMPIRE.COM', W - 48, H - 34, 2, [200, 190, 180], 0.9, 'right');

  return encodePng(s);
}

/** The world's sprite for the card, or null. Never throws. */
async function planetPixels(req, env, sum) {
  if (!sum.body) return null;
  try {
    const { rasterSvgPixels, globePngOf } = await import('./planetSprite.js');
    const { planetSvg, mapType } = await import('./planetSvg.js');
    const id = String(sum.body.id);
    const local = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const body = {
      id: local, type: mapType(sum.body.type), color: sum.body.color || '#8899aa',
      terraformed: sum.terraformed, orbitRadius: Number(sum.body.orbit_radius) || 0,
      resources: { metal: Number(sum.body.yield_metal) || 0 },
      terraformedAtTick: sum.terraformed ? 0 : null,
    };
    const globe = await globePngOf(req, env, body);
    return await rasterSvgPixels(planetSvg(body, globe), 520);
  } catch (e) {
    console.error('recap card planet failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discord: the replay, once the battle has closed
// ---------------------------------------------------------------------------

/** A fight small enough to skip: the battle card's own threshold. */
const REPLAY_MIN_LOST = 3;
const REPLAY_HEADLINE_LOST = 10;

/**
 * Post "watch the replay" to the game's feed for a battle that just
 * closed. The battle card (worker/battleCard.js) posts mid-fight, before
 * the recap link exists; this follows it with the link and the card
 * picture. Same gates as the card: the bot's battle-card switch, and the
 * game feed's own rules inside postChannelEmbed. Never throws.
 */
export async function publishReplay(env, gameId, battleId) {
  try {
    const post = await replayPost(env, battleId);
    if (!post) return;
    // Nothing to do when this game's feed would not take the post: it is
    // off, or at 'headlines' and this is not one. Checked HERE, before the
    // GIF, so a battle in a game with its feed off never spends browser
    // time on a GIF nobody would see. (The fast-game cap is still applied
    // when the post goes out.)
    const feed = await import('./gameFeed.js');
    const row = await feed.feedRow(env, gameId);
    if (!row || !feed.levelAdmits(row.level, post.sum.shipsLost >= REPLAY_HEADLINE_LOST)) return;
    // With a browser to draw it in, the replay waits for its GIF and goes
    // out as one message (recapGif.js), which posts the plain embed itself
    // if the GIF cannot be made.
    const { queueBattleGif } = await import('./recapGif.js');
    if (await queueBattleGif(env, gameId, battleId, post.token)) return;
    await postReplay(env, gameId, post, null, null);
  } catch (e) {
    console.error('publishReplay failed', e);
  }
}

/** Whether a battle gets a replay post, and what goes in it: null when it
 *  does not (no bot, battle cards off, no public link, too small a fight). */
export async function replayPost(env, battleId) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  const cfg = await (await import('./botSettings.js')).getSettings(env);
  if (cfg.battle_cards_enabled === false) return null;
  const share = await env.DB
    .prepare('SELECT token FROM battle_shares WHERE battle_id = ? AND created_by IS NULL AND revoked_at_ms IS NULL ORDER BY created_at_ms LIMIT 1')
    .bind(battleId).first();
  if (!share) return null;
  const sum = await recapSummary(env, share.token);
  if (!sum || sum.shipsLost < REPLAY_MIN_LOST) return null;
  return { token: share.token, sum };
}

/**
 * Send the replay post. With `file` (the battle GIF) it carries the GIF
 * as its picture, in the same message; without, the still battle card.
 * `span` says what the GIF covers ({ fromTick, ticks, total }), so a GIF
 * of only the final turns of a long fight says so.
 */
export async function postReplay(env, gameId, post, file, span) {
  const { tr } = await import('./i18n.js');
  const discord = await import('./discord.js');
  const { sum, token } = post;
  const url = `${SITE}/recap/${token}?from=discord-replay`;
  const colour = parseInt(String(sum.victor?.color || '#ff5e3a').replace('#', ''), 16) || 0xff5e3a;
  const tail = file && span && span.total > 0 && span.ticks > 0 && span.ticks < span.total;
  const embed = (L) => ({
    title: sum.victor
      ? tr(L, 'feed.replay.titleWon', { body: sum.bodyName, name: sum.victor.name })
      : tr(L, 'feed.replay.title', { body: sum.bodyName }),
    url,
    description: tr(L, 'feed.replay.body', { n: sum.shipsLost, turns: sum.turns, url })
      + (tail ? `\n${tr(L, 'feed.replay.gifTail', { n: span.ticks, total: span.total })}` : ''),
    color: colour,
    image: { url: file ? `attachment://${file.name}` : `${SITE}/recap/${token}/card.png` },
    footer: { text: `Orbital · ${sum.gameName} · T+${sum.startTick}–${sum.endTick}` },
  });
  const opts = { headline: sum.shipsLost >= REPLAY_HEADLINE_LOST };
  return file
    ? discord.postChannelFile(env, embed, file, gameId, opts)
    : discord.postChannelEmbed(env, embed, gameId, opts);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const CARD_CACHE = new Map();

export async function handleRecapCard(req, env, token) {
  // Drawing a card is real CPU (a 1200x630 PNG in plain JS), and every
  // crawler that unfurls the link asks for it. The edge cache serves the
  // repeats; the isolate's map covers a cold edge.
  const edge = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL(req.url).origin + new URL(req.url).pathname);
  if (edge) {
    const hit = await edge.match(key);
    if (hit) return hit;
  }
  const sum = await recapSummary(env, token);
  if (!sum) return new Response('no such recap', { status: 404 });
  let png = CARD_CACHE.get(token);
  if (!png) {
    png = await renderRecapCard(sum, await planetPixels(req, env, sum));
    if (CARD_CACHE.size > 50) CARD_CACHE.delete(CARD_CACHE.keys().next().value);
    CARD_CACHE.set(token, png);
  }
  const res = new Response(png, {
    headers: {
      'content-type': 'image/png',
      // A closed battle never changes; an open one is re-read within the hour.
      'cache-control': 'public, max-age=3600',
    },
  });
  if (edge) {
    try { await edge.put(key, res.clone()); } catch { /* the card still goes out */ }
  }
  return res;
}

/** The app's page for /recap/<token>, with this battle in its preview tags. */
export async function handleRecapPage(req, env, token) {
  // A fresh request for the shell: forwarding the browser's If-None-Match
  // could earn a bodiless 304, and there would be nothing to rewrite.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', req.url)));
  let sum = null;
  try { sum = await recapSummary(env, token); } catch (e) { console.error('recap summary failed', e); }
  if (!sum || typeof HTMLRewriter === 'undefined') return shell;

  const { title, description, alt } = recapMeta(sum);
  const url = `${SITE}/recap/${token}`;
  const image = `${SITE}/recap/${token}/card.png`;
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
    .transform(shell);
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'public, max-age=300');
  return new Response(out.body, { status: shell.status === 404 ? 200 : shell.status, headers });
}
