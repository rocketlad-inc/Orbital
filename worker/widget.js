// ============================================================
// widget.js — your empire as a single image, for the phone's home screen.
//
// WHY THIS IS AN IMAGE AND NOT AN API. An Android home-screen widget is
// the one part of this app a Worker deploy cannot change: its layout
// lives in the APK, so every tweak would mean a store release. Ship a
// rendered PNG instead and the native side becomes four lines of "fetch
// this and show it" — after which the content, the layout, the colours
// and the information can all change from here, forever, with no
// release. The dumbness of the client is the feature.
//
// WHY A TOKEN AND NOT THE SESSION. The widget is native code running
// outside the Trusted Web Activity, so it cannot see the session cookie
// Chrome holds inside the app. It gets a capability of its own that does
// exactly one thing (see migration 0134): render this card. It cannot
// read messages, issue orders, or be exchanged for a session.
//
// WHAT IT SHOWS, and why not the Herald strip. The strip is a SHARED
// artefact, designed to be pasted into Discord and read by everyone in a
// game. A widget is the opposite: it is yours, it is glanced at, and it
// is competing for space with a photo of someone's dog. So this is the
// situation at a glance — what is burning, what is coming, what is
// waiting on you — which is the thing mobile play was worst at.
//
// Routes:
//   GET  /widget/<token>.png        the card (public, token-scoped)
//   GET  /api/me/widget-tokens      list your tokens
//   POST /api/me/widget-tokens      mint one
//   POST /api/me/widget-tokens/revoke
// ============================================================

import {
  createSurface, fillRect, fillVGrad, fillCircle, strokeCircle, drawLine,
  drawText, textWidth, encodePng, hexToRgb,
} from './heraldPng.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
const err = (status, code, message) => json({ error: { code, message } }, { status });

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------

/** 32 bytes of randomness, base64url. Long enough that the table can be
 *  probed forever without finding one. */
