import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { useAuth } from './AuthContext';
import { AdminAnalytics } from './AdminAnalytics';
import { DevlogAdmin } from './DevlogAdmin';
import { BotControl } from './BotControl';
import { Editor } from './Editor';
import { ProfilePanel } from './ProfilePanel';
import { ThanksCard } from './CommissionMoments';
import { GameCard, GameSummary, initials, DEFAULT_TICK_INTERVAL_MS } from './LobbyCards';
import { LobbyStarfield } from './LobbyStarfield';
import { t, tn } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';
import { saveLocale } from '../i18n/account';
import './lobby.css';

// Full-screen pre-game lobby: where a signed-in player finds, starts and
// returns to games. Sections:
//   - My games    : your own games, grouped by what they need from you
//   - Browse      : every game you could join or watch, filterable
//   - Create      : host a new game
//   - Join code   : redeem an 8-character invite
// plus Profile and the admin tools. Quick Join sits in the hero above
// My games and Browse.
//
// On success the lobby calls onEnterRoom(roomId) and the parent swaps in
// the room view. The lobby never knows about ticks or game state beyond
// the summaries /api/lobby/browse and /api/lobby/mine hand it.

type Tab = 'my' | 'past' | 'browse' | 'create' | 'code' | 'profile' | 'admin' | 'bot' | 'editor' | 'devlog';

interface Props {
  onEnterRoom: (roomId: string) => void;
}

type Listing = { games: GameSummary[]; now: number; autoload_room_id?: string | null };

