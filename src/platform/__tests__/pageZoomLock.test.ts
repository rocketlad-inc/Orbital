// ============================================================
// A pinch on a panel must not zoom the whole app (playtester, phone and
// Android app: "the entire app then remains zoomed in"). Three layers:
// the viewport tag, touch-action on html/body, and iOS gesture events.
// The map canvas keeps its own pinch (touch-action:none on itself).
// ============================================================

import fs from 'fs';
import path from 'path';

const read = (p: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n/g, '\n');

describe('page zoom is locked; the map pinches on its own', () => {
  it('the viewport tag forbids user zoom', () => {
    const tag = read('public/index.html').match(/name="viewport"\s+content="([^"]+)"/);
    expect(tag?.[1]).toMatch(/user-scalable=no/);
    expect(tag?.[1]).toMatch(/maximum-scale=1\b/);
  });

  it('html/body allow panning only (no pinch, no double-tap zoom)', () => {
    const css = read('src/App.css');
    const block = css.slice(css.indexOf('html,\nbody {'));
    expect(block.slice(0, block.indexOf('}'))).toMatch(/touch-action:\s*pan-x pan-y;/);
  });

  it('the map canvas still owns its gestures', () => {
    expect(read('src/components/MapCanvas.css')).toMatch(/touch-action:\s*none/);
  });

  it('iOS gesture events are cancelled on the mobile layout only', () => {
    jest.isolateModules(() => {
      const shell = { mobile: true };
      jest.doMock('../../hooks/useIsMobile', () => ({ isMobileShell: () => shell.mobile }));
      const { installPageZoomLock } = require('../pageZoomLock');
      installPageZoomLock();
      const fire = () => {
        const e = new Event('gesturestart', { cancelable: true, bubbles: true });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(fire()).toBe(true);
      shell.mobile = false;
      expect(fire()).toBe(false);
    });
  });
});
