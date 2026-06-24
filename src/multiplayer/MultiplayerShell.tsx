import React, { useEffect, useRef, useState } from 'react';
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

// In-GAME, exiting the match is owned by the TopBar title-button
// drawer's GAME → "Back to Menu" entry (see App.tsx handleExitMode).
// But PRE-game (in the lobby, no TopBar yet) the only way out is the
// room's Back button, so we pass `onExit` down to LobbyView for that —
// it leaves the room and returns to the multiplayer room browser.
export function MultiplayerShell({ children, initialRoomId, onExit }: MultiplayerShellProps) {
  // `signOut` used to live behind the mp-user-pill (top-right pill with
  // "← Menu", display name, and Sign out). That pill duplicated the
  // TopBar title-button drawer's GAME section ("Back to Menu") and
  // ACCOUNT section ("Sign Out"), and visually competed with the
  // Outliner + Comms toasts. Removed; signOut import goes with it.
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>('lobby');
  const [gameId, setGameId] = useState<string | null>(null);
  // Host-only mid-game invite: the room's invite code stays valid after
  // start, so the host can pull a latecomer into an unclaimed world.
  const [invite, setInvite] = useState<{ code: string | null; isHost: boolean } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  // If the player arrives in a room where a game is already active and the
  // tab is still 'lobby' (which is now hidden), jump them to Faction so
  // they're not staring at a blank dock body.
  useEffect(() => {
    if (gameId && tab === 'lobby') setTab('faction');
  }, [gameId, tab]);

  // Pull the room's invite code + host flag once we're in a game, so the
  // host can invite a latecomer mid-match. game.id === room.id here.
  useEffect(() => {
    if (!gameId) { setInvite(null); return; }
    let cancelled = false;
    (async () => {
      const res = await apiFetch<RoomSnapshot>(`/api/lobby/rooms/${gameId}`);
      if (cancelled || !res.ok || !res.data) return;
      setInvite({
        code: res.data.settings.invite_code ?? null,
        isHost: res.data.settings.host_id === user?.id,
      });
    })();
    return () => { cancelled = true; };
  }, [gameId, user?.id]);

  async function copyInvite() {
    if (!invite?.code) return;
    try { await navigator.clipboard.writeText(invite.code); } catch { /* ignore */ }
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2500);
  }

  // Detect game_id by polling the room snapshot ourselves rather than
  // relying on LobbyView mounting — that tab is hidden once a game has
  // started, but a returning player still needs to discover it.
  //
  // CRITICAL for late-join: only enter the game (setGameId) if this user
  // actually HAS a faction. A latecomer who joined via invite link after
  // start is a room member with no faction; auto-entering would mount the
  // game canvas and 403 on /state. For them we leave gameId null and keep
  // the lobby tab active, where LobbyView shows the world picker.
  useEffect(() => {
    if (!initialRoomId || gameId) return;
    let cancelled = false;
    const poll = async () => {
      const res = await apiFetch<RoomSnapshot>(`/api/lobby/rooms/${initialRoomId}`);
      if (cancelled || !res.ok || !res.data.game_id) return;
      const gid = res.data.game_id;
      const fac = await apiFetch<{ already_joined: boolean }>(`/api/games/${gid}/joinable-bodies`);
      if (cancelled) return;
      if (fac.ok && fac.data && !fac.data.already_joined) {
        // Latecomer without a faction — keep them in the lobby tab so the
        // late-join picker (in LobbyView) can run.
        setTab('lobby');
        return;
      }
      setGameId(gid);
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [initialRoomId, gameId]);
  const [incomingTradeCount, setIncomingTradeCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  // Modal payload for a freshly-arrived trade offer. Cleared by either
  // the Dismiss button or by 'Take me there' (which also switches the
  // dock to the Trades tab). One offer at a time; if a second arrives
  // while the modal is up, the newer one replaces the older — the older
  // is already in the Trades tab badge and the EventLog so it isn't
  // lost.
  const [pendingTrade, setPendingTrade] = useState<{
    tradeId: string;
    proposerName: string;
  } | null>(null);
  // Caller's own faction id, learned from the trades-list response.
  // Held in a ref so the WS handler can read the latest value without
  // re-subscribing. Used to suppress the incoming-trade popup for
  // trades the local player SENT (the 'proposed' broadcast fans out to
  // everyone in the room, including the proposer).
  const myFactionIdRef = useRef<string | null>(null);
  // Transient toast notifications fanned out of the room WebSocket.
  // Each has a unique id so React can key it and a setTimeout dismisses
  // it after a few seconds.
  const [toasts, setToasts] = useState<Array<{ id: string; text: string; kind: 'trade' | 'message' | 'tick' | 'combat' }>>([]);

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
      // Remember who we are so the WS handler can tell our own outgoing
      // proposals apart from genuinely incoming ones.
      if (callerFactionId) myFactionIdRef.current = callerFactionId;
      setIncomingTradeCount(
        res.data.trades.filter((t) => t.responder_faction_id === callerFactionId).length,
      );
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gameId]);

  // Poll unread message count for the Comms tab badge.
  useEffect(() => {
    if (!gameId) {
      setUnreadMessages(0);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const res = await apiFetch<{ unread: number }>(`/api/games/${gameId}/messages/unread-count`);
      if (cancelled || !res.ok) return;
      setUnreadMessages(res.data.unread ?? 0);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gameId]);

  // CommsPanel now marks messages read on the server as the player
  // views each channel, and decrements `unreadMessages` via the
  // onUnreadDelta callback so the badge tracks reality channel-by-
  // channel. The blanket optimistic clear on tab change has been
  // removed — it was the root cause of the "ping comes back" bug
  // (zeroed locally, restored 10s later by /unread-count when the
  // server still had unread DMs in some other thread).

  // Listen on the room WebSocket for push events (trade / message /
  // tick / ships_destroyed) and surface them as toasts. The /notify
  // endpoint on the Room DO fans these out to all connected sockets.
  useEffect(() => {
    if (!gameId) return;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/rooms/${gameId}/ws`);
    const pushToast = (kind: 'trade' | 'message' | 'tick' | 'combat', text: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((cur) => [...cur, { id, text, kind }]);
      // Auto-dismiss
      setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.id !== id));
      }, 5000);
    };
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m?.kind === 'trade') {
          if (m.event === 'proposed') {
            // The 'proposed' broadcast fans out to EVERY socket in the
            // room, including the proposer's. Skip it for our own
            // outgoing trades — those aren't incoming, so no toast, no
            // popup, no badge bump.
            if (m.proposer_faction_id && m.proposer_faction_id === myFactionIdRef.current) {
              return;
            }
            const proposer = (typeof m.proposer_faction_name === 'string' && m.proposer_faction_name)
              ? m.proposer_faction_name
              : 'Another faction';
            pushToast('trade', `New trade offer from ${proposer}`);
            setIncomingTradeCount((n) => n + 1);
            setPendingTrade({
              tradeId: String(m.trade_id ?? ''),
              proposerName: proposer,
            });
          } else if (m.event === 'accepted') {
            pushToast('trade', 'Trade accepted');
          } else if (m.event === 'declined') {
            pushToast('trade', 'Trade declined');
          } else if (m.event === 'countered') {
            pushToast('trade', 'Counter-offer received');
          }
        } else if (m?.kind === 'treaty') {
          // Treaty WS broadcasts come from worker/trades.js handleBreakTreaty
          // (and any future treaty-lifecycle handlers). 'broken' is the
          // notable one for now — implicit war resumes the moment a NAP or
          // defense pact dies, so the other party needs to know.
          if (m.event === 'broken') {
            const kindLabel = m.treaty_kind === 'defense_pact' ? 'Defense Pact'
              : m.treaty_kind === 'nap' ? 'Non-Aggression Pact'
              : m.treaty_kind === 'intel_share' ? 'Intel-Share Pact'
              : 'Treaty';
            pushToast('trade', `${kindLabel} broken — war resumes`);
          }
        } else if (m?.kind === 'message') {
          pushToast('message', 'New message in Comms');
          setUnreadMessages((n) => n + 1);
        } else if (m?.type === 'ships_destroyed') {
          pushToast('combat', `${(m.ship_ids?.length ?? 1)} ship(s) destroyed`);
        }
        // 'tick' events fire every tick; too noisy for a toast. Skip.
      } catch { /* ignore non-json */ }
    });
    return () => { try { ws.close(); } catch {} };
  }, [gameId]);

  // MultiplayerShell is mounted only when AppShell has already authed the
  // user, so user should always be present here. Guard anyway.
  if (!user) return <>{children}</>;

  return (
    <>
      {children}
      {pendingTrade && (
        <div
          className="mp-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="trade-modal-title"
          onClick={() => setPendingTrade(null)}
        >
          <div className="mp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mp-modal__title" id="trade-modal-title">
              ⚖ Incoming Trade Offer
            </div>
            <div className="mp-modal__desc">
              <strong style={{ color: 'var(--mp-friendly)' }}>{pendingTrade.proposerName}</strong>{' '}
              is offering you a trade. Review and accept, counter, or decline it from the Trades panel.
            </div>
            <div className="mp-modal__actions">
              <button
                className="mp-btn"
                onClick={() => setPendingTrade(null)}
              >Dismiss</button>
              <button
                className="mp-btn mp-btn--primary"
                onClick={() => {
                  setTab('trades');
                  setCollapsed(false);
                  setPendingTrade(null);
                }}
              >Take Me There</button>
            </div>
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="mp-toasts">
          {toasts.map(t => (
            <div key={t.id} className={`mp-toast mp-toast--${t.kind}`}>
              <span className="mp-toast__icon">
                {t.kind === 'trade' ? '⚖' : t.kind === 'message' ? '✉' : t.kind === 'combat' ? '✸' : '◷'}
              </span>
              <span className="mp-toast__text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`mp-dock ${collapsed ? 'collapsed' : ''}`}>
        <div className="mp-dock-head">
          <span>{collapsed ? '▸' : 'MULTIPLAYER'}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!collapsed && gameId && invite?.isHost && invite.code && (
              <button
                onClick={copyInvite}
                title="Copy the invite code — a friend can join an unclaimed world mid-game"
                style={{ fontSize: 11, letterSpacing: '0.04em' }}
              >
                {inviteCopied ? `✓ ${invite.code}` : '⧉ Invite'}
              </button>
            )}
            <button onClick={() => setCollapsed((c) => !c)}>{collapsed ? '⤡' : '×'}</button>
          </div>
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
                title={unreadMessages > 0 ? `${unreadMessages} unread message${unreadMessages > 1 ? 's' : ''}` : 'Comms'}
              >
                Comms{unreadMessages > 0 && (
                  <span style={{
                    marginLeft: 4, padding: '0 5px', fontSize: 9,
                    background: '#4ecdc4', color: '#0a0e14', borderRadius: 8,
                    fontWeight: 700,
                  }}>{unreadMessages}</span>
                )}
              </button>
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
                  onExitRoom={onExit}
                />
              )}
              {tab === 'faction' && gameId && <FactionPanel gameId={gameId} />}
              {tab === 'comms'   && gameId && (
                <CommsPanel
                  gameId={gameId}
                  onUnreadDelta={(d) => setUnreadMessages((n) => Math.max(0, n + d))}
                />
              )}
              {tab === 'senate'  && gameId && <SenatePanel  gameId={gameId} />}
              {tab === 'trades'  && gameId && <TradesPanel  gameId={gameId} />}
            </div>
          </>
        )}
      </div>
    </>
  );
}
