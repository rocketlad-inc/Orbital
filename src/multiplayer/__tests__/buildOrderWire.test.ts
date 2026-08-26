import { buildOrderWireFields, buildOrderPatchBody } from '../buildOrderWire';

const GAME = 'Jt4AQbYy7M4l';
const qualify = (id: string) => (id.includes(':') ? id : `${GAME}:${id}`);

describe('buildOrderWireFields', () => {
  it('sends nothing when the hull has no standing order', () => {
    expect(buildOrderWireFields({}, qualify)).toEqual({});
    expect(buildOrderWireFields({ buildOrderBodyId: 'ariel' }, qualify)).toEqual({});
  });

  // THE REPORTED BUG: "destination body not found" on every go_to build.
  // game_bodies.id is "<gameId>:ariel"; the client had stripped it to
  // "ariel" and sent that, so the lookup found nothing.
  it('puts the game namespace back on a go_to destination', () => {
    expect(buildOrderWireFields({ buildOrder: 'go_to', buildOrderBodyId: 'ariel' }, qualify))
      .toEqual({ build_order: 'go_to', build_order_body_id: `${GAME}:ariel` });
  });

  it('qualifies a fleet id — game_fleets.id is namespaced too', () => {
    expect(buildOrderWireFields({ buildOrder: 'join_fleet', buildOrderFleetId: 'fl_yyv7ai' }, qualify))
      .toEqual({ build_order: 'join_fleet', build_order_fleet_id: `${GAME}:fl_yyv7ai` });
  });

  // The asymmetry that makes this worth a function: route ids are minted
  // flat, so qualifying one would break a call that works today.
  it('leaves a route id alone', () => {
    expect(buildOrderWireFields(
      { buildOrder: 'trade_route', buildOrderRouteId: '-0e-UM0v254BER5H' }, qualify,
    )).toEqual({ build_order: 'trade_route', build_order_route_id: '-0e-UM0v254BER5H' });
  });

  it('never double-qualifies an id that already carries the prefix', () => {
    expect(buildOrderWireFields(
      { buildOrder: 'go_to', buildOrderBodyId: `${GAME}:ariel` }, qualify,
    ).build_order_body_id).toBe(`${GAME}:ariel`);
  });

  it('sends the bare verb for orders that need no target', () => {
    for (const v of ['defensive', 'hold'] as const) {
      expect(buildOrderWireFields({ buildOrder: v }, qualify)).toEqual({ build_order: v });
    }
  });
});

describe('buildOrderPatchBody', () => {
  // Retargeting one queued hull has to be able to say "nothing", and an
  // absent key means "leave it alone" — so the clear is explicit.
  it('says build_order: null out loud when the order is cleared', () => {
    expect(buildOrderPatchBody({}, qualify)).toEqual({ build_order: null });
  });

  it('sends the same qualified fields as a build otherwise', () => {
    expect(buildOrderPatchBody({ buildOrder: 'go_to', buildOrderBodyId: 'ariel' }, qualify))
      .toEqual({ build_order: 'go_to', build_order_body_id: `${GAME}:ariel` });
  });

  it('carries a bare verb with no target', () => {
    expect(buildOrderPatchBody({ buildOrder: 'defensive' }, qualify))
      .toEqual({ build_order: 'defensive' });
  });
});
