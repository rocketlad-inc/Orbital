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
//   ?invite=<code>   a friend's game invite (the lobby reads it too)
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
  referrer?: string;
  landing?: string;
  first_seen_ms: number;
}

/** Link tags we read and then tidy out of the address bar, so a player
 *  who copies the URL to a friend doesn't pass our tag along with it. */
const TAG_PARAMS = ['from', 'ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

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
  if (p.get('invite')) now.invite = true;
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
