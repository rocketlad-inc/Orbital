/**
 * ON A PHONE, ONE PANEL AT A TIME, AND NOTHING SHOWS THROUGH (playtest C16).
 *
 * Maya (375x812) and Rafaela (768x1024), 2026-10-24: the ship designer
 * showed through Trade and the Report, and Research drew on top of it.
 * On a phone the designer sits UNDER the rail's sheets (it ends on top of
 * the bottom rail), the rail never closed it, and the sheets were 94-96%
 * opaque.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DockRail } from '../DockRail';
import { BottomSheet } from '../BottomSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mountRail(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<DockRail isMultiplayer />); });
  return {
    host,
    click(label: string) {
      const btn = host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      act(() => { btn.click(); });
    },
    done() { act(() => root.unmount()); host.remove(); },
  };
}

describe('phone panels', () => {
  it('a rail button closes the ship designer before opening its sheet', () => {
    const rail = mountRail(375);
    let closed = 0;
    const onClose = () => { closed += 1; };
    window.addEventListener('orbital:close-ship-designer', onClose);
    rail.click('Trade');
    expect(closed).toBe(1);
    rail.click('Research');
    expect(closed).toBe(2);
    window.removeEventListener('orbital:close-ship-designer', onClose);
    rail.done();
  });

  it('opening the designer closes the rail sheet that would cover it', () => {
    const rail = mountRail(375);
    rail.click('Trade');
    let active: unknown = 'trade';
    const onActive = (e: Event) => { active = (e as CustomEvent).detail?.active; };
    window.addEventListener('dockrail:active', onActive);
    act(() => { window.dispatchEvent(new CustomEvent('orbital:open-ship-designer', { detail: {} })); });
    expect(active).toBeNull();
    window.removeEventListener('dockrail:active', onActive);
    rail.done();
  });

  it('a rail button closes the ship card instead of opening under it (round 2)', () => {
    // Research (z 110) opened UNDER the ship's bottom sheet (z 1080): the
    // tap looked swallowed and the card stayed on top (Leo, Rafaela, Maya).
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const sheetHost = document.createElement('div');
    document.body.appendChild(sheetHost);
    const sheetRoot = createRoot(sheetHost);
    let closed = 0;
    act(() => { sheetRoot.render(<BottomSheet open onClose={() => { closed += 1; }} title="SHIP"><p>card</p></BottomSheet>); });
    const rail = mountRail(375);
    rail.click('Research');
    expect(closed).toBe(1);
    rail.click('Trade');
    expect(closed).toBe(2);
    rail.done();
    act(() => sheetRoot.unmount());
    sheetHost.remove();
  });

  it('a desktop keeps its independent panels', () => {
    const rail = mountRail(1440);
    let closed = 0;
    const onClose = () => { closed += 1; };
    window.addEventListener('orbital:close-ship-designer', onClose);
    rail.click('Trade');
    expect(closed).toBe(0);
    window.removeEventListener('orbital:close-ship-designer', onClose);
    rail.done();
  });

  it('the phone sheets are opaque', () => {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const phoneBlock = (css: string, selector: string) => {
      const blocks = css.split('@media (max-width: 768px)').slice(1);
      const hit = blocks.find(b => b.includes(selector));
      expect(hit).toBeDefined();
      const i = hit!.indexOf(selector);
      return hit!.slice(i, hit!.indexOf('}', i));
    };
    expect(phoneBlock(read('components/DockRail.css'), '.dock-panel {')).toMatch(/background:\s*rgb\(10,\s*14,\s*20\)/);
    expect(phoneBlock(read('multiplayer/multiplayer.css'), '.mp-dock:not(.collapsed) {')).toMatch(/background:\s*rgb\(10,\s*14,\s*20\)/);
  });
});
