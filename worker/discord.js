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
// Vote weight is 1 + one per SYSTEM controlled — see worker/systems.js.
// Every surface quotes WEIGHT_RULE verbatim rather than paraphrasing it.
//
// Identity:
//   A player mints a short code in-game (POST /api/discord/link-code) and
//   runs /link <code> in Discord. That stores users.discord_id, which the
//   button handler resolves per-game to a faction so a vote lands with the
//   right weight. See migration 0035.
//
// Required worker secrets (feature no-ops cleanly when unset):
//   DISCORD_PUBLIC_KEY   — app public key, for signature verification
//   DISCORD_BOT_TOKEN    — to POST/PATCH channel messages with buttons
//   DISCORD_CHANNEL_ID   — where senate cards post; falls back to the
//                          DISCORD_DIGEST_WEBHOOK's channel if unset
// ============================================================

import { castVoteCore, loadProposalTotals } from './senate.js';
import { WEIGHT_RULE } from './systems.js';
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
/** Same resolution, exported for the mention poller — one definition of
 *  "the channel" rather than two that can drift apart. */
export function resolveChannelIdPublic(env) { return resolveChannelId(env); }

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

/** Weight AND headcount. A bare "Yea 18" reads as eighteen voters when
 *  it's actually two factions holding eighteen planets between them —
 *  Lorne asked why a 2-vote bill said 18. The line explains itself now. */
function tallyLine(totals) {
  const cell = (k, icon, label) => {
    const w = totals[k]?.weight ?? 0;
    const c = totals[k]?.count ?? 0;
    return `${icon} ${label} **${w}** _(${c} vote${c === 1 ? '' : 's'})_`;
  };
  return [
    cell('yea', '✅', 'Yea'),
    cell('nay', '❌', 'Nay'),
    cell('abstain', '⚪', 'Abstain'),
  ].join('   ·   ');
}

/**
 * Build the { embeds, components } payload for a vote card. Reused by the
 * initial post AND every button-click refresh so the message shape stays
 * identical and buttons survive updates.
 */
/**
 * What the bill actually DOES if it passes, in plain language.
 *
 * The card used to show only the proposer's pitch and a bill-kind label,
 * which is a campaign slogan, not a policy — a voter had no idea what
 * they were agreeing to. ("What does the bill do?" — Sean, in the
 * channel, looking at a card.) Every number here mirrors the constant
 * that actually applies the effect in senate.js/room.js.
 */
function billEffect(row, sliderById, targetName) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { /* best effort */ }
  const who = targetName || 'the target';

  switch (row.kind) {
    case 'slider_law': {
      const def = sliderById?.[payload.slider_id];
      const label = def?.label ?? payload.slider_id ?? 'a rule';
      const val = payload.target_value;
      return [
        `Sets **${label}** to **${val}** for everyone.`,
        def?.description ? `_${def.description}_` : null,
      ].filter(Boolean).join('\n');
    }
    case 'trade_embargo':
      return `Blocks **${who}** from all trade routes and deliveries for **14 ticks**.`;
    case 'war_authorization':
      return [
        `Everyone deals **double damage** to **${who}** for **21 ticks**.`,
        `Also **breaks every treaty ${who} holds** — NAPs, defense pacts and intel-sharing alike.`,
      ].join('\n');
    case 'production_sanction':
      return `Halves **${who}**'s resource harvest for **14 ticks**.`;
    case 'reparations':
      return `**${who}** pays **200 credits to every other faction** immediately (capped at what they actually hold).`;
    case 'chancellor_vote':
      return `Elects **${who}** Chancellor. **This can end the game.**`;
    default:
      return null;
  }
}

