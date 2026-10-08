// Can a faction cover what it offers in a trade? The client copy of
// worker/tradeAfford.js (see there for why); tradeAfford.test.ts holds
// the two together.
export const AFFORD_EPS = 1e-6;

export function cannotAfford(held: number, offered: number): boolean {
  const want = Number(offered) || 0;
  if (want <= 0) return false;
  return (Number(held) || 0) + AFFORD_EPS < want;
}
