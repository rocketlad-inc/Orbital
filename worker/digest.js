// ============================================================
// Daily Discord digest — "The Orbital Herald"
//
// Reads chronicle_entries since the last digest and posts a
// news-report-style embed to a Discord webhook. Zero cost, zero
// email infrastructure: the playtest group lives in Discord.
//
// Wiring:
//   - env.DISCORD_DIGEST_WEBHOOK  (worker secret) — the webhook URL.
//     No secret set = digest silently disabled.
//   - maybeRunDailyDigest(env) is called from the every-minute cron
//     in worker/index.js. It self-gates: fires only when the UTC hour
//     matches DIGEST_HOUR_UTC and the game hasn't been digested in
//     the last 20 hours (idempotent across cron re-fires).
//   - digest_state table (migration 0034) tracks the per-game
//     high-water mark so each digest covers exactly the window since
//     the previous one.
//
// Tone: in-world news bulletin. Headlines pulled from the chronicle
// payload's pre-formatted `message` where present; grouped into
// sections (battles / colonies / discoveries / industry / politics).
// ============================================================

/** UTC hour to publish. 21:00 UTC ≈ 4-5pm US Eastern — evening
 *  reading for a NA playtest group. */
const DIGEST_HOUR_UTC = 21;

/** Re-fire guard: minimum ms between digests for one game. 20h (not
 *  24) so a slightly-late cron never skips a calendar day. */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** First-ever digest lookback. Without a high-water mark we take the
 *  trailing 24h, not the whole game history. */
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Section cap — keep embeds readable + inside Discord's 1024-char
 *  field limit. Overflow becomes "…and N more". */
const MAX_LINES_PER_SECTION = 6;

// Chronicle kind -> section routing.
const SECTION_OF_KIND = {
  ship_destroyed:       'battles',
  settlement_destroyed: 'battles',
  asteroid_impact:      'battles',
  asteroid_launched:    'battles',
  settlement_built:     'colonies',
  body_claimed:         'colonies',
  faction_joined:       'colonies',
  secret_discovered:    'discoveries',
  ship_built:           'industry',
  building_completed:   'industry',
  treaty_signed:        'politics',
  treaty_broken:        'politics',
  senate_vote:          'politics',
  declaration:          'politics',
  victory:              'victory',
  faction_eliminated:   'victory',
};

const SECTION_META = {
  battles:     { title: '⚔️  From the front lines', color: 0xff5e5e },
  colonies:    { title: '🏙️  Expansion report',     color: 0x4ecdc4 },
  discoveries: { title: '✨  Dispatches from deep space', color: 0x67e8f9 },
  industry:    { title: '🏗️  Industry & shipping',  color: 0xffb84d },
  politics:    { title: '🏛️  Halls of the Senate',  color: 0xc4b5fd },
  victory:     { title: '👑  History in the making', color: 0xffd700 },
};

/** Turn one chronicle row into a headline line. Prefers the payload's
 *  pre-formatted message (room.js writes rich flavor text for
 *  discoveries etc.); falls back to a kind-templated line. */
function headline(row, factionNames) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}') || {}; } catch { /* keep {} */ }
  if (typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message.length > 180 ? payload.message.slice(0, 177) + '…' : payload.message;
  }
  const actor = factionNames.get(row.actor_faction_id) ?? 'An unknown power';
  const target = factionNames.get(row.target_faction_id) ?? null;
  switch (row.kind) {
    case 'ship_destroyed':       return target ? `${actor} destroyed a ${target} vessel.` : `${actor} lost a vessel.`;
    case 'settlement_destroyed': return target ? `${actor} razed a ${target} settlement.` : `A settlement burned.`;
    case 'settlement_built':     return `${actor} founded a new settlement.`;
    case 'body_claimed':         return `${actor} planted a flag on a new world.`;
    case 'faction_joined':       return `${actor} has entered the system.`;
    case 'secret_discovered':    return `${actor} uncovered something ancient.`;
    case 'ship_built':           return `${actor} launched a new hull.`;
    case 'building_completed':   return `${actor} completed a construction project.`;
    case 'asteroid_launched':    return `${actor} set a rock on a collision course.`;
    case 'asteroid_impact':      return `An asteroid found its mark.`;
    case 'treaty_signed':        return target ? `${actor} and ${target} signed an accord.` : `${actor} signed an accord.`;
    case 'treaty_broken':        return target ? `${actor} tore up their pact with ${target}.` : `${actor} broke a pact.`;
    case 'senate_vote':          return `The Senate has ruled.`;
    case 'victory':              return `${actor} stands victorious.`;
    case 'faction_eliminated':   return `${actor} has fallen.`;
    default:                     return `${actor}: ${row.kind.replace(/_/g, ' ')}.`;
  }
}

/** Build the embed for one game. Returns null when the day was
 *  entirely uneventful (no entries + no trades) so we skip the post
 *  rather than spam "nothing happened". */
