import React, { useState } from 'react';
import { useAuth } from './AuthContext';
import { LobbyView } from './LobbyView';
import { FactionPanel } from './FactionPanel';
import { CommsPanel } from './CommsPanel';
import { SenatePanel } from './SenatePanel';

// Multiplayer overlay UI mounted alongside the existing single-player React
// app. The dock exposes a right-side panel with Lobby / Faction / Comms /
// Senate tabs. The dock is collapsible so it doesn't obscure the game canvas.
//
// IMPORTANT: this does not yet sync the actual game-state (ships, bodies,
// maneuvers) between the server and main's GameContext. Multiplayer here
// means: accounts, rooms, faction identity, messaging, and senate. The
// game canvas still runs against mockGameState. Wiring server-driven game
// state is a follow-up integration task.

type Tab = 'lobby' | 'faction' | 'comms' | 'senate';

interface MultiplayerShellProps {
  children: React.ReactNode;
  onExit?: () => void;
}

export function MultiplayerShell({ children, onExit }: MultiplayerShellProps) {
  const { user, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>('lobby');
  const [gameId, setGameId] = useState<string | null>(null);

  // MultiplayerShell is mounted only when AppShell has already authed the
  // user, so user should always be present here. Guard anyway.
  if (!user) return <>{children}</>;

  return (
    <>
      {children}
      <div className="mp-user-pill">
        {onExit && (
          <button onClick={onExit} title="Back to mode picker">← Menu</button>
        )}
        <span className="who">{user.display_name || user.email}</span>
        <button onClick={signOut}>Sign out</button>
      </div>
      <div className={`mp-dock ${collapsed ? 'collapsed' : ''}`}>
        <div className="mp-dock-head">
          <span>{collapsed ? '▸' : 'MULTIPLAYER'}</span>
          <button onClick={() => setCollapsed((c) => !c)}>{collapsed ? '⤡' : '×'}</button>
        </div>
        {!collapsed && (
          <>
            <div className="mp-tablist">
              <button className={tab === 'lobby' ? 'active' : ''} onClick={() => setTab('lobby')}>Lobby</button>
              <button
                className={tab === 'faction' ? 'active' : ''}
                disabled={!gameId}
                onClick={() => gameId && setTab('faction')}
              >Faction</button>
              <button
                className={tab === 'comms' ? 'active' : ''}
                disabled={!gameId}
                onClick={() => gameId && setTab('comms')}
              >Comms</button>
              <button
                className={tab === 'senate' ? 'active' : ''}
                disabled={!gameId}
                onClick={() => gameId && setTab('senate')}
              >Senate</button>
            </div>
            <div className="mp-dock-body">
              {tab === 'lobby' && (
                <LobbyView
                  onEnterGame={(_, gid) => { setGameId(gid); setTab('faction'); }}
                />
              )}
              {tab === 'faction' && gameId && <FactionPanel gameId={gameId} />}
              {tab === 'comms'   && gameId && <CommsPanel   gameId={gameId} />}
              {tab === 'senate'  && gameId && <SenatePanel  gameId={gameId} />}
            </div>
          </>
        )}
      </div>
    </>
  );
}
