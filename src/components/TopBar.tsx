// ============================================================
// TopBar — persistent top strip
// Title | Resources | Nav buttons | Time / Sim controls | Alerts
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameContext } from '../state/gameContext';
import { useTurnBasedSettings } from '../state/turnBasedSettings';
import { computeTurnBudget } from '../game/turnBudget';
import { useAuth } from '../multiplayer/AuthContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { useMpTurnStatus } from '../multiplayer/useMpTurnStatus';
import { logger } from '../game/logger';
import { SaveLoadModal } from './SaveLoadModal';
import { AdminGrantModal } from './AdminGrantModal';
import { computeIncomePerTick } from '../game/settlements';
import { TECH_DEFS } from '../game/techs';
import { useTutorial } from '../state/tutorial';
import { TUTORIAL_STEP_COUNT } from '../game/tutorialSteps';
import type { GameState } from '../types';
import './TopBar.css';

// Hint text under the Restart Tutorial menu item. Pulled out to a
// constant so it doesn't allocate a new string every render.
const TUTORIAL_STEP_COUNT_HINT = `${TUTORIAL_STEP_COUNT} steps · ~1 min`;

export type PanelId = 'settlements' | 'fleet' | 'research' | null;

interface TopBarProps {
  activePanel: PanelId;
  onTogglePanel: (panel: PanelId) => void;
  onExitMode?: () => void;
  /** Hide sim-speed buttons and tick-skip controls. Used in multiplayer:
   *  the server dictates the tick rate set in the lobby, players can't
   *  fast-forward or skip locally. */
  hideSimControls?: boolean;
  /** Room/game id for the side-menu admin section (host-only). When set
   *  and isHost is true, the menu shows Force-Tick controls. */
  adminGameId?: string | null;
  isHost?: boolean;
  /** True when the SideMenu should offer Save/Load entries. Single-player
   *  only — MP saves are server-side and out of scope. */
  canSaveLoad?: boolean;
  /** Threaded down from SinglePlayerView so the Load picker can hand the
   *  deserialized state back to the parent, which remounts GameContextProvider. */
  onLoadSave?: (state: GameState) => void;
}

interface Alert {
  id: string;
  level: 'info' | 'warn' | 'danger';
  text: string;
  onClick?: () => void;
}

const SIM_SPEEDS = [1, 10, 100, 1000, 10000, 100000];

