// ============================================================
// Hands an open intercept picker's state to the map painter
// (state/interceptOverlay.ts): rings on what you can catch, the meeting at
// the door for a door pick, and the course box while SHOW is on. One hook
// for the ship panel and the group bar, so both draw the same map.
// ============================================================

import { useEffect } from 'react';
import type { Body } from '../types';
import { t } from '../i18n/core';
import { courseBox, type InterceptOption, type Vec } from '../game/interceptOptions';
import { setInterceptOverlay, clearInterceptOverlay } from '../state/interceptOverlay';
import { STANDING_RING } from './InterceptPicker';

export function useInterceptOverlay(
  owner: string,
  active: boolean,
  options: readonly InterceptOption[],
  selectedKey: string | null,
  showing: boolean,
  myPos: Vec | null,
  bodies: readonly Body[],
  lang: string,
): void {
  const mx = myPos?.x ?? NaN, my = myPos?.y ?? NaN;
  useEffect(() => {
    if (!active) { clearInterceptOverlay(owner); return; }
    const sel = options.find(o => o.key === selectedKey && o.ok) ?? null;
    setInterceptOverlay({
      owner,
      targets: options.filter(o => o.ok).map(o => ({
        leadId: o.lead.id,
        color: STANDING_RING[o.standing],
        selected: o.key === selectedKey,
      })),
      // A match draws its own meeting (the rendezvous preview labels it);
      // a meeting at the door had no mark on the map at all.
      meet: sel && !sel.rv
        ? {
          x: sel.meetPos.x, y: sel.meetPos.y,
          label: t('map.meetAt', { name: sel.fleet?.name ?? sel.lead.name, dest: sel.dest.name, tick: Math.round(sel.theirEta) }),
        }
        : null,
      focus: showing && sel
        ? courseBox(sel, Number.isFinite(mx) ? { x: mx, y: my } : null, bodies)
        : null,
    });
  // lang: the meeting label is translated text.
  }, [owner, active, options, selectedKey, showing, mx, my, bodies, lang]);
  useEffect(() => () => clearInterceptOverlay(owner), [owner]);
}
