// ============================================================
// roomSocket — one room WebSocket, with a reconnect policy that can
// tell a network blip from a locked door.
//
// Reported from a console full of red: six identical
// "WebSocket connection to wss://…/api/rooms/N8iIYOKw_4q1/ws failed"
// from three different files. The room was real and the sockets were
// fine; the viewer simply was not a member of it, so the Worker
// answered 403 every time — and all three reconnect loops treated that
// exactly like hotel wifi and kept knocking, forever, in parallel.
//
// THE BROWSER WILL NOT TELL YOU WHY. A failed upgrade surfaces as a
// bare `error` + `close`; the HTTP status is deliberately not exposed
// to script. So when attempts keep failing without ever opening, this
// asks the ordinary REST endpoint the same question — and a 401 / 403 /
// 404 there is a permanent answer: stop, say so once, and let the UI
// decide what to show. Anything else (500, offline, upgrade refused by
// a proxy) stays a transient blip and keeps its backoff.
// ============================================================

import { apiFetch } from './api';

/** Consecutive failed attempts, none of which ever opened, before we
 *  stop guessing and ask the REST endpoint what is wrong. Two rather
 *  than one: a socket lost mid-handshake during a deploy is ordinary. */
const PROBE_AFTER_FAILURES = 2;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export type RoomSocketGiveUpReason = 'forbidden' | 'unauthorized' | 'missing';

export interface RoomSocketHandlers {
  /** The socket just opened. Attach per-connection extras (a ping timer)
   *  here — it runs again on every reconnect. */
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (ev: MessageEvent) => void;
  /** This room will never accept us. Fired once; no further attempts. */
  onGiveUp?: (reason: RoomSocketGiveUpReason) => void;
}

export interface RoomSocketHandle {
  /** The live socket, or null between attempts. */
  current: () => WebSocket | null;
  close: () => void;
}

/** Status → why we were refused. Null means "not a permanent refusal". */
function permanentReason(status: number): RoomSocketGiveUpReason | null {
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'missing';
  return null;
}

export function connectRoomSocket(
  roomId: string,
  handlers: RoomSocketHandlers = {},
  /** Injected in tests. */
  deps: {
    makeSocket?: (url: string) => WebSocket;
    probe?: (roomId: string) => Promise<{ status: number }>;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
  } = {},
): RoomSocketHandle {
  const makeSocket = deps.makeSocket ?? ((url: string) => new WebSocket(url));
  const probe = deps.probe ?? (async (id: string) => {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(id)}`);
    return { status: res.status ?? 0 };
  });
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;

  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = BACKOFF_START_MS;
  let failures = 0;
  let cancelled = false;
  let gaveUp = false;

  const stop = (reason: RoomSocketGiveUpReason) => {
    gaveUp = true;
    ws = null;
    // One line, not one per attempt — the point of this whole module.
    // eslint-disable-next-line no-console
    console.warn(`[room ${roomId}] the server refuses this connection (${reason}); no further attempts.`);
    handlers.onGiveUp?.(reason);
  };

  const connect = () => {
    if (cancelled || gaveUp) return;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Opened, not yet proven good: an upgrade that gets refused still
    // fires `open`-less `close`, which is what `opened` distinguishes.
    let opened = false;
    const sock = makeSocket(`${scheme}://${window.location.host}/api/rooms/${roomId}/ws`);
    ws = sock;

    sock.addEventListener('open', () => {
      opened = true;
      failures = 0;
      backoffMs = BACKOFF_START_MS;
      handlers.onOpen?.(sock);
    });
    if (handlers.onMessage) sock.addEventListener('message', handlers.onMessage);
    // 'error' is always followed by 'close', so only close reschedules —
    // reconnecting from both double-fires the loop.
    sock.addEventListener('error', () => { try { sock.close(); } catch { /* */ } });
    sock.addEventListener('close', () => {
      if (cancelled || gaveUp) return;
      ws = null;
      if (!opened) failures += 1;
      const schedule = () => {
        if (cancelled || gaveUp) return;
        timer = setT(() => {
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
          connect();
        }, backoffMs);
      };
      if (failures < PROBE_AFTER_FAILURES) { schedule(); return; }
      probe(roomId).then(({ status }) => {
        if (cancelled || gaveUp) return;
        const reason = permanentReason(status);
        if (reason) stop(reason);
        else schedule();
      }).catch(() => { schedule(); });   // the probe itself failing IS a blip
    });
  };

  connect();

  return {
    current: () => ws,
    close: () => {
      cancelled = true;
      if (timer) clearT(timer);
      try { ws?.close(); } catch { /* */ }
      ws = null;
    },
  };
}
