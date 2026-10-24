/**
 * Next tick, clicked five times while paused, advanced one tick and said
 * nothing (playtest, 2026-10-24): the clicks after the first hit a
 * disabled button. Every click now counts, one step after another, and
 * the button says where the clock got to.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const mockCalls: string[] = [];
const mockPending: Array<() => void> = [];
let mockTick = 3;
jest.mock('../api', () => ({
  apiFetch: (path: string) => {
    mockCalls.push(path);
    return new Promise(resolve => {
      mockPending.push(() => { mockTick += 1; resolve({ ok: true, data: { ok: true, tick: mockTick } }); });
    });
  },
}));
jest.mock('../../state/gameContext', () => ({
  useGameContext: () => ({ gameState: { solo: { paused: true }, currentTick: 3, tickIntervalMs: 30000 } }),
}));
jest.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

// eslint-disable-next-line import/first
import { SoloClock } from '../SoloClock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

it('every Next tick click runs a tick, in order, and the button names the tick reached', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => { root.render(<SoloClock gameId="g1" />); });
  const stepBtn = () => Array.from(host.querySelectorAll('button')).find(b => /Next tick|Ticking|Now T\+/.test(b.textContent ?? ''))!;

  act(() => { stepBtn().click(); });
  act(() => { stepBtn().click(); });
  act(() => { stepBtn().click(); });
  expect(mockCalls.filter(p => p.endsWith('/solo/step'))).toHaveLength(1);
  expect(stepBtn().textContent).toMatch(/2 more/);

  for (let i = 0; i < 3; i++) {
    await act(async () => { mockPending.shift()!(); });
    await flush();
  }
  expect(mockCalls.filter(p => p.endsWith('/solo/step'))).toHaveLength(3);
  expect(stepBtn().textContent).toMatch(/Now T\+6/);
  act(() => root.unmount());
});
