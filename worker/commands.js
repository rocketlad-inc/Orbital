// ============================================================================
// commands.js — read-only slash commands.
//
// The point of these is a player checking their empire from a phone
// without loading a canvas game. So every response is ephemeral (only
// the caller sees it — nobody wants their fleet disposition posted to a
// channel of rivals), and every one answers in a single screen.
//
// Resolution chain for all of them: discord_id -> user -> their most
// recently active game -> faction. A player in several games gets their
// freshest one, which is nearly always the one they meant.
// ============================================================================

import { STRIP_PUBLIC_URL } from './heraldStrip.js';

const EPHEMERAL = 64;
const COLOR = 0x4ecdc4;

function reply(content) {
  return { type: 4, data: { content, flags: EPHEMERAL } };
}
function replyEmbed(embed) {
  return { type: 4, data: { embeds: [embed], flags: EPHEMERAL } };
}

/**
 * Resolve the caller to a faction in a live game.
 * Returns { error } as a ready-to-send response, or { user, game, faction }.
 */
export async function resolveCaller(env, discordId) {
  const user = await env.DB
    .prepare('SELECT id, display_name FROM users WHERE discord_id = ?')
    .bind(discordId).first();
  if (!user) {
    return { error: reply('Link your account first: in-game Senate panel → Link Discord, then `/link <code>` here.') };
  }
  // Most recently ticked active game the player holds a live faction in.
  const row = await env.DB
    .prepare(
      `SELECT g.id AS game_id, g.current_tick, g.next_tick_at, g.tick_interval_ms,
              r.name AS game_name, f.id AS faction_id, f.name AS faction_name,
              f.metal, f.fuel, f.gold, f.science
         FROM game_factions f
         JOIN games g ON g.id = f.game_id
         JOIN rooms r ON r.id = g.id
        WHERE f.user_id = ? AND f.status = 'active' AND g.status = 'active'
        ORDER BY g.current_tick DESC LIMIT 1`,
    )
    .bind(user.id).first();
  if (!row) return { error: reply('You have no active empire right now.') };
  return { user, row };
}

function footer(row) {
  const mins = row.next_tick_at
    ? Math.max(0, Math.round((row.next_tick_at - Date.now()) / 60000))
    : null;
  return {
    text: [
      `${row.game_name} · T+${row.current_tick}`,
      mins != null ? `next tick ~${mins}m` : null,
    ].filter(Boolean).join(' · '),
  };
}

// ---------------------------------------------------------------------------

export async function cmdStatus(env, discordId) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { row } = r;

  const ships = (await env.DB
    .prepare(`SELECT COUNT(*) n FROM game_ships WHERE game_id=? AND owner_faction_id=? AND hp>0`)
    .bind(row.game_id, row.faction_id).first())?.n ?? 0;
  const cities = (await env.DB
    .prepare(`SELECT COUNT(*) n FROM game_settlements WHERE game_id=? AND owner_faction_id=?`)
    .bind(row.game_id, row.faction_id).first())?.n ?? 0;
  const building = (await env.DB
    .prepare(`SELECT COUNT(*) n FROM game_body_build_queue
               WHERE game_id=? AND faction_id=? AND cancelled_at_tick IS NULL AND completes_at_tick > ?`)
    .bind(row.game_id, row.faction_id, row.current_tick).first())?.n ?? 0;
  const bills = (await env.DB
    .prepare(`SELECT COUNT(*) n FROM senate_proposals p
               WHERE p.game_id=? AND p.status='voting'
                 AND NOT EXISTS (SELECT 1 FROM senate_votes v
                                  WHERE v.proposal_id=p.id AND v.faction_id=?)`)
    .bind(row.game_id, row.faction_id).first())?.n ?? 0;

  return replyEmbed({
    title: `🛰️ ${row.faction_name}`,
    color: COLOR,
    fields: [
      { name: 'Resources', value: `**${Math.round(row.metal)}**M · **${Math.round(row.gold)}**C · **${Math.round(row.science)}**S`, inline: false },
      { name: 'Holdings', value: `**${ships}** ships · **${cities}** settlements`, inline: true },
      { name: 'Building', value: building > 0 ? `**${building}** in the yards` : '—', inline: true },
      ...(bills > 0 ? [{ name: '🏛️ Needs you', value: `**${bills}** bill${bills === 1 ? '' : 's'} awaiting your vote`, inline: false }] : []),
    ],
    footer: footer(row),
  });
}

