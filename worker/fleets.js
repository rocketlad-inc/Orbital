// ============================================================
// Fleets — ships under a flag captain, common orders.
// DESIGN-fleets.md. Feature module (see worker/index.js FEATURE_MODULES).
//
// A fleet is a server-persistent group of same-faction ships led by a
// FLAG CAPTAIN (the captain of one member ship). Common standing orders
// mirror the bulk PATCH /ships/orders validation exactly; they are
// REFUSED while the fleet is leaderless (flag_captain_id NULL) — the
// player must promote a member captain first (surfaced as a
// decision-tier Situation Report row client-side).
// ============================================================

import { shipsInCombat } from './captains.js';

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const SHIP_ID_RE = /^[A-Za-z0-9_:-]{1,80}$/;
const FLEET_ID_RE = /^[A-Za-z0-9_:-]{1,80}$/;
const NAME_MAX = 48;

const STANCES = new Set(['attack', 'defensive', 'hold']);
const RETREAT_PCTS = new Set([25, 50, 75]);
const DETONATE_PCTS = new Set([25, 50]);

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

/** The caller's faction row in this game, or null. */
async function myFaction(env, gameId, userId) {
  return env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
}

function newFleetId(gameId) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${gameId}:fl_${rand}`;
}

/**
 * Load member ships for a set of ids with all-or-nothing ownership
 * validation (same contract as the bulk-orders endpoint: any missing,
 * destroyed, or foreign ship fails the whole call).
 */
async function loadOwnedShips(env, gameId, factionId, shipIds) {
  const unique = [...new Set(shipIds)];
  const placeholders = unique.map(() => '?').join(',');
  const rows = (await env.DB
    .prepare(
      `SELECT id, owner_faction_id, captain_id, fleet_id, status
         FROM game_ships
        WHERE game_id = ? AND id IN (${placeholders})`,
    )
    .bind(gameId, ...unique)
    .all()).results ?? [];
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of unique) {
    const row = byId.get(id);
    if (!row || row.status !== 'active') return { error: err(404, 'not_found', `ship not found: ${id}`) };
    if (row.owner_faction_id !== factionId) return { error: err(403, 'not_owner', `you do not own ship ${id}`) };
  }
  return { ships: unique.map(id => byId.get(id)) };
}

/** Fleet row + caller-ownership check. */
async function loadMyFleet(env, gameId, factionId, fleetId) {
  if (!FLEET_ID_RE.test(fleetId)) return { error: err(400, 'bad_request', 'invalid fleet id') };
  const fleet = await env.DB
    .prepare('SELECT id, faction_id, name, flag_captain_id FROM game_fleets WHERE game_id = ? AND id = ?')
    .bind(gameId, fleetId)
    .first();
  if (!fleet) return { error: err(404, 'not_found', 'fleet not found') };
  if (fleet.faction_id !== factionId) return { error: err(403, 'not_owner', 'not your fleet') };
  return { fleet };
}

async function memberIds(env, gameId, fleetId) {
  const rows = (await env.DB
    .prepare("SELECT id FROM game_ships WHERE game_id = ? AND fleet_id = ? AND status = 'active'")
    .bind(gameId, fleetId)
    .all()).results ?? [];
  return rows.map(r => r.id);
}

/** Disband when membership can no longer sustain a fleet (<2 actives).
 *  Shared by remove/patch handlers; the tick loop runs its own copy. */
async function pruneIfTooSmall(env, gameId, fleetId) {
  const ids = await memberIds(env, gameId, fleetId);
  if (ids.length >= 2) return false;
  await env.DB.batch([
    env.DB.prepare('UPDATE game_ships SET fleet_id = NULL WHERE game_id = ? AND fleet_id = ?').bind(gameId, fleetId),
    env.DB.prepare('DELETE FROM game_fleets WHERE game_id = ? AND id = ?').bind(gameId, fleetId),
  ]);
  return true;
}

async function writeChronicle(env, gameId, tick, kind, factionId, payload) {
  try {
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'public', ?)`,
      )
      .bind(`c_fl_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, kind,
            factionId, JSON.stringify(payload), Date.now())
      .run();
  } catch (e) {
    console.error('fleet chronicle write failed', kind, e);
  }
}

async function currentTick(env, gameId) {
  const g = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  return g?.current_tick ?? 0;
}

// ---------- POST /fleets ----------

/** ONE CAPTAIN PER FLEET (Lorne): the flag is the fleet's only officer.
 *  Ships joining a fleet surrender their captain back to the bank —
 *  rank intact, ready for reassignment. The flagship is exempt: its
 *  captain IS the fleet captain. */
async function bankMemberCaptains(env, gameId, shipIds, exceptShipId, tick) {
  const ids = shipIds.filter(id => id !== exceptShipId);
  if (ids.length === 0) return { ok: true };
  // Sending a member's captain to the bank IS a captain change, so it
  // answers to the under-fire rule like the assign endpoint does —
  // otherwise "form a fleet around the hull that's losing" would be the
  // way around it. Checked here because this is the one choke point every
  // path (create, add members) goes through.
  const hot = await shipsInCombat(env.DB, gameId, ids, tick);
  if (hot.size > 0) return { ok: false, blocked: [...hot] };
  const ph = ids.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE game_captains SET ship_id = NULL
        WHERE game_id = ? AND ship_id IN (${ph})`).bind(gameId, ...ids),
    env.DB.prepare(
      `UPDATE game_ships SET captain_id = NULL
        WHERE game_id = ? AND id IN (${ph})`).bind(gameId, ...ids),
  ]);
  return { ok: true };
}

