// R2-C11: a quiet trial made several API requests a second. /state itself
// measured at one per ~1.6 s on staging (headless Chrome, every dock panel
// opened in turn); the rest was side polls that ran every 3 s for the
// whole match. /turn/status is only live-critical in Turn-Based Mode.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const getTurnStatus = jest.fn();
jest.mock('../MultiplayerActionsContext', () => ({
  useMultiplayerActions: () => mockMp,
}));
const mockMp = { getTurnStatus };

// eslint-disable-next-line import/first
import { useMpTurnStatus } from '../useMpTurnStatus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Probe: React.FC = () => { useMpTurnStatus(); return null; };

async function callsIn60s(tbm: boolean): Promise<number> {
  getTurnStatus.mockReset();
  getTurnStatus.mockResolvedValue({ turn_based_enabled: tbm });
  jest.useFakeTimers();
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Probe />); });
  for (let i = 0; i < 60; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { jest.advanceTimersByTime(1000); });
  }
  act(() => root.unmount());
  jest.useRealTimers();
  return getTurnStatus.mock.calls.length;
}

test('a real-time game asks about Turn-Based Mode every 15 s, not every 3 s', async () => {
  expect(await callsIn60s(false)).toBeLessThanOrEqual(5);
});
test('a Turn-Based game keeps the live 3 s cadence', async () => {
  expect(await callsIn60s(true)).toBeGreaterThanOrEqual(19);
});
