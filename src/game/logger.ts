// ============================================================
// GameLogger — in-memory ring buffer of categorized events.
// Exports as a plain-text .txt for sharing/diagnosis.
//
// Hooked into gameContext (player actions + sim events), the
// multiplayer api wrapper (network), and global error handlers.
// ============================================================

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type LogCategory =
  | 'SESSION'   // metadata, one-time
  | 'SYSTEM'    // app lifecycle (mode change, auth, room join)
  | 'ACTION'    // player intent (button clicks, plans)
  | 'SIM'       // game-engine events (build completion, transfer arrival)
  | 'COMBAT'    // auto-fire volleys, kills
  | 'RESOURCE'  // economy deltas
  | 'THREAT'    // hostile incoming / resolved
  | 'API'       // network requests + responses
  | 'TICK';     // periodic snapshots

export interface LogEntry {
  /** Wall-clock time (ms since epoch) when the entry was created. */
  wallMs: number;
  /** Game tick at log time, if known. Null in pre-game (lobby/auth). */
  tick: number | null;
  level: LogLevel;
  category: LogCategory;
  msg: string;
  /** Free-form structured payload. Stringified in the export. */
  data?: Record<string, unknown>;
}

export interface SessionMeta {
  mode: 'singleplayer' | 'multiplayer' | 'guest' | 'unknown';
  gameId?: string | null;
  roomId?: string | null;
  playerName?: string | null;
  factionId?: string | null;
  scenarioId?: number | null;
  buildVersion?: string;
  startWallMs: number;
}

/** How many entries we keep before dropping the oldest. */
const RING_SIZE = 5000;

/** localStorage key + debounce for cross-refresh persistence. Bumping the
 *  version suffix invalidates any old-shape payloads on upgrade. */
const STORAGE_KEY = 'orbital:gamelog:v1';
const PERSIST_DEBOUNCE_MS = 1500;

/** Probe whether localStorage is usable (it throws in private-mode Safari
 *  and when storage is disabled). Cached once at construction. */
