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
// ONE CARD THAT ANSWERS BOTH QUESTIONS. The map — the Herald's own
// territory strip, the same drawing it posts to Discord — says how the
// war is going and nothing about you. A status card says what is waiting
// on you and shows none of the system. A widget gets one glance, so the
// default draws the status bar straight onto the map's own surface.
//
// Each half stays reachable on its own path, because at a small widget
// size the map's small print stops being legible and the status card is
// the better trade. All of them hang off ONE token: a player sets this
// up once.
//
// The map is the Herald's renderer, never a widget-sized lookalike. Two
// drawings of the same map drift apart, and the first thing to go would
// be a faction colour, which is the one thing the map is for.
//
// Routes:
//   GET  /widget/<token>.png        map + your status bar (the one to use)
//   GET  /widget/<token>/card.png   status only, for small widget sizes
//   GET  /widget/<token>/map.png    the Herald territory strip, unadorned
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
 * ONE GAME. A player in three games does not want three widgets fighting
 * over a home screen.
 *
 * CHOOSING IT IS NOT "the live one", because that is frequently nothing.
 * The first version required an active faction in an active game and
 * showed NO ACTIVE GAME to a real player with three games to his name —
 * two finished with his faction still standing, one still running after
 * he was knocked out. Neither half of that pair is rare: games end, and
 * players get eliminated from games that carry on without them.
 *
 * So the rule is "the game you would most want to look at": a live one
 * you are still playing wins outright, then any live one, then whatever
 * you touched last. A card that says ELIMINATED is informative; a card
 * that says NO ACTIVE GAME to someone with three is just broken.
 */
