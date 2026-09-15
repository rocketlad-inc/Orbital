// The research queue may hold the same tech several times over, so a
// chip's tech id is not its identity — its POSITION is. Two chips
// sharing a React key kept a stale one alive, and its × still held
// the queue from before the last removal: clicking it sent that
// longer list back to the server and put levels BACK. The player saw
// chips numbered 2, 3, 1, 5, 6, 7, 8, 2, 1 …, which a correct render
// cannot produce, since a chip prints its own index.
//
// Two guards. The first is a source scan, because a duplicate key is
// only a console warning at runtime and nothing in a rendered test
// would fail. The second is the arithmetic behind the chip's hover
// text, asserted on the pure helper.

import * as fs from 'fs';
import * as path from 'path';
import { levelForQueueSlot } from '../../game/techs';

const PANEL = path.join(__dirname, '..', 'TechPanel.tsx');

describe('research queue chips', () => {
  const src = fs.readFileSync(PANEL, 'utf8');

  it('are never keyed by the bare tech id', () => {
    expect(src).not.toMatch(/key=\{qid\}/);
  });

  it('are keyed by their position in the queue', () => {
    // Both strips — SP and MP — map (qid, qi) and key on qi.
    const positional = src.match(/key=\{`\$\{qi\}:\$\{qid\}`\}/g) ?? [];
    expect(positional.length).toBeGreaterThanOrEqual(2);
  });

  it('remove and move-up act on the chip index, not the tech id', () => {
    expect(src).toMatch(/mpDequeue\(qi\)/);
    expect(src).toMatch(/mpMoveUp\(qi\)/);
    expect(src).not.toMatch(/mpDequeue\(qid\)/);
    expect(src).not.toMatch(/mpMoveUp\(qid\)/);
  });
});

describe('levelForQueueSlot', () => {
  it('a lone entry reaches the next level', () => {
    expect(levelForQueueSlot({ propulsion: 2 }, null, ['propulsion'], 0)).toBe(3);
  });

  it('an untouched track starts at level 1', () => {
    expect(levelForQueueSlot({}, null, ['weapons'], 0)).toBe(1);
  });

  it('stacked copies count up, one level per chip', () => {
    const q = ['propulsion', 'propulsion', 'propulsion'] as const;
    const levels = { propulsion: 2 };
    expect([0, 1, 2].map(i => levelForQueueSlot(levels, null, [...q], i))).toEqual([3, 4, 5]);
  });

  it('counts the active project as a level already spoken for', () => {
    // Researching propulsion 3 right now; the queued copies are 4 and 5.
    const q = ['propulsion', 'propulsion'] as const;
    expect([0, 1].map(i => levelForQueueSlot({ propulsion: 2 }, 'propulsion', [...q], i))).toEqual([4, 5]);
  });

  it('only counts copies AHEAD of the slot, and only of the same track', () => {
    const q = ['weapons', 'propulsion', 'weapons', 'armor', 'weapons'] as const;
    const levels = { weapons: 1, propulsion: 5 };
    expect(levelForQueueSlot(levels, 'armor', [...q], 0)).toBe(2);   // weapons: 1 + 1
    expect(levelForQueueSlot(levels, 'armor', [...q], 1)).toBe(6);   // propulsion: 5 + 1
    expect(levelForQueueSlot(levels, 'armor', [...q], 2)).toBe(3);   // weapons: 1 + one ahead + 1
    expect(levelForQueueSlot(levels, 'armor', [...q], 3)).toBe(2);   // armor: 0 + active + 1
    expect(levelForQueueSlot(levels, 'armor', [...q], 4)).toBe(4);   // weapons: 1 + two ahead + 1
  });
});