function canUseStorage(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const k = '__orbital_ls_test__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

class GameLogger {
  private buffer: LogEntry[] = [];
  private head = 0;
  private size = 0;
  private currentTick: number | null = null;
  private session: SessionMeta = {
    mode: 'unknown',
    startWallMs: Date.now(),
  };
  /** Listeners notified after each new entry. UI uses this to refresh
   *  a "log size: NNN" badge without polling. */
  private listeners = new Set<() => void>();
  /** Cross-refresh persistence. The buffer is mirrored to localStorage so a
   *  page reload mid-game resumes the same log instead of starting blank. */
  private storageOk = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last non-null game id we attached to the log. Distinct from
   *  session.gameId (which gets nulled on exit-to-menu) so that exiting and
   *  re-entering the SAME game keeps the log, but entering a DIFFERENT game
   *  resets it — even with a menu visit in between. */
  private lastLoggedGameId: string | null = null;

  constructor() {
    this.storageOk = canUseStorage();
    this.restore();
  }

  // ---- Persistence ----

  /** Rehydrate the buffer + session from the last persisted snapshot. The
   *  saved entries are already chronological (oldest→newest), so we load
   *  them straight in with head=0. */
  private restore() {
    if (!this.storageOk) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as {
        entries?: LogEntry[];
        session?: SessionMeta;
        currentTick?: number | null;
        lastLoggedGameId?: string | null;
      };
      if (Array.isArray(obj.entries)) {
        this.buffer = obj.entries.slice(-RING_SIZE);
        this.size = this.buffer.length;
        this.head = 0;
      }
      // Keep the original session start (so the export's Duration spans the
      // whole game, not just since the last refresh) and the last tick.
      if (obj.session) this.session = { ...this.session, ...obj.session };
      if (obj.currentTick != null) this.currentTick = obj.currentTick;
      this.lastLoggedGameId = obj.lastLoggedGameId ?? obj.session?.gameId ?? null;
    } catch {
      /* corrupt / unavailable — start fresh */
    }
  }

  private schedulePersist() {
    if (!this.storageOk || this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Write the buffer to localStorage immediately. Called on a debounce
   *  after writes, and synchronously on tab-hide / unload so nothing in the
   *  debounce window is lost. */
  flush() {
    if (!this.storageOk) return;
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        session: this.session,
        currentTick: this.currentTick,
        lastLoggedGameId: this.lastLoggedGameId,
        entries: this.entries(),
      }));
    } catch {
      /* quota exceeded or storage disabled — drop silently */
    }
  }

  // ---- Configuration ----

  setCurrentTick(tick: number | null) {
    this.currentTick = tick;
  }

  setSession(partial: Partial<SessionMeta>) {
    this.session = { ...this.session, ...partial };
    // A new game id means a new game — drop the previous game's entries so
    // each game gets its own audit. Refreshing within the SAME game keeps
    // them (the id matches what restore() rehydrated), which is the whole
    // point of persistence. Compared against lastLoggedGameId (not the
    // just-overwritten session.gameId) so a menu visit in between is fine.
    if (partial.gameId) {
      if (this.lastLoggedGameId && partial.gameId !== this.lastLoggedGameId) {
        this.buffer = [];
        this.head = 0;
        this.size = 0;
      }
      this.lastLoggedGameId = partial.gameId;
    }
    this.info('SESSION', `Session metadata updated`, partial as Record<string, unknown>);
    this.flush();
  }

  getSession(): SessionMeta {
    return this.session;
  }

  // ---- Core write API ----

  log(level: LogLevel, category: LogCategory, msg: string, data?: Record<string, unknown>) {
    const entry: LogEntry = {
      wallMs: Date.now(),
      tick: this.currentTick,
      level,
      category,
      msg,
      data,
    };
    // Ring-buffer write
    if (this.size < RING_SIZE) {
      this.buffer.push(entry);
      this.size++;
    } else {
      this.buffer[this.head] = entry;
      this.head = (this.head + 1) % RING_SIZE;
    }
    // Notify (microtask so log calls inside React effects don't break renders)
    queueMicrotask(() => {
      for (const l of this.listeners) l();
    });
    this.schedulePersist();
  }

  info(category: LogCategory, msg: string, data?: Record<string, unknown>) {
    this.log('INFO', category, msg, data);
  }
  warn(category: LogCategory, msg: string, data?: Record<string, unknown>) {
    this.log('WARN', category, msg, data);
  }
  error(category: LogCategory, msg: string, data?: Record<string, unknown>) {
    this.log('ERROR', category, msg, data);
  }

  // ---- Read API ----

  /** Snapshot of all entries in chronological order (oldest → newest). */
  entries(): LogEntry[] {
    if (this.size < RING_SIZE) return this.buffer.slice();
    // Wrap: head points at the oldest slot
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  count(): number {
    return this.size;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  clear() {
    this.buffer = [];
    this.head = 0;
    this.size = 0;
    if (this.storageOk) {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
    for (const l of this.listeners) l();
  }

  // ---- Export ----

  /** Build the human-readable .txt body. */
  exportText(): string {
    const now = Date.now();
    const entries = this.entries();
    const s = this.session;
    const sessionDurMs = now - s.startWallMs;

    const header = [
      '=== ORBITAL GAME LOG ===',
      `Exported:       ${new Date(now).toISOString()}`,
      `Session start:  ${new Date(s.startWallMs).toISOString()}`,
      `Duration:       ${formatDuration(sessionDurMs)}`,
      `Mode:           ${s.mode}`,
      s.gameId       ? `Game ID:        ${s.gameId}` : null,
      s.roomId       ? `Room ID:        ${s.roomId}` : null,
      s.playerName   ? `Player:         ${s.playerName}` : null,
      s.factionId    ? `Faction:        ${s.factionId}` : null,
      s.scenarioId != null ? `Scenario:       ${s.scenarioId}` : null,
      s.buildVersion ? `Build:          ${s.buildVersion}` : null,
      `Viewport:       ${typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'unknown'}`,
      `User Agent:     ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `Last tick:      ${this.currentTick ?? 'n/a'}`,
      `Entries:        ${entries.length}`,
      '========================',
      '',
    ].filter(Boolean).join('\n');

    const body = entries.map(formatEntry).join('\n');
    return header + '\n' + body + '\n';
  }

  /** Trigger a browser download of the current log as a .txt file. */
  downloadText() {
    const text = this.exportText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `orbital-log-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, ' ');
}

function formatEntry(e: LogEntry): string {
  // [T+1234 18:42:11.567] [INFO] [SIM] message — data:{...}
  const tick = e.tick == null ? '   -' : `T+${pad(Math.floor(e.tick), 5)}`;
  const wall = new Date(e.wallMs).toISOString().slice(11, 23); // HH:MM:SS.mmm
  const dataStr = e.data && Object.keys(e.data).length
    ? '  ' + Object.entries(e.data)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(' ')
    : '';
  return `[${tick} ${wall}] [${e.level.padEnd(5)}] [${e.category.padEnd(8)}] ${e.msg}${dataStr}`;
}

function formatValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') {
    // Quote if it contains spaces or special chars
    return /[\s,{}]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Singleton — there's only ever one logger per session.
export const logger = new GameLogger();

// Dev-time global handle so playtest tooling / DevTools snippets can poke
// the logger without going through React. Harmless in prod (just exposes
// the same singleton everyone else imports).
if (typeof window !== 'undefined') {
  (window as unknown as { orbitalLogger: GameLogger }).orbitalLogger = logger;
}

// Install global error handlers (only in browser).
if (typeof window !== 'undefined') {
  const prevOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    logger.error('SYSTEM', `Uncaught error: ${message}`, {
      source: typeof source === 'string' ? source : undefined,
      line: lineno, col: colno,
      stack: error?.stack?.slice(0, 400),
    });
    if (typeof prevOnError === 'function') {
      return prevOnError(message, source, lineno, colno, error);
    }
    return false;
  };
  const prevOnRejection = window.onunhandledrejection;
  window.onunhandledrejection = (ev) => {
    const reason = ev.reason;
    logger.error('SYSTEM', `Unhandled rejection`, {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason?.stack?.slice?.(0, 400),
    });
    if (typeof prevOnRejection === 'function') {
      prevOnRejection.call(window, ev);
    }
  };
  // Tab visibility — useful to mark AFK gaps. Flush on hide so a tab that
  // gets backgrounded and then discarded keeps its log.
  document.addEventListener('visibilitychange', () => {
    logger.info('SYSTEM', `Tab ${document.visibilityState}`);
    if (document.visibilityState === 'hidden') logger.flush();
  });
  // Final flush on navigate-away / reload so nothing in the debounce window
  // is lost. pagehide fires more reliably than beforeunload on mobile.
  window.addEventListener('pagehide', () => logger.flush());

  // ----------------------------------------------------------------
  // Mirror console.error / console.warn into the logger so dev-time
  // warnings (React invariants, deprecation notices, "Cannot read X
  // of undefined" from third-party libs) show up in the exported log.
  // The original console methods are preserved so DevTools still
  // shows them with the right source-map links.
  //
  // Guards:
  //  - In-flight flag prevents recursion if logger code itself ever
  //    triggers a console call.
  //  - Bursts are rate-limited per second to avoid React StrictMode
  //    double-render warnings flooding the buffer.
  // ----------------------------------------------------------------
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  let inFlight = false;
  let lastBucketSec = 0;
  let bucketCount = 0;
  const PER_SECOND_CAP = 20;

  function captureConsole(level: 'ERROR' | 'WARN', args: unknown[]) {
    if (inFlight) return;
    inFlight = true;
    try {
      // Rate-limit so a render-loop warning storm doesn't fill the ring.
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== lastBucketSec) { lastBucketSec = sec; bucketCount = 0; }
      bucketCount++;
      if (bucketCount > PER_SECOND_CAP) {
        if (bucketCount === PER_SECOND_CAP + 1) {
          logger.log(level, 'SYSTEM', `console.${level.toLowerCase()} rate-limited (>${PER_SECOND_CAP}/s)`);
        }
        return;
      }
      const msg = args.map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ').slice(0, 800);
      const errorArg = args.find((a): a is Error => a instanceof Error);
      logger.log(level, 'SYSTEM', `console.${level.toLowerCase()}: ${msg}`, errorArg?.stack ? {
        stack: errorArg.stack.slice(0, 400),
      } : undefined);
    } finally {
      inFlight = false;
    }
  }

  console.error = (...args: unknown[]) => {
    captureConsole('ERROR', args);
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    captureConsole('WARN', args);
    origWarn(...args);
  };

  // Initial entry
  logger.info('SESSION', 'Logger initialized', {
    href: window.location.href,
    vp: `${window.innerWidth}x${window.innerHeight}`,
  });
}
