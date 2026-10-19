// ============================================================
// invite — the one way the game hands out an invitation.
//
// Every invite button (the new-room screen, the lobby strip, the host's
// in-game button) shares the same thing: a LINK, not a bare code. A
// link opens straight into the room, skips the password (the code is
// the proof of invitation), and names who sent it (?by=), so the game
// can tell who brings players in (worker/invites.js, migration 0175).
//
// On a phone layout the system share sheet opens (the same rule as the
// battle-recap share: touch UI follows the layout, never the pointer);
// anywhere else the link is copied. Either way one event is logged, so
// the dashboard can count shares by where they happened.
// ============================================================

import { apiFetch } from './api';
import { TELEMETRY_SESSION_ID } from './telemetry';
import { WEBSITE_ORIGIN, isAndroidApp } from '../platform/appShell';

/** Where an invite was shared from, for the dashboard. */
export type InviteWhere = 'created' | 'lobby' | 'game';

/** The link to a room, naming its sender. The website's address even in
 *  the app, so the friend opens it in any browser. */
export function inviteLink(code: string, byUserId?: string | null): string {
  const origin = isAndroidApp() || typeof window === 'undefined' ? WEBSITE_ORIGIN : window.location.origin;
  const by = byUserId ? `&by=${encodeURIComponent(byUserId)}` : '';
  return `${origin}/?invite=${encodeURIComponent(code)}${by}`;
}

function log(kind: 'invite-share' | 'invite-copy', where: InviteWhere): void {
  void apiFetch('/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({ session_id: TELEMETRY_SESSION_ID, kind, payload: { from: where } }),
  }).catch(() => { /* best-effort */ });
}

/**
 * Share a room invite: the share sheet on a phone layout, else copy the
 * link. Resolves to what happened, so the button can say so.
 */
export async function shareInvite(opts: {
  code: string;
  byUserId?: string | null;
  roomName?: string | null;
  text: string;
  where: InviteWhere;
  isMobile: boolean;
}): Promise<'shared' | 'copied' | 'failed'> {
  const url = inviteLink(opts.code, opts.byUserId);
  if (opts.isMobile && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: opts.roomName ?? 'Orbital', text: opts.text, url });
      log('invite-share', opts.where);
      return 'shared';
    } catch { /* dismissed or unsupported: fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    log('invite-copy', opts.where);
    return 'copied';
  } catch {
    return 'failed';
  }
}
