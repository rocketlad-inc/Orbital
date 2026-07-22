import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, RoomSnapshot, RoomSummary } from './api';
import { useAuth } from './AuthContext';
import { LobbyMapPreview } from './LobbyMapPreview';
import { colorDistance, COLOR_MIN_DISTANCE, deriveSecondary } from '../game/colorUtils';

/** A pre-game lobby chat line, as broadcast by the room WebSocket
 *  (`{ type: 'chat', from, text, at }`). `key` is assigned client-side
 *  for a stable React key on the append-only log. */
interface ChatMsg {
  key: number;
  from: { userId: string; displayName: string };
  text: string;
  at: number;
}

/** Two-tone (§5) chip: primary square with a secondary corner. Mirrors
 *  FactionPanel's twoToneChip exactly so a member's color reads the same
 *  in the lobby as it will in the match. */
function twoToneChip(color: string, color2?: string | null): React.CSSProperties {
  const c2 = color2 || deriveSecondary(color);
  return {
    background: `linear-gradient(135deg, ${color} 0%, ${color} 68%, ${c2} 68%, ${c2} 100%)`,
  };
}

// Two-tone factions (§5): curated swatch grid — a modest 16 colors, not
// a full wheel. PRIMARY carries all meaning on the map (server enforces
// perceptual distance between members' primaries); SECONDARY is
// decoration only and free-pick from the same grid.
const FACTION_COLOR_CHOICES: string[] = [
  '#ff7043', // ember
  '#42a5f5', // azure
  '#66bb6a', // verdant
  '#ab47bc', // violet
  '#ffca28', // amber
  '#26c6da', // cyan
  '#ec407a', // rose
  '#8d6e63', // ferrous
  '#ef5350', // signal red
  '#5c6bc0', // indigo
  '#9ccc65', // lime
  '#ff8a65', // coral
  '#78909c', // steel
  '#d4e157', // chartreuse
  '#7e57c2', // amethyst
  '#f5f5f5', // white
];

// Real-world time between automatic ticks. Must match the worker's
// ALLOWED_TICK_INTERVALS — keep these two lists in sync.
//
// Pace design (see DESIGN.md "Time and pacing"): the reference cadence is
// 7.5 min/tick, which gives an Earth→Jupiter Hohmann transfer of ~1.5
// real days and a 4000-tick match of ~21 real days (3 weeks).
const TICK_INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '30s (rapid demo)',     value: 30_000 },
  { label: '60s (demo)',           value: 60_000 },
  { label: '5min (quick play)',    value: 300_000 },
  { label: '7.5min (3-week match · DEFAULT)', value: 450_000 },
  { label: '30min (lunch break)',  value: 1_800_000 },
  { label: '1h (fast async)',      value: 3_600_000 },
  { label: '6h (4×/day)',          value: 21_600_000 },
  { label: '12h (2×/day)',         value: 43_200_000 },
  { label: '24h (1×/day)',         value: 86_400_000 },
];

/** Reference default — see comment above. Matches worker/lobby.js. */
const DEFAULT_TICK_INTERVAL_MS = 450_000;

interface Props {
  onEnterGame: (roomId: string, gameId: string) => void;
  initialRoomId?: string | null;
  /** Exit the room entirely (back to the multiplayer room browser).
   *  Supplied by MultiplayerShell. When present, the room's Back button
   *  uses it instead of the in-component RoomList fallback. */
  onExitRoom?: () => void;
}

