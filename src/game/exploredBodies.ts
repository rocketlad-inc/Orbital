// ============================================================
// Explored-body memory.
//
// A body's yields are intel: the map only revealed them while the body sat
// inside a live sensor ring (commit fb88f75). That made the readout blink
// out the moment a fleet moved on, so a surveyed world you'd been reading
// all game silently went blank — it read as "the labels are gone".
//
// Yields are stable facts about a rock, not a live reading, so once you've
// had eyes on a world you keep the number. This tracks which bodies have
// ever been in coverage, persisted per game so a refresh doesn't wipe what
// you scouted.
//
// The server already sends every body's yields (only OWNERSHIP is fogged —
// see the bodies query in worker/state.js), so this is purely a display
// gate; nothing here leaks data the client didn't already hold.
// ============================================================

const KEY_PREFIX = 'orbital:explored:';

/**
 * Stable per-game key. Faction ids are game-namespaced ("<gameId>:F1"), so
 * any faction carrying a colon yields the game id without plumbing one
 * through the render tree. The caller's own faction is rewritten to the
 * bare 'player' token, hence the search for a colon rather than [0].
 * Falls back to 'sp' for single-player, whose factions aren't namespaced.
 */
export function exploredStorageKey(factionIds: string[]): string {
  const namespaced = factionIds.find(id => id.includes(':'));
  const gameId = namespaced ? namespaced.split(':')[0] : 'sp';
  return `${KEY_PREFIX}${gameId}`;
}

export function loadExplored(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(x => typeof x === 'string')) : new Set();
  } catch {
    // Private-mode / quota / corrupt blob — memory just starts empty.
    return new Set();
  }
}

export function saveExplored(key: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    /* storage unavailable — the in-memory set still works for this session */
  }
}
