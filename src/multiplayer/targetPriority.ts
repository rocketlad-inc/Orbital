// ============================================================
// Reading a ship's target priority off the /state row.
//
// The server stores the player's ranked order as a JSON list of category
// keys (worker/actions.js TARGET_PRIORITY_KEYS). This parser used to carry
// its own whitelist of five keys; 'capital' was added everywhere else on
// Aug 24 but not here, and since the server writes the FULL list on every
// save, every saved order failed the check and came back as null. The UI
// then showed AUTO, so a fleet's priority looked like it "reset to default
// regardless of your order" (player report) -- while combat was quietly
// using the real order the whole time.
//
// The allowed keys now come from TARGET_PRIORITY_DEFAULT, the same list
// the cards are drawn from, so the two cannot drift apart again.
// ============================================================

import { TARGET_PRIORITY_DEFAULT, type TargetPriorityKey } from '../types';

const KNOWN = new Set<string>(TARGET_PRIORITY_DEFAULT);

/** The player's ranked order from a /state row, or null for AUTO (no
 *  order, unreadable JSON, or a key this client does not know). */
export function parseTargetPriority(raw: unknown): TargetPriorityKey[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length > 0
        && p.every((k: unknown) => typeof k === 'string' && KNOWN.has(k))) {
      return p as TargetPriorityKey[];
    }
  } catch { /* AUTO */ }
  return null;
}
