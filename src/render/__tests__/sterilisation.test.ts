// A WORLD DYING HAS TO BE SOMETHING YOU CAN SEE.
//
// The Mega Destroyer strike had no picture at all. The tick cleared
// terraformed_at_tick, the planet reverted to the sprite it had before
// anyone landed, and unless you were reading the log you would never
// know the most violent act in the game had happened — to YOUR world.
//
// Two halves, and both matter: the one-shot animation, and the mark it
// leaves. An animation with no persistent state means a player who was
// away sees a green planet and no explanation; a mark with no animation
// means the moment itself is missing.

import fs from 'fs';
import path from 'path';

const fx = fs.readFileSync(
  path.resolve(__dirname, '..', 'combatFx.ts'), 'utf8',
);
const renderer = fs.readFileSync(
  path.resolve(__dirname, '..', 'mapRenderer.ts'), 'utf8',
);
const pending = fs.readFileSync(
  path.resolve(__dirname, '..', 'pendingFx.ts'), 'utf8',
);
const room = fs.readFileSync(
  path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
);

describe('the strike animation', () => {
  it('plays off the same queue as every other missed event', () => {
    // The whole reason pendingFx exists: an event you were not watching
    // still plays when you look. A strike is the LAST thing that should
    // be silently missed.
    expect(pending).toMatch(/terraform_destroyed: 'sterilise'/);
    expect(pending).toMatch(/'sterilise'/);
  });

  it('has all three acts — beam, fire, ashes', () => {
    const i = fx.indexOf('export function drawSterilisations');
    const body = fx.slice(i, fx.indexOf('\n}', fx.indexOf('ACT THREE', i)));
    expect(body).toMatch(/ACT ONE: the beam/);
    expect(body).toMatch(/ACT TWO: the fire/);
    expect(body).toMatch(/ACT THREE: the ashes/);
  });

  it('the ashes are drawn in normal blend, not lighter', () => {
    // Smoke darkens. Drawn additively it would GLOW, which is the
    // opposite of the beat it is there to land.
    const i = fx.indexOf('ACT THREE');
    const body = fx.slice(i, i + 700);
    expect(body).toMatch(/c\.save\(\)/);
    expect(body).not.toMatch(/globalCompositeOperation = 'lighter'/);
  });

  it('is idempotent on the chronicle entry', () => {
    // Queued FX can be re-ingested on every poll.
    expect(fx).toMatch(/seenSteriliseIds\.has\(entryId\)/);
  });
});

