// ============================================================================
// A real room's shape, for looking at the room lobby without a server.
//
// Used ONLY by the dev preview (/?room-lobby, RoomLobbyPreview.tsx) and the
// tests; nothing in the shipped app imports it, so the production bundle does
// not carry it. The room is "The Zone of the Future" (8 players), kept as the
// design was drawn: the empire names, flags (colours and emblems) and
// starting worlds are the real ones. Player display names and notes are
// neutral stand-ins ("Player 1"...), because real players' names do not belong
// in the repository.
// ============================================================================

import type { RoomMember, RoomSnapshot, StartingBodyOption } from '../api';

export interface FixtureSeat {
  userId: string;
  displayName: string;
  empire: string | null;
  world: string | null;   // body id
  color: string;
  color2: string;
  emblem: string;
  commissioned: boolean;
  ready: boolean;
  bio: string | null;
}

/** Seat 1 hosts. Seat 4 has not finished; seat 7 has not started at all. */
export const FIXTURE_SEATS: FixtureSeat[] = [
  { userId: 'fx1', displayName: 'Player 1', empire: 'Outie Empire', world: 'triton', color: '#5c6bc0', color2: '#ab47bc', emblem: 'rocket', commissioned: true, ready: true, bio: 'Quiet traders from the outer dark.' },
  { userId: 'fx2', displayName: 'Player 2', empire: 'Tritalowda', world: 'oberon', color: '#7e57c2', color2: '#42a5f5', emblem: 'doublev', commissioned: true, ready: true, bio: 'Born far from the sun, and proud of it. We trade in ice and patience, and we remember every border dispute.' },
  { userId: 'fx3', displayName: 'Player 3', empire: 'Voyager', world: 'europa', color: '#42a5f5', color2: '#f5f5f5', emblem: 'skull', commissioned: true, ready: true, bio: null },
  { userId: 'fx4', displayName: 'Player 4', empire: 'The unown', world: 'venus', color: '#ff7043', color2: '#78909c', emblem: 'key', commissioned: false, ready: false, bio: 'Still working out the rules.' },
  { userId: 'fx5', displayName: 'Player 5', empire: 'Disciples of Robert Moses', world: 'earth', color: '#ab47bc', color2: '#ffca28', emblem: 'sun', commissioned: true, ready: true, bio: 'Roads first, questions later.' },
  { userId: 'fx6', displayName: 'Player 6', empire: 'Dog With a Gun in it\'s Mouth.', world: 'mars', color: '#ec407a', color2: '#26c6da', emblem: 'orbit', commissioned: true, ready: true, bio: 'Forward thinking, mostly.' },
  { userId: 'fx7', displayName: 'Player 7', empire: null, world: null, color: '#66bb6a', color2: '#7e57c2', emblem: 'crown', commissioned: false, ready: false, bio: null },
  { userId: 'fx8', displayName: 'Player 8', empire: 'Moosatorium', world: 'titan', color: '#8d6e63', color2: '#f5f5f5', emblem: 'mountain', commissioned: true, ready: true, bio: 'Moose business.' },
];

export type FixtureViewer = 'host' | 'player' | 'incomplete';

/** Which seat each preview viewer sits in. */
export const FIXTURE_VIEWER_ID: Record<FixtureViewer, string> = {
  host: 'fx1', player: 'fx5', incomplete: 'fx7',
};

/** The worlds a capital can be claimed on (a slice of the real list; ids match the map's bodies). */
export const FIXTURE_OPTIONS: StartingBodyOption[] = [
  { id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol', yield: { metal: 4, fuel: 0, gold: 1, science: 1 } },
  { id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol', yield: { metal: 2, fuel: 0, gold: 3, science: 2 } },
  { id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol', yield: { metal: 2, fuel: 0, gold: 4, science: 3 } },
  { id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol', yield: { metal: 3, fuel: 0, gold: 2, science: 2 } },
  { id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', yield: { metal: 3, fuel: 0, gold: 1, science: 1 } },
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter', yield: { metal: 4, fuel: 0, gold: 1, science: 0 } },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter', yield: { metal: 1, fuel: 0, gold: 2, science: 4 } },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter', yield: { metal: 3, fuel: 0, gold: 2, science: 1 } },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter', yield: { metal: 3, fuel: 0, gold: 1, science: 1 } },
  { id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn', yield: { metal: 1, fuel: 0, gold: 1, science: 4 } },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn', yield: { metal: 2, fuel: 0, gold: 3, science: 2 } },
  { id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus', yield: { metal: 3, fuel: 0, gold: 1, science: 1 } },
  { id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune', yield: { metal: 2, fuel: 0, gold: 2, science: 3 } },
];

export function fixtureMember(s: FixtureSeat): RoomMember {
  return {
    userId: s.userId,
    displayName: s.displayName,
    commissioned: s.commissioned,
    empire_name: s.empire,
    bio: s.bio,
    chosen_starting_body: s.world,
    color: s.color,
    color2: s.color2,
    emblem: s.emblem,
  };
}

/** The room as the server would send it. `seats` lets a test trim or edit the roster. */
export function fixtureSnapshot(seats: FixtureSeat[] = FIXTURE_SEATS, over: Partial<RoomSnapshot['settings']> = {}): RoomSnapshot {
  return {
    settings: {
      id: 'fxRoom000001',
      name: 'The Zone of the Future',
      host_id: seats[0]?.userId ?? 'fx1',
      status: 'lobby',
      max_players: 8,
      invite_code: 'FNCNNZZL',
      has_password: true,
      created_at: Date.now() - 20 * 60_000,
      tick_interval_ms: 3_600_000,
      game_id: null,
      game_status: null,
      current_tick: null,
      ...over,
    },
    members: seats.map(fixtureMember),
    connected: seats.filter((s) => s.userId !== 'fx4').map((s) => s.userId),
    ready: Object.fromEntries(seats.map((s) => [s.userId, s.ready])),
    game_started: false,
    game_id: null,
    starting_body_options: FIXTURE_OPTIONS,
    custom_map: null,
  };
}
