// ============================================================
// Humanize MP server error codes into actionable English.
//
// Background: every action in MultiplayerActionsContext used to swallow
// server rejections with a console.warn and return Promise<boolean>.
// The UI then looked like the click had worked, until the next /state
// poll rewound the optimistic local change and the user was left
// staring at an unexplained reset ("I lick the button then it resets").
//
// We now return {ok,code,error} from every action and route the code
// through this helper to a domain-aware message. Codes are shared
// across endpoints (not_member / not_owner / insufficient_resources /
// not_found / bad_request) so one switch with a `domain` discriminator
// keeps the copy contextual without duplicating mappings.
// ============================================================

export type MpErrorDomain =
  | 'build'
  | 'deploy'
  | 'transfer'
  | 'research'
  | 'tbm';

/**
 * Map a server error code to a user-facing string.
 *
 * @param code     The short code from the worker (e.g. 'insufficient_resources').
 *                 May be undefined if the request never made it to the API
 *                 (network error) — fallback string is used instead.
 * @param fallback Freeform message from the server payload, or a hard-coded
 *                 client default ("Server rejected the X.") — shown when the
 *                 code isn't one we recognize.
 * @param domain   Which action surfaced the error. Lets the helper say
 *                 "not enough ore + credits" for a build and "not enough
 *                 science" for a research without two mapping tables.
 */
export function humanizeMpError(
  code: string | undefined,
  fallback: string,
  domain: MpErrorDomain,
): string {
  switch (code) {
    case 'not_member':
      return 'Server: you are not in this game. Re-enter the room and try again.';

    case 'not_owner':
      // Build → you tried to queue on someone else's body. Transfer →
      // you tried to redirect someone else's ship. Either way the
      // underlying action is the same: the resource isn't yours.
      switch (domain) {
        case 'build':    return 'Server: you no longer own this body. Recapture it before queuing builds here.';
        case 'transfer': return 'Server: you no longer own this ship — it may have been captured or destroyed.';
        default:         return `Server: you do not own this resource (${fallback}).`;
      }

    case 'not_host':
      // Currently only TBM toggle returns this — non-hosts trying to
      // change game-wide settings.
      return 'Server: only the host can change this setting.';

    case 'not_found':
      switch (domain) {
        case 'build':    return 'Server: this body no longer exists in the game.';
        case 'deploy':   return 'Server: this body no longer exists in the game.';
        case 'transfer': return 'Server: target body or ship no longer exists.';
        default:         return `Server: resource not found (${fallback}).`;
      }

    case 'insufficient_resources':
      // Each domain spends a different resource pool. Be explicit
      // because "insufficient resources" alone leaves the player
      // hunting for which meter to top up.
      switch (domain) {
        case 'build':    return 'Server: not enough ore + credits. Wait for income from your settlements.';
        case 'deploy':   return 'Server: not enough ore + credits. Wait for income or grant resources via the admin panel.';
        case 'research': return `Server: not enough science. ${fallback}`;
        default:         return `Server: insufficient resources (${fallback}).`;
      }

    case 'tech_maxed':
      return 'Server: this tech is already at the global cap.';

    case 'no_presence':
      return 'Server: a freighter must be in orbit at this body to deploy. Send one and try again.';

    case 'no_surface':
      return 'Server: a city cannot be deployed on this body type (stars / gas giants / ice giants have no surface).';

    case 'bad_request':
      // bad_request typically indicates a client-server schema drift
      // (an old bundle still cached). Tell the user to refresh.
      return `Server: this client sent an invalid request — try refreshing the page. (${fallback})`;

    case 'network_error':
      return 'Network: could not reach the server. Check your connection and try again.';

    case 'no_backend':
      return 'Multiplayer backend is offline. Try again in a moment.';

    default:
      // Unmapped code — show the freeform message plus the code so
      // we can spot new server-side rejections during dev.
      return code ? `Server (${code}): ${fallback}` : `Server: ${fallback}`;
  }
}

/**
 * Convenience: pull the code + message out of an action result and
 * humanize in one step. Returns null for ok results so callers can
 * write `setError(humanizeActionResult(res, 'build'))` straight up.
 */
export function humanizeActionResult(
  result: { ok: true } | { ok: false; code?: string; error: string },
  domain: MpErrorDomain,
): string | null {
  if (result.ok) return null;
  return humanizeMpError(result.code, result.error, domain);
}