export function MultiplayerLobby({ onEnterRoom }: Props) {
  useI18n();
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>(() => {
    // Stripe's success/cancel redirect lands on the SPA root with
    // ?purchase=... — open straight onto the profile tab so the
    // COMMISSION section (which consumes the param) is on screen,
    // instead of dumping the buyer on My Games mid-thank-you. The
    // "Email settings" link in every email lands here the same way.
    const q = new URLSearchParams(window.location.search);
    // A gift code waiting to be redeemed (a gift link, possibly from
    // before signing up) opens there too: the Hangar has it filled in.
    let pendingGift = false;
    try { pendingGift = !!localStorage.getItem('orbital.pendingGift'); } catch { /* blocked */ }
    return q.has('purchase') || q.has('gift') || pendingGift || q.get('settings') === 'email' ? 'profile' : 'my';
  });
  const [mine, setMine] = useState<Listing | null>(null);
  const [browse, setBrowse] = useState<Listing | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  const refreshMine = useCallback(async () => {
    const res = await apiFetch<Listing>('/api/lobby/mine');
    setMine(res.ok ? res.data : { games: [], now: Date.now() });
  }, []);
  const refreshBrowse = useCallback(async () => {
    const res = await apiFetch<Listing>('/api/lobby/browse');
    setBrowse(res.ok ? res.data : { games: [], now: Date.now() });
  }, []);

  useEffect(() => {
    refreshMine();
    const timer = setInterval(refreshMine, 10000);
    return () => clearInterval(timer);
  }, [refreshMine]);
  // Browse feeds the hero's numbers too, so it polls on both front tabs.
  const wantsBrowse = tab === 'browse' || tab === 'my';
  useEffect(() => {
    if (!wantsBrowse) return;
    refreshBrowse();
    const timer = setInterval(refreshBrowse, 15000);
    return () => clearInterval(timer);
  }, [wantsBrowse, refreshBrowse]);

  const liveMine = useMemo(() => mine?.games.filter(g => !g.archived_at_ms) ?? null, [mine]);
  const pastMine = useMemo(() => mine?.games.filter(g => !!g.archived_at_ms) ?? null, [mine]);

  // A player with nothing live lands on Browse rather than an empty list.
  useEffect(() => {
    if (liveMine !== null && liveMine.length === 0 && tab === 'my') setTab('browse');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMine]);

  // One button: the server seats us in the open game closest to starting,
  // or opens a fresh one with us hosting (worker/index.js handleQuickJoin).
  const quickJoin = useCallback(async () => {
    setQuickBusy(true);
    setQuickError(null);
    const res = await apiFetch<{ ok: true; room_id: string }>('/api/rooms/quick-join', { method: 'POST' });
    setQuickBusy(false);
    if (res.ok) onEnterRoom(res.data.room_id);
    else setQuickError(apiErrorText(res.error, 'lobby.quick.failed'));
  }, [onEnterRoom]);

  const displayName = user?.display_name || user?.email || t('lobby.commander');

  return (
    <div className="lx">
      <LobbyStarfield />
      <div className="lx-bg" aria-hidden />
      <header className="lx-top">
        <div className="lx-top__inner">
          <button className="lx-brand" onClick={() => setTab(liveMine && liveMine.length ? 'my' : 'browse')}>
            ORBITAL
          </button>
          <nav className="lx-nav" aria-label={t('lobby.nav.label')}>
            <NavItem active={tab === 'my'} onClick={() => setTab('my')} badge={liveMine?.length || undefined}>{t('lobby.nav.my')}</NavItem>
            {pastMine && pastMine.length > 0 && (
              <NavItem active={tab === 'past'} onClick={() => setTab('past')}>{t('lobby.nav.past')}</NavItem>
            )}
            <NavItem active={tab === 'browse'} onClick={() => setTab('browse')}>{t('lobby.nav.browse')}</NavItem>
            <NavItem active={tab === 'create'} onClick={() => setTab('create')}>{t('lobby.nav.create')}</NavItem>
            <NavItem active={tab === 'code'} onClick={() => setTab('code')}>{t('lobby.nav.code')}</NavItem>
            {/* Live-ops tools, allow-listed admins only. Display-only flag;
                every /api/admin route re-checks server-side. */}
            {user?.is_admin && (
              <>
                <span className="lx-nav__sep" aria-hidden />
                <NavItem small active={tab === 'admin'} onClick={() => setTab('admin')}>{t('lobby.nav.analytics')}</NavItem>
                <NavItem small active={tab === 'bot'} onClick={() => setTab('bot')}>{t('lobby.nav.bot')}</NavItem>
                <NavItem small active={tab === 'editor'} onClick={() => setTab('editor')}>{t('lobby.nav.editor')}</NavItem>
                <NavItem small active={tab === 'devlog'} onClick={() => setTab('devlog')}>{t('lobby.nav.devlog')}</NavItem>
              </>
            )}
          </nav>
          <div className="lx-user">
            <LanguageSwitch compact className="lx-lang" onChosen={saveLocale} />
            <button
              className={`lx-user__chip ${tab === 'profile' ? 'is-active' : ''}`}
              onClick={() => setTab('profile')}
              title={t('lobby.profileTitle')}
            >
              <span className="lx-user__avatar" aria-hidden>{initials(displayName).slice(0, 1)}</span>
              <span className="lx-user__name">{displayName}</span>
            </button>
            <button className="lx-user__out" onClick={signOut}>{t('lobby.signOut')}</button>
          </div>
        </div>
      </header>

      <main className="lx-main">
        {/* The one-time Commission thank-you (20+ hours played). Only
            on the home tabs, never over a game. */}
        {(tab === 'my' || tab === 'browse') && <ThanksCard onSeeHangar={() => setTab('profile')} />}
        {(tab === 'my' || tab === 'browse') && (
          <Hero
            tab={tab}
            name={displayName}
            mine={liveMine}
            browse={browse?.games ?? null}
            autoloadSet={!!mine?.autoload_room_id}
            onQuick={quickJoin}
            quickBusy={quickBusy}
            quickError={quickError}
          />
        )}
        {tab === 'my' && (
          <MyGamesPanel
            games={liveMine}
            autoloadId={mine?.autoload_room_id ?? null}
            now={mine?.now ?? Date.now()}
            onEnter={onEnterRoom}
            onChanged={refreshMine}
            myUserId={user?.id}
            onBrowse={() => setTab('browse')}
          />
        )}
        {tab === 'past' && (
          <MyGamesPanel
            games={pastMine}
            autoloadId={mine?.autoload_room_id ?? null}
            now={mine?.now ?? Date.now()}
            onEnter={onEnterRoom}
            onChanged={refreshMine}
            myUserId={user?.id}
            archiveView
            onBrowse={() => setTab('browse')}
          />
        )}
        {tab === 'browse' && (
          <BrowsePanel
            listing={browse}
            onEnter={onEnterRoom}
            refresh={refreshBrowse}
            onCreate={() => setTab('create')}
            myUserId={user?.id}
          />
        )}
        {tab === 'create' && <CreatePanel onCreated={onEnterRoom} hostName={displayName} />}
        {tab === 'code' && <JoinByCodePanel onJoined={onEnterRoom} />}
        {tab === 'profile' && <div className="lx-legacy"><ProfilePanel onEnterRoom={onEnterRoom} /></div>}
        {tab === 'admin' && user?.is_admin && <div className="lx-legacy lx-legacy--wide"><AdminAnalytics onEnterRoom={onEnterRoom} /></div>}
        {tab === 'bot' && user?.is_admin && <div className="lx-legacy lx-legacy--wide"><BotControl /></div>}
        {tab === 'editor' && user?.is_admin && <div className="lx-legacy lx-legacy--wide"><Editor /></div>}
        {tab === 'devlog' && user?.is_admin && <div className="lx-legacy lx-legacy--wide"><DevlogAdmin /></div>}
      </main>
    </div>
  );
}

