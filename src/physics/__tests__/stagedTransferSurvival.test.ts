// [pure] Staged transfer previews must survive a /state re-apply.
//
// Regression guard for the live bug: "I've clicked transfer, but I can't
// select Enceladus." The destination was legal and the planner returned a
// valid course; what failed was that ship.plannedTransit is CLIENT-ONLY
// (COMMIT is what posts), while /state is applied by replacing gameState
// wholesale — so the staged preview was silently deleted and COMMIT went
// back to greyed-out with no explanation.
//
// The carry rule under test:
//   - carry a staged plan onto the rebuilt ship
//   - DROP it when the server says the ship is now in transit
//   - DROP it when the plan's arrival is already in the past
//   - DROP it when the ship no longer exists
//
// Kept in step with carryStagedPreviews in MultiplayerGameProvider.tsx.

interface TestPlan { targetBodyId: string; arriveTick: number }
interface TestShip {
  id: string;
  transit?: unknown;
  plannedTransit?: TestPlan;
}
interface TestState { currentTick: number; ships: TestShip[] }

/** Mirror of carryStagedPreviews. */
function carryStagedPreviews(prev: TestState | null, next: TestState): TestState {
  if (!prev) return next;
  const staged = new Map(
    prev.ships.filter(s => s.plannedTransit).map(s => [s.id, s.plannedTransit!]),
  );
  if (staged.size === 0) return next;
  let carried = 0;
  const ships = next.ships.map(s => {
    const plan = staged.get(s.id);
    if (!plan) return s;
    if (s.transit) return s;
    if (plan.arriveTick <= next.currentTick) return s;
    carried++;
    return { ...s, plannedTransit: plan };
  });
  return carried > 0 ? { ...next, ships } : next;
}

const plan = (targetBodyId: string, arriveTick: number): TestPlan => ({ targetBodyId, arriveTick });

describe('[pure] staged transfer survives a server re-apply', () => {
  it('carries the preview onto the rebuilt ship (the live Enceladus bug)', () => {
    const prev: TestState = {
      currentTick: 35,
      ships: [{ id: 'granary', plannedTransit: plan('enceladus', 38.55) }],
    };
    // The server rebuild has no plannedTransit — that is the whole point.
    const next: TestState = { currentTick: 35, ships: [{ id: 'granary' }] };

    const out = carryStagedPreviews(prev, next);

    expect(out.ships[0].plannedTransit).toEqual(plan('enceladus', 38.55));
  });

  it('drops the preview once the server reports the ship in transit', () => {
    const prev: TestState = {
      currentTick: 35,
      ships: [{ id: 'granary', plannedTransit: plan('enceladus', 38.55) }],
    };
    const next: TestState = {
      currentTick: 36,
      ships: [{ id: 'granary', transit: { targetBodyId: 'enceladus' } }],
    };

    const out = carryStagedPreviews(prev, next);

    // Two futures for one hull would draw two arcs.
    expect(out.ships[0].plannedTransit).toBeUndefined();
  });

  it('drops a plan whose arrival has already passed', () => {
    const prev: TestState = {
      currentTick: 35,
      ships: [{ id: 'granary', plannedTransit: plan('enceladus', 38.55) }],
    };
    const next: TestState = { currentTick: 39, ships: [{ id: 'granary' }] };

    const out = carryStagedPreviews(prev, next);

    expect(out.ships[0].plannedTransit).toBeUndefined();
  });

  it('drops a plan for a ship the server no longer lists', () => {
    const prev: TestState = {
      currentTick: 35,
      ships: [{ id: 'granary', plannedTransit: plan('enceladus', 38.55) }],
    };
    const next: TestState = { currentTick: 35, ships: [{ id: 'other' }] };

    const out = carryStagedPreviews(prev, next);

    expect(out.ships.find(s => s.id === 'granary')).toBeUndefined();
    expect(out.ships[0].plannedTransit).toBeUndefined();
  });

  it('leaves state untouched when nothing is staged (identity, no churn)', () => {
    const prev: TestState = { currentTick: 35, ships: [{ id: 'granary' }] };
    const next: TestState = { currentTick: 35, ships: [{ id: 'granary' }] };

    // Same object back: this path runs on every poll, so it must not
    // manufacture a new state object and re-render the whole app.
    expect(carryStagedPreviews(prev, next)).toBe(next);
  });

  it('carries only the staged ship, leaving the rest of the fleet alone', () => {
    const prev: TestState = {
      currentTick: 35,
      ships: [
        { id: 'granary', plannedTransit: plan('enceladus', 38.55) },
        { id: 'escort' },
      ],
    };
    const next: TestState = {
      currentTick: 35,
      ships: [{ id: 'granary' }, { id: 'escort' }],
    };

    const out = carryStagedPreviews(prev, next);

    expect(out.ships[0].plannedTransit).toEqual(plan('enceladus', 38.55));
    expect(out.ships[1].plannedTransit).toBeUndefined();
  });
});
