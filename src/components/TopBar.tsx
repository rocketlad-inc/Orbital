// ============================================================
// TopBar — persistent top strip
// Title | Resources | Nav buttons | Time / Sim controls | Alerts
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useAuth } from '../multiplayer/AuthContext';
import { logger } from '../game/logger';
import './TopBar.css';

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
}) => {
  const { gameState, simSpeed, setSimSpeed, updateTick, selectShip } = useGameContext();
  const { user, signOut } = useAuth();
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

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

    // Ships arriving soon (within 5 ticks)
    for (const ship of playerShips) {
      if (ship.transfer) {
        const eta = ship.transfer.arrivalTime - gameState.currentTick;
        if (eta <= 5 && eta > 0) {
          const target = gameState.bodies.find(b => b.id === ship.transfer!.arrivalBodyId);
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
          text: `${ship.name} low fuel (${ship.fuel})`,
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

  // Format tick as "T+NNNN / TOTAL" when we know the match length,
  // otherwise just T+NNNN. Flag endingSoon at 80% so the host has a
  // visible cue before the tick countdown ends the game.
  const cur = Math.floor(gameState.currentTick);
  const total = gameState.totalTickTarget;
  const tickStr = total ? `T+${cur} / ${total}` : `T+${cur}`;
  const endingSoon = total ? cur >= total * 0.8 : false;

  return (
    <div className="top-bar">
      <button
        className="top-bar__title"
        onClick={() => setMenuOpen(true)}
        title="Open menu"
        aria-label="Open menu"
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
        />
      )}

      {playerResources && (
        <div className="top-bar__resources">
          <div className="resource-pill resource-pill--fuel">
            <div className="resource-pill__label">FUEL</div>
            <div className="resource-pill__value">{Math.round(playerResources.fuel)}</div>
          </div>
          <div className="resource-pill resource-pill--ore">
            <div className="resource-pill__label">ORE</div>
            <div className="resource-pill__value">{Math.round(playerResources.ore)}</div>
          </div>
          <div className="resource-pill resource-pill--credits">
            <div className="resource-pill__label">CR</div>
            <div className="resource-pill__value">{Math.round(playerResources.credits)}</div>
          </div>
          <div className="resource-pill resource-pill--science">
            <div className="resource-pill__label">SCI</div>
            <div className="resource-pill__value">{Math.round(playerResources.science)}</div>
          </div>
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
        <div className={`time-display${endingSoon ? ' time-display--ending' : ''}`}>
          <div className="time-display__label">{endingSoon ? 'TICK · ENDING' : 'TICK'}</div>
          <div className="time-display__value">{tickStr}</div>
        </div>
        {!hideSimControls && (
          <div className="sim-controls">
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

  return (
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
    </>
  );
};

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
}

const SideMenu: React.FC<SideMenuProps> = ({
  onClose, onExitMode, user, onSignOut,
  adminGameId = null, isHost = false,
  activePanel, onTogglePanel,
  playerShipCount = 0, settlementCount = 0, researchTotal = 0,
}) => {
  const [forceTickBusy, setForceTickBusy] = useState(false);
  const [forceTickStatus, setForceTickStatus] = useState<string | null>(null);
  const [intervalBusy, setIntervalBusy] = useState(false);
  const [intervalStatus, setIntervalStatus] = useState<string | null>(null);

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

  async function extendMatchLength(delta: number) {
    if (!adminGameId || intervalBusy) return;
    setIntervalBusy(true);
    setIntervalStatus(null);
    try {
      const { apiFetch } = await import('../multiplayer/api');
      // Read the current target locally — server validates the result is
      // > current_tick anyway, so we don't need to round-trip a GET.
      const current = (gameState as any).totalTickTarget ?? 42;
      const newTotal = Math.max(Math.floor(gameState.currentTick) + 1, current + delta);
      const res = await apiFetch<{ total_tick_target?: number }>(
        `/api/lobby/rooms/${adminGameId}/match-length`,
        {
          method: 'PATCH',
          body: JSON.stringify({ total_tick_target: newTotal }),
        },
      );
      if (!res.ok) {
        setIntervalStatus(res.error?.message ?? `Failed (${res.status})`);
      } else {
        setIntervalStatus(`✓ Match length → ${res.data?.total_tick_target ?? newTotal}`);
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

  return (
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
    </>
  );
};
