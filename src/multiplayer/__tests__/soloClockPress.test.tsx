/**
 * The clock answers the press, not the server (Leo, round 2, 2026-10-24):
 * PAUSE took 2-3 s (the POST, then the next /state) to show its new state,
 * and its accessible label still said "Stop the clock" while paused.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const mockCalls: string[] = [];
jest.mock('../api', () => ({
  // Never answers: whatever the button shows came from the press alone.
  apiFetch: (path: string) => { mockCalls.push(path); return new Promise(() => undefined); },
}));
jest.mock('../../state/gameContext', () => ({
  useGameContext: () => ({ gameState: { solo: { paused: false }, currentTick: 5, tickIntervalMs: 30000 } }),
}));
jest.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

// eslint-disable-next-line import/first
import { SoloClock } from '../SoloClock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('PAUSE turns into RESUME the moment it is pressed', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => { root.render(<SoloClock gameId="g1" />); });
  const main = () => host.querySelector('[data-tutorial-id="solo-start"]') as HTMLButtonElement;
  expect(main().getAttribute('aria-label')).toBe('Pause');

  act(() => { main().click(); });
  expect(mockCalls).toEqual(['/api/games/g1/solo/pause']);
  expect(main().getAttribute('aria-label')).toBe('Resume');
  expect(main().className).toContain('is-go');
  // Past the first tick, RESUME is not START (only START keeps its word
  // on a narrow phone).
  expect(main().className).not.toContain('is-start');
  act(() => root.unmount());
});
