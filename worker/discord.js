// ============================================================
// Discord bot — two-way senate integration.
//
// Publishing (game -> Discord):
//   publishSenateVoteOpen(env, gameId, proposalRow) posts a vote card
//   (embed + Yea/Nay/Abstain buttons) to a channel via the bot token when
//   a proposal enters its voting window. Called from resolveSenate.
//
// Voting (Discord -> game):
//   handleInteractions is the app's Interactions Endpoint. Discord signs
//   every request; we verify the Ed25519 signature against
//   DISCORD_PUBLIC_KEY before trusting anything. It handles:
//     - PING (Discord's endpoint health check)
//     - the /link slash command (redeem an in-game code -> store discord_id)
//     - Yea/Nay/Abstain button clicks (resolve discord_id -> faction ->
//       castVoteCore, then refresh the message tally)
//
// Identity:
//   A player mints a short code in-game (POST /api/discord/link-code) and
//   runs /link <code> in Discord. That stores users.discord_id, which the
//   button handler resolves per-game to a faction so a vote lands with the
//   right planet-count weight. See migration 0035.
//
// Required worker secrets (feature no-ops cleanly when unset):
//   DISCORD_PUBLIC_KEY   — app public key, for signature verification
//   DISCORD_BOT_TOKEN    — to POST/PATCH channel messages with buttons
//   DISCORD_CHANNEL_ID   — where senate cards post; falls back to the
//                          DISCORD_DIGEST_WEBHOOK's channel if unset
// ============================================================

import { castVoteCore, loadProposalTotals } from './senate.js';
import { isAdminEmail } from './analytics.js';

const DISCORD_API = 'https://discord.com/api/v10';
const POLITICS_COLOR = 0xc4b5fd; // matches the digest "Halls of the Senate" hue
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// ---------- tiny JSON helpers (self-contained; index.js has its own) ----------

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}

// ---------- hex + signature ----------

function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Verify Discord's Ed25519 request signature. Discord signs
 * (timestamp + rawBody); a mismatch (or missing key) means we must reject
 * with 401 — Discord itself sends deliberately-bad signatures when you
 * register the endpoint, and expects a 401.
 */
async function verifySignature(env, req, rawBody) {
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');
  const pub = env.DISCORD_PUBLIC_KEY;
  if (!sig || !ts || !pub) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(pub), { name: 'Ed25519' }, false, ['verify'],
    );
    const data = new TextEncoder().encode(ts + rawBody);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(sig), data);
  } catch {
    return false;
  }
}

// ---------- Discord REST (bot token) ----------

