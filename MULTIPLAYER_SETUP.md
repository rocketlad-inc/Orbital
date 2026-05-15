# Multiplayer Setup

The multiplayer backend (auth, lobby, faction identity, in-game messaging,
senate) runs on Cloudflare Workers + D1 + Durable Objects. The single-player
React app keeps working without any of this — multiplayer is opt-in from the
mode picker after you sign in.

## First-time setup

1. **Create the D1 database** (one-time):

   ```bash
   npx wrangler d1 create orbital
   ```

   Wrangler will print a `database_id`. Copy it.

2. **Paste the ID into [wrangler.jsonc](wrangler.jsonc)**, replacing
   `REPLACE_WITH_D1_ID`:

   ```jsonc
   "d1_databases": [{
     "binding": "DB",
     "database_name": "orbital",
     "database_id": "<your-id-here>",
     "migrations_dir": "migrations"
   }]
   ```

3. **Apply migrations** to the live database:

   ```bash
   npm run db:migrate:remote
   ```

   Or to your local dev D1:

   ```bash
   npm run db:migrate:local
   ```

   This runs everything in [migrations/](migrations/) in order:
   - `0001_init.sql` — users + sessions
   - `0002_rooms.sql` — rooms + room_members
   - `0003_game_state.sql` — games, ticks, factions, bodies, ships, messages
   - `0004_senate_effects.sql` — senate sliders
   - `0005_empire_identity_and_starter_fleet.sql` — starter ships & empire id

## Local dev

Run two processes side-by-side:

```bash
npm start            # React app on :3000
npm run worker:dev   # Wrangler dev (worker + D1) on :8787
```

`src/setupProxy.js` forwards `/api/*` from :3000 to :8787 during dev so
cookies and credentials work as if it were one origin.

## Deploy

```bash
npm run build
npx wrangler deploy
```

The static React build is served by the worker's `ASSETS` binding; `/api/*`
routes hit the worker; everything else falls through to the SPA bundle.

## What works today

- **Auth** — email/password sign-up & sign-in. Session is an HttpOnly cookie
  (PBKDF2-SHA256, 30-day expiry). Reload keeps you signed in.
- **Mode picker** — after login the player picks Single Player or Multiplayer.
  If the player is already a member of an in-progress game, the picker
  auto-redirects them to it.
- **Lobby** — create rooms (2–8 players), browse open rooms, join, host
  controls (kick, ready-check, start game). Lobby presence over WebSocket
  via the `Room` Durable Object.
- **Faction identity** — pick empire name + bio per room.
- **Comms** — DM / group / broadcast messaging once a game is running.
- **Senate** — proposal + voting with vote weight = planet count.

## What does not work yet

The shared game-state sync isn't wired. Inside an active multiplayer game,
the map canvas still runs against the local `mockGameState` — ships,
maneuvers, and settlements are not yet broadcast across players. That's the
next integration milestone.
