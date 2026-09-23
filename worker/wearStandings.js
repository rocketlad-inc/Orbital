// ============================================================
// GET /wear/<token>/standings.json -- the Territory bar and the
// scoreboard under it, as the FACTION panel draws them in the game.
//
// THE GAME'S OWN ROSTER, NOT A SECOND COPY. This calls the game's
// /api/games/<id>/factions handler as the player (worker/factions.js
// handleListFactions), which is where the arithmetic and, more
// importantly, the SENSORS GATING live:
//
//   worlds, systems, vote weight   public -- borders are painted on
//                                  everyone's map and domination is a
//                                  win condition, so hiding the race
//                                  would make it unreadable
//   fleet count                    Fleet Census, Sensors 3
//   metal / credits / science      Economic Intel, Sensors 4
//
// A rival you cannot see the fleet of comes back with ships null, and
// the watch draws a lock rather than a number. Re-deriving any of that
// here would be a second rule set to drift against the game's.
//
// THE BAR IS THE PANEL'S BAR: every faction's share of the map in its
// own colour, the unclaimed remainder in grey, and the domination mark
// at the smallest count that wins (floor(total * fraction) + 1, the
// victory check's own arithmetic, from complicationExtras' config).
// ============================================================

import { authorizeWear } from './wear.js';
import { widgetSnapshot } from './widget.js';
import { callGame } from './wearOrders.js';

export const WEAR_STANDINGS_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/standings\.json$/;

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function handleWearStandings(_req, env, { params, ctx }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;

  const snap = await widgetSnapshot(env, auth.userId);
  // Eliminated and ended games still have standings -- the board is the
  // one thing that stays interesting when you are out of it.
  if (!snap || snap.state === 'none') return json({ ok: true, state: 'none', factions: [] });

  const r = await callGame(env, ctx, auth.userId, 'GET', `/api/games/${encodeURIComponent(snap.gameId)}/factions`, null);
  if (r.status !== 200 || !Array.isArray(r.body?.factions)) {
    return json({ ok: true, state: snap.state, factions: [] });
  }
  const rows = r.body.factions;
  const me = rows.find(f => f.user_id === auth.userId) ?? null;
  const total = Number(rows.find(f => (f.bodies_total ?? 0) > 0)?.bodies_total ?? 0);
  const systemsTotal = Number(rows.find(f => (f.systems_total ?? 0) > 0)?.systems_total ?? 0);
  const claimed = rows.reduce((n, f) => n + Number(f.bodies_owned ?? 0), 0);
  const fraction = 0.6;

  return json({
    ok: true,
    state: snap.state,
    tick: snap.tick,
    me: me?.id ?? null,
    worlds: {
      total,
      claimed,
      unclaimed: Math.max(0, total - claimed),
      systemsTotal,
      // Strictly more than the fraction wins, so this is the first count
      // that does -- the same number the panel's tick sits on.
      need: total > 0 ? Math.floor(total * fraction) + 1 : 0,
    },
    // Ranked as the panel ranks: worlds first, then senate weight.
    factions: rows
      .map(f => ({
        id: f.id,
        name: f.name,
        color: f.color || '#7d92a6',
        mine: !!me && f.id === me.id,
        out: f.status === 'eliminated',
        worlds: Number(f.bodies_owned ?? 0),
        systems: Number(f.systems_owned ?? 0),
        weight: Number(f.vote_weight ?? 0),
        // null where the player has not researched the intel for it.
        ships: f.ship_count == null ? null : Number(f.ship_count),
        metal: f.metal == null ? null : Number(f.metal),
        credits: f.gold == null ? null : Number(f.gold),
        science: f.science == null ? null : Number(f.science),
      }))
      .sort((a, b) => (b.worlds - a.worlds) || (b.weight - a.weight)),
  });
}
