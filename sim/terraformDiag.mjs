// ============================================================================
// terraformDiag.mjs — why isn't the expansion loop closing?
//
// The first sweep after teaching the bots to terraform came back with zero
// terraform_begun chronicles. That is the same class of silence as the old
// `settle_rej_not_terraformed` wall: the doctrine is issuing orders and
// nothing is happening, so the sweep's economy numbers describe a game
// where nobody expands.
//
// This walks ONE game tick by tick and reports the state of the pipeline at
// each stage, so the blockage can be attributed to a specific gate rather
// than inferred from an aggregate refusal count.
// ============================================================================

import { runGame } from './headless.mjs';

const TICKS = Number(process.argv[2] ?? 200);
const SEED = process.argv[3] ?? 'diag';

const { env, gameId } = await runGame({
  ticks: TICKS,
  players: 4,
  seed: SEED,
  quiet: true,
  // Same doctrine mix the sweep runs, so the diagnostic explains the
  // sweep rather than a different game.
  doctrines: ['rusher', 'expander', 'economist', 'technocrat'],
});

const q = async (sql, ...binds) =>
  (await env.DB.prepare(sql).bind(...binds).all()).results ?? [];

console.log(`\n=== terraform pipeline after ${TICKS} ticks (seed ${SEED}) ===\n`);

const bodies = await q(
  `SELECT COUNT(*) n,
          SUM(CASE WHEN terraformed_at_tick IS NOT NULL THEN 1 ELSE 0 END) tf,
          SUM(CASE WHEN terraform_acc_metal > 0 OR terraform_acc_gold > 0 THEN 1 ELSE 0 END) partial,
          SUM(CASE WHEN terraform_completes_at_tick IS NOT NULL THEN 1 ELSE 0 END) inwindow
     FROM game_bodies WHERE game_id = ?`, gameId);
console.log('bodies:', bodies[0]);

const owned = await q(
  `SELECT f.name,
          SUM(CASE WHEN b.owner_faction_id = f.id THEN 1 ELSE 0 END) owned,
          SUM(CASE WHEN b.owner_faction_id = f.id AND b.terraformed_at_tick IS NOT NULL THEN 1 ELSE 0 END) tf_owned
     FROM game_factions f LEFT JOIN game_bodies b ON b.game_id = f.game_id
    WHERE f.game_id = ? GROUP BY f.id`, gameId);
console.log('\nper faction owned / terraformed:');
for (const r of owned) console.log(' ', r.name.padEnd(22), `owned ${r.owned}  terraformed ${r.tf_owned}`);

const routes = await q(
  `SELECT kind, status, COUNT(*) n FROM game_trade_routes
    WHERE game_id = ? AND cancelled_at_tick IS NULL GROUP BY kind, status`, gameId);
console.log('\nlive routes:', routes.length ? routes : '(none)');

const allRoutes = await q(
  `SELECT kind, COUNT(*) n FROM game_trade_routes WHERE game_id = ? GROUP BY kind`, gameId);
console.log('routes ever created:', allRoutes.length ? allRoutes : '(none)');

const ships = await q(
  `SELECT ship_class, COUNT(*) n FROM game_ships
    WHERE game_id = ? AND status = 'active' GROUP BY ship_class`, gameId);
console.log('\nlive ships:', ships);

const setts = await q(
  `SELECT type, COUNT(*) n FROM game_settlements
    WHERE game_id = ? AND destroyed_at_tick IS NULL GROUP BY type`, gameId);
console.log('settlements:', setts);

const chron = await q(
  `SELECT kind, COUNT(*) n FROM chronicle_entries WHERE game_id = ? GROUP BY kind ORDER BY n DESC`, gameId);
console.log('\nchronicle:', chron.map(r => `${r.kind}:${r.n}`).join('  '));

// The meter itself — the single most diagnostic number. If payloads are
// partially delivered but never full, the constraint is haulage or pool
// balance, not the gate.
const meters = await q(
  `SELECT name, terraform_acc_metal m, terraform_acc_gold g, terraform_completes_at_tick w
     FROM game_bodies
    WHERE game_id = ? AND (terraform_acc_metal > 0 OR terraform_acc_gold > 0)`, gameId);
console.log('\npartial meters:', meters.length ? meters : '(none — nothing was ever delivered)');
