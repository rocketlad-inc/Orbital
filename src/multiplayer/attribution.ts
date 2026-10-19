// ============================================================
// Where a player found the game.
//
// Captured on the FIRST visit that says anything about it, kept in
// localStorage (so it survives the Google sign-in round trip and a few
// days of "I'll sign up later"), and sent once with signup. The server
// cleans it and stamps it on the new account; nothing here is trusted.
//
// Signals, strongest first:
//   ?from=<tag>      our own link tag, one per post ("r-4xgaming")
//   ?utm_source=...  the standard tag other tools write
//   ?invite=<code>   a friend's game invite (the lobby reads it too);
//                    &by=<user id> names who sent it (0175)
//   the referrer     the site the visitor came from, host only
//
// Reddit, X and most social sites send only their origin as the
// referrer, so "reddit" is as specific as the referrer gets. The ?from
// tag is what tells one post from another.
// ============================================================

const STORE_KEY = 'orbital.attribution';

export interface Attribution {
  from?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  invite?: boolean;
  /** The room code and the sender named on an invite link (0175). */
  invite_code?: string;
  by?: string;
  referrer?: string;
  landing?: string;
  first_seen_ms: number;
}

/** Link tags we read and then tidy out of the address bar, so a player
 *  who copies the URL to a friend doesn't pass our tag along with it. */
export const TAG_PARAMS = ['from', 'ref', 'by', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

const ANON_KEY = 'orbital.anon';

/** A random id this browser keeps, so one person opening an invite link
 *  twice counts once. Not an account and never joined to one. */
function anonId(): string | null {
  try {
    let id = window.localStorage.getItem(ANON_KEY);
    if (!id) {
      const a = new Uint8Array(12);
      crypto.getRandomValues(a);
      id = Array.from(a, b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(b % 64)).join('');
      window.localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch { return null; }
}

/** Tell the server an invite link was opened (worker/invites.js). Fire
 *  and forget: signed in or not, it only counts. */
function beaconInviteOpen(code: string, by: string | undefined): void {
  const anon = anonId();
  if (!anon) return;
  try {
    void fetch('/api/invite/open', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, by, anon }),
    }).catch(() => { /* best-effort */ });
  } catch { /* no fetch: nothing to count */ }
}

function read(): Attribution | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Attribution) : null;
  } catch { return null; }
}

function write(a: Attribution): void {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch { /* private mode: this visit only */ }
}

let thisVisit: Attribution | null = null;

/** True when a record says where the visitor came from, rather than
 *  "typed the address". A later informative visit may replace an
 *  uninformative first one, never the other way round. */
function informative(a: Attribution | null): boolean {
  return !!a && !!(a.from || a.utm_source || a.invite || a.referrer);
}

/** Call once at startup, before anything rewrites the URL. */
export function captureAttribution(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const p = url.searchParams;
  const now: Attribution = { first_seen_ms: Date.now(), landing: url.pathname.slice(0, 100) };
  const from = p.get('from') || p.get('ref');
  if (from) now.from = from.slice(0, 60);
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign'] as const) {
    const v = p.get(k);
    if (v) now[k] = v.slice(0, 60);
  }
  const invite = (p.get('invite') ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (invite) {
    now.invite = true;
    if (invite.length === 8) now.invite_code = invite;
    const by = p.get('by');
    if (by && /^[A-Za-z0-9_-]{16}$/.test(by)) now.by = by;
    if (now.invite_code) beaconInviteOpen(now.invite_code, now.by);
  }
  const ref = typeof document !== 'undefined' ? document.referrer : '';
  if (ref) {
    if (ref.startsWith('android-app://')) now.referrer = 'android-app';
    else {
      try {
        const host = new URL(ref).hostname;
        if (host && host !== url.hostname) now.referrer = host.slice(0, 100);
      } catch { /* not a URL */ }
    }
  }

  const stored = read();
  thisVisit = now;
  if (!stored || (!informative(stored) && informative(now))) write(now);
  // An invite arriving after some other first visit still says who brought
  // this person in: keep where they first came from, add the invite.
  else if (now.invite_code && !stored.invite_code) {
    write({ ...stored, invite: true, invite_code: now.invite_code, by: now.by });
  }

  if (TAG_PARAMS.some(k => p.has(k))) {
    for (const k of TAG_PARAMS) p.delete(k);
    const clean = url.pathname + (p.toString() ? `?${p}` : '') + url.hash;
    try { window.history.replaceState(window.history.state, '', clean); } catch { /* leave it */ }
  }
}

/** What signup sends: the first informative visit, else this one. */
export function attributionForSignup(): Attribution | null {
  if (typeof window === 'undefined') return null;
  return read() ?? thisVisit;
}
