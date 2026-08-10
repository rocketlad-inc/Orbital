// ============================================================
// Standing trade agreements — ending them, and the disruptions that do.
//
// ONE FUNCTION ENDS AN AGREEMENT. Five different things can stop a
// standing deal (a party cancels, a sender runs dry, the two go to war,
// a freighter dies, a party is eliminated) and every one of them has to
// do the same four things: stop BOTH legs, mark the contract ended with
// a reason, tell both players, and write it to the log. Spreading that
// across five call sites is how you end up with a deal that is "ended"
// in one table and still flying freighters in another.
//
// WHY BOTH LEGS (Lorne): the legs run uncoupled — neither waits on the
// other, because a freighter idling behind its partner's dead freighter
// is a deadlock no player can diagnose. But the DEAL is atomic. If one
// side stops paying, the other must stop shipping in the same tick, or
// they are donating cargo to a partner who has stopped reciprocating.
// ============================================================

/** Human copy per reason. Second person, because these go out as DMs to
 *  both parties and "your agreement" reads better than "the agreement". */
const REASON_TEXT = {
  cancelled:  'called off',
  starved:    'ended — a shipment could not be covered',
  war:        'ended — the two of you exchanged fire',
  ship_lost:  'ended — a freighter on the route was destroyed',
  eliminated: 'ended — a party was eliminated',
};

/** Reasons that are somebody's deliberate act vs. something that
 *  happened. Only the latter are worth an interrupt-grade DM; a player
 *  who just clicked "cancel" does not need to be told they did. */
const UNEXPECTED = new Set(['starved', 'war', 'ship_lost', 'eliminated']);

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return `chr_${btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * End an agreement and stop both its legs.
 *
 * Idempotent by design: the UPDATE is guarded on status = 'active', and
 * every caller is in a tick loop that may run again. Ending an already
 * ended agreement is a no-op, not a duplicate notification.
 *
 * @param {*} ag        the trade_agreements row
 * @param {string} reason  key of REASON_TEXT
 * @param {{ byFactionId?: string, detail?: string }} opts
 */
export async function endAgreement(env, gameId, ag, reason, tick, opts = {}) {
  const res = await env.DB
    .prepare(
      `UPDATE trade_agreements
          SET status = 'ended', ended_reason = ?, ended_at_tick = ?
        WHERE id = ? AND status = 'active'`,
    )
    .bind(reason, tick, ag.id)
    .run();
  // Already ended by an earlier pass this tick — do not re-notify.
  if ((res?.meta?.changes ?? 0) === 0) return { ended: false };

  // Stop every leg. Cargo in a hold at this moment is simply lost with
  // the contract rather than being force-delivered: the goods were
  // debited from the sender at pickup, and inventing a destination for
  // them at cancellation time would be a way to launder resources past
  // a partner who just went to war with you.
  await env.DB
    .prepare(
      `UPDATE game_trade_routes
          SET cancelled_at_tick = ?,
              cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
        WHERE agreement_id = ? AND cancelled_at_tick IS NULL`,
    )
    .bind(tick, ag.id)
    .run();

  const names = new Map(((await env.DB
    .prepare(`SELECT id, name, user_id FROM game_factions WHERE id IN (?, ?)`)
    .bind(ag.faction_a_id, ag.faction_b_id)
    .all()).results ?? []).map(r => [r.id, r]));
  const a = names.get(ag.faction_a_id);
  const b = names.get(ag.faction_b_id);

  // Log it to both parties and nobody else. A standing lane is private
  // commercial intelligence — who trades with whom, and how much, is
  // exactly what the Sensors track is supposed to sell.
  try {
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'trade_agreement_ended', ?, ?, ?, ?)`,
      )
      .bind(
        newId(), gameId, tick, opts.byFactionId ?? ag.faction_a_id,
        JSON.stringify({
          agreement_id: ag.id,
          reason,
          reason_text: REASON_TEXT[reason] ?? 'ended',
          detail: opts.detail ?? null,
          faction_a_id: ag.faction_a_id,
          faction_b_id: ag.faction_b_id,
          faction_a_name: a?.name ?? null,
          faction_b_name: b?.name ?? null,
          ended_by_faction_id: opts.byFactionId ?? null,
        }),
        JSON.stringify([ag.faction_a_id, ag.faction_b_id]),
        Date.now(),
      )
      .run();
  } catch (e) {
    console.error('endAgreement: chronicle write failed', e, { agreementId: ag.id });
  }

  // DM both sides when the ending was not their own doing. Fully
  // isolated — a notification failure must never leave the agreement
  // half-ended, since the rows above are already committed.
  if (UNEXPECTED.has(reason)) {
    try {
      const notify = await import('./notify.js');
      const game = await env.DB
        .prepare('SELECT r.name FROM rooms r WHERE r.id = ?').bind(gameId).first();
      for (const side of [a, b]) {
        if (!side?.user_id) continue;
        const other = side.id === ag.faction_a_id ? b : a;
        await notify.sendDm(env, {
          userId: side.user_id,
          gameId,
          category: 'trade',
          // Per agreement, not per tick — a route that dies once must
          // not DM on every subsequent pass.
          dedupeKey: `agreement_end:${ag.id}`,
          embed: {
            title: '📉 A standing trade agreement has ended',
            description: [
              `Your agreement with **${other?.name ?? 'another empire'}** ${REASON_TEXT[reason] ?? 'ended'}.`,
              opts.detail ? `\n${opts.detail}` : '',
              '\nThe freighters have stopped. You can negotiate a new one at any time.',
            ].join(''),
            color: 0xff5e5e,
            footer: { text: `Orbital · ${game?.name ?? 'game'} · T+${tick}` },
          },
        });
      }
    } catch (e) {
      console.error('endAgreement: notify failed', e, { agreementId: ag.id });
    }
  }

  return { ended: true };
}

