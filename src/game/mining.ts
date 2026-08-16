import type { GameState, Body } from '../types';
import { eligibleBodies } from './tradeRouteRules';

// ============================================================
// mining — the numbers a player needs quoted back to them.
//
// These are MIRRORS of server constants, and the reason they live in one
// module instead of being typed into each panel is that the prose copies
// were already multiplying: shipParts.ts says "50/tick" in the Mining
// Rig blurb, BodyInspector says "fills at 50 a tick", and the meteoroid
// card says it again. Three hand-written copies of a tuning number is
// three chances to retune the server and leave the UI lying.
//
// miningMirrors.test.ts reads the worker sources and fails if either of
// these drifts, so the copy stays honest without anyone remembering to
// check.
// ============================================================

/** Units pulled from a rock per tick by one rigged freighter.
 *  MIRRORS MINE_RATE_PER_TICK in worker/room.js. */
export const MINE_RATE_PER_TICK = 50;

/** Base freighter hold. MIRRORS CARGO_CAP in worker/routeMath.js.
 *  A captain's cargo trait scales the real figure, which is why live
 *  panels prefer the server's `projection.hold_cap` and fall back to
 *  this — see RouteComposer. For "how many trips is this rock worth"
 *  the base is the right unit anyway: it is the number a player can
 *  reason with before assigning anyone. */
export const BASE_HOLD = 500;

/** Ticks a rigged freighter sits parked to fill one base hold.
 *  This is the whole risk of mining — it cannot leave while filling. */
export const TICKS_PER_HOLD = Math.ceil(BASE_HOLD / MINE_RATE_PER_TICK);

/** Whole freighter-loads still in a rock. Rounded UP, because a partial
 *  load is still a trip you have to make. */
export function loadsRemaining(remaining: number, holdCap: number = BASE_HOLD): number {
  if (!(remaining > 0) || !(holdCap > 0)) return 0;
  return Math.ceil(remaining / holdCap);
}

/** What a rock's mineral pays out as, IN THE PLAYER'S VOCABULARY.
 *  `gold` is the server's column name and appears nowhere in the UI —
 *  the ledger, the economy panel and every cost label say Credits. A
 *  card that says GOLD and then counts credits invents a currency.
 *
 *  Rocks carry metal or gold only —
 *  no science, because research drain clamps to income and a science
 *  rock would have paid into a bucket that cannot bank it. */
export function mineralUnit(kind: 'metal' | 'gold' | null | undefined): string {
  return kind === 'gold' ? 'credits' : 'metal';
}

// ============================================================
// PLANNING A MINING RUN FROM THE ROCK ITSELF.
//
// The route composer can express a mining run, but only if the player
// already knows the shape: pick the rock, pick a delivery world, find
// the one freighter that happens to carry a rig. That is a lot of prior
// knowledge to demand while looking at a rock and thinking "I want
// that". This works the arrangement out and hands the composer a route
// that is already valid, so the player confirms rather than assembles.
// ============================================================


export interface MiningRunPlan {
  carrierId: string;
  carrierName: string;
  dropoff: Body;
  stops: { bodyId: string; action: 'mine' | 'dropoff' }[];
  name: string;
}

export type MiningRunBlocker =
  | 'exhausted'      // nothing left in the rock
  | 'no_rig'         // no free freighter carries a Mining Rig
  | 'no_dropoff';    // nowhere to deliver to

/** Straight-line distance between two bodies at a given tick, used only
 *  to prefer the nearer of two otherwise-equal choices. Cheap on
 *  purpose: this ranks candidates, it does not price a transfer. */
function gap(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Work out the best mining run for this rock, or say why there isn't one.
 *
 * `positionOf` is injected rather than imported so this stays a pure
 * function the tests can drive without the orbital-mechanics module.
 */
export function planMiningRun(
  rock: Body,
  gameState: GameState,
  positionOf: (body: Body) => { x: number; y: number },
): { ok: true; plan: MiningRunPlan } | { ok: false; reason: MiningRunBlocker } {
  if ((rock.mineralRemaining ?? 0) <= 0) return { ok: false, reason: 'exhausted' };

  // ONE JOB PER HULL is a server rule, so a freighter already on a route
  // is not a candidate — offering it would be offering a move the server
  // refuses. Same set the composer's carrier picker excludes.
  const employed = new Set<string>();
  for (const r of gameState.tradeRoutes ?? []) {
    for (const c of r.ships ?? []) employed.add(c.shipId);
  }

  const rigged = gameState.ships.filter(
    s => s.ownedBy === 'player'
      && s.class === 'freighter'
      && !employed.has(s.id)
      && (s.parts ?? []).includes('mining'),
  );
  if (rigged.length === 0) return { ok: false, reason: 'no_rig' };

  // Delivery worlds come from the SHARED rule, so this can never offer a
  // dropoff the composer would reject.
  const { dropoff } = eligibleBodies(gameState);
  if (dropoff.length === 0) return { ok: false, reason: 'no_dropoff' };

  const rockPos = positionOf(rock);
  const byId = new Map(gameState.bodies.map(b => [b.id, b]));

  // Nearest delivery world to the ROCK: the loaded leg is the one that
  // matters, since that is the leg carrying something worth taking.
  const bestDrop = dropoff
    .map(b => ({ b, d: gap(rockPos, positionOf(b)) }))
    .sort((x, y) => x.d - y.d)[0].b;

  // Nearest idle rig to the rock, so the run starts sooner.
  const bestShip = rigged
    .map((s) => {
      const parent = s.orbit?.parentBodyId ? byId.get(s.orbit.parentBodyId) : undefined;
      return { s, d: parent ? gap(rockPos, positionOf(parent)) : Number.MAX_SAFE_INTEGER };
    })
    .sort((x, y) => x.d - y.d)[0].s;

  return {
    ok: true,
    plan: {
      carrierId: bestShip.id,
      carrierName: bestShip.name ?? 'freighter',
      dropoff: bestDrop,
      stops: [
        { bodyId: rock.id, action: 'mine' },
        { bodyId: bestDrop.id, action: 'dropoff' },
      ],
      name: `${rock.name} run`,
    },
  };
}
