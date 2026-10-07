/**
 * "The explosion effects are happening at some other point in the orbit"
 * (Lorne, 2026-10-06). Death FX (destruction flash, wreck, breakup) read
 * drawnShipWorldPos: where the hull was last DRAWN. drawShip records it;
 * escorts are drawn by drawEscortHull and never recorded one, so a dead
 * escort -- most hulls in any fleet -- blew up at its raw orbit point,
 * which the whole-orbit layout does not use.
 */
import fs from 'fs';
import path from 'path';
import {
  drawEscortHull, drawnShipWorldPos, canvasToWorld, recordShipWorldPosAs, type RenderContext,
} from '../mapRenderer';
import type { Ship } from '../../types';

function rc(): RenderContext {
  const noop = () => {};
  const g = {
    save: noop, restore: noop, translate: noop, rotate: noop, drawImage: noop,
    beginPath: noop, arc: noop, fill: noop, fillStyle: '',
  };
  return {
    ctx: g, canvas: { width: 800, height: 600 },
    camera: { x: 120, y: -40, scale: 3 },
    factions: [], bodies: [], t: 0,
  } as unknown as RenderContext;
}

const escort = (id: string) => ({ id, ownedBy: 'a', class: 'corvette' } as unknown as Ship);

test('an escort records where it was drawn, so its death plays there', () => {
  const r = rc();
  drawEscortHull(r, escort('esc-1'), 410, 233, 24, 0.4);
  const at = drawnShipWorldPos('esc-1');
  const want = canvasToWorld(410, 233, r);
  expect(at).toBeDefined();
  expect(at!.x).toBeCloseTo(want.x, 9);
  expect(at!.y).toBeCloseTo(want.y, 9);
});

test('an escort riding with an off-screen flagship takes the flagship’s spot', () => {
  const r = rc();
  drawEscortHull(r, escort('flag-x'), 50, 60, 24, 0);   // any recorded hull will do
  recordShipWorldPosAs('esc-2', 'flag-x');
  expect(drawnShipWorldPos('esc-2')).toEqual(drawnShipWorldPos('flag-x'));
});

test('a queued death with no drawn spot looks for the hull the way weapon FX do, before its raw orbit', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../components/MapCanvas.tsx'), 'utf8');
  expect(src).toMatch(/const cp = sh \? shipCanvasPos\(sh, renderContext, transitShipCanvasPosRef\.current\) : null;\s*if \(cp\) world = canvasToWorld\(cp\.x, cp\.y, renderContext\);\s*else if \(sh\) world = shipWorldPosition/);
});
