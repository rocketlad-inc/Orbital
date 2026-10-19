// ============================================================================
// The shape of GET /api/games/:gameId/ending: everything the end-of-game page
// shows, computed once on the server for a FINISHED game.
//
// This file is the CONTRACT between worker/ending.js (which builds it) and the
// page (src/multiplayer/EndingPage.tsx, which draws it). Change it in one
// commit with both sides.
//
// Principles:
//   * Structure, not prose. The server returns ids and numbers; the page owns
//     every word (award titles, blurbs, captions) so it can be translated.
//   * Only what the players could already see in the game: faction names,
//     colours and emblems, ship names. No emails, no account display names.
//   * An award is OMITTED when there is nothing real behind it (nobody fired
//     a shot, nobody traded). The page never fills a gap with a placeholder.
// ============================================================================

export type EndingAwardId =
  // — war —
  | 'warmonger'     // faction: most ships destroyed
  | 'ace'           // one hull: most kills
  | 'heavy_hitter'  // one hull: most damage dealt
  | 'iron_wall'     // one hull: most damage soaked by its armour and shields
  | 'last_stand'    // one hull: most kills landed while under a quarter health
  | 'instigator'    // faction: most wars declared
  // — empire —
  | 'landlord'      // faction: most holdings (worlds with a settlement) at once
  | 'treasurer'     // faction: biggest credit pile at any moment
  | 'scholar'       // faction: most research completed
  | 'shipwright'    // faction: most hulls built
  // — society —
  | 'merchant'      // faction: most trades struck (market fills + treaty trades)
  | 'statesman';    // faction: most Senate bills passed

export interface EndingAward {
  id: EndingAwardId;
  factionId: string;
  /** The number behind the award, in the award's own unit (kills, damage,
   *  worlds, credits, techs, hulls, trades, bills, wars). Whole numbers. */
  value: number;
  /** Second place, when there is one with a non-zero value. */
  runnerUp?: { factionId: string; value: number };
  /** Hull awards (ace, heavy_hitter, iron_wall, last_stand) name the ship. */
  ship?: { name: string; shipClass: string | null; captainName?: string | null };
}

export interface EndingFaction {
  id: string;
  name: string;
  color: string;
  color2?: string | null;
  emblem?: string | null;
  /** 'active' = still standing at the end; 'eliminated' = knocked out. */
  finalStatus: 'active' | 'eliminated';
  /** Tick it was knocked out on, when eliminated and known. */
  eliminatedAtTick?: number | null;
  /** 1 = winner. Then ranked by holdings, then ships, then techs. Ties share
   *  no place: the order is total, so the page can list it as given. */
  place: number;
  isWinner: boolean;
  /** The viewer's own empire (the caller's faction in this game). */
  isMe: boolean;
  /** Standing when the game ended. */
  final: { holdings: number; ships: number; techs: number; credits: number; science: number; metal: number };
  /** Highest value at any moment (from the per-tick metrics). */
  peak: { holdings: number; ships: number; credits: number };
  /** Whole-game totals for this empire. 0 when it never happened. */
  totals: {
    kills: number;          // enemy hulls destroyed
    shipsLost: number;      // its own hulls destroyed
    damageDealt: number;
    shipsBuilt: number;
    trades: number;
    billsPassed: number;
    warsDeclared: number;
  };
}

/** Per-tick curves, downsampled to at most ~120 points and ALIGNED: `ticks[i]`
 *  is the tick that index i of every array refers to. A faction that was not
 *  yet in the game, or was already gone, reads 0 there. */
export interface EndingSeries {
  ticks: number[];
  holdings: Record<string, number[]>;
  ships: Record<string, number[]>;
  credits: Record<string, number[]>;
  science: Record<string, number[]>;
}

export interface EndingBattle {
  id: string;
  bodyName: string | null;
  startedTick: number;
  endedTick: number | null;
  shots: number;
  shipsLost: number;
  settlementsLost: number;
  /** Ships each empire lost in it (only empires that lost any). */
  lossesByFaction: Array<{ factionId: string; shipsLost: number }>;
}

export interface EndingPayload {
  game: {
    id: string;
    name: string;
    victoryType: string | null;      // 'engineering' | 'domination' | 'chancellor' | 'annihilation' | ...
    winnerFactionId: string | null;
    /** The victory line the game itself shows ("Completed the Sol Dyson
     *  Sphere"), when it recorded one; the page also builds its own from
     *  victoryType, so this may be null. */
    victoryDetail: string | null;
    currentTick: number;
    tickIntervalMs: number;
    startedAtMs: number | null;
    completedAtMs: number | null;
    /** Real time from first tick to the end, in ms, when both are known. */
    durationMs: number | null;
    players: number;                 // empires with a human behind them
    empires: number;                 // all empires
  };
  factions: EndingFaction[];         // ordered by place
  awards: EndingAward[];             // most interesting first; only real ones
  series: EndingSeries;
  /** Whole-game totals across everyone. */
  totals: {
    battles: number; shots: number; shipsLost: number; settlementsLost: number;
    trades: number; billsPassed: number; techsResearched: number; shipsBuilt: number;
    wars: number;
  };
  /** The three biggest fights by hulls lost, biggest first. */
  battles: EndingBattle[];
}
