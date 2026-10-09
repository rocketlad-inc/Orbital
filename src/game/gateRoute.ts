// ============================================================
// WILL THIS LEG GO THROUGH A GATE?
//
// The server's gate autopilot (worker/room.js gateAutopilot) applies a
// gate's discount to a leg as it departs, however it was ordered:
//
//   A. from one end of a gate to its other end: the crossing.
//   B. between Sol and a far system, long enough to matter: re-routed
//      through that system's sun gate.
//
// The client still plans and posts the ORDINARY burn (the leg guard
// would refuse anything faster), so until the leg launches the panel
// would show the long way round: T-156 for a 16-tick crossing. This is
// the mirror that lets the panel say what will actually happen. It
// answers only; the server decides.
//
// KEEP IN SYNC with gateAutopilot in worker/room.js.
// ============================================================

import { Body } from '../types';
import { MegastructureState, gateTransitTicks } from './megastructures';

/** worker/room.js GATE_AUTOPILOT_MIN_LEG. */
export const GATE_AUTOPILOT_MIN_LEG = 20;

export interface GateRoute {
  /** The gate the hull goes through, by its own name ("Centauri Gate"). */
  gateName: string;
  /** True when the leg IS the crossing (rule A); false when the gate is
   *  a waypoint on the way (rule B). */
  crossing: boolean;
  /** Rule A only: the crossing's own length, from the ordinary burn. */
  etaTicks: number | null;
}

/** Hulls that never use a gate (handleGateTransit refuses them). */
const NO_GATE_CLASSES = new Set(['mega_destroyer', 'kaiju']);

export function gateRouteFor(
  bodies: Body[],
  megastructures: Record<string, MegastructureState> | undefined,
  fromId: string | null | undefined,
  toId: string | null | undefined,
  normalTicks: number,
  shipClass?: string,
): GateRoute | null {
  if (!megastructures || !fromId || !toId || fromId === toId) return null;
  if (shipClass && NO_GATE_CLASSES.has(shipClass)) return null;
  const byId = new Map(bodies.map(b => [b.id, b]));
  // Both ends finished: a pair is a door only once its far end is built.
  const open = (m: MegastructureState | undefined): m is MegastructureState =>
    !!m && m.kind === 'warp_gate' && m.status === 'complete' && !!m.partnerBodyId
    && byId.has(m.bodyId) && byId.has(m.partnerBodyId)
    && megastructures?.[m.partnerBodyId]?.status !== 'building';

  // A. The crossing itself.
  const here = megastructures[fromId];
  if (open(here) && here.partnerBodyId === toId) {
    return {
      gateName: byId.get(fromId)?.name ?? fromId,
      crossing: true,
      etaTicks: gateTransitTicks(normalTicks, here.transitFraction),
    };
  }

  // B. Between Sol and a far system, through that system's sun gate.
  if (!(normalTicks >= GATE_AUTOPILOT_MIN_LEG)) return null;
  const within = (id: string, anchor: string): boolean => {
    let cur = byId.get(id);
    for (let hops = 0; cur && hops < 12; hops++) {
      if (cur.id === anchor) return true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };
  for (const m of Object.values(megastructures)) {
    if (!open(m) || m.transitFraction == null) continue;
    // The far end is the one whose parent is itself in orbit (a far
    // barycenter); the Sol end's parent is the Sun.
    const self = byId.get(m.bodyId)!;
    const parent = self.parent ? byId.get(self.parent) : undefined;
    if (!parent || !parent.parent) continue;   // walk each pair once, from its far end
    const solEnd = byId.get(m.partnerBodyId!)!;
    if (within(fromId, parent.id) !== within(toId, parent.id)) {
      // Named by the end the hull goes in at.
      const goingIn = within(fromId, parent.id) ? self : solEnd;
      return { gateName: goingIn.name, crossing: false, etaTicks: null };
    }
  }
  return null;
}