async function botFetch(env, method, path, body) {
  return fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Where senate cards post. Explicit DISCORD_CHANNEL_ID wins; otherwise we
 * ask the existing digest webhook which channel it lives in, so a setup
 * that only configured the webhook + bot token still works.
 */
async function resolveChannelId(env) {
  if (env.DISCORD_CHANNEL_ID) return env.DISCORD_CHANNEL_ID;
  const webhook = env.DISCORD_DIGEST_WEBHOOK;
  if (!webhook) return null;
  try {
    const res = await fetch(webhook, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.channel_id ?? null;
  } catch {
    return null;
  }
}

// ---------- message building ----------

const KIND_LABELS = {
  slider_law: 'Slider Law',
  trade_embargo: 'Trade Embargo',
  war_authorization: 'War Authorization',
  production_sanction: 'Production Sanction',
  reparations: 'Reparations',
  chancellor_vote: 'Chancellor Vote',
};

function tallyLine(totals) {
  const y = totals.yea?.weight ?? 0;
  const n = totals.nay?.weight ?? 0;
  const a = totals.abstain?.weight ?? 0;
  return `✅ Yea **${y}**   ·   ❌ Nay **${n}**   ·   ⚪ Abstain **${a}**`;
}

/**
 * Build the { embeds, components } payload for a vote card. Reused by the
 * initial post AND every button-click refresh so the message shape stays
 * identical and buttons survive updates.
 */
function buildVoteMessage(row, totals, gameName) {
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const descParts = [];
  if (row.summary) descParts.push(row.summary);
  descParts.push(`**Bill:** ${kindLabel}`);
  descParts.push(`Voting closes at tick **${row.vote_closes_at_tick}**.`);
  descParts.push('Vote weight = your planet count. You can change your vote until it closes.');

  return {
    embeds: [{
      title: `🏛️  Senate Vote — ${row.title}`,
      description: descParts.join('\n'),
      color: POLITICS_COLOR,
      fields: [{ name: 'Tally', value: tallyLine(totals), inline: false }],
      footer: { text: gameName ? `Orbital · ${gameName}` : 'Orbital' },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Yea',     custom_id: `orb:v:${row.id}:yea` },
        { type: 2, style: 4, label: 'Nay',     custom_id: `orb:v:${row.id}:nay` },
        { type: 2, style: 2, label: 'Abstain', custom_id: `orb:v:${row.id}:abstain` },
      ],
    }],
  };
}

/**
 * The card posted the moment a bill hits the floor. Deliberately has NO
 * buttons: voting isn't open yet, and a disabled button reads like a
 * bug. Its job is to give the debate window somewhere to happen — before
 * this, Discord stayed silent for the entire debate (12 ticks on an
 * hourly game = half a day of dead air) and the vote card was the first
 * anyone heard of a bill.
 */
function buildDebateMessage(row, gameName, proposerName) {
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const parts = [];
  if (row.summary) parts.push(row.summary);
  parts.push(`**Bill:** ${kindLabel}`);
  if (proposerName) parts.push(`**Proposed by:** ${proposerName}`);
  parts.push(`Debate is open. Voting begins at tick **${row.vote_opens_at_tick}** and closes at tick **${row.vote_closes_at_tick}**.`);
  parts.push('_A vote card with buttons posts here when the floor opens._');

  return {
    embeds: [{
      title: `📜  Bill on the Floor — ${row.title}`,
      description: parts.join('\n'),
      color: POLITICS_COLOR,
      footer: { text: gameName ? `Orbital · ${gameName}` : 'Orbital' },
    }],
  };
}

async function gameName(env, gameId) {
  const r = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();
  return r?.name ?? null;
}

// ---------- publishing (called from resolveSenate) ----------

/**
 * Post a vote card for a freshly-opened proposal. No-ops cleanly when the
 * bot isn't configured. Stores the resulting message id so button clicks
 * can refresh this exact message.
 */
export async function publishSenateVoteOpen(env, gameId, row) {
  if (!env.DISCORD_BOT_TOKEN) return { posted: false, reason: 'no_bot_token' };
  const channelId = await resolveChannelId(env);
  if (!channelId) return { posted: false, reason: 'no_channel' };

  const totals = await loadProposalTotals(env, row.id);
  const payload = buildVoteMessage(row, totals, await gameName(env, gameId));

  const res = await botFetch(env, 'POST', `/channels/${channelId}/messages`, payload);
  if (!res.ok) {
    console.error(`discord senate post failed: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, reason: `http_${res.status}` };
  }
  const msg = await res.json();
  try {
    await env.DB
      .prepare(
        `INSERT INTO discord_senate_messages (proposal_id, game_id, channel_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id) DO UPDATE SET
           channel_id = excluded.channel_id, message_id = excluded.message_id`,
      )
      .bind(row.id, gameId, channelId, msg.id, Date.now())
      .run();
  } catch (e) {
    console.error('discord_senate_messages upsert failed', e);
  }
  return { posted: true, message_id: msg.id };
}

/**
 * Announce a newly-proposed bill. Best-effort and non-fatal: a Discord
 * problem must never block a player from proposing. Fire-and-forget by
 * design — nothing downstream depends on the message id, so unlike the
 * vote card we don't record it.
 */
export async function publishSenateProposed(env, gameId, row, proposerName) {
  if (!env.DISCORD_BOT_TOKEN) return { posted: false, reason: 'no_bot_token' };
  const channelId = await resolveChannelId(env);
  if (!channelId) return { posted: false, reason: 'no_channel' };

  const payload = buildDebateMessage(row, await gameName(env, gameId), proposerName);
  const res = await botFetch(env, 'POST', `/channels/${channelId}/messages`, payload);
  if (!res.ok) {
    console.error(`discord debate post failed: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, reason: `http_${res.status}` };
  }
  return { posted: true };
}

// ---------- interactions endpoint ----------

// Interaction + response type constants (Discord API).
const T_PING = 1, T_COMMAND = 2, T_COMPONENT = 3;
const R_PONG = 1, R_MESSAGE = 4, R_UPDATE = 7;
const FLAG_EPHEMERAL = 64;

function ephemeral(content) {
  return json({ type: R_MESSAGE, data: { content, flags: FLAG_EPHEMERAL } });
}

export async function handleInteractions(req, env) {
  const raw = await req.text();
  const ok = await verifySignature(env, req, raw);
  if (!ok) return new Response('invalid request signature', { status: 401 });

  let body;
  try { body = JSON.parse(raw); } catch { return err(400, 'bad_request', 'invalid json'); }

  if (body.type === T_PING) return json({ type: R_PONG });
  if (body.type === T_COMMAND) return handleSlashCommand(env, body);
  if (body.type === T_COMPONENT) return handleComponent(env, body);
  return json({ type: R_PONG }); // unknown type — ack harmlessly
}

function discordUserOf(interaction) {
  return interaction.member?.user ?? interaction.user ?? null;
}

async function handleSlashCommand(env, interaction) {
  const name = interaction.data?.name;
  if (name === 'notify') return handleNotifyCommand(env, interaction);
  if (name !== 'link') return ephemeral('Unknown command.');

  const user = discordUserOf(interaction);
  if (!user?.id) return ephemeral('Could not read your Discord identity.');

  const opt = (interaction.data?.options ?? []).find(o => o.name === 'code');
  const code = String(opt?.value ?? '').trim().toUpperCase();
  if (!code) return ephemeral('Usage: `/link <code>` — get your code in-game from the Senate panel.');

  const now = Date.now();
  // Opportunistic sweep of expired codes.
  try { await env.DB.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').bind(now).run(); } catch { /* ignore */ }

  const rowc = await env.DB
    .prepare('SELECT user_id, expires_at FROM discord_link_codes WHERE code = ?')
    .bind(code).first();
  if (!rowc || rowc.expires_at < now) {
    return ephemeral('That code is invalid or expired. Generate a fresh one in-game (Senate panel → Link Discord).');
  }

  try {
    // Re-linking support: if this Discord account was linked to a
    // different Orbital user, clear that first (the partial unique index
    // on discord_id would otherwise reject the UPDATE).
    await env.DB.prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE discord_id = ? AND id != ?')
      .bind(user.id, rowc.user_id).run();
    await env.DB.prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?')
      .bind(user.id, user.username ?? null, rowc.user_id).run();
    await env.DB.prepare('DELETE FROM discord_link_codes WHERE code = ?').bind(code).run();
  } catch (e) {
    console.error('discord link failed', e);
    return ephemeral('Something went wrong linking your account. Try a fresh code.');
  }
  return ephemeral('✅ Linked! You can now vote in Senate polls straight from Discord.');
}

/**
 * /notify [category] [on|off] — read or change DM preferences.
 * With no options it just reports current state, which doubles as the
 * discovery surface: most players will never read docs, but they will
 * type a command they saw mentioned in a footer.
 */
async function handleNotifyCommand(env, interaction) {
  const notify = await import('./notify.js');
  const user = discordUserOf(interaction);
  if (!user?.id) return ephemeral('Could not read your Discord identity.');

  const linked = await env.DB
    .prepare('SELECT id FROM users WHERE discord_id = ?').bind(user.id).first();
  if (!linked) {
    return ephemeral('Link your account first: in-game Senate panel → Link Discord, then `/link <code>` here.');
  }

  const opts = interaction.data?.options ?? [];
  const category = opts.find(o => o.name === 'category')?.value;
  const stateRaw = opts.find(o => o.name === 'state')?.value;

  if (category && stateRaw) {
    const on = String(stateRaw) === 'on';
    if (category === 'all') await notify.setAllPrefs(env, linked.id, on);
    else if (!(await notify.setPref(env, linked.id, category, on))) {
      return ephemeral(`Unknown category '${category}'.`);
    }
  }

  const prefs = await notify.getPrefs(env, linked.id);
  const lines = Object.entries(notify.CATEGORIES)
    .map(([k, label]) => `${prefs[k] ? '🔔' : '🔕'} \`${k}\` — ${label}`);
  return ephemeral(
    ['**Your Orbital notifications**', ...lines, '',
     'Change with `/notify category:<name> state:<on|off>` (or `category:all`).'].join('\n'),
  );
}

async function handleComponent(env, interaction) {
  const customId = interaction.data?.custom_id ?? '';
  const parts = customId.split(':');
  // orb:v:<proposalId>:<choice>
  if (parts[0] !== 'orb' || parts[1] !== 'v') return ephemeral('Unrecognized action.');
  const proposalId = parts[2];
  const choice = parts[3];

  const user = discordUserOf(interaction);
  if (!user?.id) return ephemeral('Could not read your Discord identity.');

  const linked = await env.DB.prepare('SELECT id FROM users WHERE discord_id = ?').bind(user.id).first();
  if (!linked) {
    return ephemeral('You haven’t linked your Orbital account yet. In-game: Senate panel → Link Discord, then run `/link <code>` here.');
  }

  const prop = await env.DB.prepare('SELECT game_id FROM senate_proposals WHERE id = ?').bind(proposalId).first();
  if (!prop) return ephemeral('That proposal no longer exists.');

  const faction = await env.DB
    .prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(prop.game_id, linked.id).first();
  if (!faction) return ephemeral('You have no faction in that game, so you can’t vote on this bill.');

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(prop.game_id).first();
  const res = await castVoteCore(env, {
    gameId: prop.game_id,
    proposalId,
    factionId: faction.id,
    currentTick: game?.current_tick ?? 0,
    vote: choice,
  });
  if (!res.ok) return ephemeral(`Couldn’t record your vote: ${res.message}`);

  // Success — refresh the shared message tally in place (keeps buttons).
  const totals = await loadProposalTotals(env, proposalId);
  const payload = buildVoteMessage(res.row, totals, await gameName(env, prop.game_id));
  return json({ type: R_UPDATE, data: { embeds: payload.embeds, components: payload.components } });
}

// ---------- in-game link-code endpoints (session-authed) ----------

// Unambiguous alphabet (no 0/O/1/I) for codes read off a screen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newLinkCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

async function handleMintLinkCode(_req, env, { session }) {
  const now = Date.now();
  // One live code per user — drop any previous so the newest is canonical.
  await env.DB.prepare('DELETE FROM discord_link_codes WHERE user_id = ?').bind(session.user_id).run();
  const code = newLinkCode();
  await env.DB
    .prepare('INSERT INTO discord_link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(code, session.user_id, now, now + LINK_CODE_TTL_MS)
    .run();
  return json({ code, expires_at: now + LINK_CODE_TTL_MS, command: `/link ${code}` });
}

async function handleLinkStatus(_req, env, { session }) {
  const row = await env.DB
    .prepare('SELECT discord_id, discord_username FROM users WHERE id = ?')
    .bind(session.user_id).first();
  return json({
    linked: !!row?.discord_id,
    discord_username: row?.discord_username ?? null,
  });
}

async function handleUnlink(_req, env, { session }) {
  await env.DB
    .prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE id = ?')
    .bind(session.user_id).run();
  return json({ linked: false });
}

// ---------- routes ----------

// NOTE: /api/discord/interactions is NOT in this list. index.js applies a
// blanket "require session" gate to everything that reaches feature-route
// dispatch, so a cookieless Discord request would 401 before its signature
// could be checked. It's wired directly in index.js _dispatch alongside the
// other unauthenticated routes (signup/login/…), calling handleInteractions.
/** The bot's command set, defined ONCE here so the worker is the source
 *  of truth. scripts/register-discord-commands.mjs remains for offline
 *  use, but the admin endpoint below means adding a command no longer
 *  requires having the bot token on someone's laptop. */
export const SLASH_COMMANDS = [
  {
    name: 'link',
    description: 'Link your Discord account to your Orbital empire so you can vote in the Senate.',
    options: [{ name: 'code', description: 'The code shown in-game under Senate → Link Discord.', type: 3, required: true }],
  },
  {
    name: 'notify',
    description: 'See or change which Orbital events DM you.',
    options: [
      { name: 'category', description: 'Which kind of notification to change.', type: 3, required: false,
        choices: [
          { name: 'all', value: 'all' },
          { name: 'messages from factions', value: 'dm' },
          { name: 'attacks on you', value: 'combat' },
          { name: 'senate bills & votes', value: 'senate' },
          { name: 'upkeep & build problems', value: 'economy' },
          { name: 'daily situation report', value: 'digest' },
          { name: 'away reminders', value: 'nudge' },
        ] },
      { name: 'state', description: 'Turn it on or off.', type: 3, required: false,
        choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
    ],
  },
];

/**
 * POST /api/admin/discord/register-commands?guild=<id>
 * Registers SLASH_COMMANDS using the worker's OWN stored bot token, so
 * shipping a new command never requires the token to exist on a laptop
 * or pass through a chat transcript. Guild scope is instant; omit for
 * global (up to an hour to propagate).
 */
async function handleRegisterCommands(req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  if (!env.DISCORD_BOT_TOKEN) return err(400, 'not_configured', 'DISCORD_BOT_TOKEN is not set');

  const appRes = await botFetch(env, 'GET', '/applications/@me');
  if (!appRes.ok) return err(502, 'discord_error', `could not read application: ${appRes.status}`);
  const app = await appRes.json();

  const guild = new URL(req.url).searchParams.get('guild');
  const path = guild
    ? `/applications/${app.id}/guilds/${guild}/commands`
    : `/applications/${app.id}/commands`;

  const res = await botFetch(env, 'PUT', path, SLASH_COMMANDS);
  const text = await res.text();
  if (!res.ok) return err(502, 'discord_error', `register failed ${res.status}: ${text.slice(0, 300)}`);
  const registered = JSON.parse(text);
  return json({
    ok: true,
    scope: guild ? `guild:${guild}` : 'global',
    commands: registered.map(c => c.name),
  });
}

/**
 * POST /api/admin/sitrep/:gameId[?user=<id>&force=1]
 * Fire situation-report DMs on demand. Exists because the scheduled
 * version can only be observed once a day — which is a miserable loop
 * for verifying that a report reads well. force=1 uses a timestamped
 * dedupe key so a test send never consumes the day's real slot.
 */
async function handleSitrepNow(req, env, { session, params }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const url = new URL(req.url);
  const mod = await import('./situationReport.js');
  const results = await mod.sendSituationReports(env, params.gameId, {
    force: url.searchParams.get('force') === '1',
    onlyUserId: url.searchParams.get('user') || null,
  });
  return json({ ok: true, game: params.gameId, results });
}

/**
 * POST /api/admin/senate/:proposalId/announce
 * Re-post a bill's debate card. Exists because announcements fire at
 * CREATION, so any proposal made before the announcement feature landed
 * (or during a Discord outage) has no card and would stay invisible
 * until its vote opens — which on an hourly game can be half a day.
 * Admin-gated; re-announcing is idempotent from the game's side since
 * nothing downstream keys off the debate message.
 */
async function handleAnnounceProposal(_req, env, { session, params }) {
  if (!session || !isAdminEmail(session.email)) {
    return err(404, 'not_found', 'no such route');
  }
  const row = await env.DB
    .prepare('SELECT * FROM senate_proposals WHERE id = ?')
    .bind(params.proposalId).first();
  if (!row) return err(404, 'not_found', 'no such proposal');

  const prop = await env.DB
    .prepare('SELECT name FROM game_factions WHERE id = ?')
    .bind(row.proposer_faction_id).first();

  const res = await publishSenateProposed(env, row.game_id, row, prop?.name ?? null);
  return json({ ok: !!res.posted, ...res, proposal: row.id, status: row.status });
}

export const routes = [
  { method: 'POST', pattern: '/api/admin/discord/register-commands', auth: 'required', handle: handleRegisterCommands },
  { method: 'POST', pattern: /^\/api\/admin\/sitrep\/(?<gameId>[^/]+)$/, auth: 'required', handle: handleSitrepNow },
  { method: 'POST', pattern: /^\/api\/admin\/senate\/(?<proposalId>[^/]+)\/announce$/, auth: 'required', handle: handleAnnounceProposal },
  { method: 'POST', pattern: '/api/discord/link-code',  auth: 'required', handle: handleMintLinkCode },
  { method: 'GET',  pattern: '/api/discord/link-status', auth: 'required', handle: handleLinkStatus },
  { method: 'POST', pattern: '/api/discord/unlink',      auth: 'required', handle: handleUnlink },
];
