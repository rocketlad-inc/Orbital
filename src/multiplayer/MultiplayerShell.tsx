import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { LobbyView } from './LobbyView';
import { FactionPanel } from './FactionPanel';
import { CommsPanel } from './CommsPanel';
import { SenatePanel } from './SenatePanel';
import { TradesPanel } from './TradesPanel';
import { tradesApi, apiFetch, RoomSnapshot } from './api';
import { openScreen, logAction } from './telemetry';

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

/** "Players" glyph for the multiplayer dock — a group-of-people icon reads
 *  unambiguously as the multiplayer/diplomacy panel, replacing the old bare
 *  ▸ / ⤡ arrows. Inherits colour via currentColor. */
const MpPeopleIcon: React.FC = () => (
  <svg
    className="mp-dock-icon" viewBox="0 0 24 24" width="18" height="18"
    fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    <circle cx="9" cy="8" r="3.1" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.3a3.1 3.1 0 0 1 0 5.7" />
    <path d="M17.2 14.5a5.5 5.5 0 0 1 3.3 5" />
  </svg>
);

interface MultiplayerShellProps {
  children: React.ReactNode;
  onExit?: () => void;
  initialRoomId?: string | null;
  /** Pre-game: open the lobby dock immediately instead of waiting for a
   *  click. The lobby is the player's first sight of the game and the
   *  panel is the whole screen's content, so starting collapsed showed
   *  them an empty backdrop and made them go looking for it.
   *
   *  This is a PROP rather than something derived from DockRail's
   *  broadcast because React runs child effects before parent effects:
   *  DockRail (a descendant, via children) fires its initial
   *  'dockrail:active' before this component's listener is registered,
   *  so the opening event is missed. The rail defaults to the same
   *  value on its side (see lobbyOnly in DockRail) — after mount the
   *  two stay in sync through the event channel as usual. */
  preGame?: boolean;
}

// In-GAME, exiting the match is owned by the TopBar title-button
// drawer's GAME → "Back to Menu" entry (see App.tsx handleExitMode).
// But PRE-game (in the lobby, no TopBar yet) the only way out is the
// room's Back button, so we pass `onExit` down to LobbyView for that —
// it leaves the room and returns to the multiplayer room browser.
/**
 * "N ship(s) destroyed" told a player nothing about the only part that
 * mattered: whether the wreck was theirs. The broadcast is room-wide, so
 * the server cannot phrase it per-viewer — it ships the owner of each
 * loss plus the tick's at-peace pairs, and each client works out its own
 * standing here.
 *
 * Falls back to the old bare count when `owners` is absent, so a client
 * that outruns a server deploy still gets a sensible toast instead of
 * calling every loss an enemy's.
 */
