/**
 * A GROUP ALREADY IN FLIGHT TAKES A LEG ON THE END OF ITS ROUTE.
 *
 * Reported on mobile, 2026-10-05: select ships in transit, add a leg,
 * and SEND is greyed out. The group path only knew how to start a
 * parked hull (and to REPLACE its route doing so). Under way, a hull's
 * new legs must chain off where its current route parks it and append,
 * exactly as the single-ship ADD LEG does.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { planChainLegs } from '../../physics/chainPlanner';
import { bodyPosition } from '../../physics/orbitalMechanics';
import { Body } from '../../types';

const mk = (id: string, parent: string | null, extra: Partial<Body> = {}): Body => ({
  id, name: id, type: 'terrestrial', parent,
  radius: 2, soi: 10, mu: 1,
  orbitRadius: parent ? 100 : 0, orbitPeriod: parent ? 50 : 0, angle0: 0,
  color: '#fff',
  ...extra,
} as unknown as Body);

const BODIES: Body[] = [
  mk('sol', null, { type: 'star', radius: 50 } as Partial<Body>),
  mk('earth', 'sol', { orbitRadius: 186, orbitPeriod: 365 }),
  mk('mars', 'sol', { orbitRadius: 280, orbitPeriod: 687 }),
  mk('neptune', 'sol', { orbitRadius: 600, orbitPeriod: 900 }),
];
const ACCEL = 0.05;

// The burn the hull is flying right now: Earth -> Mars, launched at tick 0.
const [inFlight] = planChainLegs({
  startPos: { ...bodyPosition(BODIES[1], 0, BODIES) },
  startVel: { x: 0, y: 0 }, startTick: 0, parkedAtBodyId: 'earth',
  steps: [{ bodyId: 'mars', wait: 0 }], bodies: BODIES, accel: ACCEL,
});

const mockPosted: Array<Record<string, unknown>> = [];
const mockGameState = {
  currentTick: 3,
  bodies: BODIES,
  factions: [],
  factionTech: {},
  ships: [{
    id: 'a', ownedBy: 'player', class: 'corvette',
    orbit: { parentBodyId: 'earth' },
    transit: { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, currentTransfer: inFlight },
    queuedTransits: [],
  }],
};

jest.mock('../../state/gameContext', () => ({ useGameContext: () => ({ gameState: mockGameState }) }));
jest.mock('../../multiplayer/MultiplayerActionsContext', () => ({
  useMultiplayerActions: () => ({
    transferMany: (intents: Array<Record<string, unknown>>) => {
      mockPosted.push(...intents);
      return Promise.resolve(intents.map(() => ({ ok: true })));
    },
  }),
}));
jest.mock('../../game/fleetPace', () => ({ fleetEngineAccel: () => 0.05 }));

// eslint-disable-next-line import/first
import { useBulkChain } from '../useBulkChain';

function grab() {
  let run: ReturnType<typeof useBulkChain> | null = null;
  const Probe = () => { run = useBulkChain(); return null; };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => { createRoot(document.createElement('div')).render(<Probe />); });
  return run!;
}

test('a hull under way gets the new legs appended after its current route', () => {
  expect(inFlight).toBeDefined();
  mockPosted.length = 0;
  const res = grab()(['a'], [{ bodyId: 'neptune', wait: 0 }, { bodyId: 'earth', wait: 0 }]);
  expect(res.issued).toBe(1);
  expect(mockPosted.map(p => p.targetBodyId)).toEqual(['neptune', 'earth']);
  // Nothing replaces the burn in progress.
  expect(mockPosted.every(p => p.replace === false)).toBe(true);
  // The first new leg leaves when the current one lands at Mars.
  expect(mockPosted[0].scheduledT as number).toBeCloseTo(inFlight.arriveTick, 6);
});
