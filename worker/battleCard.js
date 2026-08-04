// ============================================================================
// battleCard.js — a battle as a poster.
//
// Sean screenshots fights into Discord unprompted; that instinct is the
// feature. This makes the bot do it automatically, and better: who
// fought, what died, who won the exchange, rendered as an image the
// channel can react to.
//
// Reuses the Herald's rasteriser wholesale — the same hand-rolled
// primitives and 5x7 font, so battle cards and territory strips share a
// visual language rather than looking like two different products.
//
// A "battle" is all ship losses at ONE body inside a window of ticks.
// That grouping is what turns twelve "X lost a corvette" lines into a
// single story with a name.
// ============================================================================

import {
  createSurface, fillRect, fillCircle, fillRadial, drawText, textWidth,
  encodePng, hexToRgb, drawLine,
} from './heraldPng.js';

/** Ticks either side that count as the same engagement. */
const BATTLE_WINDOW = 2;
/** Below this many losses it's a skirmish, not a battle worth a poster. */
export const BATTLE_MIN_LOSSES = 3;

/**
 * Gather one battle. Returns null when the body/tick has too little to
 * be worth reporting.
 */
export async function buildBattleData(env, gameId, bodyId, tick) {
  const game = await env.DB
    .prepare(`SELECT g.current_tick, r.name FROM games g JOIN rooms r ON r.id=g.id WHERE g.id=?`)
    .bind(gameId).first();
  if (!game) return null;

  const body = await env.DB
    .prepare('SELECT id, name FROM game_bodies WHERE id = ?').bind(bodyId).first();
  if (!body) return null;

  // Losses by owner. actor_faction_id on a ship_destroyed entry is the
  // faction that LOST the hull (the chronicle is written from the
  // victim's side), so this counts casualties, not kills.
  const losses = (await env.DB
    .prepare(
      `SELECT c.actor_faction_id AS faction_id, f.name, f.color, COUNT(*) AS n
         FROM chronicle_entries c
         JOIN game_factions f ON f.id = c.actor_faction_id
        WHERE c.game_id = ? AND c.kind = 'ship_destroyed'
          AND c.body_id = ? AND c.tick_number BETWEEN ? AND ?
        GROUP BY c.actor_faction_id
        ORDER BY n DESC`,
    )
    .bind(gameId, bodyId, tick - BATTLE_WINDOW, tick + BATTLE_WINDOW).all()).results ?? [];

  const total = losses.reduce((a, l) => a + l.n, 0);
  if (total < BATTLE_MIN_LOSSES || losses.length === 0) return null;

  // Who still holds the field: live hostile-capable hulls at the body now.
  const present = (await env.DB
    .prepare(
      `SELECT f.name, f.color, COUNT(*) AS n
         FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
        WHERE s.game_id = ? AND s.parent_body_id = ? AND s.hp > 0
        GROUP BY f.id ORDER BY n DESC`,
    )
    .bind(gameId, bodyId).all()).results ?? [];

  return {
    gameName: game.name,
    body: body.name,
    tick,
    losses,
    total,
    holding: present[0] ?? null,
  };
}

/**
 * Render the poster. 640x360 — wide enough for Discord's embed, tall
 * enough for one bar per combatant without crowding.
 */
