import React, { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import { employedShipIds } from '../game/routeSelectors';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

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
  useI18n();
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
        <span className="fs-k">{t('mp.freighters.label')}</span>
        <span>{t('mp.freighters.none')}</span>
      </div>
    );
  }

  const working = total - idle.length;
  return (
    <div className={`fs-strip${idle.length > 0 ? ' has-idle' : ''}`}>
      <span className="fs-k">{t('mp.freighters.label')}</span>
      <span className="fs-count">
        <b>{total}</b> · {t('mp.freighters.working', { n: working })}
        {idle.length > 0
          ? <> · <b className="fs-idle">{t('mp.freighters.idle', { n: idle.length })}</b></>
          : ` · ${t('mp.freighters.noneIdle')}`}
      </span>
      {idle.length > 0 && (
        <span className="fs-names">
          {idle.slice(0, MAX_NAMED).map(s => (
            <button
              key={s.id}
              className="fs-chip"
              title={t('mp.freighters.noJob', { name: s.name })}
              onClick={() => selectShip(s.id)}
            >{s.name}</button>
          ))}
          {idle.length > MAX_NAMED && <span className="fs-more">+{idle.length - MAX_NAMED}</span>}
          <button className="fs-chip fs-chip--go" onClick={onPutToWork} title={t('mp.freighters.routesTitle')}>
            {t('mp.freighters.putToWork')}
          </button>
        </span>
      )}
    </div>
  );
}
