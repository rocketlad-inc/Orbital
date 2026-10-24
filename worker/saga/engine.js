// ============================================================================
// saga/engine.js — the Saga Engine: a finished match's public record in, the
// script of its film out. No database, no clock, no randomness that is not
// seeded by the game, no model: buildScript(dossier) is a pure function, and
// the same dossier always gives the same script.
//
//   dossier ─► facts (the story graph + the measurements)
//           ─► shape and overlays (what kind of match was this?)
//           ─► cast (one role per empire, each with the number that earned it)
//           ─► plots (a main story that reaches the ending, side stories)
//           ─► beats (the story scenes, with headline and "because" line)
//           ─► crawl (title, board, players, omen)
//           ─► script
//
// The film (src/render/matchMap.ts) plays the script: it uses the runtime,
// the crawl, the cast cards, the story beats' weights and words, the veteran
// captains, the transmissions and the roll call. See docs in the design page:
// https://claude.ai/artifact/WYk5b2eNcE6BzVz5edGLUx
// ============================================================================

import { Walker, hashOf, numWord, cap, listOf, shareWord, tidy } from './prose.js';
import {
  MADE_TITLES, MADE_TITLES_SPHERE, MADE_TITLES_VOTE,
  BOARD_OPEN, BOARD_SENATE, BOARD_TRADE, BOARD_FAR, BOARD_QUIET,
  HINTS, OMEN, OMEN_EXTRA, ROLE_LABEL, NO_BIO, HEAD, BECAUSE, RECEIPT, KICKER,
} from './banks.js';

/** Bump when the engine's output changes shape or meaning: stored films
 *  older than this are rebuilt the next time they are opened. */
export const SAGA_ENGINE_VERSION = 1;

/** The film's length for a match of `span` days (Lorne, 2026-10-23: "Film
 *  can be as long as 3 minutes"). */
export function sagaRuntime(span) {
  return Math.max(90, Math.min(180, Math.round(90 + Math.max(0, span) * 0.16)));
}

const pairKey = (a, b) => [a, b].sort().join('|');
/** A bill title that reads as something somebody said, not a policy name:
 *  four or more words, or sentence punctuation, or a lowercase word. */
