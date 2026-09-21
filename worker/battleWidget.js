// ---------------------------------------------------------------------
// THE BATTLE WIDGET
//
// A second home-screen card, for the one question the first one only
// answers as a number. The combined card says "2 BATTLES · 3 INBOUND",
// which tells a player that something is wrong and nothing about what.
// This one says which world, who is winning it, and what is on its way
// to them next.
//
// TWO HALVES, BOTH CHOSEN DELIBERATELY:
//   - LIVE BATTLES: per fight, the body, hulls engaged on each side,
//     the hull fraction left, and the running kill/loss tally.
//   - THREAT BOARD: hostile ships under way at something you hold, the
//     world they are aimed at, and how many ticks until they arrive.
//
// WHAT IT MUST NOT DO IS LEAK. Rival strength is gated behind Sensors
// research ([[intel-gating]]), and a widget is the easiest place in the
// product to forget that, because nothing on a home screen looks like a
// query. Enemy hull counts in a battle are fair game -- you are in the
// fight, you can see the ships shooting at you -- but the hulls' HEALTH
// is not, and neither is anything about a force you have not met. Where
// coverage is missing this prints '?' rather than the truth.
// ---------------------------------------------------------------------

import {
  createSurface, fillRect, fillVGrad, drawLine, drawText, encodePng, hexToRgb,
} from './heraldPng.js';

const INK = [226, 236, 245];
const DIM = [125, 146, 166];
const ALARM = [255, 106, 96];
const WARN = [255, 202, 72];
const GOOD = [127, 255, 161];
const GROUND = [8, 12, 19];

/** The sensor level at which a rival's hull condition stops being a
 *  guess. 2 = patrol: ships in the SOI are visible to you. */
const COVERAGE_FOR_HEALTH = 2;

/** How many rows of each half fit on a card before it turns to mush. */
const MAX_BATTLES = 3;
const MAX_THREATS = 4;

/**
 * Everything the battle card draws, for the player's current game.
 *
 * Game selection is deliberately identical to the main widget's: the
 * same player, the same "live and standing first" ordering. Two cards on
 * one home screen reporting two different games would be worse than
 * either card alone.
 */
