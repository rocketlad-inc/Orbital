// ============================================================
// SettlementsPanel — overview of all deployed settlements
// (cities and stations). Shows production, stockpile, HP,
// population, and lets the user jump to any of them.
// ============================================================

import React, { useMemo, useState } from 'react';
import { empireYieldMultipliers, applyYieldMultipliers } from '../game/yieldMultipliers';
import { useGameContext } from '../state/gameContext';
import { settlementYield, SETTLEMENT_DEFS } from '../game/settlements';
import { deriveSecondary } from '../game/colorUtils';
import { makeSystemRootOf, systemLabel as systemLabelOf } from '../game/systemGrouping';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { EconomyPanel } from './EconomyPanel';
import { SettlementTradeTab } from '../multiplayer/SettlementTradeTab';
import { RouteComposer } from '../multiplayer/RouteComposer';
import { routeStops } from '../game/routeSelectors';
import type { RouteStopInput } from '../multiplayer/MultiplayerActionsContext';
import type { TradeRoute } from '../types';
import './OverviewPanel.css';
// Borrow the Fleet panel's chrome so the two overview screens read as one
// family: same scroll shell, same collapsible system headers, same card
// treatment. Settlements was the odd one out — a 9-column table.
import './FleetPanel.css';

// Translucent fill from a hex colour, for faction-tinted owner badges.
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface SettlementsPanelProps {
  onClose: () => void;
}

type Filter = 'all' | 'player' | 'enemy' | 'cities' | 'stations' | 'economy' | 'trade';

