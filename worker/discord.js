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
export const routes = [
  { method: 'POST', pattern: '/api/discord/link-code',  auth: 'required', handle: handleMintLinkCode },
  { method: 'GET',  pattern: '/api/discord/link-status', auth: 'required', handle: handleLinkStatus },
  { method: 'POST', pattern: '/api/discord/unlink',      auth: 'required', handle: handleUnlink },
];
