// Fire-and-forget UI telemetry. One row per "opened X" so the admin
// dashboard can build funnels (menu opened → feature actually used)
// that the server-side mutation log alone can't see.
//
// Deliberately dumb: no queue, no retry, errors swallowed — losing a
// telemetry row must never affect play. Deduped per (game, kind) per
// page load so a panel that remounts on every selection doesn't flood
// the table; "did they open it this session" is the funnel's question.

import { apiFetch } from './api';

const sent = new Set<string>();

export function logUiEvent(gameId: string | undefined, kind: string): void {
  if (!gameId) return; // single-player: nothing to report to
  const key = `${gameId}:${kind}`;
  if (sent.has(key)) return;
  sent.add(key);
  void apiFetch(`/api/games/${gameId}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
  }).catch(() => { /* telemetry is best-effort */ });
}
