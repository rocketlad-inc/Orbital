// ============================================================================
// recapMap.js — one battle, as a slice of the match film, for a public link.
//
//   GET /api/recap/<token>/map         a match summary scoped to the battle
//   GET /api/recap/<token>/map/replay  its snapshot rows, filtered
//
// The battle recap now plays on the game's own map renderer (BattleFilm on
// matchMap's focus mode), so it wears the current art. That renderer reads
// match_snapshots, and a snapshot records EVERY fleet in the system. A
// public link must not become a window onto a live game: this serves only
//   - ships that fought in this battle, or sat at its world;
//   - settlements at its world;
//   - no stockpiles, no pacts, no senate;
// and filters on the server, because a client-side filter is a suggestion.
// A non-participant that leaves the world is deleted from the reel as it
// goes, so it neither lingers in a stale position nor shows where it went.
// ============================================================================

/** Ticks of approach before the first shot, and of aftermath after the last. */
export const LEAD = 2;
export const TAIL = 3;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const err = (status, code, message) => json({ error: { code, message } }, status);

async function battleOf(env, share) {
  const b = await env.DB
    .prepare(
      `SELECT id, body_id, body_name, started_tick,
              COALESCE(ended_tick, last_fire_tick) AS ended_tick
         FROM battles WHERE id = ? AND game_id = ?`,
    )
    .bind(share.battle_id, share.game_id).first();
  if (!b || !b.body_id) return null;
  const range = await env.DB
    .prepare('SELECT MIN(tick_number) AS lo, MAX(tick_number) AS hi FROM match_snapshots WHERE game_id = ?')
    .bind(share.game_id).first();
  if (range?.lo == null || range.hi < b.started_tick) return null;
  return {
    ...b,
    lo: Math.max(range.lo, b.started_tick - LEAD),
    hi: Math.min(range.hi, b.ended_tick + TAIL),
  };
}

async function participantsOf(env, battleId) {
  const rows = (await env.DB
    .prepare('SELECT ship_id, parts FROM battle_participants WHERE battle_id = ?')
    .bind(battleId).all()).results ?? [];
  const parts = {};
  for (const r of rows) {
    let p = [];
    try { p = JSON.parse(r.parts || '[]'); } catch { p = []; }
    if (Array.isArray(p) && p.length) parts[r.ship_id] = p;
  }
  return { ids: new Set(rows.map(r => r.ship_id)), parts };
}

/** The match summary, cut down to what one battle's reel needs. */
export async function recapMapSummary(env, share) {
  const b = await battleOf(env, share);
  if (!b) return err(404, 'no_map', 'this battle has no map record');
  const { parts } = await participantsOf(env, b.id);
  const [gameQ, fxQ, bodiesQ, liveQ] = await env.DB.batch([
    env.DB.prepare(`SELECT g.id, r.name, g.status FROM games g LEFT JOIN rooms r ON r.id = g.id WHERE g.id = ?`)
      .bind(share.game_id),
    env.DB.prepare('SELECT id, name, color, color2, emblem FROM game_factions WHERE game_id = ?')
      .bind(share.game_id),
    env.DB.prepare(
      `SELECT id, name, type, color, radius, orbit_radius, orbit_period, angle0,
              parent_body_id, terraformed_at_tick, destroyed_at_tick
         FROM game_bodies WHERE game_id = ?`,
    ).bind(share.game_id),
    env.DB.prepare(
      `SELECT MIN(tick_number) AS t FROM match_snapshots
        WHERE game_id = ? AND tick_number BETWEEN ? AND ? AND state NOT LIKE '%"syn":1%'`,
    ).bind(share.game_id, b.lo, b.hi),
  ]);
  const game = gameQ.results?.[0];
  return json({
    game: { id: share.game_id, name: game?.name ?? null, status: game?.status ?? 'active', winner_faction_id: null },
    ticks: { lo: b.lo, hi: b.hi, rows: b.hi - b.lo + 1 },
    firstLiveTick: liveQ.results?.[0]?.t ?? null,
    factions: fxQ.results ?? [],
    bodies: bodiesQ.results ?? [],
    battles: [{ id: b.id, body_id: b.body_id, started_tick: b.started_tick, ended_tick: b.ended_tick }],
    parts,
    senate: [],
    focus: { bodyId: b.body_id, battleStart: b.started_tick, battleEnd: b.ended_tick },
  });
}

