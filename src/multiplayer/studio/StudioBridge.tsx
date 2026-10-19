// StudioBridge: mounts the director inside a multiplayer game and hands
// it to two users. People get the Studio bar (admins who arrived from the
// Studio tab, or with ?studio=1). Agents get window.__studio, the same
// object, which scripts/studio.mjs drives over the DevTools protocol.
// Nothing here renders for anyone else: the director exists only while
// the signed-in account is an admin.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameContext } from '../../state/gameContext';
import { useAuth } from '../AuthContext';
import { useMultiplayerActions } from '../MultiplayerActionsContext';
import { Director } from './director';
import { StudioAdminBar } from './StudioAdminBar';

declare global {
  interface Window { __studio?: Director }
}

const ON_KEY = 'orbital.studio.on';

export function StudioBridge() {
  const { user } = useAuth();
  const ctx = useGameContext();
  const actions = useMultiplayerActions();
  const stateRef = useRef(ctx.gameState);
  stateRef.current = ctx.gameState;
  const deselectRef = useRef({ ship: ctx.deselectShip, body: ctx.deselectBody });
  deselectRef.current = { ship: ctx.deselectShip, body: ctx.deselectBody };
  const gameId = actions?.gameId ?? '';
  // Admins, and the agent players the studio seats (scripts/studio.mjs
  // records as one of them). The server re-checks every tick request.
  const isAdmin = !!user?.is_admin || /@agents\.orbital\.local$/.test(user?.email ?? '');

  const director = useMemo(() => {
    if (!isAdmin || !gameId) return null;
    return new Director({
      gameId,
      state: () => stateRef.current,
      mapCanvas: () => document.querySelector<HTMLCanvasElement>('canvas.map-canvas'),
      deselect: () => { deselectRef.current.ship(); deselectRef.current.body(); },
    });
  }, [isAdmin, gameId]);

  const [barOn, setBarOn] = useState<boolean>(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get('studio') === '1') return true;
      return localStorage.getItem(ON_KEY) === '1';
    } catch { return false; }
  });

  useEffect(() => {
    if (!director) return;
    window.__studio = director;
    return () => {
      if (window.__studio === director) delete window.__studio;
      director.cancel();
      director.ui(true);
      director.speed(null);
    };
  }, [director]);

  if (!director || !barOn) return null;
  return createPortal(
    <StudioAdminBar
      director={director}
      onClose={() => { try { localStorage.removeItem(ON_KEY); } catch { /* fine */ } director.ui(true); setBarOn(false); }}
    />,
    document.body,
  );
}
