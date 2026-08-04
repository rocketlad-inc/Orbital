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
//
// Pass `--guild <serverId>` to register against ONE server instead.
// Guild commands appear INSTANTLY, which is the difference between
// testing the senate hookup now and waiting an hour to find out whether
// it works. Use guild registration while wiring things up; switch to
// global once it's proven.
//   node scripts/register-discord-commands.mjs --guild 123456789

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment.');
  process.exit(1);
}

const guildFlag = process.argv.indexOf('--guild');
const GUILD_ID = guildFlag !== -1 ? process.argv[guildFlag + 1] : null;
if (guildFlag !== -1 && !GUILD_ID) {
  console.error('--guild needs a server id, e.g. --guild 123456789');
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
  {
    name: 'notify',
    description: 'See or change which Orbital events DM you.',
    options: [
      {
        name: 'category',
        description: 'Which kind of notification to change.',
        type: 3,
        required: false,
        choices: [
          { name: 'all', value: 'all' },
          { name: 'messages from factions', value: 'dm' },
          { name: 'attacks on you', value: 'combat' },
          { name: 'senate bills & votes', value: 'senate' },
          { name: 'upkeep & build problems', value: 'economy' },
          { name: 'daily situation report', value: 'digest' },
          { name: 'away reminders', value: 'nudge' },
        ],
      },
      {
        name: 'state',
        description: 'Turn it on or off.',
        type: 3,
        required: false,
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        ],
      },
    ],
  },
];

const endpoint = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(endpoint, {
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
console.log(`Registered ${commands.length} command(s) ${GUILD_ID ? `to guild ${GUILD_ID}` : 'globally'}.`);
for (const c of JSON.parse(text)) console.log(`  /${c.name} — ${c.description}`);
if (!GUILD_ID) {
  console.log('');
  console.log('Global registration can take up to an hour to appear in Discord.');
  console.log('Re-run with --guild <serverId> if you want it immediately.');
}
