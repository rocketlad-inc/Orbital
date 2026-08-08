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

  // Survivors per faction, still at the body.
  const present = (await env.DB
    .prepare(
      `SELECT f.id AS faction_id, f.name, f.color, COUNT(*) AS n
         FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
        WHERE s.game_id = ? AND s.parent_body_id = ? AND s.hp > 0
        GROUP BY f.id ORDER BY n DESC`,
    )
    .bind(gameId, bodyId).all()).results ?? [];

  // FORCE SIZE = survivors + losses.
  //
  // Honest caveat: there is no historical record of "who was at this body
  // at tick N" — parent_body_id is current state. Cards post from the
  // tick loop, so at publish time "now" IS the battle and this is exact.
  // Re-rendering an OLD battle later counts whoever is standing there
  // today, which can undercount a force that won and moved on. Accepting
  // that beats inventing a fleet-position history table for a poster.
  const byFaction = new Map();
  const put = (id, name, color) => {
    if (!byFaction.has(id)) {
      byFaction.set(id, { faction_id: id, name, color, lost: 0, survived: 0 });
    }
    return byFaction.get(id);
  };
  for (const l of losses) put(l.faction_id, l.name, l.color).lost = l.n;
  for (const p of present) put(p.faction_id, p.name, p.color).survived = p.n;

  const sides = [...byFaction.values()]
    .map(x => ({ ...x, entered: x.lost + x.survived }))
    .filter(x => x.entered > 0)
    .sort((a, b) => b.entered - a.entered);

  return {
    gameName: game.name,
    body: body.name,
    tick,
    losses,
    sides,
    total,
    holding: present[0] ?? null,
  };
}

/**
 * Render the poster. 640x360 — wide enough for Discord's embed, tall
 * enough for one bar per combatant without crowding.
 */
/**
 * Render the poster as a mirrored ledger, matching the combat table in
 * the analytics dashboard: losses grow LEFT in red, survivors grow RIGHT
 * in the faction's colour, with the name between them.
 *
 * Both bars share one scale, so total bar width IS the force that
 * entered — a long bar is a big fleet, and the red/colour split is what
 * happened to it. Force size and attrition read in the same glance,
 * which two separate charts could never do.
 */
export async function renderBattlePng(data) {
  const rows = data.sides.slice(0, 7);
  const W = 900;
  const H = 128 + rows.length * 46 + 54;
  const SS = 2;
  const s = createSurface(W * SS, H * SS, [8, 6, 10]);
  const X = (v) => v * SS;

  const F_TITLE = 7, F_SUB = 3, F_NAME = 3, F_NUM = 3, F_HEAD = 2;
  const NAME_BAND = 330;                       // fixed centre column
  const cx = W / 2;
  const barMax = (W - NAME_BAND) / 2 - 66;     // room for the number

  fillRadial(s, X(cx), X(-50), X(420), [255, 90, 50], 0.28, 0);
  for (let gx = 0; gx < W; gx += 36) fillRect(s, X(gx), 0, 1, s.h, [255, 120, 80], 0.035);

  // ---- header ----
  drawText(s, 'BATTLE OF', X(34), X(30), F_SUB, [255, 150, 110], 0.9, 'left');
  const nameScale = data.body.length > 14 ? 5 : F_TITLE;
  drawText(s, data.body.toUpperCase(), X(34), X(46), nameScale, [255, 240, 230], 1, 'left');
  drawText(s, `${data.gameName.toUpperCase()} · TICK ${data.tick}`,
    X(W - 34), X(34), F_SUB, [190, 160, 160], 0.85, 'right');

  // ---- column heads ----
  const headY = 106;
  drawText(s, 'SHIPS LOST', X(cx - NAME_BAND / 2 - 14), X(headY), F_HEAD, [200, 130, 130], 0.85, 'right');
  drawText(s, 'SURVIVED', X(cx + NAME_BAND / 2 + 14), X(headY), F_HEAD, [130, 200, 190], 0.85, 'left');

  const maxEntered = Math.max(...rows.map(r => r.entered), 1);

  rows.forEach((r, i) => {
    const y = 128 + i * 46;
    const col = hexToRgb(r.color);
    const unit = barMax / maxEntered;
    const lostW = r.lost * unit;
    const survW = r.survived * unit;

    const lostEdge = cx - NAME_BAND / 2 - 14;
    const survEdge = cx + NAME_BAND / 2 + 14;

    // losses grow leftward
    if (r.lost > 0) {
      fillRect(s, X(lostEdge - lostW), X(y + 4), X(Math.max(2, lostW)), X(15), [200, 70, 70], 0.9);
      fillRect(s, X(lostEdge - lostW), X(y + 4), X(Math.max(2, lostW)), X(2), [255, 160, 150], 0.4);
    }
    drawText(s, String(r.lost), X(lostEdge - lostW - 10), X(y + 5), F_NUM,
      r.lost > 0 ? [255, 170, 160] : [110, 100, 105], r.lost > 0 ? 1 : 0.6, 'right');

    // survivors grow rightward, in the faction's own colour
    if (r.survived > 0) {
      fillRect(s, X(survEdge), X(y + 4), X(Math.max(2, survW)), X(15), col, 0.9);
      fillRect(s, X(survEdge), X(y + 4), X(Math.max(2, survW)), X(2), [255, 255, 255], 0.25);
    }
    drawText(s, String(r.survived), X(survEdge + survW + 10), X(y + 5), F_NUM,
      r.survived > 0 ? col : [110, 100, 105], r.survived > 0 ? 1 : 0.6, 'left');

    // centre: swatch + name + force size
    fillCircle(s, X(cx - NAME_BAND / 2 + 10), X(y + 11), X(5), col, 1);
    let label = (r.name || '?').toUpperCase();
    const room = NAME_BAND - 46;
    while (label.length > 3 && textWidth(label, F_NAME) > X(room)) label = label.slice(0, -1);
    drawText(s, label, X(cx - NAME_BAND / 2 + 22), X(y + 4), F_NAME, [235, 228, 232], 0.96, 'left');
    drawText(s, `${r.entered} IN`, X(cx + NAME_BAND / 2 - 6), X(y + 5), F_HEAD,
      [150, 140, 150], 0.8, 'right');
  });

  // ---- footer ----
  const fy = H - 30;
  drawLine(s, X(34), X(fy - 12), X(W - 34), X(fy - 12), [255, 140, 110], 0.22, 1.5 * SS);
  drawText(s, `${data.total} HULLS DESTROYED`, X(34), X(fy), F_NUM, [255, 190, 170], 1, 'left');
  if (data.holding) {
    drawText(s, `${(data.holding.name || '').toUpperCase().slice(0, 22)} HOLDS THE FIELD`,
      X(W - 34), X(fy), F_NUM, hexToRgb(data.holding.color), 1, 'right');
  } else {
    drawText(s, 'FIELD ABANDONED', X(W - 34), X(fy), F_NUM, [150, 140, 140], 0.9, 'right');
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
    }, gameId);
  }
}