export async function widgetSnapshot(env, userId) {
  const g = await env.DB
    .prepare(
      `SELECT g.id, g.current_tick, g.next_tick_at, g.tick_interval_ms, r.name AS game_name,
              f.id AS faction_id, f.name AS faction, f.color, f.status AS faction_status,
              g.status AS game_status, f.metal, f.gold, f.science
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

  // 'live' is the only state where the counts below mean anything: an
  // eliminated faction has nothing to act on, and a finished game cannot
  // be acted on at all. Querying them anyway and rendering "1 VOTE" on a
  // game that ended in April would be a lie with a tap target on it.
  const state = g.game_status !== 'active' ? 'ended'
    : g.faction_status !== 'active' ? 'eliminated'
    : 'live';

  const gameId = g.id, me = g.faction_id, tick = g.current_tick ?? 0;
  const one = async (sql, ...bind) =>
    state !== 'live' ? 0
      : Number((await env.DB.prepare(sql).bind(...bind).first())?.n ?? 0);

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
    gameId,
    game: String(g.game_name ?? 'Orbital'),
    faction: String(g.faction ?? ''),
    color: String(g.color || '#4ecdc4'),
    state,
    tick,
    // Only a live game has a next tick. Counting down to one on a game
    // that ended in April is the kind of detail that makes a player
    // distrust everything else on the card.
    nextTickAt: state === 'live' ? Number(g.next_tick_at ?? 0) : 0,
    // THREE RESOURCES, NOT FOUR. game_factions still carries a `fuel`
    // column and it is dead — TopBar.tsx removed the pill outright
    // ("fuel is dead"), and every one of the 55 factions on prod has it
    // at exactly 0. Reading the schema and assuming every numeric column
    // is a live currency put a dead mechanic back on the home screen.
    // The player-facing name for `gold` is CREDITS (EconomyPanel's
    // RES_ORDER is ['metal','credits','science']), so the card says CR.
    metal: Math.round(Number(g.metal ?? 0)),
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
  const sub = snap.state === 'none'
    ? snap.game.toUpperCase().slice(0, 26)
    : `${snap.game.toUpperCase().slice(0, 22)} · T${snap.tick}`;
  drawText(s, sub, pad, pad + scale * 9, small, DIM, 1);

  drawLine(s, pad, pad + scale * 9 + small * 12, W - pad, pad + scale * 9 + small * 12, DIM, 0.25, 1);

  // ---- resources -----------------------------------------------------
  const rowY = pad + scale * 9 + small * 12 + 14;
  const cols = [
    ['METAL', snap.metal, [176, 190, 205]],
    ['CREDITS', snap.gold, [255, 214, 120]],
    ['SCIENCE', snap.science, [126, 200, 255]],
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
  // State first and alone when the game is not live. "ELIMINATED" is the
  // only thing worth saying on that card, and it is worth saying clearly
  // rather than leaving a player to infer it from an empty row.
  if (snap.state === 'eliminated') flags.push(['ELIMINATED', ALARM]);
  else if (snap.state === 'ended') flags.push(['GAME OVER', DIM]);
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

/**
 * The one worth putting on a home screen: the map, with your own status
 * painted over its footer.
 *
 * Neither half is sufficient alone. The map answers "how is the war
 * going" and says nothing about you; the card answers "what do I have to
 * do" and shows none of the system. A widget gets one glance, so it
 * should answer both.
 *
 * It draws ONTO the Herald's own surface rather than compositing two
 * images. There is one drawing of this map and there will continue to be
 * one — a widget-sized lookalike would drift, and the first thing to go
 * would be a faction colour, which is the thing the map is for.
 *
 * EVERYTHING HERE IS IN DEVICE PIXELS. The strip supersamples 2x, so the
 * surface is twice the layout size it was asked for; laying this bar out
 * in the requested W/H would draw it at half scale in the corner.
 */
export async function renderCombinedPng(env, snap, { width = 512, height = 384, now = Date.now() } = {}) {
  const { renderStripPng } = await import('./heraldStrip.js');

  // Lay the map out SHORTER than the card and give the bar its own
  // space, rather than painting over the bottom of the map. Overlaying
  // was the first attempt and it ate Jupiter.
  //
  // The bar is a FIXED height, not a percentage. It carries two short
  // lines and nothing else, so a proportional bar is mostly empty on a
  // tall card while still crushing the map on a short one.
  const BAR = Math.max(48, Math.min(72, Math.round(height * 0.22)));
  const mapH = height - BAR;
  const sMap = await renderStripPng(env, snap.gameId, { width, height: mapH, surface: true });
  if (!sMap) return null;

  // The strip supersamples, so its surface is 2x the layout it was given.
  // Everything below is in DEVICE pixels; deriving the scale from what
  // came back means this keeps working if the strip ever changes SS.
  const SS = Math.max(1, Math.round(sMap.w / width));
  const W = sMap.w, H = height * SS, barTop = sMap.h;
  const s = createSurface(W, H, GROUND);
  // Widths match, so the map copies in as one contiguous run.
  s.data.set(sMap.data, 0);

  const accent = hexToRgb(snap.color);
  const pad = Math.round(W * 0.018);
  const barH = H - barTop;

  drawLine(s, 0, barTop, W, barTop, accent, 0.55, 2);
  fillRect(s, 0, barTop, 5, barH, accent, 0.95);

  const big = Math.max(2, Math.round(W / 300));
  const small = Math.max(2, big - 1);

  // Row 1 — who, and when the world next changes.
  drawText(s, snap.faction.toUpperCase().slice(0, 20), pad + 10,
    barTop + Math.round(barH * 0.14), big, INK, 1);
  const clock = snap.state === 'live' ? untilNextTick(snap.nextTickAt, now)
    : snap.state === 'eliminated' ? 'ELIMINATED' : 'GAME OVER';
  if (clock) {
    drawText(s, clock, W - pad, barTop + Math.round(barH * 0.17), small,
      snap.state === 'live' ? DIM : ALARM, 1, 'right');
  }

  // Row 2 — the numbers on the left, what is waiting on the right.
  const y2 = barTop + Math.round(barH * 0.60);
  let x = pad + 10;
  for (const [k, v, rgb] of [
    ['METAL', snap.metal, [176, 190, 205]],
    ['CR', snap.gold, [255, 214, 120]],
    ['SCI', snap.science, [126, 200, 255]],
  ]) {
    drawText(s, k, x, y2, small, DIM, 0.85);
    x += textWidth(k, small) + 4;
    const t = compact(v);
    drawText(s, t, x, y2, small, rgb, 1);
    x += textWidth(t, small) + Math.round(W * 0.022);
  }

  const flags = [];
  if (snap.fighting) flags.push([`${snap.fighting} BATTLE${snap.fighting === 1 ? '' : 'S'}`, ALARM]);
  if (snap.inbound) flags.push([`${snap.inbound} INBOUND`, ALARM]);
  if (snap.bills) flags.push([`${snap.bills} VOTE${snap.bills === 1 ? '' : 'S'}`, WARN]);
  if (snap.offers) flags.push([`${snap.offers} OFFER${snap.offers === 1 ? '' : 'S'}`, WARN]);
  if (snap.unread) flags.push([`${snap.unread} UNREAD`, DIM]);

  // Right-aligned as a GROUP but drawn in priority order, so the most
  // urgent reads first left-to-right. Placing them one at a time from
  // the right edge reverses that and puts UNREAD ahead of BATTLES.
  // Lowest priority is dropped when the row runs out of room; the bar
  // never grows a second line, because that would eat the map.
  const chipW = (t) => textWidth(t, small) + 14;
  const fit = [...flags];
  const roomFrom = x + 8;
  while (fit.length) {
    const total = fit.reduce((n, [t]) => n + chipW(t) + 6, -6);
    if (W - pad - total >= roomFrom) break;
    fit.pop();
  }
  let cx = W - pad - fit.reduce((n, [t]) => n + chipW(t) + 6, -6);
  for (const [text, rgb] of fit) {
    const w = chipW(text);
    fillRect(s, cx, y2 - 5, w, small * 9 + 10, rgb, 0.18);
    fillRect(s, cx, y2 - 5, 2, small * 9 + 10, rgb, 0.95);
    drawText(s, text, cx + 7, y2, small, rgb, 1);
    cx += w + 6;
  }

  return encodePng(s);
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

export const WIDGET_PNG_RE = /^\/widget\/([A-Za-z0-9_-]{8,64})\.png$/;
/** The map. A separate path rather than a ?view= on the card, because
 *  the Android side addresses a widget by URL and two widget types
 *  should not differ by a query string somebody can drop. */
export const WIDGET_MAP_RE = /^\/widget\/([A-Za-z0-9_-]{8,64})\/map\.png$/;
/** Status only. Its own path for the same reason as the map: the Android
 *  side addresses a widget by URL, and a widget type that differs by a
 *  query string is one somebody can drop half of. */
export const WIDGET_CARD_RE = /^\/widget\/([A-Za-z0-9_-]{8,64})\/card\.png$/;

export async function handleWidgetPng(req, env, { params, statusOnly = false }) {
  const userId = await resolveWidgetToken(env, params.token);
  // 404 and not 403: a token that does not exist and a token that was
  // revoked should be indistinguishable from outside.
  if (!userId) return new Response('no such widget', { status: 404 });

  const url = new URL(req.url);
  const width = Math.max(240, Math.min(1200, Number(url.searchParams.get('w')) || 512));
  // TALLER BY DEFAULT than the status card was. The strip lays out for
  // roughly 1.25:1 and degrades badly when squashed — at 512x256 the
  // moon counts collide with the moons. Giving the map a 4:3 card keeps
  // its own layout honest, and a 4x4 home-screen slot is the shape this
  // wants anyway.
  const height = Math.max(120, Math.min(800,
    Number(url.searchParams.get('h')) || (statusOnly ? 256 : 384)));

  const snap = await widgetSnapshot(env, userId);

  // THE DEFAULT IS THE COMBINED CARD, because a widget gets one glance
  // and neither half answers the whole question. The status-only card
  // stays reachable at /card.png for the small widget sizes where the
  // map's small print stops being legible.
  let png = null;
  if (snap && !statusOnly) {
    try {
      png = await renderCombinedPng(env, snap, { width, height });
    } catch (e) {
      // A map that will not draw must not cost the player their widget;
      // the status half alone is still worth showing.
      console.error('combined widget render failed', e);
    }
  }
  if (!png) png = await renderWidgetPng(snap ?? EMPTY_SNAP, { width, height });

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

/** A brand new account with no factions at all. Anything else, including
 *  eliminated and finished games, reaches a real card with a state chip. */
const EMPTY_SNAP = {
  gameId: null, game: 'NOT IN A GAME YET', faction: 'ORBITAL', color: '#4ecdc4',
  state: 'none', tick: 0, nextTickAt: 0, metal: 0, gold: 0, science: 0,
  fighting: 0, inbound: 0, bills: 0, unread: 0, offers: 0,
};

/**
 * The Herald's territory strip, for whichever game this token's owner is
 * in — the map of the whole system, region by region, in faction colour.
 *
 * WHY IT NEEDS A TOKEN WHEN THE STRIP IS ALREADY PUBLIC. The strip lives
 * at /herald/<gameId>/strip.png and anyone may read it; what is private
 * is WHICH GAME to render. A widget cannot know a game id — the person
 * setting it up is holding a phone, not a database — so the token is
 * doing the same job it does for the card: turning "me" into "this
 * game", without the native side ever learning either.
 *
 * Deliberately the same renderer the Herald posts to Discord rather than
 * a widget-sized lookalike. Two drawings of the same map drift, and the
 * strip supersamples 2x already, so a 512x256 request yields a 1024x512
 * file — which is exactly what a high-density phone wants.
 */
export async function handleWidgetMapPng(req, env, { params }) {
  const userId = await resolveWidgetToken(env, params.token);
  if (!userId) return new Response('no such widget', { status: 404 });

  const snap = await widgetSnapshot(env, userId);
  if (!snap) return new Response('not in a game', { status: 404 });

  const url = new URL(req.url);
  const width = Math.max(320, Math.min(1400, Number(url.searchParams.get('w')) || 512));
  const height = Math.max(220, Math.min(1000, Number(url.searchParams.get('h')) || 256));

  const { renderStripPng } = await import('./heraldStrip.js');
  const png = await renderStripPng(env, snap.gameId, { width, height });
  if (!png) return new Response('no map for that game', { status: 404 });

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=60',
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
