// ============================================================
// The battle recap's story, out of its record. Pure, so it is tested
// without a canvas: how long each tick plays, who is still standing,
// who killed whom, and who flew best.
//
// The record is the battle detail the recap page already loads
// (/api/recap/<token>): participants with their fates and captains, and a
// frame for every tick with fire in it, holding its exact shot log.
// ============================================================

import type { Detail } from './BattleReview';

type Frame = Detail['frames'][number];
type Participant = Detail['participants'][number];

/** Film seconds per tick, for every tick the reel covers. */
export function pacing(
  frames: Frame[], range: { lo: number; hi: number }, battle: { start: number; end: number },
): Map<number, number> {
  const byTick = new Map(frames.map(f => [f.tick, f]));
  // The fight gets a budget that grows with its length but not in step
  // with it: a 55-tick siege should not run four times a 12-tick raid.
  const span = Math.max(1, battle.end - battle.start + 1);
  const budget = Math.min(55, Math.max(24, 18 + span * 0.5));
  const weight = (t: number) => {
    const f = byTick.get(t);
    if (!f || !f.shots) return 0.25;          // a lull inside the fight
    return f.kills ? 2 + Math.min(3, f.kills) * 0.6 : 1;
  };
  let sum = 0;
  for (let t = battle.start; t <= battle.end; t++) sum += weight(t);
  const out = new Map<number, number>();
  for (let t = range.lo; t <= range.hi; t++) {
    if (t < battle.start) out.set(t, 0.7);   // the approach
    else if (t > battle.end) out.set(t, 0.9); // the aftermath, held a beat
    else out.set(t, Math.min(2.6, Math.max(0.2, (budget * weight(t)) / sum)));
  }
  return out;
}

/** Total film seconds, for the clock. */
export const filmSeconds = (rates: Map<number, number>) =>
  [...rates.values()].reduce((a, b) => a + b, 0);

/** Hulls only: settlements are on the roll but are not a fleet. */
const isHull = (p: Participant) => !p.kind || p.kind === 'ship';

export interface Standing {
  factionId: string; name: string; color: string;
  /** Every hull this side brings to the fight, over the whole battle. */
  total: number;
  /** Arrived by this tick and not yet destroyed. */
  alive: number;
  /** Arrived by this tick, destroyed or not. Zero = still on the way. */
  arrived: number;
}

/**
 * Each side's fleet at a tick. Sides are listed from the first frame at
 * their eventual size, ordered by it, so the board never reshuffles as
 * reinforcements land: a late fleet simply fills in.
 */
export function standingsAt(d: Detail, tick: number): Standing[] {
  const per = new Map<string, Standing>();
  for (const p of d.participants) {
    if (!p.faction_id || !isHull(p)) continue;
    let s = per.get(p.faction_id);
    if (!s) {
      const f = d.factions[p.faction_id];
      s = { factionId: p.faction_id, name: f?.name ?? 'Unknown empire', color: f?.color ?? '#8a9fb3', total: 0, alive: 0, arrived: 0 };
      per.set(p.faction_id, s);
    }
    s.total++;
    if (p.first_tick <= tick) s.arrived++;
    if (p.first_tick <= tick && (p.died_tick == null || p.died_tick > tick)) s.alive++;
  }
  return [...per.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export interface Kill {
  tick: number;
  victim: string; victimColor: string; victimFaction: string;
  killer: string | null; captain: string | null; killerColor: string;
  /** A station or city, not a hull. */
  structure: boolean;
}

/** Every kill, in order, named. */
export function kills(d: Detail): Kill[] {
  const byId = new Map(d.participants.map(p => [p.ship_id, p]));
  const colour = (fid: string | null | undefined) => (fid && d.factions[fid]?.color) || '#8a9fb3';
  const out: Kill[] = [];
  const seen = new Set<string>();
  for (const f of d.frames) {
    for (const s of f.shot_log) {
      if (!s.kill || !s.t || seen.has(s.t)) continue;
      seen.add(s.t);
      const v = byId.get(s.t);
      const a = s.a ? byId.get(s.a) : undefined;
      out.push({
        tick: f.tick,
        victim: v?.ship_name || 'a hull',
        victimColor: colour(v?.faction_id),
        victimFaction: (v?.faction_id && d.factions[v.faction_id]?.name) || '',
        killer: a?.ship_name ?? null,
        captain: a?.captain_name ?? null,
        killerColor: colour(a?.faction_id),
        structure: !!v?.kind && v.kind !== 'ship',
      });
    }
  }
  return out;
}

export interface Ace { ship: string; captain: string | null; faction: string; color: string; kills: number }

/** The hull with the most kills (damage breaks ties), if anyone killed. */
export function ace(d: Detail): Ace | null {
  let best: Participant | null = null;
  for (const p of d.participants) {
    if (!p.kills) continue;
    if (!best || p.kills > best.kills || (p.kills === best.kills && p.damage_dealt > best.damage_dealt)) best = p;
  }
  if (!best) return null;
  const f = best.faction_id ? d.factions[best.faction_id] : undefined;
  return { ship: best.ship_name || 'a hull', captain: best.captain_name ?? null,
    faction: f?.name ?? '', color: f?.color ?? '#8a9fb3', kills: best.kills };
}

// ---- the war around it ---------------------------------------------------

/** /api/recap/<token>/context (worker/recapMap.js recapContext). */
export interface RecapContext {
  wars: Array<{ a: string; b: string; declaredBy: string | null; declaredAt: number; origin: string | null }>;
  stake: { capitalOf: string | null; terraformed: boolean; type: string | null;
    yields: { metal: number; credits: number; science: number } } | null;
  series: {
    prev: { token: string; name: string | null; tick: number; lost: number } | null;
    next: { token: string; name: string | null; tick: number; lost: number } | null;
    count: number; index?: number | null;
  };
}

/**
 * Who held a world at a tick, off the reel's own settlements: the empire
 * with the most people there (a city outranks a station of the same size).
 * This is the owner THEN; the database only knows the owner now.
 */
export function holderOf(
  stls: Iterable<{ body: string; fid: string | null; pop: number }>, bodyId: string,
): string | null {
  let best: { fid: string; pop: number } | null = null;
  for (const s of stls) {
    if (s.body !== bodyId || !s.fid) continue;
    const pop = Number(s.pop) || 0;
    if (!best || pop > best.pop) best = { fid: s.fid, pop };
  }
  return best?.fid ?? null;
}

export type Outcome =
  | { kind: 'fell'; to: string; from: string | null }
  | { kind: 'held'; by: string }
  | { kind: 'emptied'; from: string }
  | null;

/** What the battle did to the world. */
export function outcomeOf(before: string | null, after: string | null): Outcome {
  if (after && after !== before) return { kind: 'fell', to: after, from: before };
  if (after && after === before) return { kind: 'held', by: after };
  if (!after && before) return { kind: 'emptied', from: before };
  return null;
}

/** Pairs that were at peace when it began and not by its end: "a|b" keys. */
export function betrayals(pairs: string[] | null | undefined): Array<[string, string]> {
  return (pairs ?? [])
    .map(p => p.split('|'))
    .filter((x): x is [string, string] => x.length === 2 && !!x[0] && !!x[1]);
}

/** Which part of the reel a tick is in. */
export const phaseAt = (tick: number, battle: { start: number; end: number }): 'approach' | 'battle' | 'aftermath' =>
  tick < battle.start ? 'approach' : tick > battle.end ? 'aftermath' : 'battle';