function buildVoteMessage(row, totals, gameName, effect) {
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const descParts = [];
  if (row.summary) descParts.push(row.summary);
  descParts.push(`**Bill:** ${kindLabel}`);
  // The mechanical consequence, separated from the proposer's pitch so a
  // voter can tell the two apart at a glance.
  if (effect) descParts.push(`\n**If this passes**\n${effect}`);
  descParts.push(`\nVoting closes at tick **${row.vote_closes_at_tick}**.`);
  // Spell the weighting rule out on every card. "Yea 18" with two voters
  // reads as a bug unless the reader already knows what weight is.
  descParts.push(`_${WEIGHT_RULE} You can change your vote until it closes._`);

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
function buildDebateMessage(row, gameName, proposerName, effect) {
  const kindLabel = KIND_LABELS[row.kind] ?? row.kind;
  const parts = [];
  if (row.summary) parts.push(row.summary);
  parts.push(`**Bill:** ${kindLabel}`);
  if (proposerName) parts.push(`**Proposed by:** ${proposerName}`);
  if (effect) parts.push(`\n**If this passes**\n${effect}`);
  parts.push(`\nDebate is open. Voting begins at tick **${row.vote_opens_at_tick}** and closes at tick **${row.vote_closes_at_tick}**.`);
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

/** Resolve everything billEffect needs: the slider catalogue and the
 *  targeted faction's display name. */
async function effectFor(env, gameId, row) {
  try {
    const senate = await import('./senate.js');
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { /* ok */ }
    const targetId = payload.target_faction_id || payload.candidate_faction_id;
    let targetName = null;
    if (targetId) {
      targetName = (await env.DB
        .prepare('SELECT name FROM game_factions WHERE id = ?')
        .bind(targetId).first())?.name ?? null;
    }
    return billEffect(row, senate.SLIDER_BY_ID, targetName);
  } catch (e) {
    console.error('billEffect failed', e);
    return null;   // a card without the effect line still beats no card
  }
}

async function gameName(env, gameId) {
  const r = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();
  return r?.name ?? null;
}

/** Master switch from the Bot Control panel. Defaults to ON when the
 *  settings table is unreachable — a D1 hiccup should not silently
 *  disable a feature the admin believes is running. */
async function senateCardsEnabled(env) {
  try {
    const cfg = await (await import('./botSettings.js')).getSettings(env);
    return cfg.senate_cards_enabled !== false;
  } catch { return true; }
}

// ---------- publishing (called from resolveSenate) ----------

/**
 * Post a vote card for a freshly-opened proposal. No-ops cleanly when the
 * bot isn't configured. Stores the resulting message id so button clicks
 * can refresh this exact message.
 */
export async function publishSenateVoteOpen(env, gameId, row) {
  if (!env.DISCORD_BOT_TOKEN) return { posted: false, reason: 'no_bot_token' };
  if (!(await senateCardsEnabled(env))) return { posted: false, reason: 'disabled' };
  const channelId = await resolveChannelId(env);
  if (!channelId) return { posted: false, reason: 'no_channel' };

  const totals = await loadProposalTotals(env, row.id);
  const payload = buildVoteMessage(
    row, totals, await gameName(env, gameId), await effectFor(env, gameId, row));

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
  if (!(await senateCardsEnabled(env))) return { posted: false, reason: 'disabled' };
  const channelId = await resolveChannelId(env);
  if (!channelId) return { posted: false, reason: 'no_channel' };

  const payload = buildDebateMessage(
    row, await gameName(env, gameId), proposerName, await effectFor(env, gameId, row));
  const res = await botFetch(env, 'POST', `/channels/${channelId}/messages`, payload);
  if (!res.ok) {
    console.error(`discord debate post failed: ${res.status} ${await res.text().catch(() => '')}`);
    return { posted: false, reason: `http_${res.status}` };
  }
  return { posted: true };
}

/** Post a plain embed to the shared channel. Used by battle cards and
 *  anything else that belongs to the room rather than a person. */
export async function postChannelEmbed(env, embed) {
  if (!env.DISCORD_BOT_TOKEN) return { posted: false, reason: 'no_bot_token' };
  const channelId = await resolveChannelId(env);
  if (!channelId) return { posted: false, reason: 'no_channel' };
  const res = await botFetch(env, 'POST', `/channels/${channelId}/messages`, { embeds: [embed] });
  if (!res.ok) {
    console.error(`channel embed post failed ${res.status}`, await res.text().catch(() => ''));
    return { posted: false, reason: `http_${res.status}` };
  }
  return { posted: true };
}

/**
 * Re-render a proposal's posted card in place.
 *
 * Called after ANY vote, not just Discord ones. Votes cast in-game used
 * to leave the channel card frozen — a bill could show "Nay 0" while a
 * 15-weight nay sat in the database, which is worse than showing no
 * tally at all because people were reading it and believing it.
 *
 * Best-effort: a failed refresh must never fail the vote.
 */
export async function refreshSenateCard(env, proposalId) {
  if (!env.DISCORD_BOT_TOKEN) return;
  try {
    const msg = await env.DB
      .prepare('SELECT game_id, channel_id, message_id FROM discord_senate_messages WHERE proposal_id = ?')
      .bind(proposalId).first();
    if (!msg) return;                      // never posted; nothing to refresh
    const row = await env.DB
      .prepare('SELECT * FROM senate_proposals WHERE id = ?').bind(proposalId).first();
    if (!row) return;

    const totals = await loadProposalTotals(env, proposalId);
    const payload = buildVoteMessage(
      row, totals, await gameName(env, msg.game_id),
      await effectFor(env, msg.game_id, row));

    // A resolved bill keeps its card but loses its buttons — clicking
    // Yea on a closed vote is a dead end that looks like a bug.
    const done = row.status !== 'voting' && row.status !== 'debating';
    await botFetch(env, 'PATCH', `/channels/${msg.channel_id}/messages/${msg.message_id}`, {
      embeds: payload.embeds,
      components: done ? [] : payload.components,
    });
  } catch (e) {
    console.error('refreshSenateCard failed', e, { proposalId });
  }
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

  // Read-only commands: checking your empire from a phone. All replies
  // are ephemeral — nobody wants their fleet disposition posted into a
  // channel full of rivals.
  const cmds = await import('./commands.js');

  // /msg closes the communication loop: relayed messages arrived in
  // Discord, but replying meant opening the game.
  if (name === 'msg') {
    const u = discordUserOf(interaction);
    if (!u?.id) return ephemeral('Could not read your Discord identity.');
    const o = interaction.data?.options ?? [];
    const get = (k) => o.find(x => x.name === k)?.value;
    try {
      return json(await cmds.cmdMsg(env, u.id, { to: get('to'), text: get('text') }));
    } catch (e) {
      console.error('slash /msg failed', e);
      return ephemeral('Could not send that message. Try again.');
    }
  }

  if (cmds.READ_COMMANDS[name]) {
    const user = discordUserOf(interaction);
    if (!user?.id) return ephemeral('Could not read your Discord identity.');
    try {
      return json(await cmds.READ_COMMANDS[name](env, user.id));
    } catch (e) {
      console.error(`slash /${name} failed`, e);
      return ephemeral('Something went wrong reading your empire. Try again.');
    }
  }

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
  // Linked — but NOT yet permitted to DM them. Ask, here, before anything
  // lands in their inbox. The buttons are the whole point: a "reply YES"
  // instruction gets ignored and we'd be left guessing.
  return json({
    type: 4,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [dmConsentEmbed()],
      components: dmConsentButtons(),
    },
  });
}

/**
 * The consent ask, shared by /link and the in-app OAuth return so both
 * paths pose the same question in the same words.
 *
 * It states what each choice costs, because the failure mode here is a
 * player declining out of vagueness and then wondering why the game never
 * tells them anything. "Server only" is a real, supported answer — not a
 * booby prize — and the copy says so.
 */
export function dmConsentEmbed() {
  return {
    title: '✅ Linked — do you want direct messages?',
    description: [
      'You can now vote on Senate bills straight from the channel. That works either way.',
      '',
      '**📬 Yes, DM me** — the daily situation report at 6pm Eastern, a nudge when a vote '
        + 'is about to close without you, and messages other factions send you in-game.',
      '',
      '**🔕 Server only** — nothing in your inbox, ever. Senate cards, the Orbital Herald '
        + 'and every slash command still work exactly the same.',
      '',
      '_You can change this any time with_ `/notify` _or in-game under Notifications._',
    ].join('\n'),
    color: POLITICS_COLOR,
  };
}

export function dmConsentButtons() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Yes, DM me', emoji: { name: '📬' }, custom_id: 'dmconsent:yes' },
      { type: 2, style: 2, label: 'Server only', emoji: { name: '🔕' }, custom_id: 'dmconsent:no' },
    ],
  }];
}

