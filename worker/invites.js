// ============================================================
// invites — who brought whom (migration 0175).
//
// An invite is a room code shared as a link: ?invite=CODE&by=<user id>.
// Three facts are kept, so an invite can be followed from the share to
// the friend's first game:
//
//   POST /api/invite/open   a link was opened (signed in or not); one
//                           row per link per browser, never trusted for
//                           anything but counting
//   stampReferral           on signup: who invited the new account
//   join_method             on every room seat: how it was taken
//
// The inviter is the ?by= on the link when it names a real account other
// than the new one; a code with no (or a bad) ?by= falls back to the host
// of the code's room, marked referred_how = 'host' because it is a guess
// (any member could have shared the code).
// ============================================================

export const INVITE_CODE_RE = /^[A-Z2-9]{8}$/;
export const USER_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ANON_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** A room code as a link carries it: upper-cased, separators dropped. */
export function cleanInviteCode(v) {
  if (typeof v !== 'string') return null;
  const c = v.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return INVITE_CODE_RE.test(c) ? c : null;
}

/** Record who invited a NEW account. Only ever fills an empty column, so
 *  a retry or a later sign-in cannot rewrite it. Best-effort. */
export async function stampReferral(db, userId, { inviteCode, by }) {
  const code = cleanInviteCode(inviteCode);
  if (!code) return;
  try {
    // Only a code that names a real room counts as an invitation.
    const room = await db.prepare('SELECT host_id FROM rooms WHERE invite_code = ?').bind(code).first();
    if (!room) return;
    let referredBy = null;
    let how = null;
    if (typeof by === 'string' && USER_ID_RE.test(by) && by !== userId) {
      const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(by).first();
      if (u) { referredBy = u.id; how = 'link'; }
    }
    if (!referredBy && room.host_id && room.host_id !== userId) { referredBy = room.host_id; how = 'host'; }
    await db
      .prepare(`UPDATE users SET signup_invite_code = ?, referred_by = ?, referred_how = ?
                 WHERE id = ? AND signup_invite_code IS NULL AND referred_by IS NULL`)
      .bind(code, referredBy, how, userId)
      .run();
  } catch (e) {
    console.error('stampReferral failed', e);
  }
}

/** POST /api/invite/open { code, by, anon } — an invite link was opened. */
async function handleInviteOpen(req, env, { session }) {
  const body = await req.json().catch(() => null);
  const code = cleanInviteCode(body?.code);
  const anon = typeof body?.anon === 'string' && ANON_RE.test(body.anon) ? body.anon : null;
  if (!code || !anon) return new Response(null, { status: 204 });
  const by = typeof body?.by === 'string' && USER_ID_RE.test(body.by) ? body.by : null;
  try {
    await env.DB
      .prepare(`INSERT OR IGNORE INTO invite_opens (code, anon_id, by_user, user_id, opened_at)
                VALUES (?, ?, ?, ?, ?)`)
      .bind(code, anon, by, session?.user_id ?? null, Date.now())
      .run();
  } catch (e) {
    console.error('invite open failed', e);
  }
  return new Response(null, { status: 204 });
}

export const routes = [
  { method: 'POST', pattern: '/api/invite/open', auth: 'optional', handle: handleInviteOpen },
];
