// ============================================================
// useMpTurnStatus — poll GET /turn/status every 3s in MP.
//
// Returns the server-authoritative Turn-Based-Mode state for the current
// game so the TopBar can show the COMMIT TURN button + per-faction
// readiness banner. Null when not in MP (no MultiplayerActions in scope).
//
// Polling cadence is 3s — short enough that "waiting on Mars" updates
// feel live, long enough that the endpoint cost stays small. We also
// poll once immediately on mount and once right after the caller's own
// commitTurn fires, so the local view doesn't lag 3s behind the server.
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import { useMultiplayerActions, TurnStatus } from './MultiplayerActionsContext';

const POLL_INTERVAL_MS = 3000;

export function useMpTurnStatus(): {
  status: TurnStatus | null;
  refresh: () => Promise<void>;
} {
  const mp = useMultiplayerActions();
  const [status, setStatus] = useState<TurnStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!mp) return;
    const s = await mp.getTurnStatus();
    setStatus(s);
  }, [mp]);

  useEffect(() => {
    if (!mp) {
      setStatus(null);
      return;
    }
    // Kick an immediate fetch so the UI doesn't lag 3s behind on mount.
    let cancelled = false;
    (async () => {
      const s = await mp.getTurnStatus();
      if (!cancelled) setStatus(s);
    })();
    const id = setInterval(async () => {
      const s = await mp.getTurnStatus();
      if (!cancelled) setStatus(s);
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [mp]);

  return { status, refresh };
}
