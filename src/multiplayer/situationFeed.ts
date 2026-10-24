// What is waiting on the player's answer in a multiplayer game, for the
// Situation Report's NEEDS A DECISION tier (useSituationItems mpData).
//
// The hook has always had rows for an open Senate vote and an incoming
// offer, but nothing ever fed it: App.tsx mounts <SituationLog /> with no
// mpData, so a bill passed and a pact sat unanswered while the report
// said nothing (playtest 2026-10-24: "bills pass without the player being
// shown them", "the Ally's peace offer is only visible inside Trade").
//
// MultiplayerShell already polls the trade and Senate lists for its tab
// badges; it publishes what it finds here, and SituationLog reads it.
// Low-frequency (a poll every few seconds), so a plain event, not a store.

import type { SituationMpData } from '../hooks/useSituationItems';

const EVENT = 'situation:mp';
let last: SituationMpData = {};

/** Merge one source's part (trades, votes or ceasefires) and announce it. */
export function publishSituation(part: SituationMpData): void {
  last = { ...last, ...part };
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: last })); } catch { /* no window */ }
}

/** Leaving the game: nothing from it is waiting any more. */
export function clearSituation(): void {
  last = {};
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: last })); } catch { /* no window */ }
}

export function currentSituation(): SituationMpData {
  return last;
}

/** Subscribe; returns the unsubscribe. */
export function onSituation(fn: (d: SituationMpData) => void): () => void {
  const h = (e: Event) => fn(((e as CustomEvent).detail ?? {}) as SituationMpData);
  window.addEventListener(EVENT, h as EventListener);
  return () => window.removeEventListener(EVENT, h as EventListener);
}
