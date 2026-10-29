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
  /** An ad and a keyword, when the link names them (0180). */
  utm_content?: string;
  utm_term?: string;
  /** The ad network's click id (rdt_cid, gclid, ...) and whose it is. */
  click_kind?: string;
  click_id?: string;
  /** The app whose browser this opened in, from its android-app:// referrer. */
  in_app?: string;
  /** This browser's anonymous id, so signup can join its visit funnel. */
  anon?: string;
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
export const TAG_PARAMS = ['from', 'ref', 'by', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'rdt_cid', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid', 'twclid'];

/** Ad networks' click ids, in the order we look for them (worker/visits.js). */
const CLICK_IDS: ReadonlyArray<readonly [string, string]> = [
  ['rdt_cid', 'reddit'],
  ['gclid', 'google'], ['gbraid', 'google'], ['wbraid', 'google'],
  ['fbclid', 'meta'],
  ['ttclid', 'tiktok'],
  ['msclkid', 'microsoft'],
  ['twclid', 'x'],
];

/** Apps whose Android browser sends an android-app:// referrer naming
 *  them. Anything else stays "android-app" (Orbital's own app among them). */
const ANDROID_APPS: Record<string, string> = {
  'com.reddit.frontpage': 'reddit',
  'com.facebook.katana': 'facebook',
  'com.instagram.android': 'instagram',
  'com.discord': 'discord',
  'com.twitter.android': 'x',
  'com.zhiliaoapp.musically': 'tiktok',
  'com.ss.android.ugc.trill': 'tiktok',
  'com.google.android.googlequicksearchbox': 'google',
  'com.google.android.gm': 'gmail',
};

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
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
    const v = p.get(k);
    if (v) now[k] = v.slice(0, 80);
  }
  for (const [param, kind] of CLICK_IDS) {
    const v = p.get(param);
    if (v) { now.click_kind = kind; now.click_id = v.slice(0, 200); break; }
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
    if (ref.startsWith('android-app://')) {
      // An Android app's built-in browser names the app: the Reddit app's
      // is a Reddit visit, not one from Orbital's own app.
      const pkg = ref.slice('android-app://'.length).split('/')[0];
      const app = ANDROID_APPS[pkg];
      now.referrer = app ? `${app}.com` : 'android-app';
      if (app) now.in_app = app;
    } else {
      try {
        const host = new URL(ref).hostname;
        if (host && host !== url.hostname) now.referrer = host.slice(0, 100);
      } catch { /* not a URL */ }
    }
  }

  // TikTok's built-in browser sends no referrer, so a visit from a video
  // would be filed as "direct". It names itself in its User-Agent: say so,
  // and the server files it under "tiktok" (worker/attribution.js), for the
  // visit and for the account it becomes. A link tag still wins.
  if (!now.referrer && typeof navigator !== 'undefined' && /musical_ly|BytedanceWebview|TikTok/i.test(navigator.userAgent || '')) {
    now.referrer = 'tiktok.com';
    now.in_app = 'tiktok';
  }

  const stored = read();
  thisVisit = now;
  if (!stored || (!informative(stored) && informative(now))) write(now);
  // An invite arriving after some other first visit still says who brought
  // this person in: keep where they first came from, add the invite.
  else if (now.invite_code && !stored.invite_code) {
    write({ ...stored, invite: true, invite_code: now.invite_code, by: now.by });
  }

  // A visit that came from somewhere: count it before anyone signs up
  // (worker/visits.js), and watch how far it gets. One that came from
  // nowhere (typed or bookmarked) is counted as "direct" the first time
  // this browser shows up; the server leaves out signed-in players.
  if (informative(now)) beaconLanding(now);
  else if (trackedHere()) watchEngagement();
  else beaconLanding(now);

  if (TAG_PARAMS.some(k => p.has(k))) {
    for (const k of TAG_PARAMS) p.delete(k);
    const clean = url.pathname + (p.toString() ? `?${p}` : '') + url.hash;
    try { window.history.replaceState(window.history.state, '', clean); } catch { /* leave it */ }
  }
}

/** What signup sends: the first informative visit, else this one, with
 *  the browser's anonymous id so the server can join its visit funnel. */
export function attributionForSignup(): Attribution | null {
  if (typeof window === 'undefined') return null;
  const a = read() ?? thisVisit;
  if (!a) return null;
  const anon = anonId();
  return anon ? { ...a, anon } : a;
}

// ---- the visit funnel (0180, worker/visits.js) ------------------------
// One anonymous row per browser that arrived through a link, ad or other
// site, then one row per step on the sign-in screen. Fire and forget.

const TRACKED_KEY = 'orbital.visit';
const sent = new Set<string>();

export type VisitStep =
  | 'engaged' | 'read_more' | 'play_click' | 'signup_tab' | 'email_try' | 'login_try' | 'google_try' | 'auth_error' | 'google_error'
  // Try out a Solo Game on the sign-in page (Play for Free, worker/trial.js).
  | 'trial_click';

function trackedHere(): boolean {
  try { return window.localStorage.getItem(TRACKED_KEY) === '1'; } catch { return false; }
}

function postVisit(body: Record<string, unknown>): void {
  try {
    void fetch('/api/visit', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* best-effort */ });
  } catch { /* no fetch: nothing to count */ }
}

function beaconLanding(a: Attribution): void {
  const anon = anonId();
  if (!anon) return;
  postVisit({ anon, step: 'land', a });
  try { window.localStorage.setItem(TRACKED_KEY, '1'); } catch { /* this visit only */ }
  watchEngagement();
}

/** Record a step on the way to signing up, once per page load, and only
 *  for a browser whose arrival was counted. */
export function trackVisitStep(step: VisitStep): void {
  if (typeof window === 'undefined' || sent.has(step) || !trackedHere()) return;
  const anon = anonId();
  if (!anon) return;
  sent.add(step);
  postVisit({ anon, step });
}

/** "Engaged" = 10 s with the page visible, or any touch, key or scroll:
 *  tells a real look from a bounce or a stray tap on an ad. */
function watchEngagement(): void {
  if (typeof document === 'undefined' || sent.has('engaged')) return;
  let visibleMs = 0;
  let since = document.visibilityState === 'visible' ? Date.now() : 0;
  const stop = () => {
    clearInterval(timer);
    for (const ev of ['pointerdown', 'keydown', 'scroll', 'wheel'] as const) window.removeEventListener(ev, onTouch, true);
    document.removeEventListener('visibilitychange', onVis);
  };
  const hit = () => { stop(); trackVisitStep('engaged'); };
  const onTouch = () => hit();
  const onVis = () => {
    if (document.visibilityState === 'visible') since = Date.now();
    else if (since) { visibleMs += Date.now() - since; since = 0; }
  };
  const timer = window.setInterval(() => {
    const total = visibleMs + (since ? Date.now() - since : 0);
    if (total >= 10_000) hit();
  }, 1000);
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'wheel'] as const) window.addEventListener(ev, onTouch, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVis);
}
