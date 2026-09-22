// ---------------------------------------------------------------------
// THE BATTLE WIDGET
//
// A second home-screen card, for the one question the first one only
// answers as a number. The combined card says "2 BATTLES · 3 INBOUND",
// which tells a player that something is wrong and nothing about what.
// This one says which world, who is winning it, and what is on its way
// to them next.
//
// IT USES THE SITUATION LOG GRAMMAR, DELIBERATELY. The log already
// solved "how do you draw a fight", and a home screen is the worst
// possible place to invent a second visual language for the same thing.
// So, taken from SituationLog.tsx:
//
//   - THE SHAPE OF THE FIGHT FIRST, as one bar split between the sides
//     and weighted by DAMAGE rather than hull count, because fifty
//     freighters are not a fleet. It is the headline, so it is thick.
//   - EACH SIDE IN ITS OWN LIVERY, on a rail down the left. Empire
//     identity lives on the rail and the label, never on the hulls.
//   - HULLS WEAR THEIR HEALTH, not their flag: the same green/amber/red
//     ramp as the log and the outliner, so a colour means one thing
//     everywhere in the game. A wounded formation reads at a glance.
//   - AND THEY ARE THE SHIPS THEMSELVES. Each hull is the game's own
//     ShipIcon, in the variant the player chose for it, rendered from
//     the component's exact SVG (see shipIconRaster.js). Not a dot and
//     not a traced outline: both were tried, and neither is the icon a
//     player recognises from the situation log.
//
// WHAT IT MUST NOT DO IS LEAK. Rival strength is gated behind Sensors
// research ([[intel-gating]]), and a widget is the easiest place in the
// product to forget that, because nothing on a home screen looks like a
// query. Enemy PRESENCE in a fight you are in is fair game -- you can
// see the ships shooting at you -- but their CONDITION is not. Without
// patrol coverage their hulls draw in the log own "unknown" grey: you
// get the size of the force and not its health, which is exactly what
// fog of war is supposed to feel like.
// ---------------------------------------------------------------------

import {
  createSurface, fillRect, fillVGrad, drawLine, drawText, encodePng, hexToRgb,
} from './heraldPng.js';
import {
  configureRasterizer, rasterReady, rasterIcon, drawIcon, iconKey,
} from './shipIconRaster.js';

const INK = [226, 236, 245];
const DIM = [125, 146, 166];
const ALARM = [255, 106, 96];
const WARN = [255, 202, 72];
const GOOD = [127, 255, 161];
const GROUND = [8, 12, 19];
const TROUGH = [22, 32, 44];          // .sit-battle__bar background

/** The sensor level at which a rival's hull condition stops being a
 *  guess. 2 = patrol: ships in the SOI are visible to you. */
const COVERAGE_FOR_HEALTH = 2;

/** Rows of each half that fit before the card turns to mush. A battle
 *  costs more than it did now that each draws its order of battle, so
 *  fewer fit and the ones shown say far more. */
const MAX_BATTLES = 2;
// Six, not three. A real fight at a Weapons Station Site had four
// empires in it; ranking by damage and cutting at three dropped a
// ten-ship fleet off the card entirely, because freighters deal no
// damage. What does not fit is dropped by the LAYOUT, with a count of
// what was left out -- never silently by a constant.
const MAX_SIDES = 6;
const MAX_HULLS = 12;
const MAX_THREATS = 3;