function newToken() {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function mintWidgetToken(env, userId, label = null) {
  const token = newToken();
  await env.DB
    .prepare('INSERT INTO widget_tokens (token, user_id, label, created_ms) VALUES (?, ?, ?, ?)')
    .bind(token, userId, label, Date.now())
    .run();
  return token;
}

/** The user this token speaks for, or null. Touches last_used_ms so a
 *  widget that has quietly stopped refreshing is visible server-side. */
export async function resolveWidgetToken(env, token) {
  const row = await env.DB
    .prepare('SELECT token, user_id, revoked_ms FROM widget_tokens WHERE token = ?')
    .bind(token).first();
  if (!row || row.revoked_ms != null) return null;
  try {
    await env.DB.prepare('UPDATE widget_tokens SET last_used_ms = ? WHERE token = ?')
      .bind(Date.now(), token).run();
  } catch { /* bookkeeping only; never fail the render over it */ }
  return row.user_id;
}

// ---------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------

/**
 * Everything the card shows, for one player.
 *
 * Deliberately its own queries rather than a call into
 * situationReport.js: that module's output is Discord embed fields —
 * markdown strings with emoji in them — and reading numbers back out of
 * formatted prose is the kind of coupling that breaks silently the first
 * time somebody rewords a line.
 *
 * ONE GAME, the most recently ticked active one. A player in three games
 * does not want three widgets fighting over a home screen, and the game
 * that just ticked is the one they are actually playing.
 */
export async function widgetSnapshot(env, userId) {
  const g = await env.DB
    .prepare(
      `SELECT g.id, g.current_tick, g.next_tick_at, g.tick_interval_ms, r.name AS game_name,
              f.id AS faction_id, f.name AS faction, f.color,
              f.metal, f.fuel, f.gold, f.science
         FROM game_factions f
         JOIN games g ON g.id = f.game_id
         JOIN rooms r ON r.id = g.id
        WHERE f.user_id = ? AND f.status = 'active' AND g.status = 'active'
        ORDER BY g.current_tick DESC
        LIMIT 1`,
    )
    .bind(userId).first();
  if (!g) return null;

  const gameId = g.id, me = g.faction_id, tick = g.current_tick ?? 0;
  const one = async (sql, ...bind) =>
    Number((await env.DB.prepare(sql).bind(...bind).first())?.n ?? 0);

  // Under fire: a live battle with one of your ships or settlements in it.
  const fighting = await one(
    `SELECT COUNT(DISTINCT b.id) AS n
       FROM battles b JOIN battle_participants p ON p.battle_id = b.id
      WHERE b.game_id = ?1 AND b.status = 'active' AND p.faction_id = ?2`,
    gameId, me,
  );

  // Inbound: hostile ships under way to somewhere you hold. Same shape as
  // the alert, minus the departure window — the card reports the STATE,
  // because a glance should answer "is anything coming" and not "did
  // something depart in the last three ticks".
  const inbound = await one(
    `SELECT COUNT(*) AS n
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
             AND s1.signed_at_tick IS NOT NULL AND s2.signed_at_tick IS NOT NULL)`,
    gameId, me,
  );

  const bills = await one(
    `SELECT COUNT(*) AS n FROM senate_proposals p
      WHERE p.game_id = ?1 AND p.status = 'voting'
        AND NOT EXISTS (SELECT 1 FROM senate_votes v
                         WHERE v.proposal_id = p.id AND v.faction_id = ?2)`,
    gameId, me,
  );
  const unread = await one(
    `SELECT COUNT(*) AS n FROM message_recipients mr
       JOIN messages m ON m.id = mr.message_id
      WHERE mr.faction_id = ?1 AND mr.read_at_ms IS NULL AND m.game_id = ?2`,
    me, gameId,
  );
  const offers = await one(
    `SELECT COUNT(*) AS n FROM trade_offers
      WHERE game_id = ?1 AND responder_faction_id = ?2 AND status = 'open'`,
    gameId, me,
  );

  return {
    game: String(g.game_name ?? 'Orbital'),
    faction: String(g.faction ?? ''),
    color: String(g.color || '#4ecdc4'),
    tick,
    nextTickAt: Number(g.next_tick_at ?? 0),
    metal: Math.round(Number(g.metal ?? 0)),
    fuel: Math.round(Number(g.fuel ?? 0)),
    gold: Math.round(Number(g.gold ?? 0)),
    science: Math.round(Number(g.science ?? 0)),
    fighting, inbound, bills, unread, offers,
  };
}

// ---------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------

const INK = [226, 236, 245];
const DIM = [125, 146, 166];
const ALARM = [255, 106, 96];
const WARN = [255, 202, 72];
const GROUND = [8, 12, 19];

/** Big numbers unreadable at a glance are the point of a widget, so 12400
 *  becomes 12.4K. The font has no lowercase, hence the capital K/M. */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** "IN 12M" / "IN 3H" — how long until the world changes under you. */
function untilNextTick(nextTickAt, now) {
  if (!nextTickAt) return '';
  const ms = nextTickAt - now;
  if (ms <= 0) return 'ANY MOMENT';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `IN ${mins}M`;
  return `IN ${Math.floor(mins / 60)}H ${mins % 60}M`;
}

/**
 * Render the card.
 *
 * Laid out for a 4x2 home-screen widget, which on most phones is roughly
 * 2:1. The whole thing is uppercase because the bundled font is a 5x7
 * bitmap with no lowercase glyphs — a constraint that happens to suit a
 * strategy game's console aesthetic, but a constraint nonetheless.
 */
export async function renderWidgetPng(snap, { width = 512, height = 256, now = Date.now() } = {}) {
  const W = width, H = height;
  const s = createSurface(W, H, GROUND);
  // hexToRgb always returns a triple — it falls back to grey internally
  // rather than returning null, so there is nothing to guard here.
  const accent = hexToRgb(snap.color);

  // Ground: a faint vertical lift, and the faction colour as a spine down
  // the left edge — the one piece of identity readable at a glance from
  // across a room.
  //
  // Gradient stops are [t, rgb, ALPHA] triples. Omitting the third
  // element does not default it: fillVGrad interpolates lo[2]..hi[2]
  // directly, so a two-element stop yields NaN and paints nothing.
  fillVGrad(s, 0, 0, W, H, [[0, [10, 15, 24], 1], [1, [6, 9, 15], 1]]);
  fillRect(s, 0, 0, 5, H, accent, 0.9);

  const pad = 18;
  const scale = Math.max(2, Math.round(W / 190));   // glyph cell scale
  const small = Math.max(1, scale - 1);

  // ---- header: faction, and the tick clock on the right --------------
  drawText(s, snap.faction.toUpperCase().slice(0, 18), pad, pad, scale, INK, 1);
  const clock = untilNextTick(snap.nextTickAt, now);
  if (clock) {
    drawText(s, clock, W - pad, pad + 2, small, DIM, 1, 'right');
  }
  drawText(s, `${snap.game.toUpperCase().slice(0, 22)} · T${snap.tick}`,
    pad, pad + scale * 9, small, DIM, 1);

  drawLine(s, pad, pad + scale * 9 + small * 12, W - pad, pad + scale * 9 + small * 12, DIM, 0.25, 1);

  // ---- resources -----------------------------------------------------
  const rowY = pad + scale * 9 + small * 12 + 14;
  const cols = [
    ['METAL', snap.metal, [176, 190, 205]],
    ['FUEL', snap.fuel, [255, 184, 77]],
    ['GOLD', snap.gold, [255, 214, 120]],
    ['SCI', snap.science, [126, 200, 255]],
  ];
  const colW = (W - pad * 2) / cols.length;
  cols.forEach(([label, value, rgb], i) => {
    const x = pad + colW * i;
    drawText(s, label, x, rowY, small, DIM, 1);
    drawText(s, compact(value), x, rowY + small * 10, scale, rgb, 1);
  });

  // ---- what needs you ------------------------------------------------
  //
  // Ordered by what costs you if ignored, not by count. Fighting first
  // because it is already happening; an unread message last because it
  // will still be there tomorrow.
  const flags = [];
  if (snap.fighting) flags.push([`${snap.fighting} BATTLE${snap.fighting === 1 ? '' : 'S'}`, ALARM]);
  if (snap.inbound) flags.push([`${snap.inbound} INBOUND`, ALARM]);
  if (snap.bills) flags.push([`${snap.bills} VOTE${snap.bills === 1 ? '' : 'S'}`, WARN]);
  if (snap.offers) flags.push([`${snap.offers} OFFER${snap.offers === 1 ? '' : 'S'}`, WARN]);
  if (snap.unread) flags.push([`${snap.unread} UNREAD`, DIM]);

  const flagY = rowY + small * 10 + scale * 9 + 16;
  if (!flags.length) {
    drawText(s, 'ALL QUIET', pad, flagY + 4, small, DIM, 0.8);
  } else {
    // Chips, wrapped. A widget that overflows its own edge looks broken
    // in a way a truncated list does not, so anything past the last
    // fitting row is dropped rather than clipped mid-glyph.
    let x = pad, y = flagY;
    const chipH = small * 9 + 10;
    for (const [text, rgb] of flags) {
      const w = textWidth(text, small) + 16;
      if (x + w > W - pad) { x = pad; y += chipH + 6; }
      if (y + chipH > H - 6) break;
      fillRect(s, x, y, w, chipH, rgb, 0.16);
      fillRect(s, x, y, 2, chipH, rgb, 0.9);
      drawText(s, text, x + 8, y + 5, small, rgb, 1);
      x += w + 6;
    }
  }

  // A quiet dot in the corner: proof the image is fresh rather than a
  // cached one from yesterday, without spending a line of text on it.
  fillCircle(s, W - 10, H - 10, 2.5, accent, 0.75);
  strokeCircle(s, W - 10, H - 10, 5, accent, 0.25, 1);

  return encodePng(s);
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

export const WIDGET_PNG_RE = /^\/widget\/([A-Za-z0-9_-]{8,64})\.png$/;

export async function handleWidgetPng(req, env, { params }) {
  const userId = await resolveWidgetToken(env, params.token);
  // 404 and not 403: a token that does not exist and a token that was
  // revoked should be indistinguishable from outside.
  if (!userId) return new Response('no such widget', { status: 404 });

  const url = new URL(req.url);
  const width = Math.max(240, Math.min(1200, Number(url.searchParams.get('w')) || 512));
  const height = Math.max(120, Math.min(800, Number(url.searchParams.get('h')) || 256));

  const snap = await widgetSnapshot(env, userId);
  const png = snap
    ? await renderWidgetPng(snap, { width, height })
    : await renderWidgetPng({
        game: 'NO ACTIVE GAME', faction: 'ORBITAL', color: '#4ecdc4', tick: 0,
        nextTickAt: 0, metal: 0, fuel: 0, gold: 0, science: 0,
        fighting: 0, inbound: 0, bills: 0, unread: 0, offers: 0,
      }, { width, height });

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // The widget refreshes on its own schedule; a short cache keeps a
      // burst of redraws from re-rendering, without ever showing
      // yesterday's empire.
      'cache-control': 'private, max-age=60',
      // This URL is a credential. Keep it out of shared caches and out
      // of any referrer sent onward.
      'referrer-policy': 'no-referrer',
    },
  });
}

