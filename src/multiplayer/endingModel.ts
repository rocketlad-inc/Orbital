// ============================================================================
// endingModel — the pure logic behind the end-of-game page.
//
// Everything here is plain data in, plain data out: ranks, award cards, the
// verdict, durations, chart geometry. No React, no catalog, no DOM, so it is
// unit-tested against the real fixtures (__fixtures__/ending.*.json) and the
// page (EndingPage.tsx) only decides how it reads and looks.
//
// Words never appear here. The page owns every string so it can translate it;
// this file returns ids, numbers and shapes.
// ============================================================================

import type {
  EndingAward, EndingAwardId, EndingBattle, EndingFaction, EndingPayload,
} from './endingTypes';

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** The viewer's own empire, or null for someone with no empire in the game
 *  (a spectator, or a payload fetched without a seat). */
export function viewerOf(factions: readonly EndingFaction[]): EndingFaction | null {
  return factions.find(f => f.isMe) ?? null;
}

/** Re-point "me" in a payload. The dev preview (/?ending=<id>&as=...) uses it
 *  to look at one finished game from every seat:
 *    'winner'  the winning empire     'none' / 'spectator'  nobody
 *    anything else: an empire's name (case-insensitive) or id.
 *  A name that matches nothing leaves nobody as the viewer. */
