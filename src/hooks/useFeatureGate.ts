// ============================================================
// useFeatureGate — "may I use this yet?", for the UI.
//
// The server is the authority on research gating (see the requireFeature
// checks in worker/actions.js). This hook is the courtesy layer: it lets
// panels grey a control out and say WHY, instead of letting the player
// click something that will bounce with a 403.
//
// Every panel must ask through here rather than reading tech levels
// directly, so the client and server can't drift on what "unlocked"
// means — both funnel into the same hasFeature() predicate and the same
// unlock table.
// ============================================================

import { useMemo } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  FeatureId, hasFeature, requirementFor,
} from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';

export interface FeatureGate {
  /** Can the player use this feature right now? */
  has: (feature: FeatureId | undefined) => boolean;
  /**
   * Why a feature is locked, or null when it's available (or ungated).
   * `label` names the unlock, `text` is a ready-to-render one-liner:
   * "Unlocks at Construction 3".
   */
  lockReason: (feature: FeatureId | undefined) => { label: string; text: string } | null;
  /** Is gating on at all for this match? False = grandfathered game. */
  enabled: boolean;
}

// The local player's key into the per-faction maps on GameState. Both
// the MP provider and the panels use this bare literal rather than a
// shared export — matching that convention here on purpose.
const PLAYER_TOKEN = 'player';

export function useFeatureGate(): FeatureGate {
  const { gameState } = useGameContext();
  const levels = gameState.factionTech?.[PLAYER_TOKEN]?.levels;
  const enabled = gameState.gatingEnabled === true;

  return useMemo(() => ({
    enabled,
    has: (feature) => (feature ? hasFeature(feature, levels, enabled) : true),
    lockReason: (feature) => {
      if (!feature) return null;
      if (hasFeature(feature, levels, enabled)) return null;
      const req = requirementFor(feature);
      if (!req) return null;
      const track = TECH_DEFS[req.track]?.name ?? req.track;
      return { label: req.label, text: `Unlocks at ${track} ${req.level}` };
    },
  }), [levels, enabled]);
}
