import React, { useEffect, useState } from 'react';
import { GameContextProvider } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { ScenarioSelector } from './components/ScenarioSelector';
import { TopBar, PanelId } from './components/TopBar';
import { Outliner } from './components/Outliner';
import { SettlementsPanel } from './components/SettlementsPanel';
import { FleetPanel } from './components/FleetPanel';
import { AuthProvider, useAuth } from './multiplayer/AuthContext';
import { AuthOverlay } from './multiplayer/AuthOverlay';
import { Landing } from './components/Landing';
import { ModePicker, GameMode } from './ModePicker';
import { MultiplayerShell } from './multiplayer/MultiplayerShell';
import { MultiplayerLobby } from './multiplayer/MultiplayerLobby';
import { apiFetch, RoomSummary } from './multiplayer/api';
import './multiplayer/multiplayer.css';
import './App.css';

const MODE_STORAGE_KEY = 'orbital.last_mode';

function SinglePlayerView({ onExit }: { onExit: () => void }) {
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
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <GameContextProvider initialScenario={1}>
      <div className="app">
        <MapCanvas width={windowSize.width} height={windowSize.height} />

        <TopBar activePanel={activePanel} onTogglePanel={setActivePanel} onExitMode={onExit} />
        <Outliner />

        {activePanel === 'settlements' && (
          <SettlementsPanel onClose={() => setActivePanel(null)} />
        )}
        {activePanel === 'fleet' && (
          <FleetPanel onClose={() => setActivePanel(null)} />
        )}

        <ShipPanel />
        <BodyInspector />
        <ScenarioSelector />
      </div>
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
  const [activeRooms, setActiveRooms] = useState<RoomSummary[] | null>(null);
  const [showAuth, setShowAuth] = useState(false);

  // When the user authenticates, fetch any rooms they're already a member of
  // so the mode picker can offer a "resume" shortcut.
  useEffect(() => {
    if (!user) {
      setActiveRooms(null);
      return;
    }
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
  };

  const handleExitMode = () => {
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
    localStorage.setItem(ROOM_STORAGE_KEY, roomId);
  };

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
  if (!user && !guestMode) {
    if (!showAuth) {
      return <Landing onSignIn={() => setShowAuth(true)} />;
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

  return (
    <MultiplayerShell onExit={handleExitRoom} initialRoomId={selectedRoomId}>
      <GameContextProvider initialScenario={1}>
        <SinglePlayerView onExit={handleExitMode} />
      </GameContextProvider>
    </MultiplayerShell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
