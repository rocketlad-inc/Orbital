// "My ship at Enceladus isn't attacking. Do I gotta toggle that?"
//
// It was in attack stance, armed, parked in the right orbit -- and the
// panel said nothing at all, because a parked hull with no target used
// to render no readout. These pin the reason codes the combat section
// prints, especially the two that look like a bug from the cockpit:
// hostiles ARE present and the guns stay cold.

import { predictTarget } from '../targeting';
import { Ship, Settlement } from '../../types';

const mkShip = (o: Partial<Ship> & { id: string; ownedBy: string }): Ship => ({
  class: 'frigate',
  damagePerTick: 10,
  stance: 'attack',
  orbit: { parentBodyId: 'enceladus' },
  parts: [],
  ...o,
} as unknown as Ship);

const mkStl = (o: Partial<Settlement> & { id: string; ownedBy: string }): Settlement => ({
  bodyId: 'enceladus',
  type: 'city',
  buildings: {},
  ...o,
} as unknown as Settlement);

const ME = 'me';
const THEM = 'them';
const call = (attacker: Ship, ships: Ship[], settlements: Settlement[], pactPairs?: string[]) =>
  predictTarget({
    attacker,
    ships: [attacker, ...ships],
    settlements,
    pactPairs,
    damagePerTick: attacker.damagePerTick ?? 0,
    tick: 100,
  });

describe('predictTarget reasons', () => {
  const me = mkShip({ id: 'a1', ownedBy: ME });

  it('names a hostile sharing the orbit', () => {
    const r = call(me, [mkShip({ id: 'e1', ownedBy: THEM })], []);
    expect(r.reason).toBeUndefined();
    expect(r.target?.kind).toBe('ship');
  });

  it('reports a treaty rather than an empty orbit', () => {
    // The reported case: hostiles right there, guns cold, because a
    // pact outranks the stance.
    const r = call(me, [mkShip({ id: 'e1', ownedBy: THEM })], [], ['me|them']);
    expect(r.target).toBeUndefined();
    expect(r.reason).toBe('at-peace');
  });

  it('covers a pacted settlement too', () => {
    const r = call(me, [], [mkStl({ id: 's1', ownedBy: THEM })], ['me|them']);
    expect(r.reason).toBe('at-peace');
  });

  it('says a defensive hull is waiting to be shot at', () => {
    // Their hull is DEFENSIVE, so nobody here is aggressing, so our
    // defensive hull never starts either -- a standoff the server
    // models and the panel never explained.
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'defensive' })], []);
    expect(r.target).toBeUndefined();
    expect(r.reason).toBe('defensive-no-aggressor');
  });

  it('lets a defensive hull engage an actual aggressor', () => {
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'attack' })], []);
    expect(r.reason).toBeUndefined();
    expect(r.target?.kind).toBe('ship');
  });

  it('treats an empty orbit as none-present, not a treaty', () => {
    const r = call(me, [], []);
    expect(r.reason).toBe('none-present');
  });

  it('does not engage something orbiting a different body', () => {
    // Enceladus is not Saturn: same system, different station.
    const away = mkShip({ id: 'e1', ownedBy: THEM, orbit: { parentBodyId: 'saturn' } } as never);
    const r = call(me, [away], []);
    expect(r.reason).toBe('none-present');
  });

  it('reports an unarmed hull as unarmed', () => {
    const hauler = mkShip({ id: 'a1', ownedBy: ME, class: 'freighter', damagePerTick: 0 });
    const r = call(hauler, [mkShip({ id: 'e1', ownedBy: THEM })], []);
    expect(r.reason).toBe('unarmed');
  });

  it('ranks the treaty above the defensive standoff', () => {
    // Both true at once: the pact is the thing the player can act on.
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'defensive' })], [], ['me|them']);
    expect(r.reason).toBe('at-peace');
  });
});
