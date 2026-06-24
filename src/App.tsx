import React, { useEffect, useState } from 'react';
import { GameContextProvider, useGameContext } from './state/gameContext';
import { useAutosave } from './state/useAutosave';
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
import { TurnBasedSettingsProvider } from './state/turnBasedSettings';
import { MapLayersProvider } from './state/mapLayers';
import { TutorialProvider } from './state/tutorial';
import { TUTORIAL_STEP_COUNT } from './game/tutorialSteps';
import { TutorialOverlay } from './components/TutorialOverlay';
import { TutorialPromptModal } from './components/TutorialPromptModal';
import { AuthOverlay } from './multiplayer/AuthOverlay';
import { Landing } from './components/Landing';
import { TunablesPage } from './components/TunablesPage';
import { UXGallery } from './components/UXGallery';
import { ShipIconGalleryPage } from './components/ShipIconGalleryPage';
import { PhysicsSandbox } from './physicsSandbox/PhysicsSandbox';
import { TorchSandbox } from './torchSandbox/TorchSandbox';
import { ModePicker, GameMode } from './ModePicker';
import { MultiplayerShell } from './multiplayer/MultiplayerShell';
import { VersionBanner } from './components/VersionBanner';
import { SituationLog } from './components/SituationLog';
import { DockRail } from './components/DockRail';
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
// Tiny bridge: SitLog dispatches 'orbital:open-panel' with a panel id;
// in SP we wire that to onTogglePanel so the requested side panel opens.
// MP has its own listener inside MultiplayerShell that handles senate/trades.
const SituationPanelBridge: React.FC<{
  onTogglePanel: (panel: 'settlements' | 'fleet' | 'research' | null) => void;
}> = ({ onTogglePanel }) => {
  React.useEffect(() => {
    const onOpenPanel = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const panel = detail?.panel;
      if (panel === 'research' || panel === 'settlements' || panel === 'fleet') {
        onTogglePanel(panel);
      }
    };
    window.addEventListener('orbital:open-panel', onOpenPanel as EventListener);
    return () => window.removeEventListener('orbital:open-panel', onOpenPanel as EventListener);
  }, [onTogglePanel]);
  return null;
};

