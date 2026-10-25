// R2-C2: four home warships left for Centauri A on one click, with the
// capital left bare and nothing said. The send buttons now ask first when
// worldsLeftUndefended() names a world.
import { worldsLeftUndefended, expandFleetIds } from '../leftUndefended';
import type { Settlement, Ship } from '../../types';

const at = (id: string, body: string, extra: Partial<Ship> = {}) => ({
  id, name: id, class: 'frigate', ownedBy: 'player', hp: 100, hpMax: 100,
  orbit: { parentBodyId: body, radius: 2, angle0: 0, epoch: 0, direction: 1 },
  ...extra,
}) as unknown as Ship;
const city = (body: string, ownedBy = 'player') =>
  ({ id: `c-${body}`, type: 'city', bodyId: body, ownedBy }) as unknown as Settlement;

const home = [at('w1', 'earth'), at('w2', 'earth'), at('w3', 'earth'), at('w4', 'earth')];

describe('worldsLeftUndefended', () => {
  it('sending every warship from the capital names the capital', () => {
    expect(worldsLeftUndefended(['w1', 'w2', 'w3', 'w4'], 'acen', home, [city('earth')])).toEqual(['earth']);
  });
  it('one warship staying behind is a guard', () => {
    expect(worldsLeftUndefended(['w1', 'w2', 'w3'], 'acen', home, [city('earth')])).toEqual([]);
  });
  it('an unarmed hull staying behind is not a guard', () => {
    const ships = [...home, at('f1', 'earth', { class: 'freighter', damagePerTick: 0 })];
    expect(worldsLeftUndefended(['w1', 'w2', 'w3', 'w4'], 'acen', ships, [city('earth')])).toEqual(['earth']);
  });
  it('leaving a world you hold nothing at says nothing', () => {
    expect(worldsLeftUndefended(['w1', 'w2', 'w3', 'w4'], 'acen', home, [city('mars')])).toEqual([]);
    expect(worldsLeftUndefended(['w1', 'w2', 'w3', 'w4'], 'acen', home, [city('earth', 'rival')])).toEqual([]);
  });
  it('a world already unguarded is not this order\'s doing', () => {
    expect(worldsLeftUndefended(['w1'], 'acen', home, [city('earth'), city('mars')])).toEqual([]);
  });
  it('a hull already in flight is not a guard', () => {
    const ships = [...home, at('w5', 'earth', { transit: { currentTransfer: {} } } as Partial<Ship>)];
    expect(worldsLeftUndefended(['w1', 'w2', 'w3', 'w4'], 'acen', ships, [city('earth')])).toEqual(['earth']);
  });
  it('a fleet leaves whole, so picking its flagship takes the fleet', () => {
    const ships = [at('f1', 'earth', { fleetId: 'F' }), at('f2', 'earth', { fleetId: 'F' })];
    expect(expandFleetIds(['f1'], ships).sort()).toEqual(['f1', 'f2']);
  });
});