export function withViewer(data: EndingPayload, as: string | null | undefined): EndingPayload {
  if (as == null || as === '') return data;
  const key = as.trim().toLowerCase();
  const pick = (f: EndingFaction): boolean => {
    if (key === 'none' || key === 'spectator') return false;
    if (key === 'winner') return f.isWinner;
    return f.name.toLowerCase() === key || f.id.toLowerCase() === key;
  };
  let used = false;
  return {
    ...data,
    factions: data.factions.map(f => {
      const me = !used && pick(f);
      if (me) used = true;
      return me === f.isMe ? f : { ...f, isMe: me };
    }),
  };
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

export interface Rank {
  /** 1 = best. Competition ranking: two empires on 5 are both 1st, the next 3rd. */
  rank: number;
  /** Someone else holds exactly the same value. */
  tied: boolean;
}

/** Where `me` stands among `factions` on a higher-is-better measure. */
export function rankBy(
  factions: readonly EndingFaction[], me: EndingFaction, get: (f: EndingFaction) => number,
): Rank {
  const mine = get(me);
  let better = 0;
  let same = 0;
  for (const f of factions) {
    if (f.id === me.id) continue;
    const v = get(f);
    if (v > mine) better++;
    else if (v === mine) same++;
  }
  return { rank: 1 + better, tied: same > 0 };
}

export type MyStatId = 'holdings' | 'kills' | 'shipsLost' | 'shipsBuilt' | 'trades';

export interface MyStat {
  id: MyStatId;
  value: number;
  /** null where a rank would mean nothing: ships lost (lower is not "better"
   *  in a way the page should crown) and any measure the viewer scored 0 on
   *  (a tied 1st for nothing is noise). */
  rank: Rank | null;
}

/** The five lines of the "Your empire" card, in the order they are shown. */
export function myStats(factions: readonly EndingFaction[], me: EndingFaction): MyStat[] {
  const ranked = (id: MyStatId, get: (f: EndingFaction) => number, always = false): MyStat => {
    const value = get(me);
    return { id, value, rank: always || value > 0 ? rankBy(factions, me, get) : null };
  };
  return [
    ranked('holdings', f => f.final.holdings, true),
    ranked('kills', f => f.totals.kills),
    { id: 'shipsLost', value: me.totals.shipsLost, rank: null },
    ranked('shipsBuilt', f => f.totals.shipsBuilt),
    ranked('trades', f => f.totals.trades),
  ];
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type VerdictKind = 'victory' | 'gameover';

/** VICTORY only for the empire that won; everyone else (eliminated, runner-up,
 *  spectator) reads GAME OVER. */
export function verdictKind(winnerFactionId: string | null, myFactionId: string | null): VerdictKind {
  return winnerFactionId != null && myFactionId != null && winnerFactionId === myFactionId
    ? 'victory' : 'gameover';
}

export type VictoryWay = 'engineering' | 'domination' | 'chancellor' | 'annihilation';

/** The victory types the page has a sentence for; anything else is null and
 *  the page says a plain "won the game". */
export function victoryWay(victoryType: string | null | undefined): VictoryWay | null {
  switch (victoryType) {
    case 'engineering': case 'domination': case 'chancellor': case 'annihilation':
      return victoryType;
    default:
      return null;
  }
}

/** A faction's place among a game's empires is given (ordered, total), but
 *  its standing can also be read off a meta-style list. */
export function survivedTheGame(me: { finalStatus?: string; status?: string } | null | undefined, won: boolean): boolean {
  if (won) return true;
  if (!me) return false;
  return (me.finalStatus ?? me.status) === 'active';
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

export interface DurationParts { unit: 'days' | 'hours' | 'minutes'; n: number }

/** Real time from first tick to the end, as one rounded figure the eyebrow
 *  can say: days from a day and a half up, else hours, else minutes. */
export function durationParts(ms: number | null | undefined): DurationParts | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (ms >= 1.5 * DAY) return { unit: 'days', n: Math.round(ms / DAY) };
  if (ms >= 1.5 * HOUR) return { unit: 'hours', n: Math.round(ms / HOUR) };
  return { unit: 'minutes', n: Math.max(1, Math.round(ms / MIN)) };
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

export type AwardGroup = 'war' | 'empire' | 'society';

export const AWARD_GROUP: Record<EndingAwardId, AwardGroup> = {
  warmonger: 'war', ace: 'war', heavy_hitter: 'war', iron_wall: 'war', last_stand: 'war', instigator: 'war',
  landlord: 'empire', treasurer: 'empire', scholar: 'empire', shipwright: 'empire',
  merchant: 'society', statesman: 'society',
};

export const AWARD_GROUPS: readonly AwardGroup[] = ['war', 'empire', 'society'];

export interface AwardCardModel {
  id: EndingAwardId;
  group: AwardGroup;
  winner: EndingFaction;
  value: number;
  /** The viewer holds this one. */
  mine: boolean;
  ship?: { name: string; shipClass: string | null; captainName: string | null };
  runnerUp?: { faction: EndingFaction; value: number; tied: boolean };
}

/** The cards for the awards in the payload, grouped War / Empire / Society.
 *  Only awards that are in the payload and whose empire we know; only groups
 *  that have a card. Server order (most interesting first) is kept inside a
 *  group. Nothing is invented to fill a gap. */
export function awardGroups(
  awards: readonly EndingAward[], factions: readonly EndingFaction[],
): Array<{ group: AwardGroup; cards: AwardCardModel[] }> {
  const byId = new Map(factions.map(f => [f.id, f] as const));
  const cards: AwardCardModel[] = [];
  for (const a of awards) {
    const group = AWARD_GROUP[a.id];
    const winner = byId.get(a.factionId);
    if (!group || !winner) continue;
    const ru = a.runnerUp ? byId.get(a.runnerUp.factionId) : undefined;
    cards.push({
      id: a.id,
      group,
      winner,
      value: a.value,
      mine: winner.isMe,
      ship: a.ship ? { name: a.ship.name, shipClass: a.ship.shipClass, captainName: a.ship.captainName ?? null } : undefined,
      runnerUp: a.runnerUp && ru ? { faction: ru, value: a.runnerUp.value, tied: a.runnerUp.value === a.value } : undefined,
    });
  }
  return AWARD_GROUPS
    .map(group => ({ group, cards: cards.filter(c => c.group === group) }))
    .filter(g => g.cards.length > 0);
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/** Width of the thin worlds-held bar under each name: share of the leader,
 *  never invisible for an empire that held anything. */
export function holdingsShare(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(3, Math.round((100 * value) / max));
}

// ---------------------------------------------------------------------------
// Battles
// ---------------------------------------------------------------------------

export interface BattleSegment { factionId: string; shipsLost: number; pct: number }

/** The loss split bar: biggest loser first, widths summing to 100. */
export function battleSegments(b: EndingBattle): BattleSegment[] {
  const total = b.lossesByFaction.reduce((s, x) => s + x.shipsLost, 0);
  if (total <= 0) return [];
  return [...b.lossesByFaction]
    .filter(x => x.shipsLost > 0)
    .sort((a, c) => c.shipsLost - a.shipsLost)
    .map(x => ({ factionId: x.factionId, shipsLost: x.shipsLost, pct: (100 * x.shipsLost) / total }));
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type Measure = 'holdings' | 'ships' | 'credits';

export interface ChartLine {
  faction: EndingFaction;
  values: number[];
  /** Last index that is drawn. An empire that fell stops at its elimination
   *  tick instead of crawling along the floor for the rest of the game. */
  cut: number;
  /** The line is the viewer's or the winner's: drawn 3px and on top. */
  emphasis: boolean;
}

/** The first index whose tick has reached `tick`, else the last index. */
export function indexAtOrAfter(ticks: readonly number[], tick: number): number {
  for (let i = 0; i < ticks.length; i++) if (ticks[i] >= tick) return i;
  return Math.max(0, ticks.length - 1);
}

/** One line per empire for a measure, drawn order: the others (worst place
 *  first), then the winner, then the viewer, so the two that matter sit on top. */
export function chartLines(data: EndingPayload, measure: Measure): ChartLine[] {
  const { ticks } = data.series;
  const src = data.series[measure];
  const lines = data.factions.map(faction => {
    const raw = src[faction.id] ?? [];
    const values = ticks.map((_, i) => (Number.isFinite(raw[i]) ? raw[i] : 0));
    const cut = faction.finalStatus === 'eliminated' && faction.eliminatedAtTick != null
      ? indexAtOrAfter(ticks, faction.eliminatedAtTick)
      : Math.max(0, ticks.length - 1);
    return { faction, values, cut, emphasis: faction.isMe || faction.isWinner } as ChartLine;
  });
  const z = (l: ChartLine) => (l.faction.isMe ? 2 : l.faction.isWinner ? 1 : 0);
  return lines.sort((a, b) => z(a) - z(b) || b.faction.place - a.faction.place);
}

/** Round a maximum up to a tidy axis top: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export interface ChartGeom {
  w: number; h: number;
  padL: number; padR: number; padT: number; padB: number;
  top: number;
  ticks: readonly number[];
  x(i: number): number;
  y(v: number): number;
  /** The x of a raw tick number (for elimination crosses). */
  xOfTick(t: number): number;
}

export function chartGeom(
  w: number, h: number, ticks: readonly number[], maxValue: number,
  pad: { l?: number; r?: number; t?: number; b?: number } = {},
): ChartGeom {
  const padL = pad.l ?? 44, padR = pad.r ?? 100, padT = pad.t ?? 14, padB = pad.b ?? 30;
  const top = niceMax(maxValue);
  const x0 = padL, x1 = Math.max(padL + 1, w - padR);
  const t0 = ticks.length ? ticks[0] : 0;
  const t1 = ticks.length ? ticks[ticks.length - 1] : 1;
  const span = Math.max(1, t1 - t0);
  const yBase = h - padB;
  const xOfTick = (t: number) => x0 + ((x1 - x0) * (t - t0)) / span;
  return {
    w, h, padL, padR, padT, padB, top, ticks,
    x: (i: number) => xOfTick(ticks[i] ?? t0),
    xOfTick,
    y: (v: number) => yBase - ((yBase - padT) * v) / top,
  };
}

export const maxOfLines = (lines: readonly ChartLine[]): number =>
  lines.reduce((m, l) => {
    for (let i = 0; i <= l.cut; i++) if (l.values[i] > m) m = l.values[i];
    return m;
  }, 0);

/** SVG path for a line up to its cut. */
export function linePath(line: ChartLine, g: ChartGeom): string {
  let d = '';
  for (let i = 0; i <= line.cut && i < line.values.length; i++) {
    d += `${i ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(line.values[i]).toFixed(1)}`;
  }
  return d;
}

export interface EndLabel {
  factionId: string;
  /** Where the dot sits. */
  x: number; y: number;
  /** Where the text baseline sits, nudged so no two labels overlap. */
  ty: number;
  value: number;
}

/** At most `max` direct end labels: the leaders by final value among the empires
 *  still standing at the end, plus the viewer when they would otherwise be
 *  missing. Sorted top to bottom and pushed apart by `minGap`, then shifted back
 *  up if the stack ran off the bottom of the plot. */
export function endLabels(
  lines: readonly ChartLine[], g: ChartGeom, max = 3, minGap = 14,
): EndLabel[] {
  const standing = lines
    .filter(l => l.faction.finalStatus === 'active')
    .map(l => ({ l, v: l.values[l.cut] ?? 0 }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v || a.l.faction.place - b.l.faction.place);
  const picked = standing.slice(0, max);
  const me = standing.find(x => x.l.faction.isMe);
  // The viewer always gets their label: it takes the last slot when they are
  // not among the leaders.
  if (me && !picked.includes(me) && picked.length > 0) picked[picked.length - 1] = me;
  const out = picked
    .map(x => ({ factionId: x.l.faction.id, x: g.x(x.l.cut), y: g.y(x.v), ty: g.y(x.v) + 4, value: x.v }))
    .sort((a, b) => a.y - b.y || (a.factionId < b.factionId ? -1 : 1));
  // Downward pass: push each label below the one above it.
  let last = -Infinity;
  for (const o of out) {
    o.ty = Math.max(o.y + 4, last + minGap);
    last = o.ty;
  }
  // Upward pass: if the stack ran off the bottom of the plot, pull it back up.
  let ceil = g.h - g.padB + 2;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].ty = Math.min(out[i].ty, ceil);
    ceil = out[i].ty - minGap;
  }
  return out;
}

/** The index of the tick nearest a pixel x inside the plot, or null when the
 *  chart has no points. */
export function nearestIndex(px: number, g: ChartGeom): number | null {
  const n = g.ticks.length;
  if (!n) return null;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(g.x(i) - px);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** `count` indexes spread evenly over `n` points, always including the first
 *  and the last: the columns of the "view as table" fallback. */
export function sampleIndexes(n: number, count: number): number[] {
  if (n <= 0) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(Math.round((k * (n - 1)) / (count - 1)));
  return Array.from(new Set(out));
}

/** The empire that peaked highest on a measure, for the chart's caption. */
export function peakLeader(factions: readonly EndingFaction[], measure: Measure): { faction: EndingFaction; value: number } | null {
  let best: EndingFaction | null = null;
  for (const f of factions) if (!best || f.peak[measure] > best.peak[measure]) best = f;
  return best && best.peak[measure] > 0 ? { faction: best, value: best.peak[measure] } : null;
}

/** Does the payload carry enough per-tick data to draw the charts? */
export function hasSeries(data: EndingPayload): boolean {
  return data.series.ticks.length >= 2;
}

// ---------------------------------------------------------------------------
// The timeline ("How it unfolded")
// ---------------------------------------------------------------------------
//
// buildTimeline turns the payload's pivotal moments into view-model rows. It
// returns catalog KEYS and params, never English: the page calls t()/tn() on
// them, so the same rows read in either language. A param may itself be a
// TextRef (a pact kind, a secret) that the page resolves first.

export type TimelineCategory = 'war' | 'power' | 'pact' | 'wonder' | 'edge';

/** A catalog entry to render. With `n` the key is a plural base (tn); without
 *  it, a plain key (t). Params that are TextRefs are rendered first. */
export interface TextRef {
  key: string;
  n?: number;
  params?: Record<string, string | number | TextRef>;
}

export interface TimelineRow {
  id: string;
  /** The server's kind, kept even when this build has no sentence for it. */
  kind: string;
  category: TimelineCategory;
  /** importance >= 70: a card with a bigger node, not a plain row. */
  big: boolean;
  tick: number;
  /** 1-based day of the game, from the tick length. null when unknown. */
  day: number | null;
  kindLabel: TextRef;
  title: TextRef;
  sub: TextRef | null;
  /** Empires shown as chips under the sentence. */
  who: EndingFaction[];
  /** The viewer's empire is in it (for a battle: it lost hulls in it). */
  mine: boolean;
  bodyName: string | null;
  /** Battle moments with a replay link. */
  clip: { path: string; battleId: string; shots: number; shipsLost: number } | null;
  /** The loss split of a clipped battle, when the payload carries that fight. */
  segments: BattleSegment[];
}

const CATEGORY: Record<string, TimelineCategory> = {
  start: 'edge', first_blood: 'war', war: 'war', pact: 'pact', pact_broken: 'pact', battle: 'war',
  eliminated: 'war', lead: 'power', bill: 'power', chancellor: 'power', megastructure: 'wonder',
  gate: 'wonder', leviathan: 'wonder', discovery: 'wonder', victory: 'power',
};

export const BIG_BEAT = 70;

/** Details the page has a sentence for; anything else falls back to the generic one. */
const PACT_KINDS: Record<string, string> = {
  nap: 'nap', defense_pact: 'defense', defense: 'defense', construction_pact: 'construction',
  construction: 'construction', intel_share: 'intel', intel: 'intel',
};
const BILL_KINDS = new Set(['war_authorization', 'trade_embargo', 'production_sanction', 'reparations']);
const SECRET_KINDS = new Set([
  'ancient_capital', 'portal_to_sun', 'far_gate', 'ancient_city', 'derelict_warship', 'pre_terraformed',
  'free_collector', 'ancient_station', 'ancient_relay', 'ancient_databank', 'resource_cache', 'deep_cache',
]);
const SHIP_KINDS = new Set(['corvette', 'frigate', 'destroyer', 'freighter', 'colony', 'mega_destroyer', 'mobile_foundry']);
const NO_CHIPS = new Set(['victory', 'lead', 'chancellor', 'start']);

const ref = (key: string, params?: TextRef['params'], n?: number): TextRef => ({ key, params, n });

/** Day of the game a tick falls on: 1 for the first 24 real hours. */
export function dayOfTick(tick: number, tickIntervalMs: number | null | undefined): number | null {
  if (!tickIntervalMs || tickIntervalMs <= 0 || !Number.isFinite(tick)) return null;
  return Math.floor((tick * tickIntervalMs) / 86_400_000) + 1;
}

/** The moments as rows, oldest first. Empty when the payload has no usable
 *  timeline (an older cached response): the page then hides the section. A
 *  moment whose actors the payload does not know is skipped, never invented. */
export function buildTimeline(data: EndingPayload): TimelineRow[] {
  const moments = Array.isArray(data.timeline) ? data.timeline : [];
  const byId = new Map(data.factions.map(f => [f.id, f] as const));
  const battleById = new Map((data.battles ?? []).map(b => [b.id, b] as const));
  const interval = data.game?.tickIntervalMs;
  const rows: TimelineRow[] = [];

  for (const m of moments) {
    if (!m || typeof m.kind !== 'string' || !Number.isFinite(m.tick)) continue;
    const ids = Array.isArray(m.factionIds) ? m.factionIds : [];
    const f = (i: number): EndingFaction | null => byId.get(ids[i] ?? '') ?? null;
    const body = m.bodyName && m.bodyName.trim() ? m.bodyName : null;
    const n = typeof m.n === 'number' && Number.isFinite(m.n) ? m.n : null;
    const nm = (x: EndingFaction | null) => (x ? x.name : '');
    let title: TextRef | null = null;
    let sub: TextRef | null = null;
    let who: EndingFaction[] = [];
    let mine = ids.some(id => byId.get(id)?.isMe);
    let segments: BattleSegment[] = [];
    let clip: TimelineRow['clip'] = null;
    let known = true;

    switch (m.kind) {
      case 'start':
        title = ref('ending.tl.start.title');
        sub = n != null && n > 0 ? ref('ending.tl.start.sub', undefined, n) : null;
        mine = false;
        break;
      case 'first_blood': {
        // [killer, victim] when the killer is a known empire, else [victim] alone.
        const two = ids.length > 1;
        const victim = two ? f(1) : f(0);
        const killer = two ? f(0) : null;
        if (!victim) break;
        if (killer) title = body ? ref('ending.tl.firstBlood.killAt', { killer: nm(killer), victim: nm(victim), body }) : ref('ending.tl.firstBlood.kill', { killer: nm(killer), victim: nm(victim) });
        else title = body ? ref('ending.tl.firstBlood.lossAt', { victim: nm(victim), body }) : ref('ending.tl.firstBlood.loss', { victim: nm(victim) });
        sub = m.detail && SHIP_KINDS.has(m.detail) ? ref('ending.tl.firstBlood.sub', { class: ref(`data.ship.${m.detail}.name`) }) : null;
        who = killer ? [killer, victim] : [victim];
        break;
      }
      case 'war':
        if (!f(0) || !f(1)) break;
        title = ref('ending.tl.war.title', { aggressor: nm(f(0)), target: nm(f(1)) });
        who = [f(0) as EndingFaction, f(1) as EndingFaction];
        break;
      case 'pact':
        if (!f(0) || !f(1)) break;
        title = ref('ending.tl.pact.title', { a: nm(f(0)), b: nm(f(1)) });
        sub = ref(`ending.tl.pactKind.${PACT_KINDS[m.detail ?? ''] ?? 'other'}`);
        who = [f(0) as EndingFaction, f(1) as EndingFaction];
        break;
      case 'pact_broken':
        if (!f(0) || !f(1)) break;
        title = ref('ending.tl.pactBroken.title', { breaker: nm(f(0)), betrayed: nm(f(1)) });
        sub = ref('ending.tl.pactBroken.sub', { pact: ref(`ending.tl.pactKind.${PACT_KINDS[m.detail ?? ''] ?? 'other'}`) });
        who = [f(0) as EndingFaction, f(1) as EndingFaction];
        break;
      case 'battle': {
        title = body ? ref('ending.battle.of', { name: body }) : ref('ending.battle.deepSpace');
        const lost = m.clip?.shipsLost ?? n;
        sub = lost != null ? ref('ending.tl.battle.sub', undefined, lost) : null;
        const full = m.clip ? battleById.get(m.clip.battleId) : undefined;
        if (m.clip) {
          clip = { path: m.clip.path, battleId: m.clip.battleId, shots: m.clip.shots, shipsLost: m.clip.shipsLost };
          if (full) segments = battleSegments(full);
        }
        // With the fight's loss split, "you" means you lost hulls in it. A
        // fight the payload carries no split for cannot say.
        mine = full ? full.lossesByFaction.some(x => x.shipsLost > 0 && !!byId.get(x.factionId)?.isMe) : false;
        const chipIds = full ? segments.map(s => s.factionId) : ids;
        who = chipIds.map(id => byId.get(id)).filter((x): x is EndingFaction => !!x);
        break;
      }
      case 'eliminated': {
        // [fallen, taker of the last world if known]; n = the fallen empire's peak worlds.
        const fallen = f(0), taker = f(1);
        if (!fallen) break;
        title = ref('ending.tl.eliminated.title', { fallen: nm(fallen) });
        const peak = n != null && n > 0 ? n : null;
        if (peak != null && taker) sub = ref('ending.tl.eliminated.subTaker', { taker: nm(taker) }, peak);
        else if (peak != null) sub = ref('ending.tl.eliminated.sub', undefined, peak);
        else if (taker) sub = ref('ending.tl.eliminated.taker', { taker: nm(taker) });
        who = taker ? [fallen, taker] : [fallen];
        break;
      }
      case 'lead':
        if (!f(0)) break;
        title = ref('ending.tl.lead.title', { leader: nm(f(0)) });
        sub = n != null && n > 0 ? ref('ending.tl.lead.sub', undefined, n) : null;
        break;
      case 'bill': {
        const kind = BILL_KINDS.has(m.detail ?? '') ? (m.detail as string) : 'other';
        title = ref(`ending.tl.bill.${kind}`);
        if (f(0)) sub = f(1) ? ref('ending.tl.bill.subTarget', { proposer: nm(f(0)), target: nm(f(1)) }) : ref('ending.tl.bill.sub', { proposer: nm(f(0)) });
        who = [f(0), f(1)].filter((x): x is EndingFaction => !!x);
        break;
      }
      case 'chancellor':
        if (!f(0)) break;
        title = ref('ending.tl.chancellor.title', { who: nm(f(0)) });
        break;
      case 'megastructure': {
        // n = build percent; 0 = the foundation was laid.
        const dyson = m.detail === 'dyson_sphere';
        const builder = f(0);
        if (n != null && n > 0) {
          title = ref(dyson ? 'ending.tl.mega.dysonPct' : 'ending.tl.mega.otherPct', { pct: n });
          if (builder) sub = ref('ending.tl.mega.sub', { who: nm(builder) });
        } else if (builder) {
          title = ref(dyson ? 'ending.tl.mega.dysonBegun' : 'ending.tl.mega.otherBegun', { who: nm(builder) });
        }
        break;
      }
      case 'gate':
        if (m.detail === 'first_crossing') {
          if (!f(0)) break;
          title = body ? ref('ending.tl.gate.crossing', { who: nm(f(0)), body }) : ref('ending.tl.gate.crossingBare', { who: nm(f(0)) });
        } else {
          title = body ? ref('ending.tl.gate.opened', { body }) : ref('ending.tl.gate.openedBare');
          sub = ref('ending.tl.gate.sub');
        }
        break;
      case 'leviathan':
        if (m.detail === 'dies') {
          if (!f(0)) break;
          title = ref('ending.tl.leviathan.dies', { who: nm(f(0)) });
          sub = body ? ref('ending.tl.leviathan.diesAt', { body }) : ref('ending.tl.leviathan.diesBare');
        } else if (m.detail === 'strike') {
          title = ref('ending.tl.leviathan.strike');
          sub = body ? ref('ending.tl.leviathan.strikeAt', { body }) : ref('ending.tl.leviathan.strikeBare');
        } else {
          title = ref('ending.tl.leviathan.arrives');
          sub = body ? ref('ending.tl.leviathan.arrivesAt', { body }) : ref('ending.tl.leviathan.arrivesBare');
        }
        break;
      case 'discovery':
        if (!f(0)) break;
        title = ref('ending.tl.discovery.title', {
          who: nm(f(0)),
          secret: ref(`ending.tl.secret.${SECRET_KINDS.has(m.detail ?? '') ? m.detail : 'other'}`),
        });
        sub = body ? ref('ending.tl.discovery.sub', { body }) : null;
        break;
      case 'victory': {
        const w = f(0);
        title = w ? ref('ending.tl.victory.title', { who: nm(w) }) : ref('ending.tl.victory.noWinner');
        const way = victoryWay(m.detail);
        sub = way === 'annihilation' ? ref('ending.verdict.annihilation') : way ? ref(`mp.provider.vl.${way}`) : null;
        break;
      }
      default:
        // A kind this build has never heard of: a plain row, never a crash.
        known = false;
        title = ref('ending.tl.other.title');
    }
    if (!title) continue;   // an actor the payload does not know: skip the row

    rows.push({
      id: String(m.id ?? `${m.kind}-${m.tick}`),
      kind: m.kind,
      category: known ? CATEGORY[m.kind] ?? 'edge' : 'edge',
      big: (m.importance ?? 0) >= BIG_BEAT,
      tick: m.tick,
      day: dayOfTick(m.tick, interval),
      kindLabel: ref(known ? `ending.tl.kind.${m.kind}` : 'ending.tl.kind.other'),
      title, sub,
      who: NO_CHIPS.has(m.kind) ? [] : who,
      mine, bodyName: body, clip, segments,
    });
  }
  return rows;
}

/** The section needs a story to tell: more than two moments. */
export const hasTimeline = (data: EndingPayload): boolean => buildTimeline(data).length > 2;
