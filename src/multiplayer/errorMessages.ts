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

import { t } from '../i18n/core';

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
      return t('mp.err.notMember');

    case 'not_owner':
      // Build → you tried to queue on someone else's body. Transfer →
      // you tried to redirect someone else's ship. Either way the
      // underlying action is the same: the resource isn't yours.
      switch (domain) {
        case 'build':    return t('mp.err.ownBuild');
        case 'transfer': return t('mp.err.ownTransfer');
        case 'rename':   return t('mp.err.ownRename');
        case 'orders':   return t('mp.err.ownOrders');
        default:         return t('mp.err.ownDefault', { fallback });
      }

    case 'on_delivery':
      // Freighter is hauling an inter-player trade shipment — the
      // delivery autopilot owns its movement until the cargo lands.
      return t('mp.err.onDelivery');

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
      return t('mp.err.notHost');

    case 'not_found':
      switch (domain) {
        case 'build':    return t('mp.err.gone');
        case 'deploy':   return t('mp.err.gone');
        case 'transfer': return t('mp.err.goneTransfer');
        case 'rename':   return t('mp.err.goneRename');
        case 'orders':   return t('mp.err.goneOrders');
        default:         return t('mp.err.goneDefault', { fallback });
      }

    case 'insufficient_resources':
      // Each domain spends a different resource pool. Be explicit
      // because "insufficient resources" alone leaves the player
      // hunting for which meter to top up.
      switch (domain) {
        case 'build':    return t('mp.err.poorBuild');
        case 'deploy':   return t('mp.err.poorDeploy');
        case 'research': return t('mp.err.poorResearch', { fallback });
        default:         return t('mp.err.poorDefault', { fallback });
      }

    case 'tech_maxed':
      return t('mp.err.techMaxed');

    case 'no_presence':
      // Legacy deploy gate (pre colony-ship split) — kept so an older
      // server bundle still gets sensible copy.
      return t('mp.err.noPresence');

    case 'need_colony_ship':
      // Colony/freighter split: cities always consume a Colony Ship;
      // stations need one too unless you already own a settlement at
      // the body (then they're built from orbit for metal + credits).
      return t('mp.err.needColony');

    case 'no_surface':
      return t('mp.err.noSurface');

    case 'too_fast':
      // worker/legGuard.js: the leg is faster than this hull's engines.
      // Only a modified client, or one planning on a stale burn for a
      // tick after a change, ever sees it.
      return t('mp.err.tooFast');

    case 'gate_in_flight':
      // worker/actions.js emergingTargetRefusal.
      return t('mp.err.gateInFlight');

    case 'monster':
      // worker/wars.js: no declaring on, or making peace with, the Leviathan.
      return t('mp.err.monster');

    case 'not_terraformed':
      return t('mp.err.notTerraformed');

    // --- Trade-route taxonomy rejections (terraforming rework) ---
    case 'origin_not_terraformed':
      return t('mp.err.originNotTerraformed');
    case 'cannot_terraform':
      return t('mp.err.cannotTerraform');
    case 'unscouted':
      return t('mp.err.unscouted');
    case 'not_controller':
      return t('mp.err.notController');
    case 'no_dest_settlement':
      return t('mp.err.noDestSettlement');
    case 'no_origin_settlement':
      return t('mp.err.noOriginSettlement');
    case 'no_dest_collector':
      return t('mp.err.noDestCollector');
    case 'no_pickup_collector':
      return t('mp.err.noPickupCollector');

    case 'no_slots':
      // Shipyards are STATION_BUILDINGS, so "build a Shipyard" is not
      // actionable from a city — the buildings strip there only offers
      // forge / mint / lab. Naming the station prerequisite keeps the
      // advice from dead-ending the one player who most needs it.
      return t('mp.err.noSlots');

    case 'occupied':
      return t('mp.err.occupied');

    // Lobby / designer / orders codes
    case 'color_taken':
      return t('mp.err.colorTaken');
    case 'already_cancelled':
      return t('mp.err.alreadyCancelled');
    case 'no_detonator':
      return t('mp.err.noDetonator');
    case 'in_transit':
      return t('mp.err.inTransit');

    // RAM-specific codes
    case 'wrong_type':
      return t('mp.err.wrongType');
    case 'already_ramming':
      return t('mp.err.alreadyRamming');
    case 'no_settlement':
      return t('mp.err.noSettlement');
    case 'no_thrusters':
      return t('mp.err.noThrusters');
    case 'insufficient_fuel':
      // Legacy code from when rams charged fuel — the server now charges
      // metal (insufficient_resources). Kept as a fallback for an old
      // worker bundle mid-deploy.
      return t('mp.err.insufficientFuel');
    case 'destroyed':
      return t('mp.err.destroyed');

    case 'bad_request':
      // bad_request typically indicates a client-server schema drift
      // (an old bundle still cached). Tell the user to refresh.
      return t('mp.err.badRequest', { fallback });

    case 'network_error':
      return t('mp.err.networkError');

    case 'no_backend':
      return t('mp.err.noBackend');

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