function GameUI({
  onExit,
  isMultiplayer = false,
  adminGameId,
  isHost,
  onLoadSave,
}: {
  onExit: () => void;
  isMultiplayer?: boolean;
  adminGameId?: string | null;
  isHost?: boolean;
  /** Hand off a deserialized save back to the parent SinglePlayerView
   *  so it can remount the GameContextProvider with the loaded state.
   *  Only wired in SP; in MP the server is authoritative and Load is
   *  hidden from the menu. */
  onLoadSave?: (state: GameState) => void;
}) {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const [activePanel, setActivePanel] = useState<PanelId>(null);

  // SP autosave loop. Reads from the GameContext that wraps this GameUI
  // and writes to the rolling AUTOSAVE slot every 100 game-ticks. No-op
  // in MP (server is authoritative). Defined here rather than in
  // GameContextProvider so it can be cleanly disabled per-mode.
  const { gameState } = useGameContext();
  useAutosave(gameState, !isMultiplayer);

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
      if (e.key === 'c' || e.key === 'C') setActivePanel(p => (p === 'settlements' ? null : 'settlements'));
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
        canSaveLoad={!isMultiplayer}
        onLoadSave={onLoadSave}
      />
      {/* Left rail — persistent column on the LEFT edge. Holds the
          ShipPanel (slides down into view when a ship is selected) on
          top and the Outliner below. Wrapping both in this flex
          container is what lets the ShipPanel push the Outliner down
          without needing absolute-position math, and what lets the MP
          dock sit free on the right edge without tracking Outliner
          width. ShipPanel is always mounted — its own internal logic
          returns null when no ship is selected. */}
      <div className="left-rail">
        <ShipPanel />
        <Outliner />
      </div>

      {/* DockRail — single source of truth for which side panel is open.
          Owns the icon column + active state; SituationLog and MultiplayerShell
          render their panels in response to its events. */}
      <DockRail />
      <SituationLog />

      {/* SP-only: listen for 'orbital:open-panel' so SitLog clicks on
          a research item open the Research tab. MP has its own listener
          inside MultiplayerShell for senate/trades/etc. */}
      <SituationPanelBridge onTogglePanel={setActivePanel} />

      {activePanel === 'settlements' && (
        <SettlementsPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'fleet' && (
        <FleetPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'research' && (
        <TechPanel onClose={() => setActivePanel(null)} />
      )}

      <BodyInspector />
      <ThreatsPanel />
      {!isMultiplayer && <AIActivityFeed />}
      <MobileSimControls hideSimControls={isMultiplayer} />

      {/* Tutorial: first-game-only prompt + the coachmark overlay
          shown while a tour is active. Both portal to document.body
          so backdrop-filter on .top-bar doesn't trap them. The prompt
          self-suppresses once the player has completed/skipped (state
          persists across sessions via localStorage). */}
      <TutorialPromptModal />
      <TutorialOverlay />
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
  // Bumped whenever we want to remount GameContextProvider with a fresh
  // initialState. The provider only reads `initialState` on first mount,
  // so loading a save mid-game requires us to throw the existing provider
  // away and stand up a new one. Keying on this counter does exactly that.
  const [providerKey, setProviderKey] = useState(0);

  const handleBegin = (config: SinglePlayerConfig) => {
    setSeededState(setupSinglePlayer(config));
    setProviderKey(k => k + 1);
    setPhase('playing');
  };

  const handleNewGame = () => {
    setSeededState(null);
    setPhase('setup');
  };

  // Used by SinglePlayerSetup ("Load Save" button) AND by the in-game
  // SaveLoadModal ("LOAD" row). Both paths land us in 'playing' phase
  // with a fresh GameContextProvider seeded from the save.
  const handleLoadSave = (state: GameState) => {
    setSeededState(state);
    setProviderKey(k => k + 1);
    setPhase('playing');
  };

  if (phase === 'setup' || !seededState) {
    return (
      <SinglePlayerSetup
        onBegin={handleBegin}
        onCancel={onExit}
        onLoadSave={handleLoadSave}
      />
    );
  }

  // Derive the player's capital from the seeded state so the camera
  // lands focused on it instead of staring at Sol. The body where
  // ownedBy === 'player' is the player's capital (singlePlayerSetup
  // flips ownership for exactly one body per faction).
  const initialFocusBodyId =
    seededState.bodies.find(b => b.ownedBy === 'player')?.id ?? null;

  return (
    <GameContextProvider
      key={providerKey}
      initialState={seededState}
      initialFocusBodyId={initialFocusBodyId}
    >
      <GameUI onExit={onExit} onLoadSave={handleLoadSave} />
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
  const [showUX, setShowUX] = useState(false);
  // Ship icon gallery — reachable at ?icons. Standalone preview page
  // for picking which D/E/F candidates to keep before the dropdown
  // wires up at ship construction.
  const [showIcons, setShowIcons] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('icons'),
  );

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

        // Sanity-check the localStorage room id against actual membership.
        // If selectedRoomId points at a room that's no longer in /me/rooms
        // (kicked, deleted by host, account swapped), clear it before any
        // mode-restore logic kicks in. Otherwise we drop the user into a
        // room they can't access and the poll loop hammers 403s.
        const remembered = localStorage.getItem(ROOM_STORAGE_KEY);
        if (remembered) {
          const stillMember = res.data.rooms.some(r => r.id === remembered);
          if (!stillMember) {
            logger.warn('SYSTEM', 'Stale room id in localStorage — clearing', { roomId: remembered });
            localStorage.removeItem(ROOM_STORAGE_KEY);
            setSelectedRoomId(null);
          }
        }

        // If the user has a single active game already underway, jump them
        // straight back in — this is the "default to active game" behavior.
        const inProgress = res.data.rooms.filter(r => r.game_status === 'active');
        if (inProgress.length === 1 && mode === null) {
          // Lock selectedRoomId to that game so we don't accidentally land
          // on whatever stale room was in localStorage from another session.
          const liveId = inProgress[0].id;
          setSelectedRoomId(liveId);
          localStorage.setItem(ROOM_STORAGE_KEY, liveId);
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
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      const res = await apiFetch<{
        game_id?: string | null;
        settings?: { game_id?: string | null; host_id?: string | null };
      }>(`/api/lobby/rooms/${selectedRoomId}`);
      if (cancelled) return;
      if (res.ok) {
        const gid = (res.data.settings?.game_id ?? res.data.game_id) || null;
        setRoomHostId(res.data.settings?.host_id ?? null);
        if (!gid) {
          // No game yet — stay in the lobby tab as before.
          setRoomGameId(null);
          return;
        }
        // CRITICAL for late-join: a fresh joiner via invite link is a
        // room_member but has no faction row yet. Promoting roomGameId
        // mounts MultiplayerGameProvider which calls /state -> 403
        // ("not_member" / "Couldn't load game state"). Check
        // /joinable-bodies first; only mount the game canvas when the
        // caller actually has a faction. Otherwise leave roomGameId
        // null so the shell stays in lobby mode and LobbyView's
        // late-join picker runs.
        try {
          const fac = await apiFetch<{ already_joined: boolean }>(`/api/games/${gid}/joinable-bodies`);
          if (cancelled) return;
          if (fac.ok && fac.data && !fac.data.already_joined) {
            setRoomGameId(null);  // hold at lobby for the picker
            return;
          }
        } catch { /* fall through to the original promote */ }
        setRoomGameId(gid);
        return;
      }
      // 404 = room is gone. 403 = we're not a member anymore (kicked, or
      // a stale localStorage room id from a previous account). Either
      // way: bail back to the lobby, clear the stored id, and stop the
      // poll loop so we don't hammer the endpoint with hundreds of 403s
      // until the user reloads the tab.
      if (res.status === 404 || res.status === 403) {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
        logger.warn('SYSTEM', `Room poll bailed (${res.status}) — exiting room`, {
          roomId: selectedRoomId, code: res.error?.code,
        });
        setRoomGameId('missing');
      }
    };
    poll();
    intervalId = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
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

  // Icon gallery — auth-bypass route so the player can preview ship
  // icon candidates without signing in. Mirrors the Tunables/UX
  // pattern; reached via ?icons.
  if (showIcons) {
    return <ShipIconGalleryPage onBack={() => {
      setShowIcons(false);
      // Strip ?icons from the URL so a refresh doesn't bounce back here.
      const url = new URL(window.location.href);
      url.searchParams.delete('icons');
      window.history.replaceState({}, '', url.toString());
    }} />;
  }

  // Unauthenticated, not yet in guest mode: show landing first, then auth overlay.
  // The auth overlay still offers a "continue as guest" path.
  // The Tunables sandbox and UX Lab are reachable from the landing nav and bypass auth.
  if (!user && !guestMode) {
    if (showTunables) {
      return <TunablesPage onBack={() => setShowTunables(false)} />;
    }
    if (showUX) {
      return <UXGallery onBack={() => setShowUX(false)} />;
    }
    if (!showAuth) {
      return (
        <Landing
          onSignIn={() => setShowAuth(true)}
          onShowTunables={() => setShowTunables(true)}
          onShowUX={() => setShowUX(true)}
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

/**
 * Top-level router gate. The physics sandbox lives on `feat/real-physics`
 * and is reachable at `?physics`. It's deliberately stood up OUTSIDE the
 * AppShell tree so it doesn't carry auth / providers / multiplayer wiring
 * along with it — it's a pure KSP-style maneuver playground.
 */
function AppRouter() {
  const [physicsMode, setPhysicsMode] = useState(() =>
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('physics'),
  );
  const [torchMode, setTorchMode] = useState(() =>
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('torch'),
  );
  if (physicsMode) {
    return (
      <PhysicsSandbox
        onExit={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('physics');
          window.history.replaceState({}, '', url.toString());
          setPhysicsMode(false);
        }}
      />
    );
  }
  if (torchMode) {
    return (
      <TorchSandbox
        onExit={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('torch');
          window.history.replaceState({}, '', url.toString());
          setTorchMode(false);
        }}
      />
    );
  }
  return (
    <AuthProvider>
      <TurnBasedSettingsProvider>
        <MapLayersProvider>
          <TutorialProvider stepCount={TUTORIAL_STEP_COUNT}>
            <AppShell />
          </TutorialProvider>
        </MapLayersProvider>
      </TurnBasedSettingsProvider>
    </AuthProvider>
  );
}

export function App() {
  return (
    <ErrorBoundary scope="App">
      <AppRouter />
      <VersionBanner />
    </ErrorBoundary>
  );
}

export default App;