export function LobbyView({ onEnterGame, initialRoomId, onExitRoom }: Props) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(initialRoomId ?? null);

  return activeRoomId
    ? <RoomDetail
        roomId={activeRoomId}
        // Prefer the real exit (→ room browser). The setActiveRoomId(null)
        // fallback only matters in the standalone RoomList → RoomDetail
        // flow, which the shell never uses (it always enters with a room).
        onLeave={() => { if (onExitRoom) onExitRoom(); else setActiveRoomId(null); }}
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
  // Bumped to force-reconnect the room WS (e.g. after a stale-socket send).
  const [wsTick, setWsTick] = useState(0);
  // Pre-game chat: the running log (capped) + the composer draft. Lines
  // arrive over the same room WS that carries presence/ready; the server
  // broadcasts each `chat` message back to everyone including the sender,
  // so a sent line simply shows up when its broadcast returns.
  const [chatLog, setChatLog] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const chatKeyRef = useRef(0);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Optimistic local ready flag — the WS roundtrip can take 100-300ms
  // and the playtester read that delay as "Ready Up does nothing".
  // We flip this immediately on click; useEffect below clears it once
  // the snap's authoritative value catches up.
  const [optimisticReady, setOptimisticReady] = useState<boolean | null>(null);
  // Optimistic starting-capital pick. Same story as Ready: picking a
  // body PATCHes then re-polls — two server round-trips before the card
  // highlight + map zoom react, which read as ">1s lag" per click. We
  // show the pick instantly and reconcile when the snapshot agrees.
  //   undefined = follow the server; string = optimistic claim;
  //   null = optimistic un-claim.
  const [optimisticChoice, setOptimisticChoice] = useState<string | null | undefined>(undefined);

  // Empire identity form state (controlled; pre-fill from snap on first load).
  const [empireName, setEmpireName] = useState('');
  const [bio, setBio] = useState('');
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const identityInitedRef = useRef(false);

  // Host settings
  const [hostName, setHostName] = useState('');
  const [hostMax, setHostMax] = useState(4);
  const [hostInterval, setHostInterval] = useState(DEFAULT_TICK_INTERVAL_MS);
  const settingsInitedRef = useRef(false);

  // Late-join: when the game has already started and this user has no
  // faction (joined via invite link after start), we show a world
  // picker instead of dumping them into the game where /state 403s.
  //   null      = not a latecomer (or undetermined yet)
  //   'needed'  = show the picker
  //   'submitting' = late-join POST in flight
  type LateJoinBody = { id: string; name: string; type: string; yield: { metal: number; fuel: number; gold: number; science: number } };
  const [lateJoin, setLateJoin] = useState<null | 'needed' | 'submitting'>(null);
  const [joinableBodies, setJoinableBodies] = useState<LateJoinBody[]>([]);
  const [lateChoice, setLateChoice] = useState<string | null>(null);
  const lateJoinCheckedRef = useRef(false);

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
  // Auto-reconnects on unexpected close (hibernation, network blip).
  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/rooms/${roomId}/ws`);
    wsRef.current = ws;
    let pingTimer: number | undefined;
    let cancelled = false;
    let reconnectTimer: number | undefined;
    ws.addEventListener('open', () => {
      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }, 25_000);
    });
    ws.addEventListener('message', (ev) => {
      // Chat lines carry their own payload and don't change the room
      // snapshot, so append them and skip the re-poll. Everything else
      // (presence, ready, settings, game-started…) just triggers a
      // refresh — the snapshot is the source of truth for those.
      let m: any;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { m = null; }
      if (m && m.type === 'chat' && m.from && typeof m.text === 'string') {
        setChatLog((prev) => {
          const next = [...prev, {
            key: chatKeyRef.current++,
            from: m.from,
            text: m.text,
            at: typeof m.at === 'number' ? m.at : Date.now(),
          }];
          // Cap the in-memory log so a marathon lobby can't grow unbounded.
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
        return;
      }
      refresh();
    });
    ws.addEventListener('close', () => {
      if (cancelled) return;
      // Backoff via setTimeout to avoid hot-looping on server-side rejections.
      reconnectTimer = window.setTimeout(() => {
        if (!cancelled) setWsTick((n) => n + 1);
      }, 1500);
    });
    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [roomId, refresh, wsTick]);

  // When we get a game_id, decide: enter the game (I have a faction) or
  // show the late-join world picker (I joined via invite after start and
  // have no faction yet). joinable-bodies reports already_joined so we
  // route correctly instead of dumping a factionless user into a /state
  // that 403s.
  useEffect(() => {
    const gameId = snap?.game_id;
    if (!gameId || lateJoinCheckedRef.current) return;
    lateJoinCheckedRef.current = true;
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ already_joined: boolean; bodies: LateJoinBody[] }>(
        `/api/games/${gameId}/joinable-bodies`,
      );
      if (cancelled) return;
      if (res.ok && res.data) {
        if (res.data.already_joined) {
          onEnterGame(gameId);
        } else {
          setJoinableBodies(res.data.bodies ?? []);
          setLateJoin('needed');
        }
      } else {
        // Couldn't determine — fall back to the original behavior so a
        // returning player isn't stranded by a transient error.
        onEnterGame(gameId);
      }
    })();
    return () => { cancelled = true; };
  }, [snap?.game_id, onEnterGame]);

  async function submitLateJoin() {
    const gameId = snap?.game_id;
    if (!gameId || !lateChoice) return;
    setError(null);
    setLateJoin('submitting');
    const res = await apiFetch<{ ok: boolean; faction_id: string }>(
      `/api/games/${gameId}/late-join`,
      {
        method: 'POST',
        body: JSON.stringify({
          chosen_body: lateChoice,
          empire_name: empireName.trim() || undefined,
          bio: bio.trim() || undefined,
        }),
      },
    );
    if (!res.ok) {
      setError(res.error?.message ?? 'Could not join');
      setLateJoin('needed');
      // A body_taken race: refresh the joinable list so the player can
      // pick another world.
      const fresh = await apiFetch<{ bodies: LateJoinBody[] }>(`/api/games/${gameId}/joinable-bodies`);
      if (fresh.ok && fresh.data) {
        setJoinableBodies(fresh.data.bodies ?? []);
        setLateChoice(null);
      }
      return;
    }
    onEnterGame(gameId);
  }

  // Clear the optimistic Ready flag once the server-authoritative
  // snapshot agrees with what we showed locally.
  useEffect(() => {
    if (optimisticReady == null || !user || !snap) return;
    const serverReady = !!snap.ready[user.id];
    if (serverReady === optimisticReady) setOptimisticReady(null);
  }, [snap, user, optimisticReady]);

  // Drop the optimistic capital pick once the server snapshot agrees.
  useEffect(() => {
    if (optimisticChoice === undefined || !user || !snap) return;
    const serverChoice = snap.members.find(m => m.userId === user.id)?.chosen_starting_body ?? null;
    if (serverChoice === optimisticChoice) setOptimisticChoice(undefined);
  }, [snap, user, optimisticChoice]);

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
    setHostInterval(snap.settings.tick_interval_ms);
    settingsInitedRef.current = true;
  }, [snap]);

  // Keep the chat pinned to the newest line as messages arrive.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatLog]);

  if (!snap) return <div className="mp-empty">Loading room…</div>;

  const isHost = snap.settings.host_id === user?.id;
  const started = !!snap.game_id;
  const myReady = optimisticReady ?? !!(user && snap.ready[user.id]);

  // Late-join world picker. Shown when the game is already running and
  // this user has no faction yet (joined via invite link after start).
  if (lateJoin) {
    return (
      <div className="mp-room-detail">
        <div className="mp-section-title" style={{ marginTop: 4 }}>Join the war</div>
        <div className="mp-empty" style={{ fontSize: 11, marginBottom: 8, padding: '0 2px' }}>
          The game is already underway. Pick an unclaimed world to drop your capital on —
          you start with a city, two frigates, and a freighter.
        </div>

        <label className="mp-label">Empire name (optional)</label>
        <input
          className="mp-input"
          type="text"
          maxLength={40}
          value={empireName}
          onChange={(e) => setEmpireName(e.target.value)}
          placeholder="e.g. Verdan Concord"
        />

        {joinableBodies.length === 0 ? (
          <div className="mp-empty" style={{ marginTop: 12 }}>
            No unclaimed capital-worlds remain — there's no open seat in this game.
          </div>
        ) : (
          <>
            <div className="mp-section-title" style={{ marginTop: 12 }}>Unclaimed worlds</div>
            <div className="lobby-body-grid">
              {joinableBodies.map((b) => {
                const isMine = lateChoice === b.id;
                return (
                  <button
                    key={b.id}
                    className={`lobby-body-card ${isMine ? 'is-mine' : ''}`}
                    onClick={() => setLateChoice(isMine ? null : b.id)}
                    title={isMine ? 'Click to un-pick' : 'Click to claim'}
                  >
                    <div className="lobby-body-card__name">{b.name}</div>
                    <div className="lobby-body-card__sub">{b.type}</div>
                    <div className="lobby-body-card__yields">
                      {b.yield.metal > 0 && <span>M{b.yield.metal}</span>}
                      {b.yield.fuel > 0 && <span>F{b.yield.fuel}</span>}
                      {/* C = credits (server field is still 'gold') */}
                      {b.yield.gold > 0 && <span>C{b.yield.gold}</span>}
                      {b.yield.science > 0 && <span>S{b.yield.science}</span>}
                    </div>
                    {isMine && <div className="lobby-body-card__tag">✓ chosen</div>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {error && <div className="mp-error">{error}</div>}

        <div className="mp-row" style={{ marginTop: 12, gap: 6 }}>
          <button
            className="mp-submit"
            style={{ width: 'auto', margin: 0, padding: '8px 16px' }}
            disabled={!lateChoice || lateJoin === 'submitting'}
            onClick={submitLateJoin}
          >
            {lateJoin === 'submitting' ? 'Joining…' : 'Found my capital'}
          </button>
          <button
            className="mp-submit"
            style={{ width: 'auto', margin: 0, padding: '8px 16px', background: 'transparent', border: '1px solid var(--mp-border)', color: 'var(--mp-fg-dim)' }}
            onClick={onLeave}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

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
    if (!user) return;
    const ws = wsRef.current;
    // The cached ref can point at a socket that's already closing or
    // closed (server hibernated, network blip, host-deletion notice
    // racing the click). Calling .send() on a dead socket throws
    // "WebSocket is already in CLOSING or CLOSED state" and the click
    // does nothing — guard explicitly and kick the reconnect counter
    // so the useEffect below opens a fresh socket.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const next = !myReady;
        setOptimisticReady(next);
        ws.send(JSON.stringify({ type: 'ready', ready: next }));
        return;
      } catch (e) {
        console.warn('ready send failed, will reconnect', e);
        setOptimisticReady(null);
      }
    }
    // Dead socket. Bump the reconnect counter so the WS effect tears
    // down + recreates. The user can click Ready Up again once the new
    // socket opens — typically <500ms.
    setWsTick((n) => n + 1);
  }

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    const ws = wsRef.current;
    // Same dead-socket guard as toggleReady: the cached ref can point at
    // a socket the server hibernated or a network blip closed. Send only
    // on an OPEN socket; otherwise kick the reconnect and let the user
    // resend once the fresh socket opens (typically <500ms).
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'chat', text: text.slice(0, 500) }));
        setChatDraft('');
        return;
      } catch (err) {
        console.warn('chat send failed, will reconnect', err);
      }
    }
    setWsTick((n) => n + 1);
  }

  async function kick(uid: string, name: string) {
    if (!window.confirm(`Kick ${name}?`)) return;
    await apiFetch(`/api/lobby/rooms/${roomId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ user_id: uid }),
    });
    refresh();
  }

  const inviteCode = snap.settings.invite_code;
  const formattedInvite = inviteCode ? inviteCode.match(/.{1,4}/g)?.join('-') : null;

  function copyInvite() {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode).catch(() => { /* ignore */ });
    setSavedFlash('copied');
    setTimeout(() => setSavedFlash(null), 1500);
  }

  // The local player's claimed capital — drives the backdrop map's
  // fly-in zoom AND the picker highlight. Prefers the optimistic value
  // (set the instant you click) so both react without waiting on the
  // server round-trip.
  const serverChoice = user?.id
    ? snap.members.find(m => m.userId === user.id)?.chosen_starting_body ?? null
    : null;
  const myChoice = optimisticChoice !== undefined ? optimisticChoice : serverChoice;

  // Pick (or un-pick) a starting capital: reflect it locally NOW, then
  // PATCH in the background. On failure, roll back to the server value.
  const handlePick = async (bodyId: string | null) => {
    setError(null);
    setOptimisticChoice(bodyId);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({ chosen_starting_body: bodyId }),
    });
    if (!res.ok) {
      setOptimisticChoice(undefined);  // revert to whatever the server says
      setError(res.error?.message ?? 'Could not pick body');
      return;
    }
    refresh();  // pull the authoritative snapshot; reconcile effect clears the override
  };

  // Two-tone (§5): pick a primary or secondary faction color. Same PATCH
  // /me endpoint as empire_name / chosen_starting_body. The server 409s
  // ('color_taken') primaries too close to another member's pick.
  const pickColor = async (field: 'color' | 'color2', value: string | null) => {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) {
      setError(
        res.error?.code === 'color_taken'
          ? "Too close to another player's color — pick something more distinct"
          : res.error?.message ?? 'Could not save color',
      );
      return;
    }
    refresh();
  };

  return (
    <div className="lobby-room">
      {/* Pre-game map preview — fills the blank viewport BEHIND the panel
          so players can see where the starting worlds sit. Only while
          the game hasn't started (a running game draws its own map).
          Purely visual; the card picker in the panel is the claim
          control. Zooms to the local player's claimed world. */}
      {!started && (
        <LobbyMapPreview snap={snap} myUserId={user?.id} focusBodyId={myChoice} />
      )}

      {/* All lobby controls live in a full-height panel over the map
          backdrop: a fixed header (room name + Back) so the top never
          scrolls out of view, and a scrollable body for everything
          else. */}
      <div className="lobby-panel">
      <div className="lobby-panel__header">
        <span className="lobby-panel__title">{snap.settings.name}</span>
        <button className="mp-kick" onClick={onLeave}>Back</button>
      </div>
      <div className="lobby-panel__body">

      {inviteCode && !started && (
        <div className="mp-invite-strip" onClick={copyInvite} title="Click to copy invite code">
          <span className="mp-invite-strip__label">INVITE</span>
          <span className="mp-invite-strip__code">{formattedInvite}</span>
          {snap.settings.has_password && (
            <span className="mp-invite-strip__lock" title="Password-protected">🔒</span>
          )}
          {savedFlash === 'copied' && <span className="mp-invite-strip__flash">✓ copied</span>}
        </div>
      )}

      <div className="mp-section-title">Status</div>
      <div className="mp-row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11 }}>
          {started
            ? `In progress · tick ${snap.settings.current_tick ?? 0}`
            : `Lobby · ${snap.members.length}/${snap.settings.max_players} · ${Object.values(snap.ready).filter(Boolean).length} ready`}
        </span>
        {!started && (
          <button
            className={`mp-ready-btn ${myReady ? 'is-ready' : ''}`}
            onClick={toggleReady}
          >
            {myReady ? '✓ Ready' : 'Ready Up'}
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

          <FactionColorPicker
            snap={snap}
            myUserId={user?.id}
            onPick={pickColor}
          />

          <StartingBodyPicker
            snap={snap}
            myUserId={user?.id}
            myChoice={myChoice}
            onPick={handlePick}
          />
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
                inputMode="numeric"
                min={2}
                max={8}
                value={hostMax}
                onChange={(e) => setHostMax(parseInt(e.target.value, 10) || 2)}
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
            {/* Two-tone (§5) swatch — same primary/secondary split chip
                the in-game FactionPanel uses, so a player's picked
                color reads identically in the lobby and in the match.
                No swatch at all until they've picked (color is null
                pre-pick) rather than a placeholder grey, since "hasn't
                chosen yet" is itself useful information here. */}
            {m.color && <span className="mp-swatch" style={twoToneChip(m.color, m.color2)} />}
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

      <div className="mp-section-title" style={{ marginTop: 12 }}>Lobby chat</div>
      <div className="lobby-chat">
        <div className="lobby-chat__log" ref={chatScrollRef}>
          {chatLog.length === 0 ? (
            <div className="mp-empty" style={{ fontSize: 10, padding: '4px 2px' }}>
              No messages yet — say hi to the other commanders.
            </div>
          ) : (
            chatLog.map((m) => {
              const mine = !!user && m.from.userId === user.id;
              return (
                <div key={m.key} className={`lobby-chat__line ${mine ? 'is-mine' : ''}`}>
                  <span className="lobby-chat__who">{mine ? 'you' : m.from.displayName}</span>
                  <span className="lobby-chat__text">{m.text}</span>
                </div>
              );
            })
          )}
        </div>
        <form className="lobby-chat__composer" onSubmit={sendChat}>
          <input
            className="mp-input"
            type="text"
            maxLength={500}
            placeholder="Message the lobby…"
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="mp-submit"
            type="submit"
            disabled={!chatDraft.trim()}
            style={{ width: 'auto', margin: 0, padding: '8px 12px' }}
          >
            Send
          </button>
        </form>
      </div>

      <div className="mp-error">{error || ''}</div>
      </div>{/* .lobby-panel__body */}
      </div>{/* .lobby-panel */}
    </div>
  );
}

// ---------- Faction color picker (two-tone, §5) ----------

/** Shared swatch-button style. */
function swatchStyle(c: string, opts: { selected: boolean; taken: boolean }): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    padding: 0,
    background: c,
    border: opts.selected ? '2px solid #fff' : '1px solid var(--mp-border)',
    borderRadius: 3,
    cursor: opts.taken ? 'not-allowed' : 'pointer',
    opacity: opts.taken ? 0.25 : 1,
    position: 'relative',
  };
}

