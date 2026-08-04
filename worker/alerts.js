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

/** A fleet of at least this many hostile hulls, already under way toward
 *  something you hold, is a strategic event rather than a skirmish. */
const URGENT_FLEET_SIZE = 5;
/** How often the same urgent situation may re-alert, in ticks. A city
 *  under sustained bombardment shouldn't ping every hour, but it should
 *  ping more than once a day. */
const URGENT_REPEAT_TICKS = 4;

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
  await urgentAlerts(env, notify, gameId, gameName, tick);
  await arrearsAlerts(env, notify, gameId, gameName, tick);
  await voteClosingAlerts(env, notify, gameId, gameName, tick);
}

// ---------------------------------------------------------------------------
// URGENT — the two things that outrank "wait for the 6pm briefing".
//
// Both are chosen because they are IRREVERSIBLE or nearly so: a razed
// city doesn't come back, and a fleet of five-plus hulls arriving
// unopposed usually takes whatever it was aimed at. Ordinary ship
// skirmishes stay in the daily report, where Lorne rightly put them.
// ---------------------------------------------------------------------------

async function urgentAlerts(env, notify, gameId, gameName, tick) {
  // ---- a settlement is actually TAKING DAMAGE ----------------------------
  // last_damaged_tick, NOT last_combat_tick. The latter records when a
  // settlement FIRED — migration 0044 says so explicitly — so a station
  // successfully defending itself at full health stamps it every tick.
  // The first cut used it and told Lorne "UrANUS Station is under fire,
  // structure at 100%", which is the station winning. A false alarm on
  // the one category meant to be trustworthy is worse than no alarm:
  // it teaches players that red means nothing.
  const cities = (await env.DB
    .prepare(
      `SELECT st.id, st.name, b.name AS body, f.user_id, st.hp, st.hp_max
         FROM game_settlements st
         JOIN game_factions f ON f.id = st.owner_faction_id
         JOIN game_bodies b ON b.id = st.body_id
        WHERE st.game_id = ? AND st.last_damaged_tick >= ?
          AND f.user_id IS NOT NULL AND f.status = 'active' AND st.hp > 0`,
    )
    .bind(gameId, tick - 1).all()).results ?? [];

  for (const c of cities) {
    const pct = c.hp_max ? Math.round((c.hp / c.hp_max) * 100) : null;
    await notify.sendDm(env, {
      userId: c.user_id,
      gameId,
      category: 'urgent',
      dedupeKey: `urgent:city:${c.id}:${Math.floor(tick / URGENT_REPEAT_TICKS)}`,
      embed: {
        title: '🔥 A city of yours is taking damage',
        description: [
          `**${c.name}** on **${c.body}** is losing structure.`,
          pct != null ? `Down to **${pct}%**.` : null,
          'A razed settlement does not come back.',
        ].filter(Boolean).join('\n'),
        color: 0xff3b30,
        footer: { text: `Orbital · ${gameName} · T+${tick}` },
      },
    });
  }

  // ---- a serious fleet is inbound ---------------------------------------
  // Same ownership and peace rules as the daily report's inbound section,
  // but only fires above the size threshold — a lone scout is not an
  // emergency, and treating it as one is how a player learns to ignore
  // the red ones.
  const waves = (await env.DB
    .prepare(
      `SELECT b.id AS body_id, b.name AS body, ef.name AS attacker,
              f.user_id, COUNT(*) AS n
         FROM game_ship_nodes n2
         JOIN game_ships sh ON sh.id = n2.ship_id
         JOIN game_factions ef ON ef.id = sh.owner_faction_id
         JOIN game_bodies b ON b.id = n2.target_body_id
         JOIN game_factions f ON f.game_id = ?1
        WHERE n2.game_id = ?1 AND n2.status = 'in_transit' AND sh.hp > 0
          AND f.user_id IS NOT NULL AND f.status = 'active'
          AND sh.owner_faction_id != f.id
          AND (
            EXISTS (SELECT 1 FROM game_settlements st
                     WHERE st.body_id = b.id AND st.owner_faction_id = f.id)
            OR b.owner_faction_id = f.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM treaties t
              JOIN treaty_signatories s1 ON s1.treaty_id = t.id AND s1.faction_id = f.id
              JOIN treaty_signatories s2 ON s2.treaty_id = t.id AND s2.faction_id = sh.owner_faction_id
             WHERE t.game_id = ?1 AND t.status = 'active' AND t.broken_at_tick IS NULL
               AND t.kind IN ('nap','defense_pact')
               AND s1.signed_at_tick IS NOT NULL AND s2.signed_at_tick IS NOT NULL
          )
        GROUP BY b.id, ef.id, f.id
        HAVING COUNT(*) >= ?2`,
    )
    .bind(gameId, URGENT_FLEET_SIZE).all()).results ?? [];

  for (const w of waves) {
    await notify.sendDm(env, {
      userId: w.user_id,
      gameId,
      category: 'urgent',
      dedupeKey: `urgent:wave:${w.body_id}:${Math.floor(tick / URGENT_REPEAT_TICKS)}`,
      embed: {
        title: '🚨 Major fleet inbound',
        description: [
          `**${w.n} hostile ships** are under way to **${w.body}**.`,
          `Flying colours of **${w.attacker}**.`,
          'Reinforce or evacuate while there is still time.',
        ].join('\n'),
        color: 0xff3b30,
        footer: { text: `Orbital · ${gameName} · T+${tick}` },
      },
    });
  }
}

// ---------------------------------------------------------------------------

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
