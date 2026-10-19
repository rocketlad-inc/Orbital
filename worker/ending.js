// ============================================================================
// GET /api/games/:gameId/ending — everything the end-of-game page shows,
// computed once, on demand, for a FINISHED game.
//
// The shape is the contract in src/multiplayer/endingTypes.ts (EndingPayload).
// This file is the only producer. Principles it keeps:
//
//   * Structure, not prose. Ids and numbers; the page owns every word.
//   * Nothing a player could not already see in the game: faction names,
//     colours, emblems, ship and captain names. No emails, no account display
//     names, no user ids (user_id is read only to find the VIEWER's empire and
//     is never copied into the payload).
//   * An award exists only when real data stands behind it.
//
// Cost: two round trips. One (in parallel) for the game row + membership, then
// ONE env.DB.batch carrying every aggregate. No per-faction loops. Every
// statement binds <= 4 params (D1 allows 100). A third, tiny batch happens only
// when a replayable battle on the timeline has no house replay link yet (see
// attachClips): the endpoint's one and only write.
//
// ---------------------------------------------------------------------------
// WHERE EACH NUMBER COMES FROM (and why — several tables look interchangeable
// and are not; this was checked against production rows of finished games):
//
//  holdings  Worlds (distinct bodies) on which the empire had a settlement,
//            rebuilt from game_settlements' own lifetime (created_at_tick ..
//            destroyed_at_tick, one row per settlement, owner fixed: a seizure
//            destroys the old row and creates a new one). NOT from
//            faction_metrics.settlements: that column counts every settlement
//            row the empire ever owned, destroyed ones included, so on prod it
//            only ever climbs (an empire with 5 live settlements reads 29).
//            This is also the lobby's definition (COUNT DISTINCT body_id).
//  ships     game_ships with hp > 0 (final), faction_metrics.ships (series,
//            peak) — the same predicate, so the curve ends where final says.
//  credits   faction_metrics.gold / game_factions.gold (the app calls gold
//            "credits"). science and metal likewise.
//  techs     SUM(faction_techs.level): research levels completed across the
//            tech tracks. (A track row is one tech with a level up to 10, so
//            counting rows would cap everyone at 6.) Ties on the scholar award
//            go to whoever got there first (MAX(completed_at_tick)).
//  kills     battle_participants rows where this empire is killer_faction_id
//            and the victim belonged to someone else. NOT game_ship_stats.kills:
//            that column credits EVERY attacker present at a kill, so on prod a
//            corvette with one real kill reads 24 and an empire with 113 hulls
//            lost reads 7502 kills. Hull "ace" uses killer_ship_id the same way.
//  shipsLost battle_participants rows with died_tick set, by the loser's empire.
//  damage    SUM(game_ship_stats.damage_dealt) by empire (complete per tick;
//            battle_participants omits some pre-battle fire). It agrees with
//            the per-battle numbers to within a few percent.
//  last_stand game_ship_stats.low_hp_kills, capped at the hull's real kills
//            (killer_ship_id) because it shares kills' over-crediting.
//  shipsBuilt chronicle_entries kind 'ship_built' by actor (every hull class).
//  trades    One "trade" = one ACCEPTED trade_offers row that moves goods or a
//            ship (pact-only acceptances — a NAP with nothing attached — are
//            diplomacy, not trade), plus any market_fills row that has no
//            accepted offer behind it (market fills normally ARE accepted
//            offers, so adding both would count them twice). Each of the two
//            parties is credited once. Route runs and deliveries are the
//            *execution* of a trade and are not counted again.
//  billsPassed senate_proposals status 'passed' by proposer.
//  warsDeclared game_wars.declared_by with origin = 'declared' (not 'seeded' —
//            the starting state — nor 'pact_broken'). totals.wars counts every
//            war except 'seeded'.
//  series    faction_metrics (gold -> credits, science, ships) at <= 120 ticks:
//            every `stride`-th tick plus the first and the last recorded tick,
//            with holdings rebuilt as above at those same ticks. Missing rows
//            (not yet in, or already out of, the game) read 0.
//  battles   battles + battle_participants (the three with most hulls lost).
//            endedTick falls back to last_fire_tick for a battle whose quiet
//            window never closed before the game ended. settlementsLost:
//            battles.settlements_lost is 0 on every prod game checked, so it
//            is the larger of that and the settlements of that body destroyed
//            during the battle (game_settlements.destroyed_at_tick); the
//            game-wide total is the count of destroyed settlement rows.
//  place     winner first, then final holdings, ships, techs, credits (all
//            descending), then later elimination, then seat number: a total
//            order.
//  empires   Monster and observer seats (the Leviathan) are not empires and
//            appear nowhere. Their hulls still count in the battle totals.
// ============================================================================

const GAME_ID = '[A-Za-z0-9_-]{6,32}';
const MAX_POINTS = 120;

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ code, error: { code, message } }, { status });
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const whole = (v) => Math.round(num(v));
const rows = (res) => res?.results ?? [];

/** { key -> number } from rows of [keyCol, valCol]. */
function sumBy(list, keyCol, valCol) {
  const out = new Map();
  for (const r of list) {
    const k = r[keyCol];
    if (k == null) continue;
    out.set(k, (out.get(k) ?? 0) + num(r[valCol]));
  }
  return out;
}

/**
 * Holdings over time for one empire. `events` is [{tick, body, d}] with d = +1
 * when a settlement appears and -1 when it dies. Returns the state after each
 * distinct event tick: [{tick, n}] where n = distinct bodies still held.
 */
function holdingsStates(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const perBody = new Map();
  let n = 0;
  const states = [];
  for (let i = 0; i < sorted.length;) {
    const tick = sorted[i].tick;
    while (i < sorted.length && sorted[i].tick === tick) {
      const e = sorted[i++];
      const before = perBody.get(e.body) ?? 0;
      const after = before + e.d;
      perBody.set(e.body, after);
      if (before <= 0 && after > 0) n++;
      else if (before > 0 && after <= 0) n--;
    }
    states.push({ tick, n });
  }
  return states;
}

function holdingsAt(states, tick) {
  let lo = 0, hi = states.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid].tick <= tick) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? 0 : states[best].n;
}