async function handleList(_req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const rows = (await env.DB
    .prepare(
      `SELECT token, label, created_ms, last_used_ms FROM widget_tokens
        WHERE user_id = ? AND revoked_ms IS NULL ORDER BY created_ms DESC`,
    )
    .bind(session.user_id).all()).results ?? [];
  return json({ ok: true, tokens: rows });
}

async function handleMint(req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  let body = {};
  try { body = await req.json(); } catch { /* label is optional */ }
  const label = typeof body.label === 'string' ? body.label.slice(0, 40) : null;
  const token = await mintWidgetToken(env, session.user_id, label);
  return json({ ok: true, token, url: `/widget/${token}.png` });
}

async function handleRevoke(req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  // Scoped by user_id as well as token: knowing someone else's token must
  // not be enough to revoke it, or the id becomes a griefing tool.
  const res = await env.DB
    .prepare('UPDATE widget_tokens SET revoked_ms = ? WHERE token = ? AND user_id = ? AND revoked_ms IS NULL')
    .bind(Date.now(), String(body.token ?? ''), session.user_id)
    .run();
  return json({ ok: true, revoked: (res.meta?.changes ?? 0) > 0 });
}

export const routes = [
  { method: 'GET', pattern: /^\/api\/me\/widget-tokens$/, auth: 'required', handle: handleList },
  { method: 'POST', pattern: /^\/api\/me\/widget-tokens$/, auth: 'required', handle: handleMint },
  { method: 'POST', pattern: /^\/api\/me\/widget-tokens\/revoke$/, auth: 'required', handle: handleRevoke },
];
