import React, { useEffect, useRef, useState } from 'react';
import { TradesPanel } from './TradesPanel';
import { MarketPanel } from './MarketPanel';
import { SettlementTradeTab } from './SettlementTradeTab';
import { RouteComposer } from './RouteComposer';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import type { RouteStopInput } from './MultiplayerActionsContext';
import { routeStops } from '../game/routeSelectors';
import { openScreen } from './telemetry';
import type { TradeRoute } from '../types';

// TRADE DOCK — trade is its own side panel, not a tab buried under
// Multiplayer and a filter chip buried under Empire.
//
// Two homes for the same concern was the complaint: offers lived in
// Multiplayer › Trades, the freight routes those offers spawn lived in
// Empire › trade, and a player chasing "why is my freighter idle" had
// to know which of the two to open. Both now sit behind ONE rail icon:
//
//   PRIVATE  — offers, counters, agreements (the old Trades tab).
//   ROUTES   — the freight itineraries and the route composer (the old
//              Empire › trade view). Empire-wide, not per-body: a milk
//              run touches four settlements and belongs to none of them.
//
//   MARKET   — open posts: offers with no named responder, visible to
//              every faction and takeable by any. First tab, because it
//              is the one you browse; PRIVATE is the one you answer.
//
// Same rail contract as MultiplayerShell: the DockRail is the single
// source of truth for which panel is open; we render only when it says
// active === 'trade', and every open/close we initiate goes back
// through 'dockrail:set'. railMounted keeps the sheet in the tree for
// one 250ms beat after close so the slide-out gets a frame to play.
//
// The pending-trade badge (incoming offers + unassigned freighters)
// is still counted in MultiplayerShell, which already polls the trade
// list for its WS toasts; it dispatches 'dockrail:badge' for 'trade'
// and we mirror the count onto the PRIVATE tab here.

type TradeTab = 'market' | 'private' | 'routes';

