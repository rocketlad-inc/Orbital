// ============================================================
// The desktop yard (Option A, 2026-09-30).
//
// Lorne: "The ship build queue struggles when you have more than 4 ships
// in queue, and also I'd like to find how we can fit a template select
// drop down on each ship type." Then: "Both options lose the function to
// set the starting orders per ship."
//
// What these pin, each a way the old panel failed:
//   * every order is drawn (it was sliced to six) in a list that scrolls
//   * the rush popover portals out, so the scroller cannot clip CONFIRM
//     (the reason the queue was never allowed to scroll)
//   * every hull row carries a template picker, not only hulls with 2+
//   * every queued hull keeps its OWN starting-order select
//   * the phone keeps its own layout
// ============================================================

import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const wm = read('../WorldMenuOverlay.tsx');
const css = read('../WorldMenuOverlay.css');
const bp = read('../../components/BuildPanel.tsx');

const fleet = wm.slice(wm.indexOf('const WmFleet'), wm.indexOf('// WmTerraformCard'));

describe('the desktop yard', () => {
  it('draws every order: no cap on the queue', () => {
    const i = fleet.indexOf('const orders = gameState.buildOrders');
    expect(i).toBeGreaterThan(0);
    expect(fleet.slice(i, i + 200)).not.toMatch(/\.slice\(0,\s*\d+\)/);
  });

  it('the queue list scrolls', () => {
    const rule = css.slice(css.indexOf('.wm-qlist {'), css.indexOf('}', css.indexOf('.wm-qlist {')));
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('the rush popover is portalled at a fixed position, so a scroller cannot clip it', () => {
    const rc = bp.slice(bp.indexOf('export const RushControl'));
    expect(rc).toMatch(/createPortal\(/);
    expect(rc).toMatch(/position: 'fixed'/);
    expect(rc).not.toMatch(/position: 'absolute', right: 0/);
  });

  it('every queued and building hull has its own starting-order select', () => {
    const line = fleet.slice(fleet.indexOf('const qLine'), fleet.indexOf('const hullInfo'));
    expect(line).toMatch(/isMine \? orderSelect\(o\)/);
    // building AND waiting both go through qLine
    expect(fleet).toMatch(/building\.map\(o => qLine\(o, true, 0\)\)/);
    expect(fleet).toMatch(/waiting\.map\(\(o, i\) => qLine\(o, false/);
  });

  it('an override reads differently from following the yard', () => {
    expect(fleet).toMatch(/wm-qorder\$\{o\.buildOrder \? ' is-own' : ''\}/);
    expect(css).toMatch(/\.wm-qorder\.is-own\s*\{/);
  });

  it('every unlocked hull row has a template picker (or says it builds bare)', () => {
    const hulls = fleet.slice(fleet.indexOf('className="wm-hulls"'));
    expect(hulls).toMatch(/h\.templates\.length > 0 \? \(\s*templateSelect\(cls, h, 'wm-hulltpl'\)/);
    expect(hulls).toMatch(/Bare hull/);
    // BUILD is its own button, so the picker can live in the row
    expect(hulls).toMatch(/className="wm-hullbuild"[\s\S]{0,300}onClick=\{\(\) => buildShip\(cls\)\}/);
  });

  it('the phone keeps its own layout', () => {
    expect(fleet).toMatch(/\{mobile \? \(\s*<div className="wm-fleet-grid">/);
    expect(fleet).toMatch(/building\.map\(o => qRow\(o, true\)\)/);
  });
});
