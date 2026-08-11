// ============================================================================
// admins.js — the single admin allow-list.
//
// This list decides who can read the analytics dashboard and who can
// grant/revoke premium entitlements. It used to be duplicated verbatim in
// analytics.js and store.js, which is a security-relevant kind of
// duplication: the failure mode isn't a bug, it's an admin who is REMOVED
// from one copy and keeps full access through the other. A second pair of
// eyes on a PR would have to notice both.
//
// One list, imported by both. Adding or removing an operator is a
// one-line change that cannot be half-applied.
//
// Comparison is lower-cased on both sides — email case is not
// significant, and an allow-list that can be bypassed by capitalising a
// letter is not an allow-list.
// ============================================================================

const ADMIN_EMAILS = new Set([
  'spaceboy1243@gmail.com',  // Lorne's play account ("Rocketlad")
  'lcfeeser@gmail.com',      // Lorne's infra account
  'lorne@bigtickets.com',    // Lorne's work account
]);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email ?? '').trim().toLowerCase());
}

/** True when the session belongs to an operator. Null/undefined-safe so
 *  callers can pass an unauthenticated session without a guard. */
export function isAdminSession(session) {
  return !!session && isAdminEmail(session.email);
}
