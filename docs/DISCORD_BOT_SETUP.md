# Discord Bot Setup — Senate Publishing & Voting

The bot does two things:

1. **Publishes a vote card** to a Discord channel when a Senate proposal
   enters its voting window (embed + Yea / Nay / Abstain buttons).
2. **Accepts votes from Discord** — a player clicks a button, and the vote
   lands in-game with their faction's real planet-count weight.

Publishing reuses the same channel as "The Orbital Herald" digest. Voting
requires a registered Discord **Application** (a plain webhook can't
receive button clicks).

---

## What you provide (worker secrets)

Set these with `npx wrangler secret put <NAME>` (or the Cloudflare
dashboard → Workers → orbital → Settings → Variables):

| Secret | Where to find it | Needed for |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | Developer Portal → your app → **General Information** → Public Key | verifying vote interactions |
| `DISCORD_BOT_TOKEN` | Developer Portal → your app → **Bot** → Reset/Copy Token | posting vote cards + reading them |
| `DISCORD_CHANNEL_ID` | *(optional)* right-click the target channel → Copy Channel ID | where cards post — falls back to the digest webhook's channel if unset |

`DISCORD_DIGEST_WEBHOOK` (already configured for the Herald) is reused to
locate the channel when `DISCORD_CHANNEL_ID` is not set. If neither is
available, publishing quietly no-ops.

---

## One-time setup steps

1. **Interactions endpoint.** In the Developer Portal → your app →
   **General Information**, set **Interactions Endpoint URL** to:

   ```
   https://orbital.lcfeeser.workers.dev/api/discord/interactions
   ```

   Discord immediately sends a signed PING; the worker verifies it and
   replies PONG. It will only save if `DISCORD_PUBLIC_KEY` is already set
   as a secret **and deployed**, so set the secret and deploy first.

2. **Invite the bot** to your server with the `bot` and
   `applications.commands` scopes, and permission to **Send Messages** in
   the target channel. (Developer Portal → **OAuth2 → URL Generator**.)

3. **Register the `/link` command** (once, and whenever it changes):

   ```powershell
   $env:DISCORD_APP_ID="<application id>"
   $env:DISCORD_BOT_TOKEN="<bot token>"
   node scripts/register-discord-commands.mjs
   ```

   Global commands can take up to ~1 hour to appear the first time.

---

## Player flow

1. In-game: **Senate panel → Link Discord** → a code appears.
2. In Discord: `/link <code>`. The bot confirms the link (ephemeral).
3. When a bill opens for voting, the bot posts a card. Anyone linked can
   click **Yea / Nay / Abstain**; the card's tally updates in place. Votes
   can be changed until the window closes, exactly like the in-game panel.

Unlinked clickers get a private nudge to link first; a linked user with no
faction in that game is told they can't vote on that bill.

---

## Notes / limits

- The card shows a live **weighted** tally, so it reveals the running
  result mid-vote — matching the in-game panel, which already shows
  tallies. Weight is **1 + 1 per system controlled**: you control a system
  when you own more of its bodies than any other faction, and a tie leaves
  it contested and worth nothing to anyone. The tally shows weight and
  headcount together (`Yea 4 (2 votes)`) because the two diverge and
  showing only one of them reads as a bug.
- Vote buttons stay clickable after the window closes; a late click gets a
  private "voting has closed" reply rather than changing anything.
- Everything is best-effort and isolated: a Discord outage or missing
  secret never blocks the Senate tick — publishing just no-ops.
- Only **voting-open** is published today. Result/close announcements are
  an easy follow-up (`discord_senate_messages` already stores each card's
  message id for editing).
