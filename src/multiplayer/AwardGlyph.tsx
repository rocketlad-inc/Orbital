// The stroke glyph of an award. Just the <svg>: the caller sizes and colours
// it (stroke is currentColor) and hides it from assistive tech.

import React from 'react';
import type { EndingAwardId } from './endingTypes';
import { AWARD_GLYPH } from './awardMeta';

export function AwardGlyph({ id, className }: { id: EndingAwardId; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className}><path d={AWARD_GLYPH[id]} /></svg>;
}