/** Shared 409 for the two callers above. */
function inCombatError(blocked) {
  return err(409, 'in_combat',
    blocked.length === 1
      ? 'a ship you are fleeting is in combat — its captain stays at their post until the shooting stops'
      : `${blocked.length} ships you are fleeting are in combat — their captains stay at their posts until the shooting stops`);
}

async function handleCreate(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await myFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'no_faction', 'you are not in this game');

  const body = await readJson(req);
  const shipIds = Array.isArray(body?.ship_ids) ? body.ship_ids : null;
  const flagShipId = typeof body?.flag_ship_id === 'string' ? body.flag_ship_id : null;
  if (!shipIds || shipIds.length < 2) return err(400, 'bad_request', 'a fleet needs at least 2 ships');
  if (shipIds.some(id => typeof id !== 'string' || !SHIP_ID_RE.test(id))) {
    return err(400, 'bad_request', 'invalid ship id');
  }
  if (!flagShipId || !shipIds.includes(flagShipId)) {
    return err(400, 'bad_request', 'flag_ship_id must be one of ship_ids');
  }

  const loaded = await loadOwnedShips(env, gameId, me.id, shipIds);
  if (loaded.error) return loaded.error;
  const flag = loaded.ships.find(s => s.id === flagShipId);
  if (!flag.captain_id) {
    // ensureCaptains fills these every tick; a null here is a freshly
    // spawned hull between ticks. Ask the player to wait a tick rather
    // than minting a captainless flag.
    return err(409, 'no_captain', 'flagship has no captain — assign one from the bank (or recruit: 50M+100C)');
  }

  const cap = await env.DB
    .prepare('SELECT id, name FROM game_captains WHERE id = ?')
    .bind(flag.captain_id)
    .first();

  let name = typeof body?.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
  if (!name) name = `${cap?.name ?? 'Unnamed'}'s Squadron`;

  const fleetId = newFleetId(gameId);
  const tick = await currentTick(env, gameId);

  const stmts = [
    env.DB
      .prepare('INSERT INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(fleetId, gameId, me.id, name, flag.captain_id, tick),
  ];
  // Claim members (this also silently pulls them out of any prior fleet).
  const placeholders = loaded.ships.map(() => '?').join(',');
  stmts.push(
    env.DB
      .prepare(`UPDATE game_ships SET fleet_id = ? WHERE game_id = ? AND id IN (${placeholders})`)
      .bind(fleetId, gameId, ...loaded.ships.map(s => s.id)),
  );
  // ONE CAPTAIN PER FLEET. This call belonged here all along — it was
  // sitting in handlePatch's RENAME branch instead, referencing locals of
  // THIS function, so forming a fleet left a captain on every member and
  // renaming one threw. Runs before the batch so a refusal leaves no
  // half-made fleet behind.
  const banked = await bankMemberCaptains(env, gameId, loaded.ships.map(s => s.id), flagShipId, tick);
  if (!banked.ok) return inCombatError(banked.blocked);
  await env.DB.batch(stmts);

  // Prior fleets that just lost members may have dropped below 2.
  const priorFleets = [...new Set(loaded.ships.map(s => s.fleet_id).filter(Boolean))];
  for (const pf of priorFleets) await pruneIfTooSmall(env, gameId, pf);

  await writeChronicle(env, gameId, tick, 'fleet_formed', me.id, {
    fleet_id: fleetId, fleet_name: name,
    flag_captain: cap?.name ?? null, ships: loaded.ships.length,
  });

  return json({ fleet: { id: fleetId, name, flag_captain_id: flag.captain_id, ship_ids: shipIds } }, { status: 201 });
}

