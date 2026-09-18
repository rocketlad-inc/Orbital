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
    if (sub) return 'subscribed';
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

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      state: permission === 'denied' ? 'denied' : 'default',
      error: permission === 'denied'
        ? 'Notifications are blocked for this site. Turn them back on in your browser settings for orbital-empire.com.'
        : undefined,
    };
  }

  const reg = await navigator.serviceWorker.ready;
  // userVisibleOnly is required by Chrome: every push must show a
  // notification, so this cannot be used for silent background work.
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.data.key),
  });

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
  if (!res.ok) {
    // Don't leave a browser subscription the server knows nothing about;
    // it would sit there receiving nothing forever.
    await sub.unsubscribe().catch(() => {});
    return { state: 'default', error: 'Could not register this device. Try again.' };
  }
  return { state: 'subscribed' };
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