export async function battleSnapshot(env, userId) {
  const g = await env.DB
    .prepare(
      `SELECT g.id, g.current_tick, g.next_tick_at, r.name AS game_name,
              f.id AS faction_id, f.name AS faction, f.color,
              f.status AS faction_status, g.status AS game_status
         FROM game_factions f
         JOIN games g ON g.id = f.game_id
         JOIN rooms r ON r.id = g.id
        WHERE f.user_id = ?
        ORDER BY (g.status = 'active' AND f.status = 'active') DESC,
                 (g.status = 'active') DESC,
                 r.updated_at DESC
        LIMIT 1`,
    )
    .bind(userId).first();
  if (!g) return null;

  const state = g.game_status !== 'active' ? 'ended'
    : g.faction_status !== 'active' ? 'eliminated'
    : 'live';

  const base = {
    gameId: g.id,
    game: String(g.game_name ?? 'Orbital'),
    faction: String(g.faction ?? ''),
    color: String(g.color || '#4ecdc4'),
    state,
    tick: g.current_tick ?? 0,
    nextTickAt: state === 'live' ? Number(g.next_tick_at ?? 0) : 0,
    battles: [],
    threats: [],
  };
  if (state !== 'live') return base;

  const gameId = g.id, me = g.faction_id;

  // ---- live battles -------------------------------------------------
  // battle_participants is per SHIP and already carries hp_end and the
  // kill tally, so a battle's whole scoreboard is one grouped read. A
  // ship with died_tick set is out of the fight and counts as a loss,
  // not as a hull still standing.
  const battleRows = await env.DB
    .prepare(
      `SELECT b.id, b.body_id, b.body_name, b.started_tick, b.last_fire_tick,
              p.faction_id,
              COUNT(*)                                   AS hulls,
              SUM(CASE WHEN p.died_tick IS NULL THEN 1 ELSE 0 END) AS alive,
              SUM(COALESCE(p.hp_end, p.hp_start, 0))     AS hp_now,
              SUM(COALESCE(p.hp_max, 0))                 AS hp_max,
              SUM(COALESCE(p.kills, 0))                  AS kills
         FROM battles b
         JOIN battle_participants p ON p.battle_id = b.id
        WHERE b.game_id = ?1 AND b.status = 'active'
          AND EXISTS (SELECT 1 FROM battle_participants mine
                       WHERE mine.battle_id = b.id AND mine.faction_id = ?2)
        GROUP BY b.id, p.faction_id
        ORDER BY b.last_fire_tick DESC`,
    )
    .bind(gameId, me).all();

  // Fold the per-faction rows into one row per battle: me, and everyone
  // who is not me lumped together as the opposition. A widget has no
  // room for a three-way breakdown, and "who is shooting at me" is the
  // question anyway.
  const byBattle = new Map();
  for (const r of battleRows.results ?? []) {
    let e = byBattle.get(r.id);
    if (!e) {
      e = {
        id: r.id,
        body: String(r.body_name || 'UNKNOWN'),
        bodyId: r.body_id,
        lastFire: Number(r.last_fire_tick ?? 0),
        mine: { hulls: 0, alive: 0, hpNow: 0, hpMax: 0, kills: 0 },
        theirs: { hulls: 0, alive: 0, hpNow: 0, hpMax: 0, kills: 0 },
      };
      byBattle.set(r.id, e);
    }
    const side = r.faction_id === me ? e.mine : e.theirs;
    side.hulls += Number(r.hulls ?? 0);
    side.alive += Number(r.alive ?? 0);
    side.hpNow += Number(r.hp_now ?? 0);
    side.hpMax += Number(r.hp_max ?? 0);
    side.kills += Number(r.kills ?? 0);
  }

  // Which of these bodies do our sensors actually cover? Enemy HEALTH is
  // intel; enemy PRESENCE in a fight we are in is not.
  const bodyIds = [...byBattle.values()].map(b => b.bodyId).filter(Boolean);
  const covered = await coveredBodies(env, gameId, me, bodyIds);

  base.battles = [...byBattle.values()]
    .sort((a, b) => b.lastFire - a.lastFire)
    .slice(0, MAX_BATTLES)
    .map(b => ({
      body: b.body.toUpperCase(),
      mine: b.mine.alive,
      theirs: b.theirs.alive,
      // Hull fraction, 0..1. Mine is always known. Theirs is only shown
      // where coverage allows; null renders as '?'.
      myHp: b.mine.hpMax > 0 ? clamp01(b.mine.hpNow / b.mine.hpMax) : null,
      theirHp: covered.has(b.bodyId) && b.theirs.hpMax > 0
        ? clamp01(b.theirs.hpNow / b.theirs.hpMax) : null,
      kills: b.mine.kills,
      // A loss is one of MY hulls that died in this battle.
      lost: b.mine.hulls - b.mine.alive,
    }));

  // ---- threat board --------------------------------------------------
  // Hostile ships in transit at a body you hold. Grouped by target, with
  // the soonest arrival, so the card reads as "MARS, 4 SHIPS, IN 2T"
  // rather than as four identical lines.
  //
  // The treaty exclusion matches the main card's inbound count exactly:
  // a signed NAP or defence pact means those ships are not a threat, and
  // a widget that cries wolf about an ally is worse than a silent one.
  const threatRows = await env.DB
    .prepare(
      `SELECT b.id AS body_id, b.name AS body_name,
              COUNT(*) AS ships,
              MIN(n2.arrival_at_tick) AS eta_tick
         FROM game_ship_nodes n2
         JOIN game_ships sh ON sh.id = n2.ship_id
         JOIN game_bodies b ON b.id = n2.target_body_id
        WHERE n2.game_id = ?1 AND n2.status = 'in_transit'
          AND sh.owner_faction_id != ?2 AND sh.hp > 0
          AND (EXISTS (SELECT 1 FROM game_settlements st
                        WHERE st.body_id = b.id AND st.owner_faction_id = ?2)
               OR b.owner_faction_id = ?2)
          AND NOT EXISTS (
            SELECT 1 FROM treaties t
              JOIN treaty_signatories s1 ON s1.treaty_id = t.id AND s1.faction_id = ?2
              JOIN treaty_signatories s2 ON s2.treaty_id = t.id AND s2.faction_id = sh.owner_faction_id
             WHERE t.game_id = ?1 AND t.status = 'active' AND t.broken_at_tick IS NULL
               AND t.kind IN ('nap','defense_pact')
               AND s1.signed_at_tick IS NOT NULL AND s2.signed_at_tick IS NOT NULL)
        GROUP BY b.id, b.name
        ORDER BY (eta_tick IS NULL), eta_tick ASC
        LIMIT ?3`,
    )
    .bind(gameId, me, MAX_THREATS).all();

  const nowTick = Number(g.current_tick ?? 0);
  base.threats = (threatRows.results ?? []).map(r => ({
    body: String(r.body_name || 'UNKNOWN').toUpperCase(),
    ships: Number(r.ships ?? 0),
    // Ticks remaining, or null when the node never recorded a predicted
    // arrival (pre-migration plans still in flight).
    eta: r.eta_tick == null ? null : Math.max(0, Number(r.eta_tick) - nowTick),
  }));

  return base;
}

