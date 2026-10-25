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
/** Off Turn-Based Mode: only watching for the host to turn it on. */
const IDLE_POLL_MS = 15000;

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
    // The 3 s cadence is for a game IN Turn-Based Mode, where "waiting on
    // Mars" has to feel live. A real-time game (every trial, nearly every
    // match) only needs to notice the host switching it on, so it asks
    // every IDLE_POLL_MS instead of adding a request every 3 s for the
    // whole match (playtest R2-C11).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pump = async () => {
      let s: TurnStatus | null = null;
      try { s = await mp.getTurnStatus(); } catch { /* keep polling */ }
      if (cancelled) return;
      setStatus(s);
      timer = setTimeout(pump, s?.turn_based_enabled ? POLL_INTERVAL_MS : IDLE_POLL_MS);
    };
    void pump();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [mp]);

  return { status, refresh };
}