function FactionColorPicker({
  snap, myUserId, onPick,
}: {
  snap: RoomSnapshot;
  myUserId?: string;
  onPick: (field: 'color' | 'color2', value: string | null) => void;
}) {
  const me = myUserId ? snap.members.find(m => m.userId === myUserId) : undefined;
  const myColor = me?.color ?? null;
  const myColor2 = me?.color2 ?? null;

  // Other members' primaries — used to gray out swatches that are too
  // close (mirrors the server's 409 'color_taken' check so the player
  // rarely hits the error path).
  const otherPrimaries = snap.members
    .filter(m => m.userId !== myUserId && m.color)
    .map(m => ({ color: m.color as string, name: m.empire_name || m.displayName }));

  const rowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 };

  return (
    <>
      <div className="mp-section-title" style={{ marginTop: 12 }}>Faction colors</div>
      <div className="mp-empty" style={{ fontSize: 10, marginBottom: 6, padding: '0 2px' }}>
        Primary marks what you own on the map — it must stay distinct from other
        players. Secondary is trim only.
      </div>
      <label className="mp-label">Primary</label>
      <div style={rowStyle}>
        {FACTION_COLOR_CHOICES.map(c => {
          const clash = otherPrimaries.find(o => colorDistance(c, o.color) < COLOR_MIN_DISTANCE);
          const selected = myColor === c;
          // Own pick is never "taken" by yourself.
          const taken = !!clash && !selected;
          return (
            <button
              key={c}
              type="button"
              disabled={taken}
              style={swatchStyle(c, { selected, taken })}
              title={taken ? `Too close to ${clash!.name}'s color` : selected ? 'Click to clear' : c}
              onClick={() => onPick('color', selected ? null : c)}
            />
          );
        })}
      </div>
      <label className="mp-label">Secondary (trim)</label>
      <div style={rowStyle}>
        {FACTION_COLOR_CHOICES.map(c => {
          const selected = myColor2 === c;
          // Secondary is decoration only — meaning must stay in the
          // primary — so it's a free pick: no taken states here.
          return (
            <button
              key={c}
              type="button"
              style={swatchStyle(c, { selected, taken: false })}
              title={selected ? 'Click to clear (auto trim)' : c}
              onClick={() => onPick('color2', selected ? null : c)}
            />
          );
        })}
      </div>
      {myColor && (
        <div className="mp-empty" style={{ fontSize: 10, padding: '0 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
          Preview:
          <span style={{
            display: 'inline-block', width: 18, height: 18, borderRadius: 3,
            border: '1px solid var(--mp-border)',
            background: `linear-gradient(135deg, ${myColor} 0%, ${myColor} 68%, ${myColor2 || deriveSecondary(myColor)} 68%)`,
          }} />
          {!myColor2 && <span>(trim auto-derived)</span>}
        </div>
      )}
    </>
  );
}

// ---------- Starting body picker ----------

function StartingBodyPicker({
  snap, myUserId, myChoice, onPick,
}: {
  snap: RoomSnapshot;
  myUserId?: string;
  /** Effective choice (optimistic-aware) from the parent. */
  myChoice: string | null;
  /** Pick / un-pick handler (optimistic + PATCH) owned by the parent. */
  onPick: (bodyId: string | null) => void;
}) {
  const options = snap.starting_body_options ?? [];
  if (!options.length) return null;

  // Map of body id -> userId who claimed it (so we can show "taken").
  // Built from the server snapshot for OTHER players, then patched with
  // the local player's optimistic choice so the highlight is instant and
  // never shows a stale double-claim while the PATCH is in flight.
  const claimedBy = new Map<string, string>();
  for (const m of snap.members) {
    if (m.chosen_starting_body) claimedBy.set(m.chosen_starting_body, m.userId);
  }
  if (myUserId) {
    for (const [bid, uid] of Array.from(claimedBy)) {
      if (uid === myUserId) claimedBy.delete(bid);
    }
    if (myChoice) claimedBy.set(myChoice, myUserId);
  }

  const pick = onPick;

  return (
    <>
      <div className="mp-section-title" style={{ marginTop: 12 }}>
        Starting capital
      </div>
      <div className="mp-empty" style={{ fontSize: 10, marginBottom: 6, padding: '0 2px' }}>
        Pick the world your faction starts on. First-come first-served — pick early.
      </div>
      <div className="lobby-body-grid">
        {options.map(opt => {
          const taken = claimedBy.get(opt.id);
          const isMine = taken === myUserId;
          const isTaken = !!taken && !isMine;
          const ownerName = taken
            ? (snap.members.find(m => m.userId === taken)?.displayName ?? 'someone')
            : null;
          return (
            <button
              key={opt.id}
              className={`lobby-body-card ${isMine ? 'is-mine' : ''} ${isTaken ? 'is-taken' : ''}`}
              disabled={isTaken}
              onClick={() => pick(isMine ? null : opt.id)}
              title={
                isMine ? 'Click to un-claim'
                : isTaken ? `Claimed by ${ownerName}`
                : 'Click to claim'
              }
            >
              <div className="lobby-body-card__name">{opt.name}</div>
              <div className="lobby-body-card__sub">
                {opt.type}{opt.parent && opt.parent !== 'sol' ? ` · ${opt.parent}` : ''}
              </div>
              <div className="lobby-body-card__yields">
                {opt.yield.metal > 0 && <span>M{opt.yield.metal}</span>}
                {opt.yield.fuel > 0 && <span>F{opt.yield.fuel}</span>}
                {/* C = credits (server field is still 'gold') */}
                {opt.yield.gold > 0 && <span>C{opt.yield.gold}</span>}
                {opt.yield.science > 0 && <span>S{opt.yield.science}</span>}
              </div>
              {isMine && <div className="lobby-body-card__tag">✓ yours</div>}
              {isTaken && <div className="lobby-body-card__tag is-taken">{ownerName}</div>}
            </button>
          );
        })}
      </div>
      {!myChoice && (
        <div className="mp-empty" style={{ fontSize: 10, marginTop: 4, padding: '0 2px', fontStyle: 'italic' }}>
          No choice = the host will auto-assign you a world.
        </div>
      )}
    </>
  );
}
