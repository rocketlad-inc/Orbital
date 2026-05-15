import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, RoomSummary } from './api';
import { useAuth } from './AuthContext';

// Full-screen pre-game lobby. The player picks one of four sections:
//   - My Games   : resume rooms they've already joined
//   - Browse     : list of open public rooms
//   - Create     : host a new room (name, max players, optional password)
//   - Join Code  : enter an 8-char invite code
//
// On success the lobby invokes onEnterRoom(roomId) and the parent swaps
// in the room-detail view. The lobby itself never knows about ticks or
// game state — it's just the discovery / setup phase.

type Tab = 'my' | 'browse' | 'create' | 'code';

interface Props {
  onEnterRoom: (roomId: string) => void;
  onExit: () => void;
}

export function MultiplayerLobby({ onEnterRoom, onExit }: Props) {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('my');
  const [myRooms, setMyRooms] = useState<RoomSummary[] | null>(null);

  const refreshMyRooms = useCallback(async () => {
    const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/users/me/rooms');
    if (res.ok) setMyRooms(res.data.rooms);
    else setMyRooms([]);
  }, []);

  useEffect(() => {
    refreshMyRooms();
    const t = setInterval(refreshMyRooms, 8000);
    return () => clearInterval(t);
  }, [refreshMyRooms]);

  // Default to "Browse" if user has no joined rooms — a cleaner first-time
  // experience than landing on an empty list.
  useEffect(() => {
    if (myRooms !== null && myRooms.length === 0 && tab === 'my') {
      setTab('browse');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myRooms]);

  return (
    <div className="mp-lobby">
      <header className="mp-lobby__top">
        <div className="mp-lobby__brand">
          <span className="mp-lobby__brand-name">ORBITAL</span>
          <span className="mp-lobby__brand-mode">MULTIPLAYER</span>
        </div>
        <div className="mp-lobby__user">
          <span className="mp-lobby__user-name">{user?.display_name || user?.email}</span>
          <button className="mp-lobby__user-btn" onClick={onExit}>← Menu</button>
          <button className="mp-lobby__user-btn" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <nav className="mp-lobby__tabs">
        <TabButton active={tab === 'my'} onClick={() => setTab('my')}>
          My Games
          {myRooms && myRooms.length > 0 && (
            <span className="mp-lobby__tab-badge">{myRooms.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>Browse</TabButton>
        <TabButton active={tab === 'create'} onClick={() => setTab('create')}>Create Room</TabButton>
        <TabButton active={tab === 'code'} onClick={() => setTab('code')}>Join by Code</TabButton>
      </nav>

      <main className="mp-lobby__main">
        {tab === 'my'     && <MyGamesPanel rooms={myRooms} onEnter={onEnterRoom} />}
        {tab === 'browse' && <BrowsePanel onEnter={onEnterRoom} />}
        {tab === 'create' && <CreatePanel onCreated={onEnterRoom} />}
        {tab === 'code'   && <JoinByCodePanel onJoined={onEnterRoom} />}
      </main>
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`mp-lobby__tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------- My Games ----------

function MyGamesPanel({
  rooms, onEnter,
}: { rooms: RoomSummary[] | null; onEnter: (id: string) => void }) {
  if (rooms === null) {
    return <div className="mp-lobby__loading">Loading…</div>;
  }
  if (rooms.length === 0) {
    return (
      <EmptyState
        title="You haven't joined any games yet"
        hint="Browse open rooms, create your own, or paste an invite code from a friend."
      />
    );
  }
  // Sort: active games first, then lobby, then anything else.
  const sorted = [...rooms].sort((a, b) => {
    const score = (r: RoomSummary) =>
      r.game_status === 'active' ? 0 : r.game_status ? 1 : 2;
    return score(a) - score(b);
  });
  return (
    <section className="mp-lobby__section">
      <div className="mp-lobby__section-title">Resume your campaigns</div>
      <div className="mp-room-grid">
        {sorted.map(r => <RoomCard key={r.id} room={r} onClick={() => onEnter(r.id)} variant="my" />)}
      </div>
    </section>
  );
}

// ---------- Browse ----------

function BrowsePanel({ onEnter }: { onEnter: (id: string) => void }) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [pwPromptFor, setPwPromptFor] = useState<RoomSummary | null>(null);
  const [pwInput, setPwInput] = useState('');

  const refresh = useCallback(async () => {
    const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/rooms');
    if (res.ok) setRooms(res.data.rooms);
    else setRooms([]);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function attemptJoin(room: RoomSummary, password?: string) {
    setError(null);
    setJoiningId(room.id);
    const res = await apiFetch(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ password: password ?? undefined }),
    });
    setJoiningId(null);
    if (!res.ok) {
      if (res.error?.code === 'password_required' || res.error?.code === 'bad_password') {
        setPwPromptFor(room);
        setPwInput('');
        setError(res.error.code === 'bad_password' ? 'Incorrect password' : null);
        return;
      }
      setError(res.error?.message ?? 'Could not join');
      return;
    }
    setPwPromptFor(null);
    onEnter(room.id);
  }

  if (rooms === null) return <div className="mp-lobby__loading">Loading…</div>;

  return (
    <section className="mp-lobby__section">
      <div className="mp-lobby__section-head">
        <div className="mp-lobby__section-title">Open rooms</div>
        <button className="mp-lobby__refresh" onClick={refresh} title="Refresh">↻</button>
      </div>

      {rooms.length === 0 ? (
        <EmptyState
          title="No open rooms right now"
          hint="Be the first — switch to Create Room and host a new game."
        />
      ) : (
        <div className="mp-room-grid">
          {rooms.map(r => (
            <RoomCard
              key={r.id}
              room={r}
              onClick={() => attemptJoin(r)}
              variant="browse"
              loading={joiningId === r.id}
            />
          ))}
        </div>
      )}

      {pwPromptFor && (
        <div className="mp-modal-backdrop" onClick={() => setPwPromptFor(null)}>
          <form
            className="mp-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); attemptJoin(pwPromptFor, pwInput); }}
          >
            <div className="mp-modal__title">Password required</div>
            <div className="mp-modal__desc">"{pwPromptFor.name}" is password-protected.</div>
            <label className="mp-label">Password</label>
            <input
              autoFocus
              className="mp-input"
              type="password"
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
            />
            <div className="mp-error">{error || ''}</div>
            <div className="mp-modal__actions">
              <button type="button" className="mp-btn mp-btn--ghost" onClick={() => setPwPromptFor(null)}>Cancel</button>
              <button type="submit" className="mp-btn mp-btn--primary" disabled={!pwInput}>Join</button>
            </div>
          </form>
        </div>
      )}

      {error && !pwPromptFor && <div className="mp-error">{error}</div>}
    </section>
  );
}

// ---------- Create ----------

function CreatePanel({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; invite_code?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError('Room name is required'); return; }
    if (usePassword && password.length < 4) {
      setError('Password must be at least 4 characters'); return;
    }
    setBusy(true);
    const res = await apiFetch<{ room: { id: string; invite_code?: string } }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: trimmed,
        max_players: maxPlayers,
        password: usePassword ? password : undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(res.error?.message ?? 'Could not create'); return; }
    setCreated({ id: res.data.room.id, invite_code: res.data.room.invite_code });
  }

  function copyCode() {
    if (!created?.invite_code) return;
    navigator.clipboard.writeText(created.invite_code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore */ });
  }

  function copyLink() {
    if (!created?.invite_code) return;
    const url = `${window.location.origin}?invite=${created.invite_code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore */ });
  }

  if (created) {
    return (
      <section className="mp-lobby__section">
        <div className="mp-create-success">
          <div className="mp-create-success__title">Room created</div>
          <div className="mp-create-success__desc">
            Share the invite code below with friends. They'll find it in the
            "Join by Code" tab.
          </div>

          {created.invite_code && (
            <div className="mp-invite-block">
              <div className="mp-invite-block__label">INVITE CODE</div>
              <div className="mp-invite-block__code" onClick={copyCode}>
                {created.invite_code.match(/.{1,4}/g)?.join('-')}
              </div>
              <div className="mp-invite-block__hint">
                {copied ? '✓ Copied to clipboard' : 'Click code to copy'}
              </div>
              <div className="mp-invite-block__actions">
                <button type="button" className="mp-btn mp-btn--ghost" onClick={copyCode}>Copy code</button>
                <button type="button" className="mp-btn mp-btn--ghost" onClick={copyLink}>Copy share link</button>
              </div>
            </div>
          )}

          <button className="mp-btn mp-btn--primary mp-btn--block" onClick={() => onCreated(created.id)}>
            Enter Room →
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mp-lobby__section">
      <form className="mp-create-form" onSubmit={submit}>
        <div className="mp-lobby__section-title">Host a new game</div>

        <label className="mp-label">Room name</label>
        <input
          autoFocus
          className="mp-input"
          type="text"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. The Inara Compact"
        />

        <label className="mp-label">Max players</label>
        <div className="mp-pill-row">
          {[2, 3, 4, 5, 6, 7, 8].map(n => (
            <button
              type="button"
              key={n}
              className={`mp-pill ${maxPlayers === n ? 'is-active' : ''}`}
              onClick={() => setMaxPlayers(n)}
            >{n}</button>
          ))}
        </div>

        <label className="mp-toggle">
          <input
            type="checkbox"
            checked={usePassword}
            onChange={(e) => setUsePassword(e.target.checked)}
          />
          <span>Password-protect this room</span>
        </label>
        {usePassword && (
          <input
            className="mp-input"
            type="text"
            placeholder="Password (min. 4 chars, shared with invitees)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={100}
          />
        )}

        <div className="mp-error">{error || ''}</div>

        <button type="submit" className="mp-btn mp-btn--primary mp-btn--block" disabled={busy}>
          {busy ? 'Creating…' : 'Create Room'}
        </button>
        <div className="mp-create-form__footnote">
          You'll get a shareable invite code on the next screen.
        </div>
      </form>
    </section>
  );
}

// ---------- Join by code ----------

function JoinByCodePanel({ onJoined }: { onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fill from `?invite=XXXX` query param (so share links land here pre-filled).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (invite) setCode(invite.toUpperCase());
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const clean = code.replace(/[^A-Z2-9]/gi, '').toUpperCase();
    if (clean.length !== 8) { setError('Invite codes are 8 characters'); return; }
    setBusy(true);
    const res = await apiFetch<{ ok: true; room_id: string }>('/api/rooms/join-by-code', {
      method: 'POST',
      body: JSON.stringify({ code: clean, password: askPassword ? password : undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error?.code === 'password_required') {
        setAskPassword(true);
        setError('This room requires a password');
        return;
      }
      if (res.error?.code === 'bad_password') {
        setError('Incorrect password');
        return;
      }
      setError(res.error?.message ?? 'Could not join');
      return;
    }
    onJoined(res.data.room_id);
  }

  return (
    <section className="mp-lobby__section">
      <form className="mp-create-form" onSubmit={submit}>
        <div className="mp-lobby__section-title">Join with an invite code</div>
        <div className="mp-create-form__footnote" style={{ marginBottom: 16 }}>
          Got a code from a friend? Enter the 8-character code below. Codes
          are case-insensitive and exclude lookalike characters (0, 1, I, O).
        </div>

        <label className="mp-label">Invite code</label>
        <input
          autoFocus
          className="mp-input mp-input--code"
          type="text"
          value={code}
          maxLength={11}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD-EFGH"
        />

        {askPassword && (
          <>
            <label className="mp-label">Password</label>
            <input
              className="mp-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </>
        )}

        <div className="mp-error">{error || ''}</div>

        <button type="submit" className="mp-btn mp-btn--primary mp-btn--block" disabled={busy}>
          {busy ? 'Joining…' : 'Join Room'}
        </button>
      </form>
    </section>
  );
}

// ---------- shared bits ----------

function RoomCard({
  room, onClick, variant, loading,
}: {
  room: RoomSummary;
  onClick: () => void;
  variant: 'my' | 'browse';
  loading?: boolean;
}) {
  const inGame = room.game_status === 'active';
  const isWaiting = !room.game_status || room.game_status !== 'active';
  return (
    <button className={`mp-room-card ${inGame ? 'is-active' : ''}`} onClick={onClick} disabled={loading}>
      <div className="mp-room-card__head">
        <span className="mp-room-card__name">{room.name}</span>
        <span className="mp-room-card__count">
          {room.member_count}/{room.max_players}
        </span>
      </div>
      <div className="mp-room-card__meta">
        <span>host · {room.host_name}</span>
        {room.has_password && <span className="mp-room-card__tag">🔒 password</span>}
      </div>
      <div className="mp-room-card__status">
        {inGame
          ? <span className="mp-room-card__status-active">● In progress</span>
          : isWaiting
            ? <span className="mp-room-card__status-lobby">○ Lobby</span>
            : <span>{room.game_status}</span>}
        {variant === 'browse' && !inGame && (
          <span className="mp-room-card__cta">{loading ? 'Joining…' : 'Join →'}</span>
        )}
        {variant === 'my' && (
          <span className="mp-room-card__cta">Resume →</span>
        )}
      </div>
    </button>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mp-empty-state">
      <div className="mp-empty-state__title">{title}</div>
      <div className="mp-empty-state__hint">{hint}</div>
    </div>
  );
}
