// ============================================================
// RouteShipPicker — "who runs it" and "who guards it", by location.
//
// The Dispatch design (Lorne picked it 2026-10-22 from a canvas built on
// Sam's real fleet): freighters hang off a flight path of worlds, nearest
// the first stop first, the close ones as cards with the hull drawn in
// the empire's livery, the far ones as small tokens, and hulls in another
// star system in their own strip. Guards are picked a FLEET at a time,
// drawn in formation, with ships in no fleet folded away by world. It
// replaced two walls of name chips in build order. Grouping and trip
// times live in routeShipGroups.ts.
// ============================================================

import React, { useMemo, useState } from 'react';
import type { GameState, Ship } from '../types';
import { ShipIcon, iconClassFor } from '../components/ShipIcons';
import { PlanetIcon } from '../components/PlanetIcon';
import { deriveSecondary } from '../game/colorUtils';
import {
  groupByWorld, groupGuards, freighterAccel, systemLabel,
  type FarGroup, type FleetPick, type ShipSpot, type WorldGroup,
} from './routeShipGroups';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';

/** Worlds drawn as cards before the path drops to tokens. */
const CARD_WORLDS = 6;
/** Fleets shown before "N more fleets". */
const FLEETS_SHOWN = 4;

export interface RouteShipPickerProps {
  gameState: GameState;
  firstStopId?: string;
  freighters: Ship[];
  warships: Ship[];
  carriers: string[];
  guards: string[];
  carrierCap: number;
  /** Shown under the freighters, and as the tooltip on a blocked card. */
  carrierHint?: string;
  guardHint?: string;
  onToggleCarrier: (id: string) => void;
  onSetGuards: (next: string[]) => void;
}

