// ============================================================================
// alerts.js — the notifications that can't wait for the 6pm briefing.
//
// The situation report is a scheduled summary. These are interrupts: your
// city is being shelled, a vote closes before you'll next look, your
// fleet is fighting at half damage because upkeep went unpaid. They fire
// from the tick loop, so they arrive while the thing is still true.
//
// Every one is dedupe-keyed on the EVENT, not the moment. "Combat at
// Oberon on tick 340" can be evaluated sixty times by sixty cron ticks
// and still send exactly once — which is what lets these run from a hot
// loop without carefully tracking what's already been said.
//
// Called from resolveTick with its own try/catch: an alert failing must
// never cost a player their turn.
// ============================================================================

/** Combat is worth interrupting for; the same 3-tick window the Herald
 *  and the sitrep use, so all three agree about what "now" means. */
const COMBAT_WINDOW = 3;
/** Warn about a vote this many ticks before it closes. */
const VOTE_WARN_TICKS = 2;
/** An idle player hears from us at most this often. */
const NUDGE_COOLDOWN_MS = 6 * 86400000;
/** ...and only after this long away. */
const NUDGE_AFTER_MS = 3 * 86400000;

async function notifyMod() { return import('./notify.js'); }

/**
 * Everything that should interrupt a player, evaluated for one game at
 * one tick. Safe to call every tick.
 */
export async function runTickAlerts(env, gameId, tick) {
  const notify = await notifyMod();
  const gameRow = await env.DB
    .prepare('SELECT r.name FROM rooms r WHERE r.id = ?').bind(gameId).first();
  const gameName = gameRow?.name ?? gameId;

  await combatAlerts(env, notify, gameId, gameName, tick);
  await arrearsAlerts(env, notify, gameId, gameName, tick);
  await voteClosingAlerts(env, notify, gameId, gameName, tick);
}

// ---------------------------------------------------------------------------

async function combatAlerts(env, notify, gameId, gameName, tick) {
  // Group by body so a ten-ship brawl is ONE alert, not ten. The dedupe
  // key includes the body and tick, so a battle spanning several ticks
  // re-alerts at most once per tick per place — enough to convey "still
  // happening" without becoming a machine gun.
  const rows = (await env.DB
    .prepare(
      `SELECT f.user_id, b.name AS body, b.id AS body_id,
              COUNT(*) AS n, MAX(x.lct) AS last_tick
         FROM (
           SELECT owner_faction_id AS fid, parent_body_id AS bid, last_combat_tick AS lct
             FROM game_ships
            WHERE game_id = ?1 AND last_combat_tick >= ?2
           UNION ALL
           SELECT owner_faction_id, body_id, last_combat_tick
             FROM game_settlements
            WHERE game_id = ?1 AND last_combat_tick >= ?2
         ) x
         JOIN game_factions f ON f.id = x.fid
         JOIN game_bodies b ON b.id = x.bid
        WHERE f.user_id IS NOT NULL AND f.status = 'active'
        GROUP BY f.user_id, b.id`,
    )
    .bind(gameId, tick - COMBAT_WINDOW).all()).results ?? [];

  // ONE alert per player, listing every front — not one per body. The
  // first cut keyed dedupe on the body and fired seven DMs in a burst to
  // a player fighting on seven fronts, which is precisely the
  // over-notifying this module's header warns against. A player at war
  // wants a briefing, not a machine gun.
  const byUser = new Map();
  for (const r of rows) {
    let e = byUser.get(r.user_id);
    if (!e) { e = { fronts: [], last: 0, total: 0 }; byUser.set(r.user_id, e); }
    e.fronts.push({ body: r.body, n: r.n });
    e.total += r.n;
    if (r.last_tick > e.last) e.last = r.last_tick;
  }

  for (const [userId, e] of byUser) {
    e.fronts.sort((a, b) => b.n - a.n);
    const shown = e.fronts.slice(0, 6);
    const more = e.fronts.length - shown.length;
    await notify.sendDm(env, {
      userId,
      gameId,
      category: 'combat',
      // Keyed on the player and the latest combat tick: a battle that
      // rages for hours re-alerts at most once per tick, and only when
      // there is genuinely new fighting.
      dedupeKey: `combat:${gameId}:${userId}:${e.last}`,
      embed: {
        title: e.fronts.length > 1
          ? `⚔️ Fighting on ${e.fronts.length} fronts`
          : '⚔️ Your forces are under fire',
        description: [
          ...shown.map(f => `**${f.body}** — ${f.n} of yours engaged`),
          more > 0 ? `_…and ${more} more_` : null,
        ].filter(Boolean).join('\n'),
        color: 0xff5e5e,
        footer: { text: `Orbital · ${gameName} · T+${tick}` },
      },
    });
  }
}

// ---------------------------------------------------------------------------

