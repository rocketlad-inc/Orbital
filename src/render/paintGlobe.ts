// A world's real-map globe, painted the way the map paints it
// (mapRenderer drawWorldGlobe): turning on its axis once its surface map
// has loaded, the static sprite until then and in lightweight mode.
//
// For the recaps (BattleReview's battle recap, TheatreRecap's campaign
// view), which draw their own scenes but should wear the game's worlds.
// They call getGlobe() first and keep their procedural painter only for
// worlds with no globe, or while one is still loading.

import type { Body } from '../types';
import { getSpinningGlobe, drawSpinningGlobe } from './globeSpin';
import { isLightweight } from './lightweightMode';

export function paintGlobe(
  g: CanvasRenderingContext2D, body: Body, terraformed: boolean, sprite: HTMLImageElement,
  x: number, y: number, r: number, nowMs: number,
): void {
  const spun = isLightweight() ? null : getSpinningGlobe(body, terraformed, r, nowMs);
  if (spun) drawSpinningGlobe(g, spun, x, y, r);
  else g.drawImage(sprite, x - r, y - r, r * 2, r * 2);
}