export async function renderBattlePng(data) {
  const W = 640, H = 360, SS = 2;
  const s = createSurface(W * SS, H * SS, [8, 6, 10]);
  const X = (v) => v * SS;

  // Ember wash behind the title: this is a battle, not a spreadsheet.
  fillRadial(s, X(W * 0.5), X(-40), X(320), [255, 90, 50], 0.30, 0);
  for (let gx = 0; gx < W; gx += 32) fillRect(s, X(gx), 0, 1, s.h, [255, 120, 80], 0.04);

  drawText(s, 'BATTLE OF', X(28), X(30), 3, [255, 150, 110], 0.9, 'left');
  const nameScale = data.body.length > 12 ? 5 : 7;
  drawText(s, data.body.toUpperCase(), X(28), X(46), nameScale, [255, 240, 230], 1, 'left');

  drawText(s, `${data.gameName.toUpperCase()} · TICK ${data.tick}`,
    X(W - 28), X(34), 2, [180, 150, 150], 0.85, 'right');

  // Losses as mirrored-weight bars, longest first. Bar length is share of
  // total losses, so the shape of the defeat reads before any number.
  const top = 110, rowH = 46;
  const maxN = Math.max(...data.losses.map(l => l.n));
  data.losses.slice(0, 5).forEach((l, i) => {
    const y = top + i * rowH;
    const col = hexToRgb(l.color);
    const barMax = W - 250;
    const w = Math.max(6, (l.n / maxN) * barMax);

    drawText(s, (l.name || '?').toUpperCase().slice(0, 22), X(28), X(y), 3, col, 0.95, 'left');
    // bar
    fillRect(s, X(28), X(y + 16), X(w), X(12), col, 0.85);
    fillRect(s, X(28), X(y + 16), X(w), X(2), [255, 255, 255], 0.25);
    // count
    drawText(s, `${l.n} LOST`, X(34 + w), X(y + 17), 3, [255, 200, 190], 0.95, 'left');
  });

  // Footer: total, and who's left standing on the field.
  const fy = H - 40;
  drawLine(s, X(28), X(fy - 10), X(W - 28), X(fy - 10), [255, 140, 110], 0.25, 1.5 * SS);
  drawText(s, `${data.total} HULLS DESTROYED`, X(28), X(fy), 3, [255, 190, 170], 1, 'left');
  if (data.holding) {
    const hc = hexToRgb(data.holding.color);
    const label = `${(data.holding.name || '').toUpperCase().slice(0, 20)} HOLDS THE FIELD`;
    drawText(s, label, X(W - 28), X(fy), 3, hc, 1, 'right');
  } else {
    drawText(s, 'FIELD ABANDONED', X(W - 28), X(fy), 3, [150, 140, 140], 0.9, 'right');
  }

  return encodePng(s);
}

/** GET /battle/:gameId/:bodyId/:tick.png */
export const BATTLE_PNG_RE = /^\/battle\/([^/]+)\/([^/]+)\/(\d+)\.png$/;

export async function handleBattlePng(req, env, { params }) {
  const data = await buildBattleData(env, params.gameId, params.bodyId, Number(params.tick));
  if (!data) return new Response('no such battle', { status: 404 });
  const png = await renderBattlePng(data);
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // A resolved battle never changes, so this can cache hard.
      'cache-control': 'public, max-age=86400',
    },
  });
}

/**
 * Post a card for any battle that resolved this tick. Called from the
 * tick loop. Channel-level (not DM): a big fight is the channel's
 * entertainment, and the losers' names being public is the point.
 */
export async function publishBattles(env, gameId, tick) {
  const cfg = await (await import('./botSettings.js')).getSettings(env);
  if (cfg.battle_cards_enabled === false) return;
  if (!env.DISCORD_BOT_TOKEN) return;

  // Which bodies saw enough death this tick to be worth a poster?
  const hot = (await env.DB
    .prepare(
      `SELECT body_id, COUNT(*) n FROM chronicle_entries
        WHERE game_id = ? AND kind = 'ship_destroyed' AND tick_number = ?
          AND body_id IS NOT NULL
        GROUP BY body_id HAVING COUNT(*) >= ?`,
    )
    .bind(gameId, tick, BATTLE_MIN_LOSSES).all()).results ?? [];
  if (!hot.length) return;

  const discord = await import('./discord.js');
  const origin = (env.PUBLIC_ORIGIN || 'https://orbital.lcfeeser.workers.dev').replace(/\/+$/, '');

  for (const h of hot) {
    const data = await buildBattleData(env, gameId, h.body_id, tick);
    if (!data) continue;
    const url = `${origin}/battle/${encodeURIComponent(gameId)}/${encodeURIComponent(h.body_id)}/${tick}.png`;
    await discord.postChannelEmbed(env, {
      title: `⚔️ Battle of ${data.body}`,
      description: data.holding
        ? `**${data.total}** hulls destroyed. **${data.holding.name}** holds the field.`
        : `**${data.total}** hulls destroyed. The field is abandoned.`,
      color: 0xff5e3a,
      image: { url },
      footer: { text: `Orbital · ${data.gameName} · T+${tick}` },
    });
  }
}
