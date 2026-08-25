// ============================================================
// The match replay's shared core: payload types, the world state
// machine, and the event miner. No renderer in here — the 2D map stage
// and the (kept, optional) 3D stage both import from this, so neither
// drags the other's dependencies into its chunk.
//
// The data is the keyframe+delta stream match_snapshots serves: reset
// the world at a key, upsert/delete at a delta, absent tick = hold.
// ============================================================

import type { ShipIconVariant } from '../components/ShipIcons';

// ---- payloads -----------------------------------------------------------

export interface MatchSummary {
  game: { id: string; name: string | null; status: string;
    winner_faction_id: string | null };
  ticks: { lo: number | null; hi: number | null; rows: number };
  firstLiveTick: number | null;
  factions: Array<{ id: string; name: string; color: string | null;
    color2: string | null }>;
  bodies: Array<{ id: string; name: string | null; type: string;
    color: string | null; radius: number; orbit_radius: number | null;
    orbit_period: number | null; angle0: number | null;
    parent_body_id: string | null; terraformed_at_tick: number | null;
    destroyed_at_tick: number | null }>;
  battles: Array<{ id: string; body_id: string | null;
    started_tick: number; ended_tick: number | null }>;
  /** Hull loadouts, keyed by ship id. Static per hull, so it rides here
   *  rather than in every snapshot row. Drives weapon type (kinetic slug
   *  vs energy lance) and whether a hit flares a shield. */
  parts?: Record<string, string[]>;
  /** The senate's whole history: bills, their windows, and how they fell. */
  senate?: Array<{
    id: string; kind: string; title: string | null; status: string;
    proposer_faction_id: string | null;
    proposed_at_tick: number | null;
    vote_opens_at_tick: number | null;
    vote_closes_at_tick: number | null;
    resolved_at_tick: number | null;
    votes: Array<{ fid: string; vote: string; weight: number }>;
  }>;
}

export interface SnapshotRow {
  t: number; kind: 'key' | 'delta';
  state: { v: number; syn?: number; put: any[][]; del: string[] };
}

/** The stage contract both renderers satisfy. */
export interface ReplayStage {
  setTick(tick: number, frac: number): void;
  render(): void;
  resize(w: number, h: number): void;
  applyRows(rows: SnapshotRow[]): void;
  dispose(): void;
  worldAt(tick: number): MatchWorld;
  /** 'auto' = the director; 'wide' = hold the whole system. Optional. */
  setView?(mode: 'auto' | 'wide'): void;
  /**
   * Seconds of film per tick at this point in the match. The director
   * sets the pace as well as the framing: a heavy battle plays slowly,
   * a quiet stretch is taken at a clip. Stages without a director (the
   * combat recap) simply do not implement it.
   */
  rateAt?(tick: number): number;
}

// ---- the world state machine -------------------------------------------

export interface ShipRow { fid: string | null; cls: string; parent: string | null;
  iv: ShipIconVariant; syn: boolean;
  /** Current hull points. The renderer refuses to draw a corpse firing,
   *  and shield/armour reads scale off it. */
  hp: number | null }
export interface StlRow { body: string; fid: string | null; pop: number }

/**
 * The replay's world, advanced by applying snapshot rows in order.
 * Rebuilding from the nearest keyframe is how scrubbing works, so apply
 * must stay cheap: plain map writes, no allocation beyond the rows.
 */
export class MatchWorld {
  ships = new Map<string, ShipRow>();
  stls = new Map<string, StlRow>();
  stock = new Map<string, number[]>();
  pacts = new Map<string, string[]>();
  synthetic = false;

  clone(): MatchWorld {
    const w = new MatchWorld();
    w.ships = new Map(this.ships); w.stls = new Map(this.stls);
    w.stock = new Map(this.stock); w.pacts = new Map(this.pacts);
    w.synthetic = this.synthetic;
    return w;
  }

