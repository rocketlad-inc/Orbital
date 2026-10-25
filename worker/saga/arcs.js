// ============================================================================
// saga/arcs.js — the season's story: which arc this match was, who played
// which part in it, and the acts it is told in.
//
//   facts (engine.factsOf) ─► measure: ~20 numbers per empire, every one a
//                             share or a fraction of the match, so a three
//                             empire skirmish and a ten empire war read on
//                             one scale
//                          ─► every ARC scores itself on those numbers and
//                             finds its acts in the record; the best one
//                             that can stand up (enough acts, each on a real
//                             event) tells the story
//                          ─► the protagonist is the arc's most dramatic
//                             empire (Lorne, 2026-10-25), and every other
//                             empire gets a PART relative to it, with the
//                             record that earned it
//
// Studied on the 14 finished prod matches (2026-10-25): the leader piled on
// and pulled down (Friendly, Peace, MEGA, UBGE), the target that survived the
// pile and won (NEXT, Accretion), the second who overtook the first at one
// battle (Pallas, 3 Fools), the duel (MEGA: nine lead changes), the
// juggernaut (8X, Miranda, the practice games), the free-for-all (UBGE).
//
// Pure: no database, no clock. Each arc is a table (fit, cast, acts); adding
// one is a table and its lines (arcBanks.js), not new engine logic. Every
// act is anchored to a real event the film can find (a declaration, a vote,
// a seizure, a fall, a battle); an act with no event does not exist, and an
// arc short of its acts gives way to the next.
// ============================================================================

const pairKey = (a, b) => [a, b].sort().join('|');
/** The fewest days between two acts that are not fights. */
const ACT_GAP = 5;

// ---------------------------------------------------------------------------
// MEASURE
// ---------------------------------------------------------------------------