// ---------------------------------------------------------------------------

export async function cmdFleet(env, discordId) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { row } = r;

  const parked = (await env.DB
    .prepare(
      `SELECT b.name AS body, s.ship_class, COUNT(*) n
         FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
        WHERE s.game_id=? AND s.owner_faction_id=? AND s.hp>0
        GROUP BY b.id, s.ship_class ORDER BY b.name`,
    )
    .bind(row.game_id, row.faction_id).all()).results ?? [];

  const moving = (await env.DB
    .prepare(
      `SELECT b.name AS body, COUNT(*) n
         FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
         JOIN game_bodies b ON b.id = n.target_body_id
        WHERE n.game_id=? AND s.owner_faction_id=? AND n.status='in_transit' AND s.hp>0
        GROUP BY b.id`,
    )
    .bind(row.game_id, row.faction_id).all()).results ?? [];

  if (!parked.length && !moving.length) return reply('You have no ships.');

  // Collapse per body so a 40-hull empire still fits one screen.
  const byBody = new Map();
  for (const p of parked) {
    const e = byBody.get(p.body) ?? [];
    e.push(`${p.n}× ${p.ship_class}`);
    byBody.set(p.body, e);
  }

  const fields = [...byBody.entries()].slice(0, 20)
    .map(([body, list]) => ({ name: body, value: list.join(', '), inline: true }));
  if (moving.length) {
    fields.push({
      name: '🚀 Under way',
      value: moving.map(m => `**${m.n}** → ${m.body}`).join('\n').slice(0, 1000),
      inline: false,
    });
  }

  return replyEmbed({
    title: `◈ ${row.faction_name} — fleet`,
    color: COLOR, fields, footer: footer(row),
  });
}

// ---------------------------------------------------------------------------

export async function cmdResearch(env, discordId) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { row } = r;

  const techs = (await env.DB
    .prepare(`SELECT tech_id, level, status FROM faction_techs WHERE game_id=? AND faction_id=?`)
    .bind(row.game_id, row.faction_id).all()).results ?? [];
  if (!techs.length) return reply('No research yet.');

  const active = techs.find(t => t.status === 'researching');
  const levels = techs
    .filter(t => (t.level ?? 0) > 0)
    .sort((a, b) => b.level - a.level)
    .map(t => `**${t.tech_id}** ${t.level}`)
    .join(' · ');

  return replyEmbed({
    title: `⚛ ${row.faction_name} — research`,
    color: COLOR,
    description: [
      active ? `Currently: **${active.tech_id}** → level ${(active.level ?? 0) + 1}` : '_Nothing in progress_',
      '',
      levels || '_No levels yet_',
      '',
      `Banked science: **${Math.round(row.science)}**`,
    ].join('\n'),
    footer: footer(row),
  });
}

// ---------------------------------------------------------------------------

export async function cmdBills(env, discordId) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { row } = r;

  const bills = (await env.DB
    .prepare(
      `SELECT p.id, p.title, p.status, p.vote_closes_at_tick,
              (SELECT vote FROM senate_votes v WHERE v.proposal_id=p.id AND v.faction_id=?) AS my_vote
         FROM senate_proposals p
        WHERE p.game_id=? AND p.status IN ('debating','voting')
        ORDER BY p.vote_closes_at_tick ASC`,
    )
    .bind(row.faction_id, row.game_id).all()).results ?? [];
  if (!bills.length) return reply('Nothing on the senate floor.');

  return replyEmbed({
    title: '🏛️ On the floor',
    color: 0xc4b5fd,
    description: bills.slice(0, 10).map(b => {
      const state = b.status === 'debating'
        ? `debating · opens soon`
        : `closes T+${b.vote_closes_at_tick} (${b.vote_closes_at_tick - row.current_tick})`;
      const mine = b.my_vote ? `— you voted **${b.my_vote}**` : (b.status === 'voting' ? '— **you have not voted**' : '');
      return `**${b.title}**\n${state} ${mine}`;
    }).join('\n\n').slice(0, 3500),
    footer: footer(row),
  });
}