/**
 * Everything the battle card draws, for the player current game.
 *
 * Game selection is deliberately identical to the main widget: the same
 * player, the same "live and standing first" ordering. Two cards on one
 * home screen reporting two different games would be worse than either
 * card alone.
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

  // ---- live battles, PER SHIP -----------------------------------------
  // Per ship and not per faction, because the card draws an order of
  // battle: one hull, one pip, painted by that hull own health. The
  // rollups (count, damage, tally) are folded from these rather than
  // queried separately, so the bar and the pips can never disagree.
  const rows = await env.DB
    .prepare(
      `SELECT b.id AS battle_id, b.body_id, b.body_name, b.last_fire_tick,
              p.ship_id, p.faction_id, p.died_tick,
              COALESCE(p.hp_end, p.hp_start, 0) AS hp_now,
              COALESCE(p.hp_max, 0)             AS hp_max,
              COALESCE(p.damage_dealt, 0)       AS damage,
              COALESCE(p.kills, 0)              AS kills,
              p.ship_class, gs.icon_variant,
              fa.name AS faction_name, fa.color AS faction_color
         FROM battles b
         JOIN battle_participants p ON p.battle_id = b.id
         LEFT JOIN game_ships gs ON gs.id = p.ship_id
         LEFT JOIN game_factions fa ON fa.id = p.faction_id
        WHERE b.game_id = ?1 AND b.status = 'active'
          AND EXISTS (SELECT 1 FROM battle_participants mine
                       WHERE mine.battle_id = b.id AND mine.faction_id = ?2)
        ORDER BY b.last_fire_tick DESC`,
    )
    .bind(gameId, me).all();

  const byBattle = new Map();
  for (const r of rows.results ?? []) {
    let bt = byBattle.get(r.battle_id);
    if (!bt) {
      bt = {
        id: r.battle_id,
        body: String(r.body_name || 'UNKNOWN').toUpperCase(),
        bodyId: r.body_id,
        lastFire: Number(r.last_fire_tick ?? 0),
        sides: new Map(),
        kills: 0,
        lost: 0,
      };
      byBattle.set(r.battle_id, bt);
    }
    const fid = r.faction_id ?? 'unknown';
    let side = bt.sides.get(fid);
    if (!side) {
      side = {
        factionId: fid,
        mine: fid === me,
        name: String(r.faction_name || 'UNKNOWN').toUpperCase(),
        color: String(r.faction_color || '#8aa0b4'),
        alive: 0,
        damage: 0,
        // One entry per STANDING hull: its health and its class, because
        // the card draws the real silhouette and not a dot.
        hulls: [],
      };
      bt.sides.set(fid, side);
    }
    side.damage += Number(r.damage ?? 0);
    const dead = r.died_tick != null;
    if (side.mine) {
      bt.kills += Number(r.kills ?? 0);
      if (dead) bt.lost += 1;
    }
    if (dead) continue;                 // a dead hull is not in the line
    side.alive += 1;
    const max = Number(r.hp_max ?? 0);
    side.hulls.push({
      hp: max > 0
        ? Math.max(0, Math.min(100, (Number(r.hp_now ?? 0) / max) * 100))
        : null,
      cls: String(r.ship_class || 'corvette'),
      // The player's own pick of icon for this hull, or null for the
      // class default -- exactly what the situation log draws.
      variant: r.icon_variant || null,
    });
  }

  // Which of these fights do our sensors actually cover? Enemy hull
  // CONDITION is intel; enemy presence in a fight we are in is not.
  const covered = await coveredBodies(
    env, gameId, me, [...byBattle.values()].map(b => b.bodyId),
  );

  base.battles = [...byBattle.values()]
    .sort((a, b) => b.lastFire - a.lastFire)
    .slice(0, MAX_BATTLES)
    .map(bt => {
      const known = covered.has(bt.bodyId);
      const sides = [...bt.sides.values()]
        // Mine first, then whoever is hitting hardest, then whoever has
        // the most hulls there. Damage alone ranked a ten-freighter fleet
        // below a pair of corvettes, because freighters do not shoot --
        // but ten ships sitting in your fight is not nothing.
        .sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0)
          || b.damage - a.damage || b.alive - a.alive)
        .slice(0, MAX_SIDES)
        .map(sd => ({
          name: sd.mine ? 'YOU' : sd.name,
          color: sd.color,
          mine: sd.mine,
          alive: sd.alive,
          damage: Math.round(sd.damage),
          // WITHOUT COVERAGE THE PIPS STILL DRAW, in the unknown grey.
          // The size of a force is not a secret once it is shooting at
          // you; its condition is.
          // WITHOUT COVERAGE THE SHAPE STILL DRAWS and only the health
          // is withheld. A hull you can see shooting at you is not a
          // secret; how badly it is hurt is.
          hulls: (sd.mine || known
            ? sd.hulls
            : sd.hulls.map(h => ({ hp: null, cls: h.cls, variant: h.variant }))).slice(0, MAX_HULLS),
          hidden: Math.max(0, sd.hulls.length - MAX_HULLS),
        }));
      // bodyId: the watch opens the Porthole on it from a battle alert.
      return { body: bt.body, bodyId: bt.bodyId, sides, kills: bt.kills, lost: bt.lost, known };
    });

  // ---- threat board ----------------------------------------------------
  // Hostile ships in transit at a body you hold. Grouped by target, with
  // the soonest arrival, so the card reads as "VESTA 2 SHIPS IN 2T"
  // rather than as two identical lines.
  //
  // The treaty exclusion matches the main card inbound count exactly: a
  // signed NAP or defence pact means those ships are not a threat, and a
  // widget that cries wolf about an ally is worse than a silent one.
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
    eta: r.eta_tick == null ? null : Math.max(0, Number(r.eta_tick) - nowTick),
  }));

  return base;
}

/**
 * Which of these bodies this faction has patrol-or-better coverage of.
 *
 * BOUND IN CHUNKS OF 60. D1 caps a statement at 100 bound parameters,
 * not SQLite 999 ([[d1-bind-limit]]), and a player in a wide war can be
 * in more battles than a naive IN-list would survive.
 */
