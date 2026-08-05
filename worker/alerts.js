// ============================================================================
// alerts.js — the notifications that can't wait for the 6pm briefing.
//
// The situation report is a scheduled summary. These are interrupts: a
// vote closes before you'll next look, your fleet is fighting at half
// damage because upkeep went unpaid. They fire from the tick loop, so
// they arrive while the thing is still true.
//
// The bar is deliberately high. Anything that stays true for many ticks
// belongs in the 6pm report, not here — the urgent category was removed
// for exactly that reason (see below). What survives is time-critical
// AND short-lived: a deadline, and a debt with a fixed daily reminder.
//
// Every one is dedupe-keyed on the EVENT, not the moment. "Bill 41
// closes" can be evaluated sixty times by sixty cron ticks and still
// send exactly once — which is what lets these run from a hot loop
// without carefully tracking what's already been said. A key that
// buckets on TIME rather than identity re-sends for as long as the
// situation lasts; that is the trap the urgent alerts fell into.
//
// Called from resolveTick with its own try/catch: an alert failing must
// never cost a player their turn.
// ============================================================================

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

  // NOTE: combat deliberately does NOT alert from here. A war lasts many
  // ticks, and an hourly "you are under fire" DM about the same ongoing
  // battle is noise — Lorne's call, and the right one. Combat now reports
  // in the daily situation report, where a day of fighting reads as one
  // narrative instead of eight interruptions. What stays here is
  // genuinely time-critical: a vote that will CLOSE before the next
  // briefing, and a debt that silently weakens every battle.
  //
  // The URGENT category (city under fire, 5+ hostiles inbound) used to
  // fire from here too and has been removed for over-firing — see the
  // note below the imports.
  await arrearsAlerts(env, notify, gameId, gameName, tick);
  await voteClosingAlerts(env, notify, gameId, gameName, tick);
}

// ---------------------------------------------------------------------------
// REMOVED: urgent alerts (city taking damage, 5+ hostile ships inbound).
//
// They over-fired, and the reason is structural rather than a tuning
// miss. Both were dedupe-keyed on a 4-tick BUCKET, not on the event, so
// they re-sent for as long as the situation lasted: a siege runs for
// dozens of ticks and a fleet can be in transit for twenty, so one
// inbound wave produced a DM every four hours until it landed. A player
// under real pressure — exactly the person these were for — got the most
// noise. That is how a channel gets muted.
//
// Both facts still reach players, in the place where a day of pressure
// reads as one story instead of six interruptions: the 6pm situation
// report carries settlements under fire and inbound hostile fleets.
//
// If these come back, the fix is not a longer bucket. It is a dedupe key
// tied to the ENGAGEMENT or the FLEET (first sighting of this wave at
// this body), so a sustained event alerts once and a genuinely new one
// still gets through.
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
