// Can a faction cover what it offers in a trade?
//
// Stockpiles are floats, and spending leaves residue: a science pool
// that should be exactly 0 is stored as -5.7e-14. Compared exactly,
// that faction "could not afford" an offer of 0 science, and the trade
// composer refused every deal it proposed (Lorne, 2026-10-08). Only an
// amount actually offered is checked, and residue is forgiven.
// Mirrored in src/game/tradeAfford.ts (the client cannot import worker
// code); tradeAfford.test.ts holds the two together.
export const AFFORD_EPS = 1e-6;

export function cannotAfford(held, offered) {
  const want = Number(offered) || 0;
  if (want <= 0) return false;
  return (Number(held) || 0) + AFFORD_EPS < want;
}
