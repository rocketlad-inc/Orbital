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
