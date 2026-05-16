import React, { useEffect, useState } from 'react';
import { GameContextProvider } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { TopBar, PanelId } from './components/TopBar';
import { Outliner } from './components/Outliner';
import { SettlementsPanel } from './components/SettlementsPanel';
import { FleetPanel } from './components/FleetPanel';
import { TechPanel } from './components/TechPanel';
import { ThreatsPanel } from './components/ThreatsPanel';
import { AIActivityFeed } from './components/AIActivityFeed';
import { MobileSimControls } from './components/MobileSimControls';
import { SinglePlayerSetup } from './components/SinglePlayerSetup';
import { VictoryOverlay } from './components/VictoryOverlay';
import { setupSinglePlayer } from './state/singlePlayerSetup';
import type { GameState, SinglePlayerConfig } from './types';
import { prewarmShipIcons } from './render/shipIconCache';
import { COLORS } from './render/colors';
import { AuthProvider, useAuth } from './multiplayer/AuthContext';
import { AuthOverlay } from './multiplayer/AuthOverlay';
import { Landing } from './components/Landing';
import { TunablesPage } from './components/TunablesPage';
import { ModePicker, GameMode } from './ModePicker';
import { MultiplayerShell } from './multiplayer/MultiplayerShell';
import { MultiplayerLobby } from './multiplayer/MultiplayerLobby';
import { MultiplayerGameProvider } from './multiplayer/MultiplayerGameProvider';
import { apiFetch, RoomSummary } from './multiplayer/api';
import { logger } from './game/logger';
import { ErrorBoundary } from './components/ErrorBoundary';
import './multiplayer/multiplayer.css';
import './App.css';
import './styles/mobile.css';

const MODE_STORAGE_KEY = 'orbital.last_mode';

// Kick off icon rasterization at module load so the first map paint has
// them ready (rather than briefly showing fallback dots).
prewarmShipIcons([COLORS.neutral, COLORS.danger]);

/**
 * The in-game UI: canvas, top bar, side panels, etc.
 *
 * Critical: this component does NOT mount its own GameContextProvider —
 * it just reads from whichever provider is already mounted above. That
 * way the same UI works for both single-player (where SinglePlayerView
 * wraps it in a local-scenario provider) and multiplayer (where
 * MultiplayerGameProvider wraps it in a server-state provider). Earlier
 * versions mounted a second provider here, which shadowed the MP one
 * and made the canvas render Scenario 1 (three ships around Earth) on
 * top of the multiplayer game — a confusing playtest blocker.
 */