function NavItem({
  active, onClick, children, badge, small,
}: { active: boolean; onClick: () => void; children: React.ReactNode; badge?: number; small?: boolean }) {
  return (
    <button
      className={`lx-nav__item ${active ? 'is-active' : ''} ${small ? 'lx-nav__item--small' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {children}
      {badge ? <span className="lx-nav__badge">{badge}</span> : null}
    </button>
  );
}

// ---------- Hero + Quick Join ----------

function Hero({
  tab, name, mine, browse, autoloadSet, onQuick, quickBusy, quickError,
}: {
  tab: 'my' | 'browse';
  name: string;
  mine: GameSummary[] | null;
  browse: GameSummary[] | null;
  autoloadSet: boolean;
  onQuick: () => void;
  quickBusy: boolean;
  quickError: string | null;
}) {
  useI18n();
  // Quick Join only ever seats you in a PUBLIC game (no password), so the
  // numbers here count only those.
  const openPublic = (browse ?? []).filter(g => g.joinable && !g.has_password && g.phase === 'open');
  const seats = openPublic.reduce((s, g) => s + g.open_seats, 0);
  const live = (browse ?? []).filter(g => g.phase === 'live').length;

  // First real word of the name ("[agent] lobby-review" greets "lobby").
  const first = name.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1)[0] ?? t('lobby.commander');
  const running = (mine ?? []).filter(g => g.phase === 'live').length;
  const waiting = (mine ?? []).filter(g => g.phase === 'open' || g.phase === 'full').length;

  const title = tab === 'my' ? t('lobby.hero.welcome', { name: first }) : t('lobby.hero.find');
  const sub = tab === 'my'
    ? [running ? tn('lobby.hero.inProgress', running) : null,
       waiting ? t('lobby.hero.waiting', { n: waiting }) : null].filter(Boolean).join(' · ') || t('lobby.hero.idle')
    : browse === null
      ? t('lobby.hero.looking')
      : tn('lobby.hero.running', live);

  return (
    <section className="lx-hero">
      <div className="lx-hero__text">
        <div className="lx-eyebrow">{t('lobby.hero.eyebrow')}</div>
        <h1 className="lx-hero__title">{title}</h1>
        <p className="lx-hero__sub">{sub}</p>
        {tab === 'my' && running > 0 && !autoloadSet && (
          <p className="lx-hero__tip">
            {t('lobby.hero.tipBefore')}<b>{t('lobby.hero.tipBold')}</b>{t('lobby.hero.tipAfter')}
          </p>
        )}
      </div>
      <div className="lx-quick">
        <div className="lx-quick__head">
          <span className="lx-quick__label">{t('lobby.quick.label')}</span>
          <span className="lx-quick__meta">
            {browse === null ? '' : seats > 0
              ? t('lobby.quick.meta', { seats: tn('lobby.quick.seats', seats), games: tn('lobby.quick.games', openPublic.length) })
              : t('lobby.quick.noneOpen')}
          </span>
        </div>
        <p className="lx-quick__body">
          {seats > 0 ? t('lobby.quick.bodySeat') : t('lobby.quick.bodyNew')}
        </p>
        <button className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" onClick={onQuick} disabled={quickBusy}>
          {quickBusy ? t('lobby.quick.busy') : seats > 0 ? t('lobby.quick.btnJoin') : t('lobby.quick.btnOpen')}
        </button>
        {quickError && <div className="lx-error" role="alert">{quickError}</div>}
      </div>
    </section>
  );
}

// ---------- My games ----------


function MyGamesPanel({
  games, autoloadId, now, onEnter, onChanged, myUserId, archiveView, onBrowse,
}: {
  games: GameSummary[] | null;
  /** The game Orbital opens on launch (users.autoload_room_id). */
  autoloadId: string | null;
  now: number;
  onEnter: (id: string) => void;
  onChanged: () => void;
  myUserId?: string;
  /** Past games: RESTORE instead of ARCHIVE, and an empty state that
   *  explains the shelf rather than telling the player to go join. */
  archiveView?: boolean;
  onBrowse: () => void;
}) {
  useI18n();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Optimistic: a deleted card disappears at once instead of lingering
  // until the next poll.
  const [gone, setGone] = useState<Set<string>>(new Set());
  // Optimistic copy of the account's Auto-load game, so the switch moves
  // the moment it is pressed; undefined = follow the server's value.
  const [autoloadLocal, setAutoloadLocal] = useState<string | null | undefined>(undefined);
  const [autoBusy, setAutoBusy] = useState(false);
  const priorityId = autoloadLocal === undefined ? autoloadId : autoloadLocal;

  if (games === null) return <LoadingGrid />;
  const visible = games.filter(g => !gone.has(g.id));

  if (visible.length === 0) {
    return archiveView ? (
      <EmptyState
        title={t('lobby.my.emptyArchivedTitle')}
        hint={t('lobby.my.emptyArchivedHint')}
      />
    ) : (
      <EmptyState
        title={t('lobby.my.emptyTitle')}
        hint={t('lobby.my.emptyHint')}
        action={{ label: t('lobby.my.browseGames'), onClick: onBrowse }}
      />
    );
  }

  function closeMenu(e: React.MouseEvent) {
    (e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
  }

  // Auto-load: only one game can open on launch, so switching one on
  // switches any other off. Stored on the account, so it follows the
  // player from browser to phone app.
  async function setAutoload(roomId: string | null) {
    setError(null);
    const before = priorityId;
    setAutoloadLocal(roomId);
    setAutoBusy(true);
    const res = await apiFetch('/api/users/me/autoload', { method: 'PUT', body: JSON.stringify({ room_id: roomId }) });
    setAutoBusy(false);
    if (!res.ok) {
      setAutoloadLocal(before);
      setError(apiErrorText(res.error, 'lobby.my.err.autoload'));
      return;
    }
    onChanged();
  }

  // Archive / restore. Per-member and non-destructive: the room, the game
  // and every analytics table stay as they are.
  async function setArchived(g: GameSummary, archived: boolean) {
    // A player archived a lobby he was waiting to start, three minutes
    // before asking why the game had "become a past game". The prompt
    // answers what he had no way to know: nothing is deleted, only HE is
    // affected, and it is reversible from a named tab.
    if (archived && !window.confirm(t('lobby.my.confirmArchive', { name: g.name }))) return;
    setError(null); setNotice(null);
    setBusyId(g.id);
    const res = await apiFetch(`/api/rooms/${g.id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) });
    setBusyId(null);
    if (!res.ok) { setError(apiErrorText(res.error, archived ? 'lobby.my.err.archive' : 'lobby.my.err.restore')); return; }
    if (archived && priorityId === g.id) setAutoload(null);
    onChanged();
  }

  // A FINISHED game's final Herald, from the lobby: the in-game control is
  // behind the GAME OVER overlay exactly when a final edition is wanted.
  async function publishFinalHerald(g: GameSummary) {
    setError(null); setNotice(null);
    setBusyId(g.id);
    const res = await apiFetch<{ posted: boolean; events: number; reason?: string }>(
      `/api/games/${g.id}/admin/digest-now`, { method: 'POST' },
    );
    setBusyId(null);
    if (!res.ok) { setError(apiErrorText(res.error, 'lobby.my.err.herald')); return; }
    setNotice(res.data.posted
      ? tn('lobby.my.heraldPublished', res.data.events)
      : t('lobby.my.heraldNot', { reason: res.data.reason ?? t('lobby.my.unknownReason') }));
  }

  async function deleteRoom(g: GameSummary) {
    if (!window.confirm(t('lobby.my.confirmDelete', { name: g.name }))) return;
    setError(null); setNotice(null);
    setBusyId(g.id);
    const res = await apiFetch(`/api/rooms/${g.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) { setError(apiErrorText(res.error, 'lobby.my.err.delete')); return; }
    setGone(prev => new Set(prev).add(g.id));
    if (priorityId === g.id) setAutoload(null);
    onChanged();
  }

  const groups: Array<{ title: string; hint?: string; items: GameSummary[] }> = archiveView
    ? [{ title: t('lobby.my.group.archived'), items: visible }]
    : [
      { title: t('lobby.my.group.needs'), hint: t('lobby.my.group.needsHint'),
        items: visible.filter(g => g.phase === 'full' && g.host_id === myUserId) },
      { title: t('lobby.my.group.live'), items: visible.filter(g => g.phase === 'live') },
      { title: t('lobby.my.group.waiting'), items: visible.filter(g => (g.phase === 'open' || g.phase === 'full') && !(g.phase === 'full' && g.host_id === myUserId)) },
      { title: t('lobby.my.group.finished'), hint: t('lobby.my.group.finishedHint'), items: visible.filter(g => g.phase === 'finished') },
    ];

  return (
    <section className="lx-section">
      {(error || notice) && <div className={error ? 'lx-error' : 'lx-notice'} role="status">{error ?? notice}</div>}
      {groups.filter(gr => gr.items.length > 0).map(gr => (
        <div className="lx-group" key={gr.title}>
          <div className="lx-group__head">
            <h2 className="lx-group__title">{gr.title}<span className="lx-group__count">{gr.items.length}</span></h2>
            {gr.hint && <p className="lx-group__hint">{gr.hint}</p>}
          </div>
          <div className="lx-grid">
            {[...gr.items]
              .sort((a, b) => (b.id === priorityId ? 1 : 0) - (a.id === priorityId ? 1 : 0))
              .map(g => {
                const iHost = !!myUserId && g.host_id === myUserId;
                const pinned = priorityId === g.id;
                return (
                  <GameCard
                    key={g.id}
                    g={g}
                    now={now}
                    variant="mine"
                    myUserId={myUserId}
                    busy={busyId === g.id}
                    pinned={pinned}
                    autoload={!archiveView && g.phase === 'live'
                      ? { on: pinned, busy: autoBusy, onToggle: () => setAutoload(pinned ? null : g.id) }
                      : undefined}
                    onPrimary={() => onEnter(g.id)}
                    menu={(
                      <details className="lx-menu">
                        <summary className="lx-menu__btn" aria-label={t('lobby.my.moreActions', { name: g.name })}>⋯</summary>
                        <div className="lx-menu__pop" role="menu">
                          <button role="menuitem" onClick={(e) => { closeMenu(e); setArchived(g, !archiveView); }}>
                            {archiveView ? t('lobby.my.restore') : t('lobby.my.archive')}
                          </button>
                          {iHost && g.phase === 'finished' && (
                            <button role="menuitem" onClick={(e) => { closeMenu(e); publishFinalHerald(g); }}>
                              {t('lobby.my.publishHerald')}
                            </button>
                          )}
                          {iHost && (
                            <button role="menuitem" className="is-danger" onClick={(e) => { closeMenu(e); deleteRoom(g); }}>
                              {t('lobby.my.delete')}
                            </button>
                          )}
                        </div>
                      </details>
                    )}
                  />
                );
              })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------- Browse ----------

type Filter = 'join' | 'private' | 'live' | 'waiting' | 'finished' | 'all';

const PHASE_ORDER = { open: 0, live: 1, full: 2, finished: 3 } as const;

function BrowsePanel({
  listing, onEnter, refresh, onCreate, myUserId,
}: {
  listing: Listing | null;
  onEnter: (id: string) => void;
  refresh: () => void;
  onCreate: () => void;
  myUserId?: string;
}) {
  useI18n();
  const [filter, setFilter] = useState<Filter>('join');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<GameSummary | null>(null);
  const [pwInput, setPwInput] = useState('');

  const games = useMemo(() => listing?.games ?? [], [listing]);
  const counts = useMemo(() => ({
    // Open seats means seats anyone can take. Password games are their
    // own list: without the password there is nothing to join.
    join: games.filter(g => g.joinable && !g.has_password).length,
    private: games.filter(g => g.joinable && g.has_password).length,
    live: games.filter(g => g.phase === 'live').length,
    waiting: games.filter(g => g.phase === 'full').length,
    finished: games.filter(g => g.phase === 'finished').length,
    all: games.length,
  }), [games]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pick = (g: GameSummary) =>
      filter === 'join' ? g.joinable && !g.has_password
        : filter === 'private' ? g.joinable && g.has_password
        : filter === 'live' ? g.phase === 'live'
        : filter === 'waiting' ? g.phase === 'full'
        : filter === 'finished' ? g.phase === 'finished'
        : true;
    const match = (g: GameSummary) => !q
      || g.name.toLowerCase().includes(q)
      || g.host_name.toLowerCase().includes(q)
      || g.players.some(p => p.name.toLowerCase().includes(q));
    return games.filter(g => pick(g) && match(g)).sort((a, b) => {
      // Lobbies before running games, then the game closest to starting,
      // then the most recent.
      if (a.phase !== b.phase) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
      if (a.phase === 'open' && a.open_seats !== b.open_seats) return a.open_seats - b.open_seats;
      if (a.phase === 'live') return (b.started_at ?? 0) - (a.started_at ?? 0);
      return (b.updated_at ?? 0) - (a.updated_at ?? 0);
    });
  }, [games, filter, query]);

  async function attemptJoin(g: GameSummary, password?: string) {
    if (g.is_member) { onEnter(g.id); return; }
    setError(null);
    setJoiningId(g.id);
    const res = await apiFetch(`/api/rooms/${g.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ password: password ?? undefined }),
    });
    setJoiningId(null);
    if (!res.ok) {
      if (res.error?.code === 'password_required' || res.error?.code === 'bad_password') {
        setPwFor(g);
        if (res.error.code === 'password_required') setPwInput('');
        setError(res.error.code === 'bad_password' ? t('err.bad_password') : null);
        return;
      }
      setError(apiErrorText(res.error, 'lobby.browse.err.join'));
      refresh();
      return;
    }
    setPwFor(null);
    onEnter(g.id);
  }

  const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'join', label: t('lobby.browse.filter.join') },
    { id: 'private', label: t('lobby.browse.filter.private') },
    { id: 'live', label: t('lobby.browse.filter.live') },
    { id: 'waiting', label: t('lobby.browse.filter.waiting') },
    { id: 'finished', label: t('lobby.browse.filter.finished') },
    { id: 'all', label: t('lobby.browse.filter.all') },
  ];

  return (
    <section className="lx-section">
      <div className="lx-toolbar">
        <div className="lx-seg" role="tablist" aria-label={t('lobby.browse.filterLabel')}>
          {FILTERS.filter(f => f.id === 'join' || f.id === 'all' || counts[f.id] > 0).map(f => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={`lx-seg__opt ${filter === f.id ? 'is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}<span className="lx-seg__n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <label className="lx-search">
          <span className="lx-search__icon" aria-hidden>⌕</span>
          <input
            type="search"
            placeholder={t('lobby.browse.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('lobby.browse.searchLabel')}
          />
        </label>
      </div>

      {error && !pwFor && <div className="lx-error" role="alert">{error}</div>}

      {listing === null ? <LoadingGrid /> : shown.length === 0 ? (
        query ? (
          <EmptyState title={t('lobby.browse.noMatchTitle')} hint={t('lobby.browse.noMatchHint')} />
        ) : filter === 'join' ? (
          <EmptyState
            title={t('lobby.browse.noSeatsTitle')}
            hint={t('lobby.browse.noSeatsHint')}
            action={{ label: t('lobby.browse.createBtn'), onClick: onCreate }}
          />
        ) : (
          <EmptyState title={t('lobby.browse.nothingTitle')} hint={t('lobby.browse.nothingHint')} />
        )
      ) : (
        <div className="lx-grid">
          {shown.map(g => (
            <GameCard
              key={g.id}
              g={g}
              now={listing.now}
              variant="browse"
              myUserId={myUserId}
              busy={joiningId === g.id}
              onPrimary={() => attemptJoin(g)}
            />
          ))}
        </div>
      )}

      {pwFor && (
        <div className="lx-modal" onClick={() => setPwFor(null)}>
          <form
            className="lx-modal__card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); attemptJoin(pwFor, pwInput); }}
          >
            <h2 className="lx-modal__title">{t('lobby.browse.pwTitle')}</h2>
            <p className="lx-muted">{t('lobby.browse.pwBody', { host: pwFor.host_name, name: pwFor.name })}</p>
            <label className="lx-field">
              <span className="lx-field__label">{t('common.password')}</span>
              <input autoFocus className="lx-input" type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)} />
            </label>
            {error && <div className="lx-error" role="alert">{error}</div>}
            <div className="lx-modal__actions">
              <button type="button" className="lx-btn lx-btn--ghost" onClick={() => setPwFor(null)}>{t('common.cancel')}</button>
              <button type="submit" className="lx-btn lx-btn--primary" disabled={!pwInput}>{t('lobby.browse.joinGame')}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

// ---------- Create ----------

function CreatePanel({ onCreated, hostName }: { onCreated: (id: string) => void; hostName: string }) {
  useI18n();
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; invite_code?: string | null } | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError(t('lobby.create.err.name')); return; }
    if (isPrivate && password.length < 4) { setError(t('lobby.create.err.pw')); return; }
    setBusy(true);
    const res = await apiFetch<{ room: { id: string; invite_code?: string } }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed, max_players: maxPlayers, password: isPrivate ? password : undefined }),
    });
    setBusy(false);
    if (!res.ok) { setError(apiErrorText(res.error, 'lobby.create.err.failed')); return; }
    setCreated({ id: res.data.room.id, invite_code: res.data.room.invite_code });
  }

  function copy(what: 'code' | 'link') {
    if (!created?.invite_code) return;
    const text = what === 'code' ? created.invite_code : `${window.location.origin}?invite=${created.invite_code}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    }).catch(() => { /* clipboard blocked: the code is on screen */ });
  }

  if (created) {
    return (
      <section className="lx-section lx-narrow">
        <div className="lx-panel lx-success">
          <div className="lx-success__badge" aria-hidden>✓</div>
          <h2 className="lx-panel__title">{t('lobby.create.doneTitle')}</h2>
          <p className="lx-muted">
            {t('lobby.create.doneBody')}
            {isPrivate ? t('lobby.create.donePrivate') : t('lobby.create.donePublic')}
          </p>
          {created.invite_code && (
            <button type="button" className="lx-code" onClick={() => copy('code')} title={t('lobby.create.copyCodeTitle')}>
              {created.invite_code.match(/.{1,4}/g)?.join('-')}
            </button>
          )}
          <div className="lx-row">
            <button type="button" className="lx-btn lx-btn--ghost" onClick={() => copy('link')}>
              {copied === 'link' ? t('lobby.create.linkCopied') : t('lobby.create.copyLink')}
            </button>
            <button type="button" className="lx-btn lx-btn--ghost" onClick={() => copy('code')}>
              {copied === 'code' ? t('lobby.create.codeCopied') : t('lobby.create.copyCode')}
            </button>
          </div>
          <button className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" onClick={() => onCreated(created.id)}>
            {t('lobby.create.goLobby')}
          </button>
        </div>
      </section>
    );
  }

  const now = Date.now();
  const preview: GameSummary = {
    id: 'preview', name: name.trim() || t('lobby.create.previewName'), phase: 'open', max_players: maxPlayers, member_count: 1,
    open_seats: maxPlayers - 1, has_password: isPrivate, quick_join: false, host_id: 'me', host_name: hostName,
    created_at: now, updated_at: now, started_at: null, completed_at: null, current_tick: null, next_tick_at: null,
    tick_interval_ms: DEFAULT_TICK_INTERVAL_MS, is_member: false, joinable: true,
    players: [{ name: hostName, is_host: true }], leader: null, winner: null, me: null,
  };

  return (
    <section className="lx-section lx-create">
      <form className="lx-panel" onSubmit={submit}>
        <h2 className="lx-panel__title">{t('lobby.create.title')}</h2>
        <p className="lx-muted">{t('lobby.create.intro')}</p>

        <label className="lx-field">
          <span className="lx-field__label">{t('lobby.create.nameLabel')}</span>
          <input
            autoFocus
            className="lx-input"
            type="text"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('lobby.create.namePlaceholder')}
          />
        </label>

        <div className="lx-field">
          <span className="lx-field__label">{t('lobby.create.players')}</span>
          <div className="lx-seg lx-seg--fill" role="radiogroup" aria-label={t('lobby.create.players')}>
            {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
              <button
                type="button"
                key={n}
                role="radio"
                aria-checked={maxPlayers === n}
                className={`lx-seg__opt ${maxPlayers === n ? 'is-active' : ''}`}
                onClick={() => setMaxPlayers(n)}
              >{n}</button>
            ))}
          </div>
        </div>

        <div className="lx-field">
          <span className="lx-field__label">{t('lobby.create.who')}</span>
          <div className="lx-choice" role="radiogroup" aria-label={t('lobby.create.who')}>
            <button type="button" role="radio" aria-checked={!isPrivate}
              className={`lx-choice__opt ${!isPrivate ? 'is-active' : ''}`} onClick={() => setIsPrivate(false)}>
              <span className="lx-choice__title">{t('lobby.create.public')}</span>
              <span className="lx-choice__desc">{t('lobby.create.publicDesc')}</span>
            </button>
            <button type="button" role="radio" aria-checked={isPrivate}
              className={`lx-choice__opt ${isPrivate ? 'is-active' : ''}`} onClick={() => setIsPrivate(true)}>
              <span className="lx-choice__title">{t('lobby.create.private')}</span>
              <span className="lx-choice__desc">{t('lobby.create.privateDesc')}</span>
            </button>
          </div>
        </div>

        {isPrivate && (
          <label className="lx-field">
            <span className="lx-field__label">{t('common.password')}</span>
            <input
              className="lx-input"
              type="text"
              placeholder={t('lobby.create.pwPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={100}
            />
          </label>
        )}

        {error && <div className="lx-error" role="alert">{error}</div>}

        <button type="submit" className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" disabled={busy}>
          {busy ? t('lobby.create.busy') : t('lobby.create.submit')}
        </button>
        <p className="lx-muted lx-small">{t('lobby.create.next')}</p>
      </form>

      <aside className="lx-create__preview" aria-label="Preview">
        <div className="lx-eyebrow">{t('lobby.create.previewTitle')}</div>
        <GameCard g={preview} now={now} variant="browse" />
      </aside>
    </section>
  );
}

