// ============================================================
// Resource display formatting.
//
// Faction pools drift fractional: income is banked as whole units (the
// server CASTs to INTEGER and carries a remainder), but the research
// drain and treaty payouts subtract fractional amounts. Repeated float
// subtraction then leaves values like 181.9399999999999, which the
// FactionPanel was rendering verbatim.
//
// Every pool readout goes through this one helper so the top bar and the
// empire tiles can never disagree about the same number.
// ============================================================

/**
 * Whole-unit display value for a resource pool, rounded UP.
 *
 * Naive Math.ceil is unsafe here: binary float noise lands on both sides
 * of a whole number, so a true 182 stored as 182.0000000001 would ceil to
 * 183. Snap to 3dp first (well past any real precision — the server
 * already rounds research bookkeeping to 3dp) to erase the noise, then
 * ceil. 181.9399999999999 -> 181.94 -> 182; 182.0000000001 -> 182 -> 182.
 */
export function displayResource(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.ceil(Number(value.toFixed(3)));
}