/** The numbers every arc reads. */
export function measure(F) {
  const D = F.D;
  const ticks = D.series?.ticks ?? [];
  const ids = F.empires.map(e => e.id);
  const H = (fid) => D.series?.holdings?.[fid] ?? ticks.map(() => 0);
  const totals = ticks.map((_, i) => ids.reduce((a, f) => a + (H(f)[i] ?? 0), 0) || 1);
  const idxAt = (t) => { let i = 0; while (i + 1 < ticks.length && ticks[i + 1] <= t) i++; return i; };
  const fracT = (f) => F.start + F.span * f;
  const rankAt = (fid, t) => { const i = idxAt(t); const n = H(fid)[i] ?? 0; return 1 + ids.filter(g => (H(g)[i] ?? 0) > n).length; };
  const heldAt = (fid, t) => H(fid)[idxAt(t)] ?? 0;

  // Sustained lead changes: a new leader counts once it has led three
  // samples running (a one-sample flicker is noise in the series).
  const reigns = [];
  {
    let leader = null, cand = null, streak = 0, candT = 0;
    for (let i = 0; i < ticks.length; i++) {
      let top = null, n = 0, tie = false;
      for (const f of ids) { const v = H(f)[i] ?? 0; if (v > n) { top = f; n = v; tie = false; } else if (v === n && v > 0) tie = true; }
      if (!top || tie || top === leader) { if (top === leader) { cand = null; streak = 0; } continue; }
      if (top === cand) streak++; else { cand = top; streak = 1; candT = ticks[i]; }
      if (streak >= 3) { reigns.push({ fid: top, t: candT }); leader = top; cand = null; streak = 0; }
    }
  }

  // A gang-up: two or more empires declaring on one inside a window that
  // scales with the match (a 6,000 day match is not paced like a 300).
  const W = Math.max(20, Math.round(F.span * 0.08));
  const hostileLaw = /war_authorization|trade_embargo|production_sanction|reparations/;
  const M = new Map();
  const biggest = Math.max(1, ...(D.battles ?? []).map(b => b.shipsLost ?? 0));
  for (const e of F.empires) {
    const fid = e.id;
    const h = H(fid);
    const peak = Math.max(0, ...h);
    const peakI = h.indexOf(peak);
    const peakShare = peak / (totals[peakI] || 1);
    const final = h[h.length - 1] ?? 0;
    const on = F.wars.filter(w => w.b === fid).sort((a, b) => a.t - b.t);
    let pile = null;
    for (let i = 0; i < on.length && !pile; i++) {
      const win = on.filter(w => w.t >= on[i].t && w.t <= on[i].t + W);
      const by = [...new Set(win.map(w => w.a))];
      if (by.length >= 2) pile = { t: on[i].t, by, wars: win };
    }
    const laws = F.laws.filter(l => l.outcome === 'passed' && l.target === fid && hostileLaw.test(l.kind));
    const fall = F.falls.find(f => f.fid === fid) ?? null;
    const lostTo = new Map(), took = new Map();
    for (const s of F.seizes) {
      if (s.from === fid && s.to !== fid) lostTo.set(s.to, (lostTo.get(s.to) ?? 0) + 1);
      if (s.to === fid && s.from && s.from !== fid) took.set(s.from, (took.get(s.from) ?? 0) + 1);
    }
    const battles = (D.battles ?? []).filter(b => (b.lossesByFaction ?? []).some(x => x.factionId === fid))
      .map(b => ({ b, lost: (b.lossesByFaction.find(x => x.factionId === fid)?.shipsLost ?? 0) }))
      .sort((a, b) => (b.b.shipsLost ?? 0) - (a.b.shipsLost ?? 0));
    const r30 = rankAt(fid, fracT(0.3)), r50 = rankAt(fid, fracT(0.5));
    const won = F.winner === fid;
    const drop = peak > 0 ? Math.max(0, peak - final) / peak : 0;
    const rise = Math.max(0, final - heldAt(fid, fracT(0.3))) / Math.max(1, ...ids.map(g => H(g)[h.length - 1] ?? 0));
    // DRAMA: how much happened TO this empire. The protagonist is the
    // empire with the most of it, not the winner by default.
    const drama =
      2.0 * (peakShare >= 0.15 ? drop : drop * 0.4)
      + 1.5 * (won && r30 >= 2 ? Math.min(1, rise * 1.5) : 0)
      + 1.0 * Math.min(1, new Set(on.map(w => w.a)).size / 3)
      + 0.8 * Math.min(1, laws.length / 2)
      + 0.8 * Math.min(1, (F.betrayedBy.get(fid) ?? 0) / 2)
      + 0.6 * (won ? 1 : 0)
      + 0.5 * (fall && F.leadShare(fid) >= 0.2 ? 1 : 0)
      + 0.4 * Math.min(1, (battles[0]?.lost ?? 0) / biggest)
      + 0.3 * Math.min(1, F.leadShare(fid) * 2);
    M.set(fid, {
      fid, e, won, place: e.place, peak, peakShare, peakT: ticks[peakI] ?? F.start, final, drop, rise,
      ledShare: F.leadShare(fid), r30, r50, on, pile, laws, fall, lostTo, took, battles,
      betrayedBy: F.betrayals.filter(b => b.b === fid), betrayals: F.betrayals.filter(b => b.a === fid),
      warsBy: F.wars.filter(w => w.a === fid), drama,
    });
  }

  // Who fought on the same side: defence pacts, and wars on the same enemy
  // at the same time; never two empires that were ever at war.
  const enemies = new Set(F.wars.map(w => pairKey(w.a, w.b)));
  const side = new Map();
  const bumpSide = (a, b, n) => { if (a !== b && !enemies.has(pairKey(a, b))) side.set(pairKey(a, b), (side.get(pairKey(a, b)) ?? 0) + n); };
  for (const r of D.chronicle) if (r.kind === 'treaty_signed' && r.p?.kind === 'defense_pact' && F.byId.has(r.a) && F.byId.has(r.b)) bumpSide(r.a, r.b, 2);
  for (const x of F.wars) for (const y of F.wars) {
    if (x !== y && x.b === y.b && x.a < y.a && Math.abs(x.t - y.t) <= W) bumpSide(x.a, y.a, 1);
  }
  return { M, reigns, rankAt, heldAt, fracT, W, side, biggest, ids };
}