/** Evenly thin an ascending list to <= max entries, keeping first and last. */
function thin(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

// ===========================================================================
// THE TIMELINE: the game's pivotal moments, picked by importance and thinned
// so they read as a story.
//
// Every candidate comes from a REAL row (chronicle_entries, game_wars is
// mirrored by the war_declared chronicle, senate_proposals, game_megastructures,
// battles + battle_participants, the holdings sweep). A candidate that cannot
// name its actors (an id that is not one of the game's empires: a monster seat,
// a vacated seat, a payload missing the field) is dropped, never invented.
//
// Importance is 0-100 and lives in ONE table, below. Selection:
//   1. the start and the victory are always in;
//   2. the rest go in by importance (ties: earlier tick first), skipping any
//      that would crowd one already chosen: on the same tick regardless; within
//      SPACING ticks (1.5% of the game) of a chosen moment of the SAME kind
//      that shares an empire (or is also an empire-less world event). Different
//      kinds may sit close: a war and the battle it started are two beats of
//      one story. And any beyond a per-kind cap, so no kind drowns the rest;
//   3. at most MAX_MOMENTS in all; past the 12th only importance >= 45 earns a
//      place, so a quiet game stays short rather than padded.
// ===========================================================================

const MAX_MOMENTS = 16;
const ELIM_WINDOW = 12;          // a fight this close before an elimination is "the last stand"
const SPACING_FRACTION = 0.015;  // minimum spacing between related moments, of the game length
const LEAD_HELD_FRACTION = 0.05; // a lead must last this long to be a moment

const IMPORTANCE = {
  start: 100,
  victory: 100,
  // A battle: floor + up to span, by hulls lost relative to the biggest fight.
  // The three biggest ride high (the biggest scores 95); a "last stand" before
  // an elimination rides lower.
  battle: { floor: 55, span: 40 },
  lastStand: { floor: 40, span: 15 },
  firstBlood: 55,
  war: 35,
  firstWar: 60,
  warBeforeBattle: 25,           // + when a top fight followed it between those two empires
  pactBrokenWar: 10,             // + a war that broke a pact is told as the betrayal
  pactBroken: 50,
  // An elimination: floor + up to span by how big the fallen empire got
  // (peak worlds / the largest peak); the first empire to fall earns a bonus.
  eliminated: { floor: 45, span: 35 },
  firstElimination: 10,
  lead: { floor: 40, span: 30 },  // + how long it held, as a % of the game, capped
  bill: { war_authorization: 55, trade_embargo: 50, production_sanction: 50, reparations: 45 },
  chancellor: 70,
  dysonBegun: 62,
  dysonMilestone: { 25: 50, 50: 56, 75: 66 },
  megastructure: { mega_destroyer: 50, weapons_station: 42, null_field: 42, gravity_sink: 42, warp_gate: 36, other: 36 },
  gateOpenedFirst: 60,
  gateOpened: 50,
  gateFirstCrossing: 55,
  leviathan: { arrives: 72, strikeFirst: 66, strike: 52, dies: 78 },
  // Only the single most valuable discovery of the game is a candidate.
  discovery: {
    ancient_capital: 75, portal_to_sun: 66, far_gate: 66, ancient_city: 55, derelict_warship: 50,
    pre_terraformed: 50, free_collector: 45, ancient_station: 45, ancient_relay: 42, ancient_databank: 40,
    resource_cache: 30, deep_cache: 40,   // deep_cache +1 per 700 metal+credits, up to +30
    other: 35,
  },
  pact: { defense_pact: 38, construction_pact: 32, nap: 22, intel_share: 22, other: 22 },
};

/** At most this many moments of a kind. */
const KIND_CAP = {
  battle: 5, war: 3, pact_broken: 3, pact: 2, eliminated: 4, lead: 4, bill: 3,
  chancellor: 1, megastructure: 2, gate: 2, leviathan: 3, discovery: 1, first_blood: 1,
};

const parseJson = (s) => { try { const v = JSON.parse(s ?? 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/**
 * Pure: turn the fetched rows into the timeline (without clips; battle moments
 * carry their battle row in `_battle` for attachClips to resolve and strip).
 */
export function buildTimeline(c) {
  const { currentTick, factions, known, holdStates, placeOf, battleRows, lossesBy, src } = c;
  const len = Math.max(1, currentTick);
  const spacing = Math.max(1, Math.round(len * SPACING_FRACTION));
  const emp = (id) => (id && known.has(id) ? id : null);
  const nameToId = new Map(factions.map(f => [f.name, f.id]));
  const peakOf = new Map(factions.map(f => [f.id, f.peak.holdings]));
  const maxPeak = Math.max(1, ...factions.map(f => f.peak.holdings));
  const cands = [];
  const add = (m) => {
    cands.push({
      bodyName: null, n: null, detail: null, clip: null, factionIds: [], ...m,
      importance: Math.max(0, Math.min(100, Math.round(m.importance))),
    });
  };

  // -- battles ---------------------------------------------------------------
  const topShips = Math.max(1, ...battleRows.filter(b => b.is_top).map(b => num(b.ships_lost)));
  const battleMoments = [];
  for (const b of battleRows) {
    const losers = (lossesBy.get(b.id) ?? [])
      .slice().sort((x, y) => (y.shipsLost - x.shipsLost) || ((placeOf.get(x.factionId) ?? 0) - (placeOf.get(y.factionId) ?? 0)))
      .map(l => l.factionId);
    const ids = [...new Set([emp(b.victor_faction_id), ...losers].filter(Boolean))].slice(0, 4);
    if (!ids.length) continue;
    const t = b.is_top ? IMPORTANCE.battle : IMPORTANCE.lastStand;
    const m = {
      kind: 'battle', tick: num(b.started_tick), factionIds: ids, bodyName: b.body_name ?? null,
      n: num(b.ships_lost), importance: t.floor + t.span * (num(b.ships_lost) / topShips),
      _battle: b,
    };
    battleMoments.push(m);
    add(m);
  }

  // -- wars and betrayed pacts ------------------------------------------------
  const warWindow = Math.max(5, Math.round(len * 0.03));
  let firstWar = true;
  const warKeys = new Set();
  for (const w of src.wars) {
    const a = emp(w.a), b = emp(w.b);
    if (!a || !b || a === b) continue;
    const t = num(w.t);
    let imp = firstWar ? IMPORTANCE.firstWar : IMPORTANCE.war;
    firstWar = false;
    // a war that was followed by one of the biggest fights between these two
    if (battleMoments.some(bm => bm._battle.is_top && bm.tick >= t && bm.tick <= t + warWindow
        && bm.factionIds.includes(a) && bm.factionIds.includes(b))) imp += IMPORTANCE.warBeforeBattle;
    warKeys.add(`${t}|${a}|${b}`);
    if (w.broke) {
      add({ kind: 'pact_broken', tick: t, factionIds: [a, b], detail: String(w.broke), importance: imp + IMPORTANCE.pactBrokenWar });
    } else {
      add({ kind: 'war', tick: t, factionIds: [a, b], importance: imp });
    }
  }
  for (const p of src.pactsBroken) {
    const a = emp(p.a), b = emp(p.b);
    if (!a || !b || a === b || warKeys.has(`${num(p.t)}|${a}|${b}`)) continue;
    add({
      kind: 'pact_broken', tick: num(p.t), factionIds: [a, b], detail: p.pact ?? null,
      importance: IMPORTANCE.pactBroken + (p.pact === 'defense_pact' ? 5 : 0),
    });
  }
  for (const p of src.pactsSigned) {
    const a = emp(p.a), b = emp(p.b);
    if (!a || !b || a === b) continue;
    add({
      kind: 'pact', tick: num(p.t), factionIds: [a, b], detail: p.pact ?? null,
      importance: IMPORTANCE.pact[p.pact] ?? IMPORTANCE.pact.other,
    });
  }

  // -- first blood: the earliest destroyed hull of an empire -------------------
  const fb = src.firstBlood.find(r => emp(r.victim));
  if (fb) {
    const killer = emp(fb.killer);
    add({
      kind: 'first_blood', tick: num(fb.t), factionIds: killer && killer !== fb.victim ? [killer, fb.victim] : [fb.victim],
      bodyName: fb.body ?? null, detail: fb.cls ?? null, importance: IMPORTANCE.firstBlood,
    });
  }

  // -- eliminations -----------------------------------------------------------
  const takers = new Map();
  for (const r of src.lastWorldTakers) {
    const prev = takers.get(r.fid);
    if (!prev || num(r.t) >= prev.t) takers.set(r.fid, { t: num(r.t), killer: r.killer });
  }
  const elims = src.eliminated.filter(e => emp(e.fid)).sort((x, y) => num(x.t) - num(y.t));
  elims.forEach((e, i) => {
    const killer = emp(takers.get(e.fid)?.killer);
    const peak = peakOf.get(e.fid) ?? 0;
    add({
      kind: 'eliminated', tick: num(e.t), factionIds: killer && killer !== e.fid ? [e.fid, killer] : [e.fid], n: peak,
      importance: IMPORTANCE.eliminated.floor + IMPORTANCE.eliminated.span * (peak / maxPeak) + (i === 0 ? IMPORTANCE.firstElimination : 0),
    });
  });

  // -- the lead changes hands, and stays changed --------------------------------
  const evTicks = [...new Set([...holdStates.values()].flatMap(st => st.map(s => s.tick)))].sort((x, y) => x - y);
  // Leadership = the one empire strictly ahead in worlds held; a tie keeps the
  // incumbent. The first leader replaced no one, so it is measured (it ends
  // when the second begins) but is not itself a change of hands.
  const allChanges = [];
  let cur = null;
  for (const t of evTicks) {
    const counts = factions.map(f => ({ id: f.id, n: holdingsAt(holdStates.get(f.id), t) }));
    const max = Math.max(0, ...counts.map(x => x.n));
    const top = counts.filter(x => x.n === max);
    if (max > 0 && top.length === 1 && top[0].id !== cur) { cur = top[0].id; allChanges.push({ t, id: cur, n: max }); }
  }
  allChanges.forEach((ch, i) => {
    if (i === 0) return;
    const end = i + 1 < allChanges.length ? allChanges[i + 1].t : len;
    const held = end - ch.t;
    if (held < len * LEAD_HELD_FRACTION) return;
    add({
      kind: 'lead', tick: ch.t, factionIds: [ch.id], n: ch.n,
      importance: IMPORTANCE.lead.floor + Math.min(IMPORTANCE.lead.span, (held / len) * 100),
    });
  });

  // -- the Senate -------------------------------------------------------------
  for (const b of src.bills) {
    if (b.kind === 'chancellor_vote') {
      const who = emp(b.candidate) ?? emp(b.proposer);
      // The election that WON the game is the victory itself, not a moment before it.
      const winning = c.victoryType === 'chancellor' && who === emp(c.winnerId) && c.victoryTick - num(b.t) <= spacing;
      if (who && !winning) add({ kind: 'chancellor', tick: num(b.t), factionIds: [who], importance: IMPORTANCE.chancellor });
      continue;
    }
    const proposer = emp(b.proposer);
    if (!proposer) continue;
    const target = emp(b.target);
    add({
      kind: 'bill', tick: num(b.t), factionIds: target && target !== proposer ? [proposer, target] : [proposer],
      detail: b.kind, importance: IMPORTANCE.bill[b.kind] ?? 40,
    });
  }

  // -- megastructures ----------------------------------------------------------
  for (const m of src.megastructures) {
    const who = emp(m.fid);
    if (!who) continue;
    add({
      kind: 'megastructure', tick: num(m.t), factionIds: [who], bodyName: m.body ?? null, detail: m.kind, n: 100,
      importance: IMPORTANCE.megastructure[m.kind] ?? IMPORTANCE.megastructure.other,
    });
  }

  // -- world events (chronicle) -------------------------------------------------
  let gatesOpened = 0, strikes = 0;
  let bestSecret = null;
  for (const e of src.world) {
    const p = parseJson(e.payload);
    const t = num(e.t);
    switch (e.kind) {
      case 'dyson_initiated': {
        const who = emp(e.a);
        if (who) add({ kind: 'megastructure', tick: t, factionIds: [who], detail: 'dyson_sphere', n: 0, importance: IMPORTANCE.dysonBegun });
        break;
      }
      case 'dyson_milestone': {
        const who = emp(e.a);
        const pct = num(p.pct);
        if (who && pct > 0 && pct < 100) {
          add({ kind: 'megastructure', tick: t, factionIds: [who], detail: 'dyson_sphere', n: pct, importance: IMPORTANCE.dysonMilestone[pct] ?? 45 });
        }
        break;
      }
      case 'sun_gate_opened':
        add({
          kind: 'gate', tick: t, detail: 'opened', bodyName: p.system ?? p.gate ?? null, n: Number.isFinite(Number(p.index)) ? Number(p.index) + 1 : null,
          importance: gatesOpened++ === 0 ? IMPORTANCE.gateOpenedFirst : IMPORTANCE.gateOpened,
        });
        break;
      case 'gate_transit': {
        const who = emp(e.a);
        if (who) add({ kind: 'gate', tick: t, factionIds: [who], detail: 'first_crossing', bodyName: p.to_system ?? p.to ?? null, importance: IMPORTANCE.gateFirstCrossing });
        break;
      }
      case 'kaiju_revealed':
        add({ kind: 'leviathan', tick: t, detail: 'arrives', bodyName: p.body_name ?? p.world ?? null, importance: IMPORTANCE.leviathan.arrives });
        break;
      case 'world_obliterated':
        add({
          kind: 'leviathan', tick: t, detail: 'strike', bodyName: p.body_name ?? p.world ?? null, n: Number.isFinite(Number(p.settlements_lost)) ? Number(p.settlements_lost) : null,
          importance: strikes++ === 0 ? IMPORTANCE.leviathan.strikeFirst : IMPORTANCE.leviathan.strike,
        });
        break;
      case 'kaiju_dead': {
        const killer = nameToId.get(p.killer_faction_name);
        add({
          kind: 'leviathan', tick: t, detail: 'dies', factionIds: killer ? [killer] : [], bodyName: p.body_name ?? p.world ?? null,
          importance: IMPORTANCE.leviathan.dies,
        });
        break;
      }
      case 'secret_discovered': {
        const who = emp(e.a);
        if (!who) break;
        const kind = String(p.kind ?? 'other');
        const cache = num(p.metal) + num(p.credits);
        const base = IMPORTANCE.discovery[kind] ?? IMPORTANCE.discovery.other;
        const imp = base + (kind === 'deep_cache' ? Math.min(30, cache / 700) : 0);
        if (!bestSecret || imp > bestSecret.importance) {
          bestSecret = {
            kind: 'discovery', tick: t, factionIds: [who], bodyName: p.body_name ?? null, detail: kind,
            n: cache > 0 ? cache : null, importance: imp,
          };
        }
        break;
      }
      default:
    }
  }
  if (bestSecret) add(bestSecret);

  // -- always: the start and the end ------------------------------------------------
  const start = {
    kind: 'start', tick: c.startTick, factionIds: [], n: factions.length, detail: null,
    bodyName: null, clip: null, importance: IMPORTANCE.start,
  };
  const winner = emp(c.winnerId);
  const victory = {
    kind: 'victory', tick: Math.max(c.victoryTick, c.startTick), factionIds: winner ? [winner] : [],
    n: null, detail: c.victoryType ?? null, bodyName: null, clip: null, importance: IMPORTANCE.victory,
  };

  // -- select, thin, order ---------------------------------------------------------------
  const share = (a, b) => a.factionIds.some(f => b.factionIds.includes(f));
  const conflicts = (a, b) => {
    const dt = Math.abs(a.tick - b.tick);
    if (dt === 0) return true;
    // Same kind: the full spacing, when it is about the same empire (or both
    // are empire-less world events). Different kinds only never share a tick.
    if (a.kind !== b.kind || dt >= spacing) return false;
    return share(a, b) || (!a.factionIds.length && !b.factionIds.length);
  };
  const chosen = [start, victory];
  const perKind = new Map();
  const ranked = cands.slice().sort((x, y) => (y.importance - x.importance) || (x.tick - y.tick));
  for (const m of ranked) {
    if (chosen.length >= MAX_MOMENTS) break;
    if (chosen.length >= 12 && m.importance < 45) continue;
    if (m.tick < start.tick || m.tick > victory.tick) continue;
    if ((perKind.get(m.kind) ?? 0) >= (KIND_CAP[m.kind] ?? 3)) continue;
    if (chosen.some(s => conflicts(m, s))) continue;
    chosen.push(m);
    perKind.set(m.kind, (perKind.get(m.kind) ?? 0) + 1);
  }
  chosen.sort((x, y) => (x.tick - y.tick) || (y.importance - x.importance));
  return chosen.map((m, i) => ({ id: `m${i + 1}`, ...m }));
}

function newShareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Attach replay links to the battle moments that can actually be replayed.
 *
 * Replayable = the battle has recorded frames (battle_ticks, what /api/recap
 * plays back) and shots. The link is the battle's HOUSE share token
 * (battle_shares.created_by IS NULL, the one the close code mints), so the
 * Herald, Discord and this page all point at one URL. The token is the
 * permission: it exposes that one battle and nothing else, and no battle id is
 * ever used as a link.
 *
 * If a replayable battle has no house token (battles closed before the close
 * code minted one) it is minted here, exactly as the close code does, but
 * atomically: the unique index is on (battle_id, created_by) and SQLite treats
 * NULLs as distinct, so INSERT OR IGNORE would NOT stop a second house token.
 * A single INSERT ... WHERE NOT EXISTS is one statement, and D1 serialises
 * writes, so two viewers opening the page together mint one token between
 * them. A battle whose house link was REVOKED (a row exists, none active) is
 * never re-minted: someone turned that link off.
 *
 * This is the endpoint's only write. It is inside try/catch: a failure drops
 * the clips, never the page. `opts.readOnly` (the prod-fixture script) never
 * writes: it uses existing tokens and drops the clip when there is none.
 */
async function attachClips(env, gameId, timeline, opts) {
  const need = [];
  const set = (m, b, token) => {
    m.clip = { path: `/recap/${token}`, battleId: b.id, shots: whole(b.shots), shipsLost: whole(b.ships_lost) };
  };
  for (const m of timeline) {
    const b = m._battle;
    delete m._battle;
    if (m.kind !== 'battle' || !b) continue;
    if (!(num(b.frames) > 0 && num(b.shots) > 0)) continue;       // nothing to play back
    if (b.token) set(m, b, b.token);
    else if (!opts.readOnly && num(b.house_rows) === 0) need.push([m, b]);
  }
  if (!need.length) return;
  try {
    const now = Date.now();
    const stmts = need.map(([, b]) => env.DB.prepare(
      `INSERT INTO battle_shares (token, battle_id, game_id, created_by, created_at_ms)
       SELECT ?, ?, ?, NULL, ?
        WHERE NOT EXISTS (SELECT 1 FROM battle_shares WHERE battle_id = ? AND created_by IS NULL)`,
    ).bind(newShareToken(), b.id, gameId, now, b.id));
    stmts.push(env.DB.prepare(
      `SELECT battle_id, token FROM battle_shares
        WHERE created_by IS NULL AND revoked_at_ms IS NULL AND battle_id IN (${need.map(() => '?').join(',')})`,
    ).bind(...need.map(([, b]) => b.id)));
    const res = await env.DB.batch(stmts);
    const got = new Map(rows(res[res.length - 1]).map(r => [r.battle_id, r.token]));
    for (const [m, b] of need) if (got.has(b.id)) set(m, b, got.get(b.id));
  } catch (e) {
    console.error('ending: clip token mint failed', e);
  }
}

// ---------------------------------------------------------------------------
// Shared by the ending page and the profile's trophy case (computeGameAwards).
// ---------------------------------------------------------------------------

const battleParticipantsOfGame = 'p JOIN battles b ON b.id = p.battle_id WHERE b.game_id = ?';
// Each empire's single best hull by `v` ("champions"), best first. One row
// per empire is what the award needs: the winner is the first row and the
// runner-up the second, however many of the top hulls belong to one fleet.
// `inner` selects ship_id, ship_name, ship_class, faction_id, v from game_ship_stats s.
// The captain (latest one on record) is looked up for the survivors only.
const champions = (inner) => `
    SELECT t.ship_id, t.ship_name, t.ship_class, t.faction_id, t.v,
           (SELECT q2.captain_name FROM battle_participants q2
             WHERE q2.ship_id = t.ship_id AND q2.captain_name IS NOT NULL
             ORDER BY q2.last_tick DESC LIMIT 1) AS captain_name
      FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.faction_id ORDER BY x.v DESC, x.ship_id) AS rn
              FROM (${inner}) x WHERE x.v > 0) t
     WHERE t.rn = 1
     ORDER BY t.v DESC, t.ship_id`;
const realKills = `(SELECT COUNT(*) FROM battle_participants k JOIN battles bk ON bk.id = k.battle_id
                       WHERE bk.game_id = s.game_id AND k.killer_ship_id = s.ship_id
                         AND k.died_tick IS NOT NULL)`;

/**
 * The statements that decide the empires and their awards, keyed by their slot
 * in buildEnding's batch (the page's own extras fill the other slots). This is
 * the ONE place those numbers are queried: the ending page and the profile's
 * awards both run these and hand the rows to deriveEmpires. (binds: game id)
 */
function statQueries(q, g) {
  return {
    0: q(`SELECT id, name, color, color2, emblem, status, eliminated_at_tick, slot,
                      user_id, metal, gold, science
                 FROM game_factions
                WHERE game_id = ? AND status NOT IN ('monster', 'observer')
                ORDER BY slot`, g),
    1: q(`SELECT owner_faction_id AS fid, body_id, created_at_tick AS t0, destroyed_at_tick AS t1
                 FROM game_settlements WHERE game_id = ?`, g),
    2: q(`SELECT owner_faction_id AS fid, COUNT(*) AS n
                 FROM game_ships WHERE game_id = ? AND hp > 0 GROUP BY owner_faction_id`, g),
    3: q(`SELECT faction_id AS fid, SUM(level) AS lv, MAX(completed_at_tick) AS done
                 FROM faction_techs WHERE game_id = ? GROUP BY faction_id`, g),
    4: q(`SELECT faction_id AS fid, MAX(ships) AS ships, MAX(gold) AS gold
                 FROM faction_metrics WHERE game_id = ? GROUP BY faction_id`, g),
    6: q(`SELECT actor_faction_id AS fid, COUNT(*) AS n FROM chronicle_entries
                WHERE game_id = ? AND kind = 'ship_built' AND actor_faction_id IS NOT NULL
                GROUP BY actor_faction_id`, g),
    7: q(`SELECT proposer_faction_id AS fid, COUNT(*) AS n FROM senate_proposals
                WHERE game_id = ? AND status = 'passed' AND proposer_faction_id IS NOT NULL
                GROUP BY proposer_faction_id`, g),
    8: q(`SELECT declared_by AS fid, origin, COUNT(*) AS n FROM game_wars
                WHERE game_id = ? GROUP BY declared_by, origin`, g),
    9: q(`SELECT fid, COUNT(*) AS n FROM (
                  SELECT proposer_faction_id AS fid FROM trade_offers
                   WHERE game_id = ? AND status = 'accepted'
                     AND (offer_metal + offer_fuel + offer_gold + offer_science
                          + request_metal + request_fuel + request_gold + request_science > 0
                          OR offered_ship_id IS NOT NULL)
                  UNION ALL
                  SELECT responder_faction_id FROM trade_offers
                   WHERE game_id = ? AND status = 'accepted'
                     AND (offer_metal + offer_fuel + offer_gold + offer_science
                          + request_metal + request_fuel + request_gold + request_science > 0
                          OR offered_ship_id IS NOT NULL)
                  UNION ALL
                  SELECT poster_faction_id FROM market_fills f
                   WHERE game_id = ? AND NOT EXISTS (SELECT 1 FROM trade_offers o
                          WHERE o.id = f.trade_offer_id AND o.status = 'accepted')
                  UNION ALL
                  SELECT taker_faction_id FROM market_fills f
                   WHERE game_id = ? AND NOT EXISTS (SELECT 1 FROM trade_offers o
                          WHERE o.id = f.trade_offer_id AND o.status = 'accepted')
                ) GROUP BY fid`, g, g, g, g),
    10: q(`SELECT p.killer_faction_id AS fid, COUNT(*) AS n FROM battle_participants ${battleParticipantsOfGame}
                  AND p.died_tick IS NOT NULL AND p.killer_faction_id IS NOT NULL
                  AND (p.faction_id IS NULL OR p.faction_id <> p.killer_faction_id)
                GROUP BY p.killer_faction_id`, g),
    11: q(`SELECT p.faction_id AS fid, COUNT(*) AS n FROM battle_participants ${battleParticipantsOfGame}
                  AND p.died_tick IS NOT NULL AND p.faction_id IS NOT NULL
                GROUP BY p.faction_id`, g),
    12: q(`SELECT faction_id AS fid, SUM(damage_dealt) AS n FROM game_ship_stats
                WHERE game_id = ? AND faction_id IS NOT NULL GROUP BY faction_id`, g),
    16: /* ace */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, h.v
                  FROM (SELECT k.killer_ship_id AS ship_id, COUNT(*) AS v
                          FROM battle_participants k JOIN battles bk ON bk.id = k.battle_id
                         WHERE bk.game_id = ? AND k.died_tick IS NOT NULL AND k.killer_ship_id IS NOT NULL
                           AND (k.faction_id IS NULL OR k.killer_faction_id IS NULL OR k.faction_id <> k.killer_faction_id)
                         GROUP BY k.killer_ship_id) h
                  JOIN game_ship_stats s ON s.game_id = ? AND s.ship_id = h.ship_id`), g, g),
    17: /* heavy_hitter */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, s.damage_dealt AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.damage_dealt > 0`), g),
    18: /* iron_wall */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, s.damage_absorbed AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.damage_absorbed > 0`), g),
    19: /* last_stand */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, MIN(s.low_hp_kills, ${realKills}) AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.low_hp_kills > 0`), g),
    21: q(`SELECT actor_faction_id AS fid, MAX(tick_number) AS t FROM chronicle_entries
                WHERE game_id = ? AND kind = 'faction_eliminated' AND actor_faction_id IS NOT NULL
                GROUP BY actor_faction_id`, g),
  };
}
const STAT_SLOTS = Object.keys(statQueries((sql) => sql, '')).map(Number);

