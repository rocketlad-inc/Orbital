import fs from 'fs';
import path from 'path';
import { NON_WORLD_TYPES } from '../victory';

/**
 * "The game says there are 78 worlds to claim and 45 systems … I think
 * it's counting the mining asteroids." It was: 21 rocks and 12 Lagrange
 * points on a map of 45 worlds, and the domination target came out
 * above the number of worlds that existed.
 *
 * The rule now lives in worker/systems.js (NON_WORLD_TYPES) and is read
 * by the domination check, the roster count and the senate summary.
 * This holds the client's copy to it, and pins the membership so the
 * set cannot quietly grow or shrink on one side.
 */
describe('NON_WORLD_TYPES — client mirrors the worker', () => {
  const workerSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'worker', 'systems.js'),
    'utf8',
  );

  it('worker declares the set once, with the same members', () => {
    const m = workerSrc.match(/export const NON_WORLD_TYPES = new Set\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull();
    const workerMembers = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
    expect(workerMembers).toEqual([...NON_WORLD_TYPES].sort());
  });

  it('is exactly the three things that cannot be settled or won', () => {
    expect([...NON_WORLD_TYPES].sort()).toEqual(['lagrange', 'megastructure', 'meteoroid']);
  });

  it('the worker consumers all read the shared rule, not a private list', () => {
    const factions = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'factions.js'), 'utf8');
    const room = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'room.js'), 'utf8');
    expect(factions).toMatch(/NON_WORLD_TYPES/);
    expect(room).toMatch(/NON_WORLD_TYPES/);
    // The old private filters must be gone — they are how the three
    // counts drifted apart in the first place.
    expect(factions).not.toMatch(/AND type <> 'megastructure'/);
    expect(workerSrc).not.toMatch(/if \(b\.type === 'megastructure'\) continue;/);
  });
});
