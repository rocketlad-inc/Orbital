// ============================================================
// Should a Comms broadcast ping THIS player?
//
// The room socket tells everyone in the game that a message was sent
// (worker/messages.js notifyRoom), and the shell toasted "New message in
// Comms" and bumped the unread badge for every one of them. So you were
// alerted to your own message the moment you sent it (Lorne,
// 2026-09-26) -- and to every private message between two OTHER
// players, which you cannot even open.
//
// Unknown identity (the faction id arrives with the first trades poll)
// keeps the old behaviour: a spare ping beats a missed one.
// ============================================================

export interface MessageEvent {
  sender_faction_id?: string | null;
  scope?: string | null;
  /** Null for a broadcast. */
  recipient_faction_ids?: string[] | null;
}

export function messageAlertsMe(m: MessageEvent, myFactionId: string | null): boolean {
  if (!myFactionId) return true;
  if (m.sender_faction_id && m.sender_faction_id === myFactionId) return false;
  if (m.scope !== 'broadcast' && Array.isArray(m.recipient_faction_ids)) {
    return m.recipient_faction_ids.includes(myFactionId);
  }
  return true;
}
