// ============================================================
// A phone has no Esc key. Playtester: "Press ESC to close" was shown on
// mobile at the foot of the Event Log and of the in-game Main Menu.
// Every keyboard hint a player can SEE (not a hover title, which a phone
// never shows) sits behind the layout's verdict, useIsMobile().
// ============================================================

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

/** Lines that print an Esc hint as visible text: a <kbd>Esc</kbd>, or a
 *  string label ending "(Esc)'" (button text, not a title= attribute). */
function visibleEscHints(file: string): Array<{ line: number; text: string; context: string }> {
  const lines = src(file).split('\n');
  const out: Array<{ line: number; text: string; context: string }> = [];
  lines.forEach((l, i) => {
    if (/title=/.test(l)) return;
    if (/<kbd>Esc<\/kbd>/i.test(l) || /\(Esc\)'/.test(l)) {
      out.push({ line: i + 1, text: l.trim(), context: lines.slice(Math.max(0, i - 2), i + 1).join('\n') });
    }
  });
  return out;
}

describe('no Esc-key hint on the mobile layout', () => {
  const files = [
    'components/EventLog.tsx',
    'components/TopBar.tsx',
    'multiplayer/MegastructureCard.tsx',
    'multiplayer/RouteComposer.tsx',
  ];
  for (const f of files) {
    it(`${f}: every visible Esc hint is gated on isMobile`, () => {
      const hints = visibleEscHints(f);
      expect(hints.length).toBeGreaterThan(0);
      for (const h of hints) expect(h.context).toMatch(/isMobile/);
      expect(src(f)).toMatch(/const isMobile = useIsMobile\(\);/);
    });
  }

  it('the map HUD drops "ESC to cancel" on the mobile shell', () => {
    const map = src('components/MapCanvas.tsx');
    const hud = map.slice(map.indexOf('function drawHUD('));
    expect(hud.slice(0, hud.indexOf('ESC to cancel'))).toMatch(/mobileShell\s*\n?\s*\?\s*'Tap a body to transfer'/);
  });
});
