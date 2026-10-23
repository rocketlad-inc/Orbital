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
import { planHullIntercept } from '../interceptCommit';
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
  // The intercept picker's own planner and poster, read fresh at call time.
  const planRef = useRef({ ctx, actions });
  planRef.current = { ctx, actions };
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
      intercept: async (shipIds, targetShipId) => {
        const { ctx: c, actions: a } = planRef.current;
        if (!a) return { sent: 0, failed: shipIds.length, error: 'no game actions' };
        const plans = shipIds
          .map(id => planHullIntercept(id, targetShipId, {
            enqueueIntercept: c.enqueueIntercept, launchTorchTransfer: c.launchTorchTransfer, previewRendezvous: c.previewRendezvous,
          }))
          .filter((p): p is NonNullable<typeof p> => !!p);
        if (!plans.length) return { sent: 0, failed: shipIds.length, error: 'no course to the target' };
        const results = await a.transferMany(plans.map(p => p.intent));
        const sent = results.filter(r => r.ok).length;
        const bad = results.find(r => !r.ok) as { error?: string } | undefined;
        return { sent, failed: shipIds.length - sent, error: bad?.error };
      },
      setSelection: (shipIds) => { planRef.current.ctx.setShipSelection(shipIds); },
      planIntercept: (shipIds, targetShipId) => {
        const c = planRef.current.ctx;
        return shipIds.map(id => {
          const leg = c.enqueueIntercept(id, targetShipId, 0, { fromNow: true });
          // A dry run: enqueueIntercept STAGES its leg as the hull's plan,
          // which drew a course and an Outliner row for a squadron that
          // never went anywhere (judges, 2026-10-22). Take it back.
          c.cancelTorchPreview(id);
          if (!leg) return { ship: id, none: true as const };
          return { ship: id, depart: leg.startTick, meet: leg.rv ? leg.rv.meetTick : null, arrive: leg.arriveTick, accel: leg.acceleration };
        });
      },
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
