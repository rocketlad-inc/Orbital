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
import { CITY_SKINS, STATION_SKINS } from '../game/settlementSkins';
import { isAndroidApp } from '../platform/appShell';
import { TELEMETRY_SESSION_ID } from './telemetry';

export const COMMISSION_NAME = 'Commander’s Commission';
export const COMMISSION_PRICE = '$10';
export const COMMISSION_LINES = PREMIUM_VARIANTS.size;
export const COMMISSION_EMBLEMS = PREMIUM_EMBLEM_IDS.length;
/** Every megastructure look beyond the one free look per kind. */
export const COMMISSION_STRUCTURE_LOOKS = premiumStructureLookCount();
/** Colony and station styles beyond the free one of each (0154). */
export const COMMISSION_CITY_SKINS = CITY_SKINS.filter(s => !s.free).length;
export const COMMISSION_STATION_SKINS = STATION_SKINS.filter(s => !s.free).length;

/** THE DISCORD PERK (worker/gameFeed.js, YOUR OWN SERVER): a host's game
 *  posts into their own Discord server. Said the same way on every surface
 *  that sells the Commission (Lorne, 2026-10-06: "make sure Discord bot is
 *  clearly outlined anywhere we are selling the commission"). */
export const COMMISSION_DISCORD = 'your games in your own Discord server';
export const COMMISSION_DISCORD_DETAIL =
  'Host a game and its wars, battles, Senate votes and daily Herald post straight into a channel '
  + 'on your own Discord server, with a link that lets your friends join.';
/** What the Commission never sells. It replaced "Cosmetic only", which
 *  stopped being the whole truth once the Discord perk joined; this is
 *  the rule itself. */
export const COMMISSION_NO_GAMEPLAY = 'Nothing that changes the game.';

/** The whole offer in one calm sentence, for any surface. */
export const COMMISSION_FACTS =
  `${COMMISSION_LINES} ship lines for every hull, ${COMMISSION_EMBLEMS} flag emblems, `
  + `${COMMISSION_CITY_SKINS} colony and ${COMMISSION_STATION_SKINS} station styles, `
  + `${COMMISSION_STRUCTURE_LOOKS} megastructure looks, and ${COMMISSION_DISCORD}. `
  + `${COMMISSION_NO_GAMEPLAY} ${COMMISSION_PRICE}, once.`;

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