/**
 * Pure: the empires (standings, totals) and the awards from the rows of the
 * stat queries. `R(i)` returns the rows of slot i. Monster and observer seats
 * are already excluded by slot 0.
 */
function deriveEmpires(game, R) {
  // ---- the empires ---------------------------------------------------------
  const fRows = R(0);
  const known = new Set(fRows.map(f => f.id));

  // holdings: settlement lifetimes -> per-empire sweeps
  const eventsBy = new Map();
  for (const s of R(1)) {
    if (!known.has(s.fid)) continue;
    const ev = eventsBy.get(s.fid) ?? [];
    ev.push({ tick: num(s.t0), body: s.body_id, d: 1 });
    if (s.t1 != null) ev.push({ tick: num(s.t1), body: s.body_id, d: -1 });
    eventsBy.set(s.fid, ev);
  }
  const holdStates = new Map(fRows.map(f => [f.id, holdingsStates(eventsBy.get(f.id) ?? [])]));
  const finalHoldings = (fid) => { const s = holdStates.get(fid); return s.length ? s[s.length - 1].n : 0; };
  const peakHoldings = (fid) => holdStates.get(fid).reduce((m, s) => Math.max(m, s.n), 0);

  const shipsAlive = sumBy(R(2), 'fid', 'n');
  const techLv = sumBy(R(3), 'fid', 'lv');
  const techDone = new Map(R(3).map(r => [r.fid, r.done == null ? Infinity : num(r.done)]));
  const peakShips = sumBy(R(4), 'fid', 'ships');
  const peakGold = sumBy(R(4), 'fid', 'gold');
  const built = sumBy(R(6), 'fid', 'n');
  const bills = sumBy(R(7), 'fid', 'n');
  const declared = new Map();
  let warsTotal = 0;
  for (const w of R(8)) {
    if (w.origin === 'declared') declared.set(w.fid, (declared.get(w.fid) ?? 0) + num(w.n));
    if (w.origin !== 'seeded') warsTotal += num(w.n);
  }
  const tradeParties = sumBy(R(9), 'fid', 'n');
  const tradesTotal = Math.round([...tradeParties.values()].reduce((a, b) => a + b, 0) / 2);
  const kills = sumBy(R(10), 'fid', 'n');
  const lost = sumBy(R(11), 'fid', 'n');
  const dealt = sumBy(R(12), 'fid', 'n');
  const elimTick = new Map(R(21).map(r => [r.fid, num(r.t)]));

  const factions = fRows.map(f => {
    const finalStatus = f.status === 'active' ? 'active' : 'eliminated';
    const final = {
      holdings: finalHoldings(f.id),
      ships: whole(shipsAlive.get(f.id) ?? 0),
      techs: whole(techLv.get(f.id) ?? 0),
      credits: whole(f.gold),
      science: whole(f.science),
      metal: whole(f.metal),
    };
    const out = {
      id: f.id,
      name: f.name,
      color: f.color,
      color2: f.color2 ?? null,
      emblem: f.emblem ?? null,
      finalStatus,
      eliminatedAtTick: finalStatus === 'eliminated'
        ? (f.eliminated_at_tick != null ? num(f.eliminated_at_tick) : (elimTick.get(f.id) ?? null))
        : null,
      place: 0,
      isWinner: game.winner_faction_id === f.id,
      isMe: false,                       // buildEnding marks the viewer's empire
      final,
      peak: {
        holdings: Math.max(peakHoldings(f.id), final.holdings),
        ships: Math.max(whole(peakShips.get(f.id) ?? 0), final.ships),
        credits: Math.max(whole(peakGold.get(f.id) ?? 0), final.credits),
      },
      totals: {
        kills: whole(kills.get(f.id) ?? 0),
        shipsLost: whole(lost.get(f.id) ?? 0),
        damageDealt: whole(dealt.get(f.id) ?? 0),
        shipsBuilt: whole(built.get(f.id) ?? 0),
        trades: whole(tradeParties.get(f.id) ?? 0),
        billsPassed: whole(bills.get(f.id) ?? 0),
        warsDeclared: whole(declared.get(f.id) ?? 0),
      },
    };
    out._slot = num(f.slot);
    return out;
  });

  factions.sort((a, b) =>
    (Number(b.isWinner) - Number(a.isWinner))
    || (b.final.holdings - a.final.holdings)
    || (b.final.ships - a.final.ships)
    || (b.final.techs - a.final.techs)
    || (b.final.credits - a.final.credits)
    || ((b.eliminatedAtTick ?? Infinity) - (a.eliminatedAtTick ?? Infinity))
    || (a._slot - b._slot));
  factions.forEach((f, i) => { f.place = i + 1; delete f._slot; });
  const placeOf = new Map(factions.map(f => [f.id, f.place]));

  // ---- awards ---------------------------------------------------------------
  const awards = [];
  const tieBreak = {
    scholar: (a, b) => (techDone.get(a.id) ?? Infinity) - (techDone.get(b.id) ?? Infinity),
  };
  /** Empire award: highest value; ties by `tieBreak` then by place. */
  const factionAward = (id, valueOf) => {
    const ranked = factions
      .map(f => ({ f, v: valueOf(f) }))
      .filter(x => x.v > 0)
      .sort((a, b) => (b.v - a.v) || (tieBreak[id]?.(a.f, b.f) ?? 0) || (a.f.place - b.f.place));
    if (!ranked.length) return;
    const award = { id, factionId: ranked[0].f.id, value: ranked[0].v };
    if (ranked[1]) award.runnerUp = { factionId: ranked[1].f.id, value: ranked[1].v };
    awards.push(award);
  };
  /** Hull award: the best hull of a real empire; runner-up is the best hull
   *  of a DIFFERENT empire (a runner-up from the same fleet says little). */
  const hullAward = (id, list) => {
    const ranked = list
      .map(h => ({ h, v: whole(h.v) }))
      .filter(x => x.v > 0 && known.has(x.h.faction_id));
    if (!ranked.length) return;
    const top = ranked[0];
    const award = {
      id, factionId: top.h.faction_id, value: top.v,
      ship: { name: top.h.ship_name ?? '', shipClass: top.h.ship_class ?? null, captainName: top.h.captain_name ?? null },
    };
    const next = ranked.find(x => x.h.faction_id !== top.h.faction_id);
    if (next) award.runnerUp = { factionId: next.h.faction_id, value: next.v };
    awards.push(award);
  };
  factionAward('warmonger', f => f.totals.kills);
  hullAward('ace', R(16));
  hullAward('heavy_hitter', R(17));
  hullAward('iron_wall', R(18));
  hullAward('last_stand', R(19));
  factionAward('instigator', f => f.totals.warsDeclared);
  factionAward('landlord', f => f.peak.holdings);
  factionAward('treasurer', f => f.peak.credits);
  factionAward('scholar', f => f.final.techs);
  factionAward('shipwright', f => f.totals.shipsBuilt);
  factionAward('merchant', f => f.totals.trades);
  factionAward('statesman', f => f.totals.billsPassed);


  return { fRows, known, holdStates, placeOf, factions, awards, techLv, built, bills, warsTotal, tradesTotal };
}