const isLine = (t) => {
  const w = String(t ?? '').trim().split(/\s+/);
  return w.length >= 4 || /[.!?'’]/.test(t) || (w.length >= 3 && w.some(x => /^[a-z]/.test(x)));
};
const short = (name) => String(name ?? '').replace(/^The\s+/i, '').trim();
const sum = (o) => Object.values(o ?? {}).reduce((a, v) => a + (Number(v) || 0), 0);

// ===========================================================================
// FACTS: the story graph and the measurements
// ===========================================================================

export function factsOf(D) {
  const empires = D.empires.filter(e => !/:leviathan_f$/.test(e.id));
  const byId = new Map(empires.map(e => [e.id, e]));
  const nameOf = (fid) => byId.get(fid)?.name ?? null;
  const bodyName = new Map(D.bodies.map(b => [b.id, b.name]));
  const C = D.chronicle;
  const start = C.find(r => r.kind === 'game_started')?.t ?? D.series?.ticks?.[0] ?? 0;
  const end = Math.max(start + 1, D.game.currentTick ?? 0);
  const span = end - start;
  const winner = D.game.winnerFactionId ?? null;

  // Homes: the capitals the match opened with.
  const home = new Map();
  for (const f of C.find(r => r.kind === 'game_started')?.p?.factions ?? []) {
    if (f?.id && f.capital_body_id) home.set(f.id, bodyName.get(f.capital_body_id) ?? null);
  }

  // Who led, and for how long (the ending's own holdings series).
  const ticks = D.series?.ticks ?? [];
  const leadTime = new Map();
  let leadChanges = 0, prevLeader = null;
  const leaderAt = [];
  for (let i = 0; i < ticks.length; i++) {
    let best = null, bestN = 0, tie = false;
    for (const e of empires) {
      const n = D.series.holdings?.[e.id]?.[i] ?? 0;
      if (n > bestN) { best = e.id; bestN = n; tie = false; } else if (n === bestN && n > 0) tie = true;
    }
    const leader = tie ? null : best;
    leaderAt.push(leader);
    const dt = i + 1 < ticks.length ? ticks[i + 1] - ticks[i] : 0;
    if (leader) leadTime.set(leader, (leadTime.get(leader) ?? 0) + dt);
    if (leader && prevLeader && leader !== prevLeader) leadChanges++;
    if (leader) prevLeader = leader;
  }
  const ledTotal = [...leadTime.values()].reduce((a, b) => a + b, 0) || 1;
  const leadShare = (fid) => (leadTime.get(fid) ?? 0) / ledTotal;
  /** The leader at a fraction of the way through the match. */
  const leaderAtFrac = (f) => {
    const t = start + span * f;
    let i = 0;
    while (i + 1 < ticks.length && ticks[i + 1] <= t) i++;
    return leaderAt[i] ?? null;
  };
  const holdingsAtFrac = (fid, f) => {
    const t = start + span * f;
    let i = 0;
    while (i + 1 < ticks.length && ticks[i + 1] <= t) i++;
    return D.series.holdings?.[fid]?.[i] ?? 0;
  };

  // Pacts, wars, betrayals.
  const pacts = C.filter(r => r.kind === 'treaty_signed' && byId.has(r.a) && byId.has(r.b));
  const pactsBy = new Map();
  for (const p of pacts) {
    for (const f of [p.a, p.b]) pactsBy.set(f, (pactsBy.get(f) ?? 0) + 1);
  }
  const lastPact = (a, b, before) => {
    let hit = null;
    for (const p of pacts) if (p.t <= before && pairKey(p.a, p.b) === pairKey(a, b)) hit = p;
    return hit;
  };
  const wars = C.filter(r => r.kind === 'war_declared' && byId.has(r.a) && byId.has(r.b))
    .map(r => ({ t: r.t, a: r.a, b: r.b, broke: Array.isArray(r.p?.broke_pacts) ? r.p.broke_pacts : [] }));
  const betrayals = wars.filter(w => w.broke.length);
  const count = (list, key) => { const m = new Map(); for (const x of list) m.set(x[key], (m.get(x[key]) ?? 0) + 1); return m; };
  const betrayalsBy = count(betrayals, 'a');
  const betrayedBy = count(betrayals, 'b');
  const warsBy = count(wars, 'a');
  const warsOn = count(wars, 'b');

  // Worlds changing hands, and who finished whom.
  const seizes = C.filter(r => r.kind === 'settlement_seized' && byId.has(r.a))
    .map(r => ({ t: r.t, to: r.a, from: r.p?.former_owner_faction_id ?? null, world: r.p?.body_name ?? bodyName.get(r.body) ?? '' }));
  const lastBlow = (fid, t) => {
    let k = null;
    for (const r of C) {
      if (r.t > t) break;
      if (r.kind === 'settlement_destroyed' && r.a === fid && r.p?.killer_faction_id) k = r.p.killer_faction_id;
      if (r.kind === 'settlement_seized' && r.p?.former_owner_faction_id === fid && r.a) k = r.a;
    }
    return k && k !== fid && byId.has(k) ? k : null;
  };
  const elims = C.filter(r => r.kind === 'faction_eliminated' && byId.has(r.a))
    .map(r => ({ t: r.t, fid: r.a, killer: lastBlow(r.a, r.t) }));
  // One empire, one fall (a revived empire can fall twice; the last counts).
  const fallOf = new Map();
  for (const e of elims) fallOf.set(e.fid, e);
  const falls = [...fallOf.values()].sort((a, b) => a.t - b.t);
  const felled = count(falls.filter(e => e.killer), 'killer');

  // Rivalries: wars and conquests between a pair.
  const rivalry = new Map();
  const bump = (a, b, n) => { if (a && b && a !== b) rivalry.set(pairKey(a, b), (rivalry.get(pairKey(a, b)) ?? 0) + n); };
  for (const w of wars) bump(w.a, w.b, 1);
  for (const s of seizes) bump(s.to, s.from, 2);
  for (const b of D.battles ?? []) {
    const l = b.lossesByFaction ?? [];
    if (l.length >= 2) bump(l[0].factionId, l[1].factionId, 3);
  }

  // The Senate.
  const laws = C.filter(r => r.kind === 'senate_vote').map(r => ({
    t: r.t, title: String(r.p?.title ?? '').trim(), kind: r.p?.bill_kind ?? '', outcome: r.p?.outcome ?? '',
    yea: Number(r.p?.yea_weight) || 0, nay: Number(r.p?.nay_weight) || 0,
    target: r.p?.payload?.target_faction_id ?? r.p?.target_faction_id ?? null,
    proposer: D.bills.find(b => b.title === r.p?.title && Math.abs((b.resolved ?? r.t) - r.t) <= 2)?.proposer ?? null,
  }));
  const bills = D.bills.map(b => {
    const yea = b.votes.filter(v => v.vote === 'yea').reduce((a, v) => a + v.weight, 0);
    const nay = b.votes.filter(v => v.vote === 'nay').reduce((a, v) => a + v.weight, 0);
    return { ...b, title: String(b.title ?? '').trim(), yea, nay };
  });
  const agree = new Map(), both = new Map(), lone = new Map();
  for (const b of bills) {
    const v = new Map(b.votes.filter(x => byId.has(x.fid) && (x.vote === 'yea' || x.vote === 'nay')).map(x => [x.fid, x.vote]));
    if (v.size >= 4) {
      for (const side of ['yea', 'nay']) {
        const on = [...v].filter(([, x]) => x === side).map(([f]) => f);
        if (on.length === 1) lone.set(on[0], (lone.get(on[0]) ?? 0) + 1);
      }
    }
    if (winner && v.has(winner)) {
      for (const [f, x] of v) {
        if (f === winner) continue;
        both.set(f, (both.get(f) ?? 0) + 1);
        if (x === v.get(winner)) agree.set(f, (agree.get(f) ?? 0) + 1);
      }
    }
  }

  // The great works and the beast.
  const dysonStart = C.find(r => r.kind === 'dyson_initiated') ?? null;
  const dysonLast = [...C].reverse().find(r => r.kind === 'dyson_damaged' || r.kind === 'dyson_milestone') ?? null;
  const beastDead = C.find(r => r.kind === 'kaiju_dead') ?? null;
  const beastSlayer = beastDead ? empires.find(e => e.name === beastDead.p?.killer_faction_name)?.id ?? null : null;
  const beastCame = C.some(r => r.kind === 'kaiju_launched' || r.kind === 'kaiju_hunting' || r.kind === 'kaiju_omen');
  const farSystems = C.some(r => r.kind === 'sun_gate_opened');
  const megas = count(C.filter(r => r.kind === 'megastructure_complete' && r.a), 'a');
  const terra = count(C.filter(r => r.kind === 'terraform_complete' && r.a), 'a');
  const detonations = count(C.filter(r => r.kind === 'ship_detonated' && r.a), 'a');
  const captainsLost = count(C.filter(r => r.kind === 'captain_lost' && r.a), 'a');

  // Money: public trades given one way (gifts), and worlds sold.
  const gifts = [];
  for (const r of C.filter(x => x.kind === 'trade_accepted' && byId.has(x.a) && byId.has(x.b))) {
    const give = sum(r.p?.offer), take = sum(r.p?.request);
    if (give > 0 && take === 0) gifts.push({ t: r.t, from: r.a, to: r.b, res: r.p.offer, total: give });
    else if (take > 0 && give === 0) gifts.push({ t: r.t, from: r.b, to: r.a, res: r.p.request, total: take });
  }
  const sold = C.filter(r => r.kind === 'asset_sold' && byId.has(r.a) && byId.has(r.b))
    .map(r => ({ t: r.t, from: r.a, to: r.b, asset: r.p?.asset ?? '', kind: r.p?.asset_kind ?? '',
      price: (Number(r.p?.metal) || 0) + (Number(r.p?.credits) || 0), world: bodyName.get(r.body) ?? r.p?.asset ?? '' }));

  // Veterans: the highest-ranked captains lost, with their records.
  const veterans = [];
  for (const c of D.captains) {
    if (!byId.has(c.fid)) continue;
    const kills = c.history.length;
    if (c.rank < 5 && kills < 5) continue;
    const row = C.find(r => r.kind === 'captain_lost' && r.a === c.fid && r.p?.captain_name === c.name
      && (c.t1 == null || Math.abs(r.t - c.t1) <= 2));
    if (!row) continue;
    const first = c.history[0] ?? null;
    veterans.push({
      fid: c.fid, name: c.name, rank: c.rank, bio: c.bio, avatar: c.avatar,
      tick: row.t, ship: row.p?.ship_name ?? null, world: row.p?.body_name ?? bodyName.get(row.body) ?? null,
      days: Math.max(1, row.t - c.t0), kills,
      firstKill: first ? { tick: first.tick, ship: first.targetName, world: bodyName.get(first.atBodyId) ?? null } : null,
      ledger: c.history.map(h => h.targetName).filter(Boolean),
    });
  }
  veterans.sort((a, b) => b.rank - a.rank || b.kills - a.kills || a.tick - b.tick);

  return {
    D, empires, byId, nameOf, start, end, span, winner, home, leadShare, leadChanges, leaderAtFrac, holdingsAtFrac,
    pacts, pactsBy, lastPact, wars, betrayals, betrayalsBy, betrayedBy, warsBy, warsOn,
    seizes, falls, felled, rivalry, laws, bills, agree, both, lone,
    dysonStart, dysonLast, beastDead, beastSlayer, beastCame, farSystems,
    megas, terra, detonations, captainsLost, gifts, sold, veterans: veterans.slice(0, 2),
  };
}

// ===========================================================================
// SHAPE: what kind of match was this?
// ===========================================================================

export function shapeOf(F) {
  const w = F.winner ? F.leadShare(F.winner) : 0;
  const shape = w >= 0.75 ? 'hegemony' : w <= 0.4 ? 'upset' : 'race';
  const overlays = [];
  if (F.D.game.victoryType === 'chancellor') overlays.push('vote');
  if (F.beastCame) overlays.push('leviathan');
  // Three or more falls inside 120 days.
  const ft = F.falls.map(f => f.t);
  for (let i = 0; i + 2 < ft.length; i++) if (ft[i + 2] - ft[i] <= 120) { overlays.push('purge'); break; }
  if (F.dysonStart) overlays.push('sphere');
  if (F.betrayals.length >= 2) overlays.push('betrayal');
  if (F.veterans.length) overlays.push('veteran');
  if (F.farSystems) overlays.push('farSystems');
  const lost = F.D.totals?.shipsLost ?? 0;
  const mood = F.D.game.victoryType === 'engineering' ? 'gold'
    : F.D.game.victoryType === 'chancellor' ? 'violet'
      : (F.wars.length >= 3 || lost >= 30 * F.empires.length) ? 'ember' : 'ice';
  return { shape, overlays, mood, winnerLead: w };
}

// ===========================================================================
// CAST: one role per empire, the rarest first
// ===========================================================================

/** Role tests: [role, score(e) -> number|null]. Higher score wins the role. */
function roleTests(F) {
  const W = F.winner;
  const pct = (fid) => Math.round(F.leadShare(fid) * 100);
  const fav = F.empires.filter(e => e.id !== W).sort((a, b) => F.leadShare(b.id) - F.leadShare(a.id))[0]?.id ?? null;
  const maxOf = (m) => Math.max(0, ...m.values());
  const firstFall = F.falls[0]?.t ?? null;
  const giftTo = (fid, to) => F.gifts.filter(g => g.from === fid && g.to === to).reduce((a, g) => a + g.total, 0);
  const salesTo = (fid, to) => F.sold.filter(s => s.from === fid && s.to === to).length;
  return [
    ['oathbreaker', e => ((F.betrayalsBy.get(e.id) ?? 0) >= 2 ? F.betrayalsBy.get(e.id) : null)],
    ['monsterSlayer', e => (F.beastSlayer === e.id ? 10 : null)],
    ['patron', e => (W && e.id !== W && giftTo(e.id, W) >= 2000 ? giftTo(e.id, W) / 1000 : null)],
    ['abdicator', e => {
      if (e.id === W) return null;
      const top = F.empires.map(o => o.id).filter(o => o !== e.id)
        .map(o => ({ o, n: salesTo(e.id, o), g: giftTo(e.id, o) })).sort((a, b) => b.n - a.n || b.g - a.g)[0];
      return top && (top.n >= 2 || top.g >= 5000) ? top.n + top.g / 5000 : null;
    }],
    ['kingmaker', e => {
      const n = F.both.get(e.id) ?? 0, k = F.agree.get(e.id) ?? 0;
      return W && e.id !== W && n >= 5 && k / n >= 0.85 ? k / n + n / 100 : null;
    }],
    ['fallingStar', e => (e.id !== W && e.peak.holdings >= 8 && e.final.holdings <= e.peak.holdings / 2
      ? (e.peak.holdings - e.final.holdings) : null)],
    ['zealots', e => ((F.detonations.get(e.id) ?? 0) >= 10 && (F.detonations.get(e.id) ?? 0) === maxOf(F.detonations)
      ? F.detonations.get(e.id) : null)],
    ['conqueror', e => ((F.felled.get(e.id) ?? 0) >= 2 ? F.felled.get(e.id) : null)],
    ['fallenFavourite', e => (e.id === fav && e.id !== W && F.leadShare(e.id) >= 0.4 ? F.leadShare(e.id) : null)],
    ['besieged', e => {
      const n = Math.max(F.betrayedBy.get(e.id) ?? 0, (F.warsOn.get(e.id) ?? 0) >= 3 ? 2 : 0);
      return (F.betrayedBy.get(e.id) ?? 0) >= 2 || (F.warsOn.get(e.id) ?? 0) >= 3 ? n + (F.warsOn.get(e.id) ?? 0) / 10 : null;
    }],
    ['merchantPrince', e => (e.totals.trades >= 6 && e.totals.trades === Math.max(...F.empires.map(o => o.totals.trades))
      ? e.totals.trades : null)],
    ['builder', e => ((F.megas.get(e.id) ?? 0) >= 2 || (F.terra.get(e.id) ?? 0) >= 8
      ? (F.megas.get(e.id) ?? 0) * 3 + (F.terra.get(e.id) ?? 0) : null)],
    ['dissenter', e => ((F.lone.get(e.id) ?? 0) >= 2 ? F.lone.get(e.id) : null)],
    ['graveyard', e => ((F.captainsLost.get(e.id) ?? 0) >= 12 && (F.captainsLost.get(e.id) ?? 0) === maxOf(F.captainsLost)
      ? F.captainsLost.get(e.id) : null)],
    ['diplomat', e => ((F.pactsBy.get(e.id) ?? 0) >= 6 && (F.pactsBy.get(e.id) ?? 0) === maxOf(F.pactsBy)
      ? F.pactsBy.get(e.id) : null)],
    ['firstToFall', e => (e.finalStatus === 'eliminated' && firstFall != null && F.falls.find(f => f.fid === e.id)?.t === firstFall ? 1 : null)],
    ['scrapper', e => (e.finalStatus === 'eliminated' && (F.warsBy.get(e.id) ?? 0) >= 1 ? F.warsBy.get(e.id) : null)],
    ['collateral', e => (e.finalStatus === 'eliminated' && !(F.warsBy.get(e.id) ?? 0) ? 1 : null)],
    ['survivor', e => (e.finalStatus !== 'eliminated' && e.id !== W && !(F.warsOn.get(e.id) ?? 0)
      && !F.seizes.some(s => s.from === e.id) ? 1 : null)],
    ['silent', e => (e.peak.holdings <= 1 && !F.D.said.some(s => s.fid === e.id) && !(F.warsBy.get(e.id) ?? 0) ? 1 : null)],
  ].map(([role, test]) => ({ role, test, pct }));
}

export function castOf(F, S) {
  const W = F.winner;
  const roleOf = new Map();
  if (W) {
    const w = F.leadShare(W);
    roleOf.set(W, F.falls.some(f => f.fid === W) ? 'comeback'
      : w >= 0.75 ? 'hegemon' : w <= 0.4 ? 'upstart' : 'champion');
  }
  const tests = roleTests(F);
  // Rarest first: a role few empires qualify for is handed out before a
  // common one, so the cast does not come out as five Scrappers.
  const quals = tests.map(t => ({ ...t, who: F.empires.filter(e => !roleOf.has(e.id))
    .map(e => ({ e, s: t.test(e) })).filter(x => x.s != null) }))
    .filter(t => t.who.length)
    .sort((a, b) => a.who.length - b.who.length);
  const used = new Set(roleOf.values());
  /** Common roles several empires can share; every other role is unique. */
  const SHARED = new Set(['collateral', 'scrapper', 'survivor']);
  for (const t of quals) {
    if (used.has(t.role) && !SHARED.has(t.role)) continue;
    if (SHARED.has(t.role)) {
      for (const x of t.who) if (!roleOf.has(x.e.id)) roleOf.set(x.e.id, t.role);
      used.add(t.role);
      continue;
    }
    const pick = t.who.filter(x => !roleOf.has(x.e.id)).sort((a, b) => b.s - a.s || a.e.place - b.e.place)[0];
    if (!pick) continue;
    roleOf.set(pick.e.id, t.role);
    used.add(t.role);
  }
  for (const e of F.empires) if (!roleOf.has(e.id)) roleOf.set(e.id, e.finalStatus === 'eliminated' ? 'fallen' : 'contender');
  return roleOf;
}

/** The stat line under an empire's role. */
function receiptOf(F, e, role) {
  const W = F.winner, wName = short(F.nameOf(W));
  const fall = F.falls.find(f => f.fid === e.id);
  const giftTotal = (to) => F.gifts.filter(g => g.from === e.id && g.to === to).reduce((a, g) => a + g.total, 0);
  const sales = F.sold.filter(s => s.from === e.id);
  const salesTo = sales.length ? sales[sales.length - 1].to : null;
  const ctx = {
    pct: Math.round(F.leadShare(e.id) * 100), n: 0, betrayed: F.betrayedBy.get(e.id) ?? 0, wars: F.warsOn.get(e.id) ?? 0,
    peak: e.peak.holdings, final: e.final.holdings, w: wName, k: F.agree.get(e.id) ?? 0, t: fall?.t ?? 0,
    tied: fall ? F.falls.filter(f => f.t === fall.t).length > 1 : false,
    megas: F.megas.get(e.id) ?? 0, terra: F.terra.get(e.id) ?? 0, world: F.beastDead?.p?.world ?? F.beastDead?.p?.body_name ?? '',
    amount: '',
  };
  switch (role) {
    case 'oathbreaker': ctx.n = F.betrayalsBy.get(e.id) ?? 0; break;
    case 'zealots': ctx.n = F.detonations.get(e.id) ?? 0; break;
    case 'conqueror': ctx.n = F.felled.get(e.id) ?? 0; break;
    case 'kingmaker': ctx.n = F.both.get(e.id) ?? 0; break;
    case 'merchantPrince': ctx.n = e.totals.trades; break;
    case 'dissenter': ctx.n = F.lone.get(e.id) ?? 0; break;
    case 'diplomat': ctx.n = F.pactsBy.get(e.id) ?? 0; break;
    case 'graveyard': ctx.n = F.captainsLost.get(e.id) ?? 0; break;
    case 'scrapper': ctx.n = F.warsBy.get(e.id) ?? 0; break;
    case 'patron': ctx.amount = amountWords({ metal: giftTotal(W) }); break;
    case 'abdicator': {
      const to = salesTo ?? F.gifts.filter(g => g.from === e.id).sort((a, b) => b.total - a.total)[0]?.to ?? null;
      ctx.w = short(F.nameOf(to));
      const g = giftTotal(to);
      ctx.amount = [sales.filter(s => s.to === to).length ? `${numWord(sales.filter(s => s.to === to).length)} worlds` : '',
        g ? amountWords({ total: g }) : ''].filter(Boolean).join(' and ');
      break;
    }
    default: break;
  }
  return RECEIPT[role] ? tidy(RECEIPT[role](ctx)) : '';
}

/** "9,000 metal", or a total. */
function amountWords(r) {
  if (r.total != null) return `${Math.round(r.total).toLocaleString('en-US')} in goods`;
  const parts = [];
  for (const [k, label] of [['metal', 'metal'], ['gold', 'credits'], ['science', 'science'], ['fuel', 'fuel']]) {
    const v = Math.round(Number(r[k]) || 0);
    if (v > 0) parts.push(`${v.toLocaleString('en-US')} ${label}`);
  }
  return listOf(parts);
}

// ===========================================================================
// PLOTS AND BEATS
// ===========================================================================

function plotsOf(F, S, roles) {
  const W = F.winner;
  const rivals = [...F.rivalry.entries()].sort((a, b) => b[1] - a[1]);
  const plots = [];
  const roleHolder = (r) => [...roles.entries()].find(([, x]) => x === r)?.[0] ?? null;
  // A: the main story always reaches the ending, so it is the winner's.
  if (W) {
    const fav = roleHolder('fallenFavourite');
    const targetedBy = F.wars.filter(w => w.b === W).map(w => w.a);
    let fids = [W], kind = 'winner';
    if (S.shape === 'upset' && new Set(targetedBy).size >= 2) { kind = 'target'; fids = [W, ...new Set(targetedBy)]; }
    else if (S.shape === 'upset' && fav) { kind = 'favourite'; fids = [W, fav]; }
    else if (S.shape === 'hegemony') {
      kind = 'resistance';
      fids = [W, ...F.falls.filter(f => f.killer === W).map(f => f.fid)];
      const top = rivals.find(([k]) => k.split('|').includes(W));
      if (top) for (const f of top[0].split('|')) if (!fids.includes(f)) fids.push(f);
    } else {
      const top = rivals.find(([k]) => k.split('|').includes(W));
      const second = F.empires.filter(e => e.id !== W).sort((a, b) => F.leadShare(b.id) - F.leadShare(a.id))[0]?.id;
      const rival = top ? top[0].split('|').find(f => f !== W) : second;
      kind = 'duel'; fids = [W, rival].filter(Boolean);
    }
    plots.push({ id: 'A', kind, fids: [...new Set(fids)] });
  }
  const inA = new Set(plots[0]?.fids ?? []);
  // B: the betrayal story, else the biggest rivalry the main story leaves out.
  const oath = roleHolder('oathbreaker');
  if (oath && !(inA.has(oath) && plots[0].fids.length > 2)) {
    const victims = [...new Set(F.betrayals.filter(b => b.a === oath).map(b => b.b))];
    plots.push({ id: 'B', kind: 'betrayal', fids: [oath, ...victims] });
  } else {
    const r = rivals.find(([k]) => !k.split('|').every(f => inA.has(f)));
    if (r) plots.push({ id: 'B', kind: 'rivalry', fids: r[0].split('|') });
  }
  // C: the Leviathan, else the Senate, else a falling star.
  if (F.beastDead || F.beastCame) plots.push({ id: 'C', kind: 'leviathan', fids: F.beastSlayer ? [F.beastSlayer] : [] });
  else if (F.laws.some(l => l.outcome === 'passed')) plots.push({ id: 'C', kind: 'senate', fids: [] });
  else {
    const star = roleHolder('fallingStar');
    if (star) plots.push({ id: 'C', kind: 'fallingStar', fids: [star] });
  }
  return plots;
}

/** The story scenes, with their words. */
function beatsOf(F, S, plots, roles, walker) {
  const out = [];
  const plotOf = (...fids) => {
    for (const p of plots) if (fids.some(f => f && p.fids.includes(f))) return p.id;
    return null;
  };
  /** A war between two empires is a story's only when both are in it, and,
   *  in a story about everyone against one empire, one of them is that empire. */
  const plotOfPair = (a, b) => {
    for (const p of plots) {
      if (!p.fids.includes(a) || !p.fids.includes(b)) continue;
      if (p.kind === 'target' && a !== p.fids[0] && b !== p.fids[0]) continue;
      return p.id;
    }
    return null;
  };
  const N = (fid) => short(F.nameOf(fid));
  const say = (bank, kind, ctx, opts) => walker.say(`${bank}.${kind}`, bank === 'head' ? HEAD[kind] : BECAUSE[kind], ctx, opts);
  const add = (b) => out.push(b);
  const W = F.winner;

  // Wars: betrayals always; ordinary declarations when they are story.
  const pileOn = new Map();
  for (const w of F.wars) {
    const near = F.wars.filter(x => x.b === w.b && Math.abs(x.t - w.t) <= 3);
    if (near.length >= 3) { pileOn.set(`${w.b}:${near[0].t}`, near); continue; }
    const plot = plotOfPair(w.a, w.b);
    if (w.broke.length) {
      const pact = F.lastPact(w.a, w.b, w.t);
      add({ tick: w.t, kind: 'war_declared', fid: w.a, target: w.b, plot: plot ?? 'B', weight: plot === 'A' ? 175 : 150,
        kicker: KICKER.betrayal, title: say('head', 'betrayal', { a: N(w.a), b: N(w.b) }),
        because: pact ? say('because', 'pactSigned', { t: pact.t, d: Math.max(1, w.t - pact.t) }) : '' });
    } else if (plot) {
      add({ tick: w.t, kind: 'war_declared', fid: w.a, target: w.b, plot, weight: plot === 'A' ? 120 : 90,
        kicker: KICKER.war, title: say('head', 'war', { a: N(w.a), b: N(w.b) }), because: '' });
    }
  }
  for (const near of pileOn.values()) {
    const b = near[0].b;
    const broke = near.filter(x => x.broke.length).length;
    add({ tick: near[0].t, kind: 'war_declared', fid: near[0].a, target: b, plot: plotOf(b) ?? 'A', weight: 190,
      kicker: KICKER.pile, title: say('head', 'pile', { n: numWord(near.length), N: cap(numWord(near.length)), b: N(b) }),
      because: broke ? say('because', 'pactsBrokenToo', { n: cap(numWord(broke)) }) : '' });
  }

  // Falls.
  let remaining = F.empires.length;
  for (const f of F.falls) {
    remaining--;
    const e = F.byId.get(f.fid);
    const plot = plotOf(f.fid, f.killer) ?? 'B';
    add({ tick: f.t, kind: 'faction_eliminated', fid: f.fid, target: f.killer, plot, weight: 230,
      kicker: KICKER.fall,
      title: f.killer ? say('head', 'fallBy', { a: N(f.fid), k: N(f.killer) }) : say('head', 'fall', { a: N(f.fid) }),
      because: tidy(`${e?.peak?.holdings >= 2 ? say('because', 'peakWas', { peak: numWord(e.peak.holdings), Peak: cap(numWord(e.peak.holdings)) }) : ''} ${say('because', 'remain', { r: cap(numWord(remaining)) })}`),
      remaining });
  }

  // The Senate's laws that changed things: wars voted, close votes, the final vote.
  for (const l of F.laws) {
    if (l.outcome !== 'passed') continue;
    if (l.kind === 'war_authorization' && l.target) {
      add({ tick: l.t, kind: 'senate_vote', fid: l.proposer, target: l.target, plot: plotOf(l.target) ?? 'C', weight: 150,
        kicker: KICKER.warLaw, title: say('head', 'warLaw', { b: N(l.target) }),
        because: say('because', 'lawVote', { yea: l.yea, nay: l.nay }) });
    } else if (l.kind === 'chancellor_vote') {
      add({ tick: l.t, kind: 'senate_vote', fid: W, target: null, plot: 'A', weight: 240,
        kicker: KICKER.vote, title: say('head', 'vote', { a: N(W) }),
        because: say('because', 'voteWas', { yea: l.yea, nay: l.nay }) });
    } else if (plots.some(p => p.kind === 'senate') && l.title && isLine(l.title)
      && out.filter(b => b.kind === 'senate_vote' && b.plot === 'C').length < 3) {
      add({ tick: l.t, kind: 'senate_vote', fid: l.proposer, target: null, plot: 'C', weight: 110,
        kicker: KICKER.law, title: say('head', 'law', { title: l.title, yea: l.yea, nay: l.nay }),
        because: '' });
    }
  }

  // The Sphere.
  if (F.dysonStart?.a) {
    const a = F.dysonStart.a, t = F.dysonStart.t;
    const warVote = F.laws.find(l => l.kind === 'war_authorization' && l.outcome === 'passed' && l.target === a && l.t <= t && t - l.t <= 40);
    add({ tick: t, kind: 'dyson_initiated', fid: a, target: null, plot: plotOf(a) ?? 'B', weight: 170,
      kicker: KICKER.sphereBegun, title: say('head', 'sphereBegun', { a: N(a) }),
      because: warVote ? say('because', 'afterWarVote', { d: Math.max(1, t - warVote.t) }) : say('because', 'sphereStakes', { a: N(a) }) });
    const last = F.dysonLast;
    if (last && last.kind === 'dyson_damaged' && Number(last.p?.pct) >= 90) {
      add({ tick: last.t, kind: 'dyson_damaged', fid: a, target: null, plot: plotOf(a) ?? 'B', weight: 200,
        kicker: KICKER.sphereStruck, title: say('head', 'sphereStruck', { pct: Number(last.p.pct) }),
        because: say('because', 'sphereNearly', { d: Math.max(1, last.t - t) }) });
    }
  }

  // The Leviathan.
  if (F.beastDead) {
    const p = F.beastDead.p ?? {};
    const eaten = Array.isArray(p.eaten) && p.eaten.length ? listOf(p.eaten) : '';
    add({ tick: F.beastDead.t, kind: 'kaiju_dead', fid: F.beastSlayer, target: null, plot: 'C', weight: 210,
      kicker: KICKER.beastDead,
      title: F.beastSlayer ? say('head', 'beastDead', { a: N(F.beastSlayer), world: p.world ?? '' }) : `The Leviathan dies at ${p.world ?? 'the edge of the system'}`,
      because: eaten ? say('because', 'beastAte', { eaten }) : p.killer_ship_name ? say('because', 'beastBy', { ship: p.killer_ship_name }) : '' });
  }

  // Veterans.
  for (const v of F.veterans) {
    add({ tick: v.tick, kind: 'captain_lost', fid: v.fid, target: null, plot: plotOf(v.fid) ?? 'B', weight: 205,
      kicker: KICKER.veteran,
      title: v.ship ? say('head', 'veteran', { name: v.name, ship: v.ship, a: N(v.fid) }) : `${N(v.fid)} loses Captain ${v.name}`,
      because: say('because', 'veteranRecord', { days: v.days, rank: v.rank, kills: v.kills, Kills: cap(numWord(v.kills)), killsWord: v.kills === 1 ? 'kill' : 'kills' }),
      veteran: v.name });
  }

  // Money that changed the result: a gift to an empire building its Sphere,
  // or the biggest gift to the winner; worlds sold to a rival.
  const toWinner = F.gifts.filter(g => g.to === W && g.total >= 2000).sort((a, b) => b.total - a.total)[0];
  if (toWinner) {
    const sphere = F.dysonStart?.a === W && toWinner.t >= F.dysonStart.t ? F.dysonStart : null;
    add({ tick: toWinner.t, kind: 'trade_accepted', fid: toWinner.from, target: W, plot: 'A', weight: 130,
      kicker: KICKER.gift, title: say('head', 'gift', { a: N(toWinner.from), b: N(W), amount: amountWords(toWinner.res) }),
      because: sphere ? say('because', 'giftBefore', { d: Math.max(1, toWinner.t - sphere.t), b: N(W) }) : '' });
  }
  return out.sort((a, b) => a.tick - b.tick || b.weight - a.weight);
}

// ===========================================================================
// TRANSMISSIONS: the empires' own words on the public channel
// ===========================================================================

/** Out of character, a technical question, or a reaction with no words in it. */
const OOC = /\b(gg\w*|glhf|gl hf|good luck|have fun|ooc|afk|discord|lol\w*|lmao|xd|bug\w*|lag\w*|fps|frames|tutorial|ui|how do (i|you)|zoom out|thanks|thank you|duplicat\w*|enter|email|players?|mechanics|this game|the game|tho)\b|^\s*[([]/i;

export function transmissionsOf(F, plots, beats) {
  const inPlot = new Set(plots.flatMap(p => p.fids));
  const seen = new Set();
  const cands = [];
  for (const s of F.D.said) {
    let text = s.text.replace(/@everyone/gi, '').replace(/\s+/g, ' ').trim();
    // A long speech is quoted by its opening sentences.
    if (text.length > 170) {
      const cut = text.slice(0, 170).match(/^.*[.!?](?=\s|$)/);
      if (cut && cut[0].length >= 40) text = cut[0];
    }
    if (!F.byId.has(s.fid) || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    if (text.length < 10 || text.length > 170 || letters < text.length * 0.55 || OOC.test(text) || /https?:/i.test(text)) continue;
    // A line counts when it is about a story: said by a story empire, or
    // within a fortnight of one of its scenes.
    const near = beats.some(b => (b.fid === s.fid || b.target === s.fid) && Math.abs(b.tick - s.t) <= 14);
    if (!inPlot.has(s.fid) && !near) continue;
    // Punchy beats long: a line someone shouted, not a press release.
    let score = (inPlot.has(s.fid) ? 2 : 0) + (near ? 3 : 0)
      + (text.length >= 24 && text.length <= 120 ? 1.5 : text.length > 150 ? -1 : 0);
    if (/[!?]/.test(text)) score += 0.5;
    if (/\b[A-Z]{3,}\b.*\b[A-Z]{3,}\b/.test(text)) score += 1;
    for (const e of F.empires) if (e.id !== s.fid && text.toLowerCase().includes(short(e.name).toLowerCase().split(' ')[0])) score += 1;
    cands.push({ tick: s.t, fid: s.fid, text, score });
  }
  // At most one per act (thirds of the match), the best of each.
  const acts = [0, 1, 2].map(i => cands.filter(c => c.tick >= F.start + (F.span * i) / 3 && c.tick < F.start + (F.span * (i + 1)) / 3)
    .sort((a, b) => b.score - a.score || a.tick - b.tick)[0]).filter(Boolean);
  return acts.map(({ tick, fid, text }) => ({ tick, fid, text }));
}

// ===========================================================================
// THE CRAWL
// ===========================================================================

function titleOf(F, S, plots, walker) {
  const aFids = new Set(plots[0]?.fids ?? []);
  const cands = F.bills.filter(b => (b.title.match(/\p{L}/gu) ?? []).length >= 3 && b.title.length <= 70)
    .map(b => {
      let s = 0;
      if (b.status === 'passed') s += 2;
      if (b.kind === 'chancellor_vote' && b.status === 'passed') s += 2;
      if (b.proposer && aFids.has(b.proposer)) s += 1;
      else if (b.proposer && plots.some(p => p.fids.includes(b.proposer))) s += 0.5;
      const voters = b.votes.length;
      if (voters >= 3 && Math.abs(b.yea - b.nay) <= 1) s += 2;
      // A title that names what the match turned out to be about.
      if (S.overlays.includes('leviathan') && /monster|beast|squid|leviathan|kaiju/i.test(b.title)) s += 2;
      if (S.overlays.includes('sphere') && /sphere|dyson|sun\b/i.test(b.title)) s += 2;
      // A LINE SOMEONE SAID beats a policy name: "There's a giant space
      // monster coming. Mount up." over "Government Handouts".
      if (isLine(b.title)) s += 3;
      else if (b.title.split(/\s+/).length <= 3) s -= 1;
      s += (hashOf(b.title) % 100) / 1000;    // a stable tie-break
      return { b, s };
    })
    .sort((a, b) => b.s - a.s);
  const best = cands[0];
  if (best && best.s >= 3) {
    const b = best.b;
    const by = short(F.nameOf(b.proposer));
    const how = b.kind === 'chancellor_vote' && b.status === 'passed' ? 'THE BILL THAT ENDED IT'
      : b.status === 'passed' ? 'A LAW OF THE SENATE'
        : Math.abs(b.yea - b.nay) <= 1 && b.votes.length >= 3 ? `FAILED ON A ${b.yea}–${b.nay} TIE` : 'A BILL THAT FAILED';
    return { text: b.title, kind: 'law', credit: by ? `${how} · PROPOSED BY ${by.toUpperCase()}` : how };
  }
  const battle = [...(F.D.battles ?? [])].sort((a, b) => (b.shipsLost ?? 0) - (a.shipsLost ?? 0))[0];
  const ctx = {
    world: battle?.bodyName ?? F.home.get(F.winner) ?? 'Sol', home: F.home.get(F.winner) ?? 'Sol',
    days: numWord(F.span), fallen: short(F.nameOf(F.falls[F.falls.length - 1]?.fid)) || short(F.nameOf(F.winner)),
  };
  const bank = S.overlays.includes('sphere') && F.D.game.victoryType === 'engineering' ? MADE_TITLES_SPHERE
    : F.D.game.victoryType === 'chancellor' ? MADE_TITLES_VOTE : MADE_TITLES;
  const made = walker.say('title.made', bank.filter(t => !/fallen/.test(t.toString()) || F.falls.length), ctx);
  return { text: made || 'A Match in Orbit', kind: 'made', credit: '' };
}

function crawlOf(F, S, plots, roles, walker) {
  const n = F.empires.length;
  const p1 = [walker.say('crawl.board', BOARD_OPEN, { n: numWord(n), N: cap(numWord(n)) })];
  if (F.bills.length) p1.push(walker.say('crawl.senate', BOARD_SENATE, {}));
  else if (F.D.totals?.trades >= 6) p1.push(walker.say('crawl.trade', BOARD_TRADE, {}));
  else if ((F.wars[0]?.t ?? Infinity) - F.start > F.span * 0.2) p1.push(walker.say('crawl.quiet', BOARD_QUIET, {}));
  if (F.farSystems) p1.push(walker.say('crawl.far', BOARD_FAR, {}));

  // Paragraph two: the story's empires, each with a hint from its role. The
  // hint must be true at the start; the role says how it pays off.
  const featured = [];
  for (const p of plots) for (const f of p.fids) if (f && !featured.includes(f)) featured.push(f);
  const hints = [];
  for (const fid of featured) {
    if (hints.length >= 2) break;
    let role = roles.get(fid);
    if (role === 'hegemon' && F.leaderAtFrac(0.2) !== fid) role = 'hegemonLate';
    if (role === 'fallenFavourite' && F.leaderAtFrac(0.25) !== fid) role = 'fallenFavourite';
    if (role === 'oathbreaker') {
      const firstBreak = F.betrayals.find(b => b.a === fid)?.t ?? Infinity;
      if (!F.pacts.some(p => (p.a === fid || p.b === fid) && p.t < firstBreak)) role = 'conqueror';
    }
    if (role === 'silent' && F.D.said.some(s => s.fid === fid)) role = null;
    const bank = HINTS[role];
    if (!bank) continue;
    const line = walker.say(`crawl.hint.${role}`, bank, { a: F.nameOf(fid) }, { subject: fid });
    if (line) hints.push(line);
  }
  // Echo one story empire's own creed, when it is short enough to quote.
  const creedOf = featured.map(f => F.byId.get(f)).find(e => e?.bio && e.bio.length <= 70
    && (e.bio.match(/\p{L}/gu) ?? []).length >= 6 && e.bio.trim().split(/\s+/).length >= 2
    && !e.name.toLowerCase().includes(e.bio.trim().toLowerCase()));
  if (creedOf && hints.length < 3) {
    const quote = creedOf.bio.replace(/["“”]/g, '').replace(/\s+/g, ' ').replace(/[.!?,;:\s]+$/, '');
    hints.push(`"${quote}," says ${creedOf.name}.`);
  }

  // Paragraph three: the question, and the strongest overlay.
  const p3 = [walker.say(`crawl.omen.${S.shape}`, OMEN[S.shape], {})];
  const extra = ['vote', 'leviathan', 'purge', 'sphere', 'betrayal', 'veteran'].find(o => S.overlays.includes(o));
  if (extra) {
    const share = shareWord(F.falls.length, n);
    p3.push(walker.say(`crawl.extra.${extra}`, OMEN_EXTRA[extra], { Share: cap(share) }));
  }
  const lines = [p1.filter(Boolean).join(' '), hints.join(' '), p3.filter(Boolean).join(' ')].filter(Boolean);
  const words = lines.join(' ').split(/\s+/).length;
  return { lines, words, seconds: Math.max(10, Math.min(16, Math.round((words / 3.8 + 2) * 10) / 10)) };
}

// ===========================================================================
// THE SCRIPT
// ===========================================================================

export function buildScript(D) {
  const F = factsOf(D);
  const S = shapeOf(F);
  const seed = hashOf(`saga:${D.gameId}`);
  const walker = new Walker(seed, D.ordinal ?? 0);
  const roles = castOf(F, S);
  const plots = plotsOf(F, S, roles);
  const beats = beatsOf(F, S, plots, roles, walker);
  const title = titleOf(F, S, plots, walker);
  const crawl = crawlOf(F, S, plots, roles, walker);

  // The cast, in seat order, each with its creed: the player's own bio, as
  // written, or a line from the engine when there is none.
  const cast = [...F.empires].sort((a, b) => a.slot - b.slot).map(e => ({
    fid: e.id,
    role: roles.get(e.id),
    label: ROLE_LABEL[roles.get(e.id)] ?? '',
    receipt: receiptOf(F, e, roles.get(e.id)),
    creed: e.bio && (e.bio.match(/\p{L}/gu) ?? []).length >= 2 ? e.bio.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    tagline: e.bio ? '' : walker.say('cast.nobio', NO_BIO, { a: e.name }, { subject: e.id }),
    home: F.home.get(e.id) ?? null,
  }));
  // The roll call: the fallen first in the order they fell, then the
  // standing from last place up, the winner last.
  const fallT = new Map(F.falls.map(f => [f.fid, f.t]));
  const rollCall = [...F.empires].sort((a, b) => {
    if (a.id === F.winner) return 1;
    if (b.id === F.winner) return -1;
    const fa = fallT.get(a.id), fb = fallT.get(b.id);
    if (fa != null && fb != null) return fa - fb;
    if (fa != null) return -1;
    if (fb != null) return 1;
    return b.place - a.place;
  }).map(e => e.id);

  // How the film weighs what it did not script: the main story's empires
  // and rivalries count for more, the rest for less.
  const boosts = { fids: {}, pairs: {} };
  for (const p of plots) {
    const m = p.id === 'A' ? 1.5 : p.id === 'B' ? 1.25 : 1.1;
    for (const f of p.fids) if (f) boosts.fids[f] = Math.max(boosts.fids[f] ?? 1, m);
    for (let i = 0; i < p.fids.length; i++) {
      for (let j = i + 1; j < p.fids.length; j++) {
        if (p.fids[i] && p.fids[j]) boosts.pairs[pairKey(p.fids[i], p.fids[j])] = Math.max(boosts.pairs[pairKey(p.fids[i], p.fids[j])] ?? 1, m + 0.2);
      }
    }
  }

  return {
    v: SAGA_ENGINE_VERSION,
    gameId: D.gameId,
    seed,
    ordinal: D.ordinal ?? 0,
    shape: S.shape,
    overlays: S.overlays,
    mood: S.mood,
    runtime: sagaRuntime(F.span),
    span: F.span,
    crawl: { title: title.text, titleKind: title.kind, credit: title.credit, lines: crawl.lines, seconds: crawl.seconds },
    cast,
    rollCall,
    plots,
    beats,
    boosts,
    veterans: F.veterans.map(v => ({ ...v, ledger: v.ledger.slice(-14) })),
    transmissions: transmissionsOf(F, plots, beats),
  };
}

// ===========================================================================
// THE SCRIPT READ: the film as text, for review (scripts/saga-from-prod.mjs)
// ===========================================================================

export function scriptText(s, D) {
  const name = new Map((D?.empires ?? []).map(e => [e.id, e.name]));
  const N = (f) => name.get(f) ?? f ?? '—';
  const L = [];
  L.push(`${'='.repeat(78)}`);
  L.push(`${D?.game?.name ?? s.gameId}  (${s.gameId})  ·  ${s.shape.toUpperCase()}${s.overlays.length ? ' + ' + s.overlays.join(', ') : ''}  ·  mood ${s.mood}  ·  ${s.runtime}s  ·  film #${s.ordinal}`);
  L.push(`${'='.repeat(78)}`);
  L.push('');
  L.push(`  CRAWL (${s.crawl.seconds}s)`);
  L.push(`    "${s.crawl.title}"${s.crawl.credit ? `   — ${s.crawl.credit}` : '   — (engine title)'}`);
  for (const line of s.crawl.lines) L.push(`    ${line}`);
  L.push('');
  L.push('  THE EMPIRES');
  for (const c of s.cast) L.push(`    ${N(c.fid).padEnd(34)} home ${String(c.home ?? '?').padEnd(10)} ${c.creed ? `"${c.creed.slice(0, 70)}"` : c.tagline}`);
  L.push('');
  L.push('  STORIES');
  for (const p of s.plots) L.push(`    ${p.id}  ${p.kind.padEnd(11)} ${p.fids.map(N).join(' · ')}`);
  L.push('');
  L.push('  SCENES');
  for (const b of s.beats) {
    L.push(`    day ${String(b.tick).padStart(4)}  [${b.plot ?? '-'}] ${String(b.weight).padStart(3)}  ${b.kicker.padEnd(16)} ${b.title}`);
    if (b.because) L.push(`    ${' '.repeat(36)}${b.because}`);
  }
  if (s.transmissions.length) {
    L.push('');
    L.push('  TRANSMISSIONS');
    for (const t of s.transmissions) L.push(`    day ${String(t.tick).padStart(4)}  ${N(t.fid)}: "${t.text}"`);
  }
  if (s.veterans.length) {
    L.push('');
    L.push('  VETERANS');
    for (const v of s.veterans) L.push(`    ${v.name} (rank ${v.rank}, ${N(v.fid)}), ${v.ship ?? '?'} at ${v.world ?? '?'} day ${v.tick}: "${v.bio}"`);
  }
  L.push('');
  L.push('  ROLL CALL');
  for (const f of s.rollCall) {
    const c = s.cast.find(x => x.fid === f);
    L.push(`    ${N(f).padEnd(34)} ${String(c?.label ?? '').padEnd(22)} ${c?.receipt ?? ''}`);
  }
  L.push('');
  return L.join('\n');
}