function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/**
 * Which of these bodies this faction has patrol-or-better coverage of.
 *
 * BOUND IN CHUNKS OF 60. D1 caps a statement at 100 bound parameters,
 * not SQLite's 999 ([[d1-bind-limit]]), and a player in a wide war can
 * easily be in more battles than a naive IN-list would survive.
 */
async function coveredBodies(env, gameId, factionId, bodyIds) {
  const out = new Set();
  const ids = [...new Set(bodyIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB
      .prepare(
        `SELECT body_id FROM sensor_coverage
          WHERE game_id = ? AND faction_id = ? AND level >= ?
            AND body_id IN (${marks})`,
      )
      .bind(gameId, factionId, COVERAGE_FOR_HEALTH, ...chunk).all();
    for (const r of rows.results ?? []) out.add(r.body_id);
  }
  return out;
}

// ---------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------

/** "IN 3T" / "NOW". Ticks, not minutes: the player plans in ticks, and a
 *  tick is the unit the arrival is actually recorded in. */
function eta(t) {
  if (t == null) return '?';
  return t <= 0 ? 'NOW' : `IN ${t}T`;
}

/** 0.71 -> "71%", null -> "?" (not covered by sensors). */
function pct(f) {
  return f == null ? '?' : `${Math.round(f * 100)}%`;
}

/**
 * Render the battle card.
 *
 * UPPERCASE THROUGHOUT, because the bundled font is a 5x7 bitmap with no
 * lowercase glyphs. Passing mixed case does not fall back, it drops the
 * characters, so every string reaching drawText is upper-cased at the
 * point it is built rather than here.
 */
export async function renderBattlePng(snap, { width = 512, height = 384 } = {}) {
  const W = width, H = height;
  const s = createSurface(W, H, GROUND);
  const accent = hexToRgb(snap.color);

  // Stops are [t, rgb, ALPHA]. A two-element stop interpolates undefined
  // and paints nothing at all.
  fillVGrad(s, 0, 0, W, H, [[0, [12, 16, 26], 1], [1, [6, 9, 15], 1]]);
  fillRect(s, 0, 0, 5, H, accent, 0.9);

  const pad = Math.round(W / 28);
  const scale = Math.max(2, Math.round(W / 190));
  const small = Math.max(1, scale - 1);
  const line = small * 9;

  let y = pad;

  // ---- header --------------------------------------------------------
  drawText(s, 'BATTLE REPORT', pad + 8, y, scale, INK, 1);
  const right = snap.state === 'live' ? `T${snap.tick}`
    : snap.state === 'eliminated' ? 'ELIMINATED' : 'GAME OVER';
  drawText(s, right, W - pad, y + 2, small,
    snap.state === 'live' ? DIM : ALARM, 1, 'right');
  y += scale * 8;
  drawText(s, snap.faction.toUpperCase().slice(0, 24), pad + 8, y, small, DIM, 1);
  y += line + 6;
  drawLine(s, pad, y, W - pad, y, DIM, 0.25, 1);
  y += 10;

  if (snap.state !== 'live') {
    drawText(s, snap.state === 'eliminated' ? 'YOUR WAR IS OVER' : 'THE GAME HAS ENDED',
      pad + 8, y + 8, small, DIM, 0.9);
    return encodePng(s);
  }

  // ---- live battles --------------------------------------------------
  drawText(s, 'ENGAGED', pad + 8, y, small, DIM, 0.8);
  y += line + 4;

  if (snap.battles.length === 0) {
    drawText(s, 'NO SHOTS FIRED', pad + 8, y, small, GOOD, 0.85);
    y += line + 8;
  } else {
    for (const b of snap.battles) {
      // A 4x2 slot is half the height of a 4x4 one, and the card is
      // rendered for whatever it is given. Two rows plus the INBOUND
      // heading have to still fit, or a resize silently eats the half
      // of the card that says what is coming.
      if (y > H - line * 4 - pad) break;
      // Row 1: the world, and the hull count each way. "6 V 4" reads at
      // arm's length in a way "6 vs 4 ships" does not.
      drawText(s, b.body.slice(0, 14), pad + 8, y, small, INK, 1);
      drawText(s, `${b.mine} V ${b.theirs}`, W - pad, y, small, INK, 1, 'right');
      y += line;
      // Row 2: hull left on each side, then the tally. Theirs is '?'
      // wherever sensors do not cover the fight.
      const hp = `HULL ${pct(b.myHp)} / ${pct(b.theirHp)}`;
      drawText(s, hp, pad + 14, y, small, b.myHp != null && b.myHp < 0.34 ? ALARM : DIM, 0.95);
      const tally = `${b.kills} KILLED  ${b.lost} LOST`;
      drawText(s, tally, W - pad, y, small, b.lost > 0 ? WARN : DIM, 0.95, 'right');
      y += line + 7;
    }
  }

  y += 4;
  drawLine(s, pad, y, W - pad, y, DIM, 0.2, 1);
  y += 10;

  // ---- threat board ---------------------------------------------------
  drawText(s, 'INBOUND', pad + 8, y, small, DIM, 0.8);
  y += line + 4;

  if (snap.threats.length === 0) {
    drawText(s, 'NOTHING ON THE WAY', pad + 8, y, small, GOOD, 0.85);
  } else {
    for (const t of snap.threats) {
      if (y > H - line - pad) break;   // never draw off the bottom edge
      drawText(s, t.body.slice(0, 14), pad + 8, y, small, INK, 0.95);
      drawText(s, `${t.ships} SHIP${t.ships === 1 ? '' : 'S'}`, Math.round(W * 0.58), y, small, DIM, 0.95);
      drawText(s, eta(t.eta), W - pad, y, small,
        t.eta != null && t.eta <= 1 ? ALARM : WARN, 1, 'right');
      y += line + 3;
    }
  }

  return encodePng(s);
}

// ---------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------

export const WIDGET_BATTLE_RE = /^\/widget\/([A-Za-z0-9_-]{8,64})\/battle\.png$/;

/**
 * GET /widget/<token>/battle.png
 *
 * PUBLIC, like the other widget images: the token IS the credential, so
 * there is no session here and a bad one must 404 rather than 403 — a
 * revoked token and a made-up one should be indistinguishable from
 * outside.
 */
export async function handleBattlePng(req, env, { params }) {
  const { resolveWidgetToken } = await import('./widget.js');
  const userId = await resolveWidgetToken(env, params.token);
  if (!userId) return new Response('no such widget', { status: 404 });

  const url = new URL(req.url);
  const width = Math.max(240, Math.min(1200, Number(url.searchParams.get('w')) || 512));
  const height = Math.max(160, Math.min(800, Number(url.searchParams.get('h')) || 384));

  const snap = await battleSnapshot(env, userId);
  const png = await renderBattlePng(snap ?? EMPTY_BATTLE_SNAP, { width, height });

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // Shorter than the main card's minute. A battle is the one thing
      // on a home screen that is allowed to be a little expensive.
      'cache-control': 'private, max-age=30',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** An account with no factions at all: the card still has to draw. */
const EMPTY_BATTLE_SNAP = {
  gameId: null, game: 'Orbital', faction: 'NO FACTION', color: '#4ecdc4',
  state: 'none', tick: 0, nextTickAt: 0, battles: [], threats: [],
};