/**
 * Keep only this battle in one snapshot row. `kept` carries which hulls
 * and settlements the reel has been shown so far, across rows in order.
 * Pure, so the privacy rule is testable without a database.
 */
export function filterRow(row, { bodyId, participants, kept }) {
  const put = [];
  const del = [];
  for (const r of row.state?.put ?? []) {
    if (r[0] === 's') {
      const id = r[1];
      if (participants.has(id) || r[4] === bodyId) {
        put.push(r);
        kept.add('s:' + id);
      } else if (kept.has('s:' + id)) {
        // It was here and has gone somewhere else: it leaves the reel.
        del.push('s:' + id);
        kept.delete('s:' + id);
      }
    } else if (r[0] === 't') {
      if (r[2] === bodyId) {
        put.push(r);
        kept.add('t:' + r[1]);
      } else if (kept.has('t:' + r[1])) {
        del.push('t:' + r[1]);
        kept.delete('t:' + r[1]);
      }
    }
    // 'f' (stockpiles) and 'p' (pacts) never leave the server.
  }
  for (const k of row.state?.del ?? []) {
    if (kept.has(k)) { del.push(k); kept.delete(k); }
  }
  if (row.kind === 'key') {
    // A keyframe resets the world: only what it put survives.
    for (const k of [...kept]) {
      const id = k.slice(2);
      const stillHere = put.some(r => r[1] === id);
      if (!stillHere) kept.delete(k);
    }
  }
  const state = { v: row.state?.v ?? 1, put, del };
  if (row.state?.syn) state.syn = 1;
  return { t: row.t, kind: row.kind, state };
}

/**
 * Why the battle happened and what it was for, as the record has it.
 *
 *   wars    the wars open between its empires when the first shot was
 *           fired: who declared, when, and whether it broke an oath to
 *   stake   whose capital the world was, whether it had been terraformed
 *           by then, and what it yields
 *   series  the battles before and after this one in the same war, with
 *           their own recap links
 *
 * All of it is public in the game: a declaration is announced to every
 * empire and the Herald, capitals wear a star on the map, and yields are
 * on every world card. Who held the world before and after is not here:
 * the client reads that from the reel's own settlements.
 */