export const TopBar: React.FC<TopBarProps> = ({
  activePanel, onTogglePanel, onExitMode, hideSimControls = false,
  adminGameId = null, isHost = false,
  canSaveLoad = false, onLoadSave,
}) => {
  const {
    gameState, simSpeed, setSimSpeed, updateTick, selectShip,
    turnBasedActive, commitTurn,
  } = useGameContext();
  // MP turn status: only present when wrapped in MultiplayerActionsProvider.
  // Drives the MP-flavored COMMIT TURN UI (waiting-on banner, server commit
  // call, ready/needed badge). In SP this returns null and we fall through
  // to the local TBM path below.
  const mpActions = useMultiplayerActions();
  const { status: mpTurnStatus, refresh: refreshTurnStatus } = useMpTurnStatus();
  const mpTbmActive = !!mpTurnStatus?.turn_based_enabled;
  const { user, signOut } = useAuth();
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Save / Load modal state. Lifted into TopBar (rather than SideMenu)
  // because closing the menu shouldn't kill the modal — players want to
  // see the picker without the menu also occupying the screen.
  const [saveLoadMode, setSaveLoadMode] = useState<null | 'save' | 'load'>(null);
  // Admin resource-grant modal — opened from the DEBUG section of the
  // SideMenu. SP-always-visible; MP-host-only on the server side.
  const [adminGrantOpen, setAdminGrantOpen] = useState(false);

  // Esc closes the drawer
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const playerResources = gameState.resources['player'];
  const playerShips = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player'),
    [gameState.ships]
  );

  // Per-tick income for the resource pill subtext. Splits "delivered"
  // (settlements with a freighter parked = actually reaches the pool)
  // from "stranded" (no freighter = stockpiling at the settlement, not
  // landing in CR). The stranded count is surfaced as a hover hint so
  // the player knows *why* their gold pile isn't moving.
  const income = useMemo(() => {
    const lvl = gameState.factionTech?.player?.levels?.industry ?? 0;
    const yieldMul = 1 + TECH_DEFS.industry.perLevel * lvl;
    return computeIncomePerTick(
      'player',
      gameState.settlements,
      gameState.bodies,
      gameState.ships,
      yieldMul,
    );
  }, [gameState.settlements, gameState.bodies, gameState.ships, gameState.factionTech]);

  // Derive alerts from game state
  const alerts = useMemo<Alert[]>(() => {
    const out: Alert[] = [];

    // Recent combat events (top 2)
    if (gameState.combatLog.length > 0) {
      const recent = gameState.combatLog.slice(-2);
      recent.forEach((msg, i) => {
        out.push({
          id: `combat-${gameState.combatLog.length - recent.length + i}`,
          level: 'danger',
          text: msg.length > 60 ? msg.slice(0, 60) + '…' : msg,
        });
      });
    }

    // Ships arriving soon (within 5 ticks).
    for (const ship of playerShips) {
      let targetBodyId: string | undefined;
      let arrivalTick: number | undefined;
      if (ship.transit) {
        targetBodyId = ship.transit.currentTransfer.targetBodyId;
        arrivalTick = ship.transit.currentTransfer.arriveTick;
      }
      if (targetBodyId && arrivalTick !== undefined) {
        const eta = arrivalTick - gameState.currentTick;
        if (eta <= 5 && eta > 0) {
          const target = gameState.bodies.find(b => b.id === targetBodyId);
          out.push({
            id: `arrive-${ship.id}`,
            level: 'info',
            text: `${ship.name} arriving at ${target?.name || '?'} in T-${eta.toFixed(0)}`,
            onClick: () => selectShip(ship.id),
          });
        }
      }
    }

    // Low fuel ships
    for (const ship of playerShips) {
      if (ship.fuel < 20) {
        out.push({
          id: `lowfuel-${ship.id}`,
          level: 'warn',
          text: `${ship.name} low fuel (${Math.round(ship.fuel)})`,
          onClick: () => selectShip(ship.id),
        });
      }
    }

    return out.filter(a => !dismissedAlertIds.has(a.id));
  }, [gameState, playerShips, dismissedAlertIds, selectShip]);

  const dismissAlert = (id: string) => {
    setDismissedAlertIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handleSkip = (n: number) => updateTick(gameState.currentTick + n);

  // Games run indefinitely — no tick countdown to surface.
  const tickStr = `T+${Math.floor(gameState.currentTick)}`;

  return (
    <div className="top-bar">
      <button
        className="top-bar__title"
        onClick={() => setMenuOpen(true)}
        title="Open menu"
        aria-label="Open menu"
        data-tutorial-id="menu-button"
      >
        <div className="top-bar__title-main">ORBITAL</div>
        <div className="top-bar__title-sub">v0.3 · menu</div>
      </button>

      {menuOpen && (
        <SideMenu
          onClose={() => setMenuOpen(false)}
          onExitMode={onExitMode}
          user={user}
          onSignOut={signOut}
          adminGameId={adminGameId}
          isHost={isHost}
          activePanel={activePanel}
          onTogglePanel={onTogglePanel}
          playerShipCount={playerShips.length}
          settlementCount={gameState.settlements.filter(s => s.ownedBy === 'player').length}
          researchTotal={(() => {
            const lvls = gameState.factionTech?.player?.levels || {};
            return Object.values(lvls).reduce((s, n) => s + (n ?? 0), 0);
          })()}
          canSaveLoad={canSaveLoad}
          onOpenSave={() => { setSaveLoadMode('save'); setMenuOpen(false); }}
          onOpenLoad={() => { setSaveLoadMode('load'); setMenuOpen(false); }}
          onOpenAdminGrant={() => { setAdminGrantOpen(true); setMenuOpen(false); }}
        />
      )}

      {saveLoadMode && (
        <SaveLoadModal
          mode={saveLoadMode}
          onClose={() => setSaveLoadMode(null)}
          currentState={saveLoadMode === 'save' ? gameState : undefined}
          onLoad={(state) => {
            // Close before handing the state back — onLoadSave triggers
            // a full GameContextProvider remount and we don't want a
            // dangling modal on the freshly-loaded session.
            setSaveLoadMode(null);
            onLoadSave?.(state);
          }}
        />
      )}

      {adminGrantOpen && (
        <AdminGrantModal
          onClose={() => setAdminGrantOpen(false)}
          mpGameId={adminGameId}
        />
      )}

      {playerResources && (
        <div className="top-bar__resources" data-tutorial-id="topbar-resources">
          <ResourcePill
            label="FUEL" modifier="fuel"
            value={playerResources.fuel}
            rate={income.delivered.fuel}
            stranded={income.stranded.fuel}
            hasCollector={income.hasCollector}
          />
          <ResourcePill
            label="ORE" modifier="ore"
            value={playerResources.ore}
            rate={income.delivered.ore}
            stranded={income.stranded.ore}
            hasCollector={income.hasCollector}
          />
          <ResourcePill
            label="CR" modifier="credits"
            value={playerResources.credits}
            rate={income.delivered.credits}
            stranded={income.stranded.credits}
            hasCollector={income.hasCollector}
          />
          <ResourcePill
            label="SCI" modifier="science"
            value={playerResources.science}
            rate={income.delivered.science}
            stranded={income.stranded.science}
            hasCollector={income.hasCollector}
          />
          <div className="resource-pill resource-pill--ships">
            <div className="resource-pill__label">SHIPS</div>
            <div className="resource-pill__value">{playerShips.length}</div>
          </div>
        </div>
      )}

      <div className="top-bar__nav">
        <button
          className={`nav-button ${activePanel === 'settlements' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'settlements' ? null : 'settlements')}
          title="Settlements"
          aria-label="Settlements"
          data-tutorial-id="nav-settlements"
        >
          <span className="nav-button__icon" aria-hidden>⌂</span>
          <span className="nav-button__label">Settlements</span>
          <span className="badge">{gameState.settlements.filter(s => s.ownedBy === 'player').length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'fleet' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'fleet' ? null : 'fleet')}
          title="Fleet"
          aria-label="Fleet"
          data-tutorial-id="nav-fleet"
        >
          <span className="nav-button__icon" aria-hidden>◈</span>
          <span className="nav-button__label">Fleet</span>
          <span className="badge">{playerShips.length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'research' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'research' ? null : 'research')}
          title="Research tech tree"
          aria-label="Research"
          data-tutorial-id="nav-research"
        >
          <span className="nav-button__icon" aria-hidden>⚛</span>
          <span className="nav-button__label">Research</span>
          {(() => {
            const lvls = gameState.factionTech?.player?.levels || {};
            const total = Object.values(lvls).reduce((s, n) => s + (n ?? 0), 0);
            return total > 0 ? <span className="badge">{total}</span> : null;
          })()}
        </button>
      </div>

      <div className="top-bar__time">
        <div className="time-display">
          <div className="time-display__label">TICK</div>
          <div className="time-display__value">{tickStr}</div>
        </div>
        {!hideSimControls && !turnBasedActive && !mpTbmActive && (
          // Realtime sim controls. Hidden in Turn-Based Mode (replaced
          // below by the single COMMIT TURN button) and in multiplayer
          // when the server says TBM is on.
          <div className="sim-controls" data-tutorial-id="sim-controls">
            <button
              className={`sim-btn ${simSpeed === 0 ? 'active' : ''}`}
              onClick={() => setSimSpeed(0)}
              title="Pause"
            >⏸</button>
            {SIM_SPEEDS.map(s => (
              <button
                key={s}
                className={`sim-btn ${simSpeed === s ? 'active' : ''}`}
                onClick={() => setSimSpeed(s)}
                title={`${s}× speed`}
              >{s}×</button>
            ))}
            <button className="sim-btn" onClick={() => handleSkip(10)} title="Skip +10 ticks">+10</button>
            <button className="sim-btn" onClick={() => handleSkip(100)} title="Skip +100 ticks">+100</button>
            <button className="sim-btn" onClick={() => handleSkip(1000)} title="Skip +1000 ticks">+1K</button>
          </div>
        )}
        {!hideSimControls && turnBasedActive && !mpTbmActive && (
          // SP Turn-Based Mode: realtime sim is suppressed. COMMIT TURN
          // jumps the sim by ticksPerTurn. The button carries an inline
          // budget summary (planned transfer fuel + items count) so the
          // player knows roughly what's about to fire.
          <CommitTurnButton onCommit={commitTurn} />
        )}
        {mpTbmActive && (
          // MP Turn-Based Mode. Source of truth is the server's
          // /turn/status poll. COMMIT TURN posts our vote; the sim
          // doesn't advance until every faction has voted.
          <MpCommitTurnButton
            status={mpTurnStatus!}
            onCommit={async () => {
              if (!mpActions) return;
              const res = await mpActions.commitTurn();
              await refreshTurnStatus();
              if (res.advanced) {
                // Server already advanced — the next /state poll picks
                // up the new tick. Could also force a /state refresh
                // here, but the existing 1.5s poll cadence is enough.
              }
            }}
          />
        )}
      </div>

      <div className="top-bar__alerts">
        {alerts.slice(0, 4).map(alert => (
          <div
            key={alert.id}
            className={`alert-chip alert-chip--${alert.level}`}
            onClick={() => alert.onClick?.()}
          >
            <span>{alert.text}</span>
            <button
              className="alert-chip__dismiss"
              onClick={(e) => { e.stopPropagation(); dismissAlert(alert.id); }}
              title="Dismiss"
            >×</button>
          </div>
        ))}
        {gameState.combatLog.length > 0 && (
          <button
            className="top-bar__log-toggle"
            onClick={() => setLogOpen(true)}
            title="Open full event log"
          >
            ☰ Log ({gameState.combatLog.length})
          </button>
        )}
      </div>

      {logOpen && (
        <EventLogPanel
          entries={gameState.combatLog}
          onClose={() => setLogOpen(false)}
        />
      )}
    </div>
  );
};

// Full chronicle history. The top-bar ticker only shows the last 2-4
// entries to stay compact; this drawer surfaces the full server-pushed
// combatLog (gameState.combatLog) in chronological order.
const EventLogPanel: React.FC<{
  entries: string[];
  onClose: () => void;
}> = ({ entries, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portal to <body> so this overlay isn't trapped by .top-bar's
  // backdrop-filter (which promotes the top-bar to a containing block
  // for position:fixed descendants and breaks the right-edge anchor).
  return createPortal(
    <>
      <div className="event-log__backdrop" onClick={onClose} />
      <aside className="event-log">
        <header className="event-log__head">
          <div className="event-log__title">EVENT LOG</div>
          <button className="event-log__close" onClick={onClose} title="Close (Esc)">×</button>
        </header>
        <div className="event-log__body">
          {entries.length === 0 ? (
            <div className="event-log__empty">No events yet. Combat results and game milestones will appear here.</div>
          ) : (
            entries.map((entry, i) => (
              <div key={i} className="event-log__row">{entry}</div>
            ))
          )}
        </div>
        <footer className="event-log__foot">
          {entries.length} entries · Press <kbd>Esc</kbd> to close
        </footer>
      </aside>
    </>,
    document.body,
  );
};

// ----------------------------------------------------------------
// Resource pill with per-tick income subtext.
//
// Two rate states:
//   - delivered (green +X/t): settlement yield that's actually reaching
//     the pool via your collector network
//   - stranded (red ~X/t):    yield piling up at settlements because
//     the empire has no collector to receive it. The capital starts
//     with one; lose it and the trickle goes red until you rebuild.
// ----------------------------------------------------------------

const fmtRate = (n: number) => {
  if (n === 0) return '0';
  if (n < 0.1) return n.toFixed(2);
  if (n < 10)  return n.toFixed(1);
  return Math.round(n).toString();
};

const ResourcePill: React.FC<{
  label: string;
  modifier: string;          // → css className suffix (fuel/ore/credits/science)
  value: number;             // current pool
  rate: number;              // per-tick income arriving in the pool (delivered)
  stranded: number;          // per-tick income stuck in stockpiles (no collector)
  hasCollector: boolean;     // does the empire have any collector at all
}> = ({ label, modifier, value, rate, stranded, hasCollector }) => {
  const hasRate = rate > 0.01;
  const isStranded = stranded > 0.01 && !hasCollector;
  let tooltip: string;
  if (isStranded) {
    tooltip = `${label}: ${Math.round(value)} (pool). ${fmtRate(stranded)}/t piling up at settlements — build a collector to receive it.`;
  } else if (hasRate) {
    tooltip = `${label}: ${Math.round(value)} (pool) — gaining +${fmtRate(rate)} per tick via your collector network.`;
  } else {
    tooltip = `${label}: ${Math.round(value)} (pool)`;
  }
  return (
    <div className={`resource-pill resource-pill--${modifier}`} title={tooltip}>
      <div className="resource-pill__label">{label}</div>
      <div className="resource-pill__value">{Math.round(value)}</div>
      {hasRate && (
        <div
          className="resource-pill__rate"
          style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', marginTop: 2, color: '#7fffa1',
          }}
        >+{fmtRate(rate)}/t</div>
      )}
      {isStranded && (
        // Red trickle indicator: yield is being produced but has
        // nowhere to land. ~X/t (with tilde) reads differently from
        // +X/t so the player can clock the difference at a glance.
        <div
          className="resource-pill__rate"
          style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', marginTop: 2, color: '#ff5e5e',
          }}
          aria-label="stranded — build a collector"
        >~{fmtRate(stranded)}/t</div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------
// Turn-Based Mode COMMIT TURN button + budget popover.
//
// The bare button shows the planned-spend headline (e.g. "3 orders,
// -36 fuel"). Hover/tap opens a popover with the full breakdown:
// every planned transfer, build-in-flight, and research progress.
// Visual is amber by default, red when planned fuel exceeds the pool
// (still allowed — the per-tick economy might catch up before each
// burn fires).
// ----------------------------------------------------------------

const CommitTurnButton: React.FC<{ onCommit: () => void }> = ({ onCommit }) => {
  const { gameState } = useGameContext();
  const { ticksPerTurn } = useTurnBasedSettings();
  const [popoverOpen, setPopoverOpen] = useState(false);

  const budget = useMemo(
    () => computeTurnBudget(gameState, 'player', ticksPerTurn),
    [gameState, ticksPerTurn],
  );

  const headline = (() => {
    const parts: string[] = [];
    const ordersN = budget.plannedItems.length;
    if (ordersN > 0) parts.push(`${ordersN} order${ordersN === 1 ? '' : 's'}`);
    if (budget.plannedSpend.fuel > 0) parts.push(`-${budget.plannedSpend.fuel} fuel`);
    const buildsLanding = budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length;
    if (buildsLanding > 0) parts.push(`+${buildsLanding} ship${buildsLanding === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(' · ') : 'no orders queued';
  })();

  const overspending = budget.overspend.fuel;
  const color = overspending ? '#ff5e5e' : '#ffb84d';

  return (
    <div
      style={{ position: 'relative', marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onMouseEnter={() => setPopoverOpen(true)}
      onMouseLeave={() => setPopoverOpen(false)}
    >
      <button
        className="sim-btn sim-btn--commit-turn"
        onClick={onCommit}
        title="Advance the simulation by one turn"
        style={{
          background: color,
          color: '#0a1018',
          fontWeight: 700,
          letterSpacing: '0.12em',
          padding: '6px 14px',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          lineHeight: 1.15,
        }}
      >
        <span style={{ fontSize: 11 }}>▶ COMMIT TURN</span>
        <span style={{ fontSize: 9, opacity: 0.75, letterSpacing: '0.04em' }}>{headline}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setPopoverOpen(p => !p); }}
        title="Show turn budget"
        aria-label="Show turn budget"
        style={{
          width: 22, height: 22, borderRadius: 3,
          border: `1px solid ${color}`, background: 'transparent', color,
          fontSize: 11, cursor: 'pointer', padding: 0,
        }}
      >ⓘ</button>

      {popoverOpen && (
        <div
          role="dialog"
          aria-label="Turn budget"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 280,
            maxWidth: 360,
            zIndex: 1120,
            background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
            border: `1px solid ${color}`,
            borderRadius: 6,
            padding: '10px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            color: '#d8e4ee',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.6)',
          }}
        >
          <div style={{ fontSize: 10, color, letterSpacing: '0.12em', marginBottom: 6 }}>
            NEXT TURN · +{ticksPerTurn} ticks
          </div>

          <BudgetRow label="Planned transfers" count={budget.plannedItems.length} delta={`-${budget.plannedSpend.fuel} fuel`} warn={overspending} />
          {budget.plannedItems.slice(0, 4).map((it, i) => (
            <div key={i} style={{ fontSize: 10, color: '#b8c8d6', paddingLeft: 8 }}>
              · {it.label}{it.detail ? ` — ${it.detail}` : ''}
            </div>
          ))}
          {budget.plannedItems.length > 4 && (
            <div style={{ fontSize: 10, color: '#b8c8d6', paddingLeft: 8 }}>
              · +{budget.plannedItems.length - 4} more
            </div>
          )}

          <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />

          <BudgetRow
            label="Builds in flight"
            count={budget.buildItems.length}
            delta={
              budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length > 0
                ? `${budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length} land this turn`
                : ''
            }
          />
          {budget.buildItems.slice(0, 3).map((it, i) => (
            <div
              key={i}
              style={{
                fontSize: 10,
                color: it.detail === 'LANDS THIS TURN' ? '#7fffa1' : '#b8c8d6',
                paddingLeft: 8,
              }}
            >
              · {it.label} — {it.detail}
            </div>
          ))}

          {budget.research && budget.research.techId && (
            <>
              <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />
              <BudgetRow
                label="Research"
                count={1}
                delta={`${budget.research.progressPct.toFixed(0)}% · ${budget.research.techId}`}
              />
            </>
          )}

          <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />

          <div style={{ fontSize: 10, color: '#b8c8d6' }}>
            POOL: {Math.round(budget.pool.fuel)} fuel · {Math.round(budget.pool.ore)} ore · {Math.round(budget.pool.credits)} cr
          </div>
          {overspending && (
            <div style={{ fontSize: 10, color: '#ff5e5e', marginTop: 4 }}>
              ⚠ Planned fuel ({budget.plannedSpend.fuel}) exceeds pool ({Math.round(budget.pool.fuel)}).
              Some burns may abort mid-turn.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------
// MP COMMIT TURN button — variant for server-driven turn batches.
//
// Differences from the SP button:
//  * Reads readiness from the /turn/status poll (mpTurnStatus prop)
//    rather than from a local TBM context.
//  * Once the caller has voted (me_committed=true), the button locks
//    and shows "WAITING ON N FACTION(S)". When the server advances,
//    the next poll resets me_committed and the button re-enables.
//  * No SP budget popover — MP budget would need cross-faction data
//    we don't have. Future: surface own-faction budget here too.
// ----------------------------------------------------------------

const MpCommitTurnButton: React.FC<{
  status: import('../multiplayer/MultiplayerActionsContext').TurnStatus;
  onCommit: () => Promise<void>;
}> = ({ status, onCommit }) => {
  const [busy, setBusy] = useState(false);
  const locked = status.me_committed || busy;
  const waitingOn = status.needed - status.ready;

  const handleClick = async () => {
    if (locked) return;
    setBusy(true);
    try { await onCommit(); } finally { setBusy(false); }
  };

  const label = locked
    ? (waitingOn > 0 ? `⏳ WAITING ON ${waitingOn}` : '⏳ ADVANCING…')
    : '▶ COMMIT TURN';
  const color = locked ? '#5a7080' : '#ffb84d';

  return (
    <div style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={handleClick}
        disabled={locked}
        title={`Turn ${status.turn_number} · ${status.ready}/${status.needed} ready · +${status.ticks_per_turn} ticks on commit`}
        style={{
          background: color, color: '#0a1018',
          fontWeight: 700, letterSpacing: '0.12em',
          padding: '6px 14px', border: 'none', borderRadius: 4,
          cursor: locked ? 'default' : 'pointer',
          display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start',
          lineHeight: 1.15, opacity: locked ? 0.7 : 1,
        }}
      >
        <span style={{ fontSize: 11 }}>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.75, letterSpacing: '0.04em' }}>
          turn {status.turn_number} · {status.ready}/{status.needed}
        </span>
      </button>
    </div>
  );
};

// MP-only host control for enabling Turn-Based Mode on the active
// game. Lives in the SideMenu HOST ADMIN section so non-hosts can't
// see or change it. Reads current state from /turn/status and writes
// via POST /turn/settings. Editing ticks_per_turn uses the same
// pill-stepper pattern as the existing tick-interval admin.
const MpTbmHostToggle: React.FC = () => {
  const mp = useMultiplayerActions();
  const { status, refresh } = useMpTurnStatus();
  const [busy, setBusy] = useState(false);
  // Surface server-side rejections (not_host, bad_request) inline so
  // a non-host clicking the toggle sees why nothing happened. Without
  // this the pill just flickered busy → idle with status unchanged.
  const [tbmError, setTbmError] = useState<string | null>(null);

  if (!mp || !status) return null;

  const setTBM = async (enabled: boolean, ticks: number) => {
    setBusy(true);
    setTbmError(null);
    try {
      const res = await mp.setTurnSettings(enabled, ticks);
      if (!res.ok) {
        setTbmError(humanizeMpError(res.code, res.error, 'tbm'));
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const ticksOptions = [10, 20, 50, 100];

  return (
    <div className="side-menu__item side-menu__item--block">
      <span className="side-menu__item-icon">⏯</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <span className="side-menu__item-label" style={{ marginBottom: 2 }}>
          Turn-Based Mode {status.turn_based_enabled ? 'ON' : 'OFF'}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="side-menu__pill"
            onClick={() => setTBM(!status.turn_based_enabled, status.ticks_per_turn)}
            disabled={busy}
          >
            {status.turn_based_enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
        {status.turn_based_enabled && (
          <>
            <span className="side-menu__item-hint">Ticks per turn</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {ticksOptions.map(t => (
                <button
                  key={t}
                  className="side-menu__pill"
                  onClick={() => setTBM(true, t)}
                  disabled={busy}
                  style={t === status.ticks_per_turn ? { borderColor: '#ffb84d', color: '#ffb84d' } : undefined}
                >
                  +{t}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="side-menu__item-hint" style={{ marginTop: 2 }}>
          {status.turn_based_enabled
            ? `Wall-clock paused. ${status.ready}/${status.needed} committed for turn ${status.turn_number}.`
            : 'Server alarm advances ticks on schedule.'}
        </span>
        {tbmError && (
          // Server rejected the toggle (almost always not_host on a
          // joined-mid-game client). Click to dismiss.
          <button
            onClick={() => setTbmError(null)}
            style={{
              marginTop: 4, padding: '4px 8px',
              background: 'rgba(255, 94, 94, 0.1)',
              border: '1px solid #ff5e5e', borderRadius: 4,
              color: '#ff5e5e', fontSize: 10, lineHeight: 1.3,
              fontFamily: 'inherit', textAlign: 'left',
              cursor: 'pointer', width: '100%',
            }}
            title="Click to dismiss"
          >⚠ {tbmError}</button>
        )}
      </div>
    </div>
  );
};

const BudgetRow: React.FC<{ label: string; count: number; delta?: string; warn?: boolean }> = ({
  label, count, delta, warn,
}) => (
  <div
    style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: 11, padding: '2px 0',
    }}
  >
    <span>
      <span style={{ color: '#d8e4ee' }}>{label}</span>
      <span style={{ color: '#b8c8d6', marginLeft: 6 }}>×{count}</span>
    </span>
    {delta && (
      <span style={{ color: warn ? '#ff5e5e' : '#ffb84d', fontWeight: 600 }}>{delta}</span>
    )}
  </div>
);

// ----------------------------------------------------------------
// Side drawer: slides in from the left when the logo is clicked.
// Houses navigation actions (Back to Menu, Sign Out) and identity
// so the in-game top bar stays focused on resources + sim controls.
// ----------------------------------------------------------------

interface SideMenuProps {
  onClose: () => void;
  onExitMode?: () => void;
  user: { display_name: string; email: string } | null;
  onSignOut: () => Promise<void> | void;
  /** When set + isHost, the menu shows admin controls (force tick, etc.). */
  adminGameId?: string | null;
  isHost?: boolean;
  /** Panel state + toggle — drives the mobile-only Panels group below. */
  activePanel?: PanelId;
  onTogglePanel?: (panel: PanelId) => void;
  playerShipCount?: number;
  settlementCount?: number;
  researchTotal?: number;
  /** SP-only: show Save / Load entries in the GAME section. */
  canSaveLoad?: boolean;
  onOpenSave?: () => void;
  onOpenLoad?: () => void;
  /** Open the admin resource-grant modal. SP-always; MP-host-only
   *  (server enforces). Wired from TopBar. */
  onOpenAdminGrant?: () => void;
}

const SideMenu: React.FC<SideMenuProps> = ({
  onClose, onExitMode, user, onSignOut,
  adminGameId = null, isHost = false,
  activePanel, onTogglePanel,
  playerShipCount = 0, settlementCount = 0, researchTotal = 0,
  canSaveLoad = false, onOpenSave, onOpenLoad, onOpenAdminGrant,
}) => {
  const [forceTickBusy, setForceTickBusy] = useState(false);
  const [forceTickStatus, setForceTickStatus] = useState<string | null>(null);
  const [intervalBusy, setIntervalBusy] = useState(false);
  const [intervalStatus, setIntervalStatus] = useState<string | null>(null);
  // Turn-Based Mode toggle (live setting, persisted to localStorage).
  // Hidden in multiplayer — the server is authoritative there and TBM
  // would need server-side turn collection to work, which isn't built.
  const tbm = useTurnBasedSettings();
  const tbmAvailable = !adminGameId; // adminGameId is MP-only; SP leaves it null
  // Tutorial — replay entry under GAME. The first-game prompt has its
  // own modal; this menu item is the "I want to see it again" path.
  const tutorial = useTutorial();

  // Host can change the tick cadence on an in-flight game. Mirrors
  // worker/lobby.js ALLOWED_TICK_INTERVALS — any value not in this set is
  // rejected by the server.
  const TICK_INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
    { label: '30s',  value:    30_000 },
    { label: '1m',   value:    60_000 },
    { label: '5m',   value:   300_000 },
    { label: '30m',  value: 1_800_000 },
    { label: '1h',   value: 3_600_000 },
    { label: '6h',   value: 21_600_000 },
    { label: '12h',  value: 43_200_000 },
    { label: '24h',  value: 86_400_000 },
  ];

  async function setTickInterval(ms: number, label: string) {
    if (!adminGameId || intervalBusy) return;
    setIntervalBusy(true);
    setIntervalStatus(null);
    try {
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ tick_interval_ms?: number; next_tick_at?: number }>(
        `/api/lobby/rooms/${adminGameId}/tick-interval`,
        {
          method: 'PATCH',
          body: JSON.stringify({ tick_interval_ms: ms }),
        },
      );
      if (!res.ok) {
        setIntervalStatus(res.error?.message ?? `Failed (${res.status})`);
      } else {
        setIntervalStatus(`✓ Now ticking every ${label}`);
      }
    } catch (e) {
      setIntervalStatus(`Network error: ${(e as Error)?.message || 'unknown'}`);
    } finally {
      setIntervalBusy(false);
      setTimeout(() => setIntervalStatus(null), 4000);
    }
  }



  async function forceTick() {
    if (!adminGameId || forceTickBusy) return;
    setForceTickBusy(true);
    setForceTickStatus(null);
    try {
      // Lazy-import apiFetch to avoid polluting TopBar's module graph
      // for single-player builds that don't need multiplayer code paths.
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ current_tick?: number; advanced?: boolean; bodies_added?: number }>(
        `/api/lobby/rooms/${adminGameId}/force-tick`,
        { method: 'POST' },
      );
      if (!res.ok) {
        setForceTickStatus(res.error?.message ?? `Failed (${res.status})`);
      } else {
        const bodiesNote = res.data?.bodies_added && res.data.bodies_added > 0
          ? ` +${res.data.bodies_added} bodies`
          : '';
        if (res.data?.advanced === false) {
          // Worker returned 200 but the tick didn't actually move — usually
          // means the DO bailed (no game / status mismatch). Surface that.
          setForceTickStatus(`No change${bodiesNote}`);
        } else {
          setForceTickStatus(`✓ Tick → T+${res.data?.current_tick ?? '?'}${bodiesNote}`);
        }
      }
    } catch (e) {
      setForceTickStatus(`Network error: ${(e as Error)?.message || 'unknown'}`);
    } finally {
      setForceTickBusy(false);
      setTimeout(() => setForceTickStatus(null), 4000);
    }
  }

  // Portal to <body> for the same reason as EventLogPanel: .top-bar's
  // backdrop-filter would otherwise trap our fixed-positioned drawer.
  return createPortal(
    <>
      <div className="side-menu__backdrop" onClick={onClose} />
      <aside className="side-menu" role="dialog" aria-label="Menu">
        <header className="side-menu__head">
          <div>
            <div className="side-menu__brand">ORBITAL</div>
            <div className="side-menu__brand-sub">v0.3 alpha</div>
          </div>
          <button className="side-menu__close" onClick={onClose} title="Close (Esc)">×</button>
        </header>

        <section className="side-menu__identity">
          <div className="side-menu__identity-label">SIGNED IN AS</div>
          <div className="side-menu__identity-name">
            {user ? (user.display_name || user.email) : 'Guest'}
          </div>
          {user && <div className="side-menu__identity-sub">{user.email}</div>}
        </section>

        <nav className="side-menu__nav">
          {onTogglePanel && (
            <div className="side-menu__panels-mobile">
              <div className="side-menu__group-label">PANELS</div>
              <button
                className={`side-menu__item${activePanel === 'settlements' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'settlements' ? null : 'settlements'); }}
              >
                <span className="side-menu__item-icon">⌂</span>
                <span className="side-menu__item-label">Settlements</span>
                <span className="side-menu__item-hint">{settlementCount}</span>
              </button>
              <button
                className={`side-menu__item${activePanel === 'fleet' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'fleet' ? null : 'fleet'); }}
              >
                <span className="side-menu__item-icon">◈</span>
                <span className="side-menu__item-label">Fleet</span>
                <span className="side-menu__item-hint">{playerShipCount}</span>
              </button>
              <button
                className={`side-menu__item${activePanel === 'research' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'research' ? null : 'research'); }}
              >
                <span className="side-menu__item-icon">⚛</span>
                <span className="side-menu__item-label">Research</span>
                <span className="side-menu__item-hint">{researchTotal || 'lvl 0'}</span>
              </button>
            </div>
          )}

          <div className="side-menu__group-label">GAME</div>
          {canSaveLoad && onOpenSave && (
            <button
              className="side-menu__item"
              onClick={onOpenSave}
              title="Save the current campaign to your browser"
            >
              <span className="side-menu__item-icon">⤓</span>
              <span className="side-menu__item-label">Save Game</span>
              <span className="side-menu__item-hint">localStorage</span>
            </button>
          )}
          {canSaveLoad && onOpenLoad && (
            <button
              className="side-menu__item"
              onClick={onOpenLoad}
              title="Load a previously saved campaign (replaces this one)"
            >
              <span className="side-menu__item-icon">⤒</span>
              <span className="side-menu__item-label">Load Game</span>
              <span className="side-menu__item-hint">replaces current</span>
            </button>
          )}
          {onExitMode && (
            <button
              className="side-menu__item"
              onClick={() => { onClose(); onExitMode(); }}
            >
              <span className="side-menu__item-icon">←</span>
              <span className="side-menu__item-label">Back to Menu</span>
              <span className="side-menu__item-hint">Exit this session</span>
            </button>
          )}
          <button
            className="side-menu__item"
            onClick={() => {
              // reset() clears the completed flag so the next time a
              // player enters a game the prompt fires again. Calling
              // start() directly also relaunches the tour now without
              // requiring a reload.
              tutorial.reset();
              tutorial.start();
              onClose();
            }}
            title="Replay the guided walkthrough"
          >
            <span className="side-menu__item-icon">?</span>
            <span className="side-menu__item-label">
              {tutorial.completed ? 'Replay Tutorial' : 'Start Tutorial'}
            </span>
            <span className="side-menu__item-hint">{TUTORIAL_STEP_COUNT_HINT}</span>
          </button>

          {tbmAvailable && (
            // SP Turn-Based Mode toggle. Persisted across sessions in
            // localStorage. Hidden in MP — the MP variant lives in HOST
            // ADMIN below (host-only since it changes the whole table's
            // tick rhythm).
            <button
              className="side-menu__item"
              onClick={() => tbm.setEnabled(!tbm.enabled)}
              title={tbm.enabled
                ? `On — realtime suppressed. Click COMMIT TURN to advance ${tbm.ticksPerTurn} ticks.`
                : 'Off — game runs in realtime. Click to switch flows.'}
            >
              <span className="side-menu__item-icon">{tbm.enabled ? '⏯' : '▶'}</span>
              <span className="side-menu__item-label">
                Turn-Based Mode {tbm.enabled ? 'ON' : 'OFF'}
              </span>
              <span
                className="side-menu__item-hint"
                style={{ color: tbm.enabled ? '#ffb84d' : undefined }}
              >
                {tbm.enabled ? `+${tbm.ticksPerTurn} ticks/turn` : 'realtime'}
              </span>
            </button>
          )}

          {!tbmAvailable && isHost && adminGameId && (
            // MP Turn-Based Mode (host-only). Posts /turn/settings, which
            // also short-circuits the Room DO alarm so wall-clock time
            // stops ticking and players have to opt in via COMMIT TURN.
            <MpTbmHostToggle />
          )}

          {isHost && adminGameId && (
            <>
              <div className="side-menu__group-label">HOST ADMIN</div>
              <button
                className="side-menu__item"
                onClick={forceTick}
                disabled={forceTickBusy}
              >
                <span className="side-menu__item-icon">⏭</span>
                <span className="side-menu__item-label">
                  {forceTickStatus ?? (forceTickBusy ? 'Ticking…' : 'Force Tick')}
                </span>
                <span className="side-menu__item-hint">Advance one tick now</span>
              </button>
              <div className="side-menu__item side-menu__item--block">
                <span className="side-menu__item-icon">⏱</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <span className="side-menu__item-label" style={{ marginBottom: 2 }}>
                    {intervalStatus ?? (intervalBusy ? 'Updating…' : 'Tick Speed')}
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {TICK_INTERVAL_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        className="side-menu__pill"
                        onClick={() => setTickInterval(opt.value, opt.label)}
                        disabled={intervalBusy}
                        title={`${opt.label} per tick`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <span className="side-menu__item-hint" style={{ marginTop: 2 }}>
                    Cadence applies on next tick
                  </span>
                </div>
              </div>
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenAdminGrant?.(); }}
              >
                <span className="side-menu__item-icon">$</span>
                <span className="side-menu__item-label">Grant Resources</span>
                <span className="side-menu__item-hint">Bump any faction's pools</span>
              </button>
            </>
          )}

          {/* SP: surface the same admin tools under DEBUG (no MP host gate). */}
          {!adminGameId && onOpenAdminGrant && (
            <>
              <div className="side-menu__group-label">DEBUG</div>
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenAdminGrant?.(); }}
              >
                <span className="side-menu__item-icon">$</span>
                <span className="side-menu__item-label">Grant Resources</span>
                <span className="side-menu__item-hint">Bump any faction's pools</span>
              </button>
            </>
          )}

          <div className="side-menu__group-label">DIAGNOSTICS</div>
          <button
            className="side-menu__item"
            onClick={() => {
              // Don't close the drawer — the user might want to inspect more
              // afterwards, and a download doesn't navigate.
              logger.info('SYSTEM', 'User exported game log');
              logger.downloadText();
            }}
          >
            <span className="side-menu__item-icon">⤓</span>
            <span className="side-menu__item-label">Download Log</span>
            <span className="side-menu__item-hint">{logger.count()} entries</span>
          </button>

          {user && (
            <>
              <div className="side-menu__group-label">ACCOUNT</div>
              <button
                className="side-menu__item side-menu__item--danger"
                onClick={async () => { onClose(); await onSignOut(); }}
              >
                <span className="side-menu__item-icon">⏏</span>
                <span className="side-menu__item-label">Sign Out</span>
                <span className="side-menu__item-hint">End your session</span>
              </button>
            </>
          )}
        </nav>

        <footer className="side-menu__foot">
          <span>Press <kbd>Esc</kbd> to close</span>
        </footer>
      </aside>
    </>,
    document.body,
  );
};
