// ============================================================
// Hands an open intercept picker's state to the map painter
// (state/interceptOverlay.ts): rings on what you can catch, the pick
// bracketed with its own course, the meeting at the door for a door pick,
// and the course box while SHOW is on. One hook for the ship panel and the
// group bar, so both draw the same map.
// ============================================================

import { useEffect } from 'react';
import type { Body } from '../types';
import { t } from '../i18n/core';
import { courseBox, type InterceptOption, type Vec } from '../game/interceptOptions';
import { torchTrajectorySamples } from '../render/mapRenderer';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import { setInterceptOverlay, clearInterceptOverlay } from '../state/interceptOverlay';
import { STANDING_RING } from './InterceptPicker';

/** Points along the pick's course from now to where it lands. */
const TARGET_PATH_STEPS = 48;

/** The group's name as the picker shows it. */
const groupName = (o: InterceptOption): string =>
  o.fleet?.name
  ?? (o.members.length > 1 ? t('ship.rv.andMore', { name: o.lead.name, n: o.members.length - 1 }) : o.lead.name);

function targetPath(o: InterceptOption, now: number, bodies: readonly Body[]): Array<{ x: number; y: number }> {
  const tr = o.lead.transit?.currentTransfer;
  if (!tr) return [];
  const samples = torchTrajectorySamples(tr, bodies as Body[]);
  if (!samples || samples.length < 2) return [];
  const t0 = Math.max(now, samples[0].t);
  const t1 = Math.max(t0, o.theirEta);
  const out: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= TARGET_PATH_STEPS; k++) {
    const p = torchPositionFromSamples(samples, t0 + (t1 - t0) * (k / TARGET_PATH_STEPS));
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

export function useInterceptOverlay(
  owner: string,
  active: boolean,
  options: readonly InterceptOption[],
  selectedKey: string | null,
  showing: boolean,
  myPos: Vec | null,
  bodies: readonly Body[],
  now: number,
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
          label: t('map.meetAt', { name: groupName(sel), dest: sel.dest.name, tick: Math.round(sel.theirEta) }),
        }
        : null,
      target: sel
        ? {
          leadId: sel.lead.id,
          label: t('map.target', { name: groupName(sel) }),
          color: STANDING_RING[sel.standing],
          path: targetPath(sel, now, bodies),
        }
        : null,
      focus: showing && sel
        ? courseBox(sel, Number.isFinite(mx) ? { x: mx, y: my } : null, bodies)
        : null,
    });
  // lang: the labels are translated text.
  }, [owner, active, options, selectedKey, showing, mx, my, bodies, now, lang]);
  useEffect(() => () => clearInterceptOverlay(owner), [owner]);
}