describe('the mark it leaves', () => {
  it('both ways of killing a biosphere set it', () => {
    // A Mega Destroyer and a redirected asteroid share their entire
    // effect block; two different afterwards would be a distinction
    // nobody could see a reason for.
    expect((room.match(/sterilised_at_tick = \?/g) ?? []).length).toBe(2);
  });

  it('the surface greys and craters', () => {
    expect(renderer).toMatch(/function drawSterilised\(/);
    // A real desaturation of what is underneath, not a grey film — a
    // film reads as fog, this should read as dead.
    expect(renderer).toMatch(/globalCompositeOperation = 'saturation'/);
    expect(renderer).toMatch(/Craters/);
  });

  it('craters are stable, not reshuffled every frame', () => {
    const i = renderer.indexOf('function drawSterilised(');
    const body = renderer.slice(i, renderer.indexOf('\n}', i));
    expect(body).toMatch(/mulberry32\(hashStr\(body\.id\)/);
  });

  it('the grey ramps with the animation instead of snapping', () => {
    // The fire and the surface are drawn by different systems. Without
    // this the planet would go grey the instant the tick resolved,
    // under a flame that was still burning.
    const i = renderer.indexOf('function sterilisedBlend(');
    const body = renderer.slice(i, renderer.indexOf('\n}', i));
    expect(body).toMatch(/sterilisationProgress\(body\.id/);
    // ...and a world with no animation running is simply dead.
    expect(body).toMatch(/if \(k == null\) return 1/);
  });

  it('applies on BOTH body draw paths', () => {
    // Textured close up, flat disc far out. A world that is only dead
    // when you are near it is a bug you find at the worst moment.
    expect((renderer.match(/drawSterilised\(body, canvasPos, radius, ctx/g) ?? []).length)
      .toBe(2);
  });
});

// ---------------------------------------------------------------------
// THE STRUCTURES SHOULD LOOK ALIVE, AND EXPLAIN THEMSELVES.
//
// Six gaps, verified before building: the sprites had stopped moving,
// nobody could see a structure's reach, a pinned fleet had no picture,
// completion was silent, razing drew nothing, and a gate flung a hull
// with no sign at either mouth.
describe('megastructures move and explain themselves', () => {
  const renderer = fs.readFileSync(
    path.resolve(__dirname, '..', 'mapRenderer.ts'), 'utf8',
  );
  const combat = fs.readFileSync(
    path.resolve(__dirname, '..', 'combatFx.ts'), 'utf8',
  );
  const pendingSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'pendingFx.ts'), 'utf8',
  );
  const roomSrc = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );

  it('the sprites turn again', () => {
    // Rasterising the silhouettes threw away eighteen animation terms
    // and left the only things on the map that visibly RAN completely
    // still. Rotation is applied to the canvas, not baked per-frame
    // into a cache entry.
    expect(renderer).toMatch(/const STRUCTURE_SPIN/);
    expect(renderer).toMatch(/g\.rotate\(spin\)/);
    expect(renderer).toMatch(/g\.rotate\(-spin\)/);
  });

  it('a fort does not spin', () => {
    // A weapons station slowly revolving reads as adrift rather than as
    // manned, so it gets its life from the overlay instead.
    const i = renderer.indexOf('const STRUCTURE_SPIN');
    const block = renderer.slice(i, renderer.indexOf('};', i));
    expect(block).not.toMatch(/weapons_station/);
    expect(block).not.toMatch(/mobile_foundry/);
  });

  it('the live overlay is unwound from the hull rotation', () => {
    // A sweep that turned with the dish would just be part of the dish.
    const i = renderer.indexOf('Unwind before the overlays');
    expect(i).toBeGreaterThan(-1);
  });

  it('reach is drawn for YOUR structure, when you are looking at it', () => {
    // Every structure at once would be a map full of circles, and a
    // rival's reach is intelligence they never gave you.
    expect(renderer).toMatch(/function drawStructureReach/);
    const i = renderer.indexOf("const mine = body.ownedBy === 'player'");
    expect(i).toBeGreaterThan(-1);
    expect(renderer.slice(i, i + 400)).toMatch(/selectedBodyId === body\.id/);
  });

  it('reach rides the map spread, like the server check does', () => {
    // Effect ranges are pre-scale numbers. Without this a spread map
    // shrinks the ring while the guns keep their range — a drawing that
    // lies about the rule it depicts.
    const i = renderer.indexOf('function drawStructureReach');
    expect(renderer.slice(i, i + 1400)).toMatch(/sensorScale/);
  });

  it('a pinned fleet says who has it and for how long', () => {
    expect(combat).toMatch(/export function drawSinkTethers/);
    const i = combat.indexOf('export function drawSinkTethers');
    const body = combat.slice(i, combat.indexOf('\n}', i));
    expect(body).toMatch(/sinkHeldUntilTick/);
    // The tick count is the actionable part.
    expect(body).toMatch(/HELD \$\{/);
  });

  it('completion is announced once, from the tick', () => {
    // Written in three places — two route paths and hand delivery — so
    // a sweep asks the question once instead of two of three announcing.
    expect(roomSrc).toMatch(/async chronicleCompletions/);
    expect(roomSrc).toMatch(/completed_at_tick = \?/);
    expect(pendingSrc).toMatch(/megastructure_complete: 'built'/);
  });

  it('razing and gate transits are on the queue too', () => {
    expect(pendingSrc).toMatch(/megastructure_destroyed: 'destruction'/);
    expect(pendingSrc).toMatch(/gate_transit: 'gateflash'/);
  });
});
