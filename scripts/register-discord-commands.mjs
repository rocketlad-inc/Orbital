// Register (or update) the Orbital bot's global slash commands.
//
// One-time / whenever the command list changes. Idempotent: Discord's
// bulk-overwrite PUT replaces the full global command set with what we
// send here.
//
// Usage (PowerShell):
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; node scripts/register-discord-commands.mjs
// Usage (bash):
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-discord-commands.mjs
//
// Global commands can take up to ~1 hour to propagate the first time.

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment.');
  process.exit(1);
}

const commands = [
  {
    name: 'link',
    description: 'Link your Discord account to your Orbital empire so you can vote in the Senate.',
    // type 4 = STRING option
    options: [
      {
        name: 'code',
        description: 'The code shown in-game under Senate → Link Discord.',
        type: 3,
        required: true,
      },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: 'PUT',
  headers: {
    authorization: `Bot ${BOT_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(commands),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Failed (${res.status}): ${text}`);
  process.exit(1);
}
console.log(`Registered ${commands.length} command(s). Discord response:`);
console.log(text);
