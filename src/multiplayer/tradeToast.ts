// Which trade push from the room (worker/trades.js notifyRoom) is news to
// THIS player. The room fans every trade event out to every socket, so a
// bystander heard about deals between two other empires: in the Play for
// Free trial the Warlord turning down the Ally's pact toasted "Trade
// declined" at the player, who had done nothing (playtest 2026-10-24).

export type TradeToast = 'offer' | 'accepted' | 'declined' | 'countered';

export interface TradePush {
  event?: unknown;
  proposer_faction_id?: unknown;
  responder_faction_id?: unknown;
}

/** The toast to show for a trade push, or null when it is not ours. */
export function tradeToastFor(m: TradePush, me: string | null): TradeToast | null {
  if (!me) return null;
  const proposer = typeof m.proposer_faction_id === 'string' ? m.proposer_faction_id : null;
  const responder = typeof m.responder_faction_id === 'string' ? m.responder_faction_id : null;
  switch (m.event) {
    // An offer to me from someone else.
    case 'proposed': return responder === me && proposer !== me ? 'offer' : null;
    // The other side answered MY offer (I know my own answers).
    case 'accepted': return proposer === me ? 'accepted' : null;
    case 'declined': return proposer === me ? 'declined' : null;
    // A counter is a new offer: its responder is the one it is addressed to.
    case 'countered': return responder === me && proposer !== me ? 'countered' : null;
    default: return null;
  }
}
