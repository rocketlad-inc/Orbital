// ============================================================
// SettlementTradeTab — every route that stops HERE, listed here
// (DESIGN-trade-v2 §5).
//
// The point of this surface is diagnosability. Before it, a lane that
// lost its freighter simply stopped, somewhere, silently. Now it sits
// in the panel of the settlement it was supposed to serve, counting
// down, with the button that fixes it attached to the thing that's
// broken.
//
// Two roles, named the way a player says them: a ship either RUNS the
// route or GUARDS it.
// ============================================================

import React, { useMemo, useState } from 'react';
import type { GameState, TradeRoute } from '../types';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import {
  routesAtBody, routeCarriers, routeGuards, routeStops,
  isStalled, stallTicksLeft, routeLabel, ROUTE_STALL_TICKS,
} from '../game/routeSelectors';
import './SettlementTradeTab.css';

export interface SettlementTradeTabProps {
  gameState: GameState;
  bodyId: string;
  /** Open the composer on an existing route ("Add stops"). */
  onEditRoute?: (route: TradeRoute) => void;
  /** Open the composer for a brand-new run starting here. */
  onNewRoute?: (bodyId: string) => void;
}

export const SettlementTradeTab: React.FC<SettlementTradeTabProps> = ({
  gameState, bodyId, onEditRoute, onNewRoute,
}) => {
  const mp = useMultiplayerActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<{ routeId: string; role: 'carrier' | 'guard' } | null>(null);

  const bodyName = (id: string) => gameState.bodies.find(b => b.id === id)?.name ?? id;
  const shipName = (id: string) => gameState.ships.find(s => s.id === id)?.name ?? id;

  const routes = useMemo(
    () => routesAtBody(gameState.tradeRoutes ?? [], bodyId),
    [gameState.tradeRoutes, bodyId],
  );

  // Free hulls, by role. A ship already employed anywhere is absent —
  // the server enforces one job per hull, so offering a busy ship would
  // only produce a 409 the player can't act on.
  const employed = useMemo(() => {
    const set = new Set<string>();
    for (const r of gameState.tradeRoutes ?? []) {
      for (const s of r.ships ?? []) set.add(s.shipId);
      if (!r.ships?.length) set.add(r.shipId);
    }
    return set;
  }, [gameState.tradeRoutes]);
  const freeFreighters = gameState.ships.filter(
    s => s.ownedBy === 'player' && s.class === 'freighter' && !employed.has(s.id));
  const freeWarships = gameState.ships.filter(
    s => s.ownedBy === 'player' && !employed.has(s.id)
      && ['corvette', 'frigate', 'destroyer'].includes(s.class));

  const assign = async (routeId: string, role: 'carrier' | 'guard', shipId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(routeId);
    const res = await mp.addRouteShip(routeId, role, { shipId });
    setBusyId(null);
    setAssignFor(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };
  const unassign = async (routeId: string, shipId: string) => {
    if (!mp) return;
    setErr(null);
    setBusyId(routeId);
    const res = await mp.removeRouteShip(routeId, shipId);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? 'The server turned that down.');
  };

  if (routes.length === 0) {
    return (
      <div className="stt">
        <div className="stt-empty">
          No trade route stops here yet. A run collects from your outposts and
          drops everything at a terraformed world you live on.
        </div>
        {onNewRoute && (
          <button type="button" className="stt-btn is-primary" onClick={() => onNewRoute(bodyId)}>
            New route from here
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="stt">
      {err && <div className="stt-err">{err}</div>}
      {routes.map(r => {
        const carriers = routeCarriers(r);
        const guards = routeGuards(r);
        const stalled = isStalled(r);
        const left = stallTicksLeft(r, gameState.currentTick);
        const stops = routeStops(r);
        const mine = r.ownedBy === 'player';
        const here = stops.filter(s => s.bodyId === bodyId);
        return (
          <div key={r.id} className={`stt-route${stalled ? ' is-stalled' : ''}`}>
            <div className="stt-row">
              <span className="stt-name">{routeLabel(r, bodyName)}</span>
              {stalled
                ? <span className="stt-pill is-warn">Stalled</span>
                : <span className="stt-pill">Running</span>}
              <span className="stt-spacer" />
              <span className="stt-meta">
                {here.map(s => (s.action === 'dropoff' ? 'drops off here' : 'collects here')).join(' · ')}
              </span>
            </div>

            {stalled && (
              <div className="stt-stall">
                No freighter. This route cancels itself in <b>{left ?? ROUTE_STALL_TICKS}</b>{' '}
                tick{left === 1 ? '' : 's'} unless one is assigned.
              </div>
            )}

            <div className="stt-row stt-crew">
              <span className="stt-chip">
                Runs it · <b>{carriers.length ? carriers.map(c => shipName(c.shipId)).join(', ') : 'none'}</b>
              </span>
              <span className="stt-chip">
                Guards · <b>{guards.length ? guards.map(g => shipName(g.shipId)).join(', ') : 'none'}</b>
              </span>
            </div>

            <div className="stt-row stt-actions">
              <button
                type="button"
                className={`stt-btn${stalled ? ' is-primary' : ''}`}
                disabled={busyId === r.id || freeFreighters.length === 0}
                title={freeFreighters.length === 0
                  ? 'Every freighter you have is already on a job.'
                  : 'Put another freighter on this run'}
                onClick={() => setAssignFor({ routeId: r.id, role: 'carrier' })}
              >
                {stalled ? 'Assign freighter' : '+ Freighter'}
              </button>
              <button
                type="button"
                className="stt-btn"
                disabled={busyId === r.id || freeWarships.length === 0}
                title={freeWarships.length === 0
                  ? 'No free warships — guards are corvettes, frigates and destroyers.'
                  : 'Guards fly the run and hold fire unless something attacks it'}
                onClick={() => setAssignFor({ routeId: r.id, role: 'guard' })}
              >
                + Guard
              </button>
              {mine && onEditRoute && !r.counterpartyFactionId && (
                <button type="button" className="stt-btn" onClick={() => onEditRoute(r)}>
                  Add stops
                </button>
              )}
            </div>

            {assignFor?.routeId === r.id && (
              <div className="stt-picker">
                <div className="stt-picker-head">
                  {assignFor.role === 'carrier' ? 'Which freighter runs it?' : 'Which ship guards it?'}
                </div>
                <div className="stt-picker-list">
                  {(assignFor.role === 'carrier' ? freeFreighters : freeWarships).map(s => (
                    <button
                      key={s.id}
                      type="button"
                      className="stt-pick"
                      onClick={() => assign(r.id, assignFor.role, s.id)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
                <button type="button" className="stt-btn" onClick={() => setAssignFor(null)}>
                  Cancel
                </button>
              </div>
            )}

            {(carriers.length + guards.length) > 0 && (
              <div className="stt-roster">
                {[...carriers, ...guards].map(s => (
                  <button
                    key={s.shipId}
                    type="button"
                    className="stt-crewchip"
                    disabled={busyId === r.id}
                    title="Take this ship off the route"
                    onClick={() => unassign(r.id, s.shipId)}
                  >
                    {shipName(s.shipId)}
                    <span className="stt-crewrole">{s.role === 'guard' ? 'guard' : 'runs it'}</span>
                    <span className="stt-crewx">✕</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {onNewRoute && (
        <button type="button" className="stt-btn" onClick={() => onNewRoute(bodyId)}>
          New route from here
        </button>
      )}
    </div>
  );
};

export default SettlementTradeTab;
