// ============================================================
// RoomLobbyScreen — the room lobby, composed. Presentational: RoomDetail
// (LobbyView.tsx) owns the data, the websocket and every flow and hands them
// down; the dev preview (/?room-lobby) and the tests hand it fixtures.
//
// The order is the point (Claude Design "Room lobby"; the old panel put the
// status, ready button, forms, host controls and roster in one long column
// with no hierarchy):
//
//   1. START card      where we stand, and the one thing to do
//   2. YOUR EMPIRE     calm unless unfinished; Edit opens the editor in place
//   3. PLAYERS         one row each
//   4. GAME RULES      folded, one line
//   5. DISCORD FEED    folded
//   +  CHAT            NOT a fold (it was buried): a dock on the map on a wide
//                      screen, a tab (with a teaser on the Room tab) on a phone
//
// WIDE (>= 900px): the starting-system map is the whole stage, still draggable
// and clickable (tap a free world to claim it), with the room panel docked on
// the right (it can be hidden to see the whole map), the legend a pill at the
// top-left and the chat dock at the bottom-left.
// PHONE: one scrolling page with Room | Chat | Map tabs.
// ============================================================

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomSnapshot } from './api';
import { FEED_LEVEL_LABEL, GameFeedSettings } from './GameFeedSettings';
import type { FeedView } from './GameFeedSettings';
import { LonelyLobbyCard, LONELY_LOBBY_MS } from './InviteCard';
import { LobbyMapPreview } from './LobbyMapPreview';
import { RoomChat } from './RoomChat';
import { RoomChatDock, readChatMin, writeChatMin } from './RoomChatDock';
import { RoomEmpireEditor } from './RoomEmpireEditor';
import type { EmpireEditorProps } from './RoomEmpireEditor';
import { RoomFold } from './RoomFold';
import { RoomMapPane } from './RoomMapPane';
import { RoomMenu } from './RoomMenu';
import type { RoomMenuItem } from './RoomMenu';
import { RoomPlayers } from './RoomPlayers';
import { ClampText, IconBack, IconChat, IconDiscord, IconDots, IconPanel, IconX } from './RoomParts';
import { RoomRules } from './RoomRules';
import type { RulesDraft } from './RoomRules';
import { RoomStartCard } from './RoomStartCard';
import { RoomYourEmpire } from './RoomYourEmpire';
import {
  badgeText, buildEmpire, buildPlayers, buildStartCard, chatTeaser, ruleFacts, unreadCount,
} from './roomLobbyModel';
import type { ChatLine, RoomTab } from './roomLobbyModel';
import './RoomLobby.css';
import { t, tk, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';

// ------------------------------------------------------------ small hooks

/** True from 900px up (the design's breakpoint for the map stage). */
export function useWide(): boolean {
  const query = '(min-width: 900px)';
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(query); } catch { return; }
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return wide;
}

// ------------------------------------------------------------- the header

function RoomHeader({ title, sub, onBack, menu, onHidePanel }: {
  title: string;
  sub: string;
  onBack: () => void;
  menu: RoomMenuItem[];
  /** Wide only: collapse the panel to see the whole map. */
  onHidePanel?: () => void;
}) {
  useI18n();
  return (
    <header className="rl-bar">
      <button
        type="button"
        className="rl-ibtn"
        aria-label={t('roomlobby.header.backAria')}
        title={t('roomlobby.back.tip')}
        onClick={onBack}
      >
        <IconBack />
      </button>
      <div className="rl-bar__ttl">
        <h1>{title}</h1>
        <div className="rl-bar__sub">{sub}</div>
      </div>
      {onHidePanel && (
        <button
          type="button"
          className="rl-ibtn"
          aria-label={t('roomlobby.panel.hide')}
          title={t('roomlobby.panel.hide')}
          onClick={onHidePanel}
        >
          <IconPanel />
        </button>
      )}
      <RoomMenu label={t('roomlobby.header.menu')} icon={<IconDots />} items={menu} />
    </header>
  );
}

