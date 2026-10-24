// ============================================================================
// saga/dossier.js — everything the Saga Engine knows about a finished match.
//
// THE ONLY PART OF THE ENGINE THAT TOUCHES THE DATABASE. Everything after
// this is a pure function of what it returns, so the privacy line is drawn
// here, once, and checked by `npm run sim:saga` (it reads this file and fails
// on any query outside the whitelist below).
//
// PUBLIC RECORDS ONLY (Lorne, 2026-10-23: "Dont publish private messages").
//   read:   the ending payload (worker/ending.js, the same numbers the end
//           screen shows), PUBLIC chronicle rows, Senate laws and their
//           votes, the PUBLIC channel (messages.scope = 'broadcast', and only
//           where the sender is who it says it is), empire bios, the records
//           of veteran captains who were lost, the names of worlds.
//   never:  direct and group messages, the notes on trade offers, standing
//           trade agreements (private in the game itself: who trades with
//           whom is what the Sensors track sells; see tradeAgreements.js),
//           private chronicle rows.
// ============================================================================

import { buildEnding } from '../ending.js';

/** The public event-log kinds the engine reads (all `visibility = 'public'`). */
export const SAGA_CHRONICLE_KINDS = [
  'game_started', 'victory',
  'war_declared', 'war_ended', 'treaty_signed', 'treaty_broken',
  'settlement_built', 'settlement_seized', 'settlement_destroyed',
  'faction_eliminated', 'faction_revived',
  'captain_lost', 'ship_detonated',
  'kaiju_omen', 'kaiju_launched', 'kaiju_hunting', 'kaiju_dead',
  'sun_gate_opened', 'megastructure_complete',
  'dyson_initiated', 'dyson_milestone', 'dyson_damaged', 'dyson_collapsed',
  'terraform_complete', 'world_obliterated', 'asteroid_impact', 'missile_strike',
  'senate_vote', 'trade_accepted', 'asset_sold',
];

/** Rows of a D1 result. */
const rows = (r) => r?.results ?? [];
const parse = (s) => { try { return JSON.parse(s ?? 'null') ?? {}; } catch { return {}; } };

/**
 * Read a finished match. Returns null when the game is unknown or not over.
 * `opts.ordinal` overrides the film counter (tests and tools).
 */
export async function readDossier(env, gameId, opts = {}) {
  const ending = await buildEnding(env, gameId, null, { skipMembership: true, readOnly: true });
  if (!ending || ending.error) return null;

  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [chron, bios, said, captains, bodies, bills, votes] = await env.DB.batch([
    q(`SELECT tick_number AS t, kind, actor_faction_id AS a, target_faction_id AS b, body_id AS body, payload
         FROM chronicle_entries
        WHERE game_id = ? AND visibility = 'public'
          AND kind IN (${SAGA_CHRONICLE_KINDS.map(() => '?').join(',')})
        ORDER BY tick_number, created_at_ms
        LIMIT 5000`, gameId, ...SAGA_CHRONICLE_KINDS),
    q(`SELECT id, bio, slot FROM game_factions WHERE game_id = ?`, gameId),
    // THE PUBLIC CHANNEL ONLY, and only messages whose sender is who they
    // say they are: a forged broadcast quoted as the empire's own words
    // would put words in its mouth.
    q(`SELECT sent_at_tick AS t, actual_sender_faction_id AS fid, body
         FROM messages
        WHERE game_id = ? AND scope = 'broadcast'
          AND actual_sender_faction_id = claimed_sender_faction_id
        ORDER BY sent_at_tick, sent_at_ms
        LIMIT 600`, gameId),
    q(`SELECT faction_id AS fid, name, rank, bio, avatar_id AS avatar,
              created_at_tick AS t0, lost_at_tick AS t1, combat_history AS history
         FROM game_captains
        WHERE game_id = ? AND status = 'lost' AND rank >= 3
        ORDER BY rank DESC
        LIMIT 40`, gameId),
    q(`SELECT id, name, type FROM game_bodies WHERE game_id = ?`, gameId),
    q(`SELECT id, kind, title, status, proposer_faction_id AS proposer,
              proposed_at_tick AS proposed, resolved_at_tick AS resolved
         FROM senate_proposals WHERE game_id = ?
        ORDER BY proposed_at_tick`, gameId),
    q(`SELECT proposal_id AS pid, faction_id AS fid, vote, weight
         FROM senate_votes
        WHERE proposal_id IN (SELECT id FROM senate_proposals WHERE game_id = ?)`, gameId),
  ]);
  // The film counter: how many films the engine wrote before this one.
  let ordinal = opts.ordinal;
  if (ordinal == null) {
    try {
      ordinal = Number((await q(`SELECT COUNT(*) AS n FROM game_sagas WHERE game_id <> ?`, gameId).first())?.n ?? 0);
    } catch { ordinal = 0; }
  }

  const votesBy = new Map();
  for (const v of rows(votes)) {
    const l = votesBy.get(v.pid) ?? [];
    l.push({ fid: v.fid, vote: v.vote, weight: Number(v.weight) || 0 });
    votesBy.set(v.pid, l);
  }
  const bioOf = new Map(rows(bios).map(r => [r.id, String(r.bio ?? '').trim()]));
  const slotOf = new Map(rows(bios).map(r => [r.id, Number(r.slot) || 0]));

  return {
    gameId,
    ordinal,
    game: ending.game,
    empires: ending.factions.map(f => ({ ...f, bio: bioOf.get(f.id) || '', slot: slotOf.get(f.id) ?? 0 })),
    awards: ending.awards,
    series: ending.series,
    battles: ending.battles,
    totals: ending.totals,
    chronicle: rows(chron).map(r => ({ t: Number(r.t), kind: r.kind, a: r.a ?? null, b: r.b ?? null,
      body: r.body ?? null, p: parse(r.payload) })),
    said: rows(said).map(r => ({ t: Number(r.t), fid: r.fid, text: String(r.body ?? '') })),
    captains: rows(captains).map(r => ({ fid: r.fid, name: r.name, rank: Number(r.rank) || 0,
      bio: String(r.bio ?? '').trim(), avatar: r.avatar ?? null,
      t0: Number(r.t0) || 0, t1: r.t1 != null ? Number(r.t1) : null,
      history: Array.isArray(parse(r.history)) ? parse(r.history) : [] })),
    bodies: rows(bodies).map(r => ({ id: r.id, name: r.name, type: r.type })),
    bills: rows(bills).map(r => ({ ...r, votes: votesBy.get(r.id) ?? [] })),
  };
}
