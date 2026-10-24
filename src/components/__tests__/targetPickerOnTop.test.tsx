/**
 * CHOOSE FROM LIST OPENS ON TOP OF EVERYTHING (playtest C2, 2026-10-24).
 *
 * The ship panel lives in .left-rail, a z-80 stacking context. The
 * picker's overlay carried z 1200, but a z-index only ranks inside its
 * stacking context, so with a world menu open (z 900) the list opened
 * behind the world and shipyard panels, and a pick landed on the world
 * menu instead. The picker must leave whatever box opened it.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { TransferTargetPicker } from '../ShipPanel';
import type { Body } from '../../types';

// React 18 wants this flag set for act() outside a test renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const body = (id: string, name: string): Body => ({
  id, name, type: 'planet', orbitRadius: 100, parent: 'sun',
} as unknown as Body);

describe('target picker stacking', () => {
  it('renders at the top of the page, not inside the panel that opened it', () => {
    const rail = document.createElement('div');
    rail.className = 'left-rail';
    rail.style.position = 'fixed';
    rail.style.zIndex = '80';
    document.body.appendChild(rail);
    const root = createRoot(rail);
    act(() => {
      root.render(
        <TransferTargetPicker
          bodies={[body('sun', 'Sun'), body('earth', 'Earth'), body('mars', 'Mars')]}
          excludeBodyId="earth"
          title="Move to"
          onPick={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const overlay = document.querySelector('[data-target-picker]');
    expect(overlay).not.toBeNull();
    expect(rail.contains(overlay)).toBe(false);
    expect(overlay!.parentElement).toBe(document.body);
    act(() => root.unmount());
    expect(document.querySelector('[data-target-picker]')).toBeNull();
    rail.remove();
  });
});
