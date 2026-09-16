import fs from 'fs';
import path from 'path';

/**
 * "The Sol-Neptune warp gate keeps moving its Sol anchor to Earth upon
 * load, and then shifting it back to Sol once you move the camera."
 *
 * The raw `camera.x / camera.y` are NOT world coordinates while the
 * camera is focused on a body — they are an offset from it, (0, 0) on
 * first load. Everything on the map projects through
 * renderContext.camera (focus resolved, zoom eased) via worldToCanvas;
 * two overlays projected with the raw camera instead, so the world
 * origin landed on the focused capital until the first camera move.
 *
 * This guards the class, not the instance: no hand-rolled projection
 * off the raw camera anywhere in the render pass.
 */
describe('MapCanvas never projects world space with the raw camera', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'components', 'MapCanvas.tsx'),
    'utf8',
  );

  it('has no `(world - camera.x) * camera.scale` projections', () => {
    expect(src).not.toMatch(/-\s*camera\.x\)\s*\*\s*camera\.scale/);
    expect(src).not.toMatch(/-\s*camera\.y\)\s*\*\s*camera\.scale/);
  });

  it('the gate link and the placement ring go through worldToCanvas', () => {
    const gate = src.slice(src.indexOf('// GATE LINKS.'), src.indexOf('clipSegmentToRect(', src.indexOf('// GATE LINKS.')));
    expect(gate).toMatch(/worldToCanvas\(pa\.x, pa\.y, renderContext\)/);
    expect(gate).toMatch(/worldToCanvas\(pb\.x, pb\.y, renderContext\)/);
    expect(src).toMatch(/worldToCanvas\(ap\.x, ap\.y, renderContext\)/);
  });
});
