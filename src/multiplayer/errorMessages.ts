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
//
// COPY RULES — this text is the game talking to a player, not the
// system talking to a developer:
//   - No "Server:" prefix. The player doesn't care which box refused;
//     they care what happened and what to do next. (Every string here
//     used to lead with it.)
//   - Never name dev-only affordances. A message once told players to
//     "grant resources via the admin panel" — a host tool they can't see.
//   - Say the next action, and make sure it's reachable from where the
//     player is standing (see 'no_slots': a city has no Shipyard option,
//     so the copy has to name the Station prerequisite).
// ============================================================

export type MpErrorDomain =
  | 'build'
  | 'deploy'
  | 'transfer'
  | 'research'
  | 'tbm'
  | 'ram'
  | 'rename'
  | 'orders';

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
      return 'You are not in this game. Re-enter the room and try again.';

    case 'not_owner':
      // Build → you tried to queue on someone else's body. Transfer →
      // you tried to redirect someone else's ship. Either way the
      // underlying action is the same: the resource isn't yours.
      switch (domain) {
        case 'build':    return 'You no longer own this body. Recapture it before queuing builds here.';
        case 'transfer': return 'You no longer own this ship — it may have been captured or destroyed.';
        case 'rename':   return 'You no longer own this ship or settlement.';
        case 'orders':   return 'One of the selected ships is not yours — no orders were changed.';
        default:         return `You do not own this resource (${fallback}).`;
      }

    case 'not_researched':
      // Research gating. The server's message already names the exact
      // feature, track and level ("Frigate unlocks at Construction level
      // 3"), which is strictly more useful than anything generic we
      // could write here — so pass it straight through. Reaching this at
      // all means a stale bundle let a locked control stay clickable.
      return fallback;

    case 'not_host':
      // Currently only TBM toggle returns this — non-hosts trying to
      // change game-wide settings.
      return 'Only the host can change this setting.';

    case 'not_found':
      switch (domain) {
        case 'build':    return 'This body no longer exists in the game.';
        case 'deploy':   return 'This body no longer exists in the game.';
        case 'transfer': return 'Target body or ship no longer exists.';
        case 'rename':   return 'This ship or settlement no longer exists.';
        case 'orders':   return 'One of the selected ships no longer exists — no orders were changed.';
        default:         return `Resource not found (${fallback}).`;
      }

    case 'insufficient_resources':
      // Each domain spends a different resource pool. Be explicit
      // because "insufficient resources" alone leaves the player
      // hunting for which meter to top up.
      switch (domain) {
        case 'build':    return 'Not enough metal + credits. Wait for income from your settlements.';
        case 'deploy':   return 'Not enough metal + credits. Wait for income from your settlements, or trade for what you need.';
        case 'research': return `Not enough science. ${fallback}`;
        default:         return `Insufficient resources (${fallback}).`;
      }

    case 'tech_maxed':
      return 'This tech is already at the global cap.';

    case 'no_presence':
      // Legacy deploy gate (pre colony-ship split) — kept so an older
      // server bundle still gets sensible copy.
      return 'No qualifying ship of yours parked here yet.';

    case 'need_colony_ship':
      // Colony/freighter split: cities always consume a Colony Ship;
      // stations need one too unless you already own a settlement at
      // the body (then they're built from orbit for metal + credits).
      return 'Needs a Colony Ship of yours in orbit here — deploying consumes it. (Stations can instead be built from orbit for resources where you already own a settlement.)';

    case 'no_surface':
      return 'A city cannot be deployed on this body type — stars, gas giants and ice giants have no surface.';

    case 'no_slots':
      // Shipyards are STATION_BUILDINGS, so "build a Shipyard" is not
      // actionable from a city — the buildings strip there only offers
      // forge / mint / lab. Naming the station prerequisite keeps the
      // advice from dead-ending the one player who most needs it.
      return 'All build slots at this body are busy. Wait for one to finish, or deploy a Station here and add a Shipyard to it for more slots.';

    case 'occupied':
      return 'This body already has that settlement type — only one city and one station per body.';

    // Lobby / designer / orders codes
    case 'color_taken':
      return 'That color is too close to another player\'s — pick something more distinct.';
    case 'already_cancelled':
      return 'This build was already cancelled.';
    case 'no_detonator':
      return 'This ship carries no detonator — fit one in the Ship Designer before building it.';
    case 'in_transit':
      return 'Cannot detonate mid-transfer — wait for the ship to arrive.';

    // RAM-specific codes
    case 'wrong_type':
      return 'Only rogue asteroid bodies can be rammed.';
    case 'already_ramming':
      return 'This asteroid already has a ram in flight.';
    case 'no_settlement':
      return 'You need a settlement on this asteroid to ram.';
    case 'no_thrusters':
      return 'Build Trajectory Control Thrusters first.';
    case 'insufficient_fuel':
      // Legacy code from when rams charged fuel — the server now charges
      // metal (insufficient_resources). Kept as a fallback for an old
      // worker bundle mid-deploy.
      return 'Not enough resources to launch this ram.';
    case 'destroyed':
      return 'This body has been destroyed.';

    case 'bad_request':
      // bad_request typically indicates a client-server schema drift
      // (an old bundle still cached). Tell the user to refresh.
      return `This client sent an invalid request — try refreshing the page. (${fallback})`;

    case 'network_error':
      return 'Network: could not reach the server. Check your connection and try again.';

    case 'no_backend':
      return 'Multiplayer backend is offline. Try again in a moment.';

    default:
      // Unmapped code — show the freeform message, keeping the raw code
      // in parens so a new server-side rejection is still identifiable in
      // a bug report without the copy reading like a stack trace.
      return code ? `${fallback} (${code})` : fallback;
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