/**
 * Handle a click on either consent button.
 *
 * On "yes" we immediately send the welcome DM — not as a flourish, but as
 * a LIVE TEST. Discord privacy settings block DMs from server members by
 * default for a lot of people, and the failure is silent: we'd mark them
 * opted in and every report after that would vanish. Better to find out
 * in the same second they said yes, while they're still looking, and tell
 * them exactly which setting to change.
 */
async function handleDmConsentButton(env, interaction, choice) {
  const du = discordUserOf(interaction);
  if (!du?.id) return json({ type: 7, data: { content: 'Could not read your Discord identity.', embeds: [], components: [] } });

  const row = await env.DB
    .prepare('SELECT id FROM users WHERE discord_id = ?').bind(du.id).first();
  if (!row) {
    return json({ type: 7, data: { content: 'That link expired — generate a fresh code in-game.', embeds: [], components: [] } });
  }

  const notify = await import('./notify.js');
  await notify.setDmConsent(env, row.id, choice === 'yes');

  if (choice !== 'yes') {
    return json({ type: 7, data: {
      content: '🔕 **Server only.** Nothing will reach your inbox. Senate cards, the Herald '
        + 'and slash commands all still work — and `/notify` flips this back whenever you like.',
      embeds: [], components: [],
    } });
  }

  const res = await notify.sendDm(env, {
    userId: row.id,
    category: 'digest',
    embed: {
      title: '📬 You are set up',
      description: [
        'This is the channel your Orbital briefings will arrive on.',
        '',
        '• **6pm Eastern** — your daily situation report: fighting, inbound fleets, bills awaiting your vote.',
        '• **Deadlines** — a vote about to close without you, or unpaid fleet upkeep.',
        '• **Diplomacy** — messages and trade offers from other factions.',
        '',
        'Use `/notify` to turn any of it off.',
      ].join('\n'),
      color: POLITICS_COLOR,
    },
  });

  // The honest failure path. Naming the exact Discord setting is the
  // difference between a fixable problem and a player concluding the bot
  // is broken.
  const content = res.sent
    ? '📬 **DMs on.** Check your inbox — a welcome message is waiting. `/notify` changes this any time.'
    : '⚠️ You are opted in, but Discord **blocked the test message**. Open this server → '
      + 'right-click its icon → *Privacy Settings* → enable **Direct Messages**, then run '
      + '`/notify` to re-test. Until then everything still reaches you in the channel.';
  return json({ type: 7, data: { content, embeds: [], components: [] } });
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

  // Never answered the master question — ask it instead of showing a
  // category list that would do nothing. Common for anyone who dismissed
  // the ephemeral prompt after /link.
  const consent = await notify.dmConsentState(env, linked.id);
  if (consent == null) {
    return json({
      type: R_MESSAGE,
      data: { flags: FLAG_EPHEMERAL, embeds: [dmConsentEmbed()], components: dmConsentButtons() },
    });
  }

  const opts = interaction.data?.options ?? [];
  const category = opts.find(o => o.name === 'category')?.value;
  const stateRaw = opts.find(o => o.name === 'state')?.value;

  // `/notify category:all state:on` is the natural way to say "actually,
  // do DM me" — honour it as a consent answer rather than flipping
  // categories that the master gate still blocks.
  if (category === 'all' && String(stateRaw) === 'on' && consent === false) {
    await notify.setDmConsent(env, linked.id, true);
    return ephemeral('📬 **DMs back on.** Use `/notify` again to fine-tune which ones.');
  }
  if (consent === false) {
    return ephemeral(
      '🔕 You are set to **server only** — no direct messages. '
      + 'Turn them on with `/notify category:all state:on`, or in-game under Notifications.',
    );
  }

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

  // dmconsent:<yes|no> — the ask posted right after /link.
  if (parts[0] === 'dmconsent') {
    return handleDmConsentButton(env, interaction, parts[1]);
  }

  // orb:t:<gameId>:<tradeId>:<accept|decline>
  // Reuses trades.js's real handlers rather than reimplementing them —
  // accepting a trade moves resources and can create treaties, and a
  // second copy of that logic would drift from the authoritative one.
  if (parts[0] === 'orb' && parts[1] === 't') {
    const [, , gameId, tradeId, action] = parts;
    const user = discordUserOf(interaction);
    if (!user?.id) return ephemeral('Could not read your Discord identity.');
    const linked = await env.DB
      .prepare('SELECT id FROM users WHERE discord_id = ?').bind(user.id).first();
    if (!linked) return ephemeral('Link your Orbital account first with `/link <code>`.');

    const trades = await import('./trades.js');
    const fn = action === 'accept' ? trades.handleAccept
      : action === 'decline' ? trades.handleDecline : null;
    if (!fn) return ephemeral('Unrecognized action.');

    // Synthetic session: the handlers only read user_id, and going
    // through them keeps every ownership and affordability check intact.
    const res = await fn(new Request('https://orbital/internal', { method: 'POST' }), env, {
      session: { user_id: linked.id },
      params: { gameId, tradeId },
    });
    let payload = null;
    try { payload = await res.clone().json(); } catch { /* non-json */ }
    if (!res.ok) {
      return ephemeral(`Could not ${action} that trade: ${payload?.error?.message ?? res.status}`);
    }
    // Replace the buttons so the offer can't be actioned twice from a
    // stale message sitting in someone's DM history.
    return json({
      type: 7,
      data: {
        embeds: [{
          title: action === 'accept' ? '✅ Trade accepted' : '✖️ Trade declined',
          description: action === 'accept'
            ? 'Resources have moved and any pacts are in force.'
            : 'The offer was turned down.',
          color: action === 'accept' ? 0x4ecdc4 : 0x8a9fb3,
        }],
        components: [],
      },
    });
  }
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

  // Update the shared card for everyone...
  const totals = await loadProposalTotals(env, proposalId);
  const payload = buildVoteMessage(
    res.row, totals, await gameName(env, prop.game_id),
    await effectFor(env, prop.game_id, res.row));

  // ...and privately confirm to the CLICKER what they just did. The
  // shared card can't show per-person state (components are per-message,
  // not per-viewer), so without this a voter has no idea whether their
  // click registered as theirs — only that some number moved.
  // Read back the weight actually recorded, rather than trusting a field
  // on the result object that may not exist.
  const myWeight = (await env.DB
    .prepare('SELECT weight FROM senate_votes WHERE proposal_id = ? AND faction_id = ?')
    .bind(proposalId, faction.id).first())?.weight ?? null;

  // Where that weight came from, by name. A player who sees "weight 4"
  // and can also see WHICH four systems bought it learns the rule once
  // and never has to ask again.
  let whyWeight = '';
  try {
    const senate = await import('./senate.js');
    const detail = await senate.voteWeightDetail(env, prop.game_id, faction.id);
    whyWeight = detail.controlled.length
      ? `\n_Base 1 + ${detail.controlled.length} system${detail.controlled.length === 1 ? '' : 's'}: `
        + `${detail.controlled.map(s => s.label).join(', ')}._`
      : '\n_Base 1 — you control no systems outright yet._';
  } catch (e) {
    console.error('weight breakdown failed', e);
  }

  const appId = interaction.application_id;
  const token = interaction.token;
  if (appId && token) {
    const mine = choice === 'yea' ? '✅ Yea' : choice === 'nay' ? '❌ Nay' : '⚪ Abstain';
    // Fire-and-forget followup; the UPDATE response below is what Discord
    // is waiting on and must not be delayed by this.
    void fetch(`${DISCORD_API}/webhooks/${appId}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flags: FLAG_EPHEMERAL,
        content: `Your vote is recorded as **${mine}**${myWeight != null ? ` · weight **${myWeight}**` : ''}`
          + `. You can change it until the vote closes.${whyWeight}`,
      }),
    }).catch(() => {});
  }

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
    oauth_available: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
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
    name: 'msg',
    description: 'Send a message to another faction (or everyone) without opening the game.',
    options: [
      { name: 'to', description: 'Faction name, or "all" to broadcast.', type: 3, required: true },
      { name: 'text', description: 'What to say.', type: 3, required: true },
    ],
  },
  { name: 'status',   description: 'Your empire at a glance — resources, fleet, what needs you.' },
  { name: 'fleet',    description: 'Where your ships are, and what is under way.' },
  { name: 'research', description: 'Your current project and tech levels.' },
  { name: 'bills',    description: 'Senate bills on the floor and how you voted.' },
  { name: 'map',      description: 'The current territory map.' },
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
 * GET /api/admin/discord/probe-messages — can we read the channel at all?
 *
 * Diagnostic for the mention-responder. A Worker cannot hold a Gateway
 * socket, and @mentions are never delivered to an interactions endpoint,
 * so the only way for the bot to notice one is to poll the channel over
 * REST. That hinges on a question worth answering with evidence rather
 * than folklore: Discord's MESSAGE_CONTENT privileged intent gates
 * `content` on GATEWAY events, and it is widely — but not universally —
 * reported that REST fetches still return it. If it comes back empty
 * here, the whole approach is dead and we need the intent enabled.
 */
async function handleProbeMessages(_req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  if (!env.DISCORD_BOT_TOKEN) return err(400, 'not_configured', 'DISCORD_BOT_TOKEN is not set');
  const channelId = await resolveChannelId(env);
  if (!channelId) return err(400, 'not_configured', 'no channel configured');

  const appRes = await botFetch(env, 'GET', '/applications/@me');
  const app = appRes.ok ? await appRes.json() : null;

  const res = await botFetch(env, 'GET', `/channels/${channelId}/messages?limit=10`);
  if (!res.ok) {
    return json({
      ok: false, channelId,
      status: res.status,
      body: (await res.text().catch(() => '')).slice(0, 400),
      hint: res.status === 403 ? 'bot lacks View Channel / Read Message History here' : null,
    });
  }
  const msgs = await res.json();
  return json({
    ok: true,
    channelId,
    botId: app?.id ?? null,
    count: msgs.length,
    // The verdict: if every non-empty-looking message reports
    // content_len 0, the intent is required.
    sample: msgs.slice(0, 10).map(m => ({
      id: m.id,
      author: m.author?.username,
      bot: !!m.author?.bot,
      content_len: (m.content ?? '').length,
      preview: (m.content ?? '').slice(0, 60),
      mentions_me: (m.mentions ?? []).some(u => u.id === app?.id),
    })),
  });
}

/** POST /api/admin/discord/poll-mentions — run the mention poll now. */
async function handlePollMentions(_req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const mentions = await import('./mentions.js');
  return json(await mentions.pollMentions(env));
}

/**
 * GET /api/me/notifications — a player's OWN preferences.
 *
 * Session-authed and self-scoped: there is no user_id parameter, so this
 * cannot be pointed at somebody else's settings. The admin panel has its
 * own route for support cases.
 */
async function handleMyNotifications(_req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const notify = await import('./notify.js');
  const user = await env.DB
    .prepare('SELECT discord_id, discord_username FROM users WHERE id = ?')
    .bind(session.user_id).first();
  return json({
    ok: true,
    linked: !!user?.discord_id,
    discord_username: user?.discord_username ?? null,
    categories: notify.CATEGORIES,
    prefs: await notify.getPrefs(env, session.user_id),
    // null = linked but never answered the DM question. The panel shows
    // the ask rather than a toggle in that state, so a player who skipped
    // it in Discord still gets a clear yes/no in front of them.
    dm_consent: await notify.dmConsentState(env, session.user_id),
  });
}

/**
 * POST /api/me/dm-consent — answer the "do you want DMs" question.
 *
 * Shared by the OAuth return page and the in-game Notifications panel so
 * every path records the same thing. On yes it sends the welcome DM and
 * reports whether it actually landed: Discord blocks server-member DMs
 * by default for a lot of accounts, and that failure is silent — the
 * player would be marked opted in and simply never hear anything.
 */
async function handleDmConsentWrite(req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const notify = await import('./notify.js');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const consent = !!body.consent;
  await notify.setDmConsent(env, session.user_id, consent);

  let dmOk = null;
  if (consent) {
    const res = await notify.sendDm(env, {
      userId: session.user_id,
      category: 'digest',
      embed: {
        title: '📬 You are set up',
        description: [
          'This is the channel your Orbital briefings will arrive on.',
          '',
          '• **6pm Eastern** — your daily situation report.',
          '• **Deadlines** — a vote closing without you, or unpaid upkeep.',
          '• **Diplomacy** — messages and trade offers from other factions.',
          '',
          'Use `/notify` in Discord, or this panel, to turn any of it off.',
        ].join('\n'),
        color: POLITICS_COLOR,
      },
    });
    dmOk = res.sent;
  }
  return json({ ok: true, dm_consent: consent, dm_ok: dmOk });
}

/** PATCH /api/me/notifications — change one of your own categories. */
async function handleMyNotificationsWrite(req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const notify = await import('./notify.js');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  if (body.category === 'all') await notify.setAllPrefs(env, session.user_id, !!body.enabled);
  else if (!(await notify.setPref(env, session.user_id, body.category, !!body.enabled))) {
    return err(400, 'bad_request', 'unknown category');
  }
  return json({ ok: true, prefs: await notify.getPrefs(env, session.user_id) });
}

/**
 * GET /api/admin/bot — everything the control panel renders: settings,
 * which categories each linked player has muted, recent deliveries, and
 * whether the bot is actually wired (secrets present).
 */
async function handleBotOverview(_req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const settingsMod = await import('./botSettings.js');
  const notify = await import('./notify.js');

  const settings = await settingsMod.getSettings(env);

  const players = (await env.DB
    .prepare(
      `SELECT u.id, u.display_name, u.discord_username, u.discord_id
         FROM users u WHERE u.discord_id IS NOT NULL ORDER BY u.display_name`,
    ).all()).results ?? [];
  for (const p of players) {
    p.prefs = await notify.getPrefs(env, p.id);
    delete p.discord_id;          // no need to expose ids to the client
  }

  const recent = (await env.DB
    .prepare(
      `SELECT n.category, n.ok, n.created_ms, n.game_id, u.display_name
         FROM notification_log n LEFT JOIN users u ON u.id = n.user_id
        ORDER BY n.created_ms DESC LIMIT 40`,
    ).all()).results ?? [];

  const counts = (await env.DB
    .prepare(
      `SELECT category, COUNT(*) AS n, SUM(ok) AS delivered
         FROM notification_log WHERE created_ms > ?
        GROUP BY category`,
    ).bind(Date.now() - 7 * 86400000).all()).results ?? [];

  const games = (await env.DB
    .prepare(`SELECT g.id, r.name, g.current_tick FROM games g JOIN rooms r ON r.id=g.id WHERE g.status='active'`)
    .all()).results ?? [];

  // Which servers the bot is actually in — so the panel offers real
  // choices instead of a hardcoded id that breaks the moment a second
  // server appears.
  let guilds = [];
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const gr = await botFetch(env, 'GET', '/users/@me/guilds');
      if (gr.ok) guilds = (await gr.json()).map(g => ({ id: g.id, name: g.name }));
    } catch { /* panel still works without it */ }
  }

  return json({
    ok: true,
    settings,
    guilds,
    defaults: settingsMod.DEFAULTS,
    categories: notify.CATEGORIES,
    wired: {
      bot_token: !!env.DISCORD_BOT_TOKEN,
      public_key: !!env.DISCORD_PUBLIC_KEY,
      digest_webhook: !!env.DISCORD_DIGEST_WEBHOOK,
      channel_override: !!env.DISCORD_CHANNEL_ID,
    },
    players, recent, counts, games,
  });
}

/** PATCH /api/admin/bot — write one setting. */
async function handleBotSettingWrite(req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const settingsMod = await import('./botSettings.js');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const res = await settingsMod.setSetting(env, body.key, body.value, session.user_id);
  if (!res.ok) return err(400, 'bad_request', res.reason);
  return json({ ok: true, settings: await settingsMod.getSettings(env) });
}

/** PATCH /api/admin/bot/prefs — mute a category for a specific player. */
async function handleBotPrefWrite(req, env, { session }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const notify = await import('./notify.js');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  if (!body.user_id) return err(400, 'bad_request', 'user_id required');
  if (body.category === 'all') await notify.setAllPrefs(env, body.user_id, !!body.enabled);
  else if (!(await notify.setPref(env, body.user_id, body.category, !!body.enabled))) {
    return err(400, 'bad_request', 'unknown category');
  }
  return json({ ok: true, prefs: await notify.getPrefs(env, body.user_id) });
}

/**
 * POST /api/admin/alerts/:gameId — evaluate the interrupt alerts now.
 * The tick loop already does this, but on an hourly game that's an hour
 * per attempt to learn whether an alert reads well. Dedupe still applies,
 * so firing this repeatedly cannot spam anyone.
 */
async function handleAlertsNow(_req, env, { session, params }) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?').bind(params.gameId).first();
  if (!game) return err(404, 'not_found', 'no such game');
  const alerts = await import('./alerts.js');
  await alerts.runTickAlerts(env, params.gameId, game.current_tick ?? 0);
  const recent = (await env.DB
    .prepare(`SELECT category, ok, created_ms FROM notification_log
               WHERE game_id = ? ORDER BY created_ms DESC LIMIT 10`)
    .bind(params.gameId).all()).results ?? [];
  return json({ ok: true, tick: game.current_tick, recent });
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
  { method: 'GET',   pattern: '/api/me/notifications', auth: 'required', handle: handleMyNotifications },
  { method: 'PATCH', pattern: '/api/me/notifications', auth: 'required', handle: handleMyNotificationsWrite },
  { method: 'POST',  pattern: '/api/me/dm-consent',   auth: 'required', handle: handleDmConsentWrite },
  { method: 'GET',   pattern: '/api/admin/bot', auth: 'required', handle: handleBotOverview },
  { method: 'PATCH', pattern: '/api/admin/bot', auth: 'required', handle: handleBotSettingWrite },
  { method: 'PATCH', pattern: '/api/admin/bot/prefs', auth: 'required', handle: handleBotPrefWrite },
  { method: 'POST', pattern: '/api/admin/discord/register-commands', auth: 'required', handle: handleRegisterCommands },
  { method: 'GET',  pattern: '/api/admin/discord/probe-messages',    auth: 'required', handle: handleProbeMessages },
  { method: 'POST', pattern: '/api/admin/discord/poll-mentions',     auth: 'required', handle: handlePollMentions },
  { method: 'POST', pattern: /^\/api\/admin\/sitrep\/(?<gameId>[^/]+)$/, auth: 'required', handle: handleSitrepNow },
  { method: 'POST', pattern: /^\/api\/admin\/alerts\/(?<gameId>[^/]+)$/, auth: 'required', handle: handleAlertsNow },
  { method: 'POST', pattern: /^\/api\/admin\/senate\/(?<proposalId>[^/]+)\/announce$/, auth: 'required', handle: handleAnnounceProposal },
  { method: 'POST', pattern: '/api/discord/link-code',  auth: 'required', handle: handleMintLinkCode },
  { method: 'GET',  pattern: '/api/discord/link-status', auth: 'required', handle: handleLinkStatus },
  { method: 'POST', pattern: '/api/discord/unlink',      auth: 'required', handle: handleUnlink },
];
