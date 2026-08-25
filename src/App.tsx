import React, { useEffect, useState } from 'react';
import { GameContextProvider, useGameContext } from './state/gameContext';
import { useAutosave } from './state/useAutosave';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { GroupSelectionPanel } from './components/GroupSelectionPanel';
import { BodyInspector } from './components/BodyInspector';
import { TopBar, PanelId } from './components/TopBar';
import { Outliner } from './components/Outliner';
import { SettlementsPanel } from './components/SettlementsPanel';
import { FleetPanel } from './components/FleetPanel';
import { ShipDesigner } from './components/ShipDesigner';
import { CaptainDebut } from './components/CaptainDebut';
import type { ShipClassName } from './game/shipClasses';
import { TechPanel } from './components/TechPanel';
// ThreatsPanel intentionally NOT imported — retired in favour of the
// Situation Log's "Incoming threats" section (see the note at its old
// mount point below). The component file is kept for reference/revert.
import { AIActivityFeed } from './components/AIActivityFeed';
import { MobileSimControls } from './components/MobileSimControls';
import { SinglePlayerSetup } from './components/SinglePlayerSetup';
import { VictoryOverlay } from './components/VictoryOverlay';
import { SharedFilm } from './multiplayer/SharedFilm';
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
import { SharedRecap } from './multiplayer/SharedRecap';
import { ShipIconGalleryPage } from './components/ShipIconGalleryPage';
import { PhysicsSandbox } from './physicsSandbox/PhysicsSandbox';
import { TorchSandbox } from './torchSandbox/TorchSandbox';
import { MultiplayerShell } from './multiplayer/MultiplayerShell';
import { WorldMenuOverlay, WorldMenuToggle, worldMenuPref } from './multiplayer/WorldMenuOverlay';
import { WarpGateCard } from './multiplayer/WarpGateCard';
import { MeteoroidCard } from './multiplayer/MeteoroidCard';
import { MegastructureCard } from './multiplayer/MegastructureCard';
import { VersionBanner } from './components/VersionBanner';
import { SituationLog } from './components/SituationLog';
import { DiscoveryBanner } from './components/DiscoveryBanner';
import { RecapOverlay } from './components/RecapOverlay';
import { EventLog } from './components/EventLog';
import { GroupActionBar } from './components/GroupActionBar';
import { DockRail } from './components/DockRail';
import { MultiplayerLobby } from './multiplayer/MultiplayerLobby';
import { MultiplayerGameProvider } from './multiplayer/MultiplayerGameProvider';
import { apiFetch, RoomSummary } from './multiplayer/api';
import { logger } from './game/logger';
import { ErrorBoundary } from './components/ErrorBoundary';
import './multiplayer/multiplayer.css';
import './App.css';
import './styles/mobile.css';
// JS-driven mirror of the shell rules — keyed on <html data-mobile-shell>,
// which useIsMobile stamps. Imported AFTER mobile.css so it wins ties, and
// it's what makes a phone/tablet OS (e.g. a Fold's wide inner screen) get
// the mobile shell even though no media query can detect it.
import './styles/shellJs.css';

/** Which engine the session is in. 'singleplayer' is unreachable — SP
 *  entry is retired — but the union survives because SinglePlayerView is
 *  still in the tree. Lived in ModePicker.tsx until that screen was
 *  deleted (it was a one-destination menu in front of the lobby). */