export async function coveredBodies(env, gameId, factionId, bodyIds) {
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

/** "IN 3T" / "NOW". Ticks, not minutes: the player plans in ticks, and
 *  a tick is the unit the arrival is actually recorded in. */
function eta(t) {
  if (t == null) return '?';
  return t <= 0 ? 'NOW' : `IN ${t}T`;
}

/** 1240 -> "1.2K". The font has no lowercase, hence the capital. */
function compact(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Render the battle card.
 *
 * UPPERCASE THROUGHOUT, because the bundled font is a 5x7 bitmap with no
 * lowercase glyphs. A missing glyph does not fall back, it vanishes, so
 * every string reaching drawText is upper-cased where it is built.
 */
export async function renderBattlePng(snap, { width = 512, height = 384 } = {}) {
  const W = width, H = height;
  const s = createSurface(W, H, GROUND);
  // The icons need the rasteriser. If it cannot start, the card still
  // draws -- names, counts, damage, the bar -- and simply leaves the
  // hull row empty rather than substituting some other picture of a
  // ship for the real one.
  const icons = await rasterReady();
  const accent = hexToRgb(snap.color);

  // Stops are [t, rgb, ALPHA]. A two-element stop interpolates undefined
  // and paints nothing at all.
  fillVGrad(s, 0, 0, W, H, [[0, [12, 16, 26], 1], [1, [6, 9, 15], 1]]);
  fillRect(s, 0, 0, 5, H, accent, 0.9);

  const pad = Math.round(W / 28);
  const left = pad + 8;
  const scale = Math.max(2, Math.round(W / 190));
  const small = Math.max(1, scale - 1);
  const line = small * 9;
  const cw = small * 6;                  // one glyph cell, for right-alignment

  let y = pad;

  // ---- header ----------------------------------------------------------
  drawText(s, 'BATTLE REPORT', left, y, scale, INK, 1);
  const right = snap.state === 'live' ? `T${snap.tick}`
    : snap.state === 'eliminated' ? 'ELIMINATED' : 'GAME OVER';
  drawText(s, right, W - pad, y + 2, small,
    snap.state === 'live' ? DIM : ALARM, 1, 'right');
  y += scale * 8;
  drawText(s, snap.faction.toUpperCase().slice(0, 24), left, y, small, DIM, 1);
  y += line + 6;
  drawLine(s, pad, y, W - pad, y, DIM, 0.25, 1);
  y += 10;

  if (snap.state !== 'live') {
    drawText(s, snap.state === 'eliminated' ? 'YOUR WAR IS OVER' : 'THE GAME HAS ENDED',
      left, y + 8, small, DIM, 0.9);
    return encodePng(s);
  }

  // ---- live battles -----------------------------------------------------
  if (snap.battles.length === 0) {
    drawText(s, 'NO SHOTS FIRED', left, y, small, GOOD, 0.85);
    y += line + 10;
  } else {
    // Ship icons sit in a 32-unit box whose drawing is wide and short,
    // so a row needs about two thirds of the icon width, not all of it.
    const rowH = Math.max(line + 6, Math.round(Math.max(16, Math.round(W / 17)) * 0.62) + 8);
    const barH = Math.max(5, Math.round(small * 4.5));
    // INBOUND keeps its heading and one line, and no more than that: on a
    // small card an early warning is worth two lines, not the fight.
    const floor = H - pad - (line * 2 + 14);
    let skippedBattles = 0;

    snap.battles.forEach((b, bi) => {
      // A BATTLE YOU ARE IN IS NEVER DROPPED WHOLE. The first version of
      // this cut any battle that would not fit completely -- and on the
      // short 4x2 card that was every battle, so a player in a four-way
      // fight saw a header and "NOTHING ON THE WAY". Silence reads as
      // "all quiet". Now a battle needs only its header, its bar and one
      // side to be drawn, and the sides that do not fit are counted.
      const headH = line + 2 + barH + 6;
      if (y + headH + rowH > floor) { skippedBattles = snap.battles.length - bi; return; }
      if (skippedBattles) return;

      // Header: the world, and what it has cost you so far.
      const tally = `${b.kills} KILLED  ${b.lost} LOST`;
      // Real bodies run long ("WEAPONS STATION SITE"). Fit what the row
      // has room for before the tally, and never leave a trailing space
      // where the cut fell between two words.
      const bodyRoom = Math.max(8, Math.floor((W - pad - left - (tally.length + 2) * cw) / cw));
      drawText(s, b.body.slice(0, bodyRoom).trimEnd(), left, y, small, INK, 1);
      drawText(s, tally, W - pad, y, small, b.lost > 0 ? WARN : DIM, 0.95, 'right');
      y += line + 2;

      // THE SHAPE OF THE FIGHT. One bar, split between the sides and
      // weighted by DAMAGE, not hull count: fifty freighters are not a
      // fleet. Thick, because it is the headline of the card and at a
      // couple of pixels it reads as a divider rather than as data.
      const barW = W - pad - left;
      fillRect(s, left, y, barW, barH, TROUGH, 1);
      const total = b.sides.reduce((n, x) => n + x.damage, 0);
      let bx = left;
      for (const side of b.sides) {
        // A side that has landed nothing yet still gets a share, or a
        // fight that has only just opened draws as one empty trough.
        const w = total > 0
          ? Math.max(3, Math.round((side.damage / total) * barW))
          : Math.round(barW / b.sides.length);
        fillRect(s, bx, y, Math.min(w, left + barW - bx), barH, hexToRgb(side.color), 0.95);
        bx += w;
        if (bx >= left + barW) break;
      }
      y += barH + 6;

      // One line per side: livery on the rail and the label, health on
      // the hulls. Never both on the same thing. Draw as many sides as
      // fit, keeping one line back to say how many did not.
      let shownSides = 0;
      for (const side of b.sides) {
        const moreAfter = b.sides.length - shownSides - 1;
        if (y + rowH + (moreAfter > 0 ? line : 0) > floor && shownSides > 0) break;
        const rail = hexToRgb(side.color);
        // A faint wash behind my own row, the way the log tints
        // .is-mine. It is the line a player looks for first.
        if (side.mine) fillRect(s, left, y - 3, W - pad - left, line + 1, rail, 0.06);
        fillRect(s, left, y - 3, 3, line + 1, rail, 0.95);

        // Sixteen, because that is what real empire names need: "THE WU
        // TANG CLAN" and "STONEKIN OF MARS" are exactly that long, and
        // fourteen cut both mid-word.
        const label = side.name.slice(0, 16).trimEnd();
        drawText(s, label, left + 9, y, small, side.mine ? INK : rail, 1);
        // The hull COUNT as well as the pips, because the pips cap out
        // and "+38" hanging on the end of a row of twelve is not a
        // number anybody adds up at a glance.
        const countX = left + 9 + (label.length + 1) * cw;
        drawText(s, String(side.alive), countX, y, small, DIM, 0.85);

        const dmg = compact(side.damage);
        drawText(s, dmg, W - pad, y, small, DIM, 0.9, 'right');

        // THE FLEET, as ships. One silhouette per standing hull, in the
        // class the game draws it in, painted by HEALTH. Laid from the
        // right so the row grows towards the name and can never collide
        // with it. Big enough for the outline to be an outline: below
        // about twelve pixels a destroyer and a corvette are the same
        // grey smudge, at which point dots would have been honester.
        // Sized to the CARD, not to the text scale: the text scale moves
        // in whole steps and left the icons at half the size the log
        // draws them. W/17 on a supersampled card comes out at about the
        // seventeen display pixels the situation log uses.
        const icon = Math.max(16, Math.round(W / 17));
        const step = icon + Math.max(2, Math.round(small));
        const stopAt = countX + String(side.alive).length * cw + 10;
        const startX = W - pad - dmg.length * cw - 14 - icon / 2;
        const cy = y + Math.round(small * 3.5);

        // HOW MANY FIT, decided before drawing, so that when they do not
        // all fit there is room left for the "+N" that says so. Deciding
        // it icon by icon filled the row to the last pixel and then had
        // nowhere to put the count: a real row of eight enemy ships drew
        // seven and said nothing about the eighth.
        const total = side.hulls.length + side.hidden;
        const leftEdge = n => startX - (n - 1) * step - icon / 2;
        let cap = 0;
        while (cap < side.hulls.length && leftEdge(cap + 1) >= stopAt) cap += 1;
        if (cap < total) {
          const labelW = n => (`+${total - n}`.length) * cw + 6;
          while (cap > 0 && leftEdge(cap) - labelW(cap) < stopAt) cap -= 1;
        }

        let px = startX;
        for (let k = 0; k < cap; k++) {
          const hull = side.hulls[k];
          if (icons) drawIcon(s, rasterIcon(iconKey(hull.cls, hull.variant, hull.hp), icon), px, cy);
          px -= step;
        }
        const extra = total - cap;
        if (extra > 0) {
          drawText(s, `+${extra}`, px + icon / 2 - 2, y, small, DIM, 0.85, 'right');
        }
        y += rowH;
        shownSides += 1;
      }
      const leftOut = b.sides.length - shownSides;
      if (leftOut > 0) {
        drawText(s, `+${leftOut} MORE SIDE${leftOut === 1 ? '' : 'S'}`, left + 9, y, small, DIM, 0.85);
        y += line;
      }
      y += 11;
    });

    // Battles that did not fit at all still exist, and the card says so
    // rather than letting the last one drawn stand for the whole war.
    if (skippedBattles > 0 && y + line <= floor + line) {
      drawText(s, `+${skippedBattles} MORE BATTLE${skippedBattles === 1 ? '' : 'S'}`,
        left, y, small, WARN, 0.9);
      y += line + 6;
    }
  }

  if (y + 10 < H - pad - line * 2) {
    drawLine(s, pad, y, W - pad, y, DIM, 0.2, 1);
    y += 10;
  }

  // ---- threat board ------------------------------------------------------
  drawText(s, 'INBOUND', left, y, small, DIM, 0.8);
  y += line + 4;

  if (snap.threats.length === 0) {
    drawText(s, 'NOTHING ON THE WAY', left, y, small, GOOD, 0.85);
  } else {
    for (const t of snap.threats) {
      if (y > H - line - pad) break;   // never draw off the bottom edge
      drawText(s, t.body.slice(0, 14), left, y, small, INK, 0.95);
      drawText(s, `${t.ships} SHIP${t.ships === 1 ? '' : 'S'}`,
        Math.round(W * 0.58), y, small, DIM, 0.95);
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
 * there is no session here and a bad one must 404 rather than 403 -- a
 * revoked token and a made-up one should be indistinguishable from
 * outside.
 */
export async function handleBattlePng(req, env, { params }) {
  const { resolveWidgetToken } = await import('./widget.js');
  const userId = await resolveWidgetToken(env, params.token);
  if (!userId) return new Response('no such widget', { status: 404 });

  const url = new URL(req.url);
  // The phone asks in DISPLAY units (dp) and shows the image across that
  // many dp on a screen two or three times denser. Rendered at 1x, every
  // icon arrived at a third of its pixels and was upscaled into mush --
  // which, for a card whose whole point is the ship icon, is the one
  // thing it cannot afford. The map card already supersamples 2x; this
  // matches it. 2x and not 3x because the widget decodes under a pixel
  // budget and would sample a 3x image straight back down.
  const SS = 2;
  const reqW = Math.max(240, Math.min(600, Number(url.searchParams.get('w')) || 256));
  const reqH = Math.max(120, Math.min(600, Number(url.searchParams.get('h')) || 192));
  const width = Math.min(1200, reqW * SS);
  const height = Math.min(1200, reqH * SS);

  // The WASM is loaded here and only here: resvgWasm.js imports a .wasm
  // file, which the Worker bundles and node cannot, so nothing shared
  // with the simulations may import it statically.
  try {
    const { default: wasm } = await import('./resvgWasm.js');
    configureRasterizer(wasm);
  } catch (e) {
    console.error('could not load the ship icon rasteriser', e);
  }

  const snap = await battleSnapshot(env, userId);
  const png = await renderBattlePng(snap ?? EMPTY_BATTLE_SNAP, { width, height });

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // Shorter than the main card minute. A battle is the one thing on
      // a home screen that is allowed to be a little expensive.
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
