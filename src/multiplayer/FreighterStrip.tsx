import React, { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { employedShipIds } from '../game/routeSelectors';

// "Why is my freighter idle?" is the question the trade dock exists to
// answer, and it was the one thing the dock never said: you had to open
// ROUTES and read every card to work out which hulls had no job. This
// strip answers it on every tab — how many freighters, how many are
// working, and the idle ones by name.
//
// Same employment rule as the ROUTES tab and the server: a hull is busy
// if it crews a live route OR is hauling a one-off shipment.

const MAX_NAMED = 3;

export function FreighterStrip({ onPutToWork }: { onPutToWork: () => void }) {
  const { gameState, selectShip } = useGameContext();

  const { total, idle } = useMemo(() => {
    const employed = employedShipIds(
      gameState.tradeRoutes ?? [],
      (gameState.tradeDeliveries ?? []) as Array<{ shipId: string | null }>,
    );
    // A legacy leg pins its hull on the route row rather than in a crew list.
    for (const r of gameState.tradeRoutes ?? []) if (!r.ships?.length) employed.add(r.shipId);
    const mine = gameState.ships.filter(s => s.ownedBy === 'player' && s.class === 'freighter');
    return { total: mine.length, idle: mine.filter(s => !employed.has(s.id)) };
  }, [gameState.ships, gameState.tradeRoutes, gameState.tradeDeliveries]);

  if (total === 0) {
    return (
      <div className="fs-strip is-empty">
        <span className="fs-k">Freighters</span>
        <span>None yet. Goods move by freighter — build one at a shipyard to trade.</span>
      </div>
    );
  }

  const working = total - idle.length;
  return (
    <div className={`fs-strip${idle.length > 0 ? ' has-idle' : ''}`}>
      <span className="fs-k">Freighters</span>
      <span className="fs-count">
        <b>{total}</b> · {working} working
        {idle.length > 0
          ? <> · <b className="fs-idle">{idle.length} idle</b></>
          : ' · none idle'}
      </span>
      {idle.length > 0 && (
        <span className="fs-names">
          {idle.slice(0, MAX_NAMED).map(s => (
            <button
              key={s.id}
              className="fs-chip"
              title={`${s.name} has no job. Click to select it on the map.`}
              onClick={() => selectShip(s.id)}
            >{s.name}</button>
          ))}
          {idle.length > MAX_NAMED && <span className="fs-more">+{idle.length - MAX_NAMED}</span>}
          <button className="fs-chip fs-chip--go" onClick={onPutToWork} title="Open ROUTES to give them a route">
            Put to work
          </button>
        </span>
      )}
    </div>
  );
}
