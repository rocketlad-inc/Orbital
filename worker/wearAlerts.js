// ============================================================
// The watch's own alerts.
//
// WHY NOT JUST MIRROR THE PHONE. Wear OS mirrors a phone notification as
// a copy: it can only open the PHONE, its buttons run on the phone, and
// a player with a watch app built for exactly these moments was being
// sent to their pocket for every one of them. So the watch gets its own
// transport, beside push and Discord:
//
//   notify.sendDm  ->  recordWatchAlert  ->  wear_alerts row
//   watch          ->  GET /wear/<t>/alerts.json?after=<id>  -> posts it
//   watch button   ->  POST /wear/<t>/act  (notifyActions.runAct)
//
// Each row carries the SCREEN it belongs to, so a tap opens the watch
// app on the Porthole of the world under fire, the Senate page, Comms --
// not the game's front door. And each row names its SUBJECT (a battle,
// a bill, a trade, a message), which lets the feed tell the watch what
// has been dealt with since -- voted on the phone, answered in the
// browser, the fight over -- so its notifications clear themselves.
//
// THE WATCH COLLECTS; THE SERVER DOES NOT PUSH. Reaching a watch
// directly needs Firebase messaging, which this project has no account
// for yet. The watch polls this feed every fifteen minutes and wakes
// itself about ninety seconds after each tick, and turns are an hour
// long -- so turn, battle and senate alerts land within minutes of the
// tick that caused them. A mid-turn message waits at most fifteen.
// ============================================================

import { authorizeWear } from './wear.js';

export const WEAR_ALERTS_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/alerts\.json$/;

/** What a tap on each kind of alert opens, when its producer did not say.
 *  The watch maps these names to its own pages (MainActivity). */
const SCREEN_BY_CATEGORY = {
  combat: 'battles',
  inbound: 'systems',
  senate: 'senate',
  dm: 'comms',
  trade: 'comms',
  market: 'comms',
  economy: 'empire',
  turn: 'empire',
  digest: 'empire',
  nudge: 'empire',
  security: 'empire',
};
const SCREENS = new Set([
  'empire', 'battles', 'senate', 'systems', 'territory', 'comms', 'yards', 'porthole',
]);

/** Alerts are delivered only while they are still news. A watch that was
 *  off all night does not want eight turn lines at breakfast. */