// ---------------------------------------------------------------------------
// ANCHORS: real events the film can find
// ---------------------------------------------------------------------------

/** An act's event. `kind` is the film's beat kind (a chronicle kind) or
 *  'battle' (a fight, found by its world) or 'lead' (a change of leader,
 *  shown on the new leader's home). */
const at = (kind, t, fid, target = null, extra = {}) => ({ kind, t, fid, target, ...extra });

function battleBetween(F, a, b, after = -Infinity) {
  return (F.D.battles ?? [])
    .filter(x => (x.startedTick ?? 0) >= after && (x.lossesByFaction ?? []).some(l => l.factionId === a)
      && (!b || (x.lossesByFaction ?? []).some(l => l.factionId === b)))
    .sort((x, y) => (y.shipsLost ?? 0) - (x.shipsLost ?? 0))[0] ?? null;
}
const battleAnchor = (bt, fid, target) => bt
  ? at('battle', bt.startedTick, fid, target, { world: bt.bodyName, lost: bt.shipsLost ?? 0,
    losses: (bt.lossesByFaction ?? []).slice(0, 3).map(l => ({ fid: l.factionId, n: l.shipsLost })) })
  : null;

/** The worlds an empire took from another, as one event: the first of them. */
function seizure(F, to, from, after = -Infinity) {
  const s = F.seizes.filter(x => x.to === to && x.from === from && x.t >= after);
  return s.length ? at('settlement_seized', s[0].t, to, from, { world: s[0].world, n: s.length }) : null;
}

// ---------------------------------------------------------------------------
// THE ARCS
// ---------------------------------------------------------------------------

const top = (list, key) => [...list].sort((a, b) => key(b) - key(a))[0] ?? null;

/**
 * Each arc: fit(F, X) -> null, or { score, cast, acts }.
 *   cast   { protagonist, nemesis?, ringleader?, heir?, turncoat?, rebel? }
 *   acts   [{ key, anchor }] in story order; anchors may be null (dropped)
 *   min    the fewest acts the arc can be told in
 */