function composeEmbed(gameName, tick, rows, factionNames, tradesDelta) {
  const sections = new Map();
  for (const row of rows) {
    const key = SECTION_OF_KIND[row.kind];
    if (!key) continue;                    // unknown kind — skip quietly
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(headline(row, factionNames));
  }

  if (sections.size === 0 && tradesDelta <= 0) return null;

  const fields = [];
  // Fixed section order: victory first (it's the headline of headlines),
  // then battles, politics, discoveries, colonies, industry.
  for (const key of ['victory', 'battles', 'politics', 'discoveries', 'colonies', 'industry']) {
    const lines = sections.get(key);
    if (!lines || lines.length === 0) continue;
    const shown = lines.slice(0, MAX_LINES_PER_SECTION);
    const more = lines.length - shown.length;
    let value = shown.map(l => `• ${l}`).join('\n');
    if (more > 0) value += `\n…and ${more} more.`;
    // Discord hard limit: 1024 chars per field value.
    if (value.length > 1020) value = value.slice(0, 1017) + '…';
    fields.push({ name: SECTION_META[key].title, value });
  }

  if (tradesDelta > 0) {
    fields.push({
      name: '📦  Trade ledger',
      value: `${tradesDelta} freighter deliver${tradesDelta === 1 ? 'y' : 'ies'} completed across all routes.`,
    });
  }

  // Accent colour: red if there was fighting, gold if victory, cyan calm.
  const color = sections.has('victory') ? SECTION_META.victory.color
    : sections.has('battles') ? SECTION_META.battles.color
    : SECTION_META.colonies.color;

  return {
    title: `🗞️  The Orbital Herald — ${gameName}`,
    description: `*All the news from tick T+${tick}. Reporting from across the system.*`,
    color,
    fields,
    footer: { text: 'Daily digest · The Orbital Herald' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Digest one game. Shared by the daily cron and the host's
 * "publish now" button.
 *
 * @param game  { id, current_tick, name }
 * @param opts.force  true = skip the once-per-day interval gate AND
 *   post a "quiet day" edition when there's nothing to report (the
 *   button should always visibly do something); the cron leaves both
 *   behaviors off.
 * @returns {posted: boolean, events: number, reason?: string}
 */
export async function runDigestForGame(env, game, { force = false } = {}) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return { posted: false, events: 0, reason: 'webhook_not_configured' };

  const now = Date.now();
  const state = await env.DB
    .prepare('SELECT last_digest_ms, last_entry_ms, trades_snapshot FROM digest_state WHERE game_id = ?')
    .bind(game.id)
    .first();
  const lastDigestMs = state?.last_digest_ms ?? 0;
  if (!force && now - lastDigestMs < MIN_INTERVAL_MS) {
    return { posted: false, events: 0, reason: 'already_ran_today' };
  }

  const sinceMs = state?.last_entry_ms || (now - FIRST_RUN_LOOKBACK_MS);

  // Public entries only — the digest goes to a shared channel, so
  // faction-scoped intel (visibility = JSON array) must not leak.
  const rows = (await env.DB
    .prepare(
      `SELECT kind, actor_faction_id, target_faction_id, payload, created_at_ms
         FROM chronicle_entries
        WHERE game_id = ? AND created_at_ms > ? AND visibility = 'public'
        ORDER BY created_at_ms ASC
        LIMIT 200`,
    )
    .bind(game.id, sinceMs)
    .all()).results ?? [];

  const factions = (await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
    .bind(game.id)
    .all()).results ?? [];
  const factionNames = new Map(factions.map(f => [f.id, f.name]));

  const tradesNow = (await env.DB
    .prepare(`SELECT COALESCE(SUM(trades_completed), 0) AS n
                FROM game_ships WHERE game_id = ? AND status = 'active'`)
    .bind(game.id)
    .first())?.n ?? 0;
  const tradesDelta = Math.max(0, tradesNow - (state?.trades_snapshot ?? tradesNow));

  let embed = composeEmbed(game.name ?? game.id, game.current_tick ?? 0, rows, factionNames, tradesDelta);

  // Forced editions always publish — a quiet day gets a short
  // "all quiet" bulletin so the host's test button visibly works.
  if (!embed && force) {
    embed = {
      title: `🗞️  The Orbital Herald — ${game.name ?? game.id}`,
      description: `*Special edition, tick T+${game.current_tick ?? 0}.*\n\nAll quiet across the system. No battles, no new colonies, no discoveries to report since the last edition. The presses idle; the void abides.`,
      color: SECTION_META.colonies.color,
      footer: { text: 'Host-triggered edition · The Orbital Herald' },
      timestamp: new Date().toISOString(),
    };
  }

  // Advance the high-water mark whether or not we post — a fully
  // quiet day should not accumulate into tomorrow's window as
  // "yesterday's news".
  const maxEntryMs = rows.length > 0 ? rows[rows.length - 1].created_at_ms : now;
  await env.DB
    .prepare(
      `INSERT INTO digest_state (game_id, last_digest_ms, last_entry_ms, trades_snapshot)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         last_digest_ms = excluded.last_digest_ms,
         last_entry_ms = excluded.last_entry_ms,
         trades_snapshot = excluded.trades_snapshot`,
    )
    .bind(game.id, now, maxEntryMs, tradesNow)
    .run();

  if (!embed) return { posted: false, events: rows.length, reason: 'quiet_day' };

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    console.error(`digest webhook post failed for ${game.id}: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, events: rows.length, reason: `webhook_${res.status}` };
  }
  return { posted: true, events: rows.length };
}

/**
 * Entry point — called from the every-minute cron. Cheap early-outs:
 * no webhook secret, wrong hour, or already digested recently.
 */
export async function maybeRunDailyDigest(env) {
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return;                              // feature off

  const now = Date.now();
  if (new Date(now).getUTCHours() !== DIGEST_HOUR_UTC) return;

  const games = (await env.DB
    .prepare(`SELECT g.id, g.current_tick, r.name
                FROM games g JOIN rooms r ON r.id = g.id
               WHERE g.status = 'active'`)
    .all()).results ?? [];

  for (const game of games) {
    try {
      await runDigestForGame(env, game, { force: false });
    } catch (e) {
      // One game's digest failure must not block the others.
      console.error(`daily digest failed for game ${game.id}`, e);
    }
  }
}