const FRESH_MS = 12 * 3600 * 1000;
const FRESH_TURN_MS = 2 * 3600 * 1000;
const KEEP_MS = 3 * 86400 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Discord markdown to plain text, as the phone does it (push.js). */
function plain(s) {
  return String(s ?? '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * The thing an alert is ABOUT, read off its dedupe key -- which every
 * producer already names after its event. Only the kinds the feed can
 * later tell are finished get a subject.
 */
function subjectOf(dedupeKey) {
  const k = String(dedupeKey ?? '');
  let m;
  if ((m = k.match(/^battle:(.+)$/))) return `battle:${m[1]}`;
  if ((m = k.match(/^(?:voteclose|billnew):(.+)$/))) return `bill:${m[1]}`;
  if ((m = k.match(/^trade:(.+)$/))) return `trade:${m[1]}`;
  if ((m = k.match(/^msg:([^:]+):/))) return `msg:${m[1]}`;
  return null;
}

/**
 * Record one alert for the watch, if this player has one and wants it.
 *
 * Called from notify.sendDm for every alert, so it must be cheap for the
 * many players with no watch: one indexed lookup and out.
 */
export async function recordWatchAlert(env, opts) {
  const { userId, category, dedupeKey = null, embed = {}, actions = [], gameId = null } = opts;
  if (!userId || !category) return { recorded: false, reason: 'bad_request' };

  // Only a paired WATCH counts. The desktop panel holds a wear_orders
  // token too, but it has nothing to post a notification to.
  const watch = await env.DB
    .prepare(
      `SELECT 1 AS x FROM widget_tokens
        WHERE user_id = ? AND label = 'watch' AND scope IN ('wear', 'wear_orders')
          AND revoked_ms IS NULL LIMIT 1`,
    )
    .bind(userId).first();
  if (!watch) return { recorded: false, reason: 'no_watch' };

  const { categoryEnabled } = await import('./notify.js');
  if (!(await categoryEnabled(env, userId, category, 'watch'))) {
    return { recorded: false, reason: 'opted_out' };
  }

  const asked = opts.watch?.screen;
  const screen = SCREENS.has(asked) ? asked : (SCREEN_BY_CATEGORY[category] ?? 'empire');
  const title = plain(embed.title).slice(0, 90) || 'Orbital';
  const body = plain(embed.description).slice(0, 400);
  // Three buttons fit on a watch card where Android's phone shade takes
  // two; the verbs are the phone's, unchanged.
  const acts = (actions ?? []).slice(0, 3).map(a => ({
    id: String(a.id),
    label: String(a.label),
    ...(a.reply ? { reply: true } : {}),
    verb: a.verb,
  }));

  const res = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO wear_alerts
         (user_id, game_id, category, dedupe_key, subject, title, body, screen, ref, actions, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId, gameId, category, dedupeKey, subjectOf(dedupeKey), title, body, screen,
      opts.watch?.ref != null ? String(opts.watch.ref) : null,
      acts.length ? JSON.stringify(acts) : null,
      Date.now(),
    )
    .run();
  return { recorded: (res?.meta?.changes ?? 0) > 0 };
}

/**
 * GET /wear/<token>/alerts.json?after=<id>
 *
 *   { latest, alerts: [...new since `after`], resolved: [alert ids] }
 *
 * WITHOUT `after` it only answers `latest`: a watch paired for the first
 * time starts from now instead of replaying the last three days.
 */
export async function handleWearAlerts(req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;
  const userId = auth.userId;
  const now = Date.now();

  await env.DB.prepare('DELETE FROM wear_alerts WHERE user_id = ? AND created_ms < ?')
    .bind(userId, now - KEEP_MS).run().catch(() => {});

  const url = new URL(req.url);
  const afterRaw = url.searchParams.get('after');
  if (afterRaw == null || !/^\d+$/.test(afterRaw)) {
    const row = await env.DB.prepare('SELECT MAX(id) AS id FROM wear_alerts WHERE user_id = ?')
      .bind(userId).first();
    return json({ ok: true, latest: Number(row?.id ?? 0), alerts: [], resolved: [] });
  }
  const after = Number(afterRaw);

  const rows = (await env.DB
    .prepare(
      `SELECT id, game_id, category, subject, title, body, screen, ref, actions, created_ms
         FROM wear_alerts WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 40`,
    )
    .bind(userId, after).all()).results ?? [];
  const latest = rows.length ? Number(rows[rows.length - 1].id) : after;

  const alerts = rows
    .filter(r => now - Number(r.created_ms) < (r.category === 'turn' ? FRESH_TURN_MS : FRESH_MS))
    .map(r => {
      let actions = [];
      try { actions = r.actions ? JSON.parse(r.actions) : []; } catch { actions = []; }
      return {
        id: Number(r.id),
        cat: r.category,
        title: r.title,
        body: r.body,
        screen: r.screen,
        ref: r.ref,
        at: Number(r.created_ms),
        actions,
      };
    });

  const resolved = await resolvedIds(env, userId, now).catch(e => {
    console.error('wear alerts: resolve failed', e);
    return [];
  });
  return json({ ok: true, latest, alerts, resolved });
}

/**
 * Which of the last day's alerts are finished: the battle over, the
 * offer answered, the bill voted on or closed, the message read. The
 * watch cancels these wherever the player actually acted.
 */
async function resolvedIds(env, userId, now) {
  const recent = (await env.DB
    .prepare(
      `SELECT id, subject FROM wear_alerts
        WHERE user_id = ? AND subject IS NOT NULL AND created_ms > ?
        ORDER BY id DESC LIMIT 80`,
    )
    .bind(userId, now - 86400000).all()).results ?? [];
  if (!recent.length) return [];

  const by = { battle: new Map(), bill: new Map(), trade: new Map(), msg: new Map() };
  for (const r of recent) {
    const i = String(r.subject).indexOf(':');
    const kind = String(r.subject).slice(0, i);
    const ref = String(r.subject).slice(i + 1);
    if (!by[kind]) continue;
    if (!by[kind].has(ref)) by[kind].set(ref, []);
    by[kind].get(ref).push(Number(r.id));
  }

  // Each list is at most 80 long, under D1's 100-parameter ceiling.
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');
  const done = new Set();
  const mark = (map, refs) => { for (const ref of refs) for (const id of map.get(String(ref)) ?? []) done.add(id); };

  if (by.battle.size) {
    const ids = [...by.battle.keys()];
    const live = new Set(((await env.DB
      .prepare(`SELECT id FROM battles WHERE status = 'active' AND id IN (${marks(ids.length)})`)
      .bind(...ids).all()).results ?? []).map(r => String(r.id)));
    mark(by.battle, ids.filter(id => !live.has(id)));
  }
  if (by.trade.size) {
    const ids = [...by.trade.keys()];
    const open = new Set(((await env.DB
      .prepare(`SELECT id FROM trade_offers WHERE status = 'open' AND id IN (${marks(ids.length)})`)
      .bind(...ids).all()).results ?? []).map(r => String(r.id)));
    mark(by.trade, ids.filter(id => !open.has(id)));
  }
  if (by.bill.size) {
    const ids = [...by.bill.keys()];
    // Still askable: in debate or voting, and not yet past its close.
    const live = new Set(((await env.DB
      .prepare(
        `SELECT p.id FROM senate_proposals p JOIN games g ON g.id = p.game_id
          WHERE p.status IN ('debating', 'voting') AND g.current_tick < p.vote_closes_at_tick
            AND p.id IN (${marks(ids.length)})`,
      )
      .bind(...ids).all()).results ?? []).map(r => String(r.id)));
    const voted = new Set(((await env.DB
      .prepare(
        `SELECT v.proposal_id AS id FROM senate_votes v
           JOIN game_factions f ON f.id = v.faction_id
          WHERE f.user_id = ? AND v.proposal_id IN (${marks(ids.length)})`,
      )
      .bind(userId, ...ids).all()).results ?? []).map(r => String(r.id)));
    mark(by.bill, ids.filter(id => !live.has(id) || voted.has(id)));
  }
  if (by.msg.size) {
    const ids = [...by.msg.keys()];
    const read = ((await env.DB
      .prepare(
        `SELECT mr.message_id AS id FROM message_recipients mr
           JOIN game_factions f ON f.id = mr.faction_id
          WHERE f.user_id = ? AND mr.read_at_ms IS NOT NULL AND mr.message_id IN (${marks(ids.length)})`,
      )
      .bind(userId, ...ids).all()).results ?? []).map(r => String(r.id));
    mark(by.msg, read);
  }
  return [...done];
}