/**
 * Every award of a FINISHED game, who earned it, and the empires behind them,
 * from a smaller batch than the ending page's (just the stat queries). One
 * function for both the ending page's awards and the profile's trophy case.
 *
 * Returns null when the game is unknown or not completed. Otherwise
 *   { game: { id, name, completedAtMs, winnerFactionId },
 *     awards: [{ id, factionId, value, tied, ship }],     (contract order)
 *     empires: Map factionId -> { userId, name, isWinner } }
 * `tied` is true when the runner-up finished on the very same number. Monster
 * and observer seats are not empires and appear nowhere; `userId` is null for
 * an AI or vacated seat.
 */
export async function computeGameAwards(env, gameId) {
  const game = await env.DB.prepare(
    `SELECT g.id, g.status, g.winner_faction_id, g.completed_at, r.name
       FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`,
  ).bind(gameId).first();
  if (!game || game.status !== 'completed') return null;
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const S = statQueries(q, gameId);
  const results = await env.DB.batch(STAT_SLOTS.map(i => S[i]));
  const R = (i) => rows(results[STAT_SLOTS.indexOf(i)]);
  return awardsOf(game, deriveEmpires(game, R));
}

/** The computeGameAwards shape from an already-derived game. */
function awardsOf(game, d) {
  const empires = new Map(d.factions.map(f => [f.id, { userId: null, name: f.name, isWinner: f.isWinner }]));
  for (const r of d.fRows) empires.get(r.id).userId = r.user_id ?? null;
  return {
    game: {
      id: game.id,
      name: game.name,
      completedAtMs: game.completed_at != null ? num(game.completed_at) : null,
      winnerFactionId: game.winner_faction_id ?? null,
    },
    awards: d.awards.map(a => ({
      id: a.id,
      factionId: a.factionId,
      value: a.value,
      tied: a.runnerUp != null && a.runnerUp.value === a.value,
      ship: a.ship ?? null,
    })),
    empires,
  };
}

