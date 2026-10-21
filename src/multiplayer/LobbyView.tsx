import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, RoomSnapshot, RoomSummary } from './api';
import { useAuth } from './AuthContext';
import { DEFAULT_TICK_INTERVAL_MS } from './LobbyCards';
import { RESOURCE_LETTER_COLORS } from '../game/resourceColors';
import type { PastNameBank } from './NamePoolEditor';
import { NamePools, EMPTY_POOLS, parseNamePools } from '../game/namePools';
import { connectRoomSocket } from './roomSocket';
import { RoomLobbyScreen, RoomPageShell } from './RoomLobbyScreen';
import type { FlagField } from './RoomEmpireEditor';
import type { ChatLine } from './roomLobbyModel';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';

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
  useI18n();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch<{ rooms: RoomSummary[] }>('/api/rooms');
    if (res.ok) setRooms(res.data.rooms);
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
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
    if (!res.ok) { setError(apiErrorText(res.error, 'roomlobby.err.create')); return; }
    setName('');
    onJoin(res.data.room.id);
  }

  async function join(roomId: string) {
    setError(null);
    const res = await apiFetch(`/api/rooms/${roomId}/join`, { method: 'POST' });
    if (!res.ok) { setError(apiErrorText(res.error, 'roomlobby.err.join')); return; }
    onJoin(roomId);
  }

  return (
    <div>
      <div className="mp-section-title">{t('roomlobby.list.create')}</div>
      <form className="mp-row" onSubmit={create} style={{ gap: 6 }}>
        <input
          className="mp-input"
          type="text"
          maxLength={60}
          placeholder={t('roomlobby.roomName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="mp-submit" type="submit" style={{ width: 'auto', margin: 0, padding: '8px 12px' }}>+</button>
      </form>
      <div className="mp-error">{error || ''}</div>

      <div className="mp-section-title" style={{ marginTop: 16 }}>{t('roomlobby.list.open')}</div>
      {rooms.length === 0 ? (
        <div className="mp-empty">{t('roomlobby.list.none')}</div>
      ) : rooms.map((r) => (
        <div key={r.id} className="mp-list-row" onClick={() => join(r.id)}>
          <div>
            <div>{r.name}</div>
            <div className="meta">{t('roomlobby.list.host', { name: r.host_name })}{r.game_id ? ` · ${t('roomlobby.list.inProgress')}` : ''}</div>
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
  useI18n();
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
  //
  // Seeded from a `chat_history` frame the room sends on connect. This
  // state used to be the ONLY copy that existed anywhere, which meant a
  // refresh wiped the conversation and anyone joining late saw an empty
  // box — indistinguishable, from the player's side, from messages never
  // sending at all.
  const [chatLog, setChatLog] = useState<ChatLine[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const chatKeyRef = useRef(0);
  // Optimistic local ready flag — the WS roundtrip can take 100-300ms
  // and the playtester read that delay as "Ready Up does nothing".
  // We flip this immediately on click; useEffect below clears it once
  // the snap's authoritative value catches up.
  const [optimisticReady, setOptimisticReady] = useState<boolean | null>(null);
  const [namePools, setNamePools] = useState<NamePools>({ ...EMPTY_POOLS });
  // Name banks from this player's past games, offered by the editor so
  // hundreds of uploaded names are not a once-per-game chore. Fetched
  // once: they only change when some OTHER lobby saves.
  const [pastBanks, setPastBanks] = useState<PastNameBank[]>([]);
  useEffect(() => {
    let live = true;
    apiFetch<{ banks: PastNameBank[] }>(
      `/api/lobby/name-pools/history?exclude=${encodeURIComponent(roomId)}`,
    ).then((res) => { if (live && res.ok) setPastBanks(res.data.banks ?? []); });
    return () => { live = false; };
  }, [roomId]);
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
  // Which Save just succeeded, so its button can say "Saved" for a moment.
  const [flash, setFlash] = useState<'empire' | 'settings' | null>(null);
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
    const iv = setInterval(refresh, 2000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Open the lobby WebSocket so the server registers presence + chat works.
  // Auto-reconnects on unexpected close (hibernation, network blip).
  useEffect(() => {
    // Reconnect policy lives in roomSocket: this used to retry every
    // 1.5s forever, which against a room the viewer is not a member of
    // is forty refusals a minute with nothing to show for them.
    let pingTimer: number | undefined;
    const sock = connectRoomSocket(roomId, {
      onOpen: (ws) => {
        wsRef.current = ws;
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }, 25_000);
      },
      onGiveUp: () => {
        wsRef.current = null;
        setError(t('roomlobby.err.giveUp'));
      },
      onMessage: (ev) => {
      // Chat lines carry their own payload and don't change the room
      // snapshot, so append them and skip the re-poll. Everything else
      // (presence, ready, settings, game-started…) just triggers a
      // refresh — the snapshot is the source of truth for those.
      let m: any;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { m = null; }
      // Backlog replayed to us on (re)connect. REPLACES the local log
      // rather than appending: the server's copy is authoritative and
      // already contains anything we had, so replacing is also what stops
      // a reconnect from duplicating every line we'd already rendered.
      if (m && m.type === 'chat_history' && Array.isArray(m.messages)) {
        setChatLog(m.messages
          .filter((h: any) => h && h.from && typeof h.text === 'string')
          .map((h: any) => ({
            key: chatKeyRef.current++,
            from: h.from,
            text: h.text,
            at: typeof h.at === 'number' ? h.at : Date.now(),
          })));
        return;
      }
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
      },
    });
    wsRef.current = sock.current();
    return () => {
      if (pingTimer) clearInterval(pingTimer);
      sock.close();
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
      setError(apiErrorText(res.error, 'roomlobby.err.join'));
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
      // Hydrate once from the server so a reload or a second device
      // starts from what is stored, not from an empty editor that would
      // overwrite it on the first edit.
      setNamePools(parseNamePools(
        typeof (me as { name_pools?: unknown }).name_pools === 'string'
          ? (me as { name_pools?: string }).name_pools ?? null
          : JSON.stringify((me as { name_pools?: unknown }).name_pools ?? null),
      ));
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

  if (!snap) return <div className="mp-empty" role={error ? 'alert' : undefined}>{error ?? t('roomlobby.loading')}</div>;

  const isHost = snap.settings.host_id === user?.id;
  const started = !!snap.game_id;
  const myReady = optimisticReady ?? !!(user && snap.ready[user.id]);

  // Late-join world picker. Shown when the game is already running and
  // this user has no faction yet (joined via invite link after start).
  // Same fields and flow as ever; only the page around it is the lobby's.
  if (lateJoin) {
    return (
      <RoomPageShell
        title={snap.settings.name}
        sub={t('roomlobby.late.title')}
        onBack={onLeave}
        menu={[]}
        error={error}
        onDismissError={() => setError(null)}
      >
        <div className="rl-layout rl-layout--one">
          <section className="rl-panel rl-sec rl-late">
            <h2 className="rl-h2">{t('roomlobby.late.title')}</h2>
            <p className="rl-hint">{t('roomlobby.late.desc')}</p>

            <div className="rl-fld">
              <label htmlFor="rl-late-empire">{t('roomlobby.late.empireName')}</label>
              <input
                id="rl-late-empire"
                className="rl-input"
                type="text"
                maxLength={40}
                value={empireName}
                onChange={(e) => setEmpireName(e.target.value)}
                placeholder={t('roomlobby.empirePlaceholder')}
              />
            </div>

            {joinableBodies.length === 0 ? (
              <div className="rl-empty">{t('roomlobby.late.none')}</div>
            ) : (
              <>
                <h3 className="rl-ed__h">{t('roomlobby.late.worlds')}</h3>
                <div className="lobby-body-grid">
                  {joinableBodies.map((b) => {
                    const isMine = lateChoice === b.id;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`lobby-body-card ${isMine ? 'is-mine' : ''}`}
                        aria-pressed={isMine}
                        onClick={() => setLateChoice(isMine ? null : b.id)}
                        title={isMine ? t('roomlobby.late.unpick') : t('roomlobby.claim')}
                      >
                        <div className="lobby-body-card__name">{b.name}</div>
                        <div className="lobby-body-card__sub">{b.type}</div>
                        <div className="lobby-body-card__yields">
                          {b.yield.metal > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.M }}>M{b.yield.metal}</span>}
                          {/* no F — fuel is dead (DESIGN-identity-economy.md §1.1) */}
                          {/* C = credits (server field is still 'gold') */}
                          {b.yield.gold > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.C }}>C{b.yield.gold}</span>}
                          {b.yield.science > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.S }}>S{b.yield.science}</span>}
                        </div>
                        {isMine && <div className="lobby-body-card__tag">{t('roomlobby.late.chosen')}</div>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <div className="rl-row">
              <button
                type="button"
                className="rl-btn rl-btn--gold"
                disabled={!lateChoice || lateJoin === 'submitting'}
                onClick={submitLateJoin}
              >
                {lateJoin === 'submitting' ? t('roomlobby.late.joining') : t('roomlobby.late.found')}
              </button>
              <button type="button" className="rl-btn rl-btn--quiet" onClick={onLeave}>
                {t('roomlobby.back')}
              </button>
            </div>
          </section>
        </div>
      </RoomPageShell>
    );
  }

  // CUSTOM NAME POOLS. Saved on their own rather than folded into
  // saveEmpire: the empire form is a name and a bio you type once, and
  // these are lists you build up over several minutes. Sharing a Save
  // would mean either losing edits or saving a half-typed bio.
  async function saveNamePools(next: NamePools) {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({ name_pools: next }),
    });
    // ONLY ON SUCCESS. Adopting the draft before the server agreed
    // would clear the editor's unsaved marker and flash "Saved" for a
    // write that failed — the exact lie a save button exists to
    // prevent. Throwing keeps the draft intact so the player can retry.
    if (!res.ok) {
      const msg = apiErrorText(res.error, 'roomlobby.err.names');
      setError(msg);
      throw new Error(msg);
    }
    setNamePools(next);
  }

  async function saveEmpire() {
    setError(null);
    setFlash(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({
        empire_name: empireName.trim() || null,
        bio: bio.trim() || null,
      }),
    });
    if (!res.ok) { setError(apiErrorText(res.error, 'roomlobby.err.save')); return; }
    setFlash('empire');
    setTimeout(() => setFlash(null), 1800);
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
    if (!res.ok) { setError(apiErrorText(res.error, 'roomlobby.err.saveFailed')); return; }
    setFlash('settings');
    setTimeout(() => setFlash(null), 1800);
    refresh();
  }

  async function startMatch() {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/start`, { method: 'POST' });
    if (!res.ok) setError(apiErrorText(res.error, 'roomlobby.err.start'));
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

  // Give up the seat. Back keeps it (the lobby stays in My Games and the
  // seat stays taken); this frees it. A host hands the room to whoever has
  // waited longest; a host alone deletes it -- the server refuses to leave
  // a lobby with no one in it (last_member).
  async function leaveLobby() {
    if (!snap) return;
    const name = snap.settings.name;
    const alone = snap.members.length <= 1;
    if (isHost && alone) {
      if (!window.confirm(t('roomlobby.delete.confirm', { name }))) return;
      const res = await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
      if (!res.ok) { window.alert(apiErrorText(res.error, 'roomlobby.err.delete')); return; }
    } else {
      const handOver = isHost ? t('roomlobby.leave.handOver') : '';
      if (!window.confirm(t('roomlobby.leave.confirm', { name, handOver }))) return;
      const res = await apiFetch(`/api/lobby/rooms/${roomId}/leave`, { method: 'POST' });
      if (!res.ok) { window.alert(apiErrorText(res.error, 'roomlobby.err.leave')); return; }
    }
    forgetPinnedRoom(roomId);
    onLeave();
  }

  // The host removes the room for everyone (the same route and the same
  // confirmation as My Games' delete). Leaving as the only member also ends
  // in a delete; this one is for a room that still has people in it.
  async function deleteRoom() {
    if (!snap) return;
    if (!window.confirm(t('lobby.my.confirmDelete', { name: snap.settings.name }))) return;
    const res = await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (!res.ok) { setError(apiErrorText(res.error, 'roomlobby.err.delete')); return; }
    forgetPinnedRoom(roomId);
    onLeave();
  }

  async function kick(uid: string, name: string) {
    if (!window.confirm(t('roomlobby.kick.confirm', { name }))) return;
    await apiFetch(`/api/lobby/rooms/${roomId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ user_id: uid }),
    });
    refresh();
  }

  // The local player's claimed capital — drives the backdrop map's
  // claim ring AND the picker highlight. Prefers the optimistic value
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
      setError(apiErrorText(res.error, 'roomlobby.err.pick'));
      return;
    }
    refresh();  // pull the authoritative snapshot; reconcile effect clears the override
  };

  // Flag: primary/secondary colour and emblem. All three go through the
  // same PATCH /me endpoint as empire_name / chosen_starting_body.
  //
  // Two exclusivity rules, deliberately different:
  //   color   409 'color_taken'  — too CLOSE to another member's pick
  //   emblem  409 'emblem_taken' — EXACTLY another member's pick
  // Colours live on a continuum so "close enough to confuse" is the real
  // failure; emblems are a closed set where only identity collides.
  const pickFlag = async (field: FlagField, value: string | null) => {
    setError(null);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/me`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) {
      const code = res.error?.code;
      setError(
        code === 'color_taken'
          ? t('roomlobby.err.colorTaken')
          : code === 'emblem_taken'
            ? t('roomlobby.err.emblemTaken')
            : apiErrorText(res.error, 'roomlobby.err.flag'),
      );
      return;
    }
    refresh();
  };

  return (
    <RoomLobbyScreen
      roomId={roomId}
      snap={snap}
      viewerId={user?.id}
      isHost={isHost}
      started={started}
      myReady={myReady}
      error={error}
      onDismissError={() => setError(null)}
      onBack={onLeave}
      onLeaveLobby={leaveLobby}
      onDeleteRoom={deleteRoom}
      onStart={startMatch}
      onToggleReady={toggleReady}
      onKick={kick}
      onSeatsOpened={refresh}
      empire={{
        myChoice,
        empireName, onEmpireName: setEmpireName,
        bio, onBio: setBio,
        onSaveEmpire: saveEmpire,
        saved: flash === 'empire',
        onPickFlag: pickFlag,
        onPickBody: handlePick,
        namePools, onSaveNamePools: saveNamePools,
        pastBanks,
      }}
      rules={{
        draft: { name: hostName, max: hostMax, interval: hostInterval },
        onDraft: (d) => { setHostName(d.name); setHostMax(d.max); setHostInterval(d.interval); },
        onSave: saveSettings,
        saved: flash === 'settings',
      }}
      chat={{ log: chatLog, draft: chatDraft, onDraft: setChatDraft, onSend: sendChat }}
    />
  );
}

/** A pinned lobby you are no longer in would be a dead pin. */
function forgetPinnedRoom(roomId: string): void {
  try { if (localStorage.getItem('orbital.priority_room') === roomId) localStorage.removeItem('orbital.priority_room'); } catch { /* storage off */ }
}
