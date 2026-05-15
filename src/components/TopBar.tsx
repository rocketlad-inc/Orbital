// ============================================================
// TopBar — persistent top strip
// Title | Resources | Nav buttons | Time / Sim controls | Alerts
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useAuth } from '../multiplayer/AuthContext';
import './TopBar.css';

export type PanelId = 'settlements' | 'fleet' | 'research' | null;

interface TopBarProps {
  activePanel: PanelId;
  onTogglePanel: (panel: PanelId) => void;
  onExitMode?: () => void;
}

interface Alert {
  id: string;
  level: 'info' | 'warn' | 'danger';
  text: string;
  onClick?: () => void;
}

const SIM_SPEEDS = [1, 10, 100, 1000, 10000, 100000];

export const TopBar: React.FC<TopBarProps> = ({ activePanel, onTogglePanel, onExitMode }) => {
  const { gameState, simSpeed, setSimSpeed, updateTick, selectShip } = useGameContext();
  const { user, signOut } = useAuth();
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Format tick as T+NNNN (and game days if non-trivial)
  const tickStr = `T+${Math.floor(gameState.currentTick)}`;

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
        >
          Settlements
          <span className="badge">{gameState.settlements.filter(s => s.ownedBy === 'player').length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'fleet' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'fleet' ? null : 'fleet')}
        >
          Fleet
          <span className="badge">{playerShips.length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'research' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'research' ? null : 'research')}
          title="Research tech tree"
        >
          Research
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
      </div>
    </div>
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
}

const SideMenu: React.FC<SideMenuProps> = ({ onClose, onExitMode, user, onSignOut }) => {
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
