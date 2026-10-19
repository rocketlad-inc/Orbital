// ============================================================
// commissionAsk — the one-time Commission thank-you card (0153, 0174).
//
// The card is for someone who has clearly chosen to keep playing (20+
// hours), and it is asked ONCE. Until 2026-10-19 "once" meant "until
// answered": the card came back on every visit until the player pressed
// a button, and one player saw it 60 times in 6 days. Now the showing
// itself is recorded: the request that hands the card out claims it
// (commission_ask_action = 'shown'), and no later request ever gets it.
// A click or a dismissal afterwards upgrades 'shown' to the answer.
// ============================================================

/** Minutes of play before the card may appear. */
export const COMMISSION_ASK_MINUTES = 20 * 60;

/**
 * Claim the one showing. True only for the single request whose UPDATE
 * recorded it, so two tabs loading at once cannot both show the card.
 */
export async function claimCommissionAsk(env, userId, now = Date.now()) {
  const r = await env.DB
    .prepare(`UPDATE users SET commission_ask_ms = ?, commission_ask_action = 'shown'
               WHERE id = ? AND commission_ask_ms IS NULL`)
    .bind(now, userId)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Record the answer once: 'shown' (or never shown) becomes the action. */
export async function answerCommissionAsk(env, userId, action, now = Date.now()) {
  const a = action === 'clicked' ? 'clicked' : 'dismissed';
  await env.DB
    .prepare(`UPDATE users SET commission_ask_action = ?, commission_ask_ms = COALESCE(commission_ask_ms, ?)
               WHERE id = ? AND (commission_ask_action IS NULL OR commission_ask_action = 'shown')`)
    .bind(a, now, userId)
    .run();
}