export const ARCS = {
  // THE TALL POPPY: the empire that got too big too early, and everyone
  // turned on it at once.
  tallPoppy: {
    min: 3,
    fit(F, X) {
      const cands = [...X.M.values()].filter(m => !m.won && m.peak >= 5 && m.peakShare >= 0.2
        && m.ledShare >= 0.15 && (m.pile || m.laws.length || new Set(m.on.map(w => w.a)).size >= 2)
        && (m.fall || m.drop >= 0.4));
      const P = top(cands, m => m.drama);
      if (!P) return null;
      const firstWar = P.on[0] ?? null;
      const law = P.laws[0] ?? null;
      const ringleader = (P.pile?.wars[0]?.a) ?? firstWar?.a ?? law?.proposer ?? null;
      const nemesis = top([...P.lostTo.entries()].map(([f, n]) => ({ f, n })), x => x.n)?.f
        ?? battleBetween(F, P.fid)?.lossesByFaction?.find(l => l.factionId !== P.fid)?.factionId ?? ringleader;
      const rise = X.reigns.find(r => r.fid === P.fid);
      const piled = P.pile ? P.pile.wars.find(w => w.a !== ringleader) ?? P.pile.wars[1] : null;
      const pileAnchor = law && (!piled || law.t <= piled.t + X.W)
        ? at('senate_vote', law.t, law.proposer, P.fid, { bill: law.title })
        : piled ? at('war_declared', piled.t, piled.a, P.fid, { n: P.pile.by.length }) : null;
      // THE FALL comes after the pile-on: its elimination, else the worst
      // fight it lost after, else a world taken from it after, else the day
      // the lead went to someone else (Smiley Face lost ten worlds without
      // a battle on the record).
      const after = pileAnchor?.t ?? rise?.t ?? -Infinity;
      const lossBattle = (F.D.battles ?? []).filter(b => (b.startedTick ?? 0) >= after
        && (b.lossesByFaction.find(l => l.factionId === P.fid)?.shipsLost ?? 0) >= 5)
        .sort((a, b) => (b.lossesByFaction.find(l => l.factionId === P.fid)?.shipsLost ?? 0) - (a.lossesByFaction.find(l => l.factionId === P.fid)?.shipsLost ?? 0))[0];
      const taken = F.seizes.find(s => s.from === P.fid && s.t >= after);
      const burned = F.D.chronicle.find(r => r.kind === 'settlement_destroyed' && r.a === P.fid && r.t >= after
        && r.p?.killer_faction_id && r.p.killer_faction_id !== P.fid);
      const lostLead = X.reigns.find(r => r.t >= after && r.fid !== P.fid);
      const fallAnchor = P.fall ? at('faction_eliminated', P.fall.t, P.fid, P.fall.killer)
        : lossBattle ? battleAnchor(lossBattle, P.fid, lossBattle.lossesByFaction.find(l => l.factionId !== P.fid)?.factionId ?? null)
          : taken ? at('settlement_seized', taken.t, taken.to, P.fid, { world: taken.world })
            : burned ? at('settlement_destroyed', burned.t, P.fid, burned.p.killer_faction_id, { world: burned.p?.body_name ?? '' })
              : lostLead ? at('lead', lostLead.t, lostLead.fid, P.fid, { drop: Math.round(P.drop * 100) }) : null;
      // THE WOUND: the worst fight it lost before the knives came out
      // (MEGA: the Wu Tang Clan lost 82 ships at Mercury before the Senate
      // voted war on it).
      const worst = P.battles.find(x => x.lost >= Math.max(5, 0.3 * X.biggest)
        && (x.b.startedTick ?? 0) > (rise?.t ?? -Infinity) && (x.b.startedTick ?? 0) < after);
      const acts = [
        { key: 'rise', anchor: rise ? at('lead', rise.t, P.fid) : null },
        { key: 'wound', anchor: worst ? battleAnchor(worst.b, P.fid, worst.b.lossesByFaction.find(l => l.factionId !== P.fid)?.factionId ?? null) : null },
        { key: 'firstStone', anchor: firstWar && firstWar.t < (pileAnchor?.t ?? Infinity) ? at('war_declared', firstWar.t, firstWar.a, P.fid) : null },
        { key: 'pileOn', rank: 3, anchor: pileAnchor },
        { key: 'fall', rank: 4, anchor: fallAnchor },
      ];
      return {
        score: 1.1 + P.drama * 0.5 + (P.pile ? 0.4 : 0) + (P.laws.length ? 0.3 : 0) + P.drop * 0.5,
        cast: { protagonist: P.fid, ringleader, nemesis: nemesis !== ringleader ? nemesis : null, heir: F.winner !== P.fid ? F.winner : null },
        acts,
      };
    },
  },

  // THE SIEGE: everyone came for one empire, and it was still there at the
  // end, holding the crown.
  siege: {
    min: 3,
    fit(F, X) {
      const P = X.M.get(F.winner);
      if (!P) return null;
      const declarers = new Set(P.on.map(w => w.a));
      // Two who came for it and one who broke its word to do it is a siege
      // too (Accretion: both Trousers, one of them a pact-breaker).
      if (!(P.pile || P.laws.length || declarers.size >= 3 || (declarers.size >= 2 && P.betrayedBy.length))) return null;
      const gang = P.pile?.wars ?? P.on;
      const ringleader = gang[0]?.a ?? P.laws[0]?.proposer ?? null;
      const knife = P.betrayedBy[0] ?? null;
      const turncoat = knife?.a ?? null;
      const sphere = F.dysonStart?.a === P.fid && F.dysonStart.t <= (gang[0]?.t ?? Infinity) + X.W ? F.dysonStart : null;
      const lead = X.reigns.find(r => r.fid === P.fid && r.t <= (gang[0]?.t ?? Infinity));
      const siegeBattle = battleBetween(F, P.fid, null, gang[0]?.t ?? -Infinity);
      const nemesis = top([...F.rivalry.entries()].filter(([k]) => k.split('|').includes(P.fid)), ([, n]) => n)?.[0]
        .split('|').find(f => f !== P.fid) ?? ringleader;
      // The Sphere begun AFTER they came is defiance, not the reason.
      const acts = [
        { key: sphere && gang[0] && sphere.t > gang[0].t ? 'defiance' : 'target',
          anchor: sphere ? at('dyson_initiated', sphere.t, P.fid) : lead ? at('lead', lead.t, P.fid) : null },
        { key: 'gang', rank: 2, anchor: gang[0] ? at('war_declared', gang[0].t, gang[0].a, P.fid, { n: declarers.size }) : null },
        // The knife outranks the gang when they land days apart, and carries
        // the gang in its evidence line ("Four empires against one, and one
        // of them was a friend").
        { key: 'knife', rank: 3, anchor: knife ? at('war_declared', knife.t, knife.a, P.fid, { broke: true, n: declarers.size })
          : P.laws[0] ? at('senate_vote', P.laws[0].t, P.laws[0].proposer, P.fid, { bill: P.laws[0].title }) : null },
        { key: 'siege', anchor: battleAnchor(siegeBattle, P.fid, siegeBattle?.lossesByFaction?.find(l => l.factionId !== P.fid)?.factionId ?? null) },
      ];
      return {
        score: 1.2 + Math.min(1, declarers.size / 4) + (P.laws.length ? 0.4 : 0) + (P.betrayedBy.length ? 0.3 : 0),
        cast: { protagonist: P.fid, ringleader, turncoat, nemesis },
        acts,
      };
    },
  },

  // THE USURPER: second for most of the match, first at the end, and the
  // fight where it changed.
  usurper: {
    min: 2,
    fit(F, X) {
      const P = X.M.get(F.winner);
      if (!P || P.r30 < 2) return null;
      const take = [...X.reigns].reverse().find(r => r.fid === P.fid);
      const before = X.reigns.filter(r => take && r.t < take.t && r.fid !== P.fid);
      const kingR = before[before.length - 1];
      if (!take || !kingR) return null;
      const K = X.M.get(kingR.fid);
      if (!K || K.ledShare < 0.25) return null;
      const turn = battleBetween(F, P.fid, K.fid, kingR.t);
      // Its first move from the shadow: a war or a world taken before the turn.
      const turnT = turn?.startedTick ?? take.t;
      const firstMove = P.warsBy.find(w => w.t > kingR.t && w.t < turnT) ?? null;
      const firstTake = F.seizes.find(s => s.to === P.fid && s.t > kingR.t && s.t < turnT) ?? null;
      const acts = [
        { key: 'king', anchor: at('lead', kingR.t, K.fid) },
        { key: 'shadow', anchor: firstMove ? at('war_declared', firstMove.t, P.fid, firstMove.b)
          : firstTake ? at('settlement_seized', firstTake.t, P.fid, firstTake.from, { world: firstTake.world }) : null },
        { key: 'turn', anchor: turn ? battleAnchor(turn, P.fid, K.fid) : at('lead', take.t, P.fid, K.fid) },
      ];
      return {
        score: 0.9 + K.ledShare + Math.min(1, P.rise * 1.5) * 0.5,
        cast: { protagonist: P.fid, nemesis: K.fid },
        acts,
      };
    },
  },

  // THE DUEL: two empires trading the lead, again and again.
  duel: {
    min: 3,
    fit(F, X) {
      const pairs = new Map();
      for (let i = 1; i < X.reigns.length; i++) {
        const k = pairKey(X.reigns[i - 1].fid, X.reigns[i].fid);
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
      const best = top([...pairs.entries()], ([, n]) => n);
      if (!best || best[1] < 3) return null;
      const [a, b] = best[0].split('|');
      const A = X.M.get(a), B = X.M.get(b);
      if (!A || !B || A.peakShare < 0.2 || B.peakShare < 0.2) return null;
      const [P, N] = A.drama >= B.drama ? [A, B] : [B, A];
      const swaps = X.reigns.filter(r => r.fid === a || r.fid === b);
      const blood = battleBetween(F, P.fid, N.fid);
      const last = swaps[swaps.length - 1];
      const acts = [
        { key: 'first', anchor: swaps[0] ? at('lead', swaps[0].t, swaps[0].fid) : null },
        { key: 'answer', anchor: swaps[1] ? at('lead', swaps[1].t, swaps[1].fid, swaps[0].fid) : null },
        { key: 'blood', anchor: blood ? battleAnchor(blood, P.fid, N.fid) : null },
        { key: 'decider', anchor: last && last !== swaps[1] ? at('lead', last.t, last.fid, last.fid === P.fid ? N.fid : P.fid, { n: best[1] }) : null },
      ];
      return {
        score: 0.8 + 0.12 * best[1] + (blood ? 0.2 : 0),
        cast: { protagonist: P.fid, nemesis: N.fid, heir: F.winner && F.winner !== P.fid && F.winner !== N.fid ? F.winner : null },
        acts,
      };
    },
  },

  // THE REBELLION: one empire ate the system, and the story is the one that
  // fought it (the most dramatic empire is never the juggernaut: nothing
  // happened TO it). The juggernaut is the Empire, the rebel the hero.
  rebellion: {
    min: 3,
    fit(F, X) {
      const E = X.M.get(F.winner);
      if (!E || E.ledShare < 0.7) return null;
      const felled = F.falls.filter(f => f.killer === E.fid);
      const finalShare = E.final / Math.max(1, [...X.M.values()].reduce((a, m) => a + m.final, 0));
      if (felled.length < 2 && finalShare < 0.5) return null;
      const touched = (m) => m.warsBy.some(w => w.b === E.fid) || E.warsBy.some(w => w.b === m.fid)
        || (m.lostTo.get(E.fid) ?? 0) > 0 || (m.took.get(E.fid) ?? 0) > 0 || !!battleBetween(F, m.fid, E.fid);
      // The rebel lasted: the one who held out longest counts for as much as
      // the one who suffered most.
      const R = top([...X.M.values()].filter(m => m.fid !== E.fid && touched(m)), m =>
        m.drama + (m.warsBy.some(w => w.b === E.fid) ? 0.5 : 0) + (m.fall ? 1.2 * (m.fall.t - F.start) / F.span : 1.5));
      if (!R) return null;
      const firstBlow = E.warsBy[0] ?? null;
      const stand = R.warsBy.find(w => w.b === E.fid) ?? E.warsBy.find(w => w.b === R.fid) ?? null;
      const rbattle = battleBetween(F, R.fid, E.fid);
      // Another empire falling to it while the rebel still stands.
      const firstFall = felled.find(f => f.fid !== R.fid && (!R.fall || f.t < R.fall.t)) ?? null;
      const acts = [
        { key: 'wakes', anchor: firstBlow ? at('war_declared', firstBlow.t, E.fid, firstBlow.b) : null },
        { key: firstFall && firstFall === felled[0] ? 'firstFall' : 'anotherFalls', anchor: firstFall ? at('faction_eliminated', firstFall.t, firstFall.fid, E.fid) : null },
        { key: 'stand', anchor: rbattle ? battleAnchor(rbattle, R.fid, E.fid)
          : stand ? at('war_declared', stand.t, stand.a, stand.b) : null },
        { key: R.fall ? 'rebelFalls' : 'holdout', anchor: R.fall ? at('faction_eliminated', R.fall.t, R.fid, R.fall.killer)
          : (() => { const s = F.seizes.filter(x => x.to === E.fid && x.from === R.fid); return s.length ? at('settlement_seized', s[s.length - 1].t, E.fid, R.fid, { world: s[s.length - 1].world }) : null; })() },
      ];
      return {
        score: 0.7 + E.ledShare * 0.4 + Math.min(0.6, felled.length * 0.15),
        cast: { protagonist: R.fid, nemesis: E.fid },
        acts,
      };
    },
  },

  // MUSICAL THRONES: everyone had a turn at the top.
  thrones: {
    min: 3,
    fit(F, X) {
      const leaders = new Set(X.reigns.map(r => r.fid));
      if (X.reigns.length < 4 || leaders.size < 3) return null;
      // The most dramatic of the empires that wore the crown.
      const P = top([...X.M.values()].filter(m => leaders.has(m.fid) || m.won), m => m.drama);
      if (!P) return null;
      // The first reign and the last, the protagonist's own, and what was
      // done to it: the pile-on, the Senate.
      const ext = { n: X.reigns.length, k: leaders.size };
      const mine = X.reigns.find(r => r.fid === P.fid);
      const last = X.reigns[X.reigns.length - 1];
      const law = P.laws[0] ?? null;
      const piledOn = P.pile ? P.pile.wars.find(w => w.a !== P.pile.wars[0].a) ?? P.pile.wars[0] : null;
      const acts = [
        { key: 'firstReign', anchor: X.reigns[0] !== mine ? at('lead', X.reigns[0].t, X.reigns[0].fid, null, ext) : null },
        { key: 'myReign', anchor: mine ? at('lead', mine.t, P.fid, null, ext) : null },
        { key: 'pileOn', anchor: piledOn ? at('war_declared', piledOn.t, piledOn.a, P.fid, { n: P.pile.by.length }) : null },
        { key: 'senate', anchor: law ? at('senate_vote', law.t, law.proposer, P.fid, { bill: law.title }) : null },
        { key: 'lastReign', anchor: last && last !== mine && last !== X.reigns[0] ? at('lead', last.t, last.fid, null, ext) : null },
      ];
      const ringleader = P.pile?.wars[0]?.a ?? law?.proposer ?? null;
      return {
        score: 0.6 + 0.07 * X.reigns.length + 0.1 * leaders.size,
        cast: { protagonist: P.fid, ringleader, heir: F.winner && F.winner !== P.fid ? F.winner : null },
        acts,
      };
    },
  },

  // THE LONG WAR: always there. The most dramatic empire's own story, told
  // through its biggest moments.
  longWar: {
    min: 1,
    fit(F, X) {
      const P = top([...X.M.values()], m => m.drama);
      if (!P) return null;
      const war = P.on[0] ?? P.warsBy[0] ?? null;
      const bt = P.battles[0]?.b ?? null;
      const acts = [
        { key: 'opening', anchor: war ? at('war_declared', war.t, war.a, war.b) : null },
        { key: 'battle', anchor: bt ? battleAnchor(bt, P.fid, bt.lossesByFaction.find(l => l.factionId !== P.fid)?.factionId ?? null) : null },
        { key: 'ending', anchor: P.fall ? at('faction_eliminated', P.fall.t, P.fid, P.fall.killer) : null },
      ];
      const nemesis = top([...F.rivalry.entries()].filter(([k]) => k.split('|').includes(P.fid)), ([, n]) => n)?.[0]
        .split('|').find(f => f !== P.fid) ?? null;
      return { score: 0.3, cast: { protagonist: P.fid, nemesis }, acts };
    },
  },
};

// ---------------------------------------------------------------------------
// CHOOSE, CAST, ACT
// ---------------------------------------------------------------------------

/** The arc this match is told as, its cast and its acts. */
export function arcOf(F) {
  const X = measure(F);
  const maxDrama = Math.max(0.01, ...[...X.M.values()].map(m => m.drama));
  const fits = [];
  for (const [key, A] of Object.entries(ARCS)) {
    const r = A.fit(F, X);
    if (!r) continue;
    // Acts with no event are dropped, two acts on one event are one, and
    // the acts play in the order they happened.
    const seen = new Set();
    const sorted = r.acts.filter(a => a.anchor && Number.isFinite(a.anchor.t))
      .filter(a => { const k = `${a.anchor.kind}:${a.anchor.t}:${a.anchor.fid}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.anchor.t - b.anchor.t);
    // Two acts days apart are one scene on film (each takes about three
    // days of the match): the stronger act keeps the moment (`rank`, the
    // earlier on a tie). A fight is a window of its own and is exempt.
    const acts = [];
    for (const a of sorted) {
      const prev = [...acts].reverse().find(x => x.anchor.kind !== 'battle');
      if (a.anchor.kind !== 'battle' && prev && a.anchor.t - prev.anchor.t < ACT_GAP) {
        if ((a.rank ?? 1) > (prev.rank ?? 1)) acts.splice(acts.indexOf(prev), 1, a);
        continue;
      }
      acts.push(a);
    }
    if (acts.length < A.min) continue;
    // The story whose protagonist has the most happen to it is preferred
    // (Lorne, 2026-10-25: the protagonist is the most dramatic empire).
    const pd = (X.M.get(r.cast.protagonist)?.drama ?? 0) / maxDrama;
    fits.push({ key, ...r, acts, score: r.score + 0.05 * acts.length + 0.6 * pd });
  }
  fits.sort((a, b) => b.score - a.score);
  // A match with nothing in its record (no war, no fight, no fall) still
  // gets a film: the long war with no acts, following the winner.
  const quiet = top([...X.M.values()], m => (m.won ? 10 : 0) + m.drama + m.final / 100);
  const arc = fits[0] ?? { key: 'longWar', score: 0, cast: { protagonist: quiet?.fid ?? F.empires[0]?.id ?? null }, acts: [] };
  return { X, arc, considered: fits.map(f => ({ key: f.key, score: Math.round(f.score * 100) / 100 })) };
}

/**
 * Every empire's part, relative to the protagonist. Arc parts first (the
 * protagonist, its nemesis, the ringleader...), then the supporting parts
 * the record earns, then the fallback (fallen, ghost, contender).
 */
export function partsOf(F, X, arc) {
  const part = new Map();
  const why = new Map();
  const P = arc.cast.protagonist;
  const set = (fid, p, ev) => { if (fid && F.byId.has(fid) && !part.has(fid)) { part.set(fid, p); why.set(fid, ev ?? {}); } };
  set(P, `lead:${arc.key}`, {});
  set(arc.cast.nemesis, 'nemesis', {});
  // The winner, when the story is someone else's: the finale crowns it, so
  // it is the heir whatever else it did (MEGA's ringleader won).
  set(F.winner, 'heir', {});
  set(arc.cast.ringleader, 'ringleader', {});
  set(arc.cast.turncoat, 'turncoat', {});
  set(arc.cast.rebel, 'rebel', {});
  // Supporting parts, each to the empire with the strongest record; one of
  // each, but turncoats can come in pairs.
  const rest = () => F.empires.filter(e => !part.has(e.id)).map(e => X.M.get(e.id));
  const taken = () => new Set(part.values());
  const pick = (p, score) => {
    if (p !== 'turncoat' && taken().has(p)) return;
    const best = top(rest().map(m => ({ m, s: score(m) })).filter(x => x.s > 0), x => x.s);
    if (best) set(best.m.fid, p, {});
  };
  pick('turncoat', m => m.betrayals.length >= 1 ? m.betrayals.length + (m.betrayals.some(b => b.b === P) ? 2 : 0) : 0);
  pick('lieutenant', m => X.side.get(pairKey(m.fid, P)) ?? 0);
  pick('ringleader', m => { const pl = X.M.get(P)?.pile; return pl && pl.by.includes(m.fid) ? 1 : 0; });
  pick('monsterSlayer', m => (F.beastSlayer === m.fid ? 1 : 0));
  pick('scavenger', m => {
    let n = 0;
    for (const f of F.falls) n += m.took.get(f.fid) ?? 0;
    return n >= 2 ? n : 0;
  });
  pick('martyr', m => (F.falls[0]?.fid === m.fid ? 1 : 0));
  pick('kingmaker', m => (F.winner ? (X.side.get(pairKey(m.fid, F.winner)) ?? 0) : 0));
  for (const m of rest()) {
    if (m.fall) set(m.fid, 'fallen', {});
    else if (!m.on.length && !m.warsBy.length) set(m.fid, 'ghost', {});
    else set(m.fid, 'contender', {});
  }
  return part;
}
