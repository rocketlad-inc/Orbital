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