// ---------- Join with code ----------

function JoinByCodePanel({ onJoined }: { onJoined: (id: string) => void }) {
  useI18n();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Share links land here pre-filled (?invite=XXXX).
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get('invite');
    if (invite) setCode(invite.toUpperCase());
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const clean = code.replace(/[^A-Z2-9]/gi, '').toUpperCase();
    if (clean.length !== 8) { setError(t('lobby.join.err.length')); return; }
    setBusy(true);
    const res = await apiFetch<{ ok: true; room_id: string }>('/api/rooms/join-by-code', {
      method: 'POST',
      body: JSON.stringify({ code: clean, password: askPassword ? password : undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error?.code === 'password_required') { setAskPassword(true); setError(t('err.password_required')); return; }
      if (res.error?.code === 'bad_password') { setError(t('err.bad_password')); return; }
      setError(apiErrorText(res.error, 'lobby.join.err.failed'));
      return;
    }
    onJoined(res.data.room_id);
  }

  return (
    <section className="lx-section lx-narrow">
      <form className="lx-panel" onSubmit={submit}>
        <h2 className="lx-panel__title">{t('lobby.join.title')}</h2>
        <p className="lx-muted">{t('lobby.join.intro')}</p>
        <label className="lx-field">
          <span className="lx-field__label">{t('lobby.join.codeLabel')}</span>
          <input
            autoFocus
            className="lx-input lx-input--code"
            type="text"
            value={code}
            maxLength={11}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {askPassword && (
          <label className="lx-field">
            <span className="lx-field__label">{t('common.password')}</span>
            <input className="lx-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="lx-error" role="alert">{error}</div>}
        <button type="submit" className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" disabled={busy}>
          {busy ? t('lobby.join.busy') : t('lobby.join.submit')}
        </button>
      </form>
    </section>
  );
}

// ---------- shared ----------

function LoadingGrid() {
  useI18n();
  return (
    <div className="lx-grid" aria-busy="true" aria-label={t('common.loadingGames')}>
      {[0, 1, 2].map(i => <div key={i} className="lx-card lx-card--skeleton" />)}
    </div>
  );
}

function EmptyState({ title, hint, action }: { title: string; hint: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="lx-empty">
      <div className="lx-empty__orbit" aria-hidden><span /></div>
      <h3 className="lx-empty__title">{title}</h3>
      <p className="lx-empty__hint">{hint}</p>
      {action && <button className="lx-btn lx-btn--ghost" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