export async function recapContext(env, share) {
  const b = await env.DB
    .prepare(
      `SELECT id, body_id, started_tick, COALESCE(ended_tick, last_fire_tick) AS ended_tick, faction_ids
         FROM battles WHERE id = ? AND game_id = ?`,
    )
    .bind(share.battle_id, share.game_id).first();
  if (!b) return err(404, 'not_found', 'no such battle');
  let fids = [];
  try { fids = JSON.parse(b.faction_ids || '[]'); } catch { fids = []; }
  if (!Array.isArray(fids)) fids = [];
  const inBattle = new Set(fids);

  // Wars open at the first shot, between two empires that were both there.
  const warRows = (await env.DB
    .prepare(
      `SELECT faction_a, faction_b, declared_by, declared_at_tick, ended_at_tick, origin
         FROM game_wars
        WHERE game_id = ? AND declared_at_tick <= ?
          AND (ended_at_tick IS NULL OR ended_at_tick >= ?)
        ORDER BY declared_at_tick`,
    )
    .bind(share.game_id, b.started_tick, b.started_tick).all()).results ?? [];
  const wars = warRows
    .filter(w => inBattle.has(w.faction_a) && inBattle.has(w.faction_b))
    .map(w => ({
      a: w.faction_a, b: w.faction_b, declaredBy: w.declared_by,
      declaredAt: w.declared_at_tick, origin: w.origin ?? null,
    }));

  // The world, as it stood.
  let stake = null;
  if (b.body_id) {
    const body = await env.DB
      .prepare(
        `SELECT yield_metal, yield_gold, yield_science, terraformed_at_tick, type
           FROM game_bodies WHERE id = ? AND game_id = ?`,
      )
      .bind(b.body_id, share.game_id).first();
    const capital = await env.DB
      .prepare('SELECT id FROM game_factions WHERE game_id = ? AND capital_body_id = ? LIMIT 1')
      .bind(share.game_id, b.body_id).first();
    if (body) {
      stake = {
        capitalOf: capital?.id ?? null,
        terraformed: body.terraformed_at_tick != null && body.terraformed_at_tick <= b.ended_tick,
        type: body.type,
        yields: { metal: body.yield_metal ?? 0, credits: body.yield_gold ?? 0, science: body.yield_science ?? 0 },
      };
    }
  }

  // The same war's other battles: any battle both sides of one of these
  // wars fought in, inside the war's span.
  let series = { prev: null, next: null, count: 0 };
  if (wars.length) {
    const w = wars[0];
    const rows = (await env.DB
      .prepare(
        `SELECT bt.id, bt.body_name, bt.started_tick, bt.ships_lost, bt.faction_ids,
                (SELECT s.token FROM battle_shares s
                  WHERE s.battle_id = bt.id AND s.created_by IS NULL AND s.revoked_at_ms IS NULL
                  ORDER BY s.created_at_ms LIMIT 1) AS token
           FROM battles bt
          WHERE bt.game_id = ? AND bt.started_tick >= ? AND bt.status = 'ended'
          ORDER BY bt.started_tick`,
      )
      .bind(share.game_id, w.declaredAt).all()).results ?? [];
    const inWar = rows.filter(r => {
      let f = [];
      try { f = JSON.parse(r.faction_ids || '[]'); } catch { f = []; }
      return Array.isArray(f) && f.includes(w.a) && f.includes(w.b);
    });
    const at = inWar.findIndex(r => r.id === b.id);
    const pick = (r) => (r && r.token
      ? { token: r.token, name: r.body_name, tick: r.started_tick, lost: r.ships_lost }
      : null);
    series = {
      prev: at > 0 ? pick(inWar[at - 1]) : null,
      next: at >= 0 && at < inWar.length - 1 ? pick(inWar[at + 1]) : null,
      count: inWar.length,
      index: at >= 0 ? at + 1 : null,
    };
  }

  return json({ wars, stake, series });
}

/** The battle's rows, from the keyframe it needs to the aftermath. */
export async function recapMapReplay(env, share) {
  const b = await battleOf(env, share);
  if (!b) return err(404, 'no_map', 'this battle has no map record');
  const { ids } = await participantsOf(env, b.id);
  const key = await env.DB
    .prepare(
      `SELECT COALESCE(MAX(tick_number), ?2) AS t FROM match_snapshots
        WHERE game_id = ?1 AND kind = 'key' AND tick_number <= ?2`,
    )
    .bind(share.game_id, b.lo).first();
  const rows = (await env.DB
    .prepare(
      `SELECT tick_number AS t, kind, state FROM match_snapshots
        WHERE game_id = ? AND tick_number >= ? AND tick_number <= ?
        ORDER BY tick_number LIMIT 400`,
    )
    .bind(share.game_id, key?.t ?? b.lo, b.hi).all()).results ?? [];
  const kept = new Set();
  const out = [];
  for (const r of rows) {
    let state;
    try { state = JSON.parse(r.state); } catch { continue; }
    out.push(filterRow({ t: r.t, kind: r.kind, state }, { bodyId: b.body_id, participants: ids, kept }));
  }
  return json({ rows: out, nextFrom: null });
}
