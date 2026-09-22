// ============================================================
// MOBILE MEGASTRUCTURE LAUNCH
//
// A finished Mega Destroyer or Mobile Foundry is not a structure, it
// is a slipway with a hull in it. This turns every finished slipway
// into that hull.
//
// It lives outside the Room so the moment of completion can call it
// directly — a hand delivery runs in the worker, a route unload in the
// tick — instead of the hull waiting up to an hour for the next sweep.
// The tick still sweeps too, as the backstop for anything that slipped.
// ============================================================

import { MEGASTRUCTURES } from './megastructures.js';
import { SHIP_COMBAT_STATS, parkPhaseFor } from './factions.js';

/** Every kind whose completion is a launch, straight from the catalogue. */
export const MOBILE_KINDS = Object.entries(MEGASTRUCTURES)
  .filter(([, spec]) => spec.family === 'mobile')
  .map(([kind]) => kind);

/**
 * Turn finished MOBILE sites into hulls.
 *
 * The two families diverge only here. A fixed structure switches on
 * where it stands and the site row IS the structure forever; a mobile
 * one was never a structure at all, it was a slipway — so the hull
 * launches and the site is spent.
 *
 * Runs as its own pass rather than inline in the two places a site can
 * complete (a manual delivery and a supply route). Those both just set
 * status='complete', and duplicating the launch into both is how one
 * of them ends up subtly different six months from now. This is also
 * why it is idempotent: it looks for completed mobile sites that still
 * have a body, so a retried tick cannot launch the same hull twice.
 */
/**
 * The INSERT for a capital hull (Mega Destroyer / Mobile Foundry), with
 * the owner's armour research applied. Returns a prepared statement, or
 * null for a kind with no hull stats.
 *
 * ONE PATH FOR EVERY CAPITAL HULL. A slipway finishing and a derelict
 * found in the Far Reach both mint one, and a second copy of this is how
 * the existing derelict destroyer ended up at 180 HP and 10 damage long
 * after the 10x hull ladder moved every real destroyer past a thousand:
 * its numbers were typed into the discovery and never heard about the
 * rebalance. Stats come from SHIP_COMBAT_STATS, so a found capital ship
 * is exactly the animal a built one is.
 *
 * INSERT OR IGNORE on a caller-chosen deterministic id, so two callers
 * racing a tick can never mint two hulls.
 */
export async function capitalHullInsert(env, {
  shipId, gameId, ownerId, kind, name, parentBodyId, tick,
}) {
  const stats = SHIP_COMBAT_STATS[kind];
  if (!stats || !ownerId) return null;
  // ARMOUR RESEARCH REACHES CAPITAL HULLS TOO — see the note in
  // launchCompletedMobileSites, which this was lifted out of.
  const capTech = (await env.DB
    .prepare(
      `SELECT tech_id, level FROM faction_techs
        WHERE game_id = ? AND faction_id = ? AND tech_id IN ('armor','shields')`,
    )
    .bind(gameId, ownerId).all()).results ?? [];
  const capDefLvl = capTech.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0);
  const capHp = Math.round(stats.hp * (1 + 0.08 * capDefLvl));
  return env.DB.prepare(
    `INSERT OR IGNORE INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
        orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, hp, hp_max, damage_per_tick,
        cargo_fuel, cargo_metal, cargo_gold, cargo_science, built_at_tick,
        home_body_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active',
             18, 20, 0, ?, ?, 1,
             ?, ?, ?, ?, ?,
             0, 0, 0, 0, ?,
             ?)`,
  ).bind(
    shipId, gameId, ownerId, name, kind, parentBodyId,
    parkPhaseFor(shipId), tick,
    // hp carries the armour; hp_max stays the catalogue BASE, exactly
    // like a normal build (room.js step 1). The repair cap multiplies
    // hp_max by armour itself, so baking armour in here counted it
    // twice: two live hulls launched 7200/7200 and began healing
    // toward 12,960.
    600, 600, capHp, stats.hp, stats.damage_per_tick, tick,
    // Home is the world it appeared at (0126).
    parentBodyId,
  );
}

