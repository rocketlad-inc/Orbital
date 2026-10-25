// ============================================================
// tradeLock — may this empire trade yet?
//
// Goods ride freighters, so the Trades and Market panels hold trading
// back until you can field one. "Field" is the word: a freighter you
// already OWN counts, whatever research says. The panels used to ask only
// "can you build one" (hull.freighter, Propulsion 1), so a Play for Free
// trial, which starts with a freighter and no Propulsion, was told "you
// cannot build one yet" beside its own freighter (playtest R2-C5).
//
// Pure, because both panels mount outside GameContextProvider and read
// /me instead (tech_levels, gating_enabled, freighters).
// ============================================================

import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';
import type { MyFaction } from './api';

export function freighterTradeLock(
  me: Pick<MyFaction, 'tech_levels' | 'gating_enabled' | 'freighters'> | null,
): { label: string; where: string } | null {
  if (!me) return null;                                 // still loading: no flash of a lock
  if ((me.freighters ?? 0) > 0) return null;           // one in hand carries trades
  const enabled = (me.gating_enabled ?? 0) === 1;      // absent (old server) means ungated
  if (hasFeature('hull.freighter', me.tech_levels, enabled)) return null;
  const req = requirementFor('hull.freighter');
  if (!req) return null;
  const track = TECH_DEFS[req.track]?.name ?? req.track;
  return { label: req.label, where: `${track} ${req.level}` };
}
