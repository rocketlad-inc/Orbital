// Which market posts has this player already looked at?
//
// A post used to sit silent until it expired: the board had no way to
// say "something new is up". This is the per-viewer half of fixing that
// — a high-water mark of the newest post seen, per game, in
// localStorage. A per-viewer convenience, so browser storage is the
// right home: losing it just re-badges a few posts once.
//
// The rail badge counts posts newer than the mark that are not yours;
// opening the MARKET tab moves the mark.

type Stamped = { created_at_ms: number; mine?: boolean };

const key = (gameId: string) => `orbital.market.seen.${gameId}`;

export function getMarketSeenMs(gameId: string): number {
  try {
    const n = Number(window.localStorage.getItem(key(gameId)));
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

export function countUnseenPosts(gameId: string, posts: Stamped[]): number {
  const seen = getMarketSeenMs(gameId);
  return posts.filter(p => !p.mine && Number(p.created_at_ms) > seen).length;
}

export function markMarketSeen(gameId: string, posts: Stamped[]): void {
  const newest = posts.reduce((m, p) => Math.max(m, Number(p.created_at_ms) || 0), 0);
  if (newest <= getMarketSeenMs(gameId)) return;
  try { window.localStorage.setItem(key(gameId), String(newest)); } catch { /* blocked storage: badge just stays */ }
  try { window.dispatchEvent(new CustomEvent('market:seen', { detail: { gameId } })); } catch { /* noop */ }
}