// ---------- PATCH /fleets/:fleetId ----------
async function handlePatch(req, env, ctx) {
  const { gameId, fleetId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await myFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'no_faction', 'you are not in this game');
  const got = await loadMyFleet(env, gameId, me.id, fleetId);
  if (got.error) return got.error;
  const fleet = got.fleet;

  const body = await readJson(req);
  if (!body) return err(400, 'bad_request', 'body required');
  const tick = await currentTick(env, gameId);

  // FLEET RETREAT THRESHOLD (migration 0113). On the FLEET, on combined
  // hull — per-hull retreat dissolves a squadron one ship at a time,
  // this breaks it as a formation. Both apply; setting one does not
  // disable the other.
  if ('retreat_hp_pct' in body) {
    const v = body.retreat_hp_pct;
    if (v !== null && !RETREAT_PCTS.has(Number(v))) {
      return err(400, 'bad_request', 'retreat_hp_pct must be null, 25, 50, or 75');
    }
    await env.DB
      .prepare('UPDATE game_fleets SET retreat_hp_pct = ? WHERE game_id = ? AND id = ?')
      .bind(v === null ? null : Number(v), gameId, fleetId)
      .run();
  }

  // DETACH / REJOIN. A detached hull KEEPS its membership — that is the
  // point — but is skipped by fleet-wide orders, fleet movement and the
  // fleet retreat threshold. LEAVE is permanent and forfeits the
  // captain arrangement; this is for "that one scouts ahead".
  if (Array.isArray(body.detach_ship_ids) || Array.isArray(body.rejoin_ship_ids)) {
    const set = (ids, val) => {
      const clean = (ids ?? []).filter(id => typeof id === 'string' && SHIP_ID_RE.test(id));
      if (clean.length === 0) return null;
      const ph = clean.map(() => '?').join(',');
      return env.DB
        .prepare(`UPDATE game_ships SET fleet_detached = ?
                   WHERE game_id = ? AND fleet_id = ? AND owner_faction_id = ?
                     AND id IN (${ph})`)
        .bind(val, gameId, fleetId, me.id, ...clean);
    };
    const stmts = [set(body.detach_ship_ids, 1), set(body.rejoin_ship_ids, 0)].filter(Boolean);
    if (stmts.length > 0) await env.DB.batch(stmts);
  }

  if (typeof body.name === 'string' && body.name.trim()) {
    await env.DB
      .prepare('UPDATE game_fleets SET name = ? WHERE game_id = ? AND id = ?')
      .bind(body.name.trim().slice(0, NAME_MAX), gameId, fleetId)
      .run();
    // (No captain work here — renaming a fleet doesn't move anybody. This
    // branch used to call bankMemberCaptains with handleCreate's locals,
    // which don't exist in this scope, so every rename 500'd.)
  }

  if (Array.isArray(body.add_ship_ids) && body.add_ship_ids.length > 0) {
    const loaded = await loadOwnedShips(env, gameId, me.id, body.add_ship_ids);
    if (loaded.error) return loaded.error;
    const ph = loaded.ships.map(() => '?').join(',');
    // Bank first: joiners surrender their captains, and if any of them is
    // under fire the join is refused before it moves anyone.
    const banked = await bankMemberCaptains(env, gameId, loaded.ships.map(x => x.id), null, tick);
    if (!banked.ok) return inCombatError(banked.blocked);
    await env.DB
      .prepare(`UPDATE game_ships SET fleet_id = ? WHERE game_id = ? AND id IN (${ph})`)
      .bind(fleetId, gameId, ...loaded.ships.map(s => s.id))
      .run();
    const priors = [...new Set(loaded.ships.map(s => s.fleet_id).filter(f => f && f !== fleetId))];
    for (const pf of priors) await pruneIfTooSmall(env, gameId, pf);
    // Joiners inherit the fleet's standing orders — take them from the
    // flagship's current row, the fleet's de-facto order sheet.
    if (fleet.flag_captain_id) {
      const flagShip = await env.DB
        .prepare('SELECT stance, retreat_hp_pct, detonate_hp_pct FROM game_ships WHERE captain_id = ?')
        .bind(fleet.flag_captain_id)
        .first();
      if (flagShip) {
        await env.DB
          .prepare(`UPDATE game_ships SET stance = ?, retreat_hp_pct = ?, detonate_hp_pct = ? WHERE game_id = ? AND id IN (${ph})`)
          .bind(flagShip.stance, flagShip.retreat_hp_pct, flagShip.detonate_hp_pct,
                gameId, ...loaded.ships.map(s => s.id))
          .run();
      }
    }
  }

  if (Array.isArray(body.remove_ship_ids) && body.remove_ship_ids.length > 0) {
    const loaded = await loadOwnedShips(env, gameId, me.id, body.remove_ship_ids);
    if (loaded.error) return loaded.error;
    const ph = loaded.ships.map(() => '?').join(',');
    await env.DB
      .prepare(`UPDATE game_ships SET fleet_id = NULL WHERE game_id = ? AND fleet_id = ? AND id IN (${ph})`)
      .bind(gameId, fleetId, ...loaded.ships.map(s => s.id))
      .run();
    // Removing the flagship beheads the fleet: leaderless until promoted.
    if (fleet.flag_captain_id && loaded.ships.some(s => s.captain_id === fleet.flag_captain_id)) {
      await env.DB
        .prepare('UPDATE game_fleets SET flag_captain_id = NULL WHERE game_id = ? AND id = ?')
        .bind(gameId, fleetId)
        .run();
    }
    if (await pruneIfTooSmall(env, gameId, fleetId)) {
      return json({ ok: true, disbanded: true });
    }
  }

  if (typeof body.flag_ship_id === 'string') {
    const ids = await memberIds(env, gameId, fleetId);
    if (!ids.includes(body.flag_ship_id)) {
      return err(400, 'bad_request', 'flag_ship_id must be a fleet member');
    }
    const ship = await env.DB
      .prepare('SELECT captain_id FROM game_ships WHERE game_id = ? AND id = ?')
      .bind(gameId, body.flag_ship_id)
      .first();
    let capId = ship?.captain_id ?? null;
    if (!capId) {
      // Promotion posts a bank captain onto this hull, so it is a captain
      // change and answers to the same rule as the assign endpoint —
      // otherwise "fleet up, then promote" is a clean bypass of it.
      // Membership was verified above, so the hull is ours to ask about.
      const hot = await shipsInCombat(env.DB, gameId, [body.flag_ship_id], tick);
      if (hot.has(body.flag_ship_id)) {
        return err(409, 'in_combat',
          'that ship is in combat — promote a captain once the shooting stops');
      }
      // Members are captainless BY DESIGN (one captain per fleet), so
      // promotion assigns the longest-waiting bank captain to the
      // chosen hull, then raises them to flag.
      const bank = await env.DB
        .prepare(`SELECT id FROM game_captains
                   WHERE game_id = ? AND faction_id = ? AND ship_id IS NULL
                     AND status = 'active'
                   ORDER BY created_at_tick ASC LIMIT 1`)
        .bind(gameId, me.id)
        .first();
      if (!bank) return err(409, 'no_captain', 'no captain in the bank — recruit one first');
      capId = bank.id;
      await env.DB.batch([
        env.DB.prepare('UPDATE game_captains SET ship_id = ? WHERE id = ?')
          .bind(body.flag_ship_id, capId),
        env.DB.prepare('UPDATE game_ships SET captain_id = ? WHERE game_id = ? AND id = ?')
          .bind(capId, gameId, body.flag_ship_id),
      ]);
    }
    await env.DB
      .prepare('UPDATE game_fleets SET flag_captain_id = ? WHERE game_id = ? AND id = ?')
      .bind(capId, gameId, fleetId)
      .run();
    const cap = await env.DB
      .prepare('SELECT name FROM game_captains WHERE id = ?').bind(capId).first();
    await writeChronicle(env, gameId, tick, 'fleet_flag_promoted', me.id, {
      fleet_id: fleetId, fleet_name: fleet.name, flag_captain: cap?.name ?? null,
    });
  }

  const flagRow = await env.DB
    .prepare('SELECT flag_captain_id, name FROM game_fleets WHERE game_id = ? AND id = ?')
    .bind(gameId, fleetId)
    .first();
  return json({ ok: true, fleet: { id: fleetId, name: flagRow?.name, flag_captain_id: flagRow?.flag_captain_id ?? null } });
}