export const RouteShipPicker: React.FC<RouteShipPickerProps> = ({
  gameState, firstStopId, freighters, warships, carriers, guards, carrierCap,
  carrierHint, guardHint, onToggleCarrier, onSetGuards,
}) => {
  useI18n();
  const [allFleets, setAllFleets] = useState(false);
  const [showLoose, setShowLoose] = useState(false);

  const me = gameState.factions.find(f => f.id === 'player');
  const c1 = me?.color ?? '#4ecdc4';
  const c2 = me?.color2 || deriveSecondary(c1);

  // Whole ticks only: the grouping re-plans every trip, so it follows
  // the tick, not the frame.
  const tickKey = Math.floor(gameState.currentTick);
  const freight = useMemo(
    () => groupByWorld(freighters, firstStopId, gameState, freighterAccel(gameState)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [freighters, firstStopId, tickKey, gameState.bodies],
  );
  const guardGroups = useMemo(
    () => groupGuards(warships, firstStopId, gameState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [warships, firstStopId, tickKey, gameState.bodies, gameState.fleets],
  );

  const bodyOf = (id: string) => gameState.bodies.find(b => b.id === id);
  const bodyName = (id: string) => bodyOf(id)?.name ?? id;
  const firstName = firstStopId ? bodyName(firstStopId) : '';
  const etaText = (eta: number | null, enRoute = false) =>
    eta == null ? '' : eta === 0 && !enRoute ? t('route.ships.here') : t('route.ships.ticksOut', { n: eta });
  const icon = (s: Ship, size: number) => (
    <ShipIcon shipClass={iconClassFor(s.class)} variant={s.iconVariant} size={size} color={c1} color2={c2} />
  );
  const globe = (bodyId: string, size: number) => {
    const b = bodyOf(bodyId);
    return b ? <PlanetIcon body={b} size={size} currentTick={gameState.currentTick} animate={false} className="rsp-globe" /> : null;
  };

  const carrierFull = carriers.length >= carrierCap;
  const carrierBtn = (spot: ShipSpot, kind: 'card' | 'tok', suffix?: string) => {
    const s = spot.ship;
    const on = carriers.includes(s.id);
    const blocked = !on && carrierFull;
    return (
      <button
        key={s.id}
        type="button"
        className={`rsp-${kind}${on ? ' on' : ''}`}
        aria-pressed={on}
        disabled={blocked}
        title={blocked ? carrierHint : undefined}
        onClick={() => onToggleCarrier(s.id)}
      >
        {kind === 'card' && on && <span className="rsp-badge">{t('route.tab.runsIt')}</span>}
        {icon(s, kind === 'card' ? 60 : 24)}
        <span className="rsp-ship-name">{s.name}</span>
        {spot.enRoute && <span className="rsp-tag">{t('route.ships.enRoute')}</span>}
        {suffix && <span className="rsp-suffix">· {suffix}</span>}
      </button>
    );
  };

  const toggleSet = (ids: string[]) => {
    const all = ids.every(id => guards.includes(id));
    onSetGuards(all ? guards.filter(id => !ids.includes(id)) : [...guards, ...ids.filter(id => !guards.includes(id))]);
  };
  const guardTok = (spot: ShipSpot, suffix?: string) => {
    const s = spot.ship;
    const on = guards.includes(s.id);
    return (
      <button key={s.id} type="button" className={`rsp-tok${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => toggleSet([s.id])}>
        {icon(s, 24)}
        <span className="rsp-ship-name">{s.name}</span>
        {suffix && <span className="rsp-suffix">· {suffix}</span>}
      </button>
    );
  };

  const nearFirst = !!firstStopId;
  const cardWorlds = nearFirst ? freight.worlds.slice(0, CARD_WORLDS) : [];
  const tokenWorlds = nearFirst ? freight.worlds.slice(CARD_WORLDS) : freight.worlds;

  const worldHead = (g: WorldGroup, small: boolean) => (
    <div className="rsp-world-head">
      <span className={`rsp-wname${small ? ' is-small' : ''}`}>{bodyName(g.bodyId)}</span>
      {g.eta != null && (
        <span className={`rsp-eta${g.eta === 0 ? ' is-here' : ''}`}>{etaText(g.eta)}</span>
      )}
    </div>
  );

  const farStrip = (g: FarGroup, render: (spot: ShipSpot, suffix: string) => React.ReactNode) => (
    <div className="rsp-gate" key={g.systemId}>
      <svg width="30" height="30" viewBox="0 0 36 36" aria-hidden="true" className="rsp-gate-glyph">
        <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="18" r="9" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
        <circle cx="18" cy="18" r="3" fill="currentColor" />
      </svg>
      <div className="rsp-gate-main">
        <div className="rsp-world-head">
          <span className="rsp-wname">{t('route.ships.farSystem', { system: systemLabel(g.systemId, gameState.bodies) })}</span>
          <span className="rsp-eta">{t('route.ships.throughGate')}</span>
        </div>
        <div className="rsp-toks">{g.ships.map(sp => render(sp, bodyName(sp.bodyId)))}</div>
      </div>
    </div>
  );

  const fleetCard = (f: FleetPick) => {
    const ids = f.members.map(m => m.id);
    const on = ids.every(id => guards.includes(id));
    const escorts = f.members.filter(m => m.id !== f.lead.id).slice(0, 3);
    const mix = (['corvette', 'frigate', 'destroyer'] as const)
      .map(cls => ({ cls, ships: f.members.filter(m => m.class === cls) }))
      .filter(x => x.ships.length > 0);
    const where = f.enRoute
      ? t('route.ships.inFlightTo', { world: bodyName(f.bodyId) })
      : t('route.ships.atWorld', { world: bodyName(f.bodyId) });
    return (
      <button key={f.fleet.id} type="button" className={`rsp-fleet${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => toggleSet(ids)}>
        {on && <span className="rsp-badge rsp-badge--fleet">{t('route.ships.guarding')}</span>}
        <span className="rsp-formation" aria-hidden="true">
          {escorts.map((m, i) => (
            <span key={m.id} className={`rsp-escort rsp-escort--${i}`}>{icon(m, 22)}</span>
          ))}
          <span className="rsp-flag">{icon(f.lead, 56)}</span>
        </span>
        <span className="rsp-fleet-main">
          <span className="rsp-fleet-name">{f.fleet.name}</span>
          <span className="rsp-fleet-where">
            {globe(f.bodyId, 14)}
            {where}
            {!f.here && f.eta != null ? ` · ${etaText(f.eta, f.enRoute)}` : ''}
          </span>
          <span className="rsp-mix">
            {mix.map(x => (
              <span key={x.cls}>{icon(x.ships[0], 18)}{x.ships.length}</span>
            ))}
          </span>
        </span>
      </button>
    );
  };

  const fleetsHere = guardGroups.fleets.filter(f => f.here);
  const fleetsAway = guardGroups.fleets.filter(f => !f.here);
  const awayShown = allFleets ? fleetsAway : fleetsAway.slice(0, FLEETS_SHOWN);
  const looseCount = guardGroups.loose.worlds.reduce((a, g) => a + g.ships.length, 0)
    + guardGroups.loose.far.reduce((a, g) => a + g.ships.length, 0);

  return (
    <div className="rsp">
      <section className="rsp-section">
        <div className="rsp-head">
          <span className="rsp-title">{t('route.ships.runsTitle')}</span>
          <span className="rsp-sub">
            {nearFirst
              ? t('route.ships.freeNearest', { n: freighters.length, stop: firstName })
              : t('route.ships.freeByWorld', { n: freighters.length })}
          </span>
        </div>
        {freighters.length === 0 && <span className="rc-empty">{t('route.composer.noneAvailable')}</span>}
        {freight.worlds.length > 0 && (
          <div className="rsp-path">
            {cardWorlds.map(g => (
              <div className="rsp-world" key={g.bodyId}>
                <div className="rsp-node">{globe(g.bodyId, 38)}</div>
                <div className="rsp-world-main">
                  {worldHead(g, false)}
                  <div className="rsp-cards">{g.ships.map(sp => carrierBtn(sp, 'card'))}</div>
                </div>
              </div>
            ))}
            {cardWorlds.length > 0 && tokenWorlds.length > 0 && (
              <div className="rsp-k rsp-further">{t('route.ships.furtherOut')}</div>
            )}
            {tokenWorlds.map(g => (
              <div className="rsp-world is-small" key={g.bodyId}>
                <div className="rsp-node">{globe(g.bodyId, 26)}</div>
                <div className="rsp-world-row">
                  {worldHead(g, true)}
                  {g.ships.map(sp => carrierBtn(sp, 'tok'))}
                </div>
              </div>
            ))}
          </div>
        )}
        {freight.far.map(g => farStrip(g, (sp, where) => carrierBtn(sp, 'tok', where)))}
        {carrierHint && <div className="rc-hint">{carrierHint}</div>}
      </section>

      <section className="rsp-section">
        <div className="rsp-head">
          <span className="rsp-title">{t('route.ships.guardsTitle')}</span>
          <span className="rsp-sub">{t('route.ships.guardsSub')}</span>
        </div>
        {warships.length === 0 && <span className="rc-empty">{t('route.composer.noneAvailable')}</span>}
        {fleetsHere.length > 0 && (
          <>
            <div className="rsp-k">{t('route.ships.fleetsAt', { world: firstName })}</div>
            <div className="rsp-fleets">{fleetsHere.map(fleetCard)}</div>
          </>
        )}
        {fleetsAway.length > 0 && (
          <>
            {fleetsHere.length > 0 && <div className="rsp-k">{t('route.ships.elsewhere')}</div>}
            <div className="rsp-fleets">{awayShown.map(fleetCard)}</div>
          </>
        )}
        {(fleetsAway.length > FLEETS_SHOWN || looseCount > 0) && (
          <div className="rsp-more">
            {fleetsAway.length > FLEETS_SHOWN && (
              <button type="button" className="rsp-more-btn" aria-expanded={allFleets}
                      onClick={() => setAllFleets(v => !v)}>
                {allFleets ? t('route.ships.fewerFleets') : tn('route.ships.moreFleets', fleetsAway.length - FLEETS_SHOWN)}
              </button>
            )}
            {looseCount > 0 && (
              <button type="button" className="rsp-more-btn" aria-expanded={showLoose}
                      onClick={() => setShowLoose(v => !v)}>
                {tn('route.ships.loose', looseCount)}
              </button>
            )}
          </div>
        )}
        {showLoose && (
          <div className="rsp-loose">
            {guardGroups.loose.worlds.map(g => {
              const ids = g.ships.map(sp => sp.ship.id);
              const all = ids.every(id => guards.includes(id));
              return (
                <div className="rsp-loose-world" key={g.bodyId}>
                  <div className="rsp-loose-head">
                    {globe(g.bodyId, 20)}
                    {worldHead(g, true)}
                    <button type="button" className="rsp-pickall" onClick={() => toggleSet(ids)}>
                      {all ? t('route.ships.dropAll') : tn('route.ships.pickAll', ids.length)}
                    </button>
                  </div>
                  <div className="rsp-toks">{g.ships.map(sp => guardTok(sp))}</div>
                </div>
              );
            })}
            {guardGroups.loose.far.map(g => farStrip(g, (sp, where) => guardTok(sp, where)))}
          </div>
        )}
        {guardHint && <div className="rc-hint">{guardHint}</div>}
      </section>
    </div>
  );
};

export default RouteShipPicker;