export async function launchCompletedMobileSites(env, gameId, tick) {
  const ready = (await env.DB
    .prepare(
      `SELECT m.body_id, m.kind, b.name, b.parent_body_id, b.owner_faction_id,
              b.orbit_radius, b.orbit_period, b.angle0
         FROM game_megastructures m
         JOIN game_bodies b ON b.id = m.body_id
        WHERE m.game_id = ? AND m.status = 'complete'
          AND b.destroyed_at_tick IS NULL
          AND m.kind IN (${MOBILE_KINDS.map(() => '?').join(', ')})`,
    )
    .bind(gameId, ...MOBILE_KINDS).all()).results ?? [];
  if (ready.length === 0) return 0;

  let launched = 0;
  for (const site of ready) {
    const spec = MEGASTRUCTURES[site.kind];
    const stats = SHIP_COMBAT_STATS[site.kind];
    if (!spec || !stats) {
      // A mobile kind with no hull stats would sit "complete" forever,
      // which is the exact bug this function exists to end. The test in
      // sim/megaLaunch.mjs refuses to let one ship; this is the backstop.
      console.error('mobile megastructure has no hull stats; cannot launch', site.kind);
      continue;
    }
    // ARMOUR RESEARCH REACHES CAPITAL HULLS TOO. Every other ship in
    // the game spawns at hp x (1 + 0.08 x defenceLevel); these launched
    // at the flat catalogue number, so a Mega Destroyer built by an
    // Armour-10 faction was no tougher than one built by a faction
    // that had never opened the tree. They take no fittings by design —
    // their ability is the structure that made them — but that is an
    // argument about MOUNTS, not about a faction's metallurgy, and it
    // left two research tracks doing nothing at all for the most
    // expensive hull a player can field. (Applied in capitalHullInsert.)
    //
    // A site nobody owns cannot launch — there would be no fleet for
    // the hull to join. Ancient gates are unowned by design; a capital
    // slipway never should be, so this is a guard, not a case.
    if (!site.owner_faction_id) continue;

    // THE HULL'S ID IS THE SLIPWAY'S. Completion now launches from three
    // places (a hand delivery, a route unload, the tick's sweep), and an
    // action can land while a tick is running. Two callers that both read
    // the site before either retired it would each mint a hull. A
    // deterministic id + INSERT OR IGNORE makes the second one a no-op.
    const shipId = `${site.body_id}_hull`;
    // The hull appears in the orbit the site held, around the same
    // parent, so it is exactly where the player watched it being built
    // rather than teleporting to a capital.
    const hullInsert = await capitalHullInsert(env, {
      shipId, gameId, ownerId: site.owner_faction_id, kind: site.kind,
      name: spec.label, parentBodyId: site.parent_body_id, tick,
    });
    if (!hullInsert) continue;
    await env.DB.batch([
      hullInsert,
      // THE SLIPWAY IS RETIRED, NEVER DELETED.
      //
      // This used to hard-delete the site body, and it never once
      // worked in production. A slipway only completes because
      // freighters supplied it, and those leave rows pointing at it:
      // flight plans that targeted it (185 on one live site) and
      // chronicle entries that name it. Neither has an ON DELETE
      // clause, so D1 refused the DELETE, the whole batch rolled back —
      // hull included — and the tick's catch logged it. Every hour,
      // for days. Two players paid 12,000 metal and 8,000 credits each
      // for a Mega Destroyer that could never exist. ("my death star
      // is completed but i don't see how to make it do anything.")
      //
      // AND THE OBVIOUS FIX IS A TRAP. game_ships.parent_body_id is
      // ON DELETE CASCADE. Clear the rows that were blocking the
      // delete and it succeeds — taking every freighter still parked
      // at the slipway with it, silently. Six were parked at each.
      //
      // So nothing here deletes a body. destroyed_at_tick is the
      // game's own "gone" marker (every body query already filters on
      // it), it trips no foreign key, and it leaves history — old
      // deliveries, chronicle lines — still able to name the place.
      //
      // Whatever was PARKED at the slipway moves to the world it was
      // orbiting, and whatever is still FLYING to it lands there too.
      // History (executed and cancelled legs) is left alone: those
      // trips really did go to the slipway.
      env.DB.prepare(
        `UPDATE game_ships SET parent_body_id = ?
          WHERE game_id = ? AND parent_body_id = ?`,
      ).bind(site.parent_body_id, gameId, site.body_id),
      env.DB.prepare(
        `UPDATE game_ship_nodes SET target_body_id = ?
          WHERE game_id = ? AND target_body_id = ?
            AND status IN ('planned', 'committed', 'in_transit')`,
      ).bind(site.parent_body_id, gameId, site.body_id),
      env.DB.prepare('DELETE FROM game_megastructures WHERE body_id = ?')
        .bind(site.body_id),
      env.DB.prepare(
        'UPDATE game_bodies SET destroyed_at_tick = ? WHERE id = ? AND game_id = ?',
      ).bind(tick, site.body_id, gameId),
    ]);
    launched += 1;

    // ANNOUNCED — for real this time. This wrote to `game_chronicle`,
    // a table that has never existed; the catch below swallowed it,
    // so even a launch that worked would have happened in silence.
    // A capital hull appearing is exactly the news everyone else in
    // the system needs, so it is public, like the strike it enables.
    try {
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO chronicle_entries
             (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'megastructure_launched', ?, ?, ?, 'public', ?)`,
        )
        .bind(`${site.body_id}_launched`, gameId, tick,
              site.owner_faction_id, site.parent_body_id,
              JSON.stringify({ kind: site.kind, label: spec.label, ship_id: shipId }),
              Date.now())
        .run();
    } catch (e) {
      // Still never fails the launch — but never silently again either.
      console.error('megastructure_launched chronicle failed', e);
    }
  }
  return launched;
}
