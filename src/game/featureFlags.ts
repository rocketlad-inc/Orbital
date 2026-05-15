// ============================================================
// Feature flags — toggle pieces of the simulation that aren't
// ready for MVP. Flip back on by changing the constant; keep
// the underlying data model intact so we don't have to re-add
// fields later.
// ============================================================

/**
 * When false:
 *   - Fuel costs are ignored for builds, settlement deploys, and burns
 *   - Fuel is not deducted on departure/arrival burns
 *   - Fuel is hidden from the TopBar resource pills, the BuildPanel
 *     cost rows, the ShipPanel stat rows, and the body/settlement/
 *     fleet/outliner readouts
 *   - Low-fuel alerts are suppressed
 *
 * The `fuel` field on `Ship` and `FactionResources` is kept and still
 * tracked in scenarios — flipping this flag back to `true` restores
 * the full fuel economy immediately.
 */
export const FUEL_ENABLED = false;