function shipLossToast(
  total: number,
  owners: Array<string | null> | null,
  peacePairs: string[],
  myFactionId: string | null,
): string {
  if (!owners || owners.length === 0 || !myFactionId) {
    return `${total} ship${total === 1 ? '' : 's'} destroyed`;
  }
  const peace = new Set(peacePairs);
  const atPeace = (other: string) => peace.has(
    myFactionId < other ? `${myFactionId}|${other}` : `${other}|${myFactionId}`,
  );
  let mine = 0, friendly = 0, enemy = 0, unknown = 0;
  for (const o of owners) {
    // An unattributed hull is NOT an enemy's. It should not happen, but
    // calling someone's derelict an enemy kill is a worse failure than
    // admitting the paperwork is missing.
    if (!o) unknown++;
    else if (o === myFactionId) mine++;
    else if (atPeace(o)) friendly++;
    else enemy++;
  }
  // Your own losses lead, always — that is the half a player has to act
  // on, and burying it behind an enemy count is how a wipe reads as a
  // win at a glance.
  const parts: string[] = [];
  if (mine > 0) parts.push(mine === 1 ? 'Your ship' : `${mine} of your ships`);
  if (friendly > 0) parts.push(friendly === 1 ? 'a friendly ship' : `${friendly} friendly ships`);
  if (enemy > 0) parts.push(enemy === 1 ? 'an enemy ship' : `${enemy} enemy ships`);
  if (unknown > 0) parts.push(unknown === 1 ? 'an unidentified ship' : `${unknown} unidentified ships`);
  if (parts.length === 0) return `${total} ship${total === 1 ? '' : 's'} destroyed`;
  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  // Capitalised only when the sentence does not already start with
  // "Your" — "A friendly ship destroyed" beats "a friendly ship...".
  const text = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${text} destroyed`;
}

export function MultiplayerShell({ children, initialRoomId, onExit, preGame = false }: MultiplayerShellProps) {
  // `signOut` used to live behind the mp-user-pill (top-right pill with
  // "← Menu", display name, and Sign out). That pill duplicated the
  // TopBar title-button drawer's GAME section ("Back to Menu") and
  // ACCOUNT section ("Sign Out"), and visually competed with the
  // Outliner + Comms toasts. Removed; signOut import goes with it.
  const { user } = useAuth();
  // Open/close state owned by the DockRail. `collapsed` is now derived
  // (kept for any descendant code paths that read it); setCollapsed
  // proxies to the rail so all open/close decisions funnel through one
  // event channel.
  const [railOpen, setRailOpen] = useState(preGame);
  const [railMounted, setRailMounted] = useState(preGame);
  const collapsed = !railOpen;
  void collapsed;  /* preserved for any descendant code paths still referencing it */
  const setCollapsed = (next: boolean) => {
    try { window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: next ? null : 'multiplayer' } })); } catch {}
  };
  const [tab, setTab] = useState<Tab>('lobby');
  /** Cross-tab request to open a DM. The nonce lets the same faction be
   *  requested twice in a row.
   *
   *  Currently has NO setter: its only trigger was the Senate's
   *  blocking-coalition builder, removed with that section. Kept because
   *  CommsPanel still accepts `focusFaction` and this is the wire it
   *  arrives on — a future message button re-enables the path by calling
   *  a setter here, rather than rebuilding the plumbing. */
  const [commsFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  // Host-only mid-game invite: the room's invite code stays valid after
  // start, so the host can pull a latecomer into an unclaimed world.
  const [invite, setInvite] = useState<{ code: string | null; isHost: boolean } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  // DockRail-driven open/close. Listening for 'dockrail:active' means we
  // open ONLY when the rail says we should; toggling our setCollapsed
  // helper just dispatches a 'dockrail:set' so the rail stays the single
  // source of truth. railMounted gates rendering during the slide-out
  // animation so the panel still gets one frame to fade.
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const open = detail?.active === 'multiplayer';
      setRailOpen(open);
      if (open) setRailMounted(true);
      else setTimeout(() => setRailMounted(false), 250);
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // SitLog clicks on vote / trade items dispatch 'orbital:open-panel'
  // with the panel id; switch tabs + open ourselves via the rail.
  useEffect(() => {
    const onOpenPanel = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const panel = detail?.panel;
      if (panel === 'senate' || panel === 'trades' || panel === 'faction' || panel === 'comms') {
        setTab(panel);
        try { window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: 'multiplayer' } })); } catch {}
      }
    };
    window.addEventListener('orbital:open-panel', onOpenPanel as EventListener);
    return () => window.removeEventListener('orbital:open-panel', onOpenPanel as EventListener);
  }, []);

  // If the player arrives in a room where a game is already active and the
  // tab is still 'lobby' (which is now hidden), jump them to Faction so
  // they're not staring at a blank dock body.
  useEffect(() => {
    if (gameId && tab === 'lobby') setTab('faction');
  }, [gameId, tab]);

  // ONE effect instruments EVERY multiplayer menu — open and dwell.
  //
  // Coverage was previously hand-placed: a logUiEvent call sitting inside
  // whichever component someone remembered to edit, which is why exactly
  // four screens out of a dozen ever reported anything. Hanging it off
  // the tab state instead means a new tab is measured the day it ships,
  // with no call to forget, and the cleanup return gives dwell for free.
  useEffect(() => openScreen(gameId, tab), [gameId, tab]);

  // Session start — fired once per page load, per game. This is the row
  // that turns a pile of events into a VISIT: everything sharing its
  // session id belongs to one sitting, so length, actions-per-visit and
  // time-of-day all fall out of a GROUP BY.
  //
  // `viewport` is here because it settles by measurement what proportion
  // of play is actually on a phone — a question every mobile decision so
  // far has had to guess at.
  const sessionLogged = useRef(false);
  useEffect(() => {
    if (!gameId || sessionLogged.current) return;
    sessionLogged.current = true;
    logAction(gameId, 'session-start', {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      is_touch: (navigator.maxTouchPoints ?? 0) > 0,
      tz_offset: -new Date().getTimezoneOffset(),
    });
  }, [gameId]);

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
  // Senate badge: bills OPEN FOR VOTING that the caller has not cast a
  // ballot on. Polled from the proposals list (caller_vote is per-caller
  // there), so it clears when you VOTE, not when you merely look — a
  // badge you can dismiss by glancing at it is a badge that lies.
  const [incomingProposalCount, setIncomingProposalCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  // Aggregate badge for the multiplayer rail icon: total attention across
  // unread messages + incoming trades + incoming proposals.
  useEffect(() => {
    const count = (unreadMessages | 0) + (incomingTradeCount | 0) + (incomingProposalCount | 0);
    const hasWarn = (incomingTradeCount > 0) || (incomingProposalCount > 0);
    try {
      window.dispatchEvent(new CustomEvent('dockrail:badge', {
        detail: { which: 'multiplayer', count, hasWarn },
      }));
    } catch {}
  }, [unreadMessages, incomingTradeCount, incomingProposalCount]);
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
  const [toasts, setToasts] = useState<Array<{ id: string; text: string; kind: 'trade' | 'message' | 'tick' | 'combat' | 'senate' }>>([]);
  /** User ids with a live socket on this room, from the DO's `presence`
   *  broadcast. Lifted to the shell rather than fetched by the panel
   *  because the shell already holds the only in-game room socket —
   *  a second one per panel would be pure duplication.
   *
   *  PRESENTATION ONLY. Nothing may branch a game RULE on this: it is
   *  "a tab is open", not "this empire is alive", and those two come
   *  apart constantly (asleep, commuting, second device). Alive vs
   *  eliminated is faction.status, and that stays the only thing rules
   *  read. */
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

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
      // Unscoped list: the badge owes the player BOTH kinds of pending
      // action — offers awaiting an answer AND accepted legs still
      // missing a freighter. An unassigned leg is invisible until you
      // open the tab otherwise, and nothing ships while it waits.
      const res = await api.list();
      if (cancelled || !res.ok) return;
      const callerFactionId = (res.data as any).caller_faction_id;
      // Remember who we are so the WS handler can tell our own outgoing
      // proposals apart from genuinely incoming ones.
      if (callerFactionId) myFactionIdRef.current = callerFactionId;
      const incoming = res.data.trades.filter(
        (t) => t.status === 'open' && t.responder_faction_id === callerFactionId,
      ).length;
      const unassigned = res.data.trades
        .filter((t) => t.status === 'accepted')
        .reduce((n, t) => n + (t.deliveries ?? []).filter(
          (d) => d.sender_faction_id === callerFactionId && d.status === 'unassigned',
        ).length, 0);
      // STANDING DEALS COUNT TOO. The badge only ever saw one-off
      // shipments, so a recurring agreement with no freighter on it --
      // the case that stalls and then cancels itself -- badged nothing
      // at all, which is precisely the "invisible until you open the
      // tab" this poll exists to prevent. A deal already served by a
      // folded lane is NOT owed anything, so it must be judged on the
      // lane's crew rather than on which side owns a leg.
      const ags = await api.listAgreements();
      let needsHull = 0;
      if (!cancelled && ags.ok) {
        for (const a of ags.data.agreements ?? []) {
          if (a.status !== 'active') continue;
          const lane = a.legs.find(l => l.consolidated);
          if (lane) {
            // Folded: only an EMPTY lane is anyone's problem.
            if ((lane.carriers ?? []).length === 0) needsHull += 1;
            continue;
          }
          const iSend = a.i_send.metal + a.i_send.fuel + a.i_send.gold + a.i_send.science;
          if (iSend > 0 && !a.legs.some(l => l.mine)) needsHull += 1;
        }
      }
      setIncomingTradeCount(incoming + unassigned + needsHull);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gameId]);

  // Poll the senate for bills awaiting the caller's ballot.
  useEffect(() => {
    if (!gameId) {
      setIncomingProposalCount(0);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const res = await apiFetch<{ proposals: Array<{ status: string; caller_vote: string | null }> }>(
        `/api/games/${gameId}/senate/proposals`,
      );
      if (cancelled || !res.ok) return;
      setIncomingProposalCount(
        (res.data.proposals ?? []).filter(p => p.status === 'voting' && !p.caller_vote).length,
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
    const pushToast = (kind: 'trade' | 'message' | 'tick' | 'combat' | 'senate', text: string) => {
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
        // Presence rides the SAME socket as the toast events, keyed on
        // `type` rather than `kind` — which is why it fell straight
        // through this handler untouched until now. The DO re-broadcasts
        // on every connect and disconnect, and sends one to each new
        // socket on open, so a client that joins late is immediately
        // correct rather than waiting for someone else to come or go.
        if (m?.type === 'presence' && Array.isArray(m.connected)) {
          setOnlineUserIds(m.connected.filter((id: unknown) => typeof id === 'string'));
          return;
        }
        if (m?.kind === 'trade') {
          if (m.event === 'proposed') {
            // The 'proposed' broadcast fans out to EVERY socket in the
            // room, including the proposer's. Skip it for our own
            // outgoing trades — those aren't incoming, so no toast, no
            // popup, no badge bump.
            if (m.proposer_faction_id && m.proposer_faction_id === myFactionIdRef.current) {
              return;
            }
            // …and skip trades between two OTHER factions. The broadcast
            // is room-wide and unscoped, so every bystander was getting a
            // popup for offers not addressed to them — and because
            // pendingTrade is a single slot, an unrelated pair's trade
            // would overwrite the popup you actually needed to answer
            // (playtest: "the popup appears whenever" / "someone else
            // closing it closed mine"). The payload already carries the
            // responder, so scope it here — no server change needed.
            if (m.responder_faction_id && m.responder_faction_id !== myFactionIdRef.current) {
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
        } else if (m?.kind === 'senate') {
          // Server emits two kinds of senate broadcasts:
          //   - 'proposed' when a new proposal lands (from create handler)
          //   - 'resolved' when phase advance opens/resolves proposals
          //                (from resolveSenate after a tick)
          // Suppress the toast for our OWN proposals so the proposer
          // doesn't get pinged about their own work.
          const proposer = (typeof m.proposer_faction_name === 'string' && m.proposer_faction_name)
            ? m.proposer_faction_name : null;
          if (m.event === 'proposed') {
            if (m.proposer_faction_id && m.proposer_faction_id === myFactionIdRef.current) {
              // Own proposal -- skip the toast but still bump no count
              // (we know we just proposed it).
            } else {
              const title = (typeof m.title === 'string' && m.title) ? m.title : 'A new proposal';
              const from  = proposer ? ` from ${proposer}` : '';
              pushToast('senate', `${title}${from}`);
            }
          } else if (m.event === 'resolved') {
            const opened = Number(m.opened ?? 0);
            const resolved = Number(m.resolved ?? 0);
            if (opened > 0) {
              pushToast('senate', `${opened} proposal${opened > 1 ? 's' : ''} now open for voting`);
            }
            if (resolved > 0) {
              pushToast('senate', `${resolved} proposal${resolved > 1 ? 's' : ''} resolved`);
            }
          }
          // Either way, nudge the panel to re-poll right now so it shows
          // the change without waiting for its 5s interval.
          try { window.dispatchEvent(new Event('mp:senate-refresh')); } catch { /* noop */ }
        } else if (m?.kind === 'message') {
          pushToast('message', 'New message in Comms');
          setUnreadMessages((n) => n + 1);
        } else if (m?.type === 'ships_destroyed') {
          pushToast('combat', shipLossToast(
            m.ship_ids?.length ?? 1,
            Array.isArray(m.owners) ? m.owners : null,
            Array.isArray(m.peace_pairs) ? m.peace_pairs : [],
            myFactionIdRef.current,
          ));
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
                {t.kind === 'senate' ? '🏛' : t.kind === 'trade' ? '⚖' : t.kind === 'message' ? '✉' : t.kind === 'combat' ? '✸' : '◷'}
              </span>
              <span className="mp-toast__text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
      {railMounted && (
      <div className={`dock-panel mp-dock${railOpen ? ' is-open' : ''}`}>
        <div className="mp-dock-head">
          <span className="mp-dock-head__title">
            <MpPeopleIcon />
            Multiplayer
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {gameId && invite?.isHost && invite.code && (
              <button
                className="mp-dock-collapse-btn"
                onClick={copyInvite}
                title="Copy the invite code — a friend can join an unclaimed world mid-game"
                style={{ fontSize: 11, letterSpacing: '0.04em' }}
              >
                {inviteCopied ? `✓ ${invite.code}` : '⧉ Invite'}
              </button>
            )}
            <button
              className="mp-dock-collapse-btn"
              onClick={() => setCollapsed(true)}
              title="Close panel"
              aria-label="Close multiplayer panel"
            >×</button>
          </div>
        </div>
        {railOpen && (
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
                title={incomingProposalCount > 0
                  ? `${incomingProposalCount} bill${incomingProposalCount > 1 ? 's' : ''} need${incomingProposalCount > 1 ? '' : 's'} your vote`
                  : 'Senate'}
              >
                Senate{incomingProposalCount > 0 && (
                  <span style={{
                    marginLeft: 4, padding: '0 5px', fontSize: 9,
                    background: '#ff6b6b', color: '#0a0e14', borderRadius: 8,
                    fontWeight: 700,
                  }}>{incomingProposalCount}</span>
                )}
              </button>
              <button
                className={tab === 'trades' ? 'active' : ''}
                disabled={!gameId}
                onClick={() => gameId && setTab('trades')}
                title={incomingTradeCount > 0
                  ? `${incomingTradeCount} trade action${incomingTradeCount > 1 ? 's' : ''} pending — offers or unassigned freighters`
                  : 'Trades'}
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
              {tab === 'faction' && gameId && (
                <FactionPanel gameId={gameId} onlineUserIds={onlineUserIds} />
              )}
              {tab === 'comms'   && gameId && (
                <CommsPanel
                  gameId={gameId}
                  onUnreadDelta={(d) => setUnreadMessages((n) => Math.max(0, n + d))}
                  focusFaction={commsFocus}
                />
              )}
              {/* onMessageFaction went with the blocking-coalition
                  section, which was its ONLY consumer — and with it the
                  only thing in the app that deep-linked to a specific
                  faction's DM. CommsPanel still accepts `focusFaction`,
                  so re-wiring it is one prop when something (a message
                  button on the diplomacy roster, most likely) wants it. */}
              {tab === 'senate'  && gameId && <SenatePanel gameId={gameId} />}
              {tab === 'trades'  && gameId && <TradesPanel  gameId={gameId} />}
            </div>
          </>
        )}
      </div>
      )}
    </>
  );
}
