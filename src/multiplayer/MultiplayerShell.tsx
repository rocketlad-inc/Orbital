import React, { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { LobbyView } from './LobbyView';
import { FactionPanel } from './FactionPanel';
import { CommsPanel } from './CommsPanel';
import { SenatePanel } from './SenatePanel';
import { TradesPanel } from './TradesPanel';
import { tradesApi, apiFetch, RoomSnapshot } from './api';

// Multiplayer overlay UI mounted alongside the existing single-player React
// app. The dock exposes a right-side panel with Lobby / Faction / Comms /
// Senate tabs. The dock is collapsible so it doesn't obscure the game canvas.
//
// IMPORTANT: this does not yet sync the actual game-state (ships, bodies,
// maneuvers) between the server and main's GameContext. Multiplayer here
// means: accounts, rooms, faction identity, messaging, and senate. The
// game canvas still runs against mockGameState. Wiring server-driven game
// state is a follow-up integration task.

type Tab = 'lobby' | 'faction' | 'comms' | 'senate' | 'trades';

interface MultiplayerShellProps {
  children: React.ReactNode;
  onExit?: () => void;
  initialRoomId?: string | null;
}

export function MultiplayerShell({ children, onExit, initialRoomId }: MultiplayerShellProps) {
  const { user, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>('lobby');
  const [gameId, setGameId] = useState<string | null>(null);

  // If the player arrives in a room where a game is already active and the
  // tab is still 'lobby' (which is now hidden), jump them to Faction so
  // they're not staring at a blank dock body.
  useEffect(() => {
    if (gameId && tab === 'lobby') setTab('faction');
  }, [gameId, tab]);

  // Detect game_id by polling the room snapshot ourselves rather than
  // relying on LobbyView mounting — that tab is hidden once a game has
  // started, but a returning player still needs to discover it.
  useEffect(() => {
    if (!initialRoomId || gameId) return;
    let cancelled = false;
    const poll = async () => {
      const res = await apiFetch<RoomSnapshot>(`/api/lobby/rooms/${initialRoomId}`);
      if (cancelled) return;
      if (res.ok && res.data.game_id) {
        setGameId(res.data.game_id);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [initialRoomId, gameId]);
  const [incomingTradeCount, setIncomingTradeCount] = useState(0);

  // Poll for incoming trade count so the Trades tab can show a badge
  // even when the user is on a different tab.
  useEffect(() => {
    if (!gameId) {
      setIncomingTradeCount(0);
      return;
    }
    const api = tradesApi(gameId);
    let cancelled = false;
    const tick = async () => {
      const res = await api.list('open');
      if (cancelled || !res.ok) return;
      // Use any here because we don't have callerFactionId in scope; the
      // server returns it but we just count where status='open' and the
      // caller is the responder. The server scopes the list to caller, so
      // any 'open' entries where proposer !== caller are incoming.
      const callerFactionId = (res.data as any).caller_faction_id;
      setIncomingTradeCount(
        res.data.trades.filter((t) => t.responder_faction_id === callerFactionId).length,
      );
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gameId]);

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
              {/* Lobby only matters while the host is still setting up. Once a
                  game has started the room is frozen; hide the tab so it
                  can't drag the player back into a screen that doesn't apply. */}
              {!gameId && (
                <button className={tab === 'lobby' ? 'active' : ''} onClick={() => setTab('lobby')}>Lobby</button>
              )}
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
              <button
                className={tab === 'trades' ? 'active' : ''}
                disabled={!gameId}
                onClick={() => gameId && setTab('trades')}
                title={incomingTradeCount > 0 ? `${incomingTradeCount} incoming offer${incomingTradeCount > 1 ? 's' : ''}` : 'Trades'}
              >
                Trades{incomingTradeCount > 0 && (
                  <span style={{
                    marginLeft: 4, padding: '0 5px', fontSize: 9,
                    background: '#ffb84d', color: '#0a0e14', borderRadius: 8,
                    fontWeight: 700,
                  }}>{incomingTradeCount}</span>
                )}
              </button>
            </div>
            <div className="mp-dock-body">
              {tab === 'lobby' && (
                <LobbyView
                  initialRoomId={initialRoomId ?? null}
                  onEnterGame={(_, gid) => { setGameId(gid); setTab('faction'); }}
                />
              )}
              {tab === 'faction' && gameId && <FactionPanel gameId={gameId} />}
              {tab === 'comms'   && gameId && <CommsPanel   gameId={gameId} />}
              {tab === 'senate'  && gameId && <SenatePanel  gameId={gameId} />}
              {tab === 'trades'  && gameId && <TradesPanel  gameId={gameId} />}
            </div>
          </>
        )}
      </div>
    </>
  );
}