export const SettlementsPanel: React.FC<SettlementsPanelProps> = ({ onClose }) => {
  const { gameState, selectSettlement, selectBody, focusBody, selectedSettlementId } = useGameContext();
  const empireMul = empireYieldMultipliers(gameState);
  const mpActions = useMultiplayerActions();
  const [filter, setFilter] = useState<Filter>('player');
  // The route composer, opened from the trade view. Held here rather
  // than inside the tab so it renders over the whole panel instead of
  // inside the scroll box.
  const [composer, setComposer] = useState<{
    routeId?: string;
    name?: string | null;
    stops: RouteStopInput[];
  } | null>(null);

  const rows = useMemo(() => {
    return gameState.settlements
      .map(settlement => {
        const body = gameState.bodies.find(b => b.id === settlement.bodyId);
        const ownerFaction = gameState.factions.find(f => f.id === settlement.ownedBy);
        const ownerFreighters = gameState.ships.filter(s =>
          s.ownedBy === settlement.ownedBy &&
          s.class === 'freighter' &&
          !s.transit &&
          s.orbit.parentBodyId === settlement.bodyId
        );
        const yields = body
          ? applyYieldMultipliers(settlementYield(settlement, body), empireMul)
          : { fuel: 0, ore: 0, credits: 0, science: 0 };
        return { settlement, body, ownerFaction, ownerFreighters, yields };
      })
      .filter(r => {
        if (filter === 'player') return r.settlement.ownedBy === 'player';
        if (filter === 'enemy') return r.settlement.ownedBy === 'enemy';
        if (filter === 'cities') return r.settlement.type === 'city';
        if (filter === 'stations') return r.settlement.type === 'station';
        return true;
      })
      .sort((a, b) => {
        // Player first, then alphabetically
        const aP = a.settlement.ownedBy === 'player' ? 0 : 1;
        const bP = b.settlement.ownedBy === 'player' ? 0 : 1;
        if (aP !== bP) return aP - bP;
        return a.settlement.name.localeCompare(b.settlement.name);
      });
  }, [gameState.settlements, gameState.bodies, gameState.factions, gameState.ships, filter]);

  // Group the filtered rows by star system, exactly as FleetPanel does —
  // same helper, so a body files under the same heading in both panels.
  const systemRootOf = useMemo(() => makeSystemRootOf(gameState.bodies), [gameState.bodies]);
  const systems = useMemo(() => {
    const bySystem = new Map<string, typeof rows>();
    for (const r of rows) {
      const root = systemRootOf(r.settlement.bodyId);
      const list = bySystem.get(root) ?? [];
      list.push(r);
      bySystem.set(root, list);
    }
    return [...bySystem.entries()]
      .map(([rootId, items]) => ({
        rootId,
        label: systemLabelOf(gameState.bodies, rootId),
        rootBody: gameState.bodies.find(b => b.id === rootId),
        items,
      }))
      .sort((a, b) => (a.rootBody?.orbitRadius ?? 0) - (b.rootBody?.orbitRadius ?? 0));
  }, [rows, systemRootOf, gameState.bodies]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleSystem = (rootId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId); else next.add(rootId);
      return next;
    });
  };

  // Picking a settlement is a navigation, not a selection: it opens the body
  // inspector, which sits in the same top-left real estate as this list and
  // would otherwise be buried under it. Close the list on the way out.
  const handleRowClick = (settlementId: string, bodyId: string) => {
    selectSettlement(settlementId);
    selectBody(bodyId);
    focusBody(bodyId);
    onClose();
  };

  // Faction id -> display name + two-tone colour (mirrors FleetPanel and
  // the map §5). Fixes the OWNER column showing a raw faction id
  // ("FY2AB2S47DSP:F2") instead of the empire name, and carries the
  // players' colours into the list.
  const factionById = useMemo(() => {
    const m = new Map<string, { name: string; color: string; color2: string }>();
    for (const f of gameState.factions) {
      m.set(f.id, { name: f.name, color: f.color, color2: f.color2 || deriveSecondary(f.color) });
    }
    return m;
  }, [gameState.factions]);

  const factionOf = (ownedBy: string): { name: string; color: string; color2: string } => {
    if (ownedBy === 'player') return { name: 'You', color: '#4ecdc4', color2: deriveSecondary('#4ecdc4') };
    if (ownedBy === 'enemy') return { name: 'Enemy', color: '#ff5e5e', color2: deriveSecondary('#ff5e5e') };
    const f = factionById.get(ownedBy);
    if (f) return f;
    // Unknown id: show the short suffix, never the game-namespaced id.
    return { name: ownedBy.split(':').pop() ?? ownedBy, color: '#8a9fb3', color2: deriveSecondary('#8a9fb3') };
  };

  const ownerBadge = (ownedBy: string) => {
    const { name, color, color2 } = factionOf(ownedBy);
    return (
      <span
        className="owner-badge"
        style={{
          color, borderColor: color, background: hexToRgba(color, 0.12),
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        {/* two-tone swatch: primary / secondary split, same livery as the map */}
        <span
          aria-hidden
          style={{
            width: 10, height: 10, borderRadius: 2, flexShrink: 0,
            background: `linear-gradient(135deg, ${color} 0%, ${color} 62%, ${color2} 62%, ${color2} 100%)`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
          }}
        />
        {name}
      </span>
    );
  };

  const renderHpBar = (s: { hp: number; maxHp: number }) => {
    const ratio = s.hp / s.maxHp;
    const hpClass = ratio > 0.66 ? 'good' : ratio > 0.33 ? 'mid' : 'low';
    return (
      <div className="status-bar">
        <div className="status-bar__fill">
          <div
            className={`status-bar__inner status-bar__inner--hp-${hpClass}`}
            style={{ width: `${Math.max(0, ratio * 100)}%` }}
          />
        </div>
        <span className="status-bar__text">{Math.round(s.hp)}/{s.maxHp}</span>
      </div>
    );
  };

  // Aggregate stats for the player
  const playerStats = useMemo(() => {
    const player = gameState.settlements.filter(s => s.ownedBy === 'player');
    return {
      total: player.length,
      cities: player.filter(s => s.type === 'city').length,
      stations: player.filter(s => s.type === 'station').length,
      totalPop: player.reduce((sum, s) => sum + s.population, 0),
      stockpile: player.reduce(
        (acc, s) => ({
          fuel: acc.fuel + s.stockpile.fuel,
          ore: acc.ore + s.stockpile.ore,
          credits: acc.credits + s.stockpile.credits,
        }),
        { fuel: 0, ore: 0, credits: 0 }
      ),
    };
  }, [gameState.settlements]);

  return (
    <div className="overview-panel">
      {composer && (
        <RouteComposer
          gameState={gameState}
          routeId={composer.routeId}
          initialName={composer.name ?? null}
          initialStops={composer.stops}
          onClose={() => setComposer(null)}
        />
      )}
      <div className="overview-panel__header">
        <div className="overview-panel__title">
          <div className="overview-panel__title-main">Empire</div>
          <div className="overview-panel__title-sub">
            {playerStats.total} player · {playerStats.cities} cities · {playerStats.stations} stations · pop {playerStats.totalPop}
            {playerStats.total > 0 && (
              <>
                {' · stockpile '}
                <span style={{ color: '#a0a0a0' }}>{Math.floor(playerStats.stockpile.ore)}M</span>
                {' '}
                <span style={{ color: '#ffd700' }}>{Math.floor(playerStats.stockpile.credits)}C</span>
              </>
            )}
          </div>
        </div>
        <button className="overview-panel__close" onClick={onClose}>✕</button>
      </div>

      <div className="overview-panel__filters">
        {([...(['player', 'enemy', 'cities', 'stations', 'all'] as Filter[]),
          // MP only: the ledger is per-faction and there is no
          // faction to bill in single player.
          // Trade and the economy ledger are both per-faction, and
          // there is no faction to bill or haul for in single player.
          ...(mpActions ? (['trade', 'economy'] as Filter[]) : [])]).map(f => (
          <button
            key={f}
            className={`filter-chip ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {/* CARDS, NOT A TABLE — and laid out to FIT.
          This was a 9-column table inside a scrolling body: every column
          fought for width, the numbers wrapped, and any real empire ran
          off the bottom. Two changes fix both complaints at once.
          1. Fleet's chrome: the same collapsible per-system headers and
             the same card treatment, so the two overview panels stop
             looking like they came from different games.
          2. A MULTI-COLUMN card grid. Fleet stacks one card per row
             because a ship line is wide; a settlement summary is narrow,
             so two or three fit side by side and the whole holding list
             lands in a third of the height. That is what removes the
             scrolling — not hiding data, just stopping it queueing in a
             single file. */}
      {filter === 'trade' && mpActions ? (
        /* TRADE (DESIGN-trade-v2 §5). Empire-wide, not per-body: a milk
           run touches four settlements and belongs to none of them, so
           scoping it to one rock was the wrong home — it lived in the
           world menu first and read as clutter on a body sheet. Here it
           sits beside the other holdings views, which is where a player
           goes to ask "what is my empire doing". */
        <div className="fleet-scroll">
          <div className="fleet-scroll__inner">
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
          </div>
        </div>
      ) : filter === 'economy' && mpActions ? (
        <div className="fleet-scroll">
          <div className="fleet-scroll__inner">
            <EconomyPanel gameId={mpActions.gameId} />
          </div>
        </div>
      ) : (
      <div className="fleet-scroll">
        <div className="fleet-scroll__inner">
          {rows.length === 0 ? (
            <div className="overview-empty">
              No settlements match the filter.
              {filter === 'player' && (
                <div style={{ marginTop: 8, fontSize: 10 }}>
                  Deploy a city or station from a body's inspector to start a colony.
                </div>
              )}
            </div>
          ) : (
            systems.map(system => {
              const isCollapsed = collapsed.has(system.rootId);
              const cities = system.items.filter(r => r.settlement.type === 'city').length;
              const stations = system.items.length - cities;
              return (
                <div className="fleet-sys" key={system.rootId}>
                  <button
                    className="fleet-sys__header"
                    onClick={() => toggleSystem(system.rootId)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`fleet-sys__caret${isCollapsed ? ' fleet-sys__caret--collapsed' : ''}`} aria-hidden>▾</span>
                    <span className="fleet-sys__dot" style={{ background: system.rootBody?.color || '#888' }} aria-hidden />
                    <span className="fleet-sys__name">{system.label}</span>
                    <span className="fleet-sys__meta">
                      {cities > 0 && `${cities} ${cities === 1 ? 'city' : 'cities'}`}
                      {cities > 0 && stations > 0 && ' · '}
                      {stations > 0 && `${stations} station${stations === 1 ? '' : 's'}`}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="set-grid">
                      {system.items.map(({ settlement: s, body, ownerFreighters, yields }) => {
                        const isSelected = selectedSettlementId === s.id;
                        const def = SETTLEMENT_DEFS[s.type];
                        const hasStock = s.stockpile.ore > 0 || s.stockpile.credits > 0;
                        return (
                          <button
                            key={s.id}
                            className={`set-card${isSelected ? ' set-card--selected' : ''}`}
                            onClick={() => handleRowClick(s.id, s.bodyId)}
                            title={`${s.name} — ${def.displayName} on ${body?.name ?? s.bodyId}`}
                          >
                            <span
                              className="set-card__icon"
                              style={{
                                background: body?.color || '#888',
                                borderRadius: s.type === 'city' ? '50%' : '2px',
                              }}
                              aria-hidden
                            />
                            <span className="set-card__body">
                              <span className="set-card__l1">
                                <span className="set-card__name">{s.name}</span>
                                <span className="set-card__where">{body?.name ?? s.bodyId}</span>
                              </span>
                              <span className="set-card__l2">
                                {ownerBadge(s.ownedBy)}
                                <span className="set-card__pop" title="Population">pop {s.population}</span>
                                {ownerFreighters.length > 0 && (
                                  <span className="set-card__frt" title="Freighters docked here">
                                    ⛟{ownerFreighters.length}
                                  </span>
                                )}
                              </span>
                              <span className="set-card__l3">
                                <span className={yields.ore > 0 ? 'prod-rate prod-rate--ore' : 'prod-rate prod-rate--zero'}>
                                  {yields.ore > 0 ? `+${yields.ore.toFixed(1)}M` : '—'}
                                </span>
                                <span className={yields.credits > 0 ? 'prod-rate prod-rate--credits' : 'prod-rate prod-rate--zero'}>
                                  {yields.credits > 0 ? `+${yields.credits.toFixed(1)}C` : '—'}
                                </span>
                                <span className="set-card__stock" title="Banked on site">
                                  {hasStock
                                    ? `${Math.floor(s.stockpile.ore)}M ${Math.floor(s.stockpile.credits)}C`
                                    : 'empty'}
                                </span>
                              </span>
                              {renderHpBar(s)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      )}
    </div>
  );
};