export function TradeDock() {
  const { gameState } = useGameContext();
  const mp = useMultiplayerActions();
  const gameId = mp?.gameId ?? null;

  const [railOpen, setRailOpen] = useState(false);
  const [railMounted, setRailMounted] = useState(false);
  const [tab, setTab] = useState<TradeTab>('market');
  const pendingRef = useRef(0);
  // Set by a deep link so the "open on PRIVATE when something is
  // pending" rule below cannot override the tab the link asked for.
  const deepLinkRef = useRef(false);
  const [pending, setPending] = useState(0);
  // The route composer, opened from ROUTES. Held here rather than inside
  // the tab so it renders over the whole sheet instead of the scroll box.
  const [composer, setComposer] = useState<{
    routeId?: string;
    name?: string | null;
    stops: RouteStopInput[];
  } | null>(null);

  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const open = detail?.active === 'trade';
      setRailOpen(open);
      // Something is waiting on YOUR answer: open on it, not on the
      // board. Only on the opening edge — never yank a tab mid-use.
      if (open && pendingRef.current > 0 && !deepLinkRef.current) setTab('private');
      deepLinkRef.current = false;
      if (open) setRailMounted(true);
      else setTimeout(() => setRailMounted(false), 250);
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // Deep links: the SitLog's trade items, the offer modal's "Take Me
  // There" and the world menu all dispatch 'orbital:open-panel' with
  // 'trades' (offers) or 'routes' (itineraries). Pick the tab, then ask
  // the rail to open us.
  useEffect(() => {
    const onOpenPanel = (e: Event) => {
      const panel = (e as CustomEvent).detail?.panel;
      if (panel !== 'trades' && panel !== 'routes' && panel !== 'market') return;
      setTab(panel === 'routes' ? 'routes' : panel === 'market' ? 'market' : 'private');
      deepLinkRef.current = true;
      try { window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: 'trade' } })); } catch {}
    };
    window.addEventListener('orbital:open-panel', onOpenPanel as EventListener);
    return () => window.removeEventListener('orbital:open-panel', onOpenPanel as EventListener);
  }, []);

  useEffect(() => {
    const onBadge = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.which !== 'trade') return;
      pendingRef.current = Number(detail.count) | 0;
      setPending(pendingRef.current);
    };
    window.addEventListener('dockrail:badge', onBadge as EventListener);
    return () => window.removeEventListener('dockrail:badge', onBadge as EventListener);
  }, []);

  // The composer and the market panel move you to where the thing you
  // just made now lives (a post -> MARKET, a counter -> PRIVATE).
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail?.tab;
      if (t === 'market' || t === 'private' || t === 'routes') setTab(t);
    };
    window.addEventListener('tradedock:tab', onTab as EventListener);
    return () => window.removeEventListener('tradedock:tab', onTab as EventListener);
  }, []);

  useEffect(() => {
    if (railOpen) openScreen(gameId, `trade:${tab}`);
  }, [gameId, tab, railOpen]);

  const close = () => {
    try { window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: null } })); } catch {}
  };

  if (!gameId || !railMounted) return null;

  return (
    <div className={`dock-panel mp-dock trade-dock${railOpen ? ' is-open' : ''}`}>
      <div className="mp-dock-head">
        <span className="mp-dock-head__title">
          <TradeGlyph />
          Trade
        </span>
        <button
          className="mp-dock-collapse-btn"
          onClick={close}
          title="Close panel"
          aria-label="Close trade panel"
        >×</button>
      </div>
      {railOpen && (
        <>
          <div className="mp-tablist">
            <button
              className={tab === 'market' ? 'active' : ''}
              onClick={() => setTab('market')}
              title="Open posts — offers anyone can take, visible to every faction"
            >
              Market
            </button>
            <button
              className={tab === 'private' ? 'active' : ''}
              onClick={() => setTab('private')}
              title={pending > 0
                ? `${pending} trade action${pending > 1 ? 's' : ''} pending — offers or unassigned freighters`
                : 'Offers, counters and agreements between factions'}
            >
              Private{pending > 0 && (
                <span style={{
                  marginLeft: 4, padding: '0 5px', fontSize: 9,
                  background: '#ffb84d', color: '#0a0e14', borderRadius: 8,
                  fontWeight: 700,
                }}>{pending}</span>
              )}
            </button>
            <button
              className={tab === 'routes' ? 'active' : ''}
              onClick={() => setTab('routes')}
              title="Your freight itineraries and the crews running them"
            >
              Routes
            </button>
          </div>
          <div className="mp-dock-body">
            {tab === 'market' && <MarketPanel gameId={gameId} />}
            {tab === 'private' && <TradesPanel gameId={gameId} />}
            {tab === 'routes' && (
              <SettlementTradeTab
                gameState={gameState}
                onEditRoute={(r: TradeRoute) => setComposer({
                  routeId: r.id,
                  name: r.name ?? null,
                  stops: routeStops(r).map(st => ({
                    bodyId: st.bodyId, action: st.action,
                    takeMetal: st.takeMetal, takeGold: st.takeGold, takeScience: st.takeScience,
                  })),
                })}
                onNewRoute={(bid?: string) => setComposer({
                  stops: bid
                    ? [{ bodyId: bid, action: 'pickup', takeMetal: true, takeGold: true, takeScience: true }]
                    : [],
                })}
              />
            )}
          </div>
        </>
      )}
      {composer && (
        <RouteComposer
          gameState={gameState}
          routeId={composer.routeId}
          initialName={composer.name ?? null}
          initialStops={composer.stops}
          onClose={() => setComposer(null)}
        />
      )}
    </div>
  );
}

/** Two crossing arrows — goods going both ways. Matches the rail's
 *  TradeIcon so the sheet reads as coming from that button. */
const TradeGlyph: React.FC = () => (
  <svg className="mp-dock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </svg>
);
