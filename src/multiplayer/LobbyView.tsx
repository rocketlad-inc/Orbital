import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, RoomSnapshot, RoomSummary } from './api';
import { useAuth } from './AuthContext';

// 24h / 1h / demo intervals — must match the worker's ALLOWED_TICK_INTERVALS.
const TICK_INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '60s (demo)', value: 60_000 },
  { label: '1h', value: 3_600_000 },
  { label: '24h', value: 86_400_000 },
];

interface Props {
  onEnterGame: (roomId: string, gameId: string) => void;
}

export function LobbyView({ onEnterGame }: Props) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  return activeRoomId
    ? <RoomDetail
        roomId={activeRoomId}
        onLeave={() => setActiveRoomId(null)}
        onEnterGame={(gid) => onEnterGame(activeRoomId, gid)}
      />
    : <RoomList onJoin={setActiveRoomId} />;
}

// ---------- Room list ----------

function RoomList({ onJoin }: { onJoin: (roomId: string) => void }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/rooms');
    if (res.ok) setRooms(res.data.rooms);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await apiFetch<{ room: { id: string } }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Could not create room'); return; }
    setName('');
    onJoin(res.data.room.id);
  }

  async function join(roomId: string) {
    setError(null);
    const res = await apiFetch(`/api/rooms/${roomId}/join`, { method: 'POST' });
    if (!res.ok) { setError(res.error?.message ?? 'Could not join'); return; }
    onJoin(roomId);
  }

  return (
    <div>
      <div className="mp-section-title">Create room</div>
      <form className="mp-row" onSubmit={create} style={{ gap: 6 }}>
        <input
          className="mp-input"
          type="text"
          maxLength={60}
          placeholder="Room name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="mp-submit" type="submit" style={{ width: 'auto', margin: 0, padding: '8px 12px' }}>+</button>
      </form>
      <div className="mp-error">{error || ''}</div>

      <div className="mp-section-title" style={{ marginTop: 16 }}>Open rooms</div>
      {rooms.length === 0 ? (
        <div className="mp-empty">No open rooms.</div>
      ) : rooms.map((r) => (
        <div key={r.id} className="mp-list-row" onClick={() => join(r.id)}>
          <div>
            <div>{r.name}</div>
            <div className="meta">host · {r.host_name}{r.game_id ? ' · in progress' : ''}</div>
          </div>
          <div style={{ color: 'var(--mp-friendly)', fontSize: 10 }}>
            {r.member_count}/{r.max_players}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Room detail ----------

function RoomDetail({
  roomId,
  onLeave,
  onEnterGame,
}: {
  roomId: string;
  onLeave: () => void;
  onEnterGame: (gameId: string) => void;
}) {
  const { user } = useAuth();
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Empire identity form state (controlled; pre-fill from snap on first load).
  const [empireName, setEmpireName] = useState('');
  const [bio, setBio] = useState('');
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const identityInitedRef = useRef(false);

  // Host settings
  const [hostName, setHostName] = useState('');
  const [hostMax, setHostMax] = useState(4);
  const [hostTicks, setHostTicks] = useState(42);
  const [hostInterval, setHostInterval] = useState(86_400_000);
  const settingsInitedRef = useRef(false);

  const refresh = useCallback(async () => {
    const res = await apiFetch<RoomSnapshot>(`/api/lobby/rooms/${roomId}`);
    if (res.ok) setSnap(res.data);
  }, [roomId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  // Open the lobby WebSocket so the server registers presence + chat works.
  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/rooms/${roomId}/ws`);
    wsRef.current = ws;
    let pingTimer: number | undefined;
    ws.addEventListener('open', () => {
      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }, 25_000);
    });
    ws.addEventListener('message', () => refresh()); // any server message triggers re-poll
    return () => {
      if (pingTimer) clearInterval(pingTimer);
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [roomId, refresh]);

  // When we get a game_id, jump out to the game view.
  useEffect(() => {
    if (snap?.game_id) onEnterGame(snap.game_id);
  }, [snap?.game_id, onEnterGame]);

  // First-load identity prefill from this user's row in members.
  useEffect(() => {
    if (!snap || identityInitedRef.current || !user) return;
    const me = snap.members.find((m) => m.userId === user.id);
    if (me) {
      setEmpireName(me.empire_name ?? '');
      setBio(me.bio ?? '');
      identityInitedRef.current = true;
    }
  }, [snap, user]);

  // First-load host settings prefill.
  useEffect(() => {
    if (!snap || settingsInitedRef.current) return;
    setHostName(snap.settings.name);
    setHostMax(snap.settings.max_players);
    setHostTicks(snap.settings.total_tick_target);
    setHostInterval(snap.settings.tick_interval_ms);
    settingsInitedRef.current = true;
  }, [snap]);

  if (!snap) return <div className="mp-empty">Loading room…</div>;

  const isHost = snap.settings.host_id === user?.id;
  const started = !!snap.game_id;
  const myReady = !!(user && snap.ready[user.id]);

  async function saveEmpire() {
    setError(null);
    setSavedFlash(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({
        empire_name: empireName.trim() || null,
        bio: bio.trim() || null,
      }),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Could not save'); return; }
    setSavedFlash('saved');
    setTimeout(() => setSavedFlash(null), 1800);
    refresh();
  }

  async function saveSettings() {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: hostName,
        max_players: hostMax,
        total_tick_target: hostTicks,
        tick_interval_ms: hostInterval,
      }),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Save failed'); return; }
    refresh();
  }

  async function startMatch() {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/start`, { method: 'POST' });
    if (!res.ok) setError(res.error?.message ?? 'Start failed');
    refresh();
  }

  function toggleReady() {
    if (!user || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'ready', ready: !myReady }));
  }

  async function kick(uid: string, name: string) {
    if (!window.confirm(`Kick ${name}?`)) return;
    await apiFetch(`/api/lobby/rooms/${roomId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ user_id: uid }),
    });
    refresh();
  }

  return (
    <div>
      <div className="mp-row" style={{ justifyContent: 'space-between' }}>
        <div className="mp-section-title" style={{ margin: 0 }}>{snap.settings.name}</div>
        <button className="mp-kick" onClick={onLeave}>Back</button>
      </div>

      <div className="mp-section-title">Status</div>
      <div className="mp-row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11 }}>
          {started
            ? `In progress · tick ${snap.settings.current_tick ?? 0}/${snap.settings.total_tick_target}`
            : `Lobby · ${snap.members.length}/${snap.settings.max_players} · ${Object.values(snap.ready).filter(Boolean).length} ready`}
        </span>
        {!started && (
          <button className="mp-kick" onClick={toggleReady}>
            {myReady ? 'Unready' : 'Ready'}
          </button>
        )}
      </div>

      {!started && (
        <>
          <div className="mp-section-title">Your empire</div>
          <label className="mp-label">Empire name</label>
          <input
            className="mp-input"
            type="text"
            maxLength={40}
            value={empireName}
            onChange={(e) => setEmpireName(e.target.value)}
            placeholder="e.g. Verdan Concord"
          />
          <label className="mp-label">Bio</label>
          <textarea
            className="mp-textarea"
            maxLength={1000}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Lore, doctrine, ambitions…"
          />
          <div className="mp-row" style={{ marginTop: 8 }}>
            <button className="mp-submit" style={{ width: 'auto', margin: 0, padding: '6px 12px' }} onClick={saveEmpire}>
              Save empire
            </button>
            <span className="mp-saved" style={{ marginLeft: 8 }}>{savedFlash || ''}</span>
          </div>
        </>
      )}

      {isHost && !started && (
        <>
          <div className="mp-section-title" style={{ marginTop: 12 }}>Host controls</div>
          <label className="mp-label">Room name</label>
          <input
            className="mp-input"
            type="text"
            maxLength={60}
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
          />
          <div className="mp-row" style={{ gap: 6, marginTop: 6 }}>
            <div style={{ flex: 1 }}>
              <label className="mp-label">Max players</label>
              <input
                className="mp-input"
                type="number"
                min={2}
                max={8}
                value={hostMax}
                onChange={(e) => setHostMax(parseInt(e.target.value, 10) || 2)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="mp-label">Ticks</label>
              <input
                className="mp-input"
                type="number"
                min={10}
                max={80}
                value={hostTicks}
                onChange={(e) => setHostTicks(parseInt(e.target.value, 10) || 10)}
              />
            </div>
          </div>
          <label className="mp-label">Tick interval</label>
          <select
            className="mp-select"
            value={String(hostInterval)}
            onChange={(e) => setHostInterval(parseInt(e.target.value, 10))}
          >
            {TICK_INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div className="mp-row" style={{ marginTop: 8, gap: 6 }}>
            <button className="mp-submit" style={{ width: 'auto', margin: 0, padding: '6px 12px' }} onClick={saveSettings}>
              Save
            </button>
            <button
              className="mp-submit"
              style={{ width: 'auto', margin: 0, padding: '6px 12px' }}
              disabled={snap.members.length < 2}
              title={snap.members.length < 2 ? 'Need at least 2 players' : ''}
              onClick={startMatch}
            >
              Start match
            </button>
          </div>
        </>
      )}

      <div className="mp-section-title" style={{ marginTop: 12 }}>Members</div>
      {snap.members.map((m) => {
        const online = snap.connected.includes(m.userId);
        const ready = !!snap.ready[m.userId];
        const isThisHost = m.userId === snap.settings.host_id;
        return (
          <div key={m.userId} className="mp-presence-row" style={{ flexWrap: 'wrap' }}>
            <span className={`mp-presence-dot ${online ? 'online' : ''}`} />
            <span>{m.displayName}{ready && !started ? ' ✓' : ''}</span>
            {isThisHost && <span className="mp-host-tag">host</span>}
            {isHost && !isThisHost && !started && (
              <button className="mp-kick" onClick={() => kick(m.userId, m.displayName)}>kick</button>
            )}
            {m.empire_name && <span className="empire">⚑ {m.empire_name}</span>}
            {m.bio && <span className="bio">{m.bio}</span>}
          </div>
        );
      })}

      <div className="mp-error">{error || ''}</div>
    </div>
  );
}