export type GameMode = 'singleplayer' | 'multiplayer';

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
      // null closes any open panel — the mobile DockRail uses this to
      // toggle: a second tap on an active button dispatches { panel: null }.
      if (panel === null) {
        onTogglePanel(null);
        return;
      }
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
  // Ship designer overlay (multiplayer only — SP has no designer, the
  // SP sim is frozen). Opened via the 'orbital:open-ship-designer'
  // event from the FleetPanel button / BuildPanel quick-links.
  // { open, cls } so a quick-link can land on the right class tab.
  const [designerState, setDesignerState] = useState<{ open: boolean; cls?: ShipClassName }>({ open: false });

  useEffect(() => {
    if (!isMultiplayer) return;
    const onOpenDesigner = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setDesignerState({ open: true, cls: detail?.shipClass });
    };
    window.addEventListener('orbital:open-ship-designer', onOpenDesigner as EventListener);
    // Close twin — lets the tutorial (and anything else) dismiss the
    // designer programmatically when it moves on to another surface.
    const onCloseDesigner = () => setDesignerState({ open: false });
    window.addEventListener('orbital:close-ship-designer', onCloseDesigner);
    return () => {
      window.removeEventListener('orbital:open-ship-designer', onOpenDesigner as EventListener);
      window.removeEventListener('orbital:close-ship-designer', onCloseDesigner);
    };
  }, [isMultiplayer]);

  // Broadcast the active panel id whenever it changes so the DockRail
  // (which hosts mobile-only Settlements/Fleet/Research buttons) can
  // mirror the active highlight. Source of truth stays here; the rail
  // is a passive subscriber.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('orbital:panel-state', { detail: { panel: activePanel } }));
    } catch { /* noop */ }
  }, [activePanel]);

  // SP autosave loop. Reads from the GameContext that wraps this GameUI
  // and writes to the rolling AUTOSAVE slot every 100 game-ticks. No-op
  // in MP (server is authoritative). Defined here rather than in
  // GameContextProvider so it can be cleanly disabled per-mode.
  // uiState here is only for targetSelectionMode: the big overlay panels
  // below must stand down while the player is picking a target on the map
  // (see the note at their render site).
  const { gameState, uiState } = useGameContext();
  useAutosave(gameState, !isMultiplayer);

  // World-menu preference (MP only — SP never reads this). Synced to
  // the toggle pill via the pref event so flipping it re-renders here.
  const [worldMenuOn, setWorldMenuOn] = useState(() => worldMenuPref());
  useEffect(() => {
    if (!isMultiplayer) return;
    const onPref = () => setWorldMenuOn(worldMenuPref());
    window.addEventListener('orbital:world-menu-pref', onPref);
    return () => window.removeEventListener('orbital:world-menu-pref', onPref);
  }, [isMultiplayer]);

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
      {/* The ship-card slot holds ONE of two things. With a group
          selected (2+ live hulls) the GroupSelectionPanel lists what
          you're commanding — previously the rail showed whichever single
          ship you last clicked, which disagreed with the "9 selected"
          action bar at the bottom of the screen. Below two, it returns
          null and ShipPanel has the slot as before. */}
      <div className="left-rail">
        <GroupSelectionPanel />
        <ShipPanel />
        <Outliner />
      </div>

      {/* DockRail — single source of truth for which side panel is open.
          Owns the icon column + active state; SituationLog and MultiplayerShell
          render their panels in response to its events. */}
      <DockRail isMultiplayer={isMultiplayer} />
      <SituationLog />
      <EventLog />
      {/* Discovery fanfare — animated banner when a body secret is
          uncovered (yours: celebratory + jump-to; a rival's: intel). */}
      <DiscoveryBanner />
      <RecapOverlay />
      {/* Shift-click group controls — renders nothing until a group
          exists, so it costs a mount and no screen space otherwise. */}
      <GroupActionBar />

      {/* SP-only: listen for 'orbital:open-panel' so SitLog clicks on
          a research item open the Research tab. MP has its own listener
          inside MultiplayerShell for senate/trades/etc. */}
      <SituationPanelBridge onTogglePanel={setActivePanel} />

      {/* THE BIG OVERLAY PANELS STAND DOWN WHILE YOU PICK A TARGET.
          `.overview-panel` is a FIXED 640px-wide, z-110 sheet, and on a
          1280px screen it covered the left half of the map — measured,
          only 48% of the canvas could receive a click while Fleet was
          open. So the usual flow (open Fleet → pick a ship → MOVE TO
          TARGET → click the destination) failed for any target under the
          panel: the click landed on the sheet and the map never saw it.
          The ship panel already did this on mobile, guarded by
          `isMobile && targetSelectionMode`, on the stated assumption that
          "Desktop is unaffected — the panel docks to the side and doesn't
          cover the canvas". That is true of the left rail and false of
          this one.
          Hidden rather than made click-through: a transparent-to-clicks
          sheet still hides the target you are trying to aim at, so you
          would be clicking blind. `activePanel` is untouched, so the
          panel returns exactly as it was the moment targeting ends. */}
      {activePanel === 'settlements' && !uiState.targetSelectionMode && (
        <SettlementsPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'fleet' && !uiState.targetSelectionMode && (
        <FleetPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'research' && !uiState.targetSelectionMode && (
        <TechPanel onClose={() => setActivePanel(null)} />
      )}
      {isMultiplayer && designerState.open && (
        <ShipDesigner
          initialClass={designerState.cls}
          onClose={() => setDesignerState({ open: false })}
        />
      )}

      {/* Captain debut card (DESIGN-captains §5.1) — dismissible rename
          offer when a new ship launches with a fresh captain. MP only. */}
      {isMultiplayer && <CaptainDebut />}

      {/* World menu (MULTIPLAYER ONLY, default ON with a kill-switch
          pill). SP is DEAD code-wise here: isMultiplayer=false always
          renders <BodyInspector /> exactly as before — the world menu
          and its toggle are unreachable outside MP. */}
      {isMultiplayer && worldMenuOn
        ? <><WorldMenuOverlay /><WarpGateCard /><MeteoroidCard /><MegastructureCard /></>
        : <BodyInspector />}
      {isMultiplayer && <WorldMenuToggle on={worldMenuOn} />}
      {/* ThreatsPanel (the top-right popup) is RETIRED — incoming hostile
          ships now live in the Situation Log's "Incoming threats" NOW-tier
          section, which says strictly more than the popup did (attacker,
          hull classes, ETA, and what's at stake) and badges the dock rail
          with a warn state so urgency still reads without a floating
          overlay covering the map. See src/components/ThreatsPanel.tsx. */}
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
// Written by the ★ toggle in MultiplayerLobby's My Games list (that file
// owns the write path; this effect owns the one read, at mount). Keep the
// literal in sync between the two files if it ever changes.
const PRIORITY_ROOM_KEY = 'orbital.priority_room';

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
  // (activeRooms state retired with the mode picker — the rooms fetch
  //  below still runs, but only the priority/auto-jump logic reads it.)
  const [showAuth, setShowAuth] = useState(false);
  // Ship icon gallery — reachable at ?icons. Standalone preview page
  // for picking which D/E/F candidates to keep before the dropdown
  // wires up at ship construction.
  const [showIcons, setShowIcons] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('icons'),
  );

  // DOC ROUTES (/changelog, /how-to-play). These live on the landing page,
  // which only renders when signed OUT — so a logged-in player following
  // a Discord link was dropped straight into their game and never saw the
  // page. They are auth-bypass routes for the same reason ?icons is: the
  // path is the whole point, and it has to work for whoever clicks it.
  const [docRoute, setDocRoute] = useState<string | null>(() =>
    typeof window !== 'undefined'
      && ['/changelog', '/how-to-play'].includes(window.location.pathname)
      ? window.location.pathname : null,
  );
  /** The token out of /recap/<token>, if that is where we are. */
  const [recapToken, setRecapToken] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? (/^\/recap\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname)?.[1] ?? null)
      : null,
  );
  /** The token out of /film/<token>: a whole-match film, its own space. */
  const [filmToken, setFilmToken] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? (/^\/film\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname)?.[1] ?? null)
      : null,
  );
  useEffect(() => {
    const onPop = () => {
      const p = window.location.pathname;
      setDocRoute(['/changelog', '/how-to-play'].includes(p) ? p : null);
      setRecapToken(/^\/recap\/([A-Za-z0-9_-]+)\/?$/.exec(p)?.[1] ?? null);
      setFilmToken(/^\/film\/([A-Za-z0-9_-]+)\/?$/.exec(p)?.[1] ?? null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // When the user authenticates, fetch any rooms they're already a member
  // of so we can jump straight back into a pinned or lone active game.
  useEffect(() => {
    if (!user) return;
    logger.setSession({ playerName: user.display_name || user.email });
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/users/me/rooms');
      if (cancelled) return;
      if (res.ok) {
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

        // Priority game: an explicit pin (the ★ in My Games) beats both
        // "resume whatever was last visited" and the lone-active-game
        // auto-jump below — the whole point of pinning is a deliberate
        // choice that survives visiting OTHER games in between launches,
        // which last-visited-wins can't express once you have more than
        // one active campaign. Cleared if the pinned room is no longer a
        // valid membership (deleted, kicked, host swapped it) so the app
        // never gets stuck pointing at a dead room id.
        const priorityId = localStorage.getItem(PRIORITY_ROOM_KEY);
        if (priorityId && mode === null) {
          const stillMember = res.data.rooms.some(r => r.id === priorityId);
          if (!stillMember) {
            logger.warn('SYSTEM', 'Priority room no longer a membership — clearing', { roomId: priorityId });
            localStorage.removeItem(PRIORITY_ROOM_KEY);
          } else {
            setSelectedRoomId(priorityId);
            localStorage.setItem(ROOM_STORAGE_KEY, priorityId);
            setMode('multiplayer');
            return;
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
      }
      // No pinned or lone active game — fall through to the lobby, which
      // is what mode === null renders now that the picker is gone.
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // handlePickMode retired with the mode picker — nothing asks the
  // player to choose a mode any more.

  const handleExitMode = () => {
    logger.info('SYSTEM', 'Exiting mode → lobby');
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

  // Guest → SP entry retired (usability report): AuthOverlay no longer
  // renders a guest button and no path sets guestMode/mode='singleplayer'.
  // SinglePlayerView stays in the tree for type-compat but is unreachable.

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

  // Doc routes render for EVERYONE, before the auth branch below.
  // Landing is reused rather than mounting the article bare: `.landing`
  // owns the scroll context (global `html, body { overflow: hidden }`
  // means a bare page cannot scroll at all) and carries the starfield,
  // the palette variables and the tab nav. Landing reads the path itself,
  // so it opens the right tab with no extra plumbing.
  // A shared battle recap. Checked BEFORE auth for the same reason
  // /changelog is: whoever you sent the link to does not have an account
  // here, and the whole point of a share is that it opens.
  if (filmToken) {
    return <SharedFilm token={filmToken} />;
  }
  if (recapToken) {
    return <SharedRecap token={recapToken} />;
  }

  if (docRoute) {
    return (
      <Landing
        onSignIn={() => { setDocRoute(null); setShowAuth(true); }}
        authed={!!user}
        onExit={() => {
          window.history.pushState({}, '', '/');
          setDocRoute(null);
        }}
      />
    );
  }

  // Unauthenticated: show landing first, then auth overlay (guest path
  // retired — accounts only). The Tunables sandbox and UX Lab used to
  // hang off the landing nav as auth-bypass routes; both are deleted.
  if (!user && !guestMode) {
    if (!showAuth) {
      return <Landing onSignIn={() => setShowAuth(true)} />;
    }
    return <AuthOverlay />;
  }

  if (guestMode) {
    return <SinglePlayerView onExit={handleExitMode} />;
  }

  // The mode picker is GONE. Once single-player entry was retired every
  // button on it — both RESUME rows and the one NEW GAME card — called
  // onPick('multiplayer'), so it was a menu with a single destination
  // sitting in front of the lobby, which already lists My Games / Browse
  // / Create. mode === null now falls through to the multiplayer path.
  if (mode === 'singleplayer') {
    return <SinglePlayerView onExit={handleExitMode} />;
  }

  // multiplayer — lobby first, then in-room shell
  if (!selectedRoomId) {
    return (
      <MultiplayerLobby onEnterRoom={handleEnterRoom} />
    );
  }

  // Pre-game (host still configuring / players still readying up): show
  // just the dock + lobby tab; no game canvas yet because no /state row
  // exists on the server. Once roomGameId is a real id, swap in the
  // game provider which feeds the canvas.
  const gameStarted = typeof roomGameId === 'string' && roomGameId.length > 0;
  return (
    <MultiplayerShell onExit={handleExitRoom} initialRoomId={selectedRoomId} preGame={!gameStarted}>
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
        // Pre-game backdrop + the dock rail's Multiplayer icon. The rail
        // normally lives inside GameUI, which isn't mounted until the game
        // starts — so pre-game had no way to open the lobby dock the hint
        // below points at. lobbyOnly renders just the Multiplayer icon
        // (the other panels need a live game).
        <>
        <DockRail isMultiplayer lobbyOnly />
        {/* Pre-game backdrop — a plain dark fill, nothing else.
            LobbyMapPreview (rendered by LobbyView, also position:fixed
            inset:0) paints the solar system straight over this, so the
            player's first sight of the game is the map they're about to
            pick a homeworld on. This layer only matters for the moment
            before the room snapshot arrives, and as a floor if the
            preview can't mount.

            It must stay BEHIND the preview: both sit at z-index 0, and
            this renders first as MultiplayerShell's children, so the
            preview wins on DOM order. Don't raise this above 0.

            The old "use the dock on the right" hint is gone with the
            black screen it explained — the panel now opens on arrival
            (see lobbyOnly in DockRail), so there's nothing to point at. */}
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#05080e',
          zIndex: 0,
          pointerEvents: 'none',
        }} />
        </>
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
