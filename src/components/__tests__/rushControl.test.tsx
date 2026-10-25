// R2-C7: a rush "confirmed" and the row still read its old T-. The
// button is not offered on an unconfirmed (optimistic) row, and a rush
// shows its new delivery at once.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const mockRushBuild = jest.fn();
const mockUpdateGameState = jest.fn();
const mockOrder = { id: 'b1', bodyId: 'earth', shipClass: 'corvette', ownedBy: 'player', startTick: 0, completeTick: 22, shipName: 'Kestrel' };
jest.mock('../../multiplayer/MultiplayerActionsContext', () => ({
  useMultiplayerActions: () => ({ rushBuild: mockRushBuild, gameId: 'g' }),
}));
jest.mock('../../state/gameContext', () => ({
  useGameContext: () => ({ gameState: { buildOrders: [mockOrder] }, updateGameState: mockUpdateGameState }),
}));

// eslint-disable-next-line import/first
import { RushControl } from '../BuildPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(o: typeof mockOrder) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => { root.render(<RushControl order={o as never} remaining={12} constructionLvl={0} />); });
  return { el, root };
}

test('no rush on a row the server has not confirmed yet', () => {
  const { el, root } = mount({ ...mockOrder, id: 'opt_1729000000000_corvette' });
  expect(el.querySelector('button')).toBeNull();
  act(() => root.unmount());
});

test('a rush shows its new delivery without waiting for the poll', async () => {
  mockRushBuild.mockResolvedValue({ ok: true, completesAtTick: 16, rushCount: 1, botched: false });
  const { el, root } = mount(mockOrder);
  act(() => { (el.querySelector('button') as HTMLButtonElement).click(); });
  const confirm = [...document.body.querySelectorAll('[role=dialog] button')][0] as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  expect(mockRushBuild).toHaveBeenCalledWith('b1');
  expect(mockUpdateGameState).toHaveBeenCalledWith({ buildOrders: [expect.objectContaining({ id: 'b1', completeTick: 16, rushCount: 1 })] });
  act(() => root.unmount());
});