// ---------------------------------------------------------------------------

export async function cmdMap(env, discordId) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { row } = r;
  // Discord fetches embed.image.url itself, so pointing at the public PNG
  // route avoids a multipart upload entirely AND guarantees the image is
  // current at the moment it renders rather than when we sent it.
  const url = `${STRIP_PUBLIC_URL(env, row.game_id)}.png?t=${row.current_tick}`;
  return {
    type: 4,
    data: {
      flags: EPHEMERAL,
      embeds: [{
        title: `🗺️ ${row.game_name} — territory`,
        color: COLOR,
        image: { url },
        footer: footer(row),
      }],
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * /msg to:<faction|all> text:<...>
 *
 * The half of the bridge that was missing: relayed messages arrived in
 * Discord but replying meant opening the game. Diplomacy in a game like
 * this already happens in Discord — the bot may as well carry it.
 *
 * Sends as YOU. The schema supports a claimed sender distinct from the
 * real one (forged diplomacy), but the send API has never exposed it,
 * and quietly adding a deception mechanic from a chat command is a
 * game-design decision rather than a bot feature.
 */
export async function cmdMsg(env, discordId, opts) {
  const r = await resolveCaller(env, discordId);
  if (r.error) return r.error;
  const { user, row } = r;

  const to = String(opts.to ?? '').trim();
  const text = String(opts.text ?? '').trim();
  if (!to || !text) return reply('Usage: `/msg to:<faction or "all"> text:<your message>`');

  const factions = (await env.DB
    .prepare(`SELECT id, name FROM game_factions
               WHERE game_id = ? AND status = 'active' AND id != ?`)
    .bind(row.game_id, row.faction_id).all()).results ?? [];

  const messages = await import('./messages.js');
  const send = async (body) => {
    // handleSend parses its payload from the Request, so give it a real
    // one rather than a fourth argument it would ignore.
    const res = await messages.handleSend(
      new Request('https://orbital/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      { session: { user_id: user.id }, params: { gameId: row.game_id } },
    );
    let payload = null;
    try { payload = await res.clone().json(); } catch { /* non-json */ }
    return { ok: res.ok, payload };
  };

  if (to.toLowerCase() === 'all' || to.toLowerCase() === 'broadcast') {
    const out = await send({ scope: 'broadcast', body: text, signed: 1 });
    if (!out.ok) return reply(`Could not send: ${out.payload?.error?.message ?? 'rejected'}`);
    return reply(`📡 Broadcast sent to every faction in **${row.game_name}**.`);
  }

  // Match on name, case-insensitively: exact first, then unique prefix,
  // then unique substring. Ambiguity is reported rather than guessed —
  // sending a private message to the wrong empire is unrecoverable.
  const lower = to.toLowerCase();
  let hits = factions.filter(f => f.name.toLowerCase() === lower);
  if (!hits.length) hits = factions.filter(f => f.name.toLowerCase().startsWith(lower));
  if (!hits.length) hits = factions.filter(f => f.name.toLowerCase().includes(lower));

  if (!hits.length) {
    return reply(`No faction matches "${to}". In this game: ${factions.map(f => `**${f.name}**`).join(', ') || '(none)'}`);
  }
  if (hits.length > 1) {
    return reply(`"${to}" matches ${hits.length} factions: ${hits.map(f => `**${f.name}**`).join(', ')}. Be more specific.`);
  }

  const target = hits[0];
  const out = await send({
    scope: 'dm', body: text, signed: 1, recipient_faction_ids: [target.id],
  });
  if (!out.ok) return reply(`Could not send: ${out.payload?.error?.message ?? 'rejected'}`);
  return reply(`✉️ Sent to **${target.name}**.`);
}

export const READ_COMMANDS = {
  status: cmdStatus,
  fleet: cmdFleet,
  research: cmdResearch,
  bills: cmdBills,
  map: cmdMap,
};
