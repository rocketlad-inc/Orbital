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
const call = (attacker: Ship, ships: Ship[], settlements: Settlement[], warPairs?: string[]) =>
  predictTarget({
    attacker,
    ships: [attacker, ...ships],
    settlements,
    warPairs,
    damagePerTick: attacker.damagePerTick ?? 0,
    tick: 100,
  });

// WAR IS DECLARED NOW, and the argument flipped with it: it used to be
// the PACTS, so passing nothing meant "hostile to everyone", and it is
// now the open WARS, so passing nothing means "at peace with everyone".
// Every case below swapped which way round it hands that in. The
// expectations are unchanged — the model underneath them is the thing
// that moved.
const AT_WAR = ['me|them'];

describe('predictTarget reasons', () => {
  const me = mkShip({ id: 'a1', ownedBy: ME });

  it('names a declared enemy sharing the orbit', () => {
    const r = call(me, [mkShip({ id: 'e1', ownedBy: THEM })], [], AT_WAR);
    expect(r.reason).toBeUndefined();
    expect(r.target?.kind).toBe('ship');
  });

  it('reports peace rather than an empty orbit', () => {
    // The reported case: a rival right there, guns cold. It used to take
    // a signed pact to produce this; it is now the default, and it is
    // the commonest state in the game.
    const r = call(me, [mkShip({ id: 'e1', ownedBy: THEM })], []);
    expect(r.target).toBeUndefined();
    expect(r.reason).toBe('at-peace');
  });

  it('covers an undeclared settlement too', () => {
    const r = call(me, [], [mkStl({ id: 's1', ownedBy: THEM })]);
    expect(r.reason).toBe('at-peace');
  });

  it('says a defensive hull is waiting to be shot at', () => {
    // Their hull is DEFENSIVE, so nobody here is aggressing, so our
    // defensive hull never starts either -- a standoff the server
    // models and the panel never explained.
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'defensive' })], [], AT_WAR);
    expect(r.target).toBeUndefined();
    expect(r.reason).toBe('defensive-no-aggressor');
  });

  it('lets a defensive hull engage an actual aggressor', () => {
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'attack' })], [], AT_WAR);
    expect(r.reason).toBeUndefined();
    expect(r.target?.kind).toBe('ship');
  });

  it('treats an empty orbit as none-present, not peace', () => {
    const r = call(me, [], [], AT_WAR);
    expect(r.reason).toBe('none-present');
  });

  it('does not engage something orbiting a different body', () => {
    // Enceladus is not Saturn: same system, different station.
    const away = mkShip({ id: 'e1', ownedBy: THEM, orbit: { parentBodyId: 'saturn' } } as never);
    const r = call(me, [away], [], AT_WAR);
    expect(r.reason).toBe('none-present');
  });

  it('reports an unarmed hull as unarmed', () => {
    const hauler = mkShip({ id: 'a1', ownedBy: ME, class: 'freighter', damagePerTick: 0 });
    const r = call(hauler, [mkShip({ id: 'e1', ownedBy: THEM })], [], AT_WAR);
    expect(r.reason).toBe('unarmed');
  });

  it('ranks peace above the defensive standoff', () => {
    // Both true at once, and peace is the one that explains the silence:
    // a defensive standoff would end the moment somebody fired, and at
    // peace nobody can.
    const mine = mkShip({ id: 'a1', ownedBy: ME, stance: 'defensive' });
    const r = call(mine, [mkShip({ id: 'e1', ownedBy: THEM, stance: 'defensive' })], []);
    expect(r.reason).toBe('at-peace');
  });
});