  apply(row: SnapshotRow): void {
    if (row.kind === 'key') {
      this.ships.clear(); this.stls.clear();
      this.stock.clear(); this.pacts.clear();
    }
    this.synthetic = !!row.state.syn;
    for (const r of row.state.put) {
      switch (r[0]) {
        case 's':
          // r[11] is hp on a LIVE row: the writer emits
          // [s, id, fid, cls, parent, rp, ra, omega, m0, epoch, dir, hp,
          //  status, iv]. A backfilled row carries nulls from r[5] on --
          // which is also how `syn` is detected -- so hp is null there
          // and consumers must treat that as "unknown", not "dead".
          this.ships.set(r[1], { fid: r[2], cls: r[3], parent: r[4],
            iv: (r[13] ?? 'A') as ShipIconVariant, syn: r[5] == null,
            hp: typeof r[11] === 'number' ? r[11] : null });
          break;
        case 't':
          // ['t', id, body, fid, kind, ?, pop] -- population is r[6].
          this.stls.set(r[1], { body: r[2], fid: r[3], pop: r[6] ?? 0 });
          break;
        case 'f':
          // The row is [metal, FUEL, GOLD, science] -- that is the order
          // the recorder writes. Reading it positionally as
          // metal/gold/fuel/science transposed the middle pair, so the
          // film's "gold" bar was fuel and its "fuel" bar was gold.
          // Fuel is also vestigial: it is zero for every faction in the
          // live game. Stored as the three resources that exist --
          // METAL, CREDITS, SCIENCE.
          this.stock.set(r[1], [r[2], r[4], r[5]]);
          break;
        case 'p':
          this.pacts.set(r[1], r.slice(3));
          break;
        default: break;
      }
    }
    for (const k of row.state.del) {
      const id = k.slice(2);
      if (k[0] === 's') this.ships.delete(id);
      else if (k[0] === 't') this.stls.delete(id);
      else if (k[0] === 'f') this.stock.delete(id);
      else if (k[0] === 'p') this.pacts.delete(id);
    }
  }
}

/**
 * Rows plus keyframe checkpoints, so worldAt(t) replays from the nearest
 * checkpoint rather than from the beginning of the match.
 */
export class MatchTimeline {
  rows: SnapshotRow[] = [];
  private checkpoints = new Map<number, MatchWorld>();

  append(rows: SnapshotRow[]): void {
    for (const r of rows) {
      if (this.rows.length && r.t <= this.rows[this.rows.length - 1].t) continue;
      this.rows.push(r);
    }
  }

  worldAt(tick: number): MatchWorld {
    let base: MatchWorld | null = null; let baseTick = -1;
    for (const [t, w] of this.checkpoints) {
      if (t <= tick && t > baseTick) { base = w; baseTick = t; }
    }
    const w = base ? base.clone() : new MatchWorld();
    for (const r of this.rows) {
      if (r.t <= baseTick || r.t > tick) continue;
      w.apply(r);
      if (r.kind === 'key' && !this.checkpoints.has(r.t)) {
        this.checkpoints.set(r.t, w.clone());
      }
    }
    return w;
  }
}

// ---- events: what the director cuts to ---------------------------------

export interface MatchEvent {
  tick: number; kind: 'battle' | 'loss' | 'founded' | 'fallen' | 'pact';
  bodyId: string | null; weight: number;
  /** Losses at this tick, for the log. */
  count?: number;
}

/** Strip the game prefix: 'g:mars' → 'mars'. Battle rows carry prefixed ids. */
export const bareId = (id: string | null | undefined) =>
  id ? id.split(':').pop()! : '';

/**
 * Mine the beats out of the stream itself. A ship key vanishing is a
 * loss; a settlement appearing is a founding; the battles table names
 * the fights. The director wants moments, and the diff IS the moment.
 */
export function mineEvents(rows: SnapshotRow[], summary: MatchSummary): MatchEvent[] {
  const events: MatchEvent[] = [];
  const shipParent = new Map<string, string | null>();
  const stlBody = new Map<string, string>();
  for (const row of rows) {
    let losses = 0; let lossBody: string | null = null;
    for (const k of row.state.del) {
      if (k[0] === 's') {
        losses++;
        lossBody = shipParent.get(k.slice(2)) ?? lossBody;
        shipParent.delete(k.slice(2));
      } else if (k[0] === 't') {
        const b = stlBody.get(k.slice(2));
        events.push({ tick: row.t, kind: 'fallen', bodyId: b ?? null, weight: 5 });
        stlBody.delete(k.slice(2));
      }
    }
    if (losses > 0) {
      events.push({ tick: row.t, kind: 'loss', bodyId: lossBody,
        weight: Math.min(6, 1 + losses), count: losses });
    }
    for (const r of row.state.put) {
      if (r[0] === 's') shipParent.set(r[1], r[4]);
      if (r[0] === 't') {
        if (!stlBody.has(r[1]) && row.kind !== 'key') {
          events.push({ tick: row.t, kind: 'founded', bodyId: r[2], weight: 3 });
        }
        stlBody.set(r[1], r[2]);
      }
      if (r[0] === 'p' && row.kind !== 'key') {
        events.push({ tick: row.t, kind: 'pact', bodyId: null, weight: 2 });
      }
    }
  }
  for (const b of summary.battles) {
    events.push({ tick: b.started_tick, kind: 'battle',
      bodyId: b.body_id, weight: 8 });
  }
  events.sort((a, b) => a.tick - b.tick || b.weight - a.weight);
  return events;
}