/**
 * Store a finished game's awards for the profile, ONCE. Idempotent:
 *   * game_awards_state says the game was already worked out -> nothing happens;
 *   * otherwise one batch inserts a row per award for each HUMAN empire that
 *     earned it (AI and vacated seats, monsters and observers never get rows)
 *     and the state marker. INSERT OR IGNORE throughout, so two requests racing
 *     each other cannot double up.
 * A game that is not completed is never stored. `computed` lets a caller that
 * already holds the game's awards (the ending page) skip a second computation.
 * Returns { computed: boolean, stored: number }.
 */
export async function recordGameAwards(env, gameId, computed) {
  const done = await env.DB.prepare('SELECT 1 AS x FROM game_awards_state WHERE game_id = ?').bind(gameId).first();
  if (done) return { computed: false, stored: 0 };
  const c = computed ?? await computeGameAwards(env, gameId);
  if (!c) return { computed: false, stored: 0 };
  const now = Date.now();
  const stmts = [];
  for (const a of c.awards) {
    const e = c.empires.get(a.factionId);
    if (!e || !e.userId) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO game_awards
         (game_id, award_id, faction_id, user_id, empire_name, value, tied, ship_name, ship_class, captain_name, won_game, completed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      c.game.id, a.id, a.factionId, e.userId, e.name, a.value, a.tied ? 1 : 0,
      a.ship?.name ?? null, a.ship?.shipClass ?? null, a.ship?.captainName ?? null,
      e.isWinner ? 1 : 0, c.game.completedAtMs,
    ));
  }
  stmts.push(env.DB.prepare('INSERT OR IGNORE INTO game_awards_state (game_id, computed_at_ms) VALUES (?, ?)').bind(c.game.id, now));
  await env.DB.batch(stmts);
  return { computed: true, stored: stmts.length - 1 };
}

