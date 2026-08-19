// ============================================================
// ShipActivityLog — "who what when where" for one hull.
//
// Reads GET /api/games/:gameId/ships/:shipId/log, which merges four
// sources that already existed (battle_shots, game_transit_shots,
// executed game_ship_nodes, chronicle_entries) into one tick-ordered
// list. See the handler in worker/state.js for the fog rules.
//
// Fetched on demand rather than folded into /state: a ship's history is
// only ever wanted when someone opens this tab, and /state is already
// the slowest thing in the game at 400-950ms. Adding a per-ship join to
// the 1.5s poll would make every player pay for a panel almost nobody
// has open.
// ============================================================

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../multiplayer/api';

export interface ShipLogRow {
  tick: number;
  kind: 'fired' | 'took_fire' | 'burn' | 'event';
  inTransit?: boolean;
  otherShipId?: string;
  otherClass?: string | null;
  hit?: boolean;
  damage?: number | null;
  killed?: boolean;
  closestApproach?: number | null;
  relativeVelocity?: number | null;
  hitChance?: number | null;
  targetBodyId?: string;
  targetBodyName?: string | null;
  event?: string;
  payload?: Record<string, unknown> | null;
}

interface LogResponse {
  ship: { id: string; name: string; shipClass: string; mine: boolean };
  scope: 'full' | 'shared_engagements';
  rows: ShipLogRow[];
}

const dmg = (n: number | null | undefined) =>
  (n == null ? null : Math.round(n * 10) / 10);

/** One line of prose per row. Kept as a function rather than JSX per kind
 *  so every row reads with the same grammar: what happened, to whom, and
 *  what it cost. */
function describe(r: ShipLogRow): { text: string; tone: 'good' | 'bad' | 'plain' } {
  const other = r.otherClass ?? 'contact';
  const transit = r.inTransit ? ' in flight' : '';
  switch (r.kind) {
    case 'fired': {
      if (!r.hit) return { text: `Fired on ${other}${transit} — missed`, tone: 'plain' };
      const d = dmg(r.damage);
      const killed = r.killed ? ' — DESTROYED' : '';
      return {
        text: `Fired on ${other}${transit} — hit${d != null ? ` for ${d}` : ''}${killed}`,
        tone: 'good',
      };
    }
    case 'took_fire': {
      if (!r.hit) return { text: `Under fire from ${other}${transit} — missed`, tone: 'plain' };
      const d = dmg(r.damage);
      return {
        text: `Hit by ${other}${transit}${d != null ? ` for ${d}` : ''}`,
        tone: 'bad',
      };
    }
    case 'burn':
      return { text: `Burned for ${r.targetBodyName ?? 'a new heading'}`, tone: 'plain' };
    case 'event':
    default: {
      const p = (r.payload ?? {}) as Record<string, string | number | null>;
      switch (r.event) {
        case 'ship_built':
          return { text: `Launched from ${p.body_name ?? 'the yard'}`, tone: 'plain' };
        case 'ship_damaged':
          return { text: `Took ${dmg(Number(p.damage)) ?? '?'} damage at ${p.body_name ?? 'station'}`, tone: 'bad' };
        case 'ship_destroyed':
          return {
            text: `Destroyed at ${p.body_name ?? 'station'}`
              + (p.killer_ship_name ? ` by ${p.killer_ship_name}` : ''),
            tone: 'bad',
          };
        case 'captain_lost':
          return { text: `Captain ${p.captain_name ?? ''} lost with the ship`.trim(), tone: 'bad' };
        case 'captain_rescued':
          return { text: `Captain ${p.captain_name ?? ''} pulled from the wreck`.trim(), tone: 'good' };
        default:
          return { text: (r.event ?? 'event').replace(/_/g, ' '), tone: 'plain' };
      }
    }
  }
}

/** Transit shots carry geometry the orbital ones do not — how close it got
 *  and how fast the two were closing. That is the whole character of a
 *  parting shot, so it is surfaced rather than dropped. */
function geometry(r: ShipLogRow): string | null {
  if (r.kind !== 'fired' && r.kind !== 'took_fire') return null;
  const bits: string[] = [];
  if (r.closestApproach != null) bits.push(`${Math.round(r.closestApproach)}u closest`);
  if (r.relativeVelocity != null) bits.push(`Δv ${Math.round(r.relativeVelocity)}`);
  if (r.hitChance != null) bits.push(`${Math.round(r.hitChance * 100)}% odds`);
  return bits.length ? bits.join(' · ') : null;
}

const TONE: Record<string, string> = {
  good: '#6ee7b7',
  bad: '#ff9a9a',
  plain: '#9fb3c8',
};

export const ShipActivityLog: React.FC<{ gameId: string; shipId: string }> = ({ gameId, shipId }) => {
  const [data, setData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await apiFetch<LogResponse>(
        `/api/games/${gameId}/ships/${encodeURIComponent(shipId)}/log`,
      );
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error?.message ?? `Failed (${res.status})`);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [gameId, shipId]);

  if (loading) return <div className="ship-log__note">Reading the log…</div>;
  if (error) return <div className="ship-log__note ship-log__note--bad">{error}</div>;
  if (!data) return null;

  return (
    <div className="ship-log">
      {/* Say WHY a rival's log is thin, rather than letting it read as broken. */}
      {data.scope === 'shared_engagements' && (
        <div className="ship-log__note">
          Not your ship — showing only engagements you were part of.
        </div>
      )}
      {data.rows.length === 0 && (
        <div className="ship-log__note">
          {data.scope === 'full' ? 'Nothing logged yet.' : 'You have never engaged this ship.'}
        </div>
      )}
      {data.rows.map((r, i) => {
        const d = describe(r);
        const geo = geometry(r);
        return (
          <div key={`${r.tick}-${r.kind}-${i}`} className="ship-log__row">
            <span className="ship-log__tick">T+{r.tick}</span>
            <span className="ship-log__what" style={{ color: TONE[d.tone] }}>
              {d.text}
              {geo && <span className="ship-log__geo"> · {geo}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
};
