import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { useAuth } from './AuthContext';
import { AdminAnalytics } from './AdminAnalytics';
import { DevlogAdmin } from './DevlogAdmin';
import { BotControl } from './BotControl';
import { Editor } from './Editor';
import { ProfilePanel } from './ProfilePanel';
import { GameCard, GameSummary, initials } from './LobbyCards';
import { LobbyStarfield } from './LobbyStarfield';
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
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>(() => {
    // Stripe's success/cancel redirect lands on the SPA root with
    // ?purchase=... — open straight onto the profile tab so the
    // COMMISSION section (which consumes the param) is on screen,
    // instead of dumping the buyer on My Games mid-thank-you. The
    // "Email settings" link in every email lands here the same way.
    const q = new URLSearchParams(window.location.search);
    return q.has('purchase') || q.get('settings') === 'email' ? 'profile' : 'my';
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
    const t = setInterval(refreshMine, 10000);
    return () => clearInterval(t);
  }, [refreshMine]);
  // Browse feeds the hero's numbers too, so it polls on both front tabs.
  const wantsBrowse = tab === 'browse' || tab === 'my';
  useEffect(() => {
    if (!wantsBrowse) return;
    refreshBrowse();
    const t = setInterval(refreshBrowse, 15000);
    return () => clearInterval(t);
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
    else setQuickError(res.error?.message ?? 'Quick join failed. Try again in a moment.');
  }, [onEnterRoom]);

  const displayName = user?.display_name || user?.email || 'Commander';

  return (
    <div className="lx">
      <LobbyStarfield />
      <div className="lx-bg" aria-hidden />
      <header className="lx-top">
        <div className="lx-top__inner">
          <button className="lx-brand" onClick={() => setTab(liveMine && liveMine.length ? 'my' : 'browse')}>
            ORBITAL
          </button>
          <nav className="lx-nav" aria-label="Lobby">
            <NavItem active={tab === 'my'} onClick={() => setTab('my')} badge={liveMine?.length || undefined}>My games</NavItem>
            {pastMine && pastMine.length > 0 && (
              <NavItem active={tab === 'past'} onClick={() => setTab('past')}>Past games</NavItem>
            )}
            <NavItem active={tab === 'browse'} onClick={() => setTab('browse')}>Browse</NavItem>
            <NavItem active={tab === 'create'} onClick={() => setTab('create')}>Create a game</NavItem>
            <NavItem active={tab === 'code'} onClick={() => setTab('code')}>Join with code</NavItem>
            {/* Live-ops tools, allow-listed admins only. Display-only flag;
                every /api/admin route re-checks server-side. */}
            {user?.is_admin && (
              <>
                <span className="lx-nav__sep" aria-hidden />
                <NavItem small active={tab === 'admin'} onClick={() => setTab('admin')}>Analytics</NavItem>
                <NavItem small active={tab === 'bot'} onClick={() => setTab('bot')}>Bot</NavItem>
                <NavItem small active={tab === 'editor'} onClick={() => setTab('editor')}>Editor</NavItem>
                <NavItem small active={tab === 'devlog'} onClick={() => setTab('devlog')}>Devlog</NavItem>
              </>
            )}
          </nav>
          <div className="lx-user">
            <button
              className={`lx-user__chip ${tab === 'profile' ? 'is-active' : ''}`}
              onClick={() => setTab('profile')}
              title="Profile and settings"
            >
              <span className="lx-user__avatar" aria-hidden>{initials(displayName).slice(0, 1)}</span>
              <span className="lx-user__name">{displayName}</span>
            </button>
            <button className="lx-user__out" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="lx-main">
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
  // Quick Join only ever seats you in a PUBLIC game (no password), so the
  // numbers here count only those.
  const openPublic = (browse ?? []).filter(g => g.joinable && !g.has_password && g.phase === 'open');
  const seats = openPublic.reduce((s, g) => s + g.open_seats, 0);
  const live = (browse ?? []).filter(g => g.phase === 'live').length;

  // First real word of the name ("[agent] lobby-review" greets "lobby").
  const first = name.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1)[0] ?? 'Commander';
  const running = (mine ?? []).filter(g => g.phase === 'live').length;
  const waiting = (mine ?? []).filter(g => g.phase === 'open' || g.phase === 'full').length;

  const title = tab === 'my' ? `Welcome back, ${first}` : 'Find a game';
  const sub = tab === 'my'
    ? [running ? `${running} ${running === 1 ? 'game' : 'games'} in progress` : null,
       waiting ? `${waiting} waiting to start` : null].filter(Boolean).join(' · ') || 'Pick up where you left off, or start something new.'
    : browse === null
      ? 'Looking across the Sol system…'
      : `${live} ${live === 1 ? 'game is' : 'games are'} running right now. Join one in progress, or take a seat in a game about to start.`;

  return (
    <section className="lx-hero">
      <div className="lx-hero__text">
        <div className="lx-eyebrow">Multiplayer · the Sol system</div>
        <h1 className="lx-hero__title">{title}</h1>
        <p className="lx-hero__sub">{sub}</p>
        {tab === 'my' && running > 0 && !autoloadSet && (
          <p className="lx-hero__tip">
            Want to skip this page? Switch on <b>Auto-load on launch</b> on a game and Orbital opens straight into it.
          </p>
        )}
      </div>
      <div className="lx-quick">
        <div className="lx-quick__head">
          <span className="lx-quick__label">Quick join</span>
          <span className="lx-quick__meta">
            {browse === null ? '' : seats > 0
              ? `${seats} open ${seats === 1 ? 'seat' : 'seats'} in ${openPublic.length} public ${openPublic.length === 1 ? 'game' : 'games'}`
              : 'No public game is open'}
          </span>
        </div>
        <p className="lx-quick__body">
          {seats > 0
            ? 'We seat you in the public game closest to starting. It begins on its own the moment every seat is filled.'
            : 'We open a fresh game with you as host and four seats for whoever joins next. It starts itself when full.'}
        </p>
        <button className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" onClick={onQuick} disabled={quickBusy}>
          {quickBusy ? 'Finding your game…' : seats > 0 ? 'Quick join' : 'Open a game'}
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
        title="Nothing archived"
        hint="Archive a finished game from My games to file it here. Nothing is deleted: the game and its history are kept."
      />
    ) : (
      <EmptyState
        title="You're not in any games yet"
        hint="Use Quick join above, pick a game from Browse, or create your own."
        action={{ label: 'Browse games', onClick: onBrowse }}
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
      setError(res.error?.message ?? 'Could not change Auto-load.');
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
    if (archived && !window.confirm(
      `Archive "${g.name}"?\n\nIt moves to your Past games tab. Nothing is deleted, and no one `
      + `else's list changes. You can restore it from Past games at any time.`,
    )) return;
    setError(null); setNotice(null);
    setBusyId(g.id);
    const res = await apiFetch(`/api/rooms/${g.id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) });
    setBusyId(null);
    if (!res.ok) { setError(res.error?.message ?? (archived ? 'Could not archive' : 'Could not restore')); return; }
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
    if (!res.ok) { setError(res.error?.message ?? 'Could not publish the Herald'); return; }
    setNotice(res.data.posted
      ? `Herald published: ${res.data.events} event${res.data.events === 1 ? '' : 's'}.`
      : `Not posted: ${res.data.reason ?? 'unknown reason'}`);
  }

  async function deleteRoom(g: GameSummary) {
    if (!window.confirm(`Delete "${g.name}"? This permanently removes the game for everyone in it.`)) return;
    setError(null); setNotice(null);
    setBusyId(g.id);
    const res = await apiFetch(`/api/rooms/${g.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) { setError(res.error?.message ?? 'Could not delete the game'); return; }
    setGone(prev => new Set(prev).add(g.id));
    if (priorityId === g.id) setAutoload(null);
    onChanged();
  }

  const groups: Array<{ title: string; hint?: string; items: GameSummary[] }> = archiveView
    ? [{ title: 'Archived', items: visible }]
    : [
      { title: 'Needs you', hint: 'Full lobbies you host: every seat is taken and only you can start.',
        items: visible.filter(g => g.phase === 'full' && g.host_id === myUserId) },
      { title: 'In progress', items: visible.filter(g => g.phase === 'live') },
      { title: 'Waiting to start', items: visible.filter(g => (g.phase === 'open' || g.phase === 'full') && !(g.phase === 'full' && g.host_id === myUserId)) },
      { title: 'Finished', hint: 'Archive a finished game to tidy it away. Nothing is deleted.', items: visible.filter(g => g.phase === 'finished') },
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
                        <summary className="lx-menu__btn" aria-label={`More actions for ${g.name}`}>⋯</summary>
                        <div className="lx-menu__pop" role="menu">
                          <button role="menuitem" onClick={(e) => { closeMenu(e); setArchived(g, !archiveView); }}>
                            {archiveView ? 'Restore to My games' : 'Archive'}
                          </button>
                          {iHost && g.phase === 'finished' && (
                            <button role="menuitem" onClick={(e) => { closeMenu(e); publishFinalHerald(g); }}>
                              Publish the final Herald
                            </button>
                          )}
                          {iHost && (
                            <button role="menuitem" className="is-danger" onClick={(e) => { closeMenu(e); deleteRoom(g); }}>
                              Delete game
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

type Filter = 'join' | 'live' | 'waiting' | 'finished' | 'all';

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
  const [filter, setFilter] = useState<Filter>('join');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<GameSummary | null>(null);
  const [pwInput, setPwInput] = useState('');

  const games = useMemo(() => listing?.games ?? [], [listing]);
  const counts = useMemo(() => ({
    join: games.filter(g => g.joinable).length,
    live: games.filter(g => g.phase === 'live').length,
    waiting: games.filter(g => g.phase === 'full').length,
    finished: games.filter(g => g.phase === 'finished').length,
    all: games.length,
  }), [games]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pick = (g: GameSummary) =>
      filter === 'join' ? g.joinable
        : filter === 'live' ? g.phase === 'live'
        : filter === 'waiting' ? g.phase === 'full'
        : filter === 'finished' ? g.phase === 'finished'
        : true;
    const match = (g: GameSummary) => !q
      || g.name.toLowerCase().includes(q)
      || g.host_name.toLowerCase().includes(q)
      || g.players.some(p => p.name.toLowerCase().includes(q));
    return games.filter(g => pick(g) && match(g)).sort((a, b) => {
      // Public before private, then lobbies before running games, then the
      // game closest to starting, then the most recent.
      if (filter === 'join' && a.has_password !== b.has_password) return a.has_password ? 1 : -1;
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
        setError(res.error.code === 'bad_password' ? 'That password is not right.' : null);
        return;
      }
      setError(res.error?.message ?? 'Could not join that game.');
      refresh();
      return;
    }
    setPwFor(null);
    onEnter(g.id);
  }

  const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'join', label: 'Open seats' },
    { id: 'live', label: 'In progress' },
    { id: 'waiting', label: 'Waiting for host' },
    { id: 'finished', label: 'Recently finished' },
    { id: 'all', label: 'All' },
  ];

  return (
    <section className="lx-section">
      <div className="lx-toolbar">
        <div className="lx-seg" role="tablist" aria-label="Filter games">
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
            placeholder="Search games, hosts, players"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search games"
          />
        </label>
      </div>

      {error && !pwFor && <div className="lx-error" role="alert">{error}</div>}

      {listing === null ? <LoadingGrid /> : shown.length === 0 ? (
        query ? (
          <EmptyState title="No games match that search" hint="Try a game name, a host, or a player." />
        ) : filter === 'join' ? (
          <EmptyState
            title="No open seats right now"
            hint="Quick join opens a new game with you as host, or create one with your own rules."
            action={{ label: 'Create a game', onClick: onCreate }}
          />
        ) : (
          <EmptyState title="Nothing here right now" hint="Check back soon, or look under Open seats." />
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
            <h2 className="lx-modal__title">This game is private</h2>
            <p className="lx-muted">Enter the password {pwFor.host_name} shared to join “{pwFor.name}”.</p>
            <label className="lx-field">
              <span className="lx-field__label">Password</span>
              <input autoFocus className="lx-input" type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)} />
            </label>
            {error && <div className="lx-error" role="alert">{error}</div>}
            <div className="lx-modal__actions">
              <button type="button" className="lx-btn lx-btn--ghost" onClick={() => setPwFor(null)}>Cancel</button>
              <button type="submit" className="lx-btn lx-btn--primary" disabled={!pwInput}>Join game</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

// ---------- Create ----------

function CreatePanel({ onCreated, hostName }: { onCreated: (id: string) => void; hostName: string }) {
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
    if (!trimmed) { setError('Give your game a name.'); return; }
    if (isPrivate && password.length < 4) { setError('The password needs at least 4 characters.'); return; }
    setBusy(true);
    const res = await apiFetch<{ room: { id: string; invite_code?: string } }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed, max_players: maxPlayers, password: isPrivate ? password : undefined }),
    });
    setBusy(false);
    if (!res.ok) { setError(res.error?.message ?? 'Could not create the game.'); return; }
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
          <h2 className="lx-panel__title">Your game is ready</h2>
          <p className="lx-muted">
            Send friends the invite link, or the code for them to enter under Join with code.
            {isPrivate ? ' They will also need the password.' : ' It is also listed in Browse for anyone to join.'}
          </p>
          {created.invite_code && (
            <button type="button" className="lx-code" onClick={() => copy('code')} title="Copy the code">
              {created.invite_code.match(/.{1,4}/g)?.join('-')}
            </button>
          )}
          <div className="lx-row">
            <button type="button" className="lx-btn lx-btn--ghost" onClick={() => copy('link')}>
              {copied === 'link' ? 'Link copied' : 'Copy invite link'}
            </button>
            <button type="button" className="lx-btn lx-btn--ghost" onClick={() => copy('code')}>
              {copied === 'code' ? 'Code copied' : 'Copy code'}
            </button>
          </div>
          <button className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" onClick={() => onCreated(created.id)}>
            Go to your lobby
          </button>
        </div>
      </section>
    );
  }

  const now = Date.now();
  const preview: GameSummary = {
    id: 'preview', name: name.trim() || 'Your game', phase: 'open', max_players: maxPlayers, member_count: 1,
    open_seats: maxPlayers - 1, has_password: isPrivate, quick_join: false, host_id: 'me', host_name: hostName,
    created_at: now, updated_at: now, started_at: null, completed_at: null, current_tick: null, next_tick_at: null,
    tick_interval_ms: 450000, is_member: false, joinable: true,
    players: [{ name: hostName, is_host: true }], leader: null, winner: null, me: null,
  };

  return (
    <section className="lx-section lx-create">
      <form className="lx-panel" onSubmit={submit}>
        <h2 className="lx-panel__title">Create a game</h2>
        <p className="lx-muted">You host it. You can change the turn speed in the lobby before you start.</p>

        <label className="lx-field">
          <span className="lx-field__label">Game name</span>
          <input
            autoFocus
            className="lx-input"
            type="text"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The Inara Compact"
          />
        </label>

        <div className="lx-field">
          <span className="lx-field__label">Players</span>
          <div className="lx-seg lx-seg--fill" role="radiogroup" aria-label="Players">
            {[2, 3, 4, 5, 6, 7, 8].map(n => (
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
          <span className="lx-field__label">Who can join</span>
          <div className="lx-choice" role="radiogroup" aria-label="Who can join">
            <button type="button" role="radio" aria-checked={!isPrivate}
              className={`lx-choice__opt ${!isPrivate ? 'is-active' : ''}`} onClick={() => setIsPrivate(false)}>
              <span className="lx-choice__title">Public</span>
              <span className="lx-choice__desc">Listed in Browse. Anyone can take a seat.</span>
            </button>
            <button type="button" role="radio" aria-checked={isPrivate}
              className={`lx-choice__opt ${isPrivate ? 'is-active' : ''}`} onClick={() => setIsPrivate(true)}>
              <span className="lx-choice__title">Private</span>
              <span className="lx-choice__desc">Joining needs a password you share.</span>
            </button>
          </div>
        </div>

        {isPrivate && (
          <label className="lx-field">
            <span className="lx-field__label">Password</span>
            <input
              className="lx-input"
              type="text"
              placeholder="At least 4 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={100}
            />
          </label>
        )}

        {error && <div className="lx-error" role="alert">{error}</div>}

        <button type="submit" className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" disabled={busy}>
          {busy ? 'Creating…' : 'Create game'}
        </button>
        <p className="lx-muted lx-small">Next you get an invite link and code to share.</p>
      </form>

      <aside className="lx-create__preview" aria-label="Preview">
        <div className="lx-eyebrow">How it appears in Browse</div>
        <GameCard g={preview} now={now} variant="browse" />
      </aside>
    </section>
  );
}

// ---------- Join with code ----------

function JoinByCodePanel({ onJoined }: { onJoined: (id: string) => void }) {
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
    if (clean.length !== 8) { setError('Invite codes are 8 characters.'); return; }
    setBusy(true);
    const res = await apiFetch<{ ok: true; room_id: string }>('/api/rooms/join-by-code', {
      method: 'POST',
      body: JSON.stringify({ code: clean, password: askPassword ? password : undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error?.code === 'password_required') { setAskPassword(true); setError('This game is private. Enter its password.'); return; }
      if (res.error?.code === 'bad_password') { setError('That password is not right.'); return; }
      setError(res.error?.message ?? 'Could not join.');
      return;
    }
    onJoined(res.data.room_id);
  }

  return (
    <section className="lx-section lx-narrow">
      <form className="lx-panel" onSubmit={submit}>
        <h2 className="lx-panel__title">Join with a code</h2>
        <p className="lx-muted">
          Got an invite? Enter its 8-character code. Capitals don&rsquo;t matter, and codes never
          use 0, 1, I or O, so there is nothing to mix up.
        </p>
        <label className="lx-field">
          <span className="lx-field__label">Invite code</span>
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
            <span className="lx-field__label">Password</span>
            <input className="lx-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="lx-error" role="alert">{error}</div>}
        <button type="submit" className="lx-btn lx-btn--primary lx-btn--lg lx-btn--block" disabled={busy}>
          {busy ? 'Joining…' : 'Join game'}
        </button>
      </form>
    </section>
  );
}

// ---------- shared ----------

function LoadingGrid() {
  return (
    <div className="lx-grid" aria-busy="true" aria-label="Loading games">
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