/**
 * Build the ending payload.
 *
 * `opts` exists for tooling only (scripts/ending-from-prod.mjs): `asFactionId`
 * picks the viewer's empire directly, `skipMembership` waives the membership
 * check and `readOnly` forbids the one write the endpoint ever makes (minting
 * a missing replay token; see attachClips). The HTTP handler sets none.
 *
 * Returns an EndingPayload, or `{ error: { status, code, message } }`.
 */
export async function buildEnding(env, gameId, viewerUserId, opts = {}) {
  const [game, member] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id, g.status, g.victory_type, g.winner_faction_id, g.current_tick,
              g.tick_interval_ms, g.started_at, g.completed_at, r.name
         FROM games g JOIN rooms r ON r.id = g.id
        WHERE g.id = ?`,
    ).bind(gameId).first(),
    opts.skipMembership
      ? Promise.resolve({ fid: null, rm: 1 })
      : env.DB.prepare(
        `SELECT (SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?) AS fid,
                (SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?) AS rm`,
      ).bind(gameId, viewerUserId ?? '', gameId, viewerUserId ?? '').first(),
  ]);
  if (!game) return { error: { status: 404, code: 'not_found', message: 'game not found' } };
  if (!opts.skipMembership && !member?.fid && !member?.rm) {
    return { error: { status: 403, code: 'not_a_member', message: 'you are not in this game' } };
  }
  if (game.status !== 'completed') {
    return { error: { status: 409, code: 'not_finished', message: 'this game is still being played' } };
  }

  const currentTick = Math.max(0, whole(game.current_tick));
  const stride = Math.max(1, Math.ceil(currentTick / (MAX_POINTS - 2)));
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const g = gameId;

  // The same ordering twice (top battles; their per-empire losses) must agree.
  const TOP_BATTLES = `SELECT id FROM battles WHERE game_id = ? AND ships_lost > 0
                        ORDER BY ships_lost DESC, shots DESC, started_tick ASC LIMIT 3`;
  // Up to four sizeable fights that ended within a quiet window before an
  // empire was knocked out and in which that empire actually lost hulls: the
  // last stands. (binds: game, game)
  const ELIM_BATTLES = `SELECT b.id FROM battles b
                          JOIN (SELECT actor_faction_id AS fid, MAX(tick_number) AS t FROM chronicle_entries
                                 WHERE game_id = ? AND kind = 'faction_eliminated' AND actor_faction_id IS NOT NULL
                                 GROUP BY actor_faction_id) e
                            ON b.started_tick <= e.t AND b.last_fire_tick >= e.t - ${ELIM_WINDOW}
                         WHERE b.game_id = ? AND b.ships_lost >= 2
                           AND EXISTS (SELECT 1 FROM battle_participants p
                                        WHERE p.battle_id = b.id AND p.faction_id = e.fid AND p.died_tick IS NOT NULL)
                         GROUP BY b.id ORDER BY b.ships_lost DESC, b.shots DESC LIMIT 4`;
  // (binds: game x3)
  const BATTLE_SET = `SELECT id FROM (${TOP_BATTLES}) UNION SELECT id FROM (${ELIM_BATTLES})`;
  const Q = {
    ...statQueries(q, g),
    5: q(`SELECT tick_number AS t, faction_id AS fid, gold, science, ships
                 FROM faction_metrics
                WHERE game_id = ?
                  AND (tick_number % ? = 0
                       OR tick_number = (SELECT MIN(tick_number) FROM faction_metrics WHERE game_id = ?)
                       OR tick_number = (SELECT MAX(tick_number) FROM faction_metrics WHERE game_id = ?))
                ORDER BY tick_number`, g, stride, g, g),
    13: q(`SELECT COUNT(*) AS battles, COALESCE(SUM(shots), 0) AS shots,
                      COALESCE(SUM(ships_lost), 0) AS ships_lost,
                      COALESCE(SUM(settlements_lost), 0) AS settlements_lost,
                      (SELECT COUNT(*) FROM game_settlements
                        WHERE game_id = ? AND destroyed_at_tick IS NOT NULL) AS setl_destroyed
                 FROM battles WHERE game_id = ?`, g, g),
    // The battles the page cares about: the three biggest (is_top) plus the
    // fights that preceded an elimination. With how much of each can be
    // replayed (battle_ticks frames) and its house share token, if any.
    14: q(`SELECT id, body_name, started_tick, ended_tick, last_fire_tick, shots, ships_lost, settlements_lost,
                      victor_faction_id, status,
                      id IN (${TOP_BATTLES}) AS is_top,
                      (SELECT COUNT(*) FROM game_settlements st
                        WHERE st.game_id = battles.game_id AND st.body_id = battles.body_id
                          AND st.destroyed_at_tick BETWEEN battles.started_tick
                              AND COALESCE(battles.ended_tick, battles.last_fire_tick)) AS setl_here,
                      (SELECT COUNT(*) FROM battle_ticks bt WHERE bt.battle_id = battles.id) AS frames,
                      (SELECT s.token FROM battle_shares s
                        WHERE s.battle_id = battles.id AND s.created_by IS NULL AND s.revoked_at_ms IS NULL
                        ORDER BY s.created_at_ms LIMIT 1) AS token,
                      (SELECT COUNT(*) FROM battle_shares s2
                        WHERE s2.battle_id = battles.id AND s2.created_by IS NULL) AS house_rows
                 FROM battles WHERE id IN (${BATTLE_SET})
                ORDER BY ships_lost DESC, shots DESC, started_tick ASC`, g, g, g, g),
    15: q(`SELECT p.battle_id, p.faction_id AS fid, COUNT(*) AS n FROM battle_participants p
                WHERE p.died_tick IS NOT NULL AND p.faction_id IS NOT NULL
                  AND p.battle_id IN (${BATTLE_SET})
                GROUP BY p.battle_id, p.faction_id`, g, g, g),
    20: q(`SELECT payload, tick_number AS t FROM chronicle_entries WHERE game_id = ? AND kind = 'victory'
                ORDER BY tick_number DESC LIMIT 1`, g),
    // ---- timeline sources (see buildTimeline) ----
    22: /* first blood */ q(`SELECT tick_number AS t, actor_faction_id AS victim,
                      json_extract(payload, '$.killer_faction_id') AS killer,
                      json_extract(payload, '$.body_name') AS body,
                      json_extract(payload, '$.ship_class') AS cls
                 FROM chronicle_entries WHERE game_id = ? AND kind = 'ship_destroyed' AND json_valid(payload)
                ORDER BY tick_number, created_at_ms, id LIMIT 12`, g),
    23: /* wars */ q(`SELECT tick_number AS t, actor_faction_id AS a, target_faction_id AS b,
                      json_extract(payload, '$.broke_pacts[0]') AS broke
                 FROM chronicle_entries WHERE game_id = ? AND kind = 'war_declared' AND json_valid(payload)
                ORDER BY tick_number LIMIT 200`, g),
    24: /* pacts broken */ q(`SELECT tick_number AS t, actor_faction_id AS a, target_faction_id AS b,
                      json_extract(payload, '$.kind') AS pact
                 FROM chronicle_entries WHERE game_id = ? AND kind = 'treaty_broken' AND json_valid(payload)
                ORDER BY tick_number LIMIT 200`, g),
    25: /* pacts signed */ q(`SELECT tick_number AS t, actor_faction_id AS a, target_faction_id AS b,
                      json_extract(payload, '$.kind') AS pact
                 FROM chronicle_entries WHERE game_id = ? AND kind = 'treaty_signed' AND json_valid(payload)
                ORDER BY tick_number LIMIT 200`, g),
    26: /* who took the last worlds */ q(`SELECT fid, killer, t FROM (
                  SELECT actor_faction_id AS fid, json_extract(payload, '$.killer_faction_id') AS killer, tick_number AS t
                    FROM chronicle_entries WHERE game_id = ? AND kind = 'settlement_destroyed' AND json_valid(payload)
                   UNION ALL
                  SELECT target_faction_id, actor_faction_id, tick_number
                    FROM chronicle_entries WHERE game_id = ? AND kind = 'settlement_seized')
                WHERE fid IN (SELECT actor_faction_id FROM chronicle_entries
                               WHERE game_id = ? AND kind = 'faction_eliminated')
                  AND killer IS NOT NULL`, g, g, g),
    27: /* bills */ q(`SELECT kind, resolved_at_tick AS t, proposer_faction_id AS proposer,
                      json_extract(payload, '$.target_faction_id') AS target,
                      json_extract(payload, '$.candidate_faction_id') AS candidate
                 FROM senate_proposals
                WHERE game_id = ? AND json_valid(payload) AND status = 'passed' AND resolved_at_tick IS NOT NULL
                  AND kind IN ('war_authorization', 'trade_embargo', 'production_sanction', 'reparations', 'chancellor_vote')
                ORDER BY resolved_at_tick LIMIT 200`, g),
    28: /* megastructures */ q(`SELECT m.kind, m.completed_at_tick AS t, m.founded_by_faction_id AS fid, b.name AS body
                 FROM game_megastructures m LEFT JOIN game_bodies b ON b.id = m.body_id
                WHERE m.game_id = ? AND m.ancient = 0 AND m.founded_by_faction_id IS NOT NULL
                  AND m.completed_at_tick IS NOT NULL
                ORDER BY m.completed_at_tick LIMIT 100`, g),
    29: /* world events */ q(`SELECT kind, tick_number AS t, actor_faction_id AS a, payload FROM chronicle_entries
                WHERE game_id = ? AND json_valid(payload)
                  AND kind IN ('dyson_initiated', 'dyson_milestone', 'sun_gate_opened', 'gate_transit',
                               'kaiju_revealed', 'world_obliterated', 'kaiju_dead', 'secret_discovered')
                  AND (kind <> 'gate_transit' OR (json_extract(payload, '$.sun_gate') = 1 AND json_extract(payload, '$.first') = 1))
                  AND (kind <> 'world_obliterated' OR json_extract(payload, '$.cause') = 'kaiju')
                ORDER BY tick_number LIMIT 400`, g),
    30: /* start */ q(`SELECT MIN(tick_number) AS t FROM chronicle_entries WHERE game_id = ? AND kind = 'game_started'`, g),
  };
  const results = await env.DB.batch(Array.from({ length: 31 }, (_, i) => Q[i]));
  const R = (i) => rows(results[i]);

  const D = deriveEmpires(game, R);
  const { fRows, known, holdStates, placeOf, factions, awards, techLv, built, bills, warsTotal, tradesTotal } = D;
  const viewerFactionId = opts.asFactionId !== undefined
    ? opts.asFactionId
    : (viewerUserId ? (fRows.find(f => f.user_id === viewerUserId)?.id ?? member?.fid ?? null) : null);
  for (const f of factions) f.isMe = viewerFactionId != null && viewerFactionId === f.id;

  // ---- series ---------------------------------------------------------------
  const metricRows = R(5);
  let ticks = [...new Set(metricRows.map(r => num(r.t)))].sort((a, b) => a - b);
  ticks = thin(ticks, MAX_POINTS);
  const at = new Map();
  for (const r of metricRows) at.set(`${num(r.t)}|${r.fid}`, r);
  const series = { ticks, holdings: {}, ships: {}, credits: {}, science: {} };
  for (const f of factions) {
    const states = holdStates.get(f.id);
    series.holdings[f.id] = ticks.map(t => holdingsAt(states, t));
    series.ships[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.ships));
    series.credits[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.gold));
    series.science[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.science));
  }

  // ---- battles ----------------------------------------------------------------
  const lossesBy = new Map();
  for (const r of R(15)) {
    if (!known.has(r.fid)) continue;
    const l = lossesBy.get(r.battle_id) ?? [];
    l.push({ factionId: r.fid, shipsLost: whole(r.n) });
    lossesBy.set(r.battle_id, l);
  }
  const battleRows = R(14);
  const battles = battleRows.filter(b => b.is_top).map(b => ({
    id: b.id,
    bodyName: b.body_name ?? null,
    startedTick: whole(b.started_tick),
    endedTick: b.ended_tick != null ? whole(b.ended_tick) : (b.last_fire_tick != null ? whole(b.last_fire_tick) : null),
    shots: whole(b.shots),
    shipsLost: whole(b.ships_lost),
    settlementsLost: Math.max(whole(b.settlements_lost), whole(b.setl_here)),
    lossesByFaction: (lossesBy.get(b.id) ?? [])
      .sort((a, c) => (c.shipsLost - a.shipsLost) || ((placeOf.get(a.factionId) ?? 0) - (placeOf.get(c.factionId) ?? 0))),
  }));

  // ---- the timeline -------------------------------------------------------------
  const timeline = buildTimeline({
    currentTick, factions, known, holdStates, placeOf, battleRows, lossesBy,
    winnerId: game.winner_faction_id ?? null, victoryType: game.victory_type ?? null,
    startTick: R(30)[0]?.t != null ? num(R(30)[0].t) : 0,
    victoryTick: R(20)[0]?.t != null ? num(R(20)[0].t) : currentTick,
    src: {
      firstBlood: R(22), wars: R(23), pactsBroken: R(24), pactsSigned: R(25),
      lastWorldTakers: R(26), bills: R(27), megastructures: R(28), world: R(29),
      eliminated: R(21),
    },
  });
  await attachClips(env, gameId, timeline, opts);

  // The profile's trophy case keeps these awards: store them now that someone
  // has opened the finished game (once; see recordGameAwards). Never breaks the page.
  if (!opts.readOnly) {
    try { await recordGameAwards(env, gameId, awardsOf(game, D)); }
    catch (e) { console.error('ending: storing the game awards failed', e); }
  }

  // ---- the game ---------------------------------------------------------------
  let victoryDetail = null;
  try {
    const d = JSON.parse(R(20)[0]?.payload ?? 'null')?.detail;
    if (typeof d === 'string' && d.trim()) victoryDetail = d.trim();
  } catch { /* an unparsable payload just means no detail line */ }
  const startedAtMs = game.started_at != null ? num(game.started_at) : null;
  const completedAtMs = game.completed_at != null ? num(game.completed_at) : null;
  const bt = R(13)[0] ?? {};

  return {
    game: {
      id: game.id,
      name: game.name,
      victoryType: game.victory_type ?? null,
      winnerFactionId: game.winner_faction_id ?? null,
      victoryDetail,
      currentTick,
      tickIntervalMs: whole(game.tick_interval_ms),
      startedAtMs,
      completedAtMs,
      durationMs: startedAtMs != null && completedAtMs != null ? Math.max(0, completedAtMs - startedAtMs) : null,
      players: fRows.filter(f => f.user_id != null).length,
      empires: fRows.length,
    },
    factions,
    awards,
    series,
    totals: {
      battles: whole(bt.battles),
      shots: whole(bt.shots),
      shipsLost: whole(bt.ships_lost),
      settlementsLost: Math.max(whole(bt.settlements_lost), whole(bt.setl_destroyed)),
      trades: tradesTotal,
      billsPassed: whole([...bills.values()].reduce((a, b) => a + b, 0)),
      techsResearched: whole([...techLv.values()].reduce((a, b) => a + b, 0)),
      shipsBuilt: whole([...built.values()].reduce((a, b) => a + b, 0)),
      wars: warsTotal,
    },
    battles,
    timeline,
  };
}

async function handleEnding(_req, env, { params, session }) {
  const result = await buildEnding(env, params.gameId, session.user_id);
  if (result.error) return err(result.error.status, result.error.code, result.error.message);
  return json(result, { headers: { 'cache-control': 'private, max-age=60' } });
}

export const routes = [
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/ending$`),
    auth: 'required',
    handle: handleEnding,
  },
];