// ---------- DELETE /fleets/:fleetId ----------
async function handleDisband(req, env, ctx) {
  const { gameId, fleetId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await myFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'no_faction', 'you are not in this game');
  const got = await loadMyFleet(env, gameId, me.id, fleetId);
  if (got.error) return got.error;
  await env.DB.batch([
    env.DB.prepare('UPDATE game_ships SET fleet_id = NULL WHERE game_id = ? AND fleet_id = ?').bind(gameId, fleetId),
    env.DB.prepare('DELETE FROM game_fleets WHERE game_id = ? AND id = ?').bind(gameId, fleetId),
  ]);
  return json({ ok: true });
}

// ---------- PATCH /fleets/:fleetId/orders ----------
// Mirrors the bulk /ships/orders contract; refused while leaderless.
async function handleFleetOrders(req, env, ctx) {
  const { gameId, fleetId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await myFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'no_faction', 'you are not in this game');
  const got = await loadMyFleet(env, gameId, me.id, fleetId);
  if (got.error) return got.error;
  if (!got.fleet.flag_captain_id) {
    return err(409, 'fleet_leaderless', 'the fleet has no flag captain — promote one first');
  }

  const body = await readJson(req);
  if (!body) return err(400, 'bad_request', 'body required');
  const hasStance = 'stance' in body;
  const hasRetreat = 'retreat_hp_pct' in body;
  const hasDetonate = 'detonate_hp_pct' in body;
  if (!hasStance && !hasRetreat && !hasDetonate) {
    return err(400, 'bad_request', 'no order fields supplied');
  }
  if (hasStance && !STANCES.has(body.stance)) {
    return err(400, 'bad_request', "stance must be 'attack', 'defensive', or 'hold'");
  }
  if (hasRetreat && body.retreat_hp_pct !== null && !RETREAT_PCTS.has(body.retreat_hp_pct)) {
    return err(400, 'bad_request', 'retreat_hp_pct must be null, 25, 50, or 75');
  }
  if (hasDetonate && body.detonate_hp_pct !== null && !DETONATE_PCTS.has(body.detonate_hp_pct)) {
    return err(400, 'bad_request', 'detonate_hp_pct must be null, 25, or 50');
  }

  const ids = await memberIds(env, gameId, fleetId);
  if (ids.length === 0) return err(409, 'empty_fleet', 'fleet has no active members');
  const sets = [];
  const binds = [];
  if (hasStance) { sets.push('stance = ?'); binds.push(body.stance); }
  if (hasRetreat) { sets.push('retreat_hp_pct = ?'); binds.push(body.retreat_hp_pct); }
  if (hasDetonate) { sets.push('detonate_hp_pct = ?'); binds.push(body.detonate_hp_pct); }
  const ph = ids.map(() => '?').join(',');
  await env.DB
    .prepare(`UPDATE game_ships SET ${sets.join(', ')} WHERE game_id = ? AND id IN (${ph})`)
    .bind(...binds, gameId, ...ids)
    .run();
  return json({ ok: true, updated: ids.length });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/fleets$/, auth: 'required', handle: handleCreate },
  { method: 'PATCH', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/fleets\/(?<fleetId>[^/]+)\/orders$/, auth: 'required', handle: handleFleetOrders },
  { method: 'PATCH', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/fleets\/(?<fleetId>[^/]+)$/, auth: 'required', handle: handlePatch },
  { method: 'DELETE', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/fleets\/(?<fleetId>[^/]+)$/, auth: 'required', handle: handleDisband },
];
