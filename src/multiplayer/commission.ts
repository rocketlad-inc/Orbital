// ============================================================
// commission — one voice for the Commander's Commission.
//
// Every surface that shows the Commission (profile hangar, lobby flag
// picker, designer preview, end of game, the 20-hour thank-you card)
// says the same plain facts, logs a view and a click the same way, and
// follows the same rules (docs: Oct 5 insight report, "Guardrails"):
//
//   - show the goods; ask at most once per moment, never mid-play
//   - every card dismisses for good
//   - nothing that touches the game is for sale
//   - the Android app shows no buy button (store rules): it can name the
//     Commission, never sell it
//
// The facts are COMPUTED from the same sets the pickers lock, so the copy
// can never undersell the goods again (the old pitch said "ten ship
// lines" for a long while after there were sixteen).
// ============================================================

import { apiFetch, CommissionSurface } from './api';
import { PREMIUM_VARIANTS } from '../components/ShipIcons';
import { PREMIUM_EMBLEM_IDS } from '../game/emblems';
import { premiumStructureLookCount } from '../components/StructureIcons';
import { isAndroidApp } from '../platform/appShell';
import { TELEMETRY_SESSION_ID } from './telemetry';

export const COMMISSION_NAME = 'Commander’s Commission';
export const COMMISSION_PRICE = '$10';
export const COMMISSION_LINES = PREMIUM_VARIANTS.size;
export const COMMISSION_EMBLEMS = PREMIUM_EMBLEM_IDS.length;
/** Every megastructure look beyond the one free look per kind. */
export const COMMISSION_STRUCTURE_LOOKS = premiumStructureLookCount();

/** The whole offer in one calm sentence, for any surface. */
export const COMMISSION_FACTS =
  `${COMMISSION_LINES} ship lines for every hull, ${COMMISSION_EMBLEMS} flag emblems and `
  + `${COMMISSION_STRUCTURE_LOOKS} megastructure looks. Cosmetic only. ${COMMISSION_PRICE}, once.`;

/** The holder mark on rosters and standings. Not ★, which already
 *  means "owned" on the map. */
export const HOLDER_MARK = '❖';
export const HOLDER_TITLE = `Holds the ${COMMISSION_NAME} — supports Orbital`;

/** Can this client SELL it? False in the Android app, where the store
 *  requires purchases of digital goods to go elsewhere. Showing and
 *  previewing the goods is fine everywhere; a buy button is not. */
export function canBuyHere(): boolean {
  return !isAndroidApp();
}

const viewed = new Set<string>();

/** Log a surface event: a view (once per surface per page load), a
 *  click, or a dismissal. Fire-and-forget, like all telemetry. */
export function logCommission(surface: CommissionSurface, action: 'view' | 'click' | 'dismiss'): void {
  if (action === 'view') {
    if (viewed.has(surface)) return;
    viewed.add(surface);
  }
  void apiFetch('/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({
      session_id: TELEMETRY_SESSION_ID,
      kind: `commission-${action}`,
      payload: { from: surface },
    }),
  }).catch(() => { /* best-effort */ });
}

/** Answer the one-time thank-you card. Recorded once server-side; it
 *  never comes back, whatever was chosen. */
export function answerCommissionAsk(action: 'clicked' | 'dismissed'): void {
  void apiFetch('/api/users/me/commission-ask', {
    method: 'POST',
    body: JSON.stringify({ action }),
  }).catch(() => { /* best-effort */ });
}
