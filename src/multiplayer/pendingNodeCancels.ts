// Bridges the gap between "player clicked ✕ on a queued maneuver" and "the
// server has actually flipped that node to status='cancelled'."
//
// The cancel is a POST that takes a round-trip, but /state polls every ~1s.
// Without this, a poll landing in that window would reconstruct the node
// from its still-'committed' server row and the leg would flicker back —
// exactly the "they disappear and come back" the player reported.
//
// When the ✕ handler cancels a node it records the id here; the MP state
// reconstruction skips any node whose id is pending, so the leg stays gone
// the instant it's removed. Once the server stops reporting that node as
// live (the cancel landed), reconcile() drops the id and the suppression
// ends naturally. Module-level (not React state) because the reconstruction
// runs inside the pure serverToGameState mapper, outside the component tree.

const pending = new Set<string>();

/** Mark a node id as cancel-in-flight. Idempotent. */
export function markNodeCancelPending(nodeId: string): void {
  pending.add(nodeId);
}

/** Undo a pending mark — call when the server REJECTS the cancel, so the
 *  still-committed leg becomes visible again instead of being suppressed
 *  forever while it continues to execute. */
export function unmarkNodeCancelPending(nodeId: string): void {
  pending.delete(nodeId);
}

/** True if this node id has a cancel in flight and should be hidden from
 *  the reconstructed transit/queue state. */
export function isNodeCancelPending(nodeId: string): boolean {
  return pending.has(nodeId);
}

/** Drop any pending id the server no longer reports as a live
 *  (committed/in_transit) node — i.e. the cancel has been applied, so we no
 *  longer need to suppress it. Call once per /state with the set of node
 *  ids the server still considers live. */
export function reconcilePendingNodeCancels(liveNodeIds: Set<string>): void {
  for (const id of pending) {
    if (!liveNodeIds.has(id)) pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Server ids for legs committed from THIS client, before any poll has
// brought them back.
//
// A leg the player queues is drawn from the local plan at once; its server
// node id only arrives when the next /state rebuilds the queue from the
// server's rows. A ✕ clicked inside that window saw a leg with no nodeId,
// took it for a local-only preview and removed it WITHOUT telling the
// server — the leg came back on the next poll and would have flown anyway
// (QA battle test: first click did nothing server-side, second worked).
// The transfer POST already answers with the node's id; it is kept here,
// keyed by the leg's ship and scheduled burn, for the ✕ handler to find.
// ---------------------------------------------------------------------------
const committedIds = new Map<string, string>();
const legKey = (shipId: string, scheduledT: number) =>
  `${shipId}|${Math.round(scheduledT * 1000)}`;

/** Record the server node a committed transfer created. */
export function rememberCommittedNode(shipId: string, scheduledT: number, nodeId: string): void {
  if (committedIds.size > 2000) committedIds.clear();
  committedIds.set(legKey(shipId, scheduledT), nodeId);
}

/** The server node for a leg this client committed, if it knows one. */
export function committedNodeIdFor(shipId: string, scheduledT: number): string | undefined {
  return committedIds.get(legKey(shipId, scheduledT));
}
