// ============================================================================
// situationReport.js — the personal counterpart to the Herald.
//
// The Herald is a newspaper: everyone gets the same edition, written
// about the whole system. This is a briefing: written for ONE commander,
// about their empire, and it leads with whatever most needs them.
//
// Design rule: every line must be ACTIONABLE or a genuine change. A
// report that recites your metal total every day teaches players to
// ignore it, and an ignored notification is worse than none — it costs
// the same attention and buys nothing. So: threats, decisions waiting,
// things that finished, things that are stuck. Not a status dump.
// ============================================================================

import { atWarSql } from './wars.js';
import { tr, trn, pickLocale } from './i18n.js';

const COLOR_CALM = 0x4ecdc4;
const COLOR_BUSY = 0xffca28;
const COLOR_ALARM = 0xff5e5e;

/**
 * Assemble one player's briefing for one game, in `locale` (the player's
 * users.locale; English when unknown).
 * Returns null when the player has no faction (spectator / vacated).
 */
export async function buildSituationReport(env, gameId, userId, locale = 'en') {
  const L = pickLocale(locale);
  const game = await env.DB
    .prepare(
      `SELECT g.id, g.current_tick, g.status, g.tick_interval_ms, g.next_tick_at, r.name
         FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`,
    )
    .bind(gameId).first();
  if (!game || game.status !== 'active') return null;

  const me = await env.DB
    .prepare(
      `SELECT id, name, color, metal, fuel, gold, science, reputation
         FROM game_factions WHERE game_id = ? AND user_id = ? AND status = 'active'`,
    )
    .bind(gameId, userId).first();
  if (!me) return null;

  const tick = game.current_tick ?? 0;
  const fields = [];
  let urgency = 0;   // 0 calm, 1 things pending, 2 under attack

  // ---- the war, since yesterday -------------------------------------------
  // A DAY's window, not 3 ticks. Combat used to interrupt hourly from the
  // tick loop; it now lives here, so the window has to match the report's
  // cadence or a battle that ended four hours ago would vanish without
  // ever being mentioned.
  const COMBAT_WINDOW_TICKS = 24;
  const attacked = (await env.DB
    .prepare(
      `SELECT b.name AS body, COUNT(*) AS n FROM (
         SELECT parent_body_id AS bid FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id = ?2
            AND last_combat_tick IS NOT NULL AND last_combat_tick >= ?3
         UNION ALL
         SELECT body_id FROM game_settlements
          WHERE game_id = ?1 AND owner_faction_id = ?2
            AND last_combat_tick IS NOT NULL AND last_combat_tick >= ?3
       ) x JOIN game_bodies b ON b.id = x.bid
       GROUP BY b.id`,
    )
    .bind(gameId, me.id, tick - COMBAT_WINDOW_TICKS).all()).results ?? [];
  if (attacked.length) {
    urgency = 2;
    fields.push({
      name: tr(L, 'sitrep.fighting'),
      value: attacked.map(a => tr(L, 'sitrep.fightingRow', { body: a.body, n: a.n })).join('\n').slice(0, 1000),
    });
  }

  // ---- inbound ------------------------------------------------------------
  // The most valuable line in the report: a fleet already under way toward
  // somewhere you hold. Unlike everything else here it is about the
  // FUTURE, and it is the only warning you get while there is still time
  // to reinforce or evacuate.
  //
  // "Somewhere you hold" = a body with your settlement on it, or one
  // recorded as yours. Only factions you are AT WAR with count — peace is
  // the default, a neighbour's fleet arriving is not a threat, and crying
  // wolf about one is how a player learns to skim past this section.
  const incoming = (await env.DB
    .prepare(
      `SELECT b.name AS body, ef.name AS attacker, COUNT(*) AS n,
              MIN(n2.scheduled_t) AS eta_t
         FROM game_ship_nodes n2
         JOIN game_ships sh ON sh.id = n2.ship_id
         JOIN game_factions ef ON ef.id = sh.owner_faction_id
         JOIN game_bodies b ON b.id = n2.target_body_id
        WHERE n2.game_id = ?1
          AND n2.status = 'in_transit'
          AND sh.owner_faction_id != ?2
          AND sh.hp > 0
          AND (
            EXISTS (SELECT 1 FROM game_settlements st
                     WHERE st.body_id = b.id AND st.owner_faction_id = ?2)
            OR b.owner_faction_id = ?2
          )
          AND ${atWarSql('?2', 'sh.owner_faction_id')}
        GROUP BY b.id, ef.id
        ORDER BY n DESC`,
    )
    .bind(gameId, me.id).all()).results ?? [];
  if (incoming.length) {
    urgency = 2;
    fields.push({
      name: tr(L, 'sitrep.inbound'),
      value: incoming.slice(0, 8)
        .map(i => tr(L, 'sitrep.inboundRow', { body: i.body, ships: trn(L, 'sitrep.ships', i.n), attacker: i.attacker }))
        .join('\n').slice(0, 1000),
    });
  }

  // ---- losses since yesterday --------------------------------------------
  const lost = (await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM chronicle_entries
        WHERE game_id = ? AND kind = 'ship_destroyed'
          AND actor_faction_id = ? AND tick_number > ?`,
    )
    .bind(gameId, me.id, tick - 24).first())?.n ?? 0;

  // ---- senate: bills waiting on YOUR vote --------------------------------
  const openBills = (await env.DB
    .prepare(
      `SELECT p.id, p.title, p.vote_closes_at_tick
         FROM senate_proposals p
        WHERE p.game_id = ? AND p.status = 'voting'
          AND NOT EXISTS (SELECT 1 FROM senate_votes v
                           WHERE v.proposal_id = p.id AND v.faction_id = ?)`,
    )
    .bind(gameId, me.id).all()).results ?? [];
  if (openBills.length) {
    urgency = Math.max(urgency, 1);
    // Lead with what the vote is WORTH. "You have a bill to vote on" is a
    // chore; "your 4-weight vote is missing" is leverage going unspent.
    let weightNote = '';
    try {
      const senate = await import('./senate.js');
      const d = await senate.voteWeightDetail(env, gameId, me.id);
      weightNote = d.controlled.length
        ? trn(L, 'sitrep.weightSys', d.controlled.length, { w: d.weight })
        : tr(L, 'sitrep.weight', { w: d.weight });
    } catch (e) {
      console.error('sitrep weight failed', e);
    }
    fields.push({
      name: tr(L, 'sitrep.voteMissing'),
      value: (weightNote + openBills
        .map(b => tr(L, 'sitrep.billRow', { title: b.title, tick: b.vote_closes_at_tick, left: b.vote_closes_at_tick - tick }))
        .join('\n')).slice(0, 1000),
    });
  }

  // ---- trade offers awaiting your answer ---------------------------------
  const offers = (await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM trade_offers
        WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`,
    )
    .bind(gameId, me.id).first())?.n ?? 0;
  if (offers > 0) {
    urgency = Math.max(urgency, 1);
    fields.push({ name: tr(L, 'sitrep.offersTitle'), value: trn(L, 'sitrep.offers', offers) });
  }

  // ---- unread messages ----------------------------------------------------
  const unread = (await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM message_recipients mr
         JOIN messages m ON m.id = mr.message_id
        WHERE mr.faction_id = ? AND mr.read_at_ms IS NULL AND m.game_id = ?`,
    )
    .bind(me.id, gameId).first())?.n ?? 0;
  if (unread > 0) {
    urgency = Math.max(urgency, 1);
    fields.push({ name: tr(L, 'sitrep.unreadTitle'), value: tr(L, 'sitrep.unread', { n: unread }) });
  }

  // ---- terraforming: what's close, and what's stuck ----------------------
  //
  // The clearest "things that are stuck" case in the game, and until now
  // completely invisible: a world with a half-delivered payload and no
  // freighter feeding it will sit at 40% forever, and NOTHING anywhere
  // tells you. The whole point of this report is to surface exactly that.
  //
  // Three states, most urgent first:
  //   STALLED    progress banked, zero routes feeding — actionable NOW
  //   FINISHING  payload in, transformation clock running — hold the world
  //   FEEDING    supply under way — a genuine change, worth one line
  //
  // Deliberately silent about raw worlds nobody has STARTED. Those are a
  // standing opportunity, not news, and listing every un-terraformed rock
  // you own every single day is exactly the status-dump this report
  // exists not to be.
  let tfCostMetal = 124, tfCostCredits = 124;
  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    tfCostMetal = Number(conf.terraform_cost_metal ?? 124);
    tfCostCredits = Number(conf.terraform_cost_credits ?? 124);
  } catch { /* shipped defaults */ }

  const tfRows = (await env.DB
    .prepare(
      `SELECT b.id, b.name,
              b.terraform_acc_metal  AS accM,
              b.terraform_acc_gold   AS accC,
              b.terraform_completes_at_tick AS doneAt,
              (SELECT COUNT(*) FROM game_trade_routes r
                WHERE r.game_id = ?1 AND r.kind = 'terraform'
                  AND r.dest_body_id = b.id AND r.cancelled_at_tick IS NULL) AS feeding
         FROM game_bodies b
        WHERE b.game_id = ?1
          AND b.owner_faction_id = ?2
          AND b.terraformed_at_tick IS NULL
          AND b.type IN ('terrestrial','moon','dwarf')`,
    )
    .bind(gameId, me.id).all()).results ?? [];

  const finishing = [], stalled = [], feeding = [];
  for (const r of tfRows) {
    const accM = Number(r.accM ?? 0), accC = Number(r.accC ?? 0);
    const started = accM > 0 || accC > 0;
    if (r.doneAt != null) {
      finishing.push(tr(L, 'sitrep.tfFinishing', { name: r.name, n: Math.max(0, r.doneAt - tick) }));
      continue;
    }
    if (!started) continue;                       // never begun: not news
    // Percent tracks the LIMITING half, matching the world-menu card —
    // a payload is only as delivered as its furthest-behind resource.
    const pct = Math.round(Math.min(accM / Math.max(1, tfCostMetal),
                                    accC / Math.max(1, tfCostCredits)) * 100);
    if (Number(r.feeding ?? 0) === 0) {
      stalled.push(tr(L, 'sitrep.tfStalled', { name: r.name, pct }));
    } else {
      feeding.push(trn(L, 'sitrep.tfFeeding', Number(r.feeding), { name: r.name, pct }));
    }
  }
  if (stalled.length || finishing.length || feeding.length) {
    // A stall is a decision waiting on the player, so it lifts urgency
    // the same way an unanswered trade offer does. Progress alone does
    // not — that would make a calm day read as busy.
    if (stalled.length) urgency = Math.max(urgency, 1);
    fields.push({
      name: tr(L, 'sitrep.terraforming'),
      value: [...finishing, ...stalled, ...feeding].join('\n').slice(0, 1000),
    });
  }

  // ---- construction: finished, and idle yards ----------------------------
  const building = (await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM game_body_build_queue
        WHERE game_id = ? AND faction_id = ? AND cancelled_at_tick IS NULL
          AND completes_at_tick > ?`,
    )
    .bind(gameId, me.id, tick).first())?.n ?? 0;

  // ---- research -----------------------------------------------------------
  const researching = await env.DB
    .prepare(
      `SELECT tech_id, level FROM faction_techs
        WHERE game_id = ? AND faction_id = ? AND status = 'researching' LIMIT 1`,
    )
    .bind(gameId, me.id).first();

  // ---- holdings snapshot --------------------------------------------------
  const ships = (await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND hp > 0`)
    .bind(gameId, me.id).first())?.n ?? 0;
  const cities = (await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM game_settlements WHERE game_id = ? AND owner_faction_id = ?`)
    .bind(gameId, me.id).first())?.n ?? 0;

  fields.push({
    name: tr(L, 'sitrep.empire'),
    value: [
      tr(L, 'sitrep.holdings', { ships, cities }),
      `**${Math.round(me.metal)}**M · **${Math.round(me.gold)}**C · **${Math.round(me.science)}**S`,
      building > 0 ? tr(L, 'sitrep.building', { n: building }) : tr(L, 'sitrep.noYards'),
      researching ? tr(L, 'sitrep.researching', { tech: researching.tech_id, level: (researching.level ?? 0) + 1 }) : tr(L, 'sitrep.noResearch'),
      lost > 0 ? trn(L, 'sitrep.lost', lost) : null,
    ].filter(Boolean).join('\n'),
  });

  const nextIn = game.next_tick_at
    ? Math.max(0, Math.round((game.next_tick_at - Date.now()) / 60000))
    : null;

  const headline = incoming.length ? tr(L, 'sitrep.headlineInbound')
    : urgency === 2 ? tr(L, 'sitrep.headlineAttack')
    : urgency === 1 ? tr(L, 'sitrep.headlineDecisions')
    : tr(L, 'sitrep.headlineQuiet');

  return {
    urgency,
    embed: {
      title: tr(L, 'sitrep.title', { headline }),
      description: [
        `**${me.name}** · ${game.name} · T+${tick}`,
        nextIn != null ? tr(L, 'sitrep.nextTick', { n: nextIn }) : null,
      ].filter(Boolean).join('\n'),
      color: urgency === 2 ? COLOR_ALARM : urgency === 1 ? COLOR_BUSY : COLOR_CALM,
      fields,
      footer: { text: tr(L, 'sitrep.footer') },
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Send the briefing to every linked human in a game. `force` bypasses
 * the once-a-day dedupe so it can be triggered on demand for testing.
 */
export async function sendSituationReports(env, gameId, { force = false, onlyUserId = null, quietOk = true } = {}) {
  const notify = await import('./notify.js');
  const rows = (await env.DB
    .prepare(
      `SELECT f.user_id, u.locale FROM game_factions f
         JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ? AND f.status = 'active'
          AND f.user_id IS NOT NULL AND u.discord_id IS NOT NULL`,
    )
    .bind(gameId).all()).results ?? [];

  const out = [];
  const day = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (onlyUserId && r.user_id !== onlyUserId) continue;
    // In the recipient's own language (users.locale, read by the query
    // above: no extra round trip per player; NULL = English).
    const report = await buildSituationReport(env, gameId, r.user_id, r.locale);
    if (!report) { out.push({ user: r.user_id, sent: false, reason: 'no_faction' }); continue; }
    // A briefing that says "nothing happened" is how players learn to
    // stop opening briefings. When quiet days are suppressed, every
    // report that DOES arrive means something wants you.
    if (!force && quietOk === false && report.urgency === 0) {
      out.push({ user: r.user_id, sent: false, reason: 'quiet_suppressed' });
      continue;
    }
    const res = await notify.sendDm(env, {
      userId: r.user_id,
      gameId,
      category: 'digest',
      // Once per player per game per day — unless forced, which uses a
      // timestamped key so a test never collides with the real one.
      dedupeKey: force ? `sitrep:${gameId}:force:${Date.now()}` : `sitrep:${gameId}:${day}`,
      embed: report.embed,
    });
    out.push({ user: r.user_id, ...res, urgency: report.urgency });
  }
  return out;
}

/**
 * Cron entry point. Called every minute alongside the tick advancer and
 * the Herald; self-gates to the configured Eastern hour.
 *
 * The per-player dedupe key is the real guard, not this hour check: the
 * cron fires ~60 times inside the target hour, and only the first send
 * per player per day claims the key. That means a worker restart, a
 * retry, or a slow minute can't produce duplicate briefings.
 */
export async function maybeSendDailySitreps(env) {
  const settings = await import('./botSettings.js');
  const cfg = await settings.getSettings(env);
  if (!cfg.sitrep_enabled) return;
  if (!settings.isEasternHour(Date.now(), cfg.sitrep_hour_eastern)) return;

  const games = (await env.DB
    .prepare(`SELECT id FROM games WHERE status = 'active'`)
    .all()).results ?? [];

  for (const g of games) {
    try {
      await sendSituationReports(env, g.id, { quietOk: cfg.sitrep_send_when_quiet });
    } catch (e) {
      console.error('sitrep batch failed', e, { gameId: g.id });
    }
  }
}