async function arrearsAlerts(env, notify, gameId, gameName, tick) {
  // Arrears are quiet and expensive — a fleet fighting at reduced damage
  // because upkeep lapsed is exactly the sort of thing a player doesn't
  // notice until they lose a battle they should have won.
  // Arrears are tracked per FACTION (migration 0051 put the columns on
  // game_factions), not per fleet — the debt belongs to the empire. An
  // earlier draft of this query joined game_fleets and would have thrown
  // on every tick.
  const rows = (await env.DB
    .prepare(
      `SELECT user_id, arrears_gold AS gold, arrears_metal AS metal
         FROM game_factions
        WHERE game_id = ? AND (arrears_gold > 0 OR arrears_metal > 0)
          AND user_id IS NOT NULL AND status = 'active'`,
    )
    .bind(gameId).all()).results ?? [];

  for (const r of rows) {
    await notify.sendDm(env, {
      userId: r.user_id,
      gameId,
      category: 'economy',
      // Daily, not per-tick: arrears persist for many ticks and an
      // hourly reminder about the same debt is nagging, not helping.
      dedupeKey: `arrears:${gameId}:${Math.floor(tick / 24)}`,
      embed: {
        title: '💸 Fleet upkeep unpaid',
        description: [
          `Owed: **${Math.round(r.gold || 0)}**C · **${Math.round(r.metal || 0)}**M`,
          'Unpaid fleets fight at reduced damage until settled.',
        ].join('\n'),
        color: 0xffca28,
        footer: { text: `Orbital · ${gameName} · T+${tick}` },
      },
    });
  }
}

// ---------------------------------------------------------------------------

async function voteClosingAlerts(env, notify, gameId, gameName, tick) {
  // The failure this prevents: a bill opens at 3am, closes before the
  // player next looks, and they never knew they had a say.
  const bills = (await env.DB
    .prepare(
      `SELECT id, title, vote_closes_at_tick FROM senate_proposals
        WHERE game_id = ? AND status = 'voting'
          AND vote_closes_at_tick - ? <= ? AND vote_closes_at_tick > ?`,
    )
    .bind(gameId, tick, VOTE_WARN_TICKS, tick).all()).results ?? [];
  if (!bills.length) return;

  for (const bill of bills) {
    const missing = (await env.DB
      .prepare(
        `SELECT f.user_id FROM game_factions f
          WHERE f.game_id = ? AND f.status = 'active' AND f.user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM senate_votes v
                             WHERE v.proposal_id = ? AND v.faction_id = f.id)`,
      )
      .bind(gameId, bill.id).all()).results ?? [];

    for (const m of missing) {
      await notify.sendDm(env, {
        userId: m.user_id,
        gameId,
        category: 'senate',
        dedupeKey: `voteclose:${bill.id}`,
        embed: {
          title: '🏛️ A vote closes soon without you',
          description: [
            `**${bill.title}**`,
            `Closes at tick **${bill.vote_closes_at_tick}** — ${bill.vote_closes_at_tick - tick} tick(s) away.`,
            'You can vote from the card in the channel, or in-game.',
          ].join('\n'),
          color: 0xc4b5fd,
          footer: { text: `Orbital · ${gameName} · T+${tick}` },
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Idle nudge — cron, not tick loop. This is the one aimed squarely at
// the players analytics shows drifting away (10 days, 34 days) who never
// decided to quit; nothing pulled them back.
// ---------------------------------------------------------------------------

export async function runIdleNudges(env) {
  const notify = await notifyMod();
  const now = Date.now();

  const rows = (await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.display_name, g.id AS game_id, r.name AS game_name,
              g.current_tick, f.id AS faction_id, f.name AS faction_name,
              (SELECT MAX(COALESCE(s.last_seen_at, s.created_at))
                 FROM sessions s WHERE s.user_id = u.id) AS last_seen,
              (SELECT MAX(n.created_ms) FROM notification_log n
                WHERE n.user_id = u.id AND n.category = 'nudge') AS last_nudge
         FROM game_factions f
         JOIN users u ON u.id = f.user_id
         JOIN games g ON g.id = f.game_id
         JOIN rooms r ON r.id = g.id
        WHERE g.status = 'active' AND f.status = 'active'
          AND u.discord_id IS NOT NULL`,
    ).all()).results ?? [];

  for (const r of rows) {
    if (!r.last_seen || now - r.last_seen < NUDGE_AFTER_MS) continue;
    if (r.last_nudge && now - r.last_nudge < NUDGE_COOLDOWN_MS) continue;

    const days = Math.floor((now - r.last_seen) / 86400000);

    // A nudge has to carry NEWS, not guilt. "You've been away" is a
    // reprimand; "someone took a planet and there's a vote open" is a
    // reason to come back.
    const lost = (await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM chronicle_entries
          WHERE game_id = ? AND kind = 'ship_destroyed' AND actor_faction_id = ?
            AND created_at_ms > ?`,
      ).bind(r.game_id, r.faction_id, r.last_seen).first())?.n ?? 0;
    const bills = (await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM senate_proposals WHERE game_id = ? AND status = 'voting'`)
      .bind(r.game_id).first())?.n ?? 0;
    const ships = (await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND hp > 0`)
      .bind(r.game_id, r.faction_id).first())?.n ?? 0;

    const news = [
      lost > 0 ? `You've lost **${lost}** ship${lost === 1 ? '' : 's'} since you left.` : null,
      bills > 0 ? `**${bills}** bill${bills === 1 ? '' : 's'} on the senate floor right now.` : null,
      `Your empire still holds **${ships}** ships.`,
    ].filter(Boolean);

    await notify.sendDm(env, {
      userId: r.user_id,
      gameId: r.game_id,
      category: 'nudge',
      dedupeKey: `nudge:${r.game_id}:${r.user_id}:${Math.floor(now / NUDGE_COOLDOWN_MS)}`,
      embed: {
        title: `🛰️ ${r.faction_name} awaits orders`,
        description: [`${days} days since your last command. ${r.game_name} is at T+${r.current_tick}.`, '', ...news].join('\n'),
        color: 0x4ecdc4,
        footer: { text: 'Orbital · /notify off to stop these' },
      },
    });
  }
}
