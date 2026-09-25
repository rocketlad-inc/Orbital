// ============================================================
// Turning phone notifications on, from the player's side.
//
// THE PERMISSION IS ASKED ONCE AND NEVER GIVEN BACK. A browser that has
// been refused will not re-prompt; the player has to dig through site
// settings, which in practice means never. So Orbital does not ask on
// load, or on first game, or on any moment it picked for itself — it
// asks only when someone presses the button that says it will ask. That
// is also what Chrome's own heuristics reward.
//
// Three states worth distinguishing, because the recovery differs:
//   unsupported  no service worker or no PushManager (old browser, or
//                iOS Safari before a home-screen install)
//   denied       asked and refused; only site settings can undo it
//   default      never asked — the button can still work
// ============================================================

import { apiFetch } from '../multiplayer/api';

export type PushState = 'unsupported' | 'denied' | 'default' | 'subscribed';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PROMPT_TIMEOUT_MS = 20_000;
const TIMED_OUT = Symbol('timed out');

const MANUAL_ALLOW =
  'Your phone did not show the permission prompt. Open Android Settings → Apps → Orbital → '
  + 'Notifications, allow them, then come back and press Turn on notifications again.';

/** The promise's value, or TIMED_OUT if it has not settled in `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise(resolve => {
    const t = window.setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      v => { window.clearTimeout(t); resolve(v); },
      () => { window.clearTimeout(t); resolve(TIMED_OUT); },
    );
  });
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    // THE BROWSER HOLDING A SUBSCRIPTION IS NOT THE SERVER KNOWING IT.
    // This used to answer 'subscribed' from the browser alone, so a
    // phone whose registration never reached the server (or was dropped
    // there) showed "Send a test" and got "not subscribed yet" back.
    // Re-sending is an idempotent upsert, so doing it on every look is
    // also what heals such a phone; only a server that accepts it counts.
    if (sub) return (await registerWithServer(sub)) ? 'subscribed' : 'default';
  } catch { /* fall through to the permission state */ }
  return Notification.permission === 'granted' ? 'default' : 'default';
}

/** Ask, subscribe, and register the device. Returns the new state and,
 *  when it failed, something a player can act on. */
export async function enablePush(): Promise<{ state: PushState; error?: string }> {
  if (!pushSupported()) {
    return { state: 'unsupported', error: 'This browser cannot do notifications.' };
  }

  const keyRes = await apiFetch<{ key: string }>('/api/push/key');
  if (!keyRes.ok) return { state: 'default', error: 'The server is not set up for notifications yet.' };

  // NEITHER WAIT BELOW MAY HANG FOREVER. Inside the Android app the
  // permission prompt is shown by the app on the page's behalf, and an
  // app build that cannot show it leaves requestPermission() pending
  // for good -- the button sat on "Asking..." with nothing to do. A
  // timeout turns that into an instruction a player can follow.
  const permission = await withTimeout(Notification.requestPermission(), PROMPT_TIMEOUT_MS);
  if (permission === TIMED_OUT) {
    return { state: 'default', error: MANUAL_ALLOW };
  }
  if (permission !== 'granted') {
    return {
      state: permission === 'denied' ? 'denied' : 'default',
      error: permission === 'denied'
        ? 'Notifications are blocked for this site. Turn them back on in your browser settings for orbital-empire.com.'
        : undefined,
    };
  }

  // `ready` never settles on a page whose service worker failed to
  // register; the same timeout keeps that from reading as a hang.
  const reg = await withTimeout(navigator.serviceWorker.ready, PROMPT_TIMEOUT_MS);
  if (reg === TIMED_OUT) {
    return { state: 'default', error: 'Notifications could not start on this device. Close Orbital completely, reopen it, and try again.' };
  }
  // userVisibleOnly is required by Chrome: every push must show a
  // notification, so this cannot be used for silent background work.
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.data.key),
  });

  if (!(await registerWithServer(sub))) {
    // Don't leave a browser subscription the server knows nothing about;
    // it would sit there receiving nothing forever.
    await sub.unsubscribe().catch(() => {});
    return { state: 'default', error: 'Could not register this device. Try again.' };
  }
  return { state: 'subscribed' };
}

/** Store this browser's subscription on the server. True when it took. */
async function registerWithServer(sub: PushSubscription): Promise<boolean> {
  const res = await apiFetch<{ ok: boolean }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: bufToB64url(sub.getKey('p256dh')),
        auth: bufToB64url(sub.getKey('auth')),
      },
    }),
  });
  return res.ok;
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await apiFetch('/api/push/unsubscribe', {
    method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe().catch(() => {});
}

/** Prove it works, now, rather than waiting for a game event. */
export async function sendTestPush(): Promise<string | null> {
  const res = await apiFetch<{ ok: boolean }>('/api/push/test', { method: 'POST' });
  return res.ok ? null : (res.error?.message ?? 'Could not send a test notification.');
}
