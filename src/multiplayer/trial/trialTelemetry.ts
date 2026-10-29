// ============================================================
// Play for Free, followed on the admin dashboard (its Play for Free
// panel, worker/adminDashboard.js). Each moment of a trial is logged
// once per page load against the trial GAME, as ui/trial-<what>, on the
// telemetry funnel channel (telemetry.ts logUiEvent). Keyed by game, not
// player, because saving moves the game to a new account mid-trial.
//
//   tour-step-<n>   the trial tour showed step n (1-based)
//   tour-done       reached its last step; tour-skip: left it earlier
//   clock           the clock started (the trial is born paused)
//   war             the Warlord declared war on them
//   save-open-<why> the save sheet opened: menu, leaving, time, account
//   save-try-<how>  pressed google, new (email sign-up) or have (sign-in)
//   save-error      the save was refused (bad password, taken email...)
// The save itself is logged by the server (trial_claim, trial.js).
// ============================================================

import { logUiEvent } from '../telemetry';

let trialGameId: string | null = null;

/** TrialLayer names the trial game once it is on screen. */
export function setTrialGame(gameId: string | null | undefined): void {
  if (gameId) trialGameId = gameId;
}

export function logTrial(what: string): void {
  let gid = trialGameId;
  // The save sheet can open over the lobby, before any game has mounted:
  // the tab's room is the trial (AuthContext startTrial).
  if (!gid) { try { gid = sessionStorage.getItem('orbital.tab_room'); } catch { /* private mode */ } }
  logUiEvent(gid, `trial-${what}`);
}