function RoomAlert({ error, onDismiss }: { error?: string | null; onDismiss?: () => void }) {
  useI18n();
  if (!error) return null;
  return (
    <div className="rl-alert" role="alert">
      <span>{error}</span>
      {onDismiss && (
        <button type="button" className="rl-ibtn rl-ibtn--sm" aria-label={t('roomlobby.error.dismiss')} onClick={onDismiss}>
          <IconX />
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- the tabs

const TABS: RoomTab[] = ['room', 'chat', 'map'];

function RoomTabs({ tab, onTab, unread }: { tab: RoomTab; onTab: (t: RoomTab) => void; unread: number }) {
  useI18n();
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onTab(TABS[n]);
    requestAnimationFrame(() => document.getElementById(`rl-tab-${TABS[n]}`)?.focus());
  };
  return (
    <div className="rl-tabs" role="tablist" aria-label={t('roomlobby.tabs.aria')} onKeyDown={onKey}>
      {TABS.map((k) => (
        <button
          key={k}
          id={`rl-tab-${k}`}
          type="button"
          role="tab"
          aria-selected={tab === k}
          aria-controls={`rl-pane-${k}`}
          tabIndex={tab === k ? 0 : -1}
          className={`rl-tab ${tab === k ? 'is-on' : ''}`}
          onClick={() => onTab(k)}
        >
          {t(`roomlobby.tab.${k}`)}
          {k === 'chat' && unread > 0 && tab !== 'chat' && (
            <span className="rl-badge" aria-label={tn('roomlobby.chat.unread', unread)}>{badgeText(unread)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// -------------------------------------------------- the phone / plain page

/**
 * A full-viewport scrolling page: a sticky top (the bar, an optional alert and
 * tabs) over a body. Used for the phone layout and for the late-join picker.
 * Portaled to <body>: the lobby is mounted inside the multiplayer dock, whose
 * transform makes it the containing block for anything fixed.
 */
export function RoomPageShell({
  title, sub, onBack, menu, error, onDismissError, tabs, fill, children,
}: {
  title: string;
  sub: string;
  onBack: () => void;
  menu: RoomMenuItem[];
  error?: string | null;
  onDismissError?: () => void;
  tabs?: React.ReactNode;
  /** Chat tab: the body fills the screen and does not scroll (the input is pinned). */
  fill?: boolean;
  children: React.ReactNode;
}) {
  useI18n();
  return createPortal(
    <div className={`rl-root rl-page ${fill ? 'is-fill' : ''}`} role="region" aria-label={title}>
      <div className="rl-top">
        <RoomHeader title={title} sub={sub} onBack={onBack} menu={menu} />
        <RoomAlert error={error} onDismiss={onDismissError} />
        {tabs}
      </div>
      {children}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- the screen

export interface RoomLobbyScreenProps {
  roomId: string;
  snap: RoomSnapshot;
  /** The signed-in user's id (undefined when signed out / not a member). */
  viewerId?: string;
  isHost: boolean;
  started: boolean;
  /** The viewer's ready flag, optimistic-aware. */
  myReady: boolean;
  error: string | null;
  onDismissError: () => void;
  onBack: () => void;
  onLeaveLobby: () => void;
  onDeleteRoom: () => void;
  onStart: () => void;
  onToggleReady: () => void;
  onKick: (userId: string, name: string) => void;
  /** The lonely-lobby card opened the seats: re-read the room. */
  onSeatsOpened: () => void;
  empire: Omit<EmpireEditorProps, 'roomId' | 'snap' | 'myUserId' | 'started'>;
  rules: {
    draft: RulesDraft;
    onDraft: (next: RulesDraft) => void;
    onSave: () => void;
    saved: boolean;
  };
  chat: {
    log: ChatLine[];
    draft: string;
    onDraft: (v: string) => void;
    onSend: (e: React.FormEvent) => void;
  };
  /** Where the screen opens (the dev preview's ?tab= and ?chat=min; real use omits it). */
  initial?: { tab?: RoomTab; chatMin?: boolean };
}

/** The room panel's width on the stage, plus its inset and a gap: the strip of
 *  the map it covers, until it has been measured. */
const DOCK_COVER_FALLBACK = 552;

export function RoomLobbyScreen(p: RoomLobbyScreenProps) {
  useI18n();
  const { snap, viewerId, isHost, started, roomId } = p;
  const wide = useWide();
  const [tab, setTab] = useState<RoomTab>(p.initial?.tab ?? 'room');
  const [empireOpen, setEmpireOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [chatMin, setChatMin] = useState(() => p.initial?.chatMin ?? readChatMin());
  const [chatSeen, setChatSeen] = useState(0);
  const [feed, setFeed] = useState<FeedView | null>(null);
  // setState is stable, so GameFeedSettings' effect fires once per change.
  const onFeedView = useCallback((v: FeedView) => setFeed(v), []);
  const dockRef = useRef<HTMLElement>(null);
  const [cover, setCover] = useState(DOCK_COVER_FALLBACK);

  // The map frames itself into the stage the panel leaves visible.
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!wide || panelHidden || !el) return;
    const measure = () => setCover(Math.round(el.getBoundingClientRect().width) + 32);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wide, panelHidden]);

  // The chat counts as read while it is on screen: the dock open, or its tab.
  const chatVisible = wide ? !chatMin : tab === 'chat';
  useEffect(() => {
    if (chatVisible) setChatSeen(p.chat.log.length);
  }, [chatVisible, p.chat.log.length]);
  const unread = unreadCount(p.chat.log, chatSeen, viewerId);
  const toggleChatMin = () => setChatMin((m) => { writeChatMin(!m); return !m; });

  const players = buildPlayers(snap, viewerId, { ready: p.myReady, worldId: p.empire.myChoice });
  const me = players.find((x) => x.isMe) ?? null;
  const start = buildStartCard({
    players, maxPlayers: snap.settings.max_players, started, currentTick: snap.settings.current_tick,
  });
  const facts = ruleFacts(snap);
  const inviteCode = snap.settings.invite_code ?? null;
  const hasPassword = !!snap.settings.has_password;
  const host = players.find((x) => x.isHost);
  const canPick = !started && !!me;
  const pickOnMap = canPick ? (id: string) => p.empire.onPickBody(id) : undefined;

  const menu: RoomMenuItem[] = [];
  if (!started) {
    menu.push({ key: 'leave', label: t('roomlobby.leaveLobby'), title: t('roomlobby.leaveLobby.tip'), onSelect: p.onLeaveLobby });
  }
  if (isHost) {
    menu.push({ key: 'delete', label: t('roomlobby.deleteRoom'), danger: true, onSelect: p.onDeleteRoom });
  }

  const sub = started
    ? t('roomlobby.status.running', { n: snap.settings.current_tick ?? 0 })
    : t('roomlobby.header.sub', { n: players.length, max: snap.settings.max_players, host: host?.name ?? t('feed.theHost') });

  const feedSummary = feed
    ? (() => {
      const level = tk(`mp.feed.level.${feed.level}`, FEED_LEVEL_LABEL[feed.level]);
      if (!feed.is_host && feed.level === 'off') return level;
      return t(feed.is_host ? 'roomlobby.feed.summaryHost' : 'roomlobby.feed.summaryPlayer', { level });
    })()
    : t('roomlobby.feed.generic');

  const chatBody = (active: boolean, className?: string) => (
    <RoomChat
      log={p.chat.log}
      viewerId={viewerId}
      draft={p.chat.draft}
      onDraft={p.chat.onDraft}
      onSend={p.chat.onSend}
      active={active}
      className={className}
    />
  );

  /** The room panel's cards, in the design's order. */
  const roomCards = (
    <>
      <RoomStartCard
        model={start}
        players={players}
        maxPlayers={snap.settings.max_players}
        facts={facts}
        started={started}
        hasPassword={hasPassword}
        inviteCode={inviteCode}
        roomName={snap.settings.name}
        viewerId={viewerId}
        onStart={p.onStart}
        onToggleReady={p.onToggleReady}
      />

      {/* Chat is one tap away on a phone, with its newest line showing; on a
          wide screen it is the dock on the map and this row is not drawn. */}
      {!wide && (
        <button type="button" className="rl-teaser" onClick={() => setTab('chat')} aria-label={t('roomlobby.chat.open')}>
          <span className="rl-teaser__ic" aria-hidden="true"><IconChat /></span>
          <span className="rl-teaser__lab">
            <b>{t('roomlobby.tab.chat')}</b>
            <span className="rl-fold__clip">{chatTeaser(p.chat.log, viewerId)}</span>
          </span>
          {unread > 0 && <span className="rl-badge" aria-label={tn('roomlobby.chat.unread', unread)}>{badgeText(unread)}</span>}
          <span className="rl-btn rl-btn--sm rl-btn--quiet" aria-hidden="true">{t('roomlobby.chat.openBtn')}</span>
        </button>
      )}

      {isHost && !started && hasPassword && snap.members.length === 1
        && snap.settings.created_at != null && Date.now() - snap.settings.created_at >= LONELY_LOBBY_MS && (
        <LonelyLobbyCard roomId={roomId} onOpened={p.onSeatsOpened} />
      )}

      {snap.custom_map && (
        <section className="rl-panel rl-custom" aria-label={t('roomlobby.customMap')}>
          <div className="rl-eyebrow">{t('roomlobby.customMap')}</div>
          {/* The map's name and pitch are player-written: plain text. */}
          <div className="rl-custom__name">{snap.custom_map.name}</div>
          {snap.custom_map.blurb && <ClampText text={snap.custom_map.blurb} lines={3} className="rl-custom__blurb" />}
        </section>
      )}

      {!started && me && (
        <RoomYourEmpire
          me={me}
          model={buildEmpire(me)}
          open={empireOpen}
          onToggle={() => setEmpireOpen((o) => !o)}
          wide={wide}
          onPickOnMap={() => setTab('map')}
        >
          <RoomEmpireEditor roomId={roomId} snap={snap} myUserId={viewerId} started={started} {...p.empire} />
        </RoomYourEmpire>
      )}

      <RoomPlayers
        players={players}
        maxPlayers={snap.settings.max_players}
        canManage={isHost && !started}
        onKick={p.onKick}
      />

      {!started && (
        <RoomRules
          snap={snap}
          facts={facts}
          isHost={isHost}
          started={started}
          open={rulesOpen}
          onToggle={() => setRulesOpen((o) => !o)}
          draft={p.rules.draft}
          onDraft={p.rules.onDraft}
          onSave={p.rules.onSave}
          onDelete={p.onDeleteRoom}
          saved={p.rules.saved}
        />
      )}

      {/* THE GAME'S DISCORD FEED. Off until the host turns it on; set
          here so a game can start with its feed already running. */}
      {!started && (
        <RoomFold
          icon={<IconDiscord />}
          title={t('roomlobby.feed.title')}
          summary={feedSummary}
          open={feedOpen}
          onToggle={() => setFeedOpen((o) => !o)}
        >
          <div className="rl-foldbody rl-feed">
            <GameFeedSettings gameId={roomId} bare onView={onFeedView} />
          </div>
        </RoomFold>
      )}
    </>
  );

  // ---------------------------------------------------------------- WIDE
  if (wide) {
    return createPortal(
      <>
        {!started && (
          <LobbyMapPreview
            snap={snap} myUserId={viewerId} focusBodyId={p.empire.myChoice}
            className="rl-map" insetRight={panelHidden ? 0 : cover} onPickBody={pickOnMap}
          />
        )}
        <div className={`rl-root rl-stage ${started ? 'is-solid' : ''}`}>
          {panelHidden ? (
            <button
              type="button"
              className="rl-showpanel"
              aria-label={t('roomlobby.panel.show')}
              title={t('roomlobby.panel.show')}
              onClick={() => setPanelHidden(false)}
            >
              <IconPanel />
              <span>{snap.settings.name}</span>
            </button>
          ) : (
            <aside className="rl-dock" ref={dockRef} aria-label={snap.settings.name}>
              <div className="rl-dock__top">
                <RoomHeader
                  title={snap.settings.name} sub={sub} onBack={p.onBack} menu={menu}
                  onHidePanel={() => setPanelHidden(true)}
                />
                <RoomAlert error={p.error} onDismiss={p.onDismissError} />
              </div>
              <div className="rl-dock__scroll">
                <div className="rl-col">{roomCards}</div>
              </div>
            </aside>
          )}
          <RoomChatDock
            log={p.chat.log} viewerId={viewerId} draft={p.chat.draft} onDraft={p.chat.onDraft}
            onSend={p.chat.onSend} inRoom={players.length} minimised={chatMin} onToggle={toggleChatMin} unread={unread}
          />
        </div>
      </>,
      document.body,
    );
  }

  // --------------------------------------------------------------- PHONE
  return (
    <RoomPageShell
      title={snap.settings.name}
      sub={sub}
      onBack={p.onBack}
      menu={menu}
      error={p.error}
      onDismissError={p.onDismissError}
      fill={tab === 'chat'}
      tabs={<RoomTabs tab={tab} onTab={setTab} unread={unread} />}
    >
      <div id="rl-pane-room" role="tabpanel" aria-labelledby="rl-tab-room" hidden={tab !== 'room'} className="rl-layout rl-layout--one">
        <div className="rl-col">{roomCards}</div>
      </div>
      <div id="rl-pane-chat" role="tabpanel" aria-labelledby="rl-tab-chat" hidden={tab !== 'chat'} className="rl-chatpane">
        <div className="rl-chatpane__hd">
          <h2 className="rl-h2">{t('roomlobby.tab.chat')}</h2>
          <span>{t('roomlobby.chat.inRoom', { n: players.length })}</span>
        </div>
        {chatBody(tab === 'chat', 'rl-chat--fill')}
      </div>
      <div id="rl-pane-map" role="tabpanel" aria-labelledby="rl-tab-map" hidden={tab !== 'map'} className="rl-layout rl-layout--one">
        {/* Mounted only while shown: a hidden canvas has no size and its
            draw loop would just spin. */}
        {tab === 'map' && (
          <RoomMapPane snap={snap} viewerId={viewerId} myChoice={p.empire.myChoice} me={started ? null : me} onPickBody={pickOnMap} />
        )}
      </div>
    </RoomPageShell>
  );
}