/** Every active agreement a faction is party to. */
export async function activeAgreementsFor(env, gameId, factionId) {
  return ((await env.DB
    .prepare(
      `SELECT * FROM trade_agreements
        WHERE game_id = ? AND status = 'active'
          AND (faction_a_id = ? OR faction_b_id = ?)`,
    )
    .bind(gameId, factionId, factionId)
    .all()).results) ?? [];
}

/**
 * End any agreement between two factions that just shot at each other.
 *
 * "Players go to war" (Lorne) has no formal declaration in this game —
 * there is no war flag, only pacts and the absence of them. So the
 * honest signal is the one players would recognise as war: shots
 * exchanged between the pair. The tick already attributes every hit to
 * an attacking faction, so this reads that attribution rather than
 * inventing new state.
 *
 * @param {Array<[string,string]>} pairs  attacker/target faction pairs
 *        that traded damage this tick, in either order.
 */
export async function endAgreementsForCombat(env, gameId, pairs, tick) {
  if (!pairs || pairs.length === 0) return 0;
  // Normalise so (A,B) and (B,A) are the same war.
  const seen = new Set();
  let ended = 0;
  for (const [x, y] of pairs) {
    if (!x || !y || x === y) continue;
    const key = x < y ? `${x}|${y}` : `${y}|${x}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = ((await env.DB
      .prepare(
        `SELECT * FROM trade_agreements
          WHERE game_id = ? AND status = 'active'
            AND ((faction_a_id = ? AND faction_b_id = ?)
              OR (faction_a_id = ? AND faction_b_id = ?))`,
      )
      .bind(gameId, x, y, y, x)
      .all()).results) ?? [];
    for (const ag of rows) {
      const r = await endAgreement(env, gameId, ag, 'war', tick, {
        detail: 'Shots were exchanged between your two empires this tick.',
      });
      if (r.ended) ended++;
    }
  }
  return ended;
}
