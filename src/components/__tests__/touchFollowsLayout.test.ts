// ============================================================
// Touch UI follows the LAYOUT (useIsMobile), never the pointer query.
//
// Lorne, 2026-10-01, on his desktop: "Why is this full width now? It
// overlaps with the outliner. And also, what happened to shift click to
// send?" His desktop Chromium reports `(pointer: coarse)` with a mouse in
// hand. Three things keyed off that query:
//   * the group bar switched to its phone layout (full width, tap hints)
//   * every MOUSE click on the map got finger-sized hit boxes, so a
//     shift-click on a world caught a hull parked around it and toggled
//     that ship instead of sending the group
//   * the dock rail closed other menus on open, a phone-only behaviour
// Lorne's standing rule: touch-only UI gates on useIsMobile() ONLY.
// ============================================================

import fs from 'fs';
import path from 'path';

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', p), 'utf8').replace(/\r\n/g, '\n');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out); }
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('touch UI follows the layout', () => {
  it('no component decides its UI from isCoarsePointer()', () => {
    const root = path.resolve(__dirname, '..', '..');
    const offenders = walk(root)
      // The hook defines it (and the app shell uses it for the Android
      // app's always-mobile clamp, which is about the device by design).
      .filter(f => !/hooks[\\/]useIsMobile\.ts$|platform[\\/]/.test(f))
      .filter(f => /isCoarsePointer\(\)/.test(code(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('the group bar\'s phone layout is the mobile layout, nothing else', () => {
    expect(code(src('components/GroupActionBar.tsx'))).toMatch(/const touch = isMobile;/);
  });

  it('the dock rail closes other menus only on the mobile layout', () => {
    expect(code(src('components/DockRail.tsx'))).toMatch(/if \(!isMobile\) return;/);
  });

  describe('map hit boxes: finger-sized for a finger only', () => {
    const map = code(src('components/MapCanvas.tsx'));
    const tap = map.slice(map.indexOf('const handleTapAt = useCallback('), map.indexOf('const handleClick = useCallback('));
    const click = map.slice(map.indexOf('const handleClick = useCallback('), map.indexOf('const handleMouseHover = useCallback('));

    it('the padding is not decided per device', () => {
      expect(map).toMatch(/const TOUCH_HIT_PADDING = 16;/);
    });
    it('handleTapAt pads only when told the input was a touch', () => {
      expect(tap).toMatch(/additive = false, touch = false\)/);
      expect(tap).toMatch(/const pad = touch \? TOUCH_HIT_PADDING : 0;/);
      expect(tap).toMatch(/pickShipAt\(canvasX, canvasY, touch\)/);
      expect(tap).not.toMatch(/\+ TOUCH_HIT_PADDING/);
    });
    it('a mouse click (shift-click to send included) says it was not a touch', () => {
      expect(click).toMatch(/e\.shiftKey \|\| e\.metaKey,\s*false,\s*\)/);
    });
    it('a finger tap says it was', () => {
      expect(map).toMatch(/handleTapAt\(x, y, false, true\)/);
    });
  });
});
