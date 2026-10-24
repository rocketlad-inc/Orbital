// The captain name generator only hands out invented names. It used to
// draw from real franchise characters (B'Elanna Torres, Mace Windu, Lando
// Calrissian, Duncan Idaho, Gaius Baltar...), flagged in the 2026-10-24
// playtest. This keeps any of them from drifting back into the pool.
// @ts-ignore -- plain JS worker module
import { CAPTAIN_NAMES } from '../../../worker/captainNames.js';

const FRANCHISE = [
  'Atreides', 'Idaho', 'Harkonnen', 'Skywalker', 'Kenobi', 'Windu', 'Calrissian', 'Organa',
  'Solo', 'Torres', 'Picard', 'Janeway', 'Kirk', 'Spock', 'Nagata', 'Holden', "O'Neill",
  'Baltar', 'Adama', 'Thrace', 'Reynolds', 'Ripley', 'Seldon', 'Quill', 'Vakarian',
];

describe('captain name pool', () => {
  it('has no franchise characters in it', () => {
    const hits = (CAPTAIN_NAMES as string[]).filter(n => FRANCHISE.some(f => n.split(/[\s-]/).includes(f)));
    expect(hits).toEqual([]);
  });

  it('has no duplicates, and enough names for a full game', () => {
    const names = CAPTAIN_NAMES as string[];
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(100);
  });
});
