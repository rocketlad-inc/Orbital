/**
 * THE SHIP DESIGNER IS A MODAL ABOVE THE DOCK RAIL (desktop).
 *
 * Studio clip "Designing a destroyer" (judges, 2026-10-23, 3.2-10.3 s):
 * the right dock rail (z 3200) sat on top of the designer (z 1200). Its
 * badged icons covered the Kinetic Mount and Energy Mount "+" buttons, and
 * the cursor appeared to click the rail's list icon (f200) - for players
 * too, a click there hit the rail, not the "+".
 *
 * Read from the stylesheets the app ships, so the order is the real one.
 */
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** z-index of `selector`'s first rule, optionally inside a media block. */
function zOf(css: string, selector: string, media?: string): number {
  let scope = css;
  if (media) {
    const at = css.indexOf(media);
    expect(at).toBeGreaterThanOrEqual(0);
    scope = css.slice(at);
    // The block: up to its matching close brace.
    let depth = 0, end = scope.length;
    for (let i = scope.indexOf('{'); i < scope.length; i++) {
      if (scope[i] === '{') depth++;
      else if (scope[i] === '}' && --depth === 0) { end = i; break; }
    }
    scope = scope.slice(0, end);
  }
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[\\s}])${esc}\\s*\\{[^}]*?z-index:\\s*(\\d+)`, 'm').exec(scope);
  expect(m).not.toBeNull();
  return Number(m![2]);
}

const designer = read('ShipDesigner.css');
const dock = read('DockRail.css');
const mp = fs.readFileSync(path.join(__dirname, '../../multiplayer/multiplayer.css'), 'utf8');
const tutorialZ = Number(/zIndex:\s*(\d+)/.exec(read('TutorialOverlay.tsx'))![1]);

const DESKTOP = '@media (min-width: 769px)';

describe('ship designer stacking', () => {
  it('on desktop sits above the dock rail and every side panel it opens', () => {
    const z = zOf(designer, '.ship-designer-overlay', DESKTOP);
    expect(z).toBeGreaterThan(zOf(dock, '.dock-rail'));
    expect(z).toBeGreaterThan(zOf(dock, '.dock-panel'));
    expect(z).toBeGreaterThan(zOf(mp, '.mp-dock'));
  });

  it('keeps what opens from inside it, and the tutorial, above it', () => {
    const z = zOf(designer, '.ship-designer-overlay', DESKTOP);
    expect(zOf(designer, '.cfp-scrim', DESKTOP)).toBeGreaterThan(z);
    expect(tutorialZ).toBeGreaterThan(z);
  });

  it('on a phone still ends on top of the bottom dock, under it', () => {
    expect(zOf(designer, '.ship-designer-overlay')).toBeLessThan(zOf(dock, '.dock-rail'));
    expect(designer).toMatch(/\.ship-designer-overlay\s*\{\s*padding:\s*0 0 var\(--mobile-rail-height/);
  });
});
