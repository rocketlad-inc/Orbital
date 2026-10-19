// ============================================================================
// The shape of GET /api/users/me/awards: the superlatives a player has earned
// across their FINISHED games, for the profile's trophy case.
//
// The awards themselves are the ones the end-of-game page shows
// (src/multiplayer/endingTypes.ts EndingAwardId; worker/ending.js decides who
// earned what). The server stores each finished game's awards once
// (game_awards) and this endpoint reads them back for the signed-in player's
// own empires. Structure only: ids and numbers; the page owns every word.
// ============================================================================

import type { EndingAwardId } from './endingTypes';

export interface ProfileAward {
  gameId: string;
  gameName: string;
  awardId: EndingAwardId;
  /** The number behind the award, in the award's own unit. */
  value: number;
  /** True when another empire finished level on the same number. */
  tied: boolean;
  /** Hull awards (ace, heavy_hitter, iron_wall, last_stand) name the ship. */
  ship?: { name: string; shipClass: string | null; captainName?: string | null } | null;
  /** The empire the player flew in that game. */
  empireName: string;
  /** Whether that empire won the game itself. */
  wonGame: boolean;
  /** When the game ended (ms), null when unknown. */
  completedAtMs: number | null;
}

/** One line per award kind the player has earned at least once. */
export interface ProfileAwardTotal {
  awardId: EndingAwardId;
  /** How many times, across all games. */
  count: number;
  /** Their best number for it, and in which game. */
  best: number;
  bestGameId: string;
  bestGameName: string;
}

export interface ProfileAwardsPayload {
  /** Finished games the player took part in. */
  gamesFinished: number;
  /** How many of those earned them at least one award. */
  gamesWithAwards: number;
  /** Most-earned first, then by best value. */
  totals: ProfileAwardTotal[];
  /** Newest game first, at most 60. */
  awards: ProfileAward[];
  /** Finished games whose awards are still being worked out (the server
   *  fills in past games a few at a time the first time a profile is
   *  opened; the page may offer to check again). 0 when everything is in. */
  pending: number;
}
