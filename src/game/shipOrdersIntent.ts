// ============================================================
// Ship panel standing-order patch -> setShipOrders intent.
//
// The panel's patch type grew fields (scheduled detonation, the MINED
// rule, its mine mode) but the forwarding kept a hand-written list of
// the old ones. Setting "WHEN a hostile enters orbit -> DETONATE" or
// MINED changed the panel optimistically, sent ONLY the ship id, and the
// server answered "no order fields supplied" — the order was never saved
// and the error sat in the panel all day (Alante, 2026-09-23).
//
// So: every key the caller put on the patch is forwarded, by
// construction. The one exception is `stance: undefined`, which has
// always meant "leave the stance alone" (forwarding it would reset the
// stance to the default).
// ============================================================

export type ShipOrdersPatch = {
  stance?: 'attack' | 'defensive' | 'hold';
  retreatHpPct?: 25 | 50 | 75 | null;
  retreatBodyId?: string | null;
  arrivalAction?: 'detonate' | 'arrive_defensive' | 'arrive_hold' | null;
  arrivalGuard?: 'hostile_in_orbit' | null;
  detonateAtTick?: number | null;
  detonateAtGuard?: 'hostile_in_orbit' | null;
  detonateOnHostile?: boolean;
  detonateMineMode?: 'hostile' | 'no_friendly' | 'hostile_no_friendly' | null;
  detonateHpPct?: 25 | 50 | null;
  targetPriority?: string[] | null;
};

export function shipOrdersIntent<P extends ShipOrdersPatch>(shipId: string, patch: P): { shipIds: string[] } & P {
  const out: Record<string, unknown> = { shipIds: [shipId] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'stance' && v === undefined) continue;
    out[k] = v === undefined ? null : v;
  }
  return out as { shipIds: string[] } & P;
}
