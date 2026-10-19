// ============================================================================
// awardMeta — what the end-of-game page and the profile's trophy case share
// about each award: the glyph, the catalog keys behind its words, and the
// line that names a hull. No component, no markup: AwardGlyph.tsx draws the
// glyph, the two pages choose the layout.
//
// Words never live here. The tables name catalog keys (so nothing freezes a
// language at import) and shipLabel() resolves them at call time.
// ============================================================================

import type { EndingAwardId } from './endingTypes';
import { Key, PluralKey, t, tk } from '../i18n/core';

/** The 24x24 stroke path drawn for each award. */
export const AWARD_GLYPH: Record<EndingAwardId, string> = {
  warmonger: 'M5 19L17 7M14 7h3v3M19 19L7 7M10 7H7v3',
  ace: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 7v10M7 12h10',
  heavy_hitter: 'M12 3l2 6 6 1-5 4 2 6-5-3-5 3 2-6-5-4 6-1z',
  iron_wall: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  last_stand: 'M6 21V4M6 5h11l-3 4 3 4H6',
  instigator: 'M12 3c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z',
  landlord: 'M12 5a7 7 0 100 14 7 7 0 000-14zM3 12c0-2 4-3 9-3s9 1 9 3-4 3-9 3-9-1-9-3z',
  treasurer: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 7v10M9 10h5a1.5 1.5 0 010 3h-4a1.5 1.5 0 000 3h5',
  scholar: 'M4 6c3-1 6-1 8 1 2-2 5-2 8-1v12c-3-1-6-1-8 1-2-2-5-2-8-1zM12 7v12',
  shipwright: 'M12 3l6 14-6-3-6 3zM12 14v7',
  merchant: 'M5 8h13M15 5l3 3-3 3M19 16H6M9 13l-3 3 3 3',
  statesman: 'M3 20h18M5 20V10M9 20V10M15 20V10M19 20V10M3 10l9-6 9 6z',
};

/** The catalog keys behind each award: the words live in the catalog, the
 *  table only names them (so nothing here freezes a language). */
export const AWARD_KEYS: Record<EndingAwardId, { title: Key; blurb: Key; unit: PluralKey }> = {
  warmonger: { title: 'ending.award.warmonger.title', blurb: 'ending.award.warmonger.blurb', unit: 'ending.award.warmonger.unit' },
  ace: { title: 'ending.award.ace.title', blurb: 'ending.award.ace.blurb', unit: 'ending.award.ace.unit' },
  heavy_hitter: { title: 'ending.award.heavy_hitter.title', blurb: 'ending.award.heavy_hitter.blurb', unit: 'ending.award.heavy_hitter.unit' },
  iron_wall: { title: 'ending.award.iron_wall.title', blurb: 'ending.award.iron_wall.blurb', unit: 'ending.award.iron_wall.unit' },
  last_stand: { title: 'ending.award.last_stand.title', blurb: 'ending.award.last_stand.blurb', unit: 'ending.award.last_stand.unit' },
  instigator: { title: 'ending.award.instigator.title', blurb: 'ending.award.instigator.blurb', unit: 'ending.award.instigator.unit' },
  landlord: { title: 'ending.award.landlord.title', blurb: 'ending.award.landlord.blurb', unit: 'ending.award.landlord.unit' },
  treasurer: { title: 'ending.award.treasurer.title', blurb: 'ending.award.treasurer.blurb', unit: 'ending.award.treasurer.unit' },
  scholar: { title: 'ending.award.scholar.title', blurb: 'ending.award.scholar.blurb', unit: 'ending.award.scholar.unit' },
  shipwright: { title: 'ending.award.shipwright.title', blurb: 'ending.award.shipwright.blurb', unit: 'ending.award.shipwright.unit' },
  merchant: { title: 'ending.award.merchant.title', blurb: 'ending.award.merchant.blurb', unit: 'ending.award.merchant.unit' },
  statesman: { title: 'ending.award.statesman.title', blurb: 'ending.award.statesman.blurb', unit: 'ending.award.statesman.unit' },
};

/** "Ariadne, Frigate" (with the captain when there is one): the line that
 *  names the hull behind a hull award. */
export function shipLabel(ship: { name: string; shipClass: string | null; captainName?: string | null }): string {
  const cls = ship.shipClass;
  const className = cls ? tk(`data.ship.${cls}.name`, cls) : t('ending.award.shipUnknown');
  return ship.captainName
    ? t('ending.award.shipCapt', { name: ship.name, class: className, captain: ship.captainName })
    : t('ending.award.ship', { name: ship.name, class: className });
}