function GameUI({
  onExit,
  isMultiplayer = false,
  adminGameId,
  isHost,
}: {
  onExit: () => void;
  isMultiplayer?: boolean;
  adminGameId?: string | null;
  isHost?: boolean;
}) {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const [activePanel, setActivePanel] = useState<PanelId>(null);

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (e.key === 'Escape') setActivePanel(null);
      if (e.key === 's' || e.key === 'S') setActivePanel(p => (p === 'settlements' ? null : 'settlements'));
      if (e.key === 'f' || e.key === 'F') setActivePanel(p => (p === 'fleet' ? null : 'fleet'));
      if (e.key === 'r' || e.key === 'R') setActivePanel(p => (p === 'research' ? null : 'research'));
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="app">
      <MapCanvas width={windowSize.width} height={windowSize.height} />

      <TopBar
        activePanel={activePanel}
        onTogglePanel={setActivePanel}
        onExitMode={onExit}
        hideSimControls={isMultiplayer}
        adminGameId={adminGameId ?? null}
        isHost={!!isHost}
      />
      <Outliner />

      {activePanel === 'settlements' && (
        <SettlementsPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'fleet' && (
        <FleetPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'research' && (
        <TechPanel onClose={() => setActivePanel(null)} />
      )}

      <ShipPanel />
      <BodyInspector />
      <ThreatsPanel />
      {!isMultiplayer && <AIActivityFeed />}
      <MobileSimControls hideSimControls={isMultiplayer} />
    </div>
  );
}

/**
 * Single-player entry. State machine:
 *   'setup'   → SinglePlayerSetup screen (configure faction + AI + match)
 *   'playing' → GameUI with the seeded GameState
 *
 * The victory overlay renders on top of GameUI when the match completes;
 * its "New Campaign" button returns the player to 'setup'.
 */
function SinglePlayerView({ onExit }: { onExit: () => void }) {
  const [phase, setPhase] = useState<'setup' | 'playing'>('setup');
  const [seededState, setSeededState] = useState<GameState | null>(null);

  const handleBegin = (config: SinglePlayerConfig) => {
    setSeededState(setupSinglePlayer(config));
    setPhase('playing');
  };

  const handleNewGame = () => {
    setSeededState(null);
    setPhase('setup');
  };

  if (phase === 'setup' || !seededState) {
    return <SinglePlayerSetup onBegin={handleBegin} onCancel={onExit} />;
  }

  return (
    <GameContextProvider initialState={seededState}>
      <GameUI onExit={onExit} />
      <VictoryOverlay onNewGame={handleNewGame} />
    </GameContextProvider>
  );
}

const ROOM_STORAGE_KEY = 'orbital.last_room';

function AppShell() {
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<GameMode | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => {
    return localStorage.getItem(ROOM_STORAGE_KEY);
  });
  // Tracks whether the selected room has actually started a game. While
  // null the player is still in the pre-game lobby and the canvas
  // shouldn't poll /state (it'll 404 until seedGameWorld runs).
  // 'missing' means /api/lobby/rooms/:id 404'd — room itself is gone.
  const [roomGameId, setRoomGameId] = useState<string | null | 'missing'>(null);
  // Host id of the selected room, so the in-game side-menu can render
  // an admin-only Settings section (force tick, etc.).
  const [roomHostId, setRoomHostId] = useState<string | null>(null);
  const [activeRooms, setActiveRooms] = useState<RoomSummary[] | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showTunables, setShowTunables] = useState(false);

  // When the user authenticates, fetch any rooms they're already a member of
  // so the mode picker can offer a "resume" shortcut.
  useEffect(() => {
    if (!user) {
      setActiveRooms(null);
      return;
    }
    logger.setSession({ playerName: user.display_name || user.email });
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/users/me/rooms');
      if (cancelled) return;
      if (res.ok) {
        setActiveRooms(res.data.rooms);
        // If the user has a single active game already underway, jump them
        // straight back in — this is the "default to active game" behavior.
        const inProgress = res.data.rooms.filter(r => r.game_status === 'active');
        if (inProgress.length === 1 && mode === null) {
          setMode('multiplayer');
          return;
        }
      } else {
        setActiveRooms([]);
      }

      // No active in-progress game — restore the user's last picked mode so
      // they don't see the picker every load.
      if (mode === null) {
        const remembered = localStorage.getItem(MODE_STORAGE_KEY);
        if (remembered === 'singleplayer' || remembered === 'multiplayer') {
          setMode(remembered);
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handlePickMode = (m: GameMode) => {
    setMode(m);
    localStorage.setItem(MODE_STORAGE_KEY, m);
    logger.setSession({ mode: m });
    logger.info('SYSTEM', `Mode selected: ${m}`);
  };

  const handleExitMode = () => {
    logger.info('SYSTEM', 'Exiting mode → mode picker');
    logger.setSession({ mode: 'unknown', roomId: null, gameId: null });
    setMode(null);
    setGuestMode(false);
    setSelectedRoomId(null);
    localStorage.removeItem(MODE_STORAGE_KEY);
    localStorage.removeItem(ROOM_STORAGE_KEY);
  };

  const handleExitRoom = () => {
    setSelectedRoomId(null);
    localStorage.removeItem(ROOM_STORAGE_KEY);
  };

  const handleEnterRoom = (roomId: string) => {
    setSelectedRoomId(roomId);
    logger.setSession({ roomId });
    logger.info('SYSTEM', `Entered room`, { roomId });
    setRoomGameId(null);
    localStorage.setItem(ROOM_STORAGE_KEY, roomId);
  };

  // Invite-link fast path: if the URL has ?invite=XXXX and the user is
  // already logged in, redeem the code straight to a room and skip the
  // lobby "enter code" screen entirely. We strip the param after the
  // attempt so a page refresh doesn't keep trying. If the join needs a
  // password or fails for any other reason, we fall through to the
  // normal lobby — its JoinByCode block still reads the param via
  // window.location.search (or by initial state), so the user lands on
  // a pre-filled form rather than an error.
  const inviteRedeemedRef = React.useRef(false);
  useEffect(() => {
    if (inviteRedeemedRef.current) return;
    if (!user) return; // wait for auth — guests don't have a multiplayer session
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (!invite) return;
    const clean = invite.replace(/[^A-Z2-9]/gi, '').toUpperCase();
    if (clean.length !== 8) return;

    inviteRedeemedRef.current = true;
    (async () => {
      const res = await apiFetch<{ ok: true; room_id: string }>('/api/rooms/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ code: clean }),
      });
      if (res.ok) {
        // Strip the invite param so refreshes / shares don't re-redeem.
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url.toString());

        setMode('multiplayer');
        localStorage.setItem(MODE_STORAGE_KEY, 'multiplayer');
        setSelectedRoomId(res.data.room_id);
        setRoomGameId(null);
        localStorage.setItem(ROOM_STORAGE_KEY, res.data.room_id);
        return;
      }
      // Password-protected or otherwise needs interactive input — drop
      // the user on the multiplayer lobby with the code still in the
      // URL so JoinByCode pre-fills the form. Don't strip the param.
      if (res.error?.code === 'password_required' || res.error?.code === 'bad_password') {
        setMode('multiplayer');
        localStorage.setItem(MODE_STORAGE_KEY, 'multiplayer');
        return;
      }
      // Other errors (invalid / expired code, room full, etc.): clear
      // the param and let the user see the lobby normally.
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.toString());
    })();
  }, [user]);

  // Watch the selected room for game start. While roomGameId is null the
  // lobby + dock are shown but the game canvas / MultiplayerGameProvider
  // stays unmounted (there's no /state to poll yet). Once the host starts
  // the match, /api/lobby/rooms/:id starts returning game_id and we mount
  // the game provider. If the room itself disappears we route the user
  // back to the lobby and clear the stored id.
  useEffect(() => {
    if (!selectedRoomId || !user) return;
    let cancelled = false;
    const poll = async () => {
      const res = await apiFetch<{
        game_id?: string | null;
        settings?: { game_id?: string | null; host_id?: string | null };
      }>(`/api/lobby/rooms/${selectedRoomId}`);
      if (cancelled) return;
      if (res.ok) {
        const gid = (res.data.settings?.game_id ?? res.data.game_id) || null;
        setRoomGameId(gid);
        setRoomHostId(res.data.settings?.host_id ?? null);
      } else if (res.status === 404) {
        setRoomGameId('missing');
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [selectedRoomId, user]);

  // If the room itself is gone, clear it and route back to the lobby.
  useEffect(() => {
    if (roomGameId === 'missing') {
      handleExitRoom();
      setRoomGameId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomGameId]);

  const handleGuest = () => {
    setGuestMode(true);
    setMode('singleplayer');
    localStorage.setItem(MODE_STORAGE_KEY, 'singleplayer');
  };

  if (loading) {
    return (
      <div className="mp-overlay">
        <div className="mp-card">Loading…</div>
      </div>
    );
  }

  // Unauthenticated, not yet in guest mode: show landing first, then auth overlay.
  // The auth overlay still offers a "continue as guest" path.
  // The Tunables sandbox is reachable from the landing nav and bypasses auth.
  if (!user && !guestMode) {
    if (showTunables) {
      return <TunablesPage onBack={() => setShowTunables(false)} />;
    }
    if (!showAuth) {
      return (
        <Landing
          onSignIn={() => setShowAuth(true)}
          onShowTunables={() => setShowTunables(true)}
        />
      );
    }
    return <AuthOverlay onGuest={handleGuest} />;
  }

  if (guestMode) {
    return <SinglePlayerView onExit={handleExitMode} />;
  }

  if (mode === null) {
    return (
      <ModePicker
        activeRooms={activeRooms ?? []}
        onPick={handlePickMode}
      />
    );
  }

  if (mode === 'singleplayer') {
    return <SinglePlayerView onExit={handleExitMode} />;
  }

  // multiplayer — lobby first, then in-room shell
  if (!selectedRoomId) {
    return (
      <MultiplayerLobby
        onEnterRoom={handleEnterRoom}
        onExit={handleExitMode}
      />
    );
  }

  // Pre-game (host still configuring / players still readying up): show
  // just the dock + lobby tab; no game canvas yet because no /state row
  // exists on the server. Once roomGameId is a real id, swap in the
  // game provider which feeds the canvas.
  const gameStarted = typeof roomGameId === 'string' && roomGameId.length > 0;
  return (
    <MultiplayerShell onExit={handleExitRoom} initialRoomId={selectedRoomId}>
      {gameStarted ? (
        <MultiplayerGameProvider gameId={roomGameId as string} onGameMissing={handleExitRoom}>
          {/* MultiplayerGameProvider already mounts its own GameContextProvider
              fed by server state. Render GameUI directly — wrapping it in
              SinglePlayerView would mount a second (local-scenario) context
              that shadows the MP one and renders Scenario 1 on top. */}
          <GameUI
            onExit={handleExitMode}
            isMultiplayer
            adminGameId={roomGameId as string}
            isHost={!!user && roomHostId === user.id}
          />
        </MultiplayerGameProvider>
      ) : (
        // Pre-game backdrop. NOT using .mp-overlay because that class
        // applies a backdrop-filter blur to everything beneath it,
        // including the dock the user needs to reach. Just a flat
        // dark canvas with a small banner that doesn't intercept clicks.
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#050810',
          zIndex: 0,
          pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute',
            top: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            color: 'var(--mp-fg-dim)',
            fontFamily: 'var(--mp-mono)',
            fontSize: 11,
            letterSpacing: '0.18em',
            textAlign: 'center',
            opacity: 0.75,
          }}>
            <div style={{ color: 'var(--mp-accent)', fontSize: 13, marginBottom: 4 }}>
              ◉ PRE-GAME LOBBY
            </div>
            Use the dock on the right to configure the match.
          </div>
        </div>
      )}
    </MultiplayerShell>
  );
}

export function App() {
  return (
    <ErrorBoundary scope="App">
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
