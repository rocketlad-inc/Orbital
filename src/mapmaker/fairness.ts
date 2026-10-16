// The fairness lens: who starts nearest to what. Every world with
// something to give goes to the start world nearest it at the opening
// positions (a moon goes with its planet; a start world's own moons are
// its own), and each start's share is totted up. The score is the
// poorest start's share over the richest's: 100% is a mirror match.

import { type CustomMap, bodyPos, startWorlds } from '../game/customMap';

export const LENS_COLORS = [
  '#4ecdc4', '#ffb84d', '#ff6b9d', '#7fd4ff', '#b98cff', '#6ee7b7', '#ff8a5c', '#e8e36b', '#5c8dff', '#d98cff',
];

export interface StartShare {
  id: string; name: string; color: string;
  metal: number; credits: number; science: number; total: number; worlds: number;
}
export interface Fairness {
  /** body id -> the start id it falls to */
  owner: Map<string, string>;
  /** start id -> its lens colour */
  colorOf: Map<string, string>;
  starts: StartShare[];
  /** 0..100 */
  score: number;
}

export function fairness(map: CustomMap): Fairness | null {
  const starts = startWorlds(map).worlds;
  if (starts.length < 2) return null;
  const startIds = new Set(starts.map(s => s.id));
  const at = new Map(starts.map(s => [s.id, bodyPos(map, s)]));
  const colorOf = new Map(starts.map((s, i) => [s.id, LENS_COLORS[i % LENS_COLORS.length]]));
  const share = new Map<string, StartShare>(starts.map(s => [s.id, {
    id: s.id, name: s.name, color: colorOf.get(s.id)!, metal: 0, credits: 0, science: 0, total: 0, worlds: 0,
  }]));
  const owner = new Map<string, string>();
  const nearest = (x: number, y: number) => {
    let best = starts[0].id, bd = Infinity;
    for (const s of starts) {
      const p = at.get(s.id)!;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  };
  for (const b of map.bodies) {
    let who: string;
    if (startIds.has(b.id)) who = b.id;
    else if (b.parent !== 'sun' && startIds.has(b.parent)) who = b.parent;
    else {
      const anchor = b.parent === 'sun' ? b : map.bodies.find(x => x.id === b.parent) ?? b;
      const p = bodyPos(map, anchor);
      who = nearest(p.x, p.y);
    }
    owner.set(b.id, who);
    const s = share.get(who)!;
    if (b.type === 'rock') {
      // Ore in a rock is a one-off haul: count it as a few ticks' yield.
      const v = Math.round((b.mineral?.tons ?? 0) / 400);
      if (b.mineral?.kind === 'gold') s.credits += v; else s.metal += v;
    } else {
      s.metal += b.yields.metal; s.credits += b.yields.credits; s.science += b.yields.science;
    }
    s.worlds++;
  }
  const list = [...share.values()];
  for (const s of list) s.total = s.metal + s.credits + s.science;
  const max = Math.max(...list.map(s => s.total));
  const min = Math.min(...list.map(s => s.total));
  return { owner, colorOf, starts: list, score: max > 0 ? Math.round((min / max) * 100) : 100 };
}
